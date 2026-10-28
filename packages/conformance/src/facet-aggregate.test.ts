/**
 * A group mark's `from.facet.aggregate` (what vega-lite emits for a sorted or crossed facet): the cell's datum carries the facet's
 * measures under their `as` names, and `cross` makes the empty cells of the full cross-product of the key values. Every case is
 * judged against real vega with the strict canonicalizer.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const VALUES = [
  { c: 'A', g: 'p', v: 3 }, { c: 'B', g: 'q', v: 9 }, { c: 'A', g: 'q', v: 5 }, { c: 'B', g: 'q', v: 1 }, { c: 'C', g: 'p', v: 7 },
]
/** A faceted group whose cells print the datum the facet gave them (a text mark reads `parent`), sorted by `sort`. */
const faceted = (facet: Record<string, unknown>, sort: string[], order: string[] = sort.map(() => 'ascending')): Spec => ({
  width: 200, height: 120, padding: 5, autosize: 'pad',
  data: [{ name: 'table', values: VALUES }],
  marks: [{
    type: 'group',
    from: { facet: { name: 'facet', data: 'table', ...facet } },
    sort: { field: sort, order },
    encode: { update: { width: { value: 40 }, height: { value: 20 }, fill: { value: '#eee' } } },
    marks: [{
      type: 'text',
      from: { data: 'facet' },
      encode: { update: { x: { value: 2 }, y: { value: 12 }, text: { signal: 'join([parent.c, parent.g, parent.n, parent.mx, parent.cnt, parent.total], "/")' } } },
    }],
  }],
  layout: { columns: 3, padding: 5 },
})

const CASES: Array<[string, Spec]> = [
  ['a facet without an aggregate (the cell count)', faceted({ groupby: ['c'], aggregate: undefined }, ['datum["c"]'])],
  ['a facet aggregate under its own names', faceted({ groupby: ['c'], aggregate: { fields: ['v'], ops: ['sum'], as: ['total'] } }, ['datum["total"]'], ['descending'])],
  ['a facet aggregate with several measures', faceted({ groupby: ['c'], aggregate: { fields: ['v', 'v'], ops: ['max', 'sum'], as: ['mx', 'total'] } }, ['datum["mx"]'], ['descending'])],
  ['a facet aggregate without names (op_field)', faceted({ groupby: ['c'], aggregate: { fields: ['v'], ops: ['max'] } }, ['datum["max_v"]'])],
  ['a crossed facet', faceted({ groupby: ['c', 'g'], aggregate: { cross: true } }, ['datum["c"]', 'datum["g"]'])],
  ['a crossed facet with measures', faceted({ groupby: ['g', 'c'], aggregate: { cross: true, fields: ['v'], ops: ['max'], as: ['mx'] } }, ['datum["g"]', 'datum["mx"]'], ['ascending', 'descending'])],
  ['a facet cross over one key (nothing to cross)', faceted({ groupby: ['c'], aggregate: { cross: true } }, ['datum["c"]'])],
]

describe('a facet aggregate matches vega', () => {
  it.each(CASES)('%s', async (_n, spec) => {
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
  })
  it('a crossed facet really draws the empty cells (an empty comparison would pass anything)', () => {
    const svg = renderSpec(CASES[4]![1] as never)
    expect((svg.match(/fill="#eee"/g) ?? []).length).toBe(6)
    expect((svg.match(/<text/g) ?? []).length).toBe(5)
  })
})
