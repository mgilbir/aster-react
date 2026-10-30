/**
 * Projecting rotated geometry events to the plane, with adaptive subdivision of line segments.
 *
 * A straight segment between two projected vertices is a poor stand-in for the great-circle arc they
 * join. Each segment is therefore split at its spherical midpoint, recursively, while the midpoint's
 * projection strays from the chord by more than the precision (or the arc spans a long angle, or the
 * midpoint is not near the middle of the chord), down to a bounded depth.
 */
import { Events, LINE_END, LINE_START, POINT, POLYGON_END, POLYGON_START } from './geo-events.js'
import { EPSILON, RADIANS, asinClamped } from './geo-sphere.js'

/** Maps radians (lambda, phi) to planar coordinates, writing them into `out`. */
export type PlanarMap = (lambda: number, phi: number, out: number[]) => void

const MAX_DEPTH = 16
const COS_MIN_ANGLE = Math.cos(30 * RADIANS)

/** Projects the vertices of one buffer, adding vertices to the segments between them. */
class Resampler {
  private readonly out: Events
  private readonly at = [0, 0]
  private src = 0
  // the previous vertex of the line being projected: where it landed and the unit vector of its position
  private hasPrevious = false
  private x0 = 0
  private y0 = 0
  private lambda0 = 0
  private a0 = 0
  private b0 = 0
  private c0 = 0
  // the first vertex of the ring being projected
  private hasFirst = false
  private x00 = 0
  private y00 = 0
  private lambda00 = 0
  private a00 = 0
  private b00 = 0
  private c00 = 0

  constructor(
    private readonly project: PlanarMap,
    private readonly delta2: number,
    expected: number,
  ) {
    this.out = Events.take(expected)
  }

  /**
   * Add the vertices that make the arc from (x0, y0) to (x1, y1) follow the sphere, not including the end.
   * Each end is its landing place, its longitude and the unit vector (a, b, c) of its position.
   */
  private refine(
    x0: number, y0: number, lambda0: number, a0: number, b0: number, c0: number,
    x1: number, y1: number, lambda1: number, a1: number, b1: number, c1: number,
    depth: number,
  ): void {
    const { delta2, at } = this
    const dx = x1 - x0
    const dy = y1 - y0
    const d2 = dx * dx + dy * dy
    if (d2 > 4 * delta2 && depth--) {
      let a = a0 + a1
      let b = b0 + b1
      let c = c0 + c1
      const m = Math.sqrt(a * a + b * b + c * c)
      const phi2 = asinClamped((c /= m))
      const lambda2 =
        Math.abs(Math.abs(c) - 1) < EPSILON || Math.abs(lambda0 - lambda1) < EPSILON
          ? (lambda0 + lambda1) / 2
          : Math.atan2(b, a)
      this.project(lambda2, phi2, at)
      const x2 = at[0]!
      const y2 = at[1]!
      const dx2 = x2 - x0
      const dy2 = y2 - y0
      const dz = dy * dx2 - dx * dy2
      if (
        (dz * dz) / d2 > delta2 || // the midpoint is far from the chord
        Math.abs((dx * dx2 + dy * dy2) / d2 - 0.5) > 0.3 || // it is near one end of the chord
        a0 * a1 + b0 * b1 + c0 * c1 < COS_MIN_ANGLE // the arc spans a wide angle
      ) {
        this.refine(x0, y0, lambda0, a0, b0, c0, x2, y2, lambda2, (a /= m), (b /= m), c, depth)
        this.out.point(x2, y2, this.src)
        this.refine(x2, y2, lambda2, a, b, c, x1, y1, lambda1, a1, b1, c1, depth)
      }
    }
  }

  /** The next vertex of a line: project it and refine the segment that leads to it. */
  private vertex(lambda: number, phi: number): void {
    const { at } = this
    const cosPhi = Math.cos(phi)
    const a = cosPhi * Math.cos(lambda)
    const b = cosPhi * Math.sin(lambda)
    const c = Math.sin(phi)
    this.project(lambda, phi, at)
    const x = at[0]!
    const y = at[1]!
    if (this.hasPrevious) this.refine(this.x0, this.y0, this.lambda0, this.a0, this.b0, this.c0, x, y, lambda, a, b, c, MAX_DEPTH)
    this.out.point(x, y, this.src)
    this.x0 = x
    this.y0 = y
    this.lambda0 = lambda
    this.a0 = a
    this.b0 = b
    this.c0 = c
    this.hasPrevious = true
  }

  run(ev: Events): Events {
    const { out, at } = this
    const subdivide = +this.delta2 !== 0
    let inPolygon = false
    let inLine = false
    for (let i = 0, n = ev.length; i < n; i++) {
      const src = (this.src = ev.src[i]!)
      switch (ev.op[i]!) {
        case POINT:
          if (subdivide && inLine) {
            const first = !this.hasPrevious
            this.vertex(ev.x[i]!, ev.y[i]!)
            if (first && inPolygon) {
              this.x00 = this.x0
              this.y00 = this.y0
              this.lambda00 = this.lambda0
              this.a00 = this.a0
              this.b00 = this.b0
              this.c00 = this.c0
              this.hasFirst = true
            }
          } else {
            this.project(ev.x[i]!, ev.y[i]!, at)
            out.point(at[0]!, at[1]!, src)
          }
          break
        case LINE_START:
          inLine = true
          this.hasPrevious = this.hasFirst = false
          out.mark(LINE_START, src)
          break
        case LINE_END:
          // a ring is closed by running its last vertex back to its first
          if (subdivide && inPolygon && this.hasPrevious && this.hasFirst) {
            this.refine(this.x0, this.y0, this.lambda0, this.a0, this.b0, this.c0, this.x00, this.y00, this.lambda00, this.a00, this.b00, this.c00, MAX_DEPTH)
          }
          inLine = false
          out.mark(LINE_END, src)
          break
        case POLYGON_START:
          inPolygon = true
          out.mark(POLYGON_START, src)
          break
        case POLYGON_END:
          inPolygon = false
          out.mark(POLYGON_END, src)
          break
        default:
          out.mark(ev.op[i]!, src)
      }
    }
    return out
  }
}

/**
 * Project events (rotated, radians) with `project`; line segments are subdivided to within `delta2`,
 * the squared precision (0 projects the vertices only).
 */
export function resample(ev: Events, project: PlanarMap, delta2: number): Events {
  // subdividing multiplies the vertices: room for a few times what comes in
  return new Resampler(project, delta2, ev.length * 3).run(ev)
}
