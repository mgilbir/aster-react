/**
 * The `label` transform against vega-label. vega's label layout draws the marks it avoids into an offscreen canvas and reads the
 * alpha back; in Node there is no canvas, so vega runs in a child process (`label-canvas/`) in which `canvas` is the
 * coverage-only context the engine's own port draws into. The same rasterizer on both sides makes this a test of everything
 * else: which marks are drawn and how (vega-scenegraph's draw against the engine's), the bitmaps, the scaler, the anchors and
 * offsets, the base-mark boundary of every mark type, the group line and area placements, the sort, the padding, the text widths.
 * Against a real browser canvas (what the rasterizer must reproduce) the gallery gate holds `vega/labeled-scatter-plot`.
 *
 * Each case is a Vega spec with inline data; its text mark's items must carry the same x, y, opacity, align and baseline.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '@aster/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster/core'

type Spec = Record<string, unknown>
interface LabelItem { text: unknown; x: unknown; y: unknown; opacity: unknown; align: unknown; baseline: unknown }

const HERE = dirname(fileURLToPath(import.meta.url))

function runVega(spec: Spec, datasets: string[] = []): { marks: Array<{ name: string | null; items: LabelItem[] }>; data: Record<string, LabelItem[]> } {
  const out = execFileSync(process.execPath, ['--import', join(HERE, 'label-canvas', 'register.mjs'), join(HERE, 'label-canvas', 'run-vega.mjs'), ...datasets], {
    input: JSON.stringify(spec), maxBuffer: 1 << 28,
  }).toString()
  return JSON.parse(out) as ReturnType<typeof runVega>
}

function vegaItems(spec: Spec, markName: string): LabelItem[] {
  const marks = runVega(spec).marks
  const mark = marks.find((m) => m.name === markName)
  if (!mark) throw new Error(`vega has no text mark "${markName}" (${marks.map((m) => m.name)})`)
  return mark.items
}

function engineItems(spec: Spec, markName: string): LabelItem[] {
  const scene = evaluateChart(compileChart(structuredClone(spec) as never), {}) as unknown as { items: unknown[] }
  const found: Array<{ name?: string; marktype?: string; items: LabelItem[] }> = []
  const visit = (n: { name?: string; marktype?: string; items?: unknown[] }): void => {
    if (n.marktype === 'text') found.push(n as never)
    for (const c of n.items ?? []) if (c && typeof c === 'object' && ((c as { marktype?: string }).marktype || (c as { items?: unknown }).items)) visit(c as never)
  }
  for (const g of scene.items) visit(g as never)
  const mark = found.find((m) => m.name === markName)
  if (!mark) throw new Error(`the engine has no text mark "${markName}"`)
  return mark.items
}

function compareRows(want: LabelItem[], got: LabelItem[]): { n: number; placed: number } {
  expect(got.length).toBe(want.length)
  const diffs: string[] = []
  want.forEach((w, i) => {
    const g = got[i]!
    if (!(same(w.x, g.x) && same(w.y, g.y) && same(w.opacity, g.opacity) && same(w.align, g.align) && same(w.baseline, g.baseline))) diffs.push(`#${i}: vega ${JSON.stringify(w)} engine ${JSON.stringify(g)}`)
  })
  expect(diffs.slice(0, 6)).toEqual([])
  return { n: want.length, placed: want.filter((w) => w.opacity === 1).length }
}
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) || (a == null && b == null)
function compare(spec: Spec, markName: string): { n: number; placed: number } {
  const want = vegaItems(spec, markName)
  const got = engineItems(spec, markName)
  expect(got.length).toBe(want.length)
  const diffs: string[] = []
  want.forEach((w, i) => {
    const g = got[i]!
    if (!(same(w.x, g.x) && same(w.y, g.y) && same(w.opacity, g.opacity) && same(w.align, g.align) && same(w.baseline, g.baseline))) {
      diffs.push(`#${i} ${String(w.text)}: vega ${JSON.stringify({ x: w.x, y: w.y, o: w.opacity, a: w.align, b: w.baseline })} engine ${JSON.stringify({ x: g.x, y: g.y, o: g.opacity, a: g.align, b: g.baseline })}`)
    }
  })
  expect(diffs.slice(0, 6)).toEqual([])
  return { n: want.length, placed: want.filter((w) => w.opacity === 1).length }
}

// --- the data and the marks ---------------------------------------------------

/** A deterministic scatter of `n` labelled points. */
const points = (n: number, seed = 1): Array<{ id: number; name: string; x: number; y: number; v: number }> => {
  let s = seed * 9301 + 49297
  const next = (): number => ((s = (s * 9301 + 49297) % 233280) / 233280)
  return Array.from({ length: n }, (_, id) => ({ id, name: `p${id} ${'abcdefghij'.slice(0, 1 + (id % 9))}`, x: next() * 100, y: next() * 100, v: next() }))
}

const W = 420
const H = 300
const frame = { width: W, height: H, padding: 5, autosize: 'none' }
const scales = [
  { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
  { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
]

const scatter = (label: Spec, extraMarks: Spec[] = [], n = 90, base: Spec = {}): Spec => ({
  ...frame,
  data: [{ name: 'd', values: points(n) }],
  scales,
  marks: [
    { name: 'pts', type: 'symbol', from: { data: 'd' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 }, fill: { value: 'steelblue' } } }, ...base },
    ...extraMarks,
    {
      name: 'lab', type: 'text', from: { data: 'pts' },
      encode: { enter: { text: { field: 'datum.name' }, fontSize: { value: 9 } } },
      transform: [{ type: 'label', size: [W, H], ...label }],
    },
  ],
})

const bigBoxes: Spec = {
  type: 'rect',
  encode: { enter: { x: { scale: 'x', field: 'x' }, width: { value: 70 }, y: { scale: 'y', field: 'y' }, height: { value: 14 }, fill: { value: '#9ecae1' }, stroke: { value: '#333' }, strokeWidth: { value: 2 } } },
}
const trend: Spec = {
  name: 'trend', type: 'line', from: { data: 'd' }, sort: { field: 'datum.x' },
  encode: { enter: { x: { scale: 'x', field: 'x' }, y: { signal: "scale('y', 100 - datum.x * 0.8 + 10)" }, stroke: { value: 'firebrick' }, strokeWidth: { value: 3 } } },
}
const boxes: Spec = {
  name: 'boxes', type: 'rect', from: { data: 'd' },
  encode: { enter: { x: { scale: 'x', field: 'x' }, width: { value: 14 }, y: { scale: 'y', field: 'y' }, height: { value: 9 }, fill: { value: '#ccc' }, stroke: { value: '#333' } } },
}

// marks to avoid, one of each kind the layout can draw
const avoid = (m: Spec): Spec => ({ name: 'av', ...m })
const AVOID_MARKS: Array<[string, Spec]> = [
  ['a thick rule', avoid({ type: 'rule', encode: { enter: { x: { value: 20 }, x2: { value: 400 }, y: { value: 150 }, stroke: { value: '#999' }, strokeWidth: { value: 36 } } } })],
  ['a dashed rule', avoid({ type: 'rule', encode: { enter: { x: { value: 20 }, x2: { value: 400 }, y: { value: 90 }, stroke: { value: '#999' }, strokeWidth: { value: 22 }, strokeDash: { value: [14, 9] } } } })],
  ['an arc', avoid({ type: 'arc', encode: { enter: { x: { value: 210 }, y: { value: 150 }, innerRadius: { value: 40 }, outerRadius: { value: 120 }, startAngle: { value: 0.3 }, endAngle: { value: 4.2 }, fill: { value: '#aaa' } } } })],
  ['a path', avoid({ type: 'path', encode: { enter: { path: { value: 'M30,40L380,70L300,250L90,220Z M150,120l30,0l0,30l-30,0z' }, fill: { value: '#bbb' }, stroke: { value: '#333' }, strokeWidth: { value: 3 }, strokeJoin: { value: 'round' } } } })],
  ['a stroked path, round caps', avoid({ type: 'path', encode: { enter: { path: { value: 'M30,40C150,10 250,250 390,60' }, stroke: { value: '#333' }, strokeWidth: { value: 30 }, strokeCap: { value: 'round' } } } })],
  ['a trail', avoid({ type: 'trail', from: { data: 'd' }, sort: { field: 'datum.x' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { signal: "scale('y', 50 + 40 * sin(datum.x / 12))" }, size: { signal: '4 + datum.x / 6' }, fill: { value: '#888' } } } })],
  ['an area', avoid({ type: 'area', from: { data: 'd' }, sort: { field: 'datum.x' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { signal: "scale('y', 70 + 20 * sin(datum.x / 9))" }, y2: { signal: "scale('y', 30)" }, fill: { value: '#ccc' } } } })],
  ['a text', avoid({ type: 'text', from: { data: 'd' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v', offset: 0 }, text: { value: 'MMMMMMM' }, fontSize: { value: 14 }, fill: { value: '#000' } } } })],
]

const CASES: Array<[string, Spec]> = [
  ['symbols, the default anchors, offset 1', scatter({})],
  ['symbols, anchors top / bottom / right / left, offset 1', scatter({ anchor: ['top', 'bottom', 'right', 'left'], offset: [1] })],
  ['symbols, an offset per anchor', scatter({ anchor: ['top-left', 'top-right', 'bottom-right', 'bottom-left'], offset: [2, 4, 6, 8] })],
  ['rects, inside the mark (anchor middle): the border is a second bitmap', scatter({ anchor: ['middle'], offset: [0] }, [], 30, bigBoxes)],
  ['rects, inside the mark by a negative offset, then outside', scatter({ anchor: ['top', 'bottom', 'right'], offset: [-2, 2] }, [], 30, bigBoxes)],
  ['symbols, a label may overlap its mark (avoidBaseMark false)', scatter({ avoidBaseMark: false })],
  ['symbols, padding 20', scatter({ padding: 20, anchor: ['top', 'bottom', 'left', 'right'] })],
  ['symbols, padding null (unbounded) at the edge of the view', scatter({ padding: null, anchor: ['right', 'left'], offset: [4] }, [], 70, {})],
  ['symbols, sorted by priority', scatter({ sort: { field: 'datum.v', order: 'descending' } })],
  ['symbols, avoiding a line', scatter({ avoidMarks: ['trend'] }, [trend])],
  ['symbols, avoiding a line and rects', scatter({ avoidMarks: ['trend', 'boxes'], anchor: ['top', 'bottom', 'left', 'right'] }, [trend, boxes])],
  ['symbols, 400 points (a denser layout)', scatter({}, [trend], 400)],
]
const AVOID_ANCHORS = { anchor: ['top', 'bottom', 'right', 'left'] }
const AVOID_CASES: Array<[string, Spec]> = AVOID_MARKS.map(([name, m]) => [`symbols, avoiding ${name}`, scatter({ avoidMarks: ['av'], ...AVOID_ANCHORS }, [m])])

// groups: a line or an area per series, the labels at the lines' ends / inside the areas
const SERIES = ['alpha', 'beta', 'gamma', 'delta']
const series = SERIES.flatMap((c, k) => Array.from({ length: 12 }, (_, t) => ({ c, t, v: 10 + k * 18 + 8 * Math.sin(t / 2 + k) + t * (k % 2 ? 1.5 : -0.5) })))
const groupFrame = (inner: Spec, label: Spec, data: Spec[] = []): Spec => ({
  ...frame,
  data: [{ name: 'd', values: series }, ...data],
  scales: [
    { name: 'x', type: 'linear', domain: [-3, 14], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 120], range: 'height' },
    { name: 'c', type: 'ordinal', domain: SERIES, range: 'category' },
  ],
  marks: [
    { name: 'groups', type: 'group', from: { facet: { name: 'series', data: data.length ? 'stacked' : 'd', groupby: 'c' } }, marks: [inner] },
    {
      name: 'lab', type: 'text', from: { data: 'groups' },
      encode: { enter: { text: { field: 'datum.c' }, fontSize: { value: 12 }, fill: { value: '#000' } } },
      transform: [{ type: 'label', size: [W, H], ...label }],
    },
  ],
})
const lineInner: Spec = {
  type: 'line', from: { data: 'series' },
  encode: { enter: { x: { scale: 'x', field: 't' }, y: { scale: 'y', field: 'v' }, stroke: { scale: 'c', field: 'c' }, strokeWidth: { value: 2 } } },
}
const areaInner: Spec = {
  type: 'area', from: { data: 'series' },
  encode: { enter: { x: { scale: 'x', field: 't' }, y: { scale: 'y', field: 'y0' }, y2: { scale: 'y', field: 'y1' }, fill: { scale: 'c', field: 'c' }, stroke: { value: 'white' } } },
}
const stack = { name: 'stacked', source: 'd', transform: [{ type: 'stack', groupby: ['t'], field: 'v', sort: { field: 'c' } }] }

const GROUP_CASES: Array<[string, Spec]> = [
  ['group lines, labels after the last point', groupFrame(lineInner, { anchor: ['right'], offset: [4] })],
  ['group lines, labels before the first point (lineAnchor start)', groupFrame(lineInner, { anchor: ['left'], offset: [4], lineAnchor: 'start' })],
  ['group lines, several anchors', groupFrame(lineInner, { anchor: ['right', 'top', 'bottom'], offset: [3, 6] })],
  ['group lines, padding null', groupFrame(lineInner, { anchor: ['right'], offset: [4], padding: null })],
  ['group areas, naive', groupFrame(areaInner, { method: 'naive' }, [stack])],
  ['group areas, reduced-search', groupFrame(areaInner, { method: 'reduced-search' }, [stack])],
  ['group areas, floodfill', groupFrame(areaInner, { method: 'floodfill' }, [stack])],
  ['group areas, reduced-search, not avoiding the base mark', groupFrame(areaInner, { method: 'reduced-search', avoidBaseMark: false }, [stack])],
]

// a dataset's tuples, with no mark behind them: the boundary is each tuple's own x, y
const tuples = points(120).map((p) => ({ text: p.name, x: (p.x / 100) * (W - 40) + 20, y: (p.y / 100) * (H - 40) + 20, fontSize: 9 }))
const DATA_CASES: Array<[string, Spec]> = [
  ['tuples with no mark (the default anchors)', { ...frame, data: [{ name: 'src', values: tuples }, { name: 'lab', source: 'src', transform: [{ type: 'label', size: [W, H] }] }], marks: [] }],
  ['tuples with no mark, anchors and offsets, sorted', { ...frame, data: [{ name: 'src', values: tuples }, { name: 'lab', source: 'src', transform: [{ type: 'label', size: [W, H], anchor: ['top', 'right', 'bottom', 'left'], offset: [2, 5], sort: { field: 'x', order: 'descending' } }] }], marks: [] }],
  ['tuples with no mark, not avoiding the points', { ...frame, data: [{ name: 'src', values: tuples }, { name: 'lab', source: 'src', transform: [{ type: 'label', size: [W, H], avoidBaseMark: false, padding: 10 }] }], marks: [] }],
]

describe('label (vs vega-label, in a child process with a canvas stand-in)', () => {
  for (const [name, spec] of CASES) {
    it(name, () => {
      const { n, placed } = compare(spec, 'lab')
      expect(n).toBeGreaterThanOrEqual(30)
      // not vacuous: some are placed, some are not
      expect(placed).toBeGreaterThan(2)
      expect(placed).toBeLessThan(n)
    }, 60_000)
  }
  // the same layout without the mark to avoid places more labels: what the mark draws does keep labels off it
  for (const [name, spec] of AVOID_CASES) {
    it(name, () => {
      const { n, placed } = compare(spec, 'lab')
      const free = compare(scatter(AVOID_ANCHORS), 'lab')
      expect(n).toBe(free.n)
      expect(placed).toBeLessThan(free.placed)
    }, 60_000)
  }
  for (const [name, spec] of DATA_CASES) {
    it(name, () => {
      const want = runVega(spec, ['lab']).data.lab!
      const scene = evaluateChart(compileChart(structuredClone(spec) as never), {})
      const got = datasetsOfScene(scene).get('lab') as unknown as LabelItem[]
      const { n, placed } = compareRows(want, got)
      expect(n).toBe(120)
      expect(placed).toBeGreaterThan(2)
      expect(placed).toBeLessThan(n)
    }, 60_000)
  }
  for (const [name, spec] of GROUP_CASES) {
    it(name, () => {
      const { n, placed } = compare(spec, 'lab')
      expect(n).toBe(SERIES.length)
      expect(placed).toBeGreaterThan(0)
    }, 60_000)
  }
})
