/**
 * Scale construction. Reuses `vega-scale` (pure: d3 + vega-util/vega-time only)
 * so scale types, schemes, and tick logic match vega exactly.
 */
import * as vs from 'vega-scale'
import type { CompiledScale, ScaleDomain, ScaleRange } from './types.js'

export type Scale = vs.Scale

export interface ScaleContext {
  width: number
  height: number
  signals: Record<string, unknown>
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
}

const CONTINUOUS_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential'])
const INCLUDE_ZERO_TYPES = new Set(['linear', 'pow', 'sqrt'])
const TIME_SCALE_TYPES = new Set(['time', 'utc'])

export function buildScale(c: CompiledScale, ctx: ScaleContext): Scale {
  const type = c.type
  const factory = vs.scale(type)
  if (!factory) throw new Error(`[aster] unsupported scale type "${type}"`)

  let s = factory()
  const domain = resolveDomain(type, c.domain, ctx)
  s.domain(domain)

  const range = resolveRange(c.range, ctx)
  if (Array.isArray(range)) s.range(range as unknown[])
  else s.range(range as never)

  if (c.reverse) s.range(s.range().slice().reverse() as unknown[])
  if (c.round) s.round?.(true)
  if (c.clamp) s.clamp?.(true)
  if (c.padding != null) s.padding?.(c.padding)
  if (c.paddingInner != null) s.paddingInner?.(c.paddingInner)
  if (c.paddingOuter != null) s.paddingOuter?.(c.paddingOuter)

  const zero = !TIME_SCALE_TYPES.has(type) && (c.zero ?? INCLUDE_ZERO_TYPES.has(type))
  if (zero) applyZero(s)
  if (c.domainMin != null || c.domainMax != null) applyDomainMinMax(s, c.domainMin, c.domainMax)
  if (c.nice) applyNice(s, c.nice)
  if (c.exponent != null) s.exponent?.(c.exponent)
  if (c.constant != null) s.constant?.(c.constant)
  if (c.base != null) s.base?.(c.base)

  return s
}

function applyNice(s: Scale, nice: boolean | number) {
  if (!s.nice) return
  if (typeof nice === 'number') s.nice(vs.tickCount(s, nice))
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

function resolveDomain(type: string, domain: ScaleDomain, ctx: ScaleContext): unknown[] {
  if (Array.isArray(domain)) return domain.slice()
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    if ('signal' in domain && domain.signal) {
      const v = ctx.signals[domain.signal]
      if (v == null) throw new Error(`[aster] unresolved signal in scale domain: ${domain.signal}`)
      return Array.isArray(v) ? (v as unknown[]) : [v]
    }
    if ('data' in domain) {
      const { data, field, fields } = domain as { data: string; field?: string; fields?: string[] }
      const fieldsToCollect = fields ?? (field ? [field] : [])
      const all: unknown[] = []
      for (const f of fieldsToCollect) {
        for (const v of ctx.dataField(data, f)) all.push(v)
      }
      if (CONTINUOUS_TYPES.has(type)) {
        if (type === 'time' || type === 'utc') {
          // For time scales, do NOT convert date-string domains to numeric timestamps.
          // This matches Vega's parser/extent behavior where extent on date strings
          // returns strings which D3's scaleTime converts to Invalid Date — producing
          // the same scale domain and no ticks/grid as Vega's output.
          const dates = all.filter(
            (v) => v instanceof Date && Number.isFinite(v.getTime()),
          ) as Date[]
          if (dates.length) {
            const ms = dates.map((d) => d.getTime())
            return [Math.min(...ms), Math.max(...ms)]
          }
          // Return raw values (numbers or strings) for extent
          // D3 scaleTime will parse/convert internally, matching Vega's runtime.
          const nums = all.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
          if (nums.length) return [Math.min(...nums), Math.max(...nums)]
          // Fall through to raw values (strings or mixed)
        }
        const finite = all.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
        if (!finite.length) return []
        return [Math.min(...finite), Math.max(...finite)]
      }
      let vals = distinctValues(all)
      if ((domain as { sort?: unknown }).sort === true) {
        // Sort domain alphabetically (Vega default for nominal scales)
        vals.sort((a, b) => (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0)
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

function distinctValues(values: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const v of values) {
    if (!out.some((x) => x === v)) out.push(v)
  }
  return out
}

function resolveRange(range: ScaleRange, ctx: ScaleContext): unknown[] {
  if (Array.isArray(range)) {
    return range.map((r) => {
      if (r && typeof r === 'object' && 'signal' in r) {
        const v = ctx.signals[(r as { signal: string }).signal]
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
        return [0, ctx.height]
      default: {
        const scheme = vs.scheme(range)
        if (scheme) return (typeof scheme === 'function' ? scheme() : scheme) as unknown[]
        throw new Error(`[aster] unsupported scale range "${range}"`)
      }
    }
  }
  if (range && typeof range === 'object' && 'signal' in range) {
    const v = ctx.signals[range.signal]
    if (v == null) throw new Error(`[aster] unresolved signal range: ${range.signal}`)
    return Array.isArray(v) ? (v as unknown[]) : [v]
  }
  throw new Error(`[aster] unsupported scale range value`)
}

/** Tick helpers reused from vega-scale (used by the axis runtime). */
export function scaleTicks(s: Scale, count?: number, size?: number, _step?: number): unknown[] {
  // For time/utc scales: use the scale range width so vega-scale computes
  // an appropriate tick count that matches vega's output.
  if ((s.type === 'time' || s.type === 'utc') && count == null) {
    const range = s.range() as number[]
    if (range.length >= 2) {
      const lo = range[0]!
      const hi = range[range.length - 1]!
      const sw = Math.abs(hi - lo)
      return (vs as any).tickValues(s, undefined, sw * 1.01) as unknown[]
    }
  }
  // Default: use vega-scale's default tick behavior.
  // Pass size to let vega-scale compute the optimal tick count.
  return (vs as any).tickValues(s, count, size) as unknown[]
}
