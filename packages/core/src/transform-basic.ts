/**
 * The row transforms that need no layout engine: collect, sample, fold, flatten, project, extent, sequence, lookup, impute,
 * stack, identifier and bin (the `reshape` part of the engine, loaded on demand: engine-parts.ts; `timeunit` is the time part's,
 * transform-timeunit.ts). Each takes the transform's raw spec parameters, as a spec writes them, applies the
 * defaults of the grammar, and returns new rows (or the rows it was given, when it only selects or reads them).
 *
 * Conventions shared with `transform-agg.ts`: input rows are never written. A transform that adds fields to its rows writes onto
 * copies; the pipeline may say the rows are its own (`owned`: nothing else holds them), and then it writes onto them directly. Odd
 * values keep the meaning the grammar gives them (`null`, `''` and `NaN`, numeric strings, Dates), and field parameters accept
 * the access paths `a.b`, `a[0]` and `a\.b`.
 */
import { accessorName, array, error, one, toNumber } from './util.js'
import { compareOf, fieldOf, fieldsOf, flattenLength, lcg, numberRange, required, SEED, sortBySpec, stableSortBy, type Row } from './row-keys.js'
import { quantile } from './arr.js'
import { checkRowCount, meterTick } from './limits.js'
export { numberRange, required } from './row-keys.js'
import type { IdCounter } from './identifier-ids.js'
import { orderOf } from './tuple-order.js'
import { recorded, recordingFor } from './step-byproduct.js'

type Params = Record<string, unknown>
type Read = (d: unknown) => unknown

/** A row to write onto: the row itself when the pipeline owns it, otherwise a copy of it. */
const writable = (row: Row, owned: boolean): Row => (owned ? row : { ...row })

/** Rows to write onto: `rows` themselves (in a new array) when owned, copies otherwise. */
const writableRows = (rows: readonly Row[], owned: boolean): Row[] => (owned ? rows.slice() : rows.map((r) => ({ ...r })))

// ---------------------------------------------------------------------------
// collect, sample
// ---------------------------------------------------------------------------

/** `collect`: a stable sort by the `sort` spec (ties keep input order); the rows as they are without one. */
export function collectRows(rows: Row[], p: Params, leaveOrder = false): Row[] {
  const record = recordingFor(rows)
  if (record === undefined) return sortBySpec(rows, p.sort, leaveOrder) ?? rows
  // (the order the step state of a collect is: see step-byproduct.ts)
  let order: readonly number[] | undefined
  const sorted = sortBySpec(rows, p.sort, leaveOrder, (o) => { order = o })
  recorded(record, { kind: 'order', sort: p.sort, order: order !== undefined ? [...order] : rows.map((_, i) => i) })
  return sorted ?? rows
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

/** `flatten`: one row per array position, each array field spread over the rows (an absent element is `null`). */
export function flattenRows(rows: Row[], p: Params): Row[] {
  required('flatten', p, 'fields')
  const fields = fieldsOf(p.fields)
  const given = array(p.as) as Array<string | null | undefined>
  const names = fields.map((f, i) => (given[i] || accessorName(f)) as string)
  const indexName = (p.index as string | undefined) || null
  const out: Row[] = []
  const record = recordingFor(rows)
  const sizes = record !== undefined ? new Array<number>(rows.length) : undefined
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!
    const arrays = fields.map((f) => f(row)) as ArrayLike<unknown>[]
    const length = flattenLength(arrays)
    if (sizes !== undefined) sizes[r] = length > 0 ? length : 0
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
  if (record !== undefined) recorded(record, { kind: 'flatten', fields: p.fields, sizes: sizes! })
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
  /** Where each row stands in the order rows were made in, if that is known (see tuple-order.ts). */
  made?: number[]
}

/**
 * `stack`: for each group (by the JSON of its `groupby` values) lay the rows' values end to end and write the two ends to `as`
 * (`y0`, `y1`). `zero` stacks positive and negative values apart from 0; `center` centres each group on the widest one;
 * `normalize` scales each group to total 1. A `sort` orders the rows within a group, after its total has been summed in input order.
 */
export function stackRows(rows: Row[], p: Params, owned = false): Row[] {
  const out = writableRows(rows, owned)
  const order = orderOf(rows)
  const as = (p.as ?? ['y0', 'y1']) as string[]
  const lowName = as[0] as string
  const highName = as[1] as string
  const sort = compareOf(p.sort) as unknown as ((a: unknown, b: unknown) => number) | null
  const valueOf = p.field ? fieldOf(p.field) : (one as Read)
  const by = p.groupby == null ? null : fieldsOf(p.groupby)

  let groups: StackGroup[]
  if (by == null) {
    groups = [{ rows: out.slice(), total: 0, made: order ? Array.from(order) : undefined }]
  } else {
    const byKey = new Map<string, StackGroup>()
    groups = []
    for (let i = 0; i < out.length; i++) {
      const row = out[i]!
      const key = JSON.stringify(by.map((g) => g(row)))
      let group = byKey.get(key)
      if (!group) { byKey.set(key, (group = { rows: [], total: 0, made: order ? [] : undefined })); groups.push(group) }
      group.rows.push(row)
      group.made?.push(order![i]!)
    }
  }
  let widest = 0
  for (const group of groups) {
    let total = 0
    for (let i = 0; i < group.rows.length; i++) total += Math.abs(valueOf(group.rows[i]) as number)
    group.total = total
    if (total > widest) widest = total
    if (sort) group.rows = stableSortBy(group.rows, sort, group.made ?? null)
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

/**
 * `identifier`: a row with a truthy value in `as` keeps it; the others are numbered from the view's counter, which every
 * `identifier` transform of the view draws from (`ids`), in the order the transforms run. A row the counter has numbered before
 * is given that number again (`ids.carry[i]`, the number row `i` had), and the counter is never behind a number it has handed
 * out. Without a counter the numbering is the transform's own, from 1.
 */
export function identifierRows(rows: Row[], p: Params, owned = false, ids?: IdCounter): Row[] {
  required('identifier', p, 'as')
  const name = p.as as string
  const counter = ids ?? { value: 0 }
  const carry = counter.carry
  return rows.map((row, i) => {
    const out = writable(row, owned)
    if (!out[name]) {
      const had = carry?.[i]
      if (had) {
        out[name] = had
        if (typeof had === 'number' && had > counter.value) counter.value = had
      } else {
        out[name] = ++counter.value
      }
    }
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
