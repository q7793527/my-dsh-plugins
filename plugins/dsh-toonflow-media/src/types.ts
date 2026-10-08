export interface ManifestProvider {
  id: string
  label: string
  capabilities: string[]
  scopes?: string[]
  baseUrl: string
  requiresPublicMediaUrls?: boolean
  auth?: { type: string; field: string }
  parameters?: { name: string; type: string; required?: boolean; mapping?: string; description?: string }[]
  create: {
    method: string
    // Some manifests spell the endpoint as a template that depends on the
    // request (ideogram/stability declare `pathTemplate` and no `path` at all).
    path?: string
    pathTemplate?: TemplateNode
    contentType?: string
    contentTypeTemplate?: TemplateNode
    body?: TemplateNode
    files?: { name: string; source?: TemplateNode; filename?: string }[]
  }
  poll?: { method: string; path: string }
  cancel?: { method: string; path: string }
  result?: { method: string; path: string; headers?: Record<string, string> }
  response?: {
    // Manifests spell these two ways: a template descriptor ($ref / $coalesce /
    // $map ...) or a plain dotted-path array (*Paths). Both are accepted.
    status?: TemplateNode
    taskId?: TemplateNode
    message?: TemplateNode
    videos?: TemplateNode
    images?: TemplateNode
    audios?: TemplateNode
    audio?: TemplateNode
    taskIdPaths?: string[]
    statusPaths?: string[]
    resultPaths?: string[]
    textPaths?: string[]
    reasoningPaths?: string[]
    errorPaths?: string[]
    messagePaths?: string[]
    resultEphemeral?: boolean
    binaryPayload?: boolean
    resultKind?: string
    usage?: unknown
  }
}

export interface Manifest {
  apiVersion: string
  id: string
  name: string
  version: string
  author: string
  description: string
  permissions?: string[]
  configuration?: { fields?: { name: string; type: string; label: string; required?: boolean }[] }
  contributes: { providers: ManifestProvider[] }
}

export interface MediaAsset {
  mediaType: 'image' | 'video' | 'audio'
  type: 'url' | 'base64' | 'binary'
  url?: string
  data?: string | Uint8Array
  mimeType?: string
}

export interface ProviderConfig {
  apiKey?: string
  [key: string]: unknown
}

export interface ProviderContext {
  config: ProviderConfig
  signal?: AbortSignal
  tool: {
    fetch: (url: string, options?: RequestInit) => Promise<Response>
    errorMessage: (obj: unknown) => string
  }
}

export interface MediaRequest {
  model: string
  prompt?: string
  text?: string
  images?: unknown[]
  videos?: unknown[]
  audios?: unknown[]
  firstFrame?: unknown
  lastFrame?: unknown
  duration?: number
  aspectRatio?: string
  ratio?: string
  resolution?: string
  quality?: string
  imageCount?: number
  generateAudio?: boolean
  watermark?: boolean
  voice?: string
  speed?: number
  volume?: number
  pitch?: number
  language?: string
  format?: string
  sampleRate?: number
  bitrateKbps?: number
  providerOptions?: Record<string, unknown>
  extra?: Record<string, unknown>
  [key: string]: unknown
}

export interface LoadedProvider {
  manifest: Manifest
  provider: ManifestProvider
}

export type TemplateNode =
  string | number | boolean | null | undefined | TemplateNode[] | { [key: string]: TemplateNode }

export interface TemplateContext {
  request?: unknown
  response?: unknown
  item?: unknown
  [key: string]: unknown
}
