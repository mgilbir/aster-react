/**
 * `<Chart urlLoad>`: the chart loads its spec's `url` datasets itself and keeps them current, as a vega view does.
 *
 * What it does, and why it lives here and not in the core: the engine is synchronous and fetches nothing (docs/ARCHITECTURE.md),
 * so a `url` dataset is turned into rows OUTSIDE evaluation, by `loadSpecData` (the loader add-on, imported lazily so an app
 * without url data never bundles it, under the host's required URL policy). Vega reloads a dataset whose url is a `{signal}`
 * whenever that signal changes, wherever the change comes from (a bound input, an event handler, `setSignal`, the host); the
 * chart's signal values (the `signals` prop merged with what events wrote) are the loader's `signals`, and the list of urls they
 * give (`datasetUrls`) is compared before each load: a signal change that leaves every url as it was loads nothing.
 *
 * - Until the first load arrives the spec is drawn with its url datasets empty (`emptyUrlData`), as vega draws a view whose url
 *   has not answered. The server draws that too (effects do not run there), so a hydrating client matches it.
 * - While a newer url loads, the rows of the previous one stay, as in vega; the load that a newer url supersedes is ABORTED (its
 *   requests are cancelled), and so is one still running when the chart unmounts. A load that was superseded never reports.
 * - A failure (policy refusal, HTTP error, limit, a url that is not a string) goes to the chart's one error channel: the error
 *   state and `onError`, once per error. It is not retried by itself; a change of url, spec or options loads again, and a
 *   success clears it.
 * - The loader's `limits` are the chart's; its `signal` is the chart's (an abort), never the host's.
 */
import * as React from 'react'
import { emptyUrlData } from '@aster-charts/core/lean'
import type { SpecLimits, VgSpec } from '@aster-charts/core'
import type { LoadOptions } from '@aster-charts/core/load'
import { useLatest } from './inputs.js'
import { useStableContent } from './spec.js'

/** The loader options the host gives `<Chart urlLoad>`: its own `signal`, `signals` and `limits` are the chart's. */
export type UrlLoadOptions = Omit<LoadOptions, 'signal' | 'signals' | 'limits'>

type LoadAddon = typeof import('@aster-charts/core/load')
let loadAddon: Promise<LoadAddon> | undefined
const importLoader = (): Promise<LoadAddon> => (loadAddon ??= import('@aster-charts/core/load').catch((e: unknown) => {
  loadAddon = undefined
  throw e
}))

/** The options with their functions replaced by calls through the latest-ref, so a function rebuilt by every render is no change. */
function useStableLoadOptions(options: UrlLoadOptions | undefined): LoadOptions | undefined {
  const latest = useLatest(options)
  const { fetch: fetchFn, allow, ...plain } = options ?? {}
  const shape = useStableContent(options === undefined ? undefined : { plain, fetch: fetchFn !== undefined, allow: allow !== undefined })
  return React.useMemo((): LoadOptions | undefined => {
    if (shape === undefined) return undefined
    const out: LoadOptions = { ...(shape.plain as LoadOptions) }
    if (shape.fetch) out.fetch = (...args: Parameters<NonNullable<LoadOptions['fetch']>>) => latest.current!.fetch!(...args)
    if (shape.allow) out.allow = (url) => latest.current!.allow!(url)
    return out
  }, [shape, latest])
}

interface Loaded { readonly source: VgSpec; readonly spec: VgSpec }
interface Failed { readonly source: VgSpec; readonly error: Error }

/**
 * The spec to evaluate and the error of a load that failed. With no `urlLoad`, or a spec with no url dataset, the spec itself and
 * no error: nothing is imported and nothing is fetched.
 */
export function useUrlData(
  spec: VgSpec,
  urlLoad: UrlLoadOptions | undefined,
  signals: Readonly<Record<string, unknown>>,
  limits: SpecLimits | undefined,
): { spec: VgSpec; error: Error | null } {
  const options = useStableLoadOptions(urlLoad)
  const enabled = options !== undefined
  // (a spec with no url dataset is returned as it is: `emptyUrlData` is the same object then)
  const empty = React.useMemo(() => (enabled ? emptyUrlData(spec) : spec), [enabled, spec])
  const hasUrls = empty !== spec
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [failed, setFailed] = React.useState<Failed | null>(null)
  // The load in flight or last made: what it was for, so an equal ask starts nothing. `seq` orders the asks (each waits for the
  // loader's import; only the latest one acts).
  const state = React.useRef<{ source: VgSpec; options: LoadOptions | undefined; key: string; controller: AbortController | null; seq: number }>({
    source: spec, options, key: '', controller: null, seq: 0,
  })

  // (declared first so that, in a StrictMode remount, it runs before the load effect: an unmount cancels what is in flight and
  // forgets it, so the remount loads again)
  React.useEffect(() => () => {
    const s = state.current
    s.seq++
    s.controller?.abort()
    s.controller = null
    s.key = ''
  }, [])

  React.useEffect(() => {
    if (!enabled || !hasUrls) return
    const s = state.current
    const mine = ++s.seq
    void importLoader().then((mod) => {
      // (a later ask, or an unmount, superseded this one while the loader was loading)
      if (s.seq !== mine) return
      let key: string
      try {
        key = JSON.stringify(mod.datasetUrls(spec, { signals, limits })) ?? ''
      } catch (e) {
        s.controller?.abort()
        s.controller = null
        s.source = spec; s.options = options; s.key = ''
        setFailed({ source: spec, error: e instanceof Error ? e : new Error(String(e)) })
        return
      }
      if (s.source === spec && s.options === options && s.key === key) return
      s.controller?.abort()
      const controller = new AbortController()
      s.controller = controller
      s.source = spec; s.options = options; s.key = key
      mod.loadSpecData(spec, { ...options, signals, limits, signal: controller.signal }).then(
        (result) => {
          if (s.controller !== controller) return
          s.controller = null
          setLoaded({ source: spec, spec: result })
          setFailed(null)
        },
        (e: unknown) => {
          // (a load a newer url superseded was aborted by that ask: it reports nothing)
          if (s.controller !== controller) return
          s.controller = null
          setFailed({ source: spec, error: e instanceof Error ? e : new Error(String(e)) })
        },
      )
    }, (e: unknown) => {
      if (s.seq === mine) setFailed({ source: spec, error: e instanceof Error ? e : new Error(String(e)) })
    })
  }, [enabled, hasUrls, spec, options, signals, limits])

  if (!enabled || !hasUrls) return { spec, error: null }
  return {
    spec: loaded !== null && loaded.source === spec ? loaded.spec : empty,
    error: failed !== null && failed.source === spec ? failed.error : null,
  }
}
