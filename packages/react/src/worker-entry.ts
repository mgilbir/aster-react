/// <reference lib="webworker" />
import type { ChartStream } from '@aster/core'
import { createWorkerDispatcher } from './worker.js'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
const streams = new Map<number, ChartStream>()
// The dispatcher validates the message shape (malformed input with no usable id is dropped: there is nobody to answer) and
// imports, on demand, the opt-in add-ons (transforms, geo, load) a spec needs that this worker bundle did not import.
const dispatch = createWorkerDispatcher(streams, (response) => scope.postMessage(response))
scope.onmessage = (event: MessageEvent<unknown>): void => dispatch(event.data)
