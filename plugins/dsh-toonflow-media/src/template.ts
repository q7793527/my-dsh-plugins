import type { TemplateNode, TemplateContext } from "./types.js";

export type { TemplateNode, TemplateContext } from "./types.js";

/** Recursively interpret a manifest template node against a context. */
export function interpret(node: TemplateNode, context: TemplateContext): unknown {
  if (node == null) return node;
  if (Array.isArray(node)) return node.map((x) => interpret(x as TemplateNode, context));
  if (typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    return interpretOp(keys[0].slice(1), obj[keys[0]], context);
  }
  const result: Record<string, unknown> = {};
  for (const k of keys) {
    result[k] = interpret(obj[k] as TemplateNode, context);
  }
  return result;
}

/** Resolve a dotted path (e.g. "request.model" or "media.role") against context. */
export function extractValue(context: TemplateContext, path: string): unknown {
  if (path === "request") return context.request;
  if (path === "response") return context.response;
  const [root, ...rest] = path.split(".");
  let value = context[root];
  for (const part of rest) {
    if (value == null) return undefined;
    if (Array.isArray(value)) {
      const idx = Number(part);
      if (Number.isInteger(idx) && idx >= 0 && idx < value.length) {
        value = value[idx];
      } else {
        return undefined;
      }
    } else if (typeof value === "object") {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return value;
}

/** A truthy test: non-null, non-false, non-empty-string, non-zero, non-empty container. */
export function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (v === false) return false;
  if (v === "") return false;
  if (v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

export function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
  if (v == null) return false;
  return true;
}

function interpretOp(op: string, arg: unknown, context: TemplateContext): unknown {
  switch (op) {
    case "ref":
      return extractValue(context, String(arg));
    case "omitEmpty": {
      const v = interpret(arg as TemplateNode, context);
      if (v == null) return null;
      if (Array.isArray(v) && v.length === 0) return null;
      if (typeof v === "object" && Object.keys(v as object).length === 0) return null;
      if (typeof v === "string" && v.trim() === "") return null;
      return v;
    }
    case "coalesce": {
      const arr = Array.isArray(arg) ? arg : [arg];
      for (const item of arr) {
        const v = interpret(item as TemplateNode, context);
        if (v != null) return v;
      }
      return null;
    }
    case "merge": {
      const arr = Array.isArray(arg) ? arg : [arg];
      const out: Record<string, unknown> = {};
      for (const item of arr) {
        const v = interpret(item as TemplateNode, context);
        if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, v as Record<string, unknown>);
      }
      return out;
    }
    default:
      return interpretOp2(op, arg, context);
  }
}

function interpretOp2(op: string, arg: unknown, context: TemplateContext): unknown {
  switch (op) {
    case "map": {
      const o = arg as { from?: unknown; as?: string; in?: unknown };
      const from = interpret(o.from as TemplateNode, context);
      if (!Array.isArray(from)) return null;
      const out: unknown[] = [];
      for (const item of from) {
        const ctx: TemplateContext = { ...context, item, [String(o.as ?? "item")]: item };
        out.push(interpret(o.in as TemplateNode, ctx));
      }
      return out;
    }
    case "filter": {
      const o = arg as { from?: unknown; as?: string; where?: unknown };
      const from = interpret(o.from as TemplateNode, context);
      if (!Array.isArray(from)) return null;
      const out: unknown[] = [];
      for (const item of from) {
        const ctx: TemplateContext = { ...context, item, [String(o.as ?? "item")]: item };
        const where = interpret(o.where as TemplateNode, ctx);
        if (truthy(where)) out.push(item);
      }
      return out;
    }
    case "if": {
      const o = arg as { condition?: unknown; then?: unknown; else?: unknown };
      const cond = interpret(o.condition as TemplateNode, context);
      return truthy(cond) ? interpret(o.then as TemplateNode, context) : interpret(o.else as TemplateNode, context);
    }
    case "switch": {
      const o = arg as { cases?: { when?: unknown; then?: unknown }[]; default?: unknown };
      for (const c of o.cases ?? []) {
        if (truthy(interpret(c.when as TemplateNode, context))) return interpret(c.then as TemplateNode, context);
      }
      return interpret(o.default as TemplateNode, context);
    }
    case "sortByOrder": {
      const v = interpret(arg as TemplateNode, context);
      if (!Array.isArray(v)) return v;
      return [...v].sort((a, b) => toNumber((a as Record<string, unknown>)?.order) - toNumber((b as Record<string, unknown>)?.order));
    }
    case "first": {
      const v = interpret(arg as TemplateNode, context);
      if (Array.isArray(v)) return v[0];
      return v;
    }
    case "len": {
      const v = interpret(arg as TemplateNode, context);
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      if (v && typeof v === "object") return Object.keys(v as object).length;
      return null;
    }
    case "at": {
      const arr = Array.isArray(arg) ? arg : [arg];
      const v = interpret(arr[0] as TemplateNode, context);
      const idx = toNumber(interpret(arr[1] as TemplateNode, context));
      if (Array.isArray(v) && idx >= 0 && idx < v.length) return v[idx];
      return null;
    }
    case "indexObject": {
      const arr = Array.isArray(arg) ? arg : [arg];
      const v = interpret(arr[0] as TemplateNode, context);
      const key = String(interpret(arr[1] as TemplateNode, context));
      if (v && typeof v === "object" && !Array.isArray(v)) return (v as Record<string, unknown>)[key];
      return null;
    }
    case "split": {
      const arr = Array.isArray(arg) ? arg : [arg];
      const s = String(interpret(arr[0] as TemplateNode, context));
      const sep = arr.length > 1 ? String(interpret(arr[1] as TemplateNode, context)) : " ";
      return s.split(sep);
    }
    case "concat": {
      const arr = Array.isArray(arg) ? arg : [arg];
      return arr.map((x) => String(interpret(x as TemplateNode, context))).join("");
    }
    case "concatArrays": {
      const arr = Array.isArray(arg) ? arg : [arg];
      const out: unknown[] = [];
      for (const x of arr) {
        const v = interpret(x as TemplateNode, context);
        if (Array.isArray(v)) out.push(...v);
      }
      return out;
    }
    case "dataMime": {
      const v = interpret(arg as TemplateNode, context);
      if (typeof v === "string" && v.startsWith("data:")) return v.split(";")[0].replace(/^data:/, "");
      return null;
    }
    case "dataPayload": {
      const v = interpret(arg as TemplateNode, context);
      if (typeof v === "string" && v.startsWith("data:")) return v.split(",")[1];
      return v;
    }
    case "eq": { const a = Array.isArray(arg) ? arg : [arg]; return interpret(a[0] as TemplateNode, context) === interpret(a[1] as TemplateNode, context); }
    case "ne": { const a = Array.isArray(arg) ? arg : [arg]; return interpret(a[0] as TemplateNode, context) !== interpret(a[1] as TemplateNode, context); }
    case "gt": { const a = Array.isArray(arg) ? arg : [arg]; return toNumber(interpret(a[0] as TemplateNode, context)) > toNumber(interpret(a[1] as TemplateNode, context)); }
    case "gte": { const a = Array.isArray(arg) ? arg : [arg]; return toNumber(interpret(a[0] as TemplateNode, context)) >= toNumber(interpret(a[1] as TemplateNode, context)); }
    case "lt": { const a = Array.isArray(arg) ? arg : [arg]; return toNumber(interpret(a[0] as TemplateNode, context)) < toNumber(interpret(a[1] as TemplateNode, context)); }
    case "lte": { const a = Array.isArray(arg) ? arg : [arg]; return toNumber(interpret(a[0] as TemplateNode, context)) <= toNumber(interpret(a[1] as TemplateNode, context)); }
    case "in": { const a = Array.isArray(arg) ? arg : [arg]; const v = interpret(a[0] as TemplateNode, context); const list = Array.isArray(a[1]) ? a[1] : [a[1]]; return list.map((x) => interpret(x as TemplateNode, context)).includes(v); }
    case "and": { const a = Array.isArray(arg) ? arg : [arg]; return a.map((x) => interpret(x as TemplateNode, context)).every(truthy); }
    case "or": { const a = Array.isArray(arg) ? arg : [arg]; return a.map((x) => interpret(x as TemplateNode, context)).some(truthy); }
    case "not": return !truthy(interpret(arg as TemplateNode, context));
    case "add": { const a = Array.isArray(arg) ? arg : [arg]; return a.map((x) => toNumber(interpret(x as TemplateNode, context))).reduce((s, x) => s + x, 0); }
    case "multiply": { const a = Array.isArray(arg) ? arg : [arg]; return a.map((x) => toNumber(interpret(x as TemplateNode, context))).reduce((s, x) => s * x, 0); }
    case "min": { const a = Array.isArray(arg) ? arg : [arg]; return Math.min(...a.map((x) => toNumber(interpret(x as TemplateNode, context)))); }
    case "divide": { const a = Array.isArray(arg) ? arg : [arg]; const d = toNumber(interpret(a[1] as TemplateNode, context)); return d !== 0 ? toNumber(interpret(a[0] as TemplateNode, context)) / d : null; }
    case "ceilStep": { const a = Array.isArray(arg) ? arg : [arg]; const s = toNumber(interpret(a[1] as TemplateNode, context)); return s !== 0 ? Math.ceil(toNumber(interpret(a[0] as TemplateNode, context)) / s) * s : null; }
    case "toFloat": return toNumber(interpret(arg as TemplateNode, context));
    case "toInt": return Math.floor(toNumber(interpret(arg as TemplateNode, context)));
    case "toString": return String(interpret(arg as TemplateNode, context));
    case "trim": return String(interpret(arg as TemplateNode, context)).trim();
    case "lower": return String(interpret(arg as TemplateNode, context)).toLowerCase();
    case "upper": return String(interpret(arg as TemplateNode, context)).toUpperCase();
    default:
      return arg;
  }
}
