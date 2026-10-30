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
const FLAT = 1e-12

export class BoundsPen {
  private readonly cos: number
  private readonly sin: number
  private readonly turn: number
  private lx = 0
  private ly = 0

  constructor(private readonly bounds: Bounds, degrees = 0) {
    this.turn = degrees ? degrees * (Math.PI / 180) : 0
    this.cos = this.turn ? Math.cos(this.turn) : 1
    this.sin = this.turn ? Math.sin(this.turn) : 0
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

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const [a0, a1, b0, b1, e0, e1] = [this.px(x1, y1), this.py(x1, y1), this.px(x2, y2), this.py(x2, y2), this.px(x, y), this.py(x, y)]
    const sx = this.lx
    const sy = this.ly
    // the curve is extreme in x or in y at the roots of either derivative: the points of the curve there
    for (const t of [...cubicTurns(sx, a0, b0, e0), ...cubicTurns(sy, a1, b1, e1)]) this.bounds.add(cubicAt(t, sx, a0, b0, e0), cubicAt(t, sy, a1, b1, e1))
    this.visit(e0, e1)
  }

  /** A circular arc about (cx, cy) from a0 to a1, clockwise unless `ccw`, with its angles turned by the pen's turn. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    const start = a0 + this.turn
    const end = a1 + this.turn
    const at = (a: number): void => { this.bounds.add(cx + r * Math.cos(a), cy + r * Math.sin(a)) }
    this.lx = cx + r * Math.cos(end)
    this.ly = cy + r * Math.sin(end)
    if (Math.abs(end - start) > CIRCLE_SWEEP) {
      this.bounds.add(cx - r, cy - r)
      this.bounds.add(cx + r, cy + r)
      return
    }
    at(start)
    at(end)
    if (end === start) return
    // the angles it passes on the way: the quarter turns within a sweep that is the way round from `from` to `from + sweep`
    const from = ccw ? end : start
    let sweep = ccw ? start - end : end - start
    sweep %= FULL_TURN
    if (sweep < 0) sweep += FULL_TURN
    let q = Math.ceil(from / QUARTER_TURN)
    for (let i = 0; i < 5 && q * QUARTER_TURN <= from + sweep; i++, q++) at(q * QUARTER_TURN)
  }
}

/** The parameters in (0, 1) where one coordinate of a cubic Bezier (control values p0..p3) is at an extreme. */
function cubicTurns(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = u (1-t)^2 + 2 v t (1-t) + w t^2 = a t^2 + 2 b t + u
  const u = p1 - p0
  const v = p2 - p1
  const w = p3 - p2
  const a = u - 2 * v + w
  const b = v - u
  const out: number[] = []
  const keep = (t: number): void => { if (t > 0 && t < 1) out.push(t) }
  if (Math.abs(a) > FLAT) {
    const disc = b * b - a * u
    if (disc >= 0) {
      const root = Math.sqrt(disc)
      keep((-b + root) / a)
      keep((-b - root) / a)
    }
  } else if (b) {
    keep(-u / (2 * b))
  }
  return out
}

function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const s = 1 - t
  return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3
}
