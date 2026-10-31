/**
 * A legend: a group holding the entries (a gradient strip with its labels, the bands of a discretizing scale with theirs, or one
 * symbol and label per entry) and a title, encoded from the spec and the config and then laid out: the entries and the title are
 * placed against each other from the bounds of what was drawn, and the legend is sized to hold them. See guide-encode.ts for how a
 * property becomes a channel of an item.
 */
import type { EncodeValue, SceneGroup, SceneItem } from './types.js'
import { Bounds, boundLeaf, boundLegendGroup, boundStroke, multiLineOffset } from './bounds.js'
import { placeGrid } from './trellis.js'
import { rectItemPath, symbolPath } from './render.js'
import type { Locale } from './locale.js'
import {
  DiscreteLegend, GradientLegend, SymbolLegend, isContinuous, isDiscretizing, labelFormat, labelFraction, labelValues, scaleFraction, tickCount,
  type LabelValues,
} from './scale.js'
import { thinOverlaps } from './guide-axis.js'
import {
  ONE, ZERO, contentKey, customize, encodeItem, entryOf, isShareable, isSignal, itemAriaOf, joinByValue, keyPart, mergeUserEncode,
  propsOf, setChannels, shareMarks, sharedMarks, staticChannel,
  type Block, type Entry, type EntryHost, type EntryScope, type GuideMarkDef, type GuideProps, type GuideStyles, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'

type Rec = Record<string, unknown>
type Scale = ((v: unknown) => unknown) & Rec

/** The channels a legend can describe, in priority order: the first one the spec names gives the legend its scale. */
export const LEGEND_SCALES = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const

/**
 * What kind of legend a spec makes: as it says, or from its scale. A legend for one color channel with no `type` is a gradient on a
 * continuous scale, bands on a discretizing one and symbols otherwise; a gradient on a discretizing scale is bands.
 */
export function legendType(spec: Rec, scaleType: string): string {
  const channels = LEGEND_SCALES.filter((c) => spec[c]).length
  let type = (spec.type as string) || SymbolLegend
  if (!spec.type && channels === 1 && (spec.fill || spec.stroke)) {
    type = isContinuous(scaleType) ? GradientLegend : isDiscretizing(scaleType) ? DiscreteLegend : SymbolLegend
  }
  return type === GradientLegend && isDiscretizing(scaleType) ? DiscreteLegend : type
}

// --- the entries a legend lists -----------------------------------------------------------------------------------------------

/** One entry: a value of the scale, its label, and where it falls (a gradient and bands: along the strip; symbols: how big it is). */
interface LegendEntry {
  index: number
  label: string | null
  value: unknown
  perc?: number
  perc2?: number
  offset?: number
  size?: number
}

interface EntriesParams {
  type: string
  scale: Scale
  count: unknown
  limit: number
  values?: unknown[]
  minstep?: number
  /** how much room an entry's symbol takes (symbol legends only) */
  size?: (value: unknown) => number
  formatSpecifier?: unknown
  formatType?: string
  locale: Locale
  warn: (msg: string) => void
}

/** The values a legend lists with their labels, and where each sits. */
function listEntries(p: EntriesParams): LegendEntry[] {
  const { type, scale } = p
  const count = tickCount(scale as never, p.count == null ? 5 : p.count, p.minstep)
  const format = labelFormat(p.locale, scale as never, count, type, p.formatSpecifier, p.formatType, !!p.values || type === SymbolLegend)
  const values: LabelValues = (p.values as LabelValues | undefined) || labelValues(scale as never, count)

  if (type === SymbolLegend) {
    const roomOf = p.size!
    // too many symbols are cut to the limit, the last row saying how many were left out
    const limit = +p.limit
    const cut = !!limit && values.length > limit
    if (cut) p.warn('Symbol legend count exceeds limit, filtering items.')
    // (a slice is a plain list: it has lost the `max` of the intervals' last upper end)
    let shown: unknown[] = cut ? values.slice(0, limit - 1) : values
    // a first value that maps to nothing (size 0) is not listed unless the values were given
    if (!p.values && (scale as (v: unknown) => unknown)(shown[0]) === 0) shown = shown.slice(1)
    const offset = shown.reduce((widest: number, v) => Math.max(widest, roomOf(v)), 0)
    const list = shown as LabelValues
    const entries: LegendEntry[] = shown.map((v, index) => ({ index, label: format(v, index, list), value: v, offset, size: roomOf(v) }))
    if (cut) {
      const next = values[entries.length]
      entries.push({ index: entries.length, label: `…${values.length - entries.length} entries`, value: next, offset, size: roomOf(next) })
    }
    return entries
  }
  if (type === GradientLegend) {
    const domain = (scale.domain as unknown as () => number[])()
    const first = domain[0]!
    const last = domain[domain.length - 1]!
    const fraction = scaleFraction(scale as never, first, last)
    // generated labels that come to two or fewer are replaced by the two ends of the domain
    const labelled = values.length < 3 && !p.values && first !== last ? [first, last] : values
    return labelled.map((v, index) => ({ index, label: format(v, index, labelled as LabelValues), value: v, perc: fraction(v as number) as number }))
  }
  // bands: each value starts one and the next value ends it (the last ends at 1)
  const fraction = labelFraction(scale as never)
  return values.map((v, index) => ({
    index, label: format(v, index, values), value: v,
    perc: index ? fraction(v) : 0,
    perc2: index === values.length - 1 ? 1 : fraction(values[index + 1]),
  }))
}

// --- the marks -----------------------------------------------------------------------------------------------------------------

/** A number, or an encode entry that holds one, as the number it is for this datum. */
function numeric(s: EntryScope, v: unknown): number {
  return (v !== null && typeof v === 'object' ? s.host.entry(v as EncodeValue, s.datum) : v) as number
}

/** What each mark of a legend is made from. */
interface Kit {
  spec: Rec
  config: Rec
  props: GuideProps
  /** the scale the legend is for (the first channel's) */
  scale: string
  vertical: boolean
  user: Record<string, UserEncode | undefined>
}

const gradientStroke = (k: Kit): Rec => ({ stroke: k.props.get('gradientStrokeColor'), strokeWidth: k.props.get('gradientStrokeWidth') })

function gradient(k: Kit, fill: Entry): GuideMarkDef {
  const thickness = k.props.gradientThickness()
  const length = k.props.gradientLength()
  const enter: Block = {
    opacity: ZERO, x: ZERO, y: ZERO,
    width: entryOf(k.vertical ? thickness : length) as EncodeValue,
    height: entryOf(k.vertical ? length : thickness) as EncodeValue,
  }
  const encode: MarkEncode = { enter, update: { ...enter, opacity: ONE, fill }, exit: { opacity: ZERO } }
  setChannels(encode, gradientStroke(k), { opacity: k.props.get('gradientOpacity') })
  return customize({ type: 'rect', role: 'legend-gradient', encode, interactive: false }, k.user.gradient)
}

/** The bands of a discretizing scale: one rect per band, each from its start to its end along the strip. */
function bands(k: Kit): GuideMarkDef {
  const thickness = k.props.gradientThickness()
  const length = k.props.gradientLength()
  const [start, end, across, size] = k.vertical ? (['y', 'y2', 'x', 'width'] as const) : (['x', 'x2', 'y', 'height'] as const)
  const along = (field: 'perc' | 'perc2'): Entry => (s) => {
    const fraction = k.vertical ? 1 - (s.datum[field] as number) : (s.datum[field] as number)
    return length != null ? fraction * numeric(s, length) : fraction
  }
  const enter: Block = { opacity: ZERO, fill: { scale: k.scale, field: 'value' } as unknown as EncodeValue }
  enter[start] = along('perc')
  enter[across] = ZERO
  enter[end] = along('perc2')
  enter[size] = entryOf(thickness) as EncodeValue
  const encode: MarkEncode = { enter, update: { ...enter, opacity: ONE }, exit: { opacity: ZERO } }
  setChannels(encode, gradientStroke(k), { opacity: k.props.get('gradientOpacity') })
  return customize({ type: 'rect', role: 'legend-band', encode, interactive: false }, k.user.gradient)
}

/** The labels beside a gradient or its bands: at each value's place along the strip, at the strip's edge. */
function stripLabels(k: Kit): GuideMarkDef {
  const { spec, config, props, vertical } = k
  const thickness = entryOf(props.gradientThickness())
  const length = props.gradientLength()
  const enter: Block = { opacity: ZERO }
  const update: Block = { opacity: ONE, text: { field: 'label' } as EncodeValue }
  const encode: MarkEncode = { enter, update, exit: { opacity: ZERO } }
  setChannels(encode, {
    fill: props.get('labelColor'), fillOpacity: props.get('labelOpacity'), font: props.get('labelFont'), fontSize: props.get('labelFontSize'),
    fontStyle: props.get('labelFontStyle'), fontWeight: props.get('labelFontWeight'), limit: spec.labelLimit ?? config.gradientLabelLimit,
  })
  // a label at the end of the strip hangs off the end rather than centring on it
  const atEnd = (s: EntryScope, low: string, high: string, middle: string): string => ((s.datum.perc as number) <= 0 ? low : (s.datum.perc as number) >= 1 ? high : middle)
  if (vertical) {
    enter.align = { value: 'left' } as EncodeValue
    enter.baseline = update.baseline = (s) => atEnd(s, 'bottom', 'top', 'middle')
  } else {
    enter.align = update.align = (s) => atEnd(s, 'left', 'right', 'center')
    enter.baseline = { value: 'top' } as EncodeValue
  }
  const [along, across] = vertical ? (['y', 'x'] as const) : (['x', 'y'] as const)
  const place: Entry = (s) => {
    const fraction = vertical ? 1 - (s.datum.perc as number) : (s.datum.perc as number)
    return length != null ? fraction * numeric(s, length) : fraction
  }
  enter[along] = update[along] = place
  enter[across] = update[across] = thickness as EncodeValue
  thickness.offset = (spec.labelOffset ?? config.gradientLabelOffset) || 0
  const mark = customize({ type: 'text', role: 'legend-label', style: 'guide-label', encode, interactive: false }, k.user.labels)
  const overlap = props.get('labelOverlap')
  if (overlap) mark.overlap = { separation: props.get('labelSeparation'), method: overlap, order: 'datum.index', bound: null }
  return mark
}

function legendTitle(k: Kit): GuideMarkDef {
  const { spec, props } = k
  const encode: MarkEncode = {
    enter: { opacity: ZERO },
    update: { opacity: ONE, x: ((s) => s.group.padding) as Entry, y: ((s) => s.group.padding) as Entry },
    exit: { opacity: ZERO },
  }
  const onSide = (s: EntryScope): boolean => s.item.orient === 'left' || s.item.orient === 'right'
  const byAnchor = (s: EntryScope, start: string, end: string, middle: string): string => (s.item.anchor === 'start' ? start : s.item.anchor === 'end' ? end : middle)
  // a title beside a vertical gradient is turned to read along it
  const alongGradient = (s: EntryScope): boolean => !!s.datum.vgrad && onSide(s)
  setChannels(encode, {
    orient: props.get('titleOrient'),
    _anchor: props.get('titleAnchor'),
    anchor: ((s) => (s.item._anchor as string) || (onSide(s) ? 'middle' : 'start')) as Entry,
    angle: ((s) => (alongGradient(s) ? (s.item.orient === 'left' ? -90 : 90) : 0)) as Entry,
    align: ((s) => {
      const vgrad = !!s.datum.vgrad
      if (vgrad && s.item.orient === 'right') return byAnchor(s, 'right', 'left', 'center')
      return onSide(s) && !(vgrad && s.item.orient === 'left') ? 'left' : byAnchor(s, 'left', 'right', 'center')
    }) as Entry,
    baseline: ((s) => (onSide(s) ? (s.datum.vgrad ? (s.item.orient === 'right' ? 'bottom' : 'top') : byAnchor(s, 'top', 'bottom', 'middle')) : 'top')) as Entry,
    text: spec.title,
    fill: props.get('titleColor'), fillOpacity: props.get('titleOpacity'), font: props.get('titleFont'), fontSize: props.get('titleFontSize'),
    fontStyle: props.get('titleFontStyle'), fontWeight: props.get('titleFontWeight'), limit: props.get('titleLimit'), lineHeight: props.get('titleLineHeight'),
  }, { align: props.get('titleAlign'), baseline: props.get('titleBaseline') })
  return customize({ type: 'text', role: 'legend-title', style: 'guide-title', encode, interactive: false }, k.user.title)
}

/** The legend group's own channels, which the layout reads. */
function groupEncode(k: Kit): MarkEncode {
  const { spec, config, props } = k
  const encode: MarkEncode = { enter: {}, update: {} }
  setChannels(encode, {
    orient: props.get('orient'), offset: props.get('offset'), padding: props.get('padding'), titlePadding: props.get('titlePadding'),
    cornerRadius: props.get('cornerRadius'), fill: props.get('fillColor'), stroke: props.get('strokeColor'), strokeWidth: config.strokeWidth,
    strokeDash: config.strokeDash, x: props.get('legendX'), y: props.get('legendY'), format: spec.format, formatType: spec.formatType,
  })
  return mergeUserEncode(encode, k.user.legend)
}

/** The marks of one symbol legend: the symbol, its label, and the group that holds an entry. They depend on whether the legend has columns. */
interface SymbolMarks {
  symbols: GuideMarkDef
  labels: GuideMarkDef
  entry: GuideMarkDef
}

function symbolMarks(inp: LegendBuildInput, k: Kit, columns: number): SymbolMarks {
  const { spec, config, props } = k
  const height = props.get('clipHeight')
  const symbolOffset = props.get('symbolOffset')
  // an entry's symbol sits half its room in from the entry's edge: the room is the entry's offset in a legend with columns, its size otherwise
  const room = (s: EntryScope): number => (columns ? (s.datum.offset as number) : (s.datum.size as number))
  const middle: Entry = height ? ({ ...entryOf(height), mult: 0.5 } as unknown as EncodeValue) : (s) => (s.datum.size as number) * 0.5

  const symbolEnter: Block = {
    opacity: ZERO,
    // the symbol offset is added only when there is one
    x: ((s) => (symbolOffset != null ? room(s) * 0.5 + numeric(s, symbolOffset) : room(s) * 0.5)) as Entry,
    y: middle,
  }
  const symbolEncode: MarkEncode = { enter: symbolEnter, update: { opacity: ONE, x: symbolEnter.x, y: symbolEnter.y }, exit: { opacity: ZERO } }
  const baseFill = spec.fill ? null : config.symbolBaseFillColor
  const baseStroke = spec.fill ? null : config.symbolBaseStrokeColor
  setChannels(symbolEncode, {
    fill: props.get('symbolFillColor', baseFill), shape: props.get('symbolType'), size: props.get('symbolSize'), stroke: props.get('symbolStrokeColor', baseStroke),
    strokeDash: props.get('symbolDash'), strokeDashOffset: props.get('symbolDashOffset'), strokeWidth: props.get('symbolStrokeWidth'),
  }, { opacity: props.get('symbolOpacity') })
  // each channel the legend describes is drawn from its own scale
  for (const [channel, name] of inp.channels) symbolEncode.update[channel] = symbolEncode.enter[channel] = { scale: name, field: 'value' } as unknown as EncodeValue
  const symbols = customize({ type: 'symbol', role: 'legend-symbol', encode: symbolEncode, interactive: false }, k.user.symbols)

  // the label starts past the symbol's room, by the symbol offset and the label offset
  const labelOffset = entryOf(symbolOffset)
  labelOffset.offset = props.get('labelOffset')
  const labelEnter: Block = { opacity: ZERO, x: ((s) => room(s) + numeric(s, labelOffset)) as Entry, y: middle }
  const labelEncode: MarkEncode = { enter: labelEnter, update: { opacity: ONE, text: { field: 'label' } as EncodeValue, x: labelEnter.x, y: labelEnter.y }, exit: { opacity: ZERO } }
  setChannels(labelEncode, {
    align: props.get('labelAlign'), baseline: props.get('labelBaseline'), fill: props.get('labelColor'), fillOpacity: props.get('labelOpacity'),
    font: props.get('labelFont'), fontSize: props.get('labelFontSize'), fontStyle: props.get('labelFontStyle'), fontWeight: props.get('labelFontWeight'),
    limit: props.get('labelLimit'),
  })
  const labels = customize({ type: 'text', role: 'legend-label', style: 'guide-label', encode: labelEncode, interactive: false }, k.user.labels)

  // the group that holds an entry: as tall as the clip, if there is one, and ignored by the bounds otherwise
  const entries = k.user.entries
  const entryEnter: Block = {
    noBound: { value: !height } as EncodeValue,
    width: ZERO,
    height: (height ? entryOf(height) : ZERO) as EncodeValue,
    opacity: ZERO,
  }
  const entryEncode: MarkEncode = mergeUserEncode({ enter: entryEnter, update: { opacity: ONE }, exit: { opacity: ZERO } }, entries)
  const entry: GuideMarkDef = { type: 'rule', role: 'scope', encode: entryEncode, interactive: !!entries?.interactive, name: nameOf(entries?.name) }
  return { symbols, labels, entry }
}

// --- the legend's definition -----------------------------------------------------------------------------------------------------

export interface LegendBuildInput {
  /** where the marks of the legend are kept between evaluations, and whether to keep them (see runtime.ts chartGuides) */
  store?: Map<object, unknown>
  keep?: boolean
  spec: Rec
  config: Rec
  encode: Record<string, UserEncode | undefined>
  /** the scale names per channel (`datum.scales`) */
  channels: Array<[string, string]>
  scale: Scale
  scaleType: string
  /** the scales of every channel (an entry's symbol takes its size, shape, fill ... from them) */
  scaleOf: (name: string) => Scale | undefined
  /** `spec.values`, with its signals resolved */
  values: unknown[] | undefined
  /** `_('tickCount')` as the legend holds it (a signal already evaluated) */
  count: unknown
  /** `spec.tickMinStep` and `_('symbolLimit')`, signals evaluated */
  minstep: number | undefined
  limit: number
  formatSpecifier: unknown
  formatType: string | undefined
  locale: Locale
  host: GuideHost
  style: GuideStyles
  /** the layout never ran: the entries stay where their encode put them */
  raw: boolean
}

export interface GuideHost extends EntryHost {
  /** a signal expression with a datum in scope */
  exprDatum(code: string, datum: unknown): unknown
  /** the fill reference for a gradient over a scale (registers its definition) */
  gradient(scaleName: string, vertical: boolean): string
  /** the box of a group item, as a group mark draws it: its background (and foreground) leaves, `_bg`-flagged */
  groupBox(geo: SceneItem, w: number, h: number): { background: SceneItem; foreground?: SceneItem }
  warn(msg: string): void
}

export interface LegendBuilt {
  leaves: SceneItem[]
  legendType: string
  width: number
  height: number
  /** the legend mark's bounds relative to the group's own position (`item.mark.bounds`) */
  bounds: Bounds
  /** the group item as encoded (orient, offset, x, y, padding ...) */
  group: Rec
  partMeta: Record<string, { name?: string; interactive: boolean }>
  datum: Row
}

/**
 * The marks of a legend that its spec and the config decide, made once per compiled legend (what the data or a signal holds is read
 * when the entries are evaluated). They are made when first needed.
 */
interface LegendDefs {
  config: Rec
  encode: Record<string, UserEncode | undefined>
  scale: string
  type: string
  vertical: boolean
  made: Map<string, GuideMarkDef>
  symbolMarks: Map<boolean, SymbolMarks>
}

function legendDefs(inp: LegendBuildInput, scale: string, type: string, vertical: boolean): LegendDefs {
  const { spec, config } = inp
  const kept = inp.store?.get(spec) as LegendDefs | undefined
  if (kept !== undefined && kept.config === config && kept.encode === inp.encode && kept.scale === scale && kept.type === type && kept.vertical === vertical) return kept
  let shareKey: string | undefined
  if (isShareable(config)) {
    const specKey = contentKey(spec)
    const encodeKey = specKey === undefined ? undefined : contentKey(inp.encode)
    const channelKey = encodeKey === undefined ? undefined : contentKey(inp.channels)
    if (channelKey !== undefined) shareKey = 'l' + keyPart(scale) + keyPart(type) + (vertical ? 'V' : 'H') + specKey + '|' + encodeKey + '|' + channelKey
  }
  const shared = sharedMarks(shareKey) as LegendDefs | undefined
  let defs: LegendDefs
  if (shared !== undefined && shared.config === config) defs = shared
  else {
    defs = { config, encode: inp.encode, scale, type, vertical, made: new Map(), symbolMarks: new Map() }
    shareMarks(shareKey, defs)
  }
  if (inp.keep) inp.store?.set(spec, defs)
  return defs
}

const markOf = (defs: LegendDefs, key: string, make: () => GuideMarkDef): GuideMarkDef => {
  let def = defs.made.get(key)
  if (def === undefined) defs.made.set(key, (def = make()))
  return def
}

const nameOf = (n: unknown): string | undefined => (n == null || n === '' ? undefined : String(n))

/** An item that is moved together with the bounds of what it holds. */
interface Placed {
  x: number
  y: number
  box: Bounds
}
function shift(p: Placed, dx: number, dy: number): void {
  p.x += dx
  p.y += dy
  p.box.translate(dx, dy)
}

// --- building a legend --------------------------------------------------------------------------------------------------------

export function buildLegend(inp: LegendBuildInput): LegendBuilt {
  const { spec, config, host, style } = inp
  const props = propsOf(spec, config)
  const type = legendType(spec, inp.scaleType)
  const vertical = props.vertical()
  const scale = inp.channels[0]?.[1] ?? ''
  const defs = legendDefs(inp, scale, type, vertical)
  const k: Kit = { spec, config, props, scale, vertical, user: inp.encode }

  const scales: Rec = {}
  for (const [channel, name] of inp.channels) scales[channel] = name
  const datum: Row = { title: spec.title != null, scales, type, vgrad: type !== SymbolLegend && vertical }
  const groupDef = markOf(defs, 'group', () => ({ type: 'rule', role: 'legend', style: inp.encode.legend?.style, encode: groupEncode(k), interactive: false }))
  const group = encodeItem(groupDef, datum, {}, host, style) as unknown as Rec
  const partMeta: LegendBuilt['partMeta'] = {
    legend: { name: nameOf(inp.encode.legend?.name), interactive: !!inp.encode.legend?.interactive },
  }
  const boxOf = (it: SceneItem): Bounds => boundLeaf(new Bounds(), it)
  const unionOf = (items: SceneItem[]): Bounds => {
    const b = new Bounds()
    for (const it of items) b.union(boxOf(it))
    return b
  }
  const make = (def: GuideMarkDef, d: Row, part: string): SceneItem & Rec => {
    const it = encodeItem(def, d, group, host, style) as SceneItem & Rec
    it._kind = def.type
    it._part = part
    return it
  }

  // the padding is what the group item has: a missing one makes the layout's arithmetic NaN
  const padding = group.padding as number
  let titleItem: (SceneItem & Rec) | undefined
  const title: Placed = { x: 0, y: 0, box: new Bounds() }
  if (datum.title) {
    const def = markOf(defs, 'title', () => legendTitle(k))
    titleItem = make(def, datum, 'title')
    title.x = titleItem.x as number
    title.y = titleItem.y as number
    title.box = boxOf(titleItem)
    partMeta.title = { name: def.name, interactive: def.interactive }
  }

  // the entry group sits at the legend's origin until the layout moves it
  const entry: Placed = { x: 0, y: 0, box: new Bounds() }
  // the strip of a gradient or bands: the title of a gradient legend lines up with it, not with the labels
  let strip = new Bounds()
  const entryLeaves: SceneItem[] = []
  if (type !== GradientLegend && type !== DiscreteLegend) {
    entry.box = symbolEntries(inp, k, defs, group, partMeta, entryLeaves, type)
  } else {
    const isGradient = type === GradientLegend
    // the default tick count of a gradient follows its length
    let count = inp.count
    if (isGradient && !count) {
      const length = props.gradientLength()
      count = Math.max(2, 2 * Math.floor((isSignal(length) ? (host.expr(length.signal) as number) : (length as number)) / 100))
    }
    const entries = listEntries({
      type, scale: inp.scale, count, limit: inp.limit, values: inp.values, minstep: inp.minstep,
      formatSpecifier: inp.formatSpecifier, formatType: inp.formatType, locale: inp.locale, warn: (m) => host.warn(m),
    })
    const stripDef = markOf(defs, isGradient ? 'gradient' : 'band', () => (isGradient ? gradient(k, ((s: EntryScope) => (s.host as GuideHost).gradient(scale, vertical)) as Entry) : bands(k)))
    const labelsDef = markOf(defs, 'gradient-labels', () => stripLabels(k))
    // bands and labels are keyed by value: entries with one value make one item
    const keyed = joinByValue(entries as unknown as Row[])
    const strips = isGradient ? [make(stripDef, datum, 'gradient')] : keyed.map((e) => make(stripDef, e, 'band'))
    const labels = keyed.map((e) => make(labelsDef, e, 'label'))
    partMeta[isGradient ? 'gradient' : 'band'] = { name: stripDef.name, interactive: stripDef.interactive }
    partMeta.label = { name: labelsDef.name, interactive: labelsDef.interactive }
    const labelBox = (labelsDef.overlap && thinOverlaps(labels, keyed, labelsDef.overlap, host, boxOf)) || unionOf(labels)
    strip = unionOf(strips)
    entry.box = new Bounds().union(strip).union(labelBox)
    for (const it of strips) entryLeaves.push(it)
    for (const it of labels) entryLeaves.push(it)
  }

  if (!inp.raw) arrange(entry, titleItem && title, titleItem, strip, group, !!datum.vgrad, type !== SymbolLegend)
  if (titleItem) {
    titleItem.x = title.x
    titleItem.y = title.y
  }

  // the legend's size: its content from the padding on, and padding after it
  const content = new Bounds().union(entry.box)
  if (titleItem) content.union(title.box)
  if (content.empty()) {
    // nothing to show: a box of the padding alone (an empty box would leave its sentinel extents in the size)
    content.x2 = padding
    content.y2 = padding
  }
  content.x1 = padding
  content.y1 = padding
  let width = 2 * padding
  let height = 2 * padding
  if (!content.empty()) {
    width = Math.ceil(content.width() + width)
    height = Math.ceil(content.height() + height)
  }
  // (relative to the group's position: the scene adds the position a legend is given, legendX / legendY for `orient: none`)
  const bounds = boundStroke(new Bounds().set(0, 0, width, height), group as SceneItem)

  // the legend's own box, painted as a group item's background (a legend whose layout never ran has no size)
  const frame = host.groupBox(group as SceneItem, inp.raw ? 0 : width, inp.raw ? 0 : height)
  const leaves: SceneItem[] = [{ ...frame.background, _part: 'bg' } as SceneItem]
  // the entries were made in the entry group's frame; the scene holds them in the legend's
  for (const it of entryLeaves) {
    const r = it as Rec
    r.x = ((r.x as number) || 0) + entry.x
    r.y = ((r.y as number) || 0) + entry.y
    // the clip of a clipped symbol is its entry's box
    const clip = r._clip as { x: number; y: number; w: number; h: number; corners?: Rec; d?: string } | undefined
    if (clip) {
      clip.x += entry.x
      clip.y += entry.y
      // an entry with a corner radius clips to its rounded box
      if (clip.corners) clip.d = String(rectItemPath({ x: clip.x, y: clip.y, width: clip.w, height: clip.h, ...clip.corners } as SceneItem))
      delete clip.corners
    }
    // a rectangle (the gradient, a band) is drawn as the path of its box at the origin (it has no rotation)
    if (r._part === 'gradient' || r._part === 'band') {
      r.path = String(rectItemPath({ ...(it as SceneItem), x: 0, y: 0 }))
      delete r.angle
    }
    leaves.push(it)
  }
  if (titleItem) {
    titleItem._legendTitle = true
    leaves.push(titleItem)
  }
  return { leaves, legendType: type, width, height, bounds, group, partMeta, datum }
}

/**
 * Place the entries and the title against each other, inside the padding. The title goes on the side `titleOrient` says, and the
 * entries move over to make room for it; a title that would then start before the padding pushes both along.
 */
function arrange(entry: Placed, title: Placed | undefined, titleItem: (SceneItem & Rec) | undefined, strip: Bounds, group: Rec, verticalStrip: boolean, isStrip: boolean): void {
  const padding = group.padding as number
  let ex = padding - entry.x
  let ey = padding - entry.y
  if (!title || !titleItem) {
    if (ex || ey) shift(entry, ex, ey)
    return
  }
  const anchor = titleItem.anchor as string
  const orient = titleItem.orient as string
  const gap = (group.titlePadding as number) || 0
  let tx = padding - title.x
  let ty = padding - title.y
  if (orient === 'left') ex += Math.ceil(title.box.width()) + gap
  else if (orient !== 'right' && orient !== 'bottom') ey += title.box.height() + gap
  if (ex || ey) shift(entry, ex, ey)

  // Where along the entries the title goes for an anchor. `y` says along which axis (1: down the entries, 0: across them, -1: from
  // the bottom), `side` that the title is beside them, and `bare` that it is measured against the whole entry group, not the strip.
  const along = (at: string, y: number, side: boolean, bare = false): number => {
    const target = isStrip && (side || !verticalStrip) && !bare ? strip : entry.box
    const extent = (y ? target.y2 : target.x2) - padding
    const lead = verticalStrip && side ? extent : 0
    const trail = verticalStrip && side ? 0 : extent
    const lines = y <= 0 ? 0 : multiLineOffset(titleItem)
    return Math.round(at === 'start' ? lead : at === 'end' ? trail - lines : 0.5 * (extent - lines))
  }
  if (orient === 'left') {
    ty += along(anchor, 1, true)
  } else if (orient === 'right') {
    tx += along('end', 0, false) + gap
    ty += along(anchor, 1, true)
  } else if (orient === 'bottom') {
    tx += along(anchor, 0, false)
    ty += along('end', -1, false, true) + gap
  } else {
    tx += along(anchor, 0, false)
  }
  if (tx || ty) shift(title, tx, ty)
  // a title that starts before the padding pushes the legend along
  const overhang = Math.round(title.box.x1 - padding)
  if (overhang < 0) {
    shift(entry, -overhang, 0)
    shift(title, -overhang, 0)
  }
}

// --- symbol legends ------------------------------------------------------------------------------------------------------------

/** The corner radii an item has (a group's clip is a rounded box when any is truthy), or undefined. */
function cornersOf(g: Rec): Rec | undefined {
  const keys = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft']
  if (!keys.some((key) => g[key])) return undefined
  const out: Rec = {}
  for (const key of keys) if (g[key] !== undefined) out[key] = g[key]
  return out
}

/** The symbol of an item as the bounds read it: the shape's own path at the symbol's radius (a missing size is the default 64). */
function symbolForBounds(sym: SceneItem & Rec): SceneItem {
  const size = (sym.size != null ? sym.size : 64) as number
  const item: Rec = {}
  for (const key in sym) if (key !== 'size' && key !== 'shape') item[key] = sym[key]
  item.shape = (sym.shape as string | undefined) || 'circle'
  item.radius = Math.sqrt(size) / 2
  return item as SceneItem
}

/** A symbol item as the leaf the renderers draw: the path of its shape at its size. */
function drawnSymbol(sym: SceneItem & Rec): SceneItem & Rec {
  const size = (sym.size != null ? sym.size : 64) as number
  const leaf: Rec = {}
  // (copied without `size` and `shape`: a `delete` would turn the leaf into a dictionary-mode object)
  for (const key in sym) if (key !== 'size' && key !== 'shape') leaf[key] = sym[key]
  leaf.path = String(symbolPath(sym.shape as string | undefined, Math.sqrt(size) / 2))
  leaf._part = 'symbol'
  leaf._kind = 'symbol'
  return leaf as SceneItem & Rec
}

/**
 * Make the entries of a symbol legend (a box, a symbol and a label each) and lay them out in a grid of `columns` columns. The leaves
 * are appended to `out` in the entry group's frame; returns the bounds of all entries.
 */
function symbolEntries(inp: LegendBuildInput, k: Kit, defs: LegendDefs, group: Rec, partMeta: LegendBuilt['partMeta'], out: SceneItem[], entriesType: string): Bounds {
  const { host, style } = inp
  const { props } = k
  const clipped = !!props.get('clipHeight')
  const columnsRaw = props.entryColumns()
  const columns = isSignal(columnsRaw) ? (host.expr(columnsRaw.signal) as number) : (columnsRaw as number)
  let marks = defs.symbolMarks.get(!!columns)
  if (marks === undefined) defs.symbolMarks.set(!!columns, (marks = symbolMarks(inp, k, columns)))
  const { symbols, labels, entry: entryDef } = marks
  partMeta.symbol = { name: symbols.name, interactive: symbols.interactive }
  partMeta.label = { name: labels.name, interactive: labels.interactive }
  partMeta.entries = { name: entryDef.name, interactive: entryDef.interactive }

  // an entry takes the room of its symbol or of its label's font, whichever is larger; the symbol's size comes from the size scale, or from the encode
  const channelScale = (channel: string): Scale | undefined => {
    const hit = inp.channels.find(([c]) => c === channel)
    return hit ? inp.scaleOf(hit[1]) : undefined
  }
  const evaluated = (v: unknown, datum: unknown): unknown => (isSignal(v) ? host.exprDatum(v.signal, datum) : v)
  const fontSize = staticChannel('fontSize', labels.encode) || (inp.style.styles['guide-label'] as Rec | undefined)?.fontSize
  const roomOf = (v: unknown): number => {
    const sizeScale = channelScale('size')
    const widthScale = channelScale('strokeWidth')
    const size = sizeScale ? sizeScale(v) : evaluated(staticChannel('size', symbols.encode), v)
    const strokeWidth = widthScale ? widthScale(v) : evaluated(staticChannel('strokeWidth', symbols.encode), v)
    return Math.max(Math.ceil(Math.sqrt(size as number) + (strokeWidth as number)), evaluated(fontSize, v) as number)
  }
  const entries = listEntries({
    type: entriesType, scale: inp.scale, count: inp.count, limit: inp.limit, values: inp.values, minstep: inp.minstep, size: roomOf,
    formatSpecifier: inp.formatSpecifier, formatType: inp.formatType, locale: inp.locale, warn: (m) => host.warn(m),
  })

  const made = entries.map((e) => {
    // the entry group's datum is the facet tuple `{index, count}`
    const g = encodeItem(entryDef, { index: e.index, count: 1 }, group, host, style) as SceneItem & Rec
    const sym = encodeItem(symbols, e as unknown as Row, group, host, style) as SceneItem & Rec
    const lbl = encodeItem(labels, e as unknown as Row, group, host, style) as SceneItem & Rec
    sym._kind = 'symbol'
    sym._part = 'symbol'
    lbl._kind = 'text'
    lbl._part = 'label'
    // what an entry holds: its symbol, its label, and its own box when it has a clip or a size
    const symbolBox = boundLeaf(new Bounds(), symbolForBounds(sym))
    // a clipped symbol has its bounds cut to the clip region: the entry group's box, whose width is still 0 at that point
    if (clipped) symbolBox.intersect(new Bounds().set(0, 0, 0, +(g.height as number)))
    const held = new Bounds().union(symbolBox).union(boundLeaf(new Bounds(), lbl))
    const w = g.width as number
    const h = g.height as number
    if ((clipped || w || h) && !g.noBound) held.add(0, 0).add(w || 0, h || 0)
    boundStroke(held, g)
    return { e, g, sym, lbl, held }
  })

  // the order the entries are laid out in: down the columns when the legend is vertical and has columns, along the rows otherwise
  const n = made.length
  const flowRows = Math.ceil(n / Math.max(1, columns))
  let order = Array.from({ length: n }, (_, i) => i)
  if (props.vertical(true) && columns && flowRows >= 1) {
    order = []
    for (let row = 0; row < flowRows; row++) for (let i = row; i < n; i += flowRows) order.push(i)
  }
  // a column count the grid cannot take is one column (the runtime reports it beforehand for a number written in the spec)
  const ncols = columns ? (columns > 0 && Number.isInteger(columns) ? columns : 1) : n
  const resolved = (v: unknown): unknown => (isSignal(v) ? host.expr(v.signal) : v)
  const place: Array<{ x: number; y: number }> = new Array(n)
  if (inp.raw) {
    for (const i of order) place[i] = { x: 0, y: 0 }
  } else {
    const plan = placeGrid(
      order.map((i) => (made[i]!.held.empty() ? new Bounds().set(0, 0, 0, 0) : made[i]!.held.clone())),
      order.map(() => ({ x: 0, y: 0 })),
      {
        align: resolved(props.get('gridAlign')), columns: ncols, center: { row: true, column: false },
        padding: { row: resolved(props.get('rowPadding')), column: resolved(props.get('columnPadding')) },
      },
    )
    order.forEach((i, j) => { place[i] = { x: plan.dx[j]!, y: plan.dy[j]! } })
  }

  // The width of an entry's box is that of the column it is annotated with, which is not always the column the grid puts it in:
  // with more columns than the vertical flow fills, the two differ.
  const columnOf = (i: number): number => (columns ? (props.vertical(true) ? Math.floor(i / flowRows) : i % columns) : i)
  const widths = new Map<number, number>()
  const all = new Bounds()
  for (const i of order) {
    const { held } = made[i]!
    if (held.empty()) continue
    widths.set(columnOf(i), Math.max(widths.get(columnOf(i)) ?? 0, held.x2))
    all.union(held.clone().translate(place[i]!.x, place[i]!.y))
  }

  for (const i of order) {
    const { e, g, sym, lbl, held } = made[i]!
    // an item's datum is the entry it shows (what `datum.value` reads in a legend's click handlers)
    const entryDatum = { value: e.value, label: e.label, index: e.index }
    const here = place[i]!
    const width = widths.get(columnOf(i)) ?? 0
    // the entry's box is as wide as its column and as tall as what it holds
    const frame = host.groupBox({ ...(g as SceneItem) } as SceneItem, inp.raw ? 0 : width, inp.raw ? 0 : held.y2)
    const entryBox = { ...frame.background, _part: 'entry', x: here.x, y: here.y, datum: entryDatum } as SceneItem & Rec
    if (k.user.entries?.interactive === true) entryBox._hit = true
    if (g.cursor != null) entryBox.cursor = g.cursor
    const aria = itemAriaOf(g)
    if (aria) entryBox.itemAria = aria
    if (g.href != null) entryBox.href = g.href
    out.push(entryBox)
    const drawn = drawnSymbol(sym)
    drawn.x = ((sym.x as number) || 0) + here.x
    drawn.y = ((sym.y as number) || 0) + here.y
    if (clipped) drawn._clip = { x: here.x, y: here.y, w: width, h: held.y2, corners: cornersOf(g) }
    drawn.datum = entryDatum
    if (k.user.symbols?.interactive === true && drawn.fill === 'transparent') drawn._hit = true
    out.push(drawn)
    lbl.datum = entryDatum
    lbl.x = ((lbl.x as number) || 0) + here.x
    lbl.y = ((lbl.y as number) || 0) + here.y
    out.push(lbl)
  }
  return all
}

// --- the legends of a view ------------------------------------------------------------------------------------------------------

/** A rectangle by its four sides. */
export interface Sides {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Place the legends that share an `orient` as one block: stacked down a column for a left or right legend (or `direction:
 * vertical`), in a row otherwise, and anchored to the plot. Left and right legends sit outside `sideBounds`, top and bottom ones
 * outside `endBounds` (the plot with the guides beside it), the corners hang from the view's own corners, and `anchor` and `frame`
 * say where along the plot's edge. `layout` is `config.legend.layout`: a setting under the orient's own name beats the general one.
 * The legends move; each is placed with its origin at the block's.
 */
export function placeLegendStack(
  orient: string, groups: SceneGroup[], offsets: unknown[], layout: Rec, sideBounds: Sides, endBounds: Sides, width: number, height: number,
): void {
  const mine = (layout[orient] ?? {}) as Rec
  const setting = (key: string, fallback?: unknown): unknown => (mine[key] != null ? mine[key] : layout[key] != null ? layout[key] : fallback)
  // legends that ask for an offset of their own: the largest wins
  const asked = offsets.filter((o): o is number => typeof o === 'number')
  const offset = (asked.length ? Math.max(...asked) : setting('offset', 0)) as number
  const anchor = setting('anchor', 'start')
  const fraction = anchor === 'end' ? 1 : anchor === 'middle' ? 0.5 : 0
  // the point along the plot's edge the anchor names: within the view's frame, or the extent of what the plot reaches
  const byBounds = setting('frame', 'group') === 'bounds'
  const alongX = byBounds ? sideBounds.x1 + fraction * (sideBounds.x2 - sideBounds.x1) : fraction * (width || (endBounds.x2 - endBounds.x1) + 2 * endBounds.x1)
  const alongY = byBounds ? endBounds.y1 + fraction * (endBounds.y2 - endBounds.y1) : fraction * (height || (sideBounds.y2 - sideBounds.y1) + 2 * sideBounds.y1)
  // the point the block hangs from, and which of its edges that point is
  const hang: Record<string, unknown> =
    orient === 'left' ? { x: Math.floor(sideBounds.x1) - offset, column: 'end', y: alongY, row: anchor }
    : orient === 'top' ? { y: Math.floor(endBounds.y1) - offset, row: 'end', x: alongX, column: anchor }
    : orient === 'bottom' ? { y: Math.ceil(endBounds.y2) + offset, x: alongX, column: anchor }
    : orient === 'top-left' ? { x: offset, y: offset }
    : orient === 'top-right' ? { x: width - offset, y: offset, column: 'end' }
    : orient === 'bottom-left' ? { x: offset, y: height - offset, row: 'end' }
    : orient === 'bottom-right' ? { x: width - offset, y: height - offset, column: 'end', row: 'end' }
    // right, and any orient not named
    : { x: Math.ceil(sideBounds.x2) + offset, y: alongY, row: anchor }

  // a legend is as big as its frame (flush) or as everything it draws (full), measured from its own origin
  const whole = setting('bounds', 'flush') !== 'flush'
  const boxes = groups.map((g) => {
    if (!whole) return new Bounds().set(0, 0, g.width || 0, g.height || 0)
    const drawn = boundLegendGroup(g)
    return drawn.empty() ? new Bounds().set(0, 0, 0, 0) : drawn.translate(-(g.x || 0), -(g.y || 0))
  })
  const centre = setting('center')
  const centreOn = (axis: 'column' | 'row'): unknown => {
    const v = centre !== null && typeof centre === 'object' ? (centre as Rec)[axis] : centre
    return v != null ? v : 0
  }
  const plan = placeGrid(boxes, groups.map(() => ({ x: 0, y: 0 })), {
    align: 'each', columns: setting('direction') === 'vertical' ? 1 : groups.length, padding: setting('margin', 8),
    center: { row: centreOn('row'), column: centreOn('column') }, anchor: hang,
  })
  groups.forEach((g, i) => {
    g.x = plan.dx[i]!
    g.y = plan.dy[i]!
  })
}
