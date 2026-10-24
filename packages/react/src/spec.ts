import * as React from 'react'
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

const MAX_COMPARE_DEPTH = 64

/**
 * Structural equality of JSON-shaped values (specs, limits). With `rowsById` the inline `values` of a data set
 * (an object inside a `data` list) are compared by identity: primitives by
 * `Object.is`, arrays and plain objects member by member, and anything else
 * (functions, Map/Set, class instances, typed arrays) by identity. A structure
 * deeper than 64 levels (or cyclic) compares unequal. Allocation-free and stops at
 * the first difference, so re-checking an equal 100k-row inline spec costs one pass
 * and a changed one usually a few steps.
 */
export function contentEqual(a: unknown, b: unknown, depth = 0, dataset = false, rowsById = false): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > MAX_COMPARE_DEPTH) return false
  const arrA = Array.isArray(a)
  if (arrA !== Array.isArray(b)) return false
  if (arrA) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!contentEqual(x[i], y[i], depth + 1, dataset, rowsById)) return false
    return true
  }
  const protoA = Object.getPrototypeOf(a) as unknown
  if ((protoA !== Object.prototype && protoA !== null) || Object.getPrototypeOf(b) !== protoA) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  let count = 0
  for (const k in x) {
    if (!Object.prototype.hasOwnProperty.call(x, k)) continue
    count++
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false
    // a data set's inline rows are compared by identity: a re-created equal array is a new input for the session,
    // whose row diff (diffRows) already finds "nothing changed" without this pass comparing every row a second time
    if (rowsById && dataset && k === 'values' && Array.isArray(x[k])) {
      if (!Object.is(x[k], y[k])) return false
      continue
    }
    if (!contentEqual(x[k], y[k], depth + 1, k === 'data', rowsById)) return false
  }
  let other = 0
  for (const k in y) if (Object.prototype.hasOwnProperty.call(y, k)) other++
  return count === other
}

/**
 * Return the previously seen object while the value keeps the same CONTENT.
 * A parent that rebuilds an inline `spec`/`limits` literal on every render then
 * does not look like a change: lifecycles keyed on this value (streams,
 * workers, scene sessions, memo deps) survive, instead of restarting on object
 * identity and discarding streamed state. Values that cannot be compared by
 * content keep identity semantics.
 */
export function useStableContent<T extends object | undefined>(value: T): T {
  const ref = React.useRef<T>(value)
  if (ref.current !== value && !contentEqual(ref.current, value)) ref.current = value
  return ref.current
}

/**
 * `useStableContent` for the spec of a chart that evaluates through a scene session: the skeleton is compared by
 * content, the inline rows of a data set by identity. A re-created equal rows array is a new input; the session's row diff
 * (diffRows) finds it unchanged, so the rows are not compared a second time here (that pass cost 1.3 ms at 10k rows).
 * Streams keep `useStableSpec`: a spec rebuilt every render must not restart them.
 */
export function useStableSpecRows(spec: VgSpec): VgSpec {
  const ref = React.useRef<VgSpec>(spec)
  if (ref.current !== spec && !contentEqual(ref.current, spec, 0, false, true)) ref.current = spec
  return ref.current
}

/** `useStableContent` for specs. */
export const useStableSpec = (spec: VgSpec): VgSpec => useStableContent(spec)
