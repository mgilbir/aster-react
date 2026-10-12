/**
 * Opt-in geo/contour addon. Importing (or dynamic-importing) this module
 * registers d3-geo and d3-entry marching-squares into the core registry so
 * that projections, projected `geoshape`, and the `contour` transform work:
 *
 *   import '@aster/core/geo'                 // static
 *   await import('@aster/core/geo')          // lazy
 *
 * Keeping them out of the core barrel means a plain bar/line chart never
 * bundles the ~17 kB (gzip) of d3-geo projection + clipping machinery.
 */
import { geoRegistry, type ContourFeature } from './registry.js'
import { buildProjection, projectedPath } from './geo.js'
import d3Contours from './contour.js'

geoRegistry.buildProjection = (spec, width, height) =>
  buildProjection(spec as Parameters<typeof buildProjection>[0], width, height)
geoRegistry.projectedPath = (projection, geo) =>
  projectedPath(projection as Parameters<typeof projectedPath>[0], geo)
// d3-contour@4's generator sets thresholds via `.thresholds(array)`, then is
// called as `contours(values)` — it has no 2-arg form (vega's fork does).
geoRegistry.contourRun = (values, thresholds, size, smooth) =>
  (d3Contours().smooth(smooth).size(size).thresholds(thresholds)(values as unknown as number[]) ?? []) as ContourFeature[]

