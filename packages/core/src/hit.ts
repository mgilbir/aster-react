/**
 * Scene hit index (R10.1): resolves the mark item under a view coordinate
 * without walking the DOM — the canvas backend has no DOM to query, and the
 * SVG backend benefits from O(1) hover on dense scenes.
 *
 * Every entry is picked against the geometry the renderers paint (audit C47),
 * never a coarse stand-in: a point is a hit when it is inside the painted fill
 * or within the painted stroke (plus a 2px pointing slack), so a pie slice is
 * not found from the empty corner of its bounding box and a map region is found
 * anywhere inside its outline. Pick semantics mirror vega-scenegraph's per-mark
 * `pick`:
 *   rect        — inside the rect (its rounded outline, when it has corners)
 *   arc, path, shape, geoshape, area, trail — inside the fill outline or
 *                 within the stroke
 *   symbol/circle — inside the symbol's shape (circle: radius) or within the
 *                 stroke, plus slack
 *   rule        — within strokeWidth/2 + 2px of the segment
 *   line        — within strokeWidth/2 + 2px of the line (curve included); the
 *                 item returned is the nearest point of the line
 *   text        — inside the (rotated) text box, from the same bounds the
 *                 layout uses
 *   image       — inside its box
 *
 * A uniform grid buckets entries by bounding box; everything is also
 * resolvable by a linear scan for small scenes. Cell ranges are clamped to the
 * grid and an entry spanning too many cells (a huge item, a full-view
 * background) is kept in a short separate list instead of being replicated into
 * every cell (audit C41).
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { Bounds, boundText } from './bounds.js'
import { parsePathData, tracePath, type PathSink } from './canvas.js'
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import { arcPath, computeAreaPath, computeLinePath, rectItemPath, symbolPath, trailPath } from './render.js'

export interface HitTarget {
  item: SceneItem
  /** The enclosing mark group (marktype), for role/type checks. */
  marktype: string
}

/** Flattened outline: a flat [x0,y0,x1,y1,...] polyline, `closed` when it ended with a close. */
interface Poly { pts: number[]; closed: boolean }

interface Entry {
  item: SceneItem
  marktype: string
  /** bounds in scene coordinates, slack included */
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'point' | 'band' | 'text' | 'geom'
  /** point geometry: center + pick radius (circle symbols) */
  cx?: number
  cy?: number
  r?: number
  /** line/rule segment endpoints (scene coords) */
  seg?: Array<[number, number, number, number]>
  sw?: number
  /** text: the anchor and the rotation (radians) the local box is rotated by */
  rot?: number
  /** text: box in the unrotated frame around the anchor (cx, cy) */
  box?: [number, number, number, number]
  /** geom: outline builder (scene coords), filled and/or stroked */
  build?: () => Poly[]
  polys?: Poly[]
  fill?: boolean
  /** geom/point stroke tolerance: strokeWidth / 2 + slack, or 0 when not stroked */
  tol?: number
  /** line/area/trail: the item to report for a hit at (x, y) */
  resolve?: (x: number, y: number) => SceneItem
}

export interface HitIndex {
  query(x: number, y: number): HitTarget | null
  /**
   * Like `query`, but only data-bearing mark items. Guides (axis/legend text)
   * paint above marks and must not swallow clicks/tooltips.
   */
  queryMark(x: number, y: number): HitTarget | null
  /** Number of indexed mark items. */
  size(): number
}

const DEFAULT_CELL = 48
/** Pointing slack around painted geometry, in px (vega's pick uses a similar hit area). */
const SLACK = 2
/** An entry covering more grid cells than this lives in the `big` list. */
const MAX_CELLS_PER_ENTRY = 64
/** Cap on the grid itself, whatever the cell size / scene size. */
const MAX_GRID_CELLS = 1 << 20

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

const rec = (it: SceneItem): Record<string, unknown> => it as Record<string, unknown>

// ---------------------------------------------------------------------------
// Geometry: flatten path data, point-in-polygon, distance to outline
// ---------------------------------------------------------------------------

/** Collects a path as polylines; curves and arcs are flattened to short segments. */
class Flattener implements PathSink {
  polys: Poly[] = []
  private cur: number[] | null = null
  private x = 0
  private y = 0
  private startX = 0
  private startY = 0
  constructor(private readonly t: (x: number, y: number) => [number, number]) {}
  private start(x: number, y: number): void {
    const [tx, ty] = this.t(x, y)
    this.cur = [tx, ty]
    this.polys.push({ pts: this.cur, closed: false })
    this.x = x; this.y = y; this.startX = x; this.startY = y
  }
  private push(x: number, y: number): void {
    if (!this.cur) { this.start(x, y); return }
    const [tx, ty] = this.t(x, y)
    this.cur.push(tx, ty)
    this.x = x; this.y = y
  }
  moveTo(x: number, y: number): void { this.start(x, y) }
  lineTo(x: number, y: number): void { this.push(x, y) }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y
    const N = 12
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t
      this.push(
        u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      )
    }
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const x0 = this.x, y0 = this.y
    const N = 10
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t
      this.push(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
    }
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    let da = a1 - a0
    if (ccw) { if (da > 0) da = (da % (2 * Math.PI)) - 2 * Math.PI } else if (da < 0) da = (da % (2 * Math.PI)) + 2 * Math.PI
    if (Math.abs(da) > 2 * Math.PI) da = Math.sign(da) * 2 * Math.PI
    const N = Math.max(4, Math.ceil(Math.abs(da) / (Math.PI / 24)))
    this.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
    for (let i = 1; i <= N; i++) {
      const a = a0 + (da * i) / N
      this.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
    }
  }
  closePath(): void {
    if (!this.cur) return
    this.polys[this.polys.length - 1]!.closed = true
    // a new subpath after a close starts at the old start point
    this.cur = null
    this.x = this.startX; this.y = this.startY
  }
}

/** Flatten SVG path data under `t` (local -> scene). */
function flattenPath(d: string, t: (x: number, y: number) => [number, number]): Poly[] {
  const f = new Flattener(t)
  tracePath(f, parsePathData(d))
  return f.polys
}

/** Non-zero winding number of (x, y) over every polygon, each implicitly closed (canvas `fill()`). */
function insidePolys(polys: Poly[], x: number, y: number): boolean {
  let wn = 0
  for (const { pts } of polys) {
    const n = pts.length / 2
    if (n < 3) continue
    let ax = pts[2 * n - 2]!
    let ay = pts[2 * n - 1]!
    for (let i = 0; i < n; i++) {
      const bx = pts[2 * i]!
      const by = pts[2 * i + 1]!
      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wn++
      } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) wn--
      ax = bx; ay = by
    }
  }
  return wn !== 0
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** True when (x, y) is within `tol` of any outline segment (a closed polygon's closing edge included). */
function nearPolys(polys: Poly[], x: number, y: number, tol: number): boolean {
  for (const { pts, closed } of polys) {
    const n = pts.length / 2
    if (n === 1 && Math.hypot(x - pts[0]!, y - pts[1]!) <= tol) return true
    for (let i = 1; i < n; i++) {
      if (distToSegment(x, y, pts[2 * i - 2]!, pts[2 * i - 1]!, pts[2 * i]!, pts[2 * i + 1]!) <= tol) return true
    }
    if (closed && n > 2 && distToSegment(x, y, pts[2 * n - 2]!, pts[2 * n - 1]!, pts[0]!, pts[1]!) <= tol) return true
  }
  return false
}

function polysBox(polys: Poly[]): [number, number, number, number] | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const { pts } of polys) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]!, y = pts[i + 1]!
      if (x < x1) x1 = x
      if (x > x2) x2 = x
      if (y < y1) y1 = y
      if (y > y2) y2 = y
    }
  }
  return Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2) ? [x1, y1, x2, y2] : null
}

const isFilled = (it: { fill?: unknown }): boolean => it.fill != null && (it.fill as unknown) !== false
const isStroked = (it: { stroke?: unknown }): boolean => it.stroke != null && (it.stroke as unknown) !== false && it.stroke !== 'transparent'
const strokeTol = (it: { stroke?: unknown; strokeWidth?: unknown }): number =>
  (isStroked(it) ? (((it.strokeWidth as number | undefined) ?? 1) / 2) : 0) + SLACK

// ---------------------------------------------------------------------------

export function buildHitIndex(scene: SceneRoot, cell = DEFAULT_CELL): HitIndex {
  const entries: Entry[] = []
  // Rect-mark entries are collected per mark and flushed after it; every renderer
  // paints rect marks in item (data) order, like vega, so the list stays in paint order.
  const rectOrder: Entry[] = []
  const walk = (group: SceneGroup, tx: number, ty: number): void => {
    const gx = tx + (group.x ?? 0)
    const gy = ty + (group.y ?? 0)
    const type = group.marktype
    if (!type || type === 'group') {
      for (const item of group.items ?? []) {
        if (isGroup(item)) walk(item, gx, gy)
        else addLeaf(item, type ?? 'group', gx, gy)
      }
      return
    }
    switch (type) {
      case 'line': addLine(group, gx, gy); return
      case 'area': addArea(group, gx, gy); return
      case 'trail': addTrail(group, gx, gy); return
    }
    for (const item of group.items ?? []) addMarkItem(item, type, gx, gy)
  }
  // Scene items live in plot coordinates; pointer queries arrive in viewport
  // coordinates, so include the root padding translation (as the renderer does
  // with its top-level translate group).
  const padX = scene.padding?.left ?? 0
  const padY = scene.padding?.top ?? 0
  for (const node of scene.items) {
    walk(node, padX, padY)
    // Flush rect entries in paint order so the global list is strictly
    // paint-ordered and a single reverse scan yields the topmost.
    for (const e of rectOrder) entries.push(e)
    rectOrder.length = 0
  }

  /** Text entry from the layout's own text bounds, rotated about the anchor. */
  function textEntry(item: SceneItem, marktype: string, tx: number, ty: number, mark: boolean): Entry | null {
    const text = item.text
    if (text == null || text === '' || (Array.isArray(text) && text.length === 0)) return null
    // Mark text honours dx/dy; guide leaves are pre-positioned (the renderer ignores them).
    // vega's text align is `left` unless set (marks/text.js: item.align || 'left').
    const flat = { ...item, align: item.align ?? 'left', angle: 0, ...(mark ? {} : { dx: 0, dy: 0 }) } as SceneItem
    const b = boundText(new Bounds(), flat)
    const x = tx + (item.x || 0)
    const y = ty + (item.y || 0)
    const box: [number, number, number, number] = [b.x1 - (item.x || 0), b.y1 - (item.y || 0), b.x2 - (item.x || 0), b.y2 - (item.y || 0)]
    const rot = ((item.angle as number | undefined) ?? 0) * (Math.PI / 180)
    // axis-aligned bounds of the rotated box (+ slack)
    const corners: Array<[number, number]> = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
    const c = Math.cos(rot), s = Math.sin(rot)
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const [px, py] of corners) {
      const rx = x + px * c - py * s
      const ry = y + px * s + py * c
      if (rx < x1) x1 = rx
      if (rx > x2) x2 = rx
      if (ry < y1) y1 = ry
      if (ry > y2) y2 = ry
    }
    if (!Number.isFinite(x1 + y1 + x2 + y2)) return null
    return { item, marktype, kind: 'text', cx: x, cy: y, rot, box, x1: x1 - SLACK, y1: y1 - SLACK, x2: x2 + SLACK, y2: y2 + SLACK }
  }

  function addLeaf(item: SceneItem, _marktype: string, tx: number, ty: number): void {
    // Group leaves: axis/legend labels (text) and symbol/path leaves.
    if (item.text != null && item.text !== '') {
      const e = textEntry(item, 'text', tx, ty, false)
      if (e) entries.push(e)
      return
    }
    if (item.shape != null && item.radius != null) {
      const r = item.radius
      entries.push({
        item, marktype: 'symbol', kind: 'point',
        cx: tx + (item.x ?? 0), cy: ty + (item.y ?? 0), r: r + 2,
        x1: tx + (item.x ?? 0) - r - 2, y1: ty + (item.y ?? 0) - r - 2,
        x2: tx + (item.x ?? 0) + r + 2, y2: ty + (item.y ?? 0) + r + 2,
      })
    }
  }

  /** A geometry entry: outline `build`t lazily, its bounding box (+ tolerance) known up front. */
  function geomEntry(item: SceneItem, marktype: string, build: () => Poly[], paintSource: { fill?: unknown; stroke?: unknown; strokeWidth?: unknown }, resolve?: Entry['resolve']): Entry | null {
    const polys = build()
    const box = polysBox(polys)
    if (!box) return null
    const fill = isFilled(paintSource)
    const stroke = isStroked(paintSource)
    if (!fill && !stroke) return null
    const tol = stroke ? strokeTol(paintSource) : SLACK
    return {
      item, marktype, kind: 'geom', polys, build, fill, tol, resolve,
      x1: box[0] - tol, y1: box[1] - tol, x2: box[2] + tol, y2: box[3] + tol,
    }
  }

  /** The item nearest (x, y): the datum a hit on a line/area/trail reports. */
  function nearestItem(items: SceneItem[], tx: number, ty: number): (x: number, y: number) => SceneItem {
    return (x, y) => {
      let best = items[0]!
      let bd = Infinity
      for (const it of items) {
        if (it.x == null || it.y == null) continue
        const d = (tx + it.x - x) ** 2 + (ty + it.y - y) ** 2
        if (d < bd) { bd = d; best = it }
      }
      return best
    }
  }

  function addLine(group: SceneGroup, tx: number, ty: number): void {
    const items = group.items ?? []
    const info = computeLinePath(group)
    if (!info || !items.length) return
    // vega paints a line with its first item's stroke/fill; width defaults to 2
    const first = items[0]!
    const paint = { fill: info.fill, stroke: info.stroke, strokeWidth: info.sw }
    const e = geomEntry(first, 'line', () => flattenPath(info.path, (x, y) => [tx + x, ty + y]), paint, nearestItem(items, tx, ty))
    // an open polyline is only a fillable region when the line is filled (closed polygons, radar)
    if (e) entries.push(e)
  }

  function addArea(group: SceneGroup, tx: number, ty: number): void {
    const items = group.items ?? []
    const info = computeAreaPath(group)
    if (!info || !items.length) return
    const e = geomEntry(items[0]!, 'area', () => flattenPath(info.path, (x, y) => [tx + x, ty + y]), info, nearestItem(items, tx, ty))
    if (e) entries.push(e)
  }

  function addTrail(group: SceneGroup, tx: number, ty: number): void {
    const items = group.items ?? []
    if (items.length <= 1) return
    const d = trailPath(items)
    if (!d) return
    const e = geomEntry(items[0]!, 'trail', () => flattenPath(d, (x, y) => [tx + x, ty + y]), items[0]!, nearestItem(items, tx, ty))
    if (e) entries.push(e)
  }

  function addMarkItem(item: SceneItem, marktype: string, tx: number, ty: number): void {
    switch (marktype) {
      case 'rect': {
        if (item.fill == null && item.stroke == null) return
        let w = item.width
        let h = item.height
        let x0 = item.x ?? 0
        let y0 = item.y ?? 0
        if (w == null && item.x2 != null) { w = Math.abs((item.x2 as number) - x0); x0 = Math.min(x0, item.x2 as number) }
        if (h == null && item.y2 != null) { h = Math.abs((item.y2 as number) - y0); y0 = Math.min(y0, item.y2 as number) }
        if (w == null || h == null) return
        // Rect marks paint in item order; the entry keeps that order (see the mark walk).
        const rounded = rec(item).cornerRadius !== undefined || rec(item).cornerRadiusTopLeft !== undefined
          || rec(item).cornerRadiusTopRight !== undefined || rec(item).cornerRadiusBottomLeft !== undefined || rec(item).cornerRadiusBottomRight !== undefined
        if (rounded) {
          const d = rectItemPath(item)
          if (d != null) {
            const polys = flattenPath(d, (x, y) => [tx + x, ty + y])
            const box = polysBox(polys)
            if (box) {
              // inside the rounded outline (so the corners outside it are not hits)
              const tol = isStroked(item) ? strokeTol(item) - SLACK : 0
              rectOrder.push({ item, marktype, kind: 'geom', polys, fill: true, tol, x1: box[0] - tol, y1: box[1] - tol, x2: box[2] + tol, y2: box[3] + tol })
            }
            return
          }
        }
        const lo = (a: number, b: number): number => Math.min(a, b)
        const hi = (a: number, b: number): number => Math.max(a, b)
        rectOrder.push({ item, marktype, kind: 'band' as const,
          x1: tx + lo(x0, x0 + w), y1: ty + lo(y0, y0 + h), x2: tx + hi(x0, x0 + w), y2: ty + hi(y0, y0 + h) })
        return
      }
      case 'symbol':
      case 'circle': {
        if (item.x == null || item.y == null) return
        const size = (item.size as number) ?? SYMBOL_DEFAULT_SIZE
        const r = item.radius != null ? item.radius : Math.sqrt(size) / 2
        const sw = ((item.strokeWidth as number) ?? 1) / 2 + 2
        const cx = tx + item.x
        const cy = ty + item.y
        const shape = marktype === 'symbol' ? (rec(item).shape as string | undefined) : undefined
        if (shape == null || shape === 'circle') {
          entries.push({
            item, marktype, kind: 'point',
            cx, cy, r: r + sw,
            x1: cx - r - sw, y1: cy - r - sw,
            x2: cx + r + sw, y2: cy + r + sw,
          })
          return
        }
        // Other shapes: pick against the shape's outline (a square's corners reach r*sqrt(2)).
        const outline = shapeOutline(shape, r)
        const reach = outline.reach + sw
        const rot = ((rec(item).angle as number | undefined) ?? 0) * (Math.PI / 180)
        entries.push({
          item, marktype, kind: 'geom', cx, cy, rot, fill: true, tol: sw, polys: outline.polys, r,
          x1: cx - reach, y1: cy - reach, x2: cx + reach, y2: cy + reach,
        })
        return
      }
      case 'rule': {
        const x = tx + (item.x ?? 0)
        const y = ty + (item.y ?? 0)
        const x2 = tx + (item.x2 ?? item.x ?? 0)
        const y2 = ty + (item.y2 ?? item.y ?? 0)
        entries.push({
          item, marktype, kind: 'band',
          seg: [[x, y, x2, y2]],
          sw: ((item.strokeWidth as number) ?? 1) / 2 + 2,
          x1: Math.min(x, x2) - 3, y1: Math.min(y, y2) - 3,
          x2: Math.max(x, x2) + 3, y2: Math.max(y, y2) + 3,
        })
        return
      }
      case 'text': {
        const e = textEntry(item, marktype, tx, ty, true)
        if (e) entries.push(e)
        return
      }
      case 'arc': {
        const r = (item.outerRadius as number) ?? (item.radius as number) ?? 0
        const r0 = (item.innerRadius as number) ?? 0
        const d = arcPath(0, 0, r, r0, (item.startAngle as number) ?? 0, (item.endAngle as number) ?? 0,
          (rec(item).cornerRadius as number | undefined) ?? 0, (rec(item).padAngle as number | undefined) ?? 0)
        const ox = tx + (item.x ?? 0)
        const oy = ty + (item.y ?? 0)
        const e = geomEntry(item, marktype, () => flattenPath(d, (x, y) => [ox + x, oy + y]), item)
        if (e) entries.push(e)
        return
      }
      case 'path':
      case 'shape':
      case 'geoshape': {
        if (!item.path) return
        const sx = (rec(item).scaleX as number | undefined) ?? 1
        const sy = (rec(item).scaleY as number | undefined) ?? 1
        const ox = tx + (item.x || 0)
        const oy = ty + (item.y || 0)
        const path = String(item.path)
        const e = geomEntry(item, marktype, () => flattenPath(path, (x, y) => [ox + sx * x, oy + sy * y]), item)
        if (e) entries.push(e)
        return
      }
      case 'image': {
        if (item.x == null || item.y == null) return
        const w = (item.width as number | undefined) ?? 0
        const h = (item.height as number | undefined) ?? 0
        entries.push({ item, marktype, kind: 'band', x1: tx + item.x, y1: ty + item.y, x2: tx + item.x + w, y2: ty + item.y + h })
        return
      }
      default: {
        // unknown mark types: the item's own coordinates (point or x/y..x2/y2 box)
        const pts: Array<[number, number]> = []
        if (item.x != null && item.y != null) pts.push([tx + item.x, ty + item.y])
        if (item.x2 != null && item.y2 != null) pts.push([tx + item.x2, ty + item.y2])
        if (pts.length === 0) return
        entries.push({
          item, marktype, kind: 'band',
          x1: Math.min(...pts.map((p) => p[0])) - 2,
          y1: Math.min(...pts.map((p) => p[1])) - 2,
          x2: Math.max(...pts.map((p) => p[0])) + 2,
          y2: Math.max(...pts.map((p) => p[1])) + 2,
        })
      }
    }
  }

  // Linear scan for small scenes; uniform grid above the threshold.
  const GRID_THRESHOLD = 400
  let grid: Map<number, number[]> | null = null
  let big: number[] = []
  let gw = 1
  let gh = 1
  let cs = cell
  const buildGrid = (): void => {
    const W = Math.max(1, scene.width || 800)
    const H = Math.max(1, scene.height || 600)
    cs = cell > 0 && Number.isFinite(cell) ? cell : DEFAULT_CELL
    // the grid never exceeds MAX_GRID_CELLS, whatever cell size the caller asked for
    while (Math.ceil(W / cs) * Math.ceil(H / cs) > MAX_GRID_CELLS) cs *= 2
    gw = Math.max(1, Math.ceil(W / cs))
    gh = Math.max(1, Math.ceil(H / cs))
    grid = new Map()
    big = []
    const clampX = (v: number): number => (v >= gw ? gw - 1 : v < 0 ? 0 : v)
    const clampY = (v: number): number => (v >= gh ? gh - 1 : v < 0 ? 0 : v)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      if (!(e.x1 <= e.x2 && e.y1 <= e.y2)) continue // NaN bounds can never be hit
      // Clamp to the grid (queries clamp the same way), so an item far outside
      // the view or an enormous one covers at most the whole grid, never more.
      const c0x = clampX(Math.floor(e.x1 / cs))
      const c1x = clampX(Math.floor(e.x2 / cs))
      const c0y = clampY(Math.floor(e.y1 / cs))
      const c1y = clampY(Math.floor(e.y2 / cs))
      if ((c1x - c0x + 1) * (c1y - c0y + 1) > MAX_CELLS_PER_ENTRY) { big.push(i); continue }
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const key = cy * gw + cx
          const list = grid.get(key)
          if (list) list.push(i)
          else grid.set(key, [i])
        }
      }
    }
  }

  const found = (e: Entry, x: number, y: number): HitTarget => ({ item: e.resolve ? e.resolve(x, y) : e.item, marktype: e.marktype })

  const hitLinear = (x: number, y: number, dataOnly = false): HitTarget | null => {
    // Reverse scan: later entries paint on top (entries are kept in paint order).
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (dataOnly && e.item.datum == null) continue
      if (hits(e, x, y)) return found(e, x, y)
    }
    return null
  }

  const hitGrid = (x: number, y: number, dataOnly = false): HitTarget | null => {
    // Draw order matters for overlapping marks: the topmost painted item is
    // the one with the highest index. Merge the cell's list and the big list
    // (both ascending) from their ends.
    if (!(x === x && y === y)) return null
    const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / cs)))
    const cy = Math.min(gh - 1, Math.max(0, Math.floor(y / cs)))
    const list = grid!.get(cy * gw + cx)
    let a = list ? list.length - 1 : -1
    let b = big.length - 1
    while (a >= 0 || b >= 0) {
      let idx: number
      if (b < 0 || (a >= 0 && list![a]! > big[b]!)) idx = list![a--]!
      else idx = big[b--]!
      const e = entries[idx]!
      if (dataOnly && e.item.datum == null) continue
      if (hits(e, x, y)) return found(e, x, y)
    }
    return null
  }

  function hits(e: Entry, x: number, y: number): boolean {
    if (x < e.x1 || x > e.x2 || y < e.y1 || y > e.y2) return false
    switch (e.kind) {
      case 'point': {
        const dx = x - e.cx!
        const dy = y - e.cy!
        return dx * dx + dy * dy <= e.r! * e.r!
      }
      case 'text': {
        // into the text's own frame: about the anchor, undoing the rotation
        const c = Math.cos(e.rot!), s = Math.sin(e.rot!)
        const dx = x - e.cx!
        const dy = y - e.cy!
        const lx = dx * c + dy * s
        const ly = -dx * s + dy * c
        const b = e.box!
        return lx >= b[0] - SLACK && lx <= b[2] + SLACK && ly >= b[1] - SLACK && ly <= b[3] + SLACK
      }
      case 'geom': {
        const polys = e.polys ?? (e.polys = e.build!())
        let px = x, py = y
        if (e.cx !== undefined) {
          // symbol outline: local frame around the symbol's center, unrotated
          const c = Math.cos(e.rot!), s = Math.sin(e.rot!)
          const dx = x - e.cx
          const dy = y - e.cy!
          px = dx * c + dy * s
          py = -dx * s + dy * c
        }
        if (e.fill && insidePolys(polys, px, py)) return true
        return e.tol! > 0 && nearPolys(polys, px, py, e.tol!)
      }
      default:
        break
    }
    if (e.seg != null) {
      const tol = e.sw ?? 3
      for (const [ax, ay, bx, by] of e.seg) {
        if (distToSegment(x, y, ax, ay, bx, by) <= tol) return true
      }
      return false
    }
    return true
  }

  return {
    query(x: number, y: number): HitTarget | null {
      if (entries.length === 0) return null
      if (entries.length <= GRID_THRESHOLD) return hitLinear(x, y)
      if (grid == null) buildGrid()
      return hitGrid(x, y)
    },
    queryMark(x: number, y: number): HitTarget | null {
      if (entries.length === 0) return null
      if (entries.length <= GRID_THRESHOLD) return hitLinear(x, y, true)
      if (grid == null) buildGrid()
      return hitGrid(x, y, true)
    },
    size(): number {
      return entries.length
    },
  }
}

// Symbol outlines are shared by every symbol of a shape and size.
const OUTLINES = new Map<string, { polys: Poly[]; reach: number }>()

function shapeOutline(shape: string, r: number): { polys: Poly[]; reach: number } {
  const key = `${shape}|${r}`
  let o = OUTLINES.get(key)
  if (o) return o
  const polys = flattenPath(symbolPath(shape, r), (x, y) => [x, y])
  let reach = 0
  for (const { pts } of polys) for (let i = 0; i < pts.length; i += 2) reach = Math.max(reach, Math.hypot(pts[i]!, pts[i + 1]!))
  o = { polys, reach }
  if (OUTLINES.size > 256) OUTLINES.clear()
  OUTLINES.set(key, o)
  return o
}

