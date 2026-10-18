import { compile } from '@aster/vl'
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
  BubbleSpec,
  CandlestickSpec,
  ColorSchemeSpec,
  GroupedBarSpec,
  RadarSpec,
} from './specs.js'

/**
 * Vega-Lite compilation for the demo runs through @aster/vl — the from-scratch
 * compiler in this repo. No npm vega-lite in the render path: the oracle column
 * on the page is the only place the official toolchain appears, and it is
 * lazy-loaded separately.
 */
function compileSpec(spec: Record<string, unknown>): Record<string, unknown> {
  return String(spec.$schema ?? '').includes('vega-lite')
    ? (compile(spec as never) as Record<string, unknown>)
    : spec
}

export const CompiledLineSpec = compileSpec(LineSpec)
export const CompiledParamBoundSpec = compileSpec(ParamBoundSpec)
export const CompiledInteractiveBrushSpec = compileSpec(InteractiveBrushSpec)
export const CompiledHistogramSpec = compileSpec(HistogramSpec)
export const CompiledLegendScatterSpec = compileSpec(LegendScatterSpec)
export const CompiledPieSpec = compileSpec(PieSpec)
export const CompiledTextLabelSpec = compileSpec(TextLabelSpec)
export const CompiledHeatmapSpec = compileSpec(HeatmapSpec)
export const CompiledStackedBarSpec = compileSpec(StackedBarSpec)
export const CompiledLayerSpec = compileSpec(LayerSpec)
export const CompiledDonutSpec = compileSpec(DonutSpec)
export const CompiledRegressionSpec = compileSpec(RegressionSpec)
export const CompiledStreamgraphSpec = compileSpec(StreamgraphSpec)
export const CompiledBubbleSpec = compileSpec(BubbleSpec)
export const CompiledCandlestickSpec = compileSpec(CandlestickSpec)
export const CompiledColorSchemeSpec = compileSpec(ColorSchemeSpec)
export const CompiledGroupedBarSpec = compileSpec(GroupedBarSpec)
// RadarSpec is a raw Vega spec — pass directly, no VL compile needed
export const CompiledRadarSpec = RadarSpec as Record<string, unknown>
