/**
 * A from-scratch Vega-Lite compiler: Vega-Lite -> Vega.
 *
 * Coverage grows mark/channel by mark/channel, each step verified by rendering
 * parity against the pinned vega-lite oracle (the conformance harness renders
 * both and compares canonicalized SVG). Spec names may differ from the
 * oracle's; the rendered output must not.
 */

import { renameDataRefs, renameFragment } from './embed.js'
import { VLCompileError, signalSafe, flatField, datumRef as dref, datumPathRef, genName, genSignal, safeKey, splitAccessPath, validExpr } from './names.js'
import { validateSpec } from './validate.js'
import { predicateExpr } from './predicate.js'
import { getTimeUnitParts, normalizeTimeUnit, timeUnitFieldName, timeUnitTransform, type NormalTimeUnit } from './timeunit.js'
import { binNames, binTransforms, normalizeBin, translateTransforms, type BinParams, type TransformContext, type TranslateState } from './transforms.js'

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
  channel: string
  /** The flat, access-path-safe key every internal reference uses (see names.ts flatField). */
  field: string
  /** The user's field text, for titles. */
  source: string
  /** Expression materializing `field` from a nested/escaped source path (pipeline start). */
  flatExpr?: string
  type: string
  aggregate?: string
  /** the field comes from a condition (the channel itself has none) */
  fromCondition?: boolean
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

function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v]
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
  const spec = cloneSpec(input)
  validateSpec(spec)
  const ctx = makeCtx(spec)
  const out = finalizeData(compileView(spec, ctx), ctx)
  const signals = paramSignals(spec)
  if (signals.length) out.signals = [...signals, ...((out.signals as Record<string, unknown>[] | undefined) ?? [])]
  return exprRefsToSignals(out) as VLSpec
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
  for (const k of keys) {
    const v = node[k]
    if (k === 'values') out[k] = v
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

function compileView(spec: VLSpec, ctx: CompileCtx): VLSpec {
  if (isObject(spec.layer) || Array.isArray(spec.layer)) return compileLayered(spec, ctx)
  // facet forms: top-level {facet, spec}, encoding.facet {row?, column?}, or
  // the encoding shorthand row/column channels
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const hasEncFacet = isObject(enc.facet) || enc.row != null || enc.column != null
  if (isObject(spec.facet) || (isObject(spec.spec) && hasTopFacet(spec))) return compileFaceted(spec, ctx)
  if (hasEncFacet && spec.spec == null) return compileFaceted(spec, ctx)
  if (spec.mark === 'boxplot' || (isObject(spec.mark) && (spec.mark as Record<string, unknown>).type === 'boxplot')) return compileBoxplot(spec, ctx)
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
  if (!['bar', 'area', 'rule', 'tick', 'line', 'text'].includes(mark)) return 'vertical'
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const has = (ch: string): boolean => enc[ch] != null
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(cfg?.[mark]) ? (cfg![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(cfg?.mark) ? (cfg!.mark as Record<string, unknown>) : undefined
  const specified = ((isObject(markRaw) ? (markRaw.orient as string | undefined) : undefined)
    ?? (cfgType?.orient as string | undefined)
    ?? (cfgMark?.orient as string | undefined))
  const x2 = has('x2')
  const y2 = has('y2')
  let phase = mark === 'text' ? 'bar' : mark
  if (phase === 'bar') {
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
    if (x2 && y2) return 'vertical' // a line segment has no orientation
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
  return 'vertical'
}

/**
 * Flatten a layer tree into its leaf unit specs. Each leaf inherits, from every
 * ancestor layer: the shared `encoding` (the child overrides per channel), the
 * `data` (a node's own data replaces the inherited one and restarts the
 * transform chain, because a parent's transform belongs to the parent's data),
 * and the `transform` chain; `config` is global and always the root's.
 */
function collectLeaves(root: VLSpec): VLSpec[] {
  const leaves: VLSpec[] = []
  interface Inherited { encoding: Record<string, unknown>; data: unknown; transform: unknown[] }
  const visit = (node: VLSpec, inh: Inherited): void => {
    let data = inh.data
    let transform = [...inh.transform]
    if (node.data !== undefined) {
      data = node.data
      transform = []
    }
    if (Array.isArray(node.transform)) transform.push(...node.transform)
    const encoding = { ...inh.encoding, ...(isObject(node.encoding) ? (node.encoding as Record<string, unknown>) : {}) }
    if (Array.isArray(node.layer)) {
      for (const c of node.layer as VLSpec[]) visit(c, { encoding, data, transform })
      return
    }
    const leaf: VLSpec = { ...node, encoding }
    if (data !== undefined) leaf.data = data
    else delete leaf.data
    if (transform.length) leaf.transform = transform
    else delete leaf.transform
    if (root.config !== undefined) leaf.config = root.config
    delete leaf.params
    leaves.push(leaf)
  }
  visit(root, { encoding: {}, data: undefined, transform: [] })
  return leaves
}

/** A width/height spec: a fixed size, a {step} request, or unspecified. */
function sizeSpec(v: unknown): { fixed?: number; step?: number } {
  if (typeof v === 'number') return { fixed: v }
  if (isObject(v) && typeof v.step === 'number') return { step: v.step }
  return {}
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
  }
  const parsed: ParsedLayer[] = leaves.map((l) => {
    const markRaw = l.mark
    const mark = typeof markRaw === 'string' ? markRaw : (markRaw as Record<string, unknown>).type as string
    const encoding = isObject(l.encoding) ? (l.encoding as Record<string, unknown>) : {}
    checkConstChannels(mark, encoding)
    const fields = parseEncodingFields(encoding)
    const orient = inferOrient(l, mark, markRaw, fields)
    return { l, mark, markRaw, markSize: isObject(markRaw) ? (markRaw.size as number | undefined) : undefined, fields, orient, pipeline: [], seriesFields: [], dataName: '', rawName: '', rawLen: 0, usesRawDomain: false, group: 0 }
  })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = autosizeOf(spec) ?? 'pad'
  // theta-only layered views (pie labels) use the unstyled 'view' frame
  const anyXY = parsed.some((p) => p.fields.some((f) => f.channel === 'x' || f.channel === 'y'))
  out.style = anyXY ? 'cell' : 'view'

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
    const sourceName = typeof source.name === 'string' ? source.name : ctx.sn(gi)
    source.name = sourceName
    return { sourceName, castDone: new Set<string>(), casts: [], source, castsName: sourceName }
  })
  for (const p of parsed) {
    const g = groups[p.group]!
    const d = buildData(p.l, p.fields, p.mark, p.orient, g.castDone, ctx)
    g.casts.push(...d.casts)
    p.pipeline = d.pipeline
    p.seriesFields = d.seriesFields
    p.rawLen = d.rawLen
    p.usesRawDomain = d.usesRawDomain
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
  const width: unknown = wSpec.fixed ?? 300
  const height: unknown = hSpec.fixed ?? 300
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
    p.rawName = rawName
    const overlayName = ctx.dn(nextData)
    const builtMarks = buildMarks(p.l, p.fields, p.mark, p.orient, p.dataName, p.markSize, overlayName) as Record<string, unknown>[] & { overlayData?: Record<string, unknown> }
    uniquifyLayerMarks(builtMarks, i)
    perLayerMarks.push(builtMarks)
    if (builtMarks.overlayData) {
      nextData++
      data.push(builtMarks.overlayData)
    }
    perLayerScales.push(buildScales(p.l, p.fields, p.mark, p.orient, p.dataName, width, height, p.seriesFields, p.rawName))
  })
  out.data = data

  // y2/x2 endpoint fields extend the layer's positional scale domain
  parsed.forEach((p, i) => {
    for (const [main, second] of [['y', 'y2'], ['x', 'x2']] as const) {
      const d2 = p.fields.find((f) => f.channel === second && f.field && !f.datumOnly)
      if (!d2) continue
      const sc = perLayerScales[i]?.find((s) => s.name === main)
      if (!sc) continue
      const d = sc.domain as { data?: string; field?: string; fields?: unknown } | undefined
      if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.data === 'string') {
        const fieldList = Array.isArray(d.fields) ? [...d.fields as string[]] : [d.field as string]
        if (!fieldList.includes(d2.field)) fieldList.push(d2.field as string)
        sc.domain = { data: d.data, fields: fieldList }
      }
    }
  })

  // independent y resolution (dual-axis layers): each layer's y scale gets a
  // unique name; the first layer keeps the left axis with grid, subsequent
  // layers move to a right axis without grid
  const resolveScale = isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale)
    ? ((spec.resolve as Record<string, Record<string, unknown>>).scale as Record<string, unknown>)
    : {}
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
          for (const k of ['y', 'y2']) {
            const v = enc[k] as Record<string, unknown> | undefined
            if (v && v.scale === 'y') v.scale = `layer_${i}_y`
          }
        }
        for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) rewrite(sub)
      }
      for (const m of perLayerMarks[i] ?? []) rewrite(m)
    })
    void firstY
  }

  const marks: Record<string, unknown>[] = perLayerMarks.flat()
  out.marks = marks

  // with independent y, the y scales stay per-layer (renamed); the remaining
  // scales still merge across layers
  const isIndepYScale = (s: ScaleSpec): boolean => s.name.startsWith('layer_') && s.name.endsWith('_y')
  const scales = indepY
    ? [...mergeLayerScales(perLayerScales.map((ls) => ls.filter((s) => s.name !== 'y' && !isIndepYScale(s)))), ...perLayerScales.flat().filter(isIndepYScale)]
    : mergeLayerScales(perLayerScales)
  out.scales = scales
  applyScaleConfig(scales, isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined)

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
        const axisDefs = buildAxes([yDef], p.mark, p.orient, perLayerScales[i]!, `layer_${i}_y`, undefined, userConfig)
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
    for (const p of layersWith) {
      const f = p.fields.find((q) => q.channel === ch)!
      const t = ((f.axis as Record<string, unknown> | null | undefined)?.title as string) ?? (channelTitle(f) as string)
      if (t) titles.push(t)
      const d2 = p.fields.find((q) => q.channel === second && q.field)
      if (d2 && !d2.datumOnly) titles.push(d2.source)
    }
    const uniq = Array.from(new Set(titles))
    const axisFields = base.fields.filter((f) => f.channel === ch).map((f) =>
      uniq.length > 1 ? ({ ...f, title: uniq.join(', ') } as FieldDef) : f,
    )
    for (const a of buildAxes(axisFields, base.mark, base.orient, scales as ScaleSpec[], undefined, ch === 'x' && indepY ? `layer_${firstYLayer}_y` : undefined, userConfig)) axes.push(a)
  }
  if (axes.length) out.axes = axes

  // discrete-dimension sizing (after the scales are merged): the scale spans
  // steps and the view size is a signal over the domain cardinality
  const sizeSignals: Record<string, unknown>[] = []
  for (const [channel, fixed, stepReq] of [['x', wSpec.fixed, wSpec.step], ['y', hSpec.fixed, hSpec.step]] as const) {
    if (fixed !== undefined) continue
    const sc = scales.find((s) => s.name === channel)
    if (!sc || (sc.type !== 'band' && sc.type !== 'point')) continue
    sizeSignals.push(...stepSignals(channel, sc, stepReq))
  }
  const xStepped = sizeSignals.some((s) => s.name === 'width')
  const yStepped = sizeSignals.some((s) => s.name === 'height')
  if (!xStepped) out.width = width
  if (!yStepped) out.height = height
  if (sizeSignals.length) out.signals = sizeSignals

  const legends: Record<string, unknown>[] = []
  for (const p of parsed) {
    for (const lg of buildUnitLegends(p.l, p.fields, p.mark, p.markRaw)) {
      // one legend per scale channel (vega resolves shared legends across layers)
      const ch = lg.fill ?? lg.stroke ?? lg.shape ?? lg.size ?? lg.opacity ?? lg.strokeWidth
      const dup = typeof ch === 'string' ? legends.find((x) => (x.fill ?? x.stroke ?? x.shape ?? x.size ?? x.opacity ?? x.strokeWidth) === ch) : undefined
      if (dup) {
        // shared legend: the titles of the layers that feed it are joined, as for axes
        if (typeof dup.title === 'string' && typeof lg.title === 'string' && dup.title !== lg.title && !dup.title.split(', ').includes(lg.title)) {
          dup.title = `${dup.title}, ${lg.title}`
        }
        continue
      }
      if (!legends.some((x) => JSON.stringify(x) === JSON.stringify(lg))) legends.push(lg)
    }
  }
  if (legends.length) out.legends = legends
  rootChrome(out, spec)
  return out
}

/**
 * Mark names double as Vega dataset names, so two layers must not reuse them:
 * rename this layer's marks (and its series group + facet) with a layer prefix.
 */
function uniquifyLayerMarks(marks: Record<string, unknown>[], layer: number): void {
  marks.forEach((m, k) => {
    if (m.name === 'pathgroup') {
      m.name = `layer_${layer}_pathgroup`
      const facet = (m.from as { facet?: { name?: string } } | undefined)?.facet
      const oldFacet = facet?.name
      if (facet && oldFacet) facet.name = `faceted_path_layer_${layer}_main`
      for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) {
        sub.name = k === 0 ? `layer_${layer}_marks` : `layer_${layer}_marks_${k}`
        const from = sub.from as { data?: string } | undefined
        if (from && from.data === oldFacet) from.data = `faceted_path_layer_${layer}_main`
      }
    } else {
      m.name = k === 0 ? `layer_${layer}_marks` : `layer_${layer}_marks_${k}`
    }
  })
}

/** The step-form size signals of a discrete scale: `<ch>_step` plus the size signal over the domain cardinality. */
function stepSignals(channel: 'x' | 'y', sc: ScaleSpec, stepReq?: number): Record<string, unknown>[] {
  const stepName = `${channel}_step`
  sc.range = { step: { signal: stepName } }
  const pi = (sc.paddingInner as number) ?? (sc.padding as number) ?? 0
  const po = (sc.paddingOuter as number) ?? (sc.padding as number) ?? 0
  return [
    { name: stepName, value: stepReq ?? 20 },
    { name: channel === 'x' ? 'width' : 'height', update: `bandspace(domain('${channel}').length, ${pi}, ${po}) * ${stepName}` },
  ]
}

/** Root-level properties every compile path shares: background, padding, config, title, description. */
function rootChrome(out: Record<string, unknown>, spec: VLSpec): void {
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  out.background = spec.background ?? (userConfig?.background as string | undefined) ?? 'white'
  out.padding = spec.padding ?? (userConfig?.padding as unknown) ?? 5
  const assembledConfig = assembleConfig(spec)
  if (assembledConfig) out.config = assembledConfig
  if (spec.title) out.title = spec.title
  if (spec.description) out.description = spec.description
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
type DomainEntry = { data: string; field: string } | unknown[]

/** The entries a domain reads, or null when the domain is a signal or otherwise not unionable. */
function domainEntries(domain: unknown): DomainEntry[] | null {
  if (Array.isArray(domain)) return [domain]
  if (!isObject(domain)) return null
  const d = domain as { data?: unknown; field?: unknown; fields?: unknown }
  if (typeof d.data === 'string' && typeof d.field === 'string') return [{ data: d.data, field: d.field }]
  if (typeof d.data === 'string' && Array.isArray(d.fields) && d.fields.every((f) => typeof f === 'string')) {
    return (d.fields as string[]).map((f) => ({ data: d.data as string, field: f }))
  }
  if (Array.isArray(d.fields)) {
    const out: DomainEntry[] = []
    for (const f of d.fields) {
      const e = domainEntries(f)
      if (!e) return null
      out.push(...e)
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
    // the first layer's type wins unless a later one set it explicitly
    const typed = list.find((s) => EXPLICIT_SCALE_PROPS.get(s)?.has('type'))
    merged.type = (typed ?? first).type
    // domain: union data references; identical non-reference domains merge
    const domains = list.map((s) => s.domain)
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
      const refs = entries.filter((e): e is { data: string; field: string } => !Array.isArray(e))
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
function compileFaceted(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const facetDef = isObject(spec.facet) ? (spec.facet as Record<string, unknown>) : undefined
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const encFacet = isObject(enc.facet) ? (enc.facet as Record<string, unknown>) : undefined
  const rowDef = (facetDef?.row ?? encFacet?.row ?? enc.row) as Record<string, unknown> | undefined
  const colDef = (facetDef?.column ?? encFacet?.column ?? enc.column) as Record<string, unknown> | undefined
  // header label formatting reads the channel def (type + format)
  const normalizeHeaderDef = (def: Record<string, unknown> | undefined): FieldDef | undefined =>
    def ? parseChannel('column', def) ?? undefined : undefined
  // the inner unit: top-level facet form uses spec.spec; the encoding form
  // strips the facet channel from the encoding
  let innerSpec: VLSpec
  if (isObject(spec.spec)) {
    innerSpec = { ...(spec.spec as VLSpec) }
    if (!isObject(innerSpec.data) && isObject(spec.data)) innerSpec.data = spec.data
  } else {
    const enc = { ...(isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}) }
    delete enc.facet
    delete enc.row
    delete enc.column
    innerSpec = { ...spec, encoding: enc }
  }
  const inner = compileUnitView(innerSpec, ctx)
  // The inner unit may carry a DECLARED source name (vega-lite preserves it);
  // facet references must target whatever the inner marks actually read.
  const innerDataName = (((inner.marks as Record<string, unknown>[])?.[0]?.from as { data?: string } | undefined)?.data) ?? 'data_0'

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
  // vega-lite appends the facet fields to the inner pipeline's grouping
  // transforms (stack groupby, aggregate/joinaggregate groupby, window
  // partitionby, pivot groupby — see FacetModel.addDimensions) so that
  // stacking etc. restart within each facet cell rather than spanning them.
  const facetKeys = [rowField, colField].filter(Boolean) as string[]
  // a timeUnit facet field is computed in the child dataflow (cast + timeunit)
  // even though it is not part of the inner encoding
  const facetTimeUnits = [rowFd, colFd].filter((f): f is FieldDef => f != null && !!f.timeUnit)
  if (facetTimeUnits.length) {
    for (const d of (inner.data as Record<string, unknown>[]) ?? []) {
      const trs = d.transform as Record<string, unknown>[] | undefined
      if (!Array.isArray(trs)) continue
      if (trs.some((t) => t.type === 'timeunit' && Array.isArray(t.units))) continue
      const pre: Record<string, unknown>[] = []
      for (const fd of facetTimeUnits) {
        pre.push({ type: 'formula', expr: `toDate(datum[${JSON.stringify(fd.field)}])`, as: fd.field })
        pre.push(timeUnitTransform(fd.tu!, fd.field, timeUnitField(fd)))
      }
      trs.unshift(...pre)
    }
  }
  if (facetKeys.length) {
    for (const d of (inner.data as Record<string, unknown>[]) ?? []) {
      for (const t of (d.transform as Record<string, unknown>[]) ?? []) {
        if (t.type === 'stack' || t.type === 'aggregate' || t.type === 'joinaggregate' || t.type === 'pivot') {
          if (Array.isArray(t.groupby)) t.groupby = [...t.groupby, ...facetKeys]
        } else if (t.type === 'window') {
          if (Array.isArray(t.partitionby)) t.partitionby = [...t.partitionby, ...facetKeys]
        }
      }
    }
  }
  // vega-lite sizes the children of a TOP-LEVEL facet spec ({facet, spec})
  // from the view defaults, NOT the facet's width/height: a discrete
  // positional scale gets step sizing (a `x_step`/`y_step` signal plus a
  // `child_width`/`child_height` bandspace update, and the scale's range
  // becomes `{step: {signal}}`), while a continuous one gets the
  // continuousWidth/Height default (300). The encoding-facet form inherits
  // the spec's width/height (calibrated against the oracle).
  const isTopLevelFacet = isObject(spec.facet)
  const facetChildSignals: Record<string, unknown>[] = []
  const stepSizeFor = (name: 'x' | 'y'): unknown => {
    const sc = (inner.scales as ScaleSpec[]).find((s) => s.name === name)
    if (sc && (sc.type === 'band' || sc.type === 'point')) {
      const stepName = `${name}_step`
      facetChildSignals.push({ name: stepName, value: 20 })
      const pi = sc.type === 'band' ? (sc.paddingInner ?? 0.1) : 1
      const po = sc.type === 'band' ? (sc.paddingOuter ?? (sc.paddingInner ?? 0.1) / 2) : (sc.padding ?? 0.5)
      sc.range = { step: { signal: stepName } }
      return { signal: `bandspace(domain('${name}').length, ${pi}, ${po}) * ${stepName}` }
    }
    return 300
  }
  let childWidth: unknown = typeof spec.width === 'number' ? spec.width : 300
  let childHeight: unknown = typeof spec.height === 'number' ? spec.height : 300
  if (isTopLevelFacet) {
    childWidth = stepSizeFor('x')
    childHeight = stepSizeFor('y')
  }

  // patch the inner scales' ranges onto the child size signals and rename the
  // tickCount size references
  const patchSizeRefs = (node: Record<string, unknown>): void => {
    const s = JSON.stringify(node).replace(/\bwidth\/40\)/g, 'child_width/40)').replace(/\bheight\/40\)/g, 'child_height/40)')
    return void s
  }
  const renameSizeSignals = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/ceil\(width\/40\)/g, 'ceil(child_width/40)').replace(/ceil\(height\/40\)/g, 'ceil(child_height/40)')
        .replace(/ceil\(width\/10\)/g, 'ceil(child_width/10)').replace(/ceil\(height\/10\)/g, 'ceil(child_height/10)')
    }
    return v
  }
  const walkRename = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walkRename); return }
    if (node != null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'signal' && typeof v === 'string') {
          ;(node as Record<string, unknown>)[k] = renameSizeSignals(v)
        } else if (k === 'tickCount' && v != null && typeof v === 'object' && 'signal' in (v as object)) {
          ;(node as Record<string, unknown>)[k] = { signal: renameSizeSignals((v as { signal: string }).signal) }
        } else {
          walkRename(v)
        }
      }
    }
  }
  const isStepRange = (r: unknown): boolean => r != null && typeof r === 'object' && !Array.isArray(r) && 'step' in (r as object)
  for (const sc of inner.scales as ScaleSpec[]) {
    // a discrete scale already sized by a step keeps its {step} range (the
    // child size signal is derived FROM it, so pointing the range back at the
    // size signal would be a dataflow cycle)
    if (sc.name === 'x' && !isStepRange(sc.range)) sc.range = [0, { signal: 'child_width' }]
    if (sc.name === 'y' && !isStepRange(sc.range)) sc.range = [{ signal: 'child_height' }, 0]
  }
  walkRename(inner.axes ?? [])
  walkRename(inner.marks)

  // split the inner axes: grid axes stay in the cell, label axes move to the
  // row header (y) / column footer (x)
  const gridAxes: Record<string, unknown>[] = []
  const yLabelAxes: Record<string, unknown>[] = []
  const xLabelAxes: Record<string, unknown>[] = []
  for (const a of (inner.axes ?? []) as Record<string, unknown>[]) {
    if (a.grid === true) gridAxes.push(a)
    else if (a.orient === 'left' || a.orient === 'right') yLabelAxes.push(a)
    else xLabelAxes.push(a)
  }

  // child marks read the facet dataset
  const childMarks = (inner.marks as Record<string, unknown>[]).map((m) => {
    const c = { ...m }
    const from = (c.from as { data?: string } | undefined) ?? {}
    if (from.data === innerDataName || from.data == null) c.from = { ...from, data: 'facet' }
    return c
  })

  const facetGroupby = [rowField, colField].filter(Boolean) as string[]
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
    const fmt = hdr?.format as string | undefined
    let text: unknown
    if (fmt) {
      text = { signal: def?.type === 'temporal' ? `timeFormat(parent[${JSON.stringify(f)}], ${JSON.stringify(fmt)})` : `format(parent[${JSON.stringify(f)}], ${JSON.stringify(fmt)})` }
    } else if (def?.timeUnit) {
      text = { signal: `timeFormat(parent[${JSON.stringify(f)}], ${timeUnitFormatSignal(def.timeUnit)})` }
    } else if (def?.type === 'temporal') {
      text = { signal: `timeFormat(parent[${JSON.stringify(f)}], "%b %d, %Y")` }
    } else if (def?.type === 'quantitative' || (def?.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(def.aggregate))) {
      text = { signal: `format(parent[${JSON.stringify(f)}], "")` }
    } else {
      text = { signal: `isValid(parent[${JSON.stringify(f)}]) ? parent[${JSON.stringify(f)}] : ""+parent[${JSON.stringify(f)}]` }
    }
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

  const marks: Record<string, unknown>[] = []
  if (rowField) {
    const cfgHeaderR = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    const hdrR = { ...(cfgHeaderR ?? {}), ...(rowDef?.header as Record<string, unknown> | undefined ?? {}) }
    marks.push({ name: 'row-title', type: 'group', role: 'row-title', title: { text: hdrR.title ?? (rowFd ? channelTitle(rowFd) : rowField), ...(hdrR.title != null ? {} : { orient: 'left' }), style: 'guide-title', offset: (hdrR.titlePadding as number | undefined) ?? 10 } })
  }
  if (colField) {
    const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    const hdrC = { ...(cfgHeader ?? {}), ...(colDef?.header as Record<string, unknown> | undefined ?? {}) }
    const ct: Record<string, unknown> = { text: hdrC.title ?? (colFd ? channelTitle(colFd) : colField), style: 'guide-title', offset: (hdrC.titlePadding as number | undefined) ?? 10 }
    if (hdrC.titleColor != null) ct.color = hdrC.titleColor
    if (hdrC.titleFontSize != null) ct.fontSize = hdrC.titleFontSize
    if (hdrC.titleFont != null) ct.font = hdrC.titleFont
    if (hdrC.titleFontWeight != null) ct.fontWeight = hdrC.titleFontWeight
    if (hdrC.titleLimit != null) ct.limit = hdrC.titleLimit
    if (hdrC.titleAngle != null) {
      const ang = Number(hdrC.titleAngle)
      ct.angle = ang
      ct.baseline = 'bottom'
      ct.align = ang === 0 ? 'center' : ang < 0 ? 'left' : 'right'
    }
    // A per-channel header.orient moves the band/title; config.header.orient is
    // ignored for the title (probed config-header-orient-left stays at top).
    const defHeaderC = colDef?.header as Record<string, unknown> | undefined
    const ctOrient = hdrC.titleOrient ?? (defHeaderC?.orient as string | undefined)
    if (ctOrient != null) ct.orient = ctOrient
    if (hdrC.titleBaseline != null) ct.baseline = hdrC.titleBaseline
    if (hdrC.titleAnchor != null) {
      ct.anchor = hdrC.titleAnchor
      if (hdrC.titleAlign == null) ct.align = hdrC.titleAnchor === 'start' ? 'left' : hdrC.titleAnchor === 'end' ? 'right' : 'center'
    }
    if (hdrC.titleAlign != null) ct.align = hdrC.titleAlign
    // vega-lite moves a side-oriented column header title onto the facet's
    // row-title role (left/right side of the grid); top/bottom stay column
    // titles.
    const sideTitle = ct.orient === 'left' || ct.orient === 'right'
    marks.push({ name: 'column-title', type: 'group', role: sideTitle ? 'row-title' : 'column-title', title: ct })
  }
  // row header: carries the y label axis (+ per-row titles when row-faceted)
  marks.push({
    name: 'row_header',
    type: 'group',
    role: 'row-header',
    ...(rowField ? {
      from: { data: 'row_domain' },
      sort: { field: datumRef(rowField), order: rowOrder },
      title: parentTitle(rowField, rowFd ?? normalizeHeaderDef(rowDef)),
    } : {}),
    encode: { update: { height: { signal: 'child_height' } } },
    ...(yLabelAxes.length ? { axes: yLabelAxes } : {}),
  })
  if (colField) {
    const hdrCLabelsDisabled = (() => {
      const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
      const hdr = { ...(cfgHeader ?? {}), ...(colDef?.header as Record<string, unknown> | undefined ?? {}) }
      return hdr.labels === false
    })()
    // labels:false still creates the header group (an empty one): the grid
    // layout measures it even though vega renders no label text, and dropping
    // it shifts the column title by a pixel.
    marks.push({
      name: 'column_header',
      type: 'group',
      role: 'column-header',
      from: { data: 'column_domain' },
      sort: { field: datumRef(colField), order: colOrder },
      ...(!hdrCLabelsDisabled
        ? { title: (() => {
            const t = parentTitle(colField, colFd ?? normalizeHeaderDef(colDef)) as Record<string, unknown>
            delete t.orient
            const cfgHeaderC = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
            const defHeaderC = colDef?.header as Record<string, unknown> | undefined
            // config.header.orient does not move the labels; a channel header's
            // own orient does (and labelOrient wins over it).
            const labelOrient = (defHeaderC?.labelOrient as string | undefined)
              ?? (defHeaderC?.orient as string | undefined)
              ?? (cfgHeaderC?.labelOrient as string | undefined)
              ?? 'top'
            if (labelOrient !== 'top') t.labelOrient = labelOrient
            return t
          })() }
        : {}),
      encode: { update: { width: { signal: 'child_width' } } },
    })
  }
  marks.push({
    name: 'column_footer',
    type: 'group',
    role: 'column-footer',
    ...(colField ? {
      from: { data: 'column_domain' },
      sort: { field: datumRef(colField), order: colOrder },
    } : {}),
    encode: { update: { width: { signal: 'child_width' } } },
    ...(xLabelAxes.length ? { axes: xLabelAxes } : {}),
  })
  marks.push({
    name: 'cell',
    type: 'group',
    style: 'cell',
    from: { facet: { name: 'facet', data: innerDataName, groupby: facetGroupby } },
    sort: { field: facetGroupby.map(datumRef), order: facetGroupby.map((_, i) => (i === 0 && rowField ? rowOrder : colOrder)) },
    encode: { update: { width: { signal: 'child_width' }, height: { signal: 'child_height' } } },
    ...(gridAxes.length ? { axes: gridAxes } : {}),
    marks: childMarks,
  })

  // facet domain datasets
  const data = [...(inner.data as Record<string, unknown>[])]
  // probed: an aggregated facet def does NOT aggregate the child pipeline —
  // every facet reference (cell groupby, domain, stack series, header label)
  // keys on the aggregated name, which the pipeline never computes, so the
  // facet collapses to a single (undefined) group exactly like upstream
  if (colField) data.push({ name: 'column_domain', source: innerDataName, transform: [{ type: 'aggregate', groupby: [colField] }] })
  if (rowField) data.push({ name: 'row_domain', source: innerDataName, transform: [{ type: 'aggregate', groupby: [rowField] }] })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = autosizeOf(spec)
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.data = data
  const sizeSignalDef = (name: string, v: unknown): Record<string, unknown> =>
    v != null && typeof v === 'object' && 'signal' in (v as object)
      ? { name, update: (v as { signal: string }).signal }
      : { name, value: v }
  out.signals = [
    ...facetChildSignals,
    sizeSignalDef('child_width', childWidth),
    sizeSignalDef('child_height', childHeight),
  ]
  const rowSpacing = typeof rowDef?.spacing === 'number' ? rowDef.spacing : undefined
  const colSpacing = typeof colDef?.spacing === 'number' ? colDef.spacing : undefined
  const cTitle = (marks.find((m) => m.name === 'column-title')?.title ?? {}) as Record<string, unknown>
  const cTitleOrient = cTitle.orient as string | undefined
  out.layout = {
    padding: rowSpacing != null || colSpacing != null
      ? { row: rowSpacing ?? 20, column: colSpacing ?? 20 }
      : 20,
    ...(cTitleOrient === 'right' || cTitleOrient === 'bottom'
      ? { titleAnchor: { ...(cTitleOrient === 'right' ? { row: 'end' } : {}), ...(cTitleOrient === 'bottom' ? { column: 'end' } : {}) } }
      : {}),
    offset: {
      ...(rowField ? { rowTitle: 10 } : {}),
      ...(colField ? { columnTitle: 10 } : {}),
    },
    columns: colField ? { signal: "length(data('column_domain'))" } : 1,
    bounds: 'full',
    align: 'all',
  }
  out.marks = marks
  out.scales = inner.scales
  if (inner.axes == null) delete inner.axes
  if (inner.legends && (inner.legends as unknown[]).length) out.legends = inner.legends
  if (spec.title) out.title = spec.title
  void patchSizeRefs
  return out
}

// --- concat / repeat composition ---------------------------------------------

/** Channels that own a scale (those whose aggregate output takes part in the invalid-value filter). */
const SCALE_CHANNELS = ['x', 'y', 'color', 'size', 'opacity', 'shape', 'strokeWidth', 'theta', 'xOffset', 'yOffset']

/** Scale channels that are independent per child of a concat/repeat (everything else is shared). */
const INDEPENDENT_SCALES = new Set(['x', 'y', 'xOffset', 'yOffset', 'theta', 'radius'])

/** Compile a child view (unit, layer or boxplot) to a standalone Vega fragment. */
function compileChildFragment(child: VLSpec, ctx: CompileCtx): VLSpec {
  if (Array.isArray(child.layer)) return compileLayered(child, ctx)
  if (child.mark === 'boxplot' || (isObject(child.mark) && (child.mark as Record<string, unknown>).type === 'boxplot')) return compileBoxplot(child, ctx)
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
  signals: Record<string, unknown>[]
  marks: Record<string, unknown>[]
  scales: ScaleSpec[]
  legends: Record<string, unknown>[]
  /** root size properties (the cross dimension of a single row/column) */
  rootWidth?: unknown
  rootHeight?: unknown
}

/**
 * Embed compiled children as groups: datasets are shared by source and
 * renamed apart, positional scales are prefixed per child, non-positional
 * scales are SHARED across children (merged, domains unioned) with one legend
 * per channel, and sizes follow vega-lite's layout-size merging.
 */
function embedCells(cells: CompositeCell[], parent: VLSpec, ctx: CompileCtx, layout: 'row' | 'column' | 'grid'): CompositeResult {
  const parentData = isObject(parent.data) ? dataSource(parent.data, ctx.datasets) : undefined
  const parentSourceName = parentData && typeof parentData.name === 'string' ? parentData.name : ctx.sn(0)
  const parentTransform = Array.isArray(parent.transform) ? (parent.transform as unknown[]) : []
  let nextSource = 1
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
      child.data = { ...dataSource(child.data, ctx.datasets), name: ctx.sn(nextSource++) }
    }
    if (parent.config !== undefined) child.config = parent.config
    delete child.params
    const vg = compileChildFragment(child, ctx)
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
  const scaleLists = new Map<string, ScaleSpec[]>()
  const legendsByChannel = new Map<string, Record<string, unknown>>()
  const legendOrder: string[] = []
  const independentScales: ScaleSpec[] = []

  frags.forEach(({ cell, vg }) => {
    const { prefix } = cell
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
      const newName = ctx.dn(nextData++)
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
      if (n !== 'width' && n !== 'height') sigMap.set(n, `${prefix}${n}`)
    }
    const scaleMap = new Map<string, string>()
    const scales = (vg.scales as ScaleSpec[]) ?? []
    for (const sc of scales) {
      const independent = INDEPENDENT_SCALES.has(sc.name) || sc.name.startsWith('layer_')
      if (independent) scaleMap.set(sc.name, `${prefix}${sc.name}`)
    }
    const renames = { signals: sigMap, scales: scaleMap }
    renameFragment(vg.scales, renames)
    renameFragment(vg.marks, renames)
    renameFragment(vg.axes ?? [], renames)
    renameFragment(vg.legends ?? [], renames)
    renameFragment(ownSignals, renames)
    for (const sc of scales) {
      const to = scaleMap.get(sc.name)
      if (to !== undefined) sc.name = to
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
    for (const sc of scales) {
      if (cellPrefixed(sc.name, prefix)) independentScales.push(sc)
      else {
        const l = scaleLists.get(sc.name)
        if (l) l.push(sc)
        else scaleLists.set(sc.name, [sc])
      }
    }
    // shared legends: the first child that has a channel defines it; titles join
    for (const lg of ((vg.legends as Record<string, unknown>[] | undefined) ?? [])) {
      const ch = legendChannel(lg)
      const have = legendsByChannel.get(ch)
      if (!have) {
        legendsByChannel.set(ch, lg)
        legendOrder.push(ch)
      } else if (typeof have.title === 'string' && typeof lg.title === 'string' && have.title !== lg.title && !have.title.split(', ').includes(lg.title)) {
        have.title = `${have.title}, ${lg.title}`
      }
    }

    const group: Record<string, unknown> = {
      name: `${prefix}group`,
      type: 'group',
      style: (vg.style as string | undefined) ?? 'cell',
      encode: { update: { width: { signal: wName }, height: { signal: hName } } },
    }
    if (vg.title) group.title = vg.title
    group.marks = vg.marks as Record<string, unknown>[]
    if (Array.isArray(vg.axes) && vg.axes.length) group.axes = vg.axes
    marks.push(group)
  })

  const mergedShared = mergeLayerScales([...scaleLists.values()].flat().map((s) => [s]))
  return {
    data,
    signals,
    marks,
    scales: [...independentScales, ...mergedShared],
    legends: legendOrder.map((c) => legendsByChannel.get(c)!),
    ...(planW === 'root' ? { rootWidth: sameW } : {}),
    ...(planH === 'root' ? { rootHeight: sameH } : {}),
  }
}

function cellPrefixed(name: string, prefix: string): boolean {
  return name.startsWith(prefix)
}

function legendChannel(lg: Record<string, unknown>): string {
  for (const k of ['fill', 'stroke', 'shape', 'size', 'opacity', 'strokeWidth', 'strokeDash', 'fillOpacity', 'strokeOpacity', 'angle']) {
    if (typeof lg[k] === 'string') return `${k}:${lg[k]}`
  }
  return JSON.stringify(lg)
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
    : kind === 'vconcat' ? 'column' : 'grid'
  const res = embedCells(cells, spec, ctx, layout)
  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = autosizeOf(spec)
  if (res.rootWidth !== undefined) out.width = res.rootWidth
  if (res.rootHeight !== undefined) out.height = res.rootHeight
  out.data = res.data
  if (res.signals.length) out.signals = res.signals
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
    const layers = (rep.layer as unknown[]).map((v) => substituteRepeat(child, { layer: v }) as VLSpec)
    const layered: VLSpec = { ...spec, layer: layers }
    delete layered.repeat
    delete layered.spec
    return compileLayered(layered, ctx)
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
        cells.push({ prefix: `child__${signalSafe(key)}_`, spec: substituteRepeat(child, repMap) as VLSpec })
      }
    }
  } else {
    for (const v of colFields) cells.push({ prefix: `child__${signalSafe(String(v))}_`, spec: substituteRepeat(child, { repeat: v }) as VLSpec })
  }
  const grid = isGrid && rowFields.length > 0 && colFields.length > 0
  const columns = grid ? colFields.length : !isGrid ? spec.columns : undefined
  const layout: 'row' | 'column' | 'grid' = grid || columns !== undefined ? 'grid' : isGrid && rowFields.length > 0 ? 'column' : 'row'
  const res = embedCells(cells, spec, ctx, layout)
  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = autosizeOf(spec)
  if (res.rootWidth !== undefined) out.width = res.rootWidth
  if (res.rootHeight !== undefined) out.height = res.rootHeight
  out.data = res.data
  if (res.signals.length) out.signals = res.signals
  out.layout = compositeLayout(spec, { align: 'all', columns })
  out.marks = res.marks
  out.scales = res.scales
  if (res.legends.length) out.legends = res.legends
  rootChrome(out, spec)
  return out
}

// --- boxplot composite -------------------------------------------------------

/** Expand a boxplot composite mark into the layered aggregate structure
 * vega-lite compiles it to: outliers, whisker rules, the box and the median
 * bar. Vertical orientation only; `extent` is a number (outlier fence in IQRs)
 * or "min-max" (whiskers span the data, no outlier layer). */
function compileBoxplot(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const markDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : { type: 'boxplot' }
  const extent = (markDef.extent as number | 'min-max' | undefined) ?? 1.5
  const minMax = extent === 'min-max'
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  for (const k of Object.keys(enc)) {
    if (k !== 'x' && k !== 'y') throw new VLCompileError(`encoding.${k}: boxplot only supports the x and y channels`)
  }
  const xFd = parseChannel('x', enc.x)
  const yFd = parseChannel('y', enc.y)
  if (!xFd || !yFd || xFd.aggregate || yFd.aggregate || xFd.bin || yFd.bin || xFd.timeUnit || yFd.timeUnit) {
    throw new VLCompileError('boxplot requires plain x and y fields (no aggregate, bin or timeUnit)')
  }
  for (const [ch, fd] of [['x', xFd], ['y', yFd]] as const) {
    for (const k of Object.keys(fd.raw)) {
      if (k !== 'field' && k !== 'type' && k !== 'title') throw new VLCompileError(`encoding.${ch}.${k}: boxplot supports only field, type and title on x/y`)
    }
  }
  const isDiscreteX = xFd.type === 'nominal' || xFd.type === 'ordinal'
  if (!isDiscreteX || yFd.type !== 'quantitative') {
    throw new VLCompileError('boxplot supports only a discrete x with a quantitative y (horizontal boxplots are not supported yet)')
  }
  const dim = xFd.field
  const F = yFd.field
  const lowerBox = genName('lower_box', F)
  const upperBox = genName('upper_box', F)
  const midBox = genName('mid_box', F)
  const minF = genName('min', F)
  const maxF = genName('max', F)
  const lowerW = genName('lower_whisker', F)
  const upperW = genName('upper_whisker', F)
  const ref = dref
  const outlierExpr =
    `(${ref(F)} < ${ref(lowerBox)} - ${extent} * (${ref(upperBox)} - ${ref(lowerBox)})) || ` +
    `(${ref(F)} > ${ref(upperBox)} + ${extent} * (${ref(upperBox)} - ${ref(lowerBox)}))`
  const inlierExpr =
    `(${ref(lowerBox)} - ${extent} * (${ref(upperBox)} - ${ref(lowerBox)}) <= ${ref(F)}) && ` +
    `(${ref(F)} <= ${ref(upperBox)} + ${extent} * (${ref(upperBox)} - ${ref(lowerBox)}))`

  const source: Record<string, unknown> = isObject(spec.data) ? dataSource(spec.data, ctx.datasets) : {}
  const sourceName = typeof source.name === 'string' ? source.name : 'source_0'
  source.name = sourceName

  // flat copies of nested/escaped fields, then the user's transforms
  const pre = (): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const fd of [xFd, yFd]) {
      if (fd.flatExpr !== undefined && !seen.has(fd.field)) {
        seen.add(fd.field)
        out.push({ type: 'formula', expr: fd.flatExpr, as: fd.field })
      }
    }
    const userT = Array.isArray(spec.transform) ? (spec.transform as Record<string, unknown>[]) : []
    out.push(...translateTransforms(userT, ctx, { parsed: new Map() }))
    return out
  }

  const bandX = { scale: 'x', field: dim, band: 0.5 }
  const ruleStroke = { value: 'black' }
  const boxFill = { value: '#4c78a8' }
  const medianMark = (name: string, dataset: string): Record<string, unknown> => ({
    name,
    type: 'rect',
    style: ['box'],
    from: { data: dataset },
    encode: { update: {
      opacity: { value: 0.7 },
      fill: [{ test: `${ref(lowerBox)} >= ${ref(upperBox)}`, value: '#4c78a8' }, { value: 'white' }],
      xc: bandX,
      width: { value: 14 },
      yc: { scale: 'y', field: midBox },
      height: { value: 1 },
    } },
  })
  const boxMark = (name: string, dataset: string): Record<string, unknown> => ({
    name,
    type: 'rect',
    style: ['box'],
    from: { data: dataset },
    encode: { update: {
      ariaRoleDescription: { value: 'box' },
      fill: boxFill,
      xc: bandX,
      width: { value: 14 },
      y: { scale: 'y', field: lowerBox },
      y2: { scale: 'y', field: upperBox },
    } },
  })

  let marks: Record<string, unknown>[]
  let data: Record<string, unknown>[]
  let xDomainData: string[]
  let yDomain: Array<{ data: string; field: string }>
  if (minMax) {
    marks = [
      { name: 'layer_0_marks', type: 'rule', style: ['rule'], from: { data: 'data_1' }, encode: { update: { stroke: ruleStroke, x: bandX, y: { scale: 'y', field: lowerW }, y2: { scale: 'y', field: lowerBox } } } },
      { name: 'layer_1_marks', type: 'rule', style: ['rule'], from: { data: 'data_2' }, encode: { update: { stroke: ruleStroke, x: bandX, y: { scale: 'y', field: upperBox }, y2: { scale: 'y', field: upperW } } } },
      boxMark('layer_2_marks', 'data_3'),
      medianMark('layer_3_marks', 'data_4'),
    ]
    data = [
      source,
      { name: 'data_0', source: sourceName, transform: [...pre(), { type: 'aggregate', groupby: [dim], ops: ['q1', 'q3', 'median', 'min', 'max'], fields: [F, F, F, F, F], as: [lowerBox, upperBox, midBox, lowerW, upperW] }] },
      { name: 'data_1', source: 'data_0', transform: [{ type: 'filter', expr: validExpr(lowerW) }] },
      { name: 'data_2', source: 'data_0', transform: [{ type: 'filter', expr: validExpr(upperBox) }] },
      { name: 'data_3', source: 'data_0', transform: [{ type: 'filter', expr: validExpr(lowerBox) }] },
      { name: 'data_4', source: 'data_0', transform: [{ type: 'filter', expr: validExpr(midBox) }] },
    ]
    xDomainData = ['data_1', 'data_2', 'data_3', 'data_4']
    yDomain = [
      { data: 'data_1', field: lowerW }, { data: 'data_1', field: lowerBox },
      { data: 'data_2', field: upperBox }, { data: 'data_2', field: upperW },
      { data: 'data_3', field: lowerBox }, { data: 'data_3', field: upperBox },
      { data: 'data_4', field: midBox },
    ]
  } else {
    if (typeof extent !== 'number' || !Number.isFinite(extent) || extent < 0) throw new VLCompileError(`mark.extent must be a non-negative number or "min-max", got ${JSON.stringify(extent)}`)
    marks = [
      {
        name: 'layer_0_layer_0_marks',
        type: 'symbol',
        style: ['point'],
        from: { data: 'data_2' },
        encode: { update: {
          opacity: { value: 0.7 },
          fill: { value: 'transparent' },
          stroke: { value: '#4c78a8' },
          ariaRoleDescription: { value: 'point' },
          x: bandX,
          y: { scale: 'y', field: F },
        } },
      },
      { name: 'layer_0_layer_1_layer_0_marks', type: 'rule', style: ['rule'], from: { data: 'data_4' }, encode: { update: { stroke: ruleStroke, x: bandX, y: { scale: 'y', field: lowerW }, y2: { scale: 'y', field: lowerBox } } } },
      { name: 'layer_0_layer_1_layer_1_marks', type: 'rule', style: ['rule'], from: { data: 'data_5' }, encode: { update: { stroke: ruleStroke, x: bandX, y: { scale: 'y', field: upperBox }, y2: { scale: 'y', field: upperW } } } },
      boxMark('layer_1_layer_0_marks', 'data_7'),
      medianMark('layer_1_layer_1_marks', 'data_8'),
    ]
    data = [
      source,
      { name: 'data_1', source: sourceName, transform: [...pre(), { type: 'joinaggregate', as: [lowerBox, upperBox], ops: ['q1', 'q3'], fields: [F, F], groupby: [dim] }] },
      { name: 'data_2', source: 'data_1', transform: [{ type: 'filter', expr: outlierExpr }, { type: 'filter', expr: validExpr(F) }] },
      {
        name: 'data_3',
        source: 'data_1',
        transform: [
          { type: 'filter', expr: inlierExpr },
          { type: 'aggregate', groupby: [dim], ops: ['min', 'max', 'min', 'max'], fields: [F, F, lowerBox, upperBox], as: [lowerW, upperW, lowerBox, upperBox] },
        ],
      },
      { name: 'data_4', source: 'data_3', transform: [{ type: 'filter', expr: validExpr(lowerW) }] },
      { name: 'data_5', source: 'data_3', transform: [{ type: 'filter', expr: validExpr(upperBox) }] },
      { name: 'data_6', source: sourceName, transform: [...pre(), { type: 'aggregate', groupby: [dim], ops: ['q1', 'q3', 'median', 'min', 'max'], fields: [F, F, F, F, F], as: [lowerBox, upperBox, midBox, minF, maxF] }] },
      { name: 'data_7', source: 'data_6', transform: [{ type: 'filter', expr: validExpr(lowerBox) }] },
      { name: 'data_8', source: 'data_6', transform: [{ type: 'filter', expr: validExpr(midBox) }] },
    ]
    xDomainData = ['data_2', 'data_4', 'data_5', 'data_7', 'data_8']
    yDomain = [
      { data: 'data_2', field: F },
      { data: 'data_4', field: lowerW }, { data: 'data_4', field: lowerBox },
      { data: 'data_5', field: upperBox }, { data: 'data_5', field: upperW },
      { data: 'data_7', field: lowerBox }, { data: 'data_7', field: upperBox },
      { data: 'data_8', field: midBox },
    ]
  }

  const scales: ScaleSpec[] = [
    {
      name: 'x',
      type: 'band',
      domain: { fields: xDomainData.map((d) => ({ data: d, field: dim })), sort: true },
      range: [0, { signal: 'width' }],
      paddingInner: 0,
      paddingOuter: 0,
    },
    {
      name: 'y',
      type: 'linear',
      domain: { fields: yDomain },
      range: [{ signal: 'height' }, 0],
      zero: true,
      nice: true,
    },
  ]

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = autosizeOf(spec)
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.width = spec.width ?? 200
  out.height = spec.height ?? 200
  out.style = 'cell'
  const assembledConfig = assembleConfig(spec)
  if (assembledConfig) out.config = assembledConfig
  out.data = data
  out.marks = marks
  out.scales = scales
  out.axes = [
    { scale: 'y', orient: 'left', gridScale: 'x', grid: true, tickCount: { signal: 'ceil(height/40)' }, domain: false, labels: false, aria: false, maxExtent: 0, minExtent: 0, ticks: false, zindex: 0 },
    { scale: 'x', orient: 'bottom', grid: false, title: channelTitle(xFd), labelAlign: 'right', labelAngle: 270, labelBaseline: 'middle', zindex: 0 },
    { scale: 'y', orient: 'left', grid: false, title: channelTitle(yFd), labelOverlap: true, tickCount: { signal: 'ceil(height/40)' }, zindex: 0 },
  ]
  if (spec.title) out.title = spec.title
  if (spec.description) out.description = spec.description
  return out
}

// --- channel parsing ---------------------------------------------------------

const TYPE_ALIASES: Record<string, string> = {
  quantitative: 'quantitative', ordinal: 'ordinal', nominal: 'nominal', temporal: 'temporal', geojson: 'geojson',
  q: 'quantitative', o: 'ordinal', n: 'nominal', t: 'temporal',
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
    const withField = conds.filter((c) => c.field !== undefined)
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
    if (isObject(d) || raw.type === 'temporal') throw new VLCompileError(`encoding.${channel}.datum: temporal/DateTime datums are not supported`)
    return {
      channel,
      field: datumSentinel(channel),
      source: '',
      type: typeof raw.type === 'string' ? normalizeType(raw.type, raw, channel) : typeof d === 'number' ? 'quantitative' : 'nominal',
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
    ...(bin ? { binParams: normalizeBin(bin) } : {}),
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

/** Replace every `{scale, field: <datum sentinel>}` in an encode entry with `{scale, value: datum}` (in place). */
function patchDatumRefs(node: unknown, datums: Map<string, unknown>): void {
  if (Array.isArray(node)) { for (const x of node) patchDatumRefs(x, datums); return }
  if (!isObject(node)) return
  if (typeof node.field === 'string' && node.field.startsWith(DATUM_PREFIX)) {
    const ch = node.field.slice(DATUM_PREFIX.length)
    delete node.field
    node.value = datums.get(ch)
    return
  }
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object') patchDatumRefs(v, datums)
}

/**
 * Constant (`datum`/`value`) position channels are implemented for the marks
 * whose position is a plain point (or a rule's end); a datum on a non-position
 * channel is supported for colour only. Everything else throws, never degrades.
 */
function checkConstChannels(mark: string, encoding: Record<string, unknown>): void {
  const pointLike = ['point', 'circle', 'square', 'text', 'rule', 'line', 'trail'].includes(mark)
  for (const [ch, def] of Object.entries(encoding)) {
    if (!isObject(def) || def.field !== undefined) continue
    const isDatum = def.datum !== undefined
    const isValue = def.value !== undefined && def.condition === undefined
    if (isDatum && !['x', 'y', 'x2', 'y2', 'color'].includes(ch)) {
      throw new VLCompileError(`encoding.${ch}.datum is not supported (datum works on x, y, x2, y2 and color)`)
    }
    if ((isDatum || isValue) && ['x', 'y', 'x2', 'y2'].includes(ch) && !pointLike) {
      throw new VLCompileError(`encoding.${ch}: a constant ${isDatum ? 'datum' : 'value'} position is not supported on the "${mark}" mark`)
    }
  }
}

/** Parse every channel of an encoding into field defs (datum-only defs included, flagged). */
function parseEncodingFields(encoding: Record<string, unknown>): FieldDef[] {
  const fields: FieldDef[] = []
  for (const [channel, def] of Object.entries(encoding)) {
    const f = parseChannel(channel, def)
    if (f) fields.push(f)
  }
  return fields
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
  if (Object.keys(style).length) out.style = style
  return Object.keys(out).length ? out : undefined
}

/** Apply config.scale to the compiled positional scales (round on x/y;
 * nice/zero on continuous quantitative ones — the color scale gets none). */
function applyScaleConfig(scales: ScaleSpec[], user: Record<string, unknown> | undefined): void {
  const sc = isObject(user?.scale) ? (user!.scale as Record<string, unknown>) : undefined
  if (!sc) return
  for (const s of scales) {
    if (s.name !== 'x' && s.name !== 'y') continue
    if (sc.round !== undefined) s.round = Boolean(sc.round)
    if (isContinuousScaleType(String(s.type)) && !isTimeScaleType(String(s.type))) {
      if (sc.nice !== undefined) s.nice = sc.nice
      if (sc.zero !== undefined) s.zero = Boolean(sc.zero)
    }
  }
}

const isTimeScaleType = (t: string) => t === 'time' || t === 'utc'

// --- titles ------------------------------------------------------------------

export function channelTitle(def: FieldDef): unknown {
  if (def.datumOnly) return undefined
  if (def.title !== undefined) return def.title
  if (def.aggregate === 'count') return 'Count of Records'
  if (def.argAgg) return `${def.source} for ${def.argAgg.op === 'argmax' ? 'max' : 'min'} ${def.argAgg.argSource}`
  if (def.bin) return `${def.source} (binned)`
  if (def.tu) return `${def.source} (${getTimeUnitParts(def.tu.unit).join('-')})`
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
}

/** Object and array sorts read the raw table; ascending/descending/null read the main one. */
function usesRawDomainSort(f: FieldDef): boolean {
  if (Array.isArray(f.sort)) return true
  return isObject(f.sort) && (f.sort.encoding !== undefined || f.sort.field !== undefined || f.sort.op !== undefined)
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
  /** Generated name for an unnamed source dataset. */
  sn(i: number): string
  /** A generated one-off dataset name (`row_domain`, ...), de-collided from user names. */
  fresh(base: string): string
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
  const ctx: CompileCtx = {
    lookups,
    datasets,
    dn: (i) => `${dataPrefix}_${i}`,
    sn: (i) => `${sourcePrefix}_${i}`,
    fresh: (base) => {
      let n = base
      while (userNames.has(n)) n = `${n}_`
      return n
    },
    addLookupSource(def: Record<string, unknown>): string {
      const entry = dataSource(def, datasets)
      // a bare named dataset is the host-supplied (or main) dataset of that name
      if (typeof entry.name === 'string' && entry.values === undefined && entry.url === undefined) {
        if (!lookups.has(entry.name)) lookups.set(entry.name, { ...entry })
        return entry.name
      }
      const name = `lookup_${hashString(JSON.stringify(entry))}`
      if (!lookups.has(name)) lookups.set(name, { ...entry, name })
      return name
    },
  }
  return ctx
}

/** A Vega data entry for a VL `data` object (values/url/name + format), resolving named `datasets`. */
function dataSource(data: Record<string, unknown>, datasets: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = v
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

  // flatten nested/escaped source paths into the flat keys the rest of the
  // compiler reads (names.ts flatField); once per distinct key per source
  const addFlat = (userPath: string): void => {
    const ff = flatField(userPath)
    if (ff.expr === undefined || castDone.has(`flat:${ff.key}`)) return
    castDone.add(`flat:${ff.key}`)
    casts.push({ type: 'formula', expr: ff.expr, as: ff.key })
  }
  for (const f of fields) if (f.flatExpr !== undefined) addFlat(f.source)
  for (const p of referencedPaths(spec.encoding)) addFlat(p)

  // type casts (formula) — the oracle emits them around impute/stack pipelines
  // (quantitative -> toNumber, temporal -> toDate)

  // binning: extent + bin transforms ahead of any aggregate
  const binFields = fields.filter((f) => f.bin)
  const binSignals = new Map<string, { startField: string; endField: string; binsSignal: string }>()
  for (const f of binFields) {
    const names = binNames(f.binParams!, f.field)
    pipeline.push(...binTransforms(f.binParams!, f.field, names))
    binSignals.set(f.field, { startField: names.start, endField: names.end, binsSignal: names.signal })
  }

  // arc marks: theta stacking (pie layout). vega-lite stacks the theta
  // measure over the whole data (no groupby), sorted by the series field,
  // then filters invalid theta values.
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  const arcTheta = thetaStackInfo(mark, fields)
  const radiusDefP = fields.find((f) => f.channel === 'radius' && f.field)
  if (mark === 'arc' && thetaDef && arcTheta) {
    if (radiusDefP?.aggregate) {
      // an aggregated radius measure: aggregate it (grouped by the raw theta
      // field — the polar dimension), filtering both endpoints
      const groupby = fields.filter((f) => f.field && !f.aggregate && f.channel !== 'radius').map((f) => f.field)
      pipeline.push({ type: 'aggregate', groupby, ops: [radiusDefP.aggregate!], fields: [radiusDefP.field], as: [aggFieldName(radiusDefP)] })
      const filt = ['theta', 'radius'].map((ch) => {
        const f = fields.find((ff) => ff.channel === ch && ff.field)
        return f ? `isValid(datum[${JSON.stringify(aggFieldName(f))}]) && isFinite(+datum[${JSON.stringify(aggFieldName(f))}])` : null
      }).filter(Boolean).join(' && ')
      if (filt) pipeline.push({ type: 'filter', expr: filt })
    } else if (radiusDefP) {
      // radius stacking (radius.stack): the polar dimension (theta) groups,
      // the radius measure stacks into radius_start/end
      if (radiusDefP.stack != null && radiusDefP.stack !== false) {
        pipeline.push({
          type: 'stack',
          groupby: [thetaDef.field],
          field: radiusDefP.field,
          sort: { field: [], order: [] },
          as: [`${radiusDefP.field}_start`, `${radiusDefP.field}_end`],
          offset: radiusDefP.stack === true ? 'zero' : radiusDefP.stack,
        })
      }
      const filt = ['theta', 'radius'].map((ch) => {
        const f = fields.find((ff) => ff.channel === ch && ff.field)
        return f ? `isValid(datum[${JSON.stringify(aggFieldName(f))}]) && isFinite(+datum[${JSON.stringify(aggFieldName(f))}])` : null
      }).filter(Boolean).join(' && ')
      if (filt) pipeline.push({ type: 'filter', expr: filt })
    } else if (thetaDef.aggregate) {
      // aggregate the theta measure, grouped by the raw (non-aggregated)
      // field channels, then stack the aggregated field when there is a
      // series to stack by (probed against the oracle)
      const rawFields = fields.filter((f) => f.field && !f.aggregate && f.channel !== 'theta' && f.channel !== 'radius')
      const groupby = rawFields.map((f) => f.field)
      pipeline.push({ type: 'aggregate', groupby, ops: [thetaDef.aggregate!], fields: [thetaDef.field], as: [arcTheta.field] })
      if (groupby.length) {
        pipeline.push({
          type: 'stack',
          groupby: [],
          field: arcTheta.field,
          sort: { field: [groupby[0]!], order: ['ascending'] },
          as: [`${arcTheta.field}_start`, `${arcTheta.field}_end`],
          offset: 'zero',
        })
      }
      pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(arcTheta.field)}]) && isFinite(+datum[${JSON.stringify(arcTheta.field)}])` })
    } else if (arcTheta.stacked) {
      const colorF = fields.find((f) => f.channel === 'color' && f.field)
      pipeline.push({
        type: 'stack',
        groupby: [],
        field: thetaDef.field,
        sort: colorF ? { field: [colorF.field], order: ['ascending'] } : { field: [], order: [] },
        as: [`${thetaDef.field}_start`, `${thetaDef.field}_end`],
        offset: 'zero',
      })
      pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(thetaDef.field)}]) && isFinite(+datum[${JSON.stringify(thetaDef.field)}])` })
    }
  }

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
  const userTransforms = Array.isArray(spec.transform) ? (spec.transform as Record<string, unknown>[]) : []
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
        (measure != null && isStacked(measure, mark, orient, fields)) ||
        (mark === 'arc' && thetaDef != null)
      )
    : false
  const skipCasts = binFields.length > 0 || generatingEnd ||
    ((mark === 'bar' || mark === 'area') &&
    !fields.some((f) => f.aggregate) &&
    !fields.some((f) => f.timeUnit) &&
    fields.some((f) => f.channel === measureChannel && f.type === 'quantitative') &&
    !continuousDimension)
  // fields a user transform produces are derived: vega-lite never re-parses them
  const derivedKeys = new Set<string>()
  {
    const probe: TranslateState = { parsed: new Map() }
    translateTransforms(userTransforms, ctx, probe)
    for (const [k, v] of probe.parsed) if (v === 'derived') derivedKeys.add(k)
  }
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
      if (f.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(String(f.aggregate))
        && (declared === 'nominal' || declared === 'ordinal')) continue
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
      } else if (f.type === 'quantitative') {
        casts.push({ type: 'formula', expr: `toNumber(${dref(f.field)})`, as: f.field })
        castTypes.set(f.field, 'number')
      }
    }
  }
  // user transforms (calculate/filter/flatten/fold/window/...), translated
  // from their Vega-Lite forms (transforms.ts); implicit parses already
  // emitted above (the casts) are not repeated
  const st: TranslateState = { parsed: new Map() }
  for (const [k, ty] of castTypes) st.parsed.set(k, ty)
  const userOut = translateTransforms(userTransforms, ctx, st)
  for (const t of userOut) USER_TRANSFORMS.add(t)
  pipeline.push(...userOut)

  // timeUnit: the timeunit transform floors each date to the unit
  const tuSeen = new Set<string>()
  for (const f of fields.filter((q) => q.tu && q.field)) {
    const as = timeUnitField(f)
    if (tuSeen.has(as)) continue
    tuSeen.add(as)
    pipeline.push(timeUnitTransform(f.tu!, f.field, as))
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

  // arcs run their own aggregate+stack law (thetaStackInfo) — the generic
  // block would aggregate after the stack and mis-group
  if ((hasAggregate && mark !== 'arc') || binFields.length) {
    const groupby: string[] = []
    const fieldsOut: Record<string, unknown>[] = []
    const argFlats: FieldDef[] = []
    let hasCount = false
    for (const f of fields) {
      if (f.bin) {
        const bin = binSignals.get(f.field)!
        groupby.push(bin.startField, bin.endField)
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
        }
      } else if (!f.bin && f.field) {
        // vega-lite groups by every non-aggregated field: the dimension,
        // color/detail, and any other channel's raw field (an aggregate on
        // one channel groups by the other channels — probed: x-aggregate
        // over a quantitative y groups by y)
        groupby.push(aggFieldName(f))
      }
    }
    // a binned measure without an explicit aggregate counts records
    const measureBinned = measure?.bin
    if (fieldsOut.length === 0 && (hasCount || (measureBinned && !hasAggregate))) hasCount = true
    if (hasCount) fieldsOut.push({ op: 'count', as: '__count', field: null })
    // the same output produced twice (two channels sharing a measure) is computed once
    const seenAs = new Set<unknown>()
    const measures = fieldsOut.filter((o) => (seenAs.has(o.as) ? false : (seenAs.add(o.as), true)))
    const groupbyUniq = [...new Set(groupby)]
    if (measures.length || groupbyUniq.length) {
      pipeline.push({ type: 'aggregate', groupby: groupbyUniq, ops: measures.map((o) => o.op), fields: measures.map((o) => o.field ?? null), as: measures.map((o) => o.as) })
      // argmax/argmin leave the winning ROW in the aggregate column; flatten
      // the channel's value out of it (vega-lite reads `argmax_b["a"]`)
      const argDone = new Set<string>()
      for (const f of argFlats) {
        const n = aggFieldName(f)
        if (argDone.has(n)) continue
        argDone.add(n)
        pipeline.push({ type: 'formula', expr: argValueExpr(f), as: n })
      }
      // vega-lite filters invalid values AFTER the aggregate: a variance-family
      // aggregate over a singleton group yields undefined, and the filter then
      // drops the row (which is why the oracle's scales go NaN). Filtering
      // before the aggregate would let the raw rows through.
      const checks: string[] = []
      const seenCheck = new Set<string>()
      const addCheck = (name: string): void => {
        if (seenCheck.has(name)) return
        seenCheck.add(name)
        const q = JSON.stringify(name)
        checks.push(`isValid(datum[${q}]) && isFinite(+datum[${q}])`)
      }
      for (const f of fields) {
        if (!f.field || f.bin) continue
        if (f.aggregate) {
          // only a QUANTITATIVE channel's aggregate output takes part in the
          // invalid filter (a nominal field aggregated with average emits
          // `average_c`, and a temporal field aggregated with stdev emits
          // `stdev_t` — upstream filters neither — probed)
          // scale/legend-bearing channels feed the filter; order/text only
          // sort or label, and vega-lite does not filter their aggregate
          // output (probed: order stderr keeps its undefined rows).
          const declared = (f.raw as Record<string, unknown> | undefined)?.type ?? f.type
          if (f.aggregate !== 'count' && declared === 'quantitative' && SCALE_CHANNELS.includes(f.channel)) addCheck(aggFieldName(f))
        } else if (f.type === 'quantitative' || f.type === 'temporal') {
          addCheck(aggFieldName(f))
        }
      }
      if (checks.length) pipeline.push({ type: 'filter', expr: checks.join(' && ') })
    }
    // binned pipelines filter invalid bins
    if (binFields.length) {
      const bf = binFields[0]!
      const bin = binSignals.get(bf.field)!
      pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(bin.startField)}]) && isFinite(+datum[${JSON.stringify(bin.startField)}])` })
    }
  } else if (stackable && measure && measure.type === 'quantitative' && !measure.bin && isStacked(measure, mark, orient, fields)) {
    // stacked bar/area: continuous dimensions impute gaps; discrete ones filter
    const dimField = dimensionChannel === 'x' ? xDef?.field : yDef?.field
    const colorDef = fields.find((f) => f.channel === 'color')
    const detailDefs = fields.filter((f) => f.channel === 'detail')
    seriesFields = [colorDef, ...detailDefs].filter(Boolean) as FieldDef[]
    const stackField = measure.field
    const startEnd = [`${stackField}_start`, `${stackField}_end`]
    if (continuousDimension) {
      pipeline.push({
        type: 'impute',
        field: stackField,
        groupby: seriesFields.map((f) => aggFieldName(f)),
        key: dimField!,
        method: 'value',
        value: 0,
      })
    }
    const xOffsetPresent = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
    pipeline.push({
      type: 'stack',
      groupby: xOffsetPresent ? [dimField, ...seriesFields.map((f) => aggFieldName(f))].filter(Boolean) : [dimField].filter(Boolean),
      field: stackField,
      sort: { field: seriesFields.map((f) => aggFieldName(f)), order: seriesFields.map(() => 'descending') },
      as: startEnd,
      offset: measureStackOffset(measure),
    })
    if (!continuousDimension) {
      const f = JSON.stringify(stackField)
      pipeline.push({ type: 'filter', expr: `isValid(datum[${f}]) && isFinite(+datum[${f}])` })
    }
  }

  // with user transforms, vl filters invalid values out of the measure fields
  // (skipped when a generating transform replaces the data entirely)
  if (userTransforms.length && !generatingEnd) {
    const quantFields = fields.filter((f) => f.type === 'quantitative' && f.field && f.field !== '__count')
    if (quantFields.length) {
      const parts = quantFields.map((f) => {
        const f2 = JSON.stringify(f.field)
        return `isValid(datum[${f2}]) && isFinite(+datum[${f2}])`
      })
      const last = pipeline[pipeline.length - 1]!
      if (last.type !== 'filter' || last.expr !== parts.join(' && ')) {
        pipeline.push({ type: 'filter', expr: parts.join(' && ') })
      }
    }
  }

  const transforms = [...casts, ...pipeline]
  const dataName = transforms.length ? ctx.dn(0) : sourceName
  return { sourceName, transforms, casts, pipeline, dataName, seriesFields, rawLen, usesRawDomain: fields.some(usesRawDomainSort) }
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

/** Arc theta layout (vega-lite stack.ts + mark/arc.ts + position-rect.ts):
 * - theta unaggregated, no radius channel → stacked (field_start/end)
 * - theta aggregated with a raw field to stack by (color/detail) → aggregate
 *   first, then stack the aggregated field (agg_start/end)
 * - theta aggregated with nothing to stack by, or a radius channel present
 *   (stacked or not) → not stacked: the arc spans startAngle = field,
 *   endAngle = scale zero; a radius channel adds a radius scale driving
 *   outerRadius/innerRadius. */
function thetaStackInfo(mark: string, fields: FieldDef[]): { stacked: boolean; field: string; offsettedRect?: boolean } | null {
  if (mark !== 'arc') return null
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  if (!thetaDef) return null
  const radiusDef = fields.find((f) => f.channel === 'radius' && f.field)
  if (thetaDef.aggregate) {
    const stackBy = fields.some((f) => f.field && !f.aggregate && f.channel !== 'theta' && f.channel !== 'radius')
    return { stacked: stackBy, field: aggregateAs(thetaDef) }
  }
  if (thetaDef.timeUnit) {
    // timeUnit thetas are not stacked; the angles reference the (never
    // populated) offsetted-rect fields — an upstream quirk the sweep pins
    return { stacked: false, field: timeUnitField(thetaDef), offsettedRect: true }
  }
  return { stacked: radiusDef == null, field: thetaDef.field }
}

function aggFieldName(f: FieldDef): string {
  if (f.bin) return binNames(f.binParams!, f.field).start
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

/** Non-positional legends format timeUnit fields with timeFormat. */
function applyTimeUnitLegend(lg: Record<string, unknown>, def: FieldDef, userLegend?: Record<string, unknown>): void {
  if (!def.timeUnit) return
  if (userLegend && userLegend.format !== undefined) return
  lg.format = { signal: timeUnitFormatSignal(def.timeUnit) }
  lg.formatType = 'time'
}

/** vega-lite's `durationExpr`: the duration of one unit as a datetime difference (tickMinStep). */
function timeUnitMinStepSignal(tu: NormalTimeUnit): string | null {
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
  const fmt = (x: typeof d): string => `${tu.utc ? 'utc' : 'datetime'}(${x.year}, ${x.month}, ${x.date}, ${x.hours}, ${x.minutes}, ${x.seconds}, ${x.milliseconds})`
  return `${fmt(end)} - ${fmt(d)}`
}

function measureStackOffset(measure: FieldDef): unknown {
  if (measure.stack === 'wiggle') return 'zero'
  if (measure.stack != null) return isObject(measure.stack) ? (measure.stack.offset ?? 'zero') : measure.stack
  return 'zero'
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

function positionalScaleType(mark: string, def: FieldDef): string {
  if (isDiscreteType(def.type)) {
    // a discrete positional channel only honors the two discrete positional
    // scale types; anything else falls back to the mark's natural type
    // (probed: nominal x + scale type linear/ordinal/threshold → band)
    const natural = mark === 'bar' || mark === 'rect' || mark === 'tick' || mark === 'rule' || mark === 'image' ? 'band' : 'point'
    const user = def.scale?.type as string | undefined
    return user === 'point' || user === 'band' ? user : natural
  }
  if (def.scale?.type) return def.scale.type as string
  if (def.type === 'temporal') return 'time'
  return 'linear'
}

function buildScales(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, width: unknown, height: unknown, series: FieldDef[] = [], rawName: string = dataName): ScaleSpec[] {
  const scales: ScaleSpec[] = []
  const dc: DomainCtx = { rawName, fields, mark, orient, series }
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
        ? unionDomain([def, def2], dataName)
        : positionalDomain(def, dataName, mark, orient, fields, dc),
      range: effRange,
    }
    // config.scale.xReverse flips every x scale (band included);
    // config.scale.continuousPadding sets vega's pixel domain padding.
    if (channel === 'x' && userScaleCfg?.xReverse === true && def.scale?.reverse == null) sc.reverse = true
    if (isContinuousScaleType(type) && userScaleCfg?.continuousPadding != null && def.scale?.padding == null) {
      sc.padding = userScaleCfg.continuousPadding as number
    }
    // a continuous positional scale reverses for sort:descending (a discrete
    // scale carries the order in its domain sort instead)
    if (def.sort === 'descending' && type !== 'band' && type !== 'point' && type !== 'ordinal' && type !== 'bin-ordinal') sc.reverse = true
    const measureChannel = orient === 'vertical' ? 'y' : 'x'
    // rect marks with two discrete channels (heatmaps) use unpadded bands
    const otherChannel = channel === 'x' ? 'y' : 'x'
    const otherDef = fields.find((f) => f.channel === otherChannel)
    const bothDiscrete = mark === 'rect' && otherDef != null && isDiscreteType(otherDef.type)
    // bar/rect marks pad the dimension channel; timeUnit dimensions use the
    // offset-encoded band layout instead and stay unpadded
    if (
      mark === 'bar' && channel !== measureChannel &&
      !def.timeUnit && def.stack == null
      && (cfgMarkType?.discreteBandSize ?? cfgMarkBlock?.discreteBandSize) !== 0
    ) sc.padding = 5
    if (type === 'linear' || type === 'log') {
      const zeroDefault = type === 'log' ? false : zeroDefaultFor(mark, channel, orient)
      if (type === 'linear' || def.scale?.zero != null) {
        sc.zero = (def.scale?.zero as boolean | undefined) ?? zeroDefault
      }
      sc.nice = (def.scale?.nice as unknown) ?? true
      if (def.bin) sc.bins = { signal: binNames(def.binParams!, def.field).signal }
      // binned scales: no zero/nice; domain comes from bin start/end
      // (zero must be explicitly false — a missing key means the engine's
      // linear default kicks in and extends the domain to 0)
      if (def.bin) {
        sc.zero = false
        sc.nice = false
        delete sc.padding
      }
    } else if (type === 'band') {
      const hasOffset = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
      // vl scale/properties.ts: bar → barBandPaddingInner (0.1), tick → 0.25,
      // everything else (rect/rule/image) → rectBandPaddingInner (0); the
      // outer padding defaults to half the inner. An explicit `padding`
      // replaces both inner and outer; an explicit paddingInner carries its
      // half into the default outer.
      const cfgInner = (userScaleCfg?.bandPaddingInner as number | undefined)
        ?? (mark === 'bar' ? userScaleCfg?.barBandPaddingInner as number | undefined : undefined)
        ?? (mark === 'tick' ? userScaleCfg?.tickBandPaddingInner as number | undefined : undefined)
        ?? (mark === 'rect' ? userScaleCfg?.rectBandPaddingInner as number | undefined : undefined)
      const defaultInner = cfgInner ?? (mark === 'tick' ? 0.25 : hasOffset ? 0.2 : mark === 'bar' ? C.barPaddingInner : 0)
      const defaultOuter = (userScaleCfg?.bandPaddingOuter as number | undefined)
        ?? (cfgInner != null ? cfgInner / 2 : (mark === 'tick' ? 0.125 : hasOffset ? 0.2 : mark === 'bar' ? C.barPaddingInner / 2 : 0))
      const userPadding = def.scale?.padding as number | undefined
      if (userPadding != null) {
        sc.padding = userPadding
      } else {
        const userInner = def.scale?.paddingInner as number | undefined
        sc.paddingInner = userInner ?? defaultInner
        sc.paddingOuter = (def.scale?.paddingOuter as number | undefined) ?? (userInner != null ? userInner / 2 : defaultOuter)
      }
    } else if (type === 'point') {
      sc.padding = (def.scale?.padding as number | undefined) ?? C.pointPadding
    }
    if (def.scale) {
      const discretePos = type === 'band' || type === 'point' || type === 'ordinal' || type === 'bin-ordinal'
      for (const [k, v] of Object.entries(def.scale)) {
        if (k === 'type' || k === 'zero' || k === 'nice' || k === 'padding' || k === 'paddingInner') continue
        // vega-lite folds rangeMin / rangeMax into the range array (below); they are not Vega scale properties
        if (k === 'rangeMin' || k === 'rangeMax') continue
        // discrete positional scales ignore continuous domain adjustments
        if (discretePos && (k === 'domain' || k === 'domainMin' || k === 'domainMax' || k === 'domainMid')) continue
        // ... and a colour scheme or bins do not apply to a band/point scale (vega-lite drops them with a warning)
        if (discretePos && (k === 'scheme' || k === 'bins')) continue
        sc[k] = v
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
    recordExplicit(sc, def.scale)
    scales.push(sc)
  }

  // size scale
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef) {
    if (isDiscreteType(sizeDef.type)) {
      scales.push({
        name: 'size',
        type: 'point',
        domain: sortedDomain(sizeDef, dataName, dc),
        range: [4, 361],
        ...(sizeDef.sort === 'descending' ? { reverse: true } : {}),
      })
    } else {
      const sc: ScaleSpec = {
        name: 'size',
        type: 'linear',
        domain: sizeDef.scale?.domain ?? { data: dataName, field: aggFieldName(sizeDef) },
        // line marks map size onto stroke width [1,4]; symbol marks onto area
        range: sizeDef.scale?.range ?? (mark === 'line' ? [1, 4] : [4, 361]),
        reverse: sizeDef.sort === 'descending' ? true : undefined,
        zero: true,
      }
      if (sizeDef.scale) {
        for (const [k, v] of Object.entries(sizeDef.scale)) {
          if (k === 'type' || k === 'domain' || k === 'range') continue
          sc[k] = v
        }
      }
      scales.push(sc)
    }
  }
  // strokeWidth scale
  const strokeWidthDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  if (strokeWidthDef) {
    scales.push({
      name: 'strokeWidth',
      type: 'linear',
      domain: strokeWidthDef.scale?.domain ?? { data: dataName, field: aggFieldName(strokeWidthDef) },
      range: strokeWidthDef.scale?.range ?? [1, 4],
      reverse: strokeWidthDef.sort === 'descending' ? true : undefined,
      zero: false,
    })
  }
  // opacity scale
  const opacityDefS = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityDefS) {
    scales.push({
      name: 'opacity',
      type: 'linear',
      domain: Array.isArray(opacityDefS.scale?.domain) ? opacityDefS.scale!.domain : { data: dataName, field: aggFieldName(opacityDefS) },
      range: [0.3, 0.8],
      zero: false,
      ...(opacityDefS.sort === 'descending' ? { reverse: true } : {}),
    })
  }
  // xOffset/yOffset scales: discrete offsets use a band, continuous ones a
  // linear scale over the same band-width range (vega-lite probes).
  for (const ch of ['xOffset', 'yOffset'] as const) {
    const offDef = fields.find((f) => f.channel === ch && f.field)
    if (offDef) {
      const dimChannel = ch === 'xOffset' ? 'x' : 'y'
      if (isDiscreteType(offDef.type)) {
        scales.push({
          name: ch,
          type: 'band',
          domain: sortedDomain(offDef, dataName, dc),
          range: [0, { signal: `bandwidth('${dimChannel}')` }],
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

  // shape scale
  const shapeDefS = fields.find((f) => f.channel === 'shape' && f.field)
  if (shapeDefS) {
    scales.push({
      name: 'shape',
      type: 'ordinal',
      domain: sortedDomain(shapeDefS, dataName, dc),
      range: 'symbol',
    })
  }

  // theta scale (arc marks): the stacked start/end fields span [0, 2pi]
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  const arcThetaS = thetaStackInfo(mark, fields)
  if ((mark === 'arc' || mark === 'text') && thetaDef) {
    scales.push({
      name: 'theta',
      type: 'linear',
      // stacked arcs span the start/end fields; plain text layers and
      // unstacked arcs read the field directly
      domain: mark === 'arc' && arcThetaS?.stacked
        ? { data: dataName, fields: [`${arcThetaS.field}_start`, `${arcThetaS.field}_end`] }
        : { data: dataName, field: arcThetaS?.field ?? thetaDef.field },
      range: [0, 6.283185307179586],
      // the theta def's sort reverses the angular scale
      reverse: thetaDef.sort === 'descending' ? true : undefined,
      zero: true,
    })
  }
  // radius scale (arc marks): drives outerRadius/innerRadius
  const radiusDef = fields.find((f) => f.channel === 'radius' && f.field)
  if (mark === 'arc' && radiusDef) {
    const stackedR = radiusDef.stack != null && radiusDef.stack !== false
    scales.push({
      name: 'radius',
      type: 'linear',
      domain: stackedR
        ? { data: dataName, fields: [`${aggFieldName(radiusDef)}_start`, `${aggFieldName(radiusDef)}_end`] }
        : { data: dataName, field: aggFieldName(radiusDef) },
      range: [0, { signal: 'min(width,height)/2' }],
      reverse: radiusDef.sort === 'descending' ? true : undefined,
      zero: true,
    })
  }

  // color scale
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const numericAggregate = colorDef?.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)
  if (colorDef) {
    if (isDiscreteType(colorDef.type) && !numericAggregate) {
      scales.push({
        name: 'color',
        type: 'ordinal',
        domain: sortedDomain(colorDef, dataName, dc),
        range: (colorDef.scale?.range as unknown) ?? (colorDef.scale?.scheme != null ? schemeRange(colorDef.scale.scheme) : 'category'),
      })
    } else {
      const cs = colorDef.scale ?? {}
      const colorScaleType = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold'].includes(cs.type as string)
        ? cs.type as string
        : 'linear'
      scales.push({
        name: 'color',
        type: colorScaleType,
        domain: Array.isArray(cs.domain) ? cs.domain : { data: dataName, field: aggFieldName(colorDef) },
        // vega-lite's quantitative color range: 'heatmap' scheme for
        // rect/geoshape marks, a ramp otherwise; a domainMid makes it
        // diverging; an explicit scheme replaces the range (probed)
        ...(cs.range != null
          ? { range: cs.range }
          : cs.scheme != null
            ? { range: schemeRange(cs.scheme) }
            : { range: cs.domainMid != null ? 'diverging' : mark === 'rect' || mark === 'geoshape' ? 'heatmap' : 'ramp' }),
        // vega-lite sets the colorspace for continuous color scales (probed:
        // interpolate hcl on ramp/scheme/diverging alike)
        interpolate: 'hcl',
        ...(cs.reverse !== undefined
          ? { reverse: Boolean(cs.reverse) }
          : colorDef.sort === 'descending' ? { reverse: true } : {}),
        ...(cs.domainMin !== undefined ? { domainMin: cs.domainMin } : {}),
        ...(cs.domainMax !== undefined ? { domainMax: cs.domainMax } : {}),
        ...(cs.domainMid !== undefined ? { domainMid: cs.domainMid } : {}),
        ...(cs.bins !== undefined ? { bins: cs.bins } : {}),
        ...(colorScaleType === 'quantile' || colorScaleType === 'threshold'
          ? {}
          : { zero: (cs.zero as boolean | undefined) ?? false }),
      })
    }
  }

  void width
  void height
  // the user's scale properties on the non-positional channels count as explicit too
  for (const f of fields) {
    if (!f.scale || f.channel === 'x' || f.channel === 'y') continue
    const sc = scales.find((x) => x.name === f.channel)
    if (sc && !EXPLICIT_SCALE_PROPS.has(sc)) recordExplicit(sc, f.scale)
  }
  return scales
}

/** A scale `scheme` (a name or {name, extent, count}) as a Vega range scheme object. */
function schemeRange(scheme: unknown): Record<string, unknown> {
  if (isObject(scheme)) {
    const { name, ...rest } = scheme
    return { scheme: name, ...rest }
  }
  return { scheme }
}

/** A domain over the values of several defs: one data reference each, or a literal list for a datum. */
function unionDomain(defs: FieldDef[], dataName: string): unknown {
  const entries = defs.map((d) => (d.datumOnly ? [d.datum] : { data: dataName, field: aggFieldName(d) }))
  if (entries.every((e) => !Array.isArray(e))) return { data: dataName, fields: (entries as Array<{ field: string }>).map((e) => e.field) }
  return { fields: entries }
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
  if (def.datumOnly) return [def.datum]
  if (def.bin) {
    const sig = binNames(def.binParams!, def.field).signal
    return { signal: `[${sig}.start, ${sig}.stop]` }
  }
  if (def.timeUnit && (mark === 'bar' || mark === 'rect') && !isDiscreteType(def.type)) {
    return { data: dataName, fields: [timeUnitField(def), `${timeUnitField(def)}_end`] }
  }
  // a stack property on a discrete channel is inert (vega-lite ignores it)
  if (def.stack === 'normalize' && def.type === 'quantitative' && !def.bin) return [0, 1]
  if (isDiscreteType(def.type)) return sortedDomain(def, dataName, dc)
  const measureChannel = (mark === 'bar' || mark === 'area')
    ? (potentialStackChannel(mark, orient, fields ?? []) ?? (orient === 'vertical' ? 'y' : 'x'))
    : orient === 'vertical' ? 'y' : 'x'
  const stacked = isStacked(def, mark, orient, fields)
  if (def.channel === measureChannel && stacked) {
    return { data: dataName, fields: [`${def.field}_start`, `${def.field}_end`] }
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
  if (def.type !== 'quantitative' || def.aggregate || def.bin) return false
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
      (f) => f.field && !positional.has(f.channel) && !f.aggregate && !groupFields.has(f.field),
    )
    if (allFields.some((f) => f.aggregate) && stackBy.length === 0) return false
    if (allFields.some((f) => (f.channel === 'x2' || f.channel === 'y2') && f.field)) return false
  }
  return true
}

/** What a discrete scale domain needs to resolve a sort definition. */
interface DomainCtx {
  /** the raw (pre-aggregate) dataset sort-by-field/array domains read */
  rawName: string
  fields: FieldDef[]
  mark: string
  orient: string
  series: FieldDef[]
}

/**
 * vega-lite `domainSort` for a discrete scale: the field's domain read from the
 * main table (ascending/descending) or from the RAW table sorted by an
 * aggregate of another field (sort by field/encoding) or by the sort-array
 * index. `sort: null` leaves the domain in data order.
 */
function sortedDomain(def: FieldDef, dataName: string, dc: DomainCtx): unknown {
  if (def.datumOnly) return [def.datum]
  const explicit = def.scale?.domain
  if (Array.isArray(explicit)) return explicit
  const field = aggFieldName(def)
  const main = { data: dataName, field }
  const sort = def.sort
  if (sort === null) return main
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
function defaultLabelBaseline(angle: number, orient: string, channel: string): string | null {
  if (channel === 'x') {
    if ((45 < angle && angle < 135) || (225 < angle && angle < 315)) return 'middle'
    return (angle <= 45 || 315 <= angle) === (orient === 'top') ? 'bottom' : 'top'
  }
  if (angle <= 45 || 315 <= angle || (135 <= angle && angle <= 225)) return null
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

// --- axes --------------------------------------------------------------------

function buildAxes(fields: FieldDef[], mark: string, orient: string, scales: ScaleSpec[], scaleName?: string, gridScaleOverride?: string, config?: Record<string, unknown>): Record<string, unknown>[] {
  // Vega-lite emits every grid axis before every label axis (paint order:
  // grids under the domain/labels). Emitting per-channel [grid, label] leaves a
  // later channel's grid line above an earlier channel's domain line.
  const gridAxes: Record<string, unknown>[] = []
  const labelAxes: Record<string, unknown>[] = []
  const scaleByName = new Map(scales.map((s) => [s.name, s]))

  for (const def of fields) {
    if (!POSITIONAL.has(def.channel) || (def.channel !== 'x' && def.channel !== 'y')) continue
    if (def.axis === null) continue
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
        ...(suppressTickCount ? {} : { tickCount: tickCountSignal }),
        domain: false,
        labels: false,
        aria: false,
        maxExtent: 0,
        minExtent: 0,
        ticks: false,
        // vega-lite: getFirstDefined(axis.zindex, 0) — grid behind marks
        zindex: typeof userAxis.zindex === 'number' ? userAxis.zindex : 0,
      }
      if (def.tu) {
        const stepExpr = timeUnitMinStepSignal(def.tu)
        if (stepExpr) gridAxis.tickMinStep = { signal: stepExpr }
      }
      // the user's grid-affecting props land on the grid axis too (upstream
      // merges grid+labels into one axis; ours splits them)
      if (userAxis) {
        for (const gk of ['gridColor', 'gridWidth', 'gridDash', 'gridOpacity', 'gridCap', 'tickOffset', 'translate', 'tickBand', 'tickExtra', 'tickCount', 'tickMinStep', 'tickRound', 'values'] as const) {
          if ((userAxis as Record<string, unknown>)[gk] !== undefined) gridAxis[gk] = (userAxis as Record<string, unknown>)[gk]
        }
      }
      gridAxes.push(gridAxis)
    }

    const title = configTitleSupplied ? null : axisTitle(def, userAxis, fields)
    const labelAxis: Record<string, unknown> = {
      scale: scaleName ?? def.channel,
      orient: orientSide,
      grid: false,
      // vega-lite defaultZindex(): a rect mark over a discrete field puts its
      // axis above the marks (zindex 1); otherwise 0. An explicit zindex wins.
      zindex: typeof userAxis.zindex === 'number'
        ? userAxis.zindex
        : mark === 'rect' && (def.type === 'nominal' || def.type === 'ordinal' || (def.type === 'quantitative' && !!def.bin)) ? 1 : 0,
    }
    if (title !== null) labelAxis.title = title
    if (isContinuousScaleType(sc.type)) {
      if (def.channel === 'x') labelAxis.labelFlush = true
      labelAxis.labelOverlap = sc.type === 'log' ? 'greedy' : true
      // log axes carry no explicit tickCount — vega's axis defaults to 10,
      // which drives the log label filter (3/30/300 stay visible)
      if (sc.type !== 'log' && !suppressTickCount) labelAxis.tickCount = def.bin
        ? { signal: def.channel === 'x' ? 'ceil(width/10)' : 'ceil(height/10)' }
        : tickCountSignal
      if (def.timeUnit) {
        labelAxis.format = { signal: timeUnitFormatSignal(def.timeUnit) }
        labelAxis.formatType = 'time'
        // the minimum tick step is one unit: expressed as a datetime difference
        const stepExpr = def.tu ? timeUnitMinStepSignal(def.tu) : null
        if (stepExpr) labelAxis.tickMinStep = { signal: stepExpr }
      } else if (def.stack === 'normalize') {
        labelAxis.format = '.0%'
      }
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
      if (angle !== undefined) {
        labelAxis.labelAngle = angle
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
          const align = defaultLabelAlign(angle, labelOrient, def.channel)
          if (align != null) labelAxis.labelAlign = align
        }
        if (ua?.labelBaseline === undefined) {
          const baseline = defaultLabelBaseline(angle, labelOrient, def.channel)
          if (baseline != null) labelAxis.labelBaseline = baseline
        }
      }
    }
    // vega-lite formats any stack-normalized positional axis as a percentage,
    // even when the scale is discrete (a nominal y stack still gets `.0%`;
    // the labels then read NaN%).
    if (def.stack === 'normalize' && labelAxis.format === undefined) labelAxis.format = '.0%'
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

function buildLegends(fields: FieldDef[], mark: string, markOpacity?: number, markFilled?: boolean, markStroke?: string, markStrokeWidth?: number, markFillOpacity?: number, cfgLegendIn?: Record<string, unknown>, markStrokeDash?: number[]): Record<string, unknown>[] {
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
  const cfgHorizontal = cfgLegend.orient === 'top' || cfgLegend.orient === 'bottom'
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
  const push = (key: string, lg: Record<string, unknown>): void => {
    legendsByKey[key] = lg
    order.push(key)
  }
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  if (colorDef && colorDef.legend !== null && !legendSuppressed(colorDef)) {
    const userLegend = { ...cfgDefaults, ...(colorDef.legend ?? {}) }
    const lg: Record<string, unknown> = { title: legendTitle(colorDef, userLegend) }
    const filled = mark === 'circle' || mark === 'square'
      || (mark === 'point' && markFilled === true)
      || (mark === 'arc' && markFilled !== false)
    // only a cyclic (discrete) time unit switches the color legend from a
    // gradient to symbols; year/week/hours/... stay continuous (probed:
    // quantitative color with month/day/quarter → symbol, every other unit →
    // gradient).
    const colorTimeUnitSymbol = colorDef.timeUnit != null
      && ['month', 'day', 'quarter'].includes(String(colorDef.timeUnit))
    const colorDiscreteScale = ['quantile', 'quantize', 'threshold'].includes(colorDef.scale?.type as string)
    const colorContinuous = (!isDiscreteType(colorDef.type)
      || (colorDef.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)))
      && !colorTimeUnitSymbol && !colorDiscreteScale
    // legend.type:'symbol' forces a symbol legend even on a continuous scale
    const colorGradient = colorContinuous && userLegend.type !== 'symbol'
    if (colorTimeUnitSymbol) lg.type = 'symbol'
    if (colorDef.scale?.type === 'quantile' || colorDef.scale?.type === 'threshold') lg.labelOverlap = 'greedy'
    const m = mark as string
    if (filled) {
      lg.fill = 'color'
      lg.symbolType = m === 'bar' || m === 'rect' ? 'square' : 'circle'
      if (m === 'arc') {
        // arc legends carry the mark's stroke/opacity/width but no reduced-opacity
        // default (unlike point/circle/square)
        const symUpdate: Record<string, unknown> = {}
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markStrokeWidth != null) symUpdate.strokeWidth = { value: markStrokeWidth }
        if (markStrokeDash != null) symUpdate.strokeDash = { value: markStrokeDash }
        if (markFillOpacity != null) symUpdate.fillOpacity = { value: markFillOpacity }
        if (markOpacity != null) symUpdate.opacity = { value: markOpacity }
        if (Object.keys(symUpdate).length) lg.encode = { symbols: { update: symUpdate } }
      } else if (m !== 'bar' && m !== 'rect') {
        const symUpdate: Record<string, unknown> = { opacity: { value: markOpacity ?? reducedOpacity ?? 1 } }
        // the mark's stroke/fill-opacity propagates onto the legend symbols
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markFillOpacity != null) symUpdate.fillOpacity = { value: markFillOpacity }
        lg.encode = { symbols: { update: symUpdate } }
      }
    } else if (m === 'arc') {
      // an unfilled arc paints by stroke: the legend is a stroke legend
      lg.stroke = 'color'
      if (!colorGradient) lg.symbolType = 'circle'
      else lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
    } else if (m === 'point' || m === 'line' || m === 'text') {
      lg.stroke = 'color'
      if (!colorGradient) {
        lg.symbolType = mark === 'line' ? 'stroke' : 'circle'
        // vega-lite adds no symbol overrides for a line's stroke legend
        // (verified against the real-vega render: extra fill/opacity here
        // changes the legend glyph); point/text legends get the unfilled,
        // reduced-opacity symbol.
        if (mark !== 'line') lg.encode = { symbols: { update: { fill: { value: 'transparent' }, opacity: { value: reducedOpacity ?? 1 } } } }
      } else {
        lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
        lg.encode = { gradient: { update: { opacity: { value: reducedOpacity ?? 1 } } } }
      }
    } else {
      lg.fill = 'color'
      if (mark === 'bar' || mark === 'rect') lg.symbolType = 'square'
      if (colorGradient) {
        lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
        if (markOpacity != null) lg.encode = { gradient: { update: { opacity: { value: markOpacity } } } }
      } else {
        // the mark's stroke/opacity propagate onto a symbol legend's entries
        // (probed: bar/rect/arc with markDef.stroke emit symbols.stroke)
        const symUpdate: Record<string, unknown> = {}
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markOpacity != null) symUpdate.opacity = { value: markOpacity }
        if (Object.keys(symUpdate).length) lg.encode = { symbols: { update: symUpdate } }
      }
    }
    applyTimeUnitLegend(lg, colorDef, userLegend)
    for (const [k, v] of Object.entries(userLegend)) {
      if (k === 'title') continue
      if (k === 'type' && v === 'gradient') continue
      lg[k] = v
    }
    // top/bottom gradients measure along the chart width
    if ((lg.orient === 'top' || lg.orient === 'bottom' || lg.direction === 'horizontal')
      && userLegend.gradientLength == null && !('gradientLength' in userLegend)) {
      lg.gradientLength = { signal: 'clamp(width, 100, 200)' }
    }
    // strip the VL-only keys and the other type's keys (upstream parity): a
    // gradient legend drops symbol*, a symbol legend drops gradient*
    const isGradient = 'gradientLength' in lg
    for (const k of Object.keys(lg)) {
      if (k === 'title' || k === 'encode' || k === 'fill' || k === 'stroke' || k === 'shape' || k === 'size' || k === 'opacity') continue
      if (isGradient ? (k.startsWith('symbol') || k === 'gradientStroke') : k.startsWith('gradient')) delete lg[k]
    }
    // top/bottom legends lay their entries out horizontally; a corner-oriented
    // gradient is horizontal with vega-lite's fixed 100px length, and an
    // explicit direction:horizontal on any other orient also uses 100px.
    if (userLegend.direction === 'horizontal' && lg.orient !== 'top' && lg.orient !== 'bottom'
      && !(typeof lg.orient === 'string' && /^(top|bottom)-(left|right)$/.test(lg.orient))
      && userLegend.gradientLength == null && 'gradientLength' in lg) {
      lg.gradientLength = 100
    }
    if (lg.orient === 'bottom' || lg.orient === 'top') lg.direction = lg.direction ?? 'horizontal'
    if (typeof lg.orient === 'string' && /^(top|bottom)-(left|right)$/.test(lg.orient) && 'gradientLength' in lg) {
      lg.direction = lg.direction ?? 'horizontal'
      if (userLegend.gradientLength == null) lg.gradientLength = 100
    }
    if (lg.direction == null) {
      if (cfgLegend.gradientDirection === 'horizontal') {
        lg.direction = 'horizontal'
        if (isGradient && userLegend.gradientLength == null && 'gradientLength' in lg) lg.gradientLength = 100
      } else if (cfgLegend.symbolDirection === 'horizontal') {
        lg.direction = 'horizontal'
      } else if (cfgHorizontal) {
        lg.direction = 'horizontal'
      }
    }
    push('color', lg)
  }
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef && sizeDef.legend !== null && !legendSuppressed(sizeDef)) {
    // vega-lite gives a standalone size legend the default symbol stroke
    // (#4c78a8) but drops it when a color legend coexists.
    const sizeUser = { ...cfgDefaults, ...(sizeDef.legend ?? {}) }
    if (sizeUser.type === 'gradient') {
      const glg: Record<string, unknown> = {
        size: 'size',
        type: 'gradient',
        gradientLength: sizeUser.gradientLength ?? { signal: 'clamp(height, 64, 200)' },
        title: legendTitle(sizeDef, sizeUser),
        encode: { gradient: { update: { opacity: { value: markOpacity ?? reducedOpacity ?? 1 } } } },
      }
      applyTimeUnitLegend(glg, sizeDef, sizeUser)
      forwardLegendProps(sizeUser, glg, true)
      push('size', glg)
    } else {
    const sizeSymbolOpacity = sizeUser.symbolOpacity as number | undefined
    const sizeSymUpdate: Record<string, unknown> = { fill: { value: 'transparent' } }
    if (sizeSymbolOpacity == null) sizeSymUpdate.opacity = { value: markOpacity ?? reducedOpacity ?? 1 }
    if (!colorDef || colorDef.legend === null || legendSuppressed(colorDef)) sizeSymUpdate.stroke = { value: C.blue }
    const sizeLg: Record<string, unknown> = {
      size: 'size',
      symbolType: 'circle',
      title: legendTitle(sizeDef, sizeUser),
      encode: { symbols: { update: sizeSymUpdate } },
    }
    applyTimeUnitLegend(sizeLg, sizeDef, sizeUser)
    forwardLegendProps(sizeUser, sizeLg, false)
    if (sizeLg.direction == null && (cfgHorizontal || cfgLegend.symbolDirection === 'horizontal')) sizeLg.direction = 'horizontal'
    push('size', sizeLg)
    }
  }
  const shapeDefL = fields.find((f) => f.channel === 'shape' && f.field)
  if (shapeDefL && shapeDefL.legend !== null && !legendSuppressed(shapeDefL)) {
    const shapeUser = { ...cfgDefaults, ...(shapeDefL.legend ?? {}) }
    const shapeLg: Record<string, unknown> = {
      shape: 'shape',
      symbolType: 'circle',
      title: legendTitle(shapeDefL, shapeUser),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue }, opacity: { value: markOpacity ?? reducedOpacity ?? 1 } } } },
    }
    applyTimeUnitLegend(shapeLg, shapeDefL, shapeUser)
    forwardLegendProps(shapeUser, shapeLg, false)
    if (shapeLg.direction == null && (cfgHorizontal || cfgLegend.symbolDirection === 'horizontal')) shapeLg.direction = 'horizontal'
    push('shape', shapeLg)
  }
  const strokeWidthLegendDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  if (strokeWidthLegendDef && strokeWidthLegendDef.legend !== null && !legendSuppressed(strokeWidthLegendDef)) {
    const swUser = { ...cfgDefaults, ...(strokeWidthLegendDef.legend ?? {}) }
    // the symbol follows the mark: a line's is a stroke sample, a filled
    // point keeps the default fill, an unfilled point a transparent one.
    const swUpdate: Record<string, unknown> =
      mark === 'line'
        ? { stroke: { value: markStroke ?? C.blue } }
        : mark === 'bar'
          ? { fill: { value: C.blue } }
          : mark === 'point'
            ? { fill: { value: 'transparent' }, stroke: { value: markStroke ?? C.blue }, opacity: { value: markOpacity ?? reducedOpacity ?? 1 } }
            : { fill: { value: C.blue }, stroke: { value: markStroke ?? C.blue }, opacity: { value: markOpacity ?? reducedOpacity ?? 1 } }
    const swLg: Record<string, unknown> = {
      strokeWidth: 'strokeWidth',
      symbolType: mark === 'line' ? 'stroke' : mark === 'bar' || mark === 'square' ? 'square' : 'circle',
      title: legendTitle(strokeWidthLegendDef, swUser),
      encode: { symbols: { update: swUpdate } },
    }
    applyTimeUnitLegend(swLg, strokeWidthLegendDef, swUser)
    forwardLegendProps(swUser, swLg, false)
    if (swLg.direction == null && (cfgHorizontal || cfgLegend.symbolDirection === 'horizontal')) swLg.direction = 'horizontal'
    push('strokeWidth', swLg)
  }
  const opacityLegendDef = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityLegendDef && opacityLegendDef.legend !== null && !legendSuppressed(opacityLegendDef)) {
    const opUser = { ...cfgDefaults, ...(opacityLegendDef.legend ?? {}) }
    const opLg: Record<string, unknown> = {
      opacity: 'opacity',
      symbolType: 'circle',
      title: legendTitle(opacityLegendDef, opUser),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue } } } },
    }
    applyTimeUnitLegend(opLg, opacityLegendDef, opUser)
    forwardLegendProps(opUser, opLg, false)
    if (opLg.direction == null && (cfgHorizontal || cfgLegend.symbolDirection === 'horizontal')) opLg.direction = 'horizontal'
    push('opacity', opLg)
  }
  for (const key of order) legends.push(legendsByKey[key]!)
  return legends
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

interface BuiltMarks extends Array<Record<string, unknown>> {
  overlayData?: Record<string, unknown>
  overlayFilled?: boolean
}
function buildMarks(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, markSize: number | undefined, overlayName: string): BuiltMarks {  // vega-lite's DEFAULT_REDUCED_OPACITY (0.7) applies to point/tick/circle/
  // square only when the encoding is NOT aggregate (init.ts opacity())
  const isAggregateEnc = fields.some((f) => f.aggregate)
  const hasFillOpacity = isObject(spec.mark) && (spec.mark as Record<string, unknown>).fillOpacity !== undefined
  let pointOpacityDefault = isAggregateEnc || hasFillOpacity ? undefined : C.pointOpacity

  const markColor = isObject(spec.mark) ? (spec.mark.color as string | undefined) : undefined
  const markFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
  let markOpacity = isObject(spec.mark) ? (spec.mark.opacity as number | undefined) : undefined
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  const shapeDef = fields.find((f) => f.channel === 'shape' && f.field)
  const opacityDef = fields.find((f) => f.channel === 'opacity' && f.field)
  const strokeWidthDef = fields.find((f) => f.channel === 'strokeWidth' && f.field)
  const update: Record<string, unknown> = {}
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
    const cfgPaint = (p: string): unknown => markDef?.[p] ?? cfgType?.[p] ?? cfgMark?.[p]
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
    if (mark === 'bar' && ((cornerRadius != null && cornerRadius !== 0) || (cornerRadiusEnd != null && cornerRadiusEnd !== 0))) {
      update.clip = { value: true }
    }
    if (cornerRadius != null && update.cornerRadius === undefined) update.cornerRadius = { value: cornerRadius }
    if (cornerRadiusEnd != null && mark === 'bar') {
      const [a, b] = orient === 'horizontal' ? ['TopRight', 'BottomRight'] : ['TopLeft', 'TopRight']
      update[`cornerRadius${a}`] = { value: cornerRadiusEnd }
      update[`cornerRadius${b}`] = { value: cornerRadiusEnd }
    }
    if (mark === 'bar') update.ariaRoleDescription = { value: 'bar' }
    const stacked = yDef && isStacked(yDef, mark, orient, fields)
    if (orient === 'vertical') {
      if (xDef) {
        const sc = positionalScaleType(mark, xDef)
        if (mark === 'rect' && xDef.timeUnit == null && !xDef.bin && sc !== 'band') {
          // a continuous rect spans to the scale's zero/min (vega-lite rangePosition)
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.x2 = zeroOrMinRef('x', xDef, mark)
        } else if (xDef.timeUnit == null && !xDef.bin && xDef.type === 'temporal') {
          // a plain temporal dimension centers the bar with the continuous
          // band size (vega-lite's continuousBandSize)
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
        } else if (xDef.timeUnit && sc !== 'band') {
          const endF = JSON.stringify(timeUnitField(xDef) + '_end')
          const startF = JSON.stringify(timeUnitField(xDef))
          const scName = 'x'
          const off = (sign: string) =>
            `0.5 + (abs(scale("${scName}", datum[${endF}]) - scale("${scName}", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("${scName}", datum[${endF}]) - scale("${scName}", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.x = { scale: 'x', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.x2 = { scale: 'x', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (xDef.bin) {
          const bn = binNames(xDef.binParams!, xDef.field)
          const endF = JSON.stringify(bn.end)
          const startF = JSON.stringify(bn.start)
          const off = (sign: string) =>
            `0.5 + (abs(scale("x", datum[${endF}]) - scale("x", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("x", datum[${endF}]) - scale("x", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.x = { scale: 'x', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.x2 = { scale: 'x', field: JSON.parse(startF), offset: { signal: off('-') } }
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
          if (barAlign === 'right' && !xOffsetPresent) {
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
            update.width = { value: sc === 'point' ? C.defaultStep : C.bandSize }
          }
        }
      }
      const y2DefB = fields.find((f) => f.channel === 'y2' && f.field)
      if (yDef) {
        if (y2DefB) {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.y2 = { scale: 'y', field: y2DefB.field }
        } else if (stacked) {
          update.y = { scale: 'y', field: `${yDef.field}_end` }
          update.y2 = { scale: 'y', field: `${yDef.field}_start` }
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
        } else {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          if (mark === 'bar') update.y2 = { scale: 'y', value: 0 }
          else if (mark === 'rect') update.y2 = zeroOrMinRef('y', yDef, mark)
        }
      }
    } else {
      if (yDef) {
        const sc = positionalScaleType(mark, yDef)
        if (mark === 'rect' && yDef.timeUnit == null && !yDef.bin && sc !== 'band') {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.y2 = zeroOrMinRef('y', yDef, mark)
        } else if (yDef.timeUnit == null && !yDef.bin && yDef.type === 'temporal') {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
        } else if (yDef.timeUnit && sc !== 'band') {
          const endF = JSON.stringify(timeUnitField(yDef) + '_end')
          const startF = JSON.stringify(timeUnitField(yDef))
          const off = (sign: string) =>
            `0.5 + (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.y = { scale: 'y', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.y2 = { scale: 'y', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (yDef.bin) {
          const bn = binNames(yDef.binParams!, yDef.field)
          const endF = JSON.stringify(bn.end)
          const startF = JSON.stringify(bn.start)
          const off = (sign: string) =>
            `0.5 + (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.y = { scale: 'y', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.y2 = { scale: 'y', field: JSON.parse(startF), offset: { signal: off('-') } }
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
          if (hSize != null && !yOffsetPresent) {
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
            update.height = { value: sc === 'point' ? C.defaultStep : C.bandSize }
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
        } else if (stackedX) {
          update.x = { scale: 'x', field: `${xDef.field}_end` }
          update.x2 = { scale: 'x', field: `${xDef.field}_start` }
        } else if (!stackedX && positionalScaleType(mark, xDef) === 'band' && !xOffsetPresent) {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { signal: `max(0.25, bandwidth('x'))` }
        } else {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          if (mark === 'bar') update.x2 = { scale: 'x', value: 0 }
          else if (mark === 'rect') update.x2 = zeroOrMinRef('x', xDef, mark)
        }
      }
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
    if (xDef) update.x = { scale: 'x', field: isStacked(xDef, mark, orient, fields) ? `${xDef.field}_end` : aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: isStacked(yDef, mark, orient, fields) ? `${yDef.field}_end` : aggFieldName(yDef) }
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
    update.defined = definedSignal(xDef, yDef)
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
      update.y = { scale: 'y', field: stacked ? `${yDef.field}_end` : aggFieldName(yDef) }
      if (orient !== 'horizontal') {
        // vertical area: y is the value axis, y2 the baseline
        update.y2 = stacked
          ? { scale: 'y', field: `${yDef.field}_start` }
          : { scale: 'y', value: 0 }
      }
    }
    if (xDef && orient === 'horizontal') {
      // horizontal area: x is the value axis; the baseline runs to the start of
      // the x domain (vega-lite's zeroOrMin rule), and y2 is not emitted.
      const stackedX = isStacked(xDef, mark, orient, fields)
      if (stackedX) {
        update.x = { scale: 'x', field: `${xDef.field}_end` }
        update.x2 = { scale: 'x', field: `${xDef.field}_start` }
      } else {
        update.x2 = { signal: "scale('x', domain('x')[0])" }
      }
    }
    update.defined = definedSignal(xDef, yDef)
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
    // Tick orientation is the opposite of bar/line/area's measure inference
    // (vega-lite mark/init.ts): a quantitative x over a discrete y is a
    // VERTICAL tick (its size axis is y and its thickness axis is x).
    const xIsMeasure = xDef != null && xDef.type === 'quantitative' && !xDef.bin
    const yIsMeasure = yDef != null && yDef.type === 'quantitative' && !yDef.bin
    const tickOrient = ((tickDef?.orient as string | undefined) ?? (cfgType?.orient as string | undefined) ?? (cfgMark?.orient as string | undefined))
      ?? (xIsMeasure && !yIsMeasure ? 'vertical'
        : !xIsMeasure && yIsMeasure ? 'horizontal'
        : xIsMeasure && yIsMeasure ? 'vertical'
        : xDef?.type === 'temporal' && yDef?.type !== 'temporal' ? 'vertical'
        : yDef?.type === 'temporal' && xDef?.type !== 'temporal' ? 'horizontal'
        : 'vertical')
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
      if (sizeRaw !== undefined) {
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
    const ruleOrient = specOrient
      ?? (hasX2Enc && hasY2Enc ? undefined
        : hasY2Enc ? 'vertical'
        : hasX2Enc ? 'horizontal'
        : (xDef != null && yDef == null) ? 'vertical'
        : (yDef != null && xDef == null) ? 'horizontal'
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
    if (x2Def) update.x2 = { scale: 'x', field: x2Def.field }
    if (y2Def) update.y2 = { scale: 'y', field: y2Def.field }
    // pointPosition2OrSize zeroOrMin (scaledZeroOrMinOrMax): with no explicit
    // x2/y2 (and no width/height encode), the rule spans to scale zero —
    // {value: 0} when the domain definitely contains zero, otherwise the
    // inrange(0, domain) probe signal (nominal/band scales, zero:false)
    const zeroOrMin = (ch: 'x' | 'y', quantZero: boolean): unknown =>
      quantZero ? { scale: ch, value: 0 } : { signal: `scale('${ch}', inrange(0, domain('${ch}')) ? 0 : domain('${ch}')[0])` }
    const xBand = xDef != null && positionalScaleType(mark, xDef) === 'band'
    const yBand = yDef != null && positionalScaleType(mark, yDef) === 'band'
    const xQuantZero = !xBand && xDef?.scale?.zero !== false
    const yQuantZero = !yBand && yDef?.scale?.zero !== false
    if (!x2Def && ruleOrient !== 'vertical' && xDef) update.x2 = zeroOrMin('x', xQuantZero)
    if (!y2Def && ruleOrient !== 'horizontal' && yDef) update.y2 = zeroOrMin('y', yQuantZero)
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
    if (thetaDefT) {
      // polar text (pie labels): anchored at the view center, offset by
      // radius along theta
      update.x = { signal: 'width', mult: 0.5 }
      update.y = { signal: 'height', mult: 0.5 }
      update.theta = { scale: 'theta', field: thetaDefT.field }
      const mRadius = isObject(spec.mark) ? (spec.mark.radius as number | undefined) : undefined
      if (mRadius != null) update.radius = { value: mRadius }
    } else {
      if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
      if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    }
    const textDef = fields.find((f) => f.channel === 'text')
    if (textDef?.field) {
      const fieldName = textDef.timeUnit ? timeUnitField(textDef) : (textDef.aggregate ? aggFieldName(textDef) : textDef.field)
      const f = JSON.stringify(fieldName)
      const rawFmt = (textDef.raw as { format?: unknown }).format
      if (textDef.timeUnit) {
        update.text = { signal: `timeFormat(datum[${f}], ${timeUnitFormatSignal(textDef.timeUnit)})` }
      } else if (textDef.aggregate || rawFmt !== undefined) {
        update.text = { signal: `format(datum[${f}], ${JSON.stringify(rawFmt ?? '')})` }
      } else {
        update.text = { signal: `isValid(datum[${f}]) ? datum[${f}] : ""+datum[${f}]` }
      }
    } else if (textDef && (textDef.raw as { value?: unknown }).value !== undefined) {
      update.text = { value: String((textDef.raw as { value?: unknown }).value) }
    }
    update.align = { value: 'center' }
    update.baseline = { value: 'middle' }
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
    for (const p of ['strokeWidth', 'dx', 'dy', 'fillOpacity', 'opacity', 'angle', 'baseline', 'align', 'limit', 'fontStyle', 'lineHeight'] as const) {
      const v = textProp(p)
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
    const thetaF = thetaDefA!.field
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
    const mOuter = isObject(arcMark) ? ((arcMark.outerRadius as number | undefined) ?? (arcMark.radius as number | undefined)) : undefined
    const mInner = (isObject(arcMark) ? (arcMark.innerRadius as number | undefined) : undefined)
      ?? (cfgType?.innerRadius as number | undefined)
      ?? (cfgType?.radius2 as number | undefined)
      ?? (cfgMark?.innerRadius as number | undefined)
    // outerRadius resolves markDef.outerRadius ?? markDef.radius ??
    // config.arc.outerRadius ?? config.arc.radius ?? the half-extent signal
    update.outerRadius = mOuter != null
      ? { value: mOuter }
      : ((cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined)) != null
        ? { value: (cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined) }
        : { signal: 'min(width,height)/2' }
    update.innerRadius = { value: mInner ?? (cfgType?.innerRadius as number | undefined) ?? 0 }
    // stacked arcs close at the series' stacked END angle (startAngle runs
    // from value_end to value_start); unstacked arcs span field → scale zero.
    // A channel bandPosition p aligns the start angle within the stacked
    // band: p=0 pins it to the band start, otherwise a lerp signal; the end
    // angle pins to the band start either way (probed).
    const arcThetaE = thetaStackInfo(mark, fields)
    const thetaBP = thetaDefA?.bandPosition as number | undefined
    if (arcThetaE?.stacked && thetaBP !== undefined) {
      update.startAngle = thetaBP === 0
        ? { scale: 'theta', field: `${arcThetaE.field}_start` }
        : { signal: `scale("theta", ${thetaBP} * datum["${arcThetaE.field}_start"] + ${1 - thetaBP} * datum["${arcThetaE.field}_end"])` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_start` }
    } else if (arcThetaE?.stacked) {
      update.startAngle = { scale: 'theta', field: `${arcThetaE.field}_end` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_start` }
    } else if (arcThetaE?.offsettedRect) {
      update.startAngle = { scale: 'theta', field: `${arcThetaE.field}_offsetted_rect_end` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_offsetted_rect_start` }
    } else if (arcThetaE) {
      update.startAngle = { scale: 'theta', field: arcThetaE.field }
      update.endAngle = { scale: 'theta', value: 0 }
    }
    // a radius channel drives the radii through its scale (replacing the
    // mark/config/extent defaults)
    const radiusDefE = fields.find((f) => f.channel === 'radius' && f.field)
    if (radiusDefE) {
      if (radiusDefE.stack != null && radiusDefE.stack !== false) {
        update.innerRadius = { scale: 'radius', field: `${aggFieldName(radiusDefE)}_start` }
        update.outerRadius = { scale: 'radius', field: `${aggFieldName(radiusDefE)}_end` }
      } else {
        update.outerRadius = { scale: 'radius', field: aggFieldName(radiusDefE) }
        update.innerRadius = { scale: 'radius', value: 0 }
      }
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
    update.defined = definedSignal(xDef, yDef)
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
      if (isObject(d) && d.value !== undefined && d.field === undefined && d.datum === undefined) update[ch] = { value: d.value }
    }
  }
  fillMissingPositions(update, mark, fields)

  // interval selections: the static brush marks (empty initial extent).
  // The interactive signal apparatus is interactive-only; the static render
  // shows the zero-size brush background clipped to the plot.
  const intervalParams = Array.isArray(spec.params)
    ? (spec.params as Record<string, unknown>[]).filter((p) => isObject(p.select) && (p.select as Record<string, unknown>).type === 'interval')
    : []
  void intervalParams

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
    'cornerRadiusBottomLeft', 'cornerRadiusBottomRight', 'padAngle',
  ]) {
    const v = passProp(p)
    if (v !== undefined && update[p] === undefined) update[p] = { value: v }
  }
  if (mark === 'bar' && update.clip === undefined) {
    const corners = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomLeft', 'cornerRadiusBottomRight']
    if (corners.some((k) => {
      const v = update[k]
      return v != null && typeof v === 'object' && 'value' in v && typeof (v as { value: unknown }).value === 'number' && (v as { value: number }).value !== 0
    })) update.clip = { value: true }
  }
  // markDef.xOffset/yOffset shift the corresponding positional channels
  // (including their secondary endpoint and centered forms) — probed.
  const xOff = markDefP?.xOffset as number | undefined
  const yOff = markDefP?.yOffset as number | undefined
  const withOffset = (ch: string, off: number): void => {
    const enc = update[ch] as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = off
  }
  if (xOff !== undefined) for (const ch of ['x', 'x2', 'xc']) withOffset(ch, xOff)
  // a rule's baseline endpoint stays at zero; only its value endpoint shifts
  if (yOff !== undefined) for (const ch of mark === 'rule' ? ['y', 'yc'] : ['y', 'y2', 'yc']) withOffset(ch, yOff)
  // arc polar offsets apply to the angles/radius channels
  const thetaOff = markDefP?.thetaOffset as number | undefined
  if (thetaOff !== undefined) {
    for (const ch of ['startAngle', 'endAngle']) {
      const enc = update[ch] as Record<string, unknown> | undefined
      if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = thetaOff
    }
  }
  const radiusOff = markDefP?.radiusOffset as number | undefined
  if (radiusOff !== undefined) {
    const enc = update.outerRadius as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = radiusOff
    const enc2 = update.innerRadius as Record<string, unknown> | undefined
    if (enc2 && typeof enc2 === 'object' && enc2.offset === undefined && typeof enc2.value === 'number' && enc2.value > 0) enc2.offset = radiusOff
  }

  const markSpec: Record<string, unknown> = {
    name: 'marks',
    type: mark === 'bar' || mark === 'tick' ? 'rect' : mark === 'point' || mark === 'circle' || mark === 'square' ? 'symbol' : mark,
    style: [mark],
    from: { data: dataName },
    encode: { update },
  }
  // order: an explicit order channel wins; otherwise vega-lite sorts a
  // line/area by its dimension channel NAME (Vega then sorts scene items by
  // that item position), not by the datum field. Trail sorts by x (probed).
  const orderDef = fields.find((f) => f.channel === 'order' && f.field)
  const lineSortFields = orderDef ? [aggFieldName(orderDef)] : []
  const lineSortOrders = [orderDef?.sort === 'descending' ? 'descending' : 'ascending']
  if (mark === 'line' || mark === 'area') {
    if (orderDef) {
      markSpec.sort = { field: [aggFieldName(orderDef)], order: [orderDef.sort === 'descending' ? 'descending' : 'ascending'] }
    } else {
      markSpec.sort = { field: orient === 'vertical' ? 'x' : 'y' }
    }
  }
  if (mark === 'trail') {
    markSpec.sort = { field: orient === 'horizontal' ? 'y' : 'x' }
  }

  const out: BuiltMarks = [markSpec]

  // area with a series channel: one faceted area per series (pathgroup) —
  // vega-lite emits this for stacked and unstacked areas alike
  const colorDefSeries = fields.find((f) => f.channel === 'color' && f.field && !f.datumOnly)
  const detailDefSeries = fields.find((f) => f.channel === 'detail' && f.field && !f.datumOnly)
  const seriesForFacet = [colorDefSeries, detailDefSeries].find((f) => f != null && !f.aggregate)
  const stackedNow = (yDef != null && isStacked(yDef, mark, orient, fields)) || (xDef != null && isStacked(xDef, mark, orient, fields))
  if (mark === 'area' && seriesForFacet) {
    markSpec.name = 'layer_0_marks'
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: [aggFieldName(seriesForFacet)],
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
        type: 'area',
        style: ['area'],
        sort: { field: lineSortFields.length ? lineSortFields : [aggFieldName(xDef ?? yDef!)], order: lineSortOrders },
        from: { data: 'faceted_path_main' },
        encode: { update },
      }],
    }
    out[0] = group
  }

  // line marks split by a series channel (color or detail): one line per group
  const pointOverlay = (isObject(spec.mark) ? spec.mark.point : undefined)
    ?? cfgType?.point
    ?? cfgMark?.point
  const lineSeries = [colorDefSeries, detailDefSeries, sizeDef].filter((f): f is FieldDef => f != null && !f.aggregate)
  if (mark === 'line' && lineSeries.length) {
    markSpec.name = 'layer_0_marks'
    const innerUpdate = { ...update }
    if (colorDefSeries && !colorDefSeries.aggregate) innerUpdate.stroke = { scale: 'color', field: aggFieldName(colorDefSeries) }
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: lineSeries.map((f) => aggFieldName(f)),
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
        type: 'line',
        style: ['line'],
        sort: { field: lineSortFields.length ? lineSortFields : [aggFieldName(xDef ?? yDef!)], order: lineSortOrders },
        from: { data: 'faceted_path_main' },
        encode: { update: innerUpdate },
      }],
    }
    out[0] = group
  }

  // line/area with a point overlay: expand to a symbol mark over a filtered clone
  if ((mark === 'line' || mark === 'area') && pointOverlay) {
    const ptDef = isObject(pointOverlay) ? pointOverlay : {}
    // The generated overlay uses the 'point' style, so config.point geometry
    // (size, shape, strokeWidth, ...) reaches it like a hand-written point.
    const cfgPoint = isObject(userConfig?.point) ? (userConfig!.point as Record<string, unknown>) : {}
    const ptType = (ptDef.type as string | undefined) ?? (ptDef.shape as string | undefined)
    const ptFilled = ptDef.filled as boolean | undefined
    // VL resolves the overlay's paint from the point def and config.point only:
    // the parent line's color does not leak into its points.
    const ptFill = (ptDef.fill as string | undefined) ?? (ptDef.color as string | undefined)
      ?? (cfgPoint.fill as string | undefined) ?? (cfgPoint.color as string | undefined) ?? C.blue
    const ptStroke = (ptDef.stroke as string | undefined) ?? (cfgPoint.stroke as string | undefined)
    const overlayUpdate: Record<string, unknown> = {
      opacity: { value: 1 },
      fill: { value: ptFill },
      ...(ptStroke != null ? { stroke: { value: ptStroke } } : {}),
      x: xDef ? { scale: 'x', field: aggFieldName(xDef) } : undefined,
      y: yDef ? { scale: 'y', field: aggFieldName(yDef) } : undefined,
      ...(ptType != null ? { shape: { value: ptType } } : {}),
    }
    if (sizeDef) overlayUpdate.size = { scale: 'size', field: aggFieldName(sizeDef) }
    else if (ptDef.size != null) overlayUpdate.size = { value: ptDef.size }
    delete overlayUpdate.x2
    markSpec.name = 'layer_0_marks'
    out.push({
      name: 'layer_1_marks',
      type: 'symbol',
      style: ['point'],
      from: { data: overlayName },
      encode: { update: overlayUpdate },
    })
    out.overlayData = {
      name: overlayName,
      source: dataName,
      transform: [{ type: 'filter', expr: (definedSignal(xDef, yDef) as { signal: string }).signal }],
    }
    out.overlayFilled = ptFilled ?? ptType === 'circle'
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

/**
 * vega-lite's `zeroOrMin` baseline for the secondary end of a continuous rect/rule
 * (scaledZeroOrMin): scale zero when the domain includes it, else the domain start.
 */
function zeroOrMinRef(ch: 'x' | 'y', def: FieldDef | undefined, mark: string): unknown {
  if (def?.type === 'temporal') return { signal: `scale('${ch}', domain('${ch}')[0])` }
  const band = def != null && positionalScaleType(mark, def) === 'band'
  const quantZero = !band && def?.scale?.zero !== false
  return quantZero ? { scale: ch, value: 0 } : { signal: `scale('${ch}', inrange(0, domain('${ch}')) ? 0 : domain('${ch}')[0])` }
}

/**
 * A mark with a position channel missing needs an explicit default on that
 * axis: real Vega leaves an absent x/y at 0 (the top-left corner), whereas
 * vega-lite centers points/lines/text, stretches rules/rects/areas across the
 * group, and centers ticks/bars with a fractional size. (The same defaults
 * hold for a channel that is only a datum/value.)
 */
function fillMissingPositions(update: Record<string, unknown>, mark: string, fields: FieldDef[]): void {
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
      if (!hasX) { update.xc = midX; update.width = { signal: '0.75 * width' } }
      if (!hasY) { update.yc = midY; update.height = { signal: '0.75 * height' } }
      break
    case 'bar':
      if (!hasX) { update.xc = midX; update.width = { signal: '0.9 * width' } }
      if (!hasY) { update.yc = midY; update.height = { signal: '0.9 * height' } }
      break
    case 'area':
      if (!hasX) update.x = { value: 0 }
      if (!hasY) update.y = groupH
      break
    case 'rect':
      if (!hasX) { update.x = groupW; update.x2 = { value: 0 } }
      if (!hasY) { update.y = { value: 0 }; update.y2 = groupH }
      break
    case 'rule':
      if (!hasX) { update.x = groupW; update.x2 = { value: 0 } }
      if (!hasY) { update.y = { value: 0 }; update.y2 = groupH }
      break
  }
}

const NON_POSITION_CHANNELS = new Set(['color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape', 'text', 'tooltip', 'href', 'description'])

/** vega-lite defaultFilled: every mark but point, line and rule is filled unless configured. */
function markIsFilled(spec: VLSpec, mark: string): boolean {
  const md = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
  const cfg = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(cfg?.[mark]) ? (cfg![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(cfg?.mark) ? (cfg!.mark as Record<string, unknown>) : undefined
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
    const mainIsField = def.field !== undefined || def.aggregate === 'count' || def.datum !== undefined
    const entries: Record<string, unknown>[] = []
    if (hasCondition) {
      for (const c of (Array.isArray(def.condition) ? def.condition : [def.condition]) as Record<string, unknown>[]) {
        const entry: Record<string, unknown> = { test: predicateExpr(c.test) }
        if (c.value !== undefined) entry.value = c.value
        else if (c.field !== undefined) {
          const target = fields.find((f) => f.channel === channel)
          if (!target) throw new VLCompileError(`encoding.${channel}.condition: the conditional field has no scale`)
          const cf = flatField(String(c.field)).key
          if (cf !== target.field && !target.fromCondition) {
            throw new VLCompileError(`encoding.${channel}.condition.field: a conditional field must be the channel's own field or its only conditional field`)
          }
          entry.scale = channel
          entry.field = aggFieldName(target)
        } else throw new VLCompileError(`encoding.${channel}.condition: datum conditions are not supported`)
        entries.push(entry)
      }
    }
    const main: Record<string, unknown> | Record<string, unknown>[] | undefined = hasValue
      ? { value: def.value }
      : mainIsField
        ? (update[prop] as Record<string, unknown> | undefined)
        : undefined
    const parts = main === undefined ? entries : [...entries, ...(Array.isArray(main) ? main : [main])]
    if (parts.length === 0) continue
    // a test-bearing entry must use the array form or Vega never runs the test
    update[prop] = parts.length === 1 && entries.length === 0 ? parts[0] : parts
  }
}

function definedSignal(xDef?: FieldDef | null, yDef?: FieldDef | null): unknown {
  const parts: string[] = []
  for (const d of [xDef, yDef]) {
    if (!d || d.datumOnly) continue
    const f = JSON.stringify(aggFieldName(d))
    if (d.type === 'quantitative') {
      parts.push(`isValid(datum[${f}]) && isFinite(+datum[${f}])`)
    } else {
      parts.push(`isValid(datum[${f}]) && isFinite(+datum[${f}])`)
    }
  }
  if (!parts.length) return undefined
  return { signal: parts.join(' && ') }
}

// --- assembly ----------------------------------------------------------------

/** Compile a single unit spec (validated; the input is not mutated). */
export function compileUnit(input: VLSpec): VLSpec {
  const spec = cloneSpec(input)
  validateSpec(spec)
  return compileUnitView(spec, makeCtx(spec))
}

function compileUnitView(spec: VLSpec, ctx: CompileCtx): VLSpec {
  const markRaw = spec.mark
  const mark = typeof markRaw === 'string' ? markRaw : (markRaw as Record<string, unknown>).type as string
  const markSize = isObject(markRaw) ? (markRaw.size as number | undefined) : undefined
  const encoding = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  checkConstChannels(mark, encoding)
  const fields = parseEncodingFields(encoding)

  // orientation (bar/area/rule/tick): vertical unless the y channel is discrete
  // and x is not, or the mark def says otherwise
  const orient = inferOrient(spec, mark, markRaw, fields)

  const data = buildData(spec, fields, mark, orient, undefined, ctx)
  // vega-lite's default sizing: continuous dimensions get 300, discrete
  // dimensions size from the band step (bandspace(domain length) * step)
  const xDefS = fields.find((f) => f.channel === 'x')
  const yDefS = fields.find((f) => f.channel === 'y')
  const wSpec = sizeSpec(spec.width)
  const hSpec = sizeSpec(spec.height)
  const xStepForm = xDefS != null && ['band', 'point'].includes(positionalScaleType(mark, xDefS)) && wSpec.fixed === undefined
  const yStepForm = yDefS != null && ['band', 'point'].includes(positionalScaleType(mark, yDefS)) && hSpec.fixed === undefined
  const width: unknown = wSpec.fixed ?? (xStepForm ? 0 : 300)
  const height: unknown = hSpec.fixed ?? (yStepForm ? 0 : 300)

  const out: Record<string, unknown> = {}
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  // A clipped view cannot grow to contain overflowing guides: vega's
  // autosize-pad then measures only the (clipped) group, i.e. the plain view
  // size. Emit autosize none so the engine reproduces that viewport.
  const viewClip = (isObject(userConfig?.view) && (userConfig!.view as Record<string, unknown>).clip === true)
    || (isObject(userConfig?.style) && isObject((userConfig!.style as Record<string, unknown>).cell)
      && ((userConfig!.style as Record<string, Record<string, unknown>>).cell!.clip === true))
  out.autosize = viewClip ? 'none' : (autosizeOf(spec) ?? 'pad')
  if (!xStepForm) out.width = width
  if (!yStepForm) out.height = height
  // theta-only views (pie/donut) get vega-lite's unstyled 'view' frame — no
  // cell stroke, no half-pixel inset
  out.style = mark === 'arc' ? 'view' : 'cell'
  // Preserve a declared source dataset name (see compileLayered) — hosts key
  // data overrides/changesets on it.
  const unitSource: Record<string, unknown> = isObject(spec.data) ? dataSource(spec.data, ctx.datasets) : {}
  const unitSourceName = typeof unitSource.name === 'string' ? unitSource.name : ctx.sn(0)
  unitSource.name = unitSourceName
  const pd = pipelineDatasets(data, unitSourceName, unitSourceName, ctx, 0)
  out.data = [unitSource, ...pd.datasets]
  const dataName = pd.dataName
  const builtMarks = buildMarks(spec, fields, mark, orient, dataName, markSize, ctx.dn(pd.next)) as Record<string, unknown>[] & { overlayData?: Record<string, unknown> }
  out.marks = builtMarks
  // interval-selection brush marks (vega-lite emits them around the unit's
  // marks: the shaded background first, the interactive brush frame after).
  // Only the static brush is emitted — see validate.ts validateSelection.
  if (Array.isArray(spec.params)) {
    const brushMarks: Record<string, unknown>[] = []
    for (const p of spec.params as Record<string, unknown>[]) {
      if (!isObject(p.select)) continue
      const name = p.name as string
      const zero = { value: 0 }
      brushMarks.push(
        {
          name: `${name}_brush_bg`,
          type: 'rect',
          style: [`${name}_brush_bg`],
          clip: true,
          encode: { update: { x: zero, y: zero, x2: zero, y2: zero, fill: { value: '#333' }, fillOpacity: { value: 0.125 } } },
        },
        {
          name: `${name}_brush`,
          type: 'rect',
          style: [`${name}_brush`],
          clip: true,
          encode: { update: { x: zero, y: zero, x2: zero, y2: zero, stroke: { value: null } } },
        },
      )
    }
    if (brushMarks.length && builtMarks.length) {
      // order: brush bg, unit marks, brush frame
      out.marks = [brushMarks[0]!, ...builtMarks, ...brushMarks.slice(1)]
    }
  }
  if (builtMarks.overlayData) {
    ;(out.data as Record<string, unknown>[]).push(builtMarks.overlayData)
  }
  out.scales = buildScales(spec, fields, mark, orient, dataName, width, height, data.seriesFields, pd.rawName)
  applyScaleConfig(out.scales as ScaleSpec[], isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined)
  // discrete-dimension sizing: the scale spans steps and the view size is a
  // signal over the domain cardinality
  const sizeSignals: Record<string, unknown>[] = []
  for (const [channel, defS, stepForm, stepReq] of [['x', xDefS, xStepForm, wSpec.step], ['y', yDefS, yStepForm, hSpec.step]] as const) {
    if (!stepForm || !defS) continue
    const sc = (out.scales as ScaleSpec[]).find((s) => s.name === channel)
    if (!sc) continue
    sizeSignals.push(...stepSignals(channel, sc, stepReq))
  }
  if (sizeSignals.length) out.signals = sizeSignals
  // the point overlay's dataset joins the size domain union
  if (builtMarks.overlayData) {
    const sizeDefU = fields.find((f) => f.channel === 'size' && f.field)
    if (sizeDefU) {
      const sc = (out.scales as ScaleSpec[]).find((s) => s.name === 'size')
      if (sc && !sizeDefU.scale?.domain) {
        sc.domain = {
          fields: [
            { data: dataName, field: aggFieldName(sizeDefU) },
            { data: (builtMarks.overlayData as { name: string }).name, field: aggFieldName(sizeDefU) },
          ],
        }
      }
    }
  }
  const axes = buildAxes(fields, mark, orient, out.scales as ScaleSpec[], undefined, undefined, userConfig)
  if (axes.length) out.axes = axes
  const legends = buildUnitLegends(spec, fields, mark, markRaw)
  if (legends.length) out.legends = legends
  rootChrome(out, spec)
  return out
}

/** Legends of one unit: mark-def and config paint propagate onto the legend symbols. */
function buildUnitLegends(spec: VLSpec, fields: FieldDef[], mark: string, markRaw: unknown): Record<string, unknown>[] {
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const markOpacity = isObject(markRaw) ? (markRaw.opacity as number | undefined) : undefined
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
    fields,
    mark,
    markOpacity,
    legendFilled,
    lgStroke,
    legendStrokeWidth,
    legendFillOpacity,
    isObject(userConfig?.legend) ? (userConfig!.legend as Record<string, unknown>) : undefined,
    legendStrokeDash,
  )
}
