/// <reference lib="webworker" />
import { handleChartWorkerRequest, type ChartWorkerRequest } from './worker.js'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
scope.onmessage = (event: MessageEvent<ChartWorkerRequest>): void => {
  scope.postMessage(handleChartWorkerRequest(event.data))
}
