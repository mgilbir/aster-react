/**
 * The order rows were made in. A sort that ties falls back to it, not to where the rows sit in the array: a `collect` that
 * sorted them by something else has moved them, and the sort after it still breaks its ties the way the rows were made. Rows
 * a transform makes new (fold, flatten, project, aggregate, ...) are made in the order it lists them, and a dataset made from
 * another makes new rows of its source's, in the order the source lists them.
 *
 * A row is not given its place until something is about to move rows (a `collect` that sorts, with a sort after it): a row with
 * none was made after every row that has one, in array order. The place rides on the row: the copies a pipeline makes of rows it may
 * not write onto are the same rows and keep it, and a transform that makes a new row of one (`remake`) gives it a place of its own.
 */

type Row = Record<string | symbol, unknown>

/** Where a row stands in the order rows were made; a symbol, so no key listing and no serialisation sees it, and a copy by spreading takes it along. */
export const MADE: unique symbol = Symbol('aster.made') as never
let next = 0

const placeOf = (row: unknown): number | undefined => (row !== null && typeof row === 'object' ? (row as Record<symbol, number | undefined>)[MADE] : undefined)

/** Give the rows that have no place theirs, in array order. The rows must be the caller's to write onto. */
export function placeRows(rows: readonly Row[]): void {
  for (const row of rows) if (row[MADE] === undefined) row[MADE] = ++next
}

/** Whether some of the rows have a place (the first and the last row tell). */
export function anyPlaced(rows: readonly unknown[]): boolean {
  const n = rows.length
  return n > 1 && (placeOf(rows[0]) !== undefined || placeOf(rows[n - 1]) !== undefined)
}

/**
 * The places of `rows`, read once for a sort: `null` when none has one (the first and the last row tell), else one number each, a row
 * without a place counting as made after every row that has one.
 */
export function placesOf(rows: readonly unknown[]): Float64Array | null {
  const n = rows.length
  if (n < 2 || (placeOf(rows[0]) === undefined && placeOf(rows[n - 1]) === undefined)) return null
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = placeOf(rows[i]) ?? Infinity
  return out
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

/** A new row made of the fields of another: the fields, and a place of its own, after the places of every row made so far. */
export function remake(row: Row): Row {
  const copy = { ...row }
  if (copy[MADE] !== undefined) copy[MADE] = ++next
  return copy
}

/**
 * The rows of a dataset made from the rows of others: new rows, made in the order the sources list them. If any source has places the
 * new rows all have places of their own, after every row made so far, so that no row of the dataset is older than another.
 */
export function deriveRows(sources: ReadonlyArray<readonly Row[]>): Row[] {
  const out: Row[] = []
  const place = sources.some(anyPlaced)
  for (const rows of sources) {
    for (const row of rows) {
      const copy = { ...row }
      if (place) copy[MADE] = ++next
      out.push(copy)
    }
  }
  return out
}
