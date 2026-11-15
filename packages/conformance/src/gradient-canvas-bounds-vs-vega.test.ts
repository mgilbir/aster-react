// @vitest-environment jsdom
/**
 * Where a gradient lies on a canvas: vega-scenegraph (util/canvas/color.js, gradient.js) lays a gradient paint over the painted item's
 * `bounds` -- for a group item (a group mark's, an axis's, a legend's, an entry's, a title's) the bounds of all of it: its box (unless
 * `noBound`), its stroke and what it holds; for a mark item its own bounds with its stroke; for a line, an area or a trail the whole
 * mark's. Every gradient paint vega's canvas makes, compared in order with Aster's canvas renderer on a recording context: the kind,
 * the device-space coordinates and the stops.
 *
 * (Only axis-aligned linear gradients and radial ones: vega draws a diagonal linear gradient into an image of the bounds' size, which
 * needs a real canvas, and paints as a pattern, which sits at the origin of the frame it is painted in: the canvas pixel gate,
 * browser-canvas-parity.mts `canvas-guide-gradient-*`, compares those in Chromium.)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { recorder, vegaDraw, type Painted } from './canvas-recorder.js'

type Spec = Record<string, unknown>
const V = (value: unknown): { value: unknown } => ({ value })

const LIN_X = { gradient: 'linear', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'darkred' }] }
const LIN_Y = { gradient: 'linear', x1: 0, y1: 0, x2: 0, y2: 1, stops: [{ offset: 0, color: 'gold' }, { offset: 1, color: 'navy' }] }
const RAD = { gradient: 'radial', x1: 0.3, y1: 0.4, r1: 0.1, x2: 0.6, y2: 0.5, r2: 0.7, stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'purple' }] }
const PAINTS: Array<[string, Spec]> = [
  ['a horizontal fill', { fill: V(LIN_X) }],
  ['a radial fill and a stroke', { fill: V(RAD), stroke: V('teal'), strokeWidth: V(3) }],
  ['a vertical stroke', { stroke: V(LIN_Y), strokeWidth: V(2) }],
  ['a fill and a stroke, both gradients, 1 px', { fill: V(LIN_X), stroke: V(LIN_Y), strokeWidth: V(1) }],
  ['a fill and a stroke in front, 5 px', { fill: V(RAD), stroke: V(LIN_Y), strokeWidth: V(5), strokeForeground: V(true) }],
  ['a fill, half opaque, rounded', { fill: V(LIN_Y), stroke: V('teal'), strokeWidth: V(4), cornerRadius: V(4), opacity: V(0.5) }],
]

const SCALES = [
  { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
  { name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'blue', 'green'] },
  { name: 'q', type: 'linear', domain: [0, 10], range: ['white', 'navy'] },
]
const BASE = { width: 140, height: 90, padding: 5, autosize: 'pad', scales: SCALES }
const SIZED = { width: V(40), height: V(20) }

/** Every group-like item a gradient can paint, with `update` as its encode. */
const GROUPS: Array<[string, (update: Spec) => Spec]> = [
  ['a group mark', (update) => ({ ...BASE, marks: [{ type: 'group', encode: { update: { x: V(20), y: V(15), width: V(60), height: V(40), ...update } }, marks: [{ type: 'rect', encode: { update: { x: V(-6), y: V(10), width: V(80), height: V(12), fill: V('tomato') } } }] }] })],
  ['a group mark left out of its bounds (noBound)', (update) => ({ ...BASE, marks: [{ type: 'group', encode: { update: { x: V(20), y: V(15), width: V(60), height: V(40), noBound: V(true), ...update } }, marks: [{ type: 'rect', encode: { update: { x: V(10), y: V(10), width: V(20), height: V(12), fill: V('tomato') } } }] }] })],
  ['a group mark in a group mark', (update) => ({ ...BASE, marks: [{ type: 'group', encode: { update: { x: V(7), y: V(9), width: V(100), height: V(70) } }, marks: [{ type: 'group', encode: { update: { x: V(13), y: V(6), width: V(50), height: V(30), ...update } }, marks: [{ type: 'symbol', encode: { update: { x: V(55), y: V(-3), size: V(200), fill: V('tomato') } } }] }] }] })],
  ['an axis', (update) => ({ ...BASE, axes: [{ orient: 'bottom', scale: 'x', title: 'X', encode: { axis: { update: { ...SIZED, ...update } } } }] })],
  ['a left axis', (update) => ({ ...BASE, axes: [{ orient: 'left', scale: 'x', encode: { axis: { update: { ...SIZED, ...update } } } }] })],
  ['a legend', (update) => ({ ...BASE, legends: [{ fill: 'c', title: 'C', encode: { legend: { update: { ...SIZED, ...update } } } }] })],
  ['a gradient legend', (update) => ({ ...BASE, legends: [{ fill: 'q', type: 'gradient', title: 'Q', encode: { legend: { update: { ...SIZED, ...update } } } }] })],
  ['a legend\'s entries', (update) => ({ ...BASE, legends: [{ fill: 'c', encode: { entries: { update: { ...SIZED, ...update } } } }] })],
  ['a title', (update) => ({ ...BASE, title: { text: 'Title', subtitle: 'Sub', encode: { group: { update: { ...SIZED, ...update } } } } })],
  ['a group mark\'s title', (update) => ({ ...BASE, marks: [{ type: 'group', encode: { update: { x: V(10), y: V(25), width: V(100), height: V(50) } }, title: { text: 'Inner', encode: { group: { update: { ...SIZED, ...update } } } } }] })],
]

/** The other items a gradient paints on a canvas. */
const ROWS = [{ x: 1, y: 3 }, { x: 4, y: 7 }, { x: 8, y: 2 }]
const MARKS: Array<[string, (paint: Spec) => Spec]> = [
  ['a rect mark', (paint) => ({ type: 'rect', encode: { update: { x: V(10), y: V(10), width: V(50), height: V(30), ...paint } } })],
  ['a rect mark by x2/y2', (paint) => ({ type: 'rect', encode: { update: { x: V(60), y: V(50), x2: V(15), y2: V(20), ...paint } } })],
  ['a symbol mark', (paint) => ({ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y', mult: 10 }, size: V(300), shape: V('diamond'), ...paint } } })],
  ['a path mark', (paint) => ({ type: 'path', encode: { update: { x: V(20), y: V(10), path: V('M0,0L40,10L10,40Z'), ...paint } } })],
  ['an arc mark', (paint) => ({ type: 'arc', encode: { update: { x: V(70), y: V(45), innerRadius: V(10), outerRadius: V(35), startAngle: V(0.3), endAngle: V(2.5), ...paint } } })],
  ['an area mark', (paint) => ({ type: 'area', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y', mult: 10 }, y2: V(80), ...paint } } })],
  ['a line mark', (paint) => ({ type: 'line', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y', mult: 10 }, ...paint } } })],
  ['a trail mark', (paint) => ({ type: 'trail', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y', mult: 10 }, size: V(8), ...paint } } })],
  ['a rule mark', (paint) => ({ type: 'rule', encode: { update: { x: V(10), y: V(10), x2: V(90), y2: V(60), ...paint } } })],
  ['a text mark', (paint) => ({ type: 'text', encode: { update: { x: V(30), y: V(30), text: V('Gradient'), fontSize: V(20), angle: V(15), ...paint } } })],
  ['a rect mark in a translated group', (paint) => ({ type: 'group', encode: { update: { x: V(17), y: V(11), width: V(60), height: V(40) } }, marks: [{ type: 'rect', encode: { update: { x: V(5), y: V(4), width: V(30), height: V(20), ...paint } } }] })],
]

const GRADIENT_STYLE = /^(linear|radial)\(/

async function vegaGradients(spec: Spec): Promise<Painted[]> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const svg = await view.toSVG()
    const [, ox, oy] = /<g[^>]*transform="translate\(([^,]+),([^)]+)\)"/.exec(svg)!
    const { ctx, painted } = recorder()
    ;(ctx as unknown as { translate(x: number, y: number): void }).translate(+ox!, +oy!)
    vegaDraw((vega as unknown as { Marks: Parameters<typeof vegaDraw>[0] }).Marks, ctx, (view.scenegraph() as unknown as { root: unknown }).root)
    return painted.filter((p) => GRADIENT_STYLE.test(p.style)).map((p) => ({ ...p, path: '' }))
  } finally { view.finalize() }
}

function asterGradients(spec: Spec): Painted[] {
  const { ctx, painted } = recorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(spec) as never), {}), ctx)
  return painted.filter((p) => GRADIENT_STYLE.test(p.style)).map((p) => ({ ...p, path: '' }))
}

async function same(spec: Spec): Promise<void> {
  const want = await vegaGradients(spec)
  expect(want.length).toBeGreaterThan(0) // not vacuous
  expect(asterGradients(spec)).toEqual(want)
}

describe('a gradient on a canvas lies over the painted item\'s bounds, as vega lays it', () => {
  for (const [name, make] of GROUPS) {
    for (const [paintName, paint] of PAINTS) {
      it(`${name}, ${paintName}`, async () => { await same(make(paint)) })
    }
  }
  for (const [name, make] of MARKS) {
    for (const [paintName, paint] of [
      ['a horizontal fill', { fill: V(LIN_X) }],
      ['a radial fill, stroked', { fill: V(RAD), stroke: V('teal'), strokeWidth: V(4) }],
      ['a vertical stroke', { stroke: V(LIN_Y), strokeWidth: V(3) }],
      ['a square-capped stroke, round joins', { stroke: V(LIN_X), strokeWidth: V(6), strokeCap: V('square'), strokeJoin: V('round') }],
    ] as Array<[string, Spec]>) {
      // (a rule has no fill, and a text no stroke vega lays a gradient for)
      if (name === 'a rule mark' && !(typeof (paint.stroke as { value?: unknown } | undefined)?.value === 'object')) continue
      if (name === 'a text mark' && !('fill' in paint)) continue
      it(`${name}, ${paintName}`, async () => { await same({ ...BASE, data: [{ name: 'd', values: ROWS }], marks: [make(paint)] }) })
    }
  }
  // a guide's parts, painted with a gradient: its marks' items, each laid over its own bounds
  const PARTS: Array<[string, Spec]> = [
    ['an axis\'s ticks, domain and grid', { axes: [{ orient: 'bottom', scale: 'x', grid: true, encode: { ticks: { update: { stroke: V(LIN_Y), strokeWidth: V(3) } }, domain: { update: { stroke: V(LIN_X), strokeWidth: V(4) } }, grid: { update: { stroke: V(LIN_Y) } } } }] }],
    ['an axis\'s labels and title', { axes: [{ orient: 'left', scale: 'x', title: 'Left', encode: { labels: { update: { fill: V(LIN_X) } }, title: { update: { fill: V(RAD) } } } }] }],
    ['a legend\'s symbols, stroked, and its labels', { legends: [{ fill: 'c', encode: { symbols: { update: { fill: V(RAD), stroke: V(LIN_Y), strokeWidth: V(3), size: V(150) } }, labels: { update: { fill: V(LIN_X) } } } }] }],
    ['a legend\'s clipped symbols', { legends: [{ fill: 'c', clipHeight: 8, encode: { symbols: { update: { fill: V(LIN_Y), size: V(300) } } } }] }],
    ['a gradient legend\'s labels and title', { legends: [{ fill: 'q', type: 'gradient', title: 'Q', encode: { labels: { update: { fill: V(LIN_Y) } }, title: { update: { fill: V(LIN_X) } } } }] }],
    ['a discrete legend\'s bands', { scales: [...SCALES, { name: 'z', type: 'quantize', domain: [0, 10], range: ['red', 'blue', 'green'] }], legends: [{ fill: 'z', type: 'discrete', encode: { gradient: { update: { stroke: V(LIN_X), strokeWidth: V(2) } } } }] }],
    ['a title and its subtitle', { title: { text: 'Title', subtitle: 'Subtitle', encode: { title: { update: { fill: V(LIN_X) } }, subtitle: { update: { fill: V(RAD) } } } } }],
  ]
  for (const [name, parts] of PARTS) it(name, async () => { await same({ ...BASE, ...parts }) })
  it('a gradient legend\'s strip, stroked', async () => {
    await same({ ...BASE, legends: [{ fill: 'q', type: 'gradient', gradientStrokeColor: 'black', gradientStrokeWidth: 3 }] })
  })
  it('a gradient legend\'s strip, horizontal, with a gradient of its own', async () => {
    await same({ ...BASE, legends: [{ fill: 'q', type: 'gradient', direction: 'horizontal', orient: 'bottom', encode: { gradient: { update: { stroke: V(LIN_Y), strokeWidth: V(2) } } } }] })
  })
})
