/**
 * The raw map projections: the maths from (lambda, phi) in radians to unscaled planar coordinates, and
 * back. Scaling, translation and the choice of centre are the business of `geo-projections.ts`.
 *
 * Each function writes its result into `out` (an array of two) so projecting a vertex allocates nothing.
 * The formulas are written out in the order the reference d3-geo implementation evaluates them: the
 * results are compared bit for bit.
 */
import { EPSILON, EPSILON2, HALF_PI, PI, acosClamped, asinClamped } from './geo-sphere.js'

export interface RawProjection {
  forward(lambda: number, phi: number, out: number[]): void
  inverse?(x: number, y: number, out: number[]): void
}

const { atan, atan2, cos, exp, log, pow, sign, sin, sqrt, tan, abs } = Math

/* ---- cylindrical ------------------------------------------------------------------------------- */

export const mercatorRaw: RawProjection = {
  forward(lambda, phi, out) {
    out[0] = lambda
    out[1] = log(tan((HALF_PI + phi) / 2))
  },
  inverse(x, y, out) {
    out[0] = x
    out[1] = 2 * atan(exp(y)) - HALF_PI
  },
}

/** Mercator turned a quarter turn: the transverse aspect. */
export const transverseMercatorRaw: RawProjection = {
  forward(lambda, phi, out) {
    out[0] = log(tan((HALF_PI + phi) / 2))
    out[1] = -lambda
  },
  inverse(x, y, out) {
    out[0] = -y
    out[1] = 2 * atan(exp(x)) - HALF_PI
  },
}

export const equirectangularRaw: RawProjection = {
  forward(lambda, phi, out) {
    out[0] = lambda
    out[1] = phi
  },
  inverse(x, y, out) {
    out[0] = x
    out[1] = y
  },
}

/** Lambert's cylindrical equal-area projection with standard parallel `phi0`. */
export function cylindricalEqualAreaRaw(phi0: number): RawProjection {
  const cosPhi0 = cos(phi0)
  return {
    forward(lambda, phi, out) {
      out[0] = lambda * cosPhi0
      out[1] = sin(phi) / cosPhi0
    },
    inverse(x, y, out) {
      out[0] = x / cosPhi0
      out[1] = asinClamped(y * cosPhi0)
    },
  }
}

/* ---- azimuthal --------------------------------------------------------------------------------- */

/** An azimuthal projection from the radial scale `k(cos c)`, where c is the angular distance from the centre. */
function azimuthal(k: (cosC: number) => number, angle: (z: number) => number): RawProjection {
  return {
    forward(lambda, phi, out) {
      const cx = cos(lambda)
      const cy = cos(phi)
      const s = k(cx * cy)
      if (s === Infinity) {
        out[0] = 2
        out[1] = 0
        return
      }
      out[0] = s * cy * sin(lambda)
      out[1] = s * sin(phi)
    },
    inverse(x, y, out) {
      const z = sqrt(x * x + y * y)
      const c = angle(z)
      const sc = sin(c)
      const cc = cos(c)
      out[0] = atan2(x * sc, z * cc)
      out[1] = asinClamped(z && (y * sc) / z)
    },
  }
}

export const azimuthalEqualAreaRaw = azimuthal(
  (cosC) => sqrt(2 / (1 + cosC)),
  (z) => 2 * asinClamped(z / 2),
)

export const azimuthalEquidistantRaw = azimuthal(
  (cosC) => (cosC = acosClamped(cosC)) && cosC / sin(cosC),
  (z) => z,
)

export const gnomonicRaw: RawProjection = {
  forward(lambda, phi, out) {
    const cy = cos(phi)
    const k = cos(lambda) * cy
    out[0] = (cy * sin(lambda)) / k
    out[1] = sin(phi) / k
  },
  inverse: azimuthal(() => 0, atan).inverse,
}

export const orthographicRaw: RawProjection = {
  forward(lambda, phi, out) {
    out[0] = cos(phi) * sin(lambda)
    out[1] = sin(phi)
  },
  inverse: azimuthal(() => 0, asinClamped).inverse,
}

export const stereographicRaw: RawProjection = {
  forward(lambda, phi, out) {
    const cy = cos(phi)
    const k = 1 + cos(lambda) * cy
    out[0] = (cy * sin(lambda)) / k
    out[1] = sin(phi) / k
  },
  inverse: azimuthal(() => 0, (z) => 2 * atan(z)).inverse,
}

/* ---- conic: built from the two standard parallels ---------------------------------------------- */

const tanHalf = (phi: number): number => tan((HALF_PI + phi) / 2)

export function conicConformalRaw(y0: number, y1: number): RawProjection {
  const cy0 = cos(y0)
  const n = y0 === y1 ? sin(y0) : log(cy0 / cos(y1)) / log(tanHalf(y1) / tanHalf(y0))
  const f = (cy0 * pow(tanHalf(y0), n)) / n
  if (!n) return mercatorRaw
  return {
    forward(x, y, out) {
      if (f > 0) {
        if (y < -HALF_PI + EPSILON) y = -HALF_PI + EPSILON
      } else if (y > HALF_PI - EPSILON) y = HALF_PI - EPSILON
      const r = f / pow(tanHalf(y), n)
      out[0] = r * sin(n * x)
      out[1] = f - r * cos(n * x)
    },
    inverse(x, y, out) {
      const fy = f - y
      let l = atan2(x, abs(fy)) * sign(fy)
      const r = sign(n) * sqrt(x * x + fy * fy)
      if (fy * n < 0) l -= PI * sign(x) * sign(fy)
      out[0] = l / n
      out[1] = 2 * atan(pow(f / r, 1 / n)) - HALF_PI
    },
  }
}

export function conicEqualAreaRaw(y0: number, y1: number): RawProjection {
  const sy0 = sin(y0)
  const n = (sy0 + sin(y1)) / 2
  // parallels symmetric about the equator degenerate to the cylindrical projection
  if (abs(n) < EPSILON) return cylindricalEqualAreaRaw(y0)
  const c = 1 + sy0 * (2 * n - sy0)
  const r0 = sqrt(c) / n
  return {
    forward(x, y, out) {
      const r = sqrt(c - 2 * n * sin(y)) / n
      out[0] = r * sin((x *= n))
      out[1] = r0 - r * cos(x)
    },
    inverse(x, y, out) {
      const r0y = r0 - y
      let l = atan2(x, abs(r0y)) * sign(r0y)
      if (r0y * n < 0) l -= PI * sign(x) * sign(r0y)
      out[0] = l / n
      out[1] = asinClamped((c - (x * x + r0y * r0y) * n * n) / (2 * n))
    },
  }
}

export function conicEquidistantRaw(y0: number, y1: number): RawProjection {
  const cy0 = cos(y0)
  const n = y0 === y1 ? sin(y0) : (cy0 - cos(y1)) / (y1 - y0)
  const g = cy0 / n + y0
  if (abs(n) < EPSILON) return equirectangularRaw
  return {
    forward(x, y, out) {
      const gy = g - y
      const nx = n * x
      out[0] = gy * sin(nx)
      out[1] = g - gy * cos(nx)
    },
    inverse(x, y, out) {
      const gy = g - y
      let l = atan2(x, abs(gy)) * sign(gy)
      if (gy * n < 0) l -= PI * sign(x) * sign(gy)
      out[0] = l / n
      out[1] = g - sign(n) * sqrt(x * x + gy * gy)
    },
  }
}

/* ---- pseudocylindrical ------------------------------------------------------------------------- */

const EE_A1 = 1.340264
const EE_A2 = -0.081106
const EE_A3 = 0.000893
const EE_A4 = 0.003796
const EE_M = sqrt(3) / 2
const EE_ITERATIONS = 12

/** Equal Earth (Savric, Patterson and Jenny, 2018). */
export const equalEarthRaw: RawProjection = {
  forward(lambda, phi, out) {
    const l = asinClamped(EE_M * sin(phi))
    const l2 = l * l
    const l6 = l2 * l2 * l2
    out[0] = (lambda * cos(l)) / (EE_M * (EE_A1 + 3 * EE_A2 * l2 + l6 * (7 * EE_A3 + 9 * EE_A4 * l2)))
    out[1] = l * (EE_A1 + EE_A2 * l2 + l6 * (EE_A3 + EE_A4 * l2))
  },
  inverse(x, y, out) {
    // Newton's method on the parametric latitude
    let l = y
    let l2 = l * l
    let l6 = l2 * l2 * l2
    for (let i = 0, delta: number, fy: number, fpy: number; i < EE_ITERATIONS; ++i) {
      fy = l * (EE_A1 + EE_A2 * l2 + l6 * (EE_A3 + EE_A4 * l2)) - y
      fpy = EE_A1 + 3 * EE_A2 * l2 + l6 * (7 * EE_A3 + 9 * EE_A4 * l2)
      l -= delta = fy / fpy
      l2 = l * l
      l6 = l2 * l2 * l2
      if (abs(delta) < EPSILON2) break
    }
    out[0] = (EE_M * x * (EE_A1 + 3 * EE_A2 * l2 + l6 * (7 * EE_A3 + 9 * EE_A4 * l2))) / cos(l)
    out[1] = asinClamped(sin(l) / EE_M)
  },
}

/** Natural Earth I (Savric, 2008): a polynomial approximation. */
export const naturalEarth1Raw: RawProjection = {
  forward(lambda, phi, out) {
    const phi2 = phi * phi
    const phi4 = phi2 * phi2
    out[0] = lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4)))
    out[1] = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
  },
  inverse(x, y, out) {
    let phi = y
    let i = 25
    let delta: number
    let phi2: number
    let phi4: number
    do {
      phi2 = phi * phi
      phi4 = phi2 * phi2
      phi -= delta =
        (phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))) - y) /
        (1.007226 + phi2 * (0.015085 * 3 + phi4 * (-0.044475 * 7 + 0.028874 * 9 * phi2 - 0.005916 * 11 * phi4)))
    } while (abs(delta) > EPSILON && --i > 0)
    out[0] = x / (0.8707 + (phi2 = phi * phi) * (-0.131979 + phi2 * (-0.013791 + phi2 * phi2 * phi2 * (0.003971 - 0.001529 * phi2))))
    out[1] = phi
  },
}

/** The auxiliary angle of the Mollweide family, by Newton's method: 2 theta + sin 2 theta = cp sin phi. */
function mollweideTheta(cp: number, phi: number): number {
  const cpsinPhi = cp * sin(phi)
  let i = 30
  let delta: number
  do phi -= delta = (phi + sin(phi) - cpsinPhi) / (1 + cos(phi))
  while (abs(delta) > EPSILON && --i > 0)
  return phi / 2
}

export const mollweideRaw: RawProjection = (() => {
  const cx = sqrt(2) / HALF_PI
  const cy = sqrt(2)
  const cp = PI
  return {
    forward(lambda: number, phi: number, out: number[]) {
      phi = mollweideTheta(cp, phi)
      out[0] = cx * lambda * cos(phi)
      out[1] = cy * sin(phi)
    },
    inverse(x: number, y: number, out: number[]) {
      y = asinClamped(y / cy)
      out[0] = x / (cx * cos(y))
      out[1] = asinClamped((2 * y + sin(2 * y)) / cp)
    },
  }
})()
