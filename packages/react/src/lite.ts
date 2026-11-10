/**
 * `@aster-charts/react/lite`: `<SvgChart>`, the SVG-only chart for size-sensitive apps. It never imports the
 * canvas renderer; hit testing and the signal event loop come only with `interaction`:
 *
 *   import { SvgChart } from '@aster-charts/react/lite'
 *   import { interaction } from '@aster-charts/react/interaction'
 *   <SvgChart spec={spec} interaction={interaction} tooltip />
 *
 * Same engine, same DOM as `<Chart renderer="svg">` (one shared implementation, ChartCore).
 */
export { SvgChart } from './SvgChart.js'
export type { SvgChartHandle, SvgChartProps } from './svg-chart-types.js'
export type { InteractionCapability } from './capabilities.js'
export type { TooltipInfo } from './chart-types.js'
