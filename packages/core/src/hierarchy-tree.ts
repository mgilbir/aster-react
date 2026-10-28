/**
 * d3-hierarchy `tree` (Reingold-Tilford "tidy" layout after Buchheim et al.) and `cluster` (dendrogram), ported
 * operation for operation (d3-hierarchy 3.1.2) onto the `HierNode` trees `stratify` builds; the `tree` transform
 * (vega-hierarchy Tree) drives them. Loaded by the transforms addon.
 */
import type { HierNode } from './transform.js'

type Separation = (a: HierNode, b: HierNode) => number

interface TreeOptions {
  /** `[dx, dy]` of the whole layout, or null when `nodeSize` is given. */
  size: [number, number] | null
  /** `[dx, dy]` of one node, or null when `size` is given. */
  nodeSize: [number, number] | null
  separation: Separation
}

/** d3's default `separation`: siblings 1 apart, cousins 2. */
export const defaultSeparation: Separation = (a, b) => (a.parent === b.parent ? 1 : 2)
/** vega-util `one`: every pair 1 apart (the `separation: false` of the tree transform). */
export const oneSeparation: Separation = () => 1

// d3 `node.eachAfter` / `node.eachBefore`: children are visited first to last (eachAfter pushes them in order and
// reads the result stack backwards)
function eachAfter<T extends { children: T[] | null }>(root: T, callback: (node: T) => void): void {
  const nodes: T[] = [root]
  const next: T[] = []
  let node: T | undefined
  while ((node = nodes.pop())) {
    next.push(node)
    const children = node.children
    if (children) for (let i = 0, n = children.length; i < n; ++i) nodes.push(children[i]!)
  }
  while ((node = next.pop())) callback(node)
}

function eachBefore<T extends { children: T[] | null }>(root: T, callback: (node: T) => void): void {
  const nodes: T[] = [root]
  let node: T | undefined
  while ((node = nodes.pop())) {
    callback(node)
    const children = node.children
    if (children) for (let i = children.length - 1; i >= 0; --i) nodes.push(children[i]!)
  }
}

/** A d3 node's `children` is absent for a leaf; a HierNode's is empty. */
const kids = (node: HierNode): HierNode[] | null => (node.children.length ? node.children : null)

interface TreeNode {
  _: HierNode | null
  parent: TreeNode | null
  children: TreeNode[] | null
  A: TreeNode | null // default ancestor
  a: TreeNode // ancestor
  z: number // prelim
  m: number // mod
  c: number // change
  s: number // shift
  t: TreeNode | null // thread
  i: number // number
}

function newTreeNode(node: HierNode | null, i: number): TreeNode {
  const t = { _: node, parent: null, children: null, A: null, a: undefined as unknown as TreeNode, z: 0, m: 0, c: 0, s: 0, t: null, i } as TreeNode
  t.a = t
  return t
}

function treeRoot(root: HierNode): TreeNode {
  const tree = newTreeNode(root, 0)
  const nodes: TreeNode[] = [tree]
  let node: TreeNode | undefined
  while ((node = nodes.pop())) {
    const children = kids(node._!)
    if (children) {
      const n = children.length
      node.children = new Array<TreeNode>(n)
      for (let i = n - 1; i >= 0; --i) {
        const child = node.children[i] = newTreeNode(children[i]!, i)
        nodes.push(child)
        child.parent = node
      }
    }
  }
  ;(tree.parent = newTreeNode(null, 0)).children = [tree]
  return tree
}

const nextLeft = (v: TreeNode): TreeNode | null => (v.children ? v.children[0]! : v.t)
const nextRight = (v: TreeNode): TreeNode | null => (v.children ? v.children[v.children.length - 1]! : v.t)

function moveSubtree(wm: TreeNode, wp: TreeNode, shift: number): void {
  const change = shift / (wp.i - wm.i)
  wp.c -= change
  wp.s += shift
  wm.c += change
  wp.z += shift
  wp.m += shift
}

function executeShifts(v: TreeNode): void {
  let shift = 0
  let change = 0
  const children = v.children!
  let i = children.length
  while (--i >= 0) {
    const w = children[i]!
    w.z += shift
    w.m += shift
    shift += w.s + (change += w.c)
  }
}

const nextAncestor = (vim: TreeNode, v: TreeNode, ancestor: TreeNode): TreeNode => (vim.a.parent === v.parent ? vim.a : ancestor)

/** d3 `tree()(root)`: Reingold-Tilford tidy layout. Writes `x` and `y` on every node. */
export function tidyTree(root: HierNode, o: TreeOptions): void {
  const separation = o.separation
  const t = treeRoot(root)

  function apportion(v: TreeNode, w: TreeNode | null, ancestorIn: TreeNode): TreeNode {
    let ancestor = ancestorIn
    if (w) {
      let vip: TreeNode | null = v
      let vop: TreeNode | null = v
      let vim: TreeNode | null = w
      let vom: TreeNode | null = vip.parent!.children![0]!
      let sip = vip.m
      let sop = vop.m
      let sim = vim.m
      let som = vom.m
      let shift: number
      for (;;) {
        vim = nextRight(vim!)
        vip = nextLeft(vip!)
        if (!(vim && vip)) break
        vom = nextLeft(vom!)
        vop = nextRight(vop!)
        vop!.a = v
        shift = vim.z + sim - vip.z - sip + separation(vim._!, vip._!)
        if (shift > 0) {
          moveSubtree(nextAncestor(vim, v, ancestor), v, shift)
          sip += shift
          sop += shift
        }
        sim += vim.m
        sip += vip.m
        som += vom!.m
        sop += vop!.m
      }
      if (vim && !nextRight(vop!)) {
        vop!.t = vim
        vop!.m += sim - sop
      }
      if (vip && !nextLeft(vom!)) {
        vom!.t = vip
        vom!.m += sip - som
        ancestor = v
      }
    }
    return ancestor
  }

  function firstWalk(v: TreeNode): void {
    const children = v.children
    const siblings = v.parent!.children!
    const w = v.i ? siblings[v.i - 1]! : null
    if (children) {
      executeShifts(v)
      const midpoint = (children[0]!.z + children[children.length - 1]!.z) / 2
      if (w) {
        v.z = w.z + separation(v._!, w._!)
        v.m = v.z - midpoint
      } else {
        v.z = midpoint
      }
    } else if (w) {
      v.z = w.z + separation(v._!, w._!)
    }
    v.parent!.A = apportion(v, w, v.parent!.A || siblings[0]!)
  }

  function secondWalk(v: TreeNode): void {
    v._!.x = v.z + v.parent!.m
    v.m += v.parent!.m
  }

  eachAfter(t, firstWalk)
  t.parent!.m = -t.z
  eachBefore(t, secondWalk)

  const nodeSize = o.nodeSize
  if (nodeSize) {
    const [dx, dy] = nodeSize
    eachBefore(root as { children: HierNode[] | null } & HierNode, (node) => {
      node.x *= dx
      node.y = node.depth * dy
    })
  } else {
    const [dx, dy] = o.size!
    let left = root
    let right = root
    let bottom = root
    eachBefore(root as { children: HierNode[] | null } & HierNode, (node) => {
      if (node.x < left.x) left = node
      if (node.x > right.x) right = node
      if (node.depth > bottom.depth) bottom = node
    })
    const s = left === right ? 1 : separation(left, right) / 2
    const tx = s - left.x
    const kx = dx / (right.x + s + tx)
    const ky = dy / (bottom.depth || 1)
    eachBefore(root as { children: HierNode[] | null } & HierNode, (node) => {
      node.x = (node.x + tx) * kx
      node.y = node.depth * ky
    })
  }
}

/** d3 `cluster()(root)`: the dendrogram layout (leaves at the same depth). Writes `x` and `y` on every node. */
export function clusterTree(root: HierNode, o: TreeOptions): void {
  const separation = o.separation
  let previousNode: HierNode | undefined
  let x = 0

  const nodes = root as { children: HierNode[] | null } & HierNode
  // (a d3 node's `children` is absent for a leaf)
  const asD3 = (n: HierNode): HierNode[] | null => kids(n)
  const walk = (cb: (node: HierNode) => void): void => {
    const stack: HierNode[] = [nodes]
    const next: HierNode[] = []
    let node: HierNode | undefined
    while ((node = stack.pop())) {
      next.push(node)
      const children = asD3(node)
      if (children) for (let i = 0, n = children.length; i < n; ++i) stack.push(children[i]!)
    }
    while ((node = next.pop())) cb(node)
  }

  walk((node) => {
    const children = asD3(node)
    if (children) {
      node.x = children.reduce((s, c) => s + c.x, 0) / children.length
      node.y = 1 + children.reduce((m, c) => Math.max(m, c.y), 0)
    } else {
      node.x = previousNode ? x += separation(node, previousNode) : 0
      node.y = 0
      previousNode = node
    }
  })

  let left = root
  while (left.children.length) left = left.children[0]!
  let right = root
  while (right.children.length) right = right.children[right.children.length - 1]!
  const x0 = left.x - separation(left, right) / 2
  const x1 = right.x + separation(right, left) / 2

  const nodeSize = o.nodeSize
  if (nodeSize) {
    const [dx, dy] = nodeSize
    walk((node) => {
      node.x = (node.x - root.x) * dx
      node.y = (root.y - node.y) * dy
    })
  } else {
    const [dx, dy] = o.size!
    walk((node) => {
      node.x = (node.x - x0) / (x1 - x0) * dx
      node.y = (1 - (root.y ? node.y / root.y : 1)) * dy
    })
  }
}
