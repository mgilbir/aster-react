/**
 * The structural half of vega-parser that runs before any dataflow exists:
 *
 * - `normalizeSpecLists`: vega-parser reads every spec-level list through vega-util's
 *   `array()` (parsers/scope.js), so `data: {values: [...]}`, `marks: {type: 'rect'}` or
 *   `scales: {name: 'x'}` is the one-element list, not an error, and `null` is the empty list.
 * - `checkDataReferences`: `Scope.getData(name)` throws `Undefined data set name: "<name>"` when
 *   a data set is used before (or without) being declared in the scope chain, and `Scope.addData`
 *   throws `Duplicate data set name: "<name>"` for a name the SAME scope already owns. A parse error:
 *   nothing is drawn, exactly as with `vega.parse`. The walk follows vega-parser's own order and its
 *   scoping: what registers a data set (data, named marks, a facet's name, the root's `root`, and every
 *   named mark a guide is made of) and which of those get a scope of their own.
 *
 * The limits pre-flight (limits.ts) reads the lists through `specList` so it counts what the
 * compiler will actually run.
 */
import { SpecParseError } from './parse-error.js'
import { mergeVegaConfig, vegaDefaultConfig } from './config-defaults.js'

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

/**
 * The data sets and scales one scope of vega-parser knows (`Scope.data`, `Scope.scales`). A nested scope is
 * `Object.create(parent)` upstream: it SEES its parents' names but only OWNS its own, and `addData` refuses a
 * name the scope already owns (`hasOwnProperty(this.data, name)`), so a group may shadow a parent's name but
 * not repeat its own.
 */
class Names {
  private readonly own = new Set<string>()
  private readonly types = new Map<string, string>()
  constructor(private readonly parent?: Names) {}

  has(name: unknown): boolean {
    const k = key(name)
    for (let s: Names | undefined = this; s; s = s.parent) if (s.own.has(k)) return true
    return false
  }

  /** `Scope.addData`: `Duplicate data set name: "<name>"` for a name this very scope owns. */
  declare(name: unknown): void {
    const k = key(name)
    // (`data['__proto__'] = ...` sets the prototype upstream and creates no own property, so it can repeat)
    if (this.own.has(k) && k !== '__proto__') throw new SpecParseError('Duplicate data set name: ' + stringValue(name))
    this.own.add(k)
  }

  addScale(name: unknown, type: unknown): void { this.types.set(key(name), type ? String(type) : 'linear') }

  /** the type of the innermost scale of that name (undefined when there is none) */
  scaleType(name: unknown): string | undefined {
    const k = key(name)
    for (let s: Names | undefined = this; s; s = s.parent) {
      const t = s.types.get(k)
      if (t !== undefined) return t
    }
    return undefined
  }
}

function need(names: Names, name: unknown): void {
  if (!names.has(name)) throw new SpecParseError('Undefined data set name: ' + stringValue(name))
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

/** vega-parser `guideMark(mark, extras)` + `parseMark`: a guide's child mark is a data set when its user encode names it. */
function declareGuideMark(names: Names, extras: unknown): void {
  if (extras && typeof extras === 'object') {
    const name = (extras as { name?: unknown }).name
    if (name != null) names.declare(name)
  }
}

/**
 * vega-scale's `isContinuous` / `isDiscretizing` (the scale registry's metadata), restated here because this module
 * must not import `scale.ts`: `limits.ts` reaches it, and scale.ts reaches `limits.ts`. A test pins both lists to the registry.
 */
export const CONTINUOUS_SCALE_TYPES: ReadonlySet<string> = new Set([
  'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc',
  'sequential', 'sequential-linear', 'sequential-log', 'sequential-pow', 'sequential-sqrt', 'sequential-symlog',
  'diverging-linear', 'diverging-log', 'diverging-pow', 'diverging-sqrt', 'diverging-symlog',
])
export const DISCRETIZING_SCALE_TYPES: ReadonlySet<string> = new Set(['quantile', 'quantize', 'threshold', 'bin-ordinal'])

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
const hasKey = (o: unknown, k: string): boolean => isRecord(o) && Object.hasOwn(o, k)
const isSignalObject = (v: unknown): boolean => isRecord(v) && !!v.signal

/** vega-parser `lookup(spec, config)(name)` over `axisConfig`: whether the axis feature `name` is on (the guide marks it is made of). */
function axisFlag(a: Record<string, unknown>, name: string, names: Names, cfg: Record<string, unknown>): boolean {
  if (a[name] != null) return !!a[name]
  const axis = rec(cfg.axis)
  const orient = a.orient
  const band = names.scaleType(a.scale) === 'band' && isRecord(cfg.axisBand) ? cfg.axisBand : undefined
  let merged: unknown
  if (isSignalObject(orient)) {
    // an orient signal turns every key the x/y or orient blocks name into an expression (a signal object: truthy)
    const named = (...blocks: unknown[]): boolean => blocks.some((b) => hasKey(b, name))
    merged = hasKey(band, name) ? (band as Record<string, unknown>)[name]
      : named(cfg.axisTop, cfg.axisBottom, cfg.axisLeft, cfg.axisRight) || named(cfg.axisX, cfg.axisY) ? { signal: '' }
      : axis[name]
  } else {
    const o = String(orient ?? '')
    const xy = o === 'top' || o === 'bottom' ? cfg.axisX : cfg.axisY
    const or = cfg['axis' + o.charAt(0).toUpperCase() + o.slice(1)]
    const block = [band, or, xy, axis].find((b) => hasKey(b, name))
    merged = block === undefined ? undefined : (block as Record<string, unknown>)[name]
  }
  return !!merged
}

/** vega-parser `parseAxis`: the guide marks the axis is made of (grid, ticks, labels, domain, title), then the axis group. */
function parseAxisNames(a: unknown, names: Names, cfg: () => Record<string, unknown>): void {
  if (!isRecord(a)) return
  const encode = rec(a.encode)
  // (the marks of an axis are named by its encode blocks alone: none, nothing to declare)
  if (!Object.keys(encode).length) return
  const c = cfg()
  const flags: Array<[string, boolean]> = [
    ['grid', axisFlag(a, 'grid', names, c)],
    ['ticks', axisFlag(a, 'ticks', names, c)],
    ['labels', axisFlag(a, 'labels', names, c)],
    ['domain', axisFlag(a, 'domain', names, c)],
    ['title', a.title != null],
  ]
  for (const [child, on] of flags) if (on) declareGuideMark(names, encode[child])
  const name = rec(encode.axis).name || undefined
  if (name != null) names.declare(name)
}

/** vega-parser `parseLegend`: which marks a legend is made of depends on its type, and a symbol legend nests two scopes. */
function parseLegendNames(l: unknown, names: Names): void {
  if (!isRecord(l)) return
  const encode = rec(l.encode)
  // (the marks of a legend are named by its encode blocks alone: none, nothing to declare)
  if (!Object.keys(encode).length) return
  // the canonical scale: the first channel in LegendScales order
  const channels = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity']
  const scale = channels.map((c) => l[c]).find((s) => !!s)
  const scaleType = scale ? names.scaleType(scale) : undefined
  const present = channels.filter((c) => !!l[c]).length
  let type = typeof l.type === 'string' && l.type ? l.type : 'symbol'
  if (!l.type && present === 1 && (l.fill || l.stroke)) {
    type = scaleType && CONTINUOUS_SCALE_TYPES.has(scaleType) ? 'gradient' : scaleType && DISCRETIZING_SCALE_TYPES.has(scaleType) ? 'discrete' : 'symbol'
  }
  if (type === 'gradient' && scaleType && DISCRETIZING_SCALE_TYPES.has(scaleType)) type = 'discrete'
  if (type === 'gradient' || type === 'discrete') {
    // the entry group has no layout of its own: its marks are parsed in the legend's scope
    declareGuideMark(names, encode.gradient)
    declareGuideMark(names, encode.labels)
  } else {
    // the entry group has a layout (a scope of its own); inside it the entries are faceted over `value` (another)
    const entryScope = new Names(names)
    const facetScope = new Names(entryScope)
    facetScope.declare('value')
    declareGuideMark(facetScope, encode.symbols)
    declareGuideMark(facetScope, encode.labels)
    const entries = encode.entries
    if (entries && typeof entries === 'object' && (entries as { name?: unknown }).name != null) entryScope.declare((entries as { name?: unknown }).name)
  }
  if (l.title != null) declareGuideMark(names, encode.title)
  const name = rec(encode.legend).name || undefined
  if (name != null) names.declare(name)
}

/** vega-parser `parseTitle`: the title text, the subtitle, then the title group. */
function parseTitleNames(title: unknown, names: Names): void {
  const spec = typeof title === 'string' ? { text: title } : title
  if (!isRecord(spec)) return
  const encode = rec(spec.encode)
  const userEncode = rec(encode.group)
  // titleEncode(): `encode.title`, else the deprecated top-level encode block carrying the title's own name
  declareGuideMark(names, encode.title ? encode.title : { name: spec.name, ...encode })
  if (spec.subtitle) declareGuideMark(names, encode.subtitle)
  const name = userEncode.name || undefined
  if (name != null) names.declare(name)
}

/** vega-parser `parseMark`: the mark's own data (`from`, transforms), a group's content in its scope, then the mark's name. */
function parseMarkNames(m: Record<string, unknown>, names: Names, cfg: () => Record<string, unknown>): void {
  const group = m.type === 'group'
  const from = isRecord(m.from) ? m.from : undefined
  const facet = from && isRecord(from.facet) ? from.facet : undefined
  checkFrom(m.from, group, names)
  checkTransforms(m.transform, names)
  if (group) {
    // getRole: a group is a `scope`, unless its role is a guide role -- then it is parsed in its parent's scope
    const role = typeof m.role === 'string' ? m.role : ''
    const guideRole = role.startsWith('axis') || role.startsWith('legend') || role.startsWith('title')
    const nested = !guideRole || !!m.layout || !!facet
    if (nested) {
      const sub = new Names(names)
      // a facet's name is a data set of the group's own scope, declared before the group's content is parsed
      if (facet) sub.declare(facet.name)
      parseScope(m, sub, cfg)
    } else {
      parseScope(m, names, cfg)
    }
  }
  if (m.name != null) names.declare(m.name)
}

/** One scope in vega-parser's order (parsers/scope.js): scales are initialised, then data, scale domains, axes, marks (in order), legends, title. */
function parseScope(spec: Record<string, unknown>, names: Names, cfg: () => Record<string, unknown>): void {
  for (const s of specList(spec.scales)) if (isRecord(s)) names.addScale(s.name, s.type)
  for (const d of specList(spec.data)) {
    if (!isRecord(d)) continue
    // the transforms are parsed first, then the data set's sources: a derived data set names its sources
    checkTransforms(d.transform, names)
    if (d.source !== undefined) for (const s of specList(d.source)) need(names, s)
    names.declare(d.name)
  }
  for (const s of specList(spec.scales)) checkScale(s, names)
  for (const a of specList(spec.axes)) parseAxisNames(a, names, cfg)
  for (const m of specList(spec.marks)) if (isRecord(m)) parseMarkNames(m, names, cfg)
  for (const l of specList(spec.legends)) parseLegendNames(l, names)
  if (spec.title) parseTitleNames(spec.title, names)
}

/**
 * Throw `SpecParseError` for the first data set a spec uses without declaring (vega-parser `getData`) or
 * declares twice in one scope (`addData`), in vega-parser's own order.
 */
export function checkDataReferences(spec: Record<string, unknown>, config?: Record<string, unknown>): void {
  // (the merged config of the view, vega's `mergeConfig(defaultConfig(), spec.config)`: the caller has it already)
  let merged: Record<string, unknown> | undefined = config
  const cfg = (): Record<string, unknown> => (merged ??= mergeVegaConfig(vegaDefaultConfig(), isRecord(spec.config) ? spec.config : undefined))
  const top = new Names()
  parseScope(spec, top, cfg)
  // the view registers its own root item last (parsers/view.js)
  top.declare('root')
}
