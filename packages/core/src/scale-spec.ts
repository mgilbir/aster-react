/**
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
import { resolveDomain } from './scale-domain.js'
import { isDiscrete } from './scale-registry.js'
import { plain, plainList, plainRecord, signalValue, type ScaleContext } from './scale-signals.js'
import type { CompiledScale } from './types.js'
import { error as raise, hasOwnProperty, isArray, isObject, isString } from './util.js'

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
    else if (range === 'height') range = isDiscrete(spec.type) ? [0, ctx.height] : [ctx.height, 0]
    else raise('Unrecognized scale range value: ' + JSON.stringify(range))
  } else if (r.scheme) {
    into.scheme = isArray(r.scheme) ? plainList(r.scheme, ctx) : plain(r.scheme, ctx)
    if (r.extent) into.schemeExtent = plainList(r.extent, ctx)
    if (r.count) into.schemeCount = plain(r.count, ctx)
    return undefined
  } else if (r.step) {
    into.rangeStep = plain(r.step, ctx)
    return undefined
  } else if (isDiscrete(spec.type) && !isArray(range)) {
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
