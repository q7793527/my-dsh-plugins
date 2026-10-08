import { describe, expect, it, vi } from 'vitest'
import { generateMedia } from '../lib/generate.js'

/**
 * Regression guard for the poll path: manifests declare `response.taskId` and
 * `response.status` as template descriptors (`$coalesce` + `$ref`), not as dotted
 * path strings. Handing a descriptor to the plain path reader crashes with
 * `TypeError: path.split is not a function`, which took down every async provider.
 * The providers below resolve those fields through refs that the hardcoded
 * fallback lists cannot reach, so a green run proves the descriptors were interpreted.
 */
function stubFetch(createBody: unknown, pollBody: unknown) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL, options?: { method?: string }) => {
    const method = options?.method ?? 'GET'
    const href = String(url)
    calls.push(`${method} ${href}`)
    const body = method === 'GET' ? pollBody : createBody
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

describe('async poll descriptors', () => {
  it('reads taskId and status through the manifest refs (dashscope-wanx-image)', async () => {
    // output.task_id / output.task_status are only reachable via $ref, never via
    // the fallback path lists in generate.ts.
    const stub = stubFetch(
      { output: { task_id: 'task-dash-42' } },
      { output: { task_status: 'SUCCEEDED' }, data: { url: 'https://cdn.example/dash.png' } },
    )
    try {
      const assets = await generateMedia(
        'dashscope-wanx-image',
        { model: 'wanx2.1-t2i-turbo', prompt: 'a cat' } as never,
        'sk-descriptor-test',
      )
      expect(assets[0]?.url).toBe('https://cdn.example/dash.png')
      expect(stub.calls.some((c) => c.endsWith('/api/v1/tasks/task-dash-42'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('keeps polling while a $coalesce status ref reports a non-terminal value', async () => {
    // fal-queue-image: taskId comes from response.prompt_id, status from response.status.
    const stub = stubFetch({ prompt_id: 'p-777' }, { status: 'IN_QUEUE', url: 'https://cdn.example/fal.png' })
    vi.useFakeTimers()
    try {
      const run = generateMedia(
        'fal-queue-image',
        {
          model: 'fal-queue-image',
          prompt: 'a cat',
          providerOptions: { 'fal-queue-image': { statusPath: 'queue/p-777' } },
        } as never,
        'sk-descriptor-test',
      )
      const settled = expect(run).rejects.toThrow(/did not complete within/)
      await vi.runAllTimersAsync()
      // The stub never completes the task, so the budget guard must end the loop
      // instead of the poll crashing on the descriptor.
      await settled
      expect(stub.calls.filter((c) => c.startsWith('GET')).length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
      stub.restore()
    }
  })
})
