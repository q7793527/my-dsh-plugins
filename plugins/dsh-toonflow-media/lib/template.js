/** Recursively interpret a manifest template node against a context. */
export function interpret(node, context) {
    if (node == null)
        return node;
    if (Array.isArray(node))
        return node.map((x) => interpret(x, context));
    if (typeof node !== 'object')
        return node;
    const obj = node;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0].startsWith('$')) {
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
    if (path === 'request')
        return context.request;
    if (path === 'response')
        return context.response;
    const [root, ...rest] = path.split('.');
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
        else if (typeof value === 'object') {
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
    if (v === '')
        return false;
    if (v === 0)
        return false;
    if (Array.isArray(v))
        return v.length > 0;
    if (typeof v === 'object')
        return Object.keys(v).length > 0;
    return true;
}
export function toNumber(v) {
    if (typeof v === 'number')
        return v;
    if (typeof v === 'string')
        return Number(v);
    return 0;
}
export function toBool(v) {
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'string')
        return v.toLowerCase() === 'true' || v === '1';
    if (v == null)
        return false;
    return true;
}
/** Most operators accept either a single operand or an array of operands. */
function asArgs(arg) {
    return Array.isArray(arg) ? arg : [arg];
}
const opRef = (arg, context) => extractValue(context, String(arg));
const opOmitEmpty = (arg, context) => {
    const v = interpret(arg, context);
    if (v == null)
        return null;
    if (Array.isArray(v) && v.length === 0)
        return null;
    if (typeof v === 'object' && Object.keys(v).length === 0)
        return null;
    if (typeof v === 'string' && v.trim() === '')
        return null;
    return v;
};
const opCoalesce = (arg, context) => {
    for (const item of asArgs(arg)) {
        const v = interpret(item, context);
        if (v != null)
            return v;
    }
    return null;
};
const opMerge = (arg, context) => {
    const out = {};
    for (const item of asArgs(arg)) {
        const v = interpret(item, context);
        if (v && typeof v === 'object' && !Array.isArray(v))
            Object.assign(out, v);
    }
    return out;
};
const opMap = (arg, context) => {
    const o = arg;
    const from = interpret(o.from, context);
    if (!Array.isArray(from))
        return null;
    const out = [];
    for (const item of from) {
        const ctx = { ...context, item, [String(o.as ?? 'item')]: item };
        out.push(interpret(o.in, ctx));
    }
    return out;
};
const opFilter = (arg, context) => {
    const o = arg;
    const from = interpret(o.from, context);
    if (!Array.isArray(from))
        return null;
    const out = [];
    for (const item of from) {
        const ctx = { ...context, item, [String(o.as ?? 'item')]: item };
        const where = interpret(o.where, ctx);
        if (truthy(where))
            out.push(item);
    }
    return out;
};
const opIf = (arg, context) => {
    const o = arg;
    const cond = interpret(o.condition, context);
    return truthy(cond) ? interpret(o.then, context) : interpret(o.else, context);
};
const opSwitch = (arg, context) => {
    const o = arg;
    for (const c of o.cases ?? []) {
        if (truthy(interpret(c.when, context)))
            return interpret(c.then, context);
    }
    return interpret(o.default, context);
};
const opSortByOrder = (arg, context) => {
    const v = interpret(arg, context);
    if (!Array.isArray(v))
        return v;
    return [...v].sort((a, b) => toNumber(a?.order) - toNumber(b?.order));
};
const opFirst = (arg, context) => {
    const v = interpret(arg, context);
    if (Array.isArray(v))
        return v[0];
    return v;
};
const opLen = (arg, context) => {
    const v = interpret(arg, context);
    if (Array.isArray(v))
        return v.length;
    if (typeof v === 'string')
        return v.length;
    if (v && typeof v === 'object')
        return Object.keys(v).length;
    return null;
};
const opAt = (arg, context) => {
    const arr = asArgs(arg);
    const v = interpret(arr[0], context);
    const idx = toNumber(interpret(arr[1], context));
    if (Array.isArray(v) && idx >= 0 && idx < v.length)
        return v[idx];
    return null;
};
const opIndexObject = (arg, context) => {
    const arr = asArgs(arg);
    const v = interpret(arr[0], context);
    const key = String(interpret(arr[1], context));
    if (v && typeof v === 'object' && !Array.isArray(v))
        return v[key];
    return null;
};
const opSplit = (arg, context) => {
    const arr = asArgs(arg);
    const s = String(interpret(arr[0], context));
    const sep = arr.length > 1 ? String(interpret(arr[1], context)) : ' ';
    return s.split(sep);
};
const opConcat = (arg, context) => asArgs(arg)
    .map((x) => String(interpret(x, context)))
    .join('');
const opConcatArrays = (arg, context) => {
    const out = [];
    for (const x of asArgs(arg)) {
        const v = interpret(x, context);
        if (Array.isArray(v))
            out.push(...v);
    }
    return out;
};
const opDataMime = (arg, context) => {
    const v = interpret(arg, context);
    if (typeof v === 'string' && v.startsWith('data:'))
        return v.split(';')[0].replace(/^data:/, '');
    return null;
};
const opDataPayload = (arg, context) => {
    const v = interpret(arg, context);
    if (typeof v === 'string' && v.startsWith('data:'))
        return v.split(',')[1];
    return v;
};
const opEq = (arg, context) => {
    const a = asArgs(arg);
    return interpret(a[0], context) === interpret(a[1], context);
};
const opNe = (arg, context) => {
    const a = asArgs(arg);
    return interpret(a[0], context) !== interpret(a[1], context);
};
const opGt = (arg, context) => {
    const a = asArgs(arg);
    return toNumber(interpret(a[0], context)) > toNumber(interpret(a[1], context));
};
const opGte = (arg, context) => {
    const a = asArgs(arg);
    return toNumber(interpret(a[0], context)) >= toNumber(interpret(a[1], context));
};
const opLt = (arg, context) => {
    const a = asArgs(arg);
    return toNumber(interpret(a[0], context)) < toNumber(interpret(a[1], context));
};
const opLte = (arg, context) => {
    const a = asArgs(arg);
    return toNumber(interpret(a[0], context)) <= toNumber(interpret(a[1], context));
};
const opIn = (arg, context) => {
    const a = asArgs(arg);
    const v = interpret(a[0], context);
    const list = asArgs(a[1]);
    return list.map((x) => interpret(x, context)).includes(v);
};
const opAnd = (arg, context) => asArgs(arg)
    .map((x) => interpret(x, context))
    .every(truthy);
const opOr = (arg, context) => asArgs(arg)
    .map((x) => interpret(x, context))
    .some(truthy);
const opNot = (arg, context) => !truthy(interpret(arg, context));
const opAdd = (arg, context) => asArgs(arg)
    .map((x) => toNumber(interpret(x, context)))
    .reduce((s, x) => s + x, 0);
const opMultiply = (arg, context) => asArgs(arg)
    .map((x) => toNumber(interpret(x, context)))
    .reduce((s, x) => s * x, 0);
const opMin = (arg, context) => Math.min(...asArgs(arg).map((x) => toNumber(interpret(x, context))));
const opDivide = (arg, context) => {
    const a = asArgs(arg);
    const d = toNumber(interpret(a[1], context));
    return d !== 0 ? toNumber(interpret(a[0], context)) / d : null;
};
const opCeilStep = (arg, context) => {
    const a = asArgs(arg);
    const s = toNumber(interpret(a[1], context));
    return s !== 0 ? Math.ceil(toNumber(interpret(a[0], context)) / s) * s : null;
};
const opToFloat = (arg, context) => toNumber(interpret(arg, context));
const opToInt = (arg, context) => Math.floor(toNumber(interpret(arg, context)));
const opToString = (arg, context) => String(interpret(arg, context));
const opTrim = (arg, context) => String(interpret(arg, context)).trim();
const opLower = (arg, context) => String(interpret(arg, context)).toLowerCase();
const opUpper = (arg, context) => String(interpret(arg, context)).toUpperCase();
/** Operator dispatch table: `$name` → its implementation. Unknown operators pass the argument through. */
const OP_HANDLERS = {
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
};
function interpretOp(op, arg, context) {
    const handler = OP_HANDLERS[op];
    return handler ? handler(arg, context) : arg;
}
//# sourceMappingURL=template.js.map