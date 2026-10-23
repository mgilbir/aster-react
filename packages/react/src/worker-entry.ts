/// <reference lib="webworker" />
import type { ChartStream } from '@aster/core'
import { handleWorkerMessage } from './worker.js'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
const streams = new Map<number, ChartStream>()
// `handleWorkerMessage` validates the message shape; malformed input with no
// usable id is dropped (there is no one to answer) instead of reaching the pipeline.
scope.onmessage = (event: MessageEvent<unknown>): void => {
  const response = handleWorkerMessage(event.data, streams)
  if (response != null) scope.postMessage(response)
}
