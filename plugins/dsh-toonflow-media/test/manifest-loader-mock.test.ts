import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { loadManifests, loadProviders } from '../lib/manifest-loader.js'

/**
 * loadProviders 的防御分支：真实 85 个 manifest 全部声明了非空 providers，
 * `contributes.providers ?? []` 的右态和「providers 为空必须抛错」在 corpus 下
 * 永远不可达，只能用受控的 fs 替身喂畸形 manifest 验证（绝不动共享 manifests/）。
 */
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}))

describe('loadProviders validation', () => {
  it('throws for a manifest whose contributes omits providers entirely', () => {
    vi.mocked(readdirSync).mockReturnValue(['broken.json'] as never)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ id: 'broken', contributes: {} }))
    expect(() => loadProviders()).toThrow('Manifest broken has no provider')
    expect(readFileSync).toHaveBeenCalledTimes(1)
  })

  it('throws for a manifest declaring an empty providers array', () => {
    vi.mocked(readdirSync).mockReturnValue(['empty.json'] as never)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ id: 'empty', contributes: { providers: [] } }))
    expect(() => loadProviders()).toThrow('Manifest empty has no provider')
  })

  it('parses each manifest file returned by the directory listing', () => {
    vi.mocked(readdirSync).mockReturnValue(['a.json', 'b.json'] as never)
    vi.mocked(readFileSync).mockImplementation(((p: unknown) =>
      String(p).includes('b.json')
        ? JSON.stringify({ id: 'b', contributes: { providers: [{ id: 'p-b' }] } })
        : JSON.stringify({ id: 'a', contributes: { providers: [{ id: 'p-a' }] } })) as never)
    const manifests = loadManifests()
    expect(manifests.map((m) => m.id)).toEqual(['a', 'b'])
    // loadProviders 内部再次 loadManifests：按文件名的实现必须对重复调用保持稳定。
    expect(loadProviders().map((x) => x.provider.id)).toEqual(['p-a', 'p-b'])
  })
})
