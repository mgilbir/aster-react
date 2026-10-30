/**
 * What a selection parameter is, once it has been resolved against its unit: the names it owns in the compiled Vega, the fields it
 * stores, the interactions it answers, and the facts about its unit it needs to know (`SelUnit`). The resolving is in selection.ts, the
 * signals a selection wires are in selection-signals.ts, its brush / voronoi marks and store dataset are in selection-marks.ts.
 *
 * A unit's facts arrive through {@link SelUnit}: the compiler has no model tree, so the field behind a channel, its scale, its size
 * signals and its mark name are asked of the unit as they are needed.
 */
import type { StreamDef } from './event-selector.js'

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
export const asList = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...(v as T[])] : [v as T])
export const deepCopy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

// --- the names the compiled Vega carries ---------------------------------------------------------------------------------------
// (a user reads these through the view API and in their own expressions: `<param>_store`, `<param>_tuple`, ...)

/** The key a data row is selected by when a selection names no field. */
export const SELECTION_ID = '_vgsid_'
export const STORE = '_store'
export const TUPLE = '_tuple'
export const MODIFY = '_modify'
export const TOGGLE = '_toggle'
export const BRUSH = '_brush'
export const SCALE_TRIGGER = '_scale_trigger'
export const TUPLE_FIELDS = '_tuple_fields'
export const INIT = '_init'
export const CENTER = '_center'
export const TRANSLATE_ANCHOR = '_translate_anchor'
export const TRANSLATE_DELTA = '_translate_delta'
export const ZOOM_ANCHOR = '_zoom_anchor'
export const ZOOM_DELTA = '_zoom_delta'
export const VORONOI = 'voronoi'
/** The expression function that turns a store's tuples into the selection's value. */
export const RESOLVE_FN = 'vlSelectionResolve'
/** A timer signal that pulses a map's dataflow once the scenegraph exists (https://github.com/vega/vega/issues/3481). */
export const GEO_INIT_TICK = 'geo_interval_init_tick'

/** A name that is a safe Vega identifier. */
export const varName = (s: string): string => (/^\d+/.test(s) ? '_' : '') + s.replace(/\W/g, '_')

/** A value as source text of an expression: strings and objects quoted, the separators JSON leaves bare escaped. */
export function stringValue(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map((v) => (v === null ? 'null' : stringValue(v))).join(',')}]`
  if (isObj(x) || typeof x === 'string') return JSON.stringify(x).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return String(x)
}

/** JSON with the keys of every object in sorted order (the text an initial value is written as), or `undefined` for `undefined`. */
export function canonicalJson(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (v === null) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? `${v}` : 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((item) => canonicalJson(item) ?? 'null').join(',')}]`
  const entries: string[] = []
  for (const key of Object.keys(v).sort()) {
    const text = canonicalJson((v as Obj)[key])
    if (text) entries.push(`${JSON.stringify(key)}:${text}`)
  }
  return `{${entries.join(',')}}`
}

/** A field name as a Vega `field:` access path: the characters that would step into the datum are escaped. */
export const escapeFieldPath = (path: string): string => path.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\[/g, '\\[').replace(/\]/g, '\\]')

// --- what a selection stores ---------------------------------------------------------------------------------------------------

/**
 * How a tuple holds the values of one field: enumerated values (`E`), a range (`R`) or a bin's [start, end) (`R-RE`).
 * The codes are what the store's `fields` entries read, which the runtime tests tuples by.
 */
export type StorageKind = 'E' | 'R' | 'R-RE'

/** One field a selection stores. */
export interface SelectedField {
  storage: StorageKind
  /** the datum key the values are read from */
  field: string
  /** the position among the selection's fields (the column of an initial value) */
  slot: number
  channel?: string
  /** a field over `longitude` / `latitude` is on the view's `x` / `y`: the geographic channel it was asked for */
  geoChannel?: string
  /** the signals that hold this field's value: in the data domain, and in pixels */
  signals: { data?: string; visual?: string }
  /** an interactive legend of this field's channel selects it */
  legendBound?: boolean
}

export interface TimeUnitProjection {
  /** the datum key the time unit is stored under (its `as`) */
  as: string
  /** the channel's field */
  field: string
  /** the time unit definition (normalized by the caller) */
  timeUnit: unknown
}

/** The fields of one selection, reachable the ways the wiring asks for them. */
export interface SelectedFields {
  list: SelectedField[]
  byChannel: Record<string, SelectedField>
  byField: Record<string, SelectedField>
  /** the selection stores rows by `_vgsid_` */
  byRowId: boolean
  timeUnits: TimeUnitProjection[]
}

export type Resolve = 'global' | 'union' | 'intersect'

/** A selection parameter, resolved. */
export interface Selection {
  name: string
  type: 'point' | 'interval'
  /** one entry per initial tuple: the value of each stored field */
  init?: unknown[][]
  events?: StreamDef[]
  bind?: unknown
  resolve: Resolve
  mark?: Obj
  toggle?: string | false
  translate?: string | false
  zoom?: string | false
  nearest?: boolean
  clear?: StreamDef[] | false | string
  fields: SelectedFields
  /** the fields a bound scale follows */
  scales?: SelectedField[]
  /** the unit is nested in a concat / facet / repeat view (see {@link SelUnit.nested}) */
  nested?: boolean
  /** the unit draws on a map: an interval selection brushes it by the marks it covers */
  geo?: boolean
  on?: unknown
  [k: string]: unknown
}
/** The name the compiler passes selections around by. */
export type SelCmpt = Selection

// --- what a selection needs to know of its unit --------------------------------------------------------------------------------

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
  /** The unit's name: '' for a root unit, `layer_0` for a layer's first child, a spec's own `name`. */
  name: string
  /** A name made unique to the unit (its name, then `text`). */
  getName(text: string): string
  fieldDef(channel: string): SelUnitField | undefined
  /** The derived field (bin start / end, time unit, aggregate) the channel reads. */
  vgField(channel: string, opt?: { binSuffix?: 'end' }): string
  /** the time-unit transform output a projection over this channel needs */
  timeUnitProjection(channel: string): TimeUnitProjection
  scaleName(channel: string): string
  scaleType(channel: string): string | undefined
  /** the scale's `reverse` flag (set by `sort: "descending"` on the field) */
  scaleReverse(channel: string): boolean
  scaleProp(channel: string, prop: 'exponent' | 'constant'): number | undefined
  /** The signal that holds the unit's width / height. */
  sizeSignal(layout: 'width' | 'height'): string
  mark: string
  /** the unit draws on a map */
  hasProjection: boolean
  /** the name of the projection the unit draws with (known once the projections are merged) */
  projectionName(): string
  /** the name of the unit's first mark */
  firstMarkName: string
  /** a scale bound to the selection: its domain follows the selection */
  bindScale(channel: string, extent: { param: string; field: string }): void
  /** the channel's tooltip encoding for the voronoi cells */
  voronoiTooltip(): Obj
  /**
   * The unit sits inside a concat, facet or repeat view: its signals are a group's, and the ones that feed a bound scale push to the
   * view's.
   */
  nested: boolean
  /** The facet channels around the unit: each part of the unit's name that names its facet cell. */
  facetFields?: ReadonlyArray<{ channel: string; field: string }>
}

// --- what a selection answers to -----------------------------------------------------------------------------------------------

/** A selection whose events include a timer animates the `time` channel. */
export const isTimerSelection = (c: { events?: StreamDef[] }): boolean => c.events?.find((e) => e.type === 'timer') !== undefined

export const isPositionChannel = (c: string): boolean => c === 'x' || c === 'y'

const CONTINUOUS_SCALES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'quantile', 'quantize', 'threshold', 'sequential'])
/** A scale of this type has a domain that is an interval of values. */
export const hasContinuousDomain = (type: string | undefined): boolean => type !== undefined && CONTINUOUS_SCALES.has(type)

export const isLegendBinding = (bind: unknown): boolean => bind === 'legend' || (isObj(bind) && !!bind.legend)
export const isLegendStream = (bind: unknown): boolean => isLegendBinding(bind) && isObj(bind)

/** Bound to input widgets (a point selection over the global resolve whose `bind` is neither the scales nor the legend). */
export const bindsInputs = (c: Selection): boolean => c.type === 'point' && c.resolve === 'global' && !!c.bind && c.bind !== 'scales' && !isLegendBinding(c.bind)
/** An interval selection the pan and zoom of its scales drive. */
export const bindsScales = (c: Selection): boolean => c.type === 'interval' && c.resolve === 'global' && !!c.bind && c.bind === 'scales'
/** A point selection an interactive legend drives (one stored field, other than the row id). */
export const bindsLegend = (c: Selection): boolean =>
  c.resolve === 'global' && !!c.bind && isLegendBinding(c.bind) && c.fields.list.length === 1 && c.fields.list[0]!.field !== SELECTION_ID
/** Whether the interaction toggles the selection's members (a point selection that is not an animation). */
export const togglesMembers = (c: Selection): boolean => c.type === 'point' && !isTimerSelection(c) && !!c.toggle
/** Whether anything clears the selection. */
export const hasClear = (c: Selection): boolean => c.clear !== undefined && c.clear !== false && !isTimerSelection(c)

/** The unit's name as an expression: the name quoted, then the facet cell the pointer is in. */
export function unitNameExpr(unit: SelUnit, quote = true): string {
  let name = quote ? stringValue(unit.name) : unit.name
  for (const f of unit.facetFields ?? []) name += ` + '__facet_${f.channel}_' + (facet[${stringValue(f.field)}])`
  return name
}

/** The datum a pointer event's tuple reads: the voronoi cell's, for a nearest selection. */
export const VORONOI_DATUM = '(item().isVoronoi ? datum.datum : datum)'
