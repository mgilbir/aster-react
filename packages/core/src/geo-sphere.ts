/**
 * Spherical geometry shared by the geo engine: constants, unit-vector helpers, the rotation of the
 * sphere, and the test for whether a polygon contains a point.
 *
 * Longitudes and latitudes are radians here unless a name says degrees.
 */
import { Adder } from './arr.js'
import { BATCH, POINT, type Events, type Run } from './geo-events.js'

export const EPSILON = 1e-6
export const EPSILON2 = 1e-12
export const PI = Math.PI
export const HALF_PI = PI / 2
export const QUARTER_PI = PI / 4
export const TAU = PI * 2
export const DEGREES = 180 / PI
export const RADIANS = PI / 180

/** `acos` / `asin` that clamp rounding overshoot of their argument instead of returning NaN. */
export const acosClamped = (x: number): number => (x > 1 ? 0 : x < -1 ? PI : Math.acos(x))
export const asinClamped = (x: number): number => (x > 1 ? HALF_PI : x < -1 ? -HALF_PI : Math.asin(x))

export type Vec3 = [number, number, number]

export function unitVector(lambda: number, phi: number): Vec3 {
  const cosPhi = Math.cos(phi)
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)]
}

/** The [lambda, phi] a vector points at. */
export function lonLat(v: Vec3): [number, number] {
  return [Math.atan2(v[1], v[0]), asinClamped(v[2])]
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export const scaled = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k]

export function addTo(a: Vec3, b: Vec3): void {
  a[0] += b[0]
  a[1] += b[1]
  a[2] += b[2]
}

export function normalize(v: Vec3): void {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  v[0] /= length
  v[1] /= length
  v[2] /= length
}

/** Whether two [lambda, phi] positions coincide to within the clipping tolerance. */
export const sameSpot = (ax: number, ay: number, bx: number, by: number): boolean =>
  Math.abs(ax - bx) < EPSILON && Math.abs(ay - by) < EPSILON

/* ---- rotation ---------------------------------------------------------------------------------- */

/** Wrap a longitude that left [-pi, pi] by a whole number of turns. */
const wrapLambda = (lambda: number): number => (Math.abs(lambda) > PI ? lambda - Math.round(lambda / TAU) * TAU : lambda)

/**
 * A rotation of the sphere: first about the polar axis by `lambda`, then the pole is tilted by `phi`
 * and the result turned by `gamma` about the new axis. Either half is skipped when it is zero.
 */
export class Rotation {
  private readonly lambda: number
  private readonly tilts: boolean
  private readonly cosPhi: number
  private readonly sinPhi: number
  private readonly cosGamma: number
  private readonly sinGamma: number

  constructor(lambda: number, phi: number, gamma: number) {
    this.lambda = lambda % TAU
    this.tilts = !!(phi || gamma)
    this.cosPhi = Math.cos(phi)
    this.sinPhi = Math.sin(phi)
    this.cosGamma = Math.cos(gamma)
    this.sinGamma = Math.sin(gamma)
  }

  private readonly at = [0, 0]

  /** Convert the point events from degrees to radians and rotate them, in place. */
  rotateEvents(ev: Events): void {
    for (let i = 0, n = ev.length; i < n; i += BATCH) this.rotateRange(ev, i, Math.min(n, i + BATCH))
  }

  private rotateRange(ev: Events, from: number, to: number): void {
    const { op, x, y } = ev
    if (this.tilts) {
      const { at } = this
      for (let i = from; i < to; i++) {
        if (op[i] === POINT) {
          this.forward(x[i]! * RADIANS, y[i]! * RADIANS, at)
          x[i] = at[0]!
          y[i] = at[1]!
        }
      }
      return
    }
    // without a tilt a rotation only turns the longitude, and keeps it within a half turn of the meridian
    const turn = this.lambda
    for (let i = from; i < to; i++) {
      if (op[i] === POINT) {
        let lambda = x[i]! * RADIANS
        if (turn) lambda += turn
        if (Math.abs(lambda) > PI) lambda -= Math.round(lambda / TAU) * TAU
        x[i] = lambda
        y[i] = y[i]! * RADIANS
      }
    }
  }

  forward(lambda: number, phi: number, out: number[]): void {
    // a pure tilt leaves the longitude as it is; every other rotation brings it back into [-pi, pi]
    if (this.lambda) {
      lambda += this.lambda
      if (Math.abs(lambda) > PI) lambda -= Math.round(lambda / TAU) * TAU
    } else if (!this.tilts && Math.abs(lambda) > PI) lambda -= Math.round(lambda / TAU) * TAU
    if (!this.tilts) {
      out[0] = lambda
      out[1] = phi
      return
    }
    const cosP = Math.cos(phi)
    const x = Math.cos(lambda) * cosP
    const y = Math.sin(lambda) * cosP
    const z = Math.sin(phi)
    const k = z * this.cosPhi + x * this.sinPhi
    out[0] = Math.atan2(y * this.cosGamma - k * this.sinGamma, x * this.cosPhi - z * this.sinPhi)
    out[1] = asinClamped(k * this.cosGamma + y * this.sinGamma)
  }

  inverse(lambda: number, phi: number, out: number[]): void {
    if (this.tilts) {
      const cosP = Math.cos(phi)
      const x = Math.cos(lambda) * cosP
      const y = Math.sin(lambda) * cosP
      const z = Math.sin(phi)
      const k = z * this.cosGamma - y * this.sinGamma
      lambda = Math.atan2(y * this.cosGamma + z * this.sinGamma, x * this.cosPhi + k * this.sinPhi)
      phi = asinClamped(k * this.cosPhi - x * this.sinPhi)
    }
    out[0] = this.lambda ? wrapLambda(lambda - this.lambda) : this.tilts ? lambda : wrapLambda(lambda)
    out[1] = phi
  }
}

/** Where the position [0, 0] of a rotation given in degrees (`[lambda, phi, gamma?]`) came from. */
export function rotationOrigin(degrees: readonly number[]): [number, number] {
  const r = new Rotation(degrees[0]! * RADIANS, degrees[1]! * RADIANS, degrees.length > 2 ? degrees[2]! * RADIANS : 0)
  const out = [0, 0]
  r.inverse(0 * RADIANS, 0 * RADIANS, out)
  return [out[0]! * DEGREES, out[1]! * DEGREES]
}

/* ---- point in polygon -------------------------------------------------------------------------- */

const lambdaOf = (x: number): number => (Math.abs(x) <= PI ? x : Math.sign(x) * (((Math.abs(x) + PI) % TAU) - PI))

/** A ring of positions (radians), without the repeated closing position: a run of an event buffer. */
export type Ring = Run

/**
 * Whether a polygon contains the position (lambda, phi). The test is on the sphere, so a ring has two sides;
 * the side holding the south pole is found from the winding of the rings, and the answer is flipped once per
 * crossing of the position's meridian by an edge that passes south of it.
 */
export function polygonContains(rings: readonly Ring[], lambdaIn: number, phiIn: number): boolean {
  const lambda = lambdaOf(lambdaIn)
  let phi = phiIn
  const sinPhi = Math.sin(phi)
  const normal: Vec3 = [Math.sin(lambda), -Math.cos(lambda), 0]
  let angle = 0
  let winding = 0
  const sum = new Adder()
  if (sinPhi === 1) phi = HALF_PI + EPSILON
  else if (sinPhi === -1) phi = -HALF_PI - EPSILON
  for (const ring of rings) {
    const m = ring.length
    if (!m) continue
    const base = ring.from
    let lambda0Raw = ring.x[base + m - 1]!
    let phi0Raw = ring.y[base + m - 1]!
    let lambda0 = lambdaOf(lambda0Raw)
    const halfPhi0 = phi0Raw / 2 + QUARTER_PI
    let sinPhi0 = Math.sin(halfPhi0)
    let cosPhi0 = Math.cos(halfPhi0)
    for (let j = 0; j < m; j++) {
      const lambda1Raw = ring.x[base + j]!
      const phi1Raw = ring.y[base + j]!
      const lambda1 = lambdaOf(lambda1Raw)
      const halfPhi1 = phi1Raw / 2 + QUARTER_PI
      const sinPhi1 = Math.sin(halfPhi1)
      const cosPhi1 = Math.cos(halfPhi1)
      const delta = lambda1 - lambda0
      const direction = delta >= 0 ? 1 : -1
      const absDelta = direction * delta
      const antimeridian = absDelta > PI
      const k = sinPhi0 * sinPhi1
      sum.add(Math.atan2(k * direction * Math.sin(absDelta), cosPhi0 * cosPhi1 + k * Math.cos(absDelta)))
      angle += antimeridian ? delta + direction * TAU : delta
      // does the edge cross the meridian of the position, and does it pass south of it?
      if (antimeridian !== (lambda0 >= lambda !== (lambda1 >= lambda))) {
        const arc = cross(unitVector(lambda0Raw, phi0Raw), unitVector(lambda1Raw, phi1Raw))
        normalize(arc)
        const intersection = cross(normal, arc)
        normalize(intersection)
        const phiArc = (antimeridian !== delta >= 0 ? -1 : 1) * asinClamped(intersection[2])
        if (phi > phiArc || (phi === phiArc && (arc[0] || arc[1]))) {
          winding += antimeridian !== delta >= 0 ? 1 : -1
        }
      }
      lambda0Raw = lambda1Raw
      phi0Raw = phi1Raw
      lambda0 = lambda1
      sinPhi0 = sinPhi1
      cosPhi0 = cosPhi1
    }
  }
  return (((angle < -EPSILON || (angle < EPSILON && +sum < -EPSILON2) ? 1 : 0) ^ (winding & 1)) !== 0)
}
