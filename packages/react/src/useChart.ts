import * as React from 'react'
import { renderSceneToSvg, type RuntimeInput, type SceneRoot, type VgSpec } from '@aster/core'
import { createChartSession } from '@aster/core/dom'
import { normalizeChartSpec } from './spec.js'

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
  const normalized = React.useMemo(() => normalizeChartSpec(spec), [spec])
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const session = sessionRef.current
  return React.useMemo(() => {
    try {
      const scene = session.evaluate(normalized, input)
      return { scene, svg: serialize ? renderSceneToSvg(scene) : null, error: null, session }
    } catch (e) {
      return { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), session }
    }
  }, [normalized, input.data, input.dataChanges, input.width, input.height, input.signals, input.domainRaw, input.limits, serialize, session])
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
