import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as plugin from '../lib/index.js'

type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => unknown[] }
  execute: (args: any, exec?: unknown) => Promise<unknown>
}

function collect(ctx: any): ToolDef[] {
  const defs: ToolDef[] = []
  plugin.apply({ ...ctx, tools: { register: (def: ToolDef) => defs.push(def) } })
  return defs
}

function withDshHome<T>(target: string, run: () => T | Promise<T>): Promise<T> {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = target
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    })
}

describe('plugin contract', () => {
  it('exposes the cordis entry contract', () => {
    expect(plugin.name).toBe('dsh-toonflow-media')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('registers the three tools inside an effect layer', () => {
    const defs = collect({ effect: (fn: () => void) => fn() })
    expect(defs.map((d) => d.name)).toEqual([
      'toonflow_media_list_models',
      'toonflow_media_generate',
      'toonflow_media_set_key',
    ])
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(20)
      expect(def.parameters.type).toBe('object')
      expect(def.output.schema.type).toBe('object')
      expect(typeof def.output.render).toBe('function')
      expect(Array.isArray(def.output.render({}, {}))).toBe(true)
    }
  })

  it('registers nothing when the host gives no effect layer', () => {
    expect(collect({})).toEqual([])
  })
})

describe('tool output rendering', () => {
  const defs = collect({ effect: (fn: () => void) => fn() })
  const [list, gen, key] = defs

  it('renders the provider list', () => {
    const text = list.output.render({}, { providers: 'a\nb' }) as { text: string }[]
    expect(text[0].text).toBe('Available media providers:\na\nb')
  })

  it('renders url, base64 and binary assets', () => {
    const render = (assets: unknown[]) => (gen.output.render({}, { assets }) as { text: string }[])[0].text
    expect(render([{ mediaType: 'image', type: 'url', url: 'https://x/y.png' }])).toBe(
      'Generated media:\n- [image] https://x/y.png',
    )
    expect(render([{ mediaType: 'image', type: 'base64', data: 'abcd' }])).toBe(
      'Generated media:\n- [image] base64 (4 chars)',
    )
    expect(render([{ mediaType: 'video', type: 'base64' }])).toBe('Generated media:\n- [video] base64 (0 chars)')
    expect(render([{ mediaType: 'audio', type: 'binary', mimeType: 'audio/mpeg' }])).toBe(
      'Generated media:\n- [audio] binary (audio/mpeg)',
    )
    expect(render([{ mediaType: 'audio', type: 'binary' }])).toBe('Generated media:\n- [audio] binary ()')
  })

  it('renders a safe shape when the tool result is missing fields', () => {
    const text = (def: ToolDef, value: unknown) => (def.output.render({}, value) as { text: string }[])[0].text
    expect(text(gen, {})).toBe('Generated media:\n- (no media returned)')
    expect(text(gen, { assets: [null, { mediaType: 'image' }] })).toBe(
      'Generated media:\n- [media] binary ()\n- [image] binary ()',
    )
    expect(text(list, {})).toBe('Available media providers:\n')
    expect(text(key, {})).toBe('Failed to set key for unknown provider')
  })

  it('renders key persistence success and failure', () => {
    const text = (value: { ok: boolean; providerId: string }) =>
      (key.output.render({}, value) as { text: string }[])[0].text
    expect(text({ ok: true, providerId: 'adobe-firefly' })).toBe('API key set for adobe-firefly')
    expect(text({ ok: false, providerId: 'adobe-firefly' })).toBe('Failed to set key for adobe-firefly')
  })
})

describe('tool execution', () => {
  const [list, gen, key] = collect({ effect: (fn: () => void) => fn() })

  it('lists every shipped provider', async () => {
    const value = (await list.execute({}, {})) as { providers: string }
    expect(value.providers.split('\n').filter(Boolean).length).toBe(86)
  })

  it('rejects an unknown provider before any request', async () => {
    await expect(gen.execute({ providerId: 'no-such-provider', model: 'm' })).rejects.toThrow(/Provider not found/)
  })

  it('rejects a known provider that has no stored key', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'toonflow-index-'))
    await withDshHome(home, async () => {
      await expect(gen.execute({ providerId: 'adobe-firefly', model: 'm' })).rejects.toThrow(/API key not set/)
    })
    rmSync(home, { recursive: true, force: true })
  })

  it('persists a key when the target directory is writable, and reports failure when it is not', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'toonflow-index-'))
    // configPath() 在调用时读 DSH_HOME，所以必须先把 DSH_HOME 指到临时目录，
    // 否则会把 key 写进真实的 DSH_HOME。
    const ok = (await withDshHome(home, async () =>
      key.execute({ providerId: 'adobe-firefly', apiKey: 'sk-index-dummy' }),
    )) as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(existsSync(join(home, 'toonflow-media', 'config.json'))).toBe(true)
    rmSync(home, { recursive: true, force: true })

    // 让落盘真正失败：DSH_HOME 落在一个普通文件下面，mkdir 必然 ENOTDIR。
    const blockedRoot = mkdtempSync(join(os.tmpdir(), 'toonflow-index-'))
    const blocker = join(blockedRoot, 'afile')
    writeFileSync(blocker, 'not a directory')
    const failed = (await withDshHome(join(blocker, 'sub'), async () =>
      key.execute({ providerId: 'adobe-firefly', apiKey: 'sk-index-dummy' }),
    )) as { ok: boolean }
    expect(failed.ok).toBe(false)
    rmSync(blockedRoot, { recursive: true, force: true })
  })
})
