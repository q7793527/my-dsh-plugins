/**
 * 共享的 fetch 测试替身：记录每次请求的 method / url / headers / body，
 * 让断言能落到「请求到底长什么样」上（JSON 还是 multipart、字段名来自哪里）。
 * 绝不发真实网络请求。
 *
 * vitest.config.mjs 没开 globals，这里不是 *.test.ts，所以 expect 必须显式 import，
 * 否则 formOf/blobBytes 会抛 ReferenceError。
 */

import { expect } from 'vitest'

export type RecordedCall = {
  method: string
  url: string
  headers: Record<string, string>
  body: BodyInit | undefined
  /** 请求发出时携带的 signal 是否已经 abort —— cancel 不能复用被 abort 的 signal。 */
  aborted: boolean
}

export type StubResponse = { status?: number; body?: BodyInit; contentType?: string }

export function stubFetch(respond: (call: RecordedCall) => StubResponse | undefined) {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body,
      aborted: init?.signal?.aborted === true,
    }
    calls.push(call)
    const out = respond(call) ?? {}
    const raw: BodyInit = out.body ?? '{}'
    // Response 只接受 string / BufferSource / Blob / ReadableStream：
    // 传对象会被隐式转成 "[object Object]"，测试替身必须自己序列化。
    const payload: BodyInit =
      typeof raw === 'string' || raw instanceof Uint8Array || raw instanceof Blob ? raw : JSON.stringify(raw)
    return new Response(payload, {
      status: out.status ?? 200,
      headers: { 'content-type': out.contentType ?? 'application/json' },
    })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** Header 查找必须大小写无关，否则「没有显式 Content-Type」这种断言会假绿。 */
export function headerValue(call: RecordedCall, name: string): string | undefined {
  const key = Object.keys(call.headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? call.headers[key] : undefined
}

export function formOf(call: RecordedCall): FormData {
  expect(call.body).toBeInstanceOf(FormData)
  return call.body as FormData
}

export async function blobBytes(part: unknown): Promise<Uint8Array> {
  expect(part).toBeInstanceOf(Blob)
  return new Uint8Array(await (part as Blob).arrayBuffer())
}

export function partName(part: unknown): string | undefined {
  return (part as File | undefined)?.name
}

export const dataUrl = (base64: string) => `data:image/png;base64,${base64}`
export const b64Bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
