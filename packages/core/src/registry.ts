/**
 * Dependency-injection registry for optional, heavy capabilities.
 *
 * The core bundle (scales, marks, layout, expressions, transforms) must not
 * statically pull `d3-geo` / `d3-contour` — a line/bar chart has no business
 * paying for projection clipping code. Instead, an opt-in addon entry
 * (`@aster/core/geo`) imports the d3 modules and registers their entry points
 * here before the first render:
 *
 *   await import('@aster/core/geo')
 *
 * The core code paths consult the registry and throw an actionable error when a
 * spec uses geo/contour without the addon loaded.
 */

export interface ContourFeature {
  type: string
  value: number
  coordinates: unknown[]
}

export interface GeoRegistry {
  /** d3-geo projection builder (see geo.ts); null until the addon is loaded. */
  buildProjection: ((spec: unknown, width: number, height: number) => unknown) | null
  /** GeoJSON -> SVG path through a d3-geo projection; null until loaded. */
  projectedPath: ((projection: unknown, geo: unknown) => string | undefined) | null
  /** d3-contour marching squares over a raster grid; null until loaded. */
  contourRun: ((values: number[] | Float32Array, thresholds: number[], size: [number, number], smooth: boolean) => ContourFeature[]) | null
}

export const geoRegistry: GeoRegistry = {
  buildProjection: null,
  projectedPath: null,
  contourRun: null,
}

export function requireGeo(): NonNullable<GeoRegistry['buildProjection']> {
  if (!geoRegistry.buildProjection) throw new Error('[aster] this spec uses a geo projection; load the addon first: await import("@aster/core/geo")')
  return geoRegistry.buildProjection
}
