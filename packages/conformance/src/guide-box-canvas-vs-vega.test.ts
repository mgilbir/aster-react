/**
 * The box of a guide's group item (an axis's, a legend's, a legend entry's, a title's: its `axis` / `legend` / `entries` / `group`
 * encode), painted: vega draws it on a canvas as it draws any group item's background, before what the guide holds, and its stroke
 * with it (or after, with `strokeForeground`). Compared with vega-scenegraph's own canvas drawing of the same scene, every paint as
 * its device-space path and its style (a gradient: its coordinates and stops).
 *
 * `strokeForeground` on every kind of group item, the legend's and the entries' included, is held to vega in
 * stroke-foreground-vs-vega.test.ts (SVG, canvas, pick, bounds); a gradient on every kind of box, and on every other item a canvas
 * paints with one, in gradient-canvas-bounds-vs-vega.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { recorder, type Painted } from './canvas-recorder.js'

const lin = { gradient: 'linear', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'darkred' }] }
const SCALES = [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }]
const BOX = { width: { value: 40 }, height: { value: 20 }, strokeWidth: { value: 2 } }
const GUIDES: Array<[string, (enc: Record<string, unknown>) => Record<string, unknown>]> = [
  ['an axis', (update) => ({ axes: [{ orient: 'bottom', scale: 'x', encode: { axis: { update } } }] })],
  ['a legend', (update) => ({ legends: [{ fill: 'c', encode: { legend: { update } } }] })],
  ['a legend\'s entries', (update) => ({ legends: [{ fill: 'c', encode: { entries: { update } } }] })],
  ['a title', (update) => ({ title: { text: 'T', encode: { group: { update } } } })],
]
const COLOUR = { fill: { value: 'gold' }, stroke: { value: 'teal' } }
const CASES: Array<[string, string, Record<string, unknown>]> = [
  ...GUIDES.map(([g]): [string, string, Record<string, unknown>] => [g, 'a colour', COLOUR]),
  ['an axis', 'a colour, stroked in front', { ...COLOUR, strokeForeground: { value: true } }],
  ['a title', 'a colour, stroked in front', { ...COLOUR, strokeForeground: { value: true } }],
  ['a title', 'a gradient', { fill: { value: lin }, stroke: { value: 'teal' } }],
]
const BOX_STYLES = /^(gold|teal|linear\()/

function spec(guide: Record<string, unknown>): Record<string, unknown> {
  // (no padding: vega's renderer, not its group drawing, moves the scene by it)
  return { width: 140, height: 90, padding: 0, autosize: 'none', scales: SCALES, ...guide }
}

async function vegaPainted(s: Record<string, unknown>): Promise<Painted[]> {
  const view = new vega.View(vega.parse(s as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const { ctx, painted } = recorder()
    ;(vega as unknown as { Marks: Record<string, { draw(c: unknown, s: unknown, b: unknown): void }> }).Marks.group!.draw(ctx, (view.scenegraph() as unknown as { root: unknown }).root, null)
    return painted
  } finally { view.finalize() }
}

function asterPainted(s: Record<string, unknown>): Painted[] {
  const { ctx, painted } = recorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(s) as never), {}), ctx)
  return painted
}

describe('a guide\'s box on a canvas, as vega draws it', () => {
  for (const [name, paintName, paint] of CASES) {
    it(`${name}, painted with ${paintName}`, async () => {
      const s = spec(GUIDES.find(([g]) => g === name)![1]({ ...paint, ...BOX }))
      const want = (await vegaPainted(structuredClone(s))).filter((p) => BOX_STYLES.test(p.style))
      expect(want.length).toBeGreaterThan(0) // not vacuous
      expect(asterPainted(s).filter((p) => BOX_STYLES.test(p.style))).toEqual(want)
    })
  }
})
