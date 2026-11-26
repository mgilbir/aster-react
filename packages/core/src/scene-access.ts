/**
 * Reads of the engine's own scene metadata for the sibling packages and the repo's tests (`@aster-charts/core/internal`, not public API).
 *
 * A scene carries members that only the engine's own consumers read (`__scales`, `__scaleMap`: see types.ts, where they are marked
 * tagged for removal from the published declarations). A package that needs one reads it through these functions instead of
 * naming the member, so the member's name and shape stay an implementation detail the engine can change in one place.
 */
import type { ScaleSnapshot, SceneGroup, SceneRoot } from './types.js'

/** The plain-data scale snapshots a scene scope (the root, or a group item that declares scales) resolved, or `undefined`. */
export function sceneScaleSnapshots(scope: SceneRoot | SceneGroup): readonly ScaleSnapshot[] | undefined {
  return scope.__scales
}

/** The live scales (by name) an evaluation left on the root, or `undefined` for a scene that crossed `postMessage` or was cloned. */
export function sceneScaleMap(root: SceneRoot): ReadonlyMap<string, unknown> | undefined {
  return root.__scaleMap
}
