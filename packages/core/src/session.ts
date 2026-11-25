/**
 * Incremental evaluation sessions.
 *
 * `renderSpec` is a pure one-shot (it compiles and evaluates from scratch); `evaluateChart` on a held
 * `CompiledChart` commits incremental state that a later call with change hints reuses.
 * A live React app
 * re-renders constantly — often with the same data (parent state changed, a
 * sibling updated, spec literal rebuilt). Without a session, aster re-evaluates
 * the whole scene on every one of those renders; Vega's dataflow skips work
 * when nothing is dirty. `createChartSession` closes that gap:
 *
 * - fingerprints everything evaluateChart consumes (spec structure minus
 *   dataset values, value-array identities, size, signal values)
 * - identical fingerprint -> returns the *same* SceneRoot object, zero work
 * - re-compiles the IR only when the structural skeleton actually changed
 *
 * Caveat (same as Vega's): dataset arrays are tracked by reference. Mutating
 * an array in place without replacing it is invisible to the cache. A spec is compared by content: a spec that is DEEP-FROZEN
 * (checked once per object, remembered) cannot change, so evaluating it again reads none of it; any other spec is compared as before.
 */
import { compileChart } from './compiler.js'
import { assertSpecObject } from './spec-guards.js'
import { dict, ownGet, sameTuple } from './util.js'
import { dataInputOf, valuesSignal } from './spec-structure.js'
import { checkHintShapes, evaluateChartPending, keepsTupleHistory, type DataStability, type IncrementalEngine } from './runtime.js'
import { applyOneWithState } from './incremental-state.js'
import { optionalPart } from './engine-parts.js'
import { refId, valueKey } from './fingerprint.js'
import { formatEnvironmentKey } from './locale.js'
import { getTextMetricsProvider } from './text-metrics.js'
import { expressionRegistryEpoch } from './expression.js'
import { assertSpecDepth, checkSpecLimits, checkSceneLimits, createLimitClock, withLimits, activeMeter } from './limits.js'
import { diffRows, type DataPulse } from './pulse.js'
import { checkChartRows } from './row-watch.js'
import type { CompiledChart, RuntimeInput, SceneRoot, VgSpec } from './types.js'

/**
 * The incremental engine a session evaluates with: the step that runs from scratch, and the pulse path from its slot, which the
 * entry that makes sessions (`@aster-charts/core/dom`) fills and the React shells fill on demand (engine-parts.ts). Read at each
 * evaluation, so the evaluation after the pulse path arrives takes it.
 */
function sessionEngine(): IncrementalEngine {
  const pulse = optionalPart('pulse')
  return pulse ? { applyOneWithState, applyPipelineWithPulse: pulse.applyPipelineWithPulse } : WITHOUT_PULSE
}
const WITHOUT_PULSE: IncrementalEngine = { applyOneWithState }

/** The build's environment, as bundlers write it in (`process.env.NODE_ENV`); `process` may not exist at all (an unbundled import). */
declare const process: { env: { NODE_ENV?: string } }


/**
 * Fingerprint of a dataset value: object/array values by IDENTITY (the caveat in
 * the file header), primitives (an inline JSON/CSV string) by typed VALUE — a
 * replaced string must invalidate the cache.
 */
function dataRefKey(v: unknown): string {
  return v !== null && (typeof v === 'object' || typeof v === 'function') ? `#${refId(v as object)}` : valueKey(v)
}

/** What a top-level dataset's inline rows are reduced to in a skeleton. */
const ROWS_MARKER = '\u0000rows'
/** What a skeleton starts with when the spec cannot be written as text (a cycle, a function): it is different every time. */
const UNCACHEABLE = '\u0000uncacheable'
/** Makes each such skeleton its own (a clock would repeat inside one millisecond: two calls would then be answered alike). */
let uncacheableCount = 0

/**
 * The values JSON writes alike that a spec built in code tells apart (a signal of `Infinity` draws otherwise than one of `-Infinity`,
 * of `NaN` or of `null`; `-0` formats as `-0`; an `undefined` entry of a list is not a `null` one): each is written as a tag, a
 * string that starts with a NUL, and a string of the spec that starts with one is written with a second one before it, so no
 * string can stand for a tag. A missing key and one holding `undefined` stay alike, as they are to the engine.
 */
function keepDistinct(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : `\u0000n${Object.is(value, -0) ? '-0' : String(value)}`
  if (typeof value === 'string') return value.charCodeAt(0) === 0 ? `\u0000s${value}` : value
  if (value === undefined && Array.isArray(this)) return '\u0000u'
  return value
}

/**
 * The rows of a nested dataset (a group mark's `data`) that are many and deep-frozen: their text is made once per array (a frozen
 * array cannot change). A spec rebuilt on each render around the same frozen rows is then not stringified again in its rows.
 */
const NESTED_ROWS_MIN = 32
const NESTED_ROWS = new WeakMap<object, string>()

/** Objects known to be deep-frozen: neither they nor anything they reach can change, so what was read of them stays true. */
const DEEP_FROZEN = new WeakSet<object>()
/** Whether `root` and everything it reaches is frozen (answered once per object: later calls are one lookup). */
export function isDeepFrozen(root: unknown): boolean {
  if (root === null || typeof root !== 'object') return false
  if (DEEP_FROZEN.has(root)) return true
  const seen = new Set<object>()
  const stack: object[] = [root]
  // bounded: each object is met once
  while (stack.length) {
    const o = stack.pop()!
    if (seen.has(o) || DEEP_FROZEN.has(o)) continue
    if (!Object.isFrozen(o)) return false
    seen.add(o)
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k)
      if (d === undefined) continue
      if (!('value' in d)) return false // (a getter can answer anything)
      const v = d.value as unknown
      if (v !== null && (typeof v === 'object' || typeof v === 'function')) stack.push(v as object)
    }
  }
  for (const o of seen) DEEP_FROZEN.add(o)
  return true
}
function skeletonReplacer(this: unknown, key: string, value: unknown): unknown {
  if (key === 'values' && Array.isArray(value) && value.length >= NESTED_ROWS_MIN && isDeepFrozen(value)) {
    let text = NESTED_ROWS.get(value)
    if (text === undefined) NESTED_ROWS.set(value, (text = `${ROWS_MARKER}:${JSON.stringify(value, keepDistinct)}`))
    return text
  }
  return keepDistinct.call(this, key, value)
}

/**
 * Serialize the spec structure, leaving the top-level datasets' inline values out (they're tracked by identity).
 * Two specs with the same skeleton compile to the same chart (a session re-evaluates it with the new rows); a different
 * skeleton is a different chart. Exported for the hosts that must tell the two apart (`@aster-charts/react` keeps a chart's
 * live state for the first and starts it afresh for the second).
 */
export function skeletonOf(spec: VgSpec): string {
  // (the walk the compiler makes first, before a text of the spec is: a spec that shares sub-objects, built in code, would make
  // the text exponential in the depth of the sharing; the walk refuses it past the spec-size ceiling, as compiling it would)
  assertSpecDepth(spec)
  const data = (spec as { data?: unknown }).data
  let stripped: unknown = data
  // A dataset's rows are not part of the chart's shape, but whether it HAS rows is: without them it is the dataset's `url`
  // (or `source`) that supplies them, a different chart (and one `urlData: 'refuse'` refuses). So rows are reduced to a marker,
  // and a missing or empty `values` is kept as it is.
  const strip = (d: unknown): unknown => {
    if (!d || typeof d !== 'object') return d
    const values = (d as { values?: unknown }).values
    // (a `{signal}` values is code, part of the chart: it stays as it is)
    return values && valuesSignal(values) === undefined ? { ...(d as object), values: ROWS_MARKER } : d
  }
  if (Array.isArray(data)) {
    stripped = data.map(strip)
  } else if (data && typeof data === 'object') {
    stripped = strip(data)
  }
  const copy = { ...(spec as Record<string, unknown>), data: stripped }
  try {
    return JSON.stringify(copy, skeletonReplacer) ?? ''
  } catch {
    // Non-serializable spec (cycles/functions): no caching, always re-evaluate.
    return `${UNCACHEABLE}:${refId(spec as object)}:${++uncacheableCount}`
  }
}

function dataKeyOf(spec: VgSpec, input: RuntimeInput, out: string[]): void {
  const data = (spec as { data?: unknown }).data
  const lists: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : data && typeof data === 'object'
      ? [data as Record<string, unknown>]
      : []
  for (const d of lists) {
    if (typeof d.name !== 'string') continue
    const override = ownGet(input.data, d.name)
    // (rows a `{signal}` values makes follow the signals, which the key has already)
    const vals = override ?? (valuesSignal(d.values) === undefined ? d.values : undefined)
    if (vals == null) continue
    out.push(`${d.name}:${dataRefKey(vals)}`)
  }
}

/** Source datasets (inline/spec values or input overrides), keyed by name. */
function rawDatasets(spec: VgSpec, input: RuntimeInput): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const data = (spec as { data?: unknown }).data
  const lists: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : data && typeof data === 'object'
      ? [data as Record<string, unknown>]
      : []
  for (const d of lists) {
    if (typeof d.name !== 'string') continue
    // Derived datasets (source:) are rebuilt from their parent; input overrides
    // for them are ignored by the runtime too.
    if (dataInputOf(d) === 'source') continue
    const override = ownGet(input.data, d.name)
    // (a `{signal}` values is not rows: the evaluation makes them from the signal, as vega's dynamic loader does)
    const values = override !== undefined ? override : valuesSignal(d.values) === undefined ? d.values : undefined
    if (values != null) out.set(d.name, values)
  }
  for (const [name, rows] of Object.entries(input.data ?? {})) {
    if (!out.has(name) && !lists.some((d) => d.name === name && dataInputOf(d) === 'source')) out.set(name, rows)
  }
  return out
}

/** Diff current source rows against the previous evaluation. */
function inferPulse(previous: Map<string, unknown> | null, current: Map<string, unknown>): DataPulse {
  const datasets = new Map<string, NonNullable<DataPulse['datasets'] extends Map<string, infer T> ? T : never>>()
  const structural = new Set<string>()
  if (previous) {
    for (const [name, next] of current) {
      const prev = previous.get(name)
      if (prev === undefined) {
        structural.add(name)
        continue
      }
      if (prev === next) continue
      const diff = diffRows(prev, next)
      if (!diff) {
        // Non-row data (raw CSV/JSON strings, etc.) cannot be diffed by index;
        // treat a replaced value as structural rather than silently no-op.
        structural.add(name)
        continue
      }
      if (!diff.sameLength) structural.add(name)
      if (diff.changed.length || !diff.sameLength) datasets.set(name, { name, ...diff })
    }
    for (const name of previous.keys()) if (!current.has(name)) structural.add(name)
  }
  return { datasets, structural }
}

function pulseOfExplicit(changes: Record<string, number[]> | undefined): DataPulse {
  const datasets = new Map()
  for (const [name, changed] of Object.entries(changes ?? {})) {
    datasets.set(name, { name, changed: [...changed], sameLength: true, added: null, removed: null })
  }
  return { datasets, structural: new Set() }
}

export interface ChartSession {
  /** Evaluate `spec` + `input`, returning the cached scene when nothing changed. */
  evaluate(spec: VgSpec, input?: RuntimeInput): SceneRoot
  /**
   * Imperative per-datum update of the last compiled chart (no spec re-pass):
   * pass `{ data, dataChanges, signals, width, height }`; the session re-evaluates
   * the chart compiled by the most recent `evaluate`, reusing unchanged scene
   * items. Requires a prior `evaluate` (returns null otherwise).
   *
   * What `input` does not say is what the last accepted `evaluate` or `change` was given: its data (a dataset `data` names
   * replaces that one), and every other input, each replaced as a whole by the one `input` gives: `width`, `height`, `signals`,
   * `limits`, `urlPolicy`, `urlData`, `random`, `textMetrics`, `logger`, `domainRaw`, `containerSize`, `measuredSize`. A key
   * given as `undefined` removes the setting. The change descriptions (`dataChanges`, `dataPulse`, `changedDatasets`,
   * `autoChanges`) are this call's only.
   */
  change(input?: RuntimeInput): SceneRoot | null
  /**
   * Metadata for the last evaluation: the compiled chart (with signalDefs for
   * the event loop) and the scene. Null before the first evaluate.
   */
  last: () => { chart: CompiledChart; scene: SceneRoot } | null
  /** Source/transform pulse inferred or supplied by the last evaluation. */
  pulse: () => DataPulse | null
}

/**
 * Non-data input fingerprint: skeleton + everything else evaluateChart consumes.
 * Every component is TYPED (`valueKey`): width `undefined` vs `0`, signal `1` vs
 * `"1"`, and so on never collide; limits are part of the key because a cached
 * scene was accepted under specific budgets.
 */
function metaKeyOf(skeleton: string, input: RuntimeInput): string {
  const parts: string[] = []
  parts.push(`w=${valueKey(input.width)}`, `h=${valueKey(input.height)}`)
  // a scene made under another default locale or in another time zone formats its text and dates otherwise
  parts.push(`fmt=${formatEnvironmentKey()}`)
  // a function registered (or replaced) since is called in its new form: the scene made with the old one is not this one
  parts.push(`fx=${expressionRegistryEpoch()}`)
  // `containerSize()` is read by the spec's width / height signals: a resized container is a different view
  if (input.containerSize) parts.push(`cs=${valueKey(input.containerSize)}`)
  if (input.measuredSize) parts.push(`ms=${valueKey(input.measuredSize)}`)
  // (what measures the text: the host's for this call, else the one set for every chart: a scene measured by another is another scene)
  const measurer = input.textMetrics ?? getTextMetricsProvider()
  if (measurer) parts.push(`tm=#${refId(measurer)}`)
  // another random source is another stream: the numbers a scene was drawn with belong to the one it was evaluated with
  if (input.random) parts.push(`rnd=#${refId(input.random)}`)
  if (input.limits) parts.push(`lim=${valueKey(input.limits)}`)
  // image urls are vetted while the scene is built: a different policy can reject a scene a looser one accepted
  if (input.urlPolicy) parts.push(`up=${valueKey(input.urlPolicy)}`)
  // a refusing input must never be answered with a scene cached under one that allowed url datasets
  if (input.urlData !== undefined) parts.push(`ud=${valueKey(input.urlData)}`)
  for (const name of Object.keys(input.domainRaw ?? {}).sort()) {
    parts.push(`d ${name}=${valueKey(input.domainRaw![name])}`)
  }
  for (const name of Object.keys(input.signals ?? {}).sort()) {
    parts.push(`s ${name}=${valueKey(input.signals![name])}`)
  }
  return `${skeleton}\u0000${parts.join('\u0001')}`
}

/** Fingerprint a spec + input for the no-op cache (skeleton + data refs + size/signals). */
function fingerprint(spec: VgSpec, input: RuntimeInput, skeleton: string = skeletonOf(spec)): string {
  const parts: string[] = []
  dataKeyOf(spec, input, parts)
  return `${metaKeyOf(skeleton, input)}\u0000${parts.join('\u0001')}`
}

/** The inputs that describe one call's changes, or its data: a `change` does not carry them over from the last evaluation. */
const PER_CALL: ReadonlySet<string> = new Set<keyof RuntimeInput>(['data', 'dataChanges', 'dataPulse', 'changedDatasets', 'autoChanges'])

/** What an evaluation was given besides its data and its change descriptions. */
function settingsOf(input: RuntimeInput): RuntimeInput {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(input)) if (!PER_CALL.has(key)) out[key] = (input as Record<string, unknown>)[key]
  return out as RuntimeInput
}

/** `given` over the settings of the last evaluation, key by key (an `undefined` it gives removes one). */
function withSettings(last: RuntimeInput, given: RuntimeInput): RuntimeInput {
  return { ...last, ...given }
}

/**
 * Whether a signal was given another object than it was given last (vega's dataflow takes a value set to another object for a change,
 * whatever it holds: `Operator.set` compares by reference), the same tuple excepted whichever of the engine's copies of it it is.
 */
function setAgain(before: Record<string, unknown> | undefined, now: Record<string, unknown> | undefined): boolean {
  for (const k of Object.keys(now ?? {})) {
    const v = now![k]
    const was = before === undefined ? undefined : ownGet(before, k)
    if (v !== null && typeof v === 'object' && !Object.is(v, was) && !sameTuple(v, was)) return true
  }
  return false
}

/** Union of the pulse's structural datasets and the host's own `changedDatasets` hint. */
function mergeNames(a: Iterable<string>, b: readonly string[] | undefined): string[] {
  return [...new Set<string>([...a, ...(b ?? [])])]
}

export function createChartSession(): ChartSession {
  let lastKey = ''
  let lastMetaKey = ''
  let lastSkeleton = ''
  let lastChart: CompiledChart | null = null
  let lastScene: SceneRoot | null = null
  let lastSpec: VgSpec | null = null
  let lastRaw: Map<string, unknown> | null = null
  // the datasets the engine's committed state was made from (`lastRaw` also follows evaluations that found nothing to do, whose rows
  // are equal to these: so a pulse relative to `lastRaw` is relative to these too, and they are what the session hands the engine as
  // the rows its pulses are relative to, compared by identity)
  let engineRaw: Map<string, unknown> | null = null
  let lastPulse: DataPulse | null = null
  // what the last accepted evaluation was given besides its data and its change descriptions: a `change` goes on from there
  let lastSettings: RuntimeInput = {}
  // the signal values the session was last given (see `setAgain`)
  let lastSignals: Record<string, unknown> | undefined

  /**
   * The datasets whose rows are equal to the ones the engine's state was made from, so the steps made from them need not run: every
   * source the evaluation has no reason to doubt. By content when the session diffs the rows itself (the replaced arrays of a
   * re-render); only the very array otherwise, since nothing has looked at the rows. A dataset the host named as changed never is.
   */
  const stableData = (input: RuntimeInput, currentRaw: Map<string, unknown>, pulse: DataPulse): DataStability | undefined => {
    if (engineRaw === null || lastRaw === null) return undefined
    const byContent = !input.dataChanges && !input.dataPulse && input.autoChanges !== false
    const named = new Set(input.changedDatasets ?? [])
    let out: Map<string, unknown> | undefined
    for (const [name, rows] of currentRaw) {
      const was = engineRaw.get(name)
      if (was === undefined || named.has(name) || pulse.datasets.has(name) || pulse.structural.has(name)) continue
      if (byContent || rows === lastRaw.get(name)) (out ??= new Map()).set(name, was)
    }
    // (empty or not, the map tells the engine that this session describes every change of the rows it hands over: see DataStability)
    return out ?? new Map()
  }

  const withAutoPulse = (input: RuntimeInput, currentRaw: Map<string, unknown>): { input: RuntimeInput; pulse: DataPulse } => {
    // (a hint that cannot be what it says is refused before it is read, as the evaluation refuses it)
    checkHintShapes(input)
    if (input.dataPulse) {
      const datasets = new Map<string, never>()
      const structural = new Set<string>()
      // `dataChanges` (same-length form) and `dataPulse` may be given together,
      // for different datasets; `dataPulse` wins per dataset. Keep both, or the
      // per-datum changes of the datasets only named in `dataChanges` are lost.
      const sameLength = dict<number[]>(input.dataChanges)
      for (const [name, idxs] of Object.entries(input.dataChanges ?? {})) {
        datasets.set(name, { name, changed: [...idxs], sameLength: true, added: null, removed: null } as never)
      }
      for (const [name, p] of Object.entries(input.dataPulse)) {
        if (!p.from) sameLength[name] = p.changed ?? []
        else { structural.add(name); delete sameLength[name] }
        datasets.set(name, {
          name,
          changed: p.changed ?? [],
          sameLength: !p.from,
          added: p.added?.[0] ?? null,
          removed: p.removed?.[0] ?? null,
          ...(p.from ? { from: p.from } : {}),
          ...(p.to ? { to: p.to } : {}),
          ...(p.added ? { addedRanges: p.added } : {}),
          ...(p.removed ? { removedRanges: p.removed } : {}),
          ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
        } as never)
      }
      return {
        input: {
          ...input,
          ...(Object.keys(sameLength).length ? { dataChanges: sameLength } : {}),
          ...(structural.size || input.changedDatasets?.length ? { changedDatasets: mergeNames(structural, input.changedDatasets) } : {}),
        },
        pulse: { datasets: datasets as never, structural },
      }
    }
    if (input.dataChanges) {
      return { input, pulse: pulseOfExplicit(input.dataChanges) }
    }
    if (input.autoChanges === false) return { input, pulse: { datasets: new Map(), structural: new Set() } }
    const pulse = inferPulse(lastRaw, currentRaw)
    if (!pulse.datasets.size && !pulse.structural.size) return { input, pulse }
    const changes = dict<number[]>()
    const mapped: NonNullable<RuntimeInput['dataPulse']> = {}
    for (const [name, p] of pulse.datasets) {
      if (p.sameLength) {
        changes[name] = p.changed
      } else {
        mapped[name] = {
          changed: p.changed,
          ...(p.from ? { from: p.from } : {}),
          ...(p.to ? { to: p.to } : {}),
          ...(p.addedRanges ? { added: p.addedRanges } : {}),
          ...(p.removedRanges ? { removed: p.removedRanges } : {}),
          ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
        }
      }
    }
    const changedDatasets = [...pulse.structural]
    return {
      input: {
        ...input,
        ...(Object.keys(changes).length ? { dataChanges: changes } : {}),
        ...(Object.keys(mapped).length ? { dataPulse: mapped } : {}),
        ...(changedDatasets.length || input.changedDatasets?.length ? { changedDatasets: mergeNames(changedDatasets, input.changedDatasets) } : {}),
      },
      pulse,
    }
  }

  /**
   * The session's view of the data as plain `input.data`: inline spec values and
   * host overrides merged. The compiled IR is never re-pointed at new values
   * (it is immutable); every evaluation is handed the current ones instead.
   */
  const dataInput = (raw: Map<string, unknown>): Record<string, unknown[]> => {
    const data = dict<unknown[]>()
    for (const [name, rows] of raw) data[name] = rows as unknown[]
    return data
  }

  const evaluateOnce = (spec: VgSpec, input: RuntimeInput = {}): SceneRoot => {
    const clock = activeMeter()?.clock ?? createLimitClock(input.limits)
    // (development builds: rows changed in place since the last evaluation are warned about, see row-watch.ts)
    try {
      if (process.env.NODE_ENV !== 'production') checkChartRows(session, spec, input as never)
    } catch (e) {
      if (typeof process !== 'undefined') throw e
    }
    clock.check('compile')
    // The spec this session evaluated last, when it is deep-frozen: it cannot have changed, so its skeleton is the one made then (the
    // walk that bounds its depth and the text of all of it are made for it once). Any other spec is read each time.
    // (a spec that cannot be written as text is never cached: its skeleton is made anew each time, see `skeletonOf`)
    const again = lastSpec !== null && spec === lastSpec && !lastSkeleton.startsWith(UNCACHEABLE) && isDeepFrozen(spec)
    const skeleton = again ? lastSkeleton : skeletonOf(spec)
    const metaKey = metaKeyOf(skeleton, input)
    const key = fingerprint(spec, input, skeleton)
    const currentRaw = rawDatasets(spec, input)
    const { input: effectiveInput, pulse } = withAutoPulse(input, currentRaw)
    // An explicit change description (per-datum changeset, pulse, or a named
    // changed dataset) means the data values changed — often in place, so the
    // array identity and thus the fingerprint is unchanged — so the no-op
    // cache must not short-circuit the re-evaluation.
    const hinted = !!input.dataChanges || !!input.dataPulse || !!input.changedDatasets?.length
    // (a chart whose tuples carry what the run before wrote -- runtime.ts `historyRun` -- is not a function of its inputs: a signal set
    // again to another object is a run of vega's dataflow even when the object holds what the one before held)
    const signalSetAgain = lastChart !== null && skeleton === lastSkeleton && keepsTupleHistory(lastChart) && setAgain(lastSignals, input.signals)
    lastSignals = input.signals
    if (!hinted && !signalSetAgain && key === lastKey && lastScene) {
      lastRaw = currentRaw
      lastPulse = pulse
      lastSettings = settingsOf(input)
      return lastScene
    }
    // New row arrays with identical values are a no-op for the scene: the
    // inferred pulse is empty and everything else matches the previous run.
    if (input.autoChanges !== false && !hinted && !signalSetAgain && !pulse.datasets.size && !pulse.structural.size && metaKey === lastMetaKey && lastScene) {
      lastRaw = currentRaw
      lastPulse = pulse
      lastSettings = settingsOf(input)
      lastKey = key
      return lastScene
    }

    // The pre-flight walks the whole spec: it is for what is about to be evaluated, so a call answered from the cache above (the
    // same spec content, data arrays and limits as the scene it returns was accepted under) is not walked again.
    if (input.limits) checkSpecLimits(spec as unknown as Record<string, unknown>, input.limits, input)

    // Compute everything into locals and commit only after every check has
    // passed: a limit that throws must leave the session — and the
    // engine's incremental state — exactly as the previous accepted
    // evaluation left them.
    const recompile = skeleton !== lastSkeleton || !lastChart
    const chart = recompile ? compileChart(spec) : lastChart!
    clock.check('compile')
    // (a chart compiled anew has no state to keep steps from)
    const pending = evaluateChartPending(sessionEngine(), chart, { ...effectiveInput, data: dataInput(currentRaw) }, recompile ? undefined : stableData(input, currentRaw, pulse), engineRaw ?? undefined)
    clock.check('evaluate')
    if (input.limits) checkSceneLimits(pending.scene, input.limits)
    pending.commit()
    engineRaw = currentRaw
    lastSettings = settingsOf(input)
    lastChart = chart
    lastSkeleton = skeleton
    lastSpec = spec
    lastScene = pending.scene
    lastKey = key
    lastMetaKey = metaKey
    lastRaw = currentRaw
    lastPulse = pulse
    return lastScene
  }

  const changeOnce = (input: RuntimeInput): SceneRoot | null => {
    // Imperative per-datum update of the last compiled chart. No spec re-pass:
    // the host drives changes via data/dataChanges/signals. Requires a prior
    // evaluate (we need a compiled chart + spec to fingerprint against).
    if (!lastChart || !lastSpec || !lastRaw) return null
    const clock = activeMeter()?.clock ?? createLimitClock(input.limits)
    // Start from the data the last evaluation (or change) left behind; the
    // host's `data` overrides win. A datum the host does not mention keeps its
    // current value rather than reverting to the spec's original one.
    try {
      if (process.env.NODE_ENV !== 'production') checkChartRows(session, lastSpec, input as never)
    } catch (e) {
      if (typeof process !== 'undefined') throw e
    }
    const currentRaw = new Map(lastRaw)
    for (const [name, rows] of Object.entries(input.data ?? {})) currentRaw.set(name, rows)
    const { input: effectiveInput, pulse } = withAutoPulse(input, currentRaw)
    const pending = evaluateChartPending(sessionEngine(), lastChart, { ...effectiveInput, data: dataInput(currentRaw) }, stableData(input, currentRaw, pulse), engineRaw ?? undefined)
    clock.check('change')
    if (input.limits) checkSceneLimits(pending.scene, input.limits)
    pending.commit()
    engineRaw = currentRaw
    lastSettings = settingsOf(input)
    lastSignals = input.signals
    lastScene = pending.scene
    // Every key follows the state that was just committed, or the no-op cache
    // would serve a scene built for different inputs.
    lastKey = fingerprint(lastSpec, { ...effectiveInput, data: dataInput(currentRaw) }, lastSkeleton)
    lastMetaKey = metaKeyOf(lastSkeleton, effectiveInput)
    lastRaw = currentRaw
    lastPulse = pulse
    return lastScene
  }

  const session: ChartSession = {
    evaluate: (spec, input = {}) => { assertSpecObject(spec, 'ChartSession.evaluate'); return withLimits(input.limits, () => evaluateOnce(spec, input)) },
    change: (given = {}) => {
      // (the limits too: a change after an evaluation under limits runs under them, unless it gives its own)
      const input = withSettings(lastSettings, given)
      return withLimits(input.limits, () => changeOnce(input))
    },
    last: () => (lastChart && lastScene ? { chart: lastChart, scene: lastScene } : null),
    pulse: () => lastPulse,
  }
  return session
}
