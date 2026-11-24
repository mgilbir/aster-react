/**
 * Explicit validation layer for Vega-Lite input.
 *
 * `@aster-charts/vl` implements a subset of Vega-Lite. Anything outside that subset
 * must fail LOUDLY, naming the feature, rather than fall through to a default
 * and render a plausible but wrong chart. This module walks the whole spec
 * once, before compilation, and throws a VLCompileError for:
 *
 *  - unknown keys (typos) and keys that Vega-Lite accepts but this compiler
 *    does not implement (each reported with its path);
 *  - invalid or unsupported composition nesting;
 *  - unknown / unsupported channels, transform keys, param and selection
 *    forms, condition forms, sort forms, timeUnit units, bin options, resolve.
 *
 * The tables below are the contract: a feature is in `SUPPORTED_*` only when
 * compile.ts implements it and the conformance corpus pins it against
 * vega-lite 6.4.3.
 */
import { VLCompileError, splitAccessPath } from './names.js'
import { markChannelCompatible, spansAChannel } from './channels.js'
import { isTimerSelect, validateTimerSelection } from './animation.js'
import { parseEventSelectorString } from './event-selector.js'
import { dateTimePartProblem } from './predicate.js'
import { CALENDAR_PARTS } from './calendar.js'
import { ignoredMarkProps } from './mark-props.js'
import { suggest } from './suggest.js'
import { checkSchema, schemaProperties } from './schema.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Does `mark` draw `channel`? A composite mark (boxplot, errorbar, errorband) is its parts: they decide, once it unfolds. */
const draws = (enc: Record<string, unknown>, channel: string, mark: string): boolean =>
  ['boxplot', 'errorbar', 'errorband'].includes(mark) || markChannelCompatible(enc, channel, mark, false)

function fail(path: string, msg: string): never {
  throw new VLCompileError(`${path || '<spec>'}: ${msg}`)
}

/** splitAccessPath of a field the spec gives at `at`: a malformed path is refused with that path. */
function accessPath(f: string, at: string): string[] {
  try {
    return splitAccessPath(f)
  } catch (e) {
    if (e instanceof VLCompileError) fail(at, e.message.replace(/^\[aster\/vl\] /, ''))
    throw e
  }
}

/** `path: must be <what>` (the message most checks share). */
function mustBe(path: string, what: string): never {
  return fail(path, `must be ${what}`)
}
const OBJECT = 'an object'

function keysOf(o: Obj, allowed: ReadonlySet<string>, path: string, what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) fail(path, `unknown ${what} property "${k}"${suggest(k, allowed)}`)
  }
}

/** `<path>: unknown <what> <value>`, with the nearest of `candidates` as a suggestion. */
function unknown(path: string, what: string, value: unknown, candidates: Iterable<string>): never {
  return fail(path, `unknown ${what} ${JSON.stringify(value)}${suggest(value, candidates)}`)
}

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean))

// --- vocabularies (from the vega-lite 6.4.3 JSON schema) ---------------------

/** The marks of the schema; compile.ts implements every one. */
export const MARKS = set('arc area bar image line point rect rule text tick trail circle square geoshape boxplot errorbar errorband')
/** The marks that can be positioned by `longitude` / `latitude`; the other marks' geographic placement is not implemented. */
const GEO_POSITION_MARKS = set('point circle square text line trail rule')

const ALL_CHANNELS = set(
  'x y x2 y2 xOffset yOffset xError xError2 yError yError2 theta theta2 radius radius2 latitude longitude latitude2 longitude2 ' +
    'color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape text tooltip href url description key detail order time ' +
    'row column facet',
)
const GEO_CHANNELS = set('longitude latitude longitude2 latitude2')

const AGG_OPS = set(
  'argmax argmin average count distinct max mean median min missing product q1 q3 ci0 ci1 stderr stdev stdevp sum valid values variance variancep exponential exponentialb',
)
/** The window-only operations plus every aggregate operation except the two exponential ones. */
const WINDOW_OPS: ReadonlySet<string> = new Set([
  ...set('row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value'),
  ...[...AGG_OPS].filter((o) => o !== 'exponential' && o !== 'exponentialb'),
])

const SINGLE_TIME_UNITS: readonly string[] = CALENDAR_PARTS
const MULTI_TIME_UNITS = set(
  'yearquarter yearquartermonth yearmonth yearmonthdate yearmonthdatehours yearmonthdatehoursminutes yearmonthdatehoursminutesseconds ' +
    'yearweek yearweekday yearweekdayhours yearweekdayhoursminutes yearweekdayhoursminutesseconds yeardayofyear quartermonth ' +
    'monthdate monthdatehours monthdatehoursminutes monthdatehoursminutesseconds weekday weekdayhours weekdayhoursminutes weekdayhoursminutesseconds ' +
    'dayhours dayhoursminutes dayhoursminutesseconds hoursminutes hoursminutesseconds minutesseconds secondsmilliseconds',
)

export interface NormalTimeUnit {
  /** unit string without the `utc` prefix, e.g. "yearmonth" */
  unit: string
  utc: boolean
  step?: number
  /** the field already holds the start of the unit (`binnedyearmonth`): no timeunit transform runs on it */
  binned?: boolean
}

/**
 * Validate and normalize a Vega-Lite timeUnit (string, utc-prefixed string, or
 * {unit, utc, step, binned} object). Throws for unknown units and `maxbins`; a `binned` prefix or flag is
 * accepted and reported as `binned` (the field already holds the start of the unit).
 */
export function normalizeTimeUnit(tu: unknown, path = 'timeUnit'): NormalTimeUnit {
  let unit: unknown = tu
  let utc = false
  let binned = false
  let step: number | undefined
  if (isObj(tu)) {
    keysOf(tu, set('unit utc step maxbins binned'), path, 'timeUnit')
    if (tu.maxbins !== undefined) fail(path, 'timeUnit.maxbins (adaptive time-unit binning) is not supported')
    if (tu.binned !== undefined && typeof tu.binned !== 'boolean') mustBe(`${path}.binned`, 'a boolean')
    binned = tu.binned === true
    unit = tu.unit
    utc = tu.utc === true
    if (tu.step !== undefined) {
      if (typeof tu.step !== 'number' || !(tu.step > 0)) fail(path, 'timeUnit.step must be a positive number')
      step = tu.step
    }
  }
  if (typeof unit !== 'string') fail(path, `timeUnit must be a unit string or {unit}, got ${JSON.stringify(tu)}`)
  let u: string = unit
  // (timeunit.ts normalizeTimeUnit: "binnedutcyearmonth" is the binned, UTC year-month)
  if (u.startsWith('binned')) {
    binned = true
    u = u.slice(6)
  }
  if (u.startsWith('utc')) {
    utc = true
    u = u.slice(3)
  }
  if (!SINGLE_TIME_UNITS.includes(u) && !MULTI_TIME_UNITS.has(u)) {
    unknown(path, 'timeUnit', tu, [...SINGLE_TIME_UNITS, ...MULTI_TIME_UNITS])
  }
  return { unit: u, utc, ...(step !== undefined ? { step } : {}), ...(binned ? { binned } : {}) }
}

// --- entry -------------------------------------------------------------------

type Kind = 'unit' | 'layer' | 'hconcat' | 'vconcat' | 'concat' | 'facet' | 'repeat'

const COMPOSITION_KEYS: Kind[] = ['layer', 'hconcat', 'vconcat', 'concat', 'facet', 'repeat']

export function viewKind(spec: Obj, path: string): Kind {
  const present = COMPOSITION_KEYS.filter((k) => spec[k] !== undefined)
  if (spec.mark !== undefined) present.push('unit' as never)
  if (present.length === 0) {
    fail(path, 'a view needs exactly one of `mark`, `layer`, `hconcat`, `vconcat`, `concat`, `facet` (with `spec`), or `repeat` (with `spec`); none found')
  }
  if (present.length > 1) fail(path, `ambiguous view: ${present.join(' + ')} cannot be combined`)
  return present[0] as Kind
}

/** Spec-level keys only the root view may carry. */
const TOP_ONLY = 'datasets usermeta $schema config'
/**
 * Keys every view (root or nested) may carry. A nested view's `background`, `padding` and `autosize` are ones vega-lite accepts and reads
 * nowhere (compile.ts consumes them as ignored; vl-ignored-properties.test.ts pins it).
 */
const VIEW_COMMON = 'name description title data transform autosize background padding'
/**
 * Layout keys the composition operators share. vega-lite accepts (and ignores) width/height on them, and a `view` background (the
 * views' own are theirs); the corpus pins that.
 */
const COMPOSE = 'bounds center spacing resolve width height view'
/** Each view kind's own keys (after the common ones). */
const OWN_KEYS: Record<Kind, string> = {
  unit: 'mark encoding width height projection view resolve align bounds center spacing',
  layer: 'layer encoding width height projection view resolve',
  hconcat: `hconcat align ${COMPOSE}`,
  vconcat: `vconcat align ${COMPOSE}`,
  concat: `concat columns align ${COMPOSE}`,
  facet: `facet spec columns align ${COMPOSE}`,
  repeat: `repeat spec columns align ${COMPOSE}`,
}
// `params` is allowed at the root of every kind but nested only inside a unit spec.
const KEYS = Object.fromEntries(
  (Object.keys(OWN_KEYS) as Kind[]).map((k) => [k, {
    top: set(`${VIEW_COMMON} ${TOP_ONLY} params ${OWN_KEYS[k]}`),
    nested: set(`${VIEW_COMMON} ${k === 'unit' ? 'params ' : ''}${OWN_KEYS[k]}`),
  }]),
) as Record<Kind, { top: ReadonlySet<string>; nested: ReadonlySet<string> }>

/**
 * Which child kinds each composition operator takes: the vega-lite 6 schema's, and what vega-lite 6.4.3 compiles beyond it (noted).
 * The compiler implements every one of them; the nestings it refuses are individual checks (README "Throws"). Anything else is
 * not allowed.
 */
const ANY_VIEW: readonly Kind[] = ['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']
export const NESTING: Record<Exclude<Kind, 'unit'>, ReadonlySet<Kind>> = {
  layer: new Set<Kind>(['unit', 'layer']),
  hconcat: new Set<Kind>(ANY_VIEW),
  vconcat: new Set<Kind>(ANY_VIEW),
  concat: new Set<Kind>(ANY_VIEW),
  // (vega-lite 6.4.3 compiles a facet inside a facet - the `_future` examples - though its schema does not list one)
  // (and a repeat or a concat: a cell may hold a composition)
  facet: new Set<Kind>(['unit', 'layer', 'facet', 'hconcat', 'vconcat', 'concat', 'repeat']),
  repeat: new Set<Kind>(ANY_VIEW),
}

/**
 * What validating one spec keeps track of while it walks the spec. It lives for one validateSpec call (`st()` outside one throws): no
 * helper reads what an earlier call left behind.
 */
interface ValidationState {
  /** the names of the timer selections declared on the top-level unit being validated (the `time` channel needs exactly one) */
  timerParams: ReadonlySet<string>
  /** the names of every timer selection param in the spec (an animation's selection may sit in a view that has a name) */
  timerNames: Set<string>
  /** is the view being validated a top-level unit (the only view where the `time` channel is supported)? */
  validatingTopUnit: boolean
  /** how many facet operators are above the view being validated (a geoshape with no GeoJSON `shape` field inside a facet is not supported) */
  facetDepth: number
  /** the repeat variables in scope while validating a repeat's child spec */
  repeatVars: ReadonlySet<string>
  /** the parameters the spec declares, by name: `selection` or `variable` (a param referenced anywhere must be one of these) */
  declaredParams: Map<string, 'selection' | 'variable'>
  /** every parameter name must be unique across the whole spec */
  paramNamesSeen: Set<string>
  selectionNamesSeen: Set<string>
}
let state: ValidationState | undefined
function st(): ValidationState {
  if (state === undefined) throw new Error('validate.ts: no spec is being validated')
  return state
}

/** True for a `{repeat: "row"|"column"|"repeat"|"layer"}` field reference. */
function isRepeatRef(v: unknown): v is { repeat: string } {
  return isObj(v) && Object.keys(v).length === 1 && typeof v.repeat === 'string'
}

function checkFieldName(f: unknown, at: string): void {
  if (isRepeatRef(f)) {
    if (!st().repeatVars.has(f.repeat)) fail(at, `{"repeat": ${JSON.stringify(f.repeat)}} is used outside a matching \`repeat\` (in scope: ${[...st().repeatVars].join(', ') || 'none'})`)
    return
  }
  if (typeof f !== 'string' || f === '') fail(at, `must be a non-empty string, got ${JSON.stringify(f)}`)
  accessPath(f, at)
}


function collectParams(node: unknown, into: Map<string, 'selection' | 'variable'>, timers?: Set<string>): void {
  if (Array.isArray(node)) { node.forEach((n) => collectParams(n, into, timers)); return }
  if (!isObj(node)) return
  if (Array.isArray(node.params)) {
    for (const p of node.params) {
      if (isObj(p) && typeof p.name === 'string' && !into.has(p.name)) into.set(p.name, p.select !== undefined ? 'selection' : 'variable')
      if (timers && isObj(p) && typeof p.name === 'string' && isTimerSelect(p.select)) timers.add(p.name)
    }
  }
  for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) collectParams(node[k], into, timers)
  if (isObj(node.spec)) collectParams(node.spec, into, timers)
}

/** `{param}` must name a declared parameter. */
function checkParamRef(name: unknown, at: string): void {
  if (typeof name !== 'string') mustBe(at, 'a parameter name')
  if (!st().declaredParams.has(name)) fail(at, `parameter ${JSON.stringify(name)} is not declared in \`params\``)
}

export function validateSpec(spec: unknown): void {
  if (!isObj(spec)) fail('', 'a Vega-Lite spec must be a JSON object')
  const saved = state
  state = {
    timerParams: new Set(), timerNames: new Set(), validatingTopUnit: false, facetDepth: 0, repeatVars: new Set(),
    declaredParams: new Map(), paramNamesSeen: new Set(), selectionNamesSeen: new Set(),
  }
  try {
    collectParams(spec, state.declaredParams, state.timerNames)
    validateView(spec, '', true, undefined, true)
    refusePrototypeNames(spec)
    // (and what the schema forbids, by path, wherever the checks above did not already refuse it)
    checkSchema(spec)
  } finally {
    state = saved
  }
}

/**
 * The names of Object.prototype's members (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__` ...). Vega keeps the
 * fields, datasets and signals of a spec in plain objects keyed by their names, so a field or a dataset named as one of these is mistaken
 * for the prototype's member: vega-lite 6.4.3's output for it fails in Vega ("Operator not defined", "list.push is not a function"), or
 * draws without it (an aggregate that aggregates nothing, a time unit of nothing, an aria description or a legend that leaves the field
 * out). Such a name is refused (DECISIONS Q9), except in the places listed in PROTOTYPE_SAFE, where vega-lite's chart is the chart of
 * any other name; a place not listed is refused (C442).
 */
const PROTOTYPE_MEMBERS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype))
const allBut = (...names: string[]): ReadonlySet<string> => new Set([...PROTOTYPE_MEMBERS].filter((n) => !names.includes(n)))
/**
 * Where, and for which members, vega-lite's chart with such a name is the chart of any other name: what a transform reads only through
 * a field accessor, a parameter's name, a binned channel's field (whose description drops some names), `x2`. Each entry is held to
 * vega-lite through real Vega, both ways and for every member, by conformance/test/vl-prototype-names.test.ts.
 */
const PROTOTYPE_SAFE = {
  fold: allBut('__proto__'),
  binTransform: allBut('__proto__'),
  stack: allBut('__proto__'),
  parameter: allBut('__proto__'),
  pivot: PROTOTYPE_MEMBERS,
  density: PROTOTYPE_MEMBERS,
  quantile: PROTOTYPE_MEMBERS,
  binnedPosition: allBut('__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'),
  binnedColor: allBut('__proto__', 'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'),
  x2: new Set(['__proto__']),
} as const satisfies Record<string, ReadonlySet<string>>

/**
 * A name with a backslash of its own: a field path with an escaped backslash (`x\\y` reads the column `x\y`), or an output name
 * holding one. vega-lite 6.4.3 writes a field into Vega's `field` properties as replacePathInField does, which escapes dots,
 * brackets and quotes but not a backslash, so Vega reads `x\y` as the escape `\y`, the column `xy`: the scale domain, the aggregate,
 * the bin, the facet, the sort read a column that is not there (a NaN domain, an empty chart). Vega reads it right only where vega-lite
 * writes an expression (`datum["x\\y"]`: a tooltip, a text, a predicate) or passes the path on as written (a fold, a joinaggregate, a
 * lookup key); those places are the ones marked safe below, each held to vega-lite through real Vega by
 * conformance/test/vl-escaped-names.test.ts. Every other place is refused (DECISIONS Q9; C184, C442).
 */
const hasEscapedBackslash = (path: string): boolean => path.includes('\\\\')
/** Channels whose plain field (no aggregate, bin or time unit) vega-lite reads by an expression, or (`x2`) through its primary's scale. */
const BACKSLASH_SAFE_CHANNELS: ReadonlySet<string> = new Set(['tooltip', 'text', 'href', 'url', 'description', 'key', 'order', 'x2'])

/**
 * Refuse every field, dataset, output (`as`) and parameter name of the spec that Vega mistakes: a member of Object.prototype, or a name
 * with a backslash of its own, outside the places where vega-lite's chart is the chart of an ordinary name.
 */
function refusePrototypeNames(spec: Obj): void {
  const refuse = (at: string, what: string, name: string): never =>
    fail(at, `a ${what} named ${JSON.stringify(name)} is not supported: Vega keeps names in plain objects and mistakes it for Object.prototype's member, so vega-lite 6.4.3's chart fails or draws without it; rename it`)
  const refuseBackslash = (at: string, what: string, name: string): never =>
    fail(at, `a ${what} named ${JSON.stringify(name)} is not supported here: it holds a backslash, which vega-lite 6.4.3 does not escape where it writes the name into Vega, so its chart reads another column; rename it`)
  // (`safe`: the members allowed here; `backslashSafe`: a backslash is read right here; `literal`: a name vega-lite also writes as it is -
  // an output - so that its every backslash is its own. A dataset's or a parameter's name is never written as a field.)
  const check = (v: unknown, at: string, what: string, safe?: ReadonlySet<string>, backslashSafe = false, literal = false): void => {
    if (typeof v !== 'string') return
    if (PROTOTYPE_MEMBERS.has(v) && !safe?.has(v)) refuse(at, what, v)
    if (!backslashSafe && what === 'field' && (literal ? v.includes('\\') : hasEscapedBackslash(v))) refuseBackslash(at, what, v)
  }
  const checkAll = (v: unknown, at: string, what: string, safe?: ReadonlySet<string>, backslashSafe = false): void => {
    if (Array.isArray(v)) v.forEach((x, i) => check(x, `${at}[${i}]`, what, safe, backslashSafe))
    else check(v, at, what, safe, backslashSafe)
  }
  // (an output, or a path vega-lite also writes as a literal name - a regression's or a flatten's output, a repeated field's title and
  // column - where any escape is lost: `a\.b` there names the column `a\.b`, and the encoding reads `a.b`)
  const literal = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => literal(x, `${at}[${i}]`))
    else check(v, at, 'field', undefined, false, true)
  }
  // (every `field` below a predicate, a sort or a condition: vega-lite reads them by expression, or passes them on as written)
  const fieldsBelow = (n: unknown, at: string): void => {
    if (Array.isArray(n)) { n.forEach((x, i) => fieldsBelow(x, `${at}[${i}]`)); return }
    if (!isObj(n)) return
    for (const [k, v] of Object.entries(n)) {
      if (k === 'field') check(v, `${at}.field`, 'field', undefined, true)
      else fieldsBelow(v, `${at}.${k}`)
    }
  }
  const data = (d: unknown, at: string): void => {
    if (!isObj(d)) return
    check(d.name, `${at}.name`, 'dataset')
    if (isObj(d.format) && isObj(d.format.parse)) for (const k of Object.keys(d.format.parse)) check(k, `${at}.format.parse`, 'field')
    for (const g of ['sequence']) if (isObj(d[g])) literal((d[g] as Obj).as, `${at}.${g}.as`)
  }
  const channelDef = (def: unknown, at: string, channel?: string): void => {
    if (Array.isArray(def)) { def.forEach((d, i) => channelDef(d, `${at}[${i}]`, channel)); return }
    if (!isObj(def)) return
    const binned = def.bin !== undefined && def.bin !== false && def.bin !== null && def.bin !== 'binned'
    const safe = binned && (channel === 'x' || channel === 'y') ? PROTOTYPE_SAFE.binnedPosition : binned && channel === 'color' ? PROTOTYPE_SAFE.binnedColor : !binned && channel === 'x2' ? PROTOTYPE_SAFE.x2 : undefined
    const plain = def.aggregate === undefined && def.timeUnit === undefined && (def.bin === undefined || def.bin === false || def.bin === null)
    check(def.field, `${at}.field`, 'field', safe, plain && channel !== undefined && BACKSLASH_SAFE_CHANNELS.has(channel))
    if (def.condition !== undefined) channelDef(def.condition, `${at}.condition`, channel)
    if (isObj(def.sort)) check(def.sort.field, `${at}.sort.field`, 'field')
  }
  const transform = (t: unknown, at: string): void => {
    if (!isObj(t)) return
    const a = (k: string): string => `${at}.${k}`
    // (a joinaggregate's and a window's groupby are passed on as written; an aggregate's are written as replacePathInField does)
    const groupsAsWritten = t.joinaggregate !== undefined || t.window !== undefined
    literal(t.as, a('as'))
    checkAll(t.groupby, a('groupby'), 'field', undefined, groupsAsWritten)
    if (t.filter !== undefined) fieldsBelow(t.filter, a('filter'))
    if (t.bin !== undefined) check(t.field, a('field'), 'field', PROTOTYPE_SAFE.binTransform)
    else if (t.timeUnit !== undefined) check(t.field, a('field'), 'field')
    if (t.fold !== undefined) checkAll(t.fold, a('fold'), 'field', PROTOTYPE_SAFE.fold, true)
    for (const k of ['aggregate', 'joinaggregate', 'window']) {
      if (Array.isArray(t[k])) (t[k] as unknown[]).forEach((op, i) => { if (isObj(op)) { check(op.field, `${a(k)}[${i}].field`, 'field', undefined, k !== 'aggregate'); literal(op.as, `${a(k)}[${i}].as`) } })
    }
    if (t.sort !== undefined) fieldsBelow(t.sort, a('sort'))
    for (const k of ['stack', 'pivot', 'density', 'quantile'] as const) checkAll(t[k], a(k), 'field', PROTOTYPE_SAFE[k], true)
    for (const k of ['lookup', 'loess', 'key', 'on', 'extent']) checkAll(t[k], a(k), 'field', undefined, true)
    checkAll(t.impute, a('impute'), 'field')
    for (const k of ['flatten', 'regression']) literal(t[k], a(k))
    if (t.pivot !== undefined) check(t.value, a('value'), 'field', undefined, true)
    if (t.extent !== undefined) check(t.param, a('param'), 'parameter', PROTOTYPE_SAFE.parameter)
    if (isObj(t.from)) {
      check(t.from.param, a('from.param'), 'parameter', PROTOTYPE_SAFE.parameter)
      check(t.from.key, a('from.key'), 'field', undefined, true)
      checkAll(t.from.fields, a('from.fields'), 'field', undefined, true)
      data(t.from.data, a('from.data'))
    }
  }
  const view = (v: unknown, at: string): void => {
    if (!isObj(v)) return
    const a = (k: string): string => (at ? `${at}.${k}` : k)
    data(v.data, a('data'))
    if (isObj(v.datasets)) for (const k of Object.keys(v.datasets)) check(k, a('datasets'), 'dataset')
    if (Array.isArray(v.transform)) v.transform.forEach((t, i) => transform(t, `${a('transform')}[${i}]`))
    if (isObj(v.encoding)) for (const [ch, def] of Object.entries(v.encoding)) channelDef(def, `${a('encoding')}.${ch}`, ch)
    if (isObj(v.facet)) {
      if (v.facet.field !== undefined) channelDef(v.facet, a('facet'))
      else for (const [k, def] of Object.entries(v.facet)) channelDef(def, `${a('facet')}.${k}`)
    }
    if (Array.isArray(v.repeat)) literal(v.repeat, a('repeat'))
    else if (isObj(v.repeat)) for (const [k, list] of Object.entries(v.repeat)) literal(list, `${a('repeat')}.${k}`)
    if (Array.isArray(v.params)) {
      v.params.forEach((p, i) => {
        if (!isObj(p)) return
        check(p.name, `${a('params')}[${i}].name`, 'parameter', PROTOTYPE_SAFE.parameter)
        if (isObj(p.select)) checkAll(p.select.fields, `${a('params')}[${i}].select.fields`, 'field')
      })
    }
    for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) if (Array.isArray(v[k])) (v[k] as unknown[]).forEach((c, i) => view(c, `${a(k)}[${i}]`))
    if (isObj(v.spec)) view(v.spec, a('spec'))
  }
  view(spec, '')
}

/**
 * How deep views may nest (a layer in a facet in a concat ...): compiling a view is recursive, several frames per level, so the spec's
 * own depth ceiling (rows.ts MAX_SPEC_DEPTH) does not keep it off the stack's end; past this a spec is refused (docs/LIMITS.md).
 */
export const MAX_VIEW_DEPTH = 100

function validateView(spec: Obj, path: string, top: boolean, parent: Kind | undefined, selOk: boolean, depth = 0): void {
  if (depth > MAX_VIEW_DEPTH) fail(path, `views nested more than ${MAX_VIEW_DEPTH} deep are not supported`)
  const kind = viewKind(spec, path)
  const at = (k: string): string => (path ? `${path}.${k}` : k)
  if (!top && spec.config !== undefined) fail(at('config'), 'config is only allowed at the top level of a spec')
  keysOf(spec, top ? KEYS[kind].top : KEYS[kind].nested, path, top ? 'top-level' : `nested ${kind}-spec`)
  if (!top && parent) {
    if (!NESTING[parent as Exclude<Kind, 'unit'>].has(kind)) fail(path, `a ${kind} spec is not allowed inside \`${parent}\` (vega-lite schema)`)
  }
  if (spec.$schema !== undefined && typeof spec.$schema !== 'string') mustBe(at('$schema'), 'a string')

  st().validatingTopUnit = top && kind === 'unit'
  st().timerParams = st().validatingTopUnit && Array.isArray(spec.params)
    ? new Set((spec.params as unknown[]).filter((p): p is Obj => isObj(p) && isObj(p.select) && isTimerSelect(p.select) && typeof p.name === 'string').map((p) => p.name as string))
    : new Set()
  validateData(spec, at)
  if (spec.transform !== undefined) validateTransforms(spec.transform, at('transform'))
  // (`"container"`: a top-level view's, or a facet's cells' - vega-lite sizes each cell by the container, child_width / child_height)
  validateSize(spec, at, (top || parent === 'facet') && (kind === 'unit' || kind === 'layer'))
  if (spec.params !== undefined) validateParams(spec.params, at('params'), kind !== 'layer' && selOk, kind, spec, at('params'))
  if (spec.resolve !== undefined) validateResolve(spec.resolve, at('resolve'), kind, isObj(spec.encoding) && (spec.encoding.row != null || spec.encoding.column != null || spec.encoding.facet != null))
  if (spec.projection !== undefined) validateProjection(spec.projection, at('projection'))
  if (spec.view !== undefined) validateViewBackground(spec.view, kind, at('view'))
  if (spec.usermeta !== undefined && !isObj(spec.usermeta)) mustBe(at('usermeta'), OBJECT)
  if (spec.config !== undefined) {
    // (a nested config was rejected above)
    if (!isObj(spec.config)) mustBe(at('config'), OBJECT)
    validateConfig(spec.config, at('config'))
  }
  if (spec.autosize !== undefined) validateAutosize(spec.autosize, at('autosize'))
  if (spec.datasets !== undefined) {
    if (!isObj(spec.datasets)) mustBe(at('datasets'), 'an object mapping names to inline data')
    // (vega-lite InlineDataset: rows, a text in the format the data says (CSV, TSV ...), or a JSON object)
    for (const [k, v] of Object.entries(spec.datasets)) {
      if (!(Array.isArray(v) || typeof v === 'string' || isObj(v))) mustBe(`${at('datasets')}.${k}`, 'an array of rows, a string or an object')
    }
  }
  for (const k of ['align', 'bounds', 'center', 'spacing', 'columns'] as const) {
    // (a unit faceted through its encoding is a facet: normalize/facet.ts moves its layout properties onto it)
    const faceted = kind === 'unit' && isObj(spec.encoding) && (spec.encoding.row != null || spec.encoding.column != null || spec.encoding.facet != null)
    if (spec[k] !== undefined && (kind === 'unit' || kind === 'layer') && !faceted) fail(at(k), `${k} is only meaningful on composition specs`)
  }

  switch (kind) {
    case 'unit':
      validateUnit(spec, at, top)
      break
    case 'layer': {
      if (!Array.isArray(spec.layer) || spec.layer.length === 0) mustBe(at('layer'), 'a non-empty array of specs')
      if (spec.encoding !== undefined) validateEncoding(spec.encoding, at('encoding'), 'layer')
      spec.layer.forEach((c, i) => {
        if (!isObj(c)) mustBe(`${at('layer')}[${i}]`, OBJECT)
        validateView(c, `${at('layer')}[${i}]`, false, 'layer', selOk, depth + 1)
      })
      break
    }
    case 'hconcat':
    case 'vconcat':
    case 'concat': {
      const arr = spec[kind]
      if (!Array.isArray(arr) || arr.length === 0) mustBe(at(kind), 'a non-empty array of specs')
      arr.forEach((c, i) => {
        if (!isObj(c)) mustBe(`${at(kind)}[${i}]`, OBJECT)
        validateView(c, `${at(kind)}[${i}]`, false, kind, selOk, depth + 1)
      })
      if (spec.columns !== undefined && kind !== 'concat') fail(at('columns'), '`columns` is only valid on `concat`')
      checkColumns(spec, at)
      break
    }
    case 'facet':
      validateFacetOperator(spec, at, selOk, depth)
      break
    case 'repeat':
      validateRepeatOperator(spec, at, selOk, depth)
      break
  }
}

/** `columns`, when present, is a positive integer. */
function checkColumns(spec: Obj, at: (k: string) => string): void {
  if (spec.columns !== undefined && !(Number.isInteger(spec.columns) && (spec.columns as number) > 0)) mustBe(at('columns'), 'a positive integer')
}

function validateAutosize(a: unknown, path: string): void {
  if (typeof a === 'string') {
    if (!['pad', 'none', 'fit', 'fit-x', 'fit-y'].includes(a)) unknown(path, 'autosize', a, ['pad', 'none', 'fit', 'fit-x', 'fit-y'])
    return
  }
  if (!isObj(a)) mustBe(path, 'a string or an object')
  keysOf(a, set('type resize contains'), path, 'autosize')
}

function validateSize(spec: Obj, at: (k: string) => string, containerOk: boolean): void {
  for (const k of ['width', 'height'] as const) {
    const v = spec[k]
    if (v === undefined) continue
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) continue
    // (vega-lite `Step`: {step, for?: "position" | "offset"})
    if (isObj(v) && typeof v.step === 'number' && v.step > 0 && Object.keys(v).every((x) => x === 'step' || (x === 'for' && (v.for === 'position' || v.for === 'offset')))) continue
    if (v === 'container') {
      if (containerOk) continue
      fail(at(k), `${k}: "container" is only supported on a top-level unit or layer view, or on a facet's spec; give a number or {"step": n}`)
    }
    // (JSON writes a NaN or an infinity as null: the value is shown as it is)
    fail(at(k), `${k} must be a non-negative number or {"step": n}, got ${typeof v === 'number' ? String(v) : JSON.stringify(v)}`)
  }
}

// --- data --------------------------------------------------------------------

function validateData(spec: Obj, at: (k: string) => string): void {
  const data = spec.data
  if (data === undefined) return
  if (data === null) fail(at('data'), 'data: null is not supported')
  if (!isObj(data)) mustBe(at('data'), OBJECT)
  const kinds = ['values', 'url', 'name', 'sequence', 'sphere', 'graticule'].filter((k) => data[k] !== undefined)
  if (kinds.length === 0) fail(at('data'), 'needs one of `values`, `url`, `name`, or a generator (`sequence`, `sphere`, `graticule`)')
  if (data.sequence !== undefined) {
    // (a generator takes a `name`, the name of the dataset it makes: vega-lite data.ts DataBase)
    if (kinds.some((k) => k !== 'sequence' && k !== 'name')) fail(at('data'), 'a `sequence` data generator cannot be combined with another data source')
    keysOf(data, set('sequence name'), at('data'), 'data generator')
    const q = data.sequence
    if (!isObj(q)) mustBe(at('data.sequence'), 'an object {start, stop, step, as}')
    keysOf(q, set('start stop step as'), at('data.sequence'), 'sequence')
    for (const k of ['start', 'stop'] as const) if (typeof q[k] !== 'number' || !Number.isFinite(q[k])) mustBe(at(`data.sequence.${k}`), 'a finite number')
    if (q.step !== undefined && (typeof q.step !== 'number' || !Number.isFinite(q.step) || q.step === 0)) mustBe(at('data.sequence.step'), 'a non-zero number')
    if (q.as !== undefined && typeof q.as !== 'string') mustBe(at('data.sequence.as'), 'a field name')
    if (data.name !== undefined && typeof data.name !== 'string') mustBe(at('data.name'), 'a string')
    return
  }
  if (data.sphere !== undefined || data.graticule !== undefined) {
    if (data.sphere !== undefined && data.graticule !== undefined) fail(at('data'), '`sphere` and `graticule` cannot be combined')
    const g = data.sphere !== undefined ? 'sphere' : 'graticule'
    keysOf(data, set(`${g} name`), at('data'), 'data generator')
    const v = data[g]
    if (g === 'sphere') {
      if (v !== true && !(isObj(v) && Object.keys(v).length === 0)) mustBe(at('data.sphere'), 'true')
    } else if (v !== true) {
      if (!isObj(v)) mustBe(at('data.graticule'), 'true or an object of graticule parameters')
      keysOf(v, set('extent extentMajor extentMinor precision step stepMajor stepMinor'), at('data.graticule'), 'graticule')
    }
    if (data.name !== undefined && typeof data.name !== 'string') mustBe(at('data.name'), 'a string')
    return
  }
  if (data.values !== undefined && data.url !== undefined) fail(at('data'), '`values` and `url` cannot be combined')
  keysOf(data, set('values url name format'), at('data'), 'data')
  if (data.values !== undefined && typeof data.values !== 'string' && !Array.isArray(data.values) && !isObj(data.values)) {
    mustBe(at('data.values'), 'an array, an object or a string')
  }
  // (a bare named dataset is legal: the host supplies rows by name at runtime)
  if (data.name !== undefined && typeof data.name !== 'string') mustBe(at('data.name'), 'a string')
  if (data.format !== undefined) {
    if (!isObj(data.format)) mustBe(at('data.format'), OBJECT)
    keysOf(data.format, set('type parse property delimiter header feature mesh'), at('data.format'), 'data.format')
    const t = data.format.type
    if (t !== undefined && !['json', 'csv', 'tsv', 'dsv', 'topojson'].includes(t as string)) fail(at('data.format.type'), `unsupported format type ${JSON.stringify(t)}`)
    for (const k of ['feature', 'mesh'] as const) {
      if (data.format[k] === undefined) continue
      if (t !== 'topojson') fail(at(`data.format.${k}`), `\`${k}\` only applies to the "topojson" format`)
      if (typeof data.format[k] !== 'string') mustBe(at(`data.format.${k}`), 'the name of a TopoJSON object')
    }
    if (t === 'topojson' && data.format.feature === undefined && data.format.mesh === undefined) {
      fail(at('data.format'), 'a "topojson" format needs `feature` or `mesh` (the TopoJSON object to read)')
    }
    if (t === 'topojson' && data.format.feature !== undefined && data.format.mesh !== undefined) fail(at('data.format'), '`feature` and `mesh` cannot be combined')
    if (data.format.parse !== undefined && data.format.parse !== null && !isObj(data.format.parse)) mustBe(at('data.format.parse'), 'an object or null')
  }
}

// --- config ------------------------------------------------------------------

const CONFIG_KEYS = set(
  'autosize background padding axis axisBand axisX axisY axisLeft axisRight axisTop axisBottom legend header headerRow headerColumn headerFacet range ' +
    'mark arc area bar circle geoshape image line point rect rule square text tick trail view title font scale style projection ' +
    'aria countTitle fieldTitle lineBreak normalizedNumberFormat numberFormat timeFormat boxplot errorbar errorband concat facet tooltipFormat ' +
    'customFormatTypes numberFormatType normalizedNumberFormatType timeFormatType selection locale',
)
const CONFIG_SCALE_KEYS = set(
  'bandPaddingInner bandPaddingOuter barBandPaddingInner tickBandPaddingInner rectBandPaddingInner bandWithNestedOffsetPaddingInner bandWithNestedOffsetPaddingOuter offsetBandPaddingInner offsetBandPaddingOuter pointPadding continuousPadding round nice zero xReverse clamp useUnaggregatedDomain invalid minBandSize maxBandSize minFontSize maxFontSize minOpacity maxOpacity minSize maxSize minStrokeWidth maxStrokeWidth quantileCount quantizeCount framesPerSecond animationDuration',
)

/** Every property of vega-lite's `Config` (the generated schema table). */
export const VEGA_LITE_CONFIG_KEYS = schemaProperties('Config')

function validateConfig(cfg: Obj, path: string): void {
  for (const k of Object.keys(cfg)) {
    if (CONFIG_KEYS.has(k)) continue
    if (VEGA_LITE_CONFIG_KEYS.has(k)) fail(`${path}.${k}`, 'this config property is valid Vega-Lite but is not supported by @aster-charts/vl (it would be silently ignored)')
    fail(`${path}.${k}`, `unknown config property "${k}"${suggest(k, VEGA_LITE_CONFIG_KEYS)}`)
  }
  if (cfg.scale !== undefined) {
    if (!isObj(cfg.scale)) mustBe(`${path}.scale`, OBJECT)
    for (const k of Object.keys(cfg.scale)) {
      if (!CONFIG_SCALE_KEYS.has(k)) fail(`${path}.scale.${k}`, 'this scale config property is not supported by @aster-charts/vl')
    }
    const inv = cfg.scale.invalid
    if (inv !== undefined) {
      if (!isObj(inv)) fail(`${path}.scale.invalid`, 'must map scale channels to "zero-or-min" or {"value": ...}')
      for (const [ch, v] of Object.entries(inv)) {
        if (!ALL_CHANNELS.has(ch)) unknown(`${path}.scale.invalid.${ch}`, 'scale channel', ch, ALL_CHANNELS)
        if (v !== 'zero-or-min' && !(isObj(v) && 'value' in v)) mustBe(`${path}.scale.invalid.${ch}`, '"zero-or-min" or {"value": ...}')
      }
    }
  }
  for (const k of ['concat', 'facet'] as const) {
    const c = cfg[k]
    if (c === undefined) continue
    if (!isObj(c)) mustBe(`${path}.${k}`, OBJECT)
    keysOf(c, set('columns spacing'), `${path}.${k}`, `${k} config`)
    if (c.columns !== undefined && !(Number.isInteger(c.columns) && (c.columns as number) > 0)) mustBe(`${path}.${k}.columns`, 'a positive integer')
    if (c.spacing !== undefined && typeof c.spacing !== 'number') mustBe(`${path}.${k}.spacing`, 'a number')
  }
  if (cfg.tooltipFormat !== undefined) {
    if (!isObj(cfg.tooltipFormat)) mustBe(`${path}.tooltipFormat`, OBJECT)
    keysOf(cfg.tooltipFormat, set('numberFormat numberFormatType normalizedNumberFormat normalizedNumberFormatType timeFormat timeFormatType'), `${path}.tooltipFormat`, 'tooltip format config')
    for (const [k, v] of Object.entries(cfg.tooltipFormat)) if (typeof v !== 'string') mustBe(`${path}.tooltipFormat.${k}`, 'a string')
  }
  if (cfg.boxplot !== undefined) {
    if (!isObj(cfg.boxplot)) mustBe(`${path}.boxplot`, OBJECT)
    keysOf(cfg.boxplot, set('size extent box median outliers rule ticks'), `${path}.boxplot`, 'boxplot config')
    const ext = cfg.boxplot.extent
    if (ext !== undefined && ext !== 'min-max' && !(typeof ext === 'number' && Number.isFinite(ext) && ext >= 0)) mustBe(`${path}.boxplot.extent`, '"min-max" or a non-negative number')
  }
  if (cfg.projection !== undefined) validateProjection(cfg.projection, `${path}.projection`)
  if (cfg.selection !== undefined) {
    if (!isObj(cfg.selection)) mustBe(`${path}.selection`, OBJECT)
    keysOf(cfg.selection, set('point interval'), `${path}.selection`, 'selection config')
    for (const t of ['point', 'interval'] as const) {
      const c = cfg.selection[t]
      if (c === undefined) continue
      if (!isObj(c)) mustBe(`${path}.selection.${t}`, OBJECT)
      keysOf(c, set(t === 'interval' ? 'clear encodings fields mark on resolve translate zoom' : 'clear encodings fields nearest on resolve toggle'), `${path}.selection.${t}`, `${t} selection config`)
      if (c.on !== undefined) validateStream(c.on, `${path}.selection.${t}.on`, 'on', false)
      if (c.clear !== undefined) validateStream(c.clear, `${path}.selection.${t}.clear`, 'clear', true)
    }
  }
  if (cfg.customFormatTypes !== undefined && typeof cfg.customFormatTypes !== 'boolean') mustBe(`${path}.customFormatTypes`, 'a boolean')
  for (const k of ['numberFormatType', 'normalizedNumberFormatType', 'timeFormatType'] as const) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'string') mustBe(`${path}.${k}`, 'the name of a format function registered as an expression function')
  }
  if (cfg.autosize !== undefined) validateAutosize(cfg.autosize, `${path}.autosize`)
}

// --- projection --------------------------------------------------------------

/** vega-lite `Projection` (the schema's property list) */
const PROJECTION_KEYS = set(
  'type clipAngle clipExtent center rotate precision reflectX reflectY coefficient distance fraction lobes parallel parallels ' +
    'pointRadius radius ratio spacing tilt scale translate extent fit size',
)
/** vega-lite `ProjectionType`, lower-cased (vega reads the type case-insensitively), and the one extra projection vega registers */
const PROJECTION_TYPES = set(
  'albers albersusa azimuthalequalarea azimuthalequidistant conicconformal conicequalarea conicequidistant equalearth ' +
    'equirectangular gnomonic identity mercator naturalearth1 orthographic stereographic transversemercator mollweide',
)

/** A projection property value that is a signal / expression reference rather than a literal. */
const isRef = (v: unknown): boolean => isObj(v) && (typeof v.signal === 'string' || typeof v.expr === 'string')

function validateProjection(p: unknown, at: string): void {
  if (!isObj(p)) mustBe(at, OBJECT)
  keysOf(p, PROJECTION_KEYS, at, 'projection')
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || isRef(v)) continue
    const path = `${at}.${k}`
    const num = (): void => { if (typeof v !== 'number' || !Number.isFinite(v)) mustBe(path, 'a number or a signal / expression reference') }
    const pair = (): void => {
      if (!(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' ? Number.isFinite(n) : isRef(n)))) mustBe(path, 'a [number, number] pair')
    }
    switch (k) {
      case 'type':
        if (typeof v !== 'string' || !PROJECTION_TYPES.has(v.toLowerCase())) fail(path, `unknown projection type ${JSON.stringify(v)}: expected one of albers, albersUsa, azimuthalEqualArea, azimuthalEquidistant, conicConformal, conicEqualArea, conicEquidistant, equalEarth, equirectangular, gnomonic, identity, mercator, naturalEarth1, orthographic, stereographic, transverseMercator (vega refuses any other)`)
        break
      case 'scale': case 'clipAngle': case 'precision': case 'coefficient': case 'distance': case 'fraction': case 'lobes':
      case 'parallel': case 'pointRadius': case 'radius': case 'ratio': case 'spacing': case 'tilt':
        num()
        break
      case 'reflectX': case 'reflectY':
        if (typeof v !== 'boolean') mustBe(path, 'a boolean or a signal / expression reference')
        break
      case 'translate': case 'center': case 'parallels':
        pair()
        break
      case 'rotate':
        if (!(Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every((n) => typeof n === 'number' ? Number.isFinite(n) : isRef(n)))) mustBe(path, 'a [lambda, phi] or [lambda, phi, gamma] array')
        break
      case 'clipExtent':
        if (!(Array.isArray(v) && v.length === 2 && v.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' ? Number.isFinite(n) : isRef(n))))) mustBe(path, 'a [[x0, y0], [x1, y1]] array')
        break
      case 'size':
        pair()
        break
      case 'extent':
        if (!(Array.isArray(v) && v.length === 2 && v.every((c) => Array.isArray(c) && c.length === 2))) mustBe(path, 'a [[x0, y0], [x1, y1]] array')
        break
      case 'fit':
        // a GeoJSON feature(s) to fit to, or a boolean: vega fits the projection to it
        if (typeof v !== 'boolean' && !isObj(v) && !Array.isArray(v)) mustBe(path, 'GeoJSON (or an array of it) to fit the projection to')
        break
    }
  }
}

// --- params ------------------------------------------------------------------

const BIND_INPUTS = set('range checkbox radio select text number date datetime-local time month week color search tel url email password')

/**
 * Why a selection parameter declared on a composition (concat, facet, repeat) cannot be pushed down to the units below it
 * (vega-lite gives every unit a copy), or undefined when it can: a layer below would declare the same signals twice in one
 * Vega scope, which Vega rejects, and a composite mark (boxplot, errorbar, errorband) is a layer once vega-lite has normalized it.
 */
/** How many units a layer tree holds. */
function unitsBelow(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + unitsBelow(c), 0)
  if (!isObj(node)) return 0
  return Array.isArray(node.layer) ? unitsBelow(node.layer) : 1
}

function pushdownProblem(node: unknown): string | undefined {
  if (!isObj(node)) return undefined
  const mark = node.mark
  const markType = typeof mark === 'string' ? mark : isObj(mark) ? mark.type : undefined
  // (an errorbar or an errorband is one unit unless it draws ticks, borders or points: the compiler refuses the ones that are several)
  if (markType === 'boxplot') return 'a boxplot is a layer once vega-lite has normalized it'
  if (Array.isArray(node.layer) && unitsBelow(node.layer) > 1) return 'a layer below would declare the selection\'s signals twice in one Vega scope, which Vega rejects'
  if (node.mark !== undefined && Array.isArray(node.params) && node.params.length > 0) return 'vega-lite replaces the parameters of a unit that has some of its own (so a variable parameter or a selection declared there would be lost)'
  for (const k of ['hconcat', 'vconcat', 'concat']) {
    if (Array.isArray(node[k])) for (const c of node[k] as unknown[]) { const p = pushdownProblem(c); if (p) return p }
  }
  return isObj(node.spec) ? pushdownProblem(node.spec) : undefined
}

function validateParams(params: unknown, path: string, selectionOk: boolean, kind: Kind, view?: Obj, viewPath?: string): void {
  if (!Array.isArray(params)) mustBe(path, 'an array of parameter definitions')
  params.forEach((p, i) => {
    const at = `${path}[${i}]`
    if (!isObj(p)) mustBe(at, OBJECT)
    if (typeof p.name !== 'string' || p.name === '') mustBe(`${at}.name`, 'a non-empty string')
    // (two views may each declare a selection of the same name: every view keeps its own tuples in the one store - concat_hover; a
    // selection and a variable parameter, or two variable parameters, cannot share a name)
    if (st().paramNamesSeen.has(p.name) && !(p.select !== undefined && st().selectionNamesSeen.has(p.name))) fail(`${at}.name`, `duplicate parameter name "${p.name}"`)
    st().paramNamesSeen.add(p.name)
    if (p.select !== undefined) st().selectionNamesSeen.add(p.name)
    if (p.select !== undefined) {
      if (!selectionOk) {
        fail(`${at}.select`, kind === 'layer'
          ? 'a selection parameter on a layer spec itself: vega-lite gives every layer a copy of its signals in the same Vega scope, which Vega rejects; declare it on one of the layers'
          : 'a selection parameter is not supported here')
      }
      if (kind !== 'unit' && view !== undefined) {
        const problem = pushdownProblem(kind === 'facet' || kind === 'repeat' ? view.spec : { [kind]: view[kind] })
        if (problem) fail(`${at}.select`, `a selection parameter on a ${kind} spec is given to every unit below it (vega-lite), and ${problem}: declare it on a unit instead`)
      }
      if (p.views !== undefined) fail(`${at}.views`, '`views` (restricting a selection declared on a composition to some of its views) is not supported: declare the selection on the unit')
      validateSelection(p, at)
      return
    }
    // variable parameter
    keysOf(p, set('name value expr bind react description push'), at, 'parameter')
    if (p.expr !== undefined && typeof p.expr !== 'string') mustBe(`${at}.expr`, 'an expression string')
    if (p.push !== undefined) fail(`${at}.push`, '`push` is not a Vega-Lite parameter property (it is Vega\'s signal scoping, which vega-lite sets itself where it needs it)')
    if (p.react !== undefined && p.react !== false && p.react !== true) mustBe(`${at}.react`, 'a boolean')
    if (p.bind !== undefined) {
      if (!isObj(p.bind)) mustBe(`${at}.bind`, 'an input binding object (legend/scales bindings belong to selection parameters)')
      validateBinding(p.bind, `${at}.bind`)
    }
    // (a bound parameter starts as its input's value)
    if (p.value === undefined && p.expr === undefined && p.bind === undefined) fail(at, 'a variable parameter needs `value`, `expr` or `bind`')
  })
}

/** An input binding (vega signal `bind`). */
function validateBinding(bind: Obj, at: string): void {
  keysOf(bind, set('input min max step options labels name debounce element placeholder autocomplete'), at, 'bind')
  if (bind.input === undefined) fail(at, `a binding needs \`input\` (one of ${[...BIND_INPUTS].join(', ')}); a binding to an element of the page alone is not supported`)
  if (typeof bind.input !== 'string' || !BIND_INPUTS.has(bind.input)) fail(`${at}.input`, `unsupported input type ${JSON.stringify(bind.input)}${suggest(bind.input, BIND_INPUTS)}`)
}

const SELECTION_RESOLVE = set('global union intersect')
const BRUSH_KEYS = set('cursor fill fillOpacity stroke strokeDash strokeDashOffset strokeOpacity strokeWidth')
/** The channels a selection can project (vega-lite SingleDefUnitChannel). */
const PROJECTABLE_CHANNELS = set(
  'x y xOffset yOffset x2 y2 xError yError xError2 yError2 theta theta2 radius radius2 longitude latitude longitude2 latitude2 color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape key text href url description detail order tooltip',
)

/** An event stream: a selector string or a stream object; both must parse, and a timer (animation) stream is refused. */
function validateStream(v: unknown, at: string, what: string, allowBoolean: boolean): void {
  if (typeof v === 'boolean') {
    if (!allowBoolean) mustBe(at, `${what}: an event stream`)
    return
  }
  const check = (events: ReturnType<typeof parseEventSelectorString>): void => {
    const visit = (e: ReturnType<typeof parseEventSelectorString>[number]): void => {
      if (e.type === 'timer') fail(at, `${what}: timer event streams (animation) are not supported`)
      e.merge?.forEach(visit)
      e.between?.forEach(visit)
      if (e.stream) visit(e.stream)
    }
    events.forEach(visit)
  }
  if (typeof v === 'string') {
    try {
      check(parseEventSelectorString(v, 'scope'))
    } catch (e) {
      if (e instanceof VLCompileError) throw e
      fail(at, `${what}: invalid event selector ${JSON.stringify(v)} (${e instanceof Error ? e.message : String(e)})`)
    }
    return
  }
  if (isObj(v)) {
    if (v.type === 'timer' || JSON.stringify(v).includes('"timer"')) fail(at, `${what}: timer event streams (animation) are not supported`)
    return
  }
  mustBe(at, `${what}: an event selector string or an event stream object`)
}

/** A selection's initial value for one projection: a scalar, a DateTime, or (interval) a [lo, hi] pair of them. */
function validateInitValue(v: unknown, at: string, interval: boolean): void {
  const scalar = (x: unknown): boolean => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || isDateTimeLike(x)
  if (interval) {
    if (!(Array.isArray(v) && v.length === 2 && v.every(scalar))) mustBe(at, 'a [lo, hi] pair of numbers, strings, booleans or DateTime objects')
    ;(v as unknown[]).forEach((x, i) => { if (isDateTimeLike(x)) validateDateTime(x as Obj, `${at}[${i}]`) })
  } else if (!scalar(v)) mustBe(at, 'a number, string, boolean, null or DateTime object')
  else if (isDateTimeLike(v)) validateDateTime(v as Obj, at)
}

/** A DateTime's parts are the numbers (and names) `datetime(...)` is written from: each is checked where the spec gives it. */
function validateDateTime(o: Obj, at: string): void {
  for (const [part, v] of Object.entries(o)) {
    const problem = dateTimePartProblem(part, v)
    if (problem !== undefined) fail(`${at}.${part}`, `a DateTime ${part === 'utc' || problem === 'is not a part of a DateTime' ? '' : `${part} `}${problem}, got ${JSON.stringify(v)}`)
  }
}

/** A value a field predicate compares with: a number, a string, a boolean, null, a DateTime, or an `{expr}` / `{signal}` reference. */
function validatePredicateValue(v: unknown, at: string): void {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return
  if (isObj(v) && Object.keys(v).length === 1 && (typeof v.expr === 'string' || typeof v.signal === 'string')) return
  if (isDateTimeLike(v)) {
    validateDateTime(v as Obj, at)
    return
  }
  mustBe(at, `a number, a string, a boolean, null, a DateTime or an {"expr"} reference, got ${JSON.stringify(v)}`)
}

const isDateTimeLike = (o: unknown): boolean =>
  isObj(o) && CALENDAR_PARTS.some((k) => k in o)

function validateSelection(p: Obj, at: string): void {
  keysOf(p, set('name select value bind description'), at, 'selection parameter')
  if (isObj(p.select) && isTimerSelect(p.select)) {
    // an animation's clock: the one point selection that is supported (see animation.ts)
    if (st().timerParams.size > 1) fail(at, 'only one timer selection is supported (vega-lite 6.4.3 ignores all but the first)')
    for (const reserved of ['unit', 'anim_clock', 'last_tick_at', 'is_playing', 'eased_anim_clock', 'min_extent', 'max_range_extent', 'anim_value']) {
      if (p.name === reserved) fail(`${at}.name`, `"${reserved}" is a signal an animation defines; name the selection something else`)
    }
    validateTimerSelection(p, at, fail)
    return
  }
  let sel = p.select
  if (typeof sel === 'string') sel = { type: sel }
  if (!isObj(sel)) mustBe(`${at}.select`, '"interval", "point" or an object with `type`')
  if (sel.type !== 'interval' && sel.type !== 'point') {
    fail(`${at}.select`, `selection type ${JSON.stringify(sel.type)} is not valid: use "point" or "interval" (the legacy "single" and "multi" types are not supported)`)
  }
  const interval = sel.type === 'interval'
  keysOf(sel, set(interval ? 'type clear encodings fields mark on resolve translate zoom' : 'type clear encodings fields nearest on resolve toggle'), `${at}.select`, `${sel.type} selection`)
  if (sel.on !== undefined) validateStream(sel.on, `${at}.select.on`, 'on', false)
  if (sel.clear !== undefined) validateStream(sel.clear, `${at}.select.clear`, 'clear', true)
  if (sel.resolve !== undefined && !(typeof sel.resolve === 'string' && SELECTION_RESOLVE.has(sel.resolve))) mustBe(`${at}.select.resolve`, '"global", "union" or "intersect"')
  if (sel.encodings !== undefined) {
    if (!Array.isArray(sel.encodings)) mustBe(`${at}.select.encodings`, 'an array of channel names')
    for (const c of sel.encodings) if (typeof c !== 'string' || !PROJECTABLE_CHANNELS.has(c)) unknown(`${at}.select.encodings`, 'channel', c, PROJECTABLE_CHANNELS)
  }
  if (sel.fields !== undefined) {
    if (!Array.isArray(sel.fields) || !sel.fields.every((f) => typeof f === 'string' && f !== '')) mustBe(`${at}.select.fields`, 'an array of field names')
    for (const f of sel.fields as string[]) {
      // (an escaped field, `a\.b`, is one column of the row the selection tests; a nested one is flattened into a column of another name)
      if (f !== '_vgsid_' && accessPath(f, `${at}.select.fields`).length !== 1) {
        fail(`${at}.select.fields`, `a selection cannot be projected over the nested field ${JSON.stringify(f)}`)
      }
    }
  }
  if (!interval) {
    if (sel.toggle !== undefined && typeof sel.toggle !== 'boolean' && typeof sel.toggle !== 'string') mustBe(`${at}.select.toggle`, 'a boolean or an expression string')
    if (sel.nearest !== undefined && typeof sel.nearest !== 'boolean') mustBe(`${at}.select.nearest`, 'a boolean')
  } else {
    for (const k of ['translate', 'zoom'] as const) if (sel[k] !== undefined) validateStream(sel[k], `${at}.select.${k}`, k, true)
    if (sel.mark !== undefined) {
      if (!isObj(sel.mark)) mustBe(`${at}.select.mark`, OBJECT)
      keysOf(sel.mark, BRUSH_KEYS, `${at}.select.mark`, 'brush mark')
    }
  }

  if (p.value !== undefined) {
    const v = p.value
    if (interval) {
      if (!isObj(v)) mustBe(`${at}.value`, 'an object mapping channels to [lo, hi] pairs')
      for (const [k, x] of Object.entries(v)) validateInitValue(x, `${at}.value.${k}`, true)
    } else if (Array.isArray(v)) {
      for (const [i, m] of v.entries()) {
        if (!isObj(m)) mustBe(`${at}.value[${i}]`, 'an object mapping fields or channels to values')
        for (const [k, x] of Object.entries(m)) validateInitValue(x, `${at}.value[${i}].${k}`, false)
      }
    } else validateInitValue(v, `${at}.value`, false)
  }

  if (p.bind !== undefined) {
    const b = p.bind
    if (interval) {
      if (b !== 'scales') fail(`${at}.bind`, 'an interval selection can only be bound to "scales"')
    } else if (b === 'legend') {
      // a legend binding
    } else if (isObj(b) && b.legend !== undefined) {
      keysOf(b, set('legend'), `${at}.bind`, 'legend binding')
      validateStream(b.legend, `${at}.bind.legend`, 'legend', false)
    } else if (isObj(b) && typeof b.input === 'string') {
      validateBinding(b, `${at}.bind`)
    } else if (isObj(b)) {
      for (const [f, x] of Object.entries(b)) {
        if (!isObj(x)) mustBe(`${at}.bind.${f}`, 'an input binding object')
        validateBinding(x, `${at}.bind.${f}`)
      }
    } else mustBe(`${at}.bind`, '"legend", {"legend": stream}, an input binding or a map of field/encoding to input bindings')
  }
}

// --- resolve -----------------------------------------------------------------

/** The channels each kind of resolution maps (vega-lite's ScaleResolveMap, AxisResolveMap, LegendResolveMap). */
const RESOLVE_CHANNELS: Record<'scale' | 'axis' | 'legend', ReadonlySet<string>> = {
  scale: set('x y xOffset yOffset theta radius color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape time'),
  axis: set('x y'),
  legend: set('color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape time'),
}

function validateResolve(r: unknown, path: string, kind: Kind, facetedUnit = false): void {
  if (!isObj(r)) mustBe(path, OBJECT)
  keysOf(r, set('scale axis legend'), path, 'resolve')
  for (const what of ['scale', 'axis', 'legend'] as const) {
    const m = r[what]
    if (m === undefined) continue
    if (!isObj(m)) mustBe(`${path}.${what}`, 'an object mapping channels to "shared" | "independent"')
    for (const [ch, v] of Object.entries(m)) {
      if (!RESOLVE_CHANNELS[what].has(ch)) fail(`${path}.${what}.${ch}`, `unknown ${what} channel "${ch}"${suggest(ch, RESOLVE_CHANNELS[what])}`)
      if (v !== 'shared' && v !== 'independent') mustBe(`${path}.${what}.${ch}`, `"shared" or "independent", got ${JSON.stringify(v)}`)
    }
  }
  // a unit faceted through its encoding is a facet over that unit: its resolve is the facet's
  if (kind === 'unit' && !facetedUnit) fail(path, '`resolve` has no meaning on a single unit spec')
  // (a facet's independent scales, axes and legends are laid out in its cells, each channel's: compile.ts compileFacetedView)
}

// --- unit specs --------------------------------------------------------------

const MARK_DEF_KEYS = set(
  'type align angle aria ariaRole ariaRoleDescription aspect bandSize baseline binSpacing blend clip color continuousBandSize cornerRadius cornerRadiusBottomLeft cornerRadiusBottomRight cornerRadiusEnd ' +
    'cornerRadiusTopLeft cornerRadiusTopRight cursor description dir discreteBandSize dx dy ellipsis fill fillOpacity filled font fontSize fontStyle fontWeight height href innerRadius interpolate invalid ' +
    'limit line lineBreak lineHeight minBandSize opacity order orient outerRadius padAngle point radius radius2 radius2Offset radiusOffset shape size smooth stroke strokeCap strokeDash strokeDashOffset ' +
    'strokeJoin strokeMiterLimit strokeOffset strokeOpacity strokeWidth style tension text theta theta2 theta2Offset thetaOffset thickness time timeUnitBandPosition timeUnitBandSize tooltip url width x x2 ' +
    'x2Offset xOffset y y2 y2Offset yOffset extent median box outliers rule ticks gradient center band borders',
)
/** mark-def properties that Vega-Lite honours but compile.ts does not implement. */
const UNSUPPORTED_MARK_KEYS: Record<string, string> = {
  timeUnitBandPosition: 'timeUnitBandPosition is not supported',
  timeUnitBandSize: 'timeUnitBandSize is not supported',
}

const INVALID_MODES = set('filter show break-paths-filter-domains break-paths-show-domains break-paths-show-path-domains')
function validateInvalidMode(v: unknown, at: string): void {
  if (v !== undefined && v !== null && !(typeof v === 'string' && INVALID_MODES.has(v))) fail(at, `unknown invalid-value mode ${JSON.stringify(v)}: expected ${[...INVALID_MODES].join(', ')} or null`)
}

/** vega-lite `ViewBackground`: the group's own fill / stroke / opacity ..., and whether it clips what it holds. */
const VIEW_BACKGROUND_KEYS = set('cornerRadius fillOpacity opacity strokeCap strokeDash strokeDashOffset strokeJoin strokeMiterLimit strokeOpacity strokeWidth fill stroke cursor style clip')
function validateViewBackground(view: unknown, _kind: string, at: string): void {
  if (!isObj(view)) mustBe(at, OBJECT)
  if (view.clip !== undefined && typeof view.clip !== 'boolean') mustBe(`${at}.clip`, 'a boolean')
  keysOf(view, VIEW_BACKGROUND_KEYS, at, 'view')
  for (const [k, v] of Object.entries(view)) {
    if (k === 'style') {
      if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) mustBe(`${at}.style`, 'a style name or an array of style names')
    } else if (isObj(v)) fail(`${at}.${k}`, 'a signal or expression reference is not supported in a view background; give a literal value')
  }
}

function validateMark(mark: unknown, at: string): string {
  let def: Obj
  if (typeof mark === 'string') def = { type: mark }
  else if (isObj(mark)) def = mark
  else fail(at, 'mark must be a mark name or a mark definition object')
  const type = def.type
  const typeAt = typeof mark === 'string' ? at : `${at}.type`
  if (typeof type !== 'string' || !MARKS.has(type)) unknown(typeAt, 'mark type', type, MARKS)
  if (typeof mark !== 'string') {
    for (const k of Object.keys(def)) {
      if (!MARK_DEF_KEYS.has(k)) fail(`${at}.${k}`, `unknown mark property "${k}"${suggest(k, MARK_DEF_KEYS)}`)
      const why = UNSUPPORTED_MARK_KEYS[k]
      // (what vega-lite ignores on this mark type is consumed as it does, not refused: ignored-table.ts)
      if (why && !ignoredMarkProps(type).has(k)) fail(`${at}.${k}`, why)
      if (k === 'order' && def.order !== false && def.order !== null && def.order !== true) fail(`${at}.order`, 'only order: false/null/true is supported')
    }
    if (def.orient !== undefined && def.orient !== 'horizontal' && def.orient !== 'vertical') mustBe(`${at}.orient`, '"horizontal" or "vertical"')
    validateInvalidMode(def.invalid, `${at}.invalid`)
  }
  return type
}

function validateUnit(spec: Obj, at: (k: string) => string, top = true): void {
  const mark = validateMark(spec.mark, at('mark'))
  const enc = spec.encoding === undefined ? {} : spec.encoding
  // (a line that spans a channel is drawn as a rule: the channels a rule draws are the ones it keeps)
  const drawnAs = mark === 'line' && isObj(enc) && spansAChannel(enc) ? 'rule' : mark
  validateEncoding(enc, at('encoding'), 'unit', drawnAs)
  if (isObj(enc)) validateGeoUnit(drawnAs, enc, at('encoding'))
  validateAnimation(spec, enc, at, drawnAs)
  const faceted = isObj(enc) && (enc.row != null || enc.column != null || enc.facet != null)
  // A map in a facet fits its projection to the facet's data. With a GeoJSON `shape` field (or longitude / latitude) that is a
  // `geojson` transform's signal; a geoshape with no GeoJSON shape channel (none, or a field its legend reads) draws its data as
  // the GeoJSON, and vega-lite fits it to `data("child_main")`, a dataset it never defines (it renders in no engine).
  if ((st().facetDepth > 0 || faceted) && mark === 'geoshape' && !(isObj(enc) && isObj(enc.shape) && enc.shape.type === 'geojson')) {
    fail(at('mark'), 'a geoshape with no `shape` field inside a facet is not supported: vega-lite 6.4.3 fits its projection to a dataset it never defines (data("child_main")), so there is no output to match')
  }
}

/**
 * An animation is a top-level unit with a `time` channel, ONE timer selection param, and a `filter: {param}` transform
 * on it (animation.ts says why vega-lite 6.4.3 needs all three: without them it emits marks that read a dataset it never
 * defines). Anything else that involves a timer selection or the time channel is refused here.
 */
function validateAnimation(spec: Obj, enc: unknown, at: (k: string) => string, mark: string): void {
  // (a geoshape does not draw the time channel: vega-lite drops it)
  const hasTime = isObj(enc) && enc.time != null && draws(enc, 'time', mark)
  if (!hasTime) {
    if (st().timerParams.size) fail(at('params'), 'a timer selection animates the `time` channel: the unit has none')
    return
  }
  const timeAt = at('encoding.time')
  if (!st().validatingTopUnit) fail(timeAt, 'the time channel is supported on a single top-level unit spec only (not inside layer / concat / facet / repeat)')
  if (st().timerParams.size !== 1) fail(timeAt, 'the time channel needs exactly one timer selection param ({"name": "anim", "select": {"type": "point", "on": "timer", "fields": [...]}}): without it vega-lite 6.4.3 emits marks that read a dataset it never defines')
  const [name] = [...st().timerParams]
  const filters = (Array.isArray(spec.transform) ? spec.transform : []).filter((t): t is Obj => isObj(t) && isObj(t.filter) && t.filter.param === name)
  if (filters.length !== 1) fail(at('transform'), `the time channel needs the transform {"filter": {"param": ${JSON.stringify(name)}}} (once): it is the predicate that picks the current frame`)
  const markDef = isObj(spec.mark) ? spec.mark : { type: spec.mark }
  if (['boxplot', 'errorbar', 'errorband'].includes(markDef.type as string)) fail(at('mark'), `a "${String(markDef.type)}" is a layered composite mark: animating it is not supported`)
  if (markDef.point !== undefined || markDef.line !== undefined) fail(at('mark'), 'a point / line overlay makes the unit a layer: animating it is not supported')
  if (isObj(enc) && (enc.row != null || enc.column != null || enc.facet != null)) fail(timeAt, 'an animated unit cannot be faceted (vega-lite 6.4.3 leaves the facet reading the unfiltered data)')
  const def = (enc as Obj).time
  if (!isObj(def) || typeof def.field !== 'string') fail(timeAt, 'the time channel is a field definition ({"field": ..., "type": ...})')
  for (const k of Object.keys(def)) {
    if (!['field', 'type', 'timeUnit', 'title'].includes(k)) fail(`${timeAt}.${k}`, `\`${k}\` is not supported on the time channel (its scale is vega-lite's band scale over the field)`)
  }
  const param = (spec.params as Obj[]).find((p) => p.name === name)!
  if (isObj(param.select) && param.select.encodings !== undefined && def.timeUnit !== undefined) {
    fail(timeAt, 'a time unit on the field cannot be projected by `encodings`: list the field in `fields` (vega-lite 6.4.3 projects the raw field)')
  }
}

/**
 * The map rules of one unit's (merged) encoding: which marks `longitude` / `latitude` can position,
 * that a pair is complete, and that `geojson` shapes belong to `geoshape`. Also run on every layer
 * leaf after a layer's encoding merges into it.
 */
export function validateGeoUnit(mark: string, enc: Obj, path: string): void {
  // (a geo channel the mark does not draw is dropped, as vega-lite drops it; a constant is no position to project, and changes
  // nothing but where a mark with no x or y reads its place from: geopositions of its own)
  const geoChannels = Object.keys(enc).filter((c) => GEO_CHANNELS.has(c) && isFieldOrDatum(enc[c]) && draws(enc, c, mark))
  if (geoChannels.length) {
    if (!GEO_POSITION_MARKS.has(mark)) {
      fail(`${path}.${geoChannels[0]}`, `longitude / latitude positions are only implemented for the ${[...GEO_POSITION_MARKS].join(', ')} marks, not "${mark}"`)
    }
    const given = (c: string): boolean => geoChannels.includes(c)
    for (const [lon, lat] of [['longitude', 'latitude'], ['longitude2', 'latitude2']] as const) {
      if (given(lon) !== given(lat)) fail(`${path}.${given(lon) ? lon : lat}`, `needs its pair: give both \`${lon}\` and \`${lat}\` (vega-lite emits a geopoint transform for a half pair that vega refuses)`)
    }
  }
  if (isObj(enc.shape) && enc.shape.type === 'geojson' && mark !== 'geoshape') {
    fail(`${path}.shape.type`, 'a geojson shape field only applies to the geoshape mark')
  }
  // (the channels a geoshape does not draw - its positions, size and angle - are dropped, as vega-lite drops them)

}

/** A field or a datum definition (not a constant, nor a condition alone). */
function isFieldOrDatum(def: unknown): boolean {
  return isObj(def) && (def.field !== undefined || def.datum !== undefined || def.aggregate === 'count')
}

/** The channels that place a mark: none of them takes a condition in Vega-Lite (its schema gives position definitions none). */
const POSITION_CHANNELS = set('x y x2 y2 xOffset yOffset theta theta2 radius radius2 longitude latitude longitude2 latitude2')

/** A condition that gives a field or a datum (rather than a value). */
function conditionGivesField(cond: unknown): boolean {
  return ([] as unknown[]).concat(cond ?? []).some((c) => isObj(c) && (c.field !== undefined || c.datum !== undefined || c.aggregate === 'count'))
}

// --- encoding ----------------------------------------------------------------

const FIELD_DEF_KEYS = set('field type aggregate bin timeUnit sort stack bandPosition axis scale legend title format formatType condition value datum header impute band')
/** facet channel definitions (row/column/facet) add the layout controls */
const FACET_CHANNEL_DEF_KEYS = set('field type aggregate bin timeUnit sort bandPosition title header columns spacing align center bounds')
const SORT_CHANNELS = set('x y color fill stroke strokeWidth size shape fillOpacity strokeOpacity opacity text')

function validateEncoding(enc: unknown, path: string, where: 'unit' | 'layer', mark?: string): void {
  if (!isObj(enc)) fail(path, 'encoding must be an object')
  for (const [ch, def] of Object.entries(enc)) {
    const at = `${path}.${ch}`
    if (!ALL_CHANNELS.has(ch)) fail(at, `unknown encoding channel "${ch}"${suggest(ch, ALL_CHANNELS)}`)
    if (def === null) continue
    // (a channel the mark does not draw is dropped, as vega-lite drops it: there is nothing of it to check)
    if (mark !== undefined && !draws(enc, ch, mark)) continue
    if ((ch === 'row' || ch === 'column' || ch === 'facet') && where === 'layer') fail(at, 'facet channels are not allowed in a layer encoding (use the facet operator)')
    if (ch === 'detail' || ch === 'order' || ch === 'tooltip' || ch === 'href' || ch === 'description') {
      if (Array.isArray(def)) {
        if (ch === 'href') fail(at, `${ch} cannot be an array`)
        // (vega-lite 6.4.3 reads none of an `order` written as a list - the schema takes one - and draws the chart in the order of its rows or its
        // dimension: a chart that orders by nothing it was asked to, so it is refused, as DECISIONS Q9 has it)
        if (ch === 'order') fail(at, 'order given as a list is refused: vega-lite 6.4.3 reads none of its entries and draws the chart unordered; give one order definition, or `detail` and a `sort` on the channel it orders')
        def.forEach((d, i) => validateChannelDef(ch, d, `${at}[${i}]`))
        continue
      }
    } else if (Array.isArray(def)) fail(at, `channel "${ch}" does not accept an array of definitions`)
    validateChannelDef(ch, def, at, where === 'layer')
  }
}

function validateChannelDef(ch: string, def: unknown, at: string, shared = false): void {
  if (!isObj(def)) fail(at, 'a channel definition must be an object')
  keysOf(def, ch === 'row' || ch === 'column' || ch === 'facet' ? FACET_CHANNEL_DEF_KEYS : FIELD_DEF_KEYS, at, 'channel definition')
  if (def.value !== undefined && (def.field !== undefined || def.datum !== undefined)) fail(at, '`value` cannot be combined with `field`/`datum`')
  if (def.field !== undefined && def.datum !== undefined) fail(at, '`field` and `datum` cannot be combined')
  if (def.field !== undefined) checkFieldName(def.field, `${at}.field`)
  if (def.field === undefined && def.value === undefined && def.datum === undefined && def.aggregate !== 'count' && def.condition === undefined && !shared && !(ch === 'order' && def.sort !== undefined)) {
    fail(at, 'a channel definition needs `field`, `value`, `datum` or `aggregate: "count"`')
  }
  if (def.type !== undefined && !['quantitative', 'ordinal', 'nominal', 'temporal', 'geojson'].includes(def.type as string)) {
    unknown(`${at}.type`, 'type', def.type, ['quantitative', 'ordinal', 'nominal', 'temporal', 'geojson'])
  }
  if (def.type === 'geojson' && ch !== 'shape') fail(`${at}.type`, 'the geojson type only applies to the shape channel of a geoshape mark')
  // (vega-lite builds a scale, an axis and a stack group for the field of such a condition, yet places the mark by the value: there
  // is no coherent output to match)
  if (POSITION_CHANNELS.has(ch) && conditionGivesField(def.condition)) {
    fail(`${at}.condition`, `a condition that gives a field or a datum on a position channel (${ch}) is not supported: a position takes no condition in Vega-Lite`)
  }
  // (a longitude or a latitude projects its raw field whatever its definition says; a count of records has no field to project)
  const geo = GEO_CHANNELS.has(ch)
  if (geo && def.field === undefined && def.aggregate === 'count') {
    fail(`${at}.aggregate`, 'a count of records reads no field: it has no position to project (vega-lite 6.4.3 emits a geopoint transform with no field, which vega cannot run)')
  }
  if (ch === 'shape' && def.type === 'geojson') {
    for (const k of ['aggregate', 'bin', 'timeUnit', 'sort', 'scale', 'legend', 'condition', 'datum', 'value']) {
      if (def[k] !== undefined) fail(`${at}.${k}`, `\`${k}\` does not apply to a geojson shape field`)
    }
    if (def.field === undefined) fail(at, 'a geojson shape needs a `field`')
  }
  if (def.aggregate !== undefined) {
    if (isObj(def.aggregate)) {
      // {argmax: field} / {argmin: field}: the value of `field` on the row where the argument is extreme
      const ks = Object.keys(def.aggregate)
      if (ks.length !== 1 || (ks[0] !== 'argmax' && ks[0] !== 'argmin') || typeof def.aggregate[ks[0]!] !== 'string') {
        fail(`${at}.aggregate`, 'an object aggregate must be {"argmax": field} or {"argmin": field}')
      }
      accessPath(def.aggregate[ks[0]!] as string, `${at}.aggregate.${ks[0]!}`)
      if (def.field === undefined) fail(`${at}.aggregate`, 'argmax/argmin need the channel `field` to read from the winning row')
    } else {
      if (typeof def.aggregate !== 'string') mustBe(`${at}.aggregate`, 'an aggregate operation name')
      if (!AGG_OPS.has(def.aggregate)) unknown(`${at}.aggregate`, 'aggregate', def.aggregate, AGG_OPS)
      if (def.aggregate !== 'count' && def.field === undefined) fail(`${at}.aggregate`, `aggregate "${def.aggregate}" needs a field`)
    }
  }
  // (vega-lite reads pre-binned data on x and y; on a longitude or a latitude it ignores it, and the mark is placed as it is)
  if (def.bin !== undefined) validateBin(def.bin, `${at}.bin`, ch === 'x' || ch === 'y' || geo)
  if ((def.bin === 'binned' || (isObj(def.bin) && def.bin.binned === true)) && ch !== 'x' && ch !== 'y' && !geo) fail(`${at}.bin`, 'pre-binned data (bin: "binned") only applies to the x and y channels')
  if (def.timeUnit !== undefined) {
    normalizeTimeUnit(def.timeUnit, `${at}.timeUnit`)
  }
  if (def.timeUnit !== undefined && def.bin) fail(at, '`timeUnit` and `bin` cannot be combined')
  if (def.sort !== undefined) validateSort(def.sort, `${at}.sort`, ch)
  // "wiggle" is not in the vega-lite 6 schema but vega-lite 6.4.3 accepts it and
  // compiles it unstacked; the corpus pins that, so it is tolerated here.
  if (def.stack !== undefined && !['zero', 'center', 'normalize', 'wiggle', true, false, null].includes(def.stack as never)) {
    fail(`${at}.stack`, `unsupported stack ${JSON.stringify(def.stack)}`)
  }
  if (def.impute !== undefined) {
    // (vega-lite imputes along x and y; on a longitude or a latitude it ignores `impute`)
    if (ch !== 'x' && ch !== 'y' && !geo) fail(`${at}.impute`, '`impute` only applies to the x and y channels')
    const im = def.impute
    if (!isObj(im)) mustBe(`${at}.impute`, OBJECT)
    keysOf(im, set('method value frame keyvals'), `${at}.impute`, 'impute')
    if (im.method !== undefined && !['value', 'median', 'max', 'min', 'mean'].includes(im.method as string)) fail(`${at}.impute.method`, `unknown impute method ${JSON.stringify(im.method)}`)
    if (im.frame !== undefined && !(Array.isArray(im.frame) && im.frame.length === 2)) fail(`${at}.impute.frame`, 'must be a [start, end] pair')
    if (im.keyvals !== undefined) validateImputeKeyvals(im.keyvals, `${at}.impute.keyvals`)
  }
  // (a projected position has no band: vega-lite ignores `band` there)
  if (def.band !== undefined && !geo) fail(`${at}.band`, '`band` is not supported')
  if (def.bandPosition !== undefined && typeof def.bandPosition !== 'number') mustBe(`${at}.bandPosition`, 'a number')
  if (def.condition !== undefined) validateCondition(def.condition, `${at}.condition`)
  for (const k of ['axis', 'legend', 'scale'] as const) {
    if (def[k] !== undefined && def[k] !== null && !isObj(def[k])) mustBe(`${at}.${k}`, 'an object or null')
  }
  if (isObj(def.scale)) validateScaleDef(def.scale, `${at}.scale`)
}

const SCALE_KEYS_OK = set(
  'type domain domainRaw domainMin domainMax domainMid range reverse nice zero padding paddingInner paddingOuter align base clamp constant exponent round bins interpolate scheme rangeMin rangeMax',
)
const SCALE_TYPES = set('linear log pow sqrt symlog identity sequential time utc quantile quantize threshold bin-ordinal ordinal point band')

function validateScaleDef(scale: Obj, at: string): void {
  for (const k of Object.keys(scale)) {
    if (!SCALE_KEYS_OK.has(k)) fail(`${at}.${k}`, `unknown scale property "${k}"${suggest(k, SCALE_KEYS_OK)}`)
  }
  if (scale.domainRaw !== undefined) {
    // (scale.ts domainRaw is an ExprRef | SignalRef: the domain as a signal, set aside from the domain the data gives)
    const r = scale.domainRaw
    if (!(isObj(r) && (typeof r.signal === 'string' || typeof r.expr === 'string'))) mustBe(`${at}.domainRaw`, 'a signal or an expression')
  }
  if (scale.type !== undefined) {
    if (typeof scale.type !== 'string' || !SCALE_TYPES.has(scale.type)) unknown(`${at}.type`, 'scale type', scale.type, SCALE_TYPES)
  }
  if (scale.domain !== undefined) {
    const d = scale.domain
    // vega-lite passes a domain that is neither an array nor 'unaggregated' nor a {param}/{unionWith}/signal object on to
    // vega as it is (a string, a number, `true`: scale/domain.ts parseSingleChannelDomain), where it fails the
    // scale (vega.parse: "Undefined data set name"). So does this: it compiles, and the runtime refuses it.
    if (isObj(d) && typeof (d as Obj).signal !== 'string' && typeof (d as Obj).expr !== 'string') {
      if (d.param !== undefined) {
        keysOf(d, set('param field encoding'), `${at}.domain`, 'domain param')
        checkParamRef(d.param, `${at}.domain.param`)
        if (d.field !== undefined && typeof d.field !== 'string') mustBe(`${at}.domain.field`, 'a field name')
        if (d.encoding !== undefined && !(typeof d.encoding === 'string' && PROJECTABLE_CHANNELS.has(d.encoding))) mustBe(`${at}.domain.encoding`, 'a channel name')
      } else if (d.unionWith !== undefined) {
        keysOf(d, set('unionWith'), `${at}.domain`, 'domain')
        if (!Array.isArray(d.unionWith) || d.unionWith.length === 0) mustBe(`${at}.domain.unionWith`, 'a non-empty array of values')
      } else {
        fail(`${at}.domain`, 'a domain object must be {"param": ...}, {"unionWith": [...]}, a signal or an expression; give an array or "unaggregated"')
      }
    }
  }
}

function validateBin(bin: unknown, at: string, prebinned = false): void {
  if (bin === 'binned') {
    if (!prebinned) fail(at, 'pre-binned data (bin: "binned") is a property of an x or y channel')
    return
  }
  if (bin === true || bin === false) return
  if (!isObj(bin)) fail(at, `bin must be true or a bin-params object, got ${JSON.stringify(bin)}`)
  if (bin.binned === true) {
    if (!prebinned) fail(`${at}.binned`, 'pre-binned data (binned: true) is a property of an x or y channel')
    keysOf(bin, set('binned step'), at, 'pre-binned bin')
    if (bin.step !== undefined && (typeof bin.step !== 'number' || !(bin.step > 0))) mustBe(`${at}.step`, 'a positive number')
    return
  }
  keysOf(bin, set('anchor base binned divide extent maxbins minstep nice step steps'), at, 'bin')
  const num = (k: string, pos = true): void => {
    const v = bin[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || (pos && !(v > 0))) mustBe(`${at}.${k}`, `a positive number, got ${JSON.stringify(v)}`)
  }
  for (const k of ['maxbins', 'minstep', 'base', 'step']) num(k)
  if (bin.anchor !== undefined && typeof bin.anchor !== 'number') mustBe(`${at}.anchor`, 'a number')
  for (const k of ['nice', 'binned']) if (bin[k] !== undefined && typeof bin[k] !== 'boolean') mustBe(`${at}.${k}`, 'a boolean')
  for (const k of ['steps', 'divide']) {
    const v = bin[k]
    if (v !== undefined && !(Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && n > 0))) mustBe(`${at}.${k}`, 'a non-empty array of positive numbers')
  }
  if (isObj(bin.extent) && bin.extent.param !== undefined) {
    // a parameter's value is the extent (bin.ts parseSelectionExtent): the span of a selection's range or of an array parameter
    keysOf(bin.extent, set('param field encoding'), `${at}.extent`, 'bin extent parameter')
    if (typeof bin.extent.param !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(bin.extent.param)) mustBe(`${at}.extent.param`, 'a parameter name')
  } else if (bin.extent !== undefined) {
    if (!(Array.isArray(bin.extent) && bin.extent.length === 2 && bin.extent.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
      mustBe(`${at}.extent`, 'a [min, max] pair of numbers or a {"param"} reference')
    }
    if ((bin.extent as number[])[0]! >= (bin.extent as number[])[1]!) fail(`${at}.extent`, 'min must be less than max')
  }
}

function validateSort(sort: unknown, at: string, ch: string): void {
  if (sort === null || sort === 'ascending' || sort === 'descending') return
  if (typeof sort === 'string') {
    const name = sort.startsWith('-') ? sort.slice(1) : sort
    if (!SORT_CHANNELS.has(name)) fail(at, `unknown sort ${JSON.stringify(sort)}: expected ascending, descending, null, an encoding channel (${[...SORT_CHANNELS].join(', ')}), optionally prefixed with "-"`)
    return
  }
  if (Array.isArray(sort)) {
    if (sort.length === 0) fail(at, 'a sort array must list at least one value')
    for (const v of sort) {
      if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        fail(at, 'sort arrays of DateTime objects are not supported; use strings, numbers or booleans')
      }
    }
    return
  }
  if (isObj(sort)) {
    if (sort.encoding !== undefined) {
      keysOf(sort, set('encoding order'), at, 'sort')
      if (typeof sort.encoding !== 'string' || !SORT_CHANNELS.has(sort.encoding)) unknown(`${at}.encoding`, 'sort channel', sort.encoding, SORT_CHANNELS)
    } else {
      keysOf(sort, set('field op order'), at, 'sort')
      if (sort.field !== undefined) checkFieldName(sort.field, `${at}.field`)
      if (sort.field === undefined && sort.op !== undefined && sort.op !== 'count') fail(at, `op "${String(sort.op)}" needs a \`field\` (only "count" works without one)`)
      if (sort.field === undefined && sort.order === undefined && sort.op === undefined) fail(at, 'an empty sort object has no meaning')
    }
    if (sort.order !== undefined && sort.order !== 'ascending' && sort.order !== 'descending' && sort.order !== null) {
      fail(`${at}.order`, `unknown order ${JSON.stringify(sort.order)}`)
    }
    if (sort.op !== undefined && !(typeof sort.op === 'string' && AGG_OPS.has(sort.op))) unknown(`${at}.op`, 'aggregate', sort.op, AGG_OPS)
    return
  }
  fail(at, `unknown sort form ${JSON.stringify(sort)} on channel "${ch}"`)
}

// --- conditions --------------------------------------------------------------

const FIELD_PREDICATE_KEYS = ['equal', 'lt', 'lte', 'gt', 'gte', 'range', 'oneOf', 'valid'] as const

/**
 * Validate a VL predicate (string expression, field predicate, and/or/not). A `{param}` predicate must name a declared
 * parameter (a `{filter: {param}}` over an interval selection is valid).
 */
function validatePredicate(p: unknown, at: string): void {
  if (typeof p === 'string') return
  if (!isObj(p)) fail(at, `a predicate must be an expression string or an object, got ${JSON.stringify(p)}`)
  if (p.param !== undefined) {
    keysOf(p, set('param empty'), at, 'param predicate')
    checkParamRef(p.param, `${at}.param`)
    if (p.empty !== undefined && typeof p.empty !== 'boolean') mustBe(`${at}.empty`, 'a boolean')
    return
  }
  if (p.and !== undefined || p.or !== undefined || p.not !== undefined) {
    const keys = Object.keys(p)
    if (keys.length !== 1) fail(at, 'and/or/not cannot be combined with other keys')
    const k = keys[0] as 'and' | 'or' | 'not'
    if (k === 'not') validatePredicate(p.not, `${at}.not`)
    else {
      const arr = p[k]
      if (!Array.isArray(arr) || arr.length === 0) mustBe(`${at}.${k}`, 'a non-empty array of predicates')
      arr.forEach((q, i) => validatePredicate(q, `${at}.${k}[${i}]`))
    }
    return
  }
  const op = FIELD_PREDICATE_KEYS.filter((k) => p[k] !== undefined)
  if (op.length !== 1) fail(at, `a field predicate needs exactly one of ${FIELD_PREDICATE_KEYS.join(', ')}; got ${JSON.stringify(Object.keys(p))}`)
  keysOf(p, set(`field timeUnit ${op[0]}`), at, 'field predicate')
  if (typeof p.field !== 'string') fail(`${at}.field`, 'a field predicate needs `field`')
  accessPath(p.field, `${at}.field`)
  if (p.timeUnit !== undefined) normalizeTimeUnit(p.timeUnit, `${at}.timeUnit`)
  if (op[0] === 'oneOf' && !Array.isArray(p.oneOf)) mustBe(`${at}.oneOf`, 'an array')
  if (op[0] === 'range' && !(Array.isArray(p.range) && p.range.length === 2)) mustBe(`${at}.range`, 'a [lower, upper] pair')
  if (op[0] === 'valid' && typeof p.valid !== 'boolean') mustBe(`${at}.valid`, 'a boolean')
  // (the values are written into the predicate's expression: predicate.ts)
  const key = op[0]!
  if (key === 'oneOf' || key === 'range') (p[key] as unknown[]).forEach((v, i) => validatePredicateValue(v, `${at}.${key}[${i}]`))
  else if (key !== 'valid') validatePredicateValue(p[key], `${at}.${key}`)
}

function validateCondition(cond: unknown, at: string): void {
  const one = (c: unknown, a: string, inArray: boolean): void => {
    if (!isObj(c)) fail(a, 'a condition must be an object')
    keysOf(c, set('test param empty value field datum type aggregate bin timeUnit sort scale legend title format formatType bandPosition'), a, 'condition')
    if (c.param !== undefined && c.test !== undefined) fail(a, 'a condition takes `test` or `param`, not both')
    if (c.param !== undefined) {
      checkParamRef(c.param, `${a}.param`)
      if (c.empty !== undefined && typeof c.empty !== 'boolean') mustBe(`${a}.empty`, 'a boolean')
    } else {
      if (c.empty !== undefined) fail(`${a}.empty`, '`empty` only applies to a condition on a `param`')
      if (c.test === undefined) fail(a, 'a condition needs `test` or `param`')
      validatePredicate(c.test, `${a}.test`)
    }
    // (a count needs no field: `{param, aggregate: "count"}` is a field def, conditional.ts ConditionalValueDef / FieldDef)
    const kinds = ['value', 'field', 'datum'].filter((k) => c[k] !== undefined)
    const isCount = kinds.length === 0 && c.aggregate === 'count'
    if (kinds.length !== 1 && !isCount) fail(a, 'a condition needs exactly one of `value`, `field`, `datum`, or `aggregate: "count"`')
    if (inArray && !(kinds[0] === 'value')) fail(a, 'conditions in an array must be value conditions')
    // (a `{repeat}` reference is replaced in a condition's field as in the channel's own: vega-lite normalize/repeater.ts)
    if (c.field !== undefined) checkFieldName(c.field, `${a}.field`)
    if (c.timeUnit !== undefined) normalizeTimeUnit(c.timeUnit, `${a}.timeUnit`)
  }
  if (Array.isArray(cond)) {
    if (cond.length === 0) fail(at, 'a condition array must not be empty')
    cond.forEach((c, i) => one(c, `${at}[${i}]`, true))
  } else one(cond, at, false)
}

// --- transforms --------------------------------------------------------------

const TRANSFORM_KEYS: Record<string, ReadonlySet<string>> = {
  filter: set('filter'),
  calculate: set('calculate as'),
  bin: set('bin field as'),
  timeUnit: set('timeUnit field as'),
  aggregate: set('aggregate groupby'),
  joinaggregate: set('joinaggregate groupby'),
  window: set('window frame groupby ignorePeers sort'),
  stack: set('stack groupby offset sort as'),
  fold: set('fold as'),
  flatten: set('flatten as'),
  pivot: set('pivot value groupby limit op'),
  impute: set('impute key frame groupby keyvals method value'),
  lookup: set('lookup from as default'),
  sample: set('sample'),
  density: set('density groupby cumulative counts bandwidth extent minsteps maxsteps steps resolve as'),
  loess: set('loess on groupby bandwidth as'),
  regression: set('regression on groupby method order extent params as'),
  quantile: set('quantile groupby probs step as'),
  extent: set('extent param'),
}

export const TRANSFORM_NAMES = Object.keys(TRANSFORM_KEYS)
/** The transforms whose key doubles as a secondary key elsewhere, and the key that makes them the primary one. */
const COMPANION: Record<string, string> = { bin: 'field', timeUnit: 'field', extent: 'param' }

/** `keyvals`: the key values to impute over, a list or a `{start, stop, step}` sequence. */
function validateImputeKeyvals(kv: unknown, at: string): void {
  if (Array.isArray(kv)) return
  if (!isObj(kv)) mustBe(at, 'an array or a {start, stop, step} sequence')
  keysOf(kv, set('start stop step'), at, 'keyvals sequence')
  if (typeof kv.stop !== 'number') mustBe(`${at}.stop`, 'a number')
  for (const k of ['start', 'step'] as const) if (kv[k] !== undefined && typeof kv[k] !== 'number') mustBe(`${at}.${k}`, 'a number')
}

function validateFieldList(v: unknown, at: string): void {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) mustBe(at, 'an array of field names')
  ;(v as string[]).forEach((f, i) => accessPath(f, `${at}[${i}]`))
}

function validateTransforms(tr: unknown, at: string): void {
  if (!Array.isArray(tr)) mustBe(at, 'an array of transforms')
  tr.forEach((t, i) => {
    const a = `${at}[${i}]`
    if (!isObj(t)) fail(a, 'a transform must be an object')
    if (t.type !== undefined && !Object.keys(TRANSFORM_KEYS).some((k) => t[k] !== undefined)) {
      fail(a, `Vega-style transforms ({"type": ${JSON.stringify(t.type)}, ...}) are not Vega-Lite; use the Vega-Lite transform forms (${TRANSFORM_NAMES.join(', ')})`)
    }
    const present = TRANSFORM_NAMES.filter((k) => t[k] !== undefined)
    // `bin` / `timeUnit` / `sort` / `on`... appear as secondary keys of other transforms.
    // a key is the transform's discriminator unless it is also a secondary key of another one, in which case the
    // transform's own companion key must be present (`extent` also belongs to density/regression)
    const primary = present.filter((k) => !(k in COMPANION) || t[COMPANION[k]!] !== undefined)
    if (primary.length === 0) {
      const near = Object.keys(t).map((k) => suggest(k, TRANSFORM_NAMES)).find((x) => x.startsWith(' (did you mean'))
      fail(a, `unknown transform; expected one of ${TRANSFORM_NAMES.join(', ')} (keys: ${JSON.stringify(Object.keys(t))})${near ?? ''}`)
    }
    if (primary.length > 1) fail(a, `ambiguous transform: ${primary.join(' + ')}`)
    const kind = primary[0]!
    // (vega-lite 6.4.3 replaces `{repeat}` references in the encoding and the facet only: in a transform it writes the reference into
    // the output as it is, a field "[object Object]" or "" that reads nothing; C83)
    const ref = repeatRefIn(t, a)
    if (ref !== undefined) fail(ref, 'a `{"repeat": ...}` reference in a transform is not supported: vega-lite 6.4.3 replaces repeat references only in the encoding, and leaves this one in its output as a field that reads nothing')
    keysOf(t, TRANSFORM_KEYS[kind]!, a, `${kind} transform`)
    validateTransform(kind, t, a)
  })
}

/** The path of the first `{repeat}` reference below `node`, if any. */
function repeatRefIn(node: unknown, at: string): string | undefined {
  if (isRepeatRef(node)) return at
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const p = repeatRefIn(node[i], `${at}[${i}]`); if (p !== undefined) return p }
  } else if (isObj(node)) {
    // (rows are the user's data, not references)
    for (const [k, v] of Object.entries(node)) { if (k === 'values') continue; const p = repeatRefIn(v, `${at}.${k}`); if (p !== undefined) return p }
  }
  return undefined
}

function validateTransform(kind: string, t: Obj, a: string): void {
  const needStr = (k: string): void => {
    if (typeof t[k] !== 'string' || t[k] === '') mustBe(`${a}.${k}`, 'a non-empty string')
  }
  const asNames = (k = 'as', n?: number): void => {
    const v = t[k]
    if (v === undefined) return
    const list = Array.isArray(v) ? v : [v]
    if (!list.every((s) => typeof s === 'string' && s !== '')) mustBe(`${a}.${k}`, 'a name or an array of names')
    for (const s of list as string[]) {
      if (accessPath(s, `${a}.${k}`).length !== 1) fail(`${a}.${k}`, `output field name ${JSON.stringify(s)} must not contain '.' or '[' (escape with a backslash for a flat name)`)
    }
    if (n !== undefined && list.length > n) fail(`${a}.${k}`, `expects at most ${n} names`)
  }
  if (t.groupby !== undefined) validateFieldList(t.groupby, `${a}.groupby`)
  switch (kind) {
    case 'filter':
      validatePredicate(t.filter, `${a}.filter`)
      break
    case 'calculate':
      needStr('calculate')
      if (typeof t.as !== 'string') fail(`${a}.as`, 'calculate needs `as`')
      asNames()
      break
    case 'bin': {
      needStr('field')
      validateBin(t.bin, `${a}.bin`)
      if (t.bin === false) fail(`${a}.bin`, 'must be true or bin params')
      if (t.as === undefined) fail(`${a}.as`, 'a bin transform needs `as`')
      asNames('as', 2)
      break
    }
    case 'timeUnit':
      needStr('field')
      normalizeTimeUnit(t.timeUnit, `${a}.timeUnit`)
      if (t.as === undefined) fail(`${a}.as`, 'a timeUnit transform needs `as`')
      asNames('as', 1)
      break
    case 'aggregate':
    case 'joinaggregate': {
      const defs = t[kind]
      // (an aggregate with no measures only groups: the distinct values of its groupby)
      if (!Array.isArray(defs) || (defs.length === 0 && kind === 'joinaggregate')) mustBe(`${a}.${kind}`, kind === 'aggregate' ? 'an array of {op, field?, as?}' : 'a non-empty array of {op, field?, as?}')
      defs.forEach((d, i) => {
        const da = `${a}.${kind}[${i}]`
        if (!isObj(d)) mustBe(da, OBJECT)
        keysOf(d, set('op field as'), da, 'aggregate field def')
        if (typeof d.op !== 'string' || !AGG_OPS.has(d.op)) unknown(`${da}.op`, 'aggregate op', d.op, AGG_OPS)
        if (d.op !== 'count' && typeof d.field !== 'string') fail(`${da}.field`, `op "${d.op}" needs a field`)
        if (d.field !== undefined) accessPath(d.field as string, `${da}.field`)
        if (d.as !== undefined && typeof d.as !== 'string') mustBe(`${da}.as`, 'a string')
      })
      break
    }
    case 'window': {
      const defs = t.window
      if (!Array.isArray(defs) || defs.length === 0) mustBe(`${a}.window`, 'a non-empty array of {op, field?, param?, as?}')
      defs.forEach((d, i) => {
        const da = `${a}.window[${i}]`
        if (!isObj(d)) mustBe(da, OBJECT)
        keysOf(d, set('op field param as'), da, 'window field def')
        if (typeof d.op !== 'string' || !WINDOW_OPS.has(d.op)) unknown(`${da}.op`, 'window op', d.op, WINDOW_OPS)
        if (d.op === 'argmax' || d.op === 'argmin') fail(`${da}.op`, `window op "${d.op}" is not supported`)
        if (d.param !== undefined && typeof d.param !== 'number') mustBe(`${da}.param`, 'a number')
      })
      if (t.frame !== undefined && !(Array.isArray(t.frame) && t.frame.length === 2)) fail(`${a}.frame`, 'must be a [start, end] pair (null = unbounded)')
      if (t.sort !== undefined) validateCompareList(t.sort, `${a}.sort`)
      break
    }
    case 'stack':
      needStr('stack')
      asNames('as', 2)
      if (t.offset !== undefined && !['zero', 'center', 'normalize'].includes(t.offset as string)) fail(`${a}.offset`, `unsupported offset ${JSON.stringify(t.offset)}`)
      if (t.sort !== undefined) validateCompareList(t.sort, `${a}.sort`)
      break
    case 'fold':
      validateFieldList(t.fold, `${a}.fold`)
      asNames('as', 2)
      break
    case 'flatten':
      validateFieldList(t.flatten, `${a}.flatten`)
      asNames('as')
      break
    case 'pivot':
      needStr('pivot')
      needStr('value')
      if (t.limit !== undefined && typeof t.limit !== 'number') mustBe(`${a}.limit`, 'a number')
      if (t.op !== undefined && !(typeof t.op === 'string' && AGG_OPS.has(t.op))) unknown(`${a}.op`, 'aggregate op', t.op, AGG_OPS)
      break
    case 'impute':
      needStr('impute')
      needStr('key')
      if (t.method !== undefined && !['value', 'median', 'max', 'min', 'mean'].includes(t.method as string)) fail(`${a}.method`, `unknown impute method ${JSON.stringify(t.method)}`)
      if (t.frame !== undefined && !(Array.isArray(t.frame) && t.frame.length === 2)) fail(`${a}.frame`, 'must be a [start, end] pair')
      if (t.keyvals !== undefined) validateImputeKeyvals(t.keyvals, `${a}.keyvals`)
      break
    case 'lookup':
      needStr('lookup')
      if (!isObj(t.from)) fail(`${a}.from`, 'lookup needs `from`')
      if (t.from.param !== undefined) {
        keysOf(t.from, set('param key fields'), `${a}.from`, 'lookup from')
        checkParamRef(t.from.param, `${a}.from.param`)
        if (st().declaredParams.get(t.from.param as string) !== 'selection') fail(`${a}.from.param`, `cannot look up the variable parameter ${JSON.stringify(t.from.param)}: only a selection can be a lookup source`)
      } else {
        keysOf(t.from, set('data key fields'), `${a}.from`, 'lookup from')
        if (!isObj(t.from.data)) mustBe(`${a}.from.data`, 'a data source object')
        validateDataSourceObj(t.from.data, `${a}.from.data`)
      }
      if (typeof t.from.key !== 'string') mustBe(`${a}.from.key`, 'a field name')
      if (t.from.fields !== undefined) validateFieldList(t.from.fields, `${a}.from.fields`)
      asNames('as')
      break
    case 'sample':
      if (typeof t.sample !== 'number' || !(t.sample >= 0)) mustBe(`${a}.sample`, 'a non-negative number')
      break
    case 'density':
      needStr('density')
      for (const k of ['bandwidth', 'minsteps', 'maxsteps', 'steps']) if (t[k] !== undefined && typeof t[k] !== 'number') mustBe(`${a}.${k}`, 'a number')
      if (t.extent !== undefined && !(Array.isArray(t.extent) && t.extent.length === 2)) mustBe(`${a}.extent`, '[min, max]')
      if (t.resolve !== undefined && t.resolve !== 'shared' && t.resolve !== 'independent') mustBe(`${a}.resolve`, '"shared" or "independent"')
      asNames('as', 2)
      break
    case 'loess':
      needStr('loess')
      needStr('on')
      asNames('as', 2)
      break
    case 'regression':
      needStr('regression')
      needStr('on')
      if (t.method !== undefined && !['linear', 'log', 'exp', 'pow', 'quad', 'poly'].includes(t.method as string)) fail(`${a}.method`, `unknown regression method ${JSON.stringify(t.method)}`)
      if (t.params !== undefined && typeof t.params !== 'boolean') mustBe(`${a}.params`, 'a boolean')
      asNames('as', 2)
      break
    case 'quantile':
      needStr('quantile')
      asNames('as', 2)
      break
    case 'extent':
      needStr('extent')
      needStr('param')
      if (typeof t.param !== 'string' || t.param === '') mustBe(`${a}.param`, 'a non-empty string')
      break
  }
}

function validateCompareList(sort: unknown, at: string): void {
  if (!Array.isArray(sort)) mustBe(at, 'an array of {field, order}')
  sort.forEach((s, i) => {
    if (!isObj(s)) mustBe(`${at}[${i}]`, OBJECT)
    keysOf(s, set('field order'), `${at}[${i}]`, 'sort field')
    if (typeof s.field !== 'string') mustBe(`${at}[${i}].field`, 'a field name')
    if (s.order !== undefined && s.order !== 'ascending' && s.order !== 'descending') fail(`${at}[${i}].order`, 'unknown order')
  })
}

function validateDataSourceObj(d: Obj, at: string): void {
  if (d.values === undefined && d.url === undefined && d.name === undefined) fail(at, 'needs `values`, `url` or `name`')
  keysOf(d, set('values url name format'), at, 'data')
}

// --- facet / repeat operators ------------------------------------------------

function validateFacetOperator(spec: Obj, at: (k: string) => string, selOk: boolean, depth: number): void {
  const facet = spec.facet
  if (!isObj(facet)) mustBe(at('facet'), 'a field definition or {row, column}')
  if (!isObj(spec.spec)) fail(at('spec'), 'a facet spec needs a nested `spec`')
  const mapping = facet.row !== undefined || facet.column !== undefined
  const checkFacetDef = (d: unknown, a: string): void => {
    if (!isObj(d)) mustBe(a, 'a field definition')
    keysOf(d, set('field type aggregate bin timeUnit sort title header bandPosition'), a, 'facet field definition')
    if (typeof d.field !== 'string') fail(`${a}.field`, 'a facet field definition needs `field`')
    accessPath(d.field, `${a}.field`)
    if (d.bin !== undefined) validateBin(d.bin, `${a}.bin`)
    if (d.timeUnit !== undefined) normalizeTimeUnit(d.timeUnit, `${a}.timeUnit`)
    if (d.sort !== undefined) {
      const s = d.sort
      if (!(s === 'ascending' || s === 'descending' || s === null || Array.isArray(s) || isObj(s))) fail(`${a}.sort`, 'unknown facet sort form')
      if (isObj(s) || Array.isArray(s)) validateSort(s, `${a}.sort`, 'row')
      if (isObj(s) && typeof s.field !== 'string' && s.op !== 'count') fail(`${a}.sort.field`, 'a facet sort by an aggregate needs the `field` to aggregate')
    }
    // (`header: null`: no title and no labels - a wrapped facet's labels stay, as vega-lite's do)
    if (d.header !== undefined && d.header !== null && !isObj(d.header)) mustBe(`${a}.header`, `${OBJECT} or null`)
  }
  if (mapping) {
    keysOf(facet, set('row column'), at('facet'), 'facet mapping')
    if (facet.row !== undefined) checkFacetDef(facet.row, at('facet.row'))
    if (facet.column !== undefined) checkFacetDef(facet.column, at('facet.column'))
    if (spec.columns !== undefined) fail(at('columns'), '`columns` only applies to a single-field (wrapped) facet')
  } else {
    checkFacetDef(facet, at('facet'))
    checkColumns(spec, at)
  }
  st().facetDepth++
  try { validateView(spec.spec as Obj, at('spec'), false, 'facet', selOk, depth + 1) } finally { st().facetDepth-- }
}

function validateRepeatOperator(spec: Obj, at: (k: string) => string, selOk: boolean, depth: number): void {
  const rep = spec.repeat
  if (!isObj(spec.spec)) fail(at('spec'), 'a repeat spec needs a nested `spec`')
  const fieldArr = (v: unknown, a: string): void => {
    // (the schema allows only an array; vega-lite 6.4.3 iterates a string as the list of its characters, `"bc"` repeats the fields `b`
    // and `c`, so its chart is the chart of the name only when the name is one character long: C83)
    if (typeof v === 'string') fail(a, `must be an array of field names (${JSON.stringify([v])}): vega-lite 6.4.3 reads the string ${JSON.stringify(v)} as the list of its characters`)
    if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string')) mustBe(a, 'a non-empty array of field names')
    ;(v as string[]).forEach((f, i) => accessPath(f, `${a}[${i}]`))
  }
  if (Array.isArray(rep)) {
    fieldArr(rep, at('repeat'))
    checkColumns(spec, at)
  } else if (isObj(rep)) {
    keysOf(rep, set('row column layer'), at('repeat'), 'repeat')
    for (const k of ['row', 'column', 'layer'] as const) if (rep[k] !== undefined) fieldArr(rep[k], at(`repeat.${k}`))
    if (rep.layer !== undefined && (rep.row !== undefined || rep.column !== undefined)) fail(at('repeat'), 'layer repeats combined with row/column are not supported')
    if (spec.columns !== undefined) fail(at('columns'), '`columns` only applies to an array repeat')
  } else mustBe(at('repeat'), 'an array of fields or {row, column, layer}')
  const prev = st().repeatVars
  const vars = new Set(prev)
  if (Array.isArray(rep)) vars.add('repeat')
  else if (isObj(rep)) for (const k of ['row', 'column', 'layer']) if (rep[k] !== undefined) vars.add(k)
  st().repeatVars = vars
  try {
    validateView(spec.spec as Obj, at('spec'), false, 'repeat', selOk, depth + 1)
  } finally {
    st().repeatVars = prev
  }
}
