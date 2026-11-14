/**
 * Scene hit index: resolves the mark item under a view coordinate
 * without walking the DOM — the canvas backend has no DOM to query, and the
 * SVG backend benefits from O(1) hover on dense scenes.
 *
 * Which item is under a point is what vega's renderers say: the topmost item, in paint order, whose painted geometry contains
 * the point exactly (vega-scenegraph's canvas `pick`: `isPointInPath` for the fill, `isPointInStroke` for the stroke; the SVG
 * renderer: the browser's own hit test of the same shapes). There is no pointing slack: a point a hair outside an item is not
 * on it, and the item drawn under it wins. Per mark type:
 *   rect, arc, path, shape, geoshape, symbol, area, line, trail — inside the fill (non-zero winding) when the item has a fill,
 *                 or within the stroke when it has one: half the stroke width either side of the outline, with the item's caps
 *                 (butt unless `strokeCap`) and joins (miter, limit 4, unless `strokeJoin` / `strokeMiterLimit`).
 *                 `fill: "transparent"` paints; an item with neither a fill nor a stroke takes no pointer.
 *   rule        — within its stroke
 *   text        — inside the (rotated) text box, from the same bounds the layout uses
 *   image       — inside its box
 *   group       — its foreground stroke (`strokeForeground`), then what it holds, then its background (fill, or the stroke)
 * A clip (the view's, a mark's `clip`, a group item's `clip`, a clipped legend symbol) hides what lies outside it from the
 * pointer, as the browser's hit test of a clipped SVG element does. A mark with `interactive: false`, and a guide part the spec
 * did not make interactive, takes no pointer: `pick` looks through it.
 *
 * A line, an area or a trail is one painted path: `pick` reports the mark's first item (vega's `event.item`), `tooltip`
 * resolves it as vega's tooltip handler does, `query` and `queryMark` report the item nearest the point.
 *
 * A uniform grid buckets entries by bounding box; everything is also
 * resolvable by a linear scan for small scenes. Cell ranges are clamped to the
 * grid and an entry spanning too many cells (a huge item, a full-view
 * background) is kept in a short separate list instead of being replicated into
 * every cell.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { Bounds, boundText } from './bounds.js'
import { textAnchor } from './text-metrics.js'
import { imageBox } from './image-box.js'
import { FLATTEN_TOLERANCE, flattenPath, insidePolys, type Poly } from './path-flatten.js'
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import { computeAreaPath, computeLinePath, isInert, itemArcPath, rectItemPath, symbolPathExact, trailPath } from './render.js'

export interface HitTarget {
  item: SceneItem
  /** The enclosing mark group (marktype), for role/type checks. */
  marktype: string
  /**
   * What was hit: an item of a `mark`, a `group` item's own box (a facet cell, a nested view), or a part of a `guide` (an axis, a
   * legend or a title, including their boxes).
   */
  kind?: 'mark' | 'group' | 'guide'
  /** An item of a mark that reads a dataset (`from.data`): its datum is a data row, not the `{}` vega makes for a mark without `from`. */
  fromData?: boolean
}

/** A clip region in scene coordinates: a rectangle (edges included), and, for a rounded one, its outline. */
interface Clip {
  x1: number
  y1: number
  x2: number
  y2: number
  polys?: Poly[]
}

/** How a stroke is painted: half its width, its caps and its joins (vega-scenegraph `stroke()`; SVG's defaults are the same). */
interface Stroke {
  hw: number
  cap: string
  join: string
  limit: number
}

type Multi = 'line' | 'area' | 'trail'

interface Entry {
  item: SceneItem
  marktype: string
  /** bounding box in scene coordinates: no point outside it is a hit */
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'circle' | 'box' | 'text' | 'geom'
  /** circle: the center; text and an outline in a frame of its own: the frame's origin */
  cx?: number
  cy?: number
  /** circle: the radius */
  r?: number
  /** text and an outline in a frame of its own: the frame's rotation (radians) */
  rot?: number
  /** text: box in the unrotated frame around the anchor (cx, cy) */
  box?: [number, number, number, number]
  /** geom: the outline (scene coordinates, or the entry's own frame when `cx` is set), and how it is rebuilt */
  polys?: Poly[]
  build?: () => Poly[]
  fill?: boolean
  stroke?: Stroke | null
  /** the clips around the entry */
  clips?: Clip[]
  /** a line, an area or a trail: one path for all the mark's items, in the frame at (tx, ty) */
  multi?: { type: Multi; items: SceneItem[]; tx: number; ty: number }
  /** A group item's own box (vega picks a group that has a fill or a stroke where no mark inside it is hit). */
  groupBox?: true
  /** Part of an axis, a legend or a title. */
  guide?: true
  /** The item's mark reads a dataset. */
  fromData?: true
  /** Not interactive (its mark / guide part says `pointer-events: none`): `pick` looks through it. */
  inert?: true
  /** A guide part the other queries never saw (an interactive legend entry, symbol path, gradient, tick...): only `pick` finds it. */
  pickOnly?: true
}

export interface HitIndex {
  /** The topmost painted item at (x, y), whether it takes the pointer or not (a line, an area, a trail: its item nearest the point). */
  query(x: number, y: number): HitTarget | null
  /**
   * Like `query`, but only the items of interactive marks (not a guide's parts, not a group item's box). Guides (axis/legend
   * text) paint above marks and must not swallow clicks/tooltips. A mark without `from` is a mark like any other: its item's
   * datum is vega's `{}`.
   */
  queryMark(x: number, y: number): HitTarget | null
  /**
   * vega's `event.item`: the topmost item that takes the pointer. Unlike `query` it looks through what is not interactive
   * (a mark with `interactive: false`, a guide part the spec did not make `interactive`) and finds the guide parts that are
   * (a legend's entry boxes, symbols and labels, an axis' ticks...), which is where the item's `cursor` channel is read. A
   * line, an area or a trail is its first item, as in vega.
   */
  pick(x: number, y: number): HitTarget | null
  /**
   * The item vega's tooltip handler is called with at (x, y): the item `pick` finds, with a line, an area or a trail resolved
   * to one of its items as vega-scenegraph resolves it (an area: the defined item nearest along its orientation; a line: the
   * last defined item within its stroke width of the point; a trail: within the item's size), or `null` when that finds none.
   */
  tooltip(x: number, y: number): HitTarget | null
  /** Number of indexed mark items. */
  size(): number
}

const DEFAULT_CELL = 48
/** An entry covering more grid cells than this lives in the `big` list. */
const MAX_CELLS_PER_ENTRY = 64
/** Cap on the grid itself, whatever the cell size / scene size. */
const MAX_GRID_CELLS = 1 << 20

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

const rec = (it: SceneItem): Record<string, unknown> => it as Record<string, unknown>

// ---------------------------------------------------------------------------
// Paint: what vega's hit test reads off an item
// ---------------------------------------------------------------------------

/** vega's hit test reads `item.fill` and `item.stroke` as booleans: any colour (`transparent` included) or gradient paints. */
const isFilled = (it: { fill?: unknown }): boolean => !!it.fill

/** The item's stroke, or null when it has none the pointer can meet (no colour, or no width). */
function strokeOf(it: { stroke?: unknown; strokeWidth?: unknown; strokeCap?: unknown; strokeJoin?: unknown; strokeMiterLimit?: unknown }, defaultWidth = 1): Stroke | null {
  if (!it.stroke) return null
  const w = it.strokeWidth != null ? +(it.strokeWidth as number) : defaultWidth
  if (!(w > 0)) return null
  const limit = it.strokeMiterLimit != null ? +(it.strokeMiterLimit as number) : 4
  return {
    hw: w / 2,
    cap: typeof it.strokeCap === 'string' ? it.strokeCap : 'butt',
    join: typeof it.strokeJoin === 'string' ? it.strokeJoin : 'miter',
    limit: limit >= 1 ? limit : 4,
  }
}

/** How far a stroke reaches out of its outline (a miter up to `limit` half-widths, a square cap sqrt(2)). */
const reachOf = (st: Stroke | null | undefined): number => (st ? st.hw * Math.max(st.join === 'miter' ? st.limit : 1, st.cap === 'square' ? Math.SQRT2 : 1) : 0)

// ---------------------------------------------------------------------------
// Geometry: a point in a stroked outline
// ---------------------------------------------------------------------------

/** Whether (x, y) lies in the convex polygon `p` (flat [x0,y0,x1,y1,...], either winding), edges included. */
function inConvex(p: number[], x: number, y: number): boolean {
  let sign = 0
  const n = p.length / 2
  for (let i = 0; i < n; i++) {
    const ax = p[2 * i]!, ay = p[2 * i + 1]!
    const j = (i + 1) % n
    const bx = p[2 * j]!, by = p[2 * j + 1]!
    const c = (bx - ax) * (y - ay) - (x - ax) * (by - ay)
    if (c === 0) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * The join at vertex (vx, vy) between a segment coming in along (d1x, d1y) and one going out along (d2x, d2y) (unit vectors):
 * whether (x, y) lies in what the join adds to the two segments' own bands, on the outer side of the turn.
 */
function inJoin(vx: number, vy: number, d1x: number, d1y: number, d2x: number, d2y: number, x: number, y: number, st: Stroke): boolean {
  if (st.join === 'round') return Math.hypot(x - vx, y - vy) <= st.hw
  const cross = d1x * d2y - d1y * d2x
  if (cross === 0) return false
  // the normals of the two segments on the outer side of the turn
  const s = cross > 0 ? 1 : -1
  const n1x = s * d1y, n1y = -s * d1x
  const n2x = s * d2y, n2y = -s * d2x
  const ax = vx + st.hw * n1x, ay = vy + st.hw * n1y
  const bx = vx + st.hw * n2x, by = vy + st.hw * n2y
  if (st.join === 'miter') {
    // the miter's length over the stroke width is 1 / sin(theta / 2), theta the angle between the two segments
    const cosHalf = Math.sqrt(Math.max(0, (1 + d1x * d2x + d1y * d2y) / 2))
    if (cosHalf > 0 && 1 / cosHalf <= st.limit) {
      const mx = n1x + n2x, my = n1y + n2y
      const ml = Math.hypot(mx, my)
      const len = st.hw / cosHalf
      return inConvex([vx, vy, ax, ay, vx + (mx / ml) * len, vy + (my / ml) * len, bx, by], x, y)
    }
  }
  // bevel, and a miter beyond its limit
  return inConvex([vx, vy, ax, ay, bx, by], x, y)
}

/** The cap at the end (ex, ey) of an open subpath, its last segment pointing along (dx, dy) (unit, out of the path). */
function inCap(ex: number, ey: number, dx: number, dy: number, x: number, y: number, st: Stroke): boolean {
  if (st.cap === 'round') return Math.hypot(x - ex, y - ey) <= st.hw
  if (st.cap !== 'square') return false
  const along = (x - ex) * dx + (y - ey) * dy
  const across = (x - ex) * -dy + (y - ey) * dx
  return along >= 0 && along <= st.hw && Math.abs(across) <= st.hw
}

/** Whether (x, y) is within the stroke of an outline: the band along each segment, the joins between them, the caps of open ends. */
function inStroke(polys: Poly[], x: number, y: number, st: Stroke): boolean {
  for (const { pts, closed } of polys) {
    // the vertices without repeats (a segment of no length has no direction)
    const v: number[] = []
    for (let i = 0; i < pts.length; i += 2) {
      const px = pts[i]!, py = pts[i + 1]!
      if (v.length === 0 || px !== v[v.length - 2] || py !== v[v.length - 1]) v.push(px, py)
    }
    let m = v.length / 2
    if (closed && m > 1 && v[0] === v[2 * m - 2] && v[1] === v[2 * m - 1]) { v.length -= 2; m-- }
    if (m === 0) continue
    if (m === 1) {
      // a subpath of one point paints only its caps: a round one is a dot, a square one an upright square
      if (closed) continue
      const dx = x - v[0]!, dy = y - v[1]!
      if (st.cap === 'round' && Math.hypot(dx, dy) <= st.hw) return true
      if (st.cap === 'square' && Math.abs(dx) <= st.hw && Math.abs(dy) <= st.hw) return true
      continue
    }
    const segs = closed ? m : m - 1
    const dir: number[] = []
    for (let i = 0; i < segs; i++) {
      const ax = v[2 * i]!, ay = v[2 * i + 1]!
      const j = (i + 1) % m
      const bx = v[2 * j]!, by = v[2 * j + 1]!
      const len = Math.hypot(bx - ax, by - ay)
      const dx = (bx - ax) / len, dy = (by - ay) / len
      dir.push(dx, dy)
      const along = (x - ax) * dx + (y - ay) * dy
      if (along >= 0 && along <= len && Math.abs((x - ax) * -dy + (y - ay) * dx) <= st.hw) return true
    }
    // the joins: at every vertex of a closed outline, at the inner ones of an open one
    for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) {
      const pi = (i - 1 + segs) % segs
      if (inJoin(v[2 * i]!, v[2 * i + 1]!, dir[2 * pi]!, dir[2 * pi + 1]!, dir[2 * i]!, dir[2 * i + 1]!, x, y, st)) return true
    }
    if (!closed) {
      if (inCap(v[0]!, v[1]!, -dir[0]!, -dir[1]!, x, y, st)) return true
      const l = 2 * (segs - 1)
      if (inCap(v[2 * m - 2]!, v[2 * m - 1]!, dir[l]!, dir[l + 1]!, x, y, st)) return true
    }
  }
  return false
}

/**
 * Whether (x, y) is inside a filled outline, its edge included (a point on the bottom edge of an area is painted, so is one on
 * a circle's edge at a whole pixel). A chord of a curve or an arc may lie off the true outline by the flattening tolerance, so a
 * point that close to one counts as on the edge; a straight segment is exact (to the rounding of the arithmetic).
 */
function inFill(polys: Poly[], x: number, y: number): boolean {
  if (insidePolys(polys, x, y)) return true
  for (const { pts, curved } of polys) {
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * j]!, by = pts[2 * j + 1]!
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
      if (d <= 1e-9 || (curved?.[j] === true && j !== 0 && d <= FLATTEN_TOLERANCE)) return true
    }
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

/** (x, y) in the frame of an entry that has one of its own (a text box, a symbol outline, a rotated path). */
function local(e: Entry, x: number, y: number): [number, number] {
  const dx = x - e.cx!
  const dy = y - e.cy!
  if (!e.rot) return [dx, dy]
  const c = Math.cos(e.rot), s = Math.sin(e.rot)
  return [dx * c + dy * s, -dx * s + dy * c]
}

// ---------------------------------------------------------------------------
// vega-scenegraph's tooltip resolution of a line, an area and a trail (resolveItem + the marks' `tip`), in the mark's frame
// ---------------------------------------------------------------------------

function tipOf(type: Multi, items: SceneItem[], px: number, py: number): SceneItem | null {
  if (type === 'area') {
    // the defined item nearest along the area's orientation (the last of equals: the scan runs backwards)
    const horizontal = rec(items[0]!).orient === 'horizontal'
    const v = horizontal ? py : px
    let best: SceneItem | null = null
    let min = Infinity
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (rec(it).defined === false) continue
      const d = Math.abs(((horizontal ? it.y : it.x) as number) - v)
      if (d < min) { min = d; best = it }
    }
    return best
  }
  // a line: the last defined item within its first item's stroke width; a trail: within the item's own size
  const lineReach = ((items[0]!.strokeWidth as number | undefined) || 1) ** 2
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (rec(it).defined === false) continue
    const dx = (it.x as number) - px
    const dy = (it.y as number) - py
    if (dx * dx + dy * dy < (type === 'line' ? lineReach : ((rec(it).size as number) || 1) ** 2)) return it
  }
  return null
}

/** The item of a line, an area or a trail nearest (x, y): what `query` and `queryMark` report for a hit on it. */
function nearestOf(items: SceneItem[], tx: number, ty: number, x: number, y: number): SceneItem {
  let best = items[0]!
  let bd = Infinity
  for (const it of items) {
    if (it.x == null || it.y == null) continue
    const d = (tx + it.x - x) ** 2 + (ty + it.y - y) ** 2
    if (d < bd) { bd = d; best = it }
  }
  return best
}

// ---------------------------------------------------------------------------

export function buildHitIndex(scene: SceneRoot, cell = DEFAULT_CELL): HitIndex {
  const entries: Entry[] = []
  /** The clips around what is being indexed (outermost first). */
  let clips: Clip[] | undefined
  /** Put every entry made since `from` that has no clips of its own under the current ones. */
  const clipFrom = (from: number): void => {
    if (clips === undefined) return
    for (let i = from; i < entries.length; i++) entries[i]!.clips ??= clips
  }
  /** Index what `fn` indexes under `clip` too. */
  const withClip = (clip: Clip | null, fn: () => void): void => {
    if (clip === null) { fn(); return }
    const outer = clips
    clips = outer ? [...outer, clip] : [clip]
    try { fn() } finally { clips = outer }
  }
  const rectClip = (x: number, y: number, w: number, h: number): Clip => ({ x1: Math.min(x, x + w), y1: Math.min(y, y + h), x2: Math.max(x, x + w), y2: Math.max(y, y + h) })
  const pathClip = (d: string, ox: number, oy: number): Clip => {
    const polys = flattenPath(d, (x, y) => [ox + x, oy + y])
    const box = polysBox(polys)
    // (an outline with no point clips everything away)
    return box ? { x1: box[0], y1: box[1], x2: box[2], y2: box[3], polys } : { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  }

  // (tx, ty): where the frame of the group around the marks is; (fw, fh): its size, what a mark's `clip` clips to
  const walk = (group: SceneGroup, tx: number, ty: number, fw: number, fh: number, outer?: SceneGroup): void => {
    const gx = tx + (group.x ?? 0)
    const gy = ty + (group.y ?? 0)
    const type = group.marktype
    if (!type || type === 'group') {
      // a group item's own box (vega-scenegraph marks/group.js): its background is painted under the content, its
      // foreground over it. What the pointer meets is the painted rectangle -- the fill inside it, the stroke along it --
      // exactly as the browser tests the `path.background` / `path.foreground` of the SVG.
      const scope = rec(group)._scope === true
      const box = scope && group.interactive !== false ? groupBoxFaces(group, gx, gy) : { background: null, foreground: null }
      // an axis or a legend: its leaves are the marks of its parts, each interactive only if the spec said so
      const guide = !scope && (group.role === 'axis' || group.role === 'legend') ? group : null
      const meta = guide ? (outer?.partMeta ?? guide.partMeta) : undefined
      const w = group.width ?? fw
      const h = group.height ?? fh
      // a group item's `clip` (encode) clips what it holds to its box: the content `<g>` of the SVG
      const content = rec(group).contentClip === true ? (group.clipPathD ? pathClip(group.clipPathD, gx, gy) : rectClip(gx, gy, w, h)) : null
      // a group mark's own `clip` clips its items to the frame of the group around them
      withClip(rec(group).markClip === true ? rectClip(tx, ty, fw, fh) : null, () => {
        if (box.background) { entries.push(box.background); clipFrom(entries.length - 1) }
        withClip(content, () => {
          for (const item of group.items ?? []) {
            if (isGroup(item)) { walk(item, gx, gy, w, h, guide ?? outer); continue }
            const before = entries.length
            addLeaf(item, gx, gy)
            if (guide) {
              if (!partInteractive(guide, meta, item)) {
                for (let i = before; i < entries.length; i++) entries[i]!.inert = true
              } else if (entries.length === before) {
                addGuidePart(item, gx, gy, guide)
              }
              for (let i = before; i < entries.length; i++) entries[i]!.guide = true
            }
            clipFrom(before)
          }
        })
        if (box.foreground) { entries.push(box.foreground); clipFrom(entries.length - 1) }
      })
      return
    }
    const e0 = entries.length
    // a mark's `clip`: its items are clipped to the frame of the group they are in (or to its rounded outline)
    const clip = group.clip === true ? (group.clipPathD ? pathClip(group.clipPathD, tx, ty) : rectClip(tx, ty, fw, fh)) : null
    withClip(clip, () => {
      addMark(group, type, gx, gy)
      clipFrom(e0)
    })
    const inert = isInert(group)
    const guidePart = group.role === 'title-text' || group.role === 'title-subtitle'
    const fromData = group.__source !== undefined
    for (let i = e0; i < entries.length; i++) {
      const e = entries[i]!
      // a mark that is not interactive takes no pointer (its container says `pointer-events: none`)
      if (inert) e.inert = true
      // a title's text is a guide's part; an item of a mark that reads a dataset has a row for its datum
      if (guidePart) e.guide = true
      else if (fromData) e.fromData = true
    }
  }
  const addMark = (group: SceneGroup, type: string, gx: number, gy: number): void => {
    if (type === 'line' || type === 'area' || type === 'trail') { addMulti(group, type, gx, gy); return }
    for (const item of group.items ?? []) addMarkItem(item, type, gx, gy)
  }
  // Scene items live in plot coordinates; pointer queries arrive in viewport
  // coordinates, so include the root padding translation (as the renderer does
  // with its top-level translate group).
  const padX = (scene.padding?.left ?? 0) + (scene.frameX ?? 0)
  const padY = (scene.padding?.top ?? 0) + (scene.frameY ?? 0)
  const plotW = scene.plotWidth ?? scene.width
  const plotH = scene.plotHeight ?? scene.height
  // nothing is picked outside the view's surface (vega's SVG clips what overflows it, its canvas ends there), nor outside the
  // plot when the view clips to it
  withClip(scene.width >= 0 && scene.height >= 0 ? rectClip(0, 0, scene.width, scene.height) : null, () => {
    withClip(scene.frameClip ? rectClip(padX, padY, plotW, plotH) : null, () => {
      for (const node of scene.items) walk(node, padX, padY, plotW, plotH)
    })
  })

  /** The entries of a group item's background and foreground rectangles, at (gx, gy). */
  function groupBoxFaces(group: SceneGroup, gx: number, gy: number): { background: Entry | null; foreground: Entry | null } {
    const items = (group.items ?? []) as SceneItem[]
    const isBox = (it: SceneItem | undefined): it is SceneItem => it !== undefined && rec(it)._bg === true && typeof it.path === 'string'
    const face = (paint: SceneItem, path: string): Entry | null => {
      const e = geomEntry(group, 'group', () => flattenPath(path, (x, y) => [gx + x, gy + y]), paint)
      if (e) e.groupBox = true
      return e
    }
    if (isBox(items[0])) {
      const fg = items.length > 1 ? items[items.length - 1] : undefined
      return { background: face(items[0], items[0].path as string), foreground: isBox(fg) ? face(fg, fg.path as string) : null }
    }
    // a scene without the boxes the runtime draws: the group's own rectangle
    const w = Number(group.width ?? 0)
    const h = Number(group.height ?? 0)
    return { background: w > 0 && h > 0 ? face(group as SceneItem, `M0,0h${w}v${h}h${-w}Z`) : null, foreground: null }
  }

  /** Text entry from the layout's own text bounds, rotated about the anchor. */
  function textEntry(item: SceneItem, marktype: string, tx: number, ty: number, mark: boolean): Entry | null {
    const text = item.text
    if (text == null || text === '' || (Array.isArray(text) && text.length === 0)) return null
    // (vega: a text of no size is never hit)
    if (item.fontSize != null && !((item.fontSize as number) > 0)) return null
    // Mark text honours dx/dy; guide leaves are pre-positioned (the renderer ignores them).
    // vega's text align is `left` unless set (marks/text.js: item.align || 'left').
    const flat = { ...item, align: item.align ?? 'left', angle: 0, ...(mark ? {} : { dx: 0, dy: 0 }) } as SceneItem
    const b = boundText(new Bounds(), flat)
    const [ax, ay] = textAnchor(item)
    const x = tx + ax
    const y = ty + ay
    const box: [number, number, number, number] = [b.x1 - ax, b.y1 - ay, b.x2 - ax, b.y2 - ay]
    const rot = ((item.angle as number | undefined) ?? 0) * (Math.PI / 180)
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
    return { item, marktype, kind: 'text', cx: x, cy: y, rot, box, x1, y1, x2, y2 }
  }

  /** A leaf of a group: an axis or legend label or title (text), or a symbol leaf of a hand-built scene. */
  function addLeaf(item: SceneItem, tx: number, ty: number): void {
    if (item.text != null && item.text !== '') {
      const e = textEntry(item, 'text', tx, ty, false)
      if (e) entries.push(e)
      return
    }
    if (item.shape != null && item.radius != null) addSymbol(item, 'symbol', tx, ty, item.radius)
  }

  /** Whether the spec made the guide part a leaf belongs to `interactive` (a leaf of a hand-built scene names no part: it is). */
  function partInteractive(guide: SceneGroup, meta: SceneGroup['partMeta'], leaf: SceneItem): boolean {
    const part = leaf._part
    if (part === undefined) return true
    const key = part === 'entry' ? 'entries' : part === 'bg' ? guide.role! : part
    return meta?.[key]?.interactive === true
  }

  /**
   * An interactive guide part drawn as a path or a rule (a legend's entry box, symbol, gradient or band; an axis' tick, grid
   * line or domain): found by `pick` only. The entry box is the entry's group item, the guide's own `bg` is the guide's group item.
   */
  function addGuidePart(item: SceneItem, tx: number, ty: number, guide: SceneGroup): void {
    const before = entries.length
    const part = item._part
    if (item._kind === 'rule' || (item.path == null && item.x2 != null)) {
      addMarkItem(item, 'rule', tx, ty)
    } else if (typeof item.path === 'string') {
      const path = item.path
      const marktype = part === 'entry' || part === 'bg' ? 'group' : part === 'gradient' || part === 'band' ? 'rect' : item._kind ?? 'symbol'
      const angle = (rec(item).angle as number | undefined) ?? 0
      const e = angle
        // a turned symbol: its outline in its own frame
        ? geomEntry(item, marktype, () => flattenPath(path, (x, y) => [x, y]), item, { cx: tx + (item.x || 0), cy: ty + (item.y || 0), rot: angle * (Math.PI / 180) })
        : geomEntry(part === 'bg' ? guide : item, marktype, () => flattenPath(path, (x, y) => [tx + (item.x || 0) + x, ty + (item.y || 0) + y]), item)
      if (e) entries.push(e)
    }
    // a clipped legend symbol (clipHeight): the clip is in the frame of the legend's leaves; an entry box that is not part of its
    // group item's bounds: vega's pick looks for the group item only within them
    const c = rec(item)._clip as { x?: number; y?: number; w: number; h: number; d?: string } | undefined
    const b = rec(item)._pickBounds as { x1: number; y1: number; x2: number; y2: number } | undefined
    const clip = c ? (c.d ? pathClip(c.d, tx, ty) : rectClip(tx + (c.x ?? 0), ty + (c.y ?? 0), c.w, c.h))
      : b ? rectClip(tx + (item.x || 0) + b.x1, ty + (item.y || 0) + b.y1, b.x2 - b.x1, b.y2 - b.y1) : null
    for (let i = before; i < entries.length; i++) {
      entries[i]!.pickOnly = true
      if (clip) entries[i]!.clips = clips ? [...clips, clip] : [clip]
    }
  }

  /**
   * A geometry entry: its outline in scene coordinates (or in the frame `at` places and turns), filled and/or stroked as `paint`
   * says; none when it is neither.
   */
  function geomEntry(item: SceneItem, marktype: string, build: () => Poly[], paint: SceneItem | Record<string, unknown>, at?: { cx: number; cy: number; rot: number }, stroke: Stroke | null = strokeOf(paint)): Entry | null {
    const fill = isFilled(paint)
    if (!fill && !stroke) return null
    const polys = build()
    const box = polysBox(polys)
    if (!box) return null
    const reach = reachOf(stroke)
    let x1 = box[0] - reach, y1 = box[1] - reach, x2 = box[2] + reach, y2 = box[3] + reach
    if (at) {
      // the box of the frame's box, turned
      const c = Math.cos(at.rot), s = Math.sin(at.rot)
      let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity
      for (const [px, py] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as const) {
        const rx = at.cx + px * c - py * s
        const ry = at.cy + px * s + py * c
        if (rx < a) a = rx
        if (rx > cc) cc = rx
        if (ry < b) b = ry
        if (ry > d) d = ry
      }
      x1 = a; y1 = b; x2 = cc; y2 = d
    }
    return { item, marktype, kind: 'geom', polys, build, fill, stroke, x1, y1, x2, y2, ...(at ?? {}) }
  }

  /** A line, an area or a trail: one painted path, styled by the mark's first item. */
  function addMulti(group: SceneGroup, type: Multi, tx: number, ty: number): void {
    const items = (group.items ?? []) as SceneItem[]
    if (!items.length) return
    let d: string
    let paint: Record<string, unknown>
    let stroke: Stroke | null
    if (type === 'line') {
      const info = computeLinePath(group, true)
      if (!info) return
      d = String(info.path)
      paint = { fill: info.fill }
      // (vega draws a line 2 wide unless its first item says otherwise: see computeLinePath)
      stroke = strokeOf(info.first, info.sw ?? 1)
    } else if (type === 'area') {
      const info = computeAreaPath(group, true)
      if (!info) return
      d = String(info.path)
      paint = info.first as Record<string, unknown>
      stroke = strokeOf(info.first)
    } else {
      if (items.length <= 1) return
      d = String(trailPath(items))
      // (vega paints a trail's outline with its first item's fill and stroke, like any path)
      paint = items[0] as Record<string, unknown>
      stroke = strokeOf(items[0]!)
    }
    if (!d) return
    const e = geomEntry(items[0]!, type, () => flattenPath(d, (x, y) => [tx + x, ty + y]), paint, undefined, stroke)
    if (e) {
      e.multi = { type, items, tx, ty }
      entries.push(e)
    }
  }

  /** A symbol: a disc when it is a circle, else its shape's outline in its own frame, turned by its angle. */
  function addSymbol(item: SceneItem, marktype: string, tx: number, ty: number, radius?: number): void {
    if (item.x == null || item.y == null) return
    const fill = isFilled(item)
    const stroke = strokeOf(item)
    if (!fill && !stroke) return
    const size = (item.size as number) ?? SYMBOL_DEFAULT_SIZE
    const r = radius != null ? radius : Math.sqrt(size) / 2
    const cx = tx + item.x
    const cy = ty + item.y
    const shape = marktype === 'symbol' ? (rec(item).shape as string | undefined) : undefined
    if (shape == null || shape === 'circle') {
      // (the circle is one arc closed on itself: no caps, no joins)
      const out = r + (stroke ? stroke.hw : 0)
      entries.push({ item, marktype, kind: 'circle', cx, cy, r, fill, stroke, x1: cx - out, y1: cy - out, x2: cx + out, y2: cy + out })
      return
    }
    const outline = shapeOutline(shape, r)
    const span = outline.reach + reachOf(stroke)
    const rot = ((rec(item).angle as number | undefined) ?? 0) * (Math.PI / 180)
    entries.push({ item, marktype, kind: 'geom', cx, cy, rot, fill, stroke, polys: outline.polys, x1: cx - span, y1: cy - span, x2: cx + span, y2: cy + span })
  }

  function addMarkItem(item: SceneItem, marktype: string, tx: number, ty: number): void {
    switch (marktype) {
      case 'rect': {
        const fill = isFilled(item)
        const stroke = strokeOf(item)
        if (!fill && !stroke) return
        // vega draws a rect at `x || 0`, `y || 0`, `width || 0`, `height || 0`
        const x0 = tx + (+(item.x as number) || 0)
        const y0 = ty + (+(item.y as number) || 0)
        const w = +(item.width as number) || 0
        const h = +(item.height as number) || 0
        const rounded = rec(item).cornerRadius !== undefined || rec(item).cornerRadiusTopLeft !== undefined
          || rec(item).cornerRadiusTopRight !== undefined || rec(item).cornerRadiusBottomLeft !== undefined || rec(item).cornerRadiusBottomRight !== undefined
        if (rounded) {
          // a rounded rect: its own outline, so the corners outside it are not hits
          const d = rectItemPath(item)
          if (d != null) {
            const e = geomEntry(item, marktype, () => flattenPath(String(d), (x, y) => [tx + x, ty + y]), item, undefined, stroke)
            if (e) entries.push(e)
            return
          }
        }
        if (!stroke) {
          // the common case: a filled rectangle is its box
          entries.push({ item, marktype, kind: 'box', fill, stroke: null, x1: Math.min(x0, x0 + w), y1: Math.min(y0, y0 + h), x2: Math.max(x0, x0 + w), y2: Math.max(y0, y0 + h) })
          return
        }
        const e = geomEntry(item, marktype, () => [{ pts: [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h], closed: true }], item, undefined, stroke)
        if (e) entries.push(e)
        return
      }
      case 'symbol':
      case 'circle':
        addSymbol(item, marktype, tx, ty)
        return
      case 'rule': {
        // (vega: a rule is its stroke, a segment from (x, y) to (x2, y2), each end defaulting to the other)
        const stroke = strokeOf(item)
        if (!stroke) return
        const x = tx + (+(item.x as number) || 0)
        const y = ty + (+(item.y as number) || 0)
        const x2 = item.x2 != null ? tx + +item.x2 : x
        const y2 = item.y2 != null ? ty + +item.y2 : y
        const e = geomEntry(item, marktype, () => [{ pts: [x, y, x2, y2], closed: false }], { stroke: item.stroke }, undefined, stroke)
        if (e) entries.push(e)
        return
      }
      case 'text': {
        const e = textEntry(item, marktype, tx, ty, true)
        if (e) entries.push(e)
        return
      }
      case 'arc': {
        const d = String(itemArcPath(item, null))
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
        const sx = (rec(item).scaleX as number | undefined) || 1
        const sy = (rec(item).scaleY as number | undefined) || 1
        const path = String(item.path)
        const angle = (rec(item).angle as number | undefined) ?? 0
        const e = angle
          // vega draws a path item at translate(x, y) rotate(angle) scale(scaleX, scaleY)
          ? geomEntry(item, marktype, () => flattenPath(path, (x, y) => [sx * x, sy * y]), item, { cx: tx + (item.x || 0), cy: ty + (item.y || 0), rot: angle * (Math.PI / 180) })
          : geomEntry(item, marktype, () => flattenPath(path, (x, y) => [tx + (item.x || 0) + sx * x, ty + (item.y || 0) + sy * y]), item)
        if (e) entries.push(e)
        return
      }
      case 'image': {
        if (item.x == null || item.y == null) return
        const b = imageBox(item)
        entries.push({ item, marktype, kind: 'box', fill: true, stroke: null, x1: tx + Math.min(b.x, b.x + b.w), y1: ty + Math.min(b.y, b.y + b.h), x2: tx + Math.max(b.x, b.x + b.w), y2: ty + Math.max(b.y, b.y + b.h) })
        return
      }
      default:
        // a mark type no renderer draws has nothing to hit
        return
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

  // what a query looks at: `ALL` the painted items the guides and marks have, `DATA` the items of interactive marks, `PICK` what
  // takes the pointer
  type Mode = 0 | 1 | 2
  const ALL = 0, DATA = 1, PICK = 2
  const skipped = (e: Entry, mode: Mode): boolean =>
    mode === PICK ? e.inert === true : e.pickOnly === true || (mode === DATA && (e.inert === true || e.groupBox === true || e.guide === true))

  const hitLinear = (x: number, y: number, mode: Mode): Entry | null => {
    // Reverse scan: later entries paint on top (entries are kept in paint order).
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (skipped(e, mode)) continue
      if (hits(e, x, y)) return e
    }
    return null
  }

  const hitGrid = (x: number, y: number, mode: Mode): Entry | null => {
    // Draw order matters for overlapping marks: the topmost painted item is
    // the one with the highest index. Merge the cell's list and the big list
    // (both ascending) from their ends.
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
      if (skipped(e, mode)) continue
      if (hits(e, x, y)) return e
    }
    return null
  }

  function inClips(cl: Clip[], x: number, y: number): boolean {
    for (const c of cl) {
      if (!(x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2)) return false
      if (c.polys && !insidePolys(c.polys, x, y)) return false
    }
    return true
  }

  function hits(e: Entry, x: number, y: number): boolean {
    if (!(x >= e.x1 && x <= e.x2 && y >= e.y1 && y <= e.y2)) return false
    if (e.clips && !inClips(e.clips, x, y)) return false
    switch (e.kind) {
      case 'box':
        return true
      case 'circle': {
        const d = Math.hypot(x - e.cx!, y - e.cy!)
        return (e.fill === true && d <= e.r!) || (e.stroke != null && Math.abs(d - e.r!) <= e.stroke.hw)
      }
      case 'text': {
        // into the text's own frame: about the anchor, undoing the rotation
        const [lx, ly] = local(e, x, y)
        const b = e.box!
        return lx >= b[0] && lx <= b[2] && ly >= b[1] && ly <= b[3]
      }
      case 'geom': {
        const polys = e.polys ?? (e.polys = e.build!())
        const [px, py] = e.cx !== undefined ? local(e, x, y) : [x, y]
        if (e.fill && inFill(polys, px, py)) return true
        return e.stroke != null && inStroke(polys, px, py, e.stroke)
      }
    }
  }

  const find = (x: number, y: number, mode: Mode): Entry | null => {
    if (entries.length === 0 || !(x === x && y === y)) return null
    if (entries.length <= GRID_THRESHOLD) return hitLinear(x, y, mode)
    if (grid == null) buildGrid()
    return hitGrid(x, y, mode)
  }
  const target = (e: Entry, item: SceneItem): HitTarget => ({
    item,
    marktype: e.marktype,
    kind: e.groupBox ? (e.guide ? 'guide' : 'group') : e.guide || e.pickOnly ? 'guide' : 'mark',
    ...(e.fromData ? { fromData: true } : {}),
  })
  /** What `query` and `queryMark` report: a line, an area or a trail as its item nearest the point. */
  const nearest = (e: Entry | null, x: number, y: number): HitTarget | null =>
    e === null ? null : target(e, e.multi ? nearestOf(e.multi.items, e.multi.tx, e.multi.ty, x, y) : e.item)

  return {
    query: (x, y) => nearest(find(x, y, ALL), x, y),
    queryMark: (x, y) => nearest(find(x, y, DATA), x, y),
    pick(x: number, y: number): HitTarget | null {
      const e = find(x, y, PICK)
      return e === null ? null : target(e, e.item)
    },
    tooltip(x: number, y: number): HitTarget | null {
      const e = find(x, y, PICK)
      if (e === null) return null
      if (!e.multi) return target(e, e.item)
      const it = tipOf(e.multi.type, e.multi.items, x - e.multi.tx, y - e.multi.ty)
      return it === null ? null : target(e, it)
    },
    size(): number {
      let n = 0
      for (const e of entries) if (!e.groupBox && !e.pickOnly) n++
      return n
    },
  }
}

// Symbol outlines are shared by every symbol of a shape and size.
const OUTLINES = new Map<string, { polys: Poly[]; reach: number }>()

function shapeOutline(shape: string, r: number): { polys: Poly[]; reach: number } {
  const key = `${shape}|${r}`
  let o = OUTLINES.get(key)
  if (o) return o
  const polys = flattenPath(symbolPathExact(shape, r), (x, y) => [x, y])
  let reach = 0
  for (const { pts } of polys) for (let i = 0; i < pts.length; i += 2) reach = Math.max(reach, Math.hypot(pts[i]!, pts[i + 1]!))
  o = { polys, reach }
  if (OUTLINES.size > 256) OUTLINES.clear()
  OUTLINES.set(key, o)
  return o
}
