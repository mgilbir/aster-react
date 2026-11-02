/**
 * Which properties of an axis, a legend and the title vega reads as expressions, and how. An axis, a legend and a title are not
 * parsed as they are written: vega-parser turns each into marks (an axis into a grid, ticks, labels, a domain line and a title; a
 * symbol legend into symbols and labels, a gradient into a bar and labels), and a property of the guide is only read by the mark it
 * belongs to. A property of a mark the guide does not have, one a scale's channel replaces, or one that only switches a feature on
 * (`grid`, `labels`) is never parsed, so an expression in it that vega would refuse is accepted.
 *
 * What is read is one of:
 * - an `entry`: the signal is the entry of a channel of one of the marks, whose expression is the signal in parentheses;
 * - a `value`: the signal is read on its own, as the parameter of the guide's data (`tickMinStep`, `symbolLimit`, ...), and a
 *   spec's `{signal: name}` that names a signal is a reference rather than an expression;
 * - an `object`: a list or an object whose parts may be signals (`values`, `tickCount`);
 * - a part of the `layout` of the entries of a symbol legend, an object vega writes out as one expression;
 * - nothing.
 *
 * Not reproduced: the longer text vega writes around a few of the entries when it is the author's text that is wrong in them
 * (`WRAPPED`: the positions of a band, the offsets of labels and ticks, the flush of labels, the symbol offset, the entry columns
 * and the sizes of a symbol legend other than the size expression below). They are read, and quoted by themselves.
 */
import { axisValue, legendType, LEGEND_CHANNELS } from './spec-structure.js'

type Rec = Record<string, unknown>
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

export type Reading = 'entry' | 'value' | 'object' | 'layout' | 'never'

export interface GuideEnv {
  /** the merged config of the view */
  config: Rec
  /** the type of the scale of that name in the scope the guide is read in */
  scaleType(name: unknown): string | undefined
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(' '))

/** The properties of an axis that vega reads from the axis alone, whichever marks it has. */
const AXIS_GROUP = set('orient offset position titlePadding minExtent maxExtent translate title')
const AXIS_OBJECTS = set('tickCount values')
const AXIS_NEVER = set('aria description zindex domain grid labels ticks tickRound')
/** Per mark: the properties an axis gives it (`tickSize` and the band's properties are read by more than one). */
const AXIS_MARKS: Readonly<Record<'grid' | 'ticks' | 'labels' | 'domain' | 'title', ReadonlySet<string>>> = {
  grid: set('gridCap gridColor gridDash gridDashOffset gridOpacity gridWidth'),
  ticks: set('tickCap tickColor tickDash tickDashOffset tickOpacity tickWidth tickSize'),
  labels: set('labelAlign labelAngle labelBaseline labelColor labelFlush labelFont labelFontSize labelFontStyle labelFontWeight labelLimit labelLineHeight labelOffset labelOpacity labelPadding'),
  domain: set('domainCap domainColor domainDash domainDashOffset domainOpacity domainWidth'),
  title: set('titleAlign titleAnchor titleAngle titleBaseline titleColor titleFont titleFontSize titleFontStyle titleFontWeight titleLimit titleLineHeight titleOpacity titleX titleY'),
}

const AXIS_MARK_NAMES = ['grid', 'ticks', 'labels', 'domain', 'title'] as const

/** How an axis's properties are read, given the marks it has: what is asked is worked out when it is, once. */
class AxisReading {
  private flags = new Map<string, boolean>()
  constructor(private readonly a: Rec, private readonly env: GuideEnv) {}

  private has(name: string): unknown { return axisValue(this.a, name, this.env.scaleType, this.env.config) }

  /** whether the axis has the feature (`grid`, `ticks`, `labels`, `domain`) */
  private on(mark: string): boolean {
    if (mark === 'title') return this.a.title != null
    let on = this.flags.get(mark)
    if (on === undefined) this.flags.set(mark, (on = !!this.has(mark)))
    return on
  }

  /** Labels are flushed to the ends of the axis (`labelFlush`), which moves them by an offset (`labelFlushOffset`); that is read for the direction the labels do not have their own alignment in. */
  private flushRead(): boolean {
    const flush = this.has('labelFlush')
    if (!this.on('labels') || !(flush === 0 || flush)) return false
    const orient = this.a.orient
    const vertical = typeof orient === 'string' && orient !== 'top' && orient !== 'bottom'
    return typeof orient !== 'string' ? !this.has('labelAlign') || !this.has('labelBaseline') : vertical ? !this.has('labelBaseline') : !this.has('labelAlign')
  }

  /** A constant `tickBand` settles where ticks lie (`extent`: at the ends, no offset), and a signal one is read wherever ticks are. */
  private band(): 'none' | 'extent' | 'constant' | 'signal' {
    const value = this.has('tickBand')
    return !value ? 'none' : value === 'extent' ? 'extent' : typeof value === 'string' ? 'constant' : 'signal'
  }

  read(key: string): Reading {
    if (AXIS_NEVER.has(key)) return 'never'
    if (AXIS_OBJECTS.has(key)) return 'object'
    if (AXIS_GROUP.has(key) || key === 'format' || key === 'formatType') return 'entry'
    if (key === 'tickExtra') return this.band() === 'none' ? 'value' : 'never'
    if (key === 'tickMinStep') return 'value'
    if (key === 'labelBound' || key === 'labelOverlap') return this.on('labels') ? 'value' : 'never'
    if (key === 'labelSeparation') return this.on('labels') && (!!this.has('labelOverlap') || !!this.has('labelBound')) ? 'value' : 'never'
    if (key === 'labelFlush' || key === 'labelFlushOffset') return this.flushRead() ? 'entry' : 'never'
    if (key === 'gridScale') return this.on('grid') ? 'entry' : 'never'
    if (key === 'tickBand') return 'entry'
    if (key === 'bandPosition') return this.band() === 'none' && (this.on('grid') || this.on('ticks')) ? 'entry' : 'never'
    if (key === 'tickOffset') return this.band() !== 'extent' && (this.on('grid') || this.on('ticks') || this.on('labels')) ? 'entry' : 'never'
    for (const mark of AXIS_MARK_NAMES) if (AXIS_MARKS[mark]!.has(key)) return this.on(mark) ? 'entry' : 'never'
    return 'entry'
  }
}

const LEGEND_GROUP = set('orient offset padding titlePadding cornerRadius fillColor strokeColor legendX legendY format formatType')
const LEGEND_NEVER = set('aria description type direction zindex')
const LEGEND_TITLE = set('title titleAlign titleAnchor titleBaseline titleColor titleFont titleFontSize titleFontStyle titleFontWeight titleLimit titleLineHeight titleOpacity titleOrient')
const LEGEND_LABELS = set('labelColor labelFont labelFontSize labelFontStyle labelFontWeight labelLimit labelOpacity labelOffset')
const LEGEND_GRADIENT = set('gradientLength gradientOpacity gradientStrokeColor gradientStrokeWidth gradientThickness')
/** A label property and the channel of the labels' encode that replaces it. */
const LABEL_CHANNEL: Readonly<Record<string, string>> = {
  labelColor: 'fill', labelFont: 'font', labelFontSize: 'fontSize', labelFontStyle: 'fontStyle', labelFontWeight: 'fontWeight',
  labelLimit: 'limit', labelOpacity: 'fillOpacity', labelAlign: 'align', labelBaseline: 'baseline',
}

/** A symbol property, the channel of the legend whose scale replaces it, and the channel of the symbols' encode that does too. */
const SYMBOL_CHANNEL: Readonly<Record<string, readonly [string, string]>> = {
  symbolType: ['shape', 'shape'], symbolSize: ['size', 'size'], symbolOpacity: ['opacity', 'opacity'], symbolFillColor: ['fill', 'fill'],
  symbolStrokeColor: ['stroke', 'stroke'], symbolStrokeWidth: ['strokeWidth', 'strokeWidth'], symbolDash: ['strokeDash', 'strokeDash'],
  symbolDashOffset: ['', 'strokeDashOffset'],
}

/** How a legend's properties are read. */
function legendReading(l: Rec, env: GuideEnv): (key: string) => Reading {
  const channel = LEGEND_CHANNELS.map((c) => l[c]).find((s) => !!s)
  const type = legendType(l, channel ? env.scaleType(channel) : undefined)
  const symbols = type === 'symbol'
  const title = l.title != null
  const userSymbols = isRecord(l.encode) && isRecord((l.encode as Rec).symbols) ? ((l.encode as Rec).symbols as Rec) : {}
  const userLabels = isRecord(l.encode) && isRecord((l.encode as Rec).labels) ? ((l.encode as Rec).labels as Rec) : {}
  const setIn = (part: Rec, channel: string): boolean => ['enter', 'update'].some((block) => isRecord(part[block]) && (part[block] as Rec)[channel] != null)
  const symbolEncoded = (channel: string): boolean => setIn(userSymbols, channel)
  const lookup = (name: string): unknown => (l[name] != null ? l[name] : isRecord(env.config.legend) ? (env.config.legend as Rec)[name] : undefined)
  return (key) => {
    if (LEGEND_NEVER.has(key)) return 'never'
    if (key === 'tickCount' || key === 'values') return 'object'
    if (key === 'symbolLimit' || key === 'tickMinStep') return 'value'
    if (LEGEND_GROUP.has(key)) return 'entry'
    if (LEGEND_TITLE.has(key)) return title ? 'entry' : 'never'
    if (LEGEND_GRADIENT.has(key)) return symbols ? 'never' : 'entry'
    if (key === 'labelAlign' || key === 'labelBaseline') return symbols && !setIn(userLabels, LABEL_CHANNEL[key]!) ? 'entry' : 'never'
    if (key === 'labelOverlap' || key === 'labelSeparation') return symbols || !lookup('labelOverlap') ? 'never' : 'value'
    if (LEGEND_LABELS.has(key)) return Object.hasOwn(LABEL_CHANNEL, key) && setIn(userLabels, LABEL_CHANNEL[key]!) ? 'never' : 'entry'
    if (key === 'clipHeight' || key === 'symbolOffset') return symbols ? 'entry' : 'never'
    if (Object.hasOwn(SYMBOL_CHANNEL, key)) {
      const [scaled, encoded] = SYMBOL_CHANNEL[key]!
      // the legend's scale for the channel, or the author's encode of it, replaces the property
      return symbols && !(scaled && l[scaled]) && !symbolEncoded(encoded) ? 'entry' : 'never'
    }
    if (key === 'columns') return symbols ? 'entry' : 'never'
    if (key === 'gridAlign' || key === 'columnPadding' || key === 'rowPadding') return symbols ? 'layout' : 'never'
    return 'entry'
  }
}

const TITLE_NEVER = set('aria description zindex')
const TITLE_SUBTITLE = /^subtitle(?!Padding)/

/** How the title's properties are read. */
function titleReading(t: Rec): (key: string) => Reading {
  return (key) => (TITLE_NEVER.has(key) ? 'never' : TITLE_SUBTITLE.test(key) && !t.subtitle ? 'never' : key === 'subtitle' && !t.subtitle ? 'never' : 'entry')
}

export type GuideKind = 'axis' | 'legend' | 'title'

/** How vega reads each property of a guide: see {@link Reading}. */
export function guideReading(kind: GuideKind, guide: Rec, env: GuideEnv): (key: string) => Reading {
  if (kind === 'axis') {
    const reading = new AxisReading(guide, env)
    return (key) => reading.read(key)
  }
  return kind === 'legend' ? legendReading(guide, env) : titleReading(guide)
}

/** The guide properties whose expression vega quotes inside a longer text; they are read, and quoted by themselves (see above). */
export const WRAPPED: ReadonlySet<string> = set(
  'bandPosition tickBand tickOffset tickSize gridScale labelFlush labelFlushOffset labelOffset labelPadding symbolOffset columns gradientLength',
)

// -- the size of the symbols of a legend -----------------------------------------------------------------------------------------

/**
 * The entry a mark's encode blocks give a channel: what vega reads of the `update` block first and the `enter` block next, as a
 * signal's text or a value. `undefined` when the channel is in neither.
 */
function encoded(channel: string, blocks: Rec | undefined): unknown {
  const entry = (isRecord(blocks?.update) && (blocks.update as Rec)[channel]) || (isRecord(blocks?.enter) && (blocks.enter as Rec)[channel]) || undefined
  return entry && (entry as Rec).signal ? (entry as Rec).signal : entry ? (entry as Rec).value : null
}

/**
 * The expression that tells a symbol legend how big its entries are: `max(ceil(sqrt(<size>)+<stroke width>),<font size>)`, where
 * the size and the stroke width are those of the symbols (the author's encode over the legend's own properties and its config) or
 * `scale("<name>",datum)` when the legend has a scale for the channel, and the font size that of the labels. vega parses it as soon
 * as the legend's entries are made, before any of its marks.
 */
export function legendSizeExpression(l: Rec, env: GuideEnv): string {
  const config = isRecord(env.config.legend) ? (env.config.legend as Rec) : {}
  const encode = isRecord(l.encode) ? (l.encode as Rec) : {}
  // a property is an entry of `update` when it is an object (a signal), a value of `enter` otherwise; the author's encode replaces it
  const own = (name: string): unknown => (l[name] != null ? l[name] : config[name])
  const base = (channel: string, name: string): Rec => {
    const v = own(name)
    return v == null ? {} : v !== null && typeof v === 'object' && (!Array.isArray(v) || (v.length > 0 && v[0] !== null && typeof v[0] === 'object')) ? { update: { [channel]: v } } : { enter: { [channel]: { value: v } } }
  }
  const merged = (defaults: Rec, user: unknown): Rec => {
    const out: Rec = { enter: { ...(defaults.enter as Rec) }, update: { ...(defaults.update as Rec) } }
    if (isRecord(user)) for (const block of ['enter', 'update'] as const) if (isRecord(user[block])) Object.assign(out[block] as Rec, user[block])
    return out
  }
  const text = (v: unknown): string => String(v !== null && typeof v === 'object' && (v as Rec).signal ? (v as Rec).signal : v)
  const symbols = merged(
    { enter: { ...(base('size', 'symbolSize').enter as Rec), ...(base('strokeWidth', 'symbolStrokeWidth').enter as Rec) }, update: { ...(base('size', 'symbolSize').update as Rec), ...(base('strokeWidth', 'symbolStrokeWidth').update as Rec) } },
    encode.symbols,
  )
  const labels = merged(base('fontSize', 'labelFontSize'), encode.labels)
  const size = l.size ? `scale("${String(l.size)}",datum)` : text(encoded('size', symbols))
  const stroke = l.strokeWidth ? `scale("${String(l.strokeWidth)}",datum)` : text(encoded('strokeWidth', symbols))
  const style = isRecord(env.config.style) && isRecord((env.config.style as Rec)['guide-label']) ? ((env.config.style as Rec)['guide-label'] as Rec).fontSize : undefined
  const font = text(encoded('fontSize', labels) || style)
  return `max(ceil(sqrt(${size})+${stroke}),${font})`
}

/**
 * The layout of the entries of a symbol legend, as the object vega writes out as one expression: the alignment of the grid, the
 * number of columns and the padding between rows and columns (the author's, else the config's).
 */
export function legendLayout(l: Rec, env: GuideEnv): Rec {
  const config = isRecord(env.config.legend) ? (env.config.legend as Rec) : {}
  const own = (name: string, fallback?: unknown): unknown => (l[name] != null ? l[name] : config[name] != null ? config[name] : fallback)
  const direction = own('direction', config.symbolDirection)
  return {
    align: own('gridAlign'),
    columns: l.columns != null ? l.columns : config.columns != null ? config.columns : +(direction === 'vertical'),
    center: { row: true, column: false },
    padding: { row: own('rowPadding'), column: own('columnPadding') },
  }
}
