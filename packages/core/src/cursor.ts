/**
 * The mouse cursor a chart shows, resolved the way vega-view does it (`cursor.js`), and the tracker a host keeps it with. Apart
 * from the signal loop (signals.ts, which re-exports them): a host reads `sceneHasCursor` on every render and tracks the cursor of
 * a chart that has no signal at all, so the React shells load these up front and the loop only for a chart that binds it.
 *
 * A view keeps a `cursor` signal `{user, item}`. `user` is the spec's own `cursor` signal (a string such as
 * `'pointer'`, 'default' when the spec has none); `item` is the `cursor` channel of the item under the pointer (set at every
 * pointermove, null when the pointer is over no item or an item without one). The user's wins unless it is 'default',
 * else the item's, else the user's again. This module is only that rule; hosts apply the result (vega writes the
 * container's `style.cursor`, `<Chart>` renders it).
 */

import type { CompiledChart, SceneGroup, SceneItem, SceneNode, SceneRoot } from './types.js'
import { isEngineNode, keptInto } from './scene-registry.js'

/** The cursor a view shows when nothing sets one (vega-view cursor.js `Default`). */
export const DEFAULT_CURSOR = 'default'

/**
 * The cursor keywords of CSS (CSS Basic User Interface 4, `cursor`). A cursor is shown only as one of these: a CSS cursor may
 * also be a `url()` list, an image the viewer's browser fetches, which no URL policy would ever see, so a value that is not a
 * keyword is not a cursor (as if it were not given).
 */
const CURSOR_KEYWORDS: ReadonlySet<string> = new Set([
  'auto', 'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair', 'text', 'vertical-text',
  'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize', 'row-resize', 'n-resize',
  'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize',
  'nwse-resize', 'zoom-in', 'zoom-out',
])

/** A cursor value as a host may show it: a CSS cursor keyword (ASCII case-insensitive, as CSS reads it), else null. */
export function cursorKeyword(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const k = value.trim().toLowerCase()
  return CURSOR_KEYWORDS.has(k) ? k : null
}

/**
 * The cursor to show for the value of the `cursor` signal and the item's cursor, or null for none (vega then removes the
 * container's `cursor` style). A signal value that is the view's own `{user, item}` object (what vega writes into a spec
 * signal named `cursor` at its first pointermove) carries its item.
 *
 * This is the one place a cursor reaches a host, so it is where a cursor is vetted: the cursor vega's rule picks is shown only
 * when it is a CSS keyword ({@link cursorKeyword}); anything else is no cursor. A browser drops a value that is not a cursor at
 * all (vega's container then has none, as here); a `url(...)` cursor it would fetch, past the URL policy, so it is not shown
 * either. (vega hands the text on as it is.)
 */
export function resolveCursor(signal: unknown, item: string | null): string | null {
  let user: unknown = DEFAULT_CURSOR
  let held = item
  if (typeof signal === 'string') {
    user = signal
  } else if (signal != null && typeof signal === 'object') {
    user = (signal as { user?: unknown }).user
    const inner = (signal as { item?: unknown }).item
    held = typeof inner === 'string' && inner !== '' ? inner : null
  }
  const shown = user && user !== DEFAULT_CURSOR ? user : (held || user)
  return typeof shown === 'string' && shown !== '' ? cursorKeyword(shown) : null
}

// --- the tracker -----------------------------------------------------------------------------------------------------------

/** What the cursor tracker needs from its host. */
export interface CursorTrackerOptions {
  /**
   * The item under the point `move` was given (`HitIndex.pick` of the view-space position: the topmost item that takes the
   * pointer), or null. The point is the host's to define: a host that knows no item has a cursor answers null without
   * converting it.
   */
  pick: (x: number, y: number) => { item: object } | null
  /** The value of the spec's `cursor` signal now (a string; undefined when the spec has none). Read at every move and refresh. */
  user: () => unknown
  /** Told the cursor to show whenever it changes (null: none). Never told the same value twice in a row. */
  onCursor: (cursor: string | null) => void
  /** `config.events`: a `view` rule that blocks `pointermove` stops the tracker from ever looking (vega's `permit`). */
  eventConfig?: CompiledChart['eventConfig']
}

export interface CursorTracker {
  /** The pointer moved to this point (vega: a `pointermove` of the view): read the `cursor` of the item `pick` finds there, report the result. */
  move: (x: number, y: number) => void
  /** The `cursor` signal changed (vega: its operator re-runs): report the cursor with the item the pointer was last over. */
  refresh: () => void
}

/**
 * vega-view `cursor.js`: the item cursor is taken at every pointermove (`event.item && event.item.cursor || null`, so
 * moving off the items resets it), the visible cursor is `resolveCursor(user, item)`. The host owns where it is shown.
 * Framework-agnostic: nothing here touches the DOM.
 */
export function createCursorTracker(opts: CursorTrackerOptions): CursorTracker {
  // `opts` is read afresh at every call: a host that re-renders updates it in place, the tracker (and the item it holds) stays
  const blocked = (): boolean => {
    // vega-view events.js `permit(view, 'view', 'pointermove')`: `false`, or a list / object of types that lacks it, blocks it
    const rule = opts.eventConfig?.view
    return rule === false || (rule != null && typeof rule === 'object' && !(Array.isArray(rule) ? rule.includes('pointermove') : (rule as Record<string, unknown>).pointermove))
  }
  let item: string | null = null
  // vega rewrites the signal as `{user, item}` at a pointermove (user: its value, or 'default' when that is falsy): until the
  // host changes the value, that is what the signal holds
  let hasMoved = false
  let movedRaw: unknown
  let movedUser: unknown
  const signal = (): unknown => {
    const raw = opts.user()
    if (!hasMoved || movedRaw !== raw) return raw
    return typeof movedUser === 'string' ? movedUser : { user: movedUser, item }
  }
  let shown: string | null = resolveCursor(opts.user(), null)
  const report = (): void => {
    const next = resolveCursor(signal(), item)
    if (next === shown) return
    shown = next
    opts.onCursor(next)
  }
  return {
    move(x, y) {
      if (blocked()) return
      const raw = opts.user()
      if (!hasMoved || movedRaw !== raw) {
        hasMoved = true
        movedRaw = raw
        movedUser = raw ? (typeof raw === 'string' ? raw : (raw as { user?: unknown }).user) : 'default'
      }
      const c = (opts.pick(x, y)?.item as { cursor?: unknown } | undefined)?.cursor
      item = typeof c === 'string' && c !== '' ? c : null
      report()
    },
    refresh: report,
  }
}

/** Whether any item of the scene has a `cursor` channel (so a host can skip picking on every pointermove when none does). */
export function sceneHasCursor(scene: SceneRoot): boolean {
  let known = cursorScenes.get(scene)
  if (known === undefined) {
    const walk = (nodes: readonly SceneNode[] | undefined, depth: number): boolean => {
      for (const n of nodes ?? []) {
        if ((n as SceneItem).cursor != null) return true
        const items = (n as SceneGroup).items
        if (!Array.isArray(items)) continue
        // (a node of a scene the engine returned holds what it held: whether it holds a cursor is kept with it)
        const engine = isEngineNode(n)
        const kept = engine ? cursorNodes.get(n) : undefined
        let has = kept !== undefined && keptInto(kept.root, scene) ? kept.has : undefined
        if (has === undefined) {
          has = depth < 256 && walk(items, depth + 1)
          if (engine) cursorNodes.set(n, { has, root: scene })
        }
        if (has) return true
      }
      return false
    }
    cursorScenes.set(scene, (known = walk(scene.items, 0)))
  }
  return known
}
const cursorScenes = new WeakMap<SceneRoot, boolean>()
const cursorNodes = new WeakMap<object, { has: boolean; root: object }>()
