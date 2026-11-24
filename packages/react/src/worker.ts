/**
 * Optional worker offload for compile/evaluate/render.
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
 * - Worker `error` / `messageerror` events name no request: they end the request in flight of each hook using the worker.
 * - Every request has a hard deadline (`ChartWorkerOptions.timeoutMs`): a worker that misses it is terminated and, when the
 *   hook made it, replaced (DECISIONS Q4).
 */
import * as React from 'react'
import {
  AsterLimitError,
  checkChartRows,
  checkUrlData,
  getStreamFlushFailure,
  checkSceneLimits, checkSpecLimits, checkSvgLength, compileChart, createChartStream,
  createLimitClock, evaluateChart, renderSceneToSvg, withLimits,
  type ChartStream, type DataPulse, type ImageUrlPolicy, type Logger, type SceneRoot, type SpecLimits, type StreamBatch,
  type StreamOptions, type StreamPolicy, type StreamStats, type TextMetricsProvider, type UrlDataMode, type VgSpec,
} from '@aster-charts/core'
import { loadAddons, missingAddons, type AddonName } from '@aster-charts/core/addons'
import { normalizeChartSpec, useStableContent, useStableSpec } from './spec.js'
import { useDataInput } from './inputs.js'
import { SCALE_INFO_KEY, serializeScales } from './serialScales.js'

/** The build's environment, as bundlers write it in (`process.env.NODE_ENV`); `process` may not exist at all (an unbundled import). */
declare const process: { env: { NODE_ENV?: string } }


/** Text metrics as named on the wire, or as an object for in-realm handling. */
export type WorkerTextMetrics = string | TextMetricsProvider

/**
 * Image URL policy as it travels: the data fields (`baseURL`, `protocols`) are sent
 * as they are; the functions (`allow`, `onDeny`) cannot cross `postMessage`, so they
 * are referred to by the name of a hook set registered in the worker with
 * `registerWorkerUrlPolicy`. In the same realm (sync fallback) a full
 * `ImageUrlPolicy` object works too.
 */
export type WorkerUrlPolicy = Pick<ImageUrlPolicy, 'baseURL' | 'protocols'> & { hooks?: string }
export type WorkerUrlPolicyInput = ImageUrlPolicy | WorkerUrlPolicy

export interface ChartWorkerRequest {
  id: number
  spec: VgSpec
  input?: {
    data?: Record<string, unknown[]>
    width?: number
    height?: number
    /** `containerSize()` in the spec's expressions, and the measured container (see `RuntimeInput`). */
    containerSize?: { width: number; height: number }
    measuredSize?: { width?: number; height?: number }
    signals?: Record<string, unknown>
    domainRaw?: Record<string, unknown[]>
    /** Budgets enforced inside the worker (same semantics as `renderSpec`). */
    limits?: SpecLimits
    /** Name of a provider registered with `registerWorkerTextMetrics`. */
    textMetrics?: WorkerTextMetrics
    /** Image URL policy; its functions travel as a `registerWorkerUrlPolicy` name. */
    urlPolicy?: WorkerUrlPolicyInput
    /** `'refuse'`: a spec with a url dataset is refused (`RuntimeInput.urlData`), before the worker imports any add-on. */
    urlData?: UrlDataMode
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

const urlPolicyRegistry = new Map<string, Pick<ImageUrlPolicy, 'allow' | 'onDeny'>>()

/**
 * Register the `allow`/`onDeny` functions of an image URL policy under a name (call
 * this in the worker entry). Hooks then send `urlPolicy: { hooks: 'name', ... }`.
 */
export function registerWorkerUrlPolicy(name: string, hooks: Pick<ImageUrlPolicy, 'allow' | 'onDeny'>): void {
  urlPolicyRegistry.set(name, hooks)
}

/** Turn a wire policy back into an `ImageUrlPolicy` (throws on an unknown hook name). @internal */
export function resolveWorkerUrlPolicy(policy: WorkerUrlPolicyInput | undefined): ImageUrlPolicy | undefined {
  if (policy == null) return undefined
  const { hooks, ...rest } = policy as WorkerUrlPolicy & ImageUrlPolicy
  if (hooks == null) return rest
  const named = urlPolicyRegistry.get(hooks)
  if (!named) throw new Error(`[aster] unknown url-policy hooks "${hooks}" (register them with registerWorkerUrlPolicy in the worker)`)
  return { ...rest, ...named }
}

/** Throw when a policy with functions would have to cross `postMessage`. @internal */
export function wireUrlPolicy(policy: WorkerUrlPolicyInput | undefined, viaWorker: boolean): WorkerUrlPolicyInput | undefined {
  const fns = policy as ImageUrlPolicy | undefined
  if (viaWorker && fns != null && (typeof fns.allow === 'function' || typeof fns.onDeny === 'function')) {
    throw new Error('[aster] a urlPolicy with allow/onDeny functions cannot be sent to a worker; register them in the worker with registerWorkerUrlPolicy and send { hooks: name, baseURL, protocols }')
  }
  return policy
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
  // Stable machine-readable codes (ASTER_STREAM_BACKPRESSURE, ASTER_URL_DENIED, ...) survive the wire.
  if (wire.code && (e as { code?: string }).code !== wire.code) Object.assign(e, { code: wire.code })
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
    const { textMetrics, urlPolicy, ...rest } = request.input ?? {}
    const input = {
      ...rest,
      ...(textMetrics != null ? { textMetrics: resolveTextMetrics(textMetrics) } : {}),
      ...(urlPolicy != null ? { urlPolicy: resolveWorkerUrlPolicy(urlPolicy) } : {}),
    }
    const limits = input.limits
    // Same budget sequence as `renderSpec`, inside one scope: the SVG is serialized under the same meter and clock
    // (its path-length checks included), and a violation a defensive catch swallowed still fails the request.
    const { svg, scene } = withLimits(limits, (meter) => {
      const clock = meter?.clock ?? createLimitClock(limits)
      if (limits) checkSpecLimits(spec as unknown as Record<string, unknown>, limits, input)
      clock.check('compile')
      const chart = compileChart(spec)
      clock.check('evaluate')
      const scene = evaluateChart(chart, input)
      clock.check('evaluate')
      if (limits) checkSceneLimits(scene, limits)
      const out = renderSceneToSvg(scene)
      clock.check('render')
      if (limits) checkSvgLength(out, limits)
      return { svg: out, scene }
    })
    return { id: request.id, svg, scene: cloneableScene(scene) }
  } catch (error) {
    return { id: request.id, error: wireError(error) }
  }
}

export interface ChartWorkerOptions {
  /**
   * Supply a worker (e.g. from a bundler URL). The hook does not own it: after a deadline (`timeoutMs`) it terminates it (it is
   * running away) and cannot make another, so the hook stays in the timeout error until you pass a new `worker`. Prefer
   * `workerFactory`, with which the hook makes a new worker itself.
   */
  worker?: Worker | null
  /**
   * Factory used when `worker` is omitted: the hook owns what it returns. Return null to force the sync path.
   * It is called once per hook instance, again when `worker` changes, and again after a deadline terminated the worker it
   * made; an inline arrow is safe: a new factory identity does NOT recreate the worker.
   */
  workerFactory?: () => Worker | null
  /**
   * The hard deadline of one request to the worker (a one-shot render, a stream's start or flush), in milliseconds. Default
   * 30 000. When it passes without an answer the worker is terminated (whatever it is doing, it is not answering: a runaway
   * evaluation, a hung import, a crashed script), the hook's `error` is an `AsterWorkerTimeoutError`
   * (`code: 'ASTER_WORKER_TIMEOUT'`) and `pending` is false, and a worker from `workerFactory` is replaced by a new one.
   * Every other hook using the terminated worker ends its own request in flight with the same error. Any finite number
   * above 0; `limits.maxTimeMs` is the friendly bound inside the worker, this is the one that holds when that one cannot.
   */
  timeoutMs?: number
}

/** The default of `ChartWorkerOptions.timeoutMs`. */
export const DEFAULT_WORKER_TIMEOUT_MS = 30_000

/**
 * A worker did not answer a request within the hook's deadline (`ChartWorkerOptions.timeoutMs`) and was terminated.
 * `code: 'ASTER_WORKER_TIMEOUT'`; `timeoutMs` is the deadline that passed.
 */
export class AsterWorkerTimeoutError extends Error {
  readonly code = 'ASTER_WORKER_TIMEOUT'
  readonly timeoutMs: number
  constructor(timeoutMs: number, message?: string) {
    super(message ?? `[aster] the worker did not answer within ${timeoutMs} ms and was terminated`)
    this.name = 'AsterWorkerTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Check `timeoutMs` (a finite number above 0, or undefined for the default). @internal */
export function workerTimeout(timeoutMs: unknown): number {
  if (timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs
  throw new TypeError(`[aster] timeoutMs must be a finite number of milliseconds above 0; got ${String(timeoutMs)}`)
}

export interface WorkerChartResult {
  svg: string | null
  scene: SceneRoot | null
  error: Error | null
  pending: boolean
}

/**
 * Every hook listening to a worker, by worker: what a terminated worker owes them (their request in flight ends with the
 * error). A worker terminated by a deadline is remembered, so a later request to it fails at once instead of waiting.
 */
const failures = new WeakMap<Worker, Set<(error: Error) => void>>()
const terminated = new WeakMap<Worker, Error>()

/** The error of a worker a deadline terminated, or null. @internal */
export function terminatedError(w: Worker): Error | null {
  return terminated.get(w) ?? null
}

/**
 * Terminate a worker that missed a deadline, and end every request in flight on it (all hooks listening to it). @internal
 */
export function terminateWorker(w: Worker, error: Error): void {
  if (terminated.has(w)) return
  terminated.set(w, error)
  try { w.terminate() } catch { /* already gone: the effect is the same */ }
  for (const fail of [...(failures.get(w) ?? [])]) fail(error)
}

/** The worker a hook uses, and the means to replace it after a deadline. @internal */
export interface WorkerInstance {
  /** The current worker (null: none, the sync path). */
  readonly ref: React.MutableRefObject<Worker | null>
  /** Increments each time the hook's own worker is replaced (an effect that talks to the worker depends on it). */
  readonly epoch: number
  /**
   * The current worker missed a deadline: terminate it and end every request in flight on it with `error`; a worker the hook
   * made (`workerFactory`) is replaced, a supplied one cannot be.
   */
  expire: (error: Error) => void
}

/**
 * Owns the Worker for a hook: the supplied `worker`, else one made by the
 * latest `workerFactory` on mount (and after a deadline). @internal
 */
export function useWorkerInstance(
  worker: Worker | null | undefined,
  workerFactory: (() => Worker | null) | undefined,
): WorkerInstance {
  const workerRef = React.useRef<Worker | null>(null)
  const factoryRef = React.useRef(workerFactory)
  factoryRef.current = workerFactory
  const ownedRef = React.useRef(false)
  const [epoch, setEpoch] = React.useState(0)
  React.useEffect(() => {
    if (worker !== undefined) {
      ownedRef.current = false
      workerRef.current = worker
      return () => { workerRef.current = null }
    }
    const created = factoryRef.current ? factoryRef.current() : null
    ownedRef.current = true
    workerRef.current = created
    return () => {
      // (the worker in use now: the one made here, or its replacement after a deadline)
      workerRef.current?.terminate?.()
      workerRef.current = null
    }
  }, [worker])
  const expire = React.useCallback((error: Error): void => {
    const w = workerRef.current
    if (w == null) return
    terminateWorker(w, error)
    if (!ownedRef.current) return
    workerRef.current = factoryRef.current ? factoryRef.current() : null
    setEpoch((n) => n + 1)
  }, [])
  return React.useMemo(() => ({ ref: workerRef, epoch, expire }), [epoch, expire])
}

/**
 * Message/error listeners every worker hook needs; returns the cleanup. `onFailure` hears the worker's `error` and
 * `messageerror` events (which carry no request id: the hook ends its own request in flight, if any) and its termination by
 * another hook's deadline. @internal
 */
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
  let set = failures.get(w)
  if (!set) failures.set(w, (set = new Set()))
  set.add(onFailure)
  return () => {
    w.removeEventListener('message', onMessage as EventListener)
    w.removeEventListener('error', onError)
    w.removeEventListener('messageerror', onMessageError)
    set.delete(onFailure)
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
  /** The container the spec is sized to (`containerSize()`); `measuredSize` is the one it fills (see `RuntimeInput`). */
  containerSize?: { width: number; height: number }
  measuredSize?: { width?: number; height?: number }
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
  /** Image URL policy; functions need a Worker-registered name (see `WorkerUrlPolicy`). Read at request time like `textMetrics`. */
  urlPolicy?: WorkerUrlPolicyInput
  /** `'refuse'`: a spec with a url dataset is refused before any add-on loads (`RuntimeInput.urlData`); `error` is the `AsterUrlError`. */
  urlData?: UrlDataMode
} = {}): WorkerChartResult {
  const { worker, workerFactory, width, height, limits, textMetrics, urlPolicy, urlData } = options
  // The React boundary's identity rule (inputs.ts): every request input that is data is compared by content (`data` by its
  // datasets' row arrays), so an inline `data={{ table: rows }}`, `signals={{ a: 1 }}`, `domainRaw`, `limits` or size literal
  // rebuilt by every render posts nothing new (C72: by identity, each render posted a full clone of spec and data, and without
  // a Worker the synchronous answer re-rendered into a loop).
  const dataInput = useDataInput(options.data)
  const data = dataInput.data
  const signals = useStableContent(options.signals)
  const domainRaw = useStableContent(options.domainRaw)
  const containerSize = useStableContent(options.containerSize)
  const measuredSize = useStableContent(options.measuredSize)
  const stableSpec = useStableSpec(spec)
  // The Vega spec a request handled here (no Worker) compiles to: once per spec, not once per request (a new size or data is a new
  // request for the same spec). A spec that does not compile is left to the request handler, which reports the error.
  const localSpec = React.useMemo(() => {
    try { return normalizeChartSpec(stableSpec) } catch { return undefined }
  }, [stableSpec])
  // Budgets are compared by content: an inline `limits={{...}}` must not
  // re-post the request on every render.
  const stableLimits = useStableContent(limits)
  const [state, setState] = React.useState<WorkerChartResult>({ svg: null, scene: null, error: null, pending: true })
  const instance = useWorkerInstance(worker, workerFactory)
  const workerRef = instance.ref
  const expireRef = React.useRef(instance.expire)
  expireRef.current = instance.expire
  const timeoutMs = options.timeoutMs
  const idRef = React.useRef(0)
  // (development builds: the rows this hook holds across renders are checked for in-place changes, see core's row-watch.ts; the
  // worker itself cannot see one -- each request hands it a structured clone and it keeps nothing -- and a render with the same
  // arrays posts nothing, so an in-place change would never reach it: the warning says why the chart did not follow)
  // (its owner is this hook's own ref: no hook of its own, nothing in a production build)
  try {
    if (process.env.NODE_ENV !== 'production') checkChartRows(idRef, localSpec ?? stableSpec, { data })
  } catch (e) {
    if (typeof process !== 'undefined') throw e
  }
  const textMetricsRef = React.useRef(textMetrics)
  textMetricsRef.current = textMetrics
  const urlPolicyRef = React.useRef(urlPolicy)
  urlPolicyRef.current = urlPolicy
  const urlPolicyKey = urlPolicy == null ? null : (urlPolicy as WorkerUrlPolicy).hooks ?? JSON.stringify([(urlPolicy as ImageUrlPolicy).baseURL, (urlPolicy as ImageUrlPolicy).protocols, typeof (urlPolicy as ImageUrlPolicy).allow, typeof (urlPolicy as ImageUrlPolicy).onDeny])
  const textMetricsKey = typeof textMetrics === 'string' ? textMetrics : textMetrics == null ? null : 'provider-object'

  React.useEffect(() => {
    const id = nextWorkerRequestId()
    const textMetrics = textMetricsRef.current
    const urlPolicy = urlPolicyRef.current
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
      // (invalid `data` is the result's error, through the same channel as an evaluation error)
      if (dataInput.error) throw dataInput.error
      request = {
        id, spec: stableSpec,
        input: {
          width, height, data, signals, domainRaw,
          ...(containerSize ? { containerSize } : {}),
          ...(measuredSize ? { measuredSize } : {}),
          ...(stableLimits ? { limits: stableLimits } : {}),
          ...(textMetrics != null ? { textMetrics: wireTextMetrics(textMetrics, w != null) } : {}),
          ...(urlPolicy != null ? { urlPolicy: wireUrlPolicy(urlPolicy, w != null) } : {}),
          ...(urlData !== undefined ? { urlData } : {}),
        },
      }
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
      return
    }
    if (w == null) {
      // No Worker: the request is handled here, so the add-ons the spec needs must be loaded in this realm first. A chart that
      // needs none (the common case) is handled in this very effect, as before; one that does applies when they arrive.
      let missing: readonly AddonName[] = []
      try {
        if (localSpec === undefined) throw new Error('the spec does not compile')
        const vega = localSpec
        request = { ...request, spec: vega }
        // a refused url dataset imports nothing: the handler reports the refusal
        checkUrlData(vega, urlData)
        missing = missingAddons(vega, { urlData })
      } catch { /* the request handler reports it */ }
      if (missing.length === 0) {
        apply(handleChartWorkerRequest(request))
        return
      }
      let cancelled = false
      loadAddons(missing).then(
        () => { if (!cancelled) apply(handleChartWorkerRequest(request)) },
        (e: unknown) => { if (!cancelled) fail(e instanceof Error ? e : new Error(String(e))) },
      )
      return () => { cancelled = true }
    }
    let deadline: number
    try {
      deadline = workerTimeout(timeoutMs)
    } catch (e) {
      fail(e as Error)
      return
    }
    const gone = terminatedError(w)
    if (gone) {
      // (a supplied worker a deadline terminated: nothing will answer; a new `worker` prop is the way back)
      fail(gone)
      return
    }
    // A new request is in flight: surface it (keep the previous result meanwhile).
    setState((s) => (s.pending ? s : { ...s, pending: true }))
    // `answered`: this request has its outcome (a response, a failure, the deadline). A worker `error` / `messageerror` event
    // names no request, so it ends only a request still in flight: a hook whose answer already came is not failed by another
    // hook's crash (C555).
    let answered = false
    const settle = (): boolean => {
      if (answered) return false
      answered = true
      clearTimeout(timer)
      return true
    }
    const stop = listenToWorker(w, (event: MessageEvent<ChartWorkerResponse & { kind?: string }>) => {
      const response = event.data
      if (response == null || response.kind === 'stream' || response.id !== id) return
      if (settle()) apply(response)
    }, (error) => { if (settle()) fail(error) })
    // The hard deadline (DECISIONS Q4): a worker that has not answered is terminated, replaced when the hook made it, and the
    // request fails with a typed error. The request is not sent again by itself: it is what ran away.
    const timer = setTimeout(() => {
      if (!settle()) return
      const error = new AsterWorkerTimeoutError(deadline)
      expireRef.current(error)
      fail(error)
    }, deadline)
    try {
      w.postMessage(request)
    } catch (e) {
      if (settle()) fail(e instanceof Error ? e : new Error(String(e)))
    }
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [stableSpec, localSpec, width, height, containerSize, measuredSize, data, dataInput.error, signals, domainRaw, stableLimits, textMetricsKey, urlPolicyKey, urlData, worker, workerRef, timeoutMs])

  return state
}

// ---------------------------------------------------------------------------
// Stream protocol
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
    /** Queued-row bound (`StreamOptions.maxQueuedRows`). */
    maxQueuedRows?: number
    policy?: StreamPolicy
    /** Budgets for every flush (`StreamOptions.limits`). */
    limits?: SpecLimits
    /** Registered provider name (`StreamOptions.textMetrics`). */
    textMetrics?: WorkerTextMetrics
    initial?: Omit<NonNullable<StreamOptions['initial']>, 'textMetrics' | 'urlPolicy' | 'logger' | 'random'> & { textMetrics?: WorkerTextMetrics; urlPolicy?: WorkerUrlPolicyInput }
    /**
     * Relay what the stream's evaluations log (a logger is a function and cannot cross `postMessage`): each response carries
     * the entries logged since the previous one, and the hook hands them to its `logger`.
     */
    log?: boolean
  }
  batches?: ChartWorkerBatch[]
  /** `limits` / `textMetrics` that apply from this flush on, outside the queue (they never take a batch's place). */
  config?: { limits?: SpecLimits; textMetrics?: WorkerTextMetrics }
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
  /**
   * Present when `error` is a failed flush: what was queued at the failure and how
   * many batches the worker discarded to recover (a failed flush is atomic, so
   * without the discard every later flush would fail with the same batch).
   */
  failure?: { batches: number; queuedRows: number; discarded: number }
  /** What the stream's evaluations logged since the previous response (when the stream was started with `log`). */
  logs?: WorkerLogEntry[]
}

/** One logger call made in the worker, as it crosses `postMessage`: its arguments cloned, an `Error` as `{ name, message }`. */
export interface WorkerLogEntry {
  level: 'error' | 'warn' | 'info' | 'debug'
  args: unknown[]
}

/** The log entries each worker stream's logger has collected and no response has carried yet. */
const streamLogs = new WeakMap<ChartStream, WorkerLogEntry[]>()

function wireLogArg(arg: unknown): unknown {
  if (arg instanceof Error) return { name: arg.name, message: arg.message }
  if (arg == null || typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg
  try {
    return structuredClone(arg)
  } catch {
    return String(arg)
  }
}

function collectingLogger(entries: WorkerLogEntry[]): Logger {
  const at = (level: WorkerLogEntry['level']) => (...args: unknown[]): void => { entries.push({ level, args: args.map(wireLogArg) }) }
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
}

/** Hand log entries relayed from a worker to a logger (an `Error` is rebuilt). @internal */
export function replayWorkerLogs(entries: readonly WorkerLogEntry[] | undefined, logger: Logger | undefined): void {
  if (!entries || !logger) return
  for (const { level, args } of entries) {
    const out = args.map((a) => (a != null && typeof a === 'object' && typeof (a as { message?: unknown }).message === 'string' && typeof (a as { name?: unknown }).name === 'string'
      ? Object.assign(new Error((a as { message: string }).message), { name: (a as { name: string }).name })
      : a))
    const fn = logger[level]
    if (typeof fn === 'function') fn.apply(logger, out)
  }
}

const streamResponse = (
  request: ChartWorkerStreamRequest,
  stream: ChartStream | null,
  extra: Partial<ChartWorkerStreamResponse> = {},
): ChartWorkerStreamResponse => {
  const scene = stream?.scene() ?? null
  const logs = stream ? streamLogs.get(stream) : undefined
  const drained = logs && logs.length ? logs.splice(0) : undefined
  return {
    kind: 'stream',
    id: request.id,
    streamId: request.streamId,
    ...(drained ? { logs: drained } : {}),
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
      const logs: WorkerLogEntry[] = []
      const initial = request.options?.log ? { ...request.options.initial, logger: collectingLogger(logs) } : request.options?.initial
      const options: StreamOptions = {
        ...(request.options?.capacity != null ? { capacity: request.options.capacity } : {}),
        ...(request.options?.maxQueuedRows != null ? { maxQueuedRows: request.options.maxQueuedRows } : {}),
        ...(request.options?.policy != null ? { policy: request.options.policy } : {}),
        ...(request.options?.limits ? { limits: request.options.limits } : {}),
        ...(request.options?.textMetrics != null ? { textMetrics: resolveTextMetrics(request.options.textMetrics) } : {}),
        ...(initial ? { initial: resolveBatchInitial(initial) } : {}),
      }
      const stream = createChartStream(normalizeChartSpec(request.spec ?? {}), options)
      streamLogs.set(stream, logs)
      streams.set(request.streamId, stream)
      try {
        stream.flush()
      } catch (error) {
        return streamFailure(request, stream, error)
      }
      return streamResponse(request, stream)
    }
    const stream = streams.get(request.streamId)
    if (!stream) throw new Error(`[aster] unknown stream ${request.streamId}`)
    let accepted = 0
    let rejected = 0
    try {
      // (config applies before the batches of this flush; it rides on the first one, whose own fields win, or alone when there is
      // none, so it never costs a batch its place in the stream's queue, which is empty when a flush arrives)
      const config = request.config
      const batches = (request.batches ?? []).slice()
      if (config && (config.limits || config.textMetrics != null)) {
        const fields: ChartWorkerBatch = {
          ...(config.limits ? { limits: config.limits } : {}),
          ...(config.textMetrics != null ? { textMetrics: config.textMetrics } : {}),
        }
        if (batches.length) {
          const first: Record<string, unknown> = { ...fields }
          for (const [k, v] of Object.entries(batches[0]!)) if (v !== undefined) first[k] = v
          batches[0] = first as ChartWorkerBatch
        } else {
          batches.push(fields)
        }
      }
      for (const batch of batches) {
        if (stream.push(resolveBatch(batch))) accepted++
        else rejected++
      }
      stream.flush()
    } catch (error) {
      return streamFailure(request, stream, error)
    }
    return streamResponse(request, stream, { accepted, rejected, depth: stream.stats().depth })
  } catch (error) {
    return { kind: 'stream', id: request.id, streamId: request.streamId, error: wireError(error) }
  }
}

/**
 * A failed push/flush leaves its batches queued (flush is atomic). Report what was
 * queued, then drop it so the next flush does not fail with the same batch forever.
 */
function streamFailure(request: ChartWorkerStreamRequest, stream: ChartStream, error: unknown): ChartWorkerStreamResponse {
  const info = getStreamFlushFailure(error) ?? { batches: stream.stats().depth, queuedRows: stream.stats().queuedRows }
  const discarded = stream.discard()
  const logs = streamLogs.get(stream)
  const drained = logs && logs.length ? logs.splice(0) : undefined
  return { kind: 'stream', id: request.id, streamId: request.streamId, error: wireError(error), failure: { ...info, discarded }, ...(drained ? { logs: drained } : {}) }
}

function resolveBatchInitial(
  initial: NonNullable<ChartWorkerStreamRequest['options']>['initial'] & object,
): NonNullable<StreamOptions['initial']> {
  const { textMetrics, urlPolicy, ...rest } = initial
  return {
    ...rest,
    ...(textMetrics != null ? { textMetrics: resolveTextMetrics(textMetrics) } : {}),
    ...(urlPolicy != null ? { urlPolicy: resolveWorkerUrlPolicy(urlPolicy) } : {}),
  }
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

/**
 * A worker message with its spec normalized to Vega (a Vega-Lite spec is compiled here, once: the handler's own normalization of
 * the Vega spec it then gets returns it as it is) and the opt-in add-ons that
 * spec needs and this realm has not loaded. A message without a spec, or with an invalid one (the handler reports it), needs none;
 * nor does one whose `urlData: 'refuse'` (a request's `input`, a stream's `options.initial`) refuses its url datasets: nothing is
 * imported for it, and the handler answers with the refusal.
 */
export function prepareWorkerMessage(data: unknown): { data: unknown; missing: readonly AddonName[] } {
  if (!isRecord(data) || !isRecord(data.spec) || (data.kind === 'stream' && data.op !== 'init')) return { data, missing: [] }
  try {
    const spec = normalizeChartSpec(data.spec as VgSpec)
    const urlData = urlDataOf(data)
    checkUrlData(spec, urlData)
    return { data: { ...data, spec }, missing: missingAddons(spec, { urlData }) }
  } catch {
    return { data, missing: [] }
  }
}

/** The `urlData` a worker message carries: a one-shot request's `input.urlData`, a stream init's `options.initial.urlData`. */
function urlDataOf(data: Record<string, unknown>): UrlDataMode | undefined {
  const holder = data.kind === 'stream'
    ? (isRecord(data.options) && isRecord(data.options.initial) ? data.options.initial : undefined)
    : (isRecord(data.input) ? data.input : undefined)
  return holder?.urlData as UrlDataMode | undefined
}

/**
 * `handleWorkerMessage` for a worker that loads add-ons on demand: import what `prepareWorkerMessage` found missing, then handle
 * the message. An import that fails answers that message with a typed error. The worker entry runs messages one after another
 * (see worker-entry.ts), so a stream's `flush` never overtakes its `init`.
 */
export async function handleWorkerMessageWithAddons(
  data: unknown,
  missing: readonly AddonName[],
  streams: Map<number, ChartStream>,
): Promise<ChartWorkerResponse | ChartWorkerStreamResponse | null> {
  if (missing.length) {
    try {
      await loadAddons(missing)
    } catch (error) {
      if (!isRecord(data) || !isId(data.id)) return null
      return data.kind === 'stream' && isId(data.streamId)
        ? { kind: 'stream', id: data.id, streamId: data.streamId, error: wireError(error) }
        : { id: data.id, error: wireError(error) }
    }
  }
  return handleWorkerMessage(data, streams)
}

/**
 * The worker entry's message handler: handles messages in arrival order, importing the add-ons a message's spec needs first.
 * While one waits for an import, later messages queue behind it (a stream's `flush` must not overtake its `init`); with nothing
 * waiting, a message that needs no import is handled in the same turn, as it always was.
 */
export function createWorkerDispatcher(
  streams: Map<number, ChartStream>,
  post: (response: ChartWorkerResponse | ChartWorkerStreamResponse) => void,
): (message: unknown) => void {
  let waiting = 0
  let tail: Promise<void> = Promise.resolve()
  // Every response goes out through here. A `post` that throws (a response that cannot be structured-cloned: a host-registered
  // expression function or provider returned a function, say) answers that request with the error instead, so its hook is not
  // left waiting, and never escapes: on the queued path an escaping throw rejected the chain and every later message waited
  // behind it for good (C160). A post that fails twice (even the plain error cannot be sent) is reported as the worker's
  // `error` event, from a fresh task, and the next message is handled all the same.
  const deliver = (response: ChartWorkerResponse | ChartWorkerStreamResponse): void => {
    try {
      post(response)
    } catch (error) {
      const failed = { ...('kind' in response ? { kind: 'stream' as const, streamId: response.streamId } : {}), id: response.id, error: wireError(error) }
      try {
        post(failed as ChartWorkerResponse | ChartWorkerStreamResponse)
      } catch (again) {
        setTimeout(() => { throw again }, 0)
      }
    }
  }
  return (message) => {
    const { data, missing } = prepareWorkerMessage(message)
    if (waiting === 0 && missing.length === 0) {
      const response = handleWorkerMessage(data, streams)
      if (response != null) deliver(response)
      return
    }
    waiting++
    tail = tail.then(async () => {
      try {
        const response = await handleWorkerMessageWithAddons(data, missing, streams)
        if (response != null) deliver(response)
      } catch (error) {
        // (the handlers answer every failure themselves; a throw here would be a bug in them, and it must not stop the queue)
        if (isRecord(data) && isId(data.id)) {
          deliver(data.kind === 'stream' && isId(data.streamId)
            ? { kind: 'stream', id: data.id, streamId: data.streamId, error: wireError(error) }
            : { id: data.id, error: wireError(error) })
        }
      } finally {
        waiting--
      }
    })
  }
}
