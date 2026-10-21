/**
 * Streaming and backpressure (R13).
 *
 * `createChartSession` is pull-based: the host calls `evaluate`/`change` with a
 * snapshot. A live feed is push-based and may arrive faster than the renderer
 * can consume it. `createChartStream` sits between the two:
 *
 * - bounded queue with an explicit backpressure policy (`coalesce`, `drop-oldest`,
 *   `drop-newest`, `error`),
 * - append/replace batches are merged without copying the whole dataset on every
 *   push,
 * - `flush()` delivers an explicit pulse (index mapping + added/removed ranges)
 *   to the runtime, so an appended batch splices scene items instead of
 *   re-evaluating the chart,
 * - `pending()` exposes the pulse that *would* be delivered, and `pulse()`
 *   returns the one from the last flush.
 *
 * The stream owns a `ChartSession` and a spec. It never mutates the spec.
 */
import { createChartSession, type ChartSession } from './session.js'
import { diffRows, type DataPulse, type DatasetPulse, type PulseRange } from './pulse.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

export type StreamPolicy = 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error'

export interface StreamOptions {
  /** Maximum queued batches. Default 32; `coalesce` keeps at most one. */
  capacity?: number
  /** Backpressure policy when the queue is full. Default `coalesce`. */
  policy?: StreamPolicy
  /** Initial input (data/signals/size) used for the first flush. */
  initial?: RuntimeInput
}

export interface StreamPulse {
  changed?: number[]
  from?: number[]
  to?: number[]
  added?: PulseRange[]
  removed?: PulseRange[]
  /** Retained rows keep their index; `baseLength` is the previous row count. */
  appendOnly?: boolean
  baseLength?: number
}

/** Per-dataset explicit pulse offered with a batch. */
export type StreamPulseInput = Record<string, StreamPulse>

export interface StreamBatch {
  /** Full row snapshot per dataset. Diffed against the last flushed snapshot. */
  data?: Record<string, unknown[]>
  /** Rows appended to each dataset's current snapshot. */
  append?: Record<string, unknown[]>
  /**
   * Explicit pulse for this batch. When every queued batch supplies a compatible
   * pulse, `flush` delivers the merged pulse without diffing the snapshots; when
   * they cannot be composed it falls back to a snapshot diff (still correct).
   */
  pulse?: StreamPulseInput
  signals?: Record<string, unknown>
  width?: number
  height?: number
  domainRaw?: Record<string, unknown[]>
}

export interface StreamStats {
  /** Batches currently queued (0 or 1 under `coalesce`). */
  depth: number
  capacity: number
  policy: StreamPolicy
  /** Batches merged into an earlier queued batch (coalesce). */
  coalesced: number
  /** Batches rejected/dropped by backpressure. */
  dropped: number
  /** Successful flushes. */
  flushes: number
}

export interface StreamFlush {
  scene: SceneRoot
  pulse: DataPulse
  /** Batches consumed by this flush. */
  batches: number
  /** True when nothing actually changed (the scene is the previous one). */
  noop: boolean
}

export interface ChartStream {
  /** Enqueue a batch. Returns false when the policy rejected it. */
  push(batch: StreamBatch): boolean
  /** Apply every queued batch and return the resulting scene + pulse. */
  flush(): StreamFlush | null
  /** The pulse that would be delivered if `flush()` ran now. */
  pending(): DataPulse
  /** The pulse delivered by the last flush. */
  pulse(): DataPulse | null
  /** The scene from the last flush (null before the first one). */
  scene(): SceneRoot | null
  stats(): StreamStats
  /** True when the next `push` would be accepted (useful for a producer). */
  canAccept(): boolean
  /** Drop queued batches and stop accepting new ones. */
  close(): void
  /** The underlying session (for `last()`, imperative `change()`, ...). */
  session(): ChartSession
}

export class AsterStreamBackpressureError extends Error {
  constructor(capacity: number) {
    super(`[aster] stream queue full (capacity ${capacity}); apply backpressure or use a drop/coalesce policy`)
    this.name = 'AsterStreamBackpressureError'
  }
}

interface SourceRows {
  get(name: string): unknown[] | undefined
}

function specSourceRows(spec: VgSpec): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  const data = (spec as { data?: unknown }).data
  const defs = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  for (const d of defs) {
    if (!d || typeof d !== 'object') continue
    const rec = d as { name?: unknown; values?: unknown; source?: unknown }
    if (typeof rec.name !== 'string' || typeof rec.source === 'string') continue
    if (Array.isArray(rec.values)) out.set(rec.name, rec.values)
  }
  return out
}

function mergePulse(
  a: StreamPulseInput | undefined,
  b: StreamPulseInput | undefined,
): StreamPulseInput | null {
  if (!a) return b ?? null
  if (!b) return a
  const out: StreamPulseInput = { ...a }
  for (const [name, next] of Object.entries(b)) {
    const prev = out[name]
    if (!prev) { out[name] = next; continue }
    if (prev.appendOnly && next.appendOnly) {
      out[name] = {
        changed: [...new Set([...(prev.changed ?? []), ...(next.changed ?? [])])],
        appendOnly: true,
        baseLength: prev.baseLength,
      }
      continue
    }
    if (prev.appendOnly || next.appendOnly) {
      // An append plus a mapped update: fall back to the snapshot path.
      return null
    }
    // Two same-length pulses over one transition: union the changed indices.
    if (!prev.from && !next.from) {
      out[name] = { changed: [...new Set([...(prev.changed ?? []), ...(next.changed ?? [])])] }
      continue
    }
    if (!prev.from || !next.from) return null
    const from = new Array<number>(next.from.length)
    for (let i = 0; i < from.length; i++) {
      const mid = next.from[i]!
      from[i] = mid < 0 ? -1 : (prev.from[mid] ?? mid)
    }
    const changed = new Set<number>(next.changed ?? [])
    for (const i of prev.changed ?? []) {
      const mapped = next.from[i]
      if (mapped != null && mapped >= 0) changed.add(mapped)
    }
    out[name] = { from, changed: [...changed] }
  }
  return out
}

function rangesFromMapping(from: number[]): PulseRange[] {
  const out: PulseRange[] = []
  for (let i = 0; i < from.length; i++) {
    if (from[i]! >= 0) continue
    const start = i
    while (i + 1 < from.length && from[i + 1]! < 0) i++
    out.push([start, i + 1])
  }
  return out
}

function toMapping(from: number[], oldLen: number): number[] {
  const to = new Array<number>(oldLen).fill(-1)
  for (let i = 0; i < from.length; i++) if (from[i]! >= 0) to[from[i]!] = i
  return to
}

function normalizePulse(p: StreamPulse, oldLen: number): StreamPulse {
  if (p.appendOnly) {
    const base = p.baseLength ?? oldLen
    const added = p.added?.length ? p.added : []
    return { ...p, changed: p.changed ?? [], baseLength: base, added }
  }
  if (p.from) {
    return {
      ...p,
      changed: p.changed ?? [],
      added: p.added ?? rangesFromMapping(p.from),
      removed: p.removed ?? [],
      to: p.to ?? toMapping(p.from, oldLen),
    }
  }
  return { ...p, changed: p.changed ?? [] }
}

export function createChartStream(spec: VgSpec, options: StreamOptions = {}): ChartStream {
  const capacity = Math.max(1, options.capacity ?? 32)
  const policy: StreamPolicy = options.policy ?? 'coalesce'
  const session = createChartSession()
  const specRows = specSourceRows(spec)
  const base = new Map<string, unknown[]>(specRows)
  if (options.initial?.data) for (const [name, rows] of Object.entries(options.initial.data)) base.set(name, rows)
  const owned = new Set<string>()
  let signals: Record<string, unknown> = { ...(options.initial?.signals ?? {}) }
  let width = options.initial?.width
  let height = options.initial?.height
  let domainRaw = options.initial?.domainRaw
  let queue: StreamBatch[] = []
  let lastPulse: DataPulse | null = null
  let lastScene: SceneRoot | null = null
  let closed = false
  const stats: StreamStats = { depth: 0, capacity, policy, coalesced: 0, dropped: 0, flushes: 0 }

  interface Target {
    appendChunks: unknown[][]
    replace?: unknown[]
    explicit: StreamPulse[]
    touched: boolean
  }

  const cloneAppend = (append: Record<string, unknown[]> | undefined): Record<string, unknown[]> | undefined => {
    if (!append) return undefined
    const out: Record<string, unknown[]> = {}
    for (const [name, list] of Object.entries(append)) out[name] = list.slice()
    return out
  }

  /** Merge a batch into the current queue state (coalesce) or append it. */
  const enqueue = (batch: StreamBatch): boolean => {
    if (closed) return false
    if (policy === 'coalesce') {
      if (queue.length) {
        const prev = queue[0]!
        const append: Record<string, unknown[]> = { ...(prev.append ?? {}) }
        for (const [name, list] of Object.entries(batch.append ?? {})) {
          const cur = append[name]
          if (cur) cur.push(...list)
          else append[name] = list.slice()
        }
        queue[0] = {
          data: { ...(prev.data ?? {}), ...(batch.data ?? {}) },
          append,
          pulse: mergePulse(prev.pulse, batch.pulse) ?? undefined,
          signals: { ...(prev.signals ?? {}), ...(batch.signals ?? {}) },
          width: batch.width ?? prev.width,
          height: batch.height ?? prev.height,
          domainRaw: { ...(prev.domainRaw ?? {}), ...(batch.domainRaw ?? {}) },
        }
        stats.coalesced++
        stats.depth = 1
        return true
      }
      queue.push({ ...batch, append: cloneAppend(batch.append) })
      stats.depth = 1
      return true
    }
    if (queue.length >= capacity) {
      if (policy === 'drop-newest') { stats.dropped++; return false }
      if (policy === 'error') throw new AsterStreamBackpressureError(capacity)
      // drop-oldest: make room by discarding whole batches.
      while (queue.length >= capacity) { queue.shift(); stats.dropped++ }
    }
    queue.push({ ...batch, append: cloneAppend(batch.append) })
    stats.depth = queue.length
    return true
  }

  const planTargets = (batches: StreamBatch[]): Map<string, Target> => {
    const targets = new Map<string, Target>()
    const get = (name: string): Target => {
      let t = targets.get(name)
      if (!t) targets.set(name, (t = { appendChunks: [], explicit: [], touched: false }))
      return t
    }
    for (const b of batches) {
      for (const [name, list] of Object.entries(b.append ?? {})) {
        const t = get(name)
        t.appendChunks.push(list)
        t.touched = true
      }
      for (const [name, list] of Object.entries(b.data ?? {})) {
        const t = get(name)
        t.replace = list
        t.appendChunks = []
        t.touched = true
      }
      for (const [name, p] of Object.entries(b.pulse ?? {})) {
        const t = get(name)
        t.explicit.push(p)
        t.touched = true
      }
    }
    return targets
  }

  const chunkLength = (t: Target): number => {
    let n = 0
    for (const c of t.appendChunks) n += c.length
    return n
  }

  const explicitFor = (t: Target): StreamPulse | null => {
    if (!t.explicit.length) return null
    let merged: StreamPulseInput | null = { }
    for (const p of t.explicit) {
      merged = mergePulse(merged, { __one: p })
      if (!merged) return null
    }
    return merged?.__one ?? null
  }

  const finalLength = (t: Target, oldLen: number): number =>
    (t.replace !== undefined ? t.replace.length : oldLen) + chunkLength(t)

  /** Resolve one target's pulse without materialising appended rows. */
  const targetPulse = (name: string, t: Target): { pulse: StreamPulse | null; oldLen: number; newLen: number; final?: unknown[] } => {
    const old = base.get(name)
    const oldLen = old?.length ?? 0
    const newLen = finalLength(t, oldLen)
    if (t.replace !== undefined) {
      const final = t.appendChunks.length
        ? [...t.replace, ...t.appendChunks.flat()]
        : t.replace
      const explicit = explicitFor(t)
      if (explicit) {
        const norm = normalizePulse(explicit, oldLen)
        return { pulse: norm, oldLen, newLen, final }
      }
      if (!old) return { pulse: null, oldLen, newLen, final }
      const diff = diffRows(old, final)
      if (!diff) return { pulse: null, oldLen, newLen, final }
      return {
        pulse: {
          changed: diff.changed,
          ...(diff.from ? { from: diff.from } : {}),
          ...(diff.to ? { to: diff.to } : {}),
          ...(diff.addedRanges ? { added: diff.addedRanges } : {}),
          ...(diff.removedRanges ? { removed: diff.removedRanges } : {}),
          ...(diff.appendOnly ? { appendOnly: true, baseLength: diff.baseLength } : {}),
        },
        oldLen, newLen, final,
      }
    }
    const explicit = explicitFor(t)
    if (explicit?.appendOnly) {
      return {
        pulse: {
          changed: explicit.changed ?? [],
          appendOnly: true,
          baseLength: oldLen,
          ...(newLen > oldLen ? { added: [[oldLen, newLen]] as PulseRange[] } : {}),
        },
        oldLen, newLen,
      }
    }
    if (explicit?.from) {
      const norm = normalizePulse(explicit, oldLen)
      if (norm.from && norm.from.length === newLen) return { pulse: norm, oldLen, newLen }
    }
    if (explicit && newLen === oldLen) return { pulse: normalizePulse(explicit, oldLen), oldLen, newLen }
    if (newLen === oldLen) return { pulse: null, oldLen, newLen }
    return {
      pulse: { changed: [], appendOnly: true, baseLength: oldLen, added: [[oldLen, newLen]] },
      oldLen, newLen,
    }
  }

  const oldLength = (pulse: StreamPulse): number => pulse.baseLength ?? (pulse.from ? pulse.from.length : 0)

  const toDataPulse = (targets: Map<string, Target>): { pulse: DataPulse; lengths: Map<string, number> } => {
    const datasets = new Map<string, DatasetPulse>()
    const structural = new Set<string>()
    const lengths = new Map<string, number>()
    for (const [name, t] of targets) {
      if (!t.touched) continue
      const { pulse, newLen } = targetPulse(name, t)
      lengths.set(name, newLen)
      if (!pulse) { structural.add(name); continue }
      const changed = pulse.changed ?? []
      const addedRanges = pulse.added ?? []
      const lengthChanging = pulse.from != null || (pulse.removed?.length ?? 0) > 0
        || (addedRanges.length > 0 && (pulse.baseLength ?? oldLength(pulse)) !== newLen)
      if (!changed.length && !addedRanges.length && !lengthChanging) continue
      if (lengthChanging) structural.add(name)
      datasets.set(name, {
        name,
        changed,
        sameLength: !lengthChanging,
        added: pulse.added?.[0] ?? null,
        removed: pulse.removed?.[0] ?? null,
        ...(pulse.from ? { from: pulse.from } : {}),
        ...(pulse.to ? { to: pulse.to } : {}),
        ...(pulse.added?.length ? { addedRanges: pulse.added } : {}),
        ...(pulse.removed?.length ? { removedRanges: pulse.removed } : {}),
        ...(pulse.appendOnly ? { appendOnly: true, baseLength: pulse.baseLength } : {}),
      })
    }
    return { pulse: { datasets, structural }, lengths }
  }

  const stream: ChartStream = {
    push(batch) {
      return enqueue(batch)
    },
    flush() {
      // An empty first flush primes the stream's scene from the spec/initial
      // snapshot; after that an empty flush is a no-op.
      if (closed || (!queue.length && lastScene)) return null
      const batches = queue
      queue = []
      stats.depth = 0
      const targets = planTargets(batches)
      const { pulse, lengths } = toDataPulse(targets)
      const changedDatasets = [...pulse.structural]
      const dataPulse: NonNullable<RuntimeInput['dataPulse']> = {}
      const dataChanges: Record<string, number[]> = {}
      for (const [name, p] of pulse.datasets) {
        if (p.sameLength) dataChanges[name] = p.changed
        else {
          dataPulse[name] = {
            changed: p.changed,
            ...(p.from ? { from: p.from } : {}),
            ...(p.to ? { to: p.to } : {}),
            ...(p.addedRanges ? { added: p.addedRanges } : {}),
            ...(p.removedRanges ? { removed: p.removedRanges } : {}),
            ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
          }
        }
      }
      // Materialise queued appends now, at flush time (never per push). A base
      // array that came from the spec/host is copied once, then mutated in
      // place so repeated appends are O(appended).
      for (const [name, t] of targets) {
        if (!t.touched) continue
        if (t.replace !== undefined) {
          let arr = t.replace
          if (t.appendChunks.length) {
            arr = [...t.replace]
            for (const c of t.appendChunks) for (const r of c) arr.push(r as never)
            owned.add(name)
          } else {
            owned.delete(name)
          }
          base.set(name, arr)
        } else if (t.appendChunks.length) {
          let arr = base.get(name) ?? []
          if (!owned.has(name)) { arr = arr.slice(); owned.add(name) }
          for (const c of t.appendChunks) for (const r of c) arr.push(r as never)
          base.set(name, arr)
        }
        void lengths
      }
      // Keep the latest values from every batch.
      for (const b of batches) {
        if (b.signals) signals = { ...signals, ...b.signals }
        if (b.width != null) width = b.width
        if (b.height != null) height = b.height
        if (b.domainRaw) domainRaw = { ...(domainRaw ?? {}), ...b.domainRaw }
      }
      const input: RuntimeInput = {
        data: Object.fromEntries(base),
        ...(Object.keys(signals).length ? { signals } : {}),
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        ...(domainRaw ? { domainRaw } : {}),
        ...(Object.keys(dataPulse).length ? { dataPulse } : {}),
        ...(Object.keys(dataChanges).length ? { dataChanges } : {}),
        ...(changedDatasets.length ? { changedDatasets } : {}),
      }
      const scene = session.evaluate(spec, input)
      const delivered = session.pulse() ?? pulse
      const noop = !delivered.datasets.size && !delivered.structural.size && scene === lastScene
      lastScene = scene
      lastPulse = delivered
      stats.flushes++
      return { scene, pulse: delivered, batches: batches.length, noop }
    },
    pending() {
      return toDataPulse(planTargets(queue)).pulse
    },
    pulse: () => lastPulse,
    scene: () => lastScene,
    stats: () => ({ ...stats }),
    canAccept() {
      if (closed) return false
      if (policy === 'coalesce' || policy === 'drop-oldest') return true
      return queue.length < capacity
    },
    close() {
      closed = true
      queue = []
      stats.depth = 0
    },
    session: () => session,
  }
  return stream
}
