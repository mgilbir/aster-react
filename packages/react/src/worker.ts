/**
 * Optional worker offload for compile/evaluate/render (R11.4).
 *
 * A large spec can block the main thread for tens of milliseconds. This entry
 * exposes a small request/response protocol that runs the pure pipeline in a
 * Worker, returning the SVG and a structured-clone-safe scene (runtime handles
 * and functions are stripped). Hosts that cannot create a Worker — SSR, jsdom,
 * an older browser — transparently fall back to the synchronous pipeline.
 *
 * Protocol rules
 * - Every request carries an `id` drawn from one counter per JS realm
 *   (`nextWorkerRequestId`), shared by `useChartWorker` and
 *   `useChartWorkerStream`, so several hooks can share one Worker without
 *   matching each other's responses. Streams get ids from the same counter.
 * - Requests carry `limits` (budgets are enforced inside the worker) and
 *   `textMetrics`. A text-metrics provider holds functions and cannot cross
 *   `postMessage`, so the wire form is the NAME of a provider registered in the
 *   worker with `registerWorkerTextMetrics`; the synchronous fallback accepts
 *   either a name or a provider object.
 * - Worker `error` / `messageerror` events end the pending request with an error.
 */
import * as React from 'react'
import {
  AsterLimitError,
  checkSceneLimits, checkSpecLimits, checkSvgLength, compileChart, createChartStream,
  createLimitClock, evaluateChart, renderSceneToSvg,
  type ChartStream, type DataPulse, type SceneRoot, type SpecLimits, type StreamBatch,
  type StreamOptions, type StreamPolicy, type StreamStats, type TextMetricsProvider, type VgSpec,
} from '@aster/core'
import { normalizeChartSpec, useStableContent, useStableSpec } from './spec.js'
import { SCALE_INFO_KEY, serializeScales } from './serialScales.js'

/** Text metrics as named on the wire, or as an object for in-realm handling. */
export type WorkerTextMetrics = string | TextMetricsProvider

export interface ChartWorkerRequest {
  id: number
  spec: VgSpec
  input?: {
    data?: Record<string, unknown[]>
    width?: number
    height?: number
    signals?: Record<string, unknown>
    domainRaw?: Record<string, unknown[]>
    /** Budgets enforced inside the worker (same semantics as `renderSpec`). */
    limits?: SpecLimits
    /** Name of a provider registered with `registerWorkerTextMetrics`. */
    textMetrics?: WorkerTextMetrics
  }
}

export interface ChartWorkerResponse {
  id: number
  svg?: string
  scene?: SceneRoot
  error?: { name: string; message: string; code?: string }
}

// ---------------------------------------------------------------------------
// Ids and text-metrics registry
// ---------------------------------------------------------------------------

let idSeq = 0
/** Next request/stream id; unique per JS realm, shared by every worker hook. */
export function nextWorkerRequestId(): number {
  return ++idSeq
}

const textMetricsRegistry = new Map<string, TextMetricsProvider>()

/**
 * Register a text-metrics provider under a name (call this in the worker
 * entry). Hooks then refer to it as `textMetrics: 'name'`.
 */
export function registerWorkerTextMetrics(name: string, provider: TextMetricsProvider): void {
  textMetricsRegistry.set(name, provider)
}

/** Resolve a name (via the registry) or pass a provider object through. @internal */
export function resolveWorkerTextMetrics(tm: WorkerTextMetrics): TextMetricsProvider {
  return resolveTextMetrics(tm)!
}

function resolveTextMetrics(tm: WorkerTextMetrics | undefined): TextMetricsProvider | undefined {
  if (tm == null) return undefined
  if (typeof tm !== 'string') return tm
  const provider = textMetricsRegistry.get(tm)
  if (!provider) throw new Error(`[aster] unknown text-metrics provider "${tm}" (register it with registerWorkerTextMetrics in the worker)`)
  return provider
}

type WireError = { name: string; message: string; code?: string }

const wireError = (error: unknown): WireError => {
  const e = error instanceof Error ? error : new Error(String(error))
  return { name: e.name, message: e.message, code: (e as { code?: string }).code }
}

/** Rebuild an `Error` (typed `AsterLimitError` for budget violations) from the wire form. */
export function errorFromWire(wire: WireError): Error {
  const e = wire.code === 'ASTER_LIMIT'
    ? new AsterLimitError(wire.message.replace(/^\[aster\] limit exceeded: /, ''))
    : new Error(wire.message)
  if (wire.name && e.name !== wire.name && !(e instanceof AsterLimitError)) e.name = wire.name
  return e
}

// ---------------------------------------------------------------------------
// Scene cloning
// ---------------------------------------------------------------------------

/**
 * Copy of `node` without non-cloneable DOM-patcher caches; returns the SAME
 * object when nothing had to be removed, so a live scene is never mutated.
 */
function stripNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const n = node as { items?: unknown[]; __domDesc?: unknown }
  let items = n.items
  if (Array.isArray(n.items)) {
    let changed = false
    const mapped = n.items.map((child) => {
      const next = stripNode(child)
      if (next !== child) changed = true
      return next
    })
    if (changed) items = mapped
  }
  if (n.__domDesc === undefined && items === n.items) return node
  const copy = { ...(node as Record<string, unknown>) }
  delete copy.__domDesc
  if (items !== n.items) copy.items = items
  return copy
}

/**
 * Strip non-cloneable runtime/compiled handles from a scene. The live scene is
 * never mutated (a stream keeps it for the next incremental update).
 *
 * The plain-data scale snapshots (`__scales`) are kept so the host can build
 * accessibility labels from them, and the invertible continuous scales are
 * described under `__scaleInfo` so pan/zoom and brushing work on the clone.
 */
export function cloneableScene(scene: SceneRoot): SceneRoot {
  const clone = { ...scene } as SceneRoot & Record<string, unknown>
  delete clone.runtime
  delete clone.compiled
  delete clone.signalParams
  delete clone.__scaleMap
  clone[SCALE_INFO_KEY] = serializeScales(scene.__scaleMap)
  clone.items = scene.items.map((item) => stripNode(item)) as SceneRoot['items']
  return clone
}

// ---------------------------------------------------------------------------
// One-shot protocol
// ---------------------------------------------------------------------------

/** Pure request handler shared by the worker entry and the sync fallback. */
export function handleChartWorkerRequest(request: ChartWorkerRequest): ChartWorkerResponse {
  try {
    const spec = normalizeChartSpec(request.spec)
    const { textMetrics, ...rest } = request.input ?? {}
    const input = { ...rest, ...(textMetrics != null ? { textMetrics: resolveTextMetrics(textMetrics) } : {}) }
    const limits = input.limits
    // Same budget sequence as `renderSpec`.
    const clock = createLimitClock(limits)
    if (limits) checkSpecLimits(spec as unknown as Record<string, unknown>, limits)
    clock.check('compile')
    const chart = compileChart(spec)
    clock.check('evaluate')
    const scene = evaluateChart(chart, input)
    clock.check('evaluate')
    if (limits) checkSceneLimits(scene, limits)
    const svg = renderSceneToSvg(scene)
    clock.check('render')
    if (limits) checkSvgLength(svg, limits)
    return { id: request.id, svg, scene: cloneableScene(scene) }
  } catch (error) {
    return { id: request.id, error: wireError(error) }
  }
}

export interface ChartWorkerOptions {
  /** Supply a worker (e.g. from a bundler URL) or let the hook create one. */
  worker?: Worker | null
  /**
   * Factory used when `worker` is omitted. Return null to force the sync path.
   * It is called once per hook instance (and again only when `worker`
   * changes), so an inline arrow is safe: a new factory identity does NOT
   * recreate the worker.
   */
  workerFactory?: () => Worker | null
}

export interface WorkerChartResult {
  svg: string | null
  scene: SceneRoot | null
  error: Error | null
  pending: boolean
}

/**
 * Owns the Worker for a hook: the supplied `worker`, else one made by the
 * latest `workerFactory` on mount. Returns a ref the effects below read.
 * @internal
 */
export function useWorkerInstance(
  worker: Worker | null | undefined,
  workerFactory: (() => Worker | null) | undefined,
): React.MutableRefObject<Worker | null> {
  const workerRef = React.useRef<Worker | null>(null)
  const factoryRef = React.useRef(workerFactory)
  factoryRef.current = workerFactory
  React.useEffect(() => {
    if (worker !== undefined) {
      workerRef.current = worker
      return () => { workerRef.current = null }
    }
    const created = factoryRef.current ? factoryRef.current() : null
    workerRef.current = created
    return () => {
      created?.terminate?.()
      workerRef.current = null
    }
  }, [worker])
  return workerRef
}

/** Message/error listeners every worker hook needs; returns the cleanup. @internal */
export function listenToWorker(
  w: Worker,
  onMessage: (event: MessageEvent) => void,
  onFailure: (error: Error) => void,
): () => void {
  const onError = (event: Event): void => {
    const message = (event as ErrorEvent).message
    onFailure(new Error(message ? `[aster] worker error: ${message}` : '[aster] worker error'))
  }
  const onMessageError = (): void => {
    onFailure(new Error('[aster] worker message could not be deserialized (messageerror)'))
  }
  w.addEventListener('message', onMessage as EventListener)
  w.addEventListener('error', onError)
  w.addEventListener('messageerror', onMessageError)
  return () => {
    w.removeEventListener('message', onMessage as EventListener)
    w.removeEventListener('error', onError)
    w.removeEventListener('messageerror', onMessageError)
  }
}

/** Throw when a provider object would have to cross `postMessage`. @internal */
export function wireTextMetrics(tm: WorkerTextMetrics | undefined, viaWorker: boolean): WorkerTextMetrics | undefined {
  if (tm != null && typeof tm !== 'string' && viaWorker) {
    throw new Error('[aster] a textMetrics provider object cannot be sent to a worker; register it in the worker with registerWorkerTextMetrics and pass its name')
  }
  return tm
}

/**
 * Evaluate a chart off the main thread. On the server (or when workers are
 * unavailable) the same request is handled synchronously, so consumers do not
 * need two code paths.
 */
export function useChartWorker(spec: VgSpec, options: ChartWorkerOptions & {
  width?: number
  height?: number
  data?: Record<string, unknown[]>
  signals?: Record<string, unknown>
  domainRaw?: Record<string, unknown[]>
  /** Budgets enforced in the worker (or the sync fallback). */
  limits?: SpecLimits
  /**
   * Provider name registered in the worker (`registerWorkerTextMetrics`); an
   * object works only without a Worker. A name change re-measures; an object is
   * read when a request is made and is not itself a trigger (an inline
   * `{ measure }` literal would otherwise re-request on every render).
   */
  textMetrics?: WorkerTextMetrics
} = {}): WorkerChartResult {
  const { worker, workerFactory, width, height, data, signals, domainRaw, limits, textMetrics } = options
  const stableSpec = useStableSpec(spec)
  // Budgets are compared by content: an inline `limits={{...}}` must not
  // re-post the request on every render.
  const stableLimits = useStableContent(limits)
  const [state, setState] = React.useState<WorkerChartResult>({ svg: null, scene: null, error: null, pending: true })
  const workerRef = useWorkerInstance(worker, workerFactory)
  const idRef = React.useRef(0)
  const textMetricsRef = React.useRef(textMetrics)
  textMetricsRef.current = textMetrics
  const textMetricsKey = typeof textMetrics === 'string' ? textMetrics : textMetrics == null ? null : 'provider-object'

  React.useEffect(() => {
    const id = nextWorkerRequestId()
    const textMetrics = textMetricsRef.current
    idRef.current = id
    const w = workerRef.current
    const apply = (response: ChartWorkerResponse): void => {
      setState({
        svg: response.svg ?? null,
        scene: response.scene ?? null,
        error: response.error ? errorFromWire(response.error) : null,
        pending: false,
      })
    }
    const fail = (error: Error): void => {
      if (idRef.current === id) setState((s) => ({ ...s, error, pending: false }))
    }
    let request: ChartWorkerRequest
    try {
      request = {
        id, spec: stableSpec,
        input: {
          width, height, data, signals, domainRaw,
          ...(stableLimits ? { limits: stableLimits } : {}),
          ...(textMetrics != null ? { textMetrics: wireTextMetrics(textMetrics, w != null) } : {}),
        },
      }
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
      return
    }
    if (w == null) {
      apply(handleChartWorkerRequest(request))
      return
    }
    // A new request is in flight: surface it (keep the previous result meanwhile).
    setState((s) => (s.pending ? s : { ...s, pending: true }))
    const stop = listenToWorker(w, (event: MessageEvent<ChartWorkerResponse & { kind?: string }>) => {
      const response = event.data
      if (response == null || response.kind === 'stream' || response.id !== id) return
      apply(response)
    }, fail)
    try {
      w.postMessage(request)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
    return stop
  }, [stableSpec, width, height, data, signals, domainRaw, stableLimits, textMetricsKey, worker, workerRef])

  return state
}

// ---------------------------------------------------------------------------
// Stream protocol (R13)
// ---------------------------------------------------------------------------

/** A batch as sent to a worker: `textMetrics` travels by registered name. */
export type ChartWorkerBatch = Omit<StreamBatch, 'textMetrics'> & { textMetrics?: WorkerTextMetrics }

export interface ChartWorkerStreamRequest {
  kind: 'stream'
  id: number
  streamId: number
  op: 'init' | 'flush' | 'close'
  spec?: VgSpec
  options?: {
    capacity?: number
    policy?: StreamPolicy
    initial?: Omit<NonNullable<StreamOptions['initial']>, 'textMetrics'> & { textMetrics?: WorkerTextMetrics }
  }
  batches?: ChartWorkerBatch[]
  /**
   * Attach an SVG string to the response (default true). Hosts that render the
   * scene themselves send `false` and skip the per-flush serialization.
   */
  serialize?: boolean
}

export interface ChartWorkerStreamResponse {
  kind: 'stream'
  id: number
  streamId: number
  svg?: string
  scene?: SceneRoot
  pulse?: DataPulse
  stats?: StreamStats
  /** Batches accepted/rejected by the stream's backpressure policy. */
  accepted?: number
  rejected?: number
  /** Queued batches after the operation. */
  depth?: number
  closed?: boolean
  error?: { name: string; message: string; code?: string }
}

const streamResponse = (
  request: ChartWorkerStreamRequest,
  stream: ChartStream | null,
  extra: Partial<ChartWorkerStreamResponse> = {},
): ChartWorkerStreamResponse => {
  const scene = stream?.scene() ?? null
  return {
    kind: 'stream',
    id: request.id,
    streamId: request.streamId,
    ...(scene ? { scene: cloneableScene(scene) } : {}),
    ...(scene && request.serialize !== false ? { svg: renderSceneToSvg(scene) } : {}),
    ...(stream ? { pulse: stream.pulse() ?? { datasets: new Map(), structural: new Set() }, stats: stream.stats() } : {}),
    ...extra,
  }
}

function resolveBatch(batch: ChartWorkerBatch): StreamBatch {
  const { textMetrics, ...rest } = batch
  return textMetrics != null ? { ...rest, textMetrics: resolveTextMetrics(textMetrics) } : rest
}

/**
 * Pure handler for the streaming worker protocol. The caller owns the stream
 * map (the worker entry uses one per worker; tests can pass a fresh map).
 */
export function handleChartWorkerStreamRequest(
  request: ChartWorkerStreamRequest,
  streams: Map<number, ChartStream>,
): ChartWorkerStreamResponse {
  try {
    if (request.op === 'close') {
      const stream = streams.get(request.streamId)
      stream?.close()
      streams.delete(request.streamId)
      return { kind: 'stream', id: request.id, streamId: request.streamId, closed: true }
    }
    if (request.op === 'init') {
      streams.get(request.streamId)?.close()
      const initial = request.options?.initial
      const options: StreamOptions = {
        ...(request.options?.capacity != null ? { capacity: request.options.capacity } : {}),
        ...(request.options?.policy != null ? { policy: request.options.policy } : {}),
        ...(initial ? { initial: resolveBatchInitial(initial) } : {}),
      }
      const stream = createChartStream(normalizeChartSpec(request.spec ?? {}), options)
      streams.set(request.streamId, stream)
      stream.flush()
      return streamResponse(request, stream)
    }
    const stream = streams.get(request.streamId)
    if (!stream) throw new Error(`[aster] unknown stream ${request.streamId}`)
    let accepted = 0
    let rejected = 0
    for (const batch of request.batches ?? []) {
      if (stream.push(resolveBatch(batch))) accepted++
      else rejected++
    }
    stream.flush()
    return streamResponse(request, stream, { accepted, rejected, depth: stream.stats().depth })
  } catch (error) {
    return { kind: 'stream', id: request.id, streamId: request.streamId, error: wireError(error) }
  }
}

function resolveBatchInitial(
  initial: NonNullable<ChartWorkerStreamRequest['options']>['initial'] & object,
): NonNullable<StreamOptions['initial']> {
  const { textMetrics, ...rest } = initial
  return textMetrics != null ? { ...rest, textMetrics: resolveTextMetrics(textMetrics) } : rest
}

// ---------------------------------------------------------------------------
// Message validation (worker entry)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Validate and dispatch one worker message. Malformed messages never reach the
 * pipeline: a recognisable id gets a typed error response, anything else is
 * dropped (null) because there is nobody to answer.
 */
export function handleWorkerMessage(
  data: unknown,
  streams: Map<number, ChartStream>,
): ChartWorkerResponse | ChartWorkerStreamResponse | null {
  if (!isRecord(data) || !isId(data.id)) return null
  const bad = (message: string): ChartWorkerResponse | ChartWorkerStreamResponse =>
    data.kind === 'stream' && isId(data.streamId)
      ? { kind: 'stream', id: data.id as number, streamId: data.streamId, error: { name: 'TypeError', message: `[aster] ${message}` } }
      : { id: data.id as number, error: { name: 'TypeError', message: `[aster] ${message}` } }
  if (data.kind === 'stream') {
    if (!isId(data.streamId)) return bad('stream request needs a numeric streamId')
    if (data.op !== 'init' && data.op !== 'flush' && data.op !== 'close') return bad(`unknown stream op ${String(data.op)}`)
    if (data.op === 'init' && !isRecord(data.spec)) return bad('stream init needs a spec object')
    if (data.batches !== undefined && (!Array.isArray(data.batches) || !data.batches.every(isRecord))) return bad('stream batches must be an array of objects')
    if (data.options !== undefined && !isRecord(data.options)) return bad('stream options must be an object')
    return handleChartWorkerStreamRequest(data as unknown as ChartWorkerStreamRequest, streams)
  }
  if (!isRecord(data.spec)) return bad('request needs a spec object')
  if (data.input !== undefined && !isRecord(data.input)) return bad('request input must be an object')
  return handleChartWorkerRequest(data as unknown as ChartWorkerRequest)
}
