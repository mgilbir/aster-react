/**
 * The order rows were made in. A sort that ties falls back to it, not to where the rows sit in the array: a `collect` that
 * sorted them by something else has moved them, and the sort after it still breaks its ties the way the rows were made. Rows
 * a transform makes new (fold, flatten, project, aggregate, ...) are made in the order it lists them, and a dataset made from
 * another makes new rows of its source's, in the order the source lists them.
 *
 * The order is kept beside the rows, not on them: a number per row, in a list that belongs to the array the rows came out in
 * (rows are not written to, and their shapes do not change). Only a `collect` that sorts, with a sort after it, makes one; it
 * rides along the transforms that keep their rows and their order (and a filter, which keeps some of them), and any other
 * transform ends it -- its rows are new, made in the order they are listed, which is what an array without a list means.
 */

type Row = Record<string, unknown>

const orders = new WeakMap<readonly unknown[], Float64Array>()

/** The order of the rows of an array, if it has one (and it still fits the array). */
export function orderOf(rows: readonly unknown[]): Float64Array | null {
  const order = orders.get(rows)
  return order !== undefined && order.length === rows.length ? order : null
}

/** Say how the rows of `result` stand in the order rows were made in. */
export function setOrder(result: readonly unknown[], order: Float64Array): void {
  orders.set(result, order)
}

/** Transforms that return their rows, all of them and in the order they were given. */
const KEEPS_ROWS = new Set([
  'formula', 'bin', 'timeunit', 'identifier', 'lookup', 'stack', 'window', 'joinaggregate', 'geopoint', 'geopath', 'geoshape',
  'linkpath', 'pie', 'dotbin', 'extent', 'resolvefilter',
])

/** Carry the order of the rows a transform was given to the rows it returned, if the transform keeps its rows. */
export function carryOrder(type: unknown, input: readonly Row[], output: readonly Row[]): void {
  const order = orderOf(input)
  if (order === null || orders.has(output)) return
  if (KEEPS_ROWS.has(type as string)) {
    if (output.length === input.length) orders.set(output, order)
  } else if (type === 'impute') {
    // the rows it was given, then the rows it made: those are newer than any
    if (output.length >= input.length) {
      const kept = new Float64Array(output.length)
      kept.set(order)
      let newest = -1
      for (let i = 0; i < order.length; i++) if (order[i]! > newest) newest = order[i]!
      for (let i = input.length; i < output.length; i++) kept[i] = ++newest
      orders.set(output, kept)
    }
  } else if (type === 'filter') {
    // the rows that pass, in the order they came: walk both lists
    const kept = new Float64Array(output.length)
    let j = 0
    for (let i = 0; i < input.length && j < output.length; i++) if (input[i] === output[j]) kept[j++] = order[i]!
    if (j === output.length) orders.set(output, kept)
  }
}

const placing = new WeakSet<object>()

/**
 * Mark the `collect`s of a dataset's transforms that leave the order behind: those that sort and have a sort (of a `collect`,
 * a `window` or a `stack`) after them. Nothing else needs it.
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

/** Whether a `collect` is marked as one that leaves the order behind. */
export const isPlacing = (t: object): boolean => placing.has(t)

/** Whether the `collect` at `at` of `transforms` leaves the order behind: it is marked, or a sort comes after it in the list. */
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
