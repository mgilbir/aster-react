/**
 * Cartographic projections for geo marks, built on the owned d3-geo port (the
 * same library vega uses). A projection turns lon/lat geometry into pixel
 * coordinates; the geoshape transform / shape marks then render it to an SVG
 * path.
 */
import {
  geoPath, albers as geoAlbers, albersUsa as geoAlbersUsa,
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
