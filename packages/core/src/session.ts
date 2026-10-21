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
import { evaluateChart } from './runtime.js'
import { checkSpecLimits, checkSceneLimits, createLimitClock } from './limits.js'
import { diffRows, type DataPulse } from './pulse.js'
import type { CompiledChart, RuntimeInput, SceneRoot, VgSpec } from './types.js'

const REF_IDS = new WeakMap<object, number>()
let REF_SEQ = 0

function refId(v: unknown): number {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return -1
  let id = REF_IDS.get(v as object)
  if (id === undefined) {
    id = ++REF_SEQ
    REF_IDS.set(v as object, id)
  }
  return id
}

/** Serialize the spec structure, leaving dataset values out (they're tracked by identity). */
function skeletonOf(spec: VgSpec): string {
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
    return `\u0000uncacheable:${refId(spec)}:${Date.now()}`
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
    const override = input.data?.[d.name]
    const vals = override ?? d.values
    if (vals == null) continue
    out.push(`${d.name}:${refId(vals)}`)
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
    const override = input.data?.[d.name]
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

/** Copy inline dataset values from a fresh spec into a structurally-identical compiled chart. */
function syncValues(chart: CompiledChart, spec: VgSpec): void {
  const data = (spec as { data?: unknown }).data
  const specs: Array<Record<string, unknown>> = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : data && typeof data === 'object'
      ? [data as Record<string, unknown>]
      : []
  for (const s of specs) {
    if (typeof s.name !== 'string') continue
    const compiled = chart.data.find((d) => d.name === s.name)
    if (compiled) compiled.values = s.values as unknown[] | undefined
  }
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

/** Non-data input fingerprint (skeleton + size/signals/domain overrides). */
function metaKeyOf(skeleton: string, input: RuntimeInput): string {
  const parts: string[] = []
  parts.push(`w=${input.width ?? ''}`, `h=${input.height ?? ''}`)
  if (input.textMetrics) parts.push(`tm=#${refId(input.textMetrics)}`)
  for (const name of Object.keys(input.domainRaw ?? {}).sort()) {
    parts.push(`d ${name}=${JSON.stringify(input.domainRaw![name])}`)
  }
  for (const name of Object.keys(input.signals ?? {}).sort()) {
    const v = input.signals![name]
    parts.push(
      typeof v === 'object' || typeof v === 'function' ? `s ${name}=#${refId(v)}` : `s ${name}=${String(v)}`,
    )
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
      const sameLength: Record<string, number[]> = {}
      for (const [name, p] of Object.entries(input.dataPulse)) {
        if (!p.from) sameLength[name] = p.changed ?? []
        else structural.add(name)
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
          ...(structural.size ? { changedDatasets: [...structural] } : {}),
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
    const changes: Record<string, number[]> = {}
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
        ...(changedDatasets.length ? { changedDatasets } : {}),
      },
      pulse,
    }
  }

  return {
    evaluate(spec, input = {}) {
      const clock = createLimitClock(input.limits)
      if (input.limits) checkSpecLimits(spec as unknown as Record<string, unknown>, input.limits)
      clock.check('compile')
      const skeleton = skeletonOf(spec)
      const metaKey = metaKeyOf(skeleton, input)
      const key = fingerprint(spec, input)
      const currentRaw = rawDatasets(spec, input)
      const { input: effectiveInput, pulse } = withAutoPulse(spec, input, currentRaw)
      // A per-datum changeset implies the data values changed (often in place, so
      // the array identity — and thus the fingerprint — is unchanged), so the
      // no-op cache must not short-circuit the differential re-evaluation.
      if (!input.dataChanges && !input.dataPulse && key === lastKey && lastScene) {
        lastRaw = currentRaw
        lastPulse = pulse
        return lastScene
      }
      // New row arrays with identical values are a no-op for the scene: the
      // inferred pulse is empty and everything else matches the previous run.
      if (input.autoChanges !== false && !input.dataChanges && !input.dataPulse && !pulse.datasets.size && !pulse.structural.size && metaKey === lastMetaKey && lastScene) {
        lastRaw = currentRaw
        lastPulse = pulse
        lastKey = key
        return lastScene
      }

      if (skeleton !== lastSkeleton || !lastChart) {
        lastChart = compileChart(spec)
        lastSkeleton = skeleton
      } else {
        // Same structure, different data: the compiled IR carries the previous
        // spec's value references — point it at the current ones before evaluating.
        syncValues(lastChart, spec)
      }
      lastSpec = spec
      clock.check('compile')
      lastScene = evaluateChart(lastChart, effectiveInput)
      clock.check('evaluate')
      if (input.limits) checkSceneLimits(lastScene, input.limits)
      lastKey = key
      lastMetaKey = metaKey
      lastRaw = currentRaw
      lastPulse = pulse
      return lastScene
    },
    change(input = {}) {
      // Imperative per-datum update of the last compiled chart. No spec re-pass:
      // the host drives changes via data/dataChanges/signals. Requires a prior
      // evaluate (we need a compiled chart + spec to fingerprint against).
      if (!lastChart || !lastSpec) return null
      const clock = createLimitClock(input.limits)
      const currentRaw = rawDatasets(lastSpec, input)
      const { input: effectiveInput, pulse } = withAutoPulse(lastSpec, input, currentRaw)
      lastScene = evaluateChart(lastChart, effectiveInput)
      clock.check('change')
      lastKey = fingerprint(lastSpec, effectiveInput)
      lastRaw = currentRaw
      lastPulse = pulse
      return lastScene
    },
    last: () => (lastChart && lastScene ? { chart: lastChart, scene: lastScene } : null),
    pulse: () => lastPulse,
  }
}
