/// <reference lib="webworker" />
import type { ChartStream } from '@aster/core'
import {
  handleChartWorkerRequest,
  handleChartWorkerStreamRequest,
  type ChartWorkerRequest,
  type ChartWorkerStreamRequest,
} from './worker.js'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
const streams = new Map<number, ChartStream>()
scope.onmessage = (event: MessageEvent<ChartWorkerRequest | ChartWorkerStreamRequest>): void => {
  const data = event.data
  if ((data as ChartWorkerStreamRequest).kind === 'stream') {
    scope.postMessage(handleChartWorkerStreamRequest(data as ChartWorkerStreamRequest, streams))
  } else {
    scope.postMessage(handleChartWorkerRequest(data as ChartWorkerRequest))
  }
}
