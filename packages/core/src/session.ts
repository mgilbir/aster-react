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
}

/** Fingerprint a spec + input for the no-op cache (skeleton + data refs + size/signals). */
function fingerprint(spec: VgSpec, input: RuntimeInput): string {
  const parts: string[] = []
  const skeleton = skeletonOf(spec)
  dataKeyOf(spec, input, parts)
  parts.push(`w=${input.width ?? ''}`, `h=${input.height ?? ''}`)
  for (const name of Object.keys(input.signals ?? {}).sort()) {
    const v = input.signals![name]
    parts.push(
      typeof v === 'object' || typeof v === 'function' ? `s ${name}=#${refId(v)}` : `s ${name}=${String(v)}`,
    )
  }
  return `${skeleton}\u0000${parts.join('\u0001')}`
}

export function createChartSession(): ChartSession {
  let lastKey = ''
  let lastSkeleton = ''
  let lastChart: CompiledChart | null = null
  let lastScene: SceneRoot | null = null
  let lastSpec: VgSpec | null = null

  return {
    evaluate(spec, input = {}) {
      const skeleton = skeletonOf(spec)
      const key = fingerprint(spec, input)
      // A per-datum changeset implies the data values changed (often in place, so
      // the array identity — and thus the fingerprint — is unchanged), so the
      // no-op cache must not short-circuit the differential re-evaluation.
      if (!input.dataChanges && key === lastKey && lastScene) return lastScene

      if (skeleton !== lastSkeleton || !lastChart) {
        lastChart = compileChart(spec)
        lastSkeleton = skeleton
      } else {
        // Same structure, different data: the compiled IR carries the previous
        // spec's value references — point it at the current ones before evaluating.
        syncValues(lastChart, spec)
      }
      lastSpec = spec
      lastScene = evaluateChart(lastChart, input)
      lastKey = key
      return lastScene
    },
    change(input = {}) {
      // Imperative per-datum update of the last compiled chart. No spec re-pass:
      // the host drives changes via data/dataChanges/signals. Requires a prior
      // evaluate (we need a compiled chart + spec to fingerprint against).
      if (!lastChart || !lastSpec) return null
      lastScene = evaluateChart(lastChart, input)
      lastKey = fingerprint(lastSpec, input)
      return lastScene
    },
    last: () => (lastChart && lastScene ? { chart: lastChart, scene: lastScene } : null),
  }
}
