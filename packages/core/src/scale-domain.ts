/**
 * Where a scale's domain comes from, and what a scale spec may refer to. `ScaleContext` is what a scale needs from its
 * surroundings (signal values, datasets, the size of the view); `signalValue`, `plain`, `plainList` and `plainRecord` read a
 * spec value that may be a `{signal}` reference. The domain is a literal list, a signal, one field of a dataset, or several
 * fields together: a numeric scale takes the extent of the values, a quantile scale the values themselves, and a discrete
 * scale the distinct values, in the order the spec's `sort` asks for (by key, by count, or by an aggregate of another field).
 *
 * What callers observe, and so what is fixed here:
 * - distinct values are told apart by their text, so `1` and `'1'` are one category, represented by the first of them seen;
 * - the categories come in order of first appearance unless a sort says otherwise, and equal sort values keep that order;
 * - a sort over several fields can only combine counts, minima and maxima, and has no combined `count` column to sort by;
 * - a domain that names a dataset that does not exist is an error, and so is one that names no dataset at all;
 * - a field list entry may be a literal list or a signal; its values count as one dataset of their own.
 */
import { SpecParseError } from './parse-error.js'
import { isDiscrete, isQuantile } from './scale.js'
import { aggregateGroup } from './transform.js'
import { aggregateRows } from './transform-agg.js'
import { ascending, error as raise, isArray, isObject, isString, pushAll, sortData } from './util.js'

export interface ScaleContext {
  width: number
  height: number
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** `config.range`: a named range ('category', 'ramp', ...) resolves through it before the built-in aliases. */
  configRange?: Record<string, unknown>
  /** Evaluate a JS expression string and return the result. */
  evaluate?: (expr: string) => unknown
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
  /** Return all rows of a named dataset (identity keys the per-evaluation memo). */
  dataRows?: (dataName: string) => Record<string, unknown>[]
  /** True when the named dataset exists (a domain over an unknown dataset is refused). */
  hasData?: (dataName: string) => boolean
  /** Host/runtime domain override (pan/zoom, brush domains). */
  domainRaw?: unknown[]
  /**
   * Distinct-value memo keyed by the dataset rows ARRAY identity. It must live exactly as long as one evaluation: the
   * incremental path (and hosts that mutate their arrays in place) reuse an array object with new contents, so a
   * process-global memo would serve stale domains.
   */
  distinctCache?: WeakMap<unknown[], Map<string, unknown[]>>
  /**
   * Present when the scale is made in a pass of a view that makes another (autosize fit). A scale operator keeps its scale
   * between passes, so a pass that changes its parameters finds `bins` where the pass before left them, and a scale with
   * bins leaves the zero out of its default domain: the first pass includes it, the second does not.
   */
  pass?: { prev: { key: string; bins: boolean } | undefined; record: (key: string, bins: boolean) => void }
}

/** A name a signal reference may be: a bare identifier. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
/** Names an expression knows without a signal. */
const EXPRESSION_CONSTANTS = new Set(['NaN', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2', 'MIN_VALUE', 'MAX_VALUE'])

/** The value a `signal` reference stands for: a named signal's value, or the value of an expression. */
export function signalValue(reference: string, ctx: ScaleContext): unknown {
  if (Object.hasOwn(ctx.signals, reference)) return ctx.signals[reference]
  // a bare name that is no signal is a slip in the spec; anything else is an expression
  if (IDENTIFIER.test(reference) && !EXPRESSION_CONSTANTS.has(reference)) raise(`Unrecognized signal name: ${reference}`)
  if (!ctx.evaluate) raise(`Unrecognized signal expression: ${reference}`)
  return ctx.evaluate!(reference)
}

/** A spec value: itself, or what its `signal` reference stands for; any other object is refused. */
export function plain(value: unknown, ctx: ScaleContext): unknown {
  if (!isObject(value)) return value
  const reference = (value as { signal?: unknown }).signal
  if (reference) return signalValue(String(reference), ctx)
  return raise('Unsupported object: ' + JSON.stringify(value))
}

/** A spec list (or a `{signal}` standing for one), each entry read with `plain`. */
export function plainList(value: unknown, ctx: ScaleContext): unknown {
  const reference = (value as { signal?: unknown }).signal
  return reference ? signalValue(String(reference), ctx) : (value as unknown[]).map((entry) => plain(entry, ctx))
}

/** An object whose members may each be `{signal}` references. */
export function plainRecord(value: Record<string, unknown>, ctx: ScaleContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = plain(value[key], ctx)
  return out
}

/** How the categories of a discrete domain are ordered: by `field` (or an aggregate `op` of it), ascending or descending. */
interface Ordering {
  op?: string
  field?: string
  order?: string
}

/** A distinct value with how often it occurs; further columns are named for the aggregates a sort asks for. */
interface Category extends Keyed {
  count: number
}

/** What a sort can read: the key and named columns. */
interface Keyed {
  key: unknown
  [column: string]: unknown
}

/** The aggregates a sort over several fields can combine, and how each combines. */
const COMBINE: Record<string, string> = Object.assign(Object.create(null), { min: 'min', max: 'max', count: 'sum' })

/** The name of the column holding `op` of `field` (just the field, or just the op). */
function columnName(op: string | undefined, field: string | undefined): string {
  const cleaned = field ? field.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') : ''
  return (op || '') + (op && field ? '_' : '') + cleaned
}

/**
 * The sort a domain asks for, with signals in `op`, `field` and `order` resolved. Whether the sort is allowed is judged on
 * what the spec wrote, before any signal is read: a `field` or `op` that is a `{signal}` counts as present (so a sort over
 * several fields with a signal `op` and `field` is refused, whatever the signals hold, and an `op` signal with no `field` is
 * refused unless it is the text `count`).
 */
function readOrdering(sort: unknown, severalFields: boolean, ctx: ScaleContext): Ordering | undefined {
  if (!sort) return undefined
  const written: Ordering = isObject(sort) && !isArray(sort) ? { ...(sort as Ordering) } : {}
  if (!written.field && !written.op) {
    written.field = 'key'
  } else if (!written.field && written.op !== 'count') {
    raise('No field provided for sort aggregate op: ' + written.op)
  } else if (severalFields && written.field && written.op && !COMBINE[written.op as string]) {
    raise('Multiple domain scales can not be sorted using ' + written.op)
  }
  const resolve = (v: unknown): unknown => (isObject(v) && (v as { signal?: unknown }).signal ? signalValue(String((v as { signal: string }).signal), ctx) : v)
  return { op: resolve(written.op) as string | undefined, field: resolve(written.field) as string | undefined, order: resolve(written.order) as string | undefined }
}

/** The aggregate `op` over a list of values. */
function aggregate(op: string, values: unknown[]): unknown {
  return aggregateGroup(values.map((v) => ({ v })), { type: 'aggregate', groupby: [], fields: ['v'], ops: [op], as: ['r'] }).r
}

// ---- reading a dataset ------------------------------------------------------------------------------------

function fieldNameOf(field: unknown, ctx: ScaleContext): string {
  if (isString(field)) return field
  const reference = isObject(field) ? (field as { signal?: unknown }).signal : undefined
  if (!reference) raise('Unsupported field reference: ' + JSON.stringify(field))
  return String(signalValue(String(reference), ctx))
}

function columnValues(ctx: ScaleContext, data: string, field: unknown): unknown[] {
  if (ctx.hasData && !ctx.hasData(data)) raise('Can not find data set: ' + JSON.stringify(data))
  return ctx.dataField(data, fieldNameOf(field, ctx))
}

/** Count the values by their text; the first value of each text is the key. */
function tally(values: readonly unknown[]): Category[] {
  const groups = new Map<string, Category>()
  for (const key of values) {
    const text = String(key)
    let group = groups.get(text)
    if (!group) groups.set(text, (group = { key, count: 0 }))
    group.count++
  }
  return [...groups.values()]
}

/** The categories of a field, counted, and measured by the ordering's aggregate when it has one. */
function categoriesOf(ctx: ScaleContext, data: string, field: string, ordering: Ordering | undefined): Category[] {
  const keys = columnValues(ctx, data, field)
  if (!(ordering?.op && ordering.field)) return tally(keys)
  // the aggregate engine groups by the same text rule and measures in one pass
  const measured = columnValues(ctx, data, ordering.field)
  const rows = keys.map((group, i) => ({ group, value: measured[i] }))
  const column = columnName(ordering.op, ordering.field)
  return aggregateRows(rows, { groupby: ['group'], fields: [null, 'value'], ops: ['count', ordering.op], as: ['count', 'measure'] }).map((r) => ({
    key: r.group,
    count: r.count as number,
    [column]: r.measure,
  }))
}

/** The keys of the categories in the order asked for (stable for equal values). */
function orderedKeys(categories: Keyed[], ordering: Ordering | undefined): unknown[] {
  if (!ordering) return categories.map((c) => c.key)
  const column = columnName(ordering.op, ordering.field)
  const direction = (ordering.order || 'ascending') === 'descending' ? -1 : 1
  const ranked = categories.map((category, position) => ({ category, position }))
  sortData(ranked, (a, b) => ascending(a.category[column], b.category[column]) * direction || a.position - b.position)
  return ranked.map((r) => r.category.key)
}

function categoricalDomain(ctx: ScaleContext, data: string, field: unknown, ordering: Ordering | undefined): unknown[] {
  const name = fieldNameOf(field, ctx)
  // unsorted (or key-sorted) categories depend on the rows alone: remember them for the length of one evaluation
  const rows = !(ordering?.op && ordering.field) && ctx.distinctCache && ctx.dataRows ? ctx.dataRows(data) : undefined
  let categories: Category[]
  if (rows) {
    let byField = ctx.distinctCache!.get(rows)
    if (!byField) ctx.distinctCache!.set(rows, (byField = new Map()))
    categories = byField.get(name) as Category[]
    if (!categories) byField.set(name, (categories = categoriesOf(ctx, data, name, undefined)))
  } else {
    categories = categoriesOf(ctx, data, name, ordering)
  }
  return orderedKeys(categories, ordering)
}

/** [min, max] of the numbers among the values (missing and NaN ignored); [undefined, undefined] when there are none. */
function numericExtent(values: unknown[]): [number | undefined, number | undefined] {
  let lo = +Infinity
  let hi = -Infinity
  for (let i = 0; i < values.length; i++) {
    const raw = values[i]
    if (raw == null || raw === '') continue
    const v = +(raw as number)
    // (a NaN fails both comparisons)
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : [undefined, undefined]
}

// ---- the domain of a spec ---------------------------------------------------------------------------------

/** One entry of a `fields` list: a field of a dataset, or a list of values standing in for a dataset. */
interface Member {
  data?: string
  field?: unknown
  literal?: unknown[]
}

/**
 * The values of a literal member's `data` field once a dataset has taken them in: an object is its own row, so the field
 * reads its `data` property (a Date or an array has none); anything else is wrapped as `{data: value}`. A missing value
 * cannot be a row: the dataflow fails on it (`tupleid` reads a property of it), and so does the scale.
 */
function asRows(values: readonly unknown[]): unknown[] {
  return values.map((x) => {
    if (x == null) throw new TypeError(`Cannot read properties of ${x} (reading 'Symbol(vega_id)')`)
    return typeof x === 'object' || typeof x === 'function' ? (x as { data?: unknown }).data : x
  })
}

function membersOf(domain: { fields: unknown[]; data?: string }, ctx: ScaleContext): Member[] {
  return domain.fields.map((entry): Member => {
    if (isString(entry)) return { data: domain.data, field: entry }
    if (isArray(entry)) return { literal: asRows(entry as unknown[]) }
    const reference = (entry as { signal?: unknown }).signal
    if (reference) {
      const v = signalValue(String(reference), ctx)
      // a signal's value is one row per entry: a scalar is one row, no value none
      return { literal: asRows(v == null ? [] : isArray(v) ? (v as unknown[]) : [v]) }
    }
    return entry as Member
  })
}

function valuesOfMember(ctx: ScaleContext, m: Member): unknown[] {
  return m.literal ? m.literal : columnValues(ctx, m.data as string, m.field)
}

function unionCategories(domain: { sort?: unknown }, ctx: ScaleContext, members: Member[]): unknown[] {
  const ordering = readOrdering(domain.sort, true, ctx)
  const parts: Category[] = []
  for (const m of members) {
    if (m.literal) {
      pushAll(parts, tally(m.literal))
    } else {
      if (ctx.hasData && !ctx.hasData(m.data as string)) raise('Can not find data set: ' + JSON.stringify(m.data))
      pushAll(parts, categoriesOf(ctx, m.data as string, fieldNameOf(m.field, ctx), ordering))
    }
  }
  // the column a combined sort reads, and the aggregate that merges it across the fields that share a key
  let column: string | undefined
  let combine: string | undefined
  if (ordering) {
    const op = ordering.op || 'count'
    column = ordering.field ? columnName(op, ordering.field) : 'count'
    combine = COMBINE[op]
  }
  // a key that appears in several fields is one category; with a sort, its only column is the combined measure
  // (there is no combined `count`: sorting by `field: 'count'` over several fields finds no such column and keeps the order)
  const merged = new Map<string, { category: Keyed; seen: unknown[] }>()
  for (const part of parts) {
    const text = String(part.key)
    let entry = merged.get(text)
    if (!entry) merged.set(text, (entry = { category: { key: part.key }, seen: [] }))
    if (column) entry.seen.push(part[column])
  }
  const categories: Keyed[] = []
  for (const { category, seen } of merged.values()) {
    if (column && combine) category[column] = aggregate(combine, seen)
    categories.push(category)
  }
  return orderedKeys(categories, ordering)
}

function unionDomain(domain: { fields: unknown[]; data?: string; sort?: unknown }, type: string, ctx: ScaleContext): unknown {
  const members = membersOf(domain, ctx)
  if (isDiscrete(type)) return unionCategories(domain, ctx, members)
  if (isQuantile(type)) return members.reduce<unknown[]>((all, m) => all.concat(valuesOfMember(ctx, m)), [])
  let lo = +Infinity
  let hi = -Infinity
  for (const m of members) {
    const [from, to] = numericExtent(valuesOfMember(ctx, m))
    if ((from as number) < lo) lo = from as number
    if ((to as number) > hi) hi = to as number
  }
  return [lo, hi]
}

function fieldDomain(domain: { data: string; field: unknown; sort?: unknown }, type: string, ctx: ScaleContext): unknown {
  // a domain that names no dataset at all fails the parse of the spec itself, before any view exists
  if (typeof domain.data !== 'string') throw new SpecParseError(`Undefined data set name: ${JSON.stringify(domain.data)}`)
  if (ctx.hasData && !ctx.hasData(domain.data)) raise('Can not find data set: ' + JSON.stringify(domain.data))
  if (isDiscrete(type)) return categoricalDomain(ctx, domain.data, domain.field, readOrdering(domain.sort, false, ctx))
  if (isQuantile(type)) return columnValues(ctx, domain.data, domain.field)
  return numericExtent(columnValues(ctx, domain.data, domain.field))
}

/** The domain a scale spec (or a discrete scale's range) describes; undefined for the default domain. */
export function resolveDomain(domain: unknown, spec: { type: string; domainMin?: unknown; domainMax?: unknown }, ctx: ScaleContext): unknown {
  if (!domain) {
    if (spec.domainMin != null || spec.domainMax != null) raise('No scale domain defined for domainMin/domainMax to override.')
    return undefined
  }
  const d = domain as { signal?: unknown; fields?: unknown; data?: string; field?: unknown; sort?: unknown }
  if (d.signal) return signalValue(String(d.signal), ctx)
  if (isArray(domain)) return (domain as unknown[]).map((v) => plain(v, ctx))
  if (d.fields) return unionDomain(d as { fields: unknown[]; data?: string; sort?: unknown }, spec.type, ctx)
  return fieldDomain(d as { data: string; field: unknown; sort?: unknown }, spec.type, ctx)
}
