/**
 * Incremental evaluation sessions.
 *
 * `renderSpec`/`evaluateChart` are pure, stateless one-shots. A live React app
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
 * an array in place without replacing it is invisible to the cache.
 */
import { compileChart } from './compiler.js'
import { dict, ownGet } from './util.js'
import { evaluateChartPending } from './runtime.js'
import { refId, valueKey } from './fingerprint.js'
import { checkSpecLimits, checkSceneLimits, createLimitClock, withLimits, activeMeter } from './limits.js'
import { diffRows, type DataPulse } from './pulse.js'
import type { CompiledChart, RuntimeInput, SceneRoot, VgSpec } from './types.js'

/**
 * Fingerprint of a dataset value: object/array values by IDENTITY (the caveat in
 * the file header), primitives (an inline JSON/CSV string) by typed VALUE — a
 * replaced string must invalidate the cache (C15).
 */
function dataRefKey(v: unknown): string {
  return v !== null && (typeof v === 'object' || typeof v === 'function') ? `#${refId(v as object)}` : valueKey(v)
}

/**
 * Serialize the spec structure, leaving the top-level datasets' inline values out (they're tracked by identity).
 * Two specs with the same skeleton compile to the same chart (a session re-evaluates it with the new rows); a different
 * skeleton is a different chart. Exported for the hosts that must tell the two apart (`@aster/react` keeps a chart's
 * live state for the first and starts it afresh for the second).
 */
export function skeletonOf(spec: VgSpec): string {
  const data = (spec as { data?: unknown }).data
  let stripped: unknown = data
  if (Array.isArray(data)) {
    stripped = data.map((d) => (d && typeof d === 'object' ? { ...(d as object), values: null } : d))
  } else if (data && typeof data === 'object') {
    stripped = { ...(data as object), values: null }
  }
  const copy = { ...(spec as Record<string, unknown>), data: stripped }
  try {
    return JSON.stringify(copy) ?? ''
  } catch {
    // Non-serializable spec (cycles/functions): no caching, always re-evaluate.
    return `\u0000uncacheable:${refId(spec as object)}:${Date.now()}`
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
    const vals = override ?? d.values
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
    if (typeof d.source === 'string') continue
    const override = ownGet(input.data, d.name)
    const values = override !== undefined ? override : d.values
    if (values != null) out.set(d.name, values)
  }
  for (const [name, rows] of Object.entries(input.data ?? {})) {
    if (!out.has(name) && !lists.some((d) => d.name === name && typeof d.source === 'string')) out.set(name, rows)
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
 * scene was accepted under specific budgets (C15/C49).
 */
function metaKeyOf(skeleton: string, input: RuntimeInput): string {
  const parts: string[] = []
  parts.push(`w=${valueKey(input.width)}`, `h=${valueKey(input.height)}`)
  // `containerSize()` is read by the spec's width / height signals: a resized container is a different view
  if (input.containerSize) parts.push(`cs=${valueKey(input.containerSize)}`)
  if (input.measuredSize) parts.push(`ms=${valueKey(input.measuredSize)}`)
  if (input.textMetrics) parts.push(`tm=#${refId(input.textMetrics)}`)
  if (input.limits) parts.push(`lim=${valueKey(input.limits)}`)
  // image urls are vetted while the scene is built: a different policy can reject a scene a looser one accepted
  if (input.urlPolicy) parts.push(`up=${valueKey(input.urlPolicy)}`)
  for (const name of Object.keys(input.domainRaw ?? {}).sort()) {
    parts.push(`d ${name}=${valueKey(input.domainRaw![name])}`)
  }
  for (const name of Object.keys(input.signals ?? {}).sort()) {
    parts.push(`s ${name}=${valueKey(input.signals![name])}`)
  }
  return `${skeleton}\u0000${parts.join('\u0001')}`
}

/** Fingerprint a spec + input for the no-op cache (skeleton + data refs + size/signals). */
function fingerprint(spec: VgSpec, input: RuntimeInput): string {
  const parts: string[] = []
  const skeleton = skeletonOf(spec)
  dataKeyOf(spec, input, parts)
  return `${metaKeyOf(skeleton, input)}\u0000${parts.join('\u0001')}`
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
  let lastPulse: DataPulse | null = null

  const withAutoPulse = (spec: VgSpec, input: RuntimeInput, currentRaw: Map<string, unknown>): { input: RuntimeInput; pulse: DataPulse } => {
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
    if (input.limits) checkSpecLimits(spec as unknown as Record<string, unknown>, input.limits, input)
    clock.check('compile')
    const skeleton = skeletonOf(spec)
    const metaKey = metaKeyOf(skeleton, input)
    const key = fingerprint(spec, input)
    const currentRaw = rawDatasets(spec, input)
    const { input: effectiveInput, pulse } = withAutoPulse(spec, input, currentRaw)
    // An explicit change description (per-datum changeset, pulse, or a named
    // changed dataset) means the data values changed — often in place, so the
    // array identity and thus the fingerprint is unchanged — so the no-op
    // cache must not short-circuit the re-evaluation.
    const hinted = !!input.dataChanges || !!input.dataPulse || !!input.changedDatasets?.length
    if (!hinted && key === lastKey && lastScene) {
      lastRaw = currentRaw
      lastPulse = pulse
      return lastScene
    }
    // New row arrays with identical values are a no-op for the scene: the
    // inferred pulse is empty and everything else matches the previous run.
    if (input.autoChanges !== false && !hinted && !pulse.datasets.size && !pulse.structural.size && metaKey === lastMetaKey && lastScene) {
      lastRaw = currentRaw
      lastPulse = pulse
      lastKey = key
      return lastScene
    }

    // Compute everything into locals and commit only after every check has
    // passed (C16): a limit that throws must leave the session — and the
    // engine's incremental state — exactly as the previous accepted
    // evaluation left them.
    const recompile = skeleton !== lastSkeleton || !lastChart
    const chart = recompile ? compileChart(spec) : lastChart!
    clock.check('compile')
    const pending = evaluateChartPending(chart, { ...effectiveInput, data: dataInput(currentRaw) })
    clock.check('evaluate')
    if (input.limits) checkSceneLimits(pending.scene, input.limits)
    pending.commit()
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

  const changeOnce = (input: RuntimeInput = {}): SceneRoot | null => {
    // Imperative per-datum update of the last compiled chart. No spec re-pass:
    // the host drives changes via data/dataChanges/signals. Requires a prior
    // evaluate (we need a compiled chart + spec to fingerprint against).
    if (!lastChart || !lastSpec || !lastRaw) return null
    const clock = activeMeter()?.clock ?? createLimitClock(input.limits)
    // Start from the data the last evaluation (or change) left behind; the
    // host's `data` overrides win. A datum the host does not mention keeps its
    // current value rather than reverting to the spec's original one.
    const currentRaw = new Map(lastRaw)
    for (const [name, rows] of Object.entries(input.data ?? {})) currentRaw.set(name, rows)
    const { input: effectiveInput, pulse } = withAutoPulse(lastSpec, input, currentRaw)
    const pending = evaluateChartPending(lastChart, { ...effectiveInput, data: dataInput(currentRaw) })
    clock.check('change')
    if (input.limits) checkSceneLimits(pending.scene, input.limits)
    pending.commit()
    lastScene = pending.scene
    // Every key follows the state that was just committed, or the no-op cache
    // would serve a scene built for different inputs (C15).
    lastKey = fingerprint(lastSpec, { ...effectiveInput, data: dataInput(currentRaw) })
    lastMetaKey = metaKeyOf(lastSkeleton, effectiveInput)
    lastRaw = currentRaw
    lastPulse = pulse
    return lastScene
  }

  return {
    evaluate: (spec, input = {}) => withLimits(input.limits, () => evaluateOnce(spec, input)),
    change: (input = {}) => withLimits(input.limits, () => changeOnce(input)),
    last: () => (lastChart && lastScene ? { chart: lastChart, scene: lastScene } : null),
    pulse: () => lastPulse,
  }
}
