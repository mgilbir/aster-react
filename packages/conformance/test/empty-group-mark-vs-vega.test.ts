// @vitest-environment node
/**
 * A group mark with no items (its data is empty, its facet has no partition) is still a mark container in vega's scenegraph:
 * the SVG has its (empty) `<g class="mark-group role-scope">` in the place its mark has in the spec.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 120, height: 60, padding: 5 }
const rect = (extra: Record<string, unknown> = {}): any => ({ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'tomato' } } }, ...extra })
const child = { type: 'symbol', encode: { update: { x: { value: 3 }, y: { value: 3 }, fill: { value: 'navy' } } } }
const CASES: Record<string, any> = {
  'from an empty dataset': { ...frame, data: [{ name: 'none', values: [] }], marks: [rect(), { type: 'group', from: { data: 'none' }, marks: [child] }] },
  'from a dataset filtered to nothing, between two marks': {
    ...frame, data: [{ name: 't', values: [{ a: 1 }], transform: [{ type: 'filter', expr: 'datum.a > 5' }] }],
    marks: [rect(), { type: 'group', name: 'cells', from: { data: 't' }, marks: [child] }, rect({ name: 'after' })],
  },
  'a facet with no partition': {
    ...frame, data: [{ name: 't', values: [] }],
    marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'a' } }, marks: [{ ...child, from: { data: 'f' } }] }],
  },
  'a named group mark with a style and no items': { ...frame, data: [{ name: 'none', values: [] }], marks: [{ type: 'group', name: 'g', style: 'cell', from: { data: 'none' } }] },
  'a clipped group mark with no items': { ...frame, data: [{ name: 'none', values: [] }], marks: [rect(), { type: 'group', clip: true, from: { data: 'none' }, marks: [child] }] },
  'an empty group mark in a group item': {
    ...frame, data: [{ name: 'none', values: [] }],
    marks: [{ type: 'group', encode: { update: { width: { value: 60 }, height: { value: 30 } } }, marks: [rect(), { type: 'group', from: { data: 'none' }, marks: [child] }] }],
  },
  'with an axis (autosize pad sees the container)': {
    ...frame, data: [{ name: 'none', values: [] }], scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: 'width' }], axes: [{ orient: 'bottom', scale: 'x' }],
    marks: [{ type: 'group', from: { data: 'none' }, marks: [child] }],
  },
  'the control: a group mark with an item': { ...frame, data: [{ name: 't', values: [{ a: 1 }] }], marks: [{ type: 'group', from: { data: 't' }, marks: [child] }] },
}
describe('a group mark with no items', () => {
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
