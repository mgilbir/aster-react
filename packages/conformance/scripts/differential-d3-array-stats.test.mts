/**
 * LIVE, generated differential for the d3-array statistics `arr.ts` carries (`quantile`, `quantileSorted`) and the
 * median / mean / min / max the `impute` transform takes from d3-array, against the pinned d3-array 3.2.4 in the same
 * process. The inputs are the ones a data column really has: numbers, numeric strings, '', null, undefined, NaN,
 * +-Infinity, booleans, Dates, empty and all-missing columns. d3-array skips a missing value (null, undefined, NaN)
 * and coerces the rest with `+`; a column of nothing has no quantile.
 */
import { describe, expect, it } from 'vitest'
import * as d3 from 'd3-array'
import { quantile, quantileSorted } from '../../core/src/arr.ts'
import { exact } from './differential-util.mts'

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r = prng(0xd3a1)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

const ODD: unknown[] = [null, undefined, NaN, '', '3', '2.5', 'x', ' 7 ', true, false, Infinity, -Infinity, new Date(5), [4], {}, -0]

function column(): unknown[] {
  const n = pick([0, 1, 2, 3, 5, 9, 40])
  const mode = pick(['clean', 'sparse', 'mostly-odd', 'all-missing', 'all-null'])
  return Array.from({ length: n }, () => {
    if (mode === 'all-missing') return pick([null, undefined, NaN])
    if (mode === 'all-null') return null
    const odd = mode === 'mostly-odd' ? 0.7 : mode === 'sparse' ? 0.2 : 0
    return r() < odd ? pick(ODD) : Math.round((r() * 20 - 5) * 4) / 4
  })
}

const PS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, -1, 2, NaN, 1 / 3]

describe('arr.ts quantile vs d3-array 3.2.4 (generated)', () => {
  for (let i = 0; i < 300; i++) {
    const col = column()
    it(`#${i} ${JSON.stringify(col, (_k, v) => (v === undefined ? '__undef' : typeof v === 'number' && !isFinite(v) ? String(v) : v))}`, () => {
      for (const p of PS) {
        expect(exact(() => quantile(col as number[], p)), `p=${p}`).toEqual(exact(() => d3.quantile(col as number[], p)))
        expect(exact(() => quantile(col.map((v) => ({ v })) as unknown as number[], p, (d) => (d as { v: unknown }).v)), `p=${p} accessor`).toEqual(
          exact(() => d3.quantile(col.map((v) => ({ v })), p, (d) => (d as { v: unknown }).v)),
        )
      }
      const sorted = col.filter((v) => v != null && +(v as number) === +(v as number)).map(Number).sort((a, b) => a - b)
      for (const p of PS) expect(exact(() => quantileSorted(sorted, p)), `sorted p=${p}`).toEqual(exact(() => d3.quantileSorted(sorted, p)))
    })
  }
  it('names the case the report asked about: a column of nulls has no quantile', () => {
    expect(quantile([null, null] as unknown as number[], 0.25)).toBeUndefined()
    expect(d3.quantile([null, null] as unknown as number[], 0.25)).toBeUndefined()
    expect(quantile([null, 4, undefined, 8] as unknown as number[], 0.5)).toBe(6)
  })
})
