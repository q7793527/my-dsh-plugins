import { describe, expect, it } from 'vitest'
import { apply } from '../lib/index.js'
import { headerValue, stubFetch } from './fetch-stub.js'

/**
 * gen.execute 的成功路径：现有 index 测试只走「Provider not found / API key
 * not set」两条拒绝分支，L112 的正常返回与 `k !== 'apiKey'` 的参数过滤
 * （apiKey 不得泄漏进请求体）从未被执行；render 的 `(no url)` 兜底同理。
 */

type Tool = {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { schema: { render: (args: unknown, value: unknown) => { type: string; text: string }[] } }
}

function collect(): Tool[] {
  const tools: Tool[] = []
  apply({ effect: (fn: () => void) => fn(), tools: { register: (t: Tool) => tools.push(t) } })
  return tools
}

describe('toonflow_media_generate success path', () => {
  it('returns assets, sends the rendered body, and keeps apiKey out of it', async () => {
    const stub = stubFetch(() => ({ body: { data: [{ url: 'https://cdn.example/i.png' }] } }))
    try {
      const tools = collect()
      const gen = tools.find((t) => t.name === 'toonflow_media_generate')
      expect(gen).toBeDefined()

      const out = (await gen!.execute(
        { providerId: 'openai-image', model: 'gpt-image-1', prompt: 'a cat', apiKey: 'sk-explicit' },
        {},
      )) as { assets: { mediaType: string; type: string; url?: string }[] }

      expect(out.assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/i.png' }])
      expect(stub.calls).toHaveLength(1)
      const call = stub.calls[0]
      expect(call.method).toBe('POST')
      expect(call.url).toBe('https://api.openai.com/v1/images/generations')
      expect(headerValue(call, 'authorization')).toBe('Bearer sk-explicit')
      const body = JSON.parse(String(call.body))
      expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a cat' })
      // args 里的 providerId/model/apiKey 只参与执行，不许混进上游请求体。
      expect(body).not.toHaveProperty('providerId')
      expect(body).not.toHaveProperty('apiKey')
    } finally {
      stub.restore()
    }
  })
})

describe('toonflow_media_generate render', () => {
  it('renders a url asset that is missing its url as (no url)', () => {
    const tools = collect()
    const gen = tools.find((t) => t.name === 'toonflow_media_generate')
    const rendered = gen!.output.render({}, { assets: [{ mediaType: 'image', type: 'url' }] })
    expect(rendered).toHaveLength(1)
    expect(rendered[0].text).toContain('- [image] (no url)')
    expect(rendered[0].text.startsWith('Generated media:')).toBe(true)
  })
})
