/**
 * d3-interpolate subset (3.0.1): the interpolators d3-scale and vega-scale
 * schemes rely on. Faithful transcription verified against oracle vectors
 * recorded from pinned d3-interpolate@3.0.1.
 */
import { color, Color as ColorInstance, type Rgb } from './color.js'

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
    const s = color(start as string) as Rgb & { r: number; g: number; b: number; opacity: number }
    const e = color(end as string) as Rgb
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
