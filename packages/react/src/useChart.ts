import * as React from 'react'
import type { RuntimeInput, SceneRoot, VgSpec } from '@aster-charts/core'
import { checkChartRows, checkSvgLength, createChartSession, renderSceneToSvg } from '@aster-charts/core/lean'
import { normalizeSpecResult, useStableContent, useStableSpec } from './spec.js'
import { useAddons } from './addons.js'
import { acquireSpecData, retainSpecData, type SpecDataOptions } from './specData.js'
export { resetSpecDataErrors } from './specData.js'

/** The build's environment, as bundlers write it in (`process.env.NODE_ENV`); `process` may not exist at all (an unbundled import). */
declare const process: { env: { NODE_ENV?: string } }


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
  // (normalized inside the guard: a value that is not a spec, a Vega-Lite spec without the compiler and a compile error are
  // the result's `error`, as an evaluation error is; see `normalizeSpecResult`)
  const { spec: normalized, error: specError } = React.useMemo(() => normalizeSpecResult(stableSpec), [stableSpec])
  // The opt-in add-ons the spec needs load before the first evaluation: the hook suspends meanwhile (a <Suspense> boundary
  // above shows its fallback), and an import that fails is the result's `error`.
  const addonError = useAddons(normalized, input.urlData, { limits: limits != null, random: input.random != null, signals: input.signals })
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const session = sessionRef.current
  // (development builds: the rows of a render that re-evaluates nothing are checked for in-place changes too, see row-watch.ts)
  try {
    if (process.env.NODE_ENV !== 'production' && normalized !== null) checkChartRows(session, normalized, input)
  } catch (e) {
    if (typeof process !== 'undefined') throw e
  }
  // Every `RuntimeInput` field is a dependency. The record below must name each
  // key of `RuntimeInput` (the type makes a missing one a compile error), so a new
  // engine input cannot silently leave a stale result the way textMetrics,
  // dataPulse, changedDatasets and autoChanges once did.
  const deps: Required<{ [K in keyof RuntimeInput]: unknown }> = {
    limits, textMetrics: input.textMetrics, urlPolicy: input.urlPolicy, urlData: input.urlData, data: input.data, width: input.width, height: input.height, signals: input.signals,
    changedDatasets: input.changedDatasets, dataChanges: input.dataChanges, dataPulse: input.dataPulse,
    autoChanges: input.autoChanges, domainRaw: input.domainRaw, logger: input.logger, random: input.random, containerSize: input.containerSize, measuredSize: input.measuredSize,
  }
  return React.useMemo(() => {
    if (specError) return { scene: null, svg: null, error: specError, session }
    if (addonError) return { scene: null, svg: null, error: addonError, session }
    try {
      const scene = session.evaluate(normalized!, { ...input, limits })
      const svg = serialize ? renderSceneToSvg(scene) : null
      // Same budget as `renderSpec`: the serialized output length.
      if (svg != null && limits) checkSvgLength(svg, limits)
      return { scene, svg, error: null, session }
    } catch (e) {
      return { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), session }
    }
  }, [normalized, specError, addonError, ...Object.values(deps), serialize, session])
}

// ---------------------------------------------------------------------------
// Async data: Suspense / use()
// ---------------------------------------------------------------------------

/**
 * Everything `loadSpecData` takes (`@aster-charts/core/load` `LoadOptions`): `fetch`,
 * `baseURL` (needed for relative urls), `protocols`, `allow`, `allowPrivateNetwork`,
 * `signal`, `timeoutMs`, `maxBytes`, `maxTotalBytes`, `maxRequests`, `maxConcurrent`,
 * `maxRedirects`, `signals` and `limits`. A network url needs an explicit policy: `allow`
 * (an allowlist), or a `baseURL` it is on; non-public hosts are refused unless
 * `allowPrivateNetwork` is set.
 *
 * Plus `cacheKey`: the host's own name for the load, part of the cache key. The
 * cache is shared by every component (and, on a server, by every request); the
 * spec and the data options are compared by content, but `fetch` / `allow` are
 * called through a latest-ref and only their code tells loads apart. Give a
 * `cacheKey` (a user id, a request id) when the same spec is loaded with
 * functions that close over different values, such as a per-user `fetch`.
 */
export type UseSpecDataOptions = SpecDataOptions

/**
 * The promise `useSpecData` reads: one per load, the same for every ask with the same inputs (see specData.ts for the key and
 * the lifetime). The spec and the data options are compared by content, `signal` by identity, and a function option by its code
 * and called through a latest-ref, so inline literals are safe. A rejected load stays the answer until an input changes or
 * `resetSpecDataErrors()` is called. The loader add-on is imported lazily: a host that never uses URL datasets never bundles the
 * csv/topojson readers.
 */
export function loadSpecDataResource(
  spec: VgSpec,
  options: UseSpecDataOptions = {},
): Promise<VgSpec> {
  return acquireSpecData(spec, options).promise
}

/**
 * Suspense-friendly URL-data loader:
 *
 * ```tsx
 * const allow = (url: URL) => url.origin === 'https://data.example.com'
 * function ChartFromUrl({ spec }) {
 *   const loaded = useSpecData(spec, { allow })
 *   return <Chart spec={loaded} />
 * }
 * // wrap in <Suspense fallback=…> and an error boundary
 * ```
 *
 * Inputs are compared as everywhere at the React boundary: an inline spec or options literal (an inline `allow` arrow included)
 * is the same load. A load that fails is thrown to the nearest error boundary, once: it is never retried by itself. It is tried
 * again when an input changes, and after `resetSpecDataErrors()`, which the boundary calls when it is reset:
 *
 * ```tsx
 * <ErrorBoundary onReset={resetSpecDataErrors} fallbackRender={...}>
 * ```
 */
export function useSpecData(spec: VgSpec, options: UseSpecDataOptions = {}): VgSpec {
  const load = acquireSpecData(spec, options)
  // (a mounted reader keeps its load in the cache; see specData.ts)
  React.useEffect(() => retainSpecData(load), [load])
  return React.use(load.promise as Promise<VgSpec>)
}

/**
 * Explicit async loader (the non-Suspense path). Same addon as
 * `@aster-charts/core/load`, imported lazily so URL datasets do not tax the base
 * bundle.
 */
export async function loadSpecData(spec: VgSpec, options: UseSpecDataOptions = {}): Promise<VgSpec> {
  const mod = await import('@aster-charts/core/load')
  // (`cacheKey` names a cached load; this call caches nothing)
  const { cacheKey: _unused, ...loaderOptions } = options
  return mod.loadSpecData(spec, loaderOptions)
}

/** Options only the loader understands; everything else (and `limits`, which both use) goes to the chart. */
const LOAD_ONLY_OPTIONS = ['cacheKey', 'fetch', 'baseURL', 'protocols', 'allow', 'allowPrivateNetwork', 'signal', 'timeoutMs', 'maxBytes', 'maxTotalBytes', 'maxRequests', 'maxConcurrent', 'maxRedirects'] as const

/**
 * A chart loaded with `useSpecData`, rendered headlessly. Takes the loader options
 * (`baseURL`, `allow`, ...) and the chart options together; `limits` and `signals` apply to
 * both (a `{signal}` url is loaded for the host's value, and loaded again when it changes).
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
  if (options.signals) loadOptions.signals = options.signals
  const loaded = useSpecData(spec, loadOptions)
  return useChart(loaded, chartOptions)
}
