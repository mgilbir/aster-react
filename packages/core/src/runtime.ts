/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, ExpressionParseError, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { ingestRows, readData, type DataFormatSpec } from './data-format.js'
import { applyTransforms, compileExprTransform, sortOrder, getField, geoJSONPath, aggregateGroup, type Row, type TransformContext } from './transform.js'
import { fieldOf } from './transform-agg.js'
import { atRandomSite, contentKey, replayable } from './random-tape.js'
import { activeMeter, withLimits, boundedCount, checkRowCount, meterItems, meterTick, AsterLimitError } from './limits.js'
import { withTextMetricsProvider } from './text-metrics.js'
import { AsterUrlError } from './url-policy.js'
import { SpecParseError } from './parse-error.js'
import { consoleLogger, type Logger } from './logger.js'
import { buildScale, scaleTicks, type Scale, CONTINUOUS_TYPES, type ScaleContext } from './scales.js'

/** Scale types whose domain is an ordered set of discrete values. */
const DISCRETE_TYPES = new Set(['band', 'point', 'ordinal'])
import { ITEM_MARK, geoRegistry, requireGeo } from './registry.js'
import { locale } from './locale.js'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledLegend,
  CompiledMark,
  CompiledProjection,
  CompiledTitle,
  CompiledScale,
  CompiledSignalDef,
  CompiledTransform,
  EncodeValue,
  RuntimeInput,
  SceneDef,
  ScaleDomain,
  SceneGroup,
  SceneItem,
  SceneNode,
  SceneRoot,
  SizeSpec,
  SortSpec,
  VgSpec,
} from './types.js'
import { gradientDefOf, hash53, isGradientPaint } from './svg-defs.js'
import { tickFormat, scaleGradientStops, tickCount, validTicks } from './scale.js'
import { timeIntervalFor, utcIntervalFor } from './time.js'
import { compileChart } from './compiler.js'
import { dict, ownGet, pushAll, sortData, lerp, scopedSignalName, heldSignalName, TUPLE_ID } from './util.js'
import { applyImageUrlPolicy, applyLinkUrlPolicy, resolveImageUrl, type ImageUrlPolicy } from './url-policy.js'
import { valueKey, valuesEqual } from './fingerprint.js'
import { rowsEqual, sourceNames, type PulseChange } from './pulse.js'
import { aggregateRows, fieldsOf, groupKeyFn } from './transform-agg.js'
import { flattenLength } from './transform-basic.js'
import { trellisLayout } from './trellis.js'
import { boundAxisGroup, boundLegendGroup, boundGroupItem, boundLeaf, boundTypedMark, Bounds, layoutBounds, eachMarkBounds, hasClippedMark } from './bounds.js'
import { rectItemPath } from './render.js'
import { buildAxis as buildAxisGuide, tickBand } from './guide-axis.js'
import { buildTitle as buildTitleGuide } from './guide-title.js'
import { buildLegend as buildLegendGuide, legendType, LEGEND_SCALES, type GuideHost } from './guide-legend.js'
import { isSignal, itemAriaOf, lookup, value, type GuideStyles, type UserEncode } from './guide-encode.js'
import { defaultMergedConfig } from './config-defaults.js'

const DEFAULT_SIZE = 500

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

/**
 * Per-dataset incremental state: the pipeline's step outputs and per-step
 * auxiliary indexes (filter pass flags, group membership, flatten offsets,
 * collect order), plus the params it was derived under.
 */
interface DatasetState {
  /** Fingerprint (signals/size/domainRaw/metrics) the pipeline ran under. */
  fp: string
  /** Row count of the pipeline INPUT, to validate a published pulse against. */
  inputLength: number
  /** `steps[k]` = output of transform k. */
  steps: Row[][]
  /** Per-step state, keyed `${dataset}#${k}`. */
  stepState: Map<string, unknown>
}

/** Min/max census of a continuous data-driven scale domain (C11). */
interface ContCensus {
  data: string
  field: string
  lo: number
  hi: number
  /** Number of rows currently holding `lo` / `hi`. */
  loCount: number
  hiCount: number
  /** Whether the census has any finite value. */
  finite: boolean
  /** The numeric value of the field for every row of the dataset, by index. */
  vals: number[]
}

/** Value census of a discrete data-driven scale domain. */
interface DiscCensus {
  data: string
  field: string
  vals: unknown[]
  counts: Map<unknown, number>
  firstIdx: Map<unknown, number>
}

interface ScaleEntry {
  scale: Scale
  /** The domain spans several datasets (`domain.fields`); never census-reused. */
  multi: boolean
  cont?: ContCensus
  disc?: DiscCensus
}

/**
 * Everything the incremental path remembers about the previous evaluation of
 * one compiled chart (audit T1). The compiled IR is immutable; this object is the
 * ONLY place per-chart evaluation memory lives, so correctness no longer
 * depends on how many times per evaluation `buildScales`/`buildDatasets` run:
 *
 * - an evaluation reads the COMMITTED state (`ctx.prev`) and writes a fresh
 *   draft (`ctx.draft`) from scratch;
 * - the draft replaces the committed state exactly once, after the whole
 *   evaluation (and, for sessions, every post-evaluation check) succeeded;
 * - the few fast paths that update a structure in place for O(changed)
 *   cost first `claim()` it: the committed state is then flagged `stale`, so an
 *   evaluation that dies before committing can never leave a half-updated state
 *   behind (the next evaluation re-derives from scratch).
 */
interface IncrementalState {
  /** Evaluation counter; reused items keep the generation they were encoded in. */
  gen: number
  /** Fingerprint of the final evaluation context (signals, size, overrides). */
  fp: string
  /** The final top-level scales of the evaluation. */
  scales: Map<string, Scale>
  scaleEntries: Map<string, ScaleEntry>
  datasets: Map<string, DatasetState>
  /** Top-level mark groups, keyed by compiled-mark identity (C4). */
  groups: Map<CompiledMark, SceneGroup>
  /** True once a fast path updated a structure in place (see above). */
  stale: boolean
}

function newState(gen: number): IncrementalState {
  return { gen, fp: '', scales: new Map(), scaleEntries: new Map(), datasets: new Map(), groups: new Map(), stale: false }
}

/** Committed state per compiled chart. Never stored on the IR itself. */
const STATES = new WeakMap<CompiledChart, IncrementalState>()

/** One evaluation's view of the committed state (shared across fit-loop passes). */
interface EvalTxn {
  prev: IncrementalState | undefined
  gen: number
  /** Structures this evaluation already updated in place (not reusable again). */
  claimed: Set<string>
}

function beginTxn(chart: CompiledChart): EvalTxn {
  const committed = STATES.get(chart)
  const prev = committed && !committed.stale ? committed : undefined
  return { prev, gen: (committed?.gen ?? 0) + 1, claimed: new Set() }
}

/** The partition key vega's aggregate/joinaggregate use (`String(a)|b|...`): the incremental grouping must equal the fresh one. */
function groupKeyOf(row: Row, groupby: string[]): string {
  return groupKeyFn(groupby)(row)
}

/**
 * Whether an aggregate / joinaggregate can be re-derived group by group.
 * A cross-product, a custom `key` accessor or a bootstrap interval (ci0/ci1
 * draws from one pseudo-random stream shared by all groups, so a group's value
 * depends on the groups before it) must be recomputed from scratch.
 */
function groupwiseIncremental(t: CompiledTransform): boolean {
  const p = t as { cross?: unknown; key?: unknown; ops?: unknown }
  if (p.cross || p.key != null) return false
  const ops = Array.isArray(p.ops) ? p.ops : []
  return !ops.includes('ci0') && !ops.includes('ci1')
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

/**
 * Fingerprint of everything that feeds expression evaluation and encoding
 * besides the data: the signal params (width/height included). Typed and
 * structural (fingerprint.ts), so a derived object-valued signal that is
 * re-created each round (`[0, width]`) hashes equal when unchanged (C57).
 */
function paramFpOf(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const k of Object.keys(params).sort()) parts.push(`${k}=${valueKey(params[k])}`)
  return parts.join('\u0001')
}

/**
 * Gradient def ids are CONTENT-ADDRESSED: `gradient_<hash of direction + stops>`.
 * They used to come from a process-global counter that never reset (copying
 * vega-scenegraph's `gradient_id`), so the same chart got different ids on every
 * render (SSR/hydration mismatch, `<defs>` churn) and two charts on one page both
 * emitted `gradient_0` for different gradients. A content hash is deterministic
 * per render, and two charts can only share an id when the gradient is identical.
 */
function gradientDefId(direction: 'horizontal' | 'vertical', stops: ReadonlyArray<{ offset: number; color: string }>): string {
  return 'gradient_' + hash53(direction + JSON.stringify(stops))
}

/** Cached recursive bounds for unchanged top-level mark groups. */
const GROUP_BOUNDS = new WeakMap<SceneGroup, Bounds>()

/**
 * Undo record for a mark whose items array was updated IN PLACE: the length it
 * had, and the items it overwrote.
 */
interface ItemsUndo { oldLen: number; idx: number[]; items: SceneItem[] }

/**
 * Persistent-scene sharing without mutating a returned scene (C52).
 *
 * An append / same-length update advances the engine-owned items array in place
 * (O(changes)) and hands it to the NEW group. The SUPERSEDED group — the one in
 * the previously returned scene — gets its `items` replaced by a lazy snapshot:
 * on first read it materialises (old length, overwritten items restored) from
 * the newer group, then becomes an ordinary data property. A chain of superseded
 * groups composes (materialising one reads its newer neighbour, itself possibly
 * lazy), so scenes can be read in any order, or never.
 *
 * Retention: an older group references the newer one until it is read; a newer
 * group never references an older one, so an unreferenced old scene is
 * collectable. A scene retained for a long time without being read keeps one
 * small undo record per later update alive (plus the items those updates
 * overwrote).
 */
/**
 * @internal Number of superseded groups materialised so far. Hot paths (DOM
 * patch, canvas append, stream flush) must never advance it in steady state;
 * tests assert exactly that.
 */
export function supersededMaterializations(): number { return materializedCount }
let materializedCount = 0

function supersedeItems(old: SceneGroup, next: SceneGroup, undo: ItemsUndo): void {
  let link: { next: SceneGroup; undo: ItemsUndo } | null = { next, undo }
  const settle = (value: SceneNode[] | undefined): void => {
    link = null
    Object.defineProperty(old, 'items', { value, writable: true, configurable: true, enumerable: true })
  }
  Object.defineProperty(old, 'items', {
    configurable: true,
    enumerable: true,
    get(): SceneNode[] | undefined {
      if (!link) return undefined
      const { next: newer, undo: u } = link
      materializedCount++
      // Reading the newer group's items materialises it first if it is lazy too.
      const base = (newer.items ?? []) as SceneItem[]
      const arr = base.slice(0, u.oldLen)
      // Reverse order: if an index was overwritten twice the earliest item wins.
      for (let k = u.idx.length - 1; k >= 0; k--) arr[u.idx[k]!] = u.items[k]!
      settle(arr as SceneNode[])
      return arr as SceneNode[]
    },
    set(v: SceneNode[] | undefined) { settle(v) },
  })
}

/** Mark types whose group bounds are exactly the union of their item bounds. */
const UNION_BOUND_MARKS = new Set(['symbol', 'rect', 'text', 'rule', 'tick'])
function cacheableGroupBounds(g: SceneGroup): boolean {
  return g.role === 'mark' && UNION_BOUND_MARKS.has(String(g.marktype))
}

/**
 * One vega-parser scope (the view, or a group item): the scales and data sets declared in it, and where its instance sits
 * among the instances of every scope (vega builds the instances of nested scopes level by level).
 */
interface GuideScope {
  parent?: GuideScope
  /** the ordinals of this instance and of its ancestors, root first (the view is `[]`) */
  path: number[]
  /** the next ordinal for a group item built directly in this scope */
  nextChild: { n: number }
  /** the scales this scope declares (the innermost of a name wins) */
  scales: readonly CompiledScale[]
  /** the data sets declared in this scope: its `data` (and, below, the partition of a facet) */
  data: readonly { name: string }[]
  facet?: string
  /** an instance at or after the aborted one is in this scope's subtree (or it is that instance): nothing laid it out */
  unsettled?: boolean
}

/**
 * Axes whose ticks failed (see axisTicksFailed). A failure aborts vega's dataflow pass: what its scope and the scopes
 * built after it would have made is absent. The first pass of a build records the failures, the second runs with the
 * earliest one as the cut.
 */
/**
 * Where a pass stopped: an axis of a scope (`axis` is its index), or a legend (`legend` is its index; the scope's axes
 * and marks come before the legends in vega's parse order, so they were all made).
 */
interface AbortPoint { path: number[]; axis: number; legend?: number; late?: boolean; /** a projection of the instance's scope could not be made (nothing else of it was) */ projection?: true }

interface AxisAbort {
  failures: Array<AbortPoint>
  /** `late`: the failing operator is the last of its scope, so everything else of the scope was made */
  cut?: AbortPoint
}

/**
 * What a dataflow pass leaves for the next one of the same view (autosize fit runs two): vega's operators keep their state.
 * The keys of the guide items it made, in item order (see `retainGuideOrder`: the join of the next pass starts from them),
 * and, per scale, the parameters it was last made with and whether it ended with `bins` (see `ScaleContext.pass`).
 */
interface PassRecord {
  guides: Map<string, string[]>
  scales: Map<string, { key: string; bins: boolean }>
}

/** The previous pass's record (undefined for the first) and the one this pass writes. */
interface PassMemory {
  prev: PassRecord | undefined
  cur: PassRecord
}

interface EvalContext {
  chart: CompiledChart
  /** Present while an evaluation makes more than one dataflow pass (autosize fit): see `PassMemory`. */
  passMemory?: PassMemory
  scope: GuideScope
  abort: AxisAbort
  signalParams: Record<string, unknown>
  width: number
  height: number
  /** The view's size, inside nested groups (whose `width` / `height` above are the group's own). A scale's `width` / `height` range is the view's. */
  viewWidth?: number
  viewHeight?: number
  /** The id of the enclosing signal scope (see `SceneGroup.scopeSignals`), '' at the root. */
  scopeId?: string
  /** Position of the enclosing facet group, for `{field: {group: 'x' | 'y'}}` references. */
  groupX?: number
  groupY?: number
  datasets: Map<string, Row[]>
  /** The rows `setdata(name, tuples)` put in a dataset's input (see `ExpressionRuntime.setdata`), and whether they changed since the datasets were last built. */
  setData: SetDataState
  /** A legend tickCount threw: the whole layout aborts (raw-guide mode). */
  rawGuides?: boolean
  /** The guide host of this context (see guideHost). */
  guideHost?: { ctx: EvalContext; host: GuideHost }
  /** The pass stopped below this scope: the legend entries of symbol legends (a level further down) were never made. */
  pendingEntries?: boolean
  scales: Map<string, Scale>
  scaleTypes: Map<string, string>
  /** Per-mark, per-eval encode bindings (scale fn + type) so the per-row encode
   * loop skips two Map lookups per scale channel. EvalContext is fresh per eval,
   * so bindings can never outlive the scales they reference. */
  encodeBinding?: EncodeBinding
  projections: Map<string, unknown>
  /** `datasets.size` and the registry's epoch when each fit projection was last built (see refreshProjection). */
  projectionStamp: Map<string, string>
  /** fit projections built before every source of their fit existed (a `geojson` signal a later dataset publishes) */
  projectionIncomplete: Set<string>
  /** a dataset transform consumed an incomplete projection: the datasets must be built again */
  geoStale: boolean
  /** while datasets build: build a named dataset now (a projection's fit can read one declared after its consumer) */
  buildOnDemand?: (name: string) => void
  runtime: ExpressionRuntime
  _defs: SceneDef[]
  /** Shared by every scope of one evaluation: a layout threw (vega logs it and renders the scene unlaid-out). */
  layoutState: { failed: boolean }
  /** Signals whose `init` expression has run (it runs once). */
  initDone: Set<string>
  /** Signals the host supplied for this evaluation (an `init` never overrides them). */
  hostSignals: Set<string>
  /** Hierarchy trees built by `stratify` transforms, keyed by data source name. */
  hierarchies: Map<string, unknown>
  /** Datasets affected by this update (changed datasets closed over source and transform dependencies). */
  affected: Set<string>
  /** True when the caller supplied change info AND a committed previous state exists. */
  incremental: boolean
  /**
   * Pulse propagation: the output pulse per dataset (after its transform
   * pipeline). A same-length update carries only `changed`; a length-changing
   * one additionally carries the old<->new index mapping (or the compact
   * `appendOnly` form) so marks can splice their item array instead of
   * re-encoding unchanged rows. null means the dataset was fully re-derived (no
   * trustworthy mapping, nothing downstream may be spliced).
   */
  datasetPulses: Map<string, StepPulse | null>
  /** Input pulses for source datasets (from the host/session): `dataChanges` and `dataPulse`. */
  inputPulses?: Map<string, StepPulse>
  /** The committed state of the previous evaluation (read-only; see IncrementalState). */
  prev?: IncrementalState
  /** The state this evaluation builds; committed by the caller on success. */
  draft: IncrementalState
  /** Evaluation generation (stamped on newly encoded items). */
  gen: number
  /** Structures already updated in place during this evaluation. */
  claimed: Set<string>
  /** Non-signal inputs that invalidate reuse (domainRaw, text metrics). */
  extraFp: string
  /** Memo for ctxFpOf; cleared whenever signalParams may have changed. */
  fpMemo?: string
  /** Bumped by every dataset (re)build pass; part of the scale-reuse stamp. */
  dsEpoch: number
  /** Census-reuse decisions already taken this evaluation (a census is advanced once). */
  scaleReuse: Map<string, { stamp: string; entry: ScaleEntry }>
  /** Distinct-value memo for discrete scale domains (lives for this evaluation only). */
  distinctCache: WeakMap<unknown[], Map<string, unknown[]>>
  /** Wall-clock deadline (performance.now epoch) from `limits.maxTimeMs`. */
  deadline?: number
  /** Direct scale-domain overrides keyed by scale name. */
  domainRaw?: Map<string, unknown[]>
  /** Throw a typed error when the current evaluation ran past its deadline. */
  checkDeadline?: (phase?: string) => void
  /** URL policy for image marks (RuntimeInput.urlPolicy). */
  urlPolicy?: ImageUrlPolicy
  /** Where recovered errors are reported (RuntimeInput.logger; default: the console). */
  logger: Logger
  /** An expression failed during this evaluation (its report was logged); the incremental state must not be committed. */
  failed?: boolean
  /** vega aborts the rest of an encode after its first error: later items stay unencoded. */
  encodeAborted?: boolean
  /** Datasets whose transform pipeline failed: nothing downstream of them is built. */
  failedDatasets?: Set<string>
  /** a dataset's transform threw: the pass stopped before the scales, marks and guides (see buildDatasetsOf) */
  datasetAborted?: boolean
  /** the rank (see datasetRanksOf) of the first dataset whose transform threw: what is ranked after it never ran (see buildDatasetsOf) */
  failedFrom?: number
  /** the first of the view's projections that could not be made (see abortAtThrowingProjection) */
  projectionError?: unknown
  /** a signal ranked last threw: the pass's post-run work (the layout that grows the padding) did not happen */
  postRunLost?: boolean
  /** the pass stopped before the root group's size was encoded (a signal threw): the frame is 0 x 0 */
  rootUnsized?: boolean
  /** The error each signal's expression threw the last time it was evaluated (a later evaluation that succeeds clears it). */
  signalErrors?: Map<string, unknown>
  /** The items of the named marks built so far (a mark may read another mark's items as its data: `from: {data: <mark name>}`). */
  markItems: Map<string, SceneItem[]>
  /** The container of each named mark built so far (its type and items; a group mark's are its group items): what a `label` transform avoids or labels. */
  markContainers: Map<string, { marktype: string; items: SceneItem[] }>
}

/**
 * Report an error the engine recovers from, the way vega's Dataflow.error does: log it and go
 * on. Errors that are the engine's own refusals -- limits, the URL policy, `[aster]` usage errors --
 * and expressions that do not parse (vega throws those from vega.parse) are never recovered:
 * they are rethrown to the caller.
 */
function reportEvalError(ctx: EvalContext, e: unknown): void {
  if (e instanceof AsterLimitError || e instanceof AsterUrlError || e instanceof ExpressionParseError || e instanceof SpecParseError || (e instanceof Error && e.message.startsWith('[aster]'))) throw e
  ctx.failed = true
  ctx.logger.error(e)
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
 *
 * The compiled chart is never written: signals, scale domains and every cache
 * live in `ctx` (this evaluation) or in the committed `IncrementalState`.
 */
function prepareChartCtx(
  chart: CompiledChart,
  input: RuntimeInput = {},
  txn: EvalTxn = { prev: undefined, gen: 1, claimed: new Set() },
  /** Whether `input.width`/`input.height` is a size someone chose (the host or a fit resize), not just the resolved default. */
  explicitSize: { width: boolean; height: boolean } = { width: input.width != null, height: input.height != null },
  /** The view size signals as written, negative included (see {@link signedViewSize}): the first autosize pass reads them so. */
  signed?: { width?: number; height?: number },
  /** Present when the view makes more than one dataflow pass: what the pass before it left (see `PassMemory`). */
  passMemory?: PassMemory,
): { ctx: EvalContext; width: number; height: number } {
  // The deadline belongs to the enclosing limits scope (evaluateChart /
  // getChartInfo / renderSpec / session), so one wall clock covers the whole
  // call -- the `fit` loop re-enters this function per iteration and must not
  // restart the budget (C7).
  const meter = activeMeter()
  const deadline = meter?.clock.deadline ?? undefined
  const checkDeadline = (phase = 'evaluation'): void => {
    if (meter) meter.clock.check(phase)
  }
  checkDeadline('startup')
  const signals = dict(chart.signals, input.signals)
  let width = signed?.width ?? resolveSize(chart.width, viewOverride(chart, input, 'width'), signals)
  // A Vega spec can define the chart height as a `height` signal (a special
  // signal that doubles as the view size), e.g. `signals:[{name:'height',
  // update: ...}]`, without a top-level numeric height. It's resolved later by
  // resolveSignalUpdates, so apply the fallback after that (see below).
  let height = signed?.height ?? resolveSize(chart.height, viewOverride(chart, input, 'height'), signals)
  // (`padding` is the view's own signal like `width` and `height`: the spec's padding, as vega-parser normalises it)
  const signalParams = dict<unknown>({ width, height, padding: { ...chart.padding } }, signals)
  // A signal the spec declares without a value (it is written by a handler later) exists, with the value undefined
  // (vega-parser refuses a reference to a name that is no signal, not one that holds nothing yet)
  for (const def of chart.signalDefs ?? []) if (!(def.name in signalParams)) signalParams[def.name] = undefined
  // An explicit view size (the host's `width` / `height`, a measured container, the fit loop's resize) is the
  // size, so the `width` / `height` signals read it too: a signal value a host or the event loop supplied
  // (a `window:resize` handler re-running `containerSize()`) must not split the signal from the view it sizes.
  if (explicitSize.width && input.width != null) signalParams.width = width
  if (explicitSize.height && input.height != null) signalParams.height = height

  const datasets = new Map<string, Row[]>()
  const setData: SetDataState = { rows: new Map(), changed: false, caller: undefined }
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
    projection: (name) => transformProjections.get(name),
    tree: (name) => {
      const root = transformHierarchies.get(name)
      return root === undefined ? undefined : { root, rows: datasets.get(name) ?? [] }
    },
    ...(input.random ? { random: input.random } : {}),
    setdata: makeSetdata(chart, setData),
    containerSize: () => {
      const c = input.containerSize ?? input.measuredSize
      return c ? [c.width, c.height] : [undefined, undefined]
    },
    expr: (expr) => {
      let compiled = exprCache.get(expr)
      if (!compiled) {
        compiled = compileExpr(expr, runtime)
        exprCache.set(expr, compiled)
      }
      return compiled
    },
  }

  const transformProjections = new ProjectionRegistry()
  const transformHierarchies = new Map<string, unknown>()
  const defs: SceneDef[] = []
  // Inputs besides the signals that change what a reused scale/item would be.
  const extraFp = `${input.domainRaw ? valueKey(input.domainRaw) : ''}\u0002${input.textMetrics ? valueKey(input.textMetrics) : ''}\u0002${input.containerSize ? `${input.containerSize.width}x${input.containerSize.height}` : ''}\u0002${input.measuredSize ? `${input.measuredSize.width}x${input.measuredSize.height}` : ''}`
  const ctx: EvalContext = {
    chart, scope: rootScope(chart), abort: { failures: [] }, ...(passMemory !== undefined ? { passMemory } : {}), signalParams, width, height, datasets, setData, scales, scaleTypes, projections: transformProjections, projectionStamp: new Map(), projectionIncomplete: new Set(), geoStale: false, runtime, _defs: defs,
    layoutState: { failed: false }, initDone: new Set(), hostSignals: new Set([
      ...Object.keys(input.signals ?? {}),
      // an explicit view size (the host's, or the fit loop's resize) wins over an `init`
      ...(explicitSize.width ? ['width'] : []), ...(explicitSize.height ? ['height'] : []),
    ]),
    hierarchies: transformHierarchies, affected: new Set(), incremental: false, deadline, checkDeadline, markItems: new Map(), markContainers: new Map(),
    datasetPulses: new Map(),
    prev: txn.prev, draft: newState(txn.gen), gen: txn.gen, claimed: txn.claimed, extraFp, dsEpoch: 0, scaleReuse: new Map(), distinctCache: new WeakMap(),
    domainRaw: input.domainRaw ? new Map(Object.entries(input.domainRaw).map(([k, v]) => [k, v])) : undefined,
    // Image urls are vetted when the host passes a policy, and with the default
    // policy whenever it passes `limits` (limits mean "this spec is untrusted").
    // With neither they are drawn as given, as Vega does: an SVG <image> cannot
    // run script, but a hostile spec can still make the viewer fetch an arbitrary
    // url (tracking pixel, IP leak). Hosts rendering foreign specs must opt in.
    urlPolicy: input.urlPolicy ?? (input.limits ? {} : undefined),
    logger: input.logger ?? consoleLogger,
  }
  // The event loop shows a dataset it modified through its transform pipeline, before the next evaluation
  // computes it (the rows of a modified selection store, sorted by its `collect`, for example).
  // (It must not close over `ctx`: that reaches the previous evaluation's state, and a scene would keep every
  // scene before it alive.)
  runtime.transformed = makeTransformed(chart, runtime, signalParams, transformHierarchies, transformProjections)
  // A non-integer `columns` makes the symbol-legend grid layout throw: the ViewLayout never completes and
  // the whole scene renders at raw encode positions (a legend whose entries cannot be made is an aborted
  // pass in its scope instead: see axisTicksFailed).
  ctx.rawGuides = chart.legends.some((l) => {
    // A non-integer/negative `columns` makes vega's symbol-legend gridLayout
    // throw (Array(columns) with a length that is not a valid uint32-ish int).
    // Gradient legends do not lay entries out in a grid and ignore columns.
    if (l.own?.gradientLength == null && typeof l.columns === 'number'
      && (l.columns > 0 ? !Number.isInteger(l.columns) : l.columns !== 0)) return true
    return false
  })
  // Normalise every caller-supplied change description into one pulse per
  // source dataset. `dataChanges` is the same-length form (`{changed}`);
  // `dataPulse` carries the full mapping and wins when both name a dataset.
  const inputPulses = new Map<string, StepPulse>()
  for (const [name, idxs] of Object.entries(input.dataChanges ?? {})) inputPulses.set(name, { changed: [...idxs] })
  for (const [name, p] of Object.entries(input.dataPulse ?? {})) {
    inputPulses.set(name, {
      changed: p.changed ?? [],
      ...(p.from ? { from: p.from } : {}),
      ...(p.to ? { to: p.to } : {}),
      ...(p.added ? { added: p.added } : {}),
      ...(p.removed ? { removed: p.removed } : {}),
      ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
    })
  }
  if (inputPulses.size) ctx.inputPulses = inputPulses
  const changedNames = new Set([...(input.changedDatasets ?? []), ...inputPulses.keys()])
  ctx.affected = affectedDatasets(chart, changedNames)
  // Incremental reuse needs both a statement of what changed and a previous
  // state to be incremental FROM; otherwise everything re-derives (and the
  // fresh state is still recorded for the next call).
  ctx.incremental = changedNames.size > 0 && txn.prev !== undefined

  // Resolve signal `update` expressions, datasets, and scales to a fixed
  // point. Signals can reference data/scales and vice versa (e.g. brush-bounded
  // domains), which vega handles reactively; we emulate the initial pulse.
  buildProjections(ctx)
  // Signals that depend on nothing but other signals and the view size resolve
  // BEFORE the first dataset build: building datasets under still-unresolved
  // derived signals is pure waste (the loop below rebuilds them), and would
  // also make the first pass's params differ from the previous evaluation's, so
  // it could never be incremental.
  for (let i = 0; i < 3 && resolveSignalUpdates(ctx, true); i++) { /* to a fixed point */ }
  buildDatasets(ctx, input.data ?? {})
  const readsScales = datasetsReadScales(chart)
  let changed = true
  let rounds = 0
  while (changed && rounds < 3) {
    // (a map whose projection was consumed before the `geojson` signals it fits were published builds again)
    const geoStale = ctx.geoStale
    ctx.geoStale = false
    changed = resolveSignalUpdates(ctx) || geoStale || (rounds === 0 && readsScales) || ctx.setData.changed
    ctx.setData.changed = false
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
    const update = (def?.update ?? def?.init) as string | undefined
    // a width the host set (setSignal / input.signals) is the signal's value; its init never runs over it
    const hosted = ctx.hostSignals.has('width') ? ctx.signalParams.width : undefined
    if (typeof update === 'string' || typeof hosted === 'number') {
      try {
        const v = typeof hosted === 'number' ? hosted : ctx.runtime.expr(update as string)({}, ctx.signalParams) as unknown
        if (typeof v === 'number' && Number.isFinite(v)) {
          width = v
          ctx.width = v
          ctx.signalParams.width = v
          ctx.fpMemo = undefined
          buildScales(ctx)
        }
      } catch { /* leave the default */ }
    }
  }
  buildProjections(ctx)
  // (a view size that is the signal that threw is the signal's value, none: 0)
  const threw = abortAtThrowingSignal(ctx)
  if (threw === 'width') { width = 0; ctx.width = 0 }
  if (threw === 'height') { height = 0; ctx.height = 0 }
  abortAtThrowingProjection(ctx)

  // The final context fingerprint: the next evaluation compares its own
  // (scale, mark) inputs against this to decide whether reuse is valid.
  ctx.draft.fp = ctxFpOf(ctx)

  return { ctx, width, height }
}

/** What `setdata(name, tuples)` calls put in the datasets' inputs during one evaluation (see {@link makeSetdata}). */
interface SetDataState {
  rows: Map<string, Row[]>
  /** the rows changed since the datasets were last built */
  changed: boolean
  /** the signal whose update expression is being evaluated: `setdata` asks who calls it */
  caller: string | undefined
}

/**
 * `ExpressionRuntime.setdata` for one evaluation. A module-level factory, like {@link makeTransformed}: a closure made inside
 * `prepareChartCtx` would share its context with the evaluation's state and keep the previous scenes alive.
 */
function makeSetdata(chart: CompiledChart, state: SetDataState): NonNullable<ExpressionRuntime['setdata']> {
  return (name, tuples) => {
    // vega reads `data.input` of the named dataset, which a dataset that does not exist does not have
    if (!chart.data.some((x) => x.name === name)) throw new TypeError(`Cannot read properties of undefined (reading 'input')`)
    // vega-dataflow enqueues an operator only once per run: a signal ranked after the dataset's input (it reads the dataset, or
    // something derived from it) calls setdata when the input has already run in this first pass, so its pulse is lost
    if (state.caller !== undefined && signalRanksAfterDatasetInput(chart, state.caller, name)) return 1
    const rows = ingestRows((Array.isArray(tuples) ? tuples : tuples == null ? [] : [tuples]) as Row[]).map((r) => ({ ...r }))
    const have = state.rows.get(name)
    if (have === undefined || contentKey(have) !== contentKey(rows)) {
      state.rows.set(name, rows)
      state.changed = true
    }
    return 1
  }
}

/**
 * `ExpressionRuntime.transformed` for one evaluation. A module-level factory, so the closure's context holds exactly these
 * arguments: a closure made inside `prepareChartCtx` shares that function's context with its other closures, which reach
 * the evaluation's state (and, through the incremental state, the previous scenes), and the scene would keep them alive.
 */
function makeTransformed(
  chart: CompiledChart,
  runtime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  hierarchies: Map<string, unknown>,
  projections: ProjectionRegistry,
): NonNullable<ExpressionRuntime['transformed']> {
  return (name, raw) => {
    const d = chart.data.find((x) => x.name === name)
    const rows = d?.values != null ? readData(raw as never, d.format) : ingestRows(raw as Row[]).map((r) => ({ ...r }))
    if (!d?.transform.length) return rows
    return applyTransforms(rows, d.transform, { runtime, signals: signalParams, hierarchies, projections }, name)
  }
}

/**
 * What a random-drawing site read, for {@link atRandomSite}: its code (an expression, or a transform's parameters), the rows it was
 * given when it has any, and the value of every signal its code mentions. The same fingerprint is the same inputs, whose numbers
 * vega would not have redrawn.
 */
function randomFingerprint(code: unknown, rows: readonly unknown[] | Record<string, unknown>, signals: Record<string, unknown>): string {
  const text = typeof code === 'string' ? code : JSON.stringify(code)
  const mentioned = new Set(text.match(IDENT))
  const read: string[] = []
  for (const k of Object.keys(signals).sort()) if (mentioned.has(k)) read.push(`${k}=${contentKey(signals[k])}`)
  return `${text}\u0001${Array.isArray(rows) ? contentKey(rows) : ''}\u0001${read.join('\u0002')}`
}

/** A dataset's inline `values`: the array, or what a `{signal}` holds (vega-parser: a signal-valued `values` loads dynamically). */
function inlineValues(ctx: Pick<EvalContext, 'runtime' | 'signalParams'>, values: unknown): unknown {
  const expr = values !== null && typeof values === 'object' && !Array.isArray(values) ? (values as { signal?: unknown }).signal : undefined
  if (typeof expr !== 'string') return values
  return ctx.runtime.expr(expr)(undefined, ctx.signalParams)
}

/** An item without the bookkeeping of the engine (`__gen` and the like): what a transform of the mark can read of it. */
function publicProps(item: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(item as object)) if (!k.startsWith('__')) out[k] = (item as Record<string, unknown>)[k]
  return out
}

/** Fingerprint of the evaluation context that reused scales/items were built under. */
function ctxFpOf(ctx: EvalContext): string {
  // Memoised: the params only change at the few known write sites, each of
  // which clears the memo (resolveSignalUpdates, the width re-resolution, and
  // the end of every dataset pass, since transforms may write signals).
  return ctx.fpMemo ??= `${paramFpOf(ctx.signalParams)}\u0002${ctx.extraFp}`
}

/**
 * vega-parser `parseParameter`: a projection parameter with every `{signal}`
 * (also inside arrays, e.g. a `clipExtent`) replaced by its value. `fit` may be a
 * GeoJSON object itself (left as is) or a signal such as `data("source_0")`.
 */
function resolveProjectionParam(ctx: EvalContext, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveProjectionParam(ctx, x))
  if (v && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string') {
    try {
      return ctx.runtime.expr((v as { signal: string }).signal)({}, ctx.signalParams)
    } catch {
      // The signal reads a dataset or scale that does not exist yet; the next pass resolves it.
      return undefined
    }
  }
  return v
}

/** Build the d3-geo projection one compiled definition describes, in the current context. */
function buildProjectionOf(ctx: EvalContext, p: CompiledProjection): unknown {
  const build = requireGeo() // throws an actionable error if the geo addon is absent
  // (the type is a parameter like any other: `type: {signal: "projectionName"}`)
  const resolved: Record<string, unknown> = dict<unknown>({ name: p.name, type: resolveProjectionParam(ctx, p.type) })
  for (const k of Object.keys(p)) {
    if (k === 'name' || k === 'type') continue
    resolved[k] = resolveProjectionParam(ctx, p[k])
  }
  // A fit over several sources (`[data('a'), geojson_0]`) is not resolvable until every source exists
  // (vega's dataflow runs the geojson transform first): the next pass resolves it.
  let incomplete = p.fit != null && resolved.fit == null
  if (Array.isArray(resolved.fit) && resolved.fit.some((f) => f == null)) {
    resolved.fit = undefined
    incomplete = true
  }
  if (incomplete) ctx.projectionIncomplete.add(p.name)
  else ctx.projectionIncomplete.delete(p.name)
  return build(resolved as never, ctx.width, ctx.height)
}

/**
 * Build the projections (vega-geo's Projection transform). A projection that
 * `fit`s a dataset depends on that dataset, which may not exist yet in the early
 * passes: such a projection is rebuilt whenever the set of built datasets has
 * changed since (see `refreshProjection`), and once more at the end of preparation.
 */
function buildProjections(ctx: EvalContext): void {
  ctx.projectionError = undefined
  if (!ctx.chart.projections?.length) return
  for (const p of ctx.chart.projections) {
    try {
      ctx.projections.set(p.name, buildProjectionOf(ctx, p))
    } catch (e) {
      // (vega's Projection transform throws; see abortAtThrowingProjection)
      if (e instanceof Error && e.message.startsWith('[aster]')) throw e
      ctx.projectionError = e
      return
    }
    ctx.projectionStamp.set(p.name, projectionStampOf(ctx))
  }
}

/**
 * A projection of the view that cannot be made (a type vega-projection has not registered) throws in vega's Projection transform,
 * which is ranked right after the view's signals: the dataflow pass stops there, so no dataset, scale, mark or guide is ever made --
 * the view is its frame at the size its signals gave, and the error is logged once.
 */
function abortAtThrowingProjection(ctx: EvalContext): void {
  if (ctx.projectionError === undefined || ctx.datasetAborted) return
  reportEvalError(ctx, ctx.projectionError)
  for (const d of ctx.chart.data) {
    ;(ctx.failedDatasets ??= new Set()).add(d.name)
    ctx.datasets.set(d.name, [])
    ctx.datasetPulses.set(d.name, null)
  }
  ctx.encodeAborted = ctx.datasetAborted = true
}

/**
 * The projections a group mark declares, made for one of its items (vega: its scope's Projection operators, ranked right after the
 * scope's signals; the item's `parent` and signals are in reach: `type: {signal: "parent.data"}`). Over the enclosing scope's, so a
 * `geoshape` in the item finds its own projection by name. One that cannot be made -- a type vega-projection has not registered --
 * throws in vega's Projection transform, which stops the whole pass there: the item and the ones after it keep their frame and make
 * nothing else, and nothing is laid out. The first pass of a build records where (an AbortPoint) and logs it once; the second builds
 * only what vega had made by then.
 */
function scopedProjections(mark: CompiledMark, ctx: EvalContext, params: Record<string, unknown>, path: number[]): { registry?: ProjectionRegistry; failed?: true } {
  if (!mark.projections?.length) return {}
  const outer = ctx.projections as ProjectionRegistry
  const registry = new ProjectionRegistry(outer)
  registry.fitNames = outer.fitNames
  const inScope = { ...ctx, signalParams: params }
  for (const p of mark.projections) {
    try {
      registry.set(p.name, buildProjectionOf(inScope, p))
    } catch (e) {
      // (vega logs the one error that stopped the pass; what the pass would have found after it never ran)
      if (!ctx.abort.failures.length) reportEvalError(ctx, e)
      else if (e instanceof Error && e.message.startsWith('[aster]')) throw e
      ctx.abort.failures.push({ path, axis: 0, projection: true })
      return { registry, failed: true }
    }
  }
  return { registry }
}

/** What a fit projection was built from: the datasets that existed and the fit signals written (geojson transforms). */
function projectionStampOf(ctx: EvalContext): string {
  return `${ctx.datasets.size}:${(ctx.projections as ProjectionRegistry).epoch}`
}

/**
 * Refresh the projection a dataset transform asks for. One that fits data is rebuilt when
 * more datasets exist than when it was last built, so a `geopath`/`geoshape`
 * transform in a later dataset sees the fit to the data built before it.
 */
function refreshProjection(ctx: EvalContext, name: string): void {
  const def = ctx.chart.projections?.find((p) => p.name === name)
  if (!def?.fit) return
  // the datasets the fit reads (vega's dataflow orders them first, whatever the declaration order)
  for (const src of fitDatasets(def.fit)) {
    if (ctx.datasets.has(src) || fitBuilding.has(src)) continue
    fitBuilding.add(src)
    try {
      ctx.buildOnDemand?.(src)
    } finally {
      fitBuilding.delete(src)
    }
  }
  if (ctx.projectionStamp.get(name) !== projectionStampOf(ctx)) {
    ctx.projections.set(name, buildProjectionOf(ctx, def))
    ctx.projectionStamp.set(name, projectionStampOf(ctx))
  }
  // a consumer is about to use a projection that could not see all of its fit: build again afterwards
  if (ctx.projectionIncomplete.has(name)) ctx.geoStale = true
}

/** Datasets whose build is in progress because a projection fit asked for them (a cycle would otherwise recurse). */
const fitBuilding = new Set<string>()

/** The names `data('name')` reads in a projection's `fit` signal. */
function fitDatasets(fit: unknown): string[] {
  const out: string[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string') {
      for (const m of (v as { signal: string }).signal.matchAll(/\bdata\(\s*(['"])(.*?)\1\s*\)/g)) out.push(m[2]!)
    }
  }
  visit(fit)
  return out
}

/** The projections map a dataset transform sees: reads go through `refreshProjection`. */
class ProjectionRegistry extends Map<string, unknown> {
  refresh: ((name: string) => void) | undefined
  /** bumped when a `geojson` transform publishes a value a projection may fit */
  epoch = 0
  /** the projections that fit data (their derived coordinates are not row-local) */
  fitNames: Set<string> | undefined
  touch(): void {
    this.epoch++
  }
  override get(name: string): unknown {
    this.refresh?.(name)
    return super.get(name)
  }
}

/** Expression functions that read datasets or scales (a signal using them cannot resolve before they exist). */
const DATA_DEPENDENT_EXPR = /\b(data|indata|domain|range|scale|bandwidth|bandspace|invert|copy|gradient|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve)\s*\(/

/**
 * Evaluate static signal `update` expressions in declaration order against the
 * current signal params (vega-expression rewrites bare identifiers to the
 * `$`-prefixed params our interpreter binds). Expressions that depend on not-yet
 * resolved values throw and are skipped for this round. Returns whether any
 * value changed (drives the fixed-point loop). Values compare structurally
 * (C57): an unchanged object-valued signal such as `[0, width]` is a fresh array
 * every round and must not count as a change.
 *
 * Resolved values live in `ctx.signalParams` for THIS evaluation only: the
 * compiled chart is never written (C17), so an evaluation is a pure function of
 * (compiled spec, input).
 *
 * `staticOnly` resolves just the signals that do not read datasets or scales.
 */
/** Whether a view signal calls a function that reads data or a scale, or reads a signal that does. */
function signalReadsDataflow(chart: CompiledChart, defs: ReadonlyMap<string, number>, name: string, seen: Set<string>): boolean {
  if (seen.has(name)) return false
  seen.add(name)
  const i = defs.get(name)
  if (i === undefined) return false
  const d = chart.signalDefs![i]!
  for (const text of [d.update, d.init]) {
    if (typeof text !== 'string') continue
    for (const id of expressionIdentifiers(text)) {
      if (DATAFLOW_FUNCTIONS.has(id) || (defs.has(id) && signalReadsDataflow(chart, defs, id, seen))) return true
    }
  }
  return false
}

/**
 * vega runs its signals first, in declaration order, and a signal whose expression throws stops the whole pass: it is logged,
 * the signals after it never get a value and nothing ranked after the signals runs -- every dataset, scale, mark and guide.
 * Resolving signals in rounds, a throw is first "a dependency is not there yet"; the one that is still thrown when the last
 * round has run is a throw -- unless it reads data or a scale (or a signal that does): that is settled only with them, and a
 * throw there is not told from a dependency that is missing; such a signal is left as it was. One that reads a signal declared
 * after it is ranked after the datasets (vega re-ranks it past everything): they and the marks ran.
 */
function abortAtThrowingSignal(ctx: EvalContext): string | undefined {
  const errors = ctx.signalErrors
  if (!errors?.size) return undefined
  const defs = ctx.chart.signalDefs ?? []
  const index = new Map<string, number>()
  defs.forEach((d, i) => { if (!index.has(d.name)) index.set(d.name, i) })
  for (const def of defs) {
    if (!errors.has(def.name) || ctx.hostSignals.has(def.name)) continue
    // (one that reads data or a scale is settled only once they are built, with the signals they feed: not told from a throw)
    if (signalReadsDataflow(ctx.chart, index, def.name, new Set())) continue
    reportEvalError(ctx, errors.get(def.name))
    // (a signal ranked after the datasets throws after them: they and the marks ran, and only the pass's post-run work, the
    // layout that grows the padding, is lost: see the padding of evaluateChartImpl)
    if (signalIsLate(ctx.chart, index, def.name, new Set())) { ctx.postRunLost = true; return undefined }
    ctx.rootUnsized = true
    for (const d of ctx.chart.data) {
      ;(ctx.failedDatasets ??= new Set()).add(d.name)
      ctx.datasets.set(d.name, [])
      ctx.datasetPulses.set(d.name, null)
    }
    ctx.encodeAborted = ctx.datasetAborted = true
    return def.name
  }
  return undefined
}

/**
 * The signals in the order vega's dataflow runs them: an operator after the operators it reads (vega-dataflow ranks by dependency),
 * the others in the order they were declared. A signal that reads one declared after it (`shiftArray` reading `leftRightCount`)
 * would otherwise see the other's value from the pass before, and a chain of them lags a pass per link.
 */
const SIGNAL_ORDERS = new WeakMap<CompiledChart, CompiledSignalDef[]>()
function signalsInDataflowOrder(chart: CompiledChart): CompiledSignalDef[] {
  const defs = chart.signalDefs ?? []
  let out = SIGNAL_ORDERS.get(chart)
  if (out) return out
  const index = new Map(defs.map((d, i) => [d.name, i] as const))
  const reads = defs.map((d, i) => {
    const text = `${d.update ?? ''} ${d.init ?? ''}`
    const deps = new Set<number>()
    for (const m of text.matchAll(IDENT)) {
      const j = index.get(m[0])
      if (j !== undefined && j !== i) deps.add(j)
    }
    return deps
  })
  const placed = new Set<number>()
  out = []
  while (out.length < defs.length) {
    // the first declared signal whose reads are all placed; in a cycle, the first declared one left
    let pick = -1
    for (let i = 0; i < defs.length && pick < 0; i++) {
      if (!placed.has(i) && [...reads[i]!].every((j) => placed.has(j))) pick = i
    }
    if (pick < 0) pick = defs.findIndex((_, i) => !placed.has(i))
    placed.add(pick)
    out.push(defs[pick]!)
  }
  SIGNAL_ORDERS.set(chart, out)
  return out
}

/**
 * Whether signal `name` is evaluated after dataset `dataset`'s input in a dataflow run: it reads the dataset's rows (`data('x')`,
 * `indata`), or a dataset derived from it, or a signal that does -- through its update, its init, or the handlers of its streams.
 * vega ranks an operator after everything it reads, and the input of a dataset with no source is the first operator of its pipeline.
 */
function signalRanksAfterDatasetInput(chart: CompiledChart, name: string, dataset: string): boolean {
  const defs = new Map((chart.signalDefs ?? []).map((d) => [d.name, d] as const))
  const sources = new Map(chart.data.map((d) => [d.name, sourceNames(d)] as const))
  const derivesFrom = (ds: string, seen = new Set<string>()): boolean => {
    if (ds === dataset) return true
    if (seen.has(ds)) return false
    seen.add(ds)
    return (sources.get(ds) ?? []).some((s) => derivesFrom(s, seen))
  }
  const seen = new Set<string>()
  const visit = (sig: string): boolean => {
    if (seen.has(sig)) return false
    seen.add(sig)
    const d = defs.get(sig)
    if (d === undefined) return false
    const texts: string[] = [d.update, d.init].filter((t): t is string => typeof t === 'string')
    for (const h of d.on ?? []) {
      texts.push(JSON.stringify(h.events))
      const u = h.update
      if (typeof u === 'string') texts.push(u)
      else if (u !== undefined) texts.push(...[u.expr, u.signal].filter((t): t is string => typeof t === 'string'))
    }
    for (const text of texts) {
      for (const m of text.matchAll(DATA_READ_CALL_ALL)) if (derivesFrom(m[2]!)) return true
      for (const id of text.match(IDENT) ?? []) if (id !== sig && defs.has(id) && visit(id)) return true
    }
    return false
  }
  return visit(name)
}

function resolveSignalUpdates(ctx: EvalContext, staticOnly = false): boolean {
  const defs = ctx.chart.signalDefs
  if (!defs?.length) return false
  let changed = false
  for (const def of signalsInDataflowOrder(ctx.chart)) {
    // `init` runs once (vega's initonly), never over a value the host or an
    // event handler already set.
    const initPending = def.update === undefined && def.init !== undefined
      && !ctx.initDone.has(def.name) && !ctx.hostSignals.has(def.name)
    const expr = def.update ?? (initPending ? def.init : undefined)
    if (!expr) continue
    // a signal with `update` AND `on` handlers is a state: an event set it, and its update is not run again until what it reads
    // pulses (the event loop, which runs that dataflow, writes it down when it does); the store's value is the signal's
    if (def.update !== undefined && def.on?.length && ctx.hostSignals.has(def.name)) continue
    // ... and a derived signal the event loop holds as it was keeps the value the store has (see `heldSignalName`)
    if (def.update !== undefined && ctx.hostSignals.has(heldSignalName(def.name))) continue
    if (staticOnly && DATA_DEPENDENT_EXPR.test(expr)) continue
    // an `init` that reads scales (a selection's initial brush: `[scale("x", 2), scale("x", 4)]`) runs once the scales exist:
    // before that `scale()` of a missing scale is `undefined`, which would be taken for the initial value
    if (initPending && SCALE_FN_EXPR.test(expr) && !ctx.chart.scales.every((sc) => ctx.scales.has(sc.name))) continue
    try {
      // (a `react: false` signal in a cycle through a scale runs before the signals it reads: it sees their initial values)
      const frozen = def.react === false ? frozenReadsOf(ctx.chart).get(def.name) : undefined
      let params = ctx.signalParams
      if (frozen !== undefined) {
        params = dict(ctx.signalParams)
        for (const f of frozen) params[f] = ctx.chart.signalDefs!.find((d) => d.name === f)?.value
      }
      ctx.setData.caller = def.name
      const value = ctx.runtime.random === undefined
        ? ctx.runtime.expr(expr)(undefined, params)
        : atRandomSite(ctx.runtime.random, `signal:${def.name}`, () => randomFingerprint(expr, [], params), () => ctx.runtime.expr(expr)(undefined, params))
      // An `init` that reads a scale or a dataset is only settled once they exist: until the scales are built,
      // `domain('x')` of a scale that is not there yet is `[]`, which is not the value vega's dataflow computes.
      const readsScales = DATA_DEPENDENT_EXPR.test(expr) && ctx.scales.size === 0 && ctx.chart.scales.length > 0
      if (initPending && value !== undefined && !readsScales) ctx.initDone.add(def.name)
      ctx.setData.caller = undefined
      ctx.signalErrors?.delete(def.name)
      if (value !== undefined && !valuesEqual(value, ctx.signalParams[def.name])) {
        ctx.signalParams[def.name] = value
        ctx.fpMemo = undefined
        changed = true
      }
    } catch (e) {
      ctx.setData.caller = undefined
      // Unresolved dependency this round; keep previous value. (What is still thrown once everything the expression can
      // read exists is a throw, not a dependency that is missing: see abortAtThrowingSignal.)
      ;(ctx.signalErrors ??= new Map()).set(def.name, e)
    }
  }
  return changed
}


// ===========================================================================
// Shared axis/legend + padding computation — used by both evaluateChart and getChartInfo
// ===========================================================================

/** Resolve a guide string/signal value for accessibility metadata. */
function guideString(ctx: EvalContext, value: unknown): string | undefined {
  if (typeof value === 'string') return value
  // (a numeric format is read as the specifier of its digits, like d3: `42` is a width of 42)
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && typeof (value as { signal?: unknown }).signal === 'string') {
    try {
      const v = ctx.runtime.expr(String((value as { signal: string }).signal))({}, ctx.signalParams)
      return v == null ? undefined : String(v)
    } catch { return undefined }
  }
  return undefined
}

/** A guide number that may be a `{signal}` (undefined when absent or not a number). */
function guideNumber(ctx: EvalContext, value: unknown): number | undefined {
  if (value && typeof value === 'object' && typeof (value as { signal?: unknown }).signal === 'string') {
    try { value = ctx.runtime.expr((value as { signal: string }).signal)({}, ctx.signalParams) } catch { return undefined }
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

/** vega-view-transforms layoutGroup: the child roles whose bounds union into BOTH anchor bounds of the guide layout. */
const VIEW_ROLES: ReadonlySet<string> = new Set(['frame', 'scope', 'row-header', 'row-footer', 'row-title', 'column-header', 'column-footer', 'column-title'])

function buildAxisAndLegend(
  ctx: EvalContext,
  contentItems: SceneGroup[],
  axes: CompiledAxis[] = ctx.chart.axes,
  legends: CompiledLegend[] = ctx.chart.legends,
): { groups: SceneGroup[] } {
  const groups: SceneGroup[] = []
  // (the pass stopped at a failing dataset: no axis or legend was made)
  if (ctx.datasetAborted) return { groups }
  // vega's layoutGroup walks the content children together with the guides:
  // the anchor bounds scan the content items too.
  const anchorItems = [...contentItems]

  for (const [axisIndex, axis0] of axes.entries()) {
    const axis = resolveAxisOrient(axis0, ctx)
    const group = buildAxis(axis, ctx, axisIndex)
    if (group) {
      // Carry guide identity for the accessible tree (R10.6) without changing
      // the serialized SVG: the fields are scene metadata only.
      const meta = group as unknown as { zindex?: number; orient?: string; scale?: string; title?: string; aria?: boolean; grid?: boolean; format?: string; formatType?: string }
      // (the mark definition reads these as written -- vega-parser marks/definition.js: `+zindex || undefined`, `aria`,
      // `description` -- so a signal object is not looked into: its zindex is none, its description is the object)
      const zindex = +(axis.zindex as number) || undefined
      if (zindex) meta.zindex = zindex
      // (the caption reads the axis group item's own orient, which a user encode may have changed)
      meta.orient = (typeof axis.orient === 'string' ? ((group as unknown as { axis?: { itemOrient?: string } }).axis?.itemOrient ?? axis.orient) : axis.orient)
      meta.scale = axis.scale
      meta.aria = axis.aria
      meta.grid = guideScalar(ctx, axis.grid) === true
      meta.format = guideString(ctx, axis.format)
      meta.formatType = guideString(ctx, axis.formatType)
      const at = guideTitle(ctx, axis.title)
      if (at) meta.title = at
      // the axis' `description` is the aria-label of its container (vega-scenegraph ariaGuide: mark.description first)
      const adesc = (axis as { description?: unknown }).description
      if (adesc) group.description = adesc as string
      groups.push(group)
      anchorItems.push(group)
    }
  }

  // Vega's legend layout (layoutGroup + legendParams + gridLayout): build each
  // legend at local (0,0), then position the orient groups with the grid
  // algorithm — vertical stacking for left/right (one column), a horizontal
  // row for top/bottom/none-direction (one row), anchored outside the axis
  // bounds with the 18px offset and an 8px margin between legends.
  // (vega has no legend `disable`: that is a Vega-Lite config key, which the VL
  // compiler resolves by omitting the legend. A config.legend.disable merged into
  // a legend that VL kept must not remove it.)
  type LegendProps = { orient?: unknown; offset?: unknown; x?: unknown; y?: unknown }
  const built = legends
    .map((legend, legendIndex) => {
      const group = buildLegend(legend, ctx, legendIndex)
      if (group) {
        // (the mark definition reads these as written -- vega-parser marks/definition.js: `+zindex || undefined`,
        // `aria`, `description` -- so a signal object is not looked into)
        const zindex = +(legend.zindex as number) || undefined
        if (zindex) (group as unknown as { zindex?: number }).zindex = zindex
        // `aria: false` removes the legend from the accessibility tree (and marks it aria-hidden)
        ;(group as unknown as { aria?: boolean }).aria = (legend as { aria?: boolean }).aria
        const lt = guideTitle(ctx, legend.title)
        if (lt) (group as unknown as { title?: string }).title = lt
        const ldesc = (legend as { description?: unknown }).description
        if (ldesc) group.description = ldesc as string
        const g = group as unknown as {
          legendScale?: string; legendChannels?: string[]; legendType?: string
          legendFormat?: string; legendFormatType?: string
        }
        // vega-parser LegendScales: the channels in priority order (the first is the canonical scale)
        const own = (legend.own ?? {}) as Record<string, unknown>
        g.legendChannels = LEGEND_SCALES.filter((k) => !!own[k])
        g.legendScale = g.legendChannels.map((k) => String(own[k]))[0]
        g.legendFormat = guideString(ctx, own.format)
        g.legendFormatType = guideString(ctx, own.formatType)
        // (the legend type is the kind of legend the builder drew: gradient, discrete bands or symbols)
      }
      return { legend, group, props: ((group as unknown as { legendProps?: LegendProps } | null)?.legendProps ?? {}) as LegendProps }
    })
    .filter((x): x is { legend: CompiledLegend; group: SceneGroup; props: LegendProps } => x.group !== null)
    // A legend whose entries failed to build (an invalid tickCount interval
    // string) degenerates to a zero-size group with no items: vega still
    // creates it, but it renders nothing and takes no layout space.
    // (a legend only waiting for its entries is a group like any other)
    .filter((x) => ctx.pendingEntries || !(x.group.width === 0 && x.group.height === 0 && (x.group.items?.length ?? 0) === 0))

  if (built.length) {
    // legendParams anchors on the axis bounds only: xBounds unions the
    // vertical (left/right) axes, yBounds the horizontal ones; marks live in
    // viewBounds and never reach the anchor.
    const layoutW = Math.max(0, ctx.width)
    const layoutH = Math.max(0, ctx.height)
    let xb = { x1: 0, y1: 0, x2: layoutW, y2: layoutH }
    let yb = { x1: 0, y1: 0, x2: layoutW, y2: layoutH }
    for (const g of anchorItems) {
      // vega's getRole: every top-level group-typed mark is a scope and
      // unions into BOTH anchor bounds; axis marks split by orientation.
      if (g.marktype === 'group' && (g.role === 'scope' || g.role === 'mark' || ((g as Record<string, unknown>)._scope === true && VIEW_ROLES.has(String(g.role))))) {
        // vega's scope bound is the recursive child union (plus the group
        // rect) — clipped cells still measure their children.
        const b = (g as Record<string, unknown>)._scope === true ? layoutBounds(g) : boundGroupItem(new Bounds(), g)
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
    const byOrient = new Map<string, { legend: CompiledLegend; group: SceneGroup; props: LegendProps }[]>()
    for (const x of built) {
      const orient = String(x.props.orient ?? 'right')
      // (a legend whose entries were never made has nothing to lay out: it stays where its encode put it)
      if ((x.group as unknown as { _entriesPending?: boolean })._entriesPending) continue
      if (orient === 'none') {
        // legendLayout leaves an `orient: none` legend where its x / y encode put it
        // (legendX / legendY); every other orient is zeroed and placed by the grid
        const lx = guideNumber(ctx, x.props.x)
        const ly = guideNumber(ctx, x.props.y)
        if (lx !== undefined) x.group.x = lx
        if (ly !== undefined) x.group.y = ly
        continue
      }
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
      // legendParams (vega-view-transforms layout/legend.js): `config.legend.layout`, the orient's own block over the general one
      const layoutCfg = (ctx.chart.legendLayout ?? {}) as Record<string, unknown>
      const orientCfg = (layoutCfg[orient] ?? {}) as Record<string, unknown>
      const cfgOf = (key: string, d?: unknown): unknown => (orientCfg[key] != null ? orientCfg[key] : layoutCfg[key] != null ? layoutCfg[key] : d)
      // if legends specify an offset directly, the maximum is used
      let specOffset: number | undefined = undefined
      for (const x of list) {
        const o = x.props.offset
        if (typeof o === 'number') specOffset = specOffset === undefined ? o : Math.max(specOffset, o)
      }
      const offset = specOffset ?? (cfgOf('offset', 0) as number)
      const anchor = cfgOf('anchor', 'start')
      const frame = cfgOf('frame', 'group')
      const mult = anchor === 'end' ? 1 : anchor === 'middle' ? 0.5 : 0
      const W = layoutW
      const H = layoutH
      const ax = frame === 'bounds' ? xb.x1 + mult * (xb.x2 - xb.x1) : mult * (W || (yb.x2 - yb.x1) + 2 * yb.x1)
      const ay = frame === 'bounds' ? yb.y1 + mult * (yb.y2 - yb.y1) : mult * (H || (xb.y2 - xb.y1) + 2 * xb.y1)
      const margin = cfgOf('margin', 8) as number
      const full = cfgOf('bounds', 'flush') !== 'flush'
      const center = cfgOf('center')
      const centerOf = (key: 'column' | 'row'): unknown => {
        const v = center !== null && typeof center === 'object' ? (center as Record<string, unknown>)[key] : center
        return v != null ? v : 0
      }
      // gridLayout: one column when the direction is vertical, else a row; align `each`
      const ncols = cfgOf('direction') === 'vertical' ? 1 : n
      const nrows = Math.max(1, Math.ceil(n / ncols))
      // the boxes: the flush ones (legendLayout sized each legend to ceil(childBounds + 2*padding): our group.width / height), or
      // the legend's own bounds relative to its origin
      const boxes = list.map((x) => {
        if (!full) return { x1: 0, y1: 0, x2: x.group.width || 0, y2: x.group.height || 0 }
        const lb = boundLegendGroup(x.group)
        return lb.empty() ? { x1: 0, y1: 0, x2: 0, y2: 0 } : { x1: lb.x1 - (x.group.x || 0), y1: lb.y1 - (x.group.y || 0), x2: lb.x2 - (x.group.x || 0), y2: lb.y2 - (x.group.y || 0) }
      })
      const xOffset = boxes.map((b) => margin + (b.x1 < 0 ? Math.ceil(-b.x1) : 0))
      const yOffset = boxes.map((b) => margin + (b.y1 < 0 ? Math.ceil(-b.y1) : 0))
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
      // centering (the legends are at x = y = 0 here)
      if (centerOf('column') && nrows > 1) {
        for (let i = 0; i < n; i++) {
          const x = xExtent[i % ncols]! - boxes[i]!.x2 - dx[i]!
          if (x > 0) dx[i]! += x / 2
        }
      }
      if (centerOf('row') && ncols !== 1) {
        for (let i = 0; i < n; i++) {
          const y = yExtent[~~(i / ncols)]! - boxes[i]!.y2 - dy[i]!
          if (y > 0) dy[i]! += y / 2
        }
      }
      // laid-out block bounds (the boxes translated by dx/dy)
      let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity
      boxes.forEach((b, i) => {
        bx1 = Math.min(bx1, b.x1 + dx[i]!)
        by1 = Math.min(by1, b.y1 + dy[i]!)
        bx2 = Math.max(bx2, b.x2 + dx[i]!)
        by2 = Math.max(by2, b.y2 + dy[i]!)
      })
      const bw = bx2 - bx1
      const bh = by2 - by1

      // the anchor of the grid: where it sits, and which of its edges that point is
      let x: number
      let y: number
      let column: unknown = 'start'
      let row: unknown = 'start'
      switch (orient) {
        case 'left': x = Math.floor(xb.x1) - offset; column = 'end'; y = ay; row = anchor; break
        case 'right': x = Math.ceil(xb.x2) + offset; y = ay; row = anchor; break
        case 'top': y = Math.floor(yb.y1) - offset; row = 'end'; x = ax; column = anchor; break
        case 'bottom': y = Math.ceil(yb.y2) + offset; x = ax; column = anchor; break
        case 'top-left': x = offset; y = offset; break
        case 'top-right': x = W - offset; y = offset; column = 'end'; break
        case 'bottom-left': x = offset; y = H - offset; row = 'end'; break
        case 'bottom-right': x = W - offset; y = H - offset; column = 'end'; row = 'end'; break
        default: x = Math.ceil(xb.x2) + offset; y = ay; row = anchor; break
      }
      if (column === 'end') x -= bw
      else if (column === 'middle') x -= bw / 2
      if (row === 'end') y -= bh
      else if (row === 'middle') y -= bh / 2
      x = Math.round(x)
      y = Math.round(y)
      list.forEach((x1, i) => {
        x1.group.x = x + dx[i]!
        x1.group.y = y + dy[i]!
      })
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
  // a laid-out group / legend / typed mark: the bounds vega's Bound pass leaves on it
  const bounds = layoutBounds(g)
  if (cacheable) GROUP_BOUNDS.set(g, bounds)
  return bounds
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

  const grow = (b: Bounds, group: SceneGroup): void => {
    if (b.empty()) return
    // Axis bounds carry fp residue from measured label/title geometry where
    // vega's arithmetic is exact; collapse only that sub-ulp residue. Mark and
    // legend geometry is exact enough that a genuine positive residue (a bar
    // whose right edge is the view width) must still grow the margin.
    // (an axis's bounds are the exact arithmetic of vega's own: no guard)
    const ei = 0
    minX = Math.min(minX, b.x1 + ei)
    maxX = Math.max(maxX, b.x2 - ei)
    minY = Math.min(minY, b.y1 + ei)
    maxY = Math.max(maxY, b.y2 - ei)
  }
  // a mark's `clip` bounds the mark to the frame it sits in (vega boundClip), a group mark across all its items
  if (hasClippedMark(items)) eachMarkBounds(items, width, height, (n) => measureGuideGroup(n as SceneGroup), (b, n) => grow(b, n as SceneGroup))
  else for (const group of items) grow(measureGuideGroup(group), group)

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
 * The view's own `encode` (vega-parser parseView: the root group mark's encode): `x` / `y` place the root group inside the padding,
 * the paint channels paint its box over what `config.view` gave it.
 */
function frameEncodeOf(ctx: EvalContext): FrameEncode | undefined {
  const geo = resolveEncodeSet(ctx.chart.frameEncode!, {}, ctx, 'group') as unknown as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const paint: Record<string, unknown> = {}
  const PAINT: Array<[string, string]> = [
    ['fill', 'frameFill'], ['stroke', 'frameStroke'], ['strokeWidth', 'frameStrokeWidth'], ['fillOpacity', 'frameFillOpacity'], ['opacity', 'frameOpacity'],
    ['strokeDash', 'frameStrokeDash'], ['strokeOpacity', 'frameStrokeOpacity'], ['strokeMiterLimit', 'frameStrokeMiterLimit'],
    ['strokeDashOffset', 'frameStrokeDashOffset'], ['strokeCap', 'frameStrokeCap'], ['strokeJoin', 'frameStrokeJoin'], ['cornerRadius', 'frameCornerRadius'], ['clip', 'frameClip'],
  ]
  for (const [from, to] of PAINT) if (geo[from] !== undefined) paint[to] = geo[from]
  return { x: num(geo.x) ?? 0, y: num(geo.y) ?? 0, paint: paint as Partial<SceneRoot> }
}

/** Walk every string reachable in a JSON-ish value (cycle-safe). */
function walkStrings(
  v: unknown,
  visit: (s: string, owner: Record<string, unknown> | null) => void,
  seen = new Set<object>(),
  owner: Record<string, unknown> | null = null,
  visitObject?: (o: Record<string, unknown>) => void,
): void {
  if (typeof v === 'string') { visit(v, owner); return }
  if (v == null || typeof v !== 'object') return
  if (seen.has(v as object)) return
  seen.add(v as object)
  if (Array.isArray(v)) { for (const x of v) walkStrings(x, visit, seen, owner, visitObject); return }
  const rec = v as Record<string, unknown>
  visitObject?.(rec)
  for (const k of Object.keys(rec)) walkStrings(rec[k], visit, seen, rec, visitObject)
}

/** Expression functions that read scales. */
const SCALE_FN_EXPR = /\b(scale|bandwidth|bandspace|invert|domain|range|copy|gradient)\s*\(/
/** Expression functions that read datasets. */
const DATA_FN_EXPR = /\b(data|indata|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve)\s*\(/

/** What a dataset's pipeline reads besides its `source`. */
interface DatasetDeps { names: Set<string>; allData: boolean }
const DATASET_DEPS = new WeakMap<CompiledChart, Map<string, DatasetDeps>>()

function datasetDepsOf(chart: CompiledChart): Map<string, DatasetDeps> {
  let deps = DATASET_DEPS.get(chart)
  if (deps) return deps
  deps = new Map()
  const known = new Set(chart.data.map((d) => d.name))
  for (const d of chart.data) {
    const names = new Set<string>()
    let allData = false
    for (const src of sourceNames(d)) names.add(src)
    // Anything in the pipeline that names another dataset (lookup `from`, ...)
    // or reads datasets from an expression makes this dataset depend on it.
    walkStrings(d.transform, (str) => {
      if (known.has(str) && str !== d.name) names.add(str)
      if (DATA_FN_EXPR.test(str)) allData = true
    })
    deps.set(d.name, { names, allData })
  }
  DATASET_DEPS.set(chart, deps)
  return deps
}

/**
 * The datasets that must be built before `d` because they publish a signal it reads. vega's dataflow orders operators by
 * what they read, so an `extent` / `bin` / `geojson` that writes a signal runs before the transform whose parameter or
 * expression reads it, wherever the two datasets are declared (the signal may also be read through a signal that is
 * computed from it). Reads are found by name in the transforms' parameters and expressions.
 */
/** Whether dataset `a` is derived from `b` (through sources or datasets its transforms name). */
function dependsOn(chart: CompiledChart, a: string, b: string): boolean {
  const deps = datasetDepsOf(chart)
  const seen = new Set<string>()
  const stack = [a]
  while (stack.length) {
    const n = stack.pop()!
    for (const m of deps.get(n)?.names ?? []) {
      if (m === b) return true
      if (!seen.has(m)) { seen.add(m); stack.push(m) }
    }
  }
  return false
}

/** The datasets some `force` transform (a dataset's or a mark's) takes link rows from. */
const FORCE_LINKS = new WeakMap<CompiledChart, Set<string>>()
function forceLinkDatasets(chart: CompiledChart): Set<string> {
  let out = FORCE_LINKS.get(chart)
  if (out) return out
  out = new Set()
  const visit = (transforms: readonly CompiledTransform[] | undefined): void => {
    for (const t of transforms ?? []) {
      if (t.type !== 'force') continue
      // (a malformed list is the force transform's to refuse, with the message of the parameter check)
      const forces = (t as { forces?: unknown }).forces
      if (!Array.isArray(forces)) continue
      for (const f of forces as Array<{ force?: string; links?: unknown } | null>) {
        if (f?.force === 'link' && typeof f.links === 'string') out!.add(f.links)
      }
    }
  }
  const walk = (marks: readonly CompiledMark[] | undefined): void => {
    for (const m of marks ?? []) { visit(m.transform); walk(m.marks) }
  }
  for (const d of chart.data) visit(d.transform)
  walk(chart.marks)
  FORCE_LINKS.set(chart, out)
  return out
}

const SIGNAL_PREREQS = new WeakMap<CompiledChart, Map<string, string[]>>()
/** A call that reads a dataset by the name in its first argument (vega-functions' dataVisitor / selectionVisitor). */
const DATA_READ_CALL = /\b(data|indata|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve)\s*\(\s*["']/
const DATA_READ_CALL_ALL = /\b(data|indata|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve)\s*\(\s*["']([^"']+)["']/g
const IDENT = /[A-Za-z_$][\w$]*/g

function signalPrereqsOf(chart: CompiledChart): Map<string, string[]> {
  let out = SIGNAL_PREREQS.get(chart)
  if (out) return out
  out = new Map()
  const writers = new Map<string, string[]>()
  for (const d of chart.data) {
    for (const t of d.transform ?? []) {
      const sig = (t as { signal?: unknown }).signal
      if (typeof sig === 'string') (writers.get(sig) ?? writers.set(sig, []).get(sig)!).push(d.name)
    }
  }
  if (writers.size || (chart.signalDefs ?? []).some((sd) => DATA_READ_CALL.test(`${sd.update ?? ''} ${sd.init ?? ''}`))) {
    const defs = new Map((chart.signalDefs ?? []).map((sd) => [sd.name, sd] as const))
    const datasetNames = new Set(chart.data.map((d) => d.name))
    const identsOf = (v: unknown, into: Set<string>): void => {
      walkStrings(v, (str) => { for (const m of str.matchAll(IDENT)) into.add(m[0]) })
    }
    for (const d of chart.data) {
      const read = new Set<string>()
      identsOf(d.transform, read)
      if (d.values !== null && typeof d.values === 'object' && !Array.isArray(d.values)) identsOf(d.values, read)
      // a signal computed from other signals reads what they read
      const queue = [...read]
      for (let i = 0; i < queue.length; i++) {
        const sd = defs.get(queue[i]!)
        if (!sd) continue
        const more = new Set<string>()
        identsOf([sd.update, sd.init], more)
        for (const n of more) if (!read.has(n)) { read.add(n); queue.push(n) }
      }
      const first: string[] = []
      for (const n of read) for (const w of writers.get(n) ?? []) if (w !== d.name && !first.includes(w) && !dependsOn(chart, w, d.name)) first.push(w)
      // ... and the datasets a signal it reads is computed from (`vlSelectionResolve("brush_store", ...)`: a bin whose span is the
      // selection's range runs after the store the selection fills)
      for (const n of read) {
        const sd = defs.get(n)
        if (!sd) continue
        for (const text of [sd.update, sd.init]) {
          if (typeof text !== 'string') continue
          for (const m of text.matchAll(DATA_READ_CALL_ALL)) {
            const w = m[2]!
            if (datasetNames.has(w) && w !== d.name && !first.includes(w) && !dependsOn(chart, w, d.name)) first.push(w)
          }
        }
      }
      if (first.length) out.set(d.name, first)
    }
  }
  SIGNAL_PREREQS.set(chart, out)
  return out
}

const READS_SCALES = new WeakMap<CompiledChart, boolean>()

/**
 * Whether some dataset's transforms read a scale (`domain('x')`, `scale('x', v)`): vega ranks such an operator after the scale,
 * so it sees the scale as built; the datasets are built before the scales here, and once more after them.
 */
function datasetsReadScales(chart: CompiledChart): boolean {
  let out = READS_SCALES.get(chart)
  if (out === undefined) {
    out = false
    for (const d of chart.data) walkStrings(d.transform, (str) => { if (SCALE_FN_EXPR.test(str)) out = true })
    READS_SCALES.set(chart, out)
  }
  return out
}

const DATASET_RANKS = new WeakMap<CompiledChart, { rank: Map<string, number>; order: string[] }>()

/**
 * The order vega's dataflow runs the datasets in, and so what a throw stops: operators are ranked in declaration order, and an
 * operator that reads one ranked after it (its source, a dataset a transform names, the writer of a signal it reads) is
 * re-ranked past everything ranked so far, with everything that reads it (vega-dataflow `connect` / `rerank`, in the order
 * vega-runtime connects the parameters). A pass that hits a throwing operator stops: only what is ranked before it has run.
 * At the grain of a dataset: its operators are taken as one (a dataset whose later transform alone reads a forward signal is
 * ranked as a whole).
 */
function datasetRanksOf(chart: CompiledChart): { rank: Map<string, number>; order: string[] } {
  let out = DATASET_RANKS.get(chart)
  if (out) return out
  const names = chart.data.map((d) => d.name)
  const n = names.length
  const rank = new Map<string, number>(names.map((nm, i) => [nm, i + 1] as const))
  const targets = new Map<string, string[]>()
  const deps = datasetDepsOf(chart)
  const prereqs = signalPrereqsOf(chart)
  let counter = n
  for (const name of names) {
    const reads = [...(deps.get(name)?.names ?? []), ...(prereqs.get(name) ?? [])].filter((m) => rank.has(m) && m !== name)
    for (const m of reads) { const t = targets.get(m); if (t) t.push(name); else targets.set(m, [name]) }
    if (!reads.some((m) => rank.get(m)! > rank.get(name)!)) continue
    // rerank(name): the operator and, depth first, everything connected to read it
    const queue = [name]
    // (vega throws on a cycle; here a cycle is reported where the build meets it, so the walk is only bounded)
    for (let pops = 0; queue.length && pops < 4 * n * n + 16; pops++) {
      const cur = queue.pop()!
      rank.set(cur, ++counter)
      const list = targets.get(cur)
      if (list) for (let i = list.length; --i >= 0;) queue.push(list[i]!)
    }
  }
  out = { rank, order: [...names].sort((a, b) => rank.get(a)! - rank.get(b)!) }
  DATASET_RANKS.set(chart, out)
  return out
}

/**
 * The set of datasets affected by a change, closed transitively over every way a
 * dataset depends on another: a `source` chain, a transform naming another
 * dataset (`lookup.from`, ...), or an expression reading datasets. A derived
 * dataset changes whenever anything it reads changes.
 */
function affectedDatasets(chart: CompiledChart, changed: Set<string>): Set<string> {
  const affected = new Set(changed)
  const deps = datasetDepsOf(chart)
  let grew = true
  while (grew) {
    grew = false
    for (const d of chart.data) {
      if (affected.has(d.name)) continue
      const dep = deps.get(d.name)!
      let hit = dep.allData && affected.size > 0
      if (!hit) for (const n of dep.names) if (affected.has(n)) { hit = true; break }
      if (hit) { affected.add(d.name); grew = true }
    }
  }
  return affected
}

/** What a mark subtree reads: datasets, scales (by name or through expressions). */
interface MarkDeps { names: Set<string>; allData: boolean; scales: Set<string>; allScales: boolean }
const MARK_DEPS = new WeakMap<CompiledMark, MarkDeps>()

function markDepsOf(mark: CompiledMark, chart: CompiledChart): MarkDeps {
  let deps = MARK_DEPS.get(mark)
  if (deps) return deps
  const known = new Set(chart.data.map((d) => d.name))
  const out: MarkDeps = { names: new Set(), allData: false, scales: new Set(), allScales: false }
  // a mark reading another mark's items (`from: {data: <mark name>}`) depends on whatever that mark depends on
  const readsMarkItems = (m: CompiledMark): boolean => {
    const from = m.from?.data
    const lookupFrom = (m.transform ?? []).some((t) => t.type === 'lookup' && typeof (t as { from?: unknown }).from === 'string' && !known.has((t as { from: string }).from))
    if ((typeof from === 'string' && !known.has(from)) || lookupFrom || (m.marks ?? []).some(readsMarkItems)) return true
    return false
  }
  if (readsMarkItems(mark)) out.allData = true
  walkStrings(mark, (str, owner) => {
    if (known.has(str)) out.names.add(str)
    if (DATA_FN_EXPR.test(str)) out.allData = true
    if (SCALE_FN_EXPR.test(str)) out.allScales = true
    if (owner && typeof owner.scale === 'string' && owner.scale === str) out.scales.add(str)
  }, new Set(), null, (o) => {
    // A scale chosen by a signal/expression object: any scale may be read.
    if (o.scale != null && typeof o.scale === 'object') out.allScales = true
  })
  MARK_DEPS.set(mark, out)
  return out
}

/** The scale names a mark subtree can depend on. */
function markScaleNames(mark: CompiledMark, chart: CompiledChart): string[] {
  const deps = markDepsOf(mark, chart)
  return deps.allScales ? chart.scales.map((s) => s.name) : [...deps.scales]
}

/**
 * Whole-group reuse (a top-level leaf mark whose output provably equals last
 * evaluation's). Every input the mark reads must be unchanged: the evaluation
 * context (signals, size, overrides), each dataset it reads (closed over
 * dependencies), and each scale it reads (by object identity). Group marks
 * (facets, trellises, scoped scopes) are always rebuilt: their layout is
 * written by later passes, so reusing their objects is not sound (C14).
 */
function canReuseMarkGroup(mark: CompiledMark, ctx: EvalContext): boolean {
  const prev = ctx.prev
  if (!prev || !ctx.incremental || mark.type === 'group') return false
  if (prev.fp !== ctx.draft.fp) return false
  const deps = markDepsOf(mark, ctx.chart)
  if (deps.allData ? ctx.affected.size > 0 : [...deps.names].some((n) => ctx.affected.has(n))) return false
  for (const name of markScaleNames(mark, ctx.chart)) {
    if (ctx.scales.get(name) !== prev.scales.get(name)) return false
  }
  return true
}

/**
 * Vega's renderers visit a group's items in dataflow order: axes (including
 * grid axes) first, then marks/scopes, then legends, then the title. Our
 * builders create marks first (guides need their bounds to anchor), so sort
 * the siblings into vega's paint order here. This is what keeps SVG and
 * canvas z-order identical for overlapping marks (e.g. an area over a grid).
 * vega-scenegraph then z-orders the children (util/visit.js): marks without a
 * `zindex` paint first, in order; the ones with a (truthy) `zindex` paint
 * after, ascending (ties by order). Axes, legends and marks carry the spec's
 * `zindex` (Vega-Lite gives non-grid axes zindex 1, drawing them over marks).
 */
function paintOrderOf(items: SceneGroup[]): SceneGroup[] {
  const orderRank = (g: SceneGroup): number =>
    g.role === 'axis' ? 0 : g.role === 'legend' ? 2 : g.role === 'title' ? 3 : 1
  const zOf = (g: SceneGroup): number => (g as unknown as { zindex?: number }).zindex || 0
  return items.length > 1
    ? sortData(items.map((g, i) => ({ g, i })), (a, b) => {
        const za = zOf(a.g), zb = zOf(b.g)
        if ((za !== 0) !== (zb !== 0)) return za !== 0 ? 1 : -1
        if (za !== 0 && za !== zb) return za - zb
        return orderRank(a.g) - orderRank(b.g) || a.i - b.i
      }).map((x) => x.g)
    : items
}

/**
 * Build the scene content (marks, axes/legends, title, trellis) and the
 * autosize padding at a given content size. Extracted from evaluateChart so
 * `fit`/`fit-x`/`fit-y` can re-run at a shrinking content size and converge.
 */
type BuiltContent = { record: PassRecord | undefined; items: SceneGroup[]; padding: ReturnType<typeof computeGuidePadding>; ctx: EvalContext; width: number; height: number; hasLayout: boolean; frame: FrameEncode | undefined }

/** What the view's own `encode` gives the root group: where it sits, and the paint of its box (see frameEncodeOf). */
interface FrameEncode { x: number; y: number; paint: Partial<SceneRoot> }

/**
 * The content of the view. A failing axis (axisTicksFailed) aborts vega's dataflow pass at the operator that failed: the
 * first pass finds out where, the second builds only what vega had made by then.
 */
function buildContent(
  chart: CompiledChart,
  input: RuntimeInput,
  cw: number,
  ch: number,
  txn: EvalTxn,
  fitted = false,
  signed?: { width?: number; height?: number },
  /** Present: this build is a pass of a view that makes another (fit); `prev`: what the pass before it left. */
  order?: { prev?: PassRecord },
): BuiltContent {
  const first = buildContentPass(chart, input, cw, ch, txn, fitted, signed, undefined, order)
  const failures = first.ctx.abort.failures
  if (!failures.length) return first
  const cut = failures.reduce((a, b) => (compareInstances(a.path, b.path) || (a.axis === b.axis ? 0 : a.axis < b.axis ? -1 : 1) || (a.legend ?? 0) - (b.legend ?? 0)) <= 0 ? a : b)
  return buildContentPass(chart, input, cw, ch, txn, fitted, signed, cut, order)
}

function buildContentPass(
  chart: CompiledChart,
  input: RuntimeInput,
  cw: number,
  ch: number,
  txn: EvalTxn,
  fitted = false,
  signed?: { width?: number; height?: number },
  cut?: AxisAbort['cut'],
  order?: { prev?: PassRecord },
): BuiltContent {
  const prepared = prepareChartCtx(
    // (the first build reads the size from the spec and the host's input itself; only a fit-resize overrides it)
    chart, fitted ? { ...input, width: cw, height: ch } : input, txn,
    fitted ? { width: true, height: true } : { width: input.width != null, height: input.height != null },
    signed,
    order !== undefined ? { prev: order.prev, cur: { guides: new Map(), scales: new Map() } } : undefined,
  )
  const { ctx } = prepared
  ctx.abort.cut = cut
  // the instance the pass stopped in made its axes before the failing one, and nothing else of it
  const stopped = cut !== undefined && !cut.late && compareInstances(ctx.scope.path, cut.path) === 0
  // the layout reads the view size as `Math.max(0, width)`; the signals themselves keep their sign
  const width = Math.max(0, prepared.width)
  const height = Math.max(0, prepared.height)

  // Partial re-evaluation: marks whose every input is provably unchanged reuse
  // the previous scene's group object as-is, and marks over a changed dataset
  // splice theirs (item identity preserved for the DOM patcher). Groups are
  // matched by COMPILED-MARK IDENTITY, never by source dataset or name: two
  // layers over one dataset, or several unnamed marks, are distinct (C4).
  const items: SceneGroup[] = []

  // 1) Build marks (plot area)
  for (const mark of stopped && cut!.legend === undefined ? [] : ctx.chart.marks) {
    const prevGroup = ctx.prev?.groups.get(mark) ?? null
    if (prevGroup && canReuseMarkGroup(mark, ctx)) {
      items.push(prevGroup)
      ctx.draft.groups.set(mark, prevGroup)
      continue
    }
    const result = evaluateMark(mark, ctx, prevGroup)
    if (result) {
      for (const g of Array.isArray(result) ? result : [result]) {
        if (mark.zindex) (g as unknown as { zindex?: number }).zindex = mark.zindex
        items.push(g)
      }
      if (!Array.isArray(result)) ctx.draft.groups.set(mark, result)
    }
  }

  // the ViewLayout of a group never ran if the pass stopped below it: the view is always such a group
  if (cut !== undefined) { ctx.rawGuides = true; ctx.pendingEntries = entriesPending(0, cut.path.length) }

  // 2) ViewLayout of the view's root group (vega-view-transforms): a `layout`
  // grid positions the child groups (cells, headers, footers, titles) first;
  // layoutGroup then lays out the axes, legends and title around them.
  const hasLayout = ctx.chart.layout != null
  if (hasLayout && cut === undefined) {
    try {
      trellisLayout({ marktype: 'group', items } as unknown as SceneGroup, resolveLayoutOptions(ctx.chart.layout!, ctx))
    } catch {
      // vega's dataflow logs the layout error and renders the scene unlayouted:
      // cells keep their encoded (0,0) anchors and the view skips overflow growth.
      ctx.layoutState.failed = true
    }
  }
  const { groups: guideGroups } = stopped
    ? buildAxisAndLegend(ctx, items, ctx.chart.axes.slice(0, cut!.axis), ctx.chart.legends.slice(0, cut!.legend ?? 0))
    : buildAxisAndLegend(ctx, items)
  for (const g of guideGroups) items.push(g)

  // Top-level title. (A pass that stopped at a failing dataset or signal never made it: it is ranked after them.)
  const titleGroup = stopped || ctx.datasetAborted ? null : buildTitleGroup(ctx.chart.title, items, width, height, ctx.rawGuides, ctx)
  if (titleGroup) items.push(titleGroup)
  // The root group's width / height are the view's `width` / `height` signals (0
  // for a composition that sizes only its children), whatever the grid inside covers.

  // (the view's bounds are those of the root's content relative to its origin: where the root sits does not move them)
  const frame = ctx.chart.frameEncode !== undefined && !ctx.datasetAborted ? frameEncodeOf(ctx) : undefined

  // 2d) viewSizeLayout padding (overflow) after the trellis layout.
  // A trellis layout that throws (vega's gridLayout does on e.g. fractional
  // `columns`) aborts vega's whole ViewLayout transform: the scene renders
  // unlayouted — cells at their encoded anchors — with the default padding
  // and no overflow growth (the dataflow logs the error and continues).
  // `autosize: none` keeps the declared viewport: vega's viewSizeLayout does not
  // grow the padding from guide/mark overflow, so measuring every top-level
  // group's recursive bounds here would be pure cost (O(items) per evaluation,
  // and the dominant cost of a one-row update on a 100k-point chart).
  // (a scale or an encode that threw stopped vega's run before its ViewLayout: no overflow growth)
  const padding = ctx.layoutState.failed
    || ctx.encodeAborted === true
    || ctx.postRunLost === true
    || ctx.rawGuides
    || ctx.chart.autosize === 'none'
    ? ctx.chart.padding
    : computeGuidePadding(items, width, height, ctx.chart.padding)
  const ordered = paintOrderOf(items)
  return { record: ctx.passMemory?.cur, items: ordered, padding, ctx, width, height, hasLayout, frame }
}

/**
 * An evaluation whose incremental state has not been committed yet. The scene is
 * usable immediately; `commit()` makes this evaluation the base the next
 * incremental one starts from. A host that runs post-evaluation checks (the
 * session's limits) commits only after they pass, so a rejected evaluation can
 * never become the state later pulses are relative to (C16).
 */
export interface PendingEvaluation {
  scene: SceneRoot
  commit(): void
}

/**
 * Evaluate without committing the incremental state. The compiled chart is not
 * written; call `commit()` once the scene has been accepted.
 */
export function evaluateChartPending(chart: CompiledChart, input: RuntimeInput = {}): PendingEvaluation {
  const txn = beginTxn(chart)
  const done: { draft?: IncrementalState; failed?: boolean } = {}
  const scene = withLimits(input.limits, () => withTextMetricsProvider(input.textMetrics, () => evaluateChartImpl(chart, input, txn, done)))
  return {
    scene,
    commit() {
      // An evaluation that logged a recovered error is not a base later pulses may be relative to
      // (its items/datasets are the partial result of a failure): the committed state goes stale.
      if (done.failed) {
        const committed = STATES.get(chart)
        if (committed) committed.stale = true
      } else if (done.draft) STATES.set(chart, done.draft)
    },
  }
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const pending = evaluateChartPending(chart, input)
  pending.commit()
  return pending.scene
}

function evaluateChartImpl(chart: CompiledChart, hostInput: RuntimeInput, txn: EvalTxn, done: { draft?: IncrementalState; failed?: boolean }): SceneRoot {
  // an injected random source is drawn from once per site and run, however many passes and evaluations repeat it (see random-tape.ts)
  const input: RuntimeInput = hostInput.random ? { ...hostInput, random: replayable(hostInput.random) } : hostInput
  const auto = chart.autosize
  const base = chart.padding
  // Differential-update generation (`txn.gen`): an unchanged (reused) item keeps
  // the generation it was encoded in, so the DOM patcher can skip it.
  const signals = dict(chart.signals, input.signals)
  let initialW = resolveSize(chart.width, viewOverride(chart, input, 'width'), signals)
  let initialH = resolveSize(chart.height, viewOverride(chart, input, 'height'), signals)
  // A negative view size: vega's first pass lays out content ranged on the signal as written (a scale over
  // [0, -100]) and sizes the view from the overflow it finds (viewSizeLayout, once); the width / height
  // signals are then clamped to 0 and the content is encoded again, but the view keeps the size and padding of
  // the first pass. So the padding comes from a build with the signed sizes and the content from the clamped one.
  const signedW = signedViewSize(chart.width, viewOverride(chart, input, 'width'), signals)
  const signedH = signedViewSize(chart.height, viewOverride(chart, input, 'height'), signals)
  const signedPadding = (signedW !== undefined || signedH !== undefined) && (auto === undefined || auto === 'pad')
    ? buildContent(chart, input, signedW ?? initialW, signedH ?? initialH, txn, false, { width: signedW, height: signedH }).padding
    : undefined

  // `fit`/`fit-x`/`fit-y` shrink the *content* to fit a fixed viewport: viewSizeLayout measures the overflow of the first pass
  // (once: the pass after it sets the width signal with the resize skipped, so the layout does not run again), and the content is
  // built again at the fitted size. The view keeps the padding the first pass found; what the second pass overflows by is not
  // looked at (a title anchored to the bounds, or any overflow that depends on the width, ends up wherever it ends up).
  // (a fit view makes a second pass over the guides: the items of its first are what the join of the second starts from)
  const fitting = auto === 'fit' || auto === 'fit-x' || auto === 'fit-y'
  let cw = initialW
  let ch = initialH
  let firstPassPadding: BuiltContent['padding'] | undefined
  let built: BuiltContent
  if (auto === 'none' && chart.autosizeContains === 'padding') {
    // autosize `none` with `contains: "padding"`: the view's width / height INCLUDE the padding, so the group (the
    // width / height signals, every scale and expression that reads them) gets what is left (vega-view-transforms
    // viewSizeLayout: `width = viewWidth`, the padding taken out of it), as a resize of the view does.
    cw = Math.max(0, initialW - base.left - base.right)
    ch = Math.max(0, initialH - base.top - base.bottom)
    built = buildContent(chart, input, cw, ch, txn, true)
  } else {
    built = buildContent(chart, input, cw, ch, txn, false, undefined, fitting ? {} : undefined)
  }
  if (auto === 'fit' || auto === 'fit-x' || auto === 'fit-y') {
    // A `width`/`height` signal (update or init, e.g. vega-lite's
    // `isFinite(containerSize()[0]) ? ... : 300`) resolves while the first
    // build runs; the fit viewport is that resolved size, not the default.
    if (!built.hasLayout && (built.ctx.width !== cw || built.ctx.height !== ch)) {
      initialW = cw = built.ctx.width
      initialH = ch = built.ctx.height
    }
    {
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
      // (the view is the fitted viewport even when the content does not move: a dimension of 0 stays 0 whatever overflows it)
      firstPassPadding = built.padding
      if (nw !== cw || nh !== ch) {
        cw = nw
        ch = nh
        built = buildContent(chart, { ...input, changedDatasets: undefined }, cw, ch, txn, true, undefined, built.record !== undefined ? { prev: built.record } : undefined)
      }
    }
  }
  const { ctx, width, height } = built
  const items = built.items
  const padding = signedPadding ?? firstPassPadding ?? built.padding

  // 3) Build the scene: the document is the view's width / height signals plus the
  // padding (autosize pad grows it by what overflows). A composition's root group is
  // 0 x 0 (vega: no `width` signal value), so only its padding and overflow remain.
  // (a fitted dimension is the viewport as the spec gave it -- plus its padding unless the size contains it -- even when the overflow
  // is wider than the viewport and the content is squeezed to nothing)
  const fitW = (auto === 'fit' || auto === 'fit-x') && firstPassPadding !== undefined
  const fitH = (auto === 'fit' || auto === 'fit-y') && firstPassPadding !== undefined
  const contains = chart.autosizeContains === 'padding'
  const sceneWidth = fitW
    ? initialW + (contains ? 0 : base.left + base.right)
    : ctx.chart.autosize !== 'none'
      ? width + padding.left + padding.right
      : width + ctx.chart.padding.left + ctx.chart.padding.right
  const sceneHeight = fitH
    ? initialH + (contains ? 0 : base.top + base.bottom)
    : ctx.chart.autosize !== 'none'
      ? height + padding.top + padding.bottom
      : height + ctx.chart.padding.top + ctx.chart.padding.bottom

  const scene: SceneRoot = {
    width: sceneWidth,
    height: sceneHeight,
    // the frame background is the root group's own box: the view's width x height
    // (a composition's is the degenerate M0,0h0v0h0Z)
    plotWidth: ctx.rootUnsized ? 0 : width,
    plotHeight: ctx.rootUnsized ? 0 : height,
    // (`background` is a view signal: a spec that declares one sets the background through it; one with no value leaves the spec's)
    background: ctx.signalParams.background !== undefined && (chart.signalDefs ?? []).some((d) => d.name === 'background') ? (ctx.signalParams.background as string | null) : ctx.chart.background,
    frameStroke: ctx.chart.frameStroke,
    frameFill: (ctx.chart as unknown as { frameFill?: string }).frameFill,
    ...(ctx.chart.frameFillTransparent ? { frameFillTransparent: true as const } : {}),
    frameStrokeWidth: (ctx.chart as unknown as { frameStrokeWidth?: number }).frameStrokeWidth,
    frameFillOpacity: (ctx.chart as unknown as { frameFillOpacity?: number }).frameFillOpacity,
    frameOpacity: (ctx.chart as unknown as { frameOpacity?: number }).frameOpacity,
    frameStrokeDash: (ctx.chart as unknown as { frameStrokeDash?: number[] }).frameStrokeDash,
    frameCornerRadius: (ctx.chart as unknown as { frameCornerRadius?: number }).frameCornerRadius,
    frameClip: (ctx.chart as unknown as { frameClip?: boolean }).frameClip,
    frameStrokeOpacity: ctx.chart.frameStrokeOpacity,
    frameStrokeMiterLimit: ctx.chart.frameStrokeMiterLimit,
    frameStrokeDashOffset: ctx.chart.frameStrokeDashOffset,
    frameStrokeCap: ctx.chart.frameStrokeCap,
    frameStrokeJoin: ctx.chart.frameStrokeJoin,
    padding: ctx.chart.autosize === 'none' ? ctx.chart.padding : padding,
    items,
    ...(built.frame ? { ...built.frame.paint, ...(built.frame.x !== 0 ? { frameX: built.frame.x } : {}), ...(built.frame.y !== 0 ? { frameY: built.frame.y } : {}) } : {}),
  }
  // Event-loop wiring (non-serialized internals)
  ;(scene as unknown as { runtime?: unknown }).runtime = ctx.runtime
  ;(scene as unknown as { signalParams?: Record<string, unknown> }).signalParams = ctx.signalParams
  ;(scene as unknown as { compiled?: unknown }).compiled = ctx.chart
  ;(scene as unknown as { __itemGen?: number }).__itemGen = txn.gen
  ;(scene as unknown as { __scales?: unknown }).__scales = snapshotScales(ctx.scales)
  ;(scene as unknown as { __scaleMap?: unknown }).__scaleMap = ctx.scales
  Object.defineProperty(scene, '__datasets', { value: { rows: ctx.datasets, failed: ctx.failedDatasets }, enumerable: false, configurable: true })
  if (ctx._defs.length) scene.defs = ctx._defs
  // The state the next incremental evaluation starts from; committed by the
  // caller once the scene is accepted.
  done.draft = ctx.draft
  done.failed = ctx.failed === true
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
 * The rows each of the spec's datasets ended with in the evaluation that made `scene` (vega's `view.data(name)`), read-only:
 * the same arrays the marks and scales read. A dataset that never ran -- a transform of its own threw, or it is ranked after the
 * one that did (see `buildDatasetsOf`) -- is `null`, as in vega, where its output was never produced. Empty for a scene that did
 * not come from this runtime (a clone, a worker).
 */
export function datasetsOfScene(scene: SceneRoot): ReadonlyMap<string, readonly unknown[] | null> {
  const made = scene.__datasets
  if (!made) return new Map()
  const out = new Map<string, readonly unknown[] | null>()
  for (const [name, rows] of made.rows) out.set(name, made.failed?.has(name) ? null : rows)
  return out
}

/**
 * Compute chart metadata (size, padding, scales) without building the full scene.
 * Useful for interaction, brushing, crosshair, etc.
 */
export function getChartInfo(spec: VgSpec, input: RuntimeInput = {}): ChartInfo {
  return withLimits(input.limits, () => getChartInfoImpl(spec, input))
}

function getChartInfoImpl(spec: VgSpec, input: RuntimeInput): ChartInfo {
  // ONE evaluation: the info is read off the evaluated scene, so it is the scene's own plot size,
  // padding and scales -- under autosize `fit`/`pad` too, where the size the scales were built for
  // is the fitted one, not the spec's (C53). (This used to prepare a second, unfitted context and
  // then evaluate the whole chart again.)
  return chartInfoFromScene(evaluateChart(compileChart(spec), input))
}

/**
 * Vega's titleLayout (vega-view titleLayout) port: the title group holds the
 * title text at (0,0) and the subtitle at (sx,sy); the group is positioned
 * outside the viewBounds by the union of the two text bounds.
 */
function buildTitleGroup(
  title0: CompiledTitle | undefined,
  items: SceneNode[],
  width: number,
  height: number,
  raw = false,
  ctx?: EvalContext,
  /** The datum a group title's `parent[...]` reads (its facet key). */
  parent?: Row,
): SceneGroup | null {
  if (!title0 || !ctx) return null
  // viewBounds: [0,0,w,h] ∪ marks ∪ axis/legend bounds (axes measured in the
  // axis-internal frame; our scene bakes the 0.5px axis delta into the leaves
  // — shift it out). The title unions in afterwards, as in vega's layoutGroup.
  const b = new Bounds().set(0, 0, width, height)
  const measured = (items as SceneGroup[]).filter((g) => g.role !== 'title')
  // (a clipped mark -- an interval selection's brush -- has its bounds cut to the frame: Bound's boundClip)
  if (hasClippedMark(measured)) eachMarkBounds(measured, width, height, (n) => measureGuideGroup(n as SceneGroup), (mb) => { b.union(mb) })
  else for (const g of measured) b.union(measureGuideGroup(g))
  // (a group title reads its facet datum as `parent`)
  const hostCtx = parent !== undefined ? { ...ctx, signalParams: { ...ctx.signalParams, parent } } : ctx
  const built = buildTitleGuide({
    spec: (title0.own ?? {}) as Record<string, unknown>, cfg: (title0.cfg ?? {}) as Record<string, unknown>,
    viewBounds: b, width, height, raw, host: guideHost(hostCtx), style: guideStyles(ctx),
  })
  const g = built.group
  const mark = (role: string, it: SceneItem, meta: { name?: string; interactive: boolean } | undefined): SceneGroup => ({
    marktype: 'text', role, items: [it],
    ...(it.href != null ? { hasLinks: true } : {}),
    ...(meta?.name ? { cssName: meta.name } : {}),
    ...(meta?.interactive ? { interactive: true } : {}),
  }) as SceneGroup
  const children: SceneGroup[] = [mark('title-text', built.title, built.partMeta.title)]
  if (built.subtitle) children.push(mark('title-subtitle', built.subtitle, built.partMeta.subtitle))
  // (the mark definition reads these as written -- vega-parser marks/definition.js: `+zindex || undefined`, `aria`, `description`)
  const own = (title0.own ?? {}) as Record<string, unknown>
  const cfg = (title0.cfg ?? {}) as Record<string, unknown>
  const aria = value(own.aria, cfg.aria)
  const description = value(own.description, cfg.description)
  const zindex = +(value(own.zindex, cfg.zindex) as number) || undefined
  const gb = groupBackground(g as SceneItem, +(g.width as number) || 0, +(g.height as number) || 0)
  const out = {
    marktype: 'group',
    role: 'title',
    x: (g.x as number) ?? 0,
    y: (g.y as number) ?? 0,
    items: children,
    box: gb.background,
    ...(gb.foreground ? { boxFg: gb.foreground } : {}),
    ...(aria !== undefined ? { aria } : {}),
    ...(description ? { description } : {}),
    ...(zindex ? { zindex } : {}),
    ...(built.partMeta.group?.name ? { cssName: built.partMeta.group.name } : {}),
    ...(built.partMeta.group?.interactive ? { interactive: true } : {}),
    ...(itemAriaOf(g) ? { itemAria: itemAriaOf(g) } : {}),
    ...(cursorOf(g) !== undefined ? { cursor: cursorOf(g) } : {}),
    ...(g.href != null ? { href: g.href } : {}),
  } as unknown as SceneGroup
  vetGuideLinks(out, ctx)
  return out
}

/** The view size as written when it is a negative number (see the first autosize pass in evaluateChartImpl). */
function signedViewSize(size: SizeSpec, override: number | undefined, signals: Record<string, unknown>): number | undefined {
  const v = override != null ? override : typeof size === 'number' ? size : size && typeof size === 'object' && 'signal' in size ? signals[size.signal] : undefined
  return typeof v === 'number' && v < 0 ? v : undefined
}

/**
 * The one value the view's `width` / `height` takes from the host, if it gives one (every consumer -- scales, layout,
 * autosize, the svg, the signal expressions read -- starts from this, so none can disagree with another). In Vega the
 * size is a signal and the later write wins, so from the strongest: the size the host fixed (`input.width`), a value it
 * wrote to the signal (a bound input, an event handler), and the container it measured, which only sizes a spec that
 * does not drive the signal itself and does not leave the dimension to its layout (a composition's size is its groups').
 */
function viewOverride(chart: CompiledChart, input: RuntimeInput, dim: 'width' | 'height'): number | undefined {
  const fixed = input[dim]
  if (fixed != null) return fixed
  const written = input.signals?.[dim]
  if (typeof written === 'number') return written
  const measured = input.measuredSize?.[dim]
  if (measured == null) return undefined
  if (chart.contentSized?.includes(dim)) return undefined
  const size = chart[dim]
  const drives = (size !== null && typeof size === 'object' && 'signal' in size) || (chart.signalDefs ?? []).some((d) => d.name === dim)
  return drives ? undefined : measured
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
      if (typeof v === 'number') return clamp(v)
      // vega: the signal's value whatever it is; the autosize pad resize makes the `width` signal
      // `Math.max(0, group.width || 0)` (viewSizeLayout), so null is 0 and a word NaN. An absent
      // value is a signal still to be computed (its update expression): the default stands in.
      return v === undefined ? DEFAULT_SIZE : Math.max(0, (v as number) || 0)
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
  const exprFn = compileExprTransform(expr, tctx)
  const fn = (row: Row): boolean => Boolean(exprFn(row))
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
  const exprFn = compileExprTransform(expr, tctx)
  const fn = (row: Row): boolean => Boolean(exprFn(row))
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
  // vega's output length for one tuple; `fields` may be access paths (`a.b`, `a[0]`)
  const maxlen = flattenLength(fieldsOf(fields).map((f) => f(row)))
  return maxlen > 0 ? maxlen : 0
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
  // Output order is the FIRST-OCCURRENCE order of the groups in the current
  // rows, exactly like the full aggregate (C52). Surviving groups that moved
  // are expressed through the pulse mapping (`outFrom`), not by keeping their
  // previous position.
  const outOrder = [...keyToIdx.keys()]

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
      next = aggregateGroup(idxs.map((i) => rows[i]!), t)
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
  for (const k of outOrder) {
    const oldIdx = prevState.outIdx.get(k)
    const oldRow = prevState.outByKey.get(k)
    let next: Row
    if (!dirty.has(k) && oldRow) next = oldRow
    else {
      const idxs = keyToIdx.get(k)!
      next = aggregateGroup(idxs.map((i) => rows[i]!), t)
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
  const sort = (t as { sort?: SortSpec }).sort
  const order = sortOrder(rows, sort)
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
 * True when a transform's output row depends only on its own input row (plus
 * the params the dataset fingerprint already covers), so the rows a pulse does
 * not name keep their cached output. Anything that reads other rows, other
 * datasets or writes a signal is NOT row-local (bin with a data-derived extent,
 * a lookup into a dataset that changed, a formula calling data()/indata(),
 * ...).
 */
function rowLocal(t: CompiledTransform, tctx: StepTransformContext): boolean {
  const type = String(t.type)
  switch (type) {
    case 'formula':
      return !DATA_DEPENDENT_EXPR.test((t as { expr?: string }).expr ?? '')
    case 'timeunit':
      // without explicit units vega bins the data extent (global); inferUnits looks at every row
      // (a `signal` output is a side effect a skipped re-run would lose, and covers every row)
      return (t as { units?: unknown }).units != null && !(t as { inferUnits?: unknown }).inferUnits && (t as { extent?: unknown }).extent === undefined && !(t as { signal?: unknown }).signal
    case 'geoshape': case 'geopath': case 'geopoint':
      // a projection that fits data moves with the data: a derived x/y or path is only valid for the fit it was made under
      return !(tctx.projections as ProjectionRegistry | undefined)?.fitNames?.has(String((t as { projection?: unknown }).projection))
    case 'linkpath': case 'project':
      return true
    case 'bin':
      // A fixed numeric extent makes the bins constant; a `signal` output is a
      // side effect a skipped re-run would lose.
      return Array.isArray((t as { extent?: unknown }).extent) && !(t as { signal?: unknown }).signal
    case 'lookup':
      return !tctx.affectedDatasets?.has((t as { from?: string }).from ?? '')
    default:
      return false
  }
}

/**
 * `identifier` over an append-only pulse. Vega numbers only the tuples whose `as`
 * value is falsy, in order (`t[as] || ++id`), so the new rows continue from the
 * count the previous evaluation reached; a modified earlier row can renumber
 * everything after it, which falls back to the aligned re-derive.
 */
function identifierAppendPulse(
  rows: Row[], t: CompiledTransform, input: StepPulse, prev: Row[] | undefined, prevState: IdentifierState | undefined,
): { rows: Row[]; pulse: StepPulse; state: IdentifierState } | null {
  const base = pulseBaseLength(input)
  if (!prev || prev.length !== base || !prevState || input.changed.length) return null
  const as = (t as { as?: string }).as
  if (as === undefined) return null
  let id = prevState.count
  for (let i = base; i < rows.length; i++) {
    const row = { ...rows[i]! }
    row[as] = row[as] || ++id
    prev.push(row)
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, []), state: { count: id } }
}

/** Ids handed out so far by an `identifier` step (the vega counter). */
interface IdentifierState { count: number }

/**
 * Apply one transform to a length-changing pulse. Returns `null` when the
 * transform cannot publish a mapping (the caller then re-derives the rest).
 */
function applyStepWithPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevStepState: unknown,
): { rows: Row[]; pulse: StepPulse | null; state?: unknown } {
  const type = String(t.type)
  if ((type === 'aggregate' || type === 'joinaggregate') && !groupwiseIncremental(t)) {
    return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
  }
  if (input.appendOnly) {
    // Fast paths that never need the full mapping.
    const appendLocal = rowLocal(t, tctx)
    if (appendLocal) {
      const fast = rowLocalAppendPulse(rows, t, tctx, sourceName, input, prev)
      if (fast) return fast
    } else if (type === 'identifier') {
      const fast = identifierAppendPulse(rows, t, input, prev, prevStepState as IdentifierState | undefined)
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
    } else if (type === 'collect') {
      const fast = orderedAppendPulse(rows, t, input, prev, prevStepState as { order: number[] } | undefined)
      if (fast) return fast
    } else if (type === 'geojson' || type === 'extent' || type === 'stratify') {
      const out = applyOne(rows, t, tctx, sourceName)
      return { rows: out, pulse: out.length === rows.length ? input : null }
    }
    // Everything else needs old<->new indices; synthesise them only here.
    const from = mappingFromPulse(input, rows.length)
    input = { ...input, from, to: inverseMapping(from, pulseBaseLength(input)), appendOnly: undefined, baseLength: undefined }
  }
  switch (type) {
    case 'formula':
    case 'timeunit':
    case 'geoshape':
    case 'geopath':
    case 'geopoint':
    case 'linkpath':
    case 'project':
    case 'bin':
    case 'lookup':
      // Row-local transforms re-derive only the added/modified rows; the others
      // of the same type (data-extent bin, a lookup into a changed dataset, a
      // formula that reads datasets) are global and re-derive aligned.
      if (rowLocal(t, tctx)) {
        return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      }
      if (type === 'bin') return rederiveAligned(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'identifier':
      // Ids are positional (`i + 1`): inserts/deletes shift them. Re-derive
      // aligned so retained rows keep their object only when the id is unchanged.
      return rederiveAligned(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'geojson':
    case 'extent':
    case 'stratify': {
      const out = applyOne(rows, t, tctx, sourceName)
      return { rows: out, pulse: out.length === rows.length ? input : null }
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
      // Window writes its results back in SOURCE order (1:1 with the input,
      // whatever the partition/sort), so it aligns like any other index-
      // preserving transform; a row's value can change without the row itself
      // changing (its partition-mates did), which the content comparison finds.
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'stack':
      // vega's stack writes y0/y1 onto each tuple in place: 1:1 with the input, in input order
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'pie':
    case 'dotbin':
    case 'label':
    case 'pack':
    case 'partition':
    case 'treemap':
    case 'tree':
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

/** Transform types that keep per-step incremental state (see `deriveStepState`). */
function keepsStepState(type: string): boolean {
  return type === 'filter' || type === 'flatten' || type === 'aggregate' || type === 'joinaggregate' || type === 'collect' || type === 'identifier'
}

/**
 * The incremental state of one step, derived from scratch from the step's input
 * and output (what a fully re-derived step leaves behind for the next pulse).
 */
function deriveStepState(t: CompiledTransform, input: Row[], output: Row[], tctx: StepTransformContext): unknown {
  switch (t.type) {
    case 'filter': {
      const fn = compileExprTransform((t as { expr?: string }).expr ?? '', tctx)
      return input.map((r) => Boolean(fn(r)))
    }
    case 'flatten': {
      const fields = (t as { fields?: string[] }).fields ?? []
      const sizes = input.map((r) => flattenSize(r, fields))
      const offsets: number[] = []
      let p = 0
      for (const sz of sizes) { offsets.push(p); p += sz }
      return { sizes, offsets }
    }
    case 'aggregate': case 'joinaggregate':
      return buildAggState(input, (t as { groupby?: string[] }).groupby ?? [], output)
    case 'collect':
      return { order: sortOrder(input, (t as { sort?: SortSpec }).sort) }
    case 'identifier': {
      const as = (t as { as?: string }).as
      let count = 0
      if (as !== undefined) for (const r of input) if (!r[as]) count++
      return { count } satisfies IdentifierState
    }
    default:
      return undefined
  }
}

/** Run one transform from scratch, leaving the state the next pulse starts from. */
function applyOneWithState(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
): { rows: Row[]; state?: unknown } {
  if (t.type === 'filter') {
    // Predicate flags and output in one pass (same function, same errors as the
    // plain transform).
    const fn = compileExprTransform((t as { expr?: string }).expr ?? '', tctx)
    const pass = new Array<boolean>(rows.length)
    const out: Row[] = []
    for (let i = 0; i < rows.length; i++) {
      const ok = Boolean(fn(rows[i]!))
      pass[i] = ok
      if (ok) out.push(rows[i]!)
    }
    return { rows: out, state: pass }
  }
  const out = applyOne(rows, t, tctx, sourceName)
  return keepsStepState(String(t.type)) ? { rows: out, state: deriveStepState(t, rows, out, tctx) } : { rows: out }
}

/**
 * Apply a transform chain driven by a pulse, step by step. Reads the COMMITTED
 * step outputs/state (`prevDS`) and records this evaluation's into `state`;
 * once a step cannot publish a mapping (`pulse` becomes null) the remaining
 * steps run from scratch but still leave their state behind.
 */
function applyPipelineWithPulse(
  rows: Row[], transforms: CompiledTransform[], tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prevDS: DatasetState, state: DatasetState,
): { rows: Row[]; pulse: StepPulse | null } {
  let cur = rows
  let pulse: StepPulse | null = input
  for (let k = 0; k < transforms.length; k++) {
    const t = transforms[k]!
    const key = `${sourceName}#${k}`
    if (!pulse) {
      const res = applyOneWithState(cur, t, tctx, sourceName)
      cur = res.rows
      checkRowCount(cur.length, `transform ${String(t.type)}`)
      state.steps.push(cur)
      if (res.state !== undefined) state.stepState.set(key, res.state)
      continue
    }
    const stepInput = cur
    const res = applyStepWithPulse(cur, t, tctx, sourceName, pulse, prevDS.steps[k], prevDS.stepState.get(key))
    cur = res.rows
    checkRowCount(cur.length, `transform ${String(t.type)}`)
    pulse = res.pulse
    state.steps.push(cur)
    const next = res.state !== undefined ? res.state
      : keepsStepState(String(t.type)) ? deriveStepState(t, stepInput, cur, tctx) : undefined
    if (next !== undefined) state.stepState.set(key, next)
  }
  return { rows: cur, pulse }
}

/**
 * A published pulse in the engine's two canonical shapes. A same-length update
 * (`{changed}`) is exactly an append-only pulse whose base is the current length
 * and that appends nothing, so ONE set of per-transform fast paths serves both
 * (C13: there used to be a second, same-length-only engine with separate state).
 */
function normalizePulse(p: StepPulse, rowCount: number): StepPulse {
  if (p.from || p.appendOnly || p.added?.length || p.removed?.length) return p
  return { ...p, appendOnly: true, baseLength: rowCount }
}

function buildDatasets(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  // While datasets build, a transform asking for a projection that fits data gets it
  // refreshed against the datasets built so far. The registry outlives the evaluation
  // (scenes keep the transform contexts holding it), so the hook is bound only for this
  // call and never leaves the evaluation context reachable from it.
  const registry = ctx.projections as ProjectionRegistry
  if (ctx.chart.projections?.some((p) => p.fit)) registry.refresh = (name) => refreshProjection(ctx, name)
  registry.fitNames = new Set((ctx.chart.projections ?? []).filter((p) => p.fit).map((p) => p.name))
  try {
    buildDatasetsOf(ctx, inputData)
  } finally {
    registry.refresh = undefined
  }
}

function buildDatasetsOf(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  ctx.dsEpoch++
  // (the datasets build again once the signals they read resolve: what failed on an earlier round is judged anew)
  if (ctx.datasetAborted) ctx.encodeAborted = false
  ctx.datasetAborted = false
  ctx.failedDatasets = undefined
  ctx.failedFrom = undefined
  const sources = new Map<string, CompiledChart['data'][number]>()
  for (const d of ctx.chart.data) sources.set(d.name, d)
  const { rank: dsRank, order: dsOrder } = datasetRanksOf(ctx.chart)
  // The params this build pass runs under: cached pipeline state is only valid
  // for the identical context (any signal/size/override change re-derives).
  const passFp = ctxFpOf(ctx)

  const build = (name: string, seen: Set<string>): Row[] => {
    ctx.checkDeadline?.('dataset build')
    if (ctx.datasets.has(name)) return ctx.datasets.get(name)!
    const d = sources.get(name)
    if (!d) {
      const rows = (ownGet(inputData, name) as Row[] | undefined) ?? []
      ctx.datasets.set(name, rows)
      const given = ctx.inputPulses?.get(name)
      ctx.datasetPulses.set(name, given ? normalizePulse(given, rows.length) : null)
      return rows
    }
    if (seen.has(name)) throw new Error(`[aster] circular data reference: ${name}`)
    seen.add(name)
    if (ctx.failedFrom !== undefined && dsRank.get(name)! > ctx.failedFrom) {
      // ranked after the failing dataset (a source or a signal it feeds pulled this one in early): it never ran
      ;(ctx.failedDatasets ??= new Set()).add(name)
      ctx.datasets.set(name, [])
      ctx.datasetPulses.set(name, null)
      return []
    }
    // the datasets that write a signal this one reads come first; the signals computed from theirs follow
    const prereqs = signalPrereqsOf(ctx.chart).get(name)
    if (prereqs) {
      let built = false
      for (const w of prereqs) if (!ctx.datasets.has(w) && !seen.has(w)) { build(w, seen); built = true }
      // (a prerequisite built earlier still has signals computed from it that this dataset's transforms read)
      if (built || prereqs.length) resolveSignalUpdates(ctx)
    }

    let rows: Row[]
    let inPulse: StepPulse | null = null
    const srcNames = sourceNames(d)
    const setRows = srcNames.length === 0 ? ctx.setData.rows.get(name) : undefined
    if (setRows !== undefined) {
      // `setdata(name, tuples)` replaced this dataset's input
      rows = setRows.map((r) => ({ ...r }))
    } else if (srcNames.length > 1) {
      // several sources: their rows, one source after the other (each pulse adds its tuples in turn)
      rows = srcNames.flatMap((n) => build(n, seen).map((r) => ({ ...r })))
    } else if (srcNames.length === 1) {
      const src = srcNames[0]!
      const srcDef = ctx.chart.data.find((sd) => sd.name === src)
      if ((d as { format?: DataFormatSpec }).format && srcDef?.values != null) {
        // Vega applies a derived dataset's `format` when (re-)parsing its
        // source's raw values (e.g. source = inline Topology, format =
        // topojson feature extraction). The host's current values (input.data)
        // win over the spec's compiled-in ones.
        rows = readData(ownGet(inputData, src) ?? inlineValues(ctx, srcDef.values), (d as { format?: DataFormatSpec }).format)
        inPulse = ctx.inputPulses?.get(src) ?? null
      } else {
        rows = build(src, seen).map((r) => ({ ...r }))
        inPulse = ctx.datasetPulses.get(src) ?? null
        // (vega: the backing tree travels with the source array, `pulse.source.root`, to a dataset derived from it)
        const root = ctx.hierarchies.get(src)
        if (root !== undefined && !ctx.hierarchies.has(name)) ctx.hierarchies.set(name, root)
      }
    } else if (d.values != null) {
      const given = ownGet(inputData, name)
      if (given) {
        rows = readData(given, d.format)
      } else {
        // vega-loader read semantics: object arrays pass through format.parse
        // coercion; string values are parsed by the registered reader.
        rows = readData(inlineValues(ctx, d.values), d.format)
      }
      inPulse = ctx.inputPulses?.get(name) ?? null
    } else {
      const given = ownGet(inputData, name) as Row[] | undefined
      if (given == null && (d as { url?: unknown }).url != null) {
        // A url dataset nobody resolved would render as an empty chart with no
        // hint why (C60): fail loudly and say how to fix it.
        throw new Error(
          `[aster] dataset "${name}" has a url but no data was loaded for it; resolve url datasets first: ` +
          `import { loadSpecData } from "@aster/core/load" and render await loadSpecData(spec, { baseURL, ... }), ` +
          `or pass the rows as input.data["${name}"]`,
        )
      }
      rows = ingestRows(given ?? []).map((r) => ({ ...r }))
      inPulse = ctx.inputPulses?.get(name) ?? null
    }
    // Inline values, host `input.data`, a `source` copy and a loaded dataset all
    // count against maxRows here, nested group data included (C49).
    checkRowCount(rows.length, `dataset "${name}"`)
    if (inPulse) inPulse = normalizePulse(inPulse, rows.length)
    let outPulse: StepPulse | null = inPulse
    // vega: the dataset downstream of one whose transform threw is never evaluated (the pass stopped at the failing operator):
    // downstream is a source, or a dataset whose signal this one reads (its operator is ranked after that dataset's)
    const failedSource = ctx.failedDatasets !== undefined && (srcNames.some((n) => ctx.failedDatasets!.has(n)) || (prereqs ?? []).some((n) => ctx.failedDatasets!.has(n)))
    if (failedSource) {
      ;(ctx.failedDatasets ??= new Set()).add(name)
      rows = []
      outPulse = null
    } else if (d.transform.length) try {
      const prevDS = ctx.prev?.datasets.get(name)
      const tctx: StepTransformContext = {
        runtime: ctx.runtime,
        signals: ctx.signalParams,
        // Cross-dataset access for the `lookup` transform. Build the referenced
        // dataset on demand (it may be declared after this one in the spec).
        datasets: (n) => {
          if (!ctx.datasets.has(n) && sources.has(n)) build(n, new Set())
          return ctx.datasets.get(n)
        },
        hierarchies: ctx.hierarchies,
        projections: ctx.projections,
        affectedDatasets: ctx.affected,
      }
      const state: DatasetState = { fp: passFp, inputLength: rows.length, steps: [], stepState: new Map() }
      // Incremental only when every precondition is provable: the caller named a
      // pulse, the previous state was built under identical params from an input
      // of the length the pulse is relative to, and no earlier pass of THIS
      // evaluation already updated that state in place.
      const incremental = ctx.incremental && inPulse !== null && !inPulse.full && prevDS !== undefined
        && prevDS.fp === passFp && prevDS.steps.length === d.transform.length
        && prevDS.inputLength === pulseBaseLength(inPulse) && !ctx.claimed.has(`ds:${name}`)
      if (incremental) {
        claim(ctx, `ds:${name}`)
        const res = applyPipelineWithPulse(rows, d.transform, tctx, name, inPulse!, prevDS, state)
        rows = res.rows
        outPulse = res.pulse
      } else {
        let cur = rows
        for (let k = 0; k < d.transform.length; k++) {
          const from = cur
          const res = ctx.runtime.random === undefined
            ? applyOneWithState(from, d.transform[k]!, tctx, name)
            : atRandomSite(ctx.runtime.random, `dataset:${name}#${k}`, () => randomFingerprint(d.transform[k]!, from, ctx.signalParams), () => applyOneWithState(from, d.transform[k]!, tctx, name))
          cur = res.rows
          state.steps.push(cur)
          if (res.state !== undefined) state.stepState.set(`${name}#${k}`, res.state)
        }
        rows = cur
        outPulse = null
      }
      ctx.draft.datasets.set(name, state)
    } catch (e) {
      // vega: a transform that throws is logged and the dataset publishes nothing (the rest of
      // its pipeline never runs, so everything downstream of it is empty / never built).
      reportEvalError(ctx, e)
      ;(ctx.failedDatasets ??= new Set()).add(name)
      ctx.failedFrom = Math.min(ctx.failedFrom ?? Infinity, dsRank.get(name)!)
      rows = []
      outPulse = null
    }
    // a dataset a `force` link force reads gets its link rows rewritten (their ends become the nodes): they are this
    // evaluation's own copies, never the spec's
    if (forceLinkDatasets(ctx.chart).has(name)) rows = rows.map((r) => ({ ...r }))
    ctx.datasets.set(name, rows)
    ctx.datasetPulses.set(name, outPulse)
    return rows
  }

  // a projection that fits data asks for the datasets it reads before it is used (see refreshProjection)
  if (ctx.chart.projections?.some((p) => p.fit)) ctx.buildOnDemand = onDemandBuilder(ctx, sources, build)
  try {
    for (const name of dsOrder) {
      if (ctx.failedFrom !== undefined && dsRank.get(name)! > ctx.failedFrom && !ctx.datasets.has(name)) {
        // vega: the pass stopped at the failing transform; the operators ranked after it never ran
        ;(ctx.failedDatasets ??= new Set()).add(name)
        ctx.datasets.set(name, [])
        ctx.datasetPulses.set(name, null)
        continue
      }
      build(name, new Set())
    }
    // (a dataset vega re-ranked past the scales and marks fails after some of them ran -- the ones that read nothing re-ranked,
    // and the joins of marks over datasets that were not; this stops all of them: see datasetRanksOf)
    if (ctx.failedDatasets?.size) ctx.encodeAborted = ctx.datasetAborted = true
  } finally {
    ctx.buildOnDemand = undefined
  }
  // Transforms (extent, bin with a signal output) may have written signals.
  ctx.fpMemo = undefined
}

/**
 * The builder `refreshProjection` calls for a dataset a projection's fit reads before it is built. A function of its
 * own, not a closure inside `buildDatasetsOf`: a closure there makes every variable it names a heap-allocated context
 * slot of the dataset builder, which costs every chart (measured: 3x the p95 of a plain evaluation, from GC).
 */
function onDemandBuilder(ctx: EvalContext, sources: ReadonlyMap<string, unknown>, build: (name: string, seen: Set<string>) => unknown): (name: string) => void {
  return (n) => {
    if (!ctx.datasets.has(n) && sources.has(n)) build(n, new Set())
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

/** The `{data, field}` form of a single-dataset scale domain, if it is one. */
function singleDataDomain(domain: ScaleDomain): { data: string; field: string; sort?: unknown } | null {
  if (domain && typeof domain === 'object' && !Array.isArray(domain)
    && typeof (domain as { data?: unknown }).data === 'string' && typeof (domain as { field?: unknown }).field === 'string') {
    return domain as { data: string; field: string; sort?: unknown }
  }
  return null
}

/** Discrete domains sorted by an aggregate depend on other fields: never census-reusable. */
function discreteCensusApplies(dom: { sort?: unknown }): boolean {
  const sort = dom.sort
  return !(sort && typeof sort === 'object' && !Array.isArray(sort) && 'op' in (sort as object))
}

/** vega-util toNumber as a number: null / '' / undefined are NaN (skipped by the extent). */
function censusNumber(v: unknown): number {
  return v == null || v === '' ? NaN : +(v as number)
}

function freshContCensus(dom: { data: string; field: string }, rows: Row[]): ContCensus {
  const vals = new Array<number>(rows.length)
  let lo = Infinity, hi = -Infinity
  // an infinite value makes vega's extent [undefined, undefined]: nothing to prove stable
  let infinite = false
  const read = scaleFieldOf(dom.field)
  for (let i = 0; i < rows.length; i++) {
    // vega's Extent reads toNumber(value): null / '' are not 0, they are absent
    const v = censusNumber(read(rows[i]))
    vals[i] = v
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v } else if (v === Infinity || v === -Infinity) infinite = true
  }
  const finite = lo <= hi && !infinite
  let loCount = 0, hiCount = 0
  if (finite) for (const v of vals) { if (v === lo) loCount++; if (v === hi) hiCount++ }
  return { data: dom.data, field: dom.field, lo: finite ? lo : 0, hi: finite ? hi : 1, loCount, hiCount, finite, vals }
}

function freshDiscCensus(dom: { data: string; field: string }, rows: Row[]): DiscCensus {
  const counts = new Map<unknown, number>()
  const firstIdx = new Map<unknown, number>()
  const vals: unknown[] = new Array(rows.length)
  const read = scaleFieldOf(dom.field)
  for (let i = 0; i < rows.length; i++) {
    const v = read(rows[i])
    vals[i] = v
    counts.set(v, (counts.get(v) ?? 0) + 1)
    if (!firstIdx.has(v)) firstIdx.set(v, i)
  }
  return { data: dom.data, field: dom.field, vals, counts, firstIdx }
}

/**
 * Advance a continuous min/max census by a pulse, or return null when the domain
 * can no longer be proven unchanged (a value left [lo,hi], or the LAST row
 * holding the min/max moved away: the extreme itself moves — C11).
 *
 * An append-only pulse (which includes the same-length form) updates `vals` in
 * place; the caller has claimed the entry. Any other mapping builds a fresh
 * array.
 */
function advanceContCensus(cen: ContCensus, rows: Row[], pulse: StepPulse): ContCensus | null {
  let { loCount, hiCount } = cen
  const { lo, hi, field } = cen
  let stable = true
  const adjust = (oldV: number | undefined, newV: number | undefined): void => {
    if (oldV !== undefined) {
      if (oldV === lo) loCount--
      if (oldV === hi) hiCount--
    }
    if (newV === undefined) return
    if (newV === Infinity || newV === -Infinity) { stable = false; return } // vega's extent breaks
    if (!Number.isFinite(newV)) return
    if (newV < lo || newV > hi) { stable = false; return }
    if (newV === lo) loCount++
    if (newV === hi) hiCount++
  }
  const read = scaleFieldOf(field)
  const valueAt = (i: number): number => censusNumber(read(rows[i]))
  const vals = cen.vals
  let nextVals: number[]
  if (pulse.appendOnly || (!pulse.from && !(pulse.added?.length) && !(pulse.removed?.length))) {
    const base = pulse.appendOnly ? (pulse.baseLength ?? vals.length) : rows.length
    if (base !== vals.length || rows.length < base) return null
    for (const i of pulse.changed) {
      if (i < 0 || i >= base) continue
      const v = valueAt(i)
      adjust(vals[i], v)
      vals[i] = v
    }
    for (let i = base; i < rows.length; i++) {
      const v = valueAt(i)
      adjust(undefined, v)
      vals.push(v)
    }
    nextVals = vals
  } else if (pulse.from && pulse.from.length === rows.length && (pulse.to == null || pulse.to.length === vals.length)) {
    const from = pulse.from
    const modified = new Set(pulse.changed)
    const retained = new Uint8Array(vals.length)
    for (let i = 0; i < from.length; i++) {
      const old = from[i]!
      if (old >= vals.length) return null
      if (old >= 0) retained[old] = 1
    }
    for (let old = 0; old < vals.length; old++) if (!retained[old]) adjust(vals[old], undefined)
    nextVals = new Array<number>(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const old = from[i]!
      if (old >= 0 && !modified.has(i)) { nextVals[i] = vals[old]!; continue }
      const v = valueAt(i)
      nextVals[i] = v
      adjust(old >= 0 ? vals[old] : undefined, v)
    }
  } else return null
  // Without a row holding each extreme the min/max moved: re-derive.
  if (!stable || loCount <= 0 || hiCount <= 0) return null
  return { ...cen, loCount, hiCount, vals: nextVals }
}

/**
 * Advance a discrete value census by a SAME-LENGTH pulse. The ordered domain is
 * unchanged iff every changed row swaps its old value for one that already
 * exists with an earlier first occurrence, while the old value keeps both a
 * positive count and its own first occurrence. Anything else rebuilds.
 */
function advanceDiscCensus(cen: DiscCensus, rows: Row[], pulse: StepPulse): DiscCensus | null {
  const sameLength = pulse.appendOnly ? (pulse.baseLength === cen.vals.length && rows.length === cen.vals.length)
    : (!pulse.from && !(pulse.added?.length) && !(pulse.removed?.length) && rows.length === cen.vals.length)
  if (!sameLength) return null
  const read = scaleFieldOf(cen.field)
  for (const i of pulse.changed) {
    if (i < 0 || i >= rows.length) return null
    const nv = read(rows[i])
    const ov = cen.vals[i]
    if (Object.is(ov, nv) || ov === nv) continue
    const nCount = cen.counts.get(nv)
    const nFirst = cen.firstIdx.get(nv)
    if (nCount == null || nCount <= 0 || nFirst == null || nFirst > i) return null
    const oCount = cen.counts.get(ov)
    if (oCount == null || oCount <= 1) return null
    if (cen.firstIdx.get(ov) === i) return null
    cen.counts.set(ov, oCount - 1)
    cen.counts.set(nv, nCount + 1)
    cen.vals[i] = nv
  }
  return cen
}

/** Mark the committed state as updated in place (see IncrementalState). */
function claim(ctx: EvalContext, key: string): boolean {
  if (!ctx.prev || ctx.claimed.has(key)) return false
  ctx.claimed.add(key)
  ctx.prev.stale = true
  return true
}

/** A scale domain / census reads its field through the one shared accessor cache (vega-util `field()` semantics). */
const scaleFieldOf = fieldOf

/** The context a scale is built in: signals, config.range, datasets and the host domain override. */
function scaleContext(ctx: EvalContext, name: string): ScaleContext {
  return {
    width: ctx.width,
    height: ctx.height,
    signals: ctx.signalParams,
    configRange: ctx.chart.configRange,
    domainRaw: ctx.domainRaw?.get(name),
    evaluate: (expr) => ctx.runtime.expr(expr)({}, ctx.signalParams),
    dataField: (dataName, field) => {
      const rows = ctx.datasets.get(dataName) ?? []
      const get = scaleFieldOf(field)
      const out: unknown[] = new Array(rows.length)
      for (let i = 0; i < rows.length; i++) out[i] = get(rows[i])
      return out
    },
    dataRows: (dataName) => (ctx.datasets.get(dataName) ?? []) as Record<string, unknown>[],
    hasData: (dataName) => ctx.datasets.has(dataName),
    distinctCache: ctx.distinctCache,
    ...(ctx.passMemory !== undefined ? { pass: passOfScale(ctx.passMemory, `${ctx.scope.path.join('/')}:${name}`) } : {}),
  }
}

function passOfScale(memory: PassMemory, id: string): NonNullable<ScaleContext['pass']> {
  return { prev: memory.prev?.scales.get(id), record: (key, bins) => { memory.cur.scales.set(id, { key, bins }) } }
}

function buildScales(ctx: EvalContext): void {
  const prev = ctx.prev
  const entries = new Map<string, ScaleEntry>()
  // A scale whose domain references none of the affected datasets (closed over
  // source and transform dependencies) and whose size/signal params are
  // unchanged is identical to the previous evaluation's scale: reuse it and skip
  // the O(n) domain re-scan. Reuse reads the COMMITTED state only; this call's
  // result goes to the draft, so calling buildScales several times per
  // evaluation (fixed-point rounds, size re-resolution) is harmless (T1, C5).
  const fp = ctxFpOf(ctx)
  const reusable = ctx.incremental && prev !== undefined && prev.fp === fp
  const stamp = `${fp}#${ctx.dsEpoch}`
  for (const s of ctx.chart.scales) {
    // This scale was already proven reusable under the very same params and
    // dataset build earlier in this evaluation (the census advances once).
    const memo = ctx.scaleReuse.get(s.name)
    if (reusable && memo && memo.stamp === stamp) {
      ctx.scales.set(s.name, memo.entry.scale)
      ctx.scaleTypes.set(s.name, s.type)
      entries.set(s.name, memo.entry)
      continue
    }
    // A `{ fields: [...] }` domain (vega-lite's layered charts: several datasets
    // contribute to one shared scale) is resolved by buildScale itself, from the
    // CURRENT datasets, every evaluation (C12): the IR keeps the declared domain.
    // Such a scale has no single-dataset census, so it is never census-reused.
    const multi = isMultiFieldDomain(s.domain)
    const prevEntry = prev?.scaleEntries.get(s.name)
    const def: CompiledScale = s
    const dom = multi ? null : singleDataDomain(s.domain)
    if (reusable && prevEntry && prevEntry.multi === multi) {
      let reuse = !domainReferencesAffected(s.domain, ctx.affected)
      let entry = prevEntry
      // An affected single-data-domain scale can still be reused when its domain
      // is provably unchanged (see the census helpers). This skips the O(n)
      // domain re-scan for the common case (few points change, domain holds, or
      // rows are appended inside the current domain).
      if (!reuse && dom && !ctx.claimed.has(`scale:${s.name}`)) {
        const pulse = ctx.datasetPulses.get(dom.data)
        const rows = ctx.datasets.get(dom.data) ?? []
        if (pulse && !pulse.full) {
          if (CONTINUOUS_TYPES.has(s.type) && prevEntry.cont && prevEntry.cont.finite
            && prevEntry.cont.data === dom.data && prevEntry.cont.field === dom.field) {
            // The census is updated in place for the append-only form: claim it.
            if (claim(ctx, `scale:${s.name}`)) {
              const next = advanceContCensus(prevEntry.cont, rows, pulse)
              if (next) { reuse = true; entry = { ...prevEntry, cont: next } }
            }
          } else if (DISCRETE_TYPES.has(s.type) && prevEntry.disc && discreteCensusApplies(dom)
            && prevEntry.disc.data === dom.data && prevEntry.disc.field === dom.field) {
            if (claim(ctx, `scale:${s.name}`)) {
              const next = advanceDiscCensus(prevEntry.disc, rows, pulse)
              if (next) { reuse = true; entry = { ...prevEntry, disc: next } }
            }
          }
        }
      }
      if (reuse) {
        ctx.scales.set(s.name, entry.scale)
        ctx.scaleTypes.set(s.name, s.type)
        entries.set(s.name, entry)
        ctx.scaleReuse.set(s.name, { stamp, entry })
        continue
      }
    }
    let scale: Scale
    try {
      scale = buildScale(def, scaleContext(ctx, def.name))
    } catch (e) {
      // vega: the Scale operator throws, the dataflow logs it and the run stops there -- this scale
      // and every operator after it (later scales, every encode) are never evaluated.
      reportEvalError(ctx, e)
      ctx.encodeAborted = true
      break
    }
    ctx.scales.set(s.name, scale)
    ctx.scaleTypes.set(s.name, s.type)
    const entry: ScaleEntry = { scale, multi }
    // Track the domain census for a single-data-domain scale so a later update
    // can prove the domain unchanged instead of rescanning.
    if (dom) {
      const rows = ctx.datasets.get(dom.data) ?? []
      if (DISCRETE_TYPES.has(s.type)) {
        if (discreteCensusApplies(dom)) entry.disc = freshDiscCensus(dom, rows)
      } else if (CONTINUOUS_TYPES.has(s.type)) {
        entry.cont = freshContCensus(dom, rows)
      }
    }
    entries.set(s.name, entry)
  }
  ctx.draft.scaleEntries = entries
  ctx.draft.scales = new Map(ctx.scales)
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

/** True for a `{ fields: [...] }` scale domain (several data fields feed one scale). */
function isMultiFieldDomain(domain: ScaleDomain): boolean {
  return !!domain && typeof domain === 'object' && !Array.isArray(domain)
    && !('signal' in domain) && Array.isArray((domain as { fields?: unknown }).fields)
    && (domain as { fields: unknown[] }).fields.length > 0
}

/**
 * Per-datum differential reuse is safe only when publishing the changed indices
 * actually captures every reason a *row* re-encodes to a different item:
 *  - the source dataset has a published pulse (index alignment) consistent with
 *    the previous group's item count,
 *  - no mark sort/transform reorders or derives rows,
 *  - the evaluation context (signals, width/height, overrides) is the one the
 *    previous items were encoded under, and
 *  - every scale the mark reads is the SAME object as last evaluation's (so an
 *    unchanged row encodes to an identical item).
 */
function reusablePulse(
  mark: CompiledMark,
  ctx: EvalContext,
  source: string,
  rowCount: number,
  prevGroup: SceneGroup | null | undefined,
): StepPulse | null {
  const prev = ctx.prev
  if (!prevGroup || !prev || !ctx.incremental) return null
  // The output pulse of the source dataset. `null` means it was fully
  // re-derived without a trustworthy mapping.
  const pulse = ctx.datasetPulses.get(source) ?? null
  if (!pulse || pulse.full) return null
  const prevItems = prevGroup.items as SceneItem[]
  if (pulse.appendOnly) {
    const base = pulse.baseLength ?? prevItems.length
    if (base !== prevItems.length || rowCount < base) return null
  } else if (pulse.from) {
    // Length-changing: retained rows can still be reused at their new index.
    if (pulse.from.length !== rowCount) return null
    if (pulse.to && pulse.to.length !== prevItems.length) return null
  } else if (rowCount !== prevItems.length) {
    return null
  }
  if (mark.sort || mark.transform?.length) return null
  const deps = markDepsOf(mark, ctx.chart)
  // Reading other datasets from an expression: an unchanged row can still
  // encode differently, and no pulse describes that.
  if (deps.allData) return null
  if (prev.fp !== ctx.draft.fp) return null
  for (const name of markScaleNames(mark, ctx.chart)) {
    if (ctx.scales.get(name) !== prev.scales.get(name)) return null
  }
  return pulse
}

/** A mark `transform` vega runs on the encoded items (see evaluateMarkItems). */
const ITEM_TRANSFORMS: ReadonlySet<string> = new Set(['voronoi', 'lookup', 'linkpath', 'force', 'geopath', 'label', 'heatmap', 'wordcloud'])
function isItemTransform(t: CompiledTransform): boolean {
  return ITEM_TRANSFORMS.has(String(t.type))
}

/** The bounds of one item of a mark, in the frame of the mark's group (vega's `item.bounds`). */
function itemBoundsOf(container: { marktype: string }, item: SceneItem): { x1: number; y1: number; x2: number; y2: number } {
  const b = container.marktype === 'group' ? boundGroupItem(new Bounds(), item as unknown as SceneGroup) : boundTypedMark(new Bounds(), { marktype: container.marktype, items: [item] } as unknown as SceneGroup)
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
}

function evaluateMark(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup?: SceneGroup | null,
): SceneGroup | SceneGroup[] | null {
  const built = evaluateMarkItems(mark, ctx, prevGroup)
  // a named mark's items are what a later mark of `from: {data: <name>}` reads
  if (built && typeof mark.name === 'string') {
    // (a group mark's items are the group items themselves, a mark's are the items of its container)
    if (mark.type === 'group') {
      if (Array.isArray(built)) {
        ctx.markItems.set(mark.name, built as unknown as SceneItem[])
        ctx.markContainers.set(mark.name, { marktype: 'group', items: built as unknown as SceneItem[] })
      }
    } else if (!Array.isArray(built)) {
      ctx.markItems.set(mark.name, (built.items ?? []) as SceneItem[])
      ctx.markContainers.set(mark.name, built as unknown as { marktype: string; items: SceneItem[] })
    }
  }
  return built
}

function evaluateMarkItems(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup?: SceneGroup | null,
): SceneGroup | SceneGroup[] | null {
  // a scale or an encode that threw stopped vega's run: the marks after it were never joined, so they are not in the scenegraph
  if (ctx.encodeAborted) return null
  if (mark.type === 'group') {
    return buildGroupMark(mark, ctx)
  }
  const source = mark.from?.data
  if (source && ctx.failedDatasets?.has(source)) return null

  let items: SceneItem[]
  // Union bounds carried over from the previous group (pure appends only) and
  // the items appended to it, so the cache survives without a recomputation.
  let carriedBounds: Bounds | undefined
  const addedItems: SceneItem[] = []
  let pendingUndo: ItemsUndo | undefined
  let hitMarked = false
  if (source) {
    // (a source that is no dataset but the name of a mark built before: that mark's items, shallow-copied as vega's tuples)
    const rawRows = ctx.datasets.get(source) ?? ctx.markItems.get(source)?.map((it) => ({ ...(it as unknown as Row) })) ?? []
    // (a `label` transform reads the mark an item is in, and its bounds, off the item it labels: see `ITEM_MARK`)
    if (!ctx.datasets.has(source) && mark.transform?.some((t) => t.type === 'label')) {
      const container = ctx.markContainers.get(source)
      const from = ctx.markItems.get(source)
      if (container !== undefined && from !== undefined) {
        rawRows.forEach((row, i) => {
          const it = from[i]!
          Object.defineProperty(row, ITEM_MARK, { value: { marktype: container.marktype, container, bounds: () => itemBoundsOf(container, it) }, enumerable: true, configurable: true, writable: true })
        })
      }
    }
    // Only clone rows when the pipeline will re-encode them all (a mark-level
    // transform); the differential path reads the raw rows and clones
    // just the changed indices, so an unchanged row is never copied.
    let rows: Row[] = rawRows
    let rowsCloned = false
    // (vega runs a mark's transforms on the ENCODED items, after the encode; `voronoi`, `lookup` and `linkpath`,
    // which read item properties (`datum.index`, `sourceNode.x`) and other marks' items, are run that way below)
    const preTransforms = mark.transform?.filter((t) => !isItemTransform(t))
    if (preTransforms?.length) {
      rows = rawRows.map((r) => ({ ...r }))
      rowsCloned = true
      try {
        rows = applyTransforms(rows, preTransforms, {
          runtime: ctx.runtime,
          signals: ctx.signalParams,
          hierarchies: ctx.hierarchies,
          projections: ctx.projections,
        }, source)
      } catch (e) {
        // a mark-level transform that throws publishes nothing (see buildDatasetsOf)
        reportEvalError(ctx, e)
        return null
      }
    }

    // Keep dataset order for rect items: vega's scene keeps data order and
    // every renderer paints the array front to back (later datum on top).
    const encodeRows = rows

    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    ctx.encodeBinding = encodeBindingFor(update, ctx)
    // Per-datum differential update: when the source dataset published a pulse
    // and reuse is provably safe (see reusablePulse), keep the previous item
    // objects for unchanged indices so the DOM patcher skips them and the
    // re-encode of those items is skipped entirely (including the row clone).
    // `rows` is in dataset order (pulse indices refer to it).
    //
    // A returned scene is never observably written (C52): structural updates
    // build a new array; appends/edits advance the engine-owned array in place
    // and turn the superseded group into a lazy snapshot (supersedeItems).
    // One item per row: refuse an over-sized mark before encoding any of it, and
    // sample the wall clock inside the encode loops (C7).
    const meter = activeMeter()
    if (meter) meter.items(encodeRows.length, `mark ${mark.type} encoding`)
    const pulse = reusablePulse(mark, ctx, source, encodeRows.length, prevGroup)
    if (pulse) {
      const prevItems = prevGroup!.items as SceneItem[]
      const gen = ctx.gen
      // (an interactive mark's transparent items are marked `_hit` as they are encoded: an update touches only these)
      hitMarked = true
      const hittable = mark.interactive !== false
      const encodeAt = (i: number): SceneItem => {
        if (meter) meter.tick('mark encoding')
        const row = { ...(rows[i] as Row) }
        const res = resolveEncodeSet(update, row, ctx, mark.type)
        res.datum = row
        res.__gen = gen
        if (hittable && (res as { fill?: unknown }).fill === 'transparent') (res as unknown as Record<string, unknown>)._hit = true
        return res
      }
      if (pulse.appendOnly) {
        const base = pulse.baseLength ?? prevItems.length
        // O(changes): advance the engine-owned array in place; the previous
        // group is turned into a lazy snapshot below (supersedeItems).
        const undo: ItemsUndo = { oldLen: prevItems.length, idx: [], items: [] }
        // The cached union bounds carry over to the new group only for a pure
        // append (re-encoded items could shrink them).
        if (!pulse.changed.length) carriedBounds = GROUP_BOUNDS.get(prevGroup!)?.clone()
        try {
          for (const i of pulse.changed) {
            if (i < 0 || i >= base) continue
            undo.idx.push(i)
            undo.items.push(prevItems[i]!)
            prevItems[i] = encodeAt(i)
          }
          for (let i = base; i < encodeRows.length; i++) {
            const item = encodeAt(i)
            prevItems.push(item)
            addedItems.push(item)
          }
        } catch (e) {
          // Never leave the (still current) previous scene half-updated.
          prevItems.length = undo.oldLen
          for (let k = undo.idx.length - 1; k >= 0; k--) prevItems[undo.idx[k]!] = undo.items[k]!
          throw e
        }
        // Stamp the array when an EXISTING item was re-encoded in place, so a
        // consumer holding a snapshot (canvas append) can tell "pure append"
        // from "edited" in O(1) without scanning, or reading, the old scene.
        if (undo.idx.length) (prevItems as SceneItem[] & { __editGen?: number }).__editGen = ctx.gen
        items = prevItems
        pendingUndo = undo
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
        const next = prevItems.slice()
        for (const i of pulse.changed) {
          if (i < 0 || i >= next.length) continue
          next[i] = encodeAt(i)
        }
        items = next
      }
    } else {
      const gen = ctx.gen
      if (meter) {
        // Same loop with the clock sampled every 1024 items (limits ON only).
        items = new Array<SceneItem>(encodeRows.length)
        for (let i = 0; i < encodeRows.length; i++) {
          const copy = rowsCloned ? encodeRows[i]! : { ...encodeRows[i]! }
          const res = resolveEncodeSet(update, copy, ctx, mark.type)
          res.datum = copy
          res.__gen = gen
          items[i] = res
          meter.tick('mark encoding')
        }
      } else {
        items = encodeRows.map((row) => {
          const copy = rowsCloned ? row : { ...row }
          const res = resolveEncodeSet(update, copy, ctx, mark.type)
          res.datum = copy
          res.__gen = gen
          return res
        })
      }
    }
  } else {
    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    const res = resolveEncodeSet(update, {}, ctx, mark.type)
    res.__gen = ctx.gen
    items = [res]
  }

  // vega-parser mark.js: a mark's `transform`s that work on the encoded items (voronoi cells over the items'
  // positions, a lookup of another mark's items by `datum.index`, a link path between looked-up items) run right
  // after the encode: the items are the transform's tuples, so `datum.datum` is the source datum. What they
  // compute is written onto the items, in order (the next transform reads it).
  for (const [k, t] of (mark.transform ?? []).entries()) {
    if (!isItemTransform(t) || !source || items.length === 0) continue
    try {
      // (a transform that draws random numbers - the layout of a word cloud - draws them once for the inputs it is given, as
      // vega's operator does, not again for every evaluation of the scene: see random-tape.ts)
      const out = atRandomSite(ctx.runtime.random, `mark:${ctx.scopeId ?? ''}/${markIdOf(mark)}#${k}`, () => randomFingerprint(t, items.map(publicProps), ctx.signalParams), () => applyTransforms(items as unknown as Row[], [t], {
        runtime: ctx.runtime, signals: ctx.signalParams, hierarchies: ctx.hierarchies, projections: ctx.projections,
        // (`lookup` `from` is a dataset, or the name of a mark: its items)
        datasets: (n) => ctx.datasets.get(n) ?? (ctx.markItems.get(n) as unknown as Row[] | undefined),
        // (`label` avoids the marks it names)
        marks: (n) => ctx.markContainers.get(n),
        // (vega's tuples: a force layout moves the items themselves)
        inPlace: true,
      }, source))
      if (t.type === 'voronoi') {
        const as = ((t as { as?: string }).as) ?? 'path'
        items.forEach((it, i) => { (it as unknown as Row)[as] = (out[i] as Row)[as] })
      } else {
        items.forEach((it, i) => { Object.assign(it as unknown as Row, out[i]) })
      }
    } catch (e) {
      reportEvalError(ctx, e)
    }
  }

  // vega's SortItems: a mark `sort` orders the ENCODED items by their own
  // properties (`x`, `datum.t`, `datum["t"]`), after the encode and before the
  // bound pass; stable. A sort that throws is logged and the items stay in data order.
  if (mark.sort && source) {
    try { items = sortMarkItems(items, mark.sort) } catch (e) { reportEvalError(ctx, e) }
  }

  // Items an aborted run never encoded: vega's mark container holds them but they carry no geometry or paint,
  // so (but for the zero-size rect path the renderers already read as `|| 0`) nothing of them is drawn.
  if (ctx.encodeAborted && items.some((it) => (it as { __unencoded?: boolean }).__unencoded === true)) {
    items = items.filter((it) => (it as { __unencoded?: boolean }).__unencoded !== true)
  }

  // Text marks encoded in polar coordinates (`radius` + `theta`, e.g. pie
  // labels): vega's text renderer offsets the anchor by
  // `radius * (cos(theta - π/2), sin(theta - π/2))` from the item's x/y.
  // Vega's mark defaults (vega.js defaults()): line {strokeWidth: 2},
  // area {fill: '#4c78a8'}, text {fill: '#000'} — applied when the encode
  // leaves the property unspecified.
  if (mark.type === 'line' || mark.type === 'area' || mark.type === 'text') {
    // vega-parser's applyDefaults skips the fill/stroke defaults when the ENCODE defines either channel
    const enc = (mark.encode?.update ?? mark.encode?.enter ?? {}) as Record<string, unknown>
    const paintDefined = enc.fill != null || enc.stroke != null
    const fill = paintDefined ? undefined : mark.type === 'text' ? '#000' : mark.type === 'area' ? '#4c78a8' : undefined
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

  // Image URLs are spec-controlled: vet each through the URL policy (C93) so a
  // hostile spec cannot make the viewer's browser request arbitrary URLs.
  // Applied here, on the scene, so the string renderer, the DOM path and canvas
  // all see the same vetted items.
  if (mark.type === 'image') {
    for (const it of items) {
      if (it.url == null) continue
      const vetted = applyImageUrlPolicy(it.url, ctx.urlPolicy)
      if (vetted == null) it.url = undefined
      else {
        const resolved = resolveImageUrl(vetted, ctx.urlPolicy?.baseURL)
        // (what is drawn is what the policy vetted: the url the base turns it into goes through it too)
        const final = resolved !== vetted ? applyImageUrlPolicy(resolved, ctx.urlPolicy) : resolved
        it.url = (final == null ? undefined : final) as string | undefined
      }
    }
  }

  vetLinks(mark, items, ctx)

  // An interactive mark's transparent items are still hit by the pointer: vega's live SVG draws them with
  // `fill="transparent"`, which the string renderer (like ours) omits. `_hit` marks them for `pointer-events`.
  if (mark.interactive !== false && !hitMarked) {
    for (const it of items) if ((it as { fill?: unknown }).fill === 'transparent') (it as unknown as Record<string, unknown>)._hit = true
  }

  // Appended items extend the carried union bounds only now, after the mark
  // defaults above ran (they can change an item's stroke and so its bounds).
  const group: SceneGroup = {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    ...markClipOf(mark, ctx),
    items,
    __source: mark.from?.data,
    ...(encodesHref(mark) ? { hasLinks: true } : {}),
    ...markContainerInfo(mark),
  }
  if (carriedBounds) {
    for (const it of addedItems) carriedBounds.union(boundLeaf(new Bounds(), it))
    GROUP_BOUNDS.set(group, carriedBounds)
  }
  if (pendingUndo && prevGroup) supersedeItems(prevGroup, group, pendingUndo)
  return group
}

/**
 * Hyperlinks (the `href` channel) pass the same URL policy as images and loaded
 * data (C93), here on the scene so every renderer sees vetted items. The
 * renderers additionally sanitize whatever they are handed (`sanitizeHref`,
 * vega-loader's rule), so with no policy a script URL is still never linked.
 */
function encodesDescription(mark: CompiledMark): boolean {
  const enc = mark.encode as Record<string, Record<string, unknown> | undefined> | undefined
  return !!enc && Object.values(enc).some((set) => set && 'description' in set)
}

function encodesHref(mark: CompiledMark): boolean {
  const enc = mark.encode as Record<string, Record<string, unknown> | undefined> | undefined
  return !!enc && Object.values(enc).some((set) => set && 'href' in set)
}

function vetLinks(mark: CompiledMark, items: SceneItem[], ctx: EvalContext): void {
  if (ctx.urlPolicy === undefined || !encodesHref(mark)) return
  for (const it of items) {
    if (it.href == null) continue
    if (applyLinkUrlPolicy(it.href, ctx.urlPolicy) == null) it.href = undefined
  }
}

/** vega SortItems: the items ordered by their own properties (a stable sort). */
function sortMarkItems(items: SceneItem[], sort: NonNullable<CompiledMark['sort']>): SceneItem[] {
  const order = sortOrder(items as unknown as Row[], sort as never)
  return order.map((i) => items[i]!)
}

// ===========================================================================
// Group marks: vega's Mark + Encode + SortItems + ViewLayout, one group item at a time
// ===========================================================================

/** One group item to build: its datum, and for a facet the partition's rows. */
interface GroupSource {
  datum: Row
  rows?: Row[]
  facetName?: string
  /** Names this item among its mark's (the facet partition's key, a datum's index): the identity of its signal scope. */
  key?: string
}

interface FacetDef {
  name: string
  data: string
  /** Pre-faceted data: each datum holds the array of the group's rows in this field. */
  field?: string
  groupby?: string | string[]
  aggregate?: { fields?: string[]; ops?: string[]; as?: string[]; cross?: boolean }
}

/**
 * The items a group mark produces (vega parse/mark.js + marks/data.js): one per
 * facet partition of the source data (first-appearance order, datum = the
 * partition's key fields plus any facet aggregate), one per datum of `from.data`,
 * or a single item with no source.
 */
function groupSources(mark: CompiledMark, ctx: EvalContext): GroupSource[] {
  const facet = (mark.from as { facet?: FacetDef } | undefined)?.facet
  if (facet?.field !== undefined) {
    // vega-transforms PreFacet: one group item per datum (the datum is the item's datum), its rows the array the
    // datum holds in `field`
    const get = fieldOf(facet.field)
    return (ctx.datasets.get(facet.data) ?? []).map((row, i) => ({
      datum: row,
      rows: ingestRows((get(row) as Row[]).map((x) => x)),
      facetName: facet.name,
      key: String(i),
    }))
  }
  if (facet) {
    const keys = ([] as string[]).concat(facet.groupby ?? [])
    if (!keys.length) return []
    const rows = ctx.datasets.get(facet.data) ?? []
    const from = mark.from?.data
    if (from !== undefined && ctx.datasets.has(from)) {
      // vega-parser marks/data.js: with `from.data` the items are ITS rows (the datum is the row, not a partition key), and each
      // item's facet is the rows of `facet.data` that share its key; a row with no partition still gets an item, a partition no
      // row asks for none
      const keyOfRow = groupKeyFn(keys)
      const byKey = new Map<string, Row[]>()
      for (const r of rows) {
        const k = keyOfRow(r)
        const g = byKey.get(k)
        if (g) g.push(r)
        else byKey.set(k, [r])
      }
      return (ctx.datasets.get(from) ?? []).map((row, i) => {
        const part = byKey.get(keyOfRow(row))
        return { datum: row, rows: part ?? [], facetName: facet.name, key: String(i) }
      })
    }
    // the keys are vega fields (`a.b`, `a\.b`): the partition is by the accessor
    const keyOf = groupKeyFn(keys)
    const parts = new Map<string, Row[]>()
    for (const r of rows) {
      const k = keyOf(r)
      const g = parts.get(k)
      if (g) g.push(r)
      else parts.set(k, [r])
    }
    // vega's own facet aggregate (vega-parser marks/data.js): an `aggregate` over the groupby makes the group item's datum - the
    // key fields plus the facet's measures, `count` by default (a cell's datum carries the partition's size); with `cross` it also
    // makes the empty cells of the full cross-product of the key values
    const ag = facet.aggregate
    const as = ag?.as ?? (ag?.ops ? ag.ops.map((op, i) => `${op}_${ag.fields?.[i]}`) : undefined)
    const tuples = aggregateRows(rows, { groupby: keys, ...(ag?.ops ? { fields: ag.fields, ops: ag.ops, as } : {}), ...(ag?.cross ? { cross: true } : {}) })
    return tuples.map((datum) => {
      const partKey = keyOf(datum)
      // (the aggregate's output is a tuple: `isTuple(group().datum)`)
      Object.defineProperty(datum, TUPLE_ID, { value: true, enumerable: false })
      return { datum, rows: parts.get(partKey) ?? [], facetName: facet.name, key: partKey }
    })
  }
  const data = mark.from?.data
  if (data) return (ctx.datasets.get(data) ?? []).map((row, i) => ({ datum: row, key: String(i) }))
  return [{ datum: {} }]
}

/**
 * A group mark. Every group item is its own scope (own scales, the facet
 * partition as a dataset, `parent` = its datum) holding, in vega's order, its
 * axes, marks, legends and title; ViewLayout then lays out a `layout` grid of
 * child groups, the guides and the title, and the items are sorted. The
 * header / footer / title groups vega-lite emits around a facet are groups like
 * any other (their `role` is what the enclosing grid layout keys on).
 */
// The group items of one mark share its container in the SVG (vega-scenegraph draws a mark as one `<g>` holding one
// item `<g>` per item), so each item records which mark it came from. Ids are per compiled mark.
const MARK_IDS = new WeakMap<CompiledMark, number>()
let nextMarkId = -1
function markIdOf(mark: CompiledMark): number {
  // (a mark from `compileChart` carries its position in the spec; a hand-built one gets a negative id of its own)
  if (mark.seq !== undefined) return mark.seq
  let id = MARK_IDS.get(mark)
  if (id === undefined) MARK_IDS.set(mark, (id = nextMarkId--))
  return id
}

/** What the SVG container of a mark says beyond its type (vega-scenegraph cssClass, ariaMarkAttributes, pointer-events). */
function markContainerInfo(mark: CompiledMark): Partial<SceneGroup> {
  const out: Partial<SceneGroup> = {}
  if (mark.userName !== undefined) out.cssName = mark.userName
  if (mark.type !== 'group' && mark.role !== undefined) out.markRole = mark.role
  if (mark.description !== undefined) out.description = mark.description
  if (encodesDescription(mark)) out.describes = true
  if (mark.aria === false) out.aria = false
  if (mark.interactive === false) out.interactive = false
  return out
}

function buildGroupMark(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const sources = groupSources(mark, ctx)
  // one group item (and one scope) per datum / facet partition: bounded like any generated item (maxItems, the clock)
  meterItems(sources.length, 'group items')
  const groups = sources.map((src) => { meterTick('group item'); return buildGroupItem(mark, ctx, src) })
  // a group mark with no items is still a container in the scenegraph (vega-scenegraph draws every mark's `<g>`)
  if (!groups.length) return [{ marktype: 'group', role: (mark.role as string | undefined) ?? 'scope', name: mark.name, items: [], emptyMark: true, markIndex: markIdOf(mark), ...markContainerInfo(mark), ...(markClip(mark, ctx) ? { markClip: true } : {}) } as unknown as SceneGroup]
  // SortItems: the group items are ordered by their own properties (`datum["g"]`, `x`, ...)
  if (mark.sort && groups.length > 1) {
    try { return sortMarkItems(groups as SceneItem[], mark.sort) as SceneGroup[] } catch (e) {
      // vega logs a sort that throws and leaves the items in data order
      reportEvalError(ctx, e)
    }
  }
  return groups
}

const GROUP_PAINT_KEYS = ['fill', 'stroke', 'strokeWidth', 'strokeOpacity', 'fillOpacity', 'opacity', 'strokeDash', 'strokeDashOffset', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'strokeOffset'] as const
const GROUP_CORNER_KEYS = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft'] as const

/**
 * A group item's background (and, with `strokeForeground`, foreground) rectangle, as
 * vega-scenegraph marks/group.js emits it: the rectangle of the item's own width/height with its
 * corner radii, inset by the stroke offset (`strokeOffset`, else 0.5 - |sw - 1| for a stroke between
 * 0.5 and 1.5 wide), painted with the item's fill/stroke; with `strokeForeground` the stroke moves to
 * a rectangle drawn after the contents. Both are flagged `_bg`: they are the group's own box, which
 * the bounds pass covers through its width/height.
 */
function groupBackground(geo: SceneItem, w: number, h: number): { background: SceneItem; foreground?: SceneItem; path: string; paint: Record<string, unknown>; corners: boolean } {
  const rec = geo as unknown as Record<string, unknown>
  const sw = rec.strokeWidth == null ? 1 : Number(rec.strokeWidth)
  const off = rec.strokeOffset != null ? Number(rec.strokeOffset) : rec.stroke && sw > 0.5 && sw < 1.5 ? 0.5 - Math.abs(sw - 1) : 0
  const shape: Record<string, unknown> = { x: off, y: off, width: w, height: h }
  let corners = false
  for (const k of GROUP_CORNER_KEYS) if (rec[k] !== undefined) { shape[k] = rec[k]; corners = true }
  const path = String(rectItemPath(shape as SceneItem))
  const fore = !!rec.strokeForeground
  const paint: Record<string, unknown> = {}
  for (const k of GROUP_PAINT_KEYS) if (rec[k] != null) paint[k] = rec[k]
  const own: Record<string, unknown> = {}
  for (const k of GROUP_PAINT_KEYS) if (rec[k] != null && !(fore && k === 'stroke')) own[k] = rec[k]
  const background = { path, x: 0, y: 0, _bg: true, ...own } as unknown as SceneItem
  if (!fore || !rec.stroke) return { background, path, paint, corners }
  const strokePaint: Record<string, unknown> = {}
  for (const k of GROUP_PAINT_KEYS) if (rec[k] != null && k !== 'fill' && k !== 'fillOpacity') strokePaint[k] = rec[k]
  return { background, foreground: { path, x: 0, y: 0, _bg: true, ...strokePaint } as unknown as SceneItem, path, paint, corners }
}

/**
 * The items of a group item: background, contents, foreground. With the item's `clip` channel the CONTENTS
 * (not the background or foreground, which vega draws outside the clip `<g>`) sit in a nested pass-through
 * group clipped to the item's own rectangle, with its corner radii.
 */
function groupItems(geo: SceneItem, w: number, h: number, content: SceneItem[]): { items: SceneItem[]; paint: Record<string, unknown> } {
  const rec = geo as unknown as Record<string, unknown>
  const bg = groupBackground(geo, w, h)
  const out: SceneItem[] = [bg.background]
  if (rec.clip) {
    // vega's clip: the group's rounded rectangle when any corner radius is truthy (even one that clamps to a
    // square corner, e.g. -4: the clip is then that path, not a rect), else the plain box
    let clipPathD: string | undefined
    if (GROUP_CORNER_KEYS.some((k) => rec[k])) {
      clipPathD = String(rectItemPath({ x: 0, y: 0, width: w, height: h, ...Object.fromEntries(GROUP_CORNER_KEYS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]])) } as SceneItem))
    }
    out.push({ marktype: 'group', role: 'scope', clip: true, contentClip: true, ...(clipPathD ? { clipPathD } : {}), width: w, height: h, x: 0, y: 0, items: content as SceneNode[] } as unknown as SceneItem)
  } else {
    pushAll(out, content)
  }
  if (bg.foreground) out.push(bg.foreground)
  return { items: out, paint: bg.paint }
}

/**
 * A mark's `clip` (vega-parser marks/clip.js): a boolean; a `{signal}` (a truthy value clips, and a SHAPE -- what `geoShape()` or
 * `pathShape()` return -- clips to the path it draws); `{path}`, the clip to an SVG path (`pathShape(path)`); `{sphere}`, the clip to
 * a projection's sphere (`geoShape(projection, {type: "Sphere"})`, in pixels). A shape's path replaces the frame of the group the
 * mark sits in as the region the mark is clipped to.
 */
function markClipOf(mark: CompiledMark, ctx: EvalContext): { clip: boolean; clipPathD?: string } {
  const c = (mark as { clip?: unknown }).clip
  if (c === null || typeof c !== 'object') return { clip: !!c }
  const o = c as { signal?: unknown; path?: unknown; sphere?: unknown }
  const param = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string' ? ctx.runtime.expr((v as { signal: string }).signal)({}, ctx.signalParams) : v
  let shape: string | undefined
  let truthy = true
  if (o.signal) {
    const v = ctx.runtime.expr(String(o.signal))({}, ctx.signalParams)
    // (a shape is drawn into the clip: given no context it is its path string)
    if (typeof v === 'function') shape = String((v as (context: null) => unknown)(null) ?? '')
    else truthy = !!v
  } else if (o.path) {
    shape = String(param(o.path))
  } else if (o.sphere) {
    const projection = ctx.runtime.projection?.(String(param(o.sphere)))
    shape = projection && geoRegistry.projectedPath ? geoRegistry.projectedPath(projection, { type: 'Sphere' }) : ''
  } else return { clip: !!c }
  return shape !== undefined ? { clip: true, ...(shape !== '' ? { clipPathD: shape } : {}) } : { clip: truthy }
}

/** Whether a mark is clipped to the frame of its group (see {@link markClipOf}). */
function markClip(mark: CompiledMark, ctx: EvalContext): boolean {
  return markClipOf(mark, ctx).clip
}

/**
 * The signals a group item's scope declares (vega: a group mark's `signals`, one set per item): each starts from the value
 * the host stored for it (`<scope id>:<name>`, the event loop's state, which outlives the scene), else its `init`, else its
 * `value`; an `update` signal is derived and always recomputed. `push: "outer"` declares nothing here (its handlers write to
 * the enclosing scope's signal). Returns the group's parameters (the enclosing ones plus these) and the scope's values.
 */
function scopeSignalValues(mark: CompiledMark, ctx: EvalContext, id: string, base: Record<string, unknown>): { params: Record<string, unknown>; values: Record<string, unknown> } {
  const params = dict<unknown>(base)
  const values: Record<string, unknown> = {}
  const defs = (mark.signalDefs ?? []).filter((d) => d.push !== 'outer')
  const evalIn = (code: string): unknown => {
    try { return ctx.runtime.expr(code)({}, params) } catch (e) { reportEvalError(ctx, e); return undefined }
  }
  for (const d of defs) {
    if (typeof d.update === 'string') continue
    const key = scopedSignalName(id, d.name)
    const v = Object.hasOwn(ctx.signalParams, key) ? ctx.signalParams[key] : typeof d.init === 'string' ? evalIn(d.init) : d.value
    params[d.name] = v
    values[d.name] = v
  }
  // derived signals read the others (and each other): a few rounds settle any acyclic chain
  const derived = defs.filter((d) => typeof d.update === 'string')
  for (let round = 0; round < Math.max(1, derived.length) && derived.length; round++) {
    for (const d of derived) {
      const v = evalIn(d.update!)
      params[d.name] = v
      values[d.name] = v
    }
  }
  return { params, values }
}

function buildGroupItem(mark: CompiledMark, ctx: EvalContext, src: GroupSource): SceneGroup {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  // the facet partition is a dataset for everything in this item's scope, its own scales included
  const savedFacet = src.facetName !== undefined ? ctx.datasets.get(src.facetName) : undefined
  // a cell of the full cross-product with no rows of its own (`cross` on a facet aggregate): vega's facet subflow never starts for
  // it, so the item is the empty group - none of its marks, axes, legends or title exist
  const hollow = src.facetName !== undefined && (src.rows?.length ?? 0) === 0
  if (src.facetName !== undefined) ctx.datasets.set(src.facetName, src.rows!)
  // the group's own datasets (vega: a group's `data`), derived in this item's scope
  const savedData: Array<[string, Row[] | undefined]> = []
  // the scales this item declares are visible to the expressions of its content (`bandwidth('child_x')`), over the enclosing ones
  let restoreScaleFns: (() => void) | undefined
  let restoreProjectionFns: (() => void) | undefined
  try {
    // this item's signal scope (its own signals, over the enclosing ones; a facet's `parent` is its datum)
    const hasParent = src.facetName !== undefined || mark.from?.data !== undefined
    const outerParams = hasParent ? { ...ctx.signalParams, parent: src.datum } : ctx.signalParams
    const scopeId = mark.signalDefs?.length ? `${ctx.scopeId ? ctx.scopeId + '/' : ''}${mark.userName ?? ''}@${markIdOf(mark)}${src.key !== undefined && src.key !== '' ? `[${src.key}]` : ''}` : undefined
    const scoped = scopeId !== undefined ? scopeSignalValues(mark, ctx, scopeId, outerParams) : undefined
    const scopeParams = scoped ? scoped.params : outerParams
    // vega builds the instances of nested scopes level by level: what an aborted pass did not reach is not made
    const path = [...ctx.scope.path, ctx.scope.nextChild.n++]
    const order = ctx.abort.cut === undefined ? -1 : compareInstances(path, ctx.abort.cut.path)
    // this item's projections (vega: its scope's Projection operators, made right after the signals); the type is a parameter like
    // any other, in this scope (`type: {signal: "parent.data"}`). One that cannot be made stops the pass there: see AbortPoint.
    const own = order < 0 ? scopedProjections(mark, ctx, scopeParams, path) : undefined
    if (order === 0 && ctx.abort.cut!.projection) ctx.failed = true
    if (own?.registry) {
      const outerProjection = ctx.runtime.projection
      ctx.runtime.projection = (n) => own.registry!.get(n) ?? outerProjection?.(n)
      restoreProjectionFns = () => { ctx.runtime.projection = outerProjection }
    }
    for (const d of mark.data ?? []) {
      const sources = sourceNames(d)
      let rows: Row[] = sources.length ? sources.flatMap((n) => (ctx.datasets.get(n) ?? []).map((r) => ({ ...r }))) : d.values != null ? readData(inlineValues(ctx, d.values), d.format) : []
      checkRowCount(rows.length, `dataset "${d.name}"`)
      if (d.transform?.length) {
        rows = applyTransforms(rows, d.transform, { runtime: ctx.runtime, signals: scopeParams, hierarchies: ctx.hierarchies, projections: ctx.projections }, d.name)
      }
      savedData.push([d.name, ctx.datasets.get(d.name)])
      ctx.datasets.set(d.name, rows)
    }
    const encode = (mark.encode?.update ?? {}) as Record<string, EncodeValue | EncodeValue[]>
    const geo = resolveEncodeSet(encode, src.datum, scoped ? { ...ctx, signalParams: scopeParams } : ctx, 'group')
    const gx = num(geo.x) ?? 0
    const gy = num(geo.y) ?? 0
    const gw = Math.max(0, num(geo.width) ?? 0)
    const gh = Math.max(0, num(geo.height) ?? 0)

    // own scales resolve against the view's signals (vega: width / height are the view's), the
    // facet partition as data
    const childScales = new Map<string, Scale>()
    const childTypes = new Map<string, string>()
    // (`range: "width" | "height"` is the signal of that name as the scope sees it: a group that declares its own
    // `height` signal sizes its scales by that, and so do the scopes below it)
    const scopedView = (name: 'width' | 'height'): number => {
      const v = scoped?.values[name]
      return typeof v === 'number' && Number.isFinite(v) ? v : (name === 'width' ? ctx.viewWidth ?? ctx.width : ctx.viewHeight ?? ctx.height)
    }
    const viewW = scopedView('width')
    const viewH = scopedView('height')
    for (const sdef of mark.scales ?? []) {
      childScales.set(sdef.name, buildScale(sdef, scaleContext({ ...ctx, signalParams: scopeParams, width: viewW, height: viewH }, sdef.name)))
      childTypes.set(sdef.name, sdef.type)
    }
    if (childScales.size) {
      const outerScale = ctx.runtime.scale
      ctx.runtime.scale = (n) => (childScales.get(n) as never) ?? outerScale(n)
      restoreScaleFns = () => { ctx.runtime.scale = outerScale }
    }
    // (the instance that failed in its last operator was made whole)
    const whole = order === 0 && ctx.abort.cut!.late === true
    // (nothing laid out a group that has an instance at or after the stopped one in its subtree)
    if (order >= 0) for (let up: GuideScope | undefined = ctx.scope; up && !up.unsettled; up = up.parent) up.unsettled = true
    const scope: GuideScope = {
      parent: ctx.scope, path, nextChild: { n: 0 }, unsettled: order >= 0,
      scales: mark.scales ?? NO_DECLARED, data: mark.data ?? NO_DECLARED, facet: src.facetName,
    }
    const childCtx: EvalContext = {
      ...ctx,
      scope,
      viewWidth: viewW,
      viewHeight: viewH,
      width: gw,
      height: gh,
      groupX: gx,
      groupY: gy,
      scales: childScales.size ? new Map([...ctx.scales, ...childScales]) : ctx.scales,
      scaleTypes: childTypes.size ? new Map([...ctx.scaleTypes, ...childTypes]) : ctx.scaleTypes,
      ...(own?.registry ? { projections: own.registry } : {}),
      signalParams: scopeParams,
      ...(scopeId !== undefined ? { scopeId } : {}),
    }

    const content: SceneGroup[] = []
    for (const child of hollow || order > 0 || (order === 0 && !whole && ctx.abort.cut!.legend === undefined) ? [] : mark.marks ?? []) {
      const r = evaluateMark(child, childCtx)
      if (r) pushAll(content, Array.isArray(r) ? r : [r])
    }
    // ViewLayout: a `layout` grid positions the child groups (headers, footers, titles, cells) first
    if (mark.layout && !scope.unsettled) {
      try {
        trellisLayout({ marktype: 'group', items: content } as unknown as SceneGroup, resolveLayoutOptions(mark.layout, childCtx))
      } catch {
        // a grid the layout cannot take (vega's gridLayout throws on e.g. fractional `columns`): the dataflow
        // logs it and the cells stay where their encode put them; the view also skips overflow growth
        ctx.layoutState.failed = true
      }
    }

    const guideCtx: EvalContext = scope.unsettled || (ctx.abort.cut !== undefined && entriesPending(path.length, ctx.abort.cut.path.length))
      ? { ...childCtx, ...(scope.unsettled ? { rawGuides: true } : {}), pendingEntries: entriesPending(path.length, ctx.abort.cut!.path.length) }
      : childCtx
    const { groups: guides } = hollow || order > 0
      ? { groups: [] }
      : order === 0 && !whole
        ? buildAxisAndLegend(guideCtx, content, (mark.axes ?? []).slice(0, ctx.abort.cut!.axis), (mark.legends ?? []).slice(0, ctx.abort.cut!.legend ?? 0))
        : buildAxisAndLegend(guideCtx, content, mark.axes ?? [], mark.legends ?? [])
    const siblings: SceneGroup[] = [...content, ...guides]
    const title = hollow || order > 0 || (order === 0 && !whole) ? null : buildTitleGroup(mark.groupTitle, siblings, gw, gh, !!scope.unsettled, guideCtx, src.datum)
    if (title) siblings.push(title)
    const ordered = paintOrderOf(siblings)

    // the item's `clip` (encode) clips its content to its own box; the mark's `clip` clips the whole mark to the enclosing group
    const { items: groupContent, paint } = groupItems(geo, gw, gh, ordered)
    // a hyperlinked group (`href` in its encode) is vetted like any mark's link
    let href = (geo as Record<string, unknown>).href
    if (href != null && ctx.urlPolicy !== undefined && applyLinkUrlPolicy(href, ctx.urlPolicy) == null) href = undefined
    const role = (mark.role as string | undefined) ?? 'scope'
    // the item's own aria channels (vega-scenegraph ariaItemAttributes, on the item's `<g>`)
    const itemAria = itemAriaOf(geo as Record<string, unknown>)

    const group = {
      marktype: 'group', name: mark.name, role, x: gx, y: gy, width: gw, height: gh,
      items: groupContent,
      ...paint,
      datum: src.datum,
      _scope: true,
      markIndex: markIdOf(mark),
      ...markContainerInfo(mark),
      ...(itemAria !== undefined ? { itemAria } : {}),
      ...(cursorOf(geo) !== undefined ? { cursor: cursorOf(geo) } : {}),
      ...(href != null ? { href: href as string } : {}),
      ...(markClip(mark, ctx) ? { markClip: true } : {}),
    } as unknown as SceneGroup
    // (an instance the aborted pass never reached has no operators, so no scales)
    if (mark.scales?.length && order <= 0) group.__scales = snapshotScales(childScales)
    if (scoped && scopeId !== undefined) {
      group.scopeSignals = { id: scopeId, defs: mark.signalDefs!, values: scoped.values, hasContent: (mark.marks?.length ?? 0) + (mark.axes?.length ?? 0) + (mark.legends?.length ?? 0) > 0 || mark.groupTitle !== undefined }
      // the scales this scope declares, for the handlers of its signals (`scale('x', ...)` resolves through the scope chain)
      if (childScales.size) Object.defineProperty(group, '__scaleFns', { value: childScales, enumerable: false })
    }
    return group
  } finally {
    restoreScaleFns?.()
    restoreProjectionFns?.()
    for (const [name, prev] of savedData.reverse()) {
      if (prev !== undefined) ctx.datasets.set(name, prev)
      else ctx.datasets.delete(name)
    }
    if (src.facetName !== undefined) {
      if (savedFacet !== undefined) ctx.datasets.set(src.facetName, savedFacet)
      else ctx.datasets.delete(src.facetName)
    }
  }
}

/** A group item's own `cursor` channel (vega: `item.cursor`, what the pointer shows over the group), when it is a name. */
function cursorOf(item: object): string | undefined {
  const c = (item as { cursor?: unknown }).cursor
  return typeof c === 'string' && c !== '' ? c : undefined
}

/** The layout options of a group mark / the view: signals resolved (vega scope.objectProperty). */
function resolveLayoutOptions(layout: Record<string, unknown>, ctx: EvalContext): Record<string, unknown> {
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.signal === 'string') {
        try { return ctx.runtime.expr(o.signal)({}, ctx.signalParams) } catch { return undefined }
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]))
    }
    return v
  }
  return resolve(layout) as Record<string, unknown>
}



// ===========================================================================
// Trellis layout (exact port of vega's ViewLayout/trellisLayout)
// ===========================================================================

// ===========================================================================
// Concat support (horizontal, vertical, and 2D repeat grids)
// ===========================================================================

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
  /** Each plain key's spec and its shape (EK_*), so the per-row loop does no shape tests. */
  plainSpecs: Array<EncodeValue | EncodeValue[]>
  plainKinds: Uint8Array
}

// Encode entry shapes with a dedicated per-row path; everything else takes the general evaluator.
const EK_GENERIC = 0
/** `{value: <primitive>}` and nothing else. */
const EK_CONST = 1
/** `{field: <path>}` and nothing else. */
const EK_FIELD = 2
/** `{scale: <name>, field: <path>}` and nothing else. */
const EK_SCALE_FIELD = 3

function encodeKind(spec: EncodeValue | EncodeValue[] | undefined): number {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) return EK_GENERIC
  const keys = Object.keys(spec)
  const rec = spec as unknown as Record<string, unknown>
  if (keys.length === 1) {
    if (keys[0] === 'value' && (rec.value === null || typeof rec.value !== 'object')) return EK_CONST
    if (keys[0] === 'field' && typeof rec.field === 'string') return EK_FIELD
  } else if (keys.length === 2 && typeof rec.scale === 'string' && typeof rec.field === 'string') {
    return EK_SCALE_FIELD
  }
  return EK_GENERIC
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
  const plainSpecs = plainKeys.map((k) => encode[k]!)
  const plainKinds = Uint8Array.from(plainSpecs, encodeKind)
  plan = { plainKeys, signalKeys, definedSpec, plainSpecs, plainKinds }
  encodePlanCache.set(encode, plan)
  return plan
}

/**
 * A paint that is a gradient object stays on the item (vega's scene keeps it too); its definition goes into the scene's
 * defs, which the renderers reference it by (see `gradientRef`).
 */
function registerGradient(paint: object, ctx: EvalContext): void {
  if (!isGradientPaint(paint)) return
  const def = gradientDefOf(paint)
  if (!ctx._defs.some((d) => d.id === def.id)) ctx._defs.push(def)
}

function resolveEncodeSet(encode: Record<string, EncodeValue | EncodeValue[]>, datum: Row, ctx: EvalContext, marktype: string): SceneItem {
  if (ctx.encodeAborted) return { __unencoded: true } as SceneItem
  const plan = encodePlan(encode)
  const binding = ctx.encodeBinding

  // The encoded channel values (pixels, colours, ...) live on the scene ITEM and
  // are never written back onto the datum: `datum` is the caller's data row, and
  // tooltips, signals and interactions read data values from it (C21). A data
  // field named like a channel (`x`, `size`, `fill`) therefore keeps its value.
  // `defined` is evaluated against the data tuple, as Vega does.
  let definedValue: unknown
  if (plan.definedSpec !== undefined) {
    try {
      definedValue = resolveEncodeProperty(plan.definedSpec, datum, ctx, binding)
    } catch (e) {
      reportEvalError(ctx, e)
      ctx.encodeAborted = true
      return {}
    }
  }

  // Pass 1: resolve all non-signal values straight into the item (no
  // intermediate per-row object — this is the hottest loop in the engine).
  const item: SceneItem = {}
  const rec = item as unknown as Record<string, unknown>
  // vega's Encode throws at the first failing channel; the dataflow logs it and stops the run:
  // this item keeps the channels evaluated before the failure and no later item is encoded.
  try {
    const { plainKeys, plainSpecs, plainKinds } = plan
    for (let i = 0; i < plainKeys.length; i++) {
      let resolved: unknown
      switch (plainKinds[i]) {
        case EK_CONST: resolved = (plainSpecs[i] as { value: unknown }).value; break
        case EK_FIELD: resolved = getField(datum, (plainSpecs[i] as { field: string }).field); break
        case EK_SCALE_FIELD: {
          const spec = plainSpecs[i] as unknown as { scale: string; field: string }
          const bound = binding?.get(spec)
          if (bound) resolved = scaleValue(bound.scale, bound.type, getField(datum, spec.field))
          else {
            const s = ctx.scales.get(spec.scale)
            resolved = s ? scaleValue(s, ctx.scaleTypes.get(spec.scale), getField(datum, spec.field)) : undefined
          }
          break
        }
        default: resolved = resolveEncodeProperty(plainSpecs[i], datum, ctx, binding)
      }
      if (resolved !== undefined) {
        rec[plainKeys[i]!] = resolved
      }
    }

    if (definedValue !== undefined) {
      rec['defined'] = definedValue
    }
    for (const key of plan.signalKeys) {
      const resolved = resolveEncodeProperty(encode[key], datum, ctx, binding)
      if (resolved !== undefined) {
        rec[key] = resolved
      }
    }
  } catch (e) {
    reportEvalError(ctx, e)
    ctx.encodeAborted = true
    // vega evaluates the channels in spec order, so the failing item keeps exactly the channels
    // BEFORE the failing one (the two passes above group plain values ahead of signals).
    const partial: SceneItem = {}
    const prec = partial as unknown as Record<string, unknown>
    for (const key of Object.keys(encode)) {
      try {
        const v = resolveEncodeProperty(encode[key], datum, ctx, binding)
        if (v !== undefined) prec[key] = v
      } catch {
        break
      }
    }
    return partial
  }
  // a gradient object as a paint (`{gradient: 'linear', stops: [...]}`): its definition joins the scene's defs
  const fillPaint = rec['fill']
  if (fillPaint !== null && typeof fillPaint === 'object') registerGradient(fillPaint, ctx)
  const strokePaint = rec['stroke']
  if (strokePaint !== null && typeof strokePaint === 'object') registerGradient(strokePaint, ctx)
  // Post-process: vega-runtime's `adjustSpatial`, which acts on the CHANNELS the encode defines
  // (not on whether their values came out finite): x2/xc/y2/yc become x/y/width/height. Rule
  // marks skip it entirely (their x2/y2 are line endpoints, not edges); rect/group/image swap so
  // x/y is the min edge. The arithmetic is JS's, so a NaN or missing operand gives NaN, which the
  // renderers read as 0 (`item.width || 0`) exactly as vega's do.
  if (marktype !== 'rule') {
    const canSwap = marktype === 'rect' || marktype === 'group' || marktype === 'image'
    const has = (k: string): boolean => encode[k] != null
    const n = (k: string): number => rec[k] as number
    if (has('x2')) {
      if (has('x')) {
        if (canSwap && n('x') > n('x2')) { const t = rec['x']; rec['x'] = rec['x2']; rec['x2'] = t }
        rec['width'] = n('x2') - n('x')
      } else {
        rec['x'] = n('x2') - (n('width') || 0)
      }
    }
    if (has('xc')) rec['x'] = n('xc') - (n('width') || 0) / 2
    if (has('y2')) {
      if (has('y')) {
        if (canSwap && n('y') > n('y2')) { const t = rec['y']; rec['y'] = rec['y2']; rec['y2'] = t }
        rec['height'] = n('y2') - n('y')
      } else {
        rec['y'] = n('y2') - (n('height') || 0)
      }
    }
    if (has('yc')) rec['y'] = n('yc') - (n('height') || 0) / 2
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
    // Vega conditional encode (vega-parser encode/rule.js): the entries become one
    // expression `(test1)?v1:(test2)?v2:...:vN`, so tests run in order and only the
    // matching branch is evaluated; an entry with no `test` is the "otherwise" value.
    // A test or branch that throws is NOT caught here: in vega the whole encode
    // throws and the dataflow logs it (see resolveEncodeSet, which reports it).
    for (const cond of spec) {
      if (cond && typeof cond === 'object' && 'test' in cond && typeof cond.test === 'string') {
        if (ctx.runtime.expr(cond.test)(datum, ctx.signalParams)) {
          return resolveEncodeValueInternal(cond, datum, ctx, binding)
        }
      } else if (cond && typeof cond === 'object') {
        return resolveEncodeValueInternal(cond, datum, ctx, binding)
      }
    }
    return undefined
  }
  return resolveEncodeValueInternal(spec, datum, ctx, binding)
}

/** The keys of an encode entry (vega-parser encode/entry.js). */
interface EncodeEntry {
  signal?: string
  field?: unknown
  value?: unknown
  scale?: unknown
  range?: unknown
  band?: unknown
  extra?: unknown
  exponent?: unknown
  mult?: unknown
  offset?: unknown
  round?: unknown
  format?: unknown
  formatType?: unknown
}

/**
 * A property that may itself be an encode entry (vega entry.js `property()`):
 * `mult`, `offset`, `exponent` and `band` take a number or a nested entry such as
 * `{signal}`, `{field}` or `{scale, field}`.
 */
function entryProperty(p: unknown, datum: Row, ctx: EvalContext, binding?: EncodeBinding): unknown {
  return p !== null && typeof p === 'object' ? resolveEncodeValueInternal(p as EncodeValue, datum, ctx, binding) : p
}

/**
 * The name a field reference gives: a path as written, or -- when the reference is itself a reference (`{parent: {datum: 'f'}}`,
 * vega-parser resolveField's recursion) -- the value that reference reads off the datum, used as a plain key.
 */
function fieldName(f: unknown, datum: Row, ctx: EvalContext): { name: unknown; path: boolean } {
  return typeof f === 'string' ? { name: f, path: true } : { name: encodeFieldValue(f, datum, ctx), path: false }
}

/** The group a `{group|parent}` field reference points at, `level` groups up (this engine has the enclosing facet group only). */
function groupFieldValue(ref: { group?: unknown; parent?: unknown }, datum: Row, ctx: EvalContext): unknown {
  if (ref.parent !== undefined) {
    // `item.mark.group.datum[field]`: the facet cell's datum is the `parent` signal there
    const parent = ctx.signalParams['parent']
    if (parent == null) return undefined
    const f = fieldName(ref.parent, datum, ctx)
    return f.path ? getField(parent as Row, f.name as string) : (parent as Record<string, unknown>)[f.name as string]
  }
  const key = fieldName(ref.group, datum, ctx).name
  if (key === 'width') return ctx.width
  if (key === 'height') return ctx.height
  if (key === 'x') return ctx.groupX ?? 0
  if (key === 'y') return ctx.groupY ?? 0
  return 0
}

/** A field reference in any of vega's forms: a path, `{datum}`, `{signal}`, `{group}`, `{parent}`. */
function encodeFieldValue(ref: unknown, datum: Row, ctx: EvalContext): unknown {
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
    const r = ref as { signal?: unknown; group?: unknown; parent?: unknown; datum?: unknown }
    if (r.signal) return (datum as Record<string, unknown>)[ctx.runtime.expr(String(r.signal))(datum, ctx.signalParams) as string]
    if (r.group !== undefined || r.parent !== undefined) return groupFieldValue(r, datum, ctx)
    if (r.datum !== undefined) {
      const f = fieldName(r.datum, datum, ctx)
      return f.path ? getField(datum, f.name as string) : (datum as Record<string, unknown>)[f.name as string]
    }
    throw new Error('Invalid field reference: ' + JSON.stringify(ref))
  }
  return getField(datum, ref as string)
}

/** The scale an entry names: a string, `{signal}` (an expression giving the name) or a field reference giving it. */
function encodeScaleOf(enc: EncodeEntry, datum: Row, ctx: EvalContext, binding?: EncodeBinding): { scale: Scale | undefined; type: string | undefined } {
  const ref = enc.scale
  if (typeof ref === 'string') {
    const bound = binding?.get(enc as object)
    if (bound) return { scale: bound.scale, type: bound.type }
    return { scale: ctx.scales.get(ref), type: ctx.scaleTypes.get(ref) }
  }
  const name = ref !== null && typeof ref === 'object' && (ref as { signal?: unknown }).signal
    ? ctx.runtime.expr(String((ref as { signal: string }).signal))(datum, ctx.signalParams)
    : encodeFieldValue(ref, datum, ctx)
  return { scale: ctx.scales.get(name as string), type: ctx.scaleTypes.get(name as string) }
}

/** `_scale(scale, value)`: the engine's tolerant coercions around the scale call. */
function scaleValue(s: Scale, type: string | undefined, raw: unknown): unknown {
  if (raw === undefined) {
    // A discrete domain can legitimately contain undefined (e.g. an aggregate
    // over a nominal field); vega still maps that domain entry through the scale
    // rather than dropping the channel.
    const dom = s.domain?.() as unknown[] | undefined
    if (!Array.isArray(dom) || !dom.includes(undefined)) return undefined
  }
  if ((type === 'time' || type === 'utc') && typeof raw === 'string') {
    const dateObj = new Date(raw)
    if (Number.isFinite(dateObj.getTime())) raw = dateObj
  }
  return s(raw)
}

function resolveEncodeValueInternal(value: EncodeValue | undefined, datum: Row, ctx: EvalContext, binding?: EncodeBinding): unknown {
  if (value == null || typeof value !== 'object') return value
  // vega-parser encode/entry.js, evaluated instead of compiled to an expression:
  //   value = (signal) | color | field | value;  value = scale(value);
  //   pow(value, exponent);  value *= mult;  value += offset;  round(value)
  // The code is concatenated TEXT there, so operator precedence matters: with a
  // `band` the scale part is `_scale(..) + _bandwidth(..)*band`, and a trailing
  // `*mult` binds to the bandwidth term only (see `tail` below).
  const enc = value as EncodeEntry
  let head: unknown
  let hasHead = true
  if (enc.signal) head = ctx.runtime.expr(enc.signal)(datum, ctx.signalParams)
  else if (enc.field != null) head = encodeFieldValue(enc.field, datum, ctx)
  else if (enc.value !== undefined) {
    const v = enc.value
    head = v !== null && typeof v === 'object' && 'signal' in v ? resolveEncodeValueInternal(v as EncodeValue, datum, ctx, binding) : v
  } else hasHead = false

  // `tail` is a product term added to `head` (the band step `_bandwidth(scale)*band`)
  let tail: number | undefined
  if (enc.scale != null) {
    const { scale: s, type } = encodeScaleOf(enc, datum, ctx, binding)
    if (!s) return undefined
    if (enc.range != null) {
      // lerp(_range(scale), +range)
      head = lerp(s.range() as number[], +(enc.range as number))
      hasHead = true
    } else {
      if (hasHead) head = scaleValue(s, type, head)
      if (enc.band) {
        // + _bandwidth(scale) [* band]   (a band of exactly 1, or `true`, has no factor)
        const bw = typeof s.bandwidth === 'function' ? s.bandwidth() : 0
        const factor = enc.band === true ? 1 : +(entryProperty(enc.band, datum, ctx, binding) as number)
        const term = factor === 1 ? bw : bw * factor
        if (enc.extra) {
          // (datum.extra ? _scale(scale, datum.extra.value) : value)
          const extra = (datum as { extra?: { value?: unknown } }).extra
          head = extra ? scaleValue(s, type, extra.value) : hasHead ? (head as number) + term : term
          hasHead = true
        } else {
          tail = term
        }
      } else if (!hasHead) {
        head = 0
        hasHead = true
      }
    }
  }

  const exponent = enc.exponent
  const mult = enc.mult
  const offset = enc.offset
  if (exponent == null && mult == null && offset == null && !enc.round) {
    if (tail !== undefined) return hasHead ? (head as number) + tail : tail
    if (!hasHead) return undefined
    return enc.field != null && enc.scale == null && enc.format !== undefined && typeof head === 'number' ? formatValue(head, value) : head
  }

  // from here the text is `value [pow] [*mult] [+offset]`, rounded as a whole
  let result: unknown
  if (exponent != null) {
    result = Math.pow(tail !== undefined ? (hasHead ? (head as number) + tail : tail) : (hasHead ? head : null) as number, +(entryProperty(exponent, datum, ctx, binding) as number))
    tail = undefined
  } else if (tail !== undefined) {
    result = hasHead ? head : undefined
  } else {
    result = hasHead ? head : null
  }
  if (mult != null) {
    const m = entryProperty(mult, datum, ctx, binding) as number
    if (tail !== undefined) tail = tail * m
    else result = (result as number) * m
  }
  if (tail !== undefined) result = !hasHead ? tail : (result as number) + tail
  if (offset != null) result = (result as number) + (entryProperty(offset, datum, ctx, binding) as number)
  if (enc.round) result = Math.round(result as number)
  if (enc.field != null && enc.scale == null && enc.format !== undefined && typeof result === 'number') result = formatValue(result, value)
  return result
}

/**
 * Which calendar a label is formatted in, vega-scale `tickFormat`'s precedence: a
 * `time` scale / formatType is local time, then a `utc` scale / formatType is UTC.
 * (A UTC scale formatted in local time shifts every label by the viewer's offset.)
 */
function calendarOf(scaleType: string | undefined, formatType: unknown): 'time' | 'utc' | undefined {
  if (scaleType === 'time' || formatType === 'time') return 'time'
  if (scaleType === 'utc' || formatType === 'utc') return 'utc'
  return undefined
}

function formatValue(v: unknown, spec: EncodeValue): unknown {
  const format = (spec as { format?: unknown }).format
  const formatType = (spec as { formatType?: unknown }).formatType
  if (format === undefined) return v
  const fmt = format as string
  const L = locale(undefined)
  const cal = calendarOf(undefined, formatType)
  if (cal === 'utc') return L.utcFormat(fmt)(v as Date)
  if (cal === 'time' || v instanceof Date) return L.timeFormat(fmt)(v as Date)
  return L.format(fmt)(v as number)
}

/** A legend's explicit `values` (a literal array, a signal, or an array holding signals), or undefined. */
function resolveLegendValues(legend: CompiledLegend, ctx: EvalContext): unknown[] | undefined {
  const raw = (legend as { values?: unknown }).values
  if (raw == null) return undefined
  const evalSignal = (v: unknown): unknown => {
    if (v && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string') {
      try { return ctx.runtime.expr((v as { signal: string }).signal)({}, ctx.signalParams) } catch { return undefined }
    }
    return v
  }
  const resolved = Array.isArray(raw) ? raw.map(evalSignal) : evalSignal(raw)
  return Array.isArray(resolved) ? resolved : undefined
}

function buildLegend(legend: CompiledLegend, ctx: EvalContext, index: number): SceneGroup | null {
  const spec = (legend.own ?? NO_PROPS) as Record<string, unknown>
  const config = (legend.cfg ?? NO_PROPS) as Record<string, unknown>
  // vega-parser legend.js: the channels the legend maps, in LegendScales order; the first is the canonical scale
  const channels: Array<[string, string]> = []
  for (const c of LEGEND_SCALES) if (spec[c]) channels.push([c, String(spec[c])])
  if (!channels.length) return null
  const scale = ctx.scales.get(channels[0]![1])
  if (!scale) return null
  const scaleType = ctx.scaleTypes.get(channels[0]![1]) ?? ''
  // vega's `_('tickCount')`: a signal is what it holds
  const tickCountRaw = guideScalar(ctx, value(spec.tickCount, config.tickCount))
  // A tickCount interval string ('day', 'month', ...) is only legal on time scales: vega's LegendEntries throws, the
  // dataflow pass aborts there, and the legend (and whatever comes after it in its scope) is never made
  // (a scale ranked late in its own scope puts the failing operator last: the legend is then made without its entries,
  // and the rest of the scope is made)
  let entriesFailed = false
  if (typeof tickCountRaw === 'string' && scaleType !== 'time' && scaleType !== 'utc') {
    const own = scopeScale(ctx.scope, channels[0]![1])
    const late = own !== undefined && scaleIsLate(own, ctx.scope, ctx.chart)
    ctx.abort.failures.push({ path: ctx.scope.path, axis: Infinity, legend: index, ...(late ? { late: true } : {}) })
    if (!late) return null
    entriesFailed = true
  }
  // a pass that stopped below this scope never made the entries of a symbol legend (they are a level further down)
  if (entriesFailed || (ctx.pendingEntries && legendType(spec, scaleType) === 'symbol')) {
    const title = guideScalar(ctx, spec.title)
    const titleStr = title == null ? '' : String(title)
    const items: SceneItem[] = []
    if (titleStr) items.push({ _legendTitle: true, _part: 'title', _kind: 'text', text: titleStr, x: 0, y: 0, align: 'left', baseline: 'top', fill: '#000', fontSize: 11, fontWeight: 'bold' } as SceneItem)
    // (the kind of legend it would have been: vega-parser's legendType, decided before any entry is built; a gradient
    // legend still has its gradient item, unencoded)
    const kind = legendType(spec, scaleType)
    if (entriesFailed && kind === 'gradient') items.push({ _part: 'gradient', _kind: 'rect', _bare: true, x: 0, y: 0, path: 'M0,0h0v0h0Z' } as unknown as SceneItem)
    return { marktype: 'group', role: 'legend', legendType: kind, _entriesPending: true, x: 0, y: 0, width: 0, height: 0, items } as unknown as SceneGroup
  }
  // the format: a specifier, or a signal holding one (a timeUnit legend writes timeUnitSpecifier(...), which the
  // expression engine may not have)
  const specifierOf = (raw: unknown): unknown => {
    if (!isSignal(raw)) return raw
    try {
      return ctx.runtime.expr(raw.signal)({}, ctx.signalParams)
    } catch {
      return evalTimeUnitSpecifier(raw.signal)
    }
  }
  const formatType = guideScalar(ctx, spec.formatType) as string | undefined
  const host = guideHost(ctx)
  const guides = chartGuides(ctx.chart)
  const built = buildLegendGuide({
    store: guides.evals > 1 ? (guides.defs ??= new Map()) : undefined, keep: guides.evals > 1,
    spec, config, encode: (legend.encode ?? NO_PROPS) as Record<string, UserEncode | undefined>,
    channels, scale: scale as never, scaleType, scaleOf: (name) => ctx.scales.get(name) as never,
    values: resolveLegendValues({ values: spec.values } as unknown as CompiledLegend, ctx),
    count: tickCountRaw, minstep: guideScalar(ctx, spec.tickMinStep) as number | undefined,
    limit: +(guideScalar(ctx, value(spec.symbolLimit, config.symbolLimit)) as number),
    formatSpecifier: specifierOf(spec.format), formatType,
    locale: locale(undefined), host, style: guideStyles(ctx), raw: !!ctx.rawGuides,
  })
  const g = built.group
  const group = {
    marktype: 'group',
    role: 'legend',
    legendType: built.legendType,
    x: 0,
    y: 0,
    width: built.width,
    height: built.height,
    items: built.leaves,
    partMeta: built.partMeta,
    ...(built.partMeta.legend?.name ? { cssName: built.partMeta.legend.name } : {}),
    legendBounds: built.bounds,
    ...(itemAriaOf(built.group) ? { itemAria: itemAriaOf(built.group) } : {}),
    // what the legend layout reads off the group item
    legendProps: { orient: g.orient, offset: g.offset, x: g.x, y: g.y },
    ...(g.strokeWidth !== undefined ? { strokeWidth: g.strokeWidth } : {}),
    ...(cursorOf(g) !== undefined ? { cursor: cursorOf(g) } : {}),
    ...(g.href != null ? { href: g.href } : {}),
  } as unknown as SceneGroup
  vetGuideLinks(group, ctx)
  return group
}

/** What the guide encoders (guide-encode.ts) need of an evaluation: entries, expressions, scales, the view's signals. */
function guideHost(ctx: EvalContext): GuideHost {
  // (one per evaluation context: the closures it holds read nothing else, and what an entry compiled for it can be kept;
  // a context made from this one by spreading carries the cache of its parent, which is not its own)
  const kept = ctx.guideHost
  if (kept !== undefined && kept.ctx === ctx) return kept.host
  const host = makeGuideHost(ctx)
  ctx.guideHost = { ctx, host }
  return host
}
function makeGuideHost(ctx: EvalContext): GuideHost {
  return {
    entry: (spec, datum) => resolveEncodeProperty(spec as EncodeValue | EncodeValue[], datum, ctx),
    fastCache: new Map(), runCache: new Map(),
    entryScale: (name) => {
      const s = ctx.scales.get(name)
      if (!s) return undefined
      const type = ctx.scaleTypes.get(name)
      // (scaleValue's coercions, written out here: the guides' scale calls do not share a call site with the marks')
      const timeLike = type === 'time' || type === 'utc'
      const call = (raw: unknown): unknown => {
        if (raw === undefined) {
          const dom = s.domain?.() as unknown[] | undefined
          if (!Array.isArray(dom) || !dom.includes(undefined)) return undefined
        } else if (timeLike && typeof raw === 'string') {
          const dateObj = new Date(raw)
          if (Number.isFinite(dateObj.getTime())) raw = dateObj
        }
        return s(raw)
      }
      return { fn: s as (v: unknown) => unknown, timeLike, call, bandwidth: () => (typeof s.bandwidth === 'function' ? s.bandwidth() : 0) }
    },
    expr: (code) => ctx.runtime.expr(code)({}, ctx.signalParams),
    exprDatum: (code, datum) => ctx.runtime.expr(code)(datum, ctx.signalParams),
    viewSignal: (name) => viewSignal(ctx, name),
    scale: (name) => ctx.scales.get(name) as never,
    report: (e) => reportEvalError(ctx, e),
    gradient: (name, vertical) => {
      // vega-functions gradient(): stops from the scale's ticks (see scaleGradientStops); the definition is the
      // renderer's, content-addressed by direction and stops
      const stops = scaleGradientStops(ctx.scales.get(name) as never)
      const id = gradientDefId(vertical ? 'vertical' : 'horizontal', stops)
      if (stops.length && !ctx._defs.some((d) => d.id === id)) ctx._defs.push(vertical ? { id, colorStops: stops } : { id, colorStops: stops, direction: 'horizontal' })
      return `url(#${id})`
    },
    groupBox: (geo, w, h) => groupBackground(geo, w, h),
    warn: (msg) => ctx.logger.warn(msg),
  }
}

/** `config.style` (and `config.lineBreak`) as the guide marks' defaults. */
/**
 * What the guide builders keep for a compiled chart. The marks of its guides are kept from the second evaluation on: a
 * chart that is rendered once builds them, uses them and lets them go (what is kept is not free to keep).
 */
interface ChartGuideState {
  evals: number
  styles: GuideStyles
  defs?: Map<object, unknown>
}
const GUIDES = '__guides'
/** The styles of a chart whose config is the default one are one object: the plans of the guides' marks are kept against it. */
let DEFAULT_STYLES: GuideStyles | undefined
function guideStylesOf(chart: CompiledChart): GuideStyles {
  const style = chart.style
  if (style === undefined || chart.lineBreak !== undefined || style !== (defaultMergedConfig().style as unknown)) return { styles: style ?? {}, lineBreak: chart.lineBreak }
  return (DEFAULT_STYLES ??= { styles: style, lineBreak: undefined })
}
function chartGuides(chart: CompiledChart): ChartGuideState {
  let st = (chart as unknown as Record<string, ChartGuideState | undefined>)[GUIDES]
  if (st === undefined) {
    st = {
      evals: 0, styles: guideStylesOf(chart),
    }
    // (kept on the chart itself, out of sight of enumeration and comparison: a weak map entry per chart made every scavenge
    // of a program that makes many charts slower)
    Object.defineProperty(chart, GUIDES, { value: st, enumerable: false, writable: false })
  }
  return st
}
function guideStyles(ctx: EvalContext): GuideStyles {
  return chartGuides(ctx.chart).styles
}

/** The view's width / height SIGNAL (what a nested group's axes grid to); the context size at the view level. */
function viewSignal(ctx: EvalContext, name: 'width' | 'height'): number {
  const v = ctx.signalParams[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : ctx[name]
}

/**
 * An axis whose `orient` is a signal, with the signal's value in (vega: the axis group's `orient` property,
 * which the layout and every guide mark's encode read). The config blocks it picks up follow the value's class.
 */
function resolveAxisOrient(axis: CompiledAxis, ctx: EvalContext): CompiledAxis {
  if (!axis.orientSignal) return axis
  let value: unknown
  try { value = ctx.runtime.expr(axis.orientSignal.signal)({}, ctx.signalParams) } catch (e) { reportEvalError(ctx, e); value = undefined }
  const orient = typeof value === 'string' ? value : ''
  const variants = axis.orientSignal.variants
  return { ...(ownGet(variants, orient) ?? variants['']!), orient }
}

/** A guide property that may be a signal, as the value the signal holds. */
function guideScalar(ctx: EvalContext, v: unknown): unknown {
  if (!isSignal(v)) return v
  try { return ctx.runtime.expr(v.signal)({}, ctx.signalParams) } catch (e) { reportEvalError(ctx, e); return undefined }
}

/** What an absent `own` / `cfg` / `encode` of a guide is: one object, so that what is kept against it is found again. */
const NO_PROPS: Record<string, never> = {}

const NO_DECLARED: readonly never[] = []
/** The innermost scale of a name that a scope declares. */
function scopeScale(scope: GuideScope, name: string): CompiledScale | undefined {
  for (let i = scope.scales.length - 1; i >= 0; i--) if (scope.scales[i]!.name === name) return scope.scales[i]
  return undefined
}

function rootScope(chart: CompiledChart): GuideScope {
  // (what the view declares is the compiled chart's; the scope's counters are the evaluation's)
  const st = chartGuides(chart)
  st.evals++
  return { path: [], nextChild: { n: 0 }, scales: chart.scales, data: chart.data }
}

/**
 * The entries of a symbol legend are a scope two levels below the one the legend is in: a pass that stopped at depth
 * `stopped` never made them where that is not above it.
 */
const entriesPending = (depth: number, stopped: number): boolean => depth + 2 > stopped

/** Instances are built level by level: the shallower first, those of one level in the order their parents made them. */
function compareInstances(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

/** The functions of an expression that read a data set or a scale: their operators are made after the signals. */
const DATAFLOW_FUNCTIONS = new Set([
  'data', 'indata', 'scale', 'bandwidth', 'bandspace', 'invert', 'copy', 'domain', 'range', 'gradient',
  'treePath', 'treeAncestors', 'geoArea', 'geoBounds', 'geoCentroid', 'geoScale', 'vlSelectionTest', 'vlSelectionResolve',
])
const VIEW_SIGNALS = new Set(['width', 'height', 'padding', 'autosize', 'background', 'cursor', 'origin', 'parent', 'datum', 'event', 'item'])

function expressionIdentifiers(text: string): string[] {
  return (text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""').match(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) ?? []
}

/**
 * Whether a view signal is ranked after the data and scales (see scaleIsLate): it calls a function that reads data or a scale,
 * or reads a signal defined after it or one that is itself late. A signal that is not is ranked before every dataset.
 */
function signalIsLate(chart: CompiledChart, defs: ReadonlyMap<string, number>, name: string, seen: Set<string>): boolean {
  if (seen.has(name)) return false
  seen.add(name)
  const i = defs.get(name)
  if (i === undefined) return false
  const d = chart.signalDefs![i]!
  for (const text of [d.update, d.init]) {
    if (typeof text !== 'string') continue
    for (const id of expressionIdentifiers(text)) {
      if (DATAFLOW_FUNCTIONS.has(id)) return true
      const j = defs.get(id)
      if (j !== undefined && (j > i || signalIsLate(chart, defs, id, seen))) return true
    }
  }
  return false
}

/**
 * Whether vega ranks a scale's operators after the ones of its own scope's axes, so that an axis over it does not find
 * them where its operators run. vega-parser creates the operators of a scope in the order it parses it; a parameter that
 * refers to an operator created later (a forward reference) is re-ranked when the dataflow connects its parameters, and
 * the operator and everything downstream of it move after it. For a scale that is: a domain over a data set declared in
 * its own scope (data comes after the scales it feeds are created), a domain of several fields (its union is made after
 * the scale, wherever the data is), an expression that is not just a signal's name (its operator is created after the
 * scale's), and -- in the view, whose signals are ranked with its scales -- a signal that reads data or a scale or a
 * signal defined after it. The signals of the view rank below every operator of a nested scope: they are never late there.
 */
function scaleIsLate(sdef: CompiledScale, scope: GuideScope, chart: CompiledChart): boolean {
  const defs = new Map<string, number>()
  ;(chart.signalDefs ?? []).forEach((d, i) => { if (!defs.has(d.name)) defs.set(d.name, i) })
  const known = (name: string): boolean => defs.has(name) || VIEW_SIGNALS.has(name) || name in chart.signals
  const signalLate = (name: string, seen: Set<string>): boolean => signalIsLate(chart, defs, name, seen)
  const late = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(late)
    if (v === null || typeof v !== 'object') return false
    const o = v as Record<string, unknown>
    if (typeof o.signal === 'string') {
      const text = o.signal.trim()
      return /^[A-Za-z_$][\w$]*$/.test(text) && known(text) ? scope.parent === undefined && signalLate(text, new Set()) : true
    }
    if (typeof o.data === 'string' && (scope.facet === o.data || scope.data.some((d) => d.name === o.data))) return true
    return Object.values(o).some(late)
  }
  const { name: _name, type: _type, ...params } = sdef as unknown as Record<string, unknown>
  const domain = params.domain
  if (domain !== null && typeof domain === 'object' && !Array.isArray(domain) && 'fields' in domain) return true
  return late(params)
}

const SCALE_NAME_CALL = /\b(?:domain|range|scale|bandwidth|bandspace|invert|copy|gradient)\s*\(\s*(?:'([^']*)'|"([^"]*)")/g

interface SpecReads { signals: Set<string>; scales: Set<string>; data: Set<string> }
const newReads = (): SpecReads => ({ signals: new Set(), scales: new Set(), data: new Set() })

/** Every name a JSON fragment of a spec reads: the signals of its `{signal}` / `{expr}` strings, the scales and datasets it names. */
function specReads(node: unknown, out: SpecReads, depth = 0): void {
  if (node === null || typeof node !== 'object' || depth > 40) return
  if (Array.isArray(node)) { for (const v of node) specReads(v, out, depth + 1); return }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string') {
      if (k === 'signal' || k === 'expr' || k === 'update' || k === 'init' || k === 'test') {
        for (const id of expressionIdentifiers(v)) out.signals.add(id)
        for (const m of v.matchAll(SCALE_NAME_CALL)) out.scales.add((m[1] ?? m[2])!)
      } else if (k === 'data' || k === 'source' || k === 'from') out.data.add(v)
      else if (k === 'scale') out.scales.add(v)
    } else specReads(v, out, depth + 1)
  }
}

const FROZEN_READS = new WeakMap<CompiledChart, Map<string, string[]>>()

/**
 * For each `react: false` view signal, the signals it reads that vega's dataflow has not computed yet when it runs.
 *
 * vega-dataflow ranks operators: one that reads an operator ranked after it is re-ranked past it, together with everything
 * that listens to it. A `react: false` signal listens to nothing, so it is not carried along. When the signal it reads is
 * pushed past it, it runs first and reads that signal's initial value. That happens when the signal it reads sits in a cycle
 * through a scale or dataset that reads the `react: false` signal back (`domain('color')` -> a scale whose domain is the
 * signal): the cycle `react: false` is there to break. A reader outside any cycle is ranked after it and has its value.
 * (The signals of a group scope are not covered: they are resolved with their group.)
 */
function frozenReadsOf(chart: CompiledChart): Map<string, string[]> {
  const cached = FROZEN_READS.get(chart)
  if (cached) return cached
  const out = new Map<string, string[]>()
  FROZEN_READS.set(chart, out)
  const defs = new Map<string, CompiledSignalDef>()
  for (const d of chart.signalDefs ?? []) if (d.push !== 'outer' && !defs.has(d.name)) defs.set(d.name, d)
  const scales = new Map(chart.scales.map((sc) => [sc.name, sc] as const))
  const datasets = new Map(chart.data.map((d) => [d.name, d] as const))
  const readsOfSignal = (d: CompiledSignalDef): SpecReads => {
    const r = newReads()
    specReads({ update: d.update, init: d.init }, r)
    return r
  }
  for (const [name, def] of defs) {
    if (def.react !== false) continue
    const frozen: string[] = []
    for (const s of readsOfSignal(def).signals) {
      const source = defs.get(s)
      if (source === undefined || s === name || source.react === false) continue
      // does `source` listen, through reactive edges only, to `name`?
      const seen = new Set<string>()
      const listens = (reads: SpecReads): boolean => {
        for (const id of reads.signals) {
          if (id === name) return true
          const d = defs.get(id)
          if (d !== undefined && d.react !== false && !seen.has(`s:${id}`)) { seen.add(`s:${id}`); if (listens(readsOfSignal(d))) return true }
        }
        for (const sc of reads.scales) {
          const sdef = scales.get(sc)
          if (sdef === undefined || seen.has(`c:${sc}`)) continue
          seen.add(`c:${sc}`)
          const r = newReads()
          specReads(sdef, r)
          if (listens(r)) return true
          for (const ds of r.data) {
            if (seen.has(`d:${ds}`) || !datasets.has(ds)) continue
            seen.add(`d:${ds}`)
            const dr = newReads()
            specReads(datasets.get(ds), dr)
            if (listens(dr)) return true
          }
        }
        return false
      }
      if (listens(readsOfSignal(source))) frozen.push(s)
    }
    if (frozen.length) out.set(name, frozen)
  }
  return out
}

/**
 * vega's AxisTicks failing (an interval string on a non-time scale, a format that is no specifier) is logged and the
 * axis never gets its ticks; the dataflow pass aborts, and every operator ranked after the failing one never runs.
 *
 * Which those are depends on the scale. One that is ranked late in the axis's own scope (scaleIsLate) is moved after the
 * operators of the scope's axes, so the axis's marks are made without their ticks. With a domain or a title to draw the
 * scenegraph has holes and vega's own SVG serializer crashes on them (`reading 'marktype'`): a refusal here too. With
 * nothing after the missing marks the axis is an empty group, and the rest is made as it would have been (what was ranked
 * after the failing operator is the axis itself). Any other scale leaves a clean
 * cut: the axes before the failing one, and nothing that follows it in its scope -- its marks, legends, title -- nor
 * anything of the scopes built after it (recorded here, applied by the build's second pass).
 */
function axisTicksFailed(axis: CompiledAxis, ctx: EvalContext, e: unknown, index: number): SceneGroup | null {
  reportEvalError(ctx, e)
  const own = scopeScale(ctx.scope, axis.scale)
  const late = own !== undefined && scaleIsLate(own, ctx.scope, ctx.chart)
  if (late && (axis.domain !== false || (axis.title !== undefined && axis.title !== null))) {
    throw new Error(`[aster] the ticks of the axis over scale "${axis.scale}" failed (${e instanceof Error ? e.message : String(e)}); vega cannot serialize the half-built axis either`)
  }
  ctx.abort.failures.push({ path: ctx.scope.path, axis: index, ...(late ? { late: true } : {}) })
  if (!late) return null
  // (the half-made axis: its group item, nothing in it -- not even the caption an encoded axis carries)
  return { marktype: 'group', role: 'axis', x: 0, y: 0, width: 0, height: 0, items: [], parts: [] } as unknown as SceneGroup
}

/** The count the tick labels are formatted for: the axis's tick count through vega's tickCount (bins, tickMinStep). */
function labelTickCount(axis: CompiledAxis, scale: Scale, count: number, ctx: EvalContext): number {
  let minstep: unknown = axis.tickMinStep
  if (minstep && typeof minstep === 'object' && typeof (minstep as { signal?: unknown }).signal === 'string') {
    try { minstep = ctx.runtime.expr((minstep as { signal: string }).signal)({}, ctx.signalParams) } catch { minstep = undefined }
  }
  const step = typeof minstep === 'number' && Number.isFinite(minstep) && minstep > 0 ? minstep : undefined
  if (step === undefined && !(scale as { bins?: unknown }).bins) return count
  const counted = tickCount(scale, count, step)
  return typeof counted === 'number' ? counted : count
}

function buildAxis(axis: CompiledAxis, ctx: EvalContext, index: number): SceneGroup | null {
  const scale = ctx.scales.get(axis.scale)
  if (!scale) return null
  const orient = String(axis.orient)
  let ticks: unknown[]
  try {
    ticks = axisTicks(axis, scale, ctx)
  } catch (e) {
    return axisTicksFailed(axis, ctx, e, index)
  }
  // The approximate tick count used for label formatting. When the axis omits
  // tickCount, vega's axis ticks operator defaults to 10 (see vega-encode
  // AxisTicks: `_.count == null ? 10 : _.count`); matching that matters for
  // log-scale labels, whose formatter only labels a subset of ticks depending
  // on the count.
  const count0 = (typeof axis.tickCount === "number") ? axis.tickCount : (axis.tickCount && typeof axis.tickCount === "object" && axis.tickCount.signal) ? (ctx.runtime.expr(axis.tickCount.signal)({}, ctx.signalParams) as number) || 10 : 10
  // (AxisTicks formats with tickCount(scale, tally, minstep) too: a scale with bins asks for a tick per boundary, a minimum step
  // thins the count)
  const count = labelTickCount(axis, scale, count0, ctx)
  let labelFormat: (v: unknown) => unknown
  const labelCache: string[] = []
  try {
    labelFormat = axisLabelFormat(axis, scale, count, ctx, !!axisValues(axis, ctx))
    // vega's AxisTicks formats every tick as it makes the tuples: a format that throws (an invalid
    // specifier) is logged and the axis never gets its ticks
    for (let i = 0; i < ticks.length; i++) labelCache[i] = String(labelFormat(ticks[i]))
  } catch (e) {
    return axisTicksFailed(axis, ctx, e, index)
  }
  const own = (axis.own ?? NO_PROPS) as Record<string, unknown>
  const cfg = (axis.cfg ?? NO_PROPS) as Record<string, unknown>
  // vega-encode AxisTicks tuples, the datum a tick / label / grid encode reads:
  // `{index (fraction 0..1), tickIndex, value, label}`; the `extra` entry (an
  // extra tick pegged to the first value, for binned axes) is
  // `{index: -1, tickIndex: -1, extra: {value}, label: ''}`.
  const band = tickBand(lookup(own, cfg))
  const extra = isSignal(band.extra) ? ctx.runtime.expr(band.extra.signal)({}, ctx.signalParams) : band.extra
  let rows: Row[] = ticks.map((value, i) => ({ index: i / ((ticks.length - 1) || 1), tickIndex: i, value, label: labelCache[i] }))
  if (extra && ticks.length) rows.push({ index: -1, tickIndex: -1, extra: { value: ticks[0] }, label: '' })
  if (ctx.passMemory !== undefined) rows = retainGuideOrder(rows, ctx.passMemory, `a${ctx.scope.path.join('/')}:${index}`)
  meterItems(rows.length, 'axis ticks')

  const guides = chartGuides(ctx.chart)
  const built = buildAxisGuide({
    store: guides.evals > 1 ? (guides.defs ??= new Map()) : undefined, keep: guides.evals > 1,
    spec: own, cfg, scale: axis.scale, orient, encode: (axis.encode ?? NO_PROPS) as Record<string, UserEncode | undefined>,
    ticks: rows, distinctTicks: !axisValues(axis, ctx) && DISTINCT_TICK_SCALES.has(ctx.scaleTypes.get(axis.scale) ?? ''), width: ctx.width, height: ctx.height, raw: !!ctx.rawGuides, host: guideHost(ctx), style: guideStyles(ctx),
  })
  const knownOrient = orient === 'top' || orient === 'bottom' || orient === 'left' || orient === 'right'
  const g = built.group
  const href = g.href
  const position = typeof g.position === 'number' ? g.position : 0
  const sr = scale.range() as number[]
  const axisRangeSpan = typeof g.range === 'number' ? g.range : sr.length > 1 ? Math.abs(Number(sr[sr.length - 1]) - Number(sr[0])) : 0
  // the axis group item is a group item like any other: its box is drawn at its (encoded) size, painted as encoded
  const gb = groupBackground(g as SceneItem, +(g.width as number) || 0, +(g.height as number) || 0)
  // (the axis's marks are in the view's frame, the group's own position baked in: so is its box)
  const gx = +(g.x as number) || 0
  const gy = +(g.y as number) || 0
  gb.background.x = gx
  gb.background.y = gy
  if (gb.foreground) { gb.foreground.x = gx; gb.foreground.y = gy }
  const out = {
    marktype: 'group',
    role: 'axis',
    items: built.leaves,
    box: gb.background,
    ...(gb.foreground ? { boxFg: gb.foreground } : {}),
    // the marks vega-parser's axis builds (grid, ticks, labels, domain, title; axis.js `datum`): the SVG draws a
    // container for each, empty or not
    parts: built.parts,
    partMeta: built.partMeta,
    ...(built.partMeta.axis?.name ? { cssName: built.partMeta.axis.name } : {}),
    ...(itemAriaOf(built.group) ? { itemAria: itemAriaOf(built.group) } : {}),
    ...(cursorOf(built.group) !== undefined ? { cursor: cursorOf(built.group) } : {}),
    axis: { orient, itemOrient: typeof g.orient === 'string' ? g.orient : orient, range: axisRangeSpan, baseline: 0, translate: ctx.rawGuides ? 0 : (typeof g.translate === 'number' ? g.translate : 0.5), position, bounds: built.bounds, ...(knownOrient ? {} : { noLayout: true }) },
    ...(href != null ? { href } : {}),
  } as unknown as SceneGroup
  vetGuideLinks(out, ctx)
  return out
}

/**
 * vega-encode DataJoin: the items of a keyed mark (an axis's ticks, labels and grid are keyed by `value`) outlive the dataflow
 * pass that made them. A second pass (autosize fit) adds its tuples first: one whose key an item already has updates that item
 * in its place, a new key makes a new item after the others, and only then do the first pass's tuples leave: an item whose
 * tuple was not replaced exits. The scene's items are what is left, in that order.
 */
function retainGuideOrder(rows: Row[], memory: PassMemory, id: string): Row[] {
  const prev = memory.prev?.guides.get(id)
  let out = rows
  if (prev !== undefined) {
    const byKey = new Map<string, Row>()
    for (const r of rows) byKey.set(String(r.value), r) // (a repeated key: the last tuple's datum, the first one's place)
    out = []
    for (const k of prev) {
      const r = byKey.get(k)
      if (r !== undefined) { out.push(r); byKey.delete(k) }
    }
    const added = new Set<string>()
    for (const r of rows) {
      const k = String(r.value)
      if (!byKey.has(k) || added.has(k)) continue
      added.add(k)
      out.push(byKey.get(k)!)
    }
  }
  memory.cur.guides.set(id, out.map((r) => String(r.value)))
  return out
}

/** A hyperlink on a guide's group or marks goes through the URL policy like any mark's. */
function vetGuideLinks(g: SceneGroup, ctx: EvalContext): void {
  if (ctx.urlPolicy === undefined) return
  const vet = (it: SceneItem): void => {
    if (it.href != null && applyLinkUrlPolicy(it.href, ctx.urlPolicy!) == null) it.href = undefined
  }
  vet(g)
  for (const it of g.items ?? []) vet(it as SceneItem)
}

/** An axis's `values`: what a signal holds when the ticks are made; null, undefined, 0 or '' is no values at all. */
/** Scales whose own ticks are strictly increasing (d3's) or the scale's distinct domain: no two ticks have one value. */
const DISTINCT_TICK_SCALES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'band', 'point'])

function axisValues(axis: CompiledAxis, ctx: EvalContext): unknown {
  const vs: unknown = axis.values
  if (vs && typeof vs === 'object' && !Array.isArray(vs) && 'signal' in (vs as Record<string, unknown>)) {
    return ctx.runtime.expr((vs as { signal: string }).signal)({}, ctx.signalParams)
  }
  return vs
}

function axisTicks(axis: CompiledAxis, scale: Scale, ctx: EvalContext): unknown[] {
  // Explicit `values` override any generated ticks (vega AxisTicks sorts them).
  const vs = axisValues(axis, ctx)
  if (vs) {
    // vega AxisTicks: validTicks(scale, values, count) -- a value outside the scale's range is dropped, the rest are
    // sorted in range order and thinned to the tick count (the number of values when the axis has none); a `values`
    // that is no list is a TypeError in the dataflow (`ticks.map is not a function`)
    if (!Array.isArray(vs)) throw new TypeError('ticks.map is not a function')
    let given: unknown = axis.tickCount
    if (given && typeof given === 'object' && typeof (given as { signal?: unknown }).signal === 'string') {
      given = ctx.runtime.expr((given as { signal: string }).signal)({}, ctx.signalParams)
    }
    let minstep: unknown = axis.tickMinStep
    if (minstep && typeof minstep === 'object' && typeof (minstep as { signal?: unknown }).signal === 'string') {
      minstep = ctx.runtime.expr((minstep as { signal: string }).signal)({}, ctx.signalParams)
    }
    const tally = given == null ? vs.length : given
    return validTicks(scale, vs, tickCount(scale, tally, minstep as number | undefined) as number)
  }
  let count: number | undefined
  // vega's AxisTicks reads the (signal-resolved) tickCount through tickCount(scale, count, minstep)
  let tickCountValue: unknown = axis.tickCount
  if (tickCountValue && typeof tickCountValue === 'object' && typeof (tickCountValue as { signal?: unknown }).signal === 'string') {
    tickCountValue = ctx.runtime.expr((tickCountValue as { signal: string }).signal)({}, ctx.signalParams)
  }
  if (typeof tickCountValue === 'number') count = tickCountValue
  else if (typeof tickCountValue === 'string' || (tickCountValue && typeof tickCountValue === 'object' && !Array.isArray(tickCountValue) && 'interval' in (tickCountValue as Record<string, unknown>))) {
    // vega's tickCount util resolves an interval string against the scale:
    // legal only on time/utc scales, where it becomes a calendar interval the
    // scale's ticks consume; anything else is an error in the dataflow (the
    // caller logs it and the axis is not drawn).  `{interval, step}` objects resolve the interval and
    // widen it with `every(step)`.
    const raw = typeof tickCountValue === 'string' ? tickCountValue : (tickCountValue as { interval?: unknown }).interval
    const step = typeof tickCountValue === 'object' && tickCountValue !== null ? (tickCountValue as { step?: unknown }).step : undefined
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
  // (a scale with bins asks for at least one tick per bin boundary, whatever the count)
  if (typeof count === 'number' && ((tickMinStep != null && tickMinStep > 0) || (scale as { bins?: unknown }).bins)) {
    const counted = tickCount(scale, count, tickMinStep != null && tickMinStep > 0 ? tickMinStep : undefined)
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
        // one tick per calendar month: bound the span before stepping through it (C9)
        boundedCount((d1.getTime() - d0.getTime()) / (28 * 86_400_000) + 1, 'calendar month ticks')
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

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number, ctx?: EvalContext, noSkip = false): (v: unknown) => string {
  // (vega has no axis `labelExpr`: vega-lite compiles it to `encode.labels.update.text`,
  // which is applied to the label items themselves - see applyGuideEncode - so a raw
  // `labelExpr` is ignored here exactly as vega ignores it)
  const fmtType = axis.formatType ? axis.formatType : undefined
  // Resolve format: may be a string or a signal expression.
  let fmt: string | undefined
  const rawFmt = axis.format ?? undefined
  // d3's formatSpecifier reads whatever it is given through a regular expression, so a number is its digits
  // (`42` is a width) and a thing that is no specifier at all is an invalid format
  if (typeof rawFmt === 'string') {
    fmt = rawFmt
  } else if (rawFmt != null && typeof rawFmt !== 'object') {
    fmt = String(rawFmt)
  } else if (rawFmt && typeof rawFmt === 'object' && 'signal' in (rawFmt as Record<string, unknown>) && ctx) {
    try {
      const v = ctx.runtime.expr((rawFmt as { signal: string }).signal)({}, ctx.signalParams)
      if (typeof v === 'string') fmt = v
      else if (v != null) fmt = String(v)
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
  const calendar = calendarOf(scale.type, fmtType)
  if (calendar) {
    const L = locale(undefined)
    // With no explicit format vega uses the time multi-format, which picks a
    // specifier per tick interval (e.g. '%B' for month ticks, '%b %d' for
    // day/week ticks). The `undefined` argument is passed explicitly to satisfy
    // the strict local type shim for vega-format.
    const timeFormatter = calendar === 'utc' ? L.utcFormat : L.timeFormat
    // (an object is the multi-format specifier: a pattern per interval, `{year: '%y', quarter: '%b'}`)
    if (fmt === undefined && rawFmt !== null && typeof rawFmt === 'object' && !Array.isArray(rawFmt) && !('signal' in (rawFmt as Record<string, unknown>))) {
      return timeFormatter(rawFmt as unknown as string)
    }
    return fmt ? timeFormatter(fmt) : timeFormatter(undefined as unknown as string)
  }
  if (scale.type !== 'linear' && scale.type !== 'log' && scale.type !== 'pow' && scale.type !== 'sqrt' && scale.type !== 'symlog') {
    // vega applies an inherited numeric format specifier even to band/point
    // labels; non-numeric band values format as NaN.
    if (fmt != null) {
      const L = locale(undefined)
      return (v) => L.format(fmt)(typeof v === 'number' ? v : Number(v))
    }
    return (v) => String(v)
  }
  const L = locale(undefined)
  return tickFormat(L, scale, count, fmt, undefined, noSkip)

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
    .filter((unit) => Object.hasOwn(TU_ORDER, unit))
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
