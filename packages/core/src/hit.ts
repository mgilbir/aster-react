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
 * vega's two renderers pick differently where an item's painted geometry reaches past the bounds vega measured for it (a rotated
 * path, a trail, a group whose content overflows its box, a stroke past a measured corner): the browser's hit test of the SVG
 * finds what is painted, vega's canvas pick tests the bounds first (marks/group.js, util/canvas/pick.js and markMultiItemPath.js:
 * a group item's `bounds`, a mark's `bounds`, an item's `bounds`) and finds nothing there. An index built for the canvas
 * renderer (`{ renderer: 'canvas' }`) tests them too: the bounds of every group item around an entry (the bounds the layout
 * reads, `layoutBounds`), and the entry's own -- its item's (`boundLeaf`, as the bounds pass measures each item), or for a line,
 * an area or a trail its mark's. The geometry is the same; only the test differs.
 *
 * A uniform grid buckets entries by bounding box; everything is also
 * resolvable by a linear scan for small scenes. Cell ranges are clamped to the
 * grid and an entry spanning too many cells (a huge item, a full-view
 * background) is kept in a short separate list instead of being replicated into
 * every cell.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { derivedCounts, isEngineNode, keptInto } from './scene-registry.js'
import { Bounds, boundLeaf, boundTypedMark, boundText, groupLayoutBounds, itemBounds, multiMarkBounds, sameGroupMark } from './bounds.js'
import { getTextMetricsProvider, textAnchor } from './text-metrics.js'
import { imageBox } from './image-box.js'
import { FLATTEN_TOLERANCE, insidePolys, type Poly } from './path-flatten.js'
import { SYMBOL_DEFAULT_SIZE, drawnOffset, frameSize } from './util.js'
import { isInert, itemArcGeometry, lineStrokeWidth } from './render.js'
import { areaGeometry, lineGeometry, rectData, symbolGeometry, trailGeometry } from './geometry.js'
import { arcExactSegs, arcPolys, canvasHolds, curvePolys, flattenSegs, pathMarkPolys, pathMarkPolysAt, pathPolys, segsOf, symbolOutline, transformPolys } from './geometry-read.js'

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
  /** The dash pattern (an even number of lengths, some above 0) and where along it the outline starts: gaps take no pointer. */
  dash?: readonly number[]
  dashOffset?: number
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
  kind: 'disc' | 'circle' | 'box' | 'text' | 'geom'
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
  /** Not interactive (its mark / guide part says `pointer-events: none`): `pick` looks through it. */
  inert?: true
  /** A guide part the other queries never saw (an interactive legend entry, symbol path, gradient, tick...): only `pick` finds it. */
  pickOnly?: true
  /**
   * (canvas index) What vega measured the entry's bounds from, in the frame at (ox, oy): its item as a mark of `bk`'s type (a
   * mark item; `leaf` for a guide's part), or its mark (`multi`: a line, an area or a trail); the box, once measured.
   */
  bk?: string
  ox?: number
  oy?: number
  bmark?: SceneGroup
  /** (canvas index) a typed mark's item: its mark and the frame it clips to, for the mark's bounds vega asks first */
  tmark?: SceneGroup
  tfw?: number
  tfh?: number
  vb?: Float64Array
}

/** The outline of a group item's box as the pointer meets it (the canvas's, where a box stroked in front differs: see `_canvasPath`). */
function boxPathOf(item: SceneItem): string {
  return ((item as unknown as Record<string, unknown>)._canvasPath as string | undefined) ?? String(item.path)
}

/** How an index picks: as the browser hit-tests vega's SVG (the default), or as vega's canvas renderer picks. */
export interface HitIndexOptions {
  renderer?: 'svg' | 'canvas'
}

/** A target is read-only: the index hands out the same object for the same item each time it is hit. */
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
function strokeOf(it: { stroke?: unknown; strokeWidth?: unknown; strokeCap?: unknown; strokeJoin?: unknown; strokeMiterLimit?: unknown; strokeDash?: unknown; strokeDashOffset?: unknown }, defaultWidth = 1): Stroke | null {
  if (!it.stroke) return null
  const w = it.strokeWidth != null ? +(it.strokeWidth as number) : defaultWidth
  if (!(w > 0)) return null
  const limit = it.strokeMiterLimit != null ? +(it.strokeMiterLimit as number) : 4
  const st: Stroke = {
    hw: w / 2,
    cap: typeof it.strokeCap === 'string' ? it.strokeCap : 'butt',
    join: typeof it.strokeJoin === 'string' ? it.strokeJoin : 'miter',
    limit: limit >= 1 ? limit : 4,
  }
  const dash = dashPattern(it.strokeDash)
  if (dash !== null) {
    st.dash = dash
    const o = +(it.strokeDashOffset as number)
    st.dashOffset = Number.isFinite(o) ? o : 0
  }
  return st
}

/**
 * A stroke's dash pattern as a canvas (`setLineDash`) and an SVG (`stroke-dasharray`) read it: an array of lengths none of which is
 * negative or not a number, an odd one repeated to make an even one; one of no length at all is no dash. Null when there is none.
 */
function dashPattern(v: unknown): readonly number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: number[] = []
  let sum = 0
  for (const e of v) {
    const n = +(e as number)
    if (!(n >= 0) || !Number.isFinite(n)) return null
    out.push(n)
    sum += n
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return null
  return out.length % 2 === 1 ? out.concat(out) : out
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

/**
 * An outline as its stroke is tested: the vertices without repeats (a segment of no length has no direction), and each segment's
 * length and unit direction. Made once per outline (a symbol's is shared by every symbol of its shape and size).
 *
 * For vega's canvas pick (`stroker`), as the canvas's stroker builds the stroke `isPointInStroke` tests: a segment shorter than
 * its degenerate length (Skia's SK_ScalarNearlyZero, 1/4096 px, below which it cannot normalize a direction) is no segment, so
 * no join (a closing segment the arithmetic left a hair long would otherwise turn the outline back on itself and miter a spike);
 * and where two chords of curves meet there is no corner: it joins curves along their own tangents, which meet there (a spline is
 * smooth through its points) or turn right back (a cusp, which it bevels), so the join is a bevel. (The SVG's pick keeps the
 * outline as the browser's hit test of vega's SVG was measured against: those vertices have no effect there that the pointer
 * phase finds, and the geometry differential pins it.)
 */
const DEGENERATE = 1 / 4096
interface StrokePath { v: Float64Array; m: number; segs: number; len: Float64Array; dir: Float64Array; closed: boolean; smooth: Uint8Array | null }
const STROKE_PATHS = new WeakMap<Poly, StrokePath>()
const STROKER_PATHS = new WeakMap<Poly, StrokePath>()

function strokePath(poly: Poly, stroker: boolean): StrokePath {
  const cache = stroker ? STROKER_PATHS : STROKE_PATHS
  let sp = cache.get(poly)
  if (sp !== undefined) return sp
  const tol = stroker ? DEGENERATE : 0
  const { pts, closed, curved } = poly
  const v: number[] = []
  /** per kept vertex: whether the segment that ends there is a chord of a curve */
  const chord: boolean[] = []
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i]!, py = pts[i + 1]!
    if (v.length === 0 || (tol === 0 ? px !== v[v.length - 2] || py !== v[v.length - 1] : Math.hypot(px - v[v.length - 2]!, py - v[v.length - 1]!) >= tol)) { v.push(px, py); chord.push(curved?.[i / 2] === true) }
  }
  let m = v.length / 2
  if (closed && m > 1 && (tol === 0 ? v[0] === v[2 * m - 2] && v[1] === v[2 * m - 1] : Math.hypot(v[0]! - v[2 * m - 2]!, v[1]! - v[2 * m - 1]!) < tol)) { chord[0] = chord[m - 1]!; v.length -= 2; chord.length--; m-- }
  const segs = m < 2 ? 0 : closed ? m : m - 1
  const len = new Float64Array(segs)
  const dir = new Float64Array(2 * segs)
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m
    const dx = v[2 * j]! - v[2 * i]!, dy = v[2 * j + 1]! - v[2 * i + 1]!
    const l = Math.hypot(dx, dy)
    len[i] = l
    dir[2 * i] = dx / l
    dir[2 * i + 1] = dy / l
  }
  // a vertex between two chords of curves is no corner of the path: the stroker joins curves along their own tangents, which
  // meet there (a spline is smooth through its points) or turn right back (a cusp, which it bevels)
  let smooth: Uint8Array | null = null
  if (stroker) {
    smooth = new Uint8Array(m)
    for (let i = 0; i < m; i++) smooth[i] = chord[i] && chord[(i + 1) % m] && (closed || (i > 0 && i < m - 1)) ? 1 : 0
  }
  sp = { v: Float64Array.from(v), m, segs, len, dir, closed, smooth }
  cache.set(poly, sp)
  return sp
}

/** The most pieces one outline is cut into: a pattern finer than that (over a 3 px long dash in a 100 000 px outline) strokes it whole. */
const MAX_DASH_PIECES = 100_000
const DASHED = new WeakMap<Poly, { key: string; pieces: Poly[] | null }>()

/**
 * The dashes of an outline, each an open outline of its own (butt or other caps at its ends, joins inside), the pattern starting at
 * the start of the outline, pushed `offset` into it, and again with each subpath; null when the pattern is too fine for the outline.
 */
function dashed(poly: Poly, dash: readonly number[], offset: number): Poly[] | null {
  const key = dash.join(',') + '/' + offset
  const kept = DASHED.get(poly)
  if (kept !== undefined && kept.key === key) return kept.pieces
  const pieces = cutIntoDashes(poly, dash, offset)
  DASHED.set(poly, { key, pieces })
  return pieces
}

function cutIntoDashes(poly: Poly, dash: readonly number[], offset: number): Poly[] | null {
  const { pts, closed } = poly
  const n = pts.length / 2
  if (n < 2) return null
  const period = dash.reduce((a, b) => a + b, 0)
  const segs = closed ? n : n - 1
  let total = 0
  for (let i = 0; i < segs; i++) { const j = (i + 1) % n; total += Math.hypot(pts[2 * j]! - pts[2 * i]!, pts[2 * j + 1]! - pts[2 * i + 1]!) }
  if (!(Number.isFinite(total) && (total / period + 1) * dash.length < MAX_DASH_PIECES)) return null
  // where in the pattern the outline starts: `offset` into it
  let idx = 0
  let at = ((offset % period) + period) % period
  while (at >= dash[idx]!) { at -= dash[idx]!; idx = (idx + 1) % dash.length }
  let left = dash[idx]! - at
  const out: Poly[] = []
  let cur: number[] | null = null
  const flush = (): void => { if (cur !== null) { out.push({ pts: cur, closed: false }); cur = null } }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * j]!, by = pts[2 * j + 1]!
    const len = Math.hypot(bx - ax, by - ay)
    if (!(len > 0)) continue
    let pos = 0
    while (pos < len) {
      const take = Math.min(left, len - pos)
      if (idx % 2 === 0) {
        if (cur === null) cur = [ax + ((bx - ax) * pos) / len, ay + ((by - ay) * pos) / len]
        cur.push(ax + ((bx - ax) * (pos + take)) / len, ay + ((by - ay) * (pos + take)) / len)
      }
      pos += take
      left -= take
      if (left > 0) break
      // the dash or the gap ended: on to the next, and past any of no length (a dash of none is a dot where it falls)
      if (idx % 2 === 0) flush()
      do {
        idx = (idx + 1) % dash.length
        left = dash[idx]!
        if (left === 0 && idx % 2 === 0) { const px = ax + ((bx - ax) * pos) / len, py = ay + ((by - ay) * pos) / len; out.push({ pts: [px, py], closed: false }) }
      } while (left === 0)
    }
  }
  flush()
  return out
}

/** Whether (x, y) is within the stroke of an outline: the band along each segment, the joins between them, the caps of open ends. */
function inStroke(polys: Poly[], x: number, y: number, st: Stroke, stroker = false): boolean {
  if (st.dash !== undefined) {
    // (the dashes, each tested as an outline of its own; an outline the pattern is too fine for is stroked whole)
    const solid: Stroke = { hw: st.hw, cap: st.cap, join: st.join, limit: st.limit }
    for (const poly of polys) {
      const pieces = dashed(poly, st.dash, st.dashOffset ?? 0)
      if (inStroke(pieces ?? [poly], x, y, solid, stroker)) return true
    }
    return false
  }
  for (const poly of polys) {
    const { v, m, segs, len, dir, closed, smooth } = strokePath(poly, stroker)
    if (m === 0) continue
    if (m === 1) {
      // a subpath of one point paints only its caps: a round one is a dot, a square one an upright square
      if (closed) continue
      const dx = x - v[0]!, dy = y - v[1]!
      if (st.cap === 'round' && Math.hypot(dx, dy) <= st.hw) return true
      if (st.cap === 'square' && Math.abs(dx) <= st.hw && Math.abs(dy) <= st.hw) return true
      continue
    }
    for (let i = 0; i < segs; i++) {
      const ax = v[2 * i]!, ay = v[2 * i + 1]!
      const j = (i + 1) % m
      const bx = v[2 * j]!, by = v[2 * j + 1]!
      // (a segment whose box, grown by half the width, misses the point cannot hold it: most of a long outline is skipped so)
      if ((x < ax && x < bx) || (x > ax && x > bx) || (y < ay && y < by) || (y > ay && y > by)) {
        if (x < Math.min(ax, bx) - st.hw || x > Math.max(ax, bx) + st.hw || y < Math.min(ay, by) - st.hw || y > Math.max(ay, by) + st.hw) continue
      }
      const dx = dir[2 * i]!, dy = dir[2 * i + 1]!
      const along = (x - ax) * dx + (y - ay) * dy
      if (along >= 0 && along <= len[i]! && Math.abs((x - ax) * -dy + (y - ay) * dx) <= st.hw) return true
    }
    // the joins: at every vertex of a closed outline, at the inner ones of an open one (none reaches further than the miter limit)
    const reach = st.hw * Math.max(1, st.limit)
    for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) {
      const vx = v[2 * i]!, vy = v[2 * i + 1]!
      if (Math.abs(x - vx) > reach || Math.abs(y - vy) > reach) continue
      const pi = (i - 1 + segs) % segs
      if (inJoin(vx, vy, dir[2 * pi]!, dir[2 * pi + 1]!, dir[2 * i]!, dir[2 * i + 1]!, x, y, smooth?.[i] ? { ...st, join: 'bevel' } : st)) return true
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
    // (an outline that holds no area, a rectangle of no height, has no edge a fill test finds: the browser's and vega's find no point on it)
    if (hasNoArea(pts)) continue
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * j]!, by = pts[2 * j + 1]!
      if (x < Math.min(ax, bx) - FLATTEN_TOLERANCE || x > Math.max(ax, bx) + FLATTEN_TOLERANCE || y < Math.min(ay, by) - FLATTEN_TOLERANCE || y > Math.max(ay, by) + FLATTEN_TOLERANCE) continue
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
      if (d <= 1e-9 || (curved?.[j] === true && j !== 0 && d <= FLATTEN_TOLERANCE)) return true
    }
  }
  return false
}

/** Whether a closed outline (its points, implicitly closed) encloses no area at all: the shoelace sum is exactly 0. */
const NO_AREA = new WeakMap<number[], boolean>()
function hasNoArea(pts: number[]): boolean {
  let z = NO_AREA.get(pts)
  if (z === undefined) {
    const n = pts.length / 2
    let a = 0
    for (let i = 0, j = n - 1; i < n; j = i++) a += pts[2 * j]! * pts[2 * i + 1]! - pts[2 * i]! * pts[2 * j + 1]!
    NO_AREA.set(pts, (z = a === 0))
  }
  return z
}

/** The box of a path's own outline (`pathPolys`, `pathMarkPolys`), kept with the outline (which the bounded parse cache keeps). */
const LOCAL_BOXES = new WeakMap<Poly[], [number, number, number, number] | null>()
function polysLocalBox(polys: Poly[]): [number, number, number, number] | null {
  let box = LOCAL_BOXES.get(polys)
  if (box === undefined) LOCAL_BOXES.set(polys, (box = polysBox(polys)))
  return box
}
const localPathBox = (d: string): [number, number, number, number] | null => polysLocalBox(pathPolys(d))
const localPathMarkBox = (d: string, sx: number, sy: number): [number, number, number, number] | null => polysLocalBox(pathMarkPolys(d, sx, sy))

/**
 * The box of an outline placed at (ox, oy) and scaled by (sx, sy) -- each point `ox + sx * x`, `oy + sy * y` -- from the box of the
 * outline itself: the same numbers `polysBox` gives over the placed points. A point's placed coordinate is a rounded sum and a
 * rounded product, each monotone in the coordinate (the product turned around for a negative scale), so the placed extremes are
 * the placed extremes of the outline's. Null where `polysBox` gives null: a box that is not finite.
 */
function placedBox(b: [number, number, number, number], ox: number, oy: number, sx: number, sy: number): [number, number, number, number] | null {
  const xa = ox + sx * b[0], xb = ox + sx * b[2]
  const ya = oy + sy * b[1], yb = oy + sy * b[3]
  const x1 = sx < 0 ? xb : xa, x2 = sx < 0 ? xa : xb
  const y1 = sy < 0 ? yb : ya, y2 = sy < 0 ? ya : yb
  return Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2) ? [x1, y1, x2, y2] : null
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

/** (x, y) in the frame of an entry that has one of its own (a text box, a symbol outline, a rotated path), left in (localX, localY). */
let localX = 0
let localY = 0
function toLocal(e: Entry, x: number, y: number): void {
  const dx = x - e.cx!
  const dy = y - e.cy!
  if (!e.rot) { localX = dx; localY = dy; return }
  const c = Math.cos(e.rot), s = Math.sin(e.rot)
  localX = dx * c + dy * s
  localY = -dx * s + dy * c
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

/**
 * The entries a leaf mark of a scene the engine returned made at a place (`gx`, `gy`: its frame in scene coordinates), before the
 * clips and flags of the index it was made in were written on them, for each renderer (an index for the canvas picks its strokes
 * and measures its bounds as vega's canvas does: its entries are its own). Such a mark holds what it held (scene-registry.ts), and
 * what `addMark` (and, on the canvas, `measuredBy`) makes of a mark reads the mark and the place alone -- but for a text item, whose
 * box is measured by the text metrics in use when the index is built, so a text mark is not kept. An index takes copies; the clips
 * around the mark, its `inert` and `guide` flags and its data runs are written as for a mark made anew. Used for a later scene that
 * kept the mark (`keptInto`).
 */
const MARK_ENTRIES = { svg: new WeakMap<SceneGroup, KeptEntries>(), canvas: new WeakMap<SceneGroup, KeptEntries>() }
interface KeptEntries { gx: number; gy: number; unbounded: boolean; entries: Entry[]; root: object }

/**
 * The entries one of the view's own guides (an axis, a legend, a title: a group of the scene's top level) made, flags and clips
 * written, for each renderer, with the runs of them that are data's (relative to the first). Such a group holds what it held, its
 * parts included (scene-registry.ts), so what indexing it makes reads besides the group only: where the view's frame is and how
 * large (`frame`: the padding, the plot's size, whether the view clips to it, which is the one clip around a guide of the top
 * level), and the text measurer set for every chart (its labels' and titles' boxes are measured when the index is built). Used for a
 * later scene that kept the group (`keptInto`); an index takes copies.
 */
const GUIDE_ENTRIES = { svg: new WeakMap<SceneGroup, KeptGuide>(), canvas: new WeakMap<SceneGroup, KeptGuide>() }
interface KeptGuide { frame: string; measurer: unknown; entries: Entry[]; runs: number[]; root: object }
const TOP_GUIDE_ROLES: ReadonlySet<string> = new Set(['axis', 'legend', 'title'])

export function buildHitIndex(scene: SceneRoot, cell = DEFAULT_CELL, options: HitIndexOptions = {}): HitIndex {
  const canvas = options.renderer === 'canvas'
  const keptEntries = canvas ? MARK_ENTRIES.canvas : MARK_ENTRIES.svg
  const entries: Entry[] = []
  /** The runs of entries `[from, to)` made for a mark that reads a dataset (their items' datums are rows), in order. */
  const dataRuns: number[] = []
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
  /**
   * A group's clip to its frame (w x h at x, y): a size that is not finite clips everything away on both renderers (an SVG `rect` of
   * such a size, like a canvas `rect`, adds nothing to the clip); a negative one clips to the box on the other side on a canvas, and
   * everything away in an SVG, whose `rect` of negative size draws nothing.
   */
  const frameClip = (x: number, y: number, w: number, h: number): Clip =>
    !Number.isFinite(w) || !Number.isFinite(h) || (!canvas && (w < 0 || h < 0)) ? { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity } : rectClip(x, y, w, h)
  /** A group item's bounds (vega's: what it holds, its box unless `noBound`, its stroke) in scene coordinates. */
  /** A group item's bounds as vega measured them, made once per index (the group item's own clip and its group mark's union ask them). */
  const groupBounds = new Map<SceneGroup, Bounds>()
  const boundsOf = (group: SceneGroup): Bounds => {
    let b = groupBounds.get(group)
    if (b === undefined) groupBounds.set(group, (b = groupLayoutBounds(group, true)))
    return b
  }
  const boundsClip = (group: SceneGroup, tx: number, ty: number): Clip => {
    // (vega's `contains`, "not outside": an edge as `Number` reads it, and one that is not a number excludes nothing; empty bounds
    // hold nothing)
    const b = boundsOf(group)
    const lo = (v: number): number => { const n = +v; return Number.isNaN(n) ? -Infinity : n }
    const hi = (v: number): number => { const n = +v; return Number.isNaN(n) ? Infinity : n }
    return { x1: tx + lo(b.x1), y1: ty + lo(b.y1), x2: tx + hi(b.x2), y2: ty + hi(b.y2) }
  }
  /**
   * (canvas index) The bounds vega's pick asks of each group MARK among `nodes` (a group's marks, the root's), before its items: the
   * union of its group items' bounds (an edge that is not a number leaves that edge out of the union), cut to the frame when the mark
   * clips, in scene coordinates, for the node at each index that is a group item of one; `undefined` for the rest. A mark whose items
   * have bounds that are all numbers needs none: each item's own bounds, asked next, are inside the union.
   */
  const groupMarkClips = (nodes: readonly SceneGroup[], fw: number, fh: number, gx: number, gy: number): (Clip | undefined)[] | undefined => {
    let out: (Clip | undefined)[] | undefined
    const lo = (v: number): number => { const n = +v; return Number.isNaN(n) ? -Infinity : n }
    const hi = (v: number): number => { const n = +v; return Number.isNaN(n) ? Infinity : n }
    for (let k = 0; k < nodes.length;) {
      const first = nodes[k]!
      if (rec(first)._scope !== true) { k++; continue }
      let end = k
      let numbers = true
      while (end < nodes.length && sameGroupMark(first as unknown as Record<string, unknown>, nodes[end] as unknown as Record<string, unknown>)) {
        const b = boundsOf(nodes[end]!)
        if (!(Number.isFinite(b.x1) && Number.isFinite(b.y1) && Number.isFinite(b.x2) && Number.isFinite(b.y2))) numbers = false
        end++
      }
      if (!numbers) {
        const mb = new Bounds()
        for (let i = k; i < end; i++) mb.union(boundsOf(nodes[i]!))
        const m = rec(first).markClip === true ? mb.intersect(new Bounds().set(0, 0, fw, fh)) : mb
        const clip: Clip = { x1: gx + lo(m.x1), y1: gy + lo(m.y1), x2: gx + hi(m.x2), y2: gy + hi(m.y2) }
        out ??= []
        for (let i = k; i < end; i++) out[i] = clip
      }
      k = end
    }
    return out
  }
  /**
   * (canvas index) The bounds vega's pick asks of a typed mark before its items (`pickMark`): the union of the items' bounds (an edge
   * that is not a number is left out of it), cut to the frame when the mark clips. Asked of an item whose own bounds have an edge that is
   * not a number only: where they are all numbers, the item's own test is inside the mark's.
   */
  const typedMarkBoxes = new Map<SceneGroup, Float64Array>()
  const typedMarkBox = (mark: SceneGroup, fw: number, fh: number): Float64Array => {
    let box = typedMarkBoxes.get(mark)
    if (box === undefined) {
      const b = boundTypedMark(new Bounds(), mark)
      const m = mark.clip === true ? b.intersect(new Bounds().set(0, 0, fw, fh)) : b
      typedMarkBoxes.set(mark, (box = Float64Array.of(+m.x1, +m.y1, +m.x2, +m.y2)))
    }
    return box
  }
  const pathClip = (d: string, ox: number, oy: number): Clip => {
    const polys = transformPolys(pathPolys(d), (x, y) => [ox + x, oy + y])
    const box = polysBox(polys)
    // (an outline with no point clips everything away)
    return box ? { x1: box[0], y1: box[1], x2: box[2], y2: box[3], polys } : { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  }

  // (tx, ty): where the frame of the group around the marks is; (fw, fh): its size, what a mark's `clip` clips to
  /**
   * (canvas index) Inside a group whose position reads as a string that is not a number, vega's pick runs on NaN coordinates: every
   * bounds it asks about "contains" them, so no bounds test excludes anything there (the geometry, drawn at the origin, still does).
   */
  let unbounded = false
  const walk = (group: SceneGroup, tx: number, ty: number, fw: number, fh: number, outer?: SceneGroup): void => {
    // (where vega's renderers draw the group's content: see `drawnOffset`)
    const [ox, oy] = drawnOffset(group)
    const gx = tx + ox
    const gy = ty + oy
    const type = group.marktype
    if (canvas && (!type || type === 'group')) {
      const rx = +((group.x || 0) as number)
      const ry = +((group.y || 0) as number)
      // (an infinite position puts the pointer at an infinite distance in the group's frame: its bounds never hold it)
      if (rx === Infinity || rx === -Infinity || ry === Infinity || ry === -Infinity) return
      if (Number.isNaN(rx) || Number.isNaN(ry)) {
        const was = unbounded
        unbounded = true
        // (the group item's own bounds are asked in the frame around it, where its position does not matter)
        try { walkGroup(group, tx, ty, gx, gy, fw, fh, outer, !was) } finally { unbounded = was }
        return
      }
    }
    if (!type || type === 'group') walkGroup(group, tx, ty, gx, gy, fw, fh, outer)
    else walkMark(group, type, tx, ty, gx, gy, fw, fh)
  }
  const walkGroup = (group: SceneGroup, tx: number, ty: number, gx: number, gy: number, fw: number, fh: number, outer?: SceneGroup, selfBounded: boolean = !unbounded): void => {
    {
      // a group item's own box (vega-scenegraph marks/group.js): its background is painted under the content, its
      // foreground over it. What the pointer meets is the painted rectangle -- the fill inside it, the stroke along it --
      // exactly as the browser tests the `path.background` / `path.foreground` of the SVG.
      const scope = rec(group)._scope === true
      const box = scope && group.interactive !== false ? groupBoxFaces(group, gx, gy) : { background: null, foreground: null }
      // an axis or a legend: its leaves are the marks of its parts, each interactive only if the spec said so
      const guide = !scope && (group.role === 'axis' || group.role === 'legend') ? group : null
      const meta = guide ? (outer?.partMeta ?? guide.partMeta) : undefined
      const w = frameSize(group, 'width', fw)
      const h = frameSize(group, 'height', fh)
      // a group item's `clip` (encode) clips what it holds to its box: the content `<g>` of the SVG
      const content = rec(group).contentClip === true ? (group.clipPathD ? pathClip(group.clipPathD, gx, gy) : frameClip(gx, gy, w, h)) : null
      // vega looks for a group item, its box and what it holds, only within its bounds: they hold all of it, unless its box is
      // left out of them (`noBound`), where its box takes the pointer only as far as what it holds reaches
      // (vega's canvas pick tests every group item's bounds first, an axis' and a legend's too: they bound what it finds there)
      const bounds = ((scope && group.noBound === true) || canvas) && selfBounded ? boundsClip(group, tx, ty) : null
      // a group mark's own `clip` clips its items to the frame of the group around them
      // (vega's canvas pick looks for a clipped group item, its box included, only inside the box -- and inside its rounded
      // outline when it has corners: marks/group.js `hitCorner` -- where the browser also finds the stroke past it)
      // (the scene keeps a clipped group item's content in a child group that clips it: on the canvas its clip bounds the whole item)
      const clipped = canvas && scope ? ((group.items ?? []) as SceneGroup[]).find((c) => isGroup(c as SceneItem) && rec(c).contentClip === true) : undefined
      const itemClip = clipped === undefined ? null
        : clipped.clipPathD ? pathClip(clipped.clipPathD, gx + (clipped.x ?? 0), gy + (clipped.y ?? 0)) : frameClip(gx + (clipped.x ?? 0), gy + (clipped.y ?? 0), frameSize(clipped, 'width', w), frameSize(clipped, 'height', h))
      // an axis's or a title's group item, held as its box: picked where it is painted when the spec made it `interactive`
      const held = !scope ? guideBoxFaces(group, gx, gy, outer) : null
      withClip(rec(group).markClip === true ? frameClip(tx, ty, fw, fh) : null, () => withClip(bounds, () => withClip(itemClip, () => {
        if (box.background) { entries.push(box.background); clipFrom(entries.length - 1) }
        if (held?.background) { entries.push(held.background); clipFrom(entries.length - 1) }
        withClip(content, () => {
          // (a legend entry's front stroke belongs to the entry box before it)
          let entryBox: SceneItem | undefined
          const nodes = group.items ?? []
          const markClips = canvas && !unbounded ? groupMarkClips(nodes, w, h, gx, gy) : undefined
          for (let k = 0; k < nodes.length; k++) {
            const item = nodes[k]!
            if (isGroup(item)) { withClip(markClips?.[k] ?? null, () => walk(item, gx, gy, w, h, guide ?? outer)); continue }
            const part = (item as SceneItem)._part
            if (part === 'entry') entryBox = item
            const before = entries.length
            addLeaf(item, gx, gy)
            if (guide) {
              if (!partInteractive(guide, meta, item)) {
                for (let i = before; i < entries.length; i++) entries[i]!.inert = true
              } else if (entries.length === before) {
                addGuidePart(item, gx, gy, guide, part === 'entryFg' ? entryBox : undefined)
              }
              for (let i = before; i < entries.length; i++) entries[i]!.guide = true
            }
            if (canvas && !unbounded) measuredBy(before, 'leaf', gx, gy)
            clipFrom(before)
          }
        })
        if (box.foreground) { entries.push(box.foreground); clipFrom(entries.length - 1) }
        if (held?.foreground) { entries.push(held.foreground); clipFrom(entries.length - 1) }
      })))
    }
  }
  const walkMark = (group: SceneGroup, type: string, tx: number, ty: number, gx: number, gy: number, fw: number, fh: number): void => {
    const e0 = entries.length
    const guidePart = group.role === 'title-text' || group.role === 'title-subtitle'
    // a mark's `clip`: its items are clipped to the frame of the group they are in (or to its rounded outline)
    const clip = group.clip === true ? (group.clipPathD ? pathClip(group.clipPathD, tx, ty) : frameClip(tx, ty, fw, fh)) : null
    withClip(clip, () => {
      // (a mark of a scene the engine returned holds what it held: at the same place, its entries are the ones made before, see
      // `MARK_ENTRIES`; each index takes copies, which the clips and flags below are written onto)
      const kept = type !== 'text' && isEngineNode(group) ? keptEntries.get(group) : undefined
      if (kept !== undefined && keptInto(kept.root, scene) && Object.is(kept.gx, gx) && Object.is(kept.gy, gy) && kept.unbounded === unbounded) {
        for (const t of kept.entries) entries.push({ ...t })
      } else {
        addMark(group, type, gx, gy)
        if (canvas && !unbounded) measuredBy(e0, type, gx, gy, type === 'line' || type === 'area' || type === 'trail' ? group : undefined, group, fw, fh)
        if (type !== 'text' && isEngineNode(group)) keptEntries.set(group, { gx, gy, unbounded, entries: entries.slice(e0).map((e) => ({ ...e })), root: scene })
      }
      clipFrom(e0)
    })
    // (an item of a mark that reads a dataset has a row for its datum; a title's text is a guide's part)
    if (group.__source !== undefined && !guidePart && entries.length > e0) dataRuns.push(e0, entries.length)
    // a mark that is not interactive takes no pointer (its container says `pointer-events: none`)
    if (isInert(group)) for (let i = e0; i < entries.length; i++) entries[i]!.inert = true
    if (guidePart) for (let i = e0; i < entries.length; i++) entries[i]!.guide = true
  }
  /** (canvas index) The entries made since `from` are measured as vega's bounds pass measures `kind`, in the frame at (ox, oy). */
  const measuredBy = (from: number, kind: string, ox: number, oy: number, mark?: SceneGroup, typed?: SceneGroup, fw?: number, fh?: number): void => {
    for (let i = from; i < entries.length; i++) {
      const e = entries[i]!
      // (a group item's box -- a guide's, a legend entry's, its stroke in front too -- lies within the group item's bounds, which
      // vega's pick tests and the clips around the entry already hold: it is not measured as a leaf)
      if (e.groupBox || isGroup(e.item) || e.item._part === 'entry') continue
      e.bk = kind
      e.ox = ox
      e.oy = oy
      if (mark) e.bmark = mark
      else if (typed) { e.tmark = typed; e.tfw = fw!; e.tfh = fh! }
    }
  }
  const addMark = (group: SceneGroup, type: string, gx: number, gy: number): void => {
    // (the items a pass that stopped in their mark's bounds never measured have no bounds, where vega looks for an item first: they
    // take no pointer, see `SceneGroup.unmeasuredFrom`)
    const from = group.unmeasuredFrom
    if (from !== undefined) group = { ...group, items: (group.items ?? []).slice(0, from) } as SceneGroup
    if (type === 'line' || type === 'area' || type === 'trail') { if (group.items?.length) addMulti(group, type, gx, gy); return }
    for (const item of group.items ?? []) addMarkItem(item, type, gx, gy)
  }
  // Scene items live in plot coordinates; pointer queries arrive in viewport
  // coordinates, so include the root padding translation (as the renderer does
  // with its top-level translate group).
  const padX = (scene.padding?.left ?? 0) + (scene.frameX ?? 0)
  const padY = (scene.padding?.top ?? 0) + (scene.frameY ?? 0)
  const plotW = scene.plotWidth ?? scene.width
  const plotH = scene.plotHeight ?? scene.height
  // nothing is picked outside the plot when the view clips to it (nor outside the view's surface: see `find`)
  const keptGuides = canvas ? GUIDE_ENTRIES.canvas : GUIDE_ENTRIES.svg
  const frame = `${padX},${padY},${plotW},${plotH},${scene.frameClip ? 1 : 0}`
  const measurer = getTextMetricsProvider()
  withClip(scene.frameClip ? rectClip(padX, padY, plotW, plotH) : null, () => {
    const rootClips = canvas ? groupMarkClips(scene.items, plotW, plotH, padX, padY) : undefined
    for (let k = 0; k < scene.items.length; k++) {
      const node = scene.items[k]!
      if (!TOP_GUIDE_ROLES.has(node.role as string) || rec(node)._scope === true || !isEngineNode(node)) { withClip(rootClips?.[k] ?? null, () => walk(node, padX, padY, plotW, plotH)); continue }
      const kept = keptGuides.get(node)
      if (kept !== undefined && keptInto(kept.root, scene) && kept.frame === frame && kept.measurer === measurer) {
        const base = entries.length
        for (const e of kept.entries) entries.push({ ...e })
        for (const r of kept.runs) dataRuns.push(base + r)
        continue
      }
      const e0 = entries.length
      const r0 = dataRuns.length
      derivedCounts.guideEntries++
      walk(node, padX, padY, plotW, plotH)
      keptGuides.set(node, { frame, measurer, entries: entries.slice(e0).map((e) => ({ ...e })), runs: dataRuns.slice(r0).map((r) => r - e0), root: scene })
    }
  })
  // the view's surface: vega's SVG clips what overflows it, its canvas ends there (a scene that gives no size is not bounded)
  const surface = scene.width >= 0 && scene.height >= 0 ? { w: scene.width, h: scene.height } : null

  /** The entries of a group item's background and foreground rectangles, at (gx, gy). */
  function groupBoxFaces(group: SceneGroup, gx: number, gy: number): { background: Entry | null; foreground: Entry | null } {
    const items = (group.items ?? []) as SceneItem[]
    const isBox = (it: SceneItem | undefined): it is SceneItem => it !== undefined && rec(it)._bg === true && typeof it.path === 'string'
    const face = (paint: SceneItem, path: string): Entry | null => {
      const e = geomEntry(group, 'group', () => transformPolys(pathPolys(path), (x, y) => [gx + x, gy + y]), paint)
      if (e) e.groupBox = true
      return e
    }
    if (isBox(items[0])) {
      const fg = items.length > 1 ? items[items.length - 1] : undefined
      return { background: face(items[0], boxPathOf(items[0])), foreground: isBox(fg) ? face(fg, boxPathOf(fg)) : null }
    }
    // a scene without the boxes the runtime draws: the group's own rectangle
    const w = Number(group.width ?? 0)
    const h = Number(group.height ?? 0)
    return { background: w > 0 && h > 0 ? face(group as SceneItem, `M0,0h${w}v${h}h${-w}Z`) : null, foreground: null }
  }

  /**
   * The entries of the box of an axis's or a title's group item (`SceneGroup.box`, `boxFg`, in the group's frame at (gx, gy)), when
   * the spec made that group item `interactive`: the guide's part only `pick` finds, as a legend's own box is.
   */
  function guideBoxFaces(group: SceneGroup, gx: number, gy: number, outer: SceneGroup | undefined): { background: Entry | null; foreground: Entry | null } | null {
    if (group.box === undefined) return null
    const interactive = group.role === 'axis' ? (outer?.partMeta ?? group.partMeta)?.axis?.interactive === true : group.role === 'title' && group.interactive === true
    if (!interactive) return null
    const face = (paint: SceneItem | undefined): Entry | null => {
      if (paint === undefined || typeof paint.path !== 'string') return null
      const ox = gx + (paint.x || 0)
      const oy = gy + (paint.y || 0)
      const e = geomEntry(group, 'group', () => transformPolys(pathPolys(boxPathOf(paint)), (x, y) => [ox + x, oy + y]), paint)
      if (e) { e.pickOnly = true; e.guide = true }
      return e
    }
    return { background: face(group.box), foreground: face(group.boxFg) }
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
    const key = part === 'entry' || part === 'entryFg' ? 'entries' : part === 'bg' || part === 'fg' ? guide.role! : part
    return meta?.[key]?.interactive === true
  }

  /**
   * An interactive guide part drawn as a path or a rule (a legend's entry box, symbol, gradient or band; an axis' tick, grid
   * line or domain): found by `pick` only. The entry box is the entry's group item, the guide's own `bg` is the guide's group item;
   * a front stroke (`fg`, `entryFg`: `strokeForeground`) is the stroke of the guide's or of the entry's (`entry`) group item.
   */
  function addGuidePart(item: SceneItem, tx: number, ty: number, guide: SceneGroup, entry?: SceneItem): void {
    const before = entries.length
    const part = item._part
    if (item._kind === 'rule' || (item.path == null && item.x2 != null)) {
      addMarkItem(item, 'rule', tx, ty)
    } else if (typeof item.path === 'string') {
      const path = boxPathOf(item)
      const own = part === 'bg' || part === 'fg' ? guide : part === 'entryFg' ? entry ?? item : item
      const marktype = part === 'entry' || own !== item ? 'group' : part === 'gradient' || part === 'band' ? 'rect' : item._kind ?? 'symbol'
      const angle = (rec(item).angle as number | undefined) ?? 0
      const e = angle
        // a turned symbol: its outline in its own frame
        ? geomEntry(item, marktype, () => pathPolys(path), item, { cx: tx + (item.x || 0), cy: ty + (item.y || 0), rot: angle * (Math.PI / 180) })
        : geomEntry(own, marktype, () => transformPolys(pathPolys(path), (x, y) => [tx + (item.x || 0) + x, ty + (item.y || 0) + y]), item)
      if (e) entries.push(e)
    }
    // a clipped legend symbol (clipHeight): the clip is in the frame of the legend's leaves; an entry box that is not part of its
    // group item's bounds: vega's pick looks for the group item only within them
    const c = rec(item)._clip as { x?: number; y?: number; w: number; h: number; d?: string } | undefined
    const b = rec(part === 'entryFg' && entry !== undefined ? entry : item)._pickBounds as { x1: number; y1: number; x2: number; y2: number } | undefined
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
  function geomEntry(item: SceneItem, marktype: string, build: () => Poly[], paint: SceneItem | Record<string, unknown>, at?: { cx: number; cy: number; rot: number }, painted: Stroke | null = strokeOf(paint), known?: [number, number, number, number] | null): Entry | null {
    const stroke = pickStroke(painted, marktype)
    const fill = isFilled(paint)
    if (!fill && !stroke) return null
    // (an outline whose box is known without it is made when a query first needs it: see `hit`)
    const polys = known === undefined ? build() : undefined
    const box = known === undefined ? polysBox(polys!) : known
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
    const e: Entry = { item, marktype, kind: 'geom', build, fill, stroke, x1, y1, x2, y2 }
    if (polys !== undefined) e.polys = polys
    if (at) { e.cx = at.cx; e.cy = at.cy; e.rot = at.rot }
    return e
  }

  /**
   * The stroke a pick tests. vega's canvas pick sets only the width and the cap on its context (util/canvas/pick.js `hitPath`): the
   * join and the miter limit are the context's own, a miter limited at 10, whatever the item says. A rule is the exception: its
   * pick strokes it as it is drawn (marks/rule.js `hit`).
   */
  function pickStroke(st: Stroke | null, marktype: string): Stroke | null {
    if (!canvas || st === null) return st
    // (vega's canvas pick draws no dashes -- its `hitPath` sets the width and the cap -- but a rule's: marks/rule.js `path`)
    if (marktype === 'rule') return st
    const { dash: _dash, dashOffset: _offset, ...plain } = st
    return { ...plain, join: 'miter', limit: 10 }
  }

  /** A line, an area or a trail: one painted path, styled by the mark's first item. */
  function addMulti(group: SceneGroup, type: Multi, tx: number, ty: number): void {
    const items = (group.items ?? []) as SceneItem[]
    if (!items.length) return
    let build: () => Poly[]
    let paint: Record<string, unknown>
    let stroke: Stroke | null
    const first = items[0]!
    if (type === 'line' || type === 'area') {
      // (the mark's cached geometry: its full-precision outline, flattened once and placed at (tx, ty))
      const geometry = type === 'line' ? lineGeometry(items) : areaGeometry(items)
      if (geometry === null || geometry.empty) return
      build = () => curvePolys(geometry, tx, ty, canvas)
      // (vega draws a line 2 wide unless its first item says otherwise: see lineStrokeWidth)
      paint = type === 'line' ? { fill: first.fill } : first as Record<string, unknown>
      stroke = type === 'line' ? strokeOf(first, lineStrokeWidth(first) ?? 1) : strokeOf(first)
    } else {
      if (items.length <= 1) return
      const geometry = trailGeometry(items)!
      if (!geometry.outline.drawn) return
      // (its text is written here, as it always was: a negative width throws now, not when the index is queried)
      arcExactSegs(geometry)
      build = () => arcPolys(geometry, tx, ty, canvas)
      // (vega paints a trail's outline with its first item's fill and stroke, like any path)
      paint = first as Record<string, unknown>
      stroke = strokeOf(first)
    }
    const e = geomEntry(first, type, build, paint, undefined, stroke)
    if (e) {
      // (the items as they are now: the engine may grow a published items array in place for a later scene, scene-registry.ts)
      e.multi = { type, items: items.slice(), tx, ty }
      entries.push(e)
    }
  }

  /** A symbol: a disc when it is a circle, else its shape's outline in its own frame, turned by its angle. */
  function addSymbol(item: SceneItem, marktype: string, tx: number, ty: number, radius?: number): void {
    // (vega draws a symbol at `translate(x || 0, y || 0)`: a missing or NaN position is the origin, one that is not two finite
    // numbers leaves the symbol at the origin too -- see `drawnOffset`)
    const [ix, iy] = drawnOffset(item)
    const fill = !!item.fill
    const stroke = item.stroke ? pickStroke(strokeOf(item), marktype) : null
    if (!fill && !stroke) return
    const size = (item.size as number) ?? SYMBOL_DEFAULT_SIZE
    const r = radius != null ? radius : Math.sqrt(size) / 2
    // (a symbol of no size covers nothing a fill test finds: neither vega's canvas pick nor a browser's hit test of a degenerate path)
    if (!(r > 0) && (!stroke || stroke.cap === 'butt')) return
    const cx = tx + ix
    const cy = ty + iy
    const shape = marktype === 'symbol' ? (rec(item).shape as string | undefined) : undefined
    if ((shape == null || shape === 'circle') && stroke?.dash === undefined) {
      // (the circle is one arc closed on itself: no caps, no joins; a filled one with no stroke, the common symbol, is a disc)
      if (!stroke) { entries.push({ item, marktype, kind: 'disc', cx, cy, r, x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r }); return }
      const out = r + stroke.hw
      entries.push({ item, marktype, kind: 'circle', cx, cy, r, fill, stroke, x1: cx - out, y1: cy - out, x2: cx + out, y2: cy + out })
      return
    }
    const outline = shapeOutline(shape ?? 'circle', r)
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
        // vega draws a rect at `+(x || 0)`, `+(y || 0)` by `+(width || 0)`, `+(height || 0)` (rectData): a numeric string is its
        // number; a size or a corner that is not a finite number draws nothing (the canvas drops the rect, the SVG path is in error)
        const x0 = tx + +((item.x || 0) as number)
        const y0 = ty + +((item.y || 0) as number)
        const w = +((item.width || 0) as number)
        const h = +((item.height || 0) as number)
        if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(w) || !Number.isFinite(h)) return
        const rounded = rec(item).cornerRadius !== undefined || rec(item).cornerRadiusTopLeft !== undefined
          || rec(item).cornerRadiusTopRight !== undefined || rec(item).cornerRadiusBottomLeft !== undefined || rec(item).cornerRadiusBottomRight !== undefined
        if (rounded) {
          // a rounded rect: its own outline, so the corners outside it are not hits
          const e = geomEntry(item, marktype, () => flattenSegs(segsOf(rectData(item)), (x, y) => [tx + x, ty + y]), item, undefined, stroke)
          if (e) entries.push(e)
          return
        }
        if (!stroke) {
          // the common case: a filled rectangle is its box (one of no area covers nothing: a fill test finds no point in it)
          if (w === 0 || h === 0) return
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
        // (its canvas pick strokes the rule as it draws it, and a rule of no stroke opacity is not drawn: marks/rule.js `path`)
        if (canvas && !(+((item.strokeOpacity ?? 1) as number) > 0)) return
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
        const geometry = itemArcGeometry(item)
        // (its text is written here, as it always was: a negative radius throws now, not when the index is queried -- but not on a canvas
        // that is given a number it cannot hold, which it ignores before it looks at the radius)
        if (!canvas || canvasHolds(geometry)) arcExactSegs(geometry)
        // (vega draws an arc at `translate(x || 0, y || 0) rotate(angle)`, as it draws a symbol or a path)
        const [ix, iy] = drawnOffset(item)
        const ox = tx + ix
        const oy = ty + iy
        const angle = +((rec(item).angle as number | undefined) || 0)
        const e = angle
          ? geomEntry(item, marktype, () => arcPolys(geometry, 0, 0, canvas), item, { cx: ox, cy: oy, rot: angle * (Math.PI / 180) })
          : geomEntry(item, marktype, () => arcPolys(geometry, ox, oy, canvas), item)
        if (e) entries.push(e)
        return
      }
      case 'path': {
        if (!item.path) return
        const sx = (rec(item).scaleX as number | undefined) || 1
        const sy = (rec(item).scaleY as number | undefined) || 1
        const path = String(item.path)
        const angle = +((rec(item).angle as number | undefined) ?? 0)
        const rx = item.x || 0
        const ry = item.y || 0
        // (its position as a number: a numeric string is its number in a transform; and the canvas, which draws an unturned path at
        // `x + l` in JavaScript's arithmetic, joins a string to the number before it)
        const px = +rx, py = +ry
        let e: Entry | null
        if (!canvas) {
          // (vega's SVG writes the text as it is and scales it with the element's transform, as a shape: an arc is scaled as the browser
          // scales it, which is not what the canvas's replay does with it)
          const localSvg = localPathBox(path)
          e = angle
            ? geomEntry(item, marktype, () => transformPolys(pathPolys(path), (x, y) => [sx * x, sy * y]), item, { cx: tx + px, cy: ty + py, rot: angle * (Math.PI / 180) }, strokeOf(item), localSvg && placedBox(localSvg, 0, 0, sx, sy))
            : geomEntry(item, marktype, () => transformPolys(pathPolys(path), (x, y) => [tx + px + sx * x, ty + py + sy * y]), item, undefined, strokeOf(item), localSvg && placedBox(localSvg, tx + px, ty + py, sx, sy))
          if (e) entries.push(e)
          return
        }
        // a path mark's text as vega's canvas draws it, the scale in the replay's numbers (`pathMarkPolys`), then moved (and turned)
        const local = localPathMarkBox(path, sx, sy)
        if (angle) {
          e = geomEntry(item, marktype, () => pathMarkPolys(path, sx, sy), item, { cx: tx + px, cy: ty + py, rot: angle * (Math.PI / 180) }, strokeOf(item), local && placedBox(local, 0, 0, 1, 1))
        } else if (typeof rx !== 'number' || typeof ry !== 'number') {
          e = geomEntry(item, marktype, () => transformPolys(pathMarkPolysAt(path, sx, sy, rx, ry), (x, y) => [tx + x, ty + y]), item, undefined, strokeOf(item))
        } else {
          e = geomEntry(item, marktype, () => transformPolys(pathMarkPolys(path, sx, sy), (x, y) => [tx + px + x, ty + py + y]), item, undefined, strokeOf(item), local && placedBox(local, tx + px, ty + py, 1, 1))
        }
        if (e) entries.push(e)
        return
      }
      case 'shape':
      case 'geoshape': {
        if (!item.path) return
        const sx = (rec(item).scaleX as number | undefined) || 1
        const sy = (rec(item).scaleY as number | undefined) || 1
        const path = String(item.path)
        const angle = (rec(item).angle as number | undefined) ?? 0
        // (the outline is placed when a query first reaches its box: the box is the placed box of the path's own, see `placedBox`)
        const local = localPathBox(path)
        const e = angle
          // vega draws a shape item at translate(x, y) rotate(angle) scale(scaleX, scaleY)
          ? geomEntry(item, marktype, () => transformPolys(pathPolys(path), (x, y) => [sx * x, sy * y]), item, { cx: tx + (item.x || 0), cy: ty + (item.y || 0), rot: angle * (Math.PI / 180) }, strokeOf(item), local && placedBox(local, 0, 0, sx, sy))
          : geomEntry(item, marktype, () => transformPolys(pathPolys(path), (x, y) => [tx + (item.x || 0) + sx * x, ty + (item.y || 0) + sy * y]), item, undefined, strokeOf(item), local && placedBox(local, tx + (item.x || 0), ty + (item.y || 0), sx, sy))
        if (e) entries.push(e)
        return
      }
      case 'image': {
        // (vega draws an image at `(x || 0) - offset`, `(y || 0) - offset` by its width and height: numbers that are not finite draw
        // nothing; a box of no area covers nothing)
        // (vega's canvas picks an image by its bounds alone: `pick()` with no test after the bounds. The entry is the whole plane, and
        // the bounds the index measures for it -- "not outside" -- decide, whatever numbers the box is made of)
        if (canvas) {
          entries.push({ item, marktype, kind: 'box', fill: true, stroke: null, x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity })
          return
        }
        const b = imageBox(item)
        const x = +b.x, y = +b.y, w = +b.w, h = +b.h
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0) return
        entries.push({ item, marktype, kind: 'box', fill: true, stroke: null, x1: tx + Math.min(x, x + w), y1: ty + Math.min(y, y + h), x2: tx + Math.max(x, x + w), y2: ty + Math.max(y, y + h) })
        return
      }
      default:
        // a mark type no renderer draws has nothing to hit
        return
    }
  }

  // Linear scan for small scenes; uniform grid above the threshold, made once the index has answered `LINEAR_QUERIES` queries by a
  // scan (a scene that changes on every pointer move is asked a couple of questions: a scan of the flat boxes is cheaper than the
  // grid; one that stays is asked many). The grid and the scan find the same entry: every entry whose box holds the point is listed
  // in the point's cell or in `big`, and both take the last such entry, in paint order, that `hits` the point.
  const GRID_THRESHOLD = 400
  const LINEAR_QUERIES = 8
  let queries = 0
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
    // (the flat arrays the scan reads are filled in the same pass; when the first queries scanned them, they are made already, and
    // so are the targets handed out, which stay the ones handed out)
    if (boxes === null) seal(false)
    const mx = gw - 1, my = gh - 1
    const bx = boxes!
    const fl = flags!
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const x1 = e.x1, y1 = e.y1, x2 = e.x2, y2 = e.y2
      bx[4 * i] = x1
      bx[4 * i + 1] = y1
      bx[4 * i + 2] = x2
      bx[4 * i + 3] = y2
      fl[i] = flagsOf(e)
      if (!(x1 <= x2 && y1 <= y2)) continue // NaN bounds can never be hit
      // Clamp to the grid (queries clamp the same way), so an item far outside
      // the view or an enormous one covers at most the whole grid, never more.
      let c0x = Math.floor(x1 / cs), c1x = Math.floor(x2 / cs), c0y = Math.floor(y1 / cs), c1y = Math.floor(y2 / cs)
      c0x = c0x > mx ? mx : c0x < 0 ? 0 : c0x
      c1x = c1x > mx ? mx : c1x < 0 ? 0 : c1x
      c0y = c0y > my ? my : c0y < 0 ? 0 : c0y
      c1y = c1y > my ? my : c1y < 0 ? 0 : c1y
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

  // What a query looks at: `ALL` the painted items the guides and marks have, `DATA` the items of interactive marks, `PICK` what
  // takes the pointer. The scan reads each candidate's box and what it is from flat arrays (`seal`), and touches the entry only
  // when the box holds the point.
  type Mode = 0 | 1 | 2
  const ALL = 0, DATA = 1, PICK = 2
  const INERT = 1, PICK_ONLY = 2, GROUP_BOX = 4, GUIDE = 8
  /** The entries a query of each mode passes over. */
  const SKIP = [PICK_ONLY, PICK_ONLY | INERT | GROUP_BOX | GUIDE, INERT]
  let boxes: Float64Array | null = null
  let flags: Uint8Array | null = null
  /** The target reported for each entry's own item, made the first time it is hit (a hover asks for the same item over and over). */
  let targets: Array<HitTarget | undefined> = []
  /** Make the flat arrays the scan reads, and fill them (`full`), or leave that to the grid's pass. */
  const seal = (full = true): void => {
    const n = entries.length
    boxes = new Float64Array(4 * n)
    flags = new Uint8Array(n)
    targets = []
    if (full) for (let i = 0; i < n; i++) flatten(i)
  }
  /** Entry `i`'s box and what it is, into the flat arrays. */
  const flatten = (i: number): void => {
    const e = entries[i]!
    const b = boxes!
    b[4 * i] = e.x1
    b[4 * i + 1] = e.y1
    b[4 * i + 2] = e.x2
    b[4 * i + 3] = e.y2
    flags![i] = flagsOf(e)
  }
  const flagsOf = (e: Entry): number => (e.inert ? INERT : 0) | (e.pickOnly ? PICK_ONLY : 0) | (e.groupBox ? GROUP_BOX : 0) | (e.guide ? GUIDE : 0)

  /** Whether entry `i` is under (x, y): its box (NaN never is), then its geometry, then the clips around it (and on the canvas its bounds). */
  const hits = (i: number, x: number, y: number): boolean => {
    const b = boxes!
    const o = 4 * i
    if (!(x >= b[o]! && x <= b[o + 2]! && y >= b[o + 1]! && y <= b[o + 3]!)) return false
    const e = entries[i]!
    return onGeometry(e, x, y) && (e.clips === undefined || inClips(e.clips, x, y)) && (e.bk === undefined || inMeasured(e, x, y))
  }

  /**
   * (canvas index) Whether (x, y) is inside the bounds vega measured for the entry (its item's, or its line's, area's or trail's), as
   * vega's pick asks it: `contains` in the entry's frame, "not outside" -- so an edge that is not a number (a NaN, a string that does
   * not read as one) excludes nothing, as it excludes nothing there, and an empty box holds no point.
   */
  function inMeasured(e: Entry, x: number, y: number): boolean {
    let vb = e.vb
    if (vb === undefined) {
      const m = e.bmark !== undefined ? multiMarkBounds(e.bmark) : measureItem(e.item, e.bk!)
      // (the numbers vega's comparisons read: a string edge as `Number` reads it, null as 0)
      vb = e.vb = Float64Array.of(+m.x1, +m.y1, +m.x2, +m.y2)
    }
    const lx = x - e.ox!
    const ly = y - e.oy!
    if (lx < vb[0]! || lx > vb[2]! || ly < vb[1]! || ly > vb[3]!) return false
    // (the mark's bounds are asked before the item's, and leave an edge that is not a number out of their union: an item with one
    // holds a point its mark's bounds do not)
    if (e.tmark !== undefined && !(Number.isFinite(vb[0]!) && Number.isFinite(vb[1]!) && Number.isFinite(vb[2]!) && Number.isFinite(vb[3]!))) {
      const m = typedMarkBox(e.tmark, e.tfw!, e.tfh!)
      if (lx < m[0]! || lx > m[2]! || ly < m[1]! || ly > m[3]!) return false
    }
    return true
  }

  const hitLinear = (x: number, y: number, mode: Mode): number => {
    // Reverse scan: later entries paint on top (entries are kept in paint order).
    const skip = SKIP[mode]!
    const f = flags!
    for (let i = entries.length - 1; i >= 0; i--) {
      if ((f[i]! & skip) === 0 && hits(i, x, y)) return i
    }
    return -1
  }

  const hitGrid = (x: number, y: number, mode: Mode): number => {
    // Draw order matters for overlapping marks: the topmost painted item is
    // the one with the highest index. Merge the cell's list and the big list
    // (both ascending) from their ends.
    const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / cs)))
    const cy = Math.min(gh - 1, Math.max(0, Math.floor(y / cs)))
    const list = grid!.get(cy * gw + cx)
    const skip = SKIP[mode]!
    const f = flags!
    let a = list ? list.length - 1 : -1
    let b = big.length - 1
    while (a >= 0 || b >= 0) {
      let idx: number
      if (b < 0 || (a >= 0 && list![a]! > big[b]!)) idx = list![a--]!
      else idx = big[b--]!
      if ((f[idx]! & skip) === 0 && hits(idx, x, y)) return idx
    }
    return -1
  }

  function inClips(cl: Clip[], x: number, y: number): boolean {
    for (const c of cl) {
      if (!(x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2)) return false
      if (c.polys && !insidePolys(c.polys, x, y)) return false
    }
    return true
  }

  function onGeometry(e: Entry, x: number, y: number): boolean {
    switch (e.kind) {
      case 'box':
        return true
      case 'disc': {
        const dx = x - e.cx!, dy = y - e.cy!
        return dx * dx + dy * dy <= e.r! * e.r!
      }
      case 'circle': {
        const dx = x - e.cx!, dy = y - e.cy!
        const d2 = dx * dx + dy * dy
        if (e.fill === true && d2 <= e.r! * e.r!) return true
        return e.stroke != null && Math.abs(Math.sqrt(d2) - e.r!) <= e.stroke.hw
      }
      case 'text': {
        // into the text's own frame: about the anchor, undoing the rotation
        toLocal(e, x, y)
        const b = e.box!
        return localX >= b[0] && localX <= b[2] && localY >= b[1] && localY <= b[3]
      }
      case 'geom': {
        const polys = e.polys ?? (e.polys = e.build!())
        let px = x, py = y
        if (e.cx !== undefined) { toLocal(e, x, y); px = localX; py = localY }
        if (e.fill && inFill(polys, px, py)) return true
        return e.stroke != null && inStroke(polys, px, py, e.stroke, canvas)
      }
    }
  }

  /** The index of the topmost entry under (x, y) a query of `mode` reports, or -1. */
  const find = (x: number, y: number, mode: Mode): number => {
    if (entries.length === 0 || !(x === x && y === y)) return -1
    if (surface !== null && !(x >= 0 && x <= surface.w && y >= 0 && y <= surface.h)) return -1
    if (entries.length <= GRID_THRESHOLD || (grid == null && queries++ < LINEAR_QUERIES)) {
      if (boxes === null) seal()
      return hitLinear(x, y, mode)
    }
    if (grid == null) buildGrid()
    return hitGrid(x, y, mode)
  }
  /** Whether entry `i` was made for a mark that reads a dataset (a binary search of the runs). */
  const inDataRun = (i: number): boolean => {
    let lo = 0, hi = dataRuns.length / 2
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (dataRuns[2 * mid + 1]! <= i) lo = mid + 1
      else hi = mid
    }
    return lo < dataRuns.length / 2 && dataRuns[2 * lo]! <= i
  }
  const kindOf = (e: Entry): HitTarget['kind'] => (e.groupBox ? (e.guide ? 'guide' : 'group') : e.guide || e.pickOnly ? 'guide' : 'mark')
  const describe = (i: number, item: SceneItem): HitTarget => ({
    item,
    marktype: entries[i]!.marktype,
    kind: kindOf(entries[i]!),
    fromData: inDataRun(i),
  })
  /** The target of entry `i`'s own item (made once), or of another item of its line, area or trail. */
  const target = (i: number, item: SceneItem): HitTarget => {
    if (item !== entries[i]!.item) return describe(i, item)
    return targets[i] ??= Object.freeze(describe(i, item))
  }
  /** What `query` and `queryMark` report: a line, an area or a trail as its item nearest the point. */
  const nearest = (i: number, x: number, y: number): HitTarget | null => {
    if (i < 0) return null
    const m = entries[i]!.multi
    return target(i, m ? nearestOf(m.items, m.tx, m.ty, x, y) : entries[i]!.item)
  }

  return {
    query: (x, y) => nearest(find(x, y, ALL), x, y),
    queryMark: (x, y) => nearest(find(x, y, DATA), x, y),
    pick(x: number, y: number): HitTarget | null {
      const i = find(x, y, PICK)
      return i < 0 ? null : target(i, entries[i]!.item)
    },
    tooltip(x: number, y: number): HitTarget | null {
      const i = find(x, y, PICK)
      if (i < 0) return null
      const m = entries[i]!.multi
      if (!m) return target(i, entries[i]!.item)
      const it = tipOf(m.type, m.items, x - m.tx, y - m.ty)
      return it === null ? null : target(i, it)
    },
    size(): number {
      let n = 0
      for (const e of entries) if (!e.groupBox && !e.pickOnly) n++
      return n
    },
  }
}

/**
 * The bounds vega's bounds pass gives one item of a mark of type `kind` (`itemBounds`: the item's own box, as vega's pick reads it,
 * edges that are not numbers included); `leaf`: a guide's part, measured as its own kind.
 */
function measureItem(it: SceneItem, kind: string): Bounds {
  return kind === 'leaf' ? boundLeaf(new Bounds(), it) : itemBounds(new Bounds(), kind, it)
}

/** A symbol shape's outline at radius r (its full-precision path's polygons), shared by every symbol of that shape and size. */
function shapeOutline(shape: string, r: number): { polys: Poly[]; reach: number } {
  return symbolOutline(symbolGeometry(shape, r))
}
