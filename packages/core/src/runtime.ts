/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { readData, type DataFormatSpec } from './data-format.js'
import { applyTransforms, sortRows, getField, type Row, geoJSONPath } from './transform.js'
import { buildScale, scaleTicks, type Scale, CONTINUOUS_TYPES, type ColorScale } from './scales.js'
import { geoRegistry, requireGeo } from './registry.js'
import { locale } from 'vega-format'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledScale,
  EncodeValue,
  RuntimeInput,
  ScaleDomain,
  SceneGroup,
  SceneItem,
  SceneNode,
  SceneRoot,
  SizeSpec,
  VgSpec,
} from './types.js'
import { tickFormat } from 'vega-scale'
import { compileChart } from './compiler.js'
import { trellisLayout } from './trellis.js'
import { boundAxisGroup, Bounds, boundLeaf } from './bounds.js'

const DEFAULT_SIZE = 500

/**
 * Global gradient id counter, mirroring vega-scenegraph's module-level
 * `gradient_id`. Vega assigns `gradient_<n>` from a process-global counter that
 * is never reset, so the ids a spec receives depend on how many gradient legends
 * earlier specs in the same process already rendered. Matching that counter here
 * keeps the emitted `url(#gradient_n)` references in lockstep with vega when
 * both renderers run in the same process (as the conformance harness does).
 */
let gradientIdCounter = 0

interface EvalContext {
  chart: CompiledChart
  signalParams: Record<string, unknown>
  width: number
  height: number
  datasets: Map<string, Row[]>
  scales: Map<string, Scale>
  scaleTypes: Map<string, string>
  projections: Map<string, unknown>
  runtime: ExpressionRuntime
  _defs: Array<{ id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }>
  /** Cached facet grid layout (computed once per chart). */
  _facetLayout?: FacetGridLayout | null
  /** Cached 2D repeat (scatter matrix) concat grid layout (computed once per chart). */
  _concatGrid?: ConcatGridState | null
  /** Hierarchy trees built by `stratify` transforms, keyed by data source name. */
  hierarchies: Map<string, unknown>
  /** Per-datum differential update: dataset name -> indices whose rows changed. */
  dataChanges?: Map<string, Set<number>>
}

/**
 * @public
 * Shared chart metadata extracted from a Vega spec.
 */
export interface ChartInfo {
  width: number
  height: number
  padding: { top: number; right: number; bottom: number; left: number }
  scales: Map<string, Scale>
}

/**
 * Prepare the shared EvalContext used by both evaluateChart and getChartInfo.
 * This is a single source-of-truth for signal/size/dataset/scale setup.
 */
function prepareChartCtx(chart: CompiledChart, input: RuntimeInput = {}): { ctx: EvalContext; width: number; height: number } {
  const signals = { ...chart.signals, ...input.signals }
  const width = resolveSize(chart.width, input.width, signals)
  const height = resolveSize(chart.height, input.height, signals)
  const signalParams = { width, height, ...signals }

  const datasets = new Map<string, Row[]>()
  const scales = new Map<string, Scale>()
  const scaleTypes = new Map<string, string>()
  // Expression compile cache: compileExpr parses an AST per call, and the
  // encode path calls expr() per row (conditional tests, signal values).
  // The compiled closure reads scales/datasets lazily at call time, so one
  // cache per runtime (per evaluateChart) is sound and bounded by the number
  // of distinct expression strings in the spec.
  const exprCache = new Map<string, CompiledExpr>()
  const runtime: ExpressionRuntime = {
    scale: (name) => scales.get(name),
    data: (name) => datasets.get(name),
    expr: (expr) => {
      let compiled = exprCache.get(expr)
      if (!compiled) {
        compiled = compileExpr(expr, runtime)
        exprCache.set(expr, compiled)
      }
      return compiled
    },
  }

  const defs: Array<{ id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }> = []
  const ctx: EvalContext = { chart, signalParams, width, height, datasets, scales, scaleTypes, projections: new Map(), runtime, _defs: defs, hierarchies: new Map() }
  if (input.dataChanges) {
    ctx.dataChanges = new Map(Object.entries(input.dataChanges).map(([name, idxs]) => [name, new Set(idxs)]))
  }

  // Remap Vega-Lite "category" range (unhandled by vega-scale) to tableau10
  for (const s of ctx.chart.scales) {
    if (s.range === 'category') { ; (s as unknown as Record<string, unknown>).range = 'tableau10' }
  }
  // Resolve signal `update` expressions, datasets, and scales to a fixed
  // point. Signals can reference data/scales and vice versa (e.g. brush-bounded
  // domains), which vega handles reactively; we emulate the initial pulse.
  buildProjections(ctx)
  buildDatasets(ctx, input.data ?? {})
  let changed = true
  let rounds = 0
  while (changed && rounds < 3) {
    changed = resolveSignalUpdates(ctx)
    buildScales(ctx)
    if (changed) {
      ctx.datasets.clear()
      ctx.hierarchies.clear()
      buildDatasets(ctx, input.data ?? {})
    }
    rounds++
  }
  resolveSignalUpdates(ctx)
  buildScales(ctx)
  buildProjections(ctx)

  return { ctx, width, height }
}

/** Build d3-geo projections from the compiled spec, resolving signal params. */
function buildProjections(ctx: EvalContext): void {
  if (!ctx.chart.projections?.length) return
  const build = requireGeo() // throws an actionable error if the geo addon is absent
  const evalNum = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v
    if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
      try { const r = ctx.runtime.expr(String((v as { signal: string }).signal))({}, ctx.signalParams); return typeof r === 'number' ? r : undefined } catch { return undefined }
    }
    return undefined
  }
  const evalTup = (v: unknown): [number, number] | undefined => {
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1])]
    if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
      try {
        const r = ctx.runtime.expr(String((v as { signal: string }).signal))({}, ctx.signalParams)
        if (Array.isArray(r)) return [Number(r[0]), Number(r[1])]
      } catch { /* ignore */ }
    }
    return undefined
  }
  for (const p of ctx.chart.projections) {
    ctx.projections.set(p.name, build({
      name: p.name,
      type: p.type,
      scale: evalNum(p.scale),
      translate: evalTup(p.translate),
      center: evalTup(p.center),
      rotate: evalTup(p.rotate),
      precision: evalNum(p.precision),
      clipAngle: evalNum(p.clipAngle),
      reflectX: p.reflectX,
      reflectY: p.reflectY,
    }, ctx.width, ctx.height))
  }
}

/**
 * Evaluate static signal `update` expressions in declaration order against the
 * current signal params (vega-expression rewrites bare identifiers to the
 * `$`-prefixed params our interpreter binds). Expressions that depend on not-yet
 * resolved values throw and are skipped for this round. Returns whether any
 * value changed (drives the fixed-point loop).
 */
function resolveSignalUpdates(ctx: EvalContext): boolean {
  const defs = ctx.chart.signalDefs
  if (!defs?.length) return false
  let changed = false
  for (const def of defs) {
    if (!def.update) continue
    try {
      const value = ctx.runtime.expr(def.update)(undefined, ctx.signalParams)
      if (value !== undefined && value !== ctx.signalParams[def.name]) {
        ctx.signalParams[def.name] = value
        ctx.chart.signals[def.name] = value
        changed = true
      }
    } catch {
      // Unresolved dependency this round; keep previous value.
    }
  }
  return changed
}


// ===========================================================================
// Shared axis/legend + padding computation — used by both evaluateChart and getChartInfo
// ===========================================================================

interface AxisLegendResult {
  groups: SceneGroup[]
  padding: { top: number; right: number; bottom: number; left: number }
}

function buildAxisAndLegend(ctx: EvalContext): { groups: SceneGroup[] } {
  const groups: SceneGroup[] = []

  for (const axis of ctx.chart.axes) {
    const group = buildAxis(axis, ctx)
    if (group) groups.push(group)
  }
  // Stack right-oriented legends vertically below each other (matching vega's
  // legend layout). Each legend's y is offset by the cumulative height of all
  // preceding right-oriented legends plus a small gap.
  let rightLegendY = 0
  const LEGEND_GAP = 8
  for (const legend of ctx.chart.legends) {
    const orient = legend.orient ?? 'right'
    const group = buildLegend(legend, ctx)
    if (group) {
      if (orient === 'right' || orient === undefined) {
        group.y = rightLegendY
        rightLegendY += (group.height ?? 0) + LEGEND_GAP
      }
      groups.push(group)
    }
  }

  return { groups }
}

function computeGuidePadding(
  items: SceneGroup[],
  width: number,
  height: number,
  base: { top: number; right: number; bottom: number; left: number },
): { top: number; right: number; bottom: number; left: number } {
  // Vega's autosize unions the *recursive* bounds of every top-level guide
  // (axis/legend) and mark into the viewBounds and grows the padding by the
  // overflow. Measure each group with the exact vega bounds port: axes via
  // the axisLayout spine semantics, everything else via the recursive
  // item-union (same as vega-scenegraph's bound pass).
  let minX = 0
  let maxX = width
  let minY = 0
  let maxY = height

  for (const group of items) {
    const b = group.role === 'axis'
      ? boundAxisGroup(group)
      : boundLeaf(new Bounds(), group as unknown as SceneItem)
    if (b.empty()) continue
    minX = Math.min(minX, b.x1)
    maxX = Math.max(maxX, b.x2)
    minY = Math.min(minY, b.y1)
    maxY = Math.max(maxY, b.y2)
  }

  // vega's viewSizeLayout (autosize pad): origin = spec padding + the ceil'd
  // overflow of the viewBounds on each side — no extra margin.
  return {
    left:   base.left   + Math.max(0, Math.ceil(-minX)),
    right:  base.right  + Math.max(0, Math.ceil(maxX - width)),
    top:    base.top    + Math.max(0, Math.ceil(-minY)),
    bottom: base.bottom + Math.max(0, Math.ceil(maxY - height)),
  }
}


/**
 * The set of datasets affected by a change, closed transitively over `source`
 * chains: a derived dataset (source: A) changes whenever A changes.
 */
function affectedDatasets(chart: CompiledChart, changed: Set<string>): Set<string> {
  const affected = new Set(changed)
  let grew = true
  while (grew) {
    grew = false
    for (const d of chart.data) {
      const src = (d as CompiledData & { source?: string }).source
      if (src && affected.has(src) && !affected.has(d.name)) {
        affected.add(d.name)
        grew = true
      }
    }
  }
  return affected
}

/** Collect the scale names a mark references in its encode (recursive). */
function collectMarkScales(mark: CompiledMark): Set<string> {
  const out = new Set<string>()
  const enc = (mark as { encode?: Record<string, Record<string, unknown>> }).encode
  if (!enc) return out
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    const rec = v as Record<string, unknown>
    if (typeof rec.scale === 'string') out.add(rec.scale)
    for (const k of Object.keys(rec)) walk(rec[k])
  }
  for (const stage of Object.keys(enc)) walk(enc[stage])
  return out
}

/** A data-derived scale domain referencing an affected dataset. */
function hasAffectedDomain(domain: ScaleDomain, affected: Set<string>): boolean {
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    const dataRef = (domain as { data?: unknown }).data
    if (typeof dataRef === 'string' && affected.has(dataRef)) return true
  }
  return false
}

function markTouchesChangedData(mark: CompiledMark, chart: CompiledChart, changed: Set<string>): boolean {
  // Marks with no `from` and no data-derived scale domain (static shapes)
  // never depend on data changes.
  const affected = affectedDatasets(chart, changed)
  if (mark.from?.data && affected.has(mark.from.data)) return true
  // A mark can draw from an unaffected dataset but be positioned by a scale
  // whose domain spans a changed dataset; the reused group would hold stale
  // positions, so treat it as touched.
  for (const name of collectMarkScales(mark)) {
    const scale = chart.scales.find((s) => s.name === name)
    if (scale && hasAffectedDomain(scale.domain, affected)) return true
  }
  return false
}

/** Find the previous scene's top-level groups for a mark (by mark name or type). */
function findReusableMarkGroup(prevItems: SceneGroup[], mark: CompiledMark): SceneGroup | null {
  const match = (g: SceneGroup): boolean =>
    g.name === mark.name || (mark.name == null && g.role === 'mark' && g.marktype === mark.type)
  for (const g of prevItems) {
    if (match(g)) return g
  }
  return null
}

/**
 * Build the scene content (marks, axes/legends, title, trellis) and the
 * autosize padding at a given content size. Extracted from evaluateChart so
 * `fit`/`fit-x`/`fit-y` can re-run at a shrinking content size and converge.
 */
function buildContent(
  chart: CompiledChart,
  input: RuntimeInput,
  cw: number,
  ch: number,
): { items: SceneGroup[]; padding: ReturnType<typeof computeGuidePadding>; ctx: EvalContext; width: number; height: number; isFacetSpec: boolean } {
  const { ctx, width, height } = prepareChartCtx(chart, { ...input, width: cw, height: ch })

  // Partial re-evaluation: when the caller names the datasets whose values
  // changed, marks drawing from untouched datasets reuse the previous scene's
  // groups (item identity preserved for the DOM patcher), so an update to one
  // dataset skips re-encoding every other mark.
  const prevItems = (chart as unknown as { __prevItems?: SceneGroup[] }).__prevItems
  // A per-datum changeset also marks its dataset as changed (it re-evaluates).
  const changedSet = (input.changedDatasets || input.dataChanges)
    ? new Set([...(input.changedDatasets ?? []), ...Object.keys(input.dataChanges ?? {})])
    : null

  const items: SceneGroup[] = []

  // 1) Build marks (plot area)
  for (const mark of ctx.chart.marks) {
    if (changedSet && !markTouchesChangedData(mark, ctx.chart, changedSet) && prevItems) {
      const reused = findReusableMarkGroup(prevItems, mark)
      if (reused) {
        items.push(reused)
        continue
      }
    }
    const prevGroup = prevItems ? findReusableMarkGroup(prevItems, mark) : null
    const result = evaluateMark(mark, ctx, prevGroup)
    if (result) {
      if (Array.isArray(result)) {
        for (const g of result) items.push(g)
      } else {
        items.push(result)
      }
    }
  }

  // 2) Build axes + legends and compute padding
  const { groups: guideGroups } = buildAxisAndLegend(ctx)
  for (const g of guideGroups) items.push(g)

  // 2b) Top-level title.
  const titleGroup = buildTitleGroup(ctx.chart, items, width, height)
  if (titleGroup) items.push(titleGroup)

  // 2c) Trellis layout (vega's ViewLayout/trellisLayout port).
  const hasFacetMarks = (ctx as any).chart.marks?.some((m: any) => m.from?.facet?.groupby?.length > 0) ?? false
  const hasChildSignals = ctx.signalParams['child_width'] !== undefined && ctx.signalParams['child_height'] !== undefined
  const isFacetSpec = hasFacetMarks && hasChildSignals
  if (isFacetSpec && isTrellis(ctx)) {
    applyTrellisLayout(items, ctx)
  }

  // 2d) viewSizeLayout padding (overflow) after the trellis layout.
  const padding = computeGuidePadding(items, width, height, ctx.chart.padding)
  return { items, padding, ctx, width, height, isFacetSpec }
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const auto = chart.autosize
  const base = chart.padding
  const signals = { ...chart.signals, ...input.signals }
  const initialW = resolveSize(chart.width, input.width, signals)
  const initialH = resolveSize(chart.height, input.height, signals)

  // `fit`/`fit-x`/`fit-y` shrink the *content* to fit a fixed viewport, then
  // vega re-runs layout (resizeView) so scales are rebuilt at the fitted size.
  // Reproduce that by iterating the content size to a fixed point.
  let cw = initialW
  let ch = initialH
  let built = buildContent(chart, input, cw, ch)
  if (auto === 'fit' || auto === 'fit-x' || auto === 'fit-y') {
    for (let i = 0; i < 5; i++) {
      const oL = built.padding.left - base.left
      const oR = built.padding.right - base.right
      const oT = built.padding.top - base.top
      const oB = built.padding.bottom - base.bottom
      let nw = cw
      let nh = ch
      // vega shrinks content against the *fixed* viewport (viewWidth/viewHeight),
      // not the current content: content = viewport - overflow.
      if (auto === 'fit') { nw = Math.max(0, initialW - oL - oR); nh = Math.max(0, initialH - oT - oB) }
      else if (auto === 'fit-x') { nw = Math.max(0, initialW - oL - oR); nh = ch }
      else { nw = cw; nh = Math.max(0, initialH - oT - oB) }
      if (nw === cw && nh === ch) break
      cw = nw
      ch = nh
      built = buildContent(chart, { ...input, changedDatasets: undefined }, cw, ch)
    }
  }
  const { ctx, width, height } = built
  const items = built.items
  const padding = built.padding
  const isFacetSpec = built.isFacetSpec

  // 3) Build the scene
  let sceneWidth: number
  let sceneHeight: number
  const isConcat = isConcatSpec(ctx.chart)
  const isVerticalConcat = isConcat && ctx.signalParams['childWidth'] === undefined && ctx.signalParams['childHeight'] !== undefined
  // A 2D repeat (e.g. scatter matrix) compiles to a concat whose cells use both
  // childWidth AND childHeight signals; vega renders such a chart at the SVG
  // minimum viewport (10x10) because both dimensions are signal-based.
  const is2DConcat = isConcat && ctx.signalParams['childWidth'] !== undefined && ctx.signalParams['childHeight'] !== undefined
  
  if (ctx.chart.autosize !== 'none') {
    sceneWidth = width + padding.left + padding.right
    sceneHeight = height + padding.top + padding.bottom
  } else {
    if (isFacetSpec) {
      // Find the extent of all items (top-level only, since axes are top-level siblings in our setup)
      // The items are: row-title, row_headers, column_footer, cells
      // Each has an x/y within the plot area and possibly width/height
      // Nested items (axis, nested marks) are at their absolute positions within the plot
      let minX = 0, minY = 0
      for (const it of items) {
        if (!it) continue
        const ix = (it.x ?? 0), iy = (it.y ?? 0)
        if (ix < minX && ix !== undefined) minX = ix
        if (iy < minY && iy !== undefined) minY = iy
      }
      let maxX = 0, maxY = 0
      for (const it of items) {
        if (!it) continue
        const ix = (it.x ?? 0) + ((it as any).width ?? 0)
        const iy = (it.y ?? 0) + ((it as any).height ?? 0)
        if (ix > maxX) maxX = ix
        if (iy > maxY) maxY = iy
      }
      // Use the plot area dimensions from the signals (child_width/child_height)
      // plus padding. This matches vega's behavior when width/height are signal-based.
      const plotW = ctx.signalParams['child_width'] ?? 500
      const plotH = ctx.signalParams['child_height'] ?? 500
      // Match vega's minimum canvas: plot area is 0x0 when dimensions are signal-based,
      // and the viewport is the default SVG minimum (10x10).
      sceneWidth = 10
      sceneHeight = 10
    } else if (isConcat) {
      if (is2DConcat) {
        // 2D repeat grid (scatter matrix): both cell dimensions are
        // signal-based, so vega renders the viewport at the SVG minimum (10x10).
        sceneWidth = 10
        sceneHeight = 10
      } else if (isVerticalConcat) {
        // Vconcat with signal-based cell height and explicit width: vega renders
        // the viewport at the SVG minimum height (10) but uses the real chart width.
        sceneWidth = width + ctx.chart.padding.left + ctx.chart.padding.right
        sceneHeight = 10
      } else {
        // Concat with signal-based cell width and explicit height: vega renders the
        // viewport at the SVG minimum width (10) but uses the real chart height.
        sceneWidth = 10
        sceneHeight = height + ctx.chart.padding.top + ctx.chart.padding.bottom
      }
    } else {
      sceneWidth = width + ctx.chart.padding.left + ctx.chart.padding.right
      sceneHeight = height + ctx.chart.padding.top + ctx.chart.padding.bottom
    }
  }

  const scene: SceneRoot = {
    width: sceneWidth,
    height: sceneHeight,
    background: ctx.chart.background,
    frameStroke: ctx.chart.frameStroke,
    padding: ctx.chart.autosize === 'none' ? ctx.chart.padding : padding,
    items,
  }
  // Event-loop wiring (non-serialized internals)
  ;(scene as unknown as { runtime?: unknown }).runtime = ctx.runtime
  ;(scene as unknown as { signalParams?: Record<string, unknown> }).signalParams = ctx.signalParams
  ;(scene as unknown as { compiled?: unknown }).compiled = ctx.chart
  // Partial re-evaluation memo
  ;(chart as unknown as { __prevItems?: SceneGroup[] }).__prevItems = items
  if (ctx._defs.length) scene.defs = ctx._defs
  return scene
}

/**
 * Compute chart metadata (size, padding, scales) without building the full scene.
 * Useful for interaction, brushing, crosshair, etc.
 */
export function getChartInfo(spec: VgSpec, input: RuntimeInput = {}): ChartInfo {
  const chart = compileChart(spec)
  const { ctx, width, height } = prepareChartCtx(chart, input)

  // Build the full scene (cheap relative to the caller's own render pass) so
  // the padding matches evaluateChart's viewSizeLayout computation exactly.
  const scene = evaluateChart(chart, input)

  return {
    width,
    height,
    padding: chart.autosize === 'none' ? chart.padding : (scene.padding ?? chart.padding),
    scales: ctx.scales,
  }
}

/**
 * Estimate a text string's rendered width using vega-scenegraph's headless
 * estimate: `~~(0.8 * text.length * fontSize)`.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  return ~~(0.8 * text.length * fontSize)
}

/**
 * View content bounds used by vega's `titleLayout` (the root group's bounds:
 * plot rect unioned with axis/legend/mark overflow). Axis line overflow is
 * calibrated to vega's measured bounds (tick end ± half-stroke; labels via the
 * same text estimator vega uses when no canvas is available).
 */
interface ContentBounds { x1: number; y1: number; x2: number; y2: number }

function contentBoundsOf(chart: CompiledChart, items: SceneNode[], width: number, height: number): ContentBounds {
  const b: ContentBounds = { x1: 0, y1: 0, x2: width, y2: height }
  // Axis tick marks (labels handled by the item scan below).
  for (const axis of chart.axes) {
    const tickSize = typeof axis.tickSize === 'number' ? axis.tickSize : 5
    const ticksOn = axis.ticks !== false
    if (!ticksOn) continue
    switch (axis.orient) {
      case 'left': b.x1 = Math.min(b.x1, -(tickSize + 0.5)); break
      case 'right': b.x2 = Math.max(b.x2, width + tickSize + 0.5); break
      case 'top': b.y1 = Math.min(b.y1, -(tickSize + 0.5)); break
      default: b.y2 = Math.max(b.y2, height + tickSize + 0.5); break
    }
  }
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    b.x1 = Math.min(b.x1, x1); b.y1 = Math.min(b.y1, y1)
    b.x2 = Math.max(b.x2, x2); b.y2 = Math.max(b.y2, y2)
  }
  const walk = (node: SceneNode, tx: number, ty: number) => {
    const ox = tx + (node.x ?? 0)
    const oy = ty + (node.y ?? 0)
    const children = (node as SceneGroup).items
    if (Array.isArray(children)) {
      for (const c of children) walk(c, ox, oy)
      return
    }
    const it = node as SceneItem
    if (it.text != null) {
      const fs = (it as Record<string, unknown>).fontSize as number | undefined ?? 11
      const w = estimateTextWidth(String(it.text), fs)
      const angle = (it as Record<string, unknown>).angle as number | undefined
      const anchor = it.align
      if (angle) {
        // Vega's text bounds (svg.js `bound`): the unrotated box is
        //   x: [x + (align offset), + w]
        //   y: [y + offset(item) - round(0.8h), + h]   (h = fontSize)
        // then rotated about the anchor (x, y) and the axis-aligned hull taken
        // (Bounds.rotate). `offset(item)` is the baseline correction.
        const h = fs
        const boff = it.baseline === 'top' ? Math.round(0.79 * h)
          : it.baseline === 'middle' ? Math.round(0.30 * h)
          : it.baseline === 'bottom' ? Math.round(-0.21 * h) : 0
        const bx1 = anchor === 'center' ? ox - w / 2 : anchor === 'right' ? ox - w : ox
        const by1 = oy + boff - Math.round(0.8 * h)
        const bx2 = bx1 + w
        const by2 = by1 + h
        const rad = (angle * Math.PI) / 180
        const cos = Math.cos(rad), sin = Math.sin(rad)
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
        for (const [px, py] of [[bx1, by1], [bx2, by1], [bx1, by2], [bx2, by2]] as [number, number][]) {
          const rx = ox + (px - ox) * cos - (py - oy) * sin
          const ry = oy + (px - ox) * sin + (py - oy) * cos
          mnx = Math.min(mnx, rx); mny = Math.min(mny, ry)
          mxx = Math.max(mxx, rx); mxy = Math.max(mxy, ry)
        }
        grow(mnx, mny, mxx, mxy)
      } else {
        let lx1: number
        if (anchor === 'center') lx1 = ox - w / 2
        else if (anchor === 'right') lx1 = ox - w
        else lx1 = ox
        // Vega text bounds: ascent 0.78*fs above the drawn baseline. Our raw y is
        // pre-baseline-offset, so `top` draws at y+0.79fs (bounds ≈ y..y+fs).
        if (it.baseline === 'top') grow(lx1, oy, lx1 + w, oy + fs)
        else if (it.baseline === 'middle') grow(lx1, oy - fs / 2, lx1 + w, oy + fs / 2)
        else grow(lx1, oy - fs, lx1 + w, oy)
      }
    } else if (it.width != null && it.height != null) {
      grow(ox, oy, ox + (it.width ?? 0), oy + (it.height ?? 0))
    } else if (it.radius != null) {
      const sw = (it.strokeWidth ?? (it.stroke ? 1 : 0)) / 2
      grow(ox - it.radius - sw, oy - it.radius - sw, ox + it.radius + sw, oy + it.radius + sw)
    }
  }
  for (const node of items) walk(node, 0, 0)
  return b
}

function buildTitleGroup(chart: CompiledChart, items: SceneNode[], width: number, height: number): SceneGroup | null {
  const title = chart.title
  if (!title || !title.text) return null
  let vb = title.frame === 'group'
    ? { x1: 0, y1: 0, x2: width, y2: height }
    : contentBoundsOf(chart, items, width, height)

  // Title (and subtitle) text sizes. Vega's default subtitle style is
  // fontSize 11, non-bold.
  const titleH = title.fontSize
  const hasSub = !!title.subtitle
  const subFs = 11
  const subH = hasSub ? subFs : 0
  const groupH = titleH + (hasSub ? title.subtitlePadding + subH : 0)
  const titleW = estimateTextWidth(title.text, title.fontSize)
  const subW = hasSub ? estimateTextWidth(title.subtitle!, subFs) : 0
  // vega's layoutGroup viewBounds: [0,0,w,h] ∪ default marks ∪ axis/legend
  // bounds ∪ headers. Axis marks measure in the axis-internal frame; our
  // scene bakes the 0.5px axis delta into the axis leaves — shift it out.
  if (title.frame !== 'group') {
    const b = new Bounds().set(0, 0, width, height)
    for (const g of items as SceneGroup[]) {
      if (g.role === 'title') continue
      const bb = g.role === 'axis'
        ? boundAxisGroup(g as SceneGroup)
        : boundLeaf(new Bounds(), g as SceneItem)
      b.union(bb)
    }
    vb = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
  }

  const groupW = Math.max(titleW, subW)

  const pos = title.anchor === 'start'
    ? (title.orient === 'left' || title.orient === 'right' ? vb.y1 : vb.x1)
    : title.anchor === 'end'
      ? (title.orient === 'left' || title.orient === 'right' ? vb.y2 : vb.x2)
      : title.orient === 'left' || title.orient === 'right'
        ? (vb.y1 + vb.y2) / 2
        : (vb.x1 + vb.x2) / 2

  let x = 0
  let y = 0
  switch (title.orient) {
    case 'bottom': x = pos; y = vb.y2 + title.offset; break
    case 'left': x = vb.x1 - groupW - title.offset; y = pos; break
    case 'right': x = vb.x2 + title.offset; y = pos; break
    default: x = pos; y = vb.y1 - groupH - title.offset; break
  }

  // Text align within the group: center anchors the text at group center.
  const align: SceneItem['align'] =
    title.anchor === 'start' ? 'left' : title.anchor === 'end' ? 'right' : 'center'

  const textChildren: SceneNode[] = [
    {
      marktype: 'text',
      role: 'title-text',
      items: [{
        x: 0,
        y: 0,
        text: title.text,
        align,
        baseline: 'top',
        fontSize: title.fontSize,
        fontWeight: title.fontWeight,
        fill: title.color,
        dy: title.dy,
      } as SceneItem],
    } as SceneGroup,
  ]

  if (hasSub) {
    textChildren.push({
      marktype: 'text',
      role: 'title-subtitle',
      items: [{
        x: 0,
        y: titleH + title.subtitlePadding,
        text: title.subtitle!,
        align,
        baseline: 'top',
        fontSize: subFs,
        fontWeight: title.fontWeight,
        fill: title.color,
        dy: title.dy,
      } as SceneItem],
    } as SceneGroup)
  }

  return {
    marktype: 'group',
    role: 'title',
    x,
    y,
    width: groupW,
    height: groupH,
    items: textChildren,
  }
}

function resolveSize(size: SizeSpec, override: number | undefined, signals: Record<string, unknown>): number {
  if (override != null) return override
  if (typeof size === 'number' && Number.isFinite(size)) return size
  if (size && typeof size === 'object') {
    if ('signal' in size) {
      const v = signals[size.signal]
      return typeof v === 'number' ? v : DEFAULT_SIZE
    }
    if ('step' in size) {
      throw new Error('[aster] width/height {step} sizing is not supported yet')
    }
  }
  return DEFAULT_SIZE
}

function buildDatasets(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  const sources = new Map<string, CompiledChart['data'][number]>()
  for (const d of ctx.chart.data) sources.set(d.name, d)

  const build = (name: string, seen: Set<string>): Row[] => {
    if (ctx.datasets.has(name)) return ctx.datasets.get(name)!
    const d = sources.get(name)
    if (!d) {
      const rows = (inputData[name] as Row[]) ?? []
      ctx.datasets.set(name, rows)
      return rows
    }
    if (seen.has(name)) throw new Error(`[aster] circular data reference: ${name}`)
    seen.add(name)

    let rows: Row[]
    if ('source' in d && (d as CompiledChart['data'][number] & { source: string }).source) {
      const src = (d as CompiledChart['data'][number] & { source: string }).source
      const srcDef = ctx.chart.data.find((sd) => sd.name === src)
      if ((d as { format?: DataFormatSpec }).format && srcDef?.values != null) {
        // Vega applies a derived dataset's `format` when (re-)parsing its
        // source's raw values (e.g. source = inline Topology, format =
        // topojson feature extraction).
        rows = readData(srcDef.values, (d as { format?: DataFormatSpec }).format)
      } else {
        rows = build(src, seen).map((r) => ({ ...r }))
      }
    } else if (d.values != null) {
      if (inputData[name]) {
        rows = readData(inputData[name], d.format)
      } else {
        // vega-loader read semantics: object arrays pass through format.parse
        // coercion; string values are parsed by the registered reader.
        rows = readData(d.values, d.format)
      }
    } else {
      rows = ((inputData[name] as Row[]) ?? []).map((r) => ({ ...r }))
    }
    if (d.transform.length) {
      rows = applyTransforms(rows, d.transform, {
        runtime: ctx.runtime,
        signals: ctx.signalParams,
        // Cross-dataset access for the `lookup` transform. Build the referenced
        // dataset on demand (it may be declared after this one in the spec).
        datasets: (name) => {
          if (!ctx.datasets.has(name) && sources.has(name)) build(name, new Set())
          return ctx.datasets.get(name)
        },
        hierarchies: ctx.hierarchies,
        projections: ctx.projections,
      }, d.name)
    }
    ctx.datasets.set(name, rows)
    return rows
  }

  for (const d of ctx.chart.data) {
    build(d.name, new Set())
  }
}

function buildScales(ctx: EvalContext): void {
  const scaleSignals = ctx.signalParams
  for (const s of ctx.chart.scales) {
    // Vega-lite emits `{ fields: [{data, field}, ...] }` domains for layered
    // charts (several datasets contribute to one shared scale). scales.ts only
    // understands single-dataset domains, so resolve the multi-dataset form
    // here into a concrete domain before building the scale.
    const multiDomain = resolveMultiDatasetDomain(s.domain, ctx)
    if (multiDomain) {
      ;(s as unknown as { domain: unknown }).domain = concreteDomain(s, multiDomain)
    }
    const scale = buildScale(s, {
      width: ctx.width,
      height: ctx.height,
      signals: scaleSignals,
      evaluate: (expr) => ctx.runtime.expr(expr)({}, ctx.signalParams),
      dataField: (dataName, field) => {
        const rows = ctx.datasets.get(dataName) ?? []
        const out: unknown[] = []
        for (const r of rows) out.push(getField(r, field))
        return out
      },
      dataRows: (dataName) => (ctx.datasets.get(dataName) ?? []) as Record<string, unknown>[],
    })
    ctx.scales.set(s.name, scale)
    ctx.scaleTypes.set(s.name, s.type)
  }
}

/**
 * Resolve a vega-lite "multi-dataset" scale domain — `{ fields: [{data, field},
 * ...] }` (layered charts) — into a concrete domain array. Returns null when the
 * domain is not in that form, so scales.ts handles everything else unchanged.
 */
function resolveMultiDatasetDomain(domain: ScaleDomain, ctx: EvalContext): unknown[] | null {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) return null
  if ('signal' in domain) return null
  const fields = (domain as { fields?: unknown }).fields
  if (!Array.isArray(fields) || !fields.length) return null
  const refs = fields as unknown[]
  if (!refs.every((f) => f != null && typeof f === 'object' && typeof (f as { data?: unknown }).data === 'string' && typeof (f as { field?: unknown }).field === 'string')) {
    return null
  }
  const all: unknown[] = []
  for (const f of refs) {
    const ref = f as { data: string; field: string }
    const rows = ctx.datasets.get(ref.data) ?? []
    for (const r of rows) all.push((r as Row)[ref.field])
  }
  return all
}

/** Collapse collected multi-dataset values into the concrete domain for a scale type. */
function concreteDomain(scale: CompiledScale, values: unknown[]): unknown[] {
  const type = scale.type
  if (type === 'time' || type === 'utc') {
    const ms: number[] = []
    for (const v of values) {
      const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : null
      if (d && Number.isFinite(d.getTime())) ms.push(d.getTime())
    }
    return ms.length ? [Math.min(...ms), Math.max(...ms)] : []
  }
  if (CONTINUOUS_TYPES.has(type)) {
    const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
    return finite.length ? [Math.min(...finite), Math.max(...finite)] : []
  }
  // Discrete scales: distinct values (sorted when the domain requests it).
  const distinct: unknown[] = []
  for (const v of values) if (!distinct.some((x) => x === v)) distinct.push(v)
  const sort = (scale.domain as { sort?: unknown }).sort
  if (sort === true || sort === 'ascending') {
    distinct.sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
  } else if (sort === 'descending') {
    distinct.sort((a, b) => String(a) > String(b) ? -1 : String(a) < String(b) ? 1 : 0)
  } else if (sort && typeof sort === 'object' && !Array.isArray(sort)) {
    const order = (sort as { order?: string }).order
    if (order === 'descending') {
      distinct.sort((a, b) => String(a) > String(b) ? -1 : String(a) < String(b) ? 1 : 0)
    } else if (order === 'ascending' || !order) {
      distinct.sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
    }
  }
  return distinct
}

/**
 * Per-datum differential reuse is safe only when publishing the changed indices
 * actually captures every reason a *row* re-encodes to a different item:
 *  - the source dataset has a published changeset (index alignment),
 *  - row length/order is unchanged (no mark sort, no reordering transform),
 *  - the mark uses no scale whose data-domain spans a changed dataset (otherwise
 *    an unchanged row's position shifts when the domain recomputes).
 */
function canReuseItems(
  mark: CompiledMark,
  ctx: EvalContext,
  source: string,
  rowCount: number,
  prevGroup: SceneGroup | null | undefined,
  rectSorts: boolean,
): boolean {
  if (!ctx.dataChanges) return false
  const changes = ctx.dataChanges.get(source)
  if (!changes || !prevGroup) return false
  const prevItems = prevGroup.items as SceneItem[]
  if (rowCount !== prevItems.length) return false
  if (mark.sort || mark.transform?.length || rectSorts) return false
  // Build the affected dataset closure from the changesets (and any dataset
  // flags), then bail if the mark references a scale with an affected domain.
  const affected = affectedDatasets(ctx.chart, new Set(ctx.dataChanges.keys()))
  for (const name of collectMarkScales(mark)) {
    const scale = ctx.chart.scales.find((s) => s.name === name)
    if (scale && hasAffectedDomain(scale.domain, affected)) return false
  }
  return true
}

function evaluateMark(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup?: SceneGroup | null,
): SceneGroup | SceneGroup[] | null {
  if (mark.type === 'group') {
    return buildGroupMark(mark, ctx)
  }
  const source = mark.from?.data

  let items: SceneItem[]
  if (source) {
    const rawRows = ctx.datasets.get(source) ?? []
    // Only clone rows when the pipeline will re-encode them all (a mark-level
    // sort or transform); the differential path reads the raw rows and clones
    // just the changed indices, so an unchanged row is never copied.
    let rows: Row[] = rawRows
    let rowsCloned = false
    if (mark.sort || mark.transform?.length) {
      rows = rawRows.map((r) => ({ ...r }))
      rowsCloned = true
      if (mark.sort) rows = sortRows(rows, mark.sort)
      if (mark.transform?.length) {
        rows = applyTransforms(rows, mark.transform, {
          runtime: ctx.runtime,
          signals: ctx.signalParams,
          hierarchies: ctx.hierarchies,
          projections: ctx.projections,
        }, source)
      }
    }

    // Sort rect marks by their scale y field so rendering order matches vega:
    // bars with smaller y-value render first (appear at the front).
    let rectSorts = false
    if (mark.type === 'rect') {
      const enc = mark.encode?.update
      if (enc) {
        for (const key of ['y', 'yc'] as const) {
          const val = enc[key]
          if (val && typeof val === 'object' && 'field' in val) {
            const f = (val as { field: string }).field
            rows = [...rows].sort((a: Row, b: Row) => {
              const av = a[f]
              const bv = b[f]
              return (typeof bv === 'number' ? bv : 0) - (typeof av === 'number' ? av : 0)
            })
            rectSorts = true
            break
          }
        }
      }
    }

    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    // Per-datum differential update: when the source dataset published a
    // changeset and reuse is provably safe (no reordering, unchanged length, no
    // scale whose data-domain spans a changed dataset), keep the previous item
    // objects for unchanged indices so the DOM patcher skips them and the
    // re-encode of those items is skipped entirely (including the row clone).
    if (canReuseItems(mark, ctx, source, rows.length, prevGroup, rectSorts)) {
      const changes = ctx.dataChanges!.get(source)!
      const prevItems = prevGroup!.items as SceneItem[]
      items = new Array(rows.length)
      for (let i = 0; i < rows.length; i++) {
        const prev = prevItems[i]
        if (!changes.has(i) && prev) {
          items[i] = prev
          continue
        }
        const row = { ...(rows[i] as Row) }
        const res = resolveEncodeSet(update, row, ctx, mark.type)
        res.datum = row
        items[i] = res
      }
    } else {
      items = rows.map((row) => {
        const copy = rowsCloned ? row : { ...row }
        const res = resolveEncodeSet(update, copy, ctx, mark.type)
        res.datum = copy
        return res
      })
    }
  } else {
    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    items = [resolveEncodeSet(update, {}, ctx, mark.type)]
  }

  // Apply arc style default: strokeWidth=1.5
  if (Array.isArray(mark.style) ? mark.style.includes('arc') : mark.style === 'arc') {
    for (const it of items) {
      if (it.strokeWidth == null) it.strokeWidth = 1.5
    }
  }

  // Text marks encoded in polar coordinates (`radius` + `theta`, e.g. pie
  // labels): vega's text renderer offsets the anchor by
  // `radius * (cos(theta - π/2), sin(theta - π/2))` from the item's x/y.
  // Vega's mark defaults (vega.js defaults()): line {strokeWidth: 2},
  // area {fill: '#4c78a8'}, text {fill: '#000'} — applied when the encode
  // leaves the property unspecified.
  if (mark.type === 'line' || mark.type === 'area' || mark.type === 'text') {
    const fill = mark.type === 'text' ? '#000' : mark.type === 'area' ? '#4c78a8' : undefined
    for (const it of items) {
      const rec = it as unknown as Record<string, unknown>
      if (fill !== undefined && rec.fill === undefined) rec.fill = fill
      if (mark.type === 'line' && rec.strokeWidth === undefined) rec.strokeWidth = 2
    }
  }
  if (mark.type === 'text') {
    applyTextPolar(items)
  }

  // The vega-lite point/circle/square styles default stroked symbols to
  // strokeWidth=2 (vega config `style.point` etc.). A raw vega symbol mark
  // without those styles carries no default width.
  applySymbolStyleDefaults(mark, items)

  // Shape/geoshape marks: turn the GeoJSON-derived path (from a geoshape
  // transform or from the datum itself) into a rendered path item.
  if (mark.type === 'shape' || mark.type === 'geoshape') {
    for (const it of items) {
      const datum = (it as { datum?: Row }).datum
      if (!datum) continue
      let path: string | undefined
      if (mark.type === 'geoshape' && typeof datum.shape !== 'string') {
        // Raw geoshape mark: the datum itself is the GeoJSON geometry.
        path = geoJSONPath(datum)
      } else {
        // The path may come from a geoshape transform (datum.shape) or from a
        // `path` data field on a shape mark.
        const shape = datum.shape
        path = typeof shape === 'string' ? shape : (typeof datum.path === 'string' ? datum.path : undefined)
      }
      if (path) it.path = path
    }
  }

  // Path marks whose `path` channel resolves to a GeoJSON object (e.g. the
  // output of a `contour` transform) render that geometry in pixel space,
  // matching vega's path-mark geo handling.
  if (mark.type === 'path') {
    for (const it of items) {
      const p = it.path as unknown
      if (p && typeof p === 'object') it.path = geoJSONPath(p) ?? undefined
    }
  }

  return {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    clip: mark.clip === true,
    items,
  }
}

/** Detect facet orientation from the compiled chart's domain datasets. */
function getFacetOrientation(ctx: EvalContext): 'row' | 'column' | null {
  let hasRow = false, hasCol = false
  for (const d of ctx.chart.data) {
    if (d.name === 'row_domain') hasRow = true
    else if (d.name === 'column_domain') hasCol = true
  }
  if (hasCol && !hasRow) return 'column'
  if (hasRow && !hasCol) return 'row'
  return null
}

/** A concat group mark: a cell with nested marks + axes, no facet, no title. */
function isConcatGroupMark(mark: CompiledMark): boolean {
  const m = mark as CompiledMark & { marks?: unknown[]; axes?: unknown[]; title?: unknown }
  // A (v/h)concat cell has nested marks+axes but NO scales/data of its own —
  // concat cells share the top-level scales. A group declaring its own scales
  // is a scoped group (nested scope), not a concat cell.
  return mark.type === 'group'
    && !(mark.from as any)?.facet
    && !(m as any).scales?.length
    && !(m as any).data?.length
    && Array.isArray(m.marks) && (m.marks as unknown[]).length > 0
    && Array.isArray(m.axes) && (m.axes as unknown[]).length > 0
    && m.title == null
}

/** Whether the chart is a (v/h)concat spec. */
function isConcatSpec(chart: CompiledChart): boolean {
  return chart.marks.some(m => isConcatGroupMark(m))
}

/** Group mark dispatch */
function buildGroupMark(mark: CompiledMark, ctx: EvalContext): SceneGroup | SceneGroup[] | null {
  const facetRaw = (mark as any).from?.facet
  if (facetRaw && facetRaw.groupby && facetRaw.groupby.length) {
    return buildFacetCellGroup(mark, facetRaw, ctx)
  }
  if (isConcatGroupMark(mark)) {
    return buildConcatGroup(mark, ctx)
  }
  const orient = getFacetOrientation(ctx)
  const tm = mark as CompiledMark & { title?: unknown; marks?: unknown[] }
  // Title groups (no from, no nested marks)
  if (tm.title && !mark.from && !(tm.marks?.length)) {
    if (mark.name === 'column-title' || mark.role === 'column-title') {
      return buildColumnTitleGroup(mark, ctx)
    }
    return buildRowTitleGroup(mark, ctx)
  }
  const name = mark.name
  // Header groups
  if (name && name.includes('header')) {
    if (name === 'row_header') {
      if (orient === 'column') return buildColumnFacetRowHeader(mark, ctx)
      return buildRowHeaderGroup(mark, ctx)
    }
    if (name === 'column_header') {
      if (orient === 'column' || isTrellis(ctx)) return buildColumnHeaderGroup(mark, ctx)
      return buildRowHeaderGroup(mark, ctx)
    }
    return buildRowHeaderGroup(mark, ctx)
  }
  // Footer groups
  if (name && name.includes('footer')) {
    if (name === 'column_footer') {
      if (orient === 'column' || isTrellis(ctx)) return buildColumnFooterGroupColumn(mark, ctx)
      return buildColumnFooterGroup(mark, ctx)
    }
    return buildColumnFooterGroup(mark, ctx)
  }
  // Unnamed container groups (e.g. nested scope within facet cells for
  // VL-compiled bar/area charts): build a simple group whose items are
  // the rendered inner marks.
  if (tm.marks?.length) {
    // A group that declares its own scales/axes/data needs an isolated child
    // scope: scales resolve against the group's width/height, and nested axes/
    // marks resolve scale references within the child. Groups without local
    // scales just render children in the parent scope.
    const hasLocalScope = !!((mark as any).scales?.length || (mark as any).axes?.length || (mark as any).data?.length)
    if (hasLocalScope) return buildScopedGroup(mark, ctx)
    const items: SceneItem[] = []
    for (const cm of tm.marks) {
      const r = evaluateMark(cm as CompiledMark, ctx)
      if (r) {
        if (Array.isArray(r)) { for (const g of r) items.push(g) }
        else items.push(r)
      }
    }
    // Vega auto-clips groups that have cornerRadius: extract the value from
    // the group encode and, when >0, emit a rounded-rect clip path matching
    // the group's plot-area dimensions.
    const grEnc = (mark as any).encode?.update
    const grCR = grEnc?.cornerRadius
    const grpCR = grCR && typeof grCR === 'object' && 'value' in grCR
      ? (grCR as { value: number }).value
      : (typeof grCR === 'number' ? grCR : 0)
    const grpClip = mark.clip === true || grpCR > 0
    const grpClipD = grpCR > 0
      ? roundedRectPath(0, 0, ctx.width, ctx.height, Math.min(grpCR, ctx.width / 2, ctx.height / 2))
      : undefined
    return { marktype: 'group', name, role: (mark.role as string) ?? 'scope', items, clip: grpClip, ...(grpClipD ? { clipPathD: grpClipD } : {}) }
  }
  throw new Error('[aster] unsupported group mark: ' + (name ?? '<unnamed>'))
}

/**
 * Build a group mark that owns its scope: its own scales (resolved against the
 * group's width/height), nested axes, and nested marks, while sharing the
 * parent's datasets and expression runtime. Vega evaluates a group as a nested
 * dataflow scope; here we build the child maps and render into them.
 */
function buildScopedGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup | null {
  const grEnc = (mark.encode?.update ?? {}) as Record<string, EncodeValue>
  // Resolve the group's own geometry against the PARENT scope (its x/y/width/
  // height may reference top-level signals like `groupW`).
  const geo = resolveEncodeSet(grEnc, {}, ctx, 'group')
  const gw = typeof geo.width === 'number' ? geo.width : ctx.width
  const gh = typeof geo.height === 'number' ? geo.height : ctx.height

  const childScaleMap = new Map<string, Scale>()
  const childTypeMap = new Map<string, string>()
  for (const s of (mark as any).scales ?? []) {
    const cs = s as CompiledScale
    // Vega's scale signal refs (`width`/`height`) resolve against the TOP-LEVEL
    // chart scope (parent), not the group's own encode dimensions. That's why a
    // nested group's y-axis domain spans 300 even though the group is 130 tall.
    const scale = buildScale(cs, {
      width: ctx.width,
      height: ctx.height,
      signals: ctx.signalParams,
      evaluate: (expr) => ctx.runtime.expr(expr)({}, ctx.signalParams),
      dataField: (dn, field) => {
        const rows = ctx.datasets.get(dn) ?? []
        const out: unknown[] = []
        for (const r of rows) out.push(getField(r, field))
        return out
      },
      dataRows: (dn) => (ctx.datasets.get(dn) ?? []) as Record<string, unknown>[],
    })
    childScaleMap.set(cs.name, scale)
    childTypeMap.set(cs.name, cs.type)
  }

  const child: EvalContext = {
    ...ctx,
    width: gw,
    height: gh,
    scales: childScaleMap,
    scaleTypes: childTypeMap,
  }

  const items: SceneItem[] = []
  // Vega draws the group background rect first (fill = view/cell default, or the
  // encode's fill; stroke/cornerRadius from the encode).
  {
    const stroke = geo.stroke as string | undefined
    const fill = geo.fill as string | undefined
    const cr = (geo.cornerRadius as number | undefined) ?? 0
    // Vega insets the group background by half a pixel (0.5) like the frame.
    const bgPath = cr > 0
      ? roundedRectPath(0.5, 0.5, gw, gh, Math.min(cr, gw / 2, gh / 2))
      : `M0.5,0.5h${gw}v${gh}h-${gw}Z`
    const sw = geo.strokeWidth as number | undefined
    items.push({ path: bgPath, x: 0, y: 0, ...(fill ? { fill } : {}), ...(stroke ? { stroke, ...(sw != null ? { strokeWidth: sw } : {}) } : {}) } as SceneItem)
  }

  for (const as of (mark as any).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as, child)
      if (a) items.push(a)
    }
  }
  for (const cm of (mark.marks ?? [])) {
    const r = evaluateMark(cm as CompiledMark, child)
    if (r) {
      if (Array.isArray(r)) { for (const g of r) items.push(g) }
      else items.push(r)
    }
  }

  const grpClip = mark.clip === true
  return {
    marktype: 'group',
    name: mark.name,
    role: (mark.role as string) ?? 'scope',
    x: typeof geo.x === 'number' ? geo.x : 0,
    y: typeof geo.y === 'number' ? geo.y : 0,
    width: gw,
    height: gh,
    items,
    clip: grpClip,
  }
}

function inlineGroupRows(rows: Row[], keys: string[]): Row[][] {
  if (!keys.length) return rows.length ? [rows] : []
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const key = keys.map((k) => String(r[k])).join('\u0000')
    let g = map.get(key)
    if (!g) map.set(key, (g = []))
    g.push(r)
  }
  return [...map.values()]
}

const ROW_SPACING = 29
const COLUMN_SPACING = 29

/**
 * Facet grid layout, mirroring vega's trellisLayout/gridLayout with
 * `align: all`, `bounds: full` and the vega-lite default layout padding (20).
 * Cell positions are a uniform grid: cell (row r, column c) sits at
 * (c * colAdvance, r * rowAdvance), where the advances account for the actual
 * content bounds of every cell (mark extents may stick out past the cell box).
 */
interface FacetGridLayout {
  cellWidth: number
  cellHeight: number
  colAdvance: number
  rowAdvance: number
  ncols: number
  nrows: number
  gridX1: number
  gridY1: number
  gridX2: number
  gridY2: number
}

const FACET_LAYOUT_PADDING = 20

/** Relative content bounds of a built facet cell (axes span the cell box). */
function cellContentBounds(cell: SceneGroup, cellW: number, cellH: number): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (bx1: number, by1: number, bx2: number, by2: number) => {
    x1 = Math.min(x1, bx1); y1 = Math.min(y1, by1)
    x2 = Math.max(x2, bx2); y2 = Math.max(y2, by2)
  }
  for (const item of cell.items ?? []) {
    const g = item as SceneGroup
    if (g.role === 'axis') {
      // Grid axes span the full cell; vega reports their extent as the cell box.
      add(0, 0, cellW, cellH)
      continue
    }
    if (g.marktype && g.marktype !== 'group' && Array.isArray(g.items)) {
      for (const p of g.items ?? []) {
        const it = p as SceneItem & { size?: number; strokeWidth?: number; x2?: number; y2?: number }
        const x = it.x ?? 0, y = it.y ?? 0
        if (g.marktype === 'symbol') {
          // vega symbol bounds: center ± (radius + 2 * strokeWidth)
          const size = it.size ?? 30
          const sw = it.strokeWidth ?? 2
          const half = Math.sqrt(size) / 2 + 2 * sw
          add(x - half, y - half, x + half, y + half)
        } else if (g.marktype === 'rect') {
          let w = it.width, h = it.height
          let x0 = x, y0 = y
          if (w == null && it.x2 != null) { w = Math.abs(it.x2 - x0); x0 = Math.min(x0, it.x2) }
          if (h == null && it.y2 != null) { h = Math.abs(it.y2 - y0); y0 = Math.min(y0, it.y2) }
          if (w != null && h != null) add(x0, y0, x0 + w, y0 + h)
        } else if (g.marktype === 'rule' || g.marktype === 'line') {
          add(x, y, it.x2 ?? x, it.y2 ?? y)
        } else if (g.marktype === 'text') {
          add(x, y, x, y)
        }
      }
    }
  }
  if (!Number.isFinite(x1)) return { x1: 0, y1: 0, x2: cellW, y2: cellH }
  return { x1, y1, x2, y2 }
}

/**
 * Compute the vega-compatible facet grid layout from the built cells.
 * `bounds` are each cell's content bounds; the group's 0.5px stroke expands
 * the union by 0.5 on every side, which is what vega feeds into gridLayout.
 */
function computeFacetGridLayout(
  cells: SceneGroup[],
  cellWidth: number,
  cellHeight: number,
  ncols: number,
  nrows: number,
): FacetGridLayout {
  const PAD = FACET_LAYOUT_PADDING
  const n = cells.length
  const bounds = cells.map((c) => cellContentBounds(c, cellWidth, cellHeight))
  const xOff = new Array<number>(n).fill(0)
  const yOff = new Array<number>(n).fill(0)
  let xMax = 0, yMax = 0
  for (let i = 0; i < n; i++) {
    const b = bounds[i]!
    // vega expands each cell's bounds by half the group stroke width (0.5) on
    // every side before feeding them into gridLayout.
    const bx1 = b.x1 - 0.5, by1 = b.y1 - 0.5, bx2 = b.x2 + 0.5, by2 = b.y2 + 0.5
    xOff[i] = PAD + Math.max(0, Math.ceil(-bx1))
    yOff[i] = PAD + Math.max(0, Math.ceil(-by1))
    xMax = Math.max(xMax, Math.ceil(bx2))
    yMax = Math.max(yMax, Math.ceil(by2))
  }
  // First column / first row start at the origin.
  for (let i = 0; i < n; i++) {
    if (i % ncols === 0) xOff[i] = 0
    if (i < ncols) yOff[i] = 0
  }
  // align: all — every non-first column/row shares one offset.
  let offX = 0
  for (let i = 0; i < n; i++) if (i % ncols !== 0) offX = Math.max(offX, xOff[i]!)
  for (let i = 0; i < n; i++) if (i % ncols !== 0) xOff[i] = offX + xMax
  let offY = 0
  for (let i = ncols; i < n; i++) offY = Math.max(offY, yOff[i]!)
  for (let i = ncols; i < n; i++) yOff[i] = offY + yMax
  const colAdvance = ncols > 1 ? offX + xMax : 0
  const rowAdvance = nrows > 1 ? offY + yMax : 0

  // Union bounds of the positioned grid (used to center titles).
  let gridX1 = Infinity, gridY1 = Infinity, gridX2 = -Infinity, gridY2 = -Infinity
  for (let i = 0; i < n; i++) {
    const b = bounds[i]!
    const bx1 = b.x1 - 0.5, by1 = b.y1 - 0.5, bx2 = b.x2 + 0.5, by2 = b.y2 + 0.5
    const cx = (i % ncols) * colAdvance
    const cy = Math.floor(i / ncols) * rowAdvance
    gridX1 = Math.min(gridX1, cx + bx1)
    gridY1 = Math.min(gridY1, cy + by1)
    gridX2 = Math.max(gridX2, cx + bx2)
    gridY2 = Math.max(gridY2, cy + by2)
  }

  return { cellWidth, cellHeight, colAdvance, rowAdvance, ncols, nrows, gridX1, gridY1, gridX2, gridY2 }
}

/**
 * Build the facet cells (unpositioned at 0,0) and compute the shared grid
 * layout. Cached on the context so every facet mark uses identical advances.
 */
function getFacetLayout(ctx: EvalContext, prebuilt?: SceneGroup[]): FacetGridLayout | null {
  if (ctx._facetLayout !== undefined) return ctx._facetLayout
  const cm = findCellMark(ctx)
  const facet = (cm?.from as any)?.facet as { name: string; data: string; groupby: string[] } | undefined
  if (!cm || !facet) { ctx._facetLayout = null; return null }
  const cells = prebuilt ?? buildFacetCells(cm, facet, ctx)
  const { width: cellWidth, height: cellHeight } = readCellSize(cm, ctx, 500, 500)
  const colDom = ctx.datasets.get('column_domain')
  const rowDom = ctx.datasets.get('row_domain')
  const ncols = colDom && colDom.length ? colDom.length : 1
  const nrows = rowDom && rowDom.length ? rowDom.length : 1
  const layout = computeFacetGridLayout(cells, cellWidth, cellHeight, ncols, nrows)
  ctx._facetLayout = layout
  return layout
}

/** Whether this chart is a wrapped 2D trellis (both row and column facets). */
function isTrellis(ctx: EvalContext): boolean {
  const cm = findCellMark(ctx)
  const gb = (cm?.from as any)?.facet?.groupby
  if (!Array.isArray(gb) || gb.length < 2) return false
  let hasRow = false, hasCol = false
  for (const d of ctx.chart.data) {
    if (d.name === 'row_domain') hasRow = true
    else if (d.name === 'column_domain') hasCol = true
  }
  return hasRow && hasCol
}

/**
 * Walk a scene subtree and find the first item with y and y2 set (a rect mark
 * item). Returns the absolute height |y2 - y|, or null if not found.
 */
function findBarHeight(items: SceneItem[]): number | null {
  for (const item of items) {
    const group = item as SceneGroup
    if ((group.marktype !== undefined || Array.isArray(group.items)) && group.items) {
      const h = findBarHeight(group.items)
      if (h != null) return h
    } else {
      const it = item as Record<string, unknown>
      if (it.y != null && it.y2 != null && typeof it.y === 'number' && typeof it.y2 === 'number') {
        return Math.abs(it.y2 - it.y)
      }
    }
  }
  return null
}

/**
 * Generate an SVG path for a rounded rectangle with corner radius r,
 * using cubic bezier approximation matching vega-scenegraph (k ≈ 0.5523).
 */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  // vega-scenegraph uses C = 0.448084975506 (from spencermortensen.com/articles/bezier-circle)
  // CP1 offset = r * (1 - C) (the larger offset, away from the corner)
  // CP2 offset = r * C (the smaller offset, closer to the end point)
  const c = 0.448084975506
  const kr1 = r * (1 - c) // CP1 offset (from start, toward end)
  const kr2 = r * c       // CP2 offset (from end, toward start)
  const fmt = (v: number) => {
    const n = Math.round(v * 1000) / 1000
    return String(n)
  }
  const x1 = x + r, y1 = y
  const x2 = x + w - r, y2 = y
  const x3 = x + w, y3 = y + r
  const x4 = x + w, y4 = y + h - r
  const x5 = x + w - r, y5 = y + h
  const x6 = x + r, y6 = y + h
  const x7 = x, y7 = y + h - r
  const x8 = x, y8 = y + r
  return `M${fmt(x1)},${fmt(y1)}L${fmt(x2)},${fmt(y2)}C${fmt(x2 + kr1)},${fmt(y2)},${fmt(x3)},${fmt(y3 - kr1)},${fmt(x3)},${fmt(y3)}`
    + `L${fmt(x4)},${fmt(y4)}C${fmt(x4)},${fmt(y4 + kr1)},${fmt(x5 + kr1)},${fmt(y5)},${fmt(x5)},${fmt(y5)}`
    + `L${fmt(x6)},${fmt(y6)}C${fmt(x6 - kr1)},${fmt(y6)},${fmt(x7)},${fmt(y7 + kr1)},${fmt(x7)},${fmt(y7)}`
    + `L${fmt(x8)},${fmt(y8)}C${fmt(x8)},${fmt(y8 - kr1)},${fmt(x1 - kr1)},${fmt(y1)},${fmt(x1)},${fmt(y1)}Z`
}

/**
 * Build the facet cell groups. In a 2D trellis the facet key is (row, column):
 * cells are arranged in a grid and each cell's data is its (r, c) slice.
 */
function buildFacetCells(
  mark: CompiledMark,
  facet: { name: string; data: string; groupby: string[] },
  ctx: EvalContext,
): SceneGroup[] {
  const rows = ctx.datasets.get(facet.data) ?? []
  let grouped = inlineGroupRows(rows, facet.groupby)
  if (!grouped.length) return []
  // A 2D facet lays cells out row-major; order groups by their facet keys so
  // the grid mapping is stable regardless of the data's insertion order.
  if (facet.groupby.length > 1) {
    grouped = grouped.slice().sort((a, b) => {
      for (const f of facet.groupby) {
        const av = String(a[0]?.[f] ?? '')
        const bv = String(b[0]?.[f] ?? '')
        if (av < bv) return -1
        if (av > bv) return 1
      }
      return 0
    })
  }

  const { width: cellWidth, height: cellHeight } = readCellSize(mark, ctx, 500, 500)
  const saved = ctx.datasets.get(facet.name)
  const result: SceneGroup[] = []

  for (const g of grouped) {
    if (!g.length) continue
    ctx.datasets.set(facet.name, g)

    const tmpCtx: EvalContext = { ...ctx, width: cellWidth, height: cellHeight }
    const nestedItems: SceneItem[] = []
    for (const cm of (mark as any).marks ?? []) {
      const ng = facetItemMark(cm, tmpCtx, facet.name)
      if (ng) nestedItems.push(ng)
    }

    const axisItems: SceneItem[] = []
    for (const as of (mark as any).axes ?? []) {
      if (isAxisSpec(as)) {
        const a = buildAxisInline(as, tmpCtx)
        if (a) axisItems.push(a)
      }
    }

    const cellItems: SceneItem[] = [...axisItems, ...nestedItems]
    // Each facet cell carries a background path the size of the cell, matching
    // vega's group background. Cells with the `cell` style (stroke #ddd, 0.5px
    // inset) are the spatial facet cells of facet/trellis charts; plain group
    // marks (e.g. vega-lite's faceted area `pathgroup`) render a bare full-size
    // path with no stroke.
    //
    // When the facet group has cornerRadius, vega renders the group background
    // as a rounded rect matching the bar's actual dimensions (y2-y height from
    // the encode), and the inner scope background as a zero-height path.
    const cellStyle = Array.isArray(mark.style) ? mark.style.includes('cell') : mark.style === 'cell'
    // Extract cornerRadius from the group's encode
    const grEnc = (mark as any).encode?.update
    const grCR = grEnc?.cornerRadius
    const cellCornerRadius = grCR && typeof grCR === 'object' && 'value' in grCR
      ? (grCR as { value: number }).value
      : (typeof grCR === 'number' ? grCR : 0)
    // Compute the actual bar height from the nested rect items
    const barH = findBarHeight(nestedItems)
    const bgH = barH ?? cellHeight
    if (cellCornerRadius > 0 && barH != null) {
      // Vega renders the group background as a rounded rect with cornerRadius
      const cr = Math.min(cellCornerRadius, cellWidth / 2, bgH / 2)
      const bgPath = roundedRectPath(0, 0, cellWidth, bgH, cr)
      cellItems.push({ path: bgPath, x: 0, y: 0 } as SceneItem)
      // Inner scope background: zero-height path (vega default for groups
      // without explicit height)
      cellItems.push({
        path: `M0,0h${cellWidth}v0h-${cellWidth}Z`,
        x: 0, y: 0,
      } as SceneItem)
    } else if (cellStyle) {
      cellItems.push({
        path: `M0.5,0.5h${cellWidth}v${cellHeight}h-${cellWidth}Z`,
        x: 0, y: 0, stroke: '#ddd',
      } as SceneItem)
    } else {
      // Check if the group mark has explicit width/height signals in its
      // encode. VL-compiled facet cells always do (either {signal:...} or
      // {field:{group:...}}); raw Vega facet cells (from.from.facet without
      // encode signals) don't, in which case Vega renders a zero-height
      // scope background that is degenerate after canonicalization.
      const grEnc = (mark as any).encode?.update
      const hasExplicitSize = grEnc && (
        (grEnc.width && typeof grEnc.width === 'object' && ('signal' in grEnc.width || ('field' in grEnc.width && typeof grEnc.width.field === 'object'))) ||
        (grEnc.height && typeof grEnc.height === 'object' && ('signal' in grEnc.height || ('field' in grEnc.height && typeof grEnc.height.field === 'object')))
      )
      if (hasExplicitSize) {
        cellItems.push({
          path: `M0,0h${cellWidth}v${cellHeight}h-${cellWidth}Z`,
          x: 0, y: 0,
        } as SceneItem)
      } else {
        cellItems.push({
          path: `M0,0h0v0h0Z`,
          x: 0, y: 0,
        } as SceneItem)
      }
    }

    result.push({
      marktype: 'group', name: mark.name, role: 'scope',
      items: cellItems,
      clip: mark.clip === true || cellCornerRadius > 0,
      width: cellWidth, height: cellHeight,
      x: 0, y: 0,
      ...(cellCornerRadius > 0 && barH != null ? { clipPathD: roundedRectPath(0, 0, cellWidth, bgH, Math.min(cellCornerRadius, cellWidth / 2, bgH / 2)) } : {}),
    })
  }

  if (saved !== undefined) ctx.datasets.set(facet.name, saved)
  else ctx.datasets.delete(facet.name)
  return result
}

function buildFacetCellGroup(
  mark: CompiledMark,
  facet: { name: string; data: string; groupby: string[] },
  ctx: EvalContext,
): SceneGroup[] {
  const cells = buildFacetCells(mark, facet, ctx)
  if (!cells.length) return cells
  // When the facet group has a scale-based x encode (e.g. VL bar charts with
  // cornerRadius compile to a faceted group where each cell is positioned at
  // the band scale position), resolve each cell's x from the scale rather
  // than using the grid layout.
  const xEnc = (mark as any).encode?.update?.x
  if (xEnc && typeof xEnc === 'object' && 'scale' in xEnc && 'field' in xEnc) {
    const xScale = ctx.scales.get(xEnc.scale as string)
    const fieldName = xEnc.field as string
    if (xScale) {
      const rows = ctx.datasets.get(facet.data) ?? []
      const grouped = inlineGroupRows(rows, facet.groupby)
      for (let i = 0; i < cells.length; i++) {
        const g = grouped[i]
        if (g && g.length > 0) {
          const catVal = g[0]?.[fieldName]
          const pos = xScale(catVal as string | number)
          if (typeof pos === 'number' && Number.isFinite(pos) && cells[i]) {
            cells[i]!.x = pos
          }
        }
      }
      return cells
    }
  }
  const layout = getFacetLayout(ctx, cells)
  if (!layout) return cells
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    cell.x = (i % layout.ncols) * layout.colAdvance
    cell.y = Math.floor(i / layout.ncols) * layout.rowAdvance
  }
  return cells
}

function buildRowHeaderGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const rows = ctx.datasets.get(mark.from!.data!) ?? []
  if (!rows.length) return []

  let cellHeight = 500
  const enc = mark.encode?.update
  if (enc?.height) {
    const hs = (enc.height as { signal?: string } | undefined)?.signal
    if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
      cellHeight = Number(ctx.signalParams[hs])
  }
  const grpW = 50

  const cellMark = findCellMark(ctx)
  const groupby = cellMark ? (cellMark.from as any)?.facet?.groupby : null
  const firstGroupby = groupby?.[0]

  let sortedRows: Row[] | undefined
  if (mark.sort?.field) {
    try {
      const expr = ctx.runtime.expr(mark.sort.field as string)
      sortedRows = rows.slice().sort((a, b) => {
        const cmp = expr({ _aster_a: firstGroupby ? (a as Record<string, unknown>)[firstGroupby] : undefined, _aster_b: firstGroupby ? (b as Record<string, unknown>)[firstGroupby] : undefined }, ctx.signalParams) as number
        return Number(cmp ?? 0)
      })
    } catch {}
  }

  const result: SceneGroup[] = []
  const src = sortedRows ?? rows
  // In a trellis the vertical advance between row headers comes from the grid
  // layout; single facets fall back to the fixed spacing.
  const layout = getFacetLayout(ctx)
  const rowAdvance = layout ? layout.rowAdvance : cellHeight + ROW_SPACING
  for (let i = 0; i < src.length; i++) {
    const row = src[i]
    if (!row) continue

    const tmpCtx: EvalContext = { ...ctx, width: grpW, height: cellHeight }
    const axisItems: SceneItem[] = []
    for (const as of (mark as any).axes ?? []) {
      if (isAxisSpec(as)) {
        const a = buildAxisInline(as, tmpCtx)
        if (a) axisItems.push(a)
      }
    }

    const labelVal = firstGroupby ? String((row as Record<string, unknown>)[firstGroupby]) : String(row)

    result.push({
      marktype: 'group', name: mark.name, role: 'row-header',
      items: [{
        // Vega's row-header group has a zero-width, full-height background
        // path (M0,0h0vHh0Z) — degenerate but non-zero, so it survives
        // canonicalization and contributes a `path|...` record.
        path: `M0,0h0v${cellHeight}h0Z`, x: 0, y: 0,
      } as SceneItem, ...axisItems, {
        text: labelVal, x: -50, y: cellHeight / 2,
        angle: -90, align: 'center' as const, baseline: 'middle' as const, fill: '#000',
      }],
      width: grpW, x: -1, y: i * rowAdvance,
    })
  }
  return result
}

function buildColumnFooterGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup | null {
  const cm = findCellMark(ctx)
  if (!cm) return null
  const facet = (cm.from as any)?.facet as { data: string; groupby: string[] } | undefined
  if (!facet) return null

  const rows = ctx.datasets.get(facet.data) ?? []
  const fkey: string = facet.groupby[0]!
  const n = rows.length ? new Set(rows.map((r: Row) => String(r[fkey]))).size : 1

  let cellWidth = ctx.width, cellHeight = 500
  const enc = cm.encode?.update ?? {}
  // If height not in encode (col_footer doesn't have it), read from signalParams
  if (enc?.height === undefined || !enc.height) {
    if (ctx.signalParams["child_height"] !== undefined && !Array.isArray(ctx.signalParams["child_height"]))
      cellHeight = Number(ctx.signalParams["child_height"])
  }
  if (enc?.width) {
    const ws = (enc.width as { signal?: string } | undefined)?.signal
    if (ws !== undefined && ctx.signalParams[ws] !== undefined && !Array.isArray(ctx.signalParams[ws]))
      cellWidth = Number(ctx.signalParams[ws])
  }
  if (enc?.height) {
    const hs = (enc.height as { signal?: string } | undefined)?.signal
    if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
      cellHeight = Number(ctx.signalParams[hs])
  }

  // Vega positions the column-footer group immediately below the last cell
  // (y = (n-1)*step + cellHeight + 1) with zero height, so the bottom axis
  // inside it is laid out at y=0. We build the axis with height=0 to match.
  const layout = getFacetLayout(ctx)
  const rowAdvance = layout ? layout.rowAdvance : cellHeight + ROW_SPACING
  const footerY = (n - 1) * rowAdvance + cellHeight + 1

  const tmpCtx: EvalContext = { ...ctx, width: cellWidth, height: 0 }
  const axisItems: SceneItem[] = []
  for (const as of (mark as any).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as, tmpCtx)
      if (a) axisItems.push(a)
    }
  }

  return {
    marktype: 'group', name: mark.name, role: 'column-footer',
    items: [{
      // Vega's column-footer group has a zero-height, full-width background
      // path (M0,0hWv0h-WZ) — degenerate but non-zero width, surviving
      // canonicalization as a `path|...` record.
      path: `M0,0h${cellWidth}v0h-${cellWidth}Z`, x: 0, y: 0,
    } as SceneItem, ...axisItems],
    x: 0, y: footerY,
  }
}

function buildRowTitleGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup | null {
  const cm = findCellMark(ctx)
  if (!cm) return null

  const layout = getFacetLayout(ctx)
  let centerY: number
  if (layout) {
    // Vega centers the row title at the vertical midpoint of the grid bounds.
    centerY = Math.round(layout.gridY1 + 0.5 * (layout.gridY2 - layout.gridY1))
  } else {
    const facet = (cm.from as any)?.facet as { data: string; groupby: string[] } | undefined
    let cellHeight = 500, n = 1
    if (facet) {
      const rows = ctx.datasets.get(facet.data) ?? []
      const fkey: string = facet.groupby[0]!
      n = rows.length ? new Set(rows.map((r: Row) => String(r[fkey]))).size : 1
    }
    if (cm.encode?.update?.height) {
      const hs = (cm.encode.update.height as { signal?: string } | undefined)?.signal
      if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
        cellHeight = Number(ctx.signalParams[hs])
    }
    centerY = Math.round(((n - 1) * (ROW_SPACING + cellHeight) + cellHeight) / 2)
  }

  const tm = mark as any
  let titleText = 'Label'
  const tSpec = tm.title?.text
  if (typeof tSpec === 'string') {
    titleText = tSpec
  } else if (tSpec && typeof tSpec === 'object' && 'signal' in tSpec && typeof (tSpec as { signal: string }).signal === 'string') {
    try { titleText = String(ctx.runtime.expr((tSpec as { signal: string }).signal)({}, ctx.signalParams)) } catch {}
  } else if (tSpec && typeof tSpec === 'object' && 'value' in tSpec) {
    titleText = String((tSpec as { value: unknown }).value)
  }

  const pad = ctx.chart.padding
  return {
    marktype: 'group', name: mark.name, role: 'row-title',
    items: [
        { text: titleText, x: -21, y: 0, angle: -90, align: 'center' as const, baseline: 'middle' as const, fill: '#000' },
      ],
    x: -61, y: centerY,
  }
}

// ===========================================================================
// Column-facet support
// ===========================================================================

/** Read the cellWidth/cellHeight from a group mark's encode (signal-based). */
function readCellSize(mark: CompiledMark, ctx: EvalContext, defW: number, defH: number): { width: number; height: number } {
  let width = defW, height = defH
  const enc = mark.encode?.update
  if (enc) {
    const ws = (enc.width as { signal?: string } | undefined)?.signal
    const hs = (enc.height as { signal?: string } | undefined)?.signal
    if (ws !== undefined && ctx.signalParams[ws] !== undefined && !Array.isArray(ctx.signalParams[ws]))
      width = Number(ctx.signalParams[ws])
    else if (ws !== undefined)
      // Signal expression (e.g. "max(0.25, bandwidth('x'))") — evaluate it
      try {
        const v = ctx.runtime.expr(ws)({}, ctx.signalParams)
        if (typeof v === 'number' && Number.isFinite(v)) width = v
      } catch { /* fall through to default */ }
    if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
      height = Number(ctx.signalParams[hs])
    else if (hs !== undefined)
      try {
        const v = ctx.runtime.expr(hs)({}, ctx.signalParams)
        if (typeof v === 'number' && Number.isFinite(v)) height = v
      } catch { /* fall through to default */ }
    // vega-lite emits `{field: {group: "width"}}` / `{field: {group: "height"}}`
    // for group marks that take their size from the enclosing group (e.g. the
    // faceted `pathgroup` around stacked areas). Resolve those to the enclosing
    // group's dimensions.
    const wg = (enc.width as { field?: { group?: string } } | undefined)?.field?.group
    const hg = (enc.height as { field?: { group?: string } } | undefined)?.field?.group
    if (wg === 'width') width = ctx.width
    if (hg === 'height') height = ctx.height
  }
  return { width, height }
}

/** Column-facet: shared y-axis on the left, a single group spanning all rows. */
function buildColumnFacetRowHeader(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const { height: cellHeight } = readCellSize(mark, ctx, 500, 500)
  const tmpCtx: EvalContext = { ...ctx, width: 0, height: cellHeight }
  const items: SceneItem[] = []
  for (const as of (mark as any).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as, tmpCtx)
      if (a) items.push(a)
    }
  }
  // row_header background: zero-width, full-height path (M0,0h0vHh0Z), matching
  // vega's degenerate-but-non-zero group background (survives canonicalization).
  items.push({ path: `M0,0h0v${cellHeight}h0Z`, x: 0, y: 0 } as SceneItem)
  return [{
    marktype: 'group', name: mark.name, role: 'row-header',
    items,
    x: -1, y: 0, width: 0, height: cellHeight,
  }]
}

/** Column-facet: per-column header labels at the top (one group per column value). */
function buildColumnHeaderGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const cm = findCellMark(ctx)
  const facet = (cm?.from as any)?.facet as { data: string; groupby: string[] } | undefined
  if (!facet) return []
  const { width: cellWidth } = readCellSize(cm!, ctx, 100, 100)
  const rows = ctx.datasets.get(mark.from!.data!) ?? []
  if (!rows.length) return []

  // The column field is the last facet key ('c' in a row×column trellis).
  const fkey: string = facet.groupby[facet.groupby.length - 1]!
  const orient = getFacetOrientation(ctx)
  const layout = getFacetLayout(ctx)
  const step = layout ? layout.colAdvance : cellWidth + (orient === 'column' ? COLUMN_SPACING : ROW_SPACING)

  let sortedRows: Row[] = rows
  if (mark.sort?.field) {
    try {
      const expr = ctx.runtime.expr(mark.sort.field as string)
      sortedRows = rows.slice().sort((a, b) => {
        const cmp = expr({ _aster_a: (a as Record<string, unknown>)[fkey], _aster_b: (b as Record<string, unknown>)[fkey] }, ctx.signalParams) as number
        return Number(cmp ?? 0)
      })
    } catch {}
  }

  const result: SceneGroup[] = []
  sortedRows.forEach((row, i) => {
    const labelVal = String((row as Record<string, unknown>)[fkey])
    const cellX = i * step
    result.push({
      marktype: 'group', name: mark.name, role: 'column-header',
      items: [
        { text: labelVal, x: cellWidth / 2, y: -12, align: 'center' as const, fill: '#000' },
        // column-header background: zero-height, full-width path (M0,0hWv0h-WZ).
        { path: `M0,0h${cellWidth}v0h-${cellWidth}Z`, x: 0, y: 0 } as SceneItem,
      ],
      x: cellX, y: -8, width: cellWidth, height: 0,
    })
  })
  return result
}

/** Column-facet: per-column x-axis at the bottom (one group per column value). */
function buildColumnFooterGroupColumn(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const cm = findCellMark(ctx)
  const facet = (cm?.from as any)?.facet as { data: string; groupby: string[] } | undefined
  if (!facet) return []
  const { width: cellWidth, height: cellHeight } = readCellSize(cm!, ctx, 100, 100)
  const rows = ctx.datasets.get(mark.from!.data!) ?? []
  if (!rows.length) return []

  const fkey: string = facet.groupby[facet.groupby.length - 1]!
  const orient = getFacetOrientation(ctx)
  const layout = getFacetLayout(ctx)
  const step = layout ? layout.colAdvance : cellWidth + (orient === 'column' ? COLUMN_SPACING : ROW_SPACING)
  // Footer sits below the last row of cells: (nrows-1) advances + cell height + 1.
  const footerY = layout
    ? (layout.nrows - 1) * layout.rowAdvance + cellHeight + 1
    : cellHeight + 1

  let sortedRows: Row[] = rows
  if (mark.sort?.field) {
    try {
      const expr = ctx.runtime.expr(mark.sort.field as string)
      sortedRows = rows.slice().sort((a, b) => {
        const cmp = expr({ _aster_a: (a as Record<string, unknown>)[fkey], _aster_b: (b as Record<string, unknown>)[fkey] }, ctx.signalParams) as number
        return Number(cmp ?? 0)
      })
    } catch {}
  }

  const result: SceneGroup[] = []
  sortedRows.forEach((row, i) => {
    const cellX = i * step
    // Axis sits at the TOP of the footer group, so ctx.height = 0.
    const tmpCtx: EvalContext = { ...ctx, width: cellWidth, height: 0 }
    const items: SceneItem[] = []
    for (const as of (mark as any).axes ?? []) {
      if (isAxisSpec(as)) {
        const a = buildAxisInline(as, tmpCtx)
        if (a) items.push(a)
      }
    }
    // column-footer background: zero-height, full-width path (M0,0hWv0h-WZ).
    items.push({ path: `M0,0h${cellWidth}v0h-${cellWidth}Z`, x: 0, y: 0 } as SceneItem)
    result.push({
      marktype: 'group', name: mark.name, role: 'column-footer',
      items,
      x: cellX, y: footerY, width: cellWidth, height: 0,
    })
  })
  return result
}

/** Compute the x bounds of mark items within built facet cells (for centering titles). */
function cellGroupXBounds(cells: SceneGroup[]): { minX: number; maxX: number } {
  let minX = Infinity, maxX = -Infinity
  for (const cell of cells) {
    const cx = cell.x ?? 0
    const cw = cell.width ?? 0
    if (Number.isFinite(cx)) minX = Math.min(minX, cx)
    if (Number.isFinite(cx + cw)) maxX = Math.max(maxX, cx + cw)
    for (const item of cell.items ?? []) {
      const g = item as SceneGroup
      // Only leaf mark groups (symbol/rect/etc.), not axis 'group' groups.
      if (g.marktype && g.marktype !== 'group' && Array.isArray(g.items)) {
        for (const p of g.items ?? []) {
          const pi = p as SceneItem & { size?: number; strokeWidth?: number; width?: number }
          const px = cx + (pi.x ?? 0)
          if (g.marktype === 'symbol') {
            const size = pi.size ?? 30
            const sw = pi.strokeWidth ?? 2
            const r = Math.sqrt(size) / 2
            const ext = r + 2 * sw
            minX = Math.min(minX, px - ext)
            maxX = Math.max(maxX, px + ext)
          } else {
            const w = pi.width ?? 0
            minX = Math.min(minX, px)
            maxX = Math.max(maxX, px + w)
          }
        }
      }
    }
  }
  if (!Number.isFinite(minX)) minX = 0
  if (!Number.isFinite(maxX)) maxX = 0
  return { minX, maxX }
}

/** Column-facet: horizontal title centered above the columns. */
function buildColumnTitleGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup | null {
  const cellMark = findCellMark(ctx)
  const layout = getFacetLayout(ctx)
  let centerX: number
  if (layout) {
    // Vega centers the column title at the horizontal midpoint of the grid bounds.
    centerX = Math.round(layout.gridX1 + 0.5 * (layout.gridX2 - layout.gridX1))
  } else if (cellMark) {
    const cells = buildFacetCellGroup(cellMark, (cellMark.from as any).facet, ctx)
    const { minX, maxX } = cellGroupXBounds(cells)
    centerX = Math.round((minX + maxX) / 2)
  } else {
    centerX = 0
  }

  const tm = mark as any
  let titleText = 'Label'
  const tSpec = tm.title?.text
  if (typeof tSpec === 'string') {
    titleText = tSpec
  } else if (tSpec && typeof tSpec === 'object' && 'signal' in tSpec && typeof (tSpec as { signal: string }).signal === 'string') {
    try { titleText = String(ctx.runtime.expr((tSpec as { signal: string }).signal)({}, ctx.signalParams)) } catch {}
  } else if (tSpec && typeof tSpec === 'object' && 'value' in tSpec) {
    titleText = String((tSpec as { value: unknown }).value)
  }

  return {
    marktype: 'group', name: mark.name, role: 'column-title',
    items: [
      { text: titleText, x: 0, y: -12, align: 'center' as const, fill: '#000' },
    ],
    x: centerX, y: -38,
  }
}

// ===========================================================================
// Trellis layout (exact port of vega's ViewLayout/trellisLayout)
// ===========================================================================

/** vega-lite's facet header/title offset (`layout.offset.{rowTitle,columnTitle}`). */
const FACET_TITLE_OFFSET = 10
/** Guide-label font size (vega config style 'guide-label'). */
const GUIDE_LABEL_FONT_SIZE = 10

/**
 * Run the exact trellis layout over the built facet items:
 * 1. Position row-header facet labels with vega's header titleLayout law
 *    (x = viewBounds.x1 - titleWidth - offset, y = header height / 2), where
 *    viewBounds is the header content bounds excluding the label itself.
 * 2. Run the ported grid + header + title layout (trellisLayout), which
 *    positions cells, headers, footers and titles from measured bounds.
 */
function applyTrellisLayout(items: SceneGroup[], ctx: EvalContext): void {
  // Vega's facet cells start at (0,0); gridLayout then derives their offsets
  // as (target − current). Our builders pre-position cells, which would
  // collapse the deltas — reset to the origin first.
  for (const g of items) {
    if (g.role === 'scope' || g.role === 'mark') {
      g.x = 0
      g.y = 0
    }
  }
  for (const g of items) {
    if (g.role === 'row-header') positionRowHeaderLabel(g, ctx)
    else if (g.role === 'column-header') positionColumnHeaderLabel(g)
  }
  trellisLayout({ marktype: 'group', items } as unknown as SceneGroup, resolveTrellisOpt(ctx))
}

/** Resolve the root layout options (vega-lite facet defaults + spec layout). */
function resolveTrellisOpt(ctx: EvalContext): Record<string, unknown> {
  const layout = (ctx.chart.layout ?? {}) as Record<string, unknown>
  const opt: Record<string, unknown> = { ...layout }
  let columns = opt.columns
  if (columns && typeof columns === 'object' && 'signal' in (columns as Record<string, unknown>)) {
    try {
      const v = ctx.runtime.expr(String((columns as { signal: string }).signal))({}, ctx.signalParams)
      columns = typeof v === 'number' ? v : undefined
    } catch {
      columns = undefined
    }
  }
  if (typeof columns !== 'number' || !(columns > 0)) {
    const colDom = ctx.datasets.get('column_domain')
    columns = colDom && colDom.length ? colDom.length : 1
  }
  opt.columns = columns
  // Vega-lite facet layout defaults (mirrors the compiled facet layout spec).
  if (opt.padding == null) opt.padding = 20
  if (opt.bounds == null) opt.bounds = 'full'
  if (opt.align == null) opt.align = 'all'
  if (opt.offset == null) opt.offset = { rowTitle: 10, columnTitle: 10 }
  return opt
}

function isLeafItem(it: SceneItem): boolean {
  return (it as SceneGroup).marktype === undefined && !Array.isArray((it as SceneGroup).items)
}

/**
 * Row-header facet label (vega: the header scope's own titleLayout with
 * orient left, frame group): the label anchors at
 *   x = viewBounds.x1 - titleWidth - offset,  y = header height / 2
 * with align center, baseline top, rotated -90. viewBounds is the header's
 * content bounds (base rect + axis content) *excluding* the label.
 */
function positionRowHeaderLabel(header: SceneGroup, ctx: EvalContext): void {
  const items = header.items ?? []
  let label: SceneItem | null = null
  for (const it of items) {
    if (!isLeafItem(it as SceneItem)) continue
    if ((it as SceneItem).text != null) label = it as SceneItem
  }
  if (!label) return
  const b = new Bounds()
  for (const it of items) {
    if (it === label) continue
    const child = it as SceneGroup
    const bb = boundLeaf(new Bounds(), it as SceneItem)
    if ((child as SceneGroup).role === 'axis') {
      // vega measures axis marks in the axis-internal frame; our scene bakes
      // the 0.5px axis delta into the leaves — shift it back out
      bb.translate(-0.5, -0.5)
    }
    b.union(bb)
  }
  if (header.width || header.height) b.add(0, 0).add(header.width || 0, header.height || 0)
  boundStrokeGroupBounds(b, header)
  const x1 = b.empty() ? 0 : Math.min(0, b.x1)
  label.x = x1 - GUIDE_LABEL_FONT_SIZE - FACET_TITLE_OFFSET
  // vega anchors the label at the vertical midpoint of the header scope
  let h = header.height
  if (h == null) {
    const cm = findCellMark(ctx)
    h = readCellSize(cm!, ctx, 500, 500).height
  }
  label.y = h / 2
  label.baseline = 'top'
  ;(label as Record<string, unknown>).fontSize = GUIDE_LABEL_FONT_SIZE
}

/**
 * Column-header facet label (orient top, frame group): x = width / 2,
 * y = viewBounds.y1 - titleHeight - offset. Our column-header label renders
 * at the equivalent alphabetic-baseline position; only the font size
 * (guide-label 10px) must match vega for exact bounds.
 */
function positionColumnHeaderLabel(header: SceneGroup): void {
  const items = header.items ?? []
  let label: SceneItem | null = null
  for (const it of items) {
    if (!isLeafItem(it as SceneItem)) continue
    if ((it as SceneItem).text != null) label = it as SceneItem
  }
  if (!label) return
  ;(label as Record<string, unknown>).fontSize = GUIDE_LABEL_FONT_SIZE
}

/** Group-node stroke expansion (vega's boundStroke on the group item). */
function boundStrokeGroupBounds(b: Bounds, group: SceneGroup): void {
  const g = group as unknown as SceneItem
  const rec = g as Record<string, unknown>
  if (g.stroke && g.opacity !== 0 && g.strokeOpacity !== 0) {
    const sw = g.strokeWidth != null ? +g.strokeWidth : 1
    b.expand((rec.strokeCap === 'square' ? Math.SQRT2 : 1) * sw / 2)
  }
}

// ===========================================================================
// Concat support (horizontal, vertical, and 2D repeat grids)
// ===========================================================================

const CONCAT_BASE_SPACING = 29
const TITLE_FONT_SIZE = 11
/** Vega-lite emits `layout: {padding: 20, ...}` for repeat grids (scatter matrix). */
const CONCAT_GRID_PADDING = 20

interface ConcatGridState {
  ncols: number
  colAdvance: number
  rowAdvance: number
  /** All concat cells built once and positioned in the grid, keyed by mark name. */
  cells: Map<string, SceneGroup>
}

/** Whether this chart is a 2D repeat concat (both childWidth and childHeight signals present). */
function is2DRepeatConcat(ctx: EvalContext): boolean {
  return ctx.signalParams['childWidth'] !== undefined && ctx.signalParams['childHeight'] !== undefined
}

/** Parse a vega-lite repeat cell name `child__row_<r>column_<c>_group`. */
function repeatCellRC(name: string): { row: string; col: string } | null {
  const m = /^child__row_(.+)column_(.+)_group$/.exec(name)
  return m ? { row: m[1]!, col: m[2]! } : null
}

/**
 * Compute the shared grid layout for a 2D repeat concat (scatter matrix) and
 * build all cells positioned in it. Cached on the context. Mirrors vega's
 * gridLayout with `align: all`, `bounds: full` and the vega-lite repeat layout
 * padding (20). Cells are laid out row-major: cell i sits at
 * ((i % ncols) * colAdvance, floor(i / ncols) * rowAdvance).
 */
function getConcatGridState(ctx: EvalContext): ConcatGridState | null {
  if (ctx._concatGrid !== undefined) return ctx._concatGrid
  ctx._concatGrid = null
  const marks = (ctx.chart.marks as CompiledMark[]).filter(m => isConcatGroupMark(m))
  if (!is2DRepeatConcat(ctx) || marks.length < 2) return null
  const rcs = marks.map(m => repeatCellRC(m.name ?? ''))
  if (rcs.some(r => !r)) return null
  const ncols = new Set(rcs.map(r => r!.col)).size
  if (ncols < 2) return null
  const { width: cw, height: ch } = readCellSize(marks[0]!, ctx, 500, 500)
  const cells = marks.map(m => buildConcatCellBody(m, ctx))
  const bounds = cells.map(c => concatCellLocalBounds(c, cw, ch))
  let offX = 0, xMax = 0, offY = 0, yMax = 0
  for (let i = 0; i < cells.length; i++) {
    const b = bounds[i]!
    if (i % ncols !== 0) offX = Math.max(offX, CONCAT_GRID_PADDING + Math.max(0, Math.ceil(-b.x1)))
    if (i >= ncols) offY = Math.max(offY, CONCAT_GRID_PADDING + Math.max(0, Math.ceil(-b.y1)))
    xMax = Math.max(xMax, Math.ceil(b.x2))
    yMax = Math.max(yMax, Math.ceil(b.y2))
  }
  const colAdvance = offX + xMax
  const rowAdvance = offY + yMax
  for (let i = 0; i < cells.length; i++) {
    cells[i]!.x = (i % ncols) * colAdvance
    cells[i]!.y = Math.floor(i / ncols) * rowAdvance
  }
  const byName = new Map<string, SceneGroup>()
  marks.forEach((m, i) => byName.set(m.name, cells[i]!))
  ctx._concatGrid = { ncols, colAdvance, rowAdvance, cells: byName }
  return ctx._concatGrid
}

/** Build a concat cell group with all its content but no layout position. */
function buildConcatCellBody(mark: CompiledMark, ctx: EvalContext): SceneGroup {
  const { width: cellWidth, height: cellHeight } = readCellSize(mark, ctx, 500, 500)
  const tmpCtx: EvalContext = { ...ctx, width: cellWidth, height: cellHeight }
  const axisItems: SceneItem[] = []
  for (const as of (mark as any).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as, tmpCtx)
      if (a) axisItems.push(a)
    }
  }
  const nestedItems: SceneItem[] = []
  for (const cm of (mark as any).marks ?? []) {
    const ng = facetItemMark(cm, tmpCtx, '')
    if (ng) nestedItems.push(ng)
  }
  return {
    marktype: 'group', name: mark.name, role: 'scope',
    items: [...axisItems, ...nestedItems, {
      // Each concat cell has a 0.5px-inset stroke='#ddd' background the size
      // of the cell, matching vega's `style: cell` default background path.
      path: `M0.5,0.5h${cellWidth}v${cellHeight}h-${cellWidth}Z`,
      x: 0, y: 0, stroke: '#ddd',
    } as SceneItem],
    width: cellWidth, height: cellHeight,
    x: 0, y: 0,
  }
}

/** Build a single concat cell group mark (point/bar/etc. with its own axes). */
function buildConcatGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup {
  // 2D repeat (scatter matrix): return the cell from the shared grid layout.
  const grid = getConcatGridState(ctx)
  if (grid) return grid.cells.get(mark.name)!

  const cell = buildConcatCellBody(mark, ctx)
  const { width: cellWidth, height: cellHeight } = readCellSize(mark, ctx, 500, 500)
  // Cell index = position among the concat group marks in the chart's mark
  // list. vega-lite names plain h/vconcat cells `concat_<n>_group` and repeat
  // cells `child__<field>_group`; the array order is the layout order for both,
  // so the ordinal position is the reliable index.
  const concatMarks = (ctx.chart.marks as CompiledMark[]).filter(m => isConcatGroupMark(m))
  const idx = Math.max(0, concatMarks.indexOf(mark))
  // Vertical concat (vconcat) uses a childHeight signal; horizontal concat uses
  // childWidth. vega-lite emits exactly one of the two for a concat layout.
  const isVertical = ctx.signalParams['childWidth'] === undefined && ctx.signalParams['childHeight'] !== undefined

  const textItems: Array<{ x: number; y: number }> = []
  const collectTexts = (items: SceneItem[]): void => {
    for (const it of items) {
      const g = it as SceneGroup
      if (Array.isArray(g.items)) {
        collectTexts(g.items)
      } else if (it.text != null && it.x != null && it.y != null) {
        textItems.push({ x: it.x, y: it.y })
      }
    }
  }
  collectTexts(cell.items ?? [])

  let cellX = 0
  let cellY = 0
  if (isVertical) {
    // Vertical concat stacks cells top-to-bottom. The per-cell vertical advance
    // must clear the cell's bottom x-axis extent (labels + title below the plot)
    // plus the base spacing — the vertical analog of the horizontal advance.
    let xAxisExtent = 0
    for (const it of textItems) {
      if (it.y > cellHeight) xAxisExtent = Math.max(xAxisExtent, Math.ceil(it.y - cellHeight - 0.5))
    }
    cellY = idx * (cellHeight + CONCAT_BASE_SPACING + xAxisExtent)
  } else {
    // Determine the per-cell horizontal advance from the y-axis left extent so the
    // next cell's y-axis clears this cell's content + base spacing.
    let yAxisExtent = 0
    for (const it of textItems) {
      if (it.x < 0) yAxisExtent = Math.max(yAxisExtent, Math.ceil(Math.abs(it.x) + TITLE_FONT_SIZE + 0.5))
    }
    cellX = idx * (cellWidth + CONCAT_BASE_SPACING + yAxisExtent)
  }

  cell.x = cellX
  cell.y = cellY
  return cell
}

/**
 * Compute the local content bounds of a built concat cell the way vega bounds
 * its cell group marks. Mirrors vega-scenegraph's text/rule/symbol bound rules
 * so that the grid advances computed by getConcatGridState match vega's
 * gridLayout (align: all, bounds: full) exactly:
 *  - the cell box is the starting extent;
 *  - symbols expand by radius + 2 * strokeWidth (miter join);
 *  - a rotated (left/right axis) title reaches one font-size left/right of its
 *    anchor plus vega's half-pixel axis offset + group stroke expansion;
 *  - a bottom axis title sits one (fontSize - round(0.8*fontSize)) below its
 *    anchor (vega bounds titles with an alphabetic baseline during layout).
 */
function concatCellLocalBounds(cell: SceneGroup, cellW: number, cellH: number): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = 0, y1 = 0, x2 = cellW, y2 = cellH
  const walk = (items: SceneItem[], ox: number, oy: number, marktype?: string): void => {
    for (const it of items) {
      const g = it as SceneGroup
      if (Array.isArray(g.items)) {
        walk(g.items, ox + (g.x ?? 0), oy + (g.y ?? 0), g.marktype)
        continue
      }
      const x = ox + (it.x ?? 0)
      const y = oy + (it.y ?? 0)
      if (it.text != null) {
        // Left/right axis titles are rotated ±90°: they extend one font-size
        // beyond their anchor on the outside. Vega's group bound excludes the
        // axis's half-pixel offset but the cell stroke adds it back, netting a
        // 1px overshoot over the anchor.
        if (x < 0) {
          const fontSize = (it as unknown as Record<string, unknown>).fontSize as number | undefined ?? TITLE_FONT_SIZE
          x1 = Math.min(x1, x - fontSize - 1)
        } else if (y > cellH) {
          // Bottom axis title: vega bounds it with an alphabetic baseline, so
          // its bottom sits (fontSize - round(0.8*fontSize)) below the anchor.
          const fontSize = (it as unknown as Record<string, unknown>).fontSize as number | undefined ?? TITLE_FONT_SIZE
          y2 = Math.max(y2, y + (fontSize - Math.round(0.8 * fontSize)))
        }
      } else if (marktype === 'symbol' || it.size != null) {
        const size = it.size ?? 30
        const sw = it.strokeWidth ?? 2
        // Vega's symbol bound adds the (miter) stroke extent and the cell
        // group's stroke expansion carries a further half pixel on each side.
        const ext = Math.sqrt(size) / 2 + 2 * sw + 0.5
        x1 = Math.min(x1, x - ext)
        y1 = Math.min(y1, y - ext)
        x2 = Math.max(x2, x + ext)
        y2 = Math.max(y2, y + ext)
      }
    }
  }
  walk(cell.items ?? [], cell.x ?? 0, cell.y ?? 0, cell.marktype)
  return { x1, y1, x2, y2 }
}

function isAxisSpec(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && 'scale' in v && 'orient' in v
}

function findCellMark(ctx: EvalContext): CompiledMark | undefined {
  return (ctx.chart.marks as CompiledMark[]).find(m => (m.from as any)?.facet?.groupby?.length)
}

function buildAxisInline(spec: Record<string, unknown>, ctx: EvalContext): SceneGroup | null {
  const def: Record<string, unknown> = { scale: spec.scale, orient: (spec as any).orient }
  for (const k of ['grid','gridScale','domain','labels','ticks','tickCount','tickSize','title','titlePadding','labelAlign','labelBaseline','labelFlush','labelOverlap','labelPadding','tickBand','zindex','encode']) {
    if ((spec as Record<string, unknown>)[k] !== undefined) def[k] = (spec as Record<string, unknown>)[k]
  }
  return buildAxis(def as unknown as CompiledAxis, ctx)
}

function facetItemMark(
  mark: CompiledMark,
  ctx: EvalContext,
  facetDataName: string,
): SceneGroup | null {
  if (mark.type === 'group') {
    const r = buildGroupMark(mark, ctx)
    if (!r) return null
    if (Array.isArray(r)) {
      const sub: SceneItem[] = []
      for (const sg of r) { if (sg.items) sub.push(...sg.items) }
      return { marktype: 'group', name: mark.name, role: mark.role as string, items: sub }
    }
    return r
  }

  const source = (mark.from as any)?.data ?? facetDataName
  let items: SceneItem[]

  // Copy each row so resolveEncodeSet (which writes resolved values back into
  // the datum) cannot corrupt the shared dataset. This matters when the same
  // cell data is built more than once (e.g. buildColumnTitleGroup rebuilds the
  // cells to compute the title center); without copies the second pass would
  // re-scale already-scaled values.
  const rows = (ctx.datasets.get(source) ?? []).map((r) => ({ ...r }))
  if (mark.sort) {
    mark.sort && (rows.sort((a, b) => {
      if (mark.sort?.field) {
        const fs = mark.sort.field as string
        const af = mark.sort.order === 'descending' ? -1 : 1
        return String(a[fs] as string).localeCompare(String(b[fs] as string)) * af
      }
      return 0
    }))
  }

  const update = mark.encode?.update ?? mark.encode?.enter ?? {}
  items = rows.map((row) => {
    const res = resolveEncodeSet(update, row, ctx, mark.type)
    res.datum = row
    return res
  })

  if (Array.isArray((mark as any).style) ? (mark as any).style.includes('arc') : (mark as any).style === 'arc') {
    for (const it of items) { if (it.strokeWidth == null) it.strokeWidth = 1.5 }
  }

  if (mark.type === 'text') {
    applyTextPolar(items)
  }

  applySymbolStyleDefaults(mark, items)

  return { marktype: mark.type, name: mark.name, role: 'mark', clip: mark.clip === true, items }
}

/**
 * Bake the style-level symbol defaults vega applies at parse time: the
 * vega-lite `point`/`circle`/`square` styles set strokeWidth=2 for symbols
 * (applied even when the symbol has no stroke — the SVG renderer emits the
 * width regardless). Raw vega symbol marks (no style) keep vega's mark
 * default (no stroke width).
 */
function applySymbolStyleDefaults(mark: CompiledMark, items: SceneItem[]): void {
  if (mark.type !== 'symbol') return
  const styles = Array.isArray(mark.style) ? mark.style : [mark.style]
  if (!styles.some((s) => s === 'point' || s === 'circle' || s === 'square')) return
  for (const it of items) {
    if (it.strokeWidth == null) it.strokeWidth = 2
  }
}

/**
 * Bake a text item's polar `radius`/`theta` encoding into its x/y anchor,
 * mirroring vega-scenegraph's `anchorPoint` (theta is measured clockwise from
 * 12 o'clock, hence the -π/2 offset).
 */
function applyTextPolar(items: SceneItem[]): void {
  for (const it of items) {
    const radius = it.radius
    if (radius == null || radius === 0) continue
    const x = it.x ?? 0
    const y = it.y ?? 0
    const t = (it.theta ?? 0) - Math.PI / 2
    it.x = x + radius * Math.cos(t)
    it.y = y + radius * Math.sin(t)
    delete (it as Record<string, unknown>).radius
    delete (it as Record<string, unknown>).theta
  }
}

interface EncodePlan {
  /** Non-signal keys, in spec order. */
  plainKeys: string[]
  /** Signal-valued keys (excluding `defined`), in spec order. */
  signalKeys: string[]
  /** The `defined` signal spec, resolved before datum mutation. */
  definedSpec: EncodeValue | EncodeValue[] | undefined
}

// Per-encode-object plan. The key scan + signal/plain partition is invariant
// across the rows of a mark; hoisting it removes an Object.keys allocation and
// an array partition per row (10k rows -> 1 scan).
const encodePlanCache = new WeakMap<object, EncodePlan>()

function encodePlan(encode: Record<string, EncodeValue | EncodeValue[]>): EncodePlan {
  let plan = encodePlanCache.get(encode)
  if (plan) return plan
  const plainKeys: string[] = []
  const signalKeys: string[] = []
  let definedSpec: EncodeValue | EncodeValue[] | undefined
  for (const key of Object.keys(encode)) {
    const spec = encode[key]
    if (typeof spec === 'object' && spec != null && 'signal' in spec) {
      if (key === 'defined') {
        definedSpec = spec
        continue
      }
      signalKeys.push(key)
      continue
    }
    plainKeys.push(key)
  }
  plan = { plainKeys, signalKeys, definedSpec }
  encodePlanCache.set(encode, plan)
  return plan
}

function resolveEncodeSet(encode: Record<string, EncodeValue | EncodeValue[]>, datum: Row, ctx: EvalContext, marktype: string): SceneItem {
  const plan = encodePlan(encode)

  // Pass 1: resolve all non-signal values and accumulate them.
  const ctxItem: Record<string, unknown> = {}
  for (const key of plan.plainKeys) {
    const resolved = resolveEncodeProperty(encode[key], datum, ctx)
    if (resolved !== undefined) {
      ctxItem[key] = resolved
    }
  }

  // Resolve the `defined` signal BEFORE datum mutation. Vega evaluates
  // `defined` against the original data tuple (before scale resolution),
  // so expressions like `isValid(datum["y"])` must see the raw data
  // value (null), not the scaled pixel position.
  let definedValue: unknown
  if (plan.definedSpec !== undefined) {
    definedValue = resolveEncodeProperty(plan.definedSpec, datum, ctx)
  }

  // Pass 2: resolve signal-value pairs. datum gets the resolved values appended.
  const item: SceneItem = {}
  for (const k in ctxItem) {
    datum[k as keyof Row] = ctxItem[k] as unknown
    ;(item as unknown as Record<string, unknown>)[k] = ctxItem[k]
  }
  // Apply the pre-resolved `defined` value (from before datum mutation).
  if (definedValue !== undefined) {
    ;(item as unknown as Record<string, unknown>)['defined'] = definedValue
  }
  for (const key of plan.signalKeys) {
    const resolved = resolveEncodeProperty(encode[key], datum, ctx)
    if (resolved !== undefined) {
      ;(item as unknown as Record<string, unknown>)[key] = resolved
    }
  }
  // Post-process: handle yc (center-y) by computing y and y2 from height.
  const rec = item as unknown as Record<string, unknown>
  const ycVal = rec['yc']
  if (ycVal != null && typeof ycVal === 'number') {
    const h = rec['height']
    if (h != null && typeof h === 'number' && h > 0) {
      rec['y'] = ycVal - h / 2
      rec['y2'] = ycVal + h / 2
    } else {
      rec['y'] = ycVal
    }
  }
  // Handle xc (center-x) by computing x and x2 from width.
  const xcVal = rec['xc']
  if (xcVal != null && typeof xcVal === 'number') {
    const w = rec['width']
    if (w != null && typeof w === 'number' && w > 0) {
      rec['x'] = xcVal - w / 2
      rec['x2'] = xcVal + w / 2
    } else {
      rec['x'] = xcVal
    }
  }

  return item
}

function resolveEncodeProperty(
  spec: EncodeValue | EncodeValue[] | undefined,
  datum: Row,
  ctx: EvalContext,
): unknown {
  if (spec == null) return undefined
  if (Array.isArray(spec)) {
    // Vega conditional encode: entries are tested in order; the first matching
    // `test` wins, and an entry with no `test` is the unconditional fallback
    // (the "otherwise" value).
    for (const cond of spec) {
      if (cond && typeof cond === 'object' && 'test' in cond && typeof cond.test === 'string') {
        try {
          const test = ctx.runtime.expr(cond.test)
          if (test(datum, ctx.signalParams)) {
            try {
              return resolveEncodeValueInternal(cond, datum, ctx)
            } catch {
              return undefined
            }
          }
        } catch {
          // Expression evaluation failed (e.g., datum has no field); skip condition
        }
      } else if (cond && typeof cond === 'object') {
        return resolveEncodeValueInternal(cond, datum, ctx)
      }
    }
    return undefined
  }
  return resolveEncodeValueInternal(spec, datum, ctx)
}

function resolveEncodeValueInternal(value: EncodeValue | undefined, datum: Row, ctx: EvalContext): unknown {
  if (value == null || typeof value !== 'object') return value
  // 1. Signal always takes priority - evaluate the expression
  if ('signal' in value && value.signal !== undefined) {
    try {
      let result = ctx.runtime.expr(value.signal as string)(datum, ctx.signalParams)
      if (result != null && typeof result === 'number') {
        const multVal = (value as { mult?: number }).mult
        if (typeof multVal === 'number') result *= multVal
        const offsetVal = (value as { offset?: number }).offset
        if (typeof offsetVal === 'number') result += offsetVal
      }
      return result
    } catch {
      return undefined
    }
  }
  // 2. Scale resolution - maps a value (or datum field) through a scale
  if ('scale' in value) {
    const multVal = (value as { mult?: number }).mult
    const offsetVal = (value as { offset?: number }).offset
    const scale = ctx.scales.get(value.scale as string)
    const field = (value as { field?: unknown }).field
    const bandSpec = (value as { band?: boolean | number | { signal: string } }).band
    const offsetSpec = (value as { offset?: number | { signal: string } }).offset
    let s = scale as Scale | undefined
    if (!s) return undefined
    
    // If scale is band and no field/value, return bandwidth (for {scale, band} encoding)
    if (s.bandwidth && field == null) {
      const litValue = (value as { value?: unknown }).value
      let raw: unknown
      if (litValue !== undefined) {
        raw = litValue
      } else {
        // { scale: "x", band: 1 } - return bandwidth * band fraction
        let fraction = bandSpec === true ? 0.5 : (typeof bandSpec === 'number' ? bandSpec : 1)
        return s.bandwidth() * fraction
      }
    } else if (field != null) {
      // 3a. Use datum field as the value to scale
    } else {
      // 3b. Use literal value as input to scale
      const litValue = (value as { value?: unknown }).value
      if (litValue === undefined) return undefined
    }
    
    // Get the value to scale
    let raw: unknown
    if (field != null) {
      raw = getField(datum, field as string)
    } else {
      raw = (value as { value?: unknown }).value
    }
    if (raw === undefined) return undefined
    
    const scaleType = ctx.scaleTypes.get(value.scale as string)
    if ((scaleType === 'time' || scaleType === 'utc') && typeof raw === 'string') {
      const dateObj = new Date(raw)
      if (dateObj instanceof Date && Number.isFinite(dateObj.getTime())) {
        raw = dateObj
      }
    }
    
    const scaled = s(raw) as number
    let position = scaled
    
    // 4. Band placement: position = scale(raw) + bandFraction * bandwidth
    if (bandSpec != null && s.bandwidth) {
      const bandwidth = s.bandwidth()
      let bandFraction: number
      if (bandSpec === true) {
        bandFraction = 0.5
      } else if (typeof bandSpec === 'number') {
        bandFraction = bandSpec
      } else if (bandSpec && typeof bandSpec === 'object' && 'signal' in bandSpec) {
        bandFraction = ctx.runtime.expr(bandSpec.signal as string)(datum, ctx.signalParams) as number
      } else {
        bandFraction = 0.5
      }
      position = scaled + bandFraction * bandwidth
    }
    
    // 5. Offset: add offset after band placement
    if (offsetSpec != null) {
      let offset: number
      if (typeof offsetSpec === 'number') {
        offset = offsetSpec
      } else if (offsetSpec && typeof offsetSpec === 'object' && 'scale' in offsetSpec) {
        // Scale-based offset (e.g. from Vega-Lite's xOffset encoding):
        // { scale: "xOffset", field: "group" }
        const offScale = ctx.scales.get((offsetSpec as { scale: string }).scale)
        if (offScale) {
          const offField = (offsetSpec as { field?: string }).field
          const offRaw = offField ? getField(datum, offField) : undefined
          offset = offRaw !== undefined ? offScale(offRaw) as number : 0
        } else {
          offset = 0
        }
      } else if (offsetSpec && typeof offsetSpec === 'object' && 'signal' in offsetSpec) {
        offset = ctx.runtime.expr(offsetSpec.signal as string)(datum, ctx.signalParams) as number
      } else {
        offset = 0
      }
      position += offset
    }
    
    // Apply mult/offset after scale resolution (only if they are actual numbers, not signal objects)
    if (typeof multVal === 'number') position = position * multVal
    if (typeof offsetVal === 'number') position = position + offsetVal
    return position
  }
  if ('field' in value) {
    // Handle Vega group field references: {field: {group: "width"}} etc.
    // These reference the enclosing group's scenegraph properties.
    const fieldSpec = value.field as unknown
    if (fieldSpec != null && typeof fieldSpec === 'object' && !Array.isArray(fieldSpec) && 'group' in (fieldSpec as Record<string, unknown>)) {
      const groupKey = (fieldSpec as { group: string }).group
      let v: unknown
      if (groupKey === 'width') v = ctx.width
      else if (groupKey === 'height') v = ctx.height
      else if (groupKey === 'x') v = 0
      else if (groupKey === 'y') v = 0
      else v = 0
      if (v != null && typeof v === 'number') {
        const multValField = (value as { mult?: number }).mult
        if (multValField != null) v *= multValField
        const offsetValField = (value as { offset?: number }).offset
        if (offsetValField != null) v += offsetValField
      }
      return v
    }
    let v = getField(datum, value.field as string)
    if (v != null && typeof v === 'number') {
      const multValField = (value as { mult?: number }).mult
      if (multValField != null) v *= multValField
      const offsetValField = (value as { offset?: number }).offset
      if (offsetValField != null) v += offsetValField
      v = formatValue(v, value)
    }
    return v
  }
  if ('value' in value) {
    const v = value.value
    let result = typeof v === 'object' && v != null && 'signal' in v
      ? (resolveEncodeValueInternal(v as EncodeValue, datum, ctx) as number)
      : (v as number)
    // Apply mult/offset
    if (typeof result === 'number' && Number.isFinite(result)) {
      const multVal = (value as { mult?: number }).mult
      if (multVal != null) result *= multVal
      const offsetVal = (value as { offset?: number }).offset
      if (offsetVal != null) result += offsetVal
    }
    return result
  }
  return undefined
}

function formatValue(v: unknown, spec: EncodeValue): unknown {
  const format = (spec as { format?: unknown }).format
  const formatType = (spec as { formatType?: unknown }).formatType
  if (format === undefined) return v
  const fmt = format as string
  const L = locale(undefined)
  if (formatType === 'time' || v instanceof Date) return L.timeFormat(fmt)(v as Date)
  return L.format(fmt)(v as number)
}

/**
 * Compute the effective content width for legend positioning.
 * For faceted charts, the actual content width is the cell width (from
 * child_width signal), not the top-level ctx.width which defaults to 500.
 */
function legendContentWidth(ctx: EvalContext): number {
  const cw = ctx.signalParams['child_width']
  if (typeof cw === 'number' && Number.isFinite(cw) && cw < ctx.width) return cw
  return ctx.width
}

function buildLegend(legend: CompiledLegend, ctx: EvalContext): SceneGroup | null {
  // Resolve the scale name (fill/stroke color legends, size legends, or shape legends).
  const scaleName = legend.shape ?? legend.stroke ?? legend.fill ?? legend.size
  if (!scaleName) return null
  const scale = ctx.scales.get(scaleName)
  if (!scale) return null
  const scaleType = ctx.scaleTypes.get(scaleName) ?? ''
  // Domain values
  const domain = scale.domain() as unknown[]
  const d0 = domain[0]
  const d1 = domain[domain.length - 1]
  const orient = legend.orient ?? 'right'

  // --- Gradient legend (continuous scale + gradientLength) ---
  // Vega defaults to gradient legends for interpolating scales (sequential,
  // diverging) even without an explicit gradientLength.
  const isInterpolating = scaleType === 'sequential'
  if (CONTINUOUS_TYPES.has(scaleType) && (legend.gradientLength != null || isInterpolating)) {
    // Resolve gradientLength: number, signal object, or fallback to 200
    let GL: number = 200
    if (typeof legend.gradientLength === 'number') {
      GL = legend.gradientLength
    } else if (legend.gradientLength && typeof legend.gradientLength === 'object' && 'signal' in legend.gradientLength) {
      const signalVal = (legend.gradientLength as { signal: string }).signal
      if (signalVal) {
        const v = ctx.runtime.expr(signalVal)({}, ctx.signalParams)
        GL = typeof v === 'number' ? v : 200
      }
    }
    const gradientLength = GL
    const L = Math.max(64, Math.min(gradientLength, 200))

    // Vega numbers gradient defs from a global counter; replicate that so the
    // `url(#gradient_n)` references match the oracle (which runs in-process).
    const gradientId = 'gradient_' + gradientIdCounter++

    // Compute tick values using scale.ticks with L/50 as hint
    const tickNums = scale.ticks ? scale.ticks(L / 50) : []
    const titleStr0 = String(legend.title ?? '')
    const titleH0 = titleStr0.length > 0 ? 16 : 0

    // --- horizontal gradient strip (top/bottom orient, or direction:horizontal) ---
    // Vega lays the strip out left→right: title at y=9, the gradient rect at
    // y=titleH (height=gradientThickness 16), labels beneath at the fractional
    // position along the strip. Calibrated to the oracle.
    if (legend.direction === 'horizontal' || orient === 'bottom' || orient === 'top') {
      const thickness = legend.gradientThickness ?? 16
      const d0n = typeof d0 === 'number' ? d0 : 0
      const d1n = typeof d1 === 'number' ? d1 : 1
      const LL = locale(undefined)
      const legendFmt = LL.format('.1~f')
      const items: SceneItem[] = []
      const bgW = gradientLength
      const bgH = titleH0 + thickness + 12
      items.push({ path: `M0,0h${bgW}v${bgH}h-${bgW}Z`, x: 0, y: 0 })
      if (titleStr0) items.push({ text: titleStr0, x: 0, y: 9, align: 'left', fill: '#000' })
      items.push({ path: `M0,0h${gradientLength}v${thickness}h-${gradientLength}Z`, x: 0, y: titleH0, fill: `url(#${gradientId})`, stroke: '#ddd', strokeWidth: 0, opacity: 1 })
      for (const t of tickNums) {
        const tNum = typeof t === 'number' ? t : 0
        const perc = d1n !== d0n ? (tNum - d0n) / (d1n - d0n) : 0
        items.push({ text: legendFmt(tNum), x: perc * gradientLength, y: titleH0 + thickness + 10, align: 'center', fill: '#000' })
      }
      const colorScale = scale as ColorScale
      const stops = colorScale.interpolator
        ? Array.from({ length: 17 }, (_, i) => ({ offset: i / 16, color: String((colorScale.interpolator as () => (t: number) => unknown)?.()(i / 16)) }))
        : []
      if (stops.length) ctx._defs.push({ id: gradientId, colorStops: stops, direction: 'horizontal' })
      const groupY = orient === 'top' ? 0 : ctx.height + 24
      return { marktype: 'group', role: 'legend', x: 0, y: groupY, width: bgW, height: bgH, items }
    }

    // The gradient rect inherits the legend's gradient encode opacity (vega-lite
    // emits opacity 0.7 for stroke legends, 1 otherwise).
    let gradientOpacity = 1
    const gradEncode = (legend as unknown as { encode?: { gradient?: { update?: { opacity?: EncodeValue } } } }).encode?.gradient?.update?.opacity
    if (gradEncode && typeof gradEncode === 'object' && 'value' in gradEncode) {
      const ov = (gradEncode as { value?: unknown }).value
      if (typeof ov === 'number') gradientOpacity = ov
    }

    // Outer background width = the wider of the label run (labels sit at x=18,
    // ~8px per character at 10px) and the title (11px bold, vega's estimate is
    // `~~(0.8 * len * fontSize)`).
    const labelStrs = tickNums.map((t) => String(typeof t === 'number' ? t : 0))
    const maxLabelLen = labelStrs.reduce((m, s) => Math.max(m, s.length), 0)
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? ~~(0.8 * titleStr.length * 11) : 0
    const outerWidth = Math.max(18 + 8 * maxLabelLen, titleWidth)

    const items: SceneItem[] = []
    // Title height: 16px when a title is present, 0 otherwise.
    const titleH = titleStr.length > 0 ? 16 : 0
    // Background box (0,0 to outerWidth, titleH+L)
    items.push({ path: `M0,0h${outerWidth}v${titleH + L}h-${outerWidth}Z`, x: 0, y: 0 })
    // Gradient rect at legend-relative (0, titleH), 16xL
    items.push({
      path: `M0,0h16v${L}h-16Z`,
      x: 0, y: titleH,
      fill: `url(#${gradientId})`,
      stroke: '#ddd',
      strokeWidth: 0,
      opacity: gradientOpacity,
    })
    // Title
    if (titleStr.length > 0) {
      items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000' })
    }
    // Labels. Vega positions each label at (1 - perc) * L and then shifts it by
    // the text baseline offset (labels flush against the gradient edges get
    // top/bottom baselines), rounding to whole pixels. Replicate that here.
    const d0n = typeof d0 === 'number' ? d0 : 0
    const d1n = typeof d1 === 'number' ? d1 : 1
    const LABEL_FONT_SIZE = 10
    // Vega formats gradient legend labels with the locale formatter, which uses
    // the Unicode minus sign (U+2212) for negative values. Match that by using
    // the locale number formatter rather than String().
    const LL = locale(undefined)
    const legendFmt = LL.format('.1~f')
    for (const t of tickNums) {
      const tNum = typeof t === 'number' ? t : 0
      const perc = d1n !== d0n ? (tNum - d0n) / (d1n - d0n) : 0
      const baselineOffset =
        perc <= 0 ? Math.round(-0.21 * LABEL_FONT_SIZE)
        : perc >= 1 ? Math.round(0.79 * LABEL_FONT_SIZE)
        : 0.3 * LABEL_FONT_SIZE
      const yPos = titleH + (1 - perc) * L + baselineOffset
      items.push({ text: legendFmt(tNum), x: 18, y: yPos, align: 'left', fill: '#000' })
    }
    // Gradient def from scale's interpolator
    const colorScale = scale as ColorScale
    const stops = colorScale.interpolator
      ? Array.from({ length: 17 }, (_, i) => ({
          offset: i / 16,
          color: String((colorScale.interpolator as () => (t: number) => unknown)?.()(i / 16)),
        }))
      : []
    const group: SceneGroup = {
      marktype: 'group',
      role: 'legend',
      x: ctx.width + 18,
      y: 0,
      width: outerWidth,
      height: titleH + L,
      items,
    }
    if (stops.length) {
      ctx._defs.push({ id: gradientId, colorStops: stops })
    }
    return group
  }

  // --- Size legend (symbol legend driven by the size scale) ---
  // Vega renders a `size` channel legend as a symbol legend whose symbols are
  // sized by the size scale and whose entries are packed vertically according
  // to the symbol bounds. This mirrors vega's LegendEntries + legend layout:
  //   datum.size  = scale(value)                      (area; radius = sqrt/2)
  //   datum.sizeD = max(ceil(sqrt(size)+strokeWidth), fontSize=10)
  //   offset      = max sizeD
  //   symbol x    = offset/2,  label x = offset + labelOffset(4)
  //   symbol y    = sizeD/2,   label y = sizeD/2 + 3 (middle baseline)
  // Entry heights/offsets derive from the symbol+label bounds:
  //   b.y1 = min(y - extent, y - 5), b.y2 = max(y + extent, y + 5)
  // where extent = r + 3 (stroke miter inflation) when the symbol is stroked,
  // else r. The single-column grid packs entries with rowPadding=2.
  if (legend.size != null && legend.fill == null && legend.stroke == null) {
    const sizeScale = ctx.scales.get(legend.size)
    if (!sizeScale) return null
    if (orient !== 'right' && orient !== undefined) return null
    // Legend tick values (vega: labelValues(scale, 5)); drop the first value
    // when it maps to size zero (vega#717).
    let ticks = ((sizeScale as { ticks?: (n?: number) => unknown[] }).ticks?.(5) ?? []) as unknown[]
    if (ticks.length > 1 && Number(sizeScale(ticks[0])) === 0) ticks = ticks.slice(1)
    if (ticks.length === 0) return null

    // Symbol stroke/opacity from the legend's symbols encode (vega-lite emits
    // stroke=#4c78a8, opacity=0.7, fill=transparent for size legends).
    const symEncode = (legend.encode?.symbols?.update ?? {}) as Record<string, EncodeValue>
    const encVal = (k: string): unknown => {
      const v = symEncode[k]
      return v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : undefined
    }
    const strokeColor = encVal('stroke')
    const opacity = (encVal('opacity') as number) ?? 0.7
    const strokeWidth = 1.5
    const fontSize = 10
    const labelOffset = 4
    const rowPadding = 2
    const symbolType = legend.symbolType ?? 'circle'

    const entries = ticks.map((v) => {
      const size = Number(sizeScale(v)) || 0
      const r = Math.sqrt(size) / 2
      const sizeD = Math.max(Math.ceil(Math.sqrt(size) + strokeWidth), fontSize)
      return { value: v, size, r, sizeD }
    })
    const offset = entries.reduce((m, e) => Math.max(m, e.sizeD), 0)
    const symbolX = offset / 2
    const labelX = offset + labelOffset

    // Per-entry vertical bounds (symbol +/- extent, label +/- 5).
    // Vega's boundStroke always inflates symbol bounds by miter*strokeWidth/2 = 3
    // (with default strokeWidth=1.5 and miterLimit=4), even when the symbol has
    // no explicit stroke color. Match that unconditionally for circle symbols.
    const hasStroke = strokeColor != null
    const b = entries.map((e) => {
      const ext = symbolType === 'square' ? (hasStroke ? e.sizeD / 2 : e.r) : e.r + 3
      const y = e.sizeD / 2
      return { y1: Math.min(y - ext, y - 5), y2: Math.max(y + ext, y + 5) }
    })
    // Single-column vertical grid layout (align 'each', rowPadding 2).
    const yOff: number[] = [0]
    for (let i = 1; i < entries.length; i++) {
      const o = rowPadding + (b[i]!.y1 < 0 ? Math.ceil(-b[i]!.y1) : 0)
      yOff.push(o + Math.ceil(b[i - 1]!.y2))
    }
    const yPos: number[] = []
    let acc = 0
    for (let i = 0; i < entries.length; i++) {
      acc += yOff[i]!
      yPos.push(acc)
    }
    const scopesHeight = acc + b[b.length - 1]!.y2

    // Widths: labels render at 10px (~8px/char), title at 11px bold.
    const maxLabelLen = entries.reduce((m, e) => Math.max(m, String(e.value).length), 0)
    const entryWidth = labelX + 8 * maxLabelLen
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? ~~(0.8 * titleStr.length * 11) : 0
    const outerWidth = Math.max(entryWidth, titleWidth)
    const bgHeight = 16 + scopesHeight

    const items: SceneItem[] = []
    items.push({ path: `M0,0h${outerWidth}v${bgHeight}h-${outerWidth}Z`, x: 0, y: 0 })
    items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000' })
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const ey = 16 + yPos[i]!
      const sy = ey + e.sizeD / 2
      items.push({ path: `M0,0h${entryWidth}v${b[i]!.y2}h-${entryWidth}Z`, x: 0, y: ey })
      // Vega always renders size legend symbols with a default stroke (#888)
      // and opacity (0.7), even when the legend encode doesn't specify them.
      const symStroke = strokeColor != null ? String(strokeColor) : '#888'
      const symOpacity = opacity ?? 0.7
      if (symbolType === 'square') {
        const w = Math.sqrt(e.size)
        items.push({
          path: `M${-w / 2},${-w / 2}h${w}v${w}h${-w}Z`,
          x: symbolX,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          opacity: symOpacity,
        })
      } else {
        items.push({
          shape: 'circle',
          radius: e.r,
          x: symbolX,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          opacity: symOpacity,
        })
      }
      items.push({ text: String(e.value), x: labelX, y: sy + 3, align: 'left', fill: '#000' })
    }
    return { marktype: 'group', role: 'legend', x: legendContentWidth(ctx) + 18, y: 0, width: outerWidth, height: bgHeight, items }
  }

  // --- Band legend (quantile / quantize / threshold) ---
  // Vega renders these scale types as a "band" legend: rectangular color
  // swatches for each range value with text labels at quantile breakpoints.
  if ((scaleType === 'quantile' || scaleType === 'quantize' || scaleType === 'threshold') && orient === 'right' || orient === undefined) {
    const rangeVals = scale.range() as string[]
    const bandCount = rangeVals.length
    if (bandCount > 0 && orient === 'right' || orient === undefined) {
      const SWATCH_W = 16
      const SWATCH_H = Math.max(25, Math.floor(200 / bandCount))
      const sortedDomain = [...domain].filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
      const isThreshold = scaleType === 'threshold'
      let outerWidth: number
      if (isThreshold) {
        // Threshold: labels are integer domain values, compute width from content
        const maxLabelLen = sortedDomain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
        outerWidth = SWATCH_W + 2 + 8 * Math.max(maxLabelLen, 1)
      } else if (scaleType === 'quantize') {
        // Quantize: compute width from content (label at breakpoint)
        let maxLabelLen = 1
        if (sortedDomain.length >= 2) {
          const d0 = sortedDomain[0]!
          const d1 = sortedDomain[sortedDomain.length - 1]!
          for (let i = 1; i < bandCount; i++) {
            const rawVal = d0 + (d1 - d0) * i / bandCount
            maxLabelLen = Math.max(maxLabelLen, String(Math.round(rawVal * 1e10) / 1e10).length)
          }
        }
        outerWidth = SWATCH_W + 2 + 8 * Math.max(maxLabelLen, 1)
      } else {
        // Quantile: vega uses a fixed width of 50
        outerWidth = 50
      }
      const bgH = bandCount * SWATCH_H
      const items: SceneItem[] = []
      // Background box
      items.push({ path: `M0,0h${outerWidth}v${bgH}h-${outerWidth}Z`, x: 0, y: 0 })
      // Band swatches (top-to-bottom: last range color first)
      for (let i = 0; i < bandCount; i++) {
        const y = (bandCount - 1 - i) * SWATCH_H
        items.push({ path: `M0,${y}h${SWATCH_W}v${SWATCH_H}h-${SWATCH_W}Z`, x: 0, y: 0, fill: String(rangeVals[i]), stroke: '#ddd', strokeWidth: 0, opacity: 1 })
      }
      // Labels at breakpoints (skip the first which is empty)
      for (let i = 1; i < bandCount; i++) {
        const y = (bandCount - i) * SWATCH_H + 3
        let rawVal: number | undefined
        if (scaleType === 'quantize' && sortedDomain.length >= 2) {
          // Quantize: breakpoints are evenly spaced across the domain extent
          const d0 = sortedDomain[0]!
          const d1 = sortedDomain[sortedDomain.length - 1]!
          rawVal = d0 + (d1 - d0) * i / bandCount
        } else {
          const nVals = sortedDomain.length
          const idx = Math.ceil(i * nVals / bandCount) - 1
          rawVal = idx >= 0 && idx < nVals ? sortedDomain[idx] : undefined
        }
        // Quantile/quantize: format with ".0" for integers; threshold: plain integers
        const label = rawVal !== undefined
          ? (isThreshold ? String(rawVal) : (scaleType === 'quantize' ? String(Math.round(rawVal * 1e10) / 1e10) : (Number.isInteger(rawVal) ? rawVal + '.0' : String(rawVal))))
          : ''
        items.push({ text: label, x: 18, y, align: 'left', fill: '#000' })
      }
      // Empty label at the bottom
      items.push({ text: '', x: 18, y: bgH - 2, align: 'left', fill: '#000' })
      return { marktype: 'group', role: 'legend', x: legendContentWidth(ctx) + 18, y: 0, width: outerWidth, height: bgH, items }
    }
  }

  // --- Symbol legend (discrete) ---
  const n = domain.length

  // --- 'right' (default) ---
  if (orient === 'right' || orient === undefined) {
    // Detect fill vs stroke legend channel and legend encode style.
    // Fill legends (e.g. arc-pie): fill=color, no stroke, opacity=1, step=13, box=11
    // Stroke legends (e.g. legend-scatter): stroke=color, no fill, opacity=0.7, step=18, box=14
    // A fill legend whose symbols carry a stroke encode (e.g. filled point with
    // stroke="#333") uses the stroke-legend dimensions because the stroke widens
    // the symbol bounding box.
    const colorProp = legend.fill ? 'fill' : 'stroke'
    const isStrokeLegend = !legend.fill
    const symType = legend.symbolType ?? 'circle'
    // Vega legend dimensions depend on the symbolType:
    // - symbolType "stroke" (line symbols): step=13, box=11, offset=22
    // - symbolType "circle" with stroke channel (scatter-like): step=18, box=14, offset=18
    // - fill channel: step=13, box=11, offset=18
    const isStrokeType = symType === 'stroke'

    // Extract symbol stroke color early — it affects legend dimensions when
    // the channel is fill (stroke widens the symbol bounding box).
    const symStrokeEnc = (legend as unknown as { encode?: { symbols?: { update?: { stroke?: EncodeValue } } } }).encode?.symbols?.update?.stroke
    const legendStrokeColor = symStrokeEnc && typeof symStrokeEnc === 'object' && 'value' in symStrokeEnc
      ? (symStrokeEnc as { value?: unknown }).value
      : undefined

    // When a fill legend's symbols have an explicit stroke encode, Vega uses
    // the larger stroke-legend entry dimensions (step=18, box=14) to account
    // for the expanded symbol bounding box.
    const hasSymbolStroke = legendStrokeColor != null && colorProp === 'fill'
    const entryStep = isStrokeType ? 13 : ((isStrokeLegend || hasSymbolStroke) ? 18 : 13)
    const boxHeight = isStrokeType ? 11 : ((isStrokeLegend || hasSymbolStroke) ? 14 : 11)
    const legendOffset = isStrokeType ? 22 : 18

    // Symbol opacity from the legend's `symbols.update.opacity` encode
    // (vega-lite emits 0.7 for colored point/circle legends, absent otherwise).
    // Stroke-type legends (horizontal lines) use opacity=1 by default.
    const symOpacityEnc = (legend as unknown as { encode?: { symbols?: { update?: { opacity?: EncodeValue } } } }).encode?.symbols?.update?.opacity
    const symbolOpacity = symOpacityEnc && typeof symOpacityEnc === 'object' && 'value' in symOpacityEnc
      ? (symOpacityEnc as { value?: unknown }).value
      : undefined

    // Vega measures text width as ~~(0.8 * len * fontSize) when no canvas is
    // available (vega-scenegraph estimateWidth). Labels render at 10px, the
    // legend title at 11px bold. The entry content width is the symbol offset
    // (16 or 20 for stroke legends) plus the widest label; the outer background
    // spans the larger of the entry content and the title.
    const maxLabelLen = domain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
    const entryWidth = 16 + 8 * maxLabelLen
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? ~~(0.8 * titleStr.length * 11) : 0
    const outerWidth = Math.max(entryWidth, titleWidth)
    // Vega includes the title row (16px) in the legend background only when
    // a title is present.
    const titleRow = titleStr ? 16 : 0
    const bgHeight = titleRow + boxHeight + entryStep * (n - 1)

    const items: SceneItem[] = []
    items.push({ path: `M0,0h${outerWidth}v${bgHeight}h-${outerWidth}Z`, x: 0, y: 0 })
    if (titleStr) items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const off = titleRow + i * entryStep
      // For shape legends, compute per-entry swatch height based on the
      // symbol's actual stroke bounds.  Vega's boundStroke expands path
      // bounds by e = max(strokeWidth/2, miterLimit*strokeWidth/2).
      // With default strokeWidth=1.5 and miterLimit=4, e=3.
      // The symbol is at y=6 inside the entry, so the swatch height is:
      //   symbolY(6) + extentY + strokeExpand(3)
      // where extentY = r for most shapes, r*sin(60°) for triangle-up/down.
      let entryBoxHeight = boxHeight
      if (legend.shape) {
        const sn = String(scale(value))
        const symR = 5
        const extentY = (sn === 'triangle-up' || sn === 'triangle-down') ? symR * Math.sqrt(3) / 2 : symR
        entryBoxHeight = 6 + extentY + 3
      }
      items.push({ path: `M0,0h${entryWidth}v${entryBoxHeight}h-${entryWidth}Z`, x: 0, y: off })
      const symbolType = legend.symbolType ?? 'circle'
      // vega renders the legend entry symbol in the shape requested by the
      // legend's symbolType. For "stroke" type, render a horizontal line.
      // For shape channel legends, render the actual shape from the scale.
      if (legend.shape) {
        // Shape legend: the scale returns shape names, use them as symbol shapes.
        // The stroke color comes from the legend encode or defaults to #888
        // (Vega's default symbol stroke for shape legends).
        const shapeName = String(scale(value))
        const shapeStroke = legendStrokeColor ?? '#888'
        // For shape legends, use the encode opacity directly (not the isStrokeLegend
        // fallback which always gives 0.7). When no encode exists, Vega defaults to 1.
        const shapeOpacity = symOpacityEnc && typeof symOpacityEnc === 'object' && 'value' in symOpacityEnc
          ? ((symOpacityEnc as { value?: unknown }).value as number ?? 0.7)
          : 1
        const r = 5
        let d: string
        switch (shapeName) {
          case 'square': d = `M${-r},${-r}h${2*r}v${2*r}h${-2*r}Z`; break
          case 'diamond': d = `M0,${-r}L${r},0L0,${r}L${-r},0Z`; break
          case 'triangle-up': { const h = r * 0.866; d = `M0,${-h}L${-r},${h}L${r},${h}Z`; break }
          case 'triangle-down': { const h = r * 0.866; d = `M0,${h}L${-r},${-h}L${r},${-h}Z`; break }
          case 'triangle-right': { const h = r * 0.866; d = `M${-h},0L${h},${-r}L${h},${r}Z`; break }
          case 'triangle-left': { const h = r * 0.866; d = `M${h},0L${-h},${-r}L${-h},${r}Z`; break }
          case 'cross': {
            const s = r / 2.5
            d = `M${-r},${-s}L${-r},${s}L${-s},${s}L${-s},${r}L${s},${r}L${s},${s}L${r},${s}L${r},${-s}L${s},${-s}L${s},${-r}L${-s},${-r}L${-s},${-s}Z`
            break
          }
          default: d = `M${r},0A${r},${r},0,1,1,${-r},0A${r},${r},0,1,1,${r},0`; break
        }
        items.push({ path: d, x: 6, y: off + 6, stroke: String(shapeStroke), strokeWidth: 1.5, opacity: shapeOpacity })
      } else if (symbolType === 'stroke') {
        items.push({ path: `M-5,0L5,0`, x: 6, y: off + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
      } else if (symbolType === 'square') {
        if (colorProp === 'fill') {
          items.push({ path: 'M-5,-5h10v10h-10Z', x: 6, y: off + 6, fill: String(scale(value)), strokeWidth: 1.5, ...(legendStrokeColor != null ? { stroke: String(legendStrokeColor) } : {}), ...(symbolOpacity != null ? { opacity: symbolOpacity as number } : {}) })
        } else {
          items.push({ path: 'M-5,-5h10v10h-10Z', x: 6, y: off + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
        }
      } else if (colorProp === 'fill') {
        items.push({ shape: 'circle', radius: 5, x: 6, y: off + 6, fill: String(scale(value)), strokeWidth: 1.5, ...(legendStrokeColor != null ? { stroke: String(legendStrokeColor) } : {}), ...(symbolOpacity != null ? { opacity: symbolOpacity as number } : {}) })
      } else {
        items.push({ shape: 'circle', radius: 5, x: 6, y: off + 6, stroke: String(scale(value)), strokeWidth: 1.5, ...(symbolOpacity != null ? { opacity: symbolOpacity as number } : {}) })
      }
      items.push({ text: String(value), x: 16, y: off + 9, align: 'left', fill: '#000' })
    }
    return { marktype: 'group', role: 'legend', x: legendContentWidth(ctx) + legendOffset, y: 0, width: outerWidth, height: bgHeight, items }
  }

  // --- 'bottom' ---
  if (orient === 'bottom') {
    const titleStr = String(legend.title ?? '')
    // Vertical flow (raw Vega default `symbolDirection: vertical`): entries
    // stack at 18px row step, each row 14px tall with symbol at (6,6) and
    // label at (16,9). Group sits at height+24 (oracle line-grid-dash).
    if (legend.direction !== 'horizontal') {
      const rowStep = 18
      const rowHeight = 14
      const maxLabelLen = domain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
      const entryWidth = 16 + 8 * maxLabelLen
      const items: SceneItem[] = []
      // Legend background spans the whole entry column.
      items.push({ path: `M0,0h${entryWidth}v${n * rowStep - (rowStep - rowHeight)}h-${entryWidth}Z`, x: 0, y: 0 })
      for (let i = 0; i < n; i++) {
        const ey = i * rowStep
        items.push({ path: `M0,0h${entryWidth}v${rowHeight}h-${entryWidth}Z`, x: 0, y: ey })
        items.push({ shape: 'circle', radius: 5, x: 6, y: ey + 6, stroke: String(scale(domain[i])), strokeWidth: 1.5, opacity: 1 })
        items.push({ text: String(domain[i]), x: 16, y: ey + 9, align: 'left', fill: '#000' })
      }
      return { marktype: 'group', role: 'legend', x: 0, y: ctx.height + 24, width: entryWidth, height: n * rowStep - 4, items }
    }
    // Horizontal flow (Vega-Lite emits `direction: horizontal` for bottom
    // legends with a title). Per-entry step = entry content width + 12px gap.
    const maxLabelLen = domain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
    const entryWidth = 16 + 8 * maxLabelLen
    const step = entryWidth + 12
    const bgW = step * n - 12
    const items: SceneItem[] = []
    items.push({ path: `M0,0h${bgW}v30h-${bgW}Z`, x: 0, y: 0 })
    items.push({ text: String(legend.title ?? ''), x: 0, y: 9, align: 'left', fill: '#000' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const sx = i * step
      items.push({ path: `M0,0h${entryWidth}v14h-${entryWidth}Z`, x: sx, y: 16 })
      items.push({ shape: 'circle', radius: 5, x: sx + 6, y: 22, stroke: String(scale(value)), strokeWidth: 1.5, opacity: 0.7 })
      items.push({ text: String(value), x: sx + 16, y: 25, align: 'left', fill: '#000' })
    }
    return { marktype: 'group', role: 'legend', x: 0, y: ctx.height + 50, width: bgW, height: 30, items }
  }

  // --- corner orents (top-left / top-right / bottom-left / bottom-right) ---
  // Discrete symbol legends laid out as a row-major grid honoring `columns` and
  // `direction`. Geometry calibrated to the oracle for a fill/square legend with
  // columns:2 (entryWidth=16+8*maxLabelLen, columnPadding=10, rowPadding=2,
  // fill boxHeight=11/rowStep=13; group at (offset, offset) from the corner).
  if (/^(top|bottom)-(left|right)$/.test(orient) && !legend.size && !legend.gradientLength) {
    const colorProp = legend.fill ? 'fill' : 'stroke'
    const symType = legend.symbolType ?? 'circle'
    const isStrokeLegend = !legend.fill
    const boxHeight = isStrokeLegend ? 14 : 11
    const rowStep = isStrokeLegend ? 18 : 13
    const columnPadding = 10, rowPadding = 2
    const maxLabelLen = domain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
    const entryWidth = 16 + 8 * maxLabelLen
    const cols = legend.direction === 'vertical' ? 1 : Math.min(legend.columns ?? n, n)
    const rows = Math.ceil(n / cols)
    const titleStr = String(legend.title ?? '')
    const titleRow = titleStr ? 16 : 0
    const titleWidth = titleStr ? ~~(0.8 * titleStr.length * 11) : 0
    const gridW = cols * entryWidth + (cols - 1) * columnPadding
    const gridH = titleRow + rows * boxHeight + (rows - 1) * rowPadding
    const outerWidth = Math.max(gridW, titleWidth)
    const offset = legend.offset ?? 0
    const groupX = orient.endsWith('right') ? ctx.width - outerWidth - offset : offset
    const groupY = orient.startsWith('bottom') ? ctx.height - gridH - offset : offset
    const items: SceneItem[] = []
    items.push({ path: `M0,0h${outerWidth}v${gridH}h-${outerWidth}Z`, x: 0, y: 0 })
    if (titleStr) items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const ex = (i % cols) * (entryWidth + columnPadding)
      const ey = titleRow + Math.floor(i / cols) * rowStep
      items.push({ path: `M0,0h${entryWidth}v${boxHeight}h-${entryWidth}Z`, x: ex, y: ey })
      if (symType === 'square') {
        items.push(colorProp === 'fill'
          ? { path: 'M-5,-5h10v10h-10Z', x: ex + 6, y: ey + 6, fill: String(scale(value)), strokeWidth: 1.5 }
          : { path: 'M-5,-5h10v10h-10Z', x: ex + 6, y: ey + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
      } else {
        items.push(colorProp === 'fill'
          ? { shape: 'circle', radius: 5, x: ex + 6, y: ey + 6, fill: String(scale(value)), strokeWidth: 1.5 }
          : { shape: 'circle', radius: 5, x: ex + 6, y: ey + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
      }
      items.push({ text: String(value), x: ex + 16, y: ey + 9, align: 'left', fill: '#000' })
    }
    return { marktype: 'group', role: 'legend', x: groupX, y: groupY, width: outerWidth, height: gridH, items }
  }

  // Unsupported
  return null
}



function scaleTickPosition(scale: Scale, t: unknown): number {
  return (scale(t) as number) + (scale.bandwidth ? scale.bandwidth() / 2 : 0)
}

function roundedPos(scale: Scale, t: unknown): number {
  const pos = scaleTickPosition(scale, t)
  const bw = scale.bandwidth ? scale.bandwidth() : 0
  // Band scales: vega applies the `axisBand` tickOffset (-0.5) correction and
  // rounds — equivalent to flooring the band center. Point scales have a
  // zero-width band and round the plain scale value.
  if (bw > 0) return Math.floor(pos)
  return Math.round(pos)
}

function buildAxis(axis: CompiledAxis, ctx: EvalContext): SceneGroup | null {
  const scale = ctx.scales.get(axis.scale)
  if (!scale) return null
  const orient = axis.orient
  const ticks = axisTicks(axis, scale, ctx)
  const items: SceneItem[] = []
  const pos = (t: unknown) => roundedPos(scale, t)

  if (axis.grid) {
    for (const t of ticks) {
      const v = pos(t)
      const item: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (orient === 'left' || orient === 'right') {
        item.x = 0.5; item.x2 = ctx.width + 0.5; item.y = v + 0.5; item.y2 = v + 0.5
      } else {
        item.x = v + 0.5; item.x2 = v + 0.5; item.y = 0.5; item.y2 = ctx.height + 0.5
      }
      item.stroke = '#ddd'; item.strokeWidth = 1
      items.push(item)
    }
  }

  // The approximate tick count used for label formatting. When the axis omits
  // tickCount, vega's axis ticks operator defaults to 10 (see vega-encode
  // AxisTicks: `_.count == null ? 10 : _.count`); matching that matters for
  // log-scale labels, whose formatter only labels a subset of ticks depending
  // on the count.
  const count = (typeof axis.tickCount === "number") ? axis.tickCount : (axis.tickCount && typeof axis.tickCount === "object" && axis.tickCount.signal) ? (ctx.runtime.expr(axis.tickCount.signal)({}, ctx.signalParams) as number) || 10 : 10
  const labelFormat = axisLabelFormat(axis, scale, count, ctx)
  const tickSize = axis.tickSize ?? 5
  const labelPadding = axis.labelPadding ?? 2
  let maxLabelLen = 0
  const labels: SceneItem[] = []

  for (const t of ticks) {
    const v = pos(t)
    if (axis.ticks !== false) {
      const tick: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (orient === 'left') { tick.x = 0.5; tick.x2 = -tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'right') { tick.x = ctx.width + 0.5; tick.x2 = ctx.width + tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'bottom') { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = ctx.height + 0.5; tick.y2 = ctx.height + tickSize + 0.5 }
      else { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = 0.5; tick.y2 = -tickSize + 0.5 }
      tick.stroke = '#888'; tick.strokeWidth = 1
      items.push(tick)
    }
    if (axis.labels !== false) {
      const rawV = Math.round(scale(t) as number * 1000) / 1000
      const label: SceneItem = { text: String(labelFormat(t)), x: 0, y: 0 }
      maxLabelLen = Math.max(maxLabelLen, (label.text as string).length)
      const align = axis.labelAlign ?? (orient === 'left' ? 'right' : orient === 'right' ? 'left' : 'center')
      const baseline = axis.labelBaseline ?? (orient === 'top' ? 'bottom' : orient === 'bottom' ? 'top' : 'middle')
      // Vega bottom/top axis labels: y = tickSize + labelPadding +
      // round(0.8 * labelFontSize) from the axis line (oracle-calibrated).
      // Rotated labels get no baseline-top offset (it folds into the rotate
      // translate applied by vega's renderer).
      const labelFs = 10
      const labelAngle = typeof axis.labelAngle === 'number' ? axis.labelAngle : 0
      const axisOffset = tickSize + labelPadding + (labelAngle ? 0 : Math.round(0.8 * labelFs))
      // For band scales the label y is anchored to the band center (matching
      // vega, which places it at bandCenter - 0.5 and shifts by the middle
      // baseline); continuous scales anchor to the raw scale value.
      const bandLabelY = scale.bandwidth ? v + 3 : rawV + 3.5
      if (orient === 'left')   { label.x = -tickSize - labelPadding + 0.5; label.y = bandLabelY; label.align = align as SceneItem['align'] }
      else if (orient === 'right') { label.x = ctx.width + tickSize + labelPadding + 0.5; label.y = bandLabelY; label.align = align as SceneItem['align'] }
      else if (orient === 'bottom') {
        if (scale.bandwidth) {
          const bw = scale.bandwidth()
          // Point scales (bw = 0) miss the band-scale `axisBand` tickOffset
          // (-0.5) that cancels vega's +0.5 axis-group translate, so their
          // label anchor needs the +0.5 baked in; band labels net to
          // scale(t) + bw/2.
          label.x = (scale(t) as number) + bw / 2 + (bw > 0 ? 0 : 0.5)
        } else {
          label.x = rawV + 0.5
        }
        label.y = ctx.height + axisOffset + 0.5
        label.align = align as SceneItem['align']
        label.fontSize = labelFs
      }
      else {
        // Top axis: mirror the bottom-axis band handling so labels anchor to
        // the band center (point scales bake the +0.5 that cancels the
        // axis-group translate).
        if (scale.bandwidth) {
          const bw = scale.bandwidth()
          label.x = (scale(t) as number) + bw / 2 + (bw > 0 ? 0 : 0.5)
        } else {
          label.x = rawV + 0.5
        }
        label.y = -(tickSize + labelPadding) + Math.round(-0.21 * labelFs) + 0.5
        label.align = align as SceneItem['align']
        label.fontSize = labelFs
      }
      label.baseline = baseline as SceneItem['baseline']
      label.fill = '#000'
      labels.push(label)
      items.push(label)
    }
  }

  // Vega's axis `labelOverlap` runs the Overlap transform over the label
  // items: labels that would collide are hidden with opacity 0 (they stay in
  // the scene). `true` falls back to the parity method (hide alternating
  // labels until none overlap); 'greedy' hides items colliding with the
  // last kept item. Bounds use the same headless text estimate vega uses.
  if (axis.labelOverlap && labels.length >= 3) {
    const sep = 0
    const boundsOf = (it: SceneItem) => {
      const w = estimateTextWidth(String(it.text ?? ''), (it as { fontSize?: number }).fontSize ?? 10)
      const x = it.x ?? 0
      const x1 = it.align === 'right' ? x - w : it.align === 'center' ? x - w / 2 : x
      const y = it.y ?? 0
      return { x1, x2: x1 + w, y1: y, y2: y + 10 }
    }
    const intersects = (a: ReturnType<typeof boundsOf>, b: ReturnType<typeof boundsOf>) =>
      sep > Math.max(b.x1 - a.x2, a.x1 - b.x2, b.y1 - a.y2, a.y1 - b.y2)
    const hasOverlap = (list: SceneItem[]) => {
      for (let i = 1; i < list.length; i++) {
        if (i > 0 && intersects(boundsOf(list[i - 1]!), boundsOf(list[i]!))) return true
      }
      return false
    }
    for (const it of labels) it.opacity = 1
    let kept = labels
    if (hasOverlap(kept)) {
      if (axis.labelOverlap === 'greedy') {
        do {
          const next: SceneItem[] = []
          let prev: ReturnType<typeof boundsOf> | null = null
          for (let i = 0; i < kept.length; i++) {
            const it = kept[i]!
            const b = boundsOf(it)
            if (i === 0 || !prev || !intersects(prev, b)) { next.push(it); prev = b }
            else it.opacity = 0
          }
          kept = next
        } while (kept.length >= 3 && hasOverlap(kept))
      } else {
        do {
          const next: SceneItem[] = []
          for (let i = 0; i < kept.length; i++) {
            if (i % 2) kept[i]!.opacity = 0
            else next.push(kept[i]!)
          }
          kept = next
        } while (kept.length >= 3 && hasOverlap(kept))
      }
      // Vega: if fewer than 3 labels survive and the last source label was
      // hidden, un-hide it and hide the last survivor instead.
      const last = labels[labels.length - 1]!
      if (kept.length < 3 && !last.opacity) {
        if (kept.length > 1) kept[kept.length - 1]!.opacity = 0
        last.opacity = 1
      }
    }
  }

  const labelWidth = Math.floor(0.8 * maxLabelLen * 10)

  if (axis.domain !== false) {
    const domainLine: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
    // Compute the scale range extent for the axis domain line.
    // For non-band scales, the range values determine the axis extent.
    const scaleRange = scale.range() as number[]
    const rangeStart: number = scaleRange.length > 0 ? Number(scaleRange[0]) || 0 : 0
    const rangeEnd: number = scaleRange.length > 0 ? Number(scaleRange[scaleRange.length - 1]) || 0 : 0
    const axisStart = Math.min(rangeStart, rangeEnd)
    const axisEnd = Math.max(rangeStart, rangeEnd)
    if (orient === 'left') { domainLine.x = 0.5; domainLine.x2 = 0.5; domainLine.y = axisStart + 0.5; domainLine.y2 = axisEnd + 0.5 }
    else if (orient === 'right') { domainLine.x = ctx.width + 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = axisStart + 0.5; domainLine.y2 = axisEnd + 0.5 }
    else if (orient === 'bottom') { domainLine.x = axisStart + 0.5; domainLine.x2 = axisEnd + 0.5; domainLine.y = ctx.height + 0.5; domainLine.y2 = ctx.height + 0.5 }
    else { domainLine.x = axisStart + 0.5; domainLine.x2 = axisEnd + 0.5; domainLine.y = 0.5; domainLine.y2 = 0.5 }
    domainLine.stroke = '#888'; domainLine.strokeWidth = 1
    ;(domainLine as Record<string, unknown>)._domain = true
    items.push(domainLine)
  }

  const title = axis.title
  if (title !== undefined && title !== null && title !== '') {
    const text =
      typeof title === 'object' && 'signal' in title && title.signal !== undefined
        ? String(ctx.runtime.expr(title.signal)({}, ctx.signalParams))
        : String(title)
    const t: SceneItem = { text, x: 0, y: 0 }
    // Vega clears the laid-out tick+label extent before anchoring the title.
    // When the domain is empty no ticks/labels are produced, the extent is 0,
    // and the title sits closer to the axis (titlePadding + baseline shift).
    const hasTickMarks = ticks.length > 0
    const ticksOn = axis.ticks !== false && hasTickMarks
    const labelsOn = axis.labels !== false && hasTickMarks
    const titlePadding = (axis as { titlePadding?: number }).titlePadding ?? 4
    // Vega lays out the axis title beyond the axis content bounds:
    //   extent = (ticks ? tickSize + 0.5 : 0) + (labels ? labelPadding + 9.5 : 0)
    //   title  = extent + titlePadding + baseline offset (9 = round(0.79*11))
    // (calibrated against the oracle for ticks/labels/titlePadding variants).
    if (orient === 'bottom') {
      t.x = ctx.width / 2 + 0.5
      if (axis.labelAngle === 270 && maxLabelLen > 0) {
        const labelExtent = Math.floor(0.8 * maxLabelLen * 10)
        t.y = ctx.height + 0.5 + tickSize + labelPadding + labelExtent + 4 + 11 - 2
      } else {
        const ext = 0.5 + (ticksOn ? tickSize + 0.5 : 0) + (labelsOn ? labelPadding + 9.5 : 0)
        t.y = ctx.height + ext + titlePadding + 9
      }
      t.align = 'center'; t.baseline = 'top'
    }
    else if (orient === 'top') { t.x = ctx.width / 2 + 0.5; t.y = -tickSize - 10 + 0.5; t.align = 'center'; t.baseline = 'bottom' }
    else if (orient === 'left') {
      // Ticks present + labels off: the title sits at tickSize + titlePadding.
      t.x = (hasTickMarks && axis.labels === false)
        ? -(tickSize + titlePadding)
        : -((hasTickMarks && axis.labels !== false ? labelPadding : 0) + (hasTickMarks ? tickSize : 0) + labelWidth + 3.5)
      t.y = ctx.height / 2 + 0.5; t.align = 'center'; t.baseline = 'bottom'
      // Vega rotates left/right axis titles (angle ∓90, baseline bottom); the
      // content-bounds scan then uses vega's exact rotated text bbox.
      ;(t as Record<string, unknown>).angle = (axis as { titleAngle?: number }).titleAngle ?? -90
    }
    else if (orient === 'right') { t.x = ctx.width + tickSize + labelPadding + labelWidth + 4.5; t.y = ctx.height / 2 + 0.5; t.align = 'center'; t.baseline = 'bottom'; ;(t as Record<string, unknown>).angle = (axis as { titleAngle?: number }).titleAngle ?? 90 }
    t.fill = '#000'
    items.push(t)
  }

  return {
    marktype: 'group',
    role: 'axis',
    items,
    // axis geometry for the vega-faithful bounds port (boundAxisGroup):
    // `range` is the spine extent along the axis line; `baseline` is the
    // perpendicular position of the axis line (content bottom for bottom,
    // content top for top, 0 for left, content right for right). These diverge
    // once autosize fit shrinks width != height, so both are needed.
    ...(orient === 'left' || orient === 'right'
      ? { axis: { orient, range: ctx.height, baseline: orient === 'right' ? ctx.width : 0 } }
      : { axis: { orient, range: ctx.width, baseline: orient === 'bottom' ? ctx.height : 0 } }),
  } as SceneGroup
}

function axisTicks(axis: CompiledAxis, scale: Scale, ctx: EvalContext): unknown[] {
  // Explicit `values` override any generated ticks (vega AxisTicks sorts them).
  if (axis.values !== undefined) {
    let vs: unknown = axis.values
    if (vs && typeof vs === 'object' && !Array.isArray(vs) && 'signal' in (vs as Record<string, unknown>)) {
      try {
        vs = ctx.runtime.expr((vs as { signal: string }).signal)({}, ctx.signalParams)
      } catch {
        return []
      }
    }
    if (Array.isArray(vs)) {
      const toNum = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Number(v)
      return vs.filter((v) => v != null).sort((a, b) => toNum(a) - toNum(b))
    }
    return []
  }
  let count: number | undefined
  if (typeof axis.tickCount === 'number') count = axis.tickCount
  else if (axis.tickCount && typeof axis.tickCount === 'object') {
    const expr = (axis.tickCount as { signal?: string }).signal
    if (expr !== undefined) {
      const v = ctx.runtime.expr(expr)({}, ctx.signalParams)
      count = typeof v === 'number' ? v : undefined
    }
  }
  // Resolve tickMinStep (may be a number or a signal expression).
  let tickMinStep: number | undefined
  if (typeof axis.tickMinStep === 'number') {
    tickMinStep = axis.tickMinStep
  } else if (axis.tickMinStep && typeof axis.tickMinStep === 'object') {
    const sig = (axis.tickMinStep as { signal?: string }).signal
    if (sig !== undefined) {
      try {
        const v = ctx.runtime.expr(sig)({}, ctx.signalParams)
        if (typeof v === 'number' && Number.isFinite(v)) tickMinStep = v
      } catch { /* ignore */ }
    }
  }

  // For continuous non-time scales with tickMinStep but no tickCount, generate
  // ticks directly from the scale domain using the step value.
  // For time/utc scales, d3's time ticks already produce calendar-aligned
  // intervals, so we use scaleTicks normally and apply tickMinStep as a filter.
  if (tickMinStep != null && tickMinStep > 0 && count == null
      && scale.type !== 'time' && scale.type !== 'utc') {
    const rawDomain = scale.domain()
    const toNum = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Number(v)
    if (rawDomain.length >= 2) {
      const d0 = toNum(rawDomain[0])
      const d1 = toNum(rawDomain[rawDomain.length - 1])
      if (Number.isFinite(d0) && Number.isFinite(d1)) {
        const ticks: unknown[] = []
        const eps = tickMinStep * 1e-9
        for (let v = d0; v <= d1 + eps; v += tickMinStep) {
          ticks.push(v)
        }
        return ticks
      }
    }
  }

  // For time/utc scales, generate calendar-aligned ticks when tickMinStep is
  // specified (matching vega's AxisTicks behavior). The tickMinStep signal
  // encodes the duration of a calendar unit (e.g. one month in ms). We step
  // through calendar months from the domain start to end to produce ticks that
  // align to month boundaries, avoiding the problem of fixed-interval stepping
  // across months of different lengths.
  if ((scale.type === 'time' || scale.type === 'utc') && tickMinStep != null && tickMinStep > 0 && count == null) {
    const rawDomain = scale.domain()
    if (rawDomain.length >= 2) {
      const toD = (v: unknown): Date => v instanceof Date ? v : new Date(Number(v))
      const d0 = toD(rawDomain[0])
      const d1 = toD(rawDomain[rawDomain.length - 1])
      if (Number.isFinite(d0.getTime()) && Number.isFinite(d1.getTime())) {
        const ticks: unknown[] = []
        const cur = new Date(d0.getTime())
        while (cur.getTime() <= d1.getTime() + 1000) {
          ticks.push(new Date(cur.getTime()))
          cur.setUTCMonth(cur.getUTCMonth() + 1)
        }
        return ticks
      }
    }
  }
  if (scale.type === 'time' || scale.type === 'utc') {
    const timeTicks = scaleTicks(scale, count)
    // When tickMinStep is specified, filter time ticks so consecutive values
    // are at least tickMinStep apart (matching vega's AxisTicks behavior).
    if (tickMinStep != null && tickMinStep > 0 && timeTicks.length > 1) {
      const toNum = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Number(v)
      const filtered: unknown[] = [timeTicks[0]]
      let last = toNum(timeTicks[0])
      for (let i = 1; i < timeTicks.length; i++) {
        const t = toNum(timeTicks[i])
        if (Math.abs(t - last) >= tickMinStep - 1e-6) {
          filtered.push(timeTicks[i])
          last = t
        }
      }
      return filtered
    }
    return timeTicks
  }

  const ticks = scaleTicks(scale, count)
  // When tickMinStep is specified, filter ticks so consecutive values are at
  // least tickMinStep apart (matching vega's AxisTicks + tickMinStep filter).
  if (tickMinStep != null && tickMinStep > 0 && ticks.length > 1) {
    const toNum = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Number(v)
    const filtered: unknown[] = [ticks[0]]
    let last = toNum(ticks[0])
    for (let i = 1; i < ticks.length; i++) {
      const t = toNum(ticks[i])
      if (Math.abs(t - last) >= tickMinStep - 1e-6) {
        filtered.push(ticks[i])
        last = t
      }
    }
    return filtered
  }
  return ticks
}

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number, ctx?: EvalContext): (v: unknown) => string {
  const specFmt = (axis.encode?.labels?.text as EncodeValue | undefined)
  if (specFmt && typeof specFmt === 'object' && 'signal' in specFmt && specFmt.signal) {
    return () => String(specFmt.signal)
  }
  const fmtType = (specFmt && typeof specFmt === 'object' && 'formatType' in specFmt && specFmt.formatType)
    ? String(specFmt.formatType)
    : (axis.formatType ? axis.formatType : undefined)
  // Resolve format: may be a string or a signal expression.
  let fmt: string | undefined
  const rawFmt = (specFmt && typeof specFmt === 'object' && 'format' in specFmt && specFmt.format)
    ? specFmt.format
    : (axis.format ?? undefined)
  if (typeof rawFmt === 'string') {
    fmt = rawFmt
  } else if (rawFmt && typeof rawFmt === 'object' && 'signal' in (rawFmt as Record<string, unknown>) && ctx) {
    try {
      const v = ctx.runtime.expr((rawFmt as { signal: string }).signal)({}, ctx.signalParams)
      if (typeof v === 'string') fmt = v
    } catch {
      // Fallback: evaluate timeUnitSpecifier(...) inline when the expression
      // engine doesn't have it.  This is the common case for Vega-Lite
      // temporal axes whose format signal is
      //   timeUnitSpecifier(["month"], {"year-month":"%b %Y ", ...})
      const sig = (rawFmt as { signal: string }).signal
      if (ctx) {
        const resolved = evalTimeUnitSpecifier(sig)
        if (resolved !== undefined) fmt = resolved
      }
    }
  }
  if (fmtType === 'time' || scale.type === 'time' || scale.type === 'utc') {
    const L = locale(undefined)
    // With no explicit format vega uses the time multi-format, which picks a
    // specifier per tick interval (e.g. '%B' for month ticks, '%b %d' for
    // day/week ticks). The `undefined` argument is passed explicitly to satisfy
    // the strict local type shim for vega-format.
    return fmt ? L.timeFormat(fmt) : L.timeFormat(undefined as unknown as string)
  }
  if (scale.type !== 'linear' && scale.type !== 'log' && scale.type !== 'pow' && scale.type !== 'sqrt' && scale.type !== 'symlog') {
    return (v) => String(v)
  }
  const L = locale(undefined)
  return tickFormat(L, scale, count, fmt)

}

// ---------------------------------------------------------------------------
// timeUnitSpecifier — inline fallback for Vega-Lite temporal axis format
// signals.  Mirrors vega-time/src/units.js `timeUnitSpecifier`.
// ---------------------------------------------------------------------------

const TU_ORDER: Record<string, number> = {
  year: 1, quarter: 2, month: 3, week: 4, date: 5,
  day: 6, dayofyear: 7, hours: 8, minutes: 9, seconds: 10, milliseconds: 11,
}
const TU_DEFAULTS: Record<string, string> = {
  year: '%Y ', quarter: 'Q%q ', month: '%b ', date: '%d ',
  week: 'W%U ', day: '%a ', dayofyear: '%j ',
  hours: '%H:00', minutes: '00:%M', seconds: ':%S', milliseconds: '.%L',
  'year-month': '%Y-%m ', 'year-month-date': '%Y-%m-%d ', 'hours-minutes': '%H:%M',
}

/**
 * Evaluate a `timeUnitSpecifier(["unit", ...], {overrides})` expression string.
 * Returns the resolved format string, or undefined when the string does not match.
 */
function evalTimeUnitSpecifier(sig: string): string | undefined {
  const m = /^\s*timeUnitSpecifier\(\s*(\[.*?\])\s*(?:,\s*(\{.*?\}))?\s*\)\s*$/.exec(sig)
  if (!m) return undefined
  let units: string[]
  try { units = JSON.parse(m[1]!) } catch { return undefined }
  if (!Array.isArray(units)) return undefined
  let overrides: Record<string, string> = {}
  if (m[2]) {
    try { overrides = JSON.parse(m[2]!) } catch { /* ignore */ }
  }
  const u = units.slice()
    .filter((unit) => unit in TU_ORDER)
    .sort((a, b) => (TU_ORDER[a] ?? 99) - (TU_ORDER[b] ?? 99))
  const s = { ...TU_DEFAULTS, ...overrides }
  let fmt = ''
  let start = 0
  const n = u.length
  while (start < n) {
    let found = false
    for (let end = n; end > start; --end) {
      const key = u.slice(start, end).join('-')
      if (s[key] != null) {
        fmt += s[key]
        start = end
        found = true
        break
      }
    }
    if (!found) break
  }
  return fmt.trim() || undefined
}
