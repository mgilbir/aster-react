import type { VgSpec } from '@aster/core'
import { compileVegaLite } from './vl-registry.js'

/** True when the value looks like a Vega-Lite grammar rather than a Vega spec. */
export function isVegaLiteSpec(spec: VgSpec): boolean {
  const schema = typeof spec.$schema === 'string' ? spec.$schema : ''
  if (schema.includes('vega-lite')) return true
  if (Array.isArray(spec.marks) || Array.isArray(spec.scales)) return false
  return spec.mark != null || spec.encoding != null || spec.layer != null || spec.facet != null
    || spec.repeat != null || spec.concat != null || spec.hconcat != null || spec.vconcat != null
}

/**
 * Normalize either grammar to the Vega spec the engine consumes.
 *
 * Vega-Lite needs the opt-in compiler addon (`import '@aster/react/vl'`); when
 * it is missing this throws an actionable error instead of returning a spec the
 * runtime cannot render.
 */
export function normalizeChartSpec(spec: VgSpec): VgSpec {
  return isVegaLiteSpec(spec) ? compileVegaLite(spec) : spec
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return value != null && typeof (value as { then?: unknown }).then === 'function'
}
