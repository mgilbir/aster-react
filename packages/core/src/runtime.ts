/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Each call evaluates eagerly from the inputs it is
 * given. The chart also keeps a committed `IncrementalState` (see below), so a
 * later call with `dataChanges`, `dataPulse` or `changedDatasets` reuses the
 * transform steps, scales and mark items that cannot have changed; the result is
 * the scene a fresh evaluation would produce.
 */
import { entryText } from './spec-expressions.js'
import { compileExpr, engineParams, evalSignal, expressionRegistryEpoch, ExpressionParseError, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { scaleCallFailure, scaleRangeFailure } from './missing-scale.js'
import { ingestRows, isNotATupleError, notATuple, readData, type DataFormatSpec } from './data-format.js'
import { followsSources, numbersSourceRows, orderOf, setOrder, setSources, sourcesAfter, sourcesOf } from './tuple-order.js'
import { alignIndices, carryByAlignment, carryBySources, sourceNumbersOf, type IdCounter, type SourceNumbers } from './identifier-ids.js'
import { applyTransforms, applyTransformsToSharedRows, copiesRows, rowUseOf, sortOrder, getField, type Row, type TransformContext } from './transform.js'
import { fieldOf, flatKeyFn, groupKeyFn } from './row-keys.js'
import { atRandomSite, contentKey, mayDrawRandom, normalPairs, replayable } from './random-tape.js'
import { autosizeOf as autosizeValueOf, paddingOf, type Autosize, type AutosizeType, type Padding } from './view-props.js'
import { lexedText } from './expr-text.js'
import { isEngineNode, noteEngineScene } from './scene-registry.js'
import { parseExpressionCached, type Expr } from './expr-parser.js'
import { datasetsReadIn, identifiersIn, scalesReadIn, dependencyKey, fieldsWritten, namesIn, pipelineReadsOf, reuse, runsOf, stepCounts, stepReadsOf, type StepReads, type StepRecord } from './step-reuse.js'
import { activeMeter, withLimits, allot, copiedRows, checkItemCount, checkRowCount, checkChartRegex, meterTick, AsterLimitError } from './limits.js'
import { collectMeasureFailures, getTextMetricsProvider, withTextMetricsProvider } from './text-metrics.js'
import { bindSceneTextMetrics } from './scene-output.js'
import { AsterUrlError } from './url-policy.js'
import { SpecParseError } from './parse-error.js'
import { follow, node as signalNode, Propagation, type SignalNode } from './signal-propagation.js'
import { loggerOf, type Logger } from './logger.js'
import { buildScale, sameSettings, scaleOfSettings, scaleSettings, scaleTicks, type Scale, type Settings, fieldDomainKind, type ScaleContext } from './scales.js'
import { sortReadsCategoriesOnly } from './scale-domain.js'
import { implicit as implicitCategory } from './scale-discrete.js'

/** Scale types whose domain is an ordered set of discrete values. */
import { ITEM_MARK, geoRegistry, requireGeo } from './registry.js'
import { chartLocale, formatEnvironmentKey, type Locale } from './locale.js'
import { adjustSpatial, ENTER_COPY, spatialProgramFor, type SpatialProgram } from './spatial.js'
import { objectProperty } from './object-property.js'
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
  VgSpec,
} from './types.js'
import { gradientDefOf, hash53, isGradientPaint } from './svg-defs.js'
import { tickFormat, scaleGradient, scaleGradientStops, tickCount, validTicks } from './scale.js'
import { compileChart } from './compiler.js'
import { splitAccessPath, copyTuple, withTupleOrigins, dict, ownGet, pushAll, sortData, lerp, scopedSignalName, heldSignalName, isTuple, markTuple, markTuples, markTupleAlways, withTuples, tuplesRegistering, PRIMITIVE_TUPLE, tupleDatum } from './util.js'
import { applyImageUrlPolicy, applyLinkUrlPolicy, bindSceneUrlPolicy, resolveImageUrl, type ImageUrlPolicy } from './url-policy.js'
import { checkChartUrlData } from './url-data.js'
import { publishRows, valueKey, valuesEqual } from './fingerprint.js'
import { beginWrite, endWrite, historical, idOf, keepHistory, pin, pinAll, samePin, samePins, stampKey, wrote, type History, type Pin } from './content-stamp.js'
import { dataWithoutRows, valuesSignal } from './spec-structure.js'
import { diffRows, equalCell, pulseChangeOf, rowsEqual, sourceNames, type PulseChange } from './pulse.js'
import type { aggregateGroups } from './transform-agg.js'
import type { GridPlace } from './trellis.js'
import { boundAxisGroup, boundGroupItem, boundTypedMark, Bounds, groupLayoutBounds, layoutBounds, eachMarkBounds, hasClippedMark } from './bounds.js'
import { rectItemPath } from './render.js'
import { boundFailure } from './bound-failure.js'
import { buildAxis as buildAxisGuide, tickPlacement } from './guide-axis.js'
import { buildTitle as buildTitleGuide } from './guide-title.js'
import type { GuideHost, Sides } from './guide-legend.js'
import { LEGEND_SCALES } from './legend-scales.js'
import { part, requestPart } from './engine-parts.js'
import { guideReading, type GuideKind } from './guide-model.js'
import { ExpressionFailure, isSignal, isUnencoded, itemAriaOf, propsOf, type GuideStyles, type UserEncode } from './guide-encode.js'
import { entryReadsItem } from './expr-reads.js'
import { encodeLogOf, hasNamedSetsIn, keptItems, namedSetsOf, stampEncodeIdent, stampEncodeSets, type EncodeLog } from './encode-handlers.js'
import { defaultMergedConfig } from './config-defaults.js'

// The legend builder and the grid layout are parts the React shells load on demand (engine-parts.ts): read from their slots when a
// spec has a legend or a layout, which every entry that evaluates fills.
const buildLegendGuide: typeof import('./guide-legend.js').buildLegend = (inp) => part('legend').buildLegend(inp)
const entriesRefusal: typeof import('./guide-legend.js').entriesRefusal = (p) => part('legend').entriesRefusal(p)
const legendType: typeof import('./guide-legend.js').legendType = (spec, scaleType) => part('legend').legendType(spec, scaleType)
const placeLegendStack: typeof import('./guide-legend.js').placeLegendStack = (...args) => part('legend').placeLegendStack(...args)
const layoutFacet: typeof import('./trellis.js').layoutFacet = (...args) => part('layout').layoutFacet(...args)

const DEFAULT_SIZE = 500

/**
 * A dataset-level pulse: the new output indices whose rows changed, plus the
 * index mapping for length-changing updates. `from` is absent for same-length
 * updates (identity mapping).
 */
export interface StepPulse extends PulseChange {
  /** True when the transform chain could not publish a trustworthy mapping. */
  full?: boolean
}

/**
 * Per-dataset incremental state: the pipeline's step outputs and per-step
 * auxiliary indexes (filter pass flags, group membership, flatten offsets,
 * collect order), plus the params it was derived under.
 */
export interface DatasetState {
  /** Fingerprint (signals/size/domainRaw/metrics) the pipeline ran under. */
  fp: string
  /** Row count of the pipeline INPUT, to validate a published pulse against. */
  inputLength: number
  /** `steps[k]` = output of transform k. */
  steps: Row[][]
  /** Per-step state, keyed `${dataset}#${k}`. */
  stepState: Map<string, unknown>
  /**
   * What the pipeline was made from (the rows the host gave, or the rows of each source dataset), and what each step read when it
   * ran: a later evaluation that finds the same inputs keeps the steps whose reads are as they were (see step-reuse.ts). Absent
   * when the pipeline's input is not one that can be recognised.
   */
  inputs?: readonly Pin[]
  records?: ReadonlyArray<StepRecord | undefined>
  /** `stepPins[k]`: the rows of step k as the run left them (see `keptSteps`: a later step was made from these rows). */
  stepPins?: readonly Pin[]
  /**
   * `aliased[k]`: the fields that the rows of `steps[k]` may hold beyond what step `k` made of them. Steps that only add fields run
   * as one over one set of rows (see runsOf), and the rows the first steps of such a run stand for are the rows the last made, which
   * hold the fields of the steps after them too. A step compared with such rows leaves those fields out.
   */
  aliased?: Array<ReadonlySet<string> | undefined>
  /**
   * What the pipeline read when it was made (see `pipelineKey`): a later evaluation runs a pulse through these steps when it reads
   * the same, whichever other signals changed. Absent when a step's reads are not known.
   */
  key?: string
  /** The build of the dataset in this pass (see `keptBuild`): a later round of the pass, over the same inputs and reads, keeps it. */
  built?: BuiltDataset
  /** Where the view's id counter stood when this build of the dataset began (see `carriedFrom`). */
  idsStart?: number
  /**
   * `published[k]`: the value of the signal step `k` publishes (an `extent`, a `bin`) as the step left it, boxed (absent when the
   * step publishes none or left it unwritten). A pulse compares it with the value the step publishes now (see `applyPipelineWithPulse`).
   */
  published?: Array<readonly [unknown] | undefined>
}

/**
 * One build of a dataset with transforms, in one pass of an evaluation. A pass builds its datasets again once the signals they read
 * resolve (see `prepareChartCtx`), and a view that fits its viewport makes a second pass at another size: a dataset whose inputs
 * are the same arrays and whose steps read the same is the dataset the round, or the pass, before built -- its rows, the numbers its
 * `identifier`s drew (a later pass carries the numbers of the one before) and the signals its steps published.
 */
interface BuiltDataset {
  /** The draft of the pass that made it (a state kept from an evaluation before never matches). */
  pass: IncrementalState
  inputs: readonly Pin[]
  key: string
  rows: Row[]
  /** The pulse it published, and the state of the evaluation before it is relative to (the rows that state's items were made from). */
  pulse: StepPulse | null
  base: DatasetState | undefined
  /** Where the view's id counter stood before and after the pipeline ran. */
  ids: readonly [number, number]
  /** The signals its steps publish, as they stood after it ran (those it left unwritten are absent). */
  published: ReadonlyArray<readonly [string, unknown]>
}

/** Min/max census of a continuous data-driven scale domain. */
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

/**
 * Category census of a discrete data-driven scale domain whose sort reads the categories alone (`sortReadsCategoriesOnly`): the
 * domain is fixed by which categories there are, the order of their first rows and the value of each first row.
 */
interface DiscCensus {
  data: string
  field: string
  /** The value of the field for every row of the dataset, by index. */
  vals: unknown[]
  /** The index of the first row of each category, by its text (the domain tells categories apart by their text). */
  first: Map<string, number>
}

interface ScaleEntry {
  scale: Scale
  /** The domain spans several datasets (`domain.fields`); never census-reused. */
  multi: boolean
  cont?: ContCensus
  disc?: DiscCensus
  /** What the scale was made under besides its data (see `scaleKeyOf`): a later evaluation under the same key may keep it. */
  key?: string
  /**
   * What the scale was made from (`scaleSettings`): a later evaluation under the same key whose settings are the same keeps the
   * scale (see `buildScales`). Absent when the scale was not made from settings this evaluation can compare.
   */
  settings?: Settings
}

/**
 * Everything the incremental path remembers about the previous evaluation of
 * one compiled chart. The compiled IR is immutable; this object is the
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
 *
 * A view that fits its viewport makes two passes (see evaluateChartImpl): the first at the viewport, the second at the fitted size.
 * The committed state is the second's, and it carries the first's (`fitFirst`), so each pass of the next evaluation reuses what the
 * same pass made before (the same size, usually): the first pass is made from `fitFirst`, the second from the committed state.
 */
interface IncrementalState {
  /** Evaluation counter; reused items keep the generation they were encoded in. */
  gen: number
  /**
   * The padding and autosize the view's signals gave this evaluation, when one of them reads data or a scale (see
   * `evaluateChartPass`): the next evaluation lays its view out with them first.
   */
  viewLayout?: ViewLayout
  /**
   * What the first pass of a view that fits its viewport left, when this state is the second's: the next evaluation's first pass is
   * made from it. Absent when the evaluation made one pass, or when its first pass failed (it is then made from this state, as before).
   */
  fitFirst?: IncrementalState
  /** Fingerprint of the final evaluation context (signals, size, overrides). */
  fp: string
  /** The final top-level scales of the evaluation. */
  scales: Map<string, Scale>
  scaleEntries: Map<string, ScaleEntry>
  datasets: Map<string, DatasetState>
  /** Top-level mark groups, keyed by compiled-mark identity. */
  groups: Map<CompiledMark, SceneGroup>
  /** What each top-level leaf mark was made under besides its data and scales (see `markKeyOf`), keyed like `groups`. */
  markKeys: Map<CompiledMark, string>
  /**
   * The view's datasets as the evaluation left them, by name (the arrays themselves): the rows its scales and marks read. A later
   * evaluation that finds the same array, which no change it was told of touched, reads the same rows (see `sameRows`).
   */
  rows: Map<string, Pin<Row[]>>
  /** The arrays the host gave the datasets (see `hostPulse`: a pulse is taken relative to these). */
  hostRows: Map<string, readonly unknown[]>
  /**
   * What stands for this state in the scene it made (`SCENE_STATES`): a caller that hands that scene back as `previousScene` says its
   * hints are relative to the rows this state was given.
   */
  token: object
  /** True once a fast path updated a structure in place (see above). */
  stale: boolean
  /** Where the view's id counter stood (see identifier-ids.ts): the next evaluation numbers new rows from here. */
  idCounter: number
  /** The datasets of group scopes, by instance and name: what the pipeline read and made (see `runScopedData` below). */
  scoped: Map<string, ScopedRun>
  /** The copies a dataset with no transforms made of the rows it was given, and what it was given (see `keptCopy`). */
  copies: Map<string, { inputs: readonly Pin[]; rows: Row[] }>
  /** The items of each mark (by instance) whose transforms number them: the numbers an item keeps (see `transformMarkItems`). */
  numbered: Map<string, readonly SceneItem[]>
  /** The leaf marks made inside group items, by instance (see `evaluateInstanceMark`): what a later evaluation keeps or splices. */
  instances: Map<string, InstanceMark>
  /** Top-level group marks made whole in a clean pass, and what making them left in the evaluation (see `keptGroupMark`). */
  groupMarks: Map<CompiledMark, GroupMarkRecord>
  /** What each channel of a top-level leaf mark was encoded under, and over which rows (see `reencodeChannels`). */
  channels: Map<CompiledMark, ChannelRecord>
  /** A top-level leaf mark drawn from another mark's items: what it was made under and the items it was made from (see `keptOverMarkItems`). */
  markSources: Map<CompiledMark, { key: string; items: readonly SceneItem[]; tuples: boolean }>
  /** The view's own axes and legends as a clean pass made them, by definition, with what they were made under (see `keptGuide`). */
  guides: Map<object, Map<string, GuideRecord>>
  /** The snapshots of the view's scales the scene carries, and the scales they were taken of (see `sceneSnapshots`). */
  snapshots?: { scales: ReadonlyArray<readonly [string, unknown]>; snaps: ReturnType<typeof snapshotScales> }
  /** The content of the view this state's pass made (its root items, laid out): a later pass shares what it makes the same (see `shareScene`). */
  content?: readonly SceneGroup[]
}

/** A leaf mark made inside a group item, and what it was made from (see `evaluateInstanceMark`). */
interface InstanceMark {
  group: SceneGroup
  /** its items in the order of its rows (a sorted mark's `items` are in its sort's order) */
  rowItems: SceneItem[]
  /** `markKeyOf` in the item's scope */
  key: string
  /** the group item it is in: its box, its datum, its `parent` and what its encode gave it */
  item: Record<string, unknown>
  /** the scales it read and the other datasets it read, as they were */
  scales: Array<readonly [string, unknown]>
  deps: Array<readonly [string, Pin]>
}

/** One run of a group scope's dataset pipeline: the source arrays it read, what its transforms mentioned, and the rows it made. */
interface ScopedRun {
  inputs: readonly Pin[]
  keys: readonly string[]
  out: Row[]
}

function newState(gen: number): IncrementalState {
  return { gen, fp: '', scales: new Map(), scaleEntries: new Map(), datasets: new Map(), groups: new Map(), markKeys: new Map(), rows: new Map(), hostRows: new Map(), token: {}, stale: false, idCounter: 0, scoped: new Map(), numbered: new Map(), copies: new Map(), instances: new Map(), groupMarks: new Map(), channels: new Map(), markSources: new Map(), guides: new Map() }
}

/** A top-level leaf mark's items as an encode made them: the encode, the rows, the items in row order and each channel's key. */
interface ChannelRecord {
  encode: object
  rows: Pin<readonly Row[]>
  items: readonly SceneItem[]
  /** per channel of `encode` (its own keys, in order): what it is evaluated under besides the row (`channelKeyOf`), null when that is unknown */
  keys: Array<string | null>
}

/**
 * A top-level group mark as a clean pass made it, with everything making it wrote into the evaluation besides its items, so that a
 * later evaluation that keeps the items can leave the evaluation as making them would have (see `keptGroupMark`).
 */
interface GroupMarkRecord {
  /** `markKeyOf` the group mark (every signal its subtree names, the view size, `extraFp`, the registry), as it was made */
  key: string
  /** its group items, in the order they were returned */
  items: SceneGroup[]
  /** where the view scope's instance counter stood before the mark, and how far making it moved it */
  instanceFrom: number
  instances: number
  /** the last instance with content below it (`noteInstance`), when it made one */
  last?: number[]
  /** every list of gradient definitions it registered, in order (`addDefs` dedupes) */
  defs: SceneDef[][]
  /** what it named among the marks (`markItems`, `markContainers`): the group mark itself and the named marks inside it */
  named: Array<[string, SceneItem[], { marktype: string; items: SceneItem[] } | undefined]>
  /** the keys it added to the state's maps of group scopes (`scoped`, `numbered`, `instances`) */
  keys: { scoped: string[]; numbered: string[]; instances: string[] }
  /** whether the tuples it made were registered (`isTuple`) */
  tuples: boolean
}

/** Committed state per compiled chart. Never stored on the IR itself. */
const STATES = new WeakMap<CompiledChart, IncrementalState>()
/** The token of the state each committed evaluation's scene was made with (see `hintBases`). */
const SCENE_STATES = new WeakMap<SceneRoot, object>()
/** No arrays: the hints of a caller whose previous scene is not the chart's committed state are relative to none of its rows. */
const NO_BASES: ReadonlyMap<string, unknown> = new Map()

/**
 * The arrays the hints of `evaluateChart`'s caller are relative to, when it says so by handing back the scene it was given last
 * (`input.previousScene`): the rows the chart's committed state was made from when that scene is the state's (the caller made the
 * last evaluation, so its rows are the state's), else none -- another caller evaluated the chart since (DECISIONS Q16), or the scene
 * is no committed evaluation of this chart, and every hinted dataset is derived in full. One identity comparison, whatever the rows.
 */
function hintBases(chart: CompiledChart, input: RuntimeInput): ReadonlyMap<string, unknown> | undefined {
  const scene = input.previousScene
  if (scene === undefined) return undefined
  const committed = STATES.get(chart)
  return committed !== undefined && (scene !== null && typeof scene === 'object') && SCENE_STATES.get(scene) === committed.token ? committed.hostRows : NO_BASES
}

/** One evaluation's view of the committed state (shared across fit-loop passes). */
interface EvalTxn {
  /** The committed state: what the evaluation reuses (the second pass of a fit view's), and where the view's id counter stands. */
  prev: IncrementalState | undefined
  /** The committed state's `fitFirst`, when it can be reused: what the first pass of a view that fits its viewport reuses. */
  firstPrev?: IncrementalState
  gen: number
  /**
   * The structures this evaluation already updated in place, by identity (a dataset's state, its steps and their state, a census):
   * not reusable again, from whichever state holds them.
   */
  claimed: WeakSet<object>
  /**
   * The host datasets whose rows are those the committed state was made from, by the array the host gave then (see
   * {@link DataStability}): the steps made from them need not run again.
   */
  unchanged?: DataStability
  /** The arrays the caller's pulses are relative to (see `hostPulse`). */
  pulseBases?: ReadonlyMap<string, unknown>
  /** What the pass of this evaluation before the one being made left (a view that fits its viewport makes two passes). */
  lastPass?: IncrementalState
  /** The incremental engine, when the evaluation keeps state for a later one (see {@link IncrementalEngine}). */
  engine?: IncrementalEngine
}

/**
 * The part of the dataset pipeline that only a RE-evaluation needs: running a transform chain from a pulse, and leaving behind the
 * state (filter flags, group membership, flatten offsets, collect order) the next pulse starts from. It lives in
 * `incremental-engine.ts`, and an evaluation that keeps its state (`evaluateChartPending`) is handed it by its caller (the public
 * `evaluateChart`, the chart session), so a chart that is evaluated once (`renderSpec`, `evaluateOnce`) does not carry it: no module
 * of that path imports it.
 */
export interface IncrementalEngine {
  /**
   * A transform chain driven by `input`, reading the committed steps `prevDS` and recording this evaluation's into `state`. The pulse
   * path: absent while it is not loaded (the React shells load it once a chart's data changes; see engine-parts.ts), and then a
   * dataset that could have taken a pulse is derived in full, which makes the same rows and leaves the same state.
   */
  applyPipelineWithPulse?(
    rows: Row[], transforms: CompiledTransform[], tctx: StepTransformContext, sourceName: string,
    input: StepPulse, prevDS: DatasetState, state: DatasetState,
  ): { rows: Row[]; pulse: StepPulse | null }
  /** One transform from scratch, leaving the state the next pulse starts from. */
  applyOneWithState(
    rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, previous?: Row[],
  ): { rows: Row[]; state?: unknown }
}

/**
 * Source dataset name -> the rows the previous evaluation was given for it, when this evaluation's are equal to them. Given at all
 * (even empty), it also says the caller tells every change of the rows it hands over: rows that changed come in a new array or with
 * a change description (the chart session's contract), so an array the evaluation was given before holds the rows it held then.
 */
export type DataStability = ReadonlyMap<string, unknown>

function beginTxn(engine: IncrementalEngine, chart: CompiledChart, unchanged?: DataStability): EvalTxn {
  // (an evaluation that keeps state without the engine would leave a state the next pulse cannot start from, and answer with
  // another evaluation: it does not run)
  if (typeof engine?.applyOneWithState !== 'function') throw new Error('[aster] an evaluation that keeps incremental state needs the incremental engine (incremental-engine.ts)')
  const committed = STATES.get(chart)
  const prev = committed && !committed.stale ? committed : undefined
  // (a claim flags the committed state stale as well as the state it was made in, so a committed state that is not stale carries a
  // first-pass state no evaluation has half-updated)
  const firstPrev = prev?.fitFirst
  return { prev, ...(firstPrev ? { firstPrev } : {}), gen: (committed?.gen ?? 0) + 1, claimed: new WeakSet(), engine, ...(unchanged ? { unchanged } : {}) }
}

/**
 * Fingerprint of everything that feeds expression evaluation and encoding
 * besides the data: the signal params (width/height included). Typed and
 * structural (fingerprint.ts), so a derived object-valued signal that is
 * re-created each round (`[0, width]`) hashes equal when unchanged.
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
/** The gradient definitions a leaf mark's items use, in item order: a group that is reused, or updated in part, brings them to the scene's defs. */
const GROUP_GRADIENTS = new WeakMap<SceneGroup, SceneDef[]>()

/**
 * Undo record for a mark whose items array was updated IN PLACE: the length it
 * had, and the items it overwrote.
 */
interface ItemsUndo { oldLen: number; idx: number[]; items: SceneItem[] }

/**
 * Persistent-scene sharing without mutating a returned scene.
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
  /** the index in the scope's `marks` of the mark being made (where an encode that fails stops the pass) */
  mark?: number
  /** the default tick counts (by gradient length) the scope's gradient legends have made so far: the first of each is a late operator */
  counts?: Set<string>
  /** the last instance in this scope's subtree (itself included) that has content of its own: a layout above it is ranked after it */
  last?: number[]
  /**
   * The instance by its marks and the keys of its group items, root first (a facet's partition key, a row's index, '' for the one item
   * of a group with no data): what names the same instance in another evaluation, where `path` counts instances in order.
   */
  keyPath?: string
}

/**
 * Where vega's dataflow pass stopped. A pass runs the operators in rank order and stops at the first one that throws: the error is
 * logged once, and what the operators before it made is all there is. The operators of one scope come in the order vega-parser
 * writes them (signals, projections, scales, axes, marks, legends, title); a group's own scopes are made one level after
 * the scope it is in, level by level (see `compareInstances`), whatever order the spec has them in.
 *
 * The first pass of a build records every failure with the instance (`path`) and the step of the scope it was at, and picks the
 * earliest; the second runs only up to it. Which failures there are, by step:
 */
interface AbortPoint {
  /** the instance of the scope the failing operator is in: the ordinals of the group items from the view down (the view is `[]`) */
  path: number[]
  /** the axis it is at (its ticks, when `inside` is not set: a failing axis is not made; else the axis part-made); `Infinity` for a later step */
  axis: number
  /** the legend it is at (as for `axis`) */
  legend?: number
  /** the pass failed in the encode of this mark of the instance (its `marks` index): the marks before it were made, the guides before it too */
  mark?: number
  /** the pass failed in a transform or the sort of the mark at `mark`, which run on its encoded items: after its encode */
  afterEncode?: true
  /** the pass failed in the title of the instance's group (the last operator of its scope) */
  title?: true
  /** the pass failed in the encode of the guide at this index: the guide is part-made (its ticks and entries were) */
  inside?: true
  /** the pass failed in the labels of the gradient legend at `legend`, an operator ranked after all the others of the scope */
  labels?: true
  late?: boolean
  /**
   * the failing encode (`mark`) reads a scale ranked late (see scaleIsLate): vega ranks it after every operator that reads no late
   * scale, so the guides over scales that are not late were made, and those over late scales (made after this mark's encode, as
   * the mark is declared before them) were not
   */
  lateScale?: true
  /** a projection of the instance's scope could not be made (nothing else of it was) */
  projection?: true
  /** a signal of the instance's scope threw (the first operators of the scope: nothing else of it was made) */
  signals?: true
  /** a scale of the instance's scope could not be made (the scales come before everything else of it but its signals and projections) */
  scales?: true
  /**
   * a dataset of the instance's scope could not take its rows (a `null` or `undefined` row of its inline values: vega reads the
   * tuple id inserting it): the datasets come after the scope's signals and projections, before its scales, so nothing else of it
   * was made
   */
  data?: true
  /** a signal of the view that reads data or a scale threw: it is ranked after every other operator of the view's scope (see `abortAtThrowingSignal`) */
  lateSignal?: true
  /**
   * The layout of a group mark (or of the view) threw (see `LayoutFailure`). Its operator is ranked after the last instance below
   * the mark's items that has content: the point is that instance, `late` (made whole), or, when none has any, the mark itself
   * (`mark`, after its encode).
   */
  layout?: LayoutFailure
  /** what the failing operator threw: logged once, for the point the pass stops at (see `buildContent`) */
  error?: unknown
}

/**
 * A layout that threw. vega lays the items of a group mark out one after the other, each its grid (cells, headers, footers, titles)
 * and then its guides: the items before the one that threw were laid out, that one only as far as its grid got, and the ones after
 * it not at all; neither was anything above the mark (the scopes it is in). Everything below the items was made, and laid out.
 */
interface LayoutFailure {
  /** the instances of the mark's items, in item order (the view's own layout: the view, `[]`) */
  items: number[][]
  /** the item whose layout threw */
  at: number
}

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
  /** Where a pass left the groups a grid layout placed, per layout (see `layoutFacet`): the next pass starts from them. */
  places: Map<string, GridPlace[]>
  /** What a legend was before its layout, per legend (see `LegendBuildInput.relayout`). */
  legends: Map<string, string>
  /** What a grid layout of a group was given, per layout (see `layoutWarn`). */
  inputs: Map<string, string>
}

/** The previous pass's record (undefined for the first) and the one this pass writes. */
interface PassMemory {
  prev: PassRecord | undefined
  cur: PassRecord
}

interface EvalContext {
  chart: CompiledChart
  /** The scenegraph item an encode's expressions see as `item` while it is encoded (see resolveEncodeSet), else undefined. */
  encodeItem?: object
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
  /**
   * The group item the marks being made are in (vega's `item.mark.group`): what its encode wrote and its `datum`, and the group item
   * it is in, up to the view's (`parent` undefined): what `{field: {group | parent, level}}` reads (see groupFieldValue). Undefined
   * for the view's marks, whose group item is the view's (`rootGroupItem`).
   */
  groupItem?: GroupLink
  datasets: Map<string, Row[]>
  /** The rows `setdata(name, tuples)` put in a dataset's input (see `ExpressionRuntime.setdata`), and whether they changed since the datasets were last built. */
  setData: SetDataState
  /** The guides are not laid out (the layout of their scope never ran, or stopped before them). */
  rawGuides?: boolean
  /** The guides are not laid out because the layout of their scope threw: what ranks before it (the grids of legend entries) ran. */
  layoutThrew?: true
  /** The guide host of this context (see guideHost). */
  guideHost?: { ctx: EvalContext; host: GuideHost }
  /** How many gradient definitions the evaluation was asked for so far (`addDefs`, a guide's gradient), shared with the contexts made from this one: see `keptGuide`. */
  defsAsked: { n: number }
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
  /**
   * whether a layout threw, and the warnings the layouts and scales of the pass gave (logged when the pass is the one kept); `warned`
   * holds the scales' already given, by scale, as a pass can make a scale more than once
   */
  layoutState: { failed: boolean; warnings: Array<string | readonly unknown[]>; warned?: Set<string> }
  /** Signals whose `init` expression has run (it runs once). */
  initDone: Set<string>
  /** The datasets and scales reached their fixed point: every `init` may run (see `initReady`). */
  initsSettled?: boolean
  /** A dataset's transform threw on a signal not settled yet (see `readsUnsettledSignal`): the rounds build the datasets again. */
  dataPending?: boolean
  /** What each signal's update read when it last ran in this pass (see `signalReadKey`): it runs again only when that changed. */
  signalRuns?: Map<string, string>
  /** Signals the host supplied for this evaluation (an `init` never overrides them). */
  hostSignals: Set<string>
  /** Hierarchy trees built by `stratify` transforms, keyed by data source name. */
  hierarchies: Map<string, unknown>
  /** Datasets affected by this update (changed datasets closed over source and transform dependencies). */
  affected: Set<string>
  /** True when the caller supplied change info AND a committed previous state exists. */
  incremental: boolean
  /** Present when this evaluation leaves its step state for a later one (see {@link IncrementalEngine}). */
  engine?: IncrementalEngine
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
  /**
   * The state of the previous evaluation this pass reuses (read-only but for what it claims; see IncrementalState): the committed
   * state, or for the first pass of a view that fits its viewport the committed state's `fitFirst`.
   */
  prev?: IncrementalState
  /** The committed state (`EvalTxn.prev`): a claim flags it stale too, whichever state this pass reuses. */
  committed?: IncrementalState
  /** The host datasets whose rows equal those `prev` was made from (see {@link DataStability}). */
  unchanged?: DataStability
  /** The arrays the caller's pulses are relative to (see `hostPulse`). */
  pulseBases?: ReadonlyMap<string, unknown>
  /** The state the pass before this one left (see `EvalTxn.lastPass`). */
  earlier?: IncrementalState
  /** The state this evaluation builds; committed by the caller on success. */
  draft: IncrementalState
  /** The view's id counter: where it stood when the evaluation began (`idStart`) and where it stands (see identifier-ids.ts). */
  ids: IdCounter
  idStart: number
  /** Evaluation generation (stamped on newly encoded items). */
  gen: number
  /** Structures already updated in place during this evaluation (`EvalTxn.claimed`). */
  claimed: WeakSet<object>
  /** Non-signal inputs that invalidate reuse (domainRaw, text metrics). */
  extraFp: string
  /** The re-encode requests of the signal handlers (`encode: <set>`) the host's signal store holds (encode-handlers.ts). */
  encodeLog?: EncodeLog
  /** Memo for ctxFpOf; cleared whenever signalParams may have changed. */
  fpMemo?: string
  /** Memo for readsKey, per list of names, over these signal params; cleared with `fpMemo`. */
  readsMemo?: { params: Record<string, unknown>; keys: Map<readonly string[], { width: number; height: number; key: string }>; values: Map<string, string> }
  /** Bumped by every dataset (re)build pass; part of the scale-reuse stamp. */
  dsEpoch: number
  /** Census-reuse decisions already taken this evaluation (a census is advanced once). */
  scaleReuse: Map<string, { stamp: string; entry: ScaleEntry; rows: readonly Pin[]; epoch: number }>
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
  /** a dataset re-ranked past the view's operators threw this round: the failure it recorded and what it replaced (see buildDatasetsOf) */
  lateData?: { entry: AbortPoint; before: LateTaint | undefined; postRunLost: boolean | undefined }
  /** a late signal of the view threw: what was ranked after it did not run (see `abortAtThrowingSignal`) */
  lateTaint?: LateTaint
  /** a dataset a `{signal}` values made holds primitive tuples (see PRIMITIVE_TUPLE): the marks join them as vega does */
  primitiveTuples?: boolean
  /** the encode of the mark being made did not run: its items are the join's, bare */
  bareEncode?: boolean
  /** the pass stopped before the root group's size was encoded (a signal threw): the frame is 0 x 0 */
  rootUnsized?: boolean
  /** The error each signal's expression threw the last time it was evaluated (a later evaluation that succeeds clears it). */
  signalErrors?: Map<string, unknown>
  /** The items of the named marks built so far (a mark may read another mark's items as its data: `from: {data: <mark name>}`). */
  markItems: Map<string, SceneItem[]>
  /** The container of each named mark built so far (its type and items; a group mark's are its group items): what a `label` transform avoids or labels. */
  markContainers: Map<string, { marktype: string; items: SceneItem[] }>
  /** While a top-level group mark is made: every list of gradient definitions registered, in order (see `GroupMarkRecord.defs`). */
  defsLog?: SceneDef[][]
  /** The gradient definitions the leaf mark being made registers (merged into the scene's defs when the mark is done: see `evaluateMark`). */
  markGradients?: { defs: SceneDef[]; /** only some of the mark's items were encoded (a pulse): the rest bring their gradients from the previous group */ partial: boolean }
}

/**
 * Report an error the engine recovers from, the way vega's Dataflow.error does: log it and go
 * on. Errors that are the engine's own refusals -- limits, the URL policy, `[aster]` usage errors --
 * and expressions that do not parse (vega throws those from vega.parse) are never recovered:
 * they are rethrown to the caller.
 */
function reportEvalError(ctx: EvalContext, e: unknown): void {
  refuseUnrecoverable(e)
  ctx.failed = true
  ctx.logger.error(e)
}

function refuseUnrecoverable(e: unknown): void {
  // (a row that is not a tuple fails the dataflow where vega's fails, and is logged where vega logs it: see notATuple)
  if (isNotATupleError(e)) return
  if (e instanceof AsterLimitError || e instanceof AsterUrlError || e instanceof ExpressionParseError || e instanceof SpecParseError || (e instanceof Error && e.message.startsWith('[aster]'))) throw e
}

/**
 * An operator of the dataflow threw. Vega logs the error once and stops the pass at the first operator (in rank order) that
 * fails: the point is recorded here, the first pass of a build finds the earliest and logs its error, and the second pass makes
 * only what ranked before it (see `buildContent`).
 */
function failPass(ctx: EvalContext, point: Omit<AbortPoint, 'path'> & { path?: number[] }, e: unknown): void {
  refuseUnrecoverable(e)
  ctx.failed = true
  ctx.abort.failures.push({ ...point, path: point.path ?? ctx.scope.path, error: e })
}

/**
 * Where a point stops the pass, among the points of one instance: its projections, then its axes, its marks, its legends and its
 * title (vega-parser's order of a scope's operators).
 */
function stepOf(p: AbortPoint): number {
  if (p.signals) return -2
  if (p.data) return -0.75
  if (p.scales) return -0.5
  if (p.labels) return 4e9 + (p.legend ?? 0)
  if (p.projection) return -1
  if (p.title) return 3e9
  if (p.lateSignal) return 3.5e9
  // (a layout ranked after an instance comes after everything of it; one ranked after its mark, after the mark's transforms)
  if (p.layout && p.late) return 6e9
  if (p.layout && p.mark !== undefined) return 1e9 + p.mark + 0.75
  if (p.legend !== undefined) return 2e9 + p.legend
  if (p.mark !== undefined) return 1e9 + p.mark + (p.afterEncode ? 0.5 : 0)
  return p.axis
}

/** How many of the instance's axes and legends the pass that stopped at `cut` began (one that failed inside is part-made). */
const madeAxes = (cut: AbortPoint): number => Math.max(0, cut.axis + (cut.inside && cut.legend === undefined ? 1 : 0))
const madeLegends = (cut: AbortPoint): number => (cut.title || cut.labels || cut.lateSignal || cut.lateScale ? Infinity : cut.legend === undefined ? 0 : cut.legend + (cut.inside ? 1 : 0))
/** Whether the pass that stopped at `cut` made the marks of the instance it stopped in (they are ranked after its axes only). */
const madeMarks = (cut: AbortPoint): boolean => cut.legend !== undefined || cut.mark !== undefined || cut.title === true || cut.labels === true || cut.lateSignal === true

function earlierPoint(a: AbortPoint, b: AbortPoint): AbortPoint {
  return (compareInstances(a.path, b.path) || stepOf(a) - stepOf(b)) <= 0 ? a : b
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
  txn: EvalTxn = { prev: undefined, gen: 1, claimed: new WeakSet() },
  /** Whether `input.width`/`input.height` is a size someone chose (the host or a fit resize), not just the resolved default. */
  explicitSize: { width: boolean; height: boolean } = { width: hostSize(chart, input, 'width') != null, height: hostSize(chart, input, 'height') != null },
  /** The view size signals as written, negative included (see {@link signedViewSize}): the first autosize pass reads them so. */
  signed?: { width?: number; height?: number },
  /** Present when the view makes more than one dataflow pass: what the pass before it left (see `PassMemory`). */
  passMemory?: PassMemory,
  /** The state of the previous evaluation this pass reuses (see `EvalContext.prev`); the view's id counter is the committed state's. */
  prev: IncrementalState | undefined = txn.prev,
  /** Stop once the signals that read no data or scale are resolved: what they hold is all the caller reads (see `evaluateChartPass`). */
  signalsOnly = false,
): { ctx: EvalContext; width: number; height: number } {
  // The deadline belongs to the enclosing limits scope (evaluateChart /
  // getChartInfo / renderSpec / session), so one wall clock covers the whole
  // call -- the `fit` loop re-enters this function per iteration and must not
  // restart the budget.
  const meter = activeMeter()
  const deadline = meter?.clock.deadline ?? undefined
  const checkDeadline = (phase = 'evaluation'): void => {
    if (meter) meter.clock.check(phase)
  }
  checkDeadline('startup')
  const signals = sizeSignals(chart, input)
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
  // (the items of the named marks made so far: what `data('<mark>')` reads, as vega's DataScope of a mark is its items)
  const markItems = new Map<string, SceneItem[]>()
  const runtime: ExpressionRuntime = {
    scale: (name) => scales.get(name),
    // (vega-functions `data`: the values of the data scope of that name; a named mark's scope is its items, in the order it draws them)
    data: (name) => datasets.get(name) ?? (markNamesOf(chart).has(name) ? markItems.get(name) : undefined),
    projection: (name) => transformProjections.get(name),
    tree: (name) => {
      const root = transformHierarchies.get(name)
      return root === undefined ? undefined : { root, rows: datasets.get(name) ?? [] }
    },
    ...(input.random ? { random: input.random } : {}),
    // (the chart's own locale, `config.locale`, for `format`, `timeFormat`, `timeParse` ...)
    ...(chart.locale ? { locale: () => chartLocale(chart.locale) } : {}),
    unitIndexed: (name) => chart.unitIndexed?.includes(name) === true,
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
  // (and what a formatted text or a local date read besides the spec and the input: the default locale, the host's time zone;
  // and what a text is measured by: the provider in force for this evaluation, `input.textMetrics` or the one set for every chart)
  const extraFp = `${input.domainRaw ? valueKey(input.domainRaw) : ''}\u0002${valueKey(getTextMetricsProvider())}\u0002${input.containerSize ? `${input.containerSize.width}x${input.containerSize.height}` : ''}\u0002${input.measuredSize ? `${input.measuredSize.width}x${input.measuredSize.height}` : ''}\u0002${formatEnvironmentKey()}`
  const ctx: EvalContext = {
    chart, scope: rootScope(chart), abort: { failures: [] }, ...(passMemory !== undefined ? { passMemory } : {}), signalParams, width, height, datasets, setData, scales, scaleTypes, projections: transformProjections, projectionStamp: new Map(), projectionIncomplete: new Set(), geoStale: false, runtime, _defs: defs,
    layoutState: { failed: false, warnings: [] }, initDone: new Set(), hostSignals: new Set([
      ...Object.keys(input.signals ?? {}),
      // an explicit view size (the host's, or the fit loop's resize) wins over an `init`
      ...(explicitSize.width ? ['width'] : []), ...(explicitSize.height ? ['height'] : []),
    ]),
    hierarchies: transformHierarchies, affected: new Set(), incremental: false, ...(txn.engine ? { engine: txn.engine } : {}), deadline, checkDeadline, markItems, markContainers: new Map(),
    datasetPulses: new Map(),
    prev, committed: txn.prev, ...(txn.unchanged ? { unchanged: txn.unchanged } : {}), ...(txn.pulseBases ? { pulseBases: txn.pulseBases } : {}), ...(txn.lastPass ? { earlier: txn.lastPass } : {}), draft: newState(txn.gen), ids: { value: txn.prev?.idCounter ?? 0 }, idStart: txn.prev?.idCounter ?? 0, gen: txn.gen, claimed: txn.claimed, extraFp, ...encodeLogEntry(input.signals), dsEpoch: 0, scaleReuse: new Map(), distinctCache: new WeakMap(), defsAsked: { n: 0 },
    domainRaw: input.domainRaw ? new Map(Object.entries(input.domainRaw).map(([k, v]) => [k, v])) : undefined,
    // Image urls are vetted when the host passes a policy, and with the default
    // policy whenever it passes `limits` (limits mean "this spec is untrusted").
    // With neither they are drawn as given, as Vega does: an SVG <image> cannot
    // run script, but a hostile spec can still make the viewer fetch an arbitrary
    // url (tracking pixel, IP leak). Hosts rendering foreign specs must opt in.
    urlPolicy: input.urlPolicy ?? (input.limits ? {} : undefined),
    logger: loggerOf(input.logger),
  }
  // The event loop shows a dataset it modified through its transform pipeline, before the next evaluation
  // computes it (the rows of a modified selection store, sorted by its `collect`, for example).
  // (It must not close over `ctx`: that reaches the previous evaluation's state, and a scene would keep every
  // scene before it alive.)
  runtime.transformed = makeTransformed(chart, runtime, signalParams, transformHierarchies, transformProjections)
  // Normalise every caller-supplied change description into one pulse per
  // source dataset. `dataChanges` is the same-length form (`{changed}`);
  // `dataPulse` carries the full mapping and wins when both name a dataset.
  // (each named dataset is one the chart or the host has, a pulse names a dataset given rows of its own, and every index is a row
  // index: see `checkHints`)
  checkHostData(chart, input)
  checkHints(chart, input)
  const inputPulses = new Map<string, StepPulse>()
  for (const [name, idxs] of Object.entries(input.dataChanges ?? {})) inputPulses.set(name, { changed: [...idxs] })
  for (const [name, given] of Object.entries(input.dataPulse ?? {})) {
    const p = pulseChangeOf(given)
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
  // (a hint given empty -- `changedDatasets: []` -- says that nothing changed: it is a statement of what changed too)
  const told = changedNames.size > 0 || input.changedDatasets !== undefined || input.dataChanges !== undefined || input.dataPulse !== undefined
  ctx.incremental = told && prev !== undefined

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
  if (signalsOnly) return { ctx, width, height }
  // A view size that is its signal's is what the signal holds (vega: the root group's size is `{signal: 'width'}`), as soon as it is
  // known: the datasets and scales built from here on read it. One that reads the dataflow is settled below.
  // (no closure here: one made in this function that reads `ctx` would keep it, and the evaluations before it, alive through the
  // closures `runtime` holds -- they share this function's context)
  for (const dim of ['width', 'height'] as const) {
    if (viewSignalReadsDataflow(chart, dim)) continue
    const v = viewSizeChange(chart, input, explicitSize, signed, ctx, dim, ctx.signalParams[dim], dim === 'width' ? width : height)
    if (v === undefined) continue
    if (dim === 'width') { width = v; ctx.width = v } else { height = v; ctx.height = v }
    ctx.fpMemo = undefined
    ctx.readsMemo = undefined
  }
  buildDatasets(ctx, input.data ?? {})
  const readsScales = datasetsReadScales(chart)
  const dataReads = signalsReadByData(chart)
  // The datasets, the scales and the signals between them, to their fixed point: vega runs each operator once, after what it reads,
  // so a chain (a dataset, a scale of it, a signal of the scale's domain, a dataset that reads the signal, ...) settles link by link.
  // A round builds the scales over the datasets as they are, then resolves the signals again -- those that read the scales just
  // built too -- and builds the datasets again only when a signal one of them reads changed. A chain is at most as long as the
  // chart has datasets, scales and signals; the rounds are bounded by that (and the clock, inside each build).
  // An `init` that reads what the rounds settle runs once they did (`initsSettled`), and a round follows when it changed a signal a
  // dataset reads.
  const maxRounds = chart.data.length + chart.scales.length + (chart.signalDefs?.length ?? 0) + 3
  for (let rounds = 0; rounds < maxRounds; rounds++) {
    // (a map whose projection was consumed before the `geojson` signals it fits were published builds again)
    const geoStale = ctx.geoStale
    ctx.geoStale = false
    const moved = new Set<string>()
    resolveSignalUpdates(ctx, false, moved)
    let changed = geoStale || (rounds === 0 && readsScales) || ctx.setData.changed
    ctx.setData.changed = false
    buildScales(ctx)
    resolveSignalUpdates(ctx, false, moved)
    if (!changed && !anyRead(moved, dataReads) && !ctx.initsSettled) {
      ctx.initsSettled = true
      resolveSignalUpdates(ctx, false, moved)
    }
    changed ||= anyRead(moved, dataReads) || ctx.setData.changed || ctx.dataPending === true
    if (!changed) break
    ctx.dataPending = false
    ctx.datasets.clear()
    ctx.hierarchies.clear()
    buildDatasets(ctx, input.data ?? {})
  }
  ctx.initsSettled = true
  if (ctx.dataPending) {
    // (a dataset still waits on a signal: built once more with every init open, and what throws now is reported)
    ctx.dataPending = false
    resolveSignalUpdates(ctx)
    ctx.datasets.clear()
    ctx.hierarchies.clear()
    buildDatasets(ctx, input.data ?? {})
  }
  resolveSignalUpdates(ctx)
  buildScales(ctx)
  // A view size that is its signal's, now that everything the signal reads exists: vega-lite's step-sized band dimensions
  // (`bandspace(domain('x').length, ...) * x_step`) read a scale domain, so the update runs again once the scales are built.
  for (const dim of ['width', 'height'] as const) {
    if (!sizeFollowsSignal(chart, input, explicitSize, signed, ctx, dim)) continue
    const def = (chart.signalDefs ?? []).find((s) => s.name === dim)
    const update = def?.update ?? def?.init
    let value = ctx.signalParams[dim]
    if (typeof update === 'string') {
      try { value = evalSignal(ctx.runtime.expr(update), ctx.signalParams) } catch { continue }
    }
    const v = viewSizeChange(chart, input, explicitSize, signed, ctx, dim, value, dim === 'width' ? width : height)
    if (v === undefined) continue
    if (dim === 'width') { width = v; ctx.width = v } else { height = v; ctx.height = v }
    ctx.signalParams[dim] = v
    ctx.fpMemo = undefined
    ctx.readsMemo = undefined
    buildScales(ctx)
  }
  // (the last build: every dataset and scale a parameter can read exists, so what one throws is an error, not "not yet")
  buildProjections(ctx, true)
  // (a view size that is the signal that threw is the signal's value, none: 0)
  const threw = abortAtThrowingSignal(ctx)
  if (threw === 'width') { width = 0; ctx.width = 0 }
  if (threw === 'height') { height = 0; ctx.height = 0 }
  if (threw === undefined) abortAtThrowingViewLayout(ctx)
  abortAtThrowingProjection(ctx)

  // The final context fingerprint: the next evaluation compares its own
  // (scale, mark) inputs against this to decide whether reuse is valid.
  ctx.draft.fp = ctxFpOf(ctx)
  // (the datasets the scales and marks of this pass read: see `sameRows`)
  ctx.draft.rows = new Map([...ctx.datasets].map(([name, rows]) => [name, pin(rows)] as const))
  txn.lastPass = ctx.draft

  return { ctx, width, height }
}

/**
 * Refuse a change hint that cannot be what it says (a usage error, thrown before anything is evaluated): a name that is no dataset
 * of the chart and no dataset the host gives (`changedDatasets`, `dataChanges`, `dataPulse`) -- a typo would otherwise be a chart
 * that silently keeps its old rows; a `dataChanges` / `dataPulse` for a dataset derived from others (`source`: the change is its
 * source's to describe); a change list that is not an array, or an index that is not a whole number (`1.5`, `NaN`, `'2'`); a
 * `dataPulse` that says nothing (no `changed`, `from` or `appendOnly`). An index past the rows is no row and is left alone, as before.
 */
function checkHints(chart: CompiledChart, input: RuntimeInput): void {
  if (input.changedDatasets === undefined && input.dataChanges === undefined && input.dataPulse === undefined) return
  checkHintShapes(input)
  const defs = new Map(chart.data.map((d) => [d.name, d] as const))
  const known = (name: string): boolean => defs.has(name) || (input.data !== undefined && Object.hasOwn(input.data, name))
  for (const name of input.changedDatasets ?? []) if (!known(name)) refuseHint('changedDatasets', name, 'which is no dataset of the chart and none the host gives')
  for (const [what, hints] of [['dataChanges', input.dataChanges], ['dataPulse', input.dataPulse]] as const) {
    for (const name of Object.keys(hints ?? {})) {
      if (!known(name)) refuseHint(what, name, 'which is no dataset of the chart and none the host gives')
      const def = defs.get(name)
      if (def !== undefined && sourceNames(def).length) refuseHint(what, name, 'which is derived from other datasets (`source`): describe the change of its source')
    }
  }
}

/**
 * Refuse host `data` that cannot be what it says (a usage error, thrown before anything is evaluated, as Vega's `view.data(name, rows)`
 * throws `Unrecognized data set`): a dataset name the chart does not declare at its top level (a typo would otherwise be a chart that
 * silently keeps the spec's rows, or none), a list of rows where a record of them by dataset is expected. What a dataset's value is
 * is the dataset's to say: rows, a GeoJSON or a TopoJSON object, text a format reads; `null` / `undefined` are no rows given.
 */
function checkHostData(chart: CompiledChart, input: RuntimeInput): void {
  const data = input.data as unknown
  if (data === undefined || data === null) return
  if (typeof data !== 'object' || Array.isArray(data)) throw new TypeError(`[aster] input.data must be an object of rows by dataset name ({ ${chart.data[0]?.name ?? 'table'}: rows }), got ${Array.isArray(data) ? 'a list' : typeof data}`)
  const names = new Set(chart.data.map((d) => d.name))
  for (const name of Object.keys(data)) {
    if (!names.has(name)) throw new TypeError(`[aster] input.data names dataset "${name}", which the chart does not declare (it declares: ${[...names].join(', ') || 'no datasets'}; Vega refuses it too: Unrecognized data set)`)
  }
}

const refuseHint = (what: string, name: string, why: string): never => {
  throw new TypeError(`[aster] ${what} names dataset "${name}", ${why}`)
}

/**
 * The part of `checkHints` that needs no chart (the session checks it before it reads the hints): every change list is a list of
 * whole numbers (an array, or another iterable such as a Set), every pulse an object that says something.
 */
export function checkHintShapes(input: RuntimeInput): void {
  const indices = (what: string, name: string, list: unknown, field: string): void => {
    if (list === null || typeof list !== 'object' || typeof (list as Iterable<unknown>)[Symbol.iterator] !== 'function') refuseHint(what, name, `but its ${field} is not a list of row indices`)
    for (const i of list as Iterable<unknown>) if (!Number.isInteger(i)) refuseHint(what, name, `but ${typeof i === 'number' ? String(i) : JSON.stringify(i) ?? String(i)} in its ${field} is not a row index (a whole number)`)
  }
  for (const [name, list] of Object.entries(input.dataChanges ?? {})) indices('dataChanges', name, list, 'list')
  for (const [name, p] of Object.entries(input.dataPulse ?? {})) {
    if (p === null || typeof p !== 'object') refuseHint('dataPulse', name, 'but its pulse is not an object')
    if (p.changed === undefined && p.from === undefined && !p.appendOnly) refuseHint('dataPulse', name, 'but its pulse says nothing (no `changed`, `from` or `appendOnly`)')
    if (p.changed !== undefined) indices('dataPulse', name, p.changed, '`changed`')
    if (p.from !== undefined && !Array.isArray(p.from)) refuseHint('dataPulse', name, 'but its `from` is not an array')
  }
}

/**
 * Whether dataset `d` reads a signal that has no settled value yet in this evaluation: an `init` that has not run, or an `update` that
 * has not run successfully (it waits for, or threw on, a scale or a dataset not made yet). Never once the rounds settled.
 */
function readsUnsettledSignal(ctx: EvalContext, d: CompiledChart['data'][number]): boolean {
  if (ctx.initsSettled) return false
  const names = new Set<string>()
  walkStrings(dataWithoutRows(d), (str) => namesIn(str, names))
  for (const def of ctx.chart.signalDefs ?? []) {
    if (!names.has(def.name) || ctx.hostSignals.has(def.name)) continue
    if (def.update === undefined ? def.init !== undefined && !ctx.initDone.has(def.name) : ctx.signalErrors?.has(def.name) === true || ctx.signalRuns?.has(def.name) !== true) return true
  }
  return false
}

/** Whether one of `names` is in `reads`. */
const anyRead = (names: ReadonlySet<string>, reads: ReadonlySet<string> | null): boolean => names.size > 0 && (reads === null || [...names].some((n) => reads.has(n)))

/**
 * The signals the datasets of a view read: named anywhere in a dataset's definition but its rows (its transforms' parameters and
 * expressions, a `{signal}` values, its format), or in a projection's (a geo transform reads the projection). `null`: every signal
 * (a dataset reads a signal by a name no definition spells out). A change of one of them is a change of the datasets.
 */
const DATA_SIGNALS = new WeakMap<CompiledChart, ReadonlySet<string> | null>()
function signalsReadByData(chart: CompiledChart): ReadonlySet<string> | null {
  let out = DATA_SIGNALS.get(chart)
  if (out !== undefined) return out
  const names = new Set<string>()
  for (const d of chart.data) walkStrings(dataWithoutRows(d), (str) => namesIn(str, names))
  for (const p of projectionDefsOf(chart)) walkStrings(p, (str) => namesIn(str, names))
  out = names
  DATA_SIGNALS.set(chart, out)
  return out
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
    const rows = copiedRows(ingestRows((Array.isArray(tuples) ? tuples : tuples == null ? [] : [tuples]) as Row[], 0, undefined, { dataset: name, source: 'setdata' }), 'setdata')
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
    const rows = d?.values != null ? readData(raw as never, d.format, false, undefined, dataLocale(chart)) : copiedRows(ingestRows(raw as Row[]), 'transformed rows')
    if (!d?.transform.length) return rows
    return applyTransforms(rows, d.transform, { runtime, signals: engineParams(signalParams), hierarchies, projections }, name)
  }
}

/**
 * What a random-drawing site read, for {@link atRandomSite}: its code (an expression, or a transform's parameters), the rows it was
 * given when it has any, and the value of every signal its code mentions. The same fingerprint is the same inputs, whose numbers
 * vega would not have redrawn.
 */
function randomFingerprint(code: unknown, rows: readonly unknown[] | Record<string, unknown>, signals: Record<string, unknown>): string {
  const text = typeof code === 'string' ? code : JSON.stringify(code)
  // (every name the code spells, as the lexer reads it: a signal named by an escape or past ASCII is one it reads)
  const mentioned = new Set<string>()
  if (typeof code === 'string') namesIn(code, mentioned)
  else walkStrings(code, (str) => namesIn(str, mentioned))
  const read: string[] = []
  for (const k of Object.keys(signals).sort()) if (mentioned.has(k)) read.push(`${k}=${contentKey(signals[k])}`)
  return `${text}\u0001${Array.isArray(rows) ? contentKey(rows) : ''}\u0001${read.join('\u0002')}`
}

/** A dataset's inline `values`: the array, or what a `{signal}` holds (vega-parser: a signal-valued `values` loads dynamically). */
function inlineValues(ctx: Pick<EvalContext, 'runtime' | 'signalParams'>, values: unknown): unknown {
  const expr = values !== null && typeof values === 'object' && !Array.isArray(values) ? (values as { signal?: unknown }).signal : undefined
  if (typeof expr !== 'string') return values
  return evalSignal(ctx.runtime.expr(expr), ctx.signalParams)
}

/** Say that the rows a `{signal}` values made hold primitive tuples (once per such dataset, only when they do). */
function notePrimitiveTuples(ctx: EvalContext, rows: readonly Row[]): void {
  if (!ctx.primitiveTuples && rows.some((r) => PRIMITIVE_TUPLE in r)) ctx.primitiveTuples = true
}

/**
 * The tuples a mark makes items of, as vega's DataJoin does: items are keyed by tuple id, which a primitive tuple does not have, so
 * every primitive tuple is the one item of the `undefined` key -- made where the first of them is, its datum the last of them.
 */
function joinPrimitiveTuples(rows: readonly Row[]): readonly Row[] {
  let first = -1
  let last: Row | undefined
  for (let i = 0; i < rows.length; i++) {
    if (!(PRIMITIVE_TUPLE in rows[i]!)) continue
    if (first < 0) first = i
    last = rows[i]
  }
  if (first < 0) return rows
  const out: Row[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i === first) out.push(last!)
    else if (!(PRIMITIVE_TUPLE in rows[i]!)) out.push(rows[i]!)
  }
  return out
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
  // (and the expression functions registered: a function re-registered with another body is another context, as in `readsKey`)
  return ctx.fpMemo ??= `${paramFpOf(ctx.signalParams)}\u0002${ctx.extraFp}\u0002${expressionRegistryEpoch()}`
}

/**
 * vega-parser `parseParameter`: a projection parameter with every `{signal}`
 * (also inside arrays, e.g. a `clipExtent`) replaced by its value. `fit` may be a
 * GeoJSON object itself (left as is) or a signal such as `data("source_0")`.
 */
function resolveProjectionParam(ctx: EvalContext, v: unknown, strict: boolean, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveProjectionParam(ctx, x, strict, depth + 1))
  if (v && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string') {
    const expr = (v as { signal: string }).signal
    try {
      return evalSignal(ctx.runtime.expr(expr), ctx.signalParams)
    } catch (e) {
      // In an early pass the signal may read a dataset or scale that does not exist yet: the next pass resolves it. In the last,
      // everything it can read exists, and what it throws is an error (C153): it stops the pass at the projection, as vega's operator
      // does. Except a signal two lists deep (a `clipExtent` corner) that reads a dataset or a scale: vega's operator does not depend
      // on one so deep (it never resolves it, a deviation docs/ARCHITECTURE.md lists), and the signal, ranked after the dataflow it
      // reads, fails after the marks are made: what it throws is logged and the projection made without it.
      if (!strict) return undefined
      if (depth < 2 || !DATA_DEPENDENT_EXPR.test(lexedText(expr))) throw e
      reportEvalError(ctx, e)
      return undefined
    }
  }
  return v
}

/** Build the projection one compiled definition describes, in the current context. */
function buildProjectionOf(ctx: EvalContext, p: CompiledProjection, strict = false): unknown {
  const build = requireGeo() // throws an actionable error if the geo addon is absent
  // (the type is a parameter like any other: `type: {signal: "projectionName"}`)
  const resolved: Record<string, unknown> = dict<unknown>({ name: p.name, type: resolveProjectionParam(ctx, p.type, strict) })
  for (const k of Object.keys(p)) {
    if (k === 'name' || k === 'type') continue
    resolved[k] = resolveProjectionParam(ctx, p[k], strict)
  }
  // A fit over several sources (`[data('a'), geojson_0]`) is not resolvable until every source exists
  // (vega's dataflow runs the geojson transform first): the next pass resolves it. In the last pass a missing member is the spec's
  // own (`fit: [null, feature]`), and the fit reads it as vega's does (`Cannot read properties of null (reading 'type')`).
  let incomplete = p.fit != null && resolved.fit == null
  if (!strict && Array.isArray(resolved.fit) && resolved.fit.some((f) => f == null)) {
    resolved.fit = undefined
    incomplete = true
  }
  if (incomplete) ctx.projectionIncomplete.add(p.name)
  else ctx.projectionIncomplete.delete(p.name)
  return build(resolved as never)
}

/**
 * Build the projections (vega-geo's Projection transform). A projection that
 * `fit`s a dataset depends on that dataset, which may not exist yet in the early
 * passes: such a projection is rebuilt whenever the set of built datasets has
 * changed since (see `refreshProjection`), and once more at the end of preparation.
 */
function buildProjections(ctx: EvalContext, last = false): void {
  ctx.projectionError = undefined
  if (!ctx.chart.projections?.length) return
  for (const p of ctx.chart.projections) {
    try {
      ctx.projections.set(p.name, buildProjectionOf(ctx, p, last))
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
      registry.set(p.name, buildProjectionOf(inScope, p, true))
    } catch (e) {
      // (vega logs the one error that stopped the pass; what the pass would have found after it never ran)
      refuseUnrecoverable(e)
      ctx.failed = true
      ctx.abort.failures.push({ path, axis: 0, projection: true, error: e })
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
      // (the datasets its expression reads by name, read off its tree: see `datasetsReadIn`)
      for (const n of datasetsReadIn((v as { signal: string }).signal) ?? []) out.push(n)
    }
  }
  visit(fit)
  return out
}

/** The projections map a dataset transform sees: reads go through `refreshProjection`. */
export class ProjectionRegistry extends Map<string, unknown> {
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
/**
 * A call that reads a dataset (or its hierarchy) or a scale. Tested against the text as the lexer reads it (`lexedText`): every
 * function the expression language can call has an ASCII name (the built-ins, and a host's, whose name must be one), which the lexer
 * spells otherwise only with `\uXXXX` escapes, and the lexer skips the blanks `lexedText` turns into spaces -- so a call is found
 * whatever its spelling (and a word inside a string literal at worst finds one that is not there).
 */
export const DATA_DEPENDENT_EXPR = /\b(data|indata|domain|range|scale|bandwidth|bandspace|invert|copy|gradient|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve|treePath|treeAncestors)\s*\(/

/**
 * Evaluate static signal `update` expressions in declaration order against the
 * current signal params (vega-expression rewrites bare identifiers to the
 * `$`-prefixed params our interpreter binds). Expressions that depend on not-yet
 * resolved values throw and are skipped for this round. Returns whether any
 * value changed (drives the fixed-point loop). Values compare structurally: an
 * unchanged object-valued signal such as `[0, width]` is a fresh array
 * every round and must not count as a change.
 *
 * Resolved values live in `ctx.signalParams` for THIS evaluation only: the
 * compiled chart is never written, so an evaluation is a pure function of
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

/** The signals, scales and datasets of a view that read (directly or through each other) a signal that threw. */
/**
 * What a late operator that threw took with it: the signals, scales and datasets ranked after it because they read it. `joined`
 * (a dataset that threw past the view's other operators, see buildDatasetsOf): the datasets whose operators never ran at all, so a
 * mark drawn from one was never joined -- it is not in the scene (where a mark whose encode reads a late signal is, unencoded).
 */
interface LateTaint { signals: Set<string>; scales: Set<string>; data: Set<string>; joined?: boolean }

function lateTaintOf(chart: CompiledChart, failed: readonly string[], failedData: readonly string[] = []): LateTaint {
  const t: LateTaint = { signals: new Set(failed), scales: new Set(), data: new Set(failedData), ...(failedData.length ? { joined: true } : {}) }
  const reads = (node: unknown): boolean => {
    let hit = false
    walkStrings(node, (str, owner) => {
      if (hit || owner === null) return
      if (['signal', 'expr', 'test', 'update', 'init'].some((k) => owner[k] === str) && expressionIdentifiers(str).some((id) => t.signals.has(id))) hit = true
      // (a dataset it reads: a `{data}` reference, a lookup's `from`, or by name in an expression)
      else if (t.data.size && ((t.data.has(str) && (owner.data === str || owner.from === str)) || (datasetsReadIn(str) ?? []).some((n) => t.data.has(n)))) hit = true
    })
    return hit
  }
  for (let changed = true; changed;) {
    changed = false
    for (const d of chart.signalDefs ?? []) if (!t.signals.has(d.name) && ([d.update, d.init].some((x) => typeof x === 'string' && expressionIdentifiers(x).some((id) => t.signals.has(id))) || reads(d.on))) { t.signals.add(d.name); changed = true }
    for (const sc of chart.scales) if (!t.scales.has(sc.name) && reads(sc)) { t.scales.add(sc.name); changed = true }
    for (const d of chart.data) if (!t.data.has(d.name) && (reads(dataWithoutRows(d)) || sourceNames(d).some((n) => t.data.has(n)))) { t.data.add(d.name); changed = true }
  }
  return t
}

/**
 * Whether a mark's own operators read what a late signal that threw took with it: those operators, and the ones after them, did not
 * run (its encode and its data, or one of its transforms, or its sort).
 */
function markReadsTaint(mark: CompiledMark, ctx: EvalContext): boolean {
  // (what a group holds is made in instances of its own, below: only its own operators read the signal here)
  return readsTaint({ encode: mark.encode, from: mark.from, transform: mark.transform, sort: mark.sort }, ctx)
}

/** Whether a part of a spec reads what a late signal that threw took with it (the signals that read it, the scales, the data). */
function readsTaint(part: unknown, ctx: EvalContext): boolean {
  const t = ctx.lateTaint
  if (t === undefined || part === undefined) return false
  let hit = false
  walkStrings(part, (str, owner) => {
    if (hit || owner === null) return
    if (['signal', 'expr', 'test', 'update'].some((k) => owner[k] === str) && (expressionIdentifiers(str).some((id) => t.signals.has(id)) || (t.data.size > 0 && (datasetsReadIn(str) ?? []).some((n) => t.data.has(n))))) hit = true
    if (typeof owner.scale === 'string' && owner.scale === str && t.scales.has(str)) hit = true
    if (t.data.has(str) && (owner.data === str || owner.from === str)) hit = true
  })
  return hit
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
  const failing = (name: string): boolean => errors.has(name) && !ctx.hostSignals.has(name)
  const isLate = (name: string): boolean => signalReadsDataflow(ctx.chart, index, name, new Set()) || signalIsLate(ctx.chart, index, name, new Set())
  // A signal that reads data or a scale, or one declared after it, is ranked after every other operator of the view's scope: vega
  // re-ranks it past them when the dataflow connects its parameters. Everything ranked before it ran -- the datasets, the scales,
  // the marks that do not read it, the guides, the title -- and what reads it, or what reads that, did not; the late signals after it
  // did not run either. The pass stops there. (A signal that is not late runs before everything: one that throws is the first
  // failure, in whatever order the signals are written.)
  const lateFrom = defs.findIndex((d) => failing(d.name) && isLate(d.name))
  if (lateFrom >= 0 && !defs.some((d) => failing(d.name) && !isLate(d.name))) {
    const error = errors.get(defs[lateFrom]!.name)
    refuseUnrecoverable(error)
    ctx.postRunLost = true
    ctx.failed = true
    ctx.lateTaint = lateTaintOf(ctx.chart, defs.slice(lateFrom).filter((d) => isLate(d.name)).map((d) => d.name))
    ctx.abort.failures.push({ path: [], axis: Infinity, lateSignal: true, error })
    return undefined
  }
  for (const def of defs) {
    if (!failing(def.name) || isLate(def.name)) continue
    reportEvalError(ctx, errors.get(def.name))
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
 * The view's `layout` holds a signal that throws (C398): vega-parser makes the layout's parameter, an expression operator, right after
 * the view's signals, so the throw stops the pass before every dataset, scale, mark and guide of the view, as a signal's does (the
 * view keeps its size: the root's own encode ran). A group mark's layout is its own operator, ranked after its content: a throw there
 * is the layout's failure (see `LayoutFailure`).
 */
function abortAtThrowingViewLayout(ctx: EvalContext): void {
  if (ctx.chart.layout == null || ctx.datasetAborted) return
  const failure = paramsFailure(ctx, [ctx.chart.layout])
  if (failure === undefined) return
  reportEvalError(ctx, failure.error)
  for (const d of ctx.chart.data) {
    ;(ctx.failedDatasets ??= new Set()).add(d.name)
    ctx.datasets.set(d.name, [])
    ctx.datasetPulses.set(d.name, null)
  }
  ctx.encodeAborted = ctx.datasetAborted = true
}

/**
 * The signals in the order vega's dataflow runs them: an operator after the operators it reads (vega-dataflow ranks by dependency),
 * the others in the order they were declared. A signal that reads one declared after it (`shiftArray` reading `leftRightCount`)
 * would otherwise see the other's value from the pass before, and a chain of them lags a pass per link.
 */
const SIGNAL_ORDERS = new WeakMap<CompiledChart, CompiledSignalDef[] | SpecParseError>()
function signalsInDataflowOrder(chart: CompiledChart): CompiledSignalDef[] {
  const defs = chart.signalDefs ?? []
  let out = SIGNAL_ORDERS.get(chart)
  if (out instanceof SpecParseError) throw out
  if (out) return out
  // vega-dataflow's ranks: each signal's operator is added in declaration order, then connected to what its update / init reads
  // (`connect`): one that reads an operator ranked after it is ranked anew past everything, and so is, depth first, every operator
  // that reacts to it. A `react: false` reader is ranked after what it reads but does not react to it (no edge to walk), and a
  // signal reading itself is no edge. A walk that comes back to the operator being ranked is a cycle, which vega refuses.
  const index = new Map<string, number>()
  defs.forEach((d, i) => { if (!index.has(d.name)) index.set(d.name, i) })
  const graph = new Propagation(() => {})
  const nodes = defs.map((d) => graph.add(signalNode(d.name)))
  const reads = defs.map((d, i) => {
    const out: SignalNode[] = []
    if (index.get(d.name) !== i) return out
    for (const text of [d.update, d.init]) {
      if (typeof text !== 'string') continue
      for (const id of identifiersIn(text)) {
        const j = index.get(id)
        if (j !== undefined && j !== i && !out.includes(nodes[j]!)) out.push(nodes[j]!)
      }
    }
    return out
  })
  try {
    defs.forEach((d, i) => {
      if (d.react !== false) for (const src of reads[i]!) follow(src, nodes[i]!)
      graph.connect(nodes[i]!, reads[i]!)
    })
  } catch (e) {
    const refused = new SpecParseError((e as Error).message)
    SIGNAL_ORDERS.set(chart, refused)
    throw refused
  }
  out = defs.map((d, i) => [d, nodes[i]!.order] as const).sort((a, b) => a[1] - b[1]).map(([d]) => d)
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
      // (a dataset read by a name the tree does not spell out is any dataset)
      const read = datasetsReadIn(text)
      if (read === null ? chart.data.some((x) => derivesFrom(x.name)) : read.some((n) => derivesFrom(n))) return true
      const names = new Set<string>()
      namesIn(text, names)
      for (const id of names) if (id !== sig && defs.has(id) && visit(id)) return true
    }
    return false
  }
  return visit(name)
}

function resolveSignalUpdates(ctx: EvalContext, staticOnly = false, changedNames?: Set<string>): boolean {
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
    // an `init` that reads, directly or through other signals, data, a scale or a signal a transform publishes runs once those exist
    // (vega runs it once, at its rank, after everything it reads; see `initReady`)
    if (initPending && !ctx.initsSettled && !initReady(ctx, def.name)) continue
    // a signal with `update` AND `on` handlers is a state: an event set it, and its update is not run again until what it reads
    // pulses (the event loop, which runs that dataflow, writes it down when it does); the store's value is the signal's
    if (def.update !== undefined && def.on?.length && ctx.hostSignals.has(def.name)) continue
    // ... and a derived signal the event loop holds as it was keeps the value the store has (see `heldSignalName`)
    if (def.update !== undefined && ctx.hostSignals.has(heldSignalName(def.name))) continue
    if (staticOnly && DATA_DEPENDENT_EXPR.test(lexedText(expr))) continue
    // an `init` that reads scales (a selection's initial brush: `[scale("x", 2), scale("x", 4)]`) runs once the scales exist:
    // before that `scale()` of a missing scale is `undefined`, which would be taken for the initial value
    if (initPending && SCALE_FN_EXPR.test(lexedText(expr)) && !ctx.chart.scales.every((sc) => ctx.scales.has(sc.name))) continue
    try {
      // (a `react: false` signal in a cycle through a scale runs before the signals it reads: it sees their initial values)
      const frozen = def.react === false ? frozenReadsOf(ctx.chart).get(def.name) : undefined
      let params = ctx.signalParams
      if (frozen !== undefined) {
        params = dict(ctx.signalParams)
        for (const f of frozen) params[f] = ctx.chart.signalDefs!.find((d) => d.name === f)?.value
      }
      // An update runs when something it reads changed since it last ran in this evaluation (vega runs an operator once per pulse
      // of its sources): the signals it names but itself, the datasets and scales it reads, the functions registered. Run again
      // on every round of the evaluation's fixed point, a self-reading update (`a + 1`) would count the rounds.
      const reads = signalReadKey(ctx, def, expr, params)
      if (reads !== null && ctx.signalRuns?.get(def.name) === reads) continue
      ctx.setData.caller = def.name
      const value = ctx.runtime.random === undefined || !mayDrawRandom(expr)
        ? evalSignal(ctx.runtime.expr(expr), params)
        : atRandomSite(ctx.runtime.random, ctx.chart, `signal:${def.name}`, () => randomFingerprint(expr, [], params), () => evalSignal(ctx.runtime.expr(expr), params))
      // An `init` that reads a scale or a dataset is only settled once they exist: until the scales are built,
      // `domain('x')` of a scale that is not there yet is `[]`, which is not the value vega's dataflow computes.
      const readsScales = DATA_DEPENDENT_EXPR.test(lexedText(expr)) && ctx.scales.size === 0 && ctx.chart.scales.length > 0
      if (initPending && value !== undefined && !readsScales) ctx.initDone.add(def.name)
      ctx.setData.caller = undefined
      ctx.signalErrors?.delete(def.name)
      if (reads !== null) (ctx.signalRuns ??= new Map()).set(def.name, reads)
      if (value !== undefined && !valuesEqual(value, ctx.signalParams[def.name])) {
        ctx.signalParams[def.name] = value
        ctx.fpMemo = undefined
        ctx.readsMemo = undefined
        changed = true
        changedNames?.add(def.name)
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


/**
 * Calls whose result is not a function of what an update names: a projection's (the `geo` functions read one made from data), the
 * host's window. An update that makes one runs whenever it is asked to. (The clock and the random source are read once per run, as
 * vega reads them once per pulse.)
 */
const UNKEYED_SIGNAL_CALL = /\b(windowSize|screen|geo[A-Za-z]*)\s*\(/

interface SignalReads { names: readonly string[]; data: readonly string[] | null; scales: boolean; trees: boolean }
const SIGNAL_READS = new WeakMap<CompiledSignalDef, Map<string, SignalReads | null>>()

/**
 * What one run of signal `def`'s expression `expr` read, as a key (see `resolveSignalUpdates`), or null when it is not known (the
 * update is then run every time it is asked to): every signal it names but itself, by value (`dependencyKey`); the datasets it reads,
 * by their content stamp (a dataset the evaluation rebuilt is another array, one a pulse advanced has another version); the scales it
 * may read, by identity (a scale is made again whenever anything it is made from changes); and the functions registered.
 */
function signalReadKey(ctx: EvalContext, def: CompiledSignalDef, expr: string, params: Record<string, unknown>): string | null {
  let byExpr = SIGNAL_READS.get(def)
  if (byExpr === undefined) SIGNAL_READS.set(def, (byExpr = new Map()))
  let reads: SignalReads | null | undefined = byExpr.get(expr)
  if (reads === undefined) {
    const text = lexedText(expr)
    reads = UNKEYED_SIGNAL_CALL.test(text) ? null : {
      names: [...new Set(identifiersIn(expr))].filter((n) => n !== def.name).sort(),
      data: datasetsReadIn(expr),
      scales: SCALE_FN_EXPR.test(text),
      trees: TREE_FN_EXPR.test(text),
    }
    byExpr.set(expr, reads)
  }
  if (reads === null) return null
  // (a `react: false` signal does not react to the signals it reads: once it ran, only the dataflow its reads stand on -- the
  // datasets and scales the signals it reads read, which settle over the rounds of the evaluation -- runs it again)
  if (def.react === false) reads = { names: [], ...unreactiveReads(ctx.chart, def) }
  let key = `${expressionRegistryEpoch()}`
  for (const n of reads.names) key += `\u0001${n}=${Object.hasOwn(params, n) ? dependencyKey(params[n]) : '-'}`
  for (const n of reads.data ?? ctx.chart.data.map((d) => d.name)) {
    const rows = ctx.datasets.get(n)
    key += `\u0002${n}=${rows === undefined ? '-' : stampKey(rows)}`
  }
  if (reads.scales) for (const sc of ctx.chart.scales) key += `\u0003${sc.name}=${scaleIdOf(ctx.scales.get(sc.name))}`
  if (reads.trees) for (const [n, root] of ctx.hierarchies) key += `\u0004${n}=${idOf(root as object)}`
  return key
}

/** The datasets and scales a `react: false` signal stands on: what its text reads, and what the signals it reads read, transitively. */
const UNREACTIVE_READS = new WeakMap<CompiledSignalDef, Omit<SignalReads, 'names'>>()
function unreactiveReads(chart: CompiledChart, def: CompiledSignalDef): Omit<SignalReads, 'names'> {
  let out = UNREACTIVE_READS.get(def)
  if (out !== undefined) return out
  const defs = new Map<string, CompiledSignalDef>()
  for (const d of chart.signalDefs ?? []) if (!defs.has(d.name)) defs.set(d.name, d)
  const data = new Set<string>()
  let allData = false
  let scales = false
  let trees = false
  const seen = new Set<string>()
  const queue: CompiledSignalDef[] = [def]
  for (let i = 0; i < queue.length; i++) {
    const d = queue[i]!
    if (seen.has(d.name)) continue
    seen.add(d.name)
    for (const text of [d.update, d.init]) {
      if (typeof text !== 'string') continue
      const lexed = lexedText(text)
      const ds = datasetsReadIn(text)
      if (ds === null) allData = true
      else for (const n of ds) data.add(n)
      if (SCALE_FN_EXPR.test(lexed)) scales = true
      if (TREE_FN_EXPR.test(lexed)) trees = true
      for (const id of identifiersIn(text)) { const next = defs.get(id); if (next !== undefined) queue.push(next) }
    }
  }
  out = { data: allData ? null : [...data].sort(), scales, trees }
  UNREACTIVE_READS.set(def, out)
  return out
}

/**
 * What signal `name`'s `init` stands on, transitively through the signals it reads: the datasets (null: any), whether it reads a
 * scale, and the writers of the signals it reads that a dataset's transform publishes (an `extent`, a `bin`'s signal).
 */
interface InitReads { data: ReadonlySet<string> | null; scales: boolean; writers: ReadonlySet<string> }
const INIT_READS = new WeakMap<CompiledChart, Map<string, InitReads>>()
function initReadsOf(chart: CompiledChart, name: string): InitReads {
  let memo = INIT_READS.get(chart)
  if (memo === undefined) INIT_READS.set(chart, (memo = new Map()))
  let out = memo.get(name)
  if (out !== undefined) return out
  const writers = new Map<string, string[]>()
  for (const d of chart.data) walkStrings(d.transform, (str, owner) => { if (owner !== null && owner.signal === str) (writers.get(str) ?? writers.set(str, []).get(str)!).push(d.name) })
  const defs = new Map<string, CompiledSignalDef>()
  for (const d of chart.signalDefs ?? []) if (!defs.has(d.name)) defs.set(d.name, d)
  let data: Set<string> | null = new Set()
  let scales = false
  const by = new Set<string>()
  const seen = new Set<string>()
  const queue = [name]
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!
    if (seen.has(n)) continue
    seen.add(n)
    if (n !== name) for (const w of writers.get(n) ?? []) by.add(w)
    const d = defs.get(n)
    if (d === undefined) continue
    for (const text of [d.update, d.init]) {
      if (typeof text !== 'string') continue
      const lexed = lexedText(text)
      if (DATA_DEPENDENT_EXPR.test(lexed)) {
        const ds = datasetsReadIn(text)
        if (ds === null) data = null
        else if (data !== null) for (const x of ds) data.add(x)
        if (SCALE_FN_EXPR.test(lexed)) scales = true
      }
      for (const id of identifiersIn(text)) if (!seen.has(id)) queue.push(id)
    }
  }
  out = { data, scales, writers: by }
  memo.set(name, out)
  return out
}

/**
 * Whether signal `name`'s `init` can run now: everything it stands on (`initReadsOf`) exists in this evaluation -- the datasets it
 * reads are built, the scales are, the datasets that publish a signal it reads are. vega runs an init once, at its rank, after what it
 * reads; run before (the first resolve, before any dataset), it would latch on a value nothing computed yet.
 */
function initReady(ctx: EvalContext, name: string): boolean {
  const r = initReadsOf(ctx.chart, name)
  if (r.data === null ? ctx.chart.data.some((d) => !ctx.datasets.has(d.name)) : [...r.data].some((n) => !ctx.datasets.has(n))) return false
  if (r.scales && !ctx.chart.scales.every((sc) => ctx.scales.has(sc.name))) return false
  for (const w of r.writers) if (!ctx.datasets.has(w)) return false
  return true
}

// ===========================================================================
// Shared axis/legend + padding computation — used by both evaluateChart and getChartInfo
// ===========================================================================

/**
 * The first error of the signals a guide's ticks or entries operator is given, in the order it is given them (vega makes each an
 * operator of its own, ranked just before that one), or undefined when none throws.
 */
function paramsFailure(ctx: EvalContext, params: readonly unknown[]): { error: unknown } | undefined {
  // (a parameter that is a list or an object holding signals is one expression too, vega's `objectProperty`: a signal in it that
  // throws fails it, C398)
  const signals: string[] = []
  const visit = (v: unknown, depth: number): void => {
    if (isSignal(v)) signals.push(v.signal)
    else if (v !== null && typeof v === 'object' && depth < 64) for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x, depth + 1)
  }
  for (const p of params) visit(p, 0)
  for (const code of signals) {
    try {
      evalSignal(ctx.runtime.expr(code), ctx.signalParams)
    } catch (error) {
      return { error }
    }
  }
  return undefined
}

/** A parameter of a guide's operator: the value, or what its signal holds (once {@link paramsFailure} has found that none throws). */
const paramValue = (ctx: EvalContext, v: unknown): unknown => (isSignal(v) ? evalSignal(ctx.runtime.expr(v.signal), ctx.signalParams) : v)

/** A guide number that may be a `{signal}` (undefined when absent or not a number). */
function guideNumber(ctx: EvalContext, value: unknown): number | undefined {
  if (value && typeof value === 'object' && typeof (value as { signal?: unknown }).signal === 'string') {
    try { value = evalSignal(ctx.runtime.expr((value as { signal: string }).signal), ctx.signalParams) } catch { return undefined }
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Resolve a guide title (string or `{signal}`) for accessibility metadata. */
function guideTitle(ctx: EvalContext, title: unknown): string | undefined {
  if (typeof title === 'string') return title
  if (title && typeof title === 'object' && typeof (title as { signal?: unknown }).signal === 'string') {
    try {
      const value = evalSignal(ctx.runtime.expr(String((title as { signal: string }).signal)), ctx.signalParams)
      return value == null ? undefined : String(value)
    } catch { return undefined }
  }
  return undefined
}

/** vega-view-transforms layoutGroup: the child roles whose bounds union into BOTH anchor bounds of the guide layout. */
const VIEW_ROLES: ReadonlySet<string> = new Set(['frame', 'scope', 'row-header', 'row-footer', 'row-title', 'column-header', 'column-footer', 'column-title'])

/** Make one of a view's axes: its group, with what the accessible tree and the caption read of it. */
function buildAxisGroup(ctx: EvalContext, axis0: CompiledAxis, axisIndex: number): SceneGroup | null {
  const axis = resolveAxisOrient(axis0, ctx)
  const group = buildAxis(axis, ctx, axisIndex)
  if (group) {
    // Carry guide identity for the accessible tree without changing
    // the serialized SVG: the fields are scene metadata only.
    const meta = group as unknown as { zindex?: number; orient?: string; scale?: string; title?: string; aria?: boolean; grid?: boolean; format?: unknown; formatType?: unknown }
    // (the mark definition reads these as written -- vega-parser marks/definition.js: `+zindex || undefined`, `aria`,
    // `description` -- so a signal object is not looked into: its zindex is none, its description is the object)
    const zindex = +(axis.zindex as number) || undefined
    if (zindex) meta.zindex = zindex
    // (the caption reads the axis group item's own orient, which a user encode may have changed)
    meta.orient = (typeof axis.orient === 'string' ? ((group as unknown as { axis?: { itemOrient?: string } }).axis?.itemOrient ?? axis.orient) : axis.orient)
    meta.scale = axis.scale
    meta.aria = axis.aria
    // (vega-parser draws the grid for any truthy `grid`, a signal object included, without reading it: `!!_('grid')`)
    meta.grid = !!axis.grid
    const unencoded = (group as unknown as { axis?: { unencoded?: boolean } }).axis?.unencoded === true
    // (the caption reads the format and its type off the axis's group item, as its encode left them: a literal object is an
    // encode entry there, a signal is what it holds whatever its type, and an `encode.axis` may set them)
    const item = (group as unknown as { axis?: { format?: unknown; formatType?: unknown } }).axis
    meta.format = unencoded ? undefined : item?.format
    meta.formatType = unencoded ? undefined : item?.formatType
    const at = guideTitle(ctx, axis.title)
    if (at) meta.title = at
    // the axis' `description` is the aria-label of its container (vega-scenegraph ariaGuide: mark.description first)
    const adesc = (axis as { description?: unknown }).description
    if (adesc) group.description = adesc as string
  }
  return group
}

/** One of the view's own axes or legends as a clean pass made it, and what it was made under (see `keptGuide`). */
interface GuideRecord {
  /** `guideKeyOf` the definition when it was made (with what its placement reads, for a title: see `buildTitleGroup`) */
  key: string
  /** the guide's group as made (a legend's as placed, once the legends of its scope were: see `buildAxisAndLegend`) */
  group: SceneGroup
  /** every scale of the scope, as the guide was made among them */
  scales: ReadonlyArray<readonly [string, unknown]>
  /** whether tuples were registered (the datums of its parts are tuples then) */
  tuples: boolean
  /** a legend's: whether making it took an instance slot of its scope (a symbol legend's entries: see `takeLegendSlot`) */
  slotted?: boolean
  /** a legend's: what the legends of its scope were placed against (see `legendPlacementKey`); unset until they are placed */
  placement?: string
}

/** Run `fn`, counting what it logs through the context's logger (which it still logs to). */
function countingLogs<T>(ctx: EvalContext, fn: () => T): { result: T; logged: number } {
  const logger = ctx.logger
  let logged = 0
  const counted = (f: (...a: unknown[]) => void) => (...a: unknown[]): void => { logged++; f.apply(logger, a) }
  ctx.logger = {
    error: counted(logger.error), warn: counted(logger.warn),
    ...(logger.info ? { info: counted(logger.info) } : {}), ...(logger.debug ? { debug: counted(logger.debug) } : {}),
  }
  try {
    return { result: fn(), logged }
  } finally {
    ctx.logger = logger
  }
}

/** The scope instance a guide belongs to: `''` for the view's, the group item's key path for a group mark's (a facet cell's). */
const guideInstance = (ctx: EvalContext): string => ctx.scope.keyPath ?? ''

function guideRecordOf(state: IncrementalState | undefined, def: object, instance: string): GuideRecord | undefined {
  return state?.guides.get(def)?.get(instance)
}
function setGuideRecord(state: IncrementalState, def: object, instance: string, record: GuideRecord): void {
  let byInstance = state.guides.get(def)
  if (byInstance === undefined) state.guides.set(def, (byInstance = new Map()))
  byInstance.set(instance, record)
}

/** What a guide definition reads besides the scales: the signals it names (null: more than it names), the datasets its expressions read by name (null: a computed name). */
interface GuideDeps { names: readonly string[] | null; data: readonly string[] | null }
const GUIDE_DEPS = new WeakMap<object, GuideDeps>()
function guideDepsOf(def: object, chart: CompiledChart): GuideDeps {
  let deps = GUIDE_DEPS.get(def)
  if (deps !== undefined) return deps
  const data = new Set<string>(datasetsNamed(def, chart))
  let computed = false
  walkStrings(def, (str) => {
    const read = datasetsReadIn(str)
    if (read === null) computed = true
    else for (const n of read) data.add(n)
  })
  deps = { names: namesMentioned(def, chart), data: computed ? null : [...data].sort() }
  GUIDE_DEPS.set(def, deps)
  return deps
}

/**
 * What one of the view's own axes or legends is made under besides the scales: the signals its definition names, the view's size,
 * `extraFp` (overrides, the text measurer, container sizes, locale, time zone) and the registered functions
 * (`readsKey`); the rows of the datasets its expressions read by name (`datasetKey`); the URL policy its links are vetted under;
 * whether the guides are laid out at all. Null: it reads more than that (a signal it does
 * not name, a dataset by a computed name).
 */
function guideKeyOf(def: object, ctx: EvalContext): string | null {
  const deps = guideDepsOf(def, ctx.chart)
  if (deps.names === null || deps.data === null) return null
  let key = `${readsKey(ctx, deps.names)}\u0003${ctx.urlPolicy === undefined ? '' : dependencyKey(ctx.urlPolicy)}\u0003${ctx.rawGuides ? 1 : 0}`
  for (const n of deps.data) key += `\u0004${n}=${datasetKey(ctx, n)}`
  return key
}

/**
 * The record of what the evaluation before made of guide `def` (an axis, a legend or a title, of the view or of a group mark's
 * instance), when this evaluation would make the same: nothing it was made from changed. A guide's group is a function of its
 * definition (the compiled chart's own object, with the config and styles folded in), of what `guideKeyOf` holds (in a group, the
 * group's size and the signals as its scope sees them), of its scope's scales -- each the very object it was made with (a scale is
 * made again whenever anything it is made from changes) -- and of whether tuples are registered. The pass must be clean (a pass that
 * stopped makes what vega made before the stop), not counted against `limits` (a kept guide is not counted again), not one of a view
 * that fits its viewport (each pass makes its own, the second from the first) and not one whose layout failed. What making it wrote
 * into the evaluation besides its group is nothing, or it was not recorded (see `recordGuide`), or it is written again by the caller
 * (a legend's instance slot). A record is kept once per evaluation: two instances of one key path never share a group.
 * Not committed: the caller keeps it with `keepGuide`.
 */
function keptGuideRecord(def: object, ctx: EvalContext, key: string | null): GuideRecord | undefined {
  if (key === null) return undefined
  const instance = guideInstance(ctx)
  const record = guideRecordOf(ctx.prev, def, instance)
  if (record === undefined || record.key !== key || record.tuples !== tuplesRegistering()) return undefined
  if (!guidesKeepable(ctx) || !sameScales(ctx, record.scales) || guideRecordOf(ctx.draft, def, instance) !== undefined) return undefined
  return record
}
/** Keep `record` (see `keptGuideRecord`): this evaluation's group of `def` is the one before. */
function keepGuide(def: object, ctx: EvalContext, record: GuideRecord): SceneGroup {
  setGuideRecord(ctx.draft, def, guideInstance(ctx), record)
  return record.group
}
function keptGuide(def: object, ctx: EvalContext, key: string | null): SceneGroup | undefined {
  const record = keptGuideRecord(def, ctx, key)
  return record === undefined ? undefined : keepGuide(def, ctx, record)
}

/** Whether this pass may keep or record the view's guides (see `keptGuide`). */
const guidesKeepable = (ctx: EvalContext): boolean => cleanPass(ctx) && activeMeter() === null && ctx.passMemory === undefined
  && !ctx.layoutState.failed && ctx.layoutThrew !== true

function sameScales(ctx: EvalContext, scales: ReadonlyArray<readonly [string, unknown]>): boolean {
  if (scales.length !== ctx.scales.size) return false
  for (const [name, scale] of scales) if (ctx.scales.get(name) !== scale) return false
  return true
}

/**
 * Make guide `def` (`make`) and record it for a later evaluation to keep, when the pass is clean before and after, and making it
 * wrote nothing into the evaluation but its group: it logged nothing (a warning is logged by every evaluation that makes the guide)
 * and asked for no gradient definition (the scene's definitions are those its parts ask for, in order).
 */
function recordGuide(def: object, ctx: EvalContext, key: string | null, make: () => SceneGroup | null): SceneGroup | null {
  if (key === null || !guidesKeepable(ctx) || guideRecordOf(ctx.draft, def, guideInstance(ctx)) !== undefined) return make()
  const slotsBefore = ctx.scope.nextChild.n
  const asked = ctx.defsAsked.n
  const { result: group, logged } = countingLogs(ctx, make)
  const slots = ctx.scope.nextChild.n - slotsBefore
  // (a legend still waiting for its entries is only made in a pass that stopped; one slot at most is what a legend takes)
  if (group !== null && logged === 0 && ctx.defsAsked.n === asked && guidesKeepable(ctx) && slots <= 1
    && (group as unknown as { _entriesPending?: boolean })._entriesPending !== true) {
    setGuideRecord(ctx.draft, def, guideInstance(ctx), { key, group, scales: [...ctx.scales], tuples: tuplesRegistering(), ...(slots === 1 ? { slotted: true } : {}) })
  }
  return group
}

function buildAxisAndLegend(
  ctx: EvalContext,
  contentItems: SceneGroup[],
  axes: CompiledAxis[] = ctx.chart.axes,
  legends: CompiledLegend[] = ctx.chart.legends,
  /** the view's own guides (not a group mark's): they may be kept from the evaluation before (see `keptGuide`) */
  keep = false,
): { groups: SceneGroup[] } {
  const groups: SceneGroup[] = []
  // (the pass stopped at a failing dataset: no axis or legend was made)
  if (ctx.datasetAborted) return { groups }
  // vega's layoutGroup walks the content children together with the guides:
  // the anchor bounds scan the content items too.
  const anchorItems = [...contentItems]

  for (const [axisIndex, axis0] of axes.entries()) {
    const key = keep ? guideKeyOf(axis0, ctx) : null
    const group = (keep ? keptGuide(axis0, ctx, key) : undefined) ?? recordGuide(axis0, ctx, key, () => buildAxisGroup(ctx, axis0, axisIndex))
    if (group) {
      groups.push(group)
      anchorItems.push(group)
    }
  }

  // The legends: each is built at its own origin, then those that share an orient are placed as a block against the plot (see
  // placeLegendStack). A legend is never dropped by the config: `disable` is a Vega-Lite key that the VL compiler has already
  // resolved by leaving the legend out, so one that is here stays.
  type LegendProps = { orient?: unknown; offset?: unknown; x?: unknown; y?: unknown }
  const layoutW = Math.max(0, ctx.width)
  const layoutH = Math.max(0, ctx.height)
  // what the legends anchor against: the plot widened by the guides beside it. Legends on the left and right clear the
  // vertical axes (xb), those above and below clear the horizontal ones (yb); a mark's group counts for both.
  let anchors: { xb: Sides; yb: Sides } | undefined
  const anchorsOf = (): { xb: Sides; yb: Sides } => {
    if (anchors !== undefined) return anchors
    const xb: Sides = { x1: 0, y1: 0, x2: layoutW, y2: layoutH }
    const yb: Sides = { x1: 0, y1: 0, x2: layoutW, y2: layoutH }
    const widen = (to: Sides, b: Bounds): void => {
      to.x1 = Math.min(to.x1, b.x1)
      to.y1 = Math.min(to.y1, b.y1)
      to.x2 = Math.max(to.x2, b.x2)
      to.y2 = Math.max(to.y2, b.y2)
    }
    for (const g of anchorItems) {
      if (g.unbounded) continue
      const scoped = (g as Record<string, unknown>)._scope === true
      if (g.marktype === 'group' && (g.role === 'scope' || g.role === 'mark' || (scoped && VIEW_ROLES.has(String(g.role))))) {
        // a scope counts as everything inside it and its own frame, clipped cells included
        const b = scoped ? layoutBounds(g) : boundGroupItem(new Bounds(), g)
        widen(xb, b)
        widen(yb, b)
      } else if (g.role === 'axis') {
        const orient = (g as unknown as { axis?: { orient: string } }).axis?.orient
        widen(orient === 'left' || orient === 'right' ? xb : yb, boundAxisGroup(g))
      }
    }
    return (anchors = { xb, yb })
  }
  // What placing the legends reads besides the legends themselves: the anchors, the plot's size and whether they are laid out.
  // `config.legend.layout`, as vega reads it (`objectProperty`): signals at any depth, the value they hold now
  const legendLayout = legends.length ? resolvedLegendLayout(ctx) : NO_LAYOUT
  const placement = keep && legends.length > 0 && guidesKeepable(ctx) ? legendPlacementKey(anchorsOf(), layoutW, layoutH, ctx.rawGuides === true) + '\u0001' + valueKey(legendLayout) : null
  // Every legend of the scope kept as the evaluation before placed it, when each is kept and they are placed against the same: the
  // placement of one depends on the others of its orient, so they are kept together or made again together (see `keptLegends`).
  const keptGroups = placement !== null ? keptLegends(ctx, legends, placement) : undefined
  const made = keptGroups ?? legends.map((legend, legendIndex) => {
    const key = keep ? guideKeyOf(legend, ctx) : null
    return recordGuide(legend, ctx, key, () => describedLegend(buildLegend(legend, ctx, legendIndex), legend, ctx))
  })
  const built = made
    .map((group, i) => ({ legend: legends[i]!, group, props: ((group as unknown as { legendProps?: LegendProps } | null)?.legendProps ?? {}) as LegendProps }))
    .filter((x): x is { legend: CompiledLegend; group: SceneGroup; props: LegendProps } => x.group !== null)
    // A legend whose entries failed to build (an invalid tickCount interval
    // string) degenerates to a zero-size group with no items: vega still
    // creates it, but it renders nothing and takes no layout space.
    // (a legend only waiting for its entries is a group like any other)
    .filter((x) => (x.group as unknown as { _entriesPending?: boolean })._entriesPending === true || !(x.group.width === 0 && x.group.height === 0 && (x.group.items?.length ?? 0) === 0))

  // (placing a legend logs nothing it could log again: an `orient: none` legend's x and y are read, and logged, as it is placed, so
  // a placement that logged is not recorded)
  const placeLegends = (): void => {
    const { xb, yb } = anchorsOf()
    // group legends by orient ('none' skips the grid: vega leaves the item
    // at its unlayouted position, which is the origin)
    const byOrient = new Map<string, { legend: CompiledLegend; group: SceneGroup; props: LegendProps }[]>()
    for (const x of built) {
      // (vega: `item.orient || 'right'`)
      const orient = String(x.props.orient || 'right')
      // (a legend whose entries were never made has nothing to lay out: it stays where its encode put it)
      if ((x.group as unknown as { _entriesPending?: boolean })._entriesPending) continue
      if (orient === 'none') {
        // legendLayout leaves an `orient: none` legend where its x / y encode put it
        // (legendX / legendY); every other orient is zeroed and placed by the grid
        const lx = guideNumber(ctx, x.props.x)
        const ly = guideNumber(ctx, x.props.y)
        if (lx !== undefined) x.group.x = lx
        if (ly !== undefined) x.group.y = ly
        if (lx === undefined || ly === undefined) (x.group as unknown as { unplaced?: { x: boolean; y: boolean } }).unplaced = { x: lx === undefined, y: ly === undefined }
        continue
      }
      const list = byOrient.get(orient) ?? []
      list.push(x)
      byOrient.set(orient, list)
    }

    for (const [orient, list] of byOrient) {
      // Raw-guide mode skips the legend grid: the groups stay at (0,0) (the built legends are pushed unpositioned below).
      if (ctx.rawGuides) continue
      placeLegendStack(orient, list.map((x) => x.group), list.map((x) => x.props.offset), legendLayout, xb, yb, layoutW, layoutH)
    }
  }
  const placed = built.length && keptGroups === undefined ? countingLogs(ctx, placeLegends).logged === 0 : true
  // (the legends this pass made and recorded are placed now: what they were placed against goes with them)
  if (placement !== null && keptGroups === undefined && placed && guidesKeepable(ctx)) {
    const instance = guideInstance(ctx)
    legends.forEach((legend, i) => {
      const record = guideRecordOf(ctx.draft, legend, instance)
      if (record !== undefined && record.group === made[i]) record.placement = placement
    })
  }
  for (const x of built) groups.push(x.group)

  return { groups }
}

/** What the legends of a scope are placed against (see `buildAxisAndLegend`), as a key: the anchors, the plot's size, the raw mode. */
const NO_LAYOUT: Record<string, unknown> = {}

/** `config.legend.layout` with the signals in it (at any depth, or the whole of it) resolved; none when it is no object. */
function resolvedLegendLayout(ctx: EvalContext): Record<string, unknown> {
  const raw = ctx.chart.legendLayout
  if (raw === undefined) return NO_LAYOUT
  const v = objectProperty(raw, (code) => {
    try { return evalSignal(ctx.runtime.expr(code), ctx.signalParams) } catch (e) { reportEvalError(ctx, e); return undefined }
  })
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : NO_LAYOUT
}

function legendPlacementKey(anchors: { xb: Sides; yb: Sides }, w: number, h: number, raw: boolean): string {
  const { xb, yb } = anchors
  return `${xb.x1},${xb.y1},${xb.x2},${xb.y2}\u0001${yb.x1},${yb.y1},${yb.x2},${yb.y2}\u0001${w}x${h}\u0001${raw ? 1 : 0}`
}

/**
 * The groups of every legend of the scope as the evaluation before made and placed them, when each is kept (`keptGuideRecord`) and
 * was placed against what the legends are placed against now: the same anchors (the bounds of the content and the axes beside the
 * plot), plot size and raw mode, beside the same other legends (each kept too). A legend's place is then the place it has, and
 * nothing is placed. What making a legend wrote besides its group is written again: the instance slot of a symbol legend.
 * Undefined: they are all made again (and placed), every one of them.
 */
function keptLegends(ctx: EvalContext, legends: readonly CompiledLegend[], placement: string): SceneGroup[] | undefined {
  const records: GuideRecord[] = []
  for (const legend of legends) {
    const record = keptGuideRecord(legend, ctx, guideKeyOf(legend, ctx))
    if (record === undefined || record.placement !== placement) return undefined
    records.push(record)
  }
  return legends.map((legend, i) => {
    const record = records[i]!
    if (record.slotted === true) takeLegendSlot(ctx)
    return keepGuide(legend, ctx, record)
  })
}

/** A legend's group with what the accessible tree and the caption read of it (scene metadata only: the SVG does not change). */
function describedLegend(group: SceneGroup | null, legend: CompiledLegend, ctx: EvalContext): SceneGroup | null {
  if (group === null) return null
  // (these are read as written, so a signal object is not looked into)
  const zindex = +(legend.zindex as number) || undefined
  if (zindex) (group as unknown as { zindex?: number }).zindex = zindex
  // `aria: false` removes the legend from the accessibility tree (and marks it aria-hidden)
  ;(group as unknown as { aria?: boolean }).aria = (legend as { aria?: boolean }).aria
  // (vega's caption asks whether the legend's OWN spec has a title -- `datum.title` is `spec.title != null` -- so a
  // `config.legend.title` is no title to it)
  const ownSpec = (legend as { own?: { title?: unknown } }).own ?? legend
  const lt = guideTitle(ctx, ownSpec.title)
  if (lt) (group as unknown as { title?: string }).title = lt
  const ldesc = (legend as { description?: unknown }).description
  if (ldesc) group.description = ldesc as string
  const g = group as unknown as {
    legendScale?: string; legendChannels?: string[]; legendType?: string
    legendFormat?: unknown; legendFormatType?: unknown
  }
  // the channels the legend describes, in priority order (the first gives the legend its scale)
  const own = (legend.own ?? {}) as Record<string, unknown>
  g.legendChannels = LEGEND_SCALES.filter((k) => !!own[k])
  g.legendScale = g.legendChannels.map((k) => String(own[k]))[0]
  // (a legend group item whose encode never ran has no format for the caption to read)
  const unencoded = (group as unknown as { unencoded?: boolean }).unencoded === true
  // (read off the legend's group item, as for an axis)
  const item = (group as unknown as { legendItemFormat?: { format?: unknown; formatType?: unknown } }).legendItemFormat
  g.legendFormat = unencoded ? undefined : item?.format
  g.legendFormatType = unencoded ? undefined : item?.formatType
  // (the legend type is the kind of legend the builder drew: gradient, discrete bands or symbols)
  return group
}

/**
 * Measure a top-level guide group the way vega's layoutGroup does: axes via
 * the spine semantics, legends via the legendBounds anchor (the item bound is
 * forced to x1=y1=padding, so negative text overhangs don't leak into the
 * viewBounds), everything else recursively.
 */
function measureGuideGroup(g: SceneGroup): Bounds {
  if (g.unbounded) return new Bounds()
  if (g.role === 'axis') return boundAxisGroup(g)
  const cacheable = cacheableGroupBounds(g)
  if (cacheable) {
    const cached = GROUP_BOUNDS.get(g)
    if (cached) return cached
  }
  // a laid-out group / legend / typed mark: the bounds vega's Bound pass leaves on it (a group item's as they are, which its mark's
  // union reads: see `eachMarkBounds`)
  const bounds = g.marktype === 'group' || (g.marktype === undefined && Array.isArray(g.items)) ? groupLayoutBounds(g) : layoutBounds(g)
  if (cacheable) GROUP_BOUNDS.set(g, bounds)
  return bounds
}

/**
 * What a top-level guide adds to the bounds of the view. A view that fits its viewport takes from a legend only the extent across the
 * side it sits on (a legend that overran the chart would otherwise squeeze it to nothing): a legend in a corner, or placed freely,
 * takes nothing. Every other guide adds its whole box.
 */
function shareOfView(b: Bounds, group: SceneGroup, fitting: boolean): Bounds {
  if (!fitting || group.role !== 'legend') return b
  const side = (group as unknown as { legendProps?: { orient?: unknown } }).legendProps?.orient
  const share = new Bounds()
  if (side === 'left' || side === 'right') { share.x1 = b.x1; share.x2 = b.x2 }
  else if (side === 'top' || side === 'bottom') { share.y1 = b.y1; share.y2 = b.y2 }
  return share
}

function computeGuidePadding(
  items: SceneGroup[],
  width: number,
  height: number,
  base: { top: number; right: number; bottom: number; left: number },
  fitting = false,
): { top: number; right: number; bottom: number; left: number } {
  // Vega's autosize unions the *recursive* bounds of every top-level guide
  // (axis/legend) and mark into the viewBounds and grows the padding by the
  // overflow. Measure each group with the exact vega bounds port: axes via
  // the axisLayout spine semantics, everything else via the recursive
  // item-union (same as vega-scenegraph's bound pass).
  // (vega's viewBounds: the view's box, with each mark's bounds unioned in -- a union, so an edge that is not a number is left out,
  // as there, and the padding is read from the box's edges as they come out)
  const view = new Bounds().set(0, 0, width, height)
  const grow = (b: Bounds, group: SceneGroup): void => { view.union(shareOfView(b, group, fitting)) }
  // (mark by mark: a group mark's items into the mark's bounds first, a mark's `clip` bounding it to the frame, vega boundClip)
  eachMarkBounds(items, width, height, (n) => measureGuideGroup(n as SceneGroup), (b, n) => grow(b, n as SceneGroup))
  const minX = view.x1
  const maxX = view.x2
  const minY = view.y1
  const maxY = view.y2

  // vega's viewSizeLayout (autosize pad): origin = spec padding + the ceil'd
  // overflow of the viewBounds on each side — no extra margin.
  // Epsilon guard: vega's rotated-text bounds land on exact integers where
  // our fp path can be off by 1 ulp; ceil would otherwise grow the padding.
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
  return { x: num(geo.x) ?? 0, y: num(geo.y) ?? 0, paint: paint as Partial<SceneRoot>, aria: itemAriaOf(geo) }
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
/** Expression functions that read a dataset's hierarchy (`treePath`, `treeAncestors`). */
const TREE_FN_EXPR = /\b(treePath|treeAncestors)\s*\(/

/** What a dataset's pipeline reads besides its `source`. */
interface DatasetDeps { names: Set<string>; allData: boolean }
const DATASET_DEPS = new WeakMap<CompiledChart, Map<string, DatasetDeps>>()

function datasetDepsOf(chart: CompiledChart): Map<string, DatasetDeps> {
  let deps = DATASET_DEPS.get(chart)
  if (deps) return deps
  deps = new Map()
  const known = new Set(chart.data.map((d) => d.name))
  const projections = projectionDepsOf(chart)
  for (const d of chart.data) {
    const names = new Set<string>()
    let allData = false
    for (const src of sourceNames(d)) names.add(src)
    // Anything in the pipeline that names another dataset (lookup `from`, ...)
    // or reads datasets from an expression makes this dataset depend on it.
    // (and a projection it names: what that projection is fitted to -- see `projectionDepsOf`)
    walkStrings(d.transform, (str) => {
      if (known.has(str) && str !== d.name) names.add(str)
      if (DATA_FN_EXPR.test(lexedText(str)) || TREE_FN_EXPR.test(lexedText(str))) allData = true
      for (const p of projectionsNamedIn(str, projections)) {
        for (const n of p.names) if (n !== d.name) names.add(n)
        if (p.allData) allData = true
      }
    })
    deps.set(d.name, { names, allData })
  }
  DATASET_DEPS.set(chart, deps)
  return deps
}

/**
 * What each projection of the view is made from among the datasets (a node of the dependency closure, like a dataset): the datasets
 * its `fit` reads, and those that publish or are read by a signal any of its parameters names (a `geojson` transform's output,
 * `data('regions')` in a signal), transitively through the signals. `allData`: some of them are read by a computed name. A dataset
 * or a mark that names the projection reads all of these: a fitted projection moves when they change, and so does everything made
 * through it (a `geopoint`'s x/y, a `geoshape`'s path, `scale('p', ...)`).
 */
const PROJECTION_DEPS = new WeakMap<CompiledChart, Map<string, DatasetDeps>>()
function projectionDepsOf(chart: CompiledChart): Map<string, DatasetDeps> {
  let out = PROJECTION_DEPS.get(chart)
  if (out) return out
  out = new Map()
  const defs = projectionDefsOf(chart)
  if (defs.length) {
    const known = new Set(chart.data.map((d) => d.name))
    const signals = new Map((chart.signalDefs ?? []).map((sd) => [sd.name, sd] as const))
    const writers = new Map<string, string[]>()
    for (const d of chart.data) {
      walkStrings(d.transform, (str, owner) => { if (owner !== null && owner.signal === str) (writers.get(str) ?? writers.set(str, []).get(str)!).push(d.name) })
    }
    for (const p of defs) {
      const names = new Set<string>()
      let allData = false
      const read = (text: string): void => {
        const ds = datasetsReadIn(text)
        if (ds === null) allData = true
        else for (const n of ds) if (known.has(n)) names.add(n)
      }
      const seen = new Set<string>()
      const queue: string[] = []
      walkStrings(p, (str) => { read(str); const ids = new Set<string>(); namesIn(str, ids); for (const id of ids) queue.push(id) })
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!
        if (seen.has(id)) continue
        seen.add(id)
        for (const w of writers.get(id) ?? []) names.add(w)
        const sd = signals.get(id)
        if (sd === undefined) continue
        for (const text of [sd.update, sd.init]) {
          if (typeof text !== 'string') continue
          read(text)
          const ids = new Set<string>()
          namesIn(text, ids)
          for (const n of ids) queue.push(n)
        }
      }
      // (a projection of a group scope by the name of one of the view's is the group's: both are counted)
      const was = out.get(p.name)
      if (was !== undefined) { for (const n of was.names) names.add(n); allData ||= was.allData }
      out.set(p.name, { names, allData })
    }
  }
  PROJECTION_DEPS.set(chart, out)
  return out
}

/**
 * The projections a string of a definition names: the string itself, a projection's name (a transform's `projection`), or a string
 * literal of an expression that is one (`scale('p', ...)`, `geoCentroid('p', ...)`). Any literal that is a projection's name counts,
 * whatever reads it: at worst a dependency that is not one.
 */
function projectionsNamedIn(str: string, projections: ReadonlyMap<string, DatasetDeps>): DatasetDeps[] {
  const whole = projections.get(str)
  if (whole !== undefined) return [whole]
  if (!/['"]/.test(str)) return []
  const out: DatasetDeps[] = []
  for (const m of lexedText(str).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const p = projections.get(m[1] ?? m[2] ?? '')
    if (p !== undefined) out.push(p)
  }
  return out
}

/** Every projection definition of the chart: the view's and those of its group marks. */
function projectionDefsOf(chart: CompiledChart): CompiledProjection[] {
  const out: CompiledProjection[] = [...(chart.projections ?? [])]
  const walk = (marks: readonly CompiledMark[] | undefined): void => {
    for (const m of marks ?? []) { if (m.projections?.length) pushAll(out, m.projections); walk(m.marks) }
  }
  walk(chart.marks)
  return out
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

/**
 * A mark bound to a force layout's links: it lays out nodes with a `link` force, or it reads a dataset a `link` force takes its rows
 * from. Each run of the force rewrites the link rows of the evaluation (their ends become the nodes it moved), so neither the force's
 * nodes nor the marks drawn from its links are kept from an evaluation before: they are made again together.
 */
const FORCE_BOUND = new WeakMap<CompiledMark, boolean>()
function forceBound(mark: CompiledMark, chart: CompiledChart): boolean {
  let out = FORCE_BOUND.get(mark)
  if (out !== undefined) return out
  const links = forceLinkDatasets(chart)
  out = links.size > 0 && (
    (mark.transform ?? []).some((t) => t.type === 'force' && Array.isArray((t as { forces?: unknown }).forces)
      && ((t as { forces: Array<{ force?: string } | null> }).forces).some((f) => f?.force === 'link'))
    || (mark.from?.data !== undefined && links.has(mark.from.data))
    || [...markDepsOf(mark, chart).names].some((n) => links.has(n)))
  FORCE_BOUND.set(mark, out)
  return out
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
  if (writers.size || (chart.signalDefs ?? []).some((sd) => [sd.update, sd.init].some((x) => typeof x === 'string' && datasetsReadIn(x)?.length !== 0))) {
    const defs = new Map((chart.signalDefs ?? []).map((sd) => [sd.name, sd] as const))
    const datasetNames = new Set(chart.data.map((d) => d.name))
    const identsOf = (v: unknown, into: Set<string>): void => {
      walkStrings(v, (str) => namesIn(str, into))
    }
    for (const d of chart.data) {
      const read = new Set<string>()
      identsOf(d.transform, read)
      const valuesExpr = valuesSignal(d.values)
      if (valuesExpr !== undefined) identsOf(valuesExpr, read)
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
          // (a dataset read by a name the tree does not spell out is any dataset)
          for (const w of datasetsReadIn(text) ?? [...datasetNames]) {
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
    for (const d of chart.data) walkStrings(d.transform, (str) => { if (SCALE_FN_EXPR.test(lexedText(str))) out = true })
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
  // vega-parser makes the scales' operators before the data and connects their parameters after (parseScope: initScale, parseData,
  // parseScale): a scale whose parameters read a dataset or anything made after it (see `scaleIsLate`) is reranked past every
  // operator so far, and with it, depth first, the datasets whose transforms read it by name (in the order they were connected)
  const scope: GuideScope = { path: [], nextChild: { n: 0 }, scales: chart.scales, data: chart.data }
  const readers = new Map<string, string[]>()
  for (const d of chart.data) {
    const read = new Set<string>()
    walkStrings(d.transform, (str) => { for (const sc of scalesReadIn(str)) read.add(sc) })
    for (const sc of read) { const r = readers.get(sc); if (r) r.push(d.name); else readers.set(sc, [d.name]) }
  }
  for (const s of chart.scales) {
    const list = readers.get(s.name)
    if (list === undefined || !scaleIsLate(s, scope, chart)) continue
    ++counter
    const queue = [...list].reverse()
    for (let pops = 0; queue.length && pops < 4 * n * n + 16; pops++) {
      const cur = queue.pop()!
      rank.set(cur, ++counter)
      const next = targets.get(cur)
      if (next) for (let i = next.length; --i >= 0;) queue.push(next[i]!)
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

/**
 * What a mark subtree reads: datasets, scales (by name or through expressions). `allData`: it may read any dataset (the items of
 * another mark, or a dataset an expression reads by a computed name); otherwise `exprData` are the datasets its expressions read by
 * the names they spell out (`vlSelectionTest("brush_store", datum)`), besides `names`, the datasets it names as a whole string.
 */
interface MarkDeps { names: Set<string>; allData: boolean; exprData: readonly string[]; scales: Set<string>; allScales: boolean }
const MARK_DEPS = new WeakMap<CompiledMark, MarkDeps>()

function markDepsOf(mark: CompiledMark, chart: CompiledChart): MarkDeps {
  let deps = MARK_DEPS.get(mark)
  if (deps) return deps
  const known = new Set(chart.data.map((d) => d.name))
  const out: MarkDeps = { names: new Set(), allData: false, exprData: [], scales: new Set(), allScales: false }
  // a mark reading another mark's items (`from: {data: <mark name>}`) depends on whatever that mark depends on
  const readsMarkItems = (m: CompiledMark): boolean => {
    const from = m.from?.data
    const lookupFrom = (m.transform ?? []).some((t) => t.type === 'lookup' && typeof (t as { from?: unknown }).from === 'string' && !known.has((t as { from: string }).from))
    if ((typeof from === 'string' && !known.has(from)) || lookupFrom || (m.marks ?? []).some(readsMarkItems)) return true
    return false
  }
  if (readsMarkItems(mark)) out.allData = true
  const exprData = new Set<string>()
  const projections = projectionDepsOf(chart)
  walkStrings(mark, (str, owner) => {
    if (known.has(str)) out.names.add(str)
    // (a projection it names, in a transform or an expression: what that projection is fitted to, see `projectionDepsOf`)
    for (const p of projectionsNamedIn(str, projections)) {
      for (const n of p.names) out.names.add(n)
      if (p.allData) out.allData = true
    }
    // (the text as the lexer reads it: an escaped name is the name it stands for)
    // (the datasets an expression reads by name, or all of them: see `datasetsReadIn`, which reads the hierarchy functions too)
    const read = datasetsReadIn(str)
    if (read === null) out.allData = true
    // (a mark's items read by name, `data('<mark>')`, depend on whatever that mark depends on, as `from: {data: <mark>}` does)
    else for (const n of read) { exprData.add(n); if (!known.has(n) && markNamesOf(chart).has(n)) out.allData = true }
    // (the text as the lexer reads it: an escaped name is the name it stands for)
    if (SCALE_FN_EXPR.test(lexedText(str))) out.allScales = true
    if (owner && typeof owner.scale === 'string' && owner.scale === str) out.scales.add(str)
  }, new Set(), null, (o) => {
    // A scale chosen by a signal/expression object: any scale may be read.
    if (o.scale != null && typeof o.scale === 'object') out.allScales = true
  })
  out.exprData = [...exprData].sort()
  MARK_DEPS.set(mark, out)
  return out
}

/** The scale names a mark subtree can depend on. */
function markScaleNames(mark: CompiledMark, chart: CompiledChart): string[] {
  const deps = markDepsOf(mark, chart)
  return deps.allScales ? chart.scales.map((s) => s.name) : [...deps.scales]
}

// ---------------------------------------------------------------------------
// What a top-level scale or leaf mark reads of the signals
// ---------------------------------------------------------------------------

/**
 * The view's own signals. Every key holds them, named or not: a scale's `range: "width"`, a `{field: {group: "width"}}` and the
 * frame read the view's size without an expression that names it.
 */
const KEYED_VIEW_SIGNALS = ['width', 'height', 'padding', 'autosize', 'background']

/**
 * Calls whose result is not a function of the signals and the data a definition names: the clock, the random source, the host's
 * window, and the geo functions (a projection is made from signals of its own). A definition that makes one is keyed by every
 * signal.
 */
const UNNAMED_READ_CALL = /\b(now|random|sampleNormal|sampleLogNormal|sampleUniform|windowSize|screen|containerSize|geo[A-Za-z]*)\s*\(/

const NAMES_MENTIONED = new WeakMap<object, readonly string[] | null>()

/**
 * The names a scale or mark definition mentions: every identifier in every string of it, expression or not, and the view's
 * signals. A signal is read by an expression by its name and by nothing else (the expression functions are handed the scales, the
 * datasets and the projections, never the signals), so this holds every signal the definition reads, and more. `null`: the
 * definition reads more than it names (see {@link UNNAMED_READ_CALL}, or a projection, by name).
 */
function namesMentioned(def: object, chart: CompiledChart): readonly string[] | null {
  let out = NAMES_MENTIONED.get(def)
  if (out !== undefined) return out
  const names = new Set<string>(KEYED_VIEW_SIGNALS)
  const strings = new Set<string>()
  let unnamed = false
  walkStrings(def, (str) => {
    strings.add(str)
    // (as the lexer reads it: `n\u006fw()` calls `now`, and a name may be escaped or past ASCII: see `namesIn`)
    if (UNNAMED_READ_CALL.test(lexedText(str))) unnamed = true
    namesIn(str, names)
  })
  for (const p of chart.projections ?? []) if (strings.has(p.name)) unnamed = true
  out = unnamed ? null : [...names].sort()
  NAMES_MENTIONED.set(def, out)
  return out
}

/**
 * The signals a top-level leaf mark may read, or `null` for all of them. A mark with transforms reads all of them: a `label` reads
 * the items of other marks, a `force` or a word cloud may draw from the random source, a geo transform a projection. So does a
 * mark that reads the items of another mark, or a dataset by a name an expression computes (`markDepsOf(...).allData`). A mark
 * whose expressions read datasets by the names they spell out (a selection test) reads the signals it names, and those datasets'
 * rows (see `markKeyOf`).
 */
function markReadsOf(mark: CompiledMark, chart: CompiledChart): readonly string[] | null {
  if (mark.transform?.length || markDepsOf(mark, chart).allData) return null
  return namesMentioned(mark, chart)
}

/**
 * The signals a top-level scale may read, or `null` for all of them: a scale whose parameters read a dataset or another scale from
 * an expression (`domain: {signal: "domain('x')"}`) depends on more than its definition names.
 */
function scaleReadsOf(s: CompiledScale, chart: CompiledChart): readonly string[] | null {
  let reads = SCALE_READS.get(s)
  if (reads === undefined) {
    let any = false
    walkStrings(s, (str) => { const text = lexedText(str); if (DATA_FN_EXPR.test(text) || SCALE_FN_EXPR.test(text) || TREE_FN_EXPR.test(text)) any = true })
    reads = { signals: any ? null : namesMentioned(s, chart), datasets: datasetsNamed(s, chart) }
    SCALE_READS.set(s, reads)
  }
  return reads.signals
}

const SCALE_READS = new WeakMap<CompiledScale, { signals: readonly string[] | null; datasets: readonly string[] }>()

/** The datasets a definition names anywhere (a scale's `domain.data`, `domain.fields[].data`). */
function datasetsNamed(def: object, chart: CompiledChart): readonly string[] {
  const known = new Set(chart.data.map((d) => d.name))
  const out = new Set<string>()
  walkStrings(def, (str) => { if (known.has(str)) out.add(str) })
  return [...out]
}

/**
 * Whether a scale the previous evaluation made, under signals that have changed since, was made under what this one reads: the
 * signals it reads (`scaleKeyOf`) are as they were, the caller tells what changed and nothing of this pass failed. It is then the
 * scale this evaluation makes when the datasets it names are the very arrays it was made from (`sameRows`), or, for the dataset of
 * its domain, rows a pulse says how they changed (its census advances, as when no signal changed). A scale with bins made in a
 * pass of a view that fits its viewport is made again: what it leaves for the next pass (see `ScaleContext.pass`) is the pass's own.
 */
function keyedScale(s: CompiledScale, ctx: EvalContext, prevEntry: ScaleEntry, key: string): boolean {
  if (!followsChanges(ctx) || !cleanPass(ctx) || prevEntry.key !== key || scaleReadsOf(s, ctx.chart) === null) return false
  return !(ctx.passMemory !== undefined && (prevEntry.scale as { bins?: unknown }).bins)
}

/** The arrays of the datasets a scale names, as they are now. */
const scaleRowsOf = (s: CompiledScale, ctx: EvalContext): unknown[] => {
  scaleReadsOf(s, ctx.chart)
  return SCALE_READS.get(s)!.datasets.map((n) => ctx.datasets.get(n))
}

/**
 * What a result that reads the signals `names` is made under besides its data and its scales: those signals' values, the view's
 * size, the inputs of `extraFp` (domainRaw, the text measurer, container size) and the expression functions registered. Read every
 * signal (`names` null), it is the whole context fingerprint, as it was before a result was keyed by what it reads.
 */
function readsKey(ctx: EvalContext, names: readonly string[] | null): string {
  if (names === null) return `*${ctxFpOf(ctx)}`
  const params = ctx.signalParams
  // (the signals' part is the same for every key made between two writes of the params: see the sites that clear `fpMemo`)
  const memo = ctx.readsMemo?.params === params ? ctx.readsMemo : (ctx.readsMemo = { params, keys: new Map(), values: new Map() })
  const made = memo.keys.get(names)
  if (made !== undefined && made.width === ctx.width && made.height === ctx.height) return made.key
  let key = `${ctx.extraFp}\u0002${ctx.width}x${ctx.height}\u0002${expressionRegistryEpoch()}`
  for (const n of names) {
    if (!Object.hasOwn(params, n)) continue
    let value = memo.values.get(n)
    if (value === undefined) memo.values.set(n, (value = `\u0001${n}=${dependencyKey(params[n])}`))
    key += value
  }
  memo.keys.set(names, { width: ctx.width, height: ctx.height, key })
  return key
}

const VETS_URLS = new WeakMap<CompiledMark, boolean>()

/**
 * A mark's key (see `readsKey`); an image or a link is also made under the host's URL policy, which vets its urls. A mark whose
 * expressions read datasets by name (`markDepsOf(...).exprData`: a selection's store) is also made from their rows: each one's
 * `datasetKey`, by content (a store is a few rows, a new array whenever the event loop edits it) or, past what a fingerprint takes
 * in, by the array, when the caller tells every change and did not name it as changed (otherwise equal to no other key).
 */
function markKeyOf(mark: CompiledMark, ctx: EvalContext, reads: readonly string[] | null = markReadsOf(mark, ctx.chart)): string {
  let key = readsKey(ctx, reads)
  let vets = VETS_URLS.get(mark)
  if (vets === undefined) VETS_URLS.set(mark, (vets = mark.type === 'image' || encodesHref(mark)))
  if (vets) key = `${key}\u0003${ctx.urlPolicy === undefined ? '' : dependencyKey(ctx.urlPolicy)}`
  const deps = markDepsOf(mark, ctx.chart)
  if (!deps.allData) for (const n of deps.exprData) key += `\u0004${n}=${datasetKey(ctx, n)}`
  return key + encodeLogKey(mark, ctx)
}
const scaleKeyOf = (s: CompiledScale, ctx: EvalContext): string => readsKey(ctx, scaleReadsOf(s, ctx.chart))

/**
 * Whether the evaluation may keep what the previous one made when the signals changed: the caller says what changed (`dataChanges`,
 * `dataPulse`, `changedDatasets`), or follows the session's contract (see {@link DataStability}), so a dataset array it was given
 * before still holds the rows it held. Not under `limits`: a result that is kept is not counted against them again (as it is when
 * nothing changed).
 */
const followsChanges = (ctx: EvalContext): boolean => (ctx.incremental || ctx.unchanged !== undefined) && activeMeter() === null

/**
 * Nothing of this pass failed so far: a pass that stopped somewhere (a signal, a dataset, a scale or an encode threw) makes what
 * vega made before the stop, which is not what a clean pass made before.
 */
function cleanPass(ctx: EvalContext): boolean {
  return ctx.failed !== true && ctx.abort.cut === undefined && ctx.abort.failures.length === 0 && ctx.lateTaint === undefined
    && ctx.encodeAborted !== true && ctx.datasetAborted !== true && ctx.bareEncode !== true
}

/**
 * Whether dataset `name` holds the rows the previous evaluation's scales and marks read: the very array, which no change the caller
 * named touched (a pulse updates an array in place only for a dataset it names). A dataset re-derived since is a new array: not
 * the same, whatever its rows (see `sameData`).
 */
function sameRows(ctx: EvalContext, name: string): boolean {
  // (a name that is a mark's, not a dataset's: its items, which nothing pins across evaluations, are never known to be the same)
  if (!ctx.datasets.has(name) && markNamesOf(ctx.chart).has(name)) return false
  return !ctx.affected.has(name) && samePin(ctx.prev?.rows.get(name), ctx.datasets.get(name))
}

/** The names of a chart's marks, at any depth (what `data('<name>')` and `from: {data: <name>}` may read instead of a dataset). */
const MARK_NAMES = new WeakMap<CompiledChart, ReadonlySet<string>>()
function markNamesOf(chart: CompiledChart): ReadonlySet<string> {
  let out = MARK_NAMES.get(chart)
  if (out === undefined) {
    const names = new Set<string>()
    const visit = (marks: readonly CompiledMark[] | undefined): void => {
      for (const m of marks ?? []) {
        if (typeof m.userName === 'string') names.add(m.userName)
        visit(m.marks)
      }
    }
    visit(chart.marks)
    MARK_NAMES.set(chart, (out = names))
  }
  return out
}

/**
 * Whether `rows` are, row by row, the rows the items were made from (each item's `datum` is a copy of its row, made when it was
 * encoded): the same own enumerable fields with the same values (`Object.is`: `0` and `-0` differ, `NaN` is `NaN`). A row whose prototype is not a plain object's,
 * or that has symbol-keyed fields, is not compared: it is not the same.
 */
function sameData(rows: readonly Row[], items: readonly SceneItem[]): boolean {
  if (rows.length !== items.length) return false
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i] as Record<string, unknown> | undefined
    const b = (items[i] as { datum?: Record<string, unknown> } | undefined)?.datum
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
    const pa = Object.getPrototypeOf(a)
    const pb = Object.getPrototypeOf(b)
    if ((pa !== Object.prototype && pa !== null) || (pb !== Object.prototype && pb !== null)) return false
    let n = 0
    for (const k in a) {
      n++
      if (!Object.hasOwn(b, k)) return false
      const x = a[k]
      const y = b[k]
      if (!Object.is(x, y)) return false
    }
    for (const _k in b) n--
    if (n !== 0) return false
    if (Object.getOwnPropertySymbols(a).length !== 0 || Object.getOwnPropertySymbols(b).length !== 0) return false
  }
  return true
}

/**
 * Whole-group reuse (a top-level leaf mark whose output provably equals last
 * evaluation's). Every input the mark reads must be unchanged: the evaluation
 * context (signals, size, overrides), each dataset it reads (closed over
 * dependencies), and each scale it reads (by object identity). A group mark is
 * not reused here: its items are laid out by later passes, and a top-level one
 * is kept whole, with everything it wrote into the evaluation, by `keptGroupMark`.
 *
 * With the whole context unchanged and the changes told, a dataset the caller did not name is unchanged. Otherwise the signals the
 * mark reads (`markKeyOf`) must be as they were, and the datasets it reads must be shown to be: the same arrays (`sameRows`), or
 * for its `from` dataset, rows equal to those its items were made from (`sameData`: a dataset re-derived since is a new array).
 */
function canReuseMarkGroup(mark: CompiledMark, ctx: EvalContext, prevGroup: SceneGroup, key: string): boolean {
  // (`key` is `markKeyOf(mark, ctx)`, recorded for the next evaluation by the caller)
  const prev = ctx.prev
  if (!prev || mark.type === 'group' || !cleanPass(ctx) || forceBound(mark, ctx.chart)) return false
  const deps = markDepsOf(mark, ctx.chart)
  if (prev.markKeys.get(mark) !== key) return false
  if (ctx.incremental && prev.fp === ctx.draft.fp) {
    if (deps.allData ? ctx.affected.size > 0 : [...deps.names].some((n) => ctx.affected.has(n))) return false
  } else {
    if (!followsChanges(ctx) || markReadsOf(mark, ctx.chart) === null) return false
    const source = mark.from?.data
    for (const n of deps.names) if (n !== source && !sameRows(ctx, n)) return false
    if (source !== undefined && !sameRows(ctx, source)) {
      // (a sort orders the items by what the encode made of them, ties in data order: the rows are compared in the items' order,
      // which is theirs when the sort left them in place)
      if (ctx.affected.has(source) || !ctx.datasets.has(source)) return false
      if (!sameData(ctx.datasets.get(source)!, prevGroup.items as SceneItem[])) return false
    }
  }
  for (const name of markScaleNames(mark, ctx.chart)) {
    if (ctx.scales.get(name) !== prev.scales.get(name)) return false
  }
  return true
}

/**
 * What a top-level group mark is made under besides its data and its scales (`markKeyOf` over the whole group definition: every
 * signal any mark, scale, dataset, axis, legend, title or layout inside it names, the view size, `extraFp` and the registry), and the
 * host's URL policy when something inside it is an image or a link.
 */
function groupMarkKeyOf(mark: CompiledMark, ctx: EvalContext): string {
  const deps = groupDepsOf(mark, ctx.chart)
  let key = readsKey(ctx, mark.transform?.length || deps.allData ? null : namesMentioned(mark, ctx.chart))
  if (subtreeOf(mark).vets) key = `${key}\u0003${ctx.urlPolicy === undefined ? '' : dependencyKey(ctx.urlPolicy)}`
  // (the datasets its expressions read by name, by content: a selection's store; see `markKeyOf`)
  if (!deps.allData) for (const n of deps.exprData) key += `\u0004${n}=${datasetKey(ctx, n)}`
  return key + encodeLogKey(mark, ctx)
}

/**
 * `markDepsOf` for a group mark: what its subtree reads, where a mark inside it reading a dataset of a scope inside the subtree (a
 * facet's partition, a group's own `data`) reads that dataset, not the items of a mark of that name. `allData` stays for a mark that
 * reads a name no scope around it declares (another mark's items), and for an expression that reads a dataset by a computed name.
 */
const GROUP_DEPS = new WeakMap<CompiledMark, MarkDeps>()
function groupDepsOf(mark: CompiledMark, chart: CompiledChart): MarkDeps {
  let out = GROUP_DEPS.get(mark)
  if (out !== undefined) return out
  const base = markDepsOf(mark, chart)
  if (!base.allData) out = base
  else {
    let computed = false
    walkStrings(mark, (str) => { if (datasetsReadIn(str) === null) computed = true })
    out = { ...base, allData: computed || readsMarksIn(mark, new Set(chart.data.map((d) => d.name)), new Set(), 0) }
  }
  GROUP_DEPS.set(mark, out)
  return out
}

/** Whether a mark of the subtree reads a name that is neither a dataset of the view nor one a scope around it declares. */
function readsMarksIn(m: CompiledMark, known: ReadonlySet<string>, scoped: ReadonlySet<string>, depth: number): boolean {
  if (depth > 64) return true
  const visible = (n: unknown): boolean => typeof n !== 'string' || known.has(n) || scoped.has(n)
  const facet = (m.from as { facet?: FacetDef } | undefined)?.facet
  if (!visible(m.from?.data) || (facet !== undefined && !visible(facet.data))) return true
  const lookups = [...(m.transform ?? []), ...(m.data ?? []).flatMap((d) => d.transform ?? [])] as Array<{ type?: unknown; from?: unknown }>
  if (lookups.some((t) => t?.type === 'lookup' && !visible(t.from))) return true
  if (!m.marks?.length) return false
  const inner = new Set(scoped)
  if (facet !== undefined && typeof facet.name === 'string') inner.add(facet.name)
  for (const d of m.data ?? []) inner.add(d.name)
  // (a group's own datasets read each other in order, and `source` names one of the view's or of a scope around it)
  for (const d of m.data ?? []) for (const n of sourceNames(d)) if (!visible(n) && !inner.has(n)) return true
  return m.marks.some((c) => readsMarksIn(c, known, inner, depth + 1))
}

/** What a group mark's subtree holds that decides whether it may be kept (see `keptGroupMark`). */
interface GroupSubtree { vets: boolean; refused: boolean }
const GROUP_SUBTREES = new WeakMap<CompiledMark, GroupSubtree>()
/**
 * Transforms whose run writes what the evaluation shares beyond the subtree, or reads other marks: `identifier` numbers from the
 * view's counter, `force` rewrites the link rows of the evaluation, `stratify` and `nest` make the hierarchies tree functions read,
 * `label` reads the marks it avoids.
 */
const SHARED_STATE_TRANSFORMS = new Set(['identifier', 'force', 'stratify', 'nest', 'label'])
function subtreeOf(mark: CompiledMark): GroupSubtree {
  let out = GROUP_SUBTREES.get(mark)
  if (out !== undefined) return out
  out = { vets: false, refused: false }
  const visit = (m: CompiledMark, depth: number): void => {
    if (depth > 64) { out!.refused = true; return }
    if (m.type === 'image' || encodesHref(m)) out!.vets = true
    // (a scope with signals of its own: their values are held under the scope's id, which no definition names)
    if (m.signalDefs?.length) out!.refused = true
    for (const t of [...(m.transform ?? []), ...(m.data ?? []).flatMap((d) => d.transform ?? [])] as Array<{ type?: unknown }>) {
      if (typeof t?.type !== 'string' || SHARED_STATE_TRANSFORMS.has(t.type)) out!.refused = true
    }
    for (const c of m.marks ?? []) visit(c, depth + 1)
  }
  visit(mark, 0)
  GROUP_SUBTREES.set(mark, out)
  return out
}

/**
 * The group items a top-level group mark made in the evaluation before, kept whole, or null when it is to be made.
 *
 * A group mark's items are a function of: its definition; the signals its subtree names and the view size, `extraFp` (overrides,
 * text metrics, container sizes, locale, time zone) and the registered functions (all in `key`); the datasets the subtree names or
 * reads by name from expressions (each the very array the evaluation before read, which no change told touched: `sameRows`); the
 * top-level scales it reads (the same objects); the URL policy (in `key` when something inside it is vetted); whether tuples are
 * registered. A subtree that reads more than it names is never kept: one that may read any dataset (another mark's items, a computed
 * name), declares signals of its own, may draw random numbers, or runs a transform that writes what the evaluation shares (see
 * `SHARED_STATE_TRANSFORMS`). Nor is one in a pass that is not clean, under `limits` (as a kept leaf mark), in a view that fits its
 * viewport (each pass makes its own) or one with a `layout` (it writes the items' places after they are made).
 *
 * Making the mark also writes into the evaluation; a kept mark writes the same (`GroupMarkRecord`): the view scope's instance
 * counter and its last instance, the gradient definitions in order, the marks it names, and the state of its group scopes is carried
 * into the draft for the evaluation after.
 */
function keptGroupMark(mark: CompiledMark, ctx: EvalContext, key: string): SceneGroup[] | null {
  const prev = ctx.prev
  const record = prev?.groupMarks.get(mark)
  if (prev === undefined || record === undefined || record.key !== key || prev.markKeys.get(mark) !== key) return null
  if (!cleanPass(ctx) || ctx.passMemory !== undefined || ctx.chart.layout != null || forceBound(mark, ctx.chart) || mayDrawRandom(mark)) return null
  if (subtreeOf(mark).refused || record.tuples !== tuplesRegistering() || ctx.scope.nextChild.n !== record.instanceFrom) return null
  const deps = groupDepsOf(mark, ctx.chart)
  if (deps.allData || mark.transform?.length || namesMentioned(mark, ctx.chart) === null) return null
  if (!(ctx.incremental && prev.fp === ctx.draft.fp) && !followsChanges(ctx)) return null
  for (const n of [...deps.names, ...deps.exprData]) {
    if (!sameRows(ctx, n) || ctx.failedDatasets?.has(n)) return null
  }
  for (const name of deps.allScales ? ctx.chart.scales.map((sc) => sc.name) : deps.scales) {
    if (ctx.scales.get(name) !== prev.scales.get(name)) return null
  }
  ctx.scope.nextChild.n += record.instances
  if (record.last !== undefined) noteInstance(ctx.scope, record.last)
  for (const defs of record.defs) addDefs(ctx, defs)
  for (const [name, its, container] of record.named) {
    ctx.markItems.set(name, its)
    if (container !== undefined) ctx.markContainers.set(name, container)
  }
  const carry = <T>(from: Map<string, T>, to: Map<string, T>, keys: readonly string[]): void => {
    for (const k of keys) { const v = from.get(k); if (v !== undefined) to.set(k, v) }
  }
  carry(prev.scoped, ctx.draft.scoped, record.keys.scoped)
  carry(prev.numbered, ctx.draft.numbered, record.keys.numbered)
  carry(prev.instances, ctx.draft.instances, record.keys.instances)
  ctx.draft.groupMarks.set(mark, record)
  return record.items
}

/** Make a top-level group mark (`make`) and, when it was made whole in a clean pass, record it for a later evaluation to keep. */
function recordGroupMark(mark: CompiledMark, ctx: EvalContext, key: string, make: () => SceneGroup | SceneGroup[] | null): SceneGroup | SceneGroup[] | null {
  const instanceFrom = ctx.scope.nextChild.n
  const lastBefore = ctx.scope.last
  const named = new Map([...ctx.markItems].map(([k, v]) => [k, v] as const))
  const sizes = { scoped: ctx.draft.scoped.size, numbered: ctx.draft.numbered.size, instances: ctx.draft.instances.size }
  const outerLog = ctx.defsLog
  const log: SceneDef[][] = []
  ctx.defsLog = log
  let made: SceneGroup | SceneGroup[] | null
  try {
    made = make()
  } finally {
    ctx.defsLog = outerLog
    if (outerLog !== undefined) pushAll(outerLog, log)
  }
  if (!Array.isArray(made) || !cleanPass(ctx) || activeMeter() !== null || ctx.passMemory !== undefined) return made
  const after = <T>(m: Map<string, T>, from: number): string[] => [...m.keys()].slice(from)
  const record: GroupMarkRecord = {
    key,
    items: made,
    instanceFrom,
    instances: ctx.scope.nextChild.n - instanceFrom,
    ...(ctx.scope.last !== lastBefore && ctx.scope.last !== undefined ? { last: ctx.scope.last } : {}),
    defs: log,
    named: [...ctx.markItems].filter(([k, v]) => named.get(k) !== v).map(([k, v]) => [k, v, ctx.markContainers.get(k)]),
    keys: { scoped: after(ctx.draft.scoped, sizes.scoped), numbered: after(ctx.draft.numbered, sizes.numbered), instances: after(ctx.draft.instances, sizes.instances) },
    tuples: tuplesRegistering(),
  }
  ctx.draft.groupMarks.set(mark, record)
  return made
}

/**
 * The fields of its row an expression reads: `datum.f` and `datum["f"]`, or null when it reads the row some other way (passes `datum`
 * on, indexes it by a computed name) or cannot be parsed.
 */
function rowFieldsIn(code: string, out: Set<string>): boolean {
  let tree: Expr
  try { tree = parseExpressionCached(code) } catch { return false }
  let whole = false
  const visit = (n: Expr | null | undefined, depth: number): void => {
    if (whole || n == null) return
    if (depth > 256) { whole = true; return }
    switch (n.type) {
      case 'Identifier': if (n.name === 'datum') whole = true; return
      case 'MemberExpression':
        if (n.object.type === 'Identifier' && n.object.name === 'datum') {
          if (!n.computed && n.property.type === 'Identifier') { out.add(n.property.name); return }
          if (n.computed && n.property.type === 'Literal' && (typeof n.property.value === 'string' || typeof n.property.value === 'number')) { out.add(String(n.property.value)); return }
          whole = true
          return
        }
        visit(n.object, depth + 1)
        if (n.computed) visit(n.property, depth + 1)
        return
      case 'CallExpression': visit(n.callee, depth + 1); for (const a of n.arguments) visit(a, depth + 1); return
      case 'UnaryExpression': visit(n.argument, depth + 1); return
      case 'BinaryExpression': case 'LogicalExpression': visit(n.left, depth + 1); visit(n.right, depth + 1); return
      case 'ConditionalExpression': visit(n.test, depth + 1); visit(n.consequent, depth + 1); visit(n.alternate, depth + 1); return
      case 'ArrayExpression': for (const e of n.elements) visit(e, depth + 1); return
      case 'ObjectExpression': for (const p of n.properties) visit(p.value, depth + 1); return
      default: return
    }
  }
  visit(tree, 0)
  return !whole
}

/** A field path that names one field of the row as a whole (`x`, not `a.b` or `a[0]`), or null. */
const plainField = (f: unknown): string | null => (typeof f === 'string' && /^[A-Za-z_$][\w$]*$/.test(f) ? f : null)

/** The parameters of the transforms whose reads of their rows are all spelled in these parameters (see `rowFieldsOfMark`). */
const ROW_READING_TRANSFORMS: Record<string, readonly string[]> = { voronoi: ['type', 'x', 'y', 'size', 'extent', 'as'] }

/**
 * The fields of its rows a leaf mark reads -- through its encode (fields of the entries, expressions in `signal` and `test`) and its
 * transforms -- or null when it may read others (a field by a path or a computed name, the row passed on whole, a transform whose
 * reads are not all spelled in parameters this knows, a sort or a key).
 */
const ROW_FIELDS = new WeakMap<CompiledMark, ReadonlySet<string> | null>()
function rowFieldsOfMark(mark: CompiledMark): ReadonlySet<string> | null {
  if (ROW_FIELDS.has(mark)) return ROW_FIELDS.get(mark)!
  const out = new Set<string>()
  let known = mark.sort === undefined && mark.key === undefined
  const entry = (v: unknown, depth: number): void => {
    if (!known || v === null || typeof v !== 'object') return
    if (depth > 64) { known = false; return }
    if (Array.isArray(v)) { for (const x of v) entry(x, depth + 1); return }
    const o = v as Record<string, unknown>
    for (const [k, x] of Object.entries(o)) {
      if (k === 'field') {
        if (typeof x === 'string') { const f = plainField(x); if (f === null) known = false; else out.add(f) }
        else if (x !== null && typeof x === 'object') {
          const ref = x as Record<string, unknown>
          // (a field of the group or of its parent is not the row's; a field named by a signal may be any of them)
          if ('datum' in ref) { const f = plainField(ref.datum); if (f === null) known = false; else out.add(f) } else if (!('group' in ref) && !('parent' in ref)) known = false
          else entry(x, depth + 1)
        }
      } else if ((k === 'signal' || k === 'test' || k === 'expr') && typeof x === 'string') {
        if (!rowFieldsIn(x, out)) known = false
      } else entry(x, depth + 1)
    }
  }
  entry(mark.encode, 0)
  for (const t of (mark.transform ?? []) as unknown as Array<Record<string, unknown>>) {
    const params = typeof t.type === 'string' ? ROW_READING_TRANSFORMS[t.type] : undefined
    if (params === undefined || Object.keys(t).some((k) => !params.includes(k))) { known = false; break }
    for (const k of ['x', 'y']) {
      const v = t[k]
      if (typeof v === 'string') { const f = plainField(v); if (f === null) known = false; else out.add(f) } else entry(v, 0)
    }
  }
  const result = known ? out : null
  ROW_FIELDS.set(mark, result)
  return result
}

/** What a leaf mark drawn from another mark's items is made under besides those items (see `keptOverMarkItems`). */
function overMarkItemsKey(mark: CompiledMark, ctx: EvalContext): string | null {
  const names = namesMentioned(mark, ctx.chart)
  if (names === null) return null
  let key = readsKey(ctx, names)
  if (mark.type === 'image' || encodesHref(mark)) key = `${key}\u0003${ctx.urlPolicy === undefined ? '' : dependencyKey(ctx.urlPolicy)}`
  for (const n of markDepsOf(mark, ctx.chart).exprData) key += `\u0004${n}=${datasetKey(ctx, n)}`
  return key
}

/**
 * Whether a top-level leaf mark drawn from another mark's items (`from: {data: <mark name>}`: its rows are copies of those items, a
 * Vega-Lite voronoi over a rule's items) makes the group it made in the evaluation before: what it reads of its rows is what it read
 * then, and so is everything else it reads. Its rows are read only through the fields `rowFieldsOfMark` finds (refused when it cannot
 * tell), so item by item those fields of the items it is drawn from must hold the same values (`Object.is`: an object, such as an
 * item's datum, by identity) -- an item kept by its mark is the same item. Besides: the signals it names (with the view size,
 * `extraFp` and the registry), the content of the datasets its expressions read by name and the URL policy (`overMarkItemsKey`); the
 * datasets it names (`sameRows`); the scales it reads (the same objects); whether tuples are registered. Refused: a mark that reads a
 * dataset by a computed name or other marks' items through a lookup, a pass that is not clean, under `limits`, a view that fits its
 * viewport.
 */
function keptOverMarkItems(mark: CompiledMark, ctx: EvalContext, prevGroup: SceneGroup): 'same' | 'datums' | null {
  const prev = ctx.prev
  const source = mark.from?.data
  const record = prev?.markSources.get(mark)
  if (prev === undefined || record === undefined || typeof source !== 'string' || ctx.datasets.has(source)) return null
  const items = markRowItems(ctx, source)
  if (items === undefined || items.length !== record.items.length || (prevGroup.items?.length ?? -1) !== items.length || record.tuples !== tuplesRegistering()) return null
  if (!cleanPass(ctx) || !(followsChanges(ctx) || (ctx.incremental && prev.fp === ctx.draft.fp)) || ctx.passMemory !== undefined || forceBound(mark, ctx.chart) || mark.sort !== undefined) return null
  if (record.key !== overMarkItemsKey(mark, ctx) || prev.markKeys.get(mark) === undefined) return null
  if (((mark.transform ?? []) as Array<{ type?: unknown; from?: unknown }>).some((t) => t.type === 'lookup')) return null
  let computed = false
  walkStrings(mark, (str) => { if (datasetsReadIn(str) === null) computed = true })
  if (computed) return null
  const deps = markDepsOf(mark, ctx.chart)
  for (const n of deps.names) if (!sameRows(ctx, n)) return null
  for (const name of markScaleNames(mark, ctx.chart)) if (ctx.scales.get(name) !== prev.scales.get(name)) return null
  const fields = rowFieldsOfMark(mark)
  let same = true
  for (let i = 0; i < items.length; i++) {
    const a = record.items[i] as unknown as Record<string, unknown>
    const b = items[i] as unknown as Record<string, unknown>
    if (a === b) continue
    same = false
    if (fields === null) return null
    for (const f of fields) if (!Object.is(a[f], b[f])) return null
  }
  return same ? 'same' : 'datums'
}

/**
 * The group a mark drawn from another mark's items makes when what it reads of its rows is as it was but the rows are not the same
 * (see `keptOverMarkItems`): each item is its item before with the datum a fresh evaluation gives it, a copy of the item it is drawn
 * from as it is now (vega's datum there is that item itself, as it is now), or the item before itself when it is drawn from the very
 * item it was (a published item holds what it held). Every other property is what it was: made from what it read, which is
 * unchanged. The group is the one before with these items.
 */
function withNewDatums(ctx: EvalContext, prevGroup: SceneGroup, from: readonly SceneItem[], was: readonly SceneItem[]): SceneGroup {
  const before = prevGroup.items as SceneItem[]
  const items = new Array<SceneItem>(before.length)
  for (let i = 0; i < before.length; i++) {
    // (drawn from the very item it was drawn from: its datum is a copy of that item, which is as it was -- the item is the one before)
    if (from[i] === was[i]) { items[i] = before[i]!; continue }
    const datum = { ...(from[i] as unknown as Row) }
    markTuple(datum)
    items[i] = { ...before[i]!, datum, __gen: ctx.gen } as SceneItem
  }
  ;(items as SceneItem[] & { __engineItems?: true }).__engineItems = true
  const group = { ...prevGroup, items } as SceneGroup
  const gradients = GROUP_GRADIENTS.get(prevGroup)
  if (gradients !== undefined) GROUP_GRADIENTS.set(group, gradients)
  return group
}

/** Record what a top-level leaf mark drawn from another mark's items was made from (see `keptOverMarkItems`), when made whole and clean. */
function recordOverMarkItems(mark: CompiledMark, ctx: EvalContext, items: readonly SceneItem[] | undefined): void {
  const key = overMarkItemsKey(mark, ctx)
  if (key === null || items === undefined || !cleanPass(ctx) || activeMeter() !== null || ctx.passMemory !== undefined) return
  // (a copy: the source mark's array is the engine's, which a later append advances in place -- the record is what was read)
  ctx.draft.markSources.set(mark, { key, items: items.slice(), tuples: tuplesRegistering() })
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
  // (a group item stands for its mark here: its mark's zindex orders it; its own orders it among its mark's items, paint-order.ts)
  const zOf = (g: SceneGroup): number => (g.markIndex !== undefined ? g.markZindex : g.zindex) || 0
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
 * autosize padding at a given content size. A view that fits its viewport
 * (`fit`/`fit-x`/`fit-y`) builds it twice: once at the viewport, once at the
 * size that leaves room for what the first build laid out (see `evaluateChartPass`).
 */
type BuiltContent = { record: PassRecord | undefined; items: SceneGroup[]; padding: ReturnType<typeof computeGuidePadding>; ctx: EvalContext; width: number; height: number; hasLayout: boolean; frame: FrameEncode | undefined }

/** What the view's own `encode` gives the root group: where it sits, and the paint of its box (see frameEncodeOf). */
interface FrameEncode { x: number; y: number; paint: Partial<SceneRoot>; aria: SceneRoot['frameAria'] }

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
  /**
   * Present: this build is a pass of a view that makes another (fit); `prev`: what the pass before it left; `first`: it is the first
   * pass, made from what the first pass of the previous evaluation left (`EvalTxn.firstPrev`).
   */
  order?: { prev?: PassRecord; first?: boolean },
): BuiltContent {
  const first = buildContentPass(chart, input, cw, ch, txn, fitted, signed, undefined, order)
  const failures = first.ctx.abort.failures
  // (a signal or a dataset that threw stopped the pass before the operators these failures are: they are not vega's)
  if (!failures.length || first.ctx.datasetAborted) {
    warnOf(first.ctx)
    return first
  }
  const cut = failures.reduce(earlierPoint)
  // The pass that stops at the first failure is made with what it reports held back: the layouts it ran are ranked before the
  // operator that threw, so their warnings come first, then the one error of the pass (what failed first, in the order vega ranks its
  // operators), then what the pass reported itself.
  const held: Array<{ level: 'error' | 'warn' | 'info' | 'debug'; args: unknown[] }> = []
  const hold = (level: 'error' | 'warn' | 'info' | 'debug') => (...args: unknown[]): void => { held.push({ level, args }) }
  const logger = first.ctx.logger
  let second: BuiltContent | undefined
  try {
    second = buildContentPass(chart, { ...input, logger: { error: hold('error'), warn: hold('warn'), info: hold('info'), debug: hold('debug') } }, cw, ch, txn, fitted, signed, cut, order)
    second.ctx.logger = logger
    warnOf(second.ctx)
  } finally {
    // (a pass that refuses the view still logs what it stopped at first)
    if (cut.error !== undefined) reportEvalError(first.ctx, cut.error)
    for (const { level, args } of held) logger[level]?.(...args)
  }
  return second
}

/**
 * Whether a dataset of the view may draw from a random source the host injected. The first pass of such a fit view keeps starting
 * from the committed state, as both passes did before each reused its own: the engine's pulse path draws without a tape (see
 * random-tape.ts), so which pass takes a pulse decides which numbers the source hands out, and the numbers must stay those.
 */
function drawsInDatasets(chart: CompiledChart, input: RuntimeInput): boolean {
  return input.random !== undefined && datasetsMayDraw(chart)
}

/** Log the warnings the layouts of the pass that is kept gave, in the order they gave them. */
function warnOf(ctx: EvalContext): void {
  for (const message of ctx.layoutState.warnings) {
    if (typeof message === 'string') ctx.logger.warn(message)
    else ctx.logger.warn(...message)
  }
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
  order?: { prev?: PassRecord; first?: boolean },
): BuiltContent {
  const prepared = prepareChartCtx(
    // (the first build reads the size from the spec and the host's input itself; only a fit-resize overrides it)
    chart, fitted ? fitResize({ ...input, width: cw, height: ch }) : input, txn,
    fitted ? { width: true, height: true } : { width: hostSize(chart, input, 'width') != null, height: hostSize(chart, input, 'height') != null },
    signed,
    order !== undefined ? { prev: order.prev, cur: { guides: new Map(), scales: new Map(), places: new Map(), legends: new Map(), inputs: new Map() } } : undefined,
    // (the first pass of a fit view whose previous evaluation left no first pass reuses the committed state, as the second does: what
    // the first claims, the second then cannot claim again, see `claim`)
    order?.first === true && !drawsInDatasets(chart, input) ? txn.firstPrev ?? txn.prev : txn.prev,
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
  // layers over one dataset, or several unnamed marks, are distinct.
  const items: SceneGroup[] = []

  // 1) Build marks (plot area)
  const marks = stopped && !madeMarks(cut!) ? [] : ctx.chart.marks
  for (let at = 0; at < marks.length; at++) {
    const mark = marks[at]!
    ctx.scope.mark = at
    const prevGroup = ctx.prev?.groups.get(mark) ?? null
    if (mark.type === 'group') {
      // (a group mark: kept whole when nothing its subtree reads changed, else made, and recorded when made whole)
      const key = groupMarkKeyOf(mark, ctx)
      ctx.draft.markKeys.set(mark, key)
      const kept = keptGroupMark(mark, ctx, key)
      if (kept !== null) { pushAll(items, kept); continue }
      const made = recordGroupMark(mark, ctx, key, () => evaluateMark(mark, ctx, prevGroup))
      if (made) {
        for (const g of Array.isArray(made) ? made : [made]) items.push(g)
      }
      continue
    }
    // (what the mark is made under besides its data and scales, for the next evaluation to compare)
    const markKey = markKeyOf(mark, ctx)
    ctx.draft.markKeys.set(mark, markKey)
    // (a mark drawn from another mark's items: the items it is drawn from now, before it is made or kept)
    const overItems = typeof mark.from?.data === 'string' && !ctx.datasets.has(mark.from.data) ? markRowItems(ctx, mark.from.data) : undefined
    const reused = prevGroup !== null && canReuseMarkGroup(mark, ctx, prevGroup, markKey)
    const keptOver = prevGroup !== null && !reused && overItems !== undefined ? keptOverMarkItems(mark, ctx, prevGroup) : null
    if (prevGroup !== null && (reused || keptOver !== null)) {
      if (overItems !== undefined) recordOverMarkItems(mark, ctx, overItems)
      const group = keptOver === 'datums' ? withNewDatums(ctx, prevGroup, overItems!, ctx.prev!.markSources.get(mark)!.items) : prevGroup
      items.push(group)
      ctx.draft.groups.set(mark, group)
      // (its channels read what they read: the mark's key, which holds every name they hold, is as it was)
      const channels = ctx.prev?.channels.get(mark)
      if (channels !== undefined) ctx.draft.channels.set(mark, channels)
      // (a named mark's items are what a later mark of `from: {data: <name>}` reads, as `evaluateMark` leaves them)
      if (typeof mark.name === 'string') {
        ctx.markItems.set(mark.name, (group.items ?? []) as SceneItem[])
        ctx.markContainers.set(mark.name, group as unknown as { marktype: string; items: SceneItem[] })
      }
      // (its items are not encoded again: their gradients are the group's)
      const keptGradients = GROUP_GRADIENTS.get(group)
      if (keptGradients !== undefined) addDefs(ctx, keptGradients)
      // (the numbers its items hold are kept with them)
      const key = numberedKey(mark, ctx)
      const kept = ctx.prev?.numbered.get(key)
      if (kept !== undefined) ctx.draft.numbered.set(key, kept)
      continue
    }
    const result = evaluateMark(mark, ctx, prevGroup)
    if (overItems !== undefined && result && !Array.isArray(result)) recordOverMarkItems(mark, ctx, overItems)
    if (result) {
      for (const g of Array.isArray(result) ? result : [result]) items.push(g)
      if (!Array.isArray(result)) ctx.draft.groups.set(mark, result)
    }
  }

  // The layout of the view is ranked after the last instance below it that has marks: it ran, and laid the guides out, when the pass
  // went past all of them (see `buildGroupItem`).
  // (a late signal is ranked after the operators of the view's scope and before every instance below it: the view's layout, which
  // is ranked after the last of those instances that has marks, ran if there is none)
  // (the view's own layout that threw is run again, as far as it gets: see LayoutFailure)
  const viewLayoutFailed = cut?.layout !== undefined && cut.layout.items.length === 1 && cut.layout.items[0]!.length === 0
  const unlaid = cut !== undefined && ((compareInstances(ctx.scope.path, cut.path) === 0 && cut.lateSignal !== true) || ctx.scope.unsettled === true || viewLayoutFailed || holdsFailedLayout(ctx.scope.path, cut.layout)
    // (a mark that reads the late signal connects its operators, ranked after it, to the layout)
    || (cut.lateSignal === true && (ctx.chart.marks.some((m) => markReadsTaint(m, ctx)) || withoutLateReads(ctx, () => hasLateLabels(ctx.chart.legends, ctx)) || guidesReadLate(ctx)))
    || symbolLegendsOf(ctx.chart.legends, ctx).some((_, k) => compareInstances([ctx.scope.nextChild.n + k, 0], cut.path) >= 0))
  if (unlaid) ctx.rawGuides = true

  // 2) ViewLayout of the view's root group (vega-view-transforms): a `layout`
  // grid positions the child groups (cells, headers, footers, titles) first;
  // layoutGroup then lays out the axes, legends and title around them.
  const hasLayout = ctx.chart.layout != null
  let layoutError: { error: unknown } | undefined
  if (hasLayout && (!unlaid || viewLayoutFailed)) {
    try {
      layoutFacet({ marktype: 'group', items } as unknown as SceneGroup, resolveLayoutOptions(ctx.chart.layout!, ctx), gridMemory(ctx, 'root'), layoutWarn(ctx))
    } catch (e) {
      // the grid stops where vega's does, the guides and the title are not laid out and the view is not sized (no overflow growth); the
      // operator is ranked after every instance with content, which were all made
      refuseUnrecoverable(e)
      ctx.layoutState.failed = true
      ctx.rawGuides = true
      if (!unlaid) ctx.layoutThrew = true
      layoutError = { error: e }
    }
  }
  const { groups: guideGroups } = withoutLateReads(ctx, () => stopped
    ? buildAxisAndLegend(ctx, items, ctx.chart.axes.slice(0, madeAxes(cut!)), ctx.chart.legends.slice(0, madeLegends(cut!)), true)
    : buildAxisAndLegend(ctx, items, ctx.chart.axes, ctx.chart.legends, true))
  for (const g of guideGroups) items.push(g)
  // (the view's layout is ranked after every instance with content, the entries of its legends included: known once they are made)
  if (layoutError !== undefined && cut === undefined) failPass(ctx, { path: ctx.scope.last ?? [], axis: Infinity, late: true, layout: { items: [[]], at: 0 } }, layoutError.error)

  // Top-level title. (A pass that stopped at a failing dataset or signal never made it: it is ranked after them.)
  const titleGroup = (stopped && !cut!.title && !cut!.labels && !cut!.lateSignal && !cut!.lateScale) || ctx.datasetAborted ? null : withoutLateReads(ctx, () => buildTitleGroup(ctx.chart.title, items, width, height, ctx.rawGuides, ctx, undefined, isFit(autosizeOf(chart, input).type), true))
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
    || cut !== undefined
    || autosizeOf(chart, input).type === 'none'
    // (no autosize type at all: the layout returns before it measures anything)
    || autosizeOf(chart, input).type === 'skip'
    ? viewLayout(chart, input).padding
    : computeGuidePadding(items, width, height, viewLayout(chart, input).padding, isFit(autosizeOf(chart, input).type))
  const ordered = paintOrderOf(items)
  // (made and laid out: what is the same as the content of this pass in the evaluation before is that content)
  const content = ctx.prev?.content !== undefined ? shareContent(ctx.prev.content, ordered) : ordered
  ctx.draft.content = content
  // (a group mark recorded in this pass keeps the nodes the scene holds: the ones `shareContent` put in place of its own)
  if (content !== ordered && ctx.draft.groupMarks.size) {
    const shared = new Map<SceneGroup, SceneGroup>()
    for (let i = 0; i < ordered.length; i++) if (content[i] !== ordered[i]) shared.set(ordered[i]!, content[i]!)
    for (const record of ctx.draft.groupMarks.values()) {
      if (record.items.some((g) => shared.has(g))) record.items = record.items.map((g) => shared.get(g) ?? g)
    }
  }
  return { record: ctx.passMemory?.cur, items: content, padding, ctx, width, height, hasLayout, frame }
}

/**
 * The view's content as made, with every node that is the same as the node at its place in the content the evaluation before made
 * replaced by that node, so an unchanged group item, guide or title (and everything in it) keeps its identity, as a kept mark does.
 * "The same" is by value, over every own property (`sameNode`); a leaf mark's group is the same only when it is the very group (a mark
 * kept or not is decided where it is made). Runs on the laid-out content, which nothing writes afterwards. Returns `next` itself
 * when nothing could be shared.
 */
function shareContent(prev: readonly SceneGroup[], next: SceneGroup[]): SceneGroup[] {
  const out = next.slice()
  let shared = false
  for (let i = 0; i < out.length && i < prev.length; i++) {
    // (the items of group marks, and what they hold: the view's own guides and title are made from what the evaluation reads, and
    // comparing them on every evaluation would cost a chart with no group mark what it does not gain)
    if (!isGroupItem(out[i]!) || !isGroupItem(prev[i]!)) continue
    const node = shareNode(prev[i]!, out[i]!)
    if (node !== out[i]) { out[i] = node as SceneGroup; shared = true }
  }
  return shared ? out : next
}

/** `next`, or `prev` when it is the same node, or `next` with the children it shares with `prev` (a new node of this evaluation). */
function shareNode(prev: SceneNode, next: SceneNode): SceneNode {
  if (prev === next) return prev
  // (a node an earlier evaluation returned, kept whole by this one -- a kept group mark's item: it is read-only, see scene-registry.ts)
  if (isLeafMark(next) || isLeafMark(prev) || isEngineNode(next)) return next
  if (sameNode(prev, next, 0)) return prev
  const a = (prev as { items?: unknown }).items
  const b = (next as { items?: unknown }).items
  if (Array.isArray(a) && Array.isArray(b)) {
    // (a node of this evaluation's own: its children list is its own array)
    for (let i = 0; i < b.length && i < a.length; i++) b[i] = shareNode(a[i] as SceneNode, b[i] as SceneNode)
  }
  return next
}

/** An item of a group mark (a cell, a view of a concat, a header): what `shareContent` shares at the top of the view. */
const isGroupItem = (n: SceneNode): boolean => (n as { marktype?: unknown }).marktype === 'group' && (n as { markIndex?: unknown }).markIndex !== undefined
  && (n as { role?: unknown }).role !== 'mark'

/** A leaf mark's group: compared by identity only (its items may be the engine's live array, or a lazy snapshot of an older scene). */
const isLeafMark = (n: SceneNode): boolean => (n as { role?: unknown }).role === 'mark' && (n as { marktype?: unknown }).marktype !== 'group'

/** How deep `sameNode` compares before it calls two nodes different. */
const SAME_NODE_DEPTH = 64

/**
 * Whether two scene nodes are the same by value: the same own keys (symbols and non-enumerable ones included) holding the same values
 * (`Object.is`; Dates by their instant; plain arrays and objects compared the same way; any other object, a Map, a function, only
 * when it is the same object), children compared as nodes (a leaf mark's group by identity only).
 */
function sameNode(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || depth > SAME_NODE_DEPTH) return false
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) return false
  if (proto === Array.prototype) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) {
      const u = x[i]
      const v = y[i]
      if (u !== v && (isLeafMarkValue(u) || isLeafMarkValue(v) || !sameNode(u, v, depth + 1))) return false
    }
    return true
  }
  // (a box a guide records, `titleBounds`, is plain data held in a class)
  if (proto !== Object.prototype && proto !== null && proto !== Bounds.prototype) return false
  if (isLeafMark(a as SceneNode) || isLeafMark(b as SceneNode)) return false
  const ka = Reflect.ownKeys(a)
  const kb = Reflect.ownKeys(b)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]!
    if (k !== kb[i]) return false
    const da = Object.getOwnPropertyDescriptor(a, k)!
    const db = Object.getOwnPropertyDescriptor(b, k)!
    if (da.enumerable !== db.enumerable || 'get' in da || 'get' in db) return false
    if (!sameNode(da.value, db.value, depth + 1)) return false
  }
  return true
}

const isLeafMarkValue = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v) && isLeafMark(v as SceneNode)

/**
 * An evaluation whose incremental state has not been committed yet. The scene is
 * usable immediately; `commit()` makes this evaluation the base the next
 * incremental one starts from. A host that runs post-evaluation checks (the
 * session's limits) commits only after they pass, so a rejected evaluation can
 * never become the state later pulses are relative to.
 */
export interface PendingEvaluation {
  scene: SceneRoot
  commit(): void
}

/**
 * Evaluate without committing the incremental state. The compiled chart is not
 * written; call `commit()` once the scene has been accepted. `engine` is the incremental
 * engine the state is made for (see {@link IncrementalEngine}).
 */
export function evaluateChartPending(
  engine: IncrementalEngine, chart: CompiledChart, input: RuntimeInput = {}, unchanged?: DataStability,
  /** The arrays the caller's pulses are relative to, by dataset (a session: the rows it handed over last; see `hostPulse`). */
  pulseBases?: ReadonlyMap<string, unknown>,
): PendingEvaluation {
  // a refused url dataset fails the evaluation before anything of it starts (no transaction, no state)
  checkChartUrlData(chart, input.urlData)
  // a spec that makes regular expressions, under `limits.regex: 'refuse'`: refused for its spec, before anything runs
  checkChartRegex(chart, input.limits)
  const txn = beginTxn(engine, chart, unchanged)
  // (a session names the rows its hints are relative to; an `evaluateChart` caller, by the scene it was given last)
  const bases = pulseBases ?? hintBases(chart, input)
  if (bases !== undefined) txn.pulseBases = bases
  const done: { draft?: IncrementalState; failed?: boolean } = {}
  const scene = measured(input, done, () => withLimits(input.limits, () => withTextMetricsProvider(input.textMetrics, () => evaluateChartImpl(chart, input, txn, done))))
  return {
    scene,
    commit() {
      // An evaluation that logged a recovered error is not a base later pulses may be relative to
      // (its items/datasets are the partial result of a failure): the committed state goes stale.
      if (done.failed) {
        const committed = STATES.get(chart)
        if (committed) committed.stale = true
      } else if (done.draft) {
        STATES.set(chart, done.draft)
        SCENE_STATES.set(scene, done.draft.token)
      }
    },
  }
}

/** The error for a url dataset whose rows nobody loaded; `hostRows` when the host could also give them as `input.data[name]`. */
function unloadedUrlError(name: string, hostRows: boolean): Error {
  return new Error(
    `[aster] dataset "${name}" has a url but no data was loaded for it; resolve url datasets first: ` +
    `import { loadSpecData } from "@aster-charts/core/load" and render await loadSpecData(spec, { baseURL, ... })` +
    (hostRows ? `, or pass the rows as input.data["${name}"]` : ' (it is in a group mark, so loadSpecData is the way: input.data does not reach it)'),
  )
}

/**
 * Evaluate a chart once: nothing is read from an earlier evaluation of it and nothing is left for a later one, so the incremental
 * engine is not involved (`renderSpec`, `getChartInfo`). The scene is what `evaluateChart` gives a chart evaluated for the first time.
 */
export function evaluateOnce(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  checkChartUrlData(chart, input.urlData)
  // a spec that makes regular expressions, under `limits.regex: 'refuse'`: refused for its spec, before anything runs
  checkChartRegex(chart, input.limits)
  const txn: EvalTxn = { prev: undefined, gen: 1, claimed: new WeakSet() }
  return measured(input, {}, () => withLimits(input.limits, () => withTextMetricsProvider(input.textMetrics, () => evaluateChartImpl(chart, input, txn, {}))))
}

/** Run an evaluation, reporting the first error the text measurer threw in it; such an evaluation is no base for the next one. */
function measured(input: RuntimeInput, done: { failed?: boolean }, fn: () => SceneRoot): SceneRoot {
  const { value, failures } = collectMeasureFailures(fn)
  if (failures.length) {
    done.failed = true
    ;loggerOf(input.logger).error(failures[0])
  }
  return value
}

function evaluateChartImpl(chart: CompiledChart, hostInput: RuntimeInput, txn: EvalTxn, done: { draft?: IncrementalState; failed?: boolean }): SceneRoot {
  // (the tuples it makes are registered only for a chart whose expressions may ask `isTuple` of one: nothing else can ask)
  return withTupleOrigins(chart.comparesTuples === true, () => withTuples(registersTuples(chart, hostInput), () => evaluateChartPass(chart, hostInput, txn, done)))
}

/**
 * Whether an evaluation registers the tuples it makes (see `CompiledChart.callsIsTuple`). A chart that only asks of Vega-Lite's
 * `facet` signal does when the host sets that signal to an object not known to be a tuple: one of the rows it hands the chart, say,
 * which the evaluation registers as vega ingests it.
 */
function registersTuples(chart: CompiledChart, input: RuntimeInput): boolean {
  if (chart.callsIsTuple === true) return true
  if (chart.callsIsTuple !== 'facet' || input.signals === undefined || !Object.hasOwn(input.signals, 'facet')) return false
  const v = input.signals.facet
  return v !== null && typeof v === 'object' && !isTuple(v)
}

/** The background a value of the `background` signal draws: a truthy one as its text (vega-scenegraph writes it as the fill), else none. */
const backgroundText = (v: unknown): string | null => (v ? (typeof v === 'string' ? v : String(v)) : null)

/** What of the view's layout is a signal: which of its signals the spec has (declared, or made by a `{signal}` property). */
interface ViewSignalUse {
  padding: boolean
  autosize: boolean
  /** `width` / `height` signals with an `update` or an `init` */
  sizes: Array<'width' | 'height'>
  /** the view signals whose value is known before anything is built: they read no data, no scale, and no signal that does */
  early: ReadonlySet<string>
  /** a view signal with an `update` or an `init` that is early: the signals are resolved before the evaluation */
  resolve: boolean
}
const VIEW_SIGNAL_USE = new WeakMap<CompiledChart, ViewSignalUse | null>()

function viewSignalUse(chart: CompiledChart): ViewSignalUse | null {
  let use = VIEW_SIGNAL_USE.get(chart)
  if (use !== undefined) return use
  const defs = chart.signalDefs ?? []
  const index = signalIndex(chart)
  const def = (name: string): CompiledSignalDef | undefined => (index.has(name) ? defs[index.get(name)!] : undefined)
  const computed = (name: string): boolean => { const d = def(name); return d !== undefined && (d.update !== undefined || d.init !== undefined) }
  const sizes = (['width', 'height'] as const).filter(computed)
  const padding = def('padding') !== undefined
  const autosize = def('autosize') !== undefined
  if (!padding && !autosize && !sizes.length) use = null
  else {
    const early = new Set<string>()
    for (const name of ['padding', 'autosize', 'width', 'height']) if (def(name) !== undefined && !viewSignalReadsDataflow(chart, name)) early.add(name)
    // (a view that fits its viewport reads its size off its first pass, see evaluateViewPass: its sizes need not be known before)
    const sizesBefore = !isFit((chart.autosize ?? 'pad') as AutosizeType) || autosize
    const resolve = ['padding', 'autosize'].some((n) => computed(n) && early.has(n)) || (sizesBefore && sizes.some((n) => early.has(n)))
    use = { padding, autosize, sizes, early, resolve }
  }
  VIEW_SIGNAL_USE.set(chart, use)
  return use
}

/**
 * An evaluation of a view whose padding, autosize or size is a signal (a `{signal}` property, or a signal of that name the spec
 * declares). vega lays the view out with what those signals hold: the padding read by vega-view (padding.js), the autosize by its
 * `type` and `contains`, the size as the root group's. The layout is decided before the content is built (the size the content is
 * built at depends on it), so the signals that read nothing of the dataflow are resolved first, exactly as the evaluation resolves
 * them (its signals-only start). One that reads data or a scale is only known once the evaluation has run: the view is laid out with
 * what it held in the evaluation before (or the static value) and, when the evaluation finds another value, laid out again with it.
 */
function evaluateChartPass(chart: CompiledChart, hostInput: RuntimeInput, txn: EvalTxn, done: { draft?: IncrementalState; failed?: boolean }): SceneRoot {
  const use = viewSignalUse(chart)
  if (use === null) return evaluateViewPass(chart, hostInput, txn, done)
  // (the same replayable source for the signals resolved first and for the evaluation: a site draws once, see random-tape.ts)
  const input: RuntimeInput = hostInput.random ? { ...hostInput, random: replayable(hostInput.random) } : hostInput
  const known = use.resolve ? prepareChartCtx(chart, input, txn, undefined, undefined, undefined, txn.prev, true).ctx.signalParams : dict(chart.signals, input.signals)
  const fallback = txn.prev?.viewLayout ?? staticViewLayout(chart)
  // (a signal the host wrote is known whatever it reads)
  const isKnown = (name: string): boolean => use.early.has(name) || (input.signals !== undefined && Object.hasOwn(input.signals, name))
  const layoutFrom = (values: Record<string, unknown>, guess: ViewLayout): ViewLayout => ({
    padding: !use.padding ? chart.padding : values.padding !== undefined ? paddingOf(values.padding) : guess.padding,
    autosize: !use.autosize ? staticViewLayout(chart).autosize : values.autosize !== undefined ? autosizeValueOf(values.autosize) : guess.autosize,
  })
  const first = layoutFrom(known, fallback)
  // (what is not known yet keeps the guess)
  if (use.padding && !isKnown('padding')) first.padding = fallback.padding
  if (use.autosize && !isKnown('autosize')) first.autosize = fallback.autosize
  const sizes = dict<unknown>()
  for (const dim of use.sizes) if (isKnown(dim) && known[dim] !== undefined) sizes[dim] = known[dim]
  const settled = (use.padding ? isKnown('padding') : true) && (use.autosize ? isKnown('autosize') : true)
  if (settled) return evaluateViewPass(chart, { ...input, [VIEW_BEFORE]: { ...first, sizes } } as ViewInput, txn, done)
  // A padding or autosize that reads the dataflow: the evaluation tells what it is. What it logs is held until it is known to be
  // kept (then logged, and what it logs later goes straight through), or dropped with it.
  const { logger: holding, settle } = heldLogger(loggerOf(input.logger))
  let scene = evaluateViewPass(chart, { ...input, logger: holding, [VIEW_BEFORE]: { ...first, sizes } } as ViewInput, txn, done)
  const found = layoutFrom((scene as unknown as { signalParams: Record<string, unknown> }).signalParams, first)
  const kept = sameLayout(found, first)
  settle(kept)
  if (!kept) scene = evaluateViewPass(chart, { ...input, [VIEW_BEFORE]: { ...found, sizes } } as ViewInput, txn, done)
  // (the next evaluation starts from the layout this one found)
  if (done.draft) done.draft.viewLayout = found
  return scene
}

/** A logger that holds what it is given until `settle`: kept, it logs it to `logger` and passes everything after; dropped, it drops it all. */
function heldLogger(logger: Logger): { logger: Logger; settle(keep: boolean): void } {
  type Level = 'error' | 'warn' | 'info' | 'debug'
  let held: Array<{ level: Level; args: unknown[] }> | null = []
  let keep = false
  const at = (level: Level) => (...args: unknown[]): void => {
    if (held !== null) held.push({ level, args })
    else if (keep) logger[level]?.(...args)
  }
  return {
    logger: { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') },
    settle(k) {
      const was = held ?? []
      held = null
      keep = k
      if (k) for (const { level, args } of was) logger[level]?.(...args)
    },
  }
}

const sameLayout = (a: ViewLayout, b: ViewLayout): boolean =>
  a.autosize.type === b.autosize.type && a.autosize.contains === b.autosize.contains
  && a.padding.top === b.padding.top && a.padding.right === b.padding.right && a.padding.bottom === b.padding.bottom && a.padding.left === b.padding.left

function evaluateViewPass(chart: CompiledChart, hostInput: RuntimeInput, txn: EvalTxn, done: { draft?: IncrementalState; failed?: boolean }): SceneRoot {
  // an injected random source is drawn from once per site and run, however many passes and evaluations repeat it (see random-tape.ts)
  const input: RuntimeInput = hostInput.random ? { ...hostInput, random: replayable(hostInput.random) } : hostInput
  // (the spec's autosize, or a fit to the container the host measured: see autosizeOf)
  const { type: auto, contains: autosizeContains } = autosizeOf(chart, input)
  const base = viewLayout(chart, input).padding
  // Differential-update generation (`txn.gen`): an unchanged (reused) item keeps
  // the generation it was encoded in, so the DOM patcher can skip it.
  const signals = sizeSignals(chart, input)
  let initialW = resolveSize(chart.width, viewOverride(chart, input, 'width'), signals)
  let initialH = resolveSize(chart.height, viewOverride(chart, input, 'height'), signals)
  // A negative view size: vega's first pass lays out content ranged on the signal as written (a scale over
  // [0, -100]) and sizes the view from the overflow it finds (viewSizeLayout, once); the width / height
  // signals are then clamped to 0 and the content is encoded again, but the view keeps the size and padding of
  // the first pass. So the padding comes from a build with the signed sizes and the content from the clamped one.
  const signedW = signedViewSize(chart.width, viewOverride(chart, input, 'width'), signals)
  const signedH = signedViewSize(chart.height, viewOverride(chart, input, 'height'), signals)
  const signedPadding = (signedW !== undefined || signedH !== undefined) && auto === 'pad'
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
  // (autosize none containing the padding: the view's width and height, the padding taken out, sign and all)
  let insidePadding: { width: number; height: number } | undefined
  if (auto === 'none' && autosizeContains === 'padding') {
    // autosize `none` with `contains: "padding"`: the view's width / height INCLUDE the padding, so the group (the
    // width / height signals, every scale and expression that reads them) gets what is left (vega-view-transforms
    // viewSizeLayout: `width = viewWidth`, the padding taken out of it), as a resize of the view does.
    // (a size that is a signal reading the dataflow is only known once a pass has run: one unfitted pass finds it, as vega's first
    // dataflow run does before its layout resizes the view)
    if (sizeReadsDataflow(chart, input, 'width') || sizeReadsDataflow(chart, input, 'height')) {
      const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined }
      const found = buildContent(chart, { ...input, logger: quiet }, initialW, initialH, txn, false)
      initialW = found.width
      initialH = found.height
    }
    cw = initialW - base.left - base.right
    ch = initialH - base.top - base.bottom
    // A size smaller than the padding (no width at all, say) leaves a negative view: vega keeps it (viewSizeLayout does not clamp
    // `width = viewWidth` for `none`), so the signals, the scales and the root group's box are laid out on it, the layout reading
    // it as 0, and the svg is `Math.max(0, view + padding)` (vega-view render-size).
    insidePadding = { width: cw, height: ch }
    built = buildContent(chart, input, cw, ch, txn, true, cw < 0 || ch < 0 ? { width: cw < 0 ? cw : undefined, height: ch < 0 ? ch : undefined } : undefined)
  } else {
    built = buildContent(chart, input, cw, ch, txn, false, undefined, fitting ? { first: true } : undefined)
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
      const padW = autosizeContains === 'padding' ? base.left + base.right : 0
      const padH = autosizeContains === 'padding' ? base.top + base.bottom : 0
      if (auto === 'fit') { nw = Math.max(0, initialW - padW - oL - oR); nh = Math.max(0, initialH - padH - oT - oB) }
      else if (auto === 'fit-x') { nw = Math.max(0, initialW - padW - oL - oR); nh = ch }
      else { nw = cw; nh = Math.max(0, initialH - padH - oT - oB) }
      // (the view is the fitted viewport even when the content does not move: a dimension of 0 stays 0 whatever overflows it)
      firstPassPadding = built.padding
      if (nw !== cw || nh !== ch) {
        cw = nw
        ch = nh
        const first = built.ctx
        // (the second pass is made from the committed state, the second pass of the previous evaluation, at the fitted size it had:
        // what changed since is what changed since then, so the pass is told, as the first was)
        built = buildContent(chart, input, cw, ch, txn, true, undefined, built.record !== undefined ? { prev: built.record } : undefined)
        // The next evaluation's first pass is made from this one's (see `IncrementalState.fitFirst`), unless it logged a recovered error:
        // as for the committed state (see `commit()`), the partial result of a failure is not a base (the next first pass is then made
        // from the committed state).
        if (!first.failed) built.ctx.draft.fitFirst = first.draft
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
  const contains = autosizeContains === 'padding'
  // (no layout, or one of no known type, leaves the view the size its signals and padding give it -- the padding taken out of it
  // first when the size contains it (vega-view `viewWidth`) -- and the content the size of its `width` / `height`)
  const unlaid = auto === 'skip' || auto === 'shift'
  const sceneWidth = insidePadding !== undefined
    ? Math.max(0, insidePadding.width + base.left + base.right)
    : fitW
    ? initialW + (contains ? 0 : base.left + base.right)
    : unlaid
      ? Math.max(0, width + (contains ? 0 : base.left + base.right))
      : auto !== 'none'
        ? width + padding.left + padding.right
        : width + base.left + base.right
  const sceneHeight = insidePadding !== undefined
    ? Math.max(0, insidePadding.height + base.top + base.bottom)
    : fitH
    ? initialH + (contains ? 0 : base.top + base.bottom)
    : unlaid
      ? Math.max(0, height + (contains ? 0 : base.top + base.bottom))
      : auto !== 'none'
        ? height + padding.top + padding.bottom
        : height + base.top + base.bottom

  const scene: SceneRoot = {
    width: sceneWidth,
    height: sceneHeight,
    // the frame background is the root group's own box: the view's width x height
    // (a composition's is the degenerate M0,0h0v0h0Z)
    plotWidth: ctx.rootUnsized ? 0 : insidePadding !== undefined && insidePadding.width < 0 ? insidePadding.width : width,
    plotHeight: ctx.rootUnsized ? 0 : insidePadding !== undefined && insidePadding.height < 0 ? insidePadding.height : height,
    // (`background` is a view signal: a spec that declares one sets the background through it; one with no value leaves the spec's)
    background: ctx.signalParams.background !== undefined && (chart.signalDefs ?? []).some((d) => d.name === 'background') ? backgroundText(ctx.signalParams.background) : ctx.chart.background,
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
    // (a layout of no known type moves the view's origin by what the content overflows, and nothing else: vega-view's offset is the
    // padding plus the origin)
    padding: auto === 'none' || auto === 'skip' ? base : auto === 'shift' ? { top: padding.top, right: base.right, bottom: base.bottom, left: padding.left } : padding,
    items,
    ...(chart.description !== undefined ? { description: chart.description } : {}),
    ...(built.frame ? { ...built.frame.paint, ...(built.frame.x !== 0 ? { frameX: built.frame.x } : {}), ...(built.frame.y !== 0 ? { frameY: built.frame.y } : {}), ...(built.frame.aria !== undefined ? { frameAria: built.frame.aria } : {}) } : {}),
  }
  // Event-loop wiring (non-serialized internals)
  ;(scene as unknown as { runtime?: unknown }).runtime = ctx.runtime
  ;(scene as unknown as { signalParams?: Record<string, unknown> }).signalParams = ctx.signalParams
  ;(scene as unknown as { compiled?: unknown }).compiled = ctx.chart
  // the limits the scene was evaluated under: the event loop runs the scene's handlers under them (signals.ts `bindSceneSignals`)
  const evaluatedUnder = activeMeter()?.limits
  if (evaluatedUnder) (scene as unknown as { __limits?: unknown }).__limits = evaluatedUnder
  ;(scene as unknown as { __itemGen?: number }).__itemGen = txn.gen
  ;(scene as unknown as { __scales?: unknown }).__scales = sceneSnapshots(ctx)
  // (the captions of the guides format with the chart's locale)
  if (ctx.chart.locale) scene.__locale = ctx.chart.locale
  ;(scene as unknown as { __scaleMap?: unknown }).__scaleMap = ctx.scales
  // (each dataset's rows as this scene has them: a later pulse that advances an array in place leaves this scene its copy, Q14)
  const histories = new Map<string, History>()
  for (const [name, rows] of ctx.datasets) histories.set(name, keepHistory(rows))
  Object.defineProperty(scene, '__datasets', { value: { rows: histories, failed: ctx.failedDatasets }, enumerable: false, configurable: true })
  if (ctx._defs.length) scene.defs = ctx._defs
  // The state the next incremental evaluation starts from; committed by the
  // caller once the scene is accepted.
  ctx.draft.idCounter = ctx.ids.value
  done.draft = ctx.draft
  done.failed = ctx.failed === true
  // what the scene was evaluated under that its renderers draw it under too (scene-output.ts): the URL policy every URL they
  // write is vetted with, and the text measurer given for this evaluation (`RuntimeInput.textMetrics`; the one set for every
  // chart, `setTextMetricsProvider`, is the one every render uses)
  bindSceneUrlPolicy(scene, ctx.urlPolicy)
  if (input.textMetrics) bindSceneTextMetrics(scene, input.textMetrics)
  // (what is derived from its nodes may be kept with them from now on: see scene-registry.ts)
  noteEngineScene(scene)
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
    // (a view laid out on a negative range, autosize none containing more padding than size, has no plot)
    width: Math.max(0, (scene as { plotWidth?: number }).plotWidth ?? 0)
      || Math.max(0, scene.width - padding.left - padding.right),
    height: Math.max(0, (scene as { plotHeight?: number }).plotHeight ?? 0)
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
  for (const [name, rows] of made.rows) out.set(name, made.failed?.has(name) ? null : historical(rows))
  return out
}

/**
 * Compute chart metadata (size, padding, scales). This evaluates the chart once, as
 * `evaluateChart` does, and reads the metadata off the evaluated scene
 * (`chartInfoFromScene`); a host that already holds the scene can call that instead.
 * Useful for interaction, brushing, crosshair, etc.
 */
export function getChartInfo(spec: VgSpec, input: RuntimeInput = {}): ChartInfo {
  return withLimits(input.limits, () => getChartInfoImpl(spec, input))
}

function getChartInfoImpl(spec: VgSpec, input: RuntimeInput): ChartInfo {
  // ONE evaluation: the info is read off the evaluated scene, so it is the scene's own plot size,
  // padding and scales -- under autosize `fit`/`pad` too, where the size the scales were built for
  // is the fitted one, not the spec's. (This used to prepare a second, unfitted context and
  // then evaluate the whole chart again.)
  return chartInfoFromScene(evaluateOnce(compileChart(spec), input))
}

/**
 * A title (or a group's title) as a scene group: the title text at (0,0) and the subtitle where the title layout put it, the group
 * itself outside the bounds of everything laid out so far.
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
  /** The view fits its viewport: what a legend adds to the bounds the title sits against is cut (see `shareOfView`). */
  fitting = false,
  /** the title may be kept from the evaluation before (see `keptGuide`) */
  keep = false,
): SceneGroup | null {
  if (!title0 || !ctx) return null
  // What the title sits against: the view's frame, the marks and the bounds of the axes and legends (axes measured in their own
  // frame: the scene bakes the 0.5px axis delta into their leaves, shifted out here). The title joins them afterwards.
  const b = new Bounds().set(0, 0, width, height)
  const measured = (items as SceneGroup[]).filter((g) => g.role !== 'title')
  // (a clipped mark -- an interval selection's brush -- has its bounds cut to the frame: Bound's boundClip)
  if (hasClippedMark(measured)) eachMarkBounds(measured, width, height, (n) => measureGuideGroup(n as SceneGroup), (mb, n) => { b.union(shareOfView(mb, n as SceneGroup, fitting)) })
  else for (const g of measured) b.union(shareOfView(measureGuideGroup(g), g, fitting))
  // A title is a function of what `guideKeyOf` holds, its scope's scales, the bounds it sits against, the size and the raw mode, and
  // a group title's datum (`parent`)
  const reads = keep ? guideKeyOf(title0, ctx) : null
  const key = reads === null ? null
    : `${reads}\u0005${width}x${height}\u0005${raw ? 1 : 0}${fitting ? 1 : 0}\u0005${b.x1},${b.y1},${b.x2},${b.y2}${parent !== undefined ? `\u0005${dependencyKey(parent)}` : ''}`
  // (the definitions of the gradients it paints with are registered as it is made: such a title is made by every evaluation, see
  // `withGuideGradients`)
  return keptGuide(title0, ctx, key) ?? recordGuide(title0, ctx, key, () => withGuideGradients(ctx, makeTitleGroup(title0, b, width, height, raw, ctx, parent)))
}

/** Make a title's group against the bounds `b` (see `buildTitleGroup`). */
function makeTitleGroup(title0: CompiledTitle, b: Bounds, width: number, height: number, raw: boolean, ctx: EvalContext, parent: Row | undefined): SceneGroup {
  // (a group title reads its facet datum as `parent`)
  const hostCtx = parent !== undefined ? { ...ctx, signalParams: { ...ctx.signalParams, parent } } : ctx
  const titleHost = guideHost(hostCtx)
  titleHost.stopped = undefined
  const built = buildTitleGuide({
    spec: (title0.own ?? {}) as Record<string, unknown>, cfg: (title0.cfg ?? {}) as Record<string, unknown>,
    viewBounds: b, width, height, raw, host: titleHost, style: guideStyles(ctx),
  })
  failGuide(ctx, titleHost, { axis: Infinity, title: true })
  const g = built.group
  const mark = (role: string, it: SceneItem, meta: { name?: string; interactive: boolean } | undefined): SceneGroup => ({
    marktype: 'text', role, items: [it],
    ...(it.href != null ? { hasLinks: true } : {}),
    ...(meta?.name ? { cssName: meta.name } : {}),
    ...(meta?.interactive ? { interactive: true } : {}),
  }) as SceneGroup
  const children: SceneGroup[] = built.title ? [mark('title-text', built.title, built.partMeta.title)] : []
  if (built.subtitle) children.push(mark('title-subtitle', built.subtitle, built.partMeta.subtitle))
  // (the mark definition reads these as written -- vega-parser marks/definition.js: `+zindex || undefined`, `aria`, `description`)
  const own = (title0.own ?? {}) as Record<string, unknown>
  const cfg = (title0.cfg ?? {}) as Record<string, unknown>
  const aria = own.aria ?? cfg.aria
  const description = own.description ?? cfg.description
  const zindex = +((own.zindex ?? cfg.zindex) as number) || undefined
  const gb = groupBackground(g as SceneItem, +(g.width as number) || 0, +(g.height as number) || 0)
  const out = {
    marktype: 'group',
    role: 'title',
    // (the title group item's own datum, a generated `{}`: vega-parser title.js)
    datum: built.datum,
    x: (g.x as number) ?? 0,
    y: (g.y as number) ?? 0,
    items: children,
    box: gb.background,
    ...(gb.foreground ? { boxFg: gb.foreground } : {}),
    ...(aria !== undefined ? { aria } : {}),
    ...(description ? { description } : {}),
    ...(zindex ? { zindex } : {}),
    ...(built.bounds ? { titleBounds: built.bounds } : {}),
    ...(built.partMeta.group?.name ? { cssName: built.partMeta.group.name } : {}),
    ...(built.partMeta.group?.interactive ? { interactive: true } : {}),
    ...(itemAriaOf(g) ? { itemAria: itemAriaOf(g) } : {}),
    ...(cursorOf(g) !== undefined ? { cursor: cursorOf(g) } : {}),
    ...(g.tooltip !== undefined ? { tooltip: g.tooltip } : {}),
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
 * drives neither `width` nor `height` itself and does not leave the dimension to its layout (a composition's size is its
 * groups'). A spec that drives one dimension sizes itself, so its other, numeric dimension stays the spec's: vega-lite's
 * `width: "container", height: 200` is 200 tall whatever the container measures, and a container that grows with the
 * chart cannot feed its own height back into it (issue #128). A spec whose autosize is `none` fixes its size: in Vega its
 * whole size is its `width`, `height` and `padding` and nothing else, so a container does not size it either (vega-embed
 * draws it at that size in any container).
 */
function viewOverride(chart: CompiledChart, input: RuntimeInput, dim: 'width' | 'height'): number | undefined {
  const fixed = hostSize(chart, input, dim)
  if (fixed != null) return fixed
  const written = input.signals?.[dim]
  if (typeof written === 'number' && !specComputesSize(chart, dim)) return written
  const measured = input.measuredSize?.[dim]
  if (measured == null) return undefined
  if (chart.contentSized?.includes(dim) || keepsOwnSize(viewLayout(chart, input).autosize.type)) return undefined
  return drivesSize(chart, 'width') || drivesSize(chart, 'height') ? undefined : measured
}

/**
 * The size the host gives the view's `dim` (`input.width` / `input.height`), unless the spec computes it: a `width` / `height` signal
 * with an `update` and no handlers is what vega sizes the view by -- `view.height(499)` or `view.signal('height', 499)` pulses the
 * signal, whose update runs and gives its own value again, frame and signal alike (C112). A view that fits its viewport resizes
 * itself (`fitResize`): that size is the view's.
 */
function hostSize(chart: CompiledChart, input: RuntimeInput, dim: 'width' | 'height'): number | undefined {
  const fixed = input[dim]
  return fixed == null || (specComputesSize(chart, dim) && !FIT_RESIZES.has(input)) ? undefined : fixed
}

/** The spec computes the view's `dim`: its signal of that name has an `update` and no handlers (a value written for it is overwritten). */
function specComputesSize(chart: CompiledChart, dim: 'width' | 'height'): boolean {
  const def = (chart.signalDefs ?? []).find((d) => d.name === dim)
  return def !== undefined && typeof def.update === 'string' && !def.on?.length
}

/** The inputs of the passes a view that fits its viewport makes at the size it fitted (not a size the host gave). */
const FIT_RESIZES = new WeakSet<RuntimeInput>()
const fitResize = (input: RuntimeInput): RuntimeInput => { FIT_RESIZES.add(input); return input }

/** An autosize that never resizes the view: its size is its `width`, `height` and padding (`none`, and no layout at all). */
const keepsOwnSize = (type: AutosizeType): boolean => type === 'none' || type === 'skip' || type === 'shift'

/** The view's padding and autosize, as one evaluation lays the view out. */
interface ViewLayout { padding: Padding; autosize: Autosize }

/**
 * What the view's signals hold before an evaluation runs, when its padding, autosize or size is a signal (see `evaluateChartPass`):
 * the layout the evaluation uses, and the values of the `width` / `height` signals that are known before anything is built.
 */
interface ViewBefore extends ViewLayout { sizes: Record<string, unknown> }
const VIEW_BEFORE = Symbol('viewBefore')
type ViewInput = RuntimeInput & { [VIEW_BEFORE]?: ViewBefore }

/** The view's layout in an evaluation: what its signals gave it (`evaluateChartPass`), else the spec's (or config's) properties. */
function viewLayout(chart: CompiledChart, input: RuntimeInput): ViewLayout {
  return (input as ViewInput)[VIEW_BEFORE] ?? staticViewLayout(chart)
}

function staticViewLayout(chart: CompiledChart): ViewLayout {
  return { padding: chart.padding, autosize: { type: (chart.autosize ?? 'pad') as AutosizeType, contains: chart.autosizeContains } }
}

/** The signals the view size is read from before an evaluation runs: the static ones, those known before it (see `ViewBefore`), the host's. */
function sizeSignals(chart: CompiledChart, input: RuntimeInput): Record<string, unknown> {
  const before = (input as ViewInput)[VIEW_BEFORE]
  return dict(chart.signals, before?.sizes, input.signals)
}

/**
 * The view's autosize. A dimension the measured container sizes (see viewOverride) is the whole chart there, padding and
 * guides included, as vega-lite's `width` / `height: "container"` is (`fit` that contains the padding): the content
 * shrinks so the chart's box is the container's. So a chart that fills its container never outgrows it, and a container
 * whose size is the chart's own (a block <div> with no height) keeps it, where the content grew on every measurement
 * (issue #128). Every other view keeps the spec's autosize.
 */
function autosizeOf(chart: CompiledChart, input: RuntimeInput): Autosize {
  const w = fillsContainer(chart, input, 'width')
  const h = fillsContainer(chart, input, 'height')
  const { autosize } = viewLayout(chart, input)
  if (!w && !h) return autosize
  const own = autosize.type
  const type = (w && h) || (w && (own === 'fit' || own === 'fit-y')) || (h && (own === 'fit' || own === 'fit-x')) ? 'fit' : w ? 'fit-x' : 'fit-y'
  return { type, contains: 'padding' }
}

/** Whether the view's `dim` is the measured container's (the host fixed no size there and no signal write beats it). */
function fillsContainer(chart: CompiledChart, input: RuntimeInput, dim: 'width' | 'height'): boolean {
  return input.measuredSize?.[dim] != null && input[dim] == null && typeof input.signals?.[dim] !== 'number' && viewOverride(chart, input, dim) !== undefined
}

const isFit = (type: AutosizeType): boolean => type === 'fit' || type === 'fit-x' || type === 'fit-y'

/** Whether the spec drives a view dimension itself: a `{signal}` size or a declared `width` / `height` signal. */
function drivesSize(chart: CompiledChart, dim: 'width' | 'height'): boolean {
  const size = chart[dim]
  return (size !== null && typeof size === 'object' && 'signal' in size) || (chart.signalDefs ?? []).some((d) => d.name === dim)
}

/**
 * A view size as the root group takes it from its signal (vega-view-transforms: `Math.max(0, group.width || 0)`, so a numeric string
 * is its number and any other string NaN, as in vega); undefined: no value yet.
 */
function viewSizeValue(v: unknown): number | undefined {
  return v === undefined ? undefined : Math.max(0, (v as number) || 0)
}

/**
 * Whether the view's `dim` is read from its signal in this pass: the size is the signal (a `{signal}` property, or a signal the spec
 * declares by that name) and nothing fixes it -- the host's size or write, a measured container, a fit resize, the signed first pass.
 */
function sizeFollowsSignal(
  chart: CompiledChart, input: RuntimeInput, explicitSize: { width: boolean; height: boolean }, signed: { width?: number; height?: number } | undefined,
  ctx: EvalContext, dim: 'width' | 'height',
): boolean {
  const size = chart[dim]
  return size !== null && typeof size === 'object' && 'signal' in size && size.signal === dim && !explicitSize[dim] && signed?.[dim] === undefined
    && (!ctx.hostSignals.has(dim) || specComputesSize(chart, dim)) && viewOverride(chart, input, dim) === undefined
}

/** Whether the view's `dim` is a signal that reads data or a scale (known only once a pass has run), and nothing fixes it. */
function sizeReadsDataflow(chart: CompiledChart, input: RuntimeInput, dim: 'width' | 'height'): boolean {
  const size = chart[dim]
  return size !== null && typeof size === 'object' && 'signal' in size && size.signal === dim && viewOverride(chart, input, dim) === undefined
    && !(input.signals !== undefined && Object.hasOwn(input.signals, dim)) && viewSignalReadsDataflow(chart, dim)
}

/** The view's `dim` the signal value `value` gives, when the size follows the signal and that is not the size it has (`current`). */
function viewSizeChange(
  chart: CompiledChart, input: RuntimeInput, explicitSize: { width: boolean; height: boolean }, signed: { width?: number; height?: number } | undefined,
  ctx: EvalContext, dim: 'width' | 'height', value: unknown, current: number,
): number | undefined {
  if (!sizeFollowsSignal(chart, input, explicitSize, signed, ctx, dim)) return undefined
  const v = viewSizeValue(value)
  return v === undefined || Object.is(v, current) ? undefined : v
}

/** Whether view signal `name` reads data or a scale, directly or through other signals (see `signalReadsDataflow`), once per chart. */
const VIEW_READS_DATAFLOW = new WeakMap<CompiledChart, Map<string, boolean>>()
function viewSignalReadsDataflow(chart: CompiledChart, name: string): boolean {
  let memo = VIEW_READS_DATAFLOW.get(chart)
  if (memo === undefined) VIEW_READS_DATAFLOW.set(chart, (memo = new Map()))
  let reads = memo.get(name)
  if (reads === undefined) memo.set(name, (reads = signalReadsDataflow(chart, signalIndex(chart), name, new Set())))
  return reads
}

/** The index of each signal the view declares (its first declaration). */
const SIGNAL_INDEX = new WeakMap<CompiledChart, Map<string, number>>()
function signalIndex(chart: CompiledChart): Map<string, number> {
  let index = SIGNAL_INDEX.get(chart)
  if (index === undefined) {
    index = new Map()
    ;(chart.signalDefs ?? []).forEach((d, i) => { if (!index!.has(d.name)) index!.set(d.name, i) })
    SIGNAL_INDEX.set(chart, index)
  }
  return index
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
// Incremental pulse propagation
// ---------------------------------------------------------------------------

export type StepTransformContext = TransformContext & {
  datasets: (name: string) => Row[] | undefined
  /** Datasets affected by this update (for lookup safety). */
  affectedDatasets?: Set<string>
}

/** Previous length of a pulse (for synthesising a mapping). */
export function pulseBaseLength(pulse: StepPulse): number {
  return pulse.baseLength ?? pulse.to?.length ?? (pulse.from ? pulse.from.length : 0)
}

/** Run one transform over the whole input (the fallback path). */
export function applyOne(rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string): Row[] {
  return applyTransforms(rows, [t], tctx, sourceName)
}

/** The field an `identifier` transform numbers into (none: the transform refuses, as it does when run). */
export const idField = (t: CompiledTransform): string => (t as { as?: string }).as as string

/** One transform from scratch, the numbers an `identifier` had in `previous` carried (the evaluation that keeps no state: no state to leave). */
export function applyFresh(rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, previous?: Row[]): Row[] {
  return t.type === 'identifier' ? applyIdentifier(rows, t, tctx, sourceName, carryByAlignment(rows, previous, idField(t))) : applyOne(rows, t, tctx, sourceName)
}

/** Run an `identifier` transform with the numbers its rows had (see identifier-ids.ts), if they had any. */
export function applyIdentifier(rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, carry: readonly unknown[] | undefined): Row[] {
  return withCarry(tctx, carry, () => applyOne(rows, t, tctx, sourceName))
}

/** Run `run` with the numbers the rows of the next `identifier` had. */
export function withCarry<T>(tctx: Pick<TransformContext, 'ids'>, carry: readonly unknown[] | undefined, run: () => T): T {
  const ids = tctx.ids
  if (ids) ids.carry = carry
  try {
    return run()
  } finally {
    if (ids) ids.carry = undefined
  }
}

/**
 * A published pulse in the engine's two canonical shapes. A same-length update
 * (`{changed}`) is exactly an append-only pulse whose base is the current length
 * and that appends nothing, so ONE set of per-transform fast paths serves both
 * (there used to be a second, same-length-only engine with separate state).
 */
/**
 * The pulse the caller gave for host dataset `name`, when it describes how the rows the state this pass reuses was made from became
 * `given`; else null (the dataset is derived in full). A hint is relative to the caller's own previous rows, which the state need
 * not have been made from: one compiled chart may be evaluated by several callers (DECISIONS Q16), each with its own data. So the
 * pulse is taken for the very array the state was given (the caller changed it in place and says how); for an array the caller
 * names as the one its hints are relative to (`ctx.pulseBases`: a session's own last rows, or the rows of the state that made the
 * scene an `evaluateChart` caller hands back as `previousScene`) when that is the state's, by identity; and, from a caller that names
 * neither, when the rows the pulse says are unchanged are the rows of the state's array where it says they are: the same objects
 * (one pass over the references), or rows equal to them field by field. A pulse whose shape cannot fit the rows (a `baseLength` that
 * is not the length before, DECISIONS Q29; a mapping of another length) is not taken either.
 */
function hostPulse(ctx: EvalContext, name: string, given: unknown): StepPulse | null {
  if (Array.isArray(given)) ctx.draft.hostRows.set(name, given)
  const p = ctx.inputPulses?.get(name)
  if (p === undefined) return null
  const before = ctx.prev?.hostRows.get(name)
  if (before === undefined || !Array.isArray(given)) return null
  if (before === given) return p
  // (the caller named the rows its pulse is relative to: they are the state's, or the pulse is someone else's)
  if (ctx.pulseBases !== undefined) return ctx.pulseBases.get(name) === before && pulseFits(p, before.length, given.length) ? p : null
  if (!pulseFits(p, before.length, given.length)) return null
  // (the references first, in one tight pass; the changed indices and the field comparison only for a row that is another object)
  let changed: Set<number> | undefined
  const accountedFor = (i: number, a: unknown, b: unknown): boolean => (changed ??= new Set(p.changed)).has(i) || sameHostRow(a, b)
  if (p.from !== undefined) {
    for (let i = 0; i < given.length; i++) {
      const old = p.from[i]!
      if (old < 0) continue
      if (old >= before.length) { if (!(changed ??= new Set(p.changed)).has(i)) return null; continue }
      if (given[i] !== before[old] && !accountedFor(i, given[i], before[old])) return null
    }
    return p
  }
  const base = p.appendOnly ? p.baseLength ?? before.length : given.length
  for (let i = 0; i < base; i++) if (given[i] !== before[i] && !accountedFor(i, given[i], before[i])) return null
  return p
}

/** Whether pulse `p` can describe rows of length `before` becoming rows of length `after` (its mapping, or what it keeps, fits). */
function pulseFits(p: StepPulse, before: number, after: number): boolean {
  if (p.from !== undefined) return p.from.length === after
  const base = p.appendOnly ? p.baseLength ?? before : after
  return base === before && base <= after
}

/** A row the pulse says is unchanged: the same row object, or one equal to it field by field (`rowsEqual`: a host may re-create it). */
const sameHostRow = (a: unknown, b: unknown): boolean => a === b || rowsEqual(a as Row, b as Row)

function normalizePulse(p: StepPulse, rowCount: number): StepPulse {
  if (p.from || p.appendOnly || p.added?.length || p.removed?.length) return p
  return { ...p, appendOnly: true, baseLength: rowCount }
}

function buildDatasets(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  // (every build of the datasets numbers from where the view's counter stood: a build repeated under signals that resolved
  // since is the same evaluation, not one more)
  ctx.ids.value = ctx.idStart
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
  // (a re-ranked dataset that threw on an earlier round is judged anew too: its failure and what it took with it are taken back)
  if (ctx.lateData !== undefined) {
    const at = ctx.abort.failures.indexOf(ctx.lateData.entry)
    if (at >= 0) ctx.abort.failures.splice(at, 1)
    ctx.lateTaint = ctx.lateData.before
    ctx.postRunLost = ctx.lateData.postRunLost
    ctx.lateData = undefined
  }
  const postRunBefore = ctx.postRunLost
  let lateError: { error: unknown } | undefined
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
      // (a dataset's rows as the engine publishes them: keyed past the fingerprint's budget by their stamp, see fingerprint.ts)
      publishRows(rows)
      ctx.datasets.set(name, rows)
      const given = hostPulse(ctx, name, ownGet(inputData, name))
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
    // What the pipeline is made from, where a later evaluation can tell it again (see DatasetState.inputs); a host dataset's input is
    // told by the array the host gave (`raw`), a derived one's by the rows of its sources. `shared`: `rows` are still the source's own,
    // copied only if a step has to run.
    let inputs: unknown[] | undefined
    let raw = false
    let shared = false
    const srcNames = sourceNames(d)
    const setRows = srcNames.length === 0 ? ctx.setData.rows.get(name) : undefined
    if (setRows !== undefined) {
      // `setdata(name, tuples)` replaced this dataset's input
      rows = copiedRows(setRows, 'setdata')
    } else if (srcNames.length > 1) {
      // several sources: their rows, one source after the other (each pulse adds its tuples in turn)
      rows = []
      inputs = []
      for (const n of srcNames) {
        const from = build(n, seen)
        inputs.push(from)
        for (const r of from) rows.push(copyTuple(r))
      }
    } else if (srcNames.length === 1) {
      const src = srcNames[0]!
      // (a dataset derived by `source` is its source's tuples: vega reads no `format` there -- the rows were parsed by the source)
      {
        const from = build(src, seen)
        rows = from
        shared = true
        inputs = [from]
        inPulse = ctx.datasetPulses.get(src) ?? null
        // (vega: the backing tree travels with the source array, `pulse.source.root`, to a dataset derived from it)
        const root = ctx.hierarchies.get(src)
        if (root !== undefined && !ctx.hierarchies.has(name)) ctx.hierarchies.set(name, root)
      }
    } else if (d.values != null) {
      const given = ownGet(inputData, name)
      inPulse = hostPulse(ctx, name, given)
      if (given) {
        // (rows that readData would pass through as they are -- an array of JSON rows, nothing to parse -- are only ingested)
        // (a session hands a dataset its spec's own inline rows this way too: those are named as inline values)
        const source = given === d.values ? 'values' : 'data'
        rows = Array.isArray(given) && passesThroughRead(d.format, given) ? ingestHostRows(given as Row[], inPulse, name, source) : readData(given, d.format, false, { dataset: name, source, ...(inPulse?.changed ? { dataChanges: inPulse.changed } : {}) }, dataLocale(ctx.chart))
        inputs = [given]
        raw = true
      } else {
        // vega-loader read semantics: object arrays pass through format.parse
        // coercion; string values are parsed by the registered reader.
        rows = readData(inlineValues(ctx, d.values), d.format, valuesSignal(d.values) !== undefined, { dataset: name, source: 'values' }, dataLocale(ctx.chart))
        notePrimitiveTuples(ctx, rows)
      }
    } else {
      const given = ownGet(inputData, name) as Row[] | undefined
      if (given == null && (d as { url?: unknown }).url != null) {
        // A url dataset nobody resolved would render as an empty chart with no
        // hint why: fail loudly and say how to fix it.
        throw unloadedUrlError(name, true)
      }
      inPulse = hostPulse(ctx, name, given)
      rows = ingestHostRows(given ?? [], inPulse, name)
      shared = true
      if (given != null) { inputs = [given]; raw = true }
    }
    // Inline values, host `input.data`, a `source` copy and a loaded dataset all
    // count against maxRows here, nested group data included.
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
    } else if (!d.transform.length) {
      if (shared) {
        // (the copy the evaluation before made of the same rows, when there is one: see keptCopy)
        rows = keptCopy(ctx, name, inputs, raw) ?? copyRows(rows)
        if (inputs !== undefined) ctx.draft.copies.set(name, { inputs: pinAll(inputs), rows })
      }
    } else try {
      // (the rows the first step is given are tuples to it, as vega's ingested rows are: a host's or the spec's rows are only
      // registered, never written)
      markTuples(rows)
      const prevDS = ctx.prev?.datasets.get(name)
      const tctx: StepTransformContext = {
        runtime: ctx.runtime,
        signals: engineParams(ctx.signalParams),
        // Cross-dataset access for the `lookup` transform. Build the referenced
        // dataset on demand (it may be declared after this one in the spec).
        datasets: (n) => {
          if (!ctx.datasets.has(n) && sources.has(n)) build(n, new Set())
          return ctx.datasets.get(n)
        },
        hierarchies: ctx.hierarchies,
        projections: ctx.projections,
        affectedDatasets: ctx.affected,
        ids: ctx.ids,
      }
      // What the steps read now (null: not known), and the build of an earlier round of this pass, or of the pass before, that read
      // the same, if any.
      // (a view whose datasets may draw from a random source the host injected takes a pulse where it always did: the engine's pulse
      // path draws without a tape, so which build takes a pulse decides which numbers the source hands out; see `drawsInDatasets`)
      const key = ctx.runtime.random !== undefined && datasetsMayDraw(ctx.chart) ? null : pipelineKey(ctx, d.transform)
      const before = reuse.on ? keptBuild(ctx, name, inputs, key) : undefined
      if (before !== undefined) {
        const kept = before.built!
        rows = kept.rows
        // (a pass before this one may have built from another state of the evaluation before: its pulse says how the rows of that
        // state changed, which are the rows this pass's items were made from only when the two states are one)
        outPulse = kept.base === prevDS ? kept.pulse : null
        ctx.ids.value = kept.ids[1]
        for (const [signal, value] of kept.published) ctx.signalParams[signal] = value
        ctx.draft.datasets.set(name, before)
        stepCounts.reused += d.transform.length
      } else {
        const idsBefore = ctx.ids.value
        const state: DatasetState = { fp: passFp, inputLength: rows.length, steps: [], stepState: new Map(), idsStart: idsBefore }
        // Incremental only when every precondition is provable: the caller named a pulse, the previous state was built under the
        // params the steps read (all of them, or the signals and datasets they name: see `pipelineKey`) from an input of the length
        // the pulse is relative to, and no earlier pass of THIS evaluation already updated that state in place.
        // A pass of an evaluation numbers the rows of an `identifier` as the pass before it did (a view that fits its viewport builds its
        // content twice): whichever route numbered them first, the others carry its numbers, and do not number them again by theirs
        // (a later round of the same pass too, when the round before gave the step the same rows: see `carriedFrom`).
        const hasIds = d.transform.some((x) => x.type === 'identifier')
        const earlierDS = hasIds ? ctx.draft.datasets.get(name) ?? ctx.earlier?.datasets.get(name) : undefined
        const incremental = ctx.incremental && inPulse !== null && !inPulse.full && prevDS !== undefined && earlierDS === undefined
          && (!numbersSourceRows(d.transform) || followsSources(d.transform))
          && (prevDS.fp === passFp || (key !== null && prevDS.key === key && activeMeter() === null))
          && prevDS.steps.length === d.transform.length
          && prevDS.inputLength === pulseBaseLength(inPulse) && pulsePath(ctx) && claim(ctx, datasetParts(prevDS))
        if (incremental) {
          if (shared) rows = copyRows(rows)
          const res = ctx.engine!.applyPipelineWithPulse!(rows, d.transform, tctx, name, inPulse!, prevDS, state)
          // (the pulse advanced the claimed steps in place: whatever pinned them before the claim, or while the pulse ran, is stale)
          for (const part of datasetParts(prevDS)) endWrite(part)
          for (const part of state.steps) endWrite(part)
          endWrite(res.rows)
          rows = res.rows
          outPulse = res.pulse
          // (what each step read, as `runPipeline` records it, so a later evaluation that is not driven by a pulse keeps the steps:
          // a step that publishes a signal another may read in the same run is not recorded, nor the run)
          if (key !== null && inputs !== undefined && d.transform.every((t) => stepReadsOf(t)!.publishes === undefined)) {
            state.inputs = pinAll(inputs)
            state.stepPins = pinAll(state.steps)
            state.records = d.transform.map((t) => ({ keys: stepKeys(ctx, stepReadsOf(t)!) }))
          }
        } else {
          rows = runPipeline(ctx, name, d.transform, tctx, rows, shared, inputs, raw, prevDS, earlierDS, state)
          outPulse = null
        }
        if (key !== null) {
          state.key = key
          if (inputs !== undefined && !forceLinkDatasets(ctx.chart).has(name)) {
            state.built = { pass: ctx.draft, inputs: pinAll(inputs), key, rows, pulse: outPulse, base: prevDS, ids: [idsBefore, ctx.ids.value], published: publishedBy(ctx, d.transform) }
          }
        }
        ctx.draft.datasets.set(name, state)
      }
    } catch (e) {
      if (readsUnsettledSignal(ctx, d)) {
        // (it read a signal whose value does not exist yet in this evaluation -- an init or an update still waiting for the scales or
        // the datasets it reads: vega runs this dataset after that signal, so the throw is one of this round, not vega's. The
        // dataset is empty for now and the rounds build it again once the signal settled; a throw then is reported.)
        refuseUnrecoverable(e)
        ctx.dataPending = true
        rows = []
        outPulse = null
      } else {
        // vega: a transform that throws is logged and the dataset publishes nothing (the rest of
        // its pipeline never runs, so everything downstream of it is empty / never built).
        // (the first to throw, when it is a dataset vega re-ranked -- it reads a signal a later dataset writes, and vega-runtime connects
        // the parameters once every operator is made -- is ranked after every other operator of the view: reported as the pass's
        // failure, at that place, below)
        if (ctx.failedFrom === undefined && dsRank.get(name)! > ctx.chart.data.length) {
          refuseUnrecoverable(e)
          lateError = { error: e }
        } else reportEvalError(ctx, e)
        ;(ctx.failedDatasets ??= new Set()).add(name)
        ctx.failedFrom = Math.min(ctx.failedFrom ?? Infinity, dsRank.get(name)!)
        rows = []
        outPulse = null
      }
    }
    // a dataset a `force` link force reads gets its link rows rewritten (their ends become the nodes): they are this
    // evaluation's own copies, never the spec's
    if (forceLinkDatasets(ctx.chart).has(name)) rows = copiedRows(rows, 'dataset rows', true)
    markTuples(rows)
    // (a dataset's rows as the engine publishes them: keyed past the fingerprint's budget by their stamp, see fingerprint.ts)
    publishRows(rows)
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
    if (ctx.failedDatasets?.size && lateError !== undefined) {
      // A dataset vega re-ranked past the scales and marks (C211) threw after every operator of the view that reads nothing re-ranked
      // ran: the datasets before and after it, the scales, the marks, the guides, the title, the layout. What reads the failed
      // datasets (and what reads that) never ran, and the run's post-run work was dropped, as for a late signal (see
      // abortAtThrowingSignal): the pass stops there.
      const before = ctx.lateTaint
      // (every dataset vega re-ranked is ranked after the view's other operators, and so is every scale whose parameters read data or
      // anything made after it, see scaleIsLate: what reads them is made after the throw too)
      const lateData = [...new Set([...ctx.failedDatasets, ...ctx.chart.data.map((d) => d.name).filter((n) => dsRank.get(n)! > ctx.chart.data.length)])]
      const t = lateTaintOf(ctx.chart, [...(before?.signals ?? [])], lateData)
      const root = rootScope(ctx.chart)
      for (const sc of ctx.chart.scales) if (scaleIsLate(sc, root, ctx.chart)) t.scales.add(sc.name)
      ctx.lateTaint = t
      ctx.failed = true
      ctx.postRunLost = true
      const entry: AbortPoint = { path: [], axis: Infinity, lateSignal: true, error: lateError.error }
      ctx.abort.failures.push(entry)
      ctx.lateData = { entry, before, postRunLost: postRunBefore }
    } else if (ctx.failedDatasets?.size) ctx.encodeAborted = ctx.datasetAborted = true
  } finally {
    ctx.buildOnDemand = undefined
  }
  // Transforms (extent, bin with a signal output) may have written signals.
  ctx.fpMemo = undefined
  ctx.readsMemo = undefined
}

const copyRows = (rows: readonly Row[]): Row[] => {
  stepCounts.copied += rows.length
  const out = copiedRows(rows, 'dataset rows', true)
  markTuples(out)
  return out
}

/** Whether `readData(rows, format)` returns `ingestRows(rows)`: JSON rows already parsed, nothing to coerce, no d3-dsv `columns`. */
function passesThroughRead(format: DataFormatSpec | undefined, rows: readonly unknown[]): boolean {
  return (!format?.type || format.type === 'json') && !format?.parse && !Object.hasOwn(rows, 'columns')
}

/** The host's arrays whose leading rows are known to be objects, by how many (see `ingestHostRows`). */
const objectRowPrefix = new WeakMap<readonly unknown[], number>()

/**
 * `ingestRows` on the rows the host gave a dataset. An append-only pulse leaves the rows before its `baseLength` as they were but
 * for the ones it lists as changed (a stream appends to the array it already gave): when those were already all objects, only
 * the appended and the changed rows are looked at, not the whole dataset on every append.
 */
function ingestHostRows(given: readonly Row[], pulse: StepPulse | null, dataset: string, source: 'values' | 'data' = 'data'): Row[] {
  const known = objectRowPrefix.get(given) ?? 0
  const base = pulse?.appendOnly && pulse.baseLength !== undefined && pulse.baseLength <= known && pulse.baseLength <= given.length ? pulse.baseLength : 0
  const rows = ingestRows(given, base, pulse?.changed, { dataset, source, ...(pulse?.changed ? { dataChanges: pulse.changed } : {}) })
  if (rows === given) objectRowPrefix.set(given, given.length)
  return rows
}

/**
 * The copy the previous evaluation made of the rows of dataset `name`, a dataset with no transforms whose rows are copies of the
 * host's or of its source's, when they were copied from the rows it is given now: the array the host gave then, which the host's
 * session says holds the rows the host gives now (or which is the very array given again by a caller that names what changed), or
 * the very arrays of its sources (see `reusableRuns`). Nothing writes to a copy once it is made, so the copy is the copy these rows
 * would make; a dataset named as changed is copied again.
 */
function keptCopy(ctx: EvalContext, name: string, inputs: readonly unknown[] | undefined, raw: boolean): Row[] | undefined {
  if (inputs === undefined || !reuse.on) return undefined
  // (a later round of this pass, or the pass after another, copies the very arrays the one before copied: its copy, whatever changed
  // since the evaluation before)
  for (const pass of [ctx.draft, ctx.earlier]) {
    const mine = pass?.copies.get(name)
    if (mine !== undefined && samePins(mine.inputs, inputs)) return mine.rows
  }
  if (ctx.affected.has(name)) return undefined
  const prev = ctx.prev?.copies.get(name)
  if (prev === undefined || prev.inputs.length !== inputs.length) return undefined
  if (raw) {
    const vouched = ctx.unchanged?.has(name) === true ? ctx.unchanged.get(name) : ctx.incremental ? inputs[0] : undefined
    return vouched !== undefined && samePin(prev.inputs[0], vouched) ? prev.rows : undefined
  }
  return samePins(prev.inputs, inputs) ? prev.rows : undefined
}

/** The earlier runs of dataset `name` whose steps may be kept: those made from the inputs it has now (see {@link DatasetState.inputs}). */
function reusableRuns(ctx: EvalContext, name: string, inputs: readonly unknown[] | undefined, raw: boolean, steps: number): DatasetState[] {
  if (inputs === undefined || !reuse.on) return []
  const sameInputs = (s: DatasetState | undefined): s is DatasetState => {
    return s?.records !== undefined && s.inputs !== undefined && s.steps.length === steps && samePins(s.inputs, inputs)
  }
  const runs: DatasetState[] = []
  // (a run of this same evaluation -- the datasets build again once the signals they read resolve -- saw the same host rows)
  const draft = ctx.draft.datasets.get(name)
  if (sameInputs(draft)) runs.push(draft)
  const prev = ctx.prev?.datasets.get(name)
  if (prev?.records !== undefined && prev.inputs !== undefined && prev.steps.length === steps && !ctx.affected.has(name) && !claimed(ctx, datasetParts(prev))) {
    // a host dataset is the rows the previous evaluation was given when the host's session says these are equal to them; a derived one
    // is the rows its sources made, which a kept source hands on as the same arrays
    if (raw ? ctx.unchanged?.has(name) === true && prev.inputs.length === 1 && samePin(prev.inputs[0], ctx.unchanged.get(name)) : sameInputs(prev)) runs.push(prev)
  }
  return runs
}


/**
 * Run a dataset's transforms over `rows` from scratch, keeping every step whose inputs are as they were in an earlier run (see
 * {@link DatasetState.inputs}) and leaving the steps, their state and what each read in `state`. `shared`: `rows` are still the
 * source's own, copied only if a step that does not make rows of its own has to run on them.
 */
function runPipeline(
  ctx: EvalContext, name: string, transforms: CompiledTransform[], tctx: StepTransformContext, rows: Row[], shared: boolean,
  inputs: readonly unknown[] | undefined, raw: boolean, prevDS: DatasetState | undefined, earlierDS: DatasetState | undefined, state: DatasetState,
): Row[] {
  const runs = reusableRuns(ctx, name, inputs, raw, transforms.length)
  const records = new Array<StepRecord | undefined>(transforms.length)
  const ends = runsOf(transforms)
  let cur = rows
  // (an `identifier` after a step that may hold rows back numbers rows as their source rows: which input row each row is rides along
  // the steps before it)
  const sourceList = numbersSourceRows(transforms) ? Int32Array.from({ length: rows.length }, (_, i) => i) : undefined
  if (sourceList !== undefined) setSources(rows, sourceList)
  // (steps kept from a run before did not run: their rows' source rows are followed from the rows they were given, by the state they
  // left -- a filter's pass flags)
  const follow = (from: number, to: number, given: readonly Row[]): void => {
    let list = sourceList === undefined ? null : sourcesOf(given)
    for (let j = from; j <= to && list !== null; j++) {
      const out = state.steps[j]!
      list = sourcesAfter(transforms[j]!.type, list, j === from ? given.length : state.steps[j - 1]!.length, out.length, state.stepState.get(`${name}#${j}`))
      if (list !== null) setSources(out, list)
    }
  }
  for (let k = 0; k < transforms.length; k++) {
    const end = reuse.on ? ends[k]! : k
    const t = transforms[k]!
    const reads = stepReadsOf(t)
    if (end > k) {
      // consecutive steps that only add fields run as one (the rows are made once; see runsOf)
      const unit = transforms.slice(k, end + 1)
      const unitReads = unit.map((u) => stepReadsOf(u)!)
      const unitKeys = unitReads.map((r) => stepKeys(ctx, r))
      const kept = runs.length > 0 ? keptSteps(ctx, name, unit, unitReads, unitKeys, runs, k, cur, earlierDS !== undefined) : undefined
      if (kept !== undefined) {
        const out = kept.steps[end]!
        for (let j = k; j <= end; j++) {
          keepStep(ctx, transforms[j]!, unitReads[j - k]!, kept.records![j]!, out)
          state.steps.push(kept.steps[j]!)
          if (kept.aliased?.[j] !== undefined) (state.aliased ??= [])[j] = kept.aliased[j]
          records[j] = kept.records![j]
        }
        follow(k, end, cur)
        cur = out
        markTuples(cur)
        stepCounts.reused += unit.length
      } else {
        // (the unit's first step copies every row it is given, so a source's rows need only be in an array of their own)
        if (shared && cur === rows) { cur = rows.slice(); if (sourceList !== undefined) setSources(cur, sourceList) }
        const out = applyTransforms(cur, unit, tctx, name)
        // (the steps before the last stand for the rows it made, which hold what the steps after them added)
        for (let j = k; j < end; j++) {
          state.steps.push(withOrderOf(out, out.slice()))
          ;(state.aliased ??= [])[j] = new Set(unit.slice(j - k + 1).flatMap(fieldsWritten))
        }
        state.steps.push(out)
        for (let j = 0; j < unit.length; j++) records[k + j] = recordStep(ctx, unitReads[j]!, unitKeys[j]!, false, undefined)
        cur = out
        markTuples(cur)
        stepCounts.ran += unit.length
      }
      k = end
      continue
    }
    const keys = reads === null ? undefined : stepKeys(ctx, reads)
    const kept = keys !== undefined && runs.length > 0 ? keptSteps(ctx, name, [t], [reads!], [keys], runs, k, cur, earlierDS !== undefined) : undefined
    if (kept !== undefined) {
      const out = kept.steps[k]!
      keepStep(ctx, t, reads!, kept.records![k]!, out)
      const given = cur
      cur = out
      markTuples(cur)
      state.steps.push(cur)
      const ss = kept.stepState.get(`${name}#${k}`)
      if (ss !== undefined) state.stepState.set(`${name}#${k}`, ss)
      follow(k, k, given)
      records[k] = kept.records![k]
      notePublished(state, k, t, ctx.signalParams)
      stepCounts.reused++
      continue
    }
    // (the rows of a step that has to run are this evaluation's own: a source's are copied now, unless the step makes rows of its own
    // and only needs them in an array of their own -- the array a source made carries the order its rows were made in, which a
    // dataset made from it does not inherit)
    // A step that only picks rows (`rowUseOf`: a filter, a collect) writes none of them, so it reads the source's rows where they are
    // and only the rows it returns are copied: a filter whose predicate moves on every pointer move copies what passes, not the source.
    // (The rows it returns are copies, as they were when the whole source was copied before it: what a step leaves is the evaluation's
    // own, which the pulse path splices and the dataset hands on. Rows numbered by source row keep the copy before the step.)
    let copyAfter = false
    if (shared && cur === rows) {
      if (sourceList === undefined && rowUseOf(t) === 'subset') { cur = rows.slice(); copyAfter = true }
      else { cur = copiesRows(t) ? rows.slice() : copyRows(rows); if (sourceList !== undefined) setSources(cur, sourceList) }
    }
    const from = cur
    const had = reads?.publishes !== undefined && Object.hasOwn(ctx.signalParams, reads.publishes)
    const published = reads?.publishes === undefined ? undefined : ctx.signalParams[reads.publishes]
    // (a pass of an evaluation numbers an identifier's rows as the pass before it did: that run is the one whose numbers rows carry)
    const carriedRun = carriedFrom(ctx, name, k, from, inputs, earlierDS, prevDS, state.idsStart)
    const before = carriedRun?.steps[k]
    const bySource = t.type === 'identifier' && sourceList !== undefined ? sourceNumbers(name, k, t, from, rows, carriedRun) : undefined
    const run = (): { rows: Row[]; state?: unknown } => bySource !== undefined
      ? { rows: applyIdentifier(from, t, tctx, name, bySource.carry) }
      : ctx.engine !== undefined
        ? ctx.engine.applyOneWithState(from, t, tctx, name, before)
        : { rows: applyFresh(from, t, tctx, name, before) }
    const res = ctx.runtime.random === undefined || !mayDrawRandom(t)
      ? run()
      : atRandomSite(ctx.runtime.random, ctx.chart, `dataset:${name}#${k}`, () => randomFingerprint(t, from, ctx.signalParams), run)
    cur = copyAfter ? withOrderOf(res.rows, copyRows(res.rows)) : res.rows
    markTuples(cur)
    state.steps.push(cur)
    if (res.state !== undefined) state.stepState.set(`${name}#${k}`, res.state)
    if (t.type === 'identifier' && sourceList !== undefined) {
      const numbered = numbersBySource(t, from, cur, rows, bySource)
      if (numbered !== undefined) state.stepState.set(`${name}#${k}`, numbered)
    }
    stepCounts.ran++
    notePublished(state, k, t, ctx.signalParams)
    if (keys !== undefined) records[k] = recordStep(ctx, reads!, keys, had, published)
  }
  if (shared && cur === rows) cur = copyRows(rows)
  if (inputs !== undefined) { state.inputs = pinAll(inputs); state.records = records; state.stepPins = pinAll(state.steps) }
  return cur
}


/** Record in `state` the value of the signal step `k` (`t`) publishes, as it stands after the step (see `DatasetState.published`). */
export function notePublished(state: DatasetState, k: number, t: CompiledTransform, signals: Record<string, unknown>): void {
  const name = (t as { signal?: unknown }).signal
  if (typeof name !== 'string' || !Object.hasOwn(signals, name)) return
  ;(state.published ??= [])[k] = [signals[name]]
}


const MAY_DRAW = new WeakMap<CompiledChart, boolean>()

/**
 * Whether the pulse path is there to take a pulse every other condition allows. When it is not (the React shells load it on demand,
 * engine-parts.ts) the dataset is derived in full -- the same rows, the same state left for the next pulse -- and the part is asked
 * for, so that the evaluations after this one are incremental.
 */
function pulsePath(ctx: EvalContext): boolean {
  if (ctx.engine?.applyPipelineWithPulse !== undefined) return true
  // With an injected random source the two builds do not draw alike (the pulse path draws only for the rows it re-derives): a
  // dataset that may draw is not derived in full instead, it is a missed detection like any other empty slot (specNeeds names
  // `pulse` for it, so the shells have loaded it; C572).
  if (ctx.runtime.random !== undefined && datasetsMayDraw(ctx.chart)) part('pulse')
  requestPart('pulse')
  return false
}

/** Whether a dataset of the view may draw from the random source, its expressions read as the lexer reads them (an escaped name too). */
function datasetsMayDraw(chart: CompiledChart): boolean {
  let may = MAY_DRAW.get(chart)
  // (rows draw nothing: only the datasets' transforms and a `{signal}` values are code)
  if (may === undefined) MAY_DRAW.set(chart, (may = mayDrawRandom(chart.data.map(dataWithoutRows))))
  return may
}

/**
 * What a dataset's steps read, as it stands now: the keys of every step (see `stepKeys`), or `null` when a step's reads are not known
 * (see step-reuse.ts) or it draws from the random source. Two builds of the pipeline under the same key over the same input rows make
 * the same rows; a pulse through its steps is a pulse through what made them.
 */
function pipelineKey(ctx: EvalContext, transforms: readonly CompiledTransform[]): string | null {
  let key = ''
  for (const t of transforms) {
    const reads = stepReadsOf(t)
    if (reads === null || reads.draws) return null
    for (const k of stepKeys(ctx, reads)) key += `\u0001${k}`
    key += '\u0002'
  }
  return key
}

/**
 * The build of dataset `name` an earlier round of this pass, or the pass before this one, made (see {@link BuiltDataset}), when this
 * one would make it again: the same input arrays, the same reads, and the view's id counter where it stood then (its `identifier`s
 * draw the same numbers, or carry the numbers that build drew). Not under `limits`: what a kept build made is not counted against
 * them again.
 */
function keptBuild(ctx: EvalContext, name: string, inputs: readonly unknown[] | undefined, key: string | null): DatasetState | undefined {
  if (key === null || inputs === undefined || activeMeter() !== null) return undefined
  for (const pass of [ctx.draft, ctx.earlier]) {
    const state = pass?.datasets.get(name)
    const built = state?.built
    if (built === undefined || built.pass !== pass || built.key !== key || built.ids[0] !== ctx.ids.value) continue
    if (samePins(built.inputs, inputs)) return state
  }
  return undefined
}

/** The signals the steps publish, as they stand after the steps ran (one a step left unwritten is absent). */
function publishedBy(ctx: EvalContext, transforms: readonly CompiledTransform[]): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = []
  for (const t of transforms) {
    const p = stepReadsOf(t)?.publishes
    if (p !== undefined && Object.hasOwn(ctx.signalParams, p)) out.push([p, ctx.signalParams[p]])
  }
  return out
}

/**
 * The run of step `k` whose rows the step's rows carry the numbers of, when it numbers them (`identifier`): the pass of this
 * evaluation before this one, or the round of this pass before this one, or the evaluation before. A round before is the run only
 * when it gave the step the rows it is given now (the same input arrays, or equal rows): every round numbers from where the view's
 * counter stood when the evaluation began, so its numbers are the ones this round would draw. A round given other rows -- a dataset
 * that reads a scale is built before the scales exist -- drew numbers that are not these rows': carried, they numbered the rows
 * anew on every evaluation, with numbers another dataset held. Its rows carry the numbers of the evaluation before, as the first
 * round's did.
 */
function carriedFrom(
  ctx: EvalContext, name: string, k: number, rows: readonly Row[], inputs: readonly unknown[] | undefined,
  earlierDS: DatasetState | undefined, prevDS: DatasetState | undefined, idsStart: number | undefined,
): DatasetState | undefined {
  if (earlierDS === undefined) return prevDS
  if (earlierDS !== ctx.draft.datasets.get(name)) return earlierDS
  const other = ctx.earlier?.datasets.get(name) ?? prevDS
  // (the counter stood elsewhere when the round before built the dataset: a dataset before it was given other rows, and the numbers
  // the round drew are not the ones this round draws)
  if (earlierDS.idsStart !== idsStart) return other
  const given = k === 0 ? undefined : earlierDS.steps[k - 1]
  const same = k === 0
    ? earlierDS.inputs === undefined || inputs === undefined || samePins(earlierDS.inputs, inputs)
    : given !== undefined && (given === rows || (given.length === rows.length && given.every((r, i) => rowsEqual(r, rows[i]!))))
  return same ? earlierDS : other
}

/**
 * The numbers the rows an `identifier` is given carry, read as vega reads them: a row is a row of the pipeline's input (`source`, the
 * dataset's source or the host's rows; see `sourcesOf`), and a source row keeps the number it was given for as long as it lives, whether
 * the steps before the identifier (a filter) let it through or not, while a source row that was never numbered is numbered anew. The
 * source rows are those of the run the numbers come from (`carriedFrom`), found among the rows now as the session finds rows (see
 * identifier-ids.ts). Undefined when that run left no such numbers or the rows' source rows are not known: the rows are then found
 * among the identifier's own rows of that run, as before. (A pulse through the pipeline numbers them the same way: see
 * `applyPipelineWithPulse`.)
 */
function sourceNumbers(name: string, k: number, t: CompiledTransform, rows: readonly Row[], source: readonly Row[], run: DatasetState | undefined): { carry: unknown[]; map: number[]; before: SourceNumbers } | undefined {
  const before = run?.stepState.get(`${name}#${k}`) as SourceNumbers | undefined
  const list = sourcesOf(rows)
  if (before === undefined || list === null || !Array.isArray(before.ids)) return undefined
  const map = alignIndices(source, before.sourceRows, idField(t))
  return { carry: carryBySources(list, map, before), map, before }
}

/** What an `identifier` that just ran leaves for the next run to carry numbers from (see `sourceNumbers`). */
function numbersBySource(t: CompiledTransform, rows: readonly Row[], out: readonly Row[], source: readonly Row[], carried: ReturnType<typeof sourceNumbers>): SourceNumbers | undefined {
  const list = sourcesOf(rows)
  if (list === null || out.length !== rows.length) return undefined
  // (a source row the steps before held back keeps the number it had)
  return sourceNumbersOf(list, out, source, idField(t), carried?.map, carried?.before)
}

/** What a step reads, as it stands now (see `StepRecord.keys`): the values of its signals, then the rows of the datasets it reads. */
function stepKeys(ctx: EvalContext, reads: StepReads): string[] {
  const keys = reads.signals.map((n) => dependencyKey(ctx.signalParams[n]))
  for (const n of reads.datasets) keys.push(datasetKey(ctx, n))
  return keys
}

let unkeyed = 0

/**
 * The rows of a dataset a step reads by name, as a key: by their content (a selection's store is a few rows, copied afresh by every
 * evaluation), or, past what a fingerprint takes in, by the array. An array holds the rows it held when the caller tells every change
 * (see `followsChanges`) and did not name this dataset as changed; otherwise the key is equal to no other. A dataset that is not
 * built is `-`: the step reads no rows.
 */
function datasetKey(ctx: EvalContext, name: string): string {
  const rows = ctx.datasets.get(name)
  // (a mark's items read by name, `data('<mark>')`: no key holds them, so nothing that reads them is kept)
  if (rows === undefined) return markNamesOf(ctx.chart).has(name) ? `!${++unkeyed}` : '-'
  const key = dependencyKey(rows)
  return key.includes('#') && (ctx.affected.has(name) || !(ctx.incremental || ctx.unchanged !== undefined)) ? `!${++unkeyed}` : key
}

/** `target` stands in the order rows were made in as `rows` does (see tuple-order.ts). */
function withOrderOf(rows: readonly Row[], target: Row[]): Row[] {
  const order = orderOf(rows)
  if (order !== null) setOrder(target, order)
  return target
}


/**
 * The earlier run in which the steps `k..k + steps.length - 1`, read as they are now and over the rows they are given, ran: they
 * need not run again. A step that draws keeps its numbers only for the source it drew them from (a tape is of one source).
 * `identifier` gives a row the number it had in the committed evaluation, and numbers the others from the view's counter: run again
 * over the rows of the committed run it hands every one its number back and leaves the counter where it stands (the evaluation
 * began at the committed counter, which no number of that run is past), so the rows to keep are the committed run's -- not a run
 * of this same evaluation, which is not what the step would carry numbers from.
 */
function keptSteps(
  ctx: EvalContext, name: string, steps: readonly CompiledTransform[], reads: readonly StepReads[], keys: ReadonlyArray<readonly string[]>,
  runs: readonly DatasetState[], k: number, input: Row[], earlierPass: boolean,
): DatasetState | undefined {
  next: for (const run of runs) {
    // (the rows step k is given now are the rows the run gave it: the very array, as that run left it)
    if (k > 0 && (run.steps[k - 1] !== input || (run.stepPins !== undefined && !samePin(run.stepPins[k - 1], input)))) continue
    for (let j = 0; j < steps.length; j++) {
      const rec = run.records![k + j]
      const mine = keys[j]!
      if (rec === undefined || run.steps[k + j] === undefined || rec.keys.length !== mine.length) continue next
      for (let i = 0; i < mine.length; i++) if (rec.keys[i] !== mine[i]) continue next
      if (reads[j]!.draws && (ctx.runtime.random === undefined || rec.random?.source !== ctx.runtime.random)) continue next
      // ... and not at all when an earlier pass of this evaluation numbered the rows: every pass gives the same rows the same ids
      if (steps[j]!.type === 'identifier' && (earlierPass || run !== ctx.prev?.datasets.get(name))) continue next
    }
    return run
  }
  return undefined
}


/** Everything running the step would have done besides making its rows: the limits it counts against and what it leaves behind. */
function keepStep(ctx: EvalContext, t: CompiledTransform, reads: StepReads, rec: StepRecord, out: Row[]): void {
  const meter = activeMeter()
  if (meter) {
    meter.clock.check(`transform ${t.type}`)
    meter.checkRows(out.length, `transform ${t.type}`)
    // (`maxGeneratedRows` meters the rows an evaluation's transforms produce (LIMITS.md): a kept step produced none in it -- its
    // rows are bounded by `maxRows`, checked above, as a pulse's are)
  }
  checkRowCount(out.length, `transform ${t.type}`)
  if (reads.publishes !== undefined && rec.published !== undefined) ctx.signalParams[reads.publishes] = rec.published.value
  if (rec.random !== undefined) {
    const source = rec.random.source as () => number
    if (rec.random.carry === undefined) normalPairs.delete(source)
    else normalPairs.set(source, rec.random.carry)
  }
}


/** What a step that just ran read and left, for the evaluation that may keep it. */
function recordStep(ctx: EvalContext, reads: StepReads, keys: readonly string[], had: boolean, before: unknown): StepRecord {
  const after = reads.publishes === undefined ? undefined : ctx.signalParams[reads.publishes]
  const random = ctx.runtime.random
  return {
    keys,
    // (written: the signal is there now, and it was not or held another value)
    ...(reads.publishes !== undefined && Object.hasOwn(ctx.signalParams, reads.publishes) && (!had || after !== before) ? { published: { value: after } } : {}),
    ...(reads.draws && random !== undefined ? { random: { source: random, carry: normalPairs.get(random) } } : {}),
  }
}


/**
 * The rows a group scope's dataset makes of its sources. A pipeline whose steps read nothing but the rows and signals (see
 * step-reuse.ts) makes the same rows again while the source arrays are the same arrays -- a source dataset that was kept hands on the
 * array it made -- and the signals it mentions are as they were: the rows of the earlier run stand for it. Whole pipelines, not
 * steps: a group's dataset is a few steps over the rows of a dataset of the view.
 */
function runScopedData(
  ctx: EvalContext, key: string, name: string, transforms: CompiledTransform[], sources: readonly string[], rows: Row[] | (() => Row[]), shared: boolean,
  tctx: TransformContext, scopeParams: Record<string, unknown>,
): Row[] {
  const run = (): Row[] => {
    const input = typeof rows === 'function' ? rows() : rows
    return shared ? applyTransformsToSharedRows(input, transforms, tctx, name) : applyTransforms(input, transforms, tctx, name)
  }
  const names = reuse.on && shared ? pipelineReadsOf(transforms) : null
  const inputs = names === null ? undefined : sources.map((n) => ctx.datasets.get(n))
  // (a source the caller named as changed is updated in place: the same array holds other rows)
  if (names === null || inputs === undefined || inputs.some((a) => a === undefined) || sources.some((n) => ctx.affected.has(n))) return run()
  const arrays = inputs as Row[][]
  const keys = names.map((n) => dependencyKey(scopeParams[n]))
  for (const earlier of [ctx.draft.scoped.get(key), ctx.prev?.scoped.get(key)]) {
    if (earlier === undefined || earlier.inputs.length !== arrays.length || earlier.keys.length !== keys.length) continue
    if (!samePins(earlier.inputs, arrays) || keys.some((k, i) => earlier.keys[i] !== k)) continue
    const meter = activeMeter()
    if (meter) { meter.clock.check('transform'); meter.checkRows(earlier.out.length, 'transform') }
    checkRowCount(earlier.out.length, 'transform')
    ctx.draft.scoped.set(key, earlier)
    stepCounts.reused += transforms.length
    return earlier.out
  }
  const out = run()
  stepCounts.ran += transforms.length
  ctx.draft.scoped.set(key, { inputs: pinAll(arrays), keys, out })
  return out
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

/**
 * The snapshots of the view's scales (what a guide's caption and a worker's clone read of them), the array the scene before carried
 * when every scale is the object it was then: a snapshot is read off the scale objects alone (their domain, range, bandwidth,
 * quantiles, thresholds, bins and the colours at the domain's ends), and a scale is made again whenever anything it is made from
 * changes. The DOM patcher keeps what it made of a guide for the same array (see `guideDesc` in dom.ts).
 */
function sceneSnapshots(ctx: EvalContext): ReturnType<typeof snapshotScales> {
  const prev = ctx.prev?.snapshots
  if (prev !== undefined && sameScales(ctx, prev.scales)) {
    ctx.draft.snapshots = prev
    return prev.snaps
  }
  const snaps = snapshotScales(ctx.scales)
  ctx.draft.snapshots = { scales: [...ctx.scales], snaps }
  return snaps
}

/** Snapshot resolved scales into plain data (what the scene carries as `__scales`: see `sceneSnapshots`). */
function snapshotScales(scales: Map<string, Scale>): Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; rangeError?: string; bandwidth?: number; samples?: [unknown, unknown] }> {
  const out: Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; rangeError?: string; bandwidth?: number; samples?: [unknown, unknown] }> = []
  for (const [name, scale] of scales) {
    const s = scale as unknown as {
      type?: string
      domain?: () => unknown[]
      range?: () => unknown[]
      bandwidth?: () => number
    }
    if (typeof s.domain !== 'function' || typeof s.range !== 'function') continue
    const domain = s.domain()
    // (a range the scale cannot give, a colour scale's over an empty list, is what a reader of the snapshot gets when it asks: vega
    // asks only when a guide or an encode reads the scale, and so does the snapshot's reader; a scale nothing reads is no error)
    let range: unknown[] = []
    let rangeError: string | undefined
    try {
      range = s.range()
    } catch (e) {
      rangeError = e instanceof Error ? e.message : String(e)
    }
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
      name, type, domain: Array.from(domain), range: Array.from(range), ...(rangeError !== undefined ? { rangeError } : {}),
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

/**
 * A discrete domain fixed by its categories alone (see `DiscCensus`). A domain sorted by count or by an aggregate of another field
 * also depends on how many rows each category has or what they hold: it has no census, and a scale over it is kept only when the
 * settings it is made from are the same (see `buildScales`).
 */
function discreteCensusApplies(dom: { sort?: unknown }): boolean {
  return sortReadsCategoriesOnly(dom.sort)
}

/**
 * An ordinal scale that adds a category it is asked for to its domain (`domainImplicit`, a `domainRaw`, or no domain): the scale is
 * changed by what reads it, so once read it is not the scale its settings make, and it is never kept (a later evaluation that keeps
 * it would hand the marks it encodes again a domain grown by rows that are gone, or by marks it does not encode again).
 */
function growsOnLookup(scale: Scale): boolean {
  const unknown = (scale as { unknown?: () => unknown }).unknown
  return typeof unknown === 'function' && unknown.call(scale) === implicitCategory
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

/** The text a discrete domain tells a value's category by (`String`, as scale-domain.ts's tally); undefined when it throws. */
function categoryText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  try {
    return String(v)
  } catch {
    return undefined
  }
}

/** The census of the rows a discrete domain was just made from, or undefined when a value has no text. */
function freshDiscCensus(dom: { data: string; field: string }, rows: Row[]): DiscCensus | undefined {
  const first = new Map<string, number>()
  const vals: unknown[] = new Array(rows.length)
  const read = scaleFieldOf(dom.field)
  for (let i = 0; i < rows.length; i++) {
    const v = read(rows[i])
    vals[i] = v
    const text = categoryText(v)
    if (text === undefined) return undefined
    if (!first.has(text)) first.set(text, i)
  }
  return { data: dom.data, field: dom.field, vals, first }
}

/**
 * Advance a continuous min/max census by a pulse, or return null when the domain
 * can no longer be proven unchanged (a value left [lo,hi], or the LAST row
 * holding the min/max moved away: the extreme itself moves).
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
 * Advance a discrete category census by a pulse that keeps every row's index (rows edited in place, rows appended), in place (the
 * caller has claimed it), in O(changed + appended); or return null when the domain is not proven unchanged. It is unchanged when no
 * category's first row moves or changes its value and no category appears or goes: an edited row is not the first of its old
 * category (which so keeps a row) and joins a category that has a row before it, or keeps its text; an appended row joins a
 * category that has one. Anything else (a pulse with an index mapping, a new category, a category's first row edited) returns null,
 * and the scale is kept only if the settings it is made from are the same (see `buildScales`).
 */
function advanceDiscCensus(cen: DiscCensus, rows: Row[], pulse: StepPulse): DiscCensus | null {
  const vals = cen.vals
  const indexed = pulse.appendOnly || (!pulse.from && !(pulse.added?.length) && !(pulse.removed?.length))
  const base = pulse.appendOnly ? (pulse.baseLength ?? vals.length) : rows.length
  if (!indexed || base !== vals.length || rows.length < base) return null
  const read = scaleFieldOf(cen.field)
  const first = cen.first
  for (const i of pulse.changed) {
    if (i < 0 || i >= base) continue
    const nv = read(rows[i])
    const ov = vals[i]
    if (Object.is(ov, nv)) continue
    const was = categoryText(ov)!
    const now = categoryText(nv)
    if (now === undefined || first.get(was) === i) return null
    if (now !== was) {
      const joins = first.get(now)
      if (joins === undefined || joins > i) return null
    }
    vals[i] = nv
  }
  for (let i = base; i < rows.length; i++) {
    const nv = read(rows[i])
    const now = categoryText(nv)
    if (now === undefined || !first.has(now)) return null
    vals.push(nv)
  }
  return cen
}

/**
 * Claim the structures of the reused state a fast path is about to update in place (see IncrementalState): false when there is no
 * state to reuse or this evaluation already updated one of them -- by identity, so a structure two states share (the two passes of a
 * fit view can keep the same steps) is updated once. The reused and the committed states are flagged stale.
 */
function claim(ctx: EvalContext, parts: readonly object[]): boolean {
  if (!ctx.prev || claimed(ctx, parts)) return false
  // (a journalled write: see content-stamp.ts; closed by `endWrite` once the pulse ran)
  for (const part of parts) { ctx.claimed.add(part); beginWrite(part) }
  ctx.prev.stale = true
  if (ctx.committed !== undefined) ctx.committed.stale = true
  return true
}

/** Whether this evaluation already updated one of `parts` in place (see {@link claim}). */
function claimed(ctx: EvalContext, parts: readonly object[]): boolean {
  for (const part of parts) if (ctx.claimed.has(part)) return true
  return false
}

/** What a pulse updates in place in a dataset's state: the state, the rows of its steps and the state its steps leave. */
function datasetParts(ds: DatasetState): object[] {
  const parts: object[] = [ds, ...ds.steps]
  for (const v of ds.stepState.values()) if (typeof v === 'object' && v !== null) parts.push(v)
  return parts
}

/** What advancing a census updates in place (see advanceContCensus, advanceDiscCensus). */
function censusParts(cen: ContCensus | DiscCensus): object[] {
  return 'first' in cen ? [cen, cen.vals, cen.first] : [cen, cen.vals]
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
    evaluate: (expr) => evalSignal(ctx.runtime.expr(expr), ctx.signalParams),
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
    // (kept with the pass, as a layout's are, and once per scale however many times the pass makes it again)
    warn: (message, ...detail) => {
      const warned = (ctx.layoutState.warned ??= new Set())
      const key = `${ctx.scope.path.join('/')}:${name}:${message}`
      if (warned.has(key)) return
      warned.add(key)
      ctx.layoutState.warnings.push(detail.length ? [message, ...detail] : message)
    },
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
  // evaluation (fixed-point rounds, size re-resolution) is harmless.
  const fp = ctxFpOf(ctx)
  const reusable = ctx.incremental && prev !== undefined && prev.fp === fp
  for (const s of ctx.chart.scales) {
    const key = scaleKeyOf(s, ctx)
    // A `{ fields: [...] }` domain (vega-lite's layered charts: several datasets
    // contribute to one shared scale) is resolved by buildScale itself, from the
    // CURRENT datasets, every evaluation: the IR keeps the declared domain.
    // Such a scale has no single-dataset census, so it is never census-reused.
    const multi = isMultiFieldDomain(s.domain)
    const prevEntry = prev?.scaleEntries.get(s.name)
    const def: CompiledScale = s
    const dom = multi ? null : singleDataDomain(s.domain)
    // Signals changed, but none this scale reads (see `keyedScale`): it is reused as when none changed, over the datasets it reads.
    const keyed = !reusable && prevEntry !== undefined && prevEntry.multi === multi && keyedScale(s, ctx, prevEntry, key)
    // What the scale was made from, besides its datasets: the whole context, or what it reads of it. An ordinal scale that adds the
    // categories it is asked for to its domain is made again every time: what read it before changed it (see `growsOnLookup`).
    const stamp = prevEntry === undefined || growsOnLookup(prevEntry.scale) ? undefined
      : reusable ? (prevEntry.multi === multi ? `*${fp}` : undefined) : keyed ? key : undefined
    // This scale was already proven reusable under the very same params and
    // dataset build earlier in this evaluation (the census advances once): the datasets it names are the very arrays it was proven
    // over, which nothing writes once a round of this evaluation made them (a scale that reads datasets from an expression also
    // needs the same build of them all).
    const memo = ctx.scaleReuse.get(s.name)
    if (stamp !== undefined && memo !== undefined && memo.stamp === stamp && samePins(memo.rows, scaleRowsOf(s, ctx))
      && (scaleReadsOf(s, ctx.chart) !== null || memo.epoch === ctx.dsEpoch)) {
      ctx.scales.set(s.name, memo.entry.scale)
      ctx.scaleTypes.set(s.name, s.type)
      entries.set(s.name, memo.entry)
      continue
    }
    if (stamp !== undefined) {
      // (with every signal as it was, a dataset the caller did not name is unchanged; with some changed, a dataset the scale names
      // must be the very array it was made from, see `sameRows`. Every dataset it names, the range's too; and a scale that reads
      // datasets or scales from an expression, whichever they are, is not kept for its datasets: its settings are read again)
      const readsAll = scaleReadsOf(s, ctx.chart) === null
      const named = SCALE_READS.get(s)!.datasets
      let reuse = reusable ? !readsAll && !named.some((n) => ctx.affected.has(n)) : named.every((n) => sameRows(ctx, n))
      let entry = prevEntry!
      // An affected single-data-domain scale can still be reused when its domain
      // is provably unchanged (see the census helpers). This skips the O(n)
      // domain re-scan for the common case (few points change, domain holds, or
      // rows are appended inside the current domain).
      // (a scale of one dataset's domain reads that dataset's rows alone, see scale-domain.ts, when it names no other dataset and
      // reads none from an expression: a census proves the domain, and nothing else of it)
      if (!reuse && dom && !readsAll && named.every((n) => n === dom.data)) {
        const pulse = ctx.datasetPulses.get(dom.data)
        const rows = ctx.datasets.get(dom.data) ?? []
        if (pulse && !pulse.full) {
          if (fieldDomainKind(s.type) === 'extent' && entry.cont && entry.cont.finite
            && entry.cont.data === dom.data && entry.cont.field === dom.field) {
            // The census is updated in place for the append-only form: claim it.
            if (claim(ctx, censusParts(entry.cont))) {
              const next = advanceContCensus(entry.cont, rows, pulse)
              if (next) { reuse = true; entry = { ...entry, cont: next } }
            }
          } else if (fieldDomainKind(s.type) === 'categories' && entry.disc && discreteCensusApplies(dom)
            && entry.disc.data === dom.data && entry.disc.field === dom.field) {
            if (claim(ctx, censusParts(entry.disc))) {
              const next = advanceDiscCensus(entry.disc, rows, pulse)
              if (next) { reuse = true; entry = { ...entry, disc: next } }
            }
          }
        }
      }
      if (reuse) {
        if (entry.key !== key) entry = { ...entry, key }
        ctx.scales.set(s.name, entry.scale)
        ctx.scaleTypes.set(s.name, s.type)
        entries.set(s.name, entry)
        ctx.scaleReuse.set(s.name, { stamp, entry, rows: pinAll(scaleRowsOf(s, ctx)), epoch: ctx.dsEpoch })
        continue
      }
    }
    let scale: Scale
    let settings: Settings
    // Made under the same key (`stamp`) from the same settings, the scale is the one the evaluation before made: keep that object,
    // so what reads it is kept too. This is what proves a domain unchanged when no census can (a pulse with an index mapping, a
    // sort by count or by an aggregate, several fields, `domainRaw`): the settings are read in full, as a fresh build reads them,
    // and only the scale is not made again. Not under `limits` (a scale made again is checked against the ceilings they replace).
    // A spec with `bins` in a view that fits its viewport reads what the pass before left (`ScaleContext.pass`): under the same key
    // (which holds the pass's size, the viewport and the signals it reads) and the same data, that pass had the same settings in
    // both evaluations, so what it left is the same too.
    let kept = false
    try {
      const sctx = scaleContext(ctx, def.name)
      settings = scaleSettings(def, sctx)
      if (stamp !== undefined && prevEntry?.settings !== undefined && activeMeter() === null
        && sameScaleSettings(s.type, settings, prevEntry.settings)) {
        scale = prevEntry.scale
        settings = prevEntry.settings
        kept = true
      } else {
        scale = scaleOfSettings(settings, sctx)
      }
    } catch (e) {
      // vega: the Scale operator throws, the dataflow logs it and the run stops there -- this scale
      // and every operator after it (later scales, every encode) are never evaluated.
      failPass(ctx, { axis: -0.5, scales: true }, e)
      ctx.encodeAborted = true
      break
    }
    ctx.scales.set(s.name, scale)
    ctx.scaleTypes.set(s.name, s.type)
    const entry: ScaleEntry = { scale, multi, key, settings }
    // Track the domain census for a single-data-domain scale so a later update
    // can prove the domain unchanged instead of rescanning.
    if (dom) {
      const rows = ctx.datasets.get(dom.data) ?? []
      if (fieldDomainKind(s.type) === 'categories') {
        if (discreteCensusApplies(dom)) entry.disc = freshDiscCensus(dom, rows)
      } else if (fieldDomainKind(s.type) === 'extent') {
        entry.cont = freshContCensus(dom, rows)
      }
    }
    entries.set(s.name, entry)
    if (kept) ctx.scaleReuse.set(s.name, { stamp: stamp!, entry, rows: pinAll(scaleRowsOf(s, ctx)), epoch: ctx.dsEpoch })
  }
  ctx.draft.scaleEntries = entries
  ctx.draft.scales = new Map(ctx.scales)
}

/**
 * `sameSettings`, but a discrete scale (band, point, ordinal, bin-ordinal) given a domain override (`domainRaw`) reads its own domain nowhere (the override
 * is the domain, and the scale's family is not chosen by it), so the domain its data would give is left out of the comparison.
 */
function sameScaleSettings(type: string, a: Settings, b: Settings): boolean {
  if (fieldDomainKind(type) === 'categories' && a.domainRaw && b.domainRaw) return sameSettings({ ...a, domain: undefined }, { ...b, domain: undefined })
  return sameSettings(a, b)
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
  // (a pass cut short by a failure -- an encode that threw, in this mark or before it -- makes what vega's first run of the dataflow
  // makes, which a pulse over the items of a clean evaluation is not: the items after the failing one stay unencoded)
  if (!prevGroup || !prev || !ctx.incremental || !cleanPass(ctx)) return null
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
  if (mark.sort || mark.transform?.length || forceBound(mark, ctx.chart)) return null
  const deps = markDepsOf(mark, ctx.chart)
  // Reading other datasets from an expression: an unchanged row can still
  // encode differently, and no pulse describes that.
  if (deps.allData) return null
  const key = ctx.draft.markKeys.get(mark)
  if (key === undefined || prev.markKeys.get(mark) !== key) return null
  if (prev.fp !== ctx.draft.fp) {
    // (signals changed: none the mark reads, and the other datasets it reads must be as they were; see canReuseMarkGroup)
    if (!followsChanges(ctx) || !cleanPass(ctx) || markReadsOf(mark, ctx.chart) === null) return null
    for (const n of deps.names) if (n !== source && !sameRows(ctx, n)) return null
  }
  for (const name of markScaleNames(mark, ctx.chart)) {
    if (ctx.scales.get(name) !== prev.scales.get(name)) return null
  }
  return pulse
}

/** The bounds of one item of a mark, in the frame of the mark's group (vega's `item.bounds`). */
function itemBoundsOf(container: { marktype: string; items?: readonly SceneItem[] }, item: SceneItem): { x1: number; y1: number; x2: number; y2: number } {
  // (a mark drawn as one path -- line, area, trail -- has one bounds, which vega's Bound gives each of its items)
  if (NESTED_MARKS.has(container.marktype)) {
    let whole = NESTED_BOUNDS.get(container)
    if (whole === undefined) {
      const b = boundTypedMark(new Bounds(), container as unknown as SceneGroup)
      whole = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
      NESTED_BOUNDS.set(container, whole)
    }
    return whole
  }
  const b = container.marktype === 'group' ? boundGroupItem(new Bounds(), item as unknown as SceneGroup) : boundTypedMark(new Bounds(), { marktype: container.marktype, items: [item] } as unknown as SceneGroup)
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
}
const NESTED_MARKS: ReadonlySet<string> = new Set(['line', 'area', 'trail'])
/** The bounds of a mark drawn as one path, measured once per container (every item reads the same). */
const NESTED_BOUNDS = new WeakMap<object, { x1: number; y1: number; x2: number; y2: number }>()

/** What one channel's definition reads besides the row: the signals it names, the datasets its expressions read by name, its scales. */
interface ChannelReads { names: readonly string[] | null; data: readonly string[] | null; scales: readonly string[] | null }
const CHANNEL_READS = new WeakMap<object, ChannelReads>()
function channelReadsOf(spec: object, chart: CompiledChart): ChannelReads {
  let out = CHANNEL_READS.get(spec)
  if (out !== undefined) return out
  const data = new Set<string>()
  const scales = new Set<string>()
  let anyData = false
  let anyScale = false
  walkStrings(spec, (str, owner) => {
    const read = datasetsReadIn(str)
    if (read === null) anyData = true
    else for (const n of read) data.add(n)
    if (SCALE_FN_EXPR.test(lexedText(str))) anyScale = true
    if (owner && owner.scale === str) scales.add(str)
  }, new Set(), null, (o) => { if (o.scale != null && typeof o.scale === 'object') anyScale = true })
  out = { names: namesMentioned(spec, chart), data: anyData ? null : [...data].sort(), scales: anyScale ? null : [...scales].sort() }
  CHANNEL_READS.set(spec, out)
  return out
}

/** A number per scale object, so a key can say which scale a channel read. */
const SCALE_IDS = new WeakMap<object, number>()
let nextScaleId = 0
const scaleIdOf = (sc: unknown): string => {
  // (a scale is a function object; a name no scale has is `-`)
  if (sc === null || (typeof sc !== 'object' && typeof sc !== 'function')) return '-'
  let id = SCALE_IDS.get(sc)
  if (id === undefined) SCALE_IDS.set(sc, (id = ++nextScaleId))
  return String(id)
}

/**
 * What one channel of a leaf mark is evaluated under besides its row: the signals it names (with the view size, `extraFp` and the
 * registry, see `readsKey`), the content of the datasets its expressions read by name, and the scale objects it reads; null when it
 * reads more than it names (the clock, the random source, a dataset or a scale by a computed name). A channel that holds a URL
 * (`URL_CHANNELS`) is vetted after its encode (`vetItemUrls`), which writes what the policy made of it onto the item: its value
 * is a function of the URL policy too, as the mark key's is (`markKeyOf`).
 */
function channelKeyOf(channel: string, spec: object, ctx: EvalContext): string | null {
  const reads = channelReadsOf(spec, ctx.chart)
  if (reads.names === null || reads.data === null || reads.scales === null) return null
  let key = readsKey(ctx, reads.names)
  for (const n of reads.data) key += `\u0004${n}=${datasetKey(ctx, n)}`
  for (const n of reads.scales) key += `\u0005${n}=${scaleIdOf(ctx.scales.get(n))}`
  if (URL_CHANNELS.has(channel)) key += `\u0003${ctx.urlPolicy === undefined ? '' : dependencyKey(ctx.urlPolicy)}`
  return key
}

/** The channels whose value is a URL the evaluation vets (`vetItemUrls`). */
const URL_CHANNELS: ReadonlySet<string> = new Set(['href', 'url', 'image'])

/**
 * Channels whose value takes part in what the encode derives from several of them (`adjustSpatial` makes x/y/width/height from the
 * edges; a paint may be a gradient whose definition joins the scene's), or that is read before the others (`defined`): when one of
 * them changed, the item is encoded whole.
 */
const COUPLED_CHANNELS = new Set(['x', 'x2', 'xc', 'width', 'y', 'y2', 'yc', 'height', 'fill', 'stroke', 'defined'])

/**
 * The items of a top-level leaf mark whose rows are the ones its items were made from, when only some of its channels read what
 * changed: each item is a copy of the item before (its keys in the same order, its datum the same copy of the row) with only those
 * channels evaluated again, or null when the mark is to be encoded whole.
 *
 * An item is a function of its row and of what each channel reads besides it (`channelKeyOf`), channel by channel: `resolveEncodeSet`
 * evaluates each channel on its own, and only the `COUPLED_CHANNELS` combine (refused when one of them changed). The rows are the very
 * array the items before were made from, untouched by any change the caller told (`sameRows`), so row `i` holds what item `i`'s datum
 * holds. A channel evaluated again that comes out undefined where it had a value, or the reverse, would change the item's keys: that
 * item is encoded whole. Refused: a mark with transforms or a sort (they read the encoded values), an image (its url is vetted after
 * the encode), a mark that reads any dataset, a channel that reads more than it names, a pass that is not clean, under `limits`; an
 * error in a channel encodes the mark whole, which reports it where a whole encode does.
 */
function reencodeChannels(mark: CompiledMark, ctx: EvalContext, prevGroup: SceneGroup | null | undefined, source: string, rows: readonly Row[], encode: Record<string, EncodeValue | EncodeValue[]>): SceneItem[] | null {
  const prev = ctx.prev
  const record = prev?.channels.get(mark)
  if (prev === undefined || record === undefined || prevGroup == null || record.encode !== encode || !samePin(record.rows, rows) || record.items.length !== rows.length) return null
  if (!cleanPass(ctx) || !followsChanges(ctx) || !sameRows(ctx, source) || mark.transform?.length || mark.sort || mark.type === 'image' || forceBound(mark, ctx.chart)) return null
  const deps = markDepsOf(mark, ctx.chart)
  if (deps.allData) return null
  for (const n of deps.names) if (n !== source && !sameRows(ctx, n)) return null
  const channels = Object.keys(encode)
  if (channels.length !== record.keys.length) return null
  const changed: string[] = []
  for (let c = 0; c < channels.length; c++) {
    const key = channelKeyOf(channels[c]!, encode[channels[c]!] as object, ctx)
    if (key === null || record.keys[c] === null) return null
    if (key !== record.keys[c]) {
      if (COUPLED_CHANNELS.has(channels[c]!) || channels[c]!.startsWith(ENTER_COPY)) return null
      changed.push(channels[c]!)
    }
  }
  if (!changed.length) return null
  // (in the order a whole encode evaluates them: the plain channels, then the signal ones)
  const plan = encodePlan(encode)
  const order = [...plan.plainKeys, ...plan.signalKeys].filter((k) => changed.includes(k))
  const binding = ctx.encodeBinding
  const gen = ctx.gen
  const out = new Array<SceneItem>(record.items.length)
  try {
    for (let i = 0; i < record.items.length; i++) {
      const before = record.items[i]! as unknown as Record<string, unknown>
      const datum = before.datum as Row
      let whole = false
      let copy: Record<string, unknown> | undefined
      for (let c = 0; c < order.length; c++) {
        const k = order[c]!
        // (a link as the policy makes it, as a whole encode makes it: `vetItemUrls`)
        const v = k === 'href' ? vetLink(resolveEncodeProperty(encode[k], datum, ctx, binding), ctx) : resolveEncodeProperty(encode[k], datum, ctx, binding)
        if ((v === undefined) !== (before[k] === undefined) || (v === undefined) !== !(k in before)) { whole = true; break }
        if (Object.is(v, before[k])) continue
        if (copy === undefined) copy = { ...before }
        copy[k] = v
      }
      // (every channel evaluated again came out as it was: the item is the one before, as a kept item is)
      if (!whole && copy === undefined) { out[i] = before as unknown as SceneItem; continue }
      if (whole) {
        const row = copyTuple(rows[i] as Row)
        markTuple(row)
        const res = resolveEncodeSet(encode, row, ctx, mark.type, mark)
        res.datum = row
        res.__gen = gen
        out[i] = res
        continue
      }
      copy!.__gen = gen
      out[i] = copy as unknown as SceneItem
    }
  } catch {
    return null
  }
  if (ctx.markGradients) ctx.markGradients.partial = true
  return out
}

/** Record what each channel of a top-level leaf mark was encoded under (see `reencodeChannels`), when the pass made it whole and clean. */
function recordChannels(mark: CompiledMark, ctx: EvalContext, encode: Record<string, EncodeValue | EncodeValue[]>, rows: readonly Row[], items: readonly SceneItem[]): void {
  if (!cleanPass(ctx) || activeMeter() !== null || mark.transform?.length || mark.sort) return
  ctx.draft.channels.set(mark, { encode, rows: pin(rows), items: items.slice(), keys: Object.keys(encode).map((k) => channelKeyOf(k, encode[k] as object, ctx)) })
}

function evaluateMark(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup?: SceneGroup | null,
  given?: GivenPulse,
): SceneGroup | SceneGroup[] | null {
  // (a mark drawn from a dataset that never ran, a re-ranked one that threw or what reads it, was never joined: it is not there)
  if (ctx.lateTaint?.joined === true && readsTaint({ from: mark.from }, ctx)) return null
  // (the encode of a mark that reads what a late signal took with it never ran: its items are the join's)
  if (ctx.lateTaint !== undefined && !ctx.bareEncode && readsTaint({ encode: mark.encode, from: mark.from }, ctx)) ctx = { ...ctx, bareEncode: true }
  // A leaf mark's gradient definitions are collected apart, so the mark's list is exact: the scene's defs dedupe, and an item that
  // is not encoded (a row a pulse leaves alone) registers nothing.
  const outer = ctx.markGradients
  const own = mark.type === 'group' ? undefined : { defs: [] as SceneDef[], partial: false }
  ctx.markGradients = own
  let built: SceneGroup | SceneGroup[] | null
  try {
    built = evaluateMarkItems(mark, ctx, prevGroup, given)
  } finally {
    ctx.markGradients = outer
  }
  if (own !== undefined) {
    let defs = own.defs
    if (built && !Array.isArray(built)) {
      // (a pulse encoded only the changed rows: the group's list is read off its items, unless neither the rows before nor the ones
      // encoded now had a gradient)
      if (own.partial && (defs.length > 0 || (prevGroup != null && (GROUP_GRADIENTS.get(prevGroup)?.length ?? 0) > 0))) defs = gradientsOf(built.items as SceneItem[])
      if (defs.length > 0) GROUP_GRADIENTS.set(built, defs)
    }
    addDefs(ctx, defs)
  }
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

/**
 * An in-place write to the items array of the group before (the append path of `markItemsOf`): the array, and what undoes it
 * until the group before is turned into a lazy snapshot (`supersedeItems`), after which it is the new group's.
 */
interface InPlaceWrite { items: SceneItem[] | undefined; undo: ItemsUndo | undefined }

/**
 * A data mark's group (see `markItemsOf`). The append path writes into the items array of the scene before, which is still the
 * caller's: from the first write until that scene's group is superseded the write is undone if anything throws -- the encode,
 * the URL policy, a transform, a sort, a bound -- so a failed evaluation never leaves the scene before (or the state committed
 * with it, which the write claimed) holding items it never had.
 */
function evaluateMarkItems(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup?: SceneGroup | null,
  given?: GivenPulse,
): SceneGroup | SceneGroup[] | null {
  const inPlace: InPlaceWrite = { items: undefined, undo: undefined }
  try {
    return markItemsOf(mark, ctx, prevGroup, given, inPlace)
  } catch (e) {
    const { items, undo } = inPlace
    if (items !== undefined && undo !== undefined) {
      items.length = undo.oldLen
      for (let k = undo.idx.length - 1; k >= 0; k--) items[undo.idx[k]!] = undo.items[k]!
    }
    throw e
  }
}

/**
 * vega's DataJoin under a mark `key` (vega-view-transforms DataJoin): one item per key. Rows whose keys read as the same text are one
 * item (vega keys its items by the properties of a plain object: 1 and "1", null and "null", every object are one key), in the place
 * of the first of them, holding the last of them. `rows` itself when no two rows share a key.
 */
function joinByKey<T>(rows: readonly T[], key: (t: T) => unknown): readonly T[] {
  const at = new Map<string, number>()
  let out: T[] | undefined
  for (let i = 0; i < rows.length; i++) {
    const k = String(key(rows[i]!))
    // ('__proto__' is no own property of vega's object, so a row of that key never finds the item before it)
    const j = k === '__proto__' ? undefined : at.get(k)
    if (j === undefined) {
      if (k !== '__proto__') at.set(k, out !== undefined ? out.length : i)
      out?.push(rows[i]!)
    } else {
      out ??= rows.slice(0, i)
      out[j] = rows[i]!
    }
  }
  return out ?? rows
}

/** A mark `key`'s accessor: a field of the row, as vega's `field(key)` reads it (`a.b` is nested, `a\.b` is one name). */
const keyAccessor = (key: string) => (row: Row): unknown => getField(row, key)

function markItemsOf(
  mark: CompiledMark,
  ctx: EvalContext,
  prevGroup: SceneGroup | null | undefined,
  given: GivenPulse | undefined,
  inPlace: InPlaceWrite,
): SceneGroup | SceneGroup[] | null {
  // a scale or an encode that threw stopped vega's run: the marks after it were never joined, so they are not in the scenegraph
  if (ctx.encodeAborted) return null
  // (a `clip` given as an expression is a parameter of the mark's operator: one that throws is logged and stops the run before the
  // mark is made -- C121)
  const clip = (mark as { clip?: unknown }).clip
  if (clip !== null && typeof clip === 'object') {
    try { markClipOf(mark, ctx) } catch (e) {
      reportEvalError(ctx, e)
      ctx.encodeAborted = true
      return null
    }
  }
  if (mark.type === 'group') {
    return buildGroupMark(mark, ctx)
  }
  const source = mark.from?.data
  if (source && ctx.failedDatasets?.has(source)) return null
  // (a mark of the view's own scope, made by the evaluation's loop over its marks: `prevGroup` is its group of the evaluation before)
  const topLevel = ctx.scope.path.length === 0 && given === undefined

  let items: SceneItem[]
  // a transform of the mark threw (see `failPass`): what ranks after it is not made
  let stoppedAfterEncode = false
  // Union bounds carried over from the previous group (pure appends only) and
  // the items appended to it, so the cache survives without a recomputation.
  let carriedBounds: Bounds | undefined
  const addedItems: SceneItem[] = []
  let pendingUndo: ItemsUndo | undefined
  let hitMarked = false
  if (source) {
    // (a source that is no dataset but the name of a mark built before: that mark's items, shallow-copied as vega's tuples)
    const rawRows = ctx.datasets.get(source) ?? markRowItems(ctx, source)?.map((it) => { const r = { ...(it as unknown as Row) }; markTuple(r); return r }) ?? []
    // (a `label` transform reads the mark an item is in, and its bounds, off the item it labels: see `ITEM_MARK`)
    if (!ctx.datasets.has(source) && mark.transform?.some((t) => t.type === 'label')) {
      const container = ctx.markContainers.get(source)
      const from = markRowItems(ctx, source)
      if (container !== undefined && from !== undefined) {
        rawRows.forEach((row, i) => {
          const it = from[i]!
          Object.defineProperty(row, ITEM_MARK, { value: { marktype: container.marktype, container, bounds: () => itemBoundsOf(container, it) }, enumerable: true, configurable: true, writable: true })
        })
      }
    }
    // (the differential path reads the raw rows and clones just the changed indices, so an unchanged row is never copied; a mark's
    // transforms run on the encoded items, below)
    const rows: Row[] = rawRows

    // Keep dataset order for rect items: vega's scene keeps data order and
    // every renderer paints the array front to back (later datum on top).
    // (vega's DataJoin reads each tuple's id: a `null` or `undefined` tuple a `{signal}` values gave throws there, before any item is
    // made -- the pass stops at this mark, which is not made)
    if (ctx.primitiveTuples) {
      const at = rows.findIndex((r) => PRIMITIVE_TUPLE in r && tupleDatum(r) == null)
      if (at >= 0) {
        const dataset = (mark.from as { data?: unknown } | undefined)?.data
        failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0 }, notATuple(tupleDatum(rows[at]) as null | undefined, { dataset: typeof dataset === 'string' ? dataset : String(dataset), source: 'signal' }, at))
        ctx.encodeAborted = true
        return null
      }
    }
    const tuples = ctx.primitiveTuples ? joinPrimitiveTuples(rows) : rows
    // (a mark `key` joins rows that share a key into one item: `rows` itself when none do, so every per-row path below still applies)
    const encodeRows = mark.key !== undefined ? joinByKey(tuples, keyAccessor(mark.key)) : tuples

    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    ctx.encodeBinding = encodeBindingFor(update, ctx)
    // Per-datum differential update: when the source dataset published a pulse
    // and reuse is provably safe (see reusablePulse), keep the previous item
    // objects for unchanged indices so the DOM patcher skips them and the
    // re-encode of those items is skipped entirely (including the row clone).
    // `rows` is in dataset order (pulse indices refer to it).
    //
    // A returned scene is never observably written: structural updates
    // build a new array; appends/edits advance the engine-owned array in place
    // and turn the superseded group into a lazy snapshot (supersedeItems).
    // One item per row: refuse an over-sized mark before encoding any of it, and
    // sample the wall clock inside the encode loops.
    const meter = activeMeter()
    if (meter) meter.items(encodeRows.length, `mark ${mark.type} encoding`)
    // (joined primitive tuples are fewer items than rows: the per-row pulse does not apply to them)
    // (a mark a signal handler re-encodes, while the host holds requests, is encoded whole: its items before carry what was asked)
    const reencodes = ctx.encodeLog !== undefined && namedSetsOf(mark).length > 0
    const pulse = encodeRows !== rows || reencodes ? undefined : given !== undefined ? given.pulse : reusablePulse(mark, ctx, source, encodeRows.length, prevGroup)
    if (pulse) {
      const prevItems = given !== undefined ? given.items : prevGroup!.items as SceneItem[]
      const gen = ctx.gen
      if (ctx.markGradients) ctx.markGradients.partial = true
      // (an interactive mark's transparent items are marked `_hit` as they are encoded: an update touches only these)
      hitMarked = true
      const hittable = mark.interactive !== false
      const encodeAt = (i: number): SceneItem => {
        if (meter) meter.tick('mark encoding')
        const row = copyTuple(rows[i] as Row)
        markTuple(row)
        const res = resolveEncodeSet(update, row, ctx, mark.type, mark)
        res.datum = row
        res.__gen = gen
        if (hittable && (res as { fill?: unknown }).fill === 'transparent') (res as unknown as Record<string, unknown>)._hit = true
        return res
      }
      if (pulse.appendOnly && claim(ctx, [prevItems])) {
        const base = pulse.baseLength ?? prevItems.length
        // O(changes): advance the engine-owned array in place, claimed (so the state committed with it is stale until this
        // evaluation commits); the previous group is turned into a lazy snapshot below (supersedeItems). Until then a throw
        // anywhere in this mark undoes the write (`evaluateMarkItems`).
        const undo: ItemsUndo = { oldLen: prevItems.length, idx: [], items: [] }
        inPlace.items = prevItems
        inPlace.undo = undo
        // The cached union bounds carry over to the new group only for a pure
        // append (re-encoded items could shrink them).
        if (!pulse.changed.length) carriedBounds = GROUP_BOUNDS.get(prevGroup!)?.clone()
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
        // Stamp the array when an EXISTING item was re-encoded in place, so a
        // consumer holding a snapshot (canvas append) can tell "pure append"
        // from "edited" in O(1) without scanning, or reading, the old scene.
        if (undo.idx.length) (prevItems as SceneItem[] & { __editGen?: number }).__editGen = ctx.gen
        // (the array a later evaluation's records pinned is not the content it holds now: see content-stamp.ts)
        wrote(prevItems)
        items = prevItems
        pendingUndo = undo
      } else if (pulse.appendOnly) {
        // (the array was already written in place by this evaluation: the items are encoded into a copy of it)
        const base = pulse.baseLength ?? prevItems.length
        const next = prevItems.slice(0, base)
        for (const i of pulse.changed) if (i >= 0 && i < base) next[i] = encodeAt(i)
        for (let i = base; i < encodeRows.length; i++) next.push(encodeAt(i))
        items = next
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
      // (a top-level mark over the rows its items were made from, only some of whose channels read what changed: see `reencodeChannels`)
      const reencoded = topLevel && encodeRows === rows && !meter && !reencodes ? reencodeChannels(mark, ctx, prevGroup, source, rows, update) : null
      if (reencoded !== null) {
        items = reencoded
      } else if (meter) {
        // Same loop with the clock sampled every 1024 items (limits ON only).
        items = new Array<SceneItem>(encodeRows.length)
        for (let i = 0; i < encodeRows.length; i++) {
          const copy = copyTuple(encodeRows[i]!)
          markTuple(copy)
          const datum = PRIMITIVE_TUPLE in copy ? tupleDatum(copy) as Row : copy
          const res = resolveEncodeSet(update, datum, ctx, mark.type, mark)
          res.datum = datum
          res.__gen = gen
          items[i] = res
          meter.tick('mark encoding')
        }
      } else {
        items = encodeRows.map((row) => {
          const copy = copyTuple(row)
          markTuple(copy)
          // (a primitive tuple is the primitive itself to its item, as in vega)
          const datum = PRIMITIVE_TUPLE in copy ? tupleDatum(copy) as Row : copy
          const res = resolveEncodeSet(update, datum, ctx, mark.type, mark)
          res.datum = datum
          res.__gen = gen
          return res
        })
      }
      if (topLevel && encodeRows === rows) recordChannels(mark, ctx, update, rows, items)
    }
  } else {
    // vega-parser marks/data.js: a mark without `from` is made from a generated singleton `{}`, which its encode reads and its
    // item carries as `datum` (what `event.item.datum`, a tooltip handler and the scene expose)
    const update = mark.encode?.update ?? mark.encode?.enter ?? {}
    const datum: Row = {}
    markTuple(datum)
    const res = resolveEncodeSet(update, datum, ctx, mark.type, mark)
    res.datum = datum
    res.__gen = ctx.gen
    items = [res]
  }

  // a signal handler's `encode: <set>`: the items it asked for, re-encoded as vega's Encode left them (encode-handlers.ts)
  if (namedSetsOf(mark).length > 0 && !ctx.encodeAborted) items = applyEncodeRequests(mark, items, ctx)

  // vega-parser mark.js: a mark's `transform`s run right after the encode, on the encoded items: the items are the transforms'
  // tuples (`datum.x` is what the encode gave the item, `datum.datum` its data), and what they compute is written onto the items,
  // which are drawn by it (see `transformMarkItems`). A transform that throws stops the pass there, the mark made in full.
  // (an encode that threw stopped the pass before them: they never ran, and the items stay in data order)
  if (ctx.encodeAborted) stoppedAfterEncode = true
  // (what reads a late signal that threw never ran, nor what comes after it: see `transformMarkItems`)
  let transformed = true
  if (mark.transform?.length && items.length && !stoppedAfterEncode) {
    try {
      transformed = transformMarkItems(mark, items, ctx, source)
    } catch (e) {
      failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, e)
      stoppedAfterEncode = true
    }
  }

  // vega's SortItems: a mark `sort` orders the ENCODED items by their own
  // properties (`x`, `datum.t`, `datum["t"]`), after the encode and before the
  // bound pass; stable. A sort that throws stops the pass there: the items stay in data order.
  const rowOrder = items
  if (mark.sort && source && !stoppedAfterEncode && transformed && sortRuns(mark, ctx)) {
    try { items = sortMarkItems(items, mark.sort) } catch (e) {
      failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, e)
      stoppedAfterEncode = true
    }
  }
  // vega's Bound: the items are measured after the transforms and the sort. A value that cannot be drawn (path text vega's reader
  // refuses, a custom symbol shape likewise, a curve that is not there, a clip path: see bound-failure.ts) stops the pass there,
  // the mark made in full: the marks after it are never made, and the view is not laid out.
  let unmeasuredFrom: number | undefined
  if (!stoppedAfterEncode && transformed && ctx.bareEncode !== true) {
    // (a channel that no encode set defines and no transform of the mark writes -- a geopath writes each item's path -- holds one
    // value on every item: the first item is judged for all; see boundFailure)
    const judged = mark.type === 'path' ? 'path' : 'shape'
    const uniform = !(mark.transform?.length) && !Object.values(mark.encode ?? {}).some((set) => set != null && Object.prototype.hasOwnProperty.call(set, judged))
    const failure = boundFailure(mark.type, items, markClipPath(mark, ctx), mark.type === 'shape' && !shapeIsLiteral(mark), uniform)
    if (failure !== undefined) {
      failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, failure.error)
      stoppedAfterEncode = true
      unmeasuredFrom = failure.from
      // (a shape mark's item holds no shape of vega's to write: its SVG renderers fail on it, where the others' fail drawing their
      // geometry themselves)
      if (mark.type === 'shape' && failure.from !== undefined && items[failure.from] !== undefined) (items[failure.from] as unknown as Record<string, unknown>)._drawError = failure.error
    }
  }
  // (the marks after it are never made)
  if (stoppedAfterEncode) ctx.encodeAborted = true

  // (vega's mark defaults -- the `line`, `area`, `text` config blocks, the `point`, `circle`, `square` and `trail` styles -- are the
  // compiled encode's own, as vega-parser's applyDefaults writes them: a channel the encode defines, an explicit null included, has
  // none, C396)

  // A shape mark draws the shape its items hold (`shape`: a mark geoshape transform's, or the encode's), as vega's does; an item
  // with none is vega's renderer failing on it, reported once. (Neither the datum's `shape` / `path` nor a `geoshape` mark type is a
  // shape: vega draws neither.)
  if (mark.type === 'shape') {
    let missing = false
    for (const it of items) {
      const own = (it as { shape?: unknown }).shape
      if (typeof own === 'string') it.path = own
      else missing = true
    }
    // (a mark whose geoshape transform failed has its own error, reported where the transform failed)
    const shapes = mark.transform?.some((t) => (t as { type?: unknown }).type === 'geoshape') === true
    if (missing && !shapes) reportEvalError(ctx, new TypeError("Cannot read properties of undefined (reading 'context')"))
  }

  // (the URLs of the items went through the URL policy as each was encoded: `resolveEncodeSet`; the renderers vet again what
  // they write)

  // An interactive mark's transparent items are still hit by the pointer: vega's live SVG draws them with
  // `fill="transparent"`, which the string renderer (like ours) omits. `_hit` marks them for `pointer-events`.
  if (mark.interactive !== false && !hitMarked) {
    for (const it of items) if ((it as { fill?: unknown }).fill === 'transparent') (it as unknown as Record<string, unknown>)._hit = true
  }

  // The engine's items array: the only in-place writes it ever gets are the append path's (above), which stamps every in-place
  // replacement with `__editGen`. A consumer may take "the same array, no stamp since" as proof that the items it saw are still
  // the ones there, without reading them (dom.ts dense chunks, canvas.ts append).
  ;(items as SceneItem[] & { __engineItems?: true }).__engineItems = true

  // Appended items extend the carried union bounds only now, after the mark
  // defaults above ran (they can change an item's stroke and so its bounds).
  const group: SceneGroup = {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    ...markClipOf(mark, ctx),
    items,
    __source: mark.from?.data,
    ...(mark.key !== undefined ? { __keyFields: [mark.key] } : {}),
    ...(encodesHref(mark) ? { hasLinks: true } : {}),
    ...markContainerInfo(mark),
    ...(unmeasuredFrom !== undefined ? { unmeasuredFrom } : {}),
  }
  if (carriedBounds) {
    // (each added item measured as a fresh evaluation measures it: by the mark's type -- a text's own box, a rect's or a rule's miter)
    for (const it of addedItems) carriedBounds.union(boundTypedMark(new Bounds(), { marktype: mark.type, items: [it] } as unknown as SceneGroup))
    GROUP_BOUNDS.set(group, carriedBounds)
  }
  if (pendingUndo && prevGroup) {
    supersedeItems(prevGroup, group, pendingUndo)
    // (the write is the new group's now; the group before reads its own items through the snapshot)
    inPlace.undo = undefined
  }
  if (rowOrder !== items) ROW_ITEMS.set(group, rowOrder)
  return group
}

/** `ctx.encodeLog` from the host's signal store (a symbol key: see encode-handlers.ts). */
function encodeLogEntry(signals: unknown): { encodeLog?: EncodeLog } {
  const log = encodeLogOf(signals)
  return log !== undefined ? { encodeLog: log } : {}
}

/** A mark (or group subtree) with encode sets a handler can name is made again whenever the requests change. */
function encodeLogKey(mark: CompiledMark, ctx: EvalContext): string {
  return ctx.encodeLog !== undefined && hasNamedSetsIn(mark) ? `\u0006${ctx.encodeLog.rev}` : ''
}

const MARK_UIDS = new WeakMap<CompiledMark, number>()
let markUid = 0

/**
 * The items of a mark with named encode sets, named for the event loop (`<mark>|<group instance>|<row>`), with the requests of the
 * host's log applied as vega's Encode applies them (vega-functions `encode`): a request is evaluated once, at the first evaluation
 * that sees it, with the set it names; what it writes is kept on the item. A channel the mark's own `update` writes is taken back
 * by the next run of `update` on the item, which vega makes when a parameter of the mark's encode sets (a signal, a scale) or the
 * item's datum changed (`print` below); a channel only named sets write stays. The items the requests touch are new objects.
 */
function applyEncodeRequests(mark: CompiledMark, items: SceneItem[], ctx: EvalContext): SceneItem[] {
  let uid = MARK_UIDS.get(mark)
  if (uid === undefined) MARK_UIDS.set(mark, (uid = ++markUid))
  const prefix = `${uid}|${ctx.scope.path.join('.')}|`
  const sets = mark.encode?.update != null ? [...namedSetsOf(mark), 'update'] : namedSetsOf(mark)
  for (let i = 0; i < items.length; i++) { stampEncodeIdent(items[i]!, prefix + i); stampEncodeSets(items[i]!, sets) }
  const log = ctx.encodeLog
  if (log === undefined) return items
  const kept = keptItems(log.session)
  const mine = log.requests.filter((r) => r.ident.startsWith(prefix))
  let touched = false
  for (const id of kept.keys()) if (id.startsWith(prefix)) { touched = true; break }
  if (!mine.length && !touched) return items
  // what a run of `update` follows: the values of the signals and scales the mark's encode sets read, and the item's datum
  const scales = markScaleNames(mark, ctx.chart).map((n) => {
    const sc = ctx.scales.get(n) as { domain?: () => unknown; range?: () => unknown } | undefined
    try { return sc ? JSON.stringify([n, sc.domain?.(), sc.range?.()]) : n } catch { return n }
  })
  const params = `${readsKey(ctx, namesMentioned(mark, ctx.chart))}\u0007${scales.join('\u0007')}`
  const print = (item: SceneItem): string => {
    try { return `${params}\u0007${JSON.stringify((item as { datum?: unknown }).datum)}` } catch { return `${params}\u0007?` }
  }
  const owned = new Set(mark.updateChannels ?? [])
  const out = items.slice()
  for (const r of mine.slice().sort((a, b) => a.seq - b.seq)) {
    const at = Number(r.ident.slice(prefix.length))
    const item = items[at]
    let k = kept.get(r.ident)
    if (k !== undefined && k.done >= r.seq) continue
    if (k === undefined) kept.set(r.ident, (k = { done: r.seq, channels: new Map() }))
    k.done = r.seq
    const set = mark.encode?.[r.set]
    if (item === undefined || set == null || typeof set !== 'object') continue
    const res = resolveEncodeSet(set, (item as { datum?: Row }).datum ?? {}, ctx, mark.type, mark) as unknown as Record<string, unknown>
    const p = print(item)
    // (the mark's `update` set is the spec's own, which the compiled `update` holds with the `enter` channels merged in: a request
    // for it -- vega's hover leave -- runs the channels the spec's update writes, not those only `enter` writes)
    const only = r.set === 'update' ? owned : undefined
    for (const c of Object.keys(set)) if ((only === undefined || only.has(c)) && Object.hasOwn(res, c)) k.channels.set(c, { value: res[c], print: p })
  }
  for (const [id, k] of kept) {
    if (!id.startsWith(prefix)) continue
    const at = Number(id.slice(prefix.length))
    const item = items[at]
    if (item === undefined) continue
    const p = print(item)
    const over: Record<string, unknown> = {}
    let any = false
    for (const [c, v] of k.channels) {
      if (v.print !== p && owned.has(c)) { k.channels.delete(c); continue }
      over[c] = v.value
      any = true
    }
    if (!any) continue
    const next = { ...item, ...over } as SceneItem
    stampEncodeIdent(next, id)
    stampEncodeSets(next, sets)
    out[at] = next
  }
  return out
}

/** The items of a sorted leaf mark in the order of its rows (the group's `items` are in the sort's order). */
const ROW_ITEMS = new WeakMap<SceneGroup, SceneItem[]>()

/** The items of a sorted group mark in the order of its rows, keyed by the sorted array the group mark's evaluation returns. */
const GROUP_ROW_ITEMS = new WeakMap<readonly SceneItem[], readonly SceneItem[]>()

/**
 * The items a later mark of `from: {data: <name>}` is drawn from: those of the named mark in the order of its ROWS, not of its
 * `sort`. vega-parser hands such a mark the pulse of the named mark's items, whose tuples come in the order they were added;
 * SortItems sorts only the array that is drawn (`mark.items`), which is what `data('<name>')` and a `lookup` from the mark read
 * (`ctx.markItems`).
 */
function markRowItems(ctx: EvalContext, name: string): SceneItem[] | undefined {
  const drawn = ctx.markItems.get(name)
  if (drawn === undefined) return undefined
  const container = ctx.markContainers.get(name) as SceneGroup | undefined
  return (container !== undefined ? ROW_ITEMS.get(container) : undefined) ?? (GROUP_ROW_ITEMS.get(drawn) as SceneItem[] | undefined) ?? drawn
}

/** A pulse a caller worked out for a mark's rows, and the items (in row order) it is relative to: see `evaluateInstanceMark`. */
interface GivenPulse { pulse: StepPulse; items: SceneItem[] }

/**
 * A leaf mark inside a group item (a facet's cell, a concat's view, a line per category). The evaluation before made it in the item of
 * the same key (`InstanceMark`); it is kept when nothing it reads changed, and only the rows that changed are encoded when its rows
 * changed. What it reads: its key (`markKeyOf` in the item's scope: the signals it names, the size), the group item (its box, datum,
 * `parent` and encode, compared by value), the scales it reads and the other datasets it reads (the same objects), and its rows,
 * compared by value with the data its items were made from (`diffRows` over each item's `datum`, a copy made when it was encoded).
 * Rows that differ only where they are (an append, an edit, a removal, a move) splice the items; a mark with transforms, one bound to
 * a force's links, one that reads datasets from expressions, and a pass that failed, under `limits` or cut short, are made in full.
 * The items it is relative to are never written: a splice makes a new array.
 */
function evaluateInstanceMark(mark: CompiledMark, ctx: EvalContext, id: string, itemContext: Record<string, unknown>): SceneGroup | SceneGroup[] | null {
  const source = mark.from?.data
  const eligible = mark.type !== 'group' && !mark.transform?.length && source !== undefined && ctx.datasets.has(source)
    && !forceBound(mark, ctx.chart) && !readsAllDataInScope(mark, ctx.chart) && !readsOuterGroup(mark)
  if (!eligible) return evaluateMark(mark, ctx)
  // (what it reads of the signals: as a top-level mark's, its `from` being a dataset of its scope, see `readsAllDataInScope`)
  const key = markKeyOf(mark, ctx, namesMentioned(mark, ctx.chart))
  const scales = markScaleNames(mark, ctx.chart).map((n) => [n, ctx.scales.get(n)] as const)
  // (the datasets it names, and those its expressions read by name: a selection's store; pinned, since a pulse advances a dataset's
  // array in place -- see content-stamp.ts)
  const named = markDepsOf(mark, ctx.chart)
  const deps = [...new Set([...named.names, ...named.exprData])].filter((n) => n !== source).sort().map((n) => [n, pin(ctx.datasets.get(n))] as const)
  const rows = ctx.datasets.get(source)!
  const prev = ctx.prev?.instances.get(id)
  let given: GivenPulse | undefined
  if (prev !== undefined && prev.key === key && cleanPass(ctx) && ctx.abort.cut === undefined && activeMeter() === null
    && ctx.lateTaint === undefined && ctx.bareEncode !== true && !ctx.encodeAborted
    && prev.scales.length === scales.length && prev.scales.every(([n, sc], i) => scales[i]![0] === n && scales[i]![1] === sc)
    && prev.deps.length === deps.length && prev.deps.every(([n, d], i) => deps[i]![0] === n && samePin(d, deps[i]![1].of))
    && equalCell(prev.item, itemContext)) {
    const datums = prev.rowItems.map((it) => (it as { datum?: unknown }).datum)
    // (an item's datum is a shallow copy of its row: an object or array a row holds is the very one the new row holds, so a write into
    // it, which a host may have made before handing new rows, cannot be seen by comparing them -- such rows are made again, as the
    // view's marks are when the caller does not say what changed: C541)
    const diff = datums.every((d) => d !== null && typeof d === 'object' && !holdsNested(d as Row)) ? diffRows(datums, rows) : null
    if (diff !== null && diff.sameLength && diff.changed.length === 0) {
      // (nothing it reads changed: the mark is the one the evaluation before made)
      keepInstanceMark(mark, ctx, prev.group)
      ctx.draft.instances.set(id, { ...prev, item: itemContext })
      return prev.group
    }
    if (diff !== null) given = { pulse: diff.sameLength ? { changed: diff.changed } : { changed: diff.changed, from: diff.from ?? appendMapping(datums.length, rows.length), ...(diff.to ? { to: diff.to } : {}) }, items: prev.rowItems }
  }
  const built = evaluateMark(mark, ctx, given !== undefined ? prev!.group : null, given)
  // (only a mark made whole in a pass that has not failed is a base: one whose encode threw is what the failure left of it)
  if (built !== null && !Array.isArray(built) && cleanPass(ctx) && ctx.abort.cut === undefined && activeMeter() === null) {
    ctx.draft.instances.set(id, { group: built, rowItems: ROW_ITEMS.get(built) ?? (built.items as SceneItem[]), key, item: itemContext, scales, deps })
  }
  return built
}

/**
 * Whether a mark may read the group item it is in beyond its box: a field reference to the group or to the parent (`{field: {group:
 * "datum.k"}}`, `{field: {parent: "count"}}`), anywhere in it. An expression reads the item's datum as the signal `parent` of the
 * item's scope, which is in the mark's key by its value (`markKeyOf`); `group()` and `item` are event functions, which an encode
 * cannot call.
 */
const READS_GROUP_ITEM = new WeakMap<CompiledMark, boolean>()
function readsGroupItem(mark: CompiledMark): boolean {
  let out = READS_GROUP_ITEM.get(mark)
  if (out !== undefined) return out
  out = false
  const visit = (v: unknown, depth: number): void => {
    if (out || depth > 64) { out = true; return }
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'group' || k === 'parent') { out = true; return }
      visit(x, depth + 1)
    }
  }
  visit(mark, 0)
  READS_GROUP_ITEM.set(mark, out)
  return out
}

/** Whether a row holds an object or an array (a Date is a value: compared by its time). */
function holdsNested(row: Row): boolean {
  for (const k in row) {
    const v = row[k]
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) return true
  }
  return false
}

/**
 * Whether a mark reads a group item above its own (`{field: {group | parent, level: 2+}}`): the item context it is kept by is its
 * own group item's, so such a mark is made again.
 */
const READS_OUTER_GROUP = new WeakMap<CompiledMark, boolean>()
function readsOuterGroup(mark: CompiledMark): boolean {
  let out = READS_OUTER_GROUP.get(mark)
  if (out !== undefined) return out
  out = false
  const visit = (v: unknown, depth: number): void => {
    if (out || depth > 64) { out = true; return }
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
    const o = v as Record<string, unknown>
    if ((o.group !== undefined || o.parent !== undefined) && o.level !== undefined && Math.max(1, +(o.level as number) || 1) > 1) { out = true; return }
    for (const x of Object.values(o)) visit(x, depth + 1)
  }
  visit(mark, 0)
  READS_OUTER_GROUP.set(mark, out)
  return out
}

/**
 * `markDepsOf(mark).allData`, for a mark inside a group item whose `from` is a dataset of its scope (a facet's partition, a group's
 * own data): such a name is not one of the view's datasets, which `markDepsOf` takes for a mark's name. Its other reasons stand.
 */
const SCOPED_ALL_DATA = new WeakMap<CompiledMark, boolean>()
function readsAllDataInScope(mark: CompiledMark, chart: CompiledChart): boolean {
  let out = SCOPED_ALL_DATA.get(mark)
  if (out === undefined) SCOPED_ALL_DATA.set(mark, (out = markDepsOf({ ...mark, from: undefined }, chart).allData))
  return out
}

/** For rows appended to `before` rows (a diff that names no mapping), each row's index among the rows before, or -1 for a new one. */
function appendMapping(before: number, length: number): number[] {
  const from = new Array<number>(length)
  for (let i = 0; i < length; i++) from[i] = i < before ? i : -1
  return from
}

/** What a kept leaf mark leaves the evaluation, as `evaluateMark` leaves a mark it makes: its gradients, and its items by its name. */
function keepInstanceMark(mark: CompiledMark, ctx: EvalContext, group: SceneGroup): void {
  const kept = GROUP_GRADIENTS.get(group)
  if (kept !== undefined) addDefs(ctx, kept)
  if (typeof mark.name === 'string') {
    ctx.markItems.set(mark.name, (group.items ?? []) as SceneItem[])
    ctx.markContainers.set(mark.name, group as unknown as { marktype: string; items: SceneItem[] })
  }
}

function encodesDescription(mark: CompiledMark): boolean {
  const enc = mark.encode as Record<string, Record<string, unknown> | undefined> | undefined
  return !!enc && Object.values(enc).some((set) => set && 'description' in set)
}

function encodesHref(mark: CompiledMark): boolean {
  const enc = mark.encode as Record<string, Record<string, unknown> | undefined> | undefined
  return !!enc && Object.values(enc).some((set) => set && 'href' in set)
}

/**
 * The URL channels of one item through the evaluation's URL policy: the one place the evaluation vets an item's URLs, for data
 * marks, group items and every node of a guide. The `href` of any item (a link); on an image item, its `url` and the `src` of an
 * `image` bitmap object (what the renderers draw an image from). A refused URL throws {@link AsterUrlError}, or, with `onDeny`,
 * is dropped: a link leaves the item unlinked, an image leaves it undrawn (`urlDenied`). An image `url` is vetted as it will be
 * drawn: resolved against the base as vega's loader resolves it (`resolveImageUrl`), so `allow` sees exactly the drawn url; the
 * text as written passes the protocol and credential checks too, so a `file:` url is refused even though the drawn form would
 * be its path. With no policy, only the drawn form is made. (The renderers vet every URL they write once more, with this policy
 * or the defaults: see url-policy.ts `outputUrl`; this is where a refusal is reported.)
 */
function vetItemUrls(it: SceneItem, image: boolean, ctx: EvalContext): void {
  const policy = ctx.urlPolicy
  const rec = it as unknown as Record<string, unknown>
  if (policy === undefined) {
    if (image && it.url != null) it.url = resolveImageUrl(it.url, undefined) as string
    return
  }
  if (it.href != null && applyLinkUrlPolicy(it.href, policy) == null) it.href = undefined
  if (!image) return
  if (it.url != null) {
    const drawn = resolveImageUrl(it.url, policy.baseURL)
    // (the text as written: protocols and credentials only; the hook is asked once, about the url that is drawn)
    const final = drawn !== it.url && applyImageUrlPolicy(it.url, basicPolicyOf(policy)) == null ? null : applyImageUrlPolicy(drawn, policy)
    if (final == null) { it.url = undefined; rec.urlDenied = true }
    else it.url = final as string
  }
  const bitmap = rec.image
  if (bitmap !== null && typeof bitmap === 'object' && typeof (bitmap as { src?: unknown }).src === 'string') {
    if (applyImageUrlPolicy((bitmap as { src: string }).src, policy) == null) { rec.image = undefined; rec.urlDenied = true }
  }
}

/** A link channel's value as the policy makes it (`vetItemUrls`): the value, or undefined when it is refused with `onDeny`. */
function vetLink(href: unknown, ctx: EvalContext): unknown {
  if (href == null || ctx.urlPolicy === undefined) return href
  return applyLinkUrlPolicy(href, ctx.urlPolicy) == null ? undefined : href
}

/** A policy's protocol and credential checks without its hook (the same `onDeny`). */
const BASIC_POLICIES = new WeakMap<ImageUrlPolicy, ImageUrlPolicy>()
function basicPolicyOf(policy: ImageUrlPolicy): ImageUrlPolicy {
  let basic = BASIC_POLICIES.get(policy)
  if (basic === undefined) {
    basic = { ...policy }
    delete basic.allow
    BASIC_POLICIES.set(policy, basic)
  }
  return basic
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
  /** The datum the item's content reads as `parent`, where it is not the item's own (see {@link groupSources}). */
  parent?: Row
  facetName?: string
  /** Names this item among its mark's (the facet partition's key, a datum's index): the identity of its signal scope. */
  key?: string
  /** The mark's PreFacet threw making the items' content (see groupSources): the items are made empty and the pass stops after them. */
  failure?: { error: unknown }
  /** The item's content never ran (its mark's PreFacet or `layout` parameter threw): it is the empty group. */
  hollow?: boolean
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
 * The items a group mark produces (vega-parser parsers/mark.js + parsers/marks/data.js): one per
 * facet partition of the source data (first-appearance order, datum = the
 * partition's key fields plus any facet aggregate), one per datum of `from.data`,
 * or a single item with no source.
 */
/** Whether a facet parameter (or a list of them) holds a `{signal}`. */
const holdsSignalRef = (v: unknown): boolean => isSignal(v) || (Array.isArray(v) && v.some(isSignal))

/**
 * A facet with the `{signal}`s of its parameters read (vega-parser reads `groupby`, `field` and the facet aggregate's `fields`,
 * `ops`, `as` and `cross` as signal references: a field name, a list of them, a flag), for this evaluation (C126).
 */
function resolvedFacet(facet: FacetDef | undefined, ctx: EvalContext): FacetDef | undefined {
  if (facet === undefined) return undefined
  const ag = facet.aggregate as Record<string, unknown> | undefined
  if (!holdsSignalRef(facet.groupby) && !holdsSignalRef(facet.field) && !(ag && Object.values(ag).some(holdsSignalRef))) return facet
  const list = (v: unknown): unknown[] => { const r = paramValue(ctx, v); return (Array.isArray(r) ? r : [r]).map((x) => paramValue(ctx, x)) }
  const out: FacetDef = { ...facet }
  if (facet.field !== undefined) out.field = paramValue(ctx, facet.field) as string
  if (facet.groupby !== undefined) out.groupby = list(facet.groupby) as string[]
  if (ag) {
    const a: Record<string, unknown> = { ...ag }
    for (const k of ['fields', 'ops', 'as'] as const) if (ag[k] !== undefined) a[k] = list(ag[k])
    if (ag.cross !== undefined) a.cross = paramValue(ctx, ag.cross)
    out.aggregate = a as FacetDef['aggregate']
  }
  return out
}

function groupSources(mark: CompiledMark, ctx: EvalContext): GroupSource[] | null {
  const facet = resolvedFacet((mark.from as { facet?: FacetDef } | undefined)?.facet, ctx)
  if (facet?.field !== undefined) {
    // vega-transforms PreFacet: one group item per datum (the datum is the item's datum), its rows the array the
    // datum holds in `field`
    const get = fieldOf(facet.field)
    // (vega's PreFacet walks each datum's array with `forEach`: a datum whose field holds none throws there, which the dataflow logs,
    // stopping the pass at this mark -- C121)
    const rowsOf = (row: Row): Row[] => {
      const held = get(row) as unknown
      if (held == null) throw new TypeError(`Cannot read properties of ${held === null ? 'null' : 'undefined'} (reading 'forEach')`)
      if (typeof (held as { forEach?: unknown }).forEach !== 'function') throw new TypeError('field(...).forEach is not a function')
      const out: Row[] = []
      ;(held as { forEach(f: (x: Row) => void): void }).forEach((x) => { out.push(x) })
      return out
    }
    const data = ctx.datasets.get(facet.data) ?? []
    try {
      return data.map((row, i) => ({
        datum: row,
        rows: ingestRows(rowsOf(row)),
        facetName: facet.name,
        key: String(i),
      }))
    } catch (e) {
      // (PreFacet runs after the group items are joined and encoded, and makes their subflows: the items are there, empty -- none of
      // their content ran -- and the pass stops after them)
      return data.map((row, i) => ({ datum: row, rows: [], facetName: facet.name, key: String(i), ...(i === 0 ? { failure: { error: e } } : {}) }))
    }
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
    let grouped: ReturnType<typeof aggregateGroups>
    try {
      grouped = part('aggregate').aggregateGroups(rows, { groupby: keys, ...(ag?.ops ? { fields: ag.fields, ops: ag.ops, as } : {}), ...(ag?.cross ? { cross: true } : {}) })
    } catch (e) {
      // (a cross-product over a nested path reads a path from a row that has only the name: the aggregate throws, the run stops
      // there, and the mark is never made)
      reportEvalError(ctx, e)
      ctx.encodeAborted = true
      return null
    }
    // The group items are the aggregate rows joined on the flat key (see flatKeyFn): rows that share one are ONE item, in the
    // place of the first, whose datum is the last. Its content is the cell of the last of them that has rows (each cell's marks
    // are made in the one item, the last made is what stays), and reads that cell's row as its `parent`; an item none of whose
    // cells has rows is the hollow group.
    const itemKey = flatKeyFn(keys)
    const places = new Map<string, number>()
    const items: GroupSource[] = []
    const content: Array<{ rows: Row[]; parent?: Row }> = []
    grouped.tuples.forEach((datum, i) => {
      const cell = parts.get(grouped.keys[i]!)
      const id = itemKey(datum)
      let at = places.get(id)
      if (at === undefined) {
        places.set(id, (at = items.length))
        content.push({ rows: [] })
        items.push({ datum, facetName: facet.name, key: grouped.keys[i]! })
      } else {
        items[at] = { datum, facetName: facet.name, key: grouped.keys[i]! }
      }
      if (cell !== undefined) content[at] = { rows: cell, parent: datum }
    })
    items.forEach((item, i) => {
      // (the aggregate's output is a tuple: `isTuple(group().datum)`)
      markTupleAlways(item.datum)
      item.rows = content[i]!.rows
      item.parent = content[i]!.parent
    })
    return items
  }
  const data = mark.from?.data
  // (a mark `key` joins the rows that share one into one group item: see joinByKey)
  if (data) return (mark.key !== undefined ? joinByKey(ctx.datasets.get(data) ?? [], keyAccessor(mark.key)) : ctx.datasets.get(data) ?? []).map((row, i) => ({ datum: row, key: String(i) }))
  const datum: Row = {}
  markTuple(datum)
  return [{ datum }]
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

/**
 * The fields that identify a group item among its mark's items across evaluations (see `SceneGroup.__keyFields`): the mark's
 * `key`, else the `groupby` of a facet that partitions by it (vega keeps one item per partition key). One array per mark.
 */
const ITEM_KEY_FIELDS = new WeakMap<CompiledMark, readonly string[] | null>()
function itemKeyFields(mark: CompiledMark, ctx: EvalContext): readonly string[] | undefined {
  const given = (mark.from as { facet?: FacetDef } | undefined)?.facet
  // (a `groupby` given by a signal is this evaluation's: read each time, not kept)
  if (given !== undefined && holdsSignalRef(given.groupby) && mark.key === undefined) {
    const groupby = given.field === undefined && mark.from?.data === undefined ? ([] as string[]).concat(resolvedFacet(given, ctx)!.groupby ?? []) : []
    return groupby.length ? groupby : undefined
  }
  let fields = ITEM_KEY_FIELDS.get(mark)
  if (fields === undefined) {
    const facet = given
    const groupby = facet !== undefined && facet.field === undefined && mark.from?.data === undefined ? ([] as string[]).concat(facet.groupby ?? []) : []
    fields = mark.key !== undefined ? [mark.key] : groupby.length ? groupby : null
    ITEM_KEY_FIELDS.set(mark, fields)
  }
  return fields ?? undefined
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
  // (the mark's own zindex orders it among the marks of its scope, `paintOrderOf`: a leaf mark holds it as vega's mark does; a group
  // mark has no node of its own, so each of its items holds it beside its own, paint-order.ts)
  if (mark.zindex) {
    if (mark.type === 'group') out.markZindex = mark.zindex
    else out.zindex = mark.zindex
  }
  return out
}

function buildGroupMark(mark: CompiledMark, ctx: EvalContext): SceneGroup[] | null {
  const sources = groupSources(mark, ctx)
  if (sources === null) return null
  // one group item (and one scope) per datum / facet partition: bounded like any generated item (maxItems, the clock)
  checkItemCount(sources.length, 'group items')
  // A group mark's own operators are its enclosing scope's: every item is encoded, then the mark's transforms and its sort run on
  // the items, and only then is what each item holds made (an instance of its own, ranked after them).
  const entered = sources.map((src) => { meterTick('group item'); return enterGroupItem(mark, ctx, src) })
  let transformed = true
  if (mark.transform?.length && entered.length && !ctx.encodeAborted) {
    try {
      transformed = transformMarkItems(mark, entered.map((g) => g.item), ctx)
    } catch (e) {
      failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, e)
      ctx.encodeAborted = true
    }
  }
  // (the PreFacet that makes the items' content threw, or the mark's `layout` parameter -- an expression operator of the mark, made
  // with it in its enclosing scope -- threw: logged, the pass stops after the items, which hold nothing, C121, C398)
  const failure = sources[0]?.failure ?? (mark.layout != null && !ctx.encodeAborted ? paramsFailure(ctx, [mark.layout]) : undefined)
  let hollow = false
  if (failure !== undefined && !ctx.encodeAborted) {
    failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, failure.error)
    ctx.encodeAborted = true
    hollow = true
  }
  // (an encode or a transform that threw stopped the pass before the sort)
  const sorts = mark.sort !== undefined && !ctx.encodeAborted && transformed && sortRuns(mark, ctx)
  const settled: GroupOutcome[] = sources.map(() => ({ unsettled: false }))
  const groups = entered.map((g, i) => buildGroupItem(mark, ctx, hollow ? { ...g, src: { ...g.src, hollow: true } } : g, settled[i]!))
  const failing = layoutFailed(ctx, entered, settled)
  markLayoutWarnings(mark, ctx, settled)
  // The layout of a group mark is one operator for all its items, ranked after every instance below any of them: one item
  // with an instance the pass did not get to leaves all of them unlaid. The items made before that was known are made again.
  // (a layout that threw laid the items before the failing one out: they stay as they are)
  if (ctx.abort.cut !== undefined && !failing && groups.length > 1 && settled.some((o) => o.unsettled) && !settled.every((o) => o.unsettled)) {
    entered.forEach((g, i) => {
      if (!settled[i]!.unsettled) groups[i] = buildGroupItem(mark, ctx, g, settled[i]!, true)
    })
  }
  // a group mark with no items is still a container in the scenegraph (vega-scenegraph draws every mark's `<g>`)
  if (!groups.length) return [{ marktype: 'group', role: (mark.role as string | undefined) ?? 'scope', name: mark.name, items: [], emptyMark: true, markIndex: markIdOf(mark), ...markContainerInfo(mark), ...(markClip(mark, ctx) ? { markClip: true } : {}) } as unknown as SceneGroup]
  // SortItems: the group items are ordered by their own properties (`datum["g"]`, `x`, ...)
  if (sorts && groups.length > 1) {
    try {
      const sorted = sortMarkItems(groups as SceneItem[], mark.sort!) as SceneGroup[]
      GROUP_ROW_ITEMS.set(sorted, groups)
      return sorted
    } catch (e) {
      // the SortItems operator threw: the items stay in data order, and the pass stops there
      failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, afterEncode: true }, e)
      ctx.encodeAborted = true
    }
  }
  return groups
}

/** A group item as its mark's own operators leave it: where its instance sits, and its encoded properties (with its `datum`). */
interface EnteredGroup {
  src: GroupSource
  /** the instance of the item's scope (see `GuideScope.path`) */
  path: number[]
  /** the encoded item: what the mark's transforms read and write */
  item: SceneItem & { datum?: Row }
}

/**
 * Encode one group item, in the scope its mark is in: the item's own signals, data sets and projections are its content's, which
 * the encode cannot read. Its instance takes the next place among the instances of the enclosing scope.
 */
function enterGroupItem(mark: CompiledMark, ctx: EvalContext, given: GroupSource): EnteredGroup {
  const path = [...ctx.scope.path, ctx.scope.nextChild.n++]
  // (the item's datum is a copy of the row it is made from, as a leaf item's is: a scene hands out no row of the spec or of the
  // data, so a host that writes into a scene it was given writes into that scene alone, C87; nested objects stay shared, as a
  // leaf's do)
  const datum = copyTuple(given.datum)
  if (isTuple(given.datum)) markTupleAlways(datum)
  const src = { ...given, datum }
  // (`parent` is the enclosing group's datum here, as for any mark of the scope; a failing encode stops the run: see failEncode)
  const item = resolveEncodeSet((mark.encode?.update ?? {}) as Record<string, EncodeValue | EncodeValue[]>, src.datum, ctx, 'group', mark)
  return { src, path, item: Object.assign(item, { datum: src.datum }) }
}

/** The tuple a mark transform was given for an item: a transform that copies its tuples copies this too (see `transformMarkItems`). */
const ITEM_OF = Symbol('item')

/**
 * A mark's transforms, run on its encoded items as vega runs them: a transform reads the items (`datum.x`, `datum.datum.k`) in the
 * order the one before it left them, and what it computes is written onto them, which are drawn by it (a group's items are also read
 * by what the group holds: its `{group: "width"}`). A transform that works on copies of its tuples has its copies written back onto
 * the items they came from. `source` is the data the mark is from (where a hierarchy built over it is found).
 */
function transformMarkItems(mark: CompiledMark, items: readonly SceneItem[], ctx: EvalContext, source?: string): boolean {
  // (a mark whose encode never ran -- it reads a late signal that threw -- has no transform run either; nor has a transform that reads
  // one, nor any after it: they come after it in vega's dataflow)
  if (ctx.bareEncode === true) return false
  const own = items as unknown as Array<Row & { [ITEM_OF]?: Row }>
  // (an `identifier` numbers the items from the view's counter, after the datasets; an item keeps the number it had in the previous
  // evaluation -- it is the item of the same datum -- and a new one takes the next)
  const numbers = mark.transform?.some((t) => t.type === 'identifier') ? numberedKey(mark, ctx) : undefined
  const before = numbers !== undefined ? ctx.prev?.numbered.get(numbers) : undefined
  for (const it of own) it[ITEM_OF] = it
  const tctx: TransformContext = {
    runtime: ctx.runtime, signals: engineParams(ctx.signalParams), hierarchies: ctx.hierarchies, projections: ctx.projections, ids: ctx.ids,
    // (`lookup` `from` is a dataset, or the name of a mark: its items; `label` avoids the marks it names)
    datasets: (n) => ctx.datasets.get(n) ?? (ctx.markItems.get(n) as unknown as Row[] | undefined),
    marks: (n) => ctx.markContainers.get(n),
    // (vega's tuples: a force layout moves the items themselves)
    inPlace: true,
  }
  try {
    let rows: Row[] = own
    for (const [k, t] of (mark.transform ?? []).entries()) {
      if (readsTaint(t, ctx)) return false
      const input = rows
      // (a transform that draws random numbers - the layout of a word cloud - draws them once for the inputs it is given, as vega's
      // operator does, not again for every evaluation of the scene: see random-tape.ts)
      const run = (): Row[] => applyTransforms(input, [t], tctx, source, true)
      const out = t.type === 'identifier'
        ? withCarry(tctx, carriedNumbers(input, before, idField(t)), run)
        : atRandomSite(mayDrawRandom(t) ? ctx.runtime.random : undefined, ctx.chart, `mark:${ctx.scopeId ?? ''}/${markIdOf(mark)}#${k}`, () => randomFingerprint(t, input.map(publicProps), ctx.signalParams), run)
      rows = out.map((r) => {
        const it = (r as { [ITEM_OF]?: Row })[ITEM_OF]
        if (it === undefined || it === r) return r
        Object.assign(it, r)
        return it
      })
    }
  } finally {
    // (cleared, not deleted: deleting a property that was not the last one added leaves the item a slow dictionary-mode object)
    for (const it of own) it[ITEM_OF] = undefined
    if (numbers !== undefined) ctx.draft.numbered.set(numbers, items)
  }
  return true
}

/** The key of a mark's instance among the evaluation's numbered marks: the mark, and the instance of the scope it is in. */
function numberedKey(mark: CompiledMark, ctx: EvalContext): string {
  return `${markIdOf(mark)}@${ctx.scope.path.join('.')}`
}

/** A key no datum has: the number an item held, beside its datum (see `carriedNumbers`). */
const HELD = '\u0000held'

/**
 * The numbers the items of a mark had in the previous evaluation, for the items it has now (`carry[i]` for `items[i]`): an item is the
 * item of its datum, so the datums are aligned as an identifier's rows are (identifier-ids.ts).
 */
function carriedNumbers(items: readonly Row[], before: readonly SceneItem[] | undefined, as: string): unknown[] | undefined {
  if (before === undefined || !before.length) return undefined
  const datumOf = (it: unknown): Row => ((it as { datum?: Row }).datum ?? {})
  const previous = before.map((it) => ({ ...datumOf(it), [HELD]: (it as unknown as Row)[as] }))
  return carryByAlignment(items.map(datumOf), previous, HELD)
}

/** Whether a mark's sort runs: not when its encode never ran, nor when it reads a late signal that threw itself. */
function sortRuns(mark: CompiledMark, ctx: EvalContext): boolean {
  return ctx.bareEncode !== true && !readsTaint(mark.sort, ctx)
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
  // (vega-scenegraph group.js blends the group item's background, not its content or its foreground)
  if (rec.blend != null) own.blend = rec.blend
  const background = { path, x: 0, y: 0, _bg: true, ...own } as unknown as SceneItem
  if (!fore || !rec.stroke) return { background, path, paint, corners }
  // A box stroked in front: vega's SVG document writes the background as the box of an unstroked item (no half-pixel inset), while
  // its canvas fills it where the stroked box is. The SVG renderers write `path`; the canvas draws (and its pick reads) `_canvasPath`.
  if (rec.strokeOffset == null && off !== 0) {
    const bg = background as unknown as Record<string, unknown>
    bg.path = String(rectItemPath({ ...shape, x: 0, y: 0 } as SceneItem))
    bg._canvasPath = path
  }
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
    v !== null && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string' ? evalSignal(ctx.runtime.expr((v as { signal: string }).signal), ctx.signalParams) : v
  let shape: string | undefined
  let truthy = true
  if (o.signal) {
    const v = evalSignal(ctx.runtime.expr(String(o.signal)), ctx.signalParams)
    // (a shape is drawn into the clip: given no context it is its path string)
    if (typeof v === 'function') shape = String((v as (context: null) => unknown)(null) ?? '')
    else truthy = !!v
  } else if (o.path) {
    // (an empty path is no shape: the clip is the frame)
    shape = String(param(o.path)) || undefined
    if (shape === undefined) return { clip: true }
  } else if (o.sphere) {
    // (a sphere through a projection that is not there, or that draws nothing, is a shape that draws nothing: it clips everything away)
    const projection = ctx.runtime.projection?.(String(param(o.sphere)))
    shape = projection && geoRegistry.projectedShape ? geoRegistry.projectedShape(projection, { type: 'Sphere' }).path ?? '' : ''
  } else return { clip: !!c }
  return shape !== undefined ? { clip: true, clipPathD: shape } : { clip: truthy }
}

/** A mark's clip when it is an SVG path (`{path}`, or a `{signal}` that holds a path shape): what vega's bounds draw it with. */
function markClipPath(mark: CompiledMark, ctx: EvalContext): string | undefined {
  const c = (mark as { clip?: unknown }).clip
  if (c === null || typeof c !== 'object' || (c as { sphere?: unknown }).sphere) return undefined
  return markClipOf(mark, ctx).clipPathD
}

/**
 * Whether a shape mark's items take their `shape` from a literal of the encode: a literal is never a shape (vega's are functions, a
 * geoshape transform's or a data field's), so vega's bounds cannot draw it. (What a field or a transform gives, the engine holds as
 * path text of its own: it is not judged here.)
 */
function shapeIsLiteral(mark: CompiledMark): boolean {
  if (mark.transform?.some((t) => (t as { type?: unknown }).type === 'geoshape')) return false
  const channel = (mark.encode?.update?.shape ?? mark.encode?.enter?.shape) as { value?: unknown } | undefined
  return channel !== undefined && channel !== null && typeof channel === 'object' && 'value' in channel
}

/**
 * What a group mark's items carry of the MARK's `clip` (see {@link markClipOf}): the flag, and the clip's shape when it is one (a
 * `{sphere}`, a `{path}`, a `{signal}` shape) rather than the enclosing group's frame.
 */
function markClipFlags(mark: CompiledMark, ctx: EvalContext): { markClip?: true; markClipPathD?: string } {
  const c = markClipOf(mark, ctx)
  return c.clip ? { markClip: true, ...(c.clipPathD !== undefined ? { markClipPathD: c.clipPathD } : {}) } : {}
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
function scopeSignalValues(mark: CompiledMark, ctx: EvalContext, id: string, base: Record<string, unknown>, instance: number[]): { params: Record<string, unknown>; values: Record<string, unknown> } {
  const params = dict<unknown>(base)
  const values: Record<string, unknown> = {}
  const defs = (mark.signalDefs ?? []).filter((d) => d.push !== 'outer')
  // (a signal that throws stops the pass at the first operators of the instance: see AbortPoint)
  const evalIn = (code: string): unknown => {
    try { return evalSignal(ctx.runtime.expr(code), params) } catch (e) { failPass(ctx, { axis: -2, signals: true, path: instance }, e); return undefined }
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

/** What making a group item tells its mark: whether it was laid out, the last instance below it with content, and a layout that threw. */
interface GroupOutcome {
  unsettled: boolean
  last?: number[]
  layoutError?: { error: unknown }
  /** what the item's grid layout warned, and (in a view that fits its viewport) what the layout was given: see `markLayoutWarnings` */
  warnings?: string[]
  input?: string
}

/** Whether instance `a` is `b` or below it. */
const within = (a: readonly number[], b: readonly number[]): boolean => a.length >= b.length && b.every((v, i) => a[i] === v)

/** A group item's x or y as vega's item holds it: the encoded value when there is one that is not a finite number, else `laid`. */
const rawPosition = (encoded: unknown, laid: number): number => (encoded == null || (typeof encoded === 'number' && Number.isFinite(encoded)) ? laid : encoded as number)
/** A group item's width or height as vega's item holds it: the encoded value (none, if none was encoded), `laid` when it is a number of at least 0. */
const rawSize = (encoded: unknown, laid: number): number => (typeof encoded === 'number' && Number.isFinite(encoded) && encoded >= 0 ? laid : encoded as number)

function buildGroupItem(mark: CompiledMark, ctx: EvalContext, entered: EnteredGroup, outcome?: GroupOutcome, unsettled = false): SceneGroup {
  const { src, path, item: geo } = entered
  // (an item made again reports afresh)
  if (outcome !== undefined) outcome.warnings = outcome.input = outcome.layoutError = undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  // the facet partition is a dataset for everything in this item's scope, its own scales included
  const savedFacet = src.facetName !== undefined ? ctx.datasets.get(src.facetName) : undefined
  // a cell of the full cross-product with no rows of its own (`cross` on a facet aggregate): vega's facet subflow never starts for
  // it, so the item is the empty group - none of its marks, axes, legends or title exist
  const hollow = src.hollow === true || (src.facetName !== undefined && (src.rows?.length ?? 0) === 0)
  if (src.facetName !== undefined) { publishRows(src.rows!); ctx.datasets.set(src.facetName, src.rows!) }
  // the group's own datasets (vega: a group's `data`), derived in this item's scope
  const savedData: Array<[string, Row[] | undefined]> = []
  // the scales this item declares are visible to the expressions of its content (`bandwidth('child_x')`), over the enclosing ones
  let restoreScaleFns: (() => void) | undefined
  let restoreProjectionFns: (() => void) | undefined
  try {
    // this item's signal scope (its own signals, over the enclosing ones). `parent` is this group item's datum, whatever made it: a
    // facet's partition key, a row of `from.data`, or the `{}` of a group mark without `from` (in vega, a plain group nested in a
    // facet cell gives what it holds its own `{}`, not the cell's datum)
    const outerParams = { ...ctx.signalParams, parent: src.parent ?? src.datum }
    const scopeId = mark.signalDefs?.length ? `${ctx.scopeId ? ctx.scopeId + '/' : ''}${mark.userName ?? ''}@${markIdOf(mark)}${src.key !== undefined && src.key !== '' ? `[${src.key}]` : ''}` : undefined
    // vega builds the instances of nested scopes level by level: what an aborted pass did not reach is not made
    const scoped = scopeId !== undefined ? scopeSignalValues(mark, ctx, scopeId, outerParams, path) : undefined
    const scopeParams = scoped ? scoped.params : outerParams
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
      // (a dataset made from others holds copies of their rows: the pipeline starts from the rows themselves while it only reads them)
      const shared = sources.length > 0
      // (the rows of the sources, made when a pipeline has to run: a pipeline that is kept does not need them)
      const gather = (): Row[] => sources.flatMap((n) => ctx.datasets.get(n) ?? [])
      // (a group's url dataset nobody loaded fails as a top-level one does; host `data` does not reach a group's datasets)
      if (!shared && d.values == null && d.url != null) throw unloadedUrlError(d.name, false)
      let rows: Row[] | undefined
      try {
        rows = shared ? undefined : d.values != null ? readData(inlineValues(ctx, d.values), d.format, valuesSignal(d.values) !== undefined, { dataset: d.name, source: 'values' }, dataLocale(ctx.chart)) : []
      } catch (e) {
        // (vega inserts a group's inline rows into its dataset inside the run: a row that is not a tuple is logged there, not thrown)
        if (!isNotATupleError(e)) throw e
        failPass(ctx, { axis: -0.75, data: true, path }, e)
        break
      }
      if (rows !== undefined) notePrimitiveTuples(ctx, rows)
      checkRowCount(rows?.length ?? sources.reduce((n, s) => n + (ctx.datasets.get(s)?.length ?? 0), 0), `dataset "${d.name}"`)
      // (the group's datasets see its own projections, made before them, over the enclosing ones: vega's parse order)
      const tctx = { runtime: ctx.runtime, signals: scopeParams, hierarchies: ctx.hierarchies, projections: own?.registry ?? ctx.projections }
      if (d.transform?.length) rows = runScopedData(ctx, `${markIdOf(mark)}/${path.join('.')}/${d.name}`, d.name, d.transform, sources, rows ?? gather, shared, tctx, scopeParams)
      else if (shared) rows = copiedRows(gather(), 'dataset rows', true)
      else rows = rows ?? []
      savedData.push([d.name, ctx.datasets.get(d.name)])
      // (a dataset's rows as the engine publishes them: keyed past the fingerprint's budget by their stamp, see fingerprint.ts)
      publishRows(rows)
      ctx.datasets.set(d.name, rows)
    }
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
      try {
        childScales.set(sdef.name, buildScale(sdef, scaleContext({ ...ctx, signalParams: scopeParams, width: viewW, height: viewH }, sdef.name)))
      } catch (e) {
        // (the Scale operator throws: this scale and every operator after it, in this instance and past it, are never made)
        failPass(ctx, { axis: -0.5, scales: true, path }, e)
        break
      }
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
    // (the layout of a group is ranked after the last instance below it that has marks of its own -- an instance with none
    // connects nothing to it)
    const hasContent = (mark.marks?.length ?? 0) + (mark.axes?.length ?? 0) + (mark.legends?.length ?? 0) > 0 || mark.groupTitle !== undefined
    // (a layout that threw is ranked after every instance below the items of its mark: those were made and laid out, and of the
    // items themselves the ones before the failing one; see LayoutFailure)
    const failing = ctx.abort.cut?.layout
    const belowFailing = failing !== undefined && failing.items.some((it) => within(path, it))
    const itemAt = failing === undefined ? -1 : failing.items.findIndex((it) => it.length === path.length && within(path, it))
    const late = order >= 0 && hasContent && !belowFailing
    if (late) for (let up: GuideScope | undefined = ctx.scope; up && !up.unsettled; up = up.parent) up.unsettled = true
    const scope: GuideScope = {
      parent: ctx.scope, path, nextChild: { n: 0 }, unsettled: late || unsettled || (itemAt >= 0 && itemAt > failing!.at) || holdsFailedLayout(path, failing),
      scales: mark.scales ?? NO_DECLARED, data: mark.data ?? NO_DECLARED, facet: src.facetName,
      keyPath: `${ctx.scope.keyPath ?? ''}/${markIdOf(mark)}[${src.key ?? ''}]`,
    }
    if (hasContent && !hollow) noteInstance(scope, path)
    const childCtx: EvalContext = {
      ...ctx,
      scope,
      viewWidth: viewW,
      viewHeight: viewH,
      width: gw,
      height: gh,
      groupX: gx,
      groupY: gy,
      // (the group item its marks read: what its encode wrote, as it is, and its datum; the one it is in above it)
      groupItem: { item: { ...geo, datum: src.datum }, up: ctx.groupItem ?? rootGroupItem(ctx) },
      scales: childScales.size ? new Map([...ctx.scales, ...childScales]) : ctx.scales,
      scaleTypes: childTypes.size ? new Map([...ctx.scaleTypes, ...childTypes]) : ctx.scaleTypes,
      ...(own?.registry ? { projections: own.registry } : {}),
      signalParams: scopeParams,
      ...(scopeId !== undefined ? { scopeId } : {}),
    }

    const content: SceneGroup[] = []
    const children = hollow || order > 0 || (order === 0 && !whole && !madeMarks(ctx.abort.cut!)) ? [] : mark.marks ?? []
    // (what the marks of this item read of it besides their data and scales: its box, and for a mark that reads its group item or its
    // `parent` (see `readsGroupItem`), the item's datum, its `parent` and what its encode gave it)
    const { datum: _datum, ...encoded } = geo
    const box = { x: gx, y: gy, width: gw, height: gh }
    const itemContext = { ...box, datum: src.datum, parent: scopeParams.parent, encoded }
    for (let at = 0; at < children.length; at++) {
      const child = children[at]!
      scope.mark = at
      const r = evaluateInstanceMark(child, childCtx, `${scope.keyPath}#${markIdOf(child)}`, readsGroupItem(child) ? itemContext : box)
      if (r) pushAll(content, Array.isArray(r) ? r : [r])
    }
    // (the entries of a symbol legend are instances of their own, after this scope's groups: one the pass never got to
    // keeps the group from being laid out like any other instance it did not get to)
    if (ctx.abort.cut !== undefined && !scope.unsettled && symbolLegendsOf(mark.legends, childCtx).some((_, k) => compareInstances([...path, scope.nextChild.n + k, 0], ctx.abort.cut!.path) >= 0)) {
      for (let up: GuideScope | undefined = scope; up && !up.unsettled; up = up.parent) up.unsettled = true
    }
    // ViewLayout: a `layout` grid positions the child groups (headers, footers, titles, cells) first
    // (a grid the layout cannot take throws as vega's does, with what it placed before that left placed: the item's guides and
    // title are then not laid out, and the mark reports it -- see `layoutFailed`)
    let laidOut = !scope.unsettled
    if (mark.layout && laidOut) {
      try {
        const options = resolveLayoutOptions(mark.layout, childCtx)
        if (outcome !== undefined && ctx.passMemory !== undefined) outcome.input = layoutInput([gx, gy, gw, gh], content, options)
        const warnings: string[] = []
        if (outcome !== undefined) outcome.warnings = warnings
        layoutFacet({ marktype: 'group', items: content } as unknown as SceneGroup, options, gridMemory(childCtx, childCtx.scope.path.join('/')), (message) => { warnings.push(message) })
      } catch (e) {
        refuseUnrecoverable(e)
        laidOut = false
        ctx.layoutState.failed = true
        if (outcome !== undefined) outcome.layoutError = { error: e }
      }
    }

    const guideCtx: EvalContext = laidOut ? childCtx : { ...childCtx, rawGuides: true, ...(scope.unsettled ? {} : { layoutThrew: true as const }) }
    const { groups: guides } = hollow || order > 0
      ? { groups: [] }
      : order === 0 && !whole
        ? buildAxisAndLegend(guideCtx, content, (mark.axes ?? []).slice(0, madeAxes(ctx.abort.cut!)), (mark.legends ?? []).slice(0, madeLegends(ctx.abort.cut!)), true)
        : buildAxisAndLegend(guideCtx, content, mark.axes ?? [], mark.legends ?? [], true)
    const siblings: SceneGroup[] = [...content, ...guides]
    const title = hollow || order > 0 || (order === 0 && !whole && !ctx.abort.cut!.title && !ctx.abort.cut!.labels && !ctx.abort.cut!.lateSignal) ? null : buildTitleGroup(mark.groupTitle, siblings, gw, gh, !laidOut, guideCtx, src.datum, false, true)
    if (title) siblings.push(title)
    const ordered = paintOrderOf(siblings)

    // the item's `clip` (encode) clips its content to its own box; the mark's `clip` clips the whole mark to the enclosing group
    // (its box and its clip are vega's: drawn from the width and height as the item holds them, `+(width || 0)`)
    const rawW = rawSize(geo.width, gw)
    const rawH = rawSize(geo.height, gh)
    const { items: groupContent, paint } = groupItems(geo, rawW, rawH, ordered)
    // (a hyperlinked group's `href` went through the policy as the item was encoded: `resolveEncodeSet`)
    const href = (geo as Record<string, unknown>).href
    const role = (mark.role as string | undefined) ?? 'scope'
    // the item's own aria channels (vega-scenegraph ariaItemAttributes, on the item's `<g>`)
    const itemAria = itemAriaOf(geo as Record<string, unknown>)

    const group = {
      // (the item's position and size are the values its encode wrote, as vega keeps them: a NaN, an infinity, a negative size or a
      // string is read by each consumer as vega's reads it, `x || 0`, `width || 0` -- `gx`, `gw` are where its content is laid out)
      marktype: 'group', name: mark.name, role, x: rawPosition(geo.x, gx), y: rawPosition(geo.y, gy), width: rawW, height: rawH,
      items: groupContent,
      ...paint,
      datum: src.datum,
      _scope: true,
      markIndex: markIdOf(mark),
      ...(itemKeyFields(mark, ctx) !== undefined ? { __keyFields: itemKeyFields(mark, ctx) } : {}),
      ...markContainerInfo(mark),
      ...(itemAria !== undefined ? { itemAria } : {}),
      ...(cursorOf(geo) !== undefined ? { cursor: cursorOf(geo) } : {}),
      // (the item's own zindex: where it is painted among the items of its mark, paint-order.ts)
      ...((geo as Record<string, unknown>).zindex !== undefined ? { zindex: (geo as Record<string, unknown>).zindex as number } : {}),
      // (what vega's tooltip handler shows for the group item where no mark inside it is hit)
      ...((geo as Record<string, unknown>).tooltip !== undefined ? { tooltip: (geo as Record<string, unknown>).tooltip } : {}),
      // (vega leaves the box of a group item that says `noBound` out of its bounds: the view's autosize, and its pick, see only
      // what it holds)
      ...((geo as Record<string, unknown>).noBound ? { noBound: true } : {}),
      ...(href != null ? { href: href as string } : {}),
      ...markClipFlags(mark, ctx),
    } as unknown as SceneGroup
    // (an instance the aborted pass never reached has no operators, so no scales)
    if (mark.scales?.length && (order < 0 || (order === 0 && !ctx.abort.cut!.signals))) group.__scales = snapshotScales(childScales)
    if (scoped && scopeId !== undefined) {
      group.scopeSignals = { id: scopeId, defs: mark.signalDefs!, values: scoped.values, hasContent: (mark.marks?.length ?? 0) + (mark.axes?.length ?? 0) + (mark.legends?.length ?? 0) > 0 || mark.groupTitle !== undefined }
      // the scales this scope declares, for the handlers of its signals (`scale('x', ...)` resolves through the scope chain)
      if (childScales.size) Object.defineProperty(group, '__scaleFns', { value: childScales, enumerable: false })
    }
    if (outcome !== undefined) {
      outcome.unsettled = scope.unsettled === true
      outcome.last = scope.last
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
      // (a signal that throws fails the layout's operator before it lays anything out: the caller reports it as the layout's
      // failure, as vega's dataflow logs it there, C398)
      if (typeof o.signal === 'string') return evalSignal(ctx.runtime.expr(o.signal), ctx.signalParams)
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]))
    }
    return v
  }
  return resolve(layout) as Record<string, unknown>
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
  /** Whether a channel holds a URL the policy vets as the item is encoded (`URL_CHANNELS`, `vetItemUrls`). */
  urls: boolean
  /** The per-set spatial adjustment of the encode, when its sets split a dimension's edges (spatial.ts); looked up once. */
  spatial: SpatialProgram | undefined
  /** Whether an expression of the encode names `item` (see resolveEncodeSet). */
  readsItem: boolean
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
  plan = { plainKeys, signalKeys, definedSpec, plainSpecs, plainKinds, urls: Object.keys(encode).some((k) => URL_CHANNELS.has(k)), spatial: spatialProgramFor(encode), readsItem: Object.values(encode).some((e) => entryReadsItem(e)) }
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
  const into = ctx.markGradients?.defs ?? ctx._defs
  if (!into.some((d) => d.id === def.id)) into.push(def)
}

/**
 * A guide (an axis, a legend, a title) whose items paint with a gradient object -- written in a part's encode, held by a signal, set
 * in the config -- brings the gradient's definition to the scene's defs, as a data mark's item does (`registerGradient`): the
 * renderers write the paint as a reference to it. A guide's items are made by the guide encoder (guide-encode.ts), so they are read
 * here once the guide is made, every item of every part, the guide's own group item included. Through `addDefs`: counted as asked
 * for, so a guide that paints with one is made again by every evaluation rather than kept (`recordGuide`), and logged, so a group
 * mark kept whole brings them back (`keptGroupMark`).
 */
function withGuideGradients(ctx: EvalContext, group: SceneGroup | null): SceneGroup | null {
  if (group === null) return group
  const defs: SceneDef[] = []
  const paints = (it: Record<string, unknown>): void => {
    for (const paint of [it['fill'], it['stroke']]) {
      if (!isGradientPaint(paint)) continue
      const def = gradientDefOf(paint)
      if (!defs.some((d) => d.id === def.id)) defs.push(def)
    }
  }
  // (a group item of a guide is drawn as its box: the background and foreground leaves, `SceneGroup.box` / `boxFg`)
  const visit = (node: { items?: unknown; box?: unknown; boxFg?: unknown }): void => {
    for (const leaf of [node.box, node.boxFg]) if (leaf != null && typeof leaf === 'object') paints(leaf as Record<string, unknown>)
    if (!Array.isArray(node.items)) return
    for (const it of node.items as Array<Record<string, unknown>>) {
      paints(it)
      visit(it)
    }
  }
  visit(group as unknown as { items?: unknown })
  if (defs.length > 0) addDefs(ctx, defs)
  return group
}

/** The scene's defs take `defs` in order, each once. */
function addDefs(ctx: EvalContext, defs: readonly SceneDef[]): void {
  ctx.defsAsked.n += defs.length
  if (ctx.defsLog !== undefined && defs.length) ctx.defsLog.push(defs.slice())
  for (const def of defs) if (!ctx._defs.some((d) => d.id === def.id)) ctx._defs.push(def)
}

/** The definitions of the gradient paints (fill, then stroke, item by item) on `items`: what encoding all of them registers. */
function gradientsOf(items: readonly SceneItem[]): SceneDef[] {
  const defs: SceneDef[] = []
  for (const it of items) {
    const rec = it as unknown as Record<string, unknown>
    for (const paint of [rec['fill'], rec['stroke']]) {
      if (!isGradientPaint(paint)) continue
      const def = gradientDefOf(paint)
      if (!defs.some((d) => d.id === def.id)) defs.push(def)
    }
  }
  return defs
}

/** A mark's encode threw: the pass stops there, and the items after the failing one are left unencoded. */
function failEncode(ctx: EvalContext, encode: Record<string, EncodeValue | EncodeValue[]>, e: unknown): void {
  ctx.encodeAborted = true
  failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, ...(encodeReadsLateScale(encode, ctx.scope, ctx.chart) ? { lateScale: true as const } : {}) }, e)
}

/**
 * Whether the scale of this name that the scope declares is ranked late (see scaleIsLate). A scale of an enclosing scope is not: its
 * operators ran before the instances of the nested scope were made, whatever their rank was among their own.
 */
function scaleNamedIsLate(scope: GuideScope, name: string, chart: CompiledChart): boolean {
  const own = scopeScale(scope, name)
  return own !== undefined && scaleIsLate(own, scope, chart)
}

/** Whether an encode reads a scale that is ranked late: by a `scale` entry, or by a call of `scale()` and its kin in an expression. */
function encodeReadsLateScale(encode: Record<string, EncodeValue | EncodeValue[]>, scope: GuideScope, chart: CompiledChart): boolean {
  const reads = newReads()
  specReads(encode, reads)
  for (const name of reads.scales) if (scaleNamedIsLate(scope, name, chart)) return true
  return false
}

/** Run `fn` with `item` as the scenegraph item the encode's expressions see (`ctx.encodeItem`, C31). */
function withEncodeItem<T>(ctx: EvalContext, item: object | undefined, fn: () => T): T {
  if (item === undefined) return fn()
  const outer = ctx.encodeItem
  ctx.encodeItem = item
  try { return fn() } finally { ctx.encodeItem = outer }
}

/**
 * An encode whose expressions name `item` sees the item it is building, as vega's encoder hands its expressions the scenegraph
 * item: the channels set so far (read live: `item.x` after `enter.x`), its `datum`, and its `mark` (type, name, role and the group
 * it is in: `item.mark.group.width`). Built only for an encode that names it.
 */
function resolveEncodeSet(encode: Record<string, EncodeValue | EncodeValue[]>, datum: Row, ctx: EvalContext, marktype: string, mark?: { name?: string; role?: string }): SceneItem {
  const plan = encodePlan(encode)
  if (!plan.readsItem) return resolveEncodeSetOf(encode, plan, datum, ctx, marktype)
  let item: SceneItem | undefined
  const facade = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'datum') return datum
      if (k === 'mark') {
        const group = { x: ctx.groupX ?? 0, y: ctx.groupY ?? 0, width: ctx.width, height: ctx.height, datum: ctx.signalParams.parent, mark: { marktype: 'group' } }
        return { marktype, name: mark?.name, role: mark?.role ?? (marktype === 'group' ? 'scope' : 'mark'), group }
      }
      return item === undefined ? undefined : (item as Record<string | symbol, unknown>)[k]
    },
  })
  return withEncodeItem(ctx, facade, () => resolveEncodeSetOf(encode, plan, datum, ctx, marktype, (it) => { item = it }))
}

function resolveEncodeSetOf(encode: Record<string, EncodeValue | EncodeValue[]>, plan: EncodePlan, datum: Row, ctx: EvalContext, marktype: string, building?: (item: SceneItem) => void): SceneItem {
  // (an item an aborted run never reached stays in its mark, bare: vega's scenegraph holds it without geometry or paint)
  if (ctx.encodeAborted || ctx.bareEncode === true) return {}
  const binding = ctx.encodeBinding

  // The encoded channel values (pixels, colours, ...) live on the scene ITEM and
  // are never written back onto the datum: `datum` is the caller's data row, and
  // tooltips, signals and interactions read data values from it. A data
  // field named like a channel (`x`, `size`, `fill`) therefore keeps its value.
  // `defined` is evaluated against the data tuple, as Vega does.
  let definedValue: unknown
  if (plan.definedSpec !== undefined) {
    try {
      definedValue = resolveEncodeProperty(plan.definedSpec, datum, ctx, binding)
    } catch (e) {
      failEncode(ctx, encode, e)
      return {}
    }
  }

  // Pass 1: resolve all non-signal values straight into the item (no
  // intermediate per-row object — this is the hottest loop in the engine).
  const item: SceneItem = {}
  const rec = item as unknown as Record<string, unknown>
  building?.(item)
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
          if (bound) resolved = scaleValue(bound.scale, getField(datum, spec.field))
          else {
            const s = ctx.scales.get(spec.scale)
            // (no such scale: the general resolver fails it, with the one error of a missing scale)
            resolved = s ? scaleValue(s, getField(datum, spec.field)) : resolveEncodeProperty(plainSpecs[i], datum, ctx, binding)
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
    // vega evaluates the channels in spec order, so the failing item keeps exactly the channels
    // BEFORE the failing one (the two passes above group plain values ahead of signals), and the error
    // it logs is that channel's: the first to fail in spec order, which is not always the pass's.
    const partial: SceneItem = {}
    const prec = partial as unknown as Record<string, unknown>
    let first: unknown = e
    for (const key of Object.keys(encode)) {
      try {
        const v = resolveEncodeProperty(encode[key], datum, ctx, binding)
        if (v !== undefined) prec[key] = v
      } catch (again) {
        first = again
        break
      }
    }
    failEncode(ctx, encode, first)
    // (the enter set's copies of the channels its update overrides are no channels: see spatial.ts)
    for (const key of Object.keys(prec)) if (key.startsWith(ENTER_COPY)) delete prec[key]
    return partial
  }
  // a gradient object as a paint (`{gradient: 'linear', stops: [...]}`): its definition joins the scene's defs
  const fillPaint = rec['fill']
  if (fillPaint !== null && typeof fillPaint === 'object') registerGradient(fillPaint, ctx)
  const strokePaint = rec['stroke']
  if (strokePaint !== null && typeof strokePaint === 'object') registerGradient(strokePaint, ctx)
  // vega-runtime's `adjustSpatial`, per encode set (spatial.ts): x2/xc/y2/yc become x/y/width/height
  adjustSpatial(rec, encode, marktype, plan.spatial)

  // The URL channels go through the policy as the item is made (outside the encode's own error handling: a refusal is the
  // policy's error, not an encode failure). An item then only ever holds what the policy made of them, so an item kept from an
  // evaluation before is never written to vet it again (it is that evaluation's: C2), and a channel evaluated again under
  // another policy differs from the one before by what the policy made of it (`reencodeChannels`, C478).
  if (plan.urls) vetItemUrls(item, marktype === 'image', ctx)
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
        if (ctx.runtime.expr(cond.test)(datum, ctx.signalParams, undefined, ctx.encodeItem)) {
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
  /** a scale's gradient (vega's `gradient(scale, start, stop, count)`): the scale named, by a signal, or by a field of the datum */
  gradient?: unknown
  start?: unknown
  stop?: unknown
  count?: unknown
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
}

/**
 * `{gradient: <scale>, start, stop, count}`: the gradient of the scale (see `scaleGradient`). The scale is named as it is written, by a
 * signal (the name the expression gives) or by a field of the datum; `start`, `stop` and `count` are values as written -- vega quotes
 * them into the expression -- so a signal object in them is an object, not what the signal holds.
 */
function gradientOfEntry(enc: EncodeEntry, datum: Row, ctx: EvalContext): unknown {
  const ref = enc.gradient
  const signal = ref !== null && typeof ref === 'object' ? (ref as { signal?: unknown }).signal : undefined
  const name = typeof ref === 'string' ? ref
    : signal ? ctx.runtime.expr(String(signal))(datum, ctx.signalParams, undefined, ctx.encodeItem)
      : encodeFieldValue(ref !== null && typeof ref === 'object' ? ref : { datum: ref }, datum, ctx)
  const scale = ctx.runtime.scale(name as string)
  // The gradient of a scale named in the spec is the same for every item of the evaluation: made once. (An item that is given
  // another scale -- a mark in a group that declares one by that name -- makes its own.)
  if (typeof ref !== 'string') return scaleGradient(scale as never, enc.start, enc.stop, enc.count)
  let made = EVALUATED_GRADIENTS.get(ctx.claimed)
  if (made === undefined) EVALUATED_GRADIENTS.set(ctx.claimed, (made = new Map()))
  const kept = made.get(enc)
  if (kept !== undefined && kept.scale === scale) return kept.gradient
  const gradient = scaleGradient(scale as never, enc.start, enc.stop, enc.count)
  made.set(enc, { scale, gradient })
  return gradient
}

/** The gradients the entries of an evaluation made (`ctx.claimed` is that evaluation's own set), by entry. */
const EVALUATED_GRADIENTS = new WeakMap<object, Map<EncodeEntry, { scale: unknown; gradient: unknown }>>()

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

/** A group item as the marks inside it read it (`item.mark.group`), and the group item it is in (`undefined` past the view's). */
interface GroupLink { item: Record<string, unknown>; up: GroupLink | undefined }

/** The view's group item, as a mark of the view reads it: at the origin, its size the `width` and `height` signals, no datum. */
function rootGroupItem(ctx: EvalContext): GroupLink {
  return { item: { x: 0, y: 0, width: ctx.viewWidth ?? ctx.width, height: ctx.viewHeight ?? ctx.height }, up: undefined }
}

/**
 * A `{group | parent}` field reference (vega-parser resolveField): `item.mark.group` `level` times (at least once), then the field
 * of that group item (`{group: "fill"}`, `{group: "datum.k"}`: any of its properties, as a path) or of its datum (`{parent}`).
 * Past the view's group item there is none: reading through it fails as vega's generated code does.
 */
function groupFieldValue(ref: { group?: unknown; parent?: unknown; level?: unknown }, datum: Row, ctx: EvalContext): unknown {
  let at: GroupLink | undefined = ctx.groupItem ?? rootGroupItem(ctx)
  const level = Math.max(1, +(ref.level as number) || 1)
  for (let up = 1; up < level; up++) {
    // (`item.mark.group.mark`: the view's group item's mark has no group, so the next `.mark` is read off undefined)
    if (at === undefined) throw new TypeError("Cannot read properties of undefined (reading 'mark')")
    at = at.up
  }
  const isParent = ref.parent !== undefined
  const f = fieldName(isParent ? ref.parent : ref.group, datum, ctx)
  // (one group past the view's: the field is read off undefined)
  if (at === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${isParent ? 'datum' : f.path ? splitAccessPath(String(f.name))[0] : String(f.name)}')`)
  // (the generated code reads each step of the path, `item.mark.group["datum"]["g"]`: a step off null or undefined fails)
  let value: unknown = isParent ? at.item.datum : at.item
  for (const step of f.path ? splitAccessPath(String(f.name)) : [String(f.name)]) {
    if (value == null) throw new TypeError(`Cannot read properties of ${value === null ? 'null' : 'undefined'} (reading '${step}')`)
    value = (value as Record<string, unknown>)[step]
  }
  return value
}

/** A field reference in any of vega's forms: a path, `{datum}`, `{signal}`, `{group}`, `{parent}`. */
function encodeFieldValue(ref: unknown, datum: Row, ctx: EvalContext): unknown {
  if (ref !== null && typeof ref === 'object' && !Array.isArray(ref)) {
    const r = ref as { signal?: unknown; group?: unknown; parent?: unknown; datum?: unknown }
    if (r.signal) return (datum as Record<string, unknown>)[ctx.runtime.expr(String(r.signal))(datum, ctx.signalParams, undefined, ctx.encodeItem) as string]
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
    ? ctx.runtime.expr(String((ref as { signal: string }).signal))(datum, ctx.signalParams, undefined, ctx.encodeItem)
    : encodeFieldValue(ref, datum, ctx)
  return { scale: ctx.scales.get(name as string), type: ctx.scaleTypes.get(name as string) }
}

/** `_scale(scale, value)`: the engine's tolerant coercions around the scale call. */
function scaleValue(s: Scale, raw: unknown): unknown {
  if (raw === undefined) {
    // A discrete domain can legitimately contain undefined (e.g. an aggregate
    // over a nominal field); vega still maps that domain entry through the scale
    // rather than dropping the channel.
    const dom = s.domain?.() as unknown[] | undefined
    if (!Array.isArray(dom) || !dom.includes(undefined)) return undefined
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
  // (a gradient entry is the whole entry: nothing else it says is read)
  if (enc.gradient != null) return gradientOfEntry(enc, datum, ctx)
  // (an entry whose meaning is the text vega writes for it -- a colour object, a property given as text -- is that text, evaluated)
  if (writtenEntry(enc)) return ctx.runtime.expr(writtenEntryText(enc))(datum, ctx.signalParams, undefined, ctx.encodeItem)
  let head: unknown
  let hasHead = true
  if (enc.signal) head = ctx.runtime.expr(enc.signal)(datum, ctx.signalParams, undefined, ctx.encodeItem)
  else if (enc.field != null) head = encodeFieldValue(enc.field, datum, ctx)
  // (a value is what it says, an object as written: vega quotes it into the entry's code, so a `{signal}` in it is an object, C397)
  else if (enc.value !== undefined) head = enc.value
  else hasHead = false

  // `tail` is a product term added to `head` (the band step `_bandwidth(scale)*band`)
  let tail: number | undefined
  if (enc.scale != null) {
    const { scale: s } = encodeScaleOf(enc, datum, ctx, binding)
    // (a scale that is not there fails where the entry calls it, and reads a bandwidth of 0: see missing-scale.ts)
    if (enc.range != null) {
      // lerp(_range(scale), +range)
      if (!s) throw scaleRangeFailure()
      head = lerp(s.range() as number[], +(enc.range as number))
      hasHead = true
    } else {
      if (hasHead) {
        if (!s) throw scaleCallFailure(enc.scale)
        head = scaleValue(s, head)
      }
      if (enc.band) {
        // + _bandwidth(scale) [* band]   (a band of exactly 1, or `true`, has no factor)
        const bw = s && typeof s.bandwidth === 'function' ? s.bandwidth() : 0
        const factor = enc.band === true ? 1 : +(entryProperty(enc.band, datum, ctx, binding) as number)
        const term = factor === 1 ? bw : bw * factor
        if (enc.extra) {
          // (datum.extra ? _scale(scale, datum.extra.value) : value)
          const extra = (datum as { extra?: { value?: unknown } }).extra
          if (extra && !s) throw scaleCallFailure(enc.scale)
          head = extra ? scaleValue(s!, extra.value) : hasHead ? (head as number) + term : term
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
    return head
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
  return result
}

/**
 * Whether an entry means what vega's code for it means and nothing this resolver reads directly: a colour object (`{color: {r, g,
 * b}}`, `{h, s, l}`, `{h, c, l}`, `{l, a, b}`: vega writes `rgb(...)+''` and the like, C27), or an `exponent`, `mult`, `offset` or
 * `band` that is neither a number nor an entry (vega pastes such a property into its code as text: `offset: '5'` adds 5, C397).
 * vega-parser encode/entry.js; the text is the one the compile-time check reads (`entryText`).
 */
function writtenEntry(enc: EncodeEntry): boolean {
  if ((enc as { color?: unknown }).color && !enc.signal) return true
  return writtenProperty(enc.exponent) || writtenProperty(enc.mult) || writtenProperty(enc.offset)
    || (enc.scale != null && enc.range == null && Boolean(enc.band) && +(enc.band as number) !== 1 && writtenProperty(enc.band))
}

/**
 * A property this resolver does not read as vega's code does: anything but a number, an entry object (`{signal}`, `{field}`, ...) or
 * nothing -- vega writes text as it is, a list as an entry, and an entry that gives no value as `null` (where this resolver has none).
 */
function writtenProperty(p: unknown): boolean {
  if (p == null || typeof p === 'number') return false
  if (typeof p !== 'object' || Array.isArray(p)) return true
  const e = p as EncodeEntry & { color?: unknown }
  return !(e.signal || e.field != null || e.value !== undefined || e.scale != null || e.gradient != null) || writtenEntry(e)
}

/** The code vega writes for an entry (cached by entry object: an encode's entries are the same objects for every item). */
function writtenEntryText(enc: EncodeEntry): string {
  let text = WRITTEN_ENTRIES.get(enc)
  if (text === undefined) {
    const t = entryText(enc)
    // (an entry vega's parser refuses was refused when the spec was compiled: the check reads this same text)
    if (t === null) throw new Error('Invalid encoding entry: ' + JSON.stringify(enc))
    WRITTEN_ENTRIES.set(enc, (text = t))
  }
  return text
}
const WRITTEN_ENTRIES = new WeakMap<object, string>()

/** The locale a chart's data is parsed with (`format.parse` date patterns): its own, when its config has one. */
const dataLocale = (chart: CompiledChart): Locale | undefined => (chart.locale ? chartLocale(chart.locale) : undefined)

/** A legend's explicit `values` (a literal array, a signal, or an array holding signals), or undefined. */
function resolveLegendValues(legend: CompiledLegend, ctx: EvalContext): unknown[] | undefined {
  const raw = (legend as { values?: unknown }).values
  if (raw == null) return undefined
  // (vega's `objectProperty`, as for an axis: signals at any depth; an expression that throws gives no value)
  const resolved = objectProperty(raw, (code) => {
    try { return evalSignal(ctx.runtime.expr(code), ctx.signalParams) } catch { return undefined }
  })
  return Array.isArray(resolved) ? resolved : undefined
}

/**
 * Whether the grid layout of a symbol legend's entries ran before the pass stopped at `cut`: its operator is ranked after the
 * instances that make the entries, so it did where none of them is at or after the cut.
 */
function entryGridRan(scopePath: readonly number[], slot: number, point: AbortPoint): boolean {
  const own = [...scopePath, slot]
  const cut = point.path
  // (a layout that threw is ranked after the instances its point names, and so after the grids of the entries they hold)
  if (point.layout !== undefined && within(cut, own)) return true
  if (cut.length > own.length && own.every((v, i) => cut[i] === v)) return false
  return compareInstances([...own, 0], cut) < 0
}

/** Whether a gradient legend of the list has labels ranked after the scope's other operators (see `lateLabels` in `buildLegend`). */
function hasLateLabels(legends: readonly CompiledLegend[] | undefined, ctx: EvalContext): boolean {
  for (const legend of legends ?? []) {
    const spec = (legend.own ?? NO_PROPS) as Record<string, unknown>
    const config = (legend.cfg ?? NO_PROPS) as Record<string, unknown>
    const channel = LEGEND_SCALES.find((c) => spec[c])
    if (channel === undefined) continue
    const name = String(spec[channel])
    if (ctx.scales.get(name) !== undefined && legendType(spec, ctx.scaleTypes.get(name) ?? '') === 'gradient' && !guideScalar(ctx, spec.tickCount ?? config.tickCount)) return true
  }
  return false
}

const AXIS_TICKS_PARAMS: ReadonlySet<string> = new Set(['tickCount', 'values', 'tickMinStep', 'tickExtra'])

/**
 * Whether a guide of the view reads a late signal that threw, in a property vega reads (guide-model.ts) or in the author's encode of a
 * part the guide has: the operator that reads it is ranked after the signal, and so is everything it feeds -- the guide's bounds and
 * the view's layout, which then never runs.
 */
function guidesReadLate(ctx: EvalContext): boolean {
  if (ctx.lateTaint === undefined) return false
  const scaleType = (name: unknown): string | undefined => ctx.scaleTypes.get(String(name))
  const reads = (v: unknown): boolean => {
    let hit = false
    walkStrings(v, (str, owner) => { if (!hit && owner !== null && (owner.signal === str || owner.test === str) && readsLateSignal(str, ctx)) hit = true })
    return hit
  }
  const guide = (kind: GuideKind, own: Record<string, unknown>, cfg: Record<string, unknown>, parts: (reading: (key: string) => string) => readonly string[]): boolean => {
    const reading = guideReading(kind, own, { config: { [kind]: cfg }, scaleType })
    for (const key of new Set([...Object.keys(own), ...Object.keys(cfg)])) {
      if (key === 'encode' || key === 'scale' || reading(key) === 'never' || (kind === 'axis' && AXIS_TICKS_PARAMS.has(key))) continue
      if (reads(own[key] ?? cfg[key])) return true
    }
    const encode = own.encode
    return encode !== null && typeof encode === 'object' && parts(reading).some((part) => reads((encode as Record<string, unknown>)[part]))
  }
  // (an axis's ticks read only by the ticks operator feed its tick, label and grid marks: an axis that has one of those is refused
  // (see buildAxis), and one that has none lays out without them)
  // (a part the guide does not have is not parsed: the property of its mark that every guide has tells)
  const axisParts = (reading: (key: string) => string): string[] => ['axis', ...(['grid', 'ticks', 'labels', 'domain', 'title'] as const).filter((p) => reading(p === 'ticks' ? 'tickColor' : p === 'labels' ? 'labelColor' : p + 'Color') !== 'never')]
  const legendParts = (reading: (key: string) => string): string[] => [
    'legend', 'labels', ...(reading('titleColor') !== 'never' ? ['title'] : []),
    ...(reading('clipHeight') !== 'never' ? ['entries', 'symbols'] : []), ...(reading('gradientLength') !== 'never' ? ['gradient'] : []),
  ]
  const NONE: Record<string, never> = {}
  const title = ctx.chart.title
  return ctx.chart.axes.some((a) => guide('axis', (a.own ?? NONE) as Record<string, unknown>, (a.cfg ?? NONE) as Record<string, unknown>, axisParts))
    || ctx.chart.legends.some((l) => guide('legend', (l.own ?? NONE) as Record<string, unknown>, (l.cfg ?? NONE) as Record<string, unknown>, legendParts))
    || (title !== undefined && guide('title', (title.own ?? NONE) as Record<string, unknown>, (title.cfg ?? NONE) as Record<string, unknown>, () => ['group', 'title', 'enter', 'update', ...(title.own?.subtitle ? ['subtitle'] : [])]))
}

/** The legends of a scope that are symbol legends (the ones whose entries are made in instances of their own). */
function symbolLegendsOf(legends: readonly CompiledLegend[] | undefined, ctx: EvalContext): CompiledLegend[] {
  const out: CompiledLegend[] = []
  for (const legend of legends ?? []) {
    const spec = (legend.own ?? NO_PROPS) as Record<string, unknown>
    const channel = LEGEND_SCALES.find((c) => spec[c])
    if (channel === undefined) continue
    const name = String(spec[channel])
    if (ctx.scales.get(name) !== undefined && legendType(spec, ctx.scaleTypes.get(name) ?? '') === 'symbol') out.push(legend)
  }
  return out
}

/**
 * The instance slot a symbol legend's entries take in its scope (after the scope's groups), noted as the scope's last instance so
 * far: its last entry's is the last a layout above it is ranked after. A kept legend takes it again (see `keptLegends`).
 */
function takeLegendSlot(ctx: EvalContext): number {
  const slot = ctx.scope.nextChild.n++
  noteInstance(ctx.scope, [...ctx.scope.path, slot, Infinity])
  return slot
}

function buildLegend(legend: CompiledLegend, ctx: EvalContext, index: number): SceneGroup | null {
  return withGuideGradients(ctx, makeLegend(legend, ctx, index))
}

function makeLegend(legend: CompiledLegend, ctx: EvalContext, index: number): SceneGroup | null {
  const spec = (legend.own ?? NO_PROPS) as Record<string, unknown>
  const config = (legend.cfg ?? NO_PROPS) as Record<string, unknown>
  // vega-parser legend.js: the channels the legend maps, in LegendScales order; the first is the canonical scale
  const channels: Array<[string, string]> = []
  for (const c of LEGEND_SCALES) if (spec[c]) channels.push([c, String(spec[c])])
  if (!channels.length) return null
  const scale = ctx.scales.get(channels[0]![1])
  if (!scale) return null
  const scaleType = ctx.scaleTypes.get(channels[0]![1]) ?? ''
  // (the signals vega's LegendEntries is given are operators of their own, ranked just before it: one that throws stops the pass at the
  // legend)
  const lambda = paramsFailure(ctx, [spec.tickCount ?? config.tickCount, spec.symbolLimit ?? config.symbolLimit, spec.values, spec.tickMinStep, spec.formatType, spec.format])
  if (lambda !== undefined) {
    failPass(ctx, { axis: Infinity, legend: index }, lambda.error)
    return null
  }
  // vega's `_('tickCount')`: a signal is what it holds
  // (vega reads a legend's tick count, the config's included, and its values through `objectProperty`: signals at any depth)
  const tickCountRaw = axisObjectParam(spec.tickCount ?? config.tickCount, ctx)
  const values = resolveLegendValues({ values: spec.values } as unknown as CompiledLegend, ctx)
  const minstep = guideScalar(ctx, spec.tickMinStep) as number | undefined
  const formatSpecifier = guideScalar(ctx, spec.format)
  const formatType = guideScalar(ctx, spec.formatType) as string | undefined
  // What vega's LegendEntries refuses before it lists anything -- a tickCount interval string ('day', 'month', ...) on a scale that
  // is not a calendar, a format specifier the label format refuses -- makes it throw: the dataflow pass aborts there, and the
  // legend (and whatever comes after it in its scope) is never made (a scale ranked late in its own scope puts the failing
  // operator last: the legend is then made without its entries, and the rest of the scope is made)
  // The entries of a symbol legend are made in instances of their own, two levels below the legend's scope: the boxes of all
  // the entries in the first, a symbol and a label per entry in the next. They are the legend's children there, after the
  // instances of the scope's groups. A pass that stopped before an instance never made what it holds.
  const symbols = legendType(spec, scaleType) === 'symbol'
  const slot = symbols ? takeLegendSlot(ctx) : undefined
  const cut = ctx.abort.cut
  // (a gradient's labels are ranked after every other operator of the scope: made only where the pass went past them)
  let lateLabels = false
  if (legendType(spec, scaleType) === 'gradient' && !tickCountRaw) {
    // (the default tick count is an expression of the gradient's length, made where the scope first needs it)
    const length = spec.gradientLength ?? config.gradientLength
    const key = isSignal(length) ? length.signal : String(length)
    const seen = (ctx.scope.counts ??= new Set())
    lateLabels = !seen.has(key)
    seen.add(key)
  }
  // (a layout ranked after the instance comes after its late labels too)
  let labels: 'none' | undefined = lateLabels && cut !== undefined && cut.layout === undefined && compareInstances(ctx.scope.path, cut.path) === 0
    && !(cut.labels === true && cut.legend !== undefined && index <= cut.legend) ? 'none' : undefined
  // (the pass stopped in the encode of a mark that reads a late scale, in this very scope: a legend over a late scale is ranked after
  // that encode, and only what the legend's group and its title read of nothing late was made)
  let entriesFailed = cut?.lateScale === true && compareInstances(ctx.scope.path, cut.path) === 0 && scaleNamedIsLate(ctx.scope, channels[0]![1], ctx.chart)
  const refusal = entriesFailed ? undefined : entriesRefusal({ type: legendType(spec, scaleType), scale: scale as never, count: tickCountRaw, minstep, values, formatSpecifier, formatType, locale: chartLocale(ctx.chart.locale) })
  if (refusal !== undefined) {
    if (lateLabels) {
      // (the entries of a gradient whose labels are ranked last: the pass stops there, after the rest of the scope, and the legend
      // has its gradient and its title but no labels)
      failPass(ctx, { axis: Infinity, legend: index, labels: true }, refusal)
      labels = 'none'
    } else {
      const own = scopeScale(ctx.scope, channels[0]![1])
      const late = own !== undefined && scaleIsLate(own, ctx.scope, ctx.chart)
      failPass(ctx, { axis: Infinity, legend: index, ...(late ? { late: true } : {}) }, refusal)
      if (!late) return null
      entriesFailed = true
    }
  }
  const entries: 'none' | 'boxes' | undefined = slot === undefined || cut === undefined ? undefined
    : compareInstances([...ctx.scope.path, slot], cut.path) > 0 ? 'none'
      : compareInstances([...ctx.scope.path, slot, 0], cut.path) > 0 ? 'boxes' : undefined
  if (entriesFailed) {
    const title = guideScalar(ctx, spec.title)
    const titleStr = title == null ? '' : String(title)
    const items: SceneItem[] = []
    if (titleStr) items.push({ _legendTitle: true, _part: 'title', _kind: 'text', text: titleStr, x: 0, y: 0, align: 'left', baseline: 'top', fill: '#000', fontSize: 11, fontWeight: 'bold' } as SceneItem)
    // (the kind of legend it would have been: vega-parser's legendType, decided before any entry is built; a gradient
    // legend still has its gradient item, unencoded)
    const kind = legendType(spec, scaleType)
    if (kind === 'gradient') items.push({ _part: 'gradient', _kind: 'rect', _bare: true, x: 0, y: 0, path: 'M0,0h0v0h0Z' } as unknown as SceneItem)
    return { marktype: 'group', role: 'legend', legendType: kind, _entriesPending: true, x: 0, y: 0, width: 0, height: 0, items, ...(kind === 'discrete' ? { madeMarks: ['entry'] } : {}) } as unknown as SceneGroup
  }
  const host = guideHost(ctx)
  host.stopped = undefined
  const guides = chartGuides(ctx.chart)
  // (an entry's size is read while the entries are listed -- an encode of the symbols or the labels that throws there is the
  // legend's entries operator failing: vega never makes the legend)
  let built: ReturnType<typeof buildLegendGuide>
  try {
    built = buildLegendGuide({
      store: guides.evals > 1 ? (guides.defs ??= new Map()) : undefined, keep: guides.evals > 1,
      spec, config, encode: (legend.encode ?? NO_PROPS) as Record<string, UserEncode | undefined>,
      channels, scale: scale as never, scaleType, scaleOf: (name) => ctx.scales.get(name) as never,
      values, count: tickCountRaw, minstep,
      limit: +(guideScalar(ctx, spec.symbolLimit ?? config.symbolLimit) as number),
      formatSpecifier, formatType,
      locale: chartLocale(ctx.chart.locale), host, style: guideStyles(ctx), raw: !!ctx.rawGuides,
      ...(ctx.passMemory !== undefined ? { relayout: legendMemory(ctx.passMemory, `l${ctx.scope.path.join('/')}:${index}`) } : {}),
      ...(entries !== undefined ? { entries } : {}),
      ...(lateLabels ? { lateLabels } : {}),
      ...(labels !== undefined ? { labels } : {}),
      ...(ctx.rawGuides && slot !== undefined && (ctx.layoutThrew === true || (cut !== undefined && entryGridRan(ctx.scope.path, slot, cut))) ? { entryGrid: true } : {}),
    })
  } catch (e) {
    // (an expression of the spec threw while the entries were listed -- an entry's size is read there: the legend's entries
    // operator fails, and vega never makes the legend)
    if (!(e instanceof ExpressionFailure)) throw e
    failPass(ctx, { axis: Infinity, legend: index }, e.error)
    return null
  }
  // (the grid of the entries threw: the layout of the instance that holds them is ranked after the last of them)
  if (built.gridError !== undefined) {
    const holder = [...ctx.scope.path, slot!]
    failPass(ctx, { path: [...holder, Infinity], axis: Infinity, late: true, layout: { items: [holder], at: 0 } }, built.gridError.error)
  }
  // (an encode of the entries threw in the instance that made them: the pass stopped there, and not in this scope)
  const stopped = stoppedOf(host)
  const inEntries = stopped?.at !== undefined && stopped.at !== 'labels' && slot !== undefined
  failGuide(ctx, host, { axis: Infinity, legend: index, inside: true, ...(stopped?.at === 'labels' ? { labels: true as const } : {}), ...(inEntries ? { path: [...ctx.scope.path, slot!, ...(stopped!.at === 'entry' ? [] : [stopped!.entryIndex ?? 0])] } : {}) })
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
    // (the legend group item's own datum: vega-parser legend.js)
    datum: built.datum,
    partMeta: built.partMeta,
    ...(built.partMeta.legend?.name ? { cssName: built.partMeta.legend.name } : {}),
    legendBounds: built.bounds,
    ...(itemAriaOf(built.group) ? { itemAria: itemAriaOf(built.group) } : {}),
    // what the legend layout reads off the group item
    legendProps: { orient: g.orient, offset: g.offset, x: g.x, y: g.y },
    legendItemFormat: { format: g.format, formatType: g.formatType },
    ...(isUnencoded(g) ? { unencoded: true } : {}),
    ...(g.strokeWidth !== undefined ? { strokeWidth: g.strokeWidth } : {}),
    ...(cursorOf(g) !== undefined ? { cursor: cursorOf(g) } : {}),
    ...(g.tooltip !== undefined ? { tooltip: g.tooltip } : {}),
    ...(g.href != null ? { href: g.href } : {}),
    // (a group item's `clip` clips what it holds to its box, a guide's as any group's: the legend's box is its laid-out size)
    ...(g.clip ? { contentClipBox: { w: built.width, h: built.height } } : {}),
    ...(built.madeMarks !== undefined ? { madeMarks: built.madeMarks, _entriesPending: true } : {}),
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
  const host: GuideHost = {
    entry: (spec, datum, item) => withEncodeItem(ctx, item, () => resolveEncodeProperty(spec as EncodeValue | EncodeValue[], datum, ctx)),
    fastCache: new Map(), runCache: new Map(),
    entryScale: (name) => {
      const s = ctx.scales.get(name)
      if (!s) return undefined
      // (scaleValue's coercions, written out here: the guides' scale calls do not share a call site with the marks')
      const call = (raw: unknown): unknown => {
        if (raw === undefined) {
          const dom = s.domain?.() as unknown[] | undefined
          if (!Array.isArray(dom) || !dom.includes(undefined)) return undefined
        }
        return s(raw)
      }
      return { fn: s as (v: unknown) => unknown, call, bandwidth: () => (typeof s.bandwidth === 'function' ? s.bandwidth() : 0) }
    },
    expr: (code) => { try { return evalSignal(ctx.runtime.expr(code), ctx.signalParams) } catch (e) { refuseUnrecoverable(e); throw new ExpressionFailure(e) } },
    exprDatum: (code, datum) => { try { return ctx.runtime.expr(code)(datum, ctx.signalParams) } catch (e) { refuseUnrecoverable(e); throw new ExpressionFailure(e) } },
    viewSignal: (name) => viewSignal(ctx, name),
    scale: (name) => ctx.scales.get(name) as never,
    note: (e) => reportEvalError(ctx, e instanceof ExpressionFailure ? e.error : e),
    // (what reads a late signal that threw never ran: see `withoutLateReads`)
    get unrun() { return ctx.lateTaint === undefined ? undefined : (code: string) => readsLateSignal(code, ctx) },
    report: (e) => {
      refuseUnrecoverable(e)
      host.stopped ??= { error: e instanceof ExpressionFailure ? e.error : e, ...(host.at !== undefined ? { at: host.at, entryIndex: host.entryIndex } : {}) }
    },
    gradient: (name, vertical) => {
      // vega-functions gradient(): stops from the scale's ticks (see scaleGradientStops); the definition is the
      // renderer's, content-addressed by direction and stops. Through `addDefs`, as every definition a guide asks for: a group
      // mark kept whole brings it back from its log.
      const stops = scaleGradientStops(ctx.scales.get(name) as never)
      const id = gradientDefId(vertical ? 'vertical' : 'horizontal', stops)
      if (stops.length) addDefs(ctx, [{ id, colorStops: stops, direction: vertical ? 'vertical' : 'horizontal' }])
      else ctx.defsAsked.n++
      return `url(#${id})`
    },
    groupBox: (geo, w, h) => groupBackground(geo, w, h),
    warn: (msg) => ctx.logger.warn(msg),
  }
  return host
}

/**
 * A guide's encode threw (the host stopped): the pass stops at that guide, which keeps what it had made. Recorded against the
 * point the guide's operators are ranked at (`point`), and the host is free for the guides of a pass that goes on.
 */
const stoppedOf = (host: GuideHost): GuideHost['stopped'] => host.stopped
function failGuide(ctx: EvalContext, host: GuideHost, point: Omit<AbortPoint, 'path'> & { path?: number[] }): boolean {
  const stopped = host.stopped
  if (stopped === undefined) return false
  host.stopped = undefined
  failPass(ctx, point, stopped.error)
  return true
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
 * which the layout and every guide mark's encode read).
 */
function resolveAxisOrient(axis: CompiledAxis, ctx: EvalContext): CompiledAxis {
  if (!axis.orientSignal) return axis
  let value: unknown
  try { value = evalSignal(ctx.runtime.expr(axis.orientSignal.signal), ctx.signalParams) } catch (e) { reportEvalError(ctx, e); value = undefined }
  return { ...axis, orient: typeof value === 'string' ? value : '' }
}

/** A guide property that may be a signal, as the value the signal holds. */
function guideScalar(ctx: EvalContext, v: unknown): unknown {
  if (!isSignal(v)) return v
  try { return evalSignal(ctx.runtime.expr(v.signal), ctx.signalParams) } catch (e) { reportEvalError(ctx, e); return undefined }
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

/** The names an expression reads by themselves, as the lexer reads them (see `identifiersIn`). */
const expressionIdentifiers = identifiersIn

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
        for (const sc of scalesReadIn(v)) out.scales.add(sc)
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
  refuseUnrecoverable(e)
  const own = scopeScale(ctx.scope, axis.scale)
  const late = own !== undefined && scaleIsLate(own, ctx.scope, ctx.chart)
  if (late && (axis.domain !== false || (axis.title !== undefined && axis.title !== null))) {
    throw new Error(`[aster] the ticks of the axis over scale "${axis.scale}" failed (${e instanceof Error ? e.message : String(e)}); vega cannot serialize the half-built axis either`)
  }
  failPass(ctx, { axis: index, ...(late ? { late: true } : {}) }, e)
  if (!late) return null
  // (the half-made axis: its group item, nothing in it -- not even the caption an encoded axis carries)
  return { marktype: 'group', role: 'axis', x: 0, y: 0, width: 0, height: 0, items: [], parts: [] } as unknown as SceneGroup
}

/**
 * The last instance below `scope` (or `scope` itself) that has content: every layout above it is ranked after it (see `LayoutFailure`).
 * vega builds the instances level by level, so the last is the deepest, and of those the last made.
 */
function noteInstance(scope: GuideScope, path: number[]): void {
  for (let up: GuideScope | undefined = scope; up !== undefined; up = up.parent) {
    if (up.last === undefined || compareInstances(path, up.last) > 0) up.last = path
  }
}

/**
 * After a group mark's items are made: when the layout of one of them threw, the pass stops at the mark's layout operator, which
 * is ranked after the last instance below its items that has content (made whole), or, when none has any, right after the mark
 * (nothing after the mark in its scope is made then). In the pass that stops there, the scopes the mark is in are not laid out (see
 * `holdsFailedLayout`). Returns whether this mark's layout is the one the pass stopped at.
 */
function layoutFailed(ctx: EvalContext, entered: readonly EnteredGroup[], outcomes: readonly GroupOutcome[]): boolean {
  const at = outcomes.findIndex((o) => o.layoutError !== undefined)
  const cut = ctx.abort.cut?.layout
  const stoppedHere = cut !== undefined && entered.length === cut.items.length && entered.every((g, i) => compareInstances(g.path, cut.items[i]!) === 0)
  if (at < 0) return stoppedHere
  const layout: LayoutFailure = { items: entered.map((g) => g.path), at }
  const last = outcomes.reduce<number[] | undefined>((max, o) => (o.last !== undefined && (max === undefined || compareInstances(o.last, max) > 0) ? o.last : max), undefined)
  const error = outcomes[at]!.layoutError!.error
  if (last !== undefined) failPass(ctx, { path: last, axis: Infinity, late: true, layout }, error)
  else {
    failPass(ctx, { axis: Infinity, mark: ctx.scope.mark ?? 0, layout }, error)
    ctx.encodeAborted = true
  }
  return true
}

/** Whether the mark whose layout threw is in the scope of instance `path` (or below it): that scope's layout, ranked after it, never ran. */
function holdsFailedLayout(path: readonly number[], failing: LayoutFailure | undefined): boolean {
  const item = failing?.items[0]
  return item !== undefined && item.length > path.length && within(item, path)
}

/** What the view's own layout warns, kept with the pass that makes it (see `buildContent`). */
function layoutWarn(ctx: EvalContext): (message: string) => void {
  return (message) => { ctx.layoutState.warnings.push(message) }
}

/** What the layout of a group item is given, as text: the item's own place and size, its options, and where its content is and reaches. */
function layoutInput(own: readonly number[], content: readonly SceneGroup[], options: Record<string, unknown>): string {
  let input = `${own.join(',')}|${JSON.stringify(options)}`
  for (const g of content) {
    const b = layoutBounds(g)
    input += `|${g.role ?? ''}:${g.x},${g.y},${g.width},${g.height}:${b.x1},${b.y1},${b.x2},${b.y2}`
  }
  return input
}

/**
 * The warnings of a group mark's layout, one operator for all its items, kept with the pass (see `buildContent`). A view that fits its
 * viewport runs its dataflow again once it is sized: the layout of a group mark runs again only when what it lays out changed (an
 * item, or what one holds, read the size), so one given what the pass before gave it warns nothing the second time.
 */
function markLayoutWarnings(mark: CompiledMark, ctx: EvalContext, outcomes: readonly GroupOutcome[]): void {
  const warnings = outcomes.flatMap((o) => o.warnings ?? [])
  const memory = ctx.passMemory
  if (memory !== undefined) {
    const id = `${ctx.scope.path.join('/')}#${markIdOf(mark)}`
    const input = outcomes.map((o) => o.input ?? '').join('\n')
    memory.cur.inputs.set(id, input)
    if (memory.prev?.inputs.get(id) === input) return
  }
  for (const message of warnings) ctx.layoutState.warnings.push(message)
}

/**
 * Build the view's guides with what reads a late signal that threw left out: in vega the operators that read it never ran, so an
 * expression of a guide that reads it gives nothing here, and throws nothing.
 */
function withoutLateReads<T>(ctx: EvalContext, build: () => T): T {
  if (ctx.lateTaint === undefined) return build()
  const runtime = ctx.runtime
  const expr = runtime.expr
  runtime.expr = (code) => (readsLateSignal(code, ctx) ? nothing : expr(code))
  try { return build() } finally { runtime.expr = expr }
}
const nothing = (): undefined => undefined

/** Whether an expression reads a late signal that threw (or one that reads it): vega never ran what reads it. */
function readsLateSignal(code: string, ctx: EvalContext): boolean {
  const t = ctx.lateTaint
  return t !== undefined && expressionIdentifiers(code).some((id) => t.signals.has(id))
}

/**
 * Whether the ticks of an axis read a late signal that threw (its parameters of vega's AxisTicks: `tickCount`, `values`, `tickMinStep`,
 * `format`, `formatType`, `tickExtra`). That operator is then ranked after the signal and never runs: the axis has no ticks.
 */
function axisTicksReadLate(own: Record<string, unknown>, cfg: Record<string, unknown>, ctx: EvalContext): boolean {
  if (ctx.lateTaint === undefined) return false
  let hit = false
  const params = { tickCount: own.tickCount, values: own.values, tickMinStep: own.tickMinStep, format: own.format, formatType: own.formatType, tickExtra: own.tickExtra ?? cfg.tickExtra }
  walkStrings(params, (str, owner) => {
    if (!hit && owner !== null && owner.signal === str && readsLateSignal(str, ctx)) hit = true
  })
  return hit
}

function buildAxis(axis: CompiledAxis, ctx: EvalContext, index: number): SceneGroup | null {
  return withGuideGradients(ctx, makeAxis(axis, ctx, index))
}

function makeAxis(axis: CompiledAxis, ctx: EvalContext, index: number): SceneGroup | null {
  const scale = ctx.scales.get(axis.scale)
  if (!scale) return null
  const orient = String(axis.orient)
  const own = (axis.own ?? NO_PROPS) as Record<string, unknown>
  const cfg = (axis.cfg ?? NO_PROPS) as Record<string, unknown>
  // Ticks that read a late signal that threw were never made. The axis's tick, label and grid marks are made from them, after them:
  // none of those is in vega's scenegraph, which keeps their places empty, and vega's own renderers cannot draw it (its `toSVG`
  // rejects; a view logs a second error and stops drawing there). As where the ticks fail of a scale ranked late (axisTicksFailed),
  // that is refused -- once the pass is known to make the axis (the first pass only finds where it stops).
  if (ctx.abort.cut !== undefined && axisTicksReadLate(own, cfg, ctx)) {
    const parts = propsOf(own, cfg)
    if (parts.get('ticks', true) || parts.get('labels', true) || parts.get('grid', false)) {
      const e = ctx.abort.failures.find((f) => f.lateSignal)?.error
      throw new Error(`[aster] the ticks of the axis over scale "${axis.scale}" read a signal that threw (${e instanceof Error ? e.message : String(e)}); vega cannot draw the half-built axis either`)
    }
  }
  // (the signals vega's AxisTicks is given are operators of their own, ranked just before it: one that throws stops the pass at the axis)
  const lambda = paramsFailure(ctx, [tickPlacement(propsOf(own, cfg)).extra, axis.tickCount, axis.values, axis.tickMinStep, axis.formatType, axis.format])
  if (lambda !== undefined) {
    failPass(ctx, { axis: index }, lambda.error)
    return null
  }
  // vega's AxisTicks: the values and the tick count (signals at any depth resolved), the tally the count stands for, the count
  // through vega's tickCount (bins, tickMinStep, interval names), the ticks; the labels are formatted for the same count
  let plan: AxisTickPlan
  let ticks: unknown[]
  try {
    plan = axisTickPlan(axis, scale, ctx)
    ticks = plan.ticks
  } catch (e) {
    return axisTicksFailed(axis, ctx, e, index)
  }
  const count = plan.count as number
  let labelFormat: (v: unknown) => unknown
  const labelCache: unknown[] = []
  try {
    labelFormat = axisLabelFormat(axis, scale, count, ctx, !!plan.values)
    // vega's AxisTicks formats every tick as it makes the tuples: a format that throws (an invalid
    // specifier) is logged and the axis never gets its ticks
    for (let i = 0; i < ticks.length; i++) labelCache[i] = labelFormat(ticks[i])
  } catch (e) {
    return axisTicksFailed(axis, ctx, e, index)
  }
  // vega-encode AxisTicks tuples, the datum a tick / label / grid encode reads:
  // `{index (fraction 0..1), tickIndex, value, label}`; the `extra` entry (an
  // extra tick pegged to the first value, for binned axes) is
  // `{index: -1, tickIndex: -1, extra: {value}, label: ''}`.
  const band = tickPlacement(propsOf(own, cfg))
  const extra = isSignal(band.extra) ? evalSignal(ctx.runtime.expr(band.extra.signal), ctx.signalParams) : band.extra
  let rows: Row[] = ticks.map((value, i) => ({ index: i / ((ticks.length - 1) || 1), tickIndex: i, value, label: labelCache[i] }))
  if (extra && ticks.length) rows.push({ index: -1, tickIndex: -1, extra: { value: ticks[0] }, label: '' })
  if (ctx.passMemory !== undefined) rows = retainGuideOrder(rows, ctx.passMemory, `a${ctx.scope.path.join('/')}:${index}`)
  allot('items', rows.length, 'axis ticks')

  const guides = chartGuides(ctx.chart)
  const host = guideHost(ctx)
  host.stopped = undefined
  const built = buildAxisGuide({
    store: guides.evals > 1 ? (guides.defs ??= new Map()) : undefined, keep: guides.evals > 1,
    spec: own, cfg, scale: axis.scale, orient, orientSignal: axis.orientSignal !== undefined, encode: (axis.encode ?? NO_PROPS) as Record<string, UserEncode | undefined>,
    ticks: rows, distinctTicks: !plan.values && DISTINCT_TICK_SCALES.has(ctx.scaleTypes.get(axis.scale) ?? ''), width: ctx.width, height: ctx.height, raw: !!ctx.rawGuides, host, style: guideStyles(ctx),
  })
  failGuide(ctx, host, { axis: index, inside: true })
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
  const axisTranslate = ctx.rawGuides ? 0 : (typeof g.translate === 'number' ? g.translate : 0.5)
  gb.background.x = gx
  gb.background.y = gy
  if (gb.foreground) { gb.foreground.x = gx; gb.foreground.y = gy }
  // (the axis group item's bounds, as its layout left them -- what it holds, its stroke; not its box -- are what a gradient on its
  // box is laid over on a canvas: in the box's own frame)
  if (!built.bounds.empty()) {
    const own = { x1: built.bounds.x1 - gx, y1: built.bounds.y1 - gy, x2: built.bounds.x2 - gx, y2: built.bounds.y2 - gy }
    ;(gb.background as unknown as Record<string, unknown>)._itemBounds = own
    if (gb.foreground) (gb.foreground as unknown as Record<string, unknown>)._itemBounds = own
  }
  const out = {
    marktype: 'group',
    role: 'axis',
    items: built.leaves,
    // (the axis group item's own datum: vega-parser axis.js)
    datum: built.datum,
    box: gb.background,
    ...(gb.foreground ? { boxFg: gb.foreground } : {}),
    // the marks vega-parser's axis builds (grid, ticks, labels, domain, title; axis.js `datum`): the SVG draws a
    // container for each, empty or not
    parts: built.parts,
    partMeta: built.partMeta,
    ...(built.partMeta.axis?.name ? { cssName: built.partMeta.axis.name } : {}),
    ...(itemAriaOf(built.group) ? { itemAria: itemAriaOf(built.group) } : {}),
    ...(cursorOf(built.group) !== undefined ? { cursor: cursorOf(built.group) } : {}),
    ...(built.group.tooltip !== undefined ? { tooltip: built.group.tooltip } : {}),
    // (a group item's `clip` clips what it holds to its box, a guide's as any group's: the axis's marks are in the view's frame, its
    // box at its position)
    ...(g.clip ? { contentClipBox: { x: gx, y: gy, w: +(g.width as number) || 0, h: +(g.height as number) || 0 } } : {}),
    // (a group item whose encode never ran has no orient: the caption calls it an X-axis, and reads no format off it)
    axis: { orient, itemOrient: isUnencoded(g) ? '' : typeof g.orient === 'string' ? g.orient : orient, format: g.format, formatType: g.formatType, ...(isUnencoded(g) ? { unencoded: true } : {}), range: axisRangeSpan, baseline: 0, translate: axisTranslate, position, bounds: built.bounds, ...(knownOrient ? {} : { noLayout: true }) },
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
/** What a legend carries between the passes of a fit view. */
function legendMemory(memory: PassMemory, id: string): { was: string | undefined; note(state: string): void } {
  return { was: memory.prev?.legends.get(id), note: (state) => { memory.cur.legends.set(id, state) } }
}

/** What a grid layout carries between the passes of a fit view, if there are two. */
function gridMemory(ctx: EvalContext, id: string): { prev: readonly GridPlace[] | undefined; keep(places: GridPlace[]): void } | undefined {
  const memory = ctx.passMemory
  if (memory === undefined) return undefined
  return { prev: memory.prev?.places.get(id), keep: (places) => { memory.cur.places.set(id, places) } }
}

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

/**
 * A guide's URLs go through the URL policy like any mark's (`vetItemUrls`): every node of it, however deep -- the guide's group,
 * the mark groups of its parts and their items (a title's text items are two levels down), and the box leaves of a group item.
 */
function vetGuideLinks(g: SceneGroup, ctx: EvalContext): void {
  if (ctx.urlPolicy === undefined) return
  const visit = (node: SceneItem, depth: number): void => {
    vetItemUrls(node, false, ctx)
    const rec = node as unknown as { items?: unknown; box?: unknown; boxFg?: unknown }
    for (const leaf of [rec.box, rec.boxFg]) if (leaf !== null && typeof leaf === 'object') vetItemUrls(leaf as SceneItem, false, ctx)
    if (Array.isArray(rec.items) && depth < 64) for (const it of rec.items as SceneItem[]) visit(it, depth + 1)
  }
  visit(g as unknown as SceneItem, 0)
}

/** An axis's `values`: what a signal holds when the ticks are made; null, undefined, 0 or '' is no values at all. */
/**
 * Scales whose own ticks are strictly increasing numbers (d3's) or the scale's distinct domain: no two ticks have one key. The
 * calendar scales are not among them: their ticks are Dates, keyed by their string, which stops at the second, so ticks a few
 * milliseconds apart are one key (vega draws one item for them).
 */
const DISTINCT_TICK_SCALES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'band', 'point'])

/** What vega's AxisTicks makes of an axis's parameters: its explicit values, the tick count, and the ticks. */
interface AxisTickPlan { values: unknown; count: unknown; ticks: unknown[] }

/** An axis parameter vega reads through `objectProperty` (`values`, `tickCount`): signals at any depth resolved. */
function axisObjectParam(v: unknown, ctx: EvalContext): unknown {
  return objectProperty(v, (code) => evalSignal(ctx.runtime.expr(code), ctx.signalParams))
}

/**
 * vega-encode AxisTicks: the tally is the tick count, else one per explicit value, else 10; the count is vega's `tickCount(scale,
 * tally, minstep)` (a number thinned by the minimum step and widened to the bins, an interval name or `{interval, step}` on a
 * calendar scale -- a name it does not know is no interval, so the scale's default ticks -- anything else as it is); the ticks are
 * the explicit values valid on the scale (`validTicks`), else the scale's ticks for the count. A `values` that is no list is a
 * TypeError in the dataflow, as vega's (`ticks.map is not a function`).
 */
function axisTickPlan(axis: CompiledAxis, scale: Scale, ctx: EvalContext): AxisTickPlan {
  const values = axisObjectParam(axis.values, ctx)
  const given = axisObjectParam(axis.tickCount, ctx)
  const minstep = guideScalar(ctx, axis.tickMinStep)
  const tally = given == null ? (values ? (values as unknown[]).length : 10) : given
  const count = tickCount(scale, tally, minstep as number | undefined)
  if (values) {
    if (!Array.isArray(values)) throw new TypeError('ticks.map is not a function')
    return { values, count, ticks: validTicks(scale, values, count as number) }
  }
  return { values, count, ticks: scaleTicks(scale, count as number) }
}

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number, ctx: EvalContext, noSkip = false): (v: unknown) => string {
  // (vega has no axis `labelExpr`: vega-lite compiles it to `encode.labels.update.text`,
  // which is applied to the label items themselves - see `customize` in guide-encode.ts - so a raw
  // `labelExpr` is ignored here exactly as vega ignores it)
  // The format and its type are what vega's AxisTicks is given: the values themselves (a signal's is what it holds, whatever its
  // type), read by the scale's tick format as vega's is. A specifier that is no string is a time multi-format on a calendar
  // (anything falsy is the default one, an object overrides it per unit, anything else is refused) and the text of its value for a
  // number format (`42` is a width, `NaN` is refused); a specifier the format refuses throws here, as it makes vega's AxisTicks throw.
  const formatType = paramValue(ctx, axis.formatType)
  const specifier = paramValue(ctx, axis.format)
  return tickFormat(chartLocale(ctx.chart.locale), scale, count, specifier, formatType as string | undefined, noSkip)
}

