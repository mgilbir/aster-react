/**
 * d3-contour (4.0.2): marching-squares isoline extraction with rings stitched
 * into polygons, as Vega's contour transform uses it. Faithful transcription
 * verified by a live differential against pinned d3-contour@4.0.2
 * (`conformance/scripts/differential-d3-geo.test.mts`).
 */
import { tickIncrement, ticks } from './arr.js'

export type ContourMultiPolygon = {
  type: 'MultiPolygon'
  value: number
  coordinates: number[][][][]
}

function ascendingNum(a: number, b: number): number {
  return a - b
}

function constantOf(x: unknown): () => unknown {
  return () => x
}

const slice = Array.prototype.slice

function extentFinite(values: number[]): [number | undefined, number | undefined] {
  let min: number | undefined
  let max: number | undefined
  for (const raw of values) {
    const value = isFinite(raw) ? raw : NaN
    if (value != null) {
      if (min === undefined) {
        if (value >= value) min = max = value
      } else {
        if (min > value) min = value
        if ((max as number) < value) max = value
      }
    }
  }
  return [min, max]
}

function countValid(values: number[]): number {
  let count = 0
  for (const raw of values) {
    if (raw != null && +(raw as number) >= +(raw as number)) ++count
  }
  return count
}

function thresholdSturges(values: number[]): number {
  return Math.max(1, Math.ceil(Math.log(countValid(values)) / Math.LN2) + 1)
}

function nice(start: number, stop: number, count: number): [number, number] {
  let prestep: number | undefined
  for (;;) {
    const step = tickIncrement(start, stop, count)
    if (step === prestep || step === 0 || !isFinite(step)) {
      return [start, stop]
    } else if (step > 0) {
      start = Math.floor(start / step) * step
      stop = Math.ceil(stop / step) * step
    } else if (step < 0) {
      start = Math.ceil(start * step) / step
      stop = Math.floor(stop * step) / step
    }
    prestep = step
  }
}

export default function contours(): any {
  let dx = 1
  let dy = 1
  let threshold: any = thresholdSturges
  let smooth: any = smoothLinear

  function contourValues(values: number[]): ContourMultiPolygon[] {
    let tz: any = threshold(values)
    // Convert number of thresholds into uniform thresholds.
    if (!Array.isArray(tz)) {
      const e = extentFinite(values)
      tz = ticks(...(nice(e[0]!, e[1]!, tz) as [number, number]), tz)
      while ((tz as number[])[tz.length - 1]! >= e[1]!) (tz as number[]).pop()
      while ((tz as number[])[1]! < e[0]!) (tz as number[]).shift()
    } else {
      tz = (tz as number[]).slice().sort(ascendingNum)
    }
    return (tz as number[]).map((value) => contour(values, value))
  }

  // Accumulate, smooth contour rings, assign holes to exterior rings.
  // Based on https://github.com/mbostock/shapefile/blob/v0.6.2/shp/polygon.js
  function contour(values: number[], value: number): ContourMultiPolygon {
    const v = value == null ? NaN : +value
    if (isNaN(v)) throw new Error(`invalid value: ${value}`)
    const polygons: number[][][][] = []
    const holes: number[][][] = []
    isorings(values, v, function (ring: any) {
      smooth(ring, values, v)
      if (area(ring) > 0) polygons.push([ring])
      else holes.push(ring)
    })
    holes.forEach(function (hole) {
      for (let i = 0, n = polygons.length; i < n; ++i) {
        if (contains(polygons[i]![0] as number[][], hole) !== -1) {
          polygons[i]!.push(hole)
          return
        }
      }
    })
    return {
      type: 'MultiPolygon',
      value,
      coordinates: polygons,
    }
  }

  // Marching squares with isolines stitched into rings.
  // Based on https://github.com/topojson/topojson-client/blob/v3.0.0/src/stitch.js
  function isorings(values: number[], value: number, callback: (ring: number[][]) => void): void {
    const fragmentByStart: any = []
    const fragmentByEnd: any = []
    let x: number, y: number, t0: any, t1: any, t2: any, t3: any
    // Special case for the first row (y = -1, t2 = t3 = 0).
    x = y = -1
    t1 = above(values[0], value)
    cases[t1 << 1].forEach(stitch as any)
    while (++x < dx - 1) {
      t0 = t1, (t1 = above(values[x + 1], value))
      cases[t0 | (t1 << 1)].forEach(stitch as any)
    }
    cases[t1 << 0].forEach(stitch as any)
    // General case for the intermediate rows.
    while (++y < dy - 1) {
      x = -1
      t1 = above(values[y * dx + dx], value)
      t2 = above(values[y * dx], value)
      cases[(t1 << 1) | (t2 << 2)].forEach(stitch as any)
      while (++x < dx - 1) {
        t0 = t1, (t1 = above(values[y * dx + dx + x + 1], value))
        t3 = t2, (t2 = above(values[y * dx + x + 1], value))
        cases[t0 | (t1 << 1) | (t2 << 2) | (t3 << 3)].forEach(stitch as any)
      }
      cases[t1 | (t2 << 3)].forEach(stitch as any)
    }
    // Special case for the last row (y = dy - 1, t0 = t1 = 0).
    x = -1
    t2 = values[y * dx]! >= value
    cases[t2 << 2].forEach(stitch as any)
    while (++x < dx - 1) {
      t3 = t2, (t2 = above(values[y * dx + x + 1], value))
      cases[(t2 << 2) | (t3 << 3)].forEach(stitch as any)
    }
    cases[t2 << 3].forEach(stitch as any)

    function stitch(line: number[][]): void {
      const start = [line[0]![0]! + x, line[0]![1]! + y]
      const end = [line[1]![0]! + x, line[1]![1]! + y]
      const startIndex = index(start)
      const endIndex = index(end)
      let f: any, g: any
      if ((f = fragmentByEnd[startIndex])) {
        if ((g = fragmentByStart[endIndex])) {
          delete fragmentByEnd[f.end]
          delete fragmentByStart[g.start]
          if (f === g) {
            f.ring.push(end)
            callback(f.ring)
          } else {
            fragmentByStart[f.start] = fragmentByEnd[g.end] = { start: f.start, end: g.end, ring: f.ring.concat(g.ring) }
          }
        } else {
          delete fragmentByEnd[f.end]
          f.ring.push(end)
          fragmentByEnd[(f.end = endIndex)] = f
        }
      } else if ((f = fragmentByStart[endIndex])) {
        if ((g = fragmentByEnd[startIndex])) {
          delete fragmentByStart[f.start]
          delete fragmentByEnd[g.end]
          if (f === g) {
            f.ring.push(end)
            callback(f.ring)
          } else {
            fragmentByStart[g.start] = fragmentByEnd[f.end] = { start: g.start, end: f.end, ring: g.ring.concat(f.ring) }
          }
        } else {
          delete fragmentByStart[f.start]
          f.ring.unshift(start)
          fragmentByStart[(f.start = startIndex)] = f
        }
      } else {
        fragmentByStart[startIndex] = fragmentByEnd[endIndex] = { start: startIndex, end: endIndex, ring: [start, end] }
      }
    }
  }

  function index(point: number[]): number {
    return point[0]! * 2 + point[1]! * (dx + 1) * 4
  }

  function smoothLinear(ring: number[][], values: number[], value: number): void {
    ring.forEach(function (point) {
      const x = point[0]!
      const y = point[1]!
      const xt = x | 0
      const yt = y | 0
      const v1 = valid(values[yt * dx + xt])
      if (x > 0 && x < dx && xt === x) {
        point[0] = smooth1(x, valid(values[yt * dx + xt - 1]), v1, value)
      }
      if (y > 0 && y < dy && yt === y) {
        point[1] = smooth1(y, valid(values[(yt - 1) * dx + xt]), v1, value)
      }
    })
  }

  contourValues.contour = contour
  contourValues.size = function (_: number[]): any {
    if (!arguments.length) return [dx, dy]
    const _0 = Math.floor(_[0]!)
    const _1 = Math.floor(_[1]!)
    if (!(_0 >= 0 && _1 >= 0)) throw new Error('invalid size')
    return (dx = _0), (dy = _1), contourValues
  }
  contourValues.thresholds = function (_: any): any {
    return arguments.length
      ? ((threshold = typeof _ === 'function' ? _ : Array.isArray(_) ? constantOf(slice.call(_)) : constantOf(_)), contourValues)
      : threshold
  }
  contourValues.smooth = function (_: boolean): any {
    return arguments.length ? ((smooth = _ ? smoothLinear : noopFn), contourValues) : smooth === smoothLinear
  }
  return contourValues
}

const cases: any = [
  [],
  [[[1.0, 1.5], [0.5, 1.0]]],
  [[[1.5, 1.0], [1.0, 1.5]]],
  [[[1.5, 1.0], [0.5, 1.0]]],
  [[[1.0, 0.5], [1.5, 1.0]]],
  [[[1.0, 1.5], [0.5, 1.0]], [[1.0, 0.5], [1.5, 1.0]]],
  [[[1.0, 0.5], [1.0, 1.5]]],
  [[[1.0, 0.5], [0.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 0.5]]],
  [[[1.0, 1.5], [1.0, 0.5]]],
  [[[0.5, 1.0], [1.0, 0.5]], [[1.5, 1.0], [1.0, 1.5]]],
  [[[1.5, 1.0], [1.0, 0.5]]],
  [[[0.5, 1.0], [1.5, 1.0]]],
  [[[1.0, 1.5], [1.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 1.5]]],
  [],
]

function noopFn(): void {}

// When computing the extent, ignore infinite values (as well as invalid ones).
// Is the (possibly invalid) x greater than or equal to the (known valid) value?
// Treat any invalid value as below negative infinity.
function above(x: unknown, value: number): boolean {
  return x == null ? false : +(x as number) >= value
}

// During smoothing, treat any invalid value as negative infinity.
function valid(v: unknown): number {
  return v == null || isNaN((v = +(v as number)) as number) ? -Infinity : (v as number)
}

function smooth1(x: number, v0: number, v1: number, value: number): number {
  const a = value - v0
  const b = v1 - v0
  const d = isFinite(a) || isFinite(b) ? a / b : Math.sign(a) / Math.sign(b)
  return isNaN(d) ? x : x + d - 0.5
}

// ---- area.js ----------------------------------------------------------------

export function area(ring: number[][]): number {
  let i = 0
  const n = ring.length
  let areaSum = ring[n - 1]![1]! * ring[0]![0]! - ring[n - 1]![0]! * ring[0]![1]!
  while (++i < n) areaSum += ring[i - 1]![1]! * ring[i]![0]! - ring[i - 1]![0]! * ring[i]![1]!
  return areaSum
}

// ---- contains.js ------------------------------------------------------------

export function contains(ring: number[][], hole: number[][]): number {
  let i = -1
  const n = hole.length
  let c: number
  while (++i < n) if ((c = ringContains(ring, hole[i]!))) return c
  return 0
}

function ringContains(ring: number[][], point: number[]): number {
  const x = point[0]!
  const y = point[1]!
  let containsV = -1
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const pi = ring[i]!
    const xi = pi[0]!
    const yi = pi[1]!
    const pj = ring[j]!
    const xj = pj[0]!
    const yj = pj[1]!
    if (segmentContains(pi, pj, point)) return 0
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) containsV = -containsV
  }
  return containsV
}

function segmentContains(a: number[], b: number[], c: number[]): boolean {
  let i: number
  return collinear(a, b, c) && within(a[(i = +(a[0]! === b[0]! ? 1 : 0))]!, c[i]!, b[i]!)
}

function collinear(a: number[], b: number[], c: number[]): boolean {
  return (b[0]! - a[0]!) * (c[1]! - a[1]!) === (c[0]! - a[0]!) * (b[1]! - a[1]!)
}

function within(p: number, q: number, r: number): boolean {
  return (p <= q && q <= r) || (r <= q && q <= p)
}
