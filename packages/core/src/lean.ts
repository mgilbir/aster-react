/**
 * `@aster-charts/core/lean` (@internal, for `@aster-charts/react`): the engine as the React shells use it, without the parts of it
 * that most charts never run (engine-parts.ts). The shells read which parts a spec needs (`specNeeds`), import them (`loadParts`)
 * and render once they are there, suspending meanwhile as they do for the opt-in add-ons; the pulse path of the incremental engine
 * is imported when a chart's data first changes (`setUpShell`).
 *
 * In a browser build (the `browser` export condition) this module is all a React app's charts load up front. Anywhere else (a
 * server rendering React, a test runner, a worker without the condition) the subpath resolves to `lean-full.ts`, which is the same
 * module with every part already in its slot: a synchronous server render (`renderToString`) draws every chart it drew before.
 *
 * Every function here is one of the public entries' functions; the public entries themselves (`@aster-charts/core`, `/dom`,
 * `/signals`, `/hit`, `/canvas`, `/png`) carry their parts, so their synchronous API works for every spec with nothing to load. The hit
 * index and the loader of the signal loop are `@aster-charts/core/lean/hit` and `/lean/signals`, so that a chart without interaction (`<SvgChart>`)
 * can be seen, from its imports alone, not to reach them; the chart stream is `/lean/stream`, so that the pulse path it carries is not
 * reached through this module by a chart that does not stream.
 */
export { buildA11yTree } from './a11y.js'
export { chartInfoFromScene } from './runtime.js'
export { renderSceneToSvg } from './render.js'
export { AsterLimitError, checkSvgLength } from './limits.js'
export { createPointMapper } from './pointer.js'
export { createCursorTracker, resolveCursor, sceneHasCursor } from './cursor.js'
export { consoleLogger } from './logger.js'
export { checkChartRows, shareRowWatch } from './row-watch.js'
export { checkUrlData } from './url-data.js'
export { createChartSession, skeletonOf as chartSkeleton } from './session.js'
export { hasDenseSymbolMarks, patchSceneDom, renderSceneToDomElement } from './dom.js'
export {
  addonsNeeded, loadAddons, loadAddonsFor, missingAddons, notLoaded,
  specNeeds, partsNeeded, partsNotLoaded, loadParts, loadPartsFor,
  type AddonName, type PartOptions, type SpecNeeds,
} from './addons.js'
export { ENGINE_PARTS, part, partLoaded, withdrawParts, type EngineParts, type EnginePart } from './engine-parts.js'
export { setUpShell } from './shell-setup.js'
