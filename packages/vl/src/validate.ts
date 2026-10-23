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

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

function fail(path: string, msg: string): never {
  throw new VLCompileError(`${path || '<spec>'}: ${msg}`)
}

function keysOf(o: Obj, allowed: ReadonlySet<string>, path: string, what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) fail(path, `unknown ${what} property "${k}"`)
  }
}

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean))

// --- vocabularies (from the vega-lite 6.4.3 JSON schema) ---------------------

export const MARKS = set('arc area bar image line point rect rule text tick trail circle square geoshape boxplot errorbar errorband')
/** Marks compile.ts implements end to end. */
export const SUPPORTED_MARKS = set('arc area bar line point rect rule text tick trail circle square boxplot image errorbar errorband')

const ALL_CHANNELS = set(
  'x y x2 y2 xOffset yOffset xError xError2 yError yError2 theta theta2 radius radius2 latitude longitude latitude2 longitude2 ' +
    'color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape text tooltip href url description key detail order time ' +
    'row column facet',
)
/** Channels compile.ts consumes. A schema-valid channel outside this set throws. */
const SUPPORTED_CHANNELS = set(
  'x y x2 y2 xOffset yOffset theta radius color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape text tooltip href description detail order row column facet url xError xError2 yError yError2',
)

const AGG_OPS = set(
  'argmax argmin average count distinct max mean median min missing product q1 q3 ci0 ci1 stderr stdev stdevp sum valid values variance variancep exponential exponentialb',
)
const WINDOW_OPS = set(
  'row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value ' +
    'count distinct sum mean average median min max q1 q3 ci0 ci1 stderr stdev stdevp valid missing variance variancep product values argmax argmin',
)

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
}

/**
 * Validate and normalize a Vega-Lite timeUnit (string, utc-prefixed string, or
 * {unit, utc, step} object). Throws for unknown units, `binned` and `maxbins`.
 */
export function normalizeTimeUnit(tu: unknown, path = 'timeUnit'): NormalTimeUnit {
  let unit: unknown = tu
  let utc = false
  let step: number | undefined
  if (isObj(tu)) {
    keysOf(tu, set('unit utc step maxbins binned'), path, 'timeUnit')
    if (tu.maxbins !== undefined) fail(path, 'timeUnit.maxbins (adaptive time-unit binning) is not supported')
    if (tu.binned !== undefined) fail(path, 'timeUnit.binned is not supported')
    unit = tu.unit
    utc = tu.utc === true
    if (tu.step !== undefined) {
      if (typeof tu.step !== 'number' || !(tu.step > 0)) fail(path, 'timeUnit.step must be a positive number')
      step = tu.step
    }
  }
  if (typeof unit !== 'string') fail(path, `timeUnit must be a unit string or {unit}, got ${JSON.stringify(tu)}`)
  let u: string = unit
  if (u.startsWith('utc')) {
    utc = true
    u = u.slice(3)
  }
  if (u.startsWith('binned')) fail(path, `timeUnit ${JSON.stringify(tu)}: binned time units are not supported`)
  if (!SINGLE_TIME_UNITS.includes(u) && !MULTI_TIME_UNITS.has(u)) {
    fail(path, `unknown timeUnit ${JSON.stringify(tu)}`)
  }
  return { unit: u, utc, ...(step !== undefined ? { step } : {}) }
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

const TOP_COMMON = 'name description title data datasets transform usermeta $schema config autosize background padding params'
const KEYS: Record<Kind, { top: ReadonlySet<string>; nested: ReadonlySet<string> }> = {
  unit: {
    top: set(`${TOP_COMMON} mark encoding width height projection view resolve align bounds center spacing`),
    nested: set('name description title data transform mark encoding width height projection view params resolve align bounds center spacing'),
  },
  layer: {
    top: set(`${TOP_COMMON} layer encoding width height projection view resolve`),
    nested: set('name description title data transform layer encoding width height projection view resolve'),
  },
  // vega-lite accepts (and ignores) width/height on composition specs; the
  // corpus pins that, so they are tolerated here too.
  hconcat: { top: set(`${TOP_COMMON} hconcat bounds center spacing resolve width height`), nested: set('name description title data transform hconcat bounds center spacing resolve width height') },
  vconcat: { top: set(`${TOP_COMMON} vconcat bounds center spacing resolve width height`), nested: set('name description title data transform vconcat bounds center spacing resolve width height') },
  concat: { top: set(`${TOP_COMMON} concat columns align bounds center spacing resolve width height`), nested: set('name description title data transform concat columns align bounds center spacing resolve width height') },
  facet: { top: set(`${TOP_COMMON} facet spec columns align bounds center spacing resolve width height`), nested: set('name description title data transform facet spec columns align bounds center spacing resolve width height') },
  repeat: { top: set(`${TOP_COMMON} repeat spec columns align bounds center spacing resolve width height`), nested: set('name description title data transform repeat spec columns align bounds center spacing resolve width height') },
}

/**
 * Which child kinds each composition operator accepts (vega-lite 6 schema) AND
 * this compiler implements. A schema-valid but unimplemented nesting reports
 * "not supported yet"; a schema-invalid one reports "not allowed".
 */
const SCHEMA_CHILDREN: Record<Exclude<Kind, 'unit'>, ReadonlySet<Kind>> = {
  layer: new Set<Kind>(['unit', 'layer']),
  hconcat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  vconcat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  concat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  facet: new Set<Kind>(['unit', 'layer']),
  repeat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
}
/** Implemented (parent -> child) nestings; edited as compile.ts gains support. */
export const SUPPORTED_NESTING: Record<Exclude<Kind, 'unit'>, ReadonlySet<Kind>> = {
  layer: new Set<Kind>(['unit', 'layer']),
  hconcat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  vconcat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  concat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
  facet: new Set<Kind>(['unit', 'layer']),
  repeat: new Set<Kind>(['unit', 'layer', 'repeat', 'facet', 'concat', 'hconcat', 'vconcat']),
}

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

export function validateSpec(spec: unknown): void {
  if (!isObj(spec)) fail('', 'a Vega-Lite spec must be a JSON object')
  repeatVars = new Set()
  validateView(spec, '', true, undefined)
}

function validateView(spec: Obj, path: string, top: boolean, parent: Kind | undefined): void {
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
  if (spec.$schema !== undefined && typeof spec.$schema !== 'string') fail(at('$schema'), 'must be a string')

  validateData(spec, at)
  if (spec.transform !== undefined) validateTransforms(spec.transform, at('transform'))
  validateSize(spec, at, top && (kind === 'unit' || kind === 'layer'))
  if (spec.params !== undefined) validateParams(spec.params, at('params'), top && kind === 'unit')
  if (spec.resolve !== undefined) validateResolve(spec.resolve, at('resolve'), kind)
  if (spec.projection !== undefined) fail(at('projection'), 'map projections are not supported (geoshape marks are unavailable)')
  if (spec.view !== undefined) fail(at('view'), 'the view background property is not supported; set it through config.view')
  if (spec.usermeta !== undefined && !isObj(spec.usermeta)) fail(at('usermeta'), 'must be an object')
  if (spec.config !== undefined) {
    if (!top) fail(at('config'), 'config is only allowed at the top level of a spec')
    if (!isObj(spec.config)) fail(at('config'), 'must be an object')
    validateConfig(spec.config, at('config'))
  }
  if (spec.autosize !== undefined) validateAutosize(spec.autosize, at('autosize'))
  if (spec.datasets !== undefined && !isObj(spec.datasets)) fail(at('datasets'), 'must be an object mapping names to arrays')
  for (const k of ['align', 'bounds', 'center', 'spacing', 'columns'] as const) {
    if (spec[k] !== undefined && (kind === 'unit' || kind === 'layer')) fail(at(k), `${k} is only meaningful on composition specs`)
  }

  switch (kind) {
    case 'unit':
      validateUnit(spec, at)
      break
    case 'layer': {
      if (!Array.isArray(spec.layer) || spec.layer.length === 0) fail(at('layer'), 'must be a non-empty array of specs')
      if (spec.encoding !== undefined) validateEncoding(spec.encoding, at('encoding'), 'layer')
      spec.layer.forEach((c, i) => {
        if (!isObj(c)) fail(`${at('layer')}[${i}]`, 'must be an object')
        validateView(c, `${at('layer')}[${i}]`, false, 'layer')
      })
      break
    }
    case 'hconcat':
    case 'vconcat':
    case 'concat': {
      const arr = spec[kind]
      if (!Array.isArray(arr) || arr.length === 0) fail(at(kind), 'must be a non-empty array of specs')
      arr.forEach((c, i) => {
        if (!isObj(c)) fail(`${at(kind)}[${i}]`, 'must be an object')
        validateView(c, `${at(kind)}[${i}]`, false, kind)
      })
      if (spec.columns !== undefined && kind !== 'concat') fail(at('columns'), '`columns` is only valid on `concat`')
      if (spec.columns !== undefined && !(Number.isInteger(spec.columns) && (spec.columns as number) > 0)) fail(at('columns'), 'must be a positive integer')
      break
    }
    case 'facet':
      validateFacetOperator(spec, path, at)
      break
    case 'repeat':
      validateRepeatOperator(spec, path, at)
      break
  }
}

function validateAutosize(a: unknown, path: string): void {
  if (typeof a === 'string') {
    if (!['pad', 'none', 'fit', 'fit-x', 'fit-y'].includes(a)) fail(path, `unknown autosize ${JSON.stringify(a)}`)
    return
  }
  if (!isObj(a)) fail(path, 'must be a string or an object')
  keysOf(a, set('type resize contains'), path, 'autosize')
}

function validateSize(spec: Obj, at: (k: string) => string, containerOk: boolean): void {
  for (const k of ['width', 'height'] as const) {
    const v = spec[k]
    if (v === undefined) continue
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) continue
    if (isObj(v) && Object.keys(v).length === 1 && typeof v.step === 'number' && v.step > 0) continue
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
  if (!isObj(data)) fail(at('data'), 'must be an object')
  const kinds = ['values', 'url', 'name', 'sequence', 'sphere', 'graticule'].filter((k) => data[k] !== undefined)
  if (kinds.length === 0) fail(at('data'), 'needs one of `values`, `url`, `name`')
  if (data.sequence !== undefined || data.sphere !== undefined || data.graticule !== undefined) {
    fail(at('data'), 'data generators (sequence/sphere/graticule) are not supported')
  }
  if (data.values !== undefined && data.url !== undefined) fail(at('data'), '`values` and `url` cannot be combined')
  keysOf(data, set('values url name format'), at('data'), 'data')
  if (data.values !== undefined && typeof data.values !== 'string' && !Array.isArray(data.values) && !isObj(data.values)) {
    fail(at('data.values'), 'must be an array, an object or a string')
  }
  if (data.name !== undefined && typeof data.name !== 'string') fail(at('data.name'), 'must be a string')
  if (data.name !== undefined && data.values === undefined && data.url === undefined && isObj(spec.datasets) === false) {
    // a bare named dataset is legal: the host supplies rows by name at runtime
  }
  if (data.format !== undefined) {
    if (!isObj(data.format)) fail(at('data.format'), 'must be an object')
    keysOf(data.format, set('type parse property delimiter header'), at('data.format'), 'data.format')
    const t = data.format.type
    if (t !== undefined && !['json', 'csv', 'tsv', 'dsv'].includes(t as string)) fail(at('data.format.type'), `unsupported format type ${JSON.stringify(t)}`)
    if (data.format.parse !== undefined && data.format.parse !== null && !isObj(data.format.parse)) fail(at('data.format.parse'), 'must be an object or null')
  }
}

// --- config ------------------------------------------------------------------

const CONFIG_KEYS = set(
  'autosize background padding axis axisBand axisX axisY axisLeft axisRight axisTop axisBottom legend header headerRow headerColumn headerFacet range ' +
    'mark arc area bar circle geoshape image line point rect rule square text tick trail view title font scale style ' +
    'aria countTitle fieldTitle lineBreak normalizedNumberFormat numberFormat timeFormat errorbar errorband ' +
    'customFormatTypes numberFormatType normalizedNumberFormatType timeFormatType',
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
    if (!isObj(cfg.scale)) fail(`${path}.scale`, 'must be an object')
    for (const k of Object.keys(cfg.scale)) {
      if (!CONFIG_SCALE_KEYS.has(k)) fail(`${path}.scale.${k}`, 'this scale config property is not supported by @aster/vl')
    }
    const inv = cfg.scale.invalid
    if (inv !== undefined) {
      if (!isObj(inv)) fail(`${path}.scale.invalid`, 'must map scale channels to "zero-or-min" or {"value": ...}')
      for (const [ch, v] of Object.entries(inv)) {
        if (!ALL_CHANNELS.has(ch)) fail(`${path}.scale.invalid.${ch}`, 'unknown scale channel')
        if (v !== 'zero-or-min' && !(isObj(v) && 'value' in v)) fail(`${path}.scale.invalid.${ch}`, 'must be "zero-or-min" or {"value": ...}')
      }
    }
  }
  if (cfg.customFormatTypes !== undefined && typeof cfg.customFormatTypes !== 'boolean') fail(`${path}.customFormatTypes`, 'must be a boolean')
  for (const k of ['numberFormatType', 'normalizedNumberFormatType', 'timeFormatType'] as const) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'string') fail(`${path}.${k}`, 'must be the name of a format function registered as an expression function')
  }
  if (cfg.autosize !== undefined) validateAutosize(cfg.autosize, `${path}.autosize`)
}

// --- params ------------------------------------------------------------------

const BIND_INPUTS = set('range checkbox radio select text number date datetime-local time month week color')

function validateParams(params: unknown, path: string, topUnit: boolean): void {
  if (!Array.isArray(params)) fail(path, 'must be an array of parameter definitions')
  const names = new Set<string>()
  params.forEach((p, i) => {
    const at = `${path}[${i}]`
    if (!isObj(p)) fail(at, 'must be an object')
    if (typeof p.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(p.name)) fail(`${at}.name`, `parameter names must be identifiers, got ${JSON.stringify(p.name)}`)
    if (names.has(p.name)) fail(`${at}.name`, `duplicate parameter name "${p.name}"`)
    names.add(p.name)
    if (p.select !== undefined) {
      if (!topUnit) fail(`${at}.select`, 'selection parameters are only supported on a single top-level unit spec (not inside layer/concat/facet/repeat views)')
      validateSelection(p, at)
      return
    }
    // variable parameter
    keysOf(p, set('name value expr bind react description push'), at, 'parameter')
    if (p.expr !== undefined && p.value !== undefined) fail(at, '`expr` and `value` cannot be combined')
    if (p.expr !== undefined && typeof p.expr !== 'string') fail(`${at}.expr`, 'must be an expression string')
    if (p.push !== undefined) fail(`${at}.push`, '`push` is not supported')
    if (p.react !== undefined && p.react !== false && p.react !== true) fail(`${at}.react`, 'must be a boolean')
    if (p.bind !== undefined) {
      if (p.expr !== undefined) fail(`${at}.bind`, 'a parameter with `expr` cannot be bound to an input')
      if (!isObj(p.bind)) fail(`${at}.bind`, 'must be an input binding object (legend/scales bindings are not supported)')
      keysOf(p.bind, set('input min max step options labels name debounce element'), `${at}.bind`, 'bind')
      if (typeof p.bind.input !== 'string' || !BIND_INPUTS.has(p.bind.input)) fail(`${at}.bind.input`, `unsupported input type ${JSON.stringify(p.bind.input)}`)
    }
    if (p.value === undefined && p.expr === undefined) fail(at, 'a variable parameter needs `value` or `expr`')
  })
}

function validateSelection(p: Obj, at: string): void {
  keysOf(p, set('name select value bind description'), at, 'selection parameter')
  let sel = p.select
  if (typeof sel === 'string') sel = { type: sel }
  if (!isObj(sel)) fail(`${at}.select`, 'must be "interval", "point" or an object with `type`')
  if (sel.type !== 'interval') {
    fail(`${at}.select`, `selection type ${JSON.stringify(sel.type)} is not supported (only a plain "interval" selection, rendered as its static brush marks without interaction)`)
  }
  for (const k of Object.keys(sel)) {
    if (k !== 'type') fail(`${at}.select.${k}`, 'interval selection options are not supported (only the default interval selection)')
  }
  if (p.value !== undefined) fail(`${at}.value`, 'initial selection values are not supported')
  if (p.bind !== undefined) fail(`${at}.bind`, 'selection bindings (e.g. "scales") are not supported')
}

// --- resolve -----------------------------------------------------------------

const RESOLVE_CHANNELS = set('x y xOffset yOffset theta radius color fill stroke opacity fillOpacity strokeOpacity strokeWidth strokeDash size angle shape time')

function validateResolve(r: unknown, path: string, kind: Kind): void {
  if (!isObj(r)) fail(path, 'must be an object')
  keysOf(r, set('scale axis legend'), path, 'resolve')
  for (const what of ['scale', 'axis', 'legend'] as const) {
    const m = r[what]
    if (m === undefined) continue
    if (!isObj(m)) fail(`${path}.${what}`, 'must be an object mapping channels to "shared" | "independent"')
    for (const [ch, v] of Object.entries(m)) {
      if (!RESOLVE_CHANNELS.has(ch)) fail(`${path}.${what}.${ch}`, `unknown channel "${ch}"`)
      if (v !== 'shared' && v !== 'independent') fail(`${path}.${what}.${ch}`, `must be "shared" or "independent", got ${JSON.stringify(v)}`)
    }
  }
  if (kind === 'unit') fail(path, '`resolve` has no meaning on a single unit spec')
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
  x: 'positional mark-def constants (x/x2/y/y2) are not supported; use encoding',
  x2: 'positional mark-def constants (x/x2/y/y2) are not supported; use encoding',
  y: 'positional mark-def constants (x/x2/y/y2) are not supported; use encoding',
  y2: 'positional mark-def constants (x/x2/y/y2) are not supported; use encoding',
  theta: 'mark-def theta is not supported; use encoding',
  theta2: 'mark-def theta2 is not supported; use encoding',
  radius2: 'mark-def radius2 is not supported',
}

const INVALID_MODES = set('filter show break-paths-filter-domains break-paths-show-domains break-paths-show-path-domains')
function validateInvalidMode(v: unknown, at: string): void {
  if (v !== undefined && v !== null && !(typeof v === 'string' && INVALID_MODES.has(v))) fail(at, `unknown invalid-value mode ${JSON.stringify(v)}: expected ${[...INVALID_MODES].join(', ')} or null`)
}

function validateMark(mark: unknown, at: string): string {
  let def: Obj
  if (typeof mark === 'string') def = { type: mark }
  else if (isObj(mark)) def = mark
  else fail(at, 'mark must be a mark name or a mark definition object')
  const type = def.type
  if (typeof type !== 'string' || !MARKS.has(type)) fail(`${at}${typeof mark === 'string' ? '' : '.type'}`, `unknown mark type ${JSON.stringify(type)}`)
  if (!SUPPORTED_MARKS.has(type)) fail(`${at}${typeof mark === 'string' ? '' : '.type'}`, `mark type "${type}" is not supported by @aster/vl yet`)
  if (typeof mark !== 'string') {
    for (const k of Object.keys(def)) {
      if (!MARK_DEF_KEYS.has(k)) fail(`${at}.${k}`, `unknown mark property "${k}"`)
      const why = UNSUPPORTED_MARK_KEYS[k]
      if (why) fail(`${at}.${k}`, why)
      if (k === 'order' && def.order !== false && def.order !== null && def.order !== true) fail(`${at}.order`, 'only order: false/null/true is supported')
    }
    if (def.orient !== undefined && def.orient !== 'horizontal' && def.orient !== 'vertical') fail(`${at}.orient`, 'must be "horizontal" or "vertical"')
    validateInvalidMode(def.invalid, `${at}.invalid`)
  }
  return type
}

function validateUnit(spec: Obj, at: (k: string) => string): void {
  const mark = validateMark(spec.mark, at('mark'))
  const enc = spec.encoding === undefined ? {} : spec.encoding
  validateEncoding(enc, at('encoding'), 'unit', mark)
}

// --- encoding ----------------------------------------------------------------

const FIELD_DEF_KEYS = set('field type aggregate bin timeUnit sort stack bandPosition axis scale legend title format formatType condition value datum header impute band')
/** facet channel definitions (row/column/facet) add the layout controls */
const FACET_CHANNEL_DEF_KEYS = set('field type aggregate bin timeUnit sort bandPosition title header columns spacing align center bounds')
const SORT_CHANNELS = set('x y color fill stroke strokeWidth size shape fillOpacity strokeOpacity opacity text')

/** Channels whose value/datum can be given as a constant. */
const POSITION_CHANNELS = set('x y x2 y2 xOffset yOffset theta radius')

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
        def.forEach((d, i) => validateChannelDef(ch, d, `${at}[${i}]`, mark))
        continue
      }
    } else if (Array.isArray(def)) fail(at, `channel "${ch}" does not accept an array of definitions`)
    validateChannelDef(ch, def, at, mark)
  }
}

function validateChannelDef(ch: string, def: unknown, at: string, mark?: string): void {
  if (!isObj(def)) fail(at, 'a channel definition must be an object')
  keysOf(def, ch === 'row' || ch === 'column' || ch === 'facet' ? FACET_CHANNEL_DEF_KEYS : FIELD_DEF_KEYS, at, 'channel definition')
  const forms = ['field', 'value', 'datum', 'aggregate'].filter((k) => def[k] !== undefined && !(k === 'aggregate' && def.field === undefined && def.aggregate !== 'count'))
  if (def.value !== undefined && (def.field !== undefined || def.datum !== undefined)) fail(at, '`value` cannot be combined with `field`/`datum`')
  if (def.field !== undefined && def.datum !== undefined) fail(at, '`field` and `datum` cannot be combined')
  if (def.field !== undefined) checkFieldName(def.field, `${at}.field`)
  void forms
  if (def.field === undefined && def.value === undefined && def.datum === undefined && def.aggregate !== 'count' && def.condition === undefined && def.expr === undefined) {
    fail(at, 'a channel definition needs `field`, `value`, `datum` or `aggregate: "count"`')
  }
  if (def.type !== undefined && !['quantitative', 'ordinal', 'nominal', 'temporal', 'geojson'].includes(def.type as string)) {
    fail(`${at}.type`, `unknown type ${JSON.stringify(def.type)}`)
  }
  if (def.type === 'geojson') fail(`${at}.type`, 'geojson fields are not supported')
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
      if (typeof def.aggregate !== 'string') fail(`${at}.aggregate`, 'must be an aggregate operation name')
      if (!AGG_OPS.has(def.aggregate)) fail(`${at}.aggregate`, `unknown aggregate ${JSON.stringify(def.aggregate)}`)
      if (def.aggregate !== 'count' && def.field === undefined) fail(`${at}.aggregate`, `aggregate "${def.aggregate}" needs a field`)
    }
  }
  if (def.bin !== undefined) validateBin(def.bin, `${at}.bin`)
  if (def.timeUnit !== undefined) normalizeTimeUnit(def.timeUnit, `${at}.timeUnit`)
  if (def.timeUnit !== undefined && def.bin) fail(at, '`timeUnit` and `bin` cannot be combined')
  if (def.sort !== undefined) validateSort(def.sort, `${at}.sort`, ch)
  // "wiggle" is not in the vega-lite 6 schema but vega-lite 6.4.3 accepts it and
  // compiles it unstacked; the corpus pins that, so it is tolerated here.
  if (def.stack !== undefined && !['zero', 'center', 'normalize', 'wiggle', true, false, null].includes(def.stack as never)) {
    fail(`${at}.stack`, `unsupported stack ${JSON.stringify(def.stack)}`)
  }
  if (def.impute !== undefined) fail(`${at}.impute`, 'channel-level `impute` is not supported')
  if (def.band !== undefined) fail(`${at}.band`, '`band` is not supported')
  if (def.bandPosition !== undefined && typeof def.bandPosition !== 'number') fail(`${at}.bandPosition`, 'must be a number')
  if (def.condition !== undefined) validateCondition(def.condition, `${at}.condition`, ch, def)
  if (def.axis !== undefined && def.axis !== null && !isObj(def.axis)) fail(`${at}.axis`, 'must be an object or null')
  if (def.legend !== undefined && def.legend !== null && !isObj(def.legend)) fail(`${at}.legend`, 'must be an object or null')
  if (def.scale !== undefined && def.scale !== null && !isObj(def.scale)) fail(`${at}.scale`, 'must be an object or null')
  if (def.scale === null && !POSITION_CHANNELS.has(ch)) fail(`${at}.scale`, '`scale: null` (identity/disabled scale) is not supported')
  if (def.scale === null) fail(`${at}.scale`, '`scale: null` (identity/disabled scale) is not supported')
  if (isObj(def.scale)) validateScaleDef(def.scale, `${at}.scale`, ch)
  void mark
}

const SCALE_KEYS_OK = set(
  'type domain domainMin domainMax domainMid range reverse nice zero padding paddingInner paddingOuter align base clamp constant exponent round bins interpolate scheme rangeMin rangeMax',
)
const SCALE_UNSUPPORTED: Record<string, string> = {
  domainRaw: 'domainRaw is not supported',
}
const SCALE_TYPES = set('linear log pow sqrt symlog identity sequential time utc quantile quantize threshold bin-ordinal ordinal point band')

function validateScaleDef(scale: Obj, at: string, ch: string): void {
  for (const k of Object.keys(scale)) {
    if (SCALE_UNSUPPORTED[k]) fail(`${at}.${k}`, SCALE_UNSUPPORTED[k]!)
    if (!SCALE_KEYS_OK.has(k)) fail(`${at}.${k}`, `unknown scale property "${k}"`)
  }
  if (scale.type !== undefined) {
    if (typeof scale.type !== 'string' || !SCALE_TYPES.has(scale.type)) fail(`${at}.type`, `unknown scale type ${JSON.stringify(scale.type)}`)
  }
  if (scale.domain !== undefined) {
    const d = scale.domain
    // vega-lite passes a domain that is neither an array nor 'unaggregated' nor a {param}/{unionWith}/signal object on to
    // vega as it is (a string, a number, `true`: scale/domain.ts parseSingleChannelDomain), where it fails the
    // scale (vega.parse: "Undefined data set name"). So does this: it compiles, and the runtime refuses it.
    if (isObj(d) && typeof (d as Obj).signal !== 'string') fail(`${at}.domain`, 'domain objects ({param}, {unionWith}) are not supported; give an array or "unaggregated"')
  }
  void ch
}

function validateBin(bin: unknown, at: string): void {
  if (bin === 'binned') fail(at, 'pre-binned data (bin: "binned") is not supported; let @aster/vl bin the field (bin: true) or use a bin transform')
  if (bin === true || bin === false) return
  if (!isObj(bin)) fail(at, `bin must be true or a bin-params object, got ${JSON.stringify(bin)}`)
  if (bin.binned === true) fail(`${at}.binned`, 'pre-binned data (binned: true) is not supported; let @aster/vl bin the field or use a bin transform')
  keysOf(bin, set('anchor base binned divide extent maxbins minstep nice step steps'), at, 'bin')
  const num = (k: string, pos = true): void => {
    const v = bin[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || (pos && !(v > 0))) fail(`${at}.${k}`, `must be a positive number, got ${JSON.stringify(v)}`)
  }
  num('maxbins')
  num('minstep')
  num('base')
  num('step')
  if (bin.anchor !== undefined && typeof bin.anchor !== 'number') fail(`${at}.anchor`, 'must be a number')
  if (bin.nice !== undefined && typeof bin.nice !== 'boolean') fail(`${at}.nice`, 'must be a boolean')
  if (bin.binned !== undefined && typeof bin.binned !== 'boolean') fail(`${at}.binned`, 'must be a boolean')
  if (bin.steps !== undefined && !(Array.isArray(bin.steps) && bin.steps.length > 0 && bin.steps.every((n) => typeof n === 'number' && n > 0))) {
    fail(`${at}.steps`, 'must be a non-empty array of positive numbers')
  }
  if (bin.divide !== undefined && !(Array.isArray(bin.divide) && bin.divide.length > 0 && bin.divide.every((n) => typeof n === 'number' && n > 0))) {
    fail(`${at}.divide`, 'must be a non-empty array of positive numbers')
  }
  if (bin.extent !== undefined) {
    if (!(Array.isArray(bin.extent) && bin.extent.length === 2 && bin.extent.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
      fail(`${at}.extent`, 'must be a [min, max] pair of numbers (parameter references are not supported)')
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

/** Validate a VL predicate (string expression, field predicate, and/or/not). */
export function validatePredicate(p: unknown, at: string, allowParam = false): void {
  if (typeof p === 'string') return
  if (!isObj(p)) fail(at, `a predicate must be an expression string or an object, got ${JSON.stringify(p)}`)
  if (p.param !== undefined) {
    if (!allowParam) fail(at, 'selection/param predicates ({"param": ...}) are not supported')
    fail(at, 'selection/param predicates ({"param": ...}) are not supported')
  }
  if (p.and !== undefined || p.or !== undefined || p.not !== undefined) {
    const keys = Object.keys(p)
    if (keys.length !== 1) fail(at, 'and/or/not cannot be combined with other keys')
    const k = keys[0] as 'and' | 'or' | 'not'
    if (k === 'not') validatePredicate(p.not, `${at}.not`)
    else {
      const arr = p[k]
      if (!Array.isArray(arr) || arr.length === 0) fail(`${at}.${k}`, 'must be a non-empty array of predicates')
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
  if (op[0] === 'oneOf' && !Array.isArray(p.oneOf)) fail(`${at}.oneOf`, 'must be an array')
  if (op[0] === 'range' && !(Array.isArray(p.range) && p.range.length === 2)) fail(`${at}.range`, 'must be a [lower, upper] pair')
  if (op[0] === 'valid' && typeof p.valid !== 'boolean') fail(`${at}.valid`, 'must be a boolean')
}

function validateCondition(cond: unknown, at: string, ch: string, parentDef: Obj): void {
  const one = (c: unknown, a: string, inArray: boolean): void => {
    if (!isObj(c)) fail(a, 'a condition must be an object')
    keysOf(c, set('test param empty value field datum type aggregate bin timeUnit sort scale legend title format formatType bandPosition'), a, 'condition')
    if (c.param !== undefined) fail(`${a}.param`, 'selection/param-driven conditions ({"param": ...}) are not supported; use `test`')
    if (c.empty !== undefined) fail(`${a}.empty`, '`empty` only applies to selection conditions, which are not supported')
    if (c.test === undefined) fail(a, 'a condition needs `test`')
    validatePredicate(c.test, `${a}.test`)
    const kinds = ['value', 'field', 'datum'].filter((k) => c[k] !== undefined)
    if (kinds.length !== 1) fail(a, 'a condition needs exactly one of `value`, `field`, `datum`')
    if (inArray && kinds[0] !== 'value') fail(a, 'conditions in an array must be value conditions')
    if (c.field !== undefined && typeof c.field !== 'string') fail(`${a}.field`, 'must be a string')
    if (c.field !== undefined) splitAccessPath(c.field as string)
    if (c.timeUnit !== undefined) normalizeTimeUnit(c.timeUnit, `${a}.timeUnit`)
    if (c.bin !== undefined) fail(`${a}.bin`, 'binned conditional fields are not supported')
    if (c.aggregate !== undefined) fail(`${a}.aggregate`, 'aggregated conditional fields are not supported')
  }
  if (Array.isArray(cond)) {
    if (cond.length === 0) fail(at, 'a condition array must not be empty')
    cond.forEach((c, i) => one(c, `${at}[${i}]`, true))
  } else one(cond, at, false)
  void ch
  void parentDef
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

function validateFieldList(v: unknown, at: string): void {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail(at, 'must be an array of field names')
  for (const f of v as string[]) splitAccessPath(f)
}

function validateTransforms(tr: unknown, at: string): void {
  if (!Array.isArray(tr)) fail(at, 'must be an array of transforms')
  tr.forEach((t, i) => {
    const a = `${at}[${i}]`
    if (!isObj(t)) fail(a, 'a transform must be an object')
    if (t.type !== undefined && !Object.keys(TRANSFORM_KEYS).some((k) => t[k] !== undefined)) {
      fail(a, `Vega-style transforms ({"type": ${JSON.stringify(t.type)}, ...}) are not Vega-Lite; use the Vega-Lite transform forms (${TRANSFORM_NAMES.join(', ')})`)
    }
    const present = TRANSFORM_NAMES.filter((k) => t[k] !== undefined)
    // `bin` / `timeUnit` / `sort` / `on`... appear as secondary keys of other transforms.
    const primary = present.filter((k) => {
      // a key that is the sole discriminator of its transform
      // `extent` is also a secondary key of density/regression; it is the extent TRANSFORM only with `param`
      return k === 'filter' || k === 'calculate' || k === 'aggregate' || k === 'joinaggregate' || k === 'window' || k === 'stack' || k === 'fold' || k === 'flatten' || k === 'pivot' ||
        k === 'impute' || k === 'lookup' || k === 'sample' || k === 'density' || k === 'loess' || k === 'regression' || k === 'quantile' || (k === 'extent' && t.param !== undefined) ||
        (k === 'bin' && t.field !== undefined) || (k === 'timeUnit' && t.field !== undefined)
    })
    if (primary.length === 0) fail(a, `unknown transform; expected one of ${TRANSFORM_NAMES.join(', ')} (keys: ${JSON.stringify(Object.keys(t))})`)
    if (primary.length > 1) fail(a, `ambiguous transform: ${primary.join(' + ')}`)
    const kind = primary[0]!
    keysOf(t, TRANSFORM_KEYS[kind]!, a, `${kind} transform`)
    validateTransform(kind, t, a)
  })
}

function validateTransform(kind: string, t: Obj, a: string): void {
  const needStr = (k: string): void => {
    if (typeof t[k] !== 'string' || t[k] === '') fail(`${a}.${k}`, 'must be a non-empty string')
  }
  const asNames = (k = 'as', n?: number): void => {
    const v = t[k]
    if (v === undefined) return
    const list = Array.isArray(v) ? v : [v]
    if (!list.every((s) => typeof s === 'string' && s !== '')) fail(`${a}.${k}`, 'must be a name or an array of names')
    for (const s of list as string[]) {
      if (splitAccessPath(s).length !== 1) fail(`${a}.${k}`, `output field name ${JSON.stringify(s)} must not contain '.' or '[' (escape with a backslash for a flat name)`)
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
      if (!Array.isArray(defs) || defs.length === 0) fail(`${a}.${kind}`, 'must be a non-empty array of {op, field?, as?}')
      defs.forEach((d, i) => {
        const da = `${a}.${kind}[${i}]`
        if (!isObj(d)) fail(da, 'must be an object')
        keysOf(d, set('op field as'), da, 'aggregate field def')
        if (typeof d.op !== 'string' || !AGG_OPS.has(d.op)) fail(`${da}.op`, `unknown aggregate op ${JSON.stringify(d.op)}`)
        if (d.op !== 'count' && typeof d.field !== 'string') fail(`${da}.field`, `op "${d.op}" needs a field`)
        if (d.field !== undefined) splitAccessPath(d.field as string)
        if (d.op === 'argmax' || d.op === 'argmin') fail(`${da}.op`, `op "${d.op}" is not supported in transforms (use {"op":"max"} with a join)`)
        if (d.as !== undefined && typeof d.as !== 'string') fail(`${da}.as`, 'must be a string')
      })
      break
    }
    case 'window': {
      const defs = t.window
      if (!Array.isArray(defs) || defs.length === 0) fail(`${a}.window`, 'must be a non-empty array of {op, field?, param?, as?}')
      defs.forEach((d, i) => {
        const da = `${a}.window[${i}]`
        if (!isObj(d)) fail(da, 'must be an object')
        keysOf(d, set('op field param as'), da, 'window field def')
        if (typeof d.op !== 'string' || !WINDOW_OPS.has(d.op)) fail(`${da}.op`, `unknown window op ${JSON.stringify(d.op)}`)
        if (d.op === 'argmax' || d.op === 'argmin') fail(`${da}.op`, `window op "${d.op}" is not supported`)
        if (d.param !== undefined && typeof d.param !== 'number') fail(`${da}.param`, 'must be a number')
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
      if (t.limit !== undefined && typeof t.limit !== 'number') fail(`${a}.limit`, 'must be a number')
      if (t.op !== undefined && !(typeof t.op === 'string' && AGG_OPS.has(t.op))) fail(`${a}.op`, 'unknown aggregate op')
      break
    case 'impute':
      needStr('impute')
      needStr('key')
      if (t.method !== undefined && !['value', 'median', 'max', 'min', 'mean'].includes(t.method as string)) fail(`${a}.method`, `unknown impute method ${JSON.stringify(t.method)}`)
      if (t.frame !== undefined && !(Array.isArray(t.frame) && t.frame.length === 2)) fail(`${a}.frame`, 'must be a [start, end] pair')
      if (t.keyvals !== undefined && !Array.isArray(t.keyvals)) fail(`${a}.keyvals`, 'must be an array (key-value ranges are not supported)')
      break
    case 'lookup':
      needStr('lookup')
      if (!isObj(t.from)) fail(`${a}.from`, 'lookup needs `from`')
      if (t.from.param !== undefined) fail(`${a}.from`, 'lookup from a selection is not supported')
      keysOf(t.from, set('data key fields'), `${a}.from`, 'lookup from')
      if (!isObj(t.from.data)) fail(`${a}.from.data`, 'must be a data source object')
      validateDataSourceObj(t.from.data, `${a}.from.data`)
      if (typeof t.from.key !== 'string') fail(`${a}.from.key`, 'must be a field name')
      if (t.from.fields !== undefined) validateFieldList(t.from.fields, `${a}.from.fields`)
      asNames('as')
      break
    case 'sample':
      if (typeof t.sample !== 'number' || !(t.sample >= 0)) fail(`${a}.sample`, 'must be a non-negative number')
      break
    case 'density':
      needStr('density')
      for (const k of ['bandwidth', 'minsteps', 'maxsteps', 'steps']) if (t[k] !== undefined && typeof t[k] !== 'number') fail(`${a}.${k}`, 'must be a number')
      if (t.extent !== undefined && !(Array.isArray(t.extent) && t.extent.length === 2)) fail(`${a}.extent`, 'must be [min, max]')
      if (t.resolve !== undefined && t.resolve !== 'shared' && t.resolve !== 'independent') fail(`${a}.resolve`, 'must be "shared" or "independent"')
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
      if (t.params === true) fail(`${a}.params`, 'regression `params: true` is not supported')
      asNames('as', 2)
      break
    case 'quantile':
      needStr('quantile')
      asNames('as', 2)
      break
    case 'extent':
      needStr('extent')
      needStr('param')
      if (!/^[A-Za-z_$][\w$]*$/.test(t.param as string)) fail(`${a}.param`, `must be an identifier, got ${JSON.stringify(t.param)}`)
      break
  }
}

function validateCompareList(sort: unknown, at: string): void {
  if (!Array.isArray(sort)) fail(at, 'must be an array of {field, order}')
  sort.forEach((s, i) => {
    if (!isObj(s)) fail(`${at}[${i}]`, 'must be an object')
    keysOf(s, set('field order'), `${at}[${i}]`, 'sort field')
    if (typeof s.field !== 'string') fail(`${at}[${i}].field`, 'must be a field name')
    if (s.order !== undefined && s.order !== 'ascending' && s.order !== 'descending') fail(`${at}[${i}].order`, 'unknown order')
  })
}

function validateDataSourceObj(d: Obj, at: string): void {
  if (d.values === undefined && d.url === undefined && d.name === undefined) fail(at, 'needs `values`, `url` or `name`')
  keysOf(d, set('values url name format'), at, 'data')
}

// --- facet / repeat operators ------------------------------------------------

function validateFacetOperator(spec: Obj, path: string, at: (k: string) => string): void {
  const facet = spec.facet
  if (!isObj(facet)) fail(at('facet'), 'must be a field definition or {row, column}')
  if (!isObj(spec.spec)) fail(at('spec'), 'a facet spec needs a nested `spec`')
  const mapping = facet.row !== undefined || facet.column !== undefined
  const checkFacetDef = (d: unknown, a: string): void => {
    if (!isObj(d)) fail(a, 'must be a field definition')
    keysOf(d, set('field type aggregate bin timeUnit sort title header bandPosition'), a, 'facet field definition')
    if (typeof d.field !== 'string') fail(`${a}.field`, 'a facet field definition needs `field`')
    splitAccessPath(d.field)
    if (d.type === undefined && d.aggregate === undefined && d.bin === undefined && d.timeUnit === undefined) fail(`${a}.type`, 'a facet field definition needs `type`')
    if (d.bin !== undefined) validateBin(d.bin, `${a}.bin`)
    if (d.timeUnit !== undefined) normalizeTimeUnit(d.timeUnit, `${a}.timeUnit`)
    if (d.sort !== undefined) {
      const s = d.sort
      if (!(s === 'ascending' || s === 'descending' || s === null || Array.isArray(s) || isObj(s))) fail(`${a}.sort`, 'unknown facet sort form')
      if (isObj(s)) validateSort(s, `${a}.sort`, 'row')
      if (Array.isArray(s)) validateSort(s, `${a}.sort`, 'row')
    }
    if (d.header !== undefined && !isObj(d.header)) fail(`${a}.header`, 'must be an object')
  }
  if (mapping) {
    keysOf(facet, set('row column'), at('facet'), 'facet mapping')
    if (facet.row !== undefined) checkFacetDef(facet.row, at('facet.row'))
    if (facet.column !== undefined) checkFacetDef(facet.column, at('facet.column'))
    if (spec.columns !== undefined) fail(at('columns'), '`columns` only applies to a single-field (wrapped) facet')
  } else {
    checkFacetDef(facet, at('facet'))
    if (spec.columns !== undefined && !(Number.isInteger(spec.columns) && (spec.columns as number) > 0)) fail(at('columns'), 'must be a positive integer')
  }
  validateView(spec.spec as Obj, at('spec'), false, 'facet')
  void path
}

function validateRepeatOperator(spec: Obj, path: string, at: (k: string) => string): void {
  const rep = spec.repeat
  if (!isObj(spec.spec)) fail(at('spec'), 'a repeat spec needs a nested `spec`')
  const fieldArr = (v: unknown, a: string): void => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string')) fail(a, 'must be a non-empty array of field names')
    for (const f of v as string[]) splitAccessPath(f)
  }
  if (Array.isArray(rep)) {
    fieldArr(rep, at('repeat'))
    if (spec.columns !== undefined && !(Number.isInteger(spec.columns) && (spec.columns as number) > 0)) fail(at('columns'), 'must be a positive integer')
  } else if (isObj(rep)) {
    keysOf(rep, set('row column layer'), at('repeat'), 'repeat')
    for (const k of ['row', 'column', 'layer'] as const) if (rep[k] !== undefined) fieldArr(rep[k], at(`repeat.${k}`))
    if (rep.layer !== undefined && (rep.row !== undefined || rep.column !== undefined)) fail(at('repeat'), 'layer repeats combined with row/column are not supported')
    if (spec.columns !== undefined) fail(at('columns'), '`columns` only applies to an array repeat')
  } else fail(at('repeat'), 'must be an array of fields or {row, column, layer}')
  const prev = repeatVars
  const vars = new Set(prev)
  if (Array.isArray(rep)) vars.add('repeat')
  else if (isObj(rep)) for (const k of ['row', 'column', 'layer']) if (rep[k] !== undefined) vars.add(k)
  repeatVars = vars
  try {
    validateView(spec.spec as Obj, at('spec'), false, 'repeat')
  } finally {
    repeatVars = prev
  }
  void path
}
