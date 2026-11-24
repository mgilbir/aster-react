/**
 * Opt-in geo/contour addon. Importing (or dynamic-importing) this module
 * registers the geo engine (projections, geoshape paths, spherical measures) and
 * the contour engine into the core registry so that projections, projected
 * `geoshape`, and the `contour` transform work:
 *
 *   import '@aster-charts/core/geo'                 // static
 *   await import('@aster-charts/core/geo')          // lazy
 *
 * It also registers the geo functions of the expression language (geoArea, geoBounds,
 * geoCentroid, geoScale, geoShape, pathShape), and the shapes the `geoshape` transform and a
 * `{sphere}` clip draw (projectedShape, through a projection or the default path).
 *
 * Keeping them out of the core barrel means a plain bar/line chart never
 * bundles the projection, clipping and resampling machinery.
 */
import { geoRegistry, type ContourFeature } from './registry.js'
import { buildProjection, shapeThrough, type GeoProjection } from './geo.js'
import { contourPolygons } from './contour.js'
import { sphereArea, sphereBounds, sphereCentroid } from './geo-sphere-measures.js'
import { GeoPath } from './geo-path.js'
import { projectionOf as projectionRef, registerRuntimeExpressionFunction } from './expression.js'

geoRegistry.buildProjection = (spec) => buildProjection(spec as Parameters<typeof buildProjection>[0])
const defaultPath = new GeoPath()
geoRegistry.defaultPath = () => defaultPath
// (a shape through a projection's path, or with no projection through the default path)
geoRegistry.projectedShape = (projection, geo, pointRadius) =>
  shapeThrough(projection ? (projection as GeoProjection).path : defaultPath, geo, pointRadius)
geoRegistry.contourRun = (values, thresholds, size, smooth) => contourPolygons(values, thresholds, size, smooth) as ContourFeature[]


// vega-functions geo.js: `geoArea` / `geoBounds` / `geoCentroid` of a GeoJSON object, through the named projection's
// path (pixels) or, with no projection, on the sphere (steradians; degrees); `geoScale` is the projection's scale.
type BoundPath = Record<'area' | 'bounds' | 'centroid', (geojson: unknown) => unknown>
type Projectionish = { path: BoundPath; scale: number }
// (a name, or a `copy()` of a projection: vega's getScale)
const projectionOf = (runtime: { projection?: (name: string) => unknown }, name: unknown): Projectionish | undefined =>
  projectionRef(runtime, name) as Projectionish | undefined
const geoMethod = (method: 'area' | 'bounds' | 'centroid', global: (geojson: never) => unknown) =>
  (runtime: { projection?: (name: string) => unknown }) =>
    (projection?: unknown, geojson?: unknown): unknown => {
      if (projection) {
        const p = projectionOf(runtime, projection)
        return p && p.path[method](geojson)
      }
      return global(geojson as never)
    }
registerRuntimeExpressionFunction('geoArea', geoMethod('area', sphereArea))
registerRuntimeExpressionFunction('geoBounds', geoMethod('bounds', sphereBounds))
registerRuntimeExpressionFunction('geoCentroid', geoMethod('centroid', sphereCentroid))
registerRuntimeExpressionFunction('geoScale', (runtime) => (projection?: unknown): unknown => projectionOf(runtime, projection)?.scale)

// vega-functions shape.js / geo.js: `geoShape(projection, geojson)` and `pathShape(path)` are shapes -- functions that draw into a
// context, or (given none) are their path string: what a mark's `clip: {signal}` takes, and what `clip: {sphere}` / `{path}` compile to.
registerRuntimeExpressionFunction('geoShape', (runtime) => (projection?: unknown, geojson?: unknown): unknown => {
  const p = projectionOf(runtime, projection)
  return (context: unknown): string => (p && !context ? ((p as unknown as GeoProjection).path.draw(geojson) ?? '') : '')
})
registerRuntimeExpressionFunction('pathShape', () => (path?: unknown): unknown => (context: unknown): string => (context ? '' : String(path)))
