import * as vl from 'vega-lite'
import { LineSpec, ParamBoundSpec, InteractiveBrushSpec, HistogramSpec, LegendScatterSpec } from './specs.js'

function compile(spec: Record<string, unknown>): Record<string, unknown> {
  return vl.compile(spec as never).spec as Record<string, unknown>
}

export const CompiledLineSpec = compile(LineSpec)
export const CompiledParamBoundSpec = compile(ParamBoundSpec)
export const CompiledInteractiveBrushSpec = compile(InteractiveBrushSpec)
export const CompiledHistogramSpec = compile(HistogramSpec)
export const CompiledLegendScatterSpec = compile(LegendScatterSpec)
