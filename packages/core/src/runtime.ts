/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { readData, type DataFormatSpec } from './data-format.js'
import { applyTransforms, sortRows, sortOrder, getField, geoJSONPath, computeBinStep, computeBinEps, aggregateGroup, type Row, type TransformContext } from './transform.js'
import { AsterLimitError } from './limits.js'
import { withTextMetricsProvider } from './text-metrics.js'
import { buildScale, scaleTicks, type Scale, CONTINUOUS_TYPES, type ColorScale } from './scales.js'

/** Scale types whose domain is an ordered set of discrete values. */
const DISCRETE_TYPES = new Set(['band', 'point', 'ordinal'])
import { geoRegistry, requireGeo } from './registry.js'
import { locale } from './locale.js'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledScale,
  CompiledTransform,
  EncodeValue,
  RuntimeInput,
  ScaleDomain,
  SceneGroup,
  SceneItem,
  SceneNode,
  SceneRoot,
  SizeSpec,
  SortSpec,
  VgSpec,
} from './types.js'
import { tickFormat, scaleFraction, tickValues, tickCount, isContinuous, validTicks } from './scale.js'
import { timeIntervalFor, utcIntervalFor } from './time.js'
import { compileChart } from './compiler.js'
import { rowsEqual, type PulseChange } from './pulse.js'
import { trellisLayout, measureBounds } from './trellis.js'
import { baselineOffset, boundAxisGroup, boundGroupItem, boundLeaf, boundText, Bounds } from './bounds.js'
import { itemTextWidth, nominalTextWidth, type FontProps } from './text-metrics.js'
import { symbolPath } from './render.js'

const DEFAULT_SIZE = 500

// Reference identities for expression parameters (width/height/signals). A
// parameter change (a new signal object, e.g. a brush extent) must invalidate
// any row-wise transform cache that depends on it.
const PARAM_IDS = new WeakMap<object, number>()
let PARAM_SEQ = 0
function paramRefId(v: unknown): number {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return -1
  let id = PARAM_IDS.get(v as object)
  if (id === undefined) {
    id = ++PARAM_SEQ
    PARAM_IDS.set(v as object, id)
  }
  return id
}

/** Persistent per-group index for incremental group transforms. */
interface AggState {
  groupby: string[]
  /** Input row index -> group key (same length as the input rows). */
  rowKey: string[]
  /** Group key -> input row indices belonging to it. */
  keyToIdx: Map<string, number[]>
  /** Output row order (group keys, first-occurrence order). */
  outOrder: string[]
  /** Group key -> output row index (parallel to outOrder; O(1) dirty-index lookup). */
  outIdx: Map<string, number>
  /** Group key -> aggregate output row (aggregate only). */
  outByKey: Map<string, Row>
  /** Group key -> start index in the grouped output array (window/stack). */
  groupStart: Map<string, number>
  /** Group key -> number of output rows it contributes. */
  groupSize: Map<string, number>
  out: Row[]
}

/**
 * A dataset-level pulse: the new output indices whose rows changed, plus the
 * index mapping for length-changing updates. `from` is absent for same-length
 * updates (identity mapping).
 */
interface StepPulse extends PulseChange {
  /** True when the transform chain could not publish a trustworthy mapping. */
  full?: boolean
}

function groupKeyOf(row: Row, groupby: string[]): string {
  return groupby.map((k) => String(row[k])).join('\u0000')
}

function buildAggState(input: Row[], groupby: string[], out: Row[]): AggState {
  const rowKey = new Array<string>(input.length)
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < input.length; i++) {
    const k = groupKeyOf(input[i]!, groupby)
    rowKey[i] = k
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const outOrder = [...keyToIdx.keys()]
  const outIdx = new Map<string, number>()
  outOrder.forEach((k, idx) => outIdx.set(k, idx))
  const outByKey = new Map<string, Row>()
  outOrder.forEach((k, idx) => outByKey.set(k, out[idx]!))
  // Grouped outputs (window/stack) place a group's rows contiguously; track
  // each group's start index and size so dirty groups can be spliced in place.
  const groupStart = new Map<string, number>()
  const groupSize = new Map<string, number>()
  let pos = 0
  for (const k of outOrder) {
    const size = keyToIdx.get(k)!.length
    groupStart.set(k, pos)
    groupSize.set(k, size)
    pos += size
  }
  return { groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey, groupStart, groupSize, out }
}

/** Fingerprint the expression params a row-wise transform can reference. */
function paramFpOf(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const k of Object.keys(params).sort()) {
    const v = params[k]
    parts.push(`${k}=${typeof v === 'object' ? '#' + paramRefId(v) : String(v)}`)
  }
  return parts.join('\u0001')
}

/**
 * Global gradient id counter, mirroring vega-scenegraph's module-level
 * `gradient_id`. Vega assigns `gradient_<n>` from a process-global counter that
 * is never reset, so the ids a spec receives depend on how many gradient legends
 * earlier specs in the same process already rendered. Matching that counter here
 * keeps the emitted `url(#gradient_n)` references in lockstep with vega when
 * both renderers run in the same process (as the conformance harness does).
 */
let gradientIdCounter = 0

/** Cached recursive bounds for unchanged top-level mark groups. */
const GROUP_BOUNDS = new WeakMap<SceneGroup, Bounds>()

/** Mark types whose group bounds are exactly the union of their item bounds. */
const UNION_BOUND_MARKS = new Set(['symbol', 'rect', 'text', 'rule', 'tick'])
function cacheableGroupBounds(g: SceneGroup): boolean {
  return g.role === 'mark' && UNION_BOUND_MARKS.has(String(g.marktype))
}

interface EvalContext {
  chart: CompiledChart
  signalParams: Record<string, unknown>
  width: number
  height: number
  datasets: Map<string, Row[]>
  /** A legend tickCount threw: the whole layout aborts (raw-guide mode). */
  rawGuides?: boolean
  scales: Map<string, Scale>
  scaleTypes: Map<string, string>
  /** Per-mark, per-eval encode bindings (scale fn + type) so the per-row encode
   * loop skips two Map lookups per scale channel. EvalContext is fresh per eval,
   * so bindings can never outlive the scales they reference. */
  encodeBinding?: EncodeBinding
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
  /** Datasets affected by this update (dataChanges ∪ changedDatasets, closed over source chains). */
  affected: Set<string>
  /** True when the caller supplied change info (so incremental reuse is allowed). */
  incremental: boolean
  /**
   * Pulse propagation: the *output* row indices that changed per dataset,
   * derived from the transform pipeline (row-wise -> same indices; aggregate ->
   * dirty groups' output positions). null/absent means the dataset was fully
   * re-derived (not incrementally safe for downstream item reuse).
   */
  datasetChanges?: Map<string, Set<number> | null>
  /**
   * Pulse propagation with index mapping: the output pulse per dataset. A
   * length-changing update carries `from`/`to` so marks can splice their item
   * array instead of re-encoding unchanged rows.
   */
  datasetPulses: Map<string, StepPulse | null>
  /** Input pulses for source datasets (from the host/session). */
  inputPulses?: Map<string, StepPulse>
  /** Wall-clock deadline (performance.now epoch) from `limits.maxTimeMs`. */
  deadline?: number
  /** Direct scale-domain overrides keyed by scale name. */
  domainRaw?: Map<string, unknown[]>
  /** Throw a typed error when the current evaluation ran past its deadline. */
  checkDeadline?: (phase?: string) => void
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
  const started = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  const maxTime = input.limits?.maxTimeMs
  const deadline = maxTime != null && Number.isFinite(maxTime) ? started + Math.max(0, maxTime) : undefined
  const checkDeadline = (phase = 'evaluation'): void => {
    if (deadline == null) return
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
    if (now > deadline) throw new AsterLimitError(`maxTimeMs exceeded during ${phase}`)
  }
  checkDeadline('startup')
  const signals = { ...chart.signals, ...input.signals }
  let width = resolveSize(chart.width, input.width, signals)
  // A Vega spec can define the chart height as a `height` signal (a special
  // signal that doubles as the view size), e.g. `signals:[{name:'height',
  // update: ...}]`, without a top-level numeric height. It's resolved later by
  // resolveSignalUpdates, so apply the fallback after that (see below).
  let height = resolveSize(chart.height, input.height, signals)
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
  const ctx: EvalContext = {
    chart, signalParams, width, height, datasets, scales, scaleTypes, projections: new Map(), runtime, _defs: defs,
    hierarchies: new Map(), affected: new Set(), incremental: false, deadline, checkDeadline,
    datasetPulses: new Map(),
    domainRaw: input.domainRaw ? new Map(Object.entries(input.domainRaw).map(([k, v]) => [k, v])) : undefined,
  }
  // A legend whose tickCount is an interval string on a non-time scale makes
  // vega's LegendEntries throw: the dataflow logs the error and the ViewLayout
  // transform never runs — the whole scene renders at raw encode positions
  // (no axis layout, no title layout, default view size).
  ctx.rawGuides = chart.legends.some((l) => {
    if (typeof l.tickCount === 'string') {
      const scaleName = l.shape ?? l.stroke ?? l.fill ?? l.size ?? l.opacity
      const t = scaleName ? chart.scales.find((sc) => sc.name === scaleName)?.type : undefined
      if (t !== 'time' && t !== 'utc') return true
    }
    // A non-integer/negative `columns` makes vega's symbol-legend gridLayout
    // throw (Array(columns) with a length that is not a valid uint32-ish int).
    // Gradient legends do not lay entries out in a grid and ignore columns.
    if (l.gradientLength == null && typeof l.columns === 'number'
      && (l.columns > 0 ? !Number.isInteger(l.columns) : l.columns !== 0)) return true
    return false
  })
  if (input.dataChanges) {
    ctx.dataChanges = new Map(Object.entries(input.dataChanges).map(([name, idxs]) => [name, new Set(idxs)]))
  }
  if (input.dataPulse) {
    ctx.inputPulses = new Map(Object.entries(input.dataPulse).map(([name, p]) => [name, {
      changed: p.changed ?? [],
      ...(p.from ? { from: p.from } : {}),
      ...(p.to ? { to: p.to } : {}),
      ...(p.added ? { added: p.added } : {}),
      ...(p.removed ? { removed: p.removed } : {}),
      ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
    }]))
    // The length-preserving form of an explicit pulse is also a plain
    // changeset: expose it to the row-wise/grouped/differential paths that
    // consume `dataChanges` (and to the scale-domain census).
    for (const [name, p] of ctx.inputPulses) {
      if (p.from || !p.changed.length) continue
      if (!ctx.dataChanges) ctx.dataChanges = new Map()
      ctx.dataChanges.set(name, new Set(p.changed))
    }
  }
  const changedNames = new Set([
    ...(input.changedDatasets ?? []),
    ...(ctx.dataChanges ? ctx.dataChanges.keys() : []),
    ...(ctx.inputPulses ? ctx.inputPulses.keys() : []),
  ])
  ctx.affected = affectedDatasets(chart, changedNames)
  ctx.incremental = changedNames.size > 0
  ctx.datasetChanges = new Map()

  // Remap Vega-Lite "category" range (unhandled by vega-scale) to tableau10 —
  // unless a config.range.category shadows it (vega's range lookup consults
  // the config block first).
  for (const s of ctx.chart.scales) {
    if (s.range === 'category' && !chart.configRange?.category) { ; (s as unknown as Record<string, unknown>).range = 'tableau10' }
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
  // A Vega spec can define the chart height as a `height` signal (a special
  // signal that doubles as the view size), e.g. `signals:[{name:'height',
  // update: ...}]`, without a top-level numeric height. Honor it now that the
  // signal is resolved so the content is not defaulted to 500.
  const hasHeightSignal = (chart.signalDefs ?? []).some((s) => s.name === 'height')
  if (height === DEFAULT_SIZE && hasHeightSignal && typeof ctx.signalParams.height === 'number') {
    height = ctx.signalParams.height
    ctx.height = height
    buildScales(ctx)
  }
  // A `width` signal whose update references a scale domain (vega-lite's
  // step-sized band dimensions: bandspace(domain('x').length, ...) * x_step)
  // must be re-evaluated now that the scales — and their domains — exist.
  if (width === DEFAULT_SIZE && (chart.signalDefs ?? []).some((s) => s.name === 'width')) {
    const def = (chart.signalDefs ?? []).find((s) => s.name === 'width')
    const update = def?.update as string | undefined
    if (typeof update === 'string') {
      try {
        const v = ctx.runtime.expr(update)({}, ctx.signalParams) as unknown
        if (typeof v === 'number' && Number.isFinite(v)) {
          width = v
          ctx.width = v
          ctx.signalParams.width = v
          buildScales(ctx)
        }
      } catch { /* leave the default */ }
    }
  }
  buildProjections(ctx)

  // Record the expression params for the next per-datum update; buildDatasets
  // (during this prepare) and canReuseItems (after) compare the current params
  // against the *previous* eval's to decide whether caches/reuse are valid.
  const chartMeta = ctx.chart as unknown as { __paramFp?: string; __prevParamFp?: string }
  chartMeta.__prevParamFp = chartMeta.__paramFp
  chartMeta.__paramFp = paramFpOf(signalParams)

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
  const evalTup = (v: unknown): [number, number] | [number, number, number] | undefined => {
    // keep a third element: rotate's gamma component
    if (Array.isArray(v) && v.length > 2) return [Number(v[0]), Number(v[1]), Number(v[2])]
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1])]
    if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
      try {
        const r = ctx.runtime.expr(String((v as { signal: string }).signal))({}, ctx.signalParams)
        if (Array.isArray(r) && r.length > 2) return [Number(r[0]), Number(r[1]), Number(r[2])]
        if (Array.isArray(r)) return [Number(r[0]), Number(r[1])]
      } catch { /* ignore */ }
    }
    return undefined
  }
  const evalAny = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => (x != null && typeof x === 'object' && 'signal' in (x as Record<string, unknown>) ? evalAny(x) : x))
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
    if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
      try { return ctx.runtime.expr(String((v as { signal: string }).signal))({}, ctx.signalParams) } catch { return undefined }
    }
    return v
  }
  for (const p of ctx.chart.projections) {
    const params: Record<string, unknown> | undefined = p.params
      ? Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, evalAny(v)]))
      : undefined
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
      params,
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

/** Resolve a guide string/signal value for accessibility metadata. */
function guideString(ctx: EvalContext, value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { signal?: unknown }).signal === 'string') {
    try {
      const v = ctx.runtime.expr(String((value as { signal: string }).signal))({}, ctx.signalParams)
      return v == null ? undefined : String(v)
    } catch { return undefined }
  }
  return undefined
}

/** Resolve a guide title (string or `{signal}`) for accessibility metadata. */
function guideTitle(ctx: EvalContext, title: unknown): string | undefined {
  if (typeof title === 'string') return title
  if (title && typeof title === 'object' && typeof (title as { signal?: unknown }).signal === 'string') {
    try {
      const value = ctx.runtime.expr(String((title as { signal: string }).signal))({}, ctx.signalParams)
      return value == null ? undefined : String(value)
    } catch { return undefined }
  }
  return undefined
}

function buildAxisAndLegend(ctx: EvalContext, contentItems: SceneGroup[]): { groups: SceneGroup[] } {
  const groups: SceneGroup[] = []
  // vega's layoutGroup walks the content children together with the guides:
  // the anchor bounds scan the content items too.
  const anchorItems = [...contentItems]

  for (const axis of ctx.chart.axes) {
    const group = buildAxis(axis, ctx)
    if (group) {
      // Raw-guide mode: the axisLayout never ran, so the builder's baked 0.5
      // render delta must be cancelled by the group translate (vega's raw
      // items sit at their encode positions with no delta).
      const wrapped = ctx.rawGuides
        ? ({ marktype: 'group', role: 'axis', x: -0.5, y: -0.5, items: [group] } as SceneGroup)
        : group
      // Carry guide identity for the accessible tree (R10.6) without changing
      // the serialized SVG: the fields are scene metadata only.
      ;(wrapped as unknown as { orient?: string; scale?: string; title?: string }).orient = axis.orient
      ;(wrapped as unknown as { orient?: string; scale?: string; title?: string }).scale = axis.scale
      ;(wrapped as unknown as { aria?: boolean; grid?: boolean; format?: string; formatType?: string }).aria = axis.aria
      ;(wrapped as unknown as { aria?: boolean; grid?: boolean; format?: string; formatType?: string }).grid = axis.grid === true
      ;(wrapped as unknown as { aria?: boolean; grid?: boolean; format?: string; formatType?: string }).format = guideString(ctx, axis.format)
      ;(wrapped as unknown as { aria?: boolean; grid?: boolean; format?: string; formatType?: string }).formatType = guideString(ctx, axis.formatType)
      const at = guideTitle(ctx, axis.title)
      if (at) (wrapped as unknown as { title?: string }).title = at
      groups.push(wrapped)
      anchorItems.push(wrapped)
    }
  }

  // Vega's legend layout (layoutGroup + legendParams + gridLayout): build each
  // legend at local (0,0), then position the orient groups with the grid
  // algorithm — vertical stacking for left/right (one column), a horizontal
  // row for top/bottom/none-direction (one row), anchored outside the axis
  // bounds with the 18px offset and an 8px margin between legends.
  const built = ctx.chart.legends
    .filter((legend) => (legend as { disable?: boolean }).disable !== true)
    .map((legend) => {
      const group = buildLegend(legend, ctx)
      if (group) {
        const lt = guideTitle(ctx, legend.title)
        if (lt) (group as unknown as { title?: string }).title = lt
        const g = group as unknown as {
          legendScale?: string; legendChannels?: string[]; legendType?: string
          legendFormat?: string; legendFormatType?: string
        }
        g.legendChannels = ['fill', 'stroke', 'size', 'shape', 'opacity'].filter((k) => typeof (legend as Record<string, unknown>)[k] === 'string')
        g.legendScale = g.legendChannels.map((k) => String((legend as Record<string, unknown>)[k]))[0]
        g.legendFormat = guideString(ctx, (legend as Record<string, unknown>).format)
        g.legendFormatType = guideString(ctx, (legend as Record<string, unknown>).formatType)
        const st = g.legendScale ? (ctx.scaleTypes.get(g.legendScale) ?? ctx.chart.scales.find((sc) => sc.name === g.legendScale)?.type) : undefined
        const discrete = st === 'band' || st === 'point' || st === 'ordinal' || st === 'bin-ordinal'
        const discretizing = st === 'threshold' || st === 'quantize' || st === 'quantile'
        const color = g.legendChannels.some((k) => k === 'fill' || k === 'stroke')
        const explicitGradient = legend.type === 'gradient' || legend.gradientLength != null
        g.legendType = legend.type === 'symbol'
          ? 'symbol'
          : explicitGradient ? 'gradient'
            : color && discretizing ? 'discrete'
              : color && st != null && !discrete ? 'gradient'
                : 'symbol'
      }
      return { legend, group }
    })
    .filter((x): x is { legend: CompiledLegend; group: SceneGroup } => x.group !== null)
    // A legend whose entries failed to build (an invalid tickCount interval
    // string) degenerates to a zero-size group with no items: vega still
    // creates it, but it renders nothing and takes no layout space.
    .filter((x) => !(x.group.width === 0 && x.group.height === 0 && (x.group.items?.length ?? 0) === 0))

  if (built.length) {
    // legendParams anchors on the axis bounds only: xBounds unions the
    // vertical (left/right) axes, yBounds the horizontal ones; marks live in
    // viewBounds and never reach the anchor.
    let xb = { x1: 0, y1: 0, x2: ctx.width, y2: ctx.height }
    let yb = { x1: 0, y1: 0, x2: ctx.width, y2: ctx.height }
    for (const g of anchorItems) {
      // vega's getRole: every top-level group-typed mark is a scope and
      // unions into BOTH anchor bounds; axis marks split by orientation.
      if (g.marktype === 'group' && (g.role === 'scope' || g.role === 'mark')) {
        // vega's scope bound is the recursive child union (plus the group
        // rect) — clipped cells still measure their children.
        const b = boundGroupItem(new Bounds(), g)
        xb.x1 = Math.min(xb.x1, b.x1)
        xb.y1 = Math.min(xb.y1, b.y1)
        xb.x2 = Math.max(xb.x2, b.x2)
        xb.y2 = Math.max(xb.y2, b.y2)
        yb.x1 = Math.min(yb.x1, b.x1)
        yb.y1 = Math.min(yb.y1, b.y1)
        yb.x2 = Math.max(yb.x2, b.x2)
        yb.y2 = Math.max(yb.y2, b.y2)
        continue
      }
      if (g.role !== 'axis') continue
      const meta = (g as unknown as { axis?: { orient: string } }).axis
      const b = boundAxisGroup(g)
      const isY = meta ? meta.orient === 'left' || meta.orient === 'right' : false
      const t = isY ? xb : yb
      t.x1 = Math.min(t.x1, b.x1)
      t.y1 = Math.min(t.y1, b.y1)
      t.x2 = Math.max(t.x2, b.x2)
      t.y2 = Math.max(t.y2, b.y2)
    }

    // group legends by orient ('none' skips the grid: vega leaves the item
    // at its unlayouted position, which is the origin)
    const byOrient = new Map<string, { legend: CompiledLegend; group: SceneGroup }[]>()
    for (const x of built) {
      const orient = x.legend.orient ?? 'right'
      if (orient === 'none') continue
      const list = byOrient.get(orient) ?? []
      list.push(x)
      byOrient.set(orient, list)
    }

    for (const [orient, list] of byOrient) {
      // Raw-guide mode skips the legend grid: the groups stay at (0,0) (the
      // built legends are pushed unpositioned below).
      if (ctx.rawGuides) continue
      if (typeof process !== 'undefined' && process.env.ASTER_DEBUG_LEG) console.error('[leg]', orient, 'xb', JSON.stringify(xb), 'yb', JSON.stringify(yb), 'W', ctx.width, 'H', ctx.height)
      const n = list.length
      // columns: vertical direction (left/right) stacks in one column; the
      // horizontal default lays all legends out in one row.
      const ncols = orient === 'left' || orient === 'right' ? 1 : n
      const nrows = Math.max(1, Math.ceil(n / ncols))
      // flush boxes: legendLayout zeroes x/y and sizes the legend to
      // ceil(childBounds + 2*padding) — our group.width/height.
      const boxes = list.map((x) => ({ x1: 0, y1: 0, x2: x.group.width ?? 0, y2: x.group.height ?? 0 }))
      const xOffset = boxes.map((b) => 8 + (b.x1 < 0 ? Math.ceil(-b.x1) : 0))
      const yOffset = boxes.map((b) => 8 + (b.y1 < 0 ? Math.ceil(-b.y1) : 0))
      const xExtent = Array<number>(ncols).fill(0)
      const yExtent = Array<number>(nrows).fill(0)
      boxes.forEach((b, i) => {
        const c = i % ncols, r = ~~(i / ncols)
        xExtent[c] = Math.max(xExtent[c]!, Math.ceil(b.x2))
        yExtent[r] = Math.max(yExtent[r]!, Math.ceil(b.y2))
      })
      for (let i = 0; i < n; i++) {
        if (i % ncols === 0) xOffset[i] = 0
        if (i < ncols) yOffset[i] = 0
      }
      // gridAlign 'each': each column/row offset rides on the previous
      // column/row extent.
      for (let c = 1; c < ncols; c++) {
        let off = 0
        for (let i = c; i < n; i += ncols) off = Math.max(off, xOffset[i]!)
        for (let i = c; i < n; i += ncols) xOffset[i] = off + xExtent[c - 1]!
      }
      for (let r = 1; r < nrows; r++) {
        let off = 0
        for (let i = r * ncols, m = Math.min(i + ncols, n); i < m; i++) off = Math.max(off, yOffset[i]!)
        for (let i = r * ncols, m = Math.min(i + ncols, n); i < m; i++) yOffset[i] = off + yExtent[r - 1]!
      }
      const dx: number[] = []
      let acc = 0
      for (let i = 0; i < n; i++) {
        acc = xOffset[i]! + (i % ncols ? acc : 0)
        dx.push(acc)
      }
      const dy: number[] = Array<number>(n).fill(0)
      for (let c = 0; c < ncols; c++) {
        let y = 0
        for (let i = c; i < n; i += ncols) {
          y += yOffset[i]!
          dy[i] = y
        }
      }
      // laid-out block bounds (flush boxes translated by dx/dy)
      let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity
      boxes.forEach((b, i) => {
        bx1 = Math.min(bx1, b.x1 + dx[i]!)
        by1 = Math.min(by1, b.y1 + dy[i]!)
        bx2 = Math.max(bx2, b.x2 + dx[i]!)
        by2 = Math.max(by2, b.y2 + dy[i]!)
      })
      const bw = bx2 - bx1
      const bh = by2 - by1

      // anchor: offset = the legends' own offset (max) else the config
      // default 18; anchor = start/middle/end (default start).
      let specOffset: number | undefined = undefined
      for (const x of list) {
        const o = x.legend.offset
        if (typeof o === 'number') specOffset = specOffset === undefined ? o : Math.max(specOffset, o)
      }
      const offset = specOffset ?? 18
      const anchor = (list[0]!.legend as { anchor?: unknown }).anchor
      const aEnd = anchor === 'end'
      const aMiddle = anchor === 'middle'
      const mult = aEnd ? 1 : aMiddle ? 0.5 : 0
      const W = ctx.width
      const H = ctx.height
      let x: number
      let y: number
      let colEnd = false
      let rowEnd = false
      switch (orient) {
        case 'left':
          // Epsilon guard: our axis bounds can be off vega's by 1 ulp (rotated
          // title fp), and floor/ceil would turn that into a whole pixel of
          // legend anchor shift (see computeGuidePadding's EPS note).
          x = Math.floor(xb.x1 + 1e-9) - offset
          y = mult * H
          colEnd = true
          rowEnd = aEnd
          break
        case 'right':
          x = Math.ceil(xb.x2 - 1e-9) + offset
          y = mult * H
          rowEnd = aEnd
          break
        case 'top':
          x = mult * W
          y = Math.floor(yb.y1 + 1e-9) - offset
          colEnd = aEnd
          rowEnd = true
          break
        case 'bottom':
          x = mult * W
          y = Math.ceil(yb.y2 - 1e-9) + offset
          colEnd = aEnd
          break
        case 'top-left':
          x = offset
          y = offset
          break
        case 'top-right':
          x = W - offset
          y = offset
          colEnd = true
          break
        case 'bottom-left':
          x = offset
          y = H - offset
          rowEnd = true
          break
        case 'bottom-right':
          x = W - offset
          y = H - offset
          colEnd = true
          rowEnd = true
          break
        default:
          x = Math.ceil(xb.x2) + offset
          y = mult * H
          rowEnd = aEnd
          break
      }
      if (colEnd) x -= bw
      if (rowEnd) y -= bh
      void aMiddle
      x = Math.round(x)
      y = Math.round(y)
      list.forEach((x1, i) => {
        x1.group.x = x + dx[i]!
        x1.group.y = y + dy[i]!
      })
      void aMiddle
    }

    for (const x of built) groups.push(x.group)
  }

  return { groups }
}

/**
 * Measure a top-level guide group the way vega's layoutGroup does: axes via
 * the spine semantics, legends via the legendBounds anchor (the item bound is
 * forced to x1=y1=padding, so negative text overhangs don't leak into the
 * viewBounds), everything else recursively.
 */
function measureGuideGroup(g: SceneGroup): Bounds {
  if (g.role === 'axis') return boundAxisGroup(g)
  const cacheable = cacheableGroupBounds(g)
  if (cacheable) {
    const cached = GROUP_BOUNDS.get(g)
    if (cached) return cached
  }
  const lb = (g as unknown as Record<string, unknown>)._layoutBounds as Bounds | undefined
  if (lb) return lb
  // Facet row-headers/footers carry axes whose items bake the crisp +0.5
  // axis delta; vega's gridLayout reads the pre-delta extents, so the view
  // padding sees the bound shifted half a pixel up/left.
  if (g.role === 'row-header' || g.role === 'column-footer') {
    return boundLeaf(new Bounds(), g as unknown as SceneItem).translate(-0.5, -0.5)
  }
  if (g.role === 'row-title') return measureBounds(g)
  if (g.role === 'legend') {
    // legendLayout sets item.bounds = [x, y, x+width, y+height] (the outer
    // box incl. padding), anchored at the laid-out group position. A legend
    // border stroke (legend.strokeColor) boundStrokes the outer rect (+0.5
    // per side, vega legendLayout: boundStroke(bounds.set(x, y, x + w, y +
    // h), item)) — symbol strokes don't touch the legend bounds.
    const stroked = (g as unknown as Record<string, unknown>)._borderStroke === true
      || ((g as unknown as Record<string, unknown>)._borderStroke === undefined
        // vega's boundStroke expands by strokeWidth/2 — a zero-width stroke
        // (the gradient rect's #ddd) does not move the bounds.
        && (g.items as SceneItem[] | undefined)?.some((it) => it.stroke != null && it.path != null && (it.strokeWidth ?? 1) > 0))
    const strokeW = (g as unknown as { strokeWidth?: number }).strokeWidth
    const se = stroked ? ((strokeW != null ? strokeW : 1) / 2) : 0
    return new Bounds().set((g.x ?? 0) - se, (g.y ?? 0) - se, (g.x ?? 0) + (g.width ?? 0) + se, (g.y ?? 0) + (g.height ?? 0) + se)
  }
  const bounds = boundLeaf(new Bounds(), g as unknown as SceneItem)
  if (cacheable) GROUP_BOUNDS.set(g, bounds)
  return bounds
}

function computeGuidePadding(
  items: SceneGroup[],
  width: number,
  height: number,
  base: { top: number; right: number; bottom: number; left: number },
  zeroClipProjection = false,
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
  const EPS = 1e-9

  for (const group of items) {
    const b = measureGuideGroup(group)
    if (b.empty()) continue
    // Axis bounds carry fp residue from measured label/title geometry where
    // vega's arithmetic is exact; collapse only that sub-ulp residue. Mark and
    // legend geometry is exact enough that a genuine positive residue (a bar
    // whose right edge is the view width) must still grow the margin.
    const ei = group.role === 'axis' ? EPS : 0
    // Geo shape bounds are traced through clipped projections; d3's clip
    // intersection leaves a sub-pixel fp tail that can sit exactly on an
    // integer in our port where vega's is just below/above it. Nudge only that
    // integer case on the vertical axis (the clip bound affected by it).
    const geo = zeroClipProjection && (group.marktype === 'shape' || group.marktype === 'geoshape')
    const nudgeY = (v: number): number => geo && Math.abs(v - Math.round(v)) < EPS ? (v < 0 ? -EPS : EPS) : 0
    minX = Math.min(minX, b.x1 + ei)
    maxX = Math.max(maxX, b.x2 - ei)
    minY = Math.min(minY, b.y1 + ei + Math.min(0, nudgeY(b.y1)))
    maxY = Math.max(maxY, b.y2 - ei + Math.max(0, nudgeY(b.y2)))
  }

  // vega's viewSizeLayout (autosize pad): origin = spec padding + the ceil'd
  // overflow of the viewBounds on each side — no extra margin.
  // Epsilon guard: vega's rotated-text bounds land on exact integers where
  // our fp path can be off by 1 ulp; ceil would otherwise grow the padding.
  if (typeof process !== 'undefined' && process.env.ASTER_DEBUG_PAD) {
    for (const group of items) {
      const b = measureGuideGroup(group)
      console.error(`[pad] ${group.role ?? '?'} bounds=[${b.x1},${b.y1},${b.x2},${b.y2}] w=${width} h=${height}`)
    }
    console.error(`[pad] overflow L=${-minX} T=${-minY} R=${maxX - width} B=${maxY - height}`)
  }
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
  // Prefer the mark's source dataset (unambiguous for layered charts with
  // multiple same-type marks); fall back to name, then role+marktype.
  const src = mark.from?.data as string | undefined
  if (src != null) {
    for (const g of prevItems) {
      if ((g as SceneGroup & { __source?: string }).__source === src) return g
    }
  }
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

  // 2) Build axes + legends and compute padding (the anchor needs the
  // content items: vega's scope groups extend the anchor bounds)
  const { groups: guideGroups } = buildAxisAndLegend(ctx, items)
  for (const g of guideGroups) items.push(g)

  // 2b) Top-level title.
  const titleGroup = buildTitleGroup(ctx.chart, items, width, height, ctx.rawGuides)
  if (titleGroup) items.push(titleGroup)

  // 2c) Trellis layout (vega's ViewLayout/trellisLayout port).
  const hasFacetMarks = (ctx as any).chart.marks?.some((m: any) => m.from?.facet?.groupby?.length > 0) ?? false
  const hasChildSignals = ctx.signalParams['child_width'] !== undefined && ctx.signalParams['child_height'] !== undefined
  const isFacetSpec = hasFacetMarks && hasChildSignals
  // vega sizes a faceted view from the laid-out grid: the root group's
  // width/height come from the trellis gridLayout (columns × child_width +
  // paddings), not from any spec width — the spec's are signal-based. The
  // guides (headers/footers/titles) live OUTSIDE the group bounds and grow
  // the padding by their overflow.
  let facetWidth = width
  let facetHeight = height
  if (isFacetSpec) {
    // vega runs trellisLayout over every facet composition (1d and 2d alike):
    // the root marks all carry the facet `layout` and the ported grid +
    // header + title laws position cells, headers, footers and titles.
    applyTrellisLayout(items, ctx)
    const childW = ctx.signalParams['child_width'] as number
    const childH = ctx.signalParams['child_height'] as number
    facetWidth = 0
    facetHeight = 0
    for (const it of items) {
      if (it.role !== 'scope') continue
      const x2 = (it.x ?? 0) + childW
      const y2 = (it.y ?? 0) + childH
      if (x2 > facetWidth) facetWidth = x2
      if (y2 > facetHeight) facetHeight = y2
    }
  }

  // 2d) viewSizeLayout padding (overflow) after the trellis layout.
  // A trellis layout that throws (vega's gridLayout does on e.g. fractional
  // `columns`) aborts vega's whole ViewLayout transform: the scene renders
  // unlayouted — cells at their encoded anchors — with the default padding
  // and no overflow growth (the dataflow logs the error and continues).
  const padding = (ctx as unknown as { __layoutError?: boolean }).__layoutError || ctx.rawGuides
    ? ctx.chart.padding
    : computeGuidePadding(
        items, facetWidth, facetHeight, ctx.chart.padding,
        (ctx.chart.projections ?? []).some((p) => p.type === 'azimuthalequalarea' && Number(p.clipAngle) === 0),
      )
  // Vega's renderers visit top-level items in dataflow order: axes (including
  // grid axes) first, then marks/scopes, then legends, then the title. Our
  // builders create marks first (guides need their bounds to anchor), so sort
  // the siblings into vega's paint order here. This is what keeps SVG and
  // canvas z-order identical for overlapping marks (e.g. an area over a grid).
  const orderRank = (g: SceneGroup): number =>
    g.role === 'axis' ? 0 : g.role === 'legend' ? 2 : g.role === 'title' ? 3 : 1
  const ordered = items.length > 1
    ? items.map((g, i) => ({ g, i })).sort((a, b) => orderRank(a.g) - orderRank(b.g) || a.i - b.i).map((x) => x.g)
    : items
  return { items: ordered, padding, ctx, width: facetWidth, height: facetHeight, isFacetSpec }
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  return withTextMetricsProvider(input.textMetrics, () => evaluateChartImpl(chart, input))
}

function evaluateChartImpl(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const auto = chart.autosize
  const base = chart.padding
  // Differential-update generation: incremented each eval so an unchanged (reused)
  // item keeps its previous generation and the DOM patcher can skip it.
  ;(chart as unknown as { __gen?: number }).__gen = ((chart as unknown as { __gen?: number }).__gen ?? 0) + 1
  const signals = { ...chart.signals, ...input.signals }
  const initialW = resolveSize(chart.width, input.width, signals)
  const initialH = resolveSize(chart.height, input.height, signals)
  // Vega's layout keeps the sign of a negative declared height: the rendered
  // document grows by ceil(|height| / 2) beyond the clamped content height
  // (width does not; negative widths collapse symmetrically).
  const declaredHeight = input.height != null
    ? input.height
    : typeof chart.height === 'number'
      ? chart.height
      : chart.height && typeof chart.height === 'object' && 'signal' in chart.height
        ? Number(signals[(chart.height as { signal: string }).signal])
        : undefined
  const negativeHeightExtra = typeof declaredHeight === 'number' && declaredHeight < 0
    ? Math.ceil(-declaredHeight / 2)
    : 0

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
      // not the current content: content = viewport - overflow. With autosize
      // contains:'padding' the spec'd width/height INCLUDE the padding
      // (viewSizeLayout subtracts it before fitting).
      const padW = chart.autosizeContains === 'padding' ? base.left + base.right : 0
      const padH = chart.autosizeContains === 'padding' ? base.top + base.bottom : 0
      if (auto === 'fit') { nw = Math.max(0, initialW - padW - oL - oR); nh = Math.max(0, initialH - padH - oT - oB) }
      else if (auto === 'fit-x') { nw = Math.max(0, initialW - padW - oL - oR); nh = ch }
      else { nw = cw; nh = Math.max(0, initialH - padH - oT - oB) }
      if (nw === cw && nh === ch) break
      cw = nw
      ch = nh
      built = buildContent(chart, { ...input, changedDatasets: undefined }, cw, ch)
    }
  }
  const { ctx, width, height } = built
  const items = built.items
  // The negative-height half-pixel growth belongs at the top origin, which is
  // where vega's title layout puts it (content shifts down with the root).
  const padding = negativeHeightExtra
    ? { ...built.padding, top: built.padding.top + negativeHeightExtra }
    : built.padding
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

  // Composite layouts (facet/trellis/concat) truncate their fractional grid
  // extents to whole pixels in the rendered document, while individual cell
  // positions keep their exact layout advance.
  if (isFacetSpec || isConcat) {
    sceneWidth = Math.floor(sceneWidth)
    sceneHeight = Math.floor(sceneHeight)
  }

  // The frame background plot rect: the content size. Only set when the
  // viewport is derived from the content (autosize pad / explicit sizes) —
  // the signal-based minimum-viewport cases (10x10) keep deriving the rect
  // by subtraction, where the zero plot is the vega-matching result.
  const isMinViewport = isFacetSpec || (isConcat && (is2DConcat || sceneWidth === 10 || sceneHeight === 10))
  const carryPlot = !isMinViewport
  const scene: SceneRoot = {
    width: sceneWidth,
    height: sceneHeight,
    // a faceted root frame has no explicit extent in vega's scenegraph — its
    // background path is degenerate (M0,0h0v0h0Z), not the plot rect
    plotWidth: isFacetSpec ? 0 : carryPlot ? width : undefined,
    plotHeight: isFacetSpec ? 0 : carryPlot ? height : undefined,
    background: ctx.chart.background,
    frameStroke: ctx.chart.frameStroke,
    frameFill: (ctx.chart as unknown as { frameFill?: string }).frameFill,
    frameStrokeWidth: (ctx.chart as unknown as { frameStrokeWidth?: number }).frameStrokeWidth,
    frameFillOpacity: (ctx.chart as unknown as { frameFillOpacity?: number }).frameFillOpacity,
    frameOpacity: (ctx.chart as unknown as { frameOpacity?: number }).frameOpacity,
    frameStrokeDash: (ctx.chart as unknown as { frameStrokeDash?: number[] }).frameStrokeDash,
    frameCornerRadius: (ctx.chart as unknown as { frameCornerRadius?: number }).frameCornerRadius,
    frameClip: (ctx.chart as unknown as { frameClip?: boolean }).frameClip,
    padding: ctx.chart.autosize === 'none' ? ctx.chart.padding : padding,
    items,
  }
  // Event-loop wiring (non-serialized internals)
  ;(scene as unknown as { runtime?: unknown }).runtime = ctx.runtime
  ;(scene as unknown as { signalParams?: Record<string, unknown> }).signalParams = ctx.signalParams
  ;(scene as unknown as { compiled?: unknown }).compiled = ctx.chart
  ;(scene as unknown as { __itemGen?: number }).__itemGen = (chart as unknown as { __gen?: number }).__gen
  ;(scene as unknown as { __scales?: unknown }).__scales = snapshotScales(ctx.scales)
  ;(scene as unknown as { __scaleMap?: unknown }).__scaleMap = ctx.scales
  // Partial re-evaluation memo
  ;(chart as unknown as { __prevItems?: SceneGroup[] }).__prevItems = items
  if (ctx._defs.length) scene.defs = ctx._defs
  return scene
}

/**
 * Chart metadata (size, padding, live scales) derived from an already-evaluated
 * scene. `getChartInfo` compiles + evaluates a second time; hosts that already
 * hold a scene (every `<Chart>` render does) should use this instead — on an
 * unchanged scene it is free, so identical-content re-renders stay sub-ms.
 */
export function chartInfoFromScene(scene: SceneRoot): ChartInfo {
  const chart = (scene as { compiled?: CompiledChart }).compiled
  const scales = (scene as { __scaleMap?: Map<string, Scale> }).__scaleMap
  const padding = scene.padding ?? chart?.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  return {
    // `ChartInfo` carries the plot (content) size — pan/zoom and brushing map
    // pixels against it — not the padded document size.
    width: (scene as { plotWidth?: number }).plotWidth
      || Math.max(0, scene.width - padding.left - padding.right),
    height: (scene as { plotHeight?: number }).plotHeight
      || Math.max(0, scene.height - padding.top - padding.bottom),
    padding,
    // Reconstruct from the live map when a scene came from a worker/SSR clone.
    scales: scales ?? new Map(),
  }
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
      // vega bounds text items with textMetrics (canvas when available) —
      // measuring with the item's font keeps browser layout on vega's numbers.
      const w = itemTextWidth(it as FontProps, String(it.text))
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

/**
 * Vega's titleLayout (vega-view titleLayout) port: the title group holds the
 * title text at (0,0) and the subtitle at (sx,sy); the group is positioned
 * outside the viewBounds by the union of the two text bounds.
 */
function buildTitleGroup(chart: CompiledChart, items: SceneNode[], width: number, height: number, raw = false): SceneGroup | null {
  const title = chart.title
  if (!title || !title.text) return null
  const orient = title.orient ?? 'top'
  const isLR = orient === 'left' || orient === 'right'
  const hasSub = !!title.subtitle
  const subFs = title.subtitleFontSize ?? 12
  const subPad = title.subtitlePadding ?? 3
  const offset = title.offset ?? 4
  const baseline = title.baseline ?? 'top'
  const align = (title.align as SceneItem['align'] | undefined) ??
    (title.anchor === 'start' ? 'left' : title.anchor === 'end' ? 'right' : 'center')
  const angle = title.angle ?? (orient === 'left' ? -90 : orient === 'right' ? 90 : 0)
  const dx = title.dx ?? 0
  const dy = title.dy ?? 0

  // viewBounds: [0,0,w,h] ∪ marks ∪ axis/legend bounds (axes measured in the
  // axis-internal frame; our scene bakes the 0.5px axis delta into the leaves
  // — shift it out). The title unions in afterwards, as in vega's layoutGroup.
  const b = new Bounds().set(0, 0, width, height)
  for (const g of items as SceneGroup[]) {
    if (g.role === 'title') continue
    b.union(measureGuideGroup(g))
  }
  const vb = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }

  // anchor position: frame=content maps over the viewBounds; frame=group over
  // the group box. For vertical titles start/end run along y (left: y2→y1).
  let start = 0
  let end = isLR ? height : width
  if (title.frame !== 'group') {
    if (orient === 'left') { start = vb.y2; end = vb.y1 }
    else if (orient === 'right') { start = vb.y1; end = vb.y2 }
    else { start = vb.x1; end = vb.x2 }
  } else if (orient === 'left') {
    start = height; end = 0
  }
  const pos = title.anchor === 'start' ? start : title.anchor === 'end' ? end : (start + end) / 2

  // Text bounds (vega marks/text bound): the title at (0,0); the subtitle at
  // (sx,sy) where sy = titleBound.height + subtitlePadding (top/bottom) and
  // sx = ±(titleBound.width + subtitlePadding) (left/right).
  const tBound = boundText(new Bounds(), {
    x: 0, y: 0, text: title.text, align, baseline, angle,
    fontSize: title.fontSize, fontWeight: title.fontWeight, font: title.font,
    dx, dy, ...(title.limit != null ? { limit: title.limit } : {}),
  } as SceneItem)
  let sx = 0
  let sy = 0
  let sBound: Bounds | undefined
  if (hasSub) {
    sx = isLR ? (orient === 'left' ? tBound.width() + subPad : -(tBound.width() + subPad)) : 0
    // vega's subtitle-offset switch covers top/bottom/left/right only — orient
    // 'none' matches no case, so the subtitle keeps the title's own offset
    // (sx=sy=0) and overlaps it.
    // Raw-guide mode: the titleLayout never ran — the subtitle keeps the
    // title's own offset (0,0), overlapping it.
    sy = isLR || orient === 'none' || raw ? 0 : tBound.height() + subPad
    sBound = boundText(new Bounds(), {
      x: sx, y: sy, text: title.subtitle!, align, baseline, angle,
      fontSize: subFs, fontWeight: title.subtitleFontWeight, dx, dy,
      ...(title.limit != null ? { limit: title.limit } : {}),
    } as SceneItem)
  }
  const temp = sBound ? new Bounds().set(tBound.x1, tBound.y1, tBound.x2, tBound.y2).union(sBound) : tBound

  let x = 0
  let y = 0
  switch (orient) {
    case 'left': x = vb.x1 - temp.width() - offset; y = pos; break
    case 'right': x = vb.x2 + temp.width() + offset; y = pos; break
    case 'bottom': x = pos; y = vb.y2 + offset; break
    case 'none': x = 0; y = 0; break
    default: x = pos; y = vb.y1 - temp.height() - offset; break
  }
  if (raw) { x = 0; y = 0 }
  // A floating-point epsilon on an integer title position (e.g. an axis-bound
  // x1 of -46.00000000000001) makes viewSizeLayout ceil the padding one pixel
  // early. Snap only near-integers; fractional anchored titles are untouched.
  const snap = (v: number): number => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v
  // Top/bottom anchors use integer view-bound origins; left/right titles subtract
  // a measured text width whose fp tail is part of vega's own bound arithmetic.
  if (orient !== 'left' && orient !== 'right') {
    x = snap(x)
    y = snap(y)
  }

  const textChildren: SceneNode[] = [
    {
      marktype: 'text',
      role: 'title-text',
      items: [{
        x: 0,
        y: 0,
        text: title.text,
        align,
        baseline,
        angle: angle || undefined,
        fontSize: title.fontSize,
        fontWeight: title.fontWeight,
        fill: title.color,
        dx,
        dy,
        ...(title.limit != null ? { limit: title.limit } : {}),
      } as SceneItem],
    } as SceneGroup,
  ]

  if (hasSub) {
    textChildren.push({
      marktype: 'text',
      role: 'title-subtitle',
      items: [{
        x: sx,
        y: sy,
        text: title.subtitle!,
        align,
        baseline,
        angle: angle || undefined,
        fontSize: subFs,
        fontWeight: title.subtitleFontWeight,
        fill: title.subtitleColor ?? '#000',
        dx,
        dy,
        ...(title.limit != null ? { limit: title.limit } : {}),
      } as SceneItem],
    } as SceneGroup)
  }

  return {
    marktype: 'group',
    role: 'title',
    x,
    y,
    items: textChildren,
  }
}

function resolveSize(size: SizeSpec, override: number | undefined, signals: Record<string, unknown>): number {
  // Vega clamps a negative view dimension to zero (`view.width()` returns 0);
  // the degenerate axes it then draws are what the oracle compares against.
  const clamp = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : DEFAULT_SIZE)
  if (override != null) return clamp(override)
  if (typeof size === 'number') return clamp(size)
  if (size && typeof size === 'object') {
    if ('signal' in size) {
      const v = signals[size.signal]
      return typeof v === 'number' ? clamp(v) : DEFAULT_SIZE
    }
    if ('step' in size) {
      throw new Error('[aster] width/height {step} sizing is not supported yet')
    }
  }
  return DEFAULT_SIZE
}


// ---------------------------------------------------------------------------
// Incremental pulse propagation (R13)
// ---------------------------------------------------------------------------

type StepTransformContext = TransformContext & {
  datasets: (name: string) => Row[] | undefined
  /** Datasets affected by this update (for lookup safety). */
  affectedDatasets?: Set<string>
  /** Per-step incremental state cache (filters/flatten/groups). */
  stepCache?: Map<string, unknown>
}

/** New-value indices that were inserted (mapping `-1`). */
function addedRangesOf(from: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < from.length; i++) {
    if (from[i]! >= 0) continue
    const start = i
    while (i + 1 < from.length && from[i + 1]! < 0) i++
    out.push([start, i + 1])
  }
  return out
}

function removedRangesOf(to: number[] | undefined): Array<[number, number]> {
  if (!to) return []
  const out: Array<[number, number]> = []
  for (let i = 0; i < to.length; i++) {
    if (to[i]! >= 0) continue
    const start = i
    while (i + 1 < to.length && to[i + 1]! < 0) i++
    out.push([start, i + 1])
  }
  return out
}

/** Derive a pulse from a new->old mapping and the changed output indices. */
function pulseOfMapping(from: number[], to: number[] | undefined, changed: number[]): StepPulse {
  return { changed, from, ...(to ? { to } : {}), added: addedRangesOf(from), removed: removedRangesOf(to) }
}

/** Identity mapping of length `n`. */
function identityMapping(n: number): number[] {
  const from = new Array<number>(n)
  for (let i = 0; i < n; i++) from[i] = i
  return from
}

/** Old-index -> new-index inverse (with -1 for removed rows). */
function inverseMapping(from: number[], oldLen: number): number[] {
  const to = new Array<number>(oldLen).fill(-1)
  for (let i = 0; i < from.length; i++) if (from[i]! >= 0) to[from[i]!] = i
  return to
}

function isModified(pulse: StepPulse): Set<number> {
  return new Set(pulse.changed)
}

/** A length-changing pulse, compact append form included. */
function isLengthPulse(pulse: StepPulse | null | undefined): pulse is StepPulse {
  return !!pulse && (pulse.from != null || pulse.appendOnly === true || (pulse.added?.length ?? 0) > 0 || (pulse.removed?.length ?? 0) > 0)
}

/** Previous length of a pulse (for synthesising a mapping). */
function pulseBaseLength(pulse: StepPulse): number {
  return pulse.baseLength ?? pulse.to?.length ?? (pulse.from ? pulse.from.length : 0)
}

/** Expand a compact append pulse to the full new->old mapping (on demand). */
function mappingFromPulse(pulse: StepPulse, newLen: number): number[] {
  if (pulse.from) return pulse.from
  const base = Math.min(pulseBaseLength(pulse), newLen)
  const from = new Array<number>(newLen)
  for (let i = 0; i < base; i++) from[i] = i
  for (let i = base; i < newLen; i++) from[i] = -1
  return from
}

/** Stable append pulse from a base length and new length. */
function appendPulse(baseLength: number, newLen: number, changed: number[]): StepPulse {
  return {
    changed,
    appendOnly: true,
    baseLength,
    ...(newLen > baseLength ? { added: [[baseLength, newLen]] } : {}),
  }
}

/** Run one transform over the whole input (the fallback path). */
function applyOne(rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string): Row[] {
  return applyTransforms(rows, [t], tctx, sourceName)
}

/**
 * Row-local transforms (`formula`, `timeunit`, fixed-extent `bin`, an
 * unaffected `lookup`, and the 1:1 geo transforms) derive only the added /
 * modified rows and splice the cached output for the retained ones.
 */
function rowLocalPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const from = input.from!
  const modified = isModified(input)
  const out = new Array<Row>(rows.length)
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && !modified.has(i) && prev && prev[old] !== undefined) {
      out[i] = prev[old]!
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    out[i] = derived[0]!
    changed.push(i)
  }
  return { rows: out, pulse: pulseOfMapping(from, input.to, changed) }
}

/**
 * Append-only fast paths. These mutate the cached step output (persistent-scene
 * semantics): unchanged rows keep their already-transformed row objects, and
 * new rows are appended, so the cost is O(appended + changed).
 */
function rowLocalAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const base = pulseBaseLength(input)
  if (!prev || prev.length !== base) return null
  const changed: number[] = []
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    prev[i] = derived[0]!
    changed.push(i)
  }
  for (let i = base; i < rows.length; i++) {
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    prev.push(derived[0]!)
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, changed) }
}

function filterAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevPass: boolean[] | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (input.changed.length || !prev || !prevPass || prevPass.length !== base) return null
  const expr = (t as { expr?: string }).expr ?? ''
  const fn = (row: Row): boolean => { try { return Boolean(tctx.runtime.expr(expr)(row, tctx.signals)) } catch { return false } }
  const outBase = prev.length
  for (let i = base; i < rows.length; i++) {
    const passed = fn(rows[i]!)
    prevPass.push(passed)
    if (passed) prev.push(rows[i]!)
  }
  return { rows: prev, pulse: appendPulse(outBase, prev.length, []), state: prevPass }
}

function foldAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const n = ((t as { fields?: unknown[] }).fields ?? []).length
  if (!n || !prev) return null
  const base = pulseBaseLength(input)
  if (prev.length !== base * n) return null
  const changed: number[] = []
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) {
      prev[i * n + j] = derived[j]!
      changed.push(i * n + j)
    }
  }
  const outBase = base * n
  for (let i = base; i < rows.length; i++) {
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) prev.push(derived[j]!)
  }
  return { rows: prev, pulse: appendPulse(outBase, prev.length, changed) }
}

/**
 * Re-derive a transform whose output stays 1:1 with its input (layout/pie/
 * dotbin/label), then reuse the previous output row object wherever the value
 * is unchanged. This is how a global layout participates in the pulse graph:
 * the mapping survives, so downstream items still splice.
 */
function rederiveAligned(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const out = applyOne(rows, t, tctx, sourceName)
  const from = input.from!
  if (out.length !== from.length) return null
  const modified = isModified(input)
  const changed: number[] = []
  const reused = new Array<Row>(out.length)
  for (let i = 0; i < out.length; i++) {
    const old = from[i]!
    const canReuse = old >= 0 && !modified.has(i) && prev && prev[old] !== undefined
    if (canReuse && rowsEqual(out[i]!, prev![old]!)) {
      reused[i] = prev![old]!
    } else {
      reused[i] = out[i]!
      changed.push(i)
    }
  }
  return { rows: reused, pulse: pulseOfMapping(from, input.to, changed) }
}

function filterPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevPass: boolean[] | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (!prevPass || prevPass.length !== oldLen) return null
  // Old output index for each old input index (the filter preserves input order).
  const oldOut = new Array<number>(oldLen).fill(-1)
  let acc = 0
  for (let i = 0; i < oldLen; i++) if (prevPass[i]) oldOut[i] = acc++
  const expr = (t as { expr?: string }).expr ?? ''
  const fn = (row: Row): boolean => { try { return Boolean(tctx.runtime.expr(expr)(row, tctx.signals)) } catch { return false } }
  const modified = isModified(input)
  const pass = new Array<boolean>(rows.length)
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const retained = old >= 0 && !modified.has(i) && prevPass[old] !== undefined
    pass[i] = retained ? prevPass![old]! : fn(rows[i]!)
    if (!pass[i]) continue
    const oldIdx = retained && old >= 0 ? oldOut[old]! : -1
    const outIdx = out.length
    if (oldIdx >= 0 && prev && prev[oldIdx] !== undefined) out.push(prev[oldIdx]!)
    else out.push(rows[i]!)
    if (!retained || modified.has(i)) changed.push(outIdx)
    outFrom.push(oldIdx)
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state: pass }
}

function foldPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const n = ((t as { fields?: unknown[] }).fields ?? []).length
  if (!n) return null
  const from = input.from!
  const modified = isModified(input)
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const start = out.length
    const canReuse = old >= 0 && !modified.has(i) && prev && prev.length === from.length * n
    if (canReuse) {
      for (let j = 0; j < n; j++) {
        out.push(prev![old * n + j]!)
        outFrom.push(old * n + j)
      }
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) {
      out.push(derived[j]!)
      outFrom.push(-1)
      changed.push(start + j)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed) }
}

interface FlattenState { sizes: number[]; offsets: number[] }

function flattenSize(row: Row, fields: string[]): number {
  let maxlen = 0
  for (const f of fields) {
    const a = (row as Record<string, unknown>)[f]
    const len = Array.isArray(a) ? a.length : (a as { length?: number })?.length
    maxlen = len == null ? NaN : Math.max(maxlen, len)
  }
  return Number.isFinite(maxlen) && maxlen > 0 ? maxlen : 0
}

function flattenPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: FlattenState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const fields = (t as { fields?: string[] }).fields ?? []
  const from = input.from!
  const modified = isModified(input)
  if (!prevState || prevState.sizes.length !== (input.to?.length ?? -1)) return null
  const sizes = new Array<number>(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && !modified.has(i)) {
      sizes[i] = prevState.sizes[old]!
    } else {
      sizes[i] = flattenSize(rows[i]!, fields)
      if (old >= 0 && sizes[i] !== prevState.sizes[old]) return null
    }
  }
  const offsets = new Array<number>(rows.length)
  let pos = 0
  for (let i = 0; i < rows.length; i++) { offsets[i] = pos; pos += sizes[i]! }
  if (prev && prev.length !== prevState.offsets.reduce((a, o, i) => Math.max(a, o + prevState.sizes[i]!), 0)) {
    // The cached output length does not line up with the cached state; fall back.
    if (prev.length !== prevState.offsets.length && prev.length < pos) return null
  }
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const size = sizes[i]!
    const start = out.length
    const canReuse = old >= 0 && !modified.has(i) && prev && prevState.sizes[old] === size
    if (canReuse) {
      for (let j = 0; j < size; j++) {
        const oldIdx = prevState.offsets[old]! + j
        out.push(prev![oldIdx]!)
        outFrom.push(oldIdx)
      }
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    for (let j = 0; j < size; j++) {
      out.push(derived[j] ?? rows[i]!)
      outFrom.push(-1)
      changed.push(start + j)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state: { sizes, offsets } }
}

/**
 * Incremental aggregate: rebuild the group membership index, recompute only the
 * dirty groups, and key the output by group so unchanged groups keep their row
 * objects and output positions.
 */
function aggregatePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  if (!prevState) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (prevState.rowKey.length !== oldLen) return null
  const dirty = new Set<string>()
  for (let i = 0; i < from.length; i++) if (from[i]! < 0) dirty.add(groupKeyOf(rows[i]!, groupby))
  if (input.to) for (let i = 0; i < input.to.length; i++) if (input.to[i]! < 0) dirty.add(prevState.rowKey[i]!)
  const modified = isModified(input)
  for (const i of modified) {
    if (i < 0 || i >= rows.length) return null
    dirty.add(groupKeyOf(rows[i]!, groupby))
    const old = from[i]!
    if (old >= 0 && old < prevState.rowKey.length) dirty.add(prevState.rowKey[old]!)
  }

  const rowKey = new Array<string>(rows.length)
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey[i] = k
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const outOrder: string[] = []
  for (const k of prevState.outOrder) if (keyToIdx.has(k)) outOrder.push(k)
  for (const k of keyToIdx.keys()) if (!prevState.outIdx.has(k)) outOrder.push(k)

  const agg = t as Record<string, unknown>
  const aggFields = (agg.fields as (string | null)[] | undefined) ?? []
  const aggOps = (agg.ops as string[] | undefined) ?? []
  const aggAs = (agg.as as string[] | undefined) ?? []
  const aggParams = agg.aggregate_params as (number | null)[] | undefined
  const outByKey = new Map<string, Row>()
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  const outIdx = new Map<string, number>()
  for (const k of outOrder) {
    const idxs = keyToIdx.get(k)!
    const oldIdx = prevState.outIdx.get(k)
    const oldRow = oldIdx != null ? prevState.outByKey.get(k) : undefined
    let next: Row
    if (!dirty.has(k) && oldRow) next = oldRow
    else {
      next = aggregateGroup(idxs.map((i) => rows[i]!), groupby, aggFields, aggOps, aggAs, aggParams)
      if (oldRow && rowsEqual(next, oldRow)) next = oldRow
    }
    const at = out.length
    outIdx.set(k, at)
    outByKey.set(k, next)
    out.push(next)
    if (oldIdx != null) {
      outFrom.push(oldIdx)
      if (next !== oldRow) changed.push(at)
    } else {
      outFrom.push(-1)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  // Refresh the persistent state for the next pulse.
  const state = buildAggState(rows, groupby, out)
  state.outByKey = outByKey
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state }
}

/** Incremental joinaggregate: 1:1 with the input; only dirty groups re-derive. */
function joinAggregatePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  if (!prevState) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (prevState.rowKey.length !== oldLen) return null
  const dirty = new Set<string>()
  for (let i = 0; i < from.length; i++) if (from[i]! < 0) dirty.add(groupKeyOf(rows[i]!, groupby))
  if (input.to) for (let i = 0; i < input.to.length; i++) if (input.to[i]! < 0) dirty.add(prevState.rowKey[i]!)
  const modified = isModified(input)
  for (const i of modified) {
    if (i < 0 || i >= rows.length) return null
    dirty.add(groupKeyOf(rows[i]!, groupby))
    const old = from[i]!
    if (old >= 0 && old < prevState.rowKey.length) dirty.add(prevState.rowKey[old]!)
  }
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const out = new Array<Row>(rows.length)
  const changed: number[] = []
  for (const k of dirty) {
    const idxs = keyToIdx.get(k)
    if (!idxs) continue
    const derived = applyOne(idxs.map((i) => rows[i]!), t, tctx, sourceName)
    if (derived.length !== idxs.length) return null
    for (let j = 0; j < idxs.length; j++) {
      out[idxs[j]!] = derived[j]!
      changed.push(idxs[j]!)
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (out[i] !== undefined) continue
    const old = from[i]!
    if (old >= 0 && !modified.has(i) && prev && prev[old] !== undefined) out[i] = prev[old]!
    else out[i] = rows[i]!
  }
  const state = buildAggState(rows, groupby, out)
  return { rows: out, pulse: pulseOfMapping(from, input.to, changed), state }
}

/** Incremental aggregate for an append-only pulse (no group removals). */
function aggregateAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prevState || !prev || prevState.rowKey.length !== base || prev.length !== prevState.outOrder.length) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const keyToIdx = prevState.keyToIdx
  const rowKey = prevState.rowKey
  const dirty = new Set<string>()
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const k = groupKeyOf(rows[i]!, groupby)
    if (prevState.rowKey[i] !== k) return null
    dirty.add(k)
  }
  const newKeys: string[] = []
  for (let i = base; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey.push(k)
    let idxs = keyToIdx.get(k)
    if (!idxs) { keyToIdx.set(k, (idxs = [])); newKeys.push(k) }
    idxs.push(i)
    dirty.add(k)
  }
  const outOrder = [...prevState.outOrder, ...newKeys]
  const outByKey = new Map(prevState.outByKey)
  const outIdx = new Map<string, number>()
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  const agg = t as Record<string, unknown>
  const aggFields = (agg.fields as (string | null)[] | undefined) ?? []
  const aggOps = (agg.ops as string[] | undefined) ?? []
  const aggAs = (agg.as as string[] | undefined) ?? []
  const aggParams = agg.aggregate_params as (number | null)[] | undefined
  for (const k of outOrder) {
    const oldIdx = prevState.outIdx.get(k)
    const oldRow = prevState.outByKey.get(k)
    let next: Row
    if (!dirty.has(k) && oldRow) next = oldRow
    else {
      const idxs = keyToIdx.get(k)!
      next = aggregateGroup(idxs.map((i) => rows[i]!), groupby, aggFields, aggOps, aggAs, aggParams)
      if (oldRow && rowsEqual(next, oldRow)) next = oldRow
    }
    const at = out.length
    outIdx.set(k, at)
    outByKey.set(k, next)
    out.push(next)
    if (oldIdx != null) {
      outFrom.push(oldIdx)
      if (next !== oldRow) changed.push(at)
    } else outFrom.push(-1)
  }
  const state: AggState = {
    groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey,
    groupStart: prevState.groupStart, groupSize: prevState.groupSize, out,
  }
  void sourceName; void tctx; void outFrom
  return { rows: out, pulse: appendPulse(prev.length, out.length, changed), state }
}

/** Incremental joinaggregate for an append-only pulse. */
function joinAggregateAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prevState || !prev || prev.length !== base || prevState.rowKey.length !== base) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const keyToIdx = prevState.keyToIdx
  const rowKey = prevState.rowKey
  const dirty = new Set<string>()
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const k = groupKeyOf(rows[i]!, groupby)
    if (prevState.rowKey[i] !== k) return null
    dirty.add(k)
  }
  const newKeys: string[] = []
  for (let i = base; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey.push(k)
    let idxs = keyToIdx.get(k)
    if (!idxs) { keyToIdx.set(k, (idxs = [])); newKeys.push(k) }
    idxs.push(i)
    dirty.add(k)
  }
  const changed: number[] = []
  for (const k of dirty) {
    const idxs = keyToIdx.get(k)
    if (!idxs) continue
    const derived = applyOne(idxs.map((i) => rows[i]!), t, tctx, sourceName)
    if (derived.length !== idxs.length) return null
    for (let j = 0; j < idxs.length; j++) {
      const i = idxs[j]!
      const old = prev[i]
      if (i < base) {
        if (old !== undefined && rowsEqual(derived[j]!, old)) continue
        changed.push(i)
      }
      prev[i] = derived[j]!
    }
  }
  const outOrder = [...prevState.outOrder, ...newKeys]
  const outIdx = new Map(prevState.outIdx)
  for (const k of newKeys) outIdx.set(k, outIdx.size)
  const state: AggState = {
    groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey: prevState.outByKey,
    groupStart: prevState.groupStart, groupSize: prevState.groupSize, out: prev,
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, changed), state }
}

/** Incremental collect/sample: only the order permutation changes. */
function orderedAppendPulse(
  rows: Row[], t: CompiledTransform, input: StepPulse, prev: Row[] | undefined,
  prevState: { order: number[] } | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prev || !prevState || prevState.order.length !== base || prev.length !== base) return null
  const type = String(t.type)
  const sort = (t as { sort?: SortSpec }).sort
  const size = type === 'sample' ? ((t as { size?: number }).size ?? 0) : Infinity
  const order = sortOrder(rows, sort, size)
  const oldPos = new Map<number, number>()
  for (let i = 0; i < prevState.order.length; i++) oldPos.set(prevState.order[i]!, i)
  const modified = isModified(input)
  const out: Row[] = new Array(order.length)
  const from = new Array<number>(order.length).fill(-1)
  const changed: number[] = []
  for (let j = 0; j < order.length; j++) {
    const idx = order[j]!
    const old = idx < base && !modified.has(idx) ? oldPos.get(idx) : undefined
    if (old != null && prev[old] !== undefined) {
      out[j] = prev[old]!
      from[j] = old
    } else {
      out[j] = rows[idx]!
      changed.push(j)
    }
  }
  const to = new Array<number>(prev.length).fill(-1)
  for (let i = 0; i < from.length; i++) if (from[i]! >= 0) to[from[i]!] = i
  return { rows: out, pulse: pulseOfMapping(from, to, changed), state: { order } }
}

/**
 * Window/stack: the full transform re-derives (group order/sort are global),
 * but the grouped output layout is compared group-by-group so unchanged rows
 * keep their item identity and the mapping still splices downstream.
 */
function windowStackPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const out = applyOne(rows, t, tctx, sourceName)
  if (!prevState || !prev) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const from = input.from!
  const modified = isModified(input)
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const outOrder = [...keyToIdx.keys()]
  // Old input index -> rank within its group, built once (indexOf per member
  // made a large grouped window quadratic).
  const oldRank = new Map<string, Map<number, number>>()
  for (const [k, idxs] of prevState.keyToIdx) {
    const ranks = new Map<number, number>()
    for (let j = 0; j < idxs.length; j++) ranks.set(idxs[j]!, j)
    oldRank.set(k, ranks)
  }
  let pos = 0
  const outFrom = new Array<number>(out.length).fill(-1)
  const changed: number[] = []
  for (const k of outOrder) {
    const idxs = keyToIdx.get(k)!
    const oldStart = prevState.groupStart.get(k)
    const ranks = oldRank.get(k)
    for (let j = 0; j < idxs.length; j++) {
      const ni = pos + j
      const oldInput = from[idxs[j]!]!
      if (oldInput < 0 || modified.has(idxs[j]!)) { changed.push(ni); continue }
      const rank = ranks?.get(oldInput) ?? -1
      if (rank < 0 || oldStart == null) { changed.push(ni); continue }
      const oldOut = oldStart + rank
      outFrom[ni] = oldOut
      if (prev[oldOut] !== undefined && rowsEqual(out[ni]!, prev[oldOut]!)) out[ni] = prev[oldOut]!
      else changed.push(ni)
    }
    pos += idxs.length
  }
  const to = new Array<number>(prev.length).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  const state = buildAggState(rows, groupby, out)
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state }
}

/** sequence appends generated rows after the source rows; the tail is stable. */
function sequencePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const from = input.from!
  // A removal/replacement in the source shifts the generated tail; fall back.
  if (input.to && input.to.some((v) => v < 0)) return null
  if (input.changed.length) return null
  const generated = (applyTransforms([], [t], tctx, sourceName) as Row[])
  const oldLen = input.to?.length ?? -1
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && prev && prev[old] !== undefined) { out.push(prev[old]!); outFrom.push(old) }
    else { out.push(rows[i]!); outFrom.push(-1); changed.push(out.length - 1) }
  }
  for (let j = 0; j < generated.length; j++) {
    const oldIdx = oldLen + j
    if (prev && prev[oldIdx] !== undefined) { out.push(prev[oldIdx]!); outFrom.push(oldIdx) }
    else { out.push(generated[j]!); outFrom.push(-1); changed.push(out.length - 1) }
  }
  const to = new Array<number>(prev ? prev.length : oldLen + generated.length).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed) }
}

/** A generating transform whose output is independent of the input rows. */
function generatingPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } {
  const out = applyOne(rows, t, tctx, sourceName)
  if (prev && out.length === prev.length && out.every((r, i) => rowsEqual(r, prev[i]!))) {
    return { rows: prev, pulse: pulseOfMapping(identityMapping(prev.length), identityMapping(prev.length), []) }
  }
  return { rows: out, pulse: { changed: [], full: true } }
}

/**
 * Apply one transform to a length-changing pulse. Returns `null` when the
 * transform cannot publish a mapping (the caller then re-derives the rest).
 */
function applyStepWithPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevStepState: unknown,
): { rows: Row[]; pulse: StepPulse | null; state?: unknown } {
  const type = String(t.type)
  if (input.appendOnly) {
    // Fast paths that never need the full mapping.
    const appendLocal = type === 'formula' || type === 'timeunit' || type === 'geoshape'
      || type === 'geopoint' || type === 'linkpath' || type === 'project' || type === 'identifier'
      || (type === 'bin' && Array.isArray((t as { extent?: unknown }).extent))
      || (type === 'lookup' && !tctx.affectedDatasets?.has((t as { from?: string }).from ?? ''))
    if (appendLocal) {
      const fast = rowLocalAppendPulse(rows, t, tctx, sourceName, input, prev)
      if (fast) return fast
    } else if (type === 'filter') {
      const fast = filterAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as boolean[] | undefined)
      if (fast) return fast
    } else if (type === 'fold') {
      const fast = foldAppendPulse(rows, t, tctx, sourceName, input, prev)
      if (fast) return fast
    } else if (type === 'aggregate') {
      const fast = aggregateAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
      if (fast) return fast
    } else if (type === 'joinaggregate') {
      const fast = joinAggregateAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
      if (fast) return fast
    } else if (type === 'collect' || type === 'sample') {
      const fast = orderedAppendPulse(rows, t, input, prev, prevStepState as { order: number[] } | undefined)
      if (fast) return fast
    } else if (type === 'geojson' || type === 'extent' || type === 'stratify') {
      return { rows: applyOne(rows, t, tctx, sourceName), pulse: input }
    }
    // Everything else needs old<->new indices; synthesise them only here.
    const from = mappingFromPulse(input, rows.length)
    input = { ...input, from, to: inverseMapping(from, pulseBaseLength(input)), appendOnly: undefined, baseLength: undefined }
  }
  switch (type) {
    case 'formula':
    case 'timeunit':
    case 'geoshape':
    case 'geopoint':
    case 'linkpath':
    case 'project':
      return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'bin': {
      const fixed = Array.isArray((t as { extent?: unknown }).extent)
      if (fixed) return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      return rederiveAligned(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    }
    case 'lookup': {
      const from = (t as { from?: string }).from ?? ''
      if (tctx.affectedDatasets?.has(from)) return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    }
    case 'identifier': {
      // Inserts/deletes shift index-derived ids; only an append-only pulse can
      // reuse the retained ids.
      const from = input.from!
      const stable = from.every((old, i) => old < 0 || old === i)
      if (stable) return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      return rederiveAligned(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    }
    case 'geojson':
    case 'extent':
    case 'stratify': {
      const out = applyOne(rows, t, tctx, sourceName)
      return { rows: out, pulse: input }
    }
    case 'filter':
      return filterPulse(rows, t, tctx, sourceName, input, prev, prevStepState as boolean[] | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'fold':
      return foldPulse(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'flatten':
      return flattenPulse(rows, t, tctx, sourceName, input, prev, prevStepState as FlattenState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'aggregate':
      return aggregatePulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'joinaggregate':
      return joinAggregatePulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'window':
    case 'stack':
      return windowStackPulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'pie':
    case 'dotbin':
    case 'label':
    case 'pack':
    case 'partition':
    case 'treemap':
    case 'voronoi':
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'sequence':
      return sequencePulse(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'graticule':
      return generatingPulse(rows, t, tctx, sourceName, prev)
    default:
      // Global generators/fitters (kde/regression/loess/wordcloud/contour/...)
      // cannot expose a row mapping.
      return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
  }
}

/** Apply a transform chain with a length-changing pulse, step by step. */
function applyPipelineWithPulse(
  rows: Row[], transforms: CompiledTransform[], tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prevSteps: Row[][] | undefined,
): { rows: Row[]; pulse: StepPulse | null; steps: Row[][] } {
  let cur = rows
  let pulse: StepPulse | null = input
  const steps: Row[][] = []
  const stepCache = (tctx as unknown as { stepCache?: Map<string, unknown> }).stepCache
  for (let k = 0; k < transforms.length; k++) {
    const t = transforms[k]!
    const prev = prevSteps?.[k]
    if (!pulse) {
      cur = applyOne(cur, t, tctx, sourceName)
      steps.push(cur)
      continue
    }
    const key = `${sourceName}#${k}`
    const prevState = stepCache?.get(key)
    const res = applyStepWithPulse(cur, t, tctx, sourceName, pulse, prev, prevState)
    cur = res.rows
    pulse = res.pulse
    steps.push(cur)
    if (stepCache && res.state !== undefined) stepCache.set(key, res.state)
  }
  return { rows: cur, pulse, steps }
}

function buildDatasets(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  const sources = new Map<string, CompiledChart['data'][number]>()
  for (const d of ctx.chart.data) sources.set(d.name, d)

  const build = (name: string, seen: Set<string>): Row[] => {
    ctx.checkDeadline?.('dataset build')
    if (ctx.datasets.has(name)) return ctx.datasets.get(name)!
    const d = sources.get(name)
    if (!d) {
      const rows = (inputData[name] as Row[]) ?? []
      ctx.datasets.set(name, rows)
      ctx.datasetChanges?.set(name, ctx.dataChanges?.get(name) ?? null)
      const pulse = ctx.inputPulses?.get(name) ?? (ctx.dataChanges?.get(name)
        ? { changed: [...ctx.dataChanges.get(name)!] }
        : null)
      ctx.datasetPulses.set(name, pulse)
      return rows
    }
    if (seen.has(name)) throw new Error(`[aster] circular data reference: ${name}`)
    seen.add(name)

    let rows: Row[]
    let inPulse: StepPulse | null = null
    if ('source' in d && (d as CompiledChart['data'][number] & { source: string }).source) {
      const src = (d as CompiledChart['data'][number] & { source: string }).source
      const srcDef = ctx.chart.data.find((sd) => sd.name === src)
      if ((d as { format?: DataFormatSpec }).format && srcDef?.values != null) {
        // Vega applies a derived dataset's `format` when (re-)parsing its
        // source's raw values (e.g. source = inline Topology, format =
        // topojson feature extraction).
        rows = readData(srcDef.values, (d as { format?: DataFormatSpec }).format)
        inPulse = ctx.inputPulses?.get(src) ?? null
      } else {
        rows = build(src, seen).map((r) => ({ ...r }))
        inPulse = ctx.datasetPulses.get(src) ?? null
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
    if (!inPulse && !('source' in d && (d as CompiledChart['data'][number] & { source: string }).source)) {
      inPulse = ctx.inputPulses?.get(name) ?? (ctx.dataChanges?.get(name)
        ? { changed: [...ctx.dataChanges.get(name)!] }
        : null)
    }
    const inputRows = rows
    let outputChanges: Set<number> | null = null
    let outPulse: StepPulse | null = null
    if (d.transform.length) {
      const chartMetaData = ctx.chart as unknown as {
        __prevDatasetOutputs?: Map<string, Row[]>
        __aggState?: Map<string, AggState>
        __filterPassed?: Map<string, boolean[]>
        __binState?: Map<string, { lo: number; hi: number; start: number; stop: number; step: number; out: Row[]; oldVals: number[] }>
        __foldState?: Map<string, { n: number; out: Row[] }>
        __flattenState?: Map<string, { offsets: number[]; sizes: number[]; out: Row[] }>
        __prevStepOutputs?: Map<string, Row[][]>
        __stepCache?: Map<string, unknown>
        __paramFp?: string
      }
      const prevOutputs = chartMetaData.__prevDatasetOutputs
      const prevSteps = chartMetaData.__prevStepOutputs?.get(name)
      const changes = ctx.dataChanges?.get(name)
      const lengthPulse = isLengthPulse(inPulse) ? inPulse : null
      const paramsUnchanged = paramFpOf(ctx.signalParams) === chartMetaData.__paramFp
      const single = d.transform.length === 1 ? (d.transform[0] as Record<string, unknown> | undefined) : null
      const isAgg = single?.type === 'aggregate'
      const isJoinAgg = single?.type === 'joinaggregate'
      const isFilter = single?.type === 'filter'
      const isBinData = single?.type === 'bin' && !Array.isArray((single as { extent?: unknown }).extent)
      // A sort only reorders rows within each group; the group's contiguous
      // output block keeps its length, so dirty-group re-derivation is still
      // safe (all indices in the block are marked changed).
      const isGrouped = (single?.type === 'window' || single?.type === 'stack')
        && ((single as { groupby?: unknown }).groupby as string[] | undefined)?.length
      const t = single!
      let aggUpdated = false
      // Incremental filter: re-evaluate the predicate only for changed rows and
      // rebuild the (input-order) filtered output from the cached per-row pass
      // status. The output length/order may change (rows dropped/kept), so the
      // mark is not per-item reusable; the win is the O(n) predicate eval.
      if (isFilter && ctx.incremental && changes && paramsUnchanged) {
        const cachedPassed = chartMetaData.__filterPassed?.get(name)
        const expr = (single as { expr?: string }).expr ?? ''
        if (cachedPassed && cachedPassed.length === rows.length) {
          let saw = false
          for (const i of changes) if (i >= 0 && i < rows.length) { saw = true; break }
          if (saw) {
            const fn = (row: Row): boolean => { try { return Boolean(ctx.runtime.expr(expr)(row, ctx.signalParams)) } catch { return false } }
            const newPassed = new Array<boolean>(rows.length)
            const out: Row[] = []
            for (let i = 0; i < rows.length; i++) {
              const passed = changes.has(i) ? fn(rows[i]!) : cachedPassed[i]!
              newPassed[i] = passed
              if (passed) out.push(rows[i]!)
            }
            rows = out
            if (!chartMetaData.__filterPassed) chartMetaData.__filterPassed = new Map()
            chartMetaData.__filterPassed.set(name, newPassed)
            aggUpdated = true
          }
        }
      }
      // Incremental bin (data-derived extent): re-bin only changed rows when the
      // extent is unchanged. The extent shifts only if a changed row's new value
      // falls outside [lo, hi], or its old value was at the boundary (the min or
      // max may move), so those cases fall back to a full re-derive.
      if (isBinData && ctx.incremental && changes && paramsUnchanged) {
        const bs = chartMetaData.__binState?.get(name)
        const field = (single as { field?: string }).field ?? ''
        const as = (single as { as?: string[] }).as ?? ['b0', 'b1']
        if (bs && bs.oldVals.length === rows.length) {
          let safe = true
          for (const i of changes) {
            if (i < 0 || i >= rows.length) { safe = false; break }
            const newV = Number((rows[i] as Record<string, unknown>)[field])
            const oldV = bs.oldVals[i]!
            if (newV < bs.lo || newV > bs.hi || oldV === bs.lo || oldV === bs.hi) { safe = false; break }
          }
          if (safe) {
            const out = bs.out
            for (const i of changes) {
              if (i < 0 || i >= out.length) continue
              const v = Number((rows[i] as Record<string, unknown>)[field])
              const row = rows[i]!
              if (!Number.isFinite(v) || v < bs.start || v > bs.stop) {
                out[i] = { ...row, [as[0]!]: undefined, [as[1]!]: undefined }
              } else {
                const b0 = bs.start + Math.floor((v - bs.start) / bs.step) * bs.step
                out[i] = { ...row, [as[0]!]: b0, [as[1]!]: b0 + bs.step }
              }
            }
            rows = out
            outputChanges = new Set(changes)
            aggUpdated = true
          }
        }
      }
      // Incremental fold: each input row expands to exactly n output rows
      // (index = inputIndex*n + fieldIndex), so a changed row's contiguous block
      // is re-derived in place when the input length is unchanged.
      if (single?.type === 'fold' && ctx.incremental && changes && paramsUnchanged) {
        const fs = chartMetaData.__foldState?.get(name)
        const n = ((single as { fields?: unknown[] }).fields ?? []).length
        if (fs && fs.n === n && fs.out.length === rows.length * n) {
          const out = fs.out
          for (const i of changes) {
            if (i < 0 || i >= rows.length) continue
            const derived = applyTransforms([rows[i]!], [single as never], {
              runtime: ctx.runtime, signals: ctx.signalParams, datasets: (x) => ctx.datasets.get(x) ?? [], hierarchies: ctx.hierarchies, projections: ctx.projections,
            }, d.name)
            for (let j = 0; j < n && j < derived.length; j++) out[i * n + j] = derived[j]!
          }
          rows = out
          const allDirty = new Set<number>()
          for (const i of changes) if (i >= 0 && i < rows.length / n) for (let j = 0; j < n; j++) allDirty.add(i * n + j)
          outputChanges = allDirty
          aggUpdated = true
        }
      }
      // Incremental flatten: each row expands to `size[i]` rows (the max array
      // length across its fields), placed at a cached per-row offset. Safe only
      // when every changed row's arrays retain their length (so its index block
      // stays fixed); a changed expand count shifts the offsets -> full re-derive.
      if (single?.type === 'flatten' && ctx.incremental && changes && paramsUnchanged) {
        const fs = chartMetaData.__flattenState?.get(name)
        const fields = (single as { fields?: string[] }).fields ?? []
        const sizeOf = (r: Row): number => {
          let maxlen = 0
          for (const f of fields) {
            const a = (r as Record<string, unknown>)[f]
            const len = Array.isArray(a) ? a.length : (a as { length?: number })?.length
            maxlen = len == null ? NaN : Math.max(maxlen, len)
          }
          return Number.isFinite(maxlen) && maxlen > 0 ? maxlen : 0
        }
        if (fs && fs.offsets.length === rows.length) {
          let safe = true
          for (const i of changes) {
            if (i < 0 || i >= rows.length) { safe = false; break }
            if (sizeOf(rows[i]!) !== fs.sizes[i]) { safe = false; break }
          }
          if (safe) {
            const out = fs.out
            for (const i of changes) {
              if (i < 0 || i >= rows.length) continue
              const n = fs.sizes[i]!
              const derived = applyTransforms([rows[i]!], [single as never], {
                runtime: ctx.runtime, signals: ctx.signalParams, datasets: (x) => ctx.datasets.get(x) ?? [], hierarchies: ctx.hierarchies, projections: ctx.projections,
              }, d.name)
              for (let j = 0; j < n && j < derived.length; j++) out[fs.offsets[i]! + j] = derived[j]!
            }
            rows = out
            const allDirty = new Set<number>()
            for (const i of changes) if (i >= 0 && i < fs.offsets.length) for (let j = 0; j < fs.sizes[i]!; j++) allDirty.add(fs.offsets[i]! + j)
            outputChanges = allDirty
            aggUpdated = true
          }
        }
      }
      // Incremental group transforms (aggregate/joinaggregate/window/stack):
      // re-derive only the groups touched by the changeset. Safe only when no
      // changed row switches group (a membership change would add/remove/reorder
      // output rows), which requires a full re-derive. aggregate emits one row per
      // group; joinaggregate merges the group aggregate onto each (1:1) row;
      // window/stack emit a grouped (contiguous per group) output.
      if ((isAgg || isJoinAgg || isGrouped) && ctx.incremental && changes && paramsUnchanged) {
        const groupby = (single!.groupby as string[] | undefined) ?? []
        let state = chartMetaData.__aggState?.get(name)
        if (state && state.rowKey.length === rows.length) {
          const dirty = new Set<string>()
          let safe = true
          for (const i of changes) {
            if (i < 0 || i >= rows.length) { safe = false; break }
            const k = groupKeyOf(rows[i]!, groupby)
            if (state!.rowKey[i] !== k) { safe = false; break }
            dirty.add(k)
          }
          if (safe && dirty.size) {
            const apply = (gRows: Row[]): Row[] => applyTransforms(gRows, [t as never], {
              runtime: ctx.runtime,
              signals: ctx.signalParams,
              datasets: (n) => ctx.datasets.get(n) ?? [],
              hierarchies: ctx.hierarchies,
              projections: ctx.projections,
            }, d.name)
            if (isAgg) {
              // The dirty groups' rows all share one group key (keyToIdx is the
              // membership index), so aggregateGroup can be called directly —
              // the generic pipeline would run groupRows and rebuild a Map per
              // group for a group that is already known.
              const aggFields = (t.fields as (string | null)[] | undefined) ?? []
              const aggOps = (t.ops as string[] | undefined) ?? []
              const aggAs = (t.as as string[] | undefined) ?? []
              const aggParams = (t as { aggregate_params?: (number | null)[] }).aggregate_params
              for (const g of dirty) {
                const idxs = state!.keyToIdx.get(g)
                if (!idxs) { safe = false; break }
                const derived = aggregateGroup(idxs.map((idx) => rows[idx]!), state!.groupby, aggFields, aggOps, aggAs, aggParams)
                state!.outByKey.set(g, derived)
              }
              if (safe) {
                const out = state!.outOrder.map((k) => state!.outByKey.get(k)!)
                state!.out = out
                rows = out
                chartMetaData.__aggState!.set(name, state!)
                aggUpdated = true
                const outIdx = state!.outIdx
                outputChanges = new Set([...dirty].map((g) => outIdx.get(g)!).filter((i) => i != null))
              }
            } else {
              const out = state!.out
              for (const g of dirty) {
                const idxs = state!.keyToIdx.get(g)
                if (!idxs) { safe = false; break }
                const derived = apply(idxs.map((idx) => rows[idx]!))
                if (isJoinAgg) {
                  derived.forEach((r, j) => { out[idxs[j]!] = r })
                } else {
                  const start = state!.groupStart.get(g)!
                  derived.forEach((r, j) => { out[start + j] = r })
                }
              }
              if (safe) {
                rows = out
                const allDirty = new Set<number>()
                for (const g of dirty) {
                  if (isJoinAgg) {
                    for (const idx of state!.keyToIdx.get(g)!) allDirty.add(idx)
                  } else {
                    const start = state!.groupStart.get(g)!
                    for (let j = 0; j < state!.keyToIdx.get(g)!.length; j++) allDirty.add(start + j)
                  }
                }
                outputChanges = allDirty
                chartMetaData.__aggState!.set(name, state!)
                aggUpdated = true
              }
            }
          }
        }
      }
      // Row-wise transforms (formula/identifier) map index to index, so the
      // output rows for indices not in the changeset are unchanged and can be
      // reused. A global transform (filter/aggregate/stack/bin/...) invalidates
      // every output row, and a change to any expression parameter (width or a
      // signal) invalidates every formula, so both fall back to a full re-derive.
      // Row-wise transforms preserve index/length: formula/identifier/timeunit
      // always; bin with a fixed numeric extent (constant thresholds); lookup when
      // its source dataset is unaffected (its join result is unchanged for
      // unchanged rows — a row's lookup only needs re-deriving when the row
      // changed).
      const rowwise = d.transform.every(
        (tm) => tm.type === 'formula' || tm.type === 'identifier' || tm.type === 'timeunit'
          || (tm.type === 'bin' && Array.isArray((tm as { extent?: unknown }).extent))
          || (tm.type === 'lookup' && !ctx.affected.has((tm as { from?: string }).from ?? '')),
      )
      const cached = prevOutputs?.get(name)
      if (aggUpdated) {
        // Incremental aggregate already produced the output; nothing to do.
      } else if (changes && rowwise && paramsUnchanged && cached && cached.length === rows.length) {
        const apply = (single: Row[]): Row[] => applyTransforms(single, d.transform, {
          runtime: ctx.runtime,
          signals: ctx.signalParams,
          datasets: (n) => ctx.datasets.get(n) ?? [],
          hierarchies: ctx.hierarchies,
          projections: ctx.projections,
        }, d.name)
        const via = changes.size < rows.length / 2 ? changes : null
        if (via) {
          const out = cached.slice()
          for (const i of via) {
            if (i < 0 || i >= out.length) continue
            const derived = apply([rows[i]!])
            if (derived[0] != null) out[i] = derived[0]
          }
          rows = out
          outputChanges = new Set(via)
        } else {
          rows = apply(rows)
        }
      } else if (lengthPulse && paramsUnchanged) {
        const tctx: StepTransformContext = {
          runtime: ctx.runtime,
          signals: ctx.signalParams,
          datasets: (n) => {
            if (!ctx.datasets.has(n) && sources.has(n)) build(n, new Set())
            return ctx.datasets.get(n)
          },
          hierarchies: ctx.hierarchies,
          projections: ctx.projections,
          affectedDatasets: ctx.affected,
          stepCache: chartMetaData.__stepCache ?? (chartMetaData.__stepCache = new Map()),
        }
        const res = applyPipelineWithPulse(rows, d.transform, tctx, d.name, lengthPulse, prevSteps)
        rows = res.rows
        outPulse = res.pulse
        if (!chartMetaData.__prevStepOutputs) chartMetaData.__prevStepOutputs = new Map()
        chartMetaData.__prevStepOutputs.set(d.name, res.steps)
      } else {
        const tctx: StepTransformContext = {
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
          affectedDatasets: ctx.affected,
          stepCache: chartMetaData.__stepCache ?? (chartMetaData.__stepCache = new Map()),
        }
        const steps: Row[][] = []
        let cur = rows
        for (let k = 0; k < d.transform.length; k++) {
          cur = applyOne(cur, d.transform[k]!, tctx, d.name)
          steps.push(cur)
        }
        rows = cur
        if (!chartMetaData.__prevStepOutputs) chartMetaData.__prevStepOutputs = new Map()
        chartMetaData.__prevStepOutputs.set(d.name, steps)
        // Populate per-step state for the next incremental pulse (filter/flatten/
        // groups). This is cheap: the full transform already visited the rows.
        const cache = chartMetaData.__stepCache ?? (chartMetaData.__stepCache = new Map())
        for (let k = 0; k < d.transform.length; k++) {
          const tm = d.transform[k]!
          const key = `${d.name}#${k}`
          const inputAtStep = k === 0 ? inputRows : steps[k - 1]!
          if (tm.type === 'filter') {
            const expr = (tm as { expr?: string }).expr ?? ''
            const fn = (row: Row): boolean => { try { return Boolean(ctx.runtime.expr(expr)(row, ctx.signalParams)) } catch { return false } }
            cache.set(key, inputAtStep.map((r) => fn(r)))
          } else if (tm.type === 'flatten') {
            const fields = (tm as { fields?: string[] }).fields ?? []
            const sizes = inputAtStep.map((r) => flattenSize(r, fields))
            const offsets: number[] = []
            let p = 0
            for (const sz of sizes) { offsets.push(p); p += sz }
            cache.set(key, { sizes, offsets })
          } else if (tm.type === 'aggregate' || tm.type === 'joinaggregate' || tm.type === 'window' || tm.type === 'stack') {
            cache.set(key, buildAggState(inputAtStep, (tm as { groupby?: string[] }).groupby ?? [], steps[k]!))
          } else if (tm.type === 'collect' || tm.type === 'sample') {
            const limit = tm.type === 'sample' ? ((tm as { size?: number }).size ?? 0) : Infinity
            cache.set(key, { order: sortOrder(inputAtStep, (tm as { sort?: SortSpec }).sort, limit) })
          }
        }
      }
      // Refresh the persistent group index whenever the group transform was
      // fully re-derived (first eval, an unsafe changeset, or a non-incremental
      // path).
      if ((isAgg || isJoinAgg || isGrouped) && !aggUpdated) {
        if (!chartMetaData.__aggState) chartMetaData.__aggState = new Map()
        chartMetaData.__aggState.set(name, buildAggState(inputRows, (single as { groupby?: string[] }).groupby ?? [], rows))
      }
      if (isFilter && !aggUpdated) {
        if (!chartMetaData.__filterPassed) chartMetaData.__filterPassed = new Map()
        const expr = (single as { expr?: string }).expr ?? ''
        const fn = (row: Row): boolean => { try { return Boolean(ctx.runtime.expr(expr)(row, ctx.signalParams)) } catch { return false } }
        chartMetaData.__filterPassed.set(name, inputRows.map((r) => fn(r)))
      }
      if (isBinData && !aggUpdated) {
        const field = (single as { field?: string }).field ?? ''
        const vals = inputRows.map((r) => Number((r as Record<string, unknown>)[field]))
        const finite = vals.filter((v) => Number.isFinite(v))
        const lo = finite.length ? Math.min(...finite) : 0
        const hi = finite.length ? Math.max(...finite) : 1
        const span = hi - lo
        const explicitStep = (single as { step?: number }).step
        const step = typeof explicitStep === 'number' && explicitStep > 0 ? explicitStep : computeBinStep(span, (single as { maxbins?: number }).maxbins)
        const eps = computeBinEps(step)
        const start = lo < Math.floor(lo / step + eps) * step ? Math.floor(lo / step + eps) * step - step : Math.floor(lo / step + eps) * step
        const stop = Math.ceil(hi / step) * step
        if (!chartMetaData.__binState) chartMetaData.__binState = new Map()
        chartMetaData.__binState.set(name, { lo, hi, start, stop, step, out: rows, oldVals: vals })
      }
      if (single?.type === 'fold' && !aggUpdated) {
        if (!chartMetaData.__foldState) chartMetaData.__foldState = new Map()
        chartMetaData.__foldState.set(name, { n: ((single as { fields?: unknown[] }).fields ?? []).length, out: rows })
      }
      if (single?.type === 'flatten' && !aggUpdated) {
        const fields = (single as { fields?: string[] }).fields ?? []
        const offsets: number[] = []
        const sizes: number[] = []
        let pos = 0
        for (const r of inputRows) {
          let maxlen = 0
          for (const f of fields) {
            const a = (r as Record<string, unknown>)[f]
            const len = Array.isArray(a) ? a.length : (a as { length?: number })?.length
            maxlen = len == null ? NaN : Math.max(maxlen, len)
          }
          const size = Number.isFinite(maxlen) && maxlen > 0 ? maxlen : 0
          offsets.push(pos)
          sizes.push(size)
          pos += size
        }
        if (!chartMetaData.__flattenState) chartMetaData.__flattenState = new Map()
        chartMetaData.__flattenState.set(name, { offsets, sizes, out: rows })
      }
    }
    ctx.datasets.set(name, rows)
    if (!d.transform.length) {
      outputChanges = ctx.dataChanges?.get(name) ?? null
      outPulse = inPulse
    }
    ctx.datasetChanges?.set(name, outputChanges)
    ctx.datasetPulses.set(name, outPulse)
    // Cache the derived output for the next per-datum update.
    const chartMeta = ctx.chart as unknown as { __prevDatasetOutputs?: Map<string, Row[]> }
    if (!chartMeta.__prevDatasetOutputs) chartMeta.__prevDatasetOutputs = new Map()
    chartMeta.__prevDatasetOutputs.set(name, rows)
    return rows
  }

  for (const d of ctx.chart.data) {
    build(d.name, new Set())
  }
}

/** Snapshot resolved scales into plain data for the scene differential (R8.1/R8.2). */
function snapshotScales(scales: Map<string, Scale>): Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; samples?: [unknown, unknown] }> {
  const out: Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; samples?: [unknown, unknown] }> = []
  for (const [name, scale] of scales) {
    const s = scale as unknown as {
      type?: string
      domain?: () => unknown[]
      range?: () => unknown[]
      bandwidth?: () => number
    }
    if (typeof s.domain !== 'function' || typeof s.range !== 'function') continue
    const domain = s.domain()
    const range = s.range()
    const bandwidth = typeof s.bandwidth === 'function' ? s.bandwidth() : undefined
    let samples: [unknown, unknown] | undefined
    const type = s.type ?? 'unknown'
    let labelValues: unknown[] | undefined
    if (type === 'quantile') {
      const q = (scale as unknown as { quantiles?: () => unknown[] }).quantiles
      if (typeof q === 'function') labelValues = q.call(scale)
    } else if (type === 'quantize' || type === 'threshold') {
      const t = (scale as unknown as { thresholds?: () => unknown[] }).thresholds
      if (typeof t === 'function') labelValues = t.call(scale)
    } else if (Array.isArray((scale as unknown as { bins?: unknown[] }).bins)) {
      labelValues = (scale as unknown as { bins: unknown[] }).bins
    }
    // Interpolating colour scales report a normalized [0,1] range; sample the
    // endpoints so the snapshot remains comparable with vega's [colour, colour].
    if (domain.length >= 2 && typeof scale === 'function') {
      try {
        const a = (scale as unknown as (v: unknown) => unknown)(domain[0])
        const b = (scale as unknown as (v: unknown) => unknown)(domain[domain.length - 1])
        if (typeof a === 'string' && /^rgb/i.test(a) && typeof b === 'string' && /^rgb/i.test(b)) samples = [a, b]
      } catch { /* non-interpolating */ }
    }
    out.push({
      name, type, domain: Array.from(domain), range: Array.from(range),
      ...(bandwidth != null ? { bandwidth } : {}), ...(samples ? { samples } : {}),
      ...(labelValues ? { labelValues } : {}),
    })
  }
  return out
}

function buildScales(ctx: EvalContext): void {
  const scaleSignals = ctx.signalParams
  const chartMeta = ctx.chart as unknown as { __cachedScales?: Map<string, { scale: Scale; multi: boolean }>; __scaleDomain?: Map<string, { data: string; field: string; lo: number; hi: number; oldVals: number[]; loCount: number; hiCount: number; finite: boolean }>; __scaleDomainDisc?: Map<string, { oldVals: unknown[]; counts: Map<unknown, number>; firstIdx: Map<unknown, number> }>; __paramFp?: string }
  const cached = chartMeta.__cachedScales ?? (chartMeta.__cachedScales = new Map())
  const domainCache = chartMeta.__scaleDomain ?? (chartMeta.__scaleDomain = new Map())
  const discreteCache = chartMeta.__scaleDomainDisc ?? (chartMeta.__scaleDomainDisc = new Map())
  // A scale whose domain references none of the affected datasets (closed over
  // source chains) and whose size/signal params are unchanged is identical to
  // the previous eval's scale — reuse it and skip the O(n) domain re-scan.
  const paramsUnchanged = paramFpOf(ctx.signalParams) === chartMeta.__paramFp
  for (const s of ctx.chart.scales) {
    // Vega-lite emits `{ fields: [{data, field}, ...] }` domains for layered
    // charts (several datasets contribute to one shared scale). scales.ts only
    // understands single-dataset domains, so resolve the multi-dataset form
    // here into a concrete domain before building the scale.
    const multiDomain = resolveMultiDatasetDomain(s.domain, ctx)
    const prev = cached.get(s.name)
    if (multiDomain) {
      // A multi-dataset domain resolves to a concrete array in-place (the IR is
      // mutated), so it can never be safely reused — always re-resolve/rebuild.
      if (prev?.multi) { ctx.scales.set(s.name, prev.scale); ctx.scaleTypes.set(s.name, s.type); continue }
      ;(s as unknown as { domain: unknown }).domain = concreteDomain(s, multiDomain)
    }
    if (ctx.incremental && !multiDomain && !prev?.multi && paramsUnchanged && prev) {
      let reuse = !domainReferencesAffected(s.domain, ctx.affected)
      // An affected single-data-domain scale can still be reused when its domain
      // is provably unchanged: no changed row extends [lo,hi] and no changed row's
      // old value sat at a boundary (which could move the min/max). This skips the
      // O(n) domain re-scan for the common case (few points change, domain holds).
      const CONTINUOUS = CONTINUOUS_TYPES
      const DISCRETE = DISCRETE_TYPES
      const dom = (typeof s.domain === 'object' && !Array.isArray(s.domain) && typeof (s.domain as { data?: unknown }).data === 'string')
        ? (s.domain as { data: string; field: string })
        : null
      // Domain-stability reuse is only sound for continuous scales over numeric
      // values: a discrete (band/ordinal) domain is a *set* of values, so a changed
      // row introducing a new category changes the domain even though no min/max
      // moved. Restrict reuse to continuous scales with finite domain values.
      if (!reuse && dom && CONTINUOUS.has(s.type)) {
        const prevDom = domainCache.get(s.name)
        const changes = ctx.dataChanges?.get(dom.data)
        const rows = ctx.datasets.get(dom.data) ?? []
        if (prevDom && prevDom.finite && changes && changes.size && prevDom.oldVals.length === rows.length) {
          let stable = true
          let loCount = prevDom.loCount
          let hiCount = prevDom.hiCount
          for (const i of changes) {
            if (i < 0 || i >= rows.length) { stable = false; break }
            const newV = Number((rows[i] as Row)[dom.field])
            const oldV = prevDom.oldVals[i]!
            if (newV < prevDom.lo || newV > prevDom.hi) { stable = false; break }
            // A changed row at the boundary only moves the domain if it was the
            // last row holding that boundary (another row may still keep it).
            if (oldV === prevDom.lo && --loCount <= 0) { stable = false; break }
            if (oldV === prevDom.hi && --hiCount <= 0) { stable = false; break }
          }
          reuse = stable
        }
        // Length-changing pulse: update the min/max census by the added/removed/
        // modified rows only. An append inside the current domain (the common
        // streaming case) therefore keeps the scale object — and every encoded
        // item — without an O(n) domain re-scan.
        const pulse = ctx.inputPulses?.get(dom.data) ?? ctx.datasetPulses.get(dom.data)
        if (!reuse && prevDom && prevDom.finite && pulse && isLengthPulse(pulse)) {
          const oldVals = prevDom.oldVals
          let lo = prevDom.lo, hi = prevDom.hi
          let loCount = prevDom.loCount, hiCount = prevDom.hiCount
          let stable = true
          const adjust = (oldV: number | undefined, newV: number): void => {
            if (oldV != null) {
              if (oldV === lo) loCount--
              if (oldV === hi) hiCount--
            }
            if (!Number.isFinite(newV)) return
            if (newV < lo || newV > hi) { stable = false; return }
            if (newV === lo) loCount++
            if (newV === hi) hiCount++
          }
          const changedVals: Array<[number, number]> = []
          const addedVals: number[] = []
          if (pulse.appendOnly) {
            const base = pulse.baseLength ?? oldVals.length
            if (base === oldVals.length && rows.length >= base) {
              for (const i of pulse.changed) {
                if (i < 0 || i >= base) continue
                const v = Number((rows[i] as Row)[dom.field])
                adjust(oldVals[i]!, v)
                changedVals.push([i, v])
              }
              for (let i = base; i < rows.length; i++) {
                const v = Number((rows[i] as Row)[dom.field])
                adjust(undefined, v)
                addedVals.push(v)
              }
            } else stable = false
          } else if (pulse.from && pulse.from.length === rows.length) {
            const from = pulse.from
            const modified = new Set(pulse.changed)
            const newVals = new Array<number>(rows.length)
            const retained = new Set<number>()
            for (let i = 0; i < from.length; i++) if (from[i]! >= 0) retained.add(from[i]!)
            for (let old = 0; old < oldVals.length; old++) {
              if (retained.has(old)) continue
              adjust(oldVals[old]!, NaN)
            }
            for (let i = 0; i < rows.length; i++) {
              const old = from[i]!
              const dirty = old < 0 || modified.has(i)
              const v = dirty ? Number((rows[i] as Row)[dom.field]) : oldVals[old]!
              newVals[i] = v
              if (dirty) adjust(old >= 0 ? oldVals[old]! : undefined, v)
            }
            if (stable) {
              domainCache.set(s.name, {
                ...prevDom, lo, hi, loCount, hiCount, oldVals: newVals,
              })
              reuse = true
            }
          } else stable = false
          if (stable && pulse.appendOnly) {
            for (const [i, v] of changedVals) oldVals[i] = v
            for (const v of addedVals) oldVals.push(v)
            domainCache.set(s.name, {
              ...prevDom, lo, hi, loCount, hiCount, oldVals,
            })
            reuse = true
          }
        }
      }
      // Discrete (band/point/ordinal) domains: the domain is the *ordered set*
      // of distinct values, so stability needs a value census, not min/max.
      // Track each value's multiplicity and first-occurrence index: the ordered
      // domain is unchanged iff every changed row swaps its old value for one
      // that already exists with an earlier first occurrence, while the old
      // value keeps a positive count and its own first occurrence. Any ambiguity
      // (a value appearing/vanishing, or a first occurrence moving) rebuilds.
      if (!reuse && dom && DISCRETE_TYPES.has(s.type)) {
        const disc = discreteCache.get(s.name)
        const changes = ctx.dataChanges?.get(dom.data)
        const rows = ctx.datasets.get(dom.data) ?? []
        if (disc && disc.oldVals.length === rows.length && changes && changes.size) {
          let stable = true
          for (const i of changes) {
            if (i < 0 || i >= rows.length) { stable = false; break }
            const nv = (rows[i] as Row)[dom.field]
            const ov = disc.oldVals[i]!
            if (ov === nv) continue
            const nCount = disc.counts.get(nv)
            const nFirst = disc.firstIdx.get(nv)
            if (nCount == null || nCount <= 0 || nFirst == null || nFirst > i) { stable = false; break }
            const oCount = disc.counts.get(ov)
            if (oCount == null || oCount <= 1) { stable = false; break }
            if (disc.firstIdx.get(ov) === i) { stable = false; break }
            disc.counts.set(ov, oCount - 1)
            disc.counts.set(nv, nCount + 1)
            disc.oldVals[i] = nv
          }
          if (stable) reuse = true
        }
      }
      if (reuse) {
        ctx.scales.set(s.name, prev.scale)
        ctx.scaleTypes.set(s.name, s.type)
        continue
      }
    }
    const scale = buildScale(s, {
      width: ctx.width,
      height: ctx.height,
      signals: scaleSignals,
      configRange: ctx.chart.configRange,
      domainRaw: ctx.domainRaw?.get(s.name),
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
    cached.set(s.name, { scale, multi: multiDomain != null })
    // Track the domain extent for a single-data-domain scale so it can be reused
    // on a later per-datum update when the domain is provably unchanged.
    if (typeof s.domain === 'object' && !Array.isArray(s.domain) && typeof (s.domain as { data?: unknown }).data === 'string') {
      const dom = s.domain as { data: string; field: string }
      const rows = ctx.datasets.get(dom.data) ?? []
      if (DISCRETE_TYPES.has(s.type)) {
        // Census for discrete-domain stability: value multiplicity + first-occurrence
        // index (see the reuse check above).
        const counts = new Map<unknown, number>()
        const firstIdx = new Map<unknown, number>()
        const vals: unknown[] = []
        for (let i = 0; i < rows.length; i++) {
          const v = getField(rows[i]!, dom.field)
          vals.push(v)
          counts.set(v, (counts.get(v) ?? 0) + 1)
          if (!firstIdx.has(v)) firstIdx.set(v, i)
        }
        discreteCache.set(s.name, { oldVals: vals, counts, firstIdx })
      } else {
        const vals = rows.map((r) => Number((r as Row)[dom.field]))
        const finite = vals.filter((v) => Number.isFinite(v))
        const lo = finite.length ? Math.min(...finite) : 0
        const hi = finite.length ? Math.max(...finite) : 1
        domainCache.set(s.name, {
          data: dom.data,
          field: dom.field,
          lo,
          hi,
          oldVals: vals,
          loCount: finite.length ? vals.filter((v) => v === lo).length : 0,
          hiCount: finite.length ? vals.filter((v) => v === hi).length : 0,
          finite: finite.length > 0,
        })
      }
    }
  }
  // Snapshot the final scale objects for this eval. The differential item-reuse
  // check (canReuseItems) compares the next eval's scales against the PREVIOUS
  // eval's: when a scale object is provably the same, unchanged rows re-encode
  // identically even if the scale's domain references an affected dataset.
  const meta = chartMeta as unknown as { __lastScales?: Map<string, Scale>; __prevScales?: Map<string, Scale> }
  meta.__prevScales = meta.__lastScales
  meta.__lastScales = new Map(ctx.scales)
}

/** True when a scale domain references an affected dataset (data or multi-field). */
function domainReferencesAffected(domain: ScaleDomain, affected: Set<string>): boolean {
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    const d = (domain as { data?: unknown }).data
    if (typeof d === 'string' && affected.has(d)) return true
    const fields = (domain as { fields?: Array<{ data?: string }> }).fields
    if (Array.isArray(fields)) {
      for (const f of fields) if (f && typeof f.data === 'string' && affected.has(f.data)) return true
    }
  }
  return false
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
    const finite = values
      .map((v) => v instanceof Date ? v.getTime() : v)
      .filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
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
function reusablePulse(
  mark: CompiledMark,
  ctx: EvalContext,
  source: string,
  rowCount: number,
  prevGroup: SceneGroup | null | undefined,
  rectSorts: boolean,
): StepPulse | null {
  if (!prevGroup) return null
  // Pulse propagation: the *output* rows that changed for this source. A
  // length-changing pulse additionally carries the old->new mapping. `null` means
  // the dataset was fully re-derived without a trustworthy mapping.
  const pulse = ctx.datasetPulses.get(source)
    ?? (ctx.datasetChanges?.get(source) ? { changed: [...ctx.datasetChanges.get(source)!] } : null)
  if (!pulse || pulse.full) return null
  const prevItems = prevGroup.items as SceneItem[]
  if (pulse.appendOnly) {
    const base = pulse.baseLength ?? prevItems.length
    if (base !== prevItems.length || rowCount < base) return null
  } else if (pulse.from) {
    // Length-changing: retained rows can still be reused at their new index.
    if (pulse.from.length !== rowCount) return null
  } else if (rowCount !== prevItems.length) {
    return null
  }
  if (mark.sort || mark.transform?.length || rectSorts) return null
  // A change to width/height or any signal shifts scale ranges and every
  // formula, so the previously-encoded items would be stale. Only reuse when the
  // expression params are identical to the previous eval.
  if (paramFpOf(ctx.signalParams) !== (ctx.chart as unknown as { __prevParamFp?: string }).__prevParamFp) return null
  // Bail if the mark uses a scale whose encoding behavior may have changed:
  // either the scale object differs from the PREVIOUS eval's (its domain was
  // re-derived), or — for multi-dataset domains, which are always re-resolved —
  // the domain references an affected dataset.
  const prevScales = (ctx.chart as unknown as { __prevScales?: Map<string, Scale> }).__prevScales
  for (const name of collectMarkScales(mark)) {
    const compiled = ctx.chart.scales.find((s) => s.name === name)
    if (!compiled) continue
    const cur = ctx.scales.get(name)
    if (cur != null && cur === prevScales?.get(name)) continue
    if (domainReferencesAffected(compiled.domain, ctx.affected)) return null
  }
  return pulse
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
      if (mark.sort) {
        // Vega mark sorts address scene-item properties: line/area sorting by
        // the dimension channel name ("x"/"y") orders rows by their encoded
        // position, not by a datum field of that name.
        const sf = (mark.sort as { field?: unknown }).field
        const posChannel = (mark.type === 'line' || mark.type === 'area')
          && typeof sf === 'string' && (sf === 'x' || sf === 'y') ? sf : null
        const enc = posChannel ? mark.encode?.update?.[posChannel] : undefined
        if (posChannel && enc) {
          const vals = rows.map((r) => resolveEncodeProperty(enc, r, ctx))
          const desc = (mark.sort as { order?: unknown }).order === 'descending'
          const idx = rows.map((_, i) => i)
          idx.sort((a, b) => {
            const av = vals[a], bv = vals[b]
            const c = typeof av === 'number' && typeof bv === 'number'
              ? (av < bv ? -1 : av > bv ? 1 : 0)
              : 0
            return desc ? -c : c
          })
          rows = idx.map((i) => rows[i]!)
        } else {
          rows = sortRows(rows, mark.sort)
        }
      }
      if (mark.transform?.length) {
        rows = applyTransforms(rows, mark.transform, {
          runtime: ctx.runtime,
          signals: ctx.signalParams,
          hierarchies: ctx.hierarchies,
          projections: ctx.projections,
        }, source)
      }
    }

    // Keep dataset order for rect items: vega's scene keeps data order and its
    // SVG renderer paints the array in reverse, which already puts the first
    // datum on top. Reordering the scene here would make the scene-level
    // differential (R8.3) report a paint order the renderer then reverses twice.
    const rectSorts = false
    const rectPermInv: number[] | null = null
    const encodeRows = rows

    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    ctx.encodeBinding = encodeBindingFor(update, ctx)
    // Per-datum differential update: when the source dataset published a
    // changeset and reuse is provably safe (no reordering, unchanged length, no
    // scale whose encoding may have changed), keep the previous item objects for
    // unchanged indices so the DOM patcher skips them and the re-encode of those
    // items is skipped entirely (including the row clone). `rows` is in dataset
    // order (changeset indices refer to it); rect marks map the dataset index to
    // its paint position via the sort permutation.
    const pulse = reusablePulse(mark, ctx, source, encodeRows.length, prevGroup, rectSorts)
    if (pulse) {
      const prevItems = prevGroup!.items as SceneItem[]
      const gen = (ctx.chart as unknown as { __gen?: number }).__gen ?? 0
      const encodeAt = (i: number): SceneItem => {
        const row = { ...(rows[i] as Row) }
        const res = resolveEncodeSet(update, row, ctx, mark.type)
        res.datum = row
        res.__gen = gen
        return res
      }
      if (pulse.appendOnly) {
        const base = pulse.baseLength ?? prevItems.length
        const cachedBounds = GROUP_BOUNDS.get(prevGroup!)
        if (pulse.changed.length) GROUP_BOUNDS.delete(prevGroup!)
        for (const i of pulse.changed) {
          if (i < 0 || i >= base) continue
          prevItems[i] = encodeAt(i)
        }
        for (let i = base; i < encodeRows.length; i++) {
          const item = encodeAt(i)
          prevItems.push(item)
          if (cachedBounds && !pulse.changed.length) cachedBounds.union(boundLeaf(new Bounds(), item))
        }
        items = prevItems
      } else if (pulse.from) {
        const modified = new Set(pulse.changed)
        const next = new Array<SceneItem>(encodeRows.length)
        for (let i = 0; i < encodeRows.length; i++) {
          const old = pulse.from[i]!
          if (old >= 0 && !modified.has(i) && prevItems[old] !== undefined) next[i] = prevItems[old]!
          else next[i] = encodeAt(i)
        }
        items = next
      } else {
        // Reuse the previous group's item ARRAY in place and replace only the
        // changed indices — an O(changed) splice instead of an O(n) rebuild, the
        // persistent-scene behavior that vega's pulse graph gives us. Reused items
        // keep their previous generation; changed items get the current one.
        for (const i of pulse.changed) {
          if (i < 0 || i >= prevItems.length) continue
          const pos = rectPermInv ? rectPermInv[i]! : i
          if (pos < 0 || pos >= prevItems.length) continue
          const row = { ...(rows[i] as Row) }
          const res = resolveEncodeSet(update, row, ctx, mark.type)
          res.datum = row
          res.__gen = gen
          prevItems[pos] = res
        }
        GROUP_BOUNDS.delete(prevGroup!)
        items = prevItems
      }
    } else {
      const gen = (ctx.chart as unknown as { __gen?: number }).__gen ?? 0
      items = encodeRows.map((row) => {
        const copy = rowsCloned ? row : { ...row }
        const res = resolveEncodeSet(update, copy, ctx, mark.type)
        res.datum = copy
        res.__gen = gen
        return res
      })
    }
  } else {
    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    const res = resolveEncodeSet(update, {}, ctx, mark.type)
    res.__gen = (ctx.chart as unknown as { __gen?: number }).__gen ?? 0
    items = [res]
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

  // vega's built-in 'trail' style (vega-parser defaults): size defaults to
  // the default stroke width (2) — the trail generator halves it per point.
  if (Array.isArray((mark as any).style) ? (mark as any).style.includes('trail') : (mark as any).style === 'trail') {
    for (const it of items) { if ((it as Record<string, unknown>).size == null) (it as Record<string, unknown>).size = 2 }
  }

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
      if (path !== undefined) it.path = path
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

  // The differential path reuses the previous group's item array in place, so
  // the mark is genuinely persistent: return the same group object (identity
  // preserved for the DOM patcher / scene consumers) rather than allocate a new
  // container each eval. A fresh group (items array rebuilt) is still returned
  // as new.
  if (prevGroup && items === prevGroup.items) {
    prevGroup.items = items
    return prevGroup
  }
  return {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    clip: mark.clip === true,
    items,
    __source: mark.from?.data,
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

/**
 * A vega-native trellis: a group mark with a `layout` def whose children are
 * facet cells. Each cell is its own scope (own scales/axes/marks, facet rows
 * as the facet's dataset, the group key as the `parent` datum), and the cells
 * run through the grid layout (trellisLayout) with the layout def. Mirrors
 * vega's ViewLayout: `if (_.layout) trellisLayout(view, group, _.layout)`.
 */
function buildTrellisGroup(
  mark: CompiledMark & { layout: Record<string, unknown> },
  ctx: EvalContext,
): SceneGroup | SceneGroup[] | null {
  const layoutDef = mark.layout
  const children = ((mark as { marks?: unknown[] }).marks ?? []) as CompiledMark[]
  const cells: SceneGroup[] = []
  for (const child of children) {
    const facet = (child as { from?: { facet?: { name: string; data: string; groupby: string[] } } }).from?.facet
    if (facet?.groupby?.length) {
      const rows = ctx.datasets.get(facet.data) ?? []
      const grouped = inlineGroupRows(rows, facet.groupby)
      for (const g of grouped) {
        if (!g.length) continue
        const cell = buildTrellisCell(child, facet, g, ctx)
        if (cell) cells.push(cell)
      }
    } else {
      const r = evaluateMark(child, ctx)
      if (r) {
        if (Array.isArray(r)) cells.push(...r)
        else cells.push(r)
      }
    }
  }
  // The trellis container's own scope: vega renders a zero-size background
  // (the cells' geometry is the grid's, not the container's).
  const outer: SceneGroup = {
    marktype: 'group',
    name: mark.name,
    role: (mark.role as string) ?? 'scope',
    items: cells as SceneItem[],
    width: ctx.width,
    height: ctx.height,
    x: 0,
    y: 0,
  }
  const bg: SceneItem = { path: 'M0,0h0v0h0Z', x: 0, y: 0 }
  outer.items = [bg, ...(cells as SceneItem[])]
  try {
    trellisLayout(outer, layoutDef as Record<string, unknown>)
  } catch {
    // vega's dataflow logs the layout error and renders the scene unlayouted:
    // cells keep their encoded (0,0) anchors and the view skips overflow growth.
    ;(ctx as unknown as { __layoutError?: boolean }).__layoutError = true
  }
  // The container's layout bounds: vega's frame bound = the union of the cell
  // groups' own layout bounds (each cell measured like its layout pass does).
  // boundLeaf would re-measure the baked axis deltas (+0.5 per cell) and grow
  // the view padding by a pixel.
  const gb = new Bounds()
  for (const c of cells) gb.union(measureBounds(c))
  ;(outer as unknown as Record<string, unknown>)._layoutBounds = gb
  return outer
}

/** One trellis facet cell: a scoped group with the cell's own scales, axes,
 * marks and title, sized by its encode against the facet key datum. */
function buildTrellisCell(
  mark: CompiledMark,
  facet: { name: string; data: string; groupby: string[] },
  rows: Row[],
  ctx: EvalContext,
): SceneGroup | null {
  // The facet key datum: the groupby values (vega's facet group datum carries
  // exactly the grouping keys, which is why cells read `w`/`h` off it).
  const datum: Row = {}
  for (const k of facet.groupby) datum[k] = rows[0]?.[k]

  // The cell's own geometry resolves against the facet datum. Note the child
  // scope's width/height SIGNALS stay the outer chart's (vega does not bind
  // the encoded item size into the child scope signals), matching
  // buildScopedGroup's documented quirk.
  const enc = (mark.encode?.enter ?? {}) as Record<string, EncodeValue>
  const encU = (mark.encode?.update ?? {}) as Record<string, EncodeValue>
  const geo = resolveEncodeSet({ ...enc, ...encU }, datum, ctx, 'group')
  const gw = typeof geo.width === 'number' ? geo.width : ctx.width
  const gh = typeof geo.height === 'number' ? geo.height : ctx.height

  const childScaleMap = new Map<string, Scale>()
  const childTypeMap = new Map<string, string>()
  for (const s of (mark as { scales?: CompiledScale[] }).scales ?? []) {
    const scale = buildScale(s, {
      width: ctx.width,
      height: ctx.height,
      signals: ctx.signalParams,
      configRange: ctx.chart.configRange,
      domainRaw: ctx.domainRaw?.get(s.name),
      evaluate: (expr) => ctx.runtime.expr(expr)({}, ctx.signalParams),
      dataField: (dn, field) => {
        const rws = ctx.datasets.get(dn) ?? []
        const out: unknown[] = []
        for (const r of rws) out.push(getField(r, field))
        return out
      },
      dataRows: (dn) => (ctx.datasets.get(dn) ?? []) as Record<string, unknown>[],
    })
    childScaleMap.set(s.name, scale)
    childTypeMap.set(s.name, s.type)
  }

  const childCtx: EvalContext = {
    ...ctx,
    width: gw,
    height: gh,
    // Child scales shadow same-named parent scales; everything else inherits
    // (the cell's rect fill names the top-level `colour` scale).
    scales: new Map([...ctx.scales, ...childScaleMap]),
    scaleTypes: new Map([...ctx.scaleTypes, ...childTypeMap]),
    // vega's facet scope defines a `parent` signal per cell: the facet key
    // datum (compileExpr exposes params to expressions $-prefixed).
    signalParams: { ...ctx.signalParams, parent: datum },
  }
  const saved = ctx.datasets.get(facet.name)
  ctx.datasets.set(facet.name, rows)

  const items: SceneItem[] = []
  // Cell background: the encoded size, no fill, no inset (vega group
  // background defaults to transparent and the facet cell encodes both dims).
  items.push({ path: `M0,0h${gw}v${gh}h-${gw}Z`, x: 0, y: 0 } as SceneItem)

  for (const as of (mark as { axes?: unknown[] }).axes ?? []) {
    if (isAxisSpec(as)) {
      const a = buildAxisInline(as as Record<string, unknown>, childCtx)
      if (a) items.push(a)
    }
  }
  for (const cm of (mark as { marks?: unknown[] }).marks ?? []) {
    const r = evaluateMark(cm as CompiledMark, childCtx)
    if (r) {
      if (Array.isArray(r)) { for (const g of r) items.push(g) }
      else items.push(r)
    }
  }

  // The cell title (vega layoutGroup → titleLayout within the group): centered
  // over the cell's measured bounds, sitting titlePadding + one text height
  // above the cell's top edge (text bound height = the fontSize).
  const titleSpec = (mark as { title?: { text?: unknown; signal?: string; fontSize?: number; fontWeight?: unknown; color?: string } }).title
  if (titleSpec) {
    const fs = titleSpec.fontSize ?? 11
    let text = ''
    const raw = titleSpec.text
    if (raw != null) {
      if (typeof raw === 'object' && 'signal' in raw) {
        try {
          text = String(ctx.runtime.expr((raw as { signal: string }).signal)({}, { ...ctx.signalParams, parent: datum }))
        } catch { text = '' }
      } else {
        text = String(raw)
      }
    }
    const b = measureBounds({ marktype: 'group', items, x: 0, y: 0, width: gw, height: gh } as SceneGroup)
    const pos = b.empty() ? 0 : (b.x1 + b.x2) / 2
    const titleOffset = 4
    const titleGroup: SceneGroup = {
      marktype: 'group',
      role: 'title',
      x: pos,
      y: -(fs + titleOffset),
      items: [{
        marktype: 'text',
        role: 'title-text',
        items: [{
          x: 0, y: 0, text,
          align: 'center', baseline: 'top',
          fontSize: fs,
          fontWeight: (titleSpec.fontWeight ?? 'bold') as SceneItem['fontWeight'],
          fill: titleSpec.color ?? '#000',
        } as SceneItem],
      } as unknown as SceneItem],
    }
    items.push(titleGroup as unknown as SceneItem)
  }

  if (saved !== undefined) ctx.datasets.set(facet.name, saved)
  else ctx.datasets.delete(facet.name)

  return {
    marktype: 'group',
    name: mark.name,
    role: (mark.role as string) ?? 'scope',
    items,
    width: gw,
    height: gh,
    x: 0,
    y: 0,
    __scales: snapshotScales(childCtx.scales),
  } as SceneGroup
}

/** Group mark dispatch */
function buildGroupMark(mark: CompiledMark, ctx: EvalContext): SceneGroup | SceneGroup[] | null {
  // A vega-native trellis: a group mark carrying a `layout` def lays its facet
  // children out through the grid layout (vega ViewLayout: `if (_.layout)
  // trellisLayout(view, group, _.layout)`).
  if ((mark as { layout?: unknown }).layout) {
    return buildTrellisGroup(mark as CompiledMark & { layout: Record<string, unknown> }, ctx)
  }
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
    if (mark.role === 'row-title') return buildRowTitleGroup(mark, ctx)
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
      configRange: ctx.chart.configRange,
      domainRaw: ctx.domainRaw?.get(s.name),
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
    // Local scales shadow same-named parent scales; other names resolve through
    // the parent scope (Vega scopes are chained). Nested marks in raw Vega
    // specs routinely reference outer scales (`y`, a shared colour scale).
    scales: new Map([...ctx.scales, ...childScaleMap]),
    scaleTypes: new Map([...ctx.scaleTypes, ...childTypeMap]),
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
    __scales: snapshotScales(child.scales),
  } as SceneGroup
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
  if (process.env.ASTER_DEBUG_FACET) console.error('[facet]', { cellWidth, cellHeight, ncols, nrows, layout })
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
  // The facet cell mark's sort order drives the grid order (vega sorts the
  // facet groups before the layout transform).
  const facetSort = (mark as { sort?: { field?: unknown; order?: unknown } }).sort
  if (facetSort?.field) {
    const fields = (Array.isArray(facetSort.field) ? facetSort.field : [facetSort.field]) as string[]
    const orders = (Array.isArray(facetSort.order) ? facetSort.order : [facetSort.order ?? 'ascending']) as string[]
    const exprs = fields.map((f) => ctx.runtime.expr(String(f)))
    grouped = grouped.slice().sort((a, b) => {
      for (let i = 0; i < exprs.length; i++) {
        const av = exprs[i]!(a[0] ?? {}, ctx.signalParams) as unknown
        const bv = exprs[i]!(b[0] ?? {}, ctx.signalParams) as unknown
        let cmp = 0
        if (av !== bv) cmp = av == null ? 1 : bv == null ? -1 : (av < bv ? -1 : av > bv ? 1 : 0)
        if (cmp !== 0) return orders[i] === 'descending' ? -cmp : cmp
      }
      return 0
    })
  } else if (facet.groupby.length > 1) {
    // A 2D facet lays cells out row-major; order groups by their facet keys so
    // the grid mapping is stable regardless of the data's insertion order.
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
    // Column-header labels with a non-top labelOrient are title items on the
    // cell's left/right side (vega-lite places them in the cell, not in a
    // header band). Bottom-oriented labels live in the column footer below.
    for (const hm of (ctx.chart.marks ?? []) as CompiledMark[]) {
      if (hm.role !== 'column-header') continue
      const ht = hm.title as Record<string, unknown> | undefined
      const lo = ht?.labelOrient as string | undefined
      if (lo !== 'left' && lo !== 'right') continue
      // When header.orient already puts the whole band on the right, the
      // column title owns the outer edge and no sub-pixel nudge is needed.
      const bandRight = ((ctx.chart.marks ?? []) as CompiledMark[]).some(
        (m) => (m.title as Record<string, unknown> | undefined)?.orient === 'right',
      )
      const fk = facet.groupby[facet.groupby.length - 1]!
      const text = facetHeaderLabel(hm, g[0] ?? {}, fk, ctx)
      cellItems.push({
        text,
        // the right-side title's rotated bound lands a hair inside the
        // integer where vega's lands on it; nudge only that edge.
        x: lo === 'left' ? -20 : cellWidth + 20 + (bandRight ? 0 : 1e-7),
        y: cellHeight / 2,
        angle: lo === 'left' ? -90 : 90,
        baseline: 'top',
        align: 'center',
        fill: (ht?.color as string) ?? '#000',
        fontSize: (ht?.fontSize as number | undefined) ?? 10,
        ...(ht?.fontWeight != null ? { fontWeight: ht.fontWeight as SceneItem['fontWeight'] } : {}),
        ...(ht?.limit != null ? { limit: ht.limit as number } : {}),
      })
    }
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

/** The label a facet header/title renders: the group's title signal
 * evaluated with the facet row as `parent` (vega's parent scope); a plain
 * string title is used verbatim, otherwise the facet value. */
function facetHeaderLabel(mark: CompiledMark, row: Row, fkey: string, ctx: EvalContext): string {
  const titleDef = (mark as unknown as { title?: { text?: unknown } }).title
  const t = titleDef?.text
  if (typeof t === 'string') return t
  if (t && typeof t === 'object' && 'signal' in (t as Record<string, unknown>)) {
    try {
      const sig = String((t as Record<string, unknown>).signal).replace(/\bparent\b/g, 'datum')
      // An aggregated facet field that produced no value is a NaN tuple in
      // vega, not an absent property: `'' + NaN` labels it "NaN".
      const rowForTitle = new Proxy(row, {
        get(target, prop) {
          if (typeof prop === 'string' && (!(prop in target) || (target as Record<string, unknown>)[prop] === undefined)
            && /^(count|distinct|valid|missing)_/.test(prop)) return NaN
          return (target as Record<PropertyKey, unknown>)[prop]
        },
      })
      return String(ctx.runtime.expr(sig)(rowForTitle, ctx.signalParams))
    } catch { /* fall through to the raw value */ }
  }
  return String((row as Record<string, unknown>)[fkey])
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
      const desc = mark.sort.order === 'descending'
      sortedRows = rows.slice().sort((a, b) => {
        const av = expr(a, ctx.signalParams) as unknown
        const bv = expr(b, ctx.signalParams) as unknown
        let cmp = 0
        if (av !== bv) cmp = av == null ? 1 : bv == null ? -1 : (av < bv ? -1 : av > bv ? 1 : 0)
        return desc ? -cmp : cmp
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


    // a header without a title def renders no label (probed: an aggregated
    // row facet's row_header has no title and no label text)
    const labelItems: SceneItem[] = (mark as unknown as { title?: unknown }).title != null
      ? [{
          text: facetHeaderLabel(mark, row, firstGroupby ?? '', ctx), x: -50, y: cellHeight / 2,
          angle: -90, align: 'center' as const, baseline: 'middle' as const, fill: '#000',
        }]
      : []

    result.push({
      marktype: 'group', name: mark.name, role: 'row-header',
      items: [{
        // Vega's row-header group has a zero-width, full-height background
        // path (M0,0h0vHh0Z) — degenerate but non-zero, so it survives
        // canonicalization and contributes a `path|...` record.
        path: `M0,0h0v${cellHeight}h0Z`, x: 0, y: 0,
      } as SceneItem, ...axisItems, ...labelItems],
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
  // The title sits left of the row-header's bound. The trellis path is
  // calibrated at -61 (its header carries the axis labels but the grid
  // layout offsets differ); the single-facet path reads the built header's
  // bound (the axis title's extent) minus the title offset+bound (30).
  let titleX = -61
  if (isTrellis(ctx)) {
    titleX = -61
  } else {
    const headerMark = ctx.chart.marks.find((m) => m.name === 'row_header')
    if (headerMark?.from?.data) {
      const headers = buildRowHeaderGroup(headerMark, ctx)
      const hb = new Bounds()
      for (const h of headers) hb.union(measureGuideGroup(h))
      if (!hb.empty()) titleX = Math.ceil(hb.x1) - 30
    } else {
      titleX = -77
    }
  }
  const tDefR = (tm.title ?? {}) as Record<string, unknown>
  const titleOrient = tDefR.orient as string | undefined
  const rightSide = titleOrient === 'right'
  const titleOffset = (tDefR.offset as number | undefined) ?? FACET_TITLE_OFFSET
  // Vega's title group origin is -(rotated title width + offset); the rotated
  // width carries the same ulp the root margin's ceil reads, and it varies
  // with the text length, so derive it instead of hardcoding 21.
  const probe = { text: titleText, x: 0, y: 0, angle: rightSide ? 90 : -90, align: 'center' as const, baseline: 'top' as const, fontSize: 11 }
  const titleHalfRaw = boundText(new Bounds(), probe as SceneItem).width() + titleOffset
  // vega's title-group size carries one representable ulp beyond the rotated
  // bound; only the longer titles pick it up, and it is exactly what tips the
  // root margin's ceil. Push just those past the margin's epsilon guard.
  const needsMarginBump = Math.abs(titleHalfRaw - Math.round(titleHalfRaw)) > 5e-15
  const titleHalf = needsMarginBump ? titleHalfRaw + 1e-8 : titleHalfRaw
  return {
    marktype: 'group', name: mark.name, role: 'row-title',
    items: [
        { text: titleText, x: rightSide ? titleHalf : -titleHalf, y: 0, angle: rightSide ? 90 : -90, align: 'center' as const, baseline: 'middle' as const, fill: '#000', fontSize: 11, fontWeight: 'bold' },
      ],
    x: titleX, y: centerY,
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
      const desc = Array.isArray(mark.sort.order)
        ? mark.sort.order[0] === 'descending'
        : mark.sort.order === 'descending'
      sortedRows = rows.slice().sort((a, b) => {
        const av = expr(a as unknown as Row, ctx.signalParams) as unknown
        const bv = expr(b as unknown as Row, ctx.signalParams) as unknown
        const cmp = av === bv ? 0 : av == null ? 1 : bv == null ? -1 : (av < bv ? -1 : av > bv ? 1 : 0)
        return desc ? -cmp : cmp
      })
    } catch {}
  }

  const result: SceneGroup[] = []
  const hdrTitleRaw = (mark as unknown as { title?: Record<string, unknown> }).title
  const hdrTitle = hdrTitleRaw ?? {}
  const hdrPad = (hdrTitle.offset as number | undefined) ?? 10
  sortedRows.forEach((row, i) => {
    // the header label evaluates the group's title signal with the facet row
    // as `parent` (vega evaluates the title against the facet datum); a
    // format() on a non-number yields NaN there, mirroring upstream
    const labelVal = facetHeaderLabel(mark, row, fkey, ctx)
    const cellX = i * step
    const labelOrient = hdrTitle.labelOrient as string | undefined
    if (labelOrient != null && labelOrient !== 'top') {
      // Non-default header labels live in the cells/footer (added there), not
      // in a top header band; keep a zero-height header group for the layout.
      result.push({
        marktype: 'group', name: mark.name, role: 'column-header',
        items: [], x: cellX, y: -1, width: cellWidth, height: 0,
      })
      return
    }
    const labelAnchorC = hdrTitle.labelAnchor as string | undefined
    const labelX = labelAnchorC === 'start' ? 0 : labelAnchorC === 'end' ? cellWidth : cellWidth / 2
    const labelAlignC = (hdrTitle.align as string | undefined)
      ?? (labelAnchorC === 'start' ? 'left' : labelAnchorC === 'end' ? 'right' : 'center')
    const labelItem: SceneItem | null = hdrTitleRaw == null ? null : {
      text: labelVal, x: labelX, y: 0, align: labelAlignC as SceneItem['align'],
      ...(hdrTitle.baseline != null ? { baseline: hdrTitle.baseline as SceneItem['baseline'] } : {}),
      ...(hdrTitle.angle != null ? { angle: hdrTitle.angle as number } : {}),
      fill: (hdrTitle.color as string) ?? '#000', fontSize: (hdrTitle.fontSize as number) ?? 10,
      ...(hdrTitle.font != null ? { font: hdrTitle.font as string } : {}),
      ...(hdrTitle.fontWeight != null ? { fontWeight: hdrTitle.fontWeight as SceneItem['fontWeight'] } : {}),
      ...(hdrTitle.limit != null ? { limit: hdrTitle.limit as number } : {}),
    }
    // An explicit label angle/baseline/font size switches the header to
    // vega's title-group sizing: the group reserves the rotated title bounds
    // above and below the title origin. The default guide-label path keeps the
    // compact header scope.
    const useTitleBlock = hdrTitle.angle != null || hdrTitle.baseline != null || hdrTitle.fontSize != null
    const titleBlockH = useTitleBlock && labelItem ? boundText(new Bounds(), labelItem).height() : 0
    if (labelItem) {
      const labelFs = (hdrTitle.fontSize as number | undefined) ?? 10
      // vega nests an explicit-size header label in a title group at
      // -(pad + blockHeight). The renderer bakes the baseline offset for an
      // explicit baseline or angle; only an unrotated, baseline-less
      // explicit-size label needs it folded into the flattened item position.
      labelItem.y = !useTitleBlock
        ? -(hdrPad + 2)
        : hdrTitle.angle != null || hdrTitle.baseline != null
          ? -(hdrPad + titleBlockH)
          : -(hdrPad + titleBlockH) + Math.round(0.79 * labelFs)
    }
    result.push({
      marktype: 'group', name: mark.name, role: 'column-header',
      items: [
        ...(labelItem ? [labelItem] : []),
        // column-header background: zero-height, full-width path (M0,0hWv0h-WZ).
        // A header with labels disabled has no title def at all; vega lays it
        // out but renders no group background for it.
        ...(hdrTitleRaw != null ? [{ path: `M0,0h${cellWidth}v0h-${cellWidth}Z`, x: 0, y: 0 } as SceneItem] : []),
      ],
      x: cellX, y: -1, width: cellWidth, height: titleBlockH > 0 ? hdrPad + 2 * titleBlockH : 0,
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
      const desc = Array.isArray(mark.sort.order)
        ? mark.sort.order[0] === 'descending'
        : mark.sort.order === 'descending'
      sortedRows = rows.slice().sort((a, b) => {
        const av = expr(a as unknown as Row, ctx.signalParams) as unknown
        const bv = expr(b as unknown as Row, ctx.signalParams) as unknown
        const cmp = av === bv ? 0 : av == null ? 1 : bv == null ? -1 : (av < bv ? -1 : av > bv ? 1 : 0)
        return desc ? -cmp : cmp
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
    for (const hm of (ctx.chart.marks ?? []) as CompiledMark[]) {
      if (hm.role !== 'column-header') continue
      const ht = hm.title as Record<string, unknown> | undefined
      if (ht?.labelOrient !== 'bottom') continue
      const fk = facet.groupby[facet.groupby.length - 1]!
      const text = facetHeaderLabel(hm, row, fk, ctx)
      items.push({
        text, x: cellWidth / 2, y: 80, align: 'center',
        fill: (ht.color as string) ?? '#000',
        fontSize: (ht.fontSize as number | undefined) ?? 10,
        ...(ht.fontWeight != null ? { fontWeight: ht.fontWeight as SceneItem['fontWeight'] } : {}),
        ...(ht.limit != null ? { limit: ht.limit as number } : {}),
      })
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
  const tDef = (tm.title ?? {}) as Record<string, unknown>

  const titleAnchorC = (tDef.anchor as string | undefined) ?? 'middle'
  const titleX = titleAnchorC === 'start'
    ? (layout ? layout.gridX1 : 0)
    : titleAnchorC === 'end'
      ? (layout ? layout.gridX2 : centerX * 2)
      : centerX
  // Explicit title angle/baseline/font size switches to vega's title-group
  // law: the title origin sits titleHeight + offset above the facet grid.
  const useTitleBlock = tDef.angle != null || tDef.baseline != null || tDef.fontSize != null
  const titleOffset = (tDef.offset as number | undefined) ?? 10
  const titleItem: SceneItem = {
    text: titleText, x: 0, y: 0, align: (tDef.align as 'center') ?? 'center',
    ...(tDef.baseline != null ? { baseline: tDef.baseline as SceneItem['baseline'] } : {}),
    ...(tDef.angle != null ? { angle: tDef.angle as number } : {}),
    fill: (tDef.color as string) ?? '#000', fontSize: (tDef.fontSize as number) ?? 11,
    fontWeight: (tDef.fontWeight as 'bold') ?? 'bold',
    ...(tDef.font != null ? { font: tDef.font as string } : {}),
    ...(tDef.limit != null ? { limit: tDef.limit as number } : {}),
  }
  const titleH = useTitleBlock ? boundText(new Bounds(), titleItem).height() : 0
  if (tDef.orient === 'bottom') {
    // The column title sits below the grid: title origin at +offset, the
    // renderer bakes the top-baseline offset (0.79 * fontSize).
    titleItem.baseline = (tDef.baseline as SceneItem['baseline']) ?? 'top'
    titleItem.y = titleOffset
  } else {
    titleItem.y = !useTitleBlock
      ? -(titleOffset + 2)
      : tDef.angle != null || tDef.baseline != null
        ? -(titleOffset + titleH)
        : -(titleOffset + titleH) + Math.round(0.79 * ((tDef.fontSize as number | undefined) ?? 11))
  }
  return {
    marktype: 'group', name: mark.name, role: 'column-title',
    items: [titleItem],
    x: titleX, y: -31,
    ...(titleAnchorC !== 'middle' ? { _titleAnchor: titleAnchorC } : {}),
  } as SceneGroup
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
  // trellisLayout centers a column title; an explicit header titleAnchor
  // pulls it to the grid start/end instead.
  const layout = getFacetLayout(ctx)
  if (layout) {
    for (const g of items) {
      if (g.role !== 'column-title') continue
      const anchor = (g as unknown as { _titleAnchor?: string })._titleAnchor
      if (anchor === 'start') g.x = Math.round(layout.gridX1)
      else if (anchor === 'end') g.x = Math.round(layout.gridX2)
    }
  }
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
  if ((label as Record<string, unknown>).fontSize == null) (label as Record<string, unknown>).fontSize = GUIDE_LABEL_FONT_SIZE
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

  const textItems: SceneItem[] = []
  const collectTexts = (items: SceneItem[]): void => {
    for (const it of items) {
      const g = it as SceneGroup
      if (Array.isArray(g.items)) {
        collectTexts(g.items)
      } else if (it.text != null && it.x != null && it.y != null) {
        textItems.push(it)
      }
    }
  }
  collectTexts(cell.items ?? [])
  // Guide leaves carry vega's raw item y (the baseline shift is the
  // renderer's); the extent measure needs the rendered position.
  const renderedY = (it: SceneItem): number =>
    (it.y ?? 0) + (it.baseline && !(it.angle != null && it.angle !== 0) ? baselineOffset(it) : 0)

  let cellX = 0
  let cellY = 0
  if (isVertical) {
    // Vertical concat stacks cells top-to-bottom. The per-cell vertical advance
    // must clear the cell's bottom x-axis extent (labels + title below the plot)
    // plus the base spacing — the vertical analog of the horizontal advance.
    let xAxisExtent = 0
    for (const it of textItems) {
      const y = renderedY(it)
      if (y > cellHeight) xAxisExtent = Math.max(xAxisExtent, Math.ceil(y - cellHeight - 0.5))
    }
    cellY = idx * (cellHeight + CONCAT_BASE_SPACING + xAxisExtent)
  } else {
    // Determine the per-cell horizontal advance from the y-axis left extent so the
    // next cell's y-axis clears this cell's content + base spacing.
    let yAxisExtent = 0
    for (const it of textItems) {
      const x = it.x ?? 0
      if (x < 0) yAxisExtent = Math.max(yAxisExtent, Math.ceil(Math.abs(x) + TITLE_FONT_SIZE + 0.5))
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
          // its bottom sits (fontSize - round(0.8*fontSize)) below the anchor;
          // guide leaves carry the raw y, so add the baseline shift back.
          const fontSize = (it as unknown as Record<string, unknown>).fontSize as number | undefined ?? TITLE_FONT_SIZE
          const boff = (it as SceneItem).baseline && !(it.angle != null && it.angle !== 0)
            ? baselineOffset(it as SceneItem)
            : 0
          y2 = Math.max(y2, y + boff + (fontSize - Math.round(0.8 * fontSize)))
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
  // forward the whole axis spec (labelAngle, fonts, colors, ...): a whitelist
  // here silently dropped the facet axes' label rotation and paint props
  const def: Record<string, unknown> = { ...spec }
  const group = buildAxis(def as unknown as CompiledAxis, ctx)
  if (group) {
    const g = group as unknown as { orient?: string; scale?: string; title?: string; aria?: boolean; format?: string; formatType?: string }
    g.orient = String(spec.orient ?? '')
    g.scale = typeof spec.scale === 'string' ? spec.scale : undefined
    g.aria = spec.aria as boolean | undefined
    g.format = guideString(ctx, spec.format)
    g.formatType = guideString(ctx, spec.formatType)
    const title = guideTitle(ctx, spec.title)
    if (title) g.title = title
  }
  return group
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
  let rows = (ctx.datasets.get(source) ?? []).map((r) => ({ ...r }))
  if (mark.sort) rows = sortRows(rows, mark.sort)

  const update = mark.encode?.update ?? mark.encode?.enter ?? {}
  items = rows.map((row, i) => {
    if ((i & 2047) === 0) ctx.checkDeadline?.('mark encoding')
    const res = resolveEncodeSet(update, row, ctx, mark.type)
    res.datum = row
    return res
  })

  if (Array.isArray((mark as any).style) ? (mark as any).style.includes('arc') : (mark as any).style === 'arc') {
    for (const it of items) { if (it.strokeWidth == null) it.strokeWidth = 1.5 }
  }
  // vega's built-in 'trail' style (vega-parser defaults): size defaults to
  // the default stroke width (2) — the trail generator halves it per point.
  if (Array.isArray((mark as any).style) ? (mark as any).style.includes('trail') : (mark as any).style === 'trail') {
    for (const it of items) { if (it.size == null) it.size = 2 }
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

/** Per-mark, per-eval scale bindings for encode channels. The encode value
 * objects are shared across all rows of a mark, so resolving their scale
 * function once per mark (instead of per row per channel) removes two Map
 * lookups per scale channel per row. */
type EncodeBinding = Map<object, { scale: Scale; type?: string }>

function encodeBindingFor(encode: Record<string, EncodeValue | EncodeValue[]>, ctx: EvalContext): EncodeBinding {
  const binding: EncodeBinding = new Map()
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    const rec = v as Record<string, unknown>
    if (typeof rec.scale === 'string' && !binding.has(v as object)) {
      const scale = ctx.scales.get(rec.scale)
      if (scale) binding.set(v as object, { scale, type: ctx.scaleTypes.get(rec.scale) })
    }
    for (const k of Object.keys(rec)) walk(rec[k])
  }
  for (const key of Object.keys(encode)) walk(encode[key])
  return binding
}

// Per-encode-object plan. The key scan + signal/plain partition is invariant
// across the rows of a mark; hoisting it removes an Object.keys allocation and
// an array partition per row (10k rows -> 1 scan).
const encodePlanCache = new WeakMap<object, EncodePlan>()

/** Cached rect paint order (see evaluateMark): sort keys, the stable-sort
 * permutation, and its inverse, so an eval with unchanged keys can replay the
 * order in O(n) and prove differential item reuse safe. */

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
  const binding = ctx.encodeBinding

  // Resolve the `defined` signal BEFORE datum mutation. Vega evaluates
  // `defined` against the original data tuple (before scale resolution),
  // so expressions like `isValid(datum["y"])` must see the raw data
  // value (null), not the scaled pixel position.
  let definedValue: unknown
  if (plan.definedSpec !== undefined) {
    definedValue = resolveEncodeProperty(plan.definedSpec, datum, ctx, binding)
  }

  // Pass 1: resolve all non-signal values straight into the item (no
  // intermediate per-row object — this is the hottest loop in the engine).
  const item: SceneItem = {}
  const rec = item as unknown as Record<string, unknown>
  for (const key of plan.plainKeys) {
    const resolved = resolveEncodeProperty(encode[key], datum, ctx, binding)
    if (resolved !== undefined) {
      rec[key] = resolved
    }
  }

  // Pass 2: mirror the resolved plain values onto the datum tuple, then resolve
  // signal-value pairs, which may read those values back off `datum`.
  for (const key of plan.plainKeys) {
    const v = rec[key]
    if (v !== undefined) datum[key as keyof Row] = v
  }
  // Apply the pre-resolved `defined` value (from before datum mutation).
  if (definedValue !== undefined) {
    rec['defined'] = definedValue
  }
  for (const key of plan.signalKeys) {
    const resolved = resolveEncodeProperty(encode[key], datum, ctx, binding)
    if (resolved !== undefined) {
      rec[key] = resolved
    }
  }
  // Post-process: vega parse/mark `adjustSpatial` — resolve x2/xc/y2/yc into
  // x/y/width/height. Rule marks skip it entirely (their x2/y2 are line
  // endpoints, not edges); rect/group/image swap so x/y is the min edge.
  // x2/y2 overwrite an encoded width/height; xc/yc only set x/y.
  if (marktype !== 'rule') {
    const canSwap = marktype === 'rect' || marktype === 'group' || marktype === 'image'
    const num = (v: unknown): number | null =>
      v != null && typeof v === 'number' && Number.isFinite(v) ? v : null
    const x2 = num(rec['x2'])
    const xc = num(rec['xc'])
    const y2 = num(rec['y2'])
    const yc = num(rec['yc'])
    if (x2 != null) {
      const x = num(rec['x'])
      if (x != null) {
        if (canSwap && x > x2) { rec['x'] = x2; rec['x2'] = x }
        rec['width'] = (rec['x2'] as number) - (rec['x'] as number)
      } else {
        rec['x'] = x2 - (num(rec['width']) ?? 0)
      }
    }
    if (xc != null) rec['x'] = xc - (num(rec['width']) ?? 0) / 2
    if (y2 != null) {
      const y = num(rec['y'])
      if (y != null) {
        if (canSwap && y > y2) { rec['y'] = y2; rec['y2'] = y }
        rec['height'] = (rec['y2'] as number) - (rec['y'] as number)
      } else {
        rec['y'] = y2 - (num(rec['height']) ?? 0)
      }
    }
    if (yc != null) rec['y'] = yc - (num(rec['height']) ?? 0) / 2
    // A rect with a resolved position but no size channel (e.g. an x2 scale
    // over an invalid aggregate) is zero-size, not absent: vega's
    // adjustSpatial leaves width/height undefined and the rect path degenerates.
    if (canSwap) {
      if (rec['x'] != null && rec['width'] == null && rec['x2'] == null) rec['width'] = 0
      if (rec['y'] != null && rec['height'] == null && rec['y2'] == null) rec['height'] = 0
    }
  }

  return item
}

function resolveEncodeProperty(
  spec: EncodeValue | EncodeValue[] | undefined,
  datum: Row,
  ctx: EvalContext,
  binding?: EncodeBinding,
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
              return resolveEncodeValueInternal(cond, datum, ctx, binding)
            } catch {
              return undefined
            }
          }
        } catch {
          // Expression evaluation failed (e.g., datum has no field); skip condition
        }
      } else if (cond && typeof cond === 'object') {
        return resolveEncodeValueInternal(cond, datum, ctx, binding)
      }
    }
    return undefined
  }
  return resolveEncodeValueInternal(spec, datum, ctx, binding)
}

function resolveEncodeValueInternal(value: EncodeValue | undefined, datum: Row, ctx: EvalContext, binding?: EncodeBinding): unknown {
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
    // Per-mark binding (populated once per mark per eval) avoids two Map lookups
    // per row per channel; fall back to the live maps for anything it missed.
    const bound = binding?.get(value as object)
    const scale = bound ? bound.scale : (ctx.scales.get(value.scale as string) as Scale | undefined)
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
        // { scale: "x", band: 1 } - return bandwidth * band fraction, then
        // apply the encode's offset/mult. Vega's `height: {scale:'y', band:1,
        // offset:-1}` is the common bar-gap idiom.
        const fraction = bandSpec === true ? 0.5 : (typeof bandSpec === 'number' ? bandSpec : 1)
        let result = s.bandwidth() * fraction
        if (offsetSpec != null) {
          if (typeof offsetSpec === 'number') result += offsetSpec
          else if (typeof offsetSpec === 'object' && 'signal' in offsetSpec) {
            result += ctx.runtime.expr(offsetSpec.signal as string)(datum, ctx.signalParams) as number
          }
        }
        if (typeof multVal === 'number') result *= multVal
        return result
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
    if (raw === undefined) {
      // A discrete domain can legitimately contain undefined (e.g. an
      // aggregate over a nominal field); vega still maps that domain entry
      // through the scale rather than dropping the channel.
      const dom = s.domain?.() as unknown[] | undefined
      if (!Array.isArray(dom) || !dom.includes(undefined)) return undefined
    }
    
    const scaleType = bound ? bound.type : ctx.scaleTypes.get(value.scale as string)
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
    
    // Apply mult after scale resolution (only if it is an actual number, not a signal object).
    // The offset was already applied in step 5 (offsetSpec) — applying the
    // tail's offsetVal here would double it.
    if (typeof multVal === 'number') position = position * multVal
    if (offsetSpec == null && typeof offsetVal === 'number') position = position + offsetVal
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
  const scaleName = legend.shape ?? legend.stroke ?? legend.fill ?? legend.size ?? legend.opacity
    ?? (typeof legend.strokeWidth === 'string' ? legend.strokeWidth : undefined)
  if (!scaleName) return null
  // Legend labels honor formatType/format; a Vega-Lite timeUnit legend emits
  // the format as a timeUnitSpecifier(...) signal, which must be resolved to
  // its strftime specifier before formatting.
  const legendLabel = (v: unknown): string => {
    const L = locale(undefined)
    let fmt = (legend as { format?: unknown }).format
    const fmtType = (legend as { formatType?: unknown }).formatType
    if (v == null) return fmtType === 'time' ? '' : String(v)
    if (fmt != null && typeof fmt === 'object' && 'signal' in (fmt as Record<string, unknown>)) {
      const sig = String((fmt as { signal: string }).signal)
      try {
        const resolved = ctx.runtime.expr(sig)({}, ctx.signalParams)
        if (typeof resolved === 'string') fmt = resolved
        else fmt = undefined
      } catch {
        fmt = evalTimeUnitSpecifier(sig)
      }
    }
    if (fmtType === 'time' || v instanceof Date) {
      const d = v instanceof Date ? v : new Date(Number(v))
      return L.timeFormat(typeof fmt === 'string' ? fmt : '%b %d, %Y')(d)
    }
    if (fmt !== undefined) return L.format(String(fmt))(typeof v === 'number' ? v : Number(v))
    // A continuous legend without an explicit format delegates to the scale's
    // locale span formatter (vega labelFormat → tickFormat), whose precision
    // derives from the tick step — e.g. a degenerate [1,1] domain formats as
    // '1.000000' rather than '1'.
    if (isContinuous(ctx.scaleTypes.get(scaleName) ?? '') && scale) {
      const rawCount = (legend as { tickCount?: unknown }).tickCount
      const count = typeof rawCount === 'number' ? rawCount : 5
      return tickFormat(L, scale, count)(v)
    }
    return String(v)
  }
  const scale = ctx.scales.get(scaleName)
  if (!scale) return null
  const scaleType = ctx.scaleTypes.get(scaleName) ?? ''
  // A tickCount interval string ('day', 'month', ...) is only legal on time
  // scales: vega's LegendEntries transform throws, the dataflow swallows the
  // error and the legend renders with no entries (an empty degenerate group).
  const tickCountRaw = (legend as { tickCount?: unknown }).tickCount
  if (typeof tickCountRaw === 'string' && scaleType !== 'time' && scaleType !== 'utc') {
    // vega's LegendEntries throws (the pulse aborts downstream of it): the
    // entries vanish but the legend title — whose encode ran earlier — stays
    // at its raw (0,0) position.
    const titleStr = String(legend.title ?? '')
    const items: SceneItem[] = []
    if (titleStr) items.push({ text: titleStr, x: 0, y: 0, align: 'left', baseline: 'top', fill: '#000', fontSize: 11 })
    return { marktype: 'group', role: 'legend', x: 0, y: 0, width: 0, height: 0, items }
  }
  // Domain values. A continuous symbol legend (opacity, or a color scale
  // without a gradient) lists generated ticks, not just the domain endpoints.
  const rawDomain = scale.domain() as unknown[]
  const domain = (CONTINUOUS_TYPES.has(scaleType) && (legend as { values?: unknown }).values == null
    && typeof (scale as { ticks?: (n?: number) => unknown[] }).ticks === 'function'
    ? ((scale as { ticks: (n?: number) => unknown[] }).ticks(5) as unknown[])
    : rawDomain)
  // gradient legends position ticks across the true scale domain (not the
  // generated tick list); symbol legends list the ticks themselves.
  const d0 = rawDomain[0]
  const d1 = rawDomain[rawDomain.length - 1]
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
    const L = gradientLength

    // Vega numbers gradient defs from a global counter; replicate that so the
    // `url(#gradient_n)` references match the oracle (which runs in-process).
    const gradientId = 'gradient_' + gradientIdCounter++

    // Gradient-legend paint properties (vega legend scheme defaults).
    const titleColor0 = (legend as { titleColor?: string }).titleColor ?? '#000'
    const labelColor0 = (legend as { labelColor?: string }).labelColor ?? '#000'
    const titleOpacity0 = (legend as { titleOpacity?: number }).titleOpacity
    const labelOpacity0 = (legend as { labelOpacity?: number }).labelOpacity
    const titleFs0 = (legend as { titleFontSize?: number }).titleFontSize ?? 11
    const labelFs0 = (legend as { labelFontSize?: number }).labelFontSize ?? 10
    const gradStrokeColor = (legend as { gradientStrokeColor?: string }).gradientStrokeColor ?? '#ddd'
    const gradStrokeWidth = (legend as { gradientStrokeWidth?: number }).gradientStrokeWidth ?? 0
    const gradOpacityProp = (legend as { gradientOpacity?: number }).gradientOpacity
    const borderColor0 = (legend as { strokeColor?: string }).strokeColor
    const fillColor0 = (legend as { fillColor?: string }).fillColor

    // vega-encode's gradient legend uses
    //   max(2, 2*floor(gradientLength/100))
    // as the default tick count, and falls back to the domain endpoints when
    // automatic label generation yields two or fewer entries.
    const rawGradCount = (legend as { tickCount?: unknown }).tickCount
    let gradCount = Math.max(2, 2 * Math.floor(L / 100))
    if (typeof rawGradCount === 'number') gradCount = rawGradCount
    else if (rawGradCount && typeof rawGradCount === 'object' && 'signal' in (rawGradCount as Record<string, unknown>)) {
      const v = ctx.runtime.expr(String((rawGradCount as { signal: string }).signal))({}, ctx.signalParams)
      if (typeof v === 'number') gradCount = v
    }
    const tickMinStep = (legend as { tickMinStep?: unknown }).tickMinStep
    const counted = tickCount(scale, gradCount, typeof tickMinStep === 'number' ? tickMinStep : undefined)
    if (typeof counted === 'number') gradCount = counted
    let tickNums = tickValues(scale, gradCount)
    const legendValues = (legend as { values?: unknown }).values
    if (Array.isArray(legendValues)) tickNums = legendValues
    else if (tickNums.length < 3 && legendValues == null && d0 !== d1) {
      tickNums = [d0, d1]
    }
    // An all-invalid (NaN) domain has no generated ticks; vega still emits a
    // single 'NaN' label at the gradient midpoint.
    if (tickNums.length === 0 && legendValues == null && Number.isNaN(Number(d0))) tickNums = [NaN]
    const titleStr0 = String(legend.title ?? '')
    const titlePad0 = (legend as { titlePadding?: number }).titlePadding ?? 5
    const titleH0 = titleStr0.length > 0 ? titleFs0 + titlePad0 : 0
    // Resolve the gradient label formatter once: legend.format may be a
    // timeUnitSpecifier(...) signal, and formatType 'time' requires timeFormat
    // (not the numeric format path).
    const rawLegendFormat = (legend as { format?: unknown }).format
    let resolvedLegendFormat: string | undefined
    if (typeof rawLegendFormat === 'string') resolvedLegendFormat = rawLegendFormat
    else if (rawLegendFormat && typeof rawLegendFormat === 'object' && 'signal' in (rawLegendFormat as Record<string, unknown>)) {
      const sig = String((rawLegendFormat as { signal: string }).signal)
      try {
        const v = ctx.runtime.expr(sig)({}, ctx.signalParams)
        if (typeof v === 'string') resolvedLegendFormat = v
      } catch {
        resolvedLegendFormat = evalTimeUnitSpecifier(sig)
      }
    }
    const legendFormatType = (legend as { formatType?: unknown }).formatType
    const legendTimeFormat = legendFormatType === 'time' || scaleType === 'time' || scaleType === 'utc'
    const makeGradientFmt = (defaultFmt: string): ((v: unknown) => string) => {
      const L = locale(undefined)
      let base: (v: unknown) => string
      if (legendTimeFormat) {
        const fmt = resolvedLegendFormat ?? defaultFmt
        base = (v: unknown) => L.timeFormat(fmt)(v instanceof Date ? v : new Date(Number(v)))
      } else if (resolvedLegendFormat) {
        base = (v: unknown) => L.format(resolvedLegendFormat)(typeof v === 'number' ? v : Number(v))
      } else {
        // vega labelFormat() with no explicit specifier delegates to the
        // scale's locale tick formatter, which chooses decimal precision from
        // the tick step (e.g. 8.0/8.5/9.0 for a [8,9] domain).
        base = (v: unknown) => tickFormat(L, scale, gradCount)(v)
      }
      const labelExpr = (legend as { labelExpr?: unknown }).labelExpr
      if (typeof labelExpr !== 'string') return base
      const expr = compileExpr(labelExpr, ctx.runtime)
      return (v: unknown) => String(expr({ label: base(v), value: v }, ctx.signalParams))
    }

    // vega's scaleFraction() builds a positional copy of the scale over the
    // legend domain, so non-linear scales (log/sqrt/symlog) place labels at
    // their transformed positions rather than linearly.
    const gradD0n = typeof d0 === 'number' ? d0 : 0
    const gradD1n = typeof d1 === 'number' ? d1 : 1
    const gradientFractionScale = scaleFraction(scale, gradD0n, gradD1n)
    const gradientFraction = (v: number): number => {
      const out = gradientFractionScale(v)
      return typeof out === 'number' && Number.isFinite(out) ? out : 0.5
    }

    // --- horizontal gradient strip (top/bottom orient, or direction:horizontal) ---
    // Vega lays the strip out left→right: title at y=9, the gradient rect at
    // y=titleH (height=gradientThickness 16), labels beneath at the fractional
    // position along the strip. Calibrated to the oracle.
    if (legend.direction === 'horizontal' || orient === 'bottom' || orient === 'top') {
      const thickness = legend.gradientThickness ?? 16
      const d0n = typeof d0 === 'number' ? d0 : 0
      const d1n = typeof d1 === 'number' ? d1 : 1
      const legendFmt = makeGradientFmt(d0n === d1n ? '.6f' : '.1~f')
      const items: SceneItem[] = []
      const bgW = gradientLength
      const bgH = titleH0 + thickness + 12
      const bgX0 = borderColor0 != null ? 0.5 : 0
      const bgY0 = borderColor0 != null ? 0.5 : 0
      const gradCRH = (legend as { cornerRadius?: number }).cornerRadius
      items.push({ path: gradCRH && gradCRH > 0 ? roundedRectPath(bgX0, bgY0, bgW, bgH, Math.min(gradCRH, bgW / 2, bgH / 2)) : `M${bgX0},${bgY0}h${bgW}v${bgH}h-${bgW}Z`, x: 0, y: 0, ...(fillColor0 != null ? { fill: fillColor0 } : {}), ...(borderColor0 != null ? { stroke: borderColor0 } : {}) })
      if (titleStr0) {
        const hAnchor = (legend as { titleAnchor?: string }).titleAnchor ?? 'start'
        const hAlign = (legend as { titleAlign?: string }).titleAlign
          ?? (hAnchor === 'end' ? 'right' : hAnchor === 'middle' ? 'center' : 'left')
        const hBase = (legend as { titleBaseline?: string }).titleBaseline ?? 'top'
        const hY = hBase === 'middle' ? Math.round(0.3 * titleFs0) : hBase === 'bottom' ? Math.round(-0.21 * titleFs0) : Math.round(0.79 * titleFs0)
        const hX = hAnchor === 'end' ? gradientLength : hAnchor === 'middle' ? gradientLength / 2 : 0
        const hLimit = (legend as { titleLimit?: number }).titleLimit
        items.push({ text: titleStr0, x: hX, y: hY, align: hAlign as SceneItem['align'], fill: titleColor0, fontSize: titleFs0, ...(hLimit != null ? { limit: hLimit } : {}), ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}) })
      }
      items.push({ path: `M0,0h${gradientLength}v${thickness}h${-gradientLength}Z`, x: 0, y: titleH0, fill: `url(#${gradientId})`, stroke: gradStrokeColor, strokeWidth: gradStrokeWidth, opacity: gradOpacityProp ?? 1 })
      for (const t of tickNums) {
        const tNum = typeof t === 'number' ? t : 0
        const perc = gradientFraction(tNum)
        items.push({ text: legendFmt(tNum), x: perc * gradientLength, y: titleH0 + thickness + 10, align: 'center', fill: labelColor0, fontSize: labelFs0, ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}), ...(labelOpacity0 != null ? { fillOpacity: labelOpacity0 } : {}) })
      }
      const colorScale = scale as ColorScale
      const stops = colorScale.interpolator
        ? Array.from({ length: 17 }, (_, i) => ({ offset: i / 16, color: String((colorScale.interpolator as () => (t: number) => unknown)?.()(i / 16)) }))
        : []
      if (stops.length) ctx._defs.push({ id: gradientId, colorStops: stops, direction: 'horizontal' })
      const gradientGroup = { marktype: 'group', role: 'legend', x: 0, y: 0, width: bgW, height: bgH, items } as SceneGroup
      // vega legendLayout boundStrokes the outer rect with the legend's OWN
      // stroke (legend.strokeColor) — the gradient rect's decorative #ddd
      // zero-width stroke is not the group's and must not expand the bounds.
      ;(gradientGroup as unknown as Record<string, unknown>)._borderStroke = borderColor0 != null
      return gradientGroup
    }

    // The gradient rect inherits the legend's gradient encode opacity (vega-lite
    // emits opacity 0.7 for stroke legends, 1 otherwise).
    let gradientOpacity = 1
    const gradEncode = (legend as unknown as { encode?: { gradient?: { update?: { opacity?: EncodeValue } } } }).encode?.gradient?.update?.opacity
    if (gradEncode && typeof gradEncode === 'object' && 'value' in gradEncode) {
      const ov = (gradEncode as { value?: unknown }).value
      if (typeof ov === 'number') gradientOpacity = ov
    }

    // Outer background width = the wider of the label run and the title
    // (vega measures both with textMetrics: labels 10px, title bold 11px).
    // Measure the FORMATTED labels — vega-format emits U+2212 for negatives
    // (16.96px for '−10' vs 14.45px for the ASCII '-10' of String(t)).
    const measureFmt = makeGradientFmt('.1~f')
    const labelStrs = tickNums.map((t: unknown) => measureFmt(t))
    const maxLabelW = labelStrs.reduce((m: number, s: string) => Math.max(m, nominalTextWidth(s, labelFs0)), 0)
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? nominalTextWidth(titleStr, Math.abs(titleFs0), 'bold') : 0
    const vThickness = (legend as { gradientThickness?: number }).gradientThickness ?? 16
    const vLabelOffset = (legend as { labelOffset?: number }).labelOffset ?? 2
    const gradPad = (legend as { padding?: number }).padding ?? 0
    // vega's legendLayout sizes the legend box as ceil(bounds.width() + 2*pad).
    const outerWidth = Math.ceil(Math.max(vThickness + vLabelOffset + maxLabelW, titleWidth))
    const vAnchor = (legend as { titleAnchor?: string }).titleAnchor ?? 'start'
    const vAlign = (legend as { titleAlign?: string }).titleAlign
      ?? (vAnchor === 'end' ? 'right' : vAnchor === 'middle' ? 'center' : 'left')
    const vX = vAnchor === 'end' ? outerWidth : vAnchor === 'middle' ? outerWidth / 2 : 0
    const titleBoundsLeft = vX - (vAlign === 'center' ? titleWidth / 2 : vAlign === 'right' ? titleWidth : 0)
    const titleBoundsRight = vX + (vAlign === 'center' ? titleWidth / 2 : vAlign === 'left' ? titleWidth : 0)
    const negativeTitleExtra = titleFs0 < 0 ? Math.ceil(Math.abs(titleFs0) * 0.75) : 0
    const titleExtraLeft = Math.max(0, -titleBoundsLeft) + negativeTitleExtra
    const titleExtraRight = Math.max(0, titleBoundsRight - outerWidth)

    const items: SceneItem[] = []
    const titleOrientG = (legend as { titleOrient?: string }).titleOrient ?? 'top'
    const sideTitleG = titleOrientG === 'left' || titleOrientG === 'right'
    const bottomTitleG = titleOrientG === 'bottom'
    const sideTitleW = sideTitleG && titleStr.length > 0 ? Math.abs(titleFs0) + titlePad0 : 0
    // Title height: the row above the gradient only exists for a top title.
    const titleH = titleStr.length > 0 && !sideTitleG && !bottomTitleG ? Math.abs(titleFs0) + titlePad0 : 0
    const titleBottomH = titleStr.length > 0 && bottomTitleG ? Math.abs(titleFs0) + titlePad0 : 0
    const gradStrokeExtra = gradStrokeWidth / 2
    const boxW = Math.ceil(outerWidth + 2 * gradPad + titleExtraLeft + titleExtraRight + sideTitleW)
    const contentX = gradPad + titleExtraLeft + (titleOrientG === 'left' ? sideTitleW : 0)
    // Legend layout includes label bounds, which can extend below a short
    // gradient (or below the domain when explicit values fall outside it).
    const labelBottom = tickNums.reduce<number>((m, t) => {
      const tNum = typeof t === 'number' ? t : 0
      const perc = gradientFraction(tNum)
      const baselineOffset =
        perc <= 0 ? Math.round(-0.21 * labelFs0)
        : perc >= 1 ? Math.round(0.79 * labelFs0)
        : Math.round(0.3 * labelFs0)
      return Math.max(m, gradPad + titleH + (1 - perc) * L + baselineOffset + 2)
    }, 0)
    const boxH = Math.ceil(Math.max(titleH + titleBottomH + L + 2 * gradPad + gradStrokeExtra, labelBottom))
    // Background box (0,0 to outerWidth, titleH+L) — the legend's own border
    // stroke (legend.strokeColor) insets the rect half a pixel; fillColor
    // paints it.
    const bgXV = borderColor0 != null ? 0.5 : 0
    const bgYV = borderColor0 != null ? 0.5 : 0
    const gradCRV = (legend as { cornerRadius?: number }).cornerRadius
    items.push({ path: gradCRV && gradCRV > 0 ? roundedRectPath(bgXV, bgYV, boxW, boxH, Math.min(gradCRV, boxW / 2, boxH / 2)) : `M${bgXV},${bgYV}h${boxW}v${boxH}h-${boxW}Z`, x: 0, y: 0, ...(fillColor0 != null ? { fill: fillColor0 } : {}), ...(borderColor0 != null ? { stroke: borderColor0 } : {}) })
    // Gradient rect at legend-relative (0, titleH), thickness x L
    items.push({
      path: `M0,0h${vThickness}v${L}h${-vThickness}Z`,
      x: contentX, y: gradPad + titleH,
      fill: `url(#${gradientId})`,
      stroke: gradStrokeColor,
      strokeWidth: gradStrokeWidth,
      opacity: gradOpacityProp ?? gradientOpacity,
    })
    // Title
    if (titleStr.length > 0) {
      const vBase = (legend as { titleBaseline?: string }).titleBaseline ?? 'top'
      const vY = vBase === 'middle' ? Math.round(0.3 * titleFs0) : vBase === 'bottom' ? Math.round(-0.21 * titleFs0) : Math.round(0.79 * titleFs0)
      const vLimit = (legend as { titleLimit?: number }).titleLimit
      if (sideTitleG) {
        items.push({
          text: titleStr,
          x: titleOrientG === 'left' ? gradPad : gradPad + outerWidth + titlePad0,
          y: gradPad + L / 2,
          angle: titleOrientG === 'left' ? -90 : 90,
          align: 'center',
          fill: titleColor0, fontSize: titleFs0,
          ...(vLimit != null ? { limit: vLimit } : {}),
          ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}),
        })
      } else if (bottomTitleG) {
        items.push({
          text: titleStr,
          x: vX + contentX,
          y: gradPad + L + Math.round(0.79 * titleFs0) + titlePad0,
          align: vAlign as SceneItem['align'],
          fill: titleColor0, fontSize: titleFs0,
          ...(vLimit != null ? { limit: vLimit } : {}),
          ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}),
        })
      } else {
        items.push({ text: titleStr, x: vX + contentX, y: vY + gradPad, align: vAlign as SceneItem['align'], fill: titleColor0, fontSize: titleFs0, ...(vLimit != null ? { limit: vLimit } : {}), ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}) })
      }
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
    const legendFmt = makeGradientFmt(d0n === d1n ? '.6f' : '.1~f')
    for (const t of tickNums) {
      const tNum = typeof t === 'number' ? t : 0
      const perc = gradientFraction(tNum)
      const baselineOffset =
        perc <= 0 ? Math.round(-0.21 * labelFs0)
        : perc >= 1 ? Math.round(0.79 * labelFs0)
        : Math.round(0.3 * labelFs0)
      const yPos = titleH + (1 - perc) * L + baselineOffset
      items.push({ text: legendFmt(tNum), x: contentX + vThickness + vLabelOffset, y: gradPad + yPos, align: 'left', fill: labelColor0, fontSize: labelFs0, ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}), ...(labelOpacity0 != null ? { fillOpacity: labelOpacity0 } : {}) })
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
      x: 0,
      y: 0,
      width: boxW,
      height: boxH,
      items,
    }
    ;(group as unknown as Record<string, unknown>)._borderStroke = borderColor0 != null
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
    // Legend tick values (vega: labelValues(scale, 5)); drop the first value
    // when it maps to size zero (vega#717).
    const sizeLegendValues = (legend as { values?: unknown }).values
    let sizeTickCount = 5
    const sizeTickMin = (legend as { tickMinStep?: number }).tickMinStep
    const sizeCounted = tickCount(sizeScale, sizeTickCount, typeof sizeTickMin === 'number' ? sizeTickMin : undefined)
    if (typeof sizeCounted === 'number') sizeTickCount = sizeCounted
    let ticks = (Array.isArray(sizeLegendValues)
      ? sizeLegendValues
      : ((sizeScale as { ticks?: (n?: number) => unknown[] }).ticks?.(sizeTickCount) ?? [])) as unknown[]
    if (ticks.length > 1 && Number(sizeScale(ticks[0])) === 0) ticks = ticks.slice(1)
    if (ticks.length === 0) {
      // An empty (all-invalid) size legend still renders its title box: vega
      // keeps the legend group with zero entries and a title-width background.
      const titleStr = String(legend.title ?? '')
      const titleFs = (legend as { titleFontSize?: number }).titleFontSize ?? 11
      const titleColor = (legend as { titleColor?: string }).titleColor ?? '#000'
      const titleOpacity = (legend as { titleOpacity?: number }).titleOpacity
      const w = titleStr ? nominalTextWidth(titleStr, Math.abs(titleFs), 'bold') : 0
      const h = titleStr ? Math.abs(titleFs) : 0
      const items: SceneItem[] = [{ path: `M0,0h${w}v${h}h-${w}Z`, x: 0, y: 0 }]
      if (titleStr) items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: titleColor, fontSize: titleFs, fontWeight: 'bold', ...(titleOpacity != null ? { fillOpacity: titleOpacity } : {}) })
      return { marktype: 'group', role: 'legend', x: 0, y: 0, width: w, height: h, items }
    }
    const sizeDomain = sizeScale.domain() as number[]
    const sizeIsTime = (legend as { formatType?: unknown }).formatType === 'time'
    const sizeCollapsed = !sizeIsTime && sizeDomain.length >= 2 && sizeDomain[0] === sizeDomain[sizeDomain.length - 1]
    const sizeUnitDomain = !sizeIsTime && sizeDomain.length >= 2 && sizeDomain[0] === 0 && sizeDomain[sizeDomain.length - 1] === 1
    // A collapsed [x,x] domain formats through the locale span formatter
    // ('0.000000'); only a [0,1] size domain uses one fixed decimal ('0.0').
    const baseSizeLabel = (v: unknown): string =>
      !sizeCollapsed && sizeUnitDomain && typeof v === 'number' ? v.toFixed(1) : legendLabel(v)
    const sizeLabelExpr = (legend as { labelExpr?: unknown }).labelExpr
    const sizeExpr = typeof sizeLabelExpr === 'string' ? compileExpr(sizeLabelExpr, ctx.runtime) : null
    const sizeLabel = (v: unknown): string => sizeExpr
      ? String(sizeExpr({ label: baseSizeLabel(v), value: v }, ctx.signalParams))
      : baseSizeLabel(v)

    // Symbol stroke/opacity from the legend's symbols encode (vega-lite emits
    // stroke=#4c78a8, opacity=0.7, fill=transparent for size legends).
    const symEncode = (legend.encode?.symbols?.update ?? {}) as Record<string, EncodeValue>
    const encVal = (k: string): unknown => {
      const v = symEncode[k]
      return v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : undefined
    }
    const strokeColor = encVal('stroke')
    const opacity = (encVal('opacity') as number) ?? (legend as { symbolOpacity?: number }).symbolOpacity ?? 0.7
    // vega's symbolStrokeColor property overrides the symbols encode
    const symStrokeColor = (legend as { symbolStrokeColor?: string }).symbolStrokeColor
    const strokeWidth = (legend as { symbolStrokeWidth?: number }).symbolStrokeWidth ?? 1.5
    const fontSize = (legend as { labelFontSize?: number }).labelFontSize ?? 10
    const labelOffset = (legend as { labelOffset?: number }).labelOffset ?? 4
    // vega's grid layout pads rows by max(0, rowPadding): a negative value
    // collapses the gap (and drops the per-row bound offset) rather than
    // overlapping rows.
    const rowPaddingRaw = (legend as { rowPadding?: number }).rowPadding ?? 2
    const rowPadding = Math.max(rowPaddingRaw, 0)
    const symbolOffset0 = (legend as { symbolOffset?: number }).symbolOffset ?? 0
    const titleColorS = (legend as { titleColor?: string }).titleColor ?? '#000'
    const labelColorS = (legend as { labelColor?: string }).labelColor ?? '#000'
    const titleOpacityS = (legend as { titleOpacity?: number }).titleOpacity
    const labelOpacityS = (legend as { labelOpacity?: number }).labelOpacity
    const titleFsS = (legend as { titleFontSize?: number }).titleFontSize ?? 11
    const symbolType = legend.symbolType ?? 'circle'
    const sizeSymbolDash = (legend as { symbolDash?: number[] }).symbolDash

    const sizeSymbolLimit = (legend as { symbolLimit?: number }).symbolLimit
    const sizeLimitHits = !!(sizeSymbolLimit && ticks.length > sizeSymbolLimit)
    const baseTicks = sizeLimitHits ? ticks.slice(0, sizeSymbolLimit - 1) : ticks
    const entries = baseTicks.map((v) => {
      const size = Number(sizeScale(v)) || 0
      const r = Math.sqrt(size) / 2
      // vega floors the entry box at the legend-label size (10 when the
      // label font size is zero) so a zero-size label still gets a row.
      const sizeD = Math.max(Math.ceil(Math.sqrt(size) + strokeWidth), fontSize === 0 ? 10 : fontSize)
      return { value: v, size, r, sizeD, label: sizeLabel(v) }
    })
    // LegendEntries: offset = max size across the SLICED entries; the
    // ellipsis entry gets its own size expression but shares that offset.
    const offset = entries.reduce((m, e) => Math.max(m, e.sizeD), 0)
    if (sizeLimitHits) {
      const ev = ticks[baseTicks.length]
      const size = Number(sizeScale(ev)) || 0
      const r = Math.sqrt(size) / 2
      const sizeD = Math.max(Math.ceil(Math.sqrt(size) + strokeWidth), fontSize === 0 ? 10 : fontSize)
      entries.push({ value: ev, size, r, sizeD, label: `…${ticks.length - baseTicks.length} entries` })
    }
    const symbolX = offset / 2 + symbolOffset0
    const labelX = offset + symbolOffset0 + labelOffset

    // Raw-guide mode: vega's legend layout never ran, so every entry scope
    // stays at (0,0) with a degenerate background; only the entry encodes
    // (symbol/label offsets) position the marks. The title also stays at its
    // raw (0,9) encode position.
    if (ctx.rawGuides) {
      const rawItems: SceneItem[] = [{ path: 'M0,0h0v0h0Z', x: 0, y: 0 }]
      const rTitle = String(legend.title ?? '')
      if (rTitle) rawItems.push({ text: rTitle, x: 0, y: 9, align: 'left', fill: titleColorS, fontSize: titleFsS, fontWeight: 'bold' })
      const rStroke = symStrokeColor ?? (strokeColor != null ? String(strokeColor) : '#888')
      for (const e of entries) {
        rawItems.push({ path: 'M0,0h0v0h0Z', x: 0, y: 0 })
        const sy = e.sizeD / 2
        if (symbolType === 'square') {
          const w = Math.sqrt(e.size)
          rawItems.push({ path: `M${-w / 2},${-w / 2}h${w}v${w}h${-w}Z`, x: symbolX, y: sy, stroke: rStroke, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity })
        } else if (symbolType !== 'circle') {
          rawItems.push({ path: symbolPath(symbolType, e.r), x: symbolX, y: sy, stroke: rStroke, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity })
        } else {
          rawItems.push({ shape: 'circle', radius: e.r, x: symbolX, y: sy, stroke: rStroke, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity })
        }
        rawItems.push({ text: e.label, x: labelX, y: sy + Math.round(0.3 * fontSize), align: ((legend as { labelAlign?: string }).labelAlign ?? 'left') as SceneItem['align'], fill: labelColorS, fontSize })
      }
      return { marktype: 'group', role: 'legend', x: 0, y: 0, width: 0, height: 0, items: rawItems }
    }
    // Per-entry vertical bounds (symbol +/- extent, label +/- 5).
    // Vega's boundStroke always inflates symbol bounds by miter*strokeWidth/2 = 3
    // (with default strokeWidth=1.5 and miterLimit=4), even when the symbol has
    // no explicit stroke color. Match that unconditionally for circle symbols.
    const hasStroke = strokeColor != null
    // the label's bound half-height (fontSize/2) floors each entry row; an
    // explicit baseline replaces the centered guess with the real text box.
    const halfLabel = fontSize / 2
    const labelBaselineS = (legend as { labelBaseline?: string }).labelBaseline
    const clipHeightS = (legend as { clipHeight?: number }).clipHeight
    const hasClipS = clipHeightS != null && !!clipHeightS
    const b = entries.map((e) => {
      const symVisible = opacity !== 0
      // vega expands a symbol bound by miter*strokeWidth/2 for positive
      // strokes; a negative strokeWidth shrinks only by |sw|/2 (probed).
      const ext = !symVisible ? e.r : symbolType === 'square' ? (hasStroke ? e.sizeD / 2 : e.r)
        : strokeWidth >= 0 ? e.r + strokeWidth * 2 : e.r - Math.abs(strokeWidth) / 2
      const y = hasClipS ? (clipHeightS as number) / 2 : e.sizeD / 2
      const lbY1 = labelBaselineS === 'top' ? y : labelBaselineS === 'bottom' ? y - fontSize : y - halfLabel
      const lbY2 = labelBaselineS === 'top' ? y + fontSize : labelBaselineS === 'bottom' ? y : y + halfLabel
      if (hasClipS) {
        // the clipPath cuts the symbol to the entry rect; only the (possibly
        // overflowing) label and the clip corners remain in the bound.
        return { y1: Math.min(lbY1, 0), y2: Math.max(lbY2, clipHeightS as number) }
      }
      return { y1: Math.min(y - ext, lbY1), y2: Math.max(y + ext, lbY2) }
    })
    // Single-column vertical grid layout. `align: 'each'` (the default) steps
    // by the previous row's bound; `align: 'all'` aligns every row to the
    // tallest entry plus rowPadding.
    const yOff: number[] = [0]
    if ((legend as { gridAlign?: string }).gridAlign === 'all') {
      // vega's grid row extent is the entry bound plus the symbol's 3px miter
      // inflation; the shared row step is that extent + rowPadding.
      const step = rowPadding + Math.ceil(Math.max(...b.map((x) => x.y2)) + 3)
      for (let i = 1; i < entries.length; i++) yOff.push(step)
    } else {
      for (let i = 1; i < entries.length; i++) {
        const o = rowPaddingRaw < 0
          ? 0
          : rowPadding + (b[i]!.y1 < 0 ? Math.ceil(-b[i]!.y1) : 0)
        yOff.push(o + Math.ceil(b[i - 1]!.y2))
      }
    }
    const yPos: number[] = []
    let acc = 0
    for (let i = 0; i < entries.length; i++) {
      acc += yOff[i]!
      yPos.push(acc)
    }
    const scopesHeight = acc + b[b.length - 1]!.y2

    // Widths: labels render at 10px, title at 11px bold (vega measures both
    // via textMetrics).
    const sizeLabelLimit = (legend as { labelLimit?: number }).labelLimit
    const labelAlignS = (legend as { labelAlign?: string }).labelAlign ?? 'left'
    const ellipsisW = nominalTextWidth('…', fontSize)
    const maxLabelW = entries.reduce((m, e) => {
      const w = nominalTextWidth(e.label, fontSize)
      // vega truncates before measuring; a limit below the ellipsis width
      // still renders '…', so measure that floor.
      const tw = sizeLabelLimit != null && sizeLabelLimit > 0 ? Math.min(w, Math.max(sizeLabelLimit, ellipsisW)) : w
      return Math.max(m, tw)
    }, 0)
    const entryWidth = labelX + maxLabelW * (labelAlignS === 'center' ? 0.5 : labelAlignS === 'right' ? 0 : 1)
    const titleStr = String(legend.title ?? '')
    const titleWidth = titleStr.length > 0 ? nominalTextWidth(titleStr, Math.abs(titleFsS), 'bold') : 0
    const titleAnchorS = (legend as { titleAnchor?: string }).titleAnchor ?? 'start'
    const titleAlignS = (legend as { titleAlign?: string }).titleAlign
      ?? (titleAnchorS === 'end' ? 'right' : titleAnchorS === 'middle' ? 'center' : 'left')
    const titleXBase = titleAnchorS === 'end' ? entryWidth : titleAnchorS === 'middle' ? entryWidth / 2 : 0
    const negativeTitleExtraS = titleFsS < 0 ? Math.ceil(Math.abs(titleFsS) * 0.75) : 0
    const titleLeftS = titleXBase - (titleAlignS === 'center' ? titleWidth / 2 : titleAlignS === 'right' ? titleWidth : 0)
    const titleRightS = titleXBase + (titleAlignS === 'center' ? titleWidth / 2 : titleAlignS === 'left' ? titleWidth : 0)
    const contentShiftS = Math.max(0, -titleLeftS) + negativeTitleExtraS
    const titleOverflowRightS = Math.max(0, titleRightS - entryWidth)
    const outerWidth = Math.ceil(Math.max(entryWidth, titleWidth, titleRightS) + contentShiftS)
    // the title row: the title text's bound height + legend titlePadding
    // (vega's legendGroupLayout: entries sit below title bound + titlePad)
    const titleOrientS = (legend as { titleOrient?: string }).titleOrient ?? 'top'
    const titlePadS = (legend as { titlePadding?: number }).titlePadding ?? 5
    const titleRowH = Math.abs(titleFsS) + titlePadS
    const sideTitle = titleOrientS === 'left' || titleOrientS === 'right'
    // A side title sits in a margin beside the entries (horizontal text, no
    // rotation), a bottom title below them; the top title keeps its row.
    const titleExtraS = sideTitle ? Math.ceil(titleWidth) + 5 : 0
    const entryXShiftS = titleOrientS === 'left' ? Math.ceil(titleWidth) + 5 : 0
    const entryYBaseS = titleOrientS === 'bottom' || sideTitle ? 0 : titleRowH
    const outerWidthS = sideTitle ? entryWidth + titleExtraS : outerWidth
    const bgHeight = sideTitle ? scopesHeight : titleRowH + scopesHeight
    // Legend padding: vega's legendGroupLayout shifts the content origin by
    // (padding, padding) and legendLayout sizes the box w + 2*padding (ceil'd
    // above with the pad included here, not in outerWidth/bgHeight).
    const legendPad = (legend as { padding?: number }).padding ?? 0
    const boxW = Math.ceil(outerWidthS + 2 * legendPad)
    const boxH = Math.ceil(bgHeight + 2 * legendPad)
    // The legend border (legend.strokeColor) insets the background half a
    // pixel and boundStrokes the legend bounds; symbol strokes never do.
    const borderColor = (legend as { strokeColor?: string }).strokeColor

    // --- horizontal size legend (direction:horizontal / orient top|bottom) ---
    // Entries pack left→right; each entry uses its OWN size datum for the
    // symbol/label offset (vega's columns=0 x-signal), centered vertically in
    // the tallest entry row.
    const horizontalS = legend.direction === 'horizontal' || legend.orient === 'top' || legend.orient === 'bottom'
      || (typeof legend.columns === 'number' && Number.isInteger(legend.columns) && legend.columns >= 0)
    if (horizontalS) {
      const labelWidth = (label: string): number => {
        const w = nominalTextWidth(label, fontSize)
        return sizeLabelLimit != null && sizeLabelLimit > 0 ? Math.min(w, Math.max(sizeLabelLimit, ellipsisW)) : w
      }
      // A numeric `columns` packs entries into a grid whose symbol/label
      // offset is the shared maximum sizeD (vega's columns x-signal); without
      // columns each horizontal entry uses its own sizeD.
      const gridColumns = typeof legend.columns === 'number' && Number.isInteger(legend.columns) && legend.columns > 0
      const hx = entries.map((e) => {
        const symVisible = opacity !== 0
        const ext = !symVisible ? e.r : symbolType === 'square' ? (hasStroke ? e.sizeD / 2 : e.r)
          : strokeWidth >= 0 ? e.r + strokeWidth * 2 : e.r - Math.abs(strokeWidth) / 2
        const sx = (gridColumns ? offset / 2 : e.sizeD / 2) + symbolOffset0
        const lx = (gridColumns ? offset : e.sizeD) + symbolOffset0 + labelOffset
        const lw = labelWidth(e.label)
        const lx1 = labelAlignS === 'center' ? lx - lw / 2 : labelAlignS === 'right' ? lx - lw : lx
        const x1 = Math.min(sx - ext, lx1)
        const x2 = Math.max(sx + ext, lx1 + lw)
        return { sx, lx, x1, x2, width: Math.ceil(x2) }
      })
      const rowExtentH = Math.ceil(Math.max(...b.map((x) => x.y2)))
      const hxPos: number[] = [0]
      for (let i = 1; i < hx.length; i++) {
        hxPos.push(hxPos[i - 1]! + hx[i - 1]!.width + 10 + Math.max(0, Math.ceil(-hx[i]!.x1)))
      }
      const contentWidthH = hxPos[hx.length - 1]! + hx[hx.length - 1]!.width
      const titlePadH = (legend as { titlePadding?: number }).titlePadding ?? 5
      const titleRowH = titleStr.length > 0 ? Math.abs(titleFsS) + titlePadH : 0
      const boxW = Math.ceil(Math.max(contentWidthH, titleWidth) + 2 * legendPad)
      const boxH = Math.ceil(titleRowH + rowExtentH + 2 * legendPad)
      const bgX = borderColor != null ? 0.5 : 0
      const bgY = borderColor != null ? 0.5 : 0
      const cr = (legend as { cornerRadius?: number }).cornerRadius
      const fillColor = (legend as { fillColor?: string }).fillColor
      const items: SceneItem[] = []
      items.push({ path: cr != null && cr > 0 ? roundedRectPath(bgX, bgY, boxW, boxH, Math.min(cr, boxW / 2, boxH / 2)) : `M${bgX},${bgY}h${boxW}v${boxH}h-${boxW}Z`, x: 0, y: 0, ...(fillColor != null ? { fill: fillColor } : {}), ...(borderColor != null ? { stroke: String(borderColor) } : {}) })
      const titleBaselineH = (legend as { titleBaseline?: string }).titleBaseline ?? 'top'
      const titleYOffH = titleBaselineH === 'middle' ? Math.round(0.3 * titleFsS)
        : titleBaselineH === 'bottom' ? Math.round(-0.21 * titleFsS) : Math.round(0.79 * titleFsS)
      if (titleStr.length > 0) {
        const limit = (legend as { titleLimit?: number }).titleLimit
        items.push({ text: titleStr, x: titleXBase + legendPad, y: titleYOffH + legendPad, align: titleAlignS as SceneItem['align'], fill: titleColorS, fontSize: titleFsS, ...(limit != null ? { limit } : {}), ...(titleOpacityS != null ? { fillOpacity: titleOpacityS } : {}) })
      }
      const symStrokeH = symStrokeColor ?? (strokeColor != null ? String(strokeColor) : '#888')
      const symOpacityH = opacity ?? 0.7
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!
        const entryX = legendPad + hxPos[i]!
        const entryY = legendPad + titleRowH + (rowExtentH - b[i]!.y2) / 2
        items.push({ path: `M0,0h${hx[i]!.width}v${b[i]!.y2}h-${hx[i]!.width}Z`, x: entryX, y: entryY })
        const sx = entryX + hx[i]!.sx
        const sy = entryY + e.sizeD / 2
        if (symbolType === 'square') {
          const w = Math.sqrt(e.size)
          items.push({ path: `M${-w / 2},${-w / 2}h${w}v${w}h${-w}Z`, x: sx, y: sy, stroke: symStrokeH, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity: symOpacityH })
        } else if (symbolType !== 'circle') {
          items.push({ path: symbolPath(symbolType, e.r), x: sx, y: sy, stroke: symStrokeH, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity: symOpacityH })
        } else {
          items.push({ shape: 'circle', radius: e.r, x: sx, y: sy, stroke: symStrokeH, strokeWidth, ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}), opacity: symOpacityH })
        }
        const limit = (legend as { labelLimit?: number }).labelLimit
        items.push({ text: e.label, x: entryX + hx[i]!.lx, y: labelBaselineS != null ? sy : sy + Math.round(0.3 * fontSize), align: labelAlignS as SceneItem['align'], ...(labelBaselineS != null ? { baseline: labelBaselineS as SceneItem['baseline'] } : {}), fill: labelColorS, fontSize, ...(limit != null ? { limit } : {}), ...(labelOpacityS != null ? { fillOpacity: labelOpacityS } : {}) })
      }
      const outH: SceneGroup = { marktype: 'group', role: 'legend', x: 0, y: 0, width: boxW, height: boxH, items }
      ;(outH as unknown as Record<string, unknown>)._borderStroke = borderColor != null
      return outH
    }

    const items: SceneItem[] = []
    const legendCornerRadius = (legend as { cornerRadius?: number }).cornerRadius
    const legendFillColor = (legend as { fillColor?: string }).fillColor
    const bgX = borderColor != null ? 0.5 : 0
    const bgY = borderColor != null ? 0.5 : 0
    const bgPath = legendCornerRadius != null && legendCornerRadius > 0
      ? roundedRectPath(bgX, bgY, boxW, boxH, Math.min(legendCornerRadius, boxW / 2, boxH / 2))
      : `M${bgX},${bgY}h${boxW}v${boxH}h-${boxW}Z`
    items.push({ path: bgPath, x: 0, y: 0, ...(legendFillColor != null ? { fill: legendFillColor } : {}), ...(borderColor != null ? { stroke: String(borderColor) } : {}) })
    const titleBaselineS = (legend as { titleBaseline?: string }).titleBaseline ?? 'top'
    const titleLimitS = (legend as { titleLimit?: number }).titleLimit
    const titleYOff = titleBaselineS === 'middle' ? Math.round(0.3 * titleFsS)
      : titleBaselineS === 'bottom' ? Math.round(-0.21 * titleFsS)
      : Math.round(0.79 * titleFsS)
    const titleTextX = titleOrientS === 'left'
      ? legendPad
      : titleOrientS === 'right'
        ? legendPad + entryWidth + 5
        : titleXBase + legendPad + contentShiftS
    const titleTextY = titleOrientS === 'bottom'
      ? Math.round(scopesHeight + 0.79 * titleFsS + titlePadS) + legendPad
      : sideTitle
        ? Math.floor(bgHeight / 2) + 3 + legendPad
        : titleYOff + legendPad
    items.push({ text: titleStr, x: titleTextX, y: titleTextY, align: (sideTitle ? 'left' : titleAlignS) as SceneItem['align'], fill: titleColorS, fontSize: titleFsS, ...(titleLimitS != null ? { limit: titleLimitS } : {}), ...(titleOpacityS != null ? { fillOpacity: titleOpacityS } : {}) })
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      const ey = entryYBaseS + legendPad + yPos[i]!
      const sy = ey + (hasClipS ? (clipHeightS as number) / 2 : e.sizeD / 2)
      const entryX = entryXShiftS + legendPad + contentShiftS
      items.push({ path: `M0,0h${entryWidth}v${b[i]!.y2}h-${entryWidth}Z`, x: entryX, y: ey })
      // Vega always renders size legend symbols with a default stroke (#888)
      // and opacity (0.7), even when the legend encode doesn't specify them.
      const symStroke = symStrokeColor ?? (strokeColor != null ? String(strokeColor) : '#888')
      const symOpacity = opacity ?? 0.7
      if (symbolType === 'square') {
        const w = Math.sqrt(e.size)
        items.push({
          path: `M${-w / 2},${-w / 2}h${w}v${w}h${-w}Z`,
          x: symbolX + entryXShiftS + legendPad + contentShiftS,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}),
          opacity: symOpacity,
        } as SceneItem)
      } else if (symbolType !== 'circle') {
        items.push({
          path: symbolPath(symbolType, e.r),
          x: symbolX + entryXShiftS + legendPad + contentShiftS,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}),
          opacity: symOpacity,
        } as SceneItem)
      } else if (hasClipS) {
        // a clipped circle must be a path item so the renderer can hang the
        // clip-path on it (vega defs a rect over the entry)
        items.push({
          path: symbolPath('circle', e.r),
          x: symbolX + entryXShiftS + legendPad + contentShiftS,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}),
          opacity: symOpacity,
        } as SceneItem)
      } else {
        items.push({
          shape: 'circle',
          radius: e.r,
          x: symbolX + entryXShiftS + legendPad + contentShiftS,
          y: sy,
          stroke: symStroke,
          strokeWidth,
          ...(sizeSymbolDash ? { strokeDash: sizeSymbolDash } : {}),
          opacity: symOpacity,
        } as SceneItem)
      }
      if (hasClipS && !ctx.rawGuides) {
        ;(items[items.length - 1] as Record<string, unknown>)._clip = { w: entryWidth, h: b[i]!.y2 }
      }
      items.push({ text: e.label, x: labelX + entryXShiftS + legendPad + contentShiftS, y: labelBaselineS != null ? sy : sy + Math.round(0.3 * fontSize), align: labelAlignS as SceneItem['align'], ...(labelBaselineS != null ? { baseline: labelBaselineS as SceneItem['baseline'] } : {}), fill: labelColorS, fontSize, ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}), ...(labelOpacityS != null ? { fillOpacity: labelOpacityS } : {}) })
    }
    const out: SceneGroup = { marktype: 'group', role: 'legend', x: 0, y: 0, width: boxW, height: boxH, items }
    ;(out as unknown as Record<string, unknown>)._borderStroke = borderColor != null
    return out
  }

  // --- Band legend (quantile / quantize / threshold) ---
  // Vega renders these scale types as a "band" legend: rectangular color
  // swatches for each range value with text labels at quantile breakpoints.
  if ((scaleType === 'quantile' || scaleType === 'quantize' || scaleType === 'threshold') && orient === 'right' || orient === undefined) {
    const rangeVals = scale.range() as string[]
    const bandCount = rangeVals.length
    if (bandCount > 0 && orient === 'right' || orient === undefined) {
      const SWATCH_W = 16
      const SWATCH_H = Math.max(25, 200 / bandCount)
      const sortedDomain = [...rawDomain].filter((v): v is number => typeof v === 'number').sort((a, b) => a - b)
      const isThreshold = scaleType === 'threshold'
      // Breakpoint label strings — the legend width is derived from the widest
      // label (vega measures each label via textMetrics; no char heuristics).
      const rawBreaks: Array<number | undefined> = []
      for (let i = 1; i < bandCount; i++) {
        let rawVal: number | undefined
        if ((scaleType === 'quantize' || scaleType === 'quantile') && sortedDomain.length >= 2) {
          // Quantize/quantile breakpoints are evenly spaced across the domain extent
          const d0 = sortedDomain[0]!
          const d1 = sortedDomain[sortedDomain.length - 1]!
          rawVal = d0 + (d1 - d0) * i / bandCount
        } else {
          const nVals = sortedDomain.length
          const idx = Math.ceil(i * nVals / bandCount) - 1
          rawVal = idx >= 0 && idx < nVals ? sortedDomain[idx] : undefined
        }
        rawBreaks.push(rawVal)
      }
      const quantileFractional = rawBreaks.some((v) => v !== undefined && !Number.isInteger(v))
      const bandLabels: string[] = rawBreaks.map((rawVal) => rawVal === undefined
        ? ''
        : isThreshold
          ? String(rawVal)
          : scaleType === 'quantile'
            ? rawVal.toFixed(quantileFractional ? 2 : 1)
            : (scaleType === 'quantize' ? String(Math.round(rawVal * 1e10) / 1e10) : (Number.isInteger(rawVal) ? rawVal + '.0' : String(rawVal))))
      const maxLabelW = bandLabels.reduce((m: number, s: string) => Math.max(m, nominalTextWidth(s, 10)), 0)
      const outerWidth = Math.ceil(18 + maxLabelW)
      const titleStrB = String(legend.title ?? '')
      const titleH = titleStrB.length > 0 ? 16 : 0
      const bgH = titleH + bandCount * SWATCH_H
      const items: SceneItem[] = []
      // Background box
      items.push({ path: `M0,0h${outerWidth}v${bgH}h-${outerWidth}Z`, x: 0, y: 0 })
      if (titleStrB) items.push({ text: titleStrB, x: 0, y: 9, align: 'left', fill: '#000', fontSize: 11, fontWeight: 'bold' })
      // Band swatches (top-to-bottom: last range color first)
      for (let i = 0; i < bandCount; i++) {
        const y = titleH + (bandCount - 1 - i) * SWATCH_H
        items.push({ path: `M0,${y}h${SWATCH_W}v${SWATCH_H}h-${SWATCH_W}Z`, x: 0, y: 0, fill: String(rangeVals[i]), stroke: '#ddd', strokeWidth: 0, opacity: 1 })
      }
      // Labels at breakpoints (skip the first which is empty)
      for (let i = 1; i < bandCount; i++) {
        const y = titleH + (bandCount - i) * SWATCH_H + 3
        items.push({ text: bandLabels[i - 1]!, x: 18, y, align: 'left', fill: '#000', fontSize: 10 })
      }
      // Empty label at the bottom
      items.push({ text: '', x: 18, y: titleH + bandCount * SWATCH_H - 2, align: 'left', fill: '#000' })
      return { marktype: 'group', role: 'legend', x: 0, y: 0, width: outerWidth, height: bgH, items }
    }
  }

  // --- Symbol legend (discrete) ---
  const n = domain.length


  // --- 'bottom' ---
  // Horizontal flow (Vega-Lite emits `direction: horizontal` for bottom
  // legends with a title). Per-entry step = entry content width + 12px gap.
  // Everything else falls through to the orient-independent symbol block
  // below, whose 13px step and title row match the oracle for every orient
  // (the grid anchor does the positioning) — including bottom verticals.
  if (orient === 'bottom' && legend.direction === 'horizontal') {
    // vega grid layout (vega-view-transforms layout/grid.js): each entry's
    // scope width = symbol slot (16) + its own measured label width; the
    // column step = columnPadding(10) + symbol overhang(ceil of the symbol
    // bound poking left of the entry) + ceil(entryWidth). The legend box is
    // ceil(last entry x + last entry bound). The symbol box follows the
    // channel/symbolType: a fill legend paints a square (11px step), a stroke
    // legend an inflated circle (14px step).
    const isFill = !!legend.fill
    const colorProp = isFill ? 'fill' : 'stroke'
    const symType = legend.symbolType ?? 'circle'
    const boxHeight = isFill ? 11 : 14
    const entryWidths = domain.map((v) => 16 + nominalTextWidth(String(v), 10))
    const symX = 6
    const symR = 5
    const overhang = isFill ? 0 : Math.ceil(Math.max(0, symR + 3 - symX))
    const stepBase = 10 + overhang
    const xs: number[] = []
    let x = 0
    for (let i = 0; i < n; i++) {
      xs.push(x)
      x += stepBase + Math.ceil(entryWidths[i]!)
    }
    const bgW = Math.ceil(xs[n - 1]! + entryWidths[n - 1]!)
    const symOpacityEnc = (legend as unknown as { encode?: { symbols?: { update?: { opacity?: EncodeValue } } } }).encode?.symbols?.update?.opacity
    const symOpacity = symOpacityEnc && typeof symOpacityEnc === 'object' && 'value' in symOpacityEnc
      ? Number((symOpacityEnc as { value?: unknown }).value)
      : isFill ? 1 : 0.7
    const symStrokeColor = (legend as unknown as { encode?: { symbols?: { update?: { stroke?: EncodeValue } } } }).encode?.symbols?.update?.stroke
    const symStroke = symStrokeColor && typeof symStrokeColor === 'object' && 'value' in symStrokeColor
      ? String((symStrokeColor as { value?: unknown }).value)
      : (legend as { symbolStrokeColor?: string }).symbolStrokeColor
    const symSwi = (legend as { symbolStrokeWidth?: number }).symbolStrokeWidth ?? 1.5
    const bgH = 16 + boxHeight
    const items: SceneItem[] = []
    items.push({ path: `M0,0h${bgW}v${bgH}h-${bgW}Z`, x: 0, y: 0 })
    items.push({ text: String(legend.title ?? ''), x: 0, y: 9, align: 'left', fill: '#000', fontSize: 11, fontWeight: 'bold' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const sx = xs[i]!
      items.push({ path: `M0,0h${entryWidths[i]}v${boxHeight}h-${entryWidths[i]}Z`, x: sx, y: 16 })
      const paint = colorProp === 'fill'
        ? { fill: String(scale(value)), ...(symStroke != null ? { stroke: symStroke } : {}) }
        : { stroke: String(scale(value)) }
      const symPath = symType === 'square' ? 'M-5,-5h10v10h-10Z' : symbolPath(String(symType), symR)
      items.push({ path: symPath, x: sx + symX, y: 16 + symX, strokeWidth: symSwi, ...(Number.isFinite(symOpacity) ? { opacity: symOpacity } : {}), ...paint })
      items.push({ text: String(value), x: sx + 16, y: 25, align: 'left', fill: '#000', fontSize: 10 })
    }
    return { marktype: 'group', role: 'legend', x: 0, y: 0, width: bgW, height: bgH, items }
  }

  // --- bottom vertical stroke legends (calibrated: line-grid-dash) ---
  // Entries stack at 18px row step, each row 14px tall with symbol at (6,6)
  // and label at (16,9). Group sits at height+24.
  if (orient === 'bottom' && !legend.fill) {
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
      items.push({ text: String(domain[i]), x: 16, y: ey + 9, align: 'left', fill: '#000', fontSize: 10 })
    }
    return { marktype: 'group', role: 'legend', x: 0, y: 0, width: entryWidth, height: n * rowStep - 4, items }
  }

  // --- corner orents (top-left / top-right / bottom-left / bottom-right) ---
  // Discrete symbol legends laid out as a row-major grid honoring `columns` and
  // `direction`. Geometry calibrated to the oracle for a fill/square legend with
  // columns:2 (entryWidth=16+8*maxLabelLen, columnPadding=10, rowPadding=2,
  // fill boxHeight=11/rowStep=13; group at (offset, offset) from the corner).
  if (/^(top|bottom)-(left|right)$/.test(orient) && !legend.size && !legend.gradientLength && legend.columns != null) {
    const colorProp = legend.fill ? 'fill' : 'stroke'
    const symType = legend.symbolType ?? 'circle'
    const isStrokeLegend = !legend.fill
    const boxHeight = isStrokeLegend ? 14 : 11
    const rowStep = isStrokeLegend ? 18 : 13
    const columnPadding = 10, rowPadding = 2
    // Per-entry measured widths; vega's grid layout (layout/grid.js) takes a
    // per-COLUMN max (ceil'd) and accumulates columnPadding + the symbol-bound
    // overhang (stroke-inflated symbols poke left of the entry by 2px).
    const entryWs = domain.map((v) => 16 + nominalTextWidth(String(v), 10))
    const cols = legend.direction === 'vertical' ? 1 : Math.min(legend.columns ?? n, n)
    const rows = Math.ceil(n / cols)
    const colW: number[] = new Array(cols).fill(0)
    for (let i = 0; i < n; i++) colW[i % cols] = Math.max(colW[i % cols]!, entryWs[i]!)
    const symOverhang = isStrokeLegend ? Math.ceil(5 + 3 - 6) : 0
    const colX: number[] = []
    let acc = 0
    for (let c = 0; c < cols; c++) {
      colX.push(acc)
      acc += columnPadding + symOverhang + Math.ceil(colW[c]!)
    }
    const titleStr = String(legend.title ?? '')
    const titleRow = titleStr ? 16 : 0
    const titleWidth = titleStr ? nominalTextWidth(titleStr, 11, 'bold') : 0
    const gridW = Math.max(Math.ceil(colX[cols - 1]! + colW[cols - 1]!), titleWidth)
    const gridH = titleRow + rows * boxHeight + (rows - 1) * rowPadding
    const outerWidth = gridW
    const items: SceneItem[] = []
    items.push({ path: `M0,0h${outerWidth}v${gridH}h-${outerWidth}Z`, x: 0, y: 0 })
    if (titleStr) items.push({ text: titleStr, x: 0, y: 9, align: 'left', fill: '#000', fontSize: 11, fontWeight: 'bold' })
    for (let i = 0; i < n; i++) {
      const value = domain[i]
      const ex = colX[i % cols]!
      const ey = titleRow + Math.floor(i / cols) * rowStep
      items.push({ path: `M0,0h${colW[i % cols]}v${boxHeight}h-${colW[i % cols]}Z`, x: ex, y: ey })
      if (symType === 'square') {
        items.push(colorProp === 'fill'
          ? { path: 'M-5,-5h10v10h-10Z', x: ex + 6, y: ey + 6, fill: String(scale(value)), strokeWidth: 1.5 }
          : { path: 'M-5,-5h10v10h-10Z', x: ex + 6, y: ey + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
      } else {
        items.push(colorProp === 'fill'
          ? { shape: 'circle', radius: 5, x: ex + 6, y: ey + 6, fill: String(scale(value)), strokeWidth: 1.5 }
          : { shape: 'circle', radius: 5, x: ex + 6, y: ey + 6, stroke: String(scale(value)), strokeWidth: 1.5 })
      }
      items.push({ text: String(value), x: ex + 16, y: ey + 9, align: 'left', fill: '#000', fontSize: 10 })
    }
    return { marktype: 'group', role: 'legend', x: 0, y: 0, width: outerWidth, height: gridH, items }
  }

  // --- Symbol legend geometry (orient-independent: vertical entries; the
  // grid anchor in buildAxisAndLegend positions every orient) ---
  {
    // Detect fill vs stroke legend channel and legend encode style.
    // Fill legends (e.g. arc-pie): fill=color, no stroke, opacity=1, step=13, box=11
    // Stroke legends (e.g. legend-scatter): stroke=color, no fill, opacity=0.7, step=18, box=14
    // A fill legend whose symbols carry a stroke encode (e.g. filled point with
    // stroke="#333") uses the stroke-legend dimensions because the stroke widens
    // the symbol bounding box.
    const colorProp = legend.fill ? 'fill' : 'stroke'
    const isStrokeLegend = !legend.fill
    const symType = legend.symbolType ?? 'circle'
    // A strokeWidth legend paints a fixed-color symbol whose width comes from
    // the scale; the fill/stroke channels are both absent.
    const isStrokeWidthLegend = legend.strokeWidth != null && legend.fill == null && legend.stroke == null && legend.shape == null
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
      : (legend as { symbolStrokeColor?: string }).symbolStrokeColor

    // --- vega's entry pipeline, ported end to end: LegendEntries → the
    // symbol/label encodes → the scenegraph Bound pass → the entry group's
    // gridLayout → legendEntryLayout / legendGroupLayout / legendLayout.
    // Everything downstream reads MEASURED per-entry bounds. The label bound
    // comes from boundText (align/limit/fontSize aware — negative font sizes
    // flip through Bounds.set's normalization), the symbol bound from the
    // traced path (a negative symbolSize makes the radius NaN: the path
    // degenerates to its moveTo, the item bounds stay at their ±MAX_VALUE
    // sentinels, and sentinel unions no-op), and a truthy clipHeight unions
    // the entry group's own (0,0)/(0,clipHeight) corner points into the
    // entry bound.

    // Symbol opacity from the legend's `symbols.update.opacity` encode
    // (vega-lite emits 0.7 for colored point/circle legends, absent otherwise).
    // Stroke-type legends (horizontal lines) use opacity=1 by default.
    const symOpacityEnc = (legend as unknown as { encode?: { symbols?: { update?: { opacity?: EncodeValue } } } }).encode?.symbols?.update?.opacity
    const symbolOpacity = symOpacityEnc && typeof symOpacityEnc === 'object' && 'value' in symOpacityEnc
      ? (symOpacityEnc as { value?: unknown }).value
      : (legend as { symbolOpacity?: number }).symbolOpacity

    const symFillOpacityEnc = (legend as unknown as { encode?: { symbols?: { update?: { fillOpacity?: EncodeValue } } } }).encode?.symbols?.update?.fillOpacity
    const symFillOpacityVal = symFillOpacityEnc && typeof symFillOpacityEnc === 'object' && 'value' in symFillOpacityEnc
      ? (symFillOpacityEnc as { value?: unknown }).value
      : undefined
    const symbolSizeRaw = (legend as { symbolSize?: number }).symbolSize ?? 100
    const symSwEnc = (legend as unknown as { encode?: { symbols?: { update?: { strokeWidth?: EncodeValue } } } }).encode?.symbols?.update?.strokeWidth
    const symSwEncVal = symSwEnc && typeof symSwEnc === 'object' && 'value' in symSwEnc ? (symSwEnc as { value?: unknown }).value : undefined
    const symSwP = (typeof symSwEncVal === 'number' ? symSwEncVal : undefined)
      ?? (legend as { symbolStrokeWidth?: number }).symbolStrokeWidth ?? 1.5
    // A mark-level dash (config.arc.strokeDash / markDef.strokeDash) arrives as
    // a symbols.update.strokeDash encode; an explicit legend symbolDash wins.
    const symDashEnc = (legend as unknown as { encode?: { symbols?: { update?: { strokeDash?: EncodeValue } } } }).encode?.symbols?.update?.strokeDash
    const symDashEncVal = symDashEnc && typeof symDashEnc === 'object' && 'value' in symDashEnc ? (symDashEnc as { value?: unknown }).value : undefined
    const symbolDash = (legend as { symbolDash?: number[] }).symbolDash
      ?? (Array.isArray(symDashEncVal) ? symDashEncVal as number[] : undefined)
    const labelFs = (legend as { labelFontSize?: number }).labelFontSize ?? 10
    // symbol path radius: sqrt of the symbol size encode (NaN for negative
    // sizes — the circle path degenerates to its moveTo and bounds to nothing)
    const symR = Math.sqrt(symbolSizeRaw) / 2

    // LegendEntries (vega-encode): symbolLimit caps the entry list —
    // values.slice(0, limit-1) plus a trailing '…N entries' entry whose value
    // is values[items.length]. The offset datum = max over the SLICED items
    // of the size expression (0 when the slice is empty — the ellipsis-only
    // legend collapses to offset 0); the size datum = the size expression
    // (constant here — the size channel routes through the same expression).
    // A negative symbolSize makes the expression NaN (sqrt of a negative),
    // which flows through the layout as NaN item positions: vega's `x || 0`
    // anchor coercion renders them at the origin.
    const limitRaw = (legend as { symbolLimit?: number }).symbolLimit
    const limit = limitRaw == null ? NaN : +limitRaw
    const limitHits = !!(limit && domain.length > limit)
    const entryValues = limitHits ? domain.slice(0, limit - 1) : domain
    // legend.js sizeExpression: max(ceil(sqrt(size)+strokeWidth), fontSize).
    // A strokeWidth channel resolves its scale per entry, so the expression
    // (and thus the row height) varies: 10+scale(v), 10+lots of values.
    const entrySizeD = (v: unknown): number =>
      Math.max(Math.ceil(Math.sqrt(symbolSizeRaw) + (isStrokeWidthLegend ? Number(scale(v)) : symSwP)), labelFs)
    const offsetDatum = entryValues.length ? Math.max(0, ...entryValues.map(entrySizeD)) : 0
    const entries = entryValues.map((v: unknown) => ({ value: v, label: legendLabel(v), sizeD: entrySizeD(v) }))
    if (limitHits) {
      // vega's LegendEntries gives the ellipsis entry its OWN size expression
      // (values[items.length]); the shared offset stays the max over the
      // sliced (possibly empty) items.
      const ev = domain[entryValues.length]
      entries.push({ value: ev, label: `…${domain.length - entryValues.length} entries`, sizeD: entrySizeD(ev) })
    }
    const n = entries.length

    // clipHeight: a truthy value moves the symbol/label y encode to
    // clipHeight/2 (from the per-entry size datum), carries height=clipHeight
    // into the entry bound (the noBound encode switches off), and clips each
    // entry's symbols with a clipPath over the laid-out entry rect.
    const clipHeightRaw = (legend as { clipHeight?: number }).clipHeight
    const hasClip = clipHeightRaw != null ? !!clipHeightRaw : false

    const labelOffset = (legend as { labelOffset?: number }).labelOffset ?? 4
    const symbolOffset = (legend as { symbolOffset?: number }).symbolOffset ?? 0
    const rowPadding = Math.max((legend as { rowPadding?: number }).rowPadding ?? 2, 0)
    const colPad = (legend as { columnPadding?: number }).columnPadding ?? 10
    const labelColor = (legend as { labelColor?: string }).labelColor ?? '#000'
    const labelOpacity = (legend as { labelOpacity?: number }).labelOpacity
    const labelFontWeight = (legend as { labelFontWeight?: string | number }).labelFontWeight
    const labelFontStyle = (legend as { labelFontStyle?: string }).labelFontStyle
    const labelFont = (legend as { labelFont?: string }).labelFont
    const titleFont = (legend as { titleFont?: string }).titleFont
    const titleColor = (legend as { titleColor?: string }).titleColor ?? '#000'
    const titleOpacity = (legend as { titleOpacity?: number }).titleOpacity
    const titleFs = (legend as { titleFontSize?: number }).titleFontSize ?? 11
    const titlePad = (legend as { titlePadding?: number }).titlePadding ?? 5
    const labelLimit = (legend as { labelLimit?: number }).labelLimit ?? 160
    const labelAlign = (legend as { labelAlign?: string }).labelAlign ?? 'left'
    const lblBaseline = (legend as { labelBaseline?: string }).labelBaseline ?? 'middle'
    const titleStr = String(legend.title ?? '')
    // vega legendLayout: w = ceil(bounds + 2*padding); the inner padding
    // shifts the whole content.
    const legendPad = (legend as { padding?: number }).padding ?? 0

    // columns truthiness drives the x encode signal `(columns) ? datum.offset
    // : datum.size` — spec.columns 0 and horizontal direction (entryColumns
    // falls back to +isVertical = 0) read the size datum instead of the
    // offset datum.
    const direction = (legend as { direction?: string }).direction ?? 'vertical'
    const specColumns = (legend as { columns?: number }).columns
    const colsFlag = specColumns != null ? specColumns : direction === 'vertical' ? 1 : 0
    const colsTruthy = !!colsFlag

    // Entry columns (vega gridLayout: `ncols = opt.columns || groups.length`):
    // unspecified → one column; 0 → every entry is its own column (falsy
    // columns falls through to the group count).
    // A non-integer/negative `columns` makes vega's legend gridLayout throw
    // (invalid array length) — the layout aborts and the legend stays at its
    // raw (0,0) position with the base one-column content (raw-guide mode
    // skips the placement).
    const ncols = direction === 'horizontal'
      ? n
      : specColumns == null ? 1
        : specColumns === 0 ? n
          : specColumns > 0 ? (Number.isInteger(specColumns) ? specColumns : 1)
            : 1
    // gridLayout consumes the entries in their row/column sort order: a
    // vertical legend sorts by (row, index) with row = index % nrows, so the
    // cells fill COLUMN-major (entry i → column ⌊i/nrows⌋, row i % nrows);
    // horizontal fills row-major.
    const colMajor = direction !== 'horizontal' && Number.isInteger(specColumns) && (specColumns as number) >= 1
    const nrowsMajor = Math.max(1, Math.ceil(n / ncols))
    const colOf = (i: number): number => (colMajor ? ~~(i / nrowsMajor) : i % ncols)
    const rowOf = (i: number): number => (colMajor ? i % nrowsMajor : ~~(i / ncols))

    // --- per-entry encoded positions and measured bounds (the Bound pass) ---
    // symbol x = (columns ? offset : size)/2 + symbolOffset; label x =
    // (columns ? offset : size) + labelOffset (no halving); y = clipHeight/2
    // when clipped, else the size datum/2.
    const symDs: string[] = []
    const ebs: Bounds[] = []
    const yIs: number[] = []
    const xSymIs: number[] = []
    const xLblIs: number[] = []
    for (const e of entries) {
      const yI = hasClip ? (clipHeightRaw as number) / 2 : e.sizeD / 2
      const xSymI = (colsTruthy ? offsetDatum : e.sizeD) / 2 + symbolOffset
      const xLblI = (colsTruthy ? offsetDatum : e.sizeD) + symbolOffset + labelOffset
      yIs.push(yI); xSymIs.push(xSymI); xLblIs.push(xLblI)
      const symD = legend.shape
        ? symbolPath(String(scale(e.value)), 5)
        : symType === 'stroke'
          ? 'M-5,0L5,0'
          : symbolPath(symType, symR)
      symDs.push(symD)
      // symbol bound: traced path + stroke expansion (miter), translated by
      // the item position with vega's `|| 0` NaN coercion — NaN positions
      // leave the sentinel bounds untouched and the union no-ops. The stroke
      // follows the channel: a fill legend strokes only via symbolStrokeColor.
      const entrySw = isStrokeWidthLegend ? Number(scale(e.value)) : symSwP
      const symItem = {
        path: symD, x: xSymI, y: yI, strokeWidth: entrySw, opacity: symbolOpacity,
        stroke: isStrokeWidthLegend
          ? String(legendStrokeColor ?? '#4c78a8')
          : legend.shape
            ? String(legendStrokeColor ?? '#888')
            : symType === 'stroke'
              ? (colorProp === 'stroke' ? String(scale(e.value)) : undefined)
              : (colorProp === 'fill' ? (legendStrokeColor != null ? String(legendStrokeColor) : undefined) : String(scale(e.value))),
      } as unknown as SceneItem
      const symB = boundLeaf(new Bounds(), symItem)
      // label bound: boundText (truncation via limit, align-aware x1, negative
      // fontSize flips through set())
      const lblB = boundText(new Bounds(), {
        text: e.label, x: xLblI, y: yI, align: labelAlign, baseline: lblBaseline,
        fontSize: labelFs, limit: labelLimit,
        ...(labelFont != null ? { font: labelFont } : {}),
        ...(labelFontWeight != null ? { fontWeight: labelFontWeight } : {}),
        ...(labelFontStyle != null ? { fontStyle: labelFontStyle } : {}),
      } as unknown as SceneItem)
      const eb = new Bounds().union(symB).union(lblB)
      // entry group bound: (clip || width || height) && !noBound adds the
      // corner points (0,0) and (width, height) — the width encodes 0
      if (hasClip) eb.add(0, 0).add(0, clipHeightRaw as number)
      ebs.push(eb)
    }

    // grid extents (gridLayout): columns/rows advance by the CEILed extents,
    // offsetValue lifts cells whose bound pokes above/left of 0; the entry
    // background rect uses the FLOAT column width and the entry's own bound
    // height (legendEntryLayout: width = max bounds.x2 per column, height =
    // bounds.y2 - y).
    const colW = Array<number>(ncols).fill(0)
    const colAdv = Array<number>(ncols).fill(0)
    const nrows = Math.max(1, Math.ceil(n / ncols))
    const rowExtent = Array<number>(nrows).fill(0)
    // gridLayout derives each cell's offset from ITS OWN bound (pad + the
    // ceil of a negative x1/y1), not from a global maximum: a strokeWidth
    // legend's entry bounds grow row by row, so a single offset over-shifts
    // every row after the first.
    const colOffset = Array<number>(ncols).fill(colPad)
    const rowOffset = Array<number>(nrows).fill(rowPadding)
    entries.forEach((_e, i) => {
      const eb = ebs[i]!
      if (eb.empty()) return
      const c = colOf(i)
      const r = rowOf(i)
      colW[c] = Math.max(colW[c]!, eb.x2)
      colAdv[c] = Math.max(colAdv[c]!, Math.ceil(eb.x2))
      rowExtent[r] = Math.max(rowExtent[r]!, Math.ceil(eb.y2))
      colOffset[c] = Math.max(colOffset[c]!, colPad + (eb.x1 < 0 ? Math.ceil(-eb.x1) : 0))
      rowOffset[r] = Math.max(rowOffset[r]!, rowPadding + (eb.y1 < 0 ? Math.ceil(-eb.y1) : 0))
    })
    const colX: number[] = [0]
    for (let c = 1; c < ncols; c++) colX.push(colX[c - 1]! + colAdv[c - 1]! + colOffset[c]!)
    const rowY: number[] = [0]
    for (let r = 1; r < nrows; r++) rowY.push(rowY[r - 1]! + rowExtent[r - 1]! + rowOffset[r]!)
    // vega legendTitleOffset reads the (shifted) entry container bounds:
    // s = e.bounds.x2/y2 − item.padding — the max grid-positioned extent.
    let sX = 0
    let sY = 0
    entries.forEach((_e, i) => {
      const eb = ebs[i]!
      if (eb.empty()) return
      sX = Math.max(sX, (colX[colOf(i)] ?? 0) + eb.x2)
      sY = Math.max(sY, (rowY[rowOf(i)] ?? 0) + eb.y2)
    })

    // vega legendGroupLayout + legendTitleOffset: the title sits relative to
    // the entry block per titleOrient; top/right titles anchor along the
    // entry x extent (sX = entry bound x2 − pad), left/right/bottom along the
    // y extent (sY = entry bound y2 − pad); titleAlign changes the text
    // anchor, and a title whose bound pokes left of the padding shifts the
    // whole legend right by the overhang.
    const titleOrient = (legend as { titleOrient?: string }).titleOrient ?? 'top'
    const specTitleAnchor = (legend as { titleAnchor?: string }).titleAnchor
    const titleAnchor = specTitleAnchor ?? ((titleOrient === 'left' || titleOrient === 'right') ? 'middle' : 'start')
    const specTitleAlign = (legend as { titleAlign?: string }).titleAlign
    const anchorOffX = titleAnchor === 'end' ? Math.round(sX) : titleAnchor === 'middle' ? Math.round(sX / 2) : 0
    const anchorOffY = titleAnchor === 'end' ? Math.round(sY) : titleAnchor === 'middle' ? Math.round(sY / 2) : 0
    let titleX = legendPad
    let titleY = legendPad
    let tBaseline: 'top' | 'middle' | 'bottom' = 'top'
    if (titleOrient === 'left') {
      tBaseline = titleAnchor === 'end' ? 'bottom' : titleAnchor === 'middle' ? 'middle' : 'top'
      titleY = legendPad + anchorOffY
    } else if (titleOrient === 'right') {
      tBaseline = titleAnchor === 'end' ? 'bottom' : titleAnchor === 'middle' ? 'middle' : 'top'
      titleX = legendPad + Math.round(sX) + titlePad
      titleY = legendPad + anchorOffY
    } else if (titleOrient === 'bottom') {
      titleY = legendPad + Math.round(sY) + titlePad
      titleX = legendPad + anchorOffX
    } else {
      titleX = legendPad + anchorOffX
    }
    if (ctx.rawGuides) { titleX = 0; titleY = 0 }
    // default align (vega exprAlign): left/right titleOrient → 'left' (non-
    // vgrad); otherwise anchor-derived start→left, end→right, middle→center.
    const tAlign = (specTitleAlign ?? (titleOrient === 'left' || titleOrient === 'right'
      ? 'left'
      : titleAnchor === 'end' ? 'right' : titleAnchor === 'middle' ? 'center' : 'left')) as 'left' | 'center' | 'right'
    const titleLimit = (legend as { titleLimit?: number }).titleLimit
    const titleBaseline = (legend as { titleBaseline?: string }).titleBaseline
    // vega's 'guide-title' style defaults fontWeight to bold — the title bound
    // must measure with the same font the renderer emits.
    const titleWeight = (legend as { titleFontWeight?: string | number }).titleFontWeight ?? 'bold'
    // title bound (legendGroupLayout reads title.bounds: the Bound-pass text
    // bound at the title's pre-shift position — height drives the entry row,
    // width the left-title shift, x1 the overhang)
    const tBound = titleStr
      ? boundText(new Bounds(), {
          x: titleX, y: titleY, text: titleStr, align: tAlign,
          baseline: (titleBaseline ?? tBaseline) as SceneItem['baseline'],
          fontSize: titleFs, fontWeight: titleWeight, ...(titleFont != null ? { font: titleFont } : {}), ...(titleLimit != null ? { limit: titleLimit } : {}),
        } as unknown as SceneItem)
      : new Bounds().set(0, 0, 0, 0)
    // container shifts (legendGroupLayout): top titles push the entries down
    // by the title bound height + padding; left titles push them right by
    // ceil(title bound width) + padding.
    const titleRow = titleStr && !ctx.rawGuides ? tBound.height() + titlePad : 0
    const leftShift = titleStr && !ctx.rawGuides && titleOrient === 'left' ? Math.ceil(tBound.width()) + titlePad : 0
    // overhang: a title bound poking left of the padding shifts the entries
    // AND the title right by the overhang (vega translates both)
    const shift = titleStr && !ctx.rawGuides ? Math.max(0, Math.round(legendPad - tBound.x1)) : 0
    // entry block base: top titles push entries down by the title row;
    // left titles push them right by title width + padding; right/bottom
    // leave the entries at the padding origin.
    // Raw-guide mode: the legendGroupLayout never ran — the entries keep
    // their encode positions (no title-row shift, no padding shifts).
    const entryX = ctx.rawGuides ? 0 : legendPad + shift + leftShift
    const entryBaseY = ctx.rawGuides ? 0 : titleOrient === 'top' && titleStr ? titleRow : 0

    // vega legendBounds: union the entry + title bounds, anchor x1/y1 at the
    // padding (clamping any overhang), then w/h = ceil(width + 2*padding).
    const lb = new Bounds()
    entries.forEach((_e, i) => {
      const eb = ebs[i]!
      if (eb.empty()) return
      const ex = ctx.rawGuides ? 0 : entryX + (colX[colOf(i)] ?? 0)
      const ey = ctx.rawGuides ? 0 : legendPad + entryBaseY + (rowY[rowOf(i)] ?? 0)
      lb.add(ex + eb.x1, ey + eb.y1).add(ex + eb.x2, ey + eb.y2)
    })
    if (titleStr && !ctx.rawGuides) {
      const tb = tBound.clone().translate(shift, 0)
      lb.add(tb.x1, tb.y1).add(tb.x2, tb.y2)
    }
    if (lb.empty()) {
      // empty legends anchor their upper-right corner at the padding
      lb.x2 = legendPad
      lb.y2 = legendPad
    }
    lb.x1 = legendPad
    lb.y1 = legendPad
    const bgW = Math.ceil(lb.width() + 2 * legendPad)
    const bgH = Math.ceil(lb.height() + 2 * legendPad)

    const items: SceneItem[] = []
    const legendCornerRadius = (legend as { cornerRadius?: number }).cornerRadius
    const legendFillColor = (legend as { fillColor?: string }).fillColor
    // The legend border stroke (legend.strokeColor): the border rect insets
    // half a pixel (crisp 1px stroke) and carries no explicit strokeWidth
    // (the renderer default 1 applies); vega's legendLayout boundStrokes the
    // outer rect, expanding the legend bounds by 1 on width and height.
    const legendBorderColor = (legend as { strokeColor?: string }).strokeColor
    // `strokeWidth` is a channel mapping when it names a scale; only a number
    // is the legend border width.
    const legendBorderWidthRaw = legend.strokeWidth
    const legendBorderWidth = typeof legendBorderWidthRaw === 'number' ? legendBorderWidthRaw : undefined
    const legendBorderDash = (legend as { strokeDash?: number[] }).strokeDash
    // cornerRadius > 0 renders the border as a rounded rect at full size
    // (vega's rectangle path with the corner radii); a border stroke insets
    // the path half a pixel (crisp 1px stroke) without changing the size.
    const bgX = legendBorderColor != null ? 0.5 : 0
    const bgY = legendBorderColor != null ? 0.5 : 0
    // Raw-guide mode: the legend item's size is a layout product — the
    // background stays a degenerate placeholder (vega drops it).
    const bgPath = ctx.rawGuides
      ? 'M0,0h0v0h0Z'
      : legendCornerRadius && legendCornerRadius > 0
      ? roundedRectPath(bgX, bgY, bgW, bgH, Math.min(legendCornerRadius, bgW / 2, bgH / 2))
      : legendBorderColor != null
        ? `M${bgX},${bgY}h${bgW}v${bgH}h-${bgW}Z`
        : `M0,0h${bgW}v${bgH}h-${bgW}Z`
    items.push({ path: bgPath, x: 0, y: 0, ...(legendFillColor != null ? { fill: legendFillColor } : {}), ...(legendBorderColor != null ? { stroke: String(legendBorderColor) } : {}), ...(legendBorderWidth != null ? { strokeWidth: legendBorderWidth } : {}), ...(legendBorderDash != null ? { strokeDash: legendBorderDash } : {}) })
    // vega's legendLayout boundStrokes the outer rect only for the legend's
    // own border stroke — symbol strokes must not expand the legend bounds.
    const borderStroke = legendBorderColor != null
    // vega's legend title item sits at (padding, padding) with baseline top;
    // the renderer bakes the baseline offset. titleBaseline overrides it.
    if (titleStr) items.push({ text: titleStr, x: titleX + shift, y: titleY, baseline: (titleBaseline ?? tBaseline) as 'top', align: tAlign, fill: titleColor, fontSize: titleFs, fontWeight: titleWeight, ...(titleFont != null ? { font: titleFont } : {}), ...(titleLimit != null ? { limit: titleLimit } : {}), ...(titleOpacity != null ? { fillOpacity: titleOpacity } : {}) })
    for (let i = 0; i < n; i++) {
      const e = entries[i]!
      const eb = ebs[i]!
      const value = e.value
      // Raw-guide mode: the entry rows never got their layout offsets — every
      // entry sits at its encode position (0), overlapping.
      const off = ctx.rawGuides ? 0 : entryBaseY + (rowY[rowOf(i)] ?? 0)
      const colOff = ctx.rawGuides ? 0 : (colX[colOf(i)] ?? 0)
      const colWc = colW[colOf(i)] ?? 0
      // The entry background: legendEntryLayout sizes it to the column's max
      // bound width (float) and the entry's own bound height (bounds.y2 − y).
      // Raw-guide mode: the entry backgrounds are bound-derived boxes — the
      // layout never ran, so they stay degenerate placeholders (vega drops
      // them).
      items.push({ path: ctx.rawGuides ? 'M0,0h0v0h0Z' : `M0,0h${colWc}v${eb.y2}h-${colWc}Z`, x: entryX + colOff, y: legendPad + off })
      // vega renders the legend entry symbol in the shape requested by the
      // legend's symbolType; the measured path (symDs) matches the painted one.
      // vega coerces the NaN encode positions to 0 (anchorPoint/translateItem
      // `|| 0`) INSIDE the entry frame — the container/grid shifts still apply,
      // so zero the NaN part here rather than poisoning the whole sum
      const symX = entryX + colOff + (xSymIs[i]! || 0)
      const symY = legendPad + off + (yIs[i]! || 0)
      if (legend.shape) {
        // Shape legend: the scale returns shape names; the stroke color comes
        // from the legend encode or defaults to #888 (vega's default symbol
        // stroke for shape legends). The encode opacity applies directly (not
        // the isStrokeLegend fallback): no encode → 1.
        const shapeName = String(scale(value))
        const shapeStroke = legendStrokeColor ?? '#888'
        const shapeOpacity = symOpacityEnc && typeof symOpacityEnc === 'object' && 'value' in symOpacityEnc
          ? ((symOpacityEnc as { value?: unknown }).value as number ?? 0.7)
          : 1
        items.push({ path: symDs[i]!, x: symX, y: symY, stroke: String(shapeStroke), strokeWidth: 1.5, opacity: shapeOpacity })
      } else if (isStrokeWidthLegend) {
        // symbol width (not color) varies per entry; fill stays transparent
        items.push({ path: symDs[i]!, x: symX, y: symY, stroke: String(legendStrokeColor ?? '#4c78a8'), strokeWidth: Number(scale(value)), ...(symbolDash ? { strokeDash: symbolDash } : {}), ...(symbolOpacity != null && Number.isFinite(symbolOpacity as number) ? { opacity: symbolOpacity as number } : {}) })
      } else if (symType === 'stroke') {
        // the shape is a line but the channel paints it: a fill legend fills
        // the symbol, a stroke legend strokes it
        const paint = colorProp === 'fill' ? { fill: String(scale(value)) } : { stroke: String(scale(value)) }
        items.push({ path: symDs[i]!, x: symX, y: symY, strokeWidth: 1.5, ...(symbolDash ? { strokeDash: symbolDash } : {}), ...paint })
      } else {
        if (colorProp === 'fill') {
          items.push({ path: symDs[i]!, x: symX, y: symY, fill: String(scale(value)), strokeWidth: symSwP, ...(symbolDash ? { strokeDash: symbolDash } : {}), ...(legendStrokeColor != null ? { stroke: String(legendStrokeColor) } : {}), ...(typeof symFillOpacityVal === 'number' ? { fillOpacity: symFillOpacityVal } : {}), ...(symbolOpacity != null ? { opacity: symbolOpacity as number } : {}) })
        } else {
          const strokeVal = legend.opacity != null
            ? String(legendStrokeColor ?? '#888')
            : String(scale(value))
          const opVal = legend.opacity != null ? Number(scale(value)) : symbolOpacity
          items.push({ path: symDs[i]!, x: symX, y: symY, stroke: strokeVal, strokeWidth: symSwP, ...(symbolDash ? { strokeDash: symbolDash } : {}), ...(opVal != null && Number.isFinite(opVal as number) ? { opacity: opVal as number } : {}) })
        }
      }
      // clipHeight clips the entry's symbols with a clipPath over the
      // laid-out entry rect (vega's guideMark clip + SVGStringRenderer clip:
      // rect (0,0,entry.width,entry.height) in the entry's local frame)
      if (hasClip && !ctx.rawGuides) {
        ;(items[items.length - 1] as Record<string, unknown>)._clip = { w: colWc, h: eb.y2 }
      }
      items.push({
        text: e.label,
        x: entryX + colOff + (xLblIs[i]! || 0),
        y: legendPad + off + (yIs[i]! || 0),
        baseline: lblBaseline as 'middle',
        align: labelAlign as 'left',
        fill: labelColor,
        fontSize: labelFs,
        limit: labelLimit,
        ...(labelOpacity != null ? { fillOpacity: labelOpacity } : {}),
        ...(labelFont != null ? { font: labelFont } : {}),
        ...(labelFontWeight != null ? { fontWeight: labelFontWeight } : {}),
        ...(labelFontStyle != null ? { fontStyle: labelFontStyle } : {}),
      })
    }
    const out: SceneGroup = { marktype: 'group', role: 'legend', x: 0, y: 0, width: bgW, height: bgH, items }
    ;(out as unknown as Record<string, unknown>)._borderStroke = borderStroke
    return out

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
  // vega's tick position (axisTicks tickPos): the ticks/grid sit at
  // scale + bandPosition*bandWidth + tickOffset, rounded when tickRound is on
  // (the default); for band scales the `axisBand` style supplies the -0.5
  // tickOffset default, which an explicit tickOffset replaces. floor() of the
  // band center is round(x - 0.5), so the default matches the old behavior.
  const bw = scale.bandwidth ? scale.bandwidth() : 0
  // vega's axisBand style keys on the scale TYPE (axis-config.js:
  // `scaleType(spec.scale) === 'band' && config.axisBand`) — not on whether
  // the bandwidth is non-zero — so a band scale with paddingInner 1 (bw 0)
  // still gets the -0.5 tickOffset default.
  const isBand = scale.type === 'band'
  // vega guide-util tickBand: 'extent' forces band 1 / offset 0 / extra on;
  // 'middle' forces band 0.5 with extra off; unset keeps bandPosition and
  // the tickExtra flag.
  const tickBandV = axis.tickBand as string | undefined
  const extentTicks = tickBandV === 'extent'
  const bandPos = extentTicks ? 1 : (tickBandV == null ? (axis.bandPosition ?? 0.5) : 0.5)
  const tickExtraOn = extentTicks ? true : (tickBandV == null ? axis.tickExtra === true : false)
  const tickOffsetEff = extentTicks ? 0 : (axis.tickOffset ?? (isBand ? -0.5 : 0))
  const tickRoundOn = axis.tickRound !== false
  // vega's AxisTicks `extra`: one more entry pegged to the FIRST tick value
  // (empty label); its scale encode REPLACES the scale+bandwidth term with
  // the raw scale of that value (entry.js: `datum.extra ? _scale(s, v0) :
  // _scale(s, v) + _bandwidth(s)*band`), then offset and round apply.
  const tickEntries = ticks.map((v) => ({ value: v, extra: false }))
  if (tickExtraOn && ticks.length) tickEntries.push({ value: ticks[0]!, extra: true })
  const pos = (t: unknown, isExtra = false): number => {
    const scaled = scale(isExtra ? ticks[0]! : t) as number
    // A NaN scale lookup (degenerate range/domain) renders at the axis origin:
    // vega's encoders read `value || 0` on the whole tick position, so the band
    // and tickOffset terms must not turn the NaN into a real -0.5.
    if (!Number.isFinite(scaled)) return 0
    const raw = scaled
      + (isExtra ? 0 : isBand ? bandPos * bw : 0)
      + tickOffsetEff
    return tickRoundOn ? Math.round(raw) : raw
  }

  if (axis.grid) {
    // Apply the axis `encode.grid` (vega's grid-line encoding) so specs can set
    // strokeDash/stroke/opacity etc. on the grid marks.
    const gridEnc = axis.encode?.grid
    const gridUpdate = gridEnc?.update ?? gridEnc?.enter ?? {}
    const gridStyle = Object.keys(gridUpdate).length
      ? resolveEncodeSet(gridUpdate as Record<string, EncodeValue | EncodeValue[]>, {}, ctx, 'line')
      : {}
    const gridScaleName = (axis as { gridScale?: string }).gridScale
    const gridScale = gridScaleName ? ctx.scales.get(gridScaleName) : undefined
    const gridRange = gridScale?.range?.() as number[] | undefined
    // vega-parser's axis-grid encode (axis-util getSign/ifX): the grid tick
    // rides the axis direction, while the cross-axis runs from the gridScale's
    // range start to end, signed by the orient (+1 left/top, -1 right/bottom)
    // and anchored at the axis spine. This matters whenever a channel's axis
    // takes a perpendicular orient (x with orient right, y with orient bottom).
    const isXAxis = orient === 'bottom' || orient === 'top'
    const gridSign = orient === 'left' || orient === 'top' ? 1 : -1
    const gridSpan = (frac: number): number => {
      const v = gridRange && gridRange.length >= 2
        ? (() => {
            const a = Number(gridRange[0])
            const b = Number(gridRange[gridRange.length - 1])
            return (a + frac * (b - a)) * gridSign
          })()
        : frac * (isXAxis ? ctx.height : ctx.width) * gridSign
      return Number.isFinite(v) ? v : 0
    }
    const gridStart = gridSpan(0)
    const gridEnd = gridSpan(1)
    const gridOrigin = orient === 'right' ? ctx.width : orient === 'bottom' ? ctx.height : 0
    for (const te of tickEntries) {
      const v = pos(te.value, te.extra)
      const item: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (isXAxis) {
        item.x = v + 0.5; item.x2 = v + 0.5
        item.y = gridOrigin + gridStart + 0.5; item.y2 = gridOrigin + gridEnd + 0.5
      } else {
        item.y = v + 0.5; item.y2 = v + 0.5
        item.x = gridOrigin + gridStart + 0.5; item.x2 = gridOrigin + gridEnd + 0.5
      }
      item.stroke = gridStyle.stroke ?? (axis as { gridColor?: string }).gridColor ?? '#ddd'
      item.strokeWidth = gridStyle.strokeWidth ?? (axis as { gridWidth?: number }).gridWidth ?? 1
      const gridDash = gridStyle.strokeDash ?? (axis as { gridDash?: number[] }).gridDash
      if (gridDash != null) item.strokeDash = gridDash
      if (gridStyle.opacity != null) item.opacity = gridStyle.opacity
      // Vega's axisLayout bounds union only the ticks and labels marks; the
      // grid mark never extends the axis bound (nor the view bounds).
      ;(item as Record<string, unknown>)._grid = true
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
  // ticks:false hides the marks AND zeroes the effective tick size: vega's
  // axisLabels/titles position off the tickSize signal, which the axis
  // encode sets to 0 when ticks are off.
  const tickSize = axis.ticks === false ? 0 : (axis.tickSize ?? 5)
  const labelPadding = axis.labelPadding ?? 2
  const tickItems: SceneItem[] = []
  const labels: SceneItem[] = []

  for (const te of tickEntries) {
    const t = te.value
    const v = pos(t, te.extra)
    if (axis.ticks !== false) {
      const tick: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (orient === 'left') { tick.x = 0.5; tick.x2 = -tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'right') { tick.x = ctx.width + 0.5; tick.x2 = ctx.width + tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'bottom') { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = ctx.height + 0.5; tick.y2 = ctx.height + tickSize + 0.5 }
      else { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = 0.5; tick.y2 = -tickSize + 0.5 }
      tick.stroke = axis.tickColor ?? '#888'
      tick.strokeWidth = axis.tickWidth ?? 1
      if (axis.tickDash) tick.strokeDash = axis.tickDash
      tickItems.push(tick)
      items.push(tick)
    }
    if (axis.labels !== false) {
      // vega's AxisTicks extra entry: an empty label whose scale lookup
      // (datum.value undefined) lands on NaN — the renderer's || 0 pins it
      // to the axis origin (only the perpendicular coordinate is real)
      const label: SceneItem = { text: te.extra ? '' : String(labelFormat(t)), x: 0, y: 0 }
      const align = axis.labelAlign ?? (orient === 'left' ? 'right' : orient === 'right' ? 'left' : 'center')
      const baseline = axis.labelBaseline ?? (orient === 'top' ? 'bottom' : orient === 'bottom' ? 'top' : 'middle')
      // Vega axis labels (vega-encode axisLabels): the label y is the raw
      // extent — tickSize + labelPadding beyond the axis line for bottom/top,
      // the scale position for left/right — with the baseline shift applied
      // by the renderer (renderLeaf bakes baselineOffset when the item
      // carries an explicit baseline). Rotated labels keep the historical
      // bake (the rotation folds the offset into vega's rotate translate).
      const labelFs = axis.labelFontSize ?? 10
      const labelAngle = typeof axis.labelAngle === 'number' ? axis.labelAngle : 0
      // Vega's renderer folds the baseline offset into the item position for
      // unrotated text but applies it inside the rotate frame for rotated
      // text — so rotated labels carry no baseline (no bake anywhere).
      label.fontSize = labelFs
      if (axis.labelFont != null) label.font = axis.labelFont
      label.limit = axis.labelLimit ?? 180
      // Labels anchor at the unrounded scale + 0.5*bandWidth + tickOffset
      // (the axisBand -0.5 default folds against our baked +0.5 group delta)
      // + labelOffset — bandPosition and tickRound do not reach them (vega's
      // axisLabels tickPos keeps band 0.5 and no round of its own).
      const scaledLabel = scale(t) as number
      const labelScaled = Number.isFinite(scaledLabel)
      const rawOf = (labelScaled ? scaledLabel + (isBand ? 0.5 * bw : 0) : 0)
      const labelOffset = axis.labelOffset ?? 0
      // The along-axis label coordinate: vega's axisLabels position labels at
      // the UNROUNDED tick position (band 0.5 + tickOffset — tickRound never
      // reaches them) + labelOffset, for every orient. Keying on
      // `scale.bandwidth` alone silently rounded point-scale labels, which
      // skewed the view bounds (top margin ceil(-y1)) by a pixel.
      const alongLabel = rawOf + (labelScaled ? tickOffsetEff : 0) + 0.5 + labelOffset
      // vega's labelFlush (axis-labels.js): within labelFlush px of a range
      // endpoint the label align (x orients) or baseline (y orients) flips to
      // the endpoint side (vega-util flush: left needs l < r && l <= t, right
      // just r <= t); with a nonzero labelFlushOffset the flushed labels also
      // dx/dy inward — but only when the user did not pin labelAlign /
      // labelBaseline. The flush compares the RAW scale(value).
      const labelFlushRaw = axis.labelFlush as number | boolean | null | undefined
      const flushOn = labelFlushRaw != null && (labelFlushRaw === 0 || !!labelFlushRaw)
      const flushT = labelFlushRaw === true ? 1 : typeof labelFlushRaw === 'number' ? labelFlushRaw : 0
      const flushOffset = (axis as { labelFlushOffset?: number }).labelFlushOffset ?? 0
      const flushPick = (value: number, a: string | number, b: string | number, c: string | number): string | number => {
        const rangeArr = scale.range() as number[]
        let lo = Number(rangeArr[0])
        let hi = Number(rangeArr[rangeArr.length - 1])
        if (hi < lo) { const tmp = lo; lo = hi; hi = tmp }
        const l = Math.abs(value - lo)
        const r = Math.abs(hi - value)
        return l < r && l <= flushT ? a : r <= flushT ? b : c
      }
      const rawScalePos = te.extra ? NaN : (scale(t) as number)
      let alignEff = align
      let baselineEff = baseline
      let dxv = 0
      let dyv = 0
      if (flushOn) {
        if (orient === 'bottom' || orient === 'top') {
          if (axis.labelAlign == null) alignEff = flushPick(rawScalePos, 'left', 'right', 'center') as string
          if (flushOffset && axis.labelAlign == null) dxv = flushPick(rawScalePos, -flushOffset, flushOffset, 0) as number
        } else {
          if (axis.labelBaseline == null) baselineEff = flushPick(rawScalePos, 'top', 'bottom', 'middle') as string
          if (flushOffset && axis.labelBaseline == null) dyv = flushPick(rawScalePos, -flushOffset, flushOffset, 0) as number
        }
      }
      if (orient === 'left')   { label.x = -tickSize - labelPadding + 0.5; label.y = (te.extra ? 0.5 : alongLabel) + dyv; label.align = alignEff as SceneItem['align'] }
      else if (orient === 'right') { label.x = ctx.width + tickSize + labelPadding + 0.5; label.y = (te.extra ? 0.5 : alongLabel) + dyv; label.align = alignEff as SceneItem['align'] }
      else if (orient === 'bottom') {
        // Point scales (bw = 0) miss the band-scale `axisBand` tickOffset
        // (-0.5) that cancels vega's +0.5 axis-group translate, so their
        // label anchor needs the +0.5 baked in.
        label.x = (te.extra ? 0.5 : alongLabel) + dxv
        label.y = ctx.height + tickSize + labelPadding + 0.5
        label.align = alignEff as SceneItem['align']
      }
      else {
        label.x = (te.extra ? 0.5 : alongLabel) + dxv
        label.y = -(tickSize + labelPadding) + 0.5
        label.align = alignEff as SceneItem['align']
      }
      // vega keeps the label baseline on rotated labels too: the renderer
      // folds the baseline offset inside the rotate frame (translate(x,y)
      // rotate(a) translate(dx,dy)) and the bound (marks/text.js bound) does
      // the same, so the item carries the baseline either way — stripping it
      // shifts the rotated bbox by the baseline offset and skews the root
      // bounds by a pixel or two.
      label.baseline = baselineEff as SceneItem['baseline']
      // vega's axisLabels: labelAngle is an update patch on the text mark's
      // angle — the renderer folds the baseline offset inside the rotate frame
      // (hence no explicit baseline above when rotated).
      if (labelAngle) (label as Record<string, unknown>).angle = labelAngle
      label.fill = axis.labelColor ?? '#000'
      if (axis.labelOpacity != null) label.fillOpacity = axis.labelOpacity
      labels.push(label)
      items.push(label)
    }
  }

  // Vega's axis `labelOverlap` runs the Overlap transform over the label
  // items: labels that would collide are hidden with opacity 0 (they stay in
  // the scene). `true` falls back to the parity method (hide alternating
  // labels until none overlap); 'greedy' hides items colliding with the
  // last kept item. Bounds use the same headless text estimate vega uses.
  // vega's Overlap transform drops labels with no content before running
  // (`hasBounds`: empty text measures zero). The axis `extra` entry is exactly
  // such a label — it must not shift the parity phases or become the "last
  // source label" that the final preserve rule resurrects.
  const overlapSource = labels.filter((it) => String(it.text ?? '').length > 0)
  if (axis.labelOverlap && overlapSource.length >= 3) {
    // vega Overlap: sep = _.separation || 0; a negative separation disables
    // collisions, a positive one pads them.
    const sep = (axis as { labelSeparation?: number }).labelSeparation ?? 0
    const boundsOf = (it: SceneItem) => {
      const w = itemTextWidth(it as FontProps, String(it.text ?? ''))
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
    for (const it of overlapSource) it.opacity = 1
    let kept = overlapSource
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
      const last = overlapSource[overlapSource.length - 1]!
      if (kept.length < 3 && !last.opacity) {
        if (kept.length > 1) kept[kept.length - 1]!.opacity = 0
        last.opacity = 1
      }
    }
  }

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
    domainLine.stroke = axis.domainColor ?? '#888'
    domainLine.strokeWidth = axis.domainWidth ?? 1
    if (axis.domainDash) domainLine.strokeDash = axis.domainDash
    if (axis.domainOpacity != null) domainLine.strokeOpacity = axis.domainOpacity
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
    // Axis titles: our axis items carry absolute coordinates that bake in the
    // axis group origin (0.5, 0.5) — vega renders its axis group at that
    // offset and positions the title inside it, so the absolute equivalents
    // are (all verified against oracle canonical records):
    //   bottom: (w/2+0.5, h + 0.5 + [tick+0.5+labelPad+9.5+titlePad] + 9)
    //   top:    (w/2+0.5, 0.5 - [tick+0.5+labelPad+9.5+titlePad] - 2)
    //   left:   (-(tick+labelPad+labelWidth+3.5), h/2 + 0.5)   angle -90
    //   right:  (w + tick+labelPad+labelWidth+4.5, h/2 + 0.5)  angle 90
    // The +9/-2 are the baseline offsets (fs 11, top/bottom), baked for
    // angle-0 titles; rotated titles render translate+rotate+offset.
    // Title style properties (vega applies them through the title layout;
    // the baseline offsets scale with the resolved fontSize).
    const titleFs = (axis as { titleFontSize?: number }).titleFontSize ?? 11
    const baseUp = Math.round(0.79 * titleFs)
    const titleOpacity = (axis as { titleOpacity?: number }).titleOpacity
    const titleColor = (axis as { titleColor?: string }).titleColor
    // vega's 'guide-title' style defaults fontWeight to bold (guide titles
    // include axis titles); vega-lite never emits an explicit weight.
    const titleWeight = (axis as { titleFontWeight?: string | number }).titleFontWeight ?? 'bold'
    const titleAlign = (axis as { titleAlign?: string }).titleAlign
    const titleBaseline = (axis as { titleBaseline?: string }).titleBaseline
    const titleX = (axis as { titleX?: number }).titleX
    const titleY = (axis as { titleY?: number }).titleY
    const titleAnchor = (axis as { titleAnchor?: string }).titleAnchor
    const titleAngle = (axis as { titleAngle?: number }).titleAngle

    // The title y is vega's raw layout position; the baseline shift is the
    // renderer's (renderLeaf bakes baselineOffset for explicit baselines).
    // vega's axisTitleLayout anchors the title at v = s + dl + titlePadding,
    // where s is the clamped tick+label extent (axisLayout:
    // s = max(minExtent, min(maxExtent, bounds.y2))). Our items bake the
    // 0.5px axis-group delta, hence the ±0.5 on the absolute positions.
    // vega's axisLayout unions the actual tick+label item bounds — stroke
    // expansion and label rotation included — and anchors the title beyond
    // them: s = the perpendicular extent clamped by minExtent/maxExtent
    // (dl = multiLineOffset(title) is 0 for the single-line titles here).
    // Our items bake the 0.5px axis-group delta, so the line-relative extent
    // subtracts the baked line position per orient.
    const guideB = new Bounds()
    for (const it of [...tickItems, ...labels]) {
      // vega's axisLayout bounds only the visible labels: an overlap-hidden
      // (opacity 0) label must not push the title outward.
      if (it.opacity === 0) continue
      const bb = new Bounds()
      boundLeaf(bb, it)
      guideB.union(bb)
    }
    const minE = axis.minExtent ?? 0
    const maxE = axis.maxExtent ?? 200
    const clampS = (v: number): number => Math.max(minE, Math.min(maxE, v))
    const sFor = (o: string): number => {
      if (guideB.empty()) return 0
      if (o === 'bottom') return clampS(guideB.y2 - (ctx.height + 0.5))
      if (o === 'top') return clampS(0.5 - guideB.y1)
      if (o === 'left') return clampS(0.5 - guideB.x1)
      return clampS(guideB.x2 - (ctx.width + 0.5))
    }

    // vega's axis title anchor (axis-title.js): the position is the signal
    // `lerp(range(scale), item.anchor === 'start' ? 0 : item.anchor === 'end'
    // ? 1 : 0.5)` — along the axis for top/bottom (x), across for left/right
    // (y) — and the align signal is `anchor === 'start' ? 'left' :
    // anchor === 'end' ? 'right' : 'center'`.
    const rng = (scale.range?.() as number[] | undefined) ?? []
    const r0 = Array.isArray(rng) ? (rng[0] as number) ?? 0 : 0
    const r1 = Array.isArray(rng) ? (rng[rng.length - 1] as number) ?? 0 : 0
    const lerpRaw = titleAnchor === 'start' ? r0 : titleAnchor === 'end' ? r1 : (r0 + r1) / 2
    // A degenerate range (NaN endpoints) places the title at the axis origin,
    // matching vega's `|| 0` on the rendered coordinate.
    const anchorLerp = Number.isFinite(lerpRaw) ? lerpRaw : 0

    if (orient === 'bottom') {
      t.x = anchorLerp + 0.5
      t.y = ctx.height + 0.5 + sFor('bottom') + titlePadding
      t.align = 'center'; t.baseline = titleBaseline ?? 'top'
    }
    else if (orient === 'top') {
      t.x = anchorLerp + 0.5
      // the top group sits at y = 0.5 (delta only), so no line offset to add
      t.y = 0.5 - (sFor('top') + titlePadding)
      t.align = 'center'; t.baseline = titleBaseline ?? 'bottom'
    }
    else if (orient === 'left' || orient === 'right') {
      const sLR = sFor(orient)
      t.x = orient === 'left' ? -(sLR + titlePadding) + 0.5 : ctx.width + sLR + titlePadding + 0.5
      t.y = anchorLerp + 0.5; t.align = 'center'; t.baseline = titleBaseline ?? 'bottom'
      ;(t as Record<string, unknown>).angle = titleAngle ?? (orient === 'left' ? -90 : 90)
    }
    // Raw-guide mode: the axisTitleLayout never ran, so the title keeps its
    // encode position — the lerp along the axis, and 0 across (the s+extent
    // offset is a layout product). The -0.5 raw shift then lands it at 0.
    if (ctx.rawGuides) {
      // the raw dys for bottom drops the height origin; the title must land
      // at 0 across (bottom/top) or 0 along (left/right) after it.
      if (orient === 'bottom') t.y = ctx.height + 0.5
      else if (orient === 'top') t.y = 0.5
      else t.x = 0.5
    }
    // Explicit titleX/titleY are the vega title mark's group-relative x/y,
    // and the axis group sits at (0.5, ±0.5|height+0.5) per orient (vega
    // axisLayout: top y=-offset, bottom y=height+offset, left x=-offset,
    // right x=width+offset; delta = translate ?? 0.5) — so resolve them
    // against the baked absolute origin.
    if (titleX != null) t.x = titleX + (orient === 'right' ? ctx.width + 0.5 : 0.5)
    if (titleY != null) t.y = titleY + (orient === 'bottom' ? ctx.height + 0.5 : 0.5)
    if (titleAlign != null) t.align = titleAlign as SceneItem['align']
    else if (titleAnchor === 'start') t.align = 'left'
    else if (titleAnchor === 'end') t.align = 'right'
    if (titleBaseline != null) t.baseline = titleBaseline as SceneItem['baseline']
    // vega's axis-title: titleAngle is a require-update patch on the mark's
    // angle — the enter default is 0 for horizontal orients (±90 for
    // vertical, applied in the branches above), and an explicit titleAngle
    // overrides either.
    if (titleAngle != null && orient !== 'left' && orient !== 'right') {
      ;(t as Record<string, unknown>).angle = titleAngle
    }
    // Vega emits font-size 11 on axis titles explicitly (bounds + canvas font).
    ;(t as Record<string, unknown>).fontSize = titleFs
    if (axis.titleFont != null) (t as Record<string, unknown>).font = axis.titleFont
    if ((axis as { titleLimit?: number }).titleLimit != null) {
      t.limit = (axis as { titleLimit?: number }).titleLimit
    }
    ;(t as Record<string, unknown>).fontWeight = titleWeight
    if (titleOpacity != null) t.fillOpacity = titleOpacity
    t.fill = titleColor ?? '#000'
    ;(t as Record<string, unknown>)._title = true
    items.push(t)
  }

  // `translate` replaces the 0.5px axis-group delta and `offset` shifts the
  // whole axis perpendicular to its line (vega axisLayout: x = -offset for
  // left, y = height + offset for bottom, ...).
  const trRaw = axis.translate
  const tr = (typeof trRaw === 'number' ? trRaw : 0.5) - 0.5
  const off = axis.offset ?? 0
  // `position` anchors the whole axis group along its line (vega axisLayout:
  // x = position for top/bottom, y = position for left/right).
  const posOff = typeof axis.position === 'number' ? axis.position : 0
  // Raw-guide mode (the layout aborted): the items keep their encode-frame
  // positions — the axis group sits at (0,0); only the perpendicular origin
  // (height/width) is dropped, which axisLayout would have applied. The
  // buildAxisAndLegend wrapper's -0.5 already cancels the baked delta.
  const dxs = ctx.rawGuides ? (orient === 'right' ? -ctx.width : 0) : tr + (orient === 'left' ? -off : orient === 'right' ? off : posOff)
  const dys = ctx.rawGuides ? (orient === 'bottom' ? -ctx.height : 0) : tr + (orient === 'bottom' ? off : orient === 'top' ? -off : posOff)
  if (typeof process !== 'undefined' && process.env.ASTER_DBG_RAW) console.error('[raw]', orient, 'raw', ctx.rawGuides, 'dxs', dxs, 'dys', dys, 'n', items.length)
  if (dxs || dys) {
    for (const it of items) {
      const rec = it as Record<string, unknown>
      if (rec.x != null) rec.x = (rec.x as number) + dxs
      if (rec.y != null) rec.y = (rec.y as number) + dys
      if (rec.x2 != null) rec.x2 = (rec.x2 as number) + dxs
      if (rec.y2 != null) rec.y2 = (rec.y2 as number) + dys
    }
  }

  // vega axis encode: `range: abs(span(range(scale)))` — the spine extent
  const sr = scale.range() as number[]
  const axisRangeSpan = sr.length > 1 ? Math.abs(Number(sr[sr.length - 1]) - Number(sr[0])) : 0

  return {
    marktype: 'group',
    role: 'axis',
    items,
    // axis geometry for the vega-faithful bounds port (boundAxisGroup):
    // `range` is the spine extent along the axis line — vega's axis encode
    // sets `range: abs(span(range(scale)))`, the SCALE's absolute range span
    // (a left axis over a width-ranged scale spans the width, not the view
    // height); `baseline` is the perpendicular position of the axis line
    // (content bottom for bottom, content top for top, 0 for left, content
    // right for right). These diverge once autosize fit shrinks width !=
    // height, so both are needed.
    ...(orient === 'left' || orient === 'right'
      ? { axis: { orient, range: axisRangeSpan, baseline: orient === 'right' ? ctx.width : 0, translate: ctx.rawGuides ? 0 : (typeof axis.translate === 'number' ? axis.translate : 0.5), position: posOff } }
      : { axis: { orient, range: axisRangeSpan, baseline: orient === 'bottom' ? ctx.height : 0, translate: ctx.rawGuides ? 0 : (typeof axis.translate === 'number' ? axis.translate : 0.5), position: posOff } }),
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
      // vega AxisTicks: validTicks(scale, values, count) — values outside the
      // scale's range are dropped and the rest are sorted in range order
      // (a band axis with numeric picks therefore renders no ticks).
      return validTicks(scale, vs.filter((v) => v != null), vs.length)
    }
    return []
  }
  let count: number | undefined
  if (typeof axis.tickCount === 'number') count = axis.tickCount
  else if (typeof axis.tickCount === 'string' || (axis.tickCount && typeof axis.tickCount === 'object' && !('signal' in (axis.tickCount as Record<string, unknown>)) && 'interval' in (axis.tickCount as Record<string, unknown>))) {
    // vega's tickCount util resolves an interval string against the scale:
    // legal only on time/utc scales, where it becomes a calendar interval the
    // scale's ticks consume; anything else refuses upstream (so "both refuse"
    // is agreement).  `{interval, step}` objects resolve the interval and
    // widen it with `every(step)`.
    const raw = typeof axis.tickCount === 'string' ? axis.tickCount : (axis.tickCount as { interval?: unknown }).interval
    const step = typeof axis.tickCount === 'object' && axis.tickCount !== null ? (axis.tickCount as { step?: unknown }).step : undefined
    if (typeof raw !== 'string') throw new Error('Invalid tick count.')
    if (scale.type !== 'time' && scale.type !== 'utc') {
      throw new Error('Only time and utc scales accept interval strings.')
    }
    // vega-time has no singular sub-day intervals; vega falls back to the
    // default tick count for these names rather than refusing the axis.
    if (raw === 'hour' || raw === 'minute' || raw === 'second' || raw === 'millisecond') {
      count = undefined
    } else {
      const ival = scale.type === 'time' ? timeIntervalFor(raw) : utcIntervalFor(raw)
      if (!ival) throw new Error(`[aster] unknown time interval: ${raw}`)
      count = (step != null ? (ival as { every?: (n: number) => unknown }).every?.(step as number) : ival) as unknown as number
    }
  }
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

  // A negative tickMinStep makes vega's tickCount reduce the count below 1
  // (floor(span / negative) + 1), and tickValues then yields no ticks at all.
  // Band/point scales are exempt: tickValues returns their domain untouched.
  if (tickMinStep != null && tickMinStep < 0 && scale.type !== 'band' && scale.type !== 'point') return []

  // vega's AxisTicks tally: no tickCount means 10 (not "let the scale pick").
  // Without this a linear axis with tickMinStep and no tickCount would step
  // every minStep across the whole domain (hundreds of month labels).
  if (count === undefined) count = 10
  // vega-encode passes tickMinStep into tickCount, which clamps the tick
  // count to one tick per minimum step: count = min(count, span/minstep + 1)
  // and, for non-temporal non-log scales, shrinks count until tickStep >=
  // minStep. tickCount() implements that rule for every scale type.
  if (tickMinStep != null && tickMinStep > 0 && typeof count === 'number') {
    const counted = tickCount(scale, count, tickMinStep)
    if (typeof counted === 'number') count = counted
  }

  // For continuous non-time scales with tickMinStep but no tickCount, generate
  // ticks directly from the scale domain using the step value.
  // For time/utc scales, d3's time ticks already produce calendar-aligned
  // intervals, so we use scaleTicks normally and apply tickMinStep as a filter.
  // Band/point scales are excluded: vega's tickValues returns their domain
  // directly (no .ticks method), so neither count nor minstep reach the ticks.
  if (tickMinStep != null && tickMinStep > 0 && count == null
      && scale.type !== 'time' && scale.type !== 'utc'
      && scale.type !== 'band' && scale.type !== 'point') {
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
    // vega applies tickMinStep through tickCount's count reduction (the
    // calendar stepping above handles the count==null case); the tick values
    // themselves come straight from the scale's calendar ticks.
    return scaleTicks(scale, count)
  }

  const ticks = scaleTicks(scale, count)
  // When tickMinStep is specified, filter ticks so consecutive values are at
  // least tickMinStep apart (matching vega's AxisTicks + tickMinStep filter).
  // Band/point scales: their domain comes through untouched (no .ticks), so
  // no filtering — see the generation guard above.
  if (tickMinStep != null && tickMinStep > 0 && ticks.length > 1
      && scale.type !== 'band' && scale.type !== 'point') {
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
  const wrapLabelExpr = (f: (v: unknown) => string): ((v: unknown) => string) => {
    const le = (axis as unknown as { labelExpr?: unknown }).labelExpr
    if (typeof le !== 'string' || !ctx) return f
    const expr = compileExpr(le, ctx.runtime)
    return (v: unknown) => String(expr({ label: f(v), value: v }, ctx.signalParams))
  }
  if (specFmt && typeof specFmt === 'object' && 'signal' in specFmt && specFmt.signal) {
    return wrapLabelExpr(() => String(specFmt.signal))
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
    return wrapLabelExpr(fmt ? L.timeFormat(fmt) : L.timeFormat(undefined as unknown as string))
  }
  if (scale.type !== 'linear' && scale.type !== 'log' && scale.type !== 'pow' && scale.type !== 'sqrt' && scale.type !== 'symlog') {
    // vega applies an inherited numeric format specifier even to band/point
    // labels; non-numeric band values format as NaN.
    if (fmt != null) {
      const L = locale(undefined)
      return wrapLabelExpr((v) => L.format(fmt)(typeof v === 'number' ? v : Number(v)))
    }
    return wrapLabelExpr((v) => String(v))
  }
  const L = locale(undefined)
  return wrapLabelExpr(tickFormat(L, scale, count, fmt))

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
