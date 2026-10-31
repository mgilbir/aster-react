/**
 * The row transforms that need no layout engine: collect, sample, fold, flatten, project, extent, sequence, lookup, impute,
 * stack, identifier, bin and timeunit. Each takes the transform's raw spec parameters, as a spec writes them, applies the
 * defaults of the grammar, and returns new rows (or the rows it was given, when it only selects or reads them).
 *
 * Conventions shared with `transform-agg.ts`: input rows are never written. A transform that adds fields to its rows writes onto
 * copies; the pipeline may say the rows are its own (`owned`: nothing else holds them), and then it writes onto them directly. Odd
 * values keep the meaning the grammar gives them (`null`, `''` and `NaN`, numeric strings, Dates), and field parameters accept
 * the access paths `a.b`, `a[0]` and `a\.b`.
 */
import { accessorName, array, error, extent as columnExtent, one, peek, toNumber } from './util.js'
import { compareOf, fieldOf, fieldsOf, lcg, SEED, sortBySpec, stableSortBy, type Row } from './transform-agg.js'
import { quantile, tickStep } from './arr.js'
import {
  DATE, DAY, HOURS, MILLISECONDS, MINUTES, MONTH, SECONDS, WEEK, YEAR,
  durationDay, durationHour, durationMinute, durationMonth, durationSecond, durationWeek, durationYear,
  timeFloor, timeIntervalFor, timeUnits, utcFloor, utcIntervalFor,
} from './time.js'
import { AsterLimitError, activeMeter, checkRowCount, meterTick } from './limits.js'

type Params = Record<string, unknown>
type Read = (d: unknown) => unknown

/** A transform's required parameter, as the grammar words the complaint. */
export function required(type: string, p: Params, ...names: string[]): void {
  for (const n of names) {
    if (p[n] === undefined) error(`[aster] Missing required "${type}" parameter: "${n}"`)
  }
}

/** A row to write onto: the row itself when the pipeline owns it, otherwise a copy of it. */
const writable = (row: Row, owned: boolean): Row => (owned ? row : { ...row })

/** Rows to write onto: `rows` themselves (in a new array) when owned, copies otherwise. */
const writableRows = (rows: readonly Row[], owned: boolean): Row[] => (owned ? rows.slice() : rows.map((r) => ({ ...r })))

/** `start, start + step, ...` below `stop` (above it for a negative step). The length is checked against the limits before it is allocated. */
export function numberRange(start: number, stop: number, step: number): number[] {
  start = +start
  stop = +stop
  step = +step
  const length = Math.max(0, Math.ceil((stop - start) / step))
  if (length > 0x7fffffff) throw new AsterLimitError(`range length ${length} > 2147483647`)
  const meter = activeMeter()
  if (meter) meter.rows(Number.isFinite(length) ? length : Infinity, 'range')
  const out: number[] = new Array(length | 0)
  for (let i = 0; i < out.length; i++) {
    out[i] = start + i * step
    if (meter && (i & 0xffff) === 0xffff) meter.clock.check('range')
  }
  return out
}

// ---------------------------------------------------------------------------
// collect, sample
// ---------------------------------------------------------------------------

/** `collect`: a stable sort by the `sort` spec (ties keep input order); the rows as they are without one. */
export function collectRows(rows: Row[], p: Params): Row[] {
  return sortBySpec(rows, p.sort) ?? rows
}

/**
 * `sample`: a uniform reservoir of `size` rows. A row past the first `size` replaces slot `~~((seen + 1) * random())` when that falls
 * inside the reservoir, so the number and order of draws is fixed by the output.
 *
 * The source is the host's injected one (`RuntimeInput.random`, Vega's `setRandom`); without one the engine's seeded stream is used
 * instead of `Math.random`, which makes a sample a pure function of its rows (an incremental evaluation equals a fresh one). An
 * omitted `size` is not defaulted to the documented 1000, as in Vega 6.3.1: nothing is sampled.
 */
export function sampleRows(rows: Row[], p: Params, source?: () => number): Row[] {
  const size = p.size as number
  const random = source ?? lcg(SEED)
  const reservoir: Row[] = []
  for (let seen = 0; seen < rows.length; seen++) {
    if (reservoir.length < size) {
      reservoir.push(rows[seen]!)
    } else {
      const slot = ~~((seen + 1) * random())
      if (slot < reservoir.length && slot >= 0) reservoir[slot] = rows[seen]!
    }
    if ((seen & 1023) === 1023) meterTick('sample', 1024)
  }
  return reservoir
}

// ---------------------------------------------------------------------------
// fold, flatten, project
// ---------------------------------------------------------------------------

/** `fold`: one row per row and field, carrying the field's name and value. */
export function foldRows(rows: Row[], p: Params): Row[] {
  required('fold', p, 'fields')
  const fields = fieldsOf(p.fields)
  const names = fields.map((f) => accessorName(f))
  const as = (p.as ?? ['key', 'value']) as string[]
  const keyName = as[0] as string
  const valueName = as[1] as string
  checkRowCount(rows.length * fields.length, 'fold')
  const out: Row[] = []
  for (const row of rows) {
    for (let i = 0; i < fields.length; ++i) {
      const folded = { ...row }
      folded[keyName] = names[i]
      folded[valueName] = fields[i]!(row)
      out.push(folded)
    }
    meterTick('fold', fields.length)
  }
  return out
}

/** The number of rows `flatten` makes of one row: the length of the longest of its arrays. */
export function flattenLength(arrays: unknown[]): number {
  return arrays.reduce<number>((longest, a) => Math.max(longest, (a as { length: number }).length), 0)
}

/** `flatten`: one row per array position, each array field spread over the rows (an absent element is `null`). */
export function flattenRows(rows: Row[], p: Params): Row[] {
  required('flatten', p, 'fields')
  const fields = fieldsOf(p.fields)
  const given = array(p.as) as Array<string | null | undefined>
  const names = fields.map((f, i) => (given[i] || accessorName(f)) as string)
  const indexName = (p.index as string | undefined) || null
  const out: Row[] = []
  for (const row of rows) {
    const arrays = fields.map((f) => f(row)) as ArrayLike<unknown>[]
    const length = flattenLength(arrays)
    // the length comes from the data: bound it before the loop
    checkRowCount(out.length + (length > 0 ? length : 0), 'flatten')
    for (let i = 0; i < length; ++i) {
      const flat = { ...row }
      for (let j = 0; j < names.length; ++j) {
        const element = arrays[j]![i]
        flat[names[j]!] = element == null ? null : element
      }
      if (indexName) flat[indexName] = i
      out.push(flat)
    }
    meterTick('flatten', 1)
  }
  return out
}

/**
 * `project`: the listed fields (renamed by `as`) as rows of their own; without `fields`, copies of the rows. Always new rows, owned or
 * not: a row some result of an earlier transform holds must not take the fields a later transform writes.
 */
export function projectRows(rows: Row[], p: Params): Row[] {
  if (p.fields == null) return rows.map((row) => ({ ...row }))
  const fields = fieldsOf(p.fields)
  const given = array(p.as) as Array<string | null | undefined>
  const names = fields.map((f, i) => (given[i] || accessorName(f)) as string)
  return rows.map((row) => {
    const projected: Row = {}
    for (let i = 0; i < fields.length; ++i) projected[names[i]!] = fields[i]!(row)
    return projected
  })
}

// ---------------------------------------------------------------------------
// extent, sequence
// ---------------------------------------------------------------------------

/** `extent`: `[min, max]` of the field's values as numbers; `[undefined, undefined]` unless both ends are finite. */
export function extentOfField(rows: Row[], p: Params): [number | undefined, number | undefined] {
  required('extent', p, 'field')
  const read = fieldOf(p.field)
  let min = +Infinity
  let max = -Infinity
  for (const row of rows) {
    const v = toNumber(read(row))
    if (v != null) {
      // (NaN fails both comparisons and is skipped)
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [undefined, undefined]
  return [min, max]
}

/** `sequence`: rows `{[as]: start}`, `{[as]: start + step}`, ... below `stop`. */
export function sequenceRows(p: Params): Row[] {
  required('sequence', p, 'start', 'stop')
  const name = ((p.as as string | undefined) || 'data')
  const values = numberRange(p.start as number, p.stop as number, ((p.step === undefined ? 1 : p.step) || 1) as number)
  const out = new Array<Row>(values.length)
  for (let i = 0; i < values.length; i++) {
    out[i] = { [name]: values[i] }
    // limits on: the clock is sampled while the rows are built
    if ((i & 0x3fff) === 0x3fff) meterTick('sequence', 1024)
  }
  return out
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

/**
 * `lookup`: copy fields from the row of `source` whose `key` matches each of the row's `fields` (the whole matched row under `as`
 * when there are no `values`; the `default`, or null, where nothing matches). Keys match by their string (`1` and `'1'` are one key)
 * and the last source row with a key wins. A data value such as `constructor` is an ordinary key.
 */
export function lookupRows(rows: Row[], p: Params, source: readonly Row[], owned = false): Row[] {
  required('lookup', p, 'fields', 'key')
  const keyOf = fieldOf(p.key)
  const probes = fieldsOf(p.fields)
  const values = p.values == null ? null : fieldsOf(p.values)
  const fallback = p.default == null ? null : p.default
  const as = p.as == null ? null : (array(p.as) as string[])
  const matches = new Map<string, Row>()
  for (const row of source) matches.set(String(keyOf(row)), row)

  let fill: (row: Row) => void
  if (values) {
    if (probes.length > 1 && !as) error('Multi-field lookup requires explicit "as" parameter.')
    if (as && as.length !== probes.length * values.length) error('The "as" parameter has too few output field names.')
    const names = as || values.map((v) => accessorName(v) as string)
    // (the probes read the row being filled: a field written by an earlier probe is what a later one sees)
    fill = (row) => {
      let at = 0
      for (let i = 0; i < probes.length; i++) {
        const found = matches.get(String(probes[i]!(row)))
        for (let j = 0; j < values.length; j++) row[names[at++]!] = found == null ? fallback : values[j]!(found)
      }
    }
  } else {
    if (!as) error('Missing output field names.')
    fill = (row) => {
      probes.forEach((probe, i) => {
        const found = matches.get(String(probe(row)))
        row[as[i]!] = found == null ? fallback : found
      })
    }
  }
  return rows.map((row) => {
    const out = writable(row, owned)
    fill(out)
    return out
  })
}

// ---------------------------------------------------------------------------
// impute
// ---------------------------------------------------------------------------

/** What a group of rows is imputed from: the group's rows (holes for the key values it lacks) read through a field. */
type Imputer = (group: ArrayLike<Row | undefined>, read: Read) => unknown

const imputers: Record<string, Imputer> = {
  mean(group, read) {
    let count = 0
    let sum = 0
    for (let i = 0; i < group.length; i++) {
      const raw = read(group[i])
      const x = raw != null ? +(raw as number) : NaN
      if (x >= x) { ++count; sum += x }
    }
    return count ? sum / count : undefined
  },
  median: (group, read) => quantile(Array.from(group), 0.5, (row) => read(row)),
  min(group, read) {
    let low: unknown
    for (let i = 0; i < group.length; i++) {
      const v = read(group[i])
      if (v != null && ((low as number) > (v as number) || (low === undefined && (v as number) >= (v as number)))) low = v
    }
    return low
  },
  max(group, read) {
    let high: unknown
    for (let i = 0; i < group.length; i++) {
      const v = read(group[i])
      if (v != null && ((high as number) < (v as number) || (high === undefined && (v as number) >= (v as number)))) high = v
    }
    return high
  },
}

/** One imputation group: the group-by values it was opened with, and its rows at the position of their key value. */
interface ImputeGroup {
  by: unknown[]
  slots: Row[]
}

/**
 * `impute`: for each group (by `groupby`) add a row for every key value the group lacks. The key values are `keyvals`, then any
 * further key met in the data, in order of appearance. The imputed field is the constant `value` (default 0) or the group's
 * mean/median/min/max, computed once per group (again for each row while it comes out as NaN). An imputed row reads
 * `{_impute: true, <group fields>, <key>: key value, <field>: imputed}`.
 */
export function imputeRows(rows: Row[], p: Params): Row[] {
  required('impute', p, 'field', 'key')
  const fieldRead = fieldOf(p.field)
  const keyRead = fieldOf(p.key)
  const by = p.groupby == null ? null : fieldsOf(p.groupby)
  const method = (p.method as string | undefined) || 'value'
  let imputed: Imputer
  if (method === 'value') {
    const constant = p.value !== undefined ? p.value : 0
    imputed = () => constant
  } else if (Object.hasOwn(imputers, method)) imputed = imputers[method]!
  else error('Unrecognized imputation method: ' + method)
  const read: Read = (row) => (row ? fieldRead(row) : NaN)
  const fieldName = accessorName(fieldRead) as string
  const keyName = accessorName(keyRead) as string
  const byNames = (by ?? []).map((g) => accessorName(g) as string)

  const domain: unknown[] = p.keyvals ? array(p.keyvals).slice() : []
  const slotOf = new Map<string, number>()
  domain.forEach((k, i) => slotOf.set(String(k), i))
  const groups = new Map<string, ImputeGroup>()
  for (const row of rows) {
    const key = keyRead(row)
    let slot = slotOf.get(String(key))
    if (slot === undefined) { slot = domain.push(key) - 1; slotOf.set(String(key), slot) }
    const groupValues = by ? by.map((g) => g(row)) : []
    // (groups are told apart by the joined string of their values: null, undefined and '' are one, and so on)
    const groupKey = groupValues + ''
    let group = groups.get(groupKey)
    if (!group) groups.set(groupKey, (group = { by: groupValues, slots: [] }))
    group.slots[slot] = row
  }

  const added: Row[] = []
  checkRowCount(rows.length + groups.size * domain.length, 'impute')
  for (const group of groups.values()) {
    let value: unknown = NaN
    for (let slot = 0; slot < domain.length; ++slot) {
      if (group.slots[slot] != null) continue
      const row: Row = { _impute: true }
      for (let i = 0; i < group.by.length; i++) row[byNames[i]!] = group.by[i]
      row[keyName] = domain[slot]
      row[fieldName] = Number.isNaN(value) ? (value = imputed(group.slots, read)) : value
      added.push(row)
    }
    meterTick('impute', domain.length)
  }
  return added.length ? rows.concat(added) : rows
}

// ---------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------

interface StackGroup {
  rows: Row[]
  /** Sum of the absolute values of the group, in the rows' input order. */
  total: number
}

/**
 * `stack`: for each group (by the JSON of its `groupby` values) lay the rows' values end to end and write the two ends to `as`
 * (`y0`, `y1`). `zero` stacks positive and negative values apart from 0; `center` centres each group on the widest one;
 * `normalize` scales each group to total 1. A `sort` orders the rows within a group, after its total has been summed in input order.
 */
export function stackRows(rows: Row[], p: Params, owned = false): Row[] {
  const out = writableRows(rows, owned)
  const as = (p.as ?? ['y0', 'y1']) as string[]
  const lowName = as[0] as string
  const highName = as[1] as string
  const sort = compareOf(p.sort) as unknown as ((a: unknown, b: unknown) => number) | null
  const valueOf = p.field ? fieldOf(p.field) : (one as Read)
  const by = p.groupby == null ? null : fieldsOf(p.groupby)

  let groups: StackGroup[]
  if (by == null) {
    groups = [{ rows: out.slice(), total: 0 }]
  } else {
    const byKey = new Map<string, StackGroup>()
    groups = []
    for (const row of out) {
      const key = JSON.stringify(by.map((g) => g(row)))
      let group = byKey.get(key)
      if (!group) { byKey.set(key, (group = { rows: [], total: 0 })); groups.push(group) }
      group.rows.push(row)
    }
  }
  let widest = 0
  for (const group of groups) {
    let total = 0
    for (let i = 0; i < group.rows.length; i++) total += Math.abs(valueOf(group.rows[i]) as number)
    group.total = total
    if (total > widest) widest = total
    if (sort) group.rows = stableSortBy(group.rows, sort)
    meterTick('stack', group.rows.length)
  }

  const offset = p.offset
  for (let g = 0; g < groups.length; g++) {
    const members = groups[g]!.rows
    const total = groups[g]!.total
    const n = members.length
    if (offset === 'center') {
      let end = (widest - total) / 2
      for (let i = 0; i < n; i++) {
        const row = members[i]!
        row[lowName] = end
        row[highName] = (end += Math.abs(valueOf(row) as number))
      }
    } else if (offset === 'normalize') {
      const scale = 1 / total
      let end = 0
      let running = 0
      for (let i = 0; i < n; i++) {
        const row = members[i]!
        row[lowName] = end
        row[highName] = end = scale * (running += Math.abs(valueOf(row) as number))
      }
    } else {
      let above = 0
      let below = 0
      for (let i = 0; i < n; i++) {
        const row = members[i]!
        const v = +(valueOf(row) as number)
        if (v < 0) {
          row[lowName] = below
          row[highName] = (below += v)
        } else {
          row[lowName] = above
          row[highName] = (above += v)
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// identifier
// ---------------------------------------------------------------------------

/** `identifier`: a row with a truthy value in `as` keeps it; the others are numbered 1, 2, 3, ... in order. */
export function identifierRows(rows: Row[], p: Params, owned = false): Row[] {
  required('identifier', p, 'as')
  const name = p.as as string
  let last = 0
  return rows.map((row) => {
    const out = writable(row, owned)
    out[name] = out[name] || ++last
    return out
  })
}

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

/** A binning: bin edges run from `start` to `stop` in steps of `step`. */
export interface BinGrid { start: number; stop: number; step: number }

/** The step of bins no coarser than `maxBins` over `span`: given, picked from the allowed `steps`, or searched as a nice power of the base. */
function binStep(p: Params, span: number, maxBins: number, base: number): number {
  if (p.step) return p.step as number
  if (p.steps) {
    // the largest allowed step below span / maxbins (the smallest one when none is)
    const steps = p.steps as number[]
    const wanted = span / maxBins
    let below = 0
    while (below < steps.length && steps[below]! < wanted) ++below
    return steps[Math.max(0, below - 1)]!
  }
  const logBase = Math.log(base)
  const minStep = (p.minstep as number) || 0
  const level = Math.ceil(Math.log(maxBins) / logBase)
  let step = Math.max(minStep, Math.pow(base, Math.round(Math.log(span) / logBase) - level))
  // coarser while too many bins; a base that cannot make it coarser would loop for ever, so it is refused
  for (let guard = 0; Math.ceil(span / step) > maxBins; guard++) {
    const coarser = step * base
    if (!(coarser > step) || guard > 1_000_000) {
      throw new Error('[aster] bin: cannot derive a step size from base, maxbins and the data span')
    }
    step = coarser
  }
  // then finer by each divisor that still keeps the bins within the limit
  for (const divisor of (p.divide as number[] | undefined) || [5, 2]) {
    const finer = step / divisor
    if (finer >= minStep && span / finer <= maxBins) step = finer
  }
  return step
}

/** The bin edges `bin` lays over `extent`: the step, and (unless `nice` is off) the extent widened to whole steps. */
function binGrid(p: Params): BinGrid {
  const maxBins = (p.maxbins as number) || 20
  const base = (p.base as number) || 10
  const extent = p.extent as number[]
  let min = extent[0] as number
  let max = extent[1] as number
  const span = (p.span as number) || (max - min) || Math.abs(min) || 1
  const step = binStep(p, span, maxBins, base)
  if (p.nice || p.nice === undefined) {
    const logStep = Math.log(step)
    const digits = logStep >= 0 ? 0 : ~~(-logStep / Math.log(base)) + 1
    const slack = Math.pow(base, -digits - 1)
    const floor = Math.floor(min / step + slack) * step
    min = min < floor ? floor - step : floor
    max = Math.ceil(max / step) * step
  }
  return { start: min, stop: max === min ? min + step : max, step }
}

/** Bias added before the floor, so a value on an edge that rounding left a hair below it lands in the bin above. */
const EDGE_BIAS = 1e-14

/** `bin`: `as` (default `bin0`, `bin1`) get the start and end of the value's bin; without `interval`, only the start. */
export function binRows(rows: Row[], p: Params, publish?: (grid: BinGrid) => void, owned = false): Row[] {
  required('bin', p, 'field')
  const read = fieldOf(p.field)
  // Extension: Vega requires `extent`; a hand-written spec may leave it out, and the extent of the finite numbers is then used
  // ([0, 1] when there are none).
  if (p.extent === undefined) {
    let low = Infinity
    let high = -Infinity
    for (const row of rows) {
      const v = read(row)
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < low) low = v
        if (v > high) high = v
      }
    }
    p = { ...p, extent: low <= high ? [low, high] : [0, 1] }
  }
  const grid = binGrid(p)
  const step = grid.step
  let start = grid.start
  let stop = start + Math.ceil((grid.stop - start) / step) * step
  const anchor = p.anchor
  if (anchor != null) {
    const shift = (anchor as number) - (start + step * Math.floor(((anchor as number) - start) / step))
    start += shift
    stop += shift
  }
  publish?.({ start, stop, step })
  const withEnd = p.interval !== false
  const as = (p.as ?? ['bin0', 'bin1']) as string[]
  const startName = as[0] as string
  const endName = as[1] as string
  const lastStart = stop - step
  return rows.map((row) => {
    const out = writable(row, owned)
    const raw = read(row)
    const v = typeof raw === 'number' ? raw : toNumber(raw)
    // the start of the bin: ±Infinity outside the extent, the first or last bin at its ends, null for no value
    const binStart = v == null ? null
      : v < start ? -Infinity
        : v > stop ? +Infinity
          : start + step * Math.floor(EDGE_BIAS + (Math.max(start, Math.min(v, lastStart)) - start) / step)
    out[startName] = binStart
    // (written as start + step * (1 + (binStart - start) / step), which is what laying the edges out one step at a time gives in floating point)
    if (withEnd) out[endName] = binStart == null ? null : start + step * (1 + (binStart - start) / step)
    return out
  })
}

// ---------------------------------------------------------------------------
// timeunit
// ---------------------------------------------------------------------------

const THROUGH_MILLISECONDS = [YEAR, MONTH, DATE, HOURS, MINUTES, SECONDS, MILLISECONDS]
const THROUGH_SECONDS = THROUGH_MILLISECONDS.slice(0, -1)
const THROUGH_MINUTES = THROUGH_SECONDS.slice(0, -1)
const THROUGH_HOURS = THROUGH_MINUTES.slice(0, -1)
const THROUGH_DATE = THROUGH_HOURS.slice(0, -1)
const YEAR_WEEK = [YEAR, WEEK]
const YEAR_MONTH = [YEAR, MONTH]
const YEAR_ONLY = [YEAR]

/** The calendar steps a time bin may use, each with its length in ms (an approximation for months and years), shortest first. */
const BIN_GRAINS: Array<{ units: string[]; step: number; ms: number }> = [
  { units: THROUGH_SECONDS, step: 1, ms: durationSecond }, { units: THROUGH_SECONDS, step: 5, ms: 5 * durationSecond },
  { units: THROUGH_SECONDS, step: 15, ms: 15 * durationSecond }, { units: THROUGH_SECONDS, step: 30, ms: 30 * durationSecond },
  { units: THROUGH_MINUTES, step: 1, ms: durationMinute }, { units: THROUGH_MINUTES, step: 5, ms: 5 * durationMinute },
  { units: THROUGH_MINUTES, step: 15, ms: 15 * durationMinute }, { units: THROUGH_MINUTES, step: 30, ms: 30 * durationMinute },
  { units: THROUGH_HOURS, step: 1, ms: durationHour }, { units: THROUGH_HOURS, step: 3, ms: 3 * durationHour },
  { units: THROUGH_HOURS, step: 6, ms: 6 * durationHour }, { units: THROUGH_HOURS, step: 12, ms: 12 * durationHour },
  { units: THROUGH_DATE, step: 1, ms: durationDay }, { units: YEAR_WEEK, step: 1, ms: durationWeek },
  { units: YEAR_MONTH, step: 1, ms: durationMonth }, { units: YEAR_MONTH, step: 3, ms: 3 * durationMonth },
  { units: YEAR_ONLY, step: 1, ms: durationYear },
]

/**
 * The units and step that give about `maxbins` bins over a time extent: the calendar step whose length is nearest (in ratio) to
 * the extent's span over `maxbins`, years in a tick step beyond the longest, and milliseconds below the shortest.
 * An extent whose ends do not subtract to a number (NaN, Infinity - Infinity, a missing end) spans nothing.
 */
export function timeBin(extent: readonly number[], maxbins?: number): { units: string[]; step: number } {
  const bins = maxbins || 40
  const target = Math.abs((extent[extent.length - 1]! - extent[0]!) || 0) / bins
  let longer = 0
  while (longer < BIN_GRAINS.length && BIN_GRAINS[longer]!.ms - target <= 0) longer++
  if (longer === BIN_GRAINS.length) {
    return { units: YEAR_ONLY, step: tickStep(extent[0]! / durationYear, extent[1]! / durationYear, bins) }
  }
  if (longer === 0) {
    return { units: THROUGH_MILLISECONDS, step: Math.max(tickStep(extent[0]!, extent[1]!, bins), 1) }
  }
  const shorter = BIN_GRAINS[longer - 1]!
  const nearer = target / shorter.ms < BIN_GRAINS[longer]!.ms / target ? shorter : BIN_GRAINS[longer]!
  return { units: nearer.units, step: nearer.step }
}

type DateParts = (d: Date) => number
const localParts: Record<string, DateParts> = {
  [YEAR]: (d) => d.getFullYear(), [MONTH]: (d) => d.getMonth(), [DATE]: (d) => d.getDate(), [DAY]: (d) => d.getDay(),
  [HOURS]: (d) => d.getHours(), [MINUTES]: (d) => d.getMinutes(), [SECONDS]: (d) => d.getSeconds(), [MILLISECONDS]: (d) => d.getMilliseconds(),
}
const utcParts: Record<string, DateParts> = {
  [YEAR]: (d) => d.getUTCFullYear(), [MONTH]: (d) => d.getUTCMonth(), [DATE]: (d) => d.getUTCDate(), [DAY]: (d) => d.getUTCDay(),
  [HOURS]: (d) => d.getUTCHours(), [MINUTES]: (d) => d.getUTCMinutes(), [SECONDS]: (d) => d.getUTCSeconds(), [MILLISECONDS]: (d) => d.getUTCMilliseconds(),
}

/** Time grains from the finest to the coarsest, each with the units and step that bin to it. The last has none: nothing is aligned to it. */
const GRAINS: Array<{ units: string[]; step: number } | { units?: undefined; step?: undefined }> = [
  { units: THROUGH_MILLISECONDS, step: 1 }, { units: THROUGH_SECONDS, step: 1 }, { units: THROUGH_MINUTES, step: 1 },
  { units: THROUGH_MINUTES, step: 5 }, { units: THROUGH_MINUTES, step: 10 }, { units: THROUGH_HOURS, step: 1 },
  { units: THROUGH_DATE, step: 1 }, { units: YEAR_WEEK, step: 1 }, { units: YEAR_MONTH, step: 1 },
  { units: YEAR_MONTH, step: 3 }, { units: YEAR_ONLY, step: 1 }, { units: YEAR_ONLY, step: 10 }, {},
]
/** The week grain is the only one the coarse search may step over: dates that share a weekday are on it, yet it is not required. */
const WEEK_GRAIN = 7

/** Whether every date sits on the boundary of each grain (index as in {@link GRAINS}); the week grain holds when all dates share a weekday. */
function alignedGrains(dates: readonly Date[], utc: boolean): boolean[] {
  const part = utc ? utcParts : localParts
  const aligned = GRAINS.map(() => true)
  aligned[GRAINS.length - 1] = false
  const weekdays = new Set<number>()
  for (const d of dates) {
    if (part[MILLISECONDS]!(d) !== 0) aligned[1] = false
    if (part[SECONDS]!(d) !== 0) aligned[2] = false
    const minute = part[MINUTES]!(d)
    if (minute % 5 !== 0) aligned[3] = false
    if (minute % 10 !== 0) aligned[4] = false
    if (minute !== 0) aligned[5] = false
    if (part[HOURS]!(d) !== 0) aligned[6] = false
    weekdays.add(part[DAY]!(d))
    if (part[DATE]!(d) !== 1) aligned[8] = false
    const month = part[MONTH]!(d)
    if (month % 3 !== 0) aligned[9] = false
    if (month !== 0) aligned[10] = false
    if (part[YEAR]!(d) % 10 !== 0) aligned[11] = false
  }
  aligned[WEEK_GRAIN] = weekdays.size === 1
  return aligned
}

/** The coarsest grain every date in `rows` (read through `read`) is aligned to, as the units and step to bin by. */
function detectTimeUnits(rows: Row[], read: Read, utc: boolean): { units: string[]; step: number } {
  const dates = rows.map((row) => {
    const v = read(row)
    const d = new Date(v as string)
    if (Number.isNaN(+d)) error(`Invalid date: ${v}`)
    return d
  })
  const aligned = alignedGrains(dates, utc)
  const firstMiss = aligned.indexOf(false)
  const firstRequiredMiss = aligned.findIndex((ok, i) => !ok && i !== WEEK_GRAIN)
  const stop = firstRequiredMiss > firstMiss + 1 ? firstRequiredMiss : firstMiss
  const grain = GRAINS[stop - 1]!
  return { units: grain.units!, step: grain.step! }
}

/** What the `signal` of a timeunit transform publishes: the unit it floors to, the unit list, the step and the span of bins produced. */
export interface TimeUnitInfo { unit: string; units: string[]; step: number; start: number | Date; stop: number | Date }

/**
 * `timeunit`: `as` (default `unit0`, `unit1`) get the start and end of the value's time bin; null where there is no value, and
 * only the start without `interval`. The units are `units` (with `step`), detected from the data (`inferUnits`), or chosen to give
 * about `maxbins` bins over `extent` (the data's, by default).
 */
export function timeunitRows(rows: Row[], p: Params, publish?: (info: TimeUnitInfo) => void, owned = false): Row[] {
  required('timeunit', p, 'field')
  const read = fieldOf(p.field)
  const withEnd = p.interval !== false
  const utc = p.timezone === 'utc'
  const as = (p.as ?? ['unit0', 'unit1']) as string[]
  const startName = as[0] as string
  const endName = as[1] as string

  let units: unknown
  let step: number
  if (p.inferUnits) {
    ({ units, step } = detectTimeUnits(rows, read, utc))
  } else if (p.units) {
    units = p.units
    step = (p.step as number) || 1
  } else {
    ({ units, step } = timeBin((p.extent as [number, number] | undefined) || (columnExtent(rows, read) as [number, number]), p.maxbins as number | undefined))
  }
  const unitList = timeUnits(units)
  const floor = (utc ? utcFloor : timeFloor)(unitList, step)
  const unit = peek(unitList) as string
  const interval = (utc ? utcIntervalFor : timeIntervalFor)(unit)

  // (the span of the bins is published with the signal: it is what the rows visited came to)
  let first: number | Date = Infinity
  let last: number | Date = -Infinity
  const out = rows.map((row) => {
    const t = writable(row, owned)
    const v = read(row)
    if (v == null) {
      t[startName] = null
      if (withEnd) t[endName] = null
    } else {
      const binStart = floor(v)
      let binEnd: unknown = binStart
      t[startName] = binStart
      if (withEnd) t[endName] = binEnd = interval ? interval.offset(binStart, step) : undefined
      if (binStart < first) first = binStart
      if ((binEnd as number) > (last as number)) last = binEnd as number
    }
    return t
  })
  publish?.({ unit, units: unitList, step, start: first, stop: last })
  return out
}
