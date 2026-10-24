/**
 * Streaming and backpressure (R13).
 *
 * `createChartSession` is pull-based: the host calls `evaluate`/`change` with a
 * snapshot. A live feed is push-based and may arrive faster than the renderer
 * can consume it. `createChartStream` sits between the two:
 *
 * - bounded queue with an explicit backpressure policy (`coalesce`, `drop-oldest`,
 *   `drop-newest`, `error`); the bound is on queued batches AND queued rows
 *   (see `StreamOptions.capacity` / `maxQueuedRows`),
 * - append/replace batches are folded in the order they were pushed (snapshot,
 *   then append, then pulse, then signals/size/domainRaw/limits) without copying
 *   the whole dataset on every push,
 * - a flush is atomic: if evaluation throws, the queue, the committed rows,
 *   signals, size and overrides are exactly as before the flush,
 * - `flush()` delivers an explicit pulse (index mapping + added/removed ranges)
 *   to the runtime, so an appended batch splices scene items instead of
 *   re-evaluating the chart,
 * - `pending()` exposes the pulse that *would* be delivered, and `pulse()`
 *   returns the one from the last flush.
 *
 * The stream owns a `ChartSession` and a spec. It never mutates the spec.
 */
import { createChartSession, type ChartSession } from './session.js'
import { dict } from './util.js'
import { diffRows, type DataPulse, type DatasetPulse, type PulseRange } from './pulse.js'
import { AsterLimitError, type SpecLimits } from './limits.js'
import type { TextMetricsProvider } from './text-metrics.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

export type StreamPolicy = 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error'

export interface StreamOptions {
  /**
   * Maximum queued BATCHES for `drop-oldest`/`drop-newest`/`error` (default 32).
   * `coalesce` folds everything into one queued batch, so it always holds 1; its
   * memory is bounded by `maxQueuedRows` instead (`stats().capacity` reports 1).
   */
  capacity?: number
  /**
   * Maximum queued ROWS (snapshot rows plus appended rows waiting for a flush),
   * across all datasets and under every policy. Default 5,000,000. A push that
   * would exceed it is handled by the policy: `drop-newest` and `coalesce`
   * reject it (`push` returns false, counted in `stats().dropped`; `coalesce`
   * never discards already queued data to make room), `drop-oldest` discards
   * whole oldest batches until it fits, `error` throws
   * `AsterStreamBackpressureError`. A single batch larger than the bound is
   * always rejected. Rows already flushed are the host's data, not queue memory.
   */
  maxQueuedRows?: number
  /** Backpressure policy when the queue is full. Default `coalesce`. */
  policy?: StreamPolicy
  /** Initial input (data/signals/size) used for the first flush. */
  initial?: RuntimeInput
  /**
   * Budgets applied to every flush (same enforcement as `createChartSession`,
   * plus `maxRows` over the rows the stream holds). Overrides `initial.limits`;
   * a batch's `limits` replaces it for later flushes.
   */
  limits?: SpecLimits
  /** Host text measurement for every flush; overrides `initial.textMetrics`. */
  textMetrics?: TextMetricsProvider
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
  /**
   * Scale-domain overrides, merged into the stream's current overrides. A
   * `null` value clears that scale's override (back to the data-derived
   * domain), which is how a host resets a pan/zoom view.
   */
  domainRaw?: Record<string, unknown[] | null>
  /** Replace the budgets applied to every later flush. */
  limits?: SpecLimits
  /** Replace the host text measurement used by every later flush. */
  textMetrics?: TextMetricsProvider
}

export interface StreamStats {
  /** Batches currently queued (0 or 1 under `coalesce`). */
  depth: number
  /** Batch bound: the `capacity` option, or 1 under `coalesce` (one folded batch). */
  capacity: number
  /** Rows currently queued (snapshot rows plus appended rows). */
  queuedRows: number
  /** Row bound (`maxQueuedRows`); this is what bounds `coalesce` memory. */
  maxQueuedRows: number
  policy: StreamPolicy
  /** Batches merged into an earlier queued batch (coalesce). */
  coalesced: number
  /** Batches rejected/dropped by backpressure (batch or row bound). */
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
  /**
   * Producer-side hint: true when a small push would be accepted now, i.e. both
   * the batch bound and the row bound have room (always true for `drop-oldest`
   * unless closed, since it makes room). A batch larger than the remaining row
   * room is still refused by the policy.
   */
  canAccept(): boolean
  /**
   * Release the queue, the committed base rows, the last scene and the session.
   * Afterwards `push` returns false, `flush` returns null, `scene()`/`pulse()`
   * are null and `session()` throws `AsterStreamClosedError`. Idempotent.
   */
  close(): void
  /**
   * Recovery after a failed flush: drop every queued batch, return how many were
   * dropped, and count them in `stats().dropped`. A failed flush is atomic (the
   * failing batches stay queued), so without this a bad batch would fail every
   * later flush. The failing batch cannot be isolated (the queue is folded), so
   * all queued batches go. Never touches committed rows or the last scene.
   */
  discard(): number
  /** The underlying session (for `last()`, imperative `change()`, ...). Throws after `close()`. */
  session(): ChartSession
}

export class AsterStreamBackpressureError extends Error {
  /** Stable machine-readable code; survives structured clone and the worker boundary. */
  readonly code = 'ASTER_STREAM_BACKPRESSURE'
  /** Which bound was hit: queued batches or queued rows. */
  readonly bound: 'batches' | 'rows'
  /** The configured bound (`capacity` batches or `maxQueuedRows` rows). */
  readonly limit: number
  constructor(limit: number, bound: 'batches' | 'rows' = 'batches') {
    super(
      bound === 'batches'
        ? `[aster] stream queue full (capacity ${limit}); apply backpressure or use a drop/coalesce policy`
        : `[aster] stream queue full (maxQueuedRows ${limit}); flush before pushing more rows`,
    )
    this.name = 'AsterStreamBackpressureError'
    this.bound = bound
    this.limit = limit
  }
}

/** What a failed `flush()` left queued; see `getStreamFlushFailure`. */
export interface StreamFlushFailure {
  /** Batches still queued (all of them took part in the failed flush; coalesce counts 1). */
  batches: number
  /** Rows still queued. */
  queuedRows: number
}

const FLUSH_FAILURES = new WeakMap<object, StreamFlushFailure>()

/**
 * Info about a failed `flush()`, or undefined for any other error. The original
 * error (e.g. `AsterLimitError`) is rethrown unchanged, so `instanceof`/`code`
 * checks keep working; the queue is intact, so call `stream.discard()` to recover.
 */
export function getStreamFlushFailure(err: unknown): StreamFlushFailure | undefined {
  return err != null && typeof err === 'object' ? FLUSH_FAILURES.get(err) : undefined
}

/** Thrown by `stream.session()` after `close()`. `push`/`flush` after close are documented no-ops. */
export class AsterStreamClosedError extends Error {
  readonly code = 'ASTER_STREAM_CLOSED'
  constructor() {
    super('[aster] stream is closed')
    this.name = 'AsterStreamClosedError'
  }
}

const DEFAULT_CAPACITY = 32
const DEFAULT_MAX_QUEUED_ROWS = 5_000_000

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

// ---------------------------------------------------------------------------
// Folding queued batches
//
// A queue of batches is folded IN ORDER into one `Fold`. Per batch and dataset
// the order is: snapshot (`data`), then `append`, then the explicit `pulse`;
// signals/size/domainRaw/limits/textMetrics are last-writer-wins. Folding the
// queue must equal applying the batches one at a time, so each dataset tracks:
//
//  - the final rows (`replace` snapshot + appended `chunks`, never copied per push),
//  - how those rows relate to the committed base, as a `mode`:
//      known  every folded step had a known row mapping (plain appends, explicit
//             pulses) and they are composed: `from` (new index -> base index, -1
//             for a new row; null = base rows keep their index and new rows
//             follow) plus the set of `changed` retained rows,
//      diff   a snapshot arrived without a pulse, so the transition is the
//             snapshot diff against the base (an earlier explicit pulse is cleared),
//      full   the transition cannot be described (an explicit pulse that does not
//             compose, or in-place edits that a snapshot diff could not see): the
//             dataset is re-derived (`changedDatasets`), always correct.
// ---------------------------------------------------------------------------

type Mode = 'known' | 'diff' | 'full'

interface Target {
  /** Rows in the committed base when the dataset was first touched (the base is immutable until a flush commits). */
  baseLen: number
  /** Row count after the folded batches. */
  len: number
  replace?: unknown[]
  chunks: unknown[][]
  /** Snapshot rows + appended rows queued for this dataset (queue memory). */
  rows: number
  mode: Mode
  from: number[] | null
  changed: Set<number>
  /** An explicit pulse reported in-place edits; a snapshot diff alone cannot be trusted afterwards. */
  inPlace: boolean
  /** Final rows, built lazily (only when a diff or the commit needs them). */
  final?: unknown[]
  finalOwned?: boolean
}

interface Fold {
  targets: Map<string, Target>
  rows: number
  signals?: Record<string, unknown>
  width?: number
  height?: number
  /** `null` clears that scale's override. */
  domainRaw?: Record<string, unknown[] | null>
  limits?: SpecLimits
  textMetrics?: TextMetricsProvider
}

const newFold = (): Fold => ({ targets: new Map(), rows: 0 })

const has = (o: object | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k)

function checkBatch(batch: StreamBatch): void {
  if (batch == null || typeof batch !== 'object') throw new TypeError('[aster] stream batch must be an object')
  for (const [field, rec] of [['data', batch.data], ['append', batch.append]] as const) {
    if (rec == null) continue
    for (const [name, list] of Object.entries(rec)) {
      if (!Array.isArray(list)) throw new TypeError(`[aster] stream batch.${field}.${name} must be an array`)
    }
  }
}

/** Rows a batch adds to the queue once folded onto `fold` (snapshots replace what was queued). */
function rowDelta(fold: Fold | null, batch: StreamBatch): number {
  let delta = 0
  const names = new Set<string>([...Object.keys(batch.data ?? {}), ...Object.keys(batch.append ?? {})])
  for (const name of names) {
    const cur = fold?.targets.get(name)?.rows ?? 0
    const snap = batch.data && has(batch.data, name) ? batch.data[name]!.length : cur
    delta += snap + (batch.append && has(batch.append, name) ? batch.append[name]!.length : 0) - cur
  }
  return delta
}

/** Composition of an explicit pulse onto the dataset's current known transition. */
function compose(t: Target, p: StreamPulse, preLen: number): boolean {
  const newLen = t.len
  const incoming = p.changed ?? []
  if (p.from) {
    if (p.from.length !== newLen) return false
    const nf = new Array<number>(newLen)
    for (let i = 0; i < newLen; i++) {
      const q = p.from[i]!
      if (q < 0) { nf[i] = -1; continue }
      if (q >= preLen) return false
      nf[i] = t.from ? t.from[q]! : q < t.baseLen ? q : -1
    }
    const nc = new Set<number>()
    if (t.changed.size) for (let i = 0; i < newLen; i++) { const q = p.from[i]!; if (q >= 0 && t.changed.has(q)) nc.add(i) }
    for (const c of incoming) {
      if (!(c >= 0 && c < newLen)) return false
      nc.add(c)
    }
    t.from = nf
    t.changed = nc
    return true
  }
  // No mapping: retained rows keep their index, rows past the previous length are new.
  if (newLen < preLen) return false
  if (p.appendOnly && p.baseLength != null && p.baseLength !== preLen) return false
  for (const c of incoming) {
    if (!(c >= 0 && c < newLen)) return false
    if (c < preLen) t.changed.add(c)
  }
  return true
}

function foldBatch(fold: Fold, batch: StreamBatch, baseLenOf: (name: string) => number): void {
  const names = new Set<string>([
    ...Object.keys(batch.data ?? {}), ...Object.keys(batch.append ?? {}), ...Object.keys(batch.pulse ?? {}),
  ])
  for (const name of names) {
    let t = fold.targets.get(name)
    if (!t) {
      const baseLen = baseLenOf(name)
      fold.targets.set(name, (t = { baseLen, len: baseLen, chunks: [], rows: 0, mode: 'known', from: null, changed: new Set(), inPlace: false }))
    }
    const preLen = t.len
    const snapshot = batch.data && has(batch.data, name) ? batch.data[name]! : undefined
    const appended = batch.append && has(batch.append, name) ? batch.append[name]! : undefined
    const pulse = batch.pulse && has(batch.pulse, name) ? batch.pulse[name] : undefined
    if (snapshot) {
      fold.rows += snapshot.length - t.rows
      t.replace = snapshot
      t.chunks = []
      t.rows = snapshot.length
      t.len = snapshot.length
      t.final = undefined
    }
    if (appended?.length) {
      t.chunks.push(appended)
      t.rows += appended.length
      fold.rows += appended.length
      t.len += appended.length
      t.final = undefined
    }
    if (pulse) {
      const hasChanges = !!(pulse.changed?.length)
      if (t.mode === 'known') {
        if (!compose(t, pulse, preLen)) t.mode = 'full'
      } else if (hasChanges) {
        // In-place edits on top of a snapshot diff: re-derive the dataset.
        t.mode = 'full'
      }
      if (hasChanges) t.inPlace = true
    } else if (snapshot) {
      // A snapshot without a pulse clears every earlier explicit pulse: the
      // transition is the snapshot diff, unless earlier in-place edits make a
      // diff against the (already mutated) base untrustworthy.
      if (t.mode === 'known') t.mode = t.inPlace ? 'full' : 'diff'
      t.from = null
      t.changed = new Set()
    }
    // Growth keeps the mapping aligned with the rows (no-op for identity).
    if (t.mode === 'known' && t.from && t.from.length < t.len) {
      for (let i = t.from.length; i < t.len; i++) t.from.push(-1)
    }
  }
  if (batch.signals) fold.signals = dict(fold.signals, batch.signals)
  if (batch.width != null) fold.width = batch.width
  if (batch.height != null) fold.height = batch.height
  if (batch.domainRaw) fold.domainRaw = dict(fold.domainRaw, batch.domainRaw)
  if (batch.limits) fold.limits = batch.limits
  if (batch.textMetrics) fold.textMetrics = batch.textMetrics
}

export function createChartStream(spec: VgSpec, options: StreamOptions = {}): ChartStream {
  const policy: StreamPolicy = options.policy ?? 'coalesce'
  const batchCapacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY)
  const maxQueuedRows = Math.max(1, options.maxQueuedRows ?? DEFAULT_MAX_QUEUED_ROWS)
  // Under coalesce the whole queue is one folded batch: that is its real bound.
  const capacity = policy === 'coalesce' ? 1 : batchCapacity
  let session: ChartSession | null = createChartSession()
  const base = new Map<string, unknown[]>(specSourceRows(spec))
  if (options.initial?.data) for (const [name, rows] of Object.entries(options.initial.data)) base.set(name, rows)
  const owned = new Set<string>()
  let signals: Record<string, unknown> = dict(options.initial?.signals)
  let width = options.initial?.width
  let height = options.initial?.height
  let domainRaw: Record<string, unknown[]> | undefined = options.initial?.domainRaw
  let limits = options.limits ?? options.initial?.limits
  let textMetrics = options.textMetrics ?? options.initial?.textMetrics
  /** coalesce: the single folded batch. */
  let fold: Fold | null = null
  /** other policies: whole batches in push order. */
  let queue: Array<{ batch: StreamBatch; rows: number }> = []
  let queuedRows = 0
  let lastPulse: DataPulse | null = null
  let lastScene: SceneRoot | null = null
  let closed = false
  const stats = { coalesced: 0, dropped: 0, flushes: 0 }

  const baseLenOf = (name: string): number => base.get(name)?.length ?? 0
  const hasQueue = (): boolean => (policy === 'coalesce' ? fold != null : queue.length > 0)
  const depth = (): number => (policy === 'coalesce' ? (fold ? 1 : 0) : queue.length)
  const rowsQueued = (): number => (policy === 'coalesce' ? fold?.rows ?? 0 : queuedRows)

  const cloneAppend = (append: Record<string, unknown[]> | undefined): Record<string, unknown[]> | undefined => {
    if (!append) return undefined
    const out = dict<unknown[]>()
    for (const [name, list] of Object.entries(append)) out[name] = list.slice()
    return out
  }
  const batchRows = (b: StreamBatch): number => {
    let n = 0
    for (const l of Object.values(b.data ?? {})) n += l.length
    for (const l of Object.values(b.append ?? {})) n += l.length
    return n
  }

  /** The queue as one fold (coalesce: the live one; others: folded on demand). */
  const currentFold = (): Fold => {
    if (policy === 'coalesce') return fold ?? newFold()
    const f = newFold()
    for (const e of queue) foldBatch(f, e.batch, baseLenOf)
    return f
  }

  const reject = (bound: 'batches' | 'rows', limit: number): false => {
    if (policy === 'error') throw new AsterStreamBackpressureError(limit, bound)
    stats.dropped++
    return false
  }

  const enqueue = (batch: StreamBatch): boolean => {
    if (closed) return false
    checkBatch(batch)
    const owned_ = { ...batch, append: cloneAppend(batch.append) }
    if (policy === 'coalesce') {
      if (rowDelta(fold, owned_) + (fold?.rows ?? 0) > maxQueuedRows) return reject('rows', maxQueuedRows)
      if (fold) stats.coalesced++
      foldBatch((fold ??= newFold()), owned_, baseLenOf)
      return true
    }
    const rows = batchRows(owned_)
    if (rows > maxQueuedRows) return reject('rows', maxQueuedRows)
    while (queue.length >= batchCapacity || queuedRows + rows > maxQueuedRows) {
      if (policy !== 'drop-oldest') {
        return reject(queue.length >= batchCapacity ? 'batches' : 'rows', queue.length >= batchCapacity ? batchCapacity : maxQueuedRows)
      }
      // drop-oldest: make room by discarding whole batches.
      const gone = queue.shift()!
      queuedRows -= gone.rows
      stats.dropped++
    }
    queue.push({ batch: owned_, rows })
    queuedRows += rows
    return true
  }

  /** Final rows of a dataset (snapshot + appended chunks) when they are not just the base. */
  const finalRows = (t: Target): unknown[] | undefined => {
    if (t.final) return t.final
    if (t.replace === undefined) return undefined
    if (!t.chunks.length) return (t.final = t.replace)
    const out = t.replace.slice()
    for (const c of t.chunks) for (let i = 0; i < c.length; i++) out.push(c[i])
    t.finalOwned = true
    return (t.final = out)
  }

  /** The pulse for one dataset, or null when it must be re-derived (structural, no pulse). */
  const targetPulse = (name: string, t: Target): StreamPulse | null => {
    if (t.mode === 'full') return null
    if (t.mode === 'diff') {
      const old = base.get(name)
      if (!old) return null
      const diff = diffRows(old, finalRows(t))
      if (!diff) return null
      return {
        changed: diff.changed,
        ...(diff.from ? { from: diff.from } : {}),
        ...(diff.to ? { to: diff.to } : {}),
        ...(diff.addedRanges ? { added: diff.addedRanges } : {}),
        ...(diff.removedRanges ? { removed: diff.removedRanges } : {}),
        ...(diff.appendOnly ? { appendOnly: true, baseLength: diff.baseLength } : {}),
      }
    }
    const changed = [...t.changed].sort((a, b) => a - b)
    if (!t.from) {
      if (t.len === t.baseLen) return { changed }
      return { changed, appendOnly: true, baseLength: t.baseLen, added: [[t.baseLen, t.len]] }
    }
    const to = toMapping(t.from, t.baseLen)
    return { changed, from: t.from, to, added: rangesFromMapping(t.from), removed: rangesFromMapping(to) }
  }

  const planPulse = (f: Fold): { pulse: DataPulse; lengths: Map<string, number> } => {
    const datasets = new Map<string, DatasetPulse>()
    const structural = new Set<string>()
    const lengths = new Map<string, number>()
    for (const [name, t] of f.targets) {
      lengths.set(name, t.len)
      const pulse = targetPulse(name, t)
      if (!pulse) { structural.add(name); continue }
      const changed = pulse.changed ?? []
      const addedRanges = pulse.added ?? []
      const lengthChanging = pulse.from != null || (pulse.removed?.length ?? 0) > 0
        || (addedRanges.length > 0 && (pulse.baseLength ?? t.baseLen) !== t.len)
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

  const applyDomainRaw = (
    cur: Record<string, unknown[]> | undefined, patch: Record<string, unknown[] | null> | undefined,
  ): Record<string, unknown[]> | undefined => {
    if (!patch) return cur
    const next = dict(cur) as Record<string, unknown[]>
    for (const [name, values] of Object.entries(patch)) {
      // A null value clears that scale's override (pan/zoom reset).
      if (values == null) delete next[name]
      else next[name] = values
    }
    return Object.keys(next).length ? next : undefined
  }

  const flushOnce = (): StreamFlush | null => {
    // An empty first flush primes the stream's scene from the spec/initial
    // snapshot; after that an empty flush is a no-op.
    if (closed || (!hasQueue() && lastScene)) return null
    const f = currentFold()
    const consumed = depth()
    const { pulse, lengths } = planPulse(f)
    const changedDatasets = [...pulse.structural]
    const dataPulse: NonNullable<RuntimeInput['dataPulse']> = {}
    const dataChanges = dict<number[]>()
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
    // Stage every scalar: nothing is committed until the evaluation succeeds.
    const nextSignals = f.signals ? dict(signals, f.signals) : signals
    const nextWidth = f.width ?? width
    const nextHeight = f.height ?? height
    const nextDomainRaw = applyDomainRaw(domainRaw, f.domainRaw)
    const nextLimits = f.limits ?? limits
    const nextTextMetrics = f.textMetrics ?? textMetrics
    if (nextLimits?.maxRows != null) {
      // The stream holds the rows (the session only sees spec literals), so
      // enforce the row budget over what it is about to evaluate.
      let total = 0
      for (const [name, rows] of base) total += lengths.get(name) ?? rows.length
      for (const [name, len] of lengths) if (!base.has(name)) total += len
      if (total > nextLimits.maxRows) throw new AsterLimitError(`maxRows ${total} > ${nextLimits.maxRows}`)
    }
    // Materialise queued rows now, at flush time (never per push), with an
    // undo log so a throwing evaluation leaves the committed rows untouched.
    // A base array that came from the spec/host is copied once, then mutated
    // in place so repeated appends are O(appended).
    const undo: Array<() => void> = []
    const rollback = (): void => { for (let i = undo.length - 1; i >= 0; i--) undo[i]!() }
    let scene: SceneRoot
    try {
      for (const [name, t] of f.targets) {
        if (t.replace !== undefined) {
          const arr = finalRows(t)!
          const prev = base.get(name)
          const wasOwned = owned.has(name)
          undo.push(() => { if (prev) base.set(name, prev); else base.delete(name); if (wasOwned) owned.add(name); else owned.delete(name) })
          if (t.finalOwned) owned.add(name); else owned.delete(name)
          base.set(name, arr)
        } else if (t.chunks.length) {
          const prev = base.get(name)
          const wasOwned = owned.has(name)
          let arr = prev ?? []
          if (!wasOwned) {
            arr = arr.slice()
            undo.push(() => { if (prev) base.set(name, prev); else base.delete(name); owned.delete(name) })
            owned.add(name)
          } else {
            const keep = arr.length
            undo.push(() => { arr.length = keep })
          }
          for (const c of t.chunks) for (let i = 0; i < c.length; i++) arr.push(c[i])
          base.set(name, arr)
        }
      }
      // The stream states exactly what changed (including in-place edits and
      // datasets that need a re-derive), so the session must not second-guess
      // it by diffing row identity: a row object edited in place compares
      // equal to itself and its change would be lost.
      const input: RuntimeInput = {
        data: Object.fromEntries(base),
        autoChanges: false,
        ...(Object.keys(nextSignals).length ? { signals: nextSignals } : {}),
        ...(nextWidth != null ? { width: nextWidth } : {}),
        ...(nextHeight != null ? { height: nextHeight } : {}),
        ...(nextDomainRaw ? { domainRaw: nextDomainRaw } : {}),
        ...(nextLimits ? { limits: nextLimits } : {}),
        ...(nextTextMetrics ? { textMetrics: nextTextMetrics } : {}),
        ...(Object.keys(dataPulse).length ? { dataPulse } : {}),
        ...(Object.keys(dataChanges).length ? { dataChanges } : {}),
        ...(changedDatasets.length ? { changedDatasets } : {}),
      }
      scene = session!.evaluate(spec, input)
    } catch (err) {
      rollback()
      throw err
    }
    // Commit.
    signals = nextSignals
    width = nextWidth
    height = nextHeight
    domainRaw = nextDomainRaw
    limits = nextLimits
    textMetrics = nextTextMetrics
    if (policy === 'coalesce') { if (fold === f) fold = null }
    else { const gone = queue.splice(0, consumed); for (const e of gone) queuedRows -= e.rows }
    const delivered = pulse
    const noop = !delivered.datasets.size && !delivered.structural.size && scene === lastScene
    lastScene = scene
    lastPulse = delivered
    stats.flushes++
    return { scene, pulse: delivered, batches: consumed, noop }
  }

  const stream: ChartStream = {
    push(batch) {
      return enqueue(batch)
    },
    flush() {
      // One registration point for EVERY throw out of a flush, whichever stage
      // raised it (stream-side checks, session pre-flight, evaluate, scene
      // limits, deadline). The queue is untouched on failure, so its current
      // size is exactly what is still queued.
      try {
        return flushOnce()
      } catch (err) {
        // Non-object throws cannot carry info (a WeakMap key must be an object).
        if (err != null && typeof err === 'object') FLUSH_FAILURES.set(err, { batches: depth(), queuedRows: rowsQueued() })
        throw err
      }
    },
    pending() {
      return closed ? { datasets: new Map(), structural: new Set() } : planPulse(currentFold()).pulse
    },
    pulse: () => lastPulse,
    scene: () => lastScene,
    stats: () => ({
      depth: depth(), capacity, queuedRows: rowsQueued(), maxQueuedRows, policy, ...stats,
    }),
    canAccept() {
      if (closed) return false
      if (policy === 'drop-oldest') return true
      // coalesce folds into its one batch, so only the row bound can be full.
      const batchRoom = policy === 'coalesce' || depth() < capacity
      return batchRoom && rowsQueued() < maxQueuedRows
    },
    discard() {
      if (closed) return 0
      const n = depth()
      stats.dropped += n
      queue = []
      queuedRows = 0
      fold = null
      return n
    },
    close() {
      closed = true
      queue = []
      queuedRows = 0
      fold = null
      base.clear()
      owned.clear()
      signals = dict()
      domainRaw = undefined
      limits = undefined
      textMetrics = undefined
      lastScene = null
      lastPulse = null
      session = null
    },
    session() {
      if (!session) throw new AsterStreamClosedError()
      return session
    },
  }
  return stream
}
