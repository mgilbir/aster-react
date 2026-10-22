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

const CONTENT_KEYS = new WeakMap<object, string | null>()

/**
 * Canonical content key of a JSON-shaped value (specs, limits), or `null` when
 * the value cannot be compared by content (functions, cycles, Map/Set, class
 * instances, non-finite numbers): such values fall back to identity. Memoised
 * per object, so a stable spec object is serialized once.
 */
export function contentKey(value: unknown): string | null {
  if (value == null || typeof value !== 'object') return null
  const cached = CONTENT_KEYS.get(value)
  if (cached !== undefined) return cached
  let key: string | null
  try {
    key = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new TypeError('not comparable by content')
      if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('not comparable by content')
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        const proto = Object.getPrototypeOf(v) as unknown
        if (proto !== Object.prototype && proto !== null) throw new TypeError('not comparable by content')
      }
      return v
    }) ?? null
  } catch {
    key = null
  }
  CONTENT_KEYS.set(value, key)
  return key
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
  const ref = React.useRef<{ value: T; key: string | null } | null>(null)
  const key = value === undefined ? null : contentKey(value)
  const prev = ref.current
  if (prev == null) {
    ref.current = { value, key }
  } else if (prev.value !== value) {
    const same = key != null && prev.key != null && prev.key === key
    if (!same) ref.current = { value, key }
  }
  return ref.current!.value
}

/** `useStableContent` for specs. */
export const useStableSpec = (spec: VgSpec): VgSpec => useStableContent(spec)
