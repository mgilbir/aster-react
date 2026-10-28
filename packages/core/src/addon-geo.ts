/**
 * Opt-in geo/contour addon. Importing (or dynamic-importing) this module
 * registers the owned geo/contour engines (ported from d3-geo and
 * d3-contour behind oracle vectors) into the core registry so
 * that projections, projected `geoshape`, and the `contour` transform work:
 *
 *   import '@aster/core/geo'                 // static
 *   await import('@aster/core/geo')          // lazy
 *
 * Keeping them out of the core barrel means a plain bar/line chart never
 * bundles the ~17 kB (gzip) of d3-geo projection + clipping machinery.
 */
import { geoRegistry, type ContourFeature } from './registry.js'
import { buildProjection, projectedBounds, projectedPath } from './geo.js'
import d3Contours from './contour.js'
import { geoArea, geoBounds, geoCentroid, geoPath } from './geo-lib.js'
import { registerRuntimeExpressionFunction } from './expression.js'

geoRegistry.buildProjection = (spec, width, height) =>
  buildProjection(spec as Parameters<typeof buildProjection>[0], width, height)
const defaultPath = geoPath()
geoRegistry.defaultPath = () => defaultPath
geoRegistry.projectedPath = (projection, geo, pointRadius): string =>
  projectedPath(projection as Parameters<typeof projectedPath>[0], geo, pointRadius)
geoRegistry.projectedBounds = (projection, geo, pointRadius) =>
  projectedBounds(projection as Parameters<typeof projectedBounds>[0], geo, pointRadius)
// the contour generator sets thresholds via `.thresholds(array)`, then is
// called as `contours(values)` — it has no 2-arg form (vega's fork does).
geoRegistry.contourRun = (values, thresholds, size, smooth) =>
  (d3Contours().smooth(smooth).size(size).thresholds(thresholds)(values as unknown as number[]) ?? []) as ContourFeature[]


// vega-functions geo.js: `geoArea` / `geoBounds` / `geoCentroid` of a GeoJSON object, through the named projection's
// path (pixels) or, with no projection, on the sphere (steradians; degrees); `geoScale` is the projection's scale.
type BoundPath = Record<'area' | 'bounds' | 'centroid', (geojson: unknown) => unknown>
type Projectionish = { path: BoundPath; scale(): number }
const projectionOf = (runtime: { projection?: (name: string) => unknown }, name: unknown): Projectionish | undefined =>
  runtime.projection?.(String(name)) as Projectionish | undefined
const geoMethod = (method: 'area' | 'bounds' | 'centroid', global: (geojson: never) => unknown) =>
  (runtime: { projection?: (name: string) => unknown }) =>
    (projection?: unknown, geojson?: unknown): unknown => {
      if (projection) {
        const p = projectionOf(runtime, projection)
        return p && p.path[method](geojson)
      }
      return global(geojson as never)
    }
registerRuntimeExpressionFunction('geoArea', geoMethod('area', geoArea))
registerRuntimeExpressionFunction('geoBounds', geoMethod('bounds', geoBounds))
registerRuntimeExpressionFunction('geoCentroid', geoMethod('centroid', geoCentroid))
registerRuntimeExpressionFunction('geoScale', (runtime) => (projection?: unknown): unknown => projectionOf(runtime, projection)?.scale())
