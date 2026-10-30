/**
 * The row transforms of vega-transforms / vega-encode that need no layout
 * engine, ported to Vega's semantics (collect, sample, fold, flatten, extent,
 * sequence, lookup, impute, stack, identifier, project, bin, timeunit, pie,
 * cross, countpattern). Each takes the transform's raw spec params, exactly as
 * Vega receives them, and applies Vega's defaults.
 *
 * Pinned by `testdata/vectors/vega-transforms*.json`. Conventions shared with
 * `transform-agg.ts`: input rows are never mutated (transforms that write onto
 * their tuples in Vega write onto copies); odd values keep Vega's meaning
 * (null/''/NaN, numeric strings, Dates); field params accept `a.b`, `a[0]`,
 * `a\.b` access paths.
 */
import { accessorName, array, error, extent as vegaExtent, one, peek, toNumber } from './util.js'
import { compareOf, fieldOf, fieldsOf, lcg, SEED, sortBySpec, stableSortBy, type Row } from './transform-agg.js'
import { tickStep } from './format.js'
import { quantile } from './arr.js'
import {
  durationDay, durationHour, durationMinute, durationMonth, durationSecond, durationWeek, durationYear,
  timeFloor, timeIntervalFor, timeUnits, utcFloor, utcIntervalFor,
} from './time.js'
import { AsterLimitError, activeMeter, checkRowCount, meterTick } from './limits.js'

type Params = Record<string, unknown>

/** Vega's parse-time check for a `required` transform parameter. */
export function required(type: string, p: Params, ...names: string[]): void {
  for (const n of names) {
    if (p[n] === undefined) error(`[aster] Missing required "${type}" parameter: "${n}"`)
  }
}

/** Derive a copy of a tuple (vega-dataflow `derive`). */
function derive(t: Row): Row {
  return { ...t }
}

// ---------------------------------------------------------------------------
// d3-array helpers used by impute / sequence
// ---------------------------------------------------------------------------

/** d3-array `range(start, stop, step)` (numeric output only). */
export function d3Range(start: number, stop: number, step: number): number[] {
  start = +start
  stop = +stop
  step = +step
  const len = Math.max(0, Math.ceil((stop - start) / step))
  // Deviation from d3 (safety): the length is bounded by the active limits
  // BEFORE the allocation (sequence 5e7, graticule steps ~0, ...).
  if (len > 0x7fffffff) throw new AsterLimitError(`range length ${len} > 2147483647`)
  const n = len | 0
  const meter = activeMeter()
  if (meter) meter.rows(Number.isFinite(len) ? len : Infinity, 'range')
  const out: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = start + i * step
    if (meter && (i & 0xffff) === 0xffff) meter.clock.check('range')
  }
  return out
}


type ValueOf = (d: unknown) => unknown

function d3mean(values: ArrayLike<unknown>, valueof: ValueOf): number | undefined {
  let count = 0
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    let v: unknown = valueof(values[i])
    if (v != null && (v = +(v as number)) >= (v as number)) { ++count; sum += v as number }
  }
  if (count) return sum / count
  return undefined
}
function d3median(values: ArrayLike<unknown>, valueof: ValueOf): number | undefined {
  return quantile(Array.from(values), 0.5, (d) => valueof(d))
}
function d3min(values: ArrayLike<unknown>, valueof: ValueOf): unknown {
  let min: unknown
  for (let i = 0; i < values.length; i++) {
    const value = valueof(values[i])
    if (value != null && ((min as number) > (value as number) || (min === undefined && (value as number) >= (value as number)))) min = value
  }
  return min
}
function d3max(values: ArrayLike<unknown>, valueof: ValueOf): unknown {
  let max: unknown
  for (let i = 0; i < values.length; i++) {
    const value = valueof(values[i])
    if (value != null && ((max as number) < (value as number) || (max === undefined && (value as number) >= (value as number)))) max = value
  }
  return max
}

// ---------------------------------------------------------------------------
// collect, sample
// ---------------------------------------------------------------------------

/** vega `collect`: a stable sort by the `sort` comparator (ties keep input order). */
export function collectRows(rows: Row[], p: Params): Row[] {
  return sortBySpec(rows, p.sort) ?? rows
}

/**
 * vega `sample`: a reservoir of `size` rows (uniform), drawn from a seeded LCG.
 *
 * Deviation from Vega: unless the host injects a source (`RuntimeInput.random`, which
 * vega's `setRandom` is the counterpart of), the reservoir is filled from `lcg(SEED)`
 * instead of `Math.random`, so the sample is a pure function of the rows (an incremental
 * evaluation equals a fresh one); with the same stream the draw is identical to
 * Vega's (pinned by the vectors). Like vega 6.3.1's runtime, an omitted `size`
 * is NOT defaulted to the documented 1000: nothing is sampled (the
 * documented default lives only in the transform's schema metadata).
 */
export function sampleRows(rows: Row[], p: Params, source?: () => number): Row[] {
  const num = p.size as number
  const random = source ?? lcg(SEED)
  const res: Row[] = []
  let cnt = 0
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!
    if (res.length < num) {
      res.push(t)
    } else {
      const idx = ~~((cnt + 1) * random())
      if (idx < res.length && idx >= 0) res[idx] = t
    }
    ++cnt
    if ((i & 1023) === 1023) meterTick('sample', 1024)
  }
  return res
}

// ---------------------------------------------------------------------------
// fold, flatten, project
// ---------------------------------------------------------------------------

export function foldRows(rows: Row[], p: Params): Row[] {
  required('fold', p, 'fields')
  const fields = fieldsOf(p.fields)
  const fnames = fields.map((f) => accessorName(f))
  const as = (p.as ?? ['key', 'value']) as string[]
  const k = as[0] as string
  const v = as[1] as string
  const n = fields.length
  checkRowCount(rows.length * n, 'fold')
  const out: Row[] = []
  for (const t of rows) {
    for (let i = 0; i < n; ++i) {
      const d = derive(t)
      d[k] = fnames[i]
      d[v] = fields[i]!(t)
      out.push(d)
    }
    meterTick('fold', n)
  }
  return out
}

/** The number of output rows Vega's flatten derives from one tuple's arrays. */
export function flattenLength(arrays: unknown[]): number {
  return arrays.reduce<number>((l, a) => Math.max(l, (a as { length: number }).length), 0)
}

export function flattenRows(rows: Row[], p: Params): Row[] {
  required('flatten', p, 'fields')
  const fields = fieldsOf(p.fields)
  const asParam = array(p.as) as Array<string | null | undefined>
  const as = fields.map((f, i) => (asParam[i] || accessorName(f)) as string)
  const index = (p.index as string | undefined) || null
  const m = as.length
  const out: Row[] = []
  for (const t of rows) {
    const arrays = fields.map((f) => f(t)) as ArrayLike<unknown>[]
    const maxlen = flattenLength(arrays)
    // maxlen comes from the data (an array length): bound it before the loop.
    checkRowCount(out.length + (maxlen > 0 ? maxlen : 0), 'flatten')
    for (let i = 0; i < maxlen; ++i) {
      const d = derive(t)
      for (let j = 0; j < m; ++j) {
        const v = arrays[j]![i]
        d[as[j]!] = v == null ? null : v
      }
      if (index) d[index] = i
      out.push(d)
    }
    meterTick('flatten', 1)
  }
  return out
}

export function projectRows(rows: Row[], p: Params): Row[] {
  const fields = p.fields == null ? null : fieldsOf(p.fields)
  if (!fields) return rows.map(derive)
  const asParam = array(p.as) as Array<string | null | undefined>
  const as = fields.map((f, i) => (asParam[i] || accessorName(f)) as string)
  const n = fields.length
  return rows.map((s) => {
    const t: Row = {}
    for (let i = 0; i < n; ++i) t[as[i]!] = fields[i]!(s)
    return t
  })
}

// ---------------------------------------------------------------------------
// extent, sequence
// ---------------------------------------------------------------------------

/** vega `extent`: `[min, max]` of the coerced field values; `[undefined, undefined]` when none are finite. */
export function extentOfField(rows: Row[], p: Params): [number | undefined, number | undefined] {
  required('extent', p, 'field')
  const f = fieldOf(p.field)
  let min = +Infinity
  let max = -Infinity
  for (const t of rows) {
    const v = toNumber(f(t))
    if (v != null) {
      // NaNs fail all comparisons
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [undefined, undefined]
  return [min, max]
}

export function sequenceRows(p: Params): Row[] {
  required('sequence', p, 'start', 'stop')
  const as = ((p.as as string | undefined) || 'data')
  const values = d3Range(p.start as number, p.stop as number, ((p.step === undefined ? 1 : p.step) || 1) as number)
  const out = new Array<Row>(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = { [as]: values[i] }
    // limits ON: sample the wall clock while the tuples are built (C7)
    if ((i & 0x3fff) === 0x3fff) meterTick('sequence', 1024)
  }
  return out
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

/**
 * vega-util `fastmap` key: the stringified key, so `1` and `'1'` collide and the last row wins.
 * (`fastmap` prefixes '$' to dodge inherited object members; a `Map` needs no prefix.)
 */
const mapKey = (k: unknown): string => String(k)

export function lookupRows(rows: Row[], p: Params, source: readonly Row[]): Row[] {
  required('lookup', p, 'fields', 'key')
  const key = fieldOf(p.key)
  const keys = fieldsOf(p.fields)
  const values = p.values == null ? null : fieldsOf(p.values)
  const defaultValue = p.default == null ? null : p.default
  const n = keys.length
  let as = p.as == null ? null : (array(p.as) as string[])
  let set: (t: Row) => void
  const index = new Map<string, Row>()
  for (const t of source) index.set(mapKey(key(t)), t)

  if (values) {
    const m = values.length
    if (n > 1 && !as) error('Multi-field lookup requires explicit "as" parameter.')
    if (as && as.length !== n * m) error('The "as" parameter has too few output field names.')
    const names = as || values.map((v) => accessorName(v) as string)
    set = (t) => {
      for (let i = 0, k = 0; i < n; ++i) {
        const v = index.get(mapKey(keys[i]!(t)))
        if (v == null) for (let j = 0; j < m; ++j, ++k) t[names[k]!] = defaultValue
        else for (let j = 0; j < m; ++j, ++k) t[names[k]!] = values[j]!(v)
      }
    }
  } else {
    if (!as) error('Missing output field names.')
    const names = as
    set = (t) => {
      for (let i = 0; i < n; ++i) {
        const v = index.get(mapKey(keys[i]!(t)))
        t[names[i]!] = v == null ? defaultValue : v
      }
    }
  }
  as = null
  return rows.map((r) => {
    const t = derive(r)
    set(t)
    return t
  })
}

// ---------------------------------------------------------------------------
// impute
// ---------------------------------------------------------------------------

type Group = Row[] & { vals?: unknown[] }

export function imputeRows(rows: Row[], p: Params): Row[] {
  required('impute', p, 'field', 'key')
  const f = fieldOf(p.field)
  const keyf = fieldOf(p.key)
  const groupby = p.groupby == null ? null : fieldsOf(p.groupby)
  const method = (p.method as string | undefined) || 'value'
  let impute: (group: Row[], field: ValueOf) => unknown
  if (method === 'value') {
    const v = p.value !== undefined ? p.value : 0
    impute = () => v
  } else if (method === 'mean') impute = d3mean
  else if (method === 'median') impute = d3median
  else if (method === 'min') impute = d3min
  else if (method === 'max') impute = d3max
  else error('Unrecognized imputation method: ' + method)
  const field: ValueOf = (t) => (t ? f(t) : NaN)
  const fName = accessorName(f) as string
  const kName = accessorName(keyf) as string
  const gNames = (groupby ?? []).map((g) => accessorName(g) as string)

  // partition (vega-transforms Impute `partition`)
  const domain: unknown[] = p.keyvals ? array(p.keyvals).slice() : []
  const kMap = new Map<string, number>()
  domain.forEach((k, i) => kMap.set(String(k), i + 1))
  const gMap = new Map<string, Group>()
  const groups: Group[] = []
  for (const t of rows) {
    const k = keyf(t)
    const ks = String(k)
    let j = kMap.get(ks)
    if (!j) { j = domain.push(k); kMap.set(ks, j) }
    const gVals = groupby ? groupby.map((g) => g(t)) : []
    const gKey = gVals + ''
    let group = gMap.get(gKey)
    if (!group) {
      group = [] as unknown as Group
      gMap.set(gKey, group)
      groups.push(group)
      group.vals = gVals
    }
    group[j - 1] = t
  }

  const m = domain.length
  const curr: Row[] = []
  checkRowCount(rows.length + groups.length * m, 'impute')
  for (const group of groups) {
    const gVals = group.vals!
    let value: unknown = NaN
    for (let j = 0; j < m; ++j) {
      if (group[j] != null) continue
      const kVal = domain[j]
      const t: Row = { _impute: true }
      for (let i = 0; i < gVals.length; i++) t[gNames[i]!] = gVals[i]
      t[kName] = kVal
      t[fName] = Number.isNaN(value) ? (value = impute(group, field)) : value
      curr.push(t)
    }
    meterTick('impute', m)
  }
  return curr.length ? rows.concat(curr) : rows
}

// ---------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------

interface StackGroup extends Array<Row> { sum?: number }

export function stackRows(rows: Row[], p: Params): Row[] {
  const out = rows.map(derive)
  const as = (p.as ?? ['y0', 'y1']) as string[]
  const y0 = as[0] as string
  const y1 = as[1] as string
  const sort = compareOf(p.sort) as unknown as ((a: unknown, b: unknown) => number) | null
  const field = p.field ? fieldOf(p.field) : (one as (d: unknown) => unknown)
  const groupby = p.groupby == null ? null : fieldsOf(p.groupby)

  // partition, sum and sort the stack groups
  const groups: StackGroup[] = []
  if (groupby == null) {
    groups.push(out.slice())
  } else {
    const map = new Map<string, StackGroup>()
    for (const t of out) {
      const k = JSON.stringify(groupby.map((g) => g(t)))
      let g = map.get(k)
      if (!g) { g = []; map.set(k, g); groups.push(g) }
      g.push(t)
    }
  }
  let max = 0
  for (let k = 0; k < groups.length; ++k) {
    let g = groups[k]!
    let s = 0
    for (let i = 0; i < g.length; ++i) s += Math.abs(field(g[i]) as number)
    g.sum = s
    if (s > max) max = s
    if (sort) {
      const sorted = stableSortBy(g, sort) as StackGroup
      sorted.sum = s
      groups[k] = g = sorted
    }
    meterTick('stack', g.length)
  }

  const offset = p.offset
  for (const group of groups) {
    const m = group.length
    if (offset === 'center') {
      let last = (max - group.sum!) / 2
      for (let j = 0; j < m; ++j) {
        const t = group[j]!
        t[y0] = last
        t[y1] = (last += Math.abs(field(t) as number))
      }
    } else if (offset === 'normalize') {
      const scale = 1 / group.sum!
      let last = 0
      let v = 0
      for (let j = 0; j < m; ++j) {
        const t = group[j]!
        t[y0] = last
        t[y1] = last = scale * (v += Math.abs(field(t) as number))
      }
    } else {
      let lastPos = 0
      let lastNeg = 0
      for (let j = 0; j < m; ++j) {
        const t = group[j]!
        const v = +(field(t) as number)
        if (v < 0) {
          t[y0] = lastNeg
          t[y1] = (lastNeg += v)
        } else {
          t[y0] = lastPos
          t[y1] = (lastPos += v)
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// identifier
// ---------------------------------------------------------------------------

/** vega `identifier`: a tuple with a truthy value in `as` keeps it; the others get 1, 2, 3, ... */
export function identifierRows(rows: Row[], p: Params): Row[] {
  required('identifier', p, 'as')
  const as = p.as as string
  let id = 0
  return rows.map((r) => {
    const t = derive(r)
    t[as] = t[as] || ++id
    return t
  })
}

// ---------------------------------------------------------------------------
// bin (vega-statistics bin + vega-transforms Bin)
// ---------------------------------------------------------------------------

const BIN_EPSILON = 1e-14

export interface BinResult { start: number; stop: number; step: number }

/** vega-statistics `bin`. Throws instead of looping forever when the step cannot grow (base <= 1). */
export function binParams(p: Params): BinResult {
  const maxb = (p.maxbins as number) || 20
  const base = (p.base as number) || 10
  const logb = Math.log(base)
  const div = (p.divide as number[] | undefined) || [5, 2]
  const ext = p.extent as number[]
  let min = ext[0] as number
  let max = ext[1] as number
  let step: number
  const span = (p.span as number) || (max - min) || Math.abs(min) || 1
  if (p.step) {
    step = p.step as number
  } else if (p.steps) {
    const steps = p.steps as number[]
    const v = span / maxb
    let i = 0
    const n = steps.length
    for (; i < n && steps[i]! < v; ++i);
    step = steps[Math.max(0, i - 1)]!
  } else {
    const level = Math.ceil(Math.log(maxb) / logb)
    const minstep = (p.minstep as number) || 0
    step = Math.max(minstep, Math.pow(base, Math.round(Math.log(span) / logb) - level))
    // increase step size if too many bins. Deliberate deviation from vega: it
    // loops forever when the step cannot grow (base 1, base < 1, an underflowed
    // step); we throw instead (C8).
    for (let guard = 0; Math.ceil(span / step) > maxb; guard++) {
      const next = step * base
      if (!(next > step) || guard > 1_000_000) {
        throw new Error('[aster] bin: cannot derive a step size from base, maxbins and the data span')
      }
      step = next
    }
    // decrease step size if allowed
    for (let i = 0, n = div.length; i < n; ++i) {
      const v = step / div[i]!
      if (v >= minstep && span / v <= maxb) step = v
    }
  }
  // update precision, min and max
  const v0 = Math.log(step)
  const precision = v0 >= 0 ? 0 : ~~(-v0 / logb) + 1
  const eps = Math.pow(base, -precision - 1)
  if (p.nice || p.nice === undefined) {
    const v = Math.floor(min / step + eps) * step
    min = min < v ? v - step : v
    max = Math.ceil(max / step) * step
  }
  return { start: min, stop: max === min ? min + step : max, step }
}

export interface BinFn { (t: unknown): number | null; start: number; stop: number; step: number }

/** The binning accessor of vega-transforms `Bin` (`_bins`): anchor shift, clamping, epsilon bias. */
export function makeBinner(p: Params): BinFn {
  const field = fieldOf(p.field)
  const bins = binParams(p)
  const step = bins.step
  let start = bins.start
  let stop = start + Math.ceil((bins.stop - start) / step) * step
  const a = p.anchor
  if (a != null) {
    const d = (a as number) - (start + step * Math.floor(((a as number) - start) / step))
    start += d
    stop += d
  }
  const f = ((t: unknown): number | null => {
    let v = toNumber(field(t))
    return v == null ? null
      : v < start ? -Infinity
        : v > stop ? +Infinity
          : (v = Math.max(start, Math.min(v, stop - step)),
            start + step * Math.floor(BIN_EPSILON + (v - start) / step))
  }) as BinFn
  f.start = start
  f.stop = stop
  f.step = step
  return f
}

export function binRows(rows: Row[], p: Params, onBins?: (b: BinResult) => void): Row[] {
  required('bin', p, 'field')
  // Deviation (Aster extension): vega requires `extent` ("Missing required bin parameter").
  // Hand-written specs and the incremental engine have always been allowed to omit it, in
  // which case the extent of the finite numeric values is used ([0, 1] when there are none).
  if (p.extent === undefined) {
    const f = fieldOf(p.field)
    let lo = Infinity
    let hi = -Infinity
    for (const r of rows) {
      const v = f(r)
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    p = { ...p, extent: lo <= hi ? [lo, hi] : [0, 1] }
  }
  const bins = makeBinner(p)
  if (onBins) onBins({ start: bins.start, stop: bins.stop, step: bins.step })
  const band = p.interval !== false
  const as = (p.as ?? ['bin0', 'bin1']) as string[]
  const b0 = as[0] as string
  const b1 = as[1] as string
  const start = bins.start
  const step = bins.step
  return rows.map((r) => {
    const t = derive(r)
    const v = bins(t)
    if (band) {
      // minimum bin value (inclusive)
      t[b0] = v
      // maximum bin value (exclusive); convoluted math for floating point agreement (vega/vega#830)
      t[b1] = v == null ? null : start + step * (1 + (v - start) / step)
    } else {
      t[b0] = v
    }
    return t
  })
}

// ---------------------------------------------------------------------------
// timeunit (vega-transforms TimeUnit, vega-time bin + detectTimeUnits)
// ---------------------------------------------------------------------------

const T_YEAR = 'year'
const T_MONTH = 'month'
const T_DATE = 'date'
const T_HOURS = 'hours'
const T_MINUTES = 'minutes'
const T_SECONDS = 'seconds'
const T_MS = 'milliseconds'
const T_WEEK = 'week'
const T_DAY = 'day'

const MILLI = [T_YEAR, T_MONTH, T_DATE, T_HOURS, T_MINUTES, T_SECONDS, T_MS]
const SECONDS = MILLI.slice(0, -1)
const MINUTES = SECONDS.slice(0, -1)
const HOURS = MINUTES.slice(0, -1)
const DAYU = HOURS.slice(0, -1)
const WEEKU = [T_YEAR, T_WEEK]
const MONTHU = [T_YEAR, T_MONTH]
const YEARU = [T_YEAR]

const BIN_INTERVALS: Array<[string[], number, number]> = [
  [SECONDS, 1, durationSecond], [SECONDS, 5, 5 * durationSecond], [SECONDS, 15, 15 * durationSecond], [SECONDS, 30, 30 * durationSecond],
  [MINUTES, 1, durationMinute], [MINUTES, 5, 5 * durationMinute], [MINUTES, 15, 15 * durationMinute], [MINUTES, 30, 30 * durationMinute],
  [HOURS, 1, durationHour], [HOURS, 3, 3 * durationHour], [HOURS, 6, 6 * durationHour], [HOURS, 12, 12 * durationHour],
  [DAYU, 1, durationDay], [WEEKU, 1, durationWeek], [MONTHU, 1, durationMonth], [MONTHU, 3, 3 * durationMonth], [YEARU, 1, durationYear],
]

/** vega-time `timeBin`: pick the units and step that give about `maxbins` bins over the extent. */
export function timeBin(ext: [number, number], maxbinsParam?: number): { units: string[]; step: number } {
  const max = maxbinsParam || 40
  const target = Math.abs(ext[ext.length - 1]! - ext[0]!) / max
  // d3-array bisector(i => i[2]).right
  let lo = 0
  let hi = BIN_INTERVALS.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (BIN_INTERVALS[mid]![2] - target <= 0) lo = mid + 1
    else hi = mid
  }
  // bisector(...).right returns the length when the target is not comparable (NaN)
  let i = target === target ? lo : BIN_INTERVALS.length
  let units: string[]
  let step: number
  if (i === BIN_INTERVALS.length) {
    units = YEARU
    step = tickStep(ext[0] / durationYear, ext[1] / durationYear, max)
  } else if (i) {
    const pick = BIN_INTERVALS[target / BIN_INTERVALS[i - 1]![2] < BIN_INTERVALS[i]![2] / target ? i - 1 : i]!
    units = pick[0]
    step = pick[1]
  } else {
    units = MILLI
    step = Math.max(tickStep(ext[0], ext[1], max), 1)
  }
  return { units, step }
}

type Getters = Record<string, (d: Date) => number>
const LOCAL_GET: Getters = {
  [T_YEAR]: (d) => d.getFullYear(), [T_MONTH]: (d) => d.getMonth(), [T_DATE]: (d) => d.getDate(), [T_DAY]: (d) => d.getDay(),
  [T_HOURS]: (d) => d.getHours(), [T_MINUTES]: (d) => d.getMinutes(), [T_SECONDS]: (d) => d.getSeconds(), [T_MS]: (d) => d.getMilliseconds(),
}
const UTC_GET: Getters = {
  [T_YEAR]: (d) => d.getUTCFullYear(), [T_MONTH]: (d) => d.getUTCMonth(), [T_DATE]: (d) => d.getUTCDate(), [T_DAY]: (d) => d.getUTCDay(),
  [T_HOURS]: (d) => d.getUTCHours(), [T_MINUTES]: (d) => d.getUTCMinutes(), [T_SECONDS]: (d) => d.getUTCSeconds(), [T_MS]: (d) => d.getUTCMilliseconds(),
}

interface Grain { units?: string[]; step?: number; skippable?: boolean; aligned: (dates: Date[], g: Getters) => boolean }
const GRAINS: Grain[] = [
  { units: MILLI, step: 1, aligned: () => true },
  { units: SECONDS, step: 1, aligned: (dates, g) => dates.every((d) => g[T_MS]!(d) === 0) },
  { units: MINUTES, step: 1, aligned: (dates, g) => dates.every((d) => g[T_SECONDS]!(d) === 0) },
  { units: MINUTES, step: 5, aligned: (dates, g) => dates.every((d) => g[T_MINUTES]!(d) % 5 === 0) },
  { units: MINUTES, step: 10, aligned: (dates, g) => dates.every((d) => g[T_MINUTES]!(d) % 10 === 0) },
  { units: HOURS, step: 1, aligned: (dates, g) => dates.every((d) => g[T_MINUTES]!(d) === 0) },
  { units: DAYU, step: 1, aligned: (dates, g) => dates.every((d) => g[T_HOURS]!(d) === 0) },
  { units: WEEKU, step: 1, skippable: true, aligned: (dates, g) => new Set(dates.map((d) => g[T_DAY]!(d))).size === 1 },
  { units: MONTHU, step: 1, aligned: (dates, g) => dates.every((d) => g[T_DATE]!(d) === 1) },
  { units: MONTHU, step: 3, aligned: (dates, g) => dates.every((d) => g[T_MONTH]!(d) % 3 === 0) },
  { units: YEARU, step: 1, aligned: (dates, g) => dates.every((d) => g[T_MONTH]!(d) === 0) },
  { units: YEARU, step: 10, aligned: (dates, g) => dates.every((d) => g[T_YEAR]!(d) % 10 === 0) },
  { aligned: () => false },
]

/** vega-time `detectTimeUnits`: the coarsest grain every date is aligned to. */
export function detectTimeUnits(data: Row[], f: (d: unknown) => unknown, utc: boolean): { units: string[]; step: number } {
  const getters = utc ? UTC_GET : LOCAL_GET
  const dates = data.map((t) => {
    const v = f(t)
    const d = new Date(v as string)
    if (Number.isNaN(+d)) error(`Invalid date: ${v}`)
    return d
  })
  const mismatch = GRAINS.findIndex((g) => !g.aligned(dates, getters))
  const req = GRAINS.findIndex((g) => !g.skippable && !g.aligned(dates, getters))
  const index = req > mismatch + 1 ? req : mismatch
  const g = GRAINS[index - 1]!
  return { units: g.units!, step: g.step! }
}

/** What vega's TimeUnit publishes as its `signal`: the floor function itself, read for its properties. */
export interface TimeUnitInfo { unit: string; units: string[]; step: number; start: number | Date; stop: number | Date }

export function timeunitRows(rows: Row[], p: Params, publish?: (info: TimeUnitInfo) => void): Row[] {
  required('timeunit', p, 'field')
  const field = fieldOf(p.field)
  const band = p.interval !== false
  const utc = p.timezone === 'utc'
  const as = (p.as ?? ['unit0', 'unit1']) as string[]
  const u0 = as[0] as string
  const u1 = as[1] as string

  // units and step
  let units: unknown
  let step: number
  if (p.inferUnits) {
    const d = detectTimeUnits(rows, field, utc)
    units = d.units
    step = d.step
  } else if (p.units) {
    units = p.units
    step = (p.step as number) || 1
  } else {
    const ext = (p.extent as [number, number] | undefined) || (vegaExtent(rows, field) as [number, number])
    const b = timeBin(ext, p.maxbins as number | undefined)
    units = b.units
    step = b.step
  }
  const tunits = timeUnits(units)
  const floor = (utc ? utcFloor : timeFloor)(tunits, step)
  const unit = peek(tunits) as string
  const ival = (utc ? utcIntervalFor : timeIntervalFor)(unit)
  const offset = ival ? (d: Date, s: number): Date => ival.offset(d, s) : undefined

  // (the extent of the bins goes with the signal: vega's TimeUnit tracks it as it visits the tuples)
  let min: number | Date = Infinity
  let max: number | Date = -Infinity
  const out = rows.map((r) => {
    const t = derive(r)
    const v = field(t)
    if (v == null) {
      t[u0] = null
      if (band) t[u1] = null
    } else {
      const a = floor(v)
      let b: unknown = a
      t[u0] = a
      if (band) t[u1] = b = offset ? offset(a, step) : undefined
      if (a < min) min = a
      if ((b as number) > (max as number)) max = b as number
    }
    return t
  })
  publish?.({ unit, units: tunits, step, start: min, stop: max })
  return out
}

