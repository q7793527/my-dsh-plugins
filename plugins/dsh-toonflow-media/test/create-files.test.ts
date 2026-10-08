import { describe, expect, it } from 'vitest'
import { generateMedia } from '../lib/generate.js'
import { b64Bytes, blobBytes, dataUrl, formOf, headerValue, partName, stubFetch } from './fetch-stub.js'

/**
 * create.files 必须被解释成真正的 multipart 上传：字段名来自 manifest 的
 * create.files[].name，内容来自 source 描述符解析出的媒体项。这些用例用 4 个
 * 真实 manifest（ideogram-image / openai-images / openai-videos / stability-image）
 * 离线复现「声明了 files 却只发 JSON body」，并守住无 files 渠道零变化。
 */

describe('create.files drives a real multipart upload', () => {
  it('ideogram-image uploads files under the manifest field names', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'GET') {
        return {
          body: call.url.includes('mask') ? new Uint8Array([9, 8, 7]) : new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
        }
      }
      return { body: { data: [{ url: 'https://cdn.example/ideogram-out.png' }] } }
    })
    try {
      const assets = await generateMedia(
        'ideogram-image',
        {
          model: 'ideogram-v3',
          prompt: 'a cat',
          images: [
            { role: 'edit_source', url: 'https://cdn.example/ref.png', order: 1 },
            { role: 'mask', url: 'https://cdn.example/mask.png', order: 2 },
          ],
        } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')
      expect(create).toBeDefined()
      // create.pathTemplate 必须被解释，manifest 里没有静态 create.path。
      expect(create!.url).toBe('https://api.ideogram.ai/v1/ideogram-v3/generate')
      const form = formOf(create!)
      // multipart 的 boundary 由 fetch 生成：显式 Content-Type 会让请求报废。
      expect(headerValue(create!, 'content-type')).toBeUndefined()
      expect(form.get('prompt')).toBe('a cat')
      expect(partName(form.get('image'))).toBe('reference.png')
      expect(await blobBytes(form.get('image'))).toEqual(new Uint8Array([1, 2, 3]))
      expect(partName(form.get('mask'))).toBe('mask.png')
      expect(await blobBytes(form.get('mask'))).toEqual(new Uint8Array([9, 8, 7]))
      // 远程图片必须先取字节再作为文件字段上传。
      const downloads = stub.calls.filter((c) => c.method === 'GET').map((c) => c.url)
      expect(downloads).toEqual(['https://cdn.example/ref.png', 'https://cdn.example/mask.png'])
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/ideogram-out.png' }])
    } finally {
      stub.restore()
    }
  })

  it('ideogram-image resolves create.pathTemplate through $coalesce', async () => {
    const stub = stubFetch(() => ({ body: { data: [{ url: 'https://cdn.example/ideogram-out.png' }] } }))
    try {
      await generateMedia(
        'ideogram-image',
        {
          model: 'ideogram-v3',
          prompt: 'a cat',
          providerOptions: { 'ideogram-image': { endpoint: '/v1/ideogram-v4/generate' } },
        } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      expect(create.url).toBe('https://api.ideogram.ai/v1/ideogram-v4/generate')
      const form = formOf(create)
      // 没有图片输入就不该凭空造文件字段。
      expect(form.get('image')).toBeNull()
      expect(form.get('mask')).toBeNull()
    } finally {
      stub.restore()
    }
  })

  it('openai-image keeps a JSON body when no images are supplied', async () => {
    const stub = stubFetch(() => ({ body: { data: [{ url: 'https://cdn.example/openai-out.png' }] } }))
    try {
      const assets = await generateMedia(
        'openai-image',
        { model: 'gpt-image-1', prompt: 'a cat' } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      expect(create.url).toBe('https://api.openai.com/v1/images/generations')
      expect(typeof create.body).toBe('string')
      expect(headerValue(create, 'content-type')).toBe('application/json')
      expect(JSON.parse(String(create.body))).toMatchObject({ model: 'gpt-image-1', prompt: 'a cat' })
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/openai-out.png' }])
    } finally {
      stub.restore()
    }
  })

  it('openai-image switches to /v1/images/edits multipart when images are supplied', async () => {
    const stub = stubFetch(() => ({ body: { data: [{ url: 'https://cdn.example/openai-edit.png' }] } }))
    try {
      await generateMedia(
        'openai-image',
        {
          model: 'gpt-image-1',
          prompt: 'a cat',
          images: [
            { role: 'edit_source', url: dataUrl('QUJD'), order: 1 },
            { role: 'reference_image', url: dataUrl('REVG'), order: 2 },
            { role: 'mask', url: dataUrl('TWFzay1tYXNr'), order: 3 },
          ],
        } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      // contentTypeTemplate / pathTemplate 都按 request.images 是否为空切换。
      expect(create.url).toBe('https://api.openai.com/v1/images/edits')
      const form = formOf(create)
      expect(headerValue(create, 'content-type')).toBeUndefined()
      const images = form.getAll('image')
      expect(images).toHaveLength(2)
      expect(await blobBytes(images[0])).toEqual(b64Bytes('QUJD'))
      expect(await blobBytes(images[1])).toEqual(b64Bytes('REVG'))
      expect(partName(form.get('mask'))).toBe('mask.png')
      expect(await blobBytes(form.get('mask'))).toEqual(b64Bytes('TWFzay1tYXNr'))
      // data: URL 自带字节，不该多发一次下载请求。
      expect(stub.calls.filter((c) => c.method === 'GET')).toEqual([])
    } finally {
      stub.restore()
    }
  })

  it('openai-videos uploads the reference image under the declared field name', async () => {
    const stub = stubFetch((call) => {
      if (call.method === 'POST') return { body: { id: 'task-7' } }
      if (call.url.includes('/content')) return { body: new Uint8Array([0, 1, 2, 3]), contentType: 'video/mp4' }
      return { body: { status: 'completed' } }
    })
    try {
      const assets = await generateMedia(
        'newapi',
        {
          model: 'sora-2',
          prompt: 'a cat',
          images: [{ role: 'first_frame', url: dataUrl('QUJD'), order: 1 }],
        } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      expect(create.url).toBe('https://api.openai.com/v1/videos')
      const form = formOf(create)
      expect(partName(form.get('input_reference'))).toBe('input-reference.png')
      expect(await blobBytes(form.get('input_reference'))).toEqual(b64Bytes('QUJD'))
      expect(stub.calls.map((c) => c.url)).toEqual([
        'https://api.openai.com/v1/videos',
        'https://api.openai.com/v1/videos/task-7',
        'https://api.openai.com/v1/videos/task-7/content',
      ])
      expect(assets).toEqual([
        { mediaType: 'video', type: 'binary', data: new Uint8Array([0, 1, 2, 3]), mimeType: 'video/mp4' },
      ])
    } finally {
      stub.restore()
    }
  })

  it('stability-image routes media by the manifest role filter and $sortByOrder', async () => {
    const stub = stubFetch(() => ({ body: { image: 'QUJD', mime_type: 'image/png' } }))
    try {
      await generateMedia(
        'stability-image',
        {
          model: 'core',
          prompt: 'a cat',
          images: [
            { role: 'mask', url: dataUrl('TWFzay1tYXNr'), order: 9 },
            { role: 'reference_image', url: dataUrl('QUJD'), order: 2 },
            { role: 'edit_source', url: dataUrl('REVG'), order: 1 },
          ],
        } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      expect(create.url).toBe('https://api.stability.ai/v2beta/stable-image/generate/core')
      const form = formOf(create)
      expect(headerValue(create, 'content-type')).toBeUndefined()
      // $sortByOrder + $first：order 最小的非 mask 图进 image 字段。
      expect(await blobBytes(form.get('image'))).toEqual(b64Bytes('REVG'))
      expect(await blobBytes(form.get('mask'))).toEqual(b64Bytes('TWFzay1tYXNr'))
      expect(form.get('prompt')).toBe('a cat')
    } finally {
      stub.restore()
    }
  })

  it('providers without create.files keep sending the same JSON body', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? { body: { id: 'task-bfl-1' } }
        : { body: { status: 'COMPLETED', data: { image_url: 'https://cdn.example/bfl-1.png' } } },
    )
    try {
      const assets = await generateMedia(
        'bfl-flux',
        { model: 'flux-schnell', prompt: 'a cat' } as never,
        'sk-files-test',
      )
      const create = stub.calls.find((c) => c.method === 'POST')!
      expect(create.url).toBe('https://api.bfl.ai/v1/flux-schnell')
      expect(typeof create.body).toBe('string')
      expect(headerValue(create, 'content-type')).toBe('application/json')
      expect(assets).toEqual([{ mediaType: 'image', type: 'url', url: 'https://cdn.example/bfl-1.png' }])
    } finally {
      stub.restore()
    }
  })
})
