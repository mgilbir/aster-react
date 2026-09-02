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
export { patchSceneDom, renderSceneToDomElement, sceneToDomDesc, type DomDesc } from './dom.js'
export { createChartSession, type ChartSession } from './session.js'
export { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
export { buildScale, type Scale } from './scales.js'
export { applyTransforms, sortRows, type Row } from './transform.js'
export { geoRegistry, type GeoRegistry, type ContourFeature } from './registry.js'
// Geo projections (`@aster/core/geo`) and the `contour` transform are optional
// addons so a plain bar/line chart never bundles d3-geo / d3-contour. Load the
// addon before rendering a geo/contour spec: `await import('@aster/core/geo')`.

import { compileChart } from './compiler.js'
import { evaluateChart, getChartInfo } from './runtime.js'
import { renderSceneToSvg } from './render.js'
import type { RuntimeInput, VgSpec } from './types.js'

/** Compile + evaluate + render a Vega spec to an SVG string (static mode). */
export function renderSpec(spec: VgSpec, input: RuntimeInput = {}): string {
  const chart = compileChart(spec)
  const scene = evaluateChart(chart, input)
  return renderSceneToSvg(scene)
}
