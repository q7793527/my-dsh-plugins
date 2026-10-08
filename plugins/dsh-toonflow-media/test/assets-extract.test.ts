import { describe, expect, it } from 'vitest'
import { descriptorKeyFor, extractAssets, normalizeAssets, readPath, readResponseField } from '../lib/assets.js'

/**
 * 资产提取的回落链（declared descriptor → resultPaths → 硬编码 URL 表）已被
 * 集成测试走通，这里直测的是回落链上的分支本身：nullish 载荷、单字符串路径、
 * base64 形状、mediaType 键选择、readResponseField 的四种 field 形状。
 */

const ctx = { request: {}, response: {} } as never

describe('readPath', () => {
  it('returns undefined for nullish roots instead of throwing', () => {
    expect(readPath(null, 'a.b')).toBeUndefined()
    expect(readPath(undefined, ['a'])).toBeUndefined()
  })

  it('accepts a single dotted path string as well as an array', () => {
    expect(readPath({ a: { b: 7 } }, 'a.b')).toBe(7)
    expect(readPath({ a: 7 }, ['missing', 'a'])).toBe(7)
  })

  it('skips empty-string hits and keeps looking at the next candidate', () => {
    expect(readPath({ a: '', b: 'kept' }, ['a', 'b'])).toBe('kept')
    expect(readPath({ a: null, b: null }, ['a', 'b'])).toBeUndefined()
  })
})

describe('normalizeAssets', () => {
  it('returns nothing for nullish or non-object payloads', () => {
    expect(normalizeAssets('image', null)).toEqual([])
    expect(normalizeAssets('image', undefined)).toEqual([])
    expect(normalizeAssets('image', 42)).toEqual([])
    expect(normalizeAssets('image', '')).toEqual([])
  })

  it('flattens arrays of url strings', () => {
    expect(normalizeAssets('video', ['https://a/v.mp4', 'https://b/v.mp4'])).toEqual([
      { mediaType: 'video', type: 'url', url: 'https://a/v.mp4' },
      { mediaType: 'video', type: 'url', url: 'https://b/v.mp4' },
    ])
  })

  it('builds a base64 asset from b64_json with its declared mime type', () => {
    expect(normalizeAssets('image', { b64_json: 'QUJD', mimeType: 'image/png' })).toEqual([
      { mediaType: 'image', type: 'base64', data: 'QUJD', mimeType: 'image/png' },
    ])
  })

  it('leaves the mime type undefined when the value is not a string', () => {
    expect(normalizeAssets('image', { b64_json: 'QUJD', mimeType: 123 })).toEqual([
      { mediaType: 'image', type: 'base64', data: 'QUJD', mimeType: undefined },
    ])
  })

  it('returns nothing for an object that carries neither url nor base64 material', () => {
    expect(normalizeAssets('audio', { status: 'done' })).toEqual([])
  })
})

describe('descriptorKeyFor', () => {
  it('maps every media type to its manifest key', () => {
    expect(descriptorKeyFor('image')).toBe('images')
    expect(descriptorKeyFor('video')).toBe('videos')
    expect(descriptorKeyFor('audio')).toBe('audios')
  })
})

describe('readResponseField', () => {
  it('reads dotted path strings directly off the payload', () => {
    expect(readResponseField('data.url', { data: { url: 'u' } }, [], ctx)).toBe('u')
    expect(readResponseField(['nope', 'data.url'], { data: { url: 'u' } }, [], ctx)).toBe('u')
  })

  it('interprets template descriptors with the payload bound as response', () => {
    const field = { $coalesce: [{ $ref: 'response.data.url' }, 'fallback'] }
    expect(readResponseField(field, { data: { url: 'u' } }, [], ctx)).toBe('u')
    expect(readResponseField(field, {}, [], ctx)).toBe('fallback')
  })

  it('falls back to the hardcoded path list when the manifest declares nothing', () => {
    expect(readResponseField(undefined, { results: [1] }, ['results'], ctx)).toEqual([1])
    expect(readResponseField(undefined, {}, ['results'], ctx)).toBeUndefined()
  })
})

describe('extractAssets', () => {
  it('uses the audio-specific descriptor key for audio media types', () => {
    const provider = { response: { audio: { $ref: 'response.audio_url' } } } as never
    expect(extractAssets('audio', { audio_url: 'https://cdn/a.mp3' }, provider, ctx)).toEqual([
      { mediaType: 'audio', type: 'url', url: 'https://cdn/a.mp3' },
    ])
  })

  it('ignores the audio descriptor when extracting an image', () => {
    // speech_url 不在内置 URL 兜底表里：若 image 错误地读了 response.audio
    // 描述符就会产出资产，这里必须为空。
    const provider = { response: { audio: { $ref: 'response.speech_url' } } } as never
    expect(extractAssets('image', { speech_url: 'https://cdn/a.mp3' }, provider, ctx)).toEqual([])
  })

  it('falls through to declared resultPaths before the payload itself', () => {
    const provider = { response: { resultPaths: ['data.output.url'] } } as never
    expect(extractAssets('image', { data: { output: { url: 'https://cdn/i.png' } } }, provider, ctx)).toEqual([
      { mediaType: 'image', type: 'url', url: 'https://cdn/i.png' },
    ])
  })

  it('falls back to scanning the payload when the manifest declares nothing', () => {
    expect(extractAssets('image', { image_url: 'https://cdn/i.png' }, { response: {} } as never, ctx)).toEqual([
      { mediaType: 'image', type: 'url', url: 'https://cdn/i.png' },
    ])
  })

  it('returns an empty list when no location holds media', () => {
    expect(extractAssets('video', { status: 'done' }, { response: {} } as never, ctx)).toEqual([])
    expect(extractAssets('video', null, { response: {} } as never, ctx)).toEqual([])
  })
})
