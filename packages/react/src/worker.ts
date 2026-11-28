/**
 * `@aster-charts/react/worker`: the public surface of the worker support (docs/API.md, "Workers"). The implementation is
 * `worker-impl.ts`; what the hooks share between them (the `Worker` a hook owns, the deadline plumbing, the wire checks) is exported
 * from there only, so it is on no public entry.
 */
export {
  AsterWorkerTimeoutError,
  DEFAULT_WORKER_TIMEOUT_MS,
  cloneableScene,
  createWorkerDispatcher,
  errorFromWire,
  handleChartWorkerRequest,
  handleChartWorkerStreamRequest,
  handleWorkerMessage,
  handleWorkerMessageWithAddons,
  nextWorkerRequestId,
  prepareWorkerMessage,
  registerWorkerTextMetrics,
  registerWorkerUrlPolicy,
  useChartWorker,
} from './worker-impl.js'
export type {
  ChartWorkerBatch,
  ChartWorkerOptions,
  ChartWorkerRequest,
  ChartWorkerResponse,
  ChartWorkerStreamRequest,
  ChartWorkerStreamResponse,
  WorkerChartResult,
  WorkerLogEntry,
  WorkerTextMetrics,
  WorkerUrlPolicy,
  WorkerUrlPolicyInput,
} from './worker-impl.js'
