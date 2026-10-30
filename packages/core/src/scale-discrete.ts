/**
 * The scales over categories and bins: ordinal (a list of categories onto a list of values), band and point (categories
 * onto evenly spaced positions along a range), bin-ordinal (a number to the bin it falls in, then to a value), and the
 * discretizing quantile, quantize and threshold scales, which cut a continuous domain into classes. `sequentialQuantile`
 * is the quantile scale's cousin for colour ramps.
 *
 * What the callers observe, and so what is fixed here:
 * - categories are identified by value: two Dates of one instant are one category, a number and its string are two;
 * - an ordinal scale that has not been told what an unknown category maps to adds it to its domain on first sight (the
 *   `implicit` setting), so the domain read back after drawing lists every category drawn;
 * - a band scale divides its range into `n` steps of `(range) / (n - padding_inner + 2 * padding_outer)` with the leftover
 *   shifted by `align`, rounding the step, the start and the band to whole units when asked, and a reversed range lists
 *   the same bands from the far end;
 * - a threshold or quantize scale answers with the class a value falls in by binary search, `undefined` for the missing;
 * - `quantize.unknown()` called with no argument returns the scale itself, not the value: the pinned oracle does, and a
 *   caller that reads it back sees a function.
 */
import { ascending, bisectRight, InternMap, quantile, quantileSorted, range as sequence } from './arr.js'
import { accessor, firstTwo, tickFormatFor, withLinearAxis, type ScaleObject } from './scale-continuous.js'
import { sortData } from './util.js'

export const implicit = Symbol('implicit')

// ---- categories --------------------------------------------------------------------------------------------

/** The ordered categories of a scale, the position of each, and the values they map to. */
class Lexicon {
  names: unknown[] = []
  positions = new InternMap<unknown, number>()
  values: unknown[] = []
  fallback: unknown

  constructor(fallback: unknown) {
    this.fallback = fallback
  }

  /** The value of a category; an unseen one is the fallback, or (when the fallback is `implicit`) joins the domain. */
  at(key: unknown): unknown {
    let position = this.positions.get(key)
    if (position === undefined) {
      if (this.fallback !== implicit) return this.fallback
      this.positions.set(key, (position = this.names.push(key) - 1))
    }
    return this.values[position % this.values.length]
  }

  // (the parameter is called `_` because the engine's message for a value that is not iterable quotes the name it was given)
  setNames(_: Iterable<unknown>): void {
    this.names = []
    this.positions = new InternMap()
    for (const key of _) {
      if (this.positions.has(key)) continue
      this.positions.set(key, this.names.push(key) - 1)
    }
  }
}

export function ordinal(): ScaleObject {
  const lexicon = new Lexicon(implicit)
  const scale = ((key: unknown) => lexicon.at(key)) as ScaleObject
  scale.domain = accessor(scale, () => lexicon.names.slice(), (v: Iterable<unknown>) => lexicon.setNames(v))
  scale.range = accessor(scale, () => lexicon.values.slice(), (v: Iterable<unknown>) => void (lexicon.values = Array.from(v)))
  scale.unknown = accessor(scale, () => lexicon.fallback, (v: unknown) => void (lexicon.fallback = v))
  scale.copy = () => ordinal().domain(lexicon.names).range(lexicon.values).unknown(lexicon.fallback)
  return scale
}

// ---- bands and points --------------------------------------------------------------------------------------

/** The number of steps a band layout divides its range into (zero for no categories; never below one otherwise). */
export function bandSpace(count: number, paddingInner: number, paddingOuter: number): number {
  const space = count - paddingInner + paddingOuter * 2
  return count ? (space > 0 ? space : 1) : 0
}

const unitClamp = (v: number): number => Math.max(0, Math.min(1, v))

/**
 * Bands (a point scale is a band scale whose inner padding is fixed at one and whose single `padding` is the outer).
 * The positions of the bands are recomputed whenever the domain, the range or a padding changes.
 */
function bands(point: boolean): ScaleObject {
  const lexicon = new Lexicon(undefined)
  const scale = ((key: unknown) => lexicon.at(key)) as ScaleObject
  let extent: [number, number] = [0, 1]
  let step = 0
  let bandwidth = 0
  let round = false
  let paddingInner = point ? 1 : 0
  let paddingOuter = 0
  let align = 0.5

  const reversed = (): boolean => extent[1] < extent[0]

  const layout = (): void => {
    const n = lexicon.names.length
    const flip = reversed()
    const stop = extent[flip ? 0 : 1]
    let start = extent[flip ? 1 : 0]
    step = (stop - start) / (bandSpace(n, paddingInner, paddingOuter) || 1)
    if (round) step = Math.floor(step)
    start += (stop - start - step * (n - paddingInner)) * align
    bandwidth = step * (1 - paddingInner)
    if (round) {
      start = Math.round(start)
      bandwidth = Math.round(bandwidth)
    }
    const starts = sequence(n).map((i) => start + step * i)
    lexicon.values = flip ? starts.reverse() : starts
  }
  const tuned = <T>(read: () => T, write: (v: T) => void) =>
    accessor(scale, read, (v: T) => {
      write(v)
      layout()
    })

  scale.domain = tuned(() => lexicon.names.slice(), (v: Iterable<unknown>) => lexicon.setNames(v))
  scale.range = tuned(() => extent.slice(), (v: ArrayLike<unknown>) => void (extent = [+(v[0] as number), +(v[1] as number)]))
  scale.rangeRound = (...v: [ArrayLike<unknown>]) => {
    extent = [+(v[0][0] as number), +(v[0][1] as number)]
    round = true
    layout()
    return scale
  }
  scale.bandwidth = () => bandwidth
  scale.step = () => step
  scale.round = tuned(() => round, (v: unknown) => void (round = !!v))
  scale.align = tuned(() => align, (v: number) => void (align = unitClamp(v)))
  scale.paddingOuter = tuned(() => paddingOuter, (v: number) => void (paddingOuter = unitClamp(v)))
  if (point) {
    scale.padding = scale.paddingOuter
  } else {
    scale.paddingInner = tuned(() => paddingInner, (v: number) => void (paddingInner = unitClamp(v)))
    scale.padding = tuned(() => paddingInner, (v: number) => void (paddingOuter = paddingInner = unitClamp(v)))
  }

  /** The categories whose bands the span [a, b] of the range touches; undefined when it touches none. */
  scale.invertRange = (span: ArrayLike<unknown>) => {
    if (span[0] == null || span[1] == null) return undefined
    const flip = reversed()
    const starts = lexicon.values.slice() as number[]
    if (flip) starts.reverse()
    const last = starts.length - 1
    let lo = +(span[0] as number)
    let hi = +(span[1] as number)
    if (lo !== lo || hi !== hi) return undefined
    if (hi < lo) [lo, hi] = [hi, lo]
    if (hi < starts[0]! || lo > extent[flip ? 0 : 1]) return undefined
    let first = Math.max(0, bisectRight(starts, lo) - 1)
    let end = lo === hi ? first : bisectRight(starts, hi) - 1
    // a start inside the gap after a band belongs to the next one
    if (lo - starts[first]! > bandwidth + 1e-10) ++first
    if (flip) [first, end] = [last - end, last - first]
    return first > end ? undefined : lexicon.names.slice(first, end + 1)
  }
  scale.invert = (position: unknown) => {
    const hit = scale.invertRange([position, position])
    return hit ? hit[0] : hit
  }
  scale.copy = () => {
    const twin = bands(point)
    twin.domain(lexicon.names).range(extent).round(round).paddingOuter(paddingOuter).align(align)
    if (!point) twin.paddingInner(paddingInner)
    return twin
  }
  layout()
  return scale
}

export const band = (): ScaleObject => bands(false)
export const point = (): ScaleObject => bands(true)

// ---- numbers to bins ---------------------------------------------------------------------------------------

/** Bin boundaries in the domain, and a value for each bin (cycled when there are more bins than values). */
export function binOrdinal(): ScaleObject {
  let boundaries: number[] = []
  let values: unknown[] = []
  const scale = ((x: unknown) => (x == null || x !== x ? undefined : values[(bisectRight(boundaries, x as number) - 1) % values.length])) as ScaleObject
  scale.domain = accessor(scale, () => boundaries.slice(), (v: Iterable<unknown>) => void (boundaries = Array.prototype.map.call(v, (d) => (d == null || d === '' ? null : +d)) as number[]))
  scale.range = accessor(scale, () => values.slice(), (v: Iterable<unknown>) => void (values = Array.prototype.slice.call(v)))
  scale.tickFormat = (count?: number, specifier?: string) =>
    tickFormatFor(boundaries[0]!, boundaries[boundaries.length - 1]!, count == null ? 10 : count, specifier)
  scale.copy = () => binOrdinal().domain(scale.domain()).range(scale.range())
  return scale
}

// ---- continuous domains cut into classes -------------------------------------------------------------------

/** The sorted numeric domain of a column: what is missing or not a number is dropped, the rest coerced with `+`. */
function sortedNumbers(_: Iterable<unknown>): number[] {
  const kept: number[] = []
  for (const raw of _) {
    const d = +(raw as number)
    if (raw != null && !isNaN(d)) kept.push(d)
  }
  return sortData(kept, ascending)
}

/** `bounds[i]` is the upper limit of class i; the class of x is how many limits lie at or below it. */
const classOf = (bounds: unknown[], x: unknown, limit: number): number => bisectRight(bounds as number[], x as number, 0, limit)

/** Equal-width classes between two ends of the domain. */
export function quantize(): ScaleObject {
  let low = 0
  let high = 1
  let classes = 1
  let limits: number[] = [0.5]
  let values: unknown[] = [0, 1]
  let fallback: unknown
  const cut = (): void => {
    limits = new Array(classes)
    for (let i = 0; i < classes; i++) limits[i] = ((i + 1) * high - (i - classes) * low) / (classes + 1)
  }
  const scale = ((x: unknown) => (x != null && (x as number) <= (x as number) ? values[classOf(limits, x, classes)] : fallback)) as ScaleObject
  scale.domain = accessor(scale, () => [low, high], (v: Iterable<unknown>) => {
    const [a, b] = firstTwo(v)
    low = +(a as number)
    high = +(b as number)
    cut()
  })
  scale.range = accessor(scale, () => values.slice(), (v: Iterable<unknown>) => {
    classes = (values = Array.from(v)).length - 1
    cut()
  })
  scale.invertExtent = (y: unknown) => {
    const i = values.indexOf(y)
    return i < 0 ? [NaN, NaN] : i < 1 ? [low, limits[0]] : i >= classes ? [limits[classes - 1], high] : [limits[i - 1], limits[i]]
  }
  scale.unknown = (...v: [unknown?]) => (v.length ? ((fallback = v[0]), scale) : scale)
  scale.thresholds = () => limits.slice()
  scale.copy = () => quantize().domain([low, high]).range(values).unknown(fallback)
  return withLinearAxis(scale)
}

/** Classes cut at explicit limits. */
export function threshold(): ScaleObject {
  let limits: unknown[] = [0.5]
  let values: unknown[] = [0, 1]
  let fallback: unknown
  let usable = 1
  const resize = (): void => void (usable = Math.min(limits.length, values.length - 1))
  const scale = ((x: unknown) => (x != null && (x as number) <= (x as number) ? values[classOf(limits, x, usable)] : fallback)) as ScaleObject
  scale.domain = accessor(scale, () => limits.slice(), (v: Iterable<unknown>) => {
    limits = Array.from(v)
    resize()
  })
  scale.range = accessor(scale, () => values.slice(), (v: Iterable<unknown>) => {
    values = Array.from(v)
    resize()
  })
  scale.invertExtent = (y: unknown) => {
    const i = values.indexOf(y)
    return [limits[i - 1], limits[i]]
  }
  scale.unknown = accessor(scale, () => fallback, (v: unknown) => void (fallback = v))
  scale.copy = () => threshold().domain(limits).range(values).unknown(fallback)
  return scale
}

/** Classes holding equal shares of the data: the limits are the quantiles of the (sorted) domain. */
export function quantileScale(): ScaleObject {
  let sorted: number[] = []
  let values: unknown[] = []
  let limits: number[] = []
  let fallback: unknown
  const cut = (): void => {
    const classes = Math.max(1, values.length)
    limits = new Array(classes - 1)
    for (let i = 1; i < classes; i++) limits[i - 1] = quantileSorted(sorted, i / classes)!
  }
  const scale = ((x: unknown) => (x == null || isNaN((x = +(x as number))) ? fallback : values[bisectRight(limits, x as number)])) as ScaleObject
  scale.domain = accessor(scale, () => sorted.slice(), (v: Iterable<unknown>) => {
    sorted = sortedNumbers(v)
    cut()
  })
  scale.range = accessor(scale, () => values.slice(), (v: Iterable<unknown>) => {
    values = Array.from(v)
    cut()
  })
  scale.invertExtent = (y: unknown) => {
    const i = values.indexOf(y)
    return i < 0 ? [NaN, NaN] : [i > 0 ? limits[i - 1] : sorted[0], i < limits.length ? limits[i] : sorted[sorted.length - 1]]
  }
  scale.unknown = accessor(scale, () => fallback, (v: unknown) => void (fallback = v))
  scale.quantiles = () => limits.slice()
  scale.copy = () => quantileScale().domain(sorted).range(values).unknown(fallback)
  return scale
}

/** A colour ramp stepped by the rank of the value in the (sorted) domain. */
export function sequentialQuantile(ramp?: (t: number) => unknown): ScaleObject {
  let sorted: number[] = []
  let current = ramp ?? ((t: number) => t as unknown)
  const scale = ((x: unknown) => {
    if (x != null && !isNaN(+(x as number))) return current((bisectRight(sorted, x as number, 1) - 1) / (sorted.length - 1))
    return undefined
  }) as ScaleObject
  scale.domain = accessor(scale, () => sorted.slice(), (v: Iterable<unknown>) => void (sorted = sortedNumbers(v)))
  scale.interpolator = accessor(scale, () => current, (v: (t: number) => unknown) => void (current = v))
  scale.range = () => sorted.map((_, i) => current(i / (sorted.length - 1)))
  scale.quantiles = (n: number) => Array.from({ length: n + 1 }, (_, i) => quantile(sorted, i / n)!)
  scale.copy = () => sequentialQuantile(current).domain(sorted)
  return scale
}

