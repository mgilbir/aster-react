import type { View } from 'vega'

/**
 * The root group of a vega view's scenegraph. The runtime's `Scenegraph` has a `root`; vega's typings declare `scenegraph(): Scene`
 * without it, and the differentials read the real scene tree, so the one place that knows this is here.
 */
export function scenegraphRoot(view: View): unknown {
  return (view.scenegraph() as unknown as { root: unknown }).root
}
