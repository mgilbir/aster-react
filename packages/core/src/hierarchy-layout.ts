/**
 * The hierarchy layout transforms (`pack`, `partition`, `treemap`, `tree`): each lays out the tree a preceding `stratify`
 * built on its data source and writes the result on copies of the rows. Loaded by the transforms addon.
 */
import { error, hasOwnProperty } from './util.js'
import { compareOf, fieldOf } from './transform-agg.js'
import type { HierNode, Row, TransformContext } from './transform.js'
import { clusterTree, defaultSeparation, oneSeparation, tidyTree } from './hierarchy-tree.js'
import { packSiblings } from './circle-pack.js'
import { layoutRandom } from './layout-random.js'
import { GOLDEN_RATIO, TILINGS, tileColumns } from './treemap-tiling.js'
import { walkPostOrder, walkPreOrder } from './tree-walk.js'

// -- shared by every layout -----------------------------------------------------------------------------------------

/** The tree a preceding `stratify` built on this data source. */
function backingTree(layout: string, ctx: TransformContext, sourceName?: string): HierNode {
  const root = sourceName ? (ctx.hierarchies?.get(sourceName) as HierNode | undefined) : undefined
  if (!root) error(`[aster] ${layout} transform requires a backing tree data source.`)
  return root
}

/**
 * Give every node its `value` (the sum of its field below it, or the number of leaves when no field is given), then order
 * each node's children by `sort`. Ties keep the order of the rows.
 */
function prepareTree(root: HierNode, rows: Row[], p: Record<string, unknown>): void {
  if (p.field) {
    const read = fieldOf(p.field)
    // a node's own value (a number, else 0) plus its children's, the last child added first
    walkPostOrder(root, (node) => {
      let sum = +(read(node.data) as number) || 0
      for (let i = node.children.length; --i >= 0;) sum += node.children[i]!.value
      node.value = sum
    })
  } else {
    walkPostOrder(root, (node) => {
      let sum = 0
      const children = node.children
      if (!children.length) sum = 1
      else for (let i = children.length; --i >= 0;) sum += children[i]!.value
      node.value = sum
    })
  }
  const compare = compareOf(p.sort) as unknown as ((a: unknown, b: unknown) => number) | null
  if (!compare) return
  const position = new Map<Row, number>()
  rows.forEach((r, i) => position.set(r, i))
  // the comparator reads the hierarchy NODES (`value`, `depth`, `data.size`, ...), not the rows: a plain row field such as
  // `size` ties everywhere and leaves the stratify order
  const byRow = (a: HierNode, b: HierNode): number => compare(a, b) || (position.get(a.data) ?? 0) - (position.get(b.data) ?? 0)
  walkPreOrder(root, (node) => { if (node.children.length) node.children.sort(byRow) })
}

/**
 * Write the layout's fields on COPIES of the rows (`as` names them; the last field is the child count). Only the
 * transform's own output fields are written, and the input rows stay untouched.
 */
function writeLayout(rows: Row[], root: HierNode, fields: string[], as: string[]): Row[] {
  const out = new Array<Row | undefined>(rows.length)
  let byData: Map<Row, Row> | undefined
  const last = fields.length - 1
  walkPreOrder(root, (node) => {
    // the tree remembers the position of each row in the rows it was built from
    const i = node.idx
    let copy: Row | undefined
    if (i !== undefined && i >= 0 && rows[i] === node.data) {
      copy = out[i]
      if (!copy) out[i] = copy = { ...node.data }
    } else {
      byData ??= new Map()
      copy = byData.get(node.data)
      if (!copy) byData.set(node.data, (copy = { ...node.data }))
    }
    for (let k = 0; k < last; ++k) copy[as[k]!] = (node as unknown as Record<string, unknown>)[fields[k]!]
    copy[as[last]!] = node.children.length
  })
  if (!byData && out.every((t) => t !== undefined)) return out as Row[]
  return rows.map((r, i) => out[i] ?? byData?.get(r) ?? r)
}

const given = (p: Record<string, unknown>, name: string): boolean => name in p

/** A two-number `size` parameter. */
function sizeOf(p: Record<string, unknown>): [number, number] | null {
  if (!given(p, 'size')) return null
  const s = p.size as number[]
  return [+s[0]!, +s[1]!]
}

/** Run one layout: the common prelude and epilogue around `lay`. */
function layout(
  name: string,
  fields: string[],
  rows: Row[],
  t: Record<string, unknown>,
  ctx: TransformContext,
  sourceName: string | undefined,
  lay: (root: HierNode) => void,
): Row[] {
  const root = backingTree(name, ctx, sourceName)
  const as = (t.as as string[] | undefined) ?? fields
  prepareTree(root, rows, t)
  lay(root)
  return writeLayout(rows, root, fields, as)
}

// -- pack -----------------------------------------------------------------------------------------------------------

/** The `pack` transform: circle packing; a leaf's radius is `radius`, or the square root of its value. */
export function packRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  return layout('Pack', ['x', 'y', 'r', 'depth', 'children'], rows, t, ctx, sourceName, (root) => {
    const [dx, dy] = sizeOf(t) ?? [1, 1]
    const padding = given(t, 'padding') ? +(t.padding as number) : 0
    const radius = given(t, 'radius') && t.radius != null ? fieldOf(t.radius) : null
    const random = layoutRandom()
    root.x = dx / 2
    root.y = dy / 2
    const setLeafRadius = (read: (node: HierNode) => unknown) => walkPreOrder(root, (node) => {
      if (!node.children.length) node.r = Math.max(0, +(read(node) as number) || 0)
    })
    // every parent becomes the circle enclosing its (padded) children, children before parents
    const enclose = (margin: number, scale: number) => walkPostOrder(root, (node) => {
      const children = node.children
      if (!children.length) return
      const pad = margin * scale || 0
      if (pad) for (let i = 0; i < children.length; ++i) children[i]!.r += pad
      const r = packSiblings(children, random)
      if (pad) for (let i = 0; i < children.length; ++i) children[i]!.r -= pad
      node.r = r + pad
    })
    // positions so far are relative to the parent's centre and radii in packing units: scale them and move them
    // to absolute coordinates, parents before children
    const place = (scale: number) => walkPreOrder(root, (node) => {
      const parent = node.parent
      node.r *= scale
      if (parent) {
        node.x = parent.x + scale * node.x
        node.y = parent.y + scale * node.y
      }
    })
    if (radius) {
      setLeafRadius((node) => radius(node))
      enclose(padding, 0.5)
      place(1)
    } else {
      setLeafRadius((node) => Math.sqrt(node.value))
      enclose(0, 1)
      // the padding is given in output units: pack again with it expressed in the packing's
      enclose(padding, root.r / Math.min(dx, dy))
      place(Math.min(dx, dy) / (2 * root.r))
    }
  })
}

// -- partition and treemap ------------------------------------------------------------------------------------------

const roundBox = (node: HierNode): void => {
  node.x0 = Math.round(node.x0!)
  node.y0 = Math.round(node.y0!)
  node.x1 = Math.round(node.x1!)
  node.y1 = Math.round(node.y1!)
}

/** The `partition` transform: one level per band of the height, a node's children side by side beneath it. */
export function partitionRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  return layout('Partition', ['x0', 'y0', 'x1', 'y1', 'depth', 'children'], rows, t, ctx, sourceName, (root) => {
    const [dx, dy] = sizeOf(t) ?? [1, 1]
    const round = given(t, 'round') && !!t.round
    const padding = given(t, 'padding') ? +(t.padding as number) : 0
    const levels = root.height + 1
    root.x0 = root.y0 = padding
    root.x1 = dx
    root.y1 = dy / levels
    walkPreOrder(root, (node) => {
      if (node.children.length) tileColumns(node, node.x0!, dy * (node.depth + 1) / levels, node.x1!, dy * (node.depth + 2) / levels)
      // the box less the padding; on an axis where that comes out inverted, its middle
      let x0 = node.x0!
      let y0 = node.y0!
      let x1 = node.x1! - padding
      let y1 = node.y1! - padding
      if (x1 < x0) x0 = x1 = (x0 + x1) / 2
      if (y1 < y0) y0 = y1 = (y0 + y1) / 2
      node.x0 = x0
      node.y0 = y0
      node.x1 = x1
      node.y1 = y1
    })
    if (round) walkPreOrder(root, roundBox)
  })
}

/** The `treemap` transform: nested rectangles tiled by `method`, with padding between siblings and around children. */
export function treemapRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  return layout('Treemap', ['x0', 'y0', 'x1', 'y1', 'depth', 'children'], rows, t, ctx, sourceName, (root) => {
    // the parameters apply in this order, later ones overriding earlier ones (`padding` sets four sides and the gap)
    let method = 'squarify'
    let ratio = GOLDEN_RATIO
    if (given(t, 'method')) {
      const m = t.method as string
      if (!hasOwnProperty(TILINGS, m)) error('Unrecognized Treemap layout method: ' + m)
      method = m
    }
    if (given(t, 'ratio') && TILINGS[method]!.ratioParam) ratio = +(t.ratio as number) > 1 ? +(t.ratio as number) : 1
    const tile = TILINGS[method]!.tile(ratio)
    const [dx, dy] = sizeOf(t) ?? [1, 1]
    const round = given(t, 'round') && !!t.round
    let inner = 0
    let top = 0
    let right = 0
    let bottom = 0
    let left = 0
    if (given(t, 'padding')) { inner = +(t.padding as number); top = right = bottom = left = inner }
    if (given(t, 'paddingInner')) inner = +(t.paddingInner as number)
    if (given(t, 'paddingOuter')) top = right = bottom = left = +(t.paddingOuter as number)
    if (given(t, 'paddingTop')) top = +(t.paddingTop as number)
    if (given(t, 'paddingRight')) right = +(t.paddingRight as number)
    if (given(t, 'paddingBottom')) bottom = +(t.paddingBottom as number)
    if (given(t, 'paddingLeft')) left = +(t.paddingLeft as number)

    root.x0 = root.y0 = 0
    root.x1 = dx
    root.y1 = dy
    // the gap a node keeps from its own box, by depth: half the inner padding, set when its parent was laid out
    const gapAtDepth: number[] = [0]
    walkPreOrder(root, (node) => {
      // the box less the gap kept from its parent; on an axis where that comes out inverted, its middle
      const gap = gapAtDepth[node.depth]!
      let x0 = node.x0! + gap
      let y0 = node.y0! + gap
      let x1 = node.x1! - gap
      let y1 = node.y1! - gap
      if (x1 < x0) x0 = x1 = (x0 + x1) / 2
      if (y1 < y0) y0 = y1 = (y0 + y1) / 2
      node.x0 = x0
      node.y0 = y0
      node.x1 = x1
      node.y1 = y1
      if (!node.children.length) return
      const childGap = gapAtDepth[node.depth + 1] = inner / 2
      x0 += left - childGap
      y0 += top - childGap
      x1 -= right - childGap
      y1 -= bottom - childGap
      if (x1 < x0) x0 = x1 = (x0 + x1) / 2
      if (y1 < y0) y0 = y1 = (y0 + y1) / 2
      tile(node, x0, y0, x1, y1)
    })
    if (round) walkPreOrder(root, roundBox)
  })
}

// -- tree -----------------------------------------------------------------------------------------------------------

/** The `tree` transform: a tidy (Reingold-Tilford) or dendrogram (`cluster`) layout; `depth` is a node's level. */
export function treeRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  return layout('Tree', ['x', 'y', 'depth', 'children'], rows, t, ctx, sourceName, (root) => {
    const method = (t.method as string | undefined) || 'tidy'
    if (method !== 'tidy' && method !== 'cluster') error('Unrecognized Tree layout method: ' + method)
    // `size` and `nodeSize` each switch the layout to their mode; the one set last wins
    let size: [number, number] | null = [1, 1]
    let nodeSize: [number, number] | null = null
    if (given(t, 'size')) { size = sizeOf(t); nodeSize = null }
    if (given(t, 'nodeSize')) { const s = t.nodeSize as number[]; nodeSize = [+s[0]!, +s[1]!]; size = null }
    const options = { size, nodeSize, separation: t.separation !== false ? defaultSeparation : oneSeparation }
    if (method === 'tidy') tidyTree(root, options)
    else clusterTree(root, options)
  })
}
