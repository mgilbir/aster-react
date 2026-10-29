import * as React from 'react'
import { checkSvgLength, renderSceneToSvg, type RuntimeInput, type SceneRoot, type VgSpec } from '@aster/core'
import { createChartSession } from '@aster/core/dom'
import type { LoadOptions } from '@aster/core/load'
import { normalizeChartSpec, useStableContent, useStableSpec } from './spec.js'
import { useAddons } from './addons.js'

export interface UseChartOptions extends RuntimeInput {
  /** Skip SVG serialization when the host renders the scene itself. */
  serialize?: boolean
}

export interface UseChartResult {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  /** The underlying incremental session, stable across renders. */
  session: ReturnType<typeof createChartSession>
}

/**
 * Headless React hook: compile/evaluate a Vega *or Vega-Lite* spec through the
 * same incremental session <Chart> uses, returning the scene (and SVG unless
 * `serialize: false`). Identical inputs return the cached scene.
 */
export function useChart(spec: VgSpec, options: UseChartOptions = {}): UseChartResult {
  const { serialize = true, ...input } = options
  // Content-stable spec and limits: an inline literal rebuilt every render must
  // not look like a change (nor re-run the Vega-Lite compiler).
  const stableSpec = useStableSpec(spec)
  const limits = useStableContent(input.limits)
  const normalized = React.useMemo(() => normalizeChartSpec(stableSpec), [stableSpec])
  // The opt-in add-ons the spec needs load before the first evaluation: the hook suspends meanwhile (a <Suspense> boundary
  // above shows its fallback), and an import that fails is the result's `error`.
  const addonError = useAddons(normalized)
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const session = sessionRef.current
  // Every `RuntimeInput` field is a dependency. The record below must name each
  // key of `RuntimeInput` (the type makes a missing one a compile error), so a new
  // engine input cannot silently leave a stale result the way textMetrics,
  // dataPulse, changedDatasets and autoChanges once did.
  const deps: Required<{ [K in keyof RuntimeInput]: unknown }> = {
    limits, textMetrics: input.textMetrics, urlPolicy: input.urlPolicy, data: input.data, width: input.width, height: input.height, signals: input.signals,
    changedDatasets: input.changedDatasets, dataChanges: input.dataChanges, dataPulse: input.dataPulse,
    autoChanges: input.autoChanges, domainRaw: input.domainRaw, logger: input.logger, random: input.random, containerSize: input.containerSize, measuredSize: input.measuredSize,
  }
  return React.useMemo(() => {
    if (addonError) return { scene: null, svg: null, error: addonError, session }
    try {
      const scene = session.evaluate(normalized, { ...input, limits })
      const svg = serialize ? renderSceneToSvg(scene) : null
      // Same budget as `renderSpec`: the serialized output length.
      if (svg != null && limits) checkSvgLength(svg, limits)
      return { scene, svg, error: null, session }
    } catch (e) {
      return { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), session }
    }
  }, [normalized, addonError, ...Object.values(deps), serialize, session])
}

// ---------------------------------------------------------------------------
// Async data: Suspense / use() (R11.2)
// ---------------------------------------------------------------------------

/**
 * Everything `loadSpecData` takes (`@aster/core/load` `LoadOptions`): `fetch`,
 * `baseURL` (needed for relative urls), `protocols`, `allow`, `allowPrivateNetwork`,
 * `signal`, `timeoutMs`, `maxBytes`, `maxConcurrent`, `maxRedirects` and `limits`.
 * The defaults are the safe ones (public http/https hosts only), so a spec you did
 * not write cannot reach a private network; widen them deliberately.
 */
export type UseSpecDataOptions = LoadOptions

const OBJECT_IDS = new WeakMap<object, number>()
let OBJECT_SEQ = 0
const RESOURCES = new WeakMap<object, { key: string; promise: Promise<VgSpec> }>()

function objectId(o: object): number {
  let id = OBJECT_IDS.get(o)
  if (id === undefined) {
    id = ++OBJECT_SEQ
    OBJECT_IDS.set(o, id)
  }
  return id
}

/**
 * Cache key of a set of load options: data by content, functions and other
 * objects (`fetch`, `allow`, `signal`) by identity. Same options, same promise.
 */
function optionsKey(options: UseSpecDataOptions): string {
  const parts: string[] = []
  for (const name of Object.keys(options).sort()) {
    const v = (options as Record<string, unknown>)[name]
    if (v === undefined) continue
    if (typeof v === 'function' || (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal)) parts.push(`${name}=#${objectId(v as object)}`)
    else parts.push(`${name}=${JSON.stringify(v)}`)
  }
  return parts.join('&')
}

/**
 * Stable promise for `loadSpecData(spec)` (R11.2), keyed by the spec object and
 * fetch implementation. The loader addon is imported lazily, so a host that
 * never uses URL datasets never bundles the csv/topojson readers.
 */
export function loadSpecDataResource(
  spec: VgSpec,
  options: UseSpecDataOptions = {},
): Promise<VgSpec> {
  const key = optionsKey(options)
  const cached = RESOURCES.get(spec)
  if (cached && cached.key === key) return cached.promise
  const promise = import('@aster/core/load').then((mod) =>
    mod.loadSpecData(spec, options),
  )
  RESOURCES.set(spec, { key, promise })
  // A failed load must not be cached forever: drop the entry so the next render
  // (e.g. after the error boundary resets) retries instead of re-throwing the
  // same rejection. The rejected promise is still what this render sees.
  promise.catch(() => {
    if (RESOURCES.get(spec)?.promise === promise) RESOURCES.delete(spec)
  })
  return promise
}

/**
 * Suspense-friendly URL-data loader:
 *
 * ```tsx
 * function ChartFromUrl({ spec }) {
 *   const loaded = useSpecData(spec)
 *   return <Chart spec={loaded} />
 * }
 * // wrap in <Suspense fallback=…>
 * ```
 */
export function useSpecData(spec: VgSpec, options: UseSpecDataOptions = {}): VgSpec {
  return React.use(loadSpecDataResource(spec, options))
}

/**
 * Explicit async loader (the non-Suspense path). Same addon as
 * `@aster/core/load`, imported lazily so URL datasets do not tax the base
 * bundle.
 */
export async function loadSpecData(spec: VgSpec, options: UseSpecDataOptions = {}): Promise<VgSpec> {
  const mod = await import('@aster/core/load')
  return mod.loadSpecData(spec, options)
}

/** Options only the loader understands; everything else (and `limits`, which both use) goes to the chart. */
const LOAD_ONLY_OPTIONS = ['fetch', 'baseURL', 'protocols', 'allow', 'allowPrivateNetwork', 'signal', 'timeoutMs', 'maxBytes', 'maxConcurrent', 'maxRedirects'] as const

/**
 * A chart loaded with `useSpecData`, rendered headlessly. Takes the loader options
 * (`baseURL`, `allow`, ...) and the chart options together; `limits` applies to both.
 */
export function useChartData(
  spec: VgSpec,
  options: UseChartOptions & UseSpecDataOptions = {},
): UseChartResult {
  const loadOptions: UseSpecDataOptions = {}
  const chartOptions: UseChartOptions = { ...options }
  for (const name of LOAD_ONLY_OPTIONS) {
    if (name in options) {
      ;(loadOptions as Record<string, unknown>)[name] = options[name]
      delete (chartOptions as Record<string, unknown>)[name]
    }
  }
  if (options.limits) loadOptions.limits = options.limits
  const loaded = useSpecData(spec, loadOptions)
  return useChart(loaded, chartOptions)
}
