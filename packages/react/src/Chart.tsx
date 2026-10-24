import * as React from 'react'
import { ChartCore } from './ChartCore.js'
import { canvasCapability } from './canvas-capability.js'
import { interaction } from './interaction-capability.js'
import type { ChartHandle, ChartProps } from './chart-types.js'

export type { ChartHandle, ChartProps, ChartStreamInput } from './chart-types.js'

/**
 * The full chart: SVG and canvas, tooltips, selection, pan/zoom and the `signal.on` event loop, with
 * zero setup. A shell over `ChartCore` that injects every capability; the logic lives there, shared
 * with `<SvgChart>`.
 */
export const Chart = React.forwardRef<ChartHandle, ChartProps>(function Chart(props, ref) {
  return <ChartCore {...props} canvas={canvasCapability} interaction={interaction} ref={ref} />
})
