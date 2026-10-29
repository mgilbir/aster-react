/**
 * Explicit validation layer for Vega-Lite input (audit C34-C37, C97).
 *
 * `@aster/vl` implements a subset of Vega-Lite. Anything outside that subset
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
import { isTimerSelect, validateTimerSelection } from './animation.js'
import { parseEventSelectorString } from './event-selector.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

function fail(path: string, msg: string): never {
  throw new VLCompileError(`${path || '<spec>'}: ${msg}`)
}

/** `path: must be <what>` (the message most checks share). */
function mustBe(path: string, what: string): never {
  return fail(path, `must be ${what}`)
}
const OBJECT = 'an object'

function keysOf(o: Obj, allowed: ReadonlySet<string>, path: string, what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) fail(path, `unknown ${what} property "${k}"`)
  }
}

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean))

// --- vocabularies (from the vega-lite 6.4.3 JSON schema) ---------------------

export const MARKS = set('arc area bar image line point rect rule text tick trail circle square geoshape boxplot errorbar errorband')
/** Marks compile.ts implements end to end: every schema mark. */
export const SUPPORTED_MARKS: ReadonlySet<string> = new Set(MARKS)
/** The marks that can be positioned by `longitude` / `latitude`; the other marks' geographic placement is not implemented. */
const GEO_POSITION_MARKS = set('point circle square text line trail rule')

const ALL_CHANNELS = set(
  'x y x2 y2 xOffset yOffset xError xError2 yError yError2 theta theta2 radius radius2 latitude longitude latitude2 longitude2 ' +
    'color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape text tooltip href url description key detail order time ' +
    'row column facet',
)
/** Schema channels compile.ts does not consume (everything else in ALL_CHANNELS is supported; the rest throws). */
const UNSUPPORTED_CHANNELS = set('theta2 radius2 key')
const GEO_CHANNELS = set('longitude latitude longitude2 latitude2')
const SUPPORTED_CHANNELS: ReadonlySet<string> = new Set([...ALL_CHANNELS].filter((c) => !UNSUPPORTED_CHANNELS.has(c)))

const AGG_OPS = set(
  'argmax argmin average count distinct max mean median min missing product q1 q3 ci0 ci1 stderr stdev stdevp sum valid values variance variancep exponential exponentialb',
)
/** The window-only operations plus every aggregate operation except the two exponential ones. */
const WINDOW_OPS: ReadonlySet<string> = new Set([
  ...set('row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value'),
  ...[...AGG_OPS].filter((o) => o !== 'exponential' && o !== 'exponentialb'),
])

const SINGLE_TIME_UNITS = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds']
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
 * {unit, utc, step} object). Throws for unknown units, `binned` and `maxbins`.
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
    fail(path, `unknown timeUnit ${JSON.stringify(tu)}`)
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
const TOP_ONLY = 'datasets usermeta $schema config autosize background padding'
/** Keys every view (root or nested) may carry. */
const VIEW_COMMON = 'name description title data transform'
/** Layout keys the composition operators share. vega-lite accepts (and ignores) width/height on them; the corpus pins that. */
const COMPOSE = 'bounds center spacing resolve width height'
/** Each view kind's own keys (after the common ones). */
const OWN_KEYS: Record<Kind, string> = {
  unit: 'mark encoding width height projection view resolve align bounds center spacing',
  layer: 'layer encoding width height projection view resolve',
  hconcat: `hconcat ${COMPOSE}`,
  vconcat: `vconcat ${COMPOSE}`,
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
 * Which child kinds each composition operator accepts (vega-lite 6 schema) AND
 * this compiler implements. A schema-valid but unimplemented nesting reports
 * "not supported yet"; a schema-invalid one reports "not allowed".
 */
const ANY_VIEW: readonly Kind[] = ['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']
const SCHEMA_CHILDREN: Record<Exclude<Kind, 'unit'>, ReadonlySet<Kind>> = {
  layer: new Set<Kind>(['unit', 'layer']),
  hconcat: new Set<Kind>(ANY_VIEW),
  vconcat: new Set<Kind>(ANY_VIEW),
  concat: new Set<Kind>(ANY_VIEW),
  facet: new Set<Kind>(['unit', 'layer']),
  repeat: new Set<Kind>(ANY_VIEW),
}
/** Implemented (parent -> child) nestings: today every schema-valid nesting is implemented; narrow this as the schema grows. */
export const SUPPORTED_NESTING: Record<Exclude<Kind, 'unit'>, ReadonlySet<Kind>> = SCHEMA_CHILDREN

/** The names of the timer selections declared on the top-level unit being validated (the only place `{param}` filters may refer to). */
let timerParams: ReadonlySet<string> = new Set()
/** The names of every timer selection param in the spec (an animation's selection may sit in a view that has a name). */
let timerNames: Set<string> = new Set()
/** Is the view being validated a top-level unit (where selection params live)? */
let validatingTopUnit = false

/** Depth of facet operators above the view being validated (a map inside a facet is not supported). */
let compositeDepth = 0

/** Repeat variables in scope while validating a repeat's child spec. */
let repeatVars: ReadonlySet<string> = new Set()

/** True for a `{repeat: "row"|"column"|"repeat"|"layer"}` field reference. */
function isRepeatRef(v: unknown): v is { repeat: string } {
  return isObj(v) && Object.keys(v).length === 1 && typeof v.repeat === 'string'
}

function checkFieldName(f: unknown, at: string): void {
  if (isRepeatRef(f)) {
    if (!repeatVars.has(f.repeat)) fail(at, `{"repeat": ${JSON.stringify(f.repeat)}} is used outside a matching \`repeat\` (in scope: ${[...repeatVars].join(', ') || 'none'})`)
    return
  }
  if (typeof f !== 'string' || f === '') fail(at, `must be a non-empty string, got ${JSON.stringify(f)}`)
  splitAccessPath(f) // throws on a malformed access path
}

/** The parameters the spec declares, by name: `selection` or `variable`. A param referenced anywhere must be one of these. */
let declaredParams: Map<string, 'selection' | 'variable'> = new Map()

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
  if (!declaredParams.has(name)) fail(at, `parameter ${JSON.stringify(name)} is not declared in \`params\``)
}

export function validateSpec(spec: unknown): void {
  if (!isObj(spec)) fail('', 'a Vega-Lite spec must be a JSON object')
  repeatVars = new Set()
  compositeDepth = 0
  timerParams = new Set()
  validatingTopUnit = false
  declaredParams = new Map()
  timerNames = new Set()
  collectParams(spec, declaredParams, timerNames)
  paramNamesSeen = new Set()
  validateView(spec, '', true, undefined, true)
}

/** A view that carries a name names its marks and units after it; the selections' fixed names would then disagree. */
function checkNamedSelectionView(spec: Obj, at: (k: string) => string): void {
  // (a timer selection is the exception: an animation's signals are not named after the view, only its tuple's `unit` is)
  if (spec.name !== undefined && ((Array.isArray(spec.params) && spec.params.some((p) => isObj(p) && p.select !== undefined && !isTimerSelect(p.select))))) {
    fail(at('name'), 'a view with selection parameters cannot be named: vega-lite names its marks, signals and units after the view, which @aster/vl does not reproduce')
  }
}

/** Every parameter name must be unique across the whole spec. */
let paramNamesSeen: Set<string> = new Set()

function validateView(spec: Obj, path: string, top: boolean, parent: Kind | undefined, selOk: boolean): void {
  const kind = viewKind(spec, path)
  const at = (k: string): string => (path ? `${path}.${k}` : k)
  if (!top && spec.config !== undefined) fail(at('config'), 'config is only allowed at the top level of a spec')
  keysOf(spec, top ? KEYS[kind].top : KEYS[kind].nested, path, top ? 'top-level' : `nested ${kind}-spec`)
  if (!top && parent) {
    const allowed = SCHEMA_CHILDREN[parent as Exclude<Kind, 'unit'>]
    if (!allowed.has(kind)) fail(path, `a ${kind} spec is not allowed inside \`${parent}\` (vega-lite schema)`)
    if (!SUPPORTED_NESTING[parent as Exclude<Kind, 'unit'>].has(kind)) {
      fail(path, `a ${kind} spec nested inside \`${parent}\` is valid Vega-Lite but is not supported by @aster/vl yet`)
    }
  }
  if (spec.$schema !== undefined && typeof spec.$schema !== 'string') mustBe(at('$schema'), 'a string')

  validatingTopUnit = top && kind === 'unit'
  timerParams = validatingTopUnit && Array.isArray(spec.params)
    ? new Set((spec.params as unknown[]).filter((p): p is Obj => isObj(p) && isObj(p.select) && isTimerSelect(p.select) && typeof p.name === 'string').map((p) => p.name as string))
    : new Set()
  validateData(spec, at)
  if (spec.transform !== undefined) validateTransforms(spec.transform, at('transform'))
  validateSize(spec, at, top && (kind === 'unit' || kind === 'layer'))
  if (spec.params !== undefined) validateParams(spec.params, at('params'), kind !== 'layer' && selOk, kind, spec, at('params'))
  checkNamedSelectionView(spec, at)
  if (top && spec.name !== undefined && [...declaredParams].some(([n, k]) => k === 'selection' && !timerNames.has(n))) fail(at('name'), 'a named spec cannot declare selection parameters: vega-lite names its marks, signals and units after the view, which @aster/vl does not reproduce')
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
  if (spec.datasets !== undefined && !isObj(spec.datasets)) mustBe(at('datasets'), 'an object mapping names to arrays')
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
        validateView(c, `${at('layer')}[${i}]`, false, 'layer', selOk)
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
        validateView(c, `${at(kind)}[${i}]`, false, kind, selOk)
      })
      if (spec.columns !== undefined && kind !== 'concat') fail(at('columns'), '`columns` is only valid on `concat`')
      checkColumns(spec, at)
      break
    }
    case 'facet':
      validateFacetOperator(spec, at, selOk, top)
      break
    case 'repeat':
      validateRepeatOperator(spec, at, selOk)
      break
  }
}

/** `columns`, when present, is a positive integer. */
function checkColumns(spec: Obj, at: (k: string) => string): void {
  if (spec.columns !== undefined && !(Number.isInteger(spec.columns) && (spec.columns as number) > 0)) mustBe(at('columns'), 'a positive integer')
}

function validateAutosize(a: unknown, path: string): void {
  if (typeof a === 'string') {
    if (!['pad', 'none', 'fit', 'fit-x', 'fit-y'].includes(a)) fail(path, `unknown autosize ${JSON.stringify(a)}`)
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
      fail(at(k), `${k}: "container" is only supported on a top-level unit or layer view; give a number or {"step": n}`)
    }
    fail(at(k), `${k} must be a non-negative number or {"step": n}, got ${JSON.stringify(v)}`)
  }
}

// --- data --------------------------------------------------------------------

function validateData(spec: Obj, at: (k: string) => string): void {
  const data = spec.data
  if (data === undefined) return
  if (data === null) fail(at('data'), 'data: null is not supported')
  if (!isObj(data)) mustBe(at('data'), OBJECT)
  const kinds = ['values', 'url', 'name', 'sequence', 'sphere', 'graticule'].filter((k) => data[k] !== undefined)
  if (kinds.length === 0) fail(at('data'), 'needs one of `values`, `url`, `name`')
  if (data.sequence !== undefined) {
    if (kinds.length > 1) fail(at('data'), 'a `sequence` data generator cannot be combined with another data source')
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
    'customFormatTypes numberFormatType normalizedNumberFormatType timeFormatType selection',
)
const CONFIG_SCALE_KEYS = set(
  'bandPaddingInner bandPaddingOuter barBandPaddingInner tickBandPaddingInner rectBandPaddingInner bandWithNestedOffsetPaddingInner bandWithNestedOffsetPaddingOuter offsetBandPaddingInner offsetBandPaddingOuter pointPadding continuousPadding round nice zero xReverse clamp useUnaggregatedDomain invalid minBandSize maxBandSize minFontSize maxFontSize minOpacity maxOpacity minSize maxSize minStrokeWidth maxStrokeWidth quantileCount quantizeCount framesPerSecond animationDuration',
)

function validateConfig(cfg: Obj, path: string): void {
  for (const k of Object.keys(cfg)) {
    if (!CONFIG_KEYS.has(k)) {
      fail(`${path}.${k}`, 'this config property is valid Vega-Lite but is not supported by @aster/vl (it would be silently ignored)')
    }
  }
  if (cfg.scale !== undefined) {
    if (!isObj(cfg.scale)) mustBe(`${path}.scale`, OBJECT)
    for (const k of Object.keys(cfg.scale)) {
      if (!CONFIG_SCALE_KEYS.has(k)) fail(`${path}.scale.${k}`, 'this scale config property is not supported by @aster/vl')
    }
    const inv = cfg.scale.invalid
    if (inv !== undefined) {
      if (!isObj(inv)) fail(`${path}.scale.invalid`, 'must map scale channels to "zero-or-min" or {"value": ...}')
      for (const [ch, v] of Object.entries(inv)) {
        if (!ALL_CHANNELS.has(ch)) fail(`${path}.scale.invalid.${ch}`, 'unknown scale channel')
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
function pushdownProblem(node: unknown): string | undefined {
  if (!isObj(node)) return undefined
  const mark = node.mark
  const markType = typeof mark === 'string' ? mark : isObj(mark) ? mark.type : undefined
  if (['boxplot', 'errorbar', 'errorband'].includes(markType as string)) return `a ${markType as string} is a layer once vega-lite has normalized it`
  if (Array.isArray(node.layer)) return 'a layer below would declare the selection\'s signals twice in one Vega scope, which Vega rejects'
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
    if (typeof p.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(p.name)) fail(`${at}.name`, `parameter names must be identifiers, got ${JSON.stringify(p.name)}`)
    if (paramNamesSeen.has(p.name)) fail(`${at}.name`, `duplicate parameter name "${p.name}"`)
    paramNamesSeen.add(p.name)
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
    if (p.expr !== undefined && p.value !== undefined) fail(at, '`expr` and `value` cannot be combined')
    if (p.expr !== undefined && typeof p.expr !== 'string') mustBe(`${at}.expr`, 'an expression string')
    if (p.push !== undefined) fail(`${at}.push`, '`push` is not a Vega-Lite parameter property (it is Vega\'s signal scoping, which vega-lite sets itself where it needs it)')
    if (p.react !== undefined && p.react !== false && p.react !== true) mustBe(`${at}.react`, 'a boolean')
    if (p.bind !== undefined) {
      if (p.expr !== undefined) fail(`${at}.bind`, 'a parameter with `expr` cannot be bound to an input')
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
  if (typeof bind.input !== 'string' || !BIND_INPUTS.has(bind.input)) fail(`${at}.input`, `unsupported input type ${JSON.stringify(bind.input)}`)
}

const SELECTION_RESOLVE = set('global union intersect')
const BRUSH_KEYS = set('cursor fill fillOpacity stroke strokeDash strokeDashOffset strokeOpacity strokeWidth')
/** The channels a selection can project (vega-lite SingleDefUnitChannel). */
const PROJECTABLE_CHANNELS = set(
  'x y xOffset yOffset x2 y2 xError yError xError2 yError2 theta theta2 radius radius2 color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape key text href url description detail order tooltip',
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
  } else if (!scalar(v)) mustBe(at, 'a number, string, boolean, null or DateTime object')
}

const isDateTimeLike = (o: unknown): boolean =>
  isObj(o) && ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'].some((k) => k in o)

function validateSelection(p: Obj, at: string): void {
  keysOf(p, set('name select value bind description'), at, 'selection parameter')
  if (isObj(p.select) && isTimerSelect(p.select)) {
    // an animation's clock: the one point selection that is supported (see animation.ts)
    if (timerParams.size > 1) fail(at, 'only one timer selection is supported (vega-lite 6.4.3 ignores all but the first)')
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
    for (const c of sel.encodings) if (typeof c !== 'string' || !PROJECTABLE_CHANNELS.has(c)) fail(`${at}.select.encodings`, `unknown channel ${JSON.stringify(c)}`)
  }
  if (sel.fields !== undefined) {
    if (!Array.isArray(sel.fields) || !sel.fields.every((f) => typeof f === 'string' && f !== '')) mustBe(`${at}.select.fields`, 'an array of field names')
    for (const f of sel.fields as string[]) {
      if (f !== '_vgsid_' && (splitAccessPath(f).length !== 1 || splitAccessPath(f)[0] !== f)) {
        fail(`${at}.select.fields`, `a selection cannot be projected over the nested or escaped field ${JSON.stringify(f)}`)
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

const RESOLVE_CHANNELS = set('x y xOffset yOffset theta radius color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape time')

function validateResolve(r: unknown, path: string, kind: Kind, facetedUnit = false): void {
  if (!isObj(r)) mustBe(path, OBJECT)
  keysOf(r, set('scale axis legend'), path, 'resolve')
  for (const what of ['scale', 'axis', 'legend'] as const) {
    const m = r[what]
    if (m === undefined) continue
    if (!isObj(m)) mustBe(`${path}.${what}`, 'an object mapping channels to "shared" | "independent"')
    for (const [ch, v] of Object.entries(m)) {
      if (!RESOLVE_CHANNELS.has(ch)) fail(`${path}.${what}.${ch}`, `unknown channel "${ch}"`)
      if (v !== 'shared' && v !== 'independent') mustBe(`${path}.${what}.${ch}`, `"shared" or "independent", got ${JSON.stringify(v)}`)
    }
  }
  // a unit faceted through its encoding is a facet over that unit: its resolve is the facet's
  if (kind === 'unit' && !facetedUnit) fail(path, '`resolve` has no meaning on a single unit spec')
  if (kind === 'facet' || facetedUnit) {
    for (const what of ['scale', 'axis', 'legend'] as const) {
      const m = r[what]
      if (!isObj(m)) continue
      for (const [ch, v] of Object.entries(m)) {
        if (v !== 'independent') continue
        // only independent x / y scales are laid out (each cell with its own scale and axes); a guide's own resolution is not
        if (what === 'scale' && (ch === 'x' || ch === 'y')) continue
        fail(`${path}.${what}.${ch}`, `an independent ${what} resolution of ${ch} inside a facet is not supported yet (independent x and y scales are)`)
      }
    }
  }
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
const POSITIONAL_MARK_DEF = 'positional mark-def constants (x/x2/y/y2) are not supported; use encoding'
const UNSUPPORTED_MARK_KEYS: Record<string, string> = {
  timeUnitBandPosition: 'timeUnitBandPosition is not supported',
  timeUnitBandSize: 'timeUnitBandSize is not supported',
  x: POSITIONAL_MARK_DEF,
  x2: POSITIONAL_MARK_DEF,
  y: POSITIONAL_MARK_DEF,
  y2: POSITIONAL_MARK_DEF,
  theta: 'mark-def theta is not supported; use encoding',
  theta2: 'mark-def theta2 is not supported; use encoding',
  radius2: 'mark-def radius2 is not supported',
}

const INVALID_MODES = set('filter show break-paths-filter-domains break-paths-show-domains break-paths-show-path-domains')
function validateInvalidMode(v: unknown, at: string): void {
  if (v !== undefined && v !== null && !(typeof v === 'string' && INVALID_MODES.has(v))) fail(at, `unknown invalid-value mode ${JSON.stringify(v)}: expected ${[...INVALID_MODES].join(', ')} or null`)
}

/** vega-lite `ViewBackground`: the group's own fill / stroke / opacity ..., on a unit or a layer. */
const VIEW_BACKGROUND_KEYS = set('cornerRadius fillOpacity opacity strokeCap strokeDash strokeDashOffset strokeJoin strokeMiterLimit strokeOpacity strokeWidth fill stroke cursor style')
function validateViewBackground(view: unknown, kind: string, at: string): void {
  if (kind !== 'unit' && kind !== 'layer') fail(at, `\`view\` is a property of a unit or a layer spec, not of a ${kind}`)
  if (!isObj(view)) mustBe(at, OBJECT)
  keysOf(view, VIEW_BACKGROUND_KEYS, at, 'view')
  for (const [k, v] of Object.entries(view)) {
    if (k === 'style') {
      if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) mustBe(`${at}.style`, 'a style name or an array of style names')
    } else if (isObj(v)) fail(`${at}.${k}`, 'a signal or expression reference is not supported in a view background; give a literal value')
  }
}

/** The marks pointPosition places (position-point.ts): the mark def's x / y stand for a missing channel. */
const POINT_POSITIONED_MARKS = set('point circle square text')

function validateMark(mark: unknown, at: string): string {
  let def: Obj
  if (typeof mark === 'string') def = { type: mark }
  else if (isObj(mark)) def = mark
  else fail(at, 'mark must be a mark name or a mark definition object')
  const type = def.type
  const typeAt = typeof mark === 'string' ? at : `${at}.type`
  if (typeof type !== 'string' || !MARKS.has(type)) fail(typeAt, `unknown mark type ${JSON.stringify(type)}`)
  if (!SUPPORTED_MARKS.has(type)) fail(typeAt, `mark type "${type}" is not supported by @aster/vl yet`)
  if (typeof mark !== 'string') {
    for (const k of Object.keys(def)) {
      if (!MARK_DEF_KEYS.has(k)) fail(`${at}.${k}`, `unknown mark property "${k}"`)
      const why = UNSUPPORTED_MARK_KEYS[k]
      // a point-positioned mark takes its x / y from the mark def: a number, or the view's `width` / `height` (valueref.ts widthHeightValueOrSignalRef)
      if (why && (k === 'x' || k === 'y') && POINT_POSITIONED_MARKS.has(type)) {
        const edge = k === 'x' ? 'width' : 'height'
        if (typeof def[k] !== 'number' && def[k] !== edge) mustBe(`${at}.${k}`, `a number or "${edge}" (an expression or signal is not supported)`)
        continue
      }
      if (why) fail(`${at}.${k}`, why)
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
  validateEncoding(enc, at('encoding'), 'unit', mark)
  if (isObj(enc)) validateGeoUnit(mark, enc, at('encoding'))
  validateAnimation(spec, enc, at)
  const faceted = isObj(enc) && (enc.row != null || enc.column != null || enc.facet != null)
  if (!top && isObj(enc) && enc.facet != null) fail(at('encoding.facet'), 'a wrapped facet (the `facet` channel) nested in another composition is not supported yet')
  if ((compositeDepth > 0 || faceted) && (mark === 'geoshape' || spec.projection !== undefined || (isObj(enc) && Object.keys(enc).some((c) => GEO_CHANNELS.has(c) && enc[c] != null)))) {
    fail(at('mark'), 'maps (geoshape marks, projections, longitude / latitude) inside a facet are not supported: vega-lite 6.4.3 fits a facet\'s projection to a dataset it never defines (data("child_main")), so there is no output to match')
  }
}

/**
 * An animation is a top-level unit with a `time` channel, ONE timer selection param, and a `filter: {param}` transform
 * on it (animation.ts says why vega-lite 6.4.3 needs all three: without them it emits marks that read a dataset it never
 * defines). Anything else that involves a timer selection or the time channel is refused here.
 */
function validateAnimation(spec: Obj, enc: unknown, at: (k: string) => string): void {
  const hasTime = isObj(enc) && enc.time != null
  if (!hasTime) {
    if (timerParams.size) fail(at('params'), 'a timer selection animates the `time` channel: the unit has none')
    return
  }
  const timeAt = at('encoding.time')
  if (!validatingTopUnit) fail(timeAt, 'the time channel is supported on a single top-level unit spec only (not inside layer / concat / facet / repeat)')
  if (timerParams.size !== 1) fail(timeAt, 'the time channel needs exactly one timer selection param ({"name": "anim", "select": {"type": "point", "on": "timer", "fields": [...]}}): without it vega-lite 6.4.3 emits marks that read a dataset it never defines')
  const [name] = [...timerParams]
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
  const geoChannels = Object.keys(enc).filter((c) => GEO_CHANNELS.has(c) && enc[c] != null)
  if (geoChannels.length) {
    if (!GEO_POSITION_MARKS.has(mark)) {
      fail(`${path}.${geoChannels[0]}`, `longitude / latitude positions are only implemented for the ${[...GEO_POSITION_MARKS].join(', ')} marks, not "${mark}"`)
    }
    const given = (c: string): boolean => enc[c] != null
    for (const [lon, lat] of [['longitude', 'latitude'], ['longitude2', 'latitude2']] as const) {
      if (given(lon) !== given(lat)) fail(`${path}.${given(lon) ? lon : lat}`, `needs its pair: give both \`${lon}\` and \`${lat}\` (vega-lite emits a geopoint transform for a half pair that vega refuses)`)
    }
    const projected = ['longitude', 'latitude', 'longitude2', 'latitude2'].some((c) => isObj(enc[c]) && (enc[c].field !== undefined || enc[c].datum !== undefined))
    if (!projected) fail(`${path}.${geoChannels[0]}`, 'a longitude / latitude pair needs a `field` or `datum` (value-only positions get no projection in vega-lite)')
  }
  if (isObj(enc.shape) && enc.shape.type === 'geojson' && mark !== 'geoshape') {
    fail(`${path}.shape.type`, 'a geojson shape field only applies to the geoshape mark')
  }
  if (mark === 'geoshape') {
    for (const c of ['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'radius', 'size', 'angle']) {
      if (enc[c] != null) fail(`${path}.${c}`, `a geoshape mark is positioned by its projection: the "${c}" channel does not apply`)
    }
    if (isObj(enc.shape) && enc.shape.field !== undefined && enc.shape.type !== 'geojson') {
      fail(`${path}.shape`, 'on a geoshape mark the shape channel carries the GeoJSON ({"field": ..., "type": "geojson"})')
    }
  }
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
    if (!ALL_CHANNELS.has(ch)) fail(at, `unknown encoding channel "${ch}"`)
    if (!SUPPORTED_CHANNELS.has(ch)) fail(at, `encoding channel "${ch}" is valid Vega-Lite but is not supported by @aster/vl`)
    if (ch === 'url' && mark !== 'image') fail(at, 'the url channel only applies to the image mark')
    if (def === null) continue
    if ((ch === 'row' || ch === 'column' || ch === 'facet') && where === 'layer') fail(at, 'facet channels are not allowed in a layer encoding (use the facet operator)')
    if (ch === 'detail' || ch === 'order' || ch === 'tooltip' || ch === 'href' || ch === 'description') {
      if (Array.isArray(def)) {
        if (ch === 'order' || ch === 'href') fail(at, `${ch} cannot be an array`)
        def.forEach((d, i) => validateChannelDef(ch, d, `${at}[${i}]`))
        continue
      }
    } else if (Array.isArray(def)) fail(at, `channel "${ch}" does not accept an array of definitions`)
    validateChannelDef(ch, def, at, where === 'layer')
  }
}

const NO_SCALE_CHANNELS = set('color fill stroke opacity fillOpacity strokeOpacity strokeWidth')

function validateChannelDef(ch: string, def: unknown, at: string, shared = false): void {
  if (!isObj(def)) fail(at, 'a channel definition must be an object')
  keysOf(def, ch === 'row' || ch === 'column' || ch === 'facet' ? FACET_CHANNEL_DEF_KEYS : FIELD_DEF_KEYS, at, 'channel definition')
  if (def.value !== undefined && (def.field !== undefined || def.datum !== undefined)) fail(at, '`value` cannot be combined with `field`/`datum`')
  if (def.field !== undefined && def.datum !== undefined) fail(at, '`field` and `datum` cannot be combined')
  if (def.field !== undefined) checkFieldName(def.field, `${at}.field`)
  if (def.field === undefined && def.value === undefined && def.datum === undefined && def.aggregate !== 'count' && def.condition === undefined && def.expr === undefined && !shared && !(ch === 'order' && def.sort !== undefined)) {
    fail(at, 'a channel definition needs `field`, `value`, `datum` or `aggregate: "count"`')
  }
  if (def.type !== undefined && !['quantitative', 'ordinal', 'nominal', 'temporal', 'geojson'].includes(def.type as string)) {
    fail(`${at}.type`, `unknown type ${JSON.stringify(def.type)}`)
  }
  if (def.type === 'geojson' && ch !== 'shape') fail(`${at}.type`, 'the geojson type only applies to the shape channel of a geoshape mark')
  if (GEO_CHANNELS.has(ch)) {
    if (def.type !== undefined && def.type !== 'quantitative') fail(`${at}.type`, 'a longitude / latitude channel is quantitative')
    for (const k of ['aggregate', 'bin', 'timeUnit', 'sort', 'stack', 'scale', 'axis', 'legend', 'condition', 'impute', 'band', 'bandPosition']) {
      if (def[k] !== undefined) fail(`${at}.${k}`, `\`${k}\` does not apply to a longitude / latitude channel (it is projected, not scaled)`)
    }
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
      splitAccessPath(def.aggregate[ks[0]!] as string)
      if (def.field === undefined) fail(`${at}.aggregate`, 'argmax/argmin need the channel `field` to read from the winning row')
    } else {
      if (typeof def.aggregate !== 'string') mustBe(`${at}.aggregate`, 'an aggregate operation name')
      if (!AGG_OPS.has(def.aggregate)) fail(`${at}.aggregate`, `unknown aggregate ${JSON.stringify(def.aggregate)}`)
      if (def.aggregate !== 'count' && def.field === undefined) fail(`${at}.aggregate`, `aggregate "${def.aggregate}" needs a field`)
    }
  }
  if (def.bin !== undefined) validateBin(def.bin, `${at}.bin`, ch === 'x' || ch === 'y')
  if ((def.bin === 'binned' || (isObj(def.bin) && def.bin.binned === true)) && ch !== 'x' && ch !== 'y') fail(`${at}.bin`, 'pre-binned data (bin: "binned") only applies to the x and y channels')
  if (def.timeUnit !== undefined) {
    const tu = normalizeTimeUnit(def.timeUnit, `${at}.timeUnit`)
    // (a binned time unit on a discrete field leaves its mark without an orientation in vega-lite, which is not reproduced)
    if (tu.binned && (def.type === 'ordinal' || def.type === 'nominal')) fail(`${at}.timeUnit`, 'a binned time unit on an ordinal or nominal field is not supported yet; use a temporal field')
  }
  if (def.timeUnit !== undefined && def.bin) fail(at, '`timeUnit` and `bin` cannot be combined')
  if (def.sort !== undefined) validateSort(def.sort, `${at}.sort`, ch)
  // "wiggle" is not in the vega-lite 6 schema but vega-lite 6.4.3 accepts it and
  // compiles it unstacked; the corpus pins that, so it is tolerated here.
  if (def.stack !== undefined && !['zero', 'center', 'normalize', 'wiggle', true, false, null].includes(def.stack as never)) {
    fail(`${at}.stack`, `unsupported stack ${JSON.stringify(def.stack)}`)
  }
  if (def.impute !== undefined) {
    if (ch !== 'x' && ch !== 'y') fail(`${at}.impute`, '`impute` only applies to the x and y channels')
    const im = def.impute
    if (!isObj(im)) mustBe(`${at}.impute`, OBJECT)
    keysOf(im, set('method value frame keyvals'), `${at}.impute`, 'impute')
    if (im.method !== undefined && !['value', 'median', 'max', 'min', 'mean'].includes(im.method as string)) fail(`${at}.impute.method`, `unknown impute method ${JSON.stringify(im.method)}`)
    if (im.frame !== undefined && !(Array.isArray(im.frame) && im.frame.length === 2)) fail(`${at}.impute.frame`, 'must be a [start, end] pair')
    if (im.keyvals !== undefined) validateImputeKeyvals(im.keyvals, `${at}.impute.keyvals`)
  }
  if (def.band !== undefined) fail(`${at}.band`, '`band` is not supported')
  if (def.bandPosition !== undefined && typeof def.bandPosition !== 'number') mustBe(`${at}.bandPosition`, 'a number')
  if (def.condition !== undefined) validateCondition(def.condition, `${at}.condition`)
  for (const k of ['axis', 'legend', 'scale'] as const) {
    if (def[k] !== undefined && def[k] !== null && !isObj(def[k])) mustBe(`${at}.${k}`, 'an object or null')
  }
  // (`scale: null` reads the field's values as they are; for a position it would need the pixel values to be known)
  if (def.scale === null && !NO_SCALE_CHANNELS.has(ch)) fail(`${at}.scale`, `\`scale: null\` (identity/disabled scale) is not supported on the ${ch} channel`)
  if (isObj(def.scale)) validateScaleDef(def.scale, `${at}.scale`)
}

const SCALE_KEYS_OK = set(
  'type domain domainRaw domainMin domainMax domainMid range reverse nice zero padding paddingInner paddingOuter align base clamp constant exponent round bins interpolate scheme rangeMin rangeMax',
)
const SCALE_TYPES = set('linear log pow sqrt symlog identity sequential time utc quantile quantize threshold bin-ordinal ordinal point band')

function validateScaleDef(scale: Obj, at: string): void {
  for (const k of Object.keys(scale)) {
    if (!SCALE_KEYS_OK.has(k)) fail(`${at}.${k}`, `unknown scale property "${k}"`)
  }
  if (scale.domainRaw !== undefined) {
    // (scale.ts domainRaw is an ExprRef | SignalRef: the domain as a signal, set aside from the domain the data gives)
    const r = scale.domainRaw
    if (!(isObj(r) && (typeof r.signal === 'string' || typeof r.expr === 'string'))) mustBe(`${at}.domainRaw`, 'a signal or an expression')
  }
  if (scale.type !== undefined) {
    if (typeof scale.type !== 'string' || !SCALE_TYPES.has(scale.type)) fail(`${at}.type`, `unknown scale type ${JSON.stringify(scale.type)}`)
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
      if (typeof sort.encoding !== 'string' || !SORT_CHANNELS.has(sort.encoding)) fail(`${at}.encoding`, `unknown sort channel ${JSON.stringify(sort.encoding)}`)
    } else {
      keysOf(sort, set('field op order'), at, 'sort')
      if (sort.field !== undefined) checkFieldName(sort.field, `${at}.field`)
      if (sort.field === undefined && sort.op !== undefined && sort.op !== 'count') fail(at, `op "${String(sort.op)}" needs a \`field\` (only "count" works without one)`)
      if (sort.field === undefined && sort.order === undefined && sort.op === undefined) fail(at, 'an empty sort object has no meaning')
    }
    if (sort.order !== undefined && sort.order !== 'ascending' && sort.order !== 'descending' && sort.order !== null) {
      fail(`${at}.order`, `unknown order ${JSON.stringify(sort.order)}`)
    }
    if (sort.op !== undefined && !(typeof sort.op === 'string' && AGG_OPS.has(sort.op))) fail(`${at}.op`, `unknown aggregate ${JSON.stringify(sort.op)}`)
    return
  }
  fail(at, `unknown sort form ${JSON.stringify(sort)} on channel "${ch}"`)
}

// --- conditions --------------------------------------------------------------

const FIELD_PREDICATE_KEYS = ['equal', 'lt', 'lte', 'gt', 'gte', 'range', 'oneOf', 'valid'] as const

/**
 * Validate a VL predicate (string expression, field predicate, and/or/not). A `{param}` predicate is accepted only as
 * the whole of a `filter` transform (`allowParam`), and only for a timer selection (an animation's frame filter).
 */
export function validatePredicate(p: unknown, at: string, allowParam = false): void {
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
  splitAccessPath(p.field)
  if (p.timeUnit !== undefined) normalizeTimeUnit(p.timeUnit, `${at}.timeUnit`)
  if (op[0] === 'oneOf' && !Array.isArray(p.oneOf)) mustBe(`${at}.oneOf`, 'an array')
  if (op[0] === 'range' && !(Array.isArray(p.range) && p.range.length === 2)) mustBe(`${at}.range`, 'a [lower, upper] pair')
  if (op[0] === 'valid' && typeof p.valid !== 'boolean') mustBe(`${at}.valid`, 'a boolean')
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
    if (c.field !== undefined) {
      if (typeof c.field !== 'string') mustBe(`${a}.field`, 'a string')
      splitAccessPath(c.field)
    }
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
  for (const f of v as string[]) splitAccessPath(f)
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
    if (primary.length === 0) fail(a, `unknown transform; expected one of ${TRANSFORM_NAMES.join(', ')} (keys: ${JSON.stringify(Object.keys(t))})`)
    if (primary.length > 1) fail(a, `ambiguous transform: ${primary.join(' + ')}`)
    const kind = primary[0]!
    keysOf(t, TRANSFORM_KEYS[kind]!, a, `${kind} transform`)
    validateTransform(kind, t, a)
  })
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
      if (splitAccessPath(s).length !== 1) fail(`${a}.${k}`, `output field name ${JSON.stringify(s)} must not contain '.' or '[' (escape with a backslash for a flat name)`)
    }
    if (n !== undefined && list.length > n) fail(`${a}.${k}`, `expects at most ${n} names`)
  }
  if (t.groupby !== undefined) validateFieldList(t.groupby, `${a}.groupby`)
  switch (kind) {
    case 'filter':
      validatePredicate(t.filter, `${a}.filter`, true)
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
        if (typeof d.op !== 'string' || !AGG_OPS.has(d.op)) fail(`${da}.op`, `unknown aggregate op ${JSON.stringify(d.op)}`)
        if (d.op !== 'count' && typeof d.field !== 'string') fail(`${da}.field`, `op "${d.op}" needs a field`)
        if (d.field !== undefined) splitAccessPath(d.field as string)
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
        if (typeof d.op !== 'string' || !WINDOW_OPS.has(d.op)) fail(`${da}.op`, `unknown window op ${JSON.stringify(d.op)}`)
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
      if (t.op !== undefined && !(typeof t.op === 'string' && AGG_OPS.has(t.op))) fail(`${a}.op`, 'unknown aggregate op')
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
        if (declaredParams.get(t.from.param as string) !== 'selection') fail(`${a}.from.param`, `cannot look up the variable parameter ${JSON.stringify(t.from.param)}: only a selection can be a lookup source`)
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
      if (!/^[A-Za-z_$][\w$]*$/.test(t.param as string)) mustBe(`${a}.param`, `an identifier, got ${JSON.stringify(t.param)}`)
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

function validateFacetOperator(spec: Obj, at: (k: string) => string, selOk: boolean, top = true): void {
  const facet = spec.facet
  if (!isObj(facet)) mustBe(at('facet'), 'a field definition or {row, column}')
  if (!isObj(spec.spec)) fail(at('spec'), 'a facet spec needs a nested `spec`')
  const mapping = facet.row !== undefined || facet.column !== undefined
  // (a wrapped facet inside another composition lays its cells out differently from vega-lite's here: refused rather than drawn wrong)
  if (!mapping && !top) fail(at('facet'), 'a wrapped facet (a single `facet` field) nested in another composition is not supported yet')
  const checkFacetDef = (d: unknown, a: string): void => {
    if (!isObj(d)) mustBe(a, 'a field definition')
    keysOf(d, set('field type aggregate bin timeUnit sort title header bandPosition'), a, 'facet field definition')
    if (typeof d.field !== 'string') fail(`${a}.field`, 'a facet field definition needs `field`')
    splitAccessPath(d.field)
    if (d.bin !== undefined) validateBin(d.bin, `${a}.bin`)
    if (d.timeUnit !== undefined) normalizeTimeUnit(d.timeUnit, `${a}.timeUnit`)
    if (d.sort !== undefined) {
      const s = d.sort
      if (!(s === 'ascending' || s === 'descending' || s === null || Array.isArray(s) || isObj(s))) fail(`${a}.sort`, 'unknown facet sort form')
      if (isObj(s) || Array.isArray(s)) validateSort(s, `${a}.sort`, 'row')
      if (isObj(s) && typeof s.field !== 'string' && s.op !== 'count') fail(`${a}.sort.field`, 'a facet sort by an aggregate needs the `field` to aggregate')
    }
    if (d.header !== undefined && !isObj(d.header)) mustBe(`${a}.header`, OBJECT)
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
  compositeDepth++
  try { validateView(spec.spec as Obj, at('spec'), false, 'facet', selOk) } finally { compositeDepth-- }
}

function validateRepeatOperator(spec: Obj, at: (k: string) => string, selOk: boolean): void {
  const rep = spec.repeat
  if (!isObj(spec.spec)) fail(at('spec'), 'a repeat spec needs a nested `spec`')
  const fieldArr = (v: unknown, a: string): void => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string')) mustBe(a, 'a non-empty array of field names')
    for (const f of v as string[]) splitAccessPath(f)
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
  const prev = repeatVars
  const vars = new Set(prev)
  if (Array.isArray(rep)) vars.add('repeat')
  else if (isObj(rep)) for (const k of ['row', 'column', 'layer']) if (rep[k] !== undefined) vars.add(k)
  repeatVars = vars
  try {
    validateView(spec.spec as Obj, at('spec'), false, 'repeat', selOk)
  } finally {
    repeatVars = prev
  }
}
