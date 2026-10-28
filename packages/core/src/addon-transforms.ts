/**
 * Opt-in transforms addon. Importing (or dynamic-importing) this module
 * registers the rare-layout transforms — kde/quantile/regression/loess,
 * pack/partition/treemap, wordcloud, voronoi — into the core registry:
 *
 *   import '@aster/core/transforms'            // static
 *   await import('@aster/core/transforms')     // lazy
 *
 * A plain bar/line/scatter chart never needs it; a spec that does use one of
 * these transforms throws an actionable "load the addon" error when the addon
 * is missing (see registry.ts `requireTransform`).
 */
import './transform-extra.js'
import './stats-functions.js'
