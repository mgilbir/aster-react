/**
 * The `tree` transform's two layouts over the `HierNode` trees `stratify` builds: the tidy tree (Reingold-Tilford as
 * improved by Buchheim, Jünger and Leipert, linear time) and the cluster dendrogram. Loaded by the transforms addon.
 *
 * Observable behaviour fixed here: the tidy layout's float arithmetic (preliminary positions, modifiers, the shifts moved
 * onto subtrees and the thread/ancestor bookkeeping that decides where they apply) and the order the nodes are
 * walked in; the final scaling of the positions into `size` or by `nodeSize`.
 */
import type { HierNode } from './transform.js'
import { walkPostOrder, walkPreOrder } from './tree-walk.js'

type Separation = (a: HierNode, b: HierNode) => number

export interface TreeOptions {
  /** `[dx, dy]` of the whole layout, or null when `nodeSize` is given. */
  size: [number, number] | null
  /** `[dx, dy]` of one node, or null when `size` is given. */
  nodeSize: [number, number] | null
  separation: Separation
}

/** Siblings are 1 apart, cousins 2. */
export const defaultSeparation: Separation = (a, b) => (a.parent === b.parent ? 1 : 2)
/** Every pair is 1 apart (the transform's `separation: false`). */
export const oneSeparation: Separation = () => 1

const NONE = -1

/** Tidy tree layout: writes `x` (position across the tree) and `y` (depth scaled) on every node of the tree under `root`. */
export function tidyTree(root: HierNode, o: TreeOptions): void {
  const separation = o.separation
  // The nodes are numbered in pre-order, so a parent always precedes its children; the root's virtual parent is the
  // last number and holds the root as its only child. Per-node state lives in parallel arrays by number.
  const nodes: HierNode[] = []
  const numberOf = new Map<HierNode, number>()
  walkPreOrder(root, (node) => { numberOf.set(node, nodes.length); nodes.push(node) })
  const n = nodes.length
  const virtual = n
  const parent = new Int32Array(n + 1)
  const kidStart = new Int32Array(n + 1)
  const kidCount = new Int32Array(n + 1)
  const kids = new Int32Array(n)
  const sibling = new Int32Array(n + 1) // position among its parent's children
  let cursor = 0
  for (let v = 0; v < n; ++v) {
    const children = nodes[v]!.children
    kidStart[v] = cursor
    kidCount[v] = children.length
    for (let i = 0; i < children.length; ++i) {
      const c = numberOf.get(children[i]!)!
      kids[cursor++] = c
      parent[c] = v
      sibling[c] = i
    }
  }
  kidStart[virtual] = cursor
  kidCount[virtual] = 1
  kids[cursor] = 0
  parent[0] = virtual
  parent[virtual] = NONE

  const prelim = new Float64Array(n + 1)
  const mod = new Float64Array(n + 1)
  const change = new Float64Array(n + 1)
  const shift = new Float64Array(n + 1)
  const thread = new Int32Array(n + 1).fill(NONE)
  const ancestor = new Int32Array(n + 1).map((_, v) => v)
  const defaultAncestor = new Int32Array(n + 1).fill(NONE) // of a node's children

  const leftmostKid = (v: number): number => kids[kidStart[v]!]!
  const rightmostKid = (v: number): number => kids[kidStart[v]! + kidCount[v]! - 1]!
  /** The next node down the left (right) contour of the subtree under `v`: its first (last) child, else its thread. */
  const nextLeft = (v: number): number => (kidCount[v] ? leftmostKid(v) : thread[v]!)
  const nextRight = (v: number): number => (kidCount[v] ? rightmostKid(v) : thread[v]!)

  /** Move the subtree at `right` by `by`, spreading the move over the siblings between it and `left`. */
  function moveSubtree(left: number, right: number, by: number): void {
    const perSibling = by / (sibling[right]! - sibling[left]!)
    change[right]! -= perSibling
    shift[right]! += by
    change[left]! += perSibling
    prelim[right]! += by
    mod[right]! += by
  }

  /** Apply the shifts accumulated on the children of `v`, last child first. */
  function applyShifts(v: number): void {
    let carried = 0
    let changed = 0
    for (let i = kidCount[v]! - 1; i >= 0; --i) {
      const w = kids[kidStart[v]! + i]!
      prelim[w]! += carried
      mod[w]! += carried
      carried += shift[w]! + (changed += change[w]!)
    }
  }

  /** Place the subtree at `v` against the contours of its left siblings' subtrees; returns the default ancestor. */
  function apportion(v: number, leftSibling: number, defaultAnc: number): number {
    if (leftSibling === NONE) return defaultAnc
    // inside/outside contours of the right (ip, op) and left (im, om) subtrees, with the modifier sums along them
    let vip = v
    let vop = v
    let vim = leftSibling
    let vom = kids[kidStart[parent[v]!]!]!
    let sip = mod[vip]!
    let sop = mod[vop]!
    let sim = mod[vim]!
    let som = mod[vom]!
    for (;;) {
      vim = nextRight(vim)
      vip = nextLeft(vip)
      if (vim === NONE || vip === NONE) break
      vom = nextLeft(vom)
      vop = nextRight(vop)
      ancestor[vop] = v
      const gap = prelim[vim]! + sim - prelim[vip]! - sip + separation(nodes[vim]!, nodes[vip]!)
      if (gap > 0) {
        const a = ancestor[vim]!
        moveSubtree(parent[a] === parent[v] ? a : defaultAnc, v, gap)
        sip += gap
        sop += gap
      }
      sim += mod[vim]!
      sip += mod[vip]!
      som += mod[vom]!
      sop += mod[vop]!
    }
    if (vim !== NONE && nextRight(vop) === NONE) {
      thread[vop] = vim
      mod[vop]! += sim - sop
    }
    if (vip !== NONE && nextLeft(vom) === NONE) {
      thread[vom] = vip
      mod[vom]! += sip - som
      defaultAnc = v
    }
    return defaultAnc
  }

  // first walk (children before parents, first child first): preliminary positions and modifiers
  walkPostOrder(root, (node) => {
    const v = numberOf.get(node)!
    const p = parent[v]!
    const left = sibling[v] ? kids[kidStart[p]! + sibling[v]! - 1]! : NONE
    if (kidCount[v]) {
      applyShifts(v)
      const midpoint = (prelim[leftmostKid(v)]! + prelim[rightmostKid(v)]!) / 2
      if (left !== NONE) {
        prelim[v] = prelim[left]! + separation(node, nodes[left]!)
        mod[v] = prelim[v]! - midpoint
      } else {
        prelim[v] = midpoint
      }
    } else if (left !== NONE) {
      prelim[v] = prelim[left]! + separation(node, nodes[left]!)
    }
    defaultAncestor[p] = apportion(v, left, defaultAncestor[p]! !== NONE ? defaultAncestor[p]! : kids[kidStart[p]!]!)
  })

  // second walk (parents before children): final positions
  mod[virtual] = -prelim[0]!
  for (let v = 0; v < n; ++v) {
    nodes[v]!.x = prelim[v]! + mod[parent[v]!]!
    mod[v]! += mod[parent[v]!]!
  }

  const nodeSize = o.nodeSize
  if (nodeSize) {
    const [dx, dy] = nodeSize
    for (const node of nodes) {
      node.x *= dx
      node.y = node.depth * dy
    }
    return
  }
  const [dx, dy] = o.size!
  let left = root
  let right = root
  let bottom = root
  for (const node of nodes) {
    if (node.x < left.x) left = node
    if (node.x > right.x) right = node
    if (node.depth > bottom.depth) bottom = node
  }
  const s = left === right ? 1 : separation(left, right) / 2
  const tx = s - left.x
  const kx = dx / (right.x + s + tx)
  const ky = dy / (bottom.depth || 1)
  for (const node of nodes) {
    node.x = (node.x + tx) * kx
    node.y = node.depth * ky
  }
}

/** Cluster dendrogram layout: leaves evenly spread, parents centred over their children, all leaves at the same level. */
export function clusterTree(root: HierNode, o: TreeOptions): void {
  const separation = o.separation
  let previousLeaf: HierNode | undefined
  let x = 0
  walkPostOrder(root, (node) => {
    const children = node.children
    if (children.length) {
      node.x = children.reduce((sum, c) => sum + c.x, 0) / children.length
      node.y = 1 + children.reduce((top, c) => Math.max(top, c.y), 0)
    } else {
      node.x = previousLeaf ? x += separation(node, previousLeaf) : 0
      node.y = 0
      previousLeaf = node
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
    walkPostOrder(root, (node) => {
      node.x = (node.x - root.x) * dx
      node.y = (root.y - node.y) * dy
    })
  } else {
    const [dx, dy] = o.size!
    walkPostOrder(root, (node) => {
      node.x = (node.x - x0) / (x1 - x0) * dx
      node.y = (1 - (root.y ? node.y / root.y : 1)) * dy
    })
  }
}
