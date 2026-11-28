/**
 * React binding for `createChartStream`.
 *
 * A push-based feed cannot wait for a React render per event. This hook owns a
 * bounded stream, coalesces pushes into one flush per tick (by default), and
 * exposes the resulting scene/SVG plus the pulse/stat APIs. It is the React
 * counterpart of the core `createChartStream` primitive.
 */
import * as React from 'react'
import type {
  ChartStream,
  DataPulse,
  SceneRoot,
  StreamBatch,
  StreamFlush,
  StreamFlushFailure,
  StreamOptions,
  StreamStats,
  UrlDataMode,
  VgSpec,
} from '@aster-charts/core'
import { renderSceneToSvg } from '@aster-charts/core/internal'
import { createChartStream, getStreamFlushFailure } from '@aster-charts/core/internal/stream'
import { normalizeSpecResult, useStableContent, useStableSpec } from './spec.js'
import { useAddons } from './addons.js'

export interface UseChartStreamOptions extends StreamOptions {
  /** Serialize the scene to SVG on every flush (default true). */
  serialize?: boolean
  /**
   * Flush once per microtask after a push (default true). Set false to drive
   * `flush()` yourself (e.g. aligned to a sensor/requestAnimationFrame tick).
   */
  autoFlush?: boolean
  /** Align automatic flushes to a microtask or an animation frame. Default `microtask`. */
  flushPolicy?: 'microtask' | 'raf'
}

/** What a failed flush left behind, and how much `discard()` dropped to recover. */
export interface StreamFlushFailureInfo extends StreamFlushFailure {
  /** Batches dropped by `stream.discard()` so the next flush does not fail again. */
  discarded: number
}

export interface UseChartStreamResult {
  scene: SceneRoot | null
  svg: string | null
  /**
   * The last flush error (typed, e.g. `AsterLimitError`); cleared by the next
   * successful flush. A failed flush is atomic, so the hook calls
   * `stream.discard()` right after capturing it: the queue is dropped (see
   * `flushFailure`) instead of failing every later flush with the same batch.
   */
  error: Error | null
  /** Queue state at the failure and the number of batches discarded; null when there is no flush error. */
  flushFailure: StreamFlushFailureInfo | null
  /** Enqueue a batch; returns false when the backpressure policy rejected it. */
  push: (batch: StreamBatch) => boolean
  /** Apply queued batches now; returns null when there is nothing to do. */
  flush: () => StreamFlush | null
  pending: () => DataPulse
  pulse: () => DataPulse | null
  stats: () => StreamStats
  /** Pause/resume the automatic microtask flush (the queue keeps filling). Kept across a rebuilt stream. */
  paused: boolean
  pause: () => void
  resume: () => void
  /** Stop accepting batches and drop the queue (this stream: one rebuilt later, after a spec change, is open). */
  close: () => void
  /** The underlying stream (stable until the spec CONTENT, `capacity`, `policy`, `maxQueuedRows` or `initial.urlData` changes). */
  stream: ChartStream
}

interface StreamState {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  flushFailure: StreamFlushFailureInfo | null
}

/** Capture the failure info of a flush error, then recover the stream by discarding its queue. */
function recoverFromFlushError(stream: ChartStream, e: unknown): { error: Error; flushFailure: StreamFlushFailureInfo | null } {
  const error = e instanceof Error ? e : new Error(String(e))
  const failure = getStreamFlushFailure(e)
  return { error, flushFailure: failure ? { ...failure, discarded: stream.discard() } : null }
}

/** A state tagged with the stream it belongs to (a rebuilt stream discards the old one). */
interface TaggedState extends StreamState {
  stream: ChartStream
}

/**
 * The stream is keyed on the spec CONTENT, `capacity`, `policy`, `maxQueuedRows` and `initial.urlData`: a parent
 * re-render that hands in an equal (but new) inline `spec` keeps the stream and
 * the rows streamed into it. The rest of `initial` is read when the stream is created. `limits` (by content) and
 * `textMetrics` changes reach the live stream from the next flush (a stream cannot go back to no text metrics: removing
 * them keeps the last; removing `limits` applies `{}`). A replaced stream, and the stream of an unmounted hook, is closed:
 * a push through it answers `false`.
 *
 * The first scene is primed synchronously while the stream is created, so a
 * server render (where no effect runs) already contains the chart.
 */
export function useChartStream(spec: VgSpec, options: UseChartStreamOptions = {}): UseChartStreamResult {
  const { serialize = true, autoFlush = true, flushPolicy = 'microtask', capacity, policy, initial, maxQueuedRows, textMetrics } = options
  const stableSpec = useStableSpec(spec)
  // (`limits` by content: an inline literal is no change; a change reaches the live stream, see below)
  const limits = useStableContent(options.limits)
  // Normalized inside the guard: a value that is not a spec, a Vega-Lite spec without the compiler or one it refuses is the
  // result's `error` (and `<ChartStream>`'s `onStreamError`), never a throw from render. Such a stream is made over an empty
  // spec (a new one per failure, so another failure makes another stream) and stays in that error.
  const normalizedResult = React.useMemo(() => normalizeSpecResult(stableSpec), [stableSpec])
  const specError = normalizedResult.error
  const normalized = React.useMemo(() => normalizedResult.spec ?? ({} as VgSpec), [normalizedResult])
  // `initial.urlData` decides whether the spec is refused, so unlike the rest of `initial` it is part of the stream's key
  const urlData = initial?.urlData
  // The add-ons the spec needs load before the stream is created (and primed): suspends meanwhile; a failed import is `error`.
  // With `urlData: 'refuse'` a spec with a url dataset is refused first, before any import.
  const addonError = useAddons(normalizedResult.spec, urlData, { limits: limits != null, random: initial?.random != null })
  const streamRef = React.useRef<ChartStream | null>(null)
  const configRef = React.useRef<{ sent: { limits: StreamOptions['limits']; textMetrics: StreamOptions['textMetrics'] }; pending: StreamBatch | null }>({ sent: { limits, textMetrics }, pending: null })
  const streamKey = React.useRef<{ spec: VgSpec; capacity?: number; policy?: StreamOptions['policy']; maxQueuedRows?: number; urlData?: UrlDataMode } | null>(null)
  const primedRef = React.useRef<TaggedState | null>(null)
  if (
    streamRef.current == null
    || streamKey.current?.spec !== normalized
    || streamKey.current?.capacity !== capacity
    || streamKey.current?.policy !== policy
    || streamKey.current?.maxQueuedRows !== maxQueuedRows
    || streamKey.current?.urlData !== urlData
  ) {
    const created = createChartStream(normalized, {
      capacity, policy, initial,
      ...(maxQueuedRows != null ? { maxQueuedRows } : {}),
      ...(limits ? { limits } : {}),
      ...(textMetrics ? { textMetrics } : {}),
    })
    streamRef.current = created
    streamKey.current = { spec: normalized, capacity, policy, maxQueuedRows, urlData }
    // (what the new stream was made with: a later change of `limits` / `textMetrics` is measured from here)
    configRef.current = { sent: { limits, textMetrics }, pending: null }
    let primed: StreamState
    try {
      if (specError) throw specError
      if (addonError) throw addonError
      const first = created.flush()
      primed = first
        ? { scene: first.scene, svg: serialize ? renderSceneToSvg(first.scene) : null, error: null, flushFailure: null }
        : { scene: null, svg: null, error: null, flushFailure: null }
    } catch (e) {
      primed = { scene: null, svg: null, ...recoverFromFlushError(created, e) }
    }
    primedRef.current = { ...primed, stream: created }
  }
  const stream = streamRef.current
  const [tagged, setState] = React.useState<TaggedState | null>(null)
  const state: StreamState = tagged != null && tagged.stream === stream ? tagged : primedRef.current!
  const mounted = React.useRef(true)
  const scheduled = React.useRef(false)
  const lastFlush = React.useRef<StreamFlush | null>(null)
  // `paused` is the hook's (a host's choice about automatic flushing): kept across a rebuilt stream. Closing is the stream's.
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  const frameRef = React.useRef<number | null>(null)
  const stateRef = React.useRef(state)
  stateRef.current = state

  /** Cancel a pending animation frame; nothing is scheduled afterwards (C159: a cancelled frame left `scheduled` set for good). */
  const cancelFrame = (): void => {
    if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    scheduled.current = false
  }

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelFrame()
    }
    // (cancelFrame only reads refs)
  }, [])

  // A stream that is replaced (a new spec content, capacity, ...) or whose hook unmounts is closed: a push through a stale
  // handle answers `false` and its queue is released (C506). Decided one microtask after the cleanup, so StrictMode's re-run of
  // the effects, which keeps the same stream, does not close it.
  React.useEffect(() => () => {
    queueMicrotask(() => {
      if (!mounted.current || streamRef.current !== stream) stream.close()
    })
  }, [stream])

  const commit = React.useCallback((result: StreamFlush | null): StreamFlush | null => {
    lastFlush.current = result
    if (result) {
      // (a no-op flush returns the scene already shown: no state update, so a flush() called from an effect cannot loop, C632)
      const shown = stateRef.current
      if (result.noop && shown.scene === result.scene && shown.error === null) return result
      setState({
        stream,
        scene: result.scene,
        svg: serialize ? renderSceneToSvg(result.scene) : null,
        error: null,
        flushFailure: null,
      })
    }
    return result
  }, [serialize, stream])

  /** Put a changed `limits` / `textMetrics` on the queue, where it applies to the next flush; returns whether it is queued. */
  const queueConfig = React.useCallback((): boolean => {
    const config = configRef.current.pending
    if (config == null) return true
    const st = stream.stats()
    // (it never takes a data batch's place: under drop-oldest that would discard rows, under drop-newest refuse the config)
    if (st.policy !== 'coalesce' && st.depth >= st.capacity) return false
    if (!stream.push(config)) return false
    configRef.current.pending = null
    return true
  }, [stream])

  const flush = React.useCallback((): StreamFlush | null => {
    // (a stream over a spec that could not be normalized has nothing to draw: it keeps its error)
    if (specError) return null
    try {
      // a queue full of data batches is applied first, and the config is queued for the flush after it
      const queued = queueConfig()
      let result = stream.flush()
      if (!queued && queueConfig()) result = stream.flush() ?? result
      if (result) return commit(result)
      // Already primed (or a no-op tick): expose the last scene so callers can
      // use flush() as a "latest frame" accessor.
      const scene = stream.scene()
      if (scene) {
        const current: StreamFlush = {
          scene,
          pulse: stream.pulse() ?? { datasets: new Map(), structural: new Set() },
          batches: 0,
          noop: true,
        }
        return commit(current)
      }
      return null
    } catch (e) {
      const failed = recoverFromFlushError(stream, e)
      if (mounted.current) setState((s) => ({ ...(s != null && s.stream === stream ? s : primedRef.current!), ...failed }))
      return null
    }
  }, [commit, stream, specError, queueConfig])

  const flushRef = React.useRef(flush)
  flushRef.current = flush

  // A rebuilt stream starts from its own primed scene (see above).
  React.useLayoutEffect(() => {
    lastFlush.current = null
  }, [stream])

  const schedule = React.useCallback((): void => {
    if (!autoFlush || pausedRef.current || scheduled.current) return
    scheduled.current = true
    const run = (): void => {
      scheduled.current = false
      frameRef.current = null
      if (mounted.current && !pausedRef.current) flushRef.current()
    }
    if (flushPolicy === 'raf' && typeof requestAnimationFrame === 'function') {
      frameRef.current = requestAnimationFrame(run)
    } else {
      queueMicrotask(run)
    }
  }, [autoFlush, flushPolicy])

  // `limits` (by content) and `textMetrics` changes reach the live stream (C296): queued for the next flush, which a `limits`
  // change schedules. A textMetrics provider is compared by identity, so it only rides on a flush that happens anyway: an inline
  // provider object rebuilt by every render must not flush on every render.
  React.useEffect(() => {
    const config = configRef.current
    const sent = config.sent
    if (sent.limits === limits && sent.textMetrics === textMetrics) return
    const next: StreamBatch = { ...config.pending }
    if (sent.limits !== limits) next.limits = limits ?? {}
    if (sent.textMetrics !== textMetrics && textMetrics != null) next.textMetrics = textMetrics
    config.sent = { limits, textMetrics }
    if (next.limits === undefined && next.textMetrics === undefined) return
    config.pending = next
    queueConfig()
    if (sent.limits !== limits) schedule()
  }, [limits, textMetrics, queueConfig, schedule])

  const push = React.useCallback((batch: StreamBatch): boolean => {
    const accepted = stream.push(batch)
    if (accepted) schedule()
    return accepted
  }, [schedule, stream])

  const pause = React.useCallback((): void => {
    pausedRef.current = true
    setPaused(true)
  }, [])

  const resume = React.useCallback((): void => {
    pausedRef.current = false
    setPaused(false)
    schedule()
  }, [schedule])

  /** Close this stream (it refuses pushes and drops its queue); a stream rebuilt later is open. It does not pause the hook. */
  const close = React.useCallback((): void => {
    cancelFrame()
    stream.close()
    // (cancelFrame only reads refs)
  }, [stream])

  // Stable identities (per stream), so a consumer can list them as dependencies.
  const pending = React.useCallback(() => stream.pending(), [stream])
  const pulse = React.useCallback(() => lastFlush.current?.pulse ?? stream.pulse(), [stream])
  const stats = React.useCallback(() => stream.stats(), [stream])

  return {
    ...state,
    push,
    flush,
    pending,
    pulse,
    stats,
    paused,
    pause,
    resume,
    close,
    stream,
  }
}
