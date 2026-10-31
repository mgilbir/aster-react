/**
 * Building a scale from a spec. `buildScale` reads the spec into settings (signals, named ranges, domain sources), picks the
 * scale type, makes the scale, applies the spec's options to it by name, then fits the domain (zero, min, max, mid, pixel
 * padding, nice), the bins and the range (explicit, stepped, or a colour scheme).
 *
 * What callers observe, and so what is fixed here:
 * - a continuous scale over colours is the sequential scale for two domain values and the diverging scale for three
 *   (a middle value counts as the third), whichever name the spec gave it; `sequential` is the linear one;
 * - an option whose name is a method of the scale is called with its value, in spec order; one that is not is ignored;
 * - linear, pow and sqrt scales include zero unless told not to or binned; a domain padded in pixels is widened so the
 *   extremes sit that far inside the range, in the scale's own space (log, power, symlog);
 * - a scheme names a list of colours or a ramp: ramps become a colour list for discretizing scales (quantized to the scale's
 *   class count), stay ramps for interpolating scales, and a scheme name that is unknown is an error;
 * - a scale made again with unchanged settings that had bins does not include the zero, as the operator it stands for
 *   would keep its bins (see `ScaleContext.pass`).
 */
import { range as sequence } from './arr.js'
import { interpolateRound, interpolateValue } from './interp.js'
import * as vs from './scale.js'
import { implicit as scaleImplicit } from './scale-discrete.js'
import { plain, plainList, plainRecord, resolveDomain, signalValue, type ScaleContext } from './scale-domain.js'
import type { CompiledScale } from './types.js'
import { error as raise, hasOwnProperty, isArray, isFunction, isObject, isString, peek } from './util.js'

export type { ScaleContext } from './scale-domain.js'

export type Scale = vs.Scale

type SchemeFn = (t: number) => unknown

export interface ColorScale extends Scale {
  interpolate?(interpolator: () => SchemeFn): this
  interpolator?(fn?: SchemeFn): this | SchemeFn
}

/** Continuous types (the runtime's domain census and gradient legends key on these). */
export const CONTINUOUS_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize'])

/** Colours in a discretizing scale's range when the spec does not count them. */
const DEFAULT_CLASSES = 5

// ---- which scale ------------------------------------------------------------------------------------------

/** Whether the settings ask for a continuous scale that maps onto colours. */
function mapsToColors(st: Settings): boolean {
  const range = st.range as unknown[] | undefined
  return !!vs.isContinuous(st.type) && st.type !== vs.Time && st.type !== vs.UTC && !!(st.scheme || (range && range.length && range.every(isString)))
}

/** The registry name for the settings: two domain values make a sequential scale, three a diverging one. */
function registryName(st: Settings): string {
  const type = st.type
  if (type === vs.Sequential) return `${vs.Sequential}-${vs.Linear}`
  let family = ''
  if (mapsToColors(st)) {
    // (the settings are read for a `rawDomain` key that nothing sets, as the scale operator it stands for does; `domainRaw` is the live one)
    const given = st.rawDomain as unknown[] | undefined
    const stops = st.domain as unknown[] | undefined
    const count = given ? given.length : stops ? stops.length + +(st.domainMid != null) : 0
    family = count === 2 ? `${vs.Sequential}-` : count === 3 ? `${vs.Diverging}-` : ''
  }
  return ((family + type) || vs.Linear).toLowerCase()
}

/** Options the builder uses itself; every other option is applied to the scale as a method call. */
const HANDLED = new Set([
  'set', 'modified', 'clear', 'type', 'scheme', 'schemeExtent', 'schemeCount',
  'domain', 'domainMin', 'domainMid', 'domainMax',
  'domainRaw', 'domainImplicit', 'nice', 'zero', 'bins',
  'range', 'rangeStep', 'round', 'reverse', 'interpolate', 'interpolateGamma',
])

/** Padding is an option of band and point scales, but a pixel inset of the others. */
const padsDomain = (type: string): boolean => !!vs.isContinuous(type) && type !== vs.Sequential

// ---- building ---------------------------------------------------------------------------------------------

export function buildScale(spec: CompiledScale, ctx: ScaleContext): Scale {
  const st = readSettings(spec, ctx)
  // a host override of the domain (pan/zoom, brushing)
  const hostRaw = ctx.domainRaw ?? spec.domainRaw
  if (hostRaw != null) {
    const resolved = isObject(hostRaw) && !isArray(hostRaw) ? plain(hostRaw, ctx) : hostRaw
    if (resolved != null) st.domainRaw = resolved
  }

  const name = registryName(st)
  const make = vs.scale(name)
  if (!make) raise(`Unrecognized scale type: ${JSON.stringify(name)}`)
  const scale = make!()

  for (const key of Object.keys(st)) {
    if (HANDLED.has(key)) continue
    if (key === 'padding' && padsDomain(scale.type)) continue
    if (typeof scale[key] === 'function') (scale[key] as (v: unknown) => unknown)(st[key])
  }

  // an operator whose settings did not change does not run again: the scale of the pass before is the scale
  const signature = ctx.pass !== undefined ? settingsKey(st) : ''
  if (ctx.pass?.prev?.bins === true && ctx.pass.prev.key !== signature) scale.bins = []
  fitRange(scale, st, fitBins(scale, st, fitDomain(scale, st)))
  ctx.pass?.record(signature, !!scale.bins)
  return scale
}

let unsigned = 0
function settingsKey(st: Settings): string {
  try {
    return JSON.stringify(st, (_k, v) => (typeof v === 'function' ? 'fn:' + v.name : v))
  } catch {
    return `#${++unsigned}` // not comparable: the scale is made again
  }
}

// ---- the domain -------------------------------------------------------------------------------------------

/** Linear-family scales start their domain at zero unless the spec says otherwise (or there are bins). */
function includesZero(scale: Scale): boolean {
  const type = scale.type
  return !scale.bins && (type === vs.Linear || type === vs.Pow || type === vs.Sqrt)
}

/** Sets the domain on the scale; returns how many values it has. */
function fitDomain(scale: Scale, st: Settings): number {
  if (st.domainRaw) {
    scale.domain(st.domainRaw)
    return (st.domainRaw as unknown[]).length
  }

  let domain = st.domain as unknown[] | undefined
  const type = scale.type as string
  const zero = st.zero || (st.zero === undefined && includesZero(scale))
  if (!domain) return 0

  if (zero || st.domainMin != null || st.domainMax != null || st.domainMid != null) {
    // (`slice` is called on whatever the domain is: a string slices fine, and a number or object is the TypeError the dataflow logs)
    domain = domain.slice()
    const last = domain.length - 1 || 1
    if (zero) {
      if ((domain[0] as number) > 0) domain[0] = 0
      if ((domain[last] as number) < 0) domain[last] = 0
    }
    if (st.domainMin != null) domain[0] = st.domainMin
    if (st.domainMax != null) domain[last] = st.domainMax
    if (st.domainMid != null) {
      const mid = st.domainMid as number
      domain.splice(mid > (domain[last] as number) ? last + 1 : mid < (domain[0] as number) ? 0 : last, 0, mid)
    }
  }

  if (padsDomain(type) && st.padding && domain[0] !== peek(domain)) {
    domain = insetDomain(type, domain, st.range as number[], st.padding as number, st.exponent as number | undefined, st.constant as number | undefined)
  }

  scale.domain(domain)
  // a discrete domain that was given outright must not grow by looking values up
  if (type === vs.Ordinal) scale.unknown(st.domainImplicit ? scaleImplicit : undefined)
  if (st.nice && scale.nice) scale.nice((st.nice !== true && vs.tickCount(scale, st.nice)) || null)
  return domain.length
}

/** A domain whose ends sit `pad` pixels inside the range once drawn: zoomed out about its middle, in the scale's own space. */
function insetDomain(type: string, domain: unknown[], range: number[], pad: number, exponent?: number, constant?: number): unknown[] {
  const span = Math.abs((peek(range) as number) - range[0]!)
  const factor = span / (span - 2 * pad)
  const [lo, hi] =
    type === vs.Log ? zoomed(domain as number[], factor, ...logSpace(Math.sign(domain[0] as number)))
    : type === vs.Sqrt ? zoomed(domain as number[], factor, ...powerSpace(0.5))
    : type === vs.Pow ? zoomed(domain as number[], factor, ...powerSpace(exponent || 1))
    : type === vs.Symlog ? zoomed(domain as number[], factor, ...symlogSpace(constant || 1))
    : zoomed(domain as number[], factor, Number, (x) => x)
  const out = domain.slice()
  out[0] = lo
  out[out.length - 1] = hi
  return out
}

type Unary = (x: number) => number

/** The two ends of `domain`, moved from their middle by `factor` as seen through `lift` (undone by `ground`). */
function zoomed(domain: number[], factor: number, lift: Unary, ground: Unary): [number, number] {
  const a = lift(domain[0]!)
  const b = lift(peek(domain) as number)
  const middle = (a + b) / 2
  return [ground(middle + (a - middle) * factor), ground(middle + (b - middle) * factor)]
}

const logSpace = (sign: number): [Unary, Unary] => [(x) => Math.log(sign * x), (x) => sign * Math.exp(x)]
const signedPower = (e: number): Unary => (x) => (x < 0 ? -Math.pow(-x, e) : Math.pow(x, e))
const powerSpace = (e: number): [Unary, Unary] => [signedPower(e), signedPower(1 / e)]
const symlogSpace = (c: number): [Unary, Unary] => [(x) => Math.sign(x) * Math.log1p(Math.abs(x / c)), (x) => Math.sign(x) * Math.expm1(Math.abs(x)) * c]

// ---- the bins ---------------------------------------------------------------------------------------------

/** Sets `scale.bins` (generated from {step, start, stop} when given so); returns the domain size, or the bins' for bin-ordinal. */
function fitBins(scale: Scale, st: Settings, size: number): number {
  let bins = st.bins as unknown
  if (bins && !isArray(bins)) {
    const domain = scale.domain() as number[]
    const lo = domain[0]!
    const hi = peek(domain) as number
    const spec = bins as { step?: number; start?: number | null; stop?: number | null }
    const step = spec.step as number
    let start = spec.start == null ? lo : spec.start
    let stop = spec.stop == null ? hi : spec.stop
    if (!step) raise('Scale bins parameter missing step property.')
    if (start < lo) start = step * Math.ceil(lo / step)
    if (stop > hi) stop = step * Math.floor(hi / step)
    bins = sequence(start, stop + step / 2, step)
  }

  if (bins) scale.bins = bins
  else if (scale.bins) delete scale.bins

  if (scale.type === vs.BinOrdinal) {
    if (!bins) {
      // the domain says where the bins are
      scale.bins = scale.domain()
    } else if (!st.domain && !st.domainRaw) {
      // the bins say what the domain is
      scale.domain(bins)
      size = (bins as unknown[]).length
    }
  }
  return size
}

// ---- the range --------------------------------------------------------------------------------------------

const reversedIf = <T>(list: T[], reverse: unknown): T[] => (reverse ? list.slice().reverse() : list)

/** Sets the range, interpolator or colours; `size` is the domain's size, which stepped and scheme ranges depend on. */
function fitRange(scale: Scale, st: Settings, size: number): void {
  const type = scale.type as string
  let range = st.range as unknown

  if (st.rangeStep != null) {
    range = steppedRange(type, st, size)
  } else if (st.scheme) {
    range = schemeRange(type, st, size)
    if (isFunction(range)) {
      if (scale.interpolator) {
        scale.interpolator(range)
        return
      }
      raise(`Scale type ${type} does not support interpolating color schemes.`)
    }
  }

  // an interpolating scale takes its range as the colours of its interpolator
  if (range && vs.isInterpolating(type)) {
    scale.interpolator(vs.interpolateColors(reversedIf(range as string[], st.reverse), st.interpolate as string | undefined, st.interpolateGamma as number | undefined))
    return
  }

  if (range && st.interpolate && scale.interpolate) {
    scale.interpolate(vs.interpolate(st.interpolate as string, st.interpolateGamma as number | undefined))
  } else if (isFunction(scale.round)) {
    ;(scale.round as (v: unknown) => unknown)(st.round || false)
  } else if (isFunction(scale.rangeRound)) {
    scale.interpolate(st.round ? interpolateRound : interpolateValue)
  }

  if (range) scale.range(reversedIf(range as unknown[], st.reverse))
}

/** [0, step * space]: the extent that gives each band or point `rangeStep` of room. */
function steppedRange(type: string, st: Settings, size: number): number[] {
  if (type !== vs.Band && type !== vs.Point) raise('Only band and point scales support rangeStep.')
  const outer = ((st.paddingOuter != null ? st.paddingOuter : st.padding) as number) || 0
  const inner = type === vs.Point ? 1 : (((st.paddingInner != null ? st.paddingInner : st.padding) as number) || 0)
  return [0, (st.rangeStep as number) * vs.bandSpace(size, inner, outer)]
}

/** The range a scheme gives: its colour list (cut to `size`), or its ramp (quantized for a discretizing scale). */
function schemeRange(type: string, st: Settings, size: number): unknown {
  const extent = st.schemeExtent as number[] | undefined
  let scheme: unknown
  if (isArray(st.scheme)) {
    scheme = vs.interpolateColors(st.scheme as string[], st.interpolate as string | undefined, st.interpolateGamma as number | undefined)
  } else {
    // (the scheme name is lower-cased; anything else is the TypeError that call raises)
    if (!isString(st.scheme)) throw new TypeError('_.scheme.toLowerCase is not a function')
    scheme = vs.scheme(st.scheme.toLowerCase())
    if (!scheme) raise(`Unrecognized scheme name: ${st.scheme}`)
  }

  // how many colours a discrete range needs
  const classes =
    type === vs.Threshold ? size + 1
    : type === vs.BinOrdinal ? size - 1
    : type === vs.Quantile || type === vs.Quantize ? +(st.schemeCount as number) || DEFAULT_CLASSES
    : size

  if (vs.isInterpolating(type)) return trimmed(scheme, extent, st.reverse)
  if (isFunction(scheme)) return vs.quantizeInterpolator(trimmed(scheme, extent) as SchemeFn, classes)
  return type === vs.Ordinal ? scheme : (scheme as unknown[]).slice(0, classes)
}

/** A ramp restricted to the sub-range of [0, 1] the spec gives (and reversed when asked); a colour list is untouched. */
function trimmed(scheme: unknown, extent: number[] | undefined, reverse?: unknown): unknown {
  return isFunction(scheme) && (extent || reverse) ? vs.interpolateRange(scheme as SchemeFn, reversedIf(extent || [0, 1], reverse)) : scheme
}

// ---- ticks for the axis runtime ---------------------------------------------------------------------------

/** The tick values the axis runtime draws for a scale: for `count` ticks, else the scale's default (none for a range of under two). */
export function scaleTicks(s: Scale, count?: number): unknown[] {
  if (count != null) return vs.tickValues(s, count)
  return (s.range() as unknown[]).length >= 2 ? vs.tickValues(s, undefined) : []
}

// ---- reading a spec ------------------------------------------------------------------------------------------

/*
 * Reading a scale spec into the settings a scale is built from: the domain and range resolved to values (signals read,
 * named ranges looked up, `{scheme}` and `{step}` ranges turned into settings of their own), the interpolation and `nice`
 * and `bins` options resolved, and every other key of the spec kept as an option to apply to the scale by name.
 *
 * What callers observe, and so what is fixed here:
 * - a range name is looked up in the user's `config.range` first, then in the built-in table, then among `width` and
 *   `height`; a user entry replaces the built-in one outright, and a name that leads back to itself is an error;
 * - `height` runs from the bottom up (`[height, 0]`) except for discrete scales, which read `[0, height]`;
 * - a range that is not a list, for a discrete scale, is a domain description (the range of a band can be a field);
 * - a `{signal}` anywhere an interpolation is named is resolved like any other literal (vega's own parser crashes there).
 */

/** The settings of a scale: the resolved parts the builder reads by name, and any other key of the spec as an option. */
export interface Settings {
  type: string
  domain?: unknown
  range?: unknown
  scheme?: unknown
  schemeExtent?: unknown
  schemeCount?: unknown
  rangeStep?: unknown
  interpolate?: unknown
  interpolateGamma?: unknown
  nice?: unknown
  bins?: unknown
  domainRaw?: unknown
  [option: string]: unknown
}

/** The named ranges a spec can use without defining them; a `config.range` entry of the same name replaces one. */
const BUILT_IN_RANGES: Record<string, unknown> = Object.assign(Object.create(null), {
  category: { scheme: 'tableau10' },
  ordinal: { scheme: 'blues' },
  heatmap: { scheme: 'yellowgreenblue' },
  ramp: { scheme: 'blues' },
  diverging: { scheme: 'blueorange', extent: [1, 0] },
  symbol: ['circle', 'square', 'triangle-up', 'cross', 'diamond', 'triangle-right', 'triangle-down', 'triangle-left'],
})

/** How deep a chain of named ranges may go before it is taken to be a loop. */
const MAX_RANGE_CHAIN = 32

/**
 * A spec's range as a value. A `{scheme}` or `{step}` range has none of its own: it is recorded in `into` for the builder
 * and the result is undefined.
 */
function resolveRange(spec: CompiledScale, ctx: ScaleContext, into: Settings, userRanges: Record<string, unknown> | undefined, depth = 0): unknown {
  let range: unknown = spec.range
  const r = range as { signal?: unknown; scheme?: unknown; extent?: unknown; count?: unknown; step?: unknown }
  if (r && r.signal) return signalValue(String(r.signal), ctx)
  if (isString(range)) {
    const userDefined = userRanges != null && hasOwnProperty(userRanges, range)
    if (userDefined || hasOwnProperty(BUILT_IN_RANGES, range)) {
      if (depth > MAX_RANGE_CHAIN) raise('Scale range lookup cycles through config.range: ' + range)
      const entry = userDefined ? userRanges![range] : BUILT_IN_RANGES[range]
      return resolveRange({ ...spec, range: entry as CompiledScale['range'] }, ctx, into, userRanges, depth + 1)
    }
    if (range === 'width') range = [0, ctx.width]
    else if (range === 'height') range = vs.isDiscrete(spec.type) ? [0, ctx.height] : [ctx.height, 0]
    else raise('Unrecognized scale range value: ' + JSON.stringify(range))
  } else if (r.scheme) {
    into.scheme = isArray(r.scheme) ? plainList(r.scheme, ctx) : plain(r.scheme, ctx)
    if (r.extent) into.schemeExtent = plainList(r.extent, ctx)
    if (r.count) into.schemeCount = plain(r.count, ctx)
    return undefined
  } else if (r.step) {
    into.rangeStep = plain(r.step, ctx)
    return undefined
  } else if (vs.isDiscrete(spec.type) && !isArray(range)) {
    return resolveDomain(range, spec, ctx)
  } else if (!isArray(range)) {
    raise('Unsupported range type: ' + JSON.stringify(range))
  }
  return (range as unknown[]).map((v) => (isArray(v) ? plainList : plain)(v, ctx))
}

/** What a spec says, resolved against the signals and data of `ctx`. */
export function readSettings(spec: CompiledScale, ctx: ScaleContext): Settings {
  const type = spec.type || 'linear'
  // the spec itself, read as `type`-defaulted: copying it per build costs more than building a literal scale
  const s = (spec.type ? spec : { ...spec, type }) as CompiledScale & Record<string, unknown>
  // a plain object: keys come from the spec and are copied below with `__proto__` refused, and nothing reads a name the
  // prototype also has
  const settings: Settings = { type }
  settings.domain = resolveDomain(s.domain, s, ctx)
  if (s.range != null) settings.range = resolveRange(s, ctx, settings, ctx.configRange)

  if (s.interpolate != null) {
    const named = s.interpolate as { type?: unknown; gamma?: unknown }
    settings.interpolate = plain((isObject(named) && named.type) || named, ctx)
    if (isObject(named) && named.gamma != null) settings.interpolateGamma = plain(named.gamma, ctx)
  }

  if (s.nice != null) {
    const nice = s.nice as { signal?: unknown; interval?: unknown; step?: unknown }
    settings.nice =
      isObject(nice) && nice.signal ? signalValue(String(nice.signal), ctx) : isObject(nice) ? { interval: plain(nice.interval, ctx), step: plain(nice.step, ctx) } : plain(nice, ctx)
  }

  if (s.bins != null) {
    const bins = s.bins as { signal?: unknown }
    settings.bins = (isObject(bins) && bins.signal) || isArray(bins) ? plainList(bins, ctx) : plainRecord(bins as Record<string, unknown>, ctx)
  }

  // every other key is an option, kept in the order the spec gave it
  for (const key of Object.keys(s)) {
    if (hasOwnProperty(settings, key) || key === 'name' || key === '__proto__') continue
    if (s[key] === undefined) continue
    settings[key] = plain(s[key], ctx)
  }
  return settings
}
