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
  /** 与 fetch 的 init.body 同类型（可为 null，表示显式无 body）。 */
  body: RequestInit['body']
  /** 请求发出时携带的 signal 是否已经 abort —— cancel 不能复用被 abort 的 signal。 */
  aborted: boolean
}

/**
 * 测试替身要返回的响应体：真实 JSON 值（对象/数组/标量）或已就绪的 BodyInit。
 * stubFetch 会把 JSON 值序列化后交给 Response，见 serializeBody。
 * 对象成员允许 undefined —— 测试字面量里的可选属性（`status?: undefined`）就是它。
 */
type JsonBody = string | number | boolean | null | JsonBody[] | { [key: string]: JsonBody | undefined }

export type StubResponse = { status?: number; body?: BodyInit | JsonBody; contentType?: string }

/**
 * Uint8Array 收窄到 BodyInit 实际要求的 ArrayBufferView<ArrayBuffer>
 * （裸 Uint8Array 是 Uint8Array<ArrayBufferLike>，赋不进 BodyInit）。
 */
function isBytes(raw: BodyInit | JsonBody): raw is Uint8Array<ArrayBuffer> {
  return raw instanceof Uint8Array
}

/** 响应体出站：string / Uint8Array / Blob 原样交给 Response，其余（含 JSON 对象）序列化。 */
function serializeBody(raw: BodyInit | JsonBody): BodyInit {
  if (typeof raw === 'string') return raw
  // 先收到 object 再判断字节视图：JsonBody 里的标量会污染 instanceof 的收窄结果。
  if (typeof raw === 'object' && raw !== null && isBytes(raw)) return raw
  if (raw instanceof Blob) return raw
  return JSON.stringify(raw)
}

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
    const raw: BodyInit | JsonBody = out.body ?? '{}'
    // Response 只接受 string / BufferSource / Blob / ReadableStream：
    // 传对象会被隐式转成 "[object Object]"，测试替身必须自己序列化。
    const payload: BodyInit = serializeBody(raw)
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
