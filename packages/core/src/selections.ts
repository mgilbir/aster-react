/**
 * Vega-Lite selection expression functions: a port of vega-selections 6.1.4
 * (`vlSelectionTest`, `vlSelectionIdTest`, `vlSelectionResolve`, `vlSelectionTuples`).
 *
 * A selection is stored as a dataset of tuples: `{unit, fields: [{field, type, ...}], values: [...]}`
 * for an intensional store (point / interval selections over fields), or `{unit, _vgsid_}` for an
 * extensional one (point selections over the identifier of each datum). The functions here read such a
 * dataset through `rows` (the dataset's rows AFTER its transforms: an extensional store is a
 * `collect` sorted by `_vgsid_`, which `vlSelectionIdTest` bisects).
 *
 * Differences from upstream, deliberate:
 *   - upstream reads `this.context.data[name]` and its `index:unit` operator; here the caller passes the rows
 *     and the unit index is derived from them (cached per rows array);
 *   - field getters are cached in a WeakMap instead of being written onto the field definition;
 *   - `d3-array`'s `union` / `intersection` are owned Set operations (the engine imports no d3).
 *
 * Everything else, including the in-place `Date -> number` coercion of tuple values that vega-selections
 * performs while testing, is the upstream behaviour (`selections` differential tests pin it).
 */
import { array, error, field, inrange, isArray, isDate, isObject, toNumber, extend } from './util.js'

export const SELECTION_ID = '_vgsid_'
const Intersect = 'intersect'
const Union = 'union'
const VlMulti = 'vlMulti'
const VlPoint = 'vlPoint'
const Or = 'or'
const And = 'and'

const TYPE_ENUM = 'E'
const TYPE_RANGE_INC = 'R'
const TYPE_RANGE_EXC = 'R-E'
const TYPE_RANGE_LE = 'R-LE'
const TYPE_RANGE_RE = 'R-RE'
const TYPE_PRED_LT = 'E-LT'
const TYPE_PRED_LTE = 'E-LTE'
const TYPE_PRED_GT = 'E-GT'
const TYPE_PRED_GTE = 'E-GTE'
const TYPE_PRED_VALID = 'E-VALID'
const TYPE_PRED_ONE_OF = 'E-ONE'

type Row = Record<string, unknown>
type Rows = readonly Row[] | undefined
interface FieldDef { field: string; type: string }

const selectionIdOf = field(SELECTION_ID)

const getters = new WeakMap<object, (d: unknown) => unknown>()
/** vega-selections `getter`: the accessor of a projected field, built once per field definition. */
function getter(f: FieldDef): (d: unknown) => unknown {
  let g = getters.get(f)
  if (!g) {
    g = field(f.field)
    getters.set(f, g)
  }
  return g
}

/** d3-array `ascending`: NaN for a missing or unordered pair. */
function ascending(a: unknown, b: unknown): number {
  const x = a as number
  const y = b as number
  return a == null || b == null ? NaN : x < y ? -1 : x > y ? 1 : x >= y ? 0 : NaN
}

// ----------------------------------------------------------------------------------------------------------
// vlSelectionTest

function testPoint(datum: unknown, entry: Row): boolean {
  const fields = entry.fields as FieldDef[]
  const values = entry.values as unknown[]
  const n = fields.length

  for (let i = 0; i < n; ++i) {
    const f = fields[i]!
    let dval = getter(f)(datum)

    if (isDate(dval)) dval = toNumber(dval)
    if (isDate(values[i])) values[i] = toNumber(values[i])
    const vi = values[i]
    if (isArray(vi) && isDate(vi[0])) values[i] = (vi as unknown[]).map(toNumber)

    const v = values[i]
    if (f.type === TYPE_ENUM) {
      // Enumerated fields can either specify individual values (single/multi selections)
      // or an array of values (interval selections).
      if (isArray(v) ? !v.includes(dval) : dval !== v) return false
    } else if (f.type === TYPE_RANGE_INC) {
      if (!inrange(dval, v as unknown[])) return false
    } else if (f.type === TYPE_RANGE_RE) {
      // Discrete selection of bins test within the range [bin_start, bin_end).
      if (!inrange(dval, v as unknown[], true, false)) return false
    } else if (f.type === TYPE_RANGE_EXC) {
      if (!inrange(dval, v as unknown[], false, false)) return false
    } else if (f.type === TYPE_RANGE_LE) {
      if (!inrange(dval, v as unknown[], false, true)) return false
    } else if (f.type === TYPE_PRED_LT) {
      if ((dval as number) >= (v as number)) return false
    } else if (f.type === TYPE_PRED_LTE) {
      if ((dval as number) > (v as number)) return false
    } else if (f.type === TYPE_PRED_GT) {
      if ((dval as number) <= (v as number)) return false
    } else if (f.type === TYPE_PRED_GTE) {
      if ((dval as number) < (v as number)) return false
    } else if (f.type === TYPE_PRED_VALID) {
      if (dval === null || isNaN(dval as number)) return false
    } else if (f.type === TYPE_PRED_ONE_OF) {
      if ((v as unknown[]).indexOf(dval) === -1) return false
    }
  }

  return true
}

/**
 * vega-selections' `index:unit` operator: per unit, how many tuples of the store carry it. Derived from the
 * rows on demand and cached per rows array; the cache entry is only trusted while the array still has the
 * length and the end tuples it was built for (an array patched in place by the incremental engine is rebuilt).
 */
const unitIndexes = new WeakMap<readonly Row[], { length: number; first: unknown; last: unknown; index: Map<unknown, { count: number }> }>()
function unitIndexOf(rows: readonly Row[]): Map<unknown, { count: number }> {
  const hit = unitIndexes.get(rows)
  if (hit && hit.length === rows.length && hit.first === rows[0] && hit.last === rows[rows.length - 1]) return hit.index
  const index = new Map<unknown, { count: number }>()
  for (const r of rows) {
    const e = index.get(r.unit)
    if (e) e.count++
    else index.set(r.unit, { count: 1 })
  }
  unitIndexes.set(rows, { length: rows.length, first: rows[0], last: rows[rows.length - 1], index })
  return index
}

/**
 * Tests whether `datum` is contained in the interactive selection stored in `rows`.
 * `op` is the set operation combining the units of the selection: `'intersect'`, or union (default).
 * With no tuples in the store nothing is selected (`0`, falsy), as upstream returns `n && intersect`.
 */
export function selectionTest(rows: Rows, datum: unknown, op?: unknown): boolean | number {
  const entries = rows ?? []
  const intersect = op === Intersect
  const unitIdx = intersect && rows ? unitIndexOf(rows) : undefined
  const n = entries.length
  let miss: Record<string, number> | undefined

  for (let i = 0; i < n; ++i) {
    const entry = entries[i]!
    let b: boolean

    if (unitIdx && intersect) {
      // multi selections union within the same unit and intersect across units.
      miss = miss || {}
      const unit = entry.unit as string
      let count = miss[unit] || 0

      // if we've already matched this unit, skip.
      if (count === -1) continue

      b = testPoint(datum, entry)
      miss[unit] = b ? -1 : ++count

      // if we match and there are no other units return true
      // if we've missed against all tuples in this unit return false
      if (b && unitIdx.size === 1) return true
      if (!b && count === unitIdx.get(unit)!.count) return false
    } else {
      b = testPoint(datum, entry)

      // if we find a miss and we do require intersection return false
      // if we find a match and we don't require intersection return true
      if ((intersect as unknown as number) ^ (b as unknown as number)) return b
    }
  }

  // if intersecting and we made it here, then we saw no misses
  // if not intersecting, then we saw no matches
  // if no active selections, return false
  return n && intersect
}

// ----------------------------------------------------------------------------------------------------------
// vlSelectionIdTest

/** d3-array `bisector(accessor)`'s `left`: the first index whose key is not below `x`. */
function bisectLeft(a: readonly Row[], x: unknown): number {
  let lo = 0
  let hi = a.length
  if (lo < hi) {
    if (ascending(x, x) !== 0) return hi
    do {
      const mid = (lo + hi) >>> 1
      if (ascending(selectionIdOf(a[mid]), x) < 0) lo = mid + 1
      else hi = mid
    } while (lo < hi)
  }
  return lo
}

/** d3-array `bisector(accessor)`'s `right`: the first index whose key is above `x`. */
function bisectRight(a: readonly Row[], x: unknown): number {
  let lo = 0
  let hi = a.length
  if (lo < hi) {
    if (ascending(x, x) !== 0) return hi
    do {
      const mid = (lo + hi) >>> 1
      if (ascending(selectionIdOf(a[mid]), x) <= 0) lo = mid + 1
      else hi = mid
    } while (lo < hi)
  }
  return lo
}

/**
 * Tests whether `datum` (by its `_vgsid_`) is contained in an extensional selection store. `rows` must be
 * sorted by `_vgsid_`, which is what the `collect` transform of such a store does.
 */
export function selectionIdTest(rows: Rows, datum: unknown, op?: unknown): boolean {
  const entries = rows ?? []
  const intersect = op === Intersect
  const unitIdx = intersect && rows ? unitIndexOf(rows) : undefined
  const value = selectionIdOf(datum)
  const index = bisectLeft(entries, value)

  if (index === entries.length) return false
  if (selectionIdOf(entries[index]) !== value) return false

  if (unitIdx && intersect) {
    if (unitIdx.size === 1) return true
    if (bisectRight(entries, value) - index < unitIdx.size) return false
  }

  return true
}

// ----------------------------------------------------------------------------------------------------------
// vlSelectionResolve

/** d3-array `union`: the distinct values of every iterable, first-seen order. */
function setUnion(...iterables: Iterable<unknown>[]): Set<unknown> {
  const set = new Set<unknown>()
  for (const it of iterables) for (const v of it) set.add(v)
  return set
}

/** d3-array `intersection`: the values of the first iterable that are in every other one. */
function setIntersection(values: Iterable<unknown>, ...others: Iterable<unknown>[]): Set<unknown> {
  const set = new Set<unknown>(values)
  const sets = others.map((o) => (o instanceof Set ? o : new Set(o)))
  out: for (const v of set) {
    for (const o of sets) {
      if (!o.has(v)) {
        set.delete(v)
        continue out
      }
    }
  }
  return set
}

type SetOp = (base: any, value: any) => any

const ops: Record<string, (...args: any[]) => any> = {
  [`${SELECTION_ID}_union`]: setUnion,
  [`${SELECTION_ID}_intersect`]: setIntersection,

  E_union: ((base: unknown[], value: unknown[]) => {
    if (!base.length) return value

    for (let i = 0, n = value.length; i < n; ++i) if (!base.includes(value[i])) base.push(value[i])
    return base
  }) as SetOp,

  E_intersect: ((base: unknown[], value: unknown[]) => (!base.length ? value : base.filter((v) => value.includes(v)))) as SetOp,

  R_union: ((base: unknown[], value: unknown[]) => {
    let lo: unknown = toNumber(value[0])
    let hi: unknown = toNumber(value[1])
    if ((lo as number) > (hi as number)) {
      lo = value[1]
      hi = value[0]
    }

    if (!base.length) return [lo, hi]
    if ((base[0] as number) > (lo as number)) base[0] = lo
    if ((base[1] as number) < (hi as number)) base[1] = hi
    return base
  }) as SetOp,

  R_intersect: ((base: unknown[], value: unknown[]) => {
    let lo: unknown = toNumber(value[0])
    let hi: unknown = toNumber(value[1])
    if ((lo as number) > (hi as number)) {
      lo = value[1]
      hi = value[0]
    }

    if (!base.length) return [lo, hi]
    if ((hi as number) < (base[0] as number) || (base[1] as number) < (lo as number)) {
      return []
    } else {
      if ((base[0] as number) < (lo as number)) base[0] = lo
      if ((base[1] as number) > (hi as number)) base[1] = hi
    }
    return base
  }) as SetOp,
}

/**
 * Resolves a selection for use as a scale domain or reads it via the API: an object of selected fields and
 * values. `isMulti` marks a "multi" (point) selection, which also yields its per-unit entries under `vlPoint`
 * (`vlMulti` when `vl5` is falsy).
 */
export function selectionResolve(rows: Rows, op?: unknown, isMulti?: unknown, vl5?: unknown): Record<string, unknown> {
  const entries = rows ?? []
  const resolved: Record<string, any> = {}
  const multiRes: Record<string, any[]> = {}
  const types: Record<string, string> = {}
  const n = entries.length

  // First union all entries within the same unit.
  for (let i = 0; i < n; ++i) {
    const entry = entries[i]!
    const unit = entry.unit as string
    const fields = entry.fields as FieldDef[] | undefined
    const values = entry.values as unknown[] | undefined

    if (fields && values) {
      // Intentional selection stores
      for (let j = 0, m = fields.length; j < m; ++j) {
        const f = fields[j]!
        const res = resolved[f.field] || (resolved[f.field] = {})
        const resUnit = res[unit] || (res[unit] = [])
        const type = (types[f.field] = f.type.charAt(0))
        const union = ops[`${type}_union`]!
        res[unit] = union(resUnit, array(values[j]))
      }

      // If the same multi-selection is repeated over views and projected over
      // an encoding, it may operate over different fields making it especially
      // tricky to reliably resolve it. At best, we can de-dupe identical entries
      // but doing so may be more computationally expensive than it is worth.
      // Instead, for now, we simply transform our store representation into
      // a more human-friendly one.
      if (isMulti) {
        const resUnit = multiRes[unit] || (multiRes[unit] = [])
        resUnit.push(array(values).reduce((obj: Record<string, unknown>, curr, j) => ((obj[fields[j]!.field] = curr), obj), {}))
      }
    } else {
      // Short circuit extensional selectionId stores which hold sorted IDs unique to each unit.
      const value = selectionIdOf(entry)
      const res = resolved[SELECTION_ID] || (resolved[SELECTION_ID] = {})
      const resUnit = res[unit] || (res[unit] = [])
      resUnit.push(value)

      if (isMulti) {
        const mu = multiRes[unit] || (multiRes[unit] = [])
        mu.push({ [SELECTION_ID]: value })
      }
    }
  }

  // Then resolve fields across units as per the op.
  const operation = (op || Union) as string
  if (resolved[SELECTION_ID]) {
    resolved[SELECTION_ID] = (ops[`${SELECTION_ID}_${operation}`] as (...a: unknown[]) => unknown)(...Object.values(resolved[SELECTION_ID]))
  } else {
    for (const f of Object.keys(resolved)) {
      resolved[f] = Object.keys(resolved[f])
        .map((unit) => resolved[f][unit])
        .reduce((acc, curr) => (acc === undefined ? curr : (ops[`${types[f]}_${operation}`] as SetOp)(acc, curr)))
    }
  }

  const units = Object.keys(multiRes)
  if (isMulti && units.length) {
    const key = vl5 ? VlPoint : VlMulti
    resolved[key] = operation === Union
      ? { [Or]: units.reduce((acc: unknown[], k) => { for (const e of multiRes[k]!) acc.push(e); return acc }, []) }
      : { [And]: units.map((k) => ({ [Or]: multiRes[k] })) }
  }

  return resolved
}

// ----------------------------------------------------------------------------------------------------------
// vlSelectionTuples

/**
 * Maps an array of scene graph items to an array of selection tuples (`base` extended with the projected
 * `values`, or with the item's `_vgsid_` for an extensional selection).
 */
export function selectionTuples(items: unknown, base: unknown): unknown[] {
  if (!isArray(items)) {
    error('First argument to selectionTuples must be an array.')
  }
  if (!isObject(base)) {
    error('Second argument to selectionTuples must be an object.')
  }
  const b = base as { fields?: FieldDef[] }
  return (items as Array<{ datum?: unknown }>).map((x) =>
    extend(
      b.fields ? { values: b.fields.map((f) => getter(f)(x.datum)) } : { [SELECTION_ID]: selectionIdOf(x.datum) },
      b,
    ),
  )
}
