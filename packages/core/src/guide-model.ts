/**
 * Which properties of an axis, a legend and the title vega reads as expressions, and how. An axis, a legend and a title are not
 * parsed as they are written: vega-parser turns each into marks (an axis into a grid, ticks, labels, a domain line and a title; a
 * symbol legend into symbols and labels, a gradient into a bar and labels), and a property of the guide is only read by the mark it
 * belongs to. A property of a mark the guide does not have, one a scale's channel or the author's encode replaces, or one that only
 * switches a feature on (`grid`, `labels`) is never parsed, so an expression in it that vega would refuse is accepted.
 *
 * What is read is one of:
 * - an `entry`: the signal is the entry of a channel of one of the marks, whose expression is the signal in parentheses;
 * - a `value`: the signal is read on its own, as the parameter of the guide's data (`tickMinStep`, `symbolLimit`, ...);
 * - an `object`: a list or an object whose parts may be signals (`values`, `tickCount`);
 * - a part of the `layout` of the entries of a symbol legend, an object vega writes out as one expression;
 * - nothing.
 *
 * The properties of a mark begin alike (`grid*`, `tick*`, `label*`, `domain*`, `title*`, `symbol*`, `gradient*`), which is how they
 * are told apart; the few that do not follow the rule are named.
 *
 * Not reproduced: the longer text vega writes around a few of the entries when it is the author's text that is wrong in them
 * (`WRAPPED`: the positions of a band, the offsets of labels and ticks, the flush of labels, the symbol offset, the entry columns,
 * the length of a gradient). They are read, and quoted by themselves. The size and the layout of a symbol legend are written out.
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

/** The guide properties whose expression vega quotes inside a longer text; they are read, and quoted by themselves (see above). */
export const WRAPPED = /^(bandPosition|tickBand|tickOffset|tickSize|gridScale|labelFlush|labelFlushOffset|labelOffset|labelPadding|symbolOffset|columns|gradientLength)$/

// -- an axis -------------------------------------------------------------------------------------------------------------------

/** Properties that only switch a feature on, or that vega keeps for itself. */
const AXIS_NEVER = /^(aria|description|zindex|domain|grid|labels|ticks|tickRound)$/
/** Properties of the axis itself, whatever marks it has. */
const AXIS_GROUP = /^(orient|offset|position|titlePadding|minExtent|maxExtent|translate|title|format|formatType)$/
/** The beginning of a property that belongs to a mark of the axis, and the feature that makes it. */
const AXIS_MARK = /^(grid|tick|label|domain|title)/
const AXIS_FEATURE: Readonly<Record<string, string>> = { grid: 'grid', tick: 'ticks', label: 'labels', domain: 'domain', title: 'title' }

/** How an axis's properties are read, given the marks it has: what is asked is worked out when it is, once. */
class AxisReading {
  private flags: Record<string, boolean | undefined> = {}
  constructor(private readonly a: Rec, private readonly env: GuideEnv) {}

  private has(name: string): unknown { return axisValue(this.a, name, this.env.scaleType, this.env.config) }

  /** whether the axis has the feature (`grid`, `ticks`, `labels`, `domain`, `title`) */
  private on(feature: string): boolean {
    if (feature === 'title') return this.a.title != null
    return (this.flags[feature] ??= !!this.has(feature))
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
    if (AXIS_NEVER.test(key)) return 'never'
    if (key === 'tickCount' || key === 'values') return 'object'
    if (AXIS_GROUP.test(key)) return 'entry'
    if (key === 'tickMinStep') return 'value'
    if (key === 'tickExtra') return this.band() === 'none' ? 'value' : 'never'
    if (key === 'labelBound' || key === 'labelOverlap') return this.on('labels') ? 'value' : 'never'
    if (key === 'labelSeparation') return this.on('labels') && (!!this.has('labelOverlap') || !!this.has('labelBound')) ? 'value' : 'never'
    if (key === 'labelFlush' || key === 'labelFlushOffset') return this.flushRead() ? 'entry' : 'never'
    if (key === 'gridScale') return this.on('grid') ? 'entry' : 'never'
    if (key === 'tickBand') return 'entry'
    if (key === 'bandPosition') return this.band() === 'none' && (this.on('grid') || this.on('ticks')) ? 'entry' : 'never'
    if (key === 'tickOffset') return this.band() !== 'extent' && (this.on('grid') || this.on('ticks') || this.on('labels')) ? 'entry' : 'never'
    const mark = AXIS_MARK.exec(key)
    return mark && !this.on(AXIS_FEATURE[mark[1]!]!) ? 'never' : 'entry'
  }
}

// -- a legend ------------------------------------------------------------------------------------------------------------------

const LEGEND_NEVER = /^(aria|description|type|direction|zindex)$/
const LEGEND_GROUP = /^(orient|offset|padding|titlePadding|cornerRadius|fillColor|strokeColor|legendX|legendY|format|formatType)$/
/** The channel of the labels' encode, or of the symbols', that replaces a property (`labelColor` is the `fill` of the labels). */
const LABEL_CHANNEL: Readonly<Record<string, string>> = {
  Color: 'fill', Font: 'font', FontSize: 'fontSize', FontStyle: 'fontStyle', FontWeight: 'fontWeight', Limit: 'limit', Opacity: 'fillOpacity', Align: 'align', Baseline: 'baseline',
}
const SYMBOL_CHANNEL: Readonly<Record<string, string>> = {
  Type: 'shape', Size: 'size', Opacity: 'opacity', FillColor: 'fill', StrokeColor: 'stroke', StrokeWidth: 'strokeWidth', Dash: 'strokeDash', DashOffset: 'strokeDashOffset',
}

/** Whether the encode of a part sets a channel in its `enter` or `update` block. */
const sets = (part: unknown, channel: string): boolean =>
  isRecord(part) && ['enter', 'update'].some((block) => isRecord(part[block]) && (part[block] as Rec)[channel] != null)

/** How a legend's properties are read. */
function legendReading(l: Rec, env: GuideEnv): (key: string) => Reading {
  const symbols = legendType(l, env.scaleType(LEGEND_CHANNELS.map((c) => l[c]).find((s) => !!s))) === 'symbol'
  const encode = isRecord(l.encode) ? l.encode : {}
  return (key) => {
    if (LEGEND_NEVER.test(key)) return 'never'
    if (key === 'tickCount' || key === 'values') return 'object'
    if (key === 'symbolLimit' || key === 'tickMinStep') return 'value'
    if (LEGEND_GROUP.test(key)) return 'entry'
    if (key.startsWith('title')) return l.title != null ? 'entry' : 'never'
    if (key.startsWith('gradient')) return symbols ? 'never' : 'entry'
    if (key === 'labelOverlap' || key === 'labelSeparation') {
      const overlap = l.labelOverlap != null ? l.labelOverlap : isRecord(env.config.legend) ? env.config.legend.labelOverlap : undefined
      return symbols || !overlap ? 'never' : 'value'
    }
    if (key.startsWith('label')) {
      const channel = LABEL_CHANNEL[key.slice(5)]
      // (a symbol legend aligns its labels itself; the others do not take `labelAlign` or `labelBaseline`)
      if (!symbols && (channel === 'align' || channel === 'baseline')) return 'never'
      return channel !== undefined && sets(encode.labels, channel) ? 'never' : 'entry'
    }
    if (key.startsWith('symbol') || key === 'clipHeight') {
      if (!symbols) return 'never'
      const channel = SYMBOL_CHANNEL[key.slice(6)]
      // the legend's scale for the channel, or the author's encode of it, replaces the property
      return channel !== undefined && (l[channel] || sets(encode.symbols, channel)) ? 'never' : 'entry'
    }
    if (key === 'columns') return symbols ? 'entry' : 'never'
    if (key === 'gridAlign' || key === 'columnPadding' || key === 'rowPadding') return symbols ? 'layout' : 'never'
    return 'entry'
  }
}

// -- the title -----------------------------------------------------------------------------------------------------------------

/** How the title's properties are read. */
function titleReading(t: Rec): (key: string) => Reading {
  return (key) => (/^(aria|description|zindex)$/.test(key) || (/^subtitle/.test(key) && key !== 'subtitlePadding' && !t.subtitle) ? 'never' : 'entry')
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

// -- the size of the symbols of a legend ---------------------------------------------------------------------------------------

/** What the encode blocks give a channel: the text of a signal, or the value, read from `update` first and `enter` next. */
function encoded(channel: string, blocks: Rec): unknown {
  const entry = (isRecord(blocks.update) && (blocks.update as Rec)[channel]) || (isRecord(blocks.enter) && (blocks.enter as Rec)[channel]) || undefined
  return entry && (entry as Rec).signal ? (entry as Rec).signal : entry ? (entry as Rec).value : null
}

/**
 * The expression that tells a symbol legend how big its entries are: `max(ceil(sqrt(<size>)+<stroke width>),<font size>)`, where
 * the size and the stroke width are those of the symbols (the author's encode over the legend's own properties and its config) or
 * `scale("<name>",datum)` when the legend has a scale for the channel, and the font size that of the labels. vega parses it as soon
 * as the legend's entries are made, before any of its marks.
 */
export function legendSizeExpression(l: Rec, env: GuideEnv): string {
  const config = isRecord(env.config.legend) ? env.config.legend : {}
  const encode = isRecord(l.encode) ? l.encode : {}
  /**
   * What a mark's encode holds for the channels given, from the legend's property of each (the author's, else the config's) and
   * then the author's own encode of the mark: a property that is an object (a signal) is an entry of `update`, any other value one of `enter`.
   */
  const blocks = (channels: Array<[channel: string, property: string]>, user: unknown): Rec => {
    const out: Rec = { enter: {}, update: {} }
    for (const [channel, property] of channels) {
      const v = l[property] != null ? l[property] : config[property]
      if (v == null) continue
      if (typeof v === 'object' && (!Array.isArray(v) || (v.length > 0 && v[0] !== null && typeof v[0] === 'object'))) (out.update as Rec)[channel] = v
      else (out.enter as Rec)[channel] = { value: v }
    }
    if (isRecord(user)) for (const block of ['enter', 'update']) if (isRecord(user[block])) Object.assign(out[block] as Rec, user[block])
    return out
  }
  const text = (v: unknown): string => String(v !== null && typeof v === 'object' && (v as Rec).signal ? (v as Rec).signal : v)
  const symbols = blocks([['size', 'symbolSize'], ['strokeWidth', 'symbolStrokeWidth']], encode.symbols)
  const labels = blocks([['fontSize', 'labelFontSize']], encode.labels)
  const size = l.size ? `scale("${String(l.size)}",datum)` : text(encoded('size', symbols))
  const stroke = l.strokeWidth ? `scale("${String(l.strokeWidth)}",datum)` : text(encoded('strokeWidth', symbols))
  const style = isRecord(env.config.style) && isRecord(env.config.style['guide-label']) ? env.config.style['guide-label'].fontSize : undefined
  return `max(ceil(sqrt(${size})+${stroke}),${text(encoded('fontSize', labels) || style)})`
}

/**
 * The layout of the entries of a symbol legend, as the object vega writes out as one expression: the alignment of the grid, the
 * number of columns and the padding between rows and columns (the author's, else the config's).
 */
export function legendLayout(l: Rec, env: GuideEnv): Rec {
  const config = isRecord(env.config.legend) ? env.config.legend : {}
  const own = (name: string): unknown => (l[name] != null ? l[name] : config[name])
  const direction = l.direction != null ? l.direction : config.direction || config.symbolDirection
  return {
    align: own('gridAlign'),
    columns: own('columns') ?? +(direction === 'vertical'),
    center: { row: true, column: false },
    padding: { row: own('rowPadding'), column: own('columnPadding') },
  }
}
