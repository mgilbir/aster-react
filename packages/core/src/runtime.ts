/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { readData, type DataFormatSpec } from './data-format.js'
import { applyTransforms, compileExprTransform, sortOrder, getField, geoJSONPath, computeBinStep, computeBinEps, aggregateGroup, type Row, type TransformContext } from './transform.js'
import { fieldOf } from './transform-agg.js'
import { activeMeter, withLimits, boundedCount, checkRowCount } from './limits.js'
import { withTextMetricsProvider } from './text-metrics.js'
import { buildScale, scaleTicks, type Scale, CONTINUOUS_TYPES, type ColorScale, type ScaleContext } from './scales.js'

/** Scale types whose domain is an ordered set of discrete values. */
const DISCRETE_TYPES = new Set(['band', 'point', 'ordinal'])
import { geoRegistry, requireGeo } from './registry.js'
import { locale } from './locale.js'
import type {
  GuideEncodeBlock,
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledProjection,
  CompiledTitle,
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
import { hash53 } from './svg-defs.js'
import { tickFormat, scaleFraction, scaleGradientStops, tickValues, tickCount, isContinuous, validTicks } from './scale.js'
import { timeIntervalFor, utcIntervalFor } from './time.js'
import { compileChart } from './compiler.js'
import { dict, ownGet, minOf, maxOf, pushAll } from './util.js'
import { applyImageUrlPolicy, applyLinkUrlPolicy, type ImageUrlPolicy } from './url-policy.js'
import { valueKey, valuesEqual } from './fingerprint.js'
import { rowsEqual, type PulseChange } from './pulse.js'
import { fieldsOf, groupKeyFn } from './transform-agg.js'
import { flattenLength } from './transform-basic.js'
import { trellisLayout, gridLayout } from './trellis.js'
import { boundAxisGroup, boundGroupItem, boundLeaf, boundText, Bounds, layoutBounds } from './bounds.js'
import { itemTextWidth, nominalTextWidth, type FontProps } from './text-metrics.js'
import { symbolPath, symbolPathExact, rectItemPath } from './render.js'

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

interface EvalContext {
  chart: CompiledChart
  signalParams: Record<string, unknown>
  width: number
  height: number
  /** Position of the enclosing facet group, for `{field: {group: 'x' | 'y'}}` references. */
  groupX?: number
  groupY?: number
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
  /** `datasets.size` when each fit projection was last built (see refreshProjection). */
  projectionStamp: Map<string, number>
  runtime: ExpressionRuntime
  _defs: Array<{ id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }>
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
  let width = resolveSize(chart.width, input.width, signals)
  // A Vega spec can define the chart height as a `height` signal (a special
  // signal that doubles as the view size), e.g. `signals:[{name:'height',
  // update: ...}]`, without a top-level numeric height. It's resolved later by
  // resolveSignalUpdates, so apply the fallback after that (see below).
  let height = resolveSize(chart.height, input.height, signals)
  const signalParams = dict<unknown>({ width, height }, signals)

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
    containerSize: () => (input.containerSize ? [input.containerSize.width, input.containerSize.height] : [undefined, undefined]),
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
  // Inputs besides the signals that change what a reused scale/item would be.
  const extraFp = `${input.domainRaw ? valueKey(input.domainRaw) : ''}\u0002${input.textMetrics ? valueKey(input.textMetrics) : ''}\u0002${input.containerSize ? `${input.containerSize.width}x${input.containerSize.height}` : ''}`
  const ctx: EvalContext = {
    chart, signalParams, width, height, datasets, scales, scaleTypes, projections: new ProjectionRegistry(), projectionStamp: new Map(), runtime, _defs: defs,
    initDone: new Set(), hostSignals: new Set([
      ...Object.keys(input.signals ?? {}),
      // an explicit view size (the host's, or the fit loop's resize) wins over an `init`
      ...(explicitSize.width ? ['width'] : []), ...(explicitSize.height ? ['height'] : []),
    ]),
    hierarchies: new Map(), affected: new Set(), incremental: false, deadline, checkDeadline,
    datasetPulses: new Map(),
    prev: txn.prev, draft: newState(txn.gen), gen: txn.gen, claimed: txn.claimed, extraFp, dsEpoch: 0, scaleReuse: new Map(), distinctCache: new WeakMap(),
    domainRaw: input.domainRaw ? new Map(Object.entries(input.domainRaw).map(([k, v]) => [k, v])) : undefined,
    // Image urls are vetted when the host passes a policy, and with the default
    // policy whenever it passes `limits` (limits mean "this spec is untrusted").
    // With neither they are drawn as given, as Vega does: an SVG <image> cannot
    // run script, but a hostile spec can still make the viewer fetch an arbitrary
    // url (tracking pixel, IP leak). Hosts rendering foreign specs must opt in.
    urlPolicy: input.urlPolicy ?? (input.limits ? {} : undefined),
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

  // The final context fingerprint: the next evaluation compares its own
  // (scale, mark) inputs against this to decide whether reuse is valid.
  ctx.draft.fp = ctxFpOf(ctx)

  return { ctx, width, height }
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
  const resolved: Record<string, unknown> = dict<unknown>({ name: p.name, type: p.type })
  for (const k of Object.keys(p)) {
    if (k === 'name' || k === 'type') continue
    resolved[k] = resolveProjectionParam(ctx, p[k])
  }
  return build(resolved as never, ctx.width, ctx.height)
}

/**
 * Build the projections (vega-geo's Projection transform). A projection that
 * `fit`s a dataset depends on that dataset, which may not exist yet in the early
 * passes: such a projection is rebuilt whenever the set of built datasets has
 * changed since (see `refreshProjection`), and once more at the end of preparation.
 */
function buildProjections(ctx: EvalContext): void {
  if (!ctx.chart.projections?.length) return
  for (const p of ctx.chart.projections) {
    ctx.projections.set(p.name, buildProjectionOf(ctx, p))
    ctx.projectionStamp.set(p.name, ctx.datasets.size)
  }
}

/**
 * Refresh the projection a dataset transform asks for. One that fits data is rebuilt when
 * more datasets exist than when it was last built, so a `geopath`/`geoshape`
 * transform in a later dataset sees the fit to the data built before it.
 */
function refreshProjection(ctx: EvalContext, name: string): void {
  const def = ctx.chart.projections?.find((p) => p.name === name)
  if (def?.fit && ctx.projectionStamp.get(name) !== ctx.datasets.size) {
    ctx.projections.set(name, buildProjectionOf(ctx, def))
    ctx.projectionStamp.set(name, ctx.datasets.size)
  }
}

/** The projections map a dataset transform sees: reads go through `refreshProjection`. */
class ProjectionRegistry extends Map<string, unknown> {
  refresh: ((name: string) => void) | undefined
  override get(name: string): unknown {
    this.refresh?.(name)
    return super.get(name)
  }
}

/** Expression functions that read datasets or scales (a signal using them cannot resolve before they exist). */
const DATA_DEPENDENT_EXPR = /\b(data|indata|domain|range|scale|bandwidth|bandspace|invert|copy|gradient)\s*\(/

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
function resolveSignalUpdates(ctx: EvalContext, staticOnly = false): boolean {
  const defs = ctx.chart.signalDefs
  if (!defs?.length) return false
  let changed = false
  for (const def of defs) {
    // `init` runs once (vega's initonly), never over a value the host or an
    // event handler already set.
    const initPending = def.update === undefined && def.init !== undefined
      && !ctx.initDone.has(def.name) && !ctx.hostSignals.has(def.name)
    const expr = def.update ?? (initPending ? def.init : undefined)
    if (!expr) continue
    if (staticOnly && DATA_DEPENDENT_EXPR.test(expr)) continue
    try {
      const value = ctx.runtime.expr(expr)(undefined, ctx.signalParams)
      if (initPending && value !== undefined) ctx.initDone.add(def.name)
      if (value !== undefined && !valuesEqual(value, ctx.signalParams[def.name])) {
        ctx.signalParams[def.name] = value
        ctx.fpMemo = undefined
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

/** A guide number that may be a `{signal}` (undefined when absent or not a number). */
function guideNumber(ctx: EvalContext, value: unknown): number | undefined {
  if (value && typeof value === 'object' && typeof (value as { signal?: unknown }).signal === 'string') {
    try { value = ctx.runtime.expr((value as { signal: string }).signal)({}, ctx.signalParams) } catch { return undefined }
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The legend-group properties vega's legend encode feeds the layout (`encode.legend`: orient, offset, padding, titlePadding, cornerRadius, fill, stroke, x, y); the spec's encode wins. */
const LEGEND_GROUP_ENCODE: Readonly<Record<string, string>> = {
  orient: 'orient', offset: 'offset', padding: 'padding', titlePadding: 'titlePadding', cornerRadius: 'cornerRadius',
  fill: 'fillColor', stroke: 'strokeColor', x: 'legendX', y: 'legendY',
}

function legendWithGroupEncode(legend: CompiledLegend, ctx: EvalContext): CompiledLegend {
  const set = guideEncodeSet(legend.encode?.legend)
  if (!set) return legend
  const datum: Row = { title: legend.title != null, scales: {}, type: legend.type ?? 'symbol', vgrad: false }
  const over: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(set)) {
    const target = LEGEND_GROUP_ENCODE[k]
    if (!target) continue
    const r = resolveEncodeProperty(v, datum, ctx)
    if (r !== undefined) over[target] = r
  }
  return Object.keys(over).length ? ({ ...legend, ...over } as CompiledLegend) : legend
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
  // vega's layoutGroup walks the content children together with the guides:
  // the anchor bounds scan the content items too.
  const anchorItems = [...contentItems]

  for (const axis of axes) {
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
      if (axis.zindex) (wrapped as unknown as { zindex?: number }).zindex = axis.zindex
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
  // (vega has no legend `disable`: that is a Vega-Lite config key, which the VL
  // compiler resolves by omitting the legend. A config.legend.disable merged into
  // a legend that VL kept must not remove it.)
  const built = legends
    .map((legend0) => {
      const legend = legendWithGroupEncode(legend0, ctx)
      const group = buildLegend(legend, ctx)
      if (group) {
        placeLegendTitleLast(group, legend, ctx)
        if (legend.zindex) (group as unknown as { zindex?: number }).zindex = legend.zindex
        // `aria: false` removes the legend from the accessibility tree (and marks it aria-hidden)
        ;(group as unknown as { aria?: boolean }).aria = (legend as { aria?: boolean }).aria
        const lt = guideTitle(ctx, legend.title)
        if (lt) (group as unknown as { title?: string }).title = lt
        const g = group as unknown as {
          legendScale?: string; legendChannels?: string[]; legendType?: string
          legendFormat?: string; legendFormatType?: string
        }
        // vega-parser LegendScales: the channels in priority order (the first is the canonical scale)
        g.legendChannels = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'].filter((k) => typeof (legend as Record<string, unknown>)[k] === 'string')
        g.legendScale = g.legendChannels.map((k) => String((legend as Record<string, unknown>)[k]))[0]
        g.legendFormat = guideString(ctx, (legend as Record<string, unknown>).format)
        g.legendFormatType = guideString(ctx, (legend as Record<string, unknown>).formatType)
        const st = g.legendScale ? (ctx.scaleTypes.get(g.legendScale) ?? ctx.chart.scales.find((sc) => sc.name === g.legendScale)?.type) : undefined
        const discrete = st === 'band' || st === 'point' || st === 'ordinal' || st === 'bin-ordinal'
        const discretizing = st === 'threshold' || st === 'quantize' || st === 'quantile'
        const color = g.legendChannels.some((k) => k === 'fill' || k === 'stroke')
        const explicitGradient = legend.type === 'gradient' || legend.own?.gradientLength != null
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
    const byOrient = new Map<string, { legend: CompiledLegend; group: SceneGroup }[]>()
    for (const x of built) {
      const orient = x.legend.orient ?? 'right'
      if (orient === 'none') {
        // legendLayout leaves an `orient: none` legend where its x / y encode put it
        // (legendX / legendY); every other orient is zeroed and placed by the grid
        const lx = guideNumber(ctx, (x.legend as { legendX?: unknown }).legendX)
        const ly = guideNumber(ctx, (x.legend as { legendY?: unknown }).legendY)
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
const DATA_FN_EXPR = /\b(data|indata)\s*\(/

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
    const src = (d as CompiledData & { source?: string }).source
    if (src) names.add(src)
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
    ? items.map((g, i) => ({ g, i })).sort((a, b) => {
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
function buildContent(
  chart: CompiledChart,
  input: RuntimeInput,
  cw: number,
  ch: number,
  txn: EvalTxn,
  fitted = false,
): { items: SceneGroup[]; padding: ReturnType<typeof computeGuidePadding>; ctx: EvalContext; width: number; height: number; isFacetSpec: boolean } {
  const { ctx, width, height } = prepareChartCtx(
    chart, { ...input, width: cw, height: ch }, txn,
    fitted ? { width: true, height: true } : { width: input.width != null, height: input.height != null },
  )

  // Partial re-evaluation: marks whose every input is provably unchanged reuse
  // the previous scene's group object as-is, and marks over a changed dataset
  // splice theirs (item identity preserved for the DOM patcher). Groups are
  // matched by COMPILED-MARK IDENTITY, never by source dataset or name: two
  // layers over one dataset, or several unnamed marks, are distinct (C4).
  const items: SceneGroup[] = []

  // 1) Build marks (plot area)
  for (const mark of ctx.chart.marks) {
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

  // 2) ViewLayout of the view's root group (vega-view-transforms): a `layout`
  // grid positions the child groups (cells, headers, footers, titles) first;
  // layoutGroup then lays out the axes, legends and title around them.
  const isFacetSpec = ctx.chart.layout != null
  if (isFacetSpec) {
    try {
      trellisLayout({ marktype: 'group', items } as unknown as SceneGroup, resolveLayoutOptions(ctx.chart.layout!, ctx))
    } catch {
      // vega's dataflow logs the layout error and renders the scene unlayouted:
      // cells keep their encoded (0,0) anchors and the view skips overflow growth.
      ;(ctx as unknown as { __layoutError?: boolean }).__layoutError = true
    }
  }
  const { groups: guideGroups } = buildAxisAndLegend(ctx, items)
  for (const g of guideGroups) items.push(g)

  // Top-level title.
  const titleGroup = buildTitleGroup(ctx.chart.title, items, width, height, ctx.rawGuides, ctx)
  if (titleGroup) items.push(titleGroup)
  // The root group's width / height are the view's `width` / `height` signals (0
  // for a composition that sizes only its children), whatever the grid inside covers.
  const facetWidth = width
  const facetHeight = height

  // 2d) viewSizeLayout padding (overflow) after the trellis layout.
  // A trellis layout that throws (vega's gridLayout does on e.g. fractional
  // `columns`) aborts vega's whole ViewLayout transform: the scene renders
  // unlayouted — cells at their encoded anchors — with the default padding
  // and no overflow growth (the dataflow logs the error and continues).
  // `autosize: none` keeps the declared viewport: vega's viewSizeLayout does not
  // grow the padding from guide/mark overflow, so measuring every top-level
  // group's recursive bounds here would be pure cost (O(items) per evaluation,
  // and the dominant cost of a one-row update on a 100k-point chart).
  const padding = (ctx as unknown as { __layoutError?: boolean }).__layoutError
    || ctx.rawGuides
    || ctx.chart.autosize === 'none'
    ? ctx.chart.padding
    : computeGuidePadding(
        items, facetWidth, facetHeight, ctx.chart.padding,
        (ctx.chart.projections ?? []).some((p) => String(p.type).toLowerCase() === 'azimuthalequalarea' && Number(p.clipAngle) === 0),
      )
  const ordered = paintOrderOf(items)
  return { items: ordered, padding, ctx, width: facetWidth, height: facetHeight, isFacetSpec }
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
  const done: { draft?: IncrementalState } = {}
  const scene = withLimits(input.limits, () => withTextMetricsProvider(input.textMetrics, () => evaluateChartImpl(chart, input, txn, done)))
  return {
    scene,
    commit() {
      if (done.draft) STATES.set(chart, done.draft)
    },
  }
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const pending = evaluateChartPending(chart, input)
  pending.commit()
  return pending.scene
}

function evaluateChartImpl(chart: CompiledChart, input: RuntimeInput, txn: EvalTxn, done: { draft?: IncrementalState }): SceneRoot {
  const auto = chart.autosize
  const base = chart.padding
  // Differential-update generation (`txn.gen`): an unchanged (reused) item keeps
  // the generation it was encoded in, so the DOM patcher can skip it.
  const signals = dict(chart.signals, input.signals)
  let initialW = resolveSize(chart.width, input.width, signals)
  let initialH = resolveSize(chart.height, input.height, signals)
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
  let built = buildContent(chart, input, cw, ch, txn)
  if (auto === 'fit' || auto === 'fit-x' || auto === 'fit-y') {
    // A `width`/`height` signal (update or init, e.g. vega-lite's
    // `isFinite(containerSize()[0]) ? ... : 300`) resolves while the first
    // build runs; the fit viewport is that resolved size, not the default.
    if (!built.isFacetSpec && (built.ctx.width !== cw || built.ctx.height !== ch)) {
      initialW = cw = built.ctx.width
      initialH = ch = built.ctx.height
    }
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
      built = buildContent(chart, { ...input, changedDatasets: undefined }, cw, ch, txn, true)
    }
  }
  const { ctx, width, height } = built
  const items = built.items
  // The negative-height half-pixel growth belongs at the top origin, which is
  // where vega's title layout puts it (content shifts down with the root).
  const padding = negativeHeightExtra
    ? { ...built.padding, top: built.padding.top + negativeHeightExtra }
    : built.padding

  // 3) Build the scene: the document is the view's width / height signals plus the
  // padding (autosize pad grows it by what overflows). A composition's root group is
  // 0 x 0 (vega: no `width` signal value), so only its padding and overflow remain.
  const sceneWidth = ctx.chart.autosize !== 'none'
    ? width + padding.left + padding.right
    : width + ctx.chart.padding.left + ctx.chart.padding.right
  const sceneHeight = ctx.chart.autosize !== 'none'
    ? height + padding.top + padding.bottom
    : height + ctx.chart.padding.top + ctx.chart.padding.bottom

  const scene: SceneRoot = {
    width: sceneWidth,
    height: sceneHeight,
    // the frame background is the root group's own box: the view's width x height
    // (a composition's is the degenerate M0,0h0v0h0Z)
    plotWidth: width,
    plotHeight: height,
    background: ctx.chart.background,
    frameStroke: ctx.chart.frameStroke,
    frameFill: (ctx.chart as unknown as { frameFill?: string }).frameFill,
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
  }
  // Event-loop wiring (non-serialized internals)
  ;(scene as unknown as { runtime?: unknown }).runtime = ctx.runtime
  ;(scene as unknown as { signalParams?: Record<string, unknown> }).signalParams = ctx.signalParams
  ;(scene as unknown as { compiled?: unknown }).compiled = ctx.chart
  ;(scene as unknown as { __itemGen?: number }).__itemGen = txn.gen
  ;(scene as unknown as { __scales?: unknown }).__scales = snapshotScales(ctx.scales)
  ;(scene as unknown as { __scaleMap?: unknown }).__scaleMap = ctx.scales
  if (ctx._defs.length) scene.defs = ctx._defs
  // The state the next incremental evaluation starts from; committed by the
  // caller once the scene is accepted.
  done.draft = ctx.draft
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
  return withLimits(input.limits, () => getChartInfoImpl(spec, input))
}

function getChartInfoImpl(spec: VgSpec, input: RuntimeInput): ChartInfo {
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
  if (!title0) return null
  // the text may be a signal (a group title reads its facet datum as `parent`)
  let textStr: string
  if (typeof title0.text === 'object' && title0.text && 'signal' in title0.text) {
    try {
      textStr = String(ctx!.runtime.expr(title0.text.signal)({}, { ...ctx!.signalParams, parent }))
    } catch { textStr = '' }
  } else textStr = String(title0.text ?? '')
  if (!textStr) return null
  const title = { ...title0, text: textStr }
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
    fontSize: title.fontSize, fontWeight: title.fontWeight, font: title.font, fontStyle: title.fontStyle,
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
        ...(title.font != null ? { font: title.font } : {}),
        ...(title.fontStyle != null ? { fontStyle: title.fontStyle } : {}),
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
      return (t as { units?: unknown }).units != null && !(t as { inferUnits?: unknown }).inferUnits && (t as { extent?: unknown }).extent === undefined
    case 'geoshape': case 'geopoint': case 'linkpath': case 'project':
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
  try {
    buildDatasetsOf(ctx, inputData)
  } finally {
    registry.refresh = undefined
  }
}

function buildDatasetsOf(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  ctx.dsEpoch++
  const sources = new Map<string, CompiledChart['data'][number]>()
  for (const d of ctx.chart.data) sources.set(d.name, d)
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

    let rows: Row[]
    let inPulse: StepPulse | null = null
    if ('source' in d && (d as CompiledChart['data'][number] & { source: string }).source) {
      const src = (d as CompiledChart['data'][number] & { source: string }).source
      const srcDef = ctx.chart.data.find((sd) => sd.name === src)
      if ((d as { format?: DataFormatSpec }).format && srcDef?.values != null) {
        // Vega applies a derived dataset's `format` when (re-)parsing its
        // source's raw values (e.g. source = inline Topology, format =
        // topojson feature extraction). The host's current values (input.data)
        // win over the spec's compiled-in ones.
        rows = readData(ownGet(inputData, src) ?? srcDef.values, (d as { format?: DataFormatSpec }).format)
        inPulse = ctx.inputPulses?.get(src) ?? null
      } else {
        rows = build(src, seen).map((r) => ({ ...r }))
        inPulse = ctx.datasetPulses.get(src) ?? null
      }
    } else if (d.values != null) {
      const given = ownGet(inputData, name)
      if (given) {
        rows = readData(given, d.format)
      } else {
        // vega-loader read semantics: object arrays pass through format.parse
        // coercion; string values are parsed by the registered reader.
        rows = readData(d.values, d.format)
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
      rows = (given ?? []).map((r) => ({ ...r }))
      inPulse = ctx.inputPulses?.get(name) ?? null
    }
    // Inline values, host `input.data`, a `source` copy and a loaded dataset all
    // count against maxRows here, nested group data included (C49).
    checkRowCount(rows.length, `dataset "${name}"`)
    if (inPulse) inPulse = normalizePulse(inPulse, rows.length)
    let outPulse: StepPulse | null = inPulse
    if (d.transform.length) {
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
          const res = applyOneWithState(cur, d.transform[k]!, tctx, name)
          cur = res.rows
          state.steps.push(cur)
          if (res.state !== undefined) state.stepState.set(`${name}#${k}`, res.state)
        }
        rows = cur
        outPulse = null
      }
      ctx.draft.datasets.set(name, state)
    }
    ctx.datasets.set(name, rows)
    ctx.datasetPulses.set(name, outPulse)
    return rows
  }

  for (const d of ctx.chart.data) {
    build(d.name, new Set())
  }
  // Transforms (extent, bin with a signal output) may have written signals.
  ctx.fpMemo = undefined
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
  }
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
    const scale = buildScale(def, scaleContext(ctx, def.name))
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
  // Union bounds carried over from the previous group (pure appends only) and
  // the items appended to it, so the cache survives without a recomputation.
  let carriedBounds: Bounds | undefined
  const addedItems: SceneItem[] = []
  let pendingUndo: ItemsUndo | undefined
  if (source) {
    const rawRows = ctx.datasets.get(source) ?? []
    // Only clone rows when the pipeline will re-encode them all (a mark-level
    // transform); the differential path reads the raw rows and clones
    // just the changed indices, so an unchanged row is never copied.
    let rows: Row[] = rawRows
    let rowsCloned = false
    if (mark.transform?.length) {
      rows = rawRows.map((r) => ({ ...r }))
      rowsCloned = true
      rows = applyTransforms(rows, mark.transform, {
        runtime: ctx.runtime,
        signals: ctx.signalParams,
        hierarchies: ctx.hierarchies,
        projections: ctx.projections,
      }, source)
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
      const encodeAt = (i: number): SceneItem => {
        if (meter) meter.tick('mark encoding')
        const row = { ...(rows[i] as Row) }
        const res = resolveEncodeSet(update, row, ctx, mark.type)
        res.datum = row
        res.__gen = gen
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

  // vega's SortItems: a mark `sort` orders the ENCODED items by their own
  // properties (`x`, `datum.t`, `datum["t"]`), after the encode and before the
  // bound pass; stable. (The sort used to run on the data rows, which only
  // agreed for datum fields.)
  if (mark.sort && source) items = sortMarkItems(items, mark.sort)

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

  // Image URLs are spec-controlled: vet each through the URL policy (C93) so a
  // hostile spec cannot make the viewer's browser request arbitrary URLs.
  // Applied here, on the scene, so the string renderer, the DOM path and canvas
  // all see the same vetted items.
  if (mark.type === 'image') {
    for (const it of items) {
      if (it.url == null) continue
      const vetted = applyImageUrlPolicy(it.url, ctx.urlPolicy)
      if (vetted == null) it.url = undefined
    }
  }

  vetLinks(mark, items, ctx)

  // Appended items extend the carried union bounds only now, after the mark
  // defaults above ran (they can change an item's stroke and so its bounds).
  const group: SceneGroup = {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    clip: mark.clip === true,
    items,
    __source: mark.from?.data,
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
function vetLinks(mark: CompiledMark, items: SceneItem[], ctx: EvalContext): void {
  if (ctx.urlPolicy === undefined) return
  const enc = mark.encode as Record<string, Record<string, unknown> | undefined> | undefined
  if (!enc || !Object.values(enc).some((set) => set && 'href' in set)) return
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
}

interface FacetDef {
  name: string
  data: string
  groupby?: string | string[]
  aggregate?: { fields: string[]; ops: string[] }
}

/**
 * The items a group mark produces (vega parse/mark.js + marks/data.js): one per
 * facet partition of the source data (first-appearance order, datum = the
 * partition's key fields plus any facet aggregate), one per datum of `from.data`,
 * or a single item with no source.
 */
function groupSources(mark: CompiledMark, ctx: EvalContext): GroupSource[] {
  const facet = (mark.from as { facet?: FacetDef } | undefined)?.facet
  if (facet) {
    const keys = ([] as string[]).concat(facet.groupby ?? [])
    if (!keys.length) return []
    const rows = ctx.datasets.get(facet.data) ?? []
    // the keys are vega fields (`a.b`, `a\.b`): partition by the accessor, and name the key
    // tuple's properties by the accessor's own name (Facet: `tuple[fn.fname] = fn(t)`)
    const accessors = fieldsOf(keys)
    const keyOf = groupKeyFn(keys)
    const parts = new Map<string, Row[]>()
    for (const r of rows) {
      const k = keyOf(r)
      const g = parts.get(k)
      if (g) g.push(r)
      else parts.set(k, [r])
    }
    return [...parts.values()].map((g) => {
      let datum: Row = {}
      accessors.forEach((acc, i) => { datum[((acc as { fname?: string }).fname) ?? keys[i]!] = acc(g[0]!) })
      const ag = facet.aggregate
      if (ag?.ops) {
        // a facet aggregate (vega-lite's stack_group_main): the group item's datum carries it
        datum = { ...datum, ...aggregateGroup(g, { type: 'aggregate', groupby: keys, fields: ag.fields, ops: ag.ops, as: ag.ops.map((op, i) => `${op}_${ag.fields[i]}`) } as never) }
      }
      return { datum, rows: g, facetName: facet.name }
    })
  }
  const data = mark.from?.data
  if (data) return (ctx.datasets.get(data) ?? []).map((row) => ({ datum: row }))
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
function buildGroupMark(mark: CompiledMark, ctx: EvalContext): SceneGroup[] {
  const groups = groupSources(mark, ctx).map((src) => buildGroupItem(mark, ctx, src))
  // SortItems: the group items are ordered by their own properties (`datum["g"]`, `x`, ...)
  return mark.sort && groups.length > 1 ? (sortMarkItems(groups as SceneItem[], mark.sort) as SceneGroup[]) : groups
}

/** vega Bound's rectangle offset for a group background (marks/group.js `offset`). */
function groupStrokeOffset(item: SceneItem): number {
  const rec = item as Record<string, unknown>
  const sw = rec.strokeWidth == null ? 1 : Number(rec.strokeWidth)
  if (rec.strokeOffset != null) return Number(rec.strokeOffset)
  return item.stroke && sw > 0.5 && sw < 1.5 ? 0.5 - Math.abs(sw - 1) : 0
}

function buildGroupItem(mark: CompiledMark, ctx: EvalContext, src: GroupSource): SceneGroup {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  // the facet partition is a dataset for everything in this item's scope, its own scales included
  const savedFacet = src.facetName !== undefined ? ctx.datasets.get(src.facetName) : undefined
  if (src.facetName !== undefined) ctx.datasets.set(src.facetName, src.rows!)
  // the group's own datasets (vega: a group's `data`), derived in this item's scope
  const savedData: Array<[string, Row[] | undefined]> = []
  try {
    for (const d of mark.data ?? []) {
      const source = (d as CompiledData & { source?: string }).source
      let rows: Row[] = source ? (ctx.datasets.get(source) ?? []).map((r) => ({ ...r })) : d.values != null ? readData(d.values, d.format) : []
      checkRowCount(rows.length, `dataset "${d.name}"`)
      if (d.transform?.length) {
        rows = applyTransforms(rows, d.transform, { runtime: ctx.runtime, signals: ctx.signalParams, hierarchies: ctx.hierarchies, projections: ctx.projections }, d.name)
      }
      savedData.push([d.name, ctx.datasets.get(d.name)])
      ctx.datasets.set(d.name, rows)
    }
    const encode = (mark.encode?.update ?? {}) as Record<string, EncodeValue | EncodeValue[]>
    const geo = resolveEncodeSet(encode, src.datum, ctx, 'group')
    const gx = num(geo.x) ?? 0
    const gy = num(geo.y) ?? 0
    const gw = Math.max(0, num(geo.width) ?? 0)
    const gh = Math.max(0, num(geo.height) ?? 0)

    // own scales resolve against the view's signals (vega: width / height are the view's), the
    // facet partition as data
    const childScales = new Map<string, Scale>()
    const childTypes = new Map<string, string>()
    for (const sdef of mark.scales ?? []) {
      childScales.set(sdef.name, buildScale(sdef, scaleContext(ctx, sdef.name)))
      childTypes.set(sdef.name, sdef.type)
    }
    const hasParent = src.facetName !== undefined || mark.from?.data !== undefined
    const childCtx: EvalContext = {
      ...ctx,
      width: gw,
      height: gh,
      groupX: gx,
      groupY: gy,
      scales: childScales.size ? new Map([...ctx.scales, ...childScales]) : ctx.scales,
      scaleTypes: childTypes.size ? new Map([...ctx.scaleTypes, ...childTypes]) : ctx.scaleTypes,
      signalParams: hasParent ? { ...ctx.signalParams, parent: src.datum } : ctx.signalParams,
    }

    const content: SceneGroup[] = []
    for (const child of mark.marks ?? []) {
      const r = evaluateMark(child, childCtx)
      if (r) pushAll(content, Array.isArray(r) ? r : [r])
    }
    // ViewLayout: a `layout` grid positions the child groups (headers, footers, titles, cells) first
    if (mark.layout) trellisLayout({ marktype: 'group', items: content } as unknown as SceneGroup, resolveLayoutOptions(mark.layout, childCtx))

    const { groups: guides } = buildAxisAndLegend(childCtx, content, mark.axes ?? [], mark.legends ?? [])
    const siblings: SceneGroup[] = [...content, ...guides]
    const title = buildTitleGroup(mark.groupTitle, siblings, gw, gh, false, childCtx, src.datum)
    if (title) siblings.push(title)
    const ordered = paintOrderOf(siblings)

    // the background: the group's own box (marks/group.js), rounded by its corner radii
    const off = groupStrokeOffset(geo)
    const corners: Record<string, number> = {}
    for (const k of Object.keys(geo)) if (k.startsWith('cornerRadius') && Number(geo[k as keyof SceneItem])) corners[k] = Number(geo[k as keyof SceneItem])
    const bgPath = Object.keys(corners).length
      ? rectItemPath({ x: off, y: off, width: gw, height: gh, ...corners } as SceneItem)!
      : `M${off},${off}h${gw}v${gh}h${-gw}Z`
    const paint: Record<string, unknown> = {}
    for (const k of ['fill', 'stroke', 'strokeWidth', 'strokeOpacity', 'fillOpacity', 'opacity', 'strokeDash', 'strokeDashOffset', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'strokeOffset'] as const) {
      const v = (geo as Record<string, unknown>)[k]
      if (v != null) paint[k] = v
    }
    const bg = { path: bgPath, x: 0, y: 0, _bg: true, ...paint } as unknown as SceneItem
    // the item's `clip` (encode) clips its content to its own box; the mark's `clip` clips the whole mark to the enclosing group
    const clip = (geo as Record<string, unknown>).clip === true
    const role = (mark.role as string | undefined) ?? 'scope'

    const group = {
      marktype: 'group', name: mark.name, role, x: gx, y: gy, width: gw, height: gh,
      items: clip
        ? [bg, { marktype: 'group', role: 'scope', clip: true, ...(Object.keys(corners).length ? { clipPathD: bgPath } : {}), width: gw, height: gh, x: 0, y: 0, items: ordered } as SceneGroup]
        : [bg, ...ordered],
      ...paint,
      datum: src.datum,
      _scope: true,
      ...(mark.clip === true ? { markClip: true } : {}),
    } as unknown as SceneGroup
    if (mark.scales?.length) group.__scales = snapshotScales(childCtx.scales)
    return group
  } finally {
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

  // The encoded channel values (pixels, colours, ...) live on the scene ITEM and
  // are never written back onto the datum: `datum` is the caller's data row, and
  // tooltips, signals and interactions read data values from it (C21). A data
  // field named like a channel (`x`, `size`, `fill`) therefore keeps its value.
  // `defined` is evaluated against the data tuple, as Vega does.
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
      else if (groupKey === 'x') v = ctx.groupX ?? 0
      else if (groupKey === 'y') v = ctx.groupY ?? 0
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

/**
 * vega's legend mark order: background, entries (per entry: bounds rect,
 * symbol, label), then the title LAST (`role-legend-title`). The builders push
 * the title where its layout is computed; it is moved to paint last here, and
 * given vega's `guide-title` bold default.
 */
function placeLegendTitleLast(group: SceneGroup, legend: CompiledLegend, ctx: EvalContext): void {
  const items = group.items
  if (!items) return
  // The legend's font properties apply to every title/label text whichever
  // builder made it (gradient, symbol, band, columns...): an explicit item value
  // (set by a builder that already honoured it) wins, then the legend property.
  const L = legend as { titleFont?: string; titleFontWeight?: string | number; titleFontStyle?: string; labelFont?: string; labelFontWeight?: string | number; labelFontStyle?: string }
  const rest: SceneItem[] = []
  const titles: SceneItem[] = []
  for (const it of items) {
    if (it.text == null) { rest.push(it); continue }
    const isTitle = it._legendTitle === true
    const font = isTitle ? L.titleFont : L.labelFont
    const weight = isTitle ? L.titleFontWeight : L.labelFontWeight
    const style = isTitle ? L.titleFontStyle : L.labelFontStyle
    if (font != null && it.font == null) it.font = font
    if (style != null && it.fontStyle == null) it.fontStyle = style
    if (isTitle) {
      // `guide-title` is bold unless the legend says otherwise
      it.fontWeight = weight != null ? weight : (it.fontWeight ?? 'bold')
      // ... and the spec's encode.title (the title mark's userEncode) has the last word, whichever builder drew it
      applyGuideEncode(it, guideEncodeSet(legend.encode?.title), { title: legend.title != null, scales: {}, type: legend.type ?? 'symbol', vgrad: false }, ctx, { x: 0, y: 0 })
      titles.push(it)
    } else {
      if (weight != null && it.fontWeight == null) it.fontWeight = weight
      rest.push(it)
    }
  }
  group.items = [...rest.filter((it) => it.text == null || !it._legendTitle), ...titles]
}

/** vega-scale `isContinuous`: the scale types a gradient legend can draw. */
/** vega-parser LegendScales: the channels a legend can map, in priority order (the first is the canonical scale). */
const LEGEND_SCALES = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const
const VEGA_CONTINUOUS_SCALES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'diverging'])

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

function buildLegend(legend: CompiledLegend, ctx: EvalContext): SceneGroup | null {
  // Resolve the scale name (fill/stroke color legends, size legends, or shape legends).
  // vega-parser legend.js: the canonical scale is the first channel in LegendScales order
  const scaleName = legend.size ?? legend.shape ?? legend.fill ?? legend.stroke
    ?? (typeof legend.strokeWidth === 'string' ? legend.strokeWidth : undefined)
    ?? legend.strokeDash ?? legend.opacity
  if (!scaleName) return null
  // Legend labels honor formatType/format; a Vega-Lite timeUnit legend emits
  // the format as a timeUnitSpecifier(...) signal, which must be resolved to
  // its strftime specifier before formatting.
  const legendLabel = (v: unknown): string => {
    const L = locale(undefined)
    let fmt = (legend as { format?: unknown }).format
    const fmtType = (legend as { formatType?: unknown }).formatType
    if (v == null) return fmtType === 'time' || fmtType === 'utc' ? '' : String(v)
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
    const cal = calendarOf(ctx.scaleTypes.get(scaleName), fmtType) ?? (v instanceof Date ? 'time' : undefined)
    if (cal) {
      const d = v instanceof Date ? v : new Date(Number(v))
      const spec = typeof fmt === 'string' ? fmt : '%b %d, %Y'
      return (cal === 'utc' ? L.utcFormat(spec) : L.timeFormat(spec))(d)
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
    if (titleStr) items.push({ _legendTitle: true, text: titleStr, x: 0, y: 0, align: 'left', baseline: 'top', fill: '#000', fontSize: 11 })
    return { marktype: 'group', role: 'legend', x: 0, y: 0, width: 0, height: 0, items }
  }
  // Domain values. A continuous symbol legend (opacity, or a color scale
  // without a gradient) lists generated ticks, not just the domain endpoints.
  const rawDomain = scale.domain() as unknown[]
  // vega LegendEntries: `values = _.values || labelValues(scale, count)`; the spec's
  // values may be a signal, or an array holding signals.
  const explicitValues = resolveLegendValues(legend, ctx)
  // vega LegendEntries: count = tickCount(scale, _.count == null ? 5 : _.count, _.minstep)
  let symbolCountSpec: unknown = tickCountRaw ?? 5
  if (symbolCountSpec && typeof symbolCountSpec === 'object' && 'signal' in (symbolCountSpec as Record<string, unknown>)) {
    try { symbolCountSpec = ctx.runtime.expr(String((symbolCountSpec as { signal: string }).signal))({}, ctx.signalParams) } catch { symbolCountSpec = 5 }
  }
  const symbolTickMinStep = (legend as { tickMinStep?: unknown }).tickMinStep
  let domain: unknown[] = explicitValues
    ?? (CONTINUOUS_TYPES.has(scaleType)
    && typeof (scale as { ticks?: (n?: number) => unknown[] }).ticks === 'function'
    ? tickValues(scale as never, tickCount(scale as never, symbolCountSpec, typeof symbolTickMinStep === 'number' ? symbolTickMinStep : undefined))
    : rawDomain)
  // ... "if first value maps to size zero, remove from list (vega#717)"
  if (!explicitValues && domain.length && scale(domain[0]) === 0) domain = domain.slice(1)
  // gradient legends position ticks across the true scale domain (not the
  // generated tick list); symbol legends list the ticks themselves.
  const d0 = rawDomain[0]
  const d1 = rawDomain[rawDomain.length - 1]
  const orient = legend.orient ?? 'right'

  // --- Gradient legend (continuous scale + gradientLength) ---
  // Vega defaults to gradient legends for interpolating scales (sequential,
  // diverging) even without an explicit gradientLength.
  const isInterpolating = scaleType === 'sequential'
  // vega-parser legendType(): an explicit `type` wins; otherwise a fill/stroke
  // legend over a single continuous scale is a gradient legend (no
  // gradientLength needed).
  const legendScaleCount = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity']
    .filter((k) => (legend as unknown as Record<string, unknown>)[k] != null).length
  const autoGradient = legend.type == null && legendScaleCount === 1 && (legend.fill != null || legend.stroke != null)
    && VEGA_CONTINUOUS_SCALES.has(scaleType)
  if (legend.type !== 'symbol' && CONTINUOUS_TYPES.has(scaleType)
    && (legend.type === 'gradient' || autoGradient || legend.own?.gradientLength != null || isInterpolating)) {
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
    // vega-functions gradient(): stops from the scale's ticks (see scaleGradientStops)
    const gradStops = scaleGradientStops(scale as never)
    const gradientIdH = gradientDefId('horizontal', gradStops)
    const gradientId = gradientDefId('vertical', gradStops)

    // The spec's encode.title: text / paint / font of the title mark, against the legend's datum.
    const gradLegendDatum: Row = { title: legend.title != null, scales: {}, type: 'gradient', vgrad: !(legend.direction === 'horizontal' || orient === 'bottom' || orient === 'top') }
    const gradTitleOver: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(guideEncodeSet(legend.encode?.title) ?? {})) {
      const r = resolveEncodeProperty(v, gradLegendDatum, ctx)
      if (r !== undefined) gradTitleOver[k] = r
    }
    // Gradient-legend paint properties (vega legend scheme defaults).
    const titleColor0 = (gradTitleOver.fill as string | undefined) ?? (legend as { titleColor?: string }).titleColor ?? '#000'
    const labelColor0 = (legend as { labelColor?: string }).labelColor ?? '#000'
    const titleOpacity0 = (gradTitleOver.fillOpacity as number | undefined) ?? (legend as { titleOpacity?: number }).titleOpacity
    const labelOpacity0 = (legend as { labelOpacity?: number }).labelOpacity
    const titleFs0 = (gradTitleOver.fontSize as number | undefined) ?? (legend as { titleFontSize?: number }).titleFontSize ?? 11
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
    const legendValues = explicitValues
    if (Array.isArray(legendValues)) tickNums = legendValues
    else if (tickNums.length < 3 && legendValues == null && d0 !== d1 && !(Number.isNaN(Number(d0)) && Number.isNaN(Number(d1)))) {
      tickNums = [d0, d1]
    }
    // An all-invalid (NaN) domain has no generated ticks and no usable end
    // points; vega (observed) emits a single 'NaN' label at the gradient midpoint.
    if (tickNums.length === 0 && legendValues == null && Number.isNaN(Number(d0))) tickNums = [NaN]
    const titleStr0 = String(gradTitleOver.text ?? legend.title ?? '')
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
    const legendCalendar = calendarOf(scaleType, legendFormatType)
    // the spec's encode.labels (text, paint, font, ...), evaluated against the entry's datum
    // {index, label, value, perc} (vega-encode LegendEntries); the label text is measured as encoded
    const encLabels = guideEncodeSet(legend.encode?.labels)
    // (the text was applied above, while measuring; the rest styles the item)
    const encLabelsRest = encLabels && Object.fromEntries(Object.entries(encLabels).filter(([k]) => k !== 'text'))
    const encodeLabel = (item: SceneItem, datum: Row): void => applyGuideEncode(item, encLabelsRest, datum, ctx, { x: 0, y: 0 })
    const makeGradientFmt = (): ((v: unknown, idx?: number, perc?: number) => string) => {
      const L = locale(undefined)
      let base: (v: unknown) => string
      if (legendCalendar) {
        // vega-scale tickFormat: no specifier means the locale's multi-scale time format
        const format = legendCalendar === 'utc' ? L.utcFormat(resolvedLegendFormat) : L.timeFormat(resolvedLegendFormat)
        base = (v: unknown) => format(v instanceof Date ? v : new Date(Number(v)))
      } else if (resolvedLegendFormat) {
        base = (v: unknown) => L.format(resolvedLegendFormat)(typeof v === 'number' ? v : Number(v))
      } else {
        // vega labelFormat() with no explicit specifier delegates to the
        // scale's locale tick formatter, which chooses decimal precision from
        // the tick step (e.g. 8.0/8.5/9.0 for a [8,9] domain).
        base = (v: unknown) => tickFormat(L, scale, gradCount)(v)
      }
      const textEnc = encLabels?.text
      if (textEnc === undefined) return base
      return (v: unknown, idx = 0, perc = 0) => {
        const r = resolveEncodeProperty(textEnc, { index: idx, label: base(v), value: v, perc }, ctx)
        return r === undefined ? base(v) : String(r)
      }
    }

    // vega's scaleFraction() builds a positional copy of the scale over the
    // legend domain, so non-linear scales (log/sqrt/symlog) place labels at
    // their transformed positions rather than linearly.
    // a time scale's domain and ticks are Dates: vega's scaleFraction subtracts them
    // (milliseconds), so a Date is its time value, never a stand-in 0
    const legendNum = (v: unknown, dflt: number): number => typeof v === 'number' ? v : v instanceof Date ? +v : dflt
    const gradD0n = legendNum(d0, 0)
    const gradD1n = legendNum(d1, 1)
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
      const legendFmt = makeGradientFmt()
      const items: SceneItem[] = []
      // legendLayout: the box spans the content from the legend origin to the right
      // edge of everything in it (labels centred on their ticks overhang the strip);
      // the left overhang is not part of it (legendBounds pins x1 to the padding).
      let bgW = gradientLength
      const bgH = titleH0 + thickness + 12
      const bgX0 = borderColor0 != null ? 0.5 : 0
      const bgY0 = borderColor0 != null ? 0.5 : 0
      const gradCRH = (legend as { cornerRadius?: number }).cornerRadius
      const bgSlot = items.length
      if (titleStr0) {
        const hAnchor = (legend as { titleAnchor?: string }).titleAnchor ?? 'start'
        const hAlign = (legend as { titleAlign?: string }).titleAlign
          ?? (hAnchor === 'end' ? 'right' : hAnchor === 'middle' ? 'center' : 'left')
        const hBase = (legend as { titleBaseline?: string }).titleBaseline ?? 'top'
        const hY = hBase === 'middle' ? Math.round(0.3 * titleFs0) : hBase === 'bottom' ? Math.round(-0.21 * titleFs0) : Math.round(0.79 * titleFs0)
        const hX = hAnchor === 'end' ? gradientLength : hAnchor === 'middle' ? gradientLength / 2 : 0
        const hTitleW = nominalTextWidth(titleStr0, Math.abs(titleFs0), 'bold')
        bgW = Math.max(bgW, hX + (hAlign === 'center' ? hTitleW / 2 : hAlign === 'right' ? 0 : hTitleW))
        const hLimit = (legend as { titleLimit?: number }).titleLimit
        items.push({ _legendTitle: true, text: titleStr0, x: hX, y: hY, align: hAlign as SceneItem['align'], fill: titleColor0, fontSize: titleFs0, ...(hLimit != null ? { limit: hLimit } : {}), ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}) })
      }
      items.push({ path: `M0,0h${gradientLength}v${thickness}h${-gradientLength}Z`, x: 0, y: titleH0, fill: `url(#${gradientIdH})`, stroke: gradStrokeColor, strokeWidth: gradStrokeWidth, opacity: gradOpacityProp ?? 1 })
      const labelStartH = items.length
      for (const [ti, t] of tickNums.entries()) {
        const tNum = legendNum(t, 0)
        const perc = gradientFraction(tNum)
        const labelText = legendFmt(tNum, ti, perc)
        // vega-parser legend-gradient-labels: flush at the strip's ends, centred between them
        const labelAlign = perc <= 0 ? 'left' : perc >= 1 ? 'right' : 'center'
        // raw item y (strip + labelOffset) with baseline 'top': the renderer adds the baseline shift,
        // so a spec's encode.labels baseline / fontSize move the label as in vega
        const labelItem: SceneItem = { text: labelText, x: perc * gradientLength, y: titleH0 + thickness + ((legend.own?.labelOffset as number | undefined) ?? (legend as { gradientLabelOffset?: number }).gradientLabelOffset ?? 2), baseline: 'top', align: labelAlign, fill: labelColor0, fontSize: labelFs0, ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}), ...(labelOpacity0 != null ? { fillOpacity: labelOpacity0 } : {}) }
        encodeLabel(labelItem, { index: ti, label: String(labelText), value: t, perc })
        items.push(labelItem)
      }
      // vega-parser legend-gradient-labels: the labels go through the Overlap
      // transform (config.legend.labelOverlap defaults to true)
      applyOverlap(items.slice(labelStartH), (legend as { labelOverlap?: unknown }).labelOverlap, (legend as { labelSeparation?: number }).labelSeparation ?? 0)
      // vega's Overlap transform re-bounds the label mark from the VISIBLE labels only
      for (const lab of items.slice(labelStartH)) {
        if (lab.opacity === 0) continue
        bgW = Math.max(bgW, boundLeaf(new Bounds(), lab).x2)
      }
      bgW = Math.ceil(bgW)
      items.splice(bgSlot, 0, { path: gradCRH && gradCRH > 0 ? roundedRectPath(bgX0, bgY0, bgW, bgH, Math.min(gradCRH, bgW / 2, bgH / 2)) : `M${bgX0},${bgY0}h${bgW}v${bgH}h-${bgW}Z`, x: 0, y: 0, ...(fillColor0 != null ? { fill: fillColor0 } : {}), ...(borderColor0 != null ? { stroke: borderColor0 } : {}) })
      if (gradStops.length && !ctx._defs.some((d) => d.id === gradientIdH)) ctx._defs.push({ id: gradientIdH, colorStops: gradStops, direction: 'horizontal' })
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
    const measureFmt = makeGradientFmt()
    const labelStrs = tickNums.map((t: unknown, i: number) => measureFmt(t, i, gradientFraction(legendNum(t, 0))))
    // Overlap re-bounds the label mark from the labels it left visible, so the
    // box is as wide as the widest of THOSE: decide visibility with the same
    // positions the labels get below (the overlap test is x-independent here).
    // (the label as it will be drawn, at the strip's x offset: the spec's encode.labels - fontSize,
    // align, baseline, ... - shapes both the overlap test and the box)
    const probeX = ((legend as { gradientThickness?: number }).gradientThickness ?? 16)
      + ((legend.own?.labelOffset as number | undefined) ?? (legend as { gradientLabelOffset?: number }).gradientLabelOffset ?? 2)
    const probe: SceneItem[] = tickNums.map((t: unknown, i: number) => {
      const perc = gradientFraction(legendNum(t, 0))
      const item: SceneItem = {
        text: labelStrs[i]!, x: probeX, y: (1 - perc) * L, baseline: perc <= 0 ? 'bottom' : perc >= 1 ? 'top' : 'middle', align: 'left', fontSize: labelFs0,
        ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}),
      }
      encodeLabel(item, { index: i, label: labelStrs[i]!, value: t, perc })
      return item
    })
    applyOverlap(probe, (legend as { labelOverlap?: unknown }).labelOverlap, (legend as { labelSeparation?: number }).labelSeparation ?? 0)
    const probeBounds = probe.map((it) => boundLeaf(new Bounds(), it))
    // the widest right edge among the labels Overlap left visible, measured from the strip's label offset
    const maxLabelW = probe.reduce((m: number, it, i: number) => it.opacity === 0 ? m : Math.max(m, probeBounds[i]!.x2 - probeX), 0)
    const titleStr = titleStr0
    const titleWidth = titleStr.length > 0 ? nominalTextWidth(titleStr, Math.abs(titleFs0), 'bold') : 0
    const vThickness = (legend as { gradientThickness?: number }).gradientThickness ?? 16
    // vega legend-gradient-labels: value(spec.labelOffset, config.gradientLabelOffset)
    const vLabelOffset = (legend.own?.labelOffset as number | undefined) ?? (legend as { gradientLabelOffset?: number }).gradientLabelOffset ?? 2
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
    const labelBottom = probe.reduce<number>((m, it, i) => {
      if (it.opacity === 0) return m // hidden by Overlap: not in the label mark's bounds
      return Math.max(m, gradPad + titleH + probeBounds[i]!.y2)
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
          _legendTitle: true,
          text: titleStr,
          x: titleOrientG === 'left' ? gradPad : gradPad + outerWidth + titlePad0,
          y: gradPad + L / 2,
          angle: titleOrientG === 'left' ? -90 : 90,
          align: 'center',
          // vega rotates the title about its anchor and applies the title
          // baseline (default top) INSIDE the rotated frame
          baseline: ((legend as { titleBaseline?: string }).titleBaseline ?? (titleOrientG === 'right' ? 'bottom' : 'top')) as SceneItem['baseline'],
          fill: titleColor0, fontSize: titleFs0,
          ...(vLimit != null ? { limit: vLimit } : {}),
          ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}),
        })
      } else if (bottomTitleG) {
        items.push({
          _legendTitle: true,
          text: titleStr,
          x: vX + contentX,
          y: gradPad + L + Math.round(0.79 * titleFs0) + titlePad0,
          align: vAlign as SceneItem['align'],
          fill: titleColor0, fontSize: titleFs0,
          ...(vLimit != null ? { limit: vLimit } : {}),
          ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}),
        })
      } else {
        items.push({ _legendTitle: true, text: titleStr, x: vX + contentX, y: vY + gradPad, align: vAlign as SceneItem['align'], fill: titleColor0, fontSize: titleFs0, ...(vLimit != null ? { limit: vLimit } : {}), ...(titleOpacity0 != null ? { fillOpacity: titleOpacity0 } : {}) })
      }
    }
    // Labels. Vega positions each label at (1 - perc) * L and then shifts it by
    // the text baseline offset (labels flush against the gradient edges get
    // top/bottom baselines), rounding to whole pixels. Replicate that here.
    // Vega formats gradient legend labels with the locale formatter, which uses
    // the Unicode minus sign (U+2212) for negative values. Match that by using
    // the locale number formatter rather than String().
    const legendFmt = makeGradientFmt()
    const labelStartV = items.length
    for (const [ti, t] of tickNums.entries()) {
      const tNum = legendNum(t, 0)
      const perc = gradientFraction(tNum)
      // raw item y with vega's flush baselines (legend-gradient-labels baselineExpr): the
      // renderer adds the shift, so a spec's encode.labels baseline / fontSize move the label as in vega
      const labelItem: SceneItem = { text: legendFmt(tNum, ti, perc), x: contentX + vThickness + vLabelOffset, y: gradPad + titleH + (1 - perc) * L, baseline: perc <= 0 ? 'bottom' : perc >= 1 ? 'top' : 'middle', align: 'left', fill: labelColor0, fontSize: labelFs0, ...((legend as { labelLimit?: number }).labelLimit != null ? { limit: (legend as { labelLimit?: number }).labelLimit } : {}), ...(labelOpacity0 != null ? { fillOpacity: labelOpacity0 } : {}) }
      encodeLabel(labelItem, { index: ti, label: String(labelItem.text), value: t, perc })
      items.push(labelItem)
    }
    applyOverlap(items.slice(labelStartV), (legend as { labelOverlap?: unknown }).labelOverlap, (legend as { labelSeparation?: number }).labelSeparation ?? 0)
    // Gradient def from scale's interpolator
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
    if (gradStops.length && !ctx._defs.some((d) => d.id === gradientId)) {
      ctx._defs.push({ id: gradientId, colorStops: gradStops })
    }
    return group
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
      if (titleStrB) items.push({ _legendTitle: true, text: titleStrB, x: 0, y: 9, align: 'left', fill: '#000', fontSize: 11, fontWeight: 'bold' })
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
      items.push({ text: '', x: 18, y: titleH + bandCount * SWATCH_H - 2, align: 'left', fill: '#000', fontSize: 10 })
      return { marktype: 'group', role: 'legend', x: 0, y: 0, width: outerWidth, height: bgH, items }
    }
  }

  // --- Symbol legend (discrete) ---
  const n = domain.length


  // --- Symbol legend geometry (orient-independent: vertical entries; the
  // grid anchor in buildAxisAndLegend positions every orient) ---
  {
    // --- vega legend-symbol-groups.js: the symbol's properties, in vega's own
    // precedence. The legend's symbol* properties first (a legend WITHOUT a fill
    // channel starts from the base fill / stroke: transparent / #888), then the
    // scale of every channel the legend maps (size, shape, fill, stroke,
    // strokeWidth, strokeDash, opacity) at the entry value, then the spec's own
    // `encode.symbols` (enter, then update). One rule for every channel: there is
    // no per-channel painting below this point.
    const legendRec = legend as unknown as Record<string, unknown>
    const symbolsEncode = (legend.encode as { symbols?: { enter?: Record<string, EncodeValue>; update?: Record<string, EncodeValue> } } | undefined)?.symbols
    const hasFillChannel = legend.fill != null
    const channelScales: Array<[string, Scale]> = []
    for (const ch of LEGEND_SCALES) {
      const scaleRef = legendRec[ch]
      const sc = typeof scaleRef === 'string' ? ctx.scales.get(scaleRef) : undefined
      if (sc) channelScales.push([ch, sc])
    }
    const baseEnter: Record<string, unknown> = {
      fill: legendRec.symbolFillColor ?? (hasFillChannel ? undefined : legendRec.symbolBaseFillColor),
      shape: legendRec.symbolType,
      size: legendRec.symbolSize,
      stroke: legendRec.symbolStrokeColor ?? (hasFillChannel ? undefined : legendRec.symbolBaseStrokeColor),
      strokeDash: legendRec.symbolDash,
      strokeDashOffset: legendRec.symbolDashOffset,
      strokeWidth: legendRec.symbolStrokeWidth,
    }
    const symbolProps = (datum: Row): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      const put = (src: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v
      }
      const scaled: Record<string, unknown> = {}
      for (const [ch, sc] of channelScales) scaled[ch] = sc(datum.value)
      put({ ...baseEnter, ...scaled })
      for (const [k, v] of Object.entries(symbolsEncode?.enter ?? {})) {
        const r = resolveEncodeProperty(v, datum, ctx)
        if (r !== undefined) out[k] = r
      }
      put({ opacity: legendRec.symbolOpacity ?? 1, ...scaled })
      for (const [k, v] of Object.entries(symbolsEncode?.update ?? {})) {
        const r = resolveEncodeProperty(v, datum, ctx)
        if (r !== undefined) out[k] = r
      }
      return out
    }
    // vega-parser legend.js sizeExpression: max(ceil(sqrt(size) + strokeWidth), fontSize),
    // where size / strokeWidth are the channel's scale at the value when the legend maps
    // it, else the symbol mark's encoded value (getEncoding: update, then enter).
    const encodedSymbolValue = (name: string, datum: Row): unknown => {
      const user = symbolsEncode?.update?.[name] ?? symbolsEncode?.enter?.[name]
      return user !== undefined ? resolveEncodeProperty(user, datum, ctx) : baseEnter[name]
    }
    const symbolSizeOf = (v: unknown): number => {
      const sc = channelScales.find(([ch]) => ch === 'size')?.[1]
      return Number(sc ? sc(v) : (encodedSymbolValue('size', { value: v }) ?? 0))
    }
    const symbolStrokeWidthOf = (v: unknown): number => {
      const sc = channelScales.find(([ch]) => ch === 'strokeWidth')?.[1]
      return Number(sc ? sc(v) : (encodedSymbolValue('strokeWidth', { value: v }) ?? 0))
    }
    const symbolItemPaint = (props: Record<string, unknown>): Record<string, unknown> => {
      const { shape: _shape, size: _size, ...paint } = props
      return paint
    }
    const labelFs = (legend as { labelFontSize?: number }).labelFontSize ?? 10

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
    // the label font size the size expression floors at: the labels' ENCODED fontSize
    // (the spec's encode.labels over the legend's), else the legend's, else the style's
    const encodedLabelFs = guideEncodeSet(legend.encode?.labels)?.fontSize
    const sizeFloorFs = (() => {
      if (encodedLabelFs === undefined) return labelFs
      const r = resolveEncodeProperty(encodedLabelFs, {}, ctx)
      return typeof r === 'number' ? r : labelFs
    })()
    const entrySizeD = (v: unknown): number =>
      // (vega: `getEncoding('fontSize', ...) || getStyle('fontSize', ...)`: a zero font size falls back to the style's 10)
      Math.max(Math.ceil(Math.sqrt(symbolSizeOf(v)) + symbolStrokeWidthOf(v)), sizeFloorFs || 10)
    const offsetDatum = entryValues.length ? Math.max(0, maxOf(entryValues.map(entrySizeD))) : 0
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
    const rowPadding = (legend as { rowPadding?: number }).rowPadding ?? 2
    const colPad = (legend as { columnPadding?: number }).columnPadding ?? 10
    const labelColor = (legend as { labelColor?: string }).labelColor ?? '#000'
    const labelOpacity = (legend as { labelOpacity?: number }).labelOpacity
    const labelFontWeight = (legend as { labelFontWeight?: string | number }).labelFontWeight
    const labelFontStyle = (legend as { labelFontStyle?: string }).labelFontStyle
    const labelFont = (legend as { labelFont?: string }).labelFont
    // the spec's encode.title (vega legend-title.js userEncode): text, paint and font of the
    // title mark, evaluated against the legend's datum, take precedence over the title properties
    const legendDatum: Row = { title: legend.title != null, scales: {}, type: 'symbol', vgrad: false }
    const titleOver: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(guideEncodeSet(legend.encode?.title) ?? {})) {
      const r = resolveEncodeProperty(v, legendDatum, ctx)
      if (r !== undefined) titleOver[k] = r
    }
    const titleFont = (titleOver.font as string | undefined) ?? (legend as { titleFont?: string }).titleFont
    const titleColor = (titleOver.fill as string | undefined) ?? (legend as { titleColor?: string }).titleColor ?? '#000'
    const titleOpacity = (titleOver.fillOpacity as number | undefined) ?? (legend as { titleOpacity?: number }).titleOpacity
    const titleFs = (titleOver.fontSize as number | undefined) ?? (legend as { titleFontSize?: number }).titleFontSize ?? 11
    const titlePad = (legend as { titlePadding?: number }).titlePadding ?? 5
    const labelLimit = (legend as { labelLimit?: number }).labelLimit ?? 160
    const labelAlign = (legend as { labelAlign?: string }).labelAlign ?? 'left'
    const lblBaseline = (legend as { labelBaseline?: string }).labelBaseline ?? 'middle'
    const titleStr = String(titleOver.text ?? legend.title ?? '')
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
    const ncols = colsFlag === 0
      ? n
      : colsFlag > 0 ? (Number.isInteger(colsFlag) ? colsFlag : 1)
        : 1

    // --- per-entry encoded positions and measured bounds (the Bound pass) ---
    // symbol x = (columns ? offset : size)/2 + symbolOffset; label x =
    // (columns ? offset : size) + labelOffset (no halving); y = clipHeight/2
    // when clipped, else the size datum/2.
    const symDs: string[] = []
    const symPropsOf: Array<Record<string, unknown>> = []
    const lblItems: SceneItem[] = []
    const ySymIs: number[] = []
    const encLabels = guideEncodeSet(legend.encode?.labels)
    const childEncodeCtx = ctx
    const ebs: Bounds[] = []
    const yIs: number[] = []
    const xSymIs: number[] = []
    const xLblIs: number[] = []
    for (const e of entries) {
      const yI = hasClip ? (clipHeightRaw as number) / 2 : e.sizeD / 2
      const xSymI = (colsTruthy ? offsetDatum : e.sizeD) / 2 + symbolOffset
      const xLblI = (colsTruthy ? offsetDatum : e.sizeD) + symbolOffset + labelOffset
      yIs.push(yI); xSymIs.push(xSymI); xLblIs.push(xLblI)
      const entryDatum: Row = { value: e.value, label: e.label, index: entries.indexOf(e) }
      const props = symbolProps(entryDatum)
      // the spec's encode.symbols may also place the symbol (x / y in the entry's frame)
      if (props.x !== undefined) xSymIs[xSymIs.length - 1] = Number(props.x)
      if (props.y !== undefined) ySymIs.push(Number(props.y)); else ySymIs.push(yI)
      const xSymFinal = xSymIs[xSymIs.length - 1]!
      const symD = String(symbolPath(String(props.shape ?? 'circle'), Math.sqrt(Number(props.size)) / 2))
      symDs.push(symD)
      symPropsOf.push(props)
      // symbol bound: traced path + stroke expansion (miter), translated by
      // the item position with vega's `|| 0` NaN coercion — NaN positions
      // leave the sentinel bounds untouched and the union no-ops.
      const symItem = { ...symbolItemPaint(props), path: symbolPathExact(String(props.shape ?? 'circle'), Math.sqrt(Number(props.size)) / 2), x: xSymFinal, y: ySymIs[ySymIs.length - 1]! } as unknown as SceneItem
      const symB = boundLeaf(new Bounds(), symItem)
      // a clipped symbol mark (clipHeight) has its bounds cut to the clip region - the entry
      // group's box, whose width is still 0 when the Bound pass runs (boundClip)
      if (hasClip) symB.intersect(new Bounds().set(0, 0, 0, clipHeightRaw as number))
      // label bound: boundText (truncation via limit, align-aware x1, negative
      // fontSize flips through set())
      // The label item as vega's legend-labels encode builds it, then the spec's encode.labels
      // (text, paint, font, align, ...) on top; it is bounded and drawn as is.
      const lblItem: SceneItem = {
        text: e.label, x: xLblI, y: yI, baseline: lblBaseline as 'middle', align: labelAlign as 'left',
        fill: labelColor, fontSize: labelFs, limit: labelLimit,
        ...(labelOpacity != null ? { fillOpacity: labelOpacity } : {}),
        ...(labelFont != null ? { font: labelFont } : {}),
        ...(labelFontWeight != null ? { fontWeight: labelFontWeight } : {}),
        ...(labelFontStyle != null ? { fontStyle: labelFontStyle } : {}),
      }
      applyGuideEncode(lblItem, encLabels, entryDatum, childEncodeCtx, { x: 0, y: 0 })
      lblItems.push(lblItem)
      const lblB = boundLeaf(new Bounds(), lblItem)
      const eb = new Bounds().union(symB).union(lblB)
      // entry group bound: (clip || width || height) && !noBound adds the
      // corner points (0,0) and (width, height) — the width encodes 0
      if (hasClip) eb.add(0, 0).add(0, clipHeightRaw as number)
      ebs.push(eb)
    }

    // The entry groups are laid out by vega's gridLayout (legendSymbolLayout:
    // align gridAlign, columns entryColumns, center rows, padding row/column,
    // full bounds) over the SORTED entry groups; `paintOrder` is that order.
    // The entry background uses the FLOAT column width and the entry's own bound
    // height (legendEntryLayout: width = max bounds.x2 per column, height =
    // bounds.y2 - y).
    const paintOrder = Array.from({ length: n }, (_, i) => i)
    if (direction !== 'horizontal') {
      const nrowsSig = Math.ceil(n / Math.max(1, Number(colsFlag) || 0))
      paintOrder.sort((x, y) => (x % nrowsSig) - (y % nrowsSig) || x - y)
    }
    const entryGroups: SceneGroup[] = paintOrder.map(() => ({ marktype: 'group', x: 0, y: 0, items: [] }) as unknown as SceneGroup)
    gridLayout(entryGroups, {
      align: (legend as { gridAlign?: string }).gridAlign ?? 'each',
      columns: ncols,
      center: { row: true, column: false },
      padding: { row: rowPadding, column: colPad },
      nodirty: true,
    }, (g) => {
      const eb = ebs[paintOrder[entryGroups.indexOf(g)]!]!
      return eb.empty() ? new Bounds().set(0, 0, 0, 0) : eb.clone()
    })
    const posX: number[] = new Array(n)
    const posY: number[] = new Array(n)
    const colW: number[] = Array<number>(ncols).fill(0)
    paintOrder.forEach((entryIdx, j) => {
      posX[entryIdx] = entryGroups[j]!.x ?? 0
      posY[entryIdx] = entryGroups[j]!.y ?? 0
      const eb = ebs[entryIdx]!
      if (!eb.empty()) colW[j % ncols] = Math.max(colW[j % ncols]!, eb.x2)
    })
    const colWOf = (i: number): number => colW[paintOrder.indexOf(i) % ncols] ?? 0
    // vega legendTitleOffset reads the (shifted) entry container bounds:
    // s = e.bounds.x2/y2 − item.padding — the max grid-positioned extent.
    let sX = 0
    let sY = 0
    entries.forEach((_e, i) => {
      const eb = ebs[i]!
      if (eb.empty()) return
      sX = Math.max(sX, (posX[i] ?? 0) + eb.x2)
      sY = Math.max(sY, (posY[i] ?? 0) + eb.y2)
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
    const specTitleAlign = (titleOver.align as string | undefined) ?? (legend as { titleAlign?: string }).titleAlign
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
    const titleLimit = (titleOver.limit as number | undefined) ?? (legend as { titleLimit?: number }).titleLimit
    const titleBaseline = (titleOver.baseline as string | undefined) ?? (legend as { titleBaseline?: string }).titleBaseline
    // vega's 'guide-title' style defaults fontWeight to bold — the title bound
    // must measure with the same font the renderer emits.
    const titleWeight = (titleOver.fontWeight as string | number | undefined) ?? (legend as { titleFontWeight?: string | number }).titleFontWeight ?? 'bold'
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
      const ex = ctx.rawGuides ? 0 : entryX + (posX[i] ?? 0)
      const ey = ctx.rawGuides ? 0 : legendPad + entryBaseY + (posY[i] ?? 0)
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
    if (titleStr) {
      items.push({ _legendTitle: true, text: titleStr, x: titleX + shift, y: titleY, baseline: (titleBaseline ?? tBaseline) as 'top', align: tAlign, fill: titleColor, fontSize: titleFs, fontWeight: titleWeight, ...(titleFont != null ? { font: titleFont } : {}), ...(titleLimit != null ? { limit: titleLimit } : {}), ...(titleOpacity != null ? { fillOpacity: titleOpacity } : {}) })
    }
    // the entry groups are sorted before they are drawn (legend-symbol-groups: a
    // vertical legend sorts by [row, index] with row = index % nrows; a
    // horizontal one by index), and the sort IS the paint order
    for (const i of paintOrder) {
      const e = entries[i]!
      const eb = ebs[i]!
      const value = e.value
      // Raw-guide mode: the entry rows never got their layout offsets — every
      // entry sits at its encode position (0), overlapping.
      const off = ctx.rawGuides ? 0 : entryBaseY + (posY[i] ?? 0)
      const colOff = ctx.rawGuides ? 0 : (posX[i] ?? 0)
      const colWc = colWOf(i)
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
      const symY = legendPad + off + (ySymIs[i]! || 0)
      items.push({ ...symbolItemPaint(symPropsOf[i]!), path: symDs[i]!, x: symX, y: symY } as SceneItem)
      // clipHeight clips the entry's symbols with a clipPath over the
      // laid-out entry rect (vega's guideMark clip + SVGStringRenderer clip:
      // rect (0,0,entry.width,entry.height) in the entry's local frame)
      if (hasClip && !ctx.rawGuides) {
        ;(items[items.length - 1] as Record<string, unknown>)._clip = { x: entryX + colOff, y: legendPad + off, w: colWc, h: eb.y2 }
      }
      const lblItem = lblItems[i]!
      items.push({ ...lblItem, x: entryX + colOff + ((lblItem.x as number) || 0), y: legendPad + off + ((lblItem.y as number) || 0) })
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

/**
 * vega-view-transforms' Overlap, for guide labels. `method`: true/'parity' hides
 * every other item until no neighbours collide, 'greedy' hides items colliding
 * with the last visible one; falsy does nothing. Items with a degenerate bound
 * (no content) are skipped, the survivors reset to opacity 1 first, and at least
 * two items are always kept (the last source item is resurrected when fewer than
 * three survive). Bounds are the real text bounds (`boundLeaf`), so a truncated
 * label (`limit`) collides as its truncated self.
 */
function applyOverlap(labels: SceneItem[], method: unknown, separation: number): void {
  if (!method) return
  const bounds = new Map<SceneItem, Bounds>()
  const source = labels.filter((it) => {
    const b = boundLeaf(new Bounds(), it)
    bounds.set(it, b)
    return !b.empty() && b.width() > 1 && b.height() > 1
  })
  if (!source.length) return
  for (const it of source) it.opacity = 1
  const intersects = (a: Bounds, b: Bounds): boolean =>
    separation > Math.max(b.x1 - a.x2, a.x1 - b.x2, b.y1 - a.y2, a.y1 - b.y2)
  const hasOverlap = (list: SceneItem[]): boolean => {
    for (let i = 1; i < list.length; i++) if (intersects(bounds.get(list[i - 1]!)!, bounds.get(list[i]!)!)) return true
    return false
  }
  let items = source
  if (items.length < 3 || !hasOverlap(items)) return
  const reduce = (list: SceneItem[]): SceneItem[] => {
    if (method === 'greedy') {
      let a: SceneItem | undefined
      return list.filter((b, i) => {
        if (!i || !intersects(bounds.get(a!)!, bounds.get(b)!)) { a = b; return true }
        b.opacity = 0
        return false
      })
    }
    return list.filter((it, i) => (i % 2 ? ((it.opacity = 0), false) : true))
  }
  do { items = reduce(items) } while (items.length >= 3 && hasOverlap(items))
  const last = source[source.length - 1]!
  if (items.length < 3 && !last.opacity) {
    if (items.length > 1) items[items.length - 1]!.opacity = 0
    last.opacity = 1
  }
}

type GuideEncodeSet = Record<string, EncodeValue | EncodeValue[]>

/** A guide element's encode as vega applies it to a static render: `enter`, then `update` over it. */
function guideEncodeSet(block: GuideEncodeBlock | undefined): GuideEncodeSet | undefined {
  if (!block) return undefined
  const merged = { ...(block.enter ?? {}), ...(block.update ?? {}) }
  return Object.keys(merged).length ? merged : undefined
}

/**
 * Apply a guide element's user `encode` (vega axis / legend `encode.<element>`)
 * to one generated item, evaluated against that element's datum (a tick
 * `{index, tickIndex, value, label}`, or the guide's own datum). It runs where
 * vega's does, after the generated encode and before the layout measures the
 * mark, so a changed `fontSize`, `angle`, `text` or `x` moves the axis extent
 * and the title. Positions are in the guide group's frame: `origin` is where our
 * leaves put that frame (for an axis: its position plus the crisp 0.5 delta).
 */
function applyGuideEncode(item: SceneItem, set: GuideEncodeSet | undefined, datum: Row, ctx: EvalContext, origin: { x: number; y: number }): void {
  if (!set) return
  const rec = item as Record<string, unknown>
  for (const [key, spec] of Object.entries(set)) {
    const v = resolveEncodeProperty(spec, datum, ctx)
    if (v === undefined) continue
    if (key === 'x' || key === 'x2') rec[key] = Number(v) + origin.x
    else if (key === 'y' || key === 'y2') rec[key] = Number(v) + origin.y
    else rec[key] = v
  }
}

/** The view's width / height SIGNAL (what a nested group's axes grid to); the context size at the view level. */
function viewSignal(ctx: EvalContext, name: 'width' | 'height'): number {
  const v = ctx.signalParams[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : ctx[name]
}

/** The axis-level layout parameters vega's axis encode feeds the layout (`encode.axis`: offset, position, translate, titlePadding, minExtent, maxExtent, range). */
const AXIS_GROUP_ENCODE_KEYS = ['offset', 'position', 'translate', 'titlePadding', 'minExtent', 'maxExtent', 'range'] as const

function buildAxis(axis0: CompiledAxis, ctx: EvalContext): SceneGroup | null {
  const scale = ctx.scales.get(axis0.scale)
  if (!scale) return null
  // vega-parser axis.js: the layout reads these off the axis group item, so a user `encode.axis`
  // that sets them wins over the spec / config value.
  const axisGroupEncode = guideEncodeSet(axis0.encode?.axis)
  let axis = axis0
  if (axisGroupEncode) {
    const axisDatum: Row = { scale: axis0.scale, ticks: axis0.ticks !== false, labels: axis0.labels !== false, grid: !!axis0.grid, domain: axis0.domain !== false, title: axis0.title != null }
    const over: Record<string, unknown> = {}
    for (const key of AXIS_GROUP_ENCODE_KEYS) {
      if (!(key in axisGroupEncode)) continue
      const v = resolveEncodeProperty(axisGroupEncode[key], axisDatum, ctx)
      if (v !== undefined) over[key] = v
    }
    if (Object.keys(over).length) axis = { ...axis0, ...over } as CompiledAxis
  }
  const encGrid = guideEncodeSet(axis.encode?.grid)
  const encTicks = guideEncodeSet(axis.encode?.ticks)
  const encLabels = guideEncodeSet(axis.encode?.labels)
  const encDomain = guideEncodeSet(axis.encode?.domain)
  const encTitle = guideEncodeSet(axis.encode?.title)
  const guideDatum: Row = { scale: axis.scale, ticks: axis.ticks !== false, labels: axis.labels !== false, grid: !!axis.grid, domain: axis.domain !== false, title: axis.title != null }
  const orient = axis.orient
  // where the axis group's origin lies in our leaves' frame (the view edge it sits on)
  const guideOrigin = { x: (orient === 'right' ? ctx.width : 0) + 0.5, y: (orient === 'bottom' ? ctx.height : 0) + 0.5 }
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

  // The approximate tick count used for label formatting. When the axis omits
  // tickCount, vega's axis ticks operator defaults to 10 (see vega-encode
  // AxisTicks: `_.count == null ? 10 : _.count`); matching that matters for
  // log-scale labels, whose formatter only labels a subset of ticks depending
  // on the count.
  const count = (typeof axis.tickCount === "number") ? axis.tickCount : (axis.tickCount && typeof axis.tickCount === "object" && axis.tickCount.signal) ? (ctx.runtime.expr(axis.tickCount.signal)({}, ctx.signalParams) as number) || 10 : 10
  const labelFormat = axisLabelFormat(axis, scale, count, ctx)
  // vega-encode AxisTicks tuples, the datum a tick / label / grid encode reads:
  // `{index (fraction 0..1), tickIndex, value, label}`; the `extra` entry is
  // `{index: -1, tickIndex: -1, extra: {value}, label: ''}`.
  const labelCache: string[] = []
  const tickDatum = (te: { value: unknown; extra: boolean }, i: number): Row => {
    if (te.extra) return { index: -1, tickIndex: -1, extra: { value: te.value }, label: '' }
    return {
      index: i / ((ticks.length - 1) || 1),
      tickIndex: i,
      value: te.value,
      label: (labelCache[i] ??= String(labelFormat(te.value))),
    }
  }

  if (axis.grid) {
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
        // vega-parser axis-grid: the cross-axis length is the VIEW's `height` / `width`
        // signal, not the enclosing group's size (a nested group's axes still draw a
        // grid as long as the whole view)
        : frac * (isXAxis ? viewSignal(ctx, 'height') : viewSignal(ctx, 'width')) * gridSign
      return v
    }
    // a non-numeric gridScale range (a band scale given a named colour range) has no
    // start (vega draws the grid from the axis, +0.5) but its end stays NaN
    const gridStartRaw = gridSpan(0)
    const gridStart = Number.isFinite(gridStartRaw) ? gridStartRaw : 0
    const gridEnd = gridSpan(1)
    const gridOrigin = orient === 'right' ? ctx.width : orient === 'bottom' ? ctx.height : 0
    for (const [ti, te] of tickEntries.entries()) {
      const v = pos(te.value, te.extra)
      const item: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (isXAxis) {
        item.x = v + 0.5; item.x2 = v + 0.5
        item.y = gridOrigin + gridStart + 0.5; item.y2 = gridOrigin + gridEnd + 0.5
      } else {
        item.y = v + 0.5; item.y2 = v + 0.5
        item.x = gridOrigin + gridStart + 0.5; item.x2 = gridOrigin + gridEnd + 0.5
      }
      item.stroke = (axis as { gridColor?: string }).gridColor ?? '#ddd'
      item.strokeWidth = (axis as { gridWidth?: number }).gridWidth ?? 1
      const gridDash = (axis as { gridDash?: number[] }).gridDash
      if (gridDash != null) item.strokeDash = gridDash
      // vega axis-grid: strokeCap/strokeDashOffset/strokeOpacity come from gridCap/gridDashOffset/gridOpacity
      if (axis.gridCap != null) item.strokeCap = axis.gridCap
      if (axis.gridDashOffset != null) item.strokeDashOffset = axis.gridDashOffset
      if (axis.gridOpacity != null) item.strokeOpacity = axis.gridOpacity
      applyGuideEncode(item, encGrid, tickDatum(te, ti), ctx, guideOrigin)
      // Vega's axisLayout bounds union only the ticks and labels marks; the
      // grid mark never extends the axis bound (nor the view bounds).
      ;(item as Record<string, unknown>)._grid = true
      items.push(item)
    }
  }

  // ticks:false hides the marks AND zeroes the effective tick size: vega's
  // axisLabels/titles position off the tickSize signal, which the axis
  // encode sets to 0 when ticks are off.
  const tickSize = axis.ticks === false ? 0 : (axis.tickSize ?? 5)
  const labelPadding = axis.labelPadding ?? 2
  const tickItems: SceneItem[] = []
  const labels: SceneItem[] = []

  for (const [ti, te] of tickEntries.entries()) {
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
      // vega axis-ticks: strokeCap/strokeDashOffset/strokeOpacity
      if (axis.tickCap != null) tick.strokeCap = axis.tickCap
      if (axis.tickDashOffset != null) tick.strokeDashOffset = axis.tickDashOffset
      if (axis.tickOpacity != null) tick.strokeOpacity = axis.tickOpacity
      applyGuideEncode(tick, encTicks, tickDatum(te, ti), ctx, guideOrigin)
      tickItems.push(tick)
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
      if (axis.labelFontStyle != null) label.fontStyle = axis.labelFontStyle
      if (axis.labelFontWeight != null) label.fontWeight = axis.labelFontWeight
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
      applyGuideEncode(label, encLabels, tickDatum(te, ti), ctx, guideOrigin)
      labels.push(label)
    }
  }

  // Vega's axis `labelOverlap` runs the Overlap transform over the label items
  // (see applyOverlap): colliding labels are hidden with opacity 0 and stay in
  // the scene. The axis `extra` entry has no content (zero bounds) and is
  // skipped by the transform's own `hasBounds` filter.
  if (axis.labelOverlap) {
    applyOverlap(labels, axis.labelOverlap, (axis as { labelSeparation?: number }).labelSeparation ?? 0)
  }

  // vega's axis mark order: grid, ticks, labels, domain, title (every tick
  // before any label, not interleaved per tick).
  pushAll(items, tickItems)
  pushAll(items, labels)

  if (axis.domain !== false) {
    const domainLine: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
    // Compute the scale range extent for the axis domain line.
    // For non-band scales, the range values determine the axis extent.
    const scaleRange = scale.range() as number[]
    const rangeStart: number = scaleRange.length > 0 ? Number(scaleRange[0]) || 0 : 0
    // the far end stays NaN when the range is not numeric (a band scale given a named colour
    // range): vega draws that domain rule to x2=NaN, only the start folds to 0
    const rangeEnd: number = scaleRange.length > 0 ? Number(scaleRange[scaleRange.length - 1]) : 0
    // vega axis-domain: the rule runs from range(0) to range(1) of the scale —
    // NOT min to max — so a reversed range (every y axis) starts at the far end
    // (it decides where a dash pattern begins).
    const axisStart = rangeStart
    const axisEnd = rangeEnd
    if (orient === 'left') { domainLine.x = 0.5; domainLine.x2 = 0.5; domainLine.y = axisStart + 0.5; domainLine.y2 = axisEnd + 0.5 }
    else if (orient === 'right') { domainLine.x = ctx.width + 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = axisStart + 0.5; domainLine.y2 = axisEnd + 0.5 }
    else if (orient === 'bottom') { domainLine.x = axisStart + 0.5; domainLine.x2 = axisEnd + 0.5; domainLine.y = ctx.height + 0.5; domainLine.y2 = ctx.height + 0.5 }
    else { domainLine.x = axisStart + 0.5; domainLine.x2 = axisEnd + 0.5; domainLine.y = 0.5; domainLine.y2 = 0.5 }
    domainLine.stroke = axis.domainColor ?? '#888'
    domainLine.strokeWidth = axis.domainWidth ?? 1
    if (axis.domainDash) domainLine.strokeDash = axis.domainDash
    if (axis.domainOpacity != null) domainLine.strokeOpacity = axis.domainOpacity
    if (axis.domainCap != null) domainLine.strokeCap = axis.domainCap
    if (axis.domainDashOffset != null) domainLine.strokeDashOffset = axis.domainDashOffset
    applyGuideEncode(domainLine, encDomain, guideDatum, ctx, guideOrigin)
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
    if (axis.titleFontStyle != null) t.fontStyle = axis.titleFontStyle
    if ((axis as { titleLimit?: number }).titleLimit != null) {
      t.limit = (axis as { titleLimit?: number }).titleLimit
    }
    ;(t as Record<string, unknown>).fontWeight = titleWeight
    if (titleOpacity != null) t.fillOpacity = titleOpacity
    t.fill = titleColor ?? '#000'
    applyGuideEncode(t, encTitle, guideDatum, ctx, guideOrigin)
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
  // vega's grid rules cancel the axis `offset` on their cross-axis span
  // (axis-grid.js: gridStart/gridEnd carry `offset: sign * offset`), so the grid
  // stays on the plot area while the rest of the axis moves out.
  // The grid cancels the axis's OWN offset (`spec.offset`), not a config-merged one.
  const specOff = typeof axis.own?.offset === 'number' ? axis.own.offset : 0
  const cancelSign = orient === 'left' || orient === 'top' ? 1 : -1
  const gridCross = tr + cancelSign * (specOff - off)
  const gridDxs = ctx.rawGuides ? dxs : (orient === 'left' || orient === 'right' ? gridCross : dxs)
  const gridDys = ctx.rawGuides ? dys : (orient === 'bottom' || orient === 'top' ? gridCross : dys)
  if (dxs || dys || gridDxs || gridDys) {
    for (const it of items) {
      const rec = it as Record<string, unknown>
      const grid = rec._grid === true
      const sx = grid ? gridDxs : dxs
      const sy = grid ? gridDys : dys
      if (rec.x != null) rec.x = (rec.x as number) + sx
      if (rec.y != null) rec.y = (rec.y as number) + sy
      if (rec.x2 != null) rec.x2 = (rec.x2 as number) + sx
      if (rec.y2 != null) rec.y2 = (rec.y2 as number) + sy
    }
  }

  // vega axis encode: `range: abs(span(range(scale)))` — the spine extent
  const sr = scale.range() as number[]
  const axisRangeSpan = typeof (axis as { range?: unknown }).range === 'number'
    ? (axis as unknown as { range: number }).range
    : sr.length > 1 ? Math.abs(Number(sr[sr.length - 1]) - Number(sr[0])) : 0

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

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number, ctx?: EvalContext): (v: unknown) => string {
  // (vega has no axis `labelExpr`: vega-lite compiles it to `encode.labels.update.text`,
  // which is applied to the label items themselves - see applyGuideEncode - so a raw
  // `labelExpr` is ignored here exactly as vega ignores it)
  const fmtType = axis.formatType ? axis.formatType : undefined
  // Resolve format: may be a string or a signal expression.
  let fmt: string | undefined
  const rawFmt = axis.format ?? undefined
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
  const calendar = calendarOf(scale.type, fmtType)
  if (calendar) {
    const L = locale(undefined)
    // With no explicit format vega uses the time multi-format, which picks a
    // specifier per tick interval (e.g. '%B' for month ticks, '%b %d' for
    // day/week ticks). The `undefined` argument is passed explicitly to satisfy
    // the strict local type shim for vega-format.
    const timeFormatter = calendar === 'utc' ? L.utcFormat : L.timeFormat
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
