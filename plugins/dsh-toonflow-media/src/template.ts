import type { TemplateNode, TemplateContext } from './types.js'

export type { TemplateNode, TemplateContext } from './types.js'

/** Recursively interpret a manifest template node against a context. */
export function interpret(node: TemplateNode, context: TemplateContext): unknown {
  if (node == null) return node
  if (Array.isArray(node)) return node.map((x) => interpret(x as TemplateNode, context))
  if (typeof node !== 'object') return node
  const obj = node as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 1 && keys[0].startsWith('$')) {
    return interpretOp(keys[0].slice(1), obj[keys[0]], context)
  }
  const result: Record<string, unknown> = {}
  for (const k of keys) {
    result[k] = interpret(obj[k] as TemplateNode, context)
  }
  return result
}

/** Resolve a dotted path (e.g. "request.model" or "media.role") against context. */
export function extractValue(context: TemplateContext, path: string): unknown {
  if (path === 'request') return context.request
  if (path === 'response') return context.response
  const [root, ...rest] = path.split('.')
  let value = context[root]
  for (const part of rest) {
    if (value == null) return undefined
    if (Array.isArray(value)) {
      const idx = Number(part)
      if (Number.isInteger(idx) && idx >= 0 && idx < value.length) {
        value = value[idx]
      } else {
        return undefined
      }
    } else if (typeof value === 'object') {
      value = (value as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return value
}

/** A truthy test: non-null, non-false, non-empty-string, non-zero, non-empty container. */
export function truthy(v: unknown): boolean {
  if (v == null) return false
  if (v === false) return false
  if (v === '') return false
  if (v === 0) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  return 0
}

export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1'
  if (v == null) return false
  return true
}

/* ------------------------------------------------------------------ *
 * Operator implementations. Every `$op` is one small named function
 * registered in OP_HANDLERS, so each operator keeps its own complexity
 * budget instead of sharing one giant switch.
 * ------------------------------------------------------------------ */

type OpHandler = (arg: unknown, context: TemplateContext) => unknown

/** Most operators accept either a single operand or an array of operands. */
function asArgs(arg: unknown): unknown[] {
  return Array.isArray(arg) ? arg : [arg]
}

const opRef: OpHandler = (arg, context) => extractValue(context, String(arg))

const opOmitEmpty: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (v == null) return null
  if (Array.isArray(v) && v.length === 0) return null
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return null
  if (typeof v === 'string' && v.trim() === '') return null
  return v
}

const opCoalesce: OpHandler = (arg, context) => {
  for (const item of asArgs(arg)) {
    const v = interpret(item as TemplateNode, context)
    if (v != null) return v
  }
  return null
}

const opMerge: OpHandler = (arg, context) => {
  const out: Record<string, unknown> = {}
  for (const item of asArgs(arg)) {
    const v = interpret(item as TemplateNode, context)
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v as Record<string, unknown>)
  }
  return out
}

const opMap: OpHandler = (arg, context) => {
  const o = arg as { from?: unknown; as?: string; in?: unknown }
  const from = interpret(o.from as TemplateNode, context)
  if (!Array.isArray(from)) return null
  const out: unknown[] = []
  for (const item of from) {
    const ctx: TemplateContext = { ...context, item, [String(o.as ?? 'item')]: item }
    out.push(interpret(o.in as TemplateNode, ctx))
  }
  return out
}

const opFilter: OpHandler = (arg, context) => {
  const o = arg as { from?: unknown; as?: string; where?: unknown }
  const from = interpret(o.from as TemplateNode, context)
  if (!Array.isArray(from)) return null
  const out: unknown[] = []
  for (const item of from) {
    const ctx: TemplateContext = { ...context, item, [String(o.as ?? 'item')]: item }
    const where = interpret(o.where as TemplateNode, ctx)
    if (truthy(where)) out.push(item)
  }
  return out
}

const opIf: OpHandler = (arg, context) => {
  const o = arg as { condition?: unknown; then?: unknown; else?: unknown }
  const cond = interpret(o.condition as TemplateNode, context)
  return truthy(cond) ? interpret(o.then as TemplateNode, context) : interpret(o.else as TemplateNode, context)
}

const opSwitch: OpHandler = (arg, context) => {
  const o = arg as { cases?: { when?: unknown; then?: unknown }[]; default?: unknown }
  for (const c of o.cases ?? []) {
    if (truthy(interpret(c.when as TemplateNode, context))) return interpret(c.then as TemplateNode, context)
  }
  return interpret(o.default as TemplateNode, context)
}

const opSortByOrder: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (!Array.isArray(v)) return v
  return [...v].sort(
    (a, b) => toNumber((a as Record<string, unknown>)?.order) - toNumber((b as Record<string, unknown>)?.order),
  )
}

const opFirst: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (Array.isArray(v)) return v[0]
  return v
}

const opLen: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (Array.isArray(v)) return v.length
  if (typeof v === 'string') return v.length
  if (v && typeof v === 'object') return Object.keys(v as object).length
  return null
}

const opAt: OpHandler = (arg, context) => {
  const arr = asArgs(arg)
  const v = interpret(arr[0] as TemplateNode, context)
  const idx = toNumber(interpret(arr[1] as TemplateNode, context))
  if (Array.isArray(v) && idx >= 0 && idx < v.length) return v[idx]
  return null
}

const opIndexObject: OpHandler = (arg, context) => {
  const arr = asArgs(arg)
  const v = interpret(arr[0] as TemplateNode, context)
  const key = String(interpret(arr[1] as TemplateNode, context))
  if (v && typeof v === 'object' && !Array.isArray(v)) return (v as Record<string, unknown>)[key]
  return null
}

const opSplit: OpHandler = (arg, context) => {
  const arr = asArgs(arg)
  const s = String(interpret(arr[0] as TemplateNode, context))
  const sep = arr.length > 1 ? String(interpret(arr[1] as TemplateNode, context)) : ' '
  return s.split(sep)
}

const opConcat: OpHandler = (arg, context) =>
  asArgs(arg)
    .map((x) => String(interpret(x as TemplateNode, context)))
    .join('')

const opConcatArrays: OpHandler = (arg, context) => {
  const out: unknown[] = []
  for (const x of asArgs(arg)) {
    const v = interpret(x as TemplateNode, context)
    if (Array.isArray(v)) out.push(...v)
  }
  return out
}

const opDataMime: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (typeof v === 'string' && v.startsWith('data:')) return v.split(';')[0].replace(/^data:/, '')
  return null
}

const opDataPayload: OpHandler = (arg, context) => {
  const v = interpret(arg as TemplateNode, context)
  if (typeof v === 'string' && v.startsWith('data:')) return v.split(',')[1]
  return v
}

const opEq: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return interpret(a[0] as TemplateNode, context) === interpret(a[1] as TemplateNode, context)
}

const opNe: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return interpret(a[0] as TemplateNode, context) !== interpret(a[1] as TemplateNode, context)
}

const opGt: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return toNumber(interpret(a[0] as TemplateNode, context)) > toNumber(interpret(a[1] as TemplateNode, context))
}

const opGte: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return toNumber(interpret(a[0] as TemplateNode, context)) >= toNumber(interpret(a[1] as TemplateNode, context))
}

const opLt: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return toNumber(interpret(a[0] as TemplateNode, context)) < toNumber(interpret(a[1] as TemplateNode, context))
}

const opLte: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  return toNumber(interpret(a[0] as TemplateNode, context)) <= toNumber(interpret(a[1] as TemplateNode, context))
}

const opIn: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  const v = interpret(a[0] as TemplateNode, context)
  const list = asArgs(a[1])
  return list.map((x) => interpret(x as TemplateNode, context)).includes(v)
}

const opAnd: OpHandler = (arg, context) =>
  asArgs(arg)
    .map((x) => interpret(x as TemplateNode, context))
    .every(truthy)

const opOr: OpHandler = (arg, context) =>
  asArgs(arg)
    .map((x) => interpret(x as TemplateNode, context))
    .some(truthy)

const opNot: OpHandler = (arg, context) => !truthy(interpret(arg as TemplateNode, context))

const opAdd: OpHandler = (arg, context) =>
  asArgs(arg)
    .map((x) => toNumber(interpret(x as TemplateNode, context)))
    .reduce((s, x) => s + x, 0)

const opMultiply: OpHandler = (arg, context) =>
  asArgs(arg)
    .map((x) => toNumber(interpret(x as TemplateNode, context)))
    .reduce((s, x) => s * x, 0)

const opMin: OpHandler = (arg, context) =>
  Math.min(...asArgs(arg).map((x) => toNumber(interpret(x as TemplateNode, context))))

const opDivide: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  const d = toNumber(interpret(a[1] as TemplateNode, context))
  return d !== 0 ? toNumber(interpret(a[0] as TemplateNode, context)) / d : null
}

const opCeilStep: OpHandler = (arg, context) => {
  const a = asArgs(arg)
  const s = toNumber(interpret(a[1] as TemplateNode, context))
  return s !== 0 ? Math.ceil(toNumber(interpret(a[0] as TemplateNode, context)) / s) * s : null
}

const opToFloat: OpHandler = (arg, context) => toNumber(interpret(arg as TemplateNode, context))

const opToInt: OpHandler = (arg, context) => Math.floor(toNumber(interpret(arg as TemplateNode, context)))

const opToString: OpHandler = (arg, context) => String(interpret(arg as TemplateNode, context))

const opTrim: OpHandler = (arg, context) => String(interpret(arg as TemplateNode, context)).trim()

const opLower: OpHandler = (arg, context) => String(interpret(arg as TemplateNode, context)).toLowerCase()

const opUpper: OpHandler = (arg, context) => String(interpret(arg as TemplateNode, context)).toUpperCase()

/** Operator dispatch table: `$name` → its implementation. Unknown operators pass the argument through. */
const OP_HANDLERS: Record<string, OpHandler> = {
  ref: opRef,
  omitEmpty: opOmitEmpty,
  coalesce: opCoalesce,
  merge: opMerge,
  map: opMap,
  filter: opFilter,
  if: opIf,
  switch: opSwitch,
  sortByOrder: opSortByOrder,
  first: opFirst,
  len: opLen,
  at: opAt,
  indexObject: opIndexObject,
  split: opSplit,
  concat: opConcat,
  concatArrays: opConcatArrays,
  dataMime: opDataMime,
  dataPayload: opDataPayload,
  eq: opEq,
  ne: opNe,
  gt: opGt,
  gte: opGte,
  lt: opLt,
  lte: opLte,
  in: opIn,
  and: opAnd,
  or: opOr,
  not: opNot,
  add: opAdd,
  multiply: opMultiply,
  min: opMin,
  divide: opDivide,
  ceilStep: opCeilStep,
  toFloat: opToFloat,
  toInt: opToInt,
  toString: opToString,
  trim: opTrim,
  lower: opLower,
  upper: opUpper,
}

function interpretOp(op: string, arg: unknown, context: TemplateContext): unknown {
  const handler = OP_HANDLERS[op]
  return handler ? handler(arg, context) : arg
}
