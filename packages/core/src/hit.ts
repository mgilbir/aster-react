/**
 * Scene hit index (R10.1): resolves the mark item under a view coordinate
 * without walking the DOM — the canvas backend has no DOM to query, and the
 * SVG backend benefits from O(1) hover on dense scenes.
 *
 * A uniform grid buckets items whose geometry is point-like; everything is
 * also resolvable by a linear scan for small scenes. Pick semantics mirror
 * vega-scenegraph's per-mark `pick`:
 *   rect/arc  — inside the shape's bbox (vega: point-in-path)
 *   symbol/circle — within radius + strokeWidth/2 + 2px slack of the center
 *   rule      — within strokeWidth/2 + 2px of the segment
 *   line      — within strokeWidth/2 + 2px of any segment
 *   text      — within the estimated text bbox
 *   path/trail/area — within the path bbox (coarse but datum-correct)
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

export interface HitTarget {
  item: SceneItem
  /** The enclosing mark group (marktype), for role/type checks. */
  marktype: string
}

interface Entry {
  item: SceneItem
  marktype: string
  /** bounds in scene coordinates */
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'point' | 'band' | 'text'
  /** point geometry: center + pick radius */
  cx?: number
  cy?: number
  r?: number
  /** line/rule segment endpoints (scene coords) */
  seg?: Array<[number, number, number, number]>
  sw?: number
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

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

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

  function addLeaf(item: SceneItem, _marktype: string, tx: number, ty: number): void {
    // Group leaves: axis/legend labels (text) and symbol/path leaves.
    if (item.text != null && item.text !== '') {
      const fs = (item as Record<string, unknown>).fontSize as number | undefined ?? 11
      const txt = String(item.text)
      const w = (item as Record<string, unknown>).limit as number | undefined ?? txt.length * fs * 0.55
      entries.push({
        item,
        marktype: 'text',
        x1: tx + (item.x ?? 0) - w / 2,
        y1: ty + (item.y ?? 0) - fs,
        x2: tx + (item.x ?? 0) + w / 2,
        y2: ty + (item.y ?? 0) + fs * 0.3,
        kind: 'text',
      })
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
        rectOrder.push({ item, marktype, kind: 'band' as const,
          x1: tx + x0, y1: ty + y0, x2: tx + x0 + w, y2: ty + y0 + h })
        return
      }
      case 'symbol':
      case 'circle': {
        if (item.x == null || item.y == null) return
        const size = (item.size as number) ?? SYMBOL_DEFAULT_SIZE
        const r = item.radius != null ? item.radius : Math.sqrt(size) / 2
        const sw = ((item.strokeWidth as number) ?? 1) / 2 + 2
        entries.push({
          item, marktype, kind: 'point',
          cx: tx + item.x, cy: ty + item.y, r: r + sw,
          x1: tx + item.x - r - sw, y1: ty + item.y - r - sw,
          x2: tx + item.x + r + sw, y2: ty + item.y + r + sw,
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
        if (item.text == null || item.text === '') return
        const fs = (item as Record<string, unknown>).fontSize as number | undefined ?? 11
        const str = String(item.text)
        // vega's text align is `left` unless set (marks/text.js: item.align || 'left')
        const align = item.align ?? 'left'
        const w = str.length * fs * 0.55
        const cx = tx + (item.x ?? 0)
        const left = align === 'left' ? cx : align === 'right' ? cx - w : cx - w / 2
        entries.push({
          item, marktype, kind: 'text',
          x1: left, y1: ty + (item.y ?? 0) - fs, x2: left + w, y2: ty + (item.y ?? 0) + fs * 0.3,
        })
        return
      }
      default: {
        // line/area/path/trail/arc: bbox over the items' coordinates
        const pts: Array<[number, number]> = []
        if (item.path != null || item.x != null || item.y != null) {
          if (item.x != null && item.y != null) pts.push([tx + item.x, ty + item.y])
          if (item.x2 != null && item.y2 != null) pts.push([tx + item.x2, ty + item.y2])
        }
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
  let gw = 0
  const buildGrid = (): void => {
    gw = Math.max(1, Math.ceil((scene.width || 800) / cell))
    grid = new Map()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const c0x = Math.max(0, Math.floor(e.x1 / cell))
      const c1x = Math.floor(e.x2 / cell)
      const c0y = Math.max(0, Math.floor(e.y1 / cell))
      const c1y = Math.floor(e.y2 / cell)
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

  const hitLinear = (x: number, y: number, dataOnly = false): HitTarget | null => {
    // Reverse scan: later entries paint on top (except rect marks, which our
    // SVG renderer paints in reverse item order — handled at insertion time
    // by keeping entries in paint order).
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (dataOnly && e.item.datum == null) continue
      if (hits(e, x, y)) return { item: e.item, marktype: e.marktype }
    }
    return null
  }

  const hitGrid = (x: number, y: number, dataOnly = false): HitTarget | null => {
    // Draw order matters for overlapping marks: the topmost painted item is
    // the mark's LAST item, so scan candidates in reverse index order.
    const key = Math.max(0, Math.floor(y / cell)) * gw + Math.max(0, Math.floor(x / cell))
    const list = grid!.get(key)
    if (list == null) return null
    for (let j = list.length - 1; j >= 0; j--) {
      const e = entries[list[j]!]!
      if (dataOnly && e.item.datum == null) continue
      if (hits(e, x, y)) return { item: e.item, marktype: e.marktype }
    }
    return null
  }

  function hits(e: Entry, x: number, y: number): boolean {
    if (x < e.x1 || x > e.x2 || y < e.y1 || y > e.y2) return false
    if (e.kind === 'point') {
      const dx = x - e.cx!
      const dy = y - e.cy!
      return dx * dx + dy * dy <= e.r! * e.r!
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

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
