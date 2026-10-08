import type {
  LoadedProvider,
  ManifestProvider,
  MediaAsset,
  MediaRequest,
  ProviderConfig,
  ProviderContext,
} from './types.js'
import { interpret, extractValue, type TemplateContext, type TemplateNode } from './template.js'
import { extractAssets, normalizeAssets, readResponseField } from './assets.js'
import { buildMultipartBody, createRequestSpec } from './upload.js'
import { loadProviders } from './manifest-loader.js'
import { getApiKey } from './config.js'

const allProviders = loadProviders()

export function listProviders() {
  return allProviders.map((p) => ({
    id: p.provider.id,
    label: p.provider.label,
    capabilities: p.provider.capabilities,
    baseUrl: p.provider.baseUrl,
    description: p.manifest.description,
  }))
}

/**
 * Some manifests declare a dedicated result endpoint (`result: { method, path,
 * headers }`) because the media is only downloadable there. Used as a last
 * resort after the payload itself yielded nothing, so providers that already
 * return a URL never issue an extra request.
 */
/** Ask the declared result endpoint for the document; nothing to fetch means nothing to decode. */
async function requestResultDocument(
  result: NonNullable<ManifestProvider['result']>,
  baseUrl: string,
  ctx: TemplateContext,
  context: ProviderContext,
): Promise<Response | undefined> {
  const url = `${baseUrl}${renderPath(result.path, ctx)}`
  const response = await context.tool.fetch(url, {
    method: result.method || 'GET',
    headers: { Authorization: `Bearer ${context.config.apiKey ?? ''}`, ...(result.headers ?? {}) },
    signal: context.signal,
  })
  return response.ok ? response : undefined
}

/** Decode a result-endpoint payload: JSON goes through the asset normalizer, anything else is raw bytes. */
async function decodeResultResponse(
  response: Response,
  mediaType: 'image' | 'video' | 'audio',
  result: NonNullable<ManifestProvider['result']>,
): Promise<MediaAsset[]> {
  const mimeType = response.headers.get('content-type') ?? result.headers?.Accept ?? 'application/octet-stream'
  if (mimeType.includes('json')) return normalizeAssets(mediaType, await response.json())
  const data = new Uint8Array(await response.arrayBuffer())
  return [{ mediaType, type: 'binary', data, mimeType }]
}

async function fetchResultAssets(
  provider: ManifestProvider,
  mediaType: 'image' | 'video' | 'audio',
  ctx: TemplateContext,
  context: ProviderContext,
): Promise<MediaAsset[]> {
  const result = provider.result
  if (!result?.path) return []
  const response = await requestResultDocument(result, provider.baseUrl, ctx, context)
  if (!response) return []
  return decodeResultResponse(response, mediaType, result)
}

/**
 * 单次生成的时间预算。abort 信号、轮询总时长、收尾余量必须自洽：
 * MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS + POLL_MARGIN_MS <= GENERATION_BUDGET_MS
 */
export const GENERATION_BUDGET_MS = 30 * 60_000
export const POLL_INTERVAL_MS = 3_000
export const POLL_MARGIN_MS = 30_000
export const MAX_POLL_ATTEMPTS = Math.floor((GENERATION_BUDGET_MS - POLL_MARGIN_MS) / POLL_INTERVAL_MS)
/** 收尾 cancel 只允许占用很小的时间窗，不能把整条调用链拖到 abort。 */
const CANCEL_TIMEOUT_MS = 10_000

function errorMessage(obj: unknown): string {
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    return String(o.error ?? o.message ?? o.code ?? JSON.stringify(obj))
  }
  return String(obj)
}

function findProvider(providerId: string): LoadedProvider {
  const p = allProviders.find((x) => x.provider.id === providerId)
  if (!p) throw new Error(`Provider not found: ${providerId}`)
  return p
}

/**
 * Render a manifest URL template. Manifests use `{{expr}}` placeholders where
 * `expr` is `model`, `taskId`, or a dotted path such as
 * `request.providerOptions.vertex-gemini.project`. Upstream Toonflow passes
 * these paths through raw, which produces literal `{{taskId}}` URLs; we resolve
 * them so async poll/create endpoints actually work.
 */
export function renderPath(path: string, ctx: TemplateContext): string {
  return path.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expr: string) => {
    const value = extractValue(ctx, expr.trim())
    return value == null ? '' : String(value)
  })
}

/** Manifest-declared terminal states, as lookup tables instead of long equality chains. */
const POLL_SUCCESS_STATUSES = new Set(['completed', 'success', 'succeeded', 'done'])
const POLL_FAILURE_STATUSES = new Set(['failed', 'failure', 'error'])

type PollVerdict = 'succeeded' | 'failed' | 'pending'

function classifyPollStatus(lower: string): PollVerdict {
  if (POLL_SUCCESS_STATUSES.has(lower)) return 'succeeded'
  if (POLL_FAILURE_STATUSES.has(lower)) return 'failed'
  return 'pending'
}

/** Read the manifest-declared status field (descriptor or path list) as a lowercase token. */
function pollStatusOf(provider: ManifestProvider, pollJson: unknown, ctx: TemplateContext): string {
  const status = readResponseField(
    provider.response?.status ?? provider.response?.statusPaths,
    pollJson,
    ['status', 'state', 'data.status', 'data.state'],
    ctx,
  )
  return String(status ?? '').toLowerCase()
}

/** One poll request: HTTP errors throw here, the payload goes back for status classification. */
async function fetchPollOnce(
  pollUrl: string,
  apiKey: string,
  context: ProviderContext,
  signal: AbortSignal,
): Promise<unknown> {
  const pollResponse = await context.tool.fetch(pollUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!pollResponse.ok) throw new Error(`Poll failed: HTTP ${pollResponse.status}`)
  return pollResponse.json()
}

/**
 * Poll the manifest-declared task endpoint until the declared status reaches a
 * terminal state. Throws on an HTTP error, a failed status, or an exhausted
 * polling budget — the caller decides whether a cancel request is worth issuing.
 */
async function pollTask(
  provider: ManifestProvider,
  poll: { method: string; path: string },
  context: ProviderContext,
  apiKey: string,
  ctx: TemplateContext,
  signal: AbortSignal,
  startedAt: number,
): Promise<unknown> {
  const pollUrl = `${provider.baseUrl}${renderPath(poll.path, ctx)}`
  let pollJson: unknown
  let attempts = 0
  // 轮询必须在 abort 之前留出收尾余量，从请求开始时刻计时。
  const pollDeadline = startedAt + GENERATION_BUDGET_MS - POLL_MARGIN_MS
  while (attempts < MAX_POLL_ATTEMPTS) {
    pollJson = await fetchPollOnce(pollUrl, apiKey, context, signal)
    const verdict = classifyPollStatus(pollStatusOf(provider, pollJson, ctx))
    if (verdict === 'succeeded') return pollJson
    if (verdict === 'failed') throw new Error(`Task failed: ${errorMessage(pollJson)}`)
    attempts++
    const remaining = pollDeadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)))
  }
  throw new Error(
    `Task did not complete within ${Math.round((GENERATION_BUDGET_MS - POLL_MARGIN_MS) / 1000)}s of polling (${attempts} attempts)`,
  )
}

/**
 * Issue the cancel request a manifest declares (`cancel: { method, path }`) when
 * a task never reached a terminal success, so upstream slots are not left held.
 * Best-effort: a cancel failure must not mask the original error, and it must
 * not reuse the signal that already aborted the poll.
 */
async function cancelTask(
  provider: ManifestProvider,
  context: ProviderContext,
  apiKey: string,
  ctx: TemplateContext,
): Promise<void> {
  const cancel = provider.cancel
  if (!cancel?.path) return
  try {
    await context.tool.fetch(`${provider.baseUrl}${renderPath(cancel.path, ctx)}`, {
      method: cancel.method || 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    })
  } catch {
    // 取消失败只影响上游配额，不改变本次调用的结果。
  }
}

/** Result media type: an explicit `resultKind` wins, then capability hints, then audio. */
function resolveMediaType(p: ManifestProvider): MediaAsset['mediaType'] {
  const kind = p.response?.resultKind
  if (kind === 'audio' || kind === 'image' || kind === 'video') return kind
  if (p.capabilities.includes('video')) return 'video'
  if (p.capabilities.includes('image')) return 'image'
  return 'audio'
}

function buildProviderContext(apiKey: string, signal: AbortSignal): ProviderContext {
  return {
    config: { apiKey },
    signal,
    tool: {
      fetch: (url, options) => fetch(url, options),
      errorMessage: (obj) => errorMessage(obj),
    },
  }
}

/**
 * Send the create request. multipart 的 boundary 由 fetch 依据 FormData 生成：
 * 手写 Content-Type 会让 header 与请求体不一致，上游直接拒收。
 */
async function postCreate(
  p: ManifestProvider,
  body: unknown,
  ctx: TemplateContext,
  context: ProviderContext,
  apiKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const spec = createRequestSpec(p, ctx)
  const createUrl = `${p.baseUrl}${renderPath(spec.path, ctx)}`
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (!spec.multipart) headers['Content-Type'] = spec.contentType
  const response = await context.tool.fetch(createUrl, {
    method: p.create.method,
    headers,
    body: spec.multipart ? await buildMultipartBody(p, body, ctx, context) : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const err = await response.text().catch(() => '')
    throw new Error(`Request failed: HTTP ${response.status} ${err}`)
  }
  return response
}

/** Synchronous binary response (audio etc.) */
async function binaryAsset(response: Response, mediaType: MediaAsset['mediaType']): Promise<MediaAsset[]> {
  const blob = await response.blob()
  const data = new Uint8Array(await blob.arrayBuffer())
  const mimeType = response.headers.get('content-type') ?? 'application/octet-stream'
  return [{ mediaType, type: 'binary', data, mimeType } as MediaAsset]
}

function requireAssets(assets: MediaAsset[], payload: unknown): MediaAsset[] {
  if (assets.length > 0) return assets
  throw new Error(`No generation result returned: ${errorMessage(payload)}`)
}

/** Async task: read the taskId, poll to a terminal state, then extract assets from the poll payload. */
async function runAsyncTask(
  p: ManifestProvider,
  json: unknown,
  mediaType: MediaAsset['mediaType'],
  ctx: TemplateContext,
  context: ProviderContext,
  apiKey: string,
  signal: AbortSignal,
  startedAt: number,
): Promise<MediaAsset[]> {
  const taskId = readResponseField(
    p.response?.taskId ?? p.response?.taskIdPaths,
    json,
    ['id', 'taskId', 'task_id', 'data.id', 'data.task_id'],
    ctx,
  )
  if (taskId == null) throw new Error(`No task id returned: ${errorMessage(json)}`)
  const assetCtx = { ...ctx, taskId }
  let pollJson: unknown
  try {
    pollJson = await pollTask(p, p.poll!, context, apiKey, assetCtx, signal, startedAt)
  } catch (err) {
    // 任务没有走到成功态才取消；成功后的取结果失败不值得再发一次 cancel。
    await cancelTask(p, context, apiKey, assetCtx)
    throw err
  }
  const assets = extractAssets(mediaType, pollJson, p, assetCtx)
  if (assets.length > 0) return assets
  return requireAssets(await fetchResultAssets(p, mediaType, assetCtx, context), pollJson)
}

async function executeGeneration(
  provider: LoadedProvider,
  request: MediaRequest,
  apiKey: string,
  signal: AbortSignal,
): Promise<MediaAsset[]> {
  const startedAt = Date.now()
  const p = provider.provider
  const mediaType = resolveMediaType(p)

  const ctx: TemplateContext = { request, response: {}, model: (request as Record<string, unknown>).model }
  const body = interpret(p.create.body, ctx)
  const context = buildProviderContext(apiKey, signal)

  const response = await postCreate(p, body, ctx, context, apiKey, signal)

  if (p.response?.binaryPayload) return binaryAsset(response, mediaType)

  const json = await response.json()

  // Async task: get taskId then poll.
  if (p.poll) return runAsyncTask(p, json, mediaType, ctx, context, apiKey, signal, startedAt)

  // Synchronous JSON response.
  return requireAssets(extractAssets(mediaType, json, p, ctx), json)
}

export async function generateMedia(providerId: string, request: MediaRequest, apiKey?: string): Promise<MediaAsset[]> {
  const loaded = findProvider(providerId)
  const key = apiKey ?? getApiKey(providerId)
  if (!key) throw new Error(`API key not set for provider "${providerId}". Use toonflow_media_set_key first.`)
  const signal = AbortSignal.timeout(GENERATION_BUDGET_MS)
  return executeGeneration(loaded, request, key, signal)
}
