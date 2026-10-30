/**
 * Strokes for the coverage-only canvas (Aster's own, not Skia's stroker): a path's subpaths become the polygons a pen of a given
 * width would cover -- segments, joins, caps and dashes, curves flattened finely first -- which the scan fills with the non-zero
 * rule like any other shape.
 */
import type { Pt, Sub } from './raster-edges.js'

const TOL = 0.05 // flattening tolerance of a curve being stroked, in pixels

// --- the pen's view of a path: curves flattened finely ---------------------------------------------

function flatten(s: Sub): Pt[] {
  const pts: Pt[] = [s.start]
  let [px, py] = s.start
  for (const o of s.ops) {
    if (o.k === 'L') pts.push([o.x, o.y])
    else if (o.k === 'Q') {
      const n = curveSteps(Math.hypot(o.cx - px, o.cy - py) + Math.hypot(o.x - o.cx, o.y - o.cy))
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        pts.push([u * u * px + 2 * u * t * o.cx + t * t * o.x, u * u * py + 2 * u * t * o.cy + t * t * o.y])
      }
    } else {
      const n = curveSteps(Math.hypot(o.c1x - px, o.c1y - py) + Math.hypot(o.c2x - o.c1x, o.c2y - o.c1y) + Math.hypot(o.x - o.c2x, o.y - o.c2y))
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
  if (!(total > 0)) return [s]
  const pts = s.closed && s.pts.length > 1 ? [...s.pts, s.pts[0]!] : s.pts
  let idx = 0
  let into = ((offset % total) + total) % total
  while (into >= pattern[idx]!) {
    into -= pattern[idx]!
    idx = (idx + 1) % pattern.length
  }
  let remaining = pattern[idx]! - into
  let on = idx % 2 === 0
  let cur: Pt[] = on ? [pts[0]!] : []
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1]!
    const [x1, y1] = pts[i]!
    let len = Math.hypot(x1 - x0, y1 - y0)
    if (len === 0) continue
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    while (len > remaining) {
      x0 += ux * remaining
      y0 += uy * remaining
      len -= remaining
      if (on) { cur.push([x0, y0]); out.push({ pts: cur, closed: false }); cur = [] } else cur = [[x0, y0]]
      on = !on
      idx = (idx + 1) % pattern.length
      remaining = pattern[idx]!
    }
    remaining -= len
    if (on) cur.push([x1, y1])
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

function disk(cx: number, cy: number, r: number): Pt[] {
  const n = Math.max(8, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.5, TOL / Math.max(r, TOL)))))
  const p: Pt[] = []
  for (let i = 0; i < n; i++) p.push([cx + r * Math.cos((i * 2 * Math.PI) / n), cy + r * Math.sin((i * 2 * Math.PI) / n)])
  return p
}

/** The polygons (all positively oriented, so the non-zero rule unions them) of a stroked polyline. */
function outline(s: Piece, half: number, cap: string, join: string, miterLimit: number, out: Pt[][]): void {
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
    if (cap === 'round') out.push(disk(x, y, half))
    else if (cap === 'square') out.push(orient([[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]]))
    return
  }
  const n = pts.length
  const segs = closed ? n : n - 1
  const dirs: Pt[] = []
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % n]!
    const len = Math.hypot(bx - ax, by - ay)
    dirs.push([(bx - ax) / len, (by - ay) / len])
  }
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
    out.push(disk(pts[0]![0], pts[0]![1], half))
    out.push(disk(pts[n - 1]![0], pts[n - 1]![1], half))
  }
  const joins = closed ? n : n - 2
  for (let j = 0; j < joins; j++) {
    const vi = closed ? j : j + 1
    const [vx, vy] = pts[vi]!
    const d0 = dirs[closed ? (vi + segs - 1) % segs : vi - 1]!
    const d1 = dirs[closed ? vi % segs : vi]!
    const cross = d0[0] * d1[1] - d0[1] * d1[0]
    const dot = d0[0] * d1[0] + d0[1] * d1[1]
    if (Math.abs(cross) < 1e-12 && dot > 0) continue // straight on
    if (join === 'round') { out.push(disk(vx, vy, half)); continue }
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

/** Pen parameters in device units. */
export interface Pen { half: number; cap: string; join: string; miterLimit: number; dash: number[]; dashOffset: number }

/** The polygons a pen covers along the subpaths (all positively oriented, so the non-zero rule unions them). */
export function strokePolygons(subs: Sub[], pen: Pen): Pt[][] {
  const polys: Pt[][] = []
  const dashing = pen.dash.length > 0 && pen.dash.some((d) => d > 0)
  for (const s of subs) {
    const pts = flatten(s)
    if (pts.length < 2 && !s.closed) continue // (a lone moveTo draws nothing)
    const piece: Piece = { pts, closed: s.closed }
    const pieces = dashing ? dashed(piece, pen.dash, pen.dashOffset) : [piece]
    for (const p of pieces) outline(p, pen.half, pen.cap, pen.join, pen.miterLimit, polys)
  }
  return polys
}
