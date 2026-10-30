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
import { arcPath } from './render.js'
import { flattenPath, insidePolys } from './path-flatten.js'
import { MARK_NODE } from './util.js'
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
  const p = b.rotatedPoints(angle, ax, ay)
  return intersectBoxLine(box, p[0]!, p[1]!, p[2]!, p[3]!)
    || intersectBoxLine(box, p[0]!, p[1]!, p[4]!, p[5]!)
    || intersectBoxLine(box, p[4]!, p[5]!, p[6]!, p[7]!)
    || intersectBoxLine(box, p[2]!, p[3]!, p[6]!, p[7]!)
}

/** The outline of an arc, shape or path item, in the frame of its group. */
function outlineOf(marktype: string, item: SceneItem): ReturnType<typeof flattenPath> {
  const it = item as Rec
  const x = (it.x as number) || 0
  const y = (it.y as number) || 0
  const rot = ((it.angle as number) || 0) * DEG_TO_RAD
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const place = (px: number, py: number): [number, number] => [x + px * cos - py * sin, y + px * sin + py * cos]
  if (marktype === 'arc') {
    const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
    const d = arcPath(0, 0, r, (it.innerRadius as number) ?? 0, (it.startAngle as number) ?? 0, (it.endAngle as number) ?? 0, (it.cornerRadius as number) ?? 0, (it.padAngle as number) ?? 0)
    return flattenPath(d, place)
  }
  const sx = (it.scaleX as number) || 1
  const sy = (it.scaleY as number) || 1
  return flattenPath(String(it.path ?? ''), (px, py) => place(px * sx, py * sy))
}

function intersectPath(marktype: string, item: SceneItem, bounds: Bounds, box: Bounds): boolean {
  const polys = outlineOf(marktype, item)
  const b = new Bounds().union(bounds).intersect(box)
  const x1 = Math.floor(b.x1)
  const y1 = Math.floor(b.y1)
  const x2 = Math.ceil(b.x2)
  const y2 = Math.ceil(b.y2)
  for (let y = y1; y <= y2; ++y) for (let x = x1; x <= x2; ++x) if (insidePolys(polys, x, y)) return true
  return false
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
  const items = (mark.items ?? []) as SceneItem[]
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

/** The scene node `group` stands for: the mark a picked group item's facade says it belongs to, a group item of the scene itself, or the whole scene. */
function sceneOf(scene: SceneRoot | undefined, group: unknown): { mark: SceneGroup } | { group: SceneGroup } | null {
  if (group != null && typeof group === 'object') {
    const g = group as Rec
    const linked = (g.mark as Rec | undefined)?.[MARK_NODE as never] as Rec | undefined
    if (linked && Array.isArray(linked.items)) return { mark: linked as unknown as SceneGroup }
    if (Array.isArray(g.items)) return isLeafMark(g) ? { mark: g as unknown as SceneGroup } : { group: g as unknown as SceneGroup }
  }
  // vega's root: a group mark holding the root group item, whose marks are the view's
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
