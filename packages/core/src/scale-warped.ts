/**
 * The continuous scales besides `linear` and the calendar ones: the warped kinds (log, pow, sqrt, symlog), identity, and the colour
 * scales that map stops onto one interpolator (sequential and diverging, of each warp). The engine's `scales` part (engine-parts.ts),
 * which scale.ts reads when a spec makes one; their model and axis members are scale-continuous.ts'.
 *
 * What the callers observe is said in scale-continuous.ts.
 */
import { ticks } from './arr.js'
import { interpolateRound, interpolateValue, piecewise, type Ramp } from './interp.js'
import { format, formatSpecifier } from './format.js'
import { powT, symexpT, symlogT } from './util.js'
import {
  carry, continuousScale, firstThree, firstTwo, FLAT, identity, niceDomain, toNumber, withLinearAxis,
  type Blend, type Mapping, type ScaleObject, type Unary, type Warp,
} from './scale-continuous.js'

// ---- the bends of the warped kinds ------------------------------------------------------------------------

const LOG: Warp = { to: Math.log, from: Math.exp }
const LOG_NEGATIVE: Warp = { to: (x) => -Math.log(-x), from: (y) => -Math.exp(-y) }
const SQRT: Warp = { to: (x) => (x < 0 ? -Math.sqrt(-x) : Math.sqrt(x)), from: (y) => (y < 0 ? -y * y : y * y) }

function powerWarp(exponent: number): Warp {
  return exponent === 1 ? FLAT : exponent === 0.5 ? SQRT : { to: powT(exponent), from: powT(1 / exponent) }
}

const symlogWarp = (c: number): Warp => ({ to: symlogT(c), from: symexpT(c) })


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

function mappedHost(): Host & { model: Mapping } {
  const { scale, model } = continuousScale()
  return { scale, model, bend: (warp) => model.bend(warp) }
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
