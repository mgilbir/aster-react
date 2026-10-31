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
import { interpolateNumber, interpolateRound, interpolateValue, piecewise, type Ramp } from './interp.js'
import {
  format,
  formatPrefix,
  formatSpecifier,
  precisionFixed,
  precisionPrefix,
  precisionRound,
  type FormatFunction,
} from './format.js'
import {
  durationDay,
  durationHour,
  durationMinute,
  durationMonth,
  durationSecond,
  durationWeek,
  durationYear,
  millisecond,
  second,
  timeDay,
  timeHour,
  timeMinute,
  timeMonth,
  timeWeek,
  timeYear,
  unixDay,
  utcDay,
  utcHour,
  utcMinute,
  utcMonth,
  utcWeek,
  utcYear,
  type TimeInterval,
} from './time.js'
import { timeFormat, utcFormat } from './time-format.js'

/** A scale: a function with the members its kind carries. */
export interface ScaleObject {
  (x: unknown): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any
}

type Unary = (x: number) => number
export type Blend = (a: unknown, b: unknown) => Ramp

/** A member that reads with no argument and writes with one, returning the scale. */
export function accessor<T>(self: ScaleObject, read: () => T, write: (value: T) => void): (...value: [T?]) => unknown {
  return (...value) => (value.length ? (write(value[0] as T), self) : read())
}

const identity = <T>(x: T): T => x
const toNumber = (x: unknown): number => +(x as number)

/**
 * The first two, or three, entries of an iterable. Taken through a parameter pattern so that a value that is not iterable
 * fails with the engine's plain message (`undefined is not iterable (cannot ...)`), which is what a user's log shows.
 */
export const firstTwo = ([a, b]: Iterable<unknown>): [unknown, unknown] => [a, b]
export const firstThree = ([a, b, c]: Iterable<unknown>): [unknown, unknown, unknown] => [a, b, c]

// ---- the bend ---------------------------------------------------------------------------------------------

/** What a scale does to a domain value before interpolating, and its inverse. */
interface Warp {
  to: Unary
  from: Unary
}

const FLAT: Warp = { to: identity, from: identity }
const LOG: Warp = { to: Math.log, from: Math.exp }
const LOG_NEGATIVE: Warp = { to: (x) => -Math.log(-x), from: (y) => -Math.exp(-y) }
const SQRT: Warp = { to: (x) => (x < 0 ? -Math.sqrt(-x) : Math.sqrt(x)), from: (y) => (y < 0 ? -y * y : y * y) }

const signedPower = (exponent: number): Unary => (x) => (x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent))

function powerWarp(exponent: number): Warp {
  return exponent === 1 ? FLAT : exponent === 0.5 ? SQRT : { to: signedPower(exponent), from: signedPower(1 / exponent) }
}

function symlogWarp(c: number): Warp {
  return {
    to: (x) => Math.sign(x) * Math.log1p(Math.abs(x / c)),
    from: (y) => Math.sign(y) * Math.expm1(Math.abs(y)) * c,
  }
}

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

class Mapping {
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

// ---- warps with a parameter: base, exponent, constant -----------------------------------------------------

/** What the scale must offer for a warp parameter to be set on it. */
interface Host {
  scale: ScaleObject
  bend(warp: Warp): void
}

const pow10 = (x: number): number => (isFinite(x) ? +('1e' + x) : x < 0 ? 0 : x)
const reflect = (f: Unary): Unary => (x) => -f(-x)

function logarithmOf(base: number): Unary {
  if (base === Math.E) return Math.log
  if (base === 10) return Math.log10
  if (base === 2) return Math.log2
  const divisor = Math.log(base)
  return (x) => Math.log(x) / divisor
}

function powerOf(base: number): Unary {
  return base === 10 ? pow10 : base === Math.E ? Math.exp : (x) => Math.pow(base, x)
}

/** Logarithmic ticks, nice and tickFormat; the base and, for a negative domain, a mirrored logarithm. */
function withLogAxis(host: Host): ScaleObject {
  const { scale } = host
  const plainDomain = scale.domain
  let base = 10
  let logs: Unary = logarithmOf(10)
  let pows: Unary = powerOf(10)

  const retune = (): void => {
    const negative = scale.domain()[0] < 0
    logs = negative ? reflect(logarithmOf(base)) : logarithmOf(base)
    pows = negative ? reflect(powerOf(base)) : powerOf(base)
    host.bend(negative ? LOG_NEGATIVE : LOG)
  }
  retune()

  scale.base = (...v: [number?]) => (v.length ? ((base = +v[0]!), retune(), scale) : base)
  scale.domain = (...v: unknown[]) => (v.length ? (plainDomain(...v), retune(), scale) : plainDomain())

  scale.ticks = (count?: number) => {
    const d = scale.domain()
    const reversed = d[d.length - 1] < d[0]
    const lo = reversed ? d[d.length - 1] : d[0]
    const hi = reversed ? d[0] : d[d.length - 1]
    const want = count == null ? 10 : +count
    let i = logs(lo)
    let j = logs(hi)
    let found: number[] = []
    if (!(base % 1) && j - i < want) {
      // a whole base: every integer multiple of every power inside the domain
      i = Math.floor(i)
      j = Math.ceil(j)
      if (lo > 0) {
        for (; i <= j; ++i) {
          for (let k = 1; k < base; ++k) {
            const t = i < 0 ? k / pows(-i) : k * pows(i)
            if (t < lo) continue
            if (t > hi) break
            found.push(t)
          }
        }
      } else {
        for (; i <= j; ++i) {
          for (let k = base - 1; k >= 1; --k) {
            const t = i > 0 ? k / pows(-i) : k * pows(i)
            if (t < lo) continue
            if (t > hi) break
            found.push(t)
          }
        }
      }
      if (found.length * 2 < want) found = ticks(lo, hi, want)
    } else {
      found = ticks(i, j, Math.min(j - i, want)).map((v) => pows(v))
    }
    return reversed ? found.reverse() : found
  }

  scale.tickFormat = (count?: number, specifier?: unknown) => {
    if (count == null) count = 10
    if (specifier == null) specifier = base === 10 ? 's' : ','
    let write: (value: number) => string
    if (typeof specifier === 'function') {
      write = specifier as typeof write
    } else if (!(base % 1)) {
      const spec = formatSpecifier(specifier)
      if (spec.precision == null) spec.trim = true
      write = format(spec)
    } else {
      write = format(specifier)
    }
    if (count === Infinity) return write
    // only the ticks that sit on a leading digit small enough for the room get a label
    const room = Math.max(1, (base * count) / scale.ticks().length)
    return (value: number) => {
      let lead = value / pows(Math.round(logs(value)))
      if (lead * base < base - 0.5) lead *= base
      return lead <= room ? write(value) : ''
    }
  }

  scale.nice = () =>
    scale.domain(niceDomain(scale.domain(), { floor: (x) => pows(Math.floor(logs(x))), ceil: (x) => pows(Math.ceil(logs(x))) }))

  return scale
}

/** The exponent of a power scale. */
function withExponent(host: Host): ScaleObject {
  const { scale } = host
  let exponent = 1
  scale.exponent = (...v: [number?]) => (v.length ? ((exponent = +v[0]!), host.bend(powerWarp(exponent)), scale) : exponent)
  return withLinearAxis(scale)
}

/** The constant of a symlog scale. */
function withConstant(host: Host): ScaleObject {
  const { scale } = host
  let c = 1
  host.bend(symlogWarp(c))
  scale.constant = (...v: [number?]) => (v.length ? ((c = +v[0]!), host.bend(symlogWarp(c)), scale) : c)
  return withLinearAxis(scale)
}

// ---- the continuous kinds ---------------------------------------------------------------------------------

function mappedHost(): Host & { model: Mapping } {
  const { scale, model } = continuousScale()
  return { scale, model, bend: (warp) => model.bend(warp) }
}

export function linear(): ScaleObject {
  const { scale } = continuousScale()
  scale.copy = () => carry(scale, linear())
  return withLinearAxis(scale)
}

export function log(): ScaleObject {
  const host = mappedHost()
  const scale = withLogAxis(host)
  scale.domain([1, 10])
  scale.copy = () => carry(scale, log()).base(scale.base())
  return scale
}

export function pow(): ScaleObject {
  const scale = withExponent(mappedHost())
  scale.copy = () => carry(scale, pow()).exponent(scale.exponent())
  return scale
}

export function sqrt(): ScaleObject {
  return pow().exponent(0.5)
}

export function symlog(): ScaleObject {
  const scale = withConstant(mappedHost())
  scale.copy = () => carry(scale, symlog()).constant(scale.constant())
  return scale
}

/** The scale of identity: the domain and the range are the same list, and a value maps to itself. */
export function identityScale(): ScaleObject {
  let list: number[] = [0, 1]
  let fallback: unknown
  const scale = ((x: unknown) => (x == null || isNaN((x = +(x as number))) ? fallback : x)) as ScaleObject
  scale.invert = scale
  scale.domain = scale.range = (...v: [Iterable<unknown>?]) => (v.length ? ((list = Array.from(v[0]!, toNumber)), scale) : list.slice())
  scale.unknown = (...v: [unknown?]) => (v.length ? ((fallback = v[0]), scale) : fallback)
  scale.copy = () => identityScale().domain(list).unknown(fallback)
  return withLinearAxis(scale)
}

// ---- colour scales: stops onto one interpolator ----------------------------------------------------------

class Gradient {
  stops: number[]
  warped: number[] = []
  rise = [0, 0]
  side = 1
  ramp: Ramp = identity
  clamped = false
  fallback: unknown = undefined
  warp: Warp = FLAT

  constructor(readonly arity: 2 | 3) {
    this.stops = arity === 2 ? [0, 1] : [0, 0.5, 1]
    this.refresh()
  }

  /** The warped stops and the slope on each side of the middle; recomputed whenever the stops or the warp change. */
  refresh(): void {
    const w = (this.warped = this.stops.map(this.warp.to))
    if (this.arity === 2) {
      this.rise = [w[0] === w[1] ? 0 : 1 / (w[1]! - w[0]!)]
    } else {
      this.rise = [w[0] === w[1] ? 0 : 0.5 / (w[1]! - w[0]!), w[1] === w[2] ? 0 : 0.5 / (w[2]! - w[1]!)]
      this.side = w[1]! < w[0]! ? -1 : 1
    }
  }

  bend(warp: Warp): void {
    this.warp = warp
    this.refresh()
  }

  setStops(v: Iterable<unknown>): void {
    // only the first `arity` entries are read, whatever else the iterable holds
    this.stops = (this.arity === 2 ? firstTwo(v) : firstThree(v)).map(toNumber)
    this.refresh()
  }

  getRange(): unknown[] {
    const interpolator = this.ramp
    return this.arity === 2 ? [interpolator(0), interpolator(1)] : [interpolator(0), interpolator(0.5), interpolator(1)]
  }

  setRange(v: Iterable<unknown>, blend: Blend): void {
    if (this.arity === 2) {
      const [a, b] = firstTwo(v)
      this.ramp = blend(a, b)
    } else {
      this.ramp = piecewise(blend, firstThree(v))
    }
  }

  private bounded(v: number): number {
    return this.clamped ? Math.max(0, Math.min(1, v)) : v
  }

  map(value: unknown): unknown {
    // (named for what it is: the engine's message for a missing interpolator quotes this name)
    const { warp, warped, rise, ramp: interpolator } = this
    if (this.arity === 2) {
      if (value == null || isNaN((value = +(value as number)))) return this.fallback
      return interpolator(rise[0] === 0 ? 0.5 : this.bounded((warp.to(value as number) - warped[0]!) * rise[0]!))
    }
    if (isNaN((value = +(value as number)))) return this.fallback
    const t = +warp.to(value as number)
    const v = 0.5 + (t - warped[1]!) * (this.side * t < this.side * warped[1]! ? rise[0]! : rise[1]!)
    return interpolator(this.bounded(v))
  }
}

/** Members of a colour scale; `blend` turns a range of two (three) endpoints into the interpolator. */
function gradientScale(arity: 2 | 3): { scale: ScaleObject; model: Gradient } {
  const model = new Gradient(arity)
  const scale = ((x: unknown) => model.map(x)) as ScaleObject
  scale.domain = (...v: [Iterable<unknown>?]) => (v.length ? (model.setStops(v[0]!), scale) : model.stops.slice())
  scale.clamp = (...v: [unknown?]) => (v.length ? ((model.clamped = !!v[0]), scale) : model.clamped)
  scale.interpolator = (...v: [Ramp?]) => (v.length ? ((model.ramp = v[0]!), scale) : model.ramp)
  scale.range = (...v: [Iterable<unknown>?]) => (v.length ? (model.setRange(v[0]!, interpolateValue as Blend), scale) : model.getRange())
  scale.rangeRound = (...v: [Iterable<unknown>?]) => (v.length ? (model.setRange(v[0]!, interpolateRound as Blend), scale) : model.getRange())
  scale.unknown = (...v: [unknown?]) => (v.length ? ((model.fallback = v[0]), scale) : model.fallback)
  return { scale, model }
}

function carryGradient(from: ScaleObject, to: ScaleObject): ScaleObject {
  return to.domain(from.domain()).interpolator(from.interpolator()).clamp(from.clamp()).unknown(from.unknown())
}

/** One colour scale of a given warp family. `domain` is the default stops of the logarithmic kind. */
function gradientKind(arity: 2 | 3, family: 'linear' | 'log' | 'pow' | 'symlog', make: () => ScaleObject): ScaleObject {
  const { scale, model } = gradientScale(arity)
  const host: Host = { scale, bend: (warp) => model.bend(warp) }
  if (family === 'log') {
    withLogAxis(host)
    scale.domain(arity === 2 ? [1, 10] : [0.1, 1, 10])
    scale.copy = () => carryGradient(scale, make()).base(scale.base())
  } else if (family === 'pow') {
    withExponent(host)
    scale.copy = () => carryGradient(scale, make()).exponent(scale.exponent())
  } else if (family === 'symlog') {
    withConstant(host)
    scale.copy = () => carryGradient(scale, make()).constant(scale.constant())
  } else {
    withLinearAxis(scale)
    scale.copy = () => carryGradient(scale, make())
  }
  return scale
}

export const sequential = (): ScaleObject => gradientKind(2, 'linear', sequential)
export const sequentialLog = (): ScaleObject => gradientKind(2, 'log', sequentialLog)
export const sequentialPow = (): ScaleObject => gradientKind(2, 'pow', sequentialPow)
export const sequentialSqrt = (): ScaleObject => sequentialPow().exponent(0.5)
export const sequentialSymlog = (): ScaleObject => gradientKind(2, 'symlog', sequentialSymlog)
export const diverging = (): ScaleObject => gradientKind(3, 'linear', diverging)
export const divergingLog = (): ScaleObject => gradientKind(3, 'log', divergingLog)
export const divergingPow = (): ScaleObject => gradientKind(3, 'pow', divergingPow)
export const divergingSqrt = (): ScaleObject => divergingPow().exponent(0.5)
export const divergingSymlog = (): ScaleObject => gradientKind(3, 'symlog', divergingSymlog)

// ---- calendar scales: time and UTC ----------------------------------------------------------------------

// The calendar scales: continuous scales over instants (milliseconds since the epoch), in local time (`time`) or in UTC
// (`utc`). The domain reads back as Dates, an inverted value is a Date, ticks fall on calendar boundaries (a day starts at
// midnight of the scale's zone), and the default label for a tick is the coarsest unit the instant sits exactly on.
//
// What the callers observe, and so what is fixed here: the ladder of tick intervals (1, 5, 15, 30 seconds; 1, 5, 15, 30
// minutes; 1, 3, 6, 12 hours; 1, 2 days; a week; 1, 3 months; a year) and the rule that chooses a rung: the one whose span
// is nearer the wanted step in ratio, with milliseconds below the ladder and multi-year steps above it; and that the UTC
// ladder counts days from the epoch (so its two-day tick falls on even epoch days, which is not "every second date").

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

/** The rungs of the tick ladder: a unit and the multiples of it that are ticks. */
const LADDER: readonly (readonly [Unit, readonly number[]])[] = [
  ['second', [1, 5, 15, 30]],
  ['minute', [1, 5, 15, 30]],
  ['hour', [1, 3, 6, 12]],
  ['day', [1, 2]],
  ['week', [1]],
  ['month', [1, 3]],
  ['year', [1]],
]

const UNIT_MS: Record<Unit, number> = {
  second: durationSecond,
  minute: durationMinute,
  hour: durationHour,
  day: durationDay,
  week: durationWeek,
  month: durationMonth,
  year: durationYear,
}

interface Zone {
  units: Record<Unit, TimeInterval>
  /** The interval whose multiples the ladder's day rung counts (the epoch's days for UTC, calendar days locally). */
  ladderDay: TimeInterval
  format: (specifier: string) => (date: Date) => string
}

const LOCAL: Zone = {
  units: { second, minute: timeMinute, hour: timeHour, day: timeDay, week: timeWeek, month: timeMonth, year: timeYear },
  ladderDay: timeDay,
  format: timeFormat as Zone['format'],
}

const UTC: Zone = {
  units: { second, minute: utcMinute, hour: utcHour, day: utcDay, week: utcWeek, month: utcMonth, year: utcYear },
  ladderDay: unixDay,
  format: utcFormat as Zone['format'],
}

interface Rung {
  interval: TimeInterval
  step: number
}

const ladders = new Map<Zone, { rungs: Rung[]; spans: number[] }>()

/** The tick ladder of a zone: its rungs and the span each covers (built once). */
function ladderOf(zone: Zone): { rungs: Rung[]; spans: number[] } {
  let ladder = ladders.get(zone)
  if (!ladder) {
    const rungs: Rung[] = []
    const spans: number[] = []
    for (const [unit, steps] of LADDER) {
      for (const step of steps) {
        rungs.push({ interval: unit === 'day' ? zone.ladderDay : zone.units[unit], step })
        spans.push(step * UNIT_MS[unit])
      }
    }
    ladders.set(zone, (ladder = { rungs, spans }))
  }
  return ladder
}

const msOf = (t: unknown): number => (t instanceof Date ? +t : +new Date(+(t as number)))

function calendarScale(zone: Zone, copy: () => ScaleObject): ScaleObject {
  const { scale } = continuousScale()
  const { rungs, spans } = ladderOf(zone)
  const { year, month, week, day, hour, minute, second: sec } = zone.units
  const asInstants = scale.domain
  const asInverse = scale.invert

  /** The interval that puts about `count` ticks between two instants. */
  const pick = (start: number, stop: number, count: unknown): TimeInterval | null => {
    const target = Math.abs(stop - start) / (count as number)
    const at = bisectRight(spans, target)
    if (at === rungs.length) return year.every!(tickStep(start / durationYear, stop / durationYear, count as number))
    if (at === 0) return millisecond.every!(Math.max(tickStep(start, stop, count as number), 1))
    const nearer = target / spans[at - 1]! < spans[at]! / target ? rungs[at - 1]! : rungs[at]!
    return nearer.interval.every!(nearer.step)
  }

  const isInterval = (x: unknown): x is TimeInterval => !!x && typeof (x as TimeInterval).range === 'function'

  const listTicks = (start: number, stop: number, count: unknown): Date[] => {
    const reversed = stop < start
    if (reversed) [start, stop] = [stop, start]
    const interval = isInterval(count) ? count : pick(start, stop, count)
    const dates = interval ? interval.range(start, +stop + 1) : []
    return reversed ? dates.reverse() : dates
  }

  const asMillisecond = zone.format('.%L')
  const asSecond = zone.format(':%S')
  const asMinute = zone.format('%I:%M')
  const asHour = zone.format('%I %p')
  const asDay = zone.format('%a %d')
  const asWeek = zone.format('%b %d')
  const asMonth = zone.format('%B')
  const asYear = zone.format('%Y')

  /** The default label: the coarsest unit the date sits on, read off the finest-first ladder of "is it exactly on it". */
  const labelFor = (d: Date): string => {
    const write =
      sec(d) < d ? asMillisecond
      : minute(d) < d ? asSecond
      : hour(d) < d ? asMinute
      : day(d) < d ? asHour
      : month(d) < d ? (week(d) < d ? asDay : asWeek)
      : year(d) < d ? asMonth
      : asYear
    return write(d)
  }

  scale.invert = (y: unknown) => new Date(asInverse(y) as number)
  scale.domain = (...v: [Iterable<unknown>?]) =>
    v.length ? (asInstants(Array.from(v[0]!, msOf)), scale) : (asInstants() as number[]).map((t) => new Date(t))
  scale.ticks = (interval?: unknown) => {
    const d = asInstants() as number[]
    return listTicks(d[0]!, d[d.length - 1]!, interval == null ? 10 : interval)
  }
  scale.tickFormat = (_count?: number, specifier?: string) => (specifier == null ? labelFor : zone.format(specifier))
  scale.nice = (interval?: unknown) => {
    const d = asInstants() as number[]
    const chosen = isInterval(interval) ? interval : pick(d[0]!, d[d.length - 1]!, interval == null ? 10 : interval)
    if (!chosen) return scale
    return asInstants(niceDomain(d, { floor: (x) => +chosen.floor(x as unknown as Date), ceil: (x) => +chosen.ceil(x as unknown as Date) }))
  }
  scale.copy = () => carry(scale, copy())
  return scale
}

export function time(): ScaleObject {
  return calendarScale(LOCAL, time).domain([new Date(2000, 0, 1), new Date(2000, 0, 2)])
}

export function utcTime(): ScaleObject {
  return calendarScale(UTC, utcTime).domain([Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2)])
}
