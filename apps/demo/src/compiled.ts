import * as vl from 'vega-lite'
import {
  LineSpec,
  ParamBoundSpec,
  InteractiveBrushSpec,
  HistogramSpec,
  LegendScatterSpec,
  PieSpec,
  TextLabelSpec,
  HeatmapSpec,
  StackedBarSpec,
  LayerSpec,
  DonutSpec,
  RegressionSpec,
  StreamgraphSpec,
} from './specs.js'

function compile(spec: Record<string, unknown>): Record<string, unknown> {
  return vl.compile(spec as never).spec as Record<string, unknown>
}

export const CompiledLineSpec = compile(LineSpec)
export const CompiledParamBoundSpec = compile(ParamBoundSpec)
export const CompiledInteractiveBrushSpec = compile(InteractiveBrushSpec)
export const CompiledHistogramSpec = compile(HistogramSpec)
export const CompiledLegendScatterSpec = compile(LegendScatterSpec)
export const CompiledPieSpec = compile(PieSpec)
export const CompiledTextLabelSpec = compile(TextLabelSpec)
export const CompiledHeatmapSpec = compile(HeatmapSpec)
export const CompiledStackedBarSpec = compile(StackedBarSpec)
export const CompiledLayerSpec = compile(LayerSpec)
export const CompiledDonutSpec = compile(DonutSpec)
export const CompiledRegressionSpec = compile(RegressionSpec)
export const CompiledStreamgraphSpec = compile(StreamgraphSpec)
