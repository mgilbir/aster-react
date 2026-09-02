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
import { contours as d3Contours } from 'd3-contour'

geoRegistry.buildProjection = (spec, width, height) =>
  buildProjection(spec as Parameters<typeof buildProjection>[0], width, height)
geoRegistry.projectedPath = (projection, geo) =>
  projectedPath(projection as Parameters<typeof projectedPath>[0], geo)
const makeContour = d3Contours as unknown as () => { smooth(b: boolean): ReturnType<typeof makeContour>; size(s: [number, number]): (v: number[], t: number[]) => unknown[] }
geoRegistry.contourRun = (values, thresholds, size, smooth) =>
  (makeContour().smooth(smooth).size(size)(values as number[], thresholds) ?? []) as ContourFeature[]

