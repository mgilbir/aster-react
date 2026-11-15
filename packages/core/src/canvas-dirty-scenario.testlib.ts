/**
 * Test-only scenario driver for the canvas dirty-region oracle (excluded from the published build). Produces, step by step, the
 * scene a chart session delivers as signals move on a random spec -- what a pointer does: a tooltip, a highlighted category, an
 * opacity threshold, a size, a moved item, a guide that reads the signal -- with now and then a change of data, plus the reference
 * scene evaluated from a freshly compiled chart. The caller paints.
 */
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { mulberry32 } from './scene-fuzz.testlib.js'
import type { SceneRoot, VgSpec } from './types.js'

export interface DirtyStep {
  step: number
  what: string
  scene: SceneRoot
  fresh(): SceneRoot
}

type Rand = () => number
const int = (r: Rand, a: number, b: number): number => a + Math.floor(r() * (b - a + 1))
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

/** What a channel of the moving mark reads of the signal `s` (a number from 0 to 9). */
const READS = [
  { tooltip: { signal: "'v ' + s" } },
  { fill: { signal: "datum.k == (s % 3 == 0 ? 'a' : s % 3 == 1 ? 'b' : 'c') ? '#d62728' : '#1f77b4'" } },
  { opacity: { signal: 'datum.x <= s ? 1 : 0.3' } },
  { size: { signal: 'datum.x == s ? 300 : 60' } },
  { strokeWidth: { signal: 'datum.x == s ? 4 : 1' } },
  { x: { scale: 'x', field: 'x', offset: { signal: 'datum.x == s ? 6 : 0' } } },
  { stroke: { signal: "datum.x == s ? 'black' : null" } },
] as const

function specOf(r: Rand): { spec: VgSpec; rows: () => Array<Record<string, unknown>> } {
  const n = int(r, 3, 24)
  const kind = pick(r, ['symbol', 'symbol', 'rect', 'rule', 'text', 'line', 'area'] as const)
  const reads = Array.from({ length: int(r, 1, 3) }, () => pick(r, READS))
  const encode: Record<string, unknown> = {
    x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' },
    ...(kind === 'rect' ? { width: { value: 8 }, y2: { scale: 'y', value: 0 } } : {}),
    ...(kind === 'rule' ? { x2: { scale: 'x', field: 'x', offset: 12 }, stroke: { value: '#444' } } : {}),
    ...(kind === 'text' ? { text: { field: 'k' }, fontSize: { value: 13 } } : {}),
    ...(kind === 'line' || kind === 'area' ? { interpolate: { value: pick(r, ['linear', 'step-after', 'monotone']) } } : {}),
    ...(kind === 'area' ? { y2: { scale: 'y', value: 0 }, fillOpacity: { value: 0.4 } } : {}),
    fill: { scale: 'c', field: 'k' },
  }
  for (const c of reads) Object.assign(encode, c)
  const rows = (): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ x: i % 10, y: int(r, 0, 20), k: pick(r, ['a', 'b', 'c']) }))
  const axisTitle = r() < 0.3 ? { signal: "'at ' + s" } : 'x'
  const spec = {
    width: int(r, 120, 260), height: int(r, 90, 200), padding: int(r, 0, 25), autosize: 'none',
    ...(r() < 0.3 ? { background: '#fafafa' } : {}),
    signals: [{ name: 's', value: 0 }],
    data: [{ name: 't', values: rows() }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 20], range: 'height' },
      { name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['#1f77b4', '#ff7f0e', '#2ca02c'] },
    ],
    axes: r() < 0.7 ? [{ scale: 'x', orient: 'bottom', title: axisTitle }, { scale: 'y', orient: 'left', grid: r() < 0.5 }] : [],
    ...(r() < 0.3 ? { legends: [{ fill: 'c', title: 'k' }] } : {}),
    marks: [
      // (another mark under and over the moving one: a repaint of a region paints them there too, in their order)
      { type: 'rect', encode: { update: { x: { value: 0 }, x2: { signal: 'width' }, y: { signal: 'height / 3' }, y2: { signal: 'height / 2' }, fill: { value: '#eee' } } } },
      { type: kind, from: { data: 't' }, encode: { update: encode } },
      ...(r() < 0.5 ? [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y', offset: 3 }, size: { value: 40 }, fill: { value: '#222' }, fillOpacity: { value: 0.5 } } } }] : []),
    ],
  }
  return { spec: spec as unknown as VgSpec, rows }
}

export function* canvasDirtyScenario(seed: number, nSteps: number): Generator<DirtyStep> {
  const r = mulberry32(seed * 7919 + 13)
  const { spec, rows } = specOf(r)
  let data = (spec as unknown as { data: Array<{ values: Array<Record<string, unknown>> }> }).data[0]!.values
  let s = 0
  const inputOf = (): { signals: { s: number }; data: { t: Array<Record<string, unknown>> } } => ({ signals: { s }, data: { t: data } })
  const freshOf = (input: ReturnType<typeof inputOf>) => (): SceneRoot => evaluateChart(compileChart(structuredClone(spec)), input)
  const session = createChartSession()
  let input = inputOf()
  yield { step: -1, what: 'first', scene: session.evaluate(spec, input), fresh: freshOf(input) }
  for (let step = 0; step < nSteps; step++) {
    let what: string
    if (r() < 0.15) { data = rows(); what = 'new rows' } else { s = int(r, 0, 9); what = `s=${s}` }
    input = inputOf()
    yield { step, what, scene: session.evaluate(spec, input), fresh: freshOf(input) }
  }
}
