/**
 * Reading rows by field and ordering them: the accessors of field specs, the `{field, order}` sorts, the group-by keys and the
 * engine's own pseudo-random stream. Every pipeline uses these, whatever transforms it runs; the transforms that aggregate
 * (`transform-agg.ts`, `transform-window.ts`) and reshape rows (`transform-basic.ts`) are parts of the engine loaded on demand
 * (engine-parts.ts), so what all of them share lives here, outside those parts.
 */
import { orderOf, setOrder } from './tuple-order.js'
import { accessor, accessorFields, array, ascending, error, field, sortData, type Accessor } from './util.js'
import { AsterLimitError, activeMeter, meterRows } from './limits.js'
import { ascending as numericAscending, quantileSorted } from './arr.js'

export type Row = Record<string, unknown>
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
 * with values (NaN, mixed types) that no ordering is consistent over. With `leaveOrder` the sorted copy also carries the order its
 * rows were made in (see tuple-order.ts), for the sorts that come after it to break their ties by; the request is an argument of
 * this one call, so it cannot reach any other sort. `onOrder` is handed the input position of each sorted item.
 */
export function sortBySpec<T>(items: readonly T[], spec: unknown, leaveOrder = false, onOrder?: (order: readonly number[]) => void): T[] | null {
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
  const places = orderOf(items)
  if (m === 1) {
    const column = columns[0]!
    const sign = keys.sign[0]!
    sortData(order, (i, j) => compareValues(column[i], column[j]) * sign || (places ? places[i]! - places[j]! : 0) || i - j)
  } else {
    sortData(order, (i, j) => {
      for (let k = 0; k < m; k++) {
        const c = compareValues(columns[k]![i], columns[k]![j])
        if (c !== 0) return c * keys.sign[k]! || (places ? places[i]! - places[j]! : 0) || i - j
      }
      return (places ? places[i]! - places[j]! : 0) || i - j
    })
  }
  const sorted = order.map((i) => items[i]!)
  onOrder?.(order)
  if (leaveOrder) {
    const made = new Float64Array(n)
    for (let i = 0; i < n; i++) made[i] = places ? places[order[i]!]! : order[i]!
    setOrder(sorted, made)
  }
  return sorted
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
export function stableSortBy<T>(items: readonly T[], compare: Compare | null, made: ArrayLike<number> | null = null): T[] {
  if (!compare) return items.slice()
  const n = items.length
  const order = new Array<number>(n)
  for (let i = 0; i < n; i++) order[i] = i
  sortData(order, (i, j) => compare(items[i], items[j]) || (made ? made[i]! - made[j]! : 0) || i - j)
  const sorted = new Array<T>(n)
  for (let i = 0; i < n; i++) sorted[i] = items[order[i]!]!
  return sorted
}


/** The string a row's group is known by: `''` with no group-by, the value's string for one field, the strings joined by `|` for several. */
export function groupKeyOf(dims: readonly Accessor[]): (row: Row) => string {
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

/**
 * The string vega identifies the group items of a facet by (what it calls the flat key): each group-by name with its backslash
 * escapes removed (`a\.b` is `a.b`), read as a plain property name of the group's aggregate row, not as a path. The row names
 * its values under the names the spec gave, so a name whose escapes change it (`a\.b` is a field `a.b` in the data, and its
 * value sits under `a\.b` in the row) reads nothing: every group of such a facet has the key `undefined`.
 */
export function flatKeyFn(groupby: unknown): (row: Row) => string {
  const names = array(groupby).map((f) => String(f).replace(/\\(.)/g, '$1'))
  if (names.length === 0) return () => ''
  if (names.length === 1) {
    const only = names[0]!
    return (row) => '' + row[only]
  }
  return (row) => {
    let key = '' + row[names[0]!]
    for (let i = 1; i < names.length; i++) key += '|' + row[names[i]!]
    return key
  }
}

/** A transform's required parameter, as the grammar words the complaint. */
export function required(type: string, p: Record<string, unknown>, ...names: string[]): void {
  for (const n of names) {
    if (p[n] === undefined) error(`[aster] Missing required "${type}" parameter: "${n}"`)
  }
}

/** `start, start + step, ...` below `stop` (above it for a negative step). The length is checked against the limits before it is allocated. */
export function numberRange(start: number, stop: number, step: number): number[] {
  start = +start
  stop = +stop
  step = +step
  const length = Math.max(0, Math.ceil((stop - start) / step))
  if (length > 0x7fffffff) throw new AsterLimitError(`range length ${length} > 2147483647`)
  const meter = activeMeter()
  meterRows(Number.isFinite(length) ? length : Infinity, 'range')
  const out: number[] = new Array(length | 0)
  for (let i = 0; i < out.length; i++) {
    out[i] = start + i * step
    if (meter && (i & 0xffff) === 0xffff) meter.clock.check('range')
  }
  return out
}

/** The number of rows `flatten` makes of one row: the length of the longest of its arrays. */
export function flattenLength(arrays: unknown[]): number {
  return arrays.reduce<number>((longest, a) => Math.max(longest, (a as { length: number }).length), 0)
}

type Get = (d: unknown) => unknown

/** The values that count as numbers: not missing, not empty, and not NaN once coerced. */
export function numbersOf(values: ArrayLike<unknown>, get?: Get): number[] {
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
