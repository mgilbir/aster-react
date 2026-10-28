/**
 * A fill or stroke may be a gradient object ({gradient: 'linear' | 'radial', stops, ...}): vega-scenegraph writes it as a
 * definition in <defs> and the paint as a reference to it (a radial gradient through a pattern wrapper). Fills, strokes,
 * both on one item, a gradient with an id of its own, on every mark type that paints, against real vega.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const lin = { gradient: 'linear', x1: 0, y1: 1, x2: 1, y2: 0, stops: [{ offset: 0, color: 'white' }, { offset: 0.6, color: 'orange' }, { offset: 1, color: 'darkred' }] }
const lin2 = { gradient: 'linear', stops: [{ offset: 0, color: 'steelblue' }, { offset: 1, color: '#fc0' }] }
const rad = { gradient: 'radial', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'purple' }] }
const rad2 = { gradient: 'radial', x1: 0.3, y1: 0.3, r1: 0.05, x2: 0.5, y2: 0.5, r2: 0.6, stops: [{ offset: 0, color: '#ff0' }, { offset: 0.5, color: '#0a0' }, { offset: 1, color: '#003' }] }
const named = { gradient: 'linear', id: 'mine', x1: 0, y1: 0, x2: 0, y2: 1, stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }

const frame = {
  width: 360, height: 200, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ x: 0, y: 3 }, { x: 1, y: 5 }, { x: 2, y: 2 }, { x: 3, y: 6 }, { x: 4, y: 4 }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: [0, 170] }, { name: 'y', type: 'linear', domain: [0, 6], range: [90, 0] }],
}
const at = (x: unknown, y: unknown): Record<string, unknown> => ({ x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, ...(x as object), ...(y as object) })
const CASES: Array<[string, Record<string, unknown>[]]> = [
  ['an area filled and stroked', [{ type: 'area', from: { data: 't' }, encode: { update: at({ y2: { scale: 'y', value: 0 } }, { fill: { value: lin }, stroke: { value: rad2 }, strokeWidth: { value: 3 } }) } }]],
  ['a line stroked', [{ type: 'line', from: { data: 't' }, encode: { update: at({}, { stroke: { value: lin2 }, strokeWidth: { value: 4 } }) } }]],
  ['rects filled with one gradient, stroked with another', [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { signal: '10 + 30 * datum.x' }, width: { value: 24 }, y: { signal: '90 - 14 * datum.y' }, y2: { value: 90 }, fill: { value: lin2 }, stroke: { value: rad }, strokeWidth: { value: 2 } } } }]],
  ['symbols with a radial fill and a linear stroke', [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: '20 + 36 * datum.x' }, y: { value: 140 }, size: { value: 900 }, fill: { value: rad }, stroke: { value: lin }, strokeWidth: { value: 2 } } } }]],
  ['a gradient with an id of its own', [{ type: 'rect', encode: { update: { x: { value: 20 }, y: { value: 20 }, width: { value: 120 }, height: { value: 60 }, fill: { value: lin }, stroke: { value: named }, strokeWidth: { value: 6 } } } }]],
  ['the same gradient on several items is one definition', [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: '20 + 36 * datum.x' }, y: { value: 50 }, size: { value: 400 }, fill: { value: lin } } } }]],
  ['text and a trail', [
    { type: 'text', encode: { update: { x: { value: 40 }, y: { value: 100 }, text: { value: 'gradient' }, fontSize: { value: 30 }, fill: { value: lin2 } } } },
    { type: 'trail', from: { data: 't' }, encode: { update: at({ size: { value: 10 } }, { fill: { value: rad2 } }) } },
  ]],
]

async function vegaSvg(s: Record<string, unknown>): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(s as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

describe('gradient paints vs vega', () => {
  for (const [name, marks] of CASES) {
    it(name, async () => {
      const spec = { ...frame, marks }
      const want = await vegaSvg(structuredClone(spec))
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
      // not vacuous: vega wrote a definition and a reference
      expect(want).toMatch(/<(linear|radial)Gradient/)
      expect(want).toMatch(/(fill|stroke)="url\(#/)
    })
  }
})
