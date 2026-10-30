/**
 * Raster grids as the transforms share them: the density estimate behind `kde2d` and the point-data mode of
 * `contour`, and the placement of contour polygons into view pixels. Points are counted into cells, the counts are
 * smoothed by a box blur applied three times per blurred axis (which approximates a Gaussian), and the result is
 * scaled to a density.
 *
 * What the output pins (and so what is not free to change):
 *  - the cell of a point is `ox + (x >> k)`, `oy + (y >> k)` (an int32 shift, so fractions truncate toward zero
 *    for the shift and out-of-range points are dropped);
 *  - a box of radius r is a running sum divided by the number of cells it covers, in double precision, stored into a
 *    Float32Array after every pass; the passes alternate x, y, x, y, x, y (or x, x, x / y, y, y when one axis has no
 *    blur), because Float32 rounding after each pass is part of the values;
 *  - the weight accessor is called once per in-range point, in input order (an expression may draw random numbers);
 *  - the density scale is 2^-2k for counts, else 1 over the sum of the cells.
 * Everything else here (the generic line blur, the ping-pong buffers, the lazy second buffer) is this module's own.
 * The estimate follows vega-geo's density2D (BSD-3-Clause), itself adapted from d3-contour; both stay in
 * THIRD_PARTY_NOTICES.md.
 */
import { meterRows } from './limits.js'
import { quartiles } from './transform-agg.js'

/** A raster of `width` x `height` cells, row-major; `[x1, x2) x [y1, y2)` is the part inside the blur padding. */
export interface RasterGrid {
  values: Float32Array
  /** Pixels per cell edge: `1 << k`. */
  scale: number
  width: number
  height: number
  x1: number
  y1: number
  x2: number
  y2: number
  translate?: number[]
}

/** Sample standard deviation of the entries that are numbers once coerced (null and NaN skipped, '' counting as 0); undefined when there are fewer than two (Welford's update). */
function sampleDeviation(sample: ArrayLike<unknown>): number | undefined {
  let count = 0
  let mean = 0
  let m2 = 0
  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i]
    if (entry == null) continue
    const value = +(entry as number)
    if (!(value >= value)) continue
    const delta = value - mean
    mean += delta / ++count
    m2 += delta * (value - mean)
  }
  const variance = count > 1 ? m2 / (count - 1) : undefined
  return variance ? Math.sqrt(variance) : variance
}

/**
 * Silverman's rule-of-thumb bandwidth, 1.06 * min(sd, IQR / 1.34) * n^-0.2, with the fallbacks sd, |Q1|, 1 when the
 * spread is zero or undefined. `n` counts every entry of the sample as it was read, missing ones included. The two
 * spread statistics read the sample differently, and so a '' contributes to one and not the other: the deviation
 * takes anything that coerces to a number (null skipped), the quartiles take only non-empty, non-null ones.
 */
export function silvermanBandwidth(sample: ArrayLike<unknown>): number {
  const sd = sampleDeviation(sample)
  const [q1, , q3] = quartiles(sample)
  const spread = sd === undefined || q1 === undefined || q3 === undefined ? NaN : Math.min(sd, (q3 - q1) / 1.34)
  return 1.06 * (spread || sd || Math.abs(q1 ?? NaN) || 1) * Math.pow(sample.length, -0.2)
}

/** The blur radius, in pixels, of a bandwidth (negative or NaN: estimated from the sample). */
export function blurRadius(bandwidth: number, sample: ArrayLike<unknown>): number {
  const h = bandwidth >= 0 ? bandwidth : silvermanBandwidth(sample)
  return Math.round((Math.sqrt(4 * h * h + 1) - 1) / 2)
}

/**
 * One box blur of radius `r` along every line of a grid: `lines` lines of `length` cells, the cell `i` of line `j`
 * at `j * lineStep + i * step`. The window shrinks at both ends, so each output is the mean of the cells it covers.
 */
function boxBlur(from: Float32Array, to: Float32Array, lines: number, length: number, step: number, lineStep: number, r: number): void {
  const w = 2 * r + 1
  for (let j = 0; j < lines; ++j) {
    const base = j * lineStep
    for (let i = 0, run = 0; i < length + r; ++i) {
      if (i < length) run += from[base + i * step]!
      if (i >= r) {
        if (i >= w) run -= from[base + (i - w) * step]!
        to[base + (i - r) * step] = run / Math.min(i + 1, length - 1 + w - i, w)
      }
    }
  }
}

export interface DensityRequest {
  /**
   * The points' pixel coordinates as the data holds them. A point is placed at the number its coordinate coerces to
   * (null is 0, NaN falls outside the grid); an estimated bandwidth reads them uncoerced, where a null is no sample.
   */
  xs: ArrayLike<unknown>
  ys: ArrayLike<unknown>
  /** The weight of point `i`; called only for points inside the grid. */
  weightAt: (i: number) => number
  /** The view size in pixels. */
  size: readonly [number, number]
  /** log2 of the cell size. */
  k: number
  /** Bandwidth per axis in pixels; negative means "estimate from the data". */
  bandwidth: readonly [number, number]
  /** True: points per square pixel. False: a probability density (the cells sum to one). */
  counts: boolean
  /** What the row meter calls the grid in its error. */
  label: string
}

export function densityGrid(req: DensityRequest): RasterGrid {
  const { xs, ys, weightAt, k } = req
  const [width, height] = req.size
  const rx = blurRadius(req.bandwidth[0], xs) >> k
  const ry = blurRadius(req.bandwidth[1], ys) >> k
  const ox = rx ? rx + 2 : 0
  const oy = ry ? ry + 2 : 0
  const n = 2 * ox + (width >> k)
  const m = 2 * oy + (height >> k)
  // The grid is sized by spec parameters (size, bandwidth radius): bound the cell count before allocating it.
  meterRows(n * m, req.label)

  let values = new Float32Array(n * m)
  for (let i = 0; i < xs.length; i++) {
    const xi = ox + (+(xs[i] as number) >> k)
    const yi = oy + (+(ys[i] as number) >> k)
    if (xi >= 0 && xi < n && yi >= 0 && yi < m) values[xi + yi * n]! += weightAt(i)
  }

  const alongX = rx > 0
  const alongY = ry > 0
  if (alongX || alongY) {
    let other = new Float32Array(n * m)
    const pass = (x: boolean): void => {
      if (x) boxBlur(values, other, m, n, 1, n, rx)
      else boxBlur(values, other, n, m, n, 1, ry)
      ;[values, other] = [other, values]
    }
    for (let round = 0; round < 3; round++) {
      if (alongX) pass(true)
      if (alongY) pass(false)
    }
  }

  let sum = 0
  if (!req.counts) {
    for (let i = 0; i < values.length; ++i) { const v = values[i]!; if (v != null && !isNaN(v)) sum += v }
  }
  const scale = req.counts ? Math.pow(2, -2 * k) : 1 / sum
  for (let i = 0; i < values.length; ++i) values[i]! *= scale

  return { values, scale: 1 << k, width: n, height: m, x1: ox, y1: oy, x2: ox + (width >> k), y2: oy + (height >> k) }
}

/**
 * Maps contour polygons from grid cells to view pixels in place: (p - origin) * scale, then + translate when one is
 * given. A negative-area scale (one axis flipped) reverses every ring so the winding order survives.
 */
export function placeContours(
  shapes: ReadonlyArray<{ coordinates: unknown }>,
  origin: readonly [number, number],
  scale: readonly [number, number],
  translate?: readonly [number, number],
): void {
  const flip = scale[0] * scale[1] < 0
  for (const shape of shapes) {
    for (const polygon of shape.coordinates as number[][][][]) {
      for (const ring of polygon) {
        if (flip) ring.reverse()
        for (const p of ring) {
          p[0] = translate ? (p[0]! - origin[0]) * scale[0] + translate[0] : (p[0]! - origin[0]) * scale[0]
          p[1] = translate ? (p[1]! - origin[1]) * scale[1] + translate[1] : (p[1]! - origin[1]) * scale[1]
        }
      }
    }
  }
}
