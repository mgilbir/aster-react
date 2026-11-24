/**
 * Scales as the chart engine uses them: the registry of scale types (name, kind, inverse members), the choice of ticks and
 * labels for an axis or legend, interpolators by name, colour schemes and gradient stops. The constructors live in
 * `scale-continuous.ts` (linear), `scale-warped.ts` (identity, pow, sqrt, log, symlog, sequential, diverging), `scale-calendar.ts`
 * (time, UTC), `scale-discrete.ts` (ordinal, band, point) and `scale-classes.ts` (bin-ordinal, quantize, threshold, quantile).
 *
 * What callers observe, and so what is fixed here:
 * - a constructed scale has its `type` set to the registered name (`sequential` keeps that name), carries a mark that says the
 *   registry made it, and has an `invertRange` member (undefined for scales with no inverse); a copy made with `scaleCopy`
 *   keeps its type but neither the mark nor `invertRange`; `identity` is registered with no kind; unregistered names are not
 *   types, whatever the prototype chain of a table holds;
 * - a tick count may be a number, an interval name (time and UTC scales only: anything else is an error) or `{interval, step}`;
 *   a scale with bins takes its ticks from the bins in range, thinned by halving until they fit the count; a minimum step
 *   shrinks the count until ticks are at least that far apart; a log scale labels only the ticks on a leading digit that fits;
 * - a symbol legend over a discretizing or binned scale labels each class by its two limits ("a - b", "< b", ">= a"), the first
 *   value of a discrete legend gets no label, quantile and quantize scales write all labels at one precision taken from the
 *   smallest gap, and a threshold scale's gradient is padded by one step on each side;
 * - an interpolator is looked up by its name with each dash-separated word capitalised (`rgb-basis-closed`), an unknown name is
 *   undefined, a gamma applies only to rgb and cubehelix; scheme names are lower-cased and looked up only among the registered.
 */
import { peek, tickStep } from './arr.js'
import { allot } from './limits.js'
import {
  interpolateArray,
  interpolateBasis,
  interpolateBasisClosed,
  interpolateDate,
  interpolateDiscrete,
  interpolateHue,
  interpolateNumber,
  interpolateNumberArray,
  interpolateObject,
  interpolateRound,
  interpolateString,
  interpolateZoom,
  piecewise,
} from './interp.js'
import type { Locale } from './locale.js'
import { linear, type ScaleObject } from './scale-continuous.js'
import { band, ordinal, point } from './scale-discrete.js'
import { discretePalettes } from './scale-schemes.js'
import type { TimeInterval } from './time.js'
import { part, type EngineParts } from './engine-parts.js'
import { error, isNumber, isObject, isString } from './util.js'

export { bandSpace } from './scale-discrete.js'

/**
 * The type hosts see for a scale. It is deliberately loose: a host keeps scales in untyped maps next to marks and
 * signals, and a scale's members differ by type (a band scale has `bandwidth`, a log scale `base`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Scale = any

// ---- names -------------------------------------------------------------------------------------------------

export const Identity = 'identity'
export const Linear = 'linear'
export const Log = 'log'
export const Pow = 'pow'
export const Sqrt = 'sqrt'
export const Symlog = 'symlog'
export const Time = 'time'
export const UTC = 'utc'
export const Sequential = 'sequential'
export const Diverging = 'diverging'
export const Quantile = 'quantile'
export const Quantize = 'quantize'
export const Threshold = 'threshold'
export const Ordinal = 'ordinal'
export const Point = 'point'
export const Band = 'band'
export const BinOrdinal = 'bin-ordinal'

/** The kinds a scale type can be. */
export const Continuous = 'continuous'
export const Discrete = 'discrete'
export const Discretizing = 'discretizing'
export const Interpolating = 'interpolating'
export const Temporal = 'temporal'

// ---- inverse members ---------------------------------------------------------------------------------------

/** `invertRange` of a scale with `invert`: the domain values at the two ends of a span of the range. */
function invertingSpan(scale: Scale): (span: ArrayLike<number>) => unknown[] {
  return (span) => {
    const a = span[0]!
    const b = span[1]!
    return b < a ? [scale.invert(b), scale.invert(a)] : [scale.invert(a), scale.invert(b)]
  }
}

/** `invertRange` of a scale with only `invertExtent`: the outer extremes of the classes whose value lies in the span. */
function invertingExtents(scale: Scale): (span: ArrayLike<number>) => unknown[] | undefined {
  return (span) => {
    const a = span[0]!
    const b = span[1]!
    const [lo, hi] = b < a ? [b, a] : [a, b]
    const values = scale.range() as number[]
    let first = -1
    let last = -1
    values.forEach((v, i) => {
      if (v >= lo && v <= hi) {
        if (first < 0) first = i
        last = i
      }
    })
    if (first < 0) return undefined
    const head = scale.invertExtent(values[first])
    const tail = scale.invertExtent(values[last])
    return [head[0] === undefined ? head[1] : head[0], tail[1] === undefined ? tail[0] : tail[1]]
  }
}

// ---- the registry ------------------------------------------------------------------------------------------

const MADE_HERE = Symbol('aster.scale')

/** Mark a scale as made by the registry. */
export function registerScale(scale: Scale): Scale {
  ;(scale as Record<symbol, unknown>)[MADE_HERE] = true
  return scale
}

/** Whether a scale was made by the registry. */
export function isRegisteredScale(scale: Scale): boolean {
  return !!scale && (scale as Record<symbol, unknown>)[MADE_HERE] === true
}

export interface ScaleCtor {
  (): Scale
  /** The kinds of the type, as an object of `kind: true` (empty for `identity`). */
  metadata: Record<string, boolean>
}

const registry = new Map<string, ScaleCtor>()

function register(type: string, make: () => ScaleObject, ...kinds: string[]): void {
  const ctor = (() => {
    const scale = make()
    if (!scale.invertRange) {
      scale.invertRange = scale.invert ? invertingSpan(scale) : scale.invertExtent ? invertingExtents(scale) : undefined
    }
    scale.type = type
    return registerScale(scale)
  }) as ScaleCtor
  ctor.metadata = Object.fromEntries(kinds.map((kind) => [kind, true]))
  registry.set(type, ctor)
}

const NUMERIC = [Continuous, Interpolating]
/** A constructor of the engine's `scales` part (scale-warped.ts, scale-classes.ts: engine-parts.ts), read when a spec makes one. */
const rare = (name: keyof EngineParts['scales']) => (): ScaleObject => part('scales')[name]()
register(Identity, rare('identityScale'))
register(Linear, linear, Continuous)
register(Log, rare('log'), Continuous, Log)
register(Pow, rare('pow'), Continuous)
register(Sqrt, rare('sqrt'), Continuous)
register(Symlog, rare('symlog'), Continuous)
// (the calendar scales are the engine's time part, read when a spec makes one)
register(Time, () => part('time').time(), Continuous, Temporal)
register(UTC, () => part('time').utcTime(), Continuous, Temporal)
register(Sequential, rare('sequential'), ...NUMERIC) // the name before sequential scales had a warp
register(`${Sequential}-${Linear}`, rare('sequential'), ...NUMERIC)
register(`${Sequential}-${Log}`, rare('sequentialLog'), ...NUMERIC, Log)
register(`${Sequential}-${Pow}`, rare('sequentialPow'), ...NUMERIC)
register(`${Sequential}-${Sqrt}`, rare('sequentialSqrt'), ...NUMERIC)
register(`${Sequential}-${Symlog}`, rare('sequentialSymlog'), ...NUMERIC)
register(`${Diverging}-${Linear}`, rare('diverging'), ...NUMERIC)
register(`${Diverging}-${Log}`, rare('divergingLog'), ...NUMERIC, Log)
register(`${Diverging}-${Pow}`, rare('divergingPow'), ...NUMERIC)
register(`${Diverging}-${Sqrt}`, rare('divergingSqrt'), ...NUMERIC)
register(`${Diverging}-${Symlog}`, rare('divergingSymlog'), ...NUMERIC)
register(Quantile, rare('quantileScale'), Discretizing, Quantile)
register(Quantize, rare('quantize'), Discretizing)
register(Threshold, rare('threshold'), Discretizing)
register(BinOrdinal, rare('binOrdinal'), Discrete, Discretizing)
register(Ordinal, ordinal, Discrete)
register(Band, band, Discrete)
register(Point, point, Discrete)

/** The constructor registered for a type name, if there is one. */
export function scale(type: string): ScaleCtor | undefined {
  return registry.get(type)
}

/** @public (the scale-helpers differential reads it by name) */
export function isValidScaleType(type: string): boolean {
  return registry.has(type)
}

const hasKind = (type: string, kind: string): boolean => registry.get(type)?.metadata[kind] === true

export const isContinuous = (type: string): boolean => hasKind(type, Continuous)
export const isDiscrete = (type: string): boolean => hasKind(type, Discrete)
export const isDiscretizing = (type: string): boolean => hasKind(type, Discretizing)
export const isLogarithmic = (type: string): boolean => hasKind(type, Log)
export const isTemporal = (type: string): boolean => hasKind(type, Temporal)
export const isInterpolating = (type: string): boolean => hasKind(type, Interpolating)
export const isQuantile = (type: string): boolean => hasKind(type, Quantile)

/** A copy of a scale of the same type (the copy is a bare scale: it keeps no registry mark and no `invertRange`). */
/** @public (the scale-helpers differential reads it by name) */
export function scaleCopy(source: Scale): Scale {
  const copy = source.copy()
  copy.type = source.type
  return copy
}

// ---- ticks -------------------------------------------------------------------------------------------------------

/**
 * The tick count or interval for a scale: `count` as given, raised to the number of bins, lowered so that ticks are at
 * least `minStep` apart, and an interval name or object resolved to a time interval.
 */
export function tickCount(scale: Scale, count: unknown, minStep?: number): unknown {
  let step: unknown
  if (isNumber(count)) {
    let wanted = count as number
    if (scale.bins) wanted = Math.max(wanted, scale.bins.length)
    if (minStep != null) {
      const domain = scale.domain() as number[]
      const lo = Math.min(domain[0]!, peek(domain))
      const hi = Math.max(domain[0]!, peek(domain))
      wanted = Math.min(wanted, Math.floor((hi - lo) / minStep || 1) + 1)
      if (!scale.bins && !isLogarithmic(scale.type) && !isTemporal(scale.type) && lo < hi) {
        // a tick step only grows as the count falls: the largest count that spaces them enough, found by halving the counts between
        // 1 and `wanted` (what counting down one at a time finds, in a number of steps that does not grow with the spec's count)
        if (wanted > 1 && tickStep(lo, hi, wanted) < minStep) {
          let fits = 1
          let short = wanted
          while (short - fits > 1) {
            const mid = Math.floor((fits + short) / 2)
            if (tickStep(lo, hi, mid) < minStep) short = mid
            else fits = mid
          }
          wanted = fits
        }
      }
    }
    count = wanted
  }
  if (isObject(count)) {
    step = (count as { step?: unknown }).step
    count = (count as { interval?: unknown }).interval
  }
  if (isString(count)) {
    count =
      scale.type === Time
        ? part('time').timeIntervalFor(count as string)!
        : scale.type === UTC
          ? part('time').utcIntervalFor(count as string)!
          : error('Only time and utc scales accept interval strings.')
    if (step) count = (count as TimeInterval).every!(step as number)
  }
  return count
}

/** The candidate ticks that map inside the scale's range (to whole pixels), in range order, thinned to fit `count`. */
export function validTicks(scale: Scale, candidates: unknown[], count: number): unknown[] {
  const range = scale.range() as number[]
  const reversed = range[0]! > peek(range)
  const lo = Math.floor(reversed ? peek(range) : range[0]!)
  const hi = Math.ceil(reversed ? range[0]! : peek(range))
  const byPosition = reversed ? (a: [unknown, unknown], b: [unknown, unknown]) => (b[1] as number) - (a[1] as number) : (a: [unknown, unknown], b: [unknown, unknown]) => (a[1] as number) - (b[1] as number)
  let ticks = candidates
    .map((v) => [v, scale(v)] as [unknown, unknown])
    .filter((p) => lo <= (p[1] as number) && (p[1] as number) <= hi)
    .sort(byPosition)
    .map((p) => p[0])
  if (count > 0 && ticks.length > 1) {
    const ends = [ticks[0], peek(ticks)]
    while (ticks.length > count && ticks.length >= 3) ticks = ticks.filter((_, i) => !(i % 2))
    if (ticks.length < 3) ticks = ends
  }
  return ticks
}

/** The values to put ticks at: the bins in range, else the scale's own ticks, else (for scales without ticks) its domain. */
export function tickValues(scale: Scale, count?: unknown): unknown[] {
  return scale.bins ? validTicks(scale, scale.bins, count as number) : scale.ticks ? scale.ticks(count) : scale.domain()
}

const stringify = (value: unknown): unknown => (Array.isArray(value) ? value.map((v) => String(v)) : String(value))

/** The ticks of a log scale that carry a label (or the test for one): a leading digit small enough for the room. */
export function logTicks(scale: Scale, count: unknown, valuesOnly: boolean): number[] | ((d: number) => boolean) {
  const ticks = tickValues(scale, count) as number[]
  const base = scale.base()
  const lnBase = Math.log(base)
  const room = Math.max(1, (base * (count as number)) / ticks.length)
  const fits = (d: number): boolean => {
    let lead = d / Math.pow(base, Math.round(Math.log(d) / lnBase))
    if (lead * base < base - 0.5) lead *= base
    return lead <= room
  }
  return valuesOnly ? ticks.filter(fits) : fits
}

/**
 * A formatter for a scale's tick values: a time format on time scales (or when `formatType` says so), a thinning
 * number format on log scales, a span-aware number format on other continuous scales, else plain text.
 */
export function tickFormat(
  locale: Locale,
  scale: Scale,
  count?: unknown,
  specifier?: unknown,
  formatType?: string,
  noSkip?: boolean,
): (v: unknown) => string {
  const type = scale.type
  if (type === Time || formatType === Time) return locale.timeFormat(specifier as string) as unknown as (v: unknown) => string
  if (type === UTC || formatType === UTC) return locale.utcFormat(specifier as string) as unknown as (v: unknown) => string
  if (isLogarithmic(type)) {
    const write = locale.formatFloat(specifier) as unknown as (v: number) => string
    if (noSkip || scale.bins) return write as unknown as (v: unknown) => string
    const labelled = logTicks(scale, count, false) as (d: number) => boolean
    return (v) => (labelled(v as number) ? write(v as number) : '')
  }
  if (scale.tickFormat) {
    const d = scale.domain() as number[]
    return locale.formatSpan(d[0]!, peek(d), count as number, specifier) as unknown as (v: unknown) => string
  }
  if (specifier) return locale.format(specifier) as unknown as (v: unknown) => string
  return stringify as (v: unknown) => string
}

// ---- legend labels -----------------------------------------------------------------------------------------------

export const SymbolLegend = 'symbol'
export const DiscreteLegend = 'discrete'
export const GradientLegend = 'gradient'

/** The scale member that lists a discretizing scale's limits, by type. */
const LIMITS_OF: Record<string, string> = { [Quantile]: 'quantiles', [Quantize]: 'thresholds', [Threshold]: 'domain' }
/** The scale member whose values set the label precision. */
const PRECISION_FROM: Record<string, string> = { [Quantile]: 'quantiles', [Quantize]: 'domain' }

/** The values a legend labels; `max` is the upper end of the last class of a discretizing scale. */
export type LabelValues = unknown[] & { max?: number }

/** The values a legend labels for a scale: bins, log ticks, a discretizing scale's limits, else its ticks. */
export function labelValues(scale: Scale, count: unknown): LabelValues {
  if (scale.bins) {
    const bins: LabelValues = scale.bins.slice(0, -1)
    bins.max = peek(scale.bins as number[])
    return bins
  }
  if (scale.type === Log) return logTicks(scale, count, true) as LabelValues
  const member = Object.hasOwn(LIMITS_OF, scale.type) ? LIMITS_OF[scale.type]! : undefined
  if (member) {
    const values: LabelValues = [-Infinity, ...(scale as unknown as Record<string, () => unknown[]>)[member]!()]
    values.max = +Infinity
    return values
  }
  return tickValues(scale, count)
}

/** A formatter whose precision is set by the smallest gap between the values a scale cuts at. */
export function thresholdFormat(locale: Locale, scale: Scale, specifier: unknown): (v: unknown) => string {
  const cuts = (scale as unknown as Record<string, () => number[]>)[PRECISION_FROM[scale.type]!]!()
  const n = cuts.length
  let gap = n > 1 ? cuts[1]! - cuts[0]! : cuts[0]!
  for (let i = 1; i < n; ++i) gap = Math.min(gap, cuts[i]! - cuts[i - 1]!)
  // three ticks across the gap, ten times over for resolution
  return locale.formatSpan(0, gap, 3 * 10, specifier) as unknown as (v: unknown) => string
}

/** A legend label function: `(value, index, values) => label`. */
export type LabelFormat = (value: unknown, index: number, values: LabelValues) => string | null

const labelsClasses = (scale: Scale): boolean => Object.hasOwn(LIMITS_OF, scale.type) || !!scale.bins

/** How a legend labels each of its values, by the kind of legend and scale. */
export function labelFormat(
  locale: Locale,
  scale: Scale,
  count: unknown,
  type: string,
  specifier?: unknown,
  formatType?: string,
  noSkip?: boolean,
): LabelFormat {
  const write =
    Object.hasOwn(PRECISION_FROM, scale.type) && formatType !== Time && formatType !== UTC
      ? thresholdFormat(locale, scale, specifier)
      : tickFormat(locale, scale, count, specifier, formatType, noSkip)
  if (type === SymbolLegend && labelsClasses(scale)) {
    const finite = (v: unknown): string | null => (Number.isFinite(v) ? write(v) : null)
    return (value, index, values) => {
      const next = values[index + 1]
      const lo = finite(value)
      const hi = finite(next != null ? next : values.max != null ? values.max : +Infinity)
      return lo && hi ? `${lo} – ${hi}` : hi ? `< ${hi}` : `≥ ${lo}`
    }
  }
  // the first value of a discrete legend is the lower end of the first class: it has no label
  if (type === DiscreteLegend) return (value, index) => (index ? write(value) : null)
  return (value) => write(value)
}

/** Where along the legend a value of a discretizing scale sits, as a fraction. */
export function labelFraction(scale: Scale): (value: unknown) => number {
  const domain = scale.domain() as number[]
  const classes = domain.length - 1
  let lo = +domain[0]!
  let hi = +peek(domain)!
  let span = hi - lo
  if (scale.type === Threshold) {
    const pad = classes ? span / classes : 0.1
    lo -= pad
    hi += pad
    span = hi - lo
  }
  return (value) => ((value as number) - lo) / span
}

// ---- interpolators by name ---------------------------------------------------------------------------------

/**
 * The interpolators a spec can name, keyed by the capitalised, dash-joined form of the name: these, and the colour ones
 * (`COLOR_INTERPOLATORS`), which are the engine's colour part (interp-color.ts, read from engine-parts.ts when one is named).
 */
const INTERPOLATORS = new Map<string, unknown>(
  Object.entries({
    Array: interpolateArray,
    Basis: interpolateBasis,
    BasisClosed: interpolateBasisClosed,
    Date: interpolateDate,
    Discrete: interpolateDiscrete,
    Hue: interpolateHue,
    Number: interpolateNumber,
    NumberArray: interpolateNumberArray,
    Object: interpolateObject,
    Round: interpolateRound,
    String: interpolateString,
    Zoom: interpolateZoom,
  }),
)
export const COLOR_INTERPOLATORS: ReadonlySet<string> = new Set(['Cubehelix', 'CubehelixLong', 'Hcl', 'HclLong', 'Hsl', 'HslLong', 'Lab', 'Rgb', 'RgbBasis', 'RgbBasisClosed'])

/** The interpolator named by a spec (with a gamma, when it takes one); undefined for a name that is not one. */
export function interpolate(type?: string, gamma?: number): unknown {
  const key = type!
    .toLowerCase()
    .split('-')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')
  const blend = (COLOR_INTERPOLATORS.has(key) ? part('color').interpolators.get(key) : INTERPOLATORS.get(key)) as { gamma?: (g: number) => unknown } | undefined
  return gamma != null && blend && blend.gamma ? blend.gamma(gamma) : blend
}

/** One ramp through a list of colours, blended in the named space (rgb by default). */
export function interpolateColors(colors: string[], type?: string, gamma?: number): (t: number) => string {
  return piecewise(interpolate(type || 'rgb', gamma) as (a: unknown, b: unknown) => (t: number) => unknown, colors) as (t: number) => string
}

/** A ramp restricted to the part of [0, 1] that `range` spans (reversed when it runs backward). */
export function interpolateRange(ramp: (t: number) => unknown, range: number[]): (i: number) => unknown {
  const start = range[0]!
  const span = peek(range) - start
  return (i) => ramp(start + i * span)
}

/** `count` evenly spaced samples of a ramp, none at either end of [0, 1]. */
export function quantizeInterpolator(ramp: (t: number) => unknown, count: number): unknown[] {
  const samples = new Array(allot('items', count, 'quantized colour samples'))
  const n = count + 1
  for (let i = 0; i < count; ) samples[i] = ramp(++i / n)
  return samples
}

// ---- gradients ---------------------------------------------------------------------------------------------

/** The members a derived scale copies from the scale it stands for. */
const SHARED_MEMBERS = ['clamp', 'base', 'constant', 'exponent']

/** Where along [0, 1] a value of `source` sits when its domain is first rescaled to [min, max]. */
export function scaleFraction(source: Scale, min: number, max: number): (t: number) => unknown {
  const delta = max - min
  if (!delta || !Number.isFinite(delta)) return () => 0.5
  const dash = (source.type as string).indexOf('-')
  const kind = dash < 0 ? source.type : (source.type as string).slice(dash + 1)
  const unit = scale(kind)!().domain([min, max]).range([0, 1])
  for (const member of SHARED_MEMBERS) if (source[member]) unit[member](source[member]())
  return unit
}

/** A linear gradient as a paint: its end points in the unit square of the item it fills, and its stops. */
export interface ScaleGradient {
  gradient: 'linear'
  x1: number
  y1: number
  x2: number
  y2: number
  stops: Array<{ offset: number; color: string }>
}

const makeScale = scale

/**
 * The gradient of a scale (vega's `gradient(scale, start, stop, count)`): a linear gradient from `start` to `stop` (points of the
 * unit square; left to right by default) whose stops are the scale's tick values (`count`, else 15) with the domain ends added when
 * they are missing, each at the fraction `scaleFraction` gives and with the colour the scale gives. A scale without ticks (a
 * discrete one) uses its domain as stops. A domain of zero width is stretched onto [0, 1] first.
 *
 * (A scale that cannot be drawn this way -- one with no `interpolate`, such as an ordinal one over a domain with no width -- fails
 * in the call with the TypeError vega's call gives.)
 */
export function scaleGradient(scale: Scale, p0?: unknown, p1?: unknown, count?: unknown): ScaleGradient {
  const first = p0 as ArrayLike<number> | undefined | null
  const second = p1 as ArrayLike<number> | undefined | null
  const stops: ScaleGradient['stops'] = []
  const gradient: ScaleGradient = {
    gradient: 'linear',
    x1: first ? first[0]! : 0,
    y1: first ? first[1]! : 0,
    x2: second ? second[0]! : 1,
    y2: second ? second[1]! : 0,
    stops,
  }
  let values: number[] = scale.domain()
  let min = values[0]!
  let max = peek(values)
  let fraction: (t: number) => unknown = (t) => t
  if (!(max - min)) {
    // (a domain with no width: the scale it stands for, on [0, 1])
    // (a scale with neither -- an ordinal one over words: no width at all -- cannot be drawn this way; what vega's call says is kept)
    if (!scale.interpolator && typeof scale.interpolate !== 'function') throw new TypeError('scale.interpolate is not a function')
    scale = (scale.interpolator
      ? makeScale('sequential')!().interpolator(scale.interpolator())
      : makeScale('linear')!().interpolate(scale.interpolate()).range(scale.range())
    ).domain([(min = 0), (max = 1)])
  } else {
    fraction = scaleFraction(scale, min, max)
  }
  if (scale.ticks) {
    values = scale.ticks(+(count as number) || 15)
    if (min !== values[0]) values.unshift(min)
    if (max !== peek(values)) values.push(max)
  }
  for (const v of values) stops.push({ offset: fraction(v) as number, color: scale(v) as string })
  return gradient
}

/** The stops of a gradient legend for a scale (see {@link scaleGradient}). */
export function scaleGradientStops(source: Scale, count?: number): Array<{ offset: number; color: string }> {
  return scaleGradient(source, undefined, undefined, count).stops.map((s) => ({ offset: Number(s.offset), color: String(s.color) }))
}

// ---- schemes -----------------------------------------------------------------------------------------------

const schemes = new Map<string, unknown>()

/** The colours of a palette given as a run of six-digit hex colours. */
export function paletteColors(hex: string): string[] {
  const colors: string[] = []
  for (let i = 0; i + 6 <= hex.length; i += 6) colors.push('#' + hex.slice(i, i + 6))
  return colors
}

for (const [name, palette] of Object.entries(discretePalettes)) schemes.set(name.toLowerCase(), paletteColors(palette))

/**
 * The named scheme (a colour list or a ramp over [0, 1]), or undefined. The lists are here; any other name is looked up among the
 * ramps, which are the engine's colour part (color-schemes.ts, read from engine-parts.ts).
 */
export function scheme(name: string): unknown {
  const key = name && name.toLowerCase()
  return schemes.get(key) ?? (key ? part('color').rampScheme(key) : undefined)
}
