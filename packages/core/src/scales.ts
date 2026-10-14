/**
 * Scale construction. The scale layer is owned (ported from d3-scale and
 * vega-scale behind oracle vectors) so scale types, schemes, and tick logic
 * match vega exactly.
 */
import * as vs from './scale.js'
import { interpolateRound } from './interp.js'
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
  signals: Record<string, unknown>
  /** Evaluate a JS expression string and return the result. */
  evaluate?: (expr: string) => unknown
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
  /** Return all rows of a named dataset (for aggregate sort). */
  dataRows?: (dataName: string) => Record<string, unknown>[]
}

export const CONTINUOUS_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize'])
const INCLUDE_ZERO_TYPES = new Set(['linear', 'pow', 'sqrt'])
const TIME_SCALE_TYPES = new Set(['time', 'utc'])

export function buildScale(c: CompiledScale, ctx: ScaleContext): Scale {
  const type = c.type
  const factory = vs.scale(type)
  if (!factory) throw new Error(`[aster] unsupported scale type "${type}"`)

  let s = factory()
  const domain = resolveDomain(type, c.domain, ctx)
  s.domain(domain)

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
  let range0: unknown[] | string
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
    range0 = resolveRange(effectiveRange, ctx, type)
  }
  // Handle continuous schemes: scheme strings like 'blues' for color interpolation
  if (typeof range0 === 'string' && CONTINUOUS_TYPES.has(type)) {
    const schemeFn = vs.scheme(range0)
    if (typeof schemeFn === 'function') {
      s.range([0, 1])
      const cs = s as ColorScale
      // When reverse is requested, wrap the interpolator so it maps t → original(1-t),
      // reversing the color mapping without replacing the range.
      const effectiveSchemeFn: SchemeFn = c.reverse
        ? ((t: number) => (schemeFn as (t: number) => unknown)(1 - t) as unknown) as SchemeFn
        : schemeFn as SchemeFn
      // d3 sequential/diverging scales use .interpolator() (not .interpolate)
      if (typeof cs.interpolator === 'function') {
        cs.interpolator(effectiveSchemeFn)
      } else if (typeof (cs as any).interpolate === 'function') {
        (cs as any).interpolate(() => effectiveSchemeFn)
      }
      cs.interpolator = () => effectiveSchemeFn
    } else {
      s.range(range0 as never)
    }
  } else {
    s.range(range0 as never)
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

  if (CONTINUOUS_TYPES.has(type) && typeof range0 !== 'string') {
    if (c.reverse) s.range(s.range().slice().reverse() as unknown[])
  } else if (c.domainMin != null || c.domainMax != null) {
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
  const isColorScheme = CONTINUOUS_TYPES.has(type) && typeof range0 === 'string'
  const zero = !TIME_SCALE_TYPES.has(type) && !isColorScheme && (c.zero ?? INCLUDE_ZERO_TYPES.has(type))
  if (zero) applyZero(s)
  if (c.domainMin != null || c.domainMax != null) applyDomainMinMax(s, c.domainMin, c.domainMax)
  // Vega's Scale transform splices domainMid into the domain array so that the
  // midpoint value is explicitly represented as a domain breakpoint.  The
  // resulting piecewise-linear scale maps domainMid to a range value that
  // maintains the same slope established by the surrounding domain/range pairs.
  // The splice happens after zero/domainMin/domainMax (which establish the
  // baseline domain) and before nice (which rounds the domain boundaries).
  if (c.domainMid != null && CONTINUOUS_TYPES.has(type)) {
    applyDomainMid(s, c.domainMid)
  }
  // Vega's Scale transform adjusts continuous domains for minimum pixel
  // padding (`padDomain`): the domain is zoomed out around its midpoint so the
  // extreme data values land `padding` px inside the range. Applies to all
  // continuous scales (linear/log/pow/sqrt/symlog/time/utc), matching vega's
  // `includePad(type)` guard.
  if (CONTINUOUS_TYPES.has(type) && c.padding != null) applyPixelPadding(s, c, c.padding)
  if (c.nice) applyNice(s, c.nice)
  if (c.exponent != null) s.exponent?.(c.exponent)
  if (c.constant != null) s.constant?.(c.constant)
  if (c.base != null) s.base?.(c.base)

  // Set scale.bins if specified in the scale config.
  // When scale.bins is set, the tickValues/tickCount helpers
  // use validTicks(scale, scale.bins, count) instead of scale.ticks(count),
  // which generates ticks from the actual bin boundaries.
  if (c.bins) {
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
  const coercible = all.filter(
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
      if (merged) return merged
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
      if (CONTINUOUS_TYPES.has(type)) {
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
        const coercible = all.filter(
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
      const vals = (domainDataRows && fields == null && field != null
        ? distinctValuesCached(domainDataRows, field, (rws, fld) =>
            (ctx.dataField ?? ((_d: string, _f: string) => []))(data, fld))
        : distinctValues(all)).slice()
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

// Per-dataset-identity cache for ordinal domain collection. The same (rows,
// field) pair is collected multiple times per evaluate (scale domain, axis
// build, legend); the rows array identity changes whenever transforms rerun,
// so a WeakMap is naturally invalidated between evaluates.
const distinctCache = new WeakMap<unknown[], Map<string, unknown[]>>()

function distinctValuesCached(rows: unknown[], field: string, collect: (rows: unknown[], field: string) => unknown[]): unknown[] {
  let byField = distinctCache.get(rows)
  if (!byField) {
    byField = new Map()
    distinctCache.set(rows, byField)
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
    if (seen.has(v)) continue
    seen.add(v)
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

function resolveRange(range: ScaleRange, ctx: ScaleContext, scaleType?: string): unknown[] | string {
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
        // Named ranges map to vega's config.defaults range entries (a continuous
        // scheme unless overridden). `range: "heatmap"` (vega-lite's default for
        // quantitative color) resolves to the yellowgreenblue scheme.
        // Vega config default ranges for non-scheme ranges
        const directRanges: Record<string, unknown[]> = {
          symbol: ['circle', 'square', 'triangle-up', 'cross', 'diamond', 'triangle-right', 'triangle-down', 'triangle-left'],
        }
        if (directRanges[range]) return directRanges[range]
        const aliases: Record<string, string> = {
          ramp: 'blues',
          heatmap: 'yellowgreenblue',
          ordinal: 'blues',
          diverging: 'blueorange',
        }
        const name = aliases[range] ?? range
        const scheme = vs.scheme(name)
        if (typeof scheme === 'function') return name
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
    if (typeof schemeName === 'string') return schemeName
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
