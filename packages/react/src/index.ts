export { Chart } from './Chart.js'
export type { ChartHandle, ChartProps, TooltipInfo, TransitionOptions } from './Chart.js'
export type { PngOptions } from '@aster-charts/core/png'
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
// Vega-Lite compiler registry: `@aster-charts/react/vl` registers it as a side effect;
// hosts that compile VL themselves can call `registerVegaLiteCompiler` instead.
export {
  hasVegaLiteCompiler,
  registerVegaLiteCompiler,
  type VegaLiteCompiler,
} from './vl-registry.js'
// The opt-in core add-ons a spec needs (transforms, geo, load) are imported on demand by the shells and hooks; this is the
// same step for hosts that cannot wait inside React (a server that calls renderChartToStaticMarkup, a prefetch).
export { loadAddonsFor } from './addons.js'
// The parts of the engine a browser build loads on demand (a legend, a time scale, a colour ramp...), fetched ahead of time by an app
// that knows its charts need them (`import '@aster-charts/react/all'` bundles every part instead).
export { preloadParts } from './preload.js'
export type { EnginePart } from '@aster-charts/core/lean'
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
  positionalScales,
  type PositionalScales,
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
export { createChartSession } from './session.js'
export type { ChartSession } from '@aster-charts/core/dom'
