/**
 * The mouse cursor a chart shows, resolved the way vega-view does it (`cursor.js`).
 *
 * A view keeps a `cursor` signal `{user, item}`. `user` is the spec's own `cursor` signal (a string such as
 * `'pointer'`, 'default' when the spec has none); `item` is the `cursor` channel of the item under the pointer (set at every
 * pointermove, null when the pointer is over no item or an item without one). The user's wins unless it is 'default',
 * else the item's, else the user's again. This module is only that rule; hosts apply the result (vega writes the
 * container's `style.cursor`, `<Chart>` renders it).
 */

/** The cursor a view shows when nothing sets one (vega-view cursor.js `Default`). */
export const DEFAULT_CURSOR = 'default'

/**
 * The cursor to show for the value of the `cursor` signal and the item's cursor, or null for none (vega then removes the
 * container's `cursor` style). A signal value that is the view's own `{user, item}` object (what vega writes into a spec
 * signal named `cursor` at its first pointermove) carries its item.
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
  return typeof shown === 'string' && shown !== '' ? shown : null
}
