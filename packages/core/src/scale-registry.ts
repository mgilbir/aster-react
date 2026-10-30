/**
 * The registry of scale types: the name a spec gives (`linear`, `band`, `diverging-log`, ...) to the constructor that
 * builds it, what kind of scale it is (continuous, discrete, discretizing, interpolating, logarithmic, temporal,
 * quantile), and the inverse members every scale carries (`invertRange`, built from `invert` or `invertExtent` when the
 * scale has no `invertRange` of its own).
 *
 * What callers observe, and so what is fixed here: a constructed scale has its `type` set to the registered name (the
 * `sequential` alias keeps that name), carries a mark that says the registry made it, and has an `invertRange` member that
 * is undefined for scales with no inverse; a copy made with `scaleCopy` keeps its type but not the mark or `invertRange`;
 * `identity` is registered with no kind; unregistered names are not types, whatever the prototype chain of a table holds.
 */
import {
  band,
  binOrdinal,
  diverging,
  divergingLog,
  divergingPow,
  divergingSqrt,
  divergingSymlog,
  identityScale,
  linear,
  log,
  ordinal,
  point,
  pow,
  quantileScale,
  quantize,
  sequential,
  sequentialLog,
  sequentialPow,
  sequentialSqrt,
  sequentialSymlog,
  sqrt,
  symlog,
  threshold,
  time,
  utcTime,
  type ScaleObject,
} from './scale-d3.js'

/**
 * The type hosts see for a scale. It is deliberately loose: a host keeps scales in untyped maps next to marks and
 * signals, and a scale's members differ by type (a band scale has `bandwidth`, a log scale `base`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Scale = any

// ---- names -------------------------------------------------------------------------------------------------

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

/** The kinds a scale type can be. */
export const Continuous = 'continuous'
export const Discrete = 'discrete'
export const Discretizing = 'discretizing'
export const Interpolating = 'interpolating'
export const Temporal = 'temporal'

// ---- inverse members ---------------------------------------------------------------------------------------

/** `invertRange` of a scale with `invert`: the domain values at the two ends of a span of the range. */
function invertingSpan(scale: Scale): (span: ArrayLike<number>) => unknown[] {
  return (span) => {
    const a = span[0]!
    const b = span[1]!
    return b < a ? [scale.invert(b), scale.invert(a)] : [scale.invert(a), scale.invert(b)]
  }
}

/** `invertRange` of a scale with only `invertExtent`: the outer extremes of the classes whose value lies in the span. */
function invertingExtents(scale: Scale): (span: ArrayLike<number>) => unknown[] | undefined {
  return (span) => {
    const a = span[0]!
    const b = span[1]!
    const [lo, hi] = b < a ? [b, a] : [a, b]
    const values = scale.range() as number[]
    let first = -1
    let last = -1
    values.forEach((v, i) => {
      if (v >= lo && v <= hi) {
        if (first < 0) first = i
        last = i
      }
    })
    if (first < 0) return undefined
    const head = scale.invertExtent(values[first])
    const tail = scale.invertExtent(values[last])
    return [head[0] === undefined ? head[1] : head[0], tail[1] === undefined ? tail[0] : tail[1]]
  }
}

// ---- the registry ------------------------------------------------------------------------------------------

const madeHere = new WeakSet<object>()

/** Mark a scale as made by the registry. */
export function registerScale(scale: Scale): Scale {
  madeHere.add(scale)
  return scale
}

/** Whether a scale was made by the registry. */
export function isRegisteredScale(scale: Scale): boolean {
  return madeHere.has(scale)
}

export interface ScaleCtor {
  (): Scale
  /** The kinds of the type, as an object of `kind: true` (empty for `identity`). */
  metadata: Record<string, boolean>
}

const registry = new Map<string, ScaleCtor>()

function register(type: string, make: () => ScaleObject, ...kinds: string[]): void {
  const ctor = (() => {
    const scale = make()
    if (!scale.invertRange) {
      scale.invertRange = scale.invert ? invertingSpan(scale) : scale.invertExtent ? invertingExtents(scale) : undefined
    }
    scale.type = type
    return registerScale(scale)
  }) as ScaleCtor
  ctor.metadata = Object.fromEntries(kinds.map((kind) => [kind, true]))
  registry.set(type, ctor)
}

const NUMERIC = [Continuous, Interpolating]
register(Identity, identityScale)
register(Linear, linear, Continuous)
register(Log, log, Continuous, Log)
register(Pow, pow, Continuous)
register(Sqrt, sqrt, Continuous)
register(Symlog, symlog, Continuous)
register(Time, time, Continuous, Temporal)
register(UTC, utcTime, Continuous, Temporal)
register(Sequential, sequential, ...NUMERIC) // the name before sequential scales had a warp
register(`${Sequential}-${Linear}`, sequential, ...NUMERIC)
register(`${Sequential}-${Log}`, sequentialLog, ...NUMERIC, Log)
register(`${Sequential}-${Pow}`, sequentialPow, ...NUMERIC)
register(`${Sequential}-${Sqrt}`, sequentialSqrt, ...NUMERIC)
register(`${Sequential}-${Symlog}`, sequentialSymlog, ...NUMERIC)
register(`${Diverging}-${Linear}`, diverging, ...NUMERIC)
register(`${Diverging}-${Log}`, divergingLog, ...NUMERIC, Log)
register(`${Diverging}-${Pow}`, divergingPow, ...NUMERIC)
register(`${Diverging}-${Sqrt}`, divergingSqrt, ...NUMERIC)
register(`${Diverging}-${Symlog}`, divergingSymlog, ...NUMERIC)
register(Quantile, quantileScale, Discretizing, Quantile)
register(Quantize, quantize, Discretizing)
register(Threshold, threshold, Discretizing)
register(BinOrdinal, binOrdinal, Discrete, Discretizing)
register(Ordinal, ordinal, Discrete)
register(Band, band, Discrete)
register(Point, point, Discrete)

/** The constructor registered for a type name, if there is one. */
export function scale(type: string): ScaleCtor | undefined {
  return registry.get(type)
}

export function isValidScaleType(type: string): boolean {
  return registry.has(type)
}

const hasKind = (type: string, kind: string): boolean => registry.get(type)?.metadata[kind] === true

export const isContinuous = (type: string): boolean => hasKind(type, Continuous)
export const isDiscrete = (type: string): boolean => hasKind(type, Discrete)
export const isDiscretizing = (type: string): boolean => hasKind(type, Discretizing)
export const isLogarithmic = (type: string): boolean => hasKind(type, Log)
export const isTemporal = (type: string): boolean => hasKind(type, Temporal)
export const isInterpolating = (type: string): boolean => hasKind(type, Interpolating)
export const isQuantile = (type: string): boolean => hasKind(type, Quantile)

/** A copy of a scale of the same type (the copy is a bare scale: it keeps no registry mark and no `invertRange`). */
export function scaleCopy(source: Scale): Scale {
  const copy = source.copy()
  copy.type = source.type
  return copy
}
