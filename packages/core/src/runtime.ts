/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, type ExpressionRuntime } from './expression.js'
import { applyTransforms, sortRows, type Row } from './transform.js'
import { buildScale, scaleTicks, type Scale, CONTINUOUS_TYPES, type ColorScale } from './scales.js'
import { locale, defaultLocale } from 'vega-format'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledLegend,
  CompiledMark,
  EncodeValue,
  RuntimeInput,
  SceneGroup,
  SceneItem,
  SceneRoot,
  SizeSpec,
  VgSpec,
} from './types.js'
import { tickFormat } from 'vega-scale'
import { compileChart } from './compiler.js'

const DEFAULT_SIZE = 500

interface EvalContext {
  chart: CompiledChart
  signalParams: Record<string, unknown>
  width: number
  height: number
  datasets: Map<string, Row[]>
  scales: Map<string, Scale>
  scaleTypes: Map<string, string>
  runtime: ExpressionRuntime
  _defs: Array<{ id: string; colorStops: Array<{ offset: number; color: string }> }>
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
  const runtime: ExpressionRuntime = {
    scale: (name) => scales.get(name),
    data: (name) => datasets.get(name),
    expr: (expr) => compileExpr(expr, runtime),
  }

  const defs: Array<{ id: string; colorStops: Array<{ offset: number; color: string }> }> = []
  const ctx: EvalContext = { chart, signalParams, width, height, datasets, scales, scaleTypes, runtime, _defs: defs }

  buildDatasets(ctx, input.data ?? {})
  // Remap Vega-Lite "category" range (unhandled by vega-scale) to tableau10
  for (const s of ctx.chart.scales) {
    if (s.range === 'category') { ; (s as unknown as Record<string, unknown>).range = 'tableau10' }
  }
  buildScales(ctx)

  return { ctx, width, height }
}


// ===========================================================================
// Shared axis/legend + padding computation — used by both evaluateChart and getChartInfo
// ===========================================================================

interface AxisLegendResult {
  groups: SceneGroup[]
  padding: { top: number; right: number; bottom: number; left: number }
}

function buildAxisAndLegend(
  ctx: EvalContext,
  width: number,
  height: number,
  basePadding: { top: number; right: number; bottom: number; left: number },
): AxisLegendResult {
  const groups: SceneGroup[] = []

  for (const axis of ctx.chart.axes) {
    const group = buildAxis(axis, ctx)
    if (group) groups.push(group)
  }
  for (const legend of ctx.chart.legends) {
    const group = buildLegend(legend, ctx)
    if (group) groups.push(group)
  }

  const pad = computeGuidePadding(groups, width, height, basePadding)
  return { groups, padding: pad }
}

function computeGuidePadding(
  items: SceneGroup[],
  width: number,
  height: number,
  base: { top: number; right: number; bottom: number; left: number },
): { top: number; right: number; bottom: number; left: number } {
  let minX = 0
  let maxX = width
  let minY = 0
  let maxY = height
  const M = 5

  for (const group of items) {
    if (group.role === 'axis') {
      const subItems = group.items ?? []
      for (const s of subItems) {
        if (s.text != null) {
          const sx = s.x ?? 0
          const sy = s.y ?? 0
          minX = Math.min(minX, sx)
          maxX = Math.max(maxX, sx)
          minY = Math.min(minY, sy)
          maxY = Math.max(maxY, sy)
        }
      }
    } else if (group.role === 'legend') {
      const gx = group.x ?? 0
      const gy = group.y ?? 0
      const gw = group.width ?? 0
      const gh = group.height ?? 0
      minX = Math.min(minX, gx)
      maxX = Math.max(maxX, gx + gw)
      minY = Math.min(minY, gy)
      maxY = Math.max(maxY, gy + gh)
    }
  }

  return {
    left:   Math.max(base.left,   M + Math.max(0, -minX)),
    right:  Math.max(base.right,  M + Math.max(0, maxX - width)),
    top:    Math.max(base.top,    M + Math.max(0, -minY)),
    bottom: Math.max(base.bottom, M + Math.max(0, maxY - height)),
  }
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const { ctx, width, height } = prepareChartCtx(chart, input)

  const items: SceneGroup[] = []

  // 1) Build marks (plot area)
  for (const mark of ctx.chart.marks) {
    const result = evaluateMark(mark, ctx)
    if (result) {
      if (Array.isArray(result)) {
        for (const g of result) items.push(g)
      } else {
        items.push(result)
      }
    }
  }

  // 2) Build axes + legends and compute padding
  const { groups: guideGroups, padding } = buildAxisAndLegend(ctx, width, height, ctx.chart.padding)

  // Merge guide groups into items
  for (const g of guideGroups) items.push(g)

  // 3) Build the scene
  let sceneWidth: number
  let sceneHeight: number
  const hasFacetMarks = (ctx as any).chart.marks?.some((m: any) => m.from?.facet?.groupby?.length > 0) ?? false
  const hasChildSignals = ctx.signalParams['child_width'] !== undefined && ctx.signalParams['child_height'] !== undefined
  const isFacetSpec = hasFacetMarks && hasChildSignals
  const isConcat = isConcatSpec(ctx.chart)
  
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
      // Concat with signal-based cell width and explicit height: vega renders the
      // viewport at the SVG minimum width (10) but uses the real chart height.
      sceneWidth = 10
      sceneHeight = height + ctx.chart.padding.top + ctx.chart.padding.bottom
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

  // Build axes+legends and compute the same padding that evaluateChart uses
  const { padding } = buildAxisAndLegend(ctx, width, height, chart.padding)

  return {
    width,
    height,
    padding: chart.autosize === 'none' ? chart.padding : padding,
    scales: ctx.scales,
  }
}

function resolveSize(size: SizeSpec, override: number | undefined, signals: Record<string, unknown>): number {
  if (typeof size === 'number' && Number.isFinite(size)) return size
  if (size && typeof size === 'object') {
    if ('signal' in size) {
      const v = signals[size.signal]
      return override ?? (typeof v === 'number' ? v : DEFAULT_SIZE)
    }
    if ('step' in size) {
      throw new Error('[aster] width/height {step} sizing is not supported yet')
    }
  }
  return override ?? DEFAULT_SIZE
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
      rows = build(src, seen).map((r) => ({ ...r }))
    } else if (d.values) {
      rows = (inputData[name] as Row[]) ?? (d.values as Row[]).map((r) => ({ ...r }))
    } else {
      rows = ((inputData[name] as Row[]) ?? []).map((r) => ({ ...r }))
    }
    if (d.transform.length) {
      rows = applyTransforms(rows, d.transform, {
        runtime: ctx.runtime,
        signals: ctx.signalParams,
      })
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
    const scale = buildScale(s, {
      width: ctx.width,
      height: ctx.height,
      signals: scaleSignals,
      evaluate: (expr) => ctx.runtime.expr(expr)({}, ctx.signalParams),
      dataField: (dataName, field) => {
        const rows = ctx.datasets.get(dataName) ?? []
        const out: unknown[] = []
        for (const r of rows) out.push(r[field])
        return out
      },
    })
    // Vega extends the domain of quantitative scales by `padding` pixels before
    // re-nicing; d3-scale's linear scale has no `padding` option, so replicate
    // vega's behavior here. Only applies to continuous quantitative scales.
    const Q = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog'])
    if (Q.has(s.type) && s.padding != null && typeof (scale as any).domain === 'function') {
      const rng = (scale as any).range ? (scale as any).range() as number[] : [0, ctx.width]
      const rangeExtent = Math.abs(rng[rng.length - 1]! - rng[0]!) || 1
      const dom = (scale as any).domain() as number[]
      if (dom.length >= 2 && Number.isFinite(dom[0]) && Number.isFinite(dom[1])) {
        const d0 = dom[0]!, d1 = dom[1]!
        const ext = (s.padding * (d1 - d0)) / rangeExtent
        ;(scale as any).domain([d0 - ext, d1 + ext])
        if (typeof (scale as any).nice === 'function') (scale as any).nice()
      }
    }
    ctx.scales.set(s.name, scale)
    ctx.scaleTypes.set(s.name, s.type)
  }
}

function evaluateMark(
  mark: CompiledMark,
  ctx: EvalContext,
): SceneGroup | SceneGroup[] | null {
  if (mark.type === 'group') {
    return buildGroupMark(mark, ctx)
  }
  const source = mark.from?.data

  let items: SceneItem[]
  if (source) {
    let rows = (ctx.datasets.get(source) ?? []).map((r) => ({ ...r }))
    if (mark.sort) rows = sortRows(rows, mark.sort)

    // Sort rect marks by their scale y field so rendering order matches vega:
    // bars with smaller y-value render first (appear at the front).
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
            break
          }
        }
      }
    }

    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    items = rows.map((row) => {
      const res = resolveEncodeSet(update, row, ctx, mark.type)
      res.datum = row
      return res
    })
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
  return mark.type === 'group'
    && !(mark.from as any)?.facet
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
  // Header groups
  if (mark.name.includes('header')) {
    if (orient === 'column' && mark.name === 'row_header') return buildColumnFacetRowHeader(mark, ctx)
    if (orient === 'column' && mark.name === 'column_header') return buildColumnHeaderGroup(mark, ctx)
    return buildRowHeaderGroup(mark, ctx)
  }
  // Footer groups
  if (mark.name.includes('footer')) {
    if (orient === 'column') return buildColumnFooterGroupColumn(mark, ctx)
    return buildColumnFooterGroup(mark, ctx)
  }
  throw new Error('[aster] unsupported group mark: ' + mark.name)
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

function buildFacetCellGroup(
  mark: CompiledMark,
  facet: { name: string; data: string; groupby: string[] },
  ctx: EvalContext,
): SceneGroup[] {
  const rows = ctx.datasets.get(facet.data) ?? []
  const grouped = inlineGroupRows(rows, facet.groupby)
  if (!grouped.length) return []

  let cellWidth = 500, cellHeight = 500
  const enc = mark.encode?.update
  if (enc) {
    const ws = (enc.width as { signal?: string } | undefined)?.signal
    const hs = (enc.height as { signal?: string } | undefined)?.signal
    if (ws !== undefined && ctx.signalParams[ws] !== undefined && !Array.isArray(ctx.signalParams[ws]))
      cellWidth = Number(ctx.signalParams[ws])
    if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
      cellHeight = Number(ctx.signalParams[hs])
  }

  const firstKey = facet.groupby[0]!
  const valueSet = new Set<string>()
  for (const r of rows) valueSet.add(String(r[firstKey]))
  let facetValues = [...valueSet]
  if (mark.sort?.field) {
    try {
      const expr = ctx.runtime.expr(mark.sort.field as string)
      facetValues.sort((a, b) => {
        const cmp = expr({ _aster_a: a, _aster_b: b }, ctx.signalParams) as number
        return Number(cmp ?? 0)
      })
    } catch {}
  }

  const orient = getFacetOrientation(ctx)
  const isRow = orient !== 'column'
  const spacing = isRow ? ROW_SPACING : COLUMN_SPACING
  const result: SceneGroup[] = []

  for (let gi = 0; gi < grouped.length; gi++) {
    const g = grouped[gi]!
    if (!g.length) continue
    ctx.datasets.set(facet.name, g)

    const cellX = isRow ? 0 : gi * (cellWidth + spacing)
    const cellY = isRow ? gi * (cellHeight + spacing) : 0

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
    // Each facet cell carries a 0.5px-inset stroke='#ddd' background the size of
    // the cell, matching vega's `style: cell` default background path.
    cellItems.push({
      path: `M0.5,0.5h${cellWidth}v${cellHeight}h-${cellWidth}Z`,
      x: 0, y: 0, stroke: '#ddd',
    } as SceneItem)

    result.push({
      marktype: 'group', name: mark.name, role: 'scope',
      items: cellItems,
      clip: mark.clip === true,
      width: cellWidth, height: cellHeight,
      x: cellX, y: cellY,
    })
  }
  return result
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
      width: grpW, x: -1, y: i * (cellHeight + ROW_SPACING),
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
  const footerY = (n - 1) * (cellHeight + ROW_SPACING) + cellHeight + 1

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

  const centerY = Math.round(((n - 1) * (ROW_SPACING + cellHeight) + cellHeight) / 2)

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
    if (hs !== undefined && ctx.signalParams[hs] !== undefined && !Array.isArray(ctx.signalParams[hs]))
      height = Number(ctx.signalParams[hs])
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

  const fkey: string = facet.groupby[0]!
  const orient = getFacetOrientation(ctx)
  const spacing = orient === 'column' ? COLUMN_SPACING : ROW_SPACING

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
    const cellX = i * (cellWidth + spacing)
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

  const fkey: string = facet.groupby[0]!
  const orient = getFacetOrientation(ctx)
  const spacing = orient === 'column' ? COLUMN_SPACING : ROW_SPACING
  const footerY = cellHeight + 1

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
    const cellX = i * (cellWidth + spacing)
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
  let centerX: number
  if (cellMark) {
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
// Horizontal concat support
// ===========================================================================

const CONCAT_BASE_SPACING = 29
const TITLE_FONT_SIZE = 11

/** Build a single concat cell group mark (point/bar/etc. with its own axes). */
function buildConcatGroup(mark: CompiledMark, ctx: EvalContext): SceneGroup {
  const idxMatch = mark.name.match(/concat_(\d+)_group/)
  const idx = idxMatch ? parseInt(idxMatch[1]!, 10) : 0
  const { width: cellWidth, height: cellHeight } = readCellSize(mark, ctx, 500, 500)

  const tmpCtx: EvalContext = { ...ctx, width: cellWidth, height: cellHeight }
  const axisItems: SceneItem[] = []
  for (const as of (mark as any).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as, tmpCtx)
      if (a) axisItems.push(a)
    }
  }

  // Determine the per-cell horizontal advance from the y-axis left extent so the
  // next cell's y-axis clears this cell's content + base spacing.
  let yAxisExtent = 0
  for (const ag of axisItems) {
    for (const it of (ag as SceneGroup).items ?? []) {
      if ((it as SceneItem).text != null && typeof (it as SceneItem).x === 'number' && (it as SceneItem).x! < 0) {
        yAxisExtent = Math.max(yAxisExtent, Math.ceil(Math.abs((it as SceneItem).x as number) + TITLE_FONT_SIZE + 0.5))
      }
    }
  }
  const advance = cellWidth + CONCAT_BASE_SPACING + yAxisExtent
  const cellX = idx * advance

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
    x: cellX, y: 0,
  }
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

  return { marktype: mark.type, name: mark.name, role: 'mark', clip: mark.clip === true, items }
}

function resolveEncodeSet(encode: Record<string, EncodeValue | EncodeValue[]>, datum: Row, ctx: EvalContext, marktype: string): SceneItem {
  // Pass 1: resolve all non-signal values and accumulate them.
  const ctxItem: Record<string, unknown> = {}
  const signalSpecs: Array<{ key: string; spec: EncodeValue | EncodeValue[] }> = []

  for (const key of Object.keys(encode)) {
    const spec = encode[key]
    if (typeof spec === 'object' && spec != null && 'signal' in spec) {
      signalSpecs.push({ key, spec })
      continue
    }
    const resolved = resolveEncodeProperty(spec, datum, ctx)
    if (resolved !== undefined) {
      ctxItem[key] = resolved
    }
  }

  // Pass 2: resolve signal-value pairs. datum gets the resolved values appended.
  const item: SceneItem = {}
  for (const k in ctxItem) {
    datum[k as keyof Row] = ctxItem[k] as unknown
    ;(item as unknown as Record<string, unknown>)[k] = ctxItem[k]
  }
  for (const { key, spec } of signalSpecs) {
    const resolved = resolveEncodeProperty(spec, datum, ctx)
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
      raw = datum[field as string]
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
    let v = datum[value.field as string]
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
  const L = locale(defaultLocale)
  if (formatType === 'time' || v instanceof Date) return L.timeFormat(fmt)(v as Date)
  return L.format(fmt)(v as number)
}


function buildLegend(legend: CompiledLegend, ctx: EvalContext): SceneGroup | null {
  // Resolve the scale name
  const scaleName = legend.stroke ?? legend.fill
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
  if (CONTINUOUS_TYPES.has(scaleType) && legend.gradientLength != null) {
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

    // Compute tick values using scale.ticks with L/50 as hint
    const tickNums = scale.ticks ? scale.ticks(L / 50) : []

    const items: SceneItem[] = []
    // Background box (0,0 to 42, 16+L)
    items.push({ path: `M0,0h42v${16 + L}h-42Z`, x: 0, y: 0 })
    // Gradient rect at legend-relative (0, 16), 16xL
    items.push({
      path: `M0,0h16v${L}h-16Z`,
      x: 0, y: 16,
      fill: 'url(#gradient_0)',
      stroke: '#ddd',
      strokeWidth: 0,
      opacity: 0.7,
    })
    // Title
    items.push({ text: String(legend.title ?? ''), x: 0, y: 9, align: 'left', fill: '#000' })
    // Labels
    const d0n = typeof d0 === 'number' ? d0 : 0
    const d1n = typeof d1 === 'number' ? d1 : 1
    for (const t of tickNums) {
      const tNum = typeof t === 'number' ? t : 0
      const yPos = 16 + 3 + L * ((d1n - tNum) / (d1n - d0n))
      items.push({ text: String(tNum), x: 18, y: yPos, align: 'left', fill: '#000' })
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
      width: 42,
      height: 16 + L,
      items,
    }
    if (stops.length) {
      ctx._defs.push({ id: 'gradient_0', colorStops: stops })
    }
    return group
  }

  // --- Symbol legend (discrete) ---
  const n = domain.length

  // --- 'right' (default) ---
  if (orient === 'right' || orient === undefined) {
    // Detect fill vs stroke legend channel and legend encode style.
    // Fill legends (e.g. arc-pie): fill=color, no stroke, opacity=1, step=13, box=11
    // Stroke legends (e.g. legend-scatter): stroke=color, no fill, opacity=0.7, step=18, box=14
    const colorProp = legend.fill ? 'fill' : 'stroke'
    const isStrokeLegend = !legend.fill
    // For fill legends use Vega defaults; for stroke legends use the styled (scatter) params
    const entryStep = isStrokeLegend ? 18 : 13
    const boxHeight = isStrokeLegend ? 14 : 11
    const bgHeight = 16 + boxHeight + entryStep * (n - 1)

    // Vega measures text width as ~~(0.8 * len * fontSize) when no canvas is
    // available (vega-scenegraph estimateWidth). Labels render at 10px, the
    // legend title at 11px bold. The entry content width is the symbol offset
    // (16) plus the widest label; the outer background spans the larger of the
    // entry content and the title.
    const maxLabelLen = domain.reduce((m: number, v) => Math.max(m, String(v).length), 0)
    const entryWidth = 16 + 8 * maxLabelLen
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? ~~(0.8 * titleStr.length * 11) : 0
    const outerWidth = Math.max(entryWidth, titleWidth)

    const items: SceneItem[] = []
    items.push({ path: `M0,0h${outerWidth}v${bgHeight}h-${outerWidth}Z`, x: 0, y: 0 })
    items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const off = 16 + i * entryStep
      items.push({ path: `M0,0h${entryWidth}v${boxHeight}h-${entryWidth}Z`, x: 0, y: off })
      if (colorProp === 'fill') {
        items.push({ shape: 'circle', radius: 5, x: 6, y: off + 6, fill: String(scale(value)), strokeWidth: 1.5 })
      } else {
        items.push({ shape: 'circle', radius: 5, x: 6, y: off + 6, stroke: String(scale(value)), strokeWidth: 1.5, opacity: 0.7 })
      }
      items.push({ text: String(value), x: 16, y: off + 9, align: 'left', fill: '#000' })
    }
    return { marktype: 'group', role: 'legend', x: ctx.width + 18, y: 0, width: outerWidth, height: bgHeight, items }
  }

  // --- 'bottom' ---
  if (orient === 'bottom') {
    // Per-entry step = entry content width (symbol offset 16 + label width) +
    // 12px gap. Outer width = step * n - 12 (last entry has no trailing gap).
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

  // Unsupported
  return null
}



function scaleTickPosition(scale: Scale, t: unknown): number {
  return (scale(t) as number) + (scale.bandwidth ? scale.bandwidth() / 2 : 0)
}

function roundedPos(scale: Scale, t: unknown): number {
  const pos = scaleTickPosition(scale, t)
  if (scale.bandwidth) return Math.floor(pos)
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

  const count = (typeof axis.tickCount === "number") ? axis.tickCount : (axis.tickCount && typeof axis.tickCount === "object" && axis.tickCount.signal) ? (ctx.runtime.expr(axis.tickCount.signal)({}, ctx.signalParams) as number) || 5 : 5
  const labelFormat = axisLabelFormat(axis, scale, count)
  const tickSize = axis.tickSize ?? 5
  const labelPadding = axis.labelPadding ?? 2
  let maxLabelLen = 0

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
      if (orient === 'left')   { label.x = -tickSize - labelPadding + 0.5; label.y = rawV + 3.5; label.align = align as SceneItem['align'] }
      else if (orient === 'right') { label.x = ctx.width + tickSize + labelPadding + 0.5; label.y = rawV + 3.5; label.align = align as SceneItem['align'] }
      else if (orient === 'bottom') { if (scale.bandwidth) { label.x = (scale(t) as number) + scale.bandwidth() / 2; label.y = ctx.height + 7 + 0.5 } else { label.x = rawV + 0.5; label.y = ctx.height + 15 + 0.5 } label.align = align as SceneItem['align'] }
      else { label.x = rawV + 0.5; label.y = -tickSize - 10 + 0.5; label.align = align as SceneItem['align'] }
      label.baseline = baseline as SceneItem['baseline']
      label.fill = '#000'
      items.push(label)
    }
  }

  const labelWidth = Math.floor(0.8 * maxLabelLen * 10)

  if (axis.domain !== false) {
    const domainLine: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
    if (orient === 'left') { domainLine.x = 0.5; domainLine.x2 = 0.5; domainLine.y = 0.5; domainLine.y2 = ctx.height + 0.5 }
    else if (orient === 'right') { domainLine.x = ctx.width + 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = 0.5; domainLine.y2 = ctx.height + 0.5 }
    else if (orient === 'bottom') { domainLine.x = 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = ctx.height + 0.5; domainLine.y2 = ctx.height + 0.5 }
    else { domainLine.x = 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = 0.5; domainLine.y2 = 0.5 }
    domainLine.stroke = '#888'; domainLine.strokeWidth = 1
    items.push(domainLine)
  }

  const title = axis.title
  if (title !== undefined && title !== null && title !== '') {
    const text =
      typeof title === 'object' && 'signal' in title && title.signal !== undefined
        ? String(ctx.runtime.expr(title.signal)({}, ctx.signalParams))
        : String(title)
    const t: SceneItem = { text, x: 0, y: 0 }
    if (orient === 'bottom')  { t.x = ctx.width / 2 + 0.5; t.y = ctx.height + (scale.bandwidth ? 28 : 30) + 0.5; t.align = 'center'; t.baseline = 'top' }
    else if (orient === 'top') { t.x = ctx.width / 2 + 0.5; t.y = -tickSize - 10 + 0.5; t.align = 'center'; t.baseline = 'bottom' }
    else if (orient === 'left') { t.x = -(tickSize + labelPadding + labelWidth + 3.5); t.y = ctx.height / 2 + 0.5; t.align = 'center' }
    else if (orient === 'right') { t.x = ctx.width + tickSize + labelPadding + labelWidth + 4.5; t.y = ctx.height / 2 + 0.5; t.align = 'center' }
    t.fill = '#000'
    items.push(t)
  }

  return {
    marktype: 'group',
    role: 'axis',
    items,
  }
}

function axisTicks(axis: CompiledAxis, scale: Scale, ctx: EvalContext): unknown[] {
  let count: number | undefined
  if (typeof axis.tickCount === 'number') count = axis.tickCount
  else if (axis.tickCount && typeof axis.tickCount === 'object') {
    const expr = axis.tickCount.signal
    if (expr !== undefined) {
      const v = ctx.runtime.expr(expr)({}, ctx.signalParams)
      count = typeof v === 'number' ? v : undefined
    }
  }
  return scaleTicks(scale, count)
}

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number): (v: unknown) => string {
  const specFmt = (axis.encode?.labels?.text as EncodeValue | undefined)
  if (specFmt && typeof specFmt === 'object' && 'signal' in specFmt && specFmt.signal) {
    return () => String(specFmt.signal)
  }
  const fmtType = (specFmt && typeof specFmt === 'object' && 'formatType' in specFmt && specFmt.formatType) ? String(specFmt.formatType) : undefined
  const fmt = (specFmt && typeof specFmt === 'object' && 'format' in specFmt && specFmt.format) ? String(specFmt.format) : undefined
  if (fmtType === 'time' || scale.type === 'time' || scale.type === 'utc') {
    const L = locale(defaultLocale)
    return fmt ? L.timeFormat(fmt) : L.timeFormat('%b %d')
  }
  if (scale.type !== 'linear' && scale.type !== 'log' && scale.type !== 'pow' && scale.type !== 'sqrt' && scale.type !== 'symlog') {
    return (v) => String(v)
  }
  const L = locale(defaultLocale)
  return tickFormat(L, scale, count, fmt)

}
