/**
 * SVG path-data parsing and replay, shared by the canvas renderer (canvas.ts) and the hit index (hit.ts).
 *
 * It lives apart from canvas.ts so that hit testing does not pull the renderer into a bundle: an app that uses
 * `@aster/core/hit` (tooltips, point selection) but never draws to a canvas must not contain `@aster/core/canvas`.
 * `@aster/core/canvas` re-exports these names, so its public surface is unchanged.
 */

// ---------------------------------------------------------------------------
// Path-data parsing: our geometry helpers emit SVG path data; the canvas
// renderer replays the same commands so both backends share one geometry
// source. Supports the subset vega/d3-shape emit: M L H V C S Q T A Z (+relative).
// ---------------------------------------------------------------------------

export type PathSeg =
  | { cmd: 'M' | 'm'; x: number; y: number }
  | { cmd: 'L' | 'l'; x: number; y: number }
  | { cmd: 'H' | 'h'; x: number }
  | { cmd: 'V' | 'v'; y: number }
  | { cmd: 'C' | 'c'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { cmd: 'S' | 's'; c2x: number; c2y: number; x: number; y: number }
  | { cmd: 'Q' | 'q'; cx: number; cy: number; x: number; y: number }
  | { cmd: 'T' | 't'; x: number; y: number }
  | { cmd: 'A' | 'a'; rx: number; ry: number; rot: number; large: number; sweep: number; x: number; y: number }
  | { cmd: 'Z' | 'z' }

const ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
}

/** Bounded cache: many marks reuse one path string (symbols, axes, legends). */
const PATH_CACHE = new Map<string, PathSeg[]>()
const PATH_CACHE_MAX = 4096


/** Parse an SVG path `d` string into absolute-command segments. */
export function parsePathData(d: string): PathSeg[] {
  const cached = PATH_CACHE.get(d)
  if (cached) return cached
  const segs = parsePathDataUncached(d)
  if (PATH_CACHE.size >= PATH_CACHE_MAX) PATH_CACHE.clear()
  PATH_CACHE.set(d, segs)
  return segs
}

function parsePathDataUncached(d: string): PathSeg[] {
  const segs: PathSeg[] = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/g
  let m: RegExpExecArray | null
  const tokens: string[] = []
  while ((m = re.exec(d))) tokens.push(m[0] as string)
  let i = 0
  let cmd = ''
  const next = (): number => {
    const t = tokens[i++]
    return t == null ? NaN : Number(t)
  }
  while (i < tokens.length) {
    const t = tokens[i] as string
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(t)) {
      cmd = t
      i++
      if (cmd === 'Z' || cmd === 'z') {
        segs.push({ cmd: 'Z' })
        continue
      }
    } else if (!cmd) {
      i++
      continue
    }
    const up = cmd.toUpperCase()
    const n = (Object.hasOwn(ARG_COUNT, up) ? ARG_COUNT[up] : undefined) ?? 0
    const a: number[] = []
    for (let k = 0; k < n; k++) a.push(next())
    const rel = cmd !== cmd.toUpperCase()
    const U = cmd.toUpperCase()
    switch (U) {
      case 'M':
      case 'L': {
        let x = a[0]!, y = a[1]!
        if (rel && segs.length) {
          const p = lastPoint(segs)
          x += p.x; y += p.y
        }
        segs.push({ cmd: U === 'M' ? 'M' : 'L', x, y })
        // implicit LineTo continuation for M
        if (U === 'M') cmd = rel ? 'l' : 'L'
        break
      }
      case 'H': {
        let x = a[0]!
        if (rel) x += lastPoint(segs).x
        segs.push({ cmd: 'H', x })
        break
      }
      case 'V': {
        let y = a[0]!
        if (rel) y += lastPoint(segs).y
        segs.push({ cmd: 'V', y })
        break
      }
      case 'C': {
        let [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
        if (rel) {
          const p = lastPoint(segs)
          c1x += p.x; c1y += p.y; c2x += p.x; c2y += p.y; x += p.x; y += p.y
        }
        segs.push({ cmd: 'C', c1x, c1y, c2x, c2y, x, y })
        break
      }
      case 'S': {
        let [c2x, c2y, x, y] = a as [number, number, number, number]
        if (rel) {
          const p = lastPoint(segs)
          c2x += p.x; c2y += p.y; x += p.x; y += p.y
        }
        segs.push({ cmd: 'S', c2x, c2y, x, y })
        break
      }
      case 'Q': {
        let [cx, cy, x, y] = a as [number, number, number, number]
        if (rel) {
          const p = lastPoint(segs)
          cx += p.x; cy += p.y; x += p.x; y += p.y
        }
        segs.push({ cmd: 'Q', cx, cy, x, y })
        break
      }
      case 'T': {
        let x = a[0]!, y = a[1]!
        if (rel) {
          const p = lastPoint(segs)
          x += p.x; y += p.y
        }
        segs.push({ cmd: 'T', x, y })
        break
      }
      case 'A': {
        let [rx, ry, rot, large, sweep, x, y] = a as [number, number, number, number, number, number, number]
        if (rel) {
          const p = lastPoint(segs)
          x += p.x; y += p.y
        }
        segs.push({ cmd: 'A', rx, ry, rot, large, sweep, x, y })
        break
      }
    }
  }
  return segs
}

/**
 * Current point after a sequence of parsed segments. H/V carry only one
 * coordinate, so the other must be carried forward from the previous segment —
 * returning `{x, y: 0}` for an H (or `{x: 0, y}` for a V) makes the next
 * relative command jump to the origin (rect paths are `M…h…v…h…Z`).
 */
function lastPoint(segs: PathSeg[]): { x: number; y: number } {
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  for (const s of segs) {
    switch (s.cmd) {
      case 'M': x = s.x; y = s.y; startX = x; startY = y; break
      case 'L': case 'T': x = s.x; y = s.y; break
      case 'H': x = s.x; break
      case 'V': y = s.y; break
      case 'C': case 'S': case 'Q': case 'A': x = s.x; y = s.y; break
      case 'Z': x = startX; y = startY; break
    }
  }
  return { x, y }
}

/** The part of a 2D context that path tracing needs (so geometry consumers can flatten a path without a canvas). */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  closePath(): void
}

/** Replay parsed segments onto a canvas context, offset by (tx, ty). */
export function tracePath(ctx: PathSink, segs: PathSeg[], tx = 0, ty = 0): void {
  // Track the current point and the last cubic/quadratic control point for
  // S/T smoothing, mirroring the SVG path semantics.
  let cx = 0, cy = 0
  let lastC: { x: number; y: number } | null = null
  let lastQ: { x: number; y: number } | null = null
  for (const s of segs) {
    switch (s.cmd) {
      case 'M': ctx.moveTo(s.x + tx, s.y + ty); cx = s.x; cy = s.y; lastC = lastQ = null; break
      case 'L': ctx.lineTo(s.x + tx, s.y + ty); cx = s.x; cy = s.y; lastC = lastQ = null; break
      case 'H': ctx.lineTo(s.x + tx, cy + ty); cx = s.x; lastC = lastQ = null; break
      case 'V': ctx.lineTo(cx + tx, s.y + ty); cy = s.y; lastC = lastQ = null; break
      case 'C':
        ctx.bezierCurveTo(s.c1x + tx, s.c1y + ty, s.c2x + tx, s.c2y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastC = { x: s.c2x, y: s.c2y }; lastQ = null
        break
      case 'S': {
        const c1 = lastC ? { x: 2 * cx - lastC.x, y: 2 * cy - lastC.y } : { x: cx, y: cy }
        ctx.bezierCurveTo(c1.x + tx, c1.y + ty, s.c2x + tx, s.c2y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastC = { x: s.c2x, y: s.c2y }; lastQ = null
        break
      }
      case 'Q':
        ctx.quadraticCurveTo(s.cx + tx, s.cy + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastQ = { x: s.cx, y: s.cy }; lastC = null
        break
      case 'T': {
        const c: { x: number; y: number } = lastQ ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y } : { x: cx, y: cy }
        ctx.quadraticCurveTo(c.x + tx, c.y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastQ = c; lastC = null
        break
      }
      case 'A': {
        // Convert the SVG endpoint arc to canvas arc parameters.
        const x1 = cx, y1 = cy
        const x2 = s.x, y2 = s.y
        const rx = Math.abs(s.rx), ry = Math.abs(s.ry)
        const phi = (s.rot * Math.PI) / 180
        if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
          ctx.lineTo(x2 + tx, y2 + ty)
        } else {
          // Per the SVG spec (F.6.5): convert endpoints to center parameterization.
          const cosP = Math.cos(phi), sinP = Math.sin(phi)
          const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
          const x1p = cosP * dx + sinP * dy
          const y1p = -sinP * dx + cosP * dy
          const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
          const scale = lambda > 1 ? Math.sqrt(lambda) : 1
          const rxp = rx * scale, ryp = ry * scale
          const sign = s.large !== s.sweep ? 1 : -1
          const denom = rxp * rxp * y1p * y1p + ryp * ryp * x1p * x1p
          const cNum = Math.max(0, rxp * rxp * ryp * ryp - denom)
          const cCoef = Math.sqrt(denom > 0 ? cNum / denom : 0) * sign
          const cxp = (cCoef * rxp * y1p) / ryp
          const cyp = (-cCoef * ryp * x1p) / rxp
          const ccx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
          const ccy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
          // Angles from the center to the endpoints (in the rotated frame).
          const ang = (ux: number, uy: number, vx: number, vy: number): number => {
            const dot = ux * vx + uy * vy
            const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
            let a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))))
            if (ux * vy - uy * vx < 0) a = -a
            return a
          }
          const theta1 = ang(1, 0, (x1p - cxp) / rxp, (y1p - cyp) / ryp)
          let dTheta = ang((x1p - cxp) / rxp, (y1p - cyp) / ryp, (-x1p - cxp) / rxp, (-y1p - cyp) / ryp)
          if (!s.sweep && dTheta > 0) dTheta -= 2 * Math.PI
          if (s.sweep && dTheta < 0) dTheta += 2 * Math.PI
          // canvas arc angles are in the un-rotated frame; rotate the center
          // parameterization angles back by -phi and draw with an ellipse-like
          // transform. Since our geometry only emits circular arcs (rx === ry)
          // or circles, draw via arc with the rotated start angle; for rx===ry
          // the rotation only shifts the start angle by phi.
          const start = theta1 + phi
          const end = start + dTheta
          if (Math.abs(rx - ry) < 1e-9) {
            ctx.arc(ccx + tx, ccy + ty, rx, start, end, dTheta < 0)
          } else {
            // Elliptical arc: approximate with an ellipse transform via
            // bezier segments (rare; our marks emit circular arcs).
            traceEllipse(ctx, ccx + tx, ccy + ty, rxp, ryp, phi, start, end)
          }
        }
        cx = x2; cy = y2
        lastC = lastQ = null
        break
      }
      case 'Z': ctx.closePath(); break
    }
  }
}

/** Draw an elliptical arc segment as an ellipse-transformed arc. */
function traceEllipse(ctx: PathSink, cx: number, cy: number, rx: number, ry: number, phi: number, start: number, end: number): void {
  // Sample the ellipse as small line segments (fallback path; not used by
  // vega marks, which emit circular arcs).
  const steps = 64
  const span = end - start
  const n = Math.max(2, Math.ceil((Math.abs(span) / (2 * Math.PI)) * steps))
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  for (let i = 0; i <= n; i++) {
    const a = start + (span * i) / n
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a)
    const x = cx + ex * cosP - ey * sinP
    const y = cy + ex * sinP + ey * cosP
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
}
