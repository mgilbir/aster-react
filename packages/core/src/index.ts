export type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledScale,
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
export { evaluateChart } from './runtime.js'
export { renderSceneToSvg } from './render.js'
export { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
export { buildScale, type Scale } from './scales.js'
export { applyTransforms, sortRows, type Row } from './transform.js'

import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { renderSceneToSvg } from './render.js'
import type { RuntimeInput, VgSpec } from './types.js'

/** Compile + evaluate + render a Vega spec to an SVG string (static mode). */
export function renderSpec(spec: VgSpec, input: RuntimeInput = {}): string {
  const chart = compileChart(spec)
  const scene = evaluateChart(chart, input)
  return renderSceneToSvg(scene)
}
