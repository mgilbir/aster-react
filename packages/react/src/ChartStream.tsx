/**
 * Streaming chart component (`<ChartStream>`).
 *
 * A thin shell over the existing `<Chart>`: the stream evaluates the
 * scene, and `<Chart sceneOverride={scene}>` runs the same SVG DOM patcher,
 * canvas renderer, interaction, tooltip and accessibility tree. No full SVG is
 * serialized per append. The stream is keyed on the spec content, so a parent
 * that rebuilds an equal inline spec does not discard streamed rows. The first
 * frame of `<ChartStream>` is part of the server-rendered HTML.
 *
 * `<ChartWorkerStream>` lives in `ChartWorkerStream.tsx`: this module must not reach the worker hook, which needs the whole
 * synchronous engine (a bundle that imports only `<ChartStream>` keeps the on-demand engine of `<Chart>`).
 */
import * as React from 'react'
import { Chart } from './Chart.js'
import {
  useSizeBatch, initialContainer, useSyncSize, useStreamInput, useInitialInput, useReportOnce, useNormalizedSpec,
  type ChartStreamHandle, type StreamErrorHandler, type CommonStreamProps,
} from './stream-shared.js'
import { useStableContent } from './spec.js'
import { useStableLogger } from './inputs.js'
import { useChartStream, type UseChartStreamOptions } from './useChartStream.js'
import type { VgSpec } from '@aster-charts/core'

export type { ChartStreamHandle, StreamErrorHandler } from './stream-shared.js'

export interface ChartStreamProps extends CommonStreamProps {
  spec: VgSpec
  /**
   * Stream options: `capacity`, `maxQueuedRows`, `policy`, `autoFlush`, ... The image
   * `urlPolicy` prop applies to every flush and is read when the stream is created; `urlData`
   * applies to every flush, and a change of it starts a new stream.
   */
  streamOptions?: UseChartStreamOptions
  onStreamError?: StreamErrorHandler
}

export const ChartStream = React.forwardRef<ChartStreamHandle, ChartStreamProps>(
  function ChartStream({
    spec, streamOptions, onStreamError, width, height, className, style,
    limits, textMetrics, urlPolicy, urlData, signals, view, random, onError, ...chartProps
  }, ref) {
    const size = useSizeBatch(width, height)
    const stableLimits = useStableContent(limits)
    const initialInput = useInitialInput(spec, signals, view)
    const vgSpec = useNormalizedSpec(spec)
    // (the stream's evaluations report to the chart's logger, as <Chart>'s do, through a latest-ref)
    const logger = useStableLogger(chartProps.logger)
    const stream = useChartStream(vgSpec, {
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
        ...(logger ? { logger } : {}),
        // (the stream evaluates, not the inner <Chart>: `random` is the stream's source of random numbers, C272)
        ...(random ? { random } : {}),
        ...initialInput,
      },
    })
    useSyncSize(stream.push, size)
    const onStreamInput = useStreamInput(stream.stream, stream.push, initialContainer(size))
    const { push, flush, pending, pulse, stats, stream: coreStream } = stream
    React.useImperativeHandle(ref, () => ({
      push,
      flush,
      pending,
      pulse,
      stats,
      scene: () => coreStream.scene(),
      close: () => coreStream.close(),
    }), [push, flush, pending, pulse, stats, coreStream])

    useReportOnce(stream.error, stream.flushFailure, onStreamError, onError)

    if (stream.error) {
      return <div role="alert" className={className} style={style} title={stream.error.message}>{stream.error.message}</div>
    }
    if (stream.scene == null) {
      return <div data-testid="chart-stream-loading" className={className} style={style} />
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
