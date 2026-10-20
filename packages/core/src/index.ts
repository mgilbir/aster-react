export type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledProjection,
  CompiledScale,
  CompiledSignalDef,
  CompiledTitle,
  CompiledTransform,
  EncodeValue,
  RuntimeInput,
  SceneGroup,
  SceneItem,
  SceneNode,
  SceneRoot,
  ScaleDomain,
  ScaleRange,
  SizeSpec,
  SortSpec,
  VgSpec,
} from './types.js'
export { compileChart } from './compiler.js'
export { evaluateChart, getChartInfo } from './runtime.js'
export type { ChartInfo } from './runtime.js'
export { renderSceneToSvg } from './render.js'
// The canvas renderer ships as an opt-in addon (`@aster/core/canvas`): hosts
// that only need SVG never bundle it.
// The incremental DOM patcher ships as an opt-in addon (`@aster/core/dom`);
// string-mode hosts never need it. To keep the DOM path working without
// touching the addon entry, the re-exports live there.
export { type DomDesc } from './dom.js'
export { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
export { buildScale, type Scale } from './scales.js'
export { applyTransforms, sortRows, type Row } from './transform.js'
export { AsterLimitError, checkSpecLimits, checkSceneLimits, checkSvgLength, type SpecLimits } from './limits.js'
export { geoRegistry, transformRegistry, requireTransform, type GeoRegistry, type ContourFeature, type TransformFn } from './registry.js'
// The event-driven signal loop (`@aster/core/signals`: bindSceneSignals etc.)
// ships as an opt-in addon like the DOM patcher; hosts using signal.on streams
// import it explicitly.
// Geo projections (`@aster/core/geo`), the rare-layout transforms
// (`@aster/core/transforms`: kde/quantile/regression/loess, pack/partition/
// treemap, wordcloud, voronoi) and URL/text-format data loading
// (`@aster/core/load`: loadSpecData, csv/tsv/dsv/topojson) are optional
// addons so a plain bar/line/scatter chart never bundles them. Load an addon
// before rendering a spec that needs it.

import { compileChart } from './compiler.js'
import { evaluateChart, getChartInfo } from './runtime.js'
import { renderSceneToSvg } from './render.js'
import { checkSpecLimits, checkSceneLimits, checkSvgLength } from './limits.js'
import type { RuntimeInput, VgSpec } from './types.js'

/** Compile + evaluate + render a Vega spec to an SVG string (static mode). */
export function renderSpec(spec: VgSpec, input: RuntimeInput = {}): string {
  if (input.limits) checkSpecLimits(spec as unknown as Record<string, unknown>, input.limits)
  const chart = compileChart(spec)
  const scene = evaluateChart(chart, input)
  if (input.limits) checkSceneLimits(scene, input.limits)
  const svg = renderSceneToSvg(scene)
  if (input.limits) checkSvgLength(svg, input.limits)
  return svg
}
