import { describe, expect, it } from 'vitest'
import { buildMultipartBody, createRequestSpec } from '../lib/upload.js'
import { blobBytes, partName } from './fetch-stub.js'

/**
 * multipart 上传契约的直测：真实 manifest 只覆盖「正常形状」的 media 项，
 * 而 resolveItems / mediaSource / toFilePart / appendScalar 上的回落分支
 * （空 create、无 source、非对象 body、标量类型、下载失败、data: URL 的
 * 各种残缺形态）在 corpus 里无从触发，必须直接喂畸形输入验证。
 */

type AnyRec = Record<string, unknown>
const ctx = { request: { images: [] }, response: {} } as never

function makeContext(fetchImpl: (url: string) => Promise<Response> = async () => new Response('{}')) {
  const controller = new AbortController()
  return {
    config: { apiKey: 'sk-test' },
    signal: controller.signal,
    tool: { fetch: (url: string, _init?: unknown) => fetchImpl(url) },
  } as never
}

describe('createRequestSpec', () => {
  it('resolves static path and content type with no files', () => {
    const spec = createRequestSpec({ create: { path: '/v1/gen', contentType: 'application/json' } } as never, ctx)
    expect(spec).toEqual({ path: '/v1/gen', contentType: 'application/json', multipart: false })
  })

  it('falls back to empty strings when the manifest declares no create endpoint at all', () => {
    const spec = createRequestSpec({ create: {} } as never, ctx)
    expect(spec).toEqual({ path: '', contentType: '', multipart: false })
  })

  it('renders pathTemplate/contentTypeTemplate and flags multipart only when files and the type agree', () => {
    const withFiles = createRequestSpec(
      {
        create: {
          pathTemplate: '/v1/{{request.model}}/edits',
          contentTypeTemplate: 'multipart/form-data',
          files: [{ name: 'image', source: { $ref: 'request.images' } }],
        },
      } as never,
      ctx,
    )
    expect(withFiles).toEqual({
      // createRequestSpec 阶段只做描述符求值；{{...}} 占位符留给执行期的 renderPath。
      path: '/v1/{{request.model}}/edits',
      contentType: 'multipart/form-data',
      multipart: true,
    })

    const jsonOnly = createRequestSpec(
      { create: { path: '/v1/x', contentType: 'application/json', files: [{ name: 'f' }] } } as never,
      ctx,
    )
    expect(jsonOnly.multipart).toBe(false)
  })
})

describe('buildMultipartBody scalar fields', () => {
  const base = { create: { path: '/v1/x', contentType: 'multipart/form-data' } }

  it('appends string, number, boolean and object scalars in their stringified forms', async () => {
    const form = await buildMultipartBody(
      { ...base, create: { ...base.create, files: [] } } as never,
      { text: 'hello', count: 2, flag: true, nested: { a: 1 }, skip: null, missing: undefined },
      ctx,
      makeContext(),
    )
    expect(form.get('text')).toBe('hello')
    expect(form.get('count')).toBe('2')
    expect(form.get('flag')).toBe('true')
    expect(form.get('nested')).toBe('{"a":1}')
    expect(form.get('skip')).toBeNull()
    expect(form.get('missing')).toBeNull()
  })

  it('ignores a body that is not a plain object (arrays/scalars contribute nothing)', async () => {
    const form = await buildMultipartBody(
      { ...base, create: { ...base.create, files: [] } } as never,
      ['not', 'an', 'object'],
      ctx,
      makeContext(),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('tolerates a provider whose create declares no files array', async () => {
    const form = await buildMultipartBody({ ...base } as never, { prompt: 'p' }, ctx, makeContext())
    expect(form.get('prompt')).toBe('p')
    expect([...form.keys()]).toEqual(['prompt'])
  })
})

describe('buildMultipartBody media parts', () => {
  const provider = (files: unknown[]) => ({
    create: { path: '/v1/x', contentType: 'multipart/form-data', files },
  }) as never

  it('skips file entries that declare no source at all', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'image' }]),
      {},
      ctx,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('skips a source that resolves to a nullish value', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'image', source: { $ref: 'request.images' } }]),
      {},
      { request: { images: null }, response: {} } as never,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('uploads a remote string URL item and names the part from the manifest', async () => {
    const fetched: string[] = []
    const form = await buildMultipartBody(
      provider([{ name: 'ref', source: ['https://cdn.example/a.png'], filename: 'a.png' }]),
      {},
      ctx,
      makeContext(async (url) => {
        fetched.push(url)
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        })
      }),
    )
    expect(fetched).toEqual(['https://cdn.example/a.png'])
    const part = form.get('ref')
    expect(await blobBytes(part)).toEqual(new Uint8Array([1, 2, 3]))
    expect(partName(part)).toBe('a.png')
  })

  it('surfaces an HTTP failure while downloading a media source', async () => {
    const run = buildMultipartBody(
      provider([{ name: 'ref', source: ['https://cdn.example/gone.png'] }]),
      {},
      ctx,
      makeContext(async () => new Response('nope', { status: 404 })),
    )
    await expect(run).rejects.toThrow(/Upload source fetch failed: HTTP 404/)
  })

  it('defaults the downloaded content type to application/octet-stream when the header is absent', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'ref', source: ['https://cdn.example/raw.bin'] }]),
      {},
      ctx,
      makeContext(async () => new Response(new Uint8Array([9])))
    )
    const part = form.get('ref')
    expect(part).toBeInstanceOf(Blob)
    expect((part as Blob).type).toBe('application/octet-stream')
  })

  it('decodes a data: URL string item inline without touching the network', async () => {
    let fetches = 0
    const form = await buildMultipartBody(
      provider([{ name: 'shot', source: ['data:image/png;base64,QUJD'] }]),
      {},
      ctx,
      makeContext(async () => {
        fetches += 1
        return new Response('{}')
      }),
    )
    expect(fetches).toBe(0)
    const part = form.get('shot')
    expect(await blobBytes(part)).toEqual(new Uint8Array(Buffer.from('QUJD', 'base64')))
    expect((part as Blob).type).toBe('image/png')
  })

  it('drops a data: URL string item whose payload is empty', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'broken', source: ['data:text/plain;base64,'] }]),
      {},
      ctx,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('uploads an object item carrying b64_json with its declared mime type', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: { $ref: 'request.images' } }]),
      {},
      { request: { images: [{ b64_json: 'QUJD', mimeType: 'image/png' }] }, response: {} } as never,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    const part = form.get('img')
    expect(await blobBytes(part)).toEqual(new Uint8Array(Buffer.from('QUJD', 'base64')))
    expect((part as Blob).type).toBe('image/png')
  })

  it('defaults the mime type of a b64_json object item that declares none', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: { $ref: 'request.images' } }]),
      {},
      { request: { images: [{ b64_json: 'QUJD' }] }, response: {} } as never,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    const part = form.get('img')
    expect((part as Blob).type).toBe('application/octet-stream')
  })

  it('inlines an object item whose url is a data: URL instead of fetching it', async () => {
    let fetches = 0
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: { $ref: 'request.images' } }]),
      {},
      {
        request: { images: [{ url: 'data:image/png;base64,QUJD' }] },
        response: {},
      } as never,
      makeContext(async () => {
        fetches += 1
        return new Response('{}')
      }),
    )
    expect(fetches).toBe(0)
    const part = form.get('img')
    expect(await blobBytes(part)).toEqual(new Uint8Array(Buffer.from('QUJD', 'base64')))
  })

  it('drops an object item whose data: URL payload is empty', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: { $ref: 'request.images' } }]),
      {},
      { request: { images: [{ url: 'data:;base64,' }] }, response: {} } as never,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('drops an object item that carries neither url nor base64 material', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: { $ref: 'request.images' } }]),
      {},
      { request: { images: [{ unrelated: 1 }] }, response: {} } as never,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    expect([...form.keys()]).toEqual([])
  })

  it('appends a nameless part when the manifest omits filename', async () => {
    const form = await buildMultipartBody(
      provider([{ name: 'img', source: ['data:image/png;base64,QUJD'] }]),
      {},
      ctx,
      makeContext(async () => {
        throw new Error('must not download')
      }),
    )
    const part = form.get('img')
    expect(await blobBytes(part)).toEqual(new Uint8Array(Buffer.from('QUJD', 'base64')))
    // 未传 filename 时 FormData 把 Blob 包装成默认名为 'blob' 的 File。
    expect(partName(part)).toBe('blob')
  })
})
