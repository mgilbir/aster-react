/**
 * d3-array subset (3.2.4): bisector/bisect, range, ticks, quantile, plus the
 * internmap InternMap used by ordinal scales. Faithful transcription verified
 * against oracle vectors recorded from pinned d3-array@3.2.4 / internmap@2.0.3.
 */

export function ascending(u: unknown, v: unknown): number {
  return (u as number) < (v as number) ? -1 : (u as number) > (v as number) ? 1 : (u as number) >= (v as number) ? 0 : NaN
}

export function descending(u: unknown, v: unknown): number {
  return (v as number) < (u as number) ? -1 : (v as number) > (u as number) ? 1 : (v as number) >= (u as number) ? 0 : NaN
}

/** Last element of an array (vega-util's `peek`). */
export function peek<T>(array: readonly T[]): T {
  return array[array.length - 1]!
}

export function range(start: number, stop?: number, step?: number): number[] {
  const n = arguments.length
  start = +start
  if (n < 2) {
    stop = start
    start = 0
  }
  const st = n < 3 ? 1 : +step!
  let i = -1
  const m = Math.max(0, Math.ceil((stop! - start) / st)) | 0
  const out = new Array<number>(m)
  while (++i < m) {
    out[i] = start + i * st
  }
  return out
}

export interface Bisector<T, U> {
  left(array: readonly T[], x: U, lo?: number, hi?: number): number
  right(array: readonly T[], x: U, lo?: number, hi?: number): number
  center(array: readonly T[], x: U, lo?: number, hi?: number): number
}

function zero(): number {
  return 0
}

export default function bisector<T, U>(f: ((d: T) => U) | ((a: T, b: U) => number)): Bisector<T, U> {
  let compare1: (a: unknown, b: unknown) => number
  let compare2: (d: T, x: U) => number
  let delta: (d: T, x: U) => number
  // If an accessor is specified, promote it to a comparator. In this case we
  // can test whether the search value is (self-) comparable. We can't do this
  // for a comparator (except for specific, known comparators) because we can't
  // tell if the comparator is symmetric, and an asymmetric comparator can't be
  // used to test whether a single value is comparable.
  if ((f as (d: T) => U).length !== 2) {
    const accessor = f as (d: T) => U
    compare1 = ascending
    compare2 = (d, x) => ascending(accessor(d), x)
    delta = (d, x) => (accessor(d) as unknown as number) - (x as unknown as number)
  } else {
    const comparator = f as (a: T, b: U) => number
    compare1 = (comparator === ascending || comparator === descending ? comparator : zero) as unknown as (a: unknown, b: unknown) => number
    compare2 = comparator
    delta = comparator
  }
  function left(a: readonly T[], x: U, lo = 0, hi = a.length): number {
    if (lo < hi) {
      if (compare1(x, x) !== 0) return hi
      do {
        const mid = (lo + hi) >>> 1
        if (compare2(a[mid]!, x) < 0) lo = mid + 1
        else hi = mid
      } while (lo < hi)
    }
    return lo
  }
  function right(a: readonly T[], x: U, lo = 0, hi = a.length): number {
    if (lo < hi) {
      if (compare1(x, x) !== 0) return hi
      do {
        const mid = (lo + hi) >>> 1
        if (compare2(a[mid]!, x) <= 0) lo = mid + 1
        else hi = mid
      } while (lo < hi)
    }
    return lo
  }
  function center(a: readonly T[], x: U, lo = 0, hi = a.length): number {
    const i = left(a, x, lo, hi - 1)
    return i > lo && delta(a[i - 1]!, x) > -delta(a[i]!, x) ? i - 1 : i
  }
  return { left, center, right }
}

const ascendingBisect = bisector(ascending) as unknown as Bisector<number, number>
export const bisectRight = ascendingBisect.right
export const bisectLeft = ascendingBisect.left
export const bisect = bisectRight
export const bisectCenter = bisector((d: number) => d).center

const e10 = Math.sqrt(50)
const e5 = Math.sqrt(10)
const e2 = Math.sqrt(2)

function tickSpec(start: number, stop: number, count: number): [number, number, number] {
  const step = (stop - start) / Math.max(0, count)
  const power = Math.floor(Math.log10(step))
  const error = step / Math.pow(10, power)
  const factor = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1
  let i1: number, i2: number, inc: number
  if (power < 0) {
    inc = Math.pow(10, -power) / factor
    i1 = Math.round(start * inc)
    i2 = Math.round(stop * inc)
    if ((i1 / inc) < start) ++i1
    if ((i2 / inc) > stop) --i2
    inc = -inc
  } else {
    inc = Math.pow(10, power) * factor
    i1 = Math.round(start / inc)
    i2 = Math.round(stop / inc)
    if (i1 * inc < start) ++i1
    if (i2 * inc > stop) --i2
  }
  if (i2 < i1 && 0.5 <= count && count < 2) return tickSpec(start, stop, count * 2)
  return [i1, i2, inc]
}

export function ticks(start: number, stop: number, count: number): number[] {
  stop = +stop, start = +start, count = +count
  if (!(count > 0)) return []
  if (start === stop) return [start]
  const reverse = stop < start
  const [i1, i2, inc] = reverse ? tickSpec(stop, start, count) : tickSpec(start, stop, count)
  if (!(i2 >= i1)) return []
  const n = i2 - i1 + 1
  const out = new Array<number>(n)
  if (reverse) {
    if (inc < 0) for (let i = 0; i < n; ++i) out[i] = (i2 - i) / -inc
    else for (let i = 0; i < n; ++i) out[i] = (i2 - i) * inc
  } else {
    if (inc < 0) for (let i = 0; i < n; ++i) out[i] = (i1 + i) / -inc
    else for (let i = 0; i < n; ++i) out[i] = (i1 + i) * inc
  }
  return out
}

export function tickIncrement(start: number, stop: number, count: number): number {
  stop = +stop, start = +start, count = +count
  return tickSpec(start, stop, count)[2]
}

export function tickStep(start: number, stop: number, count: number): number {
  stop = +stop, start = +start, count = +count
  const reverse = stop < start
  const inc = reverse ? tickIncrement(stop, start, count) : tickIncrement(start, stop, count)
  return (reverse ? -1 : 1) * (inc < 0 ? 1 / -inc : inc)
}

function min(values: ArrayLike<number>): number {
  let m = values[0]!
  for (let j = 0; j < values.length; ++j) {
    const v = values[j]!
    if (v < m || (m !== m && v !== v)) m = v
  }
  return m
}

function max(values: ArrayLike<number>): number {
  let m = values[0]!
  for (let j = 0; j < values.length; ++j) {
    const v = values[j]!
    if (v > m || (m !== m && v !== v)) m = v
  }
  return m
}

function numbers(values: Iterable<unknown>, valueof?: (d: unknown, i: number) => unknown): Float64Array {
  const out: number[] = []
  if (valueof == null) {
    for (const raw of values) {
      const v = +(raw as number)
      if (v >= v) out.push(v)
    }
  } else {
    let i = -1
    for (const raw of values) {
      const v = +(valueof(raw, ++i) as number)
      if (v >= v) out.push(v)
    }
  }
  return Float64Array.from(out)
}

function ascendingDefined(a: number, b: number): number {
  return Number(isNaN(a)) - Number(isNaN(b)) || (a < b ? -1 : a > b ? 1 : 0)
}

function compareDefined(compare: (a: number, b: number) => number) {
  return function (a: number, b: number): number {
    return ascendingDefined(a, b) || (compare(a, b), 0)
  }
}

// Based on https://github.com/mourner/quickselect (ISC, Vladimir Agafonkin).
function quickselect(array: Float64Array, k: number, left = 0, right = Infinity, compare?: (a: number, b: number) => number): Float64Array {
  k = Math.floor(k)
  left = Math.floor(Math.max(0, left))
  right = Math.floor(Math.min(array.length - 1, right))
  if (!(left <= k && k <= right)) return array
  const cmp = compare === undefined ? ascendingDefined : compareDefined(compare)
  while (right > left) {
    if (right - left > 600) {
      const n = right - left + 1
      const m = k - left + 1
      const z = Math.log(n)
      const s = 0.5 * Math.exp(2 * z / 3)
      const sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1)
      const newLeft = Math.max(left, Math.floor(k - m * s / n + sd))
      const newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd))
      quickselect(array, k, newLeft, newRight, cmp)
    }
    const t = array[k]!
    let i = left
    let j = right
    swap(array, left, k)
    if (cmp(array[right]!, t) > 0) swap(array, left, right)
    while (i < j) {
      swap(array, i, j), ++i, --j
      while (cmp(array[i]!, t) < 0) ++i
      while (cmp(array[j]!, t) > 0) --j
    }
    if (cmp(array[left]!, t) === 0) swap(array, left, j)
    else ++j, swap(array, j, right)
    if (j <= k) left = j + 1
    if (k <= j) right = j - 1
  }
  return array
}

function swap(array: Float64Array, i: number, j: number): void {
  const t = array[i]!
  array[i] = array[j]!
  array[j] = t
}

export function quantile(values: readonly number[], p: number, valueof?: (d: unknown, i: number) => unknown): number | undefined {
  const arr = Float64Array.from(numbers(values, valueof))
  const n = arr.length
  if (!n || isNaN((p = +p))) return undefined
  if (p <= 0 || n < 2) return min(arr)
  if (p >= 1) return max(arr)
  const i = (n - 1) * p
  const i0 = Math.floor(i)
  const value0 = max(quickselect(arr, i0).subarray(0, i0 + 1))
  const value1 = min(arr.subarray(i0 + 1))
  return value0 + (value1 - value0) * (i - i0)
}

export function quantileSorted<V>(values: readonly V[], p: number, valueof: (d: V, i: number, a: readonly V[]) => number = (d) => d as unknown as number): number | undefined {
  const n = values.length
  if (!n || isNaN((p = +p))) return undefined
  if (p <= 0 || n < 2) return +valueof(values[0]!, 0, values)
  if (p >= 1) return +valueof(values[n - 1]!, n - 1, values)
  const i = (n - 1) * p
  const i0 = Math.floor(i)
  const value0 = +valueof(values[i0]!, i0, values)
  const value1 = +valueof(values[i0 + 1]!, i0 + 1, values)
  return value0 + (value1 - value0) * (i - i0)
}

// ---- internmap (2.0.3) ------------------------------------------------------

function keyof(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? (value as { valueOf(): unknown }).valueOf() : value
}

function internGet(intern: Map<unknown, unknown>, value: unknown): unknown {
  const key = keyof(value)
  return intern.has(key) ? intern.get(key) : value
}

function internSet(intern: Map<unknown, unknown>, value: unknown): unknown {
  const key = keyof(value)
  if (intern.has(key)) return intern.get(key)
  intern.set(key, value)
  return value
}

function internDelete(intern: Map<unknown, unknown>, value: unknown): unknown {
  const key = keyof(value)
  if (intern.has(key)) {
    value = intern.get(key)
    intern.delete(key)
  }
  return value
}

/**
 * A Map that interns object keys by their valueOf, so equivalent objects
 * (e.g. two Date instances for the same instant) share one key.
 */
export class InternMap<K, V> extends Map<K, V> {
  private readonly _intern!: Map<unknown, unknown>
  constructor(entries?: Iterable<[K, V]>) {
    super()
    Object.defineProperty(this, '_intern', { value: new Map() })
    if (entries != null) for (const [key, value] of entries) this.set(key, value)
  }
  override get(key: K): V | undefined {
    return super.get(internGet(this._intern, key) as K)
  }
  override has(key: K): boolean {
    return super.has(internGet(this._intern, key) as K)
  }
  override set(key: K, value: V): this {
    return super.set(internSet(this._intern, key) as K, value)
  }
  override delete(key: K): boolean {
    return super.delete(internDelete(this._intern, key) as K)
  }
}
