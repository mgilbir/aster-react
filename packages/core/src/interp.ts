/**
 * Interpolators: functions that take two values and return a function of t that moves from the first to the
 * second, for numbers, strings with numbers inside, dates, arrays, objects, colours in six spaces, splines and
 * camera paths. A scale's range is walked through one of these, and a colour scheme is a spline of colours.
 *
 * What the callers observe, and so what is fixed here: the arithmetic of every channel (`a + t * d`,
 * `a * (1 - t) + b * t`, `pow(a + t * (b - a), 1 / gamma)`) is evaluated in exactly that form, because the last bit of a
 * colour channel decides the digit of the rounded byte; an interpolator that fills a container (arrays, objects, dates)
 * returns the same container on every call, so a consumer that keeps results sees the latest; a colour that cannot be
 * parsed contributes NaN channels and a NaN channel yields to the other end's.
 */
import { color, Color, Cubehelix, cubehelix, Hcl, hcl, Hsl, hsl, Lab, lab, Rgb, rgbConvert } from './color.js'

export type Ramp<T = unknown> = (t: number) => T
type Blend<T = unknown> = (a: unknown, b: unknown) => Ramp<T>

// ---- single channels --------------------------------------------------------------------------------------

/** A channel that does not move: the start's value, or the end's when the start is NaN. */
function hold(a: number, b: number): Ramp<number> {
  const value = isNaN(a) ? b : a
  return () => value
}

function straight(a: number, b: number): Ramp<number> {
  const d = b - a
  return d ? along(a, d) : hold(a, b)
}

/** The channel blended in a power space: the colour-correct way to mix light. */
function inGamma(y: number): (a: number, b: number) => Ramp<number> {
  y = +y
  if (y === 1) return straight
  return (a, b) => {
    if (!(b - a)) return hold(a, b)
    const from = Math.pow(a, y)
    const span = Math.pow(b, y) - from
    const back = 1 / y
    return (t) => Math.pow(from + t * span, back)
  }
}

/** a + t * d. */
function along(a: number, d: number): Ramp<number> {
  return (t) => a + t * d
}

/** Hue takes the short way round the circle. */
function shortestHue(a: number, b: number): Ramp<number> {
  const d = b - a
  return d ? along(a, d > 180 || d < -180 ? d - 360 * Math.round(d / 360) : d) : hold(a, b)
}

// ---- numbers, text, dates ---------------------------------------------------------------------------------

export function interpolateConstant<T>(x: T): Ramp<T> {
  return () => x
}

export function interpolateNumber(a: number, b: number): Ramp<number> {
  a = +a
  b = +b
  return (t) => a * (1 - t) + b * t
}

export function interpolateRound(a: number, b: number): Ramp<number> {
  a = +a
  b = +b
  return (t) => Math.round(a * (1 - t) + b * t)
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.?\d+)(?:[eE][-+]?\d+)?/g

/**
 * Text in which every number of `b` that has a counterpart in `a` moves, and everything else of `b` stays. Numbers
 * that print the same in both stay literal, so only a changing number costs work per call.
 */
export function interpolateString(a: string, b: string): Ramp<string> {
  const from = (a + '').matchAll(NUMBER)
  const to = b + ''
  const parts: (string | Ramp<number>)[] = []
  const text = (s: string): void => {
    if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += s
    else parts.push(s)
  }
  let cursor = 0
  for (const target of to.matchAll(NUMBER)) {
    const source = from.next()
    if (source.done) break
    if (target.index > cursor) text(to.slice(cursor, target.index))
    if (source.value[0] === target[0]) text(target[0])
    else parts.push(interpolateNumber(+source.value[0], +target[0]))
    cursor = target.index + target[0].length
  }
  if (cursor < to.length) text(to.slice(cursor))
  if (parts.length < 2) {
    const only = parts[0]
    return typeof only === 'function' ? (t) => only(t) + '' : interpolateConstant(to)
  }
  return (t) => {
    let out = ''
    for (const part of parts) out += typeof part === 'string' ? part : String(part(t))
    return out
  }
}

export function interpolateDate(a: Date | number, b: Date | number): Ramp<Date> {
  const shared = new Date()
  a = +a
  b = +b
  return (t) => (shared.setTime(a * (1 - t) + b * t), shared)
}

// ---- containers -------------------------------------------------------------------------------------------

export function isNumberArray(x: unknown): x is ArrayLike<number> {
  return ArrayBuffer.isView(x) && !(x instanceof DataView)
}

export function interpolateNumberArray(a: ArrayLike<number> | null, b: ArrayLike<number> | null): Ramp<number[]> {
  if (!b) b = []
  const paired = a ? Math.min(b.length, a.length) : 0
  const out = (b as unknown as { slice(): number[] }).slice()
  return (t) => {
    for (let i = 0; i < paired; ++i) out[i] = a![i]! * (1 - t) + b![i]! * t
    return out
  }
}

export function interpolateArray(a: readonly unknown[] | null, b: readonly unknown[] | null): Ramp<unknown[]> {
  if (isNumberArray(b)) return interpolateNumberArray(a as ArrayLike<number> | null, b)
  const length = b ? b.length : 0
  const paired = a ? Math.min(length, a.length) : 0
  const moving: Ramp[] = new Array(paired)
  const out = new Array<unknown>(length)
  let i = 0
  for (; i < paired; ++i) moving[i] = interpolateValue(a![i], b![i])
  for (; i < length; ++i) out[i] = b![i]
  return (t) => {
    for (let k = 0; k < paired; ++k) out[k] = moving[k]!(t)
    return out
  }
}

export function interpolateObject(a: Record<string, unknown> | null, b: Record<string, unknown> | null): Ramp<Record<string, unknown>> {
  const from = a !== null && typeof a === 'object' ? a : {}
  const to = b !== null && typeof b === 'object' ? b : {}
  const moving: [string, Ramp][] = []
  const out: Record<string, unknown> = {}
  for (const key in to) {
    if (key in from) moving.push([key, interpolateValue(from[key], to[key]) as Ramp])
    else out[key] = to[key]
  }
  return (t) => {
    for (const [key, ramp] of moving) out[key] = ramp(t)
    return out
  }
}

/** The interpolator for the kind of value `b` is: a colour string or object, a number, a date, an array, an object. */
export function interpolateValue(a: unknown, b: unknown): Ramp {
  const kind = typeof b
  if (b == null || kind === 'boolean') return interpolateConstant(b)
  if (kind === 'number') return interpolateNumber(a as number, b as number)
  if (kind === 'string') {
    const parsed = color(b)
    return parsed ? interpolateRgb(a, parsed) : interpolateString(a as string, b as string)
  }
  if (b instanceof Color) return interpolateRgb(a, b)
  if (b instanceof Date) return interpolateDate(a as Date, b)
  if (isNumberArray(b)) return interpolateNumberArray(a as ArrayLike<number>, b)
  if (Array.isArray(b)) return interpolateArray(a as unknown[], b)
  const o = b as { valueOf?: unknown; toString?: unknown }
  if ((typeof o.valueOf !== 'function' && typeof o.toString !== 'function') || isNaN(b as number)) {
    return interpolateObject(a as Record<string, unknown>, b as Record<string, unknown>)
  }
  return interpolateNumber(a as number, b as number)
}

/** One interpolator through a list of values: t in [0, 1] runs across all of them, each pair getting an equal share. */
export function piecewise(values: readonly unknown[]): Ramp
export function piecewise(blend: Blend, values: readonly unknown[]): Ramp
export function piecewise(...args: unknown[]): Ramp {
  // a missing second argument means the first is the list
  const lone = args[1] === undefined
  const interpolate = (lone ? interpolateValue : args[0]) as Blend
  const values = (lone ? args[0] : args[1]) as readonly unknown[]
  const pieces = values.length - 1
  const I: Ramp[] = new Array(pieces < 0 ? 0 : pieces)
  for (let k = 0, from = values[0]; k < pieces; ) I[k] = interpolate(from, (from = values[++k]))
  return (t) => {
    const scaled = t * pieces
    // (`I[i]` keeps these names: the engine's message for a position that selects no piece, NaN, quotes them)
    const i = Math.max(0, Math.min(pieces - 1, Math.floor(scaled)))
    return I[i]!(scaled - i)
  }
}

// ---- colours ----------------------------------------------------------------------------------------------

type RgbBlend = Blend<string> & { gamma(y: number): RgbBlend }

function rgbInGamma(y: number): RgbBlend {
  const channel = inGamma(y)
  const blend = ((from: unknown, to: unknown) => {
    const a = rgbConvert(from)
    const b = rgbConvert(to)
    const r = channel(a.r, b.r)
    const g = channel(a.g, b.g)
    const bl = channel(a.b, b.b)
    const alpha = straight(a.opacity, b.opacity)
    return (t: number) => new Rgb(r(t), g(t), bl(t), alpha(t)) + ''
  }) as RgbBlend
  blend.gamma = rgbInGamma
  return blend
}

export const interpolateRgb = rgbInGamma(1)

type Triple = readonly [number, number, number]
type Channel = (a: number, b: number) => Ramp<number>

/**
 * Blend two colours in a space of three channels plus opacity. `lift` is the power the position is raised to before
 * it drives the third channel (the cubehelix gamma); 1 leaves it be.
 */
function blendIn<C extends Color>(
  convert: (v: unknown) => C,
  read: (c: C) => Triple,
  make: (c0: number, c1: number, c2: number, opacity: number) => C,
  channels: readonly [Channel, Channel, Channel],
  lift = 1,
): Blend<string> {
  return (from, to) => {
    const a = convert(from)
    const b = convert(to)
    const [a0, a1, a2] = read(a)
    const [b0, b1, b2] = read(b)
    const r0 = channels[0](a0, b0)
    const r1 = channels[1](a1, b1)
    const r2 = channels[2](a2, b2)
    const alpha = straight(a.opacity, b.opacity)
    return (t) => make(r0(t), r1(t), r2(lift === 1 ? t : Math.pow(t, lift)), alpha(t)) + ''
  }
}

const hslBlend = (hue: Channel): Blend<string> =>
  blendIn(hsl as (v: unknown) => Hsl, (c) => [c.h, c.s, c.l], (h, s, l, o) => new Hsl(h, s, l, o), [hue, straight, straight])

const hclBlend = (hue: Channel): Blend<string> =>
  blendIn(hcl as (v: unknown) => Hcl, (c) => [c.h, c.c, c.l], (h, c, l, o) => new Hcl(h, c, l, o), [hue, straight, straight])

type CubehelixBlend = Blend<string> & { gamma(y: number): CubehelixBlend }

function cubehelixBlend(hue: Channel, y = 1): CubehelixBlend {
  const blend = blendIn(cubehelix as (v: unknown) => Cubehelix, (c) => [c.h, c.s, c.l], (h, s, l, o) => new Cubehelix(h, s, l, o), [hue, straight, straight], +y) as CubehelixBlend
  blend.gamma = (next) => cubehelixBlend(hue, next)
  return blend
}

export const interpolateHsl = hslBlend(shortestHue)
export const interpolateHslLong = hslBlend(straight)
export const interpolateHcl = hclBlend(shortestHue)
export const interpolateHclLong = hclBlend(straight)
export const interpolateCubehelix = cubehelixBlend(shortestHue)
export const interpolateCubehelixLong = cubehelixBlend(straight)
export const interpolateLab: Blend<string> = blendIn(lab as (v: unknown) => Lab, (c) => [c.l, c.a, c.b], (l, a, b, o) => new Lab(l, a, b, o), [straight, straight, straight])

/** A hue (degrees) blended the short way and wrapped into [0, 360). */
export function interpolateHue(a: unknown, b: unknown): Ramp<number> {
  const ramp = shortestHue(+(a as number), +(b as number))
  return (t) => {
    const h = ramp(t)
    return h - 360 * Math.floor(h / 360)
  }
}

// ---- splines ----------------------------------------------------------------------------------------------

/** One cubic B-spline segment between v1 and v2, with v0 and v3 as the neighbours, at local position t1 in [0, 1]. */
function cubicBasis(t1: number, v0: number, v1: number, v2: number, v3: number): number {
  const t2 = t1 * t1
  const t3 = t2 * t1
  return ((1 - 3 * t1 + 3 * t2 - t3) * v0 + (4 - 6 * t2 + 3 * t3) * v1 + (1 + 3 * t1 + 3 * t2 - 3 * t3) * v2 + t3 * v3) / 6
}

/** An open uniform B-spline through the values (the ends extrapolate their neighbours). */
export function interpolateBasis(values: ArrayLike<number>): Ramp<number> {
  const last = values.length - 1
  return (t) => {
    const i = t <= 0 ? (t = 0) : t >= 1 ? ((t = 1), last - 1) : Math.floor(t * last)
    const v1 = values[i]!
    const v2 = values[i + 1]!
    const v0 = i > 0 ? values[i - 1]! : 2 * v1 - v2
    const v3 = i < last - 1 ? values[i + 2]! : 2 * v2 - v1
    return cubicBasis((t - i / last) * last, v0, v1, v2, v3)
  }
}

/** A closed uniform B-spline: the values are a loop and t wraps. */
export function interpolateBasisClosed(values: ArrayLike<number>): Ramp<number> {
  const n = values.length
  return (t) => {
    const i = Math.floor(((t %= 1) < 0 ? ++t : t) * n)
    return cubicBasis((t - i / n) * n, values[(i + n - 1) % n]!, values[i % n]!, values[(i + 1) % n]!, values[(i + 2) % n]!)
  }
}

/** A spline through the red, green and blue of a list of colours. The result is opaque, and an empty list is an error. */
function rgbSpline(spline: (values: ArrayLike<number>) => Ramp<number>): (colors: ArrayLike<unknown>) => Ramp<string> {
  return (colors) => {
    const n = colors.length
    const reds = new Array<number>(n)
    const greens = new Array<number>(n)
    const blues = new Array<number>(n)
    let last: Rgb | undefined
    for (let i = 0; i < n; ++i) {
      last = rgbConvert(colors[i])
      reds[i] = last.r || 0
      greens[i] = last.g || 0
      blues[i] = last.b || 0
    }
    const r = spline(reds)
    const g = spline(greens)
    const b = spline(blues)
    // (a spline has no fourth channel: the output is opaque; an empty list has no colour to take that from)
    ;(last as { opacity: number }).opacity = 1
    return (t) => new Rgb(r(t), g(t), b(t), 1) + ''
  }
}

export const interpolateRgbBasis = rgbSpline(interpolateBasis)
export const interpolateRgbBasisClosed = rgbSpline(interpolateBasisClosed)

/** Steps through the items of a list, each holding an equal share of [0, 1]. */
export function interpolateDiscrete<T>(items: ArrayLike<T>): Ramp<T> {
  const n = items.length
  return (t) => items[Math.max(0, Math.min(n - 1, Math.floor(t * n)))]!
}

// ---- smooth zoom ------------------------------------------------------------------------------------------

const cosh = (x: number): number => ((x = Math.exp(x)) + 1 / x) / 2
const sinh = (x: number): number => ((x = Math.exp(x)) - 1 / x) / 2
const tanh = (x: number): number => ((x = Math.exp(2 * x)) - 1) / (x + 1)

type ZoomPath = Ramp<[number, number, number]> & { duration: number }
type ZoomBlend = ((from: ArrayLike<number>, to: ArrayLike<number>) => ZoomPath) & { rho(rho: number): ZoomBlend }

/**
 * The camera path between two views (x, y, width) of van Wijk and Nuij's smooth zoom, for a zoom/pan trade-off `rho`
 * (rho2 and rho4 are its square and fourth power, passed so the default's are exact). `duration` is the natural
 * length of the move in milliseconds.
 */
function zoomWith(rho: number, rho2: number, rho4: number): ZoomBlend {
  const blend = ((from: ArrayLike<number>, to: ArrayLike<number>): ZoomPath => {
    const x0 = from[0]!
    const y0 = from[1]!
    const w0 = from[2]!
    const dx = to[0]! - x0
    const dy = to[1]! - y0
    const w1 = to[2]!
    const d2 = dx * dx + dy * dy
    let path: (t: number) => [number, number, number]
    let length: number
    if (d2 < 1e-12) {
      // the centres coincide: a pure zoom
      length = Math.log(w1 / w0) / rho
      path = (t) => [x0 + t * dx, y0 + t * dy, w0 * Math.exp(rho * t * length)]
    } else {
      const d1 = Math.sqrt(d2)
      const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1)
      const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1)
      const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
      const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
      length = (r1 - r0) / rho
      path = (t) => {
        const s = t * length
        const coshR0 = cosh(r0)
        const u = (w0 / (rho2 * d1)) * (coshR0 * tanh(rho * s + r0) - sinh(r0))
        return [x0 + u * dx, y0 + u * dy, (w0 * coshR0) / cosh(rho * s + r0)]
      }
    }
    return Object.assign(path, { duration: (length * 1000 * rho) / Math.SQRT2 })
  }) as ZoomBlend
  blend.rho = (r) => {
    const clamped = Math.max(1e-3, +r)
    const squared = clamped * clamped
    return zoomWith(clamped, squared, squared * squared)
  }
  return blend
}

export const interpolateZoom = zoomWith(Math.SQRT2, 2, 4)
