/**
 * Scales as the chart engine uses them: the registry of scale types (name, kind, inverse members), the choice of ticks and
 * labels for an axis or legend, interpolators by name, colour schemes and gradient stops. The constructors live in
 * `scale-continuous.ts` (including time and UTC) and `scale-discrete.ts`.
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
import { boundedCount } from './limits.js'
import {
  interpolateArray,
  interpolateBasis,
  interpolateBasisClosed,
  interpolateCubehelix,
  interpolateCubehelixLong,
  interpolateDate,
  interpolateDiscrete,
  interpolateHcl,
  interpolateHclLong,
  interpolateHsl,
  interpolateHslLong,
  interpolateHue,
  interpolateLab,
  interpolateNumber,
  interpolateNumberArray,
  interpolateObject,
  interpolateRgb,
  interpolateRgbBasis,
  interpolateRgbBasisClosed,
  interpolateRound,
  interpolateString,
  interpolateZoom,
  piecewise,
} from './interp.js'
import type { Locale } from './locale.js'
import {
  diverging,
  divergingLog,
  divergingPow,
  divergingSqrt,
  divergingSymlog,
  identityScale,
  linear,
  log,
  pow,
  sequential,
  sequentialLog,
  sequentialPow,
  sequentialSqrt,
  sequentialSymlog,
  sqrt,
  symlog,
  time,
  utcTime,
  type ScaleObject,
} from './scale-continuous.js'
import { band, binOrdinal, ordinal, point, quantileScale, quantize, threshold } from './scale-discrete.js'
import { continuousPalettes, discretePalettes } from './scale-schemes.js'
import { timeIntervalFor, utcIntervalFor, type TimeInterval } from './time.js'
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
register(Identity, identityScale)
register(Linear, linear, Continuous)
register(Log, log, Continuous, Log)
register(Pow, pow, Continuous)
register(Sqrt, sqrt, Continuous)
register(Symlog, symlog, Continuous)
register(Time, time, Continuous, Temporal)
register(UTC, utcTime, Continuous, Temporal)
register(Sequential, sequential, ...NUMERIC) // the name before sequential scales had a warp
register(`${Sequential}-${Linear}`, sequential, ...NUMERIC)
register(`${Sequential}-${Log}`, sequentialLog, ...NUMERIC, Log)
register(`${Sequential}-${Pow}`, sequentialPow, ...NUMERIC)
register(`${Sequential}-${Sqrt}`, sequentialSqrt, ...NUMERIC)
register(`${Sequential}-${Symlog}`, sequentialSymlog, ...NUMERIC)
register(`${Diverging}-${Linear}`, diverging, ...NUMERIC)
register(`${Diverging}-${Log}`, divergingLog, ...NUMERIC, Log)
register(`${Diverging}-${Pow}`, divergingPow, ...NUMERIC)
register(`${Diverging}-${Sqrt}`, divergingSqrt, ...NUMERIC)
register(`${Diverging}-${Symlog}`, divergingSymlog, ...NUMERIC)
register(Quantile, quantileScale, Discretizing, Quantile)
register(Quantize, quantize, Discretizing)
register(Threshold, threshold, Discretizing)
register(BinOrdinal, binOrdinal, Discrete, Discretizing)
register(Ordinal, ordinal, Discrete)
register(Band, band, Discrete)
register(Point, point, Discrete)

/** The constructor registered for a type name, if there is one. */
export function scale(type: string): ScaleCtor | undefined {
  return registry.get(type)
}

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
        // a tick step only grows as the count falls, so stepping down finds the largest count that spaces them enough
        while (wanted > 1 && tickStep(lo, hi, wanted) < minStep) --wanted
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
        ? timeIntervalFor(count as string)!
        : scale.type === UTC
          ? utcIntervalFor(count as string)!
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

/** The interpolators a spec can name, keyed by the capitalised, dash-joined form of the name. */
const INTERPOLATORS = new Map<string, unknown>(
  Object.entries({
    Array: interpolateArray,
    Basis: interpolateBasis,
    BasisClosed: interpolateBasisClosed,
    Cubehelix: interpolateCubehelix,
    CubehelixLong: interpolateCubehelixLong,
    Date: interpolateDate,
    Discrete: interpolateDiscrete,
    Hcl: interpolateHcl,
    HclLong: interpolateHclLong,
    Hsl: interpolateHsl,
    HslLong: interpolateHslLong,
    Hue: interpolateHue,
    Lab: interpolateLab,
    Number: interpolateNumber,
    NumberArray: interpolateNumberArray,
    Object: interpolateObject,
    Rgb: interpolateRgb,
    RgbBasis: interpolateRgbBasis,
    RgbBasisClosed: interpolateRgbBasisClosed,
    Round: interpolateRound,
    String: interpolateString,
    Zoom: interpolateZoom,
  }),
)

/** The interpolator named by a spec (with a gamma, when it takes one); undefined for a name that is not one. */
export function interpolate(type?: string, gamma?: number): unknown {
  const key = type!
    .toLowerCase()
    .split('-')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')
  const blend = INTERPOLATORS.get(key) as { gamma?: (g: number) => unknown } | undefined
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
  boundedCount(count, 'quantized colour samples')
  const samples = new Array(count)
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

/**
 * The stops of a gradient legend for a scale: its tick values (`count`, else 15) with the domain ends added when they are
 * missing, each at the fraction `scaleFraction` gives and with the colour the scale gives. Scales without ticks use
 * their domain as stops. A domain of zero width is stretched onto [0, 1] first.
 */
export function scaleGradientStops(source: Scale, count?: number): Array<{ offset: number; color: string }> {
  let drawn: Scale = source
  let stops: number[] = source.domain()
  let min = stops[0]!
  let max = peek(stops)
  let fraction: (t: number) => unknown = (t) => t
  if (!(max - min)) {
    drawn = (source.interpolator
      ? scale('sequential')!().interpolator(source.interpolator())
      : scale('linear')!().interpolate(source.interpolate()).range(source.range())
    ).domain([(min = 0), (max = 1)])
  } else {
    fraction = scaleFraction(source, min, max)
  }
  if (drawn.ticks) {
    stops = drawn.ticks(+(count as number) || 15)
    if (min !== stops[0]) stops.unshift(min)
    if (max !== peek(stops)) stops.push(max)
  }
  return stops.map((v) => ({ offset: Number(fraction(v)), color: String(drawn(v)) }))
}

// ---- schemes -----------------------------------------------------------------------------------------------

const schemes = new Map<string, unknown>()

/** The colours of a palette given as hex runs of six digits, or as a list already. */
function paletteColors(palette: unknown): string[] {
  if (Array.isArray(palette)) return palette as string[]
  const hex = palette as string
  const colors: string[] = []
  for (let i = 0; i + 6 <= hex.length; i += 6) colors.push('#' + hex.slice(i, i + 6))
  return colors
}

for (const [name, palette] of Object.entries(discretePalettes)) schemes.set(name.toLowerCase(), paletteColors(palette))
for (const [name, palette] of Object.entries(continuousPalettes)) schemes.set(name.toLowerCase(), interpolateColors(paletteColors(palette)))

/** The named scheme (a colour list or a ramp over [0, 1]), or undefined. */
export function scheme(name: string): unknown {
  return schemes.get(name && name.toLowerCase())
}
