/**
 * An axis, as vega-parser builds it (parsers/axis.js, parsers/guides/axis-*.js) and vega-view-transforms lays it out
 * (layout/axis.js): five marks (grid, ticks, labels, domain, title) encoded from the spec and the config, an axis
 * group whose encode carries the layout parameters, the Overlap transform on the labels, and `axisLayout`, which
 * places the group and the title from the bounds of what was drawn. See guide-encode.ts for how a property reaches
 * an item.
 */
import type { SceneItem } from './types.js'
import { lerp } from './util.js'
import { Bounds, boundLeaf, boundStroke, multiLineOffset } from './bounds.js'
import {
  addEncoders, applyDefaults, encoder, encodeItem, encodeItems, extendEncode, getEncoding, guideMark, has, isSignal, joinByValue, lookup, one, value, zero,
  type Block, type Entry, type EntryFn, type EntryHost, type EntryScope, type GuideMarkDef, type GuideStyles, type Lookup, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'
import type { EncodeValue } from './types.js'

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is object => v === Object(v)

// --- guides/axis-util.js (the orient is a static string here: the runtime resolves an orient signal first) -----------

const isX = (orient: string): boolean => orient === 'bottom' || orient === 'top'
const getSign = (orient: string, a: number, b: number): number => (orient === 'left' || orient === 'top' ? a : b)
const ifX = <T>(orient: string, a: T, b?: T): T | undefined => (isX(orient) ? a : b)
const ifY = <T>(orient: string, a: T, b?: T): T | undefined => (isX(orient) ? b : a)
const ifTop = (orient: string, a: string, b: string): EncodeValue => (orient === 'top' ? { value: a } : { value: b })
const ifRight = (orient: string, a: string, b: string): EncodeValue => (orient === 'right' ? { value: a } : { value: b })
const mult = (sign: number, v: number): number | EncodeValue => (v === 0 ? 0 : { value: sign * v })

/** guides/guide-util.js `extendOffset` */
function extendOffset(v: unknown, offset: unknown): unknown {
  return !offset ? v
    : !v ? offset
    : !isObj(v) ? { value: v, offset }
    : Object.assign({}, v, { offset: extendOffset((v as Rec).offset, offset) })
}

/** guides/guide-util.js `tickBand` */
export function tickBand(_: Lookup): { extra: unknown; band: unknown; offset: unknown } {
  const v = _('tickBand')
  let offset: unknown = _('tickOffset')
  let band: unknown
  let extra: unknown
  if (!v) {
    // if no tick band entry, fall back on other properties
    band = _('bandPosition')
    extra = _('tickExtra')
  } else if (isSignal(v)) {
    // if signal, augment code to interpret values
    band = { signal: `(${v.signal}) === 'extent' ? 1 : 0.5` }
    extra = { signal: `(${v.signal}) === 'extent'` }
    if (!isObj(offset)) offset = { signal: `(${v.signal}) === 'extent' ? 0 : ${offset}` }
  } else if (v === 'extent') {
    band = 1
    extra = true
    offset = 0
  } else {
    band = 0.5
    extra = false
  }
  return { extra, band, offset }
}

/** vega-util `flush`: one of three values by the distance of a value to a range's ends. */
function flush(range: readonly number[], v: number, threshold: unknown, left: unknown, right: unknown, center: unknown): unknown {
  if (!threshold && threshold !== 0) return center
  const t = +(threshold as number)
  let a = range[0] as number
  let b = range[range.length - 1] as number
  if (b === undefined) return center
  if (b < a) { const l = a; a = b; b = l }
  const l = Math.abs(v - a)
  const r = Math.abs(b - v)
  return l < r && l <= t ? left : r <= t ? right : center
}

/** vega-parser `deref`: a signal's expression text, else the value */
const deref = (v: unknown): unknown => (v && (v as { signal?: unknown }).signal) || v

// --- the marks -------------------------------------------------------------------------------------------------------

interface AxisParts {
  spec: Rec
  _: Lookup
  orient: string
  scale: string
  band: { extra: unknown; band: unknown; offset: unknown }
  encode: Record<string, UserEncode | undefined>
}

const newEncode = (): MarkEncode => ({ enter: { opacity: zero }, update: { opacity: one }, exit: { opacity: zero } })

/** guides/axis-ticks.js */
function ticksMark(p: AxisParts, size: unknown): GuideMarkDef {
  const { _, orient, scale, band } = p
  const sign = getSign(orient, -1, 1)
  const encode = newEncode()
  const { enter, update } = encode
  addEncoders(encode, {
    stroke: _('tickColor'), strokeCap: _('tickCap'), strokeDash: _('tickDash'), strokeDashOffset: _('tickDashOffset'),
    strokeOpacity: _('tickOpacity'), strokeWidth: _('tickWidth'),
  })
  const tickSize = encoder(size)
  tickSize.mult = sign
  const tickPos = { scale, field: 'value', band: band.band, extra: band.extra, offset: band.offset, round: _('tickRound') } as unknown as EncodeValue
  update.y = enter.y = ifX(orient, zero, tickPos)
  update.y2 = enter.y2 = ifX(orient, tickSize as EncodeValue)
  update.x = enter.x = ifY(orient, zero, tickPos)
  update.x2 = enter.x2 = ifY(orient, tickSize as EncodeValue)
  return guideMark({ type: 'rule', role: 'axis-tick', encode, interactive: false }, p.encode.ticks)
}

/** guides/axis-grid.js */
function gridMark(p: AxisParts, host: EntryHost): GuideMarkDef {
  const { spec, _, orient, scale, band } = p
  const vscale = spec.gridScale
  const sign = getSign(orient, 1, -1)
  const offset = offsetValue(spec.offset, sign)
  const encode = newEncode()
  const { enter, update } = encode
  addEncoders(encode, {
    stroke: _('gridColor'), strokeCap: _('gridCap'), strokeDash: _('gridDash'), strokeDashOffset: _('gridDashOffset'),
    strokeOpacity: _('gridOpacity'), strokeWidth: _('gridWidth'),
  })
  const tickPos = { scale, field: 'value', band: band.band, extra: band.extra, offset: band.offset, round: _('tickRound') } as unknown as EncodeValue
  // (the cross-axis length is the view's `height` / `width` SIGNAL: a nested group's axes grid as far as the whole view)
  const along = (name: 'width' | 'height'): Entry => {
    const fn = ((s: EntryScope) => {
      const base = s.host.viewSignal(name)
      const m = base * sign
      return offset == null ? m : m + Number(s.host.entry(isObj(offset) ? (offset as EncodeValue) : ({ value: offset } as EncodeValue), s.datum))
    }) as EntryFn
    // (an offset that is an entry may read the datum; a number is the same for every tick)
    fn.perRun = offset == null || !isObj(offset)
    return fn
  }
  const gridStart = (vscale ? { scale: vscale, range: 0, mult: sign, offset } : { value: 0, offset }) as unknown as EncodeValue
  const gridEnd: Entry = vscale ? ({ scale: vscale, range: 1, mult: sign, offset } as unknown as EncodeValue) : (ifX(orient, along('height'), along('width')) as Entry)
  void host
  enter.x = update.x = ifX(orient, tickPos, gridStart)
  enter.y = update.y = ifY(orient, tickPos, gridStart)
  enter.x2 = update.x2 = ifY(orient, gridEnd)
  enter.y2 = update.y2 = ifX(orient, gridEnd)
  return guideMark({ type: 'rule', role: 'axis-grid', encode, interactive: false }, p.encode.grid)
}

/** guides/axis-grid.js `offsetValue` */
function offsetValue(offset: unknown, sign: number): unknown {
  if (sign === 1) {
    // no further adjustment needed, just return offset
  } else if (!isObj(offset)) {
    offset = sign * ((offset as number) || 0)
  } else {
    let entry: Rec = (offset = { ...(offset as Rec) }) as Rec
    while (entry.mult != null) {
      if (!isObj(entry.mult)) {
        entry.mult = (entry.mult as number) * sign
        return offset
      }
      entry = entry.mult = { ...(entry.mult as Rec) }
    }
    entry.mult = sign
  }
  return offset
}

/** guides/axis-domain.js */
function domainMark(p: AxisParts): GuideMarkDef {
  const { _, orient, scale } = p
  const encode = newEncode()
  const { enter, update } = encode
  addEncoders(encode, {
    stroke: _('domainColor'), strokeCap: _('domainCap'), strokeDash: _('domainDash'), strokeDashOffset: _('domainDashOffset'),
    strokeWidth: _('domainWidth'), strokeOpacity: _('domainOpacity'),
  })
  const pos0 = { scale, range: 0 } as unknown as EncodeValue
  const pos1 = { scale, range: 1 } as unknown as EncodeValue
  enter.x = update.x = ifX(orient, pos0, zero)
  enter.x2 = update.x2 = ifX(orient, pos1)
  enter.y = update.y = ifY(orient, pos0, zero)
  enter.y2 = update.y2 = ifY(orient, pos1)
  return guideMark({ type: 'rule', role: 'axis-domain', encode, interactive: false }, p.encode.domain)
}

/** guides/axis-labels.js */
function labelsMark(p: AxisParts, size: unknown): GuideMarkDef {
  const { _, orient, scale, band } = p
  const sign = getSign(orient, -1, 1)
  const flushV = deref(_('labelFlush'))
  const flushOffset = deref(_('labelFlushOffset'))
  const labelAlign = _('labelAlign')
  const labelBaseline = _('labelBaseline')
  let flushOn = flushV === 0 || !!flushV

  const tickSize = encoder(size)
  tickSize.mult = sign
  tickSize.offset = encoder(_('labelPadding') || 0)
  ;(tickSize.offset as Rec).mult = sign

  const tickPos = { scale, field: 'value', band: 0.5, offset: extendOffset(band.offset, _('labelOffset')) } as unknown as EncodeValue

  // flush(range("scale"), scale("scale", datum.value), threshold, a, b, c): the arguments are expression text upstream
  const flushExpr = (threshold: unknown, a: string, b: string, c: string): EntryFn => (s) => {
    const sc = s.host.scale(scale)
    const range = (sc ? sc.range() : []) as number[]
    const v = sc ? (sc(s.datum.value) as number) : NaN
    const ev = (t: string): unknown => s.host.expr(t)
    return flush(range, v, ev(String(threshold)), ev(a), ev(b), ev(c))
  }
  const align = ifX(orient, flushOn ? flushExpr(flushV, '"left"', '"right"', '"center"') : ({ value: 'center' } as EncodeValue), ifRight(orient, 'left', 'right')) as Entry
  const baseline = ifX(orient, ifTop(orient, 'bottom', 'top'), flushOn ? flushExpr(flushV, '"top"', '"bottom"', '"middle"') : ({ value: 'middle' } as EncodeValue)) as Entry
  const offsetExpr = flushExpr(flushV, `-(${String(flushOffset)})`, String(flushOffset), '0')
  flushOn = flushOn && !!flushOffset

  const enter: Block = {
    opacity: zero,
    x: ifX(orient, tickPos, tickSize as EncodeValue),
    y: ifY(orient, tickPos, tickSize as EncodeValue),
  }
  const update: Block = { opacity: one, text: { field: 'label' } as EncodeValue, x: enter.x, y: enter.y, align, baseline }
  const encode: MarkEncode = { enter, update, exit: { opacity: zero, x: enter.x, y: enter.y } }

  addEncoders(encode, {
    dx: !labelAlign && flushOn ? ifX(orient, offsetExpr as unknown) : null,
    dy: !labelBaseline && flushOn ? ifY(orient, offsetExpr as unknown) : null,
  })
  addEncoders(encode, {
    angle: _('labelAngle'), fill: _('labelColor'), fillOpacity: _('labelOpacity'), font: _('labelFont'), fontSize: _('labelFontSize'),
    fontWeight: _('labelFontWeight'), fontStyle: _('labelFontStyle'), limit: _('labelLimit'), lineHeight: _('labelLineHeight'),
  }, { align: labelAlign, baseline: labelBaseline })

  const bound = _('labelBound')
  let overlap = _('labelOverlap')
  const mark = guideMark({ type: 'text', role: 'axis-label', style: 'guide-label', encode, interactive: false }, p.encode.labels)
  // if overlap method or bound defined, request label overlap removal
  if (overlap || bound) {
    mark.overlap = {
      separation: _('labelSeparation'), method: overlap, order: 'datum.index',
      bound: bound ? { scale, orient, tolerance: bound } : null,
    }
  }
  overlap = undefined
  return mark
}


/** guides/axis-title.js */
function titleMark(p: AxisParts): GuideMarkDef {
  const { spec, _, orient, scale } = p
  const sign = getSign(orient, -1, 1)
  const alignFn: EntryFn = (s) => (s.item.anchor === 'start' ? 'left' : s.item.anchor === 'end' ? 'right' : 'center')
  const enter: Block = { opacity: zero, anchor: encoder(_('titleAnchor', null)) as EncodeValue, align: alignFn }
  const update: Block = Object.assign({}, enter, { opacity: one, text: encoder(spec.title) as EncodeValue })
  const encode: MarkEncode = { enter, update, exit: { opacity: zero } }

  const titlePos: EntryFn = (s) => {
    const sc = s.host.scale(scale)
    const range = (sc ? sc.range() : []) as number[]
    const a = s.item.anchor
    return lerp(range, a === 'start' ? 0 : a === 'end' ? 1 : 0.5)
  }
  update.x = ifX(orient, titlePos)
  update.y = ifY(orient, titlePos)
  enter.angle = ifX(orient, zero, mult(sign, 90) as EncodeValue)
  enter.baseline = ifX(orient, ifTop(orient, 'bottom', 'top'), { value: 'bottom' } as EncodeValue)
  update.angle = enter.angle
  update.baseline = enter.baseline

  addEncoders(encode, {
    fill: _('titleColor'), fillOpacity: _('titleOpacity'), font: _('titleFont'), fontSize: _('titleFontSize'), fontStyle: _('titleFontStyle'),
    fontWeight: _('titleFontWeight'), limit: _('titleLimit'), lineHeight: _('titleLineHeight'),
  }, { align: _('titleAlign'), angle: _('titleAngle'), baseline: _('titleBaseline') })

  // autoLayout: an explicit titleX / titleY (or a user x / y) takes the title out of the layout's hands
  const userEncode = p.encode.title
  const auto = (v: unknown, dim: 'x' | 'y'): boolean => {
    if (v != null) {
      update[dim] = encoder(v) as EncodeValue
      return false
    }
    return !has(dim, { enter: (userEncode?.enter ?? {}) as Block, update: (userEncode?.update ?? {}) as Block })
  }
  const autoY = auto(_('titleX'), 'x')
  const autoX = auto(_('titleY'), 'y')
  enter.auto = autoX === autoY ? (encoder(autoX) as EncodeValue) : (ifX(orient, encoder(autoX) as EncodeValue, encoder(autoY) as EncodeValue) as EncodeValue)
  return guideMark({ type: 'text', role: 'axis-title', style: 'guide-title', encode, interactive: false }, userEncode)
}

/** parsers/axis.js `buildAxisEncode`: the axis group's own encode, which the layout reads */
function groupEncode(p: AxisParts): MarkEncode {
  const { spec, _, scale } = p
  const encode: MarkEncode = { enter: {}, update: {} }
  const rangeSpan: EntryFn = (s) => {
    const sc = s.host.scale(scale)
    const r = (sc ? sc.range() : []) as number[]
    // abs(span(range(scale))); span: the last end minus the first, or 0
    const span = (r && (r[r.length - 1]! - r[0]!)) || 0
    return Math.abs(span)
  }
  addEncoders(encode, {
    orient: p.orient, offset: _('offset') || 0, position: value(spec.position, 0), titlePadding: _('titlePadding'),
    minExtent: _('minExtent'), maxExtent: _('maxExtent'), range: rangeSpan, translate: _('translate'),
    format: spec.format, formatType: spec.formatType,
  })
  return extendEncode(encode, p.encode.axis, true)
}

// --- Overlap (vega-view-transforms) ----------------------------------------------------------------------------------

export interface OverlapSpec {
  separation?: unknown
  method?: unknown
  order?: string
  bound?: { scale: string; orient: string; tolerance: unknown } | null
}

/**
 * vega-view-transforms `Overlap`: hide (opacity 0) the items whose boxes collide, so that at least two remain; items
 * outside the bound scale's range (bound) are hidden too. Returns the mark's bounds as the transform re-calculates
 * them (the visible items of the ones that had a box), or null when the transform left them alone.
 */
export function overlapItems(items: SceneItem[], data: Row[], o: OverlapSpec, host: EntryHost, boundOf: (it: SceneItem) => Bounds): Bounds | null {
  const cache = new Map<SceneItem, Bounds>()
  const bounds = (it: SceneItem): Bounds => { let b = cache.get(it); if (!b) cache.set(it, (b = boundOf(it))); return b }
  const methods: Record<string, (list: SceneItem[], sep: number) => SceneItem[]> = {
    parity: (list) => list.filter((it, i) => (i % 2 ? ((it.opacity = 0), false) : true)),
    greedy: (list, sep) => {
      let a: SceneItem | undefined
      return list.filter((b, i) => {
        if (!i || !intersect(bounds(a!), bounds(b), sep)) { a = b; return true }
        b.opacity = 0
        return false
      })
    },
  }
  const method = (isSignal(o.method) ? host.expr(o.method.signal) : o.method) as string
  const sep = +((isSignal(o.separation) ? host.expr(o.separation.signal) : o.separation) as number) || 0
  const reduce = (typeof method === 'string' && Object.hasOwn(methods, method) ? methods[method] : methods.parity)!
  if (!items.length) return null
  if (!method) return null
  // skip labels with no content
  let source = items.map((it, i) => ({ it, d: data[i] })).filter(({ it }) => {
    const b = bounds(it)
    return b.width() > 1 && b.height() > 1
  })
  if (!source.length) return null
  if (o.order) {
    // (the order is `datum.index`)
    source = source.slice().sort((a, b) => cmp(a.d?.index, b.d?.index))
  }
  const src = source.map((s) => s.it)
  for (const it of src) it.opacity = 1
  let list = src
  const hasOverlap = (l: SceneItem[]): boolean => {
    for (let i = 1; i < l.length; i++) if (intersect(bounds(l[i - 1]!), bounds(l[i]!), sep)) return true
    return false
  }
  if (list.length >= 3 && hasOverlap(list)) {
    do { list = reduce(list, sep) } while (list.length >= 3 && hasOverlap(list))
    const last = src[src.length - 1]!
    if (list.length < 3 && !last.opacity) {
      if (list.length > 1) list[list.length - 1]!.opacity = 0
      last.opacity = 1
    }
  }
  const b = o.bound
  if (b) {
    const tol = isSignal(b.tolerance) ? host.expr(b.tolerance.signal) : b.tolerance
    if ((tol as number) >= 0) {
      const sc = host.scale(b.scale)
      const range = (sc ? sc.range() : []) as number[]
      const box = new Bounds()
      if (b.orient === 'top' || b.orient === 'bottom') box.set(range[0]!, -Infinity, range[1]!, Infinity)
      else box.set(-Infinity, range[0]!, Infinity, range[1]!)
      box.expand(+(tol as number) || 1)
      for (const it of src) if (!encloses(box, bounds(it))) it.opacity = 0
    }
  }
  const out = new Bounds()
  for (const it of src) if (it.opacity) out.union(bounds(it))
  return out
}

const intersect = (a: Bounds, b: Bounds, sep: number): boolean => sep > Math.max(b.x1 - a.x2, a.x1 - b.x2, b.y1 - a.y2, a.y1 - b.y2)
const encloses = (a: Bounds, b: Bounds): boolean => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2
const cmp = (a: unknown, b: unknown): number => ((a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0)

// --- the axis ---------------------------------------------------------------------------------------------------------

export interface AxisBuildInput {
  spec: Rec
  cfg: Rec
  scale: string
  orient: string
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
  /** the layout never ran (vega logged it): the group stays where its encode put it */
  raw: boolean
  host: EntryHost
  style: GuideStyles
  /** the size the axis's ticks/labels read as `tickSize` (AxisTicks' own ticks flag is `_('ticks')`) */
}

export interface AxisBuilt {
  /** the leaves of every mark, in the axis group's frame moved to the view frame (vega draws them inside the group) */
  leaves: SceneItem[]
  /** which marks the axis has, in paint order */
  parts: string[]
  /** the user's names and interactivity per part (`axis` is the group) */
  partMeta: Record<string, { name?: string; interactive: boolean }>
  /** the axis group item as encoded and laid out */
  group: Rec
  /** the axis mark's bounds after layout, in the parent frame (`item.mark.bounds`) */
  bounds: Bounds
  /** the data the axis group was made from (`datum.ticks` ...) */
  datum: Row
}

interface AxisDefs {
  cfg: Rec
  orient: string
  scale: string
  encode: Record<string, UserEncode | undefined>
  flags: { ticks: boolean; labels: boolean; grid: boolean; domain: boolean; title: boolean }
  marks: Array<{ part: string; def: GuideMarkDef; onTicks: boolean }>
  groupDef: GuideMarkDef
}

/** Build an axis from vega-parser's guides, evaluate it, lay it out. */
export function buildAxis(inp: AxisBuildInput): AxisBuilt {
  const { spec, cfg, host, style } = inp
  const orient = inp.orient

  // the marks an axis is made of depend on its spec and the config (what is not known until a run is a signal, which
  // the entries read when they are evaluated): they are made once per compiled axis, and every evaluation reuses them
  let defs = inp.store?.get(spec) as AxisDefs | undefined
  if (defs === undefined || defs.cfg !== cfg || defs.orient !== orient || defs.scale !== inp.scale || defs.encode !== inp.encode) {
    const _ = lookup(spec, cfg)
    const band = tickBand(_)
    const p: AxisParts = { spec, _, orient, scale: inp.scale, band, encode: inp.encode }
    const flags = { ticks: !!_('ticks'), labels: !!_('labels'), grid: !!_('grid'), domain: !!_('domain'), title: spec.title != null }
    const marks: AxisDefs['marks'] = []
    let size: unknown
    if (flags.grid) marks.push({ part: 'grid', def: gridMark(p, host), onTicks: true })
    if (flags.ticks) {
      size = _('tickSize')
      marks.push({ part: 'tick', def: ticksMark(p, size), onTicks: true })
    }
    if (flags.labels) {
      size = flags.ticks ? size : 0
      marks.push({ part: 'label', def: labelsMark(p, size), onTicks: true })
    }
    if (flags.domain) marks.push({ part: 'domain', def: domainMark(p), onTicks: false })
    if (flags.title) marks.push({ part: 'title', def: titleMark(p), onTicks: false })
    // the axis group item: its encode carries the layout parameters
    const groupDef: GuideMarkDef = { type: 'rule', role: 'axis', style: inp.encode.axis?.style, encode: groupEncode(p), interactive: false }
    defs = { cfg, orient, scale: inp.scale, encode: inp.encode, flags, marks, groupDef }
    if (inp.keep) inp.store?.set(spec, defs)
  }
  const datum: Row = { scale: inp.scale, ticks: defs.flags.ticks, labels: defs.flags.labels, grid: defs.flags.grid, domain: defs.flags.domain, title: defs.flags.title }
  const marks = defs.marks.map((m) => ({ part: m.part, def: m.def, data: m.onTicks ? inp.ticks : [datum] }))
  const group = encodeItem(defs.groupDef, datum, {}, host, style) as unknown as Rec

  const leaves: SceneItem[] = []
  const markBounds = new Map<string, Bounds>()
  const bounds = (it: SceneItem): Bounds => boundLeaf(new Bounds(), it)
  const titleItems: SceneItem[] = []
  const partMeta: AxisBuilt['partMeta'] = {}
  let joined: [Row[], Row[]] | null = null
  for (const { part, def, data } of marks) {
    const keyed = part === 'grid' || part === 'tick' || part === 'label'
    // (the grid, the ticks and the labels are keyed over the same tuples: one join)
    const rows = keyed ? (joined !== null && joined[0] === data ? joined[1] : (joined = [data, inp.distinctTicks ? data : joinByValue(data)])[1]) : data
    // (every leaf is tagged with its kind and its part as it is made)
    def.seed ??= { _kind: def.type === 'text' ? 'text' : 'rule', _part: part }
    const items: SceneItem[] = encodeItems(def, rows, group, host, style)
    let mb: Bounds | null = null
    if (def.overlap) mb = overlapItems(items, rows, def.overlap, host, bounds)
    // (the layout reads the bounds of the ticks, the labels and the title: a grid of a thousand lines is not measured)
    if (!mb && (part === 'tick' || part === 'label' || part === 'title')) {
      mb = new Bounds()
      const scratch = new Bounds()
      for (const it of items) mb.union(boundLeaf(scratch.clear(), it))
    }
    if (mb) markBounds.set(part, mb)
    partMeta[part] = { name: def.name, interactive: def.interactive }
    if (part === 'title') for (const it of items) titleItems.push(it)
    for (const it of items) leaves.push(it)
  }
  partMeta.axis = { name: inp.encode.axis?.name == null || !inp.encode.axis.name ? undefined : String(inp.encode.axis.name), interactive: !!inp.encode.axis?.interactive }

  // --- axisLayout (vega-view-transforms layout/axis.js) ---
  const out = new Bounds()
  if (!inp.raw) {
    const delta = (group.translate as number) != null ? (group.translate as number) : 0.5
    const gOrient = group.orient as string
    const range = group.range as number
    const offset = group.offset as number
    const position = group.position as number
    const minExtent = group.minExtent as number
    const maxExtent = group.maxExtent as number
    const titlePadding = group.titlePadding as number
    const title = titleItems[0]
    const dl = title ? multiLineOffset(title) : 0
    const b = new Bounds()
    const tb = markBounds.get('tick')
    const lb = markBounds.get('label')
    if (tb) b.union(tb)
    if (lb) b.union(lb)
    let x = 0
    let y = 0
    let s: number
    const titleLayout = (extent: number, pad: number, dl2: number, isYAxis: number, sign: number): void => {
      const tbounds = markBounds.get('title')!
      if (title && (title as Rec).auto) {
        const v = sign * (extent + dl2 + pad)
        let dx = 0
        let dy = 0
        if (isYAxis) { dx = ((title.x as number) || 0) - (title.x = v) } else { dy = ((title.y as number) || 0) - (title.y = v) }
        tbounds.translate(-dx, -dy)
      }
      b.union(tbounds)
    }
    switch (gOrient) {
      case 'top':
        x = position || 0
        y = -offset
        s = Math.max(minExtent, Math.min(maxExtent, -b.y1))
        b.add(0, -s).add(range, 0)
        if (title) titleLayout(s, titlePadding, dl, 0, -1)
        break
      case 'left':
        x = -offset
        y = position || 0
        s = Math.max(minExtent, Math.min(maxExtent, -b.x1))
        b.add(-s, 0).add(0, range)
        if (title) titleLayout(s, titlePadding, dl, 1, -1)
        break
      case 'right':
        x = inp.width + offset
        y = position || 0
        s = Math.max(minExtent, Math.min(maxExtent, b.x2))
        b.add(0, 0).add(s, range)
        if (title) titleLayout(s, titlePadding, dl, 1, 1)
        break
      case 'bottom':
        x = position || 0
        y = inp.height + offset
        s = Math.max(minExtent, Math.min(maxExtent, b.y2))
        b.add(0, 0).add(range, s)
        if (title) titleLayout(s, titlePadding, 0, 0, 1)
        break
      default:
        x = group.x as number
        y = group.y as number
    }
    // update bounds
    boundStroke(b.translate(x, y), group as SceneItem)
    group.x = x + delta
    group.y = y + delta
    out.union(b)
  }

  // the leaves live in the group's frame; the scene bakes the group's position into them
  const gx = (group.x as number) || 0
  const gy = (group.y as number) || 0
  if (gx || gy) {
    for (const it of leaves) {
      const r = it as Rec
      // (vega draws an item at `item.x || 0` inside the group: a NaN position is the group's origin)
      r.x = ((r.x as number) || 0) + gx
      r.y = ((r.y as number) || 0) + gy
      if (r.x2 != null) r.x2 = (r.x2 as number) + gx
      if (r.y2 != null) r.y2 = (r.y2 as number) + gy
    }
  }
  return { leaves, parts: marks.map((m) => m.part), partMeta, group, bounds: out, datum }
}

export { getEncoding, applyDefaults }
