/**
 * The scales that cut numbers into classes: bin-ordinal (a number to the bin it falls in, then to a value), and the discretizing
 * quantile, quantize and threshold scales (`sequentialQuantile` is the quantile scale's cousin for colour ramps). The engine's
 * `scales` part (engine-parts.ts) with the warped kinds of scale-warped.ts; what is fixed by the output is said in scale-discrete.ts.
 */
import { ascending, bisectRight, quantile, quantileSorted } from './arr.js'
import { accessor, firstTwo, tickFormatFor, withLinearAxis, type ScaleObject } from './scale-continuous.js'
import { sortMetered } from './limits.js'

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
  return sortMetered(kept, ascending, 'scale domain')
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

