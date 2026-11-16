/**
 * The continuous scales: identity, linear, power, square root, logarithmic and symlog scales that map a numeric domain
 * onto a range of numbers, colours, arrays or anything an interpolator can blend; the sequential and diverging colour
 * scales, which map a domain of two or three stops onto a single interpolator; and the calendar scales over time.
 *
 * Aster builds each as a callable `ScaleObject` over a small model:
 *
 * - `Mapping` holds a domain, a range, the interpolator between range values, the clamp and the unknown value, and
 *   compiles them into a piecewise function (and its inverse) the first time they are needed;
 * - a `Warp` is the bend a scale applies before it interpolates (identity, power, logarithm, symlog): the same model
 *   serves every kind, which differ only in the warp and in the axis members they carry (ticks, nice, tickFormat);
 * - `Gradient` is the same idea for a colour scale, whose "range" is one interpolator over [0, 1].
 *
 * What the callers observe, and so what is fixed here:
 * - a value outside the domain is clamped first and warped second, but an inverted value is warped back first and clamped
 *   second; the stops of a piecewise scale are searched after the warp, so a descending domain reverses both arrays whole
 *   (a range longer than its domain keeps the entries the reversal moved);
 * - every arithmetic step (`(x - a) / (b - a)`, then the interpolator's own `a * (1 - t) + b * t`) is kept, since the last bit
 *   of a pixel or a colour channel depends on it;
 * - a diverging scale does not treat null as missing (it is 0), the others do;
 * - tick, nice and format members read the domain they are given at call time, never a copy made at construction;
 * - the members are accessors: called with no argument they read, with one they write and return the scale.
 */
import { bisectRight, ticks, tickIncrement, tickStep } from './arr.js'
import { interpolateNumber, interpolateRound, interpolateValue, type Ramp } from './interp.js'
import {
  format,
  formatPrefix,
  formatSpecifier,
  precisionFixed,
  precisionPrefix,
  precisionRound,
  type FormatFunction,
} from './format.js'

/** A scale: a function with the members its kind carries. */
export interface ScaleObject {
  (x: unknown): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any
}

export type Unary = (x: number) => number
export type Blend = (a: unknown, b: unknown) => Ramp

/** A member that reads with no argument and writes with one, returning the scale. */
export function accessor<T>(self: ScaleObject, read: () => T, write: (value: T) => void): (...value: [T?]) => unknown {
  return (...value) => (value.length ? (write(value[0] as T), self) : read())
}

export const identity = <T>(x: T): T => x
export const toNumber = (x: unknown): number => +(x as number)

/**
 * The first two, or three, entries of an iterable. Taken through a parameter pattern so that a value that is not iterable
 * fails with the engine's plain message (`undefined is not iterable (cannot ...)`), which is what a user's log shows.
 */
export const firstTwo = ([a, b]: Iterable<unknown>): [unknown, unknown] => [a, b]
export const firstThree = ([a, b, c]: Iterable<unknown>): [unknown, unknown, unknown] => [a, b, c]

// ---- the bend ---------------------------------------------------------------------------------------------

/** What a scale does to a domain value before interpolating, and its inverse. */
export interface Warp {
  to: Unary
  from: Unary
}

export const FLAT: Warp = { to: identity, from: identity }

// ---- piecewise maps ---------------------------------------------------------------------------------------

/** How far x lies from a to b, as a fraction; a flat span answers the middle (and NaN when the span is NaN). */
function fraction(a: unknown, b: unknown): Unary {
  const from = +(a as number)
  const span = (b as number) - from
  return span ? (x) => (x - from) / span : isNaN(span) ? () => NaN : () => 0.5
}

/**
 * A map from the stops `xs` to the values `ys`, linear between neighbours through `blend`. Two stops (or fewer, reading
 * the first two entries all the same) make one piece; more make a piece per pair, found by binary search. A descending
 * run of stops is reversed, along with the values, before the pieces are cut.
 */
function pieces(xs: readonly unknown[], ys: readonly unknown[], interpolate: Blend): (x: number) => unknown {
  const count = Math.min(xs.length, ys.length) - 1
  if (count < 2) {
    const [x0, x1, y0, y1] = [xs[0], xs[1], ys[0], ys[1]]
    const descending = (x1 as number) < (x0 as number)
    const along = descending ? fraction(x1, x0) : fraction(x0, x1)
    const into = descending ? interpolate(y1, y0) : interpolate(y0, y1)
    return (x) => into(along(x))
  }
  if ((xs[count] as number) < (xs[0] as number)) {
    xs = xs.slice().reverse()
    ys = ys.slice().reverse()
  }
  const along: Unary[] = new Array(count)
  const into: Ramp[] = new Array(count)
  for (let i = 0; i < count; i++) {
    along[i] = fraction(xs[i], xs[i + 1])
    into[i] = interpolate(ys[i], ys[i + 1])
  }
  return (x) => {
    const i = bisectRight(xs as number[], x, 1, count) - 1
    return into[i]!(along[i]!(x))
  }
}

function clampBetween(a: number, b: number): Unary {
  if (a > b) [a, b] = [b, a]
  return (x) => Math.max(a, Math.min(b, x))
}

// ---- the model of a continuous scale ----------------------------------------------------------------------

export class Mapping {
  domain: number[] = [0, 1]
  range: unknown[] = [0, 1]
  blend: Blend = interpolateValue as Blend
  clamped = false
  fallback: unknown = undefined
  warp: Warp = FLAT
  private clampTo: Unary = identity
  private forward: ((x: number) => unknown) | null = null
  private backward: ((y: unknown) => unknown) | null = null

  /** Called after any change to the pieces the maps are cut from. */
  refresh(): void {
    const n = Math.min(this.domain.length, this.range.length)
    this.clampTo = this.clamped ? clampBetween(this.domain[0]!, this.domain[n - 1]!) : identity
    this.forward = this.backward = null
  }

  bend(warp: Warp): void {
    this.warp = warp
    this.refresh()
  }

  setDomain(v: Iterable<unknown>): void {
    this.domain = Array.from(v, toNumber)
    this.refresh()
  }

  setRange(v: Iterable<unknown>): void {
    this.range = Array.from(v)
    this.refresh()
  }

  setBlend(blend: Blend): void {
    this.blend = blend
    this.refresh()
  }

  setClamped(v: unknown): void {
    this.clamped = !!v
    this.refresh()
  }

  map(value: unknown): unknown {
    if (value == null || isNaN((value = +(value as number)))) return this.fallback
    const warp = this.warp
    if (this.forward === null) this.forward = pieces(this.domain.map(warp.to), this.range, this.blend)
    return this.forward(warp.to(this.clampTo(value as number)))
  }

  invert(value: unknown): unknown {
    const warp = this.warp
    if (this.backward === null) this.backward = pieces(this.range, this.domain.map(warp.to), interpolateNumber as Blend) as (y: unknown) => unknown
    return this.clampTo(warp.from(this.backward(value) as number))
  }
}

/** The callable and the members every continuous scale has. */
export function continuousScale(): { scale: ScaleObject; model: Mapping } {
  const model = new Mapping()
  const scale = ((x: unknown) => model.map(x)) as ScaleObject
  scale.invert = (y: unknown) => model.invert(y)
  scale.domain = (...v: [Iterable<unknown>?]) => (v.length ? (model.setDomain(v[0]!), scale) : model.domain.slice())
  scale.range = (...v: [Iterable<unknown>?]) => (v.length ? (model.setRange(v[0]!), scale) : model.range.slice())
  scale.rangeRound = (...v: [Iterable<unknown>?]) => {
    model.range = Array.from(v[0]!)
    model.setBlend(interpolateRound as Blend)
    return scale
  }
  scale.clamp = (...v: [unknown?]) => (v.length ? (model.setClamped(v[0]), scale) : model.clamped)
  scale.interpolate = (...v: [Blend?]) => (v.length ? (model.setBlend(v[0]!), scale) : model.blend)
  scale.unknown = (...v: [unknown?]) => (v.length ? ((model.fallback = v[0]), scale) : model.fallback)
  return { scale, model }
}

/** Gives `to` the state of `from` through the public members, as a copy of a scale of the same kind. */
export function carry(from: ScaleObject, to: ScaleObject): ScaleObject {
  return to.domain(from.domain()).range(from.range()).interpolate(from.interpolate()).clamp(from.clamp()).unknown(from.unknown())
}

// ---- axis members: ticks, nice, tickFormat ---------------------------------------------------------------

/** The domain with its two outer ends rounded to ticks of the same size, or null when no such rounding settles. */
function roundedEnds(start: number, stop: number, count: number): [number, number] | null {
  let previous: number | undefined
  for (let pass = 0; pass < 10; pass++) {
    const step = tickIncrement(start, stop, count)
    if (step === previous) return [start, stop]
    if (step > 0) {
      start = Math.floor(start / step) * step
      stop = Math.ceil(stop / step) * step
    } else if (step < 0) {
      start = Math.ceil(start * step) / step
      stop = Math.floor(stop * step) / step
    } else {
      return null
    }
    previous = step
  }
  return null
}

/** The domain with its outer ends moved to the floor and ceiling of an interval. */
export function niceDomain(domain: number[], interval: { floor(x: number): number; ceil(x: number): number }): number[] {
  const out = domain.slice()
  let lo = 0
  let hi = out.length - 1
  if (out[hi]! < out[lo]!) [lo, hi] = [hi, lo]
  const low = out[lo]!
  const high = out[hi]!
  out[lo] = interval.floor(low)
  out[hi] = interval.ceil(high)
  return out
}

/** A number format for the ticks between two ends: the precision follows the tick step unless the specifier fixes it. */
export function tickFormatFor(start: number, stop: number, count: number, specifier?: unknown): FormatFunction {
  const step = tickStep(start, stop, count)
  const spec = formatSpecifier(specifier == null ? ',f' : specifier)
  const widest = Math.max(Math.abs(start), Math.abs(stop))
  const fit = (precision: number, shift = 0): void => {
    if (!isNaN(precision)) spec.precision = precision - shift
  }
  switch (spec.type) {
    case 's':
      if (spec.precision == null) fit(precisionPrefix(step, widest))
      return formatPrefix(spec, widest)
    case '':
    case 'e':
    case 'g':
    case 'p':
    case 'r':
      if (spec.precision == null) fit(precisionRound(step, widest), spec.type === 'e' ? 1 : 0)
      break
    case 'f':
    case '%':
      if (spec.precision == null) fit(precisionFixed(step), spec.type === '%' ? 2 : 0)
      break
  }
  return format(spec)
}

/** `ticks`, `tickFormat` and `nice` over a linear axis, reading the scale's own domain on every call. */
export function withLinearAxis(scale: ScaleObject): ScaleObject {
  scale.ticks = (count?: number) => {
    const d = scale.domain()
    return ticks(d[0], d[d.length - 1], count == null ? 10 : count)
  }
  scale.tickFormat = (count?: number, specifier?: unknown) => {
    const d = scale.domain()
    return tickFormatFor(d[0], d[d.length - 1], count == null ? 10 : count, specifier)
  }
  scale.nice = (count?: number) => {
    const d = scale.domain()
    let lo = 0
    let hi = d.length - 1
    if (d[hi] < d[lo]) [lo, hi] = [hi, lo]
    const ends = roundedEnds(d[lo], d[hi], count == null ? 10 : count)
    if (ends) {
      d[lo] = ends[0]
      d[hi] = ends[1]
      scale.domain(d)
    }
    return scale
  }
  return scale
}

// ---- the continuous kinds ---------------------------------------------------------------------------------

export function linear(): ScaleObject {
  const { scale } = continuousScale()
  scale.copy = () => carry(scale, linear())
  return withLinearAxis(scale)
}
