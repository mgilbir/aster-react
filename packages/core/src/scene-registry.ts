/**
 * The group nodes of the scenes the engine returned.
 *
 * The engine never writes into a scene it returned: an evaluation after it keeps its nodes (a kept mark, a kept group item, a node
 * `shareContent` finds equal) and builds on what they hold. The one in-place write the engine makes, the
 * append path's push onto its own items array, first turns the group that held the array into a snapshot that reads what it held
 * (`supersedeItems`), so no node's content changes once returned (published-scene.test.ts holds this over sessions, streams and
 * pulses). What is derived from a node -- its hit entries, its accessible box, which items it holds, whether one has a cursor --
 * is therefore a function of the node's identity, for the nodes recorded here, and may be kept with it (WeakMap-keyed: it lives
 * as long as the node) and used for a later scene that kept the node (`keptInto`). A node a host built, or a clone of a scene (a
 * worker's), is not recorded: nothing derived from it is kept.
 *
 * The guarantee is the nodes', not the arrays read from them: the append path's push grows the items array a node held when it was
 * returned (the node itself is moved to a snapshot that reads what it held). So a reader that keeps what a node held past the
 * evaluation it was read in -- a hit index, an accessible tree -- keeps a copy of the array, not the array (C229).
 */
import type { SceneGroup, SceneItem, SceneNode, SceneRoot } from './types.js'

const ENGINE_NODES = new WeakSet<object>()

/** How many times something derived from a node was made anew where it may be kept (the hit entries of a guide), since read. For the tests. */
export const derivedCounts = { guideEntries: 0 }

/** Whether `node` is a group node of a scene the engine returned (see the module comment). */
export function isEngineNode(node: object): boolean {
  return ENGINE_NODES.has(node)
}

/**
 * Whether what was derived from an engine node while a scene `made` was read may be used while reading scene `now`: only in another
 * scene, one that kept the node. A host may write into a scene it was given and draw that scene again (the renderers then draw what it
 * wrote, as they always have): what was derived from it is made afresh whenever the same scene is read again. A scene the engine
 * makes after such a write is made from what was written, which no reuse of the engine promises to draw.
 */
export function keptInto(made: object, now: object): boolean {
  return made !== now
}

/**
 * Record the group nodes of a scene the engine is about to return. A node already recorded was returned before and is unchanged
 * since, and so is everything in it: its subtree is not walked again, so a scene that keeps most of the one before costs what it
 * made anew. The leaves of a mark are not walked (they hold no group).
 */
export function noteEngineScene(scene: SceneRoot): void {
  for (const g of scene.items) note(g, 0)
}

function note(node: SceneNode, depth: number): void {
  const items = (node as SceneGroup).items
  if (!Array.isArray(items) || ENGINE_NODES.has(node) || depth > 256) return
  ENGINE_NODES.add(node)
  const g = node as SceneGroup
  // (a mark's items are leaves, but a group mark's are group items, and a guide holds groups of its parts)
  if (g.role === 'mark' && g.marktype !== 'group') return
  for (const c of items) note(c, depth + 1)
}

const ROOT_ITEMS = new WeakMap<object, SceneItem>()
const ROOT_ITEM_SET = new WeakSet<object>()

/**
 * The root group item of a scene, vega's `mark-group role-frame root` item: what `event.item` is where nothing else is hit and the
 * view's frame is painted (a fill, a transparent one included, or a stroke). One object per scene, so the hit index and the event loop
 * name the same item; it carries what the view's own `encode` gave it that an event or the cursor reads (`cursor`).
 */
export function rootItemOf(scene: SceneRoot): SceneItem {
  let item = ROOT_ITEMS.get(scene)
  if (item === undefined) {
    item = { x: 0, y: 0, ...(typeof scene.frameCursor === 'string' ? { cursor: scene.frameCursor } : {}) } as SceneItem
    ROOT_ITEMS.set(scene, item)
    ROOT_ITEM_SET.add(item)
  }
  return item
}

/** Whether an item is a scene's root group item (see `rootItemOf`). */
export function isRootItem(item: object): boolean {
  return ROOT_ITEM_SET.has(item)
}
