/**
 * Worker-backed streaming chart. The worker owns the `ChartStream`; the main thread ships batches and receives scenes and
 * pulses. When no Worker is available the same hook keeps the stream in this realm, so hosts need one code path.
 *
 * The hook is a small state machine around ONE ordered producer queue (producerQueue.ts):
 *
 * - **No stream yet** (before the start effect, while the add-ons of the in-realm fallback load, between a restart's render
 *   and its effect): `push` queues under the stream's policy and answers truthfully; nothing is sent.
 * - **Starting**: the stream's `init` is in flight (worker) or the local stream is being made. Pushes queue.
 * - **Ready**: at most ONE request is in flight to the worker. An automatic flush (one per microtask or animation frame)
 *   takes the whole queue into one `flush` request; while it is unanswered, pushes keep queueing under the policy, so a slow
 *   or silent worker bounds the producer at the queue's bounds plus the one flush it is applying (C77). The local stream
 *   takes the queue the same way, synchronously.
 * - **Closed** (`close()`), **failed to start** (a spec that cannot be normalized, a start past the deadline), **unmounted**:
 *   `push` answers `false`; the queue is dropped.
 *
 * A push answered `true` is delivered, in order, to the stream it was queued for, or to the next stream if the stream is
 * restarted first (DECISIONS Q19); under `drop-oldest` a later push may displace it, as in the stream itself.
 *
 * The stream is keyed on the spec CONTENT (plus `capacity`/`policy`/`maxQueuedRows`, `initial.urlData` and the supplied
 * `worker`). A parent re-render with an equal inline `spec`, a new `workerFactory` arrow, a changed `serialize` or an equal
 * inline `limits` does not restart it and does not discard streamed rows.
 */
import * as React from 'react'
import {
  checkUrlData,
  createChartStream,
  getStreamFlushFailure,
  renderSceneToSvg,
  type ChartStream,
  type DataPulse,
  type Logger,
  type RuntimeInput,
  type SpecLimits,
  type StreamFlushFailure,
  type SceneRoot,
  type StreamBatch,
  type StreamOptions,
  type StreamStats,
  type VgSpec,
} from '@aster-charts/core'
import { loadAddons, missingAddons, type AddonName } from '@aster-charts/core/addons'
import { normalizeSpecResult, useStableContent, useStableSpec } from './spec.js'
import { useLatest, useStableLogger } from './inputs.js'
import { createProducerQueue, type ProducerQueue } from './producerQueue.js'
import {
  AsterWorkerTimeoutError,
  errorFromWire,
  listenToWorker,
  nextWorkerRequestId,
  replayWorkerLogs,
  resolveWorkerTextMetrics,
  resolveWorkerUrlPolicy,
  terminatedError,
  useWorkerInstance,
  wireTextMetrics,
  wireUrlPolicy,
  workerTimeout,
  type ChartWorkerBatch,
  type ChartWorkerOptions,
  type ChartWorkerStreamRequest,
  type ChartWorkerStreamResponse,
  type WorkerTextMetrics,
  type WorkerUrlPolicyInput,
} from './worker.js'

export interface ChartWorkerStreamOptions extends ChartWorkerOptions, Omit<StreamOptions, 'initial' | 'textMetrics'> {
  /**
   * First-flush input. Read when the stream is (re)created. `textMetrics` is a provider name registered in the worker (an
   * object only works without one); `urlPolicy` functions travel as a `registerWorkerUrlPolicy` name. `logger` hears what the
   * stream's evaluations log (relayed from the worker with each response). `random` is a function and cannot be sent to a
   * worker: with a Worker it is refused with an error, without one it is the stream's source of random numbers.
   */
  initial?: Omit<RuntimeInput, 'textMetrics' | 'urlPolicy' | 'previousScene'> & { textMetrics?: WorkerTextMetrics; urlPolicy?: WorkerUrlPolicyInput }
  /**
   * Host text measurement for every flush: a provider name registered in the worker (an object only works without one).
   * Overrides `initial.textMetrics`. A change applies from the next flush (it never restarts the stream); a stream cannot go
   * back to having none, so removing it keeps the last one: give another to replace it.
   */
  textMetrics?: WorkerTextMetrics
  /**
   * `capacity` (batches), `maxQueuedRows` (rows; default 5,000,000), `policy` and `limits` are the stream's own options (see
   * `StreamOptions`). The producer-side queue applies the same bounds, so `push()` answers truthfully, and the worker never
   * holds more than one flush of them. Under `coalesce` the queue holds one folded batch and only the row bound applies.
   * `limits` is compared by content; a change applies from the next flush, which it schedules (removing it applies `{}`).
   */
  limits?: SpecLimits
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
  /**
   * Set with a flush `error`: what was queued at the failure and how many batches the stream discarded so later flushes
   * recover (for a flush past the deadline, the batches of that flush). Null otherwise; cleared by the next successful flush.
   */
  flushFailure: (StreamFlushFailure & { discarded: number }) | null
  /** True until the current stream's first scene (or its failure). */
  pending: boolean
  /** Increments each time a stream is started (spec content, capacity, policy, maxQueuedRows or worker changed; a worker replaced after a deadline). */
  generation: number
  /**
   * Enqueue a batch. The producer-side queue applies the stream's `capacity`/`maxQueuedRows`/`policy`, so the answer is
   * final: `false` means the policy refused it (`error` throws `AsterStreamBackpressureError`), `true` means it will be
   * delivered, in order, also when it is pushed before the stream has started (under `drop-oldest` a later push may displace
   * it, as in the stream). After `close()` and after unmount it answers `false`.
   */
  push: (batch: ChartWorkerBatch) => boolean
  /** Send what is queued now (also while paused). With a flush in flight it is sent when that one is answered. */
  flush: () => void
  pulse: () => DataPulse | null
  stats: () => StreamStats | null
  /** Batches `push` accepted since the hook mounted. */
  accepted: () => number
  /** Batches that will not be delivered since the hook mounted: refused by `push`, or displaced by `drop-oldest`. */
  rejected: () => number
  /** Batches queued on this side, waiting for the next flush (a flush in flight is not counted). */
  depth: () => number
  /** Automatic flushing is paused (`pause()`); pushes keep queueing under the policy. Kept across a stream restart. */
  paused: boolean
  pause: () => void
  resume: () => void
  /** Stop this stream: drop what is queued, close it; `push` answers `false` until a new stream starts. */
  close: () => void
}

interface StreamUiState {
  scene: SceneRoot | null
  svg: string | null
  error: Error | null
  flushFailure: (StreamFlushFailure & { discarded: number }) | null
  pending: boolean
  generation: number
}

type UiFailure = StreamFlushFailure & { discarded: number }

/** A request to the worker that has not been answered. */
interface InFlight {
  id: number
  op: 'init' | 'flush'
  timer: ReturnType<typeof setTimeout>
  /** (flush) what it carries, reported if it fails by the deadline */
  batches: number
  rows: number
}

type Sink =
  | { kind: 'none' }
  | { kind: 'worker'; w: Worker; streamId: number; inFlight: InFlight | null }
  | { kind: 'local'; stream: ChartStream }

/** The config (`limits`, `textMetrics`) waiting for the next flush. */
interface Config { limits?: SpecLimits; textMetrics?: WorkerTextMetrics }

export function useChartWorkerStream(spec: VgSpec, options: ChartWorkerStreamOptions = {}): WorkerChartStreamResult {
  const {
    worker, workerFactory, capacity, policy, initial, maxQueuedRows, textMetrics,
    serialize = true, autoFlush = true, flushPolicy = 'microtask', timeoutMs,
  } = options
  const stableSpec = useStableSpec(spec)
  // Normalized inside the guard: a value that is not a spec, a Vega-Lite spec without the compiler or one it refuses is the
  // result's `error` (and `<ChartWorkerStream>`'s `onStreamError`), never a throw from render; no stream starts for it.
  const normalizedResult = React.useMemo(() => normalizeSpecResult(stableSpec), [stableSpec])
  const specError = normalizedResult.error
  const normalized = React.useMemo(() => normalizedResult.spec ?? ({} as VgSpec), [normalizedResult])
  const limits = useStableContent(options.limits)
  const [state, setState] = React.useState<StreamUiState>({ scene: null, svg: null, error: null, flushFailure: null, pending: true, generation: 0 })
  const instance = useWorkerInstance(worker, workerFactory)
  const workerRef = instance.ref
  const expireRef = useLatest(instance.expire)

  const bounds = {
    capacity: Math.max(1, capacity ?? 32),
    maxQueuedRows: Math.max(1, maxQueuedRows ?? 5_000_000),
    policy: policy ?? 'coalesce',
  } as const
  const queueRef = React.useRef<ProducerQueue | null>(null)
  queueRef.current ??= createProducerQueue(bounds)
  const queue = queueRef.current
  queue.setBounds(bounds)

  const sinkRef = React.useRef<Sink>({ kind: 'none' })
  const configRef = React.useRef<Config | null>(null)
  const sentConfig = React.useRef<{ limits: SpecLimits | undefined; textMetrics: WorkerTextMetrics | undefined }>({ limits, textMetrics })
  const statsRef = React.useRef<StreamStats | null>(null)
  const pulseRef = React.useRef<DataPulse | null>(null)
  const counts = React.useRef({ accepted: 0, refused: 0 })
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  /** This stream was closed, or could not start: pushes are refused until the next stream. */
  const closedRef = React.useRef(false)
  /** The hook unmounted (decided one microtask after the cleanup, so StrictMode's re-run of the effects keeps it alive). */
  const deadRef = React.useRef(false)
  const mountedRef = React.useRef(false)
  const scheduledRef = React.useRef(false)
  const frameRef = React.useRef<number | null>(null)
  /** An explicit `flush()` made while a flush was in flight: sent when that one is answered. */
  const flushWantedRef = React.useRef(false)
  const lastApplied = React.useRef(0)
  const serializeRef = useLatest(serialize)
  const initialRef = useLatest(initial)
  const textMetricsRef = useLatest(textMetrics)
  const limitsRef = useLatest(limits)
  const autoRef = useLatest({ autoFlush, flushPolicy, timeoutMs })
  // (unlike the rest of `initial`, whether url datasets are refused restarts the stream when it changes)
  const urlData = initial?.urlData
  const logger = useStableLogger(initial?.logger)
  const loggerRef = useLatest(logger)
  /** The inputs whose stream's start missed the deadline: it is not started again for them (a new input starts one). */
  const startTimedOut = React.useRef<readonly unknown[] | null>(null)
  /** A flush that missed the deadline: its error stays on the stream started afresh until that stream's first scene. */
  const carried = React.useRef<{ error: Error; flushFailure: UiFailure } | null>(null)

  React.useEffect(() => {
    mountedRef.current = true
    deadRef.current = false
    return () => {
      mountedRef.current = false
      cancelFrame()
      queueMicrotask(() => {
        if (mountedRef.current) return
        deadRef.current = true
        queueRef.current?.clear()
      })
    }
    // (cancelFrame only reads refs)
  }, [])

  function cancelFrame(): void {
    if (frameRef.current != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    scheduledRef.current = false
  }

  const fail = React.useCallback((error: Error, flushFailure: UiFailure | null = null): void => {
    if (!deadRef.current) setState((s) => ({ ...s, error, flushFailure, pending: false }))
  }, [])

  const showScene = React.useCallback((scene: SceneRoot | null, svg?: string): void => {
    if (deadRef.current) return
    setState((s) => ({
      ...s,
      scene,
      svg: serializeRef.current && scene ? (svg ?? renderSceneToSvg(scene)) : null,
      error: null,
      flushFailure: null,
      pending: false,
    }))
  }, [serializeRef])

  /** Config that changed since the stream last got it (null: none). */
  const takeConfig = (): Config | null => {
    const c = configRef.current
    configRef.current = null
    return c
  }

  // `pump`: send what is queued to the stream, if there is one and nothing is in flight. `force`: an explicit flush (also
  // while paused). Defined with refs only, so its identity is stable.
  const pumpRef = React.useRef<(force: boolean) => void>(() => {})
  const schedule = React.useCallback((): void => {
    const { autoFlush: auto, flushPolicy: align } = autoRef.current
    if (!auto || pausedRef.current || scheduledRef.current || deadRef.current) return
    scheduledRef.current = true
    const run = (): void => {
      scheduledRef.current = false
      frameRef.current = null
      if (!pausedRef.current) pumpRef.current(false)
    }
    if (align === 'raf' && typeof requestAnimationFrame === 'function') frameRef.current = requestAnimationFrame(run)
    else queueMicrotask(run)
  }, [autoRef])

  pumpRef.current = (force: boolean): void => {
    if (deadRef.current || closedRef.current) return
    const sink = sinkRef.current
    if (sink.kind === 'none') return
    if (sink.kind === 'local') {
      const config = takeConfig()
      const batches = queue.take()
      if (!batches.length && !config) return
      const stream = sink.stream
      try {
        if (config) stream.push(resolveLocalBatch(configBatch(config)))
        for (const b of batches) stream.push(resolveLocalBatch(b))
        stream.flush()
        statsRef.current = stream.stats()
        pulseRef.current = stream.pulse()
        showScene(stream.scene())
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e))
        const info = getStreamFlushFailure(e) ?? { batches: stream.stats().depth, queuedRows: stream.stats().queuedRows }
        fail(error, { ...info, discarded: stream.discard() })
      }
      return
    }
    if (sink.inFlight) {
      if (force) flushWantedRef.current = true
      return
    }
    const gone = terminatedError(sink.w)
    if (gone) {
      closedRef.current = true
      queue.clear()
      fail(gone)
      return
    }
    const rows = queue.rows()
    const batches = queue.take()
    const config = takeConfig()
    if (!batches.length && !config) return
    const id = nextWorkerRequestId()
    const request: ChartWorkerStreamRequest = {
      kind: 'stream', id, streamId: sink.streamId, op: 'flush', batches, serialize: serializeRef.current,
      ...(config ? { config } : {}),
    }
    sink.inFlight = startDeadline(sink, id, 'flush', batches.length, rows)
    try {
      sink.w.postMessage(request)
    } catch (e) {
      clearTimeout(sink.inFlight.timer)
      sink.inFlight = null
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  }

  /** Arm the hard deadline of a request (DECISIONS Q4). */
  function startDeadline(sink: Extract<Sink, { kind: 'worker' }>, id: number, op: InFlight['op'], batches: number, rows: number): InFlight {
    let ms: number
    try {
      ms = workerTimeout(autoRef.current.timeoutMs)
    } catch {
      ms = workerTimeout(undefined) // (an invalid timeoutMs is reported by the start effect; the default holds meanwhile)
    }
    const timer = setTimeout(() => {
      if (sink.inFlight?.id !== id || sinkRef.current !== sink) return
      sink.inFlight = null
      const error = new AsterWorkerTimeoutError(ms)
      // the worker is not answering: what it holds is lost; a stream whose start ran away is not started again for the same
      // inputs, one whose flush ran away is started afresh on the replacement worker (with what is still queued here)
      if (op === 'init') {
        startTimedOut.current = startKeyRef.current
        closedRef.current = true
        queue.clear()
        fail(error)
      } else {
        const flushFailure = { batches, queuedRows: rows, discarded: batches }
        carried.current = { error, flushFailure }
        fail(error, flushFailure)
      }
      expireRef.current(error)
    }, ms)
    return { id, op, timer, batches, rows }
  }

  const startKey = [normalized, specError, capacity, policy, maxQueuedRows, urlData, worker] as const
  const startKeyRef = useLatest<readonly unknown[]>(startKey)

  React.useEffect(() => {
    const streamId = nextWorkerRequestId()
    const id = nextWorkerRequestId()
    lastApplied.current = id
    sinkRef.current = { kind: 'none' }
    flushWantedRef.current = false
    configRef.current = null
    sentConfig.current = { limits: limitsRef.current, textMetrics: textMetricsRef.current }
    statsRef.current = null
    pulseRef.current = null
    const begin = (s: Partial<StreamUiState>): void => {
      setState((prev) => ({ scene: null, svg: null, error: null, flushFailure: null, pending: true, ...s, generation: prev.generation + 1 }))
    }
    if (specError) {
      // nothing to stream: pushes are refused (`false`) until the spec changes
      closedRef.current = true
      queue.clear()
      begin({ error: specError, pending: false })
      return
    }
    const timedOut = startTimedOut.current
    if (timedOut && timedOut.length === startKey.length && timedOut.every((v, i) => v === startKey[i])) {
      // (the start of this very stream missed the deadline: its error stands until an input changes)
      return
    }
    startTimedOut.current = null
    closedRef.current = false
    const carry = carried.current
    carried.current = null
    begin(carry ? { error: carry.error, flushFailure: carry.flushFailure } : {})
    const init = initialRef.current
    const w = workerRef.current
    try {
      workerTimeout(autoRef.current.timeoutMs)
    } catch (e) {
      closedRef.current = true
      fail(e as Error)
      return
    }
    if (!w) {
      // No Worker: the stream lives here, so the add-ons its spec needs are loaded in this realm before it is created (at
      // once for a chart that needs none, the common case). Pushes made meanwhile queue, and are the stream's first input.
      let cancelled = false
      let stream: ChartStream | null = null
      const start = (): void => {
        if (cancelled) return
        try {
          stream = createChartStream(normalized, {
            capacity, policy,
            ...(maxQueuedRows != null ? { maxQueuedRows } : {}),
            ...(limitsRef.current ? { limits: limitsRef.current } : {}),
            ...(textMetricsRef.current != null ? { textMetrics: resolveWorkerTextMetrics(textMetricsRef.current) } : {}),
            ...(init ? { initial: localInitial(init, loggerRef.current) } : {}),
          })
        } catch (e) {
          closedRef.current = true
          fail(e instanceof Error ? e : new Error(String(e)))
          return
        }
        sinkRef.current = { kind: 'local', stream }
        try {
          stream.flush()
          statsRef.current = stream.stats()
          pulseRef.current = stream.pulse()
          showScene(stream.scene())
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e))
          const info = getStreamFlushFailure(e) ?? { batches: stream.stats().depth, queuedRows: stream.stats().queuedRows }
          fail(error, { ...info, discarded: stream.discard() })
        }
        // what was pushed before the stream existed goes in first, in order (C49, C158)
        if (queue.depth() || configRef.current) schedule()
      }
      let missing: readonly AddonName[]
      try {
        // with `urlData: 'refuse'` a spec with a url dataset is refused before any add-on is imported
        checkUrlData(normalized, init?.urlData)
        missing = missingAddons(normalized, { urlData: init?.urlData })
      } catch (e) {
        closedRef.current = true
        fail(e instanceof Error ? e : new Error(String(e)))
        return
      }
      if (missing.length === 0) start()
      else loadAddons(missing).then(start, (e: unknown) => { if (!cancelled) { closedRef.current = true; fail(e instanceof Error ? e : new Error(String(e))) } })
      return () => {
        cancelled = true
        stream?.close()
        if (sinkRef.current.kind === 'local' && sinkRef.current.stream === stream) sinkRef.current = { kind: 'none' }
      }
    }
    let request: ChartWorkerStreamRequest
    try {
      const gone = terminatedError(w)
      if (gone) throw gone
      if (init?.textMetrics != null) wireTextMetrics(init.textMetrics, true)
      if (init?.urlPolicy != null) wireUrlPolicy(init.urlPolicy, true)
      if (textMetricsRef.current != null) wireTextMetrics(textMetricsRef.current, true)
      if (init?.random != null) {
        throw new Error('[aster] initial.random is a function and cannot be sent to a worker; without a Worker it is used as given')
      }
      const { logger: _logger, random: _random, ...wireInitial } = init ?? {}
      request = {
        kind: 'stream', id, streamId, op: 'init', spec: normalized,
        options: {
          capacity, policy,
          ...(maxQueuedRows != null ? { maxQueuedRows } : {}),
          ...(limitsRef.current ? { limits: limitsRef.current } : {}),
          ...(textMetricsRef.current != null ? { textMetrics: textMetricsRef.current } : {}),
          ...(init ? { initial: wireInitial } : {}),
          ...(loggerRef.current ? { log: true } : {}),
        },
        serialize: serializeRef.current,
      }
    } catch (e) {
      closedRef.current = true
      queue.clear()
      fail(e instanceof Error ? e : new Error(String(e)))
      return
    }
    const sink: Extract<Sink, { kind: 'worker' }> = { kind: 'worker', w, streamId, inFlight: null }
    sinkRef.current = sink
    const onResponse = (response: ChartWorkerStreamResponse): void => {
      if (sinkRef.current !== sink) return
      replayWorkerLogs(response.logs, loggerRef.current)
      const answered = sink.inFlight?.id === response.id
      if (answered) {
        clearTimeout(sink.inFlight!.timer)
        sink.inFlight = null
      }
      // (a late answer to a request already ended by a worker `error` event still applies: the stream was healthy)
      if (response.id >= lastApplied.current) {
        lastApplied.current = response.id
        if (response.stats) statsRef.current = response.stats
        if (response.pulse) pulseRef.current = response.pulse
        if (response.error) fail(errorFromWire(response.error), response.failure ?? null)
        else if (response.scene) showScene(response.scene, response.svg)
        else if (!deadRef.current) setState((s) => (s.pending ? { ...s, pending: false } : s))
      }
      if (!answered) return
      if (flushWantedRef.current) {
        flushWantedRef.current = false
        pumpRef.current(true)
      } else if (queue.depth() || configRef.current) {
        schedule()
      }
    }
    const stop = listenToWorker(w, (event: MessageEvent<ChartWorkerStreamResponse>) => {
      const response = event.data
      if (response == null || response.kind !== 'stream' || response.streamId !== streamId) return
      onResponse(response)
    }, (error) => {
      // A worker `error` / `messageerror` event (or its termination by another hook's deadline) names no request: it ends this
      // stream's request in flight, if there is one, and leaves an idle stream alone (C555).
      if (sinkRef.current !== sink || !sink.inFlight) return
      clearTimeout(sink.inFlight.timer)
      sink.inFlight = null
      fail(error)
    })
    sink.inFlight = startDeadline(sink, id, 'init', 0, 0)
    try {
      w.postMessage(request)
    } catch (e) {
      clearTimeout(sink.inFlight.timer)
      sink.inFlight = null
      closedRef.current = true
      fail(e instanceof Error ? e : new Error(String(e)))
    }
    return () => {
      stop()
      if (sink.inFlight) clearTimeout(sink.inFlight.timer)
      sink.inFlight = null
      if (sinkRef.current === sink) sinkRef.current = { kind: 'none' }
      try { w.postMessage({ kind: 'stream', id: nextWorkerRequestId(), streamId, op: 'close' } satisfies ChartWorkerStreamRequest) } catch { /* terminated */ }
    }
    // (the stream's key: `startKey`; the worker instance's epoch restarts it on a replacement worker)
  }, [...startKey, instance.epoch])

  // `limits` (by content) and `textMetrics` changes reach the live stream (C296): they wait, outside the queue, for the next
  // flush; a `limits` change schedules one. A textMetrics provider is compared by identity, so it only rides on a flush that
  // happens anyway: an inline provider object rebuilt by every render must not flush on every render.
  React.useEffect(() => {
    const sent = sentConfig.current
    if (sent.limits === limits && sent.textMetrics === textMetrics) return
    const next: Config = { ...configRef.current }
    if (sent.limits !== limits) next.limits = limits ?? {}
    if (sent.textMetrics !== textMetrics && textMetrics != null) next.textMetrics = textMetrics
    sentConfig.current = { limits, textMetrics }
    if (next.limits === undefined && next.textMetrics === undefined) return
    configRef.current = next
    if (sent.limits !== limits || typeof textMetrics === 'string') schedule()
  }, [limits, textMetrics, schedule])

  const push = React.useCallback((batch: ChartWorkerBatch): boolean => {
    if (deadRef.current || closedRef.current) return false
    // a provider object cannot cross to a worker (the in-realm stream takes one as is)
    if (sinkRef.current.kind === 'worker' || workerRef.current != null) wireTextMetrics(batch.textMetrics, true)
    let accepted: boolean
    try {
      accepted = queue.push(batch)
    } catch (e) {
      counts.current.refused++
      throw e
    }
    if (!accepted) {
      counts.current.refused++
      return false
    }
    counts.current.accepted++
    schedule()
    return true
  }, [queue, schedule, workerRef])

  const flush = React.useCallback((): void => { pumpRef.current(true) }, [])

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
    closedRef.current = true
    cancelFrame()
    queue.clear()
    configRef.current = null
    const sink = sinkRef.current
    if (sink.kind === 'local') sink.stream.close()
    else if (sink.kind === 'worker') {
      if (sink.inFlight) clearTimeout(sink.inFlight.timer)
      sink.inFlight = null
      try {
        sink.w.postMessage({ kind: 'stream', id: nextWorkerRequestId(), streamId: sink.streamId, op: 'close' } satisfies ChartWorkerStreamRequest)
      } catch { /* terminated */ }
    }
    // (cancelFrame only reads refs)
  }, [queue])

  // Stable identities: they only read refs.
  const pulse = React.useCallback(() => pulseRef.current, [])
  const stats = React.useCallback(() => statsRef.current, [])
  const acceptedCount = React.useCallback(() => counts.current.accepted, [])
  const rejectedCount = React.useCallback(() => counts.current.refused + queue.displaced(), [queue])
  const depth = React.useCallback(() => queue.depth(), [queue])

  return {
    ...state,
    push,
    flush,
    pulse,
    stats,
    accepted: acceptedCount,
    rejected: rejectedCount,
    depth,
    paused,
    pause,
    resume,
    close,
  }
}

/** The config fields as a batch (applied before the batches of a flush). */
function configBatch(config: Config): ChartWorkerBatch {
  return {
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.textMetrics != null ? { textMetrics: config.textMetrics } : {}),
  }
}

/** Resolve a worker-style batch (text metrics by name) for an in-realm stream. */
function resolveLocalBatch(batch: ChartWorkerBatch): StreamBatch {
  const { textMetrics, ...rest } = batch
  return textMetrics != null ? { ...rest, textMetrics: resolveWorkerTextMetrics(textMetrics) } : rest
}

function localInitial(init: NonNullable<ChartWorkerStreamOptions['initial']>, logger: Logger | undefined): NonNullable<StreamOptions['initial']> {
  const { textMetrics, urlPolicy, logger: _given, ...rest } = init
  return {
    ...rest,
    ...(logger ? { logger } : {}),
    ...(textMetrics != null ? { textMetrics: resolveWorkerTextMetrics(textMetrics) } : {}),
    ...(urlPolicy != null ? { urlPolicy: resolveWorkerUrlPolicy(urlPolicy) } : {}),
  }
}
