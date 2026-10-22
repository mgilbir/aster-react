/**
 * Records TRANSFORM-level oracle vectors: (transform params + input rows) ->
 * output rows, captured by running the pinned real Vega (vega 6.3.1, i.e.
 * vega-transforms / vega-encode / vega-statistics / vega-regression /
 * vega-hierarchy ...) on a one-dataset dataflow, written to
 * `packages/core/testdata/transform-vectors/vega-transforms*.json`.
 *
 * `gen-vectors.mjs` pins the helper libraries one function at a time; this
 * generator pins the whole transform layer at the level the engine consumes it:
 *
 *     data: [{ name: 'src', values: <rows>, transform: [<params>...] }]
 *
 * The replay (`packages/core/src/transform-vectors.test.ts`) feeds the same
 * params + rows to `applyTransforms` and demands the same rows back, strictly:
 * NaN, -0, undefined-valued keys, Dates, row order and thrown errors included.
 *
 * Inputs are deliberately odd: numeric strings, null/undefined/NaN/Infinity,
 * Dates, empty groups, nested field paths (`a.b`, `a\.b`, `a[0]`), omitted
 * params (Vega's defaults for `as`, `ops`, `offset`, `sort`, ...), ties and
 * stable order. Random cases come from a seeded PRNG so the file is
 * reproducible byte-for-byte.
 *
 * Randomness: Vega's bootstrap (ci0/ci1), sample and a few statistics draw from
 * `vega-statistics`' global `random`. We pin it to the seeded LCG that
 * vega-statistics ships (`randomLCG`) at the start of every case, so those cases
 * are exact vectors too; Aster uses the same LCG with the same fixed seed per
 * evaluation (a deliberate, documented deviation from Vega's `Math.random`:
 * incremental evaluation must equal a fresh one).
 *
 *   pnpm --filter @aster/conformance run vectors:transforms
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ = 'UTC'

const here = dirname(fileURLToPath(import.meta.url))
const req = createRequire(join(here, '..', 'package.json'))
const vega = await import(req.resolve('vega'))

/** Seed for every random draw inside a recorded case (mirrored in the engine). */
export const SEED = 42

// --- value codec (mirrors gen-vectors.mjs; Date NaN is kept) -------------------
// Cycles are real: joinaggregate/window `argmin`/`values` write the tuple (or an
// array containing it) back onto the tuple. A back-reference to an ancestor is
// recorded as { $: 'cycle', up: n } (n levels up the encoding stack).
function enc(v, stack = []) {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return { $: 'date', ms: Number.isNaN(v.getTime()) ? null : v.getTime() }
  if (v instanceof RegExp) return { $: 're', src: v.source, flags: v.flags }
  if (typeof v === 'bigint') return { $: 'bigint', v: String(v) }
  if (typeof v === 'function') return { $: 'fn' }
  if (v !== null && typeof v === 'object') {
    const at = stack.indexOf(v)
    if (at >= 0) return { $: 'cycle', up: stack.length - at }
    stack.push(v)
    let out
    if (Array.isArray(v)) out = v.map((x) => enc(x, stack))
    else {
      out = {}
      for (const k of Object.keys(v)) out[k] = enc(v[k], stack)
    }
    stack.pop()
    return out
  }
  return v
}

/** Deep structural clone that keeps Dates, NaN, undefined, -0 (structuredClone does). */
const clone = (v) => structuredClone(v)

// --- seeded PRNG for case construction (NOT the engine's LCG) -------------------
function mulberry32(seed) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260101)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

// --- running real Vega ---------------------------------------------------------

/**
 * Run `transforms` over `rows` in real Vega. `extra` datasets are declared
 * first (for lookup/cross-style references). `signals` names are read back.
 */
async function runVega(rows, transforms, { extra = {}, signals = [] } = {}) {
  const data = []
  for (const [name, v] of Object.entries(extra)) data.push({ name, values: clone(v) })
  data.push({ name: 'src', values: clone(rows), transform: clone(transforms) })
  const errors = []
  let view
  try {
    vega.setRandom(vega.randomLCG(SEED))
    const spec = { data }
    view = new vega.View(vega.parse(spec), { renderer: 'none', logLevel: vega.None })
  } catch (err) {
    return { throw: err }
  }
  view.logger({
    level() { return 1 },
    error(...a) { errors.push(a.map((x) => (x && x.message) || String(x)).join(' ')); return this },
    warn() { return this }, info() { return this }, debug() { return this },
  })
  try {
    await view.runAsync()
  } catch (err) {
    return { throw: err }
  }
  if (errors.length) return { throw: new Error(errors[0].replace(/^Error: /, '')) }
  const out = view.data('src')
  const sig = {}
  for (const s of signals) sig[s] = view.signal(s)
  return { out, sig }
}

const suites = {}
let totalCases = 0
const pending = []
const dropped = []

/**
 * Register a case. `t` is one transform or an array (a chain). Options:
 *   extra   datasets by name        signals  signal names to capture
 *   tz      zone to record under    approx   relative tolerance for numerics
 */
function add(suite, name, t, rows, opt = {}) {
  pending.push({ suite, name, t: Array.isArray(t) ? t : [t], rows, opt })
}

async function flush() {
  for (const { suite, name, t, rows, opt } of pending) {
    if (opt.tz) process.env.TZ = opt.tz
    else process.env.TZ = 'UTC'
    const res = await runVega(rows, t, opt)
    // A few inputs crash real Vega with an incidental TypeError (a window range
    // frame that starts past the last row; dotbin on an empty source). Those are
    // Vega bugs, not semantics worth pinning: dropped, not replicated.
    if ((opt.dropOnCrash || suite === 'window') && res.throw && /Cannot read properties|is not a function/.test(String(res.throw.message))) {
      dropped.push(`${suite} / ${name}: ${res.throw.message}`)
      continue
    }
    let c
    try {
    c = {
      name,
      transform: enc(t),
      rows: enc(rows),
    }
    if (opt.extra) c.extra = Object.fromEntries(Object.entries(opt.extra).map(([k, v]) => [k, enc(v)]))
    if (opt.signals) c.signals = opt.signals
    if (opt.approx) c.approx = opt.approx
    if (opt.tz) c.tz = opt.tz
    if (res.throw) {
      c.want = { $: 'throw', message: String(res.throw.message ?? res.throw) }
    } else {
      c.want = enc(res.out)
      if (opt.signals) c.wantSignals = Object.fromEntries(opt.signals.map((s) => [s, enc(res.sig[s])]))
    }
    } catch (err) { throw new Error(`case ${suite} / ${name}: ${err.message}`) }
    ;(suites[suite] ??= []).push(c)
    totalCases++
  }
  process.env.TZ = 'UTC'
}

// ============================================================================
// shared input pools
// ============================================================================

const D = (s) => new Date(s)
/** Values that stress coercion: numeric strings, nulls, NaN, Infinity, Dates, ... */
const ODD = [
  0, 1, -1, 2.5, 1e21, '7', ' 8 ', '1e2', '0x10', '', 'abc', 'true', null, undefined, NaN, Infinity, -Infinity,
  true, false, D('2020-03-15T12:34:56.789Z'), D('1999-12-31T23:59:59.000Z'), new Date(NaN), [3], [], -0,
]
const NUMS = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]
const GROUPS = ['a', 'b', 'c', null, undefined, NaN, 1, '1', 0, '', true]

function mkRows(n, valuePool, groupPool = ['a', 'b', 'c']) {
  const rows = []
  for (let i = 0; i < n; i++) rows.push({ g: pick(groupPool), v: pick(valuePool), w: pick(NUMS), i })
  return rows
}

const OPS = [
  'count', 'valid', 'missing', 'distinct', 'sum', 'product', 'mean', 'average', 'variance', 'variancep',
  'stdev', 'stdevp', 'stderr', 'median', 'q1', 'q3', 'min', 'max', 'argmin', 'argmax', 'values',
  'exponential', 'exponentialb', 'ci0', 'ci1',
]
const AGG_OPS = OPS.filter((o) => o !== 'exponential' && o !== 'exponentialb')

// ============================================================================
// aggregate
// ============================================================================
{
  const S = 'aggregate'
  const clean = NUMS.map((v, i) => ({ g: i % 3 === 0 ? 'x' : 'y', v, i }))
  for (const op of OPS) {
    const ap = op.startsWith('exponential') ? { aggregate_params: [0.5] } : {}
    const single = (rows, extra = {}) => ({ type: 'aggregate', fields: op === 'count' ? [null] : ['v'], ops: [op], ...ap, ...extra })
    const chk = {}
    add(S, `${op}: clean numbers, no groupby`, single(), clean, chk)
    add(S, `${op}: clean numbers, groupby g`, single(0, { groupby: ['g'] }), clean, chk)
    add(S, `${op}: empty input`, single(), [])
    add(S, `${op}: all-null group`, single(0, { groupby: ['g'] }), [{ g: 'a', v: null }, { g: 'a', v: undefined }, { g: 'b', v: 2 }], chk)
    add(S, `${op}: NaN and empty-string values`, single(), [{ v: NaN }, { v: '' }, { v: 3 }, { v: 4 }], chk)
    add(S, `${op}: numeric strings`, single(), [{ v: '10' }, { v: '9' }, { v: '2.5' }, { v: 1 }], chk)
    add(S, `${op}: Dates`, single(), [{ v: D('2020-01-01') }, { v: D('2019-06-01') }, { v: D('2021-02-02') }, { v: D('2019-06-01') }], chk)
    add(S, `${op}: Infinity`, single(), [{ v: 1 }, { v: Infinity }, { v: 2 }, { v: -Infinity }], chk)
    add(S, `${op}: ties`, single(0, { groupby: ['g'] }), [{ g: 1, v: 5, i: 0 }, { g: 1, v: 5, i: 1 }, { g: 1, v: 2, i: 2 }, { g: 1, v: 2, i: 3 }], chk)
    add(S, `${op}: single value`, single(0, { groupby: ['g'] }), [{ g: 'a', v: 7 }], chk)
    add(S, `${op}: as given`, single(0, { as: ['out'] }), clean, chk)
    add(S, `${op}: nested field a.b`, { type: 'aggregate', fields: [op === 'count' ? null : 'a.b'], ops: [op], ...ap }, clean.map((r) => ({ a: { b: r.v }, 'a.b': -1 })), chk)
    add(S, `${op}: escaped dot a\\.b`, { type: 'aggregate', fields: [op === 'count' ? null : 'a\\.b'], ops: [op], ...ap }, clean.map((r) => ({ a: { b: r.v }, 'a.b': r.v * 10 })), chk)
    add(S, `${op}: array index a[1]`, { type: 'aggregate', fields: [op === 'count' ? null : 'a[1]'], ops: [op], ...ap }, clean.map((r) => ({ a: [0, r.v] })), chk)
    for (let k = 0; k < 4; k++) {
      add(S, `${op}: odd values #${k}`, single(0, { groupby: ['g'] }), mkRows(int(3, 14), ODD, ['a', 'b']), chk)
    }
  }
  // one transform carrying every op over the same / different fields
  add(S, 'all ops, shared field, groupby g', { type: 'aggregate', groupby: ['g'], fields: AGG_OPS.map((o) => (o === 'count' ? null : 'v')), ops: AGG_OPS }, clean)
  add(S, 'all ops, one field each', { type: 'aggregate', groupby: ['g'], fields: AGG_OPS.map((o, i) => (o === 'count' ? null : i % 2 ? 'v' : 'w')), ops: AGG_OPS, as: AGG_OPS.map((o, i) => `${o}_${i}`) }, clean.map((r) => ({ ...r, w: r.v * 2 })))
  // defaults
  add(S, 'omitted: no fields/ops -> count', { type: 'aggregate' }, clean)
  add(S, 'omitted: groupby only -> count', { type: 'aggregate', groupby: ['g'] }, clean)
  add(S, 'omitted: ops only', { type: 'aggregate', ops: ['count'] }, clean)
  add(S, 'omitted: as -> op_field naming', { type: 'aggregate', groupby: ['g'], fields: ['v', 'w', null], ops: ['sum', 'max', 'count'] }, clean.map((r) => ({ ...r, w: r.v + 1 })))
  add(S, 'as with holes', { type: 'aggregate', groupby: ['g'], fields: ['v', 'v', 'v'], ops: ['sum', 'min', 'max'], as: ['s', null, 'm'] }, clean)
  add(S, 'as null/undefined', { type: 'aggregate', fields: ['v', 'v'], ops: ['sum', 'mean'], as: [null, ''] }, clean)
  add(S, 'two count ops', { type: 'aggregate', groupby: ['g'], ops: ['count', 'count'], as: ['c1', 'c2'], fields: [null, null] }, clean)
  add(S, 'count with a field', { type: 'aggregate', groupby: ['g'], ops: ['count'], fields: ['v'] }, clean)
  // groupby shapes
  add(S, 'groupby two fields', { type: 'aggregate', groupby: ['g', 'h'], fields: ['v'], ops: ['sum'] }, clean.map((r, i) => ({ ...r, h: i % 2 ? 'p' : 'q' })))
  add(S, 'groupby odd keys', { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, GROUPS.map((g, i) => ({ g, v: i + 1 })))
  add(S, 'groupby 1 and "1" collide', { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, [{ g: 1, v: 1 }, { g: '1', v: 2 }, { g: 1, v: 4 }])
  add(S, 'groupby null/undefined/NaN collide as strings', { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['count'] }, [{ g: null, v: 1 }, { g: undefined, v: 2 }, { g: 'null', v: 3 }, { g: NaN, v: 4 }, { g: 'NaN', v: 5 }])
  add(S, 'groupby Dates', { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, [{ g: D('2020-01-01'), v: 1 }, { g: D('2020-01-01'), v: 2 }, { g: D('2020-01-02'), v: 3 }])
  add(S, 'groupby multi-field key pipe collision', { type: 'aggregate', groupby: ['g', 'h'], ops: ['count'] }, [{ g: 'a|b', h: 'c' }, { g: 'a', h: 'b|c' }, { g: 'a|b', h: 'c' }])
  add(S, 'groupby nested', { type: 'aggregate', groupby: ['a.b'], fields: ['v'], ops: ['sum'] }, clean.map((r) => ({ a: { b: r.g }, v: r.v })))
  add(S, 'groupby integer-like keys keep insertion order', { type: 'aggregate', groupby: ['g'], ops: ['count'] }, [{ g: 'b' }, { g: 10 }, { g: 2 }, { g: 'a' }, { g: 1 }])
  add(S, 'groupby missing field everywhere', { type: 'aggregate', groupby: ['nope'], ops: ['count'] }, clean)
  // cross / drop / key
  const crossRows = [{ a: 'x', b: 1, v: 1 }, { a: 'y', b: 2, v: 2 }, { a: 'x', b: 2, v: 3 }]
  add(S, 'cross: full cross-product', { type: 'aggregate', groupby: ['a', 'b'], fields: ['v'], ops: ['sum'], cross: true }, crossRows)
  add(S, 'cross: three dims', { type: 'aggregate', groupby: ['a', 'b', 'c'], ops: ['count'], cross: true }, [{ a: 'x', b: 1, c: 'p' }, { a: 'y', b: 2, c: 'q' }, { a: 'x', b: 10, c: 'q' }])
  add(S, 'cross: one dim is ignored', { type: 'aggregate', groupby: ['a'], ops: ['count'], cross: true }, crossRows)
  add(S, 'cross: integer-like domain order', { type: 'aggregate', groupby: ['a', 'b'], ops: ['count'], cross: true }, [{ a: 'x', b: 10 }, { a: 'y', b: 2 }, { a: 'z', b: 1 }])
  add(S, 'drop false', { type: 'aggregate', groupby: ['a'], ops: ['count'], drop: false }, crossRows)
  add(S, 'key accessor replaces group key', { type: 'aggregate', groupby: ['a'], ops: ['count'], key: 'b' }, crossRows)
  // errors
  add(S, 'error: unmatched fields/ops', { type: 'aggregate', fields: ['v'], ops: ['sum', 'max'] }, clean)
  add(S, 'error: null field with sum', { type: 'aggregate', fields: [null], ops: ['sum'] }, clean)
  add(S, 'error: unknown op', { type: 'aggregate', fields: ['v'], ops: ['frobnicate'] }, clean)
  // exponential without param (VL emits none)
  add(S, 'exponential without aggregate_params', { type: 'aggregate', fields: ['v'], ops: ['exponential', 'exponentialb'] }, clean)
  add(S, 'exponential with params 0.9 and sparse', { type: 'aggregate', groupby: ['g'], fields: ['v', 'v'], ops: ['exponential', 'exponentialb'], aggregate_params: [0.9, 0.3] }, clean)
  // many random mixed aggregates
  for (let k = 0; k < 40; k++) {
    const n = int(1, 12)
    const nOps = int(1, 4)
    const ops = Array.from({ length: nOps }, () => pick(AGG_OPS.filter((o) => o !== 'ci0' && o !== 'ci1')))
    const fields = ops.map((o) => (o === 'count' ? null : pick(['v', 'w'])))
    add(S, `random mix #${k}`, { type: 'aggregate', groupby: rnd() < 0.7 ? ['g'] : [], fields, ops }, mkRows(n, rnd() < 0.5 ? ODD : [1, 2, 3, null, 4.5, '6', NaN], rnd() < 0.5 ? GROUPS : ['a', 'b']))
  }
}

// ============================================================================
// joinaggregate
// ============================================================================
{
  const S = 'joinaggregate'
  const base = NUMS.map((v, i) => ({ g: i % 3 === 0 ? 'x' : 'y', v, i }))
  for (const op of AGG_OPS.concat(['exponential', 'exponentialb'])) {
    const f = op === 'count' ? null : 'v'
    const ap = op.startsWith('exponential') ? { aggregate_params: [0.5] } : {}
    const chk = {}
    add(S, `${op}: groupby g`, { type: 'joinaggregate', groupby: ['g'], fields: [f], ops: [op], ...ap }, base, chk)
    add(S, `${op}: no groupby`, { type: 'joinaggregate', fields: [f], ops: [op], ...ap }, base, chk)
    add(S, `${op}: odd values`, { type: 'joinaggregate', groupby: ['g'], fields: [f], ops: [op], ...ap }, mkRows(int(3, 10), ODD, ['a', 'b']), chk)
    add(S, `${op}: as given`, { type: 'joinaggregate', fields: [f], ops: [op], as: ['out'], ...ap }, base, chk)
  }
  add(S, 'omitted: no fields/ops -> count', { type: 'joinaggregate', groupby: ['g'] }, base)
  add(S, 'omitted: nothing at all', { type: 'joinaggregate' }, base)
  add(S, 'nested groupby and field', { type: 'joinaggregate', groupby: ['a.g'], fields: ['a.v'], ops: ['mean'] }, base.map((r) => ({ a: { g: r.g, v: r.v } })))
  add(S, 'groupby odd keys', { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, GROUPS.map((g, i) => ({ g, v: i + 1 })))
  add(S, 'groupby 1/"1" collide: first dim value wins on write-back', { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, [{ g: 1, v: 1 }, { g: '1', v: 2 }, { g: 1, v: 4 }])
  add(S, 'key accessor', { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], key: 'i' }, base)
  add(S, 'two fields two ops', { type: 'joinaggregate', groupby: ['g'], fields: ['v', 'i'], ops: ['mean', 'max'], as: ['m', 'x'] }, base)
  add(S, 'count and max over same group', { type: 'joinaggregate', groupby: ['g'], fields: [null, 'v'], ops: ['count', 'max'] }, base)
  add(S, 'overwrites an input field', { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['v'] }, base)
  add(S, 'empty input', { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] }, [])
  add(S, 'error: null field with sum', { type: 'joinaggregate', fields: [null], ops: ['sum'] }, base)
  for (let k = 0; k < 20; k++) {
    const ops = Array.from({ length: int(1, 3) }, () => pick(AGG_OPS.filter((o) => o !== 'ci0' && o !== 'ci1')))
    add(S, `random mix #${k}`, { type: 'joinaggregate', groupby: rnd() < 0.6 ? ['g'] : [], fields: ops.map((o) => (o === 'count' ? null : pick(['v', 'w']))), ops }, mkRows(int(1, 10), rnd() < 0.5 ? ODD : [1, 2, null, 4.5, '6'], rnd() < 0.5 ? GROUPS : ['a', 'b']))
  }
}

// ============================================================================
// window
// ============================================================================
{
  const S = 'window'
  const base = [
    { g: 'a', v: 3, k: 1 }, { g: 'a', v: 1, k: 2 }, { g: 'b', v: 2, k: 2 }, { g: 'a', v: 3, k: 3 },
    { g: 'b', v: 5, k: 1 }, { g: 'a', v: null, k: 4 }, { g: 'b', v: 2, k: 5 }, { g: 'b', v: 9, k: 5 },
  ]
  const WOPS = ['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value', 'prev_value', 'next_value']
  const wparams = { ntile: 3, lag: 2, lead: 2, nth_value: 2 }
  for (const op of WOPS.concat(AGG_OPS)) {
    const f = ['count', 'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile'].includes(op) ? null : 'v'
    const chk = {}
    const params = op in wparams ? { params: [wparams[op]] } : {}
    const mk = (extra) => ({ type: 'window', fields: [f], ops: [op], ...params, ...extra })
    add(S, `${op}: sorted by v, groupby g`, mk({ sort: { field: 'v' }, groupby: ['g'] }), base, chk)
    add(S, `${op}: sorted by k desc, no groupby`, mk({ sort: { field: 'k', order: 'descending' } }), base, chk)
    add(S, `${op}: no sort`, mk({ groupby: ['g'] }), base, chk)
    add(S, `${op}: frame [-1,1]`, mk({ sort: { field: 'k' }, frame: [-1, 1] }), base, chk)
    add(S, `${op}: frame [null,null]`, mk({ sort: { field: 'k' }, frame: [null, null] }), base, chk)
    add(S, `${op}: frame [0,null] groupby`, mk({ sort: { field: 'k' }, groupby: ['g'], frame: [0, null] }), base, chk)
    add(S, `${op}: frame [-2,0] ignorePeers`, mk({ sort: { field: 'v' }, frame: [-2, 0], ignorePeers: true }), base, chk)
    add(S, `${op}: frame [1,2] (future only)`, mk({ sort: { field: 'k' }, frame: [1, 2] }), base, { ...chk, dropOnCrash: true })
    add(S, `${op}: empty input`, mk({ sort: { field: 'k' } }), [], chk)
    add(S, `${op}: odd values`, mk({ sort: { field: 'k' }, groupby: ['g'] }), mkRows(int(3, 9), ODD, ['a', 'b']).map((r, i) => ({ ...r, k: i % 4 })), chk)
  }
  add(S, 'omitted: no ops -> nothing', { type: 'window', sort: { field: 'k' } }, base)
  add(S, 'omitted: as naming (op_field)', { type: 'window', fields: ['v', 'v', null], ops: ['sum', 'lag', 'row_number'], sort: { field: 'k' } }, base)
  add(S, 'sort multi-field with orders', { type: 'window', fields: [null], ops: ['rank'], sort: { field: ['g', 'v'], order: ['descending', 'ascending'] } }, base)
  add(S, 'sort ties are stable', { type: 'window', fields: [null], ops: ['row_number'], sort: { field: 'k' } }, base)
  add(S, 'sort with nulls, NaN, undefined, strings', { type: 'window', fields: [null], ops: ['row_number'], sort: { field: 'v' } }, [{ v: 3 }, { v: null }, { v: NaN }, { v: undefined }, { v: '10' }, { v: 2 }, { v: D('2020-01-01') }, { v: '' }])
  add(S, 'sort descending with nulls', { type: 'window', fields: [null], ops: ['row_number'], sort: { field: 'v', order: 'descending' } }, [{ v: 3 }, { v: null }, { v: 1 }, { v: undefined }, { v: 7 }])
  add(S, 'nested sort/field/groupby', { type: 'window', groupby: ['a.g'], sort: { field: 'a.k' }, fields: ['a.v'], ops: ['sum'] }, base.map((r) => ({ a: { ...r } })))
  add(S, 'groupby odd keys', { type: 'window', groupby: ['g'], sort: { field: 'k' }, fields: ['v'], ops: ['sum'] }, GROUPS.map((g, i) => ({ g, k: i, v: i })))
  add(S, 'two aggregates sharing a field + window op', { type: 'window', sort: { field: 'k' }, fields: ['v', 'v', null], ops: ['sum', 'max', 'rank'], frame: [-2, 0] }, base)
  add(S, 'lag/lead default offset', { type: 'window', sort: { field: 'k' }, fields: ['v', 'v'], ops: ['lag', 'lead'] }, base)
  add(S, 'lag/lead offset 0 -> 1', { type: 'window', sort: { field: 'k' }, fields: ['v', 'v'], ops: ['lag', 'lead'], params: [0, 0] }, base)
  add(S, 'lag with null params entry', { type: 'window', sort: { field: 'k' }, fields: ['v', 'v'], ops: ['lag', 'lead'], params: [null, 2] }, base)
  add(S, 'error: ntile 0', { type: 'window', sort: { field: 'k' }, ops: ['ntile'], fields: [null], params: [0] }, base)
  add(S, 'error: nth_value 0', { type: 'window', sort: { field: 'k' }, ops: ['nth_value'], fields: ['v'], params: [0] }, base)
  add(S, 'error: null field with sum', { type: 'window', ops: ['sum'], fields: [null] }, base)
  add(S, 'exponential in window', { type: 'window', sort: { field: 'k' }, ops: ['exponential', 'exponentialb'], fields: ['v', 'v'], aggregate_params: [0.5, 0.5], frame: [-3, 0] }, base)
  add(S, 'running sum default frame', { type: 'window', sort: { field: 'k' }, ops: ['sum'], fields: ['v'], groupby: ['g'] }, base)
  add(S, 'running min/max with removals (sliding)', { type: 'window', sort: { field: 'k' }, ops: ['min', 'max', 'median', 'q1', 'q3', 'distinct', 'argmin', 'argmax', 'values'], fields: ['v', 'v', 'v', 'v', 'v', 'v', 'v', 'v', 'v'], frame: [-2, 0] }, base)
  add(S, 'sliding mean/variance (Welford removal)', { type: 'window', sort: { field: 'k' }, ops: ['mean', 'variance', 'stdev', 'stdevp', 'variancep', 'stderr', 'sum', 'product'], fields: ['v', 'v', 'v', 'v', 'v', 'v', 'v', 'v'], frame: [-2, 1] }, NUMS.map((v, k) => ({ v, k })))
  for (let k = 0; k < 40; k++) {
    const nOps = int(1, 3)
    const ops = Array.from({ length: nOps }, () => pick(WOPS.concat(AGG_OPS.filter((o) => o !== 'ci0' && o !== 'ci1'))))
    const fields = ops.map((o) => (['count', 'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile'].includes(o) ? null : 'v'))
    const params = ops.map((o) => (o in wparams ? wparams[o] : null))
    const frame = pick([undefined, [null, 0], [-1, 1], [null, null], [-2, 0], [0, 2], [1, null]])
    add(S, `random mix #${k}`, { type: 'window', groupby: rnd() < 0.5 ? ['g'] : [], sort: rnd() < 0.8 ? { field: pick(['k', 'v']), order: pick(['ascending', 'descending']) } : undefined, fields, ops, params, ...(frame ? { frame } : {}), ignorePeers: rnd() < 0.2 },
      mkRows(int(1, 10), rnd() < 0.5 ? ODD : [1, 2, 2, null, 4.5], ['a', 'b']).map((r, i) => ({ ...r, k: i % 5 })))
  }
}

// ============================================================================
// pivot
// ============================================================================
{
  const S = 'pivot'
  const base = [
    { g: 'a', k: 'x', v: 1 }, { g: 'a', k: 'y', v: 2 }, { g: 'b', k: 'x', v: 3 }, { g: 'a', k: 'x', v: 4 },
    { g: 'b', k: 'z', v: 5 }, { g: 'c', k: 'y', v: null },
  ]
  for (const op of AGG_OPS.concat(['exponential'])) {
    const chk = {}
    add(S, `${op}: groupby g`, { type: 'pivot', field: 'k', value: 'v', op, groupby: ['g'] }, base, chk)
    add(S, `${op}: no groupby`, { type: 'pivot', field: 'k', value: 'v', op }, base, chk)
    add(S, `${op}: odd values`, { type: 'pivot', field: 'k', value: 'v', op, groupby: ['g'] }, mkRows(int(3, 10), ODD, ['a', 'b']).map((r) => ({ ...r, k: pick(['x', 'y', 'z']) })), chk)
  }
  add(S, 'omitted op -> sum', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'] }, base)
  add(S, 'limit', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'], limit: 2 }, base)
  add(S, 'limit larger than keys', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'], limit: 10 }, base)
  add(S, 'key accessor', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'], key: 'g' }, base)
  add(S, 'pivot keys sorted ascending incl mixed', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'] }, [{ g: 1, k: 'b', v: 1 }, { g: 1, k: 10, v: 2 }, { g: 1, k: 2, v: 3 }, { g: 1, k: null, v: 4 }, { g: 1, k: 'a', v: 5 }, { g: 1, k: undefined, v: 6 }])
  add(S, 'pivot keys numeric names', { type: 'pivot', field: 'k', value: 'v' }, [{ k: 1, v: 1 }, { k: 2, v: 2 }, { k: 1, v: 3 }])
  add(S, 'pivot keys Dates', { type: 'pivot', field: 'k', value: 'v' }, [{ k: D('2020-01-01'), v: 1 }, { k: D('2020-02-01'), v: 2 }])
  add(S, 'nested paths', { type: 'pivot', field: 'a.k', value: 'a.v', groupby: ['a.g'] }, base.map((r) => ({ a: { ...r } })))
  add(S, 'empty input', { type: 'pivot', field: 'k', value: 'v' }, [])
  add(S, 'all groups missing a key', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'], op: 'count' }, base)
  add(S, 'count counts matching rows only', { type: 'pivot', field: 'k', value: 'v', op: 'count' }, base)
  add(S, 'values op', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'], op: 'values' }, base)
  add(S, 'key name collides with groupby field', { type: 'pivot', field: 'k', value: 'v', groupby: ['g'] }, [{ g: 'a', k: 'g', v: 1 }, { g: 'a', k: 'x', v: 2 }])
  add(S, 'error: unknown op', { type: 'pivot', field: 'k', value: 'v', op: 'nope' }, base)
}

// ============================================================================
// bin
// ============================================================================
{
  const S = 'bin'
  const vals = [0, 1.5, 2.25, 3, 7.7, 9.99, 10, 10.01, -3, 55, 100, 12.5]
  const rows = vals.map((v, i) => ({ v, i }))
  const opts = [
    { maxbins: 10 }, { maxbins: 5 }, { maxbins: 20 }, { maxbins: 3 }, { step: 2 }, { step: 0.5 }, { step: 10 }, { base: 2, maxbins: 8 },
    { divide: [5, 2], maxbins: 7 }, { divide: [2], maxbins: 7 }, { divide: [3, 7], maxbins: 12 }, { minstep: 3, maxbins: 40 }, { nice: false, maxbins: 7 },
    { nice: false, step: 3 }, { anchor: 1.5, maxbins: 8 }, { anchor: -7, step: 5 }, { anchor: 0, maxbins: 4 }, { steps: [1, 2, 5], maxbins: 12 },
    { steps: [3, 4], maxbins: 30 }, { span: 50, maxbins: 5 }, { maxbins: 1 }, { maxbins: 0 }, { maxbins: 100000 }, { interval: false, maxbins: 6 }, { name: 'nm', maxbins: 6 },
    { as: ['lo', 'hi'], maxbins: 6 }, { as: ['only'], maxbins: 6 }, {},
  ]
  for (const o of opts) {
    for (const ext of [[0, 100], [-3, 100], [0, 10], [2.5, 2.5], [5, 5.0001], [0, 1], [-1e9, 1e9], [10, 0], [null, null]]) {
      if (ext.includes(null) && rnd() < 0.6) continue
      add(S, `extent ${JSON.stringify(ext)} ${JSON.stringify(o)}`, { type: 'bin', field: 'v', extent: ext, ...o }, rows)
    }
  }
  // Not recorded: `extent` omitted. Vega throws 'Missing required "bin" parameter: "extent"'; the engine
  // derives it from the data instead (documented extension, unit test in transform-semantics.test.ts).
  add(S, 'odd values', { type: 'bin', field: 'v', extent: [0, 100], maxbins: 10 }, ODD.map((v, i) => ({ v, i })))
  add(S, 'odd values interval false', { type: 'bin', field: 'v', extent: [0, 100], maxbins: 10, interval: false }, ODD.map((v, i) => ({ v, i })))
  add(S, 'values outside extent', { type: 'bin', field: 'v', extent: [10, 20], maxbins: 5 }, [5, 10, 14.99, 15, 20, 20.0001, 25, Infinity, -Infinity, NaN, null, undefined, '12', ''].map((v) => ({ v })))
  add(S, 'nested field', { type: 'bin', field: 'a.v', extent: [0, 100], maxbins: 10 }, rows.map((r) => ({ a: { v: r.v } })))
  add(S, 'escaped-dot field', { type: 'bin', field: 'a\\.v', extent: [0, 100], maxbins: 10 }, rows.map((r) => ({ 'a.v': r.v, a: { v: -1 } })))
  add(S, 'array field', { type: 'bin', field: 'a[0]', extent: [0, 100], maxbins: 10 }, rows.map((r) => ({ a: [r.v] })))
  add(S, 'empty input', { type: 'bin', field: 'v', extent: [0, 100], maxbins: 10 }, [])
  add(S, 'as defaults bin0/bin1', { type: 'bin', field: 'v', extent: [0, 100] }, rows)
  add(S, 'floating point agreement 0.1 steps', { type: 'bin', field: 'v', extent: [0, 1], step: 0.1 }, Array.from({ length: 12 }, (_, i) => ({ v: i / 10 })))
  add(S, 'Dates as values', { type: 'bin', field: 'v', extent: [0, 2e12], maxbins: 10 }, [{ v: D('2020-01-01') }, { v: D('1970-06-01') }])
  add(S, 'error: field omitted', { type: 'bin', extent: [0, 1] }, rows)
}

// ============================================================================
// collect / sort comparators
// ============================================================================
{
  const S = 'collect'
  const odd = [3, null, 1, undefined, NaN, '10', '9', 2, D('2020-01-01'), D('1999-01-01'), '', 'a', 'B', true, false, Infinity, -Infinity, 0, -0, '2', [1]]
  const rows = odd.map((v, i) => ({ v, i, g: i % 3, s: i % 2 ? 'x' : 'y' }))
  add(S, 'no sort keeps order', { type: 'collect' }, rows)
  add(S, 'sort ascending (nulls first in vega)', { type: 'collect', sort: { field: 'v' } }, rows)
  add(S, 'sort descending', { type: 'collect', sort: { field: 'v', order: 'descending' } }, rows)
  add(S, 'sort multi field', { type: 'collect', sort: { field: ['g', 'v'], order: ['descending', 'ascending'] } }, rows)
  add(S, 'sort multi field, order shorter than fields', { type: 'collect', sort: { field: ['s', 'g', 'i'], order: ['descending'] } }, rows)
  add(S, 'sort order unknown string', { type: 'collect', sort: { field: 'g', order: 'sideways' } }, rows)
  add(S, 'sort field array of one', { type: 'collect', sort: { field: ['v'] } }, rows)
  add(S, 'sort by missing field (all undefined) is stable', { type: 'collect', sort: { field: 'nope' } }, rows)
  add(S, 'sort ties are stable', { type: 'collect', sort: { field: 'g' } }, rows)
  add(S, 'sort ties are stable (descending)', { type: 'collect', sort: { field: 'g', order: 'descending' } }, rows)
  add(S, 'nested sort', { type: 'collect', sort: { field: 'a.v' } }, rows.map((r) => ({ a: { v: r.v }, i: r.i })))
  add(S, 'escaped dot sort', { type: 'collect', sort: { field: 'a\\.v' } }, rows.map((r) => ({ 'a.v': r.v, i: r.i })))
  add(S, 'array index sort', { type: 'collect', sort: { field: 'a[0]' } }, rows.map((r) => ({ a: [r.v], i: r.i })))
  add(S, 'strings', { type: 'collect', sort: { field: 'v' } }, ['b', 'a', 'B', 'A', 'ä', 'z', '', 'aa', 'a'].map((v, i) => ({ v, i })))
  add(S, 'numbers vs numeric strings', { type: 'collect', sort: { field: 'v' } }, [10, '9', 9, '10', '2', 2, 1].map((v, i) => ({ v, i })))
  add(S, 'empty', { type: 'collect', sort: { field: 'v' } }, [])
  add(S, 'single', { type: 'collect', sort: { field: 'v', order: 'descending' } }, [{ v: 1 }])
  for (let k = 0; k < 30; k++) {
    const n = int(2, 25)
    const rs = Array.from({ length: n }, (_, i) => ({ v: pick(odd), w: pick(NUMS), g: pick(['a', 'b', null]), i }))
    const nf = int(1, 3)
    add(S, `random sort #${k}`, { type: 'collect', sort: { field: Array.from({ length: nf }, () => pick(['v', 'w', 'g'])), order: Array.from({ length: nf }, () => pick(['ascending', 'descending'])) } }, rs)
  }
}

// ============================================================================
// filter / formula / identifier / project / fold / flatten / extent / sequence
// ============================================================================
{
  const S = 'filter'
  const rows = [{ v: 1 }, { v: 0 }, { v: null }, { v: '2' }, { v: NaN }, { v: undefined }, { v: '' }, { v: 'a' }]
  add(S, 'truthy', { type: 'filter', expr: 'datum.v' }, rows)
  add(S, 'comparison on odd values', { type: 'filter', expr: 'datum.v > 0' }, rows)
  add(S, 'isValid', { type: 'filter', expr: 'isValid(datum.v)' }, rows)
  add(S, 'nested', { type: 'filter', expr: 'datum.a.v > 1' }, [{ a: { v: 1 } }, { a: { v: 2 } }, { a: { v: 3 } }])
  add(S, 'all filtered out', { type: 'filter', expr: 'false' }, rows)
  add(S, 'error: expr omitted', { type: 'filter' }, rows)
}
{
  const S = 'formula'
  const rows = [{ v: 1 }, { v: 0 }, { v: null }, { v: '2' }, { v: NaN }, { v: undefined }, { v: 'a' }]
  add(S, 'basic', { type: 'formula', expr: 'datum.v * 2', as: 'd' }, rows)
  add(S, 'overwrite existing', { type: 'formula', expr: 'datum.v + 1', as: 'v' }, rows)
  add(S, 'as with dot is a literal key', { type: 'formula', expr: 'datum.v', as: 'a.b' }, rows)
  add(S, 'returns undefined', { type: 'formula', expr: 'datum.nope', as: 'u' }, rows)
  add(S, 'returns object', { type: 'formula', expr: '{a: datum.v}', as: 'o' }, rows)
  add(S, 'initonly', { type: 'formula', expr: 'datum.v * 3', as: 'd', initonly: true }, rows)
  add(S, 'error: as omitted', { type: 'formula', expr: 'datum.v' }, rows)
  add(S, 'chained formulas see earlier outputs', [{ type: 'formula', expr: 'datum.v * 2', as: 'a' }, { type: 'formula', expr: 'datum.a + 1', as: 'b' }], rows)
}
{
  const S = 'identifier'
  add(S, 'basic', { type: 'identifier', as: 'id' }, [{ v: 1 }, { v: 2 }, { v: 3 }])
  add(S, 'keeps an existing truthy id', { type: 'identifier', as: 'id' }, [{ id: 7 }, { id: 0 }, { id: null }, { id: '' }, { id: 'x' }, { v: 1 }])
  add(S, 'empty', { type: 'identifier', as: 'id' }, [])
  add(S, 'error: as omitted', { type: 'identifier' }, [{ v: 1 }])
}
{
  const S = 'project'
  const rows = [{ a: 1, b: { c: 2 }, 'd.e': 3, f: [4, 5], g: undefined, h: null }, { a: 6, b: { c: 7 }, 'd.e': 8, f: [9, 10] }]
  add(S, 'fields only', { type: 'project', fields: ['a'] }, rows)
  add(S, 'no fields copies everything', { type: 'project' }, rows)
  add(S, 'empty fields', { type: 'project', fields: [] }, rows)
  add(S, 'as renames', { type: 'project', fields: ['a', 'b.c'], as: ['x', 'y'] }, rows)
  add(S, 'as shorter than fields', { type: 'project', fields: ['a', 'b.c', 'f[1]'], as: ['x'] }, rows)
  add(S, 'as with null', { type: 'project', fields: ['a', 'b.c'], as: [null, 'y'] }, rows)
  add(S, 'nested field name is the path', { type: 'project', fields: ['b.c', 'f[0]', 'd\\.e'] }, rows)
  add(S, 'missing fields produce undefined keys', { type: 'project', fields: ['nope', 'g', 'h'] }, rows)
  add(S, 'as only', { type: 'project', as: ['x'] }, rows)
  add(S, 'empty input', { type: 'project', fields: ['a'] }, [])
  add(S, 'duplicate field', { type: 'project', fields: ['a', 'a'] }, rows)
}
{
  const S = 'fold'
  const rows = [{ k: 'a', x: 1, y: 2, z: null }, { k: 'b', x: 3, y: undefined }, { k: 'c', x: '5', y: NaN, z: 7 }]
  add(S, 'defaults key/value', { type: 'fold', fields: ['x', 'y'] }, rows)
  add(S, 'as given', { type: 'fold', fields: ['x', 'y', 'z'], as: ['kk', 'vv'] }, rows)
  add(S, 'as one name', { type: 'fold', fields: ['x', 'y'], as: ['kk'] }, rows)
  add(S, 'as overwrites input field', { type: 'fold', fields: ['x', 'y'], as: ['k', 'x'] }, rows)
  add(S, 'nested fields use the path as key', { type: 'fold', fields: ['a.x', 'a.y'] }, rows.map((r) => ({ a: { x: r.x, y: r.y } })))
  add(S, 'escaped dot', { type: 'fold', fields: ['a\\.x'] }, rows.map((r) => ({ 'a.x': r.x, a: { x: -1 } })))
  add(S, 'array index', { type: 'fold', fields: ['a[0]', 'a[1]'] }, rows.map((r) => ({ a: [r.x, r.y] })))
  add(S, 'missing field', { type: 'fold', fields: ['nope'] }, rows)
  add(S, 'no fields', { type: 'fold', fields: [] }, rows)
  add(S, 'empty input', { type: 'fold', fields: ['x'] }, [])
  add(S, 'error: fields omitted', { type: 'fold' }, rows)
}
{
  const S = 'flatten'
  const rows = [
    { id: 1, a: [1, 2, 3], b: ['x', 'y'] }, { id: 2, a: [], b: [] }, { id: 3, a: [4], b: ['z', 'w', 'q'] }, { id: 4, a: [null, undefined, 0], b: [1] },
  ]
  add(S, 'one field', { type: 'flatten', fields: ['a'] }, rows)
  add(S, 'two fields, ragged', { type: 'flatten', fields: ['a', 'b'] }, rows)
  add(S, 'as given', { type: 'flatten', fields: ['a', 'b'], as: ['aa', 'bb'] }, rows)
  add(S, 'as shorter than fields', { type: 'flatten', fields: ['a', 'b'], as: ['aa'] }, rows)
  add(S, 'index', { type: 'flatten', fields: ['a'], index: 'i' }, rows)
  add(S, 'index overwrites', { type: 'flatten', fields: ['a'], index: 'id' }, rows)
  add(S, 'nested field names', { type: 'flatten', fields: ['o.a'] }, rows.map((r) => ({ id: r.id, o: { a: r.a } })))
  add(S, 'array index field', { type: 'flatten', fields: ['o[0]'] }, rows.map((r) => ({ id: r.id, o: [r.a] })))
  add(S, 'strings flatten to characters', { type: 'flatten', fields: ['a'] }, [{ a: 'abc' }, { a: '' }])
  add(S, 'non-array number field yields no rows', { type: 'flatten', fields: ['a'] }, [{ a: 5 }, { a: [1] }])
  add(S, 'missing field throws', { type: 'flatten', fields: ['a'] }, [{ id: 1 }, { a: [1] }])
  add(S, 'null field throws', { type: 'flatten', fields: ['a'] }, [{ a: null }, { a: [1] }])
  add(S, 'second field not array', { type: 'flatten', fields: ['a', 'b'] }, [{ a: [1, 2], b: 3 }])
  add(S, 'array-likes (typed)', { type: 'flatten', fields: ['a'] }, [{ a: { length: 2, 0: 'p', 1: 'q' } }])
  add(S, 'empty input', { type: 'flatten', fields: ['a'] }, [])
  add(S, 'error: fields omitted', { type: 'flatten' }, rows)
}
{
  const S = 'extent'
  const sig = ['ex']
  const mk = (rows, f = 'v', extra = {}) => add(S, `${JSON.stringify(rows).slice(0, 70)} ${f}`, { type: 'extent', field: f, signal: 'ex', ...extra }, rows, { signals: sig })
  mk([{ v: 3 }, { v: 1 }, { v: 2 }])
  mk([{ v: '3' }, { v: '10' }, { v: 2 }])
  mk([{ v: null }, { v: undefined }, { v: NaN }, { v: '' }])
  mk([])
  mk([{ v: Infinity }, { v: 1 }])
  mk([{ v: -Infinity }, { v: Infinity }])
  mk([{ v: D('2020-01-01') }, { v: D('2019-01-01') }, { v: D('2021-01-01') }])
  mk([{ v: true }, { v: false }, { v: 'abc' }, { v: 4 }])
  mk([{ v: [5] }, { v: [1] }, { v: [] }])
  mk([{ v: 0 }, { v: -0 }])
  mk([{ a: { v: 3 } }, { a: { v: 8 } }, { a: { v: -1 } }], 'a.v')
  mk([{ 'a.v': 3, a: { v: 100 } }, { 'a.v': 8 }], 'a\\.v')
  mk([{ a: [3, 4] }, { a: [8, 1] }], 'a[1]')
  mk([{ v: 5 }], 'nope')
  mk([{ v: 5 }, { v: 5 }])
  for (let k = 0; k < 20; k++) mk(mkRows(int(0, 10), ODD))
}
{
  const S = 'sequence'
  const sig = []
  const src = [{ q: 1 }]
  for (const [start, stop, step] of [[0, 5, 1], [0, 5, 2], [5, 0, -1], [0, 1, 0.25], [0, 0, 1], [3, 1, 1], [1, 4, undefined], [0, 1, 0.1], [-2, 2, 1], [0, 3, 0], ['0', '3', '1'], [0, 3, NaN], [NaN, 3, 1], [0, Infinity, 1]]) {
    if (stop === Infinity) continue
    add(S, `sequence ${start},${stop},${step}`, { type: 'sequence', start, stop, ...(step !== undefined ? { step } : {}) }, [])
  }
  add(S, 'as given', { type: 'sequence', start: 0, stop: 3, as: 'k' }, [])
  add(S, 'appends to a non-empty source', { type: 'sequence', start: 0, stop: 3 }, src)
  add(S, 'as overwrites nothing (separate tuples)', { type: 'sequence', start: 0, stop: 2, as: 'q' }, src)
  add(S, 'fractional steps accumulate', { type: 'sequence', start: 0, stop: 1, step: 0.1 }, [])
  add(S, 'error: start omitted', { type: 'sequence', stop: 3 }, [])
}

// ============================================================================
// lookup
// ============================================================================
{
  const S = 'lookup'
  const lk = [
    { k: 'a', w: 1, u: 'x', nest: { z: 10 } }, { k: 'b', w: 2, u: 'y', nest: { z: 20 } }, { k: 'a', w: 99, u: 'last', nest: { z: 30 } },
    { k: 1, w: 'one', nest: { z: 1 } }, { k: '2', w: 'two', nest: {} }, { k: null, w: 'null', nest: { z: null } }, { k: undefined, w: 'undef', nest: { z: 5 } },
    { k: NaN, w: 'nan', nest: { z: 6 } }, { k: true, w: 'true', nest: { z: 7 } }, { k: D('2020-01-01'), w: 'date', nest: { z: 8 } },
  ]
  const keys = ['a', 'b', 'c', 1, '1', 2, '2', null, undefined, NaN, true, 'true', D('2020-01-01'), '', 0, '__proto__', 'constructor', 'toString']
  const rows = keys.map((k, i) => ({ f: k, i }))
  const ex = { lk }
  add(S, 'as defaults to fields (whole row)', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'] }, rows, { extra: ex })
  add(S, 'as given (whole row)', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['m'] }, rows, { extra: ex })
  add(S, 'values + as omitted -> value field names', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'] }, rows, { extra: ex })
  add(S, 'values + as given', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w', 'u'], as: ['mw', 'mu'] }, rows, { extra: ex })
  add(S, 'values nested', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['nest.z'], as: ['z'] }, rows, { extra: ex })
  add(S, 'values nested, as omitted', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['nest.z'] }, rows, { extra: ex })
  add(S, 'default value', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'], as: ['mw'], default: 'none' }, rows, { extra: ex })
  add(S, 'default 0 (falsy but not null)', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['m'], default: 0 }, rows, { extra: ex })
  add(S, 'default false', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['m'], default: false }, rows, { extra: ex })
  add(S, 'default null explicitly', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['m'], default: null }, rows, { extra: ex })
  add(S, 'overwrites the join key when as omitted', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['k'] }, rows, { extra: ex })
  add(S, 'two key fields, as required', { type: 'lookup', from: 'lk', key: 'k', fields: ['f', 'f2'], as: ['m1', 'm2'] }, rows.map((r) => ({ ...r, f2: 'b' })), { extra: ex })
  add(S, 'two key fields with values', { type: 'lookup', from: 'lk', key: 'k', fields: ['f', 'f2'], values: ['w', 'u'], as: ['a1', 'a2', 'b1', 'b2'] }, rows.map((r) => ({ ...r, f2: 'b' })), { extra: ex })
  add(S, 'nested key field in source and target', { type: 'lookup', from: 'lk2', key: 'o.k', fields: ['p.f'], values: ['w'] }, rows.map((r) => ({ p: { f: r.f } })), { extra: { lk2: lk.map((r) => ({ o: { k: r.k }, w: r.w })) } })
  add(S, 'array index key', { type: 'lookup', from: 'lk2', key: 'o[0]', fields: ['p[0]'], values: ['w'] }, rows.map((r) => ({ p: [r.f] })), { extra: { lk2: lk.map((r) => ({ o: [r.k], w: r.w })) } })
  add(S, 'escaped dot key', { type: 'lookup', from: 'lk2', key: 'o\\.k', fields: ['p\\.f'], values: ['w'] }, rows.map((r) => ({ 'p.f': r.f })), { extra: { lk2: lk.map((r) => ({ 'o.k': r.k, w: r.w })) } })
  add(S, 'empty lookup table', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'] }, rows, { extra: { lk: [] } })
  add(S, 'empty source', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'] }, [], { extra: ex })
  add(S, 'lookup row identity: whole-row result equals source row', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['m'] }, [{ f: 'b' }], { extra: ex })
  add(S, 'error: multi-field without as', { type: 'lookup', from: 'lk', key: 'k', fields: ['f', 'g'], values: ['w'] }, rows, { extra: ex })
  add(S, 'error: too few as', { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w', 'u'], as: ['x'] }, rows, { extra: ex })
  add(S, 'error: no values and no as for multi fields', { type: 'lookup', from: 'lk', key: 'k', fields: ['f', 'g'] }, rows, { extra: ex })
}

// ============================================================================
// impute
// ============================================================================
{
  const S = 'impute'
  const base = [
    { g: 'a', k: 1, v: 10 }, { g: 'a', k: 3, v: 30 }, { g: 'b', k: 2, v: 5 }, { g: 'b', k: 3, v: 7 }, { g: 'c', k: 1, v: null },
  ]
  for (const method of [undefined, 'value', 'mean', 'median', 'min', 'max']) {
    const m = method ? { method } : {}
    add(S, `${method}: groupby, keyvals`, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], ...m }, base)
    add(S, `${method}: groupby, keyvals omitted (domain from data, in order seen)`, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], ...m }, base)
    add(S, `${method}: no groupby`, { type: 'impute', field: 'v', key: 'k', keyvals: [1, 2, 3, 4], ...m }, base.slice(0, 2))
    add(S, `${method}: value 7`, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], value: 7, ...m }, base)
    add(S, `${method}: odd values`, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [0, 1, 2, 3], ...m }, mkRows(8, ODD, ['a', 'b']).map((r, i) => ({ ...r, k: i % 4 })))
    add(S, `${method}: empty input`, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2], ...m }, [])
    add(S, `${method}: nested`, { type: 'impute', field: 'a.v', key: 'a.k', groupby: ['a.g'], keyvals: [1, 2, 3], ...m }, base.map((r) => ({ a: { ...r } })))
  }
  add(S, 'value non-numeric string', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], value: 'missing' }, base)
  add(S, 'value null', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], value: null }, base)
  add(S, 'value object', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], value: { a: 1 } }, base)
  add(S, 'value 0 explicit', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], value: 0 }, base)
  add(S, 'keyvals unsorted keeps given order', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [3, 1, 2] }, base)
  add(S, 'key values strings vs numbers', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: ['1', 2, 3] }, base)
  add(S, 'keys not in keyvals extend the domain in order seen', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1] }, base)
  add(S, 'two groupby fields', { type: 'impute', field: 'v', key: 'k', groupby: ['g', 'h'], keyvals: [1, 2, 3] }, base.map((r, i) => ({ ...r, h: i % 2 })))
  add(S, 'mean of strings/dates', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], method: 'mean' }, [{ g: 'a', k: 1, v: '4' }, { g: 'a', k: 3, v: '8' }])
  add(S, 'min/max of dates', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2, 3], method: 'max' }, [{ g: 'a', k: 1, v: D('2020-01-01') }, { g: 'a', k: 3, v: D('2021-01-01') }])
  add(S, 'duplicate keys in a group: last wins slot', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, 2] }, [{ g: 'a', k: 1, v: 1 }, { g: 'a', k: 1, v: 2 }])
  add(S, 'null key values', { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [1, null] }, [{ g: 'a', k: 1, v: 1 }, { g: 'b', k: null, v: 2 }])
  add(S, 'error: bad method', { type: 'impute', field: 'v', key: 'k', method: 'nope' }, base)
}

// ============================================================================
// stack
// ============================================================================
{
  const S = 'stack'
  const base = [
    { x: 'a', g: 'p', v: 3 }, { x: 'a', g: 'q', v: -2 }, { x: 'b', g: 'p', v: 1 }, { x: 'a', g: 'r', v: 4 }, { x: 'b', g: 'q', v: 5 },
    { x: 'c', g: 'p', v: 0 }, { x: 'b', g: 'r', v: -1 }, { x: 'c', g: 'q', v: 2 },
  ]
  for (const offset of [undefined, 'zero', 'center', 'normalize', 'bogus']) {
    const o = offset ? { offset } : {}
    add(S, `${offset}: groupby x`, { type: 'stack', groupby: ['x'], field: 'v', ...o }, base)
    add(S, `${offset}: groupby x, sort g`, { type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'g' }, ...o }, base)
    add(S, `${offset}: groupby x, sort v desc`, { type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'v', order: 'descending' }, ...o }, base)
    add(S, `${offset}: no groupby`, { type: 'stack', field: 'v', ...o }, base)
    add(S, `${offset}: no field -> one`, { type: 'stack', groupby: ['x'], ...o }, base)
    add(S, `${offset}: as given`, { type: 'stack', groupby: ['x'], field: 'v', as: ['lo', 'hi'], ...o }, base)
    add(S, `${offset}: odd values`, { type: 'stack', groupby: ['g'], field: 'v', ...o }, mkRows(8, ODD, ['a', 'b']))
    add(S, `${offset}: empty`, { type: 'stack', groupby: ['x'], field: 'v', ...o }, [])
    add(S, `${offset}: nested`, { type: 'stack', groupby: ['o.x'], field: 'o.v', sort: { field: 'o.g' }, ...o }, base.map((r) => ({ o: { ...r } })))
  }
  add(S, 'keeps input order across interleaved groups', { type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'v', order: 'descending' } }, base)
  add(S, 'groupby uses JSON.stringify (1 and "1" differ)', { type: 'stack', groupby: ['x'], field: 'v' }, [{ x: 1, v: 1 }, { x: '1', v: 2 }, { x: 1, v: 3 }])
  add(S, 'groupby NaN/null/undefined stringify to null', { type: 'stack', groupby: ['x'], field: 'v' }, [{ x: NaN, v: 1 }, { x: null, v: 2 }, { x: undefined, v: 3 }, { x: Infinity, v: 4 }, { x: D('2020-01-01'), v: 5 }])
  add(S, 'as with one name', { type: 'stack', groupby: ['x'], field: 'v', as: ['lo'] }, base)
  add(S, 'sort stable on ties', { type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'g' } }, base.map((r) => ({ ...r, g: 'same' })))
  add(S, 'sort multi-field', { type: 'stack', groupby: ['x'], field: 'v', sort: { field: ['g', 'v'], order: ['descending', 'ascending'] } }, base)
  for (let k = 0; k < 20; k++) {
    add(S, `random #${k}`, { type: 'stack', groupby: rnd() < 0.7 ? ['g'] : [], field: 'v', offset: pick(['zero', 'center', 'normalize']), ...(rnd() < 0.5 ? { sort: { field: pick(['w', 'v']), order: pick(['ascending', 'descending']) } } : {}) }, mkRows(int(1, 12), rnd() < 0.5 ? ODD : [1, -2, 3, 0, '4', null], ['a', 'b', 'c']))
  }
}

// ============================================================================
// cross / countpattern
// ============================================================================
{
  const S = 'cross'
  const rows = [{ v: 1 }, { v: 2 }, { v: 3 }]
  add(S, 'defaults a/b', { type: 'cross' }, rows)
  add(S, 'as given', { type: 'cross', as: ['l', 'r'] }, rows)
  add(S, 'filter', { type: 'cross', filter: 'datum.a.v < datum.b.v' }, rows)
  add(S, 'filter with as names', { type: 'cross', filter: 'datum.p.v !== datum.q.v', as: ['p', 'q'] }, rows)
  add(S, 'empty', { type: 'cross' }, [])
  add(S, 'single', { type: 'cross' }, [{ v: 1 }])
  add(S, 'as with one name', { type: 'cross', as: ['l'] }, rows)
}
{
  const S = 'countpattern'
  const rows = [{ t: 'The quick brown fox. The lazy dog; the end' }, { t: "it's a dog's life" }, { t: 'Hello "World" HELLO' }]
  add(S, 'defaults', { type: 'countpattern', field: 't' }, rows)
  add(S, 'case upper', { type: 'countpattern', field: 't', case: 'upper' }, rows)
  add(S, 'case lower', { type: 'countpattern', field: 't', case: 'lower' }, rows)
  add(S, 'case mixed explicit', { type: 'countpattern', field: 't', case: 'mixed' }, rows)
  add(S, 'pattern', { type: 'countpattern', field: 't', pattern: '[a-z]+' }, rows)
  add(S, 'pattern with apostrophe', { type: 'countpattern', field: 't', pattern: "[\\w']+" }, rows)
  add(S, 'stopwords', { type: 'countpattern', field: 't', case: 'lower', stopwords: 'the|a|it' }, rows)
  add(S, 'stopwords empty', { type: 'countpattern', field: 't', stopwords: '' }, rows)
  add(S, 'as given', { type: 'countpattern', field: 't', as: ['word', 'n'] }, rows)
  add(S, 'as one name', { type: 'countpattern', field: 't', as: ['word'] }, rows)
  add(S, 'nested field', { type: 'countpattern', field: 'o.t' }, rows.map((r) => ({ o: { t: r.t } })))
  add(S, 'no matches', { type: 'countpattern', field: 't', pattern: 'ZZZ' }, rows)
  add(S, 'empty', { type: 'countpattern', field: 't' }, [])
  add(S, 'null text throws', { type: 'countpattern', field: 't' }, [{ t: null }])
  add(S, 'undefined text throws', { type: 'countpattern', field: 't' }, [{ u: 1 }])
  add(S, 'number text throws', { type: 'countpattern', field: 't' }, [{ t: 12 }])
  add(S, 'count ties keep first-seen order', { type: 'countpattern', field: 't' }, [{ t: 'b a b a c' }])
  add(S, 'integer-like tokens iterate first', { type: 'countpattern', field: 't' }, [{ t: 'b 10 a 2 c 1' }])
  // Not recorded: tokens named like Object.prototype members ('constructor', '__proto__') hit
  // vega's plain-object token table and yield garbage there; the engine counts them as data
  // (unit test in transform-semantics.test.ts).
  add(S, 'error: field omitted', { type: 'countpattern' }, rows)
}

// ============================================================================
// sample (reservoir)
// ============================================================================
{
  const S = 'sample'
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ i }))
  add(S, 'size >= n keeps all in order', { type: 'sample', size: 10 }, mk(5))
  add(S, 'size = n', { type: 'sample', size: 5 }, mk(5))
  add(S, 'default size 1000 keeps 700', { type: 'sample' }, mk(700))
  add(S, 'default size 1000 over 1500', { type: 'sample' }, mk(1500))
  add(S, 'size 1 of 50', { type: 'sample', size: 1 }, mk(50))
  add(S, 'size 5 of 50', { type: 'sample', size: 5 }, mk(50))
  add(S, 'size 10 of 200', { type: 'sample', size: 10 }, mk(200))
  add(S, 'size 100 of 1000', { type: 'sample', size: 100 }, mk(1000))
  add(S, 'size 0 of 10', { type: 'sample', size: 0 }, mk(10))
  add(S, 'size negative', { type: 'sample', size: -3 }, mk(10))
  add(S, 'size fractional', { type: 'sample', size: 2.5 }, mk(10))
  add(S, 'size string numeric', { type: 'sample', size: '3' }, mk(10))
  add(S, 'empty', { type: 'sample', size: 3 }, [])
}

// ============================================================================
// timeunit (run under several zones)
// ============================================================================
const TZS = ['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/Berlin', 'America/St_Johns']
{
  const S = 'timeunit'
  const dates = [
    D('2020-01-01T00:00:00.000Z'), D('2020-02-29T23:59:59.999Z'), D('2020-03-08T07:30:00.000Z'), D('2020-03-08T12:00:00.000Z'), D('2020-03-29T00:30:00.000Z'),
    D('2020-05-15T12:34:56.789Z'), D('2020-10-25T00:30:00.000Z'), D('2020-11-01T05:30:00.000Z'), D('2020-12-31T23:30:00.000Z'), D('2021-01-03T05:00:00.000Z'),
    D('2019-12-29T10:00:00.000Z'), D('2016-02-29T12:00:00.000Z'), D('1969-12-31T23:59:59.000Z'), D('2024-04-07T15:15:00.000Z'),
  ]
  const rows = dates.map((d, i) => ({ t: d, i }))
  const UNITS = [
    ['year'], ['quarter'], ['month'], ['week'], ['day'], ['date'], ['dayofyear'], ['hours'], ['minutes'], ['seconds'], ['milliseconds'],
    ['year', 'month'], ['year', 'quarter'], ['year', 'month', 'date'], ['year', 'week'], ['year', 'dayofyear'], ['year', 'week', 'day'], ['month', 'date'],
    ['quarter', 'month'], ['hours', 'minutes'], ['date', 'hours'], ['day', 'hours'], ['year', 'month', 'date', 'hours'],
    ['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'], ['week', 'day'], ['month', 'day'], ['dayofyear', 'hours'], ['minutes', 'seconds'],
    ['seconds', 'milliseconds'], ['year', 'day'], ['quarter', 'date'],
  ]
  const zones = ['UTC', ...TZS]
  for (const tz of zones) {
    for (const units of UNITS) {
      for (const timezone of [undefined, 'utc', 'local']) {
        const p = { type: 'timeunit', field: 't', units, ...(timezone ? { timezone } : {}) }
        add(S, `${tz} ${units.join('+')} tz=${timezone}`, p, rows, { tz })
      }
    }
    for (const step of [2, 3, 5, 15]) {
      for (const units of [['year'], ['month'], ['date'], ['hours'], ['minutes'], ['seconds'], ['milliseconds'], ['year', 'month']]) {
        add(S, `${tz} step ${step} ${units.join('+')}`, { type: 'timeunit', field: 't', units, step }, rows, { tz })
        add(S, `${tz} step ${step} ${units.join('+')} utc`, { type: 'timeunit', field: 't', units, step, timezone: 'utc' }, rows, { tz })
      }
    }
    add(S, `${tz} interval false`, { type: 'timeunit', field: 't', units: ['month'], interval: false }, rows, { tz })
    add(S, `${tz} as given`, { type: 'timeunit', field: 't', units: ['month'], as: ['s', 'e'] }, rows, { tz })
    add(S, `${tz} as one name`, { type: 'timeunit', field: 't', units: ['month'], as: ['s'] }, rows, { tz })
    add(S, `${tz} units omitted: maxbins 40 default`, { type: 'timeunit', field: 't' }, rows, { tz })
    add(S, `${tz} units omitted: maxbins 5`, { type: 'timeunit', field: 't', maxbins: 5 }, rows, { tz })
    add(S, `${tz} units omitted: maxbins 1000`, { type: 'timeunit', field: 't', maxbins: 1000 }, rows, { tz })
    add(S, `${tz} units omitted: extent`, { type: 'timeunit', field: 't', extent: [dates[0].getTime(), dates[5].getTime()], maxbins: 12 }, rows, { tz })
    add(S, `${tz} inferUnits`, { type: 'timeunit', field: 't', inferUnits: true }, rows.slice(0, 3), { tz })
    add(S, `${tz} inferUnits midnight-only`, { type: 'timeunit', field: 't', inferUnits: true }, [{ t: D('2020-01-01T00:00:00Z') }, { t: D('2020-02-01T00:00:00Z') }], { tz })
    add(S, `${tz} inferUnits utc`, { type: 'timeunit', field: 't', inferUnits: true, timezone: 'utc' }, [{ t: D('2020-01-01T00:00:00Z') }, { t: D('2020-02-01T00:00:00Z') }], { tz })
    add(S, `${tz} odd values`, { type: 'timeunit', field: 't', units: ['year', 'month'] }, [{ t: '2020-05-15' }, { t: 1589500000000 }, { t: null }, { t: undefined }, { t: NaN }, { t: 'garbage' }, { t: D(NaN) }, { t: '' }, { t: true }, { t: D('2020-05-15T12:00:00Z') }], { tz })
    add(S, `${tz} numeric strings and ms`, { type: 'timeunit', field: 't', units: ['date'] }, [{ t: '0' }, { t: 0 }, { t: 86400000 }, { t: '86400000' }], { tz })
    add(S, `${tz} nested field`, { type: 'timeunit', field: 'o.t', units: ['year', 'month'] }, rows.map((r) => ({ o: { t: r.t } })), { tz })
    add(S, `${tz} escaped dot field`, { type: 'timeunit', field: 'o\\.t', units: ['month'] }, rows.map((r) => ({ 'o.t': r.t })), { tz })
    add(S, `${tz} empty`, { type: 'timeunit', field: 't', units: ['month'] }, [], { tz })
    add(S, `${tz} empty units`, { type: 'timeunit', field: 't', units: [] }, rows, { tz })
    add(S, `${tz} error: bad unit`, { type: 'timeunit', field: 't', units: ['fortnight'] }, rows, { tz })
    add(S, `${tz} error: field omitted`, { type: 'timeunit', units: ['month'] }, rows, { tz })
  }
}

// ============================================================================
// density / kde / quantile / dotbin / pie
// ============================================================================
{
  const S = 'kde'
  const rows = [1, 2, 2.5, 3, 3.1, 7, 9, 9.5, 12].map((v, i) => ({ v, g: i % 2 ? 'a' : 'b', i }))
  const p = { type: 'kde', field: 'v' }
  add(S, 'defaults', p, rows)
  add(S, 'groupby', { ...p, groupby: ['g'] }, rows)
  add(S, 'cumulative', { ...p, cumulative: true }, rows)
  add(S, 'counts', { ...p, counts: true, groupby: ['g'] }, rows)
  add(S, 'bandwidth', { ...p, bandwidth: 0.5 }, rows)
  add(S, 'extent', { ...p, extent: [0, 15] }, rows)
  add(S, 'steps', { ...p, steps: 10 }, rows)
  add(S, 'minsteps maxsteps', { ...p, minsteps: 10, maxsteps: 40 }, rows)
  add(S, 'resolve shared', { ...p, groupby: ['g'], resolve: 'shared' }, rows)
  add(S, 'resolve shared steps', { ...p, groupby: ['g'], resolve: 'shared', steps: 20 }, rows)
  add(S, 'as given', { ...p, as: ['x', 'y'] }, rows)
  add(S, 'odd values', p, [{ v: 1 }, { v: null }, { v: undefined }, { v: NaN }, { v: '3' }, { v: 4 }, { v: '' }, { v: 5 }])
  add(S, 'nulls only', p, [{ v: null }, { v: null }])
  add(S, 'single value', p, [{ v: 4 }])
  add(S, 'identical values', p, [{ v: 4 }, { v: 4 }, { v: 4 }])
  add(S, 'empty', p, [])
  add(S, 'nested', { type: 'kde', field: 'o.v', groupby: ['o.g'] }, rows.map((r) => ({ o: { ...r } })))
  add(S, 'groupby odd keys', { ...p, groupby: ['g'] }, GROUPS.map((g, i) => ({ g, v: i * 1.5 })).concat(GROUPS.map((g, i) => ({ g, v: i * 1.3 + 0.2 }))))
}
{
  const S = 'density'
  add(S, 'normal defaults', { type: 'density', distribution: { function: 'normal' }, extent: [-3, 3] }, [])
  add(S, 'normal params', { type: 'density', distribution: { function: 'normal', mean: 2, stdev: 0.5 }, extent: [0, 4], steps: 10 }, [])
  add(S, 'normal cdf', { type: 'density', distribution: { function: 'normal' }, extent: [-3, 3], method: 'cdf' }, [])
  add(S, 'lognormal', { type: 'density', distribution: { function: 'lognormal', mean: 0, stdev: 0.5 }, extent: [0.1, 5] }, [])
  add(S, 'uniform', { type: 'density', distribution: { function: 'uniform', min: 1, max: 3 }, extent: [0, 4] }, [])
  add(S, 'uniform cdf', { type: 'density', distribution: { function: 'uniform', min: 1, max: 3 }, extent: [0, 4], method: 'cdf' }, [])
  add(S, 'kde from field', { type: 'density', distribution: { function: 'kde', field: 'v' }, extent: [0, 10] }, [1, 2, 3, 5, 8].map((v) => ({ v })))
  add(S, 'kde from field, no extent', { type: 'density', distribution: { function: 'kde', field: 'v' } }, [1, 2, 3, 5, 8].map((v) => ({ v })))
  add(S, 'kde bandwidth', { type: 'density', distribution: { function: 'kde', field: 'v', bandwidth: 2 }, extent: [0, 10] }, [1, 2, 3, 5, 8].map((v) => ({ v })))
  add(S, 'mixture', { type: 'density', distribution: { function: 'mixture', distributions: [{ function: 'normal', mean: -1 }, { function: 'normal', mean: 2, stdev: 0.5 }], weights: [0.3, 0.7] }, extent: [-4, 4] }, [])
  add(S, 'mixture no weights', { type: 'density', distribution: { function: 'mixture', distributions: [{ function: 'normal', mean: -1 }, { function: 'uniform', min: 0, max: 2 }] }, extent: [-4, 4] }, [])
  add(S, 'as given', { type: 'density', distribution: { function: 'normal' }, extent: [-1, 1], as: ['x', 'y'], steps: 5 }, [])
  add(S, 'minsteps maxsteps', { type: 'density', distribution: { function: 'normal' }, extent: [-1, 1], minsteps: 5, maxsteps: 9 }, [])
  add(S, 'error: no extent for normal', { type: 'density', distribution: { function: 'normal' } }, [])
  add(S, 'error: unknown distribution', { type: 'density', distribution: { function: 'cauchy' }, extent: [0, 1] }, [])
  add(S, 'error: bad method', { type: 'density', distribution: { function: 'normal' }, extent: [0, 1], method: 'nope' }, [])
}
{
  const S = 'quantile'
  const rows = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5].map((v, i) => ({ v, g: i % 2 ? 'a' : 'b' }))
  add(S, 'defaults (step 0.01)', { type: 'quantile', field: 'v' }, rows)
  add(S, 'probs', { type: 'quantile', field: 'v', probs: [0, 0.25, 0.5, 0.75, 1] }, rows)
  add(S, 'step', { type: 'quantile', field: 'v', step: 0.25 }, rows)
  add(S, 'groupby', { type: 'quantile', field: 'v', groupby: ['g'], probs: [0.1, 0.5, 0.9] }, rows)
  add(S, 'as given', { type: 'quantile', field: 'v', probs: [0.5], as: ['p', 'q'] }, rows)
  add(S, 'odd values', { type: 'quantile', field: 'v', probs: [0.25, 0.5, 0.75] }, [{ v: '4' }, { v: null }, { v: NaN }, { v: 1 }, { v: '' }, { v: undefined }, { v: 3 }, { v: D('1970-01-01T00:00:00.010Z') }])
  add(S, 'all invalid', { type: 'quantile', field: 'v', probs: [0.5] }, [{ v: null }, { v: 'a' }])
  add(S, 'empty', { type: 'quantile', field: 'v', probs: [0.5] }, [])
  add(S, 'probs out of range', { type: 'quantile', field: 'v', probs: [-1, 2, NaN] }, rows)
  add(S, 'nested + groupby nested', { type: 'quantile', field: 'o.v', groupby: ['o.g'], probs: [0.5] }, rows.map((r) => ({ o: { ...r } })))
  add(S, 'groupby odd keys', { type: 'quantile', field: 'v', groupby: ['g'], probs: [0.5] }, GROUPS.map((g, i) => ({ g, v: i })))
}
{
  const S = 'dotbin'
  const rows = [1, 1.1, 1.2, 2, 2.05, 3.7, 3.8, 3.9, 4, 9].map((v, i) => ({ v, g: i % 2 ? 'a' : 'b' }))
  add(S, 'defaults', { type: 'dotbin', field: 'v' }, rows)
  add(S, 'step', { type: 'dotbin', field: 'v', step: 0.5 }, rows)
  add(S, 'smooth', { type: 'dotbin', field: 'v', step: 0.5, smooth: true }, rows)
  add(S, 'groupby', { type: 'dotbin', field: 'v', step: 0.5, groupby: ['g'] }, rows)
  add(S, 'as', { type: 'dotbin', field: 'v', step: 0.5, as: 'b' }, rows)
  add(S, 'empty', { type: 'dotbin', field: 'v', step: 0.5 }, [], { dropOnCrash: true })
  add(S, 'odd values', { type: 'dotbin', field: 'v', step: 0.5 }, [{ v: 1 }, { v: '2' }, { v: null }, { v: 3 }])
}
{
  const S = 'pie'
  const rows = [3, 1, 2, 4].map((v, i) => ({ v, i }))
  add(S, 'defaults field->1', { type: 'pie' }, rows)
  add(S, 'field', { type: 'pie', field: 'v' }, rows)
  add(S, 'sort', { type: 'pie', field: 'v', sort: true }, rows)
  add(S, 'angles', { type: 'pie', field: 'v', startAngle: 1, endAngle: 4 }, rows)
  add(S, 'endAngle 0', { type: 'pie', field: 'v', endAngle: 0 }, rows)
  add(S, 'as', { type: 'pie', field: 'v', as: ['s', 'e'] }, rows)
  add(S, 'odd values', { type: 'pie', field: 'v' }, [{ v: 1 }, { v: '2' }, { v: null }, { v: NaN }, { v: -1 }])
  add(S, 'zero sum', { type: 'pie', field: 'v' }, [{ v: 0 }, { v: 0 }])
  add(S, 'empty', { type: 'pie', field: 'v' }, [])
  add(S, 'nested', { type: 'pie', field: 'o.v' }, rows.map((r) => ({ o: { v: r.v } })))
}

// ============================================================================
// regression / loess
// ============================================================================
{
  const S = 'regression'
  const xy = [[1, 2.1], [2, 3.9], [3, 6.2], [4, 7.8], [5, 10.1], [6, 12.3], [7, 13.8]].map(([x, y], i) => ({ x, y, g: i % 2 ? 'a' : 'b' }))
  for (const method of [undefined, 'linear', 'log', 'exp', 'pow', 'quad', 'poly', 'constant']) {
    const m = method ? { method } : {}
    const ord = method === 'poly' ? { order: 3 } : {}
    add(S, `${method}: defaults`, { type: 'regression', x: 'x', y: 'y', ...m, ...ord }, xy)
    add(S, `${method}: groupby`, { type: 'regression', x: 'x', y: 'y', groupby: ['g'], ...m, ...ord }, xy)
    add(S, `${method}: extent`, { type: 'regression', x: 'x', y: 'y', extent: [0, 10], ...m, ...ord }, xy)
    add(S, `${method}: params true`, { type: 'regression', x: 'x', y: 'y', params: true, ...m, ...ord }, xy)
    add(S, `${method}: params true groupby`, { type: 'regression', x: 'x', y: 'y', params: true, groupby: ['g'], ...m, ...ord }, xy)
    add(S, `${method}: as`, { type: 'regression', x: 'x', y: 'y', as: ['px', 'py'], ...m, ...ord }, xy)
    add(S, `${method}: odd values`, { type: 'regression', x: 'x', y: 'y', ...m, ...ord }, xy.concat([{ x: null, y: 1 }, { x: 3, y: undefined }, { x: NaN, y: 2 }, { x: '8', y: '16' }, { x: 9, y: -1 }, { x: 0, y: 0 }]))
    add(S, `${method}: two points`, { type: 'regression', x: 'x', y: 'y', ...m, ...ord }, xy.slice(0, 2))
    add(S, `${method}: one point`, { type: 'regression', x: 'x', y: 'y', ...m, ...ord }, xy.slice(0, 1))
    add(S, `${method}: empty`, { type: 'regression', x: 'x', y: 'y', ...m, ...ord }, [])
  }
  add(S, 'order 2 poly', { type: 'regression', x: 'x', y: 'y', method: 'poly', order: 2 }, xy)
  add(S, 'order 1 poly', { type: 'regression', x: 'x', y: 'y', method: 'poly', order: 1 }, xy)
  add(S, 'poly order omitted -> 3', { type: 'regression', x: 'x', y: 'y', method: 'poly' }, xy)
  add(S, 'nested', { type: 'regression', x: 'o.x', y: 'o.y', groupby: ['o.g'] }, xy.map((r) => ({ o: { ...r } })))
  add(S, 'vertical line (identical x)', { type: 'regression', x: 'x', y: 'y' }, [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }])
  add(S, 'error: unknown method', { type: 'regression', x: 'x', y: 'y', method: 'nope' }, xy)
}
{
  const S = 'loess'
  const xy = [[1, 2.1], [2, 3.9], [3, 6.2], [4, 7.8], [5, 10.1], [6, 12.3], [7, 13.8], [8, 13], [9, 15]].map(([x, y], i) => ({ x, y, g: i % 2 ? 'a' : 'b' }))
  add(S, 'defaults', { type: 'loess', x: 'x', y: 'y' }, xy)
  add(S, 'bandwidth', { type: 'loess', x: 'x', y: 'y', bandwidth: 0.8 }, xy)
  add(S, 'groupby', { type: 'loess', x: 'x', y: 'y', groupby: ['g'], bandwidth: 0.9 }, xy)
  add(S, 'as', { type: 'loess', x: 'x', y: 'y', as: ['a', 'b'] }, xy)
  add(S, 'odd values', { type: 'loess', x: 'x', y: 'y' }, xy.concat([{ x: null, y: 1 }, { x: 3, y: undefined }, { x: NaN, y: 2 }, { x: '8', y: '16' }]))
  add(S, 'ties in x', { type: 'loess', x: 'x', y: 'y' }, [{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }, { x: 3, y: 5 }, { x: 3, y: 4 }])
  add(S, 'few points', { type: 'loess', x: 'x', y: 'y' }, xy.slice(0, 2))
  add(S, 'empty', { type: 'loess', x: 'x', y: 'y' }, [])
  add(S, 'nested', { type: 'loess', x: 'o.x', y: 'o.y' }, xy.map((r) => ({ o: { ...r } })))
}

// ============================================================================
// hierarchy: stratify + treemap / pack / partition / tree
// ============================================================================
{
  const nodes = [
    { id: 'root', parent: null, size: 0 }, { id: 'a', parent: 'root', size: 10 }, { id: 'b', parent: 'root', size: 20 }, { id: 'c', parent: 'root', size: 5 },
    { id: 'a1', parent: 'a', size: 4 }, { id: 'a2', parent: 'a', size: 6 }, { id: 'b1', parent: 'b', size: 20 }, { id: 'b11', parent: 'b1', size: 20 },
  ]
  const st = { type: 'stratify', key: 'id', parentKey: 'parent' }
  const S1 = 'stratify'
  add(S1, 'passthrough', st, nodes)
  const S2 = 'treemap'
  for (const method of [undefined, 'squarify', 'binary', 'dice', 'slice', 'slicedice', 'resquarify']) {
    const m = method ? { method } : {}
    add(S2, `${method}: size`, [st, { type: 'treemap', field: 'size', size: [100, 80], ...m }], nodes)
    add(S2, `${method}: size, padding`, [st, { type: 'treemap', field: 'size', size: [100, 80], padding: 2, ...m }], nodes)
    add(S2, `${method}: paddingInner/Outer, round`, [st, { type: 'treemap', field: 'size', size: [100, 80], paddingInner: 1, paddingOuter: 2, round: true, ...m }], nodes)
    add(S2, `${method}: sort`, [st, { type: 'treemap', field: 'size', size: [100, 80], sort: { field: 'size', order: 'descending' }, ...m }], nodes)
    add(S2, `${method}: sort by node value`, [st, { type: 'treemap', field: 'size', size: [100, 80], sort: { field: 'value', order: 'descending' }, ...m }], nodes)
    add(S2, `${method}: sort by data.size`, [st, { type: 'treemap', field: 'size', size: [100, 80], sort: { field: 'data.size' }, ...m }], nodes)
    add(S2, `${method}: ratio`, [st, { type: 'treemap', field: 'size', size: [100, 80], ratio: 2, ...m }], nodes)
  }
  add(S2, 'padding Top/Right/Bottom/Left', [st, { type: 'treemap', field: 'size', size: [100, 80], paddingTop: 5, paddingRight: 4, paddingBottom: 3, paddingLeft: 2 }], nodes)
  add(S2, 'as given', [st, { type: 'treemap', field: 'size', size: [100, 80], as: ['X0', 'Y0', 'X1', 'Y1', 'D', 'C'] }], nodes)
  add(S2, 'data has x/y/width/height fields that must survive', [st, { type: 'treemap', field: 'size', size: [100, 80] }], nodes.map((n) => ({ ...n, x: 'keep', y: 'keep', width: 'keep', height: 'keep' })))
  add(S2, 'no field: leaf counts', [st, { type: 'treemap', size: [100, 80] }], nodes)
  add(S2, 'size omitted -> [1,1]', [st, { type: 'treemap', field: 'size' }], nodes)
  add(S2, 'single node', [st, { type: 'treemap', field: 'size', size: [10, 10] }], [{ id: 'r', parent: null, size: 3 }])
  add(S2, 'zero sizes', [st, { type: 'treemap', field: 'size', size: [10, 10] }], nodes.map((n) => ({ ...n, size: 0 })))
  const S3 = 'pack'
  add(S3, 'defaults', [st, { type: 'pack', field: 'size', size: [100, 100] }], nodes)
  add(S3, 'padding', [st, { type: 'pack', field: 'size', size: [100, 100], padding: 3 }], nodes)
  add(S3, 'radius field', [st, { type: 'pack', radius: 'size', size: [100, 100] }], nodes)
  add(S3, 'sort', [st, { type: 'pack', field: 'size', size: [100, 100], sort: { field: 'size' } }], nodes)
  add(S3, 'sort by node value', [st, { type: 'pack', field: 'size', size: [100, 100], sort: { field: 'value', order: 'descending' } }], nodes)
  add(S3, 'radius via data.size', [st, { type: 'pack', radius: 'data.size', size: [100, 100] }], nodes)
  add(S3, 'radius via value + padding', [st, { type: 'pack', radius: 'value', padding: 2, size: [100, 100] }], nodes)
  add(S3, 'as given', [st, { type: 'pack', field: 'size', size: [100, 100], as: ['X', 'Y', 'R', 'D', 'C'] }], nodes)
  add(S3, 'data has x/y/r/depth/children that must survive', [st, { type: 'pack', field: 'size', size: [100, 100] }], nodes.map((n) => ({ ...n, x: 'keep', y: 'keep', r: 'keep', depth: 'keep', children: 'keep' })))
  add(S3, 'size omitted', [st, { type: 'pack', field: 'size' }], nodes)
  const S4 = 'partition'
  add(S4, 'defaults', [st, { type: 'partition', field: 'size', size: [100, 80] }], nodes)
  add(S4, 'padding round', [st, { type: 'partition', field: 'size', size: [100, 80], padding: 2, round: true }], nodes)
  add(S4, 'sort', [st, { type: 'partition', field: 'size', size: [100, 80], sort: { field: 'size', order: 'descending' } }], nodes)
  add(S4, 'sort by node value', [st, { type: 'partition', field: 'size', size: [100, 80], sort: { field: 'value', order: 'descending' } }], nodes)
  add(S4, 'as given', [st, { type: 'partition', field: 'size', size: [100, 80], as: ['X0', 'Y0', 'X1', 'Y1', 'D', 'C'] }], nodes)
  add(S4, 'data has x0/y0/x1/y1/depth/children that must survive', [st, { type: 'partition', field: 'size', size: [100, 80] }], nodes.map((n) => ({ ...n, x0: 'keep', y0: 'keep', x1: 'keep', y1: 'keep', depth: 'keep', children: 'keep' })))
  add(S4, 'size omitted', [st, { type: 'partition', field: 'size' }], nodes)
  // Not recorded: `tree`, `nest` and `treelinks` are not implemented by the engine (no consumer in
  // Vega-Lite output); recorded vectors for them would only assert 'unsupported transform'.
}

// ============================================================================
// geo (transform level; projection-free paths only)
// ============================================================================
{
  const S = 'geojson'
  const pts = [{ lon: 10, lat: 20, n: 'a' }, { lon: -40, lat: 5, n: 'b' }, { lon: null, lat: 1 }, { lon: 'x', lat: 2 }]
  add(S, 'fields', { type: 'geojson', fields: ['lon', 'lat'] }, pts)
  // Not recorded: the GeoJSON transform's value (a FeatureCollection) as a signal is consumed by the
  // projection `fit` machinery, which lives in the geo layer and has its own corpus coverage.
  add(S, 'geojson field', { type: 'geojson', geojson: 'geo' }, [{ geo: { type: 'Point', coordinates: [1, 2] } }, { geo: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }], { signals: [] })
  add(S, 'nested fields', { type: 'geojson', fields: ['o.lon', 'o.lat'] }, pts.map((p) => ({ o: p })))
}

await flush()

// ============================================================================
// write
// ============================================================================
const oracle = `vega@${JSON.parse(readFileSync(join(dirname(req.resolve('vega')), '..', 'package.json'), 'utf8')).version}`
const destDir = join(here, '..', '..', 'core', 'testdata', 'transform-vectors')
mkdirSync(destDir, { recursive: true })

function writeFile(name, filter) {
  const out = { suites: {} }
  let n = 0
  for (const [suite, cases] of Object.entries(suites)) {
    const keep = cases.filter(filter)
    if (!keep.length) continue
    out.suites[suite] = { oracle, kind: 'transform', seed: SEED, cases: keep }
    n += keep.length
  }
  writeFileSync(join(destDir, name), JSON.stringify(out) + '\n')
  console.log(`[vectors:transforms] wrote ${n} cases across ${Object.keys(out.suites).length} suites -> ${name}`)
  return n
}
const timeN = writeFile('vega-transforms-time.json', (c) => c.tz != null)
const mainN = writeFile('vega-transforms.json', (c) => c.tz == null)
console.log(`[vectors:transforms] ${timeN + mainN} cases in total (${totalCases} recorded)`)
for (const d of dropped) console.log(`[vectors:transforms] dropped (Vega TypeError): ${d}`)
