import { listProviders, generateMedia } from './generate.js'
import { setApiKey, getApiKey } from './config.js'

export const name = 'dsh-toonflow-media'
export const inject = ['tools']

export interface ToonflowMediaConfig {
  defaultCwd?: string
  timeoutMs?: number
}

function describeProviders(providers: unknown[]): string {
  const lines: string[] = []
  for (const p of providers) {
    const caps = (p as { capabilities?: string[] }).capabilities?.join('/') ?? ''
    const id = (p as { id: string }).id
    const label = String((p as { label: string }).label)
    lines.push('- [' + id + '] ' + label + ' (' + caps + ')')
  }
  return lines.join('\n')
}
const LIST_PARAMS = { type: 'object', properties: {}, required: [], additionalProperties: false }
const LIST_OUTPUT = { type: 'object', properties: { providers: { type: 'string' } }, required: ['providers'] }

const GEN_PARAMS = {
  type: 'object',
  properties: {
    providerId: { type: 'string', description: 'Provider id (from toonflow_media_list_models)' },
    model: { type: 'string', description: 'Model id' },
    prompt: { type: 'string', description: 'Prompt' },
    text: { type: 'string', description: 'Text (audio)' },
    images: { type: 'array', items: { type: 'string' }, description: 'Image urls or data urls' },
    videos: { type: 'array', items: { type: 'string' }, description: 'Video urls' },
    audios: { type: 'array', items: { type: 'string' }, description: 'Audio urls' },
    duration: { type: 'number' },
    aspectRatio: { type: 'string' },
    ratio: { type: 'string' },
    resolution: { type: 'string' },
    quality: { type: 'string' },
    imageCount: { type: 'number' },
    generateAudio: { type: 'boolean' },
    watermark: { type: 'boolean' },
    voice: { type: 'string' },
    speed: { type: 'number' },
    volume: { type: 'number' },
    pitch: { type: 'number' },
    language: { type: 'string' },
    format: { type: 'string' },
    sampleRate: { type: 'number' },
    providerOptions: { type: 'object' },
    apiKey: { type: 'string', description: 'Optional API key (overrides stored)' },
  },
  required: ['providerId', 'model'],
  additionalProperties: false,
}

const GEN_OUTPUT = {
  type: 'object',
  properties: {
    assets: { type: 'array', items: { type: 'object' } },
  },
  required: ['assets'],
}

const KEY_PARAMS = {
  type: 'object',
  properties: {
    providerId: { type: 'string' },
    apiKey: { type: 'string' },
  },
  required: ['providerId', 'apiKey'],
  additionalProperties: false,
}

const KEY_OUTPUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, providerId: { type: 'string' } },
  required: ['ok', 'providerId'],
}
// render() 由宿主在工具返回后调用，value 可能缺字段（失败/空结果），必须防御性渲染成安全形状。
function renderList(value: { providers: string }) {
  const providers = typeof value?.providers === 'string' ? value.providers : ''
  return 'Available media providers:\n' + providers
}

function renderGen(value: { assets: unknown[] }) {
  const lines: string[] = []
  const assets = Array.isArray(value?.assets) ? value.assets : []
  for (const a of assets) {
    const asset = (a ?? {}) as { mediaType?: string; type?: string; url?: string; mimeType?: string; data?: unknown }
    const label = asset.mediaType ?? 'media'
    if (asset.type === 'url') lines.push('- [' + label + '] ' + (asset.url ?? '(no url)'))
    else if (asset.type === 'base64')
      lines.push('- [' + label + '] base64 (' + (asset.data ? String(asset.data).length : 0) + ' chars)')
    else lines.push('- [' + label + '] binary (' + (asset.mimeType ?? '') + ')')
  }
  if (lines.length === 0) lines.push('- (no media returned)')
  return 'Generated media:\n' + lines.join('\n')
}

function renderKey(value: { ok: boolean; providerId: string }) {
  const providerId = typeof value?.providerId === 'string' ? value.providerId : 'unknown provider'
  return value?.ok ? 'API key set for ' + providerId : 'Failed to set key for ' + providerId
}

async function execList(exec: unknown) {
  const providers = listProviders()
  return { providers: describeProviders(providers) }
}

async function execGen(
  args: { providerId: string; model: string; apiKey?: string; [key: string]: unknown },
  exec: unknown,
) {
  const request: Record<string, unknown> = {
    model: args.model,
    // entries 是 [key, value] 数组对：必须经 fromEntries 合并，直接 spread 会得到数字键。
    ...Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'providerId' && k !== 'model' && k !== 'apiKey')),
  }
  const assets = await generateMedia(args.providerId, request as any, args.apiKey)
  return { assets }
}

async function execKey(args: { providerId: string; apiKey: string }, exec: unknown) {
  try {
    setApiKey(args.providerId, args.apiKey)
    return { ok: true, providerId: args.providerId }
  } catch (e) {
    return { ok: false, providerId: args.providerId }
  }
}
function createListTool() {
  return {
    name: 'toonflow_media_list_models',
    description:
      'List available media providers (image/video/audio). Returns provider ids, labels, and capabilities. Use the providerId with toonflow_media_generate.',
    parameters: LIST_PARAMS,
    output: {
      schema: LIST_OUTPUT,
      render: (_args: unknown, value: { providers: string }) => [{ type: 'text', text: renderList(value) }],
    },
    async execute(_args: unknown, _exec: unknown) {
      return execList(_exec)
    },
  }
}

function createGenTool() {
  return {
    name: 'toonflow_media_generate',
    description:
      'Generate media (image/video/audio) using a BeefTV provider. providerId must be from toonflow_media_list_models. model is required. prompt/text for the content. Optional: images, videos, audios, duration, aspectRatio, resolution, quality, imageCount, generateAudio, watermark, voice, speed, volume, pitch, language, format, sampleRate, providerOptions, apiKey.',
    parameters: GEN_PARAMS,
    output: {
      schema: GEN_OUTPUT,
      render: (_args: unknown, value: { assets: unknown[] }) => [{ type: 'text', text: renderGen(value) }],
    },
    async execute(args: any, exec: unknown) {
      return execGen(args, exec)
    },
  }
}

function createKeyTool() {
  return {
    name: 'toonflow_media_set_key',
    description:
      'Set the API key for a provider. The key is persisted to $DSH_HOME/toonflow-media/config.json and used by toonflow_media_generate unless an apiKey is passed explicitly.',
    parameters: KEY_PARAMS,
    output: {
      schema: KEY_OUTPUT,
      render: (_args: unknown, value: { ok: boolean; providerId: string }) => [
        { type: 'text', text: renderKey(value) },
      ],
    },
    async execute(args: any, exec: unknown) {
      return execKey(args, exec)
    },
  }
}
export function apply(ctx: any) {
  const effect = ctx.effect?.bind ? ctx.effect.bind(ctx) : ctx.effect
  if (effect) {
    effect(() => {
      ctx.tools?.register(createListTool())
      ctx.tools?.register(createGenTool())
      ctx.tools?.register(createKeyTool())
    }, 'toonflow-media-tools')
  }
}
