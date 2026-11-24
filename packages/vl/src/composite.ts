/**
 * The rewrites that turn a unit into other units before it is compiled: a composite mark (boxplot, errorbar, errorband) into the layer
 * of simple marks that draws it (composite-marks.ts), a line or area with an overlay into the layer of the mark and its overlay, and a
 * stack whose order follows a colour domain into a unit with an `order` channel.
 *
 * The rewrites walk the spec tree with the encoding that the layers above a unit share. A layer's encoding is merged into each unit
 * under it (the layer keeps none) so that a unit is complete by itself when it is rewritten.
 *
 * The rewrites compile nothing: they run under consume.ts `peek` (what they read to decide is not consumed) and move the spec's
 * properties with `derive` / `pick` / `merge`, so each one is consumed where the compiler reads its new place. A composite mark's own
 * properties are read for what they mean (`consuming`).
 */
import { compositeLayers, compositeMarkOf, isGiven } from './composite-marks.js'
import { spansAChannel } from './channels.js'
import { consumeAll, consuming, derive, deriveWithout, ignoreUnread, merge, peek, pick as pickTracked, transfer } from './consume.js'

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

// --- encodings -----------------------------------------------------------------------------------------------------------------

/** A definition that names a field (or counts), or a datum. */
const namesData = (d: unknown): d is Obj => isObj(d) && (!!d.field || d.aggregate === 'count' || 'datum' in d)

/**
 * A unit's encoding under its layer's: a channel the unit defines as a field or datum inherits the properties the layer gives it
 * (the unit's win), a conditional one inherits into its condition, any other definition (a value, `null`) replaces the layer's, and a
 * channel only the layer defines is the layer's.
 */
export function mergeEncoding(parent: Obj, child: unknown): Obj {
  return peek(() => {
    const own: Obj = isObj(child) ? child : {}
    const out: Obj = {}
    for (const channel of new Set([...Object.keys(parent), ...Object.keys(own)])) {
      const c = own[channel]
      const p = parent[channel]
      // (consume.ts merge: a property of the layer's definition that the unit's overrides is consumed, as it has no effect)
      if (namesData(c)) out[channel] = isObj(p) ? basedOn(merge(p, c), p) : c
      else if (isObj(c) && namesData(c.condition)) out[channel] = isObj(p) ? basedOn(derive(c, { condition: basedOn(merge(p, c.condition), p) }), p) : c
      // (a value or a null replaces the layer's definition: the property moves as it is, a null still to be read where it lands)
      else if (c || c === null) transfer(own, channel, out)
      else transfer(parent, channel, out)
    }
    return out
  })
}

/** A unit's channel definition -> the layer's definition it was merged with (mergeEncoding). */
const MERGE_BASE = new WeakMap<object, object>()
const basedOn = <T extends object>(merged: T, base: object): T => {
  MERGE_BASE.set(merged, base)
  return merged
}

/** Is `def` the layer's definition `base`, or merged from it (through any number of layers)? */
export function derivesFrom(def: unknown, base: object): boolean {
  for (let d: unknown = def; d !== null && typeof d === 'object'; d = MERGE_BASE.get(d as object)) if (d === base) return true
  return false
}

const NO_TYPE_CHANNELS = new Set(['x2', 'y2', 'xError', 'yError', 'xError2', 'yError2', 'theta2', 'radius2'])
const QUANTITATIVE_SCALES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'identity', 'sequential', 'quantile', 'quantize', 'threshold', 'bin-ordinal'])

/** The type a field definition without one gets, from the channel and the definition itself. */
function typeOf(channel: string, def: Obj): string {
  if (channel === 'latitude' || channel === 'longitude') return 'quantitative'
  if (['row', 'column', 'facet', 'shape', 'strokeDash'].includes(channel)) return 'nominal'
  if (channel === 'order') return 'ordinal'
  if (Array.isArray(def.sort)) return 'ordinal'
  if (def.timeUnit) return 'temporal'
  if (def.bin || (def.aggregate && !isObj(def.aggregate))) return 'quantitative'
  const scaleType = isObj(def.scale) ? def.scale.type : undefined
  if (QUANTITATIVE_SCALES.has(scaleType)) return 'quantitative'
  if (scaleType === 'time' || scaleType === 'utc') return 'temporal'
  return 'nominal'
}

/** The encoding with a type on every definition that needs one: a composite mark reads the types to orient itself. */
function typed(encoding: Obj): Obj {
  return peek(() => {
    const out: Obj = {}
    for (const [channel, def] of Object.entries(encoding)) {
      const untyped = isObj(def) && def.type === undefined && (def.field !== undefined || def.aggregate === 'count') && def.datum === undefined && def.value === undefined
      out[channel] = untyped && !NO_TYPE_CHANNELS.has(channel) ? derive(def, { type: typeOf(channel, def) }) : def
    }
    return out
  })
}

const FACET_CHANNELS = ['row', 'column', 'facet'] as const
const hasFacetChannel = (encoding: unknown): boolean => isObj(encoding) && FACET_CHANNELS.some((c) => encoding[c] !== undefined)
const COMPOSITIONS = ['hconcat', 'vconcat', 'concat'] as const

/** A unit that is faceted by its encoding is a facet over a unit without the facet channels. */
function facetOver(node: Obj, inner: (unit: Obj) => unknown): Obj {
  return peek(() => {
    const enc: Obj = node.encoding
    const unit = pickTracked(node, ['width', 'height', 'params', 'projection', 'name', 'mark'])
    unit.encoding = deriveWithout(enc, ['row', 'column', 'facet'])
    const outer = deriveWithout(node, ['width', 'height', 'params', 'projection', 'mark', 'name', 'encoding'])
    outer.facet = enc.facet !== undefined ? enc.facet : pickTracked(enc, ['row', 'column'])
    outer.spec = inner(unit)
    return outer
  })
}

// --- composite marks -----------------------------------------------------------------------------------------------------------

/** Whether a layer tree has a composite mark among its units. */
function holdsComposite(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(holdsComposite)
  return isObj(node) && (compositeMarkOf(node) !== undefined || holdsComposite(node.layer))
}

/**
 * Replace every composite mark in the spec tree by its layer of simple marks. A unit under a layer shares the layer's encoding
 * (`inherited`), which its dimensions and groupings come from.
 */
export function normalizeComposites(node: unknown, userConfig: Obj | undefined, inherited: Obj = {}, pushed = false): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizeComposites(n, userConfig, inherited, pushed))
  if (!isObj(node)) return node
  const kind = compositeMarkOf(node)
  if (kind && hasFacetChannel(node.encoding)) return facetOver(node, (unit) => normalizeComposites(unit, userConfig, inherited))
  // (a composite mark's rewrite reads its mark def, its config and its encoding for what they mean)
  if (kind) {
    return consuming(() => {
      // (the mark's type said which composite mark this is)
      void (isObj(node.mark) ? node.mark.type : node.mark)
      const layers = compositeLayers(kind, derive(node, { encoding: typed(mergeEncoding(inherited, node.encoding)) }), userConfig)
      // (compositemark/*.ts: a composite mark reads its extent, orientation, parts, size, thickness, clip, colour and opacity from
      // its mark def, and its error channels as fields; anything else there vega-lite does not read)
      if (isObj(node.mark)) ignoreUnread(node.mark, 'vega-lite reads no other property of a composite mark')
      // (the channels a composite mark hands to its parts are read there; what is left of them - an error channel's value, a raw
      // tooltip of a boxplot without outliers, a size the parts do not draw - vega-lite drops with the parts that would have drawn it.
      // The composite matrices against vega-lite, not this check, hold the composite marks to what they read)
      const enc = node.encoding
      if (isObj(enc)) {
        for (const def of Object.values(enc)) for (const d of Array.isArray(def) ? def : [def]) if (isObj(d)) ignoreUnread(d, 'a composite mark drops what its parts do not draw')
      }
      // (a selection declared on a composite mark itself: vega-lite drops it when the mark is normalized; one given by a composition
      // around it is kept by compositeLayers)
      if (Array.isArray(node.params)) for (const p of node.params) if (isObj(p) && !isGiven(p)) consumeAll(p)
      return layers
    })
  }

  const out: Obj = derive(node)
  if (node.layer !== undefined) {
    // A layer with a composite in it hands its encoding down: a unit beside the composite gets the merged encoding as its own and does
    // not inherit it a second time (the composite's parts already took its time units and aggregates out of their channels).
    const handsDown = pushed || holdsComposite(node.layer)
    out.layer = normalizeComposites(node.layer, userConfig, mergeEncoding(inherited, node.encoding), handsDown)
    if (handsDown) delete out.encoding
  } else if (pushed && node.mark !== undefined && Object.keys(inherited).length > 0) {
    out.encoding = mergeEncoding(inherited, node.encoding)
  }
  for (const k of COMPOSITIONS) if (node[k] !== undefined) out[k] = normalizeComposites(node[k], userConfig, {})
  // (a repeat's spec is rewritten once the repeat has put its values in, cell by cell: `normalizeUnits`)
  if (node.spec !== undefined) out.spec = node.repeat === undefined ? normalizeComposites(node.spec, userConfig, {}) : node.spec
  return out
}

// --- overlays of line and area marks -------------------------------------------------------------------------------------------

/** The opacity of an area that has an overlay, unless the spec sets one. */
const AREA_OPACITY_WITH_OVERLAY = 0.7
const OVERLAYED_MARKS = new Set(['line', 'rule', 'trail', 'area'])


/** The points drawn over a path mark: asked by the mark def, else by the mark's config or by a `shape` channel; `null` for none. */
function pointOverlayOf(markDef: Obj, markConfig: Obj, encoding: Obj): Obj | null | undefined {
  if (markDef.point === 'transparent') return { opacity: 0 }
  if (markDef.point) return isObj(markDef.point) ? markDef.point : {}
  if (markDef.point !== undefined) return null
  if (markConfig.point || encoding.shape) return isObj(markConfig.point) ? markConfig.point : {}
  return undefined
}

/** The line drawn along the top of an area: asked by the mark def, else by the config; `null` for none. */
function lineOverlayOf(markDef: Obj, markConfig: Obj): Obj | null | undefined {
  if (markDef.line) return markDef.line === true ? {} : markDef.line
  if (markDef.line !== undefined) return null
  if (markConfig.line) return markConfig.line === true ? {} : markConfig.line
  return undefined
}

export interface StackProps {
  fieldChannel: string
  offset?: string
  /** the orientation the mark ends up with */
  orient?: string
}

/** The mark def of the mark under its overlays: no `point`, no `line`; the bare type when nothing else is left. */
function bareMark(markDef: Obj): Obj | string {
  const rest = deriveWithout(markDef, ['point', 'line'])
  // (a mark def left with its type alone is that type, read here)
  return Object.keys(rest).length > 1 ? rest : consuming(() => rest.type as string)
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Replace every line, area, rule and trail with an overlay (points, or for an area a line too) by the layer of the mark and its
 * overlays over the same encoding: a stacked measure's `stack` goes to the overlays, `shape` stays off the mark.
 * `stackOf` answers the stack properties of a unit; `inherited` is the encoding a parent layer shares.
 */
export function normalizePathOverlays(node: unknown, config: Obj, stackOf: (unit: Obj) => StackProps | undefined, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizePathOverlays(n, config, stackOf, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) {
    const encoding = mergeEncoding(inherited, node.encoding)
    return derive(node, { layer: (node.layer as unknown[]).map((c) => normalizePathOverlays(c, config, stackOf, encoding)) })
  }
  for (const k of COMPOSITIONS) {
    if (node[k] !== undefined) return derive(node, { [k]: normalizePathOverlays(node[k], config, stackOf, {}) })
  }
  if (node.spec !== undefined) return node.repeat === undefined ? derive(node, { spec: normalizePathOverlays(node.spec, config, stackOf, {}) }) : node
  if (node.mark === undefined) return node

  if (hasFacetChannel(node.encoding)) {
    const faceted = facetOver(node, (unit) => normalizePathOverlays(unit, config, stackOf, inherited))
    // (a unit with nothing to overlay stays the unit it was)
    const inner = faceted.spec as unknown
    return inner === undefined || (isObj(inner) && inner.layer === undefined) ? node : faceted
  }

  const { mark, encoding: own } = node
  const outer = deriveWithout(node, ['params', 'projection', 'mark', 'name', 'encoding'])
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  // (what a mark def says of overlays is read here, overlay or not: `point: false` says none, and a mark that takes none - a bar, an
  // arc; `line` on anything but an area - ignores them, as vega-lite does)
  const said = (): void => consuming(() => void [markDef.point, markDef.line])
  if (!OVERLAYED_MARKS.has(markDef.type)) {
    said()
    return node
  }
  const encoding: Obj = mergeEncoding(inherited, own)
  const markConfig: Obj = isObj(config[markDef.type]) ? config[markDef.type] : {}
  const points = pointOverlayOf(markDef, markConfig, encoding)
  const line = markDef.type === 'area' ? lineOverlayOf(markDef, markConfig) : undefined
  if (!points && !line) {
    said()
    return node
  }

  const opacityGiven = (k: string): boolean => (markDef[k] ?? markConfig[k] ?? (isObj(config.mark) ? config.mark[k] : undefined)) !== undefined
  // (what asked for the overlays has done its job: the mark name, or the mark def's `point` / `line`)
  consuming(() => [node.mark, markDef.point, markDef.line])
  const first = pickTracked(node, ['name', 'params'])
  first.mark = bareMark(merge(markDef.type === 'area' && !opacityGiven('opacity') && !opacityGiven('fillOpacity') ? { opacity: AREA_OPACITY_WITH_OVERLAY } : {}, markDef))
  first.encoding = own === undefined ? {} : deriveWithout(own as Obj, ['shape'])
  const layer: Obj[] = [first]
  // a stacked measure stacks the overlays alike
  const stack = stackOf(derive(node, { encoding }))
  const shared: Obj = stack
    ? derive(encoding, { [stack.fieldChannel]: stack.offset ? derive(encoding[stack.fieldChannel] as Obj, { stack: stack.offset }) : encoding[stack.fieldChannel] })
    : encoding
  // what the parent layer would give the overlay anyway is not repeated in it
  // (an overlay is drawn on the edge of the area, and a point cannot span: neither takes the second channels)
  const ownOfOverlay = deriveWithout(shared, [...Object.keys(inherited).filter((k) => sameJson(inherited[k], shared[k])), 'x2', 'y2'])
  if (line) {
    const over = pickTracked(node, ['projection'])
    over.mark = merge(pickTracked(markDef, ['clip', 'interpolate', 'tension', 'tooltip'], { type: 'line' }), line)
    over.encoding = ownOfOverlay
    layer.push(over)
  }
  if (points) {
    const over = pickTracked(node, ['projection'])
    over.mark = merge(pickTracked(markDef, ['clip', 'tooltip'], { type: 'point', opacity: 1, filled: true }), points)
    over.encoding = ownOfOverlay
    layer.push(over)
  }
  outer.layer = layer
  return outer
}

// --- stack order ---------------------------------------------------------------------------------------------------------------

/**
 * The `order` definitions this module made from a colour domain. vega-lite makes them after the unit's stack is worked out
 * (UnitModel.alignStackOrderWithColorDomain), so they sort the stack and are not one of the fields it is stacked by or imputed over.
 */
const SYNTHESIZED_ORDERS = new WeakSet<object>()
const synthesizedOrder = <T extends object>(def: T): T => (SYNTHESIZED_ORDERS.add(def), def)
export const isSynthesizedOrder = (def: unknown): boolean => typeof def === 'object' && def !== null && SYNTHESIZED_ORDERS.has(def)

/**
 * A unit with no `order` channel and a nominal colour with an explicit domain list orders its stack (or its offset groups) like that
 * list: a sort index calculated from the domain becomes the `order` channel. `inherited` is the encoding a parent layer shares;
 * `stackOf` answers the stack properties of a unit.
 */
export function alignStackOrders(node: unknown, stackOf: (unit: Obj) => StackProps | undefined, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => alignStackOrders(n, stackOf, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) return derive(node, { layer: alignStackOrders(node.layer, stackOf, mergeEncoding(inherited, node.encoding)) })
  for (const k of COMPOSITIONS) if (node[k] !== undefined) return derive(node, { [k]: alignStackOrders(node[k], stackOf, {}) })
  if (node.spec !== undefined) return node.repeat === undefined ? derive(node, { spec: alignStackOrders(node.spec, stackOf, {}) }) : node
  if (node.mark === undefined) return node

  const own: Obj = isObj(node.encoding) ? node.encoding : {}
  const encoding: Obj = mergeEncoding(inherited, own)
  if (encoding.order) return node
  const color = encoding.fill ?? encoding.color
  if (!isObj(color) || typeof color.field !== 'string') return node
  const domain = isObj(color.scale) ? color.scale.domain : undefined
  if (!Array.isArray(domain) || (color.type ?? typeOf('color', color)) !== 'nominal') return node

  // side by side: the offset channel's groups follow the list
  const offsetChannel = encoding.xOffset ? 'xOffset' : encoding.yOffset ? 'yOffset' : undefined
  const offset = offsetChannel ? encoding[offsetChannel] : undefined
  if (offsetChannel && isObj(offset) && offset.field !== undefined && !offset.sort) {
    return derive(node, { encoding: derive(own, { [offsetChannel]: derive(offset, { sort: domain }) }) })
  }
  // stacked: the layers follow the list, from the baseline up
  const stack = stackOf(derive(node, { encoding }))
  if (!stack) return node
  const as = `_${color.field}_sort_index`
  // (an arc has no orientation: vega-lite's `orient` gives it 'vertical' whatever the mark def says)
  const horizontal = (isObj(node.mark) ? node.mark.type : node.mark) !== 'arc'
    && ((isObj(node.mark) ? node.mark.orient : undefined) === 'horizontal' || (!(isObj(node.mark) && node.mark.orient) && stack.orient === 'horizontal'))
  return derive(node, {
    transform: [...(Array.isArray(node.transform) ? node.transform : []), { calculate: `indexof(${JSON.stringify(domain)}, datum['${color.field}'])`, as }],
    encoding: derive(own, { order: synthesizedOrder({ field: as, type: 'quantitative', sort: horizontal ? 'ascending' : 'descending' }) }),
  })
}

// --- a line that spans a second channel -----------------------------------------------------------------------------------------

/**
 * Every line unit that spans a channel (a second channel next to its x, y, ...) as a rule over the same encoding. `inherited` is the
 * encoding a parent layer shares.
 */
export function normalizeRangedLines(node: unknown, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizeRangedLines(n, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) return derive(node, { layer: normalizeRangedLines(node.layer, mergeEncoding(inherited, node.encoding)) })
  for (const k of COMPOSITIONS) if (node[k] !== undefined) return derive(node, { [k]: normalizeRangedLines(node[k], {}) })
  if (node.spec !== undefined) return node.repeat === undefined ? derive(node, { spec: normalizeRangedLines(node.spec, {}) }) : node
  const type = isObj(node.mark) ? node.mark.type : node.mark
  if (type !== 'line' || !spansAChannel(mergeEncoding(inherited, node.encoding))) return node
  // (the mark's type has done its job: it made the rule)
  if (isObj(node.mark)) {
    consuming(() => node.mark.type)
    return derive(node, { mark: derive(node.mark, { type: 'rule' }) })
  }
  consuming(() => node.mark)
  return derive(node, { mark: 'rule' })
}

// --- all of them ---------------------------------------------------------------------------------------------------------------

/**
 * The spec tree with its composite marks, overlays and stack orders rewritten. A repeat's spec is left as it is: it names the
 * repeated fields by reference, and a rewrite needs the field it reads (the repeat rewrites each cell, with this, once it has put the
 * values in).
 */
export function normalizeUnits(node: unknown, userConfig: Obj | undefined, stackOf: (unit: Obj) => StackProps | undefined): unknown {
  return peek(() => alignStackOrders(normalizeRangedLines(normalizePathOverlays(normalizeComposites(node, userConfig), userConfig ?? {}, stackOf)), stackOf))
}
