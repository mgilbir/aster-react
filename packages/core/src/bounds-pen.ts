/**
 * A path sink that measures instead of writing: the extent of the shapes drawn into it, from the geometry the generators hand
 * it (unrounded), not from path text. Curves contribute where they turn (the roots of the derivative), arcs where they cross a
 * quarter turn.
 *
 * The pen can be turned about the origin, as a mark item's `angle` turns its shape: points are rotated; an arc's centre is NOT
 * (only its angles are) -- which is how the extent of a turned arc with a corner radius comes out, and the one view sizes follow.
 */
import type { Bounds } from './bounds.js'

const QUARTER_TURN = Math.PI / 2
const FULL_TURN = 2 * Math.PI
/** A sweep this close to a full turn is a circle. */
const CIRCLE_SWEEP = FULL_TURN - 1e-8
/** Below this the derivative of a curve is treated as linear. */
const FLAT = 1e-14

export class BoundsPen {
  private readonly cos: number
  private readonly sin: number
  private readonly turn: number
  private lx = 0
  private ly = 0

  /**
   * `degrees` is the item's angle as it is on the item: a truthy one turns the pen, and one that is not a number (NaN, a string
   * such as "12px") turns every point it draws to NaN, which adds nothing -- vega's bound context does the same.
   */
  constructor(private readonly bounds: Bounds, degrees?: number) {
    if (degrees) {
      this.turn = degrees * (Math.PI / 180)
      this.cos = Math.cos(this.turn)
      this.sin = Math.sin(this.turn)
    } else {
      this.turn = 0
      this.cos = 1
      this.sin = 0
    }
  }

  private px(x: number, y: number): number {
    return this.cos * x - this.sin * y
  }

  private py(x: number, y: number): number {
    return this.sin * x + this.cos * y
  }

  private visit(x: number, y: number): void {
    this.bounds.add(x, y)
    this.lx = x
    this.ly = y
  }

  moveTo(x: number, y: number): void {
    this.visit(this.px(x, y), this.py(x, y))
  }

  lineTo(x: number, y: number): void {
    this.visit(this.px(x, y), this.py(x, y))
  }

  closePath(): void {}

  /** A rectangle from (x, y) by w, h: its four corners when the pen is turned, else its two opposite corners (the far one first). */
  rect(x: number, y: number, w: number, h: number): void {
    if (this.turn) {
      this.visit(this.px(x + w, y), this.py(x + w, y))
      this.visit(this.px(x + w, y + h), this.py(x + w, y + h))
      this.visit(this.px(x, y + h), this.py(x, y + h))
      this.visit(this.px(x, y), this.py(x, y))
    } else {
      this.bounds.add(x + w, y + h)
      this.visit(x, y)
    }
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const c0 = this.px(cx, cy)
    const c1 = this.py(cx, cy)
    const e0 = this.px(x, y)
    const e1 = this.py(x, y)
    // where the derivative, linear in t, is zero, the curve's value along that axis alone widens the box along it (paired with the
    // box's other edge, as vega's bound context does: so the arithmetic, and what an empty box does with it, is the same)
    const tx = (this.lx - c0) / (this.lx + e0 - 2 * c0)
    if (0 < tx && tx < 1) this.bounds.add(this.lx + (c0 - this.lx) * tx, this.bounds.y1)
    const ty = (this.ly - c1) / (this.ly + e1 - 2 * c1)
    if (0 < ty && ty < 1) this.bounds.add(this.bounds.x1, this.ly + (c1 - this.ly) * ty)
    this.visit(e0, e1)
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const [a0, a1, b0, b1, e0, e1] = [this.px(x1, y1), this.py(x1, y1), this.px(x2, y2), this.py(x2, y2), this.px(x, y), this.py(x, y)]
    const sx = this.lx
    const sy = this.ly
    // the curve is extreme in x at the roots of its x derivative, and in y at those of its y derivative: its value along that axis
    // alone widens the box along it (paired with the box's other edge, as vega's bound context does; the point of the curve there
    // would add the other coordinate as computed at that t, which can differ from the box's in the last digit)
    for (const t of cubicTurns(sx, a0, b0, e0)) this.bounds.add(cubicAt(t, sx, a0, b0, e0), this.bounds.y1)
    for (const t of cubicTurns(sy, a1, b1, e1)) this.bounds.add(this.bounds.x1, cubicAt(t, sy, a1, b1, e1))
    this.visit(e0, e1)
  }

  /** A circular arc about (cx, cy) from a0 to a1, clockwise unless `ccw`, with its angles turned by the pen's turn. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    const start = a0 + this.turn
    const end = a1 + this.turn
    const ex = cx + r * Math.cos(end)
    const ey = cy + r * Math.sin(end)
    this.lx = ex
    this.ly = ey
    if (Math.abs(end - start) > CIRCLE_SWEEP) {
      this.bounds.add(cx - r, cy - r)
      this.bounds.add(cx + r, cy + r)
      return
    }
    this.bounds.add(cx + r * Math.cos(start), cy + r * Math.sin(start))
    this.bounds.add(ex, ey)
    if (end === start) return
    // the quarter turns on the way: at most four, found by stepping from the grid line under the first angle of the sweep.
    // The stepping, not a multiplication, decides the last digits of the extent, and a view's size follows them.
    let from = wrapTurn(start)
    let to = wrapTurn(end)
    let backwards = ccw
    if (to < from) {
      backwards = !backwards
      const t = from
      from = to
      to = t
    }
    if (backwards) {
      to -= FULL_TURN
      for (let a = from - quarterRemainder(from), i = 0; i < 4 && a > to; i++, a -= QUARTER_TURN) this.bounds.add(cx + r * Math.cos(a), cy + r * Math.sin(a))
    } else {
      for (let a = from - quarterRemainder(from) + QUARTER_TURN, i = 0; i < 4 && a < to; i++, a += QUARTER_TURN) this.bounds.add(cx + r * Math.cos(a), cy + r * Math.sin(a))
    }
  }
}

/**
 * `angle % FULL_TURN`, moved into [0, FULL_TURN). The remainder is only computed for an angle further out than one turn: within
 * a turn it is the angle itself (below zero, the angle plus a turn) and from one turn to two it is the angle less a turn,
 * which the subtraction gives exactly.
 */
function wrapTurn(angle: number): number {
  if (angle >= 0 && angle < FULL_TURN) return angle
  if (angle < 0 && angle > -FULL_TURN) return angle + FULL_TURN
  if (angle >= FULL_TURN && angle < 2 * FULL_TURN) return angle - FULL_TURN
  const r = angle % FULL_TURN
  return r < 0 ? r + FULL_TURN : r
}

/** `angle % QUARTER_TURN` for an angle in [0, FULL_TURN) (or NaN), without computing a remainder for the first two quarters. */
function quarterRemainder(angle: number): number {
  if (angle < QUARTER_TURN) return angle
  if (angle < 2 * QUARTER_TURN) return angle - QUARTER_TURN
  return angle % QUARTER_TURN
}

/**
 * The parameters in (0, 1) where one coordinate of a cubic Bezier (control values p0..p3) is at an extreme: the roots of its
 * derivative, a quadratic in t. The operation order is the one a view's size depends on: an extreme that lands within an ulp
 * of an integer decides the `ceil` of the size.
 */
export function cubicTurns(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = p3 - p0 + 3 * p1 - 3 * p2
  const b = p0 + p2 - 2 * p1
  const c = p0 - p1
  const out: number[] = []
  const keep = (t: number): void => { if (t > 0 && t < 1) out.push(t) }
  if (Math.abs(a) > FLAT) {
    const disc = b * b + c * a
    if (disc >= 0) {
      const root = Math.sqrt(disc)
      keep((-b + root) / a)
      keep((-b - root) / a)
    }
  } else {
    keep(0.5 * c / b)
  }
  return out
}

export function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const s = 1 - t
  const s2 = s * s
  const t2 = t * t
  return s2 * s * p0 + 3 * s2 * t * p1 + 3 * s * t2 * p2 + t2 * t * p3
}
