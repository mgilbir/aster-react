/**
 * Worker-backed streaming chart component (`<ChartWorkerStream>`): `<ChartStream>` with the stream in a Web Worker (see
 * `ChartStream.tsx`, and why this is its own module). A `<ChartWorkerStream>` has no worker on the server and renders a
 * placeholder until it mounts.
 */
import * as React from 'react'
import type { VgSpec } from '@aster-charts/core'
import { Chart } from './Chart.js'
import {
  useSizeBatch, initialContainer, useSyncSize, useStreamInput, useInitialInput, useReportOnce, useNormalizedSpec,
  type ChartWorkerStreamHandle, type StreamErrorHandler, type CommonStreamProps,
} from './stream-shared.js'
import { useStableContent } from './spec.js'
import { useChartWorkerStream, type ChartWorkerStreamOptions } from './useChartWorkerStream.js'
export type { ChartWorkerStreamHandle } from './stream-shared.js'
import type { WorkerTextMetrics, WorkerUrlPolicyInput } from './worker.js'

export interface ChartWorkerStreamProps extends Omit<CommonStreamProps, 'textMetrics'> {
  spec: VgSpec
  /** Provider name registered in the worker (`registerWorkerTextMetrics`), or an object when no Worker is used. */
  textMetrics?: WorkerTextMetrics
  /** `urlPolicy` functions need a `registerWorkerUrlPolicy` name (`{ hooks, baseURL, protocols }`) with a Worker. */
  urlPolicy?: WorkerUrlPolicyInput
  streamOptions?: ChartWorkerStreamOptions
  onStreamError?: StreamErrorHandler
}

export const ChartWorkerStream = React.forwardRef<ChartWorkerStreamHandle, ChartWorkerStreamProps>(
  function ChartWorkerStream({
    spec, streamOptions, onStreamError, width, height, className, style,
    limits, textMetrics, urlPolicy, urlData, signals, view, random, onError, ...chartProps
  }, ref) {
    const size = useSizeBatch(width, height)
    const stableLimits = useStableContent(limits)
    const initialInput = useInitialInput(spec, signals, view)
    const vgSpec = useNormalizedSpec(spec)
    const stream = useChartWorkerStream(vgSpec, {
      ...streamOptions,
      serialize: false,
      // (`limits` and `textMetrics` follow their props: the hook takes a change to the live stream)
      ...(stableLimits ? { limits: stableLimits } : {}),
      ...(textMetrics ? { textMetrics } : {}),
      initial: {
        ...(streamOptions?.initial ?? {}),
        ...size,
        ...(initialContainer(size) ? { containerSize: initialContainer(size) } : {}),
        ...(urlPolicy ? { urlPolicy } : {}),
        ...(urlData !== undefined ? { urlData } : {}),
        // (the stream's evaluations log to the chart's logger, relayed from the worker; `random` is the stream's, and cannot
        // cross to a worker: with one it is refused with an error, without one it is used, C272)
        ...(chartProps.logger ? { logger: chartProps.logger } : {}),
        ...(random ? { random } : {}),
        ...initialInput,
      },
    })
    useSyncSize(stream.push, size)
    const onStreamInput = useStreamInput(stream.generation, stream.push, initialContainer(size))
    // The handle's `scene()` must read the latest scene without being rebuilt per frame.
    const sceneRef = React.useRef(stream.scene)
    sceneRef.current = stream.scene
    const { push, flush, pulse, stats, close } = stream
    React.useImperativeHandle(ref, () => ({
      push,
      flush,
      pending: () => null,
      pulse,
      stats,
      scene: () => sceneRef.current,
      close,
    }), [push, flush, pulse, stats, close])

    useReportOnce(stream.error, stream.flushFailure, onStreamError, onError)

    if (stream.error) {
      return <div role="alert" className={className} style={style} title={stream.error.message}>{stream.error.message}</div>
    }
    if (stream.scene == null) {
      return <div data-testid="chart-worker-stream-loading" className={className} style={style} />
    }
    return (
      <Chart
        {...chartProps}
        spec={vgSpec} width={width} height={height} className={className} style={style}
        signals={signals} view={view} onError={onError}
        sceneOverride={stream.scene} onStreamInput={onStreamInput}
      />
    )
  },
)
