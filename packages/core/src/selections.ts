/**
 * Vega-Lite's selection functions: a port of vega-selections (`vlSelectionTest`, `vlSelectionIdTest`,
 * `vlSelectionResolve`, `vlSelectionTuples`), which vega-functions registers as expression functions.
 *
 * A selection is a dataset (its "store") of tuples `{unit, fields, values}` (an "intentional" selection: the
 * fields' values or ranges the selection covers) or `{unit, _vgsid_}` (an "extensional" one: the ids of the
 * selected rows). The functions read the store's rows; where the rows come from is the caller's business (the
 * expression runtime's `data(name)`), as vega's `this.context.data[name]` is.
 */
import { isArray, isDate, toNumber, isObject } from './util.js'
import { fieldOf } from './transform-agg.js'

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

/** vega-util `inrange`: `value` within the range's first and last values, each end inclusive unless told otherwise. */
function inrange(value: number, range: number[], left?: boolean, right?: boolean): boolean {
  let r0 = range[0]!
  let r1 = range[range.length - 1]!
  if (r0 > r1) {
    const t = r0
    r0 = r1
    r1 = t
  }
  const l = left === undefined || left
  const r = right === undefined || right
  return (l ? r0 <= value : r0 < value) && (r ? value <= r1 : value < r1)
}

const Intersect = 'intersect'
const Union = 'union'
const VlMulti = 'vlMulti'
const VlPoint = 'vlPoint'
const Or = 'or'
const And = 'and'

export const SelectionId = '_vgsid_'
const $selectionId = fieldOf(SelectionId)

type Entry = { unit?: unknown; fields?: Array<{ field: string; type: string }>; values?: unknown[]; [k: string]: unknown }

const asEntries = (rows: unknown[] | undefined): Entry[] => (rows ?? []) as Entry[]
const getter = (f: { field: string }): ((d: unknown) => unknown) => fieldOf(f.field) as (d: unknown) => unknown

// TODO(vega): revisit date coercion?
function testPoint(datum: unknown, entry: Entry): boolean {
  const fields = entry.fields!
  const values = entry.values!
  const n = fields.length
  for (let i = 0; i < n; ++i) {
    const f = fields[i]!
    let dval = getter(f)(datum) as never as number
    if (isDate(dval)) dval = toNumber(dval) as number
    if (isDate(values[i])) values[i] = toNumber(values[i])
    if (isArray(values[i]) && isDate((values[i] as unknown[])[0])) values[i] = (values[i] as unknown[]).map(toNumber)

    if (f.type === TYPE_ENUM) {
      // Enumerated fields can either specify individual values (single/multi selections)
      // or an array of values (interval selections).
      if (isArray(values[i]) ? !(values[i] as unknown[]).includes(dval) : dval !== values[i]) return false
    } else if (f.type === TYPE_RANGE_INC) {
      if (!inrange(dval, values[i] as number[])) return false
    } else if (f.type === TYPE_RANGE_RE) {
      // Discrete selection of bins test within the range [bin_start, bin_end).
      if (!inrange(dval, values[i] as number[], true, false)) return false
    } else if (f.type === TYPE_RANGE_EXC) {
      // 'R-E'/'R-LE' included for completeness.
      if (!inrange(dval, values[i] as number[], false, false)) return false
    } else if (f.type === TYPE_RANGE_LE) {
      if (!inrange(dval, values[i] as number[], false, true)) return false
    } else if (f.type === TYPE_PRED_LT) {
      if (dval >= (values[i] as number)) return false
    } else if (f.type === TYPE_PRED_LTE) {
      if (dval > (values[i] as number)) return false
    } else if (f.type === TYPE_PRED_GT) {
      if (dval <= (values[i] as number)) return false
    } else if (f.type === TYPE_PRED_GTE) {
      if (dval < (values[i] as number)) return false
    } else if (f.type === TYPE_PRED_VALID) {
      if ((dval as unknown) === null || isNaN(dval)) return false
    } else if (f.type === TYPE_PRED_ONE_OF) {
      if ((values[i] as unknown[]).indexOf(dval) === -1) return false
    }
  }
  return true
}

/** vega's `data[UNIT_INDEX]`: how many tuples each unit has in the store (an Index transform over `unit`). */
function unitIndex(entries: Entry[]): Map<unknown, { count: number }> {
  const m = new Map<unknown, { count: number }>()
  for (const e of entries) {
    const c = m.get(e.unit)
    if (c) c.count++
    else m.set(e.unit, { count: 1 })
  }
  return m
}

/**
 * Tests if a tuple is contained within an interactive selection.
 * @param rows the rows of the dataset representing the selection
 * @param datum the tuple to test for inclusion
 * @param op the set operation for combining selections: 'intersect' or 'union' (default)
 * @returns true if the datum is in the selection (vega returns `n && intersect` when nothing decided: falsy)
 */
export function selectionTest(rows: unknown[] | undefined, datum: unknown, op?: string): unknown {
  const entries = asEntries(rows)
  const intersect = op === Intersect
  const unitIdx = intersect && entries.length ? unitIndex(entries) : undefined
  const n = entries.length
  let miss: Record<string, number> | undefined
  for (let i = 0; i < n; ++i) {
    const entry = entries[i]!
    let b: boolean
    if (unitIdx && intersect) {
      // multi selections union within the same unit and intersect across units.
      miss = miss || {}
      const unit = String(entry.unit)
      let count = miss[unit] || 0
      // if we've already matched this unit, skip.
      if (count === -1) continue
      b = testPoint(datum, entry)
      miss[unit] = b ? -1 : ++count
      // if we match and there are no other units return true
      // if we've missed against all tuples in this unit return false
      if (b && unitIdx.size === 1) return true
      if (!b && count === unitIdx.get(entry.unit)!.count) return false
    } else {
      b = testPoint(datum, entry)
      // if we find a miss and we do require intersection return false
      // if we find a match and we don't require intersection return true
      if (Boolean(intersect) !== b) return b
    }
  }
  // if intersecting and we made it here, then we saw no misses
  // if not intersecting, then we saw no matches
  // if no active selections, return false
  return n && intersect
}

function lowerBound(entries: Entry[], value: unknown): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((($selectionId(entries[mid]) as never) as number) < (value as number)) lo = mid + 1
    else hi = mid
  }
  return lo
}
function upperBound(entries: Entry[], value: unknown): number {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((value as number) < (($selectionId(entries[mid]) as never) as number)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Tests an extensional selection: is the datum's `_vgsid_` among the (sorted) ids the store holds. */
export function selectionIdTest(rows: unknown[] | undefined, datum: unknown, op?: string): boolean {
  const entries = asEntries(rows)
  const intersect = op === Intersect
  const unitIdx = intersect && entries.length ? unitIndex(entries) : undefined
  const value = $selectionId(datum)
  const index = lowerBound(entries, value)
  if (index === entries.length) return false
  if ($selectionId(entries[index]) !== value) return false
  if (unitIdx && intersect) {
    if (unitIdx.size === 1) return true
    if (upperBound(entries, value) - index < unitIdx.size) return false
  }
  return true
}

type Resolved = Record<string, unknown>

const setOps: Record<string, (base: unknown[], value: unknown[]) => unknown[]> = {
  E_union(base, value) {
    if (!base.length) return value
    for (let i = 0, n = value.length; i < n; ++i) if (!base.includes(value[i])) base.push(value[i])
    return base
  },
  E_intersect(base, value) {
    return !base.length ? value : base.filter((v) => value.includes(v))
  },
  R_union(base, value) {
    let lo = toNumber(value[0]) as number
    let hi = toNumber(value[1]) as number
    if (lo > hi) {
      lo = value[1] as number
      hi = value[0] as number
    }
    if (!base.length) return [lo, hi]
    if ((base[0] as number) > lo) base[0] = lo
    if ((base[1] as number) < hi) base[1] = hi
    return base
  },
  R_intersect(base, value) {
    let lo = toNumber(value[0]) as number
    let hi = toNumber(value[1]) as number
    if (lo > hi) {
      lo = value[1] as number
      hi = value[0] as number
    }
    if (!base.length) return [lo, hi]
    if (hi < (base[0] as number) || (base[1] as number) < lo) return []
    if ((base[0] as number) < lo) base[0] = lo
    if ((base[1] as number) > hi) base[1] = hi
    return base
  },
}

/** d3-array `union` / `intersection` over the per-unit id lists (the extensional resolve). */
const idUnion = (...lists: unknown[][]): Set<unknown> => new Set(lists.flat())
const idIntersection = (...lists: unknown[][]): Set<unknown> => {
  const [first = [], ...rest] = lists
  const out = new Set(first)
  for (const v of out) if (!rest.every((l) => l.includes(v))) out.delete(v)
  return out
}

/** vega-util `array`: a value as a list (null and undefined are the empty list). */
const entryRows = (v: unknown): unknown[] => (v == null ? [] : isArray(v) ? (v as unknown[]) : [v])

/**
 * Resolves selection for use as a scale domain or reads via the API.
 * @param rows the rows of the dataset representing the selection
 * @param op the set operation for combining selections: 'intersect' or 'union' (default)
 * @param isMulti identifies a "multi" selection to perform more expensive resolution computation
 * @param vl5 with Vega-Lite v5, "multi" selections are called "point" selections: the resolved tuple reflects that name
 * @returns an object of selected fields and values
 */
export function selectionResolve(rows: unknown[] | undefined, op?: string, isMulti?: boolean, vl5?: boolean): Resolved {
  // vega-selections unions into the value lists of the store's own tuples (so a later call, or the multi branch of this
  // one, sees values a previous union pushed): the lists are copied, so a call is a function of the store alone. Within
  // a call the mutation is kept, as it decides the `vlMulti` / `vlPoint` result.
  const entries = asEntries(rows).map((e) => (e.values ? { ...e, values: e.values.map((v) => (isArray(v) ? (v as unknown[]).slice() : v)) } : e))
  const resolved: Record<string, Record<string, unknown[]>> = {}
  const multiRes: Record<string, unknown[]> = {}
  const types: Record<string, string> = {}
  const out: Resolved = {}

  // First union all entries within the same unit.
  for (const entry of entries) {
    const unit = String(entry.unit)
    const fields = entry.fields
    const values = entry.values
    if (fields && values) {
      // Intentional selection stores
      for (let j = 0, m = fields.length; j < m; ++j) {
        const field = fields[j]!
        const res = resolved[field.field] || (resolved[field.field] = {})
        const resUnit = res[unit] || (res[unit] = [])
        const type = (types[field.field] = field.type.charAt(0))
        res[unit] = setOps[`${type}_union`]!(resUnit, entryRows(values[j]))
      }
      // If the same multi-selection is repeated over views and projected over an encoding, it may operate over
      // different fields making it especially tricky to reliably resolve it. At best, we can de-dupe identical
      // entries but doing so may be more computationally expensive than it is worth. Instead, for now, we simply
      // transform our store representation into a more human-friendly one.
      if (isMulti) {
        const resUnit = multiRes[unit] || (multiRes[unit] = [])
        resUnit.push(entryRows(values).reduce<Record<string, unknown>>((obj, curr, j) => ((obj[fields[j]!.field] = curr), obj), {}))
      }
    } else {
      // Short circuit extensional selectionId stores which hold sorted IDs unique to each unit.
      const res = resolved[SelectionId] || (resolved[SelectionId] = {})
      const resUnit = res[unit] || (res[unit] = [])
      resUnit.push($selectionId(entry))
      if (isMulti) {
        const mu = multiRes[unit] || (multiRes[unit] = [])
        mu.push({ [SelectionId]: $selectionId(entry) })
      }
    }
  }

  // Then resolve fields across units as per the op.
  const o = op || Union
  if (resolved[SelectionId]) {
    // (vega: only the ids are resolved; any intentional fields in the same store stay as their per-unit lists)
    Object.assign(out, resolved)
    const lists = Object.values(resolved[SelectionId]!)
    out[SelectionId] = o === Intersect ? idIntersection(...lists) : idUnion(...lists)
  } else {
    for (const field of Object.keys(resolved)) {
      out[field] = Object.keys(resolved[field]!)
        .map((unit) => resolved[field]![unit]!)
        .reduce<unknown[] | undefined>((acc, curr) => (acc === undefined ? curr : setOps[`${types[field]}_${o}`]!(acc, curr)), undefined)
    }
  }

  const units = Object.keys(multiRes)
  if (isMulti && units.length) {
    const key = vl5 ? VlPoint : VlMulti
    out[key] = o === Union
      ? { [Or]: units.reduce<unknown[]>((acc, k) => { for (const x of multiRes[k]!) acc.push(x); return acc }, []) }
      : { [And]: units.map((k) => ({ [Or]: multiRes[k] })) }
  }
  return out
}

/**
 * Maps an array of scene graph items to an array of selection tuples.
 * @param array input scene graph items
 * @param base the base object that generated tuples extend
 */
export function selectionTuples(array: unknown, base: unknown): unknown[] {
  if (!isArray(array)) throw new Error('First argument to selectionTuples must be an array.')
  if (!isObject(base)) throw new Error('Second argument to selectionTuples must be an object.')
  const b = base as { fields?: Array<{ field: string }> } & Record<string, unknown>
  return (array as Array<{ datum?: unknown }>).map((x) => Object.assign(
    b.fields ? { values: b.fields.map((f) => getter(f)(x.datum)) } : { [SelectionId]: $selectionId(x.datum) },
    b,
  ))
}
