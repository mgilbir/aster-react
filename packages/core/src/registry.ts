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
  projectedPath: ((projection: unknown, geo: unknown, pointRadius?: unknown) => string) | null
  /** The unrounded bounds [x1, y1, x2, y2] of a projected shape (what vega's bound pass sees); null until loaded. */
  projectedBounds: ((projection: unknown, geo: unknown, pointRadius?: unknown) => [number, number, number, number] | null) | null
  /** vega-projection's `defaultPath`: d3's geoPath with no projection (a `geopath` that names none draws raw coordinates). */
  defaultPath: (() => unknown) | null
  /** d3-contour marching squares over a raster grid; null until loaded. */
  contourRun: ((values: number[] | Float32Array, thresholds: number[], size: [number, number], smooth: boolean) => ContourFeature[]) | null
}

export const geoRegistry: GeoRegistry = {
  buildProjection: null,
  projectedPath: null,
  projectedBounds: null,
  defaultPath: null,
  contourRun: null,
}

/**
 * How to get the unrounded bounds [x1, y1, x2, y2] of the path a `geoshape` transform wrote on a row (see
 * `projectedBounds`). A thunk: a chart that never measures its marks (`autosize: none`) never pays for it.
 */
export const SHAPE_BOUNDS = new WeakMap<object, () => [number, number, number, number] | null>()

export function requireGeo(): NonNullable<GeoRegistry['buildProjection']> {
  if (!geoRegistry.buildProjection) throw new Error('[aster] this spec uses a geo projection; load the addon first: await import("@aster/core/geo")')
  return geoRegistry.buildProjection
}

/** eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry avoids an import cycle with transform.ts */
export type TransformFn = (rows: any[], params: Record<string, unknown>, ctx: any, sourceName?: string) => any[]

/**
 * Registry for the rare-layout transforms (kde/quantile/regression/loess,
 * pack/partition/treemap, wordcloud, voronoi). The core bundle keeps only the
 * transforms a plain chart uses; the opt-in addon entry (`@aster/core/transforms`)
 * registers the rest:
 *
 *   await import('@aster/core/transforms')
 */
export const transformRegistry = new Map<string, TransformFn>()

export function requireTransform(type: string): TransformFn {
  const fn = transformRegistry.get(type)
  if (!fn) throw new Error(`[aster] this spec uses the "${type}" transform; load the addon first: await import("@aster/core/transforms")`)
  return fn
}

export type DataFormatReader = (data: unknown, format: Record<string, unknown>) => Record<string, unknown>[]

/**
 * Registry for text-format data readers (csv/tsv/dsv/topojson). The core
 * ships the JSON reader and the `format.parse` type coercion; text formats
 * and URL fetching are registered by the `@aster/core/load` addon.
 */
export const dataFormatRegistry = new Map<string, DataFormatReader>()

export function requireDataFormat(type: string): DataFormatReader {
  const reader = dataFormatRegistry.get(type)
  if (!reader) throw new Error(`[aster] this spec reads "${type}" data; load the addon first: await import("@aster/core/load")`)
  return reader
}
