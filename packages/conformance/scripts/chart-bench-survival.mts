/**
 * The survival chart of the chart-bench study (its hand-written Vega spec and its heavy data set: 6 series of 1,000 points, seed
 * 2), as the study builds them, so the selections gate can drive it on both renderers. Its tooltip is composed from a
 * `pointermove` stream: a `hoverX` signal (`invert('x', x())`), a dataset that keeps each series' last point at or before it, and
 * a transparent rect over the plot whose `tooltip` reads that row. The study found it dead on `<Chart renderer="canvas">`,
 * where the spec's event streams were not bound.
 */

/** splitmix32, the study's seeded generator. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) >>> 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296
  }
}

const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777']
const MARGIN = { top: 20, right: 20, bottom: 44, left: 56 }

interface Point { x: number; y: number; lower: number; upper: number; censored: boolean }
interface Series { id: string; color: string; points: Point[] }

function generateSurvival(seed: number, series: number, points: number): Series[] {
  const rand = prng(seed)
  const out: Series[] = []
  for (let s = 0; s < series; s++) {
    const totalDecline = 0.45 + 0.4 * rand()
    let y = 1
    let x = 0
    const pts: Point[] = []
    for (let i = 0; i < points; i++) {
      x += 1 + Math.floor(rand() * 3)
      const censored = rand() < 0.08
      if (!censored) y = Math.max(0.02, y - (totalDecline / points) * (2 * rand()))
      const band = 0.02 + 0.08 * (i / points)
      pts.push({ x, y, lower: Math.max(0, y - band), upper: Math.min(1, y + band), censored })
    }
    out.push({ id: `Arm ${String.fromCharCode(65 + s)}`, color: PALETTE[s % PALETTE.length]!, points: pts })
  }
  return out
}

/** The study's survival spec over its heavy data set (900 x 600, the plot 824 x 536 inside its margin). */
export function chartBenchSurvival(): Record<string, unknown> {
  const series = generateSurvival(2, 6, 1000)
  const rows = series.flatMap((s) => s.points.map((p) => ({ series: s.id, ...p })))
  const lastX = Math.max(...rows.map((r) => r.x))
  const row = "data('atX')[0]"
  const tooltip = `length(data('atX')) ? {title: 'Day ' + round(hoverX), ${series.map((s) => `${JSON.stringify(s.id)}: format(${row}[${JSON.stringify(s.id)}], '.3f')`).join(', ')}} : null`
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 900 - MARGIN.left - MARGIN.right, height: 600 - MARGIN.top - MARGIN.bottom, padding: MARGIN, autosize: 'none',
    signals: [{
      name: 'hoverX', value: null,
      on: [{ events: 'pointermove', update: `clamp(invert('x', x()), 0, ${lastX})` }, { events: 'pointerout', update: 'null' }],
    }],
    data: [
      { name: 'table', values: rows },
      { name: 'plot', values: [{}] },
      { name: 'censored', source: 'table', transform: [{ type: 'filter', expr: 'datum.censored' }] },
      {
        name: 'atX', source: 'table',
        transform: [
          { type: 'filter', expr: 'hoverX != null && datum.x <= hoverX' },
          { type: 'aggregate', groupby: ['series'], fields: ['x'], ops: ['argmax'], as: ['last'] },
          { type: 'formula', expr: 'datum.last.y', as: 'y' },
          { type: 'pivot', field: 'series', value: 'y' },
        ],
      },
    ],
    scales: [
      { name: 'x', type: 'linear', domain: [0, lastX], range: 'width', nice: false, zero: false },
      { name: 'y', type: 'linear', domain: [0, 1], range: 'height', nice: false },
      { name: 'color', type: 'ordinal', domain: series.map((s) => s.id), range: series.map((s) => s.color) },
    ],
    axes: [{ scale: 'x', orient: 'bottom', title: 'Days' }, { scale: 'y', orient: 'left', title: 'Survival', grid: true }],
    marks: [
      {
        type: 'group', from: { facet: { name: 'one', data: 'table', groupby: 'series' } },
        marks: [
          { type: 'area', from: { data: 'one' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'lower' }, y2: { scale: 'y', field: 'upper' }, fill: { scale: 'color', field: 'series' }, fillOpacity: { value: 0.15 }, interpolate: { value: 'step-after' } } } },
          { type: 'line', from: { data: 'one' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { scale: 'color', field: 'series' }, strokeWidth: { value: 1.5 }, interpolate: { value: 'step-after' } } } },
        ],
      },
      { type: 'rule', from: { data: 'censored' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y', offset: -4 }, y2: { scale: 'y', field: 'y', offset: 4 }, stroke: { scale: 'color', field: 'series' } } } },
      {
        type: 'rect', from: { data: 'plot' },
        encode: {
          enter: { x: { value: 0 }, x2: { signal: 'width' }, y: { value: 0 }, y2: { signal: 'height' }, fill: { value: 'transparent' } },
          update: { tooltip: { signal: tooltip } },
        },
      },
    ],
  }
}
