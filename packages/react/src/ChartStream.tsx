/**
 * Streaming chart components (R13 / P0).
 *
 * These are thin shells over the existing `<Chart>`: the stream evaluates the
 * scene, and `<Chart sceneOverride={scene}>` runs the same SVG DOM patcher,
 * canvas renderer, interaction, tooltip and accessibility tree. No full SVG is
 * serialized per append.
 */
import * as React from 'react'
import type { SceneRoot, SpecLimits, StreamBatch, VgSpec } from '@aster/core'
import { Chart, type ChartProps, type ChartStreamInput } from './Chart.js'
import { positionalScales, viewToDomainRaw } from './interaction.js'
import { useStableContent } from './spec.js'
import {
  useChartStream,
  type UseChartStreamOptions,
} from './useChartStream.js'
import {
  useChartWorkerStream,
  type ChartWorkerStreamOptions,
} from './useChartWorkerStream.js'
import type { WorkerTextMetrics } from './worker.js'

/**
 * Props `<ChartStream>`/`<ChartWorkerStream>` take from `<Chart>`. Everything
 * that makes sense on a stream-fed chart works: `view`/`onViewChange`/`panZoom`/
 * `pan`/`zoom` and `signals` are routed into the stream (as `domainRaw` and
 * `signals` batches, so scales, marks and guides recompute inside the stream),
 * `limits`/`textMetrics` configure the stream's evaluation, and rendering,
 * selection, tooltip, a11y and event props go to the underlying `<Chart>`.
 * `data`/`dataChanges` are replaced by `push({ data | append })`.
 */
type CommonStreamProps = Omit<ChartProps, 'spec' | 'data' | 'dataChanges' | 'sceneOverride' | 'onStreamInput'>

export interface ChartStreamHandle {
  push: (batch: StreamBatch) => boolean
  flush: () => unknown
  pending: () => unknown
  pulse: () => unknown
  stats: () => unknown
  scene: () => SceneRoot | null
  close: () => void
}

export interface ChartStreamProps extends CommonStreamProps {
  spec: VgSpec
  streamOptions?: UseChartStreamOptions
  onStreamError?: (error: Error) => void
}

export interface ChartWorkerStreamProps extends Omit<CommonStreamProps, 'textMetrics'> {
  spec: VgSpec
  /** Provider name registered in the worker (`registerWorkerTextMetrics`), or an object when no Worker is used. */
  textMetrics?: WorkerTextMetrics
  streamOptions?: ChartWorkerStreamOptions
  onStreamError?: (error: Error) => void
}

function useSizeBatch(width: number | undefined, height: number | undefined): { width?: number; height?: number } {
  return React.useMemo(() => ({
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
  }), [width, height])
}

function useSyncSize(
  push: (batch: StreamBatch) => boolean,
  size: { width?: number; height?: number },
): void {
  const prev = React.useRef<{ width?: number; height?: number } | null>(null)
  React.useEffect(() => {
    const last = prev.current
    prev.current = size
    if (last == null) return
    if (last.width === size.width && last.height === size.height) return
    if (size.width == null && size.height == null) return
    push({ ...size })
  }, [push, size])
}

const sameValues = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => k in b && Object.is(a[k], b[k]))
}

/**
 * Forward what the inner `<Chart>` derives from its props and gestures (the
 * `domainRaw` of the pan/zoom view and the merged signal values) into the
 * stream. Only changes are pushed; a rebuilt stream is brought back up to date.
 */
function useStreamInput(
  stream: unknown,
  push: (batch: StreamBatch) => boolean,
): (input: ChartStreamInput) => void {
  const latest = React.useRef<ChartStreamInput | null>(null)
  const sent = React.useRef<{ stream: unknown; domainRaw: Record<string, unknown[]>; signals: Record<string, unknown> }>(
    { stream, domainRaw: {}, signals: {} },
  )
  const pushRef = React.useRef(push)
  pushRef.current = push
  const send = React.useCallback((input: ChartStreamInput, force: boolean): void => {
    const last = sent.current
    const domainRaw = input.domainRaw ?? {}
    const batch: StreamBatch = {}
    const domainChanged = Object.keys(domainRaw).length !== Object.keys(last.domainRaw).length
      || Object.entries(domainRaw).some(([k, v]) => JSON.stringify(last.domainRaw[k]) !== JSON.stringify(v))
    if (domainChanged || (force && Object.keys(domainRaw).length)) {
      const next: Record<string, unknown[] | null> = { ...domainRaw }
      for (const k of Object.keys(last.domainRaw)) if (!(k in domainRaw)) next[k] = null
      batch.domainRaw = next
    }
    const signals = input.signals
    if (!sameValues(signals, last.signals) || (force && Object.keys(signals).length)) batch.signals = signals
    sent.current = { stream: last.stream, domainRaw, signals }
    if (batch.domainRaw || batch.signals) pushRef.current(batch)
  }, [])
  React.useEffect(() => {
    if (sent.current.stream === stream) return
    // The stream was rebuilt (spec content changed): it starts from the spec
    // alone, so re-apply the current view/signals.
    sent.current = { stream, domainRaw: {}, signals: {} }
    if (latest.current) send(latest.current, true)
  }, [stream, send])
  return React.useCallback((input: ChartStreamInput): void => {
    latest.current = input
    send(input, false)
  }, [send])
}

/** Initial stream input derived from the chart props, so the first scene is already correct. */
function useInitialInput(
  spec: VgSpec,
  signals: Record<string, unknown> | undefined,
  view: ChartProps['view'],
): { signals?: Record<string, unknown>; domainRaw?: Record<string, unknown[]> } {
  const names = React.useMemo(() => positionalScales(spec), [spec])
  const domainRaw = React.useMemo(() => (view ? viewToDomainRaw(view, names) : undefined), [view, names])
  return React.useMemo(() => ({
    ...(signals ? { signals } : {}),
    ...(domainRaw ? { domainRaw } : {}),
  }), [signals, domainRaw])
}

/** Push `limits`/`textMetrics` changes into a live stream (the first values go in `initial`). */
function useStreamConfig<T>(
  push: (batch: { limits?: SpecLimits; textMetrics?: T }) => boolean,
  limits: SpecLimits | undefined,
  textMetrics: T | undefined,
  stream: unknown,
): void {
  const sent = React.useRef<{ stream: unknown; limits: unknown; textMetrics: unknown }>({ stream, limits, textMetrics })
  React.useEffect(() => {
    const last = sent.current
    if (last.stream !== stream) {
      // Rebuilt streams start from `initial`, which already carries these.
      sent.current = { stream, limits, textMetrics }
      return
    }
    const batch: { limits?: SpecLimits; textMetrics?: T } = {}
    if (last.limits !== limits && limits) batch.limits = limits
    if (last.textMetrics !== textMetrics && textMetrics != null) batch.textMetrics = textMetrics
    sent.current = { stream, limits, textMetrics }
    if (batch.limits || batch.textMetrics) push(batch)
  }, [push, stream, limits, textMetrics])
}

export const ChartStream = React.forwardRef<ChartStreamHandle, ChartStreamProps>(
  function ChartStream({
    spec, streamOptions, onStreamError, width, height, className, style,
    limits, textMetrics, signals, view, ...chartProps
  }, ref) {
    const size = useSizeBatch(width, height)
    const stableLimits = useStableContent(limits)
    const initialInput = useInitialInput(spec, signals, view)
    const stream = useChartStream(spec, {
      ...streamOptions,
      serialize: false,
      initial: {
        ...(streamOptions?.initial ?? {}),
        ...size,
        ...(stableLimits ? { limits: stableLimits } : {}),
        ...(textMetrics ? { textMetrics } : {}),
        ...initialInput,
      },
    })
    useSyncSize(stream.push, size)
    useStreamConfig(stream.push, stableLimits, textMetrics, stream.stream)
    const onStreamInput = useStreamInput(stream.stream, stream.push)
    React.useImperativeHandle(ref, () => ({
      push: stream.push,
      flush: stream.flush,
      pending: stream.pending,
      pulse: stream.pulse,
      stats: stream.stats,
      scene: () => stream.stream.scene(),
      close: () => stream.stream.close(),
    }), [stream])

    React.useEffect(() => {
      if (stream.error) onStreamError?.(stream.error)
    }, [stream.error, onStreamError])

    if (stream.error) {
      return <div role="alert" className={className} style={style} title={stream.error.message}>{stream.error.message}</div>
    }
    if (stream.scene == null) {
      return <div data-testid="chart-stream-loading" className={className} style={style} />
    }
    return (
      <Chart
        {...chartProps}
        spec={spec} width={width} height={height} className={className} style={style}
        signals={signals} view={view}
        sceneOverride={stream.scene} onStreamInput={onStreamInput}
      />
    )
  },
)

export const ChartWorkerStream = React.forwardRef<ChartStreamHandle, ChartWorkerStreamProps>(
  function ChartWorkerStream({
    spec, streamOptions, onStreamError, width, height, className, style,
    limits, textMetrics, signals, view, ...chartProps
  }, ref) {
    const size = useSizeBatch(width, height)
    const stableLimits = useStableContent(limits)
    const initialInput = useInitialInput(spec, signals, view)
    const stream = useChartWorkerStream(spec, {
      ...streamOptions,
      serialize: false,
      initial: {
        ...(streamOptions?.initial ?? {}),
        ...size,
        ...(stableLimits ? { limits: stableLimits } : {}),
        ...(textMetrics ? { textMetrics } : {}),
        ...initialInput,
      },
    })
    useSyncSize(stream.push, size)
    useStreamConfig<WorkerTextMetrics>(stream.push, stableLimits, textMetrics, stream.generation)
    const onStreamInput = useStreamInput(stream.generation, stream.push)
    React.useImperativeHandle(ref, () => ({
      push: stream.push,
      flush: stream.flush,
      pending: () => null,
      pulse: stream.pulse,
      stats: stream.stats,
      scene: () => stream.scene,
      close: stream.close,
    }), [stream])

    React.useEffect(() => {
      if (stream.error) onStreamError?.(stream.error)
    }, [stream.error, onStreamError])

    if (stream.error) {
      return <div role="alert" className={className} style={style} title={stream.error.message}>{stream.error.message}</div>
    }
    if (stream.scene == null) {
      return <div data-testid="chart-worker-stream-loading" className={className} style={style} />
    }
    return (
      <Chart
        {...chartProps}
        spec={spec} width={width} height={height} className={className} style={style}
        signals={signals} view={view}
        sceneOverride={stream.scene} onStreamInput={onStreamInput}
      />
    )
  },
)
