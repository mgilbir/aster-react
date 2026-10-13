/**
 * Scene -> Canvas2D renderer (R9.1). Both backends render the same scene, so
 * the engine stays single-sourced: the walk mirrors `render.ts` (same group
 * traversal, same shared geometry helpers) and only the final paint differs.
 *
 * The renderer accepts a minimal 2D-context interface (`CanvasLike`), so it
 * runs against a real `CanvasRenderingContext2D`, an OffscreenCanvas context,
 * or a recording mock in tests. Geometry is traced by replaying SVG path data
 * (`parsePathData` + `tracePath`), which keeps canvas output bit-identical to
 * the SVG path by construction.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

interface SceneDefs { id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }
import {
  computeAreaPath,
  computeLinePath,
  num,
  rectItemPath,
  symbolPath,
  textItemDesc,
  trailPath,
  arcPath,
} from './render.js'

/** Minimal 2D context surface used by the renderer. */
export interface CanvasLike {
  save(): void
  restore(): void
  translate(x: number, y: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  rotate(angle: number): void
  clip(fillRule?: 'nonzero' | 'evenodd'): void
  fill(fillRule?: 'nonzero' | 'evenodd'): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  setLineDash(dashes: number[]): void
  // `maxWidthOrMulti` doubles as the multi-line marker (renderers pass a
  // boolean when the item has wrapped lines); the DOM `maxWidth` overload is
  // never used by this renderer.
  fillText(text: string, x: number, y: number, maxWidthOrMulti?: number | boolean): void
  drawImage?(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike
  scale(x: number, y: number): void
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  lineWidth: number
  lineCap: string
  lineJoin: string
  miterLimit: number
  font: string
  textAlign: string
  textBaseline: string
}

export interface GradientLike {
  addColorStop(offset: number, color: string): void
}

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

/** Parse an SVG path `d` string into absolute-command segments. */
export function parsePathData(d: string): PathSeg[] {
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
    const n = ARG_COUNT[cmd.toUpperCase()] ?? 0
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

function lastPoint(segs: PathSeg[]): { x: number; y: number } {
  for (let j = segs.length - 1; j >= 0; j--) {
    const s = segs[j]!
    if ('x' in s && 'y' in s) return { x: s.x, y: s.y }
    if ('x' in s) return { x: s.x, y: 0 }
  }
  return { x: 0, y: 0 }
}

/** Canonical form of parsed segments (shared by both parity sides). */
export function canonicalPath(segs: PathSeg[]): string {
  return segs.map((s) => {
    switch (s.cmd) {
      case 'M': case 'L': return `${s.cmd}${num(s.x)},${num(s.y)}`
      case 'H': return `H${num(s.x)}`
      case 'V': return `V${num(s.y)}`
      case 'C': return `C${num(s.c1x)},${num(s.c1y)},${num(s.c2x)},${num(s.c2y)},${num(s.x)},${num(s.y)}`
      case 'S': return `S${num(s.c2x)},${num(s.c2y)},${num(s.x)},${num(s.y)}`
      case 'Q': return `Q${num(s.cx)},${num(s.cy)},${num(s.x)},${num(s.y)}`
      case 'T': return `T${num(s.x)},${num(s.y)}`
      case 'A': return `A${num(s.rx)},${num(s.ry)},${num(s.rot)},${s.large},${s.sweep},${num(s.x)},${num(s.y)}`
      case 'Z': return 'Z'
    }
  }).join('')
}

/** Replay parsed segments onto a canvas context, offset by (tx, ty). */
export function tracePath(ctx: CanvasLike, segs: PathSeg[], tx = 0, ty = 0): void {
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
function traceEllipse(ctx: CanvasLike, cx: number, cy: number, rx: number, ry: number, phi: number, start: number, end: number): void {
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

// ---------------------------------------------------------------------------
// Scene walk (mirrors render.ts)
// ---------------------------------------------------------------------------

export interface RenderCanvasOptions {
  /** Device pixel ratio: scales the context transform (R9.2 uses this). */
  dpr?: number
}

export function renderSceneToCanvas(scene: SceneRoot, ctx: CanvasLike, opts: RenderCanvasOptions = {}): void {
  const W = scene.width
  const H = scene.height
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  ctx.save()
  if (opts.dpr != null && opts.dpr !== 1) {
    ctx.scale(opts.dpr, opts.dpr)
  }
  ctx.miterLimit = 4

  // View background
  if (scene.background) {
    ctx.fillStyle = scene.background
    ctx.fillRect(0, 0, W, H)
  }
  ctx.translate(pad.left, pad.top)

  // Root frame background path (stroked only when frameStroke is set)
  ctx.beginPath()
  const frameD = scene.frameStroke
    ? `M0.5,0.5h${plotW}v${plotH}h-${plotW}Z`
    : `M0,0h${plotW}v${plotH}h-${plotW}Z`
  tracePath(ctx, parsePathData(frameD))
  if (scene.frameStroke) {
    ctx.strokeStyle = scene.frameStroke
    ctx.stroke()
  }

  for (const node of scene.items) {
    renderGroup(node, ctx, scene, plotW, plotH)
  }
  ctx.restore()
}

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

function renderGroup(group: SceneGroup, ctx: CanvasLike, scene: SceneRoot, plotW: number, plotH: number): void {
  const type = group.marktype
  if (!type || type === 'group') {
    ctx.save()
    if (group.x != null || group.y != null) ctx.translate(group.x ?? 0, group.y ?? 0)
    if (group.clip === true) {
      ctx.beginPath()
      if (group.clipPathD) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
      else ctx.rect(0, 0, plotW, plotH)
      ctx.clip()
    }
    for (const item of group.items ?? []) {
      if (isGroup(item)) renderGroup(item, ctx, scene, plotW, plotH)
      else renderLeafItem(item, ctx, scene)
    }
    ctx.restore()
    return
  }
  if (group.clip === true) {
    ctx.save()
    ctx.beginPath()
    if (group.clipPathD) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
    else ctx.rect(0, 0, plotW, plotH)
    ctx.clip()
    renderMark(type, group, ctx, scene)
    ctx.restore()
    return
  }
  renderMark(type, group, ctx, scene)
}

/** Resolve a paint value; `{gradient: id}` resolves through scene defs. */
function resolvePaint(
  paint: string | { gradient: string } | undefined,
  ctx: CanvasLike,
  defs: SceneDefs[] | undefined,
  bbox: { x1: number; y1: number; x2: number; y2: number } | null,
): unknown {
  if (paint == null) return undefined
  let id: string | undefined
  if (typeof paint === 'string') {
    // Scene items reference gradients as `url(#gradient_N)` (matching the SVG
    // serialization); resolve through the scene defs.
    const mm = /^url\(#([^)]+)\)$/.exec(paint)
    if (!mm) return paint
    id = mm[1]!
  } else {
    id = paint.gradient
  }
  const def = defs?.find((d) => d.id === id)
  if (!def || !bbox) {
    // Dangling gradient reference (no def): pass the reference through so the
    // record matches the SVG serialization.
    return typeof paint === 'string' ? paint : undefined
  }
  const w = bbox.x2 - bbox.x1
  const h = bbox.y2 - bbox.y1
  const horiz = def.direction === 'horizontal'
  // SVG objectBoundingBox fractions applied to the element's bbox.
  const fx0 = horiz ? 0 : 0, fy0 = horiz ? 0 : 1
  const fx1 = horiz ? 1 : 0, fy1 = horiz ? 0 : 0
  const g = ctx.createLinearGradient(
    bbox.x1 + fx0 * w, bbox.y1 + fy0 * h,
    bbox.x1 + fx1 * w, bbox.y1 + fy1 * h,
  )
  for (const stop of def.colorStops) g.addColorStop(stop.offset, stop.color)
  ;(g as unknown as { __gradId?: string }).__gradId = id
  return g
}

interface Bbox { x1: number; y1: number; x2: number; y2: number }

/** Compute the bbox of parsed segments (for objectBoundingBox gradients). */
function segsBbox(segs: PathSeg[]): Bbox {
  const bb: Bbox = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  const add = (x: number, y: number): void => {
    if (x < bb.x1) bb.x1 = x
    if (y < bb.y1) bb.y1 = y
    if (x > bb.x2) bb.x2 = x
    if (y > bb.y2) bb.y2 = y
  }
  let cx = 0, cy = 0
  for (const s of segs) {
    if ('x' in s && 'y' in s) { add(s.x, s.y); cx = s.x; cy = s.y }
    else if ('x' in s) { add(s.x, cy); cx = s.x }
    else if ('y' in s) { add(cx, s.y); cy = s.y }
    if ('c1x' in s) { add(s.c1x, s.c1y); add(s.c2x, s.c2y) }
    if ('c2x' in s && !('c1x' in s)) { add(s.c2x, s.c2y) }
    if ('cx' in s && !('c2x' in s) && !('c1x' in s)) { add(s.cx, s.cy) }
  }
  if (!Number.isFinite(bb.x1)) return { x1: 0, y1: 0, x2: 0, y2: 0 }
  return bb
}

/** Paint a traced path: fill and/or stroke per the item's paints. */
function paintPath(
  ctx: CanvasLike,
  segs: PathSeg[],
  it: SceneItem,
  defs: SceneDefs[] | undefined,
  op: 'auto' | 'fill' | 'stroke',
  honorStrokeOpacity = false,
): void {
  const bb = segsBbox(segs)
  const opacity = (it.opacity ?? 1) as number
  const fill = op === 'stroke' ? undefined : it.fill
  const stroke = op === 'fill' ? undefined : it.stroke
  if (fill != null && fill !== 'transparent') {
    ctx.globalAlpha = opacity * ((it.fillOpacity ?? 1) as number)
    const paint = resolvePaint(fill, ctx, defs, bb)
    // Dangling references and non-string paints serialize as their string form.
    ctx.fillStyle = (paint !== undefined ? paint : String(fill)) as string
    ctx.fill()
  }
  if (stroke != null && stroke !== 'transparent') {
    // Only the area renderer surfaces stroke-opacity (mirroring the SVG
    // renderer, and vega's own per-mark attribute emission).
    ctx.globalAlpha = opacity * (honorStrokeOpacity ? ((it.strokeOpacity ?? 1) as number) : 1)
    const paint = resolvePaint(stroke, ctx, defs, bb)
    if (paint !== undefined) ctx.strokeStyle = paint
    ctx.lineWidth = (it.strokeWidth ?? 1) as number
    if (it.strokeDash != null) ctx.setLineDash(it.strokeDash as number[])
    else ctx.setLineDash([])
    if (it.strokeLineCap) ctx.lineCap = it.strokeLineCap
    if (it.strokeLineJoin) ctx.lineJoin = it.strokeLineJoin
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.globalAlpha = 1
}

function fontString(it: SceneItem): string {
  const fontSize = (it as Record<string, unknown>).fontSize as number | undefined ?? 11
  const fontWeight = (it as Record<string, unknown>).fontWeight as string | number | undefined
  const fontStyle = (it as Record<string, unknown>).fontStyle as string | undefined
  const family = (it as Record<string, unknown>).font as string | undefined ?? 'sans-serif'
  const parts: string[] = []
  if (fontStyle) parts.push(String(fontStyle))
  if (fontWeight != null) parts.push(String(fontWeight))
  parts.push(`${fontSize}px`)
  parts.push(family)
  return parts.join(' ')
}

function renderLeafItem(it: SceneItem, ctx: CanvasLike, scene: SceneRoot): void {
  const defs = scene.defs
  // Path items (legend entries, tick labels' misc paths)
  if (it.path != null) {
    const tx = it.x ?? 0
    const ty = it.y ?? 0
    ctx.beginPath()
    const segs = parsePathData(it.path)
    tracePath(ctx, segs, tx, ty)
    paintPath(ctx, segs, it, defs, 'auto')
    return
  }
  // Symbol items (circle arc path): the SVG leaf renderer draws
  // `M{r},0A{r},{r}…` translated by (x, y) — trace the same path so records
  // match exactly (including gradient bboxes).
  if (it.shape != null && it.radius != null) {
    const r = it.radius
    const rNum = Number.isInteger(r) ? String(r) : String(Math.round(r * 1000) / 1000)
    const d = `M${rNum},0A${rNum},${rNum},0,1,1,${-rNum},0A${rNum},${rNum},0,1,1,${rNum},0`
    ctx.beginPath()
    const segs = parsePathData(d).map((s) => {
      if (s.cmd === 'Z') return s
      const o = { ...s } as unknown as Record<string, number>
      if (typeof o.x === 'number') o.x += it.x ?? 0
      if (typeof o.y === 'number') o.y += it.y ?? 0
      return o as unknown as typeof s
    })
    tracePath(ctx, segs)
    paintPath(ctx, segs, it, defs, 'auto')
    return
  }
  if (it.text != null) {
    renderTextItem(it, ctx, defs, true)
    return
  }
  // Line items (rules)
  const x = it.x ?? 0
  const y = it.y ?? 0
  const x2 = it.x2 ?? x
  const y2 = it.y2 ?? y
  if (it.stroke == null) return
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x2, y2)
  paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke')
}

/** Paint for arc-drawn symbols (bbox computed analytically). */
function paintPathArc(ctx: CanvasLike, it: SceneItem, defs: SceneDefs[] | undefined): void {
  const cx = it.x ?? 0
  const cy = it.y ?? 0
  const r = it.radius ?? 0
  const bb = { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r }
  const opacity = (it.opacity ?? 1) as number
  if (it.fill != null && it.fill !== 'transparent') {
    ctx.globalAlpha = opacity * ((it.fillOpacity ?? 1) as number)
    const paint = resolvePaint(it.fill, ctx, defs, bb)
    if (paint !== undefined) ctx.fillStyle = paint
    ctx.fill()
  }
  if (it.stroke != null && it.stroke !== 'transparent') {
    ctx.globalAlpha = opacity * ((it.strokeOpacity ?? 1) as number)
    const paint = resolvePaint(it.stroke, ctx, defs, bb)
    if (paint !== undefined) ctx.strokeStyle = paint
    ctx.lineWidth = (it.strokeWidth ?? 1) as number
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/**
 * Draw one text item. Group leaves (axis/legend labels) carry pre-baked
 * positions and render at their raw x/y — mirroring the SVG leaf renderer.
 * Text-mark items go through textItemDesc, which computes the baseline
 * offset (and dx/dy/angle/limit handling) the same way the SVG mark
 * renderer does.
 */
function renderTextItem(it: SceneItem, ctx: CanvasLike, defs: SceneDefs[] | undefined, raw: boolean): void {
  let lines: string[]
  let x: number
  let y: number
  let angle: number | undefined
  let lineHeight: number
  if (raw) {
    if (it.text == null) return
    lines = [String(it.text)]
    x = it.x ?? 0
    y = it.y ?? 0
    angle = undefined
    lineHeight = 0
  } else {
    const d = textItemDesc(it)
    if (d == null) return
    lines = d.lines
    x = Number(d.x)
    y = Number(d.y)
    angle = it.angle
    const fontSize = (it as Record<string, unknown>).fontSize as number | undefined ?? 11
    lineHeight = (it as Record<string, unknown>).lineHeight as number | undefined ?? fontSize + 2
  }
  ctx.save()
  ctx.font = fontString(it)
  ctx.textAlign = it.align === 'right' ? 'right' : it.align === 'left' ? 'left' : 'center'
  ctx.textBaseline = 'alphabetic'
  const fill = it.fill ?? '#000'
  ctx.globalAlpha = (it.opacity ?? 1) as number
  const paint = resolvePaint(fill as string | { gradient: string }, ctx, defs, null)
  ctx.fillStyle = (paint ?? '#000') as string
  if (angle != null && angle !== 0) {
    ctx.translate(x, y)
    ctx.rotate((angle * Math.PI) / 180)
    ctx.fillText(lines[0]!, 0, 0)
    for (let i = 1; i < lines.length; i++) ctx.fillText(lines[i]!, 0, i * lineHeight)
  } else {
    const multi = lines.length > 1
    ctx.fillText(lines[0]!, x, y, multi)
    for (let i = 1; i < lines.length; i++) ctx.fillText(lines[i]!, x, y + i * lineHeight, multi)
  }
  ctx.restore()
}

function renderMark(type: string, group: SceneGroup, ctx: CanvasLike, scene: SceneRoot): void {
  const defs = scene.defs
  switch (type) {
    case 'line': {
      const info = computeLinePath(group)
      if (!info) return
      if (info.stroke == null) return
      ctx.beginPath()
      const segs = parsePathData(info.path)
      tracePath(ctx, segs)
      ctx.globalAlpha = info.opacity ?? 1
      ctx.strokeStyle = info.stroke as string
      ctx.lineWidth = info.sw ?? 2
      ctx.setLineDash(info.strokeDash ?? [])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      return
    }
    case 'area': {
      const info = computeAreaPath(group)
      if (!info) return
      ctx.beginPath()
      const segs = parsePathData(info.path)
      tracePath(ctx, segs)
      paintPath(ctx, segs, {
        fill: info.fill,
        fillOpacity: info.fillOpacity,
        stroke: info.stroke,
        strokeWidth: info.strokeWidth,
        strokeOpacity: info.strokeOpacity,
        opacity: (group.items?.[0] as SceneItem | undefined)?.opacity ?? 1,
      } as SceneItem, defs, 'auto', true)
      return
    }
    case 'symbol': {
      for (const it of group.items ?? []) {
        if (it.x == null || it.y == null) continue
        const size = (it.size as number) ?? 30
        const r = Math.sqrt(size) / 2
        const shape = (it as Record<string, unknown>).shape as string | undefined
        const d = symbolPath(shape, r)
        ctx.beginPath()
        const segs = parsePathData(d)
        tracePath(ctx, segs, it.x, it.y)
        paintPath(ctx, segs, it, defs, 'auto')
      }
      return
    }
    case 'circle': {
      for (const it of group.items ?? []) {
        if (it.x == null || it.y == null) continue
        const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? 30) / 2
        ctx.beginPath()
        ctx.arc(it.x, it.y, r, 0, 2 * Math.PI, false)
        paintPathArc(ctx, { ...it, radius: r }, defs)
      }
      return
    }
    case 'rect': {
      // vega paints rects in reverse item order and skips unpainted items
      for (const it of (group.items ?? []).slice().reverse()) {
        if (it.fill == null && it.stroke == null) continue
        const d = rectItemPath(it)
        if (d == null) continue
        ctx.beginPath()
        const segs = parsePathData(d)
        tracePath(ctx, segs)
        paintPath(ctx, segs, it, defs, 'auto')
      }
      return
    }
    case 'rule': {
      for (const it of group.items ?? []) {
        if (it.stroke == null) continue
        const x = it.x ?? 0
        const y = it.y ?? 0
        const x2 = it.x2 ?? x
        const y2 = it.y2 ?? y
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x2, y2)
        paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke')
      }
      return
    }
    case 'text': {
      for (const it of group.items ?? []) {
        renderTextItem(it, ctx, defs, false)
      }
      return
    }
    case 'trail': {
      const items = group.items ?? []
      if (items.length <= 1) return
      const d = trailPath(items)
      if (!d) return
      const first = items[0]!
      ctx.beginPath()
      const segs = parsePathData(d)
      tracePath(ctx, segs)
      // trail: stroked only (fill none)
      paintPath(ctx, segs, { ...first, fill: undefined } as SceneItem, defs, 'stroke')
      return
    }
    case 'path':
    case 'shape':
    case 'geoshape': {
      for (const it of group.items ?? []) {
        if (!it.path) continue
        const tx = it.x ?? 0
        const ty = it.y ?? 0
        ctx.beginPath()
        const segs = parsePathData(it.path)
        tracePath(ctx, segs, tx, ty)
        paintPath(ctx, segs, it, defs, 'auto')
      }
      return
    }
    case 'arc': {
      for (const it of group.items ?? []) {
        const x = it.x as number
        const y = it.y as number
        const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
        const r0 = (it.innerRadius as number) ?? 0
        const a0 = (it.startAngle as number) ?? 0
        const a1 = (it.endAngle as number) ?? 0
        ctx.beginPath()
        const segs = parsePathData(arcPath(x, y, r, r0, a0, a1))
        tracePath(ctx, segs)
        paintPath(ctx, segs, it, defs, 'auto')
      }
      return
    }
    case 'image':
      // Canvas image drawing requires loaded bitmaps; hosts that need image
      // marks pass loaded elements via the item (`it.image`). Skip otherwise.
      for (const it of group.items ?? []) {
        const img = (it as Record<string, unknown>).image as CanvasImageSource | undefined
        if (img == null || it.x == null || it.y == null) continue
        ctx.drawImage?.(img, it.x, it.y, (it.width as number) ?? 0, (it.height as number) ?? 0)
      }
      return
    default:
      return
  }
}
