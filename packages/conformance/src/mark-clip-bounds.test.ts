// @vitest-environment jsdom
/**
 * A mark's `clip` bounds the mark to the ENCLOSING group's frame (vega-scenegraph boundClip, run by
 * vega-view-transforms' Bound after every mark): what overflows the frame does not pad the view.
 * Compared with real Vega under autosize pad, for every mark type, a boolean and a {signal} clip.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>
async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}
const compare = async (spec: Spec): Promise<string[]> => diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))

const DATA = [{ name: 't', values: [{ a: -40, b: -30, c: 'u' }, { a: 50, b: 60, c: 'v' }, { a: 190, b: 140, c: 'w' }] }]
const MARKS: Record<string, Record<string, unknown>> = {
  symbol: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 200 }, fill: { value: 'steelblue' } },
  rect: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 30 }, height: { value: 22 }, fill: { value: 'tomato' } },
  rule: { x: { field: 'a' }, y: { value: -20 }, y2: { field: 'b' }, stroke: { value: '#222' } },
  text: { x: { field: 'a' }, y: { field: 'b' }, text: { field: 'c' }, fill: { value: 'purple' } },
  line: { x: { field: 'a' }, y: { field: 'b' }, stroke: { value: 'green' } },
  area: { x: { field: 'a' }, y: { field: 'b' }, y2: { value: 100 }, fill: { value: 'gold' } },
  group: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 40 }, height: { value: 30 }, stroke: { value: '#888' } },
}

describe('mark clip bounds the mark to the enclosing frame', () => {
  for (const [type, update] of Object.entries(MARKS)) {
    for (const [label, clip] of [['true', true], ['signal', { signal: 'clipped' }], ['false', false]] as const) {
      it(`${type} clip ${label}`, async () => {
        const spec: Spec = {
          width: 150, height: 100, padding: 5, autosize: 'pad', data: DATA,
          signals: [{ name: 'clipped', value: true }],
          marks: [{ type, from: { data: 't' }, clip, encode: { update } }],
        }
        expect(await compare(spec)).toEqual([])
      })
    }
  }
  it('a clipped group mark with several items is bounded as one mark', async () => {
    const spec: Spec = {
      width: 150, height: 100, padding: 5, autosize: 'pad', data: DATA, signals: [{ name: 'clipped', value: true }],
      marks: [{ type: 'group', from: { data: 't' }, clip: { signal: 'clipped' }, encode: { update: { x: { field: 'a' }, y: { value: 10 }, width: { value: 20 }, height: { value: 20 }, stroke: { value: '#888' } } } }],
    }
    expect(await compare(spec)).toEqual([])
  })
})
