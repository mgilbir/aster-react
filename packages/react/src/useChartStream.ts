/**
 * React binding for `createChartStream` (R13).
 *
 * A push-based feed cannot wait for a React render per event. This hook owns a
 * bounded stream, coalesces pushes into one flush per tick (by default), and
 * exposes the resulting scene/SVG plus the pulse/stat APIs. It is the React
 * counterpart of the core `createChartStream` primitive.
 */
import * as React from 'react'
import {
  createChartStream,
  renderSceneToSvg,
  type ChartStream,
  type DataPulse,
  type SceneRoot,
  type StreamBatch,
  type StreamFlush,
  type StreamOptions,
  type StreamStats,
  type VgSpec,
} from '@aster/core'
import { normalizeChartSpec, useStableSpec } from './spec.js'

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

export interface UseChartStreamResult {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  /** Enqueue a batch; returns false when the backpressure policy rejected it. */
  push: (batch: StreamBatch) => boolean
  /** Apply queued batches now; returns null when there is nothing to do. */
  flush: () => StreamFlush | null
  pending: () => DataPulse
  pulse: () => DataPulse | null
  stats: () => StreamStats
  /** Pause/resume the automatic microtask flush (the queue keeps filling). */
  paused: boolean
  pause: () => void
  resume: () => void
  /** Stop accepting batches and drop the queue. */
  close: () => void
  /** The underlying stream (stable until the spec CONTENT, capacity or policy changes). */
  stream: ChartStream
}

interface StreamState {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
}

/** A state tagged with the stream it belongs to (a rebuilt stream discards the old one). */
interface TaggedState extends StreamState {
  stream: ChartStream
}

/**
 * The stream is keyed on the spec CONTENT, `capacity` and `policy`: a parent
 * re-render that hands in an equal (but new) inline `spec` keeps the stream and
 * the rows streamed into it. `initial` is read when the stream is created.
 *
 * The first scene is primed synchronously while the stream is created, so a
 * server render (where no effect runs) already contains the chart.
 */
export function useChartStream(spec: VgSpec, options: UseChartStreamOptions = {}): UseChartStreamResult {
  const { serialize = true, autoFlush = true, flushPolicy = 'microtask', capacity, policy, initial } = options
  const stableSpec = useStableSpec(spec)
  const normalized = React.useMemo(() => normalizeChartSpec(stableSpec), [stableSpec])
  const streamRef = React.useRef<ChartStream | null>(null)
  const streamKey = React.useRef<{ spec: VgSpec; capacity?: number; policy?: StreamOptions['policy'] } | null>(null)
  const primedRef = React.useRef<TaggedState | null>(null)
  if (
    streamRef.current == null
    || streamKey.current?.spec !== normalized
    || streamKey.current?.capacity !== capacity
    || streamKey.current?.policy !== policy
  ) {
    const created = createChartStream(normalized, { capacity, policy, initial })
    streamRef.current = created
    streamKey.current = { spec: normalized, capacity, policy }
    let primed: StreamState
    try {
      const first = created.flush()
      primed = first
        ? { scene: first.scene, svg: serialize ? renderSceneToSvg(first.scene) : null, error: null }
        : { scene: null, svg: null, error: null }
    } catch (e) {
      primed = { scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)) }
    }
    primedRef.current = { ...primed, stream: created }
  }
  const stream = streamRef.current
  const [tagged, setState] = React.useState<TaggedState | null>(null)
  const state: StreamState = tagged != null && tagged.stream === stream ? tagged : primedRef.current!
  const mounted = React.useRef(true)
  const scheduled = React.useRef(false)
  const lastFlush = React.useRef<StreamFlush | null>(null)
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  const frameRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const commit = React.useCallback((result: StreamFlush | null): StreamFlush | null => {
    lastFlush.current = result
    if (result) {
      setState({
        stream,
        scene: result.scene,
        svg: serialize ? renderSceneToSvg(result.scene) : null,
        error: null,
      })
    }
    return result
  }, [serialize, stream])

  const flush = React.useCallback((): StreamFlush | null => {
    try {
      const result = stream.flush()
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
      const error = e instanceof Error ? e : new Error(String(e))
      if (mounted.current) setState((s) => ({ ...(s != null && s.stream === stream ? s : primedRef.current!), error }))
      return null
    }
  }, [commit, stream])

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

  const close = React.useCallback((): void => {
    pausedRef.current = true
    setPaused(true)
    if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    stream.close()
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
