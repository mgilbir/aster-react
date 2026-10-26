/**
 * A legend, as vega-parser builds it (parsers/legend.js, parsers/guides/legend-*.js), vega-encode's LegendEntries
 * produces its entries, and vega-view-transforms lays it out (layout/legend.js): a group holding the entries (a
 * gradient and its labels, the bands of a discretizing scale and their labels, or one group of symbol and label per
 * entry) and the title, all encoded from the spec and the config (see guide-encode.ts for how a property reaches an
 * item), then `legendLayout`: the entries and the title are placed from the bounds of what was drawn.
 */
import type { EncodeValue, SceneItem } from './types.js'
import { Bounds, boundLeaf, boundStroke, multiLineOffset } from './bounds.js'
import { gridLayout } from './trellis.js'
import { rectItemPath, symbolPath } from './render.js'
import type { Locale } from './locale.js'
import {
  DiscreteLegend, GradientLegend, SymbolLegend, isContinuous, isDiscretizing, labelFormat, labelFraction, labelValues, scaleFraction, tickCount,
  type LabelValues,
} from './scale.js'
import { overlapItems, type OverlapSpec } from './guide-axis.js'
import {
  addEncoders, encoder, encodeItem, extendEncode, getEncoding, guideMark, isSignal, itemAriaOf, joinByValue, lookup, one, value, zero,
  type Block, type Entry, type EntryHost, type EntryScope, type GuideMarkDef, type GuideStyles, type Lookup, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'

type Rec = Record<string, unknown>
type Scale = ((v: unknown) => unknown) & Rec

/** vega-parser LegendScales: the channels a legend can map, in priority order (the first is the canonical scale). */
export const LEGEND_SCALES = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const

/** parsers/legend.js `legendType` */
export function legendType(spec: Rec, scaleType: string): string {
  let type = (spec.type as string) || SymbolLegend
  const count = LEGEND_SCALES.reduce((n, c) => n + (spec[c] ? 1 : 0), 0)
  if (!spec.type && count === 1 && (spec.fill || spec.stroke)) {
    type = isContinuous(scaleType) ? GradientLegend : isDiscretizing(scaleType) ? DiscreteLegend : SymbolLegend
  }
  return type !== GradientLegend ? type : isDiscretizing(scaleType) ? DiscreteLegend : GradientLegend
}

// --- LegendEntries (vega-encode) --------------------------------------------------------------------------------------

export interface LegendEntry {
  index: number
  label: string | null
  value: unknown
  perc?: number
  perc2?: number
  offset?: number
  size?: number
}

export interface EntriesParams {
  type: string
  scale: Scale
  count: unknown
  limit: number
  values?: unknown[]
  minstep?: number
  size?: (value: unknown) => number
  /** the fixed size of every entry when there is no size function (`offset = size || 8`) */
  sizeConst?: number
  formatSpecifier?: unknown
  formatType?: string
  locale: Locale
  warn: (msg: string) => void
}

/** vega-encode `LegendEntries.transform`: the values a legend lists, with their labels and where they sit. */
export function legendEntries(p: EntriesParams): LegendEntry[] {
  const { type, scale } = p
  const limit = +p.limit
  const count = tickCount(scale as never, p.count == null ? 5 : p.count, p.minstep)
  const lskip = !!p.values || type === SymbolLegend
  const format = labelFormat(p.locale, scale as never, count, type, p.formatSpecifier, p.formatType, lskip)
  let values: LabelValues = (p.values as LabelValues | undefined) || labelValues(scale as never, count)
  let items: LegendEntry[]

  if (type === SymbolLegend) {
    let list: unknown[]
    let ellipsis = false
    if (limit && values.length > limit) {
      p.warn('Symbol legend count exceeds limit, filtering items.')
      // (a slice is a plain list: it has lost the `max` of the intervals' last upper end)
      list = values.slice(0, limit - 1)
      ellipsis = true
    } else {
      list = values
    }
    let size: (v: unknown) => number
    let offset: number
    if (p.size) {
      // if first value maps to size zero, remove from list (vega#717)
      if (!p.values && (scale as (v: unknown) => unknown)(list[0]) === 0) list = list.slice(1)
      // compute size offset for legend entries
      offset = list.reduce((max: number, v) => Math.max(max, p.size!(v)), 0)
      size = p.size
    } else {
      offset = p.sizeConst || 8
      size = () => offset
    }
    const arr = list as LabelValues
    items = list.map((v, index) => ({ index, label: format(v, index, arr), value: v, offset, size: size(v) }))
    if (ellipsis) {
      const ev = values[items.length]
      items.push({ index: items.length, label: `…${values.length - items.length} entries`, value: ev, offset, size: size(ev) })
    }
  } else if (type === GradientLegend) {
    const domain = scale.domain as unknown as () => number[]
    const dom = domain()
    const fraction = scaleFraction(scale as never, dom[0]!, dom[dom.length - 1]!)
    // if automatic label generation produces 2 or fewer values, use the domain end points instead (vega#1364)
    if (values.length < 3 && !p.values && dom[0] !== dom[dom.length - 1]) values = [dom[0]!, dom[dom.length - 1]!]
    const arr = values
    items = values.map((v, index) => ({ index, label: format(v, index, arr), value: v, perc: fraction(v as number) as number }))
  } else {
    const size = values.length - 1
    const fraction = labelFraction(scale as never)
    const arr = values
    items = values.map((v, index) => ({
      index, label: format(v, index, arr), value: v,
      perc: index ? fraction(v) : 0,
      perc2: index === size ? 1 : fraction(values[index + 1]),
    }))
  }
  return items
}

// --- the marks ---------------------------------------------------------------------------------------------------------

/** A number or an entry that holds one, as the number it is for this datum. */
function num(s: EntryScope, v: unknown): number {
  return (v !== null && typeof v === 'object' ? s.host.entry(v as EncodeValue, s.datum) : v) as number
}

interface LegendParts {
  spec: Rec
  config: Rec
  _: Lookup
  scale: string
  encode: Record<string, UserEncode | undefined>
}

const newEncode = (): MarkEncode => ({ enter: { opacity: zero }, update: { opacity: one }, exit: { opacity: zero } })

/** guides/legend-gradient.js */
function gradientMark(p: LegendParts, vertical: boolean, gradientFill: Entry): GuideMarkDef {
  const { _ } = p
  const thickness = _.gradientThickness()
  const length = _.gradientLength()
  const width = vertical ? thickness : length
  const height = vertical ? length : thickness
  const enter: Block = { opacity: zero, x: zero, y: zero, width: encoder(width) as EncodeValue, height: encoder(height) as EncodeValue }
  const encode: MarkEncode = { enter, update: Object.assign({}, enter, { opacity: one, fill: gradientFill }), exit: { opacity: zero } }
  addEncoders(encode, { stroke: _('gradientStrokeColor'), strokeWidth: _('gradientStrokeWidth') }, { opacity: _('gradientOpacity') })
  return guideMark({ type: 'rect', role: 'legend-gradient', encode, interactive: false }, p.encode.gradient)
}

/** guides/legend-gradient-discrete.js */
function bandMark(p: LegendParts, vertical: boolean): GuideMarkDef {
  const { _ } = p
  const thickness = _.gradientThickness()
  const length = _.gradientLength()
  const [u, uu, v, vv] = vertical ? ['y', 'y2', 'x', 'width'] : ['x', 'x2', 'y', 'height']
  const along = (field: 'perc' | 'perc2'): Entry => (s) => {
    const perc = s.datum[field] as number
    // (the entry's `mult` is applied when the encode gives one)
    return length != null ? (vertical ? 1 - perc : perc) * num(s, length) : vertical ? 1 - perc : perc
  }
  const enter: Block = { opacity: zero, fill: { scale: p.scale, field: 'value' } as unknown as EncodeValue }
  enter[u!] = along('perc')
  enter[v!] = zero
  enter[uu!] = along('perc2')
  enter[vv!] = encoder(thickness) as EncodeValue
  const encode: MarkEncode = { enter, update: Object.assign({}, enter, { opacity: one }), exit: { opacity: zero } }
  addEncoders(encode, { stroke: _('gradientStrokeColor'), strokeWidth: _('gradientStrokeWidth') }, { opacity: _('gradientOpacity') })
  return guideMark({ type: 'rect', role: 'legend-band', encode, interactive: false }, p.encode.gradient)
}

/** guides/legend-gradient-labels.js */
function gradientLabelsMark(p: LegendParts, vertical: boolean): GuideMarkDef {
  const { spec, config, _ } = p
  const thickness = encoder(_.gradientThickness())
  const length = _.gradientLength()
  const overlap = _('labelOverlap')
  const enter: Block = { opacity: zero }
  const update: Block = { opacity: one, text: { field: 'label' } as EncodeValue }
  const encode: MarkEncode = { enter, update, exit: { opacity: zero } }
  addEncoders(encode, {
    fill: _('labelColor'), fillOpacity: _('labelOpacity'), font: _('labelFont'), fontSize: _('labelFontSize'), fontStyle: _('labelFontStyle'),
    fontWeight: _('labelFontWeight'), limit: value(spec.labelLimit, config.gradientLabelLimit),
  })
  const baselineFn: Entry = (s) => ((s.datum.perc as number) <= 0 ? 'bottom' : (s.datum.perc as number) >= 1 ? 'top' : 'middle')
  const alignFn: Entry = (s) => ((s.datum.perc as number) <= 0 ? 'left' : (s.datum.perc as number) >= 1 ? 'right' : 'center')
  let u: string
  let v: string
  if (vertical) {
    enter.align = { value: 'left' } as EncodeValue
    enter.baseline = update.baseline = baselineFn
    u = 'y'; v = 'x'
  } else {
    enter.align = update.align = alignFn
    enter.baseline = { value: 'top' } as EncodeValue
    u = 'x'; v = 'y'
  }
  const along: Entry = (s) => {
    const perc = vertical ? 1 - (s.datum.perc as number) : (s.datum.perc as number)
    return length != null ? perc * num(s, length) : perc
  }
  enter[u] = update[u] = along
  enter[v] = update[v] = thickness as EncodeValue
  thickness.offset = value(spec.labelOffset, config.gradientLabelOffset) || 0
  const mark = guideMark({ type: 'text', role: 'legend-label', style: 'guide-label', encode, interactive: false }, p.encode.labels)
  if (overlap) mark.overlap = { separation: _('labelSeparation'), method: overlap, order: 'datum.index', bound: null }
  return mark
}

/** guides/legend-title.js */
function titleMark(p: LegendParts): GuideMarkDef {
  const { spec, _ } = p
  const encode: MarkEncode = {
    enter: { opacity: zero },
    update: { opacity: one, x: ((s) => s.group.padding) as Entry, y: ((s) => s.group.padding) as Entry },
    exit: { opacity: zero },
  }
  const isLR = (s: EntryScope): boolean => s.item.orient === 'left' || s.item.orient === 'right'
  const anchorOf = (s: EntryScope, st: string, en: string, mi: string): string => (s.item.anchor === 'start' ? st : s.item.anchor === 'end' ? en : mi)
  addEncoders(encode, {
    orient: _('titleOrient'),
    _anchor: _('titleAnchor'),
    anchor: ((s) => (s.item._anchor as string) || (isLR(s) ? 'middle' : 'start')) as Entry,
    angle: ((s) => (s.datum.vgrad && isLR(s) ? (s.item.orient === 'left' ? -90 : 90) : 0)) as Entry,
    align: ((s) => {
      const vg = !!s.datum.vgrad
      const right = s.item.orient === 'right'
      const left = s.item.orient === 'left'
      return vg && right ? anchorOf(s, 'right', 'left', 'center')
        : isLR(s) && !(vg && left) ? 'left'
        : anchorOf(s, 'left', 'right', 'center')
    }) as Entry,
    baseline: ((s) => (isLR(s) ? (s.datum.vgrad ? (s.item.orient === 'right' ? 'bottom' : 'top') : anchorOf(s, 'top', 'bottom', 'middle')) : 'top')) as Entry,
    text: spec.title,
    fill: _('titleColor'), fillOpacity: _('titleOpacity'), font: _('titleFont'), fontSize: _('titleFontSize'), fontStyle: _('titleFontStyle'),
    fontWeight: _('titleFontWeight'), limit: _('titleLimit'), lineHeight: _('titleLineHeight'),
  }, { align: _('titleAlign'), baseline: _('titleBaseline') })
  return guideMark({ type: 'text', role: 'legend-title', style: 'guide-title', encode, interactive: false }, p.encode.title)
}

/** parsers/legend.js `buildLegendEncode`: the legend group's own encode, which the layout reads */
function groupEncode(p: LegendParts): MarkEncode {
  const { spec, config, _ } = p
  const encode: MarkEncode = { enter: {}, update: {} }
  addEncoders(encode, {
    orient: _('orient'), offset: _('offset'), padding: _('padding'), titlePadding: _('titlePadding'), cornerRadius: _('cornerRadius'),
    fill: _('fillColor'), stroke: _('strokeColor'), strokeWidth: config.strokeWidth, strokeDash: config.strokeDash,
    x: _('legendX'), y: _('legendY'), format: spec.format, formatType: spec.formatType,
  })
  return extendEncode(encode, p.encode.legend, true)
}

export interface LegendBuildInput {
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
  /** the legend-entry grid: columns the layout cannot take make it throw upstream */
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

const strOrUndef = (n: unknown): string | undefined => (n == null || n === '' ? undefined : String(n))

/** Build a legend from vega-parser's guides, evaluate it, lay it out. */
export function buildLegend(inp: LegendBuildInput): LegendBuilt {
  const { spec, config, host, style } = inp
  const _ = lookup(spec, config)
  const p: LegendParts = { spec, config, _, scale: '', encode: inp.encode }
  const type = legendType(spec, inp.scaleType)
  const vertical = _.isVertical()
  const scales: Rec = {}
  for (const [c, n] of inp.channels) scales[c] = n
  p.scale = inp.channels[0]?.[1] ?? ''
  const datum: Row = { title: spec.title != null, scales, type, vgrad: type !== SymbolLegend && vertical }
  const group = encodeItem({ type: 'rule', role: 'legend', style: inp.encode.legend?.style, encode: groupEncode(p), interactive: false }, datum, {}, host, style) as unknown as Rec
  const partMeta: LegendBuilt['partMeta'] = {
    legend: { name: strOrUndef(inp.encode.legend?.name), interactive: !!inp.encode.legend?.interactive },
  }
  const eval1 = (def: GuideMarkDef, d: Row, kind: string): SceneItem => {
    const it = encodeItem(def, d, group, host, style) as SceneItem & Rec
    it._kind = def.type === 'text' ? 'text' : def.type === 'rect' ? 'rect' : def.type === 'symbol' ? 'symbol' : 'rule'
    it._part = kind
    return it
  }
  const leaves: SceneItem[] = []
  const boundOf = (it: SceneItem): Bounds => boundLeaf(new Bounds(), it)
  const union = (items: SceneItem[]): Bounds => {
    const b = new Bounds()
    for (const it of items) b.union(boundOf(it))
    return b
  }

  // (the padding is what the group item has: a missing one makes the layout's arithmetic NaN, as vega's)
  const pad = group.padding as number
  const titleDef = datum.title ? titleMark(p) : undefined
  let titleItem: (SceneItem & Rec) | undefined
  let titleBounds = new Bounds()
  if (titleDef) {
    titleItem = eval1(titleDef, datum, 'title') as SceneItem & Rec
    titleBounds = boundOf(titleItem)
    partMeta.title = { name: titleDef.name, interactive: titleDef.interactive }
  }

  // --- the entry group (vega: `legend-entry`) ---
  let entryBounds = new Bounds()
  /** the bounds of the entry group's first mark (the gradient or the bands): the title offsets of a gradient legend read it */
  let firstMarkBounds = new Bounds()
  const entryLeaves: SceneItem[] = []
  const symbolGroup: { bounds: Bounds; entries: Array<{ box?: SceneItem; bounds: Bounds; x: number; y: number; w: number; h: number }> } = { bounds: new Bounds(), entries: [] }

  // (vega-parser builds symbol groups for anything that is not a gradient or a discrete legend, whatever LegendEntries makes of the type)
  if (type !== GradientLegend && type !== DiscreteLegend) {
    buildSymbols(inp, p, group, datum, partMeta, entryLeaves, symbolGroup, type)
    entryBounds = symbolGroup.bounds
  } else {
    const gradientLike = type === GradientLegend
    // the default tick count of a gradient legend follows its length
    let count = inp.count
    if (gradientLike && !count) {
      const len = _.gradientLength()
      const n = isSignal(len) ? (host.expr(len.signal) as number) : (len as number)
      count = Math.max(2, 2 * Math.floor(n / 100))
    }
    const entries = legendEntries({
      type, scale: inp.scale, count, limit: inp.limit, values: inp.values, minstep: inp.minstep,
      formatSpecifier: inp.formatSpecifier, formatType: inp.formatType, locale: inp.locale, warn: (m) => host.warn(m),
    })
    const firstDef = gradientLike
      ? gradientMark(p, vertical, ((s: EntryScope) => (s.host as GuideHost).gradient(p.scale, vertical)) as Entry)
      : bandMark(p, vertical)
    const labelsDef = gradientLabelsMark(p, vertical)
    // (the bands and the labels are keyed by value: entries with one value make one item)
    const keyed = joinByValue(entries as unknown as Row[])
    const firstItems: SceneItem[] = gradientLike ? [eval1(firstDef, datum, 'gradient')] : keyed.map((e) => eval1(firstDef, e, 'band'))
    partMeta[gradientLike ? 'gradient' : 'band'] = { name: firstDef.name, interactive: firstDef.interactive }
    const labelItems = keyed.map((e) => eval1(labelsDef, e, 'label'))
    partMeta.label = { name: labelsDef.name, interactive: labelsDef.interactive }
    let labelBounds: Bounds | null = null
    if (labelsDef.overlap) labelBounds = overlapItems(labelItems, keyed, labelsDef.overlap as OverlapSpec, host, boundOf)
    if (!labelBounds) labelBounds = union(labelItems)
    firstMarkBounds = union(firstItems)
    entryBounds = new Bounds().union(firstMarkBounds).union(labelBounds)
    for (const it of firstItems) entryLeaves.push(it)
    for (const it of labelItems) entryLeaves.push(it)
  }

  // --- legendLayout (vega-view-transforms layout/legend.js) ---
  const entry = { x: 0, y: 0 } // the entry group item sits at the origin (its encode: x, y = 0)
  const titlePadding = (group.titlePadding as number) || 0
  const shift = (dx: number, dy: number, node: { x: number; y: number }, bounds: Bounds): void => {
    node.x += dx
    node.y += dy
    bounds.translate(dx, dy)
  }
  const title = titleItem ? { x: titleItem.x as number, y: titleItem.y as number } : undefined
  if (!inp.raw) {
    let ex = pad - entry.x
    let ey = pad - entry.y
    if (!titleItem) {
      if (ex || ey) shift(ex, ey, entry, entryBounds)
    } else {
      const anchor = titleItem.anchor as string
      let tx = pad - title!.x
      let ty = pad - title!.y
      const tOrient = titleItem.orient as string
      switch (tOrient) {
        case 'left': ex += Math.ceil(titleBounds.width()) + titlePadding; break
        case 'right':
        case 'bottom': break
        default: ey += titleBounds.height() + titlePadding
      }
      if (ex || ey) shift(ex, ey, entry, entryBounds)
      const gradKind = type !== SymbolLegend
      const vgrad = !!datum.vgrad
      const titleOffset = (a: string, y: number, lr: number, noBar?: number): number => {
        const e = gradKind && (lr || !vgrad) && !noBar ? firstMarkBounds : entryBounds
        const s = (y ? e.y2 : e.x2) - pad
        const u = vgrad && lr ? s : 0
        const v = vgrad && lr ? 0 : s
        const o = y <= 0 ? 0 : multiLineOffset(titleItem!)
        return Math.round(a === 'start' ? u : a === 'end' ? v - o : 0.5 * (s - o))
      }
      switch (tOrient) {
        case 'left':
          ty += titleOffset(anchor, 1, 1)
          break
        case 'right':
          tx += titleOffset('end', 0, 0) + titlePadding
          ty += titleOffset(anchor, 1, 1)
          break
        case 'bottom':
          tx += titleOffset(anchor, 0, 0)
          ty += titleOffset('end', -1, 0, 1) + titlePadding
          break
        default:
          tx += titleOffset(anchor, 0, 0)
      }
      if (tx || ty) shift(tx, ty, title!, titleBounds)
      // translate legend if title pushes into negative coordinates
      const back = Math.round(titleBounds.x1 - pad)
      if (back < 0) {
        shift(-back, 0, entry, entryBounds)
        shift(-back, 0, title!, titleBounds)
      }
    }
  }
  if (titleItem) {
    titleItem.x = title!.x
    titleItem.y = title!.y
  }

  // legendBounds: the entry and the title, anchored at the legend's origin padding
  const lb = new Bounds()
  lb.union(entryBounds)
  if (titleItem) lb.union(titleBounds)
  if (lb.empty()) {
    // set upper-right corner for empty legends (e.g., no entries or title)
    lb.x2 = pad
    lb.y2 = pad
  }
  lb.x1 = pad
  lb.y1 = pad
  let w = 2 * pad
  let h = 2 * pad
  if (!lb.empty()) {
    w = Math.ceil(lb.width() + w)
    h = Math.ceil(lb.height() + h)
  }
  // (relative to the group's position: the scene adds the position a legend is given, legendX / legendY for `orient: none`)
  const markBounds = boundStroke(new Bounds().set(0, 0, w, h), group as SceneItem)

  // the legend's own box, painted as a group item's background
  // (a legend whose layout never ran has no size: its box stays a placeholder)
  const box = host.groupBox(group as SceneItem, inp.raw ? 0 : w, inp.raw ? 0 : h)
  const out: SceneItem[] = [{ ...box.background, _part: 'bg' } as SceneItem]
  // the entries' leaves live in the entry group's frame; the scene bakes the frame's position into them
  for (const it of entryLeaves) {
    const r = it as Rec
    r.x = ((r.x as number) || 0) + entry.x
    r.y = ((r.y as number) || 0) + entry.y
    // the clip of a clipped symbol is its entry's box, in the legend's frame
    const clip = r._clip as { x: number; y: number; w: number; h: number; corners?: Rec; d?: string } | undefined
    if (clip) {
      clip.x += entry.x
      clip.y += entry.y
      // an entry with a corner radius clips to its rounded box
      if (clip.corners) clip.d = String(rectItemPath({ x: clip.x, y: clip.y, width: clip.w, height: clip.h, ...clip.corners } as SceneItem))
      delete clip.corners
    }
    // a rectangle (the gradient, a band) is drawn as the path of its box, at its position
    if (r._part === 'gradient' || r._part === 'band') {
      r.path = String(rectItemPath({ ...(it as SceneItem), x: 0, y: 0 }))
      // (a rectangle has no rotation: vega's rect shape ignores `angle`)
      delete r.angle
    }
    out.push(it)
  }
  if (titleItem) {
    ;(titleItem as Rec)._legendTitle = true
    out.push(titleItem)
  }
  return { leaves: out, legendType: type, width: w, height: h, bounds: markBounds, group, partMeta, datum }
}

// --- symbol legends -------------------------------------------------------------------------------------------------------

/** guides/legend-symbol-groups.js, with the entry layout (`legendSymbolLayout`) */
function buildSymbols(
  inp: LegendBuildInput, p: LegendParts, group: Rec, datum: Row, partMeta: LegendBuilt['partMeta'], out: SceneItem[],
  result: { bounds: Bounds; entries: Array<{ box?: SceneItem; bounds: Bounds; x: number; y: number; w: number; h: number }> },
  entriesType: string,
): void {
  const { spec, config, host, style } = inp
  const _ = p._
  const userEncode = p.encode
  const entriesEncode = userEncode.entries
  const height = _('clipHeight')
  const symbolOffset = _('symbolOffset')
  const columnsRaw = _.entryColumns()
  const columns = isSignal(columnsRaw) ? (host.expr(columnsRaw.signal) as number) : (columnsRaw as number)
  const xSignal = (s: EntryScope): unknown => (columns ? s.datum.offset : s.datum.size)
  const half = (s: EntryScope): number => (xSignal(s) as number) * 0.5
  const yEncode: Entry = height ? ({ ...(encoder(height) as Rec), mult: 0.5 } as unknown as EncodeValue) : ((s) => (s.datum.size as number) * 0.5)

  // -- LEGEND SYMBOLS --
  const symEnter: Block = {
    opacity: zero,
    // (an entry's offset is added only when the encode gives one: `offset != null`)
    x: ((s) => (symbolOffset != null ? half(s) + num(s, symbolOffset) : half(s))) as Entry,
    y: yEncode,
  }
  const symEncode: MarkEncode = { enter: symEnter, update: { opacity: one, x: symEnter.x, y: symEnter.y }, exit: { opacity: zero } }
  let baseFill: unknown = null
  let baseStroke: unknown = null
  if (!spec.fill) {
    baseFill = config.symbolBaseFillColor
    baseStroke = config.symbolBaseStrokeColor
  }
  addEncoders(symEncode, {
    fill: _('symbolFillColor', baseFill), shape: _('symbolType'), size: _('symbolSize'), stroke: _('symbolStrokeColor', baseStroke),
    strokeDash: _('symbolDash'), strokeDashOffset: _('symbolDashOffset'), strokeWidth: _('symbolStrokeWidth'),
  }, { opacity: _('symbolOpacity') })
  for (const [c, name] of inp.channels) symEncode.update[c] = symEncode.enter[c] = { scale: name, field: 'value' } as unknown as EncodeValue
  const symbolsDef = guideMark({ type: 'symbol', role: 'legend-symbol', encode: symEncode, interactive: false }, userEncode.symbols)

  // -- LEGEND LABELS --
  const labelOffset = encoder(symbolOffset)
  labelOffset.offset = _('labelOffset')
  const lblEnter: Block = {
    opacity: zero,
    x: ((s) => (xSignal(s) as number) + num(s, labelOffset)) as Entry,
    y: yEncode,
  }
  const lblEncode: MarkEncode = { enter: lblEnter, update: { opacity: one, text: { field: 'label' } as EncodeValue, x: lblEnter.x, y: lblEnter.y }, exit: { opacity: zero } }
  addEncoders(lblEncode, {
    align: _('labelAlign'), baseline: _('labelBaseline'), fill: _('labelColor'), fillOpacity: _('labelOpacity'), font: _('labelFont'),
    fontSize: _('labelFontSize'), fontStyle: _('labelFontStyle'), fontWeight: _('labelFontWeight'), limit: _('labelLimit'),
  })
  const labelsDef = guideMark({ type: 'text', role: 'legend-label', style: 'guide-label', encode: lblEncode, interactive: false }, userEncode.labels)
  partMeta.symbol = { name: symbolsDef.name, interactive: symbolsDef.interactive }
  partMeta.label = { name: labelsDef.name, interactive: labelsDef.interactive }

  // the size of an entry: sizeExpression, `max(ceil(sqrt(size)+strokeWidth), fontSize)`
  const channelScale = (c: string): Scale | undefined => {
    const e = inp.channels.find(([ch]) => ch === c)
    return e ? inp.scaleOf(e[1]) : undefined
  }
  const symEnc = (name: string): unknown => getEncoding(name, applyStyleless(symEncode))
  const fontSizeEnc = getEncoding('fontSize', applyStyleless(lblEncode)) || (inp.style.styles['guide-label'] as Rec | undefined)?.fontSize
  const evalSig = (v: unknown, value: unknown): unknown => (isSignal(v) ? host.exprDatum(v.signal, value) : v)
  const sizeFn = (v: unknown): number => {
    const sizeScale = channelScale('size')
    const strokeWidthScale = channelScale('strokeWidth')
    const size = sizeScale ? sizeScale(v) : evalSig(symEnc('size'), v)
    const strokeWidth = strokeWidthScale ? strokeWidthScale(v) : evalSig(symEnc('strokeWidth'), v)
    const fontSize = evalSig(fontSizeEnc, v)
    // max(ceil(sqrt(size)+strokeWidth), fontSize): JS arithmetic on whatever the three are
    return Math.max(Math.ceil(Math.sqrt(size as number) + (strokeWidth as number)), fontSize as number)
  }

  const entries = legendEntries({
    type: entriesType, scale: inp.scale, count: inp.count, limit: inp.limit, values: inp.values, minstep: inp.minstep,
    size: sizeFn, formatSpecifier: inp.formatSpecifier, formatType: inp.formatType, locale: inp.locale, warn: (m) => host.warn(m),
  })

  // -- LEGEND ENTRY GROUPS --
  const entryEnter: Block = {
    noBound: { value: !height } as EncodeValue,
    width: zero,
    height: (height ? encoder(height) : zero) as EncodeValue,
    opacity: zero,
  }
  const entryEncode: MarkEncode = { enter: entryEnter, update: { opacity: one }, exit: { opacity: zero } }
  extendEncode(entryEncode, entriesEncode, true)
  const entryDef: GuideMarkDef = { type: 'rule', role: 'scope', encode: entryEncode, interactive: !!entriesEncode?.interactive, name: strOrUndef(entriesEncode?.name) }
  partMeta.entries = { name: entryDef.name, interactive: entryDef.interactive }

  const n = entries.length
  const items = entries.map((e) => {
    // the entry's datum is the facet tuple `{index, count}`
    const g = encodeItem(entryDef, { index: e.index, count: 1 }, group, host, style) as SceneItem & Rec
    const sym = encodeItem(symbolsDef, e as unknown as Row, group, host, style) as SceneItem & Rec
    sym._kind = 'symbol'
    const lbl = encodeItem(labelsDef, e as unknown as Row, group, host, style) as SceneItem & Rec
    lbl._kind = 'text'
    sym._part = 'symbol'
    lbl._part = 'label'
    return { e, g, sym, lbl }
  })
  const hasClip = !!height
  // bounds of each entry group (the Bound pass): its symbol, its label, and the group box when it is bounded
  const boundOf = (it: SceneItem): Bounds => boundLeaf(new Bounds(), it)
  const ebs = items.map(({ g, sym, lbl }) => {
    // (the symbol's bound: the shape's path traced unrounded, stroked with the miter allowance, at the item's position)
    const symB = boundOf(symbolBoundItem(sym))
    // a clipped symbol mark has its bounds cut to the clip region: the entry group's box, whose width is still 0 when the
    // Bound pass runs (boundClip)
    if (hasClip) symB.intersect(new Bounds().set(0, 0, 0, +(g.height as number)))
    const eb = new Bounds().union(symB).union(boundOf(lbl))
    // group bound: (clip || width || height) && !noBound adds the corner points (0,0) and (width, height)
    const gw = g.width as number
    const gh = g.height as number
    if ((hasClip || gw || gh) && !g.noBound) eb.add(0, 0).add(gw || 0, gh || 0)
    // the group's own stroke (an `encode.entries` stroke) widens its bound
    boundStroke(eb, g)
    return eb
  })

  // the entry groups are laid out by gridLayout over the SORTED groups; the sort is the paint order
  const colsFlag = columns
  // (vega's gridLayout: `columns || groups.length`; a column count that is no valid array length makes it throw, which the
  // runtime knows beforehand for a number written in the spec)
  const ncols = colsFlag ? (colsFlag > 0 && Number.isInteger(colsFlag) ? colsFlag : 1) : n
  const paintOrder = Array.from({ length: n }, (_u, i) => i)
  if (_.isVertical(true)) {
    const nrows = Math.ceil(n / Math.max(1, colsFlag))
    // vertical: sort by [row, index] with row = index % nrows (columns falsy: one row ... the signal is `(columns) ? row : index`)
    if (colsFlag) paintOrder.sort((x, y) => (x % nrows) - (y % nrows) || x - y)
  }
  const groups = paintOrder.map(() => ({ marktype: 'group', x: 0, y: 0, items: [] }) as unknown as Parameters<typeof gridLayout>[0][number])
  // (the layout never ran: every entry sits at its encode position, on top of the others)
  const resolved = (v: unknown): unknown => (isSignal(v) ? host.expr(v.signal) : v)
  if (!inp.raw) gridLayout(groups, {
    align: resolved(_('gridAlign')), columns: ncols, center: { row: true, column: false },
    padding: { row: resolved(_('rowPadding')), column: resolved(_('columnPadding')) }, nodirty: true,
  }, (g) => {
    const eb = ebs[paintOrder[groups.indexOf(g)]!]!
    return eb.empty() ? new Bounds().set(0, 0, 0, 0) : eb.clone()
  })
  const colW: number[] = Array<number>(ncols).fill(0)
  const pos: Array<{ x: number; y: number }> = new Array(n)
  paintOrder.forEach((idx, j) => {
    pos[idx] = { x: groups[j]!.x ?? 0, y: groups[j]!.y ?? 0 }
    const eb = ebs[idx]!
    if (!eb.empty()) colW[j % ncols] = Math.max(colW[j % ncols]!, eb.x2)
  })
  const bounds = new Bounds()
  paintOrder.forEach((idx, j) => {
    const eb = ebs[idx]!
    if (eb.empty()) return
    bounds.union(eb.clone().translate(pos[idx]!.x, pos[idx]!.y))
    void j
  })
  result.bounds = bounds

  // the leaves: per entry (in paint order) its box, its symbol, its label, positions in the entry group's frame
  paintOrder.forEach((idx, j) => {
    const { g, sym, lbl } = items[idx]!
    const eb = ebs[idx]!
    const at = pos[idx]!
    const colWc = colW[j % ncols] ?? 0
    // legendEntryLayout: the box is as wide as its column and as tall as its own bound
    const gb = host.groupBox({ ...(g as SceneItem) } as SceneItem, inp.raw ? 0 : colWc, inp.raw ? 0 : eb.y2)
    const box = { ...gb.background, _part: 'entry', x: at.x, y: at.y } as SceneItem & Rec
    const ia = itemAriaOf(g)
    if (ia) box.itemAria = ia
    if (g.href != null) box.href = g.href
    out.push(box)
    const s = bakeSymbol(sym)
    s.x = ((sym.x as number) || 0) + at.x
    s.y = ((sym.y as number) || 0) + at.y
    if (hasClip) (s as Rec)._clip = { x: at.x, y: at.y, w: colWc, h: eb.y2, corners: cornersOf(g) }
    out.push(s)
    lbl.x = ((lbl.x as number) || 0) + at.x
    lbl.y = ((lbl.y as number) || 0) + at.y
    out.push(lbl)
  })
}

/** the guide marks' blocks without the style defaults (vega's getEncoding reads the mark's own encode) */
function applyStyleless(e: MarkEncode): MarkEncode {
  return e
}

/** The corner radii an item has (vega's group clip is a rounded box when any is truthy), or undefined. */
function cornersOf(g: Rec): Rec | undefined {
  const keys = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft']
  if (!keys.some((k) => g[k])) return undefined
  const out: Rec = {}
  for (const k of keys) if (g[k] !== undefined) out[k] = g[k]
  return out
}

/** The symbol item the bound pass reads: the shape and its radius (vega traces the shape's own path). */
function symbolBoundItem(sym: SceneItem & Rec): SceneItem {
  const size = (sym.size != null ? sym.size : 64) as number
  const item: Rec = { ...sym, shape: (sym.shape as string | undefined) || 'circle', radius: Math.sqrt(size) / 2 }
  delete item.size
  return item as SceneItem
}

/** A symbol item as the leaf the renderers draw: its shape's path at its `size`. */
function bakeSymbol(sym: SceneItem & Rec): SceneItem & Rec {
  // (vega's symbol shape: `size` is 64 unless the item has one)
  const size = (sym.size != null ? sym.size : 64) as number
  const r = Math.sqrt(size) / 2
  const leaf: Rec = { ...sym }
  delete leaf.size
  delete leaf.shape
  leaf.path = String(symbolPath(sym.shape as string | undefined, r))
  leaf._part = 'symbol'
  leaf._kind = 'symbol'
  return leaf as SceneItem & Rec
}

