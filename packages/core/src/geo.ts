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
const FACTORIES: Record<string, Factory> = {
  albers: geoAlbers,
  'albers-usa': geoAlbersUsa as unknown as Factory,
  albersUsa: geoAlbersUsa as unknown as Factory,
  albersusa: geoAlbersUsa as unknown as Factory,
  azimuthalEqualArea: geoAzimuthalEqualArea,
  'azimuthal-equal-area': geoAzimuthalEqualArea,
  azimuthalequalarea: geoAzimuthalEqualArea,
  azimuthalEquidistant: geoAzimuthalEquidistant,
  'azimuthal-equidistant': geoAzimuthalEquidistant,
  azimuthalequidistant: geoAzimuthalEquidistant,
  conicConformal: geoConicConformal,
  'conic-conformal': geoConicConformal,
  conicconformal: geoConicConformal,
  conicEqualArea: geoConicEqualArea,
  'conic-equal-area': geoConicEqualArea,
  conicequalarea: geoConicEqualArea,
  conicEquidistant: geoConicEquidistant,
  'conic-equidistant': geoConicEquidistant,
  conicequidistant: geoConicEquidistant,
  equalEarth: geoEqualEarth,
  'equal-earth': geoEqualEarth,
  equalearth: geoEqualEarth,
  equirectangular: geoEquirectangular,
  gnomonic: geoGnomonic,
  identity: geoIdentity as unknown as Factory,
  mercator: geoMercator,
  mollweide: geoMollweide,
  naturalEarth1: geoNaturalEarth1,
  'natural-earth': geoNaturalEarth1,
  naturalearth1: geoNaturalEarth1,
  orthographic: geoOrthographic,
  stereographic: geoStereographic,
  transverseMercator: geoTransverseMercator,
  'transverse-mercator': geoTransverseMercator,
  transversemercator: geoTransverseMercator,
}

/** A projection spec with all signal values resolved to numbers/tuples. */
export interface ResolvedProjection {
  name: string
  type: string
  scale?: number
  translate?: [number, number]
  center?: [number, number]
  rotate?: [number, number] | [number, number, number]
  precision?: number
  clipAngle?: number
  reflectX?: boolean
  reflectY?: boolean
  params?: Record<string, unknown>
}

/**
 * Build a d3-geo projection from a compiled spec. Vega applies only the
 * parameters the spec provides — scale/translate/etc otherwise keep d3's own
 * per-type defaults (e.g. mercator translate [480, 250] regardless of chart
 * size; verified against the oracle on a 200x100 chart). When the type is
 * unknown we fall back to mercator (vega's default projection type).
 */
export function buildProjection(spec: ResolvedProjection, _width: number, _height: number): GeoProjection {
  const factory = (Object.hasOwn(FACTORIES, spec.type) ? FACTORIES[spec.type] : undefined) ?? geoMercator
  const p = factory()
  if (spec.scale != null && typeof p.scale === 'function') p.scale(spec.scale)
  if (spec.translate != null && typeof p.translate === 'function') p.translate(spec.translate)
  // vega-projection applies only properties the projection object carries
  // (`if (p[prop])`): geoIdentity has no center/rotate, for instance.
  if (spec.center && typeof p.center === 'function') p.center(spec.center)
  if (spec.rotate && typeof p.rotate === 'function') p.rotate(spec.rotate as [number, number, number])
  // geoIdentity has no precision/clipAngle: vega-projection only applies
  // properties the projection object actually carries, so skip when absent.
  if (spec.precision != null && typeof p.precision === 'function') p.precision(spec.precision)
  if (spec.clipAngle != null && typeof p.clipAngle === 'function') p.clipAngle(spec.clipAngle)
  if (spec.reflectX != null && 'reflectX' in p) (p as unknown as { reflectX(b: boolean): unknown }).reflectX(spec.reflectX)
  if (spec.reflectY != null && 'reflectY' in p) (p as unknown as { reflectY(b: boolean): unknown }).reflectY(spec.reflectY)
  // Vega-projection binds a persistent geoPath to each projection (`p.path`).
  // The `pointRadius` parameter is applied to that path (vega's Projection
  // transform: `if (_.pointRadius != null) proj.path.pointRadius(_.pointRadius)`),
  // so the geoshape/geopath transforms render Point geometries with it.
  const boundPath = geoPath(p)
  ;(p as unknown as { path: unknown }).path = boundPath
  ;(p as unknown as Record<string, unknown>).pointRadius = (_?: number) => {
    if (arguments.length) {
      boundPath.pointRadius(_)
      return p
    }
    return boundPath.pointRadius()
  }
  // Projection-specific parameters (parallels, pointRadius, clipExtent, ...):
  // applied when the projection factory supports them, mirroring vega's
  // projection param application.
  const extras = spec.params
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (k === 'type' || k === 'name' || v == null) continue
      const fn = (p as unknown as Record<string, unknown>)[k]
      if (typeof fn === 'function') {
        try {
          ;(p as unknown as Record<string, (x?: unknown) => unknown>)[k]!(v)
        } catch {
          /* projection rejects the parameter */
        }
      }
      void fn
    }
  }
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

export type { GeoProjection }
