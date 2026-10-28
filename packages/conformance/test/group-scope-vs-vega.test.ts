// @vitest-environment node
/**
 * Group-scope details: a facet's `aggregate` names its outputs with `as` (the group item's datum carries them), and a scale
 * declared in a group is built against the group's own signals (a group `height` signal that differs from the view's).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const rows = [
  { k: 'a', v: 1 }, { k: 'a', v: 4 }, { k: 'a', v: 9 }, { k: 'b', v: 2 }, { k: 'b', v: 8 }, { k: 'c', v: 5 },
]
const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 200, height: 120, padding: 5 }
const labelled = (aggregate: Record<string, unknown> | undefined, text: string): any => ({
  ...frame,
  data: [{ name: 'rows', values: rows }],
  scales: [{ name: 'y', type: 'band', domain: ['a', 'b', 'c'], range: 'height' }],
  marks: [{
    type: 'group',
    from: { facet: { name: 'f', data: 'rows', groupby: 'k', ...(aggregate ? { aggregate } : {}) } },
    encode: { update: { y: { scale: 'y', field: 'k' }, width: { signal: 'width' }, height: { scale: 'y', band: 1 } } },
    marks: [{ type: 'text', encode: { update: { x: { value: 2 }, y: { value: 10 }, text: { signal: text } } } }],
  }],
})
const CASES: Record<string, any> = {
  'a facet aggregate with `as`': labelled({ ops: ['min', 'max', 'count'], fields: ['v', 'v', 'v'], as: ['lo', 'hi', 'n'] }, "join([parent.lo, parent.hi, parent.n], '/')"),
  'a facet aggregate without `as` (the default names)': labelled({ ops: ['min', 'max', 'count'], fields: ['v', 'v', 'v'] }, "join([parent.min_v, parent.max_v, parent.count], '/')"),
  'a facet aggregate with a partial `as`': labelled({ ops: ['sum', 'mean'], fields: ['v', 'v'], as: ['total'] }, "join([parent.total, parent.mean_v], '/')"),
  'no facet aggregate: the partition size is `count`': labelled(undefined, "parent.count"),
  'a group scale built on the group\'s own height signal': {
    ...frame,
    data: [{ name: 'rows', values: rows }],
    scales: [{ name: 'y', type: 'band', domain: ['a', 'b', 'c'], range: 'height' }],
    marks: [{
      type: 'group',
      from: { facet: { name: 'f', data: 'rows', groupby: 'k' } },
      encode: { update: { y: { scale: 'y', field: 'k' }, width: { signal: 'width' }, height: { scale: 'y', band: 1 } } },
      signals: [{ name: 'height', update: "bandwidth('y')" }, { name: 'w2', update: 'width / 2' }],
      scales: [{ name: 'inner', type: 'linear', domain: [0, 10], range: [{ signal: 'height' }, { signal: 'height * 0.25' }] }, { name: 'xs', type: 'linear', domain: [0, 10], range: [0, { signal: 'w2' }] }],
      marks: [{ type: 'symbol', from: { data: 'f' }, encode: { update: { x: { scale: 'xs', field: 'v' }, y: { scale: 'inner', field: 'v' } } } }],
      axes: [{ orient: 'left', scale: 'inner', values: [0, 5, 10] }],
    }],
  },
}
describe('group scopes', () => {
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

// A facet aggregate with `cross`: the cells of the cross-product of the groupby values, the empty ones last (vega Aggregate).
describe('a facet aggregate with cross', () => {
  const pairs = [
    { a: 3, b: 'x', v: 1 }, { a: 1, b: 'y', v: 2 }, { a: 3, b: 'y', v: 3 }, { a: 2, b: 'z', v: 4 }, { a: 1, b: 'x', v: 5 }, { a: 3, b: 'x', v: 6 },
  ]
  const cells = (aggregate: Record<string, unknown> | undefined, sort: unknown, groupby: string[] = ['a', 'b'], text = "join([parent.a, parent.b, parent.count], '/')"): any => ({
    ...frame,
    height: 200,
    data: [{ name: 'rows', values: pairs }],
    marks: [{
      type: 'group',
      from: { facet: { name: 'f', data: 'rows', groupby, ...(aggregate ? { aggregate } : {}) } },
      ...(sort ? { sort } : {}),
      encode: { update: { x: { value: 0 }, y: { signal: 'datum.a * 30 + (datum.b == "x" ? 0 : datum.b == "y" ? 8 : 16)' }, width: { value: 100 }, height: { value: 6 }, stroke: { value: 'gray' } } },
      marks: [{ type: 'text', encode: { update: { x: { value: 2 }, y: { value: 5 }, text: { signal: text }, fontSize: { value: 5 } } } }],
    }],
  })
  const CASES: Record<string, any> = {
    'cross, sorted': cells({ cross: true }, { field: ['datum.a', 'datum.b'], order: ['ascending', 'ascending'] }),
    'cross, in the order the cells come': cells({ cross: true }, undefined),
    'cross with ops': cells({ cross: true, ops: ['sum'], fields: ['v'], as: ['total'] }, { field: ['datum.a', 'datum.b'], order: ['ascending', 'ascending'] }, ['a', 'b'], "join([parent.a, parent.b, parent.total], '/')"),
    'cross over one field is no cross': cells({ cross: true }, undefined, ['a'], "join([parent.a, parent.count], '/')"),
    'no cross: the cells that exist': cells({}, { field: ['datum.a', 'datum.b'], order: ['ascending', 'ascending'] }),
  }
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
