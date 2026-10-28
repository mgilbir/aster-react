// vega-lite config.scale: the defaults, and the pieces of scale assembly that read them
// (compile/scale/range.ts, domain.ts). Shared by the scale, data and mark code.
import type { FieldDef } from './compile.js'

export type ScaleCfg = Record<string, any>

/** vega-lite `defaultScaleConfig` (the keys that reach the output). */
export const DEFAULT_SCALE_CONFIG: ScaleCfg = {
  pointPadding: 0.5,
  barBandPaddingInner: 0.1,
  rectBandPaddingInner: 0,
  tickBandPaddingInner: 0.25,
  bandWithNestedOffsetPaddingInner: 0.2,
  bandWithNestedOffsetPaddingOuter: 0.2,
  minBandSize: 2,
  minFontSize: 8,
  maxFontSize: 40,
  minOpacity: 0.3,
  maxOpacity: 0.8,
  minSize: 4,
  minStrokeWidth: 1,
  maxStrokeWidth: 4,
  quantileCount: 4,
  quantizeCount: 4,
  zero: true,
}

export function scaleConfigOf(spec: { config?: unknown }): ScaleCfg {
  const c = spec.config as { scale?: ScaleCfg } | undefined
  return { ...DEFAULT_SCALE_CONFIG, ...(c?.scale && typeof c.scale === 'object' ? c.scale : {}) }
}

const viewConfigOf = (spec: { config?: unknown }): Record<string, unknown> => {
  const c = spec.config as { view?: unknown } | undefined
  return c?.view !== null && typeof c?.view === 'object' ? (c.view as Record<string, unknown>) : {}
}

/** vega-lite `getViewConfigContinuousSize`: `config.view.width` / `continuousWidth` (default 300). */
export function viewContinuousSize(spec: { config?: unknown }, ch: 'width' | 'height'): number {
  const v = viewConfigOf(spec)
  const size = v[ch] ?? v[ch === 'width' ? 'continuousWidth' : 'continuousHeight']
  return typeof size === 'number' ? size : 300
}

/** vega-lite `getViewConfigDiscreteSize`: `config.view.width` / `discreteWidth`, else `{step: config.view.step}` (default 20). */
export function viewDiscreteSize(spec: { config?: unknown }, ch: 'width' | 'height'): number | { step: number } {
  const v = viewConfigOf(spec)
  const size = v[ch] ?? v[ch === 'width' ? 'discreteWidth' : 'discreteHeight']
  if (typeof size === 'number') return size
  if (size !== null && typeof size === 'object' && typeof (size as { step?: unknown }).step === 'number') return { step: (size as { step: number }).step }
  return { step: typeof v.step === 'number' ? v.step : 20 }
}

/** The discrete step vega-lite sizes marks against: the spec's `{step}`, else the view config's (default 20). */
export function discreteStep(spec: { width?: unknown; height?: unknown; config?: unknown }, ch: 'width' | 'height'): number {
  const v = spec[ch] as { step?: number } | undefined
  if (typeof v === 'object' && v !== null && typeof v.step === 'number') return v.step
  const d = viewDiscreteSize(spec, ch)
  return typeof d === 'object' ? d.step : 20
}

/** `[min, max]` of a size scale (range.ts sizeRangeMin/sizeRangeMax). */
export function sizeRange(mark: string, cfg: ScaleCfg, step: number, stepExpr?: string): [number, number | { signal: string }] {
  switch (mark) {
    case 'bar': case 'tick': return [cfg.minBandSize, cfg.maxBandSize ?? (stepExpr ? { signal: `${stepExpr} - 1` } : step - 1)]
    case 'line': case 'trail': case 'rule': return [cfg.minStrokeWidth, cfg.maxStrokeWidth]
    case 'text': return [cfg.minFontSize, cfg.maxFontSize]
    default: return [cfg.minSize, cfg.maxSize || (stepExpr ? { signal: `pow(0.95 * ${stepExpr}, 2)` } : (0.95 * step) ** 2)]
  }
}

/** range.ts `interpolateRange`: `count` values spread over [min, max] for a continuous-to-discrete scale. */
export function countRange(min: number, max: number | { signal: string }, count: number): { signal: string } {
  const rMax = typeof max === 'object' ? max.signal : max
  const step = `(${rMax} - ${min}) / (${count} - 1)`
  return { signal: `sequence(${min}, ${rMax} + ${step}, ${step})` }
}

/** The number of range values a quantile / quantize / threshold scale takes (range.ts defaultContinuousToDiscreteCount). */
export function discreteCount(type: string, cfg: ScaleCfg, domain: unknown): number {
  if (type === 'quantile') return cfg.quantileCount
  if (type === 'quantize') return cfg.quantizeCount
  return Array.isArray(domain) ? domain.length + 1 : 3
}

const SHARED_DOMAIN_OPS = new Set(['mean', 'average', 'median', 'q1', 'q3', 'min', 'max'])

/** domain.ts canUseUnaggregatedDomain + normalizeUnaggregatedDomain: does this aggregated field use the unaggregated domain? */
export function usesUnaggregatedDomain(def: FieldDef, cfg: ScaleCfg): boolean {
  const d = def.scale?.domain
  const wanted = d === 'unaggregated' || (d === undefined && cfg.useUnaggregatedDomain === true)
  return wanted
    && typeof def.aggregate === 'string' && SHARED_DOMAIN_OPS.has(def.aggregate)
    && !(def.type === 'quantitative' && def.scale?.type === 'log')
}
