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

const accessors = new WeakMap<object, (d: unknown) => unknown>()
/** The accessor of a tuple's field definition, made once per definition. */
function valueOf(def: FieldDef, datum: unknown): unknown {
  let read = accessors.get(def)
  if (!read) accessors.set(def, (read = field(def.field)))
  return read(datum)
}

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
    const def = fields[i]!
    const read = valueOf(def, datum)
    const datumValue = isDate(read) ? toNumber(read) : read
    const test = POINT_TESTS[def.type]
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

type Merge = (accumulated: unknown[], next: unknown[]) => unknown[]

/** Union of enumerated values: `next`'s values that are not yet there are appended. */
const unionValues: Merge = (acc, next) => {
  if (!acc.length) return next
  const out = acc.slice()
  for (const v of next) if (!out.includes(v)) out.push(v)
  return out
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
  const out = acc.slice()
  if ((out[0] as number) > (lo as number)) out[0] = lo
  if ((out[1] as number) < (hi as number)) out[1] = hi
  return out
}

const intersectRanges: Merge = (acc, next) => {
  const [lo, hi] = ascendingEnds(next)
  if (!acc.length) return [lo, hi]
  if ((hi as number) < (acc[0] as number) || (acc[1] as number) < (lo as number)) return []
  const out = acc.slice()
  if ((out[0] as number) < (lo as number)) out[0] = lo
  if ((out[1] as number) > (hi as number)) out[1] = hi
  return out
}

/** The merge for a field kind (the first letter of its type: `E` enumerated, `R` range) and a set operation. */
function mergeFor(kind: string, operation: string): Merge | undefined {
  const table: Record<string, Record<string, Merge>> = {
    E: { union: unionValues, intersect: intersectValues },
    R: { union: unionRanges, intersect: intersectRanges },
  }
  return Object.hasOwn(table, kind) && Object.hasOwn(table[kind]!, operation) ? table[kind]![operation] : undefined
}

/** A dictionary whose keys are all data: units and field names come from specs. */
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

/**
 * `vlSelectionResolve`: the selection as an object with, per field, the values (a list) or range (`[lo, hi]`) selected
 * over all units, combined by `op` (`union`, the default, or `intersect`). An extensional store resolves to the Set of
 * its identifiers under `_vgsid_`. With `isMulti` the tuples are also listed per unit under `vlPoint` (`vlMulti` unless
 * `vl5`), in the `{or: [...]}` / `{and: [{or: [...]}, ...]}` form of a Vega-Lite predicate.
 */
export function selectionResolve(rows: Rows, op?: unknown, isMulti?: unknown, vl5?: unknown): Record<string, unknown> {
  const operation = (op || 'union') as string
  /** per field, per unit: what that unit's tuples selected */
  const byField = dictionary<Record<string, unknown[]>>()
  const kinds = dictionary<string>()
  const perUnit = dictionary<unknown[]>()

  for (const tuple of rows ?? []) {
    const unit = tuple.unit as string
    const fields = tuple.fields as FieldDef[] | undefined
    const values = tuple.values as unknown[] | undefined
    if (fields && values) {
      fields.forEach((def, j) => {
        const units = byField[def.field] ?? (byField[def.field] = dictionary())
        const kind = (kinds[def.field] = def.type.charAt(0))
        const union = mergeFor(kind, 'union')
        if (!union) throw new TypeError(`vlSelectionResolve: field type "${def.type}" cannot be combined`)
        units[unit] = union(units[unit] ?? [], array(values[j]))
      })
      if (isMulti) (perUnit[unit] ??= []).push(Object.fromEntries(array(values).map((v, j) => [fields[j]!.field, v])))
    } else {
      const id = selectionIdOf(tuple)
      const units = byField[SELECTION_ID] ?? (byField[SELECTION_ID] = dictionary())
      ;(units[unit] ??= []).push(id)
      if (isMulti) (perUnit[unit] ??= []).push({ [SELECTION_ID]: id })
    }
  }

  const resolved: Record<string, unknown> = {}
  if (byField[SELECTION_ID]) {
    const lists = Object.values(byField[SELECTION_ID])
    if (operation === 'union') resolved[SELECTION_ID] = new Set(lists.flatMap((l) => [...l]))
    else if (operation === 'intersect') resolved[SELECTION_ID] = intersectSets(lists)
    else throw new TypeError(`vlSelectionResolve: unknown operation "${operation}"`)
    for (const f of Object.keys(byField)) if (f !== SELECTION_ID) resolved[f] = byField[f]
  } else {
    for (const f of Object.keys(byField)) {
      const merge = mergeFor(kinds[f]!, operation)
      resolved[f] = Object.values(byField[f]!).reduce((acc, next) => {
        if (!merge) throw new TypeError(`vlSelectionResolve: unknown operation "${operation}"`)
        return merge(acc, next)
      })
    }
  }

  const units = Object.keys(perUnit)
  if (isMulti && units.length) {
    resolved[vl5 ? 'vlPoint' : 'vlMulti'] = operation === 'union'
      ? { or: units.flatMap((u) => perUnit[u]!) }
      : { and: units.map((u) => ({ or: perUnit[u] })) }
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
