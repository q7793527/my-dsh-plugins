import { describe, expect, it, vi } from 'vitest'
import {
  GENERATION_BUDGET_MS,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  POLL_MARGIN_MS,
  generateMedia,
} from '../lib/generate.js'

// 防回归：轮询预算必须 <= abort 预算，且真实轮询循环不会越过 abort 截止点。
describe('generation timeout budget is self-consistent', () => {
  it('poll attempts fit inside the abort budget with margin left over', () => {
    expect(GENERATION_BUDGET_MS).toBe(30 * 60_000)
    expect(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS + POLL_MARGIN_MS).toBeLessThanOrEqual(GENERATION_BUDGET_MS)
    expect(MAX_POLL_ATTEMPTS).toBe(Math.floor((GENERATION_BUDGET_MS - POLL_MARGIN_MS) / POLL_INTERVAL_MS))
  })

  it('stops polling before the abort deadline when the task never completes', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(JSON.stringify({ id: 'task-1', status: 'processing' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const startedAt = Date.now()
      const run = generateMedia('bfl-flux', { model: 'flux-schnell', prompt: 'a cat' } as any, 'sk-fake')
      // Attach the rejection handler before draining timers, otherwise the expected
      // rejection lands while nothing is listening and vitest reports it as unhandled.
      const settled = expect(run).rejects.toThrow(/did not complete within/)
      await vi.runAllTimersAsync()
      await settled

      const elapsed = Date.now() - startedAt
      // 轮询总时长必须留在 abort 预算之内，并保留收尾余量。
      expect(elapsed).toBeLessThanOrEqual(GENERATION_BUDGET_MS - POLL_MARGIN_MS)
      expect(fetchCalls).toBeLessThanOrEqual(MAX_POLL_ATTEMPTS + 1)
    } finally {
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })
})
