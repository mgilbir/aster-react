/**
 * Strokes for the coverage-only canvas (Aster's own, not Skia's stroker): a path's subpaths become the polygons a pen of a given
 * width would cover -- segments, joins, caps and dashes, curves flattened finely first -- which the scan fills with the non-zero
 * rule like any other shape.
 */
import type { Pt, Sub } from './raster-edges.js'
import { meterTick } from './limits.js'

const TOL = 0.05 // flattening tolerance of a curve being stroked, in pixels

/**
 * Dashes in one contour past which it is stroked undashed: a canvas gives up dashing there (Skia, which Chromium's canvas is,
 * draws the path as if no dash were set beyond a million dashes per contour). A pattern far finer than the path is long would
 * otherwise cut it into more pieces than memory holds, or, past the float spacing of the length, into pieces that never end.
 */
const MAX_DASHES = 1_000_000
/** Points of a full round join or cap past which only the arc facing the canvas is made (r beyond about 170 000 pixels). */
const MAX_DISK_POINTS = 4096

/** A device-space box `[x0, y0, x1, y1]`: the canvas, grown by as far as a pen's geometry reaches from the point it is drawn at. */
export type Box = [number, number, number, number]

// --- the pen's view of a path: curves flattened finely ---------------------------------------------

function flatten(s: Sub): Pt[] {
  const pts: Pt[] = [s.start]
  let [px, py] = s.start
  for (const o of s.ops) {
    if (o.k === 'L') pts.push([o.x, o.y])
    else if (o.k === 'Q') {
      const n = curveSteps(Math.hypot(o.cx - px, o.cy - py) + Math.hypot(o.x - o.cx, o.y - o.cy))
      // bounded: curveSteps() is at most 64
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        pts.push([u * u * px + 2 * u * t * o.cx + t * t * o.x, u * u * py + 2 * u * t * o.cy + t * t * o.y])
      }
    } else {
      const n = curveSteps(Math.hypot(o.c1x - px, o.c1y - py) + Math.hypot(o.c2x - o.c1x, o.c2y - o.c1y) + Math.hypot(o.x - o.c2x, o.y - o.c2y))
      // bounded: curveSteps() is at most 64
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const c = 3 * u * t * t
        const d = t * t * t
        pts.push([a * px + b * o.c1x + c * o.c2x + d * o.x, a * py + b * o.c1y + c * o.c2y + d * o.y])
      }
    }
    px = o.x
    py = o.y
  }
  return pts
}

function curveSteps(length: number): number {
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(length / TOL) / 2)))
}

interface Piece {
  pts: Pt[]
  closed: boolean
}

/** Cut a polyline into dashes (device units). */
function dashed(s: Piece, pattern: number[], offset: number): Piece[] {
  const out: Piece[] = []
  const total = pattern.reduce((p, q) => p + q, 0)
  // a canvas ignores a dash list with a negative or non-finite entry (setLineDash), and the stroke stays solid; walking one
  // would never end (a negative dash moves backwards)
  if (!(total > 0) || pattern.some((q) => !(q >= 0) || !Number.isFinite(q))) return [s]
  const pts = s.closed && s.pts.length > 1 ? [...s.pts, s.pts[0]!] : s.pts
  let length = 0
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
  meterTick('stroke dash', pts.length)
  // (an infinite length is past any count, and dashing it would never end)
  const dashes = (length * (pattern.length / 2)) / total
  if (dashes > MAX_DASHES) return [s]
  let idx = 0
  let into = ((offset % total) + total) % total
  // bounded: `into` is under one period: at most one step per pattern entry
  while (into >= pattern[idx]!) {
    into -= pattern[idx]!
    idx = (idx + 1) % pattern.length
  }
  let remaining = pattern[idx]! - into
  let on = idx % 2 === 0
  let cur: Pt[] = on ? [pts[0]!] : []
  // Dash along `len` from (x0, y0) in the direction (ux, uy), to `end`.
  const walk = (x0: number, y0: number, ux: number, uy: number, len: number, end: Pt): void => {
    while (len > remaining) {
      meterTick('stroke dash')
      x0 += ux * remaining
      y0 += uy * remaining
      len -= remaining
      if (on) { cur.push([x0, y0]); out.push({ pts: cur, closed: false }); cur = [] } else cur = [[x0, y0]]
      on = !on
      idx = (idx + 1) % pattern.length
      remaining = pattern[idx]!
    }
    remaining -= len
    if (on) cur.push(end)
  }
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!
    const [x1, y1] = pts[i]!
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len === 0) continue
    walk(x0, y0, (x1 - x0) / len, (y1 - y0) / len, len, [x1, y1])
  }
  if (on && cur.length > 1) out.push({ pts: cur, closed: false })
  return out
}

const orient = (poly: Pt[]): Pt[] => {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!
    const [bx, by] = poly[(i + 1) % poly.length]!
    area += ax * by - bx * ay
  }
  return area < 0 ? poly.reverse() : poly
}

function disk(cx: number, cy: number, r: number, near: Box): Pt[] {
  const n = Math.max(8, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.5, TOL / Math.max(r, TOL)))))
  if (n > MAX_DISK_POINTS) return diskNear(cx, cy, r, near)
  meterTick('stroke join', n)
  const p: Pt[] = []
  // bounded: n is at most MAX_DISK_POINTS, ticked for above
  for (let i = 0; i < n; i++) p.push([cx + r * Math.cos((i * 2 * Math.PI) / n), cy + r * Math.sin((i * 2 * Math.PI) / n)])
  return p
}

/**
 * A disk too large to make whole (the point count grows with the square root of the radius, and is infinite once `1 - TOL / r`
 * rounds to 1), as far as `box` sees it: nothing when it misses the box, the box when it holds it, else the slice of it between the
 * directions in which the box lies from the centre, with the arc made at the tolerance over that angle only. Inside the box the
 * slice is the disk (every point of the box in the disk lies in one of those directions).
 */
function diskNear(cx: number, cy: number, r: number, box: Box): Pt[] {
  const corners: Pt[] = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
  let far = 0
  for (let i = 0; i < 4; i++) far = Math.max(far, Math.hypot(corners[i]![0] - cx, corners[i]![1] - cy))
  if (r >= far) return corners
  const nearest = Math.hypot(cx - Math.min(Math.max(cx, box[0]), box[2]), cy - Math.min(Math.max(cy, box[1]), box[3]))
  if (!(r > nearest)) return []
  // (the centre is outside the box here: inside it, `far` is at most the box's diagonal, and no disk of more than
  // MAX_DISK_POINTS points is smaller than that for a canvas the `pixels` ceiling admits)
  const mid = Math.atan2((box[1] + box[3]) / 2 - cy, (box[0] + box[2]) / 2 - cx)
  let lo = 0
  let hi = 0
  for (const [x, y] of corners) {
    const a = Math.atan2(y - cy, x - cx) - mid
    const turn = a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
    if (turn < lo) lo = turn
    if (turn > hi) hi = turn
  }
  const step = 2 * Math.acos(1 - Math.min(0.5, TOL / r))
  const n = Math.min(MAX_DISK_POINTS, Math.max(2, Math.ceil((hi - lo) / step)))
  meterTick('stroke join', n)
  const p: Pt[] = [[cx, cy]]
  // bounded: n is at most MAX_DISK_POINTS, ticked for above
  for (let i = 0; i <= n; i++) {
    const a = mid + lo + ((hi - lo) * i) / n
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return p
}

/** The polygons (all positively oriented, so the non-zero rule unions them) of a stroked polyline. */
function outline(s: Piece, half: number, cap: string, join: string, miterLimit: number, out: Pt[][], near: Box): void {
  // drop repeated points
  const pts: Pt[] = []
  for (const p of s.pts) {
    const q = pts[pts.length - 1]
    if (q === undefined || q[0] !== p[0] || q[1] !== p[1]) pts.push(p)
  }
  const closed = s.closed && pts.length > 2
  if (closed) {
    const a = pts[0]!
    const b = pts[pts.length - 1]!
    if (a[0] === b[0] && a[1] === b[1]) pts.pop()
  }
  if (pts.length === 1) {
    // a point: a round cap is a disk, a square cap a square, a butt cap nothing
    const [x, y] = pts[0]!
    if (cap === 'round') out.push(disk(x, y, half, near))
    else if (cap === 'square') out.push(orient([[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]]))
    return
  }
  const n = pts.length
  const segs = closed ? n : n - 1
  const dirs: Pt[] = []
  // bounded: one pass over the piece's points (made by a metered flatten or dash walk)
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % n]!
    const len = Math.hypot(bx - ax, by - ay)
    dirs.push([(bx - ax) / len, (by - ay) / len])
  }
  // bounded: one pass over the piece's points (made by a metered flatten or dash walk)
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % n]!
    const [ux, uy] = dirs[i]!
    const nx = -uy * half
    const ny = ux * half
    let sx = ax
    let sy = ay
    let ex = bx
    let ey = by
    if (!closed && cap === 'square') {
      if (i === 0) { sx -= ux * half; sy -= uy * half }
      if (i === segs - 1) { ex += ux * half; ey += uy * half }
    }
    out.push(orient([[sx + nx, sy + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [sx - nx, sy - ny]]))
  }
  if (!closed && cap === 'round') {
    out.push(disk(pts[0]![0], pts[0]![1], half, near))
    out.push(disk(pts[n - 1]![0], pts[n - 1]![1], half, near))
  }
  const joins = closed ? n : n - 2
  // bounded: one pass over the piece's points (made by a metered flatten or dash walk)
  for (let j = 0; j < joins; j++) {
    const vi = closed ? j : j + 1
    const [vx, vy] = pts[vi]!
    const d0 = dirs[closed ? (vi + segs - 1) % segs : vi - 1]!
    const d1 = dirs[closed ? vi % segs : vi]!
    const cross = d0[0] * d1[1] - d0[1] * d1[0]
    const dot = d0[0] * d1[0] + d0[1] * d1[1]
    if (Math.abs(cross) < 1e-12 && dot > 0) continue // straight on
    if (join === 'round') { out.push(disk(vx, vy, half, near)); continue }
    // the outer side of the turn: left of d0 when the path turns right (y down), and the reverse
    const sgn = cross > 0 ? -1 : 1
    const ax = vx + sgn * -d0[1] * half
    const ay = vy + sgn * d0[0] * half
    const bx = vx + sgn * -d1[1] * half
    const by = vy + sgn * d1[0] * half
    if (join === 'miter') {
      const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2)) // cos(phi/2) of the turn phi: the miter is half / cos(phi/2) long
      if (cosHalf > 0 && 1 / cosHalf <= miterLimit) {
        const mx = ax + bx - 2 * vx
        const my = ay + by - 2 * vy
        const ml = Math.hypot(mx, my)
        if (ml > 0) {
          const k = half / cosHalf / ml
          out.push(orient([[vx, vy], [ax, ay], [vx + mx * k, vy + my * k], [bx, by]]))
          continue
        }
      }
    }
    out.push(orient([[vx, vy], [ax, ay], [bx, by]]))
  }
}

/**
 * Pen parameters in device units. `canvas`, the box of the pixels drawn into: a round join or cap of an immense pen is made as
 * far as it can be seen from it.
 */
export interface Pen { half: number; cap: string; join: string; miterLimit: number; dash: number[]; dashOffset: number; canvas: Box }

/** The polygons a pen covers along the subpaths (all positively oriented, so the non-zero rule unions them). */
export function strokePolygons(subs: Sub[], pen: Pen): Pt[][] {
  const polys: Pt[][] = []
  const dashing = pen.dash.length > 0 && pen.dash.some((d) => d > 0)
  // (a disk matters where it meets the canvas)
  const box = pen.canvas
  const disks: Box = [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2]
  for (const s of subs) {
    meterTick('stroke', s.ops.length + 1)
    const pts = flatten(s)
    if (pts.length < 2 && !s.closed) continue // (a lone moveTo draws nothing)
    const piece: Piece = { pts, closed: s.closed }
    const pieces = dashing ? dashed(piece, pen.dash, pen.dashOffset) : [piece]
    // bounded: the dash walk ticks for every piece it makes; outline() is one pass over a piece's points
    for (const p of pieces) outline(p, pen.half, pen.cap, pen.join, pen.miterLimit, polys, disks)
  }
  return polys
}
