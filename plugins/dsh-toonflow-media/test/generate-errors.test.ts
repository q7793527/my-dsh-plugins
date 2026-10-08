import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMedia } from '../lib/generate.js'
import { stubFetch } from './fetch-stub.js'

/**
 * generateMedia 的错误与边界路径：HTTP 非 2xx、创建响应缺 taskId、成功轮询却
 * 无资产（含 result 端点缺失 / 404 / 返回 JSON）、binaryPayload 的 content-type
 * 两态、轮询 deadline 的 break、无 status 字段的继续轮询、caps 无 video/image
 * 时的 mediaType 'audio' 兜底 —— 这些分支在现有集成测试里全部走的是成功形态。
 */

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  vi.useRealTimers()
})

describe('create stage failures', () => {
  it('throws Request failed: HTTP <status> with the upstream error body and stops', async () => {
    const stub = stubFetch(() => ({ status: 400, body: { error: 'bad request' } }))
    restore = stub.restore
    const run = generateMedia('openai-image', { model: 'gpt-image-1', prompt: 'a cat' }, 'sk-1')
    await expect(run).rejects.toThrow(/Request failed: HTTP 400 \{"error":"bad request"\}/)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].method).toBe('POST')
  })

  it('throws when the create response carries no task id at all', async () => {
    const stub = stubFetch(() => ({ body: {} }))
    restore = stub.restore
    const run = generateMedia('full-video', { model: 'fv-2.5', prompt: 'x' }, 'sk-1')
    await expect(run).rejects.toThrow(/No task id returned: \{\}/)
    expect(stub.calls).toHaveLength(1)
  })
})

describe('synchronous providers without media in the payload', () => {
  it('throws No generation result returned: <payload> when the JSON body is a bare number', async () => {
    const stub = stubFetch(() => ({ body: '42' }))
    restore = stub.restore
    const run = generateMedia('openai-image', { model: 'gpt-image-1', prompt: 'a cat' }, 'sk-1')
    await expect(run).rejects.toThrow(/No generation result returned: 42/)
    expect(stub.calls[0].headers['Content-Type']).toBe('application/json')
  })

  it('throws for a text-capable provider whose payload holds no media', async () => {
    const stub = stubFetch(() => ({ body: {} }))
    restore = stub.restore
    const run = generateMedia('deepseek-chat', { model: 'deepseek-chat', prompt: 'hi' }, 'sk-1')
    await expect(run).rejects.toThrow(/No generation result returned: \{\}/)
    expect(stub.calls).toHaveLength(1)
  })
})

describe('polling deadline and status handling', () => {
  it('breaks out of the poll loop once the wall clock passes the deadline, then cancels', async () => {
    vi.useFakeTimers()
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 't-9' } }
      if (call.method === 'GET') {
        // 把系统时钟推过 startedAt + 29.5min 的轮询截止点，迫使 remaining<=0 分支生效。
        vi.setSystemTime(Date.now() + 31 * 60_000)
        return { body: { status: 'processing' } }
      }
      return {}
    })
    restore = stub.restore
    const run = generateMedia('newapi', { model: 'sora-2', prompt: 'x' }, 'sk-1')
    await expect(run).rejects.toThrow(/1770s of polling \(1 attempts\)/)
    // 轮询失败必须补发一次 DELETE 取消，且 GET 只发过一次（deadline 立即 break）。
    expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('keeps polling a payload that carries no status field at all, then succeeds', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 'v-7' } }
      if (call.url.endsWith('/download')) {
        return { body: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' }
      }
      // 第一次轮询响应缺 status（full-video 声明的是 statusPaths）：必须继续轮询。
      return { body: stub.calls.filter((c) => c.method === 'GET').length > 1 ? { status: 'completed' } : {} }
    })
    restore = stub.restore
    const assets = await generateMedia('full-video', { model: 'fv-2.5', prompt: 'x' }, 'sk-1')
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ mediaType: 'video', type: 'binary', mimeType: 'video/mp4' })
    expect(assets[0].data).toBeInstanceOf(Uint8Array)
    expect(assets[0].data).toEqual(new Uint8Array([1, 2, 3]))
    // 两次轮询（第一次无 status 继续、第二次 completed）+ 一次 result 下载。
    // full-video manifest 未声明 baseUrl，请求 URL 因此以 'undefined' 前缀拼接。
    expect(stub.calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'undefined/v1/videos/v-7',
      'undefined/v1/videos/v-7',
      'undefined/v1/videos/v-7/download',
    ])
  })
})

describe('poll succeeded but the payload holds no media', () => {
  it('throws immediately for a provider without a result endpoint and issues no extra request', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 'fal-1' } }
      return { body: { status: 'COMPLETED' } }
    })
    restore = stub.restore
    const run = generateMedia(
      'fal-queue-image',
      {
        model: 'fal-ai/flux/dev',
        prompt: 'a cat',
        providerOptions: { 'fal-queue-image': { statusPath: 'fal-ai/flux/dev/requests/fal-1/status' } },
      },
      'sk-1',
    )
    await expect(run).rejects.toThrow(/No generation result returned: \{"status":"COMPLETED"\}/)
    expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('returns no assets when the result endpoint answers 404, then throws', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 't-2' } }
      if (call.url.endsWith('/content')) return { status: 404, body: 'gone' }
      return { body: { status: 'completed' } }
    })
    restore = stub.restore
    const run = generateMedia('newapi', { model: 'sora-2', prompt: 'x' }, 'sk-1')
    await expect(run).rejects.toThrow(/No generation result returned: \{"status":"completed"\}/)
    expect(stub.calls.filter((c) => c.url.endsWith('/content'))).toHaveLength(1)
  })

  it('accepts media delivered as JSON from the result endpoint', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 'a-1' } }
      if (call.url.endsWith('/content')) {
        return { body: { url: 'https://cdn.example/out.mp3' }, contentType: 'application/json' }
      }
      return { body: { status: 'completed' } }
    })
    restore = stub.restore
    const assets = await generateMedia('async-audio', { model: 'tts-1', prompt: 'hi' }, 'sk-1')
    // caps 只有 audio、且无 resultKind：mediaType 走 'audio' 兜底分支。
    expect(assets).toEqual([{ mediaType: 'audio', type: 'url', url: 'https://cdn.example/out.mp3' }])
  })
})

describe('binaryPayload create responses', () => {
  it('returns the audio bytes with the declared content type', async () => {
    const bytes = new Uint8Array([104, 105])
    const stub = stubFetch(() => ({ body: bytes, contentType: 'audio/mpeg' }))
    restore = stub.restore
    const assets = await generateMedia('openai-audio', { model: 'tts-1', text: 'hi' }, 'sk-1')
    expect(assets).toHaveLength(1)
    expect(assets[0].mediaType).toBe('audio')
    expect(assets[0].type).toBe('binary')
    expect(assets[0].mimeType).toBe('audio/mpeg')
    expect(assets[0].data).toEqual(bytes)
  })

  it('falls back to application/octet-stream when the response omits content-type', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array([7, 8, 9]))) as typeof fetch
    try {
      const assets = await generateMedia('openai-audio', { model: 'tts-1', text: 'hi' }, 'sk-1')
      expect(assets[0].mimeType).toBe('application/octet-stream')
      expect(assets[0].mediaType).toBe('audio')
      expect(assets[0].data).toEqual(new Uint8Array([7, 8, 9]))
    } finally {
      globalThis.fetch = original
    }
  })
})
