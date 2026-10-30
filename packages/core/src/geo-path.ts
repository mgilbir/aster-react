/**
 * Output of planar geometry events: an SVG path string, a drawing-context trace, and the planar
 * measures of a path (area, bounds, centroid, length).
 *
 * Each output is a small accumulator that is handed the planar events of one geometry after another and
 * then asked for its result. The arithmetic keeps the order of the reference d3-geo implementation
 * (compensated sums, terms added in event order) because path strings and measures are compared bit for bit.
 */
import { Adder } from './arr.js'
import {
  Events, LINE_END, LINE_START, POINT, POLYGON_END, POLYGON_START, SPHERE, forEachChunk,
} from './geo-events.js'

/** What a geometry pipeline offers a path: its planar events for a spherical input. */
export interface PlanarSource {
  /** The planar events of `ev`, a buffer of spherical events (degrees) that the call takes over (and may return). */
  planar(ev: Events): Events
}

/** Receives planar events, one geometry's worth at a time. */
export interface PlanarSink {
  add(ev: Events): void
}

/** A radius for the circles that draw points: a number, or a function of the GeoJSON object being drawn. */
export type PointRadius = number | ((object: unknown) => number)

const unsupportedSphere = (): never => {
  throw new TypeError('stream.sphere is not a function')
}

/** `digits` after validation: the number of decimals to round to, or null for none. */
function decimals(digits: number | null): number | null {
  if (digits == null) return null
  const d = Math.floor(digits)
  if (!(d >= 0)) throw new RangeError(`invalid digits: ${digits}`)
  return d > 15 ? null : d
}

/** `v` rounded to the scale `k` (a power of ten), or untouched when `k` is 0. */
const rounded = (v: number, k: number): number => (k ? Math.round(v * k) / k : v)

/** The circle that draws a point of radius `r`, relative to the point (unchanged between points, so remembered). */
let circleKey: [number, number] | null = null
let circleText = ''
function circle(radius: number, k: number): string {
  if (!circleKey || circleKey[0] !== radius || circleKey[1] !== k) {
    const r = rounded(radius, k)
    circleText = `m0,${r}a${r},${r} 0 1,1 0,${rounded(-2 * radius, k)}a${r},${r} 0 1,1 0,${rounded(2 * radius, k)}z`
    circleKey = [radius, k]
  }
  return circleText
}

/** The SVG path of the events: `M`/`L` through the vertices of a line, `Z` for a ring, a circle for a lone point. */
export class PathWriter implements PlanarSink {
  private s = ''
  private readonly k: number
  private inPolygon = false
  private vertex = NaN // 0 before the first vertex of a line, 1 after it, NaN outside a line

  constructor(
    digits: number | null,
    private readonly radius: number,
  ) {
    const d = decimals(digits)
    this.k = d === null ? 0 : 10 ** d
  }

  add(ev: Events): void {
    const { k, radius } = this
    let s = this.s
    let inPolygon = this.inPolygon
    let vertex = this.vertex
    for (let i = 0, n = ev.length; i < n; i++) {
      switch (ev.op[i]) {
        case POLYGON_START:
          inPolygon = true
          break
        case POLYGON_END:
          inPolygon = false
          break
        case LINE_START:
          vertex = 0
          break
        case LINE_END:
          if (inPolygon) s += 'Z'
          vertex = NaN
          break
        case POINT: {
          let x = ev.x[i]!
          let y = ev.y[i]!
          if (k) {
            x = Math.round(x * k) / k
            y = Math.round(y * k) / k
          }
          if (vertex === 0) {
            s += `M${x},${y}`
            vertex = 1
          } else if (vertex === 1) s += `L${x},${y}`
          else s += `M${x},${y}${circle(radius, k)}`
          break
        }
        case SPHERE:
          this.s = s
          unsupportedSphere()
      }
    }
    this.s = s
    this.inPolygon = inPolygon
    this.vertex = vertex
  }

  /** The path, or null when nothing was drawn. */
  result(): string | null {
    return this.s.length ? this.s : null
  }
}

/**
 * The box of what the events draw, as a bounding context sees it: the vertices of lines, and for a lone point the
 * circle that draws it. Every vertex is mapped through an identity transform, `1*x + 0*y`, which turns a coordinate
 * at infinity into NaN (and NaN extends nothing): a clip that degenerates emits such coordinates.
 */
export class ShapeBounds implements PlanarSink {
  private x1 = +Number.MAX_VALUE
  private y1 = +Number.MAX_VALUE
  private x2 = -Number.MAX_VALUE
  private y2 = -Number.MAX_VALUE
  private atLine = false

  constructor(private readonly radius: number) {}

  private extend(x: number, y: number): void {
    if (x < this.x1) this.x1 = x
    if (x > this.x2) this.x2 = x
    if (y < this.y1) this.y1 = y
    if (y > this.y2) this.y2 = y
  }

  private vertex(px: number, py: number): void {
    this.extend(1 * px + 0 * py, 0 * px + 1 * py)
  }

  add(ev: Events): void {
    const { radius } = this
    for (let i = 0; i < ev.length; i++) {
      switch (ev.op[i]) {
        case LINE_START:
          this.atLine = true
          break
        case LINE_END:
          this.atLine = false
          break
        case POINT: {
          const x = ev.x[i]!
          const y = ev.y[i]!
          if (this.atLine) this.vertex(x, y)
          else {
            this.vertex(x + radius, y)
            this.extend(x - radius, y - radius)
            this.extend(x + radius, y + radius)
          }
          break
        }
        case SPHERE:
          unsupportedSphere()
      }
    }
  }

  /** `[x1, y1, x2, y2]`, or null when nothing was drawn. */
  result(): [number, number, number, number] | null {
    return this.x1 === +Number.MAX_VALUE ? null : [this.x1, this.y1, this.x2, this.y2]
  }
}

/** Hands the same events to several sinks. */
export class Tee implements PlanarSink {
  private readonly sinks: PlanarSink[]
  constructor(...sinks: PlanarSink[]) {
    this.sinks = sinks
  }
  add(ev: Events): void {
    for (const sink of this.sinks) sink.add(ev)
  }
}

/** Area of the polygons (rings counted with their orientation, holes subtract), halved. */
export class AreaSum implements PlanarSink {
  private readonly total = new Adder()
  private ring = new Adder()
  private inPolygon = false
  private first = false
  private x00 = NaN
  private y00 = NaN
  private x0 = NaN
  private y0 = NaN

  private edge(x: number, y: number): void {
    this.ring.add(this.y0 * x - this.x0 * y)
    this.x0 = x
    this.y0 = y
  }

  add(ev: Events): void {
    for (let i = 0; i < ev.length; i++) {
      switch (ev.op[i]) {
        case POLYGON_START:
          this.inPolygon = true
          break
        case POLYGON_END:
          this.inPolygon = false
          this.total.add(Math.abs(+this.ring))
          this.ring = new Adder()
          break
        case LINE_START:
          this.first = true
          break
        case POINT:
          if (!this.inPolygon) break
          if (this.first) {
            this.first = false
            this.x00 = this.x0 = ev.x[i]!
            this.y00 = this.y0 = ev.y[i]!
          } else this.edge(ev.x[i]!, ev.y[i]!)
          break
        case LINE_END:
          if (this.inPolygon && !this.first) this.edge(this.x00, this.y00)
          break
        case SPHERE:
          unsupportedSphere()
      }
    }
  }

  result(): number {
    return this.total.valueOf() / 2
  }
}

/** `[[x0, y0], [x1, y1]]` of every vertex (Infinity and -Infinity when there are none). */
export class BoundsBox implements PlanarSink {
  private x0 = Infinity
  private y0 = Infinity
  private x1 = -Infinity
  private y1 = -Infinity

  add(ev: Events): void {
    let { x0, y0, x1, y1 } = this
    for (let i = 0, n = ev.length; i < n; i++) {
      if (ev.op[i] === POINT) {
        const x = ev.x[i]!
        const y = ev.y[i]!
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      } else if (ev.op[i] === SPHERE) unsupportedSphere()
    }
    this.x0 = x0
    this.y0 = y0
    this.x1 = x1
    this.y1 = y1
  }

  result(): number[][] {
    return [[this.x0, this.y0], [this.x1, this.y1]]
  }
}

/**
 * The centroid of the planar geometry: of the polygons by area, else of the lines by length, else of
 * the points; [NaN, NaN] for empty geometry.
 */
export class CentroidSum implements PlanarSink {
  private x0Sum = 0
  private y0Sum = 0
  private w0 = 0 // points
  private x1Sum = 0
  private y1Sum = 0
  private w1 = 0 // line segments
  private x2Sum = 0
  private y2Sum = 0
  private w2 = 0 // polygon rings
  private inPolygon = false
  private atLine = false
  private vertex = 0 // 0: the first vertex of the line or ring is next, 1: later vertices
  private x00 = NaN
  private y00 = NaN
  private x0 = NaN
  private y0 = NaN

  private addPoint(x: number, y: number): void {
    this.x0Sum += x
    this.y0Sum += y
    ++this.w0
  }

  private segment(x: number, y: number): void {
    const dx = x - this.x0
    const dy = y - this.y0
    const z = Math.sqrt(dx * dx + dy * dy)
    this.x1Sum += (z * (this.x0 + x)) / 2
    this.y1Sum += (z * (this.y0 + y)) / 2
    this.w1 += z
  }

  private ringEdge(x: number, y: number): void {
    this.segment(x, y)
    const z = this.y0 * x - this.x0 * y
    this.x2Sum += z * (this.x0 + x)
    this.y2Sum += z * (this.y0 + y)
    this.w2 += z * 3
    this.addPoint((this.x0 = x), (this.y0 = y))
  }

  add(ev: Events): void {
    for (let i = 0; i < ev.length; i++) {
      switch (ev.op[i]) {
        case POLYGON_START:
          this.inPolygon = true
          break
        case POLYGON_END:
          this.inPolygon = false
          break
        case LINE_START:
          this.atLine = true
          this.vertex = 0
          break
        case LINE_END:
          if (this.inPolygon && this.vertex === 1) this.ringEdge(this.x00, this.y00)
          this.atLine = false
          break
        case POINT: {
          const x = ev.x[i]!
          const y = ev.y[i]!
          if (!this.atLine) this.addPoint(x, y)
          else if (this.vertex === 0) {
            this.vertex = 1
            if (this.inPolygon) this.addPoint((this.x00 = this.x0 = x), (this.y00 = this.y0 = y))
            else this.addPoint((this.x0 = x), (this.y0 = y))
          } else if (this.inPolygon) this.ringEdge(x, y)
          else {
            this.segment(x, y)
            this.addPoint((this.x0 = x), (this.y0 = y))
          }
          break
        }
        case SPHERE:
          unsupportedSphere()
      }
    }
  }

  result(): [number, number] {
    const { w0, w1, w2 } = this
    return w2
      ? [this.x2Sum / w2, this.y2Sum / w2]
      : w1
        ? [this.x1Sum / w1, this.y1Sum / w1]
        : w0
          ? [this.x0Sum / w0, this.y0Sum / w0]
          : [NaN, NaN]
  }
}

/** Total length of the lines and the perimeters of the polygon rings. */
export class LengthSum implements PlanarSink {
  private readonly sum = new Adder()
  private inPolygon = false
  private first = false
  private atLine = false
  private x00 = NaN
  private y00 = NaN
  private x0 = NaN
  private y0 = NaN

  private step(x: number, y: number): void {
    this.x0 -= x
    this.y0 -= y
    this.sum.add(Math.sqrt(this.x0 * this.x0 + this.y0 * this.y0))
    this.x0 = x
    this.y0 = y
  }

  add(ev: Events): void {
    for (let i = 0; i < ev.length; i++) {
      switch (ev.op[i]) {
        case POLYGON_START:
          this.inPolygon = true
          break
        case POLYGON_END:
          this.inPolygon = false
          break
        case LINE_START:
          this.atLine = true
          this.first = true
          break
        case POINT:
          if (!this.atLine) break
          if (this.first) {
            this.first = false
            this.x00 = this.x0 = ev.x[i]!
            this.y00 = this.y0 = ev.y[i]!
          } else this.step(ev.x[i]!, ev.y[i]!)
          break
        case LINE_END:
          if (this.inPolygon && !this.first) this.step(this.x00, this.y00)
          this.atLine = false
          break
        case SPHERE:
          unsupportedSphere()
      }
    }
  }

  result(): number {
    return +this.sum
  }
}

/**
 * Draws and measures GeoJSON through a projection (or, with none, in the plane as given).
 * `pointRadius` and `digits` are the settings of the path string.
 *
 * A GeoJSON object is run through the projection one geometry at a time (a FeatureCollection feature by
 * feature): the results are the same as for the whole object at once, without holding every stage's output
 * for the whole object in memory.
 */
export class GeoPath {
  pointRadius: PointRadius = 4.5
  digits: number | null = 3

  constructor(readonly projection: PlanarSource | null = null) {}

  private sink: PlanarSink | null = null
  // one visitor for the life of the path, so that drawing a geometry allocates no closure
  private readonly visit = (ev: Events): void => {
    const planar = this.projection ? this.projection.planar(ev) : ev
    this.sink!.add(planar)
    planar.release()
  }

  /** Hand the planar events of each geometry of `object` to `sink`. */
  feed(object: unknown, sink: PlanarSink): void {
    this.sink = sink
    forEachChunk(object, this.visit)
    this.sink = null
  }

  /** The radius that draws the points of `object`: a function radius is asked about the object. */
  radiusFor(object: unknown, radius: PointRadius = this.pointRadius): number {
    return typeof radius === 'function' ? +radius(object) : +radius
  }

  /** The SVG path of `object`, or null if nothing of it is drawn. `radius` overrides the path's own. */
  draw(object: unknown, radius: PointRadius = this.pointRadius): string | null {
    if (!object) return null
    const writer = new PathWriter(this.digits, this.radiusFor(object, radius))
    this.feed(object, writer)
    return writer.result()
  }

  area(object: unknown): number {
    const sum = new AreaSum()
    this.feed(object, sum)
    return sum.result()
  }

  bounds(object: unknown): number[][] {
    const box = new BoundsBox()
    this.feed(object, box)
    return box.result()
  }

  centroid(object: unknown): [number, number] {
    const sum = new CentroidSum()
    this.feed(object, sum)
    return sum.result()
  }

  measure(object: unknown): number {
    const sum = new LengthSum()
    this.feed(object, sum)
    return sum.result()
  }
}
