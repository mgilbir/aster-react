/**
 * The two walks the hierarchy layouts are written on. The visiting order is not cosmetic: the circle packer draws from
 * a shared random source while it climbs the tree, so the order in which sibling subtrees are finished decides every
 * draw after it. Both walks visit the children of a node first to last.
 */

/** A tree node whose `children` is the list of its children, empty or null for a leaf. */
export interface TreeLike<T> {
  children: readonly T[] | null
}

/** Each node before its descendants (parent first, children first to last). */
export function walkPreOrder<T extends TreeLike<T>>(root: T, visit: (node: T) => void): void {
  const stack: T[] = [root]
  let node: T | undefined
  while ((node = stack.pop())) {
    visit(node)
    const kids = node.children
    if (kids) for (let i = kids.length - 1; i >= 0; --i) stack.push(kids[i]!)
  }
}

/** Each node after its descendants (children first to last, then the parent). */
export function walkPostOrder<T extends TreeLike<T>>(root: T, visit: (node: T) => void): void {
  const stack: T[] = [root]
  const done: T[] = []
  let node: T | undefined
  // a pre-order that takes the last child first, replayed backwards, is the post-order that takes the first child first
  while ((node = stack.pop())) {
    done.push(node)
    const kids = node.children
    if (kids) for (let i = 0; i < kids.length; ++i) stack.push(kids[i]!)
  }
  while ((node = done.pop())) visit(node)
}
