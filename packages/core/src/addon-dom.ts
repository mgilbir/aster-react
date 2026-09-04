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
export { patchSceneDom, renderSceneToDomElement, sceneToDomDesc, type DomDesc } from './dom.js'
export { createChartSession, type ChartSession } from './session.js'
