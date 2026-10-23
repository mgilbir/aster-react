import * as React from 'react'
import { ChartCore } from './ChartCore.js'
import type { SvgChartHandle, SvgChartProps } from './svg-chart-types.js'

/**
 * The light chart: SVG only, no canvas renderer, and no hit index or signal event loop unless given
 * `interaction`. A shell over `ChartCore`, the same component `<Chart>` is; it injects nothing itself.
 */
export const SvgChart = React.forwardRef<SvgChartHandle, SvgChartProps>(function SvgChart(props, ref) {
  return <ChartCore {...props} ref={ref} />
})
