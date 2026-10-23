/**
 * The structural half of vega-parser that runs before any dataflow exists:
 *
 * - `normalizeSpecLists`: vega-parser reads every spec-level list through vega-util's
 *   `array()` (parsers/scope.js), so `data: {values: [...]}`, `marks: {type: 'rect'}` or
 *   `scales: {name: 'x'}` is the one-element list, not an error, and `null` is the empty list.
 * - `checkDataReferences`: `Scope.getData(name)` throws `Undefined data set name: "<name>"` when
 *   a data set is used before (or without) being declared in the scope chain. A parse error:
 *   nothing is drawn, exactly as with `vega.parse`.
 *
 * The limits pre-flight (limits.ts) reads the lists through `specList` so it counts what the
 * compiler will actually run.
 */
import { SpecParseError } from './parse-error.js'

/** vega-util `array()`: a non-array becomes the one-element list, `null`/`undefined` the empty list. */
export function specList(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value]
}

const SCOPE_LISTS = ['signals', 'projections', 'scales', 'data', 'axes', 'marks', 'legends'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A copy of `spec` whose scope lists (and those of every nested group) are real arrays; the very same
 * object when they all already are (the common case costs one walk over the mark tree).
 */
export function normalizeSpecLists<T extends Record<string, unknown>>(spec: T): T {
  let out: Record<string, unknown> | undefined
  for (const key of SCOPE_LISTS) {
    const v = spec[key]
    if (v === undefined) continue
    let next: unknown = v
    if (v === null || !Array.isArray(v)) next = specList(v)
    if (key === 'marks') {
      const list = next as unknown[]
      let marks: unknown[] | undefined
      for (let i = 0; i < list.length; i++) {
        const m = list[i]
        if (!isRecord(m)) continue
        const n = normalizeSpecLists(m)
        if (n !== m) (marks ??= list.slice())[i] = n
      }
      if (marks) next = marks
    }
    if (next !== v) (out ??= { ...spec })[key] = next
  }
  return (out ?? spec) as T
}

/** vega-util `stringValue`, as used in vega-parser's error messages. */
function stringValue(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(stringValue).join(',') + ']'
  if (x !== null && typeof x === 'object' || typeof x === 'string') {
    return String(JSON.stringify(x)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  }
  return String(x)
}

/** Data set names are object keys in vega-parser: `undefined`, numbers... all become strings. */
const key = (name: unknown): string => String(name)

type Names = Set<string>

function need(names: Names, name: unknown): void {
  if (!names.has(key(name))) throw new SpecParseError('Undefined data set name: ' + stringValue(name))
}

/** A mark's `from`: vega-parser `parseData` (parsers/marks/data.js) and `parseFacet`. */
function checkFrom(from: unknown, group: boolean, names: Names): void {
  if (!from) return
  const f = from as Record<string, unknown>
  const getDataRef = (d: Record<string, unknown>): void => {
    // an already-resolved reference (internal `$ref`) names no data set
    if (d.$ref) return
    const data = d.data
    if (data !== null && typeof data === 'object' && (data as Record<string, unknown>).$ref) return
    need(names, data)
  }
  const facet = f.facet as Record<string, unknown> | undefined
  if (facet) {
    if (!group) throw new SpecParseError('Only group marks can be faceted.')
    if (facet.field != null) getDataRef(facet)
    else if (!f.data) getDataRef(facet)
    else need(names, f.data)
    // parseFacet resolves the facet's own data again
    getDataRef(facet)
    return
  }
  getDataRef(f)
}

/** The data sets a transform names: `lookup.from` and the label transform's `avoidMarks`. */
function checkTransforms(transforms: unknown, names: Names): void {
  for (const t of specList(transforms)) {
    if (!isRecord(t)) continue
    if (t.type === 'lookup' && t.from !== undefined) {
      if (typeof t.from !== 'string') throw new SpecParseError('Lookup "from" parameter must be a string literal.')
      need(names, t.from)
    } else if (t.type === 'label') {
      for (const m of specList(t.avoidMarks)) need(names, m)
    }
  }
}

function checkScale(s: unknown, names: Names): void {
  if (!isRecord(s)) return
  const domain = s.domain
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) return
  const d = domain as Record<string, unknown>
  if (d.signal) return
  if (d.fields) {
    for (const f of specList(d.fields)) {
      if (typeof f === 'string') need(names, d.data)
      else if (Array.isArray(f) || (f as Record<string, unknown>)?.signal) continue
      else need(names, (f as Record<string, unknown> | null)?.data)
    }
  } else {
    need(names, d.data)
  }
}

/** One scope in vega-parser's order (parsers/scope.js): data, scales, marks (in order), then the rest. */
function checkScope(spec: Record<string, unknown>, parent: Names, seed?: string): void {
  const names: Names = new Set(parent)
  if (seed !== undefined) names.add(seed)
  for (const d of specList(spec.data)) {
    if (!isRecord(d)) continue
    // a derived data set names its sources; the data set itself exists only afterwards
    if (d.source !== undefined) for (const s of specList(d.source)) need(names, s)
    checkTransforms(d.transform, names)
    names.add(key(d.name))
  }
  for (const s of specList(spec.scales)) checkScale(s, names)
  for (const m of specList(spec.marks)) {
    if (!isRecord(m)) continue
    const group = m.type === 'group'
    checkFrom(m.from, group, names)
    checkTransforms(m.transform, names)
    if (group) {
      const facet = isRecord(m.from) && isRecord(m.from.facet) ? m.from.facet : undefined
      // a facet's name is a data set of the group's own scope; so are the group's `data`
      checkScope(m, names, facet ? key(facet.name) : undefined)
    }
    if (m.name != null) names.add(key(m.name))
  }
}

/** Throw `SpecParseError` for the first data set a spec uses without declaring (vega-parser `getData`). */
export function checkDataReferences(spec: Record<string, unknown>): void {
  checkScope(spec, new Set())
}
