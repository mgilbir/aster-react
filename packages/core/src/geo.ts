/**
 * Cartographic projections for geo marks and transforms, as vega builds them. A projection turns
 * lon/lat geometry into pixel coordinates; the geoshape transform and shape marks then render it to an
 * SVG path (geo-path.ts), and the geopoint transform projects positions (geo-projections.ts).
 */
import {
  albers, albersUsa, azimuthalEqualArea, azimuthalEquidistant, conicConformal, conicEqualArea, conicEquidistant,
  equalEarth, equirectangular, gnomonic, identity, mercator, mollweide, naturalEarth1, orthographic, stereographic,
  transverseMercator, type GeoProjection,
} from './geo-projections.js'
import { GeoPath, PathWriter, ShapeBounds, Tee, type PointRadius } from './geo-path.js'

type Factory = () => GeoProjection

/**
 * vega-projection's registry, by lower-cased type. `projection(type)` lower-cases the name it is asked
 * for, so `naturalEarth1`, `NaturalEarth1` and `naturalearth1` are one projection; a name outside this
 * set (`robinson`, `albers-usa`, ...) is unrecognised, and building one throws.
 */
const FACTORIES: Record<string, Factory> = Object.assign(Object.create(null), {
  albers,
  albersusa: albersUsa,
  azimuthalequalarea: azimuthalEqualArea,
  azimuthalequidistant: azimuthalEquidistant,
  conicconformal: conicConformal,
  conicequalarea: conicEqualArea,
  conicequidistant: conicEquidistant,
  equalearth: equalEarth,
  equirectangular,
  gnomonic,
  identity,
  mercator,
  mollweide,
  naturalearth1: naturalEarth1,
  orthographic,
  stereographic,
  transversemercator: transverseMercator,
})

/** A projection spec with all signal values resolved (vega-parser's projection parameters). */
export interface ResolvedProjection {
  name: string
  type: string
  /** Every other parameter: the projection properties, `pointRadius`, `fit`, `size`, `extent`. */
  [param: string]: unknown
}

/** The factory for a projection type name, case-insensitively; null if there is none. */
function projectionFactory(type: string): Factory | null {
  if (!type || typeof type !== 'string') throw new Error('Projection type must be a name string.')
  return FACTORIES[type.toLowerCase()] ?? null
}

const array = (value: unknown): unknown[] => (value != null ? (Array.isArray(value) ? value : [value]) : [])

function featurize(f: unknown): unknown[] {
  // `f.type` on a null member throws, as vega's does
  return (f as { type?: unknown }).type === 'FeatureCollection'
    ? (f as { features: unknown[] }).features
    : array(f)
        .filter((d) => d != null)
        .map((d) => ((d as { type?: unknown }).type === 'Feature' ? d : { type: 'Feature', geometry: d }))
}

/** One GeoJSON object out of a GeoJSON value or a list of them (several become a FeatureCollection). */
export function collectGeoJSON(data: unknown): unknown {
  const list = array(data)
  return list.length === 1
    ? list[0]
    : { type: 'FeatureCollection', features: list.reduce<unknown[]>((a, f) => a.concat(featurize(f)), []) }
}

/**
 * Make the projection a vega projection definition describes: create the projection for `type`, apply
 * the parameters the spec provides (each only when the projection has that property -- the identity
 * projection has no centre or rotation, for instance -- and otherwise the projection's own defaults
 * stay), set the radius its path draws points with, then fit it to the data when asked. An unrecognised
 * type throws.
 */
export function buildProjection(spec: ResolvedProjection, _width?: number, _height?: number): GeoProjection {
  void _width
  void _height
  const type = (spec.type || 'mercator') as string
  const factory = projectionFactory(type)
  if (!factory) throw new Error('Unrecognized projection type: ' + type)
  const p = factory()
  p.type = type.toLowerCase()
  p.configure(spec)
  if (spec.pointRadius != null) p.path.pointRadius = typeof spec.pointRadius === 'function' ? (spec.pointRadius as PointRadius) : +(spec.pointRadius as number)
  if (spec.fit) {
    const data = collectGeoJSON(spec.fit)
    if (spec.extent) p.fitExtent(spec.extent as number[][], data)
    else if (spec.size) p.fitSize(spec.size as number[], data)
  }
  return p
}

/**
 * Render GeoJSON to an SVG path through a projection. A shape the projection clips away entirely yields
 * '' (the empty path keeps the row, so its path item bounds stay empty rather than falling back to a
 * point bound at the origin).
 */
export function projectedPath(projection: GeoProjection, geo: unknown, pointRadius?: unknown): string {
  return projection.path.draw(geo, (pointRadius ?? undefined) as PointRadius | undefined) ?? ''
}

/**
 * What a shape draws: its SVG path, and its bounds from the UNROUNDED geometry. vega-scenegraph bounds a `shape`
 * item by running the shape generator through a bounding context, not by parsing the 3-digit path string it draws,
 * so a shape that touches a pixel boundary can sit a hair past it and move an ulp-exact layout (`ceil`, a grid's
 * row height). `bounds` is null for a shape that draws nothing; `path` is '' then (the empty path keeps the row,
 * so its path item bounds stay empty rather than falling back to a point bound at the origin).
 */
export function projectedShape(
  projection: GeoProjection,
  geo: unknown,
  pointRadius?: unknown,
): { path: string; bounds: [number, number, number, number] | null } {
  const path = projection.path
  if (!geo) return { path: '', bounds: null }
  const radius = path.radiusFor(geo, (pointRadius ?? undefined) as PointRadius | undefined)
  const writer = new PathWriter(path.digits, radius)
  const box = new ShapeBounds(radius)
  path.feed(geo, new Tee(writer, box))
  return { path: writer.result() ?? '', bounds: box.result() }
}

/** The unrounded bounds of a projected shape (see `projectedShape`); null for a shape that draws nothing. */
export function projectedBounds(projection: GeoProjection, geo: unknown, pointRadius?: unknown): [number, number, number, number] | null {
  return projectedShape(projection, geo, pointRadius).bounds
}

export { GeoPath, type GeoProjection }
