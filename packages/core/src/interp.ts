/**
 * d3-interpolate subset (3.0.1): the interpolators d3-scale and vega-scale
 * schemes rely on. Faithful transcription verified against oracle vectors
 * recorded from pinned d3-interpolate@3.0.1.
 */
import { color, Color as ColorInstance, cubehelix, hcl, hsl, lab, rgbConvert, type Rgb } from './color.js'

export function interpolateConstant<T>(x: T): (t: number) => T {
  return () => x
}

export function interpolateNumber(a: number, b: number): (t: number) => number {
  return (a = +a, b = +b), function (t) {
    return a * (1 - t) + b * t
  }
}

export function interpolateRound(a: number, b: number): (t: number) => number {
  return (a = +a, b = +b), function (t) {
    return Math.round(a * (1 - t) + b * t)
  }
}

const reA = /[-+]?(?:\d+\.?\d*|\.?\d+)(?:[eE][-+]?\d+)?/g
const reB = new RegExp(reA.source, 'g')

export function interpolateString(a: string, b: string): (t: number) => string {
  let bi = (reA.lastIndex = reB.lastIndex = 0) // scan index for next number in b
  let am: RegExpExecArray | null // current match in a
  let bm: RegExpExecArray | null // current match in b
  let bs: string // string preceding current number in b, if any
  let i = -1 // index in s
  const s: (string | null)[] = [] // string constants and placeholders
  const q: { i: number; x: (t: number) => number }[] = [] // number interpolators
  // Coerce inputs to strings.
  a = a + ''
  b = b + ''
  // Interpolate pairs of numbers in a & b.
  while ((am = reA.exec(a)) && (bm = reB.exec(b))) {
    if (bm.index > bi) {
      // a string precedes the next number in b
      bs = b.slice(bi, bm.index)
      if (s[i]) s[i]! += bs
      else s[++i] = bs
    }
    const amS = am[0]
    const bmS = bm[0]
    if (amS === bmS) {
      // numbers in a & b match
      if (s[i]) s[i]! += bmS
      else s[++i] = bmS
    } else {
      // interpolate non-matching numbers
      s[++i] = null
      q.push({ i, x: interpolateNumber(+amS, +bmS) })
    }
    bi = reB.lastIndex
  }
  // Add remains of b.
  if (bi < b.length) {
    bs = b.slice(bi)
    if (s[i]) s[i]! += bs
    else s[++i] = bs
  }
  // Special optimization for only a single match.
  // Otherwise, interpolate each of the numbers and rejoin the string.
  if (s.length < 2) return q[0] ? one(q[0].x) : interpolateConstant(b)
  return function (t) {
    for (let j = 0; j < q.length; ++j) {
      const o = q[j]!
      s[o.i] = String(o.x(t))
    }
    return s.join('')
  }
}

function one(b: (t: number) => number): (t: number) => string {
  return function (t) {
    return b(t) + ''
  }
}

// ---- color interpolation (color.js + rgb.js) --------------------------------

function linear(a: number, d: number): (t: number) => number {
  return function (t) {
    return a + t * d
  }
}

function exponential(a: number, b: number, y: number): (t: number) => number {
  return (a = Math.pow(a, y)), (b = Math.pow(b, y) - a), (y = 1 / y), function (t) {
    return Math.pow(a + t * b, y)
  }
}

function interpolateConstantNum(a: number, b: number): (t: number) => number {
  return isNaN(a) ? () => b : () => a
}

export function nogamma(a: number, b: number): (t: number) => number {
  const d = b - a
  return d ? linear(a, d) : interpolateConstantNum(a, b)
}

export function gamma(y: number): (a: number, b: number) => (t: number) => number {
  return (y = +y) === 1
    ? nogamma
    : function (a, b) {
        return b - a ? exponential(a, b, y) : interpolateConstantNum(isNaN(a) ? b : a, b)
      }
}

export function interpolateRgbGamma(y: number): ((a: unknown, b: unknown) => (t: number) => string) & { gamma(y: number): (a: unknown, b: unknown) => (t: number) => string } {
  const colorInterp = gamma(y)
  function rgb(start: unknown, end: unknown): (t: number) => string {
    // start becomes the mutable accumulator (d3 reuses the parsed start color)
    const s = rgbConvert(start) as Rgb & { r: number; g: number; b: number; opacity: number }
    const e = rgbConvert(end)
    const r = colorInterp(s.r, e.r)
    const g = colorInterp(s.g, e.g)
    const b = colorInterp(s.b, e.b)
    const opacity = nogamma(s.opacity, e.opacity)
    return function (t) {
      s.r = r(t)
      s.g = g(t)
      s.b = b(t)
      s.opacity = opacity(t)
      return s + ''
    }
  }
  rgb.gamma = interpolateRgbGamma
  return rgb as typeof rgb & { gamma(y: number): (a: unknown, b: unknown) => (t: number) => string }
}

export const interpolateRgb = interpolateRgbGamma(1)

export function interpolateDate(a: Date | number, b: Date | number): (t: number) => Date {
  const d = new Date()
  return (a = +a), (b = +b), function (t) {
    return d.setTime(a * (1 - t) + b * t), d
  }
}

export function interpolateNumberArray(a: ArrayLike<number> | null, b: ArrayLike<number> | null): (t: number) => number[] {
  if (!b) b = []
  const n = a ? Math.min(b.length, a.length) : 0
  const c = Array.from<number>(b as ArrayLike<number>)
  let i: number
  return function (t) {
    for (i = 0; i < n; ++i) c[i] = (a as ArrayLike<number>)[i]! * (1 - t) + (b as ArrayLike<number>)[i]! * t
    return c
  }
}

export function isNumberArray(x: unknown): x is ArrayLike<number> {
  return ArrayBuffer.isView(x) && !(x instanceof DataView)
}

export function interpolateArray(a: readonly unknown[] | null, b: readonly unknown[] | null): (t: number) => unknown[] {
  const nb = b ? b.length : 0
  const na = a ? Math.min(nb, a.length) : 0
  const x = new Array<unknown>(na)
  const c = new Array<unknown>(nb)
  let i: number
  for (i = 0; i < na; ++i) x[i] = interpolateValue(a![i], b![i])
  for (; i < nb; ++i) c[i] = b![i]
  return function (t) {
    for (i = 0; i < na; ++i) c[i] = (x[i] as (t: number) => unknown)(t)
    return c
  }
}

export function interpolateObject(a: Record<string, unknown> | null, b: Record<string, unknown> | null): (t: number) => Record<string, unknown> {
  const i: Record<string, (t: number) => unknown> = {}
  const c: Record<string, unknown> = {}
  let k: string
  if (a === null || typeof a !== 'object') a = {}
  if (b === null || typeof b !== 'object') b = {}
  for (k in b) {
    if (k in a) {
      i[k] = interpolateValue(a[k], b[k]) as (t: number) => unknown
    } else {
      c[k] = b[k]
    }
  }
  return function (t) {
    for (k in i) c[k] = (i[k] as (t: number) => unknown)(t)
    return c
  }
}

export default interpolateValue

/**
 * The generic value interpolator (d3-interpolate's `interpolate`).
 */
export function interpolateValue(a: unknown, b: unknown): (t: number) => unknown {
  const t = typeof b
  let c: unknown
  if (b == null || t === 'boolean') return interpolateConstant(b)
  if (t === 'number') return interpolateNumber(a as number, b as number)
  if (t === 'string') {
    c = color(b as string)
    return c ? interpolateRgb(a, c as Rgb) : interpolateString(a as string, b as string)
  }
  if (b instanceof ColorInstance) return interpolateRgb(a, b as Rgb)
  if (b instanceof Date) return interpolateDate(a as Date, b)
  if (isNumberArray(b)) return interpolateNumberArray(a as ArrayLike<number>, b)
  if (Array.isArray(b)) return interpolateArray(a as readonly unknown[], b)
  if ((typeof (b as { valueOf?: unknown }).valueOf !== 'function' && typeof (b as { toString?: unknown }).toString !== 'function') || isNaN(b as number)) {
    return interpolateObject(a as Record<string, unknown>, b as Record<string, unknown>)
  }
  return interpolateNumber(a as number, b as number)
}

// ---- piecewise --------------------------------------------------------------

export function piecewise(interpolate: (a: unknown, b: unknown) => unknown, values: readonly unknown[]): (t: number) => unknown
export function piecewise(values: readonly unknown[]): (t: number) => unknown
export function piecewise(...args: unknown[]): (t: number) => unknown {
  let interpolate = args[0] as (a: unknown, b: unknown) => unknown
  let values: readonly unknown[]
  if (args.length === 1) {
    values = interpolate as unknown as readonly unknown[]
    interpolate = interpolateValue
  } else {
    values = args[1] as readonly unknown[]
  }
  let i = 0
  const n = values.length - 1
  let v = values[0]
  const I = new Array<unknown>(n < 0 ? 0 : n)
  while (i < n) I[i] = interpolate(v, (v = values[++i]))
  return function (t) {
    const i = Math.max(0, Math.min(n - 1, Math.floor((t *= n))))
    return (I[i] as (t: number) => unknown)(t - i)
  }
}

// ---- the remaining colour-space / spline interpolators (hue.js, hsl.js, lab.js,
// hcl.js, cubehelix.js, basis*.js, rgb.js splines, discrete.js, hue.js, zoom.js) ----

function constantOf(x: number): (t: number) => number {
  return () => x
}

/** d3 colour.js `hue`: the shortest arc between two hues (an achromatic endpoint holds the other). */
export function hue(a: number, b: number): (t: number) => number {
  const d = b - a
  return d ? linear(a, d > 180 || d < -180 ? d - 360 * Math.round(d / 360) : d) : constantOf(isNaN(a) ? b : a)
}

/** d3-interpolate `interpolateHue`: hue() wrapped into [0, 360). */
export function interpolateHue(a: unknown, b: unknown): (t: number) => number {
  const i = hue(+(a as number), +(b as number))
  return function (t) {
    const x = i(t)
    return x - 360 * Math.floor(x / 360)
  }
}

type ColorInterp = (a: unknown, b: unknown) => (t: number) => string

function hslLike(hueFn: (a: number, b: number) => (t: number) => number): ColorInterp {
  return function (start, end) {
    const s0 = hsl(start)
    const e0 = hsl(end)
    const h = hueFn(s0.h, e0.h)
    const s = nogamma(s0.s, e0.s)
    const l = nogamma(s0.l, e0.l)
    const opacity = nogamma(s0.opacity, e0.opacity)
    return function (t) {
      Object.assign(s0, { h: h(t), s: s(t), l: l(t), opacity: opacity(t) })
      return s0 + ''
    }
  }
}

function hclLike(hueFn: (a: number, b: number) => (t: number) => number): ColorInterp {
  return function (start, end) {
    const s0 = hcl(start)
    const e0 = hcl(end)
    const h = hueFn(s0.h, e0.h)
    const c = nogamma(s0.c, e0.c)
    const l = nogamma(s0.l, e0.l)
    const opacity = nogamma(s0.opacity, e0.opacity)
    return function (t) {
      Object.assign(s0, { h: h(t), c: c(t), l: l(t), opacity: opacity(t) })
      return s0 + ''
    }
  }
}

export const interpolateHsl: ColorInterp = hslLike(hue)
export const interpolateHslLong: ColorInterp = hslLike(nogamma)
export const interpolateHcl: ColorInterp = hclLike(hue)
export const interpolateHclLong: ColorInterp = hclLike(nogamma)

export function interpolateLab(start: unknown, end: unknown): (t: number) => string {
  const s0 = lab(start)
  const e0 = lab(end)
  const l = nogamma(s0.l, e0.l)
  const a = nogamma(s0.a, e0.a)
  const b = nogamma(s0.b, e0.b)
  const opacity = nogamma(s0.opacity, e0.opacity)
  return function (t) {
    Object.assign(s0, { l: l(t), a: a(t), b: b(t), opacity: opacity(t) })
    return s0 + ''
  }
}

type CubehelixInterp = ((a: unknown, b: unknown) => (t: number) => string) & { gamma(y: number): CubehelixInterp }

function cubehelixLike(hueFn: (a: number, b: number) => (t: number) => number): CubehelixInterp {
  const make = (y: number): CubehelixInterp => {
    y = +y
    const fn = function (start: unknown, end: unknown): (t: number) => string {
      const s0 = cubehelix(start)
      const e0 = cubehelix(end)
      const h = hueFn(s0.h, e0.h)
      const s = nogamma(s0.s, e0.s)
      const l = nogamma(s0.l, e0.l)
      const opacity = nogamma(s0.opacity, e0.opacity)
      return function (t) {
        Object.assign(s0, { h: h(t), s: s(t), l: l(Math.pow(t, y)), opacity: opacity(t) })
        return s0 + ''
      }
    } as CubehelixInterp
    fn.gamma = make
    return fn
  }
  return make(1)
}

export const interpolateCubehelix = cubehelixLike(hue)
export const interpolateCubehelixLong = cubehelixLike(nogamma)

function basisAt(t1: number, v0: number, v1: number, v2: number, v3: number): number {
  const t2 = t1 * t1
  const t3 = t2 * t1
  return ((1 - 3 * t1 + 3 * t2 - t3) * v0 + (4 - 6 * t2 + 3 * t3) * v1 + (1 + 3 * t1 + 3 * t2 - 3 * t3) * v2 + t3 * v3) / 6
}

export function interpolateBasis(values: ArrayLike<number>): (t: number) => number {
  const n = values.length - 1
  return function (t) {
    const i = t <= 0 ? (t = 0) : t >= 1 ? ((t = 1), n - 1) : Math.floor(t * n)
    const v1 = values[i]!
    const v2 = values[i + 1]!
    const v0 = i > 0 ? values[i - 1]! : 2 * v1 - v2
    const v3 = i < n - 1 ? values[i + 2]! : 2 * v2 - v1
    return basisAt((t - i / n) * n, v0, v1, v2, v3)
  }
}

export function interpolateBasisClosed(values: ArrayLike<number>): (t: number) => number {
  const n = values.length
  return function (t) {
    const i = Math.floor(((t %= 1) < 0 ? ++t : t) * n)
    const v0 = values[(i + n - 1) % n]!
    const v1 = values[i % n]!
    const v2 = values[(i + 1) % n]!
    const v3 = values[(i + 2) % n]!
    return basisAt((t - i / n) * n, v0, v1, v2, v3)
  }
}

function rgbSpline(spline: (values: ArrayLike<number>) => (t: number) => number): (colors: ArrayLike<unknown>) => (t: number) => string {
  return function (colors) {
    const n = colors.length
    let r: number[] | ((t: number) => number) = new Array<number>(n)
    let g: number[] | ((t: number) => number) = new Array<number>(n)
    let b: number[] | ((t: number) => number) = new Array<number>(n)
    let c: Rgb | undefined
    for (let i = 0; i < n; ++i) {
      c = rgbConvert(colors[i])
      r[i] = c.r || 0
      g[i] = c.g || 0
      b[i] = c.b || 0
    }
    r = spline(r)
    g = spline(g)
    b = spline(b)
    // d3 mutates the LAST parsed colour (and throws on an empty list)
    const last = c as Rgb
    Object.assign(last, { opacity: 1 })
    return function (t) {
      Object.assign(last, { r: r(t), g: g(t), b: b(t) })
      return last + ''
    }
  }
}

export const interpolateRgbBasis = rgbSpline(interpolateBasis)
export const interpolateRgbBasisClosed = rgbSpline(interpolateBasisClosed)

export function interpolateDiscrete<T>(range: ArrayLike<T>): (t: number) => T {
  const n = range.length
  return function (t) {
    return range[Math.max(0, Math.min(n - 1, Math.floor(t * n)))]!
  }
}

const zoomEpsilon2 = 1e-12
const zcosh = (x: number): number => ((x = Math.exp(x)) + 1 / x) / 2
const zsinh = (x: number): number => ((x = Math.exp(x)) - 1 / x) / 2
const ztanh = (x: number): number => ((x = Math.exp(2 * x)) - 1) / (x + 1)

type ZoomInterp = ((p0: ArrayLike<number>, p1: ArrayLike<number>) => ((t: number) => number[]) & { duration: number }) & { rho(r: number): ZoomInterp }

function zoomRho(rho: number, rho2: number, rho4: number): ZoomInterp {
  const zoom = function (p0: ArrayLike<number>, p1: ArrayLike<number>) {
    const ux0 = p0[0]!, uy0 = p0[1]!, w0 = p0[2]!
    const ux1 = p1[0]!, uy1 = p1[1]!, w1 = p1[2]!
    const dx = ux1 - ux0
    const dy = uy1 - uy0
    const d2 = dx * dx + dy * dy
    let S: number
    let i: ((t: number) => number[]) & { duration: number }
    if (d2 < zoomEpsilon2) {
      S = Math.log(w1 / w0) / rho
      i = Object.assign(function (t: number) {
        return [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)]
      }, { duration: 0 })
    } else {
      const d1 = Math.sqrt(d2)
      const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1)
      const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1)
      const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
      const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
      S = (r1 - r0) / rho
      i = Object.assign(function (t: number) {
        const s = t * S
        const coshr0 = zcosh(r0)
        const u = (w0 / (rho2 * d1)) * (coshr0 * ztanh(rho * s + r0) - zsinh(r0))
        return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / zcosh(rho * s + r0)]
      }, { duration: 0 })
    }
    i.duration = (S * 1000 * rho) / Math.SQRT2
    return i
  } as ZoomInterp
  zoom.rho = function (_: number): ZoomInterp {
    const _1 = Math.max(1e-3, +_)
    const _2 = _1 * _1
    const _4 = _2 * _2
    return zoomRho(_1, _2, _4)
  }
  return zoom
}

export const interpolateZoom = zoomRho(Math.SQRT2, 2, 4)
