/**
 * A from-scratch Vega-Lite compiler: Vega-Lite -> Vega.
 *
 * Coverage grows mark/channel by mark/channel, each step verified by rendering
 * parity against the pinned vega-lite oracle (the conformance harness renders
 * both and compares canonicalized SVG). Spec names may differ from the
 * oracle's; the rendered output must not.
 */

import { renameDataRefs, renameExpr, renameFragment } from './embed.js'
import { optimizeData } from './optimize.js'
import { VLCompileError, pushAll, signalSafe, flatField, datumRef as dref, genName, safeKey, splitAccessPath, validExpr } from './names.js'
import { validateGeoUnit, validateSpec } from './validate.js'
import { predicateExpr, domainValueExpr, paramLeaves, dateTimeToExpr, isDateTime as isDateTimeValue } from './predicate.js'
import {
  SELECTION_ID, STORE, assembleSelectionScaleDomain, assembleTopLevelSelectionSignals, assembleUnitSelectionData,
  assembleFacetSignals, assembleUnitSelectionMarks, assembleUnitSelectionSignals, interactiveLegendSelections, parseUnitSelections, requiresSelectionId, selectionPredicate,
  stringValue, varName, type ParamPredicate, type SelCmpt, type SelUnit, type TimeUnitProjection,
} from './selection.js'
import { alignStackOrders, mergeEncoding, normalizeComposites, normalizePathOverlays } from './composite.js'
import { timeScaleRange } from './animation.js'
import { isTimerSelection, selectionExtent } from './selection.js'
import { ASSEMBLED_FROM, GEO_POSITION_CHANNELS, assembleProjection, finalProjectionName, geoDataTransforms, geoshapeTransform, hasProjection, mergeLayerProjections, parseUnitProjection, renameComponentSignals, type GeoUnit, type ProjectionComponent, type UnitGeo } from './geo.js'
import { scaleConfigOf, discreteStep, viewContinuousSize, viewDiscreteSize, sizeRange, countRange, discreteCount, usesUnaggregatedDomain, type ScaleCfg } from './scaleconfig.js'
import { getTimeUnitParts, normalizeTimeUnit, timeUnitFieldName, timeUnitTransform, type NormalTimeUnit } from './timeunit.js'
import { binNames, binTransforms, isParameterExtent, imputeTransforms, normalizeBin, translateTransforms, type BinParams, type TransformContext, type TranslateState } from './transforms.js'

const VEGA_SCHEMA = 'https://vega.github.io/schema/vega/v6.json'

export { VLCompileError }

// --- spec types (structural, loose) ------------------------------------------

export type VLSpec = Record<string, unknown>

export interface ChannelDef {
  field?: string
  type?: string
  aggregate?: string
  bin?: boolean | Record<string, unknown>
  timeUnit?: string
  sort?: unknown
  stack?: unknown
  axis?: unknown
  scale?: Record<string, unknown>
  legend?: unknown
  value?: unknown
  title?: unknown
  format?: unknown
  condition?: unknown
  datum?: unknown
  expr?: unknown
  [k: string]: unknown
}

export interface FieldDef {
  /** the unit encodes this x / y's offset channel too (xOffset / yOffset): its discrete scale is a band (scale/type.ts hasNestedOffsetScale) */
  nestedOffset?: boolean
  /** the title config.fieldTitle / config.countTitle give a field with no title of its own */
  autoTitle?: string
  channel: string
  /** The flat, access-path-safe key every internal reference uses (see names.ts flatField). */
  field: string
  /** The user's field text, for titles. */
  source: string
  /** Expression materializing `field` from a nested/escaped source path (pipeline start). */
  flatExpr?: string
  type: string
  aggregate?: string
  /** `fill` / `stroke` channels are the colour machinery restricted to one paint */
  paint?: 'fill' | 'stroke'
  /** the field comes from a condition (the channel itself has none) */
  fromCondition?: boolean
  /** `scale: null`: the field's values are used as they are (no scale, no legend) */
  noScale?: boolean
  /** a `datum` def (no field): the constant is mapped through the channel's scale */
  datum?: unknown
  datumOnly?: boolean
  /** argmax/argmin aggregates: the arg field's flat key and the value path read from the winning row. */
  argAgg?: { op: 'argmax' | 'argmin'; arg: string; argSource: string; valuePath: string }
  bin?: boolean | Record<string, unknown>
  /** normalized bin params (maxbins default applied) when `bin` is set */
  binParams?: BinParams
  /** the time unit string WITHOUT the utc prefix (e.g. "yearmonth") */
  timeUnit?: string
  /** normalized time unit (utc flag, step) */
  tu?: NormalTimeUnit
  sort?: unknown
  stack?: unknown
  bandPosition?: number
  axis?: Record<string, unknown> | null
  scale?: Record<string, unknown>
  legend?: Record<string, unknown> | null
  title?: unknown
  raw: ChannelDef
}

const POSITIONAL = new Set(['x', 'y', 'x2', 'y2', 'xError', 'xError2', 'yError', 'yError2'])
const C = {
  blue: '#4c78a8',
  barPaddingInner: 0.1,
  pointPadding: 0.5,
  pointOpacity: 0.7,
  bandSize: 5,
  continuousBandSize: 5,
  // vega-lite getViewConfigDiscreteStep default (20) minus 2
  defaultStep: 18,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// --- entry -------------------------------------------------------------------

/**
 * Compile a Vega-Lite spec to Vega.
 *
 * The input is never mutated: it is cloned once up front (so every downstream
 * in-place edit lands on the private copy) and validated against the explicit
 * support tables in validate.ts. Unsupported or invalid input throws a
 * VLCompileError naming the feature; it is never silently degraded.
 */
export function compile(input: VLSpec): VLSpec {
  const first = compileOnce(input)
  // model.parse(): every view's selections are parsed BEFORE any view's data, so a predicate may name a selection that a view later in the
  // spec declares (a filter in one concat child, the brush in the next). A first pass finds those names, a second one resolves them.
  // The same goes for a lookup from a selection: the view that declares the selection makes the dataset of its selected rows, and
  // learns that a later view looks it up only from the first pass.
  const forwardSelections = first.misses.size > 0 && [...first.misses].some((n) => first.selections.has(n)) ? first.selections : undefined
  const forwardLookups = first.lookups.size > 0 ? first.lookups : undefined
  if (!forwardSelections && !forwardLookups) return first.out
  return compileOnce(input, forwardSelections, forwardLookups).out
}

function compileOnce(input: VLSpec, forward?: ReadonlyMap<string, SelCmpt>, forwardLookups?: ReadonlyMap<string, { name: string }>): { out: VLSpec; misses: ReadonlySet<string>; selections: ReadonlyMap<string, SelCmpt>; lookups: ReadonlyMap<string, { name: string }> } {
  const spec = cloneSpec(input)
  validateSpec(spec)
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  normalizeNestedFacetedUnits(spec, false)
  applyCompositionConfig(spec, spec)
  const normalized = alignStackOrders(normalizePathOverlays(normalizeComposites(spec, userConfig), userConfig ?? {}, unitStackProps), unitStackProps) as VLSpec
  // (the overlays are layers now: `config.<mark>.point / line` have done their job)
  if (userConfig) {
    const cfg = { ...userConfig }
    for (const m of ['line', 'area', 'rule', 'trail']) {
      if (isObject(cfg[m])) cfg[m] = Object.fromEntries(Object.entries(cfg[m] as Record<string, unknown>).filter(([k]) => k !== 'point' && k !== 'line'))
    }
    normalized.config = cfg
  }
  imageAsRect(normalized)
  pushSelectionParams(normalized, [])
  const ctx = makeCtx(normalized)
  if (forward) ctx.forwardSelections = forward
  if (forwardLookups) for (const [param, lookup] of forwardLookups) ctx.selectionLookups.set(param, lookup)
  const compiled = compileView(normalized, ctx)
  const selParts = SEL_PARTS.get(compiled)
  if (selParts) compiled.data = [...selParts.data, ...((compiled.data as Record<string, unknown>[] | undefined) ?? [])]
  const out = finalizeData(compiled, ctx)
  optimizeData(out, (name) => name.startsWith(ctx.dn(0).slice(0, -1)))
  // a named view names its marks after itself (vega-lite `model.getName`): `chart_marks`
  if (typeof normalized.name === 'string' && normalized.name !== '' && Array.isArray(out.marks)) {
    out.marks = (out.marks as Record<string, unknown>[]).map((m) => prefixMarkNames(m, `${signalSafe(normalized.name as string)}_`))
  }
  const signals = paramSignals(normalized)
  const layoutSignals = (out.signals as Record<string, unknown>[] | undefined) ?? []
  if (selParts) {
    // vega-lite's order: layout signals, the selections' top-level signals, the variable params, then the units' own
    out.signals = [...layoutSignals, ...selParts.top([]), ...signals, ...selParts.unit]
  } else if (signals.length) {
    out.signals = [...signals, ...layoutSignals]
  }
  assertNoGeoSignalClash(out)
  assembleGuides(out)
  return { out: exprRefsToSignals(out) as VLSpec, misses: ctx.selectionMisses, selections: ctx.selections, lookups: ctx.selectionLookups }
}


/**
 * axis/assemble.ts assembleAxis: a conditional axis property (`gridColor: {condition: {test, value}, value}`) is a custom
 * encoding of its part (grid / ticks / labels) for the corresponding Vega property, or a signal for the few that have no
 * fixed Vega property. Grid properties belong to the grid axis only.
 */
const CONDITIONAL_AXIS_PROPS: Record<string, { part: string; vgProp: string } | null> = {
  labelAlign: { part: 'labels', vgProp: 'align' }, labelBaseline: { part: 'labels', vgProp: 'baseline' }, labelColor: { part: 'labels', vgProp: 'fill' },
  labelFont: { part: 'labels', vgProp: 'font' }, labelFontSize: { part: 'labels', vgProp: 'fontSize' }, labelFontStyle: { part: 'labels', vgProp: 'fontStyle' },
  labelFontWeight: { part: 'labels', vgProp: 'fontWeight' }, labelOpacity: { part: 'labels', vgProp: 'opacity' }, labelOffset: null, labelPadding: null,
  gridColor: { part: 'grid', vgProp: 'stroke' }, gridDash: { part: 'grid', vgProp: 'strokeDash' }, gridDashOffset: { part: 'grid', vgProp: 'strokeDashOffset' },
  gridOpacity: { part: 'grid', vgProp: 'opacity' }, gridWidth: { part: 'grid', vgProp: 'strokeWidth' },
  tickColor: { part: 'ticks', vgProp: 'stroke' }, tickDash: { part: 'ticks', vgProp: 'strokeDash' }, tickDashOffset: { part: 'ticks', vgProp: 'strokeDashOffset' },
  tickOpacity: { part: 'ticks', vgProp: 'opacity' }, tickSize: null, tickWidth: { part: 'ticks', vgProp: 'strokeWidth' },
}
const GRID_ONLY_AXIS_PROPS = new Set(['gridColor', 'gridDash', 'gridDashOffset', 'gridOpacity', 'gridWidth', 'gridCap'])

function assembleGuides(node: unknown): void {
  if (Array.isArray(node)) { for (const n of node) assembleGuides(n); return }
  if (!isObject(node)) return
  // legend/assemble.ts: a falsy legend title (null, '') is no title
  if (Array.isArray(node.legends)) for (const lg of node.legends as Record<string, unknown>[]) if (isObject(lg) && 'title' in lg && !lg.title) delete lg.title
  if (Array.isArray(node.axes)) {
    for (const axis of node.axes as Record<string, unknown>[]) {
      if (!isObject(axis)) continue
      const isGrid = axis.grid === true
      for (const prop of Object.keys(axis)) {
        const value = axis[prop]
        if (!isGrid && GRID_ONLY_AXIS_PROPS.has(prop) && isObject(value) && value.condition !== undefined) { delete axis[prop]; continue }
        // a property that is a signal, with a Vega counterpart in a part's encode, moves there (assembleAxis); the others take signals themselves
        if (prop in CONDITIONAL_AXIS_PROPS && isObject(value) && value.condition === undefined && Object.keys(value).length === 1 && typeof (value.signal ?? value.expr) === 'string') {
          const index = CONDITIONAL_AXIS_PROPS[prop]
          if (index) {
            const encode = (isObject(axis.encode) ? axis.encode : (axis.encode = {})) as Record<string, Record<string, Record<string, unknown>>>
            const part = (encode[index.part] ??= {})
            ;(part.update ??= {})[index.vgProp] = { signal: (value.signal ?? value.expr) as string }
            delete axis[prop]
          }
          continue
        }
        if (!(prop in CONDITIONAL_AXIS_PROPS) || !isObject(value) || value.condition === undefined) continue
        const { condition, ...rest } = value
        const test = (c: Record<string, unknown>): Record<string, unknown> => {
          const { test: t, ...ref } = c
          return { test: typeof t === 'string' ? t : predicateExpr(t), ...ref }
        }
        const conditions = ([] as unknown[]).concat(condition) as Record<string, unknown>[]
        const index = CONDITIONAL_AXIS_PROPS[prop]
        if (index) {
          const encode = (isObject(axis.encode) ? axis.encode : (axis.encode = {})) as Record<string, Record<string, Record<string, unknown>>>
          const part = (encode[index.part] ??= {})
          ;(part.update ??= {})[index.vgProp] = [...conditions.map(test), rest]
          delete axis[prop]
        } else {
          const ref = (v: Record<string, unknown>): string => ('signal' in v ? String(v.signal) : JSON.stringify(v.value))
          axis[prop] = { signal: conditions.map((c) => { const { test: t, ...r } = c; return `${typeof t === 'string' ? t : predicateExpr(t)} ? ${ref(r)} : ` }).join('') + ref(rest) }
        }
      }
    }
  }
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object') assembleGuides(v)
}

/** vega-lite `stack(initMarkdef(markDef, encoding, config), encoding)`: the measure a unit stacks and how. */
function unitStackProps(unit: Record<string, unknown>): { fieldChannel: string; offset?: string; orient?: string } | undefined {
  const markRaw = unit.mark
  const mark = typeof markRaw === 'string' ? markRaw : isObject(markRaw) ? String(markRaw.type) : ''
  const encoding = isObject(unit.encoding) ? (unit.encoding as Record<string, unknown>) : {}
  const fields = parseEncodingFields(encoding, unit.config, markRaw)
  const orient = inferOrient(unit as VLSpec, mark, markRaw, fields)
  const measure = fields.find((f) => (f.channel === 'x' || f.channel === 'y') && isStacked(f, mark, orient, fields))
  return measure ? { fieldChannel: measure.channel, offset: measureStackOffset(measure), orient } : undefined
}

/**
 * The `geojson` transforms publish a signal each (`geojson_0`, `layer_1_geojson_0`...), which a projection's
 * fit reads: a parameter of the same name would be overwritten (vega-lite has the same hazard; here it throws).
 */
function assertNoGeoSignalClash(out: VLSpec): void {
  const names = new Set<string>()
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (!isObject(n)) return
    if (n.type === 'geojson' && typeof n.signal === 'string') names.add(n.signal)
    for (const [k, v] of Object.entries(n)) if (k !== 'values') visit(v)
  }
  visit(out.data)
  if (!names.size) return
  for (const sg of (out.signals as Record<string, unknown>[] | undefined) ?? []) {
    if (typeof sg.name === 'string' && names.has(sg.name)) {
      throw new VLCompileError(`the parameter "${sg.name}" has the name of a signal the map's geojson transform publishes (geojson_N, <layer>_geojson_N); rename the parameter`)
    }
  }
}

/**
 * vega-lite's normalizer (normalize/toplevelselection.ts) gives a selection parameter declared on a composition (concat,
 * facet, repeat) to every unit below it: each unit then declares the selection in its own group (a multi-view selection).
 * validate.ts has refused the cases where that would be wrong (a layer below, a unit with params of its own).
 */
function pushSelectionParams(node: unknown, inherited: Record<string, unknown>[]): void {
  if (!isObject(node)) return
  const concats = ['hconcat', 'vconcat', 'concat'].filter((k) => Array.isArray(node[k]))
  const composite = concats.length > 0 || (isObject(node.spec) && (node.facet !== undefined || node.repeat !== undefined))
  if (composite) {
    let carried = inherited
    if (Array.isArray(node.params)) {
      const own = (node.params as unknown[]).filter((p): p is Record<string, unknown> => isObject(p) && p.select !== undefined)
      if (own.length) {
        carried = [...inherited, ...own]
        const rest = (node.params as unknown[]).filter((p) => !(isObject(p) && p.select !== undefined))
        if (rest.length) node.params = rest
        else delete node.params
      }
    }
    for (const k of concats) for (const c of node[k] as unknown[]) pushSelectionParams(c, carried)
    if (isObject(node.spec)) pushSelectionParams(node.spec, carried)
    return
  }
  if (inherited.length && node.layer === undefined && node.mark !== undefined) node.params = inherited.map((p) => structuredClone(p))
}

/**
 * Variable parameters (anywhere in the spec tree) become Vega signals; they are
 * global in Vega-Lite, so they are declared once at the root. Interval
 * selections are handled by the unit compiler (static brush marks only).
 */
function paramSignals(root: VLSpec): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (!isObject(n)) return
    if (Array.isArray(n.params)) {
      for (const p of n.params as Record<string, unknown>[]) {
        if (p.select !== undefined) continue
        const sig: Record<string, unknown> = { name: p.name }
        if (p.expr !== undefined) {
          sig.update = p.expr
          if (p.react === false) sig.react = false
        } else if (isObject(p.value) && typeof p.value.expr === 'string') {
          sig.init = p.value.expr
        } else {
          sig.value = p.value
        }
        if (p.bind !== undefined) sig.bind = p.bind
        out.push(sig)
      }
    }
    for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) if (Array.isArray(n[k])) visit(n[k])
    if (isObject(n.spec)) visit(n.spec)
  }
  visit(root)
  return out
}

/**
 * Vega-Lite `{expr: "..."}` references become Vega `{signal: "..."}`; a
 * `{value: {expr}}` encode entry becomes `{signal}`. Data rows are user data and
 * are never rewritten.
 */
function exprRefsToSignals(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(exprRefsToSignals)
  if (!isObject(node)) return node
  const keys = Object.keys(node)
  if (keys.length === 1 && keys[0] === 'expr' && typeof node.expr === 'string') return { signal: node.expr }
  const out: Record<string, unknown> = {}
  // a geojson / geopoint transform's `fields` entries are per-datum expressions (`{expr}`), not signals
  const keepFields = node.type === 'geopoint' || node.type === 'geojson'
  for (const k of keys) {
    const v = node[k]
    // (a voronoi transform's x / y are Vega's own `{expr}` parameters)
    if (k === 'transform' && Array.isArray(v)) out[k] = v.map((t) => (isObject(t) && t.type === 'voronoi' ? t : exprRefsToSignals(t)))
    else if (k === 'values' || (keepFields && k === 'fields')) out[k] = v
    else if (k === 'value' && isObject(v) && Object.keys(v).length === 1 && typeof v.expr === 'string') out.signal = v.expr
    else out[k] = exprRefsToSignals(v)
  }
  return out
}

/** Prepend lookup source datasets (Vega resolves `lookup.from` by name at parse time). */
function finalizeData(out: VLSpec, ctx: CompileCtx): VLSpec {
  const data = (out.data as Record<string, unknown>[] | undefined) ?? []
  const have = new Set(data.map((d) => d.name as string))
  const extra: Record<string, unknown>[] = []
  for (const d of ctx.lookups.values()) if (!have.has(d.name as string)) extra.push(d)
  if (extra.length) out.data = [...extra, ...data]
  return out
}

function cloneSpec(input: VLSpec): VLSpec {
  if (!isObject(input)) throw new VLCompileError('a Vega-Lite spec must be a JSON object')
  try {
    return structuredClone(input)
  } catch (e) {
    throw new VLCompileError(`the spec must be plain JSON-compatible data (${(e as Error).message})`)
  }
}

/**
 * vega-lite lays an image mark out exactly like a rect (it is rect-based); only the emitted mark
 * differs. Every `image` mark def becomes a `rect` carrying `$image`, which buildMarks turns back.
 */
function imageAsRect(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(imageAsRect); return }
  if (!isObject(node)) return
  const m = node.mark
  if (m === 'image' || (isObject(m) && m.type === 'image')) node.mark = { ...(isObject(m) ? m : {}), type: 'rect', $image: true }
  for (const k of ['layer', 'hconcat', 'vconcat', 'concat', 'spec']) imageAsRect(node[k])
}

function compileView(spec: VLSpec, ctx: CompileCtx): VLSpec {
  if (isObject(spec.layer) || Array.isArray(spec.layer)) return compileLayered(spec, ctx)
  // facet forms: top-level {facet, spec}, encoding.facet {row?, column?}, or
  // the encoding shorthand row/column channels
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const hasEncFacet = isObject(enc.facet) || enc.row != null || enc.column != null
  if (isObject(spec.facet) || (isObject(spec.spec) && hasTopFacet(spec))) return compileFaceted(spec, ctx)
  if (hasEncFacet && spec.spec == null) return compileFaceted(spec, ctx)
  if (spec.repeat != null) return compileRepeat(spec, ctx)
  if (spec.concat || spec.hconcat || spec.vconcat) return compileConcat(spec, ctx)
  return compileUnitView(spec, ctx)
}

function hasTopFacet(spec: VLSpec): boolean {
  return isObject(spec.facet) || (spec.encoding != null && isObject((spec.encoding as Record<string, unknown>).facet))
}

// --- layer composition -------------------------------------------------------

/**
 * Orientation of a mark, ported from vega-lite 6.4.3 compile/mark/init.ts
 * `orient()`: marks without an orientation (point/circle/square/rect) are
 * 'vertical' here (the value is unused); line segments (a rule with x/x2 and
 * y/y2) have none, which this returns as 'vertical' too.
 */
function inferOrient(spec: VLSpec, mark: string, markRaw: unknown, fields: FieldDef[]): string {
  return markOrient(spec, mark, markRaw, fields) ?? 'vertical'
}

/**
 * mark/init.ts orient, exactly: undefined when vega-lite settles on none (a bar or tick over two non-measures, say). Marks read
 * that as "not vertical" (tick.ts) or as neither band channel (position-rect.ts isBarOrTickBand), so `inferOrient` says 'vertical'.
 */
function markOrient(spec: VLSpec, mark: string, markRaw: unknown, fields: FieldDef[]): string | undefined {
  if (!['bar', 'area', 'rule', 'tick', 'line', 'text'].includes(mark)) return 'vertical'
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const has = (ch: string): boolean => enc[ch] != null
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(cfg?.[mark]) ? (cfg![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(cfg?.mark) ? (cfg!.mark as Record<string, unknown>) : undefined
  const specified = ((isObject(markRaw) ? (markRaw.orient as string | undefined) : undefined)
    ?? (styleConfigProp(spec, mark, 'orient') as string | undefined)
    ?? (cfgType?.orient as string | undefined)
    ?? (cfgMark?.orient as string | undefined))
  const x2 = has('x2')
  const y2 = has('y2')
  let phase = mark === 'text' ? 'bar' : mark
  if (phase === 'bar') {
    // (init.ts orient: a pre-binned position decides the orientation)
    if (xDef?.field && isPrebinned(xDef)) return 'vertical'
    if (yDef?.field && isPrebinned(yDef)) return 'horizontal'
    if (xDef?.field && yDef?.aggregate && !xDef.aggregate && yDef.field) return 'vertical'
    if (yDef?.field && xDef?.aggregate && !yDef.aggregate && xDef.field) return 'horizontal'
    if (y2 || x2) {
      if (specified) return specified
      if (!x2) return 'vertical'
      if (!y2) return 'horizontal'
    }
    phase = 'rule'
  }
  if (phase === 'rule') {
    if (x2 && y2) return undefined // a line segment has no orientation
    phase = 'area'
  }
  if (phase === 'area') {
    if (y2) return 'vertical'
    if (x2) return 'horizontal'
    if (mark === 'rule') {
      if (has('x') && !has('y')) return 'vertical'
      if (has('y') && !has('x')) return 'horizontal'
    }
    phase = 'line'
  }
  // line / tick (and the fall-through of the others)
  const isMeasure = (f: FieldDef | undefined, ch: string): boolean => {
    if (f) return f.type === 'quantitative' && !f.bin
    const d = (enc[ch] as Record<string, unknown> | undefined)?.datum
    return typeof d === 'number'
  }
  const xIsMeasure = isMeasure(xDef, 'x')
  const yIsMeasure = isMeasure(yDef, 'y')
  if (specified) return specified
  if (xIsMeasure && !yIsMeasure) return mark !== 'tick' ? 'horizontal' : 'vertical'
  if (!xIsMeasure && yIsMeasure) return mark !== 'tick' ? 'vertical' : 'horizontal'
  if (xIsMeasure && yIsMeasure) return 'vertical'
  const xIsTemporal = xDef?.type === 'temporal'
  const yIsTemporal = yDef?.type === 'temporal'
  if (xIsTemporal && !yIsTemporal) return 'vertical'
  if (!xIsTemporal && yIsTemporal) return 'horizontal'
  return undefined
}

const LEAF_PATHS = new WeakMap<VLSpec, number[]>()
/** For a layer's leaf unit: how many layers deep (0 = the root) the node that declared each of its transforms sits. */
const TRANSFORM_DEPTHS = new WeakMap<VLSpec, number[]>()

/**
 * Flatten a layer tree into its leaf unit specs. Each leaf inherits, from every
 * ancestor layer: the shared `encoding` (the child overrides per channel), the
 * `data` (a node's own data replaces the inherited one and restarts the
 * transform chain, because a parent's transform belongs to the parent's data),
 * and the `transform` chain; `config` is global and always the root's.
 */
function collectLeaves(root: VLSpec): VLSpec[] {
  const leaves: VLSpec[] = []
  interface Inherited { encoding: Record<string, unknown>; data: unknown; transform: unknown[]; depths: number[]; projection?: unknown }
  // (the layer indices above each leaf: vega-lite names a nested layer's marks `layer_0_layer_1_marks`)
  const visit = (node: VLSpec, inh: Inherited, path: number[] = []): void => {
    let data = inh.data
    let transform = [...inh.transform]
    let depths = [...inh.depths]
    if (node.data !== undefined) {
      data = node.data
      transform = []
      depths = []
    }
    if (Array.isArray(node.transform)) {
      pushAll(transform, node.transform as Record<string, unknown>[])
      for (const _t of node.transform) depths.push(path.length)
    }
    const encoding = mergeEncoding(inh.encoding, node.encoding)
    if (Array.isArray(node.layer)) {
      const projection = node.projection !== undefined ? node.projection : inh.projection
      ;(node.layer as VLSpec[]).forEach((c, i) => visit(c, { encoding, data, transform, depths, projection }, [...path, i]))
      return
    }
    // a layer's projection reaches its units (vega-lite normalize mergeProjection: the child's own wins)
    const projection = node.projection !== undefined ? node.projection : inh.projection
    // (a channel only the layer gave, and only partially - a type, a scale, an axis, no field - encodes nothing in the unit)
    const unitEncoding: Record<string, unknown> = {}
    for (const [ch, def] of Object.entries(encoding)) {
      const partial = isObject(def) && def.field === undefined && def.datum === undefined && def.value === undefined && def.condition === undefined && def.aggregate !== 'count' && def.expr === undefined
      if (!partial) unitEncoding[ch] = def
    }
    const leaf: VLSpec = { ...node, encoding: unitEncoding, ...(projection !== undefined ? { projection } : {}) }
    LEAF_PATHS.set(leaf, path)
    TRANSFORM_DEPTHS.set(leaf, depths)
    if (isGraticuleData(node.data)) GRATICULE_UNITS.add(leaf)
    if (data !== undefined) leaf.data = data
    else delete leaf.data
    if (transform.length) leaf.transform = transform
    else delete leaf.transform
    if (root.config !== undefined) leaf.config = root.config
    // variable params are global (declared once at the root); a unit's selection params stay with the unit
    const own = selectionParamsOf(node)
    if (own.length) leaf.params = own
    else delete leaf.params
    leaves.push(leaf)
  }
  visit(root, { encoding: {}, data: undefined, transform: [], depths: [] })
  return leaves
}

/** A width/height spec: a fixed size, a {step} request, "container" or unspecified. */
interface SizeReq { fixed?: number; step?: number; stepFor?: 'position' | 'offset'; container?: boolean }
function sizeSpec(v: unknown): SizeReq {
  if (v === 'container') return { container: true }
  if (typeof v === 'number') return { fixed: v }
  if (isObject(v) && typeof v.step === 'number') return { step: v.step, ...(v.for === 'position' || v.for === 'offset' ? { stepFor: v.for } : {}) }
  return {}
}

/**
 * How a view is sized along one dimension: vega-lite `layoutsize/parse.ts defaultUnitSize` over the spec's own
 * width / height. `scaleType` is the type of the x / y scale (undefined: the view has none, a 1D view);
 * `continuousDefault` is the geoshape / projection / arc rule (they take the continuous size).
 */
type ViewSize = { step: number } | { fixed: number } | { container: true }
function sizePlan(spec: VLSpec, sizeType: 'width' | 'height', req: SizeReq, scaleType: string | undefined, continuousDefault: boolean): ViewSize {
  if (req.container) return { container: true }
  const discreteScale = scaleType === 'band' || scaleType === 'point'
  if (req.step !== undefined && discreteScale) return { step: req.step }
  if (req.fixed !== undefined) return { fixed: req.fixed }
  if (scaleType === undefined && !continuousDefault) {
    const d = viewDiscreteSize(spec, sizeType)
    return { fixed: typeof d === 'number' ? d : d.step }
  }
  if (discreteScale) {
    const d = viewDiscreteSize(spec, sizeType)
    return typeof d === 'number' ? { fixed: d } : { step: d.step }
  }
  return { fixed: viewContinuousSize(spec, sizeType) }
}

/**
 * width / height: "container": the view takes the size of its host element (vega-lite's
 * containerSize signals, autosize fit / fit-x / fit-y over the padding).
 */
function containerSizing(spec: VLSpec, w: { container?: boolean }, h: { container?: boolean }): { autosize: unknown; signals: Record<string, unknown>[] } | undefined {
  if (!w.container && !h.container) return undefined
  const user = autosizeOf(spec)
  const fit = { type: w.container && h.container ? 'fit' : w.container ? 'fit-x' : 'fit-y', contains: 'padding' }
  const signal = (name: string, i: number): Record<string, unknown> => {
    const expr = `isFinite(containerSize()[${i}]) ? containerSize()[${i}] : 300`
    return { name, init: expr, on: [{ update: expr, events: 'window:resize' }] }
  }
  return {
    autosize: { ...fit, ...(typeof user === 'string' ? { type: user } : isObject(user) ? user : {}) },
    signals: [...(w.container ? [signal('width', 0)] : []), ...(h.container ? [signal('height', 1)] : [])],
  }
}

/**
 * vega-lite `UnitModel.assembleGroupStyle`: the `style` of the unit's `view` background, else a unit with an x or y channel is a
 * `cell` (framed) and any other a `view`.
 */
function unitGroupStyle(spec: VLSpec): string | string[] {
  const view = isObject(spec.view) ? spec.view : undefined
  if (view?.style !== undefined) return view.style as string | string[]
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  return enc.x != null || enc.y != null ? 'cell' : 'view'
}

/** vega-lite `LayerModel.assembleGroupStyle`: the unique styles of the layers' units, in order (none gives `undefined`). */
function layeredGroupStyle(leaves: VLSpec[]): string | string[] | undefined {
  const styles = [...new Set(leaves.flatMap((l) => ([] as string[]).concat(unitGroupStyle(l))))]
  return styles.length > 1 ? styles : styles[0]
}

/**
 * vega-lite `Model.assembleGroupEncodeEntry` (assembleEncodeFromView): the `view` background of a unit or layer, minus its
 * `style`, becomes the group's own encode (`fill`, `stroke: null`, ...). Undefined when there is none.
 */
function viewEncode(spec: VLSpec): { update: Record<string, unknown> } | undefined {
  if (!isObject(spec.view)) return undefined
  const update: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec.view)) {
    if (k !== 'style' && v !== undefined) update[k] = { value: v }
  }
  return Object.keys(update).length ? { update } : undefined
}

/**
 * normalize/facet.ts normalizeFacetedUnit: a unit with a `row`, `column` or `facet` channel is a facet operator over the unit that
 * keeps the other channels; the layout properties stay on the facet. The top-level unit is compiled in its encoded form; the ones
 * nested in a composition become the operator here.
 */
function normalizeNestedFacetedUnits(node: unknown, nested: boolean): void {
  if (!isObject(node)) return
  for (const k of ['hconcat', 'vconcat', 'concat']) {
    const kids = node[k]
    if (Array.isArray(kids)) kids.forEach((c, i) => { kids[i] = normalizeNestedFacetedUnit(c); normalizeNestedFacetedUnits(kids[i], true) })
  }
  if (Array.isArray(node.layer)) node.layer.forEach((c) => normalizeNestedFacetedUnits(c, nested))
  if (isObject(node.spec)) {
    if (node.repeat !== undefined) node.spec = normalizeNestedFacetedUnit(node.spec)
    normalizeNestedFacetedUnits(node.spec, true)
  }
}

function normalizeNestedFacetedUnit(c: unknown): unknown {
  if (!isObject(c) || c.mark === undefined || !isObject(c.encoding)) return c
  const { row, column, facet, ...encoding } = c.encoding as Record<string, unknown>
  if (row == null && column == null && facet == null) return c
  const { mark, width, height, view, projection, params, encoding: _e, ...outer } = c
  void _e
  const inner: Record<string, unknown> = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(view !== undefined ? { view } : {}), ...(projection !== undefined ? { projection } : {}), ...(params !== undefined ? { params } : {}), mark, encoding }
  const mapping = facet != null ? facet : { ...(row != null ? { row } : {}), ...(column != null ? { column } : {}) }
  return { ...outer, facet: mapping, spec: inner }
}

/**
 * spec/base.ts extractCompositionLayout: `config.concat` (concat, hconcat, vconcat and repeat) and `config.facet` give a composition
 * its default `spacing` and, for a concat or a wrapped facet, its `columns`; the spec's own values win (a partial row / column
 * spacing falls back to the config's). Applied to every composition of the tree.
 */
function applyCompositionConfig(node: VLSpec, root: VLSpec): void {
  const cfg = isObject(root.config) ? (root.config as Record<string, unknown>) : undefined
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (!isObject(n)) return
    const enc = isObject(n.encoding) ? (n.encoding as Record<string, unknown>) : {}
    const facetedUnit = n.mark !== undefined && (enc.row != null || enc.column != null || enc.facet != null)
    const type = n.facet !== undefined || facetedUnit ? 'facet' : n.hconcat !== undefined || n.vconcat !== undefined || n.concat !== undefined || n.repeat !== undefined ? 'concat' : undefined
    const c = type && isObject(cfg?.[type]) ? (cfg![type] as Record<string, unknown>) : undefined
    // (a partial `{row}` / `{column}` spacing fills the other direction from the config, whose default spacing is 20: config.ts defaultConfig)
    if (type && isObject(n.spacing)) {
      const dflt = typeof c?.spacing === 'number' ? c.spacing : 20
      n.spacing = { row: n.spacing.row ?? dflt, column: n.spacing.column ?? dflt }
    }
    if (c) {
      if (typeof c.spacing === 'number') {
        if (n.spacing === undefined) n.spacing = c.spacing
      }
      const wrapped = type === 'facet' ? (isObject(n.facet) ? n.facet.row === undefined && n.facet.column === undefined : isObject(enc.facet) && enc.row === undefined && enc.column === undefined) : n.concat !== undefined || (n.repeat !== undefined && Array.isArray(n.repeat))
      if (c.columns !== undefined && wrapped && n.columns === undefined && !(isObject(enc.facet) && enc.facet.columns !== undefined)) n.columns = c.columns
    }
    for (const k of ['hconcat', 'vconcat', 'concat', 'layer']) if (Array.isArray(n[k])) visit(n[k])
    if (isObject(n.spec)) visit(n.spec)
  }
  visit(node)
}

/** The merged title of a layered axis on a field def: it replaces the def's own title, and its axis title when it has one. */
function withAxisTitle(f: FieldDef, title: string): FieldDef {
  return { ...f, title, ...(isObject(f.axis) && typeof f.axis.title === 'string' ? { axis: { ...f.axis, title } } : {}) } as FieldDef
}

/** Compile a multi-layer spec: per-source casts, per-layer pipelines,
 * unioned scales, one mark group per layer. */
function compileLayered(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const leaves = collectLeaves(spec)
  const wSpec = sizeSpec(spec.width)
  const hSpec = sizeSpec(spec.height)

  interface ParsedLayer {
    l: VLSpec
    mark: string
    markRaw: unknown
    markSize?: number
    fields: FieldDef[]
    orient: string
    pipeline: Record<string, unknown>[]
    seriesFields: FieldDef[]
    dataName: string
    rawName: string
    rawLen: number
    usesRawDomain: boolean
    group: number
    /** the scales read the rows before / after the invalid filter */
    invalidSplit?: InvalidScaleSplit
    /** the dataset the scales' domains read */
    scaleName: string
  }
  const parsed: ParsedLayer[] = leaves.map((l) => {
    liftBandSizeValue(l)
    const markRaw = l.mark
    const mark = typeof markRaw === 'string' ? markRaw : (markRaw as Record<string, unknown>).type as string
    const encoding = isObject(l.encoding) ? (l.encoding as Record<string, unknown>) : {}
    checkConstChannels(mark, encoding, markIsFilled(l, mark))
    // (a layer's encoding merged into this unit: the map rules apply to the result)
    validateGeoUnit(mark, encoding, 'encoding')
    const fields = parseEncodingFields(encoding, l.config, markRaw)
    const orient = inferOrient(l, mark, markRaw, fields)
    return { l, mark, markRaw, markSize: isObject(markRaw) ? (markRaw.size as number | undefined) : undefined, fields, orient, pipeline: [], seriesFields: [], dataName: '', rawName: '', rawLen: 0, usesRawDomain: false, group: 0, scaleName: '' }
  })

  for (const p of parsed) {
    if (p.fields.some((f) => isObject(f.scale?.domain) && Array.isArray((f.scale!.domain as Record<string, unknown>).unionWith))) {
      throw new VLCompileError('scale.domain {"unionWith": [...]} in a layered spec is not supported: the layers\' domains would have to merge with it')
    }
  }
  // selections: every unit's are parsed up front (a condition in one layer may test a selection of another)
  const resolveScaleEarly = isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale)
    ? ((spec.resolve as Record<string, Record<string, unknown>>).scale as Record<string, unknown>)
    : {}
  const layerSel: Array<UnitSel | undefined> = parsed.map((p, i) => {
    SPEC_CTX.set(p.l, ctx)
    const path = LEAF_PATHS.get(p.l)
    const sel = prepareUnitSelections(p.l, p.fields, p.mark, ctx, {
      unitName: childModelName(ctx.modelName, path?.length ? path.map((n) => `layer_${n}`).join('_') : `layer_${i}`),
      scaleName: (c) => (c === 'y' && resolveScaleEarly.y === 'independent' ? `layer_${i}_y` : c),
    })
    collectDomainParams(p.l, p.fields, ctx)
    if (sel?.pointer && !(isObject(p.markRaw) && p.markRaw.cursor !== undefined)) {
      p.l.mark = { ...(isObject(p.markRaw) ? p.markRaw : { type: p.markRaw }), cursor: 'pointer' }
    }
    return UNIT_SEL.get(p.l)
  })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = VEGA_SCHEMA
  out.autosize = autosizeOf(spec) ?? 'pad'
  // theta-only layered views (pie labels) use the unstyled 'view' frame
  // vega-lite assembleGroupStyle: the unique styles of the layers, in order
  {
    out.style = layeredGroupStyle(parsed.map((p) => p.l))
    const layerView = viewEncode(spec)
    if (layerView) out.encode = layerView
  }

  // Layers are grouped by the data they read: layers sharing a source share
  // its dataset and one casts dataset; a layer with its own `data` gets its own.
  const groupKey = (l: VLSpec): string => (l.data === undefined ? '' : JSON.stringify(l.data))
  const groupKeys: string[] = []
  for (const p of parsed) {
    const k = groupKey(p.l)
    let gi = groupKeys.indexOf(k)
    if (gi < 0) {
      groupKeys.push(k)
      gi = groupKeys.length - 1
    }
    p.group = gi
  }
  interface Group { sourceName: string; castDone: Set<string>; casts: Record<string, unknown>[]; source: Record<string, unknown>; castsName: string }
  const groups: Group[] = groupKeys.map((k, gi) => {
    const dataDef = k === '' ? undefined : (parsed.find((p) => p.group === gi)!.l.data as Record<string, unknown>)
    const source: Record<string, unknown> = dataDef ? dataSource(dataDef, ctx.datasets) : {}
    // vega-lite preserves a declared source dataset name (data: {name: 'table'})
    // — hosts key data overrides/changesets on it, so renaming to source_0 breaks them.
    const sourceName = typeof source.name === 'string' ? source.name : ctx.takeSource()
    source.name = sourceName
    return { sourceName, castDone: new Set<string>(), casts: [], source, castsName: sourceName }
  })
  const geoPlan = parsed.some((p) => hasProjection(p.mark, isObject(p.l.encoding) ? (p.l.encoding as Record<string, unknown>) : {}))
    ? planLayerProjections(spec, parsed)
    : undefined
  for (const p of parsed) {
    const g = groups[p.group]!
    const d = buildData(p.l, p.fields, p.mark, p.orient, g.castDone, ctx)
    g.casts.push(...d.casts)
    p.pipeline = d.pipeline
    p.seriesFields = d.seriesFields
    p.rawLen = d.rawLen
    p.usesRawDomain = d.usesRawDomain
    p.invalidSplit = d.invalidSplit
  }

  // data: per source group the source + casts dataset, then one derived
  // dataset per layer that needs a pipeline; layers without transforms read
  // their casts dataset directly
  const data: Record<string, unknown>[] = []
  let nextData = 0
  for (const g of groups) {
    data.push(g.source)
    if (g.casts.length) {
      g.castsName = ctx.dn(nextData++)
      data.push({ name: g.castsName, source: g.sourceName, transform: g.casts })
    }
  }
  const perLayerScales: ScaleSpec[][] = []
  const perLayerMarks: Record<string, unknown>[][] = []
  // size scales/domains need sizes only through signals, resolved after merging
  const width: unknown = wSpec.fixed ?? viewContinuousSize(spec, 'width')
  const height: unknown = hSpec.fixed ?? viewContinuousSize(spec, 'height')
  parsed.forEach((p, i) => {
    const g = groups[p.group]!
    let rawName: string
    if (p.pipeline.length) {
      if (p.usesRawDomain && p.pipeline.length > p.rawLen && p.rawLen === 0) {
        const dataName = ctx.dn(nextData++)
        data.push({ name: dataName, source: g.castsName, transform: p.pipeline })
        p.dataName = dataName
        rawName = g.castsName
      } else if (p.usesRawDomain && p.pipeline.length > p.rawLen) {
        rawName = ctx.dn(nextData++)
        data.push({ name: rawName, source: g.castsName, transform: p.pipeline.slice(0, p.rawLen) })
        const dataName = ctx.dn(nextData++)
        data.push({ name: dataName, source: rawName, transform: p.pipeline.slice(p.rawLen) })
        p.dataName = dataName
      } else {
        const dataName = ctx.dn(nextData++)
        data.push({ name: dataName, source: g.castsName, transform: p.pipeline })
        p.dataName = dataName
        rawName = dataName
      }
    } else {
      p.dataName = g.castsName
      rawName = g.castsName
    }
    // (data/parse.ts: the scales read the rows before / after the invalid filter when the marks do not)
    p.scaleName = p.dataName
    if (p.invalidSplit) {
      const wasRaw = rawName === p.dataName
      const split = splitInvalidData(data, p.invalidSplit, p.dataName, g.castsName, () => ctx.dn(nextData++))
      p.dataName = split.dataName
      p.scaleName = split.scaleName
      if (wasRaw && p.invalidSplit.kind === 'pre') rawName = split.scaleName
    }
    p.rawName = rawName
    // a lookup from this unit's selection reads its data filtered by the selection (materializeSelections)
    for (const c of Object.values(layerSel[i]?.cmpts ?? {})) {
      const lookup = ctx.selectionLookups.get(c.name)
      if (lookup) data.push({ name: lookup.name, source: p.dataName, transform: [{ type: 'filter', expr: ctx.selectionTest!({ param: c.name }) }] })
    }
    const builtMarks = buildMarks(p.l, p.fields, p.mark, p.orient, p.dataName, p.markSize)
    uniquifyLayerMarks(builtMarks, LEAF_PATHS.get(p.l)?.length ? LEAF_PATHS.get(p.l)!.map((n) => `layer_${n}`).join('_') : i)
    perLayerMarks.push(builtMarks)
    const layerScales = buildScales(p.l, p.fields, p.mark, p.orient, p.scaleName, wSpec, hSpec, p.seriesFields, p.rawName)
    // (shared scales are judged merged, below; an independent y scale is the layer's own)
    if (isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale) && ((spec.resolve as Record<string, Record<string, unknown>>).scale as Record<string, unknown>).y === 'independent') showInvalidValues(p.l, p.fields, p.mark, layerScales, builtMarks, (ch) => ch === 'y')
    perLayerScales.push(layerScales)
    // bin.ts getBinSignalName: the signals of a unit's bins are named after the unit's model (`model.getName`), here the layer
    const path = LEAF_PATHS.get(p.l)
    const unitName = path?.length ? path.map((n) => `layer_${n}`).join('_') : `layer_${i}`
    const own = new Map<string, string>()
    for (const t of p.pipeline) if ((t.type === 'bin' || t.type === 'extent') && typeof t.signal === 'string' && !USER_TRANSFORMS.has(t)) own.set(t.signal, `${unitName}_${t.signal}`)
    if (own.size) {
      const r = { signals: own, scales: new Map<string, string>() }
      renameFragment(p.pipeline, r)
      renameFragment(builtMarks, r)
      renameFragment(layerScales, r)
    }
  })
  // optimize/mergebins.ts: the layers that bin the same field with the same parameters share ONE bin node. Its extent is taken once,
  // over the rows of the first layer's pipeline; a later layer (a filtered one, say) bins with that extent instead of writing the
  // signal again over its own rows. The shared signals keep the name of the last layer that has them (MergeBins pops the last promotable
  // bin and merges the others into it, `renameSignal(other, this)`)
  {
    const layerPrefix = /^(?:layer_\d+_)+/
    const lastOf = new Map<string, string>()
    for (const d of data) for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) {
      if ((t.type === 'extent' || t.type === 'bin') && typeof t.signal === 'string') lastOf.set(t.signal.replace(layerPrefix, ''), t.signal)
    }
    const merged = new Map<string, string>()
    for (const d of data) for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) {
      if ((t.type === 'extent' || t.type === 'bin') && typeof t.signal === 'string') {
        const winner = lastOf.get(t.signal.replace(layerPrefix, ''))!
        if (winner !== t.signal) merged.set(t.signal, winner)
      }
    }
    if (merged.size) {
      const r = { signals: merged, scales: new Map<string, string>() }
      renameFragment(data, r)
      renameFragment(perLayerMarks, r)
      renameFragment(perLayerScales, r)
    }
    const signals = new Set<string>()
    for (const d of data) {
      const tf = d.transform as Record<string, unknown>[] | undefined
      if (!tf?.some((t) => (t.type === 'extent' || t.type === 'bin') && typeof t.signal === 'string')) continue
      d.transform = tf.flatMap((t) => {
        if ((t.type !== 'extent' && t.type !== 'bin') || typeof t.signal !== 'string') return [t]
        const first = !signals.has(t.signal)
        signals.add(t.signal)
        if (first) return [t]
        // (a signal is declared once: the later bin only writes its fields, reading the shared extent)
        if (t.type === 'extent') return []
        const { signal: _dropped, ...rest } = t
        return [rest]
      })
    }
  }
  // a lookup reads its source dataset by name, which must be declared before it (vega resolves names in order)
  {
    const at = new Map(data.map((d, i) => [d.name as string, i]))
    data.forEach((d, i) => {
      for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) {
        const src = t.type === 'lookup' && typeof t.from === 'string' ? at.get(t.from) : undefined
        if (src !== undefined && src > i) throw new VLCompileError('a lookup from a selection must come after the layer that declares the selection')
      }
    })
  }
  // the selections' store datasets, in vega-lite's order (each unit's go in front of what came before)
  const selData: Record<string, unknown>[] = []
  for (const sel of layerSel) {
    if (!sel?.unit) continue
    const stores = assembleUnitSelectionData(sel.unit, sel.cmpts, new Set([...selData, ...data].map((d) => d.name as string)))
    for (let k = stores.length - 1; k >= 0; k--) selData.unshift(stores[k]!)
  }
  out.data = data
  if (geoPlan) {
    const projections = geoPlan.assemble((leaf) => parsed.find((p) => p.l === leaf)!.dataName)
    if (projections.length) out.projections = projections
    if (geoPlan.root) FRAG_PROJECTION.set(out, geoPlan.root)
  }

  // y2/x2 endpoint fields extend the layer's positional scale domain
  parsed.forEach((p, i) => {
    for (const [main, second] of [['y', 'y2'], ['x', 'x2']] as const) {
      const d2 = p.fields.find((f) => f.channel === second && f.field && !f.datumOnly)
      if (!d2) continue
      const sc = perLayerScales[i]?.find((s) => s.name === main)
      if (!sc) continue
      const d = sc.domain as { data?: string; field?: string; fields?: unknown; sort?: unknown } | undefined
      if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.data === 'string') {
        const fieldList = Array.isArray(d.fields) ? [...d.fields as string[]] : [d.field as string]
        // (the secondary channel's own field - its aggregate / time unit applied)
        if (!fieldList.includes(aggFieldName(d2))) fieldList.push(aggFieldName(d2))
        // (the secondary channel's domain is sorted as the primary's is: domain.ts domainSort)
        sc.domain = { data: d.data, fields: fieldList, ...(d.sort !== undefined ? { sort: d.sort } : {}) }
      }
    }
  })

  // independent y resolution (dual-axis layers): each layer's y scale gets a
  // unique name; the first layer keeps the left axis with grid, subsequent
  // layers move to a right axis without grid
  const resolveScale = isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale)
    ? ((spec.resolve as Record<string, Record<string, unknown>>).scale as Record<string, unknown>)
    : {}
  // resolve.ts / scale/assemble.ts: a scale of a non-position channel is the layer's own when the spec asks for it (resolve.scale) or
  // when the layers' scales are of different families; it is then named after its layer (`layer_0_color`), and so are its references
  const indepChannels = new Set<string>()
  for (const ch of INDEPENDENT_CAPABLE_CHANNELS) {
    const own = perLayerScales.map((ls) => ls.find((sc) => sc.name === ch)).filter((sc): sc is ScaleSpec => sc !== undefined)
    if (own.length < 2 && resolveScale[ch] !== 'independent') continue
    if (resolveScale[ch] === 'independent' || own.some((sc) => !compatibleScaleTypes(String(own[0]!.type), String(sc.type)))) indepChannels.add(ch)
  }
  const indepScaleNames = new Set<string>()
  for (const ch of indepChannels) {
    parsed.forEach((_p, i) => {
      const sc = perLayerScales[i]?.find((x) => x.name === ch)
      if (!sc) return
      const named = `layer_${i}_${ch}`
      sc.name = named
      indepScaleNames.add(named)
      const rewrite = (m: Record<string, unknown>): void => {
        const upd = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
        if (upd) for (const v of Object.values(upd)) for (const r of ([] as unknown[]).concat(v ?? [])) if (isObject(r) && r.scale === ch) r.scale = named
        for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) rewrite(sub)
      }
      for (const m of perLayerMarks[i] ?? []) rewrite(m)
    })
  }
  const indepY = resolveScale.y === 'independent'
  if (indepY) {
    const firstY = parsed.findIndex((p) => p.fields.some((f) => f.channel === 'y'))
    parsed.forEach((p, i) => {
      const yScale = perLayerScales[i]?.find((s) => s.name === 'y')
      if (!yScale || !p.fields.some((f) => f.channel === 'y')) return
      yScale.name = `layer_${i}_y`
      const rewrite = (m: Record<string, unknown>): void => {
        const enc = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
        if (enc) {
          for (const k of ['y', 'y2', 'yc']) {
            // (a position with an invalid-value test is a list of refs)
            for (const v of ([] as unknown[]).concat(enc[k] ?? []) as Array<Record<string, unknown> | undefined>) {
              if (v && v.scale === 'y') v.scale = `layer_${i}_y`
            }
          }
        }
        for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) rewrite(sub)
      }
      for (const m of perLayerMarks[i] ?? []) rewrite(m)
    })
    void firstY
  }

  let marks: Record<string, unknown>[] = perLayerMarks.flat()
  out.marks = marks

  // with independent y, the y scales stay per-layer (renamed); the remaining
  // scales still merge across layers
  const isIndepYScale = (s: ScaleSpec): boolean => s.name.startsWith('layer_') && s.name.endsWith('_y')
  const isOwnScale = (s: ScaleSpec): boolean => indepScaleNames.has(s.name)
  const scales = indepY
    ? [...mergeLayerScales(perLayerScales.map((ls) => ls.filter((s) => s.name !== 'y' && !isIndepYScale(s) && !isOwnScale(s)))), ...perLayerScales.flat().filter(isIndepYScale), ...perLayerScales.flat().filter(isOwnScale)]
    : indepScaleNames.size
      ? [...mergeLayerScales(perLayerScales.map((ls) => ls.filter((s) => !isOwnScale(s)))), ...perLayerScales.flat().filter(isOwnScale)]
      : mergeLayerScales(perLayerScales)
  out.scales = scales
  applyScaleConfig(scales, isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined)
  // invalid = "show": a layer positions its invalid values against the scale it shares, not its own (a point's zero-including
  // scale does not decide for the line it is merged with)
  perLayerMarks.forEach((ms) => resolveZeroOrMin(ms, scales as ScaleSpec[]))
  parsed.forEach((p, i) => showInvalidValues(p.l, p.fields, p.mark, scales, perLayerMarks[i]!, indepY ? (ch) => ch !== 'y' : undefined))
  centerPointMarksOnBands(marks, scales)
  // selections: scales that follow a param, the marks' interactive flags and clip, the units' brush / voronoi marks
  let layerClip = false
  parsed.forEach((p, i) => {
    const sel = UNIT_SEL.get(p.l)
    if (!sel) return
    sel.scales = scales
    // (the first unit to bind a scale names the param; vega-lite warns when units disagree)
    if (applyScaleExtents(sel, scales.filter((sc) => sc.domainRaw === undefined), (c) => layerSel[i]?.unit?.scaleName(c) ?? c, ctx)) layerClip = true
  })
  parsed.forEach((p, i) => {
    if (ctx.anySelection || layerClip) flagSelectionMarks(perLayerMarks[i]!, ctx.anySelection, interactiveUnit(p.l, p.mark, p.fields, Object.keys(layerSel[i]?.cmpts ?? {}).length > 0), layerClip)
  })
  for (const sel of layerSel) if (sel?.unit) marks = assembleSelectionMarks(sel.unit, sel.cmpts, marks)
  out.marks = marks

  // axes: one per positional channel, from the first layer that encodes it,
  // with the axis title unioned across layers (vega-lite joins ', ')
  const axes: Record<string, unknown>[] = []
  const firstYLayer = parsed.findIndex((p) => p.fields.some((f) => f.channel === 'y'))
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  for (const ch of ['x', 'y'] as const) {
    if (ch === 'y' && indepY) {
      parsed.forEach((p, i) => {
        const yDef = p.fields.find((f) => f.channel === 'y' && f.axis !== null)
        if (!yDef || !perLayerScales[i]?.some((s) => s.name === `layer_${i}_y`)) return
        const isFirst = i === firstYLayer
        const axisDefs = buildAxes([yDef], axisMark(p.markRaw, p.mark), perLayerScales[i]!, `layer_${i}_y`, undefined, userConfig)
        for (const a of axisDefs) {
          ;(a as Record<string, unknown>).scale = `layer_${i}_y`
          const gridAxis = (a as Record<string, unknown>).gridScale != null
          if (!isFirst) {
            // subsequent independent y axes: right-orient, no grid
            ;(a as Record<string, unknown>).orient = (a as Record<string, unknown>).orient === 'left' ? 'right' : (a as Record<string, unknown>).orient
            if (gridAxis) continue
          }
          axes.push(a)
        }
      })
      continue
    }
    const layersWith = parsed.filter((p) => p.fields.some((f) => f.channel === ch && f.axis !== null))
    if (!layersWith.length) continue
    const base = layersWith[0]!
    const second = ch === 'y' ? 'y2' : 'x2'
    // per layer: the channel's title followed by its endpoint field
    const titles: string[] = []
    const given: string[] = []
    let nullTitle = false
    for (const p of layersWith) {
      const f = p.fields.find((q) => q.channel === ch)!
      const d2 = p.fields.find((q) => q.channel === second && q.field)
      // an explicit title on either endpoint replaces the generated "primary, secondary" pair
      // (an explicit null title - on the field or its axis - removes the axis title: common.ts mergeTitleComponent)
      if (f.title === null || d2?.title === null || (isObject(f.axis) && f.axis.title === null)) nullTitle = true
      // (an `axis.title` is explicit as well, and the whole title of that layer's axis)
      const axisTitle = isObject(f.axis) && typeof f.axis.title === 'string' && f.axis.title !== '' ? f.axis.title : undefined
      const explicit = axisTitle !== undefined ? [axisTitle] : [f.title, d2?.title].filter((x): x is string => typeof x === 'string' && x !== '')
      if (explicit.length) { given.push(explicit.join(', ')); continue }
      const t = ((f.axis as Record<string, unknown> | null | undefined)?.title as string) ?? (channelTitle(f) as string)
      if (t) titles.push(t)
      if (d2 && !d2.datumOnly) titles.push(d2.source)
    }
    // titles the user wrote win over the ones derived from fields (mergeTitleComponent)
    const uniq = Array.from(new Set(given.length ? given : titles))
    const axisFields = base.fields.filter((f) => f.channel === ch).map((f) =>
      nullTitle ? ({ ...f, title: null } as unknown as FieldDef) : uniq.length > 1 || given.length ? withAxisTitle(f, uniq.join(', ')) : f,
    )
    const gridScaleName = ch === 'x' && indepY ? `layer_${firstYLayer}_y` : undefined
    const built = buildAxes(axisFields, axisMark(base.markRaw, base.mark), scales as ScaleSpec[], undefined, gridScaleName, userConfig)
    // axis/parse.ts mergeAxisComponent: what the first layer's axis lacks (a time unit's format and tick step, say) comes from the
    // other layers that share it
    for (const other of layersWith.slice(1)) {
      const otherFields = other.fields.filter((f) => f.channel === ch).map((f) =>
        nullTitle ? ({ ...f, title: null } as unknown as FieldDef) : uniq.length > 1 || given.length ? withAxisTitle(f, uniq.join(', ')) : f,
      )
      for (const a2 of buildAxes(otherFields, axisMark(other.markRaw, other.mark), scales as ScaleSpec[], undefined, gridScaleName, userConfig)) {
        const a1 = built.find((a) => a.grid === a2.grid && a.orient === a2.orient)
        // (the label align and baseline follow the label angle: an axis that settled its angle settled them too - a null align is a value
        // there, not a missing one - so another layer's, computed from its own angle, does not fill them in)
        if (a1) for (const [k, v] of Object.entries(a2)) if ((a1 as Record<string, unknown>)[k] === undefined && v !== undefined && !((k === 'labelAlign' || k === 'labelBaseline') && (a1 as Record<string, unknown>).labelAngle !== undefined)) (a1 as Record<string, unknown>)[k] = v
      }
    }
    for (const a of built) axes.push(a)
  }
  // every grid axis is emitted before any main axis (grids paint under the domains and labels)
  if (axes.length) out.axes = [...axes.filter((a) => a.grid === true), ...axes.filter((a) => a.grid !== true)]

  // discrete-dimension sizing (after the scales are merged): the scale spans
  // steps and the view size is a signal over the domain cardinality
  const sizeSignals: Record<string, unknown>[] = []
  const layerContinuous = parsed.some((p) => p.mark === 'arc' || hasProjection(p.mark, isObject(p.l.encoding) ? (p.l.encoding as Record<string, unknown>) : {}))
  const layerPlans = (['x', 'y'] as const).map((channel) => {
    // (an independent y scale is named after its layer)
    const sc = scales.find((s) => s.name === channel) ?? (indepY && channel === 'y' ? scales.find(isIndepYScale) : undefined)
    const req = channel === 'x' ? wSpec : hSpec
    const plan = sizePlan(spec, channel === 'x' ? 'width' : 'height', req, sc ? String(sc.type) : undefined, layerContinuous)
    if ('step' in plan) pushAll(sizeSignals, stepSignals(channel, scales as ScaleSpec[], plan.step, req.stepFor))
    return plan
  })
  const xStepped = 'step' in layerPlans[0]!
  const yStepped = 'step' in layerPlans[1]!
  const container = containerSizing(spec, wSpec, hSpec)
  if (container) {
    out.autosize = container.autosize
    sizeSignals.splice(0, 0, ...container.signals)
  }
  if (!xStepped && !wSpec.container) out.width = 'fixed' in layerPlans[0]! ? layerPlans[0].fixed : width
  if (!yStepped && !hSpec.container) out.height = 'fixed' in layerPlans[1]! ? layerPlans[1].fixed : height
  if (sizeSignals.length) out.signals = sizeSignals

  const legends: Record<string, unknown>[] = []
  for (const [pi, p] of parsed.entries()) {
    const unitLegends = buildUnitLegends(p.l, p.fields, p.mark, p.markRaw)
    if (layerSel[pi]) applyLegendSelectionsOf(unitLegends, p.fields, layerSel[pi]!.cmpts)
    for (const lg of unitLegends) {
      // one legend per scale channel (vega resolves shared legends across layers)
      const ch = legendChannel(lg)
      // a layer's own scale has its own legend, which reads that scale
      if (indepChannels.has(ch)) {
        for (const k of LEGEND_SCALE_KEYS) if (lg[k] === ch) lg[k] = `layer_${pi}_${ch}`
        legends.push(lg)
        continue
      }
      // resolve.legend: independent - every layer keeps its own legend of this channel (they read the same scale)
      if (isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).legend) && ((spec.resolve as Record<string, Record<string, unknown>>).legend)?.[ch] === 'independent') {
        legends.push(lg)
        GROUP_LEGENDS.add(lg)
        continue
      }
      const dup = legends.find((x) => legendChannel(x) === ch)
      if (dup) {
        // shared legend: the layers that feed it merge, as for axes
        mergeLegend(dup, lg)
        continue
      }
      if (!legends.some((x) => JSON.stringify(x) === JSON.stringify(lg))) legends.push(lg)
    }
  }
  if (legends.length) out.legends = legends
  // the signals every unit's selections add (collected in compile())
  const selUnits = layerSel.filter((sel): sel is UnitSel => sel?.unit !== undefined)
  if (selUnits.length) {
    SEL_PARTS.set(out, {
      data: selData,
      top: (signals) => selUnits.reduce((sg, sel) => assembleTopLevelSelectionSignals(sel.cmpts, sg), signals),
      unit: selUnits.flatMap((sel) => assembleUnitSelectionSignals(sel.unit, sel.cmpts)),
    })
  }
  rootChrome(out, spec, 'unit')
  return out
}

/**
 * A point-positioned mark (line, point, text, trail, area) layered over a bar shares the bar's
 * BAND scale: it must sit at the band's centre (`band: 0.5`) rather than its start.
 */
const BIN_MID_MARKS = new Set(['point', 'circle', 'square', 'text', 'line', 'area', 'trail', 'rule'])
const OFFSET_POINT_MARKS = new Set(['point', 'circle', 'square', 'text', 'line', 'area', 'trail', 'rule'])

function centerPointMarksOnBands(marks: Record<string, unknown>[], scales: ScaleSpec[]): void {
  const bandScales = new Set(scales.filter((s) => s.type === 'band').map((s) => s.name))
  if (!bandScales.size) return
  const POINT_MARKS = new Set(['line', 'area', 'symbol', 'text', 'trail'])
  const visit = (m: Record<string, unknown>): void => {
    if (typeof m.type === 'string' && POINT_MARKS.has(m.type)) {
      const upd = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
      for (const k of ['x', 'y']) {
        const ref = upd?.[k] as Record<string, unknown> | undefined
        if (ref && typeof ref.scale === 'string' && bandScales.has(ref.scale) && ref.band === undefined && ref.field !== undefined && !(isObject(ref.offset) && typeof ref.offset.scale === 'string' && ref.offset.scale === `${k}Offset`)) ref.band = 0.5
        // an offset along a band scale sits at the middle of its band (valueref.ts midPoint: band scales get a band position)
        if (ref && isObject(ref.offset) && typeof ref.offset.scale === 'string' && bandScales.has(ref.offset.scale) && ref.offset.band === undefined) ref.offset.band = 0.5
      }
    }
    for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) visit(sub)
  }
  for (const m of marks) visit(m)
}

/**
 * Mark names double as Vega dataset names, so two layers must not reuse them:
 * rename this layer's marks (and its series group + facet) with a layer prefix.
 */
function uniquifyLayerMarks(marks: Record<string, unknown>[], layerIndex: number | string): void {
  // a nested layer's marks are named after every layer above it (`layer_0_layer_1_marks`)
  const lp = typeof layerIndex === 'number' ? `layer_${layerIndex}` : layerIndex
  marks.forEach((m, k) => {
    if (m.name === 'pathgroup') {
      m.name = `${lp}_pathgroup`
      const facet = (m.from as { facet?: { name?: string } } | undefined)?.facet
      const oldFacet = facet?.name
      if (facet && oldFacet) facet.name = `faceted_path_${lp}_main`
      for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) {
        sub.name = k === 0 ? `${lp}_marks` : `${lp}_marks_${k}`
        const from = sub.from as { data?: string } | undefined
        if (from && from.data === oldFacet) from.data = `faceted_path_${lp}_main`
      }
    } else if (m.type === 'group') {
      // a stack group (rounded stacked bars): its facet and inner mark names are dataset names too
      const facet = (m.from as { facet?: { name?: string } } | undefined)?.facet
      const oldFacet = facet?.name
      const newFacet = `${oldFacet ?? 'group'}_${lp}`
      if (facet && oldFacet) facet.name = newFacet
      const rename = (node: Record<string, unknown>): void => {
        const from = node.from as { data?: string } | undefined
        if (from && from.data === oldFacet) from.data = newFacet
        if (node.name === 'marks') node.name = k === 0 ? `${lp}_marks` : `${lp}_marks_${k}`
        for (const sub of (node.marks as Record<string, unknown>[] | undefined) ?? []) rename(sub)
      }
      for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) rename(sub)
    } else {
      m.name = k === 0 ? `${lp}_marks` : `${lp}_marks_${k}`
    }
  })
}

/** The step-form size signals of a discrete scale: `<ch>_step` plus the size signal over the domain cardinality. */
function stepSignals(channel: 'x' | 'y', scales: ScaleSpec[], step: number, stepForReq?: 'position' | 'offset'): Record<string, unknown>[] {
  const sc = scales.find((s) => s.name === channel)
  if (!sc) return []
  const stepName = `${channel}_step`
  sc.range = { step: { signal: stepName } }
  // layoutsize/assemble.ts sizeExpr: only a band scale has a real paddingInner; a point scale has n - 1 steps between n points,
  // which is paddingInner = 1 (vega-scale band.js)
  const po = (sc.paddingOuter as number) ?? (sc.padding as number) ?? 0
  const pi = sc.type === 'point' ? 1 : ((sc.paddingInner as number) ?? (sc.padding as number) ?? 0)
  // scale/range.ts getPositionStep / getOffsetStep: with a discrete offset channel the step is the offset's
  // (`for: "offset"`, the default), so the position scale takes step x (offset cardinality) / (1 - paddingInner)
  const offsetName = `${channel}Offset`
  const offset = scales.find((s) => s.name === offsetName)
  const offsetDiscrete = offset !== undefined && (offset.type === 'band' || offset.type === 'point')
  const stepFor = offsetDiscrete ? (stepForReq ?? 'offset') : 'position'
  let stepSignal: Record<string, unknown> = { name: stepName, value: step }
  if (stepFor === 'offset' && offset) {
    let count = `domain('${offsetName}').length`
    if (offset.type === 'band') count = `bandspace(${count}, ${(offset.paddingInner as number) ?? (offset.padding as number) ?? 0}, ${(offset.paddingOuter as number) ?? (offset.padding as number) ?? 0})`
    stepSignal = { name: stepName, update: `${step} * ${count} / (1-${(sc.paddingInner as number) ?? (sc.padding as number)})` }
    if (sc.type === 'band') offset.range = { step }
  }
  return [
    stepSignal,
    { name: channel === 'x' ? 'width' : 'height', update: `bandspace(domain('${channel}').length, ${pi}, ${po}) * ${stepName}` },
  ]
}

/** Root-level properties every compile path shares: background, padding, config, title, description. */
function rootChrome(out: Record<string, unknown>, spec: VLSpec, kind: 'unit' | 'composite' = 'composite'): void {
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  out.background = spec.background ?? (userConfig?.background as string | undefined) ?? 'white'
  out.padding = spec.padding ?? (userConfig?.padding as unknown) ?? 5
  const assembledConfig = assembleConfig(spec)
  if (assembledConfig) out.config = assembledConfig
  // config.aria: false takes every axis and legend out of the accessibility tree
  if (userConfig?.aria === false) {
    const hide = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(hide)
      else if (isObject(o)) {
        for (const k of ['axes', 'legends']) if (Array.isArray(o[k])) for (const g of o[k] as Record<string, unknown>[]) g.aria ??= false
        Object.values(o).forEach(hide)
      }
    }
    hide(out)
  }
  if (spec.title) out.title = unitTitle(spec.title, userConfig, kind)
  if (spec.description) out.description = spec.description
}

/**
 * vega-lite `assembleTitle` for a unit or layer: the title as a Vega title object, over config.title's anchor / frame /
 * offset / orient, framed on the group (`frame: "group"`) unless it is anchored to a side: a centred title sits over the plot
 * area, not over the plot plus its axes.
 */
function unitTitle(title: unknown, userConfig: Record<string, unknown> | undefined, kind: 'unit' | 'composite' = 'unit'): unknown {
  const cfg = isObject(userConfig?.title) ? (userConfig!.title as Record<string, unknown>) : {}
  const nonMark: Record<string, unknown> = {}
  for (const k of ['anchor', 'frame', 'offset', 'orient']) if (cfg[k]) nonMark[k] = cfg[k]
  const def = typeof title === 'string' || Array.isArray(title) ? { text: title } : isObject(title) ? title : undefined
  if (def === undefined) return title
  const merged: Record<string, unknown> = { ...nonMark, ...def }
  // model.ts assembleTitle: a unit / layer framed on its group when centred; a composition (laid out by Vega) anchors at the start
  if (merged.text) {
    if (kind === 'unit') { if (merged.anchor === 'middle' || merged.anchor === undefined) merged.frame ??= 'group' }
    else merged.anchor ??= 'start'
  }
  return merged
}

/** Scale properties the user wrote explicitly (vega-lite's explicit/implicit split). */
const EXPLICIT_SCALE_PROPS = new WeakMap<ScaleSpec, ReadonlySet<string>>()

function recordExplicit(sc: ScaleSpec, userScale: Record<string, unknown> | undefined): void {
  if (!userScale) return
  const keys = new Set<string>()
  for (const k of Object.keys(userScale)) keys.add(k === 'scheme' ? 'range' : k)
  EXPLICIT_SCALE_PROPS.set(sc, keys)
}

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** One member of a unioned domain: a (data, field) reference or a literal value list (a datum). */
type DomainEntry = { data: string; field: string } | { signal: string } | unknown[]

/** The entries a domain reads, or null when the domain is a signal or otherwise not unionable. */
function domainEntries(domain: unknown): DomainEntry[] | null {
  if (Array.isArray(domain)) return [domain]
  if (!isObject(domain)) return null
  const d = domain as { data?: unknown; field?: unknown; fields?: unknown; signal?: unknown }
  // (a signal domain is a member of a union - the extent of a bin transform, say - as vega's `fields` list allows)
  if (typeof d.signal === 'string' && d.data === undefined && d.fields === undefined) return [{ signal: d.signal }]
  if (typeof d.data === 'string' && typeof d.field === 'string') return [{ data: d.data, field: d.field }]
  if (typeof d.data === 'string' && Array.isArray(d.fields) && d.fields.every((f) => typeof f === 'string')) {
    return (d.fields as string[]).map((f) => ({ data: d.data as string, field: f }))
  }
  if (Array.isArray(d.fields)) {
    const out: DomainEntry[] = []
    for (const f of d.fields) {
      const e = domainEntries(f)
      if (!e) return null
      pushAll(out, e)
    }
    return out
  }
  return null
}

/**
 * Union per-layer scales into a single scale per name, following vega-lite's
 * merge rules (split.ts mergeValuesWithExplicit): an explicitly specified
 * property beats an implicit one; equal values merge; otherwise the first
 * layer wins (for a `range` step, the larger step). Domains union their data
 * references; sorts must agree. Scales whose domains cannot be unioned
 * (differing explicit domains, signal domains) throw rather than pick one.
 */
/** The non-position channels whose scales layers can keep apart. */
const INDEPENDENT_CAPABLE_CHANNELS = ['color', 'size', 'opacity', 'shape', 'strokeWidth', 'strokeDash', 'fillOpacity', 'strokeOpacity', 'angle']

/** The family a scale type belongs to; scales of one family merge across layers, the others cannot (scale/assemble.ts). */
function scaleTypeCategory(t: string): string {
  return t === 'point' || t === 'band' ? 'ordinal-position'
    : t === 'time' || t === 'utc' ? 'time'
    : ['linear', 'log', 'pow', 'sqrt', 'symlog', 'identity', 'sequential'].includes(t) ? 'numeric'
    : ['ordinal', 'bin-ordinal'].includes(t) ? 'discrete'
    : 'discretizing'
}
const compatibleScaleTypes = (a: string, b: string): boolean => {
  const ca = scaleTypeCategory(a)
  const cb = scaleTypeCategory(b)
  return ca === cb || (ca === 'ordinal-position' && cb === 'time') || (cb === 'ordinal-position' && ca === 'time')
}

/** What a point scale's band padding would be, were its scale a band (a layer that brings none): the unit's mark rule. */
const POINT_BAND_PADDING = new WeakMap<ScaleSpec, { inner: number; outer: number | undefined }>()

function mergeLayerScales(perLayer: ScaleSpec[][]): ScaleSpec[] {
  const byName = new Map<string, ScaleSpec[]>()
  for (const ls of perLayer) {
    for (const s of ls) {
      const list = byName.get(s.name)
      if (list) list.push(s)
      else byName.set(s.name, [s])
    }
  }
  const out: ScaleSpec[] = []
  for (const [name, list] of byName) {
    const first = list[0]!
    if (list.length === 1 || list.every((s) => deepEq(s, first))) {
      out.push(first)
      continue
    }
    const merged: ScaleSpec = { name, type: first.type, domain: undefined }
    for (const s2 of list) {
      if (!compatibleScaleTypes(first.type, s2.type)) {
        throw new VLCompileError(`layers give scale "${name}" incompatible types ("${first.type}" and "${s2.type}"); vega-lite would make them independent scales, which @aster/vl does not support`)
      }
    }
    const explicitMerged = new Set<string>()
    const keys: string[] = []
    for (const s of list) for (const k of Object.keys(s)) if (k !== 'name' && k !== 'domain' && !keys.includes(k)) keys.push(k)
    for (const k of keys) {
      let cur: { value: unknown; explicit: boolean } | undefined
      for (const s of list) {
        const v = (s as Record<string, unknown>)[k]
        if (v === undefined) continue
        const next = { value: v, explicit: EXPLICIT_SCALE_PROPS.get(s)?.has(k) ?? false }
        if (cur === undefined) cur = next
        else if (cur.explicit && !next.explicit) { /* keep */ }
        else if (next.explicit && !cur.explicit) cur = next
        else if (deepEq(cur.value, next.value)) { /* same */ }
        else if (k === 'range' && isObject(cur.value) && isObject(next.value) && isObject((cur.value as { step?: unknown }).step) === false && typeof (cur.value as { step?: unknown }).step === 'number' && typeof (next.value as { step?: unknown }).step === 'number') {
          if ((next.value as { step: number }).step > (cur.value as { step: number }).step) cur = next
        } else if (cur.explicit && next.explicit && k !== 'type') {
          throw new VLCompileError(`layers specify conflicting values for scale "${name}" property "${k}"`)
        }
        // implicit conflicts: the first layer wins
      }
      if (cur) {
        ;(merged as Record<string, unknown>)[k] = cur.value
        if (cur.explicit) explicitMerged.add(k)
      }
    }
    // an explicitly specified type wins; otherwise the higher precedence one does (band over point)
    const typed = list.find((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('type'))
    merged.type = (typed ?? (list.some((s) => s.type === 'band') && list.every((s) => s.type === 'band' || s.type === 'point') ? list.find((s) => s.type === 'band')! : first)).type
    // a point scale that becomes a band: the first layer's inner padding wins (implicit values: the first), the outer follows it
    // (properties.ts paddingOuter reads the merged paddingInner, so every layer gets `inner / 2` unless one asks for the config's outer)
    // an explicit `padding` makes the other layers' default paddingInner / paddingOuter none (properties.ts: `paddingValue !== undefined`)
    {
      const withPadding = list.find((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('padding') && s.padding !== undefined)
      const innerOuterExplicit = list.some((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('paddingInner') || EXPLICIT_SCALE_PROPS.get(s)?.has('paddingOuter'))
      if (merged.type === 'band' && withPadding && !innerOuterExplicit) {
        merged.padding = withPadding.padding
        delete merged.paddingInner
        delete merged.paddingOuter
        explicitMerged.add('padding')
      }
    }
    if (merged.type === 'band' && first.type === 'point') {
      const explicitPad = list.some((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('paddingInner') || EXPLICIT_SCALE_PROPS.get(s)?.has('padding') || EXPLICIT_SCALE_PROPS.get(s)?.has('paddingOuter'))
      const firstInner = list.map((s) => (s.type === 'point' ? POINT_BAND_PADDING.get(s)?.inner : (s.paddingInner as number | undefined)))[0]
      if (!explicitPad && typeof firstInner === 'number') {
        merged.paddingInner = firstInner
        const cfgOuter = list.map((s) => POINT_BAND_PADDING.get(s)?.outer).find((o) => o !== undefined)
        merged.paddingOuter = cfgOuter ?? firstInner / 2
        delete merged.padding
      }
    }
    // properties that the merged type cannot honour (a point scale's padding on a band scale) are dropped
    for (const k of Object.keys(merged)) {
      if (k !== 'name' && k !== 'type' && k !== 'domain' && k !== 'range' && !scalePropApplies(name, merged.type, k)) delete (merged as Record<string, unknown>)[k]
    }
    if (merged.type === 'band' && (merged.paddingInner !== undefined || merged.paddingOuter !== undefined)) delete merged.padding
    // an offset scale judged band by the merge takes the band layers' outer padding, not a point layer's half step
    // (scale properties are computed from the MERGED type: properties.ts paddingOuter)
    if (merged.type === 'band' && /Offset$/.test(name) && !explicitMerged.has('paddingOuter')) {
      const own = list.find((sc) => sc.type === 'band')?.paddingOuter
      if (own !== undefined) merged.paddingOuter = own
      else delete merged.paddingOuter
    }
    // domain: union data references; identical non-reference domains merge
    // (scale/domain.ts mergeValuesWithExplicit on `domains`: an explicitly specified domain beats the implicit ones; only
    // domains of the same explicitness are unioned)
    const explicitDomains = list.filter((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('domain'))
    const domains = (explicitDomains.length ? explicitDomains : list).map((s) => s.domain)
    if (explicitDomains.length) explicitMerged.add('domain')
    if (domains.every((d) => deepEq(d, domains[0]))) merged.domain = domains[0]
    else {
      const entries: DomainEntry[] = []
      for (const d of domains) {
        const e = domainEntries(d)
        if (!e) throw new VLCompileError(`layers give scale "${name}" different explicit or signal-based domains, which cannot be merged`)
        for (const x of e) if (!entries.some((y) => deepEq(x, y))) entries.push(x)
      }
      const sorts = domains.map((d) => (isObject(d) ? (d as { sort?: unknown }).sort : undefined)).filter((x) => x !== undefined)
      if (sorts.length && !sorts.every((x) => deepEq(x, sorts[0]))) {
        throw new VLCompileError(`layers sort the shared scale "${name}" differently`)
      }
      const sort = sorts[0]
      const refs = entries.filter((e): e is { data: string; field: string } => !Array.isArray(e) && 'data' in e)
      const sameData = refs.length === entries.length && entries.length > 0 && refs.every((e) => e.data === refs[0]!.data)
      merged.domain = {
        ...(sameData
          ? { data: refs[0]!.data, fields: refs.map((e) => e.field) }
          : { fields: entries }),
        ...(sort !== undefined ? { sort } : {}),
      }
    }
    EXPLICIT_SCALE_PROPS.set(merged, explicitMerged)
    out.push(merged)
  }
  return out
}

/** config.autosize is a config-level default for the emitted Vega autosize. */
function autosizeOf(spec: VLSpec): unknown {
  if (spec.autosize != null) return spec.autosize
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  return cfg?.autosize
}

// --- facet composition -------------------------------------------------------

/** Compile a faceted chart (encoding.facet / top-level facet + spec). */
function compileFaceted(spec: VLSpec, ctx: CompileCtx, nested = ''): VLSpec {
  // (the names of a facet and of everything it makes are its model's: those of a facet inside a facet start with `child`, and its own child
  // is `child_child`; a composite around the facet puts its own name in front afterwards)
  const own = (name: string): string => childModelName(nested, name)
  const CH = own('child')
  const FACET = own('facet')
  const CELL = own('cell')
  const facetDef = isObject(spec.facet) ? (spec.facet as Record<string, unknown>) : undefined
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const encFacet = isObject(enc.facet) ? (enc.facet as Record<string, unknown>) : undefined
  // a facet mapping {row, column} or a single wrapped field {field, type, columns?}
  const wrapDef = facetDef && facetDef.row === undefined && facetDef.column === undefined
    ? facetDef
    : encFacet && encFacet.row === undefined && encFacet.column === undefined && enc.row === undefined && enc.column === undefined
      ? encFacet
      : undefined
  const rowDef = wrapDef ? undefined : (facetDef?.row ?? encFacet?.row ?? enc.row) as Record<string, unknown> | undefined
  const colDef = wrapDef ? undefined : (facetDef?.column ?? encFacet?.column ?? enc.column) as Record<string, unknown> | undefined
  const wrapColumns = wrapDef ? ((spec.columns ?? wrapDef.columns) as number | undefined) : undefined
  // header label formatting reads the channel def (type + format)
  const normalizeHeaderDef = (def: Record<string, unknown> | undefined): FieldDef | undefined =>
    def ? parseChannel('column', def) ?? undefined : undefined
  // the inner view: top-level facet form uses spec.spec (unit or layer), which
  // inherits the facet's data/transform/config; the encoding form strips the
  // facet channels from the unit's own encoding
  let innerSpec: VLSpec
  if (isObject(spec.spec)) {
    innerSpec = { ...(spec.spec as VLSpec) }
    if (innerSpec.data === undefined) {
      if (isObject(spec.data)) innerSpec.data = spec.data
      if (Array.isArray(spec.transform) && spec.transform.length) {
        innerSpec.transform = [...(spec.transform as unknown[]), ...(Array.isArray(innerSpec.transform) ? innerSpec.transform : [])]
      }
    }
    if (spec.config !== undefined) innerSpec.config = spec.config
  } else {
    const enc = { ...(isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}) }
    delete enc.facet
    delete enc.row
    delete enc.column
    innerSpec = { ...spec, encoding: enc }
    delete innerSpec.columns
  }
  // a unit in a cell carries its facet cell in its selections' unit name (`"child" + '__facet_column_' + (facet["c"])`)
  const nameFacetField = (channel: string, def: Record<string, unknown> | undefined): { channel: string; field: string }[] => {
    const fd = def ? parseChannel(channel, def) : null
    return fd ? [{ channel, field: aggFieldName(fd) }] : []
  }
  const cellFacetFields = [...nameFacetField('row', rowDef), ...nameFacetField('column', colDef), ...nameFacetField('facet', wrapDef)]
  const savedFacetTransforms = ctx.facetTransformCount
  ctx.facetTransformCount = isObject(spec.spec) && (spec.spec as VLSpec).data === undefined && Array.isArray(spec.transform) ? spec.transform.length : 0
  // a facet inside the facet (facet.ts FacetModel with a FacetModel child): it is made whole, in the names of the child model, and nests in the cell
  const innerIsFacet = isObject(spec.spec) && (spec.spec as VLSpec).facet !== undefined
  if (innerIsFacet) {
    const innerFacet = (spec.spec as VLSpec).facet
    if (wrapDef !== undefined || !isObject(innerFacet) || (innerFacet.row === undefined && innerFacet.column === undefined)) {
      throw new VLCompileError('a wrapped facet (a single `facet` field) around or inside another facet is not supported yet; give a row and / or a column')
    }
  }
  const savedNestedFacet = ctx.inNestedFacet
  ctx.inNestedFacet = nested !== '' && !innerIsFacet
  const inner = inChildView(ctx, 'child', cellFacetFields, true, () => (innerIsFacet ? compileFaceted(innerSpec, ctx, CH) : Array.isArray(innerSpec.layer) ? compileLayered(innerSpec, ctx) : compileUnitView(innerSpec, ctx)))
  ctx.inNestedFacet = savedNestedFacet
  ctx.facetTransformCount = savedFacetTransforms
  const innerSel = SEL_PARTS.get(inner)
  if (innerIsFacet && (innerSel !== undefined || (Array.isArray(inner.projections) && inner.projections.length > 0))) {
    throw new VLCompileError('a selection or a map inside a facet inside a facet is not supported yet')
  }
  // The pieces of the inner facet that become the contents of this facet's cell: its domain datasets (made from the cell's rows), its titles,
  // headers and footers, and its own cell, which facets what the cell holds
  const DOMAIN = /(?:^|_)(?:row|column|facet)_domain(?:_row|_column)?$/
  const nestedDomains: Record<string, unknown>[] = innerIsFacet ? (inner.data as Record<string, unknown>[]).filter((d) => DOMAIN.test(d.name as string)) : []
  if (innerIsFacet) inner.data = (inner.data as Record<string, unknown>[]).filter((d) => !nestedDomains.includes(d))
  const nestedCell = innerIsFacet ? (inner.marks as Record<string, unknown>[]).find((m) => m.name === childModelName(CH, 'cell')) : undefined
  const nestedBase = innerIsFacet ? ((nestedCell?.from as { facet?: { data?: string } } | undefined)?.facet?.data) : undefined
  if (innerIsFacet && (nestedCell === undefined || nestedBase === undefined)) throw new VLCompileError('a facet inside a facet: the inner facet has no cell')
  if (nestedCell !== undefined) (nestedCell.from as { facet: { data: string } }).facet.data = FACET
  // the child view's binned fields name their signals after the child model (bin.ts getBinSignalName: `child_bin_..._bins`)
  {
    const sigMap = new Map<string, string>()
    const ts = ((inner.data as Record<string, unknown>[]) ?? []).flatMap((d) => ((d.transform as Record<string, unknown>[] | undefined) ?? []).filter((t) => (t.type === 'bin' || t.type === 'extent' || t.type === 'geojson') && typeof t.signal === 'string'))
    for (const t of ts) sigMap.set(t.signal as string, `${CH}_${t.signal as string}`)
    if (sigMap.size) {
      const r = { signals: sigMap, scales: new Map<string, string>() }
      for (const t of ts) {
        const own = t.signal as string
        renameFragment(t, r)
        t.signal = sigMap.get(own)
      }
      renameFragment(inner.scales, r)
      renameFragment(inner.axes ?? [], r)
      renameFragment(inner.marks, r)
      renameFragment(inner.legends ?? [], r)
      renameFragment(inner.projections ?? [], r)
    }
  }
  // the facet's cells declare the units' signals (and the `facet` signal that tracks the cell the pointer is in)
  const cellName = childModelName(ctx.modelName, 'cell')
  // The inner unit may carry a DECLARED source name (vega-lite preserves it);
  // facet references must target whatever the inner marks actually read.
  const innerDataName = (((inner.marks as Record<string, unknown>[])?.[0]?.from as { data?: string } | undefined)?.data) ?? ctx.dn(0)

  // the facet fields: an aggregated facet def keys everything on the
  // aggregated name (probed: column {aggregate: 'average', field: 't'}
  // names the facet 'average_t', aggregates the child pipeline grouped by
  // the inner groupby, and titles the column 'Average of t')
  const rowFd = rowDef ? parseChannel('row', rowDef) : null
  const colFd = colDef ? parseChannel('column', colDef) : null
  const rowField = rowFd ? aggFieldName(rowFd) : undefined
  const facetOrder = (d: Record<string, unknown> | undefined): 'ascending' | 'descending' =>
    d?.sort === 'descending' || (isObject(d?.sort) && (d!.sort as Record<string, unknown>).order === 'descending')
      ? 'descending'
      : 'ascending'
  const rowOrder = facetOrder(rowDef)
  const colOrder = facetOrder(colDef)
  const colField = colFd ? aggFieldName(colFd) : undefined
  // the wrapped facet field (facet: {field, type}) keys the cell grouping like a row/column one
  const wrapFd = wrapDef ? parseChannel('facet', wrapDef) : null
  const wrapField = wrapFd ? aggFieldName(wrapFd) : undefined
  // vega-lite appends the facet fields to the inner pipeline's grouping
  // transforms (stack groupby, aggregate/joinaggregate groupby, window
  // partitionby, pivot groupby — see FacetModel.addDimensions) so that
  // stacking etc. restart within each facet cell rather than spanning them.
  // Only the transforms DERIVED FROM THE ENCODING get the keys: the user's own
  // `transform` array runs before the facet and is left alone.
  // (a binned facet field groups by both ends of its bin: FacetModel.addDimensions / header/assemble)
  const colsOf = (fd: FieldDef | null | undefined, field: string | undefined): string[] =>
    fd && field ? (fd.bin ? [field, binNames(fd.binParams!, fd.field).end] : [field]) : []
  const facetKeys = [...colsOf(rowFd, rowField), ...colsOf(colFd, colField), ...colsOf(wrapFd, wrapField)]
  const innerData = (inner.data as Record<string, unknown>[]) ?? []
  const srcDataset = innerData[0]
  const srcName = srcDataset?.name as string
  // the facet fields themselves are computed in the child dataflow (flatten of a nested
  // path, cast + timeunit) even though they are not part of the inner encoding
  const facetFds = [rowFd, colFd, wrapFd].filter((f): f is FieldDef => f != null)
  const pre: Record<string, unknown>[] = []
  const preSeen = new Set<string>()
  for (const fd of facetFds) {
    if (fd.flatExpr !== undefined && !preSeen.has(`flat:${fd.field}`)) {
      preSeen.add(`flat:${fd.field}`)
      pre.push({ type: 'formula', expr: fd.flatExpr, as: fd.field })
    }
  }
  // a binned facet field: the extent + bin transforms ahead of everything (data/parse.ts, before timeUnit)
  for (const fd of facetFds.filter((f) => f.bin && !isPrebinned(f))) {
    const names = binNames(fd.binParams!, fd.field)
    if (preSeen.has(names.start)) continue
    preSeen.add(names.start)
    const alreadyComputed = innerData.some((d) => ((d.transform as Record<string, unknown>[] | undefined) ?? []).some((t) => t.type === 'bin' && Array.isArray(t.as) && (t.as as string[])[0] === names.start))
    if (!alreadyComputed) pushAll(pre, binTransforms(fd.binParams!, fd.field, names, binSpanExpr(ctx, fd.binParams!)))
  }
  for (const fd of facetFds.filter((f) => f.tu && !f.tu.binned)) {
    const as = timeUnitField(fd)
    if (preSeen.has(as)) continue
    preSeen.add(as)
    const alreadyComputed = innerData.some((d) => ((d.transform as Record<string, unknown>[] | undefined) ?? []).some((t) => t.type === 'timeunit' && Array.isArray(t.as) && (t.as as string[])[0] === as))
    if (alreadyComputed) continue
    pre.push({ type: 'formula', expr: `toDate(${dref(fd.field)})`, as: fd.field })
    pre.push(timeUnitTransform(fd.tu!, fd.field, as))
  }
  if (pre.length && innerIsFacet) throw new VLCompileError('a binned, time-unit or nested field as the facet of a facet that holds another facet is not supported yet')
  if (pre.length) {
    const derived = innerData.filter((d) => d.source === srcName)
    if (derived.length === 0) {
      // the marks read the source directly: derive a dataset that computes the facet fields
      const created = { name: ctx.dn(innerData.length), source: srcName, transform: pre }
      innerData.push(created)
      renameDataRefs(inner.marks, new Map([[srcName, created.name]]))
      renameDataRefs(inner.scales, new Map([[srcName, created.name]]))
    } else {
      for (const d of derived) d.transform = [...pre, ...((d.transform as Record<string, unknown>[] | undefined) ?? [])]
    }
  }
  if (facetKeys.length) {
    for (const d of innerData) {
      for (const t of (d.transform as Record<string, unknown>[]) ?? []) {
        if (FACET_LEVEL_TRANSFORMS.has(t)) continue
        if (t.type === 'stack' || t.type === 'aggregate' || t.type === 'joinaggregate' || t.type === 'pivot' || t.type === 'impute') {
          if (Array.isArray(t.groupby)) t.groupby = [...t.groupby, ...facetKeys]
        } else if (t.type === 'window') {
          if (Array.isArray(t.partitionby)) t.partitionby = [...t.partitionby, ...facetKeys]
        }
      }
    }
  }
  // The data the cells facet: a unit's marks dataset, or - for layers, whose marks read several
  // datasets - the first derived dataset; the other datasets are re-derived INSIDE each cell.
  const layeredInner = Array.isArray(innerSpec.layer)
  const unitMarksData = innerIsFacet ? nestedBase! : ((inner.marks as Record<string, unknown>[])?.[0]?.from as { data?: string } | undefined)?.data ?? innerDataName
  // A facet sorted by an aggregate of a field (`sort: {op: "median", field: "yield"}`) aggregates the facet's own data, the rows BEFORE
  // the view's pipeline (data/facet.ts: the cells' pipeline runs inside each cell, FacetNode.data is the parse). When the pipeline
  // aggregates, those rows are not the ones it outputs, so the cells facet the data it derives from and re-derive it inside.
  const sortsByAggregate = [rowDef, colDef, wrapDef].some((d) => isObject(d?.sort) && !Array.isArray(d!.sort))
  const unitPipelineDs = innerData.find((d) => d.name === unitMarksData)
  // (a crossed facet pre-computes its sort field with a joinaggregate on the pipeline's own data, which its aggregate then drops)
  // The raw table is separate only when the view asks for it (a scale domain sorted by an aggregate reads it: the pipeline is then two
  // datasets, the raw one and the aggregated one). Otherwise vega-lite merges the whole pipeline into the facet's data, and a sort field the
  // aggregate drops is missing from the rows the sort aggregates (trellis_area_seattle: every key is undefined, the cells keep their order).
  const rawFacet = !innerIsFacet && !layeredInner && typeof unitPipelineDs?.source === 'string' && (nested !== '' || PRE_FILTER_UNITS.has(inner) || (
    sortsByAggregate && !(rowDef && colDef)
    && typeof innerData.find((d) => d.name === unitPipelineDs.source)?.source === 'string'
    && ((unitPipelineDs.transform as Record<string, unknown>[] | undefined) ?? []).some((t) => t.type === 'aggregate')))
  // (the facet's data is that raw dataset - the casts, the calculates, the facet fields' time units; the aggregate that follows runs in
  // each cell over the cell's rows)
  const rawBase = rawFacet ? (unitPipelineDs!.source as string) : undefined
  const rawTail = rawFacet ? (unitPipelineDs!.transform as Record<string, unknown>[]) : undefined
  const baseName = layeredInner
    ? ((innerData[1]?.source === srcName ? (innerData[1]!.name as string) : srcName))
    : rawBase !== undefined ? rawBase : unitMarksData
  // The facet's own `transform` runs once, before the facet (data/parse.ts: the facet model's pipeline is the parent of its cells).
  // A layered inner view derives each layer's dataset from the facet's base dataset with these transforms in front, which would run
  // them again inside every cell (a joinaggregate over one cell's rows, ...): they are hoisted into the base dataset instead.
  if (layeredInner && isObject(spec.spec) && Array.isArray(spec.transform) && spec.transform.length && (spec.spec as VLSpec).data === undefined) {
    const hoisted = translateTransforms(spec.transform as Record<string, unknown>[], ctx, { parsed: new Map() })
    const baseDs0 = innerData.find((d) => d.name === baseName)
    const derived = innerData.filter((d) => d.source === baseName && Array.isArray(d.transform))
    const key = JSON.stringify(hoisted)
    if (baseDs0 && hoisted.length && derived.length && derived.every((d) => JSON.stringify((d.transform as unknown[]).slice(0, hoisted.length)) === key)) {
      for (const d of derived) d.transform = (d.transform as unknown[]).slice(hoisted.length)
      baseDs0.transform = [...((baseDs0.transform as Record<string, unknown>[] | undefined) ?? []), ...hoisted]
    }
  }
  const cellData: Record<string, unknown>[] = []
  const cellMap = new Map<string, string>([[baseName, FACET]])
  if (rawFacet && rawTail !== undefined) {
    const cellName = `${unitMarksData}_cell`
    cellMap.set(unitMarksData, cellName)
    cellData.push({ name: cellName, source: FACET, transform: rawTail })
  }
  if (innerIsFacet) {
    // the inner facet's domain datasets are made inside this cell, from its rows
    for (const d of nestedDomains) cellData.push({ ...d, source: FACET })
  }
  if (layeredInner) {
    const sources = new Set(innerData.filter((d) => typeof d.values !== 'undefined' || typeof d.url !== 'undefined' || d.source === undefined).map((d) => d.name))
    if (sources.size > 1) throw new VLCompileError('a facet of layers that read different data sources is not supported')
    for (const d of innerData) {
      if (d.name === baseName || d.name === srcName) continue
      const srcRef = d.source as string | undefined
      if (srcRef !== undefined && cellMap.has(srcRef)) {
        const cellName = `${d.name as string}_cell`
        cellMap.set(d.name as string, cellName)
        cellData.push({ name: cellName, source: cellMap.get(srcRef), ...(d.transform !== undefined ? { transform: d.transform } : {}) })
      }
    }
  }

  // facet sorts (compile/facet.ts assembleFacet / facetSortFields, data/facet.ts, joinaggregatefacet.ts, calculate.ts): a sort by an
  // aggregate of another field (`{op, field}`) or by a list of values orders the cells and their headers by a field the facet derives
  interface FacetSortInfo { cellField: string; domainFields: string[]; domainOps: string[]; domainAs: string[]; facetAgg?: { field: string; op: string; as: string }; headerField: string }
  const facetSortOf = (def: Record<string, unknown> | undefined, field: string | undefined, channel: 'row' | 'column' | 'facet'): FacetSortInfo | undefined => {
    const sort = def?.sort
    if (!field || sort === undefined || sort === null || typeof sort === 'string') return undefined
    const baseDs = innerData.find((d) => d.name === baseName)
    const addToBase = (t: Record<string, unknown>): void => {
      if (!baseDs) throw new VLCompileError('a facet sort needs the facet data')
      ;(baseDs.transform ??= []) as Record<string, unknown>[]
      ;(baseDs.transform as Record<string, unknown>[]).push(t)
    }
    if (Array.isArray(sort)) {
      const idx = genName(channel, `${field}_sort_index`)
      const expr = `${(sort as unknown[]).map((v, i) => `datum[${JSON.stringify(field)}]===${JSON.stringify(v)} ? ${i}`).join(' : ')} : ${sort.length}`
      addToBase({ type: 'formula', expr, as: idx })
      return { cellField: idx, domainFields: [idx], domainOps: ['max'], domainAs: [idx], facetAgg: { field: idx, op: 'max', as: idx }, headerField: idx }
    }
    if (isObject(sort)) {
      // (isSortField: `{op: "count"}` sorts by the number of rows and has no field to aggregate: vega-lite puts a null field in the aggregate)
      const sf = (typeof sort.field === 'string' ? sort.field : null) as string
      const op = (sort.op as string | undefined) ?? 'min'
      // (facetSortFieldName: vgField of the sort field def, so the op is in the name only when the sort says it: `{field: "order"}` is `order`)
      const named = sort.op !== undefined
      const out = sf === null ? genName(op, `by_${field}`) : named ? genName(`${op}_${sf}`, `by_${field}`) : genName(sf, `by_${field}`)
      const domainAs = sf === null ? op : named ? genName(op, sf) : sf
      if (rowFd && colFd) {
        // a crossed facet pre-calculates the sort field per channel value, and the cells take its max
        addToBase({ type: 'joinaggregate', as: [out], ops: [op], fields: [sf], groupby: [field] })
        return { cellField: out, domainFields: [sf], domainOps: [op], domainAs: [domainAs], facetAgg: { field: out, op: 'max', as: out }, headerField: domainAs }
      }
      return { cellField: out, domainFields: [sf], domainOps: [op], domainAs: [domainAs], facetAgg: { field: sf, op, as: out }, headerField: domainAs }
    }
    return undefined
  }
  const rowSort = facetSortOf(rowDef, rowField, 'row')
  const colSort = facetSortOf(colDef, colField, 'column')
  const wrapSort = facetSortOf(wrapDef, wrapField, 'facet')
  // the cells' source: the facet's grouping, the cross of the row and column values when both are given, the sort fields aggregated
  // the column of the facet inside this one, whose values the cells are laid out by
  const nestedColumn = innerIsFacet && isObject((spec.spec as VLSpec).facet) && isObject(((spec.spec as VLSpec).facet as Record<string, unknown>).column)
    ? parseChannel('column', ((spec.spec as VLSpec).facet as Record<string, unknown>).column as Record<string, unknown>)
    : null
  const nestedColField = nestedColumn ? aggFieldName(nestedColumn) : undefined
  const facetFrom = (groupby: string[]): Record<string, unknown> => {
    const sorts = [rowSort, colSort, wrapSort].filter((x): x is FacetSortInfo => x !== undefined && x.facetAgg !== undefined)
    const cross = !!rowFd && !!colFd
    // (facet.ts assembleFacet: the cardinality of each independent step-sized scale first, then the sort fields)
    // (getCardinalityAggregateForChild: a facet child that is itself faceted by column counts that column's values)
    const cards: Array<{ field: string; as: string }> = [
      ...indepScales.filter((i) => i.distinct !== undefined).map((i) => ({ field: i.field!, as: i.distinct! })),
      ...(nestedColField !== undefined ? [{ field: nestedColField, as: `distinct_${nestedColField}` }] : []),
    ]
    const aggFields = [...cards.map((c) => c.field), ...sorts.map((x) => x.facetAgg!.field)]
    return {
      name: FACET,
      data: baseName,
      groupby,
      ...(cross || aggFields.length
        ? { aggregate: { ...(cross ? { cross: true } : {}), ...(aggFields.length ? { fields: aggFields, ops: [...cards.map(() => 'distinct'), ...sorts.map((x) => x.facetAgg!.op)], as: [...cards.map((c) => c.as), ...sorts.map((x) => x.facetAgg!.as)] } : {}) } }
        : {}),
    }
  }
  const domainAggregate = (sort: FacetSortInfo | undefined): Record<string, unknown> => (sort ? { fields: sort.domainFields, ops: sort.domainOps, as: sort.domainAs } : {})

  // The child size: the inner view's own width/height (a number, or a step-driven
  // signal over its discrete scale). The facet's own width/height are not used.
  const sizeSigMap = new Map([['width', `${CH}_width`], ['height', `${CH}_height`]])
  const innerSignals = (inner.signals as Record<string, unknown>[] | undefined) ?? []
  for (const sg of innerSignals) {
    if (sg.name !== 'width' && sg.name !== 'height') sizeSigMap.set(sg.name as string, sg.name as string)
  }
  // (an inner facet's signals - `child_child_width` - are named already)
  if (innerIsFacet) sizeSigMap.clear()
  // --- independent position scales (resolve.scale.x / y: independent; compile/facet.ts, layoutsize/assemble.ts, model.ts getSizeSignalRef) ---
  // The channel's scale lives in each cell (`child_x`), over the cell's own data; its axis is the cell's, not the header's. A discrete
  // scale sized by a step makes the cell as wide as its own cardinality: the facet counts the distinct values of the scale's field
  // (`distinct_age`), and the cell and the header read the count to size themselves.
  const resolveAxisF = isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).axis) ? ((spec.resolve as Record<string, unknown>).axis as Record<string, unknown>) : {}
  const resolveScaleF = isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale) ? ((spec.resolve as Record<string, unknown>).scale as Record<string, unknown>) : {}
  interface IndepScale { ch: 'x' | 'y'; field?: string; sizeExpr?: string; distinct?: string }
  const indepScales: IndepScale[] = []
  for (const ch of ['x', 'y'] as const) {
    if (resolveScaleF[ch] !== 'independent') continue
    if (innerIsFacet) throw new VLCompileError('independent x / y scales in a facet that holds another facet are not supported yet')
    const sc = ((inner.scales as ScaleSpec[]) ?? []).find((x) => x.name === ch)
    if (!sc) continue
    const entry: IndepScale = { ch }
    if ((sc.type === 'band' || sc.type === 'point') && isObject(sc.range) && 'step' in sc.range) {
      const dom = sc.domain as { field?: unknown; fields?: unknown }
      const first = typeof dom?.field === 'string' ? dom.field : Array.isArray(dom?.fields) ? (dom.fields as unknown[]).map((f) => (isObject(f) ? f.field : f)).find((f) => typeof f === 'string') : undefined
      if (typeof first !== 'string') throw new VLCompileError(`an independent ${ch} scale needs a field to count the cells' sizes from`)
      const num = (v: unknown): string => (isObject(v) && typeof v.signal === 'string' ? v.signal : String(v))
      const padding = sc.padding as unknown
      const paddingOuter = (sc.paddingOuter as unknown) ?? padding
      const paddingInner = sc.type === 'band' ? ((sc.paddingInner as unknown) ?? padding) : 1
      entry.field = first
      entry.distinct = `distinct_${first}`
      entry.sizeExpr = `bandspace(datum[${JSON.stringify(entry.distinct)}], ${num(paddingInner)}, ${num(paddingOuter)}) * ${CH}_${ch}_step`
      sizeSigMap.set(`${ch}_step`, `${CH}_${ch}_step`)
    }
    indepScales.push(entry)
  }
  const indepOf = (ch: 'x' | 'y'): IndepScale | undefined => indepScales.find((i) => i.ch === ch)
  if (wrapDef && indepScales.length) throw new VLCompileError('an independent x / y scale in a wrapped facet (a single `facet` field) is not supported yet; give a row and / or a column')
  const facetChildSignals: Record<string, unknown>[] = []
  for (const sg of innerSignals) {
    // (a step-sized independent scale has no view size of its own: the cells are sized by their cardinality)
    if ((sg.name === 'width' && indepOf('x')?.sizeExpr) || (sg.name === 'height' && indepOf('y')?.sizeExpr)) continue
    facetChildSignals.push({ ...sg, name: sizeSigMap.get(sg.name as string) ?? sg.name })
  }
  const hasSig = (n: string): boolean => facetChildSignals.some((x) => x.name === n)
  if (!innerIsFacet && !hasSig(`${CH}_width`) && !indepOf('x')?.sizeExpr) facetChildSignals.push({ name: `${CH}_width`, value: typeof inner.width === 'number' ? inner.width : 300 })
  if (!innerIsFacet && !hasSig(`${CH}_height`) && !indepOf('y')?.sizeExpr) facetChildSignals.push({ name: `${CH}_height`, value: typeof inner.height === 'number' ? inner.height : 300 })
  // (layoutsize/assemble.ts assembleLayoutSignals: the width's signals, then the height's)
  {
    const rank = (n: unknown): number => (n === `${CH}_width` || n === `${CH}_x_step` || n === 'x_step' ? 0 : n === `${CH}_height` || n === `${CH}_y_step` || n === 'y_step' ? 1 : 2)
    facetChildSignals.sort((a, b) => rank(a.name) - rank(b.name))
  }
  const renames = { signals: sizeSigMap, scales: new Map<string, string>(indepScales.map((i) => [i.ch, `${CH}_${i.ch}`] as [string, string])) }
  if (innerSel) renameFragment(innerSel.unit, renames)
  renameFragment(inner.scales, renames)
  renameFragment(inner.axes ?? [], renames)
  renameFragment(inner.marks, renames)
  renameFragment(inner.legends ?? [], renames)
  renameFragment(inner.projections ?? [], renames)
  renameFragment(facetChildSignals, renames)

  // split the inner axes: grid axes stay in the cell, label axes move to the
  // row header (y) / column footer (x) - an independent scale's stay in the cell, after the grids
  const gridAxes: Record<string, unknown>[] = []
  const yLabelAxes: Record<string, unknown>[] = []
  const xLabelAxes: Record<string, unknown>[] = []
  const ownAxes: Record<string, unknown>[] = []
  for (const a of (inner.axes ?? []) as Record<string, unknown>[]) {
    // (resolve.axis: independent puts the axes of that channel in every cell, over the scale the cells share)
    const indepAxis = indepScales.some((i) => a.scale === `${CH}_${i.ch}`) || ((a.scale === 'x' || a.scale === 'y') && resolveAxisF[a.scale] === 'independent')
    if (a.grid === true) gridAxes.push(a)
    else if (indepAxis) ownAxes.push(a)
    else if (a.orient === 'left' || a.orient === 'right') yLabelAxes.push(a)
    else xLabelAxes.push(a)
  }
  pushAll(gridAxes, ownAxes)
  // axis/assemble.ts assembleAxisSignals: an axis with no grid scale (an x axis over a view with no y scale) draws its grid with the
  // group's own `height` / `width`, which the cell defines as the child's size
  const cellAxisSignals: Record<string, unknown>[] = []
  const hasInnerScale = (ch: 'x' | 'y'): boolean => ((inner.scales as ScaleSpec[]) ?? []).some((sc) => sc.name === ch)
  for (const a of (inner.axes ?? []) as Record<string, unknown>[]) {
    const horizontal = a.orient === 'bottom' || a.orient === 'top'
    // (the axis component has a grid scale whenever the other channel has a scale)
    if (hasInnerScale(horizontal ? 'y' : 'x')) continue
    const name = horizontal ? 'height' : 'width'
    const update = horizontal ? (indepOf('y')?.sizeExpr ? undefined : `${CH}_height`) : (indepOf('x')?.sizeExpr ? undefined : `${CH}_width`)
    if (update !== undefined && !cellAxisSignals.some((x) => x.name === name)) cellAxisSignals.push({ name, update })
  }

  // child marks read the per-cell datasets
  const remapFrom = (m: Record<string, unknown>): Record<string, unknown> => {
    const c = { ...m }
    const from = c.from as { data?: string; facet?: { name?: string; data?: string } } | undefined
    if (isSelectionMark(m)) return c // (the selections' marks read no data of the cell)
    if (from?.facet !== undefined) {
      // a series group (one path per series) facets the CELL's data; the facet is named after the child model
      const oldName = from.facet.name
      const newName = typeof oldName === 'string' ? oldName.replace(/^faceted_path_/, `faceted_path_${CH}_`) : oldName
      if (typeof oldName === 'string' && typeof newName === 'string') cellMap.set(oldName, newName)
      c.from = { ...from, facet: { ...from.facet, ...(typeof newName === 'string' ? { name: newName } : {}), data: from.facet.data !== undefined && cellMap.has(from.facet.data) ? cellMap.get(from.facet.data) : FACET } }
    } else if (from === undefined || from.data == null) c.from = { ...(from ?? {}), data: FACET }
    else if (cellMap.has(from.data)) c.from = { ...from, data: cellMap.get(from.data) }
    if (Array.isArray(c.marks)) c.marks = (c.marks as Record<string, unknown>[]).map(remapFrom)
    return c
  }
  // the facet child's marks carry the "child_" name prefix (vega-lite names a facet's child model that way)
  const prefixNames = (m: Record<string, unknown>): Record<string, unknown> => ({
    ...m,
    ...(typeof m.name === 'string' && /^(marks|pathgroup|layer_\d+_.+)$/.test(m.name) ? { name: `${CH}_${m.name}` } : {}),
    ...(Array.isArray(m.marks) ? { marks: (m.marks as Record<string, unknown>[]).map(prefixNames) } : {}),
  })
  const childMarks = innerIsFacet ? (inner.marks as Record<string, unknown>[]) : (inner.marks as Record<string, unknown>[]).map(remapFrom).map(prefixNames)
  // resolve.ts defaultScaleResolve: a facet shares every scale but theta, which each cell owns (`child_theta`, over the cell's data)
  const cellScales: Record<string, unknown>[] = []
  {
    // the data of a scale's domain is the cell's: the facet's partition, or the dataset the cell derives from it
    const mapDomain = (dom: unknown): unknown => {
      if (!isObject(dom)) return dom
      const out: Record<string, unknown> = { ...dom }
      if (typeof out.data === 'string') out.data = cellMap.get(out.data) ?? FACET
      if (Array.isArray(out.fields)) out.fields = out.fields.map((f) => (isObject(f) && typeof f.data === 'string' ? { ...f, data: cellMap.get(f.data) ?? FACET } : f))
      return out
    }
    const innerScalesAll = (inner.scales as ScaleSpec[]) ?? []
    for (const i of innerIsFacet ? [] : indepScales) {
      const at = innerScalesAll.findIndex((sc) => sc.name === i.ch)
      if (at < 0) continue
      const sc = innerScalesAll.splice(at, 1)[0]!
      cellScales.push({ ...sc, name: `${CH}_${i.ch}`, domain: mapDomain(sc.domain) })
    }
  }
  {
    const innerScales = (inner.scales as ScaleSpec[]) ?? []
    const at = innerIsFacet ? -1 : innerScales.findIndex((sc) => sc.name === 'theta')
    if (at >= 0) {
      const theta = innerScales.splice(at, 1)[0]!
      const dom = isObject(theta.domain) && typeof theta.domain.data === 'string' ? { ...theta.domain, data: cellMap.get(theta.domain.data) ?? FACET } : theta.domain
      cellScales.push({ ...theta, name: `${CH}_theta`, domain: dom })
      renameFragment(childMarks, { signals: new Map<string, string>(), scales: new Map([['theta', `${CH}_theta`]]) })
    }
  }
  // (assembleGroupStyle: a view with an x or y channel is a framed cell, any other a plain view)
  const cellStyle = innerIsFacet ? undefined : Array.isArray(innerSpec.layer) ? layeredGroupStyle(collectLeaves(innerSpec)) : unitGroupStyle(innerSpec)
  // (assembleGroupEncodeEntry(false): the child's width / height, then its view background)
  const cellView = innerIsFacet ? undefined : (inner.encode as { update?: Record<string, unknown> } | undefined)?.update

  const facetGroupby = [...colsOf(rowFd, rowField), ...colsOf(colFd, colField), ...colsOf(wrapFd, wrapField)]
  const facetSortFields = [rowField, colField, wrapField].filter(Boolean) as string[]
  const datumRef = (f: string): string => `datum[${JSON.stringify(f)}]`
  // header label signal: a header format formats the parent value (number
  // format for ordinal/nominal, timeFormat for temporal — probed). The
  // header def's label* props map onto the title def (labelColor→color,
  // labelFontSize→fontSize, labelPadding→offset, labelAngle→angle with
  // derived baseline/align).
  const parentTitle = (f: string, def?: FieldDef): unknown => {
    // config.header seeds the defaults; the channel's own header def wins
    const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    const hdr = { ...(cfgHeader ?? {}), ...(def?.raw?.header as Record<string, unknown> | undefined ?? {}) }
    const text = { signal: fieldTextExpr(def ?? ({ field: f, type: 'nominal', raw: {} } as unknown as FieldDef), { lineBreaks: false, spec, expr: 'parent', format: hdr?.format as string | undefined, formatType: hdr?.formatType as string | undefined }) }
    const t: Record<string, unknown> = {
      text,
      orient: 'left',
      style: 'guide-label',
      frame: 'group',
      offset: (hdr?.labelPadding as number | undefined) ?? 10,
    }
    if (hdr?.labelColor != null) t.color = hdr.labelColor
    if (hdr?.labelFontSize != null) t.fontSize = hdr.labelFontSize
    if (hdr?.labelFont != null) t.font = hdr.labelFont
    if (hdr?.labelFontWeight != null) t.fontWeight = hdr.labelFontWeight
    if (hdr?.labelLimit != null) t.limit = hdr.labelLimit
    if (hdr?.labelAlign != null) t.align = hdr.labelAlign
    if (hdr?.labelBaseline != null) t.baseline = hdr.labelBaseline
    if (hdr?.labelAnchor != null) t.labelAnchor = hdr.labelAnchor
    if (hdr?.titleAnchor != null) t.anchor = hdr.titleAnchor
    if (hdr?.labelAngle != null) {
      const ang = Number(hdr.labelAngle)
      t.angle = ang
      // vega derives baseline/align from the angle: positive rotates toward
      // the start (right anchor), negative toward the end (left anchor), and
      // 0 stays centered.
      if (hdr?.labelBaseline == null) t.baseline = 'bottom'
      if (hdr?.labelAlign == null) t.align = ang === 0 ? 'center' : ang < 0 ? 'left' : 'right'
    }
    return t
  }

  // header text for the default (columns-less) facet header
  const headerOf = (d: Record<string, unknown> | undefined): Record<string, unknown> => {
    const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    return { ...(cfgHeader ?? {}), ...((d?.header as Record<string, unknown> | undefined) ?? {}) }
  }
  const sizeSignalsOut = facetChildSignals
  // (model.getName: a named root view carries its name in front of every name it makes: `trellis_barley_facet_domain`)
  const facetModelName = ctx.modelName || (typeof spec.name === 'string' && spec.name !== '' ? signalSafe(spec.name) : '')
  const rowDomainName = ctx.fresh(childModelName(facetModelName, 'row_domain'))
  const columnDomainName = ctx.fresh(childModelName(facetModelName, 'column_domain'))

  if (wrapFd && wrapField) {
    // wrapped facet: one field laid out left-to-right over `columns` columns
    const facetDomain = ctx.fresh(childModelName(facetModelName, 'facet_domain'))
    const rowSeq = ctx.fresh(childModelName(facetModelName, 'facet_domain_row'))
    const colSeq = ctx.fresh(childModelName(facetModelName, 'facet_domain_column'))
    const hdrW = headerOf(wrapDef)
    const nCols = wrapColumns
    const wrapOrder = facetOrder(wrapDef)
    const cellTitle = parentTitle(wrapField, wrapFd) as Record<string, unknown>
    delete cellTitle.orient
    // (the row headers / column footers exist only to carry the axes: none, no group and no sequence behind it)
    const wrapData = [...innerData, { name: facetDomain, source: baseName, transform: [{ type: 'aggregate', groupby: colsOf(wrapFd, wrapField) }] },
      ...(yLabelAxes.length ? [{ name: rowSeq, transform: [{ type: 'sequence', start: 0, stop: nCols === undefined ? 1 : { signal: `ceil(length(data(${JSON.stringify(facetDomain)})) / ${nCols})` } }] }] : []),
      ...(xLabelAxes.length ? [{ name: colSeq, transform: [{ type: 'sequence', start: 0, stop: { signal: nCols === undefined ? `length(data(${JSON.stringify(facetDomain)}))` : `min(length(data(${JSON.stringify(facetDomain)})), ${nCols})` } }] }] : []),
    ]
    const wrapMarks: Record<string, unknown>[] = [
      // (header/assemble.ts assembleTitleGroup: an empty title - `header: {title: null}` - is no title group)
      ...(hdrW.title === null || hdrW.title === '' ? [] : [{ name: 'facet-title', type: 'group', role: 'column-title', title: { text: hdrW.title ?? channelTitle(wrapFd), style: 'guide-title', offset: (hdrW.titlePadding as number | undefined) ?? 10 } }]),
      ...(yLabelAxes.length ? [{ name: own('row_header'), type: 'group', role: 'row-header', from: { data: rowSeq }, encode: { update: { height: { signal: `${CH}_height` } } }, axes: yLabelAxes }] : []),
      ...(xLabelAxes.length ? [{ name: own('column_footer'), type: 'group', role: 'column-footer', from: { data: colSeq }, encode: { update: { width: { signal: `${CH}_width` } } }, axes: xLabelAxes }] : []),
      {
        name: CELL,
        type: 'group',
        title: cellTitle,
        style: cellStyle,
        from: { facet: facetFrom(colsOf(wrapFd, wrapField)) },
        sort: { field: [datumRef(wrapSort?.cellField ?? wrapField)], order: [wrapOrder] },
        encode: { update: { width: { signal: `${CH}_width` }, height: { signal: `${CH}_height` }, ...cellView } },
        ...(innerSel ? { signals: assembleFacetSignals(cellName, [...cellAxisSignals, ...innerSel.unit]) } : cellAxisSignals.length ? { signals: cellAxisSignals } : {}),
        ...(cellData.length ? { data: cellData } : {}),
        ...(gridAxes.length ? { axes: gridAxes } : {}),
        ...(cellScales.length ? { scales: cellScales } : {}),
        marks: childMarks,
      },
    ]
    const wrapOut: Record<string, unknown> = {}
    if (spec.$schema) wrapOut.$schema = VEGA_SCHEMA
    wrapOut.autosize = autosizeOf(spec)
    wrapOut.data = wrapData
    wrapOut.signals = sizeSignalsOut
    if (innerSel) SEL_PARTS.set(wrapOut, { data: innerSel.data, top: innerSel.top, unit: [] })
    wrapOut.layout = compositeLayout({ ...spec, spacing: spec.spacing ?? wrapDef?.spacing, align: spec.align ?? wrapDef?.align, bounds: spec.bounds ?? wrapDef?.bounds, center: spec.center ?? wrapDef?.center }, { align: 'all', columns: nCols })
    wrapOut.marks = wrapMarks
    wrapOut.scales = inner.scales
    if (Array.isArray(inner.projections) && inner.projections.length) wrapOut.projections = inner.projections
    if (inner.legends && (inner.legends as unknown[]).length) wrapOut.legends = inner.legends
    rootChrome(wrapOut, spec)
    return wrapOut
  }

  // --- row / column headers (vega-lite compile/header/*) ---------------------
  const cfgAll = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  const cfgHeaderBase: Record<string, unknown> = { titlePadding: 10, labelPadding: 10, ...(isObject(cfgAll.header) ? (cfgAll.header as Record<string, unknown>) : {}) }
  // getHeaderProperty: the channel's own header, then config.headerRow/headerColumn, then config.header
  const hdrProp = (prop: string, def: Record<string, unknown> | undefined, ch: 'row' | 'column'): unknown => {
    const hd = isObject(def?.header) ? (def!.header as Record<string, unknown>) : undefined
    let own = hd?.[prop]
    // header.orient is a shortcut for labelOrient + titleOrient (channeldef normalize)
    if (!own && (prop === 'labelOrient' || prop === 'titleOrient') && hd?.orient) own = hd.orient
    if (own !== undefined) return own
    const specific = cfgAll[ch === 'row' ? 'headerRow' : 'headerColumn']
    if (isObject(specific) && specific[prop] !== undefined) return specific[prop]
    return cfgHeaderBase[prop]
  }
  const headerChannelOf = (ch: 'row' | 'column', orient: unknown): 'row' | 'column' =>
    orient === 'top' || orient === 'bottom' ? 'column' : orient === 'left' || orient === 'right' ? 'row' : ch
  const TITLE_MAP: Record<string, string> = {
    titleAlign: 'align', titleAnchor: 'anchor', titleAngle: 'angle', titleBaseline: 'baseline', titleColor: 'color', titleFont: 'font',
    titleFontSize: 'fontSize', titleFontStyle: 'fontStyle', titleFontWeight: 'fontWeight', titleLimit: 'limit', titleLineHeight: 'lineHeight',
    titleOrient: 'orient', titlePadding: 'offset',
  }
  const LABEL_MAP: Record<string, string> = {
    labelAlign: 'align', labelAnchor: 'anchor', labelAngle: 'angle', labelBaseline: 'baseline', labelColor: 'color', labelFont: 'font',
    labelFontSize: 'fontSize', labelFontStyle: 'fontStyle', labelFontWeight: 'fontWeight', labelLimit: 'limit', labelLineHeight: 'lineHeight',
    labelOrient: 'orient', labelPadding: 'offset',
  }
  const mapProps = (def: Record<string, unknown> | undefined, ch: 'row' | 'column', map: Record<string, string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [prop, target] of Object.entries(map)) {
      const v = hdrProp(prop, def, ch)
      if (v !== undefined) out[target] = v
    }
    return out
  }
  // (header/assemble.ts passes the angle as written: -90 is not 270 to defaultHeaderGuideBaseline)
  const headerAngle = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  // defaultHeaderGuideBaseline / defaultHeaderGuideAlign
  const guideBaseline = (angle: number | undefined, hc: 'row' | 'column'): Record<string, unknown> => {
    if (angle === undefined) return {}
    const b = defaultLabelBaseline(angle, hc === 'row' ? 'left' : 'top', hc === 'row' ? 'y' : 'x', true)
    return b ? { baseline: b } : {}
  }
  const guideAlign = (hc: 'row' | 'column', angle: number | undefined, anchor: unknown): Record<string, unknown> => {
    if (anchor === 'start') return { align: 'left' }
    if (anchor === 'end') return { align: 'right' }
    if (angle === undefined) return {}
    const a = defaultLabelAlign(angle, hc === 'row' ? 'left' : 'top', hc === 'row' ? 'y' : 'x')
    return a ? { align: a } : {}
  }
  const titleGroup = (ch: 'row' | 'column', def: Record<string, unknown>, fd: FieldDef | null | undefined, field: string): Record<string, unknown> => {
    const hc = headerChannelOf(ch, hdrProp('titleOrient', def, ch))
    // (assembleTitleGroup normalizes the title angle; assembleLabelTitle does not)
    const titleAngleRaw = hdrProp('titleAngle', def, ch)
    const angle = typeof titleAngleRaw === 'number' ? normalizeAngle(titleAngleRaw) : undefined
    const header = isObject(def.header) ? (def.header as Record<string, unknown>) : {}
    return {
      name: `${ch}-title`,
      type: 'group',
      role: `${hc}-title`,
      title: {
        text: header.title ?? (fd ? channelTitle(fd) : field),
        ...(ch === 'row' ? { orient: 'left' } : {}),
        style: 'guide-title',
        ...guideBaseline(angle, hc),
        ...guideAlign(hc, angle, hdrProp('titleAnchor', def, ch)),
        ...mapProps(def, ch, TITLE_MAP),
      },
    }
  }
  // assembleLabelTitle: the facet value text, with its label* properties
  const labelTitle = (ch: 'row' | 'column', def: Record<string, unknown>, fd: FieldDef | null | undefined, field: string): Record<string, unknown> => {
    const base = parentTitle(field, fd ?? normalizeHeaderDef(def)) as Record<string, unknown>
    let text = base.text as { signal: string }
    const labelExpr = hdrProp('labelExpr', def, ch)
    if (typeof labelExpr === 'string') {
      text = { signal: labelExpr.split('datum.label').join(text.signal).split('datum.value').join(`parent[${JSON.stringify(field)}]`) }
    }
    const hc = headerChannelOf(ch, hdrProp('labelOrient', def, ch))
    const angle = headerAngle(hdrProp('labelAngle', def, ch))
    return {
      text,
      ...(ch === 'row' ? { orient: 'left' } : {}),
      style: 'guide-label',
      frame: 'group',
      ...guideBaseline(angle, hc),
      ...guideAlign(hc, angle, hdrProp('labelAnchor', def, ch)),
      ...mapProps(def, ch, LABEL_MAP),
    }
  }
  const labelsOn = (def: Record<string, unknown> | undefined): boolean => {
    if (def?.header === null) return false // (header: null - no title and no labels)
    const own = isObject(def?.header) ? (def!.header as Record<string, unknown>).labels : undefined
    return (own ?? cfgHeaderBase.labels ?? true) as boolean
  }

  const channels: Array<{ ch: 'row' | 'column'; def?: Record<string, unknown>; fd?: FieldDef | null; field?: string; domain: string; order: string; axes: Record<string, unknown>[]; size: string }> = [
    { ch: 'row', def: rowDef, fd: rowFd, field: rowField, domain: rowDomainName, order: rowOrder, axes: yLabelAxes, size: indepOf('y')?.sizeExpr ?? `${CH}_height` },
    { ch: 'column', def: colDef, fd: colFd, field: colField, domain: columnDomainName, order: colOrder, axes: xLabelAxes, size: indepOf('x')?.sizeExpr ?? `${CH}_width` },
  ]
  const marks: Record<string, unknown>[] = []
  // title groups first (row, then column), then the header/footer groups per channel
  // (a header title that is empty - or a header that is null - is no title group)
  const hasTitle = (c: { def?: Record<string, unknown> }): boolean => c.def?.header !== null && !(isObject(c.def?.header) && 'title' in (c.def!.header as Record<string, unknown>) && !(c.def!.header as Record<string, unknown>).title)
  for (const c of channels) {
    if (!c.field || !c.def) continue
    const outerTitle = hasTitle(c) ? titleGroup(c.ch, c.def, c.fd, c.field) : undefined
    // header/parse.ts parseFacetHeader: the title of the inner facet's header on the same channel joins this one's ("Origin / Cylinders") and
    // leaves the inner facet (its layout no longer offsets for it)
    const at = innerIsFacet ? childMarks.findIndex((m) => m.name === `${c.ch}-title`) : -1
    if (at >= 0) {
      const innerTitle = (childMarks[at]!.title as { text?: unknown } | undefined)?.text
      childMarks.splice(at, 1)
      const offsets = (inner.layout as { offset?: Record<string, number> } | undefined)?.offset
      if (offsets) {
        delete offsets[`${c.ch}Title`]
        if (Object.keys(offsets).length === 0) delete (inner.layout as { offset?: unknown }).offset
      }
      if (outerTitle && innerTitle !== undefined && innerTitle !== null && innerTitle !== '') {
        const t = outerTitle.title as { text?: unknown }
        t.text = `${Array.isArray(t.text) ? t.text.join(', ') : String(t.text)} / ${Array.isArray(innerTitle) ? innerTitle.join(', ') : String(innerTitle)}`
      }
    }
    if (outerTitle) marks.push(outerTitle)
  }
  let cellTitle: Record<string, unknown> | undefined
  // the layout the inner facet gives the cells it holds; with a column facet it takes its column count from the cell (`columns` above)
  const nestedLayout = (): Record<string, unknown> => {
    const layout = { ...(inner.layout as Record<string, unknown>) }
    if (nestedColField !== undefined) delete layout.columns
    return layout
  }
  const headerBands: Partial<Record<'header' | 'footer', Record<string, number>>> = {}
  for (const c of channels) {
    const faceted = c.field !== undefined && c.def !== undefined
    const labelOrient = faceted ? hdrProp('labelOrient', c.def, c.ch) : undefined
    const labelType = labelOrient === 'bottom' || labelOrient === 'right' ? 'footer' : 'header'
    const types: Record<'header' | 'footer', { labels: boolean; axes: Record<string, unknown>[] } | undefined> = { header: undefined, footer: undefined }
    if (faceted) types[labelType] = { labels: labelsOn(c.def), axes: [] }
    for (const a of c.axes) {
      const t = a.orient === 'top' || a.orient === 'left' ? 'header' : 'footer'
      ;(types[t] ??= { labels: false, axes: [] }).axes.push(a)
    }
    for (const t of ['header', 'footer'] as const) {
      const comp = types[t]
      if (!comp) continue
      // (facet.ts getHeaderLayoutMixins: a facet whose child has no size signal - a facet - lays its headers out by their band)
      if (innerIsFacet && faceted) (headerBands[t] ??= {})[c.ch] = 0.5
      // the label text joins the header when the label orient runs along the channel
      const aligned = faceted && comp.labels && (c.ch === 'row' ? labelOrient !== 'top' && labelOrient !== 'bottom' : labelOrient !== 'left' && labelOrient !== 'right')
      const title = aligned ? labelTitle(c.ch, c.def!, c.fd, c.field!) : undefined
      if (!title && comp.axes.length === 0) continue
      marks.push({
        name: own(`${c.ch}_${t}`),
        type: 'group',
        role: `${c.ch}-${t}`,
        ...(faceted ? { from: { data: c.domain }, sort: { field: datumRef((c.ch === 'row' ? rowSort : colSort)?.headerField ?? c.field!), order: c.order } } : {}),
        ...(title ? { title } : {}),
        ...(innerIsFacet ? {} : { encode: { update: { [c.ch === 'row' ? 'height' : 'width']: { signal: c.size } } } }),
        ...(comp.axes.length ? { axes: comp.axes } : {}),
      })
    }
    // an orthogonal label orient shows the labels as the cell's own title
    if (faceted && !cellTitle && (c.ch === 'row' ? labelOrient === 'top' || labelOrient === 'bottom' : labelOrient === 'left' || labelOrient === 'right')) cellTitle = labelTitle(c.ch, c.def!, c.fd, c.field!)
  }
  marks.push({
    name: CELL,
    type: 'group',
    ...(cellTitle ? { title: cellTitle } : {}),
    ...(innerIsFacet ? {} : { style: cellStyle }),
    from: { facet: facetFrom(facetGroupby) },
    sort: { field: [rowSort?.cellField ?? rowField, colSort?.cellField ?? colField].filter(Boolean).map((f) => datumRef(f as string)), order: facetSortFields.map((_, i) => (i === 0 && rowField ? rowOrder : colOrder)) },
    // (a cell that holds a facet has no size of its own: the inner cells give it one; the columns it lays them out by are counted by the facet)
    ...(innerIsFacet
      ? nestedColField !== undefined ? { encode: { update: { columns: { field: `distinct_${nestedColField}` } } } } : {}
      : { encode: { update: { width: { signal: indepOf('x')?.sizeExpr ?? `${CH}_width` }, height: { signal: indepOf('y')?.sizeExpr ?? `${CH}_height` }, ...cellView } } }),
    ...(innerSel ? { signals: assembleFacetSignals(cellName, [...cellAxisSignals, ...innerSel.unit]) } : cellAxisSignals.length ? { signals: cellAxisSignals } : {}),
    ...(cellData.length ? { data: cellData } : {}),
    ...(gridAxes.length ? { axes: gridAxes } : {}),
    ...(cellScales.length ? { scales: cellScales } : {}),
    ...(innerIsFacet ? { layout: nestedLayout() } : {}),
    marks: childMarks,
  })

  // facet domain datasets
  const data = [...innerData]
  // probed: an aggregated facet def does NOT aggregate the child pipeline —
  // every facet reference (cell groupby, domain, stack series, header label)
  // keys on the aggregated name, which the pipeline never computes, so the
  // facet collapses to a single (undefined) group exactly like upstream
  // (data/facet.ts assemble: a row x column facet with independent step-sized scales counts the cardinalities per cell, in a crossed dataset)
  const stepped = indepScales.filter((i) => i.distinct !== undefined)
  const crossedName = rowFd && colFd && stepped.length ? `cross_${columnDomainName}_${rowDomainName}` : undefined
  if (crossedName) {
    const cf = [...stepped.filter((i) => i.ch === 'x'), ...stepped.filter((i) => i.ch === 'y')].map((i) => i.field!)
    data.push({ name: crossedName, source: baseName, transform: [{ type: 'aggregate', groupby: [...colsOf(rowFd, rowField), ...colsOf(colFd, colField)], fields: cf, ops: cf.map(() => 'distinct') }] })
  }
  /** assembleRowColumnHeaderData: the cardinality of the independent scale along the channel, then the sort field */
  const headerAggregate = (child: 'x' | 'y', sort: FacetSortInfo | undefined): Record<string, unknown> => {
    const i = indepOf(child)
    const cardF: string[] = []
    const cardO: string[] = []
    const cardA: string[] = []
    if (i?.distinct !== undefined) {
      cardF.push(crossedName ? i.distinct : i.field!)
      cardO.push(crossedName ? 'max' : 'distinct')
      cardA.push(i.distinct)
    }
    const f = [...cardF, ...(sort ? sort.domainFields : [])]
    return f.length ? { fields: f, ops: [...cardO, ...(sort ? sort.domainOps : [])], as: [...cardA, ...(sort ? sort.domainAs : [])] } : {}
  }
  if (colField) data.push({ name: columnDomainName, source: crossedName ?? baseName, transform: [{ type: 'aggregate', groupby: colsOf(colFd, colField), ...headerAggregate('x', colSort) }] })
  if (rowField) data.push({ name: rowDomainName, source: crossedName ?? baseName, transform: [{ type: 'aggregate', groupby: colsOf(rowFd, rowField), ...headerAggregate('y', rowSort) }] })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = VEGA_SCHEMA
  out.autosize = autosizeOf(spec)
  out.data = data
  out.signals = sizeSignalsOut
  if (innerSel) SEL_PARTS.set(out, { data: innerSel.data, top: innerSel.top, unit: [] })
  const rowSpacing = typeof rowDef?.spacing === 'number' ? rowDef.spacing : undefined
  const colSpacing = typeof colDef?.spacing === 'number' ? colDef.spacing : undefined
  // titleOrient right/bottom anchor the title group at the end; the anchor also picks the title band
  const layoutTitleAnchor: Record<string, string> = {}
  const layoutTitleBand: Record<string, number> = {}
  for (const c of channels) {
    if (!c.field || !c.def) continue
    const to = hdrProp('titleOrient', c.def, c.ch)
    const hc = headerChannelOf(c.ch, to)
    if (to === 'right' || to === 'bottom') layoutTitleAnchor[hc] = 'end'
    const anchor = hdrProp('titleAnchor', c.def, c.ch)
    const band = hc === 'column' ? { start: 0, end: 1 }[anchor as 'start' | 'end'] : { start: 1, end: 0 }[anchor as 'start' | 'end']
    if (band !== undefined) layoutTitleBand[hc] = band
  }
  // spacing/align/center may be given per facet channel (row/column) or for the whole facet
  const perChannel = (key: string): { row?: unknown; column?: unknown } | undefined => {
    const r = rowDef?.[key]
    const c = colDef?.[key]
    return r !== undefined || c !== undefined ? { ...(r !== undefined ? { row: r } : {}), ...(c !== undefined ? { column: c } : {}) } : undefined
  }
  const layoutSpacing = spec.spacing ?? (rowSpacing != null || colSpacing != null ? { row: rowSpacing ?? 20, column: colSpacing ?? 20 } : 20)
  // (facet.ts assembleDefaultLayout: cells are not aligned along a direction whose scale is independent, unless both row and column are given)
  const defaultAlign = !rowFd && indepOf('x') ? 'none' : !colFd && indepOf('y') ? 'none' : 'all'
  const layoutAlign = spec.align ?? (perChannel('align') ? { row: rowDef?.align ?? 'all', column: colDef?.align ?? 'all' } : defaultAlign)
  const layoutCenter = spec.center ?? (perChannel('center') ? { row: rowDef?.center ?? false, column: colDef?.center ?? false } : undefined)
  const titleOffsets: Record<string, number> = {
    ...(rowField && hasTitle({ def: rowDef }) ? { rowTitle: 10 } : {}),
    ...(colField && hasTitle({ def: colDef }) ? { columnTitle: 10 } : {}),
  }
  out.layout = {
    padding: layoutSpacing,
    ...(Object.keys(layoutTitleAnchor).length ? { titleAnchor: layoutTitleAnchor } : {}),
    ...(headerBands.header ? { headerBand: headerBands.header } : {}),
    ...(headerBands.footer ? { footerBand: headerBands.footer } : {}),
    ...(Object.keys(titleOffsets).length ? { offset: titleOffsets } : {}),
    columns: colField ? { signal: `length(data(${JSON.stringify(columnDomainName)}))` } : 1,
    bounds: spec.bounds ?? 'full',
    align: layoutAlign,
    ...(layoutCenter !== undefined ? { center: layoutCenter } : {}),
    ...(Object.keys(layoutTitleBand).length ? { titleBand: layoutTitleBand } : {}),
  }
  out.marks = marks
  out.scales = inner.scales
  // (a map in the cells: the projection is the facet's, fitted to the data the cells share)
  if (Array.isArray(inner.projections) && inner.projections.length) out.projections = inner.projections
  if (inner.axes == null) delete inner.axes
  if (inner.legends && (inner.legends as unknown[]).length) out.legends = inner.legends
  rootChrome(out, spec)
  return out
}

// --- concat / repeat composition ---------------------------------------------

/** Channels that own a scale (those whose aggregate output takes part in the invalid-value filter). */
const SCALE_CHANNELS = ['x', 'y', 'color', 'size', 'opacity', 'shape', 'strokeWidth', 'theta', 'xOffset', 'yOffset']

/** Scale channels that are SHARED across the children of a concat/repeat (vega-lite's default resolve). */
const SHARED_SCALES = new Set(['color', 'fill', 'stroke', 'size', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'shape', 'angle'])

/** Compile a child view (unit, layer or boxplot) to a standalone Vega fragment. */
function compileChildFragment(child: VLSpec, ctx: CompileCtx): VLSpec {
  if (child.hconcat !== undefined || child.vconcat !== undefined || child.concat !== undefined) return compileConcat(child, ctx)
  if (child.repeat !== undefined) return compileRepeat(child, ctx)
  if (child.facet !== undefined) return compileFaceted(child, ctx)
  if (Array.isArray(child.layer)) return compileLayered(child, ctx)
  return compileUnitView(child, ctx)
}

interface CompositeCell {
  /** Names prefix, e.g. `concat_0_` or `child__x_`. */
  prefix: string
  /** The child spec (data/transform already inherited, config propagated). */
  spec: VLSpec
}

type SizePlan = 'root' | 'shared' | 'per-child'

interface CompositeResult {
  data: Record<string, unknown>[]
  /** the children's projections, hoisted to the root (each named after its cell) */
  projections: Record<string, unknown>[]
  /** the projection the children's merged into, when they did (a composite parent may merge it further) */
  projectionComp?: ProjectionComponent
  signals: Record<string, unknown>[]
  marks: Record<string, unknown>[]
  scales: ScaleSpec[]
  legends: Record<string, unknown>[]
  /** root size properties (the cross dimension of a single row/column) */
  rootWidth?: unknown
  rootHeight?: unknown
  /** the selections of the children: their stores and top-level signals (their own signals are in their groups) */
  selection?: SelParts
}

/**
 * Embed compiled children as groups: datasets are shared by source and
 * renamed apart, positional scales are prefixed per child, non-positional
 * scales are SHARED across children (merged, domains unioned) with one legend
 * per channel, and sizes follow vega-lite's layout-size merging.
 */
function embedCells(cells: CompositeCell[], parent: VLSpec, ctx: CompileCtx, layout: 'row' | 'column' | 'grid'): CompositeResult {
  const parentResolve = (isObject(parent.resolve) ? parent.resolve : {}) as { scale?: Record<string, string>; legend?: Record<string, string> }
  const parentData = isObject(parent.data) ? dataSource(parent.data, ctx.datasets) : undefined
  const parentSourceName = parentData ? (typeof parentData.name === 'string' ? parentData.name : ctx.takeSource()) : ''
  const parentTransform = Array.isArray(parent.transform) ? (parent.transform as unknown[]) : []
  // (the counter is the compile's, not this embedding's: a nested composite must not reuse a sibling's source names)
  let nextData = 0
  const data: Record<string, unknown>[] = []
  const emitted = new Map<string, string>() // source name -> JSON of its definition

  // 1. children inherit data/transform, then compile
  const frags = cells.map((cell) => {
    const child: VLSpec = { ...cell.spec }
    if (child.data === undefined) {
      if (parentData) child.data = { ...parentData, name: parentSourceName }
      if (parentTransform.length) child.transform = [...parentTransform, ...(Array.isArray(child.transform) ? child.transform : [])]
    } else if (isObject(child.data) && typeof child.data.name !== 'string') {
      child.data = { ...dataSource(child.data, ctx.datasets), name: ctx.takeSource() }
    }
    if (parent.config !== undefined) child.config = parent.config
    // (variable parameters are declared once at the root; the selections stay with the units they belong to)
    if (Array.isArray(child.params)) {
      const selections = (child.params as unknown[]).filter((p) => isObject(p) && p.select !== undefined)
      if (selections.length) child.params = selections
      else delete child.params
    }
    const vg = inChildView(ctx, cell.prefix.replace(/_$/, ''), [], true, () => compileChildFragment(child, ctx))
    return { cell, vg, spec: child }
  })

  // 2. size plan per dimension
  const sameFixed = (dim: 'width' | 'height'): number | undefined => {
    const vals = frags.map((f) => f.vg[dim])
    const first = vals[0]
    return typeof first === 'number' && vals.every((v) => v === first) ? first : undefined
  }
  const sameW = sameFixed('width')
  const sameH = sameFixed('height')
  const planW: SizePlan = sameW !== undefined ? (layout === 'column' ? 'root' : 'shared') : 'per-child'
  const planH: SizePlan = sameH !== undefined ? (layout === 'row' ? 'root' : 'shared') : 'per-child'

  const signals: Record<string, unknown>[] = []
  if (planW === 'shared') signals.push({ name: 'childWidth', value: sameW })
  if (planH === 'shared') signals.push({ name: 'childHeight', value: sameH })

  const marks: Record<string, unknown>[] = []
  const projections: Record<string, unknown>[] = []
  /** the cells with projections: finished below, once their siblings' are known (vega-lite merges compatible ones) */
  const cellGeo: Array<{ vg: VLSpec; prefix: string; projList: Record<string, unknown>[]; unitData: Record<string, unknown>[]; comp: ProjectionComponent | undefined }> = []
  const scaleLists = new Map<string, ScaleSpec[]>()
  const legendsByChannel = new Map<string, Record<string, unknown>>()
  const legendOrder: string[] = []
  const independentScales: ScaleSpec[] = []
  const cellScales: Array<{ marks: Record<string, unknown>[]; shared: string[] }> = []
  const selectionParts: SelParts[] = []

  frags.forEach(({ cell, vg }) => {
    const { prefix } = cell
    // (a repeat names its children itself, `child__column_x`: a composite around it does not put its own name in front)
    const ownNamed = (name: string): boolean => cell.spec.repeat !== undefined && name.startsWith('child__')
    const prefixed = (name: string): string => (ownNamed(name) ? name : `${prefix}${name}`)
    const dnames = new Map<string, string>()
    const unitData = (vg.data as Record<string, unknown>[]) ?? []
    // datasets: the first is the child's source, the rest derive from it
    unitData.forEach((d, di) => {
      const name = d.name as string
      if (di === 0) {
        const def = JSON.stringify({ ...d, name: undefined })
        const seen = emitted.get(name)
        if (seen === undefined) {
          emitted.set(name, def)
          data.push(d)
        } else if (seen !== def) {
          throw new VLCompileError(`two children declare different data under the same name "${name}"`)
        }
        return
      }
      // (a dataset a view named for itself - `concat_0_column_domain` - keeps its name, only the numbered ones are renumbered)
      const generated = name.startsWith(ctx.dn(0).slice(0, -1))
      const newName = generated ? ctx.dn(nextData++) : name
      dnames.set(name, newName)
      const srcRef = d.source as string | undefined
      data.push({ ...d, name: newName, ...(srcRef !== undefined ? { source: dnames.get(srcRef) ?? srcRef } : {}) })
    })
    renameDataRefs(vg.scales, dnames)
    renameDataRefs(vg.marks, dnames)
    renameDataRefs(vg.axes ?? [], dnames)

    // names: signals and scales
    const sigMap = new Map<string, string>()
    const wName = planW === 'root' ? 'width' : planW === 'shared' ? 'childWidth' : `${prefix}width`
    const hName = planH === 'root' ? 'height' : planH === 'shared' ? 'childHeight' : `${prefix}height`
    sigMap.set('width', wName)
    sigMap.set('height', hName)
    const ownSignals = (vg.signals as Record<string, unknown>[] | undefined) ?? []
    for (const sg of ownSignals) {
      const n = sg.name as string
      if (n !== 'width' && n !== 'height') sigMap.set(n, prefixed(n))
    }
    const scaleMap = new Map<string, string>()
    const scales = (vg.scales as ScaleSpec[]) ?? []
    for (const sc of scales) {
      // everything but the shared (legend-bearing) channels is private to its child; resolve.scale decides the rest
      const asked = parentResolve.scale?.[sc.name]
      if (asked === 'independent' || (asked !== 'shared' && !SHARED_SCALES.has(sc.name))) scaleMap.set(sc.name, prefixed(sc.name))
    }
    // maps: the geojson transforms' signals and the projections are global names: a cell's own are prefixed
    const geojsonTransforms = unitData.flatMap((d) => ((d.transform as Record<string, unknown>[] | undefined) ?? []).filter((t) => t.type === 'geojson' && typeof t.signal === 'string'))
    for (const t of geojsonTransforms) sigMap.set(t.signal as string, prefixed(t.signal as string))
    // a binned field's extent / bins signals are the cell's own as well (bin.ts getBinSignalName names them after the model)
    const binTransforms = unitData.flatMap((d) => ((d.transform as Record<string, unknown>[] | undefined) ?? []).filter((t) => (t.type === 'bin' || t.type === 'extent') && typeof t.signal === 'string'))
    for (const t of binTransforms) sigMap.set(t.signal as string, prefixed(t.signal as string))
    const projList = (vg.projections as Record<string, unknown>[] | undefined) ?? []
    const projMap = new Map(projList.map((p) => [p.name as string, `${prefix}${p.name as string}`]))
    const renames = { signals: sigMap, scales: scaleMap, datasets: dnames }
    renameFragment(vg.layout, renames)
    for (const t of binTransforms) {
      const own = t.signal as string
      renameFragment(t, renames)
      t.signal = sigMap.get(own)
    }
    // (a bin that shares another layer's bins signal declares none of its own, but reads the shared extent signal)
    for (const d of unitData) for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) if (t.type === 'bin' && typeof t.signal !== 'string') renameFragment(t, renames)
    renameFragment(projList, renames)
    renameFragment(vg.scales, renames)
    renameFragment(vg.marks, renames)
    renameFragment(vg.axes ?? [], renames)
    renameFragment(vg.legends ?? [], renames)
    renameFragment(ownSignals, renames)
    // the selections' signals keep their names (a selection is named once, for every unit); what they read of the view is renamed
    const selParts = SEL_PARTS.get(vg)
    if (selParts) {
      renameFragment(selParts.unit, { signals: new Map([['width', wName], ['height', hName]]), scales: scaleMap, datasets: dnames })
      selectionParts.push(selParts)
    }
    for (const sc of scales) {
      const to = scaleMap.get(sc.name)
      if (to !== undefined) sc.name = to
    }
    if (projList.length) {
      for (const t of geojsonTransforms) t.signal = sigMap.get(t.signal as string)
      // the cell's own root component reads this cell's signals (its size, its geojson fits): in the composite's names
      const comp = FRAG_PROJECTION.get(vg)
      if (comp) {
        renameComponentSignals(comp, (e) => renameExpr(e, renames), (n) => sigMap.get(n) ?? n)
        // ...and its fit's datasets (each leaf once: a merged component lists a leaf per child it took over)
        const seen = new Set<object>()
        for (const d of comp.data ?? []) {
          if (!('main' in d) || seen.has(d.main)) continue
          seen.add(d.main)
          const local = HANDLE_MAIN.get(d.main)!
          HANDLE_MAIN.set(d.main, dnames.get(local) ?? local)
        }
      }
      cellGeo.push({ vg, prefix, projList, unitData, comp })
    }
    // signal definitions carry their own (renamed) name
    for (const sg of ownSignals) {
      const n = sg.name as string
      const to = sigMap.get(n)
      if (to !== undefined && (n === 'width' || n === 'height')) {
        if ((n === 'width' && planW === 'per-child') || (n === 'height' && planH === 'per-child')) signals.push({ ...sg, name: to })
      } else if (to !== undefined) signals.push({ ...sg, name: to })
    }
    // a fixed-size child gets its size signal when sizes are per child
    if (planW === 'per-child' && typeof vg.width === 'number') signals.push({ name: wName, value: vg.width })
    if (planH === 'per-child' && typeof vg.height === 'number') signals.push({ name: hName, value: vg.height })

    // sort the renamed scales into independent (prefixed, already renamed) and shared
    const sharedNames: string[] = []
    for (const sc of scales) {
      if (cellPrefixed(sc.name, prefix) || ownNamed(sc.name)) independentScales.push(sc)
      else {
        const l = scaleLists.get(sc.name)
        if (l) l.push(sc)
        else scaleLists.set(sc.name, [sc])
        sharedNames.push(sc.name)
      }
    }
    // shared legends: the first child that has a channel defines it; titles join
    const ownLegends: Record<string, unknown>[] = []
    for (const lg of ((vg.legends as Record<string, unknown>[] | undefined) ?? [])) {
      const ch = legendChannel(lg)
      // resolve.ts parseGuideResolve: an independent scale has independent legends, and resolve.legend can ask for them
      const channel = ch.startsWith(prefix) ? ch.slice(prefix.length) : ch
      if (cellPrefixed(ch, prefix) || ownNamed(ch) || GROUP_LEGENDS.has(lg) || parentResolve.legend?.[channel] === 'independent') { ownLegends.push(lg); continue }
      const have = legendsByChannel.get(ch)
      if (!have) {
        legendsByChannel.set(ch, lg)
        legendOrder.push(ch)
      } else mergeLegend(have, lg)
    }

    // a nested composition lays its own children out (a group-level layout) and has no size of its own
    const composite = vg.layout !== undefined
    const group: Record<string, unknown> = composite
      ? { name: `${prefix}group`, type: 'group' }
      : {
          name: `${prefix}group`,
          type: 'group',
          style: (vg.style as string | string[] | undefined) ?? 'cell',
          encode: { update: { width: { signal: wName }, height: { signal: hName }, ...(vg.encode as { update?: Record<string, unknown> } | undefined)?.update } },
        }
    if (composite) group.layout = vg.layout
    // (the child's title is assembled already: framed on its group for a unit / layer, anchored at the start for a composition)
    if (vg.title) group.title = vg.title
    // a unit's selection signals are its group's (vega-lite: one copy per group item)
    if (selParts?.unit.length) group.signals = selParts.unit
    // vega-lite names every mark after its model, and a child's model carries its parent's prefix (`concat_0_marks`)
    // (a repeat names its marks `child__x_marks` whatever view holds it)
    group.marks = cell.spec.repeat !== undefined ? (vg.marks as Record<string, unknown>[]) : (vg.marks as Record<string, unknown>[]).map((m) => prefixMarkNames(m, prefix))
    if (Array.isArray(vg.axes) && vg.axes.length) group.axes = vg.axes
    if (ownLegends.length) group.legends = ownLegends
    marks.push(group)
    cellScales.push({ marks: group.marks as Record<string, unknown>[], shared: sharedNames })
  })

  // mark.ts scaleClip: a unit is clipped when its x or y scale follows a selection - the shared scale of the whole concat included,
  // whichever sibling's selection it is (`selectionExtent` is a property of the merged scale component)
  for (const { marks: cellMarks, shared } of cellScales) {
    if (shared.some((name) => (name === 'x' || name === 'y') && scaleLists.get(name)!.some((sc) => SELECTION_EXTENT_SCALES.has(sc)))) {
      flagSelectionMarks(cellMarks, false, false, true)
    }
  }

  // maps: vega-lite's parseNonUnitProjections for a concat / repeat: the children's projections merge into
  // one (fitted to the union of their data) wherever no property conflicts
  let projectionComp: ProjectionComponent | undefined
  if (cellGeo.length) {
    projectionComp = mergeLayerProjections(`${rootNamePrefix(parent)}projection`, cellGeo.map((c) => c.comp))
    if (projectionComp) pushAll(projections, assembleProjection(projectionComp, (h) => HANDLE_MAIN.get(h)!))
    for (const cell of cellGeo) {
      // a projection the composite took over is drawn once, there; the others are named after their cell
      const projMap = new Map<string, string>()
      for (const pj of cell.projList) {
        const from = ASSEMBLED_FROM.get(pj)
        projMap.set(pj.name as string, from?.merged ? finalProjectionName(from)! : `${cell.prefix}${pj.name as string}`)
      }
      const retarget = (t: Record<string, unknown>): void => {
        if ((t.type === 'geopoint' || t.type === 'geoshape') && typeof t.projection === 'string') t.projection = projMap.get(t.projection) ?? t.projection
      }
      for (const d of cell.unitData) for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) retarget(t)
      const walkMarks = (ms: unknown): void => {
        for (const m of (ms as Record<string, unknown>[] | undefined) ?? []) {
          for (const t of (m.transform as Record<string, unknown>[] | undefined) ?? []) retarget(t)
          walkMarks(m.marks)
        }
      }
      walkMarks(cell.vg.marks)
      for (const pj of cell.projList) {
        const from = ASSEMBLED_FROM.get(pj)
        if (from?.merged) continue
        pj.name = projMap.get(pj.name as string)
        projections.push(pj)
      }
    }
  }

  // legend/assemble.ts assembleLegends: legends of different channels over the SAME domain (a colour in one view, a size in
  // another, both of field `c`) are one legend, whatever the channel
  {
    const domainKey = (ch: string): string | undefined => {
      const d = scaleLists.get(ch)?.[0]?.domain
      return d === undefined ? undefined : JSON.stringify(isObject(d) && typeof d.data === 'string' ? { ...d, data: undefined } : d)
    }
    const byDomain = new Map<string, string>()
    for (const ch of [...legendOrder]) {
      const key = domainKey(ch)
      if (key === undefined) continue
      const into = byDomain.get(key)
      if (into === undefined) byDomain.set(key, ch)
      else if (legendsByChannel.get(into)!.orient === legendsByChannel.get(ch)!.orient) {
        mergeLegend(legendsByChannel.get(into)!, legendsByChannel.get(ch)!)
        legendsByChannel.delete(ch)
        legendOrder.splice(legendOrder.indexOf(ch), 1)
      }
    }
  }
  const mergedShared = mergeLayerScales([...scaleLists.values()].flat().map((s) => [s]))
  const selection = mergeSelParts(selectionParts)
  return {
    ...(selection ? { selection } : {}),
    data,
    projections,
    ...(projectionComp ? { projectionComp } : {}),
    signals,
    marks,
    scales: [...mergedShared, ...independentScales],
    legends: legendOrder.map((c) => legendsByChannel.get(c)!),
    ...(planW === 'root' ? { rootWidth: sameW } : {}),
    ...(planH === 'root' ? { rootHeight: sameH } : {}),
  }
}

/** `m` and every mark below it, named with the child's model prefix (vega-lite `model.getName`). */
function prefixMarkNames(m: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...m }
  if (isSelectionMark(m)) return out
  // (the facet header titles are named `row-title` / `column-title` / `facet-title` whatever the model)
  if (typeof m.name === 'string' && m.name !== 'row-title' && m.name !== 'column-title' && m.name !== 'facet-title') out.name = `${prefix}${m.name}`
  if (Array.isArray(m.marks)) out.marks = (m.marks as Record<string, unknown>[]).map((c) => prefixMarkNames(c, prefix))
  return out
}


function cellPrefixed(name: string, prefix: string): boolean {
  return name.startsWith(prefix)
}

const LEGEND_SCALE_KEYS = ['fill', 'stroke', 'shape', 'size', 'opacity', 'strokeWidth', 'strokeDash', 'fillOpacity', 'strokeOpacity', 'angle']

/** A legend is identified by the SCALE it describes (a fill and a stroke legend of one scale are one legend). */
function legendChannel(lg: Record<string, unknown>): string {
  for (const k of LEGEND_SCALE_KEYS) if (typeof lg[k] === 'string') return lg[k] as string
  return JSON.stringify(lg)
}

/**
 * Merge a second legend of the same scale into the first (vega-lite merges the
 * legends of layers/children that share a scale): channel properties union
 * (a legend describing both fill and stroke), titles join, the first legend's
 * other properties win; a symbol default of `fill: transparent` yields to a fill.
 */
/** Legends a layer keeps to itself (resolve.legend: independent): a composition does not hoist them. */
const GROUP_LEGENDS = new WeakSet<object>()

/** Legends whose title was written by the user (`legend.title`, or the field def's `title` it shows): vega-lite's explicit title. */
const EXPLICIT_LEGEND_TITLE = new WeakSet<object>()

/**
 * compile/legend/parse.ts mergeLegendComponent: the legends of one scale merge. The title follows split.ts
 * mergeValuesWithExplicit and common.ts mergeTitle: an explicit title beats an implicit one, equal titles stay,
 * anything else (both explicit or both implicit) is joined with ", ".
 */
function mergeLegend(into: Record<string, unknown>, other: Record<string, unknown>): void {
  for (const k of LEGEND_SCALE_KEYS) if (into[k] === undefined && other[k] !== undefined) into[k] = other[k]
  const intoExplicit = EXPLICIT_LEGEND_TITLE.has(into)
  const otherExplicit = EXPLICIT_LEGEND_TITLE.has(other)
  if (into.title === undefined || into.title === null) {
    if (other.title !== undefined) into.title = other.title
  } else if (intoExplicit && !otherExplicit) {
    // the explicit title stays
  } else if (otherExplicit && !intoExplicit) {
    if (other.title !== undefined) into.title = other.title
  } else if (typeof into.title === 'string' && typeof other.title === 'string') {
    if (into.title !== other.title && other.title) into.title = `${into.title}, ${other.title}`
  }
  if (otherExplicit) EXPLICIT_LEGEND_TITLE.add(into)
  // every other property: the first definition stays, one that is missing is taken from the other legend (defaultTieBreaker);
  // legend/parse.ts mergeSymbolType: a circle beats a stroke symbol
  if (other.symbolType === 'circle' && into.symbolType !== undefined) into.symbolType = 'circle'
  for (const [k, v] of Object.entries(other)) if (k !== 'title' && into[k] === undefined && v !== undefined) into[k] = v
  const upd = (into.encode as { symbols?: { update?: Record<string, unknown> } } | undefined)?.symbols?.update
  if (upd && into.fill !== undefined) {
    delete upd.fill
    if (Object.keys(upd).length === 0) {
      delete (into.encode as { symbols?: unknown }).symbols
      if (Object.keys(into.encode as object).length === 0) delete into.encode
    }
  }
}

/** Vega layout for a composite: spacing, bounds, align, center (vega-lite defaults per operator). */
function compositeLayout(spec: VLSpec, base: { align: unknown; columns?: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  out.padding = spec.spacing ?? 20
  if (base.columns !== undefined) out.columns = base.columns
  out.bounds = spec.bounds ?? 'full'
  out.align = spec.align ?? base.align
  if (spec.center !== undefined) out.center = spec.center
  return out
}

/** Concat/hconcat/vconcat: one group per child. */
function compileConcat(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const kind = spec.hconcat != null ? 'hconcat' : spec.vconcat != null ? 'vconcat' : 'concat'
  const children = (spec[kind] as VLSpec[]) ?? []
  const cells: CompositeCell[] = children.map((c, i) => ({ prefix: `concat_${i}_`, spec: c }))
  const columns = kind === 'concat' ? spec.columns : undefined
  const layout: 'row' | 'column' | 'grid' = kind === 'hconcat' || (kind === 'concat' && columns === undefined)
    ? 'row'
    : kind === 'vconcat' || columns === 1 ? 'column' : 'grid'
  const res = embedCells(cells, spec, ctx, layout)
  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = VEGA_SCHEMA
  out.autosize = autosizeOf(spec)
  if (res.rootWidth !== undefined) out.width = res.rootWidth
  if (res.rootHeight !== undefined) out.height = res.rootHeight
  out.data = res.data
  if (res.projections.length) out.projections = res.projections
  if (res.projectionComp) FRAG_PROJECTION.set(out, res.projectionComp)
  if (res.signals.length) out.signals = res.signals
  if (res.selection) SEL_PARTS.set(out, res.selection)
  out.layout = compositeLayout(spec, {
    align: 'each',
    columns: kind === 'vconcat' ? 1 : columns,
  })
  out.marks = res.marks
  out.scales = res.scales
  if (res.legends.length) out.legends = res.legends
  rootChrome(out, spec)
  return out
}

/** Substitute `{repeat: name}` references in a spec tree with the repeat values. */
function substituteRepeat(node: unknown, repMap: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => substituteRepeat(n, repMap))
  if (!isObject(node)) return node
  const keys = Object.keys(node)
  if (keys.length === 1 && keys[0] === 'repeat' && typeof node.repeat === 'string') {
    if (!(node.repeat in repMap)) throw new VLCompileError(`{"repeat": ${JSON.stringify(node.repeat)}} has no matching repeat variable`)
    return repMap[node.repeat]
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) out[k] = substituteRepeat(v, repMap)
  return out
}

/**
 * Repeat: `repeat: [..]` lays one child per value out in a row (`columns` wraps
 * it into a grid), `{row, column}` makes a grid, and `{layer: [..]}` overlays
 * the repeated spec as layers of ONE view.
 */
function compileRepeat(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const rep = spec.repeat as unknown
  const child = (spec.spec ?? {}) as VLSpec

  // layer repeat: the repeated spec becomes the layers of a single layered view
  if (isObject(rep) && Array.isArray(rep.layer)) {
    // the repeated spec's own size is the layer's size (vega-lite hoists it)
    const layers = (rep.layer as unknown[]).map((v) => {
      const c = substituteRepeat(child, { layer: v }) as VLSpec
      delete c.width
      delete c.height
      return c
    })
    const layered: VLSpec = { ...spec, layer: layers }
    delete layered.repeat
    delete layered.spec
    if (child.width !== undefined) layered.width = child.width
    if (child.height !== undefined) layered.height = child.height
    const res = compileLayered(layered, ctx)
    // vega-lite names each repeated layer after its repeat value: `child__layer_y_marks`
    const renames = (rep.layer as unknown[]).map((v, i) => [`layer_${i}_`, `child__layer_${varName(String(v))}_`] as const)
    const rename = (n: unknown): unknown => {
      if (typeof n === 'string') {
        for (const [from, to] of renames) {
          if (n.startsWith(from)) return to + n.slice(from.length)
          if (n.startsWith('faceted_path_' + from)) return 'faceted_path_' + to + n.slice(('faceted_path_' + from).length)
        }
        return n
      }
      if (Array.isArray(n)) return n.map(rename)
      return n
    }
    const walk = (m: Record<string, unknown>): Record<string, unknown> => {
      const o: Record<string, unknown> = { ...m }
      if (typeof m.name === 'string') o.name = rename(m.name)
      if (isObject(m.from)) {
        const f: Record<string, unknown> = { ...m.from }
        if (typeof f.data === 'string') f.data = rename(f.data)
        if (isObject(f.facet)) f.facet = { ...f.facet, ...(typeof f.facet.name === 'string' ? { name: rename(f.facet.name) } : {}) }
        o.from = f
      }
      if (Array.isArray(m.marks)) o.marks = (m.marks as Record<string, unknown>[]).map(walk)
      return o
    }
    if (Array.isArray(res.marks)) res.marks = (res.marks as Record<string, unknown>[]).map(walk)
    // maps: the names the layer's projection, geojson signals and geopoint outputs carry follow the same renaming
    if (Array.isArray(res.projections) && res.projections.length) {
      const names = new Map<string, string>()
      const note = (n: unknown): void => {
        if (typeof n === 'string' && typeof rename(n) === 'string' && rename(n) !== n) names.set(n, rename(n) as string)
      }
      for (const pj of res.projections as Record<string, unknown>[]) note(pj.name)
      for (const d of (res.data as Record<string, unknown>[]) ?? []) {
        for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) {
          if (t.type === 'geojson') note(t.signal)
          if (t.type === 'geopoint') for (const a of (t.as as unknown[]) ?? []) note(a)
        }
      }
      const rn = { signals: names, scales: new Map<string, string>() }
      renameFragment(res.projections, rn)
      const retarget = (t: Record<string, unknown>): void => {
        if (t.type === 'geojson' && typeof t.signal === 'string') t.signal = names.get(t.signal) ?? t.signal
        if (t.type === 'geopoint') {
          if (typeof t.projection === 'string') t.projection = names.get(t.projection) ?? t.projection
          if (Array.isArray(t.as)) t.as = t.as.map((a) => (typeof a === 'string' ? names.get(a) ?? a : a))
        }
        if (t.type === 'geoshape' && typeof t.projection === 'string') t.projection = names.get(t.projection) ?? t.projection
      }
      for (const d of (res.data as Record<string, unknown>[]) ?? []) for (const t of (d.transform as Record<string, unknown>[] | undefined) ?? []) retarget(t)
      for (const pj of res.projections as Record<string, unknown>[]) if (typeof pj.name === 'string') pj.name = names.get(pj.name) ?? pj.name
      const visitMarks = (ms: unknown): void => {
        for (const m of (ms as Record<string, unknown>[] | undefined) ?? []) {
          for (const t of (m.transform as Record<string, unknown>[] | undefined) ?? []) retarget(t)
          const upd = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
          for (const ch of ['x', 'y', 'x2', 'y2']) {
            const v = upd?.[ch]
            if (isObject(v) && typeof v.field === 'string' && names.has(v.field)) v.field = names.get(v.field)
          }
          visitMarks(m.marks)
        }
      }
      visitMarks(res.marks)
    }
    return res
  }

  const isGrid = isObject(rep)
  const rowFields = (isGrid ? ((rep as Record<string, unknown>).row as unknown[] | undefined) ?? [] : []) as unknown[]
  const colFields = (isGrid ? ((rep as Record<string, unknown>).column as unknown[] | undefined) ?? [] : (rep as unknown[])) as unknown[]
  const cells: CompositeCell[] = []
  if (isGrid) {
    const rows = rowFields.length ? rowFields : [undefined]
    const cols = colFields.length ? colFields : [undefined]
    for (const r of rows) {
      for (const c of cols) {
        const repMap: Record<string, unknown> = {}
        if (r !== undefined) repMap.row = r
        if (c !== undefined) repMap.column = c
        const key = `${r !== undefined ? `row_${String(r)}` : ''}${c !== undefined ? `column_${String(c)}` : ''}`
        cells.push({ prefix: `child__${varName(key)}_`, spec: substituteRepeat(child, repMap) as VLSpec })
      }
    }
  } else {
    for (const v of colFields) cells.push({ prefix: `child__${varName(String(v))}_`, spec: substituteRepeat(child, { repeat: v }) as VLSpec })
  }
  // vega-lite normalizes a repeat to a concat with `columns` (the column count, or 1 for rows alone): a grid, so the children
  // share both sizes (`childWidth`, `childHeight`) whatever their number
  const columns = isGrid ? (rowFields.length > 0 && colFields.length === 0 ? 1 : colFields.length) : spec.columns
  // (a column of rows alone keeps its own plan: vega-lite sizes those children by its row layout)
  // (layoutsize/parse.ts: with one column the children's width is the composition's own)
  const layout: 'row' | 'column' | 'grid' = (isGrid && rowFields.length > 0 && colFields.length === 0) || columns === 1 ? 'column' : columns !== undefined ? 'grid' : 'row'
  const res = embedCells(cells, spec, ctx, layout)
  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = VEGA_SCHEMA
  out.autosize = autosizeOf(spec)
  if (res.rootWidth !== undefined) out.width = res.rootWidth
  if (res.rootHeight !== undefined) out.height = res.rootHeight
  out.data = res.data
  if (res.projections.length) out.projections = res.projections
  if (res.projectionComp) FRAG_PROJECTION.set(out, res.projectionComp)
  if (res.signals.length) out.signals = res.signals
  if (res.selection) SEL_PARTS.set(out, res.selection)
  out.layout = compositeLayout(spec, { align: 'all', columns })
  out.marks = res.marks
  out.scales = res.scales
  if (res.legends.length) out.legends = res.legends
  rootChrome(out, spec)
  return out
}

// --- channel parsing ---------------------------------------------------------

const TYPE_ALIASES: Record<string, string> = {
  quantitative: 'quantitative', ordinal: 'ordinal', nominal: 'nominal', temporal: 'temporal', geojson: 'geojson',
  q: 'quantitative', o: 'ordinal', n: 'nominal', t: 'temporal',
}

/** vega-lite `autoMaxBins` (bin.ts): facets and the non-positional channels with a handful of values get 6 bins (4 for the dashes). */
function autoMaxBins(channel: string): number {
  switch (channel) {
    case 'row': case 'column': case 'size': case 'color': case 'fill': case 'stroke': case 'strokeWidth': case 'opacity': case 'fillOpacity': case 'strokeOpacity': case 'shape': return 6
    case 'strokeDash': return 4
    default: return 10
  }
}

function parseChannel(channel: string, def: unknown): FieldDef | null {
  if (def == null) return null
  if (Array.isArray(def)) throw new VLCompileError(`channel arrays not supported: ${channel}`)
  const raw = def as ChannelDef
  const common = {
    axis: raw.axis === null ? null : isObject(raw.axis) ? (raw.axis as Record<string, unknown>) : undefined,
    scale: isObject(raw.scale) ? (raw.scale as Record<string, unknown>) : undefined,
    legend: raw.legend === null ? null : isObject(raw.legend) ? (raw.legend as Record<string, unknown>) : undefined,
    title: raw.title,
    raw,
  }
  if (raw.field === undefined && raw.datum === undefined && raw.aggregate !== 'count' && raw.condition !== undefined) {
    // a channel whose only field is conditional (color: {condition: {test, field}, value}):
    // the conditional field drives the channel's scale and legend
    const conds = (Array.isArray(raw.condition) ? raw.condition : [raw.condition]) as ChannelDef[]
    const withField = conds.filter((c) => c.field !== undefined || (c.aggregate === 'count' && c.value === undefined && c.datum === undefined))
    if (withField.length > 1) throw new VLCompileError(`encoding.${channel}.condition: only one conditional field per channel is supported`)
    if (withField.length === 1) {
      const { test: _t, ...rest } = withField[0] as ChannelDef & { test?: unknown }
      void _t
      const promoted = parseChannel(channel, rest)
      if (promoted) return { ...promoted, fromCondition: true, raw }
    }
    return null
  }
  if (raw.field === undefined && raw.datum !== undefined) {
    const d = raw.datum
    // (channeldef.ts initDatumDef: the type of a datum without one follows its value)
    return {
      channel,
      field: datumSentinel(channel),
      source: '',
      type: typeof raw.type === 'string' ? normalizeType(raw.type, raw, channel) : typeof d === 'number' ? 'quantitative' : isDateTimeValue(d) ? 'temporal' : 'nominal',
      datum: d,
      datumOnly: true,
      stack: false,
      ...common,
    }
  }
  if (raw.field === undefined) {
    if (raw.aggregate === 'count') {
      // count has no field: synthesise one for the pipeline
      return {
        channel,
        field: '__count',
        source: '__count',
        type: normalizeType(raw.type, raw, channel),
        aggregate: 'count',
        stack: raw.stack,
        bandPosition: raw.bandPosition as number | undefined,
        ...common,
      }
    }
    return null
  }
  if (typeof raw.field !== 'string') throw new VLCompileError(`encoding.${channel}.field must be a string, got ${JSON.stringify(raw.field)}`)
  const ff = flatField(raw.field)
  const type0 = normalizeType(raw.type, raw, channel)
  const tu = raw.timeUnit !== undefined ? normalizeTimeUnit(raw.timeUnit, `encoding.${channel}.timeUnit`) : undefined
  // argmax/argmin: {aggregate: {argmax: 'b'}} aggregates the whole row; the channel field is
  // read from the winning row (vega-lite: field `argmax_b["a"]`)
  let aggregate: string | undefined
  let argAgg: FieldDef['argAgg']
  if (isObject(raw.aggregate)) {
    const op = 'argmax' in raw.aggregate ? 'argmax' : 'argmin'
    const argSource = String((raw.aggregate as Record<string, unknown>)[op])
    aggregate = op
    argAgg = { op, arg: flatField(argSource).key, argSource, valuePath: raw.field }
  } else aggregate = raw.aggregate as string | undefined
  // count/distinct/valid/missing always emit a number regardless of the
  // source field type (vega-lite warns and uses quantitative) — this drives
  // the scale type and the toNumber cast.
  const type = aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(String(aggregate)) ? 'quantitative' : type0
  const bin = raw.bin === false ? undefined : raw.bin
  return {
    channel,
    field: ff.key,
    source: raw.field,
    ...(ff.expr !== undefined ? { flatExpr: ff.expr } : {}),
    type,
    aggregate,
    ...(argAgg ? { argAgg } : {}),
    bin,
    ...(bin ? { binParams: normalizeBin(bin, autoMaxBins(channel)) } : {}),
    ...(tu ? { timeUnit: tu.unit, tu } : {}),
    sort: normalizeSort(raw.sort),
    stack: raw.stack,
    bandPosition: raw.bandPosition as number | undefined,
    ...common,
  }
}

const SORT_BY_CHANNEL = new Set(['x', 'y', 'color', 'fill', 'stroke', 'strokeWidth', 'size', 'shape', 'fillOpacity', 'strokeOpacity', 'opacity', 'text'])

/** vega-lite normalizeFieldDef: "-y" / "x" channel strings become {encoding, order}. */
function normalizeSort(sort: unknown): unknown {
  if (typeof sort === 'string') {
    if (SORT_BY_CHANNEL.has(sort)) return { encoding: sort }
    if (sort.startsWith('-') && SORT_BY_CHANNEL.has(sort.slice(1))) return { encoding: sort.slice(1), order: 'descending' }
  }
  return sort
}

/** Placeholder field name carried by a datum-only def until the mark encode swaps it for the constant. */
const DATUM_PREFIX = '\u0000datum:'
function datumSentinel(channel: string): string {
  return `${DATUM_PREFIX}${channel}`
}

/**
 * valueref.ts valueRefForFieldOrDatumDef: the reference a datum is. A DateTime is the expression that builds the date, a signal or an
 * expression stays one, anything else is the value.
 */
function datumValueRef(datum: unknown): Record<string, unknown> {
  if (isDateTimeValue(datum)) return { signal: dateTimeToExpr(datum as Record<string, unknown>) }
  if (isObject(datum) && typeof datum.signal === 'string') return { signal: datum.signal }
  if (isObject(datum) && typeof datum.expr === 'string') return { signal: datum.expr }
  return { value: datum }
}

/** scale/domain.ts convertDomainIfItIsDateTime for a datum: the domain a datum alone gives its scale. */
function datumDomain(def: FieldDef): unknown {
  // (mapDomainToDataSignal: a time is a signal that gives the domain as a one-row data set)
  if (def.type === 'temporal' || def.timeUnit) return { signal: `{data: ${domainValueExpr(def.datum, def.type, def.timeUnit)}}` }
  return [def.datum]
}

/** Replace every `{scale, field: <datum sentinel>}` in an encode entry with `{scale, value: datum}` (in place). */
function patchDatumRefs(node: unknown, datums: Map<string, unknown>): void {
  if (Array.isArray(node)) { for (const x of node) patchDatumRefs(x, datums); return }
  if (!isObject(node)) return
  if (typeof node.field === 'string' && node.field.startsWith(DATUM_PREFIX)) {
    const ch = node.field.slice(DATUM_PREFIX.length)
    delete node.field
    Object.assign(node, datumValueRef(datums.get(ch)))
    return
  }
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object') patchDatumRefs(v, datums)
}

/**
 * Constant (`datum`/`value`) position channels are implemented for the marks
 * whose position is a plain point (or a rule's end); a datum on a non-position
 * channel is supported for colour only. Everything else throws, never degrades.
 */
function checkConstChannels(mark: string, encoding: Record<string, unknown>, filled?: boolean): void {
  // channels that need their own scale + legend are implemented for colour (fill/stroke alias it);
  // the rest are limited to constants and conditions
  for (const ch of ['fillOpacity', 'strokeOpacity']) {
    const d = encoding[ch]
    if (isObject(d) && (d.field !== undefined || d.datum !== undefined)) {
      throw new VLCompileError(`encoding.${ch}: a data-driven ${ch} (scale + legend) is not supported; use a constant {"value": ...} or a condition`)
    }
  }
  for (const ch of ['fill', 'stroke']) {
    const d = encoding[ch]
    if (!isObject(d) || (d.field === undefined && d.datum === undefined)) continue
    if (encoding.color !== undefined) throw new VLCompileError(`encoding.${ch} together with encoding.color is not supported`)
    // (a `scale: null` field is read as it is - no colour machinery is involved, so the mark's filledness does not matter)
    if (filled !== undefined && (ch === 'fill') !== filled && d.scale !== null) {
      throw new VLCompileError(`encoding.${ch} on a ${filled ? 'filled' : 'stroked'} "${mark}" mark is not supported; use encoding.color or set mark.filled`)
    }
  }
  for (const [ch, def] of Object.entries(encoding)) {
    if (!isObject(def) || def.field !== undefined) continue
    const isDatum = def.datum !== undefined
    const isValue = def.value !== undefined && def.condition === undefined
    if (isDatum && !['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'color', 'fill', 'stroke', ...GEO_POSITION_CHANNELS].includes(ch)) {
      throw new VLCompileError(`encoding.${ch}.datum is not supported (datum works on x, y, x2, y2, longitude, latitude, color, fill and stroke)`)
    }

  }
}

/** Parse every channel of an encoding into field defs (datum-only defs included, flagged). */
/** Channels whose scale can have a legend (position channels have axes instead). */
const LEGEND_CHANNELS = new Set(['color', 'size', 'shape', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'angle'])

/** vega-lite defaultTitleFormatter: config.fieldTitle ('verbal' | 'plain' | 'functional') and config.countTitle. */
function titleFromConfig(f: FieldDef, config: unknown): { autoTitle?: string } {
  const c = isObject(config) ? config : {}
  if (f.datumOnly || f.title !== undefined) return {}
  if (c.fieldTitle === 'plain') return { autoTitle: f.source }
  if (c.fieldTitle === 'functional') {
    if (f.argAgg) return { autoTitle: `${f.source} for ${f.argAgg.op}(${f.argAgg.argSource})` }
    const fn = f.aggregate ?? f.tu?.unit ?? (f.bin ? 'bin' : undefined)
    return { autoTitle: fn ? `${fn.toUpperCase()}(${f.source})` : f.source }
  }
  return f.aggregate === 'count' && typeof c.countTitle === 'string' ? { autoTitle: c.countTitle } : {}
}

/**
 * vega-lite initFieldOrDatumDef: a custom `formatType` (any but "number" / "time") is honoured only when
 * `config.customFormatTypes` is true. Otherwise it is dropped WITH its `format` (warning "custom format type and
 * format for channel ... are dropped"): from the field def itself when it carries a format / formatType (text,
 * tooltip, href, description...), else from its axis or legend. A header's is kept.
 */
function dropUnallowedCustomFormat(def0: unknown, config: unknown): unknown {
  if (!isObject(def0)) return def0
  const cfg = isObject(config) ? (config as Record<string, unknown>) : undefined
  if (cfg?.customFormatTypes === true) return def0
  let def: Record<string, unknown> = def0
  if (Array.isArray(def.condition)) def = { ...def, condition: def.condition.map((c) => dropUnallowedCustomFormat(c, config)) }
  else if (isObject(def.condition)) def = { ...def, condition: dropUnallowedCustomFormat(def.condition, config) }
  if ('format' in def || 'formatType' in def) {
    if (!isCustomFormatType(def.formatType)) return def
    const rest: Record<string, unknown> = { ...def }
    delete rest.format
    delete rest.formatType
    return dropUnallowedCustomFormat(rest, config)
  }
  for (const guide of ['axis', 'legend'] as const) {
    const g = def[guide]
    if (!(guide in def) || !isObject(g)) continue
    if (!isCustomFormatType(g.formatType)) return def
    const rest: Record<string, unknown> = { ...g }
    delete rest.format
    delete rest.formatType
    return dropUnallowedCustomFormat({ ...def, [guide]: rest }, config)
  }
  return def
}

const ALL_MARK_TYPES = ['arc', 'area', 'bar', 'circle', 'geoshape', 'image', 'line', 'rule', 'point', 'rect', 'square', 'trail', 'text', 'tick']
/** channel.ts getSupportedMark: the marks that draw a channel (`always`), or draw it only for pre-binned data (`binned`). */
function supportedMarks(channel: string): Record<string, 'always' | 'binned'> | undefined {
  const always = (marks: string[]): Record<string, 'always'> => Object.fromEntries(marks.map((m) => [m, 'always' as const]))
  switch (channel) {
    case 'color': case 'fill': case 'stroke': case 'description': case 'detail': case 'key': case 'tooltip': case 'href': case 'order':
    case 'opacity': case 'fillOpacity': case 'strokeOpacity': case 'strokeWidth': case 'facet': case 'row': case 'column':
      return always(ALL_MARK_TYPES)
    case 'x': case 'y': case 'xOffset': case 'yOffset': case 'latitude': case 'longitude': case 'time':
      return always(ALL_MARK_TYPES.filter((m) => m !== 'geoshape'))
    case 'x2': case 'y2': case 'latitude2': case 'longitude2':
      return { ...always(['area', 'bar', 'image', 'rect', 'rule']), circle: 'binned', point: 'binned', square: 'binned', tick: 'binned', line: 'binned', trail: 'binned' }
    case 'size': return always(['point', 'tick', 'rule', 'circle', 'square', 'bar', 'text', 'line', 'trail'])
    case 'strokeDash': return always(['line', 'point', 'tick', 'rule', 'circle', 'square', 'bar', 'geoshape'])
    case 'shape': return always(['point', 'geoshape'])
    case 'text': return always(['text'])
    case 'angle': return always(['point', 'square', 'text'])
    case 'url': return always(['image'])
    case 'theta': case 'radius': return always(['text', 'arc'])
    case 'theta2': case 'radius2': return always(['arc'])
    default: return undefined
  }
}

/** encoding.ts markChannelCompatible. (An image mark is compiled as a rect carrying `$image`; the channel table is the image's.) */
function markChannelCompatible(encoding: Record<string, unknown>, channel: string, mark: string, image: boolean): boolean {
  const table = supportedMarks(channel)
  if (!table) return true // (an unknown channel is validate.ts's to reject)
  const supported = table[image ? 'image' : mark]
  if (!supported) return false
  if (supported === 'binned') {
    // circle, point, square and tick only take x2 / y2 when x / y is pre-binned data and they say where the bin ends
    const primary = encoding[channel === 'x2' ? 'x' : 'y']
    const bin = isObject(primary) ? primary.bin : undefined
    return isObject(primary) && typeof primary.field === 'string' && isObject(encoding[channel]) && typeof (encoding[channel] as Record<string, unknown>).field === 'string' && (bin === 'binned' || (isObject(bin) && bin.binned === true))
  }
  return true
}

function parseEncodingFields(encoding: Record<string, unknown>, config?: unknown, markDef?: unknown): FieldDef[] {
  const fields: FieldDef[] = []
  // vega-lite parseLegend: `disable = legend !== undefined ? !legend : config.legend.disable`
  const legendCfg = isObject(config) && isObject(config.legend) ? (config.legend as Record<string, unknown>) : undefined
  const disableLegends = legendCfg?.disable === true
  for (const [channel, def] of Object.entries(encoding)) {
    // vega-lite drops the size of an image mark (it is incompatible)
    if (channel === 'size' && isObject(markDef) && markDef.$image) continue
    // encoding.ts markChannelCompatible (channel.ts supportMark): a channel a mark does not draw is dropped, with a warning
    {
      const markType = typeof markDef === 'string' ? markDef : isObject(markDef) ? markDef.type : undefined
      if (typeof markType === 'string' && !markChannelCompatible(encoding, channel, markType, isObject(markDef) && markDef.$image === true)) continue
    }
    // detail / order / tooltip accept a list of definitions
    for (const d0 of Array.isArray(def) ? def : [def]) {
      const d = dropUnallowedCustomFormat(d0, config)
      const f = parseChannel(channel === 'fill' || channel === 'stroke' ? 'color' : channel, d)
      if (!f) continue
      const g = { ...(disableLegends && f.legend === undefined && !f.datumOnly && LEGEND_CHANNELS.has(f.channel) ? { ...f, legend: null } : f), ...titleFromConfig(f, config) }
      const h = (isObject(d) && d.scale === null && g.field ? { ...g, noScale: true } : g) as FieldDef
      fields.push(channel === 'fill' || channel === 'stroke' ? { ...h, paint: channel } : h)
    }
  }
  for (const f of fields) {
    if ((f.channel === 'x' || f.channel === 'y') && fields.some((o) => o.channel === `${f.channel}Offset` && o.field)) f.nestedOffset = true
    // pre-binned data: the bins' ends are the secondary channel's field
    if (isPrebinned(f)) {
      const d2 = encoding[`${f.channel}2`]
      if (isObject(d2) && typeof d2.field === 'string') f.binParams = { ...f.binParams!, end: flatField(d2.field).key }
    }
  }
  return fields
}

/**
 * vega-lite `getSort`: the mark's item order. The `order` channel sorts by its
 * fields (when the view is not stacked: there it orders the stack instead);
 * line/area/trail sort by their dimension channel's position.
 */
function markSort(spec: VLSpec, fields: FieldDef[], mark: string, orient: string): Record<string, unknown> | undefined {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  const orderRaw = enc.order
  if (isObject(orderRaw) && orderRaw.value !== undefined && (orderRaw.value === null || orderRaw.value === false)) return undefined
  if (orderRaw === undefined && (md.order === false || md.order === null)) return undefined
  const orderDefs = fields.filter((f) => f.channel === 'order' && f.field && !f.datumOnly)
  const stacked = fields.some((f) => isStacked(f, mark, orient, fields))
  if (orderDefs.length && !stacked) {
    return { field: orderDefs.map((f) => dref(aggFieldName(f))), order: orderDefs.map((f) => (f.sort === 'descending' ? 'descending' : 'ascending')) }
  }
  if (mark === 'line' || mark === 'area' || mark === 'trail') {
    const dim = orient === 'horizontal' ? 'y' : 'x'
    if (fields.some((f) => f.channel === dim && !f.datumOnly)) return { field: dim }
  }
  return undefined
}

/**
 * vega-lite `pathGroupingFields`: the fields that split a line/area/trail into one path each,
 * in encoding order (position, text/shape/angle/tooltip/href never group).
 */
function pathGroupingKeys(spec: VLSpec, fields: FieldDef[], mark: string): string[] {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const out: string[] = []
  const add = (n: string): void => {
    if (!out.includes(n)) out.push(n)
  }
  for (const ch of Object.keys(enc)) {
    const defs = fields.filter((f) => f.channel === ch && !f.datumOnly && f.field)
    switch (ch) {
      case 'xOffset': case 'yOffset': {
        const offsetDef = defs[0]
        const mainDef = fields.find((f) => f.channel === (ch === 'xOffset' ? 'x' : 'y') && !f.datumOnly)
        if (offsetDef && mainDef && !mainDef.aggregate && !offsetDef.aggregate && aggFieldName(mainDef) !== aggFieldName(offsetDef)) add(aggFieldName(mainDef))
        break
      }
      case 'order':
        if (mark === 'line' || mark === 'trail') break
        for (const d of defs) if (!d.aggregate) add(aggFieldName(d))
        break
      case 'detail': case 'key':
        for (const d of defs) if (!d.aggregate) add(aggFieldName(d))
        break
      case 'size':
        if (mark === 'trail') break
      // falls through
      case 'color': case 'fill': case 'stroke': case 'opacity': case 'fillOpacity': case 'strokeOpacity': case 'strokeDash': case 'strokeWidth': {
        const d = defs[0]
        if (d && !d.aggregate) add(aggFieldName(d))
        break
      }
      default:
        break
    }
  }
  return out
}

/** vega-lite `defaultType` + `getFullName`: the field's type, inferred when absent. */
function normalizeType(t: unknown, def: ChannelDef, channel: string): string {
  if (typeof t === 'string') {
    const full = TYPE_ALIASES[t.toLowerCase()]
    if (!full) throw new VLCompileError(`encoding.${channel}.type: unknown type ${JSON.stringify(t)}`)
    return full
  }
  switch (channel) {
    case 'row': case 'column': case 'facet': case 'shape': case 'strokeDash':
      return 'nominal'
    case 'longitude': case 'latitude':
      return 'quantitative'
    case 'order':
      return 'ordinal'
  }
  if (Array.isArray(def.sort)) return 'ordinal'
  if (def.timeUnit) return 'temporal'
  if (def.bin || (def.aggregate && !isObject(def.aggregate))) return 'quantitative'
  const st = isObject(def.scale) ? (def.scale.type as string | undefined) : undefined
  if (st) {
    if (['linear', 'log', 'pow', 'sqrt', 'symlog', 'identity', 'sequential', 'quantile', 'quantize', 'threshold', 'bin-ordinal'].includes(st)) return 'quantitative'
    if (st === 'time' || st === 'utc') return 'temporal'
  }
  return 'nominal'
}

const isDiscreteType = (t: string) => t === 'nominal' || t === 'ordinal'
const isContinuousScaleType = (t: string) => t === 'linear' || t === 'log' || t === 'pow' || t === 'sqrt' || t === 'symlog' || t === 'time' || t === 'utc'

// --- config ------------------------------------------------------------------

/**
 * Vega-Lite resolves its config into Vega-level pieces (probed against
 * vl.compile): guide blocks (axis/axisX/axisY/axisBand/axisOrient, legend,
 * header, range) forward verbatim into the Vega config; config.mark forwards
 * as config.mark; per-mark-type blocks become config.style[type]; config.view
 * becomes the 'cell' style; config.title splits onto 'group-title' (color ->
 * fill) and 'group-subtitle' (align/baseline/limit); config.font seeds the
 * guide/title/text styles; config.scale applies straight to the scales; the
 * VL-only keys (invalid, filled, binSpacing, continuousBandSize, bandSize,
 * thickness, point, line, color, the view sizing props) are stripped.
 */
const VL_ONLY_MARK_KEYS = new Set(['invalid', 'filled', 'binSpacing', 'continuousBandSize', 'bandSize', 'thickness', 'point', 'line', 'color'])
const VIEW_DROPPED_KEYS = new Set(['discreteWidth', 'discreteHeight', 'continuousWidth', 'continuousHeight', 'step'])
const MARK_TYPE_BLOCKS = ['bar', 'point', 'line', 'area', 'text', 'tick', 'rect', 'arc', 'rule', 'trail', 'circle', 'square', 'geoshape', 'image']

export function assembleConfig(spec: VLSpec): Record<string, unknown> | undefined {
  const user = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  if (!user) return undefined
  const out: Record<string, unknown> = {}
  const style: Record<string, Record<string, unknown>> = {}
  const strip = (block: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(block).filter(([k]) => !VL_ONLY_MARK_KEYS.has(k)))
  for (const k of ['axis', 'axisX', 'axisY', 'axisBand', 'axisLeft', 'axisRight', 'axisTop', 'axisBottom', 'legend', 'header', 'headerRow', 'headerColumn', 'headerFacet', 'range']) {
    if (isObject(user[k])) out[k] = user[k]
  }
  for (const k of ['aria', 'fieldTitle', 'lineBreak']) if (user[k] !== undefined) out[k] = user[k]
  if (isObject(user.mark)) out.mark = strip(user.mark)
  for (const t of MARK_TYPE_BLOCKS) {
    if (isObject(user[t])) style[t] = strip(user[t])
  }
  if (isObject(user.view)) {
    style.cell = Object.fromEntries(Object.entries(user.view).filter(([k]) => !VIEW_DROPPED_KEYS.has(k)))
  }
  if (isObject(user.title)) {
    const gt: Record<string, unknown> = {}
    const gs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(user.title)) {
      if (k === 'anchor' || k === 'offset' || k === 'orient') continue
      if (k === 'color') gt.fill = v
      else gt[k] = v
      if (k === 'align' || k === 'baseline' || k === 'limit') gs[k] = v
    }
    if (Object.keys(gt).length) style['group-title'] = gt
    if (Object.keys(gs).length) style['group-subtitle'] = gs
  }
  if (typeof user.font === 'string') {
    for (const name of ['guide-label', 'guide-title', 'group-title', 'group-subtitle', 'text']) {
      style[name] = { ...style[name], font: user.font }
    }
  }
  // the user's own named styles (markDef.style) travel in config.style as written
  if (isObject(user.style)) for (const [name, block] of Object.entries(user.style)) if (!MARK_TYPE_BLOCKS.includes(name) && isObject(block)) style[name] = block
  if (Object.keys(style).length) out.style = style
  return Object.keys(out).length ? out : undefined
}

/** Apply config.scale to the compiled positional scales (round on x/y;
 * nice/zero on continuous quantitative ones — the color scale gets none). */
function applyScaleConfig(scales: ScaleSpec[], user: Record<string, unknown> | undefined): void {
  const sc = isObject(user?.scale) ? (user!.scale as Record<string, unknown>) : undefined
  if (!sc) return
  for (const s of scales) {
    // config.scale supplies the default of every scale property that has the same name
    for (const k of ['clamp', 'round']) {
      if (sc[k] !== undefined && s[k] === undefined && scalePropApplies(s.name, String(s.type), k)) s[k] = Boolean(sc[k])
    }
    if (s.name !== 'x' && s.name !== 'y') continue
    if (isContinuousScaleType(String(s.type)) && !isTimeScaleType(String(s.type))) {
      if (sc.nice !== undefined) s.nice = sc.nice
      if (sc.zero !== undefined) s.zero = Boolean(sc.zero)
    }
  }
}

const isTimeScaleType = (t: string) => t === 'time' || t === 'utc'

// --- titles ------------------------------------------------------------------

export function channelTitle(def: FieldDef): unknown {
  // (a datum has no default title; its own, if it has one, is the guide's)
  if (def.datumOnly) return def.title
  if (def.title !== undefined) return def.title
  if (def.autoTitle !== undefined) return def.autoTitle
  if (def.aggregate === 'count') return 'Count of Records'
  if (def.argAgg) return `${def.source} for ${def.argAgg.op === 'argmax' ? 'max' : 'min'} ${def.argAgg.argSource}`
  if (def.bin && !isPrebinned(def)) return `${def.source} (binned)`
  if (def.tu && !def.tu.binned) return `${def.source} (${getTimeUnitParts(def.tu.unit).join('-')})`
  if (def.aggregate) {
    const op = def.aggregate
    const label = op.charAt(0).toUpperCase() + op.slice(1)
    return `${label} of ${def.source}`
  }
  return def.source
}

// --- data pipeline -----------------------------------------------------------

interface DataPipeline {
  sourceName: string
  transforms: Record<string, unknown>[]
  /** type-cast formulas only (shared across layers in layered compilation) */
  casts: Record<string, unknown>[]
  /** everything after the casts (bin/theta/user/aggregate/stack pipelines) */
  pipeline: Record<string, unknown>[]
  /** the name of the final derived dataset */
  dataName: string
  seriesFields: FieldDef[]
  /** `pipeline` entries before this index form the raw (pre-aggregate) table */
  rawLen: number
  /** some scale domain sorts by a field/array and so needs the raw table */
  usesRawDomain: boolean
  /** the scales read the rows before / after the invalid filter, the marks the others */
  invalidSplit?: InvalidScaleSplit
}

interface InvalidScaleSplit {
  kind: 'pre' | 'post'
  filter: Record<string, unknown>
}

/** Object and array sorts read the raw table; ascending/descending/null read the main one. */
function usesRawDomainSort(f: FieldDef): boolean {
  if (Array.isArray(f.sort)) return true
  return isObject(f.sort) && (f.sort.encoding !== undefined || f.sort.field !== undefined || f.sort.op !== undefined)
}

const NONPOSITION_ORDER = ['color', 'fill', 'stroke', 'time', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape', 'order', 'text', 'detail', 'key', 'tooltip', 'href', 'url', 'description']

/**
 * vega-lite `stack()` stackBy: the unaggregated fields of the non-position channels
 * (tooltip excluded) that differ from the stack's dimension/offset fields, in vega-lite's
 * channel order.
 */
function stackByFields(fields: FieldDef[], dimensionChannel: 'x' | 'y'): FieldDef[] {
  const offsetChannel = dimensionChannel === 'x' ? 'xOffset' : 'yOffset'
  const groupFields = new Set(fields.filter((f) => f.channel === dimensionChannel || f.channel === offsetChannel).map((f) => f.field))
  const out: FieldDef[] = []
  for (const ch of NONPOSITION_ORDER) {
    if (ch === 'tooltip') continue
    for (const f of fields) {
      if (f.channel !== ch || f.datumOnly || !f.field || f.aggregate || groupFields.has(f.field)) continue
      out.push(f)
    }
  }
  return out
}

/** vega-lite's stack sort: the `order` channel when present, else the stack-by fields (descending for y, ascending otherwise). */
function stackSortParams(fields: FieldDef[], stackBy: FieldDef[], measureChannel: string, enc: Record<string, unknown> = {}): { field: string[]; order: string[] } {
  const orderDefs = fields.filter((f) => f.channel === 'order' && f.field && !f.datumOnly)
  if (orderDefs.length) {
    return { field: orderDefs.map((f) => aggFieldName(f)), order: orderDefs.map((f) => (f.sort === 'descending' ? 'descending' : 'ascending')) }
  }
  // (stack.ts isOrderOnlyDef: an `order` def with only a `sort` gives the direction of the default stack order)
  const orderOnly = isObject(enc.order) && enc.order.field === undefined && (enc.order.sort === 'ascending' || enc.order.sort === 'descending') ? enc.order.sort : undefined
  const dflt = orderOnly ?? (measureChannel === 'y' ? 'descending' : 'ascending')
  const seen = new Set<string>()
  const names = stackBy.map((f) => aggFieldName(f)).filter((n) => (seen.has(n) ? false : (seen.add(n), true)))
  return { field: names, order: names.map(() => dflt) }
}

/** The index column holding a sort array's position (vega-lite: `<channel>_<field>_sort_index`). */
function sortIndexName(f: FieldDef): string {
  return genName(f.channel, `${aggFieldName(f)}_sort_index`)
}

/**
 * Split a unit's pipeline into raw + main datasets when a scale domain needs
 * the raw table (sort by field/array) and stages follow it; otherwise one dataset.
 */
function pipelineDatasets(p: DataPipeline, sourceName: string, srcOfCasts: string, ctx: CompileCtx, startIndex: number): { datasets: Record<string, unknown>[]; dataName: string; rawName: string; next: number } {
  const all = [...p.casts, ...p.pipeline]
  if (!all.length) return { datasets: [], dataName: srcOfCasts, rawName: srcOfCasts, next: startIndex }
  const rawTransforms = [...p.casts, ...p.pipeline.slice(0, p.rawLen)]
  if (p.usesRawDomain && p.pipeline.length > p.rawLen && rawTransforms.length === 0) {
    // the raw table IS the source: no separate raw dataset
    const name = ctx.dn(startIndex)
    return { datasets: [{ name, source: sourceName, transform: p.pipeline }], dataName: name, rawName: srcOfCasts, next: startIndex + 1 }
  }
  if (p.usesRawDomain && p.pipeline.length > p.rawLen) {
    const rawName = ctx.dn(startIndex)
    const mainName = ctx.dn(startIndex + 1)
    return {
      datasets: [
        { name: rawName, source: sourceName, transform: [...p.casts, ...p.pipeline.slice(0, p.rawLen)] },
        { name: mainName, source: rawName, transform: p.pipeline.slice(p.rawLen) },
      ],
      dataName: mainName,
      rawName,
      next: startIndex + 2,
    }
  }
  const name = ctx.dn(startIndex)
  return { datasets: [{ name, source: sourceName, transform: all }], dataName: name, rawName: name, next: startIndex + 1 }
}

/**
 * Per-compile state shared by every view of one spec: lookup source datasets
 * (named by content, so identical sources dedupe) and the spec's named
 * `datasets`.
 */
interface CompileCtx extends TransformContext {
  /** Extra top-level datasets generated while translating (lookup sources). */
  lookups: Map<string, Record<string, unknown>>
  /** `datasets` of the top-level spec (name -> rows). */
  datasets: Record<string, unknown>
  /** Generated derived-dataset name `<prefix>_<i>`; never collides with a user dataset name. */
  dn(i: number): string
  /**
   * The name of the next unnamed source dataset (`source_<n>`). Vega-lite numbers its sources in the order the views are parsed, a
   * parent's before its children's, across the whole spec - so a source never takes a name an earlier one has.
   */
  takeSource(): string
  /** A generated one-off dataset name (`row_domain`, ...), de-collided from user names. */
  fresh(base: string): string
  /** The selection components of the spec, by (sanitized) parameter name. */
  selections: Map<string, SelCmpt>
  /** The selections of views compiled in an earlier pass: a predicate may name a selection a later view declares. */
  forwardSelections?: ReadonlyMap<string, SelCmpt>
  /** The parameter names a predicate asked for that no earlier view declared as a selection. */
  selectionMisses: Set<string>
  /** Some selection projects `_vgsid_`: every pipeline starts with an identifier transform. */
  selectionIds: boolean
  /** Lookups from a selection: the dataset (unit data filtered by the selection) each one reads, by param. */
  selectionLookups: Map<string, { name: string }>
  /**
   * Some unit of the spec declares a selection (after the parameters of compositions are pushed down). Every unit's marks then
   * carry the `interactive` flag (vega-lite: the selections of a view are those of all its units, whichever one asks).
   */
  anySelection: boolean
  /** How many of the first transforms of the view being compiled were written on the facet around it (and not in its `spec`). */
  facetTransformCount: number
  /** The unit whose pipeline is being built. */
  currentUnit?: VLSpec
  /** The view being compiled is the child of a facet that is itself inside a facet: its pipeline stays inside the innermost cell. */
  inNestedFacet?: boolean
  /** vega-lite's `model.name` of the view being compiled ('' at the root): `concat_0`, `child`, `concat_1_child__column_a`. */
  modelName: string
  /** How many concat / facet / repeat views enclose the view being compiled (a unit inside one declares its signals in a group). */
  compositeDepth: number
  /** The facet channels around the view being compiled, outermost first: a unit's name carries its cell's (vega-lite `unitName`). */
  facetFields: ReadonlyArray<{ channel: string; field: string }>
}

/** The name of a child view: its parent's, then its own (vega-lite `model.getName`, which joins with `_`). */
const childModelName = (parent: string, own: string): string => (parent ? `${parent}_${own}` : own)

/** Compile `child` as the view named `own` inside the one being compiled (a concat child, a facet's cell, a repeated view). */
function inChildView<T>(ctx: CompileCtx, own: string, facetFields: ReadonlyArray<{ channel: string; field: string }>, composite: boolean, f: () => T): T {
  const saved = { modelName: ctx.modelName, compositeDepth: ctx.compositeDepth, facetFields: ctx.facetFields }
  ctx.modelName = childModelName(ctx.modelName, own)
  if (composite) ctx.compositeDepth++
  ctx.facetFields = [...ctx.facetFields, ...facetFields]
  try {
    return f()
  } finally {
    ctx.modelName = saved.modelName
    ctx.compositeDepth = saved.compositeDepth
    ctx.facetFields = saved.facetFields
  }
}

/** Every dataset name the user's spec declares or references (declared names are never renamed). */
function userDatasetNames(top: VLSpec): Set<string> {
  const names = new Set<string>()
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (!isObject(n)) return
    if (isObject(n.data) && typeof n.data.name === 'string') names.add(n.data.name)
    if (isObject(n.from) && isObject(n.from.data) && typeof n.from.data.name === 'string') names.add(n.from.data.name)
    for (const [k, v] of Object.entries(n)) if (k !== 'data' || isObject(v)) visit(v)
  }
  visit(top)
  if (isObject(top.datasets)) for (const k of Object.keys(top.datasets)) names.add(k)
  return names
}

function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Whether any unit (or layer) in the spec tree declares a selection parameter. */
function hasSelectionParams(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasSelectionParams)
  if (!isObject(node)) return false
  if (Array.isArray(node.params) && node.params.some((p) => isObject(p) && p.select !== undefined)) return true
  for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) if (hasSelectionParams(node[k])) return true
  return isObject(node.spec) && hasSelectionParams(node.spec)
}

function makeCtx(top: VLSpec): CompileCtx {
  const lookups = new Map<string, Record<string, unknown>>()
  const datasets = isObject(top.datasets) ? (top.datasets as Record<string, unknown>) : {}
  const userNames = userDatasetNames(top)
  const prefixFree = (base: string): string => {
    // grow a leading-underscore prefix until no user dataset name starts with `<prefix>_`
    let p = base
    while ([...userNames].some((n) => n.startsWith(`${p}_`))) p = `_${p}`
    return p
  }
  const dataPrefix = prefixFree('data')
  const sourcePrefix = prefixFree('source')
  let sourceCount = 0
  const ctx: CompileCtx = {
    lookups,
    datasets,
    selections: new Map(),
    selectionMisses: new Set(),
    facetTransformCount: 0,
    selectionIds: false,
    anySelection: hasSelectionParams(top),
    modelName: '',
    compositeDepth: 0,
    facetFields: [],
    dn: (i) => `${dataPrefix}_${i}`,
    takeSource: () => `${sourcePrefix}_${sourceCount++}`,
    fresh: (base) => {
      let n = base
      while (userNames.has(n)) n = `${n}_`
      return n
    },
    addLookupSource(def: Record<string, unknown>): string {
      const entry = dataSource(def, datasets)
      // a NAMED source keeps its name (hosts key data on it; a bare name is the
      // host-supplied or main dataset of that name); an anonymous one is named by content
      const name = typeof entry.name === 'string' ? entry.name : `lookup_${hashString(JSON.stringify(entry))}`
      const have = lookups.get(name)
      const next: Record<string, unknown> = { ...entry, name }
      if (have && JSON.stringify(have) !== JSON.stringify(next) && (have.values !== undefined || have.url !== undefined) && (next.values !== undefined || next.url !== undefined)) {
        throw new VLCompileError(`two lookups declare different data under the name "${name}"`)
      }
      if (!have || (have.values === undefined && have.url === undefined)) lookups.set(name, next)
      return name
    },
    selectionLookups: new Map(),
  }
  ctx.selectionTest = selectionTester(ctx)
  ctx.selectionTimeUnits = (param) => ctx.selections.get(varName(param))?.project.timeUnits ?? []
  ctx.addSelectionLookup = (param) => {
    const cmpt = ctx.selections.get(varName(param))
    if (!cmpt) throw new VLCompileError(`cannot look up the variable parameter "${param}": only a selection parameter can be a lookup source`)
    if (ctx.currentUnit && UNIT_SEL.get(ctx.currentUnit)?.cmpts[cmpt.name]) {
      throw new VLCompileError(`cannot look up the selection "${param}" in the unit that declares it: use a selection of another layer`)
    }
    let have = ctx.selectionLookups.get(cmpt.name)
    if (!have) ctx.selectionLookups.set(cmpt.name, (have = { name: ctx.fresh(`lookup_${cmpt.name}`) }))
    return have.name
  }
  return ctx
}

/** A Vega data entry for a VL `data` object (values/url/name + format), resolving named `datasets`. */
function dataSource(data: Record<string, unknown>, datasets: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // data generators (vega-lite SourceNode / GraticuleNode): the sphere is one GeoJSON row, a graticule a transform
  if (data.sphere !== undefined) return { ...(typeof data.name === 'string' ? { name: data.name } : {}), values: [{ type: 'Sphere' }] }
  // (compile/data/sequence.ts: the generated rows are the source itself)
  if (data.sequence !== undefined) return { ...(typeof data.name === 'string' ? { name: data.name } : {}), transform: [{ type: 'sequence', ...(data.sequence as Record<string, unknown>) }] }
  if (data.graticule !== undefined) {
    return { ...(typeof data.name === 'string' ? { name: data.name } : {}), transform: [{ type: 'graticule', ...(isObject(data.graticule) ? data.graticule : {}) }] }
  }
  for (const [k, v] of Object.entries(data)) out[k] = v
  // compile/data/source.ts: a URL's format type is the file's extension (json, csv, tsv, dsv, topojson; json for any other); Vega reads
  // json when it is not told, so a csv file would not load
  if (typeof data.url === 'string') {
    const format: Record<string, unknown> = isObject(data.format) ? { ...(data.format as Record<string, unknown>) } : {}
    if (!format.type) {
      const ext = /(?:\.([^.]+))?$/.exec(data.url)![1]
      format.type = ext !== undefined && ['json', 'csv', 'tsv', 'dsv', 'topojson'].includes(ext) ? ext : 'json'
    }
    out.format = format
  }
  if (typeof data.name === 'string' && data.values === undefined && data.url === undefined && Array.isArray(datasets[data.name])) {
    out.values = datasets[data.name]
  }
  return out
}

/** The user field paths a unit's encoding references (field, sort.field, condition fields, argmax args). */
function referencedPaths(encoding: unknown): string[] {
  const out = new Set<string>()
  const visit = (def: unknown): void => {
    if (Array.isArray(def)) { def.forEach(visit); return }
    if (!isObject(def)) return
    if (typeof def.field === 'string') out.add(def.field)
    if (isObject(def.aggregate)) for (const v of Object.values(def.aggregate)) if (typeof v === 'string') out.add(v)
    if (isObject(def.sort) && typeof def.sort.field === 'string') out.add(def.sort.field)
    if (def.condition !== undefined) visit(def.condition)
  }
  if (isObject(encoding)) for (const def of Object.values(encoding)) visit(def)
  return [...out]
}

/** Transform objects that came from the user's `transform` array (not the encoding). */
const USER_TRANSFORMS = new WeakSet<object>()
/** The user transforms written on a facet itself (they run once, before the cells), as opposed to the ones inside its `spec`. */
const FACET_LEVEL_TRANSFORMS = new WeakSet<object>()

function buildData(spec: VLSpec, allFields: FieldDef[], mark: string, orient: string, castDoneIn: Set<string> | undefined, ctx: CompileCtx): DataPipeline {
  // datum-only defs read no data
  const fields = allFields.filter((f) => !f.datumOnly)
  let seriesFields: FieldDef[] = []
  const source: Record<string, unknown> = isObject(spec.data) ? dataSource(spec.data, ctx.datasets) : {}
  const sourceName = (source.name as string) ?? 'source_0'
  source.name = sourceName
  const casts: Record<string, unknown>[] = []
  const pipeline: Record<string, unknown>[] = []
  const castDone = castDoneIn ?? new Set<string>()
  const scaleCfg = scaleConfigOf(spec)
  // default point selections identify each datum: the identifier is the first transform of the pipeline
  // (vega-lite IdentifierNode, kept by RemoveUnnecessaryIdentifierNodes when its parent is the source)
  if (ctx.selectionIds && !castDone.has('selection:id')) {
    castDone.add('selection:id')
    casts.push(identifierTransform())
  }
  const ownSelectionId = UNIT_SEL.get(spec)?.ownId === true

  const userTransforms = Array.isArray(spec.transform) ? (spec.transform as Record<string, unknown>[]) : []
  // fields a user transform produces are derived: vega-lite never re-parses them
  const derivedKeys = new Set<string>()
  {
    const probe: TranslateState = { parsed: new Map() }
    translateTransforms(userTransforms, ctx, probe)
    for (const [k, v] of probe.parsed) if (v === 'derived') derivedKeys.add(k)
    // a sequence generator's rows are numbers already (sequence.ts producedFields)
    if (isObject(spec.data) && isObject(spec.data.sequence)) derivedKeys.add(typeof spec.data.sequence.as === 'string' ? spec.data.sequence.as : 'data')
  }
  // flatten nested/escaped source paths into the flat keys the rest of the
  // compiler reads (names.ts flatField); once per distinct key per source
  // (a path under a field a user transform produces - a flatten's output, say - can only be read once that transform has run: its
  // copy follows the transforms, as a parse node placed after them, and the copy is not parsed again)
  const lateFlat: Record<string, unknown>[] = []
  const addFlat = (userPath: string): void => {
    const ff = flatField(userPath)
    if (ff.expr === undefined || castDone.has(`flat:${ff.key}`)) return
    castDone.add(`flat:${ff.key}`)
    if (derivedKeys.has(splitAccessPath(userPath)[0]!)) {
      lateFlat.push({ type: 'formula', expr: ff.expr, as: ff.key })
      derivedKeys.add(ff.key)
    } else casts.push({ type: 'formula', expr: ff.expr, as: ff.key })
  }
  for (const f of fields) if (f.flatExpr !== undefined) addFlat(f.source)
  for (const p of referencedPaths(spec.encoding)) addFlat(p)

  // type casts (formula) — the oracle emits them around impute/stack pipelines
  // (quantitative -> toNumber, temporal -> toDate)

  // binning: extent + bin transforms ahead of any aggregate
  const binFields = fields.filter((f) => f.bin)
  const binSignals = new Map<string, { startField: string; endField: string; binsSignal: string }>()
  const binPipeline: Record<string, unknown>[] = []
  for (const f of binFields) {
    const names = binNames(f.binParams!, f.field)
    if (!isPrebinned(f)) pushAll(binPipeline, binTransforms(f.binParams!, f.field, names, binSpanExpr(ctx, f.binParams!)))
    binSignals.set(f.field, { startField: names.start, endField: names.end, binsSignal: names.signal })
  }

  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  // stack.ts: an arc (or a label) stacks along theta or radius
  const polarStack = polarStackOf(fields, mark)
  // channel roles shared by the pipeline stages below
  const yDef = fields.find((f) => f.channel === 'y')
  const xDef = fields.find((f) => f.channel === 'x')
  const stackable = mark !== 'arc'
  // an explicit stack on x/y decides the measure axis even for marks with no
  // natural orientation (point/circle/square)
  // vega-lite only reads an explicit stack from an unbinned quantitative
  // channel; a stack property on a discrete channel is inert.
  const explicitStackDef = fields.find((f) => (f.channel === 'x' || f.channel === 'y')
    && f.type === 'quantitative' && !f.bin
    && f.stack != null && f.stack !== false && f.stack !== 'wiggle')
  const autoStackDef = !explicitStackDef && (mark === 'bar' || mark === 'area')
    ? fields.find((f) => f.channel === potentialStackChannel(mark, orient, fields))
    : undefined
  const measureChannel = explicitStackDef
    ? explicitStackDef.channel
    : autoStackDef
      ? autoStackDef.channel
      : orient === 'vertical' ? 'y' : 'x'
  const dimensionChannel = measureChannel === 'y' ? 'x' : 'y'
  const measure = measureChannel === 'y' ? yDef : xDef
  const dimension = dimensionChannel === 'x' ? xDef : yDef
  const continuousDimension = dimension != null && !isDiscreteType(dimension.type)

  // the oracle skips casts only in the discrete-dimension stack+filter pipeline
  const GENERATING = new Set(['regression', 'quantile', 'loess', 'kde', 'density'])
  const lastUser = userTransforms.length
    ? (userTransforms[userTransforms.length - 1] as Record<string, unknown>)
    : undefined
  const lastUserType = lastUser == null
    ? undefined
    : (lastUser.type as string | undefined) ?? GENERATING.has(Object.keys(lastUser)[0] ?? '') ? Object.keys(lastUser)[0] : undefined
  // a generating transform that ends the pipeline REPLACES the data feeding
  // the mark — vega-lite skips both the type casts and the invalid-value
  // filter in that case (e.g. {regression: y, on: x})
  const generatingEnd = lastUser != null && GENERATING.has(lastUserType ?? '')
    ? !(
        fields.some((f) => f.aggregate) ||
        (measure != null && isStacked(measure, mark, orient, allFields)) ||
        (mark === 'arc' && thetaDef != null)
      )
    : false
  // (binning leaves a quantitative field uncast - vega-lite relies on the data format - but a temporal one is still parsed)
  const skipNumberCasts = binFields.length > 0
  const skipCasts = generatingEnd ||
    ((mark === 'bar' || mark === 'area') &&
    !fields.some((f) => f.aggregate) &&
    !fields.some((f) => f.timeUnit) &&
    fields.some((f) => f.channel === measureChannel && f.type === 'quantitative') &&
    !continuousDimension)
  const castTypes = new Map<string, 'number' | 'date'>()
  if (!skipCasts) {
    // a field carrying a timeUnit anywhere in the encoding casts as a date,
    // even if another channel declares it quantitative
    const timeUnitFields = new Set(fields.filter((f) => f.timeUnit).map((f) => f.field))
    for (const f of fields) {
      if (castDone.has(f.field)) continue
      castDone.add(f.field)
      if (f.argAgg || derivedKeys.has(f.field)) continue
      const declared = (f.raw as Record<string, unknown> | undefined)?.type
      // count/distinct/valid/missing over a nominal/ordinal field counts raw
      // values — vega-lite does not coerce the source column (only temporal
      // sources go through toNumber).
      // (a temporal field declared under one of them is coerced to quantitative with a warning, and then does cast to a number)
      if (f.aggregate != null && declared !== 'temporal' && ['count', 'distinct', 'valid', 'missing'].includes(String(f.aggregate))) continue
      if (timeUnitFields.has(f.field) || f.timeUnit || f.type === 'temporal') {
        // A temporal axis formatted as a number makes upstream skip the toDate
        // cast entirely (the time scale then gets raw strings and an invalid
        // domain — probed guide-axis-x-temporal-formatType-number).
        const cfgAll = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
        const cfgA = isObject(cfgAll.axis) ? cfgAll.axis as Record<string, unknown> : undefined
        const cfgCh = isObject(cfgAll[f.channel === 'x' ? 'axisX' : 'axisY'])
          ? cfgAll[f.channel === 'x' ? 'axisX' : 'axisY'] as Record<string, unknown>
          : undefined
        const ownA = isObject((f.raw as Record<string, unknown> | undefined)?.axis)
          ? (f.raw as Record<string, unknown>).axis as Record<string, unknown>
          : undefined
        const axisFT = ownA?.formatType ?? cfgCh?.formatType ?? cfgA?.formatType
        if (axisFT !== 'number') {
          // a timeUnit implies a temporal cast even when the declared type is
          // quantitative (probed: size/timeUnit-year casts the source toDate)
          casts.push({ type: 'formula', expr: `toDate(${dref(f.field)})`, as: f.field })
          castTypes.set(f.field, 'date')
        }
      } else if (f.type === 'quantitative' && !skipNumberCasts) {
        casts.push({ type: 'formula', expr: `toNumber(${dref(f.field)})`, as: f.field })
        castTypes.set(f.field, 'number')
      }
    }
  }
  // user transforms (calculate/filter/flatten/fold/window/...), translated
  // from their Vega-Lite forms (transforms.ts); implicit parses already
  // emitted above (the casts) are not repeated
  const st: TranslateState = { parsed: new Map(), ...(ownSelectionId ? { requiresSelectionId: true } : {}) }
  for (const [k, ty] of castTypes) st.parsed.set(k, ty)
  ctx.currentUnit = spec
  // (bin.ts getBinSignalName: a bin transform's signals are named after the model that declares it, a layer's name for a transform on a layer)
  const leafPath = LEAF_PATHS.get(spec)
  const depths = TRANSFORM_DEPTHS.get(spec)
  const userOut = userTransforms.flatMap((t, i) => {
    const out = translateTransforms([t], ctx, st)
    // (FacetModel.addDimensions reaches the aggregates inside the facet's `spec`; the transforms on the facet itself ran before the cells)
    if (i < ctx.facetTransformCount && !depths?.[i]) for (const o of out) FACET_LEVEL_TRANSFORMS.add(o)
    const depth = depths?.[i]
    if (leafPath && depth) {
      const own = new Map<string, string>()
      for (const o of out) if ((o.type === 'bin' || o.type === 'extent') && typeof o.signal === 'string') own.set(o.signal, `${leafPath.slice(0, depth).map((n) => `layer_${n}`).join('_')}_${o.signal}`)
      if (own.size) renameFragment(out, { signals: own, scales: new Map<string, string>() })
    }
    return out
  })
  ctx.currentUnit = undefined
  for (const t of userOut) USER_TRANSFORMS.add(t)
  pushAll(pipeline, userOut)
  pushAll(pipeline, lateFlat)
  // (the facet node of a facet inside a facet sits here: what the encoding adds is made inside the innermost cell)
  const userLen = pipeline.length

  // maps: the geojson (projection fit) and geopoint (longitude / latitude) transforms follow the
  // user's transforms and the implicit parses, ahead of bin / timeUnit / aggregate
  {
    const geo = GEO_UNITS.get(spec)
    if (geo) pushAll(pipeline, geoDataTransforms(spec, geo))
  }

  // binning (data/parse.ts: user transforms, geo, THEN bin, then timeUnit): the extent is taken over the filtered rows
  pushAll(pipeline, binPipeline)
  // a binned discrete field is named by its bin's text (data/bin.ts: `<bin>_range`)
  for (const f of binFields) {
    if (!binDiscrete(f)) continue
    const bn = binNames(f.binParams!, f.field)
    const rangeField = `${bn.start}_range`
    if (pipeline.some((t) => t.type === 'formula' && t.as === rangeField)) continue
    const dfn = defFormat(f)
    pipeline.push({ type: 'formula', expr: binFormatExpr(dref(bn.start), dref(bn.end), dfn.format, dfn.formatType, spec.config as never), as: rangeField })
  }

  // timeUnit: the timeunit transform floors each date to the unit
  const tuSeen = new Set<string>()
  for (const f of fields.filter((q) => q.tu && q.field)) {
    const as = timeUnitField(f)
    if (tuSeen.has(as)) continue
    tuSeen.add(as)
    // timeunit.ts TimeUnitNode (binned): the field is the start already; its end is made only for a rect-based mark or a band position
    const hasSecondary0 = fields.some((g) => g.channel === `${f.channel}2`)
    if (f.tu!.binned) {
      const rectBased = RECT_BASED_MARKS.has(mark)
      // (`!!bandPosition`: a band position of 0 is no reason to make the end)
      if (rectBased || !!bandPositionOf(spec, mark, f, hasSecondary0)) {
        pipeline.push({ type: 'formula', expr: binnedEndExpr(f.tu!, f.field), as: `${as}_end` })
      }
    } else {
      pipeline.push(timeUnitTransform(f.tu!, f.field, as))
    }
    // timeunit.ts offsetedRectFormulas: a rect-based mark's time unit that is not at the middle of its band (bandPosition)
    // reads start / end positions interpolated between the unit and the unit before it
    const hasSecondary = fields.some((g) => g.channel === `${f.channel}2`)
    const bp = (f.channel === 'x' || f.channel === 'y') && RECT_BASED_MARKS.has(mark) ? bandPositionOf(spec, mark, f, hasSecondary) : undefined
    if (bp !== undefined && bp !== 0.5) pushAll(pipeline, offsettedRectFormulas(as, bp, f.tu!))
  }

  // sort arrays: an index column (position in the user's list) that the scale
  // domain sorts by; values missing from the list sort last (vega-lite
  // calculate.ts parseAllForSortIndex)
  const sortIdxSeen = new Set<string>()
  for (const f of fields) {
    if (!Array.isArray(f.sort)) continue
    const name = sortIndexName(f)
    if (sortIdxSeen.has(name)) continue
    sortIdxSeen.add(name)
    const sortValues = f.sort as unknown[]
    const expr = sortValues
      .map((v, i) => `${predicateExpr({ field: f.source, ...(f.raw.timeUnit !== undefined ? { timeUnit: f.raw.timeUnit } : {}), equal: v })} ? ${i} : `)
      .join('') + sortValues.length
    pipeline.push({ type: 'formula', expr, as: name })
  }
  // everything above is the "raw" table that object/array sorts of a scale domain read
  const rawLen = pipeline.length

  const hasAggregate = fields.some((f) => f.aggregate)

  // the stack (and, for path marks over a continuous dimension, the impute that
  // zero-fills missing series) of a stacked measure; vega-lite runs it after the
  // aggregate when the measure is aggregated
  const stackTransforms = (m: FieldDef): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    const dimDef = dimensionChannel === 'x' ? xDef : yDef
    const dimField = dimDef ? aggFieldName(dimDef) : undefined
    seriesFields = stackByFields(fields, dimensionChannel)
    const stackField = aggFieldName(m)
    const midDim = dimDef !== undefined && usesBinMid(spec, dimDef, mark, fields)
    if (midDim) {
      const bn = binNames(dimDef!.binParams!, dimDef!.field)
      const start = JSON.stringify(bn.start)
      const end = JSON.stringify(bn.end)
      out.push({ type: 'formula', expr: `isValid(datum[${start}]) && isFinite(+datum[${start}]) ? 0.5*datum[${start}]+0.5*datum[${end}] : datum[${start}]`, as: binMidName(dimDef!) })
    }
    const stackDim = midDim ? binMidName(dimDef!) : dimField
    if (continuousDimension && (mark === 'area' || mark === 'line' || mark === 'trail')) {
      out.push({
        type: 'impute',
        field: stackField,
        groupby: seriesFields.map((f) => aggFieldName(f)),
        key: stackDim!,
        method: 'value',
        value: 0,
      })
    }
    out.push({
      type: 'stack',
      groupby: [stackDim, ...fields.filter((f) => f.channel === (dimensionChannel === 'x' ? 'xOffset' : 'yOffset')).map((f) => aggFieldName(f))].filter(Boolean),
      field: stackField,
      sort: stackSortParams(fields, seriesFields, measureChannel, isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}),
      as: [`${stackField}_start`, `${stackField}_end`],
      offset: measureStackOffset(m),
    })
    return out
  }
  // data/impute.ts makeFromEncoding: an `impute` on x or y (when both are fields) imputes the channel over the other one, per path group,
  // ahead of the stack
  const channelImpute: Record<string, unknown>[] = []
  if (xDef?.field && yDef?.field && !xDef.datumOnly && !yDef.datumOnly) {
    const imputed = xDef.raw.impute !== undefined ? xDef : yDef.raw.impute !== undefined ? yDef : undefined
    if (imputed) {
      const keyDef = imputed === xDef ? yDef : xDef
      const { method, value, frame, keyvals } = imputed.raw.impute as Record<string, unknown>
      const groupby = pathGroupingKeys(spec, fields, mark)
      pushAll(channelImpute, imputeTransforms({
        impute: imputed.field,
        key: keyDef.field,
        ...(method ? { method } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(frame ? { frame } : {}),
        ...(keyvals !== undefined ? { keyvals } : {}),
        ...(groupby.length ? { groupby } : {}),
      }))
    }
  }
  const stackAfterAggregate = stackable && measure != null && measure.aggregate != null && measure.type === 'quantitative' && !measure.bin && isStacked(measure, mark, orient, allFields)

  // (aggregate.ts makeFromEncoding: only a field with an aggregate makes an aggregate node; binning alone groups nothing)
  if (hasAggregate) {
    const groupby: string[] = []
    const fieldsOut: Record<string, unknown>[] = []
    const argFlats: FieldDef[] = []
    let hasCount = false
    for (const f of fields) {
      if (f.bin) {
        const bin = binSignals.get(f.field)!
        groupby.push(bin.startField, bin.endField)
        if (binDiscrete(f)) groupby.push(`${bin.startField}_range`)
        continue
      }
      if (f.aggregate) {
        if (f.aggregate === 'count') {
          hasCount = true
        } else if (f.argAgg) {
          fieldsOut.push({ op: f.argAgg.op, field: f.argAgg.arg, as: argObjName(f) })
          argFlats.push(f)
        } else {
          fieldsOut.push({ op: f.aggregate, field: f.field, as: aggregateAs(f) })
          // a scale over the unaggregated domain also needs the raw min and max
          if (SCALE_CHANNELS.includes(f.channel) && usesUnaggregatedDomain(f, scaleCfg)) {
            for (const op of ['min', 'max']) fieldsOut.push({ op, field: f.field, as: genName(op, f.field) })
          }
        }
      } else if (GEO_POSITION_CHANNELS.includes(f.channel as never)) {
        // a projected position groups by the geopoint transform's output (vega-lite aggregate.ts addDimension)
        const geo = GEO_UNITS.get(spec)
        if (geo) groupby.push(`${geo.prefix}${f.channel.startsWith('longitude') ? 'x' : 'y'}${f.channel.endsWith('2') ? '2' : ''}`)
      } else if (!f.bin && f.field) {
        // vega-lite groups by every non-aggregated field: the dimension,
        // color/detail, and any other channel's raw field (an aggregate on
        // one channel groups by the other channels — probed: x-aggregate
        // over a quantitative y groups by y)
        groupby.push(aggFieldName(f))
        // a time-unit band on a rect-based mark also spans to its end (vega-lite hasBandEnd)
        // (aggregate.ts addDimension: the end of the band when it has one, and the offsetted rect fields off its middle)
        const hasSecondary = fields.some((g) => g.channel === `${f.channel}2`)
        const bp = f.tu && f.type === 'temporal' ? bandPositionOf(spec, mark, f, hasSecondary) : undefined
        if (f.tu && f.type === 'temporal' && bp !== undefined) {
          groupby.push(`${aggFieldName(f)}_end`)
          if (RECT_BASED_MARKS.has(mark) && bp !== 0.5 && (f.channel === 'x' || f.channel === 'y')) groupby.push(`${aggFieldName(f)}_offsetted_rect_start`, `${aggFieldName(f)}_offsetted_rect_end`)
        }
      }
    }
    if (hasCount) fieldsOut.push({ op: 'count', as: '__count', field: null })
    // the same output produced twice (two channels sharing a measure) is computed once
    const seenAs = new Set<unknown>()
    const measures = fieldsOut.filter((o) => (seenAs.has(o.as) ? false : (seenAs.add(o.as), true)))
    const groupbyUniq = [...new Set(groupby)]
    if (measures.length || groupbyUniq.length) {
      pipeline.push({ type: 'aggregate', groupby: groupbyUniq, ops: measures.map((o) => o.op), fields: measures.map((o) => o.field ?? null), as: measures.map((o) => o.as) })
      if (ownSelectionId) pipeline.push(identifierTransform())
      pushAll(pipeline, channelImpute)
      if (stackAfterAggregate) pushAll(pipeline, stackTransforms(measure!))
      if (polarStack) pushAll(pipeline, polarStackTransforms(polarStack, fields, isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}))
      // argmax/argmin leave the winning ROW in the aggregate column; flatten
      // the channel's value out of it (vega-lite reads `argmax_b["a"]`)
      const argDone = new Set<string>()
      for (const f of argFlats) {
        const n = aggFieldName(f)
        if (argDone.has(n)) continue
        argDone.add(n)
        pipeline.push({ type: 'formula', expr: argValueExpr(f), as: n })
      }
    }
  } else if (stackable && measure && measure.type === 'quantitative' && !measure.bin && isStacked(measure, mark, orient, allFields)) {
    // stacked bar/area: continuous dimensions impute gaps; discrete ones filter
    pushAll(pipeline, channelImpute)
    pushAll(pipeline, stackTransforms(measure))
  } else {
    pushAll(pipeline, channelImpute)
    if (polarStack) pushAll(pipeline, polarStackTransforms(polarStack, fields, isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}))
  }

  // the invalid values the marks must not see (vega-lite FilterInvalidNode): skipped when a generating
  // transform replaces the data entirely
  let invalidSplit: InvalidScaleSplit | undefined
  {
    const invalid = invalidFilter(spec, fields, mark)
    if (invalid) pipeline.push(invalid)
    invalidSplit = invalidScaleSplit(spec, fields, mark, invalid)
  }

  const transforms = [...casts, ...pipeline]
  const dataName = transforms.length ? ctx.dn(0) : sourceName
  return { sourceName, transforms, casts, pipeline, dataName, seriesFields, rawLen: ctx.inNestedFacet ? userLen : rawLen, usesRawDomain: ctx.inNestedFacet === true || fields.some(usesRawDomainSort), ...(invalidSplit ? { invalidSplit } : {}) }
}

function aggregateAs(f: FieldDef): string {
  if (f.argAgg) return safeKey(`${argObjName(f)}_${f.field}`)
  return genName(String(f.aggregate), f.field)
}

/** The aggregate column holding the winning row of an argmax/argmin. */
function argObjName(f: FieldDef): string {
  return genName(f.argAgg!.op, f.argAgg!.arg)
}

/** Expression reading the channel's value out of the argmax/argmin winning row. */
function argValueExpr(f: FieldDef): string {
  return dref(argObjName(f)) + splitAccessPath(f.argAgg!.valuePath).map((p) => `[${JSON.stringify(p)}]`).join('')
}

/**
 * mark/arc.ts + position-rect.ts `rectPosition` for `radius` and `theta`: an arc is a rectangle in polar coordinates. A binned (or time unit)
 * channel spans its bin's end (outer radius, start angle) to its start; a discrete one sits at the start of its band and spans the band;
 * any other is positioned by its field - or, stacked, by its stack's end - and runs to its second channel, the mark definition's
 * inner radius / end angle, or scale zero. Returns the channels a field drove. (theta2 and radius2 channels are refused earlier.)
 */
function polarRectPositions(update: Record<string, unknown>, spec: VLSpec, fields: FieldDef[], stack: PolarStack | undefined, markRef: (v: unknown) => Record<string, unknown>, innerFallback: unknown): Set<string> {
  const handled = new Set<string>()
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  for (const channel of ['radius', 'theta'] as const) {
    const def = fields.find((f) => f.channel === channel && f.field && !f.datumOnly)
    if (!def) continue
    handled.add(channel)
    const near = channel === 'theta' ? 'startAngle' : 'outerRadius'
    const far = channel === 'theta' ? 'endAngle' : 'innerRadius'
    const discrete = isDiscreteType(def.type)
    const bandScale = discrete && (def.scale?.type === undefined || def.scale.type === 'band')
    const offsetValue = md[`${channel}Offset`]
    const offset = offsetValue ? offsetValue : undefined
    const withOffset = (ref: Record<string, unknown>): Record<string, unknown> => (offset === undefined ? ref : { ...ref, offset })
    if ((def.bin || def.tu) && !discrete) {
      // rectBinPosition: the band size is 1 (a bin, a time unit), so the near key reads the far end of the band
      let start: string
      let end: string
      if (def.bin) {
        const names = binNames(def.binParams!, def.field)
        start = names.start
        end = isPrebinned(def) ? `${def.field}_end` : names.end
      } else {
        const base = timeUnitField(def)
        const rect = bandPositionOf(spec, 'arc', def, false) !== 0.5
        start = rect ? `${base}_offsetted_rect_start` : base
        end = rect ? `${base}_offsetted_rect_end` : `${base}_end`
      }
      update[near] = { scale: channel, field: end }
      update[far] = { scale: channel, field: start }
    } else if (discrete) {
      // positionAndSize: the start of the band, and the band's width on to its end
      const size = bandScale ? { signal: `bandwidth('${channel}')` } : { value: C.defaultStep }
      const sizeRef = offset === undefined ? size : { ...size, offset }
      update[near] = withOffset({ scale: channel, field: aggFieldName(def) })
      update[far] = { scale: channel, field: aggFieldName(def), offset: sizeRef }
    } else {
      const band = bandScale ? { band: def.bandPosition ?? 0.5 } : {}
      update[near] = withOffset(stack?.fieldChannel === channel ? stackedPolarRef(channel, stack, def.bandPosition) : { scale: channel, field: aggFieldName(def), ...band })
      if (stack?.fieldChannel === channel) update[far] = withOffset({ scale: channel, field: `${stack.field}_start` })
      else {
        const given = channel === 'theta' ? (md.endAngle ?? md.theta2) : innerFallback
        update[far] = given !== undefined && given !== null ? markRef(given) : zeroOrMinRef(channel)
      }
    }
  }
  return handled
}

/**
 * position-point.ts `positionRef` + valueref.ts `interpolatedSignalRef` for the stacked channel of an arc or a label: the stack's end, or,
 * with a `bandPosition`, that fraction of the way from the stack's start to its end (0 is the start, 1 the end).
 */
function stackedPolarRef(channel: 'theta' | 'radius', stack: PolarStack, bandPosition: number | undefined): Record<string, unknown> {
  if (bandPosition === undefined || bandPosition === 1) return { scale: channel, field: `${stack.field}_end` }
  if (bandPosition === 0) return { scale: channel, field: `${stack.field}_start` }
  return { signal: `scale(${JSON.stringify(channel)}, ${1 - bandPosition} * datum[${JSON.stringify(`${stack.field}_start`)}] + ${bandPosition} * datum[${JSON.stringify(`${stack.field}_end`)}])` }
}

/**
 * position-point.ts `pointPosition` / `positionRef` for the `theta` and `radius` of a label: a stacked channel sits in the middle of its
 * stack (a label's band position is 0.5 unless it says otherwise), any other at its value; `thetaOffset` / `radiusOffset` move it.
 */
function polarPointPositions(update: Record<string, unknown>, spec: VLSpec, fields: FieldDef[], stack: PolarStack | undefined): void {
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  for (const channel of ['theta', 'radius'] as const) {
    const def = fields.find((f) => f.channel === channel && f.field && !f.datumOnly)
    if (!def) continue
    const offsetValue = md[`${channel}Offset`]
    const offset = offsetValue ? { offset: offsetValue } : {}
    if (stack?.fieldChannel === channel) {
      update[channel] = { ...stackedPolarRef(channel, stack, def.bandPosition ?? 0.5), ...offset }
    } else {
      update[channel] = { scale: channel, field: aggFieldName(def), ...offset }
    }
  }
}

/**
 * stack.ts `potentialStackedChannel` for a polar or cartesian pair (`x`/`y`, `theta`/`radius`): the channel that is stacked, if any.
 * An explicit `stack` decides; otherwise the one unaggregated quantitative channel, or the only aggregated one of two.
 */
function potentialStackedChannel(fields: FieldDef[], first: 'x' | 'theta'): 'x' | 'y' | 'theta' | 'radius' | undefined {
  const second = first === 'x' ? 'y' : 'radius'
  const defOf = (ch: string): FieldDef | undefined => fields.find((f) => f.channel === ch && !f.datumOnly && (f.field !== undefined && f.field !== '' || f.aggregate === 'count'))
  const unbinnedQuantitative = (f: FieldDef | undefined): f is FieldDef => f !== undefined && f.type === 'quantitative' && !f.bin
  const a = defOf(first)
  const b = defOf(second)
  if (a !== undefined && b !== undefined) {
    if (unbinnedQuantitative(a) && unbinnedQuantitative(b)) {
      if (a.stack) return first
      if (b.stack) return second
      const aAggregate = !!a.aggregate
      const bAggregate = !!b.aggregate
      // (with no explicit stacking, only when exactly one of the two is aggregated)
      if (aAggregate !== bAggregate) return aAggregate ? first : second
    } else if (unbinnedQuantitative(a)) return first
    else if (unbinnedQuantitative(b)) return second
  } else if (unbinnedQuantitative(a)) return first
  else if (unbinnedQuantitative(b)) return second
  return undefined
}

/** What an arc or a label stacks along theta or radius (stack.ts `stack`). */
interface PolarStack {
  fieldChannel: 'theta' | 'radius'
  field: string
  /** the dimension the stack restarts for: the other polar channel's field, unless it is the stacked one */
  groupby: FieldDef[]
  /** the fields that split the stack (colour, detail, ...), not the dimension's */
  stackBy: FieldDef[]
  offset: 'zero' | 'center' | 'normalize'
}

function polarStackOf(fields: FieldDef[], mark: string): PolarStack | undefined {
  if (mark !== 'arc' && mark !== 'text') return undefined
  // stack.ts: the cartesian pair is asked first; a stack of x or y (even one that does not happen) leaves theta alone
  if (potentialStackedChannel(fields, 'x') !== undefined) return undefined
  const fieldChannel = potentialStackedChannel(fields, 'theta') as 'theta' | 'radius' | undefined
  if (fieldChannel === undefined) return undefined
  const def = fields.find((f) => f.channel === fieldChannel && !f.datumOnly)!
  const field = aggFieldName(def)
  const dimensionChannel = fieldChannel === 'theta' ? 'radius' : 'theta'
  const dimensionDef = fields.find((f) => f.channel === dimensionChannel && !f.datumOnly && f.field)
  const groupby: FieldDef[] = []
  const groupFields = new Set<string>()
  if (dimensionDef !== undefined && aggFieldName(dimensionDef) !== field) {
    groupby.push(dimensionDef)
    groupFields.add(aggFieldName(dimensionDef))
  }
  const stackBy: FieldDef[] = []
  for (const ch of NONPOSITION_ORDER) {
    if (ch === 'tooltip') continue
    for (const f of fields) {
      if (f.channel !== ch || f.datumOnly || !f.field || f.aggregate || groupFields.has(aggFieldName(f))) continue
      stackBy.push(f)
    }
  }
  let offset: unknown
  if (def.stack !== undefined) offset = typeof def.stack === 'boolean' ? (def.stack ? 'zero' : null) : def.stack
  else if (mark === 'arc') offset = 'zero'
  if (offset !== 'zero' && offset !== 'center' && offset !== 'normalize') return undefined
  // an aggregate with nothing to split the stack by, and a ranged mark, do not stack
  if (fields.some((f) => f.aggregate) && stackBy.length === 0) return undefined
  if (fields.some((f) => f.channel === `${fieldChannel}2` && f.field)) return undefined
  return { fieldChannel, field, groupby, stackBy, offset }
}

/** data/stack.ts StackNode.assemble for an arc or a label. */
function polarStackTransforms(stack: PolarStack, fields: FieldDef[], encoding: Record<string, unknown>): Record<string, unknown>[] {
  const groupby = stack.groupby.flatMap((d) => (d.bin ? [binNames(d.binParams!, d.field).start, binNames(d.binParams!, d.field).end] : [aggFieldName(d)]))
  return [{ type: 'stack', groupby, field: stack.field, sort: stackSortParams(fields, stack.stackBy, 'theta', encoding), as: [`${stack.field}_start`, `${stack.field}_end`], offset: stack.offset }]
}

/** Pre-binned data (`bin: "binned"`): the field holds the bins' starts and no bin transform is made. */
const isPrebinned = (f: FieldDef): boolean => f.binParams?.binned === true

/** A binned field of a discrete type (ordinal / nominal): its bins are the categories. */
function binDiscrete(f: FieldDef): boolean {
  return !!f.bin && isDiscreteType(f.type) && (f.channel === 'x' || f.channel === 'y' || f.channel === 'xOffset' || f.channel === 'yOffset')
}

function aggFieldName(f: FieldDef): string {
  // (channeldef.ts binRequiresRange: a binned discrete field is positioned by its bin's text, the `_range` field)
  if (f.bin) return binDiscrete(f) ? `${binNames(f.binParams!, f.field).start}_range` : binNames(f.binParams!, f.field).start
  if (f.tu) return timeUnitField(f)
  if (f.aggregate === 'count') return '__count'
  if (f.aggregate) return aggregateAs(f)
  return f.field
}

/** The timeunit transform's output field for a time-unit channel (flat-safe). */
function timeUnitField(f: FieldDef): string {
  return timeUnitFieldName(f.tu!, f.field)
}

/** vega's timeUnitSpecifier signal for a vega-lite time unit string. */
function timeUnitFormatSignal(u: string): string {
  return `timeUnitSpecifier(${JSON.stringify(getTimeUnitParts(u))}, {"year-month":"%b %Y ","year-month-date":"%b %d, %Y "})`
}

/**
 * vega-lite axis/assemble.ts, legend/assemble.ts: a `labelExpr` is the label text encode; when the labels already
 * have a text signal (a custom format type) its `datum.label` stands for that text.
 */
function labelExprSignal(labelExpr: string, existing: unknown): string {
  const prior = isObject(existing) && typeof existing.signal === 'string' ? existing.signal : undefined
  return prior === undefined ? labelExpr : labelExpr.split('datum.label').join(prior)
}

/**
 * vega-lite axis/encode.ts labels() and legend/encode.ts labels(): the label text of a guide whose format type is
 * custom -- the guide's own, else (`config.customFormatTypes`, no format or format type of its own) the config's
 * number / time (and, on a normalized stack axis, normalized number) format type -- as a signal over `datum.value`.
 * The caller leaves vega's `format` / `formatType` unset for such a guide.
 */
function customLabelText(def: FieldDef, guide: Record<string, unknown> | null | undefined, config: Record<string, unknown> | undefined, normalizedStack: boolean): string | undefined {
  const format = guide?.format
  const formatType = guide?.formatType
  if (isCustomFormatType(formatType)) return customFormatExpr(formatType, 'datum.value', format)
  if (format === undefined && formatType === undefined && config?.customFormatTypes === true) {
    if (def.type === 'quantitative') {
      if (normalizedStack && typeof config.normalizedNumberFormatType === 'string') {
        return customFormatExpr(config.normalizedNumberFormatType, 'datum.value', config.normalizedNumberFormat)
      }
      if (typeof config.numberFormatType === 'string') return customFormatExpr(config.numberFormatType, 'datum.value', config.numberFormat)
    }
    if (def.type === 'temporal' && typeof config.timeFormatType === 'string' && def.tu === undefined) {
      return customFormatExpr(config.timeFormatType, 'datum.value', config.timeFormat)
    }
  }
  return undefined
}

/** Non-positional legends format timeUnit fields with timeFormat. */
function applyTimeUnitLegend(lg: Record<string, unknown>, def: FieldDef, userLegend: Record<string, unknown> | undefined, formats: { numberFormat?: string; timeFormat?: string }): void {
  if (userLegend && userLegend.format !== undefined) return
  // a raw temporal field formats through config.timeFormat, a quantitative one through config.numberFormat
  if (!def.timeUnit) {
    if (def.type === 'temporal') lg.format = formats.timeFormat ?? DEFAULT_TIME_FORMAT
    else if (def.type === 'quantitative' && formats.numberFormat !== undefined) lg.format = formats.numberFormat
    return
  }
  lg.format = { signal: timeUnitFormatSignal(def.timeUnit) }
  lg.formatType = 'time'
}


/**
 * scale/range.ts getOffsetRange: the range of an offset scale. Along a band position scale it is the band's width; with no
 * position scale it is centred on the view; along a continuous position scale with a time unit it is the (padded) duration of
 * one unit on that scale.
 */
/** The padding properties of a discrete offset scale (scale/properties.ts padding, paddingInner, paddingOuter). */
function offsetPaddings(def: FieldDef, type: 'band' | 'point', defaultInner: unknown, defaultOuter: unknown): Record<string, unknown> {
  const sc = def.scale ?? {}
  if (sc.padding !== undefined) return { padding: sc.padding, ...(type === 'band' && sc.paddingInner !== undefined ? { paddingInner: sc.paddingInner } : {}), ...(sc.paddingOuter !== undefined ? { paddingOuter: sc.paddingOuter } : {}) }
  const inner = type === 'band' ? sc.paddingInner ?? defaultInner : undefined
  const outer = sc.paddingOuter ?? defaultOuter
  return { ...(inner !== undefined ? { paddingInner: inner } : {}), ...(outer !== undefined ? { paddingOuter: outer } : {}) }
}

function offsetRange(ch: 'xOffset' | 'yOffset', posDef: FieldDef | undefined, spec: VLSpec, mark: string, paddingInner: unknown): unknown[] {
  const pos = ch === 'xOffset' ? 'x' : 'y'
  const size = ch === 'xOffset' ? 'width' : 'height'
  if (!posDef) return [{ signal: `-${size}/2` }, { signal: `${size}/2` }]
  if (positionalScaleType(mark, posDef) === 'band' || !posDef.tu) return [0, { signal: `bandwidth('${pos}')` }]
  const wrap = (e: string): string => `scale('${pos}', ${e})`
  const duration = timeUnitMinStepSignal(posDef.tu, wrap)
  if (!duration) return [0, { signal: `bandwidth('${pos}')` }]
  const padding = typeof paddingInner === 'number' ? paddingInner : 0.2
  const bpOffset = (bandPositionOf(spec, mark, posDef, false) ?? 0.5) - 0.5
  if (!padding) return [0, { signal: duration }]
  return [{ signal: `${padding / 2 + bpOffset} * (${duration})` }, { signal: `${1 - padding / 2 + bpOffset} * (${duration})` }]
}

function timeUnitMinStepSignal(tu: NormalTimeUnit, wrap: (expr: string) => string = (e) => e): string | null {
  const parts = getTimeUnitParts(tu.unit)
  const smallest = parts[parts.length - 1]
  if (!smallest || smallest === 'day') return null
  const step = tu.step ?? 1
  // month index is 0-based in datetime(); the base date is 2001-01-01 (non-leap)
  const d = { year: 2001, month: 0, date: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }
  const end = { ...d }
  switch (smallest) {
    case 'year': end.year += step; break
    case 'quarter': end.month += 3 * step; break
    case 'month': end.month += step; break
    case 'week': end.date += 7 * step; break
    case 'dayofyear': case 'date': end.date += step; break
    case 'hours': end.hours += step; break
    case 'minutes': end.minutes += step; break
    case 'seconds': end.seconds += step; break
    case 'milliseconds': end.milliseconds += step; break
  }
  const fmt = (x: typeof d): string => `datetime(${x.year}, ${x.month}, ${x.date}, ${x.hours}, ${x.minutes}, ${x.seconds}, ${x.milliseconds})`
  return `${wrap(fmt(end))} - ${wrap(fmt(d))}`
}

/** The Vega stack offset: `stack: true` is "zero" ("wiggle" compiles unstacked/zero as vega-lite 6.4.3 does). */
function measureStackOffset(measure: FieldDef): 'zero' | 'center' | 'normalize' {
  const st = measure.stack
  return st === 'center' || st === 'normalize' ? st : 'zero'
}

// --- scales ------------------------------------------------------------------

interface ScaleSpec {
  name: string
  type: string
  domain: unknown
  range?: unknown
  zero?: boolean
  nice?: unknown
  padding?: number
  paddingInner?: number
  reverse?: boolean
  [k: string]: unknown
}

/** scale.rangeMin / rangeMax replace the first / last end of the default range (scale/range.ts). */
function withRangeLimits(sc: ScaleSpec, user: Record<string, unknown> | undefined): void {
  if (!user || user.range !== undefined || !Array.isArray(sc.range) || sc.range.length !== 2) return
  const r = [...sc.range] as unknown[]
  if (user.rangeMin !== undefined) r[0] = user.rangeMin
  if (user.rangeMax !== undefined) r[1] = user.rangeMax
  sc.range = r
}

/** scale/parse.ts: a domainMin / domainMax that is a time (a DateTime, or of a temporal / time-unit field) is a datetime signal. */
function domainLimit(v: unknown, def: FieldDef): unknown {
  return isDateTimeValue(v) || def.type === 'temporal' || def.timeUnit ? { signal: domainValueExpr(v, def.type, def.timeUnit) } : v
}

/** The scale's `bins` property of a binned field: the bin transform's signal, or the step of pre-binned data. */
function binsProp(def: FieldDef): Record<string, unknown> | undefined {
  if (isPrebinned(def)) return typeof def.binParams!.step === 'number' ? { step: def.binParams!.step } : undefined
  return { signal: binNames(def.binParams!, def.field).signal }
}

/** scale/domain.ts: the domain of a binned field is the extent of its bins. */
function binsDomain(def: FieldDef): { signal: string } {
  const bins = binNames(def.binParams!, def.field).signal
  return { signal: `[${bins}.start, ${bins}.stop]` }
}

function positionalScaleType(mark: string, def: FieldDef): string {
  if (isDiscreteType(def.type)) {
    // a discrete positional channel only honors the two discrete positional
    // scale types; anything else falls back to the mark's natural type
    // (probed: nominal x + scale type linear/ordinal/threshold → band)
    const natural = mark === 'bar' || mark === 'rect' || mark === 'tick' || mark === 'rule' || mark === 'image' || def.nestedOffset ? 'band' : 'point'
    const user = def.scale?.type as string | undefined
    return user === 'point' || user === 'band' ? user : natural
  }
  // (an identity scale is not available to a field: vega-lite falls back to the default type)
  if (def.scale?.type && def.scale.type !== 'identity') return def.scale.type as string
  if (def.type === 'temporal') return def.tu?.utc ? 'utc' : 'time'
  return 'linear'
}

/** The spec's config object (empty when it has none). */
function specConfigOf(spec: VLSpec): Record<string, unknown> {
  return isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
}

function buildScales(spec: VLSpec, fieldsIn: FieldDef[], mark: string, orient: string, dataName: string, wReq: SizeReq, hReq: SizeReq, series: FieldDef[] = [], rawName: string = dataName): ScaleSpec[] {
  // (a `scale: null` field has no scale)
  const fields = fieldsIn.filter((f) => !f.noScale)
  const scales: ScaleSpec[] = []
  const dc: DomainCtx = { rawName, fields, mark, orient, series, cfg: scaleConfigOf(spec), specConfig: spec.config }
  const userScaleCfg = isObject(spec.config) && isObject((spec.config as Record<string, unknown>).scale)
    ? (spec.config as Record<string, unknown>).scale as Record<string, unknown>
    : undefined
  const cfgMarkType = isObject(spec.config) && isObject((spec.config as Record<string, unknown>)[mark])
    ? (spec.config as Record<string, Record<string, unknown>>)[mark]!
    : undefined
  const cfgMarkBlock = isObject(spec.config) && isObject((spec.config as Record<string, unknown>).mark)
    ? (spec.config as Record<string, Record<string, unknown>>).mark!
    : undefined
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const size = 1

  for (const [channel, def, range] of [
    ['x', xDef, [0, { signal: 'width' }]],
    ['y', yDef, [{ signal: 'height' }, 0]],
  ] as const) {
    if (!def) continue
    void size
    const type = positionalScaleType(mark, def)
    // a secondary range channel (x2/y2 field) extends the scale domain to the
    // union of both endpoints (vega-lite scale/assemble: fields union)
    const ch2 = channel === 'x' ? 'x2' : 'y2'
    const def2 = fields.find((f) => f.channel === ch2 && f.field)
    // discrete y scales run top-to-bottom; continuous y scales are reversed
    const effRange = channel === 'y' && (type === 'band' || type === 'point') ? [0, { signal: 'height' }] : range
    const sc: ScaleSpec = {
      name: channel,
      type,
      domain: def2 && !def2.bin && !def.stack
        ? unionPositionalDomain(def, def2, dataName, mark, orient, fields, dc)
        : positionalDomain(def, dataName, mark, orient, fields, dc),
      range: effRange,
    }
    // an explicit domain is the scale's domain (the secondary channel's does not widen it)
    const explicitDom = explicitDomainOf(def)
    if (explicitDom !== undefined) sc.domain = explicitDomainValue(explicitDom, def)
    // config.scale.xReverse flips every x scale (band included);
    // config.scale.continuousPadding sets vega's pixel domain padding.
    if (channel === 'x' && userScaleCfg?.xReverse === true && def.scale?.reverse == null) sc.reverse = true
    if (isContinuousScaleType(type) && userScaleCfg?.continuousPadding != null && def.scale?.padding == null) {
      sc.padding = userScaleCfg.continuousPadding as number
    }
    // (a continuous scale pads by the scale's own `padding`; the bar rule below leaves an explicit one alone)
    if (isContinuousScaleType(type) && typeof def.scale?.padding === 'number') sc.padding = def.scale.padding
    // a continuous positional scale reverses for sort:descending (a discrete
    // scale carries the order in its domain sort instead)
    if (def.sort === 'descending' && type !== 'band' && type !== 'point' && type !== 'ordinal' && type !== 'bin-ordinal') sc.reverse = true
    const measureChannel = orient === 'vertical' ? 'y' : 'x'
    // init.ts orient: a mark ranged on both axes has no orientation, so neither axis is its dimension (zero and padding follow config)
    const rangedBoth = (mark === 'bar' || mark === 'rule') && fields.some((f) => f.channel === 'x2' && f.field) && fields.some((f) => f.channel === 'y2' && f.field)
    // rect marks with two discrete channels (heatmaps) use unpadded bands
    // bar/rect marks pad the dimension channel; timeUnit dimensions use the
    // offset-encoded band layout instead and stay unpadded
    if (
      mark === 'bar' && !rangedBoth && channel !== measureChannel &&
      !def.timeUnit && def.stack == null
      && (cfgMarkType?.discreteBandSize ?? cfgMarkBlock?.discreteBandSize) !== 0
      // a continuous bar dimension pads by half a bar; band/point scales pad through paddingInner/Outer
      && isContinuousScaleType(type) && def.scale?.padding == null
    ) sc.padding = ((isObject(specConfigOf(spec).bar) ? (specConfigOf(spec).bar as Record<string, unknown>).continuousBandSize : undefined) as number | undefined) ?? 5
    if (type === 'linear' || type === 'log' || type === 'pow' || type === 'sqrt' || type === 'symlog') {
      const zeroDefault = explicitDom !== undefined ? zeroForCustomDomain(explicitDom) : type === 'log' ? false : rangedBoth ? true : zeroDefaultFor(mark, channel, orient)
      if (type !== 'log' || def.scale?.zero != null) {
        sc.zero = (def.scale?.zero as boolean | undefined) ?? zeroDefault
      }
      // vega-lite nice(): none for a binned field, an array domain, or a domainMin / domainMax
      const niceDefault = def.bin || Array.isArray(explicitDom) || def.scale?.domainMin != null || def.scale?.domainMax != null ? undefined : true
      const niceValue = (def.scale?.nice as unknown) ?? niceDefault
      if (niceValue !== undefined) sc.nice = niceValue
      if (def.bin) { const b = binsProp(def); if (b) sc.bins = b }
      // binned scales: no zero/nice; domain comes from bin start/end
      // (zero must be explicitly false — a missing key means the engine's
      // linear default kicks in and extends the domain to 0)
      if (def.bin) {
        sc.zero = false
        // (scale/properties.ts nice: a binned field gets none - the key is left out, so a layer that wants one decides)
        delete sc.nice
        delete sc.padding
      }
    } else if (type === 'band') {
      const hasOffset = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
      // vl scale/properties.ts: bar → barBandPaddingInner (0.1), tick → 0.25,
      // everything else (rect/rule/image) → rectBandPaddingInner (0); the
      // outer padding defaults to half the inner. An explicit `padding`
      // replaces both inner and outer; an explicit paddingInner carries its
      // half into the default outer.
      const cfgInner = hasOffset
        ? dc.cfg.bandWithNestedOffsetPaddingInner
        : dc.cfg.bandPaddingInner ?? (mark === 'bar' ? dc.cfg.barBandPaddingInner : mark === 'tick' ? dc.cfg.tickBandPaddingInner : dc.cfg.rectBandPaddingInner)
      const defaultInner = cfgInner as number
      const defaultOuter = hasOffset ? dc.cfg.bandWithNestedOffsetPaddingOuter as number : (dc.cfg.bandPaddingOuter as number | undefined) ?? defaultInner / 2
      const userPadding = def.scale?.padding as number | undefined
      if (userPadding != null) {
        sc.padding = userPadding
      } else {
        const userInner = def.scale?.paddingInner as number | undefined
        sc.paddingInner = userInner ?? defaultInner
        sc.paddingOuter = (def.scale?.paddingOuter as number | undefined) ?? (userInner != null ? userInner / 2 : defaultOuter)
      }
    } else if (type === 'point') {
      sc.padding = (def.scale?.padding as number | undefined) ?? dc.cfg.pointPadding
      // (scale/properties.ts parseUnitScaleProperty rates every property with the MERGED scale type: when a layer next to this one
      // makes the scale a band, this layer's paddingInner is its mark's band rule)
      POINT_BAND_PADDING.set(sc, {
        inner: (dc.cfg.bandPaddingInner ?? (mark === 'bar' ? dc.cfg.barBandPaddingInner : mark === 'tick' ? dc.cfg.tickBandPaddingInner : dc.cfg.rectBandPaddingInner)) as number,
        outer: dc.cfg.bandPaddingOuter as number | undefined,
      })
    }
    if (def.scale) {
      for (const [k, v] of Object.entries(def.scale)) {
        if (k === 'type' || k === 'zero' || k === 'nice' || k === 'padding' || k === 'paddingInner' || k === 'rangeMin' || k === 'rangeMax') continue
        // a property the scale TYPE (or channel) cannot honour is dropped, as vega-lite does
        if (!scalePropApplies(channel, sc.type, k)) continue
        // a discrete scale's explicit domain is resolved by sortedDomain (a list of values)
        if (k === 'domain') continue
        sc[k] = (k === 'domainMin' || k === 'domainMax') ? domainLimit(v, def) : v
      }
      const rMin = def.scale.rangeMin
      const rMax = def.scale.rangeMax
      if ((rMin != null || rMax != null) && Array.isArray(sc.range)) {
        const r = (sc.range as unknown[]).slice()
        if (rMin != null) r[0] = rMin
        if (rMax != null) r[r.length - 1] = rMax
        sc.range = r
      }
    }
    // (a scale assembles its explicit properties before its implicit ones - split.ts combine() - and vega applies a point scale's
    // `padding` (both paddings) in key order, so the implicit padding follows an explicit paddingOuter)
    if (type === 'point' && def.scale?.padding === undefined && sc.padding !== undefined) {
      const implicitPadding = sc.padding
      delete sc.padding
      sc.padding = implicitPadding
    }
    withRangeLimits(sc, def.scale)
    recordExplicit(sc, def.scale)
    scales.push(sc)
  }

  // size / strokeWidth / opacity: numeric ranges from config.scale (range.ts defaultRange)
  const cfgS = dc.cfg
  const widthStep = wReq.step ?? discreteStep(spec, 'width')
  const heightStep = hReq.step ?? discreteStep(spec, 'height')
  const step = Math.min(widthStep, heightStep)
  // range.ts getBinStepSignal: a binned x / y contributes the width (height) per bin to the step the size range derives from
  const binStep = (ch: 'x' | 'y'): string | undefined => {
    const d = fields.find((f) => f.channel === ch && f.field && f.bin && !f.datumOnly)
    if (!d) return undefined
    const bins = binNames(d.binParams!, d.field).signal
    return `${ch === 'x' ? 'width' : 'height'} / ((${bins}.stop - ${bins}.start) / ${bins}.step)`
  }
  const binStepX = binStep('x')
  const binStepY = binStep('y')
  const stepExpr = binStepX || binStepY ? `min(${binStepX ?? widthStep}, ${binStepY ?? heightStep})` : undefined
  const numericScale = (name: string, def: FieldDef, range: [number, number | { signal: string }], zero: boolean): ScaleSpec => {
    const discrete = isDiscreteType(def.type)
    const userType = def.scale?.type as string | undefined
    const type = discrete ? 'point' : ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold'].includes(userType ?? '') ? userType! : 'linear'
    const explicitDom = explicitDomainOf(def)
    const userDomain = explicitDom !== undefined ? explicitDomainValue(explicitDom, def) : undefined
    const sc: ScaleSpec = {
      name,
      type,
      domain: userDomain ?? (discrete ? sortedDomain(def, dataName, dc) : def.bin ? binsDomain(def) : unaggregatedDomain(def, dataName, cfgS) ?? { data: dataName, field: aggFieldName(def) }),
      range: rangeRef(def, dataName, def.scale?.range) ?? (['quantile', 'quantize', 'threshold'].includes(type) ? countRange(range[0], range[1], discreteCount(type, cfgS, explicitDom)) : range),
    }
    if (def.bin && !discrete && userDomain === undefined) { const b = binsProp(def); if (b) sc.bins = b }
    if (def.sort === 'descending') sc.reverse = true
    if (!discrete && scalePropApplies(name, type, 'zero')) sc.zero = (def.scale?.zero as boolean | undefined) ?? (explicitDom !== undefined && isContinuousScaleType(type) ? zeroForCustomDomain(explicitDom) : type === 'log' ? false : zero)
    for (const [k, v] of Object.entries(def.scale ?? {})) {
      if (k === 'type' || k === 'domain' || k === 'range' || k === 'zero' || k === 'rangeMin' || k === 'rangeMax' || !scalePropApplies(name, type, k)) continue
      sc[k] = v
    }
    withRangeLimits(sc, def.scale)
    recordExplicit(sc, def.scale)
    return sc
  }
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  // (properties.ts zero(): a size scale includes zero unless it discretizes a continuous domain)
  if (sizeDef) scales.push(numericScale('size', sizeDef, sizeRange(mark, cfgS, step, stepExpr), !['quantile', 'quantize', 'threshold'].includes(String(sizeDef.scale?.type))))
  const strokeWidthDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  if (strokeWidthDef) scales.push(numericScale('strokeWidth', strokeWidthDef, [cfgS.minStrokeWidth, cfgS.maxStrokeWidth], false))
  const opacityDefS = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityDefS) scales.push(numericScale('opacity', opacityDefS, [cfgS.minOpacity, cfgS.maxOpacity], false))
  // angle: a linear scale to degrees (range.ts defaultRange: [0, 360])
  const angleDefS = fields.find((f) => f.channel === 'angle' && f.field && !f.datumOnly && !f.noScale)
  if (angleDefS) scales.push(numericScale('angle', angleDefS, [0, 360], false))
  // xOffset/yOffset scales: discrete offsets use a band, continuous ones a
  // linear scale over the same band-width range (vega-lite probes).
  for (const ch of ['xOffset', 'yOffset'] as const) {
    const offDef = fields.find((f) => f.channel === ch && f.field)
    if (offDef) {
      const dimChannel = ch === 'xOffset' ? 'x' : 'y'
      if (isDiscreteType(offDef.type)) {
        // scale/type.ts defaultType + properties.ts paddingOuter: a rect-based mark offsets within a band; any other mark
        // offsets along a point scale whose outer padding is half a step (so the points align with the band centres)
        const offsetBand = ['bar', 'rect', 'image', 'rule', 'tick'].includes(mark)
        scales.push(offsetBand
          ? {
              name: ch,
              type: 'band',
              domain: sortedDomain(offDef, dataName, dc),
              range: offsetRange(ch, fields.find((f) => f.channel === dimChannel && f.field), spec, mark, dc.cfg.bandWithNestedOffsetPaddingInner),
              // (properties.ts paddingInner / paddingOuter: a padding of the scale replaces both defaults, an explicit inner / outer one its own)
              ...offsetPaddings(offDef, 'band', dc.cfg.offsetBandPaddingInner, dc.cfg.offsetBandPaddingOuter),
            }
          : {
              name: ch,
              type: 'point',
              domain: sortedDomain(offDef, dataName, dc),
              range: [0, { signal: `bandwidth('${dimChannel}')` }],
              ...offsetPaddings(offDef, 'point', undefined, 0.5),
            })
      } else {
        scales.push({
          name: ch,
          type: 'linear',
          domain: offDef.scale?.domain ?? { data: dataName, field: aggFieldName(offDef) },
          range: [0, { signal: `bandwidth('${dimChannel}')` }],
          zero: false,
          ...(offDef.scale?.type != null ? { type: String(offDef.scale.type) } : {}),
        })
      }
    }
  }

  // time scale (an animation's frames): a band scale, one step per frame (vega-lite scale/range.ts)
  const timeDefS = fields.find((f) => f.channel === 'time' && f.field)
  if (timeDefS) {
    scales.push({
      name: 'time',
      type: 'band',
      domain: { data: dataName, field: aggFieldName(timeDefS), sort: true },
      range: timeScaleRange(userScaleCfg?.framesPerSecond),
    })
  }

  // shape scale
  const shapeDefS = fields.find((f) => f.channel === 'shape' && f.field && f.type !== 'geojson')
  if (shapeDefS) {
    scales.push({
      name: 'shape',
      type: 'ordinal',
      domain: sortedDomain(shapeDefS, dataName, dc),
      range: rangeRef(shapeDefS, dataName, shapeDefS.scale?.range) ?? 'symbol',
    })
  }

  // stroke dash scale: an ordinal scale over the default dash patterns (scale/range.ts STROKEDASH)
  const strokeDashDefS = fields.find((f) => f.channel === 'strokeDash' && f.field)
  if (strokeDashDefS) {
    scales.push({
      name: 'strokeDash',
      type: 'ordinal',
      domain: sortedDomain(strokeDashDefS, dataName, dc),
      range: rangeRef(strokeDashDefS, dataName, strokeDashDefS.scale?.range) ?? [[1, 0], [4, 2], [2, 1], [1, 1], [1, 2, 4, 2]],
    })
  }

  // theta and radius (scale/type.ts, range.ts, properties.ts zero, domain.ts): a polar position scale is linear (or the type asked for) over
  // [0, 2pi] / [0, min(width, height) / 2]; a discrete field is a band scale on an arc and a point scale under a label, a time unit a time scale;
  // the stacked channel spans its start and end
  const polarStackS = polarStackOf(fields, mark)
  for (const channel of ['theta', 'radius'] as const) {
    const polarDef = fields.find((f) => f.channel === channel && f.field && !f.datumOnly && !f.noScale)
    if (!polarDef || (mark !== 'arc' && mark !== 'text')) continue
    const sc = numericScale(channel, polarDef, channel === 'theta' ? [0, 6.283185307179586] : [0, { signal: 'min(width,height)/2' }], !polarDef.bin)
    const asked = polarDef.scale?.type as string | undefined
    if (isDiscreteType(polarDef.type)) {
      sc.type = asked === 'band' || asked === 'point' ? asked : mark === 'arc' ? 'band' : 'point'
      // (a discrete scale is ordered by its domain's sort, not reversed)
      delete sc.reverse
    } else if (polarDef.type === 'temporal' && asked === undefined) {
      sc.type = polarDef.tu?.utc ? 'utc' : 'time'
      delete sc.zero
    }
    if (polarStackS?.fieldChannel === channel && explicitDomainOf(polarDef) === undefined) sc.domain = { data: dataName, fields: [`${polarStackS.field}_start`, `${polarStackS.field}_end`] }
    scales.push(sc)
  }

  // color scale
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const numericAggregate = colorDef?.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)
  if (colorDef) {
    if (isDiscreteType(colorDef.type) && !numericAggregate) {
      // nominal colours are categorical; an ORDINAL field gets vega-lite's sequential
      // 'ordinal' ramp, interpolated in hcl
      const ordinalColor = colorDef.type === 'ordinal'
      scales.push({
        name: 'color',
        type: 'ordinal',
        domain: sortedDomain(colorDef, dataName, dc),
        range: rangeRef(colorDef, dataName, colorDef.scale?.range) ?? (colorDef.scale?.scheme != null ? schemeRange(colorDef.scale.scheme) : ordinalColor ? 'ordinal' : 'category'),
        ...(ordinalColor ? { interpolate: 'hcl' } : {}),
      })
    } else {
      const cs = colorDef.scale ?? {}
      // scale/type.ts defaultType: a binned quantitative colour is a bin-ordinal scale over the bins (no domain of its own)
      const binOrdinalColor = colorDef.bin && colorDef.type === 'quantitative' && (cs.type === undefined || cs.type === 'bin-ordinal') && !numericAggregate
      if (binOrdinalColor) {
        scales.push({
          name: 'color',
          type: 'bin-ordinal',
          domain: undefined,
          range: cs.range != null ? rangeRef(colorDef, dataName, cs.range) : cs.scheme != null ? schemeRange(cs.scheme) : mark === 'rect' || mark === 'geoshape' ? 'heatmap' : 'ramp',
          bins: { signal: binNames(colorDef.binParams!, colorDef.field).signal },
          interpolate: 'hcl',
          ...(cs.reverse !== undefined ? { reverse: Boolean(cs.reverse) } : colorDef.sort === 'descending' ? { reverse: true } : {}),
        })
      } else {
      // a temporal colour field is a time scale (utc for a utc time unit), like vega-lite's default type
      // (vega-lite falls back to linear when a time scale is asked of a non-temporal field)
      const colorScaleType = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold', ...(colorDef.type === 'temporal' ? ['time', 'utc'] : [])].includes(cs.type as string)
        ? cs.type as string
        : colorDef.type === 'temporal' ? (colorDef.tu?.utc ? 'utc' : 'time') : 'linear'
      scales.push({
        name: 'color',
        type: colorScaleType,
        domain: explicitDomainOf(colorDef) !== undefined
          ? explicitDomainValue(explicitDomainOf(colorDef), colorDef)
          // domain.ts: a time unit with a band end spans start..end
          : colorDef.tu && colorDef.type === 'temporal' && ['time', 'utc'].includes(colorScaleType) && bandPositionOf(spec, mark, colorDef, false) !== undefined
            ? { data: dataName, fields: [timeUnitField(colorDef), `${timeUnitField(colorDef)}_end`] }
            : { data: dataName, field: aggFieldName(colorDef) },
        // vega-lite's quantitative color range: 'heatmap' scheme for
        // rect/geoshape marks, a ramp otherwise; a domainMid makes it
        // diverging; an explicit scheme replaces the range (probed)
        ...(cs.range != null
          ? { range: rangeRef(colorDef, dataName, cs.range) }
          : cs.scheme != null
            ? { range: schemeRange(cs.scheme) }
            : { range: cs.domainMid != null ? 'diverging' : mark === 'rect' || mark === 'geoshape' ? 'heatmap' : 'ramp' }),
        // vega-lite sets the colorspace for continuous color scales (probed:
        // interpolate hcl on ramp/scheme/diverging alike)
        interpolate: 'hcl',
        ...(cs.reverse !== undefined
          ? { reverse: Boolean(cs.reverse) }
          : colorDef.sort === 'descending' ? { reverse: true } : {}),
        ...(cs.domainMin !== undefined && scalePropApplies('color', colorScaleType, 'domainMin') ? { domainMin: cs.domainMin } : {}),
        ...(cs.domainMax !== undefined && scalePropApplies('color', colorScaleType, 'domainMax') ? { domainMax: cs.domainMax } : {}),
        ...(cs.domainMid !== undefined && scalePropApplies('color', colorScaleType, 'domainMid') ? { domainMid: cs.domainMid } : {}),
        ...(cs.bins !== undefined && scalePropApplies('color', colorScaleType, 'bins') ? { bins: cs.bins } : {}),
        ...(!scalePropApplies('color', colorScaleType, 'zero')
          ? {}
          : { zero: (cs.zero as boolean | undefined) ?? (explicitDomainOf(colorDef) !== undefined && isContinuousScaleType(colorScaleType) ? zeroForCustomDomain(explicitDomainOf(colorDef)) : false) }),
        // (scale/domain.ts: a binned field's continuous scale spans the bins; it carries the bins too)
        ...(colorDef.bin && colorDef.type === 'quantitative' && explicitDomainOf(colorDef) === undefined ? { bins: { signal: binNames(colorDef.binParams!, colorDef.field).signal } } : {}),
      })
      if (colorDef.bin && colorDef.type === 'quantitative' && explicitDomainOf(colorDef) === undefined) {
        const last = scales[scales.length - 1]!
        last.domain = { signal: `[${binNames(colorDef.binParams!, colorDef.field).signal}.start, ${binNames(colorDef.binParams!, colorDef.field).signal}.stop]` }
      }
      }
    }
  }

  // the user's scale properties on the non-positional channels count as explicit too
  for (const f of fields) {
    if (!f.scale || f.channel === 'x' || f.channel === 'y') continue
    const sc = scales.find((x) => x.name === f.channel)
    if (sc && !EXPLICIT_SCALE_PROPS.has(sc)) recordExplicit(sc, f.scale)
  }
  return scales
}

const CONTINUOUS_TO_CONTINUOUS = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc'])
const CONTINUOUS_DOMAIN = new Set([...CONTINUOUS_TO_CONTINUOUS, 'quantile', 'quantize', 'threshold'])

/**
 * vega-lite `scaleTypeSupportProperty` + `channelScalePropertyIncompatability`: whether a
 * user scale property means anything for this channel and scale type. An
 * inapplicable one is dropped (vega-lite warns), never forwarded: real vega
 * rejects e.g. `exponent` on a linear scale.
 */
function scalePropApplies(channel: string, type: string, prop: string): boolean {
  switch (prop) {
    case 'type': case 'domain': case 'reverse': case 'range':
      return true
    case 'scheme': case 'interpolate': case 'domainMid':
      if (channel !== 'color' && channel !== 'fill' && channel !== 'stroke') return false
      return prop === 'domainMid' ? CONTINUOUS_TO_CONTINUOUS.has(type) : !['point', 'band', 'identity'].includes(type)
    case 'bins':
      return !['point', 'band', 'identity', 'ordinal'].includes(type)
    case 'round':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'band' || type === 'point'
    case 'padding':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'point' || type === 'band'
    case 'paddingOuter': case 'align':
      return type === 'point' || type === 'band'
    case 'paddingInner':
      return type === 'band'
    case 'domainMax': case 'domainMin': case 'domainRaw': case 'clamp':
      return CONTINUOUS_TO_CONTINUOUS.has(type)
    case 'nice':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'quantize' || type === 'threshold'
    case 'exponent': return type === 'pow'
    case 'base': return type === 'log'
    case 'constant': return type === 'symlog'
    case 'zero':
      return CONTINUOUS_DOMAIN.has(type) && !['log', 'time', 'utc', 'threshold', 'quantile'].includes(type)
    default:
      return true
  }
}

/** A scale `scheme` (a name or {name, extent, count}) as a Vega range scheme object. */
function rangeRef(def: FieldDef, dataName: string, range: unknown): unknown {
  // scale/range.ts: a range given as a field ({field}) is read from the main data, sorted by the scale's own field
  return isObject(range) && typeof range.field === 'string' ? { data: dataName, field: range.field, sort: { op: 'min', field: aggFieldName(def) } } : range
}

function schemeRange(scheme: unknown): Record<string, unknown> {
  if (isObject(scheme)) {
    const { name, ...rest } = scheme
    return { scheme: name, ...rest }
  }
  return { scheme }
}

/** A domain over the values of several defs: one data reference each, or a literal list for a datum. */
function unionDomain(defs: FieldDef[], dataName: string): unknown {
  const entries = defs.map((d) => (d.datumOnly ? datumDomain(d) : { data: dataName, field: aggFieldName(d) }))
  if (entries.every((e) => !Array.isArray(e) && 'field' in (e as object))) return { data: dataName, fields: (entries as Array<{ field: string }>).map((e) => e.field) }
  return { fields: entries }
}

/**
 * scale/domain.ts parseDomainForChannel: the domain of a position with a secondary channel is the union of the two channels' domains
 * (mergeDomains). A discrete position's is sorted (domainSort), and so is the secondary's, which has no sort of its own.
 */
function unionPositionalDomain(def: FieldDef, def2: FieldDef, dataName: string, mark: string, orient: string, fields: FieldDef[], dc: DomainCtx): unknown {
  const plain = unionDomain([def, def2], dataName)
  if (def.datumOnly || def2.datumOnly || !isDiscreteType(def.type)) return plain
  const first = positionalDomain(def, dataName, mark, orient, fields, dc)
  // (only the default ascending sort is unioned here: a sort by a field reads the raw rows, which the secondary channel does not)
  if (!isDataRef(first) || typeof first.field !== 'string' || first.sort !== true) return plain
  // (the secondary channel has no sort of its own: domain.ts domainSort reads the channel's own field def)
  return mergeDomains([first, { data: dataName, field: aggFieldName(def2) }])
}

function zeroDefaultFor(mark: string, channel: string, orient: string): boolean {
  // vega-lite scale/properties.ts zero(): bar/area/line/trail opt out on their
  // dimension axis; everything else (including their measure axis) falls
  // through to config.zero (true) for continuous positional scales.
  if (mark === 'bar' || mark === 'area' || mark === 'line' || mark === 'trail') {
    if ((orient === 'horizontal' && channel === 'y') || (orient === 'vertical' && channel === 'x')) return false
  }
  return true
}

function positionalDomain(def: FieldDef, dataName: string, mark: string, orient: string, fields: FieldDef[] | undefined, dc: DomainCtx): unknown {
  if (def.datumOnly) return datumDomain(def)
  const unagg = unaggregatedDomain(def, dataName, dc.cfg)
  if (unagg !== undefined) return unagg
  if (def.bin && binDiscrete(def)) return sortedDomain(def, dataName, dc)
  if (def.bin && isPrebinned(def)) {
    const bn = binNames(def.binParams!, def.field)
    return { data: dataName, fields: [bn.start, bn.end] }
  }
  if (def.bin) {
    const sig = binNames(def.binParams!, def.field).signal
    return { signal: `[${sig}.start, ${sig}.stop]` }
  }
  if (def.timeUnit && !isDiscreteType(def.type) && def.type === 'temporal' && ['time', 'utc'].includes(positionalScaleType(mark, def))) {
    // domain.ts: a time unit with a band end spans start..end (the offsetted rect fields off the middle of a rect's band)
    const hasSecondary = (fields ?? []).some((g) => g.channel === `${def.channel}2`)
    const bp = bandPositionOf({ config: dc.specConfig } as VLSpec, mark, def, hasSecondary)
    if (bp !== undefined) {
      const offsetted = RECT_BASED_MARKS.has(mark) && bp !== 0.5 && (def.channel === 'x' || def.channel === 'y')
      return { data: dataName, fields: [timeUnitField(def) + (offsetted ? '_offsetted_rect_start' : ''), timeUnitField(def) + (offsetted ? '_offsetted_rect_end' : '_end')] }
    }
  }
  // a stack property on a discrete channel is inert (vega-lite ignores it)
  if (def.stack === 'normalize' && def.type === 'quantitative' && !def.bin) return [0, 1]
  if (isDiscreteType(def.type)) return sortedDomain(def, dataName, dc)
  const measureChannel = (mark === 'bar' || mark === 'area')
    ? (potentialStackChannel(mark, orient, fields ?? []) ?? (orient === 'vertical' ? 'y' : 'x'))
    : orient === 'vertical' ? 'y' : 'x'
  const stacked = isStacked(def, mark, orient, fields)
  // (an explicit stack names its own channel as the measure, whatever the orientation of the mark)
  if (stacked && (def.channel === measureChannel || (def.stack != null && def.stack !== false))) {
    return { data: dataName, fields: [`${aggFieldName(def)}_start`, `${aggFieldName(def)}_end`] }
  }
  return { data: dataName, field: aggFieldName(def) }
}

/**
 * vega-lite stack.ts `potentialStackedChannel` (cartesian x/y): the encoding,
 * not only the mark's orient, decides which channel is the stack measure.
 * Notably a bar with orient:horizontal over a nominal x and quantitative y
 * still stacks y upstream.
 */
function potentialStackChannel(mark: string, orient: string, fields: FieldDef[]): 'x' | 'y' | undefined {
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const isUQ = (f: FieldDef | undefined): f is FieldDef =>
    f != null && f.field != null && f.type === 'quantitative' && !f.bin
  const cartesian = mark === 'bar' || mark === 'area'
  if (xDef?.field != null && yDef?.field != null) {
    if (isUQ(xDef) && isUQ(yDef)) {
      if (xDef.stack) return 'x'
      if (yDef.stack) return 'y'
      if (!!xDef.aggregate !== !!yDef.aggregate) return xDef.aggregate ? 'x' : 'y'
      if (cartesian) return orient === 'horizontal' ? 'x' : 'y'
    } else if (isUQ(xDef)) {
      return 'x'
    } else if (isUQ(yDef)) {
      return 'y'
    }
  } else if (isUQ(xDef)) {
    if (cartesian && orient === 'vertical') return undefined
    return 'x'
  } else if (isUQ(yDef)) {
    if (cartesian && orient === 'horizontal') return undefined
    return 'y'
  }
  return undefined
}

function isStacked(def: FieldDef, mark: string, orient: string, allFields?: FieldDef[]): boolean {
  // an explicit stack applies to any mark (the sweep's point stack cases);
  // bar/area additionally stack by default.
  const explicit = def.stack != null && def.stack !== false && def.stack !== 'wiggle'
  if (mark !== 'bar' && mark !== 'area' && !explicit) return false
  const measureChannel = explicit ? def.channel : potentialStackChannel(mark, orient, allFields ?? [])
  if (def.channel !== measureChannel) return false
  if (def.type !== 'quantitative' || def.bin || def.datumOnly) return false
  // explicit stack false/null opts out; 'wiggle' compiles to a plain
  // unstacked measure (vega's Stack transform only supports zero/center/
  // normalize)
  if (def.stack === false || def.stack === null || def.stack === 'wiggle') return false
  if (allFields) {
    // vega-lite's stack law (stack.ts): an aggregate anywhere in the
    // encoding with no *unaggregated* stack-by series disables stacking;
    // ranged marks never stack.
    const dimChannel = orient === 'vertical' ? 'x' : 'y'
    const groupFields = new Set(
      allFields
        .filter((f) => f.channel === dimChannel || f.channel === 'xOffset' || f.channel === 'yOffset')
        .map((f) => f.field),
    )
    const positional = new Set(['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'radius', 'row', 'column', 'facet'])
    const stackBy = allFields.filter(
      (f) => f.field && !f.datumOnly && !positional.has(f.channel) && !f.aggregate && !groupFields.has(f.field),
    )
    if (allFields.some((f) => f.aggregate) && stackBy.length === 0) return false
    // (stack.ts: a ranged STACK field - its own secondary channel - never stacks; the other axis may be ranged)
    if (allFields.some((f) => f.channel === `${def.channel}2` && f.field)) return false
  }
  return true
}

/** What a discrete scale domain needs to resolve a sort definition. */
interface DomainCtx {
  /** the spec's config (band positions read the mark config) */
  specConfig?: unknown
  /** the raw (pre-aggregate) dataset sort-by-field/array domains read */
  rawName: string
  fields: FieldDef[]
  mark: string
  orient: string
  series: FieldDef[]
  cfg: ScaleCfg
}

/** The domain of an aggregated field that also tracks its unaggregated extent (min/max of the raw values). */
function unaggregatedDomain(def: FieldDef, dataName: string, cfg: ScaleCfg): unknown {
  return usesUnaggregatedDomain(def, cfg) ? { data: dataName, fields: [genName('min', def.field), genName('max', def.field)] } : undefined
}

/**
 * vega-lite scale/domain.ts parseSingleChannelDomain: a `domain` that is not 'unaggregated' (nor a {param} /
 * {unionWith} object, which validation refuses) is the scale's domain as written -- an array, or a bare string /
 * number / `true` that vega itself then refuses (`Undefined data set name`).
 */
function explicitDomainOf(def: FieldDef): unknown | undefined {
  const d = def.scale?.domain
  if (Array.isArray(d)) return d
  // (a signal is the domain; an `{expr}` is one once expression references become signals - init.ts replaceExprRef)
  if (isObject(d) && typeof d.signal === 'string') return { signal: d.signal }
  if (isObject(d) && typeof d.expr === 'string') return { signal: d.expr }
  if (d && d !== 'unaggregated' && !isObject(d)) return d
  return undefined
}

/**
 * The emitted form of an explicit domain: an array of a temporal field (or one with a time unit) is a list of
 * `{data: datetime(...)}` signals under `fields`; any other array keeps its values, an `{expr}` becoming a signal;
 * a scalar is passed through.
 */
function explicitDomainValue(explicit: unknown, def: FieldDef): unknown {
  if (!Array.isArray(explicit)) return explicit
  const unit = def.tu?.unit
  if (def.type === 'temporal' || unit !== undefined) {
    return { fields: explicit.map((v) => ({ signal: `{data: ${domainValueExpr(v, def.type, unit)}}` })) }
  }
  return explicit.map((v) => (isObject(v) && typeof v.expr === 'string' ? { signal: v.expr } : v))
}

/** vega-lite scale/properties.ts zero(): with a custom domain only one that spans 0 keeps zero. */
function zeroForCustomDomain(explicit: unknown): boolean {
  if (!Array.isArray(explicit) || explicit.length === 0) return false
  const first = explicit[0]
  const last = explicit[explicit.length - 1]
  return typeof first === 'number' && first <= 0 && typeof last === 'number' && last >= 0
}

/**
 * vega-lite `domainSort` for a discrete scale: the field's domain read from the
 * main table (ascending/descending) or from the RAW table sorted by an
 * aggregate of another field (sort by field/encoding) or by the sort-array
 * index. `sort: null` leaves the domain in data order.
 */
function sortedDomain(def: FieldDef, dataName: string, dc: DomainCtx): unknown {
  if (def.datumOnly) return datumDomain(def)
  const explicit = explicitDomainOf(def)
  if (explicit !== undefined) return explicitDomainValue(explicit, def)
  const field = aggFieldName(def)
  const main = { data: dataName, field }
  const sort = def.sort
  if (sort === null) return main
  // domain.ts: the categories of a binned field are the bins' texts, in the order of their starts
  if (binDiscrete(def) && (sort === undefined || sort === 'ascending' || sort === 'descending')) {
    return { ...main, sort: { field: binNames(def.binParams!, def.field).start, op: 'min', ...(sort === 'descending' ? { order: 'descending' } : {}) } }
  }
  if (sort === undefined || sort === 'ascending') return { ...main, sort: true }
  // vega-lite assembles {op: 'min', field: <the domain field>, order} as just {order}
  if (sort === 'descending') return { ...main, sort: { order: 'descending' } }
  const raw = { data: dc.rawName, field }
  if (Array.isArray(sort)) return { ...raw, sort: { op: 'min', field: sortIndexName(def), order: 'ascending' } }
  if (isObject(sort)) {
    // stacked measure: a sort by anything that is not a stack dimension defaults to 'sum'
    const stackedDef = dc.fields.find((f) => isStacked(f, dc.mark, dc.orient, dc.fields))
    const stacked = stackedDef !== undefined
    const dims = new Set<string>([
      ...dc.series.map((f) => f.field),
      ...dc.fields.filter((f) => f !== stackedDef && (f.channel === 'x' || f.channel === 'y' || f.channel === 'xOffset' || f.channel === 'yOffset')).map((f) => f.field),
    ])
    const order = (sort.order as string | null | undefined) ?? undefined
    if (sort.encoding !== undefined) {
      const target = dc.fields.find((f) => f.channel === sort.encoding)
      if (!target) throw new VLCompileError(`sort by encoding "${String(sort.encoding)}": that channel is not encoded`)
      if (target.argAgg) throw new VLCompileError('sorting by an argmax/argmin encoding is not supported')
      const isStackedMeasure = stacked && !dims.has(target.field)
      const op = target.aggregate ?? (isStackedMeasure ? 'sum' : 'min')
      return {
        ...raw,
        sort: { op, ...(target.aggregate === 'count' || target.field === '__count' ? {} : { field: target.field }), ...(order ? { order } : {}) },
      }
    }
    if (sort.field !== undefined || sort.op !== undefined) {
      const sortField = sort.field !== undefined ? flatField(String(sort.field)).key : undefined
      const isStackedMeasure = stacked && !(sortField !== undefined && dims.has(sortField))
      const op = (sort.op as string | undefined) ?? (isStackedMeasure ? 'sum' : 'min')
      return { ...raw, sort: { op, ...(sortField !== undefined ? { field: sortField } : {}), ...(order ? { order } : {}) } }
    }
    // {order} alone is neither a field nor an encoding sort: vega-lite leaves the domain unsorted
    return main
  }
  throw new VLCompileError(`unsupported sort ${JSON.stringify(sort)}`)
}

// --- axis label angle defaults (vega-lite getLabelAngle + defaultLabel*) ---

function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360
}

/** vega-lite `defaultLabelBaseline(angle, orient, channel)`. */
function defaultLabelBaseline(angle: number, orient: string, channel: string, alwaysIncludeMiddle = false): string | null {
  if (channel === 'x') {
    if ((45 < angle && angle < 135) || (225 < angle && angle < 315)) return 'middle'
    return (angle <= 45 || 315 <= angle) === (orient === 'top') ? 'bottom' : 'top'
  }
  if (angle <= 45 || 315 <= angle || (135 <= angle && angle <= 225)) return alwaysIncludeMiddle ? 'middle' : null
  return (45 <= angle && angle <= 135) === (orient === 'left') ? 'top' : 'bottom'
}

/** vega-lite `defaultLabelAlign(angle, orient, channel)`. */
function defaultLabelAlign(angle: number, orient: string, channel: string): string | null {
  const isX = channel === 'x'
  const startAngle = isX ? 0 : 90
  const mainOrient = isX ? 'bottom' : 'left'
  if ((angle + startAngle) % 180 === 0) return isX ? null : 'center'
  return ((startAngle < angle && angle < 180 + startAngle) === (orient === mainOrient)) ? 'left' : 'right'
}

/** vega-lite `defaultLabelBaseline` for an angle that is a signal (`labelAngle: {expr}`). */
function defaultLabelBaselineSignal(angle: { signal: string }, orient: string, channel: string): { signal: string } {
  const a = `(((${angle.signal} % 360) + 360) % 360)`
  if (channel === 'x') {
    return { signal: `(45 < ${a} && ${a} < 135) || (225 < ${a} && ${a} < 315) ? "middle" :(${a} <= 45 || 315 <= ${a}) === ${orient === 'top'} ? "bottom" : "top"` }
  }
  return { signal: `${a} <= 45 || 315 <= ${a} || (135 <= ${a} && ${a} <= 225) ? null : (45 <= ${a} && ${a} <= 135) === ${orient === 'left'} ? "top" : "bottom"` }
}

/** vega-lite `defaultLabelAlign` for an angle that is a signal. */
function defaultLabelAlignSignal(angle: { signal: string }, orient: string, channel: string): { signal: string } {
  const isX = channel === 'x'
  const startAngle = isX ? 0 : 90
  const mainOrient = isX ? 'bottom' : 'left'
  const a = `(((${angle.signal} % 360) + 360) % 360)`
  return { signal: `(${startAngle ? `(${a} + 90)` : a} % 180 === 0) ? ${isX ? null : '"center"'} :(${startAngle} < ${a} && ${a} < ${180 + startAngle}) === ${orient === mainOrient} ? "left" : "right"` }
}

// --- axes --------------------------------------------------------------------

/** The mark whose axis rules apply: an image mark is laid out as a rect but is not one. */
const axisMark = (markRaw: unknown, mark: string): string => (isObject(markRaw) && markRaw.$image ? 'image' : mark)

function buildAxes(fields: FieldDef[], mark: string, scales: ScaleSpec[], scaleName?: string, gridScaleOverride?: string, config?: Record<string, unknown>): Record<string, unknown>[] {
  // Vega-lite emits every grid axis before every label axis (paint order:
  // grids under the domain/labels). Emitting per-channel [grid, label] leaves a
  // later channel's grid line above an earlier channel's domain line.
  const gridAxes: Record<string, unknown>[] = []
  const labelAxes: Record<string, unknown>[] = []
  const scaleByName = new Map(scales.map((s) => [s.name, s]))

  // x axes come before y axes whatever the encoding order (vega-lite assembles x then y)
  for (const def of [...fields].sort((a, b) => Number(a.channel !== 'x') - Number(b.channel !== 'x'))) {
    if (!POSITIONAL.has(def.channel) || (def.channel !== 'x' && def.channel !== 'y')) continue
    if (def.axis === null) continue
    // a rect over a discrete field draws its axis above the cells (axis/properties.ts defaultZindex)
    const axisZindex = mark === 'rect' && (isDiscreteType(def.type) || (def.type === 'quantitative' && def.bin)) ? 1 : 0
    // config.axis seeds both channels; config.axisX/axisY override it; the
    // channel's own axis definition wins last (vega-lite axis config cascade).
    const cfgAxis = isObject(config?.axis) ? (config!.axis as Record<string, unknown>) : {}
    const cfgChannelAxis = isObject(config?.[def.channel === 'x' ? 'axisX' : 'axisY'])
      ? (config![def.channel === 'x' ? 'axisX' : 'axisY'] as Record<string, unknown>)
      : {}
    const sc = scaleByName.get(scaleName ?? def.channel)!
    const axisBand = sc.type === 'band' && isObject(config?.axisBand)
      ? (config!.axisBand as Record<string, unknown>)
      : undefined
    // config.axis seeds both channels; config.axisX/axisY override it;
    // config.axisBand overrides both for band scales; the channel's own axis
    // definition wins last (vega-lite axis config cascade).
    const userAxis: Record<string, unknown> | undefined = {
      ...cfgAxis,
      ...cfgChannelAxis,
      ...(axisBand ?? {}),
      ...(def.axis ?? {}),
    }
    if (userAxis.disable === true) continue
    // the computed zindex is explicit in vega-lite's axis, so a config zindex (Vega config only) never replaces it
    // (only the axis' own zindex and config.axisBand's, which vega-lite merges for band scales, count)
    if ((!isObject(def.axis) || (def.axis as Record<string, unknown>).zindex === undefined) && axisBand?.zindex === undefined) delete userAxis.zindex
    const configTitleSupplied = (cfgAxis.title !== undefined || cfgChannelAxis.title !== undefined)
      && (!isObject(def.axis) || (def.axis as Record<string, unknown>).title === undefined)
    if (configTitleSupplied) delete (userAxis as Record<string, unknown>).title
    // Vega's axisBand block supplies the band tickOffset even though
    // config.axis/axisX/axisY are ignored for it. An explicit axis wins.
    if (sc.type === 'band' && (def.axis == null || (def.axis as Record<string, unknown>).tickOffset === undefined)) {
      if (axisBand?.tickOffset !== undefined) userAxis.tickOffset = axisBand.tickOffset
      else delete (userAxis as Record<string, unknown>).tickOffset
    }
    // vega-lite does not inherit config.axis/axisBand values into compiled axes.
    if (def.axis == null || (def.axis as Record<string, unknown>).values === undefined) {
      delete (userAxis as Record<string, unknown>).values
    }
    const grid = (userAxis?.grid as boolean | undefined) ?? (isContinuousScaleType(sc.type) && !def.bin && !def.datumOnly)
    const tickCountSignal = def.channel === 'x' ? { signal: 'ceil(width/40)' } : { signal: 'ceil(height/40)' }
    // vega-lite suppresses the default tickCount for these cyclic/sub-day
    // time units (the axis falls back to tickMinStep/vega's default count).
    const suppressTickCount = def.timeUnit != null && ['month', 'hours', 'day', 'quarter'].includes(String(def.timeUnit))
    const orientSide = typeof userAxis?.orient === 'string' ? userAxis.orient : def.channel === 'x' ? 'bottom' : 'left'
    const gridScale = def.channel === 'x'
      ? (gridScaleOverride ?? (scaleByName.get('y') ? 'y' : undefined))
      : scaleByName.get('x')
        ? 'x'
        : scaleByName.get('x') === undefined && scales.some((s) => s.name.endsWith('_y'))
          ? undefined
          : undefined

    if (grid) {
      // gridScale extends the grid lines across the OTHER dimension; with no
      // other scale the grid axis stands alone (vega-lite emits it unchanged)
      const gridAxis: Record<string, unknown> = {
        scale: def.channel,
        orient: orientSide,
        ...(gridScale ? { gridScale } : {}),
        grid: true,
        // (axis/properties.ts defaultTickCount: a discrete scale has none, nor does a log one)
        ...(suppressTickCount || ['band', 'point', 'ordinal', 'bin-ordinal', 'log'].includes(sc.type) ? {} : { tickCount: tickCountSignal }),
        domain: false,
        labels: false,
        aria: false,
        maxExtent: 0,
        minExtent: 0,
        ticks: false,
        zindex: axisZindex,
      }
      if (def.tu) {
        const stepExpr = timeUnitMinStepSignal(def.tu)
        if (stepExpr) gridAxis.tickMinStep = { signal: stepExpr }
      }
      // the user's grid-affecting props land on the grid axis too (upstream
      // merges grid+labels into one axis; ours splits them)
      if (userAxis) {
        for (const gk of ['gridColor', 'gridWidth', 'gridDash', 'gridOpacity', 'gridCap', 'tickOffset', 'translate', 'tickBand', 'tickExtra', 'tickCount', 'tickMinStep', 'tickRound', 'values', 'zindex', 'bandPosition'] as const) {
          if ((userAxis as Record<string, unknown>)[gk] !== undefined) gridAxis[gk] = (userAxis as Record<string, unknown>)[gk]
        }
      }
      // axis/properties.ts defaultTickMinStep: an integer format ('d') ticks at whole numbers only
      if (userAxis?.format === 'd') gridAxis.tickMinStep = userAxis.tickMinStep ?? 1
      gridAxes.push(gridAxis)
    }

    const title = configTitleSupplied ? null : axisTitle(def, userAxis, fields)
    const labelAxis: Record<string, unknown> = {
      scale: scaleName ?? def.channel,
      orient: orientSide,
      grid: false,
      zindex: axisZindex,
    }
    // assemble.ts: `titleString ? {title} : {}` - an empty title is no title
    if (title) labelAxis.title = title
    if (isContinuousScaleType(sc.type)) {
      if (def.channel === 'x') labelAxis.labelFlush = true
      // log axes carry no explicit tickCount — vega's axis defaults to 10,
      // which drives the log label filter (3/30/300 stay visible)
      if (sc.type !== 'log' && !suppressTickCount) labelAxis.tickCount = def.bin && !isPrebinned(def)
        ? { signal: def.channel === 'x' ? 'ceil(width/10)' : 'ceil(height/10)' }
        : tickCountSignal
      if (def.timeUnit) {
        labelAxis.format = { signal: timeUnitFormatSignal(def.timeUnit) }
        labelAxis.formatType = 'time'
        // the minimum tick step is one unit: expressed as a datetime difference
        const stepExpr = def.tu ? timeUnitMinStepSignal(def.tu) : null
        if (stepExpr) labelAxis.tickMinStep = { signal: stepExpr }
      } else if (def.stack === 'normalize') {
        labelAxis.format = (config?.normalizedNumberFormat as string | undefined) ?? '.0%'
      }
    }
    // overlapping labels are thinned unless the field is categorical (axis/properties.ts defaultLabelOverlap)
    if ((def.timeUnit && !isObject(def.sort)) || (def.type !== 'nominal' && def.type !== 'ordinal')) {
      labelAxis.labelOverlap = sc.type === 'log' || sc.type === 'symlog' ? 'greedy' : true
    }
    if (userAxis?.format === 'd' && labelAxis.tickMinStep === undefined) labelAxis.tickMinStep = userAxis.tickMinStep ?? 1
    // a time unit's duration is the smallest meaningful tick step, whatever the scale type
    if (def.tu && labelAxis.tickMinStep === undefined) {
      const stepExpr = timeUnitMinStepSignal(def.tu)
      if (stepExpr) labelAxis.tickMinStep = { signal: stepExpr }
    }
    // vega-lite's getLabelAngle: an explicit/config labelAngle wins (normalized
    // into [0,360)); otherwise a nominal/ordinal x axis defaults to 270. The
    // align/baseline then derive from the angle for EVERY channel and scale
    // type, not just discrete x — a temporal x with labelAngle 8 anchors its
    // labels left/top exactly like a band axis does.
    {
      const rawAngle = (userAxis as Record<string, unknown> | null | undefined)?.labelAngle
      let angle: number | undefined
      if (typeof rawAngle === 'number') {
        angle = normalizeAngle(rawAngle)
        ;(userAxis as Record<string, unknown>).labelAngle = angle
      } else if (rawAngle === undefined && def.channel === 'x' && (sc.type === 'band' || sc.type === 'point')
          && (def.type === 'nominal' || def.type === 'ordinal') && !def.timeUnit) {
        angle = 270
      }
      const signalAngle = isObject(rawAngle) && (typeof rawAngle.signal === 'string' || typeof rawAngle.expr === 'string')
        ? { signal: (rawAngle.signal ?? rawAngle.expr) as string }
        : undefined
      if (angle !== undefined || signalAngle) {
        labelAxis.labelAngle = signalAngle ?? angle
        const ua = userAxis as Record<string, unknown> | null | undefined
        // vega-lite's parseAxis computes `orient` from the axis def,
        // config.axisX/axisY, then config.axis — the config.axisBand style
        // block supplies the compiled orient but does NOT feed the label
        // align/baseline rule (probed: axisBand.orient top still aligns 270°
        // labels right). Fall back to the channel's own default for the rule.
        const labelOrient = (isObject(def.axis) && typeof (def.axis as Record<string, unknown>).orient === 'string'
          ? (def.axis as Record<string, unknown>).orient as string
          : typeof cfgChannelAxis.orient === 'string'
            ? cfgChannelAxis.orient as string
            : typeof cfgAxis.orient === 'string'
              ? cfgAxis.orient as string
              : def.channel === 'x' ? 'bottom' : 'left')
        if (ua?.labelAlign === undefined) {
          const align = signalAngle ? defaultLabelAlignSignal(signalAngle, labelOrient, def.channel) : defaultLabelAlign(angle!, labelOrient, def.channel)
          if (align != null) labelAxis.labelAlign = align
        }
        if (ua?.labelBaseline === undefined) {
          const baseline = signalAngle ? defaultLabelBaselineSignal(signalAngle, labelOrient, def.channel) : defaultLabelBaseline(angle!, labelOrient, def.channel)
          if (baseline != null) labelAxis.labelBaseline = baseline
        }
      }
    }
    // vega-lite formats any stack-normalized positional axis as a percentage,
    // even when the scale is discrete (a nominal y stack still gets `.0%`;
    // the labels then read NaN%).
    if (def.stack === 'normalize' && labelAxis.format === undefined) labelAxis.format = (config?.normalizedNumberFormat as string | undefined) ?? '.0%'
    // config.numberFormat is the default format of a quantitative field's axis labels
    if (def.type === 'quantitative' && !def.timeUnit && labelAxis.format === undefined && typeof config?.numberFormat === 'string') labelAxis.format = config.numberFormat
    // a timeUnit on a discrete positional axis still formats with timeFormat
    if (def.timeUnit && !isContinuousScaleType(sc.type)) {
      labelAxis.format = { signal: timeUnitFormatSignal(def.timeUnit) }
      labelAxis.formatType = 'time'
    }
    if (userAxis) {
      for (const [k, v] of Object.entries(userAxis)) {
        if (k === 'grid' || k === 'title' || k === 'orient' || k === 'scale') continue
        labelAxis[k] = v
      }
      if (userAxis.orient) labelAxis.orient = userAxis.orient
    }
    // a custom format type moves the label text into the labels encode and leaves vega's own `format` unset
    // (vega-lite axis/encode.ts labels(), format.ts guideFormat)
    {
      const customText = customLabelText(def, userAxis, config as Record<string, unknown> | undefined, def.stack === 'normalize')
      if (customText !== undefined) {
        delete labelAxis.format
        delete labelAxis.formatType
        const enc = (labelAxis.encode ?? (labelAxis.encode = {})) as { labels?: { update?: Record<string, unknown> } }
        const labels = (enc.labels ??= {})
        labels.update = { text: { signal: customText }, ...(labels.update ?? {}) }
      }
    }
    // vega-lite's axis labelExpr is a label text encode (vega has no such axis property)
    if (typeof labelAxis.labelExpr === 'string') {
      const enc = (labelAxis.encode ?? (labelAxis.encode = {})) as { labels?: { update?: Record<string, unknown> } }
      const labels = (enc.labels ??= {})
      const update = (labels.update ??= {})
      update.text = { signal: labelExprSignal(labelAxis.labelExpr, update.text) }
      // `labelExpr` itself stays as an unknown key that real Vega and Aster both ignore; the encode above labels the ticks
    }
    labelAxes.push(labelAxis)
  }
  return [...gridAxes, ...labelAxes]
}

function axisTitle(def: FieldDef, userAxis?: Record<string, unknown> | null, fields?: FieldDef[]): unknown {
  if (userAxis && 'title' in userAxis) return userAxis.title
  // ranged channels (x2/y2 fields) join their titles with ', ' (vega-lite
  // joins the field defs' titles for the shared axis)
  if (fields) {
    const ch2 = def.channel === 'x' ? 'x2' : def.channel === 'y' ? 'y2' : null
    const def2 = ch2 ? fields.find((f) => f.channel === ch2 && f.field) : undefined
    if (def2) {
      // an explicit title on either endpoint wins over the joined default
      if (def2.title !== undefined) return def2.title
      if (def.title !== undefined) return def.title
      const t1 = channelTitle(def)
      const t2 = channelTitle(def2)
      if (typeof t1 === 'string' && typeof t2 === 'string') return `${t1}, ${t2}`
    }
  }
  return channelTitle(def)
}

// --- legends -----------------------------------------------------------------

function buildLegends(fields: FieldDef[], mark: string, markOpacity?: number, markFilled?: boolean, markStroke?: string, markStrokeWidth?: number, markFillOpacity?: number, cfgLegendIn?: Record<string, unknown>, markStrokeDash?: number[], formats: { numberFormat?: string; timeFormat?: string; customFormatTypes?: boolean; numberFormatType?: string; timeFormatType?: string } = {}, paint: { fill?: string; stroke?: string; markFill?: string; shape?: string; colorScaleless?: boolean } = {}): Record<string, unknown>[] {
  const legends: Record<string, unknown>[] = []
  // config.legend is a defaults layer: orient/direction keys are translated
  // into the compiled `direction`, everything else merges under the channel's
  // own legend definition.
  const cfgLegend = cfgLegendIn ?? {}
  // Only the properties vega-lite actually forwards from config.legend merge
  // as legend defaults; orient/symbolDirection/gradientDirection are handled
  // separately, and keys like direction/gradientLength are NOT config defaults
  // (upstream leaves them to the channel's own legend definition).
  const cfgDefaults: Record<string, unknown> = {}
  if (cfgLegend.symbolType != null) cfgDefaults.symbolType = cfgLegend.symbolType
  // vega-lite's reduced symbol opacity (init.ts opacity()) does not apply
  // when the encoding is aggregate — the mark legend follows the mark.
  const reducedOpacity = fields.some((f) => f.aggregate) ? undefined : C.pointOpacity
  // a field's legend is suppressed when ANY channel bound to the same field
  // disables it (vega-lite merges per-field legends)
  const legendSuppressed = (def: FieldDef): boolean =>
    fields.some((f) => f.field === def.field && f.legend === null)
  // vega-lite emits legends in a fixed channel order (color, size, shape,
  // opacity) regardless of the encoding's key order — verified by probing
  // vl.compile with permuted encodings.
  const legendsByKey: Record<string, Record<string, unknown>> = {}
  const order: string[] = []
  const legendDefs: Record<string, FieldDef> = {}
  const push = (key: string, lg: Record<string, unknown>, def: FieldDef): void => {
    // a custom format type moves the label text into the labels encode and leaves vega's `format` unset
    const customText = customLabelText(def, { ...cfgDefaults, ...(def.legend ?? {}) }, formats as Record<string, unknown>, false)
    if (customText !== undefined) {
      delete lg.format
      delete lg.formatType
      const enc = (lg.encode ?? (lg.encode = {})) as { labels?: { update?: Record<string, unknown> } }
      const labels = (enc.labels ??= {})
      labels.update = { text: { signal: customText }, ...(labels.update ?? {}) }
    }
    legendsByKey[key] = lg
    legendDefs[key] = def
    // legend/parse.ts isExplicit: the title is the legend's own, or the field def's title
    if ((isObject(def.legend) && 'title' in def.legend) || (def.title !== undefined && lg.title === def.title)) EXPLICIT_LEGEND_TITLE.add(lg)
    order.push(key)
  }
  // the paint a legend symbol shows: vega-lite fills every mark but point, line and rule unless configured (trail never)
  const legendFilled = mark !== 'trail' && (markFilled ?? !['point', 'line', 'rule'].includes(mark))
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const colorLegendShown = !!colorDef && colorDef.legend !== null && !legendSuppressed(colorDef)
  if (colorDef && colorDef.legend !== null && !legendSuppressed(colorDef)) {
    const userLegend = { ...cfgDefaults, ...(colorDef.legend ?? {}) }
    const lg: Record<string, unknown> = { title: legendTitle(colorDef, userLegend) }
    // only a cyclic (discrete) time unit switches the color legend from a
    // gradient to symbols; year/week/hours/... stay continuous (probed:
    // quantitative color with month/day/quarter → symbol, every other unit →
    // gradient).
    const colorTimeUnitSymbol = colorDef.timeUnit != null
      && ['month', 'day', 'quarter'].includes(String(colorDef.timeUnit))
    const colorDiscreteScale = ['quantile', 'quantize', 'threshold'].includes(colorDef.scale?.type as string)
      || (!!colorDef.bin && colorDef.type === 'quantitative' && (colorDef.scale?.type === undefined || colorDef.scale.type === 'bin-ordinal'))
    const colorContinuous = (!isDiscreteType(colorDef.type)
      || (colorDef.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)))
      && !colorTimeUnitSymbol && !colorDiscreteScale
    // legend.type:'symbol' forces a symbol legend even on a continuous scale
    const colorGradient = colorContinuous && userLegend.type !== 'symbol'
    if (colorTimeUnitSymbol) lg.type = 'symbol'
    if (colorDef.scale?.type === 'quantile' || colorDef.scale?.type === 'threshold') lg.labelOverlap = 'greedy'
    lg[legendFilled ? 'fill' : 'stroke'] = 'color'
    const opacity = markOpacity ?? (['point', 'circle', 'square', 'tick'].includes(mark) ? reducedOpacity : undefined)
    if (colorGradient) {
      GRADIENT_LEGENDS.add(lg)
      lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
      if (opacity) lg.encode = { gradient: { update: { opacity: { value: opacity } } } }
    } else {
      lg.symbolType = paint.shape ?? (['bar', 'rect', 'square'].includes(mark) ? 'square' : ['line', 'trail', 'rule'].includes(mark) ? 'stroke' : 'circle')
      // the mark's own paint and opacity ride along on the symbols (legend/encode.ts symbols())
      const symUpdate: Record<string, unknown> = {}
      if (!legendFilled && !['line', 'rule', 'trail'].includes(mark)) symUpdate.fill = { value: paint.markFill ?? 'transparent' }
      if (markStroke) symUpdate.stroke = { value: markStroke }
      if (markStrokeWidth != null) symUpdate.strokeWidth = { value: markStrokeWidth }
      if (markStrokeDash != null) symUpdate.strokeDash = { value: markStrokeDash }
      if (markFillOpacity != null) symUpdate.fillOpacity = { value: markFillOpacity }
      if (opacity) symUpdate.opacity = { value: opacity }
      if (Object.keys(symUpdate).length) lg.encode = { symbols: { update: symUpdate } }
    }
    applyTimeUnitLegend(lg, colorDef, userLegend, formats)
    for (const [k, v] of Object.entries(userLegend)) {
      if (k === 'title') continue
      if (k === 'type' && v === 'gradient') continue
      lg[k] = v
    }
    // strip the VL-only keys and the other type's keys (upstream parity): a
    // gradient legend drops symbol*, a symbol legend drops gradient*
    const isGradient = 'gradientLength' in lg
    for (const k of Object.keys(lg)) {
      if (k === 'title' || k === 'encode' || k === 'fill' || k === 'stroke' || k === 'shape' || k === 'size' || k === 'opacity') continue
      if (isGradient ? (k.startsWith('symbol') || k === 'gradientStroke') : k.startsWith('gradient')) delete lg[k]
    }
    push('color', lg, colorDef)
  }
  // the symbol of a size / strokeWidth / opacity legend follows the mark (legend/encode.ts symbols())
  const symbolFor = (channel: string): { symbolType: string; update: Record<string, unknown> } => {
    const filled = legendFilled
    // the symbol is painted like the mark: its constant colour (channel value, then mark def) over the mark's default
    const base = (filled ? paint.fill : paint.stroke) ?? (mark === 'text' || mark === 'rule' ? 'black' : C.blue)
    const opacity = markOpacity ?? (['point', 'circle', 'square', 'tick'].includes(mark) ? reducedOpacity : undefined)
    // a colour legend colours the symbols only when the channel is a field of its own: a channel whose field is a
    // condition's (`{condition: {test, field}, value: "lightgray"}`) is a value def to the legend, whose constant paints them
    // (legend/encode.ts symbols(): a colour channel that is a field makes the symbols black, whether or not its own legend is shown)
    // (a `scale: null` colour is a field too: the symbols are not painted like the mark)
    const byColor = (colorDef != null && !colorDef.fromCondition) || paint.colorScaleless === true
    const u: Record<string, unknown> = {}
    if (filled) {
      if (byColor) Object.assign(u, { fill: { value: 'black' }, fillOpacity: { value: opacity ?? 1 } })
      else u.fill = { value: base }
      u.stroke = { value: markStroke ?? 'transparent' }
    } else {
      if (mark === 'point') u.fill = { value: 'transparent' }
      if (!byColor) u.stroke = { value: markStroke ?? base }
    }
    if (channel !== 'opacity' && opacity) u.opacity = { value: opacity }
    return { symbolType: paint.shape ?? (['bar', 'rect', 'square'].includes(mark) ? 'square' : ['line', 'trail', 'rule'].includes(mark) ? 'stroke' : 'circle'), update: u }
  }
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef && sizeDef.legend !== null && !legendSuppressed(sizeDef)) {
    // vega-lite gives a standalone size legend the default symbol stroke
    // (#4c78a8) but drops it when a color legend coexists.
    const sizeUser = { ...cfgDefaults, ...(sizeDef.legend ?? {}) }
    if (sizeUser.type === 'gradient') {
      const glg: Record<string, unknown> = {
        [mark === 'trail' ? 'strokeWidth' : 'size']: 'size',
        type: 'gradient',
        gradientLength: sizeUser.gradientLength ?? { signal: 'clamp(height, 64, 200)' },
        title: legendTitle(sizeDef, sizeUser),
        encode: { gradient: { update: { opacity: { value: markOpacity ?? reducedOpacity ?? 1 } } } },
      }
      applyTimeUnitLegend(glg, sizeDef, sizeUser, formats)
      forwardLegendProps(sizeUser, glg, true)
      GRADIENT_LEGENDS.add(glg)
      push('size', glg, sizeDef)
    } else {
    const sizeSym = symbolFor('size')
    if (sizeUser.symbolOpacity != null) delete sizeSym.update.opacity
    const sizeLg: Record<string, unknown> = {
      // (a trail's size scale is its stroke width: vega-lite legend/parse.ts getLegendDefWithScale)
      [mark === 'trail' ? 'strokeWidth' : 'size']: 'size',
      symbolType: sizeSym.symbolType,
      title: legendTitle(sizeDef, sizeUser),
      encode: { symbols: { update: sizeSym.update } },
    }
    applyTimeUnitLegend(sizeLg, sizeDef, sizeUser, formats)
    forwardLegendProps(sizeUser, sizeLg, false)
    push('size', sizeLg, sizeDef)
    }
  }
  const shapeDefL = fields.find((f) => f.channel === 'shape' && f.field && f.type !== 'geojson')
  if (shapeDefL && shapeDefL.legend !== null && !legendSuppressed(shapeDefL)) {
    const shapeUser = { ...cfgDefaults, ...(shapeDefL.legend ?? {}) }
    const shapeLg: Record<string, unknown> = {
      shape: 'shape',
      symbolType: 'circle',
      title: legendTitle(shapeDefL, shapeUser),
      // (a filled mark - a point overlay is one - paints the symbols like the mark; an unfilled point strokes them)
      encode: { symbols: { update: legendFilled ? symbolFor('shape').update : { fill: { value: 'transparent' }, ...(colorLegendShown && !colorDef?.fromCondition ? {} : { stroke: { value: paint.stroke ?? C.blue } }), opacity: { value: markOpacity ?? reducedOpacity ?? 1 } } } },
    }
    applyTimeUnitLegend(shapeLg, shapeDefL, shapeUser, formats)
    forwardLegendProps(shapeUser, shapeLg, false)
    push('shape', shapeLg, shapeDefL)
  }
  const strokeWidthLegendDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  if (strokeWidthLegendDef && strokeWidthLegendDef.legend !== null && !legendSuppressed(strokeWidthLegendDef)) {
    const swUser = { ...cfgDefaults, ...(strokeWidthLegendDef.legend ?? {}) }
    const swSym = symbolFor('strokeWidth')
    const swLg: Record<string, unknown> = {
      strokeWidth: 'strokeWidth',
      symbolType: swSym.symbolType,
      title: legendTitle(strokeWidthLegendDef, swUser),
      encode: { symbols: { update: swSym.update } },
    }
    applyTimeUnitLegend(swLg, strokeWidthLegendDef, swUser, formats)
    forwardLegendProps(swUser, swLg, false)
    push('strokeWidth', swLg, strokeWidthLegendDef)
  }
  const strokeDashLegendDef = fields.find((f) => f.channel === 'strokeDash' && f.field)
  if (strokeDashLegendDef && strokeDashLegendDef.legend !== null && !legendSuppressed(strokeDashLegendDef)) {
    const sdUser = { ...cfgDefaults, ...(strokeDashLegendDef.legend ?? {}) }
    const sdSym = symbolFor('strokeDash')
    const sdLg: Record<string, unknown> = {
      strokeDash: 'strokeDash',
      symbolType: sdSym.symbolType,
      title: legendTitle(strokeDashLegendDef, sdUser),
      encode: { symbols: { update: sdSym.update } },
    }
    applyTimeUnitLegend(sdLg, strokeDashLegendDef, sdUser, formats)
    forwardLegendProps(sdUser, sdLg, false)
    push('strokeDash', sdLg, strokeDashLegendDef)
  }
  const opacityLegendDef = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityLegendDef && opacityLegendDef.legend !== null && !legendSuppressed(opacityLegendDef)) {
    const opUser = { ...cfgDefaults, ...(opacityLegendDef.legend ?? {}) }
    const opSym = symbolFor('opacity')
    const opLg: Record<string, unknown> = {
      opacity: 'opacity',
      symbolType: opSym.symbolType,
      title: legendTitle(opacityLegendDef, opUser),
      encode: { symbols: { update: opSym.update } },
    }
    applyTimeUnitLegend(opLg, opacityLegendDef, opUser, formats)
    forwardLegendProps(opUser, opLg, false)
    push('opacity', opLg, opacityLegendDef)
  }
  // legends over the SAME domain (a colour and a shape both on `c`) are one legend (legend/assemble.ts assembleLegends: keyed by
  // the scale's domains, so differing titles do not keep them apart - they merge by mergeTitleComponent)
  const sigOf = (d: FieldDef): string => JSON.stringify([d.source, d.aggregate ?? null, d.bin ? 1 : 0, d.timeUnit ?? null])
  const merged = new Map<string, string>()
  for (const key of order) {
    const sig = sigOf(legendDefs[key]!)
    const into = merged.get(sig)
    if (into !== undefined && legendsByKey[into]!.orient === legendsByKey[key]!.orient) {
      mergeLegend(legendsByKey[into]!, legendsByKey[key]!)
      delete legendsByKey[key]
    } else if (into === undefined) merged.set(sig, key)
  }
  for (const key of order) {
    const lg = legendsByKey[key]
    if (!lg) continue
    applyLegendDirection(lg, legendDefs[key]!, cfgLegend)
    // vega-lite's legend labelExpr is a label text encode (vega has no such legend property)
    if (typeof lg.labelExpr === 'string') {
      const enc = (lg.encode ?? (lg.encode = {})) as { labels?: { update?: Record<string, unknown> } }
      const labels = (enc.labels ??= {})
      const update = (labels.update ??= {})
      update.text = { signal: labelExprSignal(lg.labelExpr, update.text) }
      // `labelExpr` itself stays as an unknown key that real Vega and Aster both ignore; the encode above labels the ticks
    }
    // the mark-derived symbol stroke default must not shadow a user symbolStrokeColor
    const upd = (lg.encode as { symbols?: { update?: Record<string, unknown> } } | undefined)?.symbols?.update
    if (upd) {
      // (vega-lite only lets symbolStrokeColor through; its transparent fill and
      // reduced opacity overrides stay and shadow symbolFillColor/symbolOpacity)
      if (lg.symbolStrokeColor !== undefined) delete upd.stroke
      if (Object.keys(upd).length === 0) delete (lg.encode as { symbols?: unknown }).symbols
      if (Object.keys(lg.encode as object).length === 0) delete lg.encode
    }
    legends.push(lg)
  }
  return legends
}

/** The legends that are a gradient (a colour or size scale that is continuous to continuous). */
const GRADIENT_LEGENDS = new WeakSet<object>()

/**
 * legend/parse.ts + legend/properties.ts getDirection, defaultDirection, defaultGradientLength: a legend's direction and its gradient's
 * length follow its orient (the legend's, then config.legend's, then 'right'). A property that config.legend sets and the legend does
 * not is left to the config (parse.ts: `explicit || config.legend[property] === undefined`), so it is not written on the legend.
 * (`getDirection` reads `legendConfig.gradientDirection` for every legend type: the type is always truthy.)
 */
function applyLegendDirection(lg: Record<string, unknown>, def: FieldDef, cfgLegend: Record<string, unknown>): void {
  const user = (isObject(def.legend) ? def.legend : {}) as Record<string, unknown>
  const gradient = GRADIENT_LEGENDS.has(lg)
  const orient = (user.orient ?? cfgLegend.orient ?? 'right') as string
  const dflt = orient === 'top' || orient === 'bottom' ? 'horizontal' : orient === 'left' || orient === 'right' || orient === 'none' ? undefined : gradient ? 'horizontal' : undefined
  const direction = user.direction ?? cfgLegend.gradientDirection ?? dflt
  delete lg.direction
  if (direction !== undefined && (direction === user.direction || cfgLegend.direction === undefined)) lg.direction = direction
  if (!gradient) return
  const num = (v: unknown, d: number): unknown => v ?? d
  const length = user.gradientLength ?? cfgLegend.gradientLength
    ?? (direction === 'horizontal'
      ? (orient === 'top' || orient === 'bottom' ? { signal: `clamp(width, ${String(num(cfgLegend.gradientHorizontalMinLength, 100))}, ${String(num(cfgLegend.gradientHorizontalMaxLength, 200))})` } : num(cfgLegend.gradientHorizontalMinLength, 100))
      : { signal: `clamp(height, ${String(num(cfgLegend.gradientVerticalMinLength, 64))}, ${String(num(cfgLegend.gradientVerticalMaxLength, 200))})` })
  delete lg.gradientLength
  if (length === user.gradientLength || cfgLegend.gradientLength === undefined) lg.gradientLength = length
}

function legendTitle(def: FieldDef, userLegend: Record<string, unknown>): unknown {
  if ('title' in userLegend) return userLegend.title
  return channelTitle(def)
}

/**
 * Forward the user's legend properties onto the compiled legend (vega-lite
 * copies the legend definition through verbatim minus the VL-only keys and
 * the keys that belong to the other legend type — probed: a symbol legend
 * drops gradient*, a gradient legend drops symbol*; both drop disable, type,
 * symbolWidth).
 */
function forwardLegendProps(userLegend: Record<string, unknown>, lg: Record<string, unknown>, isGradient: boolean): void {
  for (const [k, v] of Object.entries(userLegend)) {
    if (k === 'title' || k === 'encode' || k === 'disable' || k === 'type' || k === 'symbolWidth') continue
    if (isGradient ? (k.startsWith('symbol') || k === 'gradientStroke') : k.startsWith('gradient')) continue
    lg[k] = v
  }
}

// --- marks -------------------------------------------------------------------

type BuiltMarks = Array<Record<string, unknown>>
function buildMarks(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, markSize: number | undefined): BuiltMarks {  // vega-lite's DEFAULT_REDUCED_OPACITY (0.7) applies to point/tick/circle/
  // square only when the encoding is NOT aggregate (init.ts opacity())
  const isAggregateEnc = fields.some((f) => f.aggregate)
  const hasFillOpacity = isObject(spec.mark) && (spec.mark as Record<string, unknown>).fillOpacity !== undefined
  let pointOpacityDefault = isAggregateEnc || hasFillOpacity ? undefined : C.pointOpacity

  const markColor = isObject(spec.mark) ? (spec.mark.color as string | undefined) : undefined
  const markFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
  let markOpacity = isObject(spec.mark) ? (spec.mark.opacity as number | undefined) : undefined
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  // A `fill` / `stroke` field that is read as it is (`scale: null`) and is the paint the mark does NOT use (a stroked point with a
  // fill field) is just that one property: the mark keeps painting its own (color.ts colorOrFillOrStroke; the channels are independent)
  const filledMark = markIsFilled(spec, mark)
  const crossPaint = fields.filter((f) => f.noScale && f.paint !== undefined && f.paint !== (filledMark ? 'fill' : 'stroke'))
  const colorDef = fields.find((f) => f.channel === 'color' && f.field && !f.fromCondition && !crossPaint.includes(f))
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  const shapeDef = fields.find((f) => f.channel === 'shape' && f.field && f.type !== 'geojson')
  const opacityDef = fields.find((f) => f.channel === 'opacity' && f.field)
  const strokeWidthDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  const update: Record<string, unknown> = {}
  /** the orientation the rule branch settled on (undefined: a line segment), for the geographic positions */
  let ruleOrientOut: string | undefined
  const xOffsetDefM = fields.find((f) => f.channel === 'xOffset' && f.field)
  const yOffsetDefM = fields.find((f) => f.channel === 'yOffset' && f.field)
  const xOffsetPresent = xOffsetDefM != null
  const yOffsetPresent = yOffsetDefM != null
  const xOffsetContinuous = xOffsetDefM != null && !isDiscreteType(xOffsetDefM.type)
  const yOffsetContinuous = yOffsetDefM != null && !isDiscreteType(yOffsetDefM.type)
  // config resolution (getMarkPropOrConfig): the mark def first, then the
  // mark-type config block, then the generic config.mark block
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(userConfig?.[mark]) ? (userConfig![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(userConfig?.mark) ? (userConfig!.mark as Record<string, unknown>) : undefined
  const cfgColor = (cfgType?.color ?? cfgMark?.color) as string | undefined
  const cfgFill = (cfgType?.fill ?? cfgMark?.fill) as string | undefined
  const cfgStroke = (cfgType?.stroke ?? cfgMark?.stroke) as string | undefined
  // markDef.opacity ?? config[type].opacity ?? config.mark.opacity
  markOpacity = markOpacity ?? (cfgType?.opacity as number | undefined) ?? (cfgMark?.opacity as number | undefined)
  // any fillOpacity (definition or config) suppresses the reduced-opacity default
  const cfgFillOpacity = cfgType?.fillOpacity ?? cfgMark?.fillOpacity
  pointOpacityDefault = isAggregateEnc || (hasFillOpacity || cfgFillOpacity !== undefined) ? undefined : C.pointOpacity

  if (mark === 'bar' || mark === 'rect') {
    // getMarkPropOrConfig precedence (probed): markDef.fill overrides the
    // color channel; the channel beats config fill; config beats markDef.color;
    // filled:false moves the colour onto stroke (bar fills transparent, rect
    // drops fill entirely) and markDef.fill is ignored.
    const markDef = isObject(spec.mark) ? spec.mark : undefined
    const filledSetting = markDef?.filled ?? cfgType?.filled ?? cfgMark?.filled
    const filled = filledSetting !== false
    if (!filled) {
      if (mark === 'bar') update.fill = { value: 'transparent' }
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: (markDef?.stroke as string | undefined) ?? (cfgType?.stroke as string | undefined) ?? (cfgMark?.stroke as string | undefined) ?? markColor ?? C.blue }
    } else {
      update.fill = markDef?.fill != null
        ? { value: markDef.fill }
        : colorDef
          ? { scale: 'color', field: aggFieldName(colorDef) }
          : { value: (cfgType?.fill as string | undefined) ?? (cfgMark?.fill as string | undefined) ?? (cfgType?.color as string | undefined) ?? (cfgMark?.color as string | undefined) ?? markColor ?? C.blue }
      const stroke = markDef?.stroke ?? cfgType?.stroke ?? cfgMark?.stroke
      if (stroke != null) update.stroke = { value: stroke }
    }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    // pass-through mark-def paint props (getMarkPropOrConfig reads each
    // straight off the definition; vega renders the ones it knows)
    for (const p of ['strokeWidth', 'strokeDash', 'strokeCap', 'strokeJoin', 'fillOpacity', 'cornerRadius', 'angle', 'cursor', 'blend'] as const) {
      if (markDef?.[p] !== undefined) update[p] = { value: markDef[p] }
    }
    // bar rounds its ends with a clip (rect's cornerRadius needs no clip);
    // cornerRadiusEnd rounds the leading edge per orientation
    const cornerRadius = markDef?.cornerRadius ?? cfgType?.cornerRadius ?? cfgMark?.cornerRadius
    const cornerRadiusEnd = markDef?.cornerRadiusEnd ?? cfgType?.cornerRadiusEnd ?? cfgMark?.cornerRadiusEnd
    if (cornerRadius != null && update.cornerRadius === undefined) update.cornerRadius = { value: cornerRadius }
    if (cornerRadiusEnd != null && mark === 'bar') {
      const [a, b] = orient === 'horizontal' ? ['TopRight', 'BottomRight'] : ['TopLeft', 'TopRight']
      update[`cornerRadius${a}`] = { value: cornerRadiusEnd }
      update[`cornerRadius${b}`] = { value: cornerRadiusEnd }
    }
    if (mark === 'bar') update.ariaRoleDescription = { value: 'bar' }
    const stacked = yDef && isStacked(yDef, mark, orient, fields)
    // channeldef.ts getBandSize: the `size` of the mark def (or of the bar config) is the band's size on a continuous scale too
    const barSizeProp = mark === 'bar' ? ((markDef?.size ?? cfgType?.size) as number | undefined) : undefined
    const continuousBand = barSizeProp !== undefined && barSizeProp !== 0 ? barSizeProp : ((cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize)
    if (orient === 'vertical') {
      if (xDef) {
        const sc = positionalScaleType(mark, xDef)
        if (mark === 'rect' && xDef.timeUnit == null && !xDef.bin && sc !== 'band' && markDef?.width !== undefined) {
          // a rect with a width of its own is centered on its value
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: markDef.width }
        } else if (mark === 'rect' && xDef.timeUnit == null && !xDef.bin && sc !== 'band') {
          // a continuous rect spans to the scale's zero/min (vega-lite rangePosition)
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.x2 = zeroOrMinRef('x', xDef, mark)
        } else if (xDef.timeUnit == null && !xDef.bin && xDef.type === 'temporal') {
          // a plain temporal dimension centers the bar with the continuous
          // band size (vega-lite's continuousBandSize)
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: continuousBand }
        } else if (xDef.timeUnit && sc !== 'band') {
          setBinnedRect(update, 'x', xDef, spec, mark)
        } else if (xDef.bin && !binDiscrete(xDef)) {
          setBinnedRect(update, 'x', xDef, spec, mark)
        } else if (sc === 'band') {
          // BarConfig band alignment/size (probed): align 'right' anchors
          // the bar with x2 at the band position; a size/discreteBandSize
          // centers a fixed-width bar in the band; otherwise the bar spans
          // the band
          const barAlign = (markDef?.align ?? cfgType?.align ?? cfgMark?.align) as string | undefined
          const barExplicitSize = (((mark === 'bar' ? markDef?.size : undefined)
            ?? markDef?.width
            ?? (mark === 'bar' ? (cfgType?.size as number | undefined) : undefined)
            ?? (cfgType?.width as number | undefined)
            ?? (cfgMark?.width as number | undefined)) as number | undefined)
          // An explicit zero size uses vega-lite's default discrete step; a
          // zero discreteBandSize is inert upstream (the bar spans the band).
          const barSize = barExplicitSize != null
            ? (barExplicitSize === 0 ? C.defaultStep : barExplicitSize)
            : ((cfgType?.discreteBandSize as number | undefined) === 0 ? undefined : cfgType?.discreteBandSize as number | undefined)
          if (sizeDef) {
            // a size channel centers a bar of data-driven width in its band
            update.xc = { scale: 'x', field: aggFieldName(xDef), band: 0.5 }
            update.width = { scale: 'size', field: aggFieldName(sizeDef) }
          } else if (barAlign === 'right' && !xOffsetPresent) {
            update.x2 = { scale: 'x', field: aggFieldName(xDef) }
            update.width = { signal: `max(0.25, bandwidth('x'))` }
          } else if (barAlign === 'center' && !xOffsetPresent) {
            update.xc = { scale: 'x', field: aggFieldName(xDef), band: 0.5 }
            update.width = { signal: `max(0.25, bandwidth('x'))` }
          } else if (barSize != null && !xOffsetPresent) {
            update.xc = { scale: 'x', field: aggFieldName(xDef), band: 0.5 }
            update.width = { value: barSize }
          } else {
            update.x = { scale: 'x', field: aggFieldName(xDef) }
            if (xOffsetPresent) {
              update.x = { scale: 'x', field: aggFieldName(xDef), offset: { scale: 'xOffset', field: aggFieldName(fields.find((f) => f.channel === 'xOffset')!) } }
            }
            update.width = xOffsetContinuous ? { value: C.defaultStep } : { signal: `max(0.25, bandwidth('${xOffsetPresent ? 'xOffset' : 'x'}'))` }
          }
        } else {
          if (mark === 'rect') {
            update.x = { scale: 'x', field: aggFieldName(xDef) }
            update.x2 = zeroOrMinRef('x', xDef, mark)
          } else {
            update.xc = { scale: 'x', field: aggFieldName(xDef) }
            // a discrete point scale centers a default-step bar (18px); a
            // continuous measure uses the continuous band size
            update.width = { value: sc === 'point' ? C.defaultStep : continuousBand }
          }
        }
      }
      const y2DefB = fields.find((f) => f.channel === 'y2' && f.field)
      if (yDef) {
        if (y2DefB) {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.y2 = { scale: 'y', field: aggFieldName(y2DefB) }
        } else if (mark === 'rect' && ((yDef.bin && !binDiscrete(yDef)) || (yDef.timeUnit && positionalScaleType(mark, yDef) !== 'band'))) {
          // a rect's second dimension may be binned too (2d heatmaps)
          if (yDef.bin) {
            const bn = binNames(yDef.binParams!, yDef.field)
            setBinnedRect(update, 'y', yDef, spec, mark)
          } else setBinnedRect(update, 'y', yDef, spec, mark)
        } else if (stacked) {
          update.y = { scale: 'y', field: `${aggFieldName(yDef)}_end` }
          update.y2 = { scale: 'y', field: `${aggFieldName(yDef)}_start` }
        } else if (positionalScaleType(mark, yDef) === 'band') {
          // nominal/ordinal y (heatmap-style rect marks): band cell height.
          // baseline aligns the cell within the band (top/undefined left,
          // bottom pins y2, middle centers via yc band 0.5).
          const yAlign = (markDef?.baseline ?? cfgType?.baseline ?? cfgMark?.baseline) as string | undefined
          const yExplicitSize = ((markDef?.height
            ?? (cfgType?.height as number | undefined)
            ?? (cfgMark?.height as number | undefined)) as number | undefined)
          const ySize = yExplicitSize != null
            ? (yExplicitSize === 0 ? C.defaultStep : yExplicitSize)
            : ((cfgType?.discreteBandSize as number | undefined) === 0 ? undefined : cfgType?.discreteBandSize as number | undefined)
          if (ySize != null) {
            update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            update.height = { value: ySize }
          } else {
            if (yAlign === 'bottom') update.y2 = { scale: 'y', field: aggFieldName(yDef) }
            else if (yAlign === 'middle') update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            else update.y = { scale: 'y', field: aggFieldName(yDef) }
            update.height = { signal: `max(0.25, bandwidth('y'))` }
          }
        } else if (mark === 'rect' && markDef?.height !== undefined) {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: markDef.height }
        } else {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          if (mark === 'bar') update.y2 = zeroOrMinRef('y')
          else if (mark === 'rect') update.y2 = zeroOrMinRef('y', yDef, mark)
        }
      }
    } else {
      if (yDef) {
        const sc = positionalScaleType(mark, yDef)
        if (mark === 'rect' && yDef.timeUnit == null && !yDef.bin && sc !== 'band' && markDef?.height !== undefined) {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: markDef.height }
        } else if (mark === 'rect' && yDef.timeUnit == null && !yDef.bin && sc !== 'band') {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.y2 = zeroOrMinRef('y', yDef, mark)
        } else if (yDef.timeUnit == null && !yDef.bin && yDef.type === 'temporal') {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: continuousBand }
        } else if (yDef.timeUnit && sc !== 'band') {
          setBinnedRect(update, 'y', yDef, spec, mark)
        } else if (yDef.bin && !binDiscrete(yDef)) {
          setBinnedRect(update, 'y', yDef, spec, mark)
        } else if (sc === 'band') {
          const yAlignH = (markDef?.baseline ?? cfgType?.baseline ?? cfgMark?.baseline) as string | undefined
          const hExplicitSize = (((mark === 'bar' ? markDef?.size : undefined)
            ?? markDef?.height
            ?? (cfgType?.size as number | undefined)
            ?? (cfgType?.height as number | undefined)
            ?? (cfgMark?.height as number | undefined)) as number | undefined)
          const hSize = hExplicitSize != null
            ? (hExplicitSize === 0 ? C.defaultStep : hExplicitSize)
            : ((cfgType?.discreteBandSize as number | undefined) === 0 ? undefined : cfgType?.discreteBandSize as number | undefined)
          if (sizeDef) {
            update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            update.height = { scale: 'size', field: aggFieldName(sizeDef) }
          } else if (hSize != null && !yOffsetPresent) {
            update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            update.height = { value: hSize }
          } else {
            if (yAlignH === 'bottom') update.y2 = { scale: 'y', field: aggFieldName(yDef) }
            else if (yAlignH === 'middle') update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            else update.y = { scale: 'y', field: aggFieldName(yDef) }
            if (yOffsetPresent) {
              const ych = yAlignH === 'bottom' ? 'y2' : yAlignH === 'middle' ? 'yc' : 'y'
              update[ych] = { scale: 'y', field: aggFieldName(yDef), offset: { scale: 'yOffset', field: aggFieldName(fields.find((f) => f.channel === 'yOffset')!) } }
            }
            update.height = yOffsetContinuous ? { value: C.defaultStep } : { signal: `max(0.25, bandwidth('${yOffsetPresent ? 'yOffset' : 'y'}'))` }
          }
        } else {
          if (mark === 'rect') {
            update.y = { scale: 'y', field: aggFieldName(yDef) }
            update.y2 = zeroOrMinRef('y', yDef, mark)
          } else {
            update.yc = { scale: 'y', field: aggFieldName(yDef) }
            update.height = { value: sc === 'point' ? C.defaultStep : continuousBand }
          }
        }
      }
      if (xDef) {
        const x2Field = fields.find((f) => f.channel === 'x2' && f.field)
        const stackedX = !x2Field && isStacked(xDef, mark, orient, fields)
        if (x2Field) {
          // an explicit x2 field: the bar spans x → x2 (ranged bar)
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.x2 = { scale: 'x', field: aggFieldName(x2Field) }
        } else if (mark === 'rect' && ((xDef.bin && !binDiscrete(xDef)) || (xDef.timeUnit && positionalScaleType(mark, xDef) !== 'band'))) {
          if (xDef.bin) {
            const bn = binNames(xDef.binParams!, xDef.field)
            setBinnedRect(update, 'x', xDef, spec, mark)
          } else setBinnedRect(update, 'x', xDef, spec, mark)
        } else if (stackedX) {
          update.x = { scale: 'x', field: `${aggFieldName(xDef)}_end` }
          update.x2 = { scale: 'x', field: `${aggFieldName(xDef)}_start` }
        } else if (!stackedX && positionalScaleType(mark, xDef) === 'band' && !xOffsetPresent) {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { signal: `max(0.25, bandwidth('x'))` }
        } else if (mark === 'rect' && markDef?.width !== undefined) {
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: markDef.width }
        } else {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          if (mark === 'bar') update.x2 = zeroOrMinRef('x')
          else if (mark === 'rect') update.x2 = zeroOrMinRef('x', xDef, mark)
        }
      }
    }
    // position-rect.ts positionAndSize: the band channel of a bar with a relative band size or an offset channel
    if (mark === 'bar') {
      const bandCh = orient === 'vertical' ? 'x' : 'y'
      const handled = positionAndSizeRefs(bandCh, bandCh === 'x' ? xDef : yDef, spec, mark, fields)
      if (handled) {
        for (const k of [bandCh, `${bandCh}c`, `${bandCh}2`, bandCh === 'x' ? 'width' : 'height']) delete update[k]
        Object.assign(update, handled)
      }
    }
    // position-rect.ts rectPosition: a channel with a secondary channel (x + x2, y + y2) that is not binned is a plain range
    // between the two refs (rangePosition), whatever the scale: the band-size rules above are for single-channel positions
    for (const [pos, def] of [['x', xDef], ['y', yDef]] as const) {
      const def2 = fields.find((f) => f.channel === `${pos}2` && f.field)
      if (!def || !def2 || def.bin) continue
      const band = positionalScaleType(mark, def) === 'band' ? { band: 0.5 } : {}
      for (const k of [pos, `${pos}c`, `${pos}2`, pos === 'x' ? 'width' : 'height']) delete update[k]
      update[pos] = { scale: pos, field: aggFieldName(def), ...band }
      update[`${pos}2`] = { scale: pos, field: aggFieldName(def2), ...band }
    }
  } else if (mark === 'point' || mark === 'circle' || mark === 'square') {
    const filledSetting = isObject(spec.mark) && spec.mark.filled !== undefined
      ? spec.mark.filled
      : (cfgType?.filled ?? cfgMark?.filled)
    const filled = mark === 'point' ? filledSetting === true : filledSetting !== false
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    if (filled) {
      update.fill = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
      const st = markStroke ?? cfgStroke
      if (st != null) update.stroke = { value: st }
      if (markStrokeWidth) update.strokeWidth = { value: markStrokeWidth }
      if (markOpacity != null || pointOpacityDefault != null) update.opacity = { value: markOpacity ?? pointOpacityDefault }
      if (mark !== 'point') update.shape = { value: mark }
      if (markSize != null) update.size = { value: markSize }
    } else {
      update.opacity = opacityDef
        ? { scale: 'opacity', field: aggFieldName(opacityDef) }
        : (markOpacity != null || pointOpacityDefault != null ? { value: markOpacity ?? pointOpacityDefault } : undefined)
      if (update.opacity === undefined) delete update.opacity
      // an unfilled point keeps its stroke-mode defaults; a config fill
      // (point.fill / mark.fill) still fills it (probed). filled:false on a
      // circle/square also moves the paint onto the stroke.
      const ptFill = (isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined) ?? cfgFill
      update.fill = ptFill != null ? { value: ptFill } : { value: 'transparent' }
      const ptStroke = (isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined) ?? markColor ?? cfgStroke ?? cfgColor ?? C.blue
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: ptStroke }
    }
    update.ariaRoleDescription = { value: mark }
    // Vega's symbol shape vocabulary has no "point": the point mark keeps
    // Vega's default (circle) shape; circle/square name their own.
    if (mark !== 'point') update.shape = { value: mark }
    if (markSize != null) update.size = { value: markSize }
    // a stacked point sits at the stacked end of its measure
    if (xDef) update.x = { scale: 'x', field: isStacked(xDef, mark, orient, fields) ? `${aggFieldName(xDef)}_end` : aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: isStacked(yDef, mark, orient, fields) ? `${aggFieldName(yDef)}_end` : aggFieldName(yDef) }
    if (sizeDef) update.size = { scale: 'size', field: aggFieldName(sizeDef) }
    if (strokeWidthDef) update.strokeWidth = { scale: 'strokeWidth', field: aggFieldName(strokeWidthDef) }
    if (shapeDef) update.shape = { scale: 'shape', field: aggFieldName(shapeDef) }
    void 0
  } else if (mark === 'line') {
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markStroke ?? cfgStroke ?? cfgColor ?? markColor ?? C.blue }
    if (markStrokeWidth != null) update.strokeWidth = { value: markStrokeWidth }
    const lineSizeCfg = (cfgType?.size as number | undefined) ?? (cfgMark?.size as number | undefined)
    if (markSize != null) update.strokeWidth = { value: markSize }
    else if (lineSizeCfg != null) update.strokeWidth = { value: lineSizeCfg }
    // the size channel maps to line width
    if (sizeDef) update.strokeWidth = { scale: 'size', field: aggFieldName(sizeDef) }
    const markInterpolate = isObject(spec.mark) ? (spec.mark.interpolate as string | undefined) : undefined
    if (markInterpolate) update.interpolate = { value: markInterpolate }
    // a line's markDef.fill fills the line's area (vega paints line marks);
    // the stroke default stays. markDef.filled:true paints the area instead
    // of the stroke, like a filled rule.
    const lineFill = (isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined)
      ?? (cfgType?.fill as string | undefined)
      ?? (cfgMark?.fill as string | undefined)
    const lineFilled = isObject(spec.mark) && spec.mark.filled !== undefined
      ? spec.mark.filled
      : (cfgType?.filled ?? cfgMark?.filled)
    if (lineFilled === true) {
      update.fill = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: lineFill ?? markColor ?? cfgFill ?? cfgColor ?? C.blue }
      delete update.stroke
    } else if (lineFill != null) update.fill = { value: lineFill }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    { const dfn = definedSignal(spec, fields, mark); if (dfn !== undefined) update.defined = dfn }
  } else if (mark === 'area') {
    update.orient = { value: orient }
    const areaStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const areaInterpolate = isObject(spec.mark) ? (spec.mark.interpolate as string | undefined) : undefined
    if (areaInterpolate) update.interpolate = { value: areaInterpolate }
    const areaFillOpacity = isObject(spec.mark) ? (spec.mark.fillOpacity as number | undefined) : undefined
    if (areaFillOpacity != null) update.fillOpacity = { value: areaFillOpacity }
    if (areaStroke) update.stroke = { value: areaStroke }
    const areaFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
    const areaColor = colorDef
      ? { scale: 'color', field: aggFieldName(colorDef) }
      : { value: areaFill ?? markColor ?? cfgFill ?? cfgColor ?? C.blue }
    if (isObject(spec.mark) && spec.mark.filled === false) {
      update.stroke = areaColor
      update.fill = { value: 'transparent' }
    } else {
      update.fill = areaColor
    }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) {
      const stacked = isStacked(yDef, mark, orient, fields)
      update.y = { scale: 'y', field: stacked ? `${aggFieldName(yDef)}_end` : aggFieldName(yDef) }
      const areaY2 = fields.find((f) => f.channel === 'y2' && f.field && !f.datumOnly)
      if (areaY2 && orient !== 'horizontal') {
        // a ranged area: y2 is the other end
        update.y2 = { scale: 'y', field: aggFieldName(areaY2) }
      } else if (orient !== 'horizontal') {
        // vertical area: y is the value axis, y2 the baseline
        update.y2 = stacked
          ? { scale: 'y', field: `${aggFieldName(yDef)}_start` }
          : zeroOrMinRef('y')
      }
    }
    if (xDef && orient === 'horizontal') {
      // horizontal area: x is the value axis; the baseline runs to the start of
      // the x domain (vega-lite's zeroOrMin rule), and y2 is not emitted.
      const stackedX = isStacked(xDef, mark, orient, fields)
      if (stackedX) {
        update.x = { scale: 'x', field: `${aggFieldName(xDef)}_end` }
        update.x2 = { scale: 'x', field: `${aggFieldName(xDef)}_start` }
      } else {
        update.x2 = zeroOrMinRef('x')
      }
    }
    { const dfn = definedSignal(spec, fields, mark); if (dfn !== undefined) update.defined = dfn }
  } else if (mark === 'tick') {
    if (markOpacity != null || pointOpacityDefault != null) update.opacity = { value: markOpacity ?? pointOpacityDefault }
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
    const tickDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
    const tickStroke = tickDef?.stroke as string | undefined
    if (tickStroke != null || cfgStroke != null) update.stroke = { value: tickStroke ?? cfgStroke }
    const tickFilled = tickDef?.filled !== undefined ? tickDef.filled : (cfgType?.filled ?? cfgMark?.filled)
    if (tickFilled === false) {
      const tf = update.fill
      delete update.fill
      update.stroke = tf
    }
    update.ariaRoleDescription = { value: 'tick' }
    // Tick orientation is the opposite of bar/line/area's measure inference (mark/init.ts orient, which inferOrient ports): a
    // quantitative x over a discrete y is a VERTICAL tick (its size axis is y and its thickness axis is x). A tick whose
    // orientation cannot be told is a vertical one (tick.ts reads `orient === 'horizontal'`).
    const tickOrient = orient
    const sizeAxis = tickOrient === 'horizontal' ? 'x' : 'y'
    const sizeField = sizeAxis === 'x' ? xDef : yDef
    const sizeVg = sizeAxis === 'x' ? 'width' : 'height'
    const thickAxis = sizeAxis === 'x' ? 'y' : 'x'
    const thickField = thickAxis === 'x' ? xDef : yDef
    const thickVg = thickAxis === 'x' ? 'width' : 'height'
    const thickVal = (tickDef?.thickness ?? (cfgType?.thickness as number | undefined) ?? 1) as number
    const tickExplicitSize = (tickDef?.size
      ?? (cfgType?.size as number | undefined)
      ?? (cfgType?.height as number | undefined)) as number | undefined
    const tickSize = tickExplicitSize != null
      ? (tickExplicitSize === 0 ? C.defaultStep : tickExplicitSize)
      : ((cfgType?.discreteBandSize as number | undefined) === 0 ? undefined : cfgType?.discreteBandSize as number | undefined)
    const sizeRaw = tickSize
    // thickness axis: centered on the point/band (pointPosition default mid);
    // a band thickness axis honors baseline (bottom pins y2, middle centers)
    if (thickField) {
      const isBand = positionalScaleType(mark, thickField) === 'band'
      const base = (tickDef?.baseline ?? cfgType?.baseline) as string | undefined
      if (isBand && thickAxis === 'y' && base === 'bottom') {
        update.y2 = { scale: 'y', field: aggFieldName(thickField) }
      } else {
        const key = `${thickAxis}c`
        update[key] = { scale: thickAxis, field: aggFieldName(thickField), ...(isBand ? { band: 0.5 } : {}) }
      }
    }
    if (sizeField) {
      const isBand = positionalScaleType(mark, sizeField) === 'band'
      // position-rect.ts rectPosition: a binned / time-unit size axis spans its bin (tick.ts calls rectPosition for it)
      const binnedSizeAxis = !isBand && !sizeDef && sizeRaw === undefined && (sizeField.bin || (sizeField.tu && sizeField.type === 'temporal'))
        && !fields.some((f) => f.channel === `${sizeAxis}2` || f.channel === `${sizeAxis}Offset`)
      if (binnedSizeAxis) {
        setBinnedRect(update, sizeAxis, sizeField, spec, mark)
      } else if (sizeDef) {
        update[`${sizeAxis}c`] = { scale: sizeAxis, field: aggFieldName(sizeField), ...(isBand ? { band: 0.5 } : {}) }
        update[sizeVg] = { scale: 'size', field: aggFieldName(sizeDef) }
      } else if (sizeRaw !== undefined) {
        update[`${sizeAxis}c`] = { scale: sizeAxis, field: aggFieldName(sizeField), ...(isBand ? { band: 0.5 } : {}) }
        update[sizeVg] = { value: sizeRaw }
      } else if (isBand) {
        // baseline.bottom pins a band size axis to its y2 edge; every other
        // baseline anchors at the band start (vega-lite tick.ts).
        const sizeBase = (tickDef?.baseline ?? cfgType?.baseline) as string | undefined
        if (sizeAxis === 'y' && sizeBase === 'bottom') {
          update.y2 = { scale: 'y', field: aggFieldName(sizeField) }
        } else {
          update[sizeAxis] = { scale: sizeAxis, field: aggFieldName(sizeField) }
        }
        update[sizeVg] = { signal: `max(0.25, bandwidth('${sizeAxis}'))` }
      } else {
        update[`${sizeAxis}c`] = { scale: sizeAxis, field: aggFieldName(sizeField) }
        update[sizeVg] = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
      }
    }
    // position-rect.ts positionAndSize for a tick's size axis with a relative band size or an offset channel
    {
      const handled = positionAndSizeRefs(sizeAxis, sizeField, spec, mark, fields)
      if (handled) {
        for (const k of [sizeAxis, `${sizeAxis}c`, `${sizeAxis}2`, sizeVg]) delete update[k]
        Object.assign(update, handled)
      }
    }
    update[thickVg] = { value: thickVal }
  } else if (mark === 'rule') {
    const ruleDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: (ruleDef.stroke as string | undefined) ?? markColor ?? cfgStroke ?? cfgColor ?? 'black' }
    const ruleFill = ruleDef.fill as string | undefined
    if (ruleFill != null) update.fill = { value: ruleFill }
    // vega-lite rule orientation (compile/mark/init.ts, falling through the
    // BAR/TEXT and LINE/TICK cases): ranged rules by their y2/x2 presence,
    // single-channel rules by the present channel, then by measure-ness —
    // rules default vertical whenever the y is a measure or x is not.
    const xIsMeasure = xDef != null && xDef.type === 'quantitative'
    const yIsMeasure = yDef != null && yDef.type === 'quantitative'
    const x2Def = fields.find((f) => f.channel === 'x2' && f.field)
    const y2Def = fields.find((f) => f.channel === 'y2' && f.field)
    const hasX2Enc = x2Def != null || fields.some((f) => f.channel === 'x2')
    const hasY2Enc = y2Def != null || fields.some((f) => f.channel === 'y2')
    const specOrient = isObject(spec.mark) ? (spec.mark.orient as string | undefined) : undefined
    const ruleOrient = ruleOrientOut = specOrient
      ?? (hasX2Enc && hasY2Enc ? undefined
        : hasY2Enc ? 'vertical'
        : hasX2Enc ? 'horizontal'
        // (init.ts orient: `x && !y` is about the channels, a constant `value` position included)
        : (hasEncodingChannel(spec, 'x') && !hasEncodingChannel(spec, 'y')) ? 'vertical'
        : (hasEncodingChannel(spec, 'y') && !hasEncodingChannel(spec, 'x')) ? 'horizontal'
        : (xIsMeasure && !yIsMeasure) ? 'horizontal'
        : (!xIsMeasure && yIsMeasure) ? 'vertical'
        : (xIsMeasure && yIsMeasure) ? 'vertical'
        : (xDef?.type === 'temporal' && yDef?.type !== 'temporal') ? 'vertical'
        : (yDef?.type === 'temporal' && xDef?.type !== 'temporal') ? 'horizontal'
        : undefined)
    // pointPosition mid: band scales anchor at band 0.5 (both axes — the
    // band term keys on the scale type, not the orientation)
    const ruleXOff = ruleDef.xOffset as number | undefined
    const ruleYOff = ruleDef.yOffset as number | undefined
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef), ...(positionalScaleType(mark, xDef) === 'band' ? { band: 0.5 } : {}), ...(ruleXOff !== undefined ? { offset: ruleXOff } : {}) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef), ...(positionalScaleType(mark, yDef) === 'band' ? { band: 0.5 } : {}), ...(ruleYOff !== undefined ? { offset: ruleYOff } : {}) }
    // (position2Ref: the secondary ref of a band scale sits at the middle of its band too)
    if (x2Def) update.x2 = { scale: 'x', field: aggFieldName(x2Def), ...(xDef != null && positionalScaleType(mark, xDef) === 'band' ? { band: 0.5 } : {}) }
    if (y2Def) update.y2 = { scale: 'y', field: aggFieldName(y2Def), ...(yDef != null && positionalScaleType(mark, yDef) === 'band' ? { band: 0.5 } : {}) }
    // pointPosition2OrSize zeroOrMin (scaledZeroOrMinOrMax): with no explicit
    // x2/y2 (and no width/height encode), the rule spans to scale zero —
    // {value: 0} when the domain definitely contains zero, otherwise the
    // inrange(0, domain) probe signal (nominal/band scales, zero:false)
    if (!x2Def && ruleOrient !== 'vertical' && xDef) update.x2 = zeroOrMinRef('x')
    if (!y2Def && ruleOrient !== 'horizontal' && yDef) update.y2 = zeroOrMinRef('y')
    // rule paint plumbing: size maps to strokeWidth (rule.ts nonPosition);
    // filled rules paint with fill and drop the stroke; the rest pass through
    const ruleSize = markSize
    if (ruleSize != null) update.strokeWidth = { value: ruleSize }
    if (ruleDef.strokeWidth !== undefined && update.strokeWidth === undefined) update.strokeWidth = { value: ruleDef.strokeWidth }
    if (ruleDef.strokeDash !== undefined) update.strokeDash = { value: ruleDef.strokeDash }
    if (ruleDef.fillOpacity !== undefined) update.fillOpacity = { value: ruleDef.fillOpacity }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    if (ruleDef.filled === true) {
      update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? ruleFill ?? cfgFill ?? cfgColor ?? 'black' }
      delete update.stroke
    }
  } else if (mark === 'text') {
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? 'black' }
    const textStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const tStroke = textStroke ?? cfgStroke
    if (tStroke != null) update.stroke = { value: tStroke }
    const thetaDefT = fields.find((f) => f.channel === 'theta' && f.field)
    const radiusDefT = fields.find((f) => f.channel === 'radius' && f.field)
    if (thetaDefT || radiusDefT) {
      // polar text (pie labels): anchored at the view center, offset by
      // radius along theta
      update.x = { signal: 'width', mult: 0.5 }
      update.y = { signal: 'height', mult: 0.5 }
      polarPointPositions(update, spec, fields, polarStackOf(fields, mark))
      const mRadius = isObject(spec.mark) ? (spec.mark.radius as number | undefined) : undefined
      if (mRadius != null && !radiusDefT) update.radius = { value: mRadius }
    } else {
      if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
      if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    }
    const textDef = fields.find((f) => f.channel === 'text')
    if (textDef?.field) {
      update.text = { signal: fieldTextExpr(textDef, { lineBreaks: false, spec }) }
    } else if (textDef && (textDef.raw as { value?: unknown }).value !== undefined) {
      update.text = { value: String((textDef.raw as { value?: unknown }).value) }
    } else if (!textDef && isObject(spec.mark) && spec.mark.text !== undefined) {
      // the mark def's own `text` (vega-lite passes every mark def property of the Vega mark set through)
      update.text = { value: spec.mark.text }
    }
    // (the defaults give way to the named styles of the mark: markDef.style over config.style)
    const styleNames = isObject(spec.mark) ? ([] as unknown[]).concat((spec.mark.style as unknown) ?? []) : []
    const styleDefines = (prop: string): boolean => {
      const styles = isObject((spec.config as Record<string, unknown> | undefined)?.style) ? ((spec.config as Record<string, Record<string, unknown>>).style as Record<string, unknown>) : {}
      return styleNames.some((n) => typeof n === 'string' && isObject(styles[n]) && (styles[n] as Record<string, unknown>)[prop] !== undefined)
    }
    // (a config value reaches Vega through config.style, so it replaces the default without being repeated in the encoding)
    const configDefines = (prop: string): boolean => ((spec.config as Record<string, Record<string, unknown>> | undefined)?.text?.[prop] ?? (spec.config as Record<string, Record<string, unknown>> | undefined)?.mark?.[prop]) !== undefined
    if (!styleDefines('align') && !configDefines('align') && !(isObject(spec.mark) && spec.mark.align !== undefined)) update.align = { value: 'center' }
    if (!styleDefines('baseline') && !configDefines('baseline') && !(isObject(spec.mark) && spec.mark.baseline !== undefined)) update.baseline = { value: 'middle' }
    const mFontSize = isObject(spec.mark) ? (spec.mark.fontSize as number | undefined) : undefined
    if (mFontSize != null) update.fontSize = { value: mFontSize }
    const mFontWeight = isObject(spec.mark) ? (spec.mark.fontWeight as unknown) : undefined
    if (mFontWeight != null) update.fontWeight = { value: mFontWeight }
    // pass-through text mark props (probed: size maps to fontSize, radius to
    // the polar radius; the paint/offset props go straight through)
    const markPaint = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
    const textProp = (p: string): unknown => markPaint?.[p] ?? cfgType?.[p] ?? cfgMark?.[p]
    const textOuterRadius = textProp('outerRadius')
    if (textOuterRadius != null) update.radius = { value: textOuterRadius }
    const textCfgSize = (cfgType?.size as number | undefined) ?? (cfgMark?.size as number | undefined)
    if (markPaint?.size != null) update.fontSize = { value: markPaint.size }
    else if (textCfgSize != null) update.fontSize = { value: textCfgSize }
    if (sizeDef) update.fontSize = { scale: 'size', field: aggFieldName(sizeDef) }
    for (const p of ['strokeWidth', 'dx', 'dy', 'fillOpacity', 'opacity', 'angle', 'baseline', 'align', 'limit', 'fontStyle', 'lineHeight'] as const) {
      // (the mark's own value is encoded; config.text / config.mark values are config.style's, Vega applies them)
      const v = p === 'dx' || p === 'dy' || p === 'baseline' || p === 'align' ? markPaint?.[p] : textProp(p)
      if (v !== undefined) update[p] = { value: v }
    }
    const textFilled = markPaint?.filled ?? cfgType?.filled ?? cfgMark?.filled
    if (textFilled === false) {
      const tf = update.fill
      update.fill = { value: 'transparent' }
      update.stroke = tf
    } else if (textFilled === true) {
      const ts = update.stroke
      if (ts != null) { delete update.stroke; update.fill = ts }
    }
    if (markPaint?.outerRadius != null) update.radius = { value: markPaint.outerRadius }
  } else if (mark === 'arc') {
    const thetaDefA = fields.find((f) => f.channel === 'theta' && f.field)
    update.fill = markFill != null
      ? { value: markFill }
      : colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? cfgFill ?? cfgColor ?? C.blue }
    const arcStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const aStroke = arcStroke ?? cfgStroke
    if (aStroke != null) update.stroke = { value: aStroke }
    const arcFilled = isObject(spec.mark) && spec.mark.filled !== undefined
      ? spec.mark.filled
      : (cfgType?.filled ?? cfgMark?.filled)
    if (arcFilled === false) {
      const ac = update.fill
      delete update.fill
      update.stroke = ac
    }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    const cfgArcX = (cfgType?.x as number | undefined) ?? (cfgMark?.x as number | undefined)
    const cfgArcY = (cfgType?.y as number | undefined) ?? (cfgMark?.y as number | undefined)
    update.x = cfgArcX != null ? { value: cfgArcX } : { signal: 'width', mult: 0.5 }
    update.y = cfgArcY != null ? { value: cfgArcY } : { signal: 'height', mult: 0.5 }
    const arcMark = spec.mark
    // (valueref.ts signalOrValueRef: a mark def value is a constant, an expression or a signal is a signal)
    const markRef = (v: unknown): Record<string, unknown> => (isObject(v) && typeof v.expr === 'string' ? { signal: v.expr } : isObject(v) && typeof v.signal === 'string' ? { signal: v.signal } : { value: v })
    const mOuter = isObject(arcMark) ? (arcMark.outerRadius ?? arcMark.radius) : undefined
    const mInner = (isObject(arcMark) ? (arcMark.innerRadius ?? arcMark.radius2) : undefined)
      ?? (cfgType?.innerRadius as number | undefined)
      ?? (cfgType?.radius2 as number | undefined)
      ?? (cfgMark?.innerRadius as number | undefined)
    // outerRadius resolves markDef.outerRadius ?? markDef.radius ??
    // config.arc.outerRadius ?? config.arc.radius ?? the half-extent signal
    update.outerRadius = mOuter != null
      ? markRef(mOuter)
      : ((cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined)) != null
        ? { value: (cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined) }
        : { signal: 'min(width,height)/2' }
    update.innerRadius = mInner != null ? markRef(mInner) : { value: (cfgType?.innerRadius as number | undefined) ?? 0 }
    // theta and radius are rectangles in polar coordinates (arc.ts: rectPosition for each); with neither channel the angles are the mark definition's
    const polarHandled = polarRectPositions(update, spec, fields, polarStackOf(fields, mark), markRef, mInner)
    if (!polarHandled.has('theta') && isObject(arcMark) && (arcMark.theta !== undefined || arcMark.theta2 !== undefined)) {
      // no theta channel: the angles are the mark def's (rangePosition: theta, then position2orSize for theta2)
      if (arcMark.theta !== undefined) update.startAngle = markRef(arcMark.theta)
      if (arcMark.theta2 !== undefined) update.endAngle = markRef(arcMark.theta2)
    }
  } else if (mark === 'trail') {
    // trail: a stroked-by-size line — fill default, size channel/def, sorted
    // along the dimension (probed)
    update.fill = colorDef
      ? { scale: 'color', field: aggFieldName(colorDef) }
      : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    for (const p of ['strokeWidth', 'strokeDash', 'strokeCap', 'fillOpacity', 'blend'] as const) {
      if (isObject(spec.mark) && (spec.mark as Record<string, unknown>)[p] !== undefined) update[p] = { value: (spec.mark as Record<string, unknown>)[p] }
    }
    const trailStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    if (trailStroke != null) update.stroke = { value: trailStroke }
    if (isObject(spec.mark) && spec.mark.filled === false) {
      update.stroke = { value: trailStroke ?? markColor ?? cfgStroke ?? cfgColor ?? C.blue }
      update.fill = { value: 'transparent' }
    }
    if (markSize != null) update.size = { value: markSize }
    if (sizeDef) update.size = { scale: 'size', field: aggFieldName(sizeDef) }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    { const dfn = definedSignal(spec, fields, mark); if (dfn !== undefined) update.defined = dfn }
  } else if (mark === 'geoshape') {
    // vega-lite mark/geoshape.ts: baseEncodeEntry with colour included (a filled mark: bar's colour rules);
    // the shape itself is drawn by the `geoshape` transform below, from the projection
    const markDef = isObject(spec.mark) ? spec.mark : undefined
    const filled = markIsFilled(spec, mark)
    if (!filled) {
      update.fill = { value: 'transparent' }
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: (markDef?.stroke as string | undefined) ?? (cfgType?.stroke as string | undefined) ?? (cfgMark?.stroke as string | undefined) ?? markColor ?? C.blue }
    } else {
      update.fill = markDef?.fill != null
        ? { value: markDef.fill }
        : colorDef
          ? { scale: 'color', field: aggFieldName(colorDef) }
          : { value: (cfgType?.fill as string | undefined) ?? (cfgMark?.fill as string | undefined) ?? (cfgType?.color as string | undefined) ?? (cfgMark?.color as string | undefined) ?? markColor ?? C.blue }
      const stroke = markDef?.stroke ?? cfgType?.stroke ?? cfgMark?.stroke
      if (stroke != null) update.stroke = { value: stroke }
    }
    // an explicit null (`fill: null`, the usual way to draw an outline only) is the mark def's own value
    if (markDef && markDef.fill === null) update.fill = { value: null }
    if (markDef && markDef.stroke === null) update.stroke = { value: null }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    update.ariaRoleDescription = { value: 'geoshape' }
  } else {
    throw new Error(`[aster/vl] mark type not supported yet: ${mark}`)
  }

  // position `value` channels are pixels; `datum` channels (flagged by a sentinel
  // field) map the constant through the channel's scale
  {
    const datums = new Map<string, unknown>()
    for (const f of fields) if (f.datumOnly) datums.set(f.channel, f.datum)
    patchDatumRefs(update, datums)
    const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
    for (const ch of ['x', 'y', 'x2', 'y2'] as const) {
      const d = enc[ch]
      if (isObject(d) && d.value !== undefined && d.field === undefined && d.datum === undefined) {
        // (tick.ts: the thickness axis of a tick is positioned by its centre, `xc` / `yc`)
        const thickness = mark === 'tick' && ch === (orient === 'horizontal' ? 'y' : 'x')
        update[thickness ? `${ch}c` : ch] = { value: d.value }
      }
    }
  }
  // (a map unit's positions come from its geopoint output, never from a default)
  if (!GEO_UNITS.has(spec)) {
    const md0 = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
    // position-point.ts pointPositionDefaultRef: the mark def's x / y position a point-placed mark that has no such channel
    if (mark === 'point' || mark === 'circle' || mark === 'square' || mark === 'text') {
      for (const [ch, edge] of [['x', 'width'], ['y', 'height']] as const) {
        const v = md0[ch]
        if (v !== undefined && update[ch] === undefined && update[`${ch}c`] === undefined) update[ch] = v === edge ? { field: { group: edge } } : { value: v }
      }
    }
    fillMissingPositions(update, mark, fields, orient, scaleConfigOf(spec), ruleOrientOut, typeof md0.size === 'number' && md0.size !== 0 ? md0.size : isObject(md0.size) && (typeof md0.size.signal === 'string' || typeof md0.size.expr === 'string') ? { signal: (md0.size.signal ?? md0.size.expr) as string } : undefined, markOrient(spec, mark, spec.mark, fields) === undefined)
  }

  {
    // markDef.ariaRoleDescription (vega-lite getMarkPropOrConfig): what a composite mark's parts call themselves
    const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
    const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
    const ard = md.ariaRoleDescription ?? (isObject(cfg[mark]) ? (cfg[mark] as Record<string, unknown>).ariaRoleDescription : undefined) ?? (isObject(cfg.mark) ? (cfg.mark as Record<string, unknown>).ariaRoleDescription : undefined)
    if (typeof ard === 'string' && cfg.aria !== false && md.aria !== false) update.ariaRoleDescription = { value: ard }
  }
  applyTextualChannels(update, spec, fields, (d) => d.stack === 'normalize' && ((d.channel === 'theta' && mark === 'arc' && !d.aggregate) || isStacked(d, mark, orient, fields)))

  // data-driven opacity, stroke width and stroke dash reach every mark
  for (const prop of ['opacity', 'strokeWidth', 'strokeDash', 'angle']) {
    const def = fields.find((f) => f.channel === prop && f.field && !f.datumOnly)
    if (def && !(isObject(update[prop]) && 'scale' in (update[prop] as object))) update[prop] = { scale: prop, field: aggFieldName(def) }
  }

  // constant and conditional encodings of the non-position channels: a
  // `value` is the constant, `condition` entries ({test, value|field}) come
  // first, then the main reference (vega-lite wrapCondition)
  applyNonPositionConstants(update, spec, fields, mark)

  // mark-def paint/geometry properties pass straight through to the mark
  // encode (vega-lite's getMarkPropOrConfig resolution): the definition wins
  // over the mark-type config block, which wins over the generic mark block.
  // Explicit per-mark handling above takes precedence.
  const markDefP = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
  const passProp = (p: string): unknown => markDefP?.[p] ?? cfgType?.[p] ?? cfgMark?.[p]
  for (const p of [
    'strokeWidth', 'strokeDash', 'strokeCap', 'strokeJoin', 'strokeMiterLimit',
    'strokeOpacity', 'fillOpacity', 'opacity', 'angle', 'blend', 'cursor',
    'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight',
    'cornerRadiusBottomLeft', 'cornerRadiusBottomRight', 'padAngle', 'smooth', 'aspect',
  ]) {
    const v = passProp(p)
    if (v !== undefined && update[p] === undefined) update[p] = { value: v }
  }
  // (base.ts markDefProperties: every Vega mark property the mark def sets is the mark's own, an expression as a signal; the text ones
  // are the mark def's alone - a config value reaches Vega through config.style)
  for (const p of ['font', 'fontStyle', 'fontWeight', 'dir', 'ellipsis', 'limit', 'lineBreak', 'lineHeight', 'startAngle', 'endAngle', 'tension', 'strokeOffset', 'strokeDashOffset', 'shape', ...(mark === 'arc' ? ['radius'] : [])]) {
    const v = markDefP?.[p]
    if (v !== undefined && update[p] === undefined) update[p] = isObject(v) && typeof v.signal === 'string' ? { signal: v.signal } : { value: v }
  }
  // aria.ts ariaRoleDescription: `config.aria: false` leaves the role description out, whatever the mark def says
  if ((isObject(spec.config) ? (spec.config as Record<string, unknown>).aria : undefined) === false) delete update.ariaRoleDescription
  // a link: markDef.href is the mark's href, and any href (mark, config or channel) makes the cursor a pointer
  if (markDefP?.href !== undefined && update.href === undefined) update.href = { value: markDefP.href }
  if ((update.href !== undefined || passProp('href') !== undefined) && update.cursor === undefined) update.cursor = { value: 'pointer' }
  // markDef.xOffset/yOffset shift the corresponding positional channels
  // (including their secondary endpoint and centered forms) — probed.
  const xOff = markDefP?.xOffset as number | undefined
  const yOff = markDefP?.yOffset as number | undefined
  const withOffset = (ch: string, off: number): void => {
    const enc = update[ch] as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = off
  }
  const x2Off = markDefP?.x2Offset as number | undefined
  const y2Off = markDefP?.y2Offset as number | undefined
  // a secondary offset moves only its own endpoint and takes precedence over xOffset/yOffset there
  // (the implicit baseline / stack-start endpoint of a bar or area is not an x2 / y2 channel and stays put)
  if (x2Off !== undefined && fields.some((f) => f.channel === 'x2')) withOffset('x2', x2Off)
  if (y2Off !== undefined && fields.some((f) => f.channel === 'y2')) withOffset('y2', y2Off)
  if (xOff !== undefined) for (const ch of ['x', 'x2', 'xc']) withOffset(ch, xOff)
  // a rule's baseline endpoint stays at zero; only its value endpoint shifts
  if (yOff !== undefined) for (const ch of mark === 'rule' ? ['y', 'yc'] : ['y', 'y2', 'yc']) withOffset(ch, yOff)
  // a stacked measure is positioned at the end of its stack on every mark that does not lay out the stack itself
  // (position-point.ts positionRef: `stack && channel === stack.fieldChannel` reads the `_end` field)
  if (mark !== 'bar' && mark !== 'rect' && mark !== 'area' && mark !== 'arc') {
    for (const pos of ['x', 'y'] as const) {
      const def = fields.find((f) => f.channel === pos && f.field && !f.datumOnly)
      if (!def || !isStacked(def, mark, orient, fields)) continue
      for (const key of [pos, `${pos}c`]) {
        const ref = update[key] as Record<string, unknown> | undefined
        if (isObject(ref) && ref.scale === pos && (ref.field === aggFieldName(def) || ref.field === `${aggFieldName(def)}_end`)) {
          // positionRef: a bandPosition on the stacked channel places the mark within its stack segment
          const bp = def.bandPosition
          const f = aggFieldName(def)
          update[key] = bp === undefined
            ? { ...ref, field: `${f}_end` }
            : bp === 0 || bp === 1
              ? { ...ref, field: `${f}_${bp === 0 ? 'start' : 'end'}` }
              : { signal: `scale(${JSON.stringify(pos)}, ${1 - bp} * datum[${JSON.stringify(`${f}_start`)}] + ${bp} * datum[${JSON.stringify(`${f}_end`)}])`, ...(ref.offset !== undefined ? { offset: ref.offset } : {}) }
        }
      }
    }
  }
  // an xOffset / yOffset CHANNEL on a point-positioned mark (compile/mark/encode/offset.ts positionOffset): the position is
  // offset by the offset scale's value, centred in its band, and sits at the start of its own band (bandPosition 0). Bars and
  // rects lay their offset out through the band geometry above.
  if (OFFSET_POINT_MARKS.has(mark)) {
    for (const [pos, offCh] of [['x', 'xOffset'], ['y', 'yOffset']] as const) {
      const offDef = fields.find((f) => f.channel === offCh && f.field)
      const ref = (update[pos] ?? update[`${pos}c`]) as Record<string, unknown> | undefined
      if (!offDef || !ref || ref.scale !== pos || ref.field === undefined) continue
      delete ref.band
      ref.offset = { scale: offCh, field: aggFieldName(offDef), ...(isDiscreteType(offDef.type) && ['bar', 'rect', 'image', 'rule', 'tick'].includes(mark) ? { band: 0.5 } : {}) }
    }
  }
  // a binned field on a point-positioned mark sits at the middle of its bin (valueref.ts midPoint / interpolatedSignalRef:
  // bandPosition 0.5 over a continuous scale), not at the bin start; so does a binned size / opacity / ... through its scale,
  // and a time unit with a band position (the field's own, or the mark config's timeUnitBandPosition) sits at that point of its unit
  if (BIN_MID_MARKS.has(mark)) {
    const midpoint = (node: unknown, scaleName: string, start: string, end: string, bp: number): unknown => {
      if (Array.isArray(node)) return node.map((x) => midpoint(x, scaleName, start, end, bp))
      if (!isObject(node) || node.scale !== scaleName || node.field !== start) return node
      return {
        ...(bp === 1
          ? { scale: scaleName, field: end }
          : { signal: `scale(${JSON.stringify(scaleName)}, ${1 - bp} * datum[${JSON.stringify(start)}] + ${bp} * datum[${JSON.stringify(end)}])` }),
        ...(node.offset !== undefined ? { offset: node.offset } : {}),
      }
    }
    for (const def of fields) {
      if (!def.field || def.datumOnly || def.channel === 'row' || def.channel === 'column' || def.channel === 'facet') continue
      const timeBand = def.tu && def.type === 'temporal' && (def.channel === 'x' || def.channel === 'y')
      if (!def.bin && !timeBand) continue
      const bp = def.bin ? (def.bandPosition ?? 0.5) : bandPositionOf(spec, mark, def, fields.some((g) => g.channel === `${def.channel}2`))
      if (!bp) continue
      const scaleName = def.channel
      const discrete = def.channel === 'x' || def.channel === 'y'
        ? ['band', 'point'].includes(positionalScaleType(mark, def))
        : def.channel === 'color' ? (def.scale?.type === undefined || def.scale.type === 'bin-ordinal') && def.type === 'quantitative'
          : isDiscreteType(def.type) || def.channel === 'shape' || def.channel === 'strokeDash'
      if (discrete) continue
      const names = def.bin ? binNames(def.binParams!, def.field) : { start: timeUnitField(def), end: `${timeUnitField(def)}_end` }
      if (usesBinMid(spec, def, mark, fields)) {
        // (valueref.ts midPoint: a stacked, imputed dimension reads the precomputed bin middle)
        for (const key of Object.keys(update)) {
          const ref = update[key]
          if (isObject(ref) && ref.scale === scaleName && ref.field === names.start) update[key] = { ...ref, field: binMidName(def) }
        }
        continue
      }
      for (const key of Object.keys(update)) update[key] = midpoint(update[key], scaleName, names.start, names.end, bp)
    }
  }
  // arc polar offsets apply to the angles/radius channels (those a polar channel drives carry theirs already)
  const thetaOff = fields.some((f) => f.channel === 'theta' && f.field) ? undefined : markDefP?.thetaOffset as number | undefined
  if (thetaOff !== undefined) {
    for (const ch of ['startAngle', 'endAngle']) {
      const enc = update[ch] as Record<string, unknown> | undefined
      if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = thetaOff
    }
  }
  const radiusOff = fields.some((f) => f.channel === 'radius' && f.field) ? undefined : markDefP?.radiusOffset as number | undefined
  if (radiusOff !== undefined) {
    const enc = update.outerRadius as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = radiusOff
    const enc2 = update.innerRadius as Record<string, unknown> | undefined
    if (enc2 && typeof enc2 === 'object' && enc2.offset === undefined && typeof enc2.value === 'number' && enc2.value > 0) enc2.offset = radiusOff
  }

  // maps: longitude / latitude positions are the geopoint transform's output fields (no scale, no offset)
  const geo = GEO_UNITS.get(spec)
  if (geo) applyGeoPositions(update, spec, mark, ruleOrientOut)

  const markSpec: Record<string, unknown> = {
    name: 'marks',
    type: mark === 'bar' || mark === 'tick' ? 'rect' : mark === 'point' || mark === 'circle' || mark === 'square' ? 'symbol' : mark === 'geoshape' ? 'shape' : mark,
    style: [mark, ...(isObject(spec.mark) ? ([] as string[]).concat((spec.mark.style as string | string[] | undefined) ?? []) : [])],
    from: { data: dataName },
    encode: { update },
  }
  // markDef.clip / markDef.aria are properties of the Vega mark itself
  if (isObject(spec.mark)) {
    if (typeof spec.mark.clip === 'boolean') markSpec.clip = spec.mark.clip
    if (typeof spec.mark.aria === 'boolean') markSpec.aria = spec.mark.aria
  }
  // a projection that does not fit the data (the author gave its scale / translate) can draw outside the
  // view: vega-lite clips such a unit (mark.ts projectionClip), unless the mark def says otherwise
  if (geo && !geo.isFit && markSpec.clip === undefined) markSpec.clip = true
  // the geoshape mark draws the projected shape of each datum
  if (mark === 'geoshape' && geo) markSpec.transform = [geoshapeTransform(spec, geo)]
  {
    // config.mark.aria / config.<mark>.aria: false hides the mark from the accessibility tree (vega-lite getMarkGroups)
    const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
    const own = isObject(spec.mark) ? (spec.mark as Record<string, unknown>).aria : undefined
    const fromCfg = (isObject(cfg[mark]) ? (cfg[mark] as Record<string, unknown>).aria : undefined) ?? (isObject(cfg.mark) ? (cfg.mark as Record<string, unknown>).aria : undefined)
    if (own === undefined && fromCfg === false) markSpec.aria = false
  }
  if (isObject(spec.mark) && spec.mark.$image) {
    // an image mark carries no paint; its bands are not floored at the rect minimum
    markSpec.type = 'image'
    markSpec.style = ['image']
    for (const k of ['fill', 'stroke', 'ariaRoleDescription']) delete update[k]
    for (const k of ['width', 'height']) {
      const w = update[k] as { signal?: string } | undefined
      if (w?.signal) w.signal = w.signal.replace(/^max\(0\.25, (.*)\)$/, '$1')
    }
  }
  // order: an explicit order channel wins; otherwise vega-lite sorts a
  // line/area by its dimension channel NAME (Vega then sorts scene items by
  // that item position), not by the datum field. Trail sorts by x (probed).
  const markSortSpec = markSort(spec, fields, mark, orient)
  if (markSortSpec) markSpec.sort = markSortSpec

  // a `scale: null` channel reads its field as it is: no scale in the reference
  for (const f of crossPaint) update[f.paint!] = { field: aggFieldName(f) }
  for (const f of fields) {
    if (!f.noScale) continue
    const scaleName = f.channel === 'fill' || f.channel === 'stroke' ? 'color' : f.channel
    const strip = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(strip); return }
      if (isObject(v) && v.scale === scaleName) delete v.scale
    }
    for (const v of Object.values(update)) strip(v)
  }

  // color.ts: `nonPosition('fill')` and `nonPosition('stroke')` come after the colour and, when the encoding has no fill / stroke of its
  // own, read the mark definition's: the definition's paint is what the mark has, whatever the colour channel said (a hover line
  // drawn transparent over the colour-conditioned lines)
  {
    const own = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
    for (const ch of ['fill', 'stroke'] as const) {
      const v = own[ch]
      if (v === undefined || fields.some((f) => f.channel === ch)) continue
      update[ch] = isObject(v) && typeof v.signal === 'string' ? { signal: v.signal } : isObject(v) && typeof v.expr === 'string' ? { signal: v.expr } : { value: v }
    }
  }

  const out: BuiltMarks = [markSpec]

  // rounded stacked bars: vega-lite clips the whole stack in a group that carries the
  // corner radii, so only the outer ends of a stack are rounded (not every segment)
  if (mark === 'bar' && !xOffsetPresent && !yOffsetPresent) {
    const measureDef = orient === 'vertical' ? yDef : xDef
    const dimDef = orient === 'vertical' ? xDef : yDef
    const cornerKeys = Object.keys(update).filter((k) => k.startsWith('cornerRadius'))
    // vega-lite getMarkPropOrConfig is truthy only for a non-zero radius, and a size channel disables the group
    const hasRadius = cornerKeys.some((k) => {
      const e = update[k] as Record<string, unknown> | undefined
      return isObject(e) && ('signal' in e || Boolean(e.value))
    })
    if (hasRadius && !fields.some((f) => f.channel === 'size') && measureDef && dimDef && isStacked(measureDef, mark, orient, fields)) {
      const v = orient === 'vertical'
      const mc = v ? 'y' : 'x'
      const dc = v ? 'x' : 'y'
      const start = `${aggFieldName(measureDef)}_start`
      const end = `${aggFieldName(measureDef)}_end`
      const ext = (op: string, f: string): string => `scale('${mc}',datum[${JSON.stringify(`${op}_${f}`)}])`
      const extents = `${ext('min', start)},${ext('max', start)},${ext('min', end)},${ext('max', end)}`
      const groupUpdate: Record<string, unknown> = {}
      for (const k of v ? ['x', 'x2', 'xc', 'width'] : ['y', 'y2', 'yc', 'height']) {
        if (update[k] !== undefined) {
          groupUpdate[k] = update[k]
          delete update[k]
        }
      }
      groupUpdate[mc] = { signal: `min(${extents})` }
      groupUpdate[`${mc}2`] = { signal: `max(${extents})` }
      groupUpdate.clip = { value: true }
      // mark.ts getStackGroup: the stroke properties are the group's too (the outline is drawn on the clipped group, in front)
      for (const prop of ['stroke', 'strokeWidth', 'strokeJoin', 'strokeCap', 'strokeDash', 'strokeDashOffset', 'strokeMiterLimit', 'strokeOpacity']) {
        if (update[prop] !== undefined) groupUpdate[prop] = update[prop]
      }
      if (groupUpdate.stroke) {
        groupUpdate.strokeForeground = { value: true }
        groupUpdate.strokeOffset = { value: 0 }
      }
      const ownMarkDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
      for (const k of cornerKeys) {
        groupUpdate[k] = update[k]
        delete update[k]
        // a radius that came from config would still reach the rect through vega's own mark config: zero it
        if (ownMarkDef[k] === undefined && ownMarkDef.cornerRadiusEnd === undefined) update[k] = { value: 0 }
      }
      delete update.clip
      update[v ? 'width' : 'height'] = { field: { group: v ? 'width' : 'height' } }
      markSpec.from = { data: 'stack_group_main' }
      out[0] = {
        type: 'group',
        from: {
          facet: {
            data: dataName,
            name: 'stack_group_main',
            // (a binned / time-unit dimension also groups by the end of its band)
            groupby: dimDef.bin ? [aggFieldName(dimDef), binNames(dimDef.binParams!, dimDef.field).end] : dimDef.tu ? [aggFieldName(dimDef), `${aggFieldName(dimDef)}_end`] : [aggFieldName(dimDef)],
            aggregate: { fields: [start, start, end, end], ops: ['min', 'max', 'min', 'max'] },
          },
        },
        encode: { update: groupUpdate },
        marks: [{
          type: 'group',
          encode: { update: { [mc]: { field: { group: mc }, mult: -1 }, [v ? 'width' : 'height']: { field: { group: v ? 'width' : 'height' } } } },
          marks: [markSpec],
        }],
      }
      void dc
    }
  }

  // line / area / trail split by their grouping channels (colour, detail, size for lines, ...):
  // one path per group, drawn by a group faceted on those fields (vega-lite pathGroupingFields)
  const pathDetails = mark === 'line' || mark === 'area' || mark === 'trail' ? pathGroupingKeys(spec, fields, mark) : []
  if (pathDetails.length) {
    markSpec.name = 'layer_0_marks'
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: pathDetails,
        },
      },
      encode: {
        update: {
          width: { field: { group: 'width' } },
          height: { field: { group: 'height' } },
        },
      },
      marks: [{
        name: 'marks',
        type: markSpec.type,
        style: [mark],
        ...(markSpec.clip !== undefined ? { clip: markSpec.clip } : {}),
        ...(markSpec.aria !== undefined ? { aria: markSpec.aria } : {}),
        ...(markSortSpec ? { sort: markSortSpec } : {}),
        from: { data: 'faceted_path_main' },
        encode: { update },
      }],
    }
    out[0] = group
  }

  // datum references that landed in copies of `update` (series groups, overlays)
  {
    const datums = new Map<string, unknown>()
    for (const f of fields) if (f.datumOnly) datums.set(f.channel, f.datum)
    if (datums.size) patchDatumRefs(out, datums)
  }
  // user overrides: encoding.update-style custom encodings are out of scope here
  void spec
  return out
}


/** timeunit.ts offsetExpr: the end of a binned time unit, one step of its smallest part after the field. */
function binnedEndExpr(tu: NormalTimeUnit, field: string): string {
  const parts = getTimeUnitParts(tu.unit)
  const smallest = parts[parts.length - 1]!
  const step = tu.step ?? 1
  const { part, mult } = smallest === 'quarter' ? { part: 'month', mult: 3 } : smallest === 'dayofyear' ? { part: 'date', mult: 1 } : { part: smallest, mult: 1 }
  return `${tu.utc ? 'utcOffset' : 'timeOffset'}('${part}', datum['${field.replaceAll("'", "\\'")}'], ${step * mult})`
}

/** timeunit.ts offsetedRectFormulas (and offsetExpr): the start and end positions of a rect off the middle of its time-unit band. */
function offsettedRectFormulas(startField: string, rectBandPosition: number, tu: NormalTimeUnit): Record<string, unknown>[] {
  const endField = `${startField}_end`
  const start = `datum[${JSON.stringify(startField).replace(/"/g, "'")}]`
  const end = `datum[${JSON.stringify(endField).replace(/"/g, "'")}]`
  const parts = getTimeUnitParts(tu.unit)
  const smallest = parts[parts.length - 1]!
  // getDateTimePartAndStep: quarter is three months, a week is one 'week' part
  const step = tu.step ?? 1
  const { part, mult } = smallest === 'quarter' ? { part: 'month', mult: 3 } : smallest === 'dayofyear' ? { part: 'date', mult: 1 } : { part: smallest, mult: 1 }
  const offset = `${tu.utc ? 'utcOffset' : 'timeOffset'}('${part}', ${start}, ${-step * mult})`
  const interpolate = (a: string, b: string, fraction: number): string => `${1 - fraction} * ${a} + ${fraction} * ${b}`
  return [
    { type: 'formula', expr: interpolate(offset, start, rectBandPosition + 0.5), as: `${startField}_offsetted_rect_start` },
    { type: 'formula', expr: interpolate(start, end, rectBandPosition + 0.5), as: `${startField}_offsetted_rect_end` },
  ]
}

/**
 * stack.ts `impute` + data/stack.ts: a binned dimension of a stacked area / line / trail is imputed (zero-filled) and stacked
 * over the bin's middle, a `<bin>_mid` field computed ahead of the impute.
 */
function binMidName(def: FieldDef): string {
  return `${binNames(def.binParams!, def.field).start}_mid`
}
function usesBinMid(spec: VLSpec, def: FieldDef | undefined, mark: string, fields: FieldDef[]): boolean {
  if (!def || !def.bin || (def.channel !== 'x' && def.channel !== 'y') || !(mark === 'area' || mark === 'line' || mark === 'trail')) return false
  const orient = inferOrient(spec, mark, spec.mark, fields)
  return fields.some((f) => (f.channel === 'x' || f.channel === 'y') && f.channel !== def.channel && isStacked(f, mark, orient, fields))
}

/** vega-lite `getMarkConfig(prop, mark, config)`: config.<mark>.<prop> over config.mark.<prop>. */
function markConfigProp(spec: VLSpec, mark: string, prop: string): unknown {
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  const ofType = isObject(cfg[mark]) ? (cfg[mark] as Record<string, unknown>)[prop] : undefined
  return styleConfigProp(spec, mark, prop) ?? ofType ?? (isObject(cfg.mark) ? (cfg.mark as Record<string, unknown>)[prop] : undefined)
}

/**
 * common.ts getMarkStyleConfig: the value a named style gives a mark property. The styles of a mark are its type, then
 * `mark.style`; a later one wins. It comes before the mark-type and the mark config (getMarkConfig).
 */
function styleConfigProp(spec: VLSpec, mark: string, prop: string): unknown {
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  const styles = isObject(cfg.style) ? (cfg.style as Record<string, unknown>) : undefined
  if (!styles) return undefined
  const names = [mark, ...(isObject(spec.mark) ? ([] as unknown[]).concat(spec.mark.style ?? []) : [])]
  let value: unknown
  for (const n of names) {
    const st = typeof n === 'string' ? styles[n] : undefined
    if (isObject(st) && st[prop] !== undefined) value = st[prop]
  }
  return value
}

const RECT_BASED_MARKS = new Set(['rect', 'bar', 'image', 'arc', 'tick'])

/**
 * vega-lite `getBandPosition`: where in its band a time-unit / binned value sits. The field's own `bandPosition`, else
 * (time unit with no secondary channel) the mark config's `timeUnitBandPosition` - 0.5 on rect, bar and tick -, else 0.5 for a
 * binned field.
 */
function bandPositionOf(spec: VLSpec, mark: string, def: FieldDef, hasSecondary: boolean): number | undefined {
  if (def.bandPosition !== undefined) return def.bandPosition
  if (def.tu && !hasSecondary) {
    const configured = markConfigProp(spec, mark, 'timeUnitBandPosition')
    if (typeof configured === 'number') return configured
    return mark === 'bar' || mark === 'rect' || mark === 'tick' ? 0.5 : undefined
  }
  if (def.bin && !isPrebinned(def)) return 0.5
  return undefined
}

/** The names of the start / end fields of a time-unit or binned def; a rect off the band middle reads the offsetted ones. */
function rectBandFields(def: FieldDef, useRectOffsetField: boolean): { start: string; end: string; bandEnd?: string } {
  if (def.bin) {
    const bn = binNames(def.binParams!, def.field)
    // (position-rect.ts rectBinPosition measures the band on `<field>_end` whatever the secondary field is called)
    return { start: bn.start, end: bn.end, ...(isPrebinned(def) ? { bandEnd: `${def.field}_end` } : {}) }
  }
  const start = timeUnitField(def)
  return useRectOffsetField ? { start: `${start}_offsetted_rect_start`, end: `${start}_offsetted_rect_end` } : { start, end: `${start}_end` }
}


/**
 * position-rect.ts positionAndSize for the band channel of a bar / tick, in the cases that carry a relative band size (a mark
 * `width` / `height` of `{band}`) or an offset channel: the position (aligned to the top / middle of the band, by the band size
 * and the offset) and the size (a share of the offset scale's or the position scale's bandwidth). Returns null where the plain
 * rules of the caller apply (an absolute size, a size channel, ...).
 */
function positionAndSizeRefs(ch: 'x' | 'y', def: FieldDef | undefined, spec: VLSpec, mark: string, fields: FieldDef[]): Record<string, unknown> | null {
  const offsetCh = ch === 'x' ? 'xOffset' : 'yOffset'
  const offDef = fields.find((f) => f.channel === offsetCh && f.field && !f.datumOnly)
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  const sizeProp = ch === 'x' ? 'width' : 'height'
  const sizeVal = md[sizeProp] ?? md.size ?? markConfigProp(spec, mark, sizeProp) ?? markConfigProp(spec, mark, 'size')
  const relative = isObject(sizeVal) && typeof sizeVal.band === 'number'
  if (!relative && !offDef) return null
  // (an absolute size with an offset channel: the mark is centred on its offset sub-band at that size, sizeMixins of positionAndSize)
  const absolute = !relative && offDef !== undefined && typeof sizeVal === 'number' && sizeVal !== 0
  if (sizeVal !== undefined && !relative && !absolute) return null
  if (fields.some((f) => f.channel === 'size' && f.field)) return null
  if (def && def.bin) return null
  const hasSecondary = fields.some((f) => f.channel === `${ch}2` && f.field)
  if (hasSecondary) return null
  const scaleType = def ? positionalScaleType(mark, def) : undefined
  const offsetBand = offDef && isDiscreteType(offDef.type) && ['bar', 'rect', 'image', 'rule', 'tick'].includes(mark)
  const offsetType = offDef ? (isDiscreteType(offDef.type) ? (offsetBand ? 'band' : 'point') : 'linear') : undefined
  // channeldef.ts getBandSize
  let band: number
  if (absolute) band = 1
  else if (relative) band = (sizeVal as { band: number }).band
  else if (def?.tu) band = typeof markConfigProp(spec, mark, 'timeUnitBandSize') === 'number' ? (markConfigProp(spec, mark, 'timeUnitBandSize') as number) : 1
  else if (['band', 'point'].includes(scaleType ?? offsetType ?? '')) band = 1
  else return null
  // defaultSizeRef: a share of the offset scale's (else the position scale's) bandwidth
  const sizeScale = offDef ? offsetCh : def ? ch : undefined
  const sizeScaleType = offDef ? offsetType : scaleType
  const minBandSize = typeof markConfigProp(spec, mark, 'minBandSize') === 'number' ? (markConfigProp(spec, mark, 'minBandSize') as number) : 0.25
  let size: Record<string, unknown>
  if (absolute) size = { value: sizeVal }
  else if (sizeScale && sizeScaleType === 'band') {
    const bandwidth = band !== 1 ? `${band} * bandwidth('${sizeScale}')` : `bandwidth('${sizeScale}')`
    size = { signal: minBandSize ? `max(${minBandSize}, ${bandwidth})` : bandwidth }
  } else if (!sizeScale) size = { mult: band, field: { group: sizeProp } }
  else return null
  // the aligned position channel
  const alignProp = ch === 'x' ? 'align' : 'baseline'
  const align = md[alignProp] ?? markConfigProp(spec, mark, alignProp)
  // (the band size is relative here whatever its source: a band scale aligns to the top / left of its band)
  const top = !absolute && (scaleType ?? offsetType) === 'band'
  const vgChannel = ch === 'x'
    ? ({ left: 'x', center: 'xc', right: 'x2' } as Record<string, string>)[String(align ?? (top ? 'left' : 'center'))]
    : ({ top: 'y', middle: 'yc', bottom: 'y2' } as Record<string, string>)[String(align ?? (top ? 'top' : 'middle'))]
  if (!vgChannel) return null
  const center = vgChannel === 'xc' || vgChannel === 'yc'
  // positionOffset: an offset channel (centred in its band), else the mark's visual offset
  let offset: unknown
  let offsetKind: 'encoding' | 'visual' | undefined
  if (offDef) {
    offsetKind = 'encoding'
    offset = { scale: offsetCh, field: aggFieldName(offDef), ...(offsetType === 'band' && center ? { band: 0.5 } : {}) }
  } else if (md[`${ch}Offset`]) {
    offsetKind = 'visual'
    offset = md[`${ch}Offset`]
  }
  const timeBp = center && offsetKind !== 'encoding' && def?.tu && !hasSecondary ? bandPositionOf(spec, mark, def, hasSecondary) : undefined
  const bandPosition = timeBp ?? (center ? (offsetKind === 'encoding' ? 0 : 0.5) : (1 - band) / 2)
  let pos: Record<string, unknown>
  if (!def) pos = { signal: sizeProp, mult: 0.5, ...(offset ? { offset } : {}) }
  else if (def.tu && def.type === 'temporal' && bandPosition && bandPosition !== 0 && !isDiscreteType(def.type)) {
    const start = timeUnitField(def)
    pos = bandPosition === 1
      ? { scale: ch, field: `${start}_end`, ...(offset ? { offset } : {}) }
      : { signal: `scale("${ch}", ${1 - bandPosition} * datum[${JSON.stringify(start)}] + ${bandPosition} * datum[${JSON.stringify(`${start}_end`)}])`, ...(offset ? { offset } : {}) }
  } else {
    pos = {
      scale: ch,
      field: aggFieldName(def),
      ...(offset ? { offset } : {}),
      ...(scaleType === 'band' && bandPosition ? { band: bandPosition } : {}),
    }
  }
  return { [vgChannel]: pos, [sizeProp]: size }
}

/**
 * A binned / time-unit-binned rect position: the end value on the main channel and
 * the start on the secondary, each nudged by the axis translate (0.5) plus half the
 * bin spacing (or, when the bin is thinner than minBandSize, half the shortfall) -
 * vega-lite `getBinSpacing`. `x` and `y2` are the "end" channels.
 */
function setBinnedRect(update: Record<string, unknown>, ch: 'x' | 'y', def: FieldDef, spec: VLSpec, mark: string, hasSecondary = false): void {
  const geometry = binGeometry(spec, mark)
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  const sizeProp = ch === 'x' ? 'width' : 'height'
  // channeldef.ts getBandSize: the mark's own relative band, else the time unit's (config.timeUnitBandSize, 1) or the whole bin
  const markSize = md[sizeProp] ?? (isObject((spec.config as Record<string, unknown> | undefined)?.[mark]) ? ((spec.config as Record<string, Record<string, unknown>>)[mark]!)[sizeProp] : undefined)
  const sizeBand = isObject(markSize) && typeof markSize.band === 'number'
    ? markSize.band
    : def.tu && !hasSecondary ? (typeof markConfigProp(spec, mark, 'timeUnitBandSize') === 'number' ? (markConfigProp(spec, mark, 'timeUnitBandSize') as number) : 1) : 1
  const bandPositionForBandSize = (1 - sizeBand) / 2
  const bandPosition = bandPositionOf(spec, mark, def, hasSecondary)
  const useRectOffsetField = def.tu !== undefined && bandPosition !== 0.5
  const { start, end } = rectBandFields(def, useRectOffsetField)
  // the size of the band is read from the plain start / end of the value, whatever the position fields are
  const plain = rectBandFields(def, false)
  const band = `abs(scale("${ch}", datum[${JSON.stringify(plain.bandEnd ?? plain.end)}]) - scale("${ch}", datum[${JSON.stringify(plain.start)}]))`
  const minBandSize = geometry.minBandSize
  // position-rect.ts getBinSpacing: the axis translate, the scale's reverse, the mark's visual offset and the spacing
  const axisObj = isObject(def.axis) ? def.axis : undefined
  const translate = axisObj?.translate ?? 0.5
  const cfgScale = isObject((spec.config as Record<string, unknown> | undefined)?.scale) ? ((spec.config as Record<string, Record<string, unknown>>).scale as Record<string, unknown>) : {}
  let reverse: unknown = def.scale?.reverse
  if (reverse === undefined && def.sort === 'descending' && !isDiscreteType(def.type)) reverse = true
  if (reverse === undefined && ch === 'x' && cfgScale.xReverse !== undefined) reverse = cfgScale.xReverse
  const offsetOf = (k: string): unknown => md[k]
  const isSignal = (v: unknown): v is { signal: string } => isObject(v) && typeof v.signal === 'string'
  // position-rect.ts getBinSpacing. `signalOrStringValue` of a number is the number itself, so a zero translate / reverse / offset is
  // falsy and leaves its term out; with no signal and no minBandSize at all the result is a plain number
  const termOf = (v: unknown): string => (isSignal(v) ? v.signal : isObject(v) && typeof v.expr === 'string' ? v.expr : v ? String(v) : '')
  const offsetFor = (isEnd: boolean, offset: unknown): { signal: string } | number => {
    const spacingOffset = (isEnd ? -geometry.spacing / 2 : geometry.spacing / 2) + 0 // + 0: never "-0"
    if (isSignal(reverse) || isSignal(offset) || isSignal(translate) || minBandSize) {
      const sign = isEnd ? '' : '-'
      const spacingAndSizeOffset = minBandSize ? `(${band} < ${minBandSize} ? ${sign}0.5 * (${minBandSize} - (${band})) : ${spacingOffset})` : String(spacingOffset)
      const t = termOf(translate) ? `${termOf(translate)} + ` : ''
      const r = termOf(reverse) ? `(${termOf(reverse)} ? -1 : 1) * ` : ''
      const offsetExpr = termOf(offset)
      const o = offsetExpr ? `(${offsetExpr} + ${spacingAndSizeOffset})` : spacingAndSizeOffset
      return { signal: `${t}${r}${o}` }
    }
    const off = typeof offset === 'number' ? offset : 0
    return (translate as number) + (reverse ? -off - spacingOffset : +off + spacingOffset)
  }
  // interpolatedSignalRef: the start (position 0), the end (1) or a point between them
  const interpolated = (bp: number, offset: { signal: string } | number): Record<string, unknown> => {
    // (a zero offset is no offset)
    const off = offset === 0 ? {} : { offset }
    if (bp === 0 || bp === 1) return { scale: ch, field: bp === 0 ? start : end, ...off }
    return { signal: `scale("${ch}", ${1 - bp} * datum[${JSON.stringify(start)}] + ${bp} * datum[${JSON.stringify(end)}])`, ...off }
  }
  const offset1 = offsetOf(`${ch}Offset`)
  const offset2 = offsetOf(`${ch}2Offset`) ?? offset1
  update[ch] = interpolated(1 - bandPositionForBandSize, offsetFor(ch === 'x', offset1))
  update[`${ch}2`] = interpolated(bandPositionForBandSize, offsetFor(ch === 'y', offset2))
}
function binGeometry(spec: VLSpec, mark: string): { spacing: number; minBandSize: number } {
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  const cfgType = isObject(cfg[mark]) ? (cfg[mark] as Record<string, unknown>) : {}
  const cfgMark = isObject(cfg.mark) ? (cfg.mark as Record<string, unknown>) : {}
  const pick = (k: string): number | undefined => {
    const v = md[k] ?? cfgType[k] ?? cfgMark[k]
    return typeof v === 'number' ? v : undefined
  }
  return { spacing: pick('binSpacing') ?? (mark === 'bar' ? 1 : 0), minBandSize: pick('minBandSize') ?? 0.25 }
}

/**
 * vega-lite's `zeroOrMin` baseline for the secondary end of a continuous rect / bar / area / rule (scaledZeroOrMinOrMax): it reads the
 * scale the channel ends up with (`domainHasZero`), which is not known while the marks are built. The reference is written as the
 * 'definitely' form and noted here; `resolveZeroOrMin` rewrites it, once the view's scales are assembled.
 */
const LAZY_ZERO_OR_MIN = new WeakMap<object, string>()
function zeroOrMinRef(ch: string, _def?: FieldDef | undefined, _mark?: string): Record<string, unknown> {
  void _def
  void _mark
  const ref: Record<string, unknown> = { scale: ch, value: 0 }
  LAZY_ZERO_OR_MIN.set(ref, ch)
  return ref
}

/** The reference scaledZeroOrMinOrMax writes for a scale: zero, the probe, or the domain's start. */
function zeroOrMinOf(name: string, sc: ScaleSpec | undefined): Record<string, unknown> {
  const has = sc ? domainHasZero(sc) : 'definitely'
  return has === 'definitely' ? { scale: name, value: 0 }
    : has === 'maybe' ? { signal: `scale('${name}', inrange(0, domain('${name}')) ? 0 : domain('${name}')[0])` }
    : { signal: `scale('${name}', domain('${name}')[0])` }
}

/** Rewrite the zeroOrMin references of these marks (in place) from the scales the view ended up with (a reference names its scale). */
function resolveZeroOrMin(marks: Record<string, unknown>[], scales: ScaleSpec[]): void {
  const rewrite = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(rewrite); return }
    if (!isObject(v) || !LAZY_ZERO_OR_MIN.has(v)) return
    LAZY_ZERO_OR_MIN.delete(v)
    const name = v.scale as string
    const ref = zeroOrMinOf(name, scales.find((sc) => sc.name === name))
    for (const k of Object.keys(v)) delete v[k]
    Object.assign(v, ref)
  }
  const visit = (m: Record<string, unknown>): void => {
    const update = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
    if (update) for (const v of Object.values(update)) rewrite(v)
    for (const c of (m.marks as Record<string, unknown>[] | undefined) ?? []) visit(c)
  }
  marks.forEach(visit)
}

/**
 * Maps: the positions of a mark with `longitude` / `latitude` channels (vega-lite
 * mark/encode/position-point.ts and position-range.ts). A position the author did not give as x / y /
 * x2 / y2 is the geopoint transform's output field; no scale is involved and no offset applies.
 */
function applyGeoPositions(update: Record<string, unknown>, spec: VLSpec, mark: string, ruleOrient: string | undefined): void {
  const geo = GEO_UNITS.get(spec)
  if (!geo || mark === 'geoshape') return
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const has = (c: string): boolean => enc[c] != null
  if (!has('latitude') && !has('longitude')) return
  const out = (c: string): { field: string } => ({ field: `${geo.prefix}${c}` })
  // pointPosition: x and y
  for (const ch of ['x', 'y'] as const) if (!has(ch)) update[ch] = out(ch)
  if (mark === 'rule') {
    // a rule is a line segment (both ranges) unless it is vertical (no x2) or horizontal (no y2)
    for (const [ch, range] of [['x', ruleOrient !== 'vertical'], ['y', ruleOrient !== 'horizontal']] as const) {
      if (!range || has(ch)) continue
      update[`${ch}2`] = out(`${ch}2`)
    }
  }
}

/**
 * A mark with a position channel missing needs an explicit default on that
 * axis: real Vega leaves an absent x/y at 0 (the top-left corner), whereas
 * vega-lite centers points/lines/text, stretches rules/rects/areas across the
 * group, and centers ticks/bars with a fractional size. (The same defaults
 * hold for a channel that is only a datum/value.)
 */
/** Does the unit encode the channel at all (a field, a datum or a constant value)? */
function hasEncodingChannel(spec: VLSpec, channel: string): boolean {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  return enc[channel] != null
}

function fillMissingPositions(update: Record<string, unknown>, mark: string, fields: FieldDef[], orient: string, scaleCfg: ScaleCfg, ruleOrient?: string, explicitSizeRaw?: number | { signal: string }, orientUndefined = false): void {
  // (a mark def size is a number or an expression, which vega-lite emits as a signal reference)
  const explicitSize = explicitSizeRaw
  const has = (...ks: string[]): boolean => ks.some((k) => update[k] !== undefined)
  const hasX = has('x', 'xc', 'x2')
  const hasY = has('y', 'yc', 'y2')
  if (hasX && hasY) return
  if (mark === 'arc' || fields.some((f) => f.channel === 'theta' || f.channel === 'radius')) return
  const midX = { signal: 'width', mult: 0.5 }
  const midY = { signal: 'height', mult: 0.5 }
  const groupW = { field: { group: 'width' } }
  const groupH = { field: { group: 'height' } }
  switch (mark) {
    case 'point': case 'circle': case 'square': case 'text': case 'line': case 'trail':
      if (!hasX) update.x = midX
      if (!hasY) update.y = midY
      break
    case 'tick':
      // (tick.ts: the size axis is x of a horizontal tick and y of a vertical one; a size of the mark def is its length there)
      // (the other axis is the thickness axis: pointPosition centres it and `thickness` is its extent, set by the mark)
      if (!hasX) { update.xc = midX; if (orient === 'horizontal') update.width = explicitSize !== undefined ? (typeof explicitSize === 'number' ? { value: explicitSize } : explicitSize) : { signal: '0.75 * width' } }
      if (!hasY) { update.yc = midY; if (orient !== 'horizontal') update.height = explicitSize !== undefined ? (typeof explicitSize === 'number' ? { value: explicitSize } : explicitSize) : { signal: '0.75 * height' } }
      break
    case 'bar': {
      // position-rect.ts rectPosition: the band channel of the orientation (x of a vertical bar, y of a horizontal one) is
      // centred with a size of (1 - barBandPaddingInner) of the view (defaultSizeRef); the other channel is a range from
      // zeroOrMax to zeroOrMin, i.e. the whole view
      const padding = (scaleCfg.bandPaddingInner ?? scaleCfg.barBandPaddingInner) as number | undefined
      // (a size of the mark def or the encoding is the band's size: positionAndSize, `sizeMixins`)
      const span = (size: 'width' | 'height'): unknown => (explicitSize !== undefined ? (typeof explicitSize === 'number' ? { value: explicitSize } : explicitSize) : typeof padding === 'number' ? { signal: `${1 - padding} * ${size}` } : { value: 18 })
      // (a bar with no orientation - neither axis is a measure - has no band channel: both missing ones are ranges)
      if (!hasX) {
        if (orient === 'vertical' && !orientUndefined) { update.xc = midX; update.width = span('width') } else { update.x = groupW; update.x2 = { value: 0 } }
      }
      if (!hasY) {
        if (orient === 'horizontal') { update.yc = midY; update.height = span('height') } else { update.y = { value: 0 }; update.y2 = groupH }
      }
      break
    }
    case 'area':
      if (!hasX) update.x = { value: 0 }
      if (!hasY) update.y = groupH
      break
    case 'rect':
      if (!hasX) { update.x = groupW; update.x2 = { value: 0 } }
      if (!hasY) { update.y = { value: 0 }; update.y2 = groupH }
      break
    case 'rule':
      // rule.ts: a missing x is zeroOrMax (the whole width, x2 at zero) for a horizontal rule and the middle otherwise
      // (with an x2 unless the rule is vertical); a missing y likewise for a vertical rule
      if (!hasX && !hasY) break // (a rule with neither x nor y shows nothing)
      if (!hasX) {
        if (ruleOrient === 'horizontal') { update.x = groupW; update.x2 = { value: 0 } } else { update.x = midX; if (ruleOrient !== 'vertical') update.x2 = { value: 0 } }
      }
      if (!hasY) {
        if (ruleOrient === 'vertical') { update.y = { value: 0 }; update.y2 = groupH } else { update.y = midY; if (ruleOrient !== 'horizontal') update.y2 = groupH }
      }
      break
  }
}

/**
 * The text a field def shows (vega-lite formatSignalRef / addLineBreaksToTooltip): dates through
 * timeFormat, numbers through format, strings as themselves (arrays joined by `sep`).
 */
/** vega-lite's default `config.timeFormat` for raw temporal values. */
const DEFAULT_TIME_FORMAT = '%b %d, %Y'

/** vega-lite `isCustomFormatType`: any format type but the two built in ones. */
function isCustomFormatType(formatType: unknown): formatType is string {
  return typeof formatType === 'string' && formatType !== '' && formatType !== 'number' && formatType !== 'time'
}

/** vega-lite `customFormatExpr`: `price(<field>, "<format>")`, calling the function registered under that name. */
function customFormatExpr(formatType: string, field: string, format: unknown): string {
  return `${formatType}(${field}${format ? `, ${JSON.stringify(format)}` : ''})`
}

/** vega-lite `BIN_RANGE_DELIMITER` */
const BIN_RANGE_DELIMITER = ' \u2013 '

/** vega-lite format.ts `binFormatExpression`: `start – end` of a bin, `"null"` when the bin has no valid start. */
function binFormatExpr(startField: string, endField: string, format: unknown, formatType: string | undefined, cfg: { numberFormat?: string; numberFormatType?: string; customFormatTypes?: boolean } | undefined): string {
  if (format === undefined && formatType === undefined && cfg?.customFormatTypes === true && cfg.numberFormatType) {
    return binFormatExpr(startField, endField, cfg.numberFormat, cfg.numberFormatType, cfg)
  }
  const one = (field: string): string => (isCustomFormatType(formatType)
    ? customFormatExpr(formatType, field, format)
    : `format(${field}, ${JSON.stringify((typeof format === 'string' ? format : undefined) ?? cfg?.numberFormat ?? '')})`)
  return `!isValid(${startField}) || !isFinite(+${startField}) ? "null" : ${one(startField)} + ${JSON.stringify(BIN_RANGE_DELIMITER)} + ${one(endField)}`
}

/**
 * vega-lite `getFormatMixins`: the format of a def that has `format` / `formatType` itself (text, tooltip, ...), else the
 * one of its guide (a position channel's axis, a mark property's legend).
 */
function defFormat(def: FieldDef): { format: string | undefined; formatType: string | undefined } {
  const raw = def.raw as Record<string, unknown>
  if ('format' in raw || 'formatType' in raw) return { format: raw.format as string | undefined, formatType: raw.formatType as string | undefined }
  const guide = isObject(def.axis) ? def.axis : isObject(def.legend) ? def.legend : undefined
  return { format: guide?.format as string | undefined, formatType: guide?.formatType as string | undefined }
}

function fieldTextExpr(def: FieldDef, opts: { lineBreaks: boolean; spec: VLSpec; expr?: 'datum' | 'parent'; format?: string; formatType?: string; normalizeStack?: boolean }): string {
  // (a binned field is shown from its bin's start and end, never from the `_range` text that positions it)
  const name = def.bin ? binNames(def.binParams!, def.field).start : aggFieldName(def)
  const refOf = (n: string): string => (opts.expr === 'parent' ? `parent[${JSON.stringify(n)}]` : dref(n))
  // a normalized stack shows its share: end - start (vega-lite fieldToFormat)
  const f = opts.normalizeStack ? `${refOf(`${name}_end`)}-${refOf(`${name}_start`)}` : refOf(name)
  const { format: guideFmt, formatType: guideFmtType } = defFormat(def)
  const fmt = opts.format ?? guideFmt
  const formatType = opts.formatType ?? guideFmtType
  // addLineBreaksToTooltip comes first: a discrete field (a binned one included) shows its own value, line breaks joined
  if (opts.lineBreaks && (def.type === 'nominal' || def.type === 'ordinal') && def.tu === undefined && opts.format === undefined && guideFmt === undefined && guideFmtType === undefined) {
    const raw = refOf(def.field)
    return `isValid(${raw}) ? isArray(${raw}) ? join(${raw}, '\\n') : ${raw} : ""+${raw}`
  }
  const binEnd = def.bin ? refOf(binNames(def.binParams!, def.field).end) : ''
  const binCfg = (opts.spec.config as { numberFormat?: string; numberFormatType?: string; customFormatTypes?: boolean } | undefined)
  // vega-lite formatSignalRef
  if (isCustomFormatType(formatType)) return def.bin ? binFormatExpr(f, binEnd, fmt, formatType, binCfg) : customFormatExpr(formatType, f, fmt)
  const cfg = opts.spec.config as { timeFormat?: string; numberFormat?: string; customFormatTypes?: boolean; numberFormatType?: string; timeFormatType?: string } | undefined
  if (fmt === undefined && formatType === undefined && cfg?.customFormatTypes === true) {
    const normalizedType = (cfg as { normalizedNumberFormatType?: string }).normalizedNumberFormatType
    // (vega-lite's custom types read the field itself, not the share `end - start` the built-in format shows)
    const own = refOf(name)
    if (def.type === 'quantitative' && opts.normalizeStack && typeof normalizedType === 'string') return customFormatExpr(normalizedType, own, (cfg as { normalizedNumberFormat?: string }).normalizedNumberFormat)
    if (def.type === 'quantitative' && typeof cfg.numberFormatType === 'string') return def.bin ? binFormatExpr(own, binEnd, cfg.numberFormat, cfg.numberFormatType, binCfg) : customFormatExpr(cfg.numberFormatType, own, cfg.numberFormat)
    if (def.type === 'temporal' && typeof cfg.timeFormatType === 'string' && def.tu === undefined) return customFormatExpr(cfg.timeFormatType, f, cfg.timeFormat)
  }
  // a time format: formatType "time", or no formatType and a temporal field / a time unit
  const timeFormatted = formatType === 'time' || (formatType === undefined && (def.type === 'temporal' || def.tu !== undefined))
  if (timeFormatted) {
    // (timeFormatExpression: a UTC time unit, or a utc scale, formats in UTC)
    const timeFn = def.tu?.utc || def.scale?.type === 'utc' ? 'utcFormat' : 'timeFormat'
    if (def.tu && fmt === undefined) return `${timeFn}(${f}, ${timeUnitFormatSignal(def.tu.unit)})`
    // (vega-lite's timeFormatExpression: config.timeFormatType applies to a raw time with no format)
    if (def.tu === undefined && typeof cfg?.timeFormatType === 'string') return customFormatExpr(cfg.timeFormatType, f, fmt)
    // (timeFormatExpression: only a string format is used - an object one, a per-unit axis format, falls back to config.timeFormat)
    return `${timeFn}(${f}, ${JSON.stringify(typeof fmt === 'string' ? fmt : cfg?.timeFormat ?? DEFAULT_TIME_FORMAT)})`
  }
  if (def.bin) return binFormatExpr(f, binEnd, fmt, formatType, binCfg)
  if (opts.normalizeStack && (def.type === 'quantitative' || typeof fmt === 'string')) {
    return `format(${f}, ${JSON.stringify((typeof fmt === 'string' ? fmt : undefined) ?? (binCfg as { normalizedNumberFormat?: string } | undefined)?.normalizedNumberFormat ?? '.0%')})`
  }
  if (def.type === 'quantitative' || (def.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(def.aggregate))) {
    return `format(${f}, ${JSON.stringify(fmt ?? cfg?.numberFormat ?? '')})`
  }
  if (fmt !== undefined) return `format(${f}, ${JSON.stringify(fmt)})`
  // a geojson shape field is shown as the geometry itself (never joined as an array)
  if (def.type === 'geojson') return `isValid(${f}) ? ${f} : ""+${f}`
  // (vega-lite addLineBreaksToTooltip reads a discrete field by its own name, not the aggregate's: `datum["c"]` for the `max` of c)
  if (opts.lineBreaks && (def.type === 'nominal' || def.type === 'ordinal') && def.tu === undefined && opts.format === undefined && guideFmt === undefined && guideFmtType === undefined) {
    const raw = refOf(def.field)
    return `isValid(${raw}) ? isArray(${raw}) ? join(${raw}, '\\n') : ${raw} : ""+${raw}`
  }
  return opts.lineBreaks
    ? `isValid(${f}) ? isArray(${f}) ? join(${f}, '\\n') : ${f} : ""+${f}`
    : `isValid(${f}) ? ${f} : ""+${f}`
}

/** tooltip / href / description fields (vega-lite mark/encode/tooltip.ts, text.ts). */
function applyTextualChannels(update: Record<string, unknown>, spec: VLSpec, fields: FieldDef[], normalizedStack: (d: FieldDef) => boolean = () => false): void {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  const tooltipTitle = (d: FieldDef): string => {
    // tooltip.ts add(): `fieldDef.title || defaultTitle(fieldDef)` - an empty or null title falls back to the default
    const t = channelTitle(d.title ? d : { ...d, title: undefined })
    return (Array.isArray(t) ? t.join(', ') : String(t)).replace(/"/g, '\\"')
  }
  /** tooltip.ts tooltipData: the end of a pre-binned position is shown with its start (`start – end`), not on its own. */
  const prebinnedEnd = (f: FieldDef): boolean => (f.channel === 'x2' || f.channel === 'y2') && fields.some((m) => m.channel === f.channel[0] && isPrebinned(m))
  /** vega-lite tooltipData: one `title -> text expression` per field, the first of a title wins. */
  const objectEntries = (defs: FieldDef[], s: VLSpec = spec): Array<[string, string]> => {
    const seen = new Set<string>()
    const out: Array<[string, string]> = []
    for (const d of defs) {
      const key = tooltipTitle(d)
      if (seen.has(key)) continue
      seen.add(key)
      // a secondary channel's def has no type of its own: it takes its main channel's (vega-lite tooltipData)
      const main = SECONDARY_MAIN[d.channel] !== undefined ? defs.find((m) => m.channel === SECONDARY_MAIN[d.channel]) ?? fields.find((m) => m.channel === SECONDARY_MAIN[d.channel]) : undefined
      const typed = main !== undefined && main.type !== d.type ? { ...d, type: main.type } : d
      out.push([key, fieldTextExpr(typed, { lineBreaks: true, spec: s, normalizeStack: normalizedStack(d) })])
    }
    return out
  }
  const objectOf = (defs: FieldDef[]): string | undefined => {
    const kv = objectEntries(defs, tipSpec).map(([key, value]) => `"${key}": ${value}`)
    return kv.length ? `{${kv.join(', ')}}` : undefined
  }
  // tooltip (getMarkPropOrConfig: the mark definition, then config.<mark>, then config.mark)
  const tipCfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  // tooltip.ts tooltipData: the formats are the config's overlaid by config.tooltipFormat
  const tipSpec: VLSpec = isObject(tipCfg.tooltipFormat) ? { ...spec, config: { ...tipCfg, ...tipCfg.tooltipFormat } } : spec
  const tipMark = isObject(spec.mark) ? String((spec.mark as Record<string, unknown>).type) : String(spec.mark)
  const markTooltip = md.tooltip ?? (isObject(tipCfg[tipMark]) ? (tipCfg[tipMark] as Record<string, unknown>).tooltip : undefined) ?? (isObject(tipCfg.mark) ? (tipCfg.mark as Record<string, unknown>).tooltip : undefined)
  const tipDefs = fields.filter((f) => f.channel === 'tooltip' && !f.datumOnly)
  if (Array.isArray(enc.tooltip)) {
    const o = objectOf(tipDefs)
    if (o) update.tooltip = { signal: o }
  } else if (tipDefs.length === 1 && isObject(enc.tooltip) && (enc.tooltip as Record<string, unknown>).field !== undefined) {
    update.tooltip = { signal: fieldTextExpr(tipDefs[0]!, { lineBreaks: true, spec }) }
  } else if (enc.tooltip === undefined && markTooltip !== undefined && markTooltip !== false && markTooltip !== null) {
    const t = markTooltip
    if (t === true || (isObject(t) && t.content === 'encoding')) {
      const o = objectOf(fields.filter((f) => !f.datumOnly && f.field && f.channel !== 'tooltip' && f.channel !== 'row' && f.channel !== 'column' && f.channel !== 'facet' && !prebinnedEnd(f)))
      if (o) update.tooltip = { signal: o }
    } else if (typeof t === 'string') update.tooltip = { value: t }
    else if (isObject(t) && t.content === 'data') update.tooltip = { signal: 'datum' }
    else if (isObject(t) && typeof t.expr === 'string') update.tooltip = { signal: t.expr }
    else throw new VLCompileError(`mark.tooltip: unsupported form ${JSON.stringify(t)}`)
  }
  // href / description
  for (const ch of ['href', 'description', 'url'] as const) {
    const d = fields.find((f) => f.channel === ch && !f.datumOnly)
    if (d && isObject(enc[ch]) && (enc[ch] as Record<string, unknown>).field !== undefined) update[ch] = { signal: fieldTextExpr(d, { lineBreaks: false, spec }) }
  }
  // description (vega-lite mark/encode/aria.ts): the channel (above), else the mark's / config's own, else a summary of
  // the encoded fields, `title: text; title: text` -- the screen-reader text of every item
  if (update.description === undefined && !isObject(enc.description)) {
    const mt = isObject(spec.mark) ? String((spec.mark as Record<string, unknown>).type) : String(spec.mark)
    const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
    const pick = (prop: string): unknown => md[prop] ?? (isObject(cfg[mt]) ? (cfg[mt] as Record<string, unknown>)[prop] : undefined) ?? (isObject(cfg.mark) ? (cfg.mark as Record<string, unknown>)[prop] : undefined)
    if (pick('aria') !== false) {
      const own = pick('description')
      if (own != null) update.description = isObject(own) && typeof own.signal === 'string' ? { signal: own.signal } : { value: own }
      else if (cfg.aria !== false) {
        // (in vega-lite's channel order, initEncoding's walk over UNIT_CHANNELS, not the order the spec wrote them in)
        const rank = (f: FieldDef): number => { const i = UNIT_CHANNEL_ORDER.indexOf(f.channel); return i < 0 ? UNIT_CHANNEL_ORDER.length : i }
        const defs = fields.filter((f) => !f.datumOnly && f.field && f.channel !== 'description' && f.channel !== 'row' && f.channel !== 'column' && f.channel !== 'facet' && !prebinnedEnd(f))
          .map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f)
        const sig = objectEntries(defs, tipSpec).filter(([key]) => !key.startsWith('_'))
          .map(([key, value]) => `"${key}: " + (${value.replaceAll('\\n', ' ')})`)
          .map((part, i) => (i > 0 ? part.replace(/^"/, '"; ') : part))
          .join(' + ')
        if (sig) update.description = { signal: sig }
      }
    }
  }
}

/** The main channel of each secondary one. */
const SECONDARY_MAIN: Record<string, string> = { x2: 'x', y2: 'y', theta2: 'theta', radius2: 'radius', longitude2: 'longitude', latitude2: 'latitude' }

/** vega-lite `UNIT_CHANNELS`: the order `initEncoding` normalizes the channels in (and so the order their fields are listed). */
const UNIT_CHANNEL_ORDER = [
  'x', 'y', 'x2', 'y2', 'theta', 'theta2', 'radius', 'radius2', 'longitude', 'longitude2', 'latitude', 'latitude2', 'xOffset', 'yOffset',
  'color', 'fill', 'stroke', 'time', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape',
  'order', 'text', 'detail', 'key', 'tooltip', 'href', 'url', 'description',
]

const NON_POSITION_CHANNELS = new Set(['color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape', 'text', 'tooltip', 'href', 'description', 'url'])

/** vega-lite defaultFilled: every mark but point, line and rule is filled unless configured. */
function markIsFilled(spec: VLSpec, mark: string): boolean {
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(cfg?.[mark]) ? (cfg![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(cfg?.mark) ? (cfg!.mark as Record<string, unknown>) : undefined
  // vega-lite defaultFilled: a unit drawing a graticule is unfilled unless its mark def says otherwise
  if (GRATICULE_UNITS.has(spec) && typeof md?.filled !== 'boolean') return false
  const v = md?.filled ?? cfgType?.filled ?? cfgMark?.filled
  return typeof v === 'boolean' ? v : mark !== 'point' && mark !== 'line' && mark !== 'rule'
}

/** The Vega encode property a non-position channel writes on a mark. Throws where that mapping is not implemented. */
function vgPropFor(channel: string, mark: string, filled: boolean): string {
  switch (channel) {
    case 'color': return filled ? 'fill' : 'stroke'
    case 'size':
      if (mark === 'point' || mark === 'circle' || mark === 'square' || mark === 'trail') return 'size'
      if (mark === 'text') return 'fontSize'
      if (mark === 'line' || mark === 'rule') return 'strokeWidth'
      throw new VLCompileError(`encoding.size is not supported on the "${mark}" mark`)
    default: return channel
  }
}

function applyNonPositionConstants(update: Record<string, unknown>, spec: VLSpec, fields: FieldDef[], mark: string): void {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const filled = markIsFilled(spec, mark)
  for (const [channel, def] of Object.entries(enc)) {
    if (!isObject(def) || !NON_POSITION_CHANNELS.has(channel)) continue
    const hasCondition = def.condition !== undefined
    const hasValue = def.value !== undefined
    if (!hasCondition && !hasValue) continue
    const prop = vgPropFor(channel, mark, filled)
    const entries: Record<string, unknown>[] = []
    if (hasCondition) {
      for (const c of (Array.isArray(def.condition) ? def.condition : [def.condition]) as Record<string, unknown>[]) {
        const entry: Record<string, unknown> = { test: c.param !== undefined ? predicateWithParams(ctxOf(spec), { param: c.param as string, ...(c.empty !== undefined ? { empty: c.empty as boolean } : {}) }) : predicateWithParams(ctxOf(spec), c.test) }
        if (c.value !== undefined) entry.value = c.value
        else if (c.field !== undefined || c.aggregate === 'count') {
          const target = fields.find((f) => f.channel === channel || ((channel === 'fill' || channel === 'stroke') && f.channel === 'color' && f.paint === channel))
          if (!target) throw new VLCompileError(`encoding.${channel}.condition: the conditional field has no scale`)
          const cf = c.field === undefined ? '__count' : flatField(String(c.field)).key
          if (cf !== target.field && !target.fromCondition) {
            throw new VLCompileError(`encoding.${channel}.condition.field: a conditional field must be the channel's own field or its only conditional field`)
          }
          entry.scale = target.channel
          entry.field = aggFieldName(target)
        } else throw new VLCompileError(`encoding.${channel}.condition: datum conditions are not supported`)
        entries.push(entry)
      }
    }
    // (conditional.ts wrapCondition: a condition-only channel falls back to the mark's default for that property)
    const main: Record<string, unknown> | Record<string, unknown>[] | undefined = hasValue
      ? { value: def.value }
      : (update[prop] as Record<string, unknown> | undefined)
    const parts = main === undefined ? entries : [...entries, ...(Array.isArray(main) ? main : [main])]
    if (parts.length === 0) continue
    // a test-bearing entry must use the array form or Vega never runs the test
    update[prop] = parts.length === 1 && entries.length === 0 ? parts[0] : parts
  }
}

// --- invalid values (vega-lite compile/invalid/*, data/filterinvalid.ts, mark/encode/defined.ts) -----------

type InvalidMode = 'filter' | 'show' | 'break-paths-filter-domains' | 'break-paths-show-domains'
const isPathMark = (mark: string): boolean => mark === 'line' || mark === 'area' || mark === 'trail'

/** The mark's `invalid` mode (markDef, then config[mark], then config.mark), normalized. */
function invalidModeOf(spec: VLSpec, mark: string): InvalidMode {
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : {}
  const blocks = [isObject(spec.mark) ? spec.mark : {}, isObject(cfg[mark]) ? cfg[mark] : {}, isObject(cfg.mark) ? cfg.mark : {}] as Record<string, unknown>[]
  const raw = blocks.find((blk) => blk.invalid !== undefined)?.invalid
  if (raw === undefined || raw === 'break-paths-show-path-domains') return isPathMark(mark) ? 'break-paths-show-domains' : 'filter'
  return raw === null ? 'show' : (raw as InvalidMode)
}

/** A channel with a `config.scale.invalid` value shows invalid data whatever the mark's mode. */
function channelInvalidMode(spec: VLSpec, mark: string, channel: string): InvalidMode {
  const inv = (scaleConfigOf(spec) as { invalid?: Record<string, unknown> }).invalid
  return isObject(inv) && inv[channel] !== undefined ? 'show' : invalidModeOf(spec, mark)
}

const COUNTING_AGGREGATES = new Set(['count', 'valid', 'missing', 'distinct'])
const INVALID_CHANNELS = ['x', 'y', 'theta', 'radius', 'color', 'size', 'opacity', 'strokeWidth', 'angle', 'xOffset', 'yOffset']

/** The fields (keyed by raw field, the last def winning) whose continuous scale can meet an invalid value. */
function invalidCandidates(spec: VLSpec, fields: FieldDef[], mark: string): Array<{ def: FieldDef; mode: InvalidMode }> {
  const byField = new Map<string, { def: FieldDef; mode: InvalidMode }>()
  // (model.reduceFieldDef walks the unit's encoding, which initEncoding rebuilds in the order of channel.ts UNIT_CHANNELS, not the user's)
  const unitOrder = (f: FieldDef): number => UNIT_CHANNEL_ORDER.indexOf(String(f.paint ?? f.channel))
  for (const f of [...fields].sort((a, b) => unitOrder(a) - unitOrder(b))) {
    // (a counting aggregate never outputs an invalid value (isCountingAggregateOp: count, valid, missing, distinct); `scale: null` has no scale)
    if (f.datumOnly || f.noScale || !f.field || !INVALID_CHANNELS.includes(f.channel) || COUNTING_AGGREGATES.has(String(f.aggregate))) continue
    const type = ((f.raw as Record<string, unknown> | undefined)?.type ?? f.type) as string
    if (type !== 'quantitative' && type !== 'temporal') continue
    if (f.channel === 'x' || f.channel === 'y' ? ['band', 'point', 'ordinal'].includes(positionalScaleType(mark, f)) : ['ordinal', 'point'].includes(String(f.scale?.type))) continue
    // scale/type.ts defaultType: a binned quantitative colour is a bin-ordinal scale, a discrete one that takes any value (getScaleInvalidDataMode)
    if (f.channel === 'color' && f.bin && type === 'quantitative' && (f.scale?.type === undefined || f.scale.type === 'bin-ordinal')) continue
    byField.set(f.field, { def: f, mode: channelInvalidMode(spec, mark, f.channel) })
  }
  return [...byField.values()]
}

const invalidFieldName = (f: FieldDef, mid = false): string => (f.bin ? (mid ? binMidName(f) : binNames(f.binParams!, f.field).start) : aggFieldName(f))
const validExprOf = (ref: string): string => `isValid(${ref}) && isFinite(+${ref})`

/**
 * compile/invalid/datasources.ts getDataSourcesForHandlingInvalidValues: whether the marks / the scale domains read the data with the
 * invalid values filtered out.
 */
function invalidDataSources(spec: VLSpec, mark: string): { marks: 'exclude' | 'include'; scales: 'exclude' | 'include' } {
  return dataSourcesOfMode(invalidModeOf(spec, mark), isPathMark(mark))
}

function dataSourcesOfMode(mode: InvalidMode, path: boolean): { marks: 'exclude' | 'include'; scales: 'exclude' | 'include' } {
  if (mode === 'filter') return { marks: 'exclude', scales: 'exclude' }
  if (mode === 'show') return { marks: 'include', scales: 'include' }
  if (mode === 'break-paths-show-domains') return { marks: path ? 'include' : 'exclude', scales: 'include' }
  return { marks: path ? 'include' : 'exclude', scales: 'exclude' }
}

/**
 * scale/domain.ts parseSingleChannelDomain: the data the scale domains ask for, from `getMarkConfig('invalid')` - the config alone, not
 * the mark definition the datasets themselves were made from (so a mark's own `invalid` never changes where its scales read).
 */
function scaleDomainSource(spec: VLSpec, mark: string): 'main' | 'pre' | 'post' {
  const raw = markConfigProp(spec, mark, 'invalid')
  const mode: InvalidMode = raw === undefined || raw === 'break-paths-show-path-domains' ? (isPathMark(mark) ? 'break-paths-show-domains' : 'filter') : raw === null ? 'show' : (raw as InvalidMode)
  const { marks, scales } = dataSourcesOfMode(mode, isPathMark(mark))
  return marks === scales ? 'main' : scales === 'include' ? 'pre' : 'post'
}

/** data/filterinvalid.ts FilterInvalidNode.assemble: the filter on the fields whose scale cannot take an invalid value. */
function invalidFilterExpr(spec: VLSpec, fields: FieldDef[], mark: string): Record<string, unknown> | undefined {
  const { marks, scales } = invalidDataSources(spec, mark)
  if (marks === 'include' && scales === 'include') return undefined
  const checks = invalidCandidates(spec, fields, mark)
    .filter((c) => c.mode !== 'show')
    .map(({ def }) => {
      const ref = `datum[${JSON.stringify(invalidFieldName(def))}]`
      return ((def.raw as Record<string, unknown> | undefined)?.type ?? def.type) === 'temporal' ? `(isDate(${ref}) || (${validExprOf(ref)}))` : validExprOf(ref)
    })
  return checks.length ? { type: 'filter', expr: checks.join(' && ') } : undefined
}

/** The filter that keeps invalid values out of the data (FilterInvalidNode), where the marks must not see them. */
function invalidFilter(spec: VLSpec, fields: FieldDef[], mark: string): Record<string, unknown> | undefined {
  return invalidDataSources(spec, mark).marks === 'exclude' ? invalidFilterExpr(spec, fields, mark) : undefined
}

/**
 * data/parse.ts: when the marks and the scale domains read different data, the scales get a dataset of their own - the rows before the
 * filter (PreFilterInvalid, marks filtered and scales not) or after it (PostFilterInvalid, scales filtered and marks not).
 */
function invalidScaleSplit(spec: VLSpec, fields: FieldDef[], mark: string, mainFilter: Record<string, unknown> | undefined): InvalidScaleSplit | undefined {
  const { marks, scales } = invalidDataSources(spec, mark)
  if (marks === scales) return undefined
  // (the dataset exists only when a scale asks for it: vega-lite drops an output node nothing reads)
  const asked = scaleDomainSource(spec, mark)
  if (marks === 'exclude') return mainFilter && asked === 'pre' ? { kind: 'pre', filter: mainFilter } : undefined
  const filter = invalidFilterExpr(spec, fields, mark)
  return filter && asked === 'post' ? { kind: 'post', filter } : undefined
}

/**
 * Give the scales their own dataset of the rows before / after the invalid filter. `data` holds the datasets of the view (the last
 * one named `mainName` is the marks' one, and for a PreFilterInvalid split ends in the filter); `source` is what that dataset
 * derives from when it holds nothing else.
 */
function splitInvalidData(data: Record<string, unknown>[], split: InvalidScaleSplit, mainName: string, source: string, newName: () => string): { dataName: string; scaleName: string } {
  const at = data.findIndex((d) => d.name === mainName)
  if (split.kind === 'post') {
    const name = newName()
    data.push({ name, source: mainName, transform: [split.filter] })
    return { dataName: mainName, scaleName: name }
  }
  const main = data[at]
  const rest = main ? ((main.transform as Record<string, unknown>[]).filter((t) => t !== split.filter)) : []
  if (!main || rest.length === (main.transform as unknown[]).length) return { dataName: mainName, scaleName: mainName }
  if (rest.length === 0) {
    // nothing but the filter was in it: the scales read what it read
    main.transform = [split.filter]
    return { dataName: mainName, scaleName: (main.source as string | undefined) ?? source }
  }
  main.transform = rest
  const name = newName()
  data.splice(at + 1, 0, { name, source: mainName, transform: [split.filter] })
  return { dataName: name, scaleName: mainName }
}

/** The `defined` signal of a path mark: the fields whose invalid values break the path. */
function definedSignal(spec: VLSpec, fields: FieldDef[], mark: string): unknown {
  const refs = new Set(
    invalidCandidates(spec, fields, mark)
      .filter((c) => c.mode.startsWith('break-paths'))
      .map(({ def }) => `datum[${JSON.stringify(invalidFieldName(def, usesBinMid(spec, def, mark, fields)))}]`),
  )
  return refs.size ? { signal: [...refs].map(validExprOf).join(' && ') } : undefined
}

/** scale/component.ts `domainHasZero`, from the scale this compiler emitted. */
function domainHasZero(sc: ScaleSpec): 'definitely' | 'definitely-not' | 'maybe' {
  if (['log', 'time', 'utc'].includes(sc.type)) return 'definitely-not'
  // (a linear, sqrt or pow scale holds zero unless it says it does not)
  if (sc.zero === true || (sc.zero === undefined && ['linear', 'sqrt', 'pow'].includes(sc.type))) return 'definitely'
  const doms = Array.isArray(sc.domain) ? [sc.domain] : []
  let withZero = false, without = false
  for (const d of doms) { if (typeof d[0] === 'number' && typeof d[d.length - 1] === 'number') { if (d[0] <= 0 && d[d.length - 1] >= 0) withZero = true; else without = true } }
  return withZero ? 'definitely' : without ? 'definitely-not' : 'maybe'
}

/**
 * invalid: "show": a channel whose value is invalid takes the scale's zero-or-min (or the
 * config.scale.invalid value) instead of dropping the datum (mark/encode/invalid.ts).
 */
function showInvalidValues(spec: VLSpec, fields: FieldDef[], mark: string, scales: ScaleSpec[], markSpecs: Record<string, unknown>[], channelFilter: (channel: string) => boolean = () => true): void {
  // (position2Ref / midPointRefWithPositionInvalidTest: a secondary position tests its own field against the main channel's scale)
  const secondary = fields.filter((f) => (f.channel === 'x2' || f.channel === 'y2') && f.field && !f.datumOnly && !f.noScale && !COUNTING_AGGREGATES.has(String(f.aggregate)))
  const cands = [
    ...invalidCandidates(spec, fields, mark).filter((c) => c.mode === 'show' && channelFilter(c.def.channel)),
    ...secondary.filter((f) => channelFilter(f.channel[0]!) && channelInvalidMode(spec, mark, f.channel[0]!) === 'show').map((def) => ({ def, mode: 'show' as InvalidMode })),
  ]
  if (!cands.length) return
  const cfgInvalid = (scaleConfigOf(spec) as { invalid?: Record<string, unknown> }).invalid
  const positional = mark !== 'arc'
  const filled = markIsFilled(spec, mark)
  const visit = (m: Record<string, unknown>): void => {
    if (m.type === 'group') { for (const c of (m.marks as Record<string, unknown>[] | undefined) ?? []) visit(c); return }
    const update = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
    if (!update) return
    for (const { def } of cands) {
      const ch = def.channel
      const scaleCh = ch === 'x2' || ch === 'y2' ? ch[0]! : ch
      if ((scaleCh === 'x' || scaleCh === 'y') ? !positional : !['color', 'size', 'opacity', 'strokeWidth', 'angle'].includes(ch)) continue
      // (a centred bar position is `xc` / `yc`)
      const prop = ch === 'color' ? (isObject(update.fill) && (update.fill as Record<string, unknown>).scale === 'color' || Array.isArray(update.fill) ? 'fill' : 'stroke') : ch === 'size' ? vgPropFor('size', mark, filled) : (ch === 'x' || ch === 'y') && update[ch] === undefined && update[`${ch}c`] !== undefined ? `${ch}c` : ch
      const cur = update[prop]
      const main = (Array.isArray(cur) ? cur[cur.length - 1] : cur) as Record<string, unknown> | undefined
      const sc = scales.find((x) => x.name === scaleCh)
      if (!main || !sc || main.scale !== scaleCh || main.field !== aggFieldName(def)) continue
      const d = `datum[${JSON.stringify(aggFieldName(def))}]`
      const given = cfgInvalid?.[scaleCh]
      const ref = isObject(given) && 'value' in given ? { value: given.value } : zeroOrMinOf(scaleCh, sc)
      const invalid = { test: `!isValid(${d}) || !isFinite(+${d})`, ...ref }
      update[prop] = Array.isArray(cur) ? [...cur.slice(0, -1), invalid, main] : [invalid, main]
    }
  }
  markSpecs.forEach(visit)
}

// --- assembly ----------------------------------------------------------------

// --- maps --------------------------------------------------------------------

/** The geo facts of each unit (or layer leaf) that has a projection, read by buildData and buildMarks. */
const GEO_UNITS = new WeakMap<object, UnitGeo>()
/** The projection component a compiled view fragment owns at its root (a composite may merge it with its siblings'). */
const FRAG_PROJECTION = new WeakMap<object, ProjectionComponent>()
/** The main dataset (in its fragment's own names) of each leaf a projection component's fit reads. */
const HANDLE_MAIN = new WeakMap<object, string>()
/** Units whose OWN data is a graticule generator (vega-lite: `defaultFilled` is false for them). */
const GRATICULE_UNITS = new WeakSet<object>()
const isGraticuleData = (d: unknown): boolean => isObject(d) && d.graticule !== undefined

/** vega-lite `model.getName` prefix of the root view: its `name`, when it has one. */
function rootNamePrefix(spec: VLSpec): string {
  return typeof spec.name === 'string' && spec.name !== '' ? `${signalSafe(spec.name)}_` : ''
}

/** The projection component of one unit, and the geo facts its transforms and mark need. */
function unitProjection(spec: VLSpec, prefix: string, handle: object): ProjectionComponent | undefined {
  const mark = typeof spec.mark === 'string' ? spec.mark : (spec.mark as Record<string, unknown>).type as string
  const encoding = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const config = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const unit: GeoUnit = {
    mark,
    encoding,
    projection: isObject(spec.projection) ? (spec.projection as Record<string, unknown>) : undefined,
    configProjection: isObject(config?.projection) ? (config!.projection as Record<string, unknown>) : undefined,
    prefix,
    handle,
  }
  const component = parseUnitProjection(unit)
  if (component) GEO_UNITS.set(spec, { component, isFit: component.isFit, prefix })
  return component
}

/**
 * The projections of a layered view (vega-lite parseProjection / assembleProjections): each unit's
 * component, merged upwards through the layer tree wherever no property conflicts, assembled in
 * vega-lite's order (a layer's own projection, then its children's).
 */
function planLayerProjections(root: VLSpec, parsed: Array<{ l: VLSpec }>): { root: ProjectionComponent | undefined; assemble: (mainOf: (leaf: VLSpec) => string) => Record<string, unknown>[] } {
  const leafAt = new Map<string, { l: VLSpec; handle: object }>()
  const paths: number[][] = []
  for (const p of parsed) {
    const path = LEAF_PATHS.get(p.l) ?? []
    leafAt.set(path.join('/'), { l: p.l, handle: {} })
    paths.push(path)
  }
  const handleLeaf = new Map<object, VLSpec>()
  for (const { l, handle } of leafAt.values()) handleLeaf.set(handle, l)
  const rootPrefix = rootNamePrefix(root)
  const prefixOf = (path: number[]): string => rootPrefix + path.map((i) => `layer_${i}_`).join('')
  interface PNode { comp?: ProjectionComponent; children: PNode[] }
  const parse = (path: number[]): PNode => {
    const leaf = leafAt.get(path.join('/'))
    if (leaf) return { comp: unitProjection(leaf.l, prefixOf(path), leaf.handle), children: [] }
    const childIdx = [...new Set(paths.filter((q) => q.length > path.length && path.every((v, i) => q[i] === v)).map((q) => q[path.length]!))].sort((a, b) => a - b)
    const children = childIdx.map((i) => parse([...path, i]))
    return { comp: mergeLayerProjections(`${prefixOf(path)}projection`, children.map((c) => c.comp)), children }
  }
  const tree = parse([])
  return {
    root: tree.comp,
    assemble(mainOf) {
      for (const { l, handle } of leafAt.values()) HANDLE_MAIN.set(handle, mainOf(l))
      const out: Record<string, unknown>[] = []
      const visit = (n: PNode): void => {
        if (n.comp) pushAll(out, assembleProjection(n.comp, (h) => mainOf(handleLeaf.get(h)!)))
        for (const c of n.children) visit(c)
      }
      visit(tree)
      return out
    },
  }
}

/** Compile a single unit spec (validated; the input is not mutated). */
export function compileUnit(input: VLSpec): VLSpec {
  const spec = cloneSpec(input)
  validateSpec(spec)
  return compileUnitView(spec, makeCtx(spec))
}

/**
 * vega-lite assembleUnitSelectionData: the timer selection's frame filter (the `filter: {param}` transform) is removed
 * from the main dataset to be the whole of the `<main>_curr` dataset. It is only there to find when the filter is in
 * the main dataset's own transform list: a pipeline that split before it (an aggregate with a sort over the raw
 * table) has the filter in an earlier dataset, which vega-lite does not search.
 */
function extractFrameFilter(data: DataPipeline, selection: string): { filter: Record<string, unknown> } {
  // vega-lite: the first filter of the main dataset that tests a selection (`expr.includes('vlSelectionTest')`)
  const isFrameFilter = (t: Record<string, unknown>): boolean => t.type === 'filter' && typeof t.expr === 'string' && t.expr.includes('vlSelectionTest')
  const at = data.pipeline.findIndex(isFrameFilter)
  if (at < 0) throw new VLCompileError(`transform: the {"filter": {"param": ${JSON.stringify(selection)}}} is not in the unit's data pipeline`)
  if (data.usesRawDomain && data.pipeline.length > data.rawLen && at < data.rawLen) {
    throw new VLCompileError(`transform: the {"filter": {"param": ${JSON.stringify(selection)}}} lands in the pre-aggregation table, not the main dataset; vega-lite 6.4.3 then emits marks that read a frame dataset it never defines`)
  }
  const [filter] = data.pipeline.splice(at, 1) as [Record<string, unknown>]
  if (at < data.rawLen) data.rawLen--
  const i = data.transforms.indexOf(filter)
  if (i >= 0) data.transforms.splice(i, 1)
  return { filter }
}

/**
 * The marks of an animated unit read the frame dataset (the facet of a path group keeps the whole main dataset: vega-lite's
 * `correctDataNames`), and a unit with a point selection is interactive with a pointer cursor.
 */
function animateMarks(marks: Record<string, unknown>[], dataName: string): void {
  for (const m of marks) {
    if (isObject(m.from) && m.from.data === dataName) m.from = { ...m.from, data: `${dataName}_curr` }
    if (m.type === 'group') {
      animateMarks((m.marks as Record<string, unknown>[] | undefined) ?? [], dataName)
      continue
    }
    m.interactive = true
    const update = (isObject(m.encode) ? (m.encode as { update?: Record<string, unknown> }).update : undefined)
    if (update && update.cursor === undefined) update.cursor = { value: 'pointer' }
  }
}

/**
 * position-rect.ts positionAndSize: a bar's / tick's `size` value (encoding or mark def) is its band size, and the encoding
 * wins; the unit then reads it from the mark def alone.
 */
function liftBandSizeValue(spec: VLSpec): void {
  const markRaw = spec.mark
  const mark = typeof markRaw === 'string' ? markRaw : isObject(markRaw) ? markRaw.type : undefined
  const def = (mark === 'bar' || mark === 'tick') && isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>).size : undefined
  if (!isObject(def) || def.value === undefined || def.field !== undefined || def.datum !== undefined || def.condition !== undefined) return
  const { size: _size, ...rest } = spec.encoding as Record<string, unknown>
  void _size
  spec.encoding = rest
  spec.mark = { ...(isObject(markRaw) ? markRaw : { type: markRaw }), size: def.value }
}

function compileUnitView(spec: VLSpec, ctx: CompileCtx): VLSpec {
  let markRaw = spec.mark
  const mark = typeof markRaw === 'string' ? markRaw : (markRaw as Record<string, unknown>).type as string
  liftBandSizeValue(spec)
  markRaw = spec.mark
  const markSize = isObject(markRaw) ? (markRaw.size as number | undefined) : undefined
  const encoding = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  checkConstChannels(mark, encoding, markIsFilled(spec, mark))
  const fields = parseEncodingFields(encoding, spec.config, markRaw)

  // orientation (bar/area/rule/tick): vertical unless the y channel is discrete
  // and x is not, or the mark def says otherwise
  const orient = inferOrient(spec, mark, markRaw, fields)

  if (isGraticuleData(spec.data)) GRATICULE_UNITS.add(spec)
  const unitHandle = {}
  const unitProj = unitProjection(spec, rootNamePrefix(spec), unitHandle)
  // selections: parsed first, since the data pipeline, the mark encodings and the scales all depend on them
  SPEC_CTX.set(spec, ctx)
  const unitSel = prepareUnitSelections(spec, fields, mark, ctx, { unitName: ctx.modelName || (typeof spec.name === 'string' ? spec.name : ''), scaleName: (c) => c })
  const domainSel = collectDomainParams(spec, fields, ctx)
  if (unitSel?.pointer && !(isObject(markRaw) && markRaw.cursor !== undefined)) {
    spec.mark = { ...(isObject(markRaw) ? markRaw : { type: markRaw }), cursor: 'pointer' }
  }

  const data = buildData(spec, fields, mark, orient, undefined, ctx)
  // animation: the selection's frame filter leaves the main dataset for the `_curr` dataset the marks read
  const timerSel = unitSel ? Object.values(unitSel.cmpts).find(isTimerSelection) : undefined
  const animation = timerSel && fields.some((f) => f.channel === 'time') ? extractFrameFilter(data, timerSel.name) : undefined
  // vega-lite's default sizing: continuous dimensions get 300, discrete
  // dimensions size from the band step (bandspace(domain length) * step)
  const xDefS = fields.find((f) => f.channel === 'x')
  const yDefS = fields.find((f) => f.channel === 'y')
  const wSpec = sizeSpec(spec.width)
  const hSpec = sizeSpec(spec.height)
  const continuousDefault = mark === 'arc' || hasProjection(mark, encoding)
  const wPlan = sizePlan(spec, 'width', wSpec, xDefS != null ? positionalScaleType(mark, xDefS) : undefined, continuousDefault)
  const hPlan = sizePlan(spec, 'height', hSpec, yDefS != null ? positionalScaleType(mark, yDefS) : undefined, continuousDefault)
  const xStepForm = 'step' in wPlan
  const yStepForm = 'step' in hPlan
  const width: unknown = 'fixed' in wPlan ? wPlan.fixed : 0
  const height: unknown = 'fixed' in hPlan ? hPlan.fixed : 0

  const out: Record<string, unknown> = {}
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  if (spec.$schema) out.$schema = VEGA_SCHEMA
  // A clipped view cannot grow to contain overflowing guides: vega's
  // autosize-pad then measures only the (clipped) group, i.e. the plain view
  // size. Emit autosize none so the engine reproduces that viewport.
  const viewClip = (isObject(userConfig?.view) && (userConfig!.view as Record<string, unknown>).clip === true)
    || (isObject(userConfig?.style) && isObject((userConfig!.style as Record<string, unknown>).cell)
      && ((userConfig!.style as Record<string, Record<string, unknown>>).cell!.clip === true))
  out.autosize = viewClip ? 'none' : (autosizeOf(spec) ?? 'pad')
  const unitContainer = containerSizing(spec, wSpec, hSpec)
  if (unitContainer) out.autosize = unitContainer.autosize
  if (!xStepForm && !wSpec.container) out.width = width
  if (!yStepForm && !hSpec.container) out.height = height
  // theta-only views (pie/donut) get vega-lite's unstyled 'view' frame — no
  // cell stroke, no half-pixel inset
  out.style = unitGroupStyle(spec)
  const unitView = viewEncode(spec)
  if (unitView) out.encode = unitView
  // Preserve a declared source dataset name (see compileLayered) — hosts key
  // data overrides/changesets on it.
  const unitSource: Record<string, unknown> = isObject(spec.data) ? dataSource(spec.data, ctx.datasets) : {}
  const unitSourceName = typeof unitSource.name === 'string' ? unitSource.name : ctx.takeSource()
  unitSource.name = unitSourceName
  const pd = pipelineDatasets(data, unitSourceName, unitSourceName, ctx, 0)
  if (animation && pd.datasets.length === 0) {
    // (vega-lite keeps an empty main dataset: the frame dataset derives from it)
    const main = ctx.dn(0)
    pd.datasets.push({ name: main, source: unitSourceName, transform: [] })
    pd.dataName = main
    pd.rawName = main
    pd.next = 1
  }
  // a lookup from this unit's selection reads its data filtered by the selection (materializeSelections)
  const unitLookups: Record<string, unknown>[] = []
  for (const c of Object.values(unitSel?.cmpts ?? {})) {
    const lookup = ctx.selectionLookups.get(c.name)
    if (lookup) unitLookups.push({ name: lookup.name, source: pd.dataName, transform: [{ type: 'filter', expr: ctx.selectionTest!({ param: c.name }) }] })
  }
  // (data/parse.ts: the scales read the rows before / after the invalid filter when the marks do not)
  let scaleDataName = pd.dataName
  if (data.invalidSplit) {
    let next = pd.next
    const split = splitInvalidData(pd.datasets, data.invalidSplit, pd.dataName, unitSourceName, () => ctx.dn(next++))
    const wasRaw = pd.rawName === pd.dataName
    pd.dataName = split.dataName
    scaleDataName = split.scaleName
    if (wasRaw && data.invalidSplit.kind === 'pre') pd.rawName = split.scaleName
    pd.next = next
  }
  out.data = [unitSource, ...pd.datasets, ...unitLookups]
  const dataName = pd.dataName
  if (animation) (out.data as Record<string, unknown>[]).push({ name: `${dataName}_curr`, source: dataName, transform: [animation.filter] })
  if (unitProj) {
    HANDLE_MAIN.set(unitHandle, dataName)
    out.projections = assembleProjection(unitProj, () => dataName)
    FRAG_PROJECTION.set(out, unitProj)
  }
  const builtMarks = buildMarks(spec, fields, mark, orient, dataName, markSize)
  if (animation) animateMarks(builtMarks, dataName)
  out.marks = builtMarks
  out.scales = buildScales(spec, fields, mark, orient, scaleDataName, wSpec, hSpec, data.seriesFields, pd.rawName)
  applyScaleConfig(out.scales as ScaleSpec[], isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined)
  resolveZeroOrMin(builtMarks, out.scales as ScaleSpec[])
  showInvalidValues(spec, fields, mark, out.scales as ScaleSpec[], builtMarks)
  applyDomainUnion(fields, out.scales as ScaleSpec[])
  if (domainSel) domainSel.scales = out.scales as ScaleSpec[]
  const clipped = applyScaleExtents(domainSel, out.scales as ScaleSpec[], (c) => c, ctx)
  if (unitSel || clipped || ctx.anySelection) flagSelectionMarks(builtMarks, ctx.anySelection, interactiveUnit(spec, mark, fields, unitSel !== undefined), clipped)
  // discrete-dimension sizing: the scale spans steps and the view size is a
  // signal over the domain cardinality
  const sizeSignals: Record<string, unknown>[] = []
  for (const [channel, defS, plan, req] of [['x', xDefS, wPlan, wSpec], ['y', yDefS, hPlan, hSpec]] as const) {
    if (!('step' in plan) || !defS) continue
    pushAll(sizeSignals, stepSignals(channel, out.scales as ScaleSpec[], plan.step, req.stepFor))
  }
  if (unitContainer) sizeSignals.splice(0, 0, ...unitContainer.signals)
  if (sizeSignals.length) out.signals = sizeSignals
  const axes = buildAxes(fields, axisMark(markRaw, mark), out.scales as ScaleSpec[], undefined, undefined, userConfig)
  if (axes.length) out.axes = axes
  const legends = buildUnitLegends(spec, fields, mark, markRaw)
  if (unitSel) applyLegendSelectionsOf(legends, fields, unitSel.cmpts)
  if (legends.length) out.legends = legends
  // selections: the store data, brush and voronoi marks, signals
  const assembled = assembleUnitSelections(unitSel, out.marks as Record<string, unknown>[], new Set())
  if (assembled.out) {
    out.marks = assembled.marks
    SEL_PARTS.set(out, { data: assembled.out.data, top: assembled.out.topSignals, unit: assembled.out.unitSignals })
  }
  rootChrome(out, spec, 'unit')
  if (data.invalidSplit?.kind === 'pre') PRE_FILTER_UNITS.add(out)
  return out
}

/**
 * Units whose scales read the rows before the invalid filter, which the marks' dataset applies: a facet around one is made over the rows
 * before the filter (the facet node moves down only as far as the scales' dataset), and each cell filters its own.
 */
const PRE_FILTER_UNITS = new WeakSet<object>()

/** Legends of one unit: mark-def and config paint propagate onto the legend symbols. */
function buildUnitLegends(spec: VLSpec, fields: FieldDef[], mark: string, markRaw: unknown): Record<string, unknown>[] {
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  // legend/encode.ts getMaxValue(encoding.opacity) ?? markDef.opacity: the largest opacity the channel can produce
  // (its value and the values of its conditions) is the opacity of the legend's symbols
  const opacityChannel = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>).opacity : undefined
  const channelOpacity = (() => {
    if (!isObject(opacityChannel)) return undefined
    const conds = opacityChannel.condition === undefined ? [] : (Array.isArray(opacityChannel.condition) ? opacityChannel.condition : [opacityChannel.condition])
    const values = [opacityChannel.value, ...conds.map((c) => (isObject(c) ? c.value : undefined))]
    if (opacityChannel.field !== undefined || opacityChannel.datum !== undefined) return undefined
    const nums = values.filter((v): v is number => typeof v === 'number')
    return nums.length ? nums.reduce((a, b) => Math.max(a, b)) : undefined
  })()
  const markOpacity = channelOpacity ?? (isObject(markRaw) ? (markRaw.opacity as number | undefined) : undefined)
  // the legend symbols' stroke resolves through getMarkPropOrConfig
  // (markDef.stroke ?? config[type].stroke ?? config.mark.stroke — probed:
  // config.arc.stroke propagates onto the arc legend's symbols)
  const lgStroke = (isObject(markRaw) ? (markRaw.stroke as string | undefined) : undefined)
    ?? (isObject(userConfig?.[mark]) ? ((userConfig![mark] as Record<string, unknown>).stroke as string | undefined) : undefined)
    ?? (isObject(userConfig?.mark) ? ((userConfig!.mark as Record<string, unknown>).stroke as string | undefined) : undefined)
  const cfgMarkBlock = isObject(userConfig?.[mark]) ? (userConfig![mark] as Record<string, unknown>) : undefined
  const cfgGenericMark = isObject(userConfig?.mark) ? (userConfig!.mark as Record<string, unknown>) : undefined
  const legendFilled = isObject(markRaw) && markRaw.filled !== undefined
    ? markRaw.filled === true
    : cfgMarkBlock?.filled !== undefined
      ? cfgMarkBlock.filled === true
      : cfgGenericMark?.filled !== undefined
        ? cfgGenericMark.filled === true
        : undefined
  const legendStrokeWidth = (cfgMarkBlock?.strokeWidth as number | undefined)
    ?? (cfgGenericMark?.strokeWidth as number | undefined)
  // Only config-level paint propagates onto legend symbols (vega's mark style
  // applies to the generated legend marks); a markDef fillOpacity/strokeDash
  // stays on the mark itself.
  const legendFillOpacity = (cfgMarkBlock?.fillOpacity as number | undefined)
    ?? (cfgGenericMark?.fillOpacity as number | undefined)
  const legendStrokeDash = (cfgMarkBlock?.strokeDash as number[] | undefined)
    ?? (cfgGenericMark?.strokeDash as number[] | undefined)
  return buildLegends(
    fields.filter((f) => !f.noScale),
    mark,
    markOpacity,
    legendFilled,
    lgStroke,
    legendStrokeWidth,
    legendFillOpacity,
    isObject(userConfig?.legend) ? (userConfig!.legend as Record<string, unknown>) : undefined,
    legendStrokeDash,
    {
      numberFormat: userConfig?.numberFormat as string | undefined,
      timeFormat: userConfig?.timeFormat as string | undefined,
      customFormatTypes: userConfig?.customFormatTypes as boolean | undefined,
      numberFormatType: userConfig?.numberFormatType as string | undefined,
      timeFormatType: userConfig?.timeFormatType as string | undefined,
    },
    { ...legendPaint(spec, markRaw), ...(fields.some((f) => f.noScale && f.channel === 'color') ? { colorScaleless: true } : {}) },
  )
}

/** The constant colour a legend symbol takes: a `value` colour channel, else the mark def's `fill` / `stroke` / `color`. */
function legendPaint(spec: VLSpec, markRaw: unknown): { fill?: string; stroke?: string; markFill?: string; shape?: string } {
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const md = isObject(markRaw) ? markRaw : {}
  const encValue = (ch: string): string | undefined => {
    const d = enc[ch]
    return isObject(d) && d.field === undefined && d.datum === undefined && typeof d.value === 'string' ? d.value : undefined
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return {
    fill: encValue('fill') ?? encValue('color') ?? str(md.fill) ?? str(md.color),
    stroke: encValue('stroke') ?? encValue('color') ?? str(md.stroke) ?? str(md.color),
    // (the mark definition's own fill: what an unfilled mark's legend symbols are filled with)
    markFill: str(md.fill),
    // legend/properties.ts symbolType: a constant shape (a value def, else the mark's) is every non-shape legend's symbol
    shape: encValue('shape') ?? str(md.shape),
  }
}

// --- selections (params with `select`) ----------------------------------------
//
// The selection compiler itself is selection.ts (a port of vega-lite's compile/selection). The code here is the
// seam: it tells that compiler what a unit's channels, scales and marks are, and weaves what it emits (the store
// datasets, signals, brush and voronoi marks) and what depends on a selection (param conditions and filters, the
// identifier transform, scale domains, interactive legends, lookups) into the unit's output.

/** The selections of one unit, parsed. */
interface UnitSel {
  cmpts: Record<string, SelCmpt>
  unit: SelUnit
  /** scale channels whose domain follows a param, by channel */
  extents: Map<string, { param: string; field?: string; encoding?: string }>
  /** the unit has a point selection that is not bound to inputs: its marks get a pointer cursor */
  pointer: boolean
  /** the unit's data pipeline gets an identifier after its own aggregate */
  ownId: boolean
  /** scales of the unit, once built (read by the signals that pan and zoom them) */
  scales?: ScaleSpec[]
}
const UNIT_SEL = new WeakMap<VLSpec, UnitSel>()
/** The compile context of the view a unit spec belongs to (the mark builders do not take one). */
const SPEC_CTX = new WeakMap<VLSpec, CompileCtx>()
function ctxOf(spec: VLSpec): CompileCtx {
  const ctx = SPEC_CTX.get(spec)
  if (!ctx) throw new VLCompileError('internal: a unit was built without a compile context')
  return ctx
}

const selectionParamsOf = (spec: VLSpec): Record<string, unknown>[] =>
  (Array.isArray(spec.params) ? (spec.params as Record<string, unknown>[]) : []).filter((p) => p.select !== undefined)

/** Predicates over a param: the selection test for the param in scope, a variable parameter coerced to boolean otherwise. */
function selectionTester(ctx: CompileCtx): (pred: ParamPredicate) => string {
  return (pred) => selectionPredicate({
    get: (name) => {
      const have = ctx.selections.get(name) ?? ctx.forwardSelections?.get(name)
      if (!have) ctx.selectionMisses.add(name)
      return have
    },
  }, pred)
}

/** bin.ts createBinComponent: the expression a parameter extent stands for (parseSelectionExtent), if the bin has one. */
function binSpanExpr(ctx: CompileCtx, bin: Record<string, unknown>): string | undefined {
  const ext = bin.extent
  if (!isParameterExtent(ext)) return undefined
  return selectionExtent({
    get: (name) => {
      const have = ctx.selections.get(name) ?? ctx.forwardSelections?.get(name)
      if (!have) ctx.selectionMisses.add(name)
      return have
    },
  }, ext.param, ext)
}

/** `{param}`-aware predicate expression (filter transform, condition `test`). */
function predicateWithParams(ctx: CompileCtx, p: unknown): string {
  return predicateExpr(p, selectionTester(ctx))
}

/**
 * Parse a unit's selection params (parse.ts parseUnitSelection) before anything that depends on them is built.
 * `opts.unitName` is vega-lite's `model.name` ('' for a root unit, `layer_0` for a layer's first unit).
 */
function prepareUnitSelections(
  spec: VLSpec,
  fields: FieldDef[],
  mark: string,
  ctx: CompileCtx,
  opts: { unitName: string; scaleName: (channel: string) => string },
): UnitSel | undefined {
  const params = selectionParamsOf(spec)
  if (!params.length) return undefined
  const md = isObject(spec.mark) ? spec.mark : {}
  if ((md.point !== undefined && md.point !== false) || (md.line !== undefined && md.line !== false)) {
    throw new VLCompileError('mark.point / mark.line (a path mark with an overlay) cannot carry selection parameters: vega-lite splits it into layers; write the layers')
  }
  const extents = new Map<string, { param: string; field?: string; encoding?: string }>()
  const fieldOf = (channel: string): FieldDef | undefined => fields.find((f) => f.channel === channel && f.field && !f.datumOnly)
  const unit: SelUnit = {
    name: opts.unitName,
    getName: (text) => varName((opts.unitName ? `${opts.unitName}_` : '') + text),
    fieldDef: (channel) => {
      const f = fieldOf(channel)
      if (!f) return undefined
      if (f.flatExpr !== undefined) {
        throw new VLCompileError(`encoding.${channel}: a selection cannot be projected over the nested or escaped field "${f.source}"`)
      }
      return { field: f.field, source: f.source, aggregate: f.aggregate, bin: !!f.bin, ...(f.tu ? { timeUnit: f.tu } : {}) }
    },
    vgField: (channel, opt) => {
      const f = fieldOf(channel)!
      if (f.bin) {
        const names = binNames(f.binParams!, f.field)
        return opt?.binSuffix === 'end' ? names.end : names.start
      }
      return aggFieldName(f)
    },
    timeUnitProjection: (channel) => {
      const f = fieldOf(channel)!
      return { as: timeUnitField(f), field: f.field, timeUnit: f.tu }
    },
    scaleName: opts.scaleName,
    scaleType: (channel) => {
      const f = fieldOf(channel)
      return f && (channel === 'x' || channel === 'y') ? positionalScaleType(mark, f) : undefined
    },
    scaleReverse: (channel) => unitSel?.scales?.find((sc) => sc.name === opts.scaleName(channel))?.reverse === true,
    scaleProp: (channel, prop) => {
      const f = fieldOf(channel)
      const v = f?.scale?.[prop]
      return typeof v === 'number' ? v : undefined
    },
    sizeSignal: (layout) => layout,
    nested: ctx.compositeDepth > 0,
    ...(ctx.facetFields.length ? { facetFields: ctx.facetFields } : {}),
    mark,
    hasProjection: hasProjection(mark, isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}),
    // (the projection's final name: a layer that took the unit's over, a composite that merged it, are known once the view is assembled)
    projectionName: () => finalProjectionName(GEO_UNITS.get(spec)?.component) ?? 'projection',
    firstMarkName: varName((opts.unitName ? `${opts.unitName}_` : '') + 'marks'),
    bindScale: (channel, extent) => { extents.set(channel, extent) },
    voronoiTooltip: () => {
      const u: Record<string, unknown> = {}
      applyTextualChannels(u, spec, fields)
      const t = u.tooltip as { signal?: string; value?: unknown } | undefined
      if (!t) return {}
      return { tooltip: t.signal !== undefined ? { signal: t.signal.replace(/\bdatum\b(?!\.datum)/g, 'datum.datum') } : t }
    },
  }
  const cmpts = parseUnitSelections(unit, params, spec.config)
  // (a parameter is declared once, and pushed to every unit of a composition or repeated with its view: the last wins, as
  // in vega-lite's concat model, where the selection components of the children are merged by name)
  for (const c of Object.values(cmpts)) ctx.selections.set(c.name, c)
  if (requiresSelectionId(cmpts)) ctx.selectionIds = true
  const unitSel: UnitSel = {
    cmpts,
    unit,
    extents,
    pointer: Object.values(cmpts).some((c) => c.type === 'point' && !c.bind && c.on !== 'pointerover'),
    ownId: requiresSelectionId(cmpts),
  }
  UNIT_SEL.set(spec, unitSel)
  return unitSel
}

/** The unit-level pieces `domain: {param}` and `bin.extent: {param}` add, recorded on the unit for the scale pass. */
function collectDomainParams(spec: VLSpec, fields: FieldDef[], ctx: CompileCtx): UnitSel | undefined {
  let sel = UNIT_SEL.get(spec)
  for (const f of fields) {
    // scale/domain.ts parseSelectionDomain: a `domain: {param}`, else the `{param}` extent of a binned field
    const d = f.scale?.domain
    const binExtent = f.bin && f.binParams && isParameterExtent(f.binParams.extent) ? f.binParams.extent : undefined
    const ext = isObject(d) && typeof d.param === 'string' ? d : binExtent
    if (!ext) continue
    if (!sel) {
      sel = { cmpts: {}, unit: undefined as unknown as SelUnit, extents: new Map(), pointer: false, ownId: false }
      UNIT_SEL.set(spec, sel)
    }
    sel.extents.set(f.channel, { param: ext.param as string, ...(typeof ext.field === 'string' ? { field: ext.field } : {}), ...(typeof ext.encoding === 'string' ? { encoding: ext.encoding } : {}) })
  }
  void ctx
  return sel
}

/**
 * `scale.domain: {unionWith: [...]}` (scale/domain.ts): the listed values joined to the scale's default domain, as
 * `mergeDomains` writes a union (the literal values first, the data references after).
 */
function applyDomainUnion(fields: FieldDef[], scales: ScaleSpec[]): void {
  for (const f of fields) {
    const d = f.scale?.domain
    if (!isObject(d) || !Array.isArray(d.unionWith)) continue
    const channel = f.channel === 'x2' ? 'x' : f.channel === 'y2' ? 'y' : f.channel
    const sc = scales.find((s) => s.name === channel)
    if (!sc) continue
    const unit = f.tu?.unit
    const literals: unknown[] = f.type === 'temporal' || unit !== undefined
      ? (d.unionWith as unknown[]).map((v) => ({ signal: `{data: ${domainValueExpr(v, f.type, unit)}}` }))
      : [d.unionWith]
    const current = sc.domain as Record<string, unknown> | unknown[]
    const defaults: unknown[] = Array.isArray(current)
      ? [current]
      : isObject(current) && typeof current.data === 'string' && Array.isArray(current.fields)
        ? (current.fields as string[]).map((field) => ({ data: current.data, field, ...(current.sort !== undefined ? { sort: current.sort } : {}) }))
        : isObject(current) && Array.isArray(current.fields)
          ? (current.fields as unknown[]).map((piece) => (isObject(piece) && current.sort !== undefined && piece.sort === undefined ? { ...piece, sort: current.sort } : piece))
          : [current]
    sc.domain = mergeDomains([...literals, ...defaults])
  }
}

const UNION_SORT_OPS = new Set(['count', 'min', 'max'])
const isDataRef = (d: unknown): d is Record<string, unknown> => isObject(d) && typeof d.data === 'string'

/** vega-lite scale/domain.ts mergeDomains: several domains as one Vega scale domain. */
function mergeDomains(domains: unknown[]): unknown {
  const stripSort = (d: unknown): unknown => {
    if (!isDataRef(d)) return d
    const { sort: _s, ...rest } = d
    void _s
    return rest
  }
  const seen = new Set<string>()
  const unique = domains.map(stripSort).filter((d) => (seen.has(JSON.stringify(d)) ? false : (seen.add(JSON.stringify(d)), true)))
  const sortsSeen = new Set<string>()
  const sorts: unknown[] = []
  for (const d of domains) {
    if (!isDataRef(d) || d.sort === undefined) continue
    let sort = d.sort
    if (isObject(sort)) {
      sort = { ...sort }
      if ('op' in (sort as Record<string, unknown>) && (sort as Record<string, unknown>).op === 'count') delete (sort as Record<string, unknown>).field
      if ((sort as Record<string, unknown>).order === 'ascending') delete (sort as Record<string, unknown>).order
    }
    const key = JSON.stringify(sort)
    if (!sortsSeen.has(key)) { sortsSeen.add(key); sorts.push(sort) }
  }
  if (unique.length === 0) return undefined
  if (unique.length === 1) {
    const domain = domains[0]
    if (isDataRef(domain) && sorts.length > 0) {
      let sort = sorts[0]
      if (sorts.length > 1) {
        const filtered = sorts.filter((x) => isObject(x) && 'op' in x && x.op !== 'min')
        sort = sorts.every((x) => isObject(x) && 'op' in x) && filtered.length === 1 ? filtered[0] : true
      } else if (isObject(sort) && 'field' in sort && domain.field === sort.field) {
        sort = sort.order ? { order: sort.order } : true
      }
      return { ...domain, sort }
    }
    return domain
  }
  // only the sorts that work with unioned domains survive
  const unionSortsSeen = new Set<string>()
  const unionSorts: unknown[] = []
  for (const x of sorts) {
    const kept = typeof x === 'boolean' || !isObject(x) || !('op' in x) || (typeof x.op === 'string' && UNION_SORT_OPS.has(x.op)) ? x : true
    const key = JSON.stringify(kept)
    if (!unionSortsSeen.has(key)) { unionSortsSeen.add(key); unionSorts.push(kept) }
  }
  const sort = unionSorts.length === 1 ? unionSorts[0] : unionSorts.length > 1 ? true : undefined
  const allData = [...new Set(domains.map((d) => (isDataRef(d) ? d.data : null)))]
  if (allData.length === 1 && allData[0] !== null) {
    return { data: allData[0], fields: unique.map((d) => (d as Record<string, unknown>).field), ...(sort ? { sort } : {}) }
  }
  return { fields: unique, ...(sort ? { sort } : {}) }
}

/** The scales that follow a selection (`bind: scales`): vega-lite's `selectionExtent` scale property. */
const SELECTION_EXTENT_SCALES = new WeakSet<object>()

/** Selection-driven `domainRaw`s of a unit's scales, and the clip they imply (mark.ts scaleClip). */
function applyScaleExtents(sel: UnitSel | undefined, scales: ScaleSpec[], scaleName: (channel: string) => string, ctx: CompileCtx): boolean {
  if (!sel || sel.extents.size === 0) return false
  let bound = false
  for (const [channel, extent] of sel.extents) {
    const sc = scales.find((s) => s.name === scaleName(channel))
    if (!sc) continue
    sc.domainRaw = assembleSelectionScaleDomain({
      get: (n) => {
        const have = ctx.selections.get(n) ?? ctx.forwardSelections?.get(n)
        if (!have) ctx.selectionMisses.add(n)
        return have
      },
    }, extent, isContinuousScaleType(sc.type), sc.domain)
    SELECTION_EXTENT_SCALES.add(sc)
    bound = true
  }
  return bound
}

/**
 * mark.ts interactiveFlag: once a selection exists somewhere in the view, a unit's marks are interactive when the unit has selections of
 * its own, draws a geoshape, or has a tooltip (an encoding or the mark definition's).
 */
function interactiveUnit(spec: VLSpec, mark: string, fields: FieldDef[], hasSelections: boolean): boolean {
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
  return hasSelections || mark === 'geoshape' || fields.some((f) => f.channel === 'tooltip') || Boolean(md.tooltip)
}

/** mark.ts: the `interactive` flag, and `clip` for scales that follow a selection, on a unit's main marks. */
function flagSelectionMarks(marks: Record<string, unknown>[], hasSelections: boolean, own: boolean, clip: boolean): void {
  const visit = (m: Record<string, unknown>): void => {
    if (typeof m.name === 'string' && /(^|_)marks$/.test(m.name) && m.type !== 'group') {
      if (hasSelections) m.interactive = own || m.interactive === true
      if (clip && m.clip === undefined) m.clip = true
    }
    for (const c of (m.marks as Record<string, unknown>[] | undefined) ?? []) visit(c)
  }
  marks.forEach(visit)
}

/** The identifier transform vega-lite puts at the head of every pipeline once a selection projects `_vgsid_`. */
const identifierTransform = (): Record<string, unknown> => ({ type: 'identifier', as: SELECTION_ID })

/** The interactive legend's encode (legend/encode.ts, selections): symbols and labels dim unselected entries, entries are clickable. */
function applyLegendSelections(lg: Record<string, unknown>, def: FieldDef, names: string[]): void {
  const field = stringValue(def.source)
  const condition = names
    .map((name) => {
      const store = stringValue(varName(name) + STORE)
      return `(!length(data(${store})) || (${name}[${field}] && indexof(${name}[${field}], datum.value) >= 0))`
    })
    .join(' || ')
  const unselected = 0.35 // config.legend.unselectedOpacity
  const enc = (lg.encode ?? {}) as Record<string, { update?: Record<string, unknown> }>
  if (!GRADIENT_LEGENDS.has(lg) && def.channel !== 'opacity') {
    const symbols = (enc.symbols ??= {})
    const update = (symbols.update ??= {})
    update.opacity = [{ test: condition, value: (update.opacity as { value?: number } | undefined)?.value ?? 1 }, { value: unselected }]
  }
  const labels = (enc.labels ??= {})
  labels.update = { opacity: [{ test: condition, value: 1 }, { value: unselected }], ...(labels.update ?? {}) }
  // entries are drawn transparent so the whole row takes the click
  const entries = (enc.entries ??= {})
  entries.update = { ...(entries.update ?? {}), fill: { value: 'transparent' } }
  const out: Record<string, unknown> = {}
  for (const part of ['labels', 'legend', 'title', 'symbols', 'gradient', 'entries']) {
    const value = enc[part]?.update
    if (value === undefined || Object.keys(value).length === 0) continue
    out[part] = { name: `${varName(def.source)}_legend_${part}`, interactive: true, update: { ...value, cursor: { value: 'pointer' } } }
  }
  lg.encode = out
}

/**
 * What the selections of a compiled view add outside its own marks. The root (compile()) puts the store datasets in front of
 * the data and the top-level signals among the view's; a unit's own signals go to the root too, unless the unit sits in a
 * concat, facet or repeat view: then the group mark that holds it declares them (a Vega group scope, one copy per group item).
 */
interface SelParts {
  /** the store datasets, in vega-lite's order (a later view's go in front of an earlier one's) */
  data: Record<string, unknown>[]
  /** the top-level signals, assembled over the ones before them */
  top: (signals: Record<string, unknown>[]) => Record<string, unknown>[]
  /** the units' own signals; a composition has none (its units' are in their groups) */
  unit: Record<string, unknown>[]
}
const SEL_PARTS = new WeakMap<object, SelParts>()

/**
 * The marks the selections add (brush, voronoi): vega-lite names them after the selection, not after the view that holds them
 * and they are no data mark of the view. The flag is an own symbol property, so a copy of the mark (a spread) keeps it.
 */
const SELECTION_MARK = Symbol('aster.vl.selectionMark')
const isSelectionMark = (m: Record<string, unknown>): boolean => (m as Record<symbol, unknown>)[SELECTION_MARK] === true

/** The selection parts of several views laid side by side (concat, repeat): each one's stores go in front of the ones before. */
function mergeSelParts(parts: SelParts[]): SelParts | undefined {
  if (parts.length === 0) return undefined
  // each view passes over the data the views before it left: a store another view declared is not declared again
  const seen = new Set<string>()
  const groups = parts.map((part) => part.data.filter((d) => (seen.has(d.name as string) ? false : (seen.add(d.name as string), true))))
  const data = groups.reverse().flat()
  return { data, top: (signals) => parts.reduce((sg, part) => part.top(sg), signals), unit: [] }
}

/** Interactive legends (legends.ts parseInteractiveLegend + legend/encode.ts): a legend over a field a selection is bound to. */
function applyLegendSelectionsOf(legends: Record<string, unknown>[], fields: FieldDef[], cmpts: Record<string, SelCmpt>): void {
  for (const lg of legends) {
    const key = LEGEND_SCALE_KEYS.find((k) => typeof lg[k] === 'string')
    if (!key) continue
    const channel = String(lg[key]) // the legend's scale is named after its channel
    const def = fields.find((f) => f.channel === channel && f.field && !f.datumOnly)
    if (!def) continue
    const names = interactiveLegendSelections(cmpts, def.channel, def.source)
    if (names.length) applyLegendSelections(lg, def, names)
  }
}

/** All the pieces a unit's selections add to the Vega spec being built. */
interface SelectionOutput {
  data: Record<string, unknown>[]
  topSignals: (signals: Record<string, unknown>[]) => Record<string, unknown>[]
  unitSignals: Record<string, unknown>[]
}

/** Wrap `marks` with the unit's brush / voronoi marks and gather its store data and signals. */
function assembleUnitSelections(sel: UnitSel | undefined, marks: Record<string, unknown>[], existingData: ReadonlySet<string>): { marks: Record<string, unknown>[]; out: SelectionOutput | undefined } {
  if (!sel || !sel.unit) return { marks, out: undefined }
  const out: SelectionOutput = {
    data: assembleUnitSelectionData(sel.unit, sel.cmpts, existingData),
    topSignals: (signals) => assembleTopLevelSelectionSignals(sel.cmpts, signals),
    unitSignals: assembleUnitSelectionSignals(sel.unit, sel.cmpts),
  }
  return { marks: assembleSelectionMarks(sel.unit, sel.cmpts, marks), out }
}

/** The unit's brush / voronoi marks around its own, noted as the selections' (they keep the selection's name when a view is embedded). */
function assembleSelectionMarks(unit: SelUnit, cmpts: Record<string, SelCmpt>, marks: Record<string, unknown>[]): Record<string, unknown>[] {
  const own = new Set(marks)
  const out = assembleUnitSelectionMarks(unit, cmpts, marks)
  for (const m of out) if (!own.has(m)) (m as Record<symbol, unknown>)[SELECTION_MARK] = true
  return out
}
