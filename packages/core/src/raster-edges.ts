/*
 * Derived in part from Skia (https://skia.org), BSD-3-Clause: the way a software scan converter turns a path into monotonic line
 * edges (SkAnalyticEdge::setLine, the curve subdivision of SkEdge.cpp -- diff_to_shift and cubic_delta_from_line -- and
 * SkConic::BuildUnitArc and computeQuadPOW2) is re-expressed here in TypeScript. Skia is Copyright The Android Open Source Project
 * and Google Inc.; its licence text is reproduced in THIRD_PARTY_NOTICES.md.
 */
/**
 * From a recorded path to the line edges the coverage scan (`raster.ts`) integrates. A browser canvas fills with Skia, and which
 * pixels end up with any alpha depends on exactly how Skia cuts curves into lines and where it snaps their ends, so these steps
 * follow it:
 *
 *  - a line's ends are snapped: y to a quarter of a pixel, x to 1/256;
 *  - a quad or cubic is cut at its vertical extrema into y-monotonic pieces, each stepped into 2^shift lines, where `shift` is
 *    read from the piece's distance from its chord in fixed point (at most 2^6 lines); only the first and last y of a piece are
 *    snapped, the ones between keep their offset from the first;
 *  - an arc is a run of conics (rational quads) of at most a quarter turn, each made into quads at a quarter-pixel tolerance.
 *
 * Every constant below decides which edge pixels receive a sliver of alpha; none is free.
 */

export type Pt = [number, number]

/** A drawing command after the transform (device space). */
export type Op =
  | { k: 'L'; x: number; y: number }
  | { k: 'Q'; cx: number; cy: number; x: number; y: number }
  | { k: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }

/** A subpath: where it starts, what follows, and whether `closePath` ended it. */
export interface Sub {
  start: Pt
  ops: Op[]
  closed: boolean
}

/** A line edge with y0 < y1: x at y0, dx/dy, and the winding direction (+1 when the path ran downwards). */
export interface Edge { y0: number; y1: number; x0: number; slope: number; dir: number }

const quarterRow = (y: number): number => Math.floor(y * 4 + 0.5) / 4
const x256 = (x: number): number => Math.round(x * 256) / 256

/**
 * The edge from (ax, ay) to (bx, by), or null when it is flat. `placed`: the y's are already where an edge keeps them (a piece of
 * a subdivided curve); otherwise they are snapped to a quarter row here.
 */
function edgeBetween(ax: number, ay: number, bx: number, by: number, placed: boolean): Edge | null {
  let x0 = x256(ax)
  let x1 = x256(bx)
  let y0 = placed ? ay : quarterRow(ay)
  let y1 = placed ? by : quarterRow(by)
  let dir = 1
  if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; dir = -1 }
  if (y0 === y1) return null
  return { y0, y1, x0, slope: (x1 - x0) / (y1 - y0), dir }
}

/** The edges of closed polygons (each ring closes back to its first point); a ring with a non-finite coordinate loses that side. */
export function polygonEdges(rings: Pt[][]): Edge[] {
  const out: Edge[] = []
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!
      const [bx, by] = ring[(i + 1) % ring.length]!
      if (!Number.isFinite(ax + ay + bx + by)) continue
      const e = edgeBetween(ax, ay, bx, by, false)
      if (e !== null) out.push(e)
    }
  }
  return out
}

/** The edges of a subpath, closed implicitly back to its start, curves cut into lines. */
export function pathEdges(s: Sub, out: Edge[]): void {
  let [px, py] = s.start
  const push = (ax: number, ay: number, bx: number, by: number, placed: boolean): void => {
    const e = edgeBetween(ax, ay, bx, by, placed)
    if (e !== null) out.push(e)
  }
  for (const o of s.ops) {
    if (o.k === 'L') push(px, py, o.x, o.y, false)
    else if (o.k === 'Q') for (const q of splitQuad([px, py], [o.cx, o.cy], [o.x, o.y])) quadEdges(q, push)
    else for (const c of splitCubic([px, py], [o.c1x, o.c1y], [o.c2x, o.c2y], [o.x, o.y])) cubicEdges(c, push)
    px = o.x
    py = o.y
  }
  push(px, py, s.start[0], s.start[1], false)
}

type PushLine = (ax: number, ay: number, bx: number, by: number, placed: boolean) => void

// --- subdividing curves --------------------------------------------------------------------------------------------

/** Fixed point with 8 fractional bits; `>> 6` of it is a quarter pixel. */
const fixed = (v: number): number => Math.round(v * 256)
/** Do both ends fall in the same quarter row (so the curve is a flat line to the scan)? */
const sameQuarterRow = (ay: number, by: number): boolean => ((fixed(ay) + 32) >> 6) === ((fixed(by) + 32) >> 6)

/** An inexpensive overestimate of the length of (dx, dy), in fixed point. */
const approxLength = (dx: number, dy: number): number => {
  dx = Math.abs(dx)
  dy = Math.abs(dy)
  return dx > dy ? dx + (dy >> 1) : dy + (dx >> 1)
}

/** log4 of the sag, in quarter-row units: 0 for a sag under 1/2 of them, one more for every factor of 4. */
function sagShift(dx: number, dy: number): number {
  const units = (approxLength(dx, dy) + (1 << 4)) >> (3 + 2)
  return (32 - Math.clz32(units)) >> 1
}

const MAX_SHIFT = 6

/** How far the points at 1/3 and 2/3 of a cubic (one coordinate) sit from the chord's, a fixed-point estimate. */
const cubicSag = (a: number, b: number, c: number, d: number): number => {
  const atOneThird = ((a * 8 - b * 15 + 6 * c + d) * 19) >> 9
  const atTwoThirds = ((a + 6 * b - c * 15 + d * 8) * 19) >> 9
  return Math.max(Math.abs(atOneThird), Math.abs(atTwoThirds))
}

function quadEdges(q: [Pt, Pt, Pt], push: PushLine): void {
  const [p0, p1, p2] = q
  if (sameQuarterRow(p0[1], p2[1])) { push(p0[0], p0[1], p2[0], p2[1], false); return }
  const x0 = fixed(p0[0]), x1 = fixed(p1[0]), x2 = fixed(p2[0])
  const y0 = fixed(p0[1]), y1 = fixed(p1[1]), y2 = fixed(p2[1])
  let shift = sagShift(((x1 << 1) - x0 - x2) >> 2, ((y1 << 1) - y0 - y2) >> 2)
  if (shift === 0) shift = 1
  else if (shift > MAX_SHIFT) shift = MAX_SHIFT
  const n = 1 << shift
  const top = quarterRow(p0[1])
  let ax = p0[0]
  let ay = top
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const bx = i === n ? p2[0] : u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
    const by = i === n ? quarterRow(p2[1]) : top + (u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1] - p0[1])
    push(ax, ay, bx, by, true)
    ax = bx
    ay = by
  }
}

function cubicEdges(c: [Pt, Pt, Pt, Pt], push: PushLine): void {
  const [p0, p1, p2, p3] = c
  if (sameQuarterRow(p0[1], p3[1])) { push(p0[0], p0[1], p3[0], p3[1], false); return }
  const dx = cubicSag(fixed(p0[0]), fixed(p1[0]), fixed(p2[0]), fixed(p3[0]))
  const dy = cubicSag(fixed(p0[1]), fixed(p1[1]), fixed(p2[1]), fixed(p3[1]))
  const shift = Math.min(sagShift(dx, dy) + 1, MAX_SHIFT)
  const n = 1 << shift
  const top = quarterRow(p0[1])
  let ax = p0[0]
  let ay = top
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const w0 = u * u * u
    const w1 = 3 * u * u * t
    const w2 = 3 * u * t * t
    const w3 = t * t * t
    const bx = i === n ? p3[0] : w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0]
    const by = i === n ? quarterRow(p3[1]) : top + (w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1] - p0[1])
    push(ax, ay, bx, by, true)
    ax = bx
    ay = by
  }
}

/** A quad cut where its y turns around (at most once), so every piece is monotonic in y. */
function splitQuad(p0: Pt, p1: Pt, p2: Pt): Array<[Pt, Pt, Pt]> {
  const a = p0[1] - p1[1]
  const b = p1[1] - p2[1]
  if (a * b < 0) {
    const t = a / (p0[1] - 2 * p1[1] + p2[1])
    if (t > 0 && t < 1) {
      const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      const ab = lerp(p0, p1)
      const bc = lerp(p1, p2)
      const mid = lerp(ab, bc)
      return [[p0, ab, mid], [mid, bc, p2]]
    }
  }
  return [[p0, p1, p2]]
}

/** A cubic cut where its y turns around (at most twice), so every piece is monotonic in y. */
function splitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Array<[Pt, Pt, Pt, Pt]> {
  // the turning points are the roots of y'(t) = A t^2 + B t + C
  const A = p3[1] - p0[1] + 3 * (p1[1] - p2[1])
  const B = 2 * (p0[1] - p1[1] - p1[1] + p2[1])
  const C = p1[1] - p0[1]
  const roots: number[] = []
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) roots.push(-C / B)
  } else {
    const disc = B * B - 4 * A * C
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      roots.push((-B - sq) / (2 * A), (-B + sq) / (2 * A))
    }
  }
  const cuts = roots.filter((t) => t > 0 && t < 1).sort((u, v) => u - v)
  if (!cuts.length) return [[p0, p1, p2, p3]]
  const pieces: Array<[Pt, Pt, Pt, Pt]> = []
  let rest: [Pt, Pt, Pt, Pt] = [p0, p1, p2, p3]
  let done = 0 // the parameter of the original curve at which `rest` starts
  for (const cut of cuts) {
    const t = (cut - done) / (1 - done)
    const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    const ab = lerp(rest[0], rest[1])
    const bc = lerp(rest[1], rest[2])
    const cd = lerp(rest[2], rest[3])
    const abc = lerp(ab, bc)
    const bcd = lerp(bc, cd)
    const mid = lerp(abc, bcd)
    pieces.push([rest[0], ab, abc, mid])
    rest = [mid, bcd, cd, rest[3]]
    done = cut
  }
  pieces.push(rest)
  return pieces
}

// --- arcs: conics, then quads --------------------------------------------------------------------------------------

/** A rational quadratic: control points and the weight of the middle one. */
export interface Conic { p0: Pt; p1: Pt; p2: Pt; w: number }

/**
 * The conics (a quarter turn each, weight sqrt(1/2), and a last partial one) of the unit-circle arc from `from` towards `to`, in
 * direction `dir` (1: increasing angle). A `full` circle is four quarter turns. An arc too short to see (under 1/4096 of a unit in
 * the cross product, same way round) is no conics at all.
 */
export function arcConics(from: Pt, to: Pt, dir: 1 | -1, full: boolean): Conic[] {
  // express `to` in the frame where `from` is (1, 0)
  let x = from[0] * to[0] + from[1] * to[1]
  let y = from[0] * to[1] - from[1] * to[0]
  if (!full && Math.abs(y) <= 1.0 / 4096 && x > 0 && ((y >= 0 && dir === 1) || (y <= 0 && dir === -1))) return []
  if (dir === -1) y = -y
  let quadrants = 0
  if (full) { quadrants = 4; x = 1; y = 0 } else if (y === 0) quadrants = 2
  else if (x === 0) quadrants = y > 0 ? 1 : 3
  else {
    if (y < 0) quadrants += 2
    if ((x < 0) !== (y < 0)) quadrants += 1
  }
  const ring: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const conics: Conic[] = []
  for (let i = 0; i < quadrants; i++) conics.push({ p0: ring[i * 2]!, p1: ring[i * 2 + 1]!, p2: ring[(i * 2 + 2) % 8]!, w: Math.SQRT1_2 })
  if (!full) {
    const edge = ring[quadrants * 2]!
    const dot = edge[0] * x + edge[1] * y
    if (dot < 1) {
      // the remaining wedge: its middle control point sits where the tangents meet, its weight is the cosine of half the angle
      let mx = edge[0] + x
      let my = edge[1] + y
      const cosHalf = Math.sqrt((1 + dot) / 2)
      const len = Math.hypot(mx, my)
      mx = mx / len / cosHalf
      my = my / len / cosHalf
      if (Math.abs(edge[0] - mx) > 1.0 / 4096 || Math.abs(edge[1] - my) > 1.0 / 4096) conics.push({ p0: edge, p1: [mx, my], p2: [x, y], w: cosHalf })
    }
  }
  // rotate into the arc's own frame (and mirror it for the other direction)
  const [c, s] = from
  const place = (p: Pt): Pt => {
    const py = dir === -1 ? -p[1] : p[1]
    return [c * p[0] - s * py, s * p[0] + c * py]
  }
  return conics.map((k) => ({ p0: place(k.p0), p1: place(k.p1), p2: place(k.p2), w: k.w }))
}

/** The quads (control point, end point) a conic is split into so that none strays more than `tolerance` from it (at most 32). */
export function conicQuads(c: Conic, tolerance: number): Array<[number, number, number, number]> {
  const a = c.w - 1
  const k = a / (4 * (2 + a))
  const ex = k * (c.p0[0] - 2 * c.p1[0] + c.p2[0])
  const ey = k * (c.p0[1] - 2 * c.p1[1] + c.p2[1])
  // halving a conic cuts its distance from the quad through the same control points by 4
  let error = Math.sqrt(ex * ex + ey * ey)
  let levels = 0
  for (; levels < 5; ++levels) {
    if (error <= tolerance) break
    error *= 0.25
  }
  const out: Array<[number, number, number, number]> = []
  const halve = (k2: Conic, level: number): void => {
    if (level === 0) { out.push([k2.p1[0], k2.p1[1], k2.p2[0], k2.p2[1]]); return }
    const scale = 1 / (1 + k2.w)
    const newW = Math.sqrt(0.5 + k2.w * 0.5)
    const wp1: Pt = [k2.w * k2.p1[0], k2.w * k2.p1[1]]
    const m: Pt = [((k2.p0[0] + 2 * wp1[0] + k2.p2[0]) * scale) / 2, ((k2.p0[1] + 2 * wp1[1] + k2.p2[1]) * scale) / 2]
    halve({ p0: k2.p0, p1: [(k2.p0[0] + wp1[0]) * scale, (k2.p0[1] + wp1[1]) * scale], p2: m, w: newW }, level - 1)
    halve({ p0: m, p1: [(wp1[0] + k2.p2[0]) * scale, (wp1[1] + k2.p2[1]) * scale], p2: k2.p2, w: newW }, level - 1)
  }
  halve(c, levels)
  return out
}
