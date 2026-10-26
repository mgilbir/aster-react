/**
 * The incremental-equivalence oracle (audit C84, design tension T1).
 *
 * The contract under test is a CORRECTNESS GUARANTEE, not a best-effort
 * optimisation:
 *
 *   for every spec and every sequence of updates, the scene produced by the
 *   incremental/streamed path deep-equals
 *   `evaluateChart(compileChart(spec), input)` built from scratch at that step.
 *
 * The earlier fuzz compared the incremental result against the SAME mutated
 * compiled chart, so it could only ever catch bugs that survive a second
 * evaluation of the mutated state (it was structurally blind to stale caches).
 * Here the reference is always a freshly compiled chart fed the freshly built
 * input, so any stale cache, mis-keyed reuse or drifting transform state shows
 * up as a scene diff.
 *
 * Both incremental surfaces are exercised:
 *  - `evaluateChart` reuse of one compiled chart (explicit hints: `dataChanges`,
 *    `dataPulse`, `changedDatasets`, in-place array mutation, or none), and
 *  - `createChartSession` (the default `<Chart>` path): auto-diffed `evaluate`,
 *    explicit hints, `change()`, and the no-op cache.
 *
 * Determinism: everything derives from a seed (mulberry32). A failure prints the
 * seed, target, the (greedily shrunk) step list and the first differing scene
 * path. Knobs:
 *   ASTER_ORACLE_SEEDS=200        number of seeds (CI default: 40)
 *   ASTER_ORACLE_SEED=17          run exactly one seed (reproduce a failure)
 *   ASTER_ORACLE_STEPS=14         steps per seed
 *   ASTER_ORACLE_START=1000       first seed when sweeping
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { createChartSession } from './session.js'
import { diffRows, type RowDiff } from './pulse.js'
import { applyChangeset, newChangeset, planModify, type Changeset } from './modify.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneGroup, SceneRoot } from './types.js'
import { scopedSignalName } from './util.js'

type Row = Record<string, unknown>
type Rnd = () => number

function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, a: readonly T[]): T => a[Math.floor(r() * a.length)]!
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const clone = <T,>(v: T): T => structuredClone(v)

// ---------------------------------------------------------------------------
// Spec generator
// ---------------------------------------------------------------------------

interface Pipe {
  name: string
  tr: Array<Record<string, unknown>>
  /** Numeric field for the x channel / y channel, and a category field. */
  xf: string
  yf: string
  cf?: string
  /** The pipe reads dataset `t`, so it cannot run on `t` itself. */
  skipSource?: boolean
}

const PIPES: Pipe[] = [
  { name: 'none', tr: [], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'filter', tr: [{ type: 'filter', expr: 'datum.v > 4' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'filter-signal', tr: [{ type: 'filter', expr: 'datum.v > thr' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'formula', tr: [{ type: 'formula', expr: 'datum.x * 2 + sig', as: 'f' }], xf: 'f', yf: 'v', cf: 'g' },
  { name: 'aggregate', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'x'], ops: ['sum', 'max'], as: ['s', 'm'] }], xf: 'm', yf: 's', cf: 'g' },
  { name: 'aggregate-count', tr: [{ type: 'aggregate', groupby: ['g'], fields: [null], ops: ['count'], as: ['c'] }], xf: 'c', yf: 'c', cf: 'g' },
  { name: 'aggregate-global', tr: [{ type: 'aggregate', fields: ['v'], ops: ['mean'], as: ['mv'] }], xf: 'mv', yf: 'mv' },
  { name: 'joinaggregate', tr: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['mean'], as: ['mv'] }], xf: 'x', yf: 'mv', cf: 'g' },
  { name: 'window-sort', tr: [{ type: 'window', groupby: ['g'], sort: { field: 'v' }, ops: ['row_number', 'sum'], fields: [null, 'v'], as: ['rn', 'cs'] }], xf: 'rn', yf: 'cs', cf: 'g' },
  { name: 'window-nosort', tr: [{ type: 'window', groupby: ['g'], ops: ['sum'], fields: ['v'], as: ['cs'] }], xf: 'x', yf: 'cs', cf: 'g' },
  { name: 'window-global', tr: [{ type: 'window', sort: { field: 'x' }, ops: ['rank'], fields: [null], as: ['rk'] }], xf: 'x', yf: 'rk' },
  { name: 'identifier', tr: [{ type: 'identifier', as: 'id' }], xf: 'id', yf: 'v', cf: 'g' },
  { name: 'bin-data', tr: [{ type: 'bin', field: 'x', maxbins: 5, as: ['b0', 'b1'] }], xf: 'b0', yf: 'v', cf: 'g' },
  { name: 'bin-extent', tr: [{ type: 'bin', field: 'x', extent: [0, 10], maxbins: 5, as: ['b0', 'b1'] }], xf: 'b0', yf: 'v', cf: 'g' },
  { name: 'stack', tr: [{ type: 'stack', groupby: ['g'], field: 'v', sort: { field: 'x' }, as: ['y0', 'y1'] }], xf: 'x', yf: 'y1', cf: 'g' },
  { name: 'fold', tr: [{ type: 'fold', fields: ['x', 'y'], as: ['k', 'val'] }], xf: 'val', yf: 'v', cf: 'k' },
  { name: 'flatten', tr: [{ type: 'flatten', fields: ['arr'], as: ['e'] }], xf: 'e', yf: 'v', cf: 'g' },
  { name: 'lookup', tr: [{ type: 'lookup', from: 'u', key: 'g', fields: ['g'], values: ['w'], as: ['w'] }], xf: 'w', yf: 'v', cf: 'g' },
  { name: 'collect', tr: [{ type: 'collect', sort: { field: 'v' } }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'filter>aggregate', tr: [{ type: 'filter', expr: 'datum.v > 3' }, { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }], xf: 's', yf: 's', cf: 'g' },
  { name: 'formula>window', tr: [{ type: 'formula', expr: 'datum.v + 1', as: 'v1' }, { type: 'window', groupby: ['g'], sort: { field: 'v1' }, ops: ['sum'], fields: ['v1'], as: ['cs'] }], xf: 'v1', yf: 'cs', cf: 'g' },
  { name: 'filter>identifier', tr: [{ type: 'filter', expr: 'datum.x > 2' }, { type: 'identifier', as: 'id' }], xf: 'id', yf: 'v', cf: 'g' },
  { name: 'fold>filter', tr: [{ type: 'fold', fields: ['x', 'y'], as: ['k', 'val'] }, { type: 'filter', expr: 'datum.val > 2' }], xf: 'val', yf: 'v', cf: 'k' },
  { name: 'aggregate>filter', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }, { type: 'filter', expr: 'datum.s > 5' }], xf: 's', yf: 's', cf: 'g' },
  { name: 'lookup>formula', tr: [{ type: 'lookup', from: 'u', key: 'g', fields: ['g'], values: ['w'], as: ['w'] }, { type: 'formula', expr: 'datum.w + datum.v', as: 'wv' }], xf: 'wv', yf: 'v', cf: 'g' },
  { name: 'bin>aggregate', tr: [{ type: 'bin', field: 'x', maxbins: 4, as: ['b0', 'b1'] }, { type: 'aggregate', groupby: ['b0'], fields: ['v'], ops: ['sum'], as: ['s'] }], xf: 'b0', yf: 's' },
  // -- Vega-faithful transform semantics (audit C59/C94/C24): odd values (`s` numeric strings, `n` nullable),
  //    nested paths (`o.a`, `o.b[0]`), argmin/argmax/ci0/ci1, window ranks and frames, stack offsets, impute,
  //    sample, identifier, project, pivot, lookup (last wins), timeunit (fixed units and data-derived).
  { name: 'aggregate-stats', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'v', 'v', 'n', 's', 'x'], ops: ['stdev', 'median', 'distinct', 'valid', 'sum', 'argmin'], as: ['sd', 'md', 'ds', 'vl', 'ss', 'am'] }], xf: 'md', yf: 'ss', cf: 'g' },
  { name: 'aggregate-argmax-values', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['n', 'v', 'x'], ops: ['argmax', 'values', 'missing'], as: ['ax', 'vs', 'ms'] }, { type: 'formula', expr: 'datum.ms + 1', as: 'ms1' }], xf: 'ms1', yf: 'ms1', cf: 'g' },
  { name: 'aggregate-ci', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'v'], ops: ['ci0', 'ci1'], as: ['c0', 'c1'] }], xf: 'c0', yf: 'c1', cf: 'g' },
  { name: 'aggregate-ci-global', tr: [{ type: 'aggregate', fields: ['v', 'v', null], ops: ['ci0', 'ci1', 'count'], as: ['c0', 'c1', 'n'] }], xf: 'c0', yf: 'c1' },
  { name: 'aggregate-cross', tr: [{ type: 'aggregate', groupby: ['g', 'x'], cross: true, fields: ['v'], ops: ['sum'], as: ['s'] }], xf: 'x', yf: 's', cf: 'g' },
  { name: 'aggregate-nested', tr: [{ type: 'aggregate', groupby: ['o.a'], fields: ['o.b[0]'], ops: ['sum'], as: ['sb'] }, { type: 'formula', expr: 'datum["o.a"]', as: 'k' }], xf: 'k', yf: 'sb' },
  { name: 'aggregate-strings', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['s', 's', 's'], ops: ['sum', 'min', 'max'], as: ['ss', 'lo', 'hi'] }, { type: 'formula', expr: 'toNumber(datum.lo)', as: 'lon' }], xf: 'lon', yf: 'ss', cf: 'g' },
  { name: 'joinaggregate-ci', tr: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['ci1'], as: ['hi'] }], xf: 'x', yf: 'hi', cf: 'g' },
  { name: 'joinaggregate-key', tr: [{ type: 'joinaggregate', groupby: ['g'], key: 'x', fields: ['v'], ops: ['sum'], as: ['sv'] }], xf: 'x', yf: 'sv', cf: 'g' },
  { name: 'joinaggregate-odd', tr: [{ type: 'joinaggregate', groupby: ['g'], fields: ['n', 's', 'n'], ops: ['mean', 'max', 'valid'], as: ['mn', 'mx', 'vd'] }, { type: 'formula', expr: 'toNumber(datum.mx)', as: 'mxn' }], xf: 'mxn', yf: 'mn', cf: 'g' },
  { name: 'window-ranks', tr: [{ type: 'window', sort: { field: 'v' }, groupby: ['g'], ops: ['rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value'], fields: [null, null, null, null, null, 'v', 'v', 'v'], params: [null, null, null, null, 2, 1, 1, null], as: ['rk', 'dr', 'pr', 'cd', 'nt', 'lg', 'ld', 'fv'] }], xf: 'rk', yf: 'cd', cf: 'g' },
  { name: 'window-frame', tr: [{ type: 'window', sort: { field: 'x' }, ops: ['mean', 'min', 'max', 'median'], fields: ['v', 'v', 'v', 'v'], frame: [-1, 1], as: ['m', 'lo', 'hi', 'md'] }], xf: 'lo', yf: 'hi' },
  { name: 'window-null-sort', tr: [{ type: 'window', sort: { field: 'n', order: 'descending' }, ops: ['row_number', 'sum'], fields: [null, 'n'], as: ['rn', 'cs'] }], xf: 'rn', yf: 'cs' },
  { name: 'window-ci', tr: [{ type: 'window', groupby: ['g'], sort: { field: 'x' }, ops: ['ci0'], fields: ['v'], as: ['c0'] }], xf: 'x', yf: 'c0', cf: 'g' },
  { name: 'stack-center', tr: [{ type: 'stack', groupby: ['g'], field: 'v', offset: 'center', sort: { field: 'x' }, as: ['y0', 'y1'] }], xf: 'x', yf: 'y1', cf: 'g' },
  { name: 'stack-normalize', tr: [{ type: 'stack', groupby: ['x'], field: 'n', offset: 'normalize', as: ['y0', 'y1'] }], xf: 'x', yf: 'y1', cf: 'g' },
  { name: 'stack-zero-sort-desc', tr: [{ type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'g', order: 'descending' }, as: ['y0', 'y1'] }], xf: 'x', yf: 'y1', cf: 'g' },
  { name: 'impute-mean', tr: [{ type: 'impute', field: 'v', key: 'x', groupby: ['g'], keyvals: [0, 1, 2, 3, 4, 5], method: 'mean' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'impute-value', tr: [{ type: 'impute', field: 'n', key: 'x', keyvals: [0, 5, 10], value: 7 }], xf: 'x', yf: 'n' },
  { name: 'sample', tr: [{ type: 'sample', size: 4 }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'identifier-falsy', tr: [{ type: 'identifier', as: 'x' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'project', tr: [{ type: 'project', fields: ['x', 'v', 'g'], as: ['px', 'pv', 'pg'] }], xf: 'px', yf: 'pv', cf: 'pg' },
  { name: 'project-all', tr: [{ type: 'project' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'pivot', tr: [{ type: 'pivot', field: 'g', value: 'v', groupby: ['x'], op: 'sum' }], xf: 'x', yf: 'x' },
  { name: 'lookup-self-last-wins', tr: [{ type: 'lookup', from: 't', key: 'x', fields: ['x'], values: ['v', 'g'], as: ['lv', 'lg'], default: -1 }], xf: 'x', yf: 'lv', cf: 'lg', skipSource: true },
  { name: 'lookup-row', tr: [{ type: 'lookup', from: 'u', key: 'g', fields: ['g'], as: ['urow'], default: null }, { type: 'formula', expr: 'datum.urow ? datum.urow.w : -1', as: 'w' }], xf: 'w', yf: 'v', cf: 'g' },
  { name: 'timeunit-units', tr: [{ type: 'formula', expr: 'datetime(2020, datum.x, 1 + datum.y, datum.v)', as: 'dt' }, { type: 'timeunit', field: 'dt', units: ['month', 'date'], as: ['u0', 'u1'] }, { type: 'formula', expr: 'datum.u1 - datum.u0', as: 'ux' }], xf: 'ux', yf: 'v', cf: 'g' },
  { name: 'timeunit-utc-year-month', tr: [{ type: 'formula', expr: 'datetime(2000 + datum.x * 3, datum.y, 15)', as: 'dt' }, { type: 'timeunit', field: 'dt', units: ['year', 'month'], timezone: 'utc', as: ['u0', 'u1'] }, { type: 'formula', expr: 'datum.u1 - datum.u0', as: 'ux' }], xf: 'ux', yf: 'v' },
  { name: 'timeunit-data-derived', tr: [{ type: 'formula', expr: 'datetime(2020, datum.x, 1 + datum.y)', as: 'dt' }, { type: 'timeunit', field: 'dt', maxbins: 6, as: ['u0', 'u1'] }, { type: 'formula', expr: 'datum.u1 - datum.u0', as: 'ux' }], xf: 'ux', yf: 'v', cf: 'g' },
  { name: 'bin-strings', tr: [{ type: 'bin', field: 's', extent: [0, 20], maxbins: 5, as: ['b0', 'b1'] }], xf: 'b0', yf: 'v', cf: 'g' },
  { name: 'collect-null-sort', tr: [{ type: 'collect', sort: { field: ['n', 'v'], order: ['descending', 'ascending'] } }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'fold-flatten-nested', tr: [{ type: 'flatten', fields: ['o.b'], as: ['bv'] }], xf: 'x', yf: 'bv', cf: 'g' },
]

export interface GenSpec {
  spec: Record<string, unknown>
  /** Human-readable summary of the generated features (printed on failure). */
  label: string
  /** Inline `values` in the spec (true) or only via `input.data` (false). */
  inlineValues: boolean
  /** A selection store dataset `sel` the scenario edits (see `scenarioSel`): field tuples, or `_vgsid_` ids. */
  store?: 'fields' | 'ids'
  /** The scope ids of the two group scopes `scenarioScoped` adds (outer, and the one nested in it). */
  scoped?: { outer: string; inner: string }
}

function genSpec(r: Rnd): GenSpec {
  const pipe = pick(r, PIPES)
  const onSource = pipe.tr.length > 0 && !pipe.skipSource && r() < 0.35
  const ds = onSource ? 't' : pipe.tr.length ? 'd' : 't'
  const inlineValues = r() < 0.5
  const features: string[] = [`pipe=${pipe.name}${onSource ? '@source' : ''}`]

  const data: Array<Record<string, unknown>> = []
  const t: Record<string, unknown> = { name: 't' }
  if (inlineValues) t.values = []
  if (onSource) t.transform = clone(pipe.tr)
  data.push(t)
  const u: Record<string, unknown> = { name: 'u' }
  if (inlineValues) u.values = []
  data.push(u)
  if (!onSource && pipe.tr.length) data.push({ name: 'd', source: 't', transform: clone(pipe.tr) })

  // Scales ---------------------------------------------------------------
  const xdomKind = pick(r, ['data', 'data', 'fixed', 'multi', 'signal'] as const)
  const ydomKind = pick(r, ['data', 'data', 'fixed', 'multi'] as const)
  const dom = (kind: string, field: string, fixed: number[], other: { data: string; field: string }): unknown =>
    kind === 'data' ? { data: ds, field }
      : kind === 'fixed' ? fixed
        : kind === 'signal' ? { signal: 'lim' }
          : { fields: [{ data: ds, field }, other] }
  features.push(`xdom=${xdomKind}`, `ydom=${ydomKind}`)
  const nice = r() < 0.4
  const scales: Array<Record<string, unknown>> = [
    { name: 'x', type: 'linear', domain: dom(xdomKind, pipe.xf, [0, 30], { data: 't', field: 'x' }), range: r() < 0.25 ? { signal: 'rng' } : 'width', nice },
    { name: 'y', type: 'linear', domain: dom(ydomKind, pipe.yf, [0, 40], { data: 't', field: 'v' }), range: 'height', zero: true, nice: r() < 0.4 },
  ]
  if (pipe.cf) {
    scales.push({ name: 'bx', type: r() < 0.7 ? 'band' : 'point', domain: { data: ds, field: pipe.cf }, range: 'width', padding: 0.1 })
    scales.push({ name: 'color', type: 'ordinal', domain: { data: ds, field: pipe.cf, sort: r() < 0.5 }, range: 'category' })
  }

  // Marks ----------------------------------------------------------------
  const xy = (dataset: string, xf: string, yf: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ x: { scale: 'x', field: xf }, y: { scale: 'y', field: yf }, ...extra })
  const fillFor = pipe.cf ? { fill: { scale: 'color', field: pipe.cf } } : { fill: { value: '#4c78a8' } }
  // Marks whose encode reads a signal directly (not only through a scale).
  const sigSize = r() < 0.4
  const sym = (dataset: string): Record<string, unknown> => ({
    type: 'symbol', from: { data: dataset },
    encode: { update: { ...xy(dataset, pipe.xf, pipe.yf), size: sigSize ? { signal: '10 + sig * 5' } : { value: 30 }, ...fillFor } },
  })
  const txt = (dataset: string): Record<string, unknown> => ({
    type: 'text', from: { data: dataset },
    encode: { update: { ...xy(dataset, pipe.xf, pipe.yf), text: { field: pipe.yf }, dy: { value: -4 }, fontSize: { value: 9 } } },
  })
  const line = (dataset: string, sortField?: string): Record<string, unknown> => ({
    type: 'line', from: { data: dataset },
    ...(sortField ? { sort: { field: sortField } } : {}),
    encode: { update: { ...xy(dataset, pipe.xf, pipe.yf), stroke: { value: '#333' } } },
  })
  const rect = (dataset: string): Record<string, unknown> => ({
    type: 'rect', from: { data: dataset },
    encode: { update: { x: { scale: 'bx', field: pipe.cf }, width: { scale: 'bx', band: 1 }, y: { scale: 'y', field: pipe.yf }, y2: { scale: 'y', value: 0 }, ...fillFor } },
  })

  const marks: Array<Record<string, unknown>> = []
  const layered = r() < 0.55
  const primary = pick(r, pipe.cf ? ['symbol', 'symbol', 'rect', 'line'] : ['symbol', 'symbol', 'line'])
  features.push(`primary=${primary}`)
  if (primary === 'symbol') marks.push(sym(ds))
  else if (primary === 'rect') marks.push(rect(ds))
  else marks.push(line(ds, r() < 0.5 ? pipe.xf : undefined))
  if (layered) {
    // Layered marks over ONE shared dataset (symbol + text), the classic
    // labels-over-points chart (C4).
    marks.push(txt(ds))
    features.push('layered(text)')
    if (r() < 0.4) { marks.push(sym(ds)); features.push('layered(sym2)') }
  }
  const nested = pick(r, ['none', 'none', 'group', 'facet', 'scoped', 'other', 'umark'] as const)
  features.push(`nested=${nested}`)
  if (nested === 'group') {
    marks.push({ type: 'group', marks: [sym(ds), txt(ds)] })
  } else if (nested === 'facet' && pipe.cf) {
    marks.push({
      type: 'group',
      from: { facet: { name: 'fc', data: ds, groupby: [pipe.cf] } },
      marks: [{ ...line('fc'), from: { data: 'fc' } }, { ...sym('fc'), from: { data: 'fc' } }],
    })
  } else if (nested === 'scoped') {
    marks.push({
      type: 'group',
      encode: { update: { width: { value: 120 }, height: { value: 80 } } },
      scales: [{ name: 'sx', type: 'linear', domain: [0, 10], range: 'width' }],
      axes: [{ scale: 'sx', orient: 'bottom' }],
      marks: [sym(ds)],
    })
  } else if (nested === 'umark') {
    // A mark over an UNRELATED dataset positioned by a scale whose domain spans
    // the changed data: the whole group must not be reused with stale positions.
    marks.push({
      type: 'symbol', from: { data: 'u' },
      encode: { update: { x: { scale: 'x', field: 'w' }, y: { scale: 'y', field: 'w' }, size: { value: 12 }, fill: { value: '#54a24b' } } },
    })
  } else if (nested === 'other') {
    // A mark over a DIFFERENT dataset sharing the same scales.
    marks.push({
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { value: 14 }, fill: { value: '#e45756' } } },
    })
  }

  const axes: Array<Record<string, unknown>> = [
    { scale: 'x', orient: 'bottom', grid: r() < 0.3 },
    { scale: 'y', orient: 'left' },
  ]
  const legends: Array<Record<string, unknown>> = pipe.cf && r() < 0.35 ? [{ fill: 'color' }] : []
  if (legends.length) features.push('legend')

  const autosize = pick(r, ['none', 'pad', 'pad', 'fit'] as const)
  features.push(`autosize=${autosize}`)
  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: pick(r, [200, 260, 320]), height: pick(r, [160, 200, 240]), padding: 5, autosize,
    signals: [
      { name: 'sig', value: 3 },
      { name: 'thr', update: 'sig + 1' },
      { name: 'rng', update: '[0, width]' },
      { name: 'lim', update: '[0, 10 + sig]' },
    ],
    data, scales, axes, legends, marks,
  }
  if (r() < 0.2) {
    spec.title = { text: 'oracle' }
    features.push('title')
  }
  return { spec, label: features.join(' '), inlineValues }
}

// ---------------------------------------------------------------------------
// World + steps
// ---------------------------------------------------------------------------

interface World { t: Row[]; u: Row[]; sel: Row[]; /** the store holds `_vgsid_` ids (else field tuples) */ selIds?: boolean; /** the values the events wrote to the signals of the two group scopes (see `scenarioScoped`) */ scoped?: { outer: number; inner: number }; sig: number; width: number | undefined; height: number | undefined }

const GROUPS = ['A', 'B', 'C', 'D'] as const

function genRow(r: Rnd): Row {
  const n = pick(r, [2, 2, 2, 1, 3])
  return {
    ...oddFields(int(r, 0, 10), int(r, 0, 20)),
    y: int(r, 0, 10), g: pick(r, GROUPS),
    arr: Array.from({ length: n }, () => int(r, 0, 10)),
  }
}

/** x, v plus the fields the new pipes read: a nested copy `o`, a numeric string `s` and a nullable number `n`. */
function oddFields(x: number, v: number): Row {
  return { x, v, o: { a: x, b: [v] }, s: String(v), n: v % 5 === 0 ? null : v }
}

function genWorld(r: Rnd): World {
  const n = int(r, 3, 9)
  const keys = [...GROUPS].filter(() => r() < 0.85)
  return {
    t: Array.from({ length: n }, () => genRow(r)),
    u: keys.map((g) => ({ g, w: int(r, 1, 12) })),
    sel: [], sig: 3, width: undefined, height: undefined,
  }
}

type Op = 'edit' | 'grow' | 'shrink' | 'insert' | 'remove' | 'append' | 'truncate' | 'swap' | 'shuffle'
  | 'replaceAll' | 'editU' | 'signal' | 'size' | 'noop' | 'edit-group' | 'store' | 'scoped'
type Delivery = 'none' | 'changedDatasets' | 'dataChanges' | 'dataPulse' | 'inplace'
type Via = 'evaluate' | 'change'

interface Step { op: Op; delivery: Delivery; via: Via; r: number[] }

const OPS: Op[] = ['edit', 'edit', 'grow', 'shrink', 'shrink', 'insert', 'remove', 'append', 'append', 'truncate',
  'swap', 'shuffle', 'replaceAll', 'editU', 'signal', 'size', 'noop', 'edit-group']

function genStep(r: Rnd): Step {
  return {
    op: pick(r, OPS),
    delivery: pick(r, ['none', 'changedDatasets', 'dataChanges', 'dataPulse', 'dataPulse', 'inplace'] as const),
    via: r() < 0.2 ? 'change' : 'evaluate',
    r: Array.from({ length: 8 }, () => r()),
  }
}

const ix = (x: number, n: number): number => (n <= 0 ? 0 : Math.min(n - 1, Math.floor(x * n)))

/** Apply a step to a world, purely (new arrays, new row objects for changed rows). */
export function applyStep(w: World, s: Step): World {
  const next: World = { ...w, t: w.t.slice(), u: w.u.slice(), sel: w.sel.slice() }
  const t = next.t
  const maxV = t.reduce((m, row) => Math.max(m, Number(row.v)), 0)
  const maxX = t.reduce((m, row) => Math.max(m, Number(row.x)), 0)
  const rowAt = (k: number): Row => ({
    ...oddFields(Math.floor(s.r[(k + 2) % 8]! * 11), Math.floor(s.r[(k + 4) % 8]! * 21)), y: Math.floor(s.r[(k + 3) % 8]! * 11),
    g: GROUPS[Math.floor(s.r[(k + 5) % 8]! * 4)]!, arr: Array.from({ length: 1 + Math.floor(s.r[(k + 6) % 8]! * 3) }, (_, i) => (i * 3 + k) % 11),
  })
  switch (s.op) {
    case 'edit': {
      const k = 1 + Math.floor(s.r[0]! * 3)
      for (let j = 0; j < k && t.length; j++) {
        const i = ix(s.r[(j + 1) % 8]!, t.length)
        t[i] = { ...t[i]!, ...rowAt(j), g: s.r[7]! < 0.5 ? t[i]!.g : rowAt(j).g }
      }
      break
    }
    case 'grow': {
      if (t.length) {
        const i = ix(s.r[0]!, t.length)
        t[i] = { ...t[i]!, v: maxV + 1 + Math.floor(s.r[1]! * 6), x: maxX + 1 + Math.floor(s.r[2]! * 4) }
      }
      break
    }
    case 'shrink': {
      // Move rows that hold the extreme values back into the interior: the
      // domain census must shrink with them.
      const hi = t.reduce((best, row, i) => (Number(row.v) >= Number(t[best]!.v) ? i : best), 0)
      const lo = t.reduce((best, row, i) => (Number(row.x) <= Number(t[best]!.x) ? i : best), 0)
      if (t.length) {
        t[hi] = { ...t[hi]!, v: Math.floor(s.r[0]! * 4), x: Math.floor(s.r[1]! * 4) }
        if (s.r[2]! < 0.5) t[lo] = { ...t[lo]!, x: 5 + Math.floor(s.r[3]! * 5) }
      }
      break
    }
    case 'insert': {
      const k = 1 + Math.floor(s.r[0]! * 3)
      const at = Math.floor(s.r[1]! * (t.length + 1))
      t.splice(at, 0, ...Array.from({ length: k }, (_, j) => rowAt(j)))
      break
    }
    case 'remove': {
      const k = Math.min(t.length - 1, 1 + Math.floor(s.r[0]! * 2))
      for (let j = 0; j < k; j++) t.splice(ix(s.r[(j + 1) % 8]!, t.length), 1)
      break
    }
    case 'append': {
      const k = 1 + Math.floor(s.r[0]! * 3)
      for (let j = 0; j < k; j++) t.push(rowAt(j))
      break
    }
    case 'truncate': {
      const k = Math.min(t.length - 1, 1 + Math.floor(s.r[0]! * 2))
      t.length = t.length - Math.max(0, k)
      break
    }
    case 'swap': {
      if (t.length > 1) {
        const a = ix(s.r[0]!, t.length), b = ix(s.r[1]!, t.length)
        const tmp = t[a]!; t[a] = t[b]!; t[b] = tmp
      }
      break
    }
    case 'shuffle': {
      for (let i = t.length - 1; i > 0; i--) {
        const j = Math.floor(s.r[i % 8]! * (i + 1))
        const tmp = t[i]!; t[i] = t[j]!; t[j] = tmp
      }
      break
    }
    case 'replaceAll': {
      const n = 2 + Math.floor(s.r[0]! * 8)
      t.length = 0
      for (let j = 0; j < n; j++) t.push(rowAt(j + Math.floor(s.r[1]! * 5)))
      break
    }
    case 'edit-group': {
      // Move one row to another group: membership change for grouped transforms.
      if (t.length) {
        const i = ix(s.r[0]!, t.length)
        t[i] = { ...t[i]!, g: GROUPS[Math.floor(s.r[1]! * 4)]! }
      }
      break
    }
    case 'editU': {
      const u = next.u
      if (u.length) {
        const i = ix(s.r[0]!, u.length)
        if (s.r[1]! < 0.3 && u.length > 1) u.splice(i, 1)
        else u[i] = { ...u[i]!, w: 1 + Math.floor(s.r[2]! * 12) }
      }
      if (s.r[3]! < 0.3) {
        const g = GROUPS[Math.floor(s.r[4]! * 4)]!
        if (!u.some((row) => row.g === g)) u.push({ g, w: 1 + Math.floor(s.r[5]! * 12) })
      }
      break
    }
    case 'signal': {
      next.sig = Math.floor(s.r[0]! * 9)
      // Often together with a data edit: reuse must notice the signal anyway.
      if (s.r[7]! < 0.6 && t.length) { const i = ix(s.r[6]!, t.length); t[i] = { ...t[i]!, ...rowAt(1), g: t[i]!.g } }
      break
    }
    case 'size': {
      next.width = s.r[0]! < 0.2 ? undefined : 150 + Math.floor(s.r[0]! * 200)
      next.height = s.r[1]! < 0.2 ? undefined : 120 + Math.floor(s.r[1]! * 160)
      if (s.r[7]! < 0.6 && t.length) { const i = ix(s.r[6]!, t.length); t[i] = { ...t[i]!, ...rowAt(2), g: t[i]!.g } }
      break
    }
    case 'scoped': {
      // an event wrote the signals of the group scopes; often together with a data edit (reuse must notice the signal anyway)
      next.scoped = { outer: Math.floor(s.r[0]! * 7), inner: Math.floor(s.r[1]! * 7) }
      if (s.r[7]! < 0.5 && t.length) { const i = ix(s.r[6]!, t.length); t[i] = { ...t[i]!, ...rowAt(3), g: t[i]!.g } }
      break
    }
    case 'store': {
      // A `modify(sel, ...)` as vega-lite's selections issue it: replace with one tuple, add one (a shift-click),
      // toggle one, replace within a unit, or clear. The edit is the dataflow's own (modify.ts).
      const mode = Math.floor(s.r[0]! * 6)
      const ids = w.selIds === true
      const tuple = (k: number): Row => (ids
        ? { unit: s.r[(k + 5) % 8]! < 0.3 ? 'u2' : '', _vgsid_: 1 + Math.floor(s.r[(k + 1) % 8]! * 9) }
        : s.r[(k + 2) % 8]! < 0.5
          ? { unit: '', fields: [{ field: 'g', type: 'E' }], values: [GROUPS[Math.floor(s.r[(k + 3) % 8]! * 4)]!] }
          : { unit: '', fields: [{ field: 'x', type: 'R' }], values: [[Math.floor(s.r[(k + 3) % 8]! * 6), 5 + Math.floor(s.r[(k + 4) % 8]! * 8)]] })
      let cs: Changeset | null = null
      const changes = (): Changeset => (cs ??= newChangeset())
      const rows = next.sel
      const mod = (insert: unknown, remove: unknown, toggle: unknown): void => { planModify(rows, changes, insert, remove, toggle, null, null) }
      if (mode === 0) mod(tuple(0), true, null)
      else if (mode === 1) mod(tuple(1), null, null)
      else if (mode === 2) mod(null, null, tuple(2))
      else if (mode === 3 && rows.length) mod(null, null, { ...rows[Math.floor(s.r[1]! * rows.length)]! })
      else if (mode === 4) mod(tuple(3), { unit: 'u2' }, null)
      else mod(null, true, null)
      next.sel = cs ? (applyChangeset(rows, cs) as Row[]) : rows
      break
    }
    case 'noop': break
  }
  return next
}

// ---------------------------------------------------------------------------
// Scene normalisation + comparison
// ---------------------------------------------------------------------------

// Non-serialised internals and run-dependent bookkeeping. `__scales` (the
// resolved-scale snapshot) is deliberately KEPT: a stale scale must show up.
const SKIP_KEYS = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])

function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined) return undefined
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}

function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: expected ${JSON.stringify(a)?.slice(0, 120)} got ${JSON.stringify(b)?.slice(0, 120)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length expected ${a.length} got ${b.length}`
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d }
    return null
  }
  const ak = Object.keys(a as object), bk = Object.keys(b as object)
  for (const k of new Set([...ak, ...bk])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

function sceneKey(scene: SceneRoot): { norm: unknown; svg: string } {
  return { norm: norm(scene), svg: renderSceneToSvg(scene) }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The signals the host stores for the group scopes of a scenario: what the event loop writes as `<scope id>:<name>`. */
function scopedSignals(g: GenSpec, w: World): Record<string, unknown> {
  if (!g.scoped || !w.scoped) return {}
  return { [scopedSignalName(g.scoped.outer, 'gs')]: w.scoped.outer, [scopedSignalName(g.scoped.inner, 'gs')]: w.scoped.inner }
}

export function inputOf(g: GenSpec, w: World): RuntimeInput {
  const input: RuntimeInput = { signals: { sig: w.sig, ...scopedSignals(g, w) } }
  if (w.width != null) input.width = w.width
  if (w.height != null) input.height = w.height
  input.data = { t: clone(w.t), u: clone(w.u), ...(g.store ? { sel: clone(w.sel) } : {}) }
  return input
}

function reference(g: GenSpec, w: World): SceneRoot | Error {
  try {
    const spec = clone(g.spec)
    // The reference sees the SAME visible state: data via input.data, always.
    return evaluateChart(compileChart(spec as never), inputOf(g, w))
  } catch (e) {
    return e as Error
  }
}

function toDataPulse(d: RowDiff): NonNullable<RuntimeInput['dataPulse']>[string] {
  return {
    changed: d.changed,
    ...(d.from ? { from: d.from } : {}),
    ...(d.to ? { to: d.to } : {}),
    ...(d.addedRanges ? { added: d.addedRanges } : {}),
    ...(d.removedRanges ? { removed: d.removedRanges } : {}),
    ...(d.appendOnly ? { appendOnly: true, baseLength: d.baseLength } : {}),
  }
}

/** Truthful change hints for a step, given the previous and next worlds. */
function hintsFor(s: Step, prev: World, next: World): Partial<RuntimeInput> {
  const hints: Partial<RuntimeInput> = {}
  const touched: Array<'t' | 'u' | 'sel'> = []
  for (const name of ['t', 'u', 'sel'] as const) {
    const a = prev[name], b = next[name]
    if (a.length !== b.length || b.some((row, i) => row !== a[i])) touched.push(name)
  }
  if (!touched.length) return hints
  if (s.delivery === 'none') return hints
  if (s.delivery === 'changedDatasets') { hints.changedDatasets = touched; return hints }
  const changes: Record<string, number[]> = {}
  const pulses: NonNullable<RuntimeInput['dataPulse']> = {}
  const structural: string[] = []
  for (const name of touched) {
    const d = diffRows(prev[name], next[name])
    if (!d) { structural.push(name); continue }
    if (d.sameLength && s.delivery !== 'dataPulse') { changes[name] = d.changed; continue }
    if (s.delivery === 'dataChanges') { structural.push(name); continue }
    pulses[name] = toDataPulse(d)
  }
  if (Object.keys(changes).length) hints.dataChanges = changes
  if (Object.keys(pulses).length) hints.dataPulse = pulses
  if (structural.length) hints.changedDatasets = structural
  return hints
}

export interface Failure {
  seed: number
  target: string
  step: number
  op: string
  where: string
  detail: string
}

interface RunResult { failure: Failure | null; steps: number }

/**
 * Run one generated scenario against one target and compare every step with the
 * fresh reference. Returns the first failure.
 */
function run(target: 'chart' | 'session', g: GenSpec, world0: World, steps: Step[], seed: number): RunResult {
  const fail = (step: number, op: string, where: string, detail: string): RunResult => ({ failure: { seed, target, step, op, where, detail }, steps: step })
  let world = world0
  // Previously returned scenes must never change under the caller (C52).
  const retained: Array<{ scene: SceneRoot; key: ReturnType<typeof sceneKey>; step: number }> = []

  const compare = (stepNo: number, op: string, actual: SceneRoot | Error, w: World): RunResult | null => {
    const ref = reference(g, w)
    if (ref instanceof Error || actual instanceof Error) {
      const a = actual instanceof Error ? actual.message : 'ok'
      const b = ref instanceof Error ? ref.message : 'ok'
      return a === b ? null : fail(stepNo, op, 'error', `reference: ${b}; incremental: ${a}`)
    }
    const want = sceneKey(ref)
    const got = sceneKey(actual)
    const d = firstDiff(want.norm, got.norm)
    if (d) return fail(stepNo, op, 'scene', d)
    if (want.svg !== got.svg) return fail(stepNo, op, 'svg', 'serialised SVG differs although the normalised scenes are equal')
    // Earlier returned scenes must read exactly as they did when returned, in
    // ANY read order (the engine hands superseded groups lazy snapshots):
    // oldest first, newest first, or not at all until much later.
    const mode = stepNo % 3
    if (mode !== 2) {
      const order = mode === 0 ? retained.slice() : retained.slice().reverse()
      for (const old of order) {
        const dd = firstDiff(old.key.norm, sceneKey(old.scene).norm)
        if (dd) return fail(stepNo, op, `retained scene from step ${old.step} mutated`, dd)
      }
    }
    retained.push({ scene: actual, key: got, step: stepNo })
    return null
  }

  /** Final audit: scenes that were never re-read, in pseudo-random order. */
  const finalAudit = (): RunResult | null => {
    const order = retained.map((_, i) => i).sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13) || a - b)
    for (const i of order) {
      const old = retained[i]!
      const dd = firstDiff(old.key.norm, sceneKey(old.scene).norm)
      if (dd) return fail(old.step, 'final audit', `retained scene from step ${old.step} mutated`, dd)
    }
    return null
  }

  const attempt = (fn: () => SceneRoot | null): SceneRoot | Error => {
    try {
      const s = fn()
      return s ?? new Error('null scene')
    } catch (e) {
      return e as Error
    }
  }

  if (target === 'chart') {
    const chart = compileChart(clone(g.spec) as never)
    const live = { t: clone(world.t), u: clone(world.u), sel: clone(world.sel) }
    // The compiled IR must stay byte-identical across every evaluation (C12/C17).
    const irAtCompile = JSON.stringify(chart)
    const irCheck = (stepNo: number, op: string): RunResult | null => {
      const now = JSON.stringify(chart)
      return now === irAtCompile ? null : fail(stepNo, op, 'compiled IR mutated by evaluateChart', firstDiff(JSON.parse(irAtCompile), JSON.parse(now)) ?? '')
    }
    const first = attempt(() => evaluateChart(chart, { ...inputOf(g, world), data: { t: live.t, u: live.u, ...(g.store ? { sel: live.sel } : {}) } }))
    const r0 = compare(-1, 'init', first, world) ?? irCheck(-1, 'init')
    if (r0) return r0
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      const prev = world
      world = applyStep(world, s)
      const base = inputOf(g, world)
      const hints = hintsFor(s, prev, world)
      const input: RuntimeInput = { ...base, ...hints }
      if (s.delivery === 'inplace') {
        // Mutate the previous arrays IN PLACE (the bench / host pattern): the
        // same array identity carries the new rows, announced via the hints.
        for (const name of ['t', 'u', 'sel'] as const) {
          const arr = live[name]
          arr.length = 0
          for (const row of world[name]) arr.push(clone(row))
        }
        input.data = { t: live.t, u: live.u, ...(g.store ? { sel: live.sel } : {}) }
      } else {
        live.t = clone(world.t)
        live.u = clone(world.u)
        live.sel = clone(world.sel)
      }
      const scene = attempt(() => evaluateChart(chart, input))
      const r = compare(i, `${s.op}/${s.delivery}`, scene, world) ?? irCheck(i, s.op)
      if (r) return r
    }
    return finalAudit() ?? { failure: null, steps: steps.length }
  }

  // session target
  const session = createChartSession()
  const specFor = (w: World): Record<string, unknown> => {
    const spec = clone(g.spec)
    if (g.inlineValues) {
      for (const d of spec.data as Array<Record<string, unknown>>) {
        if (d.name === 't') d.values = clone(w.t)
        if (d.name === 'u') d.values = clone(w.u)
        if (d.name === 'sel') d.values = clone(w.sel)
      }
    }
    return spec
  }
  const sessionInput = (w: World, extra: Partial<RuntimeInput>): RuntimeInput => {
    const input: RuntimeInput = { signals: { sig: w.sig, ...scopedSignals(g, w) }, ...extra }
    if (w.width != null) input.width = w.width
    if (w.height != null) input.height = w.height
    if (!g.inlineValues || extra.dataChanges || extra.dataPulse) input.data = { t: clone(w.t), u: clone(w.u), ...(g.store ? { sel: clone(w.sel) } : {}) }
    return input
  }
  const first = attempt(() => session.evaluate(specFor(world) as never, sessionInput(world, {})))
  const irAtCompile = JSON.stringify(session.last()?.chart ?? null)
  const irCheck = (stepNo: number, op: string): RunResult | null => {
    const now = JSON.stringify(session.last()?.chart ?? null)
    return now === irAtCompile ? null : fail(stepNo, op, 'compiled IR mutated by the session', firstDiff(JSON.parse(irAtCompile), JSON.parse(now)) ?? '')
  }
  const r0 = compare(-1, 'init', first, world) ?? irCheck(-1, 'init')
  if (r0) return r0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    const prev = world
    world = applyStep(world, s)
    const hints = hintsFor(s, prev, world)
    // The session auto-diffs by default; only 'dataChanges'/'dataPulse' are
    // passed through as explicit hints, 'none' leaves it to the auto-diff.
    const extra: Partial<RuntimeInput> = {}
    if (hints.dataChanges) extra.dataChanges = hints.dataChanges
    if (hints.dataPulse) extra.dataPulse = hints.dataPulse
    if (s.delivery === 'changedDatasets' && hints.changedDatasets) extra.autoChanges = false
    let scene: SceneRoot | Error
    if (s.via === 'change') {
      // `change()` re-evaluates the last compiled chart: it must be handed the
      // complete state (data, signals, size), exactly like a host would.
      const input = { ...sessionInput(world, extra), data: { t: clone(world.t), u: clone(world.u), ...(g.store ? { sel: clone(world.sel) } : {}) } }
      scene = attempt(() => session.change(input))
    } else {
      scene = attempt(() => session.evaluate(specFor(world) as never, sessionInput(world, extra)))
    }
    let r = compare(i, `${s.op}/${s.delivery}/${s.via}`, scene, world) ?? irCheck(i, s.op)
    if (r) return r
    // The no-op cache: re-evaluating the identical state must be correct too,
    // with fresh equal arrays and with the very same inputs.
    if (s.op === 'noop' || i % 3 === 1) {
      const again = attempt(() => session.evaluate(specFor(world) as never, sessionInput(world, {})))
      r = compare(i, `${s.op}/re-evaluate`, again, world)
      if (r) return r
    }
  }
  return finalAudit() ?? { failure: null, steps: steps.length }
}

export function scenario(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const r = mulberry32(seed)
  const g = genSpec(r)
  const world = genWorld(r)
  const steps = Array.from({ length: nSteps }, () => genStep(r))
  return { g, world, steps }
}

/**
 * The same scenarios with a selection store: a dataset `sel` (vega-lite's `<name>_store`: field tuples, or `_vgsid_`
 * ids kept sorted by a `collect`) that the pipeline filters by (`vlSelectionTest` / `vlSelectionIdTest`), a mark
 * highlights by, and a derived signal resolves (`vlSelectionResolve`), edited by `modify`-style updates between the
 * data edits, signal changes and resizes the base scenario already has.
 */
export function scenarioSel(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const base = scenario(seed, nSteps)
  const r = mulberry32(seed ^ 0x5e1ec7)
  const ids = r() < 0.5
  const spec = base.g.spec
  const data = spec.data as Array<Record<string, unknown>>
  const op = pick(r, ['union', 'intersect'] as const)
  const test = ids ? 'vlSelectionIdTest("sel", datum)' : `vlSelectionTest("sel", datum, "${op}")`
  const features = [`sel=${ids ? 'ids' : 'fields'}${ids ? '' : '/' + op}`]
  data.unshift({
    name: 'sel',
    ...(base.g.inlineValues ? { values: [] } : {}),
    ...(ids ? { transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] } : {}),
  })
  const t = data.find((d) => d.name === 't')!
  const head: Array<Record<string, unknown>> = ids ? [{ type: 'identifier', as: '_vgsid_' }] : []
  const kinds = { filter: r() < 0.5, encode: r() < 0.7, signal: r() < 0.5 }
  if (!kinds.filter && !kinds.encode && !kinds.signal) kinds.encode = true
  if (kinds.filter) {
    // guarded the way vega-lite writes it, or the bare test (which reads the store only through its own function)
    head.push({ type: 'filter', expr: r() < 0.5 ? `!length(data("sel")) || ${test}` : test })
    features.push('filter')
  }
  if (head.length) t.transform = [...head, ...((t.transform as Array<Record<string, unknown>> | undefined) ?? [])]
  const marks = spec.marks as Array<Record<string, unknown>>
  const first = marks.find((m) => (m.encode as { update?: Record<string, unknown> } | undefined)?.update?.fill !== undefined)
  if (first && kinds.encode) {
    const upd = (first.encode as { update: Record<string, unknown> }).update
    upd.fill = [{ test: r() < 0.5 ? `length(data("sel")) && ${test}` : test, value: '#e45756' }, ...([] as unknown[]).concat(upd.fill)]
    upd.opacity = [{ test, value: 1 }, { value: 0.45 }]
    features.push('encode')
  }
  if (first && kinds.signal) {
    ;(spec.signals as Array<Record<string, unknown>>).push({ name: 'selres', update: 'vlSelectionResolve("sel", "union", true, true)' })
    const upd = (first.encode as { update: Record<string, unknown> }).update
    upd.strokeWidth = { signal: 'isObject(selres) && selres.vlPoint ? 1 + length(selres.vlPoint.or) : 1' }
    upd.stroke = { value: '#333' }
    features.push('resolve')
  }
  base.g.label += ' ' + features.join(' ')
  base.g.store = ids ? 'ids' : 'fields'
  const steps = base.steps.map((s) => (r() < 0.4 ? { ...s, op: 'store' as const } : s))
  return { g: base.g, world: { ...base.world, selIds: ids }, steps }
}

/**
 * The same scenarios with group scopes: a group mark declaring signals (one derived from the view's `sig`), whose marks read
 * them, with a second scope nested in it that shadows one. The steps write the scopes' signals the way the event loop does
 * (`<scope id>:gs` in the signal store), between the data edits, signal changes and resizes the base scenario already has.
 */
export function scenarioScoped(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const base = scenario(seed, nSteps)
  const r = mulberry32(seed ^ 0x5c09ed)
  const spec = base.g.spec
  const xs = (spec.scales as Array<{ name: string }>).some((sc) => sc.name === 'x') && (spec.scales as Array<{ name: string }>).some((sc) => sc.name === 'y')
  const group = {
    type: 'group', name: 'sc_outer', signals: [{ name: 'gs', value: 2 }, { name: 'gd', update: 'gs * 2 + sig' }],
    encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 120 }, height: { value: 80 }, fill: { value: '#eee' } } },
    marks: [
      ...(xs ? [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { signal: '10 + gs * 30 + gd' }, fill: { signal: 'gd > 6 ? "#c33" : "#33c"' } } } }] : []),
      {
        type: 'group', name: 'sc_inner', signals: [{ name: 'gs', value: 1 }],
        encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 60 }, height: { value: 40 }, stroke: { value: '#999' } } },
        marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: '10 + gs * 8' }, height: { value: 10 }, fill: { value: '#6a6' } } } }],
      },
    ],
  }
  ;(spec.marks as unknown[]).push(group)
  // the scope ids the compiled chart gives them: the marks' places in the spec
  const chart = compileChart(clone(spec) as never)
  const outerMark = chart.marks.find((m) => m.name === 'sc_outer')!
  const innerMark = outerMark.marks!.find((m) => m.name === 'sc_inner')!
  const outer = `sc_outer@${outerMark.seq}`
  base.g.scoped = { outer, inner: `${outer}/sc_inner@${innerMark.seq}` }
  base.g.label += ' scoped'
  const steps = base.steps.map((s) => (r() < 0.4 ? { ...s, op: 'scoped' as const } : s))
  return { g: base.g, world: { ...base.world, scoped: { outer: 2, inner: 1 } }, steps }
}

/** Greedy delta-debugging: drop steps while the failure persists. */
function shrink(target: 'chart' | 'session', g: GenSpec, world: World, steps: Step[], seed: number): Step[] {
  let cur = steps
  const fails = (s: Step[]): boolean => run(target, g, world, s, seed).failure !== null
  for (let pass = 0; pass < 2; pass++) {
    for (let i = cur.length - 1; i >= 0; i--) {
      const trial = cur.slice(0, i).concat(cur.slice(i + 1))
      if (fails(trial)) cur = trial
    }
  }
  return cur
}

export function checkSeed(seed: number, nSteps: number, make: typeof scenario = scenario): string | null {
  const { g, world, steps } = make(seed, nSteps)
  for (const target of ['chart', 'session'] as const) {
    const res = run(target, g, world, steps, seed)
    if (!res.failure) continue
    const f = res.failure
    const minimal = shrink(target, g, world, steps.slice(0, Math.max(0, f.step + 1)), seed)
    const again = run(target, g, world, minimal, seed).failure ?? f
    const names = minimal.map((s) => `${s.op}/${s.delivery}${s.via === 'change' ? '/change' : ''}`).join(' -> ')
    return [
      `seed=${seed} target=${target} (reproduce: ASTER_ORACLE_SEED=${seed})`,
      `spec: ${g.label} inlineValues=${g.inlineValues}`,
      `first failing step: ${f.step} (${f.op}) ${f.where}: ${f.detail}`,
      `minimal steps (${minimal.length}): ${names || '(initial evaluation)'}`,
      `minimal failure: step ${again.step} (${again.op}) ${again.where}: ${again.detail}`,
    ].join('\n  ')
  }
  return null
}

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
const SEEDS = Number(env('ASTER_ORACLE_SEEDS') ?? 40)
const STEPS = Number(env('ASTER_ORACLE_STEPS') ?? 12)
const START = Number(env('ASTER_ORACLE_START') ?? 1)
const ONE = env('ASTER_ORACLE_SEED')
const MAX_FAIL = Number(env('ASTER_ORACLE_MAXFAIL') ?? 5)

describe('incremental === fresh evaluateChart(compileChart(spec)) (audit C84 / T1)', () => {
  it('the generator is deterministic per seed', () => {
    const a = scenario(7, 6), b = scenario(7, 6)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(scenario(8, 6))).not.toBe(JSON.stringify(a))
  })

  it('the generator covers every required feature', () => {
    const seen = new Set<string>()
    const text: string[] = []
    for (let s = 1; s <= 400; s++) text.push(scenario(s, 1).g.label)
    const all = text.join('\n')
    for (const p of PIPES) seen.add(p.name)
    for (const need of ['filter', 'aggregate', 'window-sort', 'window-nosort', 'identifier', 'bin-data', 'stack', 'fold', 'flatten', 'lookup',
      'layered(text)', 'nested=group', 'nested=facet', 'nested=scoped', 'nested=other', 'nested=umark', 'xdom=multi', 'xdom=signal', 'autosize=fit', 'legend']) {
      expect(all, `generator never produces ${need}`).toContain(need)
    }
  })

  const seeds = ONE != null ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => START + i)
  it(`holds for ${seeds.length} seeds x ${STEPS} steps (chart reuse + session)`, () => {
    const failures: string[] = []
    for (const seed of seeds) {
      const f = checkSeed(seed, STEPS)
      if (f) failures.push(f)
      if (failures.length >= MAX_FAIL) break
    }
    expect(failures.join('\n\n'), `${failures.length} failing seed(s)`).toBe('')
  }, 600_000)
})

describe('incremental === fresh with selection stores that are edited between updates', () => {
  it('the generator is deterministic per seed and covers fields, ids, filters, conditions and resolves', () => {
    expect(JSON.stringify(scenarioSel(7, 6))).toBe(JSON.stringify(scenarioSel(7, 6)))
    const all = Array.from({ length: 200 }, (_, i) => scenarioSel(i + 1, 1).g.label).join('\n')
    for (const need of ['sel=ids', 'sel=fields/union', 'sel=fields/intersect', 'filter', 'encode', 'resolve']) {
      expect(all, `generator never produces ${need}`).toContain(need)
    }
    const ops = new Set(Array.from({ length: 40 }, (_, i) => scenarioSel(i + 1, 12).steps.map((x) => x.op)).flat())
    expect(ops.has('store')).toBe(true)
  })

  it('a store edit reaches the scene: the stores the scenarios build are not all empty', () => {
    let nonEmpty = 0
    for (let seed = 1; seed <= 40; seed++) {
      let w = scenarioSel(seed, 12).world
      const { steps } = scenarioSel(seed, 12)
      for (const st of steps) w = applyStep(w, st)
      if (w.sel.length) nonEmpty++
    }
    expect(nonEmpty).toBeGreaterThan(10)
  })

  const seedsSel = ONE != null ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => START + i)
  it(`holds for ${seedsSel.length} seeds x ${STEPS} steps (chart reuse + session)`, () => {
    const failures: string[] = []
    for (const seed of seedsSel) {
      const f = checkSeed(seed, STEPS, scenarioSel)
      if (f) failures.push(f)
      if (failures.length >= MAX_FAIL) break
    }
    expect(failures.join('\n\n'), `${failures.length} failing seed(s)`).toBe('')
  }, 600_000)
})

describe('incremental === fresh with group scopes whose signals events write between updates', () => {
  it('the generator is deterministic per seed and the scopes are real', () => {
    expect(JSON.stringify(scenarioScoped(7, 6))).toBe(JSON.stringify(scenarioScoped(7, 6)))
    const sc = scenarioScoped(3, 4)
    const scene = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, sc.world))
    const ids: string[] = []
    const walk = (g: SceneGroup): void => { if (g.scopeSignals) ids.push(g.scopeSignals.id); for (const c of g.items ?? []) if ((c as SceneGroup).items) walk(c as SceneGroup) }
    for (const g of scene.items) walk(g)
    expect(ids).toEqual([sc.g.scoped!.outer, sc.g.scoped!.inner])
    expect(new Set(Array.from({ length: 40 }, (_, i) => scenarioScoped(i + 1, 12).steps.map((x) => x.op)).flat()).has('scoped')).toBe(true)
  })

  it('the scoped signals reach the scene: the stored value changes what is drawn', () => {
    const sc = scenarioScoped(3, 4)
    const a = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, sc.world))
    const b = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, { ...sc.world, scoped: { outer: 6, inner: 5 } }))
    expect(renderSceneToSvg(a)).not.toBe(renderSceneToSvg(b))
  })

  const seedsScoped = ONE != null ? [Number(ONE)] : Array.from({ length: SEEDS }, (_, i) => START + i)
  it(`holds for ${seedsScoped.length} seeds x ${STEPS} steps (chart reuse + session)`, () => {
    const failures: string[] = []
    for (const seed of seedsScoped) {
      const f = checkSeed(seed, STEPS, scenarioScoped)
      if (f) failures.push(f)
      if (failures.length >= MAX_FAIL) break
    }
    expect(failures.join('\n\n'), `${failures.length} failing seed(s)`).toBe('')
  }, 600_000)
})
