/**
 * Cartographic projections for geo marks, built on d3-geo (the same library
 * vega uses). A projection turns lon/lat geometry into pixel coordinates; the
 * geoshape transform / shape marks then render it to an SVG path.
 */
import {
  geoPath, geoAlbers, geoAlbersUsa, geoAzimuthalEqualArea,
  geoAzimuthalEquidistant, geoConicConformal,
  geoConicEqualArea, geoConicEquidistant, geoEqualEarth, geoEquirectangular,
  geoGnomonic, geoMercator, geoNaturalEarth1, geoOrthographic, geoStereographic,
  geoTransverseMercator, type GeoProjection,
} from 'd3-geo'

type Factory = () => GeoProjection
const FACTORIES: Record<string, Factory> = {
  albers: geoAlbers,
  'albers-usa': geoAlbersUsa as unknown as Factory,
  albersUsa: geoAlbersUsa as unknown as Factory,
  azimuthalEqualArea: geoAzimuthalEqualArea,
  'azimuthal-equal-area': geoAzimuthalEqualArea,
  azimuthalEquidistant: geoAzimuthalEquidistant,
  'azimuthal-equidistant': geoAzimuthalEquidistant,
  conicConformal: geoConicConformal,
  'conic-conformal': geoConicConformal,
  conicEqualArea: geoConicEqualArea,
  'conic-equal-area': geoConicEqualArea,
  conicEquidistant: geoConicEquidistant,
  'conic-equidistant': geoConicEquidistant,
  equalEarth: geoEqualEarth,
  equirectangular: geoEquirectangular,
  gnomonic: geoGnomonic,
  mercator: geoMercator,
  naturalEarth1: geoNaturalEarth1,
  'natural-earth': geoNaturalEarth1,
  orthographic: geoOrthographic,
  stereographic: geoStereographic,
  transverseMercator: geoTransverseMercator,
  'transverse-mercator': geoTransverseMercator,
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
}

/**
 * Build a d3-geo projection from a compiled spec. Vega applies only the
 * parameters the spec provides — scale/translate/etc otherwise keep d3's own
 * per-type defaults (e.g. mercator translate [480, 250] regardless of chart
 * size; verified against the oracle on a 200x100 chart). When the type is
 * unknown we fall back to mercator (vega's default projection type).
 */
export function buildProjection(spec: ResolvedProjection, _width: number, _height: number): GeoProjection {
  const factory = FACTORIES[spec.type] ?? geoMercator
  const p = factory()
  if (spec.scale != null) p.scale(spec.scale)
  if (spec.translate != null) p.translate(spec.translate)
  if (spec.center) p.center(spec.center)
  if (spec.rotate) p.rotate(spec.rotate as [number, number, number])
  if (spec.precision != null) p.precision(spec.precision)
  if (spec.clipAngle != null) p.clipAngle(spec.clipAngle)
  if (spec.reflectX != null && 'reflectX' in p) (p as unknown as { reflectX(b: boolean): unknown }).reflectX(spec.reflectX)
  if (spec.reflectY != null && 'reflectY' in p) (p as unknown as { reflectY(b: boolean): unknown }).reflectY(spec.reflectY)
  return p
}

/** Render GeoJSON to an SVG path via a projection. Returns undefined for empty. */
export function projectedPath(projection: GeoProjection, geo: unknown): string | undefined {
  const g = geoPath(projection)
  const d = g(geo as never)
  return d ? d : undefined
}

export type { GeoProjection }
