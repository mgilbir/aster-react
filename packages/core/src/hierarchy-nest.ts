/**
 * The `nest` transform: the rows of a dataset grouped by one or more key fields into a tree, which the hierarchy layouts
 * (`pack`, `partition`, `treemap`, `tree`, `treelinks`) then lay out. Loaded by the transforms addon.
 *
 * What it promises, and what the output depends on:
 *  - the rows themselves are the leaves of the tree and come out untouched, in their order. With `generate` the interior nodes
 *    follow them as rows of their own (`{key, values}`, the root `{values}`), breadth first from the root, so a layout that
 *    comes after writes its fields on them too;
 *  - a group is told by the string of its key (`'' + value`), and the groups of a level come in the order of an object keyed by
 *    those strings: whole numbers first, ascending, then the rest in order of first appearance;
 *  - a node's children are the array its data holds as `values`. That is how the interior nodes hold theirs, and it applies to
 *    a row too: a row with a non-empty array `values` field is a node with children (and, with `generate`, is added a second
 *    time as one). A `values` that is not an array is not read as children;
 *  - the tree is kept for the layouts of the same dataset (`TransformContext.hierarchies`), as `stratify` keeps its own. It has
 *    no key lookup, so `treePath` and `treeAncestors` find nothing in it.
 *
 * A row that holds itself among its `values` has no end: the tree refuses it.
 */
import { array, error } from './util.js'
import { fieldOf } from './transform-agg.js'
import { checkRowCount, meterTick } from './limits.js'
import type { HierNode, Row, TransformContext } from './transform.js'
import { walkPostOrder } from './tree-walk.js'

/** The rows grouped by `keys[depth]` and the keys after it: the leaves (rows) once the keys are used up. */
interface Group { key: string; values: Group[] | Row[] }

/**
 * The rows grouped by each key in turn. Iterative, as deep as there are keys (a spec can give thousands): a level's groups are
 * split by the next key depth first, the first group before the next, so the keys are read in the order a recursion would read them.
 */
function groupBy(rows: readonly Row[], keys: ReadonlyArray<(d: unknown) => unknown>): Group[] | Row[] {
  const top: { values: Group[] | Row[] } = { values: rows as Row[] }
  const work: Array<{ rows: readonly Row[]; depth: number; into: { values: Group[] | Row[] } }> = [{ rows, depth: 0, into: top }]
  let task
  while ((task = work.pop())) {
    meterTick('nest')
    const { depth, into } = task
    if (depth >= keys.length) {
      into.values = task.rows as Row[]
      continue
    }
    const read = keys[depth]!
    // (no inherited names: a group called `constructor` is a group; the order of the names is that of any object's own keys)
    const byKey: Record<string, Row[]> = Object.create(null)
    for (let i = 0; i < task.rows.length; i++) {
      const row = task.rows[i]!
      const name = '' + (read(row) as string)
      const group = byKey[name]
      if (group) group.push(row)
      else byKey[name] = [row]
      if ((i & 255) === 255) meterTick('nest', 256)
    }
    // bounded: one entry per group of this level, made by the metered row loop above
    const groups: Group[] = Object.keys(byKey).map((name) => ({ key: name, values: byKey[name]! }))
    into.values = groups
    for (let g = groups.length - 1; g >= 0; g--) work.push({ rows: groups[g]!.values as Row[], depth: depth + 1, into: groups[g]! })
  }
  return top.values
}

/** The children a node's data holds: the array it keeps as `values`, when it has any. */
function childrenOf(data: unknown): readonly unknown[] | null {
  const values = data !== null && typeof data === 'object' ? (data as { values?: unknown }).values : undefined
  return Array.isArray(values) && values.length > 0 ? values : null
}

/** The tree of nested data, as hierarchy nodes; `idx` is where a node's data is among `rows`. */
function buildTree(rootData: Row, rows: readonly Row[]): HierNode {
  const position = new Map<unknown, number>()
  for (let i = 0; i < rows.length; i++) if (!position.has(rows[i])) position.set(rows[i], i)
  const make = (data: Row, parent: HierNode | null): HierNode => ({
    data, idx: position.get(data) ?? -1, children: [], parent, depth: parent ? parent.depth + 1 : 0, height: 0, x: 0, y: 0, r: 0, value: 0,
  })
  const root = make(rootData, null)
  // (depth first, with the data of the nodes from the root down to the one being expanded: a child whose data is among them would
  // make the tree endless)
  const stack: HierNode[] = [root]
  const leaving: boolean[] = [false]
  const onPath = new Set<unknown>()
  let made = 1
  let node: HierNode | undefined
  while ((node = stack.pop())) {
    if (leaving.pop()) {
      onPath.delete(node.data)
      continue
    }
    const kids = childrenOf(node.data)
    if (!kids) continue
    onPath.add(node.data)
    stack.push(node)
    leaving.push(true)
    // bounded: the node's children; the loop around it ticks with their count
    for (const data of kids) {
      if (onPath.has(data)) error('[aster] nest: a row holds itself among its "values"')
      const child = make(data as Row, node)
      node.children.push(child)
      stack.push(child)
      leaving.push(false)
    }
    made += kids.length
    checkRowCount(made, 'nest')
    meterTick('nest', kids.length)
  }
  walkPostOrder(root, (n) => {
    let h = 0
    for (const c of n.children) if (c.height + 1 > h) h = c.height + 1
    n.height = h
  })
  return root
}

/** vega `nest`: the rows, with (`generate`) the interior nodes of the tree after them; the tree is left for the layouts. */
export function nestRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  const keys = array(t.keys).map(fieldOf)
  const rootData = { values: groupBy(rows, keys) } as unknown as Row
  const root = buildTree(rootData, rows)
  let out = rows
  if (t.generate) {
    // every node that has children, breadth first: each is a row of the dataset from here on
    const added: Row[] = []
    const queue: HierNode[] = [root]
    for (let i = 0; i < queue.length; i++) {
      meterTick('nest')
      const node = queue[i]!
      if (node.children.length) {
        if (node.idx === undefined || node.idx < 0) node.idx = rows.length + added.length
        added.push(node.data)
      }
      // bounded: the node's children; every node of the tree is queued once
      for (const c of node.children) queue.push(c)
    }
    out = rows.concat(added)
  }
  root.rowCount = out.length
  if (sourceName && ctx.hierarchies) ctx.hierarchies.set(sourceName, root)
  return out
}
