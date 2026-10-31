/**
 * Grouping and statistics for the aggregating transforms: `aggregate`, `joinaggregate` and `pivot` live here, `window`
 * (`transform-window.ts`) reuses the running measures, and so do the field, ordering and quantile helpers the other transforms share.
 *
 * What the measures promise, and what the output depends on:
 *  - a measure sees the RAW field value, not a coerced one: `null`, `undefined` and `''` are missing, `NaN` is neither missing nor
 *    valid (it is skipped), everything else is valid and meets the arithmetic of the op as JavaScript defines it (`+v` for a sum,
 *    `v - mean` for a mean, `<` for a minimum). Numeric strings and Dates therefore aggregate the way they do in Vega;
 *  - a group without a valid value reads `undefined` for most ops, not `NaN`;
 *  - groups are keyed by the string of their group-by values, and a group's own values come from the first row that opened it;
 *  - the order in which a field's statistics are updated, and the order the measures write their results, are part of the output
 *    (see {@link Accumulator.take} and {@link OP_TABLE});
 *  - the bootstrap interval (`ci0`/`ci1`) draws one number per resampled index from the injected random source, or from a seeded
 *    stream of the engine's own (see {@link SEED}) when the host injects none, so an incremental evaluation equals a fresh one.
 *
 * Deviations from Vega, both on purpose: the input rows are never written (the transforms that write onto their rows in Vega write
 * onto copies, or onto rows the pipeline owns), and group tables hold no inherited names, so a group called `constructor` is a group.
 */
import { accessor, accessorFields, accessorName, array, ascending, error, field, sortData, type Accessor } from './util.js'
import { meterTick } from './limits.js'
import { ascending as numericAscending, quantileSorted } from './arr.js'

export type Row = Record<string, unknown>
type Get = (d: unknown) => unknown
export type Compare = (a: unknown, b: unknown) => number

// ---------------------------------------------------------------------------
// random stream
// ---------------------------------------------------------------------------

/** Seed of the engine's own pseudo-random stream, used when the host injects no source. */
export const SEED = 42

/** The linear congruential generator Vega ships (glibc's constants); the arithmetic is kept as is, rounding of the product included. */
export function lcg(seed: number): () => number {
  return () => (seed = (1103515245 * seed + 12345) % 2147483647) / 2147483647
}

// ---------------------------------------------------------------------------
// field access
// ---------------------------------------------------------------------------

const accessors = new Map<string, Accessor>()
const ACCESSOR_CACHE_LIMIT = 4096

/** The accessor of a field spec (`a.b`, `a[0]`, `a\.b`), parsed once per distinct string. */
export function fieldOf(spec: unknown): Accessor {
  if (typeof spec !== 'string') return field(spec)
  let found = accessors.get(spec)
  if (found === undefined) {
    if (accessors.size >= ACCESSOR_CACHE_LIMIT) accessors.clear()
    found = field(spec)
    accessors.set(spec, found)
  }
  return found
}

export function fieldsOf(specs: unknown): Accessor[] {
  return array(specs).map(fieldOf)
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * Vega's `ascending`, with a shortcut for two values of the same primitive kind (non-NaN numbers, strings) which it orders the
 * same way: nearly every comparison of a sort is one of those.
 */
function compareValues(a: unknown, b: unknown): number {
  const kind = typeof a
  if (kind === typeof b && (kind === 'string' || (kind === 'number' && a === a && b === b))) {
    return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
  }
  return ascending(a, b)
}

interface SortKeys {
  get: Accessor[]
  /** 1 for ascending, -1 for descending, per key. */
  sign: number[]
}

/** The keys of a `{field, order}` sort spec; `null` when it names no field. A key's order is looked up at the key's own position. */
function sortKeys(spec: unknown): SortKeys | null {
  if (spec == null) return null
  const { field: names, order } = spec as { field?: unknown; order?: unknown }
  const orders = array(order)
  const keys: SortKeys = { get: [], sign: [] }
  array(names).forEach((name, i) => {
    if (name == null) return
    keys.get.push(typeof name === 'function' ? (name as Accessor) : fieldOf(name))
    keys.sign.push(orders[i] === 'descending' ? -1 : 1)
  })
  return keys.get.length ? keys : null
}

/**
 * A stable sorted copy of `items` by a `{field, order}` spec, or `null` when the spec names no field. Each sort key is read once
 * per item, not twice per comparison, and the positions are what gets sorted: ties keep input order whatever the comparison does
 * with values (NaN, mixed types) that no ordering is consistent over.
 */
export function sortBySpec<T>(items: readonly T[], spec: unknown): T[] | null {
  const keys = sortKeys(spec)
  if (keys === null) return null
  const n = items.length
  const m = keys.get.length
  const columns = keys.get.map((get) => {
    const column = new Array<unknown>(n)
    for (let i = 0; i < n; i++) column[i] = get(items[i])
    return column
  })
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  if (m === 1) {
    const column = columns[0]!
    const sign = keys.sign[0]!
    sortData(order, (i, j) => compareValues(column[i], column[j]) * sign || i - j)
  } else {
    sortData(order, (i, j) => {
      for (let k = 0; k < m; k++) {
        const c = compareValues(columns[k]![i], columns[k]![j])
        if (c !== 0) return c * keys.sign[k]! || i - j
      }
      return i - j
    })
  }
  return order.map((i) => items[i]!)
}

/** A comparator over rows for a `{field, order}` spec, carrying the fields it reads; `null` when the spec names no field. */
export function compareOf(spec: unknown): Accessor<number> | null {
  const keys = sortKeys(spec)
  if (keys === null) return null
  const { get, sign } = keys
  const read = new Set<string>()
  for (const g of get) for (const name of accessorFields(g) ?? []) read.add(name)
  let compare: Compare
  if (get.length === 1) {
    const only = get[0]!
    const direction = sign[0]!
    compare = (a, b) => compareValues(only(a), only(b)) * direction
  } else {
    const n = get.length
    compare = (a, b) => {
      for (let k = 0; k < n; k++) {
        const c = compareValues(get[k]!(a), get[k]!(b))
        if (c !== 0) return c * sign[k]!
      }
      return 0
    }
  }
  return accessor(compare as (d: unknown) => number, [...read])
}

/** `items` stably sorted by `compare` (a copy; unsorted without one): ties break by position, and it is the positions that are sorted. */
export function stableSortBy<T>(items: readonly T[], compare: Compare | null): T[] {
  if (!compare) return items.slice()
  const n = items.length
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  sortData(order, (i, j) => compare(items[i], items[j]) || i - j)
  const sorted = new Array<T>(n)
  for (let i = 0; i < n; i++) sorted[i] = items[order[i]!]!
  return sorted
}

// ---------------------------------------------------------------------------
// quantiles and the bootstrap interval
// ---------------------------------------------------------------------------

/** The values that count as numbers: not missing, not empty, and not NaN once coerced. */
function numbersOf(values: ArrayLike<unknown>, get?: Get): number[] {
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const raw = get ? get(values[i]) : values[i]
    if (raw == null || raw === '') continue
    const x = +(raw as number)
    if (x >= x) out.push(x)
  }
  return out
}

/** Quantiles `probs` of the numbers in `values` (read through `get`); `undefined` where there is no number. */
export function quantiles(values: ArrayLike<unknown>, probs: readonly number[], get?: Get): Array<number | undefined> {
  const sorted = Float64Array.from(numbersOf(values, get)).sort(numericAscending)
  return probs.map((p) => quantileSorted(sorted, p))
}

export function quartiles(values: ArrayLike<unknown>, get?: Get): Array<number | undefined> {
  return quantiles(values, [0.25, 0.5, 0.75], get)
}

/**
 * The percentile interval of the mean by bootstrap resampling: `samples` resamples of the valid numbers, each as large as the data
 * and drawn with replacement, give `samples` means; the interval runs from their `alpha / 2` to their `1 - alpha / 2` quantile.
 * No rows, no interval. Fixed by the output: a resample takes its `n` indices as `~~(random() * n)`, one draw per index and resample
 * after resample, and a mean is the plain sum in draw order over `n`.
 */
export function bootstrapCI(
  rows: ArrayLike<unknown>, samples: number, alpha: number, get: Get | undefined, random: () => number,
): [number | undefined, number | undefined] {
  if (!rows.length) return [undefined, undefined]
  const pool = Float64Array.from(numbersOf(rows, get))
  const n = pool.length
  const means = new Float64Array(samples)
  for (let s = 0; s < samples; ++s) {
    let total = 0
    for (let i = 0; i < n; ++i) total += pool[~~(random() * n)]!
    means[s] = total / n
    meterTick('bootstrap', n)
  }
  // the means of data with no valid number are NaN: they are left out, the rest order numerically
  const ordered = means.filter((mean) => mean === mean).sort()
  return [quantileSorted(ordered, alpha / 2), quantileSorted(ordered, 1 - alpha / 2)]
}

// ---------------------------------------------------------------------------
// the rows a group holds, for the measures that look at them
// ---------------------------------------------------------------------------

/** Positions of the lowest and highest usable value (not null/undefined, not NaN) of `get`, first occurrence; `-1`s when none. */
function extremeIndexes(items: ArrayLike<Row>, get: Get): [number, number] {
  const n = items.length
  let lowAt = 0
  while (lowAt < n) {
    const x = get(items[lowAt]) as number | null | undefined
    if (x != null && x >= x) break
    lowAt++
  }
  if (lowAt === n) return [-1, -1]
  let highAt = lowAt
  let low = get(items[lowAt]) as number
  let high = low
  for (let i = lowAt + 1; i < n; i++) {
    const x = get(items[i]) as number | null | undefined
    if (x == null) continue
    if (low > x) { low = x; lowAt = i }
    if (high < x) { high = x; highAt = i }
  }
  return [lowAt, highAt]
}

/**
 * The rows of one group, kept for the measures that cannot be updated one value at a time (quantiles, distinct count, the
 * bootstrap interval, the row of an extreme once it was removed, `values`).
 *
 * A window takes rows out again. Removals are held back and applied the next time the rows are read, sized as Vega sizes them: the
 * result has room for the rows added minus the removals asked for, so a window that removes more than it added fails with a
 * RangeError, and a removal that matches no row leaves a hole.
 *
 * What a statistic caches is valid for ONE reader at a time (the field accessor it was computed for): the caches share a single
 * owner mark, every read of the rows clears the mark, and the bootstrap interval survives {@link RowBag.clear}. The numbers a frame
 * gives when several fields' measures read it depend on that, and Vega's depend on it too.
 */
export class RowBag {
  private held: Row[] = []
  private dropped = new Set<Row>()
  private droppedCount = 0
  private owner: Get | null = null
  private extremes: [Row | undefined, Row | undefined] | null = null
  private quartile: Array<number | undefined> | null = null
  private interval: [number | undefined, number | undefined] | null = null

  constructor(private readonly random: () => number) {}

  /** Start a new group: nothing held, the extremes and quartiles forgotten (the interval is not, see the class comment). */
  clear(): void {
    this.held = []
    this.dropped = new Set()
    this.droppedCount = 0
    this.owner = null
    this.extremes = null
    this.quartile = null
  }

  push(row: Row): void {
    this.held.push(row)
  }

  drop(row: Row): void {
    this.dropped.add(row)
    this.droppedCount++
  }

  /** The rows held, with the pending removals applied. */
  rows(): Row[] {
    this.owner = null
    if (this.droppedCount === 0) return this.held
    const held = this.held
    meterTick('aggregate', held.length)
    const kept = new Array<Row>(held.length - this.droppedCount)
    let at = 0
    for (let i = 0; i < held.length; ++i) {
      const row = held[i]!
      if (this.dropped.delete(row)) continue
      kept[at++] = row
    }
    this.dropped = new Set()
    this.droppedCount = 0
    return (this.held = kept)
  }

  distinct(get: Get): number {
    const rows = this.rows()
    meterTick('aggregate', rows.length)
    const seen = new Set<string>()
    for (let i = rows.length; --i >= 0;) seen.add(get(rows[i]) + '')
    return seen.size
  }

  /** The rows holding the lowest and highest value of `get`. */
  private extremesFor(get: Get): [Row | undefined, Row | undefined] {
    if (this.owner !== get || !this.extremes) {
      const rows = this.rows()
      meterTick('aggregate', rows.length)
      const [lo, hi] = extremeIndexes(rows, get)
      this.extremes = [rows[lo], rows[hi]]
      this.owner = get
    }
    return this.extremes
  }

  lowestRow(get: Get): Row { return this.extremesFor(get)[0] || {} }
  highestRow(get: Get): Row { return this.extremesFor(get)[1] || {} }

  lowest(get: Get): unknown {
    const row = this.extremesFor(get)[0]
    return row != null ? get(row) : undefined
  }

  highest(get: Get): unknown {
    const row = this.extremesFor(get)[1]
    return row != null ? get(row) : undefined
  }

  quartileAt(get: Get, which: 0 | 1 | 2): number | undefined {
    if (this.owner !== get || !this.quartile) {
      const rows = this.rows()
      // a sort per read: O(n log n), which a window re-pays at every row
      meterTick('aggregate', rows.length * 8)
      this.quartile = quartiles(rows, get)
      this.owner = get
    }
    return this.quartile[which]
  }

  intervalEnd(get: Get, end: 0 | 1): number | undefined {
    if (this.owner !== get || !this.interval) {
      this.interval = bootstrapCI(this.rows(), 1000, 0.05, get, this.random)
      this.owner = get
    }
    return this.interval[end]
  }
}

// ---------------------------------------------------------------------------
// running statistics of one field
// ---------------------------------------------------------------------------

// The statistics a field maintains, as a set of bits chosen by the ops asked for.
const SUM = 1
const PRODUCT = 2
const MEAN = 4
const DEVIATION = 8
const EWMA = 16
const LOW = 32
const HIGH = 64
const LOW_ROW = 128
const HIGH_ROW = 256
const ROWS = 512
const SUMS = SUM | PRODUCT | EWMA
const MOMENTS = MEAN | DEVIATION
const EXTREMES = LOW | HIGH | LOW_ROW | HIGH_ROW

type ReadFn = (acc: Accumulator, rows: RowBag | null, get: Get) => unknown

/** What is needed to run the measures of one field. */
export interface FieldPlan {
  get: Get
  stats: number
  /** The smoothing factor of the exponential moving average, read from the last `exponential` op listed for the field. */
  rate: number
  /** The measures to write, in the order their keys land on the output row. */
  readers: Array<{ out: string; read: ReadFn }>
}

/**
 * The running statistics of one field in one group. `take` and `release` add and remove a value; they update the statistics in the
 * one order that gives the right numbers: the mean before the deviation that uses its change, the rows of the extremes before the
 * extremes themselves (those compare against the extremes of the values seen so far).
 *
 * Values arrive raw, so what a statistic does with a string or a Date is what JavaScript's operators do with it.
 */
export class Accumulator {
  valid = 0
  missing = 0
  private sum = 0
  private product = 1
  private mean = 0
  private meanShift = 0
  private deviation = 0
  private ewma = 0
  private low: unknown = undefined
  private high: unknown = undefined
  private lowRow: Row | undefined = undefined
  private highRow: Row | undefined = undefined

  constructor(readonly plan: FieldPlan) {}

  take(value: unknown, row: Row): void {
    if (value == null || value === '') { this.missing++; return }
    if (value !== value) return
    this.valid++
    const stats = this.plan.stats
    if (stats & SUMS) this.takeSums(value as number, stats)
    if (stats & MOMENTS) this.takeMoments(value as number, stats)
    if (stats & EXTREMES) this.takeExtremes(value as number, row, stats)
  }

  release(value: unknown): void {
    if (value == null || value === '') { this.missing--; return }
    if (value !== value) return
    this.valid--
    const stats = this.plan.stats
    if (stats & SUMS) this.releaseSums(value as number, stats)
    if (stats & MOMENTS) this.releaseMoments(value as number, stats)
    if (stats & EXTREMES) this.releaseExtremes(value as number, stats)
  }

  // (the three groups of statistics are independent of each other; inside a group the order matters)
  private takeSums(x: number, stats: number): void {
    if (stats & SUM) this.sum += +x
    if (stats & PRODUCT) this.product *= x
    if (stats & EWMA) this.ewma = this.plan.rate * this.ewma + x
  }

  private takeMoments(x: number, stats: number): void {
    if (stats & MEAN) {
      this.meanShift = x - this.mean
      this.mean += this.meanShift / this.valid
    }
    if (stats & DEVIATION) this.deviation += this.meanShift * (x - this.mean)
  }

  private takeExtremes(x: number, row: Row, stats: number): void {
    if (stats & LOW_ROW && x < (this.low as number)) this.lowRow = row
    if (stats & HIGH_ROW && x > (this.high as number)) this.highRow = row
    if (stats & LOW && (x < (this.low as number) || this.low === undefined)) this.low = x
    if (stats & HIGH && (x > (this.high as number) || this.high === undefined)) this.high = x
  }

  private releaseSums(x: number, stats: number): void {
    if (stats & SUM) this.sum -= x
    if (stats & PRODUCT) this.product /= x
    if (stats & EWMA) this.ewma = (this.ewma - x / this.plan.rate ** (this.valid - 1)) / this.plan.rate
  }

  private releaseMoments(x: number, stats: number): void {
    if (stats & MEAN) {
      this.meanShift = x - this.mean
      this.mean -= this.valid ? this.meanShift / this.valid : this.mean
    }
    if (stats & DEVIATION) this.deviation -= this.meanShift * (x - this.mean)
  }

  private releaseExtremes(x: number, stats: number): void {
    if (stats & LOW_ROW && x <= (this.low as number)) this.lowRow = undefined
    if (stats & HIGH_ROW && x >= (this.high as number)) this.highRow = undefined
    // a removed extreme leaves NaN as a mark: the next read looks the extreme up among the rows left
    if (stats & LOW && x <= (this.low as number)) this.low = NaN
    if (stats & HIGH && x >= (this.high as number)) this.high = NaN
  }

  readSum(): unknown { return this.valid ? this.sum : undefined }
  readProduct(): unknown { return this.valid ? this.product : undefined }
  readMean(): unknown { return this.valid ? this.mean : undefined }
  readVariance(): unknown { return this.valid > 1 ? Math.max(0, this.deviation) / (this.valid - 1) : undefined }
  readVarianceP(): unknown { return this.valid ? Math.max(0, this.deviation) / this.valid : undefined }
  readStdev(): unknown { return this.valid > 1 ? Math.sqrt(Math.max(0, this.deviation) / (this.valid - 1)) : undefined }
  readStdevP(): unknown { return this.valid ? Math.sqrt(Math.max(0, this.deviation) / this.valid) : undefined }
  readStderr(): unknown { return this.valid > 1 ? Math.sqrt(Math.max(0, this.deviation) / (this.valid * (this.valid - 1))) : undefined }
  readEwma(): unknown {
    const rate = this.plan.rate
    return this.valid ? (this.ewma * (1 - rate) / (1 - rate ** this.valid)) : undefined
  }
  readEwmaB(): unknown { return this.valid ? (this.ewma * (1 - this.plan.rate)) : undefined }
  readLow(rows: RowBag, get: Get): unknown { return (this.low = Number.isNaN(this.low) ? rows.lowest(get) : this.low) }
  readHigh(rows: RowBag, get: Get): unknown { return (this.high = Number.isNaN(this.high) ? rows.highest(get) : this.high) }
  readLowRow(rows: RowBag, get: Get): unknown { return this.lowRow || rows.lowestRow(get) }
  readHighRow(rows: RowBag, get: Get): unknown { return this.highRow || rows.highestRow(get) }
}

// ---------------------------------------------------------------------------
// the ops
// ---------------------------------------------------------------------------

interface OpSpec {
  /** The statistics the op needs maintained, those of the ops it is built on included. */
  stats: number
  /**
   * Where the op's result goes among the results of its field: the lowest tier writes first, ops of one tier in the order listed.
   * (Result key order is part of the output. A field's statistics themselves update in the fixed order of {@link Accumulator.take}.)
   */
  tier: number
  read: ReadFn
}

const OP_TABLE: Record<string, OpSpec> = {
  values: { stats: ROWS, tier: -1, read: (_a, rows) => rows!.rows() },
  __count__: { stats: 0, tier: 0, read: (a) => a.missing + a.valid },
  missing: { stats: 0, tier: 0, read: (a) => a.missing },
  valid: { stats: 0, tier: 0, read: (a) => a.valid },
  sum: { stats: SUM, tier: 0, read: (a) => a.readSum() },
  product: { stats: PRODUCT, tier: 0, read: (a) => a.readProduct() },
  mean: { stats: MEAN, tier: 0, read: (a) => a.readMean() },
  exponential: { stats: EWMA, tier: 0, read: (a) => a.readEwma() },
  average: { stats: MEAN, tier: 1, read: (a) => a.readMean() },
  variance: { stats: MEAN | DEVIATION, tier: 1, read: (a) => a.readVariance() },
  exponentialb: { stats: EWMA, tier: 1, read: (a) => a.readEwmaB() },
  variancep: { stats: MEAN | DEVIATION, tier: 2, read: (a) => a.readVarianceP() },
  stdev: { stats: MEAN | DEVIATION, tier: 2, read: (a) => a.readStdev() },
  stdevp: { stats: MEAN | DEVIATION, tier: 2, read: (a) => a.readStdevP() },
  stderr: { stats: MEAN | DEVIATION, tier: 2, read: (a) => a.readStderr() },
  distinct: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.distinct(get) },
  ci0: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.intervalEnd(get, 0) },
  ci1: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.intervalEnd(get, 1) },
  median: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.quartileAt(get, 1) },
  q1: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.quartileAt(get, 0) },
  q3: { stats: ROWS, tier: 3, read: (_a, rows, get) => rows!.quartileAt(get, 2) },
  argmin: { stats: LOW_ROW | LOW | ROWS, tier: 3, read: (a, rows, get) => a.readLowRow(rows!, get) },
  argmax: { stats: HIGH_ROW | HIGH | ROWS, tier: 3, read: (a, rows, get) => a.readHighRow(rows!, get) },
  min: { stats: LOW | ROWS, tier: 4, read: (a, rows, get) => a.readLow(rows!, get) },
  max: { stats: HIGH | ROWS, tier: 4, read: (a, rows, get) => a.readHigh(rows!, get) },
}

/** The name a measure writes to: the explicit alias, or `op` / `op_field`. */
export function outputName(op: string, fieldName: string | null | undefined, alias?: string | null): string {
  return alias || (op + (!fieldName ? '' : '_' + fieldName))
}

/** One measure of the transform's list. */
interface Measure {
  op: string
  param: unknown
  out: string
}

function planField(get: Get, measures: Measure[]): FieldPlan {
  let stats = 0
  let rate = NaN
  for (const m of measures) {
    stats |= OP_TABLE[m.op]!.stats
    // one ratio per field: the last `exponential` listed gives it (without a parameter there is no ratio at all)
    if (m.op === 'exponential') rate = m.param ? +(m.param as number) : NaN
  }
  const readers = measures
    .map((m) => ({ out: m.out, tier: OP_TABLE[m.op]!.tier, read: OP_TABLE[m.op]!.read }))
    .sort((a, b) => a.tier - b.tier)
  return { get, stats, rate, readers }
}

/** The measures of a transform, planned: the plain counts, and one plan per measured field in order of first mention. */
export interface MeasureSet {
  counts: string[]
  fields: FieldPlan[]
  needsRows: boolean
}

/**
 * Plan the measures `ops[i]` over `fields[i]` named `as[i]`. A count needs no field; any other op without one, or one the table does
 * not know, is refused (the first problem found, in list order).
 */
export function planMeasures(
  ops: readonly string[],
  fields: ReadonlyArray<Accessor | null | undefined>,
  as: ReadonlyArray<string | null | undefined>,
  params: ReadonlyArray<unknown>,
): MeasureSet {
  const counts: string[] = []
  const byField = new Map<string | null, { get: Accessor | null | undefined; measures: Measure[] }>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    const get = fields[i]
    if (get == null && op !== 'count') error('Null aggregate field specified.')
    const fieldName = accessorName(get)
    const out = outputName(op, fieldName, as[i])
    if (op === 'count') { counts.push(out); continue }
    if (!Object.hasOwn(OP_TABLE, op)) error(`[aster] unsupported aggregate op "${op}" (vega: AggregateOps[op] is not a function)`)
    let entry = byField.get(fieldName)
    if (entry === undefined) byField.set(fieldName, (entry = { get, measures: [] }))
    entry.measures.push({ op, param: params[i] || null, out })
  }
  const plans = [...byField.values()].map((e) => planField(e.get as Get, e.measures))
  return { counts, fields: plans, needsRows: plans.some((p) => p.stats & ROWS) }
}

// ---------------------------------------------------------------------------
// a group of rows folded into its measures
// ---------------------------------------------------------------------------

/**
 * The running measures of one group: rows go in (and, for a window, out), and the results are written onto a row. Aggregate,
 * joinaggregate, pivot and window all fold rows into one of these.
 */
export class MeasureGroup {
  /** Rows currently in the group. */
  size = 0
  private accs: Accumulator[]
  private readonly rows: RowBag | null

  constructor(private readonly set: MeasureSet, random: () => number) {
    this.accs = MeasureGroup.accumulatorsOf(set)
    this.rows = set.needsRows ? new RowBag(random) : null
  }

  private static accumulatorsOf(set: MeasureSet): Accumulator[] {
    const accs = new Array<Accumulator>(set.fields.length)
    for (let i = 0; i < accs.length; i++) accs[i] = new Accumulator(set.fields[i]!)
    return accs
  }

  /** Back to an empty group, as a window does between partitions. */
  reset(): void {
    this.size = 0
    this.rows?.clear()
    this.accs = MeasureGroup.accumulatorsOf(this.set)
  }

  add(row: Row): void {
    this.size++
    this.rows?.push(row)
    const accs = this.accs
    for (let i = 0; i < accs.length; i++) accs[i]!.take(accs[i]!.plan.get(row), row)
  }

  /**
   * Add a row that only one field of the group can see a value in (a pivot column): the other fields would read NaN and skip it.
   * `at` is that field's position, `-1` for none.
   */
  addAt(row: Row, at: number, value: unknown): void {
    this.size++
    this.rows?.push(row)
    if (at >= 0) this.accs[at]!.take(value, row)
  }

  remove(row: Row): void {
    this.size--
    this.rows?.drop(row)
    const accs = this.accs
    for (let i = 0; i < accs.length; i++) accs[i]!.release(accs[i]!.plan.get(row))
  }

  /** Write the counts, then each field's measures, onto `target`. */
  writeTo(target: Row): void {
    this.rows?.rows()
    for (const name of this.set.counts) target[name] = this.size
    for (const acc of this.accs) {
      const get = acc.plan.get
      for (const reader of acc.plan.readers) target[reader.out] = reader.read(acc, this.rows, get)
    }
  }
}

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

/** The string a row's group is known by: `''` with no group-by, the value's string for one field, the strings joined by `|` for several. */
function groupKeyOf(dims: readonly Accessor[]): (row: Row) => string {
  if (dims.length === 0) return () => ''
  if (dims.length === 1) {
    const only = dims[0]!
    return (row) => String(only(row))
  }
  return (row) => {
    let key = String(dims[0]!(row))
    for (let i = 1; i < dims.length; i++) key += '|' + dims[i]!(row)
    return key
  }
}

const keyFns = new WeakMap<object, (row: Row) => string>()

/** The partition key of a `groupby` as a string: how the incremental evaluation partitions, identically to {@link aggregateRows}. */
export function groupKeyFn(groupby: unknown): (row: Row) => string {
  if (groupby == null || (Array.isArray(groupby) && groupby.length === 0)) return () => ''
  const cacheable = typeof groupby === 'object'
  let fn = cacheable ? keyFns.get(groupby) : undefined
  if (!fn) {
    fn = groupKeyOf(fieldsOf(groupby))
    if (cacheable) keyFns.set(groupby, fn)
  }
  return fn
}

/** The partition of `rows` by a `groupby`, in order of first appearance of each group. */
export function partitionRows(rows: readonly Row[], groupby: unknown): Row[][] {
  const keyOf = groupKeyOf(fieldsOf(groupby))
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()]
}

interface Cell {
  group: MeasureGroup
  /** The group's output row: its group-by values (from the row that opened it), then the measures. */
  tuple: Row
}

interface Grouping {
  /** Prototype-less, and an object on purpose: `cross` walks it in property order. */
  cells: Record<string, Cell>
  /** The cells in order of first appearance. */
  order: Cell[]
  dims: Accessor[]
  dimNames: string[]
  keyOf: (row: Row) => string
  set: MeasureSet
  random: () => number
}

function newGrouping(groupby: unknown, key: unknown, set: MeasureSet, random: () => number): Grouping {
  const dims = fieldsOf(groupby)
  const keyField = key ? fieldOf(key) : null
  return {
    cells: Object.create(null) as Record<string, Cell>,
    order: [],
    dims,
    dimNames: dims.map((d) => accessorName(d) as string),
    keyOf: keyField ? (row) => String(keyField(row)) : groupKeyOf(dims),
    set,
    random,
  }
}

function cellAt(g: Grouping, key: string, firstRow: Row): Cell {
  let cell = g.cells[key]
  if (!cell) {
    const tuple: Row = {}
    for (let i = 0; i < g.dims.length; ++i) tuple[g.dimNames[i]!] = g.dims[i]!(firstRow)
    cell = g.cells[key] = { group: new MeasureGroup(g.set, g.random), tuple }
    g.order.push(cell)
  }
  return cell
}

function finishCell(cell: Cell): Row {
  cell.group.writeTo(cell.tuple)
  return cell.tuple
}

/**
 * The cells of the full cross product of the group-by values, those with no row included. The values of each dimension are visited
 * in the order of an object keyed by their strings (whole numbers first, ascending), which is the order the result comes in.
 */
function crossFill(g: Grouping): void {
  const dims = g.dimNames
  const domains = dims.map(() => Object.create(null) as Record<string, unknown>)
  for (const key in g.cells) {
    const tuple = g.cells[key]!.tuple
    dims.forEach((name, i) => { domains[i]![tuple[name] as string] = tuple[name] })
  }
  const visit = (prefix: string, tuple: Row, depth: number): void => {
    const domain = domains[depth]!
    const last = depth === dims.length - 1
    for (const value in domain) {
      const key = prefix ? prefix + '|' + value : value
      tuple[dims[depth]!] = domain[value]
      if (!last) visit(key, tuple, depth + 1)
      else if (!g.cells[key]) cellAt(g, key, tuple)
    }
  }
  visit('', {}, 0)
}

// ---------------------------------------------------------------------------
// aggregate, joinaggregate, pivot
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

function groupingFor(p: AggregateParams, random: () => number): Grouping {
  const fields = (p.fields == null ? [null] : array(p.fields)).map((f) => (f == null ? null : fieldOf(f)))
  const ops = (p.ops == null ? ['count'] : array(p.ops)) as string[]
  const params = p.aggregate_params == null ? [null] : array(p.aggregate_params)
  if (fields.length !== ops.length) error('Unmatched number of fields and aggregate ops.')
  const set = planMeasures(ops, fields, array(p.as) as Array<string | null>, params)
  return newGrouping(p.groupby, p.key, set, random)
}

/** vega `aggregate`: one output row per group, in order of first appearance. */
export function aggregateRows(rows: readonly Row[], p: AggregateParams, random: () => number = lcg(SEED)): Row[] {
  const g = groupingFor(p, random)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    cellAt(g, g.keyOf(row), row).group.add(row)
    if ((i & 255) === 255) meterTick('aggregate', 256)
  }
  if (p.cross && g.dims.length > 1) crossFill(g)
  return g.order.map(finishCell)
}

/**
 * vega `joinaggregate`: every row gains the measures of its group. The rows written are the copies the aggregation also holds (what
 * `values`, `argmin` and `argmax` return), or the rows themselves when the pipeline owns them.
 */
export function joinAggregateRows(rows: readonly Row[], p: AggregateParams, random: () => number = lcg(SEED), owned = false): Row[] {
  const out = owned ? rows.slice() : rows.map((r) => ({ ...r }))
  // Vega's JoinAggregate declares no `aggregate_params`, `drop` or `cross`: they are not read (an exponential gets no ratio)
  const g = groupingFor({ groupby: p.groupby, fields: p.fields, ops: p.ops, as: p.as, key: p.key }, random)
  for (let i = 0; i < out.length; i++) {
    const row = out[i]!
    cellAt(g, g.keyOf(row), row).group.add(row)
    if ((i & 255) === 255) meterTick('joinaggregate', 256)
  }
  for (const cell of g.order) finishCell(cell)
  for (const row of out) {
    const cell = g.cells[g.keyOf(row)]!
    const tuple = cell.tuple
    for (const name in tuple) row[name] = tuple[name]
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

/**
 * vega `pivot`: an aggregate with one measure per distinct value of `field` (ascending, at most `limit`), each measuring `value` over
 * the rows that carry that pivot value.
 *
 * Pivot values are told apart by their string (`2` and `'2'` are one, the first spelling names the column) but a row belongs to a
 * column only if its value IS that spelling.
 */
export function pivotRows(rows: readonly Row[], p: PivotParams, random: () => number = lcg(SEED)): Row[] {
  const pivotOf = fieldOf(p.field)
  const valueOf = fieldOf(p.value)
  const op = ((p.op === 'count' ? '__count__' : p.op) as string) || 'sum'
  const seen = new Set<string>()
  const spellings: unknown[] = []
  for (const row of rows) {
    const spelling = pivotOf(row)
    const text = String(spelling)
    if (!seen.has(text)) { seen.add(text); spellings.push(spelling) }
  }
  sortData(spellings, ascending)
  const limit = (p.limit as number) || 0
  const columns = limit ? spellings.slice(0, limit) : spellings
  meterTick('pivot', columns.length)

  // One measure per column, over an accessor that yields the row's value when the row carries the column's pivot value and NaN
  // (which every measure skips) when not. A row is then handed to its own column only.
  const reads = [...(accessorFields(pivotOf) ?? []), ...(accessorFields(valueOf) ?? [])]
  const names = columns.map((c) => c + '')
  const getters = columns.map((c, i) => accessor((d: unknown) => (pivotOf(d) === c ? valueOf(d) : NaN), reads, names[i]))
  const set = planMeasures(columns.map(() => op), getters, names, [])
  const planAt = new Map<string, number>()
  set.fields.forEach((plan, i) => planAt.set(accessorName(plan.get) as string, i))
  const columnOf = new Map<unknown, number>()
  columns.forEach((c, i) => {
    const at = planAt.get(names[i]!)
    // (a NaN spelling equals nothing, not even itself; a name two columns share belongs to the first)
    if (c === c && at !== undefined && set.fields[at]!.get === getters[i]) columnOf.set(c, at)
  })

  const g = newGrouping(p.groupby, p.key, set, random)
  for (const row of rows) {
    const at = columnOf.get(pivotOf(row))
    cellAt(g, g.keyOf(row), row).group.addAt(row, at ?? -1, at === undefined ? undefined : valueOf(row))
    meterTick('pivot', columns.length)
  }
  return g.order.map(finishCell)
}
