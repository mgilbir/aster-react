import * as React from 'react'
import type { VgSpec } from '@aster-charts/core'
import { chartSkeleton } from '@aster-charts/core/lean'
import { compileVegaLite } from './vl-registry.js'

/** A plain object (not an array, a string, a class instance): the only value that can be a spec. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** An own property of a spec (an inherited `concat` of a string or an array is not one). */
const own = (spec: Record<string, unknown>, key: string): unknown => (Object.hasOwn(spec, key) ? spec[key] : undefined)

/**
 * True when the value is a Vega-Lite spec rather than a Vega spec: a plain object whose `$schema` names vega-lite, or that has
 * no Vega `marks` / `scales` list and has one of Vega-Lite's top-level properties of its own. Anything that is not a plain object
 * (a string, an array, `null`) is neither grammar.
 */
export function isVegaLiteSpec(spec: unknown): boolean {
  if (!isPlainObject(spec)) return false
  const schema = own(spec, '$schema')
  if (typeof schema === 'string' && schema.includes('vega-lite')) return true
  if (Array.isArray(own(spec, 'marks')) || Array.isArray(own(spec, 'scales'))) return false
  return ['mark', 'encoding', 'layer', 'facet', 'repeat', 'concat', 'hconcat', 'vconcat'].some((k) => own(spec, k) != null)
}

/** What a value that is not a spec object is, for the error that refuses it. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return 'a string (parse JSON text with JSON.parse first)'
  if (typeof value === 'object') return `an instance of ${(value as object).constructor?.name ?? 'a class'}`
  return typeof value
}

/**
 * Normalize either grammar to the Vega spec the engine consumes.
 *
 * Throws a `TypeError` for a value that is not a spec object (`null`, `undefined`, a JSON string, an array), the actionable error
 * of a Vega-Lite spec when the opt-in compiler (`import '@aster-charts/react/vl'`) is missing, and the compiler's own errors.
 * The components and hooks call it inside their guarded evaluation (see `normalizeSpecResult`), so each of these reaches their
 * error state and `onError` / `error` like any other failure.
 */
export function normalizeChartSpec(spec: VgSpec): VgSpec {
  if (!isPlainObject(spec)) throw new TypeError(`[aster] spec must be a Vega or Vega-Lite spec object; got ${describe(spec)}`)
  return isVegaLiteSpec(spec) ? compileVegaLite(spec) : spec
}

/** The outcome of normalizing a spec: the Vega spec, or the error that stopped it (never thrown). */
export type NormalizedSpec = { spec: VgSpec; error: null } | { spec: null; error: Error }

/**
 * `normalizeChartSpec` without the throw: the one place a chart's spec becomes the Vega spec it evaluates, for every component
 * and hook. A failure (not a spec, no Vega-Lite compiler, a `VLCompileError`) is returned, so the caller hands it to the same
 * error channel as an evaluation error, once.
 */
export function normalizeSpecResult(spec: unknown): NormalizedSpec {
  try {
    return { spec: normalizeChartSpec(spec as VgSpec), error: null }
  } catch (e) {
    return { spec: null, error: e instanceof Error ? e : new Error(String(e)) }
  }
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
export function useStableContent<T>(value: T): T {
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

/**
 * Which chart a spec is: a number that changes when the spec changes to ANOTHER chart and not when only the rows
 * of its inline datasets do (the `chartSkeleton` the scene session compiles by). A chart keeps state that belongs to the
 * spec it was made under -- timers, the pointer interaction in flight, signal values, a selection, a zoom, hidden legend
 * entries, the DOM the patcher owns -- so a changed chart starts as a fresh mount would, while a data-only change keeps
 * everything and stays on the incremental path.
 */
export function useChartEpoch(spec: VgSpec): number {
  const skeleton = React.useMemo(() => chartSkeleton(spec), [spec])
  const [state, setState] = React.useState({ skeleton, epoch: 0 })
  if (state.skeleton === skeleton) return state.epoch
  // derived state, set while rendering: React re-renders this component at once, before anything is committed
  const next = { skeleton, epoch: state.epoch + 1 }
  setState(next)
  return next.epoch
}
