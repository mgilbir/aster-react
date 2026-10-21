/**
 * Optional worker offload for compile/evaluate/render (R11.4).
 *
 * A large spec can block the main thread for tens of milliseconds. This entry
 * exposes a small request/response protocol that runs the pure pipeline in a
 * Worker, returning the SVG and a structured-clone-safe scene (runtime handles
 * and functions are stripped). Hosts that cannot create a Worker — SSR, jsdom,
 * an older browser — transparently fall back to the synchronous pipeline.
 */
import * as React from 'react'
import {
  compileChart, createChartStream, evaluateChart, renderSceneToSvg,
  type ChartStream, type DataPulse, type SceneRoot, type StreamBatch,
  type StreamOptions, type StreamPolicy, type StreamStats, type VgSpec,
} from '@aster/core'
import { normalizeChartSpec } from './spec.js'

export interface ChartWorkerRequest {
  id: number
  spec: VgSpec
  input?: {
    data?: Record<string, unknown[]>
    width?: number
    height?: number
    signals?: Record<string, unknown>
    domainRaw?: Record<string, unknown[]>
  }
}

export interface ChartWorkerResponse {
  id: number
  svg?: string
  scene?: SceneRoot
  error?: { name: string; message: string; code?: string }
}

/** Strip non-cloneable runtime/compiled handles from a scene. */
export function cloneableScene(scene: SceneRoot): SceneRoot {
  const strip = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    delete (node as { __scales?: unknown }).__scales
    delete (node as { __domDesc?: unknown }).__domDesc
    const items = (node as { items?: unknown[] }).items
    if (Array.isArray(items)) for (const item of items) strip(item)
  }
  const clone: SceneRoot = { ...scene, items: scene.items }
  delete (clone as { runtime?: unknown }).runtime
  delete (clone as { compiled?: unknown }).compiled
  delete (clone as { signalParams?: unknown }).signalParams
  delete (clone as { __scales?: unknown }).__scales
  delete (clone as { __scaleMap?: unknown }).__scaleMap
  for (const item of clone.items) strip(item)
  return clone
}

/** Pure request handler shared by the worker entry and the sync fallback. */
export function handleChartWorkerRequest(request: ChartWorkerRequest): ChartWorkerResponse {
  try {
    const spec = normalizeChartSpec(request.spec)
    const chart = compileChart(spec)
    const scene = evaluateChart(chart, request.input ?? {})
    return { id: request.id, svg: renderSceneToSvg(scene), scene: cloneableScene(scene) }
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error))
    return {
      id: request.id,
      error: { name: e.name, message: e.message, code: (e as { code?: string }).code },
    }
  }
}

export interface ChartWorkerOptions {
  /** Supply a worker (e.g. from a bundler URL) or let the hook create one. */
  worker?: Worker | null
  /** Factory used when `worker` is omitted. Return null to force the sync path. */
  workerFactory?: () => Worker | null
}

export interface WorkerChartResult {
  svg: string | null
  scene: SceneRoot | null
  error: Error | null
  pending: boolean
}

let requestSeq = 0

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
} = {}): WorkerChartResult {
  const { worker, workerFactory, width, height, data, signals, domainRaw, ...rest } = options
  void rest
  const [state, setState] = React.useState<WorkerChartResult>({ svg: null, scene: null, error: null, pending: true })
  const workerRef = React.useRef<Worker | null>(null)
  const idRef = React.useRef(0)

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

  React.useEffect(() => {
    const id = ++requestSeq
    idRef.current = id
    const request: ChartWorkerRequest = { id, spec, input: { width, height, data, signals, domainRaw } }
    const w = workerRef.current
    if (w == null) {
      const response = handleChartWorkerRequest(request)
      setState({
        svg: response.svg ?? null,
        scene: response.scene ?? null,
        error: response.error ? Object.assign(new Error(response.error.message), response.error) : null,
        pending: false,
      })
      return
    }
    const onMessage = (event: MessageEvent<ChartWorkerResponse>): void => {
      const response = event.data
      if (response.id !== idRef.current) return
      setState({
        svg: response.svg ?? null,
        scene: response.scene ?? null,
        error: response.error ? Object.assign(new Error(response.error.message), response.error) : null,
        pending: false,
      })
    }
    w.addEventListener('message', onMessage)
    w.postMessage(request)
    return () => w.removeEventListener('message', onMessage)
  }, [spec, width, height, data, signals, domainRaw])

  return state
}

// ---------------------------------------------------------------------------
// Stream protocol (R13)
// ---------------------------------------------------------------------------

export interface ChartWorkerStreamRequest {
  kind: 'stream'
  id: number
  streamId: number
  op: 'init' | 'flush' | 'close'
  spec?: VgSpec
  options?: {
    capacity?: number
    policy?: StreamPolicy
    initial?: StreamOptions['initial']
  }
  batches?: StreamBatch[]
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
    ...(scene ? { scene: cloneableScene(scene), svg: renderSceneToSvg(scene) } : {}),
    ...(stream ? { pulse: stream.pulse() ?? { datasets: new Map(), structural: new Set() }, stats: stream.stats() } : {}),
    ...extra,
  }
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
      const stream = createChartStream(normalizeChartSpec(request.spec ?? {}), request.options)
      streams.set(request.streamId, stream)
      stream.flush()
      return streamResponse(request, stream)
    }
    const stream = streams.get(request.streamId)
    if (!stream) throw new Error(`[aster] unknown stream ${request.streamId}`)
    let accepted = 0
    let rejected = 0
    for (const batch of request.batches ?? []) {
      if (stream.push(batch)) accepted++
      else rejected++
    }
    stream.flush()
    return streamResponse(request, stream, { accepted, rejected, depth: stream.stats().depth })
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error))
    return {
      kind: 'stream',
      id: request.id,
      streamId: request.streamId,
      error: { name: e.name, message: e.message, code: (e as { code?: string }).code },
    }
  }
}
