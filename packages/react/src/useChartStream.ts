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
import { normalizeChartSpec } from './spec.js'

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
  /** The underlying stream (stable until the spec/capacity/policy changes). */
  stream: ChartStream
}

interface StreamState {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
}

export function useChartStream(spec: VgSpec, options: UseChartStreamOptions = {}): UseChartStreamResult {
  const { serialize = true, autoFlush = true, flushPolicy = 'microtask', capacity, policy, initial } = options
  const normalized = React.useMemo(() => normalizeChartSpec(spec), [spec])
  const streamRef = React.useRef<ChartStream | null>(null)
  const streamKey = React.useRef<{ spec: VgSpec; capacity?: number; policy?: StreamOptions['policy'] } | null>(null)
  if (
    streamRef.current == null
    || streamKey.current?.spec !== normalized
    || streamKey.current?.capacity !== capacity
    || streamKey.current?.policy !== policy
  ) {
    streamRef.current = createChartStream(normalized, { capacity, policy, initial })
    streamKey.current = { spec: normalized, capacity, policy }
  }
  const stream = streamRef.current
  const [state, setState] = React.useState<StreamState>({ scene: null, svg: null, error: null })
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
        scene: result.scene,
        svg: serialize ? renderSceneToSvg(result.scene) : null,
        error: null,
      })
    }
    return result
  }, [serialize])

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
      if (mounted.current) setState((s) => ({ ...s, error }))
      return null
    }
  }, [commit, stream])

  const flushRef = React.useRef(flush)
  flushRef.current = flush

  // Prime the initial scene (and reset when the stream is rebuilt). Layout
  // effect so the first paint already has the scene.
  React.useLayoutEffect(() => {
    lastFlush.current = null
    setState({ scene: null, svg: null, error: null })
    flushRef.current()
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

  return {
    ...state,
    push,
    flush,
    pending: () => stream.pending(),
    pulse: () => lastFlush.current?.pulse ?? stream.pulse(),
    stats: () => stream.stats(),
    paused,
    pause,
    resume,
    close,
    stream,
  }
}
