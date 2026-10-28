// @vitest-environment node
/**
 * The forms of an encode field reference (vega-parser encode/entry.js resolveField): `{datum}`, `{signal}`, `{group}` and
 * `{parent}`, each of which may name its field with another reference -- `{parent: {datum: 'f'}}` is
 * `item.mark.group.datum[datum['f']]`, the field of the group's datum that the item's own datum names. Also a scale chosen so.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 200, height: 100, padding: 5 }
const cars = [{ A: 1, B: 10, nest: { n: 3 } }, { A: 3, B: 30, nest: { n: 7 } }, { A: 2, B: 15, nest: { n: 5 } }]
const spec = (y: any, extra: Record<string, unknown> = {}, rowExtra: Record<string, unknown> = {}): any => ({
  ...frame,
  data: [{ name: 'cars', values: cars }, { name: 'fields', values: [{ f: 'A', s: 'A', g: 'width' }, { f: 'B', s: 'B', g: 'height' }, { f: 'nest.n', s: 'A', g: 'x' }].map((r) => ({ ...r, ...rowExtra })) }],
  scales: [
    { name: 'ord', type: 'point', range: 'width', domain: { data: 'fields', field: 'f' } },
    { name: 'A', type: 'linear', range: 'height', domain: { data: 'cars', field: 'A' } },
    { name: 'B', type: 'linear', range: 'height', domain: { data: 'cars', field: 'B' } },
  ],
  marks: [{
    type: 'group',
    from: { data: 'cars' },
    marks: [{
      type: 'symbol',
      from: { data: 'fields' },
      encode: { enter: { x: { scale: 'ord', field: 'f' }, y, fill: { value: 'steelblue' } } },
    }],
  }],
  ...extra,
})
const CASES: Record<string, any> = {
  'parent: named by a datum field': spec({ scale: { datum: 's' }, field: { parent: { datum: 's' } } }),
  'parent: named by a datum field, a scale of its own': spec({ scale: 'B', field: { parent: { datum: 's' } } }),
  'parent: a plain path': spec({ scale: 'A', field: { parent: 'A' } }),
  'parent: a nested path in the datum': spec({ scale: 'A', field: { parent: 'nest.n' } }),
  'parent: named by a signal': { ...spec({ scale: 'A', field: { parent: { signal: "'A'" } } }) },
  'group: named by a datum field': spec({ field: { group: { datum: 'g' } } }),
  'group: a plain name': spec({ field: { group: 'height' }, mult: 0.5 }),
  'datum: a field of the datum named by a field of the datum': spec({ field: { datum: { datum: 'f' } } }, {}, { A: 11, B: 22, 'nest.n': 33 }),
}
describe('encode field references', () => {
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
