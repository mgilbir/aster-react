/**
 * The Vega-Lite selection functions of the expression language: `vlSelectionTest`, `vlSelectionIdTest`,
 * `vlSelectionResolve` and `vlSelectionTuples`.
 *
 * A selection lives in a store, a dataset of tuples. An intensional tuple names the fields it constrains,
 * `{unit, fields: [{field, type}], values}`, and `type` says how its value constrains a datum (see `POINT_TESTS`). An
 * extensional tuple is just `{unit, _vgsid_}`: the identifier of a selected datum. `unit` names the view the tuple came
 * from. The functions read the store as the rows of its dataset after the dataset's own transforms, so an extensional
 * store arrives sorted by `_vgsid_`.
 *
 * What other code can see, and so what is fixed here:
 *   - Testing rewrites the store. A tuple value that is a Date (or a list that starts with one) becomes a number in the
 *     tuple itself, the first time a datum is tested against it, and later reads of the store show the numbers.
 *   - Combining units for `intersect` needs a match in every unit; `union` needs a match in any.
 *   - With no tuples at all `vlSelectionTest` answers `0`, not `false`.
 *   - `vlSelectionResolve` merges a unit's lists with the same sloppy rules the store was written under: an empty
 *     accumulator is replaced by the next list, so an empty intersection starts over with the next unit.
 */
import { array, error, extend, field, inrange, isArray, isDate, isObject, toNumber } from './util.js'

export const SELECTION_ID = '_vgsid_'

type Row = Record<string, unknown>
type Rows = readonly Row[] | undefined
interface FieldDef { field: string; type: string }

const selectionIdOf = field(SELECTION_ID)

/** What testing needs of one field definition: its accessor and the test for its type, found once. */
interface FieldTest {
  type: string
  read: (d: unknown) => unknown
  test: ((d: unknown, v: unknown) => boolean) | undefined
}
const fieldTests = new WeakMap<object, FieldTest>()

function fieldTestOf(def: FieldDef): FieldTest {
  let entry = fieldTests.get(def)
  // the type is compared on every use: a definition is not frozen, and a changed type must not keep its old test
  if (!entry || entry.type !== def.type) {
    entry = { type: def.type, read: field(def.field), test: Object.hasOwn(POINT_TESTS, def.type) ? POINT_TESTS[def.type] : undefined }
    fieldTests.set(def, entry)
  }
  return entry
}

/** The value of the definition's field in a datum. */
const valueOf = (def: FieldDef, datum: unknown): unknown => fieldTestOf(def).read(datum)

// -- testing a datum against one tuple ------------------------------------------------------------------------------

/** How a tuple of each field type constrains a datum's value `d`, given the tuple's value `v`. */
const POINT_TESTS: Record<string, (d: unknown, v: unknown) => boolean> = {
  // a single value, or a list of values (an interval over a discrete field)
  E: (d, v) => (isArray(v) ? v.includes(d) : d === v),
  R: (d, v) => inrange(d, v as unknown[]),
  'R-RE': (d, v) => inrange(d, v as unknown[], true, false),
  'R-E': (d, v) => inrange(d, v as unknown[], false, false),
  'R-LE': (d, v) => inrange(d, v as unknown[], false, true),
  'E-LT': (d, v) => !((d as number) >= (v as number)),
  'E-LTE': (d, v) => !((d as number) > (v as number)),
  'E-GT': (d, v) => !((d as number) <= (v as number)),
  'E-GTE': (d, v) => !((d as number) < (v as number)),
  'E-VALID': (d) => !(d === null || isNaN(d as number)),
  'E-ONE': (d, v) => (v as unknown[]).indexOf(d) !== -1,
}

/** The tuple's i-th value with Dates turned into numbers, written back into the tuple (see the module comment). */
function numericValue(values: unknown[], i: number): unknown {
  const v = values[i]
  if (isDate(v)) return (values[i] = toNumber(v))
  if (isArray(v) && isDate(v[0])) return (values[i] = v.map(toNumber))
  return v
}

/** Does the datum satisfy every field constraint of the tuple? A field type nobody defined constrains nothing. */
function matches(datum: unknown, tuple: Row): boolean {
  const fields = tuple.fields as FieldDef[]
  const values = tuple.values as unknown[]
  for (let i = 0; i < fields.length; ++i) {
    const { read, test } = fieldTestOf(fields[i]!)
    const found = read(datum)
    const datumValue = isDate(found) ? toNumber(found) : found
    const value = numericValue(values, i)
    if (test && !test(datumValue, value)) return false
  }
  return true
}

// -- units ----------------------------------------------------------------------------------------------------------

interface UnitCounts {
  length: number
  first: unknown
  last: unknown
  counts: Map<unknown, number>
}
const unitCountCache = new WeakMap<readonly Row[], UnitCounts>()

/**
 * How many tuples each unit has. Kept per store array, and trusted only while the array has the length and end tuples
 * it was counted for: the incremental engine patches a store array in place.
 */
function countUnits(rows: readonly Row[]): Map<unknown, number> {
  const cached = unitCountCache.get(rows)
  if (cached && cached.length === rows.length && cached.first === rows[0] && cached.last === rows[rows.length - 1]) return cached.counts
  const counts = new Map<unknown, number>()
  for (const row of rows) counts.set(row.unit, (counts.get(row.unit) ?? 0) + 1)
  unitCountCache.set(rows, { length: rows.length, first: rows[0], last: rows[rows.length - 1], counts })
  return counts
}

/**
 * `vlSelectionTest`: is `datum` in the selection `rows` holds? `op` is `'intersect'` (the datum must match in every
 * unit; within a unit one tuple is enough) or anything else for a union (any tuple of any unit).
 */
export function selectionTest(rows: Rows, datum: unknown, op?: unknown): boolean | number {
  const tuples = rows ?? []
  if (op !== 'intersect') {
    for (const tuple of tuples) if (matches(datum, tuple)) return true
    return tuples.length ? false : 0
  }
  if (!rows) return 0

  const unitCounts = countUnits(rows)
  const matched = new Set<unknown>()
  const missed = new Map<unknown, number>()
  for (const tuple of tuples) {
    const unit = tuple.unit
    if (matched.has(unit)) continue
    if (matches(datum, tuple)) {
      if (unitCounts.size === 1) return true
      matched.add(unit)
    } else {
      const misses = (missed.get(unit) ?? 0) + 1
      if (misses === unitCounts.get(unit)) return false
      missed.set(unit, misses)
    }
  }
  return tuples.length ? true : 0
}

// -- testing by identifier --------------------------------------------------------------------------------------------

/** Three-way comparison where anything unordered (a missing value, NaN, mixed types) is `NaN`. */
function order(a: unknown, b: unknown): number {
  return a == null || b == null ? NaN : (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : (a as number) >= (b as number) ? 0 : NaN
}

/** First position in `rows` (sorted by identifier) whose identifier is not below `id`, or above it if `past`. */
function searchIds(rows: readonly Row[], id: unknown, past: boolean): number {
  let lo = 0
  let hi = rows.length
  if (order(id, id) !== 0) return hi
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const c = order(selectionIdOf(rows[mid]), id)
    if (past ? c <= 0 : c < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * `vlSelectionIdTest`: is the datum's `_vgsid_` one of the identifiers in `rows` (sorted by `_vgsid_`)? For
 * `'intersect'` the identifier must be there once for every unit.
 */
export function selectionIdTest(rows: Rows, datum: unknown, op?: unknown): boolean {
  const tuples = rows ?? []
  const id = selectionIdOf(datum)
  const first = searchIds(tuples, id, false)
  if (first === tuples.length || selectionIdOf(tuples[first]) !== id) return false
  if (op === 'intersect' && rows) {
    const units = countUnits(rows).size
    if (units === 1) return true
    if (searchIds(tuples, id, true) - first < units) return false
  }
  return true
}

// -- resolving --------------------------------------------------------------------------------------------------------

/**
 * Combines what has been collected so far with the next list. The accumulator is the resolve's own array (the first list
 * is always a copy of the tuple's), so a merge may grow it in place; only the result is used.
 */
type Merge = (accumulated: unknown[], next: unknown[]) => unknown[]

/** Union of enumerated values: `next`'s values that are not yet there are appended. */
const unionValues: Merge = (acc, next) => {
  if (!acc.length) return next
  for (const v of next) if (!acc.includes(v)) acc.push(v)
  return acc
}

const intersectValues: Merge = (acc, next) => (acc.length ? acc.filter((v) => next.includes(v)) : next)

/** `[lo, hi]` of a range given in either order; the order test is on numbers, the values kept are the ones given. */
function ascendingEnds(range: unknown[]): [unknown, unknown] {
  const lo = toNumber(range[0])
  const hi = toNumber(range[1])
  return (lo as number) > (hi as number) ? [range[1], range[0]] : [lo, hi]
}

const unionRanges: Merge = (acc, next) => {
  const [lo, hi] = ascendingEnds(next)
  if (!acc.length) return [lo, hi]
  if ((acc[0] as number) > (lo as number)) acc[0] = lo
  if ((acc[1] as number) < (hi as number)) acc[1] = hi
  return acc
}

const intersectRanges: Merge = (acc, next) => {
  const [lo, hi] = ascendingEnds(next)
  if (!acc.length) return [lo, hi]
  if ((hi as number) < (acc[0] as number) || (acc[1] as number) < (lo as number)) return []
  if ((acc[0] as number) < (lo as number)) acc[0] = lo
  if ((acc[1] as number) > (hi as number)) acc[1] = hi
  return acc
}

const MERGES: Record<string, Record<string, Merge>> = {
  E: { union: unionValues, intersect: intersectValues },
  R: { union: unionRanges, intersect: intersectRanges },
}

/** The merge for a field kind (the first letter of its type: `E` enumerated, `R` range) and a set operation. */
function mergeFor(kind: string, operation: string): Merge | undefined {
  const table = MERGES
  return Object.hasOwn(table, kind) && Object.hasOwn(table[kind]!, operation) ? table[kind]![operation] : undefined
}

/** Is `key` an array index (`'0'`, `'17'`, not `'01'`), which an object lists before its other keys? */
const isArrayIndex = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1

/** The keys in the order an object would list them: array indices ascending, then the rest as they were added. */
function objectOrder(keys: Iterable<string>): string[] {
  const indices: string[] = []
  const others: string[] = []
  for (const key of keys) (isArrayIndex(key) ? indices : others).push(key)
  return indices.sort((a, b) => Number(a) - Number(b)).concat(others)
}

/** The values of a map in `objectOrder` of its keys. */
const valuesInObjectOrder = <T>(map: Map<string, T>): T[] => objectOrder(map.keys()).map((key) => map.get(key)!)

/**
 * `vlSelectionResolve`: the selection as an object with, per field, the values (a list) or range (`[lo, hi]`) selected
 * over all units, combined by `op` (`union`, the default, or `intersect`). An extensional store resolves to the Set of
 * its identifiers under `_vgsid_`. With `isMulti` the tuples are also listed per unit under `vlPoint` (`vlMulti` unless
 * `vl5`), in the `{or: [...]}` / `{and: [{or: [...]}, ...]}` form of a Vega-Lite predicate.
 *
 * Units and fields are keys, so they are kept in maps (a unit or field called `__proto__` is just a name) and listed
 * the way an object would list them, which decides the order of the combined lists and of the result's keys.
 */
export function selectionResolve(rows: Rows, op?: unknown, isMulti?: unknown, vl5?: unknown): Record<string, unknown> {
  const operation = (op || 'union') as string
  /** per field, per unit: what that unit's tuples selected */
  const byField = new Map<string, Map<string, unknown[]>>()
  const kinds = new Map<string, string>()
  const perUnit = new Map<string, unknown[]>()
  const unitsOf = (name: string): Map<string, unknown[]> => {
    let units = byField.get(name)
    if (!units) byField.set(name, (units = new Map()))
    return units
  }
  const listOf = <T>(map: Map<string, T[]>, key: string): T[] => {
    let list = map.get(key)
    if (!list) map.set(key, (list = []))
    return list
  }

  for (const tuple of rows ?? []) {
    const unit = String(tuple.unit)
    const fields = tuple.fields as FieldDef[] | undefined
    const values = tuple.values as unknown[] | undefined
    if (fields && values) {
      fields.forEach((def, j) => {
        const units = unitsOf(def.field)
        const kind = def.type.charAt(0)
        kinds.set(def.field, kind)
        const union = mergeFor(kind, 'union')
        if (!union) throw new TypeError(`vlSelectionResolve: field type "${def.type}" cannot be combined`)
        units.set(unit, union(units.get(unit) ?? [], array(values[j])))
      })
      if (isMulti) {
        const entry: Record<string, unknown> = {}
        array(values).forEach((v, j) => {
          const name = fields[j]!.field
          // a field called __proto__ is data here, not a prototype
          if (name === '__proto__') Object.defineProperty(entry, name, { value: v, enumerable: true, writable: true, configurable: true })
          else entry[name] = v
        })
        listOf(perUnit, unit).push(entry)
      }
    } else {
      const id = selectionIdOf(tuple)
      listOf(unitsOf(SELECTION_ID), unit).push(id)
      if (isMulti) listOf(perUnit, unit).push({ [SELECTION_ID]: id })
    }
  }

  const resolved: Record<string, unknown> = {}
  const ids = byField.get(SELECTION_ID)
  if (ids) {
    const lists = valuesInObjectOrder(ids)
    if (operation === 'union') resolved[SELECTION_ID] = new Set(lists.flatMap((l) => [...l]))
    else if (operation === 'intersect') resolved[SELECTION_ID] = intersectSets(lists)
    else throw new TypeError(`vlSelectionResolve: unknown operation "${operation}"`)
    // fields beside the identifiers (a mixed store) are left as they were collected, unit by unit
    for (const [f, units] of byField) if (f !== SELECTION_ID) resolved[f] = Object.fromEntries(units)
  } else {
    for (const [f, units] of byField) {
      const merge = mergeFor(kinds.get(f)!, operation)
      resolved[f] = valuesInObjectOrder(units).reduce((acc, next) => {
        if (!merge) throw new TypeError(`vlSelectionResolve: unknown operation "${operation}"`)
        return merge(acc, next)
      })
    }
  }

  if (isMulti && perUnit.size) {
    const lists = valuesInObjectOrder(perUnit)
    resolved[vl5 ? 'vlPoint' : 'vlMulti'] = operation === 'union' ? { or: lists.flat() } : { and: lists.map((list) => ({ or: list })) }
  }
  return resolved
}

/** The members of the first list that every other list has too, in the first list's order. */
function intersectSets(lists: unknown[][]): Set<unknown> {
  const [first = [], ...rest] = lists
  const others = rest.map((l) => new Set(l))
  return new Set([...first].filter((v) => others.every((s) => s.has(v))))
}

/**
 * `vlSelectionTuples`: one tuple per scene item, `base` (the unit and fields) extended with the item's projected
 * `values`, or with its `_vgsid_` when `base` names no fields.
 */
export function selectionTuples(items: unknown, base: unknown): unknown[] {
  if (!isArray(items)) error('First argument to selectionTuples must be an array.')
  if (!isObject(base)) error('Second argument to selectionTuples must be an object.')
  const { fields } = base as { fields?: FieldDef[] }
  return (items as Array<{ datum?: unknown }>).map((item) =>
    extend(fields ? { values: fields.map((def) => valueOf(def, item.datum)) } : { [SELECTION_ID]: selectionIdOf(item.datum) }, base),
  )
}
