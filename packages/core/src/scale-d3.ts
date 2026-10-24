/**
 * d3-scale (4.0.2): the full scale type library as Vega uses it. Faithful
 * transcription verified against oracle vectors recorded from pinned
 * d3-scale@4.0.2 + vega-scale@8.1.2.
 *
 * The upstream source is duck-typed JS (scales are functions carrying their
 * own accessor closures, and every method is both getter and setter). The
 * internals below therefore use a permissive `SR` record type; the public
 * surface is typed in `scale.ts`.
 */
import bisectorDefault, {
  bisect,
  InternMap,
  quantile,
  quantileSorted,
  range as sequence,
  tickIncrement,
  ticks,
  tickStep,
  ascending,
} from './arr.js'
import {
  interpolateRound,
  interpolateValue as interpolate,
  interpolateNumber,
  piecewise,
} from './interp.js'
import {
  format,
  formatPrefix,
  formatSpecifier,
  precisionFixed,
  precisionPrefix,
  precisionRound,
  type FormatSpecifier as FormatSpecifierObject,
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
  timeSunday,
  timeWeek,
  timeYear,
  unixDay,
  utcDay,
  utcHour,
  utcMinute,
  utcMonth,
  utcSunday,
  utcWeek,
  utcYear,
  type TimeInterval,
} from './time.js'
import { timeFormat, utcFormat } from './time-format.js'

export type SR = any // upstream scales are untyped closures; vectors verify behaviour
type Fn = (...args: any[]) => any

export type Interpolator<T = unknown> = (t: number) => T

function identity(x: unknown): unknown {
  return x
}

function numberCoerce(x: unknown): number {
  return +(x as number)
}

const unit = [0, 1]

// ---- continuous.js ----------------------------------------------------------

function normalize(a: number, b: number): (x: number) => number {
  return (b -= a = +a)
    ? function (x) {
        return (x - a) / b
      }
    : (isNaN(b) ? () => NaN : () => 0.5) as (x: number) => number
}

function clamper(a: number, b: number): (x: number) => number {
  let t: number
  if (a > b) (t = a), (a = b), (b = t)
  return function (x) {
    return Math.max(a, Math.min(b, x))
  }
}

// normalize(a, b)(x) takes a domain value x in [a,b] and returns the corresponding parameter t in [0,1].
// interpolate(a, b)(t) takes a parameter t in [0,1] and returns the corresponding range value x in [a,b].
function bimap(domain: number[], range: unknown[], interp: (a: unknown, b: unknown) => unknown): (x: number) => unknown {
  let d0: any = domain[0]
  const d1 = domain[1]!
  let r0: any = range[0]
  const r1 = range[1]
  if (d1 < d0) {
    d0 = normalize(d1, d0)
    r0 = interp(r1, r0)
  } else {
    d0 = normalize(d0, d1)
    r0 = interp(r0, r1)
  }
  return function (x) {
    return r0(d0(x))
  }
}

function polymap(domain: number[], range: unknown[], interp: (a: unknown, b: unknown) => unknown): (x: number) => unknown {
  const j = Math.min(domain.length, range.length) - 1
  const d = new Array(j)
  const r = new Array(j)
  let i = -1
  // Reverse descending domains.
  if (domain[j]! < domain[0]!) {
    domain = domain.slice().reverse()
    range = range.slice().reverse()
  }
  while (++i < j) {
    d[i] = normalize(domain[i]!, domain[i + 1]!)
    r[i] = interp(range[i], range[i + 1])
  }
  return function (x) {
    const i = bisect(domain, x, 1, j) - 1
    return r[i]!(d[i]!(x))
  }
}

export function continuousCopy(source: SR, target: SR): SR {
  return target
    .domain(source.domain())
    .range(source.range())
    .interpolate(source.interpolate())
    .clamp(source.clamp())
    .unknown(source.unknown())
}

/**
 * The shared continuous-scale transformer. Returns a function that takes the
 * (transform, untransform) pair and returns the scale.
 */
export function transformer(): (t: (x: number) => number, u: (y: number) => number) => SR {
  let domain: number[] = unit
  let range: unknown[] = unit
  let interp: (a: unknown, b: unknown) => unknown = interpolate as any
  let transform!: (x: number) => number
  let untransform!: (y: number) => number
  let unknown: unknown
  let clamp: any = identity
  let piece: (domain: number[], range: unknown[], interp: (a: unknown, b: unknown) => unknown) => (x: number) => unknown
  let output: ((x: number) => unknown) | null
  let input: ((y: unknown) => unknown) | null

  function rescale(): SR {
    const n = Math.min(domain.length, range.length)
    if (clamp !== identity) clamp = clamper(domain[0]!, domain[n - 1]!)
    piece = n > 2 ? polymap : bimap
    output = input = null
    return scale
  }

  function scale(x: unknown): unknown {
    return x == null || isNaN((x = +(x as number)))
      ? unknown
      : (output || (output = piece(domain.map(transform), range, interp)))(transform(clamp(x) as number))
  }

  scale.invert = function (y: unknown): unknown {
    return clamp(untransform((input || (input = (piece as any)(range, domain.map(transform), interpolateNumber)))(y)))
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (!arguments.length) return domain.slice()
    domain = Array.from(_!, numberCoerce as (x: unknown) => number)
    return rescale()
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    if (!arguments.length) return range.slice()
    range = Array.from(_!)
    return rescale()
  }

  scale.rangeRound = function (_: Iterable<unknown>): SR {
    range = Array.from(_!)
    interp = interpolateRound as any
    return rescale()
  }

  scale.clamp = function (_?: boolean): unknown {
    if (!arguments.length) return clamp !== identity
    clamp = _ ? true : identity
    return rescale()
  }

  scale.interpolate = function (_?: (a: unknown, b: unknown) => unknown): unknown {
    if (!arguments.length) return interp
    interp = _!
    return rescale()
  }

  scale.unknown = function (_?: unknown): unknown {
    if (!arguments.length) return unknown
    unknown = _
    return scale
  }

  return function (t, u) {
    transform = t
    untransform = u
    return rescale()
  }
}

export function continuous(): SR {
  return transformer()(identity as (x: number) => number, identity as (y: number) => number)
}

// ---- init.js ----------------------------------------------------------------

export function initRange(this: SR, domain?: unknown[], range?: unknown[]): SR {
  switch (arguments.length) {
    case 0:
      break
    case 1:
      this.range(domain)
      break
    default:
      this.range(range).domain(domain)
      break
  }
  return this
}

export function initInterpolator(this: SR, domain?: unknown, interpolator?: unknown): SR {
  switch (arguments.length) {
    case 0:
      break
    case 1: {
      if (typeof domain === 'function') this.interpolator(domain)
      else this.range(domain)
      break
    }
    default: {
      this.domain(domain)
      if (typeof interpolator === 'function') this.interpolator(interpolator)
      else this.range(interpolator)
      break
    }
  }
  return this
}

// ---- nice.js ----------------------------------------------------------------

export function nice(domain: number[], interval: { floor(x: number): number; ceil(x: number): number }): number[] {
  domain = domain.slice()
  let i0 = 0
  let i1 = domain.length - 1
  let x0 = domain[i0]!
  let x1 = domain[i1]!
  let t: number
  if (x1 < x0) {
    t = i0, i0 = i1, i1 = t
    t = x0, x0 = x1, x1 = t
  }
  domain[i0] = interval.floor(x0)
  domain[i1] = interval.ceil(x1)
  return domain
}

// ---- linear.js --------------------------------------------------------------

export function linearish(scale: SR): SR {
  const domain = scale.domain
  scale.ticks = function (count: number): number[] {
    const d = domain()
    return ticks(d[0], d[d.length - 1], count == null ? 10 : count)
  }
  scale.tickFormat = function (count: number, specifier: string): (v: number) => string {
    const d = domain()
    return d3TickFormat(d[0], d[d.length - 1], count == null ? 10 : count, specifier)
  }
  scale.nice = function (count?: number): SR {
    if (count == null) count = 10
    const d = domain()
    let i0 = 0
    let i1 = d.length - 1
    let start = d[i0]
    let stop = d[i1]
    let prestep: number | undefined
    let step: number | undefined
    let maxIter = 10
    if (stop < start) {
      step = start, start = stop, stop = step
      step = i0, i0 = i1, i1 = step
    }

    while (maxIter-- > 0) {
      step = tickIncrement(start, stop, count)
      if (step === prestep) {
        d[i0] = start
        d[i1] = stop
        return domain(d)
      } else if (step > 0) {
        start = Math.floor(start / step) * step
        stop = Math.ceil(stop / step) * step
      } else if (step < 0) {
        start = Math.ceil(start * step) / step
        stop = Math.floor(stop * step) / step
      } else {
        break
      }
      prestep = step
    }
    return scale
  }
  return scale
}

export function linear(): SR {
  const scale = continuous()
  scale.copy = function () {
    return continuousCopy(scale, linear())
  }
  initRange.apply(scale, arguments as any)
  return linearish(scale)
}

// ---- log.js -----------------------------------------------------------------

function transformLog(x: number): number {
  return Math.log(x)
}
function transformExp(x: number): number {
  return Math.exp(x)
}
function transformLogn(x: number): number {
  return -Math.log(-x)
}
function transformExpn(x: number): number {
  return -Math.exp(-x)
}
function pow10(x: number): number {
  return isFinite(x) ? +('1e' + x) : x < 0 ? 0 : x
}
function powp(base: number): (x: number) => number {
  return base === 10 ? pow10
    : base === Math.E ? Math.exp
    : (x) => Math.pow(base, x)
}
function logp(base: number): (x: number) => number {
  return base === Math.E ? Math.log
    : (base === 10 && Math.log10)
    || (base === 2 && Math.log2)
    || ((base = Math.log(base)), (x: number) => Math.log(x) / base)
}
function reflect(f: (x: number, k?: unknown) => number): (x: number, k?: unknown) => number {
  return (x, k) => -f(-x, k)
}

export function loggish(transform: (t: Fn, u: Fn) => SR): SR {
  const scale = transform(transformLog, transformExp)
  const domain = scale.domain
  let base = 10
  let logs: (x: number) => number
  let pows: (x: number) => number

  function rescale(): SR {
    logs = logp(base)
    pows = powp(base)
    if (domain()[0] < 0) {
      logs = reflect(logs)
      pows = reflect(pows)
      transform(transformLogn, transformExpn)
    } else {
      transform(transformLog, transformExp)
    }
    return scale
  }

  scale.base = function (_?: number): unknown {
    return arguments.length ? (base = +(_ as number), rescale()) : base
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? (domain(_), rescale()) : domain()
  }

  scale.ticks = (count?: number): number[] => {
    const d = domain()
    let u = d[0]
    let v = d[d.length - 1]
    const r = v < u
    if (r) [u, v] = [v, u]
    let i = logs(u)
    let j = logs(v)
    let k: number
    let t: number
    const n = count == null ? 10 : +count
    let z: number[] = []
    if (!(base % 1) && j - i < n) {
      i = Math.floor(i), j = Math.ceil(j)
      if (u > 0) {
        for (; i <= j; ++i) {
          for (k = 1; k < base; ++k) {
            t = i < 0 ? k / pows(-i) : k * pows(i)
            if (t < u) continue
            if (t > v) break
            z.push(t)
          }
        }
      } else {
        for (; i <= j; ++i) {
          for (k = base - 1; k >= 1; --k) {
            t = i > 0 ? k / pows(-i) : k * pows(i)
            if (t < u) continue
            if (t > v) break
            z.push(t)
          }
        }
      }
      if (z.length * 2 < n) z = ticks(u, v, n)
    } else {
      z = ticks(i, j, Math.min(j - i, n)).map(pows)
    }
    return r ? z.reverse() : z
  }

  scale.tickFormat = (count?: number, specifier?: any): any => {
    if (count == null) count = 10
    if (specifier == null) specifier = base === 10 ? 's' : ','
    if (typeof specifier !== 'function') {
      if (!(base % 1) && (specifier = formatSpecifier(specifier)).precision == null) specifier.trim = true
      specifier = format(specifier)
    }
    if (count === Infinity) return specifier
    const k = Math.max(1, (base * count) / scale.ticks().length) // TODO fast estimate?
    return (d: number) => {
      let i = d / pows(Math.round(logs(d)))
      if (i * base < base - 0.5) i *= base
      return i <= k ? specifier(d) : ''
    }
  }

  scale.nice = (): SR => {
    return domain(nice(domain(), {
      floor: (x: number) => pows(Math.floor(logs(x))),
      ceil: (x: number) => pows(Math.ceil(logs(x))),
    }))
  }

  return scale
}

export function log(): SR {
  const scale = loggish(transformer()).domain([1, 10])
  scale.copy = () => continuousCopy(scale, log()).base(scale.base())
  initRange.apply(scale, arguments as any)
  return scale
}

// ---- pow.js / sqrt ----------------------------------------------------------

function transformPow(exponent: number): (x: number) => number {
  return function (x) {
    return x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent)
  }
}
function transformSqrt(x: number): number {
  return x < 0 ? -Math.sqrt(-x) : Math.sqrt(x)
}
function transformSquare(x: number): number {
  return x < 0 ? -x * x : x * x
}

export function powish(transform: (t: Fn, u: Fn) => SR): SR {
  const scale = transform(identity as Fn, identity as Fn)
  let exponent = 1
  function rescale(): SR {
    return exponent === 1
      ? transform(identity as Fn, identity as Fn)
      : exponent === 0.5
        ? transform(transformSqrt, transformSquare)
        : transform(transformPow(exponent), transformPow(1 / exponent))
  }
  scale.exponent = function (_?: number): unknown {
    return arguments.length ? (exponent = +(_ as number), rescale()) : exponent
  }
  return linearish(scale)
}

export function pow(): SR {
  const scale = powish(transformer())
  scale.copy = function () {
    return continuousCopy(scale, pow()).exponent(scale.exponent())
  }
  initRange.apply(scale, arguments as any)
  return scale
}

export function sqrt(): SR {
  return pow.apply(null, arguments as any).exponent(0.5)
}

// ---- symlog.js --------------------------------------------------------------

function transformSymlog(c: number): (x: number) => number {
  return function (x) {
    return Math.sign(x) * Math.log1p(Math.abs(x / c))
  }
}
function transformSymexp(c: number): (x: number) => number {
  return function (x) {
    return Math.sign(x) * Math.expm1(Math.abs(x)) * c
  }
}

export function symlogish(transform: (t: Fn, u: Fn) => SR): SR {
  let c = 1
  const scale = transform(transformSymlog(c), transformSymexp(c))
  scale.constant = function (_?: number): unknown {
    return arguments.length ? transform(transformSymlog((c = +(_ as number))), transformSymexp(c)) : c
  }
  return linearish(scale)
}

export function symlog(): SR {
  const scale = symlogish(transformer())
  scale.copy = function () {
    return continuousCopy(scale, symlog()).constant(scale.constant())
  }
  return initRange.apply(scale, arguments as any)
}

// ---- identity.js ------------------------------------------------------------

export function identityScale(domain?: Iterable<unknown>): SR {
  let unknown: unknown
  function scale(x: unknown): unknown {
    return x == null || isNaN((x = +x)) ? unknown : x
  }
  scale.invert = scale
  scale.domain = scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? ((domain = Array.from(_!, numberCoerce as (x: unknown) => number)), scale) : (domain as number[]).slice()
  }
  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }
  scale.copy = function () {
    return identityScale(domain).unknown(unknown)
  }
  domain = arguments.length ? Array.from(domain as Iterable<unknown>, numberCoerce as (x: unknown) => number) : [0, 1]
  return linearish(scale)
}

// ---- ordinal.js -------------------------------------------------------------

export const implicit = Symbol('implicit')

export function ordinal(domain?: Iterable<unknown>, range?: Iterable<unknown>): SR {
  let index = new InternMap<unknown, number>()
  let dom: unknown[] = []
  let rng: unknown[] = []
  let unknown: unknown = implicit

  function scale(d: unknown): unknown {
    let i = index.get(d)
    if (i === undefined) {
      if (unknown !== implicit) return unknown
      index.set(d, (i = dom.push(d) - 1))
    }
    return rng[i % rng.length]
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (!arguments.length) return dom.slice()
    dom = []
    index = new InternMap()
    for (const value of _ as Iterable<unknown>) {
      if (index.has(value)) continue
      index.set(value, dom.push(value) - 1)
    }
    return scale
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? ((rng = Array.from(_!)), scale) : rng.slice()
  }

  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }

  scale.copy = function () {
    return ordinal(dom, rng).unknown(unknown)
  }

  initRange.apply(scale, arguments as any)
  return scale
}

// ---- band.js / point --------------------------------------------------------

export function band(domain?: unknown[], range?: unknown[]): SR {
  const scale: SR = ordinal().unknown(undefined)
  const ordinalDomain = scale.domain
  const ordinalRange = scale.range
  let r0 = 0
  let r1 = 1
  let step: number
  let bandwidth: number
  let round = false
  let paddingInner = 0
  let paddingOuter = 0
  let align = 0.5
  delete scale.unknown

  function rescale(): SR {
    const n = ordinalDomain().length
    const reverse = r1 < r0
    let start = reverse ? r1 : r0
    const stop = reverse ? r0 : r1
    step = (stop - start) / Math.max(1, n - paddingInner + paddingOuter * 2)
    if (round) step = Math.floor(step)
    start += (stop - start - step * (n - paddingInner)) * align
    bandwidth = step * (1 - paddingInner)
    if (round) (start = Math.round(start)), (bandwidth = Math.round(bandwidth))
    const values = sequence(n).map((i: number) => start + step * i)
    return ordinalRange(reverse ? values.reverse() : values)
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? (ordinalDomain(_), rescale()) : ordinalDomain()
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? (([r0, r1] = _ as unknown as [number, number]), (r0 = +r0), (r1 = +r1), rescale()) : [r0, r1]
  }

  scale.rangeRound = function (_?: Iterable<unknown>): unknown {
    return ([r0, r1] = _ as unknown as [number, number]), (r0 = +r0), (r1 = +r1), (round = true), rescale()
  }

  scale.bandwidth = function (): number {
    return bandwidth
  }
  scale.step = function (): number {
    return step
  }
  scale.round = function (_?: boolean): unknown {
    return arguments.length ? ((round = !!_), rescale()) : round
  }
  scale.padding = function (_?: number): unknown {
    return arguments.length ? ((paddingInner = Math.min(1, (paddingOuter = +(_ as number)))), rescale()) : paddingInner
  }
  scale.paddingInner = function (_?: number): unknown {
    return arguments.length ? ((paddingInner = Math.min(1, +(_ as number))), rescale()) : paddingInner
  }
  scale.paddingOuter = function (_?: number): unknown {
    return arguments.length ? ((paddingOuter = +(_ as number)), rescale()) : paddingOuter
  }
  scale.align = function (_?: number): unknown {
    return arguments.length ? ((align = Math.max(0, Math.min(1, +(_ as number)))), rescale()) : align
  }

  scale.copy = function () {
    return band(ordinalDomain(), [r0, r1])
      .round(round)
      .paddingInner(paddingInner)
      .paddingOuter(paddingOuter)
      .align(align)
  }

  return initRange.apply(rescale(), arguments as any)
}

function pointish(scale: SR): SR {
  const copy = scale.copy
  scale.padding = scale.paddingOuter
  delete scale.paddingInner
  delete scale.paddingOuter
  scale.copy = function () {
    return pointish(copy())
  }
  return scale
}

export function point(domain?: unknown[], range?: unknown[]): SR {
  return pointish(band.apply(null, arguments as any).paddingInner(1))
}

// ---- quantize.js / threshold.js / quantile.js -------------------------------

export function quantize(): SR {
  let x0 = 0
  let x1 = 1
  let n = 1
  let domain: number[] = [0.5]
  let range: unknown[] = [0, 1]
  let unknown: unknown

  function scale(x: unknown): unknown {
    return x != null && x <= x ? range[bisect(domain, x as number, 0, n)] : unknown
  }

  function rescale(): SR {
    let i = -1
    domain = new Array(n)
    while (++i < n) domain[i] = ((i + 1) * x1 - (i - n) * x0) / (n + 1)
    return scale
  }

  scale.domain = function (_?: [number, number]): unknown {
    return arguments.length ? (([x0, x1] = _ as [number, number]), (x0 = +x0), (x1 = +x1), rescale()) : [x0, x1]
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? ((n = (range = Array.from(_!)).length - 1), rescale()) : range.slice()
  }

  scale.invertExtent = function (y: unknown): unknown[] {
    const i = range.indexOf(y)
    return i < 0
      ? [NaN, NaN]
      : i < 1
        ? [x0, domain[0]]
        : i >= n
          ? [domain[n - 1], x1]
          : [domain[i - 1], domain[i]]
  }

  // d3-scale 4.0.2's quantize getter returns the SCALE, not the unknown value
  // (an upstream slip, kept: the owned port is verified against the pinned oracle).
  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : scale
  }

  scale.thresholds = function (): number[] {
    return domain.slice()
  }

  scale.copy = function () {
    return quantize()
      .domain([x0, x1])
      .range(range)
      .unknown(unknown)
  }

  return initRange.apply(linearish(scale), arguments as any)
}

export function threshold(): SR {
  let domain: unknown[] = [0.5]
  let range: unknown[] = [0, 1]
  let unknown: unknown
  let n = 1

  function scale(x: unknown): unknown {
    return x != null && x <= x ? range[bisect(domain as number[], x as number, 0, n)] : unknown
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length
      ? ((domain = Array.from(_!)), (n = Math.min(domain.length, range.length - 1)), scale)
      : domain.slice()
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length
      ? ((range = Array.from(_!)), (n = Math.min(domain.length, range.length - 1)), scale)
      : range.slice()
  }

  scale.invertExtent = function (y: unknown): unknown[] {
    const i = range.indexOf(y)
    return [domain[i - 1], domain[i]]
  }

  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }

  scale.copy = function () {
    return threshold()
      .domain(domain)
      .range(range)
      .unknown(unknown)
  }

  return initRange.apply(scale, arguments as any)
}

export function quantileScale(): SR {
  let domain: number[] = []
  let range: unknown[] = []
  let thresholds: number[] = []
  let unknown: unknown

  function rescale(): SR {
    let i = 0
    const n = Math.max(1, range.length)
    thresholds = new Array(n - 1)
    while (++i < n) thresholds[i - 1] = quantileSorted(domain, i / n)!
    return scale
  }

  function scale(x: unknown): unknown {
    return x == null || isNaN((x = +x)) ? unknown : range[bisect(thresholds, x as number)]
  }

  scale.invertExtent = function (y: unknown): unknown[] {
    const i = range.indexOf(y)
    return i < 0
      ? [NaN, NaN]
      : [
          i > 0 ? thresholds[i - 1] : domain[0],
          i < thresholds.length ? thresholds[i] : domain[domain.length - 1],
        ]
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (!arguments.length) return domain.slice()
    domain = []
    // d3-scale: `for (let d of _) if (d != null && !isNaN(d = +d)) domain.push(d)` - the values are coerced
    for (const raw of _ as Iterable<unknown>) {
      const d = +(raw as number)
      if (raw != null && !isNaN(d)) domain.push(d)
    }
    domain.sort(ascending)
    return rescale()
  }

  scale.range = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? ((range = Array.from(_!)), rescale()) : range.slice()
  }

  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }

  scale.quantiles = function (): number[] {
    return thresholds.slice()
  }

  scale.copy = function () {
    return quantileScale()
      .domain(domain)
      .range(range)
      .unknown(unknown)
  }

  return initRange.apply(scale, arguments as any)
}

// ---- sequentialQuantile -----------------------------------------------------

export function sequentialQuantile(interpolator?: Interpolator): SR {
  let domain: number[] = []
  let interp: Interpolator = (interpolator ?? identity) as Interpolator

  function scale(x: unknown): unknown {
    if (x != null && !isNaN(+(x as number))) {
      return interp((bisect(domain, x as number, 1) - 1) / (domain.length - 1))
    }
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    if (!arguments.length) return domain.slice()
    domain = []
    // d3-scale: `for (let d of _) if (d != null && !isNaN(d = +d)) domain.push(d)` - the values are coerced
    for (const raw of _ as Iterable<unknown>) {
      const d = +(raw as number)
      if (raw != null && !isNaN(d)) domain.push(d)
    }
    domain.sort(ascending)
    return scale
  }

  scale.interpolator = function (_?: Interpolator): unknown {
    return arguments.length ? ((interp = _!), scale) : interp
  }

  scale.range = function (): unknown[] {
    return domain.map((d, i) => interp(i / (domain.length - 1)))
  }

  scale.quantiles = function (n: number): number[] {
    return Array.from({ length: n + 1 }, (_, i) => quantile(domain, i / n)!)
  }

  scale.copy = function () {
    return sequentialQuantile(interp).domain(domain)
  }

  return initInterpolator.apply(scale, arguments as any)
}

// ---- tickFormat.js (d3-scale) -----------------------------------------------

export function d3TickFormat(start: number, stop: number, count: number, specifier?: any): FormatFunction {
  const step = tickStep(start, stop, count)
  let precision: number
  const spec = formatSpecifier(specifier == null ? ',f' : specifier)
  switch (spec.type) {
    case 's': {
      const value = Math.max(Math.abs(start), Math.abs(stop))
      if (spec.precision == null && !isNaN((precision = precisionPrefix(step, value)))) spec.precision = precision
      return formatPrefix(spec, value)
    }
    case '':
    case 'e':
    case 'g':
    case 'p':
    case 'r': {
      if (spec.precision == null && !isNaN((precision = precisionRound(step, Math.max(Math.abs(start), Math.abs(stop)))))) spec.precision = precision - (spec.type === 'e' ? 1 : 0)
      break
    }
    case 'f':
    case '%': {
      if (spec.precision == null && !isNaN((precision = precisionFixed(step)))) spec.precision = precision - (spec.type === '%' ? 2 : 0)
      break
    }
  }
  return format(spec)
}

// ---- sequential.js / diverging.js -------------------------------------------

type Transform1 = (t: (x: number) => number) => SR

function sequentialTransformer(): Transform1 {
  let x0 = 0
  let x1 = 1
  let t0: number
  let t1: number
  let k10: number
  let transform!: (x: number) => number
  let interpolator: Interpolator = identity as Interpolator
  let clamp = false
  let unknown: unknown

  function scale(x: unknown): unknown {
    return x == null || isNaN(+(x as number))
      ? unknown
      : interpolator(
          k10 === 0
            ? 0.5
            : ((() => { const v = (transform(x as number) - t0) * k10; return clamp ? Math.max(0, Math.min(1, v)) : v })()),
        )
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length
      ? (([x0, x1] = _ as [number, number]),
        (t0 = transform((x0 = +x0))),
        (t1 = transform((x1 = +x1))),
        (k10 = t0 === t1 ? 0 : 1 / (t1 - t0)),
        scale)
      : [x0, x1]
  }

  scale.clamp = function (_?: boolean): unknown {
    return arguments.length ? ((clamp = !!_), scale) : clamp
  }

  scale.interpolator = function (_?: Interpolator): unknown {
    return arguments.length ? ((interpolator = _!), scale) : interpolator
  }

  function rangeFn(interp: (a: unknown, b: unknown) => unknown) {
    return function (_?: Iterable<unknown>): unknown {
      let r0: unknown
      let r1: unknown
      return arguments.length
        ? (([r0, r1] = _ as [unknown, unknown]), (interpolator = interp(r0, r1) as Interpolator), scale)
        : [interpolator(0), interpolator(1)]
    }
  }

  scale.range = rangeFn(interpolate)
  scale.rangeRound = rangeFn(interpolateRound as unknown as (a: unknown, b: unknown) => unknown)

  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }

  return function (t) {
    transform = t
    t0 = t(x0)
    t1 = t(x1)
    k10 = t0 === t1 ? 0 : 1 / (t1 - t0)
    return scale
  }
}

export function sequentialCopy(source: SR, target: SR): SR {
  return target
    .domain(source.domain())
    .interpolator(source.interpolator())
    .clamp(source.clamp())
    .unknown(source.unknown())
}

export function sequential(): SR {
  const scale = linearish(sequentialTransformer()(identity as (x: number) => number))
  scale.copy = function () {
    return sequentialCopy(scale, sequential())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function sequentialLog(): SR {
  const scale = loggish(sequentialTransformer() as any).domain([1, 10])
  scale.copy = function () {
    return sequentialCopy(scale, sequentialLog()).base(scale.base())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function sequentialSymlog(): SR {
  const scale = symlogish(sequentialTransformer() as any)
  scale.copy = function () {
    return sequentialCopy(scale, sequentialSymlog()).constant(scale.constant())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function sequentialPow(): SR {
  const scale = powish(sequentialTransformer() as any)
  scale.copy = function () {
    return sequentialCopy(scale, sequentialPow()).exponent(scale.exponent())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function sequentialSqrt(): SR {
  return sequentialPow.apply(null, arguments as any).exponent(0.5)
}

function divergingTransformer(): Transform1 {
  let x0 = 0
  let x1 = 0.5
  let x2 = 1
  let s = 1
  let t0: number
  let t1: number
  let t2: number
  let k10: number
  let k21: number
  let interpolator: Interpolator = identity as Interpolator
  let transform!: (x: number) => number
  let clamp = false
  let unknown: unknown

  function scale(x: unknown): unknown {
    if (isNaN(+(x as number))) return unknown
    const tx = +transform(x as number)
    const v = 0.5 + (tx - t1) * (s * tx < s * t1 ? k10 : k21)
    return interpolator(clamp ? Math.max(0, Math.min(1, v)) : v)
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length
      ? (([x0, x1, x2] = _ as [number, number, number]),
        (t0 = transform((x0 = +x0))),
        (t1 = transform((x1 = +x1))),
        (t2 = transform((x2 = +x2))),
        (k10 = t0 === t1 ? 0 : 0.5 / (t1 - t0)),
        (k21 = t1 === t2 ? 0 : 0.5 / (t2 - t1)),
        (s = t1 < t0 ? -1 : 1),
        scale)
      : [x0, x1, x2]
  }

  scale.clamp = function (_?: boolean): unknown {
    return arguments.length ? ((clamp = !!_), scale) : clamp
  }

  scale.interpolator = function (_?: Interpolator): unknown {
    return arguments.length ? ((interpolator = _!), scale) : interpolator
  }

  function rangeFn(interp: (a: unknown, b: unknown) => unknown) {
    return function (_?: Iterable<unknown>): unknown {
      let r0: unknown
      let r1: unknown
      let r2: unknown
      return arguments.length
        ? (([r0, r1, r2] = _ as [unknown, unknown, unknown]), (interpolator = (piecewise as any)(interp, [r0, r1, r2]) as Interpolator), scale)
        : [interpolator(0), interpolator(0.5), interpolator(1)]
    }
  }

  scale.range = rangeFn(interpolate)
  scale.rangeRound = rangeFn(interpolateRound as unknown as (a: unknown, b: unknown) => unknown)

  scale.unknown = function (_?: unknown): unknown {
    return arguments.length ? ((unknown = _), scale) : unknown
  }

  return function (t) {
    transform = t
    t0 = t(x0)
    t1 = t(x1)
    t2 = t(x2)
    k10 = t0 === t1 ? 0 : 0.5 / (t1 - t0)
    k21 = t1 === t2 ? 0 : 0.5 / (t2 - t1)
    s = t1 < t0 ? -1 : 1
    return scale
  }
}

export function diverging(): SR {
  const scale = linearish(divergingTransformer()(identity as (x: number) => number))
  scale.copy = function () {
    return sequentialCopy(scale, diverging())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function divergingLog(): SR {
  const scale = loggish(divergingTransformer() as any).domain([0.1, 1, 10])
  scale.copy = function () {
    return sequentialCopy(scale, divergingLog()).base(scale.base())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function divergingSymlog(): SR {
  const scale = symlogish(divergingTransformer() as any)
  scale.copy = function () {
    return sequentialCopy(scale, divergingSymlog()).constant(scale.constant())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function divergingPow(): SR {
  const scale = powish(divergingTransformer() as any)
  scale.copy = function () {
    return sequentialCopy(scale, divergingPow()).exponent(scale.exponent())
  }
  return initInterpolator.apply(scale, arguments as any)
}

export function divergingSqrt(): SR {
  return divergingPow.apply(null, arguments as any).exponent(0.5)
}

// ---- time.js / utcTime.js ---------------------------------------------------

function dateOf(t: number): Date {
  return new Date(t)
}

function numberDate(t: unknown): number {
  return t instanceof Date ? +t : +new Date(+(t as number))
}

export function calendar(
  ticksFn: (start: number, stop: number, count?: number | TimeInterval) => Date[],
  tickIntervalFn: (start: number, stop: number, count?: number | TimeInterval) => TimeInterval | null,
  year: TimeInterval,
  month: TimeInterval,
  week: TimeInterval,
  day: TimeInterval,
  hour: TimeInterval,
  minute: TimeInterval,
  sec: TimeInterval,
  fmt: any,
): SR {
  const scale = continuous()
  const invert = scale.invert
  const domain = scale.domain

  const formatMillisecond = fmt('.%L')
  const formatSecond = fmt(':%S')
  const formatMinute = fmt('%I:%M')
  const formatHour = fmt('%I %p')
  const formatDay = fmt('%a %d')
  const formatWeek = fmt('%b %d')
  const formatMonth = fmt('%B')
  const formatYear = fmt('%Y')

  function tickFormatDate(d: Date): string {
    return (sec(d) < d
      ? formatMillisecond
      : minute(d) < d
        ? formatSecond
        : hour(d) < d
          ? formatMinute
          : day(d) < d
            ? formatHour
            : month(d) < d
              ? week(d) < d
                ? formatDay
                : formatWeek
              : year(d) < d
                ? formatMonth
                : formatYear)(d)
  }

  scale.invert = function (y: unknown): unknown {
    return new Date(invert(y) as number)
  }

  scale.domain = function (_?: Iterable<unknown>): unknown {
    return arguments.length ? domain(Array.from(_ as Iterable<unknown>, numberDate)) : (domain() as number[]).map(dateOf)
  }

  scale.ticks = function (interval?: number | TimeInterval): unknown[] {
    const d = domain()
    return ticksFn(d[0], d[d.length - 1], interval == null ? 10 : (interval as number)) as unknown[]
  }

  scale.tickFormat = function (count?: number, specifier?: string): (d: Date) => string {
    return specifier == null ? tickFormatDate : (fmt(specifier) as unknown as (d: Date) => string)
  }

  scale.nice = function (interval?: number | TimeInterval): SR {
    const d = domain()
    if (!interval || typeof (interval as TimeInterval).range !== 'function') {
      interval = tickIntervalFn(d[0], d[d.length - 1], interval == null ? 10 : (interval as number)) as TimeInterval
    }
    return interval ? domain(nice(d, interval as unknown as { floor(x: number): number; ceil(x: number): number })) : scale
  }

  scale.copy = function () {
    return continuousCopy(scale, calendar(ticksFn, tickIntervalFn, year, month, week, day, hour, minute, sec, fmt))
  }

  return scale
}

// ---- d3-time ticks (ticker) --------------------------------------------------

const tickIntervals: [TimeInterval, number, number][] = [
  [second as unknown as TimeInterval, 1, durationSecond],
  [second as unknown as TimeInterval, 5, 5 * durationSecond],
  [second as unknown as TimeInterval, 15, 15 * durationSecond],
  [second as unknown as TimeInterval, 30, 30 * durationSecond],
  [timeMinute, 1, durationMinute],
  [timeMinute, 5, 5 * durationMinute],
  [timeMinute, 15, 15 * durationMinute],
  [timeMinute, 30, 30 * durationMinute],
  [timeHour, 1, durationHour],
  [timeHour, 3, 3 * durationHour],
  [timeHour, 6, 6 * durationHour],
  [timeHour, 12, 12 * durationHour],
  [timeDay, 1, durationDay],
  [timeDay, 2, 2 * durationDay],
  [timeWeek, 1, durationWeek],
  [timeMonth, 1, durationMonth],
  [timeMonth, 3, 3 * durationMonth],
  [timeYear, 1, durationYear],
]

const utcTickIntervals: [TimeInterval, number, number][] = [
  [second as unknown as TimeInterval, 1, durationSecond],
  [second as unknown as TimeInterval, 5, 5 * durationSecond],
  [second as unknown as TimeInterval, 15, 15 * durationSecond],
  [second as unknown as TimeInterval, 30, 30 * durationSecond],
  [utcMinute, 1, durationMinute],
  [utcMinute, 5, 5 * durationMinute],
  [utcMinute, 15, 15 * durationMinute],
  [utcMinute, 30, 30 * durationMinute],
  [utcHour, 1, durationHour],
  [utcHour, 3, 3 * durationHour],
  [utcHour, 6, 6 * durationHour],
  [utcHour, 12, 12 * durationHour],
  // d3-time's utc ticker counts DAYS since the epoch (unixDay), not days of the month: its
  // 2-day ticks are the even epoch days, which is not the odd dates utcDay.every(2) gives
  [unixDay, 1, durationDay],
  [unixDay, 2, 2 * durationDay],
  [utcWeek, 1, durationWeek],
  [utcMonth, 1, durationMonth],
  [utcMonth, 3, 3 * durationMonth],
  [utcYear, 1, durationYear],
]

function ticker(
  year: TimeInterval,
  intervals: [TimeInterval, number, number][],
): [(start: number, stop: number, count?: number | TimeInterval) => Date[], (start: number, stop: number, count?: number | TimeInterval) => TimeInterval | null] {
  const stepAccessor = (d: [TimeInterval, number, number]) => d[2]

  function timeTicks(start: number, stop: number, count?: number | TimeInterval): Date[] {
    const reverse = stop < start
    if (reverse) [start, stop] = [stop, start]
    const interval =
      count && typeof (count as TimeInterval).range === 'function'
        ? (count as TimeInterval)
        : tickInterval(start, stop, count as number)
    const out: Date[] = interval ? interval.range(start, +stop + 1) : []
    return reverse ? out.reverse() : out
  }

  function tickInterval(start: number, stop: number, count?: number | TimeInterval): TimeInterval | null {
    const target = Math.abs(stop - start) / (count as number)
    const i = bisectorDefault(stepAccessor).right(intervals, target)
    if (i === intervals.length) {
      return year.every!(tickStep(start / durationYear, stop / durationYear, count as number)) as TimeInterval
    }
    if (i === 0) {
      return millisecond.every!(Math.max(tickStep(start, stop, count as number), 1)) as TimeInterval
    }
    const [t, step] =
      target / intervals[i - 1]![2] < intervals[i]![2] / target ? intervals[i - 1]! : intervals[i]!
    return t.every!(step) as TimeInterval
  }

  return [timeTicks, tickInterval]
}

const [utcTicks, utcTickInterval] = ticker(utcYear, utcTickIntervals)
const [timeTicks, timeTickInterval] = ticker(timeYear, tickIntervals)

export function time(): SR {
  return initRange.apply(
    calendar(timeTicks, timeTickInterval, timeYear, timeMonth, timeWeek, timeDay, timeHour, timeMinute, second as unknown as TimeInterval, timeFormat).domain([
      new Date(2000, 0, 1),
      new Date(2000, 0, 2),
    ]),
    arguments as any,
  )
}

export function utcTime(): SR {
  return initRange.apply(
    calendar(utcTicks, utcTickInterval, utcYear, utcMonth, utcWeek, utcDay, utcHour, utcMinute, second as unknown as TimeInterval, utcFormat).domain([
      Date.UTC(2000, 0, 1),
      Date.UTC(2000, 0, 2),
    ]),
    arguments as any,
  )
}
