import * as React from 'react'
import { checkSvgLength, renderSceneToSvg, type RuntimeInput, type SceneRoot, type VgSpec } from '@aster/core'
import { createChartSession } from '@aster/core/dom'
import { normalizeChartSpec, useStableContent, useStableSpec } from './spec.js'

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
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const session = sessionRef.current
  // Every `RuntimeInput` field is a dependency. The record below must name each
  // key of `RuntimeInput` (the type makes a missing one a compile error), so a new
  // engine input cannot silently leave a stale result the way textMetrics,
  // dataPulse, changedDatasets and autoChanges once did.
  const deps: Required<{ [K in keyof RuntimeInput]: unknown }> = {
    limits, textMetrics: input.textMetrics, data: input.data, width: input.width, height: input.height, signals: input.signals,
    changedDatasets: input.changedDatasets, dataChanges: input.dataChanges, dataPulse: input.dataPulse,
    autoChanges: input.autoChanges, domainRaw: input.domainRaw,
  }
  return React.useMemo(() => {
    try {
      const scene = session.evaluate(normalized, { ...input, limits })
      const svg = serialize ? renderSceneToSvg(scene) : null
      // Same budget as `renderSpec`: the serialized output length.
      if (svg != null && limits) checkSvgLength(svg, limits)
      return { scene, svg, error: null, session }
    } catch (e) {
      return { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), session }
    }
  }, [normalized, ...Object.values(deps), serialize, session])
}

// ---------------------------------------------------------------------------
// Async data: Suspense / use() (R11.2)
// ---------------------------------------------------------------------------

export interface UseSpecDataOptions {
  /** Fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis['fetch']
}

const FETCH_IDS = new WeakMap<object, number>()
let FETCH_SEQ = 0
const RESOURCES = new WeakMap<object, { key: string; promise: Promise<VgSpec> }>()

function fetchKey(fetchImpl: typeof globalThis['fetch'] | undefined): string {
  if (!fetchImpl) return 'global'
  let id = FETCH_IDS.get(fetchImpl as unknown as object)
  if (id === undefined) {
    id = ++FETCH_SEQ
    FETCH_IDS.set(fetchImpl as unknown as object, id)
  }
  return `f${id}`
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
  const key = fetchKey(options.fetch)
  const cached = RESOURCES.get(spec)
  if (cached && cached.key === key) return cached.promise
  const promise = import('@aster/core/load').then((mod) =>
    mod.loadSpecData(spec, options.fetch ? { fetch: options.fetch } : undefined),
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
  return mod.loadSpecData(spec, options.fetch ? { fetch: options.fetch } : undefined)
}

/** A chart loaded with `useSpecData`, rendered headlessly. */
export function useChartData(
  spec: VgSpec,
  options: UseChartOptions & UseSpecDataOptions = {},
): UseChartResult {
  const { fetch, ...chartOptions } = options
  const loaded = useSpecData(spec, { fetch })
  return useChart(loaded, chartOptions)
}
