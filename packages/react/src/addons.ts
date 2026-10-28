/**
 * Add-on auto-load for the React shells and hooks.
 *
 * A spec that needs an opt-in add-on (`@aster/core/transforms`, `/geo`, `/load`; see `@aster/core/addons`) renders with
 * nothing imported by the app. The shells read what the spec needs, import it, and render when it is there.
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
import type { VgSpec } from '@aster/core'
import { addonsNeeded, loadAddons, notLoaded, type AddonName } from '@aster/core/addons'

/** One promise per set of add-ons: what resolves to `null` (loaded) or the error that stopped it. */
const settled = new Map<string, Promise<Error | null>>()

function settle(names: readonly AddonName[]): Promise<Error | null> {
  const key = names.join('+')
  let p = settled.get(key)
  if (!p) {
    p = loadAddons(names).then(() => null, (e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    settled.set(key, p)
  }
  return p
}

/**
 * Make sure the add-ons `spec` needs are loaded. Returns `null` once they are (at once when none is needed), the error
 * when an import failed; suspends while an import is in flight. `null` as the spec (a scene supplied from outside,
 * which is never evaluated here) needs nothing.
 */
export function useAddons(spec: VgSpec | null): Error | null {
  // what the spec needs is a walk of the spec: once per spec, not once per render (a signal event re-renders the chart often)
  const needed = React.useMemo(() => (spec === null ? NO_ADDONS : addonsNeeded(spec)), [spec])
  const missing = notLoaded(needed)
  return missing.length === 0 ? null : React.use(settle(missing))
}
const NO_ADDONS: readonly AddonName[] = []

export { loadAddonsFor } from '@aster/core/addons'
