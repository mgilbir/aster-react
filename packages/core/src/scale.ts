/**
 * vega-scale (8.1.2): the scale registry, tick helpers, and colour scheme
 * registry as Vega uses them. Faithful transcription verified against oracle
 * vectors recorded from pinned vega-scale@8.1.2.
 *
 * Supersedes the `vega-scale` runtime dependency.
 */
import {
  bisectRight,
  peek,
  range as sequence,
  tickStep,
} from './arr.js'
import { ownGet, setOwn } from './util.js'
import { piecewise } from './interp.js'
import { interpolateRgb } from './interp.js'
import {
  identityScale,
  ordinal as d3Ordinal,
  d3TickFormat,
  quantileScale,
  quantize as d3Quantize,
  sequentialQuantile,
  threshold as d3Threshold,
  time,
  utcTime,
  continuous,
  linear,
  log,
  pow,
  sqrt,
  symlog,
  sequential,
  sequentialLog,
  sequentialPow,
  sequentialSqrt,
  sequentialSymlog,
  diverging,
  divergingLog,
  divergingPow,
  divergingSqrt,
  divergingSymlog,
  type SR,
} from './scale-d3.js'
import type { Locale } from './locale.js'
import {
  isNumber,
  isObject,
  isString,
  array as arr,
  error,
} from './util.js'
import {
  millisecond,
  timeIntervalFor,
  utcIntervalFor,
  type TimeInterval,
} from './time.js'

export type Scale = SR

// ---- scales/types.js --------------------------------------------------------

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
// categories
export const Continuous = 'continuous'
export const Discrete = 'discrete'
export const Discretizing = 'discretizing'
export const Interpolating = 'interpolating'
export const Temporal = 'temporal'

// ---- bandSpace.js -----------------------------------------------------------

export function bandSpace(count: number, paddingInner: number, paddingOuter: number): number {
  const space = count - paddingInner + paddingOuter * 2
  return count ? (space > 0 ? space : 1) : 0
}

// ---- numbers.js / slice.js --------------------------------------------------

export function numbers(_: Iterable<unknown>): number[] {
  return Array.from(_, (v) => +(v as number))
}

export const slice = Array.prototype.slice

// ---- scales/scaleBand.js (vega's band with invertRange) ---------------------

function vegaBand(): SR {
  const scale: SR = (d3Ordinal as unknown as () => SR)().unknown(undefined)
  const domain = scale.domain
  const ordinalRange = scale.range
  let range: [number, number] = [0, 1]
  let step: number
  let bandwidth: number
  let round = false
  let paddingInner = 0
  let paddingOuter = 0
  let align = 0.5
  delete scale.unknown

  function rescale(): SR {
    const n = domain().length
    const reverse: number = range[1]! < range[0]! ? 1 : 0
    const stop = range[1 - reverse]! as number
    let start = range[reverse]! as number
    step = (stop - start) / (bandSpace(n, paddingInner, paddingOuter) || 1)
    if (round) {
      step = Math.floor(step)
    }
    start += (stop - start - step * (n - paddingInner)) * align
    bandwidth = step * (1 - paddingInner)
    if (round) {
      start = Math.round(start)
      bandwidth = Math.round(bandwidth)
    }
    const values = sequence(n).map((i: number) => start + step * i)
    return ordinalRange(reverse ? values.reverse() : values)
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (arguments.length) {
      domain(_)
      return rescale()
    } else {
      return domain()
    }
  }

  scale.range = function (_?: [number, number]): unknown {
    if (arguments.length) {
      range = [+_![0], +_![1]]
      return rescale()
    } else {
      return range.slice()
    }
  }

  scale.rangeRound = function (_: [number, number]): SR {
    range = [+_[0], +_[1]]
    round = true
    return rescale()
  }

  scale.bandwidth = function (): number {
    return bandwidth
  }

  scale.step = function (): number {
    return step
  }

  scale.round = function (_?: boolean): unknown {
    if (arguments.length) {
      round = !!_
      return rescale()
    } else {
      return round
    }
  }

  scale.padding = function (_?: number): unknown {
    if (arguments.length) {
      paddingOuter = Math.max(0, Math.min(1, _ as number))
      paddingInner = paddingOuter
      return rescale()
    } else {
      return paddingInner
    }
  }

  scale.paddingInner = function (_?: number): unknown {
    if (arguments.length) {
      paddingInner = Math.max(0, Math.min(1, _ as number))
      return rescale()
    } else {
      return paddingInner
    }
  }

  scale.paddingOuter = function (_?: number): unknown {
    if (arguments.length) {
      paddingOuter = Math.max(0, Math.min(1, _ as number))
      return rescale()
    } else {
      return paddingOuter
    }
  }

  scale.align = function (_?: number): unknown {
    if (arguments.length) {
      align = Math.max(0, Math.min(1, _ as number))
      return rescale()
    } else {
      return align
    }
  }

  scale.invertRange = function (_: [number, number]): unknown[] | undefined {
    // bail if range has null or undefined values
    if (_[0] == null || _[1] == null) return undefined
    const reverse: number = range[1]! < range[0]! ? 1 : 0
    const values = reverse ? (ordinalRange() as number[]).reverse() : (ordinalRange() as number[])
    const n = values.length - 1
    let lo = +_[0]
    let hi = +_[1]
    let a: number
    let b: number
    let t: number
    // bail if either range endpoint is invalid
    if (lo !== lo || hi !== hi) return undefined
    // order range inputs, bail if outside of scale range
    if (hi < lo) {
      t = lo
      lo = hi
      hi = t
    }
    if (hi < values[0]! || lo > range[1 - reverse]!) return undefined
    // binary search to index into scale range
    a = Math.max(0, bisectRight(values, lo) - 1)
    b = lo === hi ? a : bisectRight(values, hi) - 1
    // increment index a if lo is within padding gap
    if (lo - values[a]! > bandwidth + 1e-10) ++a
    if (reverse) {
      // map + swap
      t = a
      a = n - b
      b = n - t
    }
    return a > b ? undefined : (domain() as unknown[]).slice(a, b + 1)
  }

  scale.invert = function (_: number): unknown {
    const value = scale.invertRange([_, _])
    return value ? value[0] : value
  }

  scale.copy = function () {
    return (vegaBand()
      .domain(domain())
      .range(range)
      .round(round)
      .paddingInner(paddingInner)
      .paddingOuter(paddingOuter)
      .align(align) as unknown) as SR
  }

  return rescale()
}

function vegaPointish(scale: SR): SR {
  const copy = scale.copy
  scale.padding = scale.paddingOuter
  delete scale.paddingInner
  scale.copy = function () {
    return vegaPointish(copy())
  }
  return scale
}

function vegaPoint(): SR {
  return vegaPointish((vegaBand() as unknown as { paddingInner(v: number): SR }).paddingInner(1))
}

// ---- scales/scaleBinOrdinal.js ----------------------------------------------

export function scaleBinOrdinal(): SR {
  let domain: number[] = []
  let range: unknown[] = []

  function scale(x: unknown): unknown {
    return x == null || x !== x
      ? undefined
      : range[(bisectRight(domain, x as number) - 1) % range.length]
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (arguments.length) {
      domain = Array.from(_ as Iterable<unknown>, (v) => +(v as number))
      return scale
    } else {
      return domain.slice()
    }
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    if (arguments.length) {
      range = slice.call(_)
      return scale
    } else {
      return range.slice()
    }
  }

  scale.tickFormat = function (count?: number, specifier?: string): (v: number) => string {
    return d3TickFormat(domain[0]!, domain[domain.length - 1]!, count == null ? 10 : count, specifier)
  }

  scale.copy = function () {
    return scaleBinOrdinal().domain(scale.domain()).range(scale.range())
  }

  return scale
}

// ---- scales/invertRange.js / invertRangeExtent.js ---------------------------

function invertRangeFor(scale: SR): (range: [number, number]) => unknown[] {
  return function (_) {
    let lo = _[0]
    let hi = _[1]
    let t: number
    if (hi < lo) {
      t = lo
      lo = hi
      hi = t
    }
    return [scale.invert(lo), scale.invert(hi)]
  }
}

function invertRangeExtentFor(scale: SR): (range: [number, number]) => unknown[] | undefined {
  return function (_) {
    const range = scale.range() as unknown[]
    let lo = _[0]
    let hi = _[1]
    let min = -1
    let max: number | undefined
    let t: number
    if (hi < lo) {
      t = lo
      lo = hi
      hi = t
    }
    for (let i = 0, n = range.length; i < n; ++i) {
      if ((range[i] as number) >= (lo as number) && (range[i] as number) <= (hi as number)) {
        if (min < 0) min = i
        max = i
      }
    }
    if (min < 0) return undefined
    const loExt = scale.invertExtent(range[min!])
    const hiExt = scale.invertExtent(range[max!])
    return [
      loExt[0] === undefined ? loExt[1] : loExt[0],
      hiExt[1] === undefined ? hiExt[0] : hiExt[1],
    ]
  }
}

// ---- scales.js (registry) ---------------------------------------------------

// Placeholder returned by `scale(type, ctor, meta)` setter calls (mirrors `this`).
const scaleRegistryApi = {} as unknown as () => SR

interface RegistryEntry {
  create: (type: string, constructor: () => SR, metadata: string[]) => () => SR
}

const VEGA_SCALE = Symbol('vega_scale')
const scales = new Map<string, () => SR>()

/** Mark a scale as produced by this registry. */
export function registerScale(scale: SR): SR {
  scale[VEGA_SCALE] = true
  return scale
}

/** Return true if the object was created by a `scale(type)` constructor. */
export function isRegisteredScale(scale: SR): boolean {
  return scale && scale[VEGA_SCALE] === true
}

/** Augment scales with their type and needed inverse methods. */
function create(type: string, constructor: () => SR, metadata: string | string[]): () => SR {
  const ctr = function scale(this: unknown): SR {
    const s = constructor()
    if (!s.invertRange) {
      s.invertRange = s.invert
        ? invertRangeFor(s)
        : s.invertExtent
          ? invertRangeExtentFor(s)
          : undefined
    }
    s.type = type
    return registerScale(s)
  }
  ctr.metadata = toSet(arr(metadata) as string[])
  return ctr
}

function toSet(_: Iterable<string>): Record<string, boolean> {
  const o: Record<string, boolean> = {}
  for (const v of _) o[v] = true
  return o
}

/**
 * Registry function for adding and accessing scale constructor functions.
 * The `type` argument is a String indicating the name of the scale type.
 *
 * If the `scale` argument is not specified, this method returns the matching
 * scale constructor in the registry, or `null` if not found. If the `scale`
 * argument is provided, it must be a scale constructor function to add to the
 * registry under the given `type` name. The `metadata` argument provides
 * additional information to guide appropriate use of scales within Vega
 * (`continuous`, `discrete`, `discretizing`, `interpolating`, `log`,
 * `temporal`).
 */
export function scale(type: string, scale?: () => SR, metadata?: string | string[]): (() => SR) | undefined {
  if (arguments.length > 1) {
    scales.set(type, create(type, scale!, metadata ?? []))
    return scaleRegistryApi
  } else {
    return isValidScaleType(type) ? scales.get(type) : undefined
  }
}

// d3-scale type factories, wrapped to satisfy the registry's constructor shape
const d3 = {
  scaleIdentity: identityScale,
  scaleLinear: linear,
  scaleLog: log,
  scalePow: pow,
  scaleSqrt: sqrt,
  scaleSymlog: symlog,
  scaleTime: time,
  scaleUtc: utcTime,
  scaleSequential: sequential,
  scaleSequentialLog: sequentialLog,
  scaleSequentialPow: sequentialPow,
  scaleSequentialSqrt: sequentialSqrt,
  scaleSequentialSymlog: sequentialSymlog,
  scaleDiverging: diverging,
  scaleDivergingLog: divergingLog,
  scaleDivergingPow: divergingPow,
  scaleDivergingSqrt: divergingSqrt,
  scaleDivergingSymlog: divergingSymlog,
  scaleQuantile: quantileScale,
  scaleQuantize: d3Quantize,
  scaleThreshold: d3Threshold,
  scaleOrdinal: d3Ordinal,
  scaleSequentialQuantile: sequentialQuantile,
}

// identity scale
scale(Identity, d3.scaleIdentity as unknown as () => SR, Continuous as string)
// continuous scales
scale(Linear, d3.scaleLinear as unknown as () => SR, Continuous)
scale(Log, d3.scaleLog as unknown as () => SR, [Continuous, Log])
scale(Pow, d3.scalePow as unknown as () => SR, Continuous)
scale(Sqrt, d3.scaleSqrt as unknown as () => SR, Continuous)
scale(Symlog, d3.scaleSymlog as unknown as () => SR, Continuous)
scale(Time, d3.scaleTime as unknown as () => SR, [Continuous, Temporal])
scale(UTC, d3.scaleUtc as unknown as () => SR, [Continuous, Temporal])
// sequential scales
scale(Sequential, d3.scaleSequential as unknown as () => SR, [Continuous, Interpolating]) // backwards compat
scale(`${Sequential}-${Linear}`, d3.scaleSequential as unknown as () => SR, [Continuous, Interpolating])
scale(`${Sequential}-${Log}`, d3.scaleSequentialLog as unknown as () => SR, [Continuous, Interpolating, Log])
scale(`${Sequential}-${Pow}`, d3.scaleSequentialPow as unknown as () => SR, [Continuous, Interpolating])
scale(`${Sequential}-${Sqrt}`, d3.scaleSequentialSqrt as unknown as () => SR, [Continuous, Interpolating])
scale(`${Sequential}-${Symlog}`, d3.scaleSequentialSymlog as unknown as () => SR, [Continuous, Interpolating])
// diverging scales
scale(`${Diverging}-${Linear}`, d3.scaleDiverging as unknown as () => SR, [Continuous, Interpolating])
scale(`${Diverging}-${Log}`, d3.scaleDivergingLog as unknown as () => SR, [Continuous, Interpolating, Log])
scale(`${Diverging}-${Pow}`, d3.scaleDivergingPow as unknown as () => SR, [Continuous, Interpolating])
scale(`${Diverging}-${Sqrt}`, d3.scaleDivergingSqrt as unknown as () => SR, [Continuous, Interpolating])
scale(`${Diverging}-${Symlog}`, d3.scaleDivergingSymlog as unknown as () => SR, [Continuous, Interpolating])
// discretizing scales
scale(Quantile, d3.scaleQuantile as unknown as () => SR, [Discretizing, Quantile])
scale(Quantize, d3.scaleQuantize as unknown as () => SR, Discretizing)
scale(Threshold, d3.scaleThreshold as unknown as () => SR, Discretizing)
// discrete scales
scale(BinOrdinal, scaleBinOrdinal, [Discrete, Discretizing])
scale(Ordinal, d3.scaleOrdinal as unknown as () => SR, Discrete)
scale(Band, vegaBand, Discrete)
scale(Point, vegaPoint, Discrete)

export function isValidScaleType(type: string): boolean {
  return scales.has(type)
}

function hasType(key: string, type: string): boolean | undefined {
  const s = scales.get(key)
  return s && (s as unknown as { metadata?: Record<string, boolean> }).metadata![type]
}

export function isContinuous(key: string): boolean | undefined {
  return hasType(key, Continuous)
}

export function isDiscrete(key: string): boolean | undefined {
  return hasType(key, Discrete)
}

export function isDiscretizing(key: string): boolean | undefined {
  return hasType(key, Discretizing)
}

export function isLogarithmic(key: string): boolean | undefined {
  return hasType(key, Log)
}

export function isTemporal(key: string): boolean | undefined {
  return hasType(key, Temporal)
}

export function isInterpolating(key: string): boolean | undefined {
  return hasType(key, Interpolating)
}

export function isQuantile(key: string): boolean | undefined {
  return hasType(key, Quantile)
}

// ---- ticks.js ---------------------------------------------------------------

const defaultFormatter = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((v) => String(v)) : String(value)

const ascendingCmp = (a: [unknown, unknown], b: [unknown, unknown]) => (a[1] as number) - (b[1] as number)
const descendingCmp = (a: [unknown, unknown], b: [unknown, unknown]) => (b[1] as number) - (a[1] as number)

/**
 * Determine the tick count or interval function.
 * @param scale - The scale for which to generate tick values.
 * @param count - The desired tick count or interval specifier.
 * @param minStep - The desired minimum step between tick values.
 */
export function tickCount(scale: SR, count: unknown, minStep?: number): unknown {
  let step: unknown
  if (isNumber(count)) {
    if (scale.bins) {
      count = Math.max(count as number, scale.bins.length)
    }
    if (minStep != null) {
      const domain = scale.domain() as number[]
      const lo = Math.min(domain[0]!, peek(domain))
      const hi = Math.max(domain[0]!, peek(domain))
      count = Math.min(count as number, Math.floor((hi - lo) / minStep || 1) + 1)
      if (!scale.bins && !isLogarithmic(scale.type) && !isTemporal(scale.type) && lo < hi) {
        // d3 tick steps grow monotonically as the count shrinks
        while ((count as number) > 1 && tickStep(lo, hi, count as number) < minStep) --(count as number)
      }
    }
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

/**
 * Filter a set of candidate tick values, ensuring that only tick values
 * that lie within the scale range are included.
 */
export function validTicks(scale: SR, ticks: unknown[], count: number): unknown[] {
  let range = scale.range() as number[]
  let lo = range[0]
  let hi = peek(range)!
  let cmp = ascendingCmp
  if (lo! > hi) {
    range = [hi, hi = lo!] as unknown as number[]
    cmp = descendingCmp
  }
  lo = range[0]!
  hi = peek(range)!
  lo = Math.floor(lo)
  hi = Math.ceil(hi)
  // filter ticks to valid values within the range
  // additionally sort ticks in range order (#2579)
  ticks = (ticks as unknown[])
    .map((v) => [v, scale(v)] as [unknown, unknown])
    .filter((_) => lo! <= (_[1] as number) && (_[1] as number) <= hi!)
    .sort(cmp)
    .map((_) => _[0])
  if (count > 0 && (ticks as unknown[]).length > 1) {
    const endpoints = [(ticks as unknown[])[0], peek(ticks as unknown[])]
    while ((ticks as unknown[]).length > count && (ticks as unknown[]).length >= 3) {
      ticks = (ticks as unknown[]).filter((_, i) => !(i % 2))
    }
    if ((ticks as unknown[]).length < 3) {
      ticks = endpoints
    }
  }
  return ticks as unknown[]
}

/**
 * Generate tick values for the given scale and approximate tick count or
 * interval value. If the scale has a 'ticks' method, it will be used to
 * generate the ticks, with the count argument passed as a parameter. If the
 * scale lacks a 'ticks' method, the full scale domain will be returned.
 */
export function tickValues(scale: SR, count?: unknown): unknown[] {
  return scale.bins
    ? validTicks(scale, scale.bins, count as number)
    : scale.ticks
      ? scale.ticks(count)
      : scale.domain()
}

/**
 * Generate a label format function for a scale. If the scale has a
 * 'tickFormat' method, it will be used to generate the formatter, with the
 * count and specifier arguments passed as parameters. If the scale lacks a
 * 'tickFormat' method, the returned formatter performs simple string coercion.
 * If the input scale is a logarithmic scale and the format specifier does not
 * indicate a desired decimal precision, a special variable precision formatter
 * that automatically trims trailing zeroes will be generated.
 */
export function tickFormat(
  locale: Locale,
  scale: SR,
  count?: unknown,
  specifier?: unknown,
  formatType?: string,
  noSkip?: boolean,
): (v: unknown) => string {
  const type = scale.type
  let format: (v: unknown) => string = defaultFormatter as (v: unknown) => string
  if (type === Time || formatType === Time) {
    format = locale.timeFormat(specifier as string) as unknown as (v: unknown) => string
  } else if (type === UTC || formatType === UTC) {
    format = locale.utcFormat(specifier as string) as unknown as (v: unknown) => string
  } else if (isLogarithmic(type)) {
    const varfmt = locale.formatFloat(specifier) as unknown as (v: number) => string
    if (noSkip || scale.bins) {
      format = varfmt as unknown as (v: unknown) => string
    } else {
      const test = tickLog(scale, count, false) as (d: number) => boolean
      format = (_: unknown) => (test(_ as number) ? varfmt(_ as number) : '')
    }
  } else if (scale.tickFormat) {
    // if d3 scale has tickFormat, it must be continuous
    const d = scale.domain() as number[]
    format = locale.formatSpan(d[0]!, d[d.length - 1]!, count as number, specifier) as unknown as (v: unknown) => string
  } else if (specifier) {
    format = locale.format(specifier) as unknown as (v: unknown) => string
  }
  return format
}

function tickLog(scale: SR, count: unknown, values: boolean): number[] | ((d: number) => boolean) {
  const ticks = tickValues(scale, count) as number[]
  const base = scale.base()
  const logb = Math.log(base)
  const k = Math.max(1, (base * (count as number)) / ticks.length)
  // apply d3-scale's log format filter criteria
  const test = (d: number): boolean => {
    let i = d / Math.pow(base, Math.round(Math.log(d) / logb))
    if (i * base < base - 0.5) i *= base
    return i <= k
  }
  return values ? ticks.filter(test) : test
}

// ---- interpolate.js ---------------------------------------------------------

const scaleProps = ['clamp', 'base', 'constant', 'exponent']

export function interpolateRange(interpolator: (t: number) => unknown, range: number[]): (i: number) => unknown {
  const start = range[0]!
  const span = peek(range)! - start
  return function (i) {
    return interpolator(start + i * span)
  }
}

export function interpolateColors(colors: string[], type?: string, gamma?: number): (t: number) => string {
  return (piecewise as (i: unknown, v: string[]) => (t: number) => string)(
    (interpolate as (t?: string, g?: number) => unknown)(type || 'rgb', gamma),
    colors,
  )
}

export function quantizeInterpolator(interpolator: (t: number) => unknown, count: number): unknown[] {
  const samples = new Array(count)
  const n = count + 1
  for (let i = 0; i < count;) samples[i] = interpolator(++i / n)
  return samples
}

export function scaleCopy(scale: SR): SR {
  const t = scale.type
  const s = scale.copy()
  s.type = t
  return s
}

export function scaleFraction(source: SR, min: number, max: number): (t: number) => unknown {
  const delta = max - min
  if (!delta || !Number.isFinite(delta)) {
    return () => 0.5
  } else {
    let t: string = source.type
    const i = t.indexOf('-')
    t = i < 0 ? t : t.slice(i + 1)
    const s = (scale(t) as unknown as () => SR)().domain([min, max]).range([0, 1])
    scaleProps.forEach((m) => (source[m] ? s[m](source[m]()) : 0))
    return s
  }
}

export function interpolate(type?: string, gamma?: number): unknown {
  const interp = (method(type) as unknown as Record<string, unknown>)
  return gamma != null && interp && (interp as { gamma?: unknown }).gamma
    ? (interp as { gamma: (g: number) => unknown }).gamma(gamma)
    : interp
}

function method(type?: string): unknown {
  const name =
    'interpolate' +
    type!.toLowerCase()
      .split('-')
      .map((s) => s[0]!.toUpperCase() + s.slice(1))
      .join('')
  return ownGet(interpolators, name)
}

const interpolators: Record<string, unknown> = {
  interpolateRgb,
}

// ---- schemes.js / palettes.js -----------------------------------------------

import { continuousPalettes, discretePalettes } from './scale-schemes.js'

function paletteColors(palette: unknown): string[] {
  if (Array.isArray(palette)) return palette as string[]
  const s = palette as string
  const n = (s.length / 6) | 0
  const c = new Array<string>(n)
  for (let i = 0; i < n;) {
    c[i] = '#' + s.slice(i * 6, ++i * 6)
  }
  return c
}

function applyPalettes(obj: Record<string, unknown>, f: (v: unknown) => unknown): void {
  for (const k in obj) scheme(k, f(obj[k]))
}

const schemes: Record<string, unknown> = {}
const schemeApi = {}
applyPalettes(discretePalettes, paletteColors)
applyPalettes(continuousPalettes, (_) => interpolateColors(paletteColors(_)))

export function scheme(name: string, schemeDef?: unknown): unknown {
  name = name && name.toLowerCase()
  if (arguments.length > 1) {
    setOwn(schemes, name, schemeDef)
    return schemeApi
  } else {
    return ownGet(schemes, name)
  }
}

