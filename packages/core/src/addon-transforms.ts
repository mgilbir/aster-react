/**
 * Opt-in transforms addon. Importing (or dynamic-importing) this module
 * registers the rare-layout and statistics transforms into the core registry: the statistics
 * (kde, kde2d, density, quantile, regression, loess, isocontour, heatmap), the hierarchy and network
 * layouts (nest, tree, treelinks, pack, partition, treemap, force), wordcloud, voronoi, label, and the
 * row-shaping and geo ones (crossfilter, resolvefilter, pie, cross, countpattern, dotbin, geopoint,
 * geojson, geopath, linkpath). `TRANSFORMS_ADDON_TYPES` in addons.ts is the authoritative list. The
 * module also registers the distribution functions of the expression language
 * (sample/density/cumulative/quantile for the normal, log-normal and uniform distributions,
 * treePath, treeAncestors):
 *
 *   import '@aster-charts/core/transforms'            // static
 *   await import('@aster-charts/core/transforms')     // lazy
 *
 * A plain bar/line/scatter chart never needs it; a spec that does use one of
 * these transforms throws an actionable "load the addon" error when the addon
 * is missing (see registry.ts `requireTransform`).
 */
import './transform-extra.js'
import './label.js'
import './stats-functions.js'
