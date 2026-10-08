import { describe, expect, it } from 'vitest'
import { generateMedia } from '../lib/generate.js'

/**
 * 资源提取必须优先走 manifest 的 response 描述符（images / videos / audios /
 * resultPaths），硬编码 URL 表只能当 fallback。这些用例用真实 manifest 的
 * 真实响应形状离线复现「轮询成功却抛 No generation result returned」。
 */

type StubCall = { method: string; url: string }

function stubFetch(createBody: unknown, pollBody: unknown, resultBody?: unknown) {
  const calls: StubCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = String(input)
    calls.push({ method, url })
    let body: BodyInit
    if (resultBody !== undefined && url.includes('/download') && method === 'GET') {
      body = resultBody as BodyInit
    } else if (method === 'GET') {
      body = JSON.stringify(pollBody)
    } else {
      body = JSON.stringify(createBody)
    }
    const headers: Record<string, string> = resultBody !== undefined && url.includes('/download')
      ? { 'content-type': 'video/mp4' }
      : { 'content-type': 'application/json' }
    return new Response(body, { status: 200, headers })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

describe('asset extraction follows manifest response descriptors', () => {
  it('extracts fal-queue-image images from the $ref: response.images descriptor', async () => {
    // manifests/fal-queue-image.json:241-243 -> images: { $ref: "response.images" }
    const stub = stubFetch(
      { request_id: 'req-1', prompt_id: 'p-1' },
      {
        status: 'COMPLETED',
        images: [
          { url: 'https://cdn.example/fal-1.png', width: 1024 },
          { url: 'https://cdn.example/fal-2.png', width: 1024 },
        ],
      },
    )
    try {
      const assets = await generateMedia(
        'fal-queue-image',
        { model: 'fal-queue-image', prompt: 'a cat', providerOptions: { 'fal-queue-image': { statusPath: 'queue/p-1' } } } as never,
        'sk-descriptor-test',
      )
      expect(assets.map((a) => a.url)).toEqual(['https://cdn.example/fal-1.png', 'https://cdn.example/fal-2.png'])
      expect(assets.every((a) => a.mediaType === 'image' && a.type === 'url')).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('extracts dashscope-wanx-image from output.results[] via the $coalesce descriptor', async () => {
    // manifests/dashscope-wanx-image.json:281-290 -> $ref: response.output.results
    const stub = stubFetch(
      { output: { task_id: 'task-dash-42' } },
      {
        request_id: 'req-dash',
        output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example/dash-1.png' }] },
      },
    )
    try {
      const assets = await generateMedia(
        'dashscope-wanx-image',
        { model: 'wanx2.1-t2i-turbo', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/dash-1.png' }])
      expect(stub.calls.some((c) => c.url.endsWith('/api/v1/tasks/task-dash-42'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('extracts bfl-flux from data.image_url via the $coalesce descriptor', async () => {
    // manifests/bfl-flux.json:199-210 -> $ref: response.data.image_url
    const stub = stubFetch(
      { id: 'task-bfl-1' },
      { status: 'COMPLETED', data: { image_url: 'https://cdn.example/bfl-1.png' } },
    )
    try {
      const assets = await generateMedia(
        'bfl-flux',
        { model: 'flux-schnell', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/bfl-1.png' }])
    } finally {
      stub.restore()
    }
  })

  it('extracts gemini-image inline data through the $map/$filter descriptor', async () => {
    // manifests/google-gemini-image.json -> images: $map over candidates[0].content.parts
    const stub = stubFetch({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }],
    }, {})
    try {
      const assets = await generateMedia(
        'gemini-image',
        { model: 'gemini-2.0-flash-preview-image-generation', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'data:image/png;base64,iVBORw0KGgo=' }])
    } finally {
      stub.restore()
    }
  })

  it('extracts autodl-comfyui through the declared resultPaths', async () => {
    // manifests/autodl-comfyui.json -> resultPaths: ["data.results"]
    const stub = stubFetch(
      { data: { task_id: 'task-comfy-1' } },
      { data: { status: 'completed', results: [{ url: 'https://cdn.example/comfy-out.mp4' }] } },
    )
    try {
      const assets = await generateMedia(
        'autodl-comfyui',
        { model: 'comfyui-workflow', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets).toEqual([{ mediaType: 'video', type: 'url', url: 'https://cdn.example/comfy-out.mp4' }])
    } finally {
      stub.restore()
    }
  })

  it('falls back to the declared result endpoint when the payload carries no media', async () => {
    // manifests/full-video.json -> result: GET /v1/videos/{{taskId}}/download
    const stub = stubFetch(
      { id: 'task-9' },
      { status: 'completed' },
      new Uint8Array([0, 1, 2, 3]),
    )
    try {
      const assets = await generateMedia(
        'full-video',
        { model: 'full-video', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets).toHaveLength(1)
      expect(assets[0].mediaType).toBe('video')
      expect(assets[0].type).toBe('binary')
      expect(assets[0].mimeType).toBe('video/mp4')
      expect(assets[0].data).toBeInstanceOf(Uint8Array)
      expect(stub.calls.some((c) => c.url.endsWith('/v1/videos/task-9/download'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('still uses the hardcoded URL table when the descriptor resolves to nothing', async () => {
    const stub = stubFetch(
      { request_id: 'req-2', prompt_id: 'p-2' },
      { status: 'COMPLETED', url: 'https://cdn.example/fal-fallback.png' },
    )
    try {
      const assets = await generateMedia(
        'fal-queue-image',
        { model: 'fal-queue-image', prompt: 'a cat', providerOptions: { 'fal-queue-image': { statusPath: 'queue/p-2' } } } as never,
        'sk-descriptor-test',
      )
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/fal-fallback.png' }])
    } finally {
      stub.restore()
    }
  })
})
