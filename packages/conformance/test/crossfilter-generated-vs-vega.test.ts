// @vitest-environment node
/**
 * crossfilter / resolvefilter over GENERATED data and filter ranges, against the real vega-crossfilter in the same process.
 *
 * crossfilter-vs-vega.test.ts pins the transforms on one small table; this one varies what the result depends on: the size of the
 * table, ties, how clean each column is (all numbers -- where no sort is needed to place a tuple against a range -- or holding
 * nulls, NaN, strings, booleans, where the sorted order has to decide), the ends of each range (inside the data, on a value, past
 * it, reversed, not a number) and the dimensions each resolvefilter ignores. The datasets (every tuple carries its `_index`) are
 * compared whole.
 */
import { describe, it, expect } from 'vitest'
import '@aster/core/transforms'
import { evaluateChart, compileChart, datasetsOfScene } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'

/** mulberry32: a fixed stream, so a failure names a case that can be run again. */
function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Kind = 'ints' | 'floats' | 'dirty-numbers' | 'nan-heavy' | 'strings' | 'mixed'
const KINDS: Kind[] = ['ints', 'ints', 'floats', 'floats', 'dirty-numbers', 'nan-heavy', 'nan-heavy', 'strings', 'mixed']

function column(rand: () => number, kind: Kind, n: number): unknown[] {
  const span = 3 + Math.floor(rand() * 40)
  const pick = (): unknown => {
    switch (kind) {
      case 'ints': return Math.floor(rand() * span) - Math.floor(span / 3)
      case 'floats': return Math.round((rand() * span - span / 3) * 8) / 8
      case 'nan-heavy': return rand() < 0.35 ? NaN : Math.floor(rand() * span)
      case 'strings': return String.fromCharCode(97 + Math.floor(rand() * 8))
      case 'dirty-numbers': {
        const r = rand()
        return r < 0.08 ? null : r < 0.12 ? undefined : r < 0.16 ? NaN : Math.floor(rand() * span)
      }
      case 'mixed': {
        const r = rand()
        return r < 0.25 ? String(Math.floor(rand() * span)) : r < 0.3 ? true : r < 0.4 ? null : Math.floor(rand() * span)
      }
    }
  }
  return Array.from({ length: n }, pick)
}

/** An end of a range: a value of the column, between two, past them, or something that is not a number. */
function end(rand: () => number, col: unknown[]): number {
  const nums = col.filter((v): v is number => typeof v === 'number' && v === v)
  const r = rand()
  if (nums.length === 0 || r < 0.1) return Math.floor(rand() * 20) - 5
  const at = nums[Math.floor(rand() * nums.length)]!
  if (r < 0.5) return at
  if (r < 0.75) return at + 0.5
  if (r < 0.85) return at - 1000
  return at + 1000
}

interface Case { name: string; /** every column is plain numbers (no sort is needed to place a tuple against a range) */ clean: boolean; spec: Record<string, unknown> }

function generate(seed: number): Case {
  const rand = stream(seed)
  const n = [0, 1, 2, 7, 40, 150][Math.floor(rand() * 6)]! + Math.floor(rand() * 5)
  const dims = 1 + Math.floor(rand() * 3)
  const kinds = Array.from({ length: dims }, () => KINDS[Math.floor(rand() * KINDS.length)]!)
  const cols = kinds.map((k) => column(rand, k, n))
  const fields = ['a', 'b', 'c'].slice(0, dims)
  const values = Array.from({ length: n }, (_, i) => {
    const row: Record<string, unknown> = { id: i }
    fields.forEach((f, d) => { row[f] = cols[d]![i] })
    return row
  })
  const signals = fields.map((f, d) => {
    let lo = end(rand, cols[d]!)
    let hi = end(rand, cols[d]!)
    if (rand() < 0.85 && lo > hi) [lo, hi] = [hi, lo] // (mostly the right way round; sometimes not)
    // an end that is not a number: null, NaN (an expression: JSON has none) or a numeric string
    const odd = (v: number): number | null | string => { const r = rand(); return r < 0.08 ? null : r < 0.2 ? 'NaN' : r < 0.25 ? String(v) : v }
    const ends = [odd(lo), odd(hi)]
    const nan = ends.map((e) => (e === 'NaN' ? 'NaN' : JSON.stringify(e)))
    return ends.includes('NaN') ? { name: `q${f}`, update: `[${nan.join(', ')}]` } : { name: `q${f}`, value: ends }
  })
  const mask = (1 << dims) - 1
  const ignores = [0, Math.floor(rand() * (mask + 1)), Math.floor(rand() * (mask + 1)), mask]
  return {
    clean: kinds.every((k) => k === 'ints' || k === 'floats'),
    name: `seed ${seed}: ${n} rows, ${kinds.join('/')}, ranges ${signals.map((s) => JSON.stringify('value' in s ? s.value : s.update)).join(' ')}, ignoring ${ignores.join(',')}`,
    spec: {
      width: 50, height: 50,
      signals,
      data: [
        { name: 'rows', values, transform: [{ type: 'crossfilter', signal: 'xf', fields, query: signals.map((s) => ({ signal: s.name })) }] },
        // (vega applies the filter lazily: `collect` materializes the tuples a dataset ends with)
        ...ignores.map((ignore, i) => ({ name: `r${i}`, source: 'rows', transform: [{ type: 'resolvefilter', ignore, filter: { signal: 'xf' } }, { type: 'collect' }] })),
      ],
    },
  }
}

/** (a signal carries NaN as `undefined` into a transform; a literal `query` array carries it as it is) */
function literalEnds(seed: number): Case {
  const rand = stream(seed)
  const n = 5 + Math.floor(rand() * 30)
  const values = Array.from({ length: n }, (_, i) => ({ id: i, a: rand() < 0.3 ? NaN : Math.floor(rand() * 10), b: Math.floor(rand() * 10) }))
  const ends = [[NaN, 4], [3, NaN], [NaN, NaN], [2, 6], [6, 2]]
  const query = [ends[Math.floor(rand() * ends.length)]!, ends[Math.floor(rand() * ends.length)]!]
  return {
    clean: false,
    name: `literal ends ${seed}: ${n} rows, query ${query.map((q) => `[${q}]`).join(' ')}`,
    spec: {
      width: 50, height: 50,
      data: [
        { name: 'rows', values, transform: [{ type: 'crossfilter', signal: 'xf', fields: ['a', 'b'], query }] },
        ...[0, 1, 2, 3].map((ignore, i) => ({ name: `r${i}`, source: 'rows', transform: [{ type: 'resolvefilter', ignore, filter: { signal: 'xf' } }, { type: 'collect' }] })),
      ],
    },
  }
}

const SEEDS = Array.from({ length: 300 }, (_, i) => 1000 + i)

/** What the cases between them exercised, so a generator that stopped producing filtering ranges could not pass unnoticed. */
const seen = { partial: 0, none: 0, everything: 0, cleanNumeric: 0, unsorted: 0 }

describe('crossfilter and resolvefilter over generated tables and ranges', () => {
  for (const c of [...SEEDS.map(generate), ...SEEDS.slice(0, 40).map((s) => literalEnds(s))]) {
    it(c.name, async () => {
      const vega = await renderWithVegaChecked(structuredClone(c.spec))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const scene = evaluateChart(compileChart(structuredClone(c.spec)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never)
      expect(errors).toEqual([])
      const got: Record<string, unknown> = {}
      for (const d of c.spec.data as Array<{ name: string }>) got[d.name] = JSON.parse(JSON.stringify(datasetsOfScene(scene).get(d.name) ?? null))
      expect(got).toEqual(vega.datasets)
      const rows = (c.spec.data as Array<{ values?: unknown[] }>)[0]!.values!.length
      const kept = (vega.datasets.r0 as unknown[]).length
      if (rows > 1 && kept === 0) seen.none++
      else if (rows > 1 && kept === rows) seen.everything++
      else if (kept > 0 && kept < rows) seen.partial++
      if (c.clean) seen.cleanNumeric++
      else seen.unsorted++
    }, 30_000)
  }

  it('the generator reaches filtering, passing, empty, clean-numeric and unclean cases', () => {
    expect(seen.partial).toBeGreaterThan(30)
    expect(seen.none).toBeGreaterThan(5)
    expect(seen.everything).toBeGreaterThan(0)
    expect(seen.cleanNumeric).toBeGreaterThan(30)
    expect(seen.unsorted).toBeGreaterThan(30)
  })
})
