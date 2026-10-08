/** Recursively interpret a manifest template node against a context. */
export function interpret(node, context) {
    if (node == null)
        return node;
    if (Array.isArray(node))
        return node.map((x) => interpret(x, context));
    if (typeof node !== "object")
        return node;
    const obj = node;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0].startsWith("$")) {
        return interpretOp(keys[0].slice(1), obj[keys[0]], context);
    }
    const result = {};
    for (const k of keys) {
        result[k] = interpret(obj[k], context);
    }
    return result;
}
/** Resolve a dotted path (e.g. "request.model" or "media.role") against context. */
export function extractValue(context, path) {
    if (path === "request")
        return context.request;
    if (path === "response")
        return context.response;
    const [root, ...rest] = path.split(".");
    let value = context[root];
    for (const part of rest) {
        if (value == null)
            return undefined;
        if (Array.isArray(value)) {
            const idx = Number(part);
            if (Number.isInteger(idx) && idx >= 0 && idx < value.length) {
                value = value[idx];
            }
            else {
                return undefined;
            }
        }
        else if (typeof value === "object") {
            value = value[part];
        }
        else {
            return undefined;
        }
    }
    return value;
}
/** A truthy test: non-null, non-false, non-empty-string, non-zero, non-empty container. */
export function truthy(v) {
    if (v == null)
        return false;
    if (v === false)
        return false;
    if (v === "")
        return false;
    if (v === 0)
        return false;
    if (Array.isArray(v))
        return v.length > 0;
    if (typeof v === "object")
        return Object.keys(v).length > 0;
    return true;
}
export function toNumber(v) {
    if (typeof v === "number")
        return v;
    if (typeof v === "string")
        return Number(v);
    return 0;
}
export function toBool(v) {
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string")
        return v.toLowerCase() === "true" || v === "1";
    if (v == null)
        return false;
    return true;
}
function interpretOp(op, arg, context) {
    switch (op) {
        case "ref":
            return extractValue(context, String(arg));
        case "omitEmpty": {
            const v = interpret(arg, context);
            if (v == null)
                return null;
            if (Array.isArray(v) && v.length === 0)
                return null;
            if (typeof v === "object" && Object.keys(v).length === 0)
                return null;
            if (typeof v === "string" && v.trim() === "")
                return null;
            return v;
        }
        case "coalesce": {
            const arr = Array.isArray(arg) ? arg : [arg];
            for (const item of arr) {
                const v = interpret(item, context);
                if (v != null)
                    return v;
            }
            return null;
        }
        case "merge": {
            const arr = Array.isArray(arg) ? arg : [arg];
            const out = {};
            for (const item of arr) {
                const v = interpret(item, context);
                if (v && typeof v === "object" && !Array.isArray(v))
                    Object.assign(out, v);
            }
            return out;
        }
        default:
            return interpretOp2(op, arg, context);
    }
}
function interpretOp2(op, arg, context) {
    switch (op) {
        case "map": {
            const o = arg;
            const from = interpret(o.from, context);
            if (!Array.isArray(from))
                return null;
            const out = [];
            for (const item of from) {
                const ctx = { ...context, item, [String(o.as ?? "item")]: item };
                out.push(interpret(o.in, ctx));
            }
            return out;
        }
        case "filter": {
            const o = arg;
            const from = interpret(o.from, context);
            if (!Array.isArray(from))
                return null;
            const out = [];
            for (const item of from) {
                const ctx = { ...context, item, [String(o.as ?? "item")]: item };
                const where = interpret(o.where, ctx);
                if (truthy(where))
                    out.push(item);
            }
            return out;
        }
        case "if": {
            const o = arg;
            const cond = interpret(o.condition, context);
            return truthy(cond) ? interpret(o.then, context) : interpret(o.else, context);
        }
        case "switch": {
            const o = arg;
            for (const c of o.cases ?? []) {
                if (truthy(interpret(c.when, context)))
                    return interpret(c.then, context);
            }
            return interpret(o.default, context);
        }
        case "sortByOrder": {
            const v = interpret(arg, context);
            if (!Array.isArray(v))
                return v;
            return [...v].sort((a, b) => toNumber(a?.order) - toNumber(b?.order));
        }
        case "first": {
            const v = interpret(arg, context);
            if (Array.isArray(v))
                return v[0];
            return v;
        }
        case "len": {
            const v = interpret(arg, context);
            if (Array.isArray(v))
                return v.length;
            if (typeof v === "string")
                return v.length;
            if (v && typeof v === "object")
                return Object.keys(v).length;
            return null;
        }
        case "at": {
            const arr = Array.isArray(arg) ? arg : [arg];
            const v = interpret(arr[0], context);
            const idx = toNumber(interpret(arr[1], context));
            if (Array.isArray(v) && idx >= 0 && idx < v.length)
                return v[idx];
            return null;
        }
        case "indexObject": {
            const arr = Array.isArray(arg) ? arg : [arg];
            const v = interpret(arr[0], context);
            const key = String(interpret(arr[1], context));
            if (v && typeof v === "object" && !Array.isArray(v))
                return v[key];
            return null;
        }
        case "split": {
            const arr = Array.isArray(arg) ? arg : [arg];
            const s = String(interpret(arr[0], context));
            const sep = arr.length > 1 ? String(interpret(arr[1], context)) : " ";
            return s.split(sep);
        }
        case "concat": {
            const arr = Array.isArray(arg) ? arg : [arg];
            return arr.map((x) => String(interpret(x, context))).join("");
        }
        case "concatArrays": {
            const arr = Array.isArray(arg) ? arg : [arg];
            const out = [];
            for (const x of arr) {
                const v = interpret(x, context);
                if (Array.isArray(v))
                    out.push(...v);
            }
            return out;
        }
        case "dataMime": {
            const v = interpret(arg, context);
            if (typeof v === "string" && v.startsWith("data:"))
                return v.split(";")[0].replace(/^data:/, "");
            return null;
        }
        case "dataPayload": {
            const v = interpret(arg, context);
            if (typeof v === "string" && v.startsWith("data:"))
                return v.split(",")[1];
            return v;
        }
        case "eq": {
            const a = Array.isArray(arg) ? arg : [arg];
            return interpret(a[0], context) === interpret(a[1], context);
        }
        case "ne": {
            const a = Array.isArray(arg) ? arg : [arg];
            return interpret(a[0], context) !== interpret(a[1], context);
        }
        case "gt": {
            const a = Array.isArray(arg) ? arg : [arg];
            return toNumber(interpret(a[0], context)) > toNumber(interpret(a[1], context));
        }
        case "gte": {
            const a = Array.isArray(arg) ? arg : [arg];
            return toNumber(interpret(a[0], context)) >= toNumber(interpret(a[1], context));
        }
        case "lt": {
            const a = Array.isArray(arg) ? arg : [arg];
            return toNumber(interpret(a[0], context)) < toNumber(interpret(a[1], context));
        }
        case "lte": {
            const a = Array.isArray(arg) ? arg : [arg];
            return toNumber(interpret(a[0], context)) <= toNumber(interpret(a[1], context));
        }
        case "in": {
            const a = Array.isArray(arg) ? arg : [arg];
            const v = interpret(a[0], context);
            const list = Array.isArray(a[1]) ? a[1] : [a[1]];
            return list.map((x) => interpret(x, context)).includes(v);
        }
        case "and": {
            const a = Array.isArray(arg) ? arg : [arg];
            return a.map((x) => interpret(x, context)).every(truthy);
        }
        case "or": {
            const a = Array.isArray(arg) ? arg : [arg];
            return a.map((x) => interpret(x, context)).some(truthy);
        }
        case "not": return !truthy(interpret(arg, context));
        case "add": {
            const a = Array.isArray(arg) ? arg : [arg];
            return a.map((x) => toNumber(interpret(x, context))).reduce((s, x) => s + x, 0);
        }
        case "multiply": {
            const a = Array.isArray(arg) ? arg : [arg];
            return a.map((x) => toNumber(interpret(x, context))).reduce((s, x) => s * x, 0);
        }
        case "min": {
            const a = Array.isArray(arg) ? arg : [arg];
            return Math.min(...a.map((x) => toNumber(interpret(x, context))));
        }
        case "divide": {
            const a = Array.isArray(arg) ? arg : [arg];
            const d = toNumber(interpret(a[1], context));
            return d !== 0 ? toNumber(interpret(a[0], context)) / d : null;
        }
        case "ceilStep": {
            const a = Array.isArray(arg) ? arg : [arg];
            const s = toNumber(interpret(a[1], context));
            return s !== 0 ? Math.ceil(toNumber(interpret(a[0], context)) / s) * s : null;
        }
        case "toFloat": return toNumber(interpret(arg, context));
        case "toInt": return Math.floor(toNumber(interpret(arg, context)));
        case "toString": return String(interpret(arg, context));
        case "trim": return String(interpret(arg, context)).trim();
        case "lower": return String(interpret(arg, context)).toLowerCase();
        case "upper": return String(interpret(arg, context)).toUpperCase();
        default:
            return arg;
    }
}
//# sourceMappingURL=template.js.map