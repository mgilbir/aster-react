/**
 * The incremental-equivalence oracle.
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
import './addon-transforms.js'
import './addon-geo.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { diffRows, type RowDiff } from './pulse.js'
import { applyChangeset, newChangeset, planModify, type Changeset } from './modify.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import type { CompiledChart, RuntimeInput, SceneRoot } from './types.js'
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

export interface Pipe {
  name: string
  tr: Array<Record<string, unknown>>
  /** Numeric field for the x channel / y channel, and a category field. */
  xf: string
  yf: string
  cf?: string
  /** The pipe reads dataset `t`, so it cannot run on `t` itself. */
  skipSource?: boolean
}

export const PIPES: Pipe[] = [
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
  { name: 'identifier', tr: [{ type: 'identifier', as: 'id' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'bin-data', tr: [{ type: 'bin', field: 'x', maxbins: 5, as: ['b0', 'b1'] }], xf: 'b0', yf: 'v', cf: 'g' },
  { name: 'bin-extent', tr: [{ type: 'bin', field: 'x', extent: [0, 10], maxbins: 5, as: ['b0', 'b1'] }], xf: 'b0', yf: 'v', cf: 'g' },
  { name: 'stack', tr: [{ type: 'stack', groupby: ['g'], field: 'v', sort: { field: 'x' }, as: ['y0', 'y1'] }], xf: 'x', yf: 'y1', cf: 'g' },
  { name: 'fold', tr: [{ type: 'fold', fields: ['x', 'y'], as: ['k', 'val'] }], xf: 'val', yf: 'v', cf: 'k' },
  { name: 'flatten', tr: [{ type: 'flatten', fields: ['arr'], as: ['e'] }], xf: 'e', yf: 'v', cf: 'g' },
  { name: 'lookup', tr: [{ type: 'lookup', from: 'u', key: 'g', fields: ['g'], values: ['w'], as: ['w'] }], xf: 'w', yf: 'v', cf: 'g' },
  { name: 'collect', tr: [{ type: 'collect', sort: { field: 'v' } }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'filter>aggregate', tr: [{ type: 'filter', expr: 'datum.v > 3' }, { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }], xf: 's', yf: 's', cf: 'g' },
  { name: 'formula>window', tr: [{ type: 'formula', expr: 'datum.v + 1', as: 'v1' }, { type: 'window', groupby: ['g'], sort: { field: 'v1' }, ops: ['sum'], fields: ['v1'], as: ['cs'] }], xf: 'v1', yf: 'cs', cf: 'g' },
  { name: 'filter>identifier', tr: [{ type: 'filter', expr: 'datum.x > 2' }, { type: 'identifier', as: 'id' }], xf: 'x', yf: 'v', cf: 'g' },
  { name: 'fold>filter', tr: [{ type: 'fold', fields: ['x', 'y'], as: ['k', 'val'] }, { type: 'filter', expr: 'datum.val > 2' }], xf: 'val', yf: 'v', cf: 'k' },
  { name: 'aggregate>filter', tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }, { type: 'filter', expr: 'datum.s > 5' }], xf: 's', yf: 's', cf: 'g' },
  { name: 'lookup>formula', tr: [{ type: 'lookup', from: 'u', key: 'g', fields: ['g'], values: ['w'], as: ['w'] }, { type: 'formula', expr: 'datum.w + datum.v', as: 'wv' }], xf: 'wv', yf: 'v', cf: 'g' },
  { name: 'bin>aggregate', tr: [{ type: 'bin', field: 'x', maxbins: 4, as: ['b0', 'b1'] }, { type: 'aggregate', groupby: ['b0'], fields: ['v'], ops: ['sum'], as: ['s'] }], xf: 'b0', yf: 's' },
  // -- Vega-faithful transform semantics: odd values (`s` numeric strings, `n` nullable),
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
  { name: 'identifier-falsy', tr: [{ type: 'identifier', as: 'x' }], xf: 'v', yf: 'v', cf: 'g' },
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
  /**
   * What the scenario was built from, read off the BUILT spec (`featuresOf`) plus the choices the builder names (the pipeline, the
   * delivery families): the coverage counter and the label printed on failure both derive from it, never from what a builder meant to draw.
   */
  features: Set<string>
  /** Human-readable summary of the features (printed on failure). */
  label: string
  /** The data set the marks read, and the pipeline that made it (what the relational shapes add to). */
  ds?: string
  pipe?: Pipe
  /** Inline `values` in the spec (true) or only via `input.data` (false). */
  inlineValues: boolean
  /** A selection store dataset `sel` the scenario edits (see `scenarioSel`): field tuples, or `_vgsid_` ids. */
  store?: 'fields' | 'ids'
  /** The scope ids of the two group scopes `scenarioScoped` adds (outer, and the one nested in it). */
  scoped?: { outer: string; inner: string }
}

type Spec = Record<string, unknown>
const asList = (v: unknown): Spec[] => (Array.isArray(v) ? (v as Spec[]) : v == null ? [] : [v as Spec])

/**
 * What a built spec contains, read off the spec itself (never off what a builder meant to draw): the mark types and how they nest, what
 * a mark is drawn from, which encode sets it has, the scale types, the transforms of every dataset and mark, the signals' forms, the
 * projections, the layout and the guides. The coverage counter counts these over the scenarios that run.
 */
export function featuresOf(spec: Spec): string[] {
  const out = new Set<string>()
  const markNames = new Set<string>()
  const names = (marks: Spec[]): void => { for (const m of marks) { if (typeof m.name === 'string') markNames.add(m.name); names(asList(m.marks)) } }
  names(asList(spec.marks))
  const scales = (list: Spec[]): void => {
    for (const sc of list) {
      out.add(`scale:${String(sc.type ?? 'linear')}`)
      if (sc.nice) out.add('scale.nice')
      if (sc.zero === true) out.add('scale.zero')
      if (sc.zero === false) out.add('scale.no-zero')
      const dom = sc.domain
      if (dom && typeof dom === 'object' && !Array.isArray(dom) && (dom as Spec).sort) out.add('domain.sort')
      if (Array.isArray(dom)) out.add('domain=fixed')
      else if (dom && typeof dom === 'object') out.add((dom as Spec).fields ? 'domain=multi' : (dom as Spec).signal ? 'domain=signal' : 'domain=data')
      if (sc.range && typeof sc.range === 'object' && !Array.isArray(sc.range)) out.add((sc.range as Spec).signal ? 'range=signal' : (sc.range as Spec).scheme ? 'range=scheme' : 'range=object')
    }
  }
  const signals = (list: Spec[]): void => {
    for (const sg of list) {
      if (typeof sg.init === 'string') out.add('signal:init')
      if (Array.isArray(sg.on) && sg.on.length) out.add('signal:on')
      if (typeof sg.update === 'string' && /\bdata\(/.test(sg.update)) out.add('signal:reads-data')
      if (typeof sg.update === 'string' && /\bscale\(|\bgeoScale\(|\binvert\(/.test(sg.update)) out.add('signal:reads-scale')
    }
  }
  const guides = (list: Spec[], kind: string): void => { for (const g of list) { out.add(kind); if (g.encode) out.add(`${kind}:encode`) } }
  const marks = (list: Spec[], depth: number): void => {
    const reads = new Map<string, number>()
    for (const m of list) {
      out.add(`mark:${String(m.type)}`)
      const from = m.from as Spec | undefined
      const src = typeof from?.data === 'string' ? from.data : undefined
      if (src !== undefined) reads.set(src, (reads.get(src) ?? 0) + 1)
      if (src !== undefined && markNames.has(src)) { out.add('mark-from-mark'); if (depth > 0) out.add('mark-from-mark@group') }
      if (from?.facet) out.add('nested=facet')
      if (m.type === 'group') {
        out.add(depth > 0 ? 'nested=group-in-group' : 'nested=group')
        if (asList(m.scales).length || asList(m.signals).length) out.add('nested=scoped')
        if (m.layout) out.add('layout')
      }
      if (depth > 0 && m.type !== 'group' && src !== undefined && !markNames.has(src)) out.add('nested=leaf-reads-data')
      const enc = (m.encode ?? {}) as Spec
      if (enc.enter && enc.update) out.add('enter+update')
      else if (enc.enter) out.add('enter')
      for (const set of ['exit', 'hover']) if (enc[set]) out.add(set)
      for (const k of ['key', 'sort', 'clip', 'zindex']) if (m[k] !== undefined) out.add(`mark.${k}`)
      if (Object.values(enc).some((set) => 'zindex' in ((set ?? {}) as Spec))) out.add('mark.zindex')
      for (const set of Object.values(enc)) {
        const channels = Object.values((set ?? {}) as Spec)
        if (channels.some((c) => Array.isArray(c))) out.add('encode:rules')
        if (channels.some((c) => typeof c === 'object' && c !== null && !Array.isArray(c) && typeof (c as Spec).signal === 'string' && /datum/.test((c as Spec).signal as string))) out.add('encode:per-item-signal')
      }
      for (const t of asList(m.transform)) out.add(`mark.transform:${String(t.type)}`)
      if (typeof m.name === 'string') out.add('mark:named')
      if (Array.isArray(m.on) && m.on.length) out.add('mark.on')
      scales(asList(m.scales)); signals(asList(m.signals)); guides(asList(m.axes), 'axis'); guides(asList(m.legends), 'legend')
      marks(asList(m.marks), depth + 1)
    }
    if ([...reads.values()].some((n) => n > 1)) out.add('layered')
  }
  marks(asList(spec.marks), 0)
  for (const d of asList(spec.data)) {
    for (const t of asList(d.transform)) out.add(`transform:${String(t.type)}`)
    if (d.format) out.add('data:format')
    if ((d.format as Spec | undefined)?.parse) out.add('data:format.parse')
    if (Array.isArray(d.on) && d.on.length) out.add('data.on')
    if (d.source) out.add('data:derived')
  }
  scales(asList(spec.scales)); signals(asList(spec.signals)); guides(asList(spec.axes), 'axis'); guides(asList(spec.legends), 'legend')
  if (asList(spec.projections).length) out.add('projection')
  if (asList(spec.projections).some((p) => p.fit !== undefined)) out.add('projection:fit')
  if (spec.title) out.add('title')
  out.add(`autosize=${typeof spec.autosize === 'object' && spec.autosize ? String((spec.autosize as Spec).type) : String(spec.autosize ?? 'pad')}`)
  return [...out].sort()
}

/** Settle a scenario's features and label: what the builders named plus what the built spec contains. */
export function finish<T extends { spec: Spec; features: Set<string>; label: string }>(g: T): T {
  for (const f of featuresOf(g.spec)) g.features.add(f)
  g.label = [...g.features].sort().join(' ')
  return g
}

/** The pipeline a seed runs: every pipeline in turn, so any run of `PIPES.length` consecutive seeds covers them all (the families start at their own offsets). */
export const pipeFor = (seed: number): Pipe => PIPES[(((seed - 1) % PIPES.length) + PIPES.length) % PIPES.length]!

function genSpec(r: Rnd, pipe: Pipe): GenSpec {
  const onSource = pipe.tr.length > 0 && !pipe.skipSource && r() < 0.35
  const ds = onSource ? 't' : pipe.tr.length ? 'd' : 't'
  const inlineValues = r() < 0.5
  const features: string[] = [`pipe=${pipe.name}`, onSource ? 'pipe@source' : 'pipe@derived', inlineValues ? 'values=inline' : 'values=input']

  const data: Array<Record<string, unknown>> = []
  const t: Record<string, unknown> = { name: 't' }
  if (inlineValues) t.values = []
  if (onSource) t.transform = clone(pipe.tr)
  const u: Record<string, unknown> = { name: 'u' }
  if (inlineValues) u.values = []
  // (a lookup reads a data set declared before it, as vega requires: a pipeline on `t` that looks `u` up follows it)
  if (onSource && JSON.stringify(pipe.tr).includes('"from":"u"')) data.push(u, t)
  else data.push(t, u)
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
    { name: 'y', type: 'linear', domain: dom(ydomKind, pipe.yf, [0, 40], { data: 't', field: 'v' }), range: 'height', zero: r() < 0.6, nice: r() < 0.4 },
  ]
  if (pipe.cf) {
    scales.push({ name: 'bx', type: r() < 0.7 ? 'band' : 'point', domain: { data: ds, field: pipe.cf }, range: 'width', padding: 0.1 })
    scales.push({ name: 'color', type: 'ordinal', domain: { data: ds, field: pipe.cf, sort: r() < 0.5 }, range: 'category' })
  }

  // Marks ----------------------------------------------------------------
  const xy = (_dataset: string, xf: string, yf: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
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
  if (primary === 'symbol') marks.push(sym(ds))
  else if (primary === 'rect') marks.push(rect(ds))
  else marks.push(line(ds, r() < 0.5 ? pipe.xf : undefined))
  if (layered) {
    // Layered marks over ONE shared dataset (symbol + text), the classic
    // labels-over-points chart.
    marks.push(txt(ds))
    if (r() < 0.4) marks.push(sym(ds))
  }
  const drawn = pick(r, ['none', 'none', 'group', 'facet', 'scoped', 'other', 'umark'] as const)
  // (a facet needs a category to group by: a pipeline without one draws no facet)
  const nested = drawn === 'facet' && !pipe.cf ? 'none' : drawn
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

  // Items that are not one per row in data order: a mark `key` (C120), an item `zindex` (C28), a colour object (C27), at any depth
  const reshape = (m: Record<string, unknown>): void => {
    for (const inner of (m.marks as Array<Record<string, unknown>> | undefined) ?? []) reshape(inner)
    const upd = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
    if (upd === undefined || m.type === 'group' || m.from === undefined) return
    if (r() < 0.2) { m.key = pick(r, [pipe.xf, pipe.cf ?? pipe.xf]); features.push('key') }
    if (r() < 0.25) { upd.zindex = { signal: `datum.${pipe.yf} % 3` }; features.push('zindex') }
    if (upd.fill !== undefined && r() < 0.15) { upd.fill = { color: { h: { field: pipe.xf, mult: 20 }, c: { value: 40 }, l: { value: 60 } } }; features.push('color-object') }
  }
  for (const m of marks) reshape(m)

  const axes: Array<Record<string, unknown>> = [
    { scale: 'x', orient: 'bottom', grid: r() < 0.3 },
    { scale: 'y', orient: 'left' },
  ]
  const legends: Array<Record<string, unknown>> = pipe.cf && r() < 0.35 ? [{ fill: 'color' }] : []

  const autosize = pick(r, ['none', 'pad', 'pad', 'fit'] as const)
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
  if (r() < 0.2) spec.title = { text: 'oracle' }
  return finish({ spec, features: new Set(features), label: '', inlineValues, ds, pipe })
}

// ---------------------------------------------------------------------------
// World + steps
// ---------------------------------------------------------------------------

export interface World { /** the URL policy the host holds (images are vetted by it: see POLICIES) */ policy?: 'open' | 'a' | 'b'; t: Row[]; u: Row[]; sel: Row[]; /** the next unique row key (`k`: what a keyed join and a mark-from-mark label read) */ ctr: number; /** the store holds `_vgsid_` ids (else field tuples) */ selIds?: boolean; /** the values the events wrote to the signals of the two group scopes (see `scenarioScoped`) */ scoped?: { outer: number; inner: number }; sig: number; width: number | undefined; height: number | undefined
  /** The host's container element size (`containerSize`, see `scenarioContainer`). */
  container?: { width: number; height: number } | undefined
  /** The container a <Chart> without size props measured (`measuredSize`). */
  measured?: { width: number; height: number } | undefined
  /** The `width` / `height` signal values a `window:resize` handler wrote through the event loop (see `scenarioContainer`). */
  sizeSig?: { width?: number; height?: number } | undefined
}

const GROUPS = ['A', 'B', 'C', 'D'] as const

function genRow(r: Rnd, k: number): Row {
  const n = pick(r, [2, 2, 2, 1, 3])
  return {
    ...oddFields(int(r, 0, 10), int(r, 0, 20)),
    y: int(r, 0, 10), g: pick(r, GROUPS), k,
    arr: Array.from({ length: n }, () => int(r, 0, 10)),
  }
}

/** x, v plus the fields the new pipes read: a nested copy `o`, a numeric string `s` and a nullable number `n`. */
function oddFields(x: number, v: number): Row {
  return { x, v, o: { a: x, b: [v] }, s: String(v), n: v % 5 === 0 ? null : v }
}

function genWorld(r: Rnd, rows?: [number, number]): World {
  const n = rows ? int(r, rows[0], rows[1]) : int(r, 3, 9)
  const keys = [...GROUPS].filter(() => r() < 0.85)
  return {
    t: Array.from({ length: n }, (_, i) => genRow(r, i)),
    u: keys.map((g) => ({ g, w: int(r, 1, 12) })),
    ctr: n, sel: [], sig: 3, width: undefined, height: undefined,
  }
}

export type Op = 'edit' | 'grow' | 'shrink' | 'insert' | 'remove' | 'append' | 'truncate' | 'swap' | 'shuffle'
  | 'replaceAll' | 'editU' | 'signal' | 'size' | 'noop' | 'edit-group' | 'store' | 'scoped' | 'resize'
  // the domain-census ops: values below the current minimum, the minimum row leaving the extreme, the extreme row removed, a new category
  | 'low' | 'dropMin' | 'removeExt' | 'newGroup' | 'swapCat'
  // the data a host really holds: no rows at all, values a chart has to survive (null, NaN, a missing field, a string, Infinity), a data set that gains rows
  | 'empty' | 'odd' | 'appendU' | 'bulk' | 'bulkU' | 'policy'
type Delivery = 'none' | 'changedDatasets' | 'dataChanges' | 'dataPulse' | 'inplace'
type Via = 'evaluate' | 'change'

/**
 * `keep`: the rows are handed over as the host holds them -- a row that did not change is the very object the evaluation before was given
 * (and may have written to), not a copy -- where every other step hands over fresh copies.
 */
export interface Step { op: Op; delivery: Delivery; via: Via; keep: boolean; r: number[] }

const OPS: Op[] = ['edit', 'edit', 'grow', 'shrink', 'shrink', 'insert', 'remove', 'append', 'append', 'truncate',
  'swap', 'shuffle', 'replaceAll', 'editU', 'signal', 'size', 'noop', 'edit-group', 'low', 'low', 'dropMin', 'dropMin', 'removeExt', 'removeExt', 'newGroup',
  'empty', 'odd', 'odd', 'appendU']

function genStep(r: Rnd): Step {
  return {
    op: pick(r, OPS),
    delivery: pick(r, ['none', 'changedDatasets', 'dataChanges', 'dataPulse', 'dataPulse', 'inplace'] as const),
    via: r() < 0.2 ? 'change' : 'evaluate',
    keep: r() < 0.4,
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
    ...oddFields(Math.floor(s.r[(k + 2) % 8]! * 11), Math.floor(s.r[(k + 4) % 8]! * 21)), y: Math.floor(s.r[(k + 3) % 8]! * 11), k: next.ctr++,
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
      for (let j = 0; j < k; j++) t.splice(at + j, 0, rowAt(j))
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
    case 'resize': {
      // The viewport was resized: the host's container changes size, the spec's `window:resize` handlers write the
      // `width` / `height` signals (to the container, or to their 300 fallback when the container has no size), and the
      // host may also fix or release the view size itself. Often together with a data edit.
      const known = s.r[0]! < 0.7
      next.container = known ? { width: 200 + Math.floor(s.r[1]! * 400), height: 150 + Math.floor(s.r[2]! * 250) } : undefined
      next.measured = next.container && s.r[6]! < 0.6 ? { ...next.container } : undefined
      next.sizeSig = s.r[3]! < 0.15 ? undefined : { width: next.container?.width ?? 300, height: next.container?.height ?? 300 }
      if (s.r[4]! < 0.3) { next.width = 150 + Math.floor(s.r[5]! * 200); next.height = s.r[3]! < 0.5 ? undefined : 120 + Math.floor(s.r[2]! * 160) }
      else if (s.r[4]! < 0.45) { next.width = undefined; next.height = undefined }
      if (s.r[7]! < 0.6 && t.length) { const i = ix(s.r[6]!, t.length); t[i] = { ...t[i]!, ...rowAt(4), g: t[i]!.g } }
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
    case 'low': {
      // A value BELOW the current minimum (the census must widen at the low end too), by an edit or by an append.
      const lowest = (f: 'x' | 'v'): number => (t.length ? t.reduce((m, row) => Math.min(m, Number(row[f])), Infinity) : 0)
      const minV = Number.isFinite(lowest('v')) ? lowest('v') : 0
      const minX = Number.isFinite(lowest('x')) ? lowest('x') : 0
      const low = (): Row => ({ ...rowAt(0), ...oddFields(minX - 1 - Math.floor(s.r[1]! * 4), minV - 1 - Math.floor(s.r[2]! * 5)) })
      if (t.length && s.r[3]! < 0.5) { const i = ix(s.r[4]!, t.length); t[i] = { ...t[i]!, ...low(), g: t[i]!.g } } else t.push(low())
      break
    }
    case 'dropMin': {
      // The row(s) holding the minimum x / v move up into the interior (or stay tied for it when a second row holds it).
      if (t.length) {
        const lo = (f: 'x' | 'v'): number => t.reduce((best, row, i) => (Number(row[f]) < Number(t[best]![f]) ? i : best), 0)
        const a = lo('x'), b = lo('v')
        t[a] = { ...t[a]!, ...oddFields(5 + Math.floor(s.r[0]! * 5), Number(t[a]!.v)), g: t[a]!.g }
        if (s.r[1]! < 0.7) t[b] = { ...t[b]!, ...oddFields(Number(t[b]!.x), 8 + Math.floor(s.r[2]! * 8)), g: t[b]!.g }
        if (s.r[3]! < 0.3 && t.length > 2) { const c = ix(s.r[4]!, t.length); t[c] = { ...t[c]!, ...oddFields(Number(t[a]!.x), Number(t[b]!.v)), g: t[c]!.g } }
      }
      break
    }
    case 'removeExt': {
      // Remove the row holding the maximum v, or the minimum x (so its category may vanish with it).
      if (t.length > 1) {
        const i = s.r[0]! < 0.5
          ? t.reduce((best, row, j) => (Number(row.v) > Number(t[best]!.v) ? j : best), 0)
          : t.reduce((best, row, j) => (Number(row.x) < Number(t[best]!.x) ? j : best), 0)
        t.splice(i, 1)
      }
      break
    }
    case 'swapCat': {
      // A row takes the category of another row: the same-length swap the ordered domain survives only while the old value keeps
      // another row and its own first occurrence, and the new one already stands earlier than the row.
      if (t.length > 1) {
        const i = ix(s.r[0]!, t.length), j = s.r[5]! < 0.5 ? ix(s.r[1]!, i) : (i + 1 + ix(s.r[1]!, t.length - i - 1)) % t.length
        t[i] = { ...t[i]!, g: t[j]!.g }
        if (s.r[2]! < 0.4) { const k = ix(s.r[3]!, t.length); t[k] = { ...t[k]!, g: GROUPS[Math.floor(s.r[4]! * 4)]! } }
      }
      break
    }
    case 'newGroup': {
      // A category no row had yet (the discrete census must grow), sometimes replacing the only row of its group.
      const g = `N${Math.floor(s.r[0]! * 3)}`
      if (t.length && s.r[1]! < 0.5) { const i = ix(s.r[2]!, t.length); t[i] = { ...t[i]!, g } } else t.push({ ...rowAt(1), g })
      break
    }
    case 'empty': {
      t.length = 0
      if (s.r[0]! < 0.3) next.u = []
      break
    }
    case 'odd': {
      // values a chart has to survive, in the fields the pipelines read: null, NaN, a missing field, a numeric string, Infinity
      const odds: Array<(row: Row) => Row> = [
        (row) => ({ ...row, x: null, o: { a: null, b: [null] } }),
        (row) => ({ ...row, v: NaN, n: NaN, s: 'abc' }),
        (row) => { const { x: _x, ...rest } = row; return rest },
        (row) => ({ ...row, v: String(row.v ?? 0), x: String(row.x ?? 0) }),
        (row) => ({ ...row, v: Infinity }),
        (row) => ({ ...row, g: null, arr: [] }),
      ]
      if (!t.length) t.push(rowAt(0))
      const how = Math.floor(s.r[0]! * odds.length)
      for (let j = 0; j < 1 + Math.floor(s.r[1]! * 2); j++) { const i = ix(s.r[(j + 2) % 8]!, t.length); t[i] = odds[(how + j) % odds.length]!(t[i]!) }
      break
    }
    case 'appendU': {
      const g = GROUPS[Math.floor(s.r[0]! * 4)]!
      next.u.push({ g, w: 1 + Math.floor(s.r[1]! * 12) })
      if (s.r[2]! < 0.4) next.u.push({ g: GROUPS[Math.floor(s.r[3]! * 4)]!, w: 1 + Math.floor(s.r[4]! * 12) })
      break
    }
    case 'bulkU': {
      // the second data set gains hundreds of rows at once (the arrays a pulse advances in place are the long ones)
      const k = 100 + Math.floor(s.r[0]! * 300)
      for (let j = 0; j < k; j++) next.u.push({ g: GROUPS[j % 4]!, w: 1 + ((j * 7 + Math.floor(s.r[1]! * 12)) % 12) })
      break
    }
    case 'bulk': {
      // a data set that gains many rows at once (a signal that holds it then holds past what a structural key takes in)
      const k = 20 + Math.floor(s.r[0]! * 60)
      for (let j = 0; j < k; j++) t.push(rowAt(j % 8))
      break
    }
    case 'policy': {
      next.policy = (['open', 'a', 'b'] as const)[Math.floor(s.r[0]! * 3)]
      if (s.r[7]! < 0.5 && t.length) { const i = ix(s.r[6]!, t.length); t[i] = { ...t[i]!, ...rowAt(5), g: t[i]!.g } }
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

export function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined) return undefined
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  // (a collection is compared by what it holds: a Set under `_vgsid_` is the rows' ids, which a flattened '[collection]' would hide)
  if (v instanceof Set) return { $set: [...v].map((x) => norm(x, depth + 1)).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) }
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [norm(k, depth + 1), norm(x, depth + 1)]).sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)) }
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}

/**
 * The first difference between two normalised values. `ids` (two maps, one per direction) are the fields an `identifier` writes: the
 * numbers an `identifier` gives are the running view's (vega's counter is the view's, and a row keeps its id as the data changes), so a
 * fresh evaluation numbers the same rows otherwise. Those fields are compared as IDENTITIES: the rows the incremental scene gave one id
 * are the rows the fresh scene gave one id (a bijection between the two numberings, built as the two scenes are walked together).
 * What the numbers are is pinned against vega (identifier-order-vs-vega.test.ts, identifier-pulse.test.ts), not here.
 */
interface IdMaps { fwd: Map<unknown, unknown>; back: Map<unknown, unknown>; fields: ReadonlySet<string> }

function firstDiff(a: unknown, b: unknown, path = '$', ids?: IdMaps): string | null {
  if (ids && ids.fields.has(path.slice(path.lastIndexOf('.') + 1)) && !/\.items\[\d+\]\.[^.\]]+$/.test(path) && typeof a === 'number' && typeof b === 'number') {
    const f = ids.fwd.get(a), g = ids.back.get(b)
    if (f === undefined && g === undefined) { ids.fwd.set(a, b); ids.back.set(b, a); return null }
    return f === b && g === a ? null : `${path}: the reference numbers a row ${a} where the incremental scene numbers it ${b}, and elsewhere the reference's ${a} is the incremental's ${f === undefined ? '(not seen)' : String(f)} (ids are compared as identities)`
  }
  if (Object.is(a, b)) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: expected ${JSON.stringify(a)?.slice(0, 120)} got ${JSON.stringify(b)?.slice(0, 120)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length expected ${a.length} got ${b.length}`
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`, ids); if (d) return d }
    return null
  }
  const ak = Object.keys(a as object), bk = Object.keys(b as object)
  for (const k of new Set([...ak, ...bk])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, ids)
    if (d) return d
  }
  return null
}

/** The fields the rows of the scenarios carry (an `identifier` that writes one of them overwrites a value the host gave). */
const ROW_FIELDS = new Set(['x', 'v', 'y', 'g', 'k', 's', 'n', 'o', 'arr'])

/**
 * Whether a scenario's result depends on how the view got there, beyond the NUMBERS its `identifier`s give (which are compared as
 * identities): a store of `_vgsid_` ids (the host's ids are the running view's numbers, so a fresh view reads them as other rows), and an
 * `identifier` that overwrites a field the rows carry (vega gives a NEW row its number, and an edited row keeps the value it has, so what the
 * field holds depends on which rows were edited). Those compare with a reference chart carried through the same states (`reference`).
 */
export function historyBound(g: GenSpec): boolean {
  return g.store === 'ids' || [...idFieldsOf(g.spec)].some((f) => ROW_FIELDS.has(f))
}

/** The fields the `identifier` steps of a spec write (a dataset's or a mark's, at any depth). */
export function idFieldsOf(spec: Spec): Set<string> {
  const out = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v === null || typeof v !== 'object') return
    const o = v as Spec
    if (o.type === 'identifier') out.add(typeof o.as === 'string' ? o.as : 'id')
    for (const x of Object.values(o)) walk(x)
  }
  walk(spec)
  return out
}

/**
 * What a scene is, for comparing two of them: everything the scene holds (`norm`), the datasets a host reads with `datasetsOfScene`
 * (non-enumerable on the scene, so `norm` never walks them: the rows the event loop's `data()` reads, and the rows a host shows), and
 * the SVG it draws.
 */
function sceneKey(scene: SceneRoot, hostOwned: ReadonlySet<string> = new Set()): { norm: unknown; svg: string } {
  const datasets = new Map([...datasetsOfScene(scene)].filter(([name]) => !hostOwned.has(name)))
  return { norm: { scene: norm(scene), datasets: norm(datasets) }, svg: renderSceneToSvg(scene) }
}

/**
 * The data sets of `scene` that ARE the arrays the host handed over (a data set with no transform reads the host's own array: it is
 * the host's to change, and a host that edits its array in place -- the `inplace` delivery -- edits the rows of every scene that read it).
 */
function ownedBy(scene: SceneRoot, given: Record<string, unknown[]> | undefined): Set<string> {
  const out = new Set<string>()
  if (given) for (const [name, rows] of datasetsOfScene(scene)) if (rows !== null && given[name] === rows) out.add(name)
  return out
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The signals the host stores for the group scopes of a scenario: what the event loop writes as `<scope id>:<name>`. */
function scopedSignals(g: GenSpec, w: World): Record<string, unknown> {
  if (!g.scoped || !w.scoped) return {}
  return { [scopedSignalName(g.scoped.outer, 'gs')]: w.scoped.outer, [scopedSignalName(g.scoped.inner, 'gs')]: w.scoped.inner }
}

/** The host's URL policies: one object each, as a host keeps them (a policy that is the same object is the same policy). */
const POLICIES = {
  open: { baseURL: 'https://a.example/' },
  a: { baseURL: 'https://a.example/', allow: (u: { host: string }): boolean => u.host === 'a.example', onDeny: (): void => undefined },
  b: { baseURL: 'https://a.example/', allow: (u: { host: string }): boolean => u.host === 'b.example', onDeny: (): void => undefined },
} as const

/** What the host adds for the view size: the container it measured, and the size signals the event loop wrote. */
function sizeInputs(w: World, input: RuntimeInput): void {
  if (w.container) input.containerSize = w.container
  if (w.measured) input.measuredSize = w.measured
  if (w.sizeSig) Object.assign(input.signals!, w.sizeSig)
  if (w.policy) input.urlPolicy = POLICIES[w.policy] as never
}

export function inputOf(g: GenSpec, w: World): RuntimeInput {
  const input: RuntimeInput = { signals: { sig: w.sig, ...scopedSignals(g, w) } }
  if (w.width != null) input.width = w.width
  if (w.height != null) input.height = w.height
  sizeInputs(w, input)
  input.data = { t: clone(w.t), u: clone(w.u), ...(g.store ? { sel: clone(w.sel) } : {}) }
  return input
}

/**
 * The fresh reference of a state: a chart compiled afresh from the spec and given the state's input, for EVERY spec (an `identifier`'s
 * numbers are compared as identities, see `firstDiff`).
 *
 * The exceptions are `historyBound` scenarios (a store of `_vgsid_` ids: the ids the host stores name rows by the running
 * view's numbers, which a freshly compiled chart does not share, so the same stored ids select other rows there; an `identifier` that
 * overwrites a field the rows carry). Their reference is a chart of its own evaluated through the same states, each time from scratch with no hint of what changed but one: rows changed where they
 * stood (`modified`) are the same rows in a new state, which keeps their ids, while a row that moved is a row that moved. `kept` is that chart.
 */
function reference(g: GenSpec, w: World, kept?: CompiledChart, modified?: Record<string, number[]>): SceneRoot | Error {
  try {
    const spec = clone(g.spec)
    // The reference sees the SAME visible state: data via input.data, always. A view size the host fixed IS the size:
    // the `width` / `height` signals a `window:resize` handler wrote do not move it, so the reference never sees them.
    const sizeSig = w.sizeSig && { ...(w.width == null ? { width: w.sizeSig.width } : {}), ...(w.height == null ? { height: w.sizeSig.height } : {}) }
    return evaluateChart(kept ?? compileChart(spec as never), { ...inputOf(g, { ...w, sizeSig }), ...(modified ? { dataChanges: modified } : {}) })
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

/** The rows a step's hints say changed where they stood (and nothing else about them). */
function modifiedBy(hints: Partial<RuntimeInput>, more?: Record<string, number[]>): Record<string, number[]> | undefined {
  const out: Record<string, number[]> = { ...more, ...hints.dataChanges }
  for (const [name, p] of Object.entries(hints.dataPulse ?? {})) if (!p.from) out[name] = p.changed ?? []
  return Object.keys(out).length ? out : undefined
}

/** The data sets that have the same number of rows in both worlds, and the rows of each that differ. */
function sameLengthChanges(prev: World, next: World): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const name of ['t', 'u', 'sel'] as const) {
    const d = diffRows(prev[name], next[name])
    if (d?.sameLength && d.changed.length) out[name] = d.changed
  }
  return out
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
  /** The step that DETECTED the failure (the last step, for the final audit of retained scenes). */
  step: number
  op: string
  where: string
  /** What kind of failure it is, without the step it was found at: a shrunk list must fail the same way to count. */
  kind: string
  detail: string
}

interface RunResult { failure: Failure | null; steps: number }

const readMode = (s: Step): number => Math.min(2, Math.floor(s.r[5]! * 3))

/** Test-only hook: lets a test break something the oracle watches, between steps, to see that it is seen (and shrunk to the right list). */
export interface RunOptions {
  /** Called with the scene a step produced, before it is compared with the reference. */
  beforeCompare?: (step: number, scene: SceneRoot) => void
  /** Called after a step's scene was compared and retained. */
  afterStep?: (step: number, retained: ReadonlyArray<{ scene: SceneRoot }>) => void
}

const kindOf = (where: string): string => (where.startsWith('retained') ? 'retained' : where.startsWith('compiled IR') ? 'compiled IR' : where)

/**
 * Run one generated scenario against one target and compare every step with the
 * fresh reference. Returns the first failure.
 */
function run(target: 'chart' | 'session', g: GenSpec, world0: World, steps: Step[], seed: number, opts: RunOptions = {}): RunResult {
  const fail = (step: number, op: string, where: string, detail: string): RunResult => ({ failure: { seed, target, step, op, where, kind: kindOf(where), detail }, steps: step })
  // The rows a host that keeps its rows hands over: a row that did not change is the very object it handed over before, which the
  // engine may have written to (a copy of each world row, made once, stands for it; the world's own rows stay as generated).
  const held = new WeakMap<object, Row>()
  const same = (rows: Row[]): Row[] => rows.map((row) => { let c = held.get(row); if (!c) { c = clone(row); held.set(row, c) } return c })
  // ... and a data set that did not change is the very array it was (a host that holds its rows hands over the array it holds)
  const lastGiven = new Map<string, { world: Row[]; given: Row[] }>()
  const arrayOf = (name: string, rows: Row[]): Row[] => {
    const last = lastGiven.get(name)
    if (last && last.world.length === rows.length && rows.every((row, i) => row === last.world[i])) return last.given
    const given = same(rows)
    lastGiven.set(name, { world: rows, given })
    return given
  }
  const dataFor = (w: World, keep: boolean): Record<string, Row[]> => (keep
    ? { t: arrayOf('t', w.t), u: arrayOf('u', w.u), ...(g.store ? { sel: arrayOf('sel', w.sel) } : {}) }
    : { t: clone(w.t), u: clone(w.u), ...(g.store ? { sel: clone(w.sel) } : {}) })
  let world = world0
  // Previously returned scenes must never change under the caller.
  const retained: Array<{ scene: SceneRoot; key: ReturnType<typeof sceneKey>; step: number; owned: Set<string> }> = []

  const keptReference = historyBound(g) ? compileChart(clone(g.spec) as never) : undefined
  const idFields = idFieldsOf(g.spec)
  const compare = (stepNo: number, op: string, actual: SceneRoot | Error, w: World, modified: Record<string, number[]> | undefined, mode: number, given?: Record<string, Row[]>): RunResult | null => {
    if (!(actual instanceof Error)) opts.beforeCompare?.(stepNo, actual)
    const ref = reference(g, w, keptReference, keptReference ? modified : undefined)
    if (ref instanceof Error || actual instanceof Error) {
      const a = actual instanceof Error ? actual.message : 'ok'
      const b = ref instanceof Error ? ref.message : 'ok'
      if (a !== b) return fail(stepNo, op, 'error', `reference: ${b}; incremental: ${a}`)
      // (both sides refusing the same state is agreement, but every generated state is one a chart can draw: a scenario that does not
      // evaluate compares nothing, and a generator that makes one has stopped testing what it names)
      return fail(stepNo, op, 'generator', `the generated state does not evaluate on either side: ${b}`)
    }
    const want = sceneKey(ref)
    const got = sceneKey(actual)
    const d = firstDiff(want.norm, got.norm, '$', !keptReference && idFields.size ? { fwd: new Map(), back: new Map(), fields: idFields } : undefined)
    if (d) return fail(stepNo, op, 'scene', d)
    if (want.svg !== got.svg) return fail(stepNo, op, 'svg', 'serialised SVG differs although the normalised scenes are equal')
    // Earlier returned scenes must read exactly as they did when returned, in
    // ANY read order (the engine hands superseded groups lazy snapshots):
    // oldest first, newest first, or not at all until much later.
    // (which of the three is a property of the step, not of its place in the list: a list with steps dropped reads its scenes as the whole one did)
    if (mode !== 2) {
      const order = mode === 0 ? retained.slice() : retained.slice().reverse()
      for (const old of order) {
        const dd = firstDiff(old.key.norm, sceneKey(old.scene, old.owned).norm)
        if (dd) return fail(stepNo, op, `retained scene from step ${old.step} mutated`, dd)
      }
    }
    const owned = ownedBy(actual, given)
    retained.push({ scene: actual, key: sceneKey(actual, owned), step: stepNo, owned })
    opts.afterStep?.(stepNo, retained)
    return null
  }

  /** Final audit: scenes that were never re-read, in pseudo-random order. */
  const finalAudit = (last: number): RunResult | null => {
    const order = retained.map((_, i) => i).sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13) || a - b)
    for (const i of order) {
      const old = retained[i]!
      const dd = firstDiff(old.key.norm, sceneKey(old.scene, old.owned).norm)
      // (reported at the step that found it: the scene changed at some step after it was returned, so a list cut at the scene's own step would not repeat the change)
      if (dd) return fail(last, 'final audit', `retained scene from step ${old.step} mutated`, dd)
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
    // The compiled IR must stay byte-identical across every evaluation.
    const irAtCompile = JSON.stringify(chart)
    const irCheck = (stepNo: number, op: string): RunResult | null => {
      const now = JSON.stringify(chart)
      return now === irAtCompile ? null : fail(stepNo, op, 'compiled IR mutated by evaluateChart', firstDiff(JSON.parse(irAtCompile), JSON.parse(now)) ?? '')
    }
    const firstData = { t: live.t, u: live.u, ...(g.store ? { sel: live.sel } : {}) }
    const first = attempt(() => evaluateChart(chart, { ...inputOf(g, world), data: firstData }))
    const r0 = compare(-1, 'init', first, world, undefined, 0, firstData) ?? irCheck(-1, 'init')
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
        if (s.keep) input.data = dataFor(world, true)
      }
      const scene = attempt(() => evaluateChart(chart, input))
      const r = compare(i, `${s.op}/${s.delivery}`, scene, world, modifiedBy(hints), readMode(s), input.data as Record<string, Row[]>) ?? irCheck(i, s.op)
      if (r) return r
    }
    return finalAudit(steps.length - 1) ?? { failure: null, steps: steps.length }
  }

  // session target
  const session = createChartSession()
  const specFor = (w: World, keep = false): Record<string, unknown> => {
    const spec = clone(g.spec)
    if (g.inlineValues) {
      for (const d of spec.data as Array<Record<string, unknown>>) {
        if (d.name === 't') d.values = keep ? same(w.t) : clone(w.t)
        if (d.name === 'u') d.values = keep ? same(w.u) : clone(w.u)
        if (d.name === 'sel') d.values = keep ? same(w.sel) : clone(w.sel)
      }
    }
    return spec
  }
  const sessionInput = (w: World, extra: Partial<RuntimeInput>, keep = false): RuntimeInput => {
    const input: RuntimeInput = { signals: { sig: w.sig, ...scopedSignals(g, w) }, ...extra }
    if (w.width != null) input.width = w.width
    if (w.height != null) input.height = w.height
    sizeInputs(w, input)
    if (!g.inlineValues || extra.dataChanges || extra.dataPulse) input.data = dataFor(w, keep)
    return input
  }
  const first = attempt(() => session.evaluate(specFor(world) as never, sessionInput(world, {})))
  const irAtCompile = JSON.stringify(session.last()?.chart ?? null)
  const irCheck = (stepNo: number, op: string): RunResult | null => {
    const now = JSON.stringify(session.last()?.chart ?? null)
    return now === irAtCompile ? null : fail(stepNo, op, 'compiled IR mutated by the session', firstDiff(JSON.parse(irAtCompile), JSON.parse(now)) ?? '')
  }
  const r0 = compare(-1, 'init', first, world, undefined, 0) ?? irCheck(-1, 'init')
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
      // complete state (data, signals, size), exactly like a host would. What it is not given it keeps from the last
      // evaluation, so a size the world no longer has is given as `undefined` (which removes it).
      const input = {
        width: undefined, height: undefined, containerSize: undefined, measuredSize: undefined,
        ...sessionInput(world, extra), data: dataFor(world, s.keep),
      }
      scene = attempt(() => session.change(input))
    } else {
      scene = attempt(() => session.evaluate(specFor(world, s.keep) as never, sessionInput(world, extra, s.keep)))
    }
    // (the session works out what changed itself, unless the step says only which data sets did)
    let r = compare(i, `${s.op}/${s.delivery}/${s.via}`, scene, world, extra.autoChanges === false ? undefined : modifiedBy(hints, sameLengthChanges(prev, world)), readMode(s)) ?? irCheck(i, s.op)
    if (r) return r
    // The no-op cache: re-evaluating the identical state must be correct too,
    // with fresh equal arrays and with the very same inputs.
    if (s.op === 'noop' || s.r[4]! < 0.35) {
      const again = attempt(() => session.evaluate(specFor(world) as never, sessionInput(world, {})))
      r = compare(i, `${s.op}/re-evaluate`, again, world, undefined, readMode(s))
      if (r) return r
    }
  }
  return finalAudit(steps.length - 1) ?? { failure: null, steps: steps.length }
}

export function scenario(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const r = mulberry32(seed)
  const g = genSpec(r, pipeFor(seed))
  const world = genWorld(r)
  const steps = Array.from({ length: nSteps }, () => genStep(r))
  return { g, world, steps }
}

/**
 * The scale-reuse scenario: every scale reads the source dataset `t` DIRECTLY (a numeric domain per axis, a band or ordinal domain
 * over the category), so each small edit goes through the domain census instead of a rebuild, and the steps are the edits that
 * decide whether the domain moved: values below the minimum, above the maximum, the extreme row leaving or removed, ties, a
 * category that is new, gone, or swapped for an earlier row's.
 */
const CENSUS_OPS: Op[] = ['edit', 'edit-group', 'edit-group', 'edit-group', 'swapCat', 'swapCat', 'swapCat', 'swapCat', 'swapCat', 'low', 'low', 'dropMin', 'dropMin',
  'removeExt', 'removeExt', 'newGroup', 'grow', 'shrink', 'append', 'truncate', 'remove', 'insert', 'shuffle', 'swap', 'noop']

/** Each family draws its base scenario from seeds of its own, so the families do not re-run one another's specs (every family still takes the pipelines in turn). */
export const OFFSET = { scenario: 0, scenarioSel: 10_007, scenarioScoped: 20_011, scenarioContainer: 30_011, scenarioRelational: 40_009, scenarioRelationalMore: 50_021 } as const

export function scenarioCensus(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const r = mulberry32(seed ^ 0xce45a5)
  const inlineValues = r() < 0.5
  const xType = pick(r, ['linear', 'linear', 'pow'] as const)
  const nice = r() < 0.5
  const zero = r() < 0.5
  const bandType = pick(r, ['band', 'point'] as const)
  const sortColor = r() < 0.5
  const data: Array<Record<string, unknown>> = [{ name: 't', ...(inlineValues ? { values: [] } : {}) }, { name: 'u', ...(inlineValues ? { values: [] } : {}) }]
  const scales: Array<Record<string, unknown>> = [
    { name: 'x', type: xType, ...(xType === 'pow' ? { exponent: 2 } : {}), domain: { data: 't', field: 'x' }, range: 'width', nice },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', zero, nice: r() < 0.4 },
    { name: 'bx', type: bandType, domain: { data: 't', field: 'g' }, range: 'width', padding: 0.1 },
    { name: 'color', type: 'ordinal', domain: { data: 't', field: 'g', sort: sortColor }, range: 'category' },
  ]
  const marks: Array<Record<string, unknown>> = [{
    type: 'symbol', from: { data: 't' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { value: 30 }, fill: { scale: 'color', field: 'g' } } },
  }]
  if (r() < 0.6) {
    marks.push({
      type: 'rect', from: { data: 't' },
      encode: { update: { x: { scale: 'bx', field: 'g' }, width: { scale: 'bx', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { scale: 'color', field: 'g' } } },
    })
  }
  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega/v6.json', width: pick(r, [200, 300]), height: pick(r, [160, 220]), padding: 5, autosize: pick(r, ['none', 'pad'] as const),
    signals: [{ name: 'sig', value: 3 }, { name: 'thr', update: 'sig + 1' }], data, scales,
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }, { scale: 'bx', orient: 'top' }],
    legends: r() < 0.5 ? [{ fill: 'color' }] : [], marks,
  }
  const g = finish<GenSpec>({ spec, inlineValues, features: new Set(['census']), label: '' })
  const world = genWorld(r)
  const steps = Array.from({ length: nSteps }, () => ({ ...genStep(r), op: pick(r, CENSUS_OPS) }))
  return { g, world, steps }
}

/**
 * The same scenarios with a selection store: a dataset `sel` (vega-lite's `<name>_store`: field tuples, or `_vgsid_`
 * ids kept sorted by a `collect`) that the pipeline filters by (`vlSelectionTest` / `vlSelectionIdTest`), a mark
 * highlights by, and a derived signal resolves (`vlSelectionResolve`), edited by `modify`-style updates between the
 * data edits, signal changes and resizes the base scenario already has.
 */
export function scenarioSel(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const base = scenario(seed + OFFSET.scenarioSel, nSteps)
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
  for (const f of features) base.g.features.add(f)
  base.g.store = ids ? 'ids' : 'fields'
  const steps = base.steps.map((s) => (r() < 0.4 ? { ...s, op: 'store' as const } : s))
  return { g: finish(base.g), world: { ...base.world, selIds: ids }, steps }
}

/**
 * The same scenarios with group scopes: a group mark declaring signals (one derived from the view's `sig`), whose marks read
 * them, with a second scope nested in it that shadows one. The steps write the scopes' signals the way the event loop does
 * (`<scope id>:gs` in the signal store), between the data edits, signal changes and resizes the base scenario already has.
 */
export function scenarioScoped(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const base = scenario(seed + OFFSET.scenarioScoped, nSteps)
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
  base.g.features.add('scoped-signals')
  const steps = base.steps.map((s) => (r() < 0.4 ? { ...s, op: 'scoped' as const } : s))
  return { g: finish(base.g), world: { ...base.world, scoped: { outer: 2, inner: 1 } }, steps }
}

/**
 * The same scenarios on container-sized views, as `width: "container"` compiles (vega-lite): no top-level width / height,
 * `width` / `height` signals whose `init` reads `containerSize()` and that a `window:resize` handler re-runs, and an
 * `autosize` of any kind that contains the padding. The steps resize the viewport the way a browser does (the container
 * changes size, the handlers write the signals) and fix or release the view size from the host, between the data edits,
 * signal changes and size changes the base scenario already has. Every step is compared with a fresh evaluation, and a
 * view size the host fixed must not be moved by those signals.
 */
export function scenarioContainer(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  const base = scenario(seed + OFFSET.scenarioContainer, nSteps)
  const r = mulberry32(seed ^ 0xc0117a)
  const spec = base.g.spec
  // a third of the views keep their own numeric size: the measured container then sizes them (a <Chart> without size props)
  const fill = r() < 0.3
  if (fill) {
    base.g.features.add('container(fill)')
  } else {
    delete spec.width
    delete spec.height
    const auto = pick(r, ['fit', 'fit', 'fit-x', 'fit-y', 'pad', 'none'] as const)
    spec.autosize = { type: auto, contains: 'padding' }
    const size = (i: 0 | 1): Record<string, unknown> => {
      const expr = `isFinite(containerSize()[${i}]) ? containerSize()[${i}] : 300`
      return { init: expr, on: [{ update: expr, events: 'window:resize' }] }
    }
    const sigs = spec.signals as Array<Record<string, unknown>>
    sigs.unshift({ name: 'width', ...size(0) }, { name: 'height', ...size(1) })
    base.g.features.add(`container(${auto})`)
  }
  const steps = base.steps.map((s) => (r() < 0.45 ? { ...s, op: 'resize' as const } : s))
  return { g: finish(base.g), world: { ...base.world, container: { width: 480, height: 300 } }, steps }
}

/**
 * Greedy delta-debugging: drop steps while the SAME kind of failure persists (a shrink that is allowed to end on any failure can end on
 * another bug than the one it was given).
 */
function shrink(target: 'chart' | 'session', g: GenSpec, world: World, steps: Step[], seed: number, kind: string, opts: RunOptions): Step[] {
  let cur = steps
  const fails = (s: Step[]): boolean => run(target, g, world, s, seed, opts).failure?.kind === kind
  for (let pass = 0; pass < 2; pass++) {
    for (let i = cur.length - 1; i >= 0; i--) {
      const trial = cur.slice(0, i).concat(cur.slice(i + 1))
      if (fails(trial)) cur = trial
    }
  }
  return cur
}

export function checkSeed(seed: number, nSteps: number, make: typeof scenario = scenario, opts: RunOptions = {}): string | null {
  const { g, world, steps } = make(seed, nSteps)
  noteCoverage(g, steps, make.name)
  for (const target of ['chart', 'session'] as const) {
    const res = run(target, g, world, steps, seed, opts)
    if (!res.failure) continue
    const f = res.failure
    // (the step that found the failure, not the step the scene came from: a retained scene is changed by a LATER step)
    const minimal = shrink(target, g, world, steps.slice(0, Math.max(0, f.step + 1)), seed, f.kind, opts)
    const again = run(target, g, world, minimal, seed, opts).failure
    const names = minimal.map((s) => `${s.op}/${s.delivery}${s.via === 'change' ? '/change' : ''}${s.keep ? '/keep' : ''}`).join(' -> ')
    return [
      `seed=${seed} target=${target} (reproduce: ASTER_ORACLE_SEED=${seed})`,
      `spec: ${g.label} inlineValues=${g.inlineValues}`,
      `first failing step: ${f.step} (${f.op}) ${f.where}: ${f.detail}`,
      `minimal steps (${minimal.length}): ${names || '(initial evaluation)'}`,
      again?.kind === f.kind
        ? `minimal failure (re-run on the minimal list): step ${again.step} (${again.op}) ${again.where}: ${again.detail}`
        : `the minimal list does NOT reproduce the failure (${again ? `it fails as ${again.kind}` : 'it passes'}): replay the whole seed`,
    ].join('\n  ')
  }
  return null
}

// ---------------------------------------------------------------------------
// Coverage: what the scenarios that RAN contained
// ---------------------------------------------------------------------------

const seen = new Map<string, number>()
const bump = (k: string): void => { seen.set(k, (seen.get(k) ?? 0) + 1) }

/** Count the features of a scenario that is about to run (read off its built spec, see `featuresOf`) and the steps it takes. */
function noteCoverage(g: GenSpec, steps: Step[], family: string): void {
  bump('scenarios')
  bump(`${family}`)
  for (const f of g.features) { bump(f); if (f.startsWith('pipe=')) bump(`${family}:${f}`) }
  for (const s of steps) { bump(`op:${s.op}`); bump(`delivery:${s.delivery}`); bump(`via:${s.via}`); if (s.keep) bump('rows:kept') }
}

/** The counts of every feature the scenarios run so far contained. */
export const coverage = (): ReadonlyMap<string, number> => seen

// ---------------------------------------------------------------------------
// The relational layer: what a node READS rather than the rows it is drawn from
// ---------------------------------------------------------------------------

/**
 * Shapes added to a base scenario (any pipeline, any delivery, any step): each is a place where reuse rests on what a mark, a scale, a
 * signal or a projection reads, so a stale answer shows only when something it reads -- not its own rows -- moved:
 *  - mark-from-mark: a mark drawn from another mark's items, at the top level and inside a group, a text, a rule, a symbol and a `label`
 *    layout over it (C7: a record of the source's items that was the live array the source advances in place);
 *  - per-item: encodes whose every item differs by its datum (signals reading `datum`, rule lists, shape and dash per item);
 *  - nested: a leaf mark inside a facet cell or a group item reading ANOTHER pipeline dataset by expression (C26);
 *  - enter + update, exit, hover, key, zindex, mark sort;
 *  - fitted projections whose consumers read rows of their own while the fit follows another dataset (C42): a dataset with `geopoint`,
 *    a mark with a `geopoint` transform, a `geoshape`, an encode reading `scale('p', ...)`;
 *  - large signal arrays: a signal that holds a data set past what a structural key takes in (C24), and a derived array;
 *  - init-dependent signals: an `init` that reads data, a scale or a published signal;
 *  - transforms that publish signals (`extent`, `bin`), read by marks and by a scale's domain;
 *  - scales of every kind and marks of every kind the base scenarios leave out, a grid `layout`, guide `encode`.
 */
interface Shape {
  name: string
  /** Adds the shape to the scenario's spec. */
  add: (g: GenSpec, r: Rnd, n: number) => void
  /** The shape needs a world of this many rows (a large signal array is large). */
  rows?: [number, number]
  /** The steps the shape's world needs more of. */
  ops?: Op[]
  /** Every step hands the rows over as a host that holds them does (the data set that did not change is the same array). */
  keep?: true
}

interface Parts { data: Spec[]; marks: Spec[]; scales: Spec[]; signals: Spec[]; axes: Spec[]; legends: Spec[]; projections?: Spec[] }
const specOf = (g: GenSpec): Parts => g.spec as unknown as Parts
const xy = (g: GenSpec, extra: Spec = {}): Spec => ({ x: { scale: 'x', field: g.pipe!.xf }, y: { scale: 'y', field: g.pipe!.yf }, ...extra })

const SHAPES: Shape[] = [
  {
    name: 'mark-from-mark',
    add(g, r) {
      const sp = specOf(g)
      const source: Spec = { type: pick(r, ['symbol', 'symbol', 'rect'] as const), name: 'pts', from: { data: g.ds }, encode: { update: { ...xy(g), size: { value: 40 }, fill: { value: '#369' } } } }
      if (source.type === 'rect') source.encode = { update: { x: { scale: 'x', field: g.pipe!.xf }, width: { value: 6 }, y: { scale: 'y', field: g.pipe!.yf }, y2: { scale: 'y', value: 0 } } }
      const yf = g.pipe!.yf
      const dependents: Spec[] = [
        { type: 'text', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, text: { signal: `datum.datum.${yf} + '@' + round(datum.x)` } } } },
        { type: 'rule', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, x2: { field: 'x' }, y: { field: 'y' }, y2: { value: 0 }, stroke: { signal: "datum.datum.g === 'A' ? 'red' : 'blue'" } } } },
        { type: 'symbol', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, y: { field: 'y', offset: 6 }, size: { signal: '20 + round(datum.x) % 7' }, fill: { value: '#e45756' } } } },
        { type: 'text', from: { data: 'pts' }, encode: { update: { text: { field: `datum.${yf}` }, fontSize: { value: 9 } } }, transform: [{ type: 'label', size: [{ signal: 'width' }, { signal: 'height' }], anchor: ['top', 'bottom'], offset: [1, 1] }] },
      ]
      const dep = pick(r, dependents)
      if (r() < 0.4) sp.marks.push({ type: 'group', encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } }, marks: [source, dep] })
      else sp.marks.push(source, dep)
    },
  },
  {
    name: 'per-item',
    add(g, r) {
      const sp = specOf(g)
      const { xf, yf } = g.pipe!
      const n = (f: string): string => `(datum.${f} || 0)`
      sp.marks.push({
        type: 'symbol', from: { data: g.ds },
        encode: {
          update: {
            ...xy(g),
            size: { signal: `10 + ${n(yf)} * 4` },
            angle: { signal: `${n(xf)} * 7` },
            opacity: { signal: `0.3 + 0.1 * (${n(xf)} % 5)` },
            shape: { signal: `${n(xf)} % 2 ? 'square' : 'circle'` },
            fill: [{ test: `${n(yf)} > sig * 4`, value: '#c33' }, { test: `${n(xf)} % 3 === 0`, value: '#3a3' }, { value: '#999' }],
            stroke: { value: '#000' },
            strokeDash: { signal: `[${n(xf)} % 3 + 1, 2]` },
          },
        },
      })
      if (r() < 0.6) sp.marks.push({ type: 'text', from: { data: g.ds }, encode: { update: { ...xy(g), text: { signal: `format(${n(yf)}, '.1f') + '/' + length(data('u'))` }, fontSize: { signal: `8 + ${n(xf)} % 4` }, align: { signal: `${n(yf)} > 10 ? 'left' : 'right'` } } } })
    },
  },
  {
    name: 'nested-reads',
    ops: ['appendU', 'editU', 'appendU', 'bulkU'],
    keep: true,
    add(g, r) {
      const sp = specOf(g)
      const pipe = pick(r, [[{ type: 'formula', expr: 'datum.w * 2', as: 'w2' }], [{ type: 'filter', expr: 'datum.w > 3' }], [{ type: 'collect', sort: { field: 'w' } }], []])
      sp.data.push({ name: 'o', source: 'u', transform: pipe })
      const text = pick(r, [
        "(datum.g || '?') + ':' + length(data('o'))",
        "(datum.g || '?') + ':' + indata('o', 'g', datum.g)",
        "(datum.g || '?') + ':' + (length(data('o')) ? data('o')[0].w : '-')",
      ])
      const leaf = (from: string): Spec => ({ type: 'text', from: { data: from }, encode: { update: { text: { signal: text } } } })
      const kind = pick(r, ['facet', 'group', 'deep'] as const)
      if (kind === 'facet') {
        sp.marks.push({ type: 'group', from: { facet: { name: 'cell', data: g.ds, groupby: g.pipe!.cf ?? 'g' } }, encode: { update: { width: { value: 50 }, height: { value: 30 } } }, marks: [leaf('cell')] })
      } else if (kind === 'group') {
        sp.marks.push({ type: 'group', encode: { update: { width: { value: 80 }, height: { value: 40 } } }, marks: [leaf(g.ds!)] })
      } else {
        sp.marks.push({ type: 'group', encode: { update: { width: { value: 120 }, height: { value: 80 } } }, marks: [{ type: 'group', encode: { update: { width: { value: 60 }, height: { value: 30 } } }, marks: [leaf(g.ds!)] }] })
      }
      // (the same read from the top level: it was right there while the nested one was stale)
      sp.marks.push({ type: 'text', encode: { update: { y: { value: 150 }, text: { signal: "'top:' + length(data('o'))" } } } })
    },
  },
  {
    name: 'enter-update',
    add(g, r, n) {
      const sp = specOf(g)
      // (a keyed join reads the key of the source's own rows: `t` has a unique `k`, a pipeline's rows may not)
      const keyed = n % 2 === 0 && (g.ds === 'd' || g.pipe!.tr.length === 0)
      const from = keyed ? 't' : g.ds
      const xf = keyed ? 'x' : g.pipe!.xf, yf = keyed ? 'v' : g.pipe!.yf
      const enc: Spec = {
        enter: { fill: { value: '#aaa' }, x: { scale: 'x', field: xf } },
        update: { y: { scale: 'y', field: yf }, size: { signal: '20 + sig' } },
      }
      if (r() < 0.6) enc.exit = { opacity: { value: 0 } }
      if (r() < 0.6) enc.hover = { fill: { value: 'orange' }, size: { signal: '60' } }
      const mark: Spec = { type: 'symbol', from: { data: from }, encode: enc }
      if (keyed) mark.key = 'k'
      if (r() < 0.5) mark.sort = { field: yf }
      if (n % 3 !== 1) (enc.update as Spec).zindex = { signal: `(datum.${xf} || 0) % 3` }
      sp.marks.push(mark)
    },
  },
  {
    name: 'fitted-projection',
    add(g, r) {
      const sp = specOf(g)
      sp.data.push(
        { name: 'regions', source: 't', transform: [{ type: 'formula', expr: "'Feature'", as: 'type' }, { type: 'formula', expr: '{type: "Point", coordinates: [datum.x * 10 - 50, datum.v * 2 - 20]}', as: 'geometry' }] },
        { name: 'cities', source: 'u', transform: [{ type: 'formula', expr: 'datum.w * 8 - 40', as: 'lon' }, { type: 'formula', expr: 'datum.w * 3', as: 'lat' }] },
      )
      sp.projections = [{ name: 'p', type: pick(r, ['mercator', 'equirectangular'] as const), fit: { signal: "data('regions')" }, size: [{ signal: 'width' }, { signal: 'height' }] }]
      const kind = pick(r, ['dataset', 'mark', 'shape', 'scale'] as const)
      const cities = sp.data.find((d) => d.name === 'cities')!
      if (kind === 'dataset') {
        (cities.transform as Spec[]).push({ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] })
        sp.marks.push({ type: 'symbol', from: { data: 'cities' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 20 }, fill: { value: '#d62' } } } })
      } else if (kind === 'mark') {
        sp.marks.push({ type: 'symbol', from: { data: 'cities' }, transform: [{ type: 'geopoint', projection: 'p', fields: ['datum.lon', 'datum.lat'] }], encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 20 }, fill: { value: '#26d' } } } })
      } else if (kind === 'shape') {
        sp.marks.push({ type: 'shape', from: { data: 'regions' }, transform: [{ type: 'geoshape', projection: 'p' }], encode: { update: { fill: { value: '#ccc' } } } })
      } else {
        sp.marks.push({ type: 'text', from: { data: 'cities' }, encode: { update: { x: { signal: "scale('p', [datum.lon, datum.lat])[0]" }, y: { signal: "scale('p', [datum.lon, datum.lat])[1]" }, text: { field: 'w' } } } })
      }
    },
  },
  {
    name: 'large-signal',
    rows: [170, 260],
    ops: ['bulk', 'append', 'edit', 'truncate'],
    add(g, r) {
      const sp = specOf(g)
      const yf = g.pipe!.yf
      sp.signals.push({ name: 'whole', update: `data('${g.ds}')` }, { name: 'col', update: `pluck(data('${g.ds}'), '${yf}')` })
      const texts = [
        `length(whole) ? whole[1] && whole[1].${yf} + ':' + length(whole) : 'none'`,
        `length(col) + ':' + col[1] + ':' + col[length(col) - 1]`,
      ]
      sp.marks.push({ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { signal: pick(r, texts) } } } })
    },
  },
  {
    name: 'init-signals',
    add(g, r) {
      const sp = specOf(g)
      sp.signals.push(
        { name: 'first', init: "length(data('t')) ? data('t')[0].v : -1" },
        { name: 'count0', init: `length(data('${g.ds}'))` },
        { name: 'count', update: `length(data('${g.ds}')) + sig` },
        { name: 'sx', init: "scale('x', 5)" },
        { name: 'halfw', init: 'width / 2' },
      )
      const text = pick(r, ["first + '/' + count + '/' + count0", "round(sx) + '/' + halfw", "first + '/' + round(sx) + '/' + count0"])
      sp.marks.push({ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 30 }, text: { signal: text } } } })
    },
  },
  {
    name: 'published-signals',
    add(g, r) {
      const sp = specOf(g)
      sp.data.push({ name: 'ex', source: g.ds, transform: [{ type: 'extent', field: g.pipe!.xf, signal: 'xext' }, { type: 'bin', field: g.pipe!.xf, extent: { signal: 'xext' }, maxbins: 5, signal: 'bn', as: ['b0', 'b1'] }] })
      sp.scales.push({ name: 'ex', type: 'linear', domain: { signal: 'xext' }, range: 'width' })
      sp.marks.push(
        { type: 'text', encode: { update: { x: { value: 10 }, y: { value: 40 }, text: { signal: "'' + xext[0] + '-' + xext[1] + '/' + bn.step" } } } },
        { type: 'rect', from: { data: 'ex' }, encode: { update: { x: { scale: 'ex', field: 'b0' }, x2: { scale: 'ex', field: 'b1' }, y: { value: 0 }, height: { value: 4 }, fill: { value: r() < 0.5 ? '#888' : '#468' } } } },
      )
    },
  },
  {
    name: 'scales',
    add(g, _r, n) {
      const sp = specOf(g)
      const { xf, yf } = g.pipe!
      const zoo: Array<[Spec, string]> = [
        [{ name: 'zsq', type: 'sqrt', domain: { data: g.ds, field: yf }, range: [0, 40] }, 'size'],
        [{ name: 'zsl', type: 'symlog', domain: { data: g.ds, field: yf }, range: [0, 40] }, 'size'],
        [{ name: 'zqz', type: 'quantize', domain: { data: g.ds, field: yf }, range: ['#eee', '#99c', '#339'] }, 'fill'],
        [{ name: 'zqt', type: 'quantile', domain: { data: g.ds, field: yf }, range: ['#eee', '#9c9', '#393'] }, 'fill'],
        [{ name: 'zth', type: 'threshold', domain: [5, 10], range: ['#e66', '#ee6', '#6e6'] }, 'fill'],
        [{ name: 'zsc', type: 'sequential', domain: { data: g.ds, field: yf }, range: { scheme: 'blues' } }, 'fill'],
        [{ name: 'zlg', type: 'log', domain: [1, 100], range: [0, 40], clamp: true }, 'size'],
        [{ name: 'zpw', type: 'pow', exponent: 0.5, domain: { data: g.ds, field: xf }, range: [0, 40] }, 'size'],
        [{ name: 'zbn', type: 'bin-ordinal', domain: { data: g.ds, field: yf }, range: ['#eee', '#cc9', '#996'] }, 'fill'],
      ]
      for (const [sc, channel] of [zoo[(n * 2) % zoo.length]!, zoo[(n * 2 + 1) % zoo.length]!]) {
        if (sp.scales.some((s) => s.name === sc.name)) continue
        sp.scales.push(sc)
        const field = sc.type === 'pow' ? xf : yf
        sp.marks.push({ type: 'symbol', from: { data: g.ds }, encode: { update: { ...xy(g), ...(channel === 'size' ? { size: { scale: sc.name, field } } : { size: { value: 30 }, fill: { scale: sc.name, field } }) } } })
      }
    },
  },
  {
    name: 'marks',
    add(g, r, n) {
      const sp = specOf(g)
      const { xf, yf } = g.pipe!
      const mk: Spec[] = [
        { type: 'area', from: { data: g.ds }, encode: { update: { x: { scale: 'x', field: xf }, y: { scale: 'y', field: yf }, y2: { scale: 'y', value: 0 }, fill: { value: '#9bd' } } } },
        { type: 'rule', from: { data: g.ds }, encode: { update: { x: { scale: 'x', field: xf }, y: { value: 0 }, y2: { scale: 'y', field: yf }, stroke: { value: '#c63' } } } },
        { type: 'arc', from: { data: g.ds }, encode: { update: { x: { value: 100 }, y: { value: 80 }, startAngle: { signal: `(datum.${xf} || 0) * 0.4` }, endAngle: { signal: `(datum.${xf} || 0) * 0.4 + 0.3` }, innerRadius: { value: 10 }, outerRadius: { signal: `20 + (datum.${yf} || 0)` }, fill: { value: '#a5c' } } } },
        { type: 'trail', from: { data: g.ds }, encode: { update: { x: { scale: 'x', field: xf }, y: { scale: 'y', field: yf }, size: { signal: `2 + (datum.${yf} || 0) % 5` }, fill: { value: '#3a8' } } } },
        { type: 'path', from: { data: g.ds }, encode: { update: { path: { signal: `'M0,0L' + (datum.${xf} || 0) * 3 + ',' + (datum.${yf} || 0) * 2 + 'Z'` }, stroke: { value: '#333' } } } },
        { type: 'line', from: { data: g.ds }, sort: { field: xf }, interpolate: { value: pick(r, ['monotone', 'step', 'cardinal'] as const) }, encode: { update: { x: { scale: 'x', field: xf }, y: { scale: 'y', field: yf }, stroke: { value: '#555' } } } },
        { type: 'rect', from: { data: g.ds }, encode: { update: { x: { scale: 'x', field: xf }, width: { value: 5 }, y: { scale: 'y', field: yf }, y2: { scale: 'y', value: 0 }, cornerRadius: { signal: `(datum.${xf} || 0) % 3` }, fill: { value: '#b84' } } } },
      ]
      sp.marks.push(mk[(n * 2) % mk.length]!, mk[(n * 2 + 1) % mk.length]!)
    },
  },
  {
    name: 'layout-guides',
    add(g, r) {
      const sp = specOf(g)
      const cf = g.pipe!.cf ?? 'g'
      sp.marks.push({
        type: 'group', layout: { columns: pick(r, [1, 2, 3]), padding: 6, bounds: pick(r, ['full', 'flush'] as const), align: 'each' },
        marks: [{
          type: 'group', from: { facet: { name: 'fc', data: g.ds, groupby: cf } }, encode: { update: { width: { value: 60 }, height: { value: 40 } } },
          marks: [{ type: 'symbol', from: { data: 'fc' }, encode: { update: xy(g, { size: { value: 16 } }) } }],
        }],
      })
      sp.axes.push({ scale: 'x', orient: 'top', encode: { labels: { update: { fill: { signal: 'sig > 4 ? "red" : "blue"' }, angle: { signal: 'sig * 5' } } }, ticks: { update: { stroke: { signal: 'sig > 6 ? "green" : "grey"' } } } } })
      if (sp.legends.length) sp.legends[0]!.encode = { symbols: { update: { size: { signal: '30 + sig * 10' } } } }
    },
  },
]

/** Shapes added after the first ten (their seeds are pinned): an image mark, time and utc scales, `format.parse` on rows the host gives. */
const MORE_SHAPES: Shape[] = [
  {
    name: 'image',
    ops: ['policy', 'signal', 'edit', 'policy', 'append'],
    add(g, r) {
      const sp = specOf(g)
      const { xf } = g.pipe!
      // (absolute urls on two hosts, by the datum: the host's policy admits one, both or -- as a denied image is dropped -- neither;
      // the item's url, and whether it has one, follow the policy the evaluation is made under)
      sp.marks.push({
        type: 'image', from: { data: g.ds },
        encode: { update: { ...xy(g), width: { value: 8 }, height: { signal: '6 + sig' }, url: { signal: `'https://' + ((datum.${xf} || 0) % 2 ? 'a' : 'b') + '.example/img/' + (sig % 3) + '.png'` }, aspect: { value: r() < 0.5 }, align: { value: 'center' } } },
      })
    },
  },
  {
    name: 'time-scales',
    add(g, r, n) {
      const sp = specOf(g)
      sp.data.push({ name: 'dt', source: 't', transform: [{ type: 'formula', expr: 'datetime(2020, (datum.x || 0) % 12, 1 + ((datum.v || 0) % 27))', as: 'when' }] })
      sp.scales.push(
        { name: 'tm', type: 'time', domain: { data: 'dt', field: 'when' }, range: 'width', nice: n % 2 === 0 },
        { name: 'tu', type: 'utc', domain: { data: 'dt', field: 'when' }, range: 'width' },
      )
      sp.marks.push(
        { type: 'symbol', from: { data: 'dt' }, encode: { update: { x: { scale: 'tm', field: 'when' }, y: { scale: 'y', field: 'v' }, size: { value: 14 }, fill: { value: '#a55' } } } },
        { type: 'rule', from: { data: 'dt' }, encode: { update: { x: { scale: 'tu', field: 'when' }, y: { value: 0 }, y2: { value: 6 }, stroke: { value: '#55a' } } } },
      )
      sp.axes.push({ scale: 'tm', orient: 'top', ...(r() < 0.5 ? { format: '%b' } : {}) }, { scale: 'tu', orient: 'bottom', formatType: 'utc', format: '%d' })
    },
  },
  {
    name: 'format-parse',
    add(g) {
      const sp = specOf(g)
      // (`s` is a numeric string in every row: parsed, it is a number; a static data set parses its inline rows the same way)
      const t = sp.data.find((d) => d.name === 't')!
      t.format = { type: 'json', parse: { s: 'number' } }
      sp.data.push({ name: 'fp', values: [{ n: '3', d: '2020-03-01', b: 'true' }, { n: '7', d: '2020-07-15', b: 'false' }], format: { type: 'json', parse: { n: 'number', d: 'date', b: 'boolean' } } })
      sp.marks.push(
        { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 20 }, size: { signal: '10 + datum.s * 2' }, fill: { value: '#c80' } } } },
        { type: 'text', from: { data: 'fp' }, encode: { update: { x: { value: 10 }, y: { value: 60 }, dy: { signal: 'datum.n' }, text: { signal: "(datum.b ? 'y' : 'n') + (datum.d ? year(datum.d) : '')" } } } },
      )
    },
  },
]

/** The relational shapes, in the order seeds take them. */
export const SHAPE_NAMES: readonly string[] = SHAPES.map((x) => x.name)
export const MORE_SHAPE_NAMES: readonly string[] = MORE_SHAPES.map((x) => x.name)

/**
 * The base scenarios (any pipeline) with one relational shape added -- seed n takes shape n mod the list, so any run of
 * `SHAPE_NAMES.length` seeds takes every shape -- and, one time in three, a second shape on top.
 */
export function scenarioRelational(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  return relational(SHAPES, seed, nSteps, OFFSET.scenarioRelational)
}

/** The same over `MORE_SHAPES`, from seeds of its own. */
export function scenarioRelationalMore(seed: number, nSteps: number): { g: GenSpec; world: World; steps: Step[] } {
  return relational(MORE_SHAPES, seed, nSteps, OFFSET.scenarioRelationalMore)
}

function relational(list: Shape[], seed: number, nSteps: number, offset: number): { g: GenSpec; world: World; steps: Step[] } {
  const shape = list[(seed - 1) % list.length]!
  const r = mulberry32(seed ^ 0x4e1a7)
  const base = scenario(seed + offset, nSteps)
  // (the base scenario's spec is `onSource` for a third of the pipelines: a shape reads `g.ds`, the data set the marks read)
  const chosen = [shape]
  if (r() < 0.33) chosen.push(pick(r, SHAPES.filter((x) => x !== shape && !x.rows)))
  const occurrence = Math.floor((seed - 1) / list.length)
  for (const sh of chosen) { sh.add(base.g, r, occurrence); base.g.features.add(`shape=${sh.name}`) }
  const rows = chosen.find((x) => x.rows)?.rows
  const world = rows ? genWorld(mulberry32(seed ^ 0xb16), rows) : base.world
  const holds = chosen.some((x) => x.keep)
  const steps0 = holds ? base.steps.map((s) => ({ ...s, keep: true })) : base.steps
  const steps = chosen.some((x) => x.ops) ? steps0.map((s) => (r() < 0.85 ? { ...s, op: pick(r, chosen.find((x) => x.ops)!.ops!) } : s)) : steps0
  return { g: finish(base.g), world, steps }
}

/** A whole-number knob: unset gives the default, anything else that is not a whole number of at least `min` is an error (never a sweep of nothing). */
export function wholeNumberKnob(name: string, raw: string | undefined, dflt: number, min: number): number {
  if (raw === undefined) return dflt
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`)
  return n
}
