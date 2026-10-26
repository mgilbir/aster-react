import { describe, it, expect } from 'vitest'
import { validateDataChanges } from './dataChanges.js'
import { mergeBatches } from './batches.js'
import { contentEqual } from './spec.js'

const rows = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ i }))

describe('validateDataChanges (C66)', () => {
  it('passes a correct changeset', () => {
    expect(validateDataChanges({ t: [0, 2] }, { t: rows(3) }, new Map([['t', 3]]))).toEqual({ changes: { t: [0, 2] }, problems: [] })
  })
  it('rejects out-of-range, fractional, negative, unknown dataset, length change, non-array', () => {
    const data = { t: rows(3) }
    const prev = new Map([['t', 3]])
    for (const bad of [{ t: [3] }, { t: [-1] }, { t: [0.5] }, { nope: [0] }, { t: 'x' as never }]) {
      const v = validateDataChanges(bad as never, data, prev)
      expect(v.changes).toBeUndefined()
      expect(v.problems.length).toBe(1)
    }
    const grown = validateDataChanges({ t: [0] }, { t: rows(4) }, prev)
    expect(grown.changes).toBeUndefined()
    expect(grown.problems[0]).toMatch(/row count changed/)
  })
  it('one bad dataset drops the whole changeset', () => {
    const v = validateDataChanges({ a: [0], b: [9] }, { a: rows(2), b: rows(2) }, new Map())
    expect(v.changes).toBeUndefined()
    expect(v.problems).toHaveLength(1)
  })
})

describe('mergeBatches (C69)', () => {
  it('concatenates appends, lets a later snapshot supersede earlier appends, keeps later scalars', () => {
    const merged = mergeBatches(
      { append: { t: [1], u: [1] }, signals: { a: 1 }, width: 10 },
      { append: { t: [2] }, data: { u: [9] }, signals: { b: 2 }, height: 5 },
    )
    expect(merged.append).toEqual({ t: [1, 2] })
    expect(merged.data).toEqual({ u: [9] })
    expect(merged.signals).toEqual({ a: 1, b: 2 })
    expect([merged.width, merged.height]).toEqual([10, 5])
  })
  it('drops explicit pulses (falls back to a snapshot diff)', () => {
    const merged = mergeBatches({ append: { t: [1] }, pulse: { t: { appendOnly: true } } }, { append: { t: [2] } })
    expect(merged.pulse).toBeUndefined()
  })
  it('an undefined scalar in the later batch does not erase the earlier one', () => {
    expect(mergeBatches({ width: 7 }, { width: undefined }).width).toBe(7)
  })
})

describe('contentEqual (C32)', () => {
  it('is equal for equal content and different otherwise', () => {
    expect(contentEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(contentEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(contentEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(contentEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false)
    expect(contentEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(contentEqual([], {})).toBe(false)
    expect(contentEqual(NaN, NaN)).toBe(true)
    expect(contentEqual(null, undefined)).toBe(false)
  })
  it('compares what JSON cannot represent by identity', () => {
    const f = () => 1
    expect(contentEqual({ f }, { f })).toBe(true)
    expect(contentEqual({ f }, { f: () => 1 })).toBe(false)
    const m = new Map([[1, 2]])
    expect(contentEqual({ m }, { m })).toBe(true)
    expect(contentEqual({ m }, { m: new Map([[1, 2]]) })).toBe(false)
    expect(contentEqual(new Date(1), new Date(1))).toBe(false)
  })
  it('a cycle or absurd depth compares unequal instead of overflowing', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    const b: Record<string, unknown> = {}
    b.self = b
    expect(contentEqual(a, b)).toBe(false)
    expect(contentEqual(a, a)).toBe(true)
  })
  it('a big spec costs one pass over its skeleton: data rows are by identity, other big arrays by content', () => {
    // Counted, not timed: a wall bound measures the machine. `reads` counts property reads on the rows.
    let reads = 0
    const rows = () => Array.from({ length: 100_000 }, (_, i) => ({ get x() { reads++; return i } }))
    const shared = rows()
    expect(contentEqual({ data: [{ name: 't', values: shared }] }, { data: [{ name: 't', values: shared }] }, 0, false, true)).toBe(true)
    // a re-created equal rows array is a new input (the session's row diff finds it unchanged), without 100k row compares here
    expect(contentEqual({ data: [{ name: 't', values: rows() }] }, { data: [{ name: 't', values: rows() }] }, 0, false, true)).toBe(false)
    expect(contentEqual({ data: [{ name: 't', values: shared }] }, { data: [{ name: 't', values: shared.slice() }] })).toBe(true) // (content mode, for streams)
    expect(reads).toBe(0)
    // other big arrays are compared by content, in one pass: element reads grow linearly (a quadratic compare reads ~n^2)
    const n = 100_000
    let gets = 0
    const counted = (): number[] => new Proxy(Array.from({ length: n }, (_, i) => i), { get(t, k, r) { gets++; return Reflect.get(t, k, r) } })
    expect(contentEqual({ scales: [{ name: 's', domain: counted() }] }, { scales: [{ name: 's', domain: counted() }] })).toBe(true)
    expect(gets).toBeGreaterThanOrEqual(2 * n)
    expect(gets).toBeLessThanOrEqual(6 * n)
  })
})
