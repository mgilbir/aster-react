/**
 * Opt-in DOM addon. Importing (or dynamic-importing) this module registers the
 * incremental DOM patcher (patchSceneDom / sceneToDomDesc /
 * renderSceneToDomElement / createChartSession) used by
 * `<Chart incremental>`:
 *
 *   import '@aster/core/dom'            // static
 *   await import('@aster/core/dom')     // lazy
 *
 * A string-mode host (renderSpec → SVG string) never needs it.
 */
export {
  hasDenseSymbolMarks,
  patchSceneDom,
  renderSceneToDomElement,
  sceneToDomDesc,
  translatePathData,
  type DomDesc,
  type DomRenderOptions,
} from './dom.js'
export { createChartSession, skeletonOf as chartSkeleton, type ChartSession } from './session.js'
