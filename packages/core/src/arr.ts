/**
 * Ordering, binary search, tick generation, quantiles and exact summation: the array and number-line helpers
 * under the scales, the statistics transforms and the geo code.
 *
 * What the callers observe, and so what is fixed here: the comparison functions give NaN for a missing or
 * unordered operand and a search over such a value lands on the end of its range; tick positions are built by
 * dividing or multiplying a rounded integer index by a power of ten, in that order, so the printed values are the
 * shortest decimal and never an accumulated sum; a quantile of an unsorted column interpolates its two nearest order
 * statistics; the compensated sum is exact to the last bit.
 */
import { boundedCount } from './limits.js'

// ---- ordering ---------------------------------------------------------------------------------------------

/** -1, 0 or 1 by the language's relational operators; NaN when either operand is missing or the pair is unordered. */
export function ascending(a: unknown, b: unknown): number {
  if (a == null || b == null) return NaN
  const x = a as number
  const y = b as number
  return x < y ? -1 : x > y ? 1 : x >= y ? 0 : NaN
}

/** `ascending` with the operands exchanged. */
export function descending(a: unknown, b: unknown): number {
  return ascending(b, a)
}

/** The last element of a list. */
export function peek<T>(list: readonly T[]): T {
  return list[list.length - 1]!
}

/**
 * `range(stop)`, `range(start, stop)` or `range(start, stop, step)`: start + i * step for every i below
 * ceil((stop - start) / step); empty when that is not a positive number.
 */
export function range(...bounds: [number] | [number, number] | [number, number, number]): number[] {
  let start = +bounds[0]
  let stop = start
  let step = 1
  if (bounds.length > 1) {
    stop = +(bounds[1] as number)
    if (bounds.length > 2) step = +(bounds[2] as number)
  } else {
    start = 0
  }
  const wanted = Math.max(0, Math.ceil((stop - start) / step))
  boundedCount(wanted, 'range', 'rows')
  const out = new Array<number>(wanted | 0)
  for (let i = 0; i < out.length; i++) out[i] = start + i * step
  return out
}

// ---- binary search ----------------------------------------------------------------------------------------

export interface Bisector<T, U> {
  left(list: readonly T[], x: U, lo?: number, hi?: number): number
  right(list: readonly T[], x: U, lo?: number, hi?: number): number
  center(list: readonly T[], x: U, lo?: number, hi?: number): number
}

/**
 * Binary searches over a sorted list, ordered either by a key accessor (one parameter) or by a comparator of an
 * element and the sought value (two parameters). Only a key accessor, or `ascending` / `descending` themselves, can
 * be asked whether the sought value is comparable at all; a value that is not (NaN, null) finds `hi`.
 */
export default function bisector<T, U>(order: ((item: T) => U) | ((item: T, x: U) => number)): Bisector<T, U> {
  const byKey = order.length !== 2
  const key = order as (item: T) => U
  const compare = order as (item: T, x: U) => number
  const cmp = byKey ? (item: T, x: U) => ascending(key(item), x) : compare
  const probe = byKey || order === (ascending as unknown) || order === (descending as unknown) ? (cmp as unknown as (a: U, b: U) => number) : null
  const selfOrder: (x: U) => number = byKey ? (x) => ascending(x, x) : probe ? (x) => (compare as unknown as (a: U, b: U) => number)(x as U, x) : () => 0

  const search = (list: readonly T[], x: U, lo: number, hi: number, passes: (c: number) => boolean): number => {
    if (lo < hi) {
      if (selfOrder(x) !== 0) return hi
      do {
        const mid = (lo + hi) >>> 1
        if (passes(cmp(list[mid]!, x))) lo = mid + 1
        else hi = mid
      } while (lo < hi)
    }
    return lo
  }
  const before = (c: number): boolean => c < 0
  const upTo = (c: number): boolean => c <= 0
  const distance = byKey ? (item: T, x: U) => (key(item) as unknown as number) - (x as unknown as number) : cmp
  const left = (list: readonly T[], x: U, lo = 0, hi = list.length): number => search(list, x, lo, hi, before)
  return {
    left,
    right: (list, x, lo = 0, hi = list.length) => search(list, x, lo, hi, upTo),
    center(list, x, lo = 0, hi = list.length) {
      const i = left(list, x, lo, hi - 1)
      return i > lo && distance(list[i - 1]!, x) > -distance(list[i]!, x) ? i - 1 : i
    },
  }
}

const ascendingSearch = bisector(ascending) as unknown as Bisector<number, number>
export const bisectRight = ascendingSearch.right
export const bisectLeft = ascendingSearch.left
export const bisect = bisectRight
export const bisectCenter = bisector((d: number) => (d === null ? NaN : +d)).center

// ---- ticks ------------------------------------------------------------------------------------------------

/** The error of a step against its power of ten at which the nicer multiples 1, 2, 5 and 10 take over. */
const STEP_CUTS = [Math.sqrt(2), Math.sqrt(10), Math.sqrt(50)] as const

/**
 * The tick positions between two ends as integer indexes `first..last`, each meaning `index / -unit` when `unit` is
 * negative (a fractional step: dividing by an integer keeps the value exact) and `index * unit` otherwise.
 */
function planTicks(start: number, stop: number, count: number): { first: number; last: number; unit: number } {
  for (;;) {
    const rough = (stop - start) / Math.max(0, count)
    const power = Math.floor(Math.log10(rough))
    const error = rough / Math.pow(10, power)
    const factor = error >= STEP_CUTS[2] ? 10 : error >= STEP_CUTS[1] ? 5 : error >= STEP_CUTS[0] ? 2 : 1
    let first: number
    let last: number
    let unit: number
    if (power < 0) {
      unit = Math.pow(10, -power) / factor
      first = Math.round(start * unit)
      last = Math.round(stop * unit)
      if (first / unit < start) ++first
      if (last / unit > stop) --last
      unit = -unit
    } else {
      unit = Math.pow(10, power) * factor
      first = Math.round(start / unit)
      last = Math.round(stop / unit)
      if (first * unit < start) ++first
      if (last * unit > stop) --last
    }
    // a count below two can leave no tick between the ends: ask for twice as many
    if (last < first && count >= 0.5 && count < 2) {
      count *= 2
      continue
    }
    return { first, last, unit }
  }
}

/** About `count` evenly spaced round numbers in [start, stop] (or [stop, start], listed from `start`). */
export function ticks(start: number, stop: number, count: number): number[] {
  start = +start
  stop = +stop
  count = +count
  if (!(count > 0)) return []
  if (start === stop) return [start]
  const reversed = stop < start
  const { first, last, unit } = reversed ? planTicks(stop, start, count) : planTicks(start, stop, count)
  if (!(last >= first)) return []
  const n = last - first + 1
  // the count comes from a spec: bound the array before allocating it
  boundedCount(n, 'ticks')
  const out = new Array<number>(n)
  const origin = reversed ? last : first
  const heading = reversed ? -1 : 1
  if (unit < 0) for (let i = 0; i < n; ++i) out[i] = (origin + heading * i) / -unit
  else for (let i = 0; i < n; ++i) out[i] = (origin + heading * i) * unit
  return out
}

/** The step of `ticks` as the unit `planTicks` found: positive for a whole step, negative for 1 / step. */
export function tickIncrement(start: number, stop: number, count: number): number {
  return planTicks(+start, +stop, +count).unit
}

/** The distance between two ticks of `ticks(start, stop, count)`, signed by the direction of the range. */
export function tickStep(start: number, stop: number, count: number): number {
  start = +start
  stop = +stop
  count = +count
  const reversed = stop < start
  const unit = reversed ? tickIncrement(stop, start, count) : tickIncrement(start, stop, count)
  return (reversed ? -1 : 1) * (unit < 0 ? 1 / -unit : unit)
}

// ---- quantiles --------------------------------------------------------------------------------------------

/** The numbers of a column: a missing entry (null, undefined, NaN) is skipped and the rest is coerced with `+`. */
export function numbers(values: Iterable<unknown>, valueof?: (d: unknown, i: number) => unknown): Float64Array {
  const kept: number[] = []
  let index = -1
  for (const raw of values) {
    const entry = valueof === undefined ? raw : valueof(raw, ++index)
    if (entry == null) continue
    const v = +(entry as number)
    if (v >= v) kept.push(v)
  }
  return Float64Array.from(kept)
}

/** Moves the k-th smallest of `a` to a[k], with nothing larger before it and nothing smaller after (Hoare partitioning). */
function placeKth(a: Float64Array, k: number): void {
  let lo = 0
  let hi = a.length - 1
  while (lo < hi) {
    const x = a[lo]!
    const y = a[(lo + hi) >> 1]!
    const z = a[hi]!
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i]! < pivot) i++
      while (a[j]! > pivot) j--
      if (i <= j) {
        const t = a[i]!
        a[i] = a[j]!
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}

/** The p-quantile (p in [0, 1]) of a column by linear interpolation between order statistics; undefined for an empty column. */
export function quantile(values: Iterable<unknown>, p: number, valueof?: (d: unknown, i: number) => unknown): number | undefined {
  const column = numbers(values, valueof)
  const n = column.length
  if (!n || isNaN((p = +p))) return undefined
  if (p <= 0 || n < 2) return column.reduce((m, v) => (v < m ? v : m))
  if (p >= 1) return column.reduce((m, v) => (v > m ? v : m))
  const position = (n - 1) * p
  const below = Math.floor(position)
  placeKth(column, below)
  const lower = column[below]!
  let upper = column[below + 1]!
  for (let i = below + 2; i < n; ++i) if (column[i]! < upper) upper = column[i]!
  return lower + (upper - lower) * (position - below)
}

/** `quantile` over a list already sorted ascending (and free of missing entries): no copy, no search. */
export function quantileSorted<V>(values: ArrayLike<V>, p: number, valueof: (d: V, i: number, all: ArrayLike<V>) => number = (d) => d as unknown as number): number | undefined {
  const n = values.length
  if (!n || isNaN((p = +p))) return undefined
  const at = (i: number): number => +valueof(values[i]!, i, values)
  if (p <= 0 || n < 2) return at(0)
  if (p >= 1) return at(n - 1)
  const position = (n - 1) * p
  const below = Math.floor(position)
  const lower = at(below)
  return lower + (at(below + 1) - lower) * (position - below)
}

// ---- exact summation --------------------------------------------------------------------------------------

/**
 * A running sum without rounding error: the sum is kept as a list of non-overlapping partial sums (Shewchuk's
 * expansion, as in Python's `math.fsum`), and `valueOf` rounds the whole list once, correctly.
 */
export class Adder {
  private readonly parts = new Float64Array(32)
  private count = 0

  add(x: number): this {
    const parts = this.parts
    let kept = 0
    for (let j = 0; j < this.count && j < 32; j++) {
      const y = parts[j]!
      const hi = x + y
      const lo = Math.abs(x) < Math.abs(y) ? x - (hi - y) : y - (hi - x)
      if (lo) parts[kept++] = lo
      x = hi
    }
    parts[kept] = x
    this.count = kept + 1
    return this
  }

  valueOf(): number {
    const parts = this.parts
    let n = this.count
    let hi = 0
    if (n > 0) {
      let lo = 0
      hi = parts[--n]!
      while (n > 0) {
        const x = hi
        const y = parts[--n]!
        hi = x + y
        lo = y - (hi - x)
        if (lo) break
      }
      // a half-way case must round to even: look at the sign of the next partial
      if (n > 0 && ((lo < 0 && parts[n - 1]! < 0) || (lo > 0 && parts[n - 1]! > 0))) {
        const doubled = lo * 2
        const x = hi + doubled
        if (doubled == x - hi) hi = x
      }
    }
    return hi
  }
}

/** The concatenation of several lists. */
export function merge(lists: readonly unknown[][]): unknown[] {
  const out: unknown[] = []
  for (const list of lists) for (const v of list) out.push(v)
  return out
}

// ---- keys that compare by value ---------------------------------------------------------------------------

/**
 * A Map whose object keys are identified by their `valueOf()` (two Dates of one instant are one key), keeping the first
 * object seen as the key the map reports. Primitive keys behave as in a Map.
 */
export class InternMap<K, V> extends Map<K, V> {
  private readonly firstSeen = new Map<unknown, K>()

  constructor(entries?: Iterable<[K, V]>) {
    super()
    if (entries != null) for (const [key, value] of entries) this.set(key, value)
  }

  private identity(key: K): unknown {
    return key !== null && typeof key === 'object' ? (key as { valueOf(): unknown }).valueOf() : key
  }

  private canonical(key: K): K {
    const id = this.identity(key)
    return this.firstSeen.has(id) ? this.firstSeen.get(id)! : key
  }

  override get(key: K): V | undefined {
    return super.get(this.canonical(key))
  }

  override has(key: K): boolean {
    return super.has(this.canonical(key))
  }

  override set(key: K, value: V): this {
    const id = this.identity(key)
    if (!this.firstSeen.has(id)) this.firstSeen.set(id, key)
    return super.set(this.firstSeen.get(id)!, value)
  }

  override delete(key: K): boolean {
    const id = this.identity(key)
    const known = this.firstSeen.has(id)
    const canonical = known ? this.firstSeen.get(id)! : key
    this.firstSeen.delete(id)
    return super.delete(canonical)
  }
}
