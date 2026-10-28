// @vitest-environment node
/**
 * The view's own `encode` (vega-parser parseView: the root group mark's encode): `x` / `y` move the root group, the paint
 * channels paint its box. Both renderers of a scene (SVG string and DOM tree) and the canvas draw it.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const base = (extra: Record<string, unknown>): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 200,
  height: 100,
  padding: 10,
  scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }],
  axes: [{ orient: 'bottom', scale: 'x' }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 20 }, y: { value: 10 }, width: { value: 50 }, height: { value: 30 }, fill: { value: 'steelblue' } } } }],
  ...extra,
})
const CASES: Record<string, any> = {
  'x and y in enter': base({ encode: { enter: { x: { value: 30 }, y: { value: 15 } } } }),
  'x and y in update win over enter': base({ encode: { enter: { x: { value: 30 } }, update: { x: { value: 12 }, y: { value: 7 } } } }),
  'x and y from signals': base({ signals: [{ name: 'r', update: 'width / 4' }], encode: { enter: { x: { signal: 'r' }, y: { signal: 'r' } } } }),
  'a negative offset (the padding grows)': base({ encode: { enter: { x: { value: -25 }, y: { value: -14 } } } }),
  'autosize none': base({ autosize: 'none', encode: { enter: { x: { value: 30 }, y: { value: 15 } } } }),
  'autosize none contains padding (the radar chart)': base({ width: 300, height: 300, padding: 40, autosize: { type: 'none', contains: 'padding' }, signals: [{ name: 'radius', update: 'width / 2' }], encode: { enter: { x: { signal: 'radius' }, y: { signal: 'radius' } } } }),
  'a fill': base({ encode: { enter: { fill: { value: '#eeeeee' } } } }),
  'a stroke': base({ encode: { enter: { stroke: { value: 'red' }, strokeWidth: { value: 3 } } } }),
  'a position and a fill together': base({ encode: { enter: { x: { value: 20 }, y: { value: 20 }, fill: { value: 'gold' }, fillOpacity: { value: 0.5 } } } }),
}
describe('the view encode', () => {
  for (const [name, s] of Object.entries(CASES)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
