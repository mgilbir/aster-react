// A frozen copy of path-flatten.ts as it was on stack/3-expr, the base perf/geometry-once lands on: the behaviour the geometry
// differentials (geometry-differential.test.ts) compare the new code against. Test-only; not built, not shipped.
// Delete it with the differential once that guard is no longer wanted.
/**
 * SVG path data as polylines, and the non-zero point-in-path test over them (canvas `isPointInPath`): what the hit index and the
 * scene `intersect()` test items against. Curves and arcs are flattened to short segments.
 */
import { parsePathData, tracePath, type PathSink } from './legacy-path-data.testlib.js'

/**
 * Flattened outline: a flat [x0,y0,x1,y1,...] polyline, `closed` when it ended with a close. `curved[i]` is set when the segment
 * that ends at point i is a chord of a curve or an arc (it may lie off the true outline by the flattening tolerance), not a
 * straight segment of the path.
 */
export interface Poly { pts: number[]; closed: boolean; curved?: boolean[] }

/**
 * How far a flattened curve or arc may stray from the true one, in path units: the hit index tests a point against the painted
 * outline, so the flattening must not move an edge by a visible amount. A segment is cut into at most MAX_STEPS chords whatever
 * its size, so an enormous radius in an untrusted spec cannot make the outline unbounded.
 */
export const FLATTEN_TOLERANCE = 0.01
const TOLERANCE = FLATTEN_TOLERANCE
const MAX_STEPS = 1024
const steps = (n: number): number => (n >= 1 ? Math.min(MAX_STEPS, Math.ceil(n)) : 1)

/** Collects a path as polylines; curves and arcs are flattened to short segments. */
class Flattener implements PathSink {
  polys: Poly[] = []
  private cur: number[] | null = null
  private x = 0
  private y = 0
  private startX = 0
  private startY = 0
  constructor(private readonly t: (x: number, y: number) => [number, number]) {}
  private start(x: number, y: number): void {
    const [tx, ty] = this.t(x, y)
    this.cur = [tx, ty]
    this.polys.push({ pts: this.cur, closed: false })
    this.x = x; this.y = y; this.startX = x; this.startY = y
  }
  private push(x: number, y: number, curved = true): void {
    if (!this.cur) { this.start(x, y); return }
    const [tx, ty] = this.t(x, y)
    this.cur.push(tx, ty)
    if (curved) {
      const poly = this.polys[this.polys.length - 1]!
      ;(poly.curved ??= [])[this.cur.length / 2 - 1] = true
    }
    this.x = x; this.y = y
  }
  moveTo(x: number, y: number): void { this.start(x, y) }
  lineTo(x: number, y: number): void { this.push(x, y, false) }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y
    // a cubic's chords stray from it by at most 3/4 of its largest second difference over N^2
    const dd = Math.max(Math.hypot(x0 - 2 * c1x + c2x, y0 - 2 * c1y + c2y), Math.hypot(c1x - 2 * c2x + x, c1y - 2 * c2y + y))
    const N = steps(Math.sqrt((0.75 * dd) / TOLERANCE))
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t
      this.push(
        u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      )
    }
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y
    // ... and a quadratic's by a quarter of its second difference over N^2
    const N = steps(Math.sqrt(Math.hypot(x0 - 2 * cx + x, y0 - 2 * cy + y) / (4 * TOLERANCE)))
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t
      this.push(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
    }
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    let da = a1 - a0
    if (ccw) { if (da > 0) da = (da % (2 * Math.PI)) - 2 * Math.PI } else if (da < 0) da = (da % (2 * Math.PI)) + 2 * Math.PI
    if (Math.abs(da) > 2 * Math.PI) da = Math.sign(da) * 2 * Math.PI
    // a chord of angle `a` strays from the circle by r (1 - cos(a / 2))
    const r0 = Math.abs(r)
    const N = Math.max(4, steps(r0 > TOLERANCE ? Math.abs(da) / (2 * Math.acos(1 - TOLERANCE / r0)) : 1))
    // (the line to the arc's start is straight)
    this.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0), false)
    for (let i = 1; i <= N; i++) {
      const a = a0 + (da * i) / N
      this.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
    }
  }
  closePath(): void {
    if (!this.cur) return
    this.polys[this.polys.length - 1]!.closed = true
    // a new subpath after a close starts at the old start point
    this.cur = null
    this.x = this.startX; this.y = this.startY
  }
}

/** Flatten SVG path data under `t` (local -> scene). */
export function flattenPath(d: string, t: (x: number, y: number) => [number, number]): Poly[] {
  const f = new Flattener(t)
  tracePath(f, parsePathData(d))
  return f.polys
}

/** Non-zero winding number of (x, y) over every polygon, each implicitly closed (canvas `fill()`). */
export function insidePolys(polys: Poly[], x: number, y: number): boolean {
  let wn = 0
  for (const { pts } of polys) {
    const n = pts.length / 2
    if (n < 3) continue
    let ax = pts[2 * n - 2]!
    let ay = pts[2 * n - 1]!
    for (let i = 0; i < n; i++) {
      const bx = pts[2 * i]!
      const by = pts[2 * i + 1]!
      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wn++
      } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) wn--
      ax = bx; ay = by
    }
  }
  return wn !== 0
}

