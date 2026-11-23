/**
 * The expression function `intersect(box, {marktype, markname}, group)`: the scene items inside a box (vega-functions
 * intersect.js over vega-scenegraph's `intersect`). Vega-Lite's interval selections over geographic encodings (`latitude` /
 * `longitude`, which no scale inverts) select by what is drawn inside the brush.
 *
 * The walk is vega-scenegraph's: a mark is visited if its bounds meet the box and (a group mark, or interactive and passing the
 * filter); a group item recurses into its marks with the box moved into its own frame; an item is a hit if the box encloses its
 * bounds, or meets them and the mark's own test says so --
 *
 *   rect, group            the box meets the item's rectangle
 *   symbol                 the box holds the item's anchor (x, y)
 *   line, area, trail      the same -- against the bounds of the whole mark, which every item of these marks has in vega
 *   rule                   the segment meets the box
 *   text                   one of the edges of the (rotated) text box meets the box
 *   image                  bounds are enough
 *   arc, shape, path       some pixel of the box (rounded to whole pixels, within the item's bounds) is inside the item's path
 *                          -- what vega-scenegraph asks a canvas context, which a browser has and headless Node does not
 *                          (without one it settles for the bounds)
 */
import { Bounds, DEG_TO_RAD, boundGroupItem, boundText, boundTypedMark } from './bounds.js'
import { textAnchor } from './text-metrics.js'
import { itemArcGeometry } from './render.js'
import { insidePolys, type Poly } from './path-flatten.js'
import { arcLocalPolys, pathMarkPolys, pathPolys, transformPolys } from './geometry-read.js'
import { MARK_NODE, ROOT_MARK_NODE } from './util.js'
import { ceiling, HARD_CAPS, meterTick } from './limits.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

type Rec = Record<string, unknown>
const array = (x: unknown): unknown[] => (x == null ? [] : Array.isArray(x) ? x : [x])

const intersects = (a: Bounds, b: Bounds): boolean => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2)
const encloses = (a: Bounds, b: Bounds): boolean => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2
const contains = (a: Bounds, x: number, y: number): boolean => !(x < a.x1 || x > a.x2 || y < a.y1 || y > a.y2)

/** vega-scenegraph intersectBoxLine: Liang-Barsky clipping of a segment against the box. */
function intersectBoxLine(box: Bounds, x: number, y: number, u: number, v: number): boolean {
  const { x1, y1, x2, y2 } = box
  const dx = u - x
  const dy = v - y
  let t0 = 0
  let t1 = 1
  let p = 0
  let q = 0
  for (let e = 0; e < 4; ++e) {
    if (e === 0) { p = -dx; q = -(x1 - x) }
    if (e === 1) { p = dx; q = x2 - x }
    if (e === 2) { p = -dy; q = -(y1 - y) }
    if (e === 3) { p = dy; q = y2 - y }
    if (Math.abs(p) < 1e-10 && q < 0) return false
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      else if (r > t0) t0 = r
    } else if (p > 0) {
      if (r < t0) return false
      else if (r < t1) t1 = r
    }
  }
  return true
}

/** The bounds of one item in the frame of its mark's group (vega's `item.bounds`). */
function itemBounds(mark: SceneGroup, item: SceneItem): Bounds {
  if (mark.marktype === 'group') return boundGroupItem(new Bounds(), item as unknown as SceneGroup)
  return boundTypedMark(new Bounds(), { marktype: mark.marktype, items: [item] } as unknown as SceneGroup)
}

/** The mark's own bounds: the union of its items' (a line, area or trail has one for all of them, which each item shares). */
function markBounds(mark: SceneGroup, items: SceneItem[]): Bounds {
  if (items.length === 0) return new Bounds()
  if (mark.marktype === 'line' || mark.marktype === 'area' || mark.marktype === 'trail') return boundTypedMark(new Bounds(), mark)
  const b = new Bounds()
  for (const it of items) b.union(itemBounds(mark, it))
  return b
}

function intersectText(item: SceneItem, box: Bounds): boolean {
  // (vega's text `bound(tempBounds, item, 2)`: the corners of the text box, rotated about the anchor)
  const angle = (item.angle || 0) * DEG_TO_RAD
  const b = boundText(new Bounds(), { ...item, angle: 0 })
  const [ax, ay] = textAnchor(item)
  const p = b.rotatedCorners(angle, ax, ay)
  return intersectBoxLine(box, p[0]!, p[1]!, p[2]!, p[3]!)
    || intersectBoxLine(box, p[0]!, p[1]!, p[4]!, p[5]!)
    || intersectBoxLine(box, p[4]!, p[5]!, p[6]!, p[7]!)
    || intersectBoxLine(box, p[2]!, p[3]!, p[6]!, p[7]!)
}

/** The outline of an arc, shape or path item, in the frame of its group. */
function outlineOf(marktype: string, item: SceneItem): Poly[] {
  const it = item as Rec
  const x = (it.x as number) || 0
  const y = (it.y as number) || 0
  const rot = ((it.angle as number) || 0) * DEG_TO_RAD
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const place = (px: number, py: number): [number, number] => [x + px * cos - py * sin, y + px * sin + py * cos]
  if (marktype === 'arc') {
    return transformPolys(arcLocalPolys(itemArcGeometry(it as SceneItem)), place)
  }
  const sx = (it.scaleX as number) || 1
  const sy = (it.scaleY as number) || 1
  // (a path mark's text as vega draws it, the scale in its numbers; a shape's, the engine's own, scaled as it is drawn)
  if (marktype === 'path') return transformPolys(pathMarkPolys(String(it.path ?? ''), sx, sy), place)
  return transformPolys(pathPolys(String(it.path ?? '')), (px, py) => place(px * sx, py * sy))
}

const SAFE = 2 ** 52
const EPS = 2 ** -52

function intersectPath(marktype: string, item: SceneItem, bounds: Bounds, box: Bounds): boolean {
  const polys = outlineOf(marktype, item)
  const b = new Bounds().union(bounds).intersect(box)
  const x1 = Math.floor(b.x1)
  const y1 = Math.floor(b.y1)
  const x2 = Math.ceil(b.x2)
  const y2 = Math.ceil(b.y2)
  // (vega: is any lattice point of the region inside the outline? A region that is empty or NaN has none)
  if (!(x1 <= x2 && y1 <= y2)) return false
  return latticeInside(polys, x1, y1, x2, y2)
}

/**
 * Whether `insidePolys` holds at some integer (x, y) of [x1, x2] x [y1, y2] -- vega's answer, which it finds by testing every
 * lattice point of the region -- without testing every point. On a row the winding test changes only where an edge crosses the
 * row (each edge's side test is linear in x, so it flips once, within a few float steps of the true crossing: `window`), so the
 * inside points of a row are runs between crossings, and testing the integers around each crossing, one inside each gap and
 * the region's ends tests every run. Rows the outline does not reach have no crossing and nothing inside.
 *
 * The work is the rows the outline spans times its edges, and each candidate point tested against every edge, whatever the
 * region's area. A region past 2^52 (where `x + 1` no longer
 * moves: vega's walk never ends there) or work past the built-in `latticeTests` ceiling is refused with an `AsterLimitError`
 * (docs/LIMITS.md); under `limits`, the walk also counts against `maxTimeMs`.
 */
function latticeInside(polys: Poly[], x1: number, y1: number, x2: number, y2: number): boolean {
  let minY = Infinity, maxY = -Infinity
  let edges = 0
  for (const { pts } of polys) {
    const n = pts.length / 2
    if (n < 3) continue
    edges += n
    for (let i = 0; i < n; i++) {
      const y = pts[2 * i + 1]!
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const r0 = Math.max(y1, Math.ceil(minY))
  const r1 = Math.min(y2, Math.floor(maxY))
  if (!(r0 <= r1)) return false
  // (the work: each row's crossings, then each candidate point tested against every edge; counted as it is done, after a
  // check that the rows' crossings alone fit)
  let work = (r1 - r0 + 1) * edges
  if (!(Math.abs(x1) <= SAFE && Math.abs(x2) <= SAFE && Math.abs(r0) <= SAFE && Math.abs(r1) <= SAFE)) ceiling('latticeTests', Infinity, 'intersect() lattice tests (a region beyond 2^52)')
  ceiling('latticeTests', work, 'intersect() lattice tests')
  work = 0
  const xs: number[] = []
  const ws: number[] = []
  const order: number[] = []
  const test = (x: number, y: number): boolean => {
    if (!(x >= x1 && x <= x2)) return false
    if ((work += edges) > HARD_CAPS.latticeTests) ceiling('latticeTests', work, 'intersect() lattice tests')
    return insidePolys(polys, x, y)
  }
  for (let y = r0; y <= r1; y++) {
    meterTick('intersect() lattice rows')
    if ((work += edges) > HARD_CAPS.latticeTests) ceiling('latticeTests', work, 'intersect() lattice tests')
    xs.length = 0
    ws.length = 0
    for (const { pts } of polys) {
      const n = pts.length / 2
      if (n < 3) continue
      let ax = pts[2 * n - 2]!, ay = pts[2 * n - 1]!
      for (let i = 0; i < n; i++) {
        const bx = pts[2 * i]!, by = pts[2 * i + 1]!
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          // (an edge whose crossing is not a finite number never flips the test at a point of the region)
          const xc = ax + ((bx - ax) * (y - ay)) / (by - ay)
          if (Number.isFinite(xc)) { xs.push(xc); ws.push(crossingSlack(ax, bx)) }
        }
        ax = bx; ay = by
      }
    }
    if (xs.length === 0) continue
    order.length = 0
    for (let k = 0; k < xs.length; k++) order.push(k)
    order.sort((a, c) => xs[a]! - xs[c]!)
    for (let k = 0; k < order.length; k++) {
      const xc = xs[order[k]!]!
      const w = ws[order[k]!]!
      const f = Math.floor(xc)
      // (only the integers of the region: a slack wider than it -- an edge of enormous coordinates -- is the row itself)
      for (let x = Math.max(x1, f - w), end = Math.min(x2, f + w + 1); x <= end; x++) if (test(x, y)) return true
      if (k + 1 < order.length) {
        const m = Math.floor((xc + xs[order[k + 1]!]!) / 2)
        if (test(m, y) || test(Math.max(x1, Math.min(x2, m)), y)) return true
      }
    }
    if (test(x1, y) || test(x2, y)) return true
  }
  return false
}

/**
 * How many float steps an edge's crossing -- the estimate here and the point where `insidePolys`'s side test flips -- may lie
 * from the true one: both are a few roundings of terms no larger than the edge's coordinates.
 */
function crossingSlack(ax: number, bx: number): number {
  const w = 2 + Math.ceil(16 * EPS * (Math.abs(ax) + 2 * Math.abs(bx - ax)))
  return Number.isFinite(w) ? w : 2
}

function test(marktype: string, item: SceneItem, bounds: Bounds, box: Bounds): boolean {
  const it = item as Rec
  switch (marktype) {
    case 'group':
    case 'rect': {
      let x = (it.x as number) || 0
      let y = (it.y as number) || 0
      let w = it.width as number | undefined
      let h = it.height as number | undefined
      if (marktype === 'rect') {
        if (w == null && it.x2 != null) { w = Math.abs((it.x2 as number) - x); x = Math.min(x, it.x2 as number) }
        if (h == null && it.y2 != null) { h = Math.abs((it.y2 as number) - y); y = Math.min(y, it.y2 as number) }
      }
      return intersects(box, new Bounds().set(x, y, x + (w || 0), y + (h || 0)))
    }
    case 'symbol':
      return contains(box, (it.x as number) || 0, (it.y as number) || 0)
    case 'line': case 'area': case 'trail':
      return contains(box, (it.x as number) || 0, (it.y as number) || 0)
    case 'rule': {
      const x = (it.x as number) || 0
      const y = (it.y as number) || 0
      return intersectBoxLine(box, x, y, it.x2 != null ? (it.x2 as number) : x, it.y2 != null ? (it.y2 as number) : y)
    }
    case 'text':
      return intersectText(item, box)
    case 'image':
      return true
    case 'arc': case 'shape': case 'path': case 'geoshape':
      return intersectPath(marktype, item, bounds, box)
    default:
      // a mark type the engine has no test for: vega's `Marks[type].isect` would be undefined; the bounds are all there is
      return true
  }
}

type Filter = ((mark: { marktype?: string; name?: string }) => boolean) | null

/** A mark container (symbols, rects...). A scene's group items carry `marktype: 'group'` themselves: they are not wrapped in a group mark. */
const isLeafMark = (n: Rec): boolean => typeof n.marktype === 'string' && n.marktype !== 'group'

function intersectMark(mark: SceneGroup, box: Bounds, filter: Filter, hits: SceneItem[]): void {
  // (the items a pass that stopped in their mark's bounds never measured have no bounds to meet the box: see `SceneGroup.unmeasuredFrom`)
  const items = (mark.unmeasuredFrom === undefined ? mark.items ?? [] : (mark.items ?? []).slice(0, mark.unmeasuredFrom)) as SceneItem[]
  const type = mark.marktype
  if (items.length === 0) return
  const mb = markBounds(mark, items)
  // visited if the bounds meet the box and (a group mark: we must recurse, or interactive and passes the filter)
  if (!(intersects(box, mb) && (type === 'group' || (mark.interactive !== false && (!filter || filter(mark)))))) return
  if (type === 'group') {
    for (const g of items) intersectGroup(g as unknown as SceneGroup, mark, box, filter, hits)
    return
  }
  const nested = type === 'line' || type === 'area' || type === 'trail'
  for (const item of items) {
    const bounds = nested ? mb : itemBounds(mark, item)
    if (encloses(box, bounds) || (intersects(box, bounds) && test(type!, item, bounds, box))) hits.push(item)
  }
}

function intersectGroup(group: SceneGroup, mark: { marktype?: string; name?: string }, box: Bounds, filter: Filter, hits: SceneItem[]): void {
  // a group item is a hit only if the filter says so (never by default)
  if (filter && filter(mark)) {
    const bounds = boundGroupItem(new Bounds(), group)
    if (encloses(box, bounds) || (intersects(box, bounds) && test('group', group as unknown as SceneItem, bounds, box))) hits.push(group as unknown as SceneItem)
  }
  const marks = group.items
  if (!marks || marks.length === 0) return
  const x = (group.x as number) || 0
  const y = (group.y as number) || 0
  box.translate(-x, -y)
  for (const m of marks) {
    const node = m as unknown as SceneGroup
    if (isLeafMark(node as unknown as Rec)) intersectMark(node, box, filter, hits)
    else if (Array.isArray(node.items)) intersectGroup(node, { marktype: 'group', name: (node as Rec).name as string | undefined }, box, filter, hits)
  }
  box.translate(x, y)
}

/**
 * The scene node `group` stands for, as vega reads its third argument (`group || root`, then a mark node only):
 *  - nothing (any falsy value): the whole scene;
 *  - a mark node: the `mark` of a picked item's facade (what vega-lite passes as `unit.mark`; signals.ts links it to the scene
 *    node of the item's mark), or a mark container of the scene itself (it has a `marktype` and items);
 *  - anything else -- a picked item itself, a datum, a number, the `mark` of a guide part (whose mark has no node of its own
 *    in Aster's scene) -- is vega's error, 'Intersect scene must be mark node or group item.' (never the whole scene).
 */
function sceneOf(scene: SceneRoot | undefined, group: unknown): { mark: SceneGroup } | { group: SceneGroup } | null {
  if (group) {
    const g = (typeof group === 'object' ? group : {}) as Rec
    const linked = g[MARK_NODE as never] as Rec | undefined
    // (the root group item's mark: vega-lite's `unit.mark` of a single view is the root mark, the whole scene)
    if (linked !== undefined && linked === (ROOT_MARK_NODE as Rec)) return rootOf(scene)
    if (linked && Array.isArray(linked.items)) return { mark: linked as unknown as SceneGroup }
    // (an item's facade carries its `mark`: an item is no mark node, even a group item, which has a marktype and items)
    const isItem = g.mark !== null && typeof g.mark === 'object'
    if (!isItem && g.marktype && Array.isArray(g.items)) return { mark: g as unknown as SceneGroup }
    throw new Error('Intersect scene must be mark node or group item.')
  }
  return rootOf(scene)
}

/** vega's root: a group mark holding the root group item, whose marks are the view's. */
function rootOf(scene: SceneRoot | undefined): { group: SceneGroup } | null {
  if (!scene) return null
  const root: Rec = { items: scene.items, x: 0, y: 0, width: scene.plotWidth ?? scene.width, height: scene.plotHeight ?? scene.height, name: 'root' }
  return { group: root as unknown as SceneGroup }
}

export function sceneIntersect(scene: SceneRoot | undefined, b: unknown, opt: unknown, group: unknown): SceneItem[] {
  if (!b) return []
  const [u, v] = b as number[][]
  const box = new Bounds().set(u![0]!, u![1]!, v![0]!, v![1]!)
  let filter: Filter = null
  if (opt) {
    const types = array((opt as Rec).marktype)
    const names = array((opt as Rec).markname)
    filter = (m) => (!types.length || types.some((t) => m.marktype === t)) && (!names.length || names.some((s) => m.name === s))
  }
  const target = sceneOf(scene, group)
  const hits: SceneItem[] = []
  if (!target) return hits
  if ('mark' in target) intersectMark(target.mark, box, filter, hits)
  else intersectGroup(target.group, { marktype: 'group', name: (target.group as Rec).name as string | undefined }, box, filter, hits)
  return hits
}
