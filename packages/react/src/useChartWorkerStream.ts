/**
 * Worker-backed streaming chart (R13). The worker owns the `ChartStream`; the
 * main thread only ships batches and receives scenes/pulses. When no Worker is
 * available the same hook falls back to a local stream, so hosts need one code
 * path.
 */
import * as React from 'react'
import {
  createChartStream,
  renderSceneToSvg,
  type ChartStream,
  type DataPulse,
  type SceneRoot,
  type StreamBatch,
  type StreamOptions,
  type StreamPolicy,
  type StreamStats,
  type VgSpec,
} from '@aster/core'
import { normalizeChartSpec } from './spec.js'
import {
  handleChartWorkerStreamRequest,
  type ChartWorkerOptions,
  type ChartWorkerStreamRequest,
  type ChartWorkerStreamResponse,
} from './worker.js'

export interface ChartWorkerStreamOptions extends ChartWorkerOptions, StreamOptions {
  /** Serialize each received scene to SVG (default true). */
  serialize?: boolean
  /** Flush once per microtask/`requestAnimationFrame` after a push (default true). */
  autoFlush?: boolean
  /** Align automatic flushes to a microtask or an animation frame. Default `microtask`. */
  flushPolicy?: 'microtask' | 'raf'
}

export interface WorkerChartStreamResult {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  pending: boolean
  push: (batch: StreamBatch) => boolean
  flush: () => void
  pulse: () => DataPulse | null
  stats: () => StreamStats | null
  /** Batches accepted/rejected by the worker's backpressure policy. */
  accepted: () => number | null
  rejected: () => number | null
  /** Main-thread batches waiting for the next flush. */
  depth: () => number
  paused: boolean
  pause: () => void
  resume: () => void
  close: () => void
}

interface StreamUiState {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  pending: boolean
}

export function useChartWorkerStream(spec: VgSpec, options: ChartWorkerStreamOptions = {}): WorkerChartStreamResult {
  const {
    worker, workerFactory, capacity, policy, initial,
    serialize = true, autoFlush = true, flushPolicy = 'microtask',
  } = options
  const normalized = React.useMemo(() => normalizeChartSpec(spec), [spec])
  const [state, setState] = React.useState<StreamUiState>({ scene: null, svg: null, error: null, pending: true })
  const workerRef = React.useRef<Worker | null>(null)
  const localRef = React.useRef<ChartStream | null>(null)
  const batchesRef = React.useRef<StreamBatch[]>([])
  const statsRef = React.useRef<StreamStats | null>(null)
  const pulseRef = React.useRef<DataPulse | null>(null)
  const acceptedRef = React.useRef<number | null>(null)
  const rejectedRef = React.useRef<number | null>(null)
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  const closedRef = React.useRef(false)
  const frameRef = React.useRef<number | null>(null)
  const seqRef = React.useRef(0)
  const streamIdRef = React.useRef(0)
  const lastApplied = React.useRef(0)
  const scheduled = React.useRef(false)
  const mounted = React.useRef(true)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (worker !== undefined) {
      workerRef.current = worker
      return
    }
    workerRef.current = workerFactory ? workerFactory() : null
    return () => {
      workerRef.current?.terminate?.()
      workerRef.current = null
    }
  }, [worker, workerFactory])

  const apply = React.useCallback((response: ChartWorkerStreamResponse): void => {
    if (!mounted.current || response.id < lastApplied.current) return
    lastApplied.current = response.id
    if (response.stats) statsRef.current = response.stats
    if (response.pulse) pulseRef.current = response.pulse
    if (response.accepted != null) acceptedRef.current = response.accepted
    if (response.rejected != null) rejectedRef.current = response.rejected
    if (response.error) {
      setState((s) => ({
        ...s,
        error: Object.assign(new Error(response.error!.message), response.error),
        pending: false,
      }))
      return
    }
    if (response.scene) {
      setState({
        scene: response.scene,
        svg: serialize ? (response.svg ?? renderSceneToSvg(response.scene)) : null,
        error: null,
        pending: false,
      })
    } else {
      setState((s) => ({ ...s, pending: false }))
    }
  }, [serialize])

  const sendFlush = React.useCallback((batches: StreamBatch[]): void => {
    const w = workerRef.current
    const streamId = streamIdRef.current
    if (!w) {
      const stream = localRef.current
      if (!stream) return
      for (const b of batches) stream.push(b)
      try {
        stream.flush()
        const scene = stream.scene()
        if (scene) setState({ scene, svg: serialize ? renderSceneToSvg(scene) : null, error: null, pending: false })
        statsRef.current = stream.stats()
        pulseRef.current = stream.pulse()
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e : new Error(String(e)), pending: false }))
      }
      return
    }
    const id = ++seqRef.current
    batchesRef.current = []
    const request: ChartWorkerStreamRequest = { kind: 'stream', id, streamId, op: 'flush', batches }
    w.postMessage(request)
  }, [serialize])

  const scheduleFlush = React.useCallback((): void => {
    if (!autoFlush || pausedRef.current || scheduled.current) return
    scheduled.current = true
    const run = (): void => {
      scheduled.current = false
      frameRef.current = null
      if (!mounted.current || pausedRef.current) return
      sendFlush(batchesRef.current)
    }
    if (flushPolicy === 'raf' && typeof requestAnimationFrame === 'function') {
      frameRef.current = requestAnimationFrame(run)
    } else {
      queueMicrotask(run)
    }
  }, [autoFlush, flushPolicy, sendFlush])

  React.useEffect(() => {
    const streamId = ++streamIdRef.current
    const id = ++seqRef.current
    lastApplied.current = id
    batchesRef.current = []
    setState({ scene: null, svg: null, error: null, pending: true })
    closedRef.current = false
    const w = workerRef.current
    if (!w) {
      const stream = createChartStream(normalized, { capacity, policy, initial })
      localRef.current = stream
      try {
        stream.flush()
        const scene = stream.scene()
        setState({ scene, svg: serialize && scene ? renderSceneToSvg(scene) : null, error: null, pending: false })
        statsRef.current = stream.stats()
        pulseRef.current = stream.pulse()
      } catch (e) {
        setState({ scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), pending: false })
      }
      return () => {
        stream.close()
        if (localRef.current === stream) localRef.current = null
      }
    }
    localRef.current?.close()
    localRef.current = null
    const request: ChartWorkerStreamRequest = {
      kind: 'stream', id, streamId, op: 'init', spec: normalized,
      options: { capacity, policy, initial },
    }
    const onMessage = (event: MessageEvent<ChartWorkerStreamResponse>): void => {
      const response = event.data
      if (response.kind !== 'stream' || response.streamId !== streamId) return
      apply(response)
    }
    w.addEventListener('message', onMessage)
    w.postMessage(request)
    return () => {
      w.removeEventListener('message', onMessage)
      try { w.postMessage({ kind: 'stream', id: ++seqRef.current, streamId, op: 'close' }) } catch { /* terminated */ }
    }
  }, [normalized, capacity, policy, worker, workerFactory, serialize, apply])

  // In case the worker is created asynchronously (workerFactory), the effect
  // above runs after the setup effect and sees it in workerRef.
  const push = React.useCallback((batch: StreamBatch): boolean => {
    if (closedRef.current) return false
    const local = localRef.current
    if (local) {
      const accepted = local.push(batch)
      if (accepted) scheduleFlush()
      return accepted
    }
    // Worker path: the bounded queue lives in the worker; the main thread only
    // batches until the next flush. A local capacity is a producer-side guard.
    if (capacity != null && batchesRef.current.length >= capacity) return false
    batchesRef.current.push(batch)
    scheduleFlush()
    return true
  }, [capacity, scheduleFlush])

  const flush = React.useCallback((): void => {
    if (localRef.current) {
      sendFlush([])
      return
    }
    if (batchesRef.current.length) sendFlush(batchesRef.current)
  }, [sendFlush])

  const pause = React.useCallback((): void => {
    pausedRef.current = true
    setPaused(true)
  }, [])

  const resume = React.useCallback((): void => {
    pausedRef.current = false
    setPaused(false)
    scheduleFlush()
  }, [scheduleFlush])

  const close = React.useCallback((): void => {
    closedRef.current = true
    pausedRef.current = true
    setPaused(true)
    if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    batchesRef.current = []
    localRef.current?.close()
    const w = workerRef.current
    if (w) {
      try {
        w.postMessage({ kind: 'stream', id: ++seqRef.current, streamId: streamIdRef.current, op: 'close' } satisfies ChartWorkerStreamRequest)
      } catch { /* terminated */ }
    }
  }, [])

  return {
    ...state,
    push,
    flush,
    pulse: () => pulseRef.current,
    stats: () => statsRef.current,
    accepted: () => acceptedRef.current,
    rejected: () => rejectedRef.current,
    depth: () => localRef.current?.stats().depth ?? batchesRef.current.length,
    paused,
    pause,
    resume,
    close,
  }
}
