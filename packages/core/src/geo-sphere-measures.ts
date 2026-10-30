/**
 * Measures of GeoJSON on the sphere: area (steradians), bounding box and centroid (degrees).
 *
 * Each is a fold over the geometry's event buffer. Coordinates are degrees. The arithmetic is the
 * arithmetic of the reference d3-geo implementation (the sums are exact-compensated `Adder`s and the
 * trigonometric terms are evaluated in a fixed order), because the results are compared bit for bit.
 */
import { Adder } from './arr.js'
import { Events, LINE_END, LINE_START, POINT, POLYGON_END, POLYGON_START, SPHERE, eventsOf } from './geo-events.js'
import {
  DEGREES, EPSILON, EPSILON2, QUARTER_PI, RADIANS, TAU, type Vec3, asinClamped, cross, lonLat, normalize, unitVector,
} from './geo-sphere.js'

/**
 * The signed area swept by one polygon's rings: each ring is a sum of spherical excesses of the triangles
 * (south pole, previous vertex, vertex), and the rings of one polygon share a single sum so that holes subtract.
 */
class RingArea {
  sum = new Adder()
  private lambda00 = NaN
  private phi00 = NaN
  private lambda0 = NaN
  private cosPhi0 = NaN
  private sinPhi0 = NaN
  private first = true

  begin(): void {
    this.sum = new Adder()
  }

  start(): void {
    this.first = true
  }

  point(lambda: number, phi: number): void {
    if (this.first) {
      this.first = false
      this.lambda00 = lambda
      this.phi00 = phi
      this.lambda0 = lambda * RADIANS
      const half = (phi * RADIANS) / 2 + QUARTER_PI
      this.cosPhi0 = Math.cos(half)
      this.sinPhi0 = Math.sin(half)
    } else this.addVertex(lambda, phi)
  }

  /** The ring is closed by returning to its first vertex (a ring with no vertex has no area). */
  end(): void {
    if (!this.first) this.addVertex(this.lambda00, this.phi00)
  }

  private addVertex(lambdaDegrees: number, phiDegrees: number): void {
    const lambda = lambdaDegrees * RADIANS
    const phi = (phiDegrees * RADIANS) / 2 + QUARTER_PI // the colatitude from the south pole, halved
    // the signed spherical excess of the triangle (south pole, previous vertex, this vertex)
    const dLambda = lambda - this.lambda0
    const direction = dLambda >= 0 ? 1 : -1
    const absDLambda = direction * dLambda
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)
    const k = this.sinPhi0 * sinPhi
    const u = this.cosPhi0 * cosPhi + k * Math.cos(absDLambda)
    const v = k * direction * Math.sin(absDLambda)
    this.sum.add(Math.atan2(v, u))
    this.lambda0 = lambda
    this.cosPhi0 = cosPhi
    this.sinPhi0 = sinPhi
  }
}

/** Area on the unit sphere, in steradians: the sphere is 4 pi. */
export function sphereArea(object: unknown): number {
  return areaOf(eventsOf(object))
}

export function areaOf(ev: Events): number {
  const total = new Adder()
  const ring = new RingArea()
  let inPolygon = false
  for (let i = 0; i < ev.length; i++) {
    switch (ev.op[i]!) {
      case SPHERE:
        total.add(TAU)
        break
      case POLYGON_START:
        inPolygon = true
        ring.begin()
        break
      case POLYGON_END: {
        inPolygon = false
        const area = +ring.sum
        total.add(area < 0 ? TAU + area : area)
        break
      }
      case LINE_START:
        if (inPolygon) ring.start()
        break
      case POINT:
        if (inPolygon) ring.point(ev.x[i]!, ev.y[i]!)
        break
      case LINE_END:
        if (inPolygon) ring.end()
        break
    }
  }
  return total.valueOf() * 2
}

/* ---- bounding box ------------------------------------------------------------------------------ */

/** The left-right distance between two longitudes, going east from the first. */
const eastwardSpan = (from: number, to: number): number => ((to -= from) < 0 ? to + 360 : to)

type Range = [number, number]

const rangeContains = (range: Range, x: number): boolean =>
  range[0] <= range[1] ? range[0] <= x && x <= range[1] : x < range[0] || range[1] < x

/**
 * The longitude/latitude box of a GeoJSON object, `[[west, south], [east, north]]` in degrees (the west
 * edge can exceed the east edge when the box crosses the antimeridian), or NaNs for an empty object.
 */
export function sphereBounds(object: unknown): number[][] {
  const ev = eventsOf(object)
  let lambda0 = Infinity
  let phi0 = Infinity
  let lambda1 = -Infinity
  let phi1 = -Infinity
  const ranges: Range[] = []
  let range: Range | null = null
  let previous: Vec3 | null = null
  let lambda2 = NaN // longitude of the previous vertex of the line
  let lambda00 = NaN
  let phi00 = NaN
  let deltaSum = new Adder()
  const ringArea = new RingArea()
  let inPolygon = false
  let inLine = false

  const widenLatitude = (phi: number): void => {
    if (phi < phi0) phi0 = phi
    if (phi > phi1) phi1 = phi
  }

  // one vertex of a line or ring
  const linePoint = (lambda: number, phi: number): void => {
    const p = unitVector(lambda * RADIANS, phi * RADIANS)
    if (previous) {
      const normal = cross(previous, p)
      const equatorial: Vec3 = [normal[1], -normal[0], 0]
      let inflection = cross(equatorial, normal)
      normalize(inflection)
      const turning = lonLat(inflection)
      const delta = lambda - lambda2
      const direction = delta > 0 ? 1 : -1
      let lambdaI = turning[0] * DEGREES * direction
      const antimeridian = Math.abs(delta) > 180
      if (antimeridian !== (direction * lambda2 < lambdaI && lambdaI < direction * lambda)) {
        const phiI = turning[1] * DEGREES
        if (phiI > phi1) phi1 = phiI
      } else if (((lambdaI = ((lambdaI + 360) % 360) - 180), antimeridian !== (direction * lambda2 < lambdaI && lambdaI < direction * lambda))) {
        const phiI = -turning[1] * DEGREES
        if (phiI < phi0) phi0 = phiI
      } else {
        widenLatitude(phi)
      }
      if (antimeridian) {
        if (lambda < lambda2) {
          if (eastwardSpan(lambda0, lambda) > eastwardSpan(lambda0, lambda1)) lambda1 = lambda
        } else if (eastwardSpan(lambda, lambda1) > eastwardSpan(lambda0, lambda1)) lambda0 = lambda
      } else if (lambda1 >= lambda0) {
        if (lambda < lambda0) lambda0 = lambda
        if (lambda > lambda1) lambda1 = lambda
      } else if (lambda > lambda2) {
        if (eastwardSpan(lambda0, lambda) > eastwardSpan(lambda0, lambda1)) lambda1 = lambda
      } else if (eastwardSpan(lambda, lambda1) > eastwardSpan(lambda0, lambda1)) lambda0 = lambda
    } else {
      lambda0 = lambda1 = lambda
      ranges.push((range = [lambda0, lambda1]))
    }
    widenLatitude(phi)
    previous = p
    lambda2 = lambda
  }

  // a vertex of a ring: the winding of its longitudes, its share of the area, and its place on the boundary
  const ringVertex = (lambda: number, phi: number, original: boolean): void => {
    if (previous) {
      const delta = lambda - lambda2
      deltaSum.add(Math.abs(delta) > 180 ? delta + (delta > 0 ? 360 : -360) : delta)
    } else {
      lambda00 = lambda
      phi00 = phi
    }
    if (original) ringArea.point(lambda, phi)
    linePoint(lambda, phi)
  }

  // the box of the line or ring that just ended is the box of its longitude range
  const closeRange = (): void => {
    if (!range) throw new TypeError("Cannot set properties of null (setting '0')")
    range[0] = lambda0
    range[1] = lambda1
  }

  for (let i = 0; i < ev.length; i++) {
    const x = ev.x[i]!
    const y = ev.y[i]!
    switch (ev.op[i]!) {
      case SPHERE:
        lambda0 = -(lambda1 = 180)
        phi0 = -(phi1 = 90)
        break
      case POLYGON_START:
        inPolygon = true
        deltaSum = new Adder()
        ringArea.begin()
        break
      case POLYGON_END:
        inPolygon = false
        if (+ringArea.sum < 0) {
          lambda0 = -(lambda1 = 180)
          phi0 = -(phi1 = 90)
        } else if (+deltaSum > EPSILON) phi1 = 90
        else if (+deltaSum < -EPSILON) phi0 = -90
        closeRange()
        break
      case LINE_START:
        inLine = true
        if (inPolygon) ringArea.start()
        break
      case LINE_END:
        if (inPolygon) {
          // a ring is closed by returning to its first vertex; a ring with no vertex adds nothing
          if (!previous) {
            inLine = false
            break
          }
          ringVertex(lambda00, phi00, true)
          ringArea.end()
          if (Math.abs(+deltaSum) > EPSILON) lambda0 = -(lambda1 = 180)
        }
        closeRange()
        previous = null
        inLine = false
        break
      case POINT:
        if (inLine && inPolygon) ringVertex(x, y, true)
        else if (inLine) linePoint(x, y)
        else {
          ranges.push((range = [(lambda0 = x), (lambda1 = x)]))
          widenLatitude(y)
        }
        break
    }
  }

  // sort the longitude ranges by their west edge, merge the overlapping ones, then cut at the widest gap
  if (ranges.length) {
    ranges.sort((a, b) => a[0] - b[0])
    let a = ranges[0]!
    const merged: Range[] = [a]
    for (let i = 1; i < ranges.length; i++) {
      const b = ranges[i]!
      if (rangeContains(a, b[0]) || rangeContains(a, b[1])) {
        if (eastwardSpan(a[0], b[1]) > eastwardSpan(a[0], a[1])) a[1] = b[1]
        if (eastwardSpan(b[0], a[1]) > eastwardSpan(a[0], a[1])) a[0] = b[0]
      } else merged.push((a = b))
    }
    let widest = -Infinity
    a = merged[merged.length - 1]!
    for (let i = 0; i < merged.length; a = merged[i]!, i++) {
      const b = merged[i]!
      const gap = eastwardSpan(a[1], b[0])
      if (gap > widest) {
        widest = gap
        lambda0 = b[0]
        lambda1 = a[1]
      }
    }
  }
  return lambda0 === Infinity || phi0 === Infinity ? [[NaN, NaN], [NaN, NaN]] : [[lambda0, phi0], [lambda1, phi1]]
}

/* ---- centroid ---------------------------------------------------------------------------------- */

/**
 * The centroid of a GeoJSON object as `[lambda, phi]` in degrees. It is taken from the highest-dimension
 * geometry present: polygons by area, else lines by length, else points by their mean; NaNs if there is none.
 * Polygon weights follow Brock, "The Inertia Tensor for a Spherical Triangle", J. Applied Mechanics 42 (1975).
 */
export function sphereCentroid(object: unknown): [number, number] {
  const ev = eventsOf(object)
  // mean of the point vectors (weight w0), of the line midpoints (w1) and of the polygon triangles
  let w0 = 0
  let w1 = 0
  let x0 = 0
  let y0 = 0
  let z0 = 0
  let x1 = 0
  let y1 = 0
  let z1 = 0
  const x2 = new Adder()
  const y2 = new Adder()
  const z2 = new Adder()
  let lambda00 = NaN
  let phi00 = NaN
  let px = NaN // the previous vertex of the line or ring
  let py = NaN
  let pz = NaN
  let inPolygon = false
  let vertex = 0 // 0: not in a line, 1: first vertex of the line, 2: later vertices

  const addMean = (x: number, y: number, z: number): void => {
    ++w0
    x0 += (x - x0) / w0
    y0 += (y - y0) / w0
    z0 += (z - z0) / w0
  }

  const lineVertex = (x: number, y: number, z: number): void => {
    let w: number
    w = Math.atan2(
      Math.sqrt((w = py * z - pz * y) * w + (w = pz * x - px * z) * w + (w = px * y - py * x) * w),
      px * x + py * y + pz * z,
    )
    w1 += w
    x1 += w * (px + (px = x))
    y1 += w * (py + (py = y))
    z1 += w * (pz + (pz = z))
    addMean(px, py, pz)
  }

  const ringVertex = (lambda: number, phi: number): void => {
    lambda *= RADIANS
    phi *= RADIANS
    const cosPhi = Math.cos(phi)
    const x = cosPhi * Math.cos(lambda)
    const y = cosPhi * Math.sin(lambda)
    const z = Math.sin(phi)
    const cx = py * z - pz * y
    const cy = pz * x - px * z
    const cz = px * y - py * x
    const m = Math.hypot(cx, cy, cz)
    const w = asinClamped(m) // the edge's weight as a line: the angle it spans
    const v = m && -w / m // its weight as an area triangle
    x2.add(v * cx)
    y2.add(v * cy)
    z2.add(v * cz)
    w1 += w
    x1 += w * (px + (px = x))
    y1 += w * (py + (py = y))
    z1 += w * (pz + (pz = z))
    addMean(px, py, pz)
  }

  for (let i = 0; i < ev.length; i++) {
    const op = ev.op[i]!
    if (op === POLYGON_START) inPolygon = true
    else if (op === POLYGON_END) inPolygon = false
    else if (op === LINE_START) vertex = 1
    else if (op === LINE_END) {
      if (inPolygon && vertex === 2) ringVertex(lambda00, phi00)
      vertex = 0
    } else if (op === POINT) {
      const lambda = ev.x[i]! * RADIANS
      const phi = ev.y[i]! * RADIANS
      if (vertex === 0) {
        const cosPhi = Math.cos(phi)
        addMean(cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi))
      } else if (vertex === 1) {
        vertex = 2
        if (inPolygon) {
          lambda00 = ev.x[i]!
          phi00 = ev.y[i]!
        }
        const cosPhi = Math.cos(phi)
        px = cosPhi * Math.cos(lambda)
        py = cosPhi * Math.sin(lambda)
        pz = Math.sin(phi)
        addMean(px, py, pz)
      } else if (inPolygon) ringVertex(ev.x[i]!, ev.y[i]!)
      else {
        const cosPhi = Math.cos(phi)
        lineVertex(cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi))
      }
    }
  }

  let x = +x2
  let y = +y2
  let z = +z2
  let m = Math.hypot(x, y, z)
  // an area-weighted centroid that is undefined falls back to the length-weighted one, and that to the mean point
  if (m < EPSILON2) {
    x = x1
    y = y1
    z = z1
    if (w1 < EPSILON) {
      x = x0
      y = y0
      z = z0
    }
    m = Math.hypot(x, y, z)
    if (m < EPSILON2) return [NaN, NaN]
  }
  return [Math.atan2(y, x) * DEGREES, asinClamped(z / m) * DEGREES]
}
