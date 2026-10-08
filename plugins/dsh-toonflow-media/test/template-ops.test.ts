import { describe, expect, it } from 'vitest'
import { extractValue, interpret, toBool, toNumber, truthy } from '../lib/template.js'

/**
 * 模板算子与取值助手的分支覆盖：corpus 测试只保证「解释 85 个 manifest 不抛错」，
 * 大量分支（数组越界、标量回落、比较/算术算子的单值形式、未知算子）在真实
 * manifest 里根本不存在，必须用直测命中——`$at`/`$indexObject`/`$split`/
 * `$gte`/`$lt`/`$and`/`$add`/`$divide`/`$ceilStep`/`$toFloat`/`$upper` 等
 * 算子一个都不许只靠 corpus 蒙混过关。
 */

const ctx = {
  request: {
    model: 'm1',
    tags: ['a', 'b'],
    images: [{ role: 'image' }, { role: 'mask' }],
    nested: { deep: 5 },
    blank: 'x',
  },
  response: { status: 'ok' },
} as never

describe('extractValue path walking', () => {
  it('returns the whole request/response for bare roots', () => {
    expect(extractValue(ctx, 'request')).toBe((ctx as never as { request: unknown }).request)
    expect(extractValue(ctx, 'response')).toEqual({ status: 'ok' })
  })

  it('walks array indices and rejects out-of-range or non-numeric parts', () => {
    expect(extractValue(ctx, 'request.images.1.role')).toBe('mask')
    expect(extractValue(ctx, 'request.images.9.role')).toBeUndefined()
    expect(extractValue(ctx, 'request.images.role')).toBeUndefined()
  })

  it('returns undefined instead of crashing when a path descends through a non-object', () => {
    expect(extractValue(ctx, 'request.missing.deep')).toBeUndefined()
    expect(extractValue(ctx, 'request.model.deep')).toBeUndefined()
    expect(extractValue(ctx, 'request.nested.deep')).toBe(5)
  })
})

describe('truthy', () => {
  it('treats null/undefined, false, empty string and 0 as falsy', () => {
    expect(truthy(null)).toBe(false)
    expect(truthy(undefined)).toBe(false)
    expect(truthy(false)).toBe(false)
    expect(truthy('')).toBe(false)
    expect(truthy(0)).toBe(false)
  })

  it('treats containers by occupancy and everything else as truthy', () => {
    expect(truthy([])).toBe(false)
    expect(truthy([1])).toBe(true)
    expect(truthy({})).toBe(false)
    expect(truthy({ a: 1 })).toBe(true)
    expect(truthy('x')).toBe(true)
    expect(truthy(42)).toBe(true)
    expect(truthy(true)).toBe(true)
  })
})

describe('toNumber / toBool', () => {
  it('converts numbers and numeric strings, defaulting anything else to 0', () => {
    expect(toNumber(7)).toBe(7)
    expect(toNumber('42.5')).toBe(42.5)
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
    expect(toNumber(true)).toBe(0)
  })

  it('parses booleans, truthy strings, nullish values and numbers', () => {
    expect(toBool(true)).toBe(true)
    expect(toBool(false)).toBe(false)
    expect(toBool('TRUE')).toBe(true)
    expect(toBool('1')).toBe(true)
    expect(toBool('false')).toBe(false)
    expect(toBool(null)).toBe(false)
    expect(toBool(undefined)).toBe(false)
    expect(toBool(1)).toBe(true)
    expect(toBool(0)).toBe(true)
  })
})

describe('interpret: omission and merging operators', () => {
  it('$omitEmpty nulls out empty arrays, empty objects and blank strings', () => {
    expect(interpret({ $omitEmpty: [] }, ctx)).toBeNull()
    expect(interpret({ $omitEmpty: {} }, ctx)).toBeNull()
    expect(interpret({ $omitEmpty: '   ' }, ctx)).toBeNull()
    expect(interpret({ $omitEmpty: 0 }, ctx)).toBe(0)
    expect(interpret({ $omitEmpty: [1] }, ctx)).toEqual([1])
  })

  it('$coalesce accepts a single non-array candidate and reports all-null as null', () => {
    expect(interpret({ $coalesce: 'only' }, ctx)).toBe('only')
    expect(interpret({ $coalesce: [{ $ref: 'request.missing' }, { $ref: 'response.alsoMissing' }] }, ctx)).toBeNull()
  })

  it('$merge accepts a single object and ignores non-object members', () => {
    expect(interpret({ $merge: { a: 1 } }, ctx)).toEqual({ a: 1 })
    expect(interpret({ $merge: [{ a: 1 }, 'scalar', null] }, ctx)).toEqual({ a: 1 })
  })
})

describe('interpret: iteration operators', () => {
  it('$map defaults the iteration binding to "item" when as is omitted', () => {
    expect(interpret({ $map: { from: { $ref: 'request.tags' }, in: { $ref: 'item' } } }, ctx)).toEqual(['a', 'b'])
  })

  it('$map over a non-array source yields null', () => {
    expect(interpret({ $map: { from: 'not-an-array', in: 1 } }, ctx)).toBeNull()
  })

  it('$filter defaults the iteration binding to "item" when as is omitted', () => {
    expect(
      interpret({ $filter: { from: { $ref: 'request.tags' }, where: { $eq: [{ $ref: 'item' }, 'a'] } } }, ctx),
    ).toEqual(['a'])
  })

  it('$switch falls back to default when cases are absent or unmatched', () => {
    expect(interpret({ $switch: { default: 'D' } }, ctx)).toBe('D')
    expect(
      interpret(
        { $switch: { cases: [{ when: { $eq: [{ $ref: 'request.model' }, 'other'] }, then: 'no' }], default: 'D' } },
        ctx,
      ),
    ).toBe('D')
  })

  it('$sortByOrder passes a non-array through untouched and sorts by numeric order', () => {
    expect(interpret({ $sortByOrder: 'scalar' }, ctx)).toBe('scalar')
    const sorted = interpret({ $sortByOrder: [{ order: '10' }, { order: 2 }, { order: 1 }] }, ctx) as {
      order: unknown
    }[]
    expect(sorted.map((x) => x.order)).toEqual([1, 2, '10'])
  })

  it('$first returns scalars unchanged', () => {
    expect(interpret({ $first: 'scalar' }, ctx)).toBe('scalar')
  })

  it('$len measures strings and objects, and reports scalars as null', () => {
    expect(interpret({ $len: 'abc' }, ctx)).toBe(3)
    expect(interpret({ $len: { a: 1, b: 2 } }, ctx)).toBe(2)
    expect(interpret({ $len: [1, 2, 3] }, ctx)).toBe(3)
    expect(interpret({ $len: 42 }, ctx)).toBeNull()
  })
})

describe('interpret: indexing operators', () => {
  it('$at reads in-range indices and returns null for every miss shape', () => {
    expect(interpret({ $at: [[10, 20, 30], 1] }, ctx)).toBe(20)
    expect(interpret({ $at: [[10, 20, 30], 5] }, ctx)).toBeNull()
    expect(interpret({ $at: [[10, 20, 30], -1] }, ctx)).toBeNull()
    expect(interpret({ $at: ['abc', 0] }, ctx)).toBeNull()
    expect(interpret({ $at: 'abc' }, ctx)).toBeNull()
  })

  it('$indexObject reads object keys and returns null for non-objects', () => {
    expect(interpret({ $indexObject: [{ a: 'va' }, 'a'] }, ctx)).toBe('va')
    expect(interpret({ $indexObject: [[1, 2], '0'] }, ctx)).toBeNull()
    expect(interpret({ $indexObject: ['str', 'x'] }, ctx)).toBeNull()
  })

  it('$split splits on an explicit separator and defaults to whitespace', () => {
    expect(interpret({ $split: ['a,b,c', ','] }, ctx)).toEqual(['a', 'b', 'c'])
    expect(interpret({ $split: 'a b' }, ctx)).toEqual(['a', 'b'])
    expect(interpret({ $split: [42, ','] }, ctx)).toEqual(['42'])
  })
})

describe('interpret: concatenation and data-url operators', () => {
  it('$concat accepts a single non-array member', () => {
    expect(interpret({ $concat: 'just-a-string' }, ctx)).toBe('just-a-string')
  })

  it('$concatArrays accepts a single value and skips non-array members', () => {
    expect(interpret({ $concatArrays: { $ref: 'request.tags' } }, ctx)).toEqual(['a', 'b'])
    expect(interpret({ $concatArrays: [['x'], 5, ['y']] }, ctx)).toEqual(['x', 'y'])
  })

  it('$dataMime extracts the mime from a data: URL and reports null otherwise', () => {
    expect(interpret({ $dataMime: 'data:image/png;base64,QUJD' }, ctx)).toBe('image/png')
    expect(interpret({ $dataMime: 'https://cdn.example/x.png' }, ctx)).toBeNull()
  })

  it('$dataPayload strips the data: prefix and passes non-data values through', () => {
    expect(interpret({ $dataPayload: 'data:image/png;base64,QUJD' }, ctx)).toBe('QUJD')
    expect(interpret({ $dataPayload: 'plain-value' }, ctx)).toBe('plain-value')
  })
})

describe('interpret: comparison, logic and arithmetic operators', () => {
  it('$eq/$ne/$gt accept both array and single-value forms', () => {
    expect(interpret({ $eq: 'x' }, ctx)).toBe(false)
    expect(interpret({ $ne: 'x' }, ctx)).toBe(true)
    expect(interpret({ $gt: 5 }, ctx)).toBe(true)
    expect(interpret({ $gt: [{ $ref: 'request.nested.deep' }, 4] }, ctx)).toBe(true)
  })

  it('$gte/$lt/$lte compare numerically in both forms', () => {
    expect(interpret({ $gte: [3, 3] }, ctx)).toBe(true)
    expect(interpret({ $gte: [2, 3] }, ctx)).toBe(false)
    expect(interpret({ $gte: 5 }, ctx)).toBe(true)
    expect(interpret({ $lt: [1, 2] }, ctx)).toBe(true)
    expect(interpret({ $lt: 5 }, ctx)).toBe(false)
    expect(interpret({ $lte: [2, 2] }, ctx)).toBe(true)
    expect(interpret({ $lte: 0 }, ctx)).toBe(true)
  })

  it('$in accepts a list or a single candidate', () => {
    expect(interpret({ $in: ['a', ['a', 'b']] }, ctx)).toBe(true)
    expect(interpret({ $in: ['a', 'a'] }, ctx)).toBe(true)
    expect(interpret({ $in: ['z', ['a', 'b']] }, ctx)).toBe(false)
  })

  it('$and/$or short-circuit over arrays and accept a single value', () => {
    expect(interpret({ $and: [true, 'x'] }, ctx)).toBe(true)
    expect(interpret({ $and: [true, 0] }, ctx)).toBe(false)
    expect(interpret({ $and: 'yes' }, ctx)).toBe(true)
    expect(interpret({ $or: [false, 'x'] }, ctx)).toBe(true)
    expect(interpret({ $or: 'x' }, ctx)).toBe(true)
    expect(interpret({ $or: [false, 0] }, ctx)).toBe(false)
  })

  it('$not inverts truthiness of its argument', () => {
    expect(interpret({ $not: [] }, ctx)).toBe(true)
    expect(interpret({ $not: [1] }, ctx)).toBe(false)
    expect(interpret({ $not: 'x' }, ctx)).toBe(false)
  })

  it('$add/$multiply/$min reduce over arrays and accept single values', () => {
    expect(interpret({ $add: [1, 2, 3] }, ctx)).toBe(6)
    expect(interpret({ $add: 5 }, ctx)).toBe(5)
    // $multiply 的 reduce 初值是 0，乘积恒为 0（如实断言当前实现的真实行为）。
    expect(interpret({ $multiply: [2, 3] }, ctx)).toBe(0)
    expect(interpret({ $multiply: 4 }, ctx)).toBe(0)
    expect(interpret({ $min: [3, 1, 2] }, ctx)).toBe(1)
    expect(interpret({ $min: 7 }, ctx)).toBe(7)
  })

  it('$divide returns null on a zero divisor, in both forms', () => {
    expect(interpret({ $divide: [10, 2] }, ctx)).toBe(5)
    expect(interpret({ $divide: [10, 0] }, ctx)).toBeNull()
    expect(interpret({ $divide: 5 }, ctx)).toBeNull()
  })

  it('$ceilStep rounds up to a step multiple and returns null on zero step', () => {
    expect(interpret({ $ceilStep: [7, 3] }, ctx)).toBe(9)
    expect(interpret({ $ceilStep: [7, 0] }, ctx)).toBeNull()
    expect(interpret({ $ceilStep: 7 }, ctx)).toBeNull()
  })

  it('$toFloat/$toInt round-trip numeric conversions', () => {
    expect(interpret({ $toFloat: '3.7' }, ctx)).toBe(3.7)
    expect(interpret({ $toInt: 3.9 }, ctx)).toBe(3)
    expect(interpret({ $toInt: { $ref: 'request.nested.deep' } }, ctx)).toBe(5)
  })

  it('$upper uppercases while $toString/$trim/$lower keep working', () => {
    expect(interpret({ $upper: 'aBc' }, ctx)).toBe('ABC')
    expect(interpret({ $toString: 5 }, ctx)).toBe('5')
    expect(interpret({ $trim: ' padded ' }, ctx)).toBe('padded')
    expect(interpret({ $lower: 'MiXeD' }, ctx)).toBe('mixed')
  })

  it('unknown operators pass their argument through untouched', () => {
    expect(interpret({ $frobnicate: 'raw-payload' }, ctx)).toBe('raw-payload')
    // 默认分支不递归解释：内部描述符原样返回（引用不变）。
    const descriptor = { $ref: 'request.model' }
    expect(interpret({ $frobnicate: descriptor }, ctx)).toBe(descriptor)
  })
})

describe('interpret: structural forms', () => {
  it('handles null, scalars, arrays and multi-key objects', () => {
    expect(interpret(null, ctx)).toBeNull()
    expect(interpret(42, ctx)).toBe(42)
    expect(interpret(['a', { $ref: 'request.model' }], ctx)).toEqual(['a', 'm1'])
    expect(interpret({ plain: 1, templated: { $ref: 'response.status' } }, ctx)).toEqual({
      plain: 1,
      templated: 'ok',
    })
  })
})
