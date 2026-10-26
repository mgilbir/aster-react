/**
 * The `modify` expression function and vega-dataflow's changeset, for named datasets.
 *
 * vega's `modify(name, insert, remove, toggle, modify, values)` (vega-functions/src/functions/modify.js)
 * queues its edits in a changeset that is pulsed into the dataset's input after the running pass; the
 * edits of one pass share one changeset, and a `toggle` is decided against the dataset as it was BEFORE
 * the pass (so two toggles of one pass see the same state). `planModify` is the call, `applyChangeset`
 * the pulse (vega-dataflow ChangeSet.pulse followed by the collect that keeps the dataset's input).
 *
 * A dataset's input is an array of tuples. vega gives each tuple an id when it is ingested and matches
 * tuples by id; a tuple here is an object and is matched by identity. The rows `data()` returns are copies
 * (the evaluation does not hand out its inputs), so a tuple handed to `remove` that is not one of the
 * dataset's rows is treated as a property pattern, as any plain object is, and one handed to `modify`
 * stands for the first row equal to it.
 */
import { array, isArray, isFunction, isObject } from './util.js'

type Tuple = Record<string, unknown>

export interface Changeset {
  /** insert tuples */
  add: unknown[]
  /** remove tuples */
  rem: object[]
  /** remove by predicate */
  remp: Array<(t: Tuple) => boolean>
  /** modify tuples */
  mod: Array<{ tuple: Tuple; field: string; value: unknown }>
}

export function newChangeset(): Changeset {
  return { add: [], rem: [], remp: [], mod: [] }
}

/** modify.js `equal`: same value, both NaN, or arrays / objects that agree entry by entry. */
function equal(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
    ? true
    : isArray(a)
      ? isArray(b) && a.length === b.length
        ? equalArray(a, b)
        : false
      : isObject(a) && isObject(b)
        ? equalObject(a as object, b as object)
        : false
}

function equalArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  for (let i = 0, n = a.length; i < n; ++i) {
    if (!equal(a[i], b[i])) return false
  }
  return true
}

function equalObject(a: object, b: object): boolean {
  for (const key in a) {
    if (!equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

const removePredicate = (props: object) => (t: Tuple): boolean => equalObject(props, t)

/**
 * Queue one `modify(...)` call into `changes`. `rows` is the dataset's input as of the start of the pass.
 * `changes()` returns the pass's changeset, creating it on first use (the caller schedules its pulse).
 * Returns what the function returns: 0 when there was nothing to do, else 1.
 */
export function planModify(
  rows: readonly Tuple[],
  changes: () => Changeset,
  insert: unknown,
  remove: unknown,
  toggle: unknown,
  modifyArg: unknown,
  values: unknown,
): number {
  if (!(rows.length || insert || toggle)) return 0 // nothing to do!

  const cs = changes()

  if (remove) {
    const predicate = remove === true
      ? () => true
      : isArray(remove) || (isObject(remove) && rows.includes(remove as Tuple))
        ? null
        : removePredicate(remove as object)
    if (predicate) cs.remp.push(predicate)
    else for (const t of array(remove) as object[]) cs.rem.push(t)
  }

  if (insert) {
    for (const t of array(insert)) cs.add.push(t)
  }

  if (toggle) {
    const predicate = removePredicate(toggle as object)
    if (rows.some(predicate)) {
      cs.remp.push(predicate)
    } else {
      cs.add.push(toggle)
    }
  }

  if (modifyArg) {
    if (isFunction(modifyArg)) {
      throw Error('modify parameter must be a data tuple, not a function')
    }
    // A tuple read back through `data()` is a copy of the row the dataset holds (the evaluation never hands out
    // its inputs), so one that is not a row itself stands for the first row equal to it.
    const target = rows.includes(modifyArg as Tuple) ? (modifyArg as Tuple) : (rows.find((r) => equalObject(modifyArg as object, r)) ?? (modifyArg as Tuple))
    for (const key in values as object) {
      const value = (values as Record<string, unknown>)[key]
      cs.mod.push({ tuple: target, field: key, value })
    }
  }

  return 1
}

/** A tuple as vega ingests it: an object as is, a literal wrapped as `{data}`. */
const ingest = (d: unknown): Tuple => (d === Object(d) ? (d as Tuple) : { data: d })

/**
 * The dataset's input after the changeset is pulsed into it: the surviving tuples in their order, then the
 * inserted ones. Tuples are modified in place, as vega's `modify` does. Returns the new array (a new
 * array even when nothing changed, as the caller replaces the input).
 */
export function applyChangeset(rows: readonly Tuple[], cs: Changeset): Tuple[] {
  // flag: 1 resident, -1 resident and to be removed
  const cur = new Map<unknown, number>()
  for (const t of rows) cur.set(t, 1)

  for (const t of cs.rem) cur.set(t, -1)
  for (const f of cs.remp) for (const t of rows) if (f(t)) cur.set(t, -1)

  const added: Tuple[] = []
  for (const raw of cs.add) {
    if (cur.get(raw)) {
      // the tuple already resides in the dataset: flagged for both add and remove, cancel
      cur.set(raw, 1)
    } else {
      added.push(ingest(raw))
    }
  }

  for (const m of cs.mod) {
    if ((cur.get(m.tuple) ?? 0) > 0) m.tuple[m.field] = m.value
  }

  const out: Tuple[] = []
  for (const t of rows) if ((cur.get(t) ?? 0) >= 0) out.push(t)
  for (const t of added) out.push(t)
  return out
}
