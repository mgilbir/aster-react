/**
 * The order vega paints and picks a mark's items in (vega-scenegraph `util/visit.js`: `zorder`, `visit`, `pickVisit`).
 *
 * vega's scenegraph keeps a mark's items in the order its dataflow made them (data order, or its `sort`): that is the order an
 * expression reads them in (`data('<mark>')`, a mark drawn from another mark) and the order a grid lays a group mark's items out in.
 * Its renderers paint them in another order when an item has a `zindex`: the items whose `zindex` is falsy (none, 0, NaN) first, in
 * order, then the others by `zindex` ascending, ties in order (`a.zindex - b.zindex || a.index - b.index`, the values compared as
 * vega compares them: coerced to numbers). Its pick looks from the top of that order down.
 *
 * Aster's scene keeps vega's order, and every painter of a scene (the SVG string, the DOM patcher, the canvas) and the hit index
 * visit a mark's items through `paintOrder`, so none of them can paint or pick in another order. (The accessible tree keeps the
 * scene's order: it is a keyboard order, not a paint order.) A mark's own `zindex`
 * (and an axis', a legend's, a title's) orders the marks of a scope; the runtime puts the marks of a scope in that order as it
 * builds the scope (`paintOrderOf` in runtime.ts), since nothing reads a scope's marks in any other order.
 */
import type { SceneGroup, SceneItem } from './types.js'

interface Zindexed { zindex?: unknown }

/**
 * `items` in the order vega paints them: the array itself when no item has a truthy `zindex` (the common case: one pass, nothing
 * allocated), else a new array.
 */
export function paintOrder<T extends object>(items: readonly T[]): readonly T[] {
  const n = items.length
  let first = 0
  while (first < n && !(items[first] as Zindexed).zindex) first++
  if (first === n) return items
  const out: T[] = items.slice(0, first)
  const raised: Array<{ item: T; index: number }> = []
  for (let i = first; i < n; i++) {
    const item = items[i]!
    if ((item as Zindexed).zindex) raised.push({ item, index: i })
    else out.push(item)
  }
  // (vega's comparator, on its values as they are: `-` coerces them as vega's does)
  raised.sort((a, b) => ((a.item as Zindexed).zindex as number) - ((b.item as Zindexed).zindex as number) || a.index - b.index)
  for (const r of raised) out.push(r.item)
  return out
}

/** A node of a scope that is a group item (a group mark's items are consecutive nodes of the scope, sharing `markIndex`). */
const isGroupItemNode = (n: SceneItem | SceneGroup): boolean => {
  const g = n as SceneGroup
  return (g.marktype === 'group' || (g.marktype === undefined && Array.isArray(g.items))) && g.markIndex !== undefined
}

/**
 * The nodes of a scope (its marks, and the group items of its group marks, each group mark's items one run of consecutive nodes)
 * with the items of every group mark in paint order (`paintOrder`). The array itself when no group item has a truthy `zindex`.
 */
export function scopeInPaintOrder<T extends SceneItem | SceneGroup>(nodes: readonly T[]): readonly T[] {
  const n = nodes.length
  let i = 0
  while (i < n && !(isGroupItemNode(nodes[i]!) && (nodes[i] as Zindexed).zindex)) i++
  if (i === n) return nodes
  const out: T[] = []
  for (let k = 0; k < n;) {
    const node = nodes[k]!
    if (!isGroupItemNode(node)) { out.push(node); k++; continue }
    const id = (node as SceneGroup).markIndex
    let end = k + 1
    while (end < n && isGroupItemNode(nodes[end]!) && (nodes[end] as SceneGroup).markIndex === id) end++
    const run = nodes.slice(k, end)
    for (const item of paintOrder(run)) out.push(item)
    k = end
  }
  return out
}
