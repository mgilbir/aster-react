// @vitest-environment node
/**
 * A group mark with both `from.data` and `from.facet.groupby` (vega-parser marks/data.js): the group items are the rows of
 * `from.data` (the datum of an item is that row, not a partition key), and each item's facet dataset is the rows of `facet.data`
 * that share the item's key.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const tuples = [
  { a: 0, b: 'a', c: 6.3 }, { a: 0, b: 'a', c: 4.2 }, { a: 0, b: 'b', c: 6.8 }, { a: 0, b: 'c', c: 5.1 },
  { a: 1, b: 'b', c: 4.4 }, { a: 2, b: 'b', c: 3.5 }, { a: 2, b: 'c', c: 6.2 },
]
const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 300, padding: 5 }
const trellis = (extra: any[] = []): any => ({
  name: 'trellis',
  source: 'tuples',
  transform: [
    { type: 'aggregate', groupby: ['a'] },
    { type: 'formula', as: 'span', expr: '20 * datum.count' },
    { type: 'stack', field: 'span' },
    ...extra,
  ],
})
const nested = (over: Record<string, unknown> = {}): any => ({
  ...frame,
  signals: [{ name: 'height', update: 'trellisExtent[1]' }],
  data: [{ name: 'tuples', values: tuples }, trellis([{ type: 'extent', field: 'y1', signal: 'trellisExtent' }])],
  scales: [{ name: 'xscale', domain: { data: 'tuples', field: 'c' }, nice: true, zero: true, round: true, range: 'width' }],
  marks: [{
    type: 'group',
    from: { data: 'trellis', facet: { name: 'faceted', data: 'tuples', groupby: 'a' } },
    encode: { enter: { x: { value: 0 }, width: { signal: 'width' } }, update: { y: { field: 'y0' }, y2: { field: 'y1' }, stroke: { value: 'red' } } },
    scales: [{ name: 'yscale', type: 'band', paddingInner: 0.1, paddingOuter: 0.2, round: true, domain: { data: 'faceted', field: 'b' }, range: { step: 20 } }],
    axes: [{ orient: 'left', scale: 'yscale', ticks: false, domain: false, labelPadding: 4 }],
    marks: [{
      type: 'rect',
      from: { data: 'faceted' },
      encode: {
        enter: { x: { value: 0 }, x2: { scale: 'xscale', field: 'c' }, fill: { value: 'steelblue' } },
        update: { y: { scale: 'yscale', field: 'b' }, height: { scale: 'yscale', band: 1 } },
      },
    }],
    ...over,
  }],
})
const CASES: Record<string, any> = {
  'the nested bar chart (rows of from.data, partitions of facet.data)': nested(),
  'the items follow from.data, not the partitions': {
    ...nested(),
    data: [{ name: 'tuples', values: tuples }, trellis([{ type: 'collect', sort: { field: 'a', order: 'descending' } }, { type: 'extent', field: 'y1', signal: 'trellisExtent' }])],
  },
  'the facet data is another dataset than the one the rows were made from': {
    ...nested(),
    data: [
      { name: 'tuples', values: tuples },
      { name: 'more', values: tuples.map((t) => ({ ...t, c: t.c / 2 })) },
      { name: 'trellis', source: 'tuples', transform: [{ type: 'aggregate', groupby: ['a'] }, { type: 'formula', as: 'span', expr: '20 * datum.count' }, { type: 'stack', field: 'span' }, { type: 'extent', field: 'y1', signal: 'trellisExtent' }] },
    ],
    marks: [{ ...nested().marks[0], from: { data: 'trellis', facet: { name: 'faceted', data: 'more', groupby: 'a' } } }],
  },
  'two groupby fields': {
    ...nested(),
    data: [
      { name: 'tuples', values: tuples },
      { name: 'trellis', source: 'tuples', transform: [{ type: 'aggregate', groupby: ['a', 'b'] }, { type: 'formula', as: 'span', expr: '12 * datum.count' }, { type: 'stack', field: 'span' }, { type: 'extent', field: 'y1', signal: 'trellisExtent' }] },
    ],
    marks: [{ ...nested().marks[0], from: { data: 'trellis', facet: { name: 'faceted', data: 'tuples', groupby: ['a', 'b'] } } }],
  },
}
describe('a group mark faceted over the rows of another dataset', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(spec)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
