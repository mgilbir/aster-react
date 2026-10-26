/**
 * Vega-Lite selections -> Vega: params with `select`, ported from vega-lite 6.4.3 `compile/selection/*`
 * (parse.ts, project.ts, point.ts, interval.ts, toggle.ts, nearest.ts, clear.ts, inputs.ts, legends.ts,
 * scales.ts, translate.ts, zoom.ts, assemble.ts).
 *
 * vega-lite builds these from its model tree; this compiler has none, so a unit's facts (the field behind a
 * channel, its scale, its size signals, its mark name) arrive through {@link SelUnit}. What the selections
 * emit is the same: a `<name>_store` dataset, the signals that turn events into tuples and tuples into store
 * edits (`modify`), brush and voronoi marks, and the top-level signal that resolves the store.
 *
 * Only unit specs and layers of units are supported (their signals live at the root of the Vega spec, like
 * the rest of the engine's event loop; see validate.ts for the refusals).
 */
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import { dateTimeToExpr, dateTimeToTimestamp, isDateTime } from './predicate.js'
import { VLCompileError } from './names.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const array = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...(v as T[])] : [v as T])
const duplicate = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export const SELECTION_ID = '_vgsid_'
export const STORE = '_store'
export const TUPLE = '_tuple'
export const MODIFY = '_modify'
export const TOGGLE = '_toggle'
export const BRUSH = '_brush'
export const SCALE_TRIGGER = '_scale_trigger'
export const TUPLE_FIELDS = '_tuple_fields'
const VL_SELECTION_RESOLVE = 'vlSelectionResolve'
const TRANSLATE_ANCHOR = '_translate_anchor'
const TRANSLATE_DELTA = '_translate_delta'
const ZOOM_ANCHOR = '_zoom_anchor'
const ZOOM_DELTA = '_zoom_delta'
const VORONOI = 'voronoi'

/** vega-lite `varName`: a safe identifier. */
export const varName = (s: string): string => (/^\d+/.test(s) ? '_' : '') + s.replace(/\W/g, '_')

/** vega-util `stringValue`. */
export function stringValue(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map((v) => (v === null ? 'null' : stringValue(v))).join(',')}]`
  if (isObj(x) || typeof x === 'string') return JSON.stringify(x).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return String(x)
}

/** vega-lite `stringify`: stable JSON (keys in sorted order). */
function stringify(data: unknown): string | undefined {
  if (data === undefined) return undefined
  if (typeof data === 'number') return Number.isFinite(data) ? `${data}` : 'null'
  if (typeof data !== 'object') return JSON.stringify(data)
  if (data === null) return 'null'
  if (Array.isArray(data)) return `[${data.map((d) => stringify(d) ?? 'null').join(',')}]`
  const o = data as Obj
  const out: string[] = []
  for (const k of Object.keys(o).sort()) {
    const v = stringify(o[k])
    if (v) out.push(`${JSON.stringify(k)}:${v}`)
  }
  return `{${out.join(',')}}`
}

/** vega-lite `replacePathInField`: the field as a Vega `field:` access path (dots escaped). */
export function replacePathInField(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

// --- configuration -----------------------------------------------------------

/** vega-lite `defaultConfig.selection`. */
const DEFAULT_SELECTION_CONFIG: Record<'point' | 'interval', Obj> = {
  point: { on: 'click', fields: [SELECTION_ID], toggle: 'event.shiftKey', resolve: 'global', clear: 'dblclick' },
  interval: {
    on: '[pointerdown, window:pointerup] > window:pointermove!',
    encodings: ['x', 'y'],
    translate: '[pointerdown, window:pointerup] > window:pointermove!',
    zoom: 'wheel!',
    mark: { fill: '#333', fillOpacity: 0.125, stroke: 'white' },
    resolve: 'global',
    clear: 'dblclick',
  },
}

function mergeInto(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? mergeInto(out[k] as Obj, v) : duplicate(v)
  return out
}

/** `config.selection` over the defaults (vega-lite `writeConfig(…, 'selection', selection, true)`). */
export function selectionConfigOf(config: unknown): Record<'point' | 'interval', Obj> {
  const user = isObj(config) && isObj(config.selection) ? config.selection : {}
  return {
    point: mergeInto(DEFAULT_SELECTION_CONFIG.point, isObj(user.point) ? user.point : {}),
    interval: mergeInto(DEFAULT_SELECTION_CONFIG.interval, isObj(user.interval) ? user.interval : {}),
  }
}

// --- components --------------------------------------------------------------

/** Whether the tuple stores enumerated values (`E`), a range (`R`) or a bin's [start, end) (`R-RE`). */
export type TupleStoreType = 'E' | 'R' | 'R-RE'

export interface SelProjection {
  type: TupleStoreType
  field: string
  index: number
  channel?: string
  signals: { data?: string; visual?: string }
  hasLegend?: boolean
}

export interface TimeUnitProjection {
  /** the datum key the time unit is stored under (its `as`) */
  as: string
  /** the channel's field */
  field: string
  /** the time unit definition (normalized by the caller) */
  timeUnit: unknown
}

export interface SelProject {
  items: SelProjection[]
  hasChannel: Record<string, SelProjection>
  hasField: Record<string, SelProjection>
  hasSelectionId: boolean
  timeUnits: TimeUnitProjection[]
}

export interface SelCmpt {
  name: string
  type: 'point' | 'interval'
  /** one entry per initial tuple: the value of each projection */
  init?: unknown[][]
  events?: StreamDef[]
  bind?: unknown
  resolve: 'global' | 'union' | 'intersect'
  mark?: Obj
  toggle?: string | false
  translate?: string | false
  zoom?: string | false
  nearest?: boolean
  clear?: StreamDef[] | false | string
  project: SelProject
  scales?: SelProjection[]
  on?: unknown
  [k: string]: unknown
}

/** What the selection compiler needs to know about the unit it is compiled for. */
export interface SelUnitField {
  /** the datum key the channel's value is read from */
  field: string
  /** the user's field text */
  source: string
  aggregate?: string
  bin?: boolean
  /** the field has a (non-binned) time unit */
  timeUnit?: unknown
}

export interface SelUnit {
  /** `model.name`: '' for a root unit, `layer_0` for a layer's first child, a spec's own `name`. */
  name: string
  /** `model.getName(text)` */
  getName(text: string): string
  fieldDef(channel: string): SelUnitField | undefined
  /** `model.vgField(channel, opt)`: the derived field (bin start / end, time unit, aggregate) the channel reads. */
  vgField(channel: string, opt?: { binSuffix?: 'end' }): string
  /** the time-unit transform output a projection over this channel needs */
  timeUnitProjection(channel: string): TimeUnitProjection
  /** `model.scaleName(channel)` */
  scaleName(channel: string): string
  /** `model.getScaleComponent(channel).get('type')` */
  scaleType(channel: string): string | undefined
  /** the scale's `reverse` flag (set by `sort: "descending"` on the field) */
  scaleReverse(channel: string): boolean
  scaleProp(channel: string, prop: 'exponent' | 'constant'): number | undefined
  /** `model.getSizeSignalRef(layout).signal` */
  sizeSignal(layout: 'width' | 'height'): string
  mark: string
  /** `model.component.mark[0].name` */
  firstMarkName: string
  /** a scale bound to the selection: its domain follows the selection (`selectionExtent`) */
  bindScale(channel: string, extent: { param: string; field: string }): void
  /** the channel's tooltip encoding for the voronoi cells (vega-lite `tooltip(model, {reactiveGeom: true})`) */
  voronoiTooltip(): Obj
  /** a name of this unit's legend-bound channel, e.g. for `hasLegend` */
}

const TIMER = (e: StreamDef): boolean => e.type === 'timer'

export const isScaleChannel = (c: string): boolean => c === 'x' || c === 'y'

/** vega-lite `hasContinuousDomain` */
export function hasContinuousDomain(type: string | undefined): boolean {
  return type !== undefined && ['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'quantile', 'quantize', 'threshold', 'sequential'].includes(type)
}

const isLegendBinding = (bind: unknown): boolean => bind === 'legend' || (isObj(bind) && !!bind.legend)
const isLegendStreamBinding = (bind: unknown): boolean => isLegendBinding(bind) && isObj(bind)

/** inputs.ts `defined` */
const inputsDefined = (c: SelCmpt): boolean => c.type === 'point' && c.resolve === 'global' && !!c.bind && c.bind !== 'scales' && !isLegendBinding(c.bind)
/** scales.ts `defined` */
const scalesDefined = (c: SelCmpt): boolean => c.type === 'interval' && c.resolve === 'global' && !!c.bind && c.bind === 'scales'

// --- parse -------------------------------------------------------------------

function disableDirectManipulation(c: SelCmpt, def: Obj): void {
  const sel = def.select
  if (typeof sel === 'string' || !isObj(sel) || !sel.on) delete c.events
  if (typeof sel === 'string' || !isObj(sel) || !sel.clear) delete c.clear
  if (typeof sel === 'string' || !isObj(sel) || !sel.toggle) delete c.toggle
}

/**
 * parse.ts parseUnitSelection: the components of one unit's selection params. `names` is the set of parameter
 * names the caller has seen (for duplicate checks) and not used otherwise.
 */
export function parseUnitSelections(unit: SelUnit, defs: Obj[], config: unknown): Record<string, SelCmpt> {
  const cmpts: Record<string, SelCmpt> = {}
  const selectionConfig = selectionConfigOf(config)
  for (const def of defs) {
    const name = varName(def.name as string)
    const selDef = def.select
    const type = (typeof selDef === 'string' ? selDef : (selDef as Obj).type) as 'point' | 'interval'
    const defaults: Obj = isObj(selDef) ? duplicate(selDef) : { type }

    // Default values from the config where the property is not specified, or is `true` ("translate": true uses the
    // default event handlers; true may also be a real value, e.g. "nearest": true).
    const cfg = selectionConfig[type]
    for (const key of Object.keys(cfg)) {
      if (key === 'fields' || key === 'encodings') continue // the projection applies its defaults
      if (key === 'mark') defaults.mark = { ...(cfg.mark as Obj), ...(defaults.mark as Obj | undefined) }
      if (defaults[key] === undefined || defaults[key] === true) defaults[key] = duplicate(cfg[key] ?? defaults[key])
    }

    const cmpt = {
      ...defaults,
      name,
      type,
      init: def.value,
      bind: def.bind,
      events: typeof defaults.on === 'string' ? parseEventSelectorString(defaults.on, 'scope') : array(duplicate(defaults.on) as StreamDef | StreamDef[]),
    } as unknown as SelCmpt
    cmpts[name] = cmpt

    if (cmpt.events?.find(TIMER)) throw new VLCompileError(`selection "${name}": timer events (animation) are not supported`)

    const def_ = duplicate(def)
    parsePoint(cmpt)
    parseInterval(unit, cmpt)
    parseProject(unit, cmpt, def_, selectionConfig)
    if (inputsDefined(cmpt)) disableDirectManipulation(cmpt, def_)
    if (scalesDefined(cmpt)) parseScales(unit, cmpt)
    if (legendsDefined(cmpt)) parseLegends(cmpt, def_)
    if (cmpt.clear !== undefined && cmpt.clear !== false) cmpt.clear = typeof cmpt.clear === 'string' ? parseEventSelectorString(cmpt.clear, 'view') : cmpt.clear
    if (cmpt.type === 'point' && cmpt.nearest) parseNearest(unit, cmpt)
  }
  return cmpts
}

function parsePoint(_c: SelCmpt): void {
  // point.ts has no parse step
}

/** interval.ts parse: dragging the brush must not start a new brush. */
function parseInterval(_unit: SelUnit, c: SelCmpt): void {
  if (c.type !== 'interval') return
  if (c.translate && !scalesDefined(c)) {
    const filterExpr = `!event.item || event.item.mark.name !== ${stringValue(c.name + BRUSH)}`
    for (const evt of c.events ?? []) {
      if (!evt.between) continue // vega-lite warns: "not an ordered event stream for interval selections"
      const first = evt.between[0]!
      const filters = array(first.filter ?? [])
      first.filter = filters
      if (!filters.includes(filterExpr)) filters.push(filterExpr)
    }
  }
}

/** nearest.ts parse: scope the selection events to the voronoi mark. */
function parseNearest(unit: SelUnit, c: SelCmpt): void {
  for (const s of c.events ?? []) s.markname = unit.getName(VORONOI)
}

/** project.ts parse */
function parseProject(unit: SelUnit, c: SelCmpt, selDef: Obj, selectionConfig: Record<'point' | 'interval', Obj>): void {
  const name = c.name
  const proj: SelProject = { items: [], hasChannel: {}, hasField: {}, hasSelectionId: false, timeUnits: [] }
  c.project = proj
  const parsed: Record<string, SelProjection> = {}
  const timeUnits: Record<string, TimeUnitProjection> = {}

  const signals = new Set<string>()
  const signalName = (p: { channel?: string; field: string }, range: 'data' | 'visual'): { data?: string; visual?: string } => {
    const suffix = range === 'visual' ? p.channel : p.field
    let sg = varName(`${name}_${suffix}`)
    for (let counter = 1; signals.has(sg); counter++) sg = varName(`${name}_${suffix}_${counter}`)
    signals.add(sg)
    return { [range]: sg }
  }

  const type = c.type
  const cfg = selectionConfig[type]
  const init = selDef.value !== undefined ? array(selDef.value as unknown) : null

  // No explicit projection (fields or encodings): infer it from an initial value, else use the defaults.
  const sel = isObj(selDef.select) ? selDef.select : {}
  let fields = sel.fields as string[] | undefined
  let encodings = sel.encodings as string[] | undefined
  if (!fields && !encodings && init) {
    for (const initVal of init) {
      // an initial value may be a scalar, to ease the way from variable params to point selections
      if (!isObj(initVal)) continue
      for (const key of Object.keys(initVal)) {
        if (isSingleDefUnitChannel(key)) {
          ;(encodings ??= []).push(key)
        } else if (type === 'interval') {
          // vega-lite warns (an interval initialized with a field name) and falls back to the default encodings
          encodings = cfg.encodings as string[]
        } else {
          ;(fields ??= []).push(key)
        }
      }
    }
  }
  if (!fields && !encodings) {
    encodings = cfg.encodings as string[] | undefined
    if ('fields' in cfg) fields = cfg.fields as string[]
  }

  for (const channel of encodings ?? []) {
    const fieldDef = unit.fieldDef(channel)
    if (!fieldDef) continue // vega-lite warns: cannot project a selection on a channel without a field
    let field = fieldDef.source
    if (fieldDef.aggregate) continue // cannot project an aggregate
    if (!field) continue
    if (fieldDef.timeUnit) {
      field = unit.vgField(channel)
      const component = unit.timeUnitProjection(channel)
      timeUnits[JSON.stringify([component.as, component.field])] = component
    }
    // Prevent duplicate projections on the same field.
    if (!parsed[field]) {
      // Interval selections store ranges for continuous scales, and enumerations otherwise. Point selections
      // store ranges for binned fields, and enumerations otherwise.
      const tupleType: TupleStoreType = type === 'interval' && isScaleChannel(channel) && hasContinuousDomain(unit.scaleType(channel)) ? 'R' : fieldDef.bin ? 'R-RE' : 'E'
      const p: SelProjection = { field, channel, type: tupleType, index: proj.items.length, signals: {} }
      p.signals = { ...signalName(p, 'data'), ...signalName(p, 'visual') }
      proj.items.push((parsed[field] = p))
      proj.hasField[field] = p
      proj.hasSelectionId = proj.hasSelectionId || field === SELECTION_ID
      proj.hasChannel[channel] = p
    }
  }

  for (const field of fields ?? []) {
    if (proj.hasField[field]) continue
    const p: SelProjection = { type: 'E', field, index: proj.items.length, signals: {} }
    p.signals = { ...signalName(p, 'data') }
    proj.items.push(p)
    proj.hasField[field] = p
    proj.hasSelectionId = proj.hasSelectionId || field === SELECTION_ID
  }

  if (init) {
    // An initial value is either an object mapping projections to values, or a scalar value.
    c.init = init.map((v) => proj.items.map((p) => (isObj(v) ? (v[p.channel as string] !== undefined ? v[p.channel as string] : v[p.field]) : v)))
  }
  proj.timeUnits = Object.values(timeUnits)
}

const SINGLE_DEF_UNIT_CHANNELS = new Set([
  'x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'xError', 'yError', 'xError2', 'yError2', 'theta', 'theta2', 'radius', 'radius2',
  'longitude', 'latitude', 'longitude2', 'latitude2', 'color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth',
  'strokeDash', 'size', 'angle', 'shape', 'key', 'text', 'href', 'url', 'description', 'detail', 'order', 'tooltip', 'time',
])
const isSingleDefUnitChannel = (k: string): boolean => SINGLE_DEF_UNIT_CHANNELS.has(k)

/** scales.ts parse */
function parseScales(unit: SelUnit, c: SelCmpt): void {
  const bound: SelProjection[] = (c.scales = [])
  for (const proj of c.project.items) {
    const channel = proj.channel
    if (channel === undefined || !isScaleChannel(channel)) continue
    if (!hasContinuousDomain(unit.scaleType(channel))) continue // vega-lite warns: scale bindings are only supported for continuous scales
    unit.bindScale(channel, { param: c.name, field: proj.field })
    bound.push(proj)
  }
}

/** legends.ts `defined`, without the warning (the caller reports unusable bindings) */
function legendsDefined(c: SelCmpt): boolean {
  const spec = c.resolve === 'global' && !!c.bind && isLegendBinding(c.bind)
  const projLen = c.project.items.length === 1 && c.project.items[0]!.field !== SELECTION_ID
  return spec && projLen
}

function parseLegends(c: SelCmpt, selDef: Obj): void {
  // Legend items are toggleable by default although direct manipulation is disabled.
  const sel = selDef.select
  const select = typeof sel === 'string' ? { type: sel, toggle: c.toggle } : { ...(sel as Obj), toggle: c.toggle }
  disableDirectManipulation(c, { ...selDef, select })

  const s = selDef.select
  if (isObj(s) && (s.on || s.clear)) {
    const legendFilter = 'event.item && indexof(event.item.mark.role, "legend") < 0'
    for (const evt of c.events ?? []) {
      evt.filter = array(evt.filter ?? [])
      if (!(evt.filter as string[]).includes(legendFilter)) (evt.filter as string[]).push(legendFilter)
    }
  }

  const bind = c.bind
  const evt = isLegendStreamBinding(bind) ? (bind as Obj).legend : 'click'
  const stream: StreamDef[] = typeof evt === 'string' ? parseEventSelectorString(evt, 'view') : array(evt as StreamDef | StreamDef[])
  c.bind = { legend: { merge: stream } }
}

/** Marks `hasLegend` on the selections bound to the legend of `channel` (legends.ts parseInteractiveLegend). Returns their names. */
export function interactiveLegendSelections(cmpts: Record<string, SelCmpt>, channel: string, field: string | undefined): string[] {
  const names: string[] = []
  for (const c of Object.values(cmpts)) {
    const proj = (field !== undefined ? c.project.hasField[field] : undefined) ?? c.project.hasChannel[channel]
    if (proj && legendsDefined(c)) {
      names.push(c.name)
      proj.hasLegend = true
    }
  }
  return names
}

/** Whether any of the selections projects `_vgsid_` (so the data needs identifiers). */
export const requiresSelectionId = (cmpts: Record<string, SelCmpt>): boolean => Object.values(cmpts).some((c) => c.project.hasSelectionId)

// --- predicates --------------------------------------------------------------

/** What a predicate over a parameter needs to find: the selection components by (sanitized) name. */
export interface SelLookup {
  get(name: string): SelCmpt | undefined
}

export type ParamPredicate = string | { param: string; empty?: boolean }

/** parse.ts parseSelectionPredicate: the expression testing `datum` against a selection (or a variable parameter, coerced to boolean). */
export function selectionPredicate(lookup: SelLookup, pred: ParamPredicate, datum = 'datum'): string {
  const name = typeof pred === 'string' ? pred : pred.param
  const vname = varName(name)
  const store = stringValue(vname + STORE)
  const cmpt = lookup.get(vname)
  if (!cmpt) return `!!${vname}` // not a selection: a variable parameter
  const fn = cmpt.project.hasSelectionId ? 'vlSelectionIdTest(' : 'vlSelectionTest('
  const resolve = cmpt.resolve === 'global' ? ')' : `, ${stringValue(cmpt.resolve)})`
  const test = `${fn}${store}, ${datum}${resolve}`
  const length = `length(data(${store}))`
  return typeof pred !== 'string' && pred.empty === false ? `${length} && ${test}` : `!${length} || ${test}`
}

/** parse.ts parseSelectionExtent: the expression for a scale domain / bin extent that is a parameter. */
export function selectionExtent(lookup: SelLookup, name: string, extent: { field?: string; encoding?: string }): string {
  const vname = varName(name)
  const cmpt = lookup.get(vname)
  if (!cmpt) return vname // a variable parameter
  let field = extent.field
  if (!extent.encoding && !field) {
    field = cmpt.project.items[0]!.field
  } else if (extent.encoding && !field) {
    const encodings = cmpt.project.items.filter((p) => p.channel === extent.encoding)
    if (encodings.length !== 1) field = cmpt.project.items[0]!.field
    else field = encodings[0]!.field
  }
  return `${cmpt.name}[${stringValue(replacePathInField(field!))}]`
}

// --- assemble ----------------------------------------------------------------

type Signal = Obj

export function assembleProjection(p: SelProjection): Obj {
  const { signals: _s, hasLegend: _l, index: _i, ...rest } = p
  void _s
  void _l
  void _i
  return { ...rest, field: replacePathInField(p.field) }
}

/** assemble.ts assembleInit */
export function assembleInit(init: unknown, isExpr = true, wrap: (s: string | number) => string | number = (x) => x): unknown {
  if (Array.isArray(init)) {
    const assembled = init.map((v) => assembleInit(v, isExpr, wrap))
    return isExpr ? `[${assembled.join(', ')}]` : assembled
  } else if (isDateTime(init)) {
    return isExpr ? wrap(dateTimeToExpr(init)) : wrap(dateTimeToTimestamp(init))
  }
  return isExpr ? wrap(stringify(init) as string) : init
}

const unitNameOf = (unit: SelUnit): string => stringValue(unit.name)

const datumOf = (c: SelCmpt): string => (c.nearest ? '(item().isVoronoi ? datum.datum : datum)' : 'datum')

function signalIndex(signals: Signal[], name: string | undefined): number {
  return signals.findIndex((s) => s.name === name)
}

// point.ts signals
function pointSignals(unit: SelUnit, cmpts: Record<string, SelCmpt>, c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const fieldsSg = name + TUPLE_FIELDS
  const project = c.project
  const datum = '(item().isVoronoi ? datum.datum : datum)'

  // Only add a discrete selection to the store if a datum is present _and_ the interaction isn't occurring on a
  // group mark (it would pollute the interactive state in faceted displays). The update is forced to account for
  // constant null states but varying toggles.
  const brushes = Object.values(cmpts)
    .reduce<string[]>((acc, cmpt) => (cmpt.type === 'interval' ? acc.concat(cmpt.name + BRUSH) : acc), [])
    .map((b) => `indexof(item().mark.name, '${b}') < 0`)
    .join(' && ')

  const test = `datum && item().mark.marktype !== 'group' && indexof(item().mark.role, 'legend') < 0${brushes ? ` && ${brushes}` : ''}`

  let update = `unit: ${unitNameOf(unit)}, `
  if (project.hasSelectionId) {
    update += `${SELECTION_ID}: ${datum}[${stringValue(SELECTION_ID)}]`
  } else {
    const values = project.items
      .map((p) => {
        const fieldDef = unit.fieldDef(p.channel as string)
        // Binned fields capture extents, for a range test against the raw field.
        return fieldDef?.bin
          ? `[${datum}[${stringValue(unit.vgField(p.channel as string))}], ${datum}[${stringValue(unit.vgField(p.channel as string, { binSuffix: 'end' }))}]]`
          : `${datum}[${stringValue(p.field)}]`
      })
      .join(', ')
    update += `fields: ${fieldsSg}, values: [${values}]`
  }

  const events = c.events
  return signals.concat([{
    name: name + TUPLE,
    on: events ? [{ events, update: `${test} ? {${update}} : null`, force: true }] : [],
  }])
}

// project.ts signals
function projectSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name + TUPLE_FIELDS
  const has = signals.filter((s) => s.name === name)
  return has.length > 0 || c.project.hasSelectionId ? signals : signals.concat({ name, value: c.project.items.map(assembleProjection) })
}

// toggle.ts
const toggleDefined = (c: SelCmpt): boolean => c.type === 'point' && !!c.toggle

function toggleSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  return signals.concat({ name: c.name + TOGGLE, value: false, on: [{ events: c.events, update: c.toggle }] })
}

function toggleModifyExpr(unit: SelUnit, c: SelCmpt): string {
  const tpl = c.name + TUPLE
  const signal = c.name + TOGGLE
  return `${signal} ? null : ${tpl}, ${c.resolve === 'global' ? `${signal} ? null : true, ` : `${signal} ? null : {unit: ${unitNameOf(unit)}}, `}${signal} ? ${tpl} : null`
}

// inputs.ts
function inputsTopLevelSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const bind = c.bind as Obj
  const init = c.init?.[0] // only single selections have one initial value
  const datum = c.type === 'point' && c.nearest ? '(item().isVoronoi ? datum.datum : datum)' : 'datum'

  c.project.items.forEach((p, i) => {
    const sgname = varName(`${name}_${p.field}`)
    const has = signals.filter((s) => s.name === sgname)
    if (!has.length) {
      signals.unshift({
        name: sgname,
        ...(init ? { init: assembleInit(init[i]) } : { value: null }),
        on: c.events
          ? [{ events: c.events, update: `datum && item().mark.marktype !== 'group' ? ${datum}[${stringValue(p.field)}] : null` }]
          : [],
        bind: bind[p.field] ?? bind[p.channel as string] ?? bind,
      })
    }
  })
  return signals
}

function inputsSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const signal = signals.find((s) => s.name === name + TUPLE)!
  const fields = name + TUPLE_FIELDS
  const values = c.project.items.map((p) => varName(`${name}_${p.field}`))
  const valid = values.map((v) => `${v} !== null`).join(' && ')
  if (values.length) signal.update = `${valid} ? {fields: ${fields}, values: [${values.join(', ')}]} : null`
  delete signal.value
  delete signal.on
  return signals
}

// legends.ts
function legendsTopLevelSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const selName = c.name
  const stream = isLegendStreamBinding(c.bind) ? ((c.bind as Obj).legend as { merge: StreamDef[] }) : undefined
  const markName = (name: string) => (s: StreamDef): StreamDef => ({ ...duplicate(s), markname: name })

  for (const proj of c.project.items) {
    if (!proj.hasLegend) continue
    const prefix = `${varName(proj.field)}_legend`
    const sgName = `${selName}_${prefix}`
    const has = signals.filter((s) => s.name === sgName)
    if (has.length === 0) {
      const merge = stream!.merge
      const events = merge.map(markName(`${prefix}_symbols`)).concat(merge.map(markName(`${prefix}_labels`))).concat(merge.map(markName(`${prefix}_entries`)))
      signals.unshift({
        name: sgName,
        ...(!c.init ? { value: null } : {}),
        on: [
          // Legend entries do not store values, so the scenegraph is walked to the symbol datum.
          { events, update: 'isDefined(datum.value) ? datum.value : item().items[0].items[0].datum.value', force: true },
          { events: merge, update: `!event.item || !datum ? null : ${sgName}`, force: true },
        ],
      })
    }
  }
  return signals
}

function legendsSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const tuple = signals.find((s) => s.name === name + TUPLE)!
  const fields = name + TUPLE_FIELDS
  const values = c.project.items.filter((p) => p.hasLegend).map((p) => varName(`${name}_${varName(p.field)}_legend`))
  const valid = values.map((v) => `${v} !== null`).join(' && ')
  const update = `${valid} ? {fields: ${fields}, values: [${values.join(', ')}]} : null`

  if (c.events && values.length > 0) {
    ;(tuple.on as Obj[]).push({ events: values.map((signal) => ({ signal })), update })
  } else if (values.length > 0) {
    tuple.update = update
    delete tuple.value
    delete tuple.on
  }

  const toggle = signals.find((s) => s.name === name + TOGGLE)
  const events = isLegendStreamBinding(c.bind) && (c.bind as Obj).legend
  if (toggle) {
    const on = toggle.on as Obj[]
    if (!c.events) on[0]!.events = events
    else on.push({ ...on[0], events })
  }
  return signals
}

// clear.ts
const clearDefined = (c: SelCmpt): boolean => c.clear !== undefined && c.clear !== false

function clearTopLevelSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  if (inputsDefined(c)) {
    for (const proj of c.project.items) {
      const idx = signals.findIndex((n) => n.name === varName(`${c.name}_${proj.field}`))
      if (idx !== -1) (signals[idx]!.on as Obj[]).push({ events: c.clear, update: 'null' })
    }
  }
  return signals
}

function clearSignals(c: SelCmpt, signals: Signal[]): Signal[] {
  const addClear = (idx: number, update: string): void => {
    if (idx !== -1 && signals[idx]!.on) (signals[idx]!.on as Obj[]).push({ events: c.clear, update })
  }
  // Be as minimalist as possible when adding clear triggers, to minimize dataflow execution.
  if (c.type === 'interval') {
    for (const proj of c.project.items) {
      const vIdx = signalIndex(signals, proj.signals.visual)
      addClear(vIdx, '[0, 0]')
      if (vIdx === -1) addClear(signalIndex(signals, proj.signals.data), 'null')
    }
  } else {
    let tIdx = signalIndex(signals, c.name + TUPLE)
    addClear(tIdx, 'null')
    if (toggleDefined(c)) {
      tIdx = signalIndex(signals, c.name + TOGGLE)
      addClear(tIdx, 'false')
    }
  }
  return signals
}

// interval.ts
function channelSignals(unit: SelUnit, c: SelCmpt, proj: SelProjection, init: unknown): Signal[] {
  const channel = proj.channel as string
  const vname = proj.signals.visual as string
  const scaleName = stringValue(unit.scaleName(channel))
  const scaled = (str: string | number): string => `scale(${scaleName}, ${str})`

  const size = unit.sizeSignal(channel === 'x' ? 'width' : 'height')
  const coord = `${channel}(unit)`
  const von = (c.events ?? []).reduce<Obj[]>((def, evt) => [
    ...def,
    { events: (evt.between as StreamDef[])[0], update: `[${coord}, ${coord}]` }, // brush start
    { events: evt, update: `[${vname}[0], clamp(${coord}, 0, ${size})]` }, // brush end
  ], [])

  const dname = proj.signals.data as string
  const hasScales = scalesDefined(c)
  const scaleType = unit.scaleType(channel)
  const vinit: Obj = init ? { init: assembleInit(init, true, scaled) } : { value: [] }

  // React to pan/zooms of continuous scales. Non-continuous scales (band, point) cannot be pan/zoomed, and any
  // other change to their domains (e.g. filtering) clears the brushes.
  von.push({
    events: { signal: c.name + SCALE_TRIGGER },
    update: hasContinuousDomain(scaleType) ? `[${scaled(`${dname}[0]`)}, ${scaled(`${dname}[1]`)}]` : '[0, 0]',
  })

  return hasScales
    ? [{ name: dname, on: [] }]
    : [
        { name: vname, ...vinit, on: von },
        {
          name: dname,
          ...(init ? { init: assembleInit(init) } : {}), // cannot be `value`: init may require datetime expressions
          on: [{ events: { signal: vname }, update: `${vname}[0] === ${vname}[1] ? null : invert(${scaleName}, ${vname})` }],
        },
      ]
}

function intervalSignals(unit: SelUnit, c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const tupleSg = name + TUPLE
  const channels = Object.values(c.project.hasChannel).filter((p) => p.channel === 'x' || p.channel === 'y')
  const init = c.init ? c.init[0]! : null

  for (const proj of channels) for (const s of channelSignals(unit, c, proj, init?.[proj.index])) signals.push(s)

  // Proxy scale reactions so that no infinite loop occurs when an interval selection filter touches the scale.
  if (!scalesDefined(c)) {
    const triggerSg = name + SCALE_TRIGGER
    const scaleTriggers = channels.map((proj) => {
      const channel = proj.channel as string
      const { data: dname, visual: vname } = proj.signals
      const sn = stringValue(unit.scaleName(channel))
      const toNum = hasContinuousDomain(unit.scaleType(channel)) ? '+' : ''
      return `(!isArray(${dname}) || (${toNum}invert(${sn}, ${vname})[0] === ${toNum}${dname}[0] && ${toNum}invert(${sn}, ${vname})[1] === ${toNum}${dname}[1]))`
    })
    if (scaleTriggers.length) {
      signals.push({
        name: triggerSg,
        value: {},
        on: [{ events: channels.map((proj) => ({ scale: unit.scaleName(proj.channel as string) })), update: `${scaleTriggers.join(' && ')} ? ${triggerSg} : {}` }],
      })
    }
  }

  // Only add an interval to the store if it has valid data extents. Extents are null when the pixel extents are
  // equal, to account for intervals over ordinal domains which, inverted, still produce a valid datum.
  const dataSignals = channels.map((proj) => proj.signals.data)
  const update = `unit: ${unitNameOf(unit)}, fields: ${name + TUPLE_FIELDS}, values`
  return signals.concat({
    name: tupleSg,
    ...(init ? { init: `{${update}: ${assembleInit(init)}}` } : {}),
    ...(dataSignals.length
      ? {
          on: [{
            events: [{ signal: dataSignals.join(' || ') }], // prevents double invocation, see vega/vega#1672
            update: `${dataSignals.join(' && ')} ? {${update}: [${dataSignals}]} : null`,
          }],
        }
      : {}),
  })
}

// translate.ts / zoom.ts
function panZoomFn(kind: 'pan' | 'zoom', unit: SelUnit, c: SelCmpt, channel: string, boundScales: boolean): { fn: string; arg: string } {
  const type = unit.scaleType(channel)
  const hasScale = type !== undefined
  const cap = kind === 'pan' ? 'pan' : 'zoom'
  const fn = !boundScales || !hasScale ? `${cap}Linear` : type === 'log' ? `${cap}Log` : type === 'symlog' ? `${cap}Symlog` : type === 'pow' ? `${cap}Pow` : `${cap}Linear`
  const arg = !boundScales ? '' : type === 'pow' ? `, ${unit.scaleProp(channel, 'exponent') ?? 1}` : type === 'symlog' ? `, ${unit.scaleProp(channel, 'constant') ?? 1}` : ''
  void c
  return { fn, arg }
}

const domainOf = (unit: SelUnit, channel: string): string => `domain(${stringValue(unit.scaleName(channel))})`

function translateOnDelta(unit: SelUnit, c: SelCmpt, proj: SelProjection, size: 'width' | 'height', signals: Signal[]): void {
  const name = c.name
  const anchor = name + TRANSLATE_ANCHOR
  const delta = name + TRANSLATE_DELTA
  const channel = proj.channel as string
  const boundScales = scalesDefined(c)
  const signal = signals.find((s) => s.name === proj.signals[boundScales ? 'data' : 'visual'])!
  const sizeSg = unit.sizeSignal(size)
  const reversed = unit.scaleReverse(channel)
  const sign = !boundScales ? '' : channel === 'x' ? (reversed ? '' : '-') : reversed ? '-' : ''
  const extent = `${anchor}.extent_${channel}`
  const offset = `${sign}${delta}.${channel} / ${boundScales ? sizeSg : `span(${extent})`}`
  const { fn, arg } = panZoomFn('pan', unit, c, channel, boundScales)
  const update = `${fn}(${extent}, ${offset}${arg})`
  ;(signal.on as Obj[]).push({ events: { signal: delta }, update: boundScales ? update : `clampRange(${update}, 0, ${sizeSg})` })
}

function translateSignals(unit: SelUnit, c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const boundScales = scalesDefined(c)
  const anchor = name + TRANSLATE_ANCHOR
  const { x, y } = c.project.hasChannel
  let events = parseEventSelectorString(c.translate as string, 'scope')
  if (!boundScales) events = events.map((e) => ((e.between![0]!.markname = name + BRUSH), e))

  signals.push(
    {
      name: anchor,
      value: {},
      on: [{
        events: events.map((e) => e.between![0]),
        update: `{x: x(unit), y: y(unit)${x !== undefined ? `, extent_x: ${boundScales ? domainOf(unit, 'x') : `slice(${x.signals.visual})`}` : ''}${y !== undefined ? `, extent_y: ${boundScales ? domainOf(unit, 'y') : `slice(${y.signals.visual})`}` : ''}}`,
      }],
    },
    { name: name + TRANSLATE_DELTA, value: {}, on: [{ events, update: `{x: ${anchor}.x - x(unit), y: ${anchor}.y - y(unit)}` }] },
  )
  if (x !== undefined) translateOnDelta(unit, c, x, 'width', signals)
  if (y !== undefined) translateOnDelta(unit, c, y, 'height', signals)
  return signals
}

function zoomOnDelta(unit: SelUnit, c: SelCmpt, proj: SelProjection, size: 'width' | 'height', signals: Signal[]): void {
  const name = c.name
  const channel = proj.channel as string
  const boundScales = scalesDefined(c)
  const signal = signals.find((s) => s.name === proj.signals[boundScales ? 'data' : 'visual'])!
  const sizeSg = unit.sizeSignal(size)
  const base = boundScales ? domainOf(unit, channel) : (signal.name as string)
  const delta = name + ZOOM_DELTA
  const anchor = `${name}${ZOOM_ANCHOR}.${channel}`
  const { fn, arg } = panZoomFn('zoom', unit, c, channel, boundScales)
  const update = `${fn}(${base}, ${anchor}, ${delta}${arg})`
  ;(signal.on as Obj[]).push({ events: { signal: delta }, update: boundScales ? update : `clampRange(${update}, 0, ${sizeSg})` })
}

function zoomSignals(unit: SelUnit, c: SelCmpt, signals: Signal[]): Signal[] {
  const name = c.name
  const boundScales = scalesDefined(c)
  const delta = name + ZOOM_DELTA
  const { x, y } = c.project.hasChannel
  const sx = stringValue(unit.scaleName('x'))
  const sy = stringValue(unit.scaleName('y'))
  let events = parseEventSelectorString(c.zoom as string, 'scope')
  if (!boundScales) events = events.map((e) => ((e.markname = name + BRUSH), e))

  signals.push(
    {
      name: name + ZOOM_ANCHOR,
      on: [{
        events,
        update: !boundScales
          ? '{x: x(unit), y: y(unit)}'
          : `{${[sx ? `x: invert(${sx}, x(unit))` : '', sy ? `y: invert(${sy}, y(unit))` : ''].filter((e) => e).join(', ')}}`,
      }],
    },
    { name: delta, on: [{ events, force: true, update: 'pow(1.001, event.deltaY * pow(16, event.deltaMode))' }] },
  )
  if (x !== undefined) zoomOnDelta(unit, c, x, 'width', signals)
  if (y !== undefined) zoomOnDelta(unit, c, y, 'height', signals)
  return signals
}

/** assemble.ts assembleUnitSelectionSignals */
export function assembleUnitSelectionSignals(unit: SelUnit, cmpts: Record<string, SelCmpt>): Signal[] {
  let signals: Signal[] = []
  for (const c of Object.values(cmpts)) {
    let modifyExpr = `${c.name}${TUPLE}, ${c.resolve === 'global' ? 'true' : `{unit: ${unitNameOf(unit)}}`}`
    const isPoint = c.type === 'point'
    const isInterval = c.type === 'interval'
    // the compilers run in vega-lite's order: point, interval, project, toggle, inputs, scales, legends, clear, translate, zoom, nearest
    if (isPoint) signals = pointSignals(unit, cmpts, c, signals)
    if (isInterval) signals = intervalSignals(unit, c, signals)
    signals = projectSignals(c, signals)
    if (toggleDefined(c)) {
      signals = toggleSignals(c, signals)
      modifyExpr = toggleModifyExpr(unit, c)
    }
    if (inputsDefined(c)) signals = inputsSignals(c, signals)
    if (legendsDefined(c)) signals = legendsSignals(c, signals)
    if (clearDefined(c)) signals = clearSignals(c, signals)
    if (isInterval && c.translate) signals = translateSignals(unit, c, signals)
    if (isInterval && c.zoom) signals = zoomSignals(unit, c, signals)
    signals.push({
      name: c.name + MODIFY,
      on: [{ events: { signal: c.name + TUPLE }, update: `modify(${stringValue(c.name + STORE)}, ${modifyExpr})` }],
    })
  }
  return cleanupEmptyOn(signals)
}

/** assemble.ts assembleTopLevelSignals */
export function assembleTopLevelSelectionSignals(cmpts: Record<string, SelCmpt>, signals: Signal[]): Signal[] {
  let hasSelections = false
  for (const c of Object.values(cmpts)) {
    const name = c.name
    const store = stringValue(name + STORE)
    if (signals.filter((s) => s.name === name).length === 0) {
      const resolve = c.resolve === 'global' ? 'union' : c.resolve
      const isPoint = c.type === 'point' ? ', true, true)' : ')'
      signals.push({ name, update: `${VL_SELECTION_RESOLVE}(${store}, ${stringValue(resolve)}${isPoint}` })
    }
    hasSelections = true
    // inputs, scales (multiview only), legends, clear
    if (inputsDefined(c)) signals = inputsTopLevelSignals(c, signals)
    if (legendsDefined(c)) signals = legendsTopLevelSignals(c, signals)
    if (clearDefined(c)) signals = clearTopLevelSignals(c, signals)
  }
  if (hasSelections && signals.filter((s) => s.name === 'unit').length === 0) {
    signals.unshift({ name: 'unit', value: {}, on: [{ events: 'pointermove', update: 'isTuple(group()) ? group() : unit' }] })
  }
  return cleanupEmptyOn(signals)
}

function cleanupEmptyOn(signals: Signal[]): Signal[] {
  return signals.map((s) => {
    if (s.on && !(s.on as unknown[]).length) delete s.on
    return s
  })
}

/** assemble.ts assembleUnitSelectionData: the store datasets of a unit's selections (not already in `existing`). */
export function assembleUnitSelectionData(unit: SelUnit, cmpts: Record<string, SelCmpt>, existing: ReadonlySet<string>): Obj[] {
  const out: Obj[] = []
  const have = new Set(existing)
  for (const c of Object.values(cmpts)) {
    const store: Obj = { name: c.name + STORE }
    if (c.project.hasSelectionId) store.transform = [{ type: 'collect', sort: { field: SELECTION_ID } }]
    if (c.init) {
      const fields = c.project.items.map(assembleProjection)
      store.values = c.project.hasSelectionId
        ? c.init.map((i) => ({ unit: unit.name, [SELECTION_ID]: (assembleInit(i, false) as unknown[])[0] }))
        : c.init.map((i) => ({ unit: unit.name, fields, values: assembleInit(i, false) }))
    }
    if (!have.has(store.name as string)) {
      have.add(store.name as string)
      out.push(store)
    }
  }
  return out
}

/** interval.ts marks + nearest.ts marks, for one unit; `marks` are the unit's marks so far. */
export function assembleUnitSelectionMarks(unit: SelUnit, cmpts: Record<string, SelCmpt>, marks: Obj[]): Obj[] {
  for (const c of Object.values(cmpts)) {
    if (c.type === 'interval') marks = intervalMarks(unit, c, marks)
    if (c.type === 'point' && c.nearest) marks = nearestMarks(unit, c, marks)
  }
  return marks
}

function intervalMarks(unit: SelUnit, c: SelCmpt, marks: Obj[]): Obj[] {
  const name = c.name
  const { x, y } = c.project.hasChannel
  const xvname = x?.signals.visual
  const yvname = y?.signals.visual
  const store = `data(${stringValue(name + STORE)})`

  // No brush when the scales are bound, or there is no valid interval projection.
  if (scalesDefined(c) || (!x && !y)) return marks

  const update: Record<string, unknown> = {
    x: x !== undefined ? { signal: `${xvname}[0]` } : { value: 0 },
    y: y !== undefined ? { signal: `${yvname}[0]` } : { value: 0 },
    x2: x !== undefined ? { signal: `${xvname}[1]` } : { field: { group: 'width' } },
    y2: y !== undefined ? { signal: `${yvname}[1]` } : { field: { group: 'height' } },
  }

  // With resolve "global" the store has a single interval: hide the brush that belongs to another unit.
  if (c.resolve === 'global') {
    for (const key of Object.keys(update)) {
      update[key] = [{ test: `${store}.length && ${store}[0].unit === ${unitNameOf(unit)}`, ...(update[key] as Obj) }, { value: 0 }]
    }
  }

  // Two brush marks keep the fill and other aesthetics from interfering with the core marks while the brushed
  // region can still be interacted with (dragged).
  const { fill, fillOpacity, cursor, ...stroke } = c.mark as Obj
  const vgStroke: Obj = {}
  for (const k of Object.keys(stroke)) {
    vgStroke[k] = [
      {
        test: [x !== undefined && `${xvname}[0] !== ${xvname}[1]`, y !== undefined && `${yvname}[0] !== ${yvname}[1]`].filter((t) => t).join(' && '),
        value: stroke[k],
      },
      { value: null },
    ]
  }

  // Cursor "move" unless the brush cannot be translated.
  const vgCursor = cursor ?? (c.translate ? 'move' : null)

  return [
    {
      name: `${name + BRUSH}_bg`,
      type: 'rect',
      clip: true,
      encode: { enter: { fill: { value: fill }, fillOpacity: { value: fillOpacity } }, update },
    },
    ...marks,
    {
      name: name + BRUSH,
      type: 'rect',
      clip: true,
      encode: { enter: { ...(vgCursor ? { cursor: { value: vgCursor } } : {}), fill: { value: 'transparent' } }, update: { ...update, ...vgStroke } },
    },
  ]
}

const PATH_MARKS = new Set(['line', 'area', 'trail'])

function nearestMarks(unit: SelUnit, c: SelCmpt, marks: Obj[]): Obj[] {
  const { x, y } = c.project.hasChannel
  if (PATH_MARKS.has(unit.mark)) return marks // vega-lite warns: nearest is not supported for continuous marks

  const cellDef: Obj = {
    name: unit.getName(VORONOI),
    type: 'path',
    interactive: true,
    aria: false,
    from: { data: unit.getName('marks') },
    encode: {
      update: {
        fill: { value: 'transparent' },
        strokeWidth: { value: 0.35 },
        stroke: { value: 'transparent' },
        isVoronoi: { value: true },
        ...unit.voronoiTooltip(),
      },
    },
    transform: [{
      type: 'voronoi',
      x: { expr: x || !y ? 'datum.datum.x || 0' : '0' },
      y: { expr: y || !x ? 'datum.datum.y || 0' : '0' },
      size: [{ signal: unit.sizeSignal('width') }, { signal: unit.sizeSignal('height') }],
    }],
  }

  let index = 0
  let exists = false
  marks.forEach((mark, i) => {
    const n = (mark.name as string | undefined) ?? ''
    if (n === unit.firstMarkName) index = i
    else if (n.includes(VORONOI)) exists = true
  })
  if (!exists) marks.splice(index + 1, 0, cellDef)
  return marks
}

/** scales.ts domain signals are emitted through the selection's own signals; here the scale's `domainRaw`. */
export function assembleSelectionScaleDomain(lookup: SelLookup, extent: { param: string; field?: string; encoding?: string }, continuous: boolean, domain: unknown): Obj {
  const parsed = selectionExtent(lookup, extent.param, extent)
  return {
    signal: continuous && Array.isArray(domain) && (domain[0] as number) > (domain[1] as number) ? `isValid(${parsed}) && reverse(${parsed})` : parsed,
  }
}
