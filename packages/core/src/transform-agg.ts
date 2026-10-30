/**
 * Aggregation machinery: a faithful port of vega-transforms' `Aggregate`,
 * `JoinAggregate`, `Pivot` and `Window` transforms, their measure table
 * (`util/AggregateOps`), `TupleStore`, the window-op table and the
 * vega-statistics helpers they use (quartiles, bootstrap confidence interval).
 *
 * The semantics worth knowing, all pinned by `testdata/vectors/vega-transforms.json`:
 *  - values are NOT coerced up front: a measure sees the raw field value. `null`,
 *    `undefined` and `''` are `missing`; `NaN` is neither missing nor valid;
 *    everything else is valid and flows into the op with JS coercion (`+v` for
 *    sum, `v - mean` for mean/variance, `<`/`>` for min/max), so numeric strings
 *    and Dates aggregate the way Vega aggregates them;
 *  - a group with no valid value yields `undefined` (not `NaN`) for most ops;
 *  - group cells are keyed by `String(a)|b|...` of the groupby values and the
 *    cell's group values come from the first tuple that created it;
 *  - ops are evaluated in Vega's `idx` order and `argmin`/`argmax`/`values`
 *    return the very tuples.
 *
 * Deviations (deliberate, documented):
 *  - the input rows are never mutated; the transforms that write onto their
 *    tuples in Vega (joinaggregate, window) write onto copies, which are also
 *    the objects `argmin`/`values` return (so the structure matches Vega's);
 *  - lookup tables are prototype-less, so a data value such as `constructor` is
 *    a plain key rather than an inherited member;
 *  - `random` is a seeded LCG (see {@link SEED}) instead of `Math.random`, so a
 *    bootstrap interval (ci0/ci1) is a pure function of the data: an incremental
 *    evaluation equals a fresh one.
 */
import { accessor, accessorFields, accessorName, array, ascending, constant, sortData, error, extent as vegaExtent, field, identity, type Accessor } from './util.js'
import { meterTick } from './limits.js'
import { ascending as d3Ascending, quantileSorted } from './arr.js'

export type Row = Record<string, unknown>
type Get = (d: unknown) => unknown
type Compare = (a: unknown, b: unknown) => number

// ---------------------------------------------------------------------------
// random (vega-statistics `lcg`), field accessors, comparators
// ---------------------------------------------------------------------------

/** Seed of the engine's pseudo-random stream; the oracle vectors are recorded with the same seed. */
export const SEED = 42

/** vega-statistics' `randomLCG`: the glibc linear congruential generator. */
export function lcg(seed: number): () => number {
  return function () {
    seed = (1103515245 * seed + 12345) % 2147483647
    return seed / 2147483647
  }
}

const fieldCache = new Map<string, Accessor>()
/** Memoised `vega-util` `field(str)` accessor (parsing `a.b`, `a[0]`, `a\.b` once). */
export function fieldOf(name: unknown): Accessor {
  if (typeof name !== 'string') return field(name)
  let a = fieldCache.get(name)
  if (a === undefined) {
    if (fieldCache.size >= 4096) fieldCache.clear()
    a = field(name)
    fieldCache.set(name, a)
  }
  return a
}

/** Field accessors of an optional list of field names (`null` entries stay `null`). */
export function fieldsOf(names: unknown): Accessor[] {
  return array(names).map((n) => fieldOf(n))
}

/**
 * Stable sort of `items` by a vega `compare` spec ({field, order}): the field values are read once per item
 * (accessors are pure) instead of twice per comparison. `null` when the spec names no field.
 */
export function sortBySpec<T>(items: readonly T[], sort: unknown): T[] | null {
  if (sort == null) return null
  const sp = sort as { field?: unknown; order?: unknown }
  const fields = array(sp.field)
  const orders = array(sp.order)
  const get: Accessor[] = []
  const ord: number[] = []
  fields.forEach((f, i) => {
    if (f == null) return
    ord.push(orders[i] === 'descending' ? -1 : 1)
    get.push(typeof f === 'function' ? (f as Accessor) : fieldOf(f))
  })
  const m = get.length
  if (m === 0) return null
  const n = items.length
  const keys: unknown[][] = get.map((g) => {
    const k = new Array<unknown>(n)
    for (let i = 0; i < n; i++) k[i] = g(items[i])
    return k
  })
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  if (m === 1) {
    const k0 = keys[0]!
    const o = ord[0]!
    sortData(order, (i, j) => cmp1(k0[i], k0[j]) * o || i - j)
  } else {
    const ords = ord.concat(0) // pad zero for convenient lookup
    sortData(order, (i, j) => {
      let c = 0
      let f = -1
      while (c === 0 && ++f < m) c = cmp1(keys[f]![i], keys[f]![j])
      return c * ords[f]! || i - j
    })
  }
  const out = new Array<T>(n)
  for (let i = 0; i < n; i++) out[i] = items[order[i]!]!
  return out
}

/** vega-util `ascending`, with a shortcut for the two common cases (non-NaN numbers, strings) that it decides identically. */
function cmp1(u: unknown, v: unknown): number {
  const tu = typeof u
  if (tu === typeof v && (tu === 'string' || (tu === 'number' && u === u && v === v))) {
    return (u as number) < (v as number) ? -1 : (u as number) > (v as number) ? 1 : 0
  }
  return ascending(u, v)
}

/** A comparator accessor for vega's `compare` param (`{field, order}`), or `null` when it names no field. */
export function compareOf(sort: unknown): Accessor<number> | null {
  if (sort == null) return null
  const s = sort as { field?: unknown; order?: unknown }
  const fields = array(s.field)
  const orders = array(s.order)
  const ord: number[] = []
  const get: Accessor[] = []
  const fmap: Record<string, number> = Object.create(null) as Record<string, number>
  fields.forEach((f, i) => {
    if (f == null) return
    ord.push(orders[i] === 'descending' ? -1 : 1)
    const a = typeof f === 'function' ? (f as Accessor) : fieldOf(f)
    get.push(a)
    for (const k of accessorFields(a) ?? []) fmap[k] = 1
  })
  if (get.length === 0) return null
  const cmp: Compare = get.length === 1
    ? (() => {
      const f = get[0]!
      const o = ord[0]!
      return (a: unknown, b: unknown) => cmp1(f(a), f(b)) * o
    })()
    : (() => {
      const n = get.length
      const orders2 = ord.concat(0) // pad zero for convenient lookup
      return (a: unknown, b: unknown) => {
        let c = 0
        let i = -1
        while (c === 0 && ++i < n) {
          const f = get[i]!
          c = cmp1(f(a), f(b))
        }
        return c * orders2[i]!
      }
    })()
  return accessor(cmp as (d: unknown) => number, Object.keys(fmap))
}

/**
 * `Array.prototype.sort` with vega-dataflow's `stableCompare`: ties break by input
 * position. The positions are sorted (not the items), so the comparator sees
 * exactly the sequence of results upstream's tupleid tie-break produces, even for
 * the non-transitive orderings NaN creates.
 */
export function stableSortBy<T>(items: readonly T[], cmp: Compare | null): T[] {
  if (!cmp) return items.slice()
  const n = items.length
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  sortData(order, (i, j) => cmp(items[i], items[j]) || i - j)
  const out = new Array<T>(n)
  for (let i = 0; i < n; i++) out[i] = items[order[i]!]!
  return out
}

// ---------------------------------------------------------------------------
// vega-statistics helpers
// ---------------------------------------------------------------------------

/** vega-statistics `numbers(values, f)`: coerce to finite numbers, dropping null, '' and NaN. */
export function numbersOf(values: ArrayLike<unknown>, f?: Get): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    let v: unknown = f ? f(values[i]) : values[i]
    if (v != null && v !== '' && (v = +(v as number)) >= (v as number)) out.push(v as number)
  }
  return out
}

/** vega-statistics `quantiles(array, p, f)`. */
export function quantiles(arr: ArrayLike<unknown>, p: readonly number[], f?: Get): Array<number | undefined> {
  const values = Float64Array.from(numbersOf(arr, f))
  values.sort(d3Ascending)
  return p.map((q) => quantileSorted(values, q))
}

/** vega-statistics `quartiles`. */
export function quartiles(arr: ArrayLike<unknown>, f?: Get): Array<number | undefined> {
  return quantiles(arr, [0.25, 0.5, 0.75], f)
}

/**
 * The percentile interval of the mean by bootstrap resampling: `samples` resamples of the valid numbers, each as large as the data
 * and drawn with replacement, give `samples` means; the interval runs from their `alpha / 2` to their `1 - alpha / 2` quantile.
 * An empty input has no interval. Fixed by the output: each resample takes its `n` indices as `~~(random() * n)`, one draw per
 * index and resample after resample, and a mean is the plain sum in draw order over `n`.
 */
export function bootstrapCI(arr: ArrayLike<unknown>, samples: number, alpha: number, f: Get | undefined, random: () => number): [number | undefined, number | undefined] {
  if (!arr.length) return [undefined, undefined]
  const values = Float64Array.from(numbersOf(arr, f))
  const n = values.length
  const means = new Float64Array(samples)
  for (let s = 0; s < samples; ++s) {
    let total = 0
    for (let i = 0; i < n; ++i) total += values[~~(random() * n)]!
    means[s] = total / n
    meterTick('bootstrap', n)
  }
  // the means of data with no valid number are NaN and are left out; the rest sort numerically
  const sorted = means.filter((mean) => mean === mean).sort()
  return [quantileSorted(sorted, alpha / 2), quantileSorted(sorted, 1 - alpha / 2)]
}

/** vega-util `extentIndex`: indices of the min and max, skipping null/undefined/NaN; `[-1, -1]` if none. */
function extentIndex(arr: ArrayLike<unknown>, f: Get): [number, number] {
  const n = arr.length
  let i = -1
  let u: number
  let v: number
  let a: unknown
  let b: unknown
  let c: unknown
  while (++i < n) {
    b = f(arr[i])
    if (b != null && (b as number) >= (b as number)) { a = c = b; break }
  }
  if (i === n) return [-1, -1]
  u = v = i
  while (++i < n) {
    b = f(arr[i])
    if (b != null) {
      if ((a as number) > (b as number)) { a = b; u = i }
      if ((c as number) < (b as number)) { c = b; v = i }
    }
  }
  return [u, v]
}

// ---------------------------------------------------------------------------
// TupleStore (vega-transforms util/TupleStore)
// ---------------------------------------------------------------------------

/** Shared per-application environment: the seeded random stream. */
export interface AggEnv { random: () => number }

/** `random`: the host's injected source ({@link ExpressionRuntime.random}); without one, the engine's seeded stream. */
export function newEnv(random?: () => number): AggEnv {
  return { random: random ?? lcg(SEED) }
}

/** The tuples of one aggregation cell, with memoised statistics. */
class TupleStore {
  private _add: Row[] = []
  private _rem = new Set<Row>()
  private _remN = 0
  private _ext: [Row | undefined, Row | undefined] | null = null
  private _get: Get | null = null
  private _q: Array<number | undefined> | null = null
  private _ci: [number | undefined, number | undefined] | null = null
  private readonly env: AggEnv
  constructor(env: AggEnv) { this.env = env }

  reset(): void {
    this._add = []
    this._rem = new Set()
    this._remN = 0
    this._ext = null
    this._get = null
    this._q = null
    // (the bootstrap interval is not forgotten: vega's reset keeps it, and a later read under the same accessor returns it)
  }
  add(v: Row): void { this._add.push(v) }
  rem(v: Row): void { this._rem.add(v); this._remN++ }

  values(): Row[] {
    this._get = null
    if (this._rem.size === 0) return this._add
    meterTick('aggregate', this._add.length)
    const a = this._add
    const r = this._rem
    // sized by the removals asked for: more of them than rows is a RangeError, and one that matches no row leaves a hole
    const x = new Array<Row>(a.length - this._remN)
    let j = 0
    for (let i = 0; i < a.length; ++i) {
      const v = a[i]!
      if (r.has(v)) r.delete(v)
      else x[j++] = v
    }
    this._rem = new Set()
    this._remN = 0
    return (this._add = x)
  }

  distinct(get: Get): number {
    const v = this.values()
    meterTick('aggregate', v.length)
    const seen = new Set<string>()
    for (let n = v.length; --n >= 0;) seen.add(get(v[n]) + '')
    return seen.size
  }

  extent(get: Get): [Row | undefined, Row | undefined] {
    if (this._get !== get || !this._ext) {
      const v = this.values()
      meterTick('aggregate', v.length)
      const i = extentIndex(v, get)
      this._ext = [v[i[0]], v[i[1]]]
      this._get = get
    }
    return this._ext
  }
  argmin(get: Get): Row { return this.extent(get)[0] || {} }
  argmax(get: Get): Row { return this.extent(get)[1] || {} }
  min(get: Get): unknown { const m = this.extent(get)[0]; return m != null ? get(m) : undefined }
  max(get: Get): unknown { const m = this.extent(get)[1]; return m != null ? get(m) : undefined }

  quartile(get: Get): Array<number | undefined> {
    if (this._get !== get || !this._q) {
      const v = this.values()
      // a sort per call: O(n log n) work, which a window re-pays at every row
      meterTick('aggregate', v.length * 8)
      this._q = quartiles(v, get)
      this._get = get
    }
    return this._q
  }
  q1(get: Get): number | undefined { return this.quartile(get)[0] }
  q2(get: Get): number | undefined { return this.quartile(get)[1] }
  q3(get: Get): number | undefined { return this.quartile(get)[2] }

  ci(get: Get): [number | undefined, number | undefined] {
    if (this._get !== get || !this._ci) {
      this._ci = bootstrapCI(this.values(), 1000, 0.05, get, this.env.random)
      this._get = get
    }
    return this._ci
  }
  ci0(get: Get): number | undefined { return this.ci(get)[0] }
  ci1(get: Get): number | undefined { return this.ci(get)[1] }
}

// ---------------------------------------------------------------------------
// aggregate measures (vega-transforms util/AggregateOps)
// ---------------------------------------------------------------------------

/** The cell a measure belongs to. */
interface MCell {
  num: number
  store: boolean
  data?: TupleStore
}

/**
 * Per-field measure state. The numeric fields are written by the ops' `init`
 * (as upstream); `v` arguments below are RAW field values, typed `number` only
 * because upstream relies on JS coercion (`+v`, `v - mean`, `v < min`).
 */
class MState {
  cell!: MCell
  _ops!: Measure[]
  _out!: Measure[]
  get!: Get
  valid = 0
  missing = 0
  sum = 0
  product = 1
  mean = 0
  mean_d = 0
  dev = 0
  min: unknown = undefined
  max: unknown = undefined
  argmin: unknown = undefined
  argmax: unknown = undefined
  exp = 0
  exp_r = 0

  init(): void {
    this.valid = 0
    this.missing = 0
    for (const op of this._ops) {
      if (op.aggregate_param == null) op.init(this)
      else op.init(this, op.aggregate_param)
    }
  }
  add(v: unknown, t: Row): void {
    if (v == null || v === '') { ++this.missing; return }
    if (v !== v) return
    ++this.valid
    for (const op of this._ops) op.add(this, v as number, t)
  }
  rem(v: unknown, t: Row): void {
    if (v == null || v === '') { --this.missing; return }
    if (v !== v) return
    --this.valid
    for (const op of this._ops) op.rem(this, v as number, t)
  }
  set(t: Row): void {
    for (const op of this._out) t[op.out] = op.value(this)
  }
}

interface Measure {
  name: string
  aggregate_param: number | null
  out: string
  idx: number
  req?: string[]
  init(m: MState, r?: number): void
  add(m: MState, v: number, t: Row): void
  rem(m: MState, v: number, t: Row): void
  value(m: MState): unknown
}

type OpDef = Partial<Pick<Measure, 'init' | 'add' | 'rem' | 'idx' | 'req'>> & Pick<Measure, 'value'>

const noop = (): void => {}

const OP_DEFS: Record<string, OpDef> = {
  values: {
    init: (m) => { m.cell.store = true },
    value: (m) => m.cell.data!.values(),
    idx: -1,
  },
  count: { value: (m) => m.cell.num },
  __count__: { value: (m) => m.missing + m.valid },
  missing: { value: (m) => m.missing },
  valid: { value: (m) => m.valid },
  sum: {
    init: (m) => { m.sum = 0 },
    value: (m) => (m.valid ? m.sum : undefined),
    add: (m, v) => { m.sum += +v },
    rem: (m, v) => { m.sum -= v },
  },
  product: {
    init: (m) => { m.product = 1 },
    value: (m) => (m.valid ? m.product : undefined),
    add: (m, v) => { m.product *= v },
    rem: (m, v) => { m.product /= v },
  },
  mean: {
    init: (m) => { m.mean = 0 },
    value: (m) => (m.valid ? m.mean : undefined),
    add: (m, v) => { m.mean_d = v - m.mean; m.mean += m.mean_d / m.valid },
    rem: (m, v) => { m.mean_d = v - m.mean; m.mean -= m.valid ? m.mean_d / m.valid : m.mean },
  },
  average: {
    value: (m) => (m.valid ? m.mean : undefined),
    req: ['mean'], idx: 1,
  },
  variance: {
    init: (m) => { m.dev = 0 },
    value: (m) => (m.valid > 1 ? Math.max(0, m.dev) / (m.valid - 1) : undefined),
    add: (m, v) => { m.dev += m.mean_d * (v - m.mean) },
    rem: (m, v) => { m.dev -= m.mean_d * (v - m.mean) },
    req: ['mean'], idx: 1,
  },
  variancep: {
    value: (m) => (m.valid ? Math.max(0, m.dev) / m.valid : undefined),
    req: ['variance'], idx: 2,
  },
  stdev: {
    value: (m) => (m.valid > 1 ? Math.sqrt(Math.max(0, m.dev) / (m.valid - 1)) : undefined),
    req: ['variance'], idx: 2,
  },
  stdevp: {
    value: (m) => (m.valid ? Math.sqrt(Math.max(0, m.dev) / m.valid) : undefined),
    req: ['variance'], idx: 2,
  },
  stderr: {
    value: (m) => (m.valid > 1 ? Math.sqrt(Math.max(0, m.dev) / (m.valid * (m.valid - 1))) : undefined),
    req: ['variance'], idx: 2,
  },
  distinct: { value: (m) => m.cell.data!.distinct(m.get), req: ['values'], idx: 3 },
  ci0: { value: (m) => m.cell.data!.ci0(m.get), req: ['values'], idx: 3 },
  ci1: { value: (m) => m.cell.data!.ci1(m.get), req: ['values'], idx: 3 },
  median: { value: (m) => m.cell.data!.q2(m.get), req: ['values'], idx: 3 },
  q1: { value: (m) => m.cell.data!.q1(m.get), req: ['values'], idx: 3 },
  q3: { value: (m) => m.cell.data!.q3(m.get), req: ['values'], idx: 3 },
  min: {
    init: (m) => { m.min = undefined },
    value: (m) => (m.min = Number.isNaN(m.min) ? m.cell.data!.min(m.get) : m.min),
    add: (m, v) => { if (v < (m.min as number) || m.min === undefined) m.min = v },
    rem: (m, v) => { if (v <= (m.min as number)) m.min = NaN },
    req: ['values'], idx: 4,
  },
  max: {
    init: (m) => { m.max = undefined },
    value: (m) => (m.max = Number.isNaN(m.max) ? m.cell.data!.max(m.get) : m.max),
    add: (m, v) => { if (v > (m.max as number) || m.max === undefined) m.max = v },
    rem: (m, v) => { if (v >= (m.max as number)) m.max = NaN },
    req: ['values'], idx: 4,
  },
  argmin: {
    init: (m) => { m.argmin = undefined },
    value: (m) => m.argmin || m.cell.data!.argmin(m.get),
    add: (m, v, t) => { if (v < (m.min as number)) m.argmin = t },
    rem: (m, v) => { if (v <= (m.min as number)) m.argmin = undefined },
    req: ['min', 'values'], idx: 3,
  },
  argmax: {
    init: (m) => { m.argmax = undefined },
    value: (m) => m.argmax || m.cell.data!.argmax(m.get),
    add: (m, v, t) => { if (v > (m.max as number)) m.argmax = t },
    rem: (m, v) => { if (v >= (m.max as number)) m.argmax = undefined },
    req: ['max', 'values'], idx: 3,
  },
  exponential: {
    init: (m, r) => { m.exp = 0; m.exp_r = r as number },
    value: (m) => (m.valid ? (m.exp * (1 - m.exp_r) / (1 - m.exp_r ** m.valid)) : undefined),
    add: (m, v) => { m.exp = m.exp_r * m.exp + v },
    rem: (m, v) => { m.exp = (m.exp - v / m.exp_r ** (m.valid - 1)) / m.exp_r },
  },
  exponentialb: {
    value: (m) => (m.valid ? (m.exp * (1 - m.exp_r)) : undefined),
    req: ['exponential'], idx: 1,
  },
}

/** The aggregate op names (`ValidAggregateOps`). */
export const VALID_AGGREGATE_OPS: readonly string[] = Object.keys(OP_DEFS).filter((d) => d !== '__count__')

export function isAggregateOp(op: string): boolean {
  return Object.hasOwn(OP_DEFS, op)
}

/** Output field name of a measure: the explicit alias, or `op` / `op_field`. */
export function measureName(op: string, fieldName: string | null | undefined, as?: string | null): string {
  return as || (op + (!fieldName ? '' : '_' + fieldName))
}

function createMeasure(op: string, param: number | null, name?: string): Measure {
  const def = OP_DEFS[op]
  // upstream: `AggregateOps[op]` is not a function -> TypeError for an unknown op
  if (def === undefined || !Object.hasOwn(OP_DEFS, op)) error(`[aster] unsupported aggregate op "${op}" (vega: AggregateOps[op] is not a function)`)
  return { name: op, aggregate_param: param, out: name || op, init: noop, add: noop, rem: noop, idx: 0, ...def }
}

function resolveMeasures(agg: Measure[]): Measure[] {
  const map = new Map<string, Measure>()
  for (const a of agg) map.set(a.name, a)
  const getreqs = (a: Measure): void => {
    if (!a.req) return
    for (const key of a.req) {
      if (!map.has(key)) {
        const r = createMeasure(key, null)
        map.set(key, r)
        getreqs(r)
      }
    }
  }
  for (const a of agg) getreqs(a)
  return [...map.values()].sort((a, b) => a.idx - b.idx)
}

type MeasureCtor = (cell: MCell) => MState

/** Compile the measures of one field into a state constructor. */
function compileMeasures(agg: Measure[], f: Get | null): MeasureCtor {
  const get = f || (identity as Get)
  const ops = resolveMeasures(agg)
  const out = agg.slice().sort((a, b) => a.idx - b.idx)
  return (cell: MCell) => {
    const m = new MState()
    m._ops = ops
    m._out = out
    m.cell = cell
    m.get = get
    m.init()
    return m
  }
}

// ---------------------------------------------------------------------------
// group keys (vega-transforms util/AggregateKeys)
// ---------------------------------------------------------------------------

type KeyFn = (d: unknown) => string

/** `groupkey(fields)`: '' for none, `String(v)` for one, `a|b|...` for several. */
export function groupkey(fields: readonly Get[] | null | undefined): KeyFn {
  if (!fields || !fields.length) return () => ''
  if (fields.length === 1) {
    const f = fields[0]!
    return (x) => f(x) as string
  }
  const n = fields.length
  return (x) => {
    let k = String(fields[0]!(x))
    for (let i = 1; i < n; ++i) k += '|' + fields[i]!(x)
    return k
  }
}

const EMPTY_GROUPBY: readonly Accessor[] = []
const groupKeyFns = new WeakMap<object, (r: Row) => string>()

/**
 * The partition key of an aggregate / joinaggregate / window `groupby` as a
 * string: what the incremental evaluation groups by, so it partitions exactly
 * like {@link aggregateRows}.
 */
export function groupKeyFn(groupby: unknown): (r: Row) => string {
  if (groupby == null || (Array.isArray(groupby) && groupby.length === 0)) return () => ''
  let f = typeof groupby === 'object' ? groupKeyFns.get(groupby) : undefined
  if (!f) {
    const key = groupkey(fieldsOf(groupby) ?? EMPTY_GROUPBY)
    f = (r) => String(key(r))
    if (typeof groupby === 'object') groupKeyFns.set(groupby, f)
  }
  return f
}

// ---------------------------------------------------------------------------
// shared measure setup for Aggregate / Window (the two parse ops + fields alike)
// ---------------------------------------------------------------------------

interface MeasureSet {
  counts: string[]
  measures: MeasureCtor[]
  countOnly: boolean
  outputs: string[]
}

function buildMeasures(ops: readonly string[], fields: ReadonlyArray<Accessor | null | undefined>, as: ReadonlyArray<string | null | undefined>, aggParams: ReadonlyArray<number | null | undefined>, outputs: string[]): MeasureSet {
  const counts: string[] = []
  const list: Array<Measure[] & { field?: Accessor | null }> = []
  const map = new Map<string | null, Measure[] & { field?: Accessor | null }>()
  let countOnly = true
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    const f = fields[i]
    const aggregate_param = aggParams[i] || null
    if (f == null && op !== 'count') error('Null aggregate field specified.')
    const mname = accessorName(f)
    const outname = measureName(op, mname, as[i])
    outputs.push(outname)
    if (op === 'count') { counts.push(outname); continue }
    countOnly = false
    let m = map.get(mname)
    if (!m) {
      m = [] as Measure[] & { field?: Accessor | null }
      m.field = f
      map.set(mname, m)
      list.push(m)
    }
    m.push(createMeasure(op, aggregate_param, outname))
  }
  return { counts, measures: list.map((m) => compileMeasures(m, m.field ?? null)), countOnly, outputs }
}

// ---------------------------------------------------------------------------
// aggregate / joinaggregate / pivot
// ---------------------------------------------------------------------------

export interface AggregateParams {
  groupby?: unknown
  fields?: unknown
  ops?: unknown
  aggregate_params?: unknown
  as?: unknown
  drop?: unknown
  cross?: unknown
  key?: unknown
}

interface Cell extends MCell {
  key: string
  agg: MState[] | null
  tuple: Row
}

interface Aggregator {
  cells: Record<string, Cell>
  adds: Cell[]
  dims: Accessor[]
  dnames: string[]
  cellkey: KeyFn
  measures: MeasureCtor[]
  counts: string[]
  countOnly: boolean
  env: AggEnv
}

function makeAggregator(groupby: unknown, key: unknown, ms: MeasureSet, env: AggEnv): Aggregator {
  const dims = fieldsOf(groupby)
  const dnames = dims.map((d) => accessorName(d) as string)
  const cellkey: KeyFn = key ? (fieldOf(key) as unknown as KeyFn) : groupkey(dims)
  return {
    cells: Object.create(null) as Record<string, Cell>,
    adds: [], dims, dnames, cellkey,
    measures: ms.measures, counts: ms.counts, countOnly: ms.countOnly, env,
  }
}

function newAggregator(p: AggregateParams, env: AggEnv): Aggregator {
  const fields = (p.fields == null ? [null] : array(p.fields)).map((f) => (f == null ? null : fieldOf(f)))
  const ops = (p.ops == null ? ['count'] : array(p.ops)) as string[]
  const aggParams = (p.aggregate_params == null ? [null] : array(p.aggregate_params)) as Array<number | null>
  const as = array(p.as) as Array<string | null>
  if (fields.length !== ops.length) error('Unmatched number of fields and aggregate ops.')
  // group-by names come first among the outputs, then the measures (as upstream)
  const ms = buildMeasures(ops, fields, as, aggParams, [])
  return makeAggregator(p.groupby, p.key, ms, env)
}

function newcell(a: Aggregator, key: string, t: Row): Cell {
  const x: Row = {}
  for (let i = 0; i < a.dims.length; ++i) x[a.dnames[i]!] = a.dims[i]!(t)
  const cell: Cell = { key, num: 0, agg: null, tuple: x, store: false }
  if (!a.countOnly) {
    const n = a.measures.length
    cell.agg = new Array<MState>(n)
    for (let i = 0; i < n; ++i) cell.agg[i] = a.measures[i]!(cell)
  }
  if (cell.store) cell.data = new TupleStore(a.env)
  return cell
}

function cellFor(a: Aggregator, key: string, t: Row): Cell {
  let cell = a.cells[key]
  if (!cell) {
    cell = a.cells[key] = newcell(a, key, t)
    a.adds.push(cell)
  }
  return cell
}

function addTuple(a: Aggregator, t: Row): void {
  const cell = cellFor(a, a.cellkey(t), t)
  cell.num += 1
  if (a.countOnly) return
  if (cell.store) cell.data!.add(t)
  const agg = cell.agg!
  for (let i = 0, n = agg.length; i < n; ++i) agg[i]!.add(agg[i]!.get(t), t)
}

function celltuple(a: Aggregator, cell: Cell): Row {
  const tuple = cell.tuple
  if (cell.store) cell.data!.values()
  for (const c of a.counts) tuple[c] = cell.num
  if (!a.countOnly) for (const m of cell.agg!) m.set(tuple)
  return tuple
}

/** Generate the cells of the full cross-product of the group-by domains (vega `cross`). */
function crossCells(a: Aggregator): void {
  const dims = a.dnames
  const n = dims.length
  const vals: Array<Record<string, unknown>> = dims.map(() => Object.create(null) as Record<string, unknown>)
  for (const key in a.cells) {
    const t = a.cells[key]!.tuple
    for (let i = 0; i < n; ++i) {
      const v = t[dims[i]!]
      vals[i]![v as string] = v
    }
  }
  const generate = (base: string, tuple: Row, index: number): void => {
    const name = dims[index]!
    const v = vals[index++]!
    for (const k in v) {
      const key = base ? base + '|' + k : k
      tuple[name] = v[k]
      if (index < n) generate(key, tuple, index)
      else if (!a.cells[key]) cellFor(a, key, tuple)
    }
  }
  generate('', {}, 0)
}

/** vega `aggregate`: one output tuple per group, in order of first appearance. */
export function aggregateRows(rows: readonly Row[], p: AggregateParams, random?: () => number): Row[] {
  const a = newAggregator(p, newEnv(random))
  for (let i = 0; i < rows.length; i++) {
    addTuple(a, rows[i]!)
    if ((i & 255) === 255) meterTick('aggregate', 256)
  }
  if (p.cross && a.dims.length > 1) crossCells(a)
  return a.adds.map((c) => celltuple(a, c))
}

/** vega `joinaggregate`: each tuple gains the aggregate values of its group. */
export function joinAggregateRows(rows: readonly Row[], p: AggregateParams, random?: () => number): Row[] {
  const out = rows.map((r) => ({ ...r }))
  // vega's JoinAggregate declares no aggregate_params, drop or cross parameter:
  // they are not read, so exponential measures get no ratio (NaN), as upstream
  const a = newAggregator({ groupby: p.groupby, fields: p.fields, ops: p.ops, as: p.as, key: p.key }, newEnv(random))
  for (let i = 0; i < out.length; i++) {
    addTuple(a, out[i]!)
    if ((i & 255) === 255) meterTick('joinaggregate', 256)
  }
  for (const c of a.adds) celltuple(a, c)
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!
    const src = a.cells[a.cellkey(t)]!.tuple
    for (const k in src) t[k] = src[k]
  }
  return out
}

export interface PivotParams {
  groupby?: unknown
  field?: unknown
  value?: unknown
  op?: unknown
  limit?: unknown
  key?: unknown
}

/** vega `pivot`: an aggregate with one measure per distinct pivot key (sorted ascending). */
export function pivotRows(rows: readonly Row[], p: PivotParams, random?: () => number): Row[] {
  const key = fieldOf(p.field)
  const value = fieldOf(p.value)
  const op = (p.op === 'count' ? '__count__' : p.op) as string || 'sum'
  const fieldNames = [...(accessorFields(key) ?? []), ...(accessorFields(value) ?? [])]
  const seen = new Set<string>()
  const list: unknown[] = []
  for (const t of rows) {
    const k = key(t)
    const s = String(k)
    if (!seen.has(s)) { seen.add(s); list.push(k) }
  }
  sortData(list, ascending)
  const limit = (p.limit as number) || 0
  const keys = limit ? list.slice(0, limit) : list
  checkPivotWidth(keys.length)
  const fields = keys.map((k) => accessor((d: unknown) => (key(d) === k ? value(d) : NaN), fieldNames, k + ''))
  const ms = buildMeasures(keys.map(() => op), fields, keys.map((k) => k + ''), [], [])
  const a = makeAggregator(p.groupby, p.key, ms, newEnv(random))
  for (let i = 0; i < rows.length; i++) {
    addTuple(a, rows[i]!)
    meterTick('pivot', keys.length)
  }
  return a.adds.map((c) => celltuple(a, c))
}

function checkPivotWidth(n: number): void {
  meterTick('pivot', n)
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

interface Win {
  i0: number; i1: number; p0: number; p1: number; index: number
  data: Row[]
  compare: Compare
}

interface WindowOpImpl { init: () => void; next: (w: Win) => unknown }

const WINDOW_OPS: Record<string, (f: Accessor | undefined, param: number | null | undefined) => WindowOpImpl> = {
  row_number: () => ({ init: noop, next: (w) => w.index + 1 }),
  rank: () => {
    let rank = 1
    return {
      init: () => { rank = 1 },
      next: (w) => {
        const i = w.index
        const data = w.data
        return (i && w.compare(data[i - 1], data[i])) ? (rank = i + 1) : rank
      },
    }
  },
  dense_rank: () => {
    let drank = 1
    return {
      init: () => { drank = 1 },
      next: (w) => {
        const i = w.index
        const d = w.data
        return (i && w.compare(d[i - 1], d[i])) ? ++drank : drank
      },
    }
  },
  percent_rank: () => {
    const rank = WINDOW_OPS.rank!(undefined, undefined)
    return { init: rank.init, next: (w) => ((rank.next(w) as number) - 1) / (w.data.length - 1) }
  },
  cume_dist: () => {
    let cume = 0
    return {
      init: () => { cume = 0 },
      next: (w) => {
        const d = w.data
        const c = w.compare
        let i = w.index
        if (cume < i) {
          while (i + 1 < d.length && !c(d[i], d[i + 1])) ++i
          cume = i
        }
        return (1 + cume) / d.length
      },
    }
  },
  ntile: (_f, param) => {
    const num = +(param as number)
    if (!(num > 0)) error('ntile num must be greater than zero.')
    const cume = WINDOW_OPS.cume_dist!(undefined, undefined)
    return { init: cume.init, next: (w) => Math.ceil(num * (cume.next(w) as number)) }
  },
  lag: (f, param) => {
    const offset = +(param as number) || 1
    return {
      init: zeroInit,
      next: (w) => {
        const i = w.index - offset
        return i >= 0 ? f!(w.data[i]) : null
      },
    }
  },
  lead: (f, param) => {
    const offset = +(param as number) || 1
    return {
      init: zeroInit,
      next: (w) => {
        const i = w.index + offset
        const d = w.data
        return i < d.length ? f!(d[i]) : null
      },
    }
  },
  first_value: (f) => ({ init: zeroInit, next: (w) => f!(w.data[w.i0]) }),
  last_value: (f) => ({ init: zeroInit, next: (w) => f!(w.data[w.i1 - 1]) }),
  nth_value: (f, param) => {
    const nth = +(param as number)
    if (!(nth > 0)) error('nth_value nth must be greater than zero.')
    return {
      init: zeroInit,
      next: (w) => {
        const i = w.i0 + (nth - 1)
        return i < w.i1 ? f!(w.data[i]) : null
      },
    }
  },
  prev_value: (f) => {
    let prev: unknown = null
    return {
      init: () => { prev = null },
      next: (w) => {
        const v = f!(w.data[w.index])
        return v != null ? (prev = v) : prev
      },
    }
  },
  next_value: (f) => {
    let v: unknown = null
    let i = -1
    return {
      init: () => { v = null; i = -1 },
      next: (w) => {
        const d = w.data
        return w.index <= i ? v
          : (i = findNonNull(f!, d, w.index)) < 0
            ? (i = d.length, v = null)
            : (v = f!(d[i]))
      },
    }
  },
}
function zeroInit(): void {}

function findNonNull(f: Get, data: Row[], index: number): number {
  for (let n = data.length; index < n; ++index) {
    if (f(data[index]) != null) return index
  }
  return -1
}

export const VALID_WINDOW_OPS: readonly string[] = Object.keys(WINDOW_OPS)

export interface WindowParams {
  sort?: unknown
  groupby?: unknown
  ops?: unknown
  params?: unknown
  aggregate_params?: unknown
  fields?: unknown
  as?: unknown
  frame?: unknown
  ignorePeers?: unknown
}

interface WindowCell {
  num: number
  store: boolean
  data?: TupleStore
  agg: MState[] | null
  add(t: Row): void
  rem(t: Row): void
  set(t: Row): void
  init(): void
}

/** vega `WindowState`: the window ops plus the (incremental) aggregate cell. */
function windowState(p: WindowParams, env: AggEnv): { windows: Array<{ init: () => void; update: (w: Win, t: Row) => void }>; cell: WindowCell | null } {
  const ops = array(p.ops) as string[]
  const fields = array(p.fields).map((f) => (f == null ? null : fieldOf(f)))
  const params = array(p.params) as Array<number | null>
  const aggParams = array(p.aggregate_params) as Array<number | null>
  const as = array(p.as) as Array<string | null>
  const windows: Array<{ init: () => void; update: (w: Win, t: Row) => void }> = []
  const outputs: string[] = []

  const aggOps: string[] = []
  const aggFields: Array<Accessor | null> = []
  const aggAs: Array<string | null> = []
  const aggP: Array<number | null> = []
  ops.forEach((op, i) => {
    const f = fields[i]
    const mname = accessorName(f)
    const name = measureName(op, mname, as[i])
    if (Object.hasOwn(WINDOW_OPS, op)) {
      outputs.push(name)
      const fn = WINDOW_OPS[op]!(f ?? undefined, params[i])
      windows.push({ init: fn.init, update: (w, t) => { t[name] = fn.next(w) } })
    } else {
      aggOps.push(op)
      aggFields.push(f ?? null)
      aggAs.push(as[i] ?? null)
      aggP.push(aggParams[i] ?? null)
    }
  })
  // aggregate ops keep the position of their field/alias among the window ops
  let cell: WindowCell | null = null
  if (aggOps.length) {
    const ms = buildMeasures(aggOps, aggFields, aggAs, aggP, outputs)
    cell = makeWindowCell(ms, env)
    if (!ms.counts.length && !ms.measures.length) cell = null
  }
  return { windows, cell }
}

function makeWindowCell(ms: MeasureSet, env: AggEnv): WindowCell {
  const measures = ms.measures
  const cell: WindowCell = {
    num: 0, agg: null, store: false,
    add: noop, rem: noop, set: noop, init: noop,
  }
  const countOnly = ms.countOnly
  const counts = ms.counts
  let n = 0
  if (!countOnly) {
    n = measures.length
    const a = (cell.agg = new Array<MState>(n))
    for (let i = 0; i < n; ++i) a[i] = measures[i]!(cell)
  }
  if (cell.store) cell.data = new TupleStore(env)
  const store = cell.data
  const a = cell.agg
  cell.add = (t) => {
    cell.num += 1
    if (countOnly) return
    if (store) store.add(t)
    for (let i = 0; i < n; ++i) a![i]!.add(a![i]!.get(t), t)
  }
  cell.rem = (t) => {
    cell.num -= 1
    if (countOnly) return
    if (store) store.rem(t)
    for (let i = 0; i < n; ++i) a![i]!.rem(a![i]!.get(t), t)
  }
  cell.set = (t) => {
    if (store) store.values()
    for (let i = 0; i < counts.length; i++) t[counts[i]!] = cell.num
    if (!countOnly) for (let i = 0; i < a!.length; i++) a![i]!.set(t)
  }
  cell.init = () => {
    cell.num = 0
    if (store) store.reset()
    for (let i = 0; i < n; ++i) a![i]!.init()
  }
  return cell
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** d3-array `bisector` over a two-argument comparator. */
function bisector(compare: Compare): { left: (a: Row[], x: Row) => number; right: (a: Row[], x: Row) => number } {
  return {
    left(a, x) {
      let lo = 0
      let hi = a.length
      if (lo < hi) {
        do {
          const mid = (lo + hi) >>> 1
          if (compare(a[mid], x) < 0) lo = mid + 1
          else hi = mid
        } while (lo < hi)
      }
      return lo
    },
    right(a, x) {
      let lo = 0
      let hi = a.length
      if (lo < hi) {
        do {
          const mid = (lo + hi) >>> 1
          if (compare(a[mid], x) <= 0) lo = mid + 1
          else hi = mid
        } while (lo < hi)
      }
      return lo
    },
  }
}

/** vega `window`: running/sliding aggregates and rank ops, written onto copies in source order. */
export function windowRows(rows: readonly Row[], p: WindowParams, random?: () => number): Row[] {
  const out = rows.map((r) => ({ ...r }))
  const env = newEnv(random)
  const sort = compareOf(p.sort) as Compare | null
  const cmp = sort
  const key = groupkey(fieldsOf(p.groupby))
  const state = windowState(p, env)

  // partition (in order of first appearance), each partition stable-sorted
  const groups = new Map<string, Row[]>()
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!
    const k = String(key(t))
    let g = groups.get(k)
    if (!g) groups.set(k, (g = []))
    g.push(t)
  }
  const frame = (Array.isArray(p.frame) ? p.frame : [null, 0]) as [number | null, number | null]
  const range = !!sort && !p.ignorePeers
  const b = range ? bisector(sort!) : null
  for (const g of groups.values()) {
    const data = cmp ? stableSortBy(g, cmp) : g
    const n = data.length
    const w: Win = { i0: 0, i1: 0, p0: 0, p1: 0, index: 0, data, compare: sort || (constant(-1) as Compare) }
    for (const wn of state.windows) wn.init()
    if (state.cell) state.cell.init()
    for (let i = 0; i < n; ++i) {
      // window bounds (offsets are relative to the current row; null = unbounded)
      w.p0 = w.i0
      w.p1 = w.i1
      const start = frame[0] == null ? 0 : i + frame[0]
      const endExclusive = frame[1] == null ? n : i + frame[1] + 1
      w.i0 = clamp(start, 0, n)
      w.i1 = clamp(endExclusive, 0, n)
      w.index = i
      if (b) {
        const r0 = w.i0
        const r1 = w.i1 - 1
        const c = w.compare
        const d = w.data
        const nn = d.length - 1
        if (r0 > 0 && r0 <= nn && !c(d[r0], d[r0 - 1])) w.i0 = b.left(d, d[r0]!)
        if (r1 < nn && r1 >= 0 && !c(d[r1], d[r1 + 1])) w.i1 = b.right(d, d[r1]!)
      }
      // update
      const t = data[i]!
      const cell = state.cell
      if (cell) {
        for (let j = w.p0; j < w.i0; ++j) cell.rem(data[j]!)
        for (let j = w.p1; j < w.i1; ++j) cell.add(data[j]!)
        cell.set(t)
      }
      for (let j = 0; j < state.windows.length; ++j) state.windows[j]!.update(w, t)
      meterTick('window', 1)
    }
  }
  return out
}

// re-exported so callers do not need util for the same helper
export { vegaExtent }
