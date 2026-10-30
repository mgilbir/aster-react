/**
 * Vega-Lite selections -> Vega: the `params` with a `select`.
 *
 * A selection compiles to a `<name>_store` dataset that holds its tuples, the signals that turn events into tuples and tuples into
 * store edits (`<name>_modify`), the brush and voronoi marks, and one top-level signal named after the parameter that resolves the
 * store. This module reads a parameter and the facts of its unit into a {@link Selection} (what it stores, which interactions it
 * answers), and answers the questions the rest of the compiler asks about it: the test a predicate over it is, the expression a scale
 * domain it drives reads. The wiring is built from a resolved selection:
 *
 *  - selection-signals.ts  the signals, unit by unit and at the top of the spec;
 *  - selection-marks.ts    the brush and voronoi marks, and the store datasets.
 *
 * A unit at the root (or in a layer at the root) puts its signals at the root of the Vega spec; a unit inside a concat, facet or
 * repeat view puts them in its own group mark (a Vega group scope: one copy per group item), see {@link SelUnit.nested}.
 */
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import {
  BRUSH, SELECTION_ID, STORE, VORONOI, asList, bindsInputs, bindsLegend, bindsScales, deepCopy, escapeFieldPath, hasContinuousDomain, isLegendStream,
  isObj, isPositionChannel, isTimerSelection, stringValue, varName,
  type Obj, type SelectedField, type SelectedFields, type Selection, type SelUnit, type StorageKind, type TimeUnitProjection,
} from './selection-model.js'

export {
  GEO_INIT_TICK, SELECTION_ID, STORE, isTimerSelection, stringValue, varName,
  type SelCmpt, type Selection, type SelUnit, type SelUnitField, type SelectedField, type SelectedFields, type StorageKind, type TimeUnitProjection,
} from './selection-model.js'
export { assembleFacetSignals, assembleTopLevelSelectionSignals, assembleUnitSelectionSignals } from './selection-signals.js'
export { assembleInit, assembleProjection, assembleUnitSelectionData, assembleUnitSelectionMarks } from './selection-marks.js'

// --- configuration -------------------------------------------------------------------------------------------------------------

type SelectionKind = Selection['type']

/** What `config.selection` holds before the spec says anything. */
const SELECTION_DEFAULTS: Record<SelectionKind, Obj> = {
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

/**
 * `config.selection` over the defaults: the point and interval blocks merge property by property, and a property (`mark`, `on`,
 * `fields`...) replaces the default whole.
 */
export function selectionConfigOf(config: unknown): Record<SelectionKind, Obj> {
  const user = isObj(config) && isObj(config.selection) ? config.selection : {}
  const merged = (kind: SelectionKind): Obj => ({ ...SELECTION_DEFAULTS[kind], ...(isObj(user[kind]) ? deepCopy(user[kind] as Obj) : {}) })
  return { point: merged('point'), interval: merged('interval') }
}

/** The selection definition with the config's value for every property it leaves out (or sets to `true`, which asks for the default). */
function withConfigDefaults(select: Obj, cfg: Obj): Obj {
  const out = { ...select }
  for (const key of Object.keys(cfg)) {
    // (the fields and encodings are the projection's to default)
    if (key === 'fields' || key === 'encodings') continue
    if (key === 'mark') out.mark = { ...(cfg.mark as Obj), ...(out.mark as Obj | undefined) }
    if (out[key] === undefined || out[key] === true) out[key] = deepCopy(cfg[key] ?? out[key])
  }
  return out
}

// --- resolving a parameter -----------------------------------------------------------------------------------------------------

/**
 * The selections one unit declares, by name. A second animation (a selection with a timer) is left out: only the first one drives the
 * clock.
 */
export function parseUnitSelections(unit: SelUnit, params: Obj[], config: unknown): Record<string, Selection> {
  const byName: Record<string, Selection> = {}
  const configs = selectionConfigOf(config)
  let timers = 0
  for (const param of params) {
    const draft = draftSelection(unit, param, configs)
    if (isTimerSelection(draft) && ++timers > 1) continue
    byName[draft.name] = completeSelection(unit, draft, param, configs[draft.type])
  }
  return byName
}

/** The selection as far as the definition and the config alone take it: its settings and the events it answers. */
function draftSelection(unit: SelUnit, param: Obj, configs: Record<SelectionKind, Obj>): Selection {
  const select = param.select
  const type = (typeof select === 'string' ? select : (select as Obj).type) as SelectionKind
  const settings = withConfigDefaults(isObj(select) ? deepCopy(select) : { type }, configs[type])
  return {
    ...settings,
    name: varName(param.name as string),
    type,
    init: param.value,
    bind: param.bind,
    events: typeof settings.on === 'string' ? parseEventSelectorString(settings.on, 'scope') : asList(deepCopy(settings.on) as StreamDef | StreamDef[]),
    nested: unit.nested,
  } as unknown as Selection
}

/** What the unit and the interactions add: the fields it stores, the scales it drives, the streams it answers. */
function completeSelection(unit: SelUnit, sel: Selection, param: Obj, cfg: Obj): Selection {
  // (the steps read the parameter as the user wrote it, which the map adaptation below rewrites)
  const written = deepCopy(param)
  if (sel.type === 'interval') {
    if (unit.hasProjection) adaptToMap(sel, written)
    if (sel.translate && !bindsScales(sel)) keepDragsOffTheBrush(sel)
  }
  sel.fields = selectFields(unit, sel, written, cfg)
  if (bindsInputs(sel)) dropDirectManipulation(sel, written.select)
  if (bindsScales(sel)) bindScalesOf(unit, sel)
  if (bindsLegend(sel)) bindLegendOf(sel, written)
  if (typeof sel.clear === 'string') sel.clear = parseEventSelectorString(sel.clear, 'view')
  if (sel.type === 'point' && sel.nearest) for (const e of sel.events ?? []) e.markname = unit.getName(VORONOI)
  return sel
}

/** On a map an interval is over longitude and latitude (or the channels the initial value names), stored by `_vgsid_`. */
function adaptToMap(sel: Selection, written: Obj): void {
  const select: Obj = { ...(isObj(written.select) ? written.select : {}), fields: [SELECTION_ID] }
  if (!select.encodings) select.encodings = written.value ? Object.keys(written.value as Obj) : ['longitude', 'latitude']
  written.select = { type: 'interval', ...select }
  sel.geo = true
}

/** Dragging the brush must not start a new brush: the streams that start a drag skip events on the brush mark. */
function keepDragsOffTheBrush(sel: Selection): void {
  const skip = `!event.item || event.item.mark.name !== ${stringValue(sel.name + BRUSH)}`
  for (const stream of sel.events ?? []) {
    const start = stream.between?.[0]
    if (!start) continue // a stream that is not an ordered pair of events does not drag
    start.filter = asList(start.filter ?? [])
    if (!start.filter.includes(skip)) start.filter.push(skip)
  }
}

/** A selection driven by input widgets or a legend answers the events the user wrote, not the pointer's defaults. */
function dropDirectManipulation(sel: Selection, select: unknown): void {
  const wrote = (key: string): boolean => isObj(select) && !!select[key]
  if (!wrote('on')) delete sel.events
  if (!wrote('clear')) delete sel.clear
  if (!wrote('toggle')) delete sel.toggle
}

/** The scales a bound interval pans and zooms: the continuous ones of its x and y fields. */
function bindScalesOf(unit: SelUnit, sel: Selection): void {
  sel.scales = []
  for (const field of sel.fields.list) {
    const channel = field.channel
    if (channel === undefined || !isPositionChannel(channel) || !hasContinuousDomain(unit.scaleType(channel))) continue
    unit.bindScale(channel, { param: sel.name, field: field.field })
    sel.scales.push(field)
  }
}

/** The legend's own events stand in for the pointer's, and the items stay togglable although direct manipulation is off. */
function bindLegendOf(sel: Selection, written: Obj): void {
  const select = written.select
  dropDirectManipulation(sel, isObj(select) ? { ...select, toggle: sel.toggle } : { type: select, toggle: sel.toggle })

  if (isObj(select) && (select.on || select.clear)) {
    const outsideLegend = 'event.item && indexof(event.item.mark.role, "legend") < 0'
    for (const stream of sel.events ?? []) {
      stream.filter = asList(stream.filter ?? [])
      if (!stream.filter.includes(outsideLegend)) stream.filter.push(outsideLegend)
    }
  }

  const events = isLegendStream(sel.bind) ? (sel.bind as Obj).legend : 'click'
  sel.bind = { legend: { merge: typeof events === 'string' ? parseEventSelectorString(events, 'view') : asList(events as StreamDef | StreamDef[]) } }
}

// --- what a selection stores ---------------------------------------------------------------------------------------------------

/** Channels a selection can name in `encodings`, or in an initial value. */
const SELECTABLE_CHANNELS = new Set([
  'x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'xError', 'yError', 'xError2', 'yError2', 'theta', 'theta2', 'radius', 'radius2',
  'longitude', 'latitude', 'longitude2', 'latitude2', 'color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth',
  'strokeDash', 'size', 'angle', 'shape', 'key', 'text', 'href', 'url', 'description', 'detail', 'order', 'tooltip', 'time',
])
const GEO_TO_POSITION: Record<string, string> = { longitude: 'x', latitude: 'y', longitude2: 'x2', latitude2: 'y2' }

/** Which channels and which fields a selection is over: the ones it names, else the ones its initial value names, else the config's. */
function projectionRequest(sel: Selection, select: Obj, init: unknown[] | null, cfg: Obj): { channels: string[] | undefined; fields: string[] | undefined } {
  let channels = select.encodings as string[] | undefined
  let fields = select.fields as string[] | undefined
  if (!channels && !fields && init) {
    for (const row of init) {
      // (an initial value may be a bare scalar, to ease the way from a variable parameter to a point selection)
      if (!isObj(row)) continue
      for (const key of Object.keys(row)) {
        if (SELECTABLE_CHANNELS.has(key)) (channels ??= []).push(key)
        // a field name where an interval wants a channel: the interval falls back to the config's channels
        else if (sel.type === 'interval') channels = [...(cfg.encodings as string[])]
        else (fields ??= []).push(key)
      }
    }
  }
  if (!channels && !fields) {
    channels = cfg.encodings as string[] | undefined
    if ('fields' in cfg) fields = cfg.fields as string[]
  }
  return { channels, fields }
}

function selectFields(unit: SelUnit, sel: Selection, written: Obj, cfg: Obj): SelectedFields {
  const init = written.value !== undefined ? asList(written.value) : null
  const request = projectionRequest(sel, isObj(written.select) ? written.select : {}, init, cfg)

  const list: SelectedField[] = []
  const byChannel: Record<string, SelectedField> = {}
  const byField: Record<string, SelectedField> = {}
  const timeUnits = new Map<string, TimeUnitProjection>()
  let byRowId = false

  // each stored field gets a signal of its own, named after its field (data) and its channel (pixels); a repeated name is numbered
  const taken = new Set<string>()
  const signalFor = (suffix: string | undefined): string => {
    let name = varName(`${sel.name}_${suffix}`)
    for (let n = 1; taken.has(name); n++) name = varName(`${sel.name}_${suffix}_${n}`)
    taken.add(name)
    return name
  }
  const add = (field: SelectedField): void => {
    list.push(field)
    byField[field.field] = field
    byRowId ||= field.field === SELECTION_ID
  }

  for (const channel of request.channels ?? []) {
    const def = unit.fieldDef(channel)
    // a channel without a field has nothing to store, and neither has an aggregate
    if (!def || def.aggregate || !def.source) continue
    let field = def.source
    if (def.timeUnit) {
      field = unit.vgField(channel)
      const unitField = unit.timeUnitProjection(channel)
      timeUnits.set(JSON.stringify([unitField.as, unitField.field]), unitField)
    }
    if (byField[field]) continue
    // an interval holds a range over a continuous position scale and enumerated values otherwise; a point holds a range for a binned field
    const storage: StorageKind = sel.type === 'interval' && isPositionChannel(channel) && hasContinuousDomain(unit.scaleType(channel)) ? 'R' : def.bin ? 'R-RE' : 'E'
    const stored: SelectedField = { field, channel, storage, slot: list.length, signals: {} }
    stored.signals = { data: signalFor(field), visual: signalFor(channel) }
    add(stored)
    const position = GEO_TO_POSITION[channel]
    if (position !== undefined) {
      // (the signals above are named after the geographic channel; the field is on the view's x / y)
      stored.geoChannel = channel
      stored.channel = position
    }
    byChannel[stored.channel!] = stored
  }

  for (const field of request.fields ?? []) {
    if (byField[field]) continue
    const stored: SelectedField = { storage: 'E', field, slot: list.length, signals: {} }
    stored.signals = { data: signalFor(field) }
    add(stored)
  }

  if (init) {
    // an initial value is an object that maps channels (else fields) to values, or one scalar for every field
    sel.init = init.map((row) =>
      list.map((f) => {
        if (!isObj(row)) return row
        const key = f.geoChannel ?? f.channel
        return key !== undefined && row[key] !== undefined ? row[key] : row[f.field]
      }),
    )
  }
  return { list, byChannel, byField, byRowId, timeUnits: [...timeUnits.values()] }
}

/**
 * Mark the selections an interactive legend of `channel` (or of `field`) drives; the names of the ones that are. The legend of a field
 * a selection is over selects it.
 */
export function interactiveLegendSelections(selections: Record<string, Selection>, channel: string, field: string | undefined): string[] {
  const names: string[] = []
  for (const sel of Object.values(selections)) {
    const stored = (field !== undefined ? sel.fields.byField[field] : undefined) ?? sel.fields.byChannel[channel]
    if (stored && bindsLegend(sel)) {
      stored.legendBound = true
      names.push(sel.name)
    }
  }
  return names
}

/** Whether a selection stores rows by their id, so the data needs one. */
export const requiresSelectionId = (selections: Record<string, Selection>): boolean => Object.values(selections).some((s) => s.fields.byRowId)

// --- reading a selection from elsewhere in the spec -----------------------------------------------------------------------------

/** Where the compiler finds a selection by its (identifier-safe) name. */
export interface SelLookup {
  get(name: string): Selection | undefined
}

export type ParamPredicate = string | { param: string; empty?: boolean }

/**
 * The test a predicate over a parameter is: of a datum against a selection (an empty selection holds for every datum, unless the
 * predicate says `empty: false`), or the truth of a variable parameter.
 */
export function selectionPredicate(lookup: SelLookup, pred: ParamPredicate, datum = 'datum'): string {
  const vname = varName(typeof pred === 'string' ? pred : pred.param)
  const sel = lookup.get(vname)
  if (!sel) return `!!${vname}`
  const store = stringValue(vname + STORE)
  const test = `${sel.fields.byRowId ? 'vlSelectionIdTest' : 'vlSelectionTest'}(${store}, ${datum}${sel.resolve === 'global' ? '' : `, ${stringValue(sel.resolve)}`})`
  const size = `length(data(${store}))`
  return typeof pred !== 'string' && pred.empty === false ? `${size} && ${test}` : `!${size} || ${test}`
}

/** The expression a scale domain (or a bin extent) that is a parameter reads: the selection's values of one field, or the variable. */
export function selectionExtent(lookup: SelLookup, name: string, extent: { field?: string; encoding?: string }): string {
  const vname = varName(name)
  const sel = lookup.get(vname)
  if (!sel) return vname
  let field = extent.field
  if (!field) {
    const stored = sel.fields.list
    // a channel names its field when exactly one stored field is on it; otherwise the first field stands
    const onChannel = extent.encoding ? stored.filter((f) => f.channel === extent.encoding) : []
    field = (onChannel.length === 1 ? onChannel[0]! : stored[0]!).field
  }
  return `${sel.name}[${stringValue(escapeFieldPath(field))}]`
}

/** The `domainRaw` of a scale that follows a selection: reversed when the scale's own domain is. */
export function assembleSelectionScaleDomain(lookup: SelLookup, extent: { param: string; field?: string; encoding?: string }, continuous: boolean, domain: unknown): Obj {
  const read = selectionExtent(lookup, extent.param, extent)
  const descending = continuous && Array.isArray(domain) && (domain[0] as number) > (domain[1] as number)
  return { signal: descending ? `isValid(${read}) && reverse(${read})` : read }
}
