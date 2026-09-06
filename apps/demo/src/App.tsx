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

const SPECS: Array<{ title: string; desc: string; spec: Record<string, unknown>; render: () => React.ReactNode; span?: string }> = [
  { title: 'Responsive Line', desc: 'Spec-level signals drive width/height; resizes with the container.', spec: CompiledLineSpec, render: () => <ResponsiveLine /> },
  { title: 'Bound Parameter', desc: 'A bound signal updates Y values live via the slider.', spec: CompiledParamBoundSpec, render: () => <BoundParam /> },
  { title: 'Interactive Brush', desc: 'Drag to select a data interval; persisted via the brush prop.', spec: CompiledInteractiveBrushSpec, render: () => <InteractiveBrush /> },
  { title: 'Histogram', desc: 'Bar encoding with bin:true auto-bins occurrences.', spec: CompiledHistogramSpec, render: () => <Histogram />, span: 'wide' },
  { title: 'Scatter + Legend', desc: 'Color encodes a category dimension with an automatic legend.', spec: CompiledLegendScatterSpec, render: () => <LegendScatter /> },
  { title: 'Pie / Donut', desc: 'Arc marks with innerRadius render donuts; theta encodes value.', spec: CompiledPieSpec, render: () => <PieDonut /> },
  { title: 'Text Labels', desc: 'Text marks render a label at each (x, y) point.', spec: CompiledTextLabelSpec, render: () => <TextLabels /> },
  { title: 'Heatmap', desc: 'Band scales + a quantitative color scale render a gradient heatmap.', spec: CompiledHeatmapSpec, render: () => <Heatmap /> },
  { title: 'Stacked Bar', desc: 'Bars stacked per category with an automatic color legend.', spec: CompiledStackedBarSpec, render: () => <StackedBar /> },
  { title: 'Layered Area + Line', desc: 'An area mark overlaid with a line on shared scales.', spec: CompiledLayerSpec, render: () => <LayeredAreaLine />, span: 'wide' },
  { title: 'Donut Chart', desc: 'A larger innerRadius arc renders a donut with a legend.', spec: CompiledDonutSpec, render: () => <Donut /> },
  { title: 'Regression Line', desc: 'A regression transform fits a line to point data.', spec: CompiledRegressionSpec, render: () => <Regression /> },
  { title: 'Streamgraph', desc: 'Stacked areas offset around the center produce a streamgraph.', spec: CompiledStreamgraphSpec, render: () => <Streamgraph />, span: 'wide' },
  { title: 'Bubble Chart', desc: 'The size channel quantitatively scales marker area.', spec: CompiledBubbleSpec, render: () => <Bubble /> },
  { title: 'Candlestick', desc: 'Rule + bar layers render OHLC, colored by direction.', spec: CompiledCandlestickSpec, render: () => <Candlestick /> },
  { title: 'Color Scheme', desc: 'A nominal scale with an explicit palette drives color + legend.', spec: CompiledColorSchemeSpec, render: () => <ColorScheme /> },
  { title: 'Grouped Bar', desc: 'Bars grouped side-by-side via the xOffset channel.', spec: CompiledGroupedBarSpec, render: () => <GroupedBar /> },
  { title: 'Radar / Spider', desc: 'A raw Vega spec with radial axes and a polygon line.', spec: CompiledRadarSpec, render: () => <Radar />, span: 'wide' },
]

// ----- Interactive showcases of the reactive dataflow engine -----

function LiveDataChanges() {
  const [data, setData] = React.useState(() => Array.from({ length: 60 }, (_, i) => ({ x: i, y: 50 + Math.round(40 * Math.sin(i / 5)) })))
  const seed = React.useRef(0)
  React.useEffect(() => {
    const id = window.setInterval(() => {
      seed.current++
      const changed = (seed.current * 7) % data.length
      setData((prev) => prev.map((r, i) => (i === changed ? { ...r, y: 10 + Math.round(80 * Math.random()) } : r)))
    }, 700)
    return () => window.clearInterval(id)
  }, [data.length])
  return (
    <div className="chart-container">
      <Chart spec={CompiledLineSpec} width={560} height={260} data={{ table: data }} dataChanges={{ table: [(seed.current * 7) % data.length] }} ariaLabel="Live incremental line chart" />
    </div>
  )
}

function TooltipDemo() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledLegendScatterSpec} width={480} height={300} tooltip ariaLabel="Scatter with tooltips" />
    </div>
  )
}

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
  const onSelect = React.useCallback((interval: SelectionInterval | null) => setBrush(interval), [])
  const clear = React.useCallback(() => setBrush(null), [])
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
        :root {
          --bg: #0b0f17; --bg-soft: #111826; --card: #141c2c; --border: #24304a;
          --text: #e8edf6; --muted: #93a1bd; --accent: #4f8cff; --accent2: #7aa2ff;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--text); background: radial-gradient(1200px 600px at 20% -10%, #16213b 0%, var(--bg) 55%) fixed; min-height: 100vh; }
        .app { max-width: 1160px; margin: 0 auto; padding: 0 1.5rem 4rem; }
        .hero { padding: 3.5rem 0 2.5rem; }
        .eyebrow { color: var(--accent2); font-size: 0.85rem; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; margin-bottom: 0.75rem; }
        h1 { font-size: clamp(2.2rem, 5vw, 3.2rem); line-height: 1.05; letter-spacing: -0.03em; }
        .subtitle { color: var(--muted); font-size: 1.15rem; margin-top: 0.9rem; max-width: 46rem; line-height: 1.6; }
        .hero-stats { display: flex; gap: 2rem; margin-top: 1.6rem; flex-wrap: wrap; }
        .hero-stats div { font-size: 0.9rem; color: var(--muted); }
        .hero-stats b { display: block; color: var(--text); font-size: 1.3rem; }
        nav.toc { position: sticky; top: 0; z-index: 20; display: flex; gap: 0.5rem; flex-wrap: wrap; padding: 0.9rem 0; backdrop-filter: blur(8px); background: rgba(11,15,23,0.7); border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; }
        nav.toc a { color: var(--muted); text-decoration: none; font-size: 0.85rem; padding: 0.35rem 0.7rem; border-radius: 999px; }
        nav.toc a:hover { color: var(--text); background: var(--bg-soft); }
        h2 { font-size: 1.5rem; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
        .section-head { margin: 2.5rem 0 1.25rem; }
        .section-head .desc { color: var(--muted); font-size: 0.95rem; max-width: 44rem; }
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
        .feature { background: linear-gradient(180deg, var(--card), var(--bg-soft)); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .feature h3 { font-size: 1.05rem; margin-bottom: 0.4rem; color: var(--accent2); }
        .feature p { color: var(--muted); font-size: 0.9rem; line-height: 1.55; }
        .showcase { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr)); gap: 1.25rem; }
        .showcase .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .showcase .card h3 { font-size: 1.05rem; margin-bottom: 0.4rem; }
        .showcase .card p { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.9rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); gap: 1.25rem; }
        .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .section.wide { grid-column: 1 / -1; }
        .section h2 { font-size: 1.05rem; margin-bottom: 0.25rem; }
        .section .desc { color: var(--muted); font-size: 0.88rem; margin-bottom: 0.75rem; line-height: 1.5; }
        .chart-container { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; display: flex; align-items: center; justify-content: center; overflow-x: auto; }
        .controls { margin-top: 0.5rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; color: var(--muted); }
        .controls input[type="range"] { width: 200px; accent-color: var(--accent); }
        button { background: var(--accent); color: #fff; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
        button:hover { background: var(--accent2); }
        .selection-info { font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; font-family: monospace; }
        footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
      `}</style>

      <header className="hero">
        <div className="eyebrow">Vega-compatible chart engine</div>
        <h1>Aster Charts</h1>
        <p className="subtitle">
          A fast, Vega/Vega-Lite-compatible chart engine for React. Accurate rendering, a tiny bundle,
          and a reactive dataflow that re-renders only the marks that changed.
        </p>
        <div className="hero-stats">
          <div><b>406+</b> conformance specs</div>
          <div><b>86 kB</b> gzip bundle</div>
          <div><b>~9x</b> faster stable updates</div>
          <div><b>0</b> leaks</div>
        </div>
      </header>

      <nav className="toc">
        <a href="#features">Features</a>
        <a href="#reactive">Reactive dataflow</a>
        <a href="#gallery">Gallery</a>
      </nav>

      <section id="features">
        <div className="section-head">
          <h2>Built to be exact, built to be fast</h2>
          <p className="desc">Aster renders Vega and Vega-Lite specs against the real Vega oracle, then optimizes the update path.</p>
        </div>
        <div className="features">
          <div className="feature"><h3>Oracle-verified</h3><p>Geometry diffed against the actual Vega renderer on a 400+ spec conformance corpus.</p></div>
          <div className="feature"><h3>Tiny &amp; tree-shakeable</h3><p>~86 kB gzip for the React chart, with geo, transforms, and the DOM patcher behind opt-in addons.</p></div>
          <div className="feature"><h3>Incremental DOM</h3><p>Patches only changed attributes and skips unchanged subtrees on updates.</p></div>
          <div className="feature"><h3>Reactive dataflow</h3><p>Per-datum updates re-derive only the changed rows, reusing unchanged marks, items, and scales.</p></div>
        </div>
      </section>

      <section id="reactive">
        <div className="section-head">
          <h2>Reactive dataflow — live</h2>
          <p className="desc">The charts below exercise the new reactive engine: a live per-datum update via <code>dataChanges</code>, and hover tooltips.</p>
        </div>
        <div className="showcase">
          <div className="card">
            <h3>Live incremental update</h3>
            <p>One point changes every 700ms. The engine re-derives only that row and reuses the rest — O(changed), not O(n).</p>
            <LiveDataChanges />
          </div>
          <div className="card">
            <h3>Hover tooltips</h3>
            <p>Hover any mark to read its datum, via <code>tooltip</code>.</p>
            <TooltipDemo />
          </div>
        </div>
      </section>

      <section id="gallery">
        <div className="section-head">
          <h2>Gallery</h2>
          <p className="desc">Every mark type, scale, axis, legend, and interaction, rendered by Aster.</p>
        </div>
        <div className="grid">
          {SPECS.map((s) => (
            <div key={s.title} className={`section ${s.span === 'wide' ? 'wide' : ''}`}>
              <h2>{s.title}</h2>
              <p className="desc">{s.desc}</p>
              {s.render()}
            </div>
          ))}
        </div>
      </section>

      <footer>Built with <a href="https://github.com/mgilbir/aster-react" style={{ color: 'var(--accent2)' }}>aster-react</a>.</footer>
    </div>
  )
}
