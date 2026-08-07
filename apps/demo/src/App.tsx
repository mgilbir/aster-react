import * as React from 'react'
import {
  CompiledLineSpec,
  CompiledParamBoundSpec,
  CompiledInteractiveBrushSpec,
  CompiledHistogramSpec,
  CompiledLegendScatterSpec,
  CompiledPieSpec,
  CompiledTextLabelSpec,
  CompiledHeatmapSpec,
  CompiledStackedBarSpec,
  CompiledLayerSpec,
  CompiledDonutSpec,
  CompiledRegressionSpec,
  CompiledStreamgraphSpec,
  CompiledBubbleSpec,
  CompiledCandlestickSpec,
  CompiledColorSchemeSpec,
  CompiledGroupedBarSpec,
  CompiledRadarSpec,
} from './compiled'
import { Chart } from '@aster/react'
import type { SelectionInterval } from '@aster/react'

function Section({ title, desc, chart }: { title: string; desc: string; chart: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      <p className="desc">{desc}</p>
      <div className="chart-container">{chart}</div>
    </section>
  )
}

function ResponsiveLine() {
  return (
    <div style={{ width: '100%', height: 400 }}>
      <Chart spec={CompiledLineSpec} ariaLabel="Responsive line chart" />
    </div>
  )
}

function BoundParam() {
  const [shift, setShift] = React.useState(10)
  return (
    <>
      <div className="controls">
        <label>
          Shift:&nbsp;
          <input type="range" min={0} max={30} value={shift} onChange={(e) => setShift(+e.target.value)} />
          {shift}
        </label>
      </div>
      <div className="chart-container">
        <Chart spec={CompiledParamBoundSpec} ariaLabel="Shifted line chart" width={400} height={300} signals={{ shift }} />
      </div>
    </>
  )
}

function InteractiveBrush() {
  const [brush, setBrush] = React.useState<SelectionInterval | null>(null)
  const onSelect = React.useCallback((interval: SelectionInterval | null) => {
    setBrush(interval)
  }, [])
  const clear = React.useCallback(() => {
    setBrush(null)
  }, [])
  return (
    <>
      <div className="controls">
        <button onClick={clear}>Clear brush</button>
      </div>
      {brush && (
        <div className="selection-info">
          x: {brush.x?.map((v: number) => v.toFixed(1)).join(', ')} / y: {brush.y?.map((v: number) => v.toFixed(1)).join(', ')}
        </div>
      )}
      <div className="chart-container">
        <Chart spec={CompiledInteractiveBrushSpec} ariaLabel="Brush scatter" width={400} height={300} onSelect={onSelect} brush={brush} />
      </div>
    </>
  )
}

function Histogram() {
  return (
    <div className="chart-container" style={{ alignItems: 'flex-start' }}>
      <Chart spec={CompiledHistogramSpec} ariaLabel="Histogram" width={400} height={300} />
    </div>
  )
}

function LegendScatter() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledLegendScatterSpec} ariaLabel="Legend scatter" width={400} height={300} />
    </div>
  )
}

function PieDonut() {
  return (
    <div className="chart-container" style={{ alignItems: 'flex-start' }}>
      <Chart spec={CompiledPieSpec} ariaLabel="Pie/donut chart" width={200} height={200} />
    </div>
  )
}

function TextLabels() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledTextLabelSpec} ariaLabel="Text labels" width={400} height={300} />
    </div>
  )
}

function Heatmap() {
  return (
    <div className="chart-container" style={{ alignItems: 'flex-start' }}>
      <Chart spec={CompiledHeatmapSpec} ariaLabel="Heatmap" width={300} height={200} />
    </div>
  )
}

function StackedBar() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledStackedBarSpec} ariaLabel="Stacked bar" width={400} height={300} />
    </div>
  )
}

function LayeredAreaLine() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledLayerSpec} ariaLabel="Layered area + line" width={400} height={300} />
    </div>
  )
}

function Donut() {
  return (
    <div className="chart-container" style={{ alignItems: 'flex-start' }}>
      <Chart spec={CompiledDonutSpec} ariaLabel="Donut chart" width={200} height={200} />
    </div>
  )
}

function Regression() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledRegressionSpec} ariaLabel="Regression line" width={400} height={300} />
    </div>
  )
}

function Streamgraph() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledStreamgraphSpec} ariaLabel="Streamgraph" width={400} height={300} />
    </div>
  )
}

function Bubble() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledBubbleSpec} ariaLabel="Bubble chart" width={400} height={300} />
    </div>
  )
}

function Candlestick() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledCandlestickSpec} ariaLabel="Candlestick chart" width={400} height={300} />
    </div>
  )
}

function ColorScheme() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledColorSchemeSpec} ariaLabel="Color scheme scatter" width={400} height={300} />
    </div>
  )
}

function GroupedBar() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledGroupedBarSpec} ariaLabel="Grouped bar chart" width={400} height={300} />
    </div>
  )
}

function Radar() {
  return (
    <div className="chart-container" style={{ justifyContent: 'center' }}>
      <Chart spec={CompiledRadarSpec} ariaLabel="Radar spider chart" width={200} height={200} />
    </div>
  )
}

export function App() {
  return (
    <div className="app">
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; background: #fafafa; }
        .app { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
        h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
        .subtitle { color: #666; margin-bottom: 2rem; font-size: 1.05rem; }
        .section { margin-bottom: 2.5rem; }
        .section h2 { font-size: 1.25rem; margin-bottom: 0.25rem; }
        .desc { color: #555; margin-bottom: 0.75rem; font-size: 0.95rem; line-height: 1.5; }
        .chart-container { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 1rem; display: flex; overflow-x: auto; }
        .controls { margin-top: 0.5rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; color: #444; }
        .controls input[type="range"] { width: 200px; }
        button { background: #3b82f6; color: #fff; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
        button:hover { background: #2563eb; }
        .selection-info { font-size: 0.85rem; color: #555; margin-top: 0.5rem; font-family: monospace; }
      `}</style>
      <h1>Aster Charts</h1>
      <p className="subtitle">Chart engine demos — Vega/Vega-Lite specs rendered via React</p>
      <Section title="1. Responsive Line" desc="A line chart using spec-level signals for width/height. Resizes with the container via ResizeObserver." chart={<ResponsiveLine />} />
      <Section title="2. Bound Param — Shifted Line" desc="A line chart where a parameter 'shift' is bound to the range input below, shifting all Y values by delta." chart={<BoundParam />} />
      <Section title="3. Interactive Brush Selection" desc="Click and drag on the scatter plot to select a data interval. Persisted via the Chart's 'brush' prop. Click 'Clear' to reset." chart={<InteractiveBrush />} />
      <Section title="4. Histogram — Auto-Bin Binning" desc="The mark='bar' encoding with bin: true counts occurrences into bins automatically." chart={<Histogram />} />
      <Section title="5. Scatter Plot — Legend" desc="Color encodes the 'cat' dimension, generating an automatic legend on the right." chart={<LegendScatter />} />
      <Section title="6. Pie / Donut" desc="An arc mark with innerRadius renders a donut chart. Theta encodes 'value'; color encodes 'cat' with an automatic legend." chart={<PieDonut />} />
      <Section title="7. Text Labels" desc="The text mark renders a label string at each (x, y) point, sourced from the 'label' field." chart={<TextLabels />} />
      <Section title="8. Heatmap" desc="A rect mark with band scales for both axes and a quantitative color scale, rendered as a gradient heatmap with a color legend." chart={<Heatmap />} />
      <Section title="9. Stacked Bar" desc="Bars stacked per category via a color-encoded nominal dimension, with an automatic color legend." chart={<StackedBar />} />
      <Section title="10. Layered Area + Line" desc="A layer combining an area mark with an overlaid line mark on the same quantitative scales." chart={<LayeredAreaLine />} />
      <Section title="11. Donut Chart" desc="An arc mark with a larger innerRadius renders a donut with the theta channel encoding 'value' and color encoding 'cat'." chart={<Donut />} />
      <Section title="12. Regression Line" desc="A linear regression transform fits a line to the point data, overlaid as a line layer on the same axes." chart={<Regression />} />
      <Section title="13. Streamgraph" desc="Stacked area marks offset around the center (stack: 'center') produce a streamgraph over the temporal axis." chart={<Streamgraph />} />
      <Section title="14. Bubble Chart" desc="A point mark with the size channel encoding 'size' quantitatively scales the marker area, producing a bubble chart." chart={<Bubble />} />
      <Section title="15. Candlestick" desc="A layered rule (low-high wick) and bar (open-close body) renders a candlestick chart. Bar color is conditioned on the open/close relationship: green when close is above open, red otherwise." chart={<Candlestick />} />
      <Section title="16. Color Scheme Scatter" desc="A nominal color scale with an explicit range maps each category to a fixed palette, driving both marker color and the legend." chart={<ColorScheme />} />
      <Section title="17. Grouped Bar Chart" desc="Bars grouped side-by-side per category using the xOffset channel, with color encoding the group dimension." chart={<GroupedBar />} />
      <Section title="18. Radar / Spider Chart" desc="A raw Vega spec with radial axes and a polygon line connecting data points at each axis, with dots and labels." chart={<Radar />} />
    </div>
  )
}
