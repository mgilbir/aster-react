import { describe, it, expect } from 'vitest'
import { validateDataChanges } from './dataChanges.js'
import { mergeBatches } from './batches.js'
import { contentKey } from './spec.js'

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

describe('contentKey (C32)', () => {
  it('is equal for equal content and different otherwise', () => {
    expect(contentKey({ a: [1, { b: 2 }] })).toBe(contentKey({ a: [1, { b: 2 }] }))
    expect(contentKey({ a: 1 })).not.toBe(contentKey({ a: 2 }))
  })
  it('refuses to compare what JSON cannot represent (identity fallback)', () => {
    expect(contentKey({ f: () => 1 })).toBeNull()
    expect(contentKey({ m: new Map([[1, 2]]) })).toBeNull()
    expect(contentKey({ n: NaN })).toBeNull()
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(contentKey(cyc)).toBeNull()
  })
})
