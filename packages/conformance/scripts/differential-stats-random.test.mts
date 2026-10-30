/**
 * GENERATED live differentials for the numeric core of the statistics modules, against the pinned real vega-statistics /
 * vega-transforms in this process (same engine, strict `Object.is`-level equality, no tolerance):
 *
 *   - `sample` / `density` / `cumulative` / `quantile` of the normal, log-normal and uniform distributions, over random
 *     parameters and extreme values (tails, zero or negative spread, huge and subnormal numbers, NaN, +-Infinity), with the
 *     number AND order of draws from the random source compared as well;
 *   - the `regression` transform for every method (linear, log, exp, pow, quad, poly at orders 1..8, constant fits through
 *     degenerate data) and the `loess` transform, over random data (ties, groups, nulls, strings, non-positive values for
 *     the logarithmic methods, vertical lines), including `params`, `extent`, `as` and `bandwidth`;
 *   - `bootstrapCI` under a seeded source: the interval AND the draws made.
 *
 * Seeds are fixed, so the case list is reproducible; a divergence names the case that found it.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
// (the SOURCE modules, not the built dist: the guard must watch the code being edited)
import { applyTransforms } from '../../core/src/transform.ts'
import type { Row } from '../../core/src/types.ts'
import '../../core/src/addon-transforms.ts'
import { compileExpr } from '../../core/src/expression.ts'
import * as asterFns from '../../core/src/stats-functions.ts'
import { bootstrapCI as asterBootstrapCI } from '../../core/src/transform-agg.ts'
import { enc } from './differential-util.mts'
import { seededRandom } from '../src/gallery/seeded.js'

const V = vega as unknown as Record<string, (...a: unknown[]) => unknown> & { setRandom(r: () => number): void }

function rng(seed: number): () => number { return seededRandom(seed) }

/** A source that counts its draws and records them, so the order and count are part of the comparison. */
function tape(seed: number): { random: () => number; draws: number[] } {
  const src = seededRandom(seed)
  const draws: number[] = []
  return { random: () => { const v = src(); draws.push(v); return v }, draws }
}

// ---------------------------------------------------------------------------------------------------------------------
// value generators
// ---------------------------------------------------------------------------------------------------------------------
const EXTREMES = [
  0, -0, 1, -1, 0.5, 1e-300, -1e-300, 5e-324, 1e300, -1e300, Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON,
  37, -37, 37.0000001, 7.07106781186547, -7.07106781186547, 7.0710678118654755, 6.9999, 8, 38, -38, 1e6, Math.PI, -Math.E,
  NaN, Infinity, -Infinity, null, undefined, '2.5', 'x', true, [],
]
function genNumber(r: () => number): unknown {
  const k = r()
  if (k < 0.25) return EXTREMES[Math.floor(r() * EXTREMES.length)]
  if (k < 0.45) return (r() - 0.5) * 2 * 10 ** Math.floor((r() - 0.4) * 20)
  if (k < 0.7) return (r() - 0.5) * 16 // the bulk and the tails of a standard normal
  if (k < 0.8) return 1 - 10 ** -Math.floor(r() * 17) // probabilities hugging 1
  if (k < 0.9) return 10 ** -Math.floor(r() * 300) // probabilities hugging 0
  return r()
}
/** A probability argument: mostly inside [0, 1], with the edges and a few outside. */
function genProbability(r: () => number): unknown {
  const k = r()
  if (k < 0.15) return [0, 1, 0.5, -0, 1e-300, 1 - Number.EPSILON, Number.EPSILON, 0.5 + 1e-16][Math.floor(r() * 8)]
  if (k < 0.3) return 10 ** -(1 + r() * 300)
  if (k < 0.45) return 1 - 10 ** -(1 + r() * 16)
  if (k < 0.55) return genNumber(r)
  return r()
}
/** A parameter: absent, null, or a number. */
function genParam(r: () => number): unknown {
  const k = r()
  if (k < 0.12) return undefined
  if (k < 0.2) return null
  if (k < 0.35) return EXTREMES[Math.floor(r() * EXTREMES.length)]
  if (k < 0.5) return Math.round((r() - 0.5) * 20)
  return (r() - 0.4) * 10 ** Math.floor(r() * 6 - 2)
}
function genArgs(r: () => number, first: (r: () => number) => unknown): unknown[] {
  const args = [first(r)]
  const n = Math.floor(r() * 3) // 0, 1 or 2 parameters
  for (let i = 0; i < n; i++) args.push(genParam(r))
  return args
}

const same = (a: unknown, b: unknown, what: string): void => expect(enc(a), what).toEqual(enc(b))

// ---------------------------------------------------------------------------------------------------------------------
// distribution functions
// ---------------------------------------------------------------------------------------------------------------------
describe('distribution functions over random parameters and extreme values vs vega-statistics', () => {
  const pure = [
    ['densityNormal', genNumber], ['cumulativeNormal', genNumber], ['quantileNormal', genProbability],
    ['densityLogNormal', genNumber], ['cumulativeLogNormal', genNumber], ['quantileLogNormal', genProbability],
    ['densityUniform', genNumber], ['cumulativeUniform', genNumber], ['quantileUniform', genProbability],
  ] as const
  for (const [name, first] of pure) {
    it(name, () => {
      const r = rng(name.length * 7919 + name.charCodeAt(0))
      const fn = (asterFns as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!
      for (let i = 0; i < 6000; i++) {
        const args = genArgs(r, first)
        same(fn(...args), V[name]!(...args), `${name}(${args.map(String).join(', ')})`)
      }
    })
  }

  it('quantileNormal across all three erfinv regions, finely and at the seams', () => {
    // w = -log((1-x)(1+x)) switches branch at 6.25 and 16: probe a dense grid and the neighbourhood of both seams
    const probes: number[] = []
    for (let i = 0; i <= 4000; i++) probes.push(i / 4000)
    for (const e of [Math.exp(-6.25), Math.exp(-16)]) {
      const x = Math.sqrt(1 - e)
      for (let k = -40; k <= 40; k++) { const p = (x + k * Number.EPSILON * 4 + 1) / 2; probes.push(p, 1 - p) }
    }
    for (let k = 1; k < 330; k++) probes.push(10 ** -k, 1 - 10 ** -k / 2)
    for (const p of probes) same(asterFns.quantileNormal(p, 1, 2), V.quantileNormal!(p, 1, 2), `quantileNormal(${p})`)
  })

  /** vega-statistics keeps half a Box-Muller pair in a module variable: take it, so the next call starts a new pair. */
  const drainVegaPair = (): void => {
    let draws = 0
    V.setRandom(() => { draws++; return 0.75 })
    V.sampleNormal!()
    if (draws > 0) V.sampleNormal!()
  }
  const drawing = [['sampleNormal', 'sampleNormalFrom'], ['sampleLogNormal', 'sampleLogNormalFrom'], ['sampleUniform', 'sampleUniformFrom']] as const
  for (const [name, fromName] of drawing) {
    it(`${name}: same numbers, same draws in the same order and count (pairs left over between calls included)`, () => {
      const r = rng(31 + name.length)
      const from = (asterFns as unknown as Record<string, (rand: () => number, ...a: unknown[]) => unknown>)[fromName]!
      for (let round = 0; round < 300; round++) {
        const seed = Math.floor(r() * 2 ** 31)
        const mine = tape(seed)
        const theirs = tape(seed)
        const seq = Array.from({ length: 1 + Math.floor(r() * 9) }, () => Array.from({ length: Math.floor(r() * 3) }, () => genParam(r)))
        drainVegaPair()
        V.setRandom(theirs.random)
        for (const args of seq) {
          same(from(mine.random, ...args), V[name]!(...args), `${name}(${args.map(String).join(', ')}) round ${round}`)
        }
        expect(mine.draws, `${name} draws, round ${round}`).toEqual(theirs.draws)
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// regression and loess
// ---------------------------------------------------------------------------------------------------------------------
type Case = { name: string; t: Record<string, unknown>; rows: Row[] }

function genXY(r: () => number, n: number, kind: number, positive: boolean): Array<{ x: unknown; y: unknown }> {
  const rows: Array<{ x: unknown; y: unknown }> = []
  const slope = (r() - 0.5) * 4
  const icpt = (r() - 0.5) * 10
  const noise = r() * 3
  const scale = 10 ** Math.floor(r() * 5 - 2)
  const ties = r() < 0.25
  for (let i = 0; i < n; i++) {
    let x = ties ? Math.floor(r() * 6) : r() * 20 * scale - (positive ? 0 : 5 * scale)
    if (positive) x = Math.abs(x) + (r() < 0.9 ? 1e-3 : 0)
    let y: number
    switch (kind) {
      case 0: y = icpt + slope * x + (r() - 0.5) * noise; break
      case 1: y = Math.exp(0.1 * slope * (x % 10)) * (1 + r() * noise * 0.1); break
      case 2: y = icpt + slope * x * x * 0.1 - x + (r() - 0.5) * noise; break
      case 3: y = Math.sin(x / (2 * scale)) * 5 + (r() - 0.5) * noise; break
      default: y = (r() - 0.5) * 100
    }
    if (positive) y = Math.abs(y) + 1e-3
    rows.push({ x, y })
  }
  // odd values: nulls, NaN, numeric strings, non-positive ones, and an outlier
  const odd = r()
  if (odd < 0.2 && rows.length) {
    rows[Math.floor(r() * rows.length)]!.x = null
    rows[Math.floor(r() * rows.length)]!.y = undefined
  } else if (odd < 0.3 && rows.length) {
    rows[Math.floor(r() * rows.length)]!.x = String(rows[0]!.x)
    rows[Math.floor(r() * rows.length)]!.y = NaN
  } else if (odd < 0.4 && rows.length) {
    rows[Math.floor(r() * rows.length)]!.y = (r() - 0.5) * 1e6
  } else if (odd < 0.46 && rows.length) {
    rows[Math.floor(r() * rows.length)]!.y = [Infinity, -Infinity, 1e300, -1e300][Math.floor(r() * 4)]!
  } else if (odd < 0.5 && rows.length) {
    rows[Math.floor(r() * rows.length)]!.x = [Infinity, -Infinity, 1e300, 'abc', true, ''][Math.floor(r() * 6)]!
  }
  return rows
}

function genCases(seed: number, count: number, kinds: Array<(r: () => number) => Record<string, unknown>>): Case[] {
  const r = rng(seed)
  const cases: Case[] = []
  for (let c = 0; c < count; c++) {
    const params = kinds[Math.floor(r() * kinds.length)]!(r)
    const log = ['log', 'exp', 'pow'].includes(String(params.method))
    const n = r() < 0.1 ? Math.floor(r() * 4) : 2 + Math.floor(r() * (r() < 0.2 ? 400 : 40))
    const groups = r() < 0.4 ? 1 + Math.floor(r() * 3) : 0
    const rows: Row[] = []
    for (let g = 0; g < Math.max(groups, 1); g++) {
      const part = genXY(r, Math.max(1, Math.floor(n / Math.max(groups, 1))), Math.floor(r() * 5), log && r() < 0.8)
      for (const p of part) rows.push(groups ? { x: p.x, y: p.y, g: `g${g}` } : { x: p.x, y: p.y })
    }
    // the transform sorts and partitions on its own; shuffle so input order is not already sorted
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rows[i], rows[j]] = [rows[j]!, rows[i]!] }
    const t: Record<string, unknown> = { x: 'x', y: 'y', ...params }
    if (groups) t.groupby = ['g']
    cases.push({ name: `#${c} ${JSON.stringify(t)} n=${rows.length}`, t, rows })
  }
  return cases
}

const regressionParams = (r: () => number): Record<string, unknown> => {
  const method = ['linear', 'log', 'exp', 'pow', 'quad', 'poly', 'constant', undefined][Math.floor(r() * 8)]
  const p: Record<string, unknown> = { type: 'regression' }
  if (method !== undefined) p.method = method
  if (method === 'poly' || r() < 0.05) {
    p.order = Math.floor(r() * 8) + (r() < 0.1 ? 0 : 1)
    if (r() < 0.12) p.order = [-1, 0.5, 2.5, 3.5, '3', '2', NaN, 1.5, null][Math.floor(r() * 9)] // odd orders: the same refusal or the same fit
  }
  if (r() < 0.3) p.extent = [(r() - 0.3) * 10, 5 + r() * 30]
  if (r() < 0.3) p.params = true
  if (r() < 0.15) p.as = ['px', 'py']
  return p
}
const loessParams = (r: () => number): Record<string, unknown> => {
  const p: Record<string, unknown> = { type: 'loess' }
  if (r() < 0.7) p.bandwidth = [0.05, 0.1, 0.3, 0.5, 0.8, 1, 2, r()][Math.floor(r() * 8)]
  if (r() < 0.15) p.as = ['lx', 'ly']
  return p
}

async function runVega(c: Case): Promise<unknown[]> {
  V.setRandom(vega.randomLCG(42) as () => number)
  const view = new vega.View(
    vega.parse({ data: [{ name: 'src', values: structuredClone(c.rows), transform: [structuredClone(c.t)] }] } as vega.Spec),
    { renderer: 'none', logLevel: vega.None },
  )
  let err: unknown
  view.logger({ level() { return 1 }, error(...a: unknown[]) { err = a[0]; return this }, warn() { return this }, info() { return this }, debug() { return this } } as never)
  try { await view.runAsync() } catch (e) { return [{ $: 'throw', message: String((e as Error).message) }] }
  if (err) return [{ $: 'throw', message: String((err as Error).message ?? err).replace(/^Error: /, '') }]
  return view.data('src')
}
function runAster(c: Case): unknown[] {
  const runtime = { scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, runtime as never) }
  const ctx = { runtime, signals: Object.create(null), datasets: () => undefined, hierarchies: new Map() }
  try { return applyTransforms(structuredClone(c.rows), [structuredClone(c.t)] as never, ctx as never, 'src') } catch (e) {
    return [{ $: 'throw', message: (e as Error).message }]
  }
}
const seen = { cases: 0, throws: 0, rows: 0 }
function compareRows(got: unknown[], want: unknown[], what: string): void {
  seen.cases++
  seen.rows += want.length
  if (want.length === 1 && '$' in (want[0] as object)) seen.throws++
  expect(got.length, `${what}: row count`).toBe(want.length)
  for (let i = 0; i < want.length; i++) {
    const g = got[i] as Record<string, unknown>
    const w = want[i] as Record<string, unknown>
    if ('$' in w) { expect(g.$, `${what}: throw`).toBe('throw'); expect(String(g.message)).toContain(String(w.message)); continue }
    const keys = Object.keys(w).filter((k) => k !== 'Symbol(vega_id)')
    expect(Object.keys(g), `${what}: keys of row ${i}`).toEqual(expect.arrayContaining(keys))
    for (const k of keys) expect(enc(g[k]), `${what}: row ${i}.${k}`).toEqual(enc(w[k]))
  }
}

describe('regression and loess over random data vs the real vega transforms', { timeout: 120_000 }, () => {
  it('regression: every method, orders 0..8, groups, extent, params, as', async () => {
    for (const c of genCases(1001, 700, [regressionParams])) compareRows(runAster(c), await runVega(c), c.name)
  })
  it('regression: each method on each data shape (a fixed sweep so none is left to chance)', async () => {
    const r = rng(77)
    const methods: Array<[string, number | undefined]> = [['linear', undefined], ['log', undefined], ['exp', undefined], ['pow', undefined], ['quad', undefined], ['constant', undefined],
      ...[1, 2, 3, 4, 5, 6, 8].map((o) => ['poly', o] as [string, number])]
    for (const [method, order] of methods) {
      for (let k = 0; k < 40; k++) {
        const positive = method === 'log' || method === 'exp' || method === 'pow'
        const rows = genXY(r, 3 + Math.floor(r() * 50), k % 5, positive)
        const t: Record<string, unknown> = { type: 'regression', x: 'x', y: 'y', method, params: k % 2 === 0, ...(order ? { order } : {}) }
        const c = { name: `${method}${order ?? ''}#${k}`, t, rows: rows as Row[] }
        compareRows(runAster(c), await runVega(c), c.name)
      }
    }
  })
  it('small integer-grid data: exact ties in the elimination pivots, in the loess windows and in the robustness weights', async () => {
    const r = rng(5150)
    for (let k = 0; k < 2500; k++) {
      const n = 3 + Math.floor(r() * 8)
      const span = 2 + Math.floor(r() * 5)
      const sym = r() < 0.5 // x symmetric about 0: equal-magnitude pivots
      const rows: Row[] = Array.from({ length: n }, (_, i) => ({ x: sym ? i - Math.floor(n / 2) : Math.floor(r() * span), y: Math.floor(r() * span * 2) - span }))
      const t: Record<string, unknown> = k % 2
        ? { type: 'regression', x: 'x', y: 'y', method: 'poly', order: 3 + (k % 5) % 4 }
        : { type: 'loess', x: 'x', y: 'y', bandwidth: [0.3, 0.5, 0.75, 1][k % 4] }
      const c = { name: `grid#${k} ${JSON.stringify(t)} ${JSON.stringify(rows)}`, t, rows }
      compareRows(runAster(c), await runVega(c), c.name)
    }
  })
  it('loess: random data, bandwidths and groups', async () => {
    for (const c of genCases(2002, 500, [loessParams])) compareRows(runAster(c), await runVega(c), c.name)
  })
})

describe('the generated regression / loess cases are not vacuous', () => {
  it('most cases produce fitted rows, and a minority refuse or are empty', () => {
    expect(seen.cases).toBeGreaterThan(1000)
    expect(seen.rows).toBeGreaterThan(30_000)
    expect(seen.throws).toBeLessThan(seen.cases * 0.1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// bootstrapCI
// ---------------------------------------------------------------------------------------------------------------------
describe('bootstrapCI under a seeded source vs vega-statistics', () => {
  it('the interval and the draws (count and order) over random samples', () => {
    const r = rng(4242)
    for (let i = 0; i < 400; i++) {
      const n = r() < 0.1 ? Math.floor(r() * 3) : 1 + Math.floor(r() * 60)
      const arr: unknown[] = Array.from({ length: n }, () => {
        const k = r()
        if (k < 0.05) return null
        if (k < 0.08) return NaN
        if (k < 0.1) return String(Math.round(r() * 10))
        return k < 0.5 ? Math.round(r() * 20) : (r() - 0.5) * 10 ** Math.floor(r() * 8 - 2)
      })
      const samples = [1, 2, 10, 100, 1000][Math.floor(r() * 5)]!
      const alpha = [0.05, 0.5, 0.01, 0.1, 1, 0, r()][Math.floor(r() * 7)]!
      const useAccessor = r() < 0.4
      const f = useAccessor ? (d: unknown) => (d as { v: unknown }).v : undefined
      const data = useAccessor ? arr.map((v) => ({ v })) : arr
      const seed = Math.floor(r() * 2 ** 31)
      const a = tape(seed)
      const b = tape(seed)
      V.setRandom(b.random)
      const want = V.bootstrapCI!(data, samples, alpha, f)
      const got = asterBootstrapCI(data as never, samples, alpha, f, a.random)
      same(got, want, `bootstrapCI #${i} n=${n} samples=${samples} alpha=${alpha}`)
      expect(a.draws, `draws of #${i}`).toEqual(b.draws)
    }
  })
  it('aggregate ci0 / ci1 and joinaggregate over random groups', async () => {
    const r = rng(99)
    for (let i = 0; i < 60; i++) {
      const rows: Row[] = Array.from({ length: 5 + Math.floor(r() * 80) }, () => ({ g: `g${Math.floor(r() * 4)}`, v: Math.round(r() * 30 * 10) / 10 }))
      const ops = [['ci0', 'ci1'], ['ci1', 'mean', 'ci0']][i % 2]!
      const t = i % 3 === 0
        ? { type: 'joinaggregate', groupby: ['g'], ops, fields: ops.map(() => 'v'), as: ops.map((_, k) => `o${k}`) }
        : { type: 'aggregate', groupby: i % 3 === 1 ? ['g'] : [], ops, fields: ops.map(() => 'v'), as: ops.map((_, k) => `o${k}`) }
      const seed = Math.floor(r() * 2 ** 31)
      V.setRandom(seededRandom(seed))
      const view = new vega.View(vega.parse({ data: [{ name: 'src', values: structuredClone(rows), transform: [structuredClone(t)] }] } as vega.Spec), { renderer: 'none', logLevel: vega.None })
      await view.runAsync()
      const want = view.data('src')
      const runtime = { scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, runtime as never), random: seededRandom(seed) }
      const ctx = { runtime, signals: Object.create(null), datasets: () => undefined, hierarchies: new Map() }
      const got = applyTransforms(structuredClone(rows), [structuredClone(t)] as never, ctx as never, 'src')
      compareRows(got, want, `${JSON.stringify(t)} #${i}`)
    }
  })
})
