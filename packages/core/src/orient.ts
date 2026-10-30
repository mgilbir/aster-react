/**
 * Orientation of three points with an exact sign.
 *
 * `orientation(a, b, c)` is negative, zero or positive according to the exact sign of
 * `(ay - cy)(bx - cx) - (ax - cx)(by - cy)`, computed on the coordinates as the real numbers they are, so it
 * never disagrees with the true geometry however nearly collinear the points are. The magnitude is meaningful only
 * when it is large; callers use the sign. (A triangulation that gets one sign wrong can produce overlapping
 * triangles, and which sign is right for a nearly degenerate triple decides the shape of the whole diagram.)
 *
 * Three stages, each used only when the previous cannot decide:
 *  1. the floating point determinant, when it exceeds a bound on its rounding error;
 *  2. the same determinant when every difference and product in it is known to be exact (Knuth/Dekker error terms),
 *     which covers collinear points on integer and other short-mantissa grids;
 *  3. exact integer arithmetic: every double is an integer multiple of 2^-1074, so the determinant is an exact BigInt.
 * Non-finite coordinates give the plain floating point value (NaN or an infinity).
 */

/** Bound on the relative rounding error of the floating point determinant, (3 + 16e)e for e = 2^-53. */
const ERROR_BOUND = 3.3306690738754716e-16

const SPLITTER = 134217729 // 2^27 + 1
const SMALLEST_TRUSTED_PRODUCT = 1e-250

const bits = new BigUint64Array(1)
const float = new Float64Array(bits.buffer)

/** `x` as an integer count of 2^-1074 (exact for every finite double). */
function ticks(x: number): bigint {
  float[0] = x
  const raw = bits[0]!
  const exponent = Number((raw >> 52n) & 0x7ffn)
  const mantissa = raw & 0xfffffffffffffn
  const magnitude = exponent === 0 ? mantissa : (mantissa | 0x10000000000000n) << BigInt(exponent - 1)
  return raw >> 63n ? -magnitude : magnitude
}

/** `a - b` and whether it is exact. */
function exactDifference(a: number, b: number): boolean {
  const s = a - b
  const bb = s - a
  return a - (s - bb) + (-b - bb) === 0
}

/** Is `x * y` exactly representable, judged by Dekker's error term (and not too small to trust it)? */
function exactProduct(x: number, y: number): boolean {
  const p = x * y
  if (p === 0) return x === 0 || y === 0
  if (Math.abs(p) < SMALLEST_TRUSTED_PRODUCT) return false
  let c = SPLITTER * x
  const xHigh = c - (c - x)
  const xLow = x - xHigh
  c = SPLITTER * y
  const yHigh = c - (c - y)
  const yLow = y - yHigh
  return xHigh * yHigh - p + xHigh * yLow + xLow * yHigh + xLow * yLow === 0
}

function exactSign(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const [tax, tay, tbx, tby, tcx, tcy] = [ticks(ax), ticks(ay), ticks(bx), ticks(by), ticks(cx), ticks(cy)]
  const d = (tay - tcy) * (tbx - tcx) - (tax - tcx) * (tby - tcy)
  return d < 0n ? -1 : d > 0n ? 1 : 0
}

export function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const left = (ay - cy) * (bx - cx)
  const right = (ax - cx) * (by - cy)
  const det = left - right
  if (Math.abs(det) >= ERROR_BOUND * Math.abs(left + right)) return det
  if (!Number.isFinite(det)) return det
  const finite = Number.isFinite(ax + ay + bx + by + cx + cy)
  if (!finite) return det
  if (
    Math.abs(ax) < 1e150 && Math.abs(ay) < 1e150 && Math.abs(bx) < 1e150 && Math.abs(by) < 1e150 && Math.abs(cx) < 1e150 && Math.abs(cy) < 1e150 &&
    exactDifference(ay, cy) && exactDifference(bx, cx) && exactDifference(ax, cx) && exactDifference(by, cy) &&
    exactProduct(ay - cy, bx - cx) && exactProduct(ax - cx, by - cy)
  ) return det
  return exactSign(ax, ay, bx, by, cx, cy)
}
