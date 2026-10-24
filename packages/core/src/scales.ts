/**
 * Scale construction. The scale layer is owned (ported from d3-scale and
 * vega-scale behind oracle vectors) so scale types, schemes, and tick logic
 * match vega exactly.
 */
import * as vs from './scale.js'
import { interpolateRound } from './interp.js'
import { ownGet } from './util.js'
import { quantizeInterpolator } from './scale.js'
import { hcl, rgb } from './color.js'
import type { CompiledScale, ScaleDomain, ScaleRange } from './types.js'

export type Scale = vs.Scale

type SchemeFn = (t: number) => unknown

export interface ColorScale extends Scale {
  interpolate?(interpolator: () => SchemeFn): this
  interpolator?(fn?: SchemeFn): this | SchemeFn
}

export interface ScaleContext {
  width: number
  height: number
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** `config.range` — a named range ('category', 'ramp', ...) resolves through
   * it before the built-in aliases (vega-parser's range lookup). */
  configRange?: Record<string, unknown>
  /** Evaluate a JS expression string and return the result. */
  evaluate?: (expr: string) => unknown
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
  /** Return all rows of a named dataset (for aggregate sort). */
  dataRows?: (dataName: string) => Record<string, unknown>[]
  /** Host/runtime domain override (vega `domainRaw`, pan/zoom, brush domains). */
  domainRaw?: unknown[]
  /**
   * Distinct-value memo keyed by the dataset rows ARRAY identity. It must live
   * exactly as long as one evaluation: the incremental path (and hosts that
   * mutate their arrays in place) reuse an array object with new contents, so a
   * process-global memo would serve stale domains.
   */
  distinctCache?: WeakMap<unknown[], Map<string, unknown[]>>
}

export const CONTINUOUS_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize'])
const INCLUDE_ZERO_TYPES = new Set(['linear', 'pow', 'sqrt'])
const TIME_SCALE_TYPES = new Set(['time', 'utc'])

/** d3-interpolate's hcl interpolator: hue takes the shortest arc (the ±360
 * correction), chroma/luminance/opacity interpolate linearly; the result
 * formats as `rgb(r, g, b)` like every engine color. */
function interpolateHclStrings(a: string, b: string): (t: number) => string {
  const A = hcl(a)
  const B = hcl(b)
  // d3-interpolate's hue(): an achromatic endpoint (NaN hue) holds the other
  // endpoint's hue constant instead of poisoning the whole interpolation.
  let h0 = A.h
  let hStep = 0
  if (isNaN(A.h)) h0 = B.h
  else if (!isNaN(B.h)) {
    const dh = B.h - A.h
    hStep = dh > 180 || dh < -180 ? dh - 360 * Math.round(dh / 360) : dh
  }
  return (t) => {
    const c = hcl(h0 + t * hStep, A.c + t * (B.c - A.c), A.l + t * (B.l - A.l), A.opacity + t * (B.opacity - A.opacity))
    return c.formatRgb()
  }
}

/** vega-scale interpolateColors: d3-array piecewise over colorspace
 * interpolators (type 'hcl' or the 'rgb' fallback). */
function piecewiseColors(palette: string[], type?: string): (t: number) => string {
  const n = palette.length - 1
  if (n < 1) return () => palette[0]!
  const segs = palette.slice(0, -1).map((c, i) => {
    if (type === 'hcl') return interpolateHclStrings(c, palette[i + 1]!)
    const A = rgb(c)
    const B = rgb(palette[i + 1]!)
    return (t: number) => rgb(A.r + t * (B.r - A.r), A.g + t * (B.g - A.g), A.b + t * (B.b - A.b), A.opacity + t * (B.opacity - A.opacity)).formatRgb()
  })
  return (t) => {
    if (t <= 0) return rgb(palette[0]!).formatRgb()
    if (t >= 1) return rgb(palette[n]!).formatRgb()
    const i = Math.min(Math.floor(t * n), n - 1)
    return segs[i]!(t * n - i)
  }
}

function resolveRawDomain(raw: unknown, ctx: ScaleContext): unknown[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') {
    const signal = (raw as { signal?: unknown }).signal
    if (typeof signal === 'string') {
      try {
        const value = ctx.evaluate?.(signal)
        if (Array.isArray(value)) return value
      } catch { /* unresolved signal this round */ }
    }
  }
  if (typeof raw === 'string') {
    try {
      const value = ctx.evaluate?.(raw)
      if (Array.isArray(value)) return value
    } catch { /* unresolved signal this round */ }
  }
  return null
}

/** Continuous types vega turns into `sequential-<type>` when given a colour scheme (excludes time/utc). */
const SEQUENTIAL_BASES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog'])

export function buildScale(c: CompiledScale, ctx: ScaleContext): Scale {
  const type = c.type
  const raw = ctx.domainRaw ?? c.domainRaw
  // Vega's domainRaw is a *replacement* for the data-derived domain. It may be
  // a literal array or a signal reference; resolve both once here so the rest
  // of the scale pipeline (nice/zero/domainMin/domainMax) is unchanged.
  const rawDomain = resolveRawDomain(raw, ctx)
  const domain = rawDomain ?? resolveDomain(type, c.domain, ctx)
  // vega-encode's scaleKey: a continuous colour scale with a domainMid (a
  // 3-element domain) is built as a DIVERGING scale, not a linear one; the
  // midpoint then maps to the interpolator's centre instead of falling off a
  // mismatched domain/range.
  const isColorRange = typeof c.range === 'string' || c.scheme != null
  const diverging = c.domainMid != null && isColorRange
    && (type === 'linear' || type === 'log' || type === 'pow' || type === 'sqrt' || type === 'symlog')
  const factory = vs.scale(diverging ? `diverging-${type}` : type)
  if (!factory) throw new Error(`[aster] unsupported scale type "${type}"`)

  let s = factory()
  // A diverging scale's domain is always the 3-tuple [min, mid, max]. Splice
  // domainMid in BEFORE handing it to d3 — reading back a 2-value domain from
  // a diverging scale yields its default x2, so the later generic splice would
  // insert at the wrong position (and d3 would drop the extra element).
  let divergingDomain: number[] | undefined
  if (diverging && c.domainMid != null && domain.length >= 2 && rawDomain == null) {
    const d0 = Number(domain[0])
    const d1 = Number(domain[domain.length - 1])
    const mid = Number(c.domainMid)
    divergingDomain = mid > d1 ? [d0, d1, mid] : mid < d0 ? [mid, d0, d1] : [d0, mid, d1]
  }
  s.domain(divergingDomain ?? domain)
  // vega-encode's Scale transform disables d3's implicit ordinal domain once an
  // explicit domain is set (`scale.unknown(undefined)`): an out-of-domain value
  // maps to undefined instead of growing the domain (and its colour range).
  if (type === 'ordinal' && c.domain != null) {
    ;(s as unknown as { unknown?: (v: undefined) => unknown }).unknown?.(undefined)
  }
  // The identity scale maps its input straight through; it has no range (the
  // schema's identity base declares none) and ignores nice/zero/round. Upstream
  // configureRange is a no-op for it, so an absent range is not an error.
  if (type === 'identity') {
    if (c.clamp) s.clamp?.(true)
    return s
  }

  // When the scale has a `scheme` property but no `range`, resolve the scheme
  // to a concrete range.  Vega resolves `scheme` during the Scale encode
  // transform; for ordinal scales this yields the scheme's color array.
  let effectiveRange = c.range
  if (effectiveRange == null && c.scheme) {
    const schemeArr = vs.scheme(c.scheme)
    if (Array.isArray(schemeArr)) {
      effectiveRange = schemeArr as unknown as ScaleRange
    } else if (typeof schemeArr === 'function') {
      // Continuous scheme (e.g. 'viridis', 'blues'): pass the scheme name as
      // a string so the continuous interpolation path handles it, rather than
      // passing the interpolator function through resolveRange.
      effectiveRange = c.scheme as unknown as ScaleRange
    }
  }
  // Band/point scales with a step-based range (`{step: N}` or
  // `{step: {signal}}`, emitted by Vega-Lite for facet/fit layouts): the step
  // fully determines the range given the domain count, so set `.step()` and
  // skip `.range()`.
  const stepRange = effectiveRange && typeof effectiveRange === 'object' && !Array.isArray(effectiveRange) && 'step' in (effectiveRange as object)
    ? (effectiveRange as unknown as { step: unknown }).step
    : undefined
  let range0: unknown[] | string | { __asterScheme: string; __asterExtent?: number[] }
  if (stepRange !== undefined) {
    const stepVal = typeof stepRange === 'number' ? stepRange
      : stepRange && typeof stepRange === 'object' && 'signal' in stepRange
        ? (resolveRangeSignal((stepRange as { signal: string }).signal, ctx) as number)
        : NaN
    // vega-scale's band `.step()` setter does NOT re-expand the range (it only
    // derives step from an explicit range), so compute the range ourselves:
    //   rangeEnd = step * bandSpace(count, paddingInner, paddingOuter)
    const count = ((s as unknown as { domain: () => unknown[] }).domain() ?? []).length
    const pInner = c.paddingInner ?? c.padding ?? 0
    const pOuter = c.paddingOuter ?? c.padding ?? 0
    const rangeEnd = Number.isFinite(stepVal) ? stepVal * vs.bandSpace(count, pInner, pOuter) : 1
    ;(s as { range: (r: number[]) => unknown }).range([0, rangeEnd])
    if (Number.isFinite(stepVal)) (s as { step?: (n: number) => unknown }).step?.(stepVal)
    range0 = [0, rangeEnd]
  } else {
    range0 = resolveRange(effectiveRange, ctx, type, (s.domain() as unknown[]).length)
  }
  // Handle continuous schemes: scheme strings like 'blues' for color interpolation
  const isSchemeRef = range0 != null && typeof range0 === 'object' && '__asterScheme' in (range0 as object)
  if ((typeof range0 === 'string' || isSchemeRef) && CONTINUOUS_TYPES.has(type)) {
    const ref = range0 as string | { __asterScheme: string; __asterExtent?: number[] }
    const schemeName = typeof ref === 'string' ? ref : ref.__asterScheme
    const schemeExtent = typeof ref === 'string' ? undefined : ref.__asterExtent
    const schemeFn = vs.scheme(schemeName)
    if (typeof schemeFn === 'function') {
      // vega-encode scaleKey: a continuous scale with an interpolating colour
      // scheme and a two-value domain IS a `sequential-<type>` scale (a
      // three-value one a diverging scale, handled above). Evaluating it as a
      // plain linear scale with a colour interpolator maps values with a
      // different float evaluation order, shifting colours by one unit.
      if (!diverging && SEQUENTIAL_BASES.has(type) && (s.domain() as unknown[]).length === 2) {
        const seq = vs.scale(`sequential-${type}`)?.()
        if (seq) {
          seq.domain(s.domain())
          s = seq
        }
      }
      s.range([0, 1])
      const cs = s as ColorScale
      // vega configureScheme/adjustScheme: the interpolator samples the
      // scheme across flip(extent ?? [0,1], reverse) — reverse folds into
      // the extent flip, and configureRange returns before any range flip
      // for interpolating scales.
      const e0 = schemeExtent ? schemeExtent[0]! : 0
      const e1 = schemeExtent ? schemeExtent[1]! : 1
      const baseA = c.reverse ? e1 : e0
      const baseB = c.reverse ? e0 : e1
      // d3's continuous bimap reverses the range for a descending domain;
      // sequential scales do not. An interpolating color scale stores its
      // palette as a [0,1] range, so fold that same reversal into the
      // sampled extent instead of losing it in the interpolator.
      const domNow = (s.domain() as unknown[])
      // domainMin/domainMax are applied after the range is configured; fold
      // their eventual endpoints into the descending-domain test.
      const expectedFirst = c.domainMin != null && !Array.isArray(c.domainMin) ? c.domainMin : domNow[0]
      const expectedLast = c.domainMax != null && !Array.isArray(c.domainMax) ? c.domainMax : domNow[domNow.length - 1]
      const descending = domNow.length > 1
        && Number(expectedLast) < Number(expectedFirst)
      const flip = descending && type !== 'sequential' && !String((s as { type?: string }).type).startsWith('sequential')
      const a = flip ? baseB : baseA
      const b = flip ? baseA : baseB
      const effectiveSchemeFn: SchemeFn = ((t: number) => (schemeFn as (t: number) => unknown)(a + t * (b - a)) as unknown) as SchemeFn
      // d3 sequential/diverging scales use .interpolator() (not .interpolate)
      if (typeof cs.interpolator === 'function') {
        cs.interpolator(effectiveSchemeFn)
      } else if (typeof (cs as any).interpolate === 'function') {
        (cs as any).interpolate(() => effectiveSchemeFn)
      }
      cs.interpolator = () => effectiveSchemeFn
    } else if (Array.isArray(schemeFn)) {
      // a discrete-color scheme on a continuous scale: vega-scale
      // interpolateColors(piecewise(interpolate(type||'rgb'), palette)) —
      // the palette is sampled piecewise in the scale's colorspace
      // (vega-lite emits interpolate 'hcl' for these)
      const fn = piecewiseColors(schemeFn as string[], c.interpolate)
      s.range([0, 1])
      const cs = s as ColorScale
      if (typeof cs.interpolator === 'function') cs.interpolator(fn as unknown as SchemeFn)
      else if (typeof (cs as any).interpolate === 'function') (cs as any).interpolate(() => fn)
      cs.interpolator = () => fn as unknown as SchemeFn
    } else {
      s.range(range0 as never)
    }
  } else if (
    CONTINUOUS_TYPES.has(type) && type !== 'quantize' && Array.isArray(range0) && range0.length > 2 && c.interpolate != null
    && range0.every((v) => typeof v === 'string')
  ) {
    // vega-scale resolves an explicit multi-color range array on an
    // interpolating scale to a piecewise color interpolator. d3's polymap
    // would pair it against the two-value domain and only use the first two
    // colors; vega spreads the whole palette across the domain instead.
    const fn = piecewiseColors(range0 as string[], c.interpolate)
    s.range([0, 1])
    const cs = s as ColorScale
    if (typeof cs.interpolator === 'function') cs.interpolator(fn as unknown as SchemeFn)
    else if (typeof (cs as any).interpolate === 'function') (cs as any).interpolate(() => fn)
    cs.interpolator = () => fn as unknown as SchemeFn
  } else {
    s.range(range0 as never)
  }
  if (c.rangeMin != null || c.rangeMax != null) {
    const r = (s.range() as unknown[]).slice()
    if (r.length) {
      if (c.rangeMin != null) r[0] = c.rangeMin
      if (c.rangeMax != null) r[r.length - 1] = c.rangeMax
      s.range(r as never)
    }
  }

  // Don't reverse for scheme-based color: range [0,1] is the normalized domain
  // Also skip zero/padding/round/clamp for color scales
  if (!CONTINUOUS_TYPES.has(type)) {
    if (c.reverse) s.range(s.range().slice().reverse() as unknown[])
    if (c.round) s.round?.(true)
    if (c.clamp) s.clamp?.(true)
    if (c.padding != null) s.padding?.(c.padding)
    if (c.paddingInner != null) s.paddingInner?.(c.paddingInner)
    if (c.paddingOuter != null) s.paddingOuter?.(c.paddingOuter)
    if (c.align != null) s.align?.(c.align)
  }

  // interpolating (scheme) scales return from configureRange before the
  // range flip — reverse is folded into the extent-sampled interpolator
  if (CONTINUOUS_TYPES.has(type) && typeof range0 !== 'string' && !isSchemeRef) {
    if (c.reverse) s.range(s.range().slice().reverse() as unknown[])
  } else if (rawDomain == null && (c.domainMin != null || c.domainMax != null)) {
    applyDomainMinMax(s, c.domainMin, c.domainMax)
  }
  if (c.exponent != null) s.exponent?.(c.exponent)
  if (c.constant != null) s.constant?.(c.constant)
  if (c.base != null) s.base?.(c.base)
  // vega's Scale transform configures rounding as `scale.round(round)` when
  // the scale has the method (band/point), else `scale.interpolate(
  // interpolateRound)` — continuous scales have no round method, so their
  // rounding goes through the range interpolator.
  if (c.round) {
    if (typeof s.round === 'function') s.round(true)
    else if (typeof (s as unknown as { interpolate?: unknown }).interpolate === 'function') {
      ;(s as unknown as { interpolate: (f: unknown) => unknown }).interpolate(interpolateRound)
    }
  }
  if (c.clamp) s.clamp?.(true)
  if (c.padding != null) s.padding?.(c.padding)
  if (c.paddingInner != null) s.paddingInner?.(c.paddingInner)
  if (c.paddingOuter != null) s.paddingOuter?.(c.paddingOuter)

  // A continuous scale whose range resolves to a color scheme is a sequential
  // color scale; vega never applies `zero` extension to it (the domain maps
  // directly onto [0,1] of the interpolator).
  const isColorScheme = CONTINUOUS_TYPES.has(type) && (typeof range0 === 'string' || isSchemeRef)
  const zero = rawDomain == null && !TIME_SCALE_TYPES.has(type)
    && (c.zero != null ? c.zero : (!isColorScheme && INCLUDE_ZERO_TYPES.has(type)))
  if (zero) applyZero(s)
  if (rawDomain == null && (c.domainMin != null || c.domainMax != null)) applyDomainMinMax(s, c.domainMin, c.domainMax)
  // Vega's Scale transform splices domainMid into the domain array so that the
  // midpoint value is explicitly represented as a domain breakpoint.  The
  // resulting piecewise-linear scale maps domainMid to a range value that
  // maintains the same slope established by the surrounding domain/range pairs.
  // The splice happens after zero/domainMin/domainMax (which establish the
  // baseline domain) and before nice (which rounds the domain boundaries).
  if (rawDomain == null && c.domainMid != null && CONTINUOUS_TYPES.has(type) && divergingDomain == null) {
    applyDomainMid(s, c.domainMid)
  }
  // Vega's Scale transform adjusts continuous domains for minimum pixel
  // padding (`padDomain`): the domain is zoomed out around its midpoint so the
  // extreme data values land `padding` px inside the range. Applies to all
  // continuous scales (linear/log/pow/sqrt/symlog/time/utc), matching vega's
  // `includePad(type)` guard.
  if (rawDomain == null && CONTINUOUS_TYPES.has(type) && c.padding != null) applyPixelPadding(s, c, c.padding)
  if (rawDomain == null && c.nice) applyNice(s, c.nice)
  if (c.exponent != null) s.exponent?.(c.exponent)
  if (c.constant != null) s.constant?.(c.constant)
  if (c.base != null) s.base?.(c.base)

  // Set scale.bins if specified in the scale config.
  // When scale.bins is set, the tickValues/tickCount helpers
  // use validTicks(scale, scale.bins, count) instead of scale.ticks(count),
  // which generates ticks from the actual bin boundaries.
  if (Array.isArray(c.bins) && c.interpolate != null) {
    ;(s as unknown as { bins: unknown[] }).bins = c.bins
  } else if (c.bins && !Array.isArray(c.bins)) {
    const binsVal = resolveBins(c.bins as { signal?: string }, ctx)
    if (binsVal && typeof binsVal === 'object' && 'start' in binsVal && 'stop' in binsVal && 'step' in binsVal) {
      const b = binsVal as { start: number; stop: number; step: number }
      // Generate bin boundary array: [start, start+step, ..., stop]
      const binArray: number[] = []
      for (let v = b.start; v <= b.stop + b.step * 0.5; v += b.step) {
        binArray.push(Math.round(v * 1e10) / 1e10)
      }
      ;(s as any).bins = binArray
    }
  }

  return s
}

function resolveBins(
  bins: { signal?: string } | undefined | string,
  ctx: ScaleContext,
): Record<string, number> | undefined {
  if (!bins) return undefined
  if (typeof bins === 'string') {
    const v = ctx.signals[bins]
    if (v && typeof v === 'object' && 'start' in v && 'stop' in v && 'step' in v) {
      return v as Record<string, number>
    }
    return undefined
  }
  if (bins.signal) {
    const v = ctx.signals[bins.signal]
    if (v && typeof v === 'object' && 'start' in v && 'stop' in v && 'step' in v) {
      return v as Record<string, number>
    }
  }
  return undefined
}

function applyNice(s: Scale, nice: boolean | number | string) {
  if (!s.nice) return
  // vega's Scale transform: `scale.nice((_.nice !== true && tickCount(scale,
  // _.nice)) || null)` — every non-true nice goes through the tickCount util,
  // which resolves an interval string against the scale (time/utc → calendar
  // interval; anything else refuses, as upstream does).
  if (nice !== true) s.nice(vs.tickCount(s as never, nice) ?? null)
  else s.nice()
}

function applyZero(s: Scale) {
  const d = (s.domain() as number[]).slice()
  if (!d.length) return
  d[0] = Math.min(0, d[0]!)
  d[1] = Math.max(0, d[1]!)
  s.domain(d)
}

function applyDomainMinMax(s: Scale, min?: number, max?: number) {
  const d = (s.domain() as number[]).slice()
  if (min != null) d[0] = min
  if (max != null) d[1] = max
  s.domain(d)
}

/**
 * Vega's Scale transform: splice domainMid into the continuous domain array so
 * the midpoint is an explicit breakpoint.  The splice position mirrors Vega's
 * logic exactly: `i = mid > d[n] ? n+1 : mid < d[0] ? 0 : n`.  When the
 * midpoint falls inside the domain, it is inserted before the last element
 * (index n), creating a 3-element domain.  The range is left untouched; d3
 * handles mismatched domain/range lengths by extrapolating beyond the last
 * range value, matching vega-encode's behaviour.
 */
function applyDomainMid(s: Scale, mid: number) {
  const d = (s.domain() as number[]).slice()
  const n = d.length - 1 || 1
  const i = mid > d[n]! ? n + 1 : mid < d[0]! ? 0 : n
  d.splice(i, 0, mid)
  s.domain(d)
}

/**
 * vega-encode `padDomain`: zoom a continuous scale domain out around its
 * midpoint so the extreme domain values sit `pad` px inside the range
 * (`frac = span / (span - 2*pad)`). The zoom runs in the scale's transform
 * space: log zooms logarithmically, sqrt/pow exponentially, symlog through
 * log1p (vega-util zoom.js); everything else linearly.
 */
function applyPixelPadding(s: Scale, c: CompiledScale, pad: number) {
  const range = s.range() as number[]
  if (range.length < 2) return
  const span = Math.abs((range[range.length - 1] ?? 0) - (range[0] ?? 0))
  if (!(span > 0)) return
  const domain = (s.domain() as number[]).slice()
  if (domain.length < 2 || domain[0] === domain[domain.length - 1]) return
  if (!Number.isFinite(Number(domain[0])) || !Number.isFinite(Number(domain[domain.length - 1]))) return
  const frac = span / (span - 2 * pad)
  const type = c.type
  const d =
    type === 'log' ? zoomLog(domain, frac)
    : type === 'sqrt' ? zoomPow(domain, frac, 0.5)
    : type === 'pow' ? zoomPow(domain, frac, (c.exponent as number) || 1)
    : type === 'symlog' ? zoomSymlog(domain, frac, (c.constant as number) || 1)
    : zoomLinear(domain, frac)
  domain[0] = d[0] as unknown as number
  domain[domain.length - 1] = d[1] as unknown as number
  s.domain(domain)
}

// ---- vega-util zoom.js (domain-space zooming for padDomain) ----------------

const zoomExp = (sign: number) => (x: number) => sign * Math.exp(x)
const zoomLogF = (sign: number) => (x: number) => Math.log(sign * x)
const zoomSymlogF = (c: number) => (x: number) => Math.sign(x) * Math.log1p(Math.abs(x / c))
const zoomSymexpF = (c: number) => (x: number) => Math.sign(x) * Math.expm1(Math.abs(x)) * c
const zoomPowF = (exponent: number) => (x: number) => x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent)

function zoomDomain(domain: number[], frac: number, lift: (x: number) => number, ground: (x: number) => number): [number, number] {
  const d0 = lift(domain[0]!)
  const d1 = lift(domain[domain.length - 1]!)
  const da = (d0 + d1) / 2
  return [ground(da + (d0 - da) * frac), ground(da + (d1 - da) * frac)]
}

function zoomLinear(domain: number[], frac: number): [number, number] {
  return zoomDomain(domain, frac, Number, (x) => x)
}

function zoomLog(domain: number[], frac: number): [number, number] {
  const sign = Math.sign(domain[0]!)
  return zoomDomain(domain, frac, zoomLogF(sign), zoomExp(sign))
}

function zoomPow(domain: number[], frac: number, exponent: number): [number, number] {
  return zoomDomain(domain, frac, zoomPowF(exponent), zoomPowF(1 / exponent))
}

function zoomSymlog(domain: number[], frac: number, constant: number): [number, number] {
  return zoomDomain(domain, frac, zoomSymlogF(constant), zoomSymexpF(constant))
}

/** Continuous-domain reduction shared by the union forms. Returns null when
 * the values are not reducible to a continuous domain (caller falls through). */
function mergeUnionDomain(type: string, all: unknown[]): [number, number] | [Date, Date] | null {
  if (type === 'time' || type === 'utc') {
    const dates = all.filter((v) => v instanceof Date && Number.isFinite((v as Date).getTime())) as Date[]
    if (dates.length) {
      const ms = dates.map((d) => d.getTime())
      return [new Date(Math.min(...ms)), new Date(Math.max(...ms))]
    }
    const nums = all.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
    if (nums.length) return [Math.min(...nums), Math.max(...nums)]
    return null
  }
  const coercible = all
    .map((v) => v instanceof Date ? v.getTime() : v)
    .filter(
      (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)),
    ) as number[]
  if (!coercible.length) return null
  return [Math.min(...coercible), Math.max(...coercible)]
}

function resolveDomain(type: string, domain: ScaleDomain, ctx: ScaleContext): unknown[] {
  if (Array.isArray(domain)) return domain.slice()
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    if ('signal' in domain && domain.signal) {
      // Try a plain signal name lookup first
      const v = ctx.signals[domain.signal]
      if (v != null) {
        return Array.isArray(v) ? (v as unknown[]) : [v]
      }
      // Not a plain signal name — the signal name might be a JS expression string
      // that references a bins object (e.g. "[bin_maxbins_10_v_bins.start, bin_maxbins_10_v_bins.stop]").
      // Find the bins signal name embedded in the expression and expand it.
      // Pattern: "[<name>.start, <name>.stop]" or similar
      const binsMatch = domain.signal.match(/\[([^\]]*\.start)[\s,\s]*([^\]]*\.stop)?\]/)
      if (binsMatch) {
        const propExpr = binsMatch[1] as string  // e.g. "bin_maxbins_10_v_bins.start"
        const dotIdx = propExpr.lastIndexOf('.')
        if (dotIdx > 0) {
          const sigKey = propExpr.substring(0, dotIdx)  // e.g. "bin_maxbins_10_v_bins"
          const sigVal = ctx.signals[sigKey]
          if (sigVal && typeof sigVal === 'object') {
            const startVal = (sigVal as Record<string, unknown>).start
            const stopVal = (sigVal as Record<string, unknown>).stop
            if (typeof startVal === 'number' && typeof stopVal === 'number') {
              return [startVal, stopVal]
            }
          }
        }
      }
      throw new Error(`[aster] unresolved signal in scale domain: ${domain.signal}`)
    }
    // union domain: {fields: [{data, field}, ...]} — vega's multi-dataset
    // union form used by layered charts
    if ('fields' in domain && Array.isArray((domain as { fields?: unknown }).fields) &&
        (domain as { fields?: unknown[] }).fields!.some((f) => f != null && typeof f === 'object')) {
      const all: unknown[] = []
      for (const f of (domain as { fields: unknown[] }).fields) {
        if (f == null || typeof f !== 'object') continue
        const e = f as { data?: string; field?: string }
        if (typeof e.data === 'string' && typeof e.field === 'string') {
          for (const val of ctx.dataField(e.data, e.field)) all.push(val)
        }
      }
      const merged = mergeUnionDomain(type, all)
      if (merged && (CONTINUOUS_TYPES.has(type) || type === 'threshold')) return merged
      // discrete union (band/point): the distinct values, sorted per the
      // domain's sort flag
      const present = all.filter((v) => v != null)
      const distinct = Array.from(new Set(present))
      if ((domain as { sort?: unknown }).sort === true || (domain as { sort?: unknown }).sort === 'ascending') {
        distinct.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      }
      return distinct
    }
    if ('data' in domain) {
      const { data, field, fields } = domain as { data: string; field?: string; fields?: string[] }
      const domainDataRows = ctx.dataRows ? ctx.dataRows(data) : undefined
      const fieldsToCollect = fields ?? (field ? [field] : [])
      const all: unknown[] = []
      for (const f of fieldsToCollect) {
        for (const val of ctx.dataField(data, f)) all.push(val)
      }
      if (CONTINUOUS_TYPES.has(type) || type === 'threshold') {
        if (type === 'time' || type === 'utc') {
          const dates = all.filter(
            (v) => v instanceof Date && Number.isFinite(v.getTime()),
          ) as Date[]
          if (dates.length) {
            const ms = dates.map((d) => d.getTime())
            return [Math.min(...ms), Math.max(...ms)]
          }
          const nums = all.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
          if (nums.length) return [Math.min(...nums), Math.max(...nums)]
        }
        // d3-scale coerces the domain through +d (strings like "28" become
        // numbers); vega feeds it whatever the data holds. Keep strings that
        // coerce, drop the rest — same observable behavior as d3.
        const coercible = all
          .map((v) => v instanceof Date ? v.getTime() : v)
          .filter(
            (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)),
          ) as number[]
        if (!coercible.length) {
          // vega's multi-field aggregate domain bottoms out at [0, 0] over an
          // empty dataset; a single-field domain stays empty (no ticks)
          return fieldsToCollect.length > 1 ? [0, 0] : []
        }
        return [Math.min(...coercible), Math.max(...coercible)]
      }
      // `all` is freshly collected per call via ctx.dataField; cache the
      // distinct pass by the underlying rows identity when available.
      // Single-field domains only: multi-field collection stays uncached.
      const vals = (all.length && all.every((v) => v == null)
        ? [undefined]
        : domainDataRows && fields == null && field != null
          ? distinctValuesCached(ctx.distinctCache, domainDataRows, field, (rws, fld) =>
              (ctx.dataField ?? ((_d: string, _f: string) => []))(data, fld))
          : distinctValues(all)).slice() as unknown[]
      const sortSpec = (domain as { sort?: unknown }).sort
      if (sortSpec === true || sortSpec === 'ascending') {
        vals.sort((a, b) => (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0)
      } else if (sortSpec === 'descending') {
        vals.sort((a, b) => (a as string) > (b as string) ? -1 : (a as string) < (b as string) ? 1 : 0)
      } else if (sortSpec && typeof sortSpec === 'object' && !Array.isArray(sortSpec)) {
        const ss = sortSpec as { op?: string; field?: string; order?: string }
        if (ss.op && ss.field && ctx.dataRows) {
          // Aggregate sort: group rows by domain field, compute op per group, sort
          const domainField = (domain as { field: string }).field
          const dataName = (domain as { data: string }).data
          const rows = ctx.dataRows(dataName)
          const agg = new Map<unknown, number>()
          for (const r of rows) {
            const key = r[domainField]
            const val = typeof r[ss.field] === 'number' ? r[ss.field] as number : Number(r[ss.field]) || 0
            agg.set(key, (agg.get(key) ?? 0) + val)
          }
          const desc = ss.order === 'descending'
          vals.sort((a, b) => {
            const av = agg.get(a) ?? 0, bv = agg.get(b) ?? 0
            return desc ? bv - av : av - bv
          })
        } else if (!ss.field || ss.field === 'key') {
          // Alphabetical sort: {order: "descending"} or {order: "descending", field: "key"}
          // The "key" field is a Vega-Lite marker for alphabetical sort.
          // When sort has a real field but no op (e.g. {field: "val", order: "descending"}),
          // Vega does not sort the domain — preserve insertion order.
          const order = ss.order
          if (order === 'descending') {
            vals.sort((a, b) => (a as string) > (b as string) ? -1 : (a as string) < (b as string) ? 1 : 0)
          } else if (order === 'ascending' || !order) {
            vals.sort((a, b) => (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0)
          }
        }
      }
      return vals
    }
  }
  if (typeof domain === 'string') {
    const v = ctx.signals[domain]
    if (v == null) throw new Error(`[aster] unresolved signal domain: ${domain}`)
    return Array.isArray(v) ? (v as unknown[]) : [v]
  }
  return []
}

// Per-evaluation, per-dataset-identity memo for ordinal domain collection. The
// same (rows, field) pair is collected several times per evaluation (scale
// domain, axis build, legend); the memo is owned by the evaluation (see
// ScaleContext.distinctCache), never shared across evaluations.
function distinctValuesCached(
  cache: WeakMap<unknown[], Map<string, unknown[]>> | undefined,
  rows: unknown[],
  field: string,
  collect: (rows: unknown[], field: string) => unknown[],
): unknown[] {
  if (!cache) return distinctValues(collect(rows, field))
  let byField = cache.get(rows)
  if (!byField) {
    byField = new Map()
    cache.set(rows, byField)
  }
  let vals = byField.get(field)
  if (!vals) {
    vals = distinctValues(collect(rows, field))
    byField.set(field, vals)
  }
  return vals
}

function distinctValues(values: unknown[]): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  for (const v of values) {
    // vega's discrete domain is an Aggregate groupby, and its object keys
    // stringify the value: two distinct arrays/objects with the same string
    // form collapse into one domain entry (the first). The `values` aggregate
    // op emits an array per group, so this is what turns its domain into a
    // single entry.
    const key = v !== null && typeof v === 'object' && !(v instanceof Date) ? `obj:${String(v)}` : v
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

function resolveRangeSignal(signal: string, ctx: ScaleContext): unknown {
  // Try direct signal name lookup first
  const v = ctx.signals[signal]
  if (v != null) return v
  // Not a plain signal name — try evaluating as a Vega expression (e.g. "bandwidth('x')")
  if (ctx.evaluate) {
    try {
      const result = ctx.evaluate(signal)
      if (result != null) return result
    } catch { /* fall through to error */ }
  }
  return undefined
}

function resolveRange(range: ScaleRange, ctx: ScaleContext, scaleType?: string, domainCount = 0): unknown[] | string | { __asterScheme: string; __asterExtent?: number[] } {
  if (Array.isArray(range)) {
    return range.map((r) => {
      if (r && typeof r === 'object' && 'signal' in r) {
        const v = resolveRangeSignal((r as { signal: string }).signal, ctx)
        if (v == null) throw new Error(`[aster] unresolved signal range element: ${(r as { signal: string }).signal}`)
        return v
      }
      return r
    })
  }
  if (typeof range === 'string') {
    switch (range) {
      case 'width':
        return [0, ctx.width]
      case 'height':
        // Vega resolves "height" to [0, height] for band/ordinal/point scales
        // (natural top-to-bottom direction) and [height, 0] for continuous scales
        // (inverted y-axis).
        if (scaleType === 'band' || scaleType === 'ordinal' || scaleType === 'point') {
          return [0, ctx.height]
        }
        return [ctx.height, 0]
      default: {
        // A named palette range on a positional band/point scale is not a
        // numeric range: vega's parser yields [NaN, NaN] (probed: band
        // ranges like "symbol"/"ramp" degenerate the scale, not colour it).
        if (scaleType === 'band' || scaleType === 'point') return [NaN, NaN]
        // A `config.range.<name>` entry resolves first (vega-parser's range
        // lookup: the config block shadows the built-in range definitions).
        // An array is the palette itself; a `{scheme}` object resolves to the
        // scheme colors (ordinal) or keeps the scheme name (continuous, where
        // the interpolator needs the name); anything else refuses upstream
        // ('Unrecognized scale range value').
        const cfg = ownGet(ctx.configRange, range)
        if (cfg != null) {
          if (Array.isArray(cfg)) return cfg
          if (cfg && typeof cfg === 'object' && 'scheme' in cfg) {
            const schemeName = (cfg as { scheme: string }).scheme
            const extent = (cfg as { extent?: number[] }).extent
            if (scaleType === 'band' || scaleType === 'ordinal' || scaleType === 'point') {
              const colors = vs.scheme(schemeName)
              if (Array.isArray(colors)) return colors
              if (typeof colors === 'function') {
                // vega configureScheme: a continuous scheme on a discrete
                // scale quantizes to the DOMAIN cardinality (schemeCount
                // applies only to quantile/quantize)
                return quantizeInterpolator(colors as (t: number) => unknown, Math.max(domainCount, 1)) as unknown[]
              }
              throw new Error(`Unrecognized scale scheme: ${schemeName}`)
            }
            // continuous: thread the extent through to the interpolator
            return extent ? { __asterScheme: schemeName, __asterExtent: extent } : schemeName
          }
          throw new Error(`Unrecognized scale range value: ${JSON.stringify(range)}`)
        }
        // Named ranges map to vega's config.defaults range entries (a continuous
        // scheme unless overridden). `range: "heatmap"` (vega-lite's default for
        // quantitative color) resolves to the yellowgreenblue scheme.
        // Vega config default ranges for non-scheme ranges
        const directRanges: Record<string, unknown[]> = {
          symbol: ['circle', 'square', 'triangle-up', 'cross', 'diamond', 'triangle-right', 'triangle-down', 'triangle-left'],
        }
        const direct = ownGet(directRanges, range)
        if (direct) return direct
        // vega's config.js defaults: diverging carries extent [1, 0] (the
        // default reads the scheme backwards — and a user entry REPLACES the
        // default wholesale, so {scheme} alone reads forwards)
        const aliases: Record<string, { scheme: string; extent?: number[] }> = {
          ramp: { scheme: 'blues' },
          heatmap: { scheme: 'yellowgreenblue' },
          ordinal: { scheme: 'blues' },
          diverging: { scheme: 'blueorange', extent: [1, 0] },
        }
        const entry = ownGet(aliases, range)
        const name = entry ? entry.scheme : range
        const scheme = vs.scheme(name)
        if (typeof scheme === 'function') {
          if (scaleType === 'band' || scaleType === 'ordinal' || scaleType === 'point') {
            return quantizeInterpolator(scheme as (t: number) => unknown, Math.max(domainCount, 1)) as unknown[]
          }
          if (scaleType === 'quantile' || scaleType === 'quantize' || scaleType === 'threshold') {
            const n = scaleType === 'threshold' ? Math.max(domainCount + 1, 2) : 5
            return quantizeInterpolator(scheme as (t: number) => unknown, n) as unknown[]
          }
          return entry?.extent ? { __asterScheme: name, __asterExtent: entry.extent } : name
        }
        if (scheme) return scheme as unknown[]
        throw new Error(`[aster] unsupported scale range "${name}"`)
      }
    }
  }
  if (range && typeof range === 'object' && 'signal' in range) {
    const v = resolveRangeSignal(range.signal, ctx)
    if (v == null) throw new Error(`[aster] unresolved signal range: ${range.signal}`)
    return Array.isArray(v) ? (v as unknown[]) : [v]
  }
  // Vega-lite emits `{ scheme: "blues" }` (or `{ scheme: "blues", extent: [...] }`)
  // for sequential/diverging color scales.  Resolve to the scheme name string so
  // buildScale's continuous-scheme branch picks it up.
  if (range && typeof range === 'object' && 'scheme' in range) {
    const schemeName = (range as { scheme: string }).scheme
    const extent = (range as { extent?: number[] }).extent
    if (typeof schemeName === 'string') {
      if (scaleType === 'quantile' || scaleType === 'quantize' || scaleType === 'threshold') {
        const scheme = vs.scheme(schemeName)
        if (typeof scheme === 'function') return quantizeInterpolator(scheme as (t: number) => unknown, 5) as unknown[]
      }
      return extent ? { __asterScheme: schemeName, __asterExtent: extent } : schemeName
    }
  }
  throw new Error(`[aster] unsupported scale range value`)
}

/** Tick helpers reused from vega-scale (used by the axis runtime). */
export function scaleTicks(s: Scale, count?: number, _size?: number, _step?: number): unknown[] {
  // For time/utc scales: use the scale range width so vega-scale computes
  // an appropriate tick count that matches vega's output.
  if ((s.type === 'time' || s.type === 'utc') && count == null) {
    const range = s.range() as number[]
    if (range.length >= 2) {
      const lo = range[0]!
      const hi = range[range.length - 1] ?? 0
      const sw = Math.abs(hi - lo)
      return (vs as any).tickValues(s, undefined, sw * 1.01) as unknown[]
    }
  }
  // For linear scales with bins: use tickValues which respects scale.bins
  // If bins is set, vega-scale's tickValues uses validTicks() which generates
  // ticks from the bin boundary values instead of d3's default tick algorithm.
  if (count != null) {
    return (vs as any).tickValues(s, count) as unknown[]
  }
  // Fallback: use d3-scale's ticks with the scale range
  const range = s.range() as number[]
  if (range.length >= 2) {
    const span = Math.abs((range[range.length - 1] ?? 0) - (range[0] ?? 0))
    return (vs as any).tickValues(s, undefined, span) as unknown[]
  }
  return []
}
