/**
 * The rewrites that turn a unit into other units before it is compiled: a composite mark (boxplot, errorbar, errorband) into the layer
 * of simple marks that draws it (composite-marks.ts), a line or area with an overlay into the layer of the mark and its overlay, and a
 * stack whose order follows a colour domain into a unit with an `order` channel.
 *
 * The rewrites walk the spec tree with the encoding that the layers above a unit share. A layer's encoding is merged into each unit
 * under it (the layer keeps none) so that a unit is complete by itself when it is rewritten.
 */
import { compositeLayers, compositeMarkOf } from './composite-marks.js'

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
  const own: Obj = isObj(child) ? child : {}
  const out: Obj = {}
  for (const channel of new Set([...Object.keys(parent), ...Object.keys(own)])) {
    const c = own[channel]
    const p = parent[channel]
    if (namesData(c)) out[channel] = { ...(isObj(p) ? p : {}), ...c }
    else if (isObj(c) && namesData(c.condition)) out[channel] = { ...c, condition: { ...(isObj(p) ? p : {}), ...c.condition } }
    else if (c || c === null) out[channel] = c
    else out[channel] = p
  }
  return out
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
  const out: Obj = {}
  for (const [channel, def] of Object.entries(encoding)) {
    const untyped = isObj(def) && def.type === undefined && (def.field !== undefined || def.aggregate === 'count') && def.datum === undefined && def.value === undefined
    out[channel] = untyped && !NO_TYPE_CHANNELS.has(channel) ? { ...def, type: typeOf(channel, def) } : def
  }
  return out
}

const FACET_CHANNELS = ['row', 'column', 'facet'] as const
const hasFacetChannel = (encoding: unknown): boolean => isObj(encoding) && FACET_CHANNELS.some((c) => encoding[c] !== undefined)
const COMPOSITIONS = ['hconcat', 'vconcat', 'concat'] as const

/** A unit that is faceted by its encoding is a facet over a unit without the facet channels. */
function facetOver(node: Obj, inner: (unit: Obj) => unknown): Obj {
  const { row, column, facet, ...rest } = node.encoding
  const { width, height, params, projection, mark, name, encoding: _e, ...outer } = node
  const unit = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(params ? { params } : {}), ...(projection !== undefined ? { projection } : {}), ...(name !== undefined ? { name } : {}), mark, encoding: rest }
  return { ...outer, facet: facet !== undefined ? facet : { ...(row !== undefined ? { row } : {}), ...(column !== undefined ? { column } : {}) }, spec: inner(unit) }
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
  if (kind) return compositeLayers(kind, { ...node, encoding: typed(mergeEncoding(inherited, node.encoding)) }, userConfig)

  const out: Obj = { ...node }
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
  if (node.spec !== undefined) out.spec = normalizeComposites(node.spec, userConfig, {})
  return out
}

// --- overlays of line and area marks -------------------------------------------------------------------------------------------

/** The opacity of an area that has an overlay, unless the spec sets one. */
const AREA_OPACITY_WITH_OVERLAY = 0.7
const OVERLAYED_MARKS = new Set(['line', 'rule', 'trail', 'area'])

const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const omit = (o: Obj, keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

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
  const rest = omit(markDef, ['point', 'line'])
  return Object.keys(rest).length > 1 ? rest : (rest.type as string)
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Replace every line, area, rule and trail with an overlay (points, or for an area a line too) by the layer of the mark and its
 * overlays over the same encoding: a stacked measure's `stack` goes to the overlays, `x2` / `y2` and `shape` stay off them.
 * `stackOf` answers the stack properties of a unit; `inherited` is the encoding a parent layer shares.
 */
export function normalizePathOverlays(node: unknown, config: Obj, stackOf: (unit: Obj) => StackProps | undefined, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizePathOverlays(n, config, stackOf, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) {
    const encoding = mergeEncoding(inherited, node.encoding)
    return { ...node, layer: (node.layer as unknown[]).map((c) => normalizePathOverlays(c, config, stackOf, encoding)) }
  }
  for (const k of COMPOSITIONS) {
    if (node[k] !== undefined) return { ...node, [k]: normalizePathOverlays(node[k], config, stackOf, {}) }
  }
  if (node.spec !== undefined) return { ...node, spec: normalizePathOverlays(node.spec, config, stackOf, {}) }
  if (node.mark === undefined) return node

  if (hasFacetChannel(node.encoding)) {
    const faceted = facetOver(node, (unit) => normalizePathOverlays(unit, config, stackOf, inherited))
    // (a unit with nothing to overlay stays the unit it was)
    const inner = faceted.spec as unknown
    return inner === undefined || (isObj(inner) && inner.layer === undefined) ? node : faceted
  }

  const { params, projection, mark, name, encoding: own, ...outer } = node
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  if (!OVERLAYED_MARKS.has(markDef.type)) return node
  const encoding: Obj = mergeEncoding(inherited, own)
  const markConfig: Obj = isObj(config[markDef.type]) ? config[markDef.type] : {}
  const points = pointOverlayOf(markDef, markConfig, encoding)
  const line = markDef.type === 'area' ? lineOverlayOf(markDef, markConfig) : undefined
  if (!points && !line) return node

  const opacityGiven = (k: string): boolean => (markDef[k] ?? markConfig[k] ?? (isObj(config.mark) ? config.mark[k] : undefined)) !== undefined
  const layer: Obj[] = [
    {
      ...(name !== undefined ? { name } : {}),
      ...(params ? { params } : {}),
      mark: bareMark({
        ...(markDef.type === 'area' && !opacityGiven('opacity') && !opacityGiven('fillOpacity') ? { opacity: AREA_OPACITY_WITH_OVERLAY } : {}),
        ...markDef,
      }),
      encoding: omit(own === undefined ? {} : (own as Obj), ['shape']),
    },
  ]
  // a stacked measure stacks the overlays alike; an overlay is not ranged (x2 / y2 would make it a rule)
  const stack = stackOf({ ...node, encoding })
  const stacked: Obj = stack
    ? { ...encoding, [stack.fieldChannel]: { ...(encoding[stack.fieldChannel] as Obj), ...(stack.offset ? { stack: stack.offset } : {}) } }
    : encoding
  const shared = omit(stacked, ['y2', 'x2'])
  // what the parent layer would give the overlay anyway is not repeated in it
  const ownOfOverlay = omit(shared, Object.keys(inherited).filter((k) => sameJson(inherited[k], shared[k])))
  if (line) {
    layer.push({
      ...(projection !== undefined ? { projection } : {}),
      mark: { type: 'line', ...pick(markDef, ['clip', 'interpolate', 'tension', 'tooltip']), ...line },
      encoding: ownOfOverlay,
    })
  }
  if (points) {
    layer.push({
      ...(projection !== undefined ? { projection } : {}),
      mark: { type: 'point', opacity: 1, filled: true, ...pick(markDef, ['clip', 'tooltip']), ...points },
      encoding: ownOfOverlay,
    })
  }
  return { ...outer, layer }
}

// --- stack order ---------------------------------------------------------------------------------------------------------------

/**
 * A unit with no `order` channel and a nominal colour with an explicit domain list orders its stack (or its offset groups) like that
 * list: a sort index calculated from the domain becomes the `order` channel. `inherited` is the encoding a parent layer shares;
 * `stackOf` answers the stack properties of a unit.
 */
export function alignStackOrders(node: unknown, stackOf: (unit: Obj) => StackProps | undefined, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => alignStackOrders(n, stackOf, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) return { ...node, layer: alignStackOrders(node.layer, stackOf, mergeEncoding(inherited, node.encoding)) }
  for (const k of COMPOSITIONS) if (node[k] !== undefined) return { ...node, [k]: alignStackOrders(node[k], stackOf, {}) }
  if (node.spec !== undefined) return { ...node, spec: alignStackOrders(node.spec, stackOf, {}) }
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
    return { ...node, encoding: { ...own, [offsetChannel]: { ...offset, sort: domain } } }
  }
  // stacked: the layers follow the list, from the baseline up
  const stack = stackOf({ ...node, encoding })
  if (!stack) return node
  const as = `_${color.field}_sort_index`
  const horizontal = (isObj(node.mark) ? node.mark.orient : undefined) === 'horizontal' || (!(isObj(node.mark) && node.mark.orient) && stack.orient === 'horizontal')
  return {
    ...node,
    transform: [...(Array.isArray(node.transform) ? node.transform : []), { calculate: `indexof(${JSON.stringify(domain)}, datum['${color.field}'])`, as }],
    encoding: { ...own, order: { field: as, type: 'quantitative', sort: horizontal ? 'ascending' : 'descending' } },
  }
}
