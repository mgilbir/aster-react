// Must COMPILE: what <SvgChart> accepts with and without `interaction`, and what <Chart> accepts.
import * as React from 'react'
import { Chart } from '../src/Chart.js'
import { SvgChart } from '../src/SvgChart.js'
import { interaction } from '../src/interaction-capability.js'
import type { SvgChartHandle } from '../src/svg-chart-types.js'
import { spec } from './shared.js'

const ref = React.createRef<SvgChartHandle>()

// no interaction: everything that does not need hit testing or the event loop
export const plain = (
  <SvgChart
    ref={ref} spec={spec} width={100} height={100} ariaLabel="x" className="c" style={{ color: 'red' }}
    data={{ t: [] }} signals={{ a: 1 }} incremental denseMarks="auto" a11y={false} interactive={false}
    onSelect={() => {}} brush={null} panZoom pan zoom view={null} onViewChange={() => {}} maxZoom={10}
    signalListeners={{ a: () => {} }} onSignal={() => {}} limits={{ maxRows: 10 }} onError={() => {}}
  />
)

// with interaction: the interaction props, typed exactly like <Chart>'s
export const rich = (
  <SvgChart
    spec={spec} interaction={interaction} tooltip renderTooltip={(d) => <i>{String(d.x)}</i>}
    onPointSelect={(d) => void d} selection={null} select={null} onSelectionChange={(v) => void v} preventDefault
  />
)

// <Chart> takes all of it, and the canvas renderer
export const full = <Chart spec={spec} tooltip renderer="canvas" onPointSelect={() => {}} />

// the handle is the same
export const handle = (): void => { ref.current?.setSignal('a', 1); ref.current?.getScene(); ref.current?.resetView() }
