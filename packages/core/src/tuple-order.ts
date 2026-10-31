/**
 * The order rows were made in. A sort that ties falls back to it, not to where the rows sit in the array: a `collect` that
 * sorted them by something else has moved them, and the sort after it still breaks its ties the way the rows were made. Rows
 * a transform makes new (fold, flatten, project, aggregate, ...) are made in the order it lists them, and a dataset made from
 * another makes new rows of its source's, in the order the source lists them.
 *
 * A row is not given its place until something is about to move rows (a `collect` that sorts, with a sort after it): a row with
 * none was made after every row that has one, in array order. The place rides on the row (copies of a row keep it, as the
 * copies a pipeline makes of rows it writes onto are the same row), and a transform that makes a new row of one drops it.
 */

type Row = Record<string | symbol, unknown>

/** Where a row came from in the order rows were made. */
export const MADE: unique symbol = Symbol('aster.made') as never

let made = 0

/** How two rows compare by the order they were made in (0: neither has a place, or both the same one). */
export function madeBefore(a: unknown, b: unknown): number {
  const x = a !== null && typeof a === 'object' ? (a as Row)[MADE] as number | undefined : undefined
  const y = b !== null && typeof b === 'object' ? (b as Row)[MADE] as number | undefined : undefined
  return x === undefined ? (y === undefined ? 0 : 1) : y === undefined ? -1 : x - y
}

/** Give the rows that have no place theirs, in array order. The rows must be the caller's to write onto. */
export function placeRows(rows: Row[]): void {
  for (const row of rows) if (row[MADE] === undefined) row[MADE] = ++made
}

/** A new row made of another's fields: the fields, and not the other's place. */
export function remake(row: Row): Row {
  const copy = { ...row }
  if (copy[MADE] !== undefined) delete copy[MADE]
  return copy
}

const placing = new WeakSet<object>()

/**
 * Mark the `collect`s of a dataset's transforms that give the rows their places: those that sort and have a sort (of a `collect`,
 * a `window` or a `stack`) after them. Nothing else needs the places, and giving them costs the rows a write.
 */
export function markPlacing(transforms: ReadonlyArray<{ type?: unknown; sort?: unknown }>): void {
  let sortsAfter = false
  for (let i = transforms.length - 1; i >= 0; i--) {
    const t = transforms[i]!
    const sorts = (t.type === 'collect' || t.type === 'window' || t.type === 'stack') && t.sort !== undefined
    if (t.type === 'collect' && sorts && sortsAfter) placing.add(t)
    if (sorts) sortsAfter = true
  }
}

/** Whether a `collect` gives the rows their places before it sorts them. */
export const isPlacing = (t: object): boolean => placing.has(t)

/** Whether the `collect` at `at` of `transforms` gives the rows their places: it is marked, or a sort comes after it in the list. */
export function placesAt(transforms: ReadonlyArray<{ type?: unknown; sort?: unknown }>, at: number): boolean {
  const t = transforms[at]!
  if (placing.has(t)) return true
  if (t.type !== 'collect' || t.sort === undefined) return false
  for (let i = at + 1; i < transforms.length; i++) {
    const u = transforms[i]!
    if ((u.type === 'collect' || u.type === 'window' || u.type === 'stack') && u.sort !== undefined) return true
  }
  return false
}
