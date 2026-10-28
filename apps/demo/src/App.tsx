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
import { compile } from '@aster/vl'
import { loadSpecData } from '@aster/core/load'
// The playground takes any spec, so it loads the opt-in addons an app would (rare transforms such as pie, and maps).
import '@aster/core/transforms'
import '@aster/core/geo'
import { Chart, ChartStream, type ChartStreamHandle } from '@aster/react'
import type { SelectionInterval } from '@aster/react'
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
import { SHOWCASE } from './showcase'

/**
 * The oracle column (official vega-embed) lives in its own chunk and streams
 * in after aster has painted. Until it arrives, panes show a loading note.
 */
const VegaPane = React.lazy(() => import('./VegaPane'))

function VegaLoading() {
  return <div className="vega-loading">loading the official vega renderer…</div>
}

const DEFAULT_SPEC = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 420,
  height: 300,
  padding: 5,
  data: { values: [{ c: 'A', v: 28 }, { c: 'B', v: 55 }, { c: 'C', v: 43 }, { c: 'D', v: 91 }, { c: 'E', v: 81 }, { c: 'F', v: 53 }] },
  mark: 'bar',
  encoding: {
    x: { field: 'c', type: 'nominal' },
    y: { field: 'v', type: 'quantitative' },
    color: { field: 'c', type: 'nominal', legend: null },
  },
}

/** Resolve a compiled spec's width/height, honoring a `height` signal (Vega's view height). */
function specSize(spec: Record<string, unknown>): { width?: number; height?: number } {
  const width = typeof spec.width === 'number' ? spec.width : undefined
  let height = typeof spec.height === 'number' ? spec.height : undefined
  const signals = (spec.signals as Array<Record<string, unknown>> | undefined) ?? []
  const heightSig = signals.find((s) => s.name === 'height')
  if (height == null && heightSig) {
    if (typeof heightSig.value === 'number') height = heightSig.value
    else if (typeof heightSig.update === 'string') {
      const src = signals.find((s) => s.name === heightSig.update)
      if (src && typeof src.value === 'number') height = src.value
    }
  }
  return { width, height }
}

// ---------------------------------------------------------------------------
// Two-column comparison card
// ---------------------------------------------------------------------------

/** A gallery card: the same spec input rendered by both engines side by side. */
function CompareCard({ title, desc, spec, aster, wide }: {
  title: string
  desc: string
  /** The raw input spec (Vega-Lite or Vega) — handed to the oracle verbatim. */
  spec: Record<string, unknown>
  /** The aster column: a rendered <Chart> (possibly interactive). */
  aster: React.ReactNode
  wide?: boolean
}) {
  const size = specSize(spec)
  return (
    <div className={`section ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      <p className="desc">{desc}</p>
      <div className="compare">
        <div className="pane">
          <div className="pane-head"><span className="badge oracle">vega / vega-lite</span></div>
          <div className="chart-container">
            <React.Suspense fallback={<VegaLoading />}>
              <VegaPane spec={spec} width={size.width} height={size.height} ariaLabel={`${title} — official vega`} />
            </React.Suspense>
          </div>
        </div>
        <div className="pane">
          <div className="pane-head"><span className="badge aster">aster · react</span></div>
          <div className="chart-container">{aster}</div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Streaming: identical append stream into the SVG DOM patcher and the canvas
// backend, side by side.
// ---------------------------------------------------------------------------

const STREAM_SPEC = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 560, height: 340, padding: 8, autosize: 'none', background: 'white',
  data: [{ name: 'table', values: [] as Array<{ x: number; y: number }> }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 1], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  axes: [
    { scale: 'x', orient: 'bottom', grid: true },
    { scale: 'y', orient: 'left', grid: true },
  ],
  marks: [{
    type: 'symbol', from: { data: 'table' },
    encode: { update: {
      x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' },
      size: { value: 26 }, fill: { value: '#4f8cff' }, opacity: { value: 0.75 },
    } },
  }],
} as Record<string, unknown>

const streamRows = (n: number, from = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => {
    const k = from + i
    return { x: (k % 997) / 997, y: ((k * 17) % 100) / 10 }
  })

function StreamingCompare() {
  const [running, setRunning] = React.useState(true)
  const [runId, setRunId] = React.useState(0)
  const [points, setPoints] = React.useState(3000)
  const [frames, setFrames] = React.useState<{ median: number; long: number; count: number }>({ median: 0, long: 0, count: 0 })
  const svgRef = React.useRef<ChartStreamHandle>(null)
  const canvasRef = React.useRef<ChartStreamHandle>(null)
  const nextRef = React.useRef(3000)
  const initial = React.useMemo(() => streamRows(3000), [runId])

  React.useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    const times: number[] = []
    let sinceStats = 0
    const loop = (): void => {
      const now = performance.now()
      const dt = now - last
      last = now
      if (dt > 0) times.push(dt)
      const batch = 1
      const rows = streamRows(batch, nextRef.current)
      nextRef.current += batch
      svgRef.current?.push({ append: { table: rows } })
      canvasRef.current?.push({ append: { table: rows } })
      sinceStats += batch
      if (sinceStats >= 60) {
        sinceStats = 0
        const sorted = times.slice(-240).sort((a, b) => a - b)
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0
        const long = times.slice(-240).filter((t) => t > 21).length
        setPoints(nextRef.current)
        setFrames({ median, long, count: Math.min(240, times.length) })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running, runId])

  const reset = (): void => {
    nextRef.current = 5000
    setPoints(5000)
    setFrames({ median: 0, long: 0, count: 0 })
    setRunId((n) => n + 1)
  }

  const pane = (renderer: 'svg' | 'canvas', ref: React.RefObject<ChartStreamHandle | null>, title: string) => (
    <div className="pane">
      <div className="pane-head"><span className={`badge ${renderer === 'canvas' ? 'aster' : 'oracle'}`}>{title}</span></div>
      <div className="chart-container">
        <ChartStream
          key={runId}
          ref={ref}
          spec={STREAM_SPEC}
          width={560}
          height={340}
          renderer={renderer}
          a11y={false}
          streamOptions={{ initial: { data: { table: initial } }, flushPolicy: 'raf', autoFlush: true }}
        />
      </div>
    </div>
  )

  return (
    <div className="section wide">
      <h2>Streaming — same append stream, two renderers</h2>
      <p className="desc">
        Both panes receive one row per animation frame through <code>ChartStream</code>.
        Left patches the SVG DOM; right paints only the appended mark items on canvas. Scales are fixed
        so this measures the render path, not scale-domain churn.
      </p>
      <div className="controls">
        <button onClick={() => setRunning((r) => !r)}>{running ? 'Pause' : 'Resume'}</button>
        <button onClick={reset}>Reset</button>
        <span>rows: {points.toLocaleString()}</span>
        <span>frame median: {frames.median ? frames.median.toFixed(1) : '—'} ms</span>
        <span>long frames: {frames.long} / {frames.count || '—'}</span>
      </div>
      <div className="compare">
        {pane('svg', svgRef, 'aster · svg dom patch')}
        {pane('canvas', canvasRef, 'aster · canvas')}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playground: one spec, both engines, live
// ---------------------------------------------------------------------------

/**
 * Relative data URLs resolve against the vega examples host by default
 * (vega-datasets), so specs like `data: { url: 'seattle-weather.csv' }` work
 * without editing. Absolute and data: URLs pass through untouched.
 */
const VEGA_DATA_BASES = [
  'https://vega.github.io/vega-datasets/data/',
  'https://vega.github.io/vega/data/',
]

/**
 * Official Vega examples write `"url": "data/stocks.csv"` (and occasionally
 * `"./data/..."`). The datasets host serves the file at `/data/stocks.csv`, so
 * strip the leading `data/` before joining the base; otherwise the request
 * becomes `.../data/data/stocks.csv` (404) and copy/pasting examples fails.
 */
function resolveDataUrl(u: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('data:')) return u
  const clean = u.replace(/^\.\//, '').replace(/^data\//, '')
  return VEGA_DATA_BASES[0]! + clean
}

function resolveDataUrls<T extends Record<string, unknown>>(spec: T): T {
  const out = structuredClone(spec)
  const seen = new WeakSet<object>()
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== 'object' || seen.has(v as object)) return
    seen.add(v as object)
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    const rec = v as Record<string, unknown>
    if (typeof rec.url === 'string') rec.url = resolveDataUrl(rec.url)
    for (const k of Object.keys(rec)) walk(rec[k])
  }
  walk(out)
  return out
}

/** Try the second official data host when the first returns a 404. */
const dataFetch: typeof fetch = async (input, init) => {
  const first = await fetch(input, init)
  if (first.ok) return first
  const url = String(input)
  if (!url.startsWith(VEGA_DATA_BASES[0]!)) return first
  const alt = VEGA_DATA_BASES[1]! + url.slice(VEGA_DATA_BASES[0]!.length)
  try {
    const second = await fetch(alt, init)
    if (second.ok) return second
  } catch { /* keep the original response */ }
  return first
}

function SpecPlayground() {
  const [text, setText] = React.useState(() => JSON.stringify(DEFAULT_SPEC, null, 2))
  const [error, setError] = React.useState<string | null>(null)
  const [vl, setVl] = React.useState<Record<string, unknown> | null>(() => structuredClone(DEFAULT_SPEC))
  const [vg, setVg] = React.useState<Record<string, unknown> | null>(() => {
    try { return compile(DEFAULT_SPEC as never) as Record<string, unknown> } catch { return null }
  })
  React.useEffect(() => {
    let cancelled = false
    const id = window.setTimeout(async () => {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const isVl = String(parsed.$schema ?? '').includes('vega-lite')
        // Relative data URLs default to the vega-datasets base; URL datasets
        // are fetched + inlined for the aster column (the oracle fetches its own).
        const resolved = resolveDataUrls(parsed)
        let inlined = resolved
        try { inlined = await loadSpecData(structuredClone(resolved), { fetch: dataFetch }) } catch { /* bad URL: surface via the oracle/render error paths */ }
        if (cancelled) return
        setVl(resolved)
        setVg(isVl ? (compile(inlined as never) as Record<string, unknown>) : inlined)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }, 400)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [text])
  // Only a numeric top-level size is passed on: a size the spec computes through its width / height signals stays
  // the spec's (an explicit size would fix the view and override it).
  const size = vg ? { width: typeof vg.width === 'number' ? vg.width : undefined, height: typeof vg.height === 'number' ? vg.height : undefined } : {}
  return (
    <div className="playground">
      <textarea
        className="spec-editor"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Paste a Vega or Vega-Lite spec"
      />
      <div className="playground-output">
        {error ? <div className="error">{error}</div> : (
          <div className="compare">
            <div className="pane">
              <div className="pane-head"><span className="badge oracle">vega / vega-lite</span></div>
              <div className="chart-container">
                <React.Suspense fallback={<VegaLoading />}>
                  {vl && <VegaPane spec={vl} width={size.width} height={size.height} ariaLabel="Playground — official vega" />}
                </React.Suspense>
              </div>
            </div>
            <div className="pane">
              <div className="pane-head"><span className="badge aster">aster · react</span></div>
              <div className="chart-container">
                {vg && (
                  <Chart
                    spec={vg}
                    // the spec's own size: a forced size would override a spec that sizes itself through its
                    // width / height signals (an explicit size fixes the view; docs/API.md)
                    width={size.width}
                    height={size.height}
                    tooltip
                    ariaLabel="Playground — aster"
                  />
                )}
              </div>
            </div>
          </div>
        )}
        {!error && <p className="hint">Paste a Vega (<code>$schema</code> vega) or Vega-Lite spec. Relative data URLs like <code>data/stocks.csv</code> resolve to the official Vega dataset host automatically. Both engines compile and render the same input — Vega-Lite goes through <strong>@aster/vl</strong> on the right, the official compiler on the left.</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reactive showcases (aster-only capabilities: per-datum dataChanges)
// ---------------------------------------------------------------------------

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
      <Chart spec={CompiledLineSpec} width={480} height={260} data={{ table: data }} dataChanges={{ table: [(seed.current * 7) % data.length] }} ariaLabel="Live incremental line chart" />
    </div>
  )
}

function TooltipDemo() {
  return (
    <div className="chart-container">
      <Chart spec={CompiledStackedBarSpec} width={440} height={300} tooltip ariaLabel="Bars with tooltips" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gallery renderers (aster column). Interactive ones drive aster's reactive
// engine; the vega pane beside them exercises the same spec natively.
// ---------------------------------------------------------------------------

function ResponsiveLine() {
  return (
    <div style={{ width: '100%', height: 400 }}>
      <Chart spec={CompiledLineSpec} ariaLabel="Responsive line chart" />
    </div>
  )
}

function BoundParam() {
  // The compiled spec carries `shift.bind`; <Chart> renders the range control
  // itself (same as Vega's bind UI), so no manual slider is needed here.
  return <Chart spec={CompiledParamBoundSpec} ariaLabel="Shifted line chart" width={400} height={300} />
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
      <Chart spec={CompiledInteractiveBrushSpec} ariaLabel="Brush scatter" width={400} height={300} onSelect={onSelect} brush={brush} />
    </>
  )
}

const plain = (spec: Record<string, unknown>, width: number, height: number, label: string, style?: React.CSSProperties) => (
  <div style={style}>
    <Chart spec={spec} ariaLabel={label} width={width} height={height} />
  </div>
)

const SPECS: Array<{ title: string; desc: string; raw: Record<string, unknown>; compiled: Record<string, unknown>; aster: React.ReactNode; wide?: string }> = [
  { title: 'Responsive Line', desc: 'Spec-level signals drive width/height; resizes with the container.', raw: LineSpec, compiled: CompiledLineSpec, aster: <ResponsiveLine />, wide: 'wide' },
  { title: 'Bound Parameter', desc: 'A bound signal updates Y values live. Both engines render the bound range control and re-evaluate the same param.', raw: ParamBoundSpec, compiled: CompiledParamBoundSpec, aster: <BoundParam /> },
  { title: 'Interactive Brush', desc: 'Drag to select a data interval — native vega params on the left, aster\'s event-driven signals on the right.', raw: InteractiveBrushSpec, compiled: CompiledInteractiveBrushSpec, aster: <InteractiveBrush /> },
  { title: 'Histogram', desc: 'Bar encoding with bin:true auto-bins occurrences.', raw: HistogramSpec, compiled: CompiledHistogramSpec, aster: plain(CompiledHistogramSpec, 400, 300, 'Histogram', { alignItems: 'flex-start' }) },
  { title: 'Scatter + Legend', desc: 'Color encodes a category dimension with an automatic legend.', raw: LegendScatterSpec, compiled: CompiledLegendScatterSpec, aster: plain(CompiledLegendScatterSpec, 400, 300, 'Legend scatter') },
  { title: 'Pie / Donut', desc: 'Arc marks with innerRadius render donuts; theta encodes value.', raw: PieSpec, compiled: CompiledPieSpec, aster: plain(CompiledPieSpec, 200, 200, 'Pie/donut chart', { alignItems: 'flex-start' }) },
  { title: 'Text Labels', desc: 'Text marks render a label at each (x, y) point.', raw: TextLabelSpec, compiled: CompiledTextLabelSpec, aster: plain(CompiledTextLabelSpec, 400, 300, 'Text labels') },
  { title: 'Heatmap', desc: 'Band scales + a quantitative color scale render a gradient heatmap.', raw: HeatmapSpec, compiled: CompiledHeatmapSpec, aster: plain(CompiledHeatmapSpec, 300, 200, 'Heatmap', { alignItems: 'flex-start' }) },
  { title: 'Stacked Bar', desc: 'Bars stacked per category with an automatic color legend.', raw: StackedBarSpec, compiled: CompiledStackedBarSpec, aster: plain(CompiledStackedBarSpec, 400, 300, 'Stacked bar') },
  { title: 'Layered Area + Line', desc: 'An area mark overlaid with a line on shared scales.', raw: LayerSpec, compiled: CompiledLayerSpec, aster: plain(CompiledLayerSpec, 400, 300, 'Layered area + line') },
  { title: 'Donut Chart', desc: 'A larger innerRadius arc renders a donut with a legend.', raw: DonutSpec, compiled: CompiledDonutSpec, aster: plain(CompiledDonutSpec, 200, 200, 'Donut chart', { alignItems: 'flex-start' }) },
  { title: 'Regression Line', desc: 'A regression transform fits a line to point data.', raw: RegressionSpec, compiled: CompiledRegressionSpec, aster: plain(CompiledRegressionSpec, 400, 300, 'Regression line') },
  { title: 'Streamgraph', desc: 'Stacked areas offset around the center produce a streamgraph.', raw: StreamgraphSpec, compiled: CompiledStreamgraphSpec, aster: plain(CompiledStreamgraphSpec, 400, 300, 'Streamgraph') },
  { title: 'Bubble Chart', desc: 'The size channel quantitatively scales marker area.', raw: BubbleSpec, compiled: CompiledBubbleSpec, aster: plain(CompiledBubbleSpec, 400, 300, 'Bubble chart') },
  { title: 'Candlestick', desc: 'Rule + bar layers render OHLC, colored by direction.', raw: CandlestickSpec, compiled: CompiledCandlestickSpec, aster: plain(CompiledCandlestickSpec, 400, 300, 'Candlestick chart') },
  { title: 'Color Scheme', desc: 'A nominal scale with an explicit palette drives color + legend.', raw: ColorSchemeSpec, compiled: CompiledColorSchemeSpec, aster: plain(CompiledColorSchemeSpec, 400, 300, 'Color scheme scatter') },
  { title: 'Grouped Bar', desc: 'Bars grouped side-by-side via the xOffset channel.', raw: GroupedBarSpec, compiled: CompiledGroupedBarSpec, aster: plain(CompiledGroupedBarSpec, 400, 300, 'Grouped bar chart') },
  { title: 'Radar / Spider', desc: 'A raw Vega spec with radial axes and a polygon line.', raw: RadarSpec, compiled: CompiledRadarSpec, aster: plain(CompiledRadarSpec, 200, 200, 'Radar spider chart'), wide: 'wide' },
]

export function App() {
  const [dark, setDark] = React.useState(true)
  React.useEffect(() => {
    document.body.dataset.mode = dark ? 'dark' : 'light'
  }, [dark])
  return (
    <div className="app">
      <style>{`
        :root {
          --bg: #0b0f17; --bg-soft: #111826; --card: #141c2c; --border: #24304a;
          --text: #e8edf6; --muted: #93a1bd; --accent: #4f8cff; --accent2: #7aa2ff;
        }
        [data-mode="light"] {
          --bg: #f5f7fb; --bg-soft: #ffffff; --card: #ffffff; --border: #d9e1ee;
          --text: #1a2233; --muted: #5c6b87; --accent: #2563eb; --accent2: #1d4ed8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--text); background: var(--bg); min-height: 100vh; }
        .app { max-width: 1240px; margin: 0 auto; padding: 0 1.5rem 4rem; }
        .hero { position: relative; padding: 3.5rem 0 2.5rem; }
        .eyebrow { color: var(--accent2); font-size: 0.85rem; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; margin-bottom: 0.75rem; }
        h1 { font-size: clamp(2.2rem, 5vw, 3.2rem); line-height: 1.05; letter-spacing: -0.03em; }
        .subtitle { color: var(--muted); font-size: 1.15rem; margin-top: 0.9rem; max-width: 52rem; line-height: 1.6; }
        .hero-stats { display: flex; gap: 2rem; margin-top: 1.6rem; flex-wrap: wrap; }
        .hero-stats div { font-size: 0.9rem; color: var(--muted); }
        .hero-stats b { display: block; color: var(--text); font-size: 1.3rem; }
        h2 { font-size: 1.5rem; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
        .section-head { margin: 2.5rem 0 1.25rem; }
        .section-head .desc { color: var(--muted); font-size: 0.95rem; max-width: 48rem; }
        .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
        .feature { background: linear-gradient(180deg, var(--card), var(--bg-soft)); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .feature h3 { font-size: 1.05rem; margin-bottom: 0.4rem; color: var(--accent2); }
        .feature p { color: var(--muted); font-size: 0.9rem; line-height: 1.55; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(680px, 100%), 1fr)); gap: 1.25rem; }
        .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .section.wide { grid-column: 1 / -1; }
        .section h2 { font-size: 1.05rem; margin-bottom: 0.25rem; }
        .section .desc { color: var(--muted); font-size: 0.88rem; margin-bottom: 0.75rem; line-height: 1.5; }
        /* The two-column comparison: same spec, both engines. */
        .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        @media (max-width: 860px) { .compare { grid-template-columns: 1fr; } }
        .pane { min-width: 0; }
        .pane-head { display: flex; align-items: center; margin-bottom: 0.5rem; min-height: 22px; }
        .badge { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); }
        .badge.oracle { color: var(--muted); }
        .badge.aster { color: #fff; background: var(--accent); border-color: var(--accent); }
        .vega-loading { min-height: 120px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 0.85rem; width: 100%; }
        .chart-container { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; display: flex; align-items: center; justify-content: safe center; overflow: auto; min-height: 120px; }
        .chart-container svg { max-width: 100%; height: auto; }
        .vega-pane { min-width: 0; overflow: auto; }
        .mode-toggle { position: absolute; top: 1.4rem; right: 1.5rem; background: var(--card); color: var(--text); border: 1px solid var(--border); padding: 6px 12px; border-radius: 999px; cursor: pointer; font-size: 0.85rem; }
        .playground-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .playground { display: grid; grid-template-columns: minmax(280px, 1fr) 2fr; gap: 1.25rem; align-items: start; }
        @media (max-width: 900px) { .playground { grid-template-columns: 1fr; } }
        .spec-editor { width: 100%; min-height: 300px; background: var(--bg-soft); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
        .playground-output { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
        .playground-output .hint { color: var(--muted); font-size: 0.82rem; text-align: center; }
        .playground-output .error { color: #ff8a8a; font-size: 0.85rem; font-family: ui-monospace, monospace; }
        .controls { margin-top: 0.5rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; color: var(--muted); }
        .controls input[type="range"] { width: 200px; accent-color: var(--accent); }
        button { background: var(--accent); color: #fff; border: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
        button:hover { background: var(--accent2); }
        .selection-info { font-size: 0.85rem; color: var(--muted); margin-top: 0.5rem; font-family: monospace; }
        [data-testid="chart-binds"] { color: var(--muted); }
        [data-testid="chart-binds"] input[type="range"] { accent-color: var(--accent); width: 200px; }
        .showcase { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(600px, 100%), 1fr)); gap: 1.25rem; }
        .showcase .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
        .showcase .card h3 { font-size: 1.05rem; margin-bottom: 0.4rem; }
        .showcase .card p { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.9rem; }
        footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
      `}</style>

      <header className="hero">
        <button className="mode-toggle" onClick={() => setDark((d) => !d)} aria-label="Toggle dark/light mode">
          {dark ? '☀️ Light' : '🌙 Dark'}
        </button>
        <div className="eyebrow">Vega-compatible chart engine</div>
        <h1>Aster Charts</h1>
        <p className="subtitle">
          A fast, Vega/Vega-Lite-compatible chart engine for React — with its own from-scratch
          Vega-Lite compiler. Every card below feeds the <strong>same spec</strong> to both engines:
          the official vega toolchain on the left, aster on the right. The vega column streams in
          separately; aster paints first.
        </p>
        <div className="hero-stats">
          <div><b>419/419</b> conformance specs vs the oracle</div>
          <div><b>157 kB</b> gzip React chart (no vega runtime)</div>
          <div><b>16.7 ms</b> streaming frames @ 100k canvas</div>
          <div><b>~0 MB</b> retained per update</div>
        </div>
      </header>

      <section id="features">
        <div className="section-head">
          <h2>Built to be exact, built to be fast</h2>
          <p className="desc">Aster renders Vega and Vega-Lite specs against the real Vega oracle, then optimizes the update path.</p>
        </div>
        <div className="features">
          <div className="feature"><h3>Oracle-verified</h3><p>Geometry diffed against the actual Vega renderer on a 400+ spec conformance corpus.</p></div>
          <div className="feature"><h3>Own Vega-Lite compiler</h3><p>@aster/vl compiles Vega-Lite to Vega from scratch — no npm vega-lite anywhere in the render path.</p></div>
          <div className="feature"><h3>Incremental DOM</h3><p>Patches only changed attributes and skips unchanged subtrees on updates.</p></div>
          <div className="feature"><h3>Reactive dataflow</h3><p>Per-datum updates re-derive only the changed rows, reusing unchanged marks, items, and scales.</p></div>
        </div>
      </section>

      <section id="reactive">
        <div className="section-head">
          <h2>Reactive dataflow — live</h2>
          <p className="desc">Aster-only capabilities: a live per-datum update via <code>dataChanges</code> (O(changed), not O(n)), and hover tooltips.</p>
        </div>
        <div className="showcase">
          <div className="card">
            <h3>Live incremental update</h3>
            <p>One point changes every 700ms. The engine re-derives only that row and reuses the rest.</p>
            <LiveDataChanges />
          </div>
          <div className="card">
            <h3>Hover tooltips</h3>
            <p>Hover any mark to read its datum, via <code>tooltip</code>.</p>
            <TooltipDemo />
          </div>
        </div>
      </section>

      <section id="streaming">
        <StreamingCompare />
      </section>

      <section id="playground">
        <div className="section-head">
          <h2>Spec playground</h2>
          <p className="desc">Paste any Vega or Vega-Lite spec and see both engines render it live.</p>
        </div>
        <div className="playground-wrap">
          <SpecPlayground />
        </div>
      </section>

      <section id="new">
        <div className="section-head">
          <h2>New in this build — same spec, both engines</h2>
          <p className="desc">Selections across composed views, maps, the time channel and discretizing legends. Each spec is from the conformance corpus, where it is checked against the official toolchain.</p>
        </div>
        <div className="grid">
          {SHOWCASE.map((s) => (
            <CompareCard key={s.title} title={s.title} desc={s.desc} spec={s.raw} aster={s.aster} wide={s.wide === 'wide'} />
          ))}
        </div>
      </section>

      <section id="gallery">
        <div className="section-head">
          <h2>Gallery — same spec, both engines</h2>
          <p className="desc">Left: the official vega/vega-lite toolchain. Right: aster, fed with the identical spec input.</p>
        </div>
        <div className="grid">
          {SPECS.map((s) => (
            <CompareCard key={s.title} title={s.title} desc={s.desc} spec={s.raw} aster={s.aster} wide={s.wide === 'wide'} />
          ))}
        </div>
      </section>

      <footer>Built with <a href="https://github.com/mgilbir/aster-react" style={{ color: 'var(--accent2)' }}>aster-react</a>. The vega column is the official renderer, loaded separately for comparison.</footer>
    </div>
  )
}
