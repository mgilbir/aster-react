// @vitest-environment node
/**
 * The structural half of the compiler-parity check can fail on what it says it compares. Vega-lite's own output for a spec with a point
 * selection, a slider and a concat is compared with a copy of itself that has one planted difference; each must be seen, and the copy
 * with none must not be.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { AXIS_STEPS, groupsOf, INTERACTION, NODE_SHAPES, SIZE_TREE } from './vl-parity-structure.js'

const DATA = { values: [{ c: 'A', g: 'p', x: 1, y: 2, v: 5 }, { c: 'B', g: 'q', x: 2, y: 4, v: 9 }, { c: 'A', g: 'q', x: 3, y: 3, v: 2 }] }
const SPEC = {
  data: DATA,
  params: [{ name: 'pick', select: { type: 'point', fields: ['c'] } }, { name: 'cut', value: 2, bind: { input: 'range', min: 0, max: 10 } }],
  hconcat: [
    { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative', aggregate: 'sum' }, color: { condition: { param: 'pick', value: 'red' }, value: 'grey' }, opacity: { condition: { test: 'datum.v > cut', value: 1 }, value: 0.3 } } },
    { mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } },
  ],
}
/** A faceted spec with independent scales: its scales and axes live in the child groups. */
const FACET = { data: DATA, resolve: { scale: { x: 'independent', y: 'independent' }, axis: { x: 'independent', y: 'independent' } }, facet: { column: { field: 'g', type: 'nominal' } }, spec: { mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } } }
const compiled = (): any => (vl as any).compile(JSON.parse(JSON.stringify(SPEC))).spec
const compiledFacet = (): any => (vl as any).compile(JSON.parse(JSON.stringify(FACET))).spec
const copy = (v: any): any => JSON.parse(JSON.stringify(v))
const all = (v: any, side: 'vega-lite' | 'aster' = 'vega-lite') => ({ size: SIZE_TREE(v), axes: AXIS_STEPS(v), nodes: NODE_SHAPES(v, side), interaction: INTERACTION(v, side) })
const groups = (vg: any): any[] => groupsOf(vg).map(([, g]) => g)

describe('the structural comparison of the parity check sees what it compares', () => {
  const oracle = compiled()
  it('a copy with nothing planted is equal (control)', () => {
    expect(all(copy(oracle))).toEqual(all(oracle))
  })
  it('the spec has the parts the plants need', () => {
    expect(INTERACTION(oracle, 'vega-lite')).toMatchObject({ signals: expect.anything() })
    expect(JSON.stringify(INTERACTION(oracle, 'vega-lite'))).toContain('"bind"')
    expect(groups(oracle).length).toBeGreaterThan(2)
  })
  const plants: Array<[string, (v: any) => void]> = [
    ['an event stream (object form) that listens to another event', (v) => { for (const g of groups(v)) for (const s of g.signals ?? []) for (const h of s.on ?? []) for (const e of [h.events].flat()) if (e?.type) e.type = 'dblclick' }],
    ['the slider binding removed', (v) => { for (const s of v.signals) delete s.bind }],
    ['the slider bound to another range', (v) => { for (const s of v.signals) if (s.bind) s.bind.max = 99 }],
    ['the initial value of a param', (v) => { for (const s of v.signals) if (s.name === 'cut') s.value = 7 }],
    ['a mark set not interactive', (v) => { for (const g of groups(v)) for (const m of g.marks ?? []) if (m.type !== 'group') m.interactive = false }],
    ['a changed cursor', (v) => { for (const g of groups(v)) for (const m of g.marks ?? []) if (m.type !== 'group') m.encode = { ...m.encode, update: { ...m.encode?.update, cursor: { value: 'wait' } } } }],
    ['a changed scale range at the root', (v) => { for (const s of v.scales ?? []) if (/(^|_)[xy]$/.test(s.name)) s.range = [0, 1] }],
    ['an aggregate that groups by another field', (v) => { for (const g of groups(v)) for (const d of g.data ?? []) for (const t of d.transform ?? []) if (t.type === 'aggregate') t.groupby = [...(t.groupby ?? []), 'extra'] }],
  ]
  for (const [name, plant] of plants) {
    it(`sees ${name}`, () => {
      const planted = copy(oracle)
      plant(planted)
      expect(all(planted), 'the plant changed nothing the check compares').not.toEqual(all(oracle))
    })
  }
})

describe('and in the child groups of a facet', () => {
  const oracle = compiledFacet()
  it('the scales and axes are in the child groups', () => {
    expect((oracle.scales ?? []).filter((s: any) => /(^|_)x$/.test(s.name))).toEqual([])
    expect(groups(oracle).slice(1).some((g) => (g.scales ?? []).length > 0 && (g.axes ?? []).length > 0)).toBe(true)
  })
  it('a changed scale range in a child group is seen', () => {
    const planted = copy(oracle)
    for (const g of groups(planted).slice(1)) for (const s of g.scales ?? []) if (/(^|_)x$/.test(s.name)) s.range = [0, 1]
    expect(SIZE_TREE(planted)).not.toEqual(SIZE_TREE(oracle))
  })
  it('a changed tick step of a child group axis is seen', () => {
    const planted = copy(oracle)
    for (const g of groups(planted).slice(1)) for (const a of g.axes ?? []) a.tickMinStep = 5
    expect(AXIS_STEPS(planted)).not.toEqual(AXIS_STEPS(oracle))
  })
})
