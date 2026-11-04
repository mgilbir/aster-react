/**
 * The structural half of vega-parser that runs before any dataflow exists:
 *
 * - `normalizeSpecLists`: vega-parser reads every spec-level list through vega-util's
 *   `array()` (parsers/scope.js), so `data: {values: [...]}`, `marks: {type: 'rect'}` or
 *   `scales: {name: 'x'}` is the one-element list, not an error, and `null` is the empty list.
 * - the names of data sets (`Names`): `Scope.getData(name)` throws `Undefined data set name: "<name>"` when
 *   a data set is used before (or without) being declared in the scope chain, and `Scope.addData`
 *   throws `Duplicate data set name: "<name>"` for a name the SAME scope already owns. A parse error:
 *   nothing is drawn, exactly as with `vega.parse`. What registers a data set (data, named marks, a
 *   facet's name, the root's `root`, and every named mark a guide is made of) is here; the walk that
 *   meets them in vega-parser's order, with everything else it refuses, is spec-expressions.ts.
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
export function stringValue(x: unknown): string {
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
export class Names {
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

export function need(names: Names, name: unknown): void {
  if (!names.has(name)) throw new SpecParseError('Undefined data set name: ' + stringValue(name))
}

/** A data reference that names a data set (`{data}`), unless it is one vega made itself (`$ref`). */
export function needDataRef(d: Record<string, unknown>, names: Names): void {
  if (d.$ref) return
  const data = d.data
  if (data !== null && typeof data === 'object' && (data as Record<string, unknown>).$ref) return
  need(names, data)
}

/** A mark's `from`: vega-parser `parseData` (parsers/marks/data.js); a facet's own reading (`parseFacet`) comes with the group's content. */
export function checkFrom(from: unknown, group: boolean, names: Names): void {
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
    return
  }
  getDataRef(f)
}

const DISCRETE_SCALE_TYPES: ReadonlySet<string> = new Set(['ordinal', 'band', 'point', 'bin-ordinal'])

/** vega-parser `parseSort`: a domain sorted by an aggregate op needs the field it aggregates (`count` counts the values themselves). */
function checkSort(sort: unknown): void {
  if (!sort || typeof sort !== 'object') return
  const o = sort as Record<string, unknown>
  if (!o.field && o.op && o.op !== 'count') throw new SpecParseError('No field provided for sort aggregate op: ' + String(o.op))
}

/**
 * vega-parser `parseScaleDomain`: a `domainMin` / `domainMax` needs a domain to override; a domain read from data names data sets of
 * the scope, and a discrete scale's domain may be sorted by an aggregate of a field it must name (checked before the data sets of a
 * domain of several fields, after the data set of one).
 */
export function checkScale(s: unknown, names: Names): void {
  if (!isRecord(s)) return
  const domain = s.domain
  if (!domain) {
    if (s.domainMin != null || s.domainMax != null) throw new SpecParseError('No scale domain defined for domainMin/domainMax to override.')
    return
  }
  if (typeof domain !== 'object' || Array.isArray(domain)) return
  const d = domain as Record<string, unknown>
  if (d.signal) return
  const discrete = DISCRETE_SCALE_TYPES.has(String(s.type))
  if (d.fields) {
    if (discrete) checkSort(d.sort)
    for (const f of specList(d.fields)) {
      if (typeof f === 'string') need(names, d.data)
      else if (Array.isArray(f) || (f as Record<string, unknown>)?.signal) continue
      else need(names, (f as Record<string, unknown> | null)?.data)
    }
  } else {
    need(names, d.data)
    if (discrete) checkSort(d.sort)
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

/**
 * vega-parser `lookup(spec, config)(name)` over `axisConfig`: the value the axis has for `name`, the spec's own or else the first
 * config block that has it (the band block of a band scale, the block of its orient, of its direction, the axis block). An
 * `orient` that is a signal reads every block that names the key as a signal expression, which is an object (truthy).
 */
export function axisValue(a: Record<string, unknown>, name: string, scaleType: (scale: unknown) => string | undefined, cfg: Record<string, unknown>): unknown {
  if (a[name] != null) return a[name]
  const orient = a.orient
  const axis = cfg.axis
  const band = cfg.axisBand
  const bandBlock = isRecord(band) && scaleType(a.scale) === 'band' ? band : undefined
  if (isSignalObject(orient)) {
    return hasKey(bandBlock, name) ? bandBlock![name]
      : hasKey(cfg.axisTop, name) || hasKey(cfg.axisBottom, name) || hasKey(cfg.axisLeft, name) || hasKey(cfg.axisRight, name) || hasKey(cfg.axisX, name) || hasKey(cfg.axisY, name) ? { signal: '' }
      : isRecord(axis) ? axis[name] : undefined
  }
  const o = String(orient ?? '')
  if (hasKey(bandBlock, name)) return bandBlock![name]
  const or = cfg['axis' + o.charAt(0).toUpperCase() + o.slice(1)]
  if (hasKey(or, name)) return (or as Record<string, unknown>)[name]
  const xy = o === 'top' || o === 'bottom' ? cfg.axisX : cfg.axisY
  if (hasKey(xy, name)) return (xy as Record<string, unknown>)[name]
  return hasKey(axis, name) ? (axis as Record<string, unknown>)[name] : undefined
}

/** Whether the axis feature `name` (`grid`, `ticks`, `labels`, `domain`) is on: the guide marks it is made of. */
function axisFlag(a: Record<string, unknown>, name: string, names: Names, cfg: Record<string, unknown>): boolean {
  return !!axisValue(a, name, (scale) => names.scaleType(scale), cfg)
}

/** vega-parser `parseAxis`: the guide marks the axis is made of (grid, ticks, labels, domain, title), then the axis group. */
export function parseAxisNames(a: unknown, names: Names, cfg: () => Record<string, unknown>): void {
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

/** The channels a legend can have a scale for, in the order the first of them gives the legend its canonical scale (vega-parser `LegendScales`). */
export const LEGEND_CHANNELS = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const

/** vega-parser `legendType`: a symbol legend, a gradient, or a gradient in steps; the type given, else by the kind of its one scale. */
export function legendType(l: Record<string, unknown>, scaleType: string | undefined): 'symbol' | 'gradient' | 'discrete' {
  const present = LEGEND_CHANNELS.filter((c) => !!l[c]).length
  let type = typeof l.type === 'string' && l.type ? l.type : 'symbol'
  if (!l.type && present === 1 && (l.fill || l.stroke)) {
    type = scaleType && CONTINUOUS_SCALE_TYPES.has(scaleType) ? 'gradient' : scaleType && DISCRETIZING_SCALE_TYPES.has(scaleType) ? 'discrete' : 'symbol'
  }
  if (type === 'gradient' && scaleType && DISCRETIZING_SCALE_TYPES.has(scaleType)) type = 'discrete'
  return type as 'symbol' | 'gradient' | 'discrete'
}

/** vega-parser `parseLegend`: which marks a legend is made of depends on its type, and a symbol legend nests two scopes. */
export function parseLegendNames(l: unknown, names: Names): void {
  if (!isRecord(l)) return
  const encode = rec(l.encode)
  // (the marks of a legend are named by its encode blocks alone: none, nothing to declare)
  if (!Object.keys(encode).length) return
  const scale = LEGEND_CHANNELS.map((c) => l[c]).find((s) => !!s)
  const type = legendType(l, scale ? names.scaleType(scale) : undefined)
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
export function parseTitleNames(title: unknown, names: Names): void {
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
