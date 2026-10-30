/**
 * GENERATED live differential for the aggregation and row-reshaping transforms against the pinned real Vega, in this process.
 *
 * `differential-transforms.test.mts` pins a fixed list of ~3000 hand-written cases. This file adds seeded, randomly drawn ones for the
 * transforms whose output depends on how values are combined, ordered and keyed: every aggregate op (nulls, NaN, strings, Dates,
 * empty and one-member groups, floats whose sum depends on the order of accumulation), every window op with random frames, sort ties,
 * `ignorePeers` and open frames, pivot with `limit` and `op`, bin with every parameter (also given as signals), stack offsets and
 * sort, impute methods with `keyvals`, lookup with defaults and several key fields, fold, flatten, project, identifier and timeunit.
 *
 * What is compared, strictly (no tolerance):
 *   - the output rows: values (NaN, -0, undefined-valued keys, Dates), the ORDER of each row's keys, the order of the rows;
 *   - that the input rows were not touched (the run repeats over deep-frozen inputs);
 *   - a thrown error: Aster must refuse when Vega does, with Vega's message;
 *   - the random source: the number of draws the transform made and the next value of the stream, so a transform that draws
 *     (ci0/ci1, sample) draws the same count in the same order as Vega;
 *   - the `signal` a bin publishes (start, stop, step).
 *
 * Every case is reproducible from its suite, seed and index (a failure prints the transform and the rows). `ASTER_DIFF_SCALE=10`
 * multiplies the counts.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { applyTransforms, compileExpr, type Row } from '@aster/core'
import '@aster/core/transforms'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

const SEED = 42

// ---------------------------------------------------------------------------
// the two sides
// ---------------------------------------------------------------------------

interface Case {
  t: Record<string, unknown>[]
  rows: unknown[]
  /** Signals the transform params refer to (`{signal: name}`), by name. */
  signals?: Record<string, unknown>
  /** Datasets other than `src` (lookup's `from`). */
  extra?: Record<string, unknown[]>
  /** Names of the signals the transforms publish, compared after the run. */
  publish?: string[]
}

interface Outcome {
  out?: unknown[]
  published?: Record<string, unknown>
  draws: number
  next: number
  error?: Error
}

function countingLcg(): { random: () => number; draws: () => number } {
  const base = vega.randomLCG(SEED)
  let n = 0
  return { random: () => { n++; return base() }, draws: () => n }
}

/** What Vega publishes through a bin's `signal` is the binning function itself; the comparable part is its three numbers. */
function publishedValue(v: unknown): unknown {
  if (v && (typeof v === 'function' || typeof v === 'object') && 'units' in (v as object)) {
    const o = v as { unit: unknown; units: unknown; step: unknown; start: unknown; stop: unknown }
    return { unit: o.unit, units: o.units, step: o.step, start: o.start, stop: o.stop }
  }
  if (typeof v === 'function' || (v && typeof v === 'object')) {
    const f = v as unknown as { start: number; stop: number; step: number }
    return { start: f.start, stop: f.stop, step: f.step }
  }
  return v
}

async function runVega(c: Case): Promise<Outcome> {
  const data: unknown[] = []
  for (const [name, v] of Object.entries(c.extra ?? {})) data.push({ name, values: structuredClone(v) })
  data.push({ name: 'src', values: structuredClone(c.rows), transform: structuredClone(c.t) })
  const signals = Object.entries(c.signals ?? {}).map(([name, value]) => ({ name, value: structuredClone(value) }))
  const rng = countingLcg()
  const errors: string[] = []
  vega.setRandom(rng.random)
  try {
    const view = new vega.View(vega.parse({ signals, data } as vega.Spec), { renderer: 'none', logLevel: vega.None })
    view.logger({
      level() { return 1 },
      error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')); return this },
      warn() { return this }, info() { return this }, debug() { return this },
    } as unknown as vega.LoggerInterface)
    await view.runAsync()
    if (errors.length) return { error: new Error(errors[0]!.replace(/^Error: /, '')), draws: rng.draws(), next: 0 }
    const published: Record<string, unknown> = {}
    for (const s of c.publish ?? []) published[s] = publishedValue(view.signal(s))
    return { out: view.data('src'), published, draws: rng.draws(), next: rng.random() }
  } catch (err) {
    return { error: err as Error, draws: rng.draws(), next: 0 }
  }
}

function deepFreeze<T>(v: T, seen = new Set<unknown>()): T {
  if (v === null || typeof v !== 'object' || seen.has(v) || v instanceof Date) return v
  seen.add(v)
  Object.freeze(v)
  for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k], seen)
  return v
}

function runAster(c: Case, freeze: boolean): Outcome {
  const prep = <T,>(v: T): T => (freeze ? deepFreeze(structuredClone(v)) : structuredClone(v))
  const extra: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(c.extra ?? {})) extra[k] = prep(v) as Row[]
  const signals: Record<string, unknown> = Object.create(null)
  for (const [k, v] of Object.entries(c.signals ?? {})) signals[k] = structuredClone(v)
  const rng = countingLcg()
  const runtime: { scale: () => undefined; data: () => never[]; expr: (e: string) => unknown; random: () => number } = {
    scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, runtime as never), random: rng.random,
  }
  const ctx = { runtime, signals, datasets: (n: string) => extra[n], hierarchies: new Map<string, unknown>() }
  try {
    const out = applyTransforms(prep(c.rows) as Row[], structuredClone(c.t) as never, ctx as never, 'src')
    const published: Record<string, unknown> = {}
    for (const s of c.publish ?? []) published[s] = publishedValue(signals[s])
    return { out, published, draws: rng.draws(), next: rng.random() }
  } catch (err) {
    return { error: err as Error, draws: rng.draws(), next: 0 }
  }
}

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

const show = (v: unknown): string => {
  if (typeof v === 'object' && v !== null) return v instanceof Date ? `Date(${v.getTime()})` : Array.isArray(v) ? `[array ${v.length}]` : '{object}'
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

/** Strict structural equality, key ORDER included; the path of the first difference, or null. */
function diff(a: unknown, b: unknown, path = '$', seen = new Map<unknown, Set<unknown>>()): string | null {
  if (Object.is(a, b)) return null
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime()) ? null : `${path}: ${show(a)} vs ${show(b)}`
  if (typeof a === 'function' && typeof b === 'function') return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${show(a)} vs ${show(b)}`
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`
  const s = seen.get(a) ?? new Set()
  seen.set(a, s)
  if (s.has(b)) return null
  s.add(b)
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return `${path}.length: ${a.length} vs ${bb.length}`
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], bb[i], `${path}[${i}]`, seen)
      if (d) return d
    }
    return null
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  const kb = Object.keys(rb)
  if (ka.join('\u0000') !== kb.join('\u0000')) return `${path}: keys [${ka.join(',')}] vs [${kb.join(',')}]`
  for (const k of ka) {
    const d = diff(ra[k], rb[k], `${path}.${k}`, seen)
    if (d) return d
  }
  return null
}

const INCIDENTAL = /Cannot read properties|is not a function|is not iterable|undefined|not defined/

interface Tally { cases: number; compared: number; threw: number; crashed: number; draws: number }

/** Run one case through both sides; the mismatch description, or null. `crashed` counts Vega's incidental TypeErrors (not comparable). */
async function check(c: Case, tally: Tally): Promise<string | null> {
  tally.cases++
  const want = await runVega(c)
  if (want.error) {
    const msg = String(want.error.message ?? want.error)
    if (/Cannot read properties|is not iterable|is not a function/.test(msg) && !/^AggregateOps\[op\]/.test(msg)) {
      tally.crashed++
      if (process.env.ASTER_GEN_DEBUG) console.log('CRASH', JSON.stringify(c.t).slice(0, 300), msg)
      return null
    }
    tally.threw++
    const got = runAster(c, false)
    if (!got.error) return `Aster did not refuse; vega: ${msg}`
    if (!INCIDENTAL.test(msg) && !got.error.message.includes(msg)) return `error text: aster "${got.error.message}" vs vega "${msg}"`
    return null
  }
  tally.compared++
  tally.draws += want.draws
  for (const freeze of [false, true]) {
    const got = runAster(c, freeze)
    if (got.error) return `${freeze ? 'frozen inputs: ' : ''}Aster threw: ${got.error.message}`
    let d = diff(got.out, want.out)
    if (d) return `${freeze ? 'frozen inputs: ' : ''}${d}`
    d = diff(got.published, want.published, 'published')
    if (d) return d
    if (got.draws !== want.draws) return `random draws: aster ${got.draws} vs vega ${want.draws}`
    if (got.next !== want.next) return 'random stream position differs after the run'
  }
  return null
}

// ---------------------------------------------------------------------------
// value and row generators
// ---------------------------------------------------------------------------

const D = (s: string): Date => new Date(s)
const FLOATS = [0.1, 0.2, 0.3, 0.7, 1 / 3, 2 / 3, 1e-7, 123456.789, 99999.99, 0.015, 1e15, 1e15 + 0.5, 7.77, 1e-300, 2.5e-5]
const WIDE = [1, 1e16, -1e16, 1e16 + 2, 3, 1e308, -1e308, 5e-324, 0.1, 9007199254740993, 1e21, -1e21, 4.9e-324, 12345678901234567]
const STRINGS = ['7', ' 8 ', '1e2', '0x10', '', 'abc', 'true', '2020-01-01', '-3', '10', '9', '2.5', 'B', 'a', 'Z']
const DATES = [D('2020-03-15T12:34:56.789Z'), D('1999-12-31T23:59:59.000Z'), D('2021-02-02'), new Date(NaN), D('2020-03-15T12:34:56.789Z'), D('1970-01-01')]
const ODD: unknown[] = [
  0, 1, -1, 2.5, 1e21, '7', ' 8 ', '1e2', '0x10', '', 'abc', 'true', null, undefined, NaN, Infinity, -Infinity,
  true, false, ...DATES, [3], [], -0, '', null, NaN,
]
const NULLISH: unknown[] = [null, undefined, NaN, '']

type Mode = 'ints' | 'floats' | 'wide' | 'strings' | 'dates' | 'odd' | 'nullish' | 'mixed' | 'small'
const MODES: Mode[] = ['ints', 'ints', 'floats', 'floats', 'wide', 'strings', 'dates', 'odd', 'odd', 'nullish', 'nullish', 'mixed', 'small']

function genValue(r: Rng, mode: Mode): unknown {
  switch (mode) {
    case 'ints': return r.between(-5, 20)
    case 'small': return r.between(0, 3)
    case 'floats': return r.chance(0.7) ? r.pick(FLOATS) * r.pick([1, 1, -1, 10, 100]) : r.between(-3, 9)
    case 'wide': return r.pick(WIDE)
    case 'strings': return r.pick(STRINGS)
    case 'dates': return r.chance(0.1) ? null : r.pick(DATES)
    case 'odd': return r.pick(ODD)
    case 'nullish': return r.chance(0.35) ? r.pick(NULLISH) : r.chance(0.5) ? r.between(-4, 12) : r.pick(FLOATS)
    case 'mixed': return r.chance(0.5) ? r.pick(ODD) : r.chance(0.5) ? r.pick(FLOATS) : r.between(-9, 9)
  }
}

const GROUPS: unknown[] = ['a', 'b', 'c', null, undefined, NaN, 1, '1', 0, '', true, 'a|b', 'b', 'a']
const H_POOL: unknown[] = ['p', 'q', 'p', 1, '1', null]

/**
 * The rows of a case. Fields: `g`/`h` group keys, `v`/`w` values (own modes), `k` a sort key with many ties, `i` the position; the
 * same values also sit at the nested/indexed/escaped paths `a.v`, `a.g`, `x[1]` and `'e.v'`, so access paths are exercised everywhere.
 */
function genRows(r: Rng, n: number): Record<string, unknown>[] {
  const vMode = r.pick(MODES)
  const wMode = r.pick(MODES)
  const groups = r.chance(0.6) ? ['a', 'b', 'c'] : r.chance(0.5) ? GROUPS : ['a', 'b']
  const kMode: Mode = r.chance(0.7) ? 'small' : r.chance(0.5) ? 'nullish' : 'mixed'
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < n; i++) {
    const v = genValue(r, vMode)
    const g = r.pick(groups)
    const row: Record<string, unknown> = { g, h: r.pick(H_POOL), v, w: genValue(r, wMode), k: genValue(r, kMode), i }
    row.a = { v, g }
    row['e.v'] = v
    row.x = [0, v]
    rows.push(row)
  }
  return rows
}

const fieldFor = (r: Rng, nested: boolean): string => (nested ? r.pick(['v', 'w', 'a.v', 'e\\.v', 'x[1]', 'k']) : r.pick(['v', 'w', 'k']))

/** Move numeric/boolean/array params into signals: `{signal: name}` in the transform, the value in the spec's signals. */
function withSignals(r: Rng, t: Record<string, unknown>, keys: string[], signals: Record<string, unknown>, p = 0.3): Record<string, unknown> {
  const out = { ...t }
  for (const k of keys) {
    if (k in out && out[k] !== undefined && r.chance(p)) {
      const name = `s_${k}`
      signals[name] = out[k]
      out[k] = { signal: name }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// the suites
// ---------------------------------------------------------------------------

const AGG_OPS = [
  'count', 'valid', 'missing', 'distinct', 'sum', 'product', 'mean', 'average', 'variance', 'variancep', 'stdev', 'stdevp', 'stderr',
  'median', 'q1', 'q3', 'min', 'max', 'argmin', 'argmax', 'values', 'ci0', 'ci1', 'exponential', 'exponentialb',
]
const WINDOW_ONLY = ['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value', 'prev_value', 'next_value']
const NO_FIELD_WINDOW = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile'])

function genSort(r: Rng): Record<string, unknown> | undefined {
  if (r.chance(0.2)) return undefined
  if (r.chance(0.7)) return { field: r.pick(['k', 'v', 'w']), ...(r.chance(0.5) ? { order: r.pick(['ascending', 'descending']) } : {}) }
  const n = r.between(2, 3)
  return { field: Array.from({ length: n }, () => r.pick(['k', 'v', 'g', 'w'])), order: Array.from({ length: n }, () => r.pick(['ascending', 'descending'])) }
}

function genMeasures(r: Rng, pool: string[], nested: boolean): { ops: string[]; fields: (string | null)[]; as?: (string | null)[]; aggregate_params?: unknown[] } {
  const n = r.between(1, 5)
  const ops = Array.from({ length: n }, () => r.pick(pool))
  const fields = ops.map((o) => (o === 'count' ? (r.chance(0.8) ? null : fieldFor(r, nested)) : fieldFor(r, nested)))
  const out: ReturnType<typeof genMeasures> = { ops, fields }
  if (r.chance(0.35)) out.as = ops.map((o, i) => (r.chance(0.5) ? `m${i}_${o}` : r.chance(0.5) ? null : ''))
  if (ops.some((o) => o.startsWith('exponential')) && r.chance(0.85)) {
    out.aggregate_params = ops.map((o) => (o.startsWith('exponential') ? (r.chance(0.9) ? r.pick([0.5, 0.9, 0.1, 0.3, 0.75, 1.5, 2, 0]) : null) : null))
  }
  return out
}

function genAggregateLike(r: Rng, type: 'aggregate' | 'joinaggregate'): Case {
  const nested = r.chance(0.3)
  const m = genMeasures(r, AGG_OPS, nested)
  const groupby = r.pick<string[] | undefined>([undefined, [], ['g'], ['g'], ['g', 'h'], nested ? ['a.g'] : ['h'], ['a.g', 'h']])
  const t: Record<string, unknown> = { type, ...(groupby ? { groupby } : {}), fields: m.fields, ops: m.ops }
  if (m.as) t.as = m.as
  if (m.aggregate_params) t.aggregate_params = m.aggregate_params
  if (type === 'aggregate') {
    // (cross fills the missing cells from the group values alone, so a nested group path cannot be read back: both sides throw a TypeError)
    if (groupby && groupby.length > 1 && r.chance(0.25) && !groupby.some((g) => /[.[\\]/.test(g))) t.cross = true
    if (r.chance(0.1)) t.drop = false
  }
  if (r.chance(0.08)) t.key = r.pick(['k', 'i', 'g'])
  if (r.chance(0.05)) t.fields = m.fields.slice(0, -1) // unmatched fields and ops
  if (r.chance(0.03)) t.ops = [...m.ops.slice(0, -1), 'frobnicate']
  const signals: Record<string, unknown> = {}
  const n = r.chance(0.1) ? r.between(0, 1) : r.between(2, 40)
  return { t: [withSignals(r, t, ['aggregate_params', 'cross', 'drop'], signals)], rows: genRows(r, n), signals }
}

function genWindow(r: Rng): Case {
  const nested = r.chance(0.2)
  const n = r.between(1, 4)
  const ops = Array.from({ length: n }, () => r.pick(r.chance(0.6) ? WINDOW_ONLY : AGG_OPS.filter((o) => o !== 'ci0' && o !== 'ci1' || r.chance(0.1))))
  const fields = ops.map((o) => (NO_FIELD_WINDOW.has(o) || o === 'count' ? (r.chance(0.9) ? null : fieldFor(r, nested)) : fieldFor(r, nested)))
  const params = ops.map((o) => {
    if (o === 'ntile') return r.pick([1, 2, 3, 4, 7, 0, '3', 2.5])
    if (o === 'nth_value') return r.pick([1, 2, 3, 5, 0, '2'])
    if (o === 'lag' || o === 'lead') return r.pick([null, 1, 2, 3, 0, '2', 5])
    return null
  })
  const t: Record<string, unknown> = { type: 'window', ops, fields, params }
  const sort = genSort(r)
  if (sort) t.sort = sort
  if (r.chance(0.3)) t.ignorePeers = r.chance(0.8)
  if (r.chance(0.55)) t.groupby = r.pick([['g'], ['h'], ['g', 'h'], nested ? ['a.g'] : ['g']])
  // vega adjusts a frame over peers (sort, no ignorePeers) by reading the rows at both of its ends, and crashes with a TypeError when an
  // end lies outside the partition (a frame that starts after the current row, or ends before it); Aster does not (see the header
  // of the window suite), so those frames are drawn only where the rows are not read: with ignorePeers or without a sort.
  const ranged = !!t.sort && t.ignorePeers !== true
  const anywhere: unknown[] = [undefined, [null, 0], [null, 0], [-1, 1], [null, null], [-2, 0], [0, 2], [1, null], [0, 0], [-3, -1], [1, 3], [2, -1], [-1, null], [null, 1], [0, null], [-5, 5], [null]]
  const inside: unknown[] = [undefined, [null, 0], [null, 0], [-1, 1], [null, null], [-2, 0], [0, 2], [0, 0], [-1, null], [null, 1], [0, null], [-5, 5]]
  const frame = r.pick(ranged ? inside : anywhere) as [number | null, number | null] | undefined
  if (frame) t.frame = frame
  // first_value / last_value read the row at the end of the frame, which does not exist when the frame lies outside the partition
  const exotic = !!frame && ((frame[0] ?? 0) > 0 || (frame[1] ?? 0) < 0)
  if (exotic) {
    for (let i = 0; i < ops.length; i++) if (ops[i] === 'first_value' || ops[i] === 'last_value') { ops[i] = 'nth_value'; params[i] = 1 }
  }
  if (ops.some((o) => o.startsWith('exponential'))) t.aggregate_params = ops.map((o) => (o.startsWith('exponential') ? r.pick([0.5, 0.9, null]) : null))
  if (r.chance(0.3)) t.as = ops.map((o, i) => (r.chance(0.6) ? `w${i}_${o}` : null))
  const signals: Record<string, unknown> = {}
  return { t: [withSignals(r, t, ['frame', 'ignorePeers', 'params'], signals)], rows: genRows(r, r.chance(0.08) ? 0 : r.between(1, 30)), signals }
}


/**
 * Windows whose measures read the stored rows of a frame through SEVERAL fields (min, max, quartiles, distinct, argmin... over v, w and
 * k at once, over sliding frames): the rows a frame holds are shared by every field's measures, and what one field's read leaves
 * behind is seen by the next field's.
 */
function genWindowStores(r: Rng): Case {
  const pool = ['min', 'max', 'median', 'q1', 'q3', 'distinct', 'argmin', 'argmax', 'values', 'sum', 'mean', 'valid', 'missing', 'ci0']
  const n = r.between(3, 7)
  const ops = Array.from({ length: n }, () => r.pick(pool))
  const fields = ops.map(() => r.pick(['v', 'w', 'k']))
  const t: Record<string, unknown> = { type: 'window', ops, fields, sort: { field: 'i' }, frame: r.pick([[-2, 0], [-1, 1], [null, 0], [0, null], [-3, 3], [-1, 0], [0, 2]]) }
  if (r.chance(0.5)) t.groupby = ['g']
  if (r.chance(0.3)) t.ignorePeers = true
  return { t: [t], rows: genRows(r, r.between(2, 25)) }
}

/**
 * Chains of two to four transforms. The rows a transform returns may be written onto by the next one (in Vega they are the same
 * tuples all the way down): that must not show anywhere it did not before, and where a result holds rows (`values`, `argmin`,
 * `argmax`) it must show what Vega shows there.
 */
function genChain(r: Rng): Case {
  const steps: Array<() => Record<string, unknown>> = [
    () => ({ type: 'formula', expr: r.pick(['datum.i * 2', 'datum.w', 'datum.k + 1', 'datum.v']), as: r.pick(['f1', 'f2', 'v', 'i']) }),
    () => ({ type: 'formula', expr: 'datum.i + 1', as: r.pick(['f1', 'v', 'bin0']) }),
    () => ({ type: 'bin', field: r.pick(['v', 'w', 'i']), extent: r.pick([[-10, 30], [0, 25], [-100, 100]]), maxbins: r.pick([5, 10, 20]), as: r.pick([['b0', 'b1'], ['bin0', 'bin1'], ['v', 'w'], ['f1', 'b1']]) }),
    () => ({ type: 'identifier', as: r.pick(['id', 'i', 'v']) }),
    () => ({ type: 'project', ...(r.chance(0.6) ? { fields: ['g', 'v', 'w', 'k', 'i', 'f1', 'b0', 'id'], as: r.pick([undefined, ['g', 'v', 'w', 'k', 'i', 'f1', 'b0', 'id']]) } : {}) }),
    () => ({ type: 'stack', field: r.pick(['w', 'i']), groupby: ['g'], offset: r.pick(['zero', 'center', 'normalize']), as: r.pick([['y0', 'y1'], ['b0', 'b1'], ['v', 'w']]) }),
    () => ({ type: 'joinaggregate', groupby: ['g'], fields: ['v', 'w', 'v'], ops: [r.pick(['sum', 'max']), r.pick(['values', 'argmin', 'argmax', 'mean']), r.pick(['values', 'count', 'argmax'])], as: [r.pick(['s', 'f1']), r.pick(['vals', 'am', 'f2']), r.pick(['vs', 'n'])] }),
    () => ({ type: 'window', sort: { field: 'k' }, groupby: r.pick([['g'], []]), ops: [r.pick(['sum', 'values', 'argmax', 'rank', 'count']), r.pick(['row_number', 'values', 'lag'])], fields: ['v', 'w'], as: [r.pick(['ws', 'f1']), r.pick(['wr', 'wv'])], frame: r.pick([[null, 0], [-1, 1], [null, null]]) }),
    () => ({ type: 'aggregate', groupby: ['g'], fields: ['v', 'w', 'v'], ops: [r.pick(['sum', 'values', 'argmin']), 'max', 'count'] }),
    () => ({ type: 'filter', expr: r.pick(['datum.i % 2 === 0', 'datum.k > 0', 'true']) }),
    () => ({ type: 'collect', sort: { field: r.pick(['k', 'i', 'v']), order: r.pick(['ascending', 'descending']) } }),
    () => ({ type: 'lookup', from: 'lk', key: 'k', fields: ['k'], ...(r.chance(0.5) ? { as: ['m'] } : { values: ['w'], as: ['lw'] }), default: r.pick([0, null]) }),
    () => ({ type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [0, 1, 2, 3, 4], method: r.pick(['value', 'mean', 'max']) }),
    () => ({ type: 'timeunit', field: 'i', units: ['year'], timezone: 'utc', as: r.pick([['u0', 'u1'], ['f1', 'f2']]) }),
    () => ({ type: 'fold', fields: ['v', 'w'], as: r.pick([['key', 'value'], ['f1', 'f2']]) }),
  ]
  // Two things Vega does that the engine does not (and that are not about who writes the rows): its ids number across ALL identifier
  // transforms of a view, and its ties in a sort go by the order the tuples were created in, which a `collect` before them has changed.
  // So: one identifier at most, and a collect only last.
  const t: Array<Record<string, unknown>> = []
  const length = r.between(2, 4)
  for (let i = 0; i < length; i++) {
    let step = r.pick(steps)()
    for (let tries = 0; tries < 8; tries++) {
      const clash = (step.type === 'identifier' && t.some((x) => x.type === 'identifier')) || (step.type === 'collect' && i < length - 1)
      if (!clash) break
      step = r.pick(steps)()
    }
    if ((step.type === 'identifier' && t.some((x) => x.type === 'identifier')) || (step.type === 'collect' && i < length - 1)) step = { type: 'formula', expr: 'datum.i', as: 'f1' }
    t.push(step)
  }
  return { t, rows: genRows(r, r.between(0, 14)), extra: { lk: Array.from({ length: 4 }, (_, i) => ({ k: i, w: i * 10 })) } }
}

function genPivot(r: Rng): Case {
  const keyPools: unknown[][] = [['x', 'y', 'z'], ['x', 'y', 'z', 'b', 'a', 10, 2, null, '2'], [1, 2, 3, 10], [D('2020-01-01'), D('2019-01-01')]]
  const keys = r.pick(keyPools)
  const rows = genRows(r, r.between(0, 30)).map((row) => ({ ...row, p: r.pick(keys) }))
  const op = r.pick<string | undefined>([undefined, ...AGG_OPS.filter((o) => o !== 'exponential' && o !== 'exponentialb')])
  const t: Record<string, unknown> = { type: 'pivot', field: 'p', value: r.pick(['v', 'w', 'k']), ...(op ? { op } : {}) }
  if (r.chance(0.7)) t.groupby = r.pick([['g'], ['h'], ['g', 'h']])
  if (r.chance(0.35)) t.limit = r.pick([0, 1, 2, 3, 10, '2', null])
  if (r.chance(0.1)) t.key = r.pick(['k', 'i'])
  if (r.chance(0.04)) t.op = 'nope'
  const signals: Record<string, unknown> = {}
  return { t: [withSignals(r, t, ['limit'], signals)], rows, signals }
}

function genBin(r: Rng): Case {
  const mode = r.pick<Mode>(['ints', 'floats', 'wide', 'odd', 'nullish', 'strings', 'dates'])
  const rows: Record<string, unknown>[] = []
  const scale = r.pick([1, 1, 0.001, 100, 1e6, 1e-6])
  const n = r.between(0, 25)
  // values a hair below a bin edge: the bin an edge-adjacent value falls in depends on the epsilon added before the floor
  const edgeStep = r.pick([0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 0.05, 3])
  const edges = r.chance(0.35)
  for (let i = 0; i < n; i++) {
    if (edges) {
      const delta = r.pick([0, 0, -1e-16, -1e-15, -5e-15, 1e-15, -2e-14, -5e-14, -1e-13, -5e-13, -1e-12, 1e-13])
      rows.push({ v: edgeStep * (r.between(0, 40) + delta), i })
      continue
    }
    const v = genValue(r, mode)
    rows.push({ v: typeof v === 'number' && r.chance(0.8) ? v * scale : v, i })
  }
  const lo = r.pick([0, -3, 2.5, 1e-3, -1e9, 10, 0.1, 1e6, -7.77])
  const ext = r.pick([[lo, lo + r.pick([100, 10, 1, 0.5, 1e-4, 3e9, 0, 55.5, 7])], [lo, lo], [lo + 50, lo], [NaN, 5], [3, NaN], [-Infinity, Infinity], [null, 7]])
  const t: Record<string, unknown> = { type: 'bin', field: r.pick(['v', 'v', 'v']), extent: ext }
  if (r.chance(0.6)) t.maxbins = r.pick([1, 2, 3, 5, 7, 10, 20, 40, 100, 1000, 0, 2.5, '8', null, 100000])
  if (r.chance(0.25)) t.step = r.pick([0.1, 0.5, 2, 3, 10, 25, 0, 1e-3, '4'])
  if (r.chance(0.2)) t.steps = r.pick([[1, 2, 5], [3, 4], [0.1, 0.25], [10, 20, 50], [], [7]])
  if (r.chance(0.3)) t.nice = r.chance(0.5)
  if (r.chance(0.25)) t.minstep = r.pick([0, 0.1, 1, 3, 50])
  if (r.chance(0.3)) t.divide = r.pick([[5, 2], [2], [3, 7], [5, 3, 2], [], [4]])
  if (r.chance(0.2)) t.span = r.pick([1, 5, 50, 1e4, 0, -5])
  if (r.chance(0.3)) t.anchor = r.pick([0, 1.5, -7, 3, 100, 1e-3])
  if (r.chance(0.2)) t.base = r.pick([10, 2, 5, 3, 16, 1.5])
  if (r.chance(0.2)) t.interval = r.chance(0.5)
  if (r.chance(0.2)) t.as = r.pick([['lo', 'hi'], ['only'], ['b', 'b'], ['v', 'i']])
  if (r.chance(0.7)) t.signal = 'bins'
  const signals: Record<string, unknown> = {}
  const tt = withSignals(r, t, ['extent', 'maxbins', 'step', 'steps', 'nice', 'minstep', 'divide', 'span', 'anchor', 'base', 'interval'], signals, 0.25)
  return { t: [tt], rows, signals, publish: t.signal ? ['bins'] : [] }
}

function genStack(r: Rng): Case {
  const t: Record<string, unknown> = { type: 'stack' }
  if (r.chance(0.9)) t.field = r.pick(['v', 'w', 'a.v'])
  if (r.chance(0.8)) t.groupby = r.pick([['g'], ['h'], ['g', 'h'], ['k']])
  const sort = genSort(r)
  if (sort && r.chance(0.7)) t.sort = sort
  if (r.chance(0.85)) t.offset = r.pick(['zero', 'center', 'normalize', 'zero', 'bogus'])
  if (r.chance(0.2)) t.as = r.pick([['lo', 'hi'], ['lo'], ['y0', 'v']])
  const signals: Record<string, unknown> = {}
  return { t: [withSignals(r, t, ['offset'], signals)], rows: genRows(r, r.between(0, 30)), signals }
}

function genImpute(r: Rng): Case {
  const mode = r.pick<Mode>(['ints', 'floats', 'nullish', 'strings', 'dates', 'odd', 'small'])
  const keyvalPool: unknown[] = [0, 1, 2, 3, 4, '1', '2', null, 5, 10]
  const rows: Record<string, unknown>[] = []
  for (let i = 0, n = r.between(0, 25); i < n; i++) {
    rows.push({ g: r.pick(['a', 'b', 'c', 1]), h: r.pick(['p', 'q']), k: r.pick(keyvalPool), v: genValue(r, mode), i, a: { v: i } })
  }
  const t: Record<string, unknown> = { type: 'impute', field: r.pick(['v', 'a.v']), key: 'k' }
  if (r.chance(0.8)) t.groupby = r.pick([['g'], ['g', 'h'], ['h']])
  if (r.chance(0.6)) t.keyvals = Array.from({ length: r.between(0, 6) }, () => r.pick(keyvalPool))
  if (r.chance(0.85)) t.method = r.pick(['value', 'mean', 'median', 'min', 'max', 'value'])
  if (r.chance(0.04)) t.method = 'nope'
  if (r.chance(0.3)) t.value = r.pick([0, 7, -1, null, 'missing', { a: 1 }, NaN, undefined])
  const signals: Record<string, unknown> = {}
  return { t: [withSignals(r, t, ['keyvals', 'value', 'method'], signals, 0.2)], rows, signals }
}

function genLookup(r: Rng): Case {
  const keyPool: unknown[] = ['a', 'b', 'c', 1, '1', 2, '2', null, undefined, NaN, true, 'true', D('2020-01-01'), '', 0, 'constructor', 'x|y']
  const table = Array.from({ length: r.between(0, 14) }, (_, i) => ({ k: r.pick(keyPool), w: genValue(r, 'mixed'), u: `u${i}`, nest: { z: i } }))
  const nf = r.chance(0.75) ? 1 : 2
  const rows = Array.from({ length: r.between(0, 25) }, (_, i) => ({ f: r.pick(keyPool), f2: r.pick(keyPool), i }))
  const t: Record<string, unknown> = { type: 'lookup', from: 'lk', key: 'k', fields: nf === 1 ? ['f'] : ['f', 'f2'] }
  const useValues = r.chance(0.55)
  if (useValues) t.values = r.pick([['w'], ['w', 'u'], ['nest.z'], ['u']])
  const m = useValues ? (t.values as string[]).length * nf : nf
  if (r.chance(0.7)) t.as = Array.from({ length: r.chance(0.9) ? m : Math.max(0, m - 1) }, (_, i) => `o${i}`)
  if (r.chance(0.5)) t.default = r.pick([0, 'none', null, false, '', NaN, -1])
  return { t: [t], rows, extra: { lk: table } }
}

function genReshape(r: Rng): Case {
  const rows = genRows(r, r.between(0, 20)).map((row) => ({ ...row, arr: r.pick([[1, 2, 3], [], 'str', [null, undefined, 4], [5]]), arr2: r.pick([[1, 2], [7, 8, 9, 10], [], [0]]) }))
  const kind = r.between(0, 3)
  const names = ['v', 'w', 'k', 'g']
  if (kind === 0) {
    const fields = Array.from({ length: r.between(1, 3) }, () => r.pick(names))
    const t: Record<string, unknown> = { type: 'fold', fields }
    if (r.chance(0.5)) t.as = r.pick([['key', 'value'], ['name', 'val'], ['v', 'k'], ['i']])
    return { t: [t], rows }
  }
  if (kind === 1) {
    const fields = r.pick([['arr'], ['arr', 'arr2'], ['arr2']])
    const t: Record<string, unknown> = { type: 'flatten', fields }
    if (r.chance(0.5)) t.as = r.pick([['a'], ['a', 'b'], [null, 'b'], ['v']])
    if (r.chance(0.5)) t.index = r.pick(['ix', 'i', ''])
    return { t: [t], rows }
  }
  if (kind === 2) {
    const t: Record<string, unknown> = { type: 'project' }
    if (r.chance(0.8)) t.fields = Array.from({ length: r.between(0, 3) }, () => r.pick(['v', 'w', 'a.v', 'x[1]', 'e\\.v', 'g']))
    if (r.chance(0.5)) t.as = r.pick([['a', 'b', 'c'], [null, 'q'], ['g', 'g']])
    return { t: [t], rows }
  }
  const t: Record<string, unknown> = { type: 'identifier', as: r.pick(['id', 'i', 'v']) }
  return { t: [t], rows: rows.map((row) => (r.chance(0.3) ? { ...row, id: r.pick([0, 5, '', 'x']) } : row)) }
}

function genTimeunit(r: Rng): Case {
  const t0 = Date.UTC(2018, 0, 1)
  const span = r.pick([1000, 60000, 3_600_000, 86_400_000, 30 * 86_400_000, 365 * 86_400_000, 8 * 365 * 86_400_000, 40 * 365 * 86_400_000])
  const rows = Array.from({ length: r.between(0, 20) }, (_, i) => ({
    t: r.chance(0.08) ? r.pick([null, undefined, NaN, 'abc', '']) : r.chance(0.5) ? t0 + Math.floor(r.next() * span) : new Date(t0 + Math.floor(r.next() * span)),
    i,
  }))
  const t: Record<string, unknown> = { type: 'timeunit', field: 't', timezone: r.pick(['utc', 'utc', 'local']) }
  const how = r.between(0, 2)
  if (how === 0) t.units = r.pick([['year'], ['year', 'month'], ['year', 'month', 'date'], ['year', 'month', 'date', 'hours'], ['month'], ['day'], ['week'], ['year', 'quarter'], ['hours', 'minutes']])
  if (how === 0 && r.chance(0.4)) t.step = r.pick([1, 2, 3, 6, 0])
  if (how === 1) t.maxbins = r.pick([2, 5, 10, 40, 100, 0, NaN])
  if (how === 2) t.inferUnits = true
  if (r.chance(0.2)) t.interval = false
  if (r.chance(0.3)) t.as = ['lo', 'hi']
  if (r.chance(0.3)) t.extent = r.pick([[t0, t0 + span], [NaN, NaN], [NaN, 5], [Infinity, 7], [t0 + span, t0]])
  t.signal = 'tu'
  return { t: [t], rows, publish: ['tu'] }
}

const SUITES: Array<{ name: string; seed: number; count: number; gen: (r: Rng) => Case; maxCrashShare: number }> = [
  { name: 'aggregate', seed: 0xa601, count: 700, gen: (r) => genAggregateLike(r, 'aggregate'), maxCrashShare: 0.02 },
  { name: 'joinaggregate', seed: 0xa602, count: 350, gen: (r) => genAggregateLike(r, 'joinaggregate'), maxCrashShare: 0.02 },
  { name: 'window', seed: 0xa603, count: 900, gen: genWindow, maxCrashShare: 0.2 },
  { name: 'window stores over several fields', seed: 0xa60b, count: 500, gen: genWindowStores, maxCrashShare: 0.02 },
  { name: 'transform chains', seed: 0xa60c, count: 900, gen: genChain, maxCrashShare: 0.2 },
  { name: 'pivot', seed: 0xa604, count: 300, gen: genPivot, maxCrashShare: 0.02 },
  { name: 'bin', seed: 0xa605, count: 700, gen: genBin, maxCrashShare: 0.02 },
  { name: 'stack', seed: 0xa606, count: 350, gen: genStack, maxCrashShare: 0.02 },
  { name: 'impute', seed: 0xa607, count: 350, gen: genImpute, maxCrashShare: 0.02 },
  { name: 'lookup', seed: 0xa608, count: 350, gen: genLookup, maxCrashShare: 0.02 },
  { name: 'fold/flatten/project/identifier', seed: 0xa609, count: 300, gen: genReshape, maxCrashShare: 0.02 },
  { name: 'timeunit', seed: 0xa60a, count: 250, gen: genTimeunit, maxCrashShare: 0.02 },
]

describe('generated transform differential vs real Vega (live, same engine)', { timeout: 300_000 }, () => {
  for (const s of SUITES) {
    it(`${s.name}: ${scaled(s.count)} seeded cases`, async () => {
      const r = makeRng(s.seed)
      const tally: Tally = { cases: 0, compared: 0, threw: 0, crashed: 0, draws: 0 }
      const bad: string[] = []
      let failures = 0
      const prevTz = process.env.TZ
      process.env.TZ = 'UTC'
      try {
        for (let i = 0, n = scaled(s.count); i < n; i++) {
          const c = s.gen(r)
          const tz = s.name === 'timeunit' && (c.t[0] as { timezone?: string }).timezone === 'local' ? 'Asia/Kolkata' : 'UTC'
          process.env.TZ = tz
          if (process.env.ASTER_GEN_SHOW === `${s.name}#${i}`) {
            const [w, a] = [await runVega(c), runAster(c, false)]
            const dump = (v: unknown): string => {
              const seen = new WeakSet<object>()
              return JSON.stringify(v, (_k, x) => {
                if (typeof x === 'number' && !Number.isFinite(x)) return String(x)
                if (x && typeof x === 'object') { if (seen.has(x)) return '[cycle]'; seen.add(x) }
                return x
              })
            }
            console.log('CASE', dump({ t: c.t, signals: c.signals, extra: c.extra, rows: c.rows }))
            console.log('VEGA', dump(w.error ? String(w.error) : w.out))
            console.log('ASTER', dump(a.error ? String(a.error) : a.out))
          }
          const why = await check(c, tally)
          if (why) {
            failures++
            if (bad.length < 4) bad.push(`  #${i} [${tz}] ${why}\n     t    ${JSON.stringify(c.t).slice(0, 400)}\n     rows ${JSON.stringify(c.rows, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)).slice(0, 500)}`)
          }
        }
      } finally {
        if (prevTz === undefined) delete process.env.TZ
        else process.env.TZ = prevTz
      }
      if (failures) throw new Error(`${s.name}: ${failures}/${tally.cases} cases differ from vega (seed 0x${s.seed.toString(16)})\n${bad.join('\n')}`)
      // the generator must exercise the transform, not mostly be refused or skipped
      expect(tally.compared, `${s.name} compared ${tally.compared} of ${tally.cases} (threw ${tally.threw}, vega crashed ${tally.crashed})`).toBeGreaterThan(tally.cases * 0.6)
      expect(tally.crashed, `vega crashed on ${tally.crashed} of ${tally.cases}`).toBeLessThanOrEqual(Math.ceil(tally.cases * s.maxCrashShare))
      if (s.name === 'aggregate' || s.name === 'joinaggregate') expect(tally.draws, 'ci0/ci1 must draw from the source').toBeGreaterThan(0)
    })
  }
})
