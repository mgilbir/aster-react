/**
 * An axis: five marks (grid lines, ticks, labels, the domain line, the title) encoded from the spec and the config, and a group
 * item whose channels are the layout's parameters. Building one evaluates the marks against the scale's ticks, thins out the
 * labels that collide, then places the axis against the frame from the extent of what was drawn. See guide-encode.ts for how a
 * property becomes a channel of an item.
 *
 * An axis has two directions and two sides, and its marks are written once for them: `Frame` says whether it runs along x or y
 * and which side of the plot it faces, and each mark names its position channels by the role they play (along the axis, across
 * it) instead of by orientation.
 */
import type { EncodeValue, SceneItem } from './types.js'
import { lerp, sortData } from './util.js'
import { Bounds, boundLeaf, boundStroke, multiLineOffset } from './bounds.js'
import {
  ONE, ZERO, contentKey, customize, encodeItem, encodeItems, encodes, entryOf, isShareable, isSignal, joinByValue, keyPart, mergeUserEncode,
  propsOf, setChannels, shareMarks, sharedMarks,
  type Block, type Entry, type EntryFn, type EntryHost, type EntryScope, type GuideMarkDef, type GuideProps, type GuideStyles, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is object => v === Object(v)

// --- which way an axis runs --------------------------------------------------------------------------------------------------

interface Frame {
  /** Runs along x (a top or bottom axis); otherwise along y. */
  horizontal: boolean
  /** -1 when it faces the top or the left of the plot, else 1: the sign of "outward" in the axis's own coordinates. */
  facing: 1 | -1
  /** The position channel along the axis, and the one across it. */
  along: 'x' | 'y'
  across: 'x' | 'y'
}

function frameOf(orient: string): Frame {
  const horizontal = orient === 'top' || orient === 'bottom'
  return { horizontal, facing: orient === 'top' || orient === 'left' ? -1 : 1, along: horizontal ? 'x' : 'y', across: horizontal ? 'y' : 'x' }
}

/** Where on the axis the ticks sit within a band of the scale, and the offset that goes with it. */
export interface TickPlacement {
  band: unknown
  extra: unknown
  offset: unknown
}

/**
 * A tick sits in the middle of its band (`center`), at the band's start with one more tick at the end (`extent`), or wherever
 * `bandPosition` and `tickExtra` say. A `tickBand` that is a signal picks between the first two as the signal changes.
 */
export function tickPlacement(props: GuideProps): TickPlacement {
  const mode = props.get('tickBand')
  let offset: unknown = props.get('tickOffset')
  if (!mode) return { band: props.get('bandPosition'), extra: props.get('tickExtra'), offset }
  if (isSignal(mode)) {
    const extent = `(${mode.signal}) === 'extent'`
    if (!isObj(offset)) offset = { signal: `${extent} ? 0 : ${offset}` }
    return { band: { signal: `${extent} ? 1 : 0.5` }, extra: { signal: extent }, offset }
  }
  return mode === 'extent' ? { band: 1, extra: true, offset: 0 } : { band: 0.5, extra: false, offset }
}

/** An entry that adds `extra` to the offset an entry already has. */
function addOffset(entry: unknown, extra: unknown): unknown {
  if (!extra) return entry
  if (!entry) return extra
  if (!isObj(entry)) return { value: entry, offset: extra }
  return { ...entry, offset: addOffset((entry as Rec).offset, extra) }
}

/** An expression's text if the value is a signal, else the value. */
const textOf = (v: unknown): unknown => (isSignal(v) ? v.signal : v)

/**
 * Which of three values a position takes by how close it lies to the ends of the range: `atStart` within `threshold` of the first
 * end (and nearer to it), `atEnd` within `threshold` of the other, `between` otherwise.
 */
function byRangeEnd(range: readonly number[], position: number, threshold: unknown, atStart: unknown, atEnd: unknown, between: unknown): unknown {
  if (!threshold && threshold !== 0) return between
  const limit = +(threshold as number)
  let lo = range[0] as number
  let hi = range[range.length - 1] as number | undefined
  if (hi === undefined) return between
  if (hi < lo) [lo, hi] = [hi, lo]
  const fromLo = Math.abs(position - lo)
  const fromHi = Math.abs(hi - position)
  return fromLo < fromHi && fromLo <= limit ? atStart : fromHi <= limit ? atEnd : between
}

// --- the marks --------------------------------------------------------------------------------------------------------------

/** What each mark of an axis is made from. */
interface Kit {
  spec: Rec
  props: GuideProps
  frame: Frame
  orient: string
  scale: string
  /** the orient the overlap removal bounds the labels by: what a signal holds is not a side, so the axis is bounded as a vertical one */
  boundOrient: string
  band: TickPlacement
  user: Record<string, UserEncode | undefined>
}

const freshEncode = (): MarkEncode => ({ enter: { opacity: ZERO }, update: { opacity: ONE }, exit: { opacity: ZERO } })

/** Both blocks get the same entry (the channel is static, or its entry does not care which block it is in). */
function both(encode: MarkEncode, channel: string, entry: unknown): void {
  if (entry !== undefined) encode.enter[channel] = encode.update[channel] = entry as Entry
}

/** The stroke properties of a mark that draws a line (`prefix` + Color, Cap, Dash, DashOffset, Opacity, Width). */
function strokeChannels(k: Kit, prefix: string): Rec {
  const get = (suffix: string): unknown => k.props.get(prefix + suffix)
  return {
    stroke: get('Color'), strokeCap: get('Cap'), strokeDash: get('Dash'), strokeDashOffset: get('DashOffset'),
    strokeOpacity: get('Opacity'), strokeWidth: get('Width'),
  }
}

/** A tick's or a grid line's position along the axis: the scale's position of its value, within its band. */
function tickPosition(k: Kit): EncodeValue {
  return { scale: k.scale, field: 'value', band: k.band.band, extra: k.band.extra, offset: k.band.offset, round: k.props.get('tickRound') } as unknown as EncodeValue
}

function ticks(k: Kit, size: unknown): GuideMarkDef {
  const { frame } = k
  const encode = freshEncode()
  setChannels(encode, strokeChannels(k, 'tick'))
  // a tick reaches out from the axis line by the tick size
  const reach = { ...entryOf(size), mult: frame.facing } as unknown as EncodeValue
  both(encode, frame.across, ZERO)
  both(encode, frame.across + '2', reach)
  both(encode, frame.along, tickPosition(k))
  return customize({ type: 'rule', role: 'axis-tick', encode, interactive: false }, k.user.ticks)
}

/** A grid line's offset for an axis that faces `facing`: the lines run the other way, so the offset's sign flips. */
function signedOffset(offset: unknown, sign: number): unknown {
  if (sign === 1) return offset
  if (!isObj(offset)) return sign * ((offset as number) || 0)
  // an entry: its innermost `mult` (or a new one) takes the sign
  const copy: Rec = { ...(offset as Rec) }
  let at = copy
  while (at.mult != null) {
    if (!isObj(at.mult)) {
      at.mult = (at.mult as number) * sign
      return copy
    }
    at = at.mult = { ...(at.mult as Rec) }
  }
  at.mult = sign
  return copy
}

function grid(k: Kit): GuideMarkDef {
  const { spec, frame } = k
  const alongScale = spec.gridScale
  // grid lines run across the plot, against the way the ticks point
  const inward = -frame.facing
  const offset = signedOffset(spec.offset, inward)
  const encode = freshEncode()
  setChannels(encode, strokeChannels(k, 'grid'))
  // the lines end at the plot's far side: the view's size, so that a nested group's axes grid as far as the whole view
  const reachView = (extent: 'width' | 'height'): Entry => {
    const fn = ((s: EntryScope) => {
      const reach = s.host.viewSignal(extent) * inward
      return offset == null ? reach : reach + Number(s.host.entry(isObj(offset) ? (offset as EncodeValue) : ({ value: offset } as EncodeValue), s.datum))
    }) as EntryFn
    // an offset that is an entry may read the datum; a number is the same for every line
    fn.perRun = offset == null || !isObj(offset)
    return fn
  }
  const start = (alongScale ? { scale: alongScale, range: 0, mult: inward, offset } : { value: 0, offset }) as unknown as EncodeValue
  const end: Entry = alongScale ? ({ scale: alongScale, range: 1, mult: inward, offset } as unknown as EncodeValue) : reachView(frame.horizontal ? 'height' : 'width')
  both(encode, frame.along, tickPosition(k))
  both(encode, frame.across, start)
  both(encode, frame.across + '2', end)
  return customize({ type: 'rule', role: 'axis-grid', encode, interactive: false }, k.user.grid)
}

function domain(k: Kit): GuideMarkDef {
  const { frame, scale } = k
  const encode = freshEncode()
  const get = (suffix: string): unknown => k.props.get('domain' + suffix)
  setChannels(encode, { stroke: get('Color'), strokeCap: get('Cap'), strokeDash: get('Dash'), strokeDashOffset: get('DashOffset'), strokeWidth: get('Width'), strokeOpacity: get('Opacity') })
  // the line runs the scale's range, along the plot's edge
  both(encode, frame.along, { scale, range: 0 })
  both(encode, frame.along + '2', { scale, range: 1 })
  both(encode, frame.across, ZERO)
  return customize({ type: 'rule', role: 'axis-domain', encode, interactive: false }, k.user.domain)
}

function labels(k: Kit, size: unknown): GuideMarkDef {
  const { frame, props, scale, orient } = k
  const flush = textOf(props.get('labelFlush'))
  const flushDistance = textOf(props.get('labelFlushOffset'))
  const labelAlign = props.get('labelAlign')
  const labelBaseline = props.get('labelBaseline')
  const flushing = flush === 0 || !!flush

  // a label sits past the end of the tick by the label padding
  const distance = { ...entryOf(size), mult: frame.facing, offset: { ...entryOf(props.get('labelPadding') || 0), mult: frame.facing } } as unknown as EncodeValue
  const position = { scale, field: 'value', band: 0.5, offset: addOffset(k.band.offset, props.get('labelOffset')) } as unknown as EncodeValue

  // the end labels of an axis can be pulled in (flush) by shifting their alignment, or (flushDistance) their position
  const nearEnds = (atStart: string, atEnd: string, between: string, threshold: unknown = flush): EntryFn => (s) => {
    const sc = s.host.scale(scale)
    const range = (sc ? sc.range() : []) as number[]
    const at = sc ? (sc(s.datum.value) as number) : NaN
    const value = (code: string): unknown => s.host.expr(code)
    return byRangeEnd(range, at, value(String(threshold)), value(atStart), value(atEnd), value(between))
  }
  const align: Entry = frame.horizontal
    ? (flushing ? nearEnds('"left"', '"right"', '"center"') : { value: 'center' } as EncodeValue)
    : { value: orient === 'right' ? 'left' : 'right' } as EncodeValue
  const baseline: Entry = frame.horizontal
    ? { value: orient === 'top' ? 'bottom' : 'top' } as EncodeValue
    : (flushing ? nearEnds('"top"', '"bottom"', '"middle"') : { value: 'middle' } as EncodeValue)
  const nudge = nearEnds(`-(${String(flushDistance)})`, String(flushDistance), '0')
  const nudging = flushing && !!flushDistance

  const enter: Block = { opacity: ZERO }
  enter[frame.along] = position
  enter[frame.across] = distance
  const update: Block = { opacity: ONE, text: { field: 'label' } as EncodeValue, x: enter.x, y: enter.y, align, baseline }
  const encode: MarkEncode = { enter, update, exit: { opacity: ZERO, x: enter.x, y: enter.y } }
  // only labels whose alignment the spec leaves alone are shifted
  setChannels(encode, {
    [frame.horizontal ? 'dx' : 'dy']: (frame.horizontal ? !labelAlign : !labelBaseline) && nudging ? nudge : null,
  })
  setChannels(encode, {
    angle: props.get('labelAngle'), fill: props.get('labelColor'), fillOpacity: props.get('labelOpacity'), font: props.get('labelFont'),
    fontSize: props.get('labelFontSize'), fontWeight: props.get('labelFontWeight'), fontStyle: props.get('labelFontStyle'),
    limit: props.get('labelLimit'), lineHeight: props.get('labelLineHeight'),
  }, { align: labelAlign, baseline: labelBaseline })

  const mark = customize({ type: 'text', role: 'axis-label', style: 'guide-label', encode, interactive: false }, k.user.labels)
  const overlap = props.get('labelOverlap')
  const bound = props.get('labelBound')
  if (overlap || bound) {
    mark.overlap = { separation: props.get('labelSeparation'), method: overlap, order: 'datum.index', bound: bound ? { scale, orient: k.boundOrient, tolerance: bound } : null }
  }
  return mark
}

function title(k: Kit): GuideMarkDef {
  const { spec, frame, props, scale } = k
  const user = k.user.title
  const anchorSide = (item: Rec, start: string, end: string, middle: string): string => (item.anchor === 'start' ? start : item.anchor === 'end' ? end : middle)
  const enter: Block = {
    opacity: ZERO,
    anchor: entryOf(props.get('titleAnchor', null)) as EncodeValue,
    align: (s) => anchorSide(s.item, 'left', 'right', 'center'),
  }
  const update: Block = { ...enter, opacity: ONE, text: entryOf(spec.title) as EncodeValue }
  const encode: MarkEncode = { enter, update, exit: { opacity: ZERO } }

  // along the axis the title sits at its anchor on the scale's range
  update[frame.along] = (s: EntryScope) => {
    const sc = s.host.scale(scale)
    const range = (sc ? sc.range() : []) as number[]
    return lerp(range, s.item.anchor === 'start' ? 0 : s.item.anchor === 'end' ? 1 : 0.5)
  }
  // a title beside a vertical axis is turned to read along it, facing outward
  enter.angle = frame.horizontal ? ZERO : ({ value: frame.facing * 90 } as EncodeValue)
  enter.baseline = frame.horizontal ? ({ value: k.orient === 'top' ? 'bottom' : 'top' } as EncodeValue) : ({ value: 'bottom' } as EncodeValue)
  update.angle = enter.angle
  update.baseline = enter.baseline

  setChannels(encode, {
    fill: props.get('titleColor'), fillOpacity: props.get('titleOpacity'), font: props.get('titleFont'), fontSize: props.get('titleFontSize'),
    fontStyle: props.get('titleFontStyle'), fontWeight: props.get('titleFontWeight'), limit: props.get('titleLimit'), lineHeight: props.get('titleLineHeight'),
  }, { align: props.get('titleAlign'), angle: props.get('titleAngle'), baseline: props.get('titleBaseline') })

  // the layout places the title across the axis unless the spec pins that position (titleX / titleY, or an x / y of the user's)
  const free = (pinned: unknown, channel: 'x' | 'y'): boolean => {
    if (pinned != null) {
      update[channel] = entryOf(pinned) as EncodeValue
      return false
    }
    return !encodes(channel, { enter: (user?.enter ?? {}) as Block, update: (user?.update ?? {}) as Block })
  }
  const freeX = free(props.get('titleX'), 'x')
  const freeY = free(props.get('titleY'), 'y')
  enter.auto = entryOf(frame.horizontal ? freeY : freeX) as EncodeValue
  return customize({ type: 'text', role: 'axis-title', style: 'guide-title', encode, interactive: false }, user)
}

/** The axis group's own channels, which the layout reads: where it goes, how far its content may reach, how long it is. */
function groupEncode(k: Kit): MarkEncode {
  const { spec, props, scale } = k
  const encode: MarkEncode = { enter: {}, update: {} }
  const length: EntryFn = (s) => {
    const sc = s.host.scale(scale)
    const range = (sc ? sc.range() : []) as number[]
    return Math.abs((range && range[range.length - 1]! - range[0]!) || 0)
  }
  setChannels(encode, {
    orient: k.orient, offset: props.get('offset') || 0, position: spec.position ?? 0, titlePadding: props.get('titlePadding'),
    minExtent: props.get('minExtent'), maxExtent: props.get('maxExtent'), range: length, translate: props.get('translate'),
    format: spec.format, formatType: spec.formatType,
  })
  return mergeUserEncode(encode, k.user.axis)
}

// --- thinning out labels that collide ------------------------------------------------------------------------------------------

export interface OverlapSpec {
  separation?: unknown
  method?: unknown
  order?: string
  bound?: { scale: string; orient: string; tolerance: unknown } | null
}

/** Do two boxes come closer than `gap`? */
const closerThan = (a: Bounds, b: Bounds, gap: number): boolean => gap > Math.max(b.x1 - a.x2, a.x1 - b.x2, b.y1 - a.y2, a.y1 - b.y2)
const contains = (a: Bounds, b: Bounds): boolean => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2
const ascending = (a: unknown, b: unknown): number => ((a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0)

/**
 * Hide (opacity 0) the items whose boxes collide until no two neighbours do, always leaving the last one shown; items outside the
 * range of the bound's scale are hidden too. The method is `greedy` (keep an item only if it clears the last one kept) or, for
 * anything else, `parity` (keep every other one). Items with no content to speak of (a box 1px across or less) take no part.
 * Returns the bounds of what is left shown, or null when there was nothing to decide.
 */
export function thinOverlaps(items: SceneItem[], data: Row[], o: OverlapSpec, host: EntryHost, boxOf: (it: SceneItem) => Bounds): Bounds | null {
  const boxes = new Map<SceneItem, Bounds>()
  const box = (it: SceneItem): Bounds => {
    let b = boxes.get(it)
    if (!b) boxes.set(it, (b = boxOf(it)))
    return b
  }
  const method = (isSignal(o.method) ? host.expr(o.method.signal) : o.method) as string
  const gap = +((isSignal(o.separation) ? host.expr(o.separation.signal) : o.separation) as number) || 0
  if (!items.length || !method) return null

  let shown = items.map((it, i) => ({ it, datum: data[i] })).filter(({ it }) => box(it).width() > 1 && box(it).height() > 1)
  if (!shown.length) return null
  if (o.order) shown = sortData(shown.slice(), (a, b) => ascending(a.datum?.index, b.datum?.index))
  const order = shown.map((s) => s.it)
  for (const it of order) it.opacity = 1

  const collides = (list: SceneItem[]): boolean => {
    for (let i = 1; i < list.length; i++) if (closerThan(box(list[i - 1]!), box(list[i]!), gap)) return true
    return false
  }
  const thin = (list: SceneItem[]): SceneItem[] => {
    if (method === 'greedy') {
      let kept: SceneItem | undefined
      return list.filter((it, i) => {
        if (i && closerThan(box(kept!), box(it), gap)) {
          it.opacity = 0
          return false
        }
        kept = it
        return true
      })
    }
    return list.filter((it, i) => {
      if (i % 2) it.opacity = 0
      return !(i % 2)
    })
  }
  let kept = order
  if (kept.length >= 3 && collides(kept)) {
    do kept = thin(kept)
    while (kept.length >= 3 && collides(kept))
    // the last label is the one a reader looks for: if thinning hid it, it comes back and the one before it goes
    const last = order[order.length - 1]!
    if (kept.length < 3 && !last.opacity) {
      if (kept.length > 1) kept[kept.length - 1]!.opacity = 0
      last.opacity = 1
    }
  }

  const bound = o.bound
  if (bound) {
    const tolerance = isSignal(bound.tolerance) ? host.expr(bound.tolerance.signal) : bound.tolerance
    if ((tolerance as number) >= 0) {
      const sc = host.scale(bound.scale)
      const range = (sc ? sc.range() : []) as number[]
      const within = new Bounds()
      if (bound.orient === 'top' || bound.orient === 'bottom') within.set(range[0]!, -Infinity, range[1]!, Infinity)
      else within.set(-Infinity, range[0]!, Infinity, range[1]!)
      within.expand(+(tolerance as number) || 1)
      for (const it of order) if (!contains(within, box(it))) it.opacity = 0
    }
  }
  const out = new Bounds()
  for (const it of order) if (it.opacity) out.union(box(it))
  return out
}

// --- building an axis ---------------------------------------------------------------------------------------------------------

export interface AxisBuildInput {
  spec: Rec
  cfg: Rec
  scale: string
  orient: string
  /** the orient is the value of a signal (the config it picks up and the label bounds are read as for no known side) */
  orientSignal?: boolean
  encode: Record<string, UserEncode | undefined>
  /** the AxisTicks tuples: `{index, tickIndex, value, label}`, plus the `extra` entry */
  ticks: Row[]
  /** the tuples' values are known to differ (the scale's own ticks, not a list the spec gave): the keyed join is the identity */
  distinctTicks?: boolean
  /** where the marks of the axis are kept between evaluations, and whether to keep them (see runtime.ts chartGuides) */
  store?: Map<object, unknown>
  keep?: boolean
  /** the frame the axis sits on */
  width: number
  height: number
  /** the layout never ran: the group stays where its encode put it */
  raw: boolean
  host: EntryHost
  style: GuideStyles
}

export interface AxisBuilt {
  /** the leaves of every mark, in the axis group's frame moved to the view frame (the scene draws them inside the group) */
  leaves: SceneItem[]
  /** which marks the axis has, in paint order */
  parts: string[]
  /** the user's names and interactivity per part (`axis` is the group) */
  partMeta: Record<string, { name?: string; interactive: boolean }>
  /** the axis group item as encoded and laid out */
  group: Rec
  /** the axis mark's bounds after layout, in the parent frame */
  bounds: Bounds
  /** the data the axis group was made from (`datum.ticks` ...) */
  datum: Row
}

type PartName = 'grid' | 'tick' | 'label' | 'domain' | 'title'

/** The marks an axis has: decided by its spec and the config alone (what a signal holds is read when the entries are evaluated). */
interface AxisDefs {
  cfg: Rec
  orient: string
  orientSignal: boolean
  scale: string
  encode: Record<string, UserEncode | undefined>
  flags: { ticks: boolean; labels: boolean; grid: boolean; domain: boolean; title: boolean }
  parts: Array<{ part: PartName; def: GuideMarkDef; onTicks: boolean }>
  groupDef: GuideMarkDef
}

function defineAxis(inp: AxisBuildInput): AxisDefs {
  const { spec, cfg, orient } = inp
  const props = propsOf(spec, cfg)
  const k: Kit = { spec, props, frame: frameOf(orient), orient, boundOrient: inp.orientSignal ? '' : orient, scale: inp.scale, band: tickPlacement(props), user: inp.encode }
  const flags = { ticks: !!props.get('ticks'), labels: !!props.get('labels'), grid: !!props.get('grid'), domain: !!props.get('domain'), title: spec.title != null }
  const parts: AxisDefs['parts'] = []
  if (flags.grid) parts.push({ part: 'grid', def: grid(k), onTicks: true })
  // labels start where the ticks end; without ticks, at the axis line
  const tickSize = flags.ticks ? props.get('tickSize') : 0
  if (flags.ticks) parts.push({ part: 'tick', def: ticks(k, tickSize), onTicks: true })
  if (flags.labels) parts.push({ part: 'label', def: labels(k, tickSize), onTicks: true })
  if (flags.domain) parts.push({ part: 'domain', def: domain(k), onTicks: false })
  if (flags.title) parts.push({ part: 'title', def: title(k), onTicks: false })
  const groupDef: GuideMarkDef = { type: 'rule', role: 'axis', style: inp.encode.axis?.style, encode: groupEncode(k), interactive: false }
  return { cfg, orient, orientSignal: !!inp.orientSignal, scale: inp.scale, encode: inp.encode, flags, parts, groupDef }
}

/** Charts that share a config nobody can change also share the marks of an axis with the same spec; so does an axis kept between evaluations. */
function axisDefs(inp: AxisBuildInput): AxisDefs {
  const { spec, cfg, orient } = inp
  const kept = inp.store?.get(spec) as AxisDefs | undefined
  if (kept !== undefined && kept.cfg === cfg && kept.orient === orient && kept.orientSignal === !!inp.orientSignal && kept.scale === inp.scale && kept.encode === inp.encode) return kept
  let shareKey: string | undefined
  if (isShareable(cfg)) {
    const specKey = contentKey(spec)
    const encodeKey = specKey === undefined ? undefined : contentKey(inp.encode)
    if (encodeKey !== undefined) shareKey = 'a' + (inp.orientSignal ? 's' : 'o') + keyPart(orient) + keyPart(inp.scale) + specKey + '|' + encodeKey
  }
  const shared = sharedMarks(shareKey) as AxisDefs | undefined
  let defs: AxisDefs
  if (shared !== undefined && shared.cfg === cfg) defs = shared
  else {
    defs = defineAxis(inp)
    shareMarks(shareKey, defs)
  }
  if (inp.keep) inp.store?.set(spec, defs)
  return defs
}

export function buildAxis(inp: AxisBuildInput): AxisBuilt {
  const { host, style } = inp
  const defs = axisDefs(inp)
  const datum: Row = { scale: inp.scale, ...defs.flags }
  const group = encodeItem(defs.groupDef, datum, {}, host, style) as unknown as Rec

  const leaves: SceneItem[] = []
  const extents = new Map<PartName, Bounds>()
  const partMeta: AxisBuilt['partMeta'] = {}
  let titleItem: (SceneItem & Rec) | undefined
  const boxOf = (it: SceneItem): Bounds => boundLeaf(new Bounds(), it)
  // the grid, the ticks and the labels are keyed by value over the same tuples: one join serves all three
  let joined: Row[] | undefined
  for (const { part, def, onTicks } of defs.parts) {
    let rows: Row[] = onTicks ? inp.ticks : [datum]
    if (part === 'grid' || part === 'tick' || part === 'label') {
      joined ??= inp.distinctTicks ? inp.ticks : joinByValue(inp.ticks)
      rows = joined
    }
    def.seed ??= { _kind: def.type === 'text' ? 'text' : 'rule', _part: part }
    const items = encodeItems(def, rows, group, host, style)
    let extent: Bounds | null = def.overlap ? thinOverlaps(items, rows, def.overlap, host, boxOf) : null
    // the layout reads the extent of the ticks, the labels and the title only: a grid of a thousand lines is not measured
    if (!extent && (part === 'tick' || part === 'label' || part === 'title')) {
      extent = new Bounds()
      const scratch = new Bounds()
      for (const it of items) extent.union(boundLeaf(scratch.clear(), it))
    }
    if (extent) extents.set(part, extent)
    partMeta[part] = { name: def.name, interactive: def.interactive }
    if (part === 'title') titleItem = items[0] as SceneItem & Rec
    for (const it of items) leaves.push(it)
  }
  const userAxis = inp.encode.axis
  partMeta.axis = { name: userAxis?.name ? String(userAxis.name) : undefined, interactive: !!userAxis?.interactive }

  const bounds = inp.raw ? new Bounds() : layoutAxis(group, titleItem, extents, inp.width, inp.height)

  // the leaves were made in the group's frame; the scene holds them in the view's
  const gx = (group.x as number) || 0
  const gy = (group.y as number) || 0
  if (gx || gy) {
    for (const it of leaves) {
      const r = it as Rec
      // an item is drawn at `x || 0`, so a NaN position is the group's origin
      r.x = ((r.x as number) || 0) + gx
      r.y = ((r.y as number) || 0) + gy
      if (r.x2 != null) r.x2 = (r.x2 as number) + gx
      if (r.y2 != null) r.y2 = (r.y2 as number) + gy
    }
  }
  return { leaves, parts: defs.parts.map((p) => p.part), partMeta, group, bounds, datum }
}

/**
 * Place the axis group against the frame and its title beyond the tick labels, and return the bounds the axis takes up. The reach
 * of the ticks and labels past the axis line (kept between `minExtent` and `maxExtent`) is how far out the title goes.
 */
function layoutAxis(group: Rec, titleItem: (SceneItem & Rec) | undefined, extents: Map<PartName, Bounds>, width: number, height: number): Bounds {
  const orient = group.orient as string
  const delta = (group.translate as number) ?? 0.5
  const length = group.range as number
  const offset = group.offset as number
  const position = (group.position as number) || 0
  const frame = frameOf(orient)
  const known = orient === 'top' || orient === 'bottom' || orient === 'left' || orient === 'right'

  const box = new Bounds()
  const tickBox = extents.get('tick')
  const labelBox = extents.get('label')
  if (tickBox) box.union(tickBox)
  if (labelBox) box.union(labelBox)

  let x = 0
  let y = 0
  if (known) {
    // how far the ticks and labels reach out of the axis line
    const edge = frame.horizontal ? (frame.facing < 0 ? -box.y1 : box.y2) : (frame.facing < 0 ? -box.x1 : box.x2)
    const reach = Math.max(group.minExtent as number, Math.min(group.maxExtent as number, edge))
    // the axis line and the box it takes up: across it from the line to `reach` out, and its length along
    const [from, to] = frame.facing < 0 ? [-reach, 0] : [0, reach]
    if (frame.horizontal) box.add(0, from).add(length, to)
    else box.add(from, 0).add(to, length)
    x = frame.horizontal ? position : frame.facing < 0 ? -offset : width + offset
    y = frame.horizontal ? (frame.facing < 0 ? -offset : height + offset) : position

    if (titleItem) {
      const tbox = extents.get('title')!
      // a multi-line title is moved out by its extra lines on every side but the bottom
      const lines = orient === 'bottom' ? 0 : multiLineOffset(titleItem)
      if (titleItem.auto) {
        const target = frame.facing * (reach + lines + (group.titlePadding as number))
        if (frame.horizontal) {
          const dy = ((titleItem.y as number) || 0) - (titleItem.y = target)
          tbox.translate(0, -dy)
        } else {
          const dx = ((titleItem.x as number) || 0) - (titleItem.x = target)
          tbox.translate(-dx, 0)
        }
      }
      box.union(tbox)
    }
  } else {
    // an axis with no known side is not laid out, and stays where its encode put it
    x = group.x as number
    y = group.y as number
  }
  boundStroke(box.translate(x, y), group as SceneItem)
  group.x = x + delta
  group.y = y + delta
  return box
}
