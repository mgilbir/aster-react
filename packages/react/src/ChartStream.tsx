/**
 * Streaming chart components (R13 / P0).
 *
 * These are thin shells over the existing `<Chart>`: the stream evaluates the
 * scene, and `<Chart sceneOverride={scene}>` runs the same SVG DOM patcher,
 * canvas renderer, interaction, tooltip and accessibility tree. No full SVG is
 * serialized per append.
 */
import * as React from 'react'
import type { SceneRoot, StreamBatch, VgSpec } from '@aster/core'
import { Chart, type ChartProps } from './Chart.js'
import {
  useChartStream,
  type UseChartStreamOptions,
} from './useChartStream.js'
import {
  useChartWorkerStream,
  type ChartWorkerStreamOptions,
} from './useChartWorkerStream.js'

type CommonStreamProps = Omit<ChartProps, 'spec' | 'data' | 'dataChanges' | 'sceneOverride'>

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

export interface ChartWorkerStreamProps extends CommonStreamProps {
  spec: VgSpec
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

export const ChartStream = React.forwardRef<ChartStreamHandle, ChartStreamProps>(
  function ChartStream({ spec, streamOptions, onStreamError, width, height, className, style, ...chartProps }, ref) {
    const size = useSizeBatch(width, height)
    const stream = useChartStream(spec, {
      ...streamOptions,
      serialize: false,
      initial: { ...(streamOptions?.initial ?? {}), ...size },
    })
    useSyncSize(stream.push, size)
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
    return <Chart {...chartProps} spec={spec} width={width} height={height} className={className} style={style} sceneOverride={stream.scene} />
  },
)

export const ChartWorkerStream = React.forwardRef<ChartStreamHandle, ChartWorkerStreamProps>(
  function ChartWorkerStream({ spec, streamOptions, onStreamError, width, height, className, style, ...chartProps }, ref) {
    const size = useSizeBatch(width, height)
    const stream = useChartWorkerStream(spec, {
      ...streamOptions,
      serialize: false,
      initial: { ...(streamOptions?.initial ?? {}), ...size },
    })
    useSyncSize(stream.push, size)
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
    return <Chart {...chartProps} spec={spec} width={width} height={height} className={className} style={style} sceneOverride={stream.scene} />
  },
)
