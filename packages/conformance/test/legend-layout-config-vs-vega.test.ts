// @vitest-environment node
/**
 * `config.legend.layout` (vega-view-transforms legendParams): per-orient overrides of `anchor`, `frame`, `offset`, `margin`,
 * `direction`, `bounds` and `center`, over vega's defaults (offset 18, horizontal, left and right vertical).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (orient: string, layout: unknown, extra: Record<string, unknown> = {}, legend: Record<string, unknown> = {}): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 300,
  height: 160,
  padding: 5,
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    { name: 'c', type: 'ordinal', domain: ['alpha', 'beta', 'gamma'], range: ['red', 'green', 'blue'] },
    { name: 's', type: 'ordinal', domain: ['one', 'two'], range: [40, 160] },
  ],
  axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
  legends: [{ fill: 'c', orient, title: 'colour', ...legend }, { size: 's', orient, title: 'size', ...legend }],
  marks: [{ type: 'symbol', encode: { update: { x: { scale: 'x', value: 5 }, y: { scale: 'y', value: 5 } } } }],
  ...(layout === undefined ? {} : { config: { legend: { layout } } }),
  ...extra,
})
const CASES: Array<[string, any]> = [
  ['the defaults: bottom', spec('bottom', undefined)],
  ['the defaults: right', spec('right', undefined)],
  ['anchor middle, bottom', spec('bottom', { anchor: 'middle' })],
  ['anchor end, bottom', spec('bottom', { anchor: 'end' })],
  ['anchor middle, top', spec('top', { anchor: 'middle' })],
  ['anchor end, right', spec('right', { anchor: 'end' })],
  ['anchor middle, left', spec('left', { anchor: 'middle' })],
  ['anchor set for one orient only', spec('bottom', { bottom: { anchor: 'end' }, anchor: 'start' })],
  ['frame bounds, anchor middle', spec('bottom', { anchor: 'middle', frame: 'bounds' })],
  ['frame bounds, anchor end, right', spec('right', { anchor: 'end', frame: 'bounds' })],
  ['offset from the config', spec('bottom', { offset: 40 })],
  ['offset from the orient', spec('right', { right: { offset: 3 } })],
  ['the legends\' own offset wins', spec('right', { offset: 40 }, {}, { offset: 7 })],
  ['margin', spec('bottom', { margin: 20 })],
  ['direction vertical at the bottom', spec('bottom', { direction: 'vertical' })],
  ['direction horizontal at the right', spec('right', { right: { direction: 'horizontal' } })],
  ['bounds full', spec('bottom', { bounds: 'full' })],
  ['center', spec('bottom', { center: true })],
  ['center, vertical direction (the narrower legend is centred)', spec('bottom', { direction: 'vertical', center: true })],
  ['center on the column axis only', spec('bottom', { direction: 'vertical', center: { column: true } })],
  ['center on the row axis only, side by side', spec('bottom', { center: { row: true } })],
  ['bounds full with a padded, stroked legend', spec('right', { bounds: 'full' }, {}, { padding: 10, strokeColor: '#888', fillColor: '#eee' })],
  ['bounds full, vertical direction, anchored in the middle', spec('top', { bounds: 'full', direction: 'vertical', anchor: 'middle' }, {}, { padding: 6, strokeColor: 'red' })],
]
describe('config.legend.layout', () => {
  for (const [name, s] of CASES) {
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
