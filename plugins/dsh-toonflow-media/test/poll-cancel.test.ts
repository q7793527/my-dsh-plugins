import { describe, expect, it, vi } from 'vitest'
import { generateMedia } from '../lib/generate.js'
import { RecordedCall, stubFetch } from './fetch-stub.js'

/**
 * 轮询失败/超时/中断时，必须发出 manifest 声明的 cancel 请求，否则上游任务
 * 继续计费。夹具是真实声明 cancel 的 manifest：openai-videos.json:186（provider
 * id newapi）、replicate-prediction-image.json:197、volcengine-ark-seedance.json:295。
 * 同时守住「没有 cancel 声明的渠道一个请求都不多发」。
 */

function findCall(calls: RecordedCall[], method: string, urlSuffix: string): RecordedCall | undefined {
  return calls.find((c) => c.method === method && c.url.endsWith(urlSuffix))
}

describe('poll failure issues the manifest-declared cancel', () => {
  it('openai-videos (newapi) cancels the task when the poll reports a failed status', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? { body: { id: 'task-7' } }
        : { body: { status: 'failed', error: { message: 'moderation rejected' } } },
    )
    try {
      await expect(
        generateMedia('newapi', { model: 'sora-2', prompt: 'a cat' } as never, 'sk-cancel-test'),
      ).rejects.toThrow(/Task failed/)
      const cancel = findCall(stub.calls, 'DELETE', '/v1/videos/task-7')
      expect(cancel).toBeDefined()
      expect(cancel!.aborted).toBe(false)
      expect(stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })

  it('openai-videos cancels when the poll endpoint answers with an HTTP error', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST' ? { body: { id: 'task-8' } } : { status: 500, body: { error: 'upstream boom' } },
    )
    try {
      await expect(
        generateMedia('newapi', { model: 'sora-2', prompt: 'a cat' } as never, 'sk-cancel-test'),
      ).rejects.toThrow(/Poll failed: HTTP 500/)
      expect(findCall(stub.calls, 'DELETE', '/v1/videos/task-8')).toBeDefined()
    } finally {
      stub.restore()
    }
  })

  it('openai-videos cancels when the poll request is aborted, without reusing the aborted signal', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 'task-9' } }
      if (call.method === 'GET') {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      return { body: {} }
    })
    try {
      await expect(
        generateMedia('newapi', { model: 'sora-2', prompt: 'a cat' } as never, 'sk-cancel-test'),
      ).rejects.toThrow(/aborted/)
      const cancel = findCall(stub.calls, 'DELETE', '/v1/videos/task-9')
      expect(cancel).toBeDefined()
      // cancel 必须自带新的超时信号，不能挂在已经 abort 的 signal 上。
      expect(cancel!.aborted).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('openai-videos cancels when the polling budget runs out', async () => {
    vi.useFakeTimers()
    const stub = stubFetch((call) =>
      call.method === 'POST' ? { body: { id: 'task-10' } } : { body: { status: 'processing' } },
    )
    try {
      const run = generateMedia('newapi', { model: 'sora-2', prompt: 'a cat' } as never, 'sk-cancel-test')
      // 先挂上 rejection handler，再排空定时器，否则预期拒绝会被报成 unhandled。
      const settled = expect(run).rejects.toThrow(/did not complete within/)
      await vi.runAllTimersAsync()
      await settled
      expect(findCall(stub.calls, 'DELETE', '/v1/videos/task-10')).toBeDefined()
    } finally {
      stub.restore()
      vi.useRealTimers()
    }
  })

  it('replicate-prediction-image uses its declared POST cancel endpoint', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST' && call.url.endsWith('/v1/predictions')
        ? { body: { id: 'task-11', status: 'starting' } }
        : { body: { status: 'failed', error: 'cuda oom' } },
    )
    try {
      await expect(
        generateMedia('replicate-prediction-image', { model: 'sd-xl', prompt: 'a cat' } as never, 'sk-cancel-test'),
      ).rejects.toThrow(/Task failed/)
      expect(findCall(stub.calls, 'POST', '/v1/predictions/task-11/cancel')).toBeDefined()
      expect(stub.calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })

  it('volcengine-ark-video cancels its generation task with DELETE', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? { body: { id: 'task-12' } }
        : { body: { status: 'failed', error: { message: 'content policy' } } },
    )
    try {
      await expect(
        generateMedia('volcengine-ark-video', { model: 'seedance-1-0-pro', prompt: 'a cat' } as never, 'sk-cancel-test'),
      ).rejects.toThrow(/Task failed/)
      expect(findCall(stub.calls, 'DELETE', '/api/v3/contents/generations/tasks/task-12')).toBeDefined()
    } finally {
      stub.restore()
    }
  })

  it('providers without a cancel declaration send no extra request on failure', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? { body: { request_id: 'req-13', prompt_id: 'p-13' } }
        : { body: { status: 'FAILED', detail: 'worker crashed' } },
    )
    try {
      await expect(
        generateMedia(
          'fal-queue-image',
          {
            model: 'fal-queue-image',
            prompt: 'a cat',
            providerOptions: { 'fal-queue-image': { statusPath: 'queue/p-13' } },
          } as never,
          'sk-cancel-test',
        ),
      ).rejects.toThrow(/Task failed/)
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'POST https://queue.fal.run/fal-queue-image',
        'GET https://queue.fal.run/queue/p-13',
      ])
    } finally {
      stub.restore()
    }
  })

  it('a successful task is never cancelled', async () => {
    // 成功夹具必须用该 manifest 声明的媒体位置：openai-videos.json:244-256 的
    // response.videos = $coalesce[response.url, response.video_url, response.output.url]。
    // `content: [{url}]` 在该 manifest 里只作为 /content 结果端点存在（:192），
    // 不是轮询响应里的媒体字段。
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? { body: { id: 'task-14' } }
        : { body: { status: 'completed', url: 'https://cdn.example/newapi.mp4' } },
    )
    try {
      const assets = await generateMedia('newapi', { model: 'sora-2', prompt: 'a cat' } as never, 'sk-cancel-test')
      expect(assets).toEqual([
        { mediaType: 'video', type: 'url', url: 'https://cdn.example/newapi.mp4' },
      ])
      expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'POST https://api.openai.com/v1/videos',
        'GET https://api.openai.com/v1/videos/task-14',
      ])
    } finally {
      stub.restore()
    }
  })
})
