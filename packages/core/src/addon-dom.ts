/**
 * Opt-in DOM addon. Importing (or dynamic-importing) this module gives access to the
 * incremental DOM patcher (patchSceneDom / sceneToDomDesc /
 * renderSceneToDomElement / createChartSession) used by
 * `<Chart incremental>`. The module only re-exports them and registers nothing;
 * it exists so that the patcher stays out of the core bundle:
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
