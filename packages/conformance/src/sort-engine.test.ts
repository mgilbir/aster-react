/**
 * The order Aster sorts a domain / a collection into must not depend on how long the process has been running.
 *
 * Vega sorts with `Array.prototype.sort`. A comparator over data (`ascending` over a column that mixes strings and
 * numbers: `ascending('a', 1)` is 0 both ways) is not a strict weak order, so the sorted order is whatever
 * sequence of comparisons the engine makes. V8 15.x (Node 27) compiles a hot `x.sort(cmp)` call site with Maglev
 * into an inlined sort that makes different comparisons from the builtin: the very same call returned
 * `d,c,b,1,a` cold and `c,b,1,d,a` hot, and the differential against Vega failed on that engine only (CI,
 * `unit (node node)`, v27.0.0-alpha). Aster's data sorts go through `sortData`, which stays on the builtin.
 *
 * The engine flag that turns the inlining off is set for every vitest worker (scripts/vitest-engine.setup.mjs) so the
 * oracle is stable; these tests turn it back ON, which is the engine behaviour that changed, and prove Aster does
 * not move. On an engine without that flag there is nothing to turn on, and the sorts are stable by construction.
 */
import v8 from 'node:v8'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { getChartInfo } from '../../core/src/runtime.js'
import { sortData } from '../../core/src/util.js'

const FLAG = process.env.ASTER_V8_SORT_FLAG ?? ''
const ENABLE_INLINING = FLAG.replace('--', '--no-')

beforeAll(() => {
  if (FLAG) v8.setFlagsFromString(ENABLE_INLINING)
})
afterAll(() => {
  if (FLAG) v8.setFlagsFromString(FLAG)
})

/** A tiny deterministic generator, so the warm-up is the same on every run. */
function rng(seed: number): () => number {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

/** d3-array `ascending`: 0 for a mixed pair such as 'a' and 1, which is what makes the order engine-defined. */
function ascending(u: unknown, v: unknown): number {
  return u == null || v == null ? NaN : (u as number) < (v as number) ? -1 : (u as number) > (v as number) ? 1 : (u as number) >= (v as number) ? 0 : NaN
}

const POOL: unknown[] = ['a', 'b', 'c', 'd', 'e', 'f', 1, 2, 3, null]

describe('sortData: the same input sorts the same way cold and after the call site is hot', () => {
  const sortKeys = (keys: unknown[], sign: number): unknown[] =>
    sortData(keys.map((key, i) => ({ key, i })), (a, b) => ascending(a.key, b.key) * sign || a.i - b.i).map((e) => e.key)
  const probe = ['b', 'c', 1, 'd', 1, 'a']

  it('keeps one answer over a long warm-up of varied inputs', () => {
    const cold = JSON.stringify(sortKeys(probe, -1))
    const next = rng(1)
    for (let i = 0; i < 60000; i++) {
      const n = 1 + Math.floor(next() * 8)
      sortKeys(Array.from({ length: n }, () => POOL[Math.floor(next() * POOL.length)]), next() < 0.5 ? 1 : -1)
      if (i % 500 === 0) expect(JSON.stringify(sortKeys(probe, -1)), `after ${i} calls`).toBe(cold)
    }
    expect(JSON.stringify(sortKeys(probe, -1))).toBe(cold)
  })
})

describe('a band / ordinal domain sorted on a column of mixed types', () => {
  const spec = (values: unknown[], order: string) => ({
    width: 300, height: 200,
    data: [{ name: 'd', values: values.map((c, n) => ({ c, n })) }],
    scales: [{ name: 's', type: 'band', domain: { data: 'd', field: 'c', sort: { order } }, range: [0, 189] }],
  })
  const asterDomain = (s: unknown): unknown[] => (getChartInfo(structuredClone(s) as never).scales.get('s') as unknown as { domain(): unknown[] }).domain()
  const vegaDomain = async (s: unknown): Promise<unknown[]> => {
    const view = new vega.View(vega.parse(structuredClone(s) as vega.Spec), { renderer: 'none', logLevel: vega.None })
    await view.runAsync()
    return (view.scale('s') as unknown as { domain(): unknown[] }).domain()
  }
  const probe = spec(['b', 'c', 1, 'd', 1, 'a'], 'descending')

  it('is what Vega gives, cold, and stays that after thousands of other charts have run', async () => {
    const want = await vegaDomain(probe) // Vega's own call site is cold here too
    expect(asterDomain(probe)).toEqual(want)
    const next = rng(2)
    for (let i = 0; i < 6000; i++) {
      const n = 1 + Math.floor(next() * 8)
      const values = Array.from({ length: n }, () => POOL[Math.floor(next() * POOL.length)])
      asterDomain(spec(values, next() < 0.5 ? 'ascending' : 'descending'))
      if (i % 250 === 0) expect(asterDomain(probe), `after ${i} charts`).toEqual(want)
    }
    expect(asterDomain(probe)).toEqual(want)
  })
})
