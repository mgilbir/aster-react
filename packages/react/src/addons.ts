/**
 * Add-on auto-load for the React shells and hooks.
 *
 * A spec that needs an opt-in add-on (`@aster-charts/core/transforms`, `/geo`, `/load`; see `@aster-charts/core/addons`) renders with
 * nothing imported by the app. The shells read what the spec needs, import it, and render when it is there. The same goes for the
 * parts of the engine that `@aster-charts/core/lean` leaves out of a browser build (the legend builder, the grid layout, the path
 * reader, vega-selections' functions...; see engine-parts.ts in @aster-charts/core): a chart that needs none of them loads nothing.
 *
 * The wait is a React Suspense wait (`use`), the same one an async `spec` and `useSpecData` already use: a <Suspense>
 * boundary above shows its fallback while the add-on loads; with none, the tree waits (a new root commits nothing yet).
 * There is no intermediate render and so no flash of an error or of a half-drawn chart. A spec that needs nothing, and an
 * app that imported the add-on itself, never suspend: the check is one cached lookup per spec.
 *
 * A failed import is an ordinary chart error: it comes back to the shell, which reports it through `onError` like an
 * evaluation error. It is remembered for the page's lifetime, because React retries a suspended tree by asking for the
 * same promise again and a fresh one per ask would never settle (and browsers keep a failed module fetch anyway).
 */
import * as React from 'react'
import type { UrlDataMode, VgSpec } from '@aster-charts/core'
import {
  checkUrlData, loadAddons, loadParts, notLoaded, partLoaded, partsNotLoaded, setUpShell, specNeeds,
  type AddonName, type EnginePart, type PartOptions, type SpecNeeds,
} from '@aster-charts/core/lean'

/**
 * One promise per set of add-ons and parts: what resolves to `null` (loaded) or the error that stopped it. A load that succeeded is
 * not kept once it has settled: asked again, what is missing is missing anew (a slot emptied since), so it is loaded again.
 */
const settled = new Map<string, Promise<Error | null>>()

function settle(addons: readonly AddonName[], parts: readonly EnginePart[], loadCanvas: (() => Promise<void>) | undefined): Promise<Error | null> {
  const key = [...addons, ...parts.map((p) => `part:${p}`), ...(loadCanvas ? ['part:canvas'] : [])].join('+')
  let p = settled.get(key)
  if (!p) {
    p = Promise.all([loadAddons(addons), loadParts(parts), loadCanvas?.()]).then(
      () => { settled.delete(key); return null },
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )
    settled.set(key, p)
  }
  return p
}

/** What the evaluation is given besides the spec that decides which parts of the engine it may need (see `specNeeds`). */
export interface AddonInput {
  /** Whether the chart has `limits` (the regular-expression screen runs only under them). */
  limits?: boolean
  /** Whether the chart has a `random` source. */
  random?: boolean
  /** The canvas renderer to load first, when the chart draws on a canvas (`renderer="canvas"` with the canvas capability). */
  canvas?: { load: () => Promise<void> }
}

/**
 * Make sure the add-ons and the parts of the engine `spec` needs are loaded (see `specNeeds` in `@aster-charts/core/addons`: the
 * parts are what `@aster-charts/core/lean` leaves out, such as the legend builder). Returns `null` once they are (at once when none is
 * needed), the error when an import failed; suspends while an import is in flight. `null` as the spec (a scene supplied from
 * outside, which is never evaluated here) needs nothing. With `urlData: 'refuse'` a spec that has a url dataset is refused here,
 * before any import: the result is the `AsterUrlError` evaluation would throw (and an invalid `urlData` its `TypeError`).
 */
export function useAddons(spec: VgSpec | null, urlData?: UrlDataMode, input?: AddonInput): Error | null {
  setUpShell()
  const limits = input?.limits === true
  const random = input?.random === true
  const canvas = input?.canvas
  // what the spec needs is a walk of the spec: once per spec, not once per render (a signal event re-renders the chart often)
  const needed = React.useMemo((): SpecNeeds | Error => {
    if (spec === null) return NOTHING
    try {
      checkUrlData(spec, urlData)
      const options: PartOptions = { urlData, limits, random }
      return specNeeds(spec, options)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }, [spec, urlData, limits, random])
  if (needed instanceof Error) return needed
  const addons = notLoaded(needed.addons)
  const parts = partsNotLoaded(needed.parts)
  const loadCanvas = canvas !== undefined && !partLoaded('canvas') ? canvas.load : undefined
  return addons.length === 0 && parts.length === 0 && loadCanvas === undefined ? null : React.use(settle(addons, parts, loadCanvas))
}
const NOTHING: SpecNeeds = { addons: [], parts: [] }

export { loadAddonsFor } from '@aster-charts/core/lean'
