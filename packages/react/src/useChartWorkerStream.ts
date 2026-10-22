/**
 * Worker-backed streaming chart (R13). The worker owns the `ChartStream`; the
 * main thread only ships batches and receives scenes/pulses. When no Worker is
 * available the same hook falls back to a local stream, so hosts need one code
 * path.
 *
 * Lifecycle: the stream is keyed on the spec CONTENT (plus capacity/policy and
 * the supplied `worker`). A parent re-render with an equal inline `spec`, a new
 * `workerFactory` arrow, or a changed `serialize` does not restart it and does
 * not discard streamed rows.
 */
import * as React from 'react'
import {
  AsterStreamBackpressureError,
  createChartStream,
  renderSceneToSvg,
  type ChartStream,
  type DataPulse,
  type RuntimeInput,
  type SceneRoot,
  type StreamBatch,
  type StreamOptions,
  type StreamStats,
  type VgSpec,
} from '@aster/core'
import { mergeBatches } from './batches.js'
import { normalizeChartSpec, useStableSpec } from './spec.js'
import {
  errorFromWire,
  listenToWorker,
  nextWorkerRequestId,
  resolveWorkerTextMetrics,
  useWorkerInstance,
  wireTextMetrics,
  type ChartWorkerBatch,
  type ChartWorkerOptions,
  type ChartWorkerStreamRequest,
  type ChartWorkerStreamResponse,
  type WorkerTextMetrics,
} from './worker.js'

export interface ChartWorkerStreamOptions extends ChartWorkerOptions, Omit<StreamOptions, 'initial'> {
  /**
   * First-flush input. Read when the stream is (re)created. `textMetrics` is a
   * provider name registered in the worker (an object only works without one).
   */
  initial?: Omit<RuntimeInput, 'textMetrics'> & { textMetrics?: WorkerTextMetrics }
  /** Serialize each received scene to SVG (default true). Changing it never restarts the stream. */
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
  /** Increments each time the stream is (re)created (spec content, capacity, policy or worker changed). */
  generation: number
  /**
   * Enqueue a batch. With a Worker the producer-side buffer applies the same
   * `capacity`/`policy` as the stream, so the return value is final: `false`
   * means the policy rejected the batch (`error` throws
   * `AsterStreamBackpressureError`), `true` means it will be delivered.
   */
  push: (batch: ChartWorkerBatch) => boolean
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
  generation: number
}

export function useChartWorkerStream(spec: VgSpec, options: ChartWorkerStreamOptions = {}): WorkerChartStreamResult {
  const {
    worker, workerFactory, capacity, policy, initial,
    serialize = true, autoFlush = true, flushPolicy = 'microtask',
  } = options
  const stableSpec = useStableSpec(spec)
  const normalized = React.useMemo(() => normalizeChartSpec(stableSpec), [stableSpec])
  const [state, setState] = React.useState<StreamUiState>({ scene: null, svg: null, error: null, pending: true, generation: 0 })
  const workerRef = useWorkerInstance(worker, workerFactory)
  const localRef = React.useRef<ChartStream | null>(null)
  const batchesRef = React.useRef<ChartWorkerBatch[]>([])
  const statsRef = React.useRef<StreamStats | null>(null)
  const pulseRef = React.useRef<DataPulse | null>(null)
  const acceptedRef = React.useRef<number | null>(null)
  const rejectedRef = React.useRef<number | null>(null)
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  const closedRef = React.useRef(false)
  const frameRef = React.useRef<number | null>(null)
  const streamIdRef = React.useRef(0)
  const lastApplied = React.useRef(0)
  const scheduled = React.useRef(false)
  const mounted = React.useRef(true)
  // Read at use time so they never restart the stream.
  const serializeRef = React.useRef(serialize)
  serializeRef.current = serialize
  const initialRef = React.useRef(initial)
  initialRef.current = initial
  const queueCapacity = Math.max(1, capacity ?? 32)
  const queuePolicy = policy ?? 'coalesce'

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const fail = React.useCallback((error: Error): void => {
    if (mounted.current) setState((s) => ({ ...s, error, pending: false }))
  }, [])

  const apply = React.useCallback((response: ChartWorkerStreamResponse): void => {
    if (!mounted.current || response.id < lastApplied.current) return
    lastApplied.current = response.id
    if (response.stats) statsRef.current = response.stats
    if (response.pulse) pulseRef.current = response.pulse
    if (response.accepted != null) acceptedRef.current = response.accepted
    if (response.rejected != null) rejectedRef.current = response.rejected
    if (response.error) {
      fail(errorFromWire(response.error))
      return
    }
    if (response.scene) {
      const scene = response.scene
      setState((s) => ({
        ...s,
        scene,
        svg: serializeRef.current ? (response.svg ?? renderSceneToSvg(scene)) : null,
        error: null,
        pending: false,
      }))
    } else {
      setState((s) => ({ ...s, pending: false }))
    }
  }, [fail])

  const sendFlush = React.useCallback((batches: ChartWorkerBatch[]): void => {
    const w = workerRef.current
    const streamId = streamIdRef.current
    if (!w) {
      const stream = localRef.current
      if (!stream) return
      for (const b of batches) stream.push(resolveLocalBatch(b))
      batchesRef.current = []
      try {
        stream.flush()
        const scene = stream.scene()
        if (scene) setState((s) => ({ ...s, scene, svg: serializeRef.current ? renderSceneToSvg(scene) : null, error: null, pending: false }))
        statsRef.current = stream.stats()
        pulseRef.current = stream.pulse()
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
      return
    }
    const id = nextWorkerRequestId()
    batchesRef.current = []
    const request: ChartWorkerStreamRequest = {
      kind: 'stream', id, streamId, op: 'flush', batches, serialize: serializeRef.current,
    }
    try {
      w.postMessage(request)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  }, [fail, workerRef])

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
    const streamId = nextWorkerRequestId()
    streamIdRef.current = streamId
    const id = nextWorkerRequestId()
    lastApplied.current = id
    batchesRef.current = []
    setState((s) => ({ scene: null, svg: null, error: null, pending: true, generation: s.generation + 1 }))
    closedRef.current = false
    const w = workerRef.current
    const init = initialRef.current
    if (!w) {
      let stream: ChartStream
      try {
        stream = createChartStream(normalized, {
          capacity, policy,
          ...(init ? { initial: localInitial(init) } : {}),
        })
      } catch (e) {
        setState((s) => ({ ...s, scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), pending: false }))
        return
      }
      localRef.current = stream
      try {
        stream.flush()
        const scene = stream.scene()
        setState((s) => ({ ...s, scene, svg: serializeRef.current && scene ? renderSceneToSvg(scene) : null, error: null, pending: false }))
        statsRef.current = stream.stats()
        pulseRef.current = stream.pulse()
      } catch (e) {
        setState((s) => ({ ...s, scene: null, svg: null, error: e instanceof Error ? e : new Error(String(e)), pending: false }))
      }
      return () => {
        stream.close()
        if (localRef.current === stream) localRef.current = null
      }
    }
    localRef.current?.close()
    localRef.current = null
    let request: ChartWorkerStreamRequest
    try {
      if (init?.textMetrics != null) wireTextMetrics(init.textMetrics, true)
      request = {
        kind: 'stream', id, streamId, op: 'init', spec: normalized,
        options: { capacity, policy, ...(init ? { initial: init } : {}) },
        serialize: serializeRef.current,
      }
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
      return
    }
    const stop = listenToWorker(w, (event: MessageEvent<ChartWorkerStreamResponse>) => {
      const response = event.data
      if (response == null || response.kind !== 'stream' || response.streamId !== streamId) return
      apply(response)
    }, fail)
    try {
      w.postMessage(request)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
    return () => {
      stop()
      try { w.postMessage({ kind: 'stream', id: nextWorkerRequestId(), streamId, op: 'close' } satisfies ChartWorkerStreamRequest) } catch { /* terminated */ }
    }
  }, [normalized, capacity, policy, worker, workerRef, apply, fail])

  const push = React.useCallback((batch: ChartWorkerBatch): boolean => {
    if (closedRef.current) return false
    const local = localRef.current
    if (local) {
      const accepted = local.push(resolveLocalBatch(batch))
      if (accepted) scheduleFlush()
      return accepted
    }
    // Worker path: the producer-side buffer mirrors the stream's bounded queue
    // and policy, so what it accepts the worker will accept too.
    wireTextMetrics(batch.textMetrics, true)
    const buf = batchesRef.current
    if (queuePolicy === 'coalesce') {
      if (buf.length) buf[0] = mergeBatches(buf[0]!, batch)
      else buf.push(batch)
    } else {
      if (buf.length >= queueCapacity) {
        if (queuePolicy === 'drop-newest') return false
        if (queuePolicy === 'error') throw new AsterStreamBackpressureError(queueCapacity)
        while (buf.length >= queueCapacity) buf.shift()
      }
      buf.push(batch)
    }
    scheduleFlush()
    return true
  }, [queueCapacity, queuePolicy, scheduleFlush])

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
        w.postMessage({ kind: 'stream', id: nextWorkerRequestId(), streamId: streamIdRef.current, op: 'close' } satisfies ChartWorkerStreamRequest)
      } catch { /* terminated */ }
    }
  }, [workerRef])

  // Stable identities: they only read refs.
  const pulse = React.useCallback(() => pulseRef.current, [])
  const stats = React.useCallback(() => statsRef.current, [])
  const accepted = React.useCallback(() => acceptedRef.current, [])
  const rejected = React.useCallback(() => rejectedRef.current, [])
  const depth = React.useCallback(() => localRef.current?.stats().depth ?? batchesRef.current.length, [])

  return {
    ...state,
    push,
    flush,
    pulse,
    stats,
    accepted,
    rejected,
    depth,
    paused,
    pause,
    resume,
    close,
  }
}

/** Resolve a worker-style batch (text metrics by name) for an in-realm stream. */
function resolveLocalBatch(batch: ChartWorkerBatch): StreamBatch {
  const { textMetrics, ...rest } = batch
  return textMetrics != null ? { ...rest, textMetrics: resolveWorkerTextMetrics(textMetrics) } : rest
}

function localInitial(init: NonNullable<ChartWorkerStreamOptions['initial']>): NonNullable<StreamOptions['initial']> {
  const { textMetrics, ...rest } = init
  return textMetrics != null ? { ...rest, textMetrics: resolveWorkerTextMetrics(textMetrics) } : rest
}
