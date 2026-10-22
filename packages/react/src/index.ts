export { Chart } from './Chart.js'
export type { ChartHandle, ChartProps } from './Chart.js'
export {
  ChartStream,
  ChartWorkerStream,
  type ChartStreamHandle,
  type ChartStreamProps,
  type ChartWorkerStreamProps,
} from './ChartStream.js'
export {
  useChartStream,
  type UseChartStreamOptions,
  type UseChartStreamResult,
} from './useChartStream.js'
export {
  useChartWorkerStream,
  type ChartWorkerStreamOptions,
  type WorkerChartStreamResult,
} from './useChartWorkerStream.js'
export {
  isVegaLiteSpec,
  normalizeChartSpec,
  isPromiseLike,
} from './spec.js'
// Vega-Lite compiler registry: `@aster/react/vl` registers it as a side effect;
// hosts that compile VL themselves can call `registerVegaLiteCompiler` instead.
export {
  hasVegaLiteCompiler,
  registerVegaLiteCompiler,
  type VegaLiteCompiler,
} from './vl-registry.js'
export {
  useChart,
  useSpecData,
  useChartData,
  loadSpecData,
  loadSpecDataResource,
  type UseChartOptions,
  type UseChartResult,
  type UseSpecDataOptions,
} from './useChart.js'
export {
  useChartWorker,
  handleChartWorkerRequest,
  cloneableScene,
  type ChartWorkerOptions,
  type ChartWorkerRequest,
  type ChartWorkerResponse,
  type WorkerChartResult,
  handleChartWorkerStreamRequest,
  type ChartWorkerStreamRequest,
  type ChartWorkerStreamResponse,
} from './worker.js'
export {
  dragToDataInterval,
  selectionToPixels,
  selectValueToInterval,
  selectValueToDatum,
  domainOf,
  zoomDomain,
  panDomain,
  normalizeView,
  viewToDomainRaw,
  keyboardView,
  cursorZoom,
  continuousAxes,
  type SelectionInterval,
  type SelectValue,
  type ViewDomain,
  type PixelPoint,
} from './interaction.js'
export {
  renderChartToStaticMarkup,
  hydrateChart,
  type HydrateChartOptions,
  type HydratedChart,
} from './ssr.js'
export { createChartSession } from '@aster/core/dom'
export type { ChartSession } from '@aster/core/dom'
