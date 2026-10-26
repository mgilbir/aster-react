/**
 * Cartographic projections for geo marks, built on the owned d3-geo port (the
 * same library vega uses). A projection turns lon/lat geometry into pixel
 * coordinates; the geoshape transform / shape marks then render it to an SVG
 * path.
 */
import {
  geoPath, albers as geoAlbers, albersUsa as geoAlbersUsa, geoIdentity, mollweide as geoMollweide,
  azimuthalEqualArea as geoAzimuthalEqualArea,
  azimuthalEquidistant as geoAzimuthalEquidistant,
  conicConformal as geoConicConformal,
  conicEqualArea as geoConicEqualArea,
  conicEquidistant as geoConicEquidistant,
  equalEarth as geoEqualEarth, equirectangular as geoEquirectangular,
  gnomonic as geoGnomonic, mercator as geoMercatorDefault,
  naturalEarth1 as geoNaturalEarth1, orthographic as geoOrthographic,
  stereographic as geoStereographic, transverseMercator as geoTransverseMercator,
} from './geo-projections.js'

type GeoProjection = any

const geoMercator: () => any = geoMercatorDefault

type Factory = () => GeoProjection

/**
 * vega-projection's registry, by lower-cased type. `projection(type)` lower-cases
 * the name it is asked for, so `naturalEarth1`, `NaturalEarth1` and
 * `naturalearth1` are one projection; a name outside this set (`robinson`,
 * `albers-usa`, ...) is unrecognised, and building one throws.
 */
const FACTORIES: Record<string, Factory> = Object.assign(Object.create(null), {
  albers: geoAlbers,
  albersusa: geoAlbersUsa,
  azimuthalequalarea: geoAzimuthalEqualArea,
  azimuthalequidistant: geoAzimuthalEquidistant,
  conicconformal: geoConicConformal,
  conicequalarea: geoConicEqualArea,
  conicequidistant: geoConicEquidistant,
  equalearth: geoEqualEarth,
  equirectangular: geoEquirectangular,
  gnomonic: geoGnomonic,
  identity: geoIdentity,
  mercator: geoMercator,
  mollweide: geoMollweide,
  naturalearth1: geoNaturalEarth1,
  orthographic: geoOrthographic,
  stereographic: geoStereographic,
  transversemercator: geoTransverseMercator,
})

/** vega-projection `projectionProperties`, in the order the Projection transform applies them. */
const PROJECTION_PROPERTIES = [
  // standard properties in d3-geo
  'clipAngle', 'clipExtent', 'scale', 'translate', 'center', 'rotate', 'parallels', 'precision', 'reflectX', 'reflectY',
  // extended properties in d3-geo-projections
  'coefficient', 'distance', 'fraction', 'lobes', 'parallel', 'radius', 'ratio', 'spacing', 'tilt',
]

/** A projection spec with all signal values resolved (vega-parser's projection parameters). */
export interface ResolvedProjection {
  name: string
  type: string
  /** Every other parameter: the d3 projection properties, `pointRadius`, `fit`, `size`, `extent`. */
  [param: string]: unknown
}

/** vega-projection `projection(type)`: the factory for a type name, case-insensitively; null if unknown. */
function projectionFactory(type: string): Factory | null {
  if (!type || typeof type !== 'string') throw new Error('Projection type must be a name string.')
  return FACTORIES[type.toLowerCase()] ?? null
}

function array(_: unknown): unknown[] {
  return _ != null ? (Array.isArray(_) ? _ : [_]) : []
}

function featurize(f: unknown): unknown[] {
  // `f.type` on a null member throws, as upstream's does
  return (f as { type?: unknown }).type === 'FeatureCollection'
    ? (f as { features: unknown[] }).features
    : array(f)
        .filter((d) => d != null)
        .map((d) => ((d as { type?: unknown }).type === 'Feature' ? d : { type: 'Feature', geometry: d }))
}

/** vega-geo `collectGeoJSON`: one GeoJSON object out of a GeoJSON value or a list of them. */
export function collectGeoJSON(data: unknown): unknown {
  const list = array(data)
  return list.length === 1
    ? list[0]
    : { type: 'FeatureCollection', features: list.reduce<unknown[]>((a, f) => a.concat(featurize(f)), []) }
}

/** vega-geo Projection transform `fit`: scale/translate the projection to the data's bounds. */
function fit(proj: GeoProjection, _: Record<string, unknown>): void {
  const data = collectGeoJSON(_.fit)
  if (_.extent) proj.fitExtent(_.extent, data)
  else if (_.size) proj.fitSize(_.size, data)
}

/**
 * The vega-geo Projection transform: create the projection for `type`, apply the
 * parameters the spec provides (each only when the projection has that property -
 * geoIdentity has no center/rotate, for instance - and otherwise d3's own per-type
 * defaults stay), set the bound path's `pointRadius`, then `fit` to the data when
 * asked. An unrecognised type throws, as upstream.
 */
export function buildProjection(spec: ResolvedProjection, _width?: number, _height?: number): GeoProjection {
  void _width
  void _height
  const type = (spec.type || 'mercator') as string
  const factory = projectionFactory(type)
  if (!factory) throw new Error('Unrecognized projection type: ' + type)
  const p = factory()
  p.type = type.toLowerCase() // the registry key, as vega-projection's `create` sets it
  // vega-projection binds a persistent geoPath to each projection (`p.path`)
  p.path = geoPath(p)
  for (const prop of PROJECTION_PROPERTIES) {
    if (spec[prop] != null && typeof p[prop] === 'function') p[prop](spec[prop])
  }
  if (spec.pointRadius != null) p.path.pointRadius(spec.pointRadius)
  if (spec.fit) fit(p, spec)
  return p
}

/**
 * Render GeoJSON to an SVG path via a projection. A shape the projection clips
 * away entirely yields '' (vega's geoPath does the same; the empty path keeps
 * the row so its path item bounds stay empty rather than falling back to a
 * point bound at the origin).
 */
export function projectedPath(projection: GeoProjection, geo: unknown): string {
  // Use the projection's persistent bound path when present: it carries the
  // projection's pointRadius (and any per-transform overrides applied to it).
  const g = (projection as { path?: (geo: unknown) => string | undefined }).path
  const d = g ? g(geo) : (geoPath(projection)(geo as never) as string | undefined)
  return d ?? ''
}

/**
 * The bounds of a projected shape from its UNROUNDED geometry: vega-scenegraph bounds a `shape` item by
 * running the shape generator through a bounding context (boundContext), not by parsing the 3-digit path
 * string it draws, so a shape that touches a pixel boundary can sit a hair past it and move an ulp-exact
 * layout (`ceil`, a grid's row height). `null` for a shape that draws nothing.
 */
export function projectedBounds(projection: GeoProjection, geo: unknown): [number, number, number, number] | null {
  const g = (projection as { path?: { context(c?: unknown): unknown; (geo: unknown): unknown } }).path
  if (!g) return null
  let x1 = +Number.MAX_VALUE
  let y1 = +Number.MAX_VALUE
  let x2 = -Number.MAX_VALUE
  let y2 = -Number.MAX_VALUE
  const add = (x: number, y: number): void => {
    if (x < x1) x1 = x
    if (x > x2) x2 = x
    if (y < y1) y1 = y
    if (y > y2) y2 = y
  }
  g.context({
    beginPath() {},
    closePath() {},
    moveTo: add,
    lineTo: add,
    // d3's point radius is a full circle
    arc(cx: number, cy: number, r: number) {
      add(cx - r, cy - r)
      add(cx + r, cy + r)
    },
  })
  try {
    g(geo)
  } finally {
    g.context(null)
  }
  return x1 === +Number.MAX_VALUE ? null : [x1, y1, x2, y2]
}

export type { GeoProjection }
