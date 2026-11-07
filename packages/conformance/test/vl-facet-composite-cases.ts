/** The specs of the facet-over-a-composition differential (vl-facet-composite.test.ts): a facet whose spec is a repeat or a concat. */

const DATA = { values: Array.from({ length: 36 }, (_, i) => ({ c: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', h: ['u', 'v', 'w'][i % 3], x: i % 6, v: (i * 7) % 13 + 1, w: (i * 3) % 11 + 2 })) }
type Case = [string, Record<string, any>]
export const GROUPS: Array<[title: string, cases: Case[]]> = []
const q = (field: unknown, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const ref = (name: string) => ({ repeat: name })
const point = (e: Record<string, unknown>) => ({ mark: 'point', encoding: e })

const FACETS: Array<[string, Record<string, any>]> = [
  ['a column', { facet: { column: n('g') } }],
  ['a row', { facet: { row: n('g') } }],
  ['a row and a column', { facet: { row: n('g'), column: n('h') } }],
  ['a wrapped field', { facet: n('h'), columns: 2 }],
]
const CHILDREN: Array<[string, Record<string, any>]> = [
  ['a column repeat', { repeat: { column: ['v', 'w'] }, spec: point({ x: n('c'), y: q(ref('column')) }) }],
  ['a row repeat', { repeat: { row: ['v', 'w'] }, spec: point({ x: n('c'), y: q(ref('row')) }) }],
  ['a list repeat', { repeat: ['v', 'w'], spec: point({ x: q('x'), y: q(ref('repeat')) }) }],
  ['a grid repeat', { repeat: { row: ['v', 'w'], column: ['x', 'v'] }, spec: point({ x: q(ref('column')), y: q(ref('row')) }) }],
  ['a layer repeat', { repeat: { layer: ['v', 'w'] }, spec: { mark: 'line', encoding: { x: q('x'), y: q(ref('layer'), { aggregate: 'mean' }) } } }],
  ['a column repeat with a colour', { repeat: { column: ['v', 'w'] }, spec: point({ x: n('c'), y: q(ref('column')), color: n('c') }) }],
  ['a column repeat of bars', { repeat: { column: ['v', 'w'] }, spec: { mark: 'bar', encoding: { x: n('c'), y: q(ref('column'), { aggregate: 'sum' }) } } }],
  ['an hconcat', { hconcat: [point({ x: q('x'), y: q('v') }), point({ x: q('x'), y: q('w') })] }],
  ['a vconcat', { vconcat: [point({ x: q('x'), y: q('v') }), point({ x: q('x'), y: q('w') })] }],
  ['a concat in two columns', { columns: 2, concat: [point({ x: q('x'), y: q('v') }), point({ x: q('x'), y: q('w') }), point({ x: q('v'), y: q('w') })] }],
  ['an hconcat with a shared colour', { hconcat: [point({ x: q('x'), y: q('v'), color: n('c') }), point({ x: q('x'), y: q('w'), color: n('c') })] }],
  ['an hconcat of bars', { hconcat: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }, { mark: 'bar', encoding: { x: n('c'), y: q('w', { aggregate: 'mean' }) } }] }],
  ['an hconcat of a layer and a unit', { hconcat: [{ layer: [point({ x: q('x'), y: q('v') }), { mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } }] }, point({ x: q('x'), y: q('w') })] }],
  ['an hconcat with independent scales', { resolve: { scale: { y: 'independent' } }, hconcat: [point({ x: q('x'), y: q('v') }), point({ x: q('x'), y: q('w') })] }],
]
const list: Case[] = []
for (const [fn, f] of FACETS) for (const [cn, c] of CHILDREN) list.push([`${fn}, over ${cn}`, { data: DATA, ...f, spec: c }])
const columnRepeat = (u: Record<string, unknown>) => ({ repeat: { column: ['v', 'w'] }, spec: u })
list.push(
  ['a column facet over a repeat, with a title', { data: DATA, title: 'T', facet: { column: n('g') }, spec: columnRepeat(point({ x: n('c'), y: q(ref('column')) })) }],
  ['a column facet over a repeat, with a header', { data: DATA, facet: { column: n('g', { header: { title: 'Group', labelAngle: 0 } }) }, spec: columnRepeat(point({ x: n('c'), y: q(ref('column')) })) }],
  ['a column facet over a repeat, with spacing', { data: DATA, spacing: 30, facet: { column: n('g') }, spec: columnRepeat(point({ x: n('c'), y: q(ref('column')) })) }],
  ['a column facet over a repeat with a size', { data: DATA, facet: { column: n('g') }, spec: columnRepeat({ ...point({ x: n('c'), y: q(ref('column')) }), width: 100, height: 80 }) }],
  ['a column facet over a repeat of boxplots', { data: DATA, facet: { column: n('g') }, spec: columnRepeat({ mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column')) } }) }],
  ['a column facet over a repeat of errorbars', { data: DATA, facet: { column: n('g') }, spec: columnRepeat({ mark: 'errorbar', encoding: { x: n('c'), y: q(ref('column')) } }) }],
  ['a facet with independent scales over a repeat', { data: DATA, resolve: { scale: { y: 'independent' } }, facet: { column: n('g') }, spec: columnRepeat(point({ x: n('c'), y: q(ref('column')) })) }],
  ['a facet over a repeat with a transform on the facet', { data: DATA, transform: [{ filter: 'datum.v > 3' }], facet: { column: n('g') }, spec: columnRepeat(point({ x: n('c'), y: q(ref('column')) })) }],
  ['a facet over an hconcat that holds a repeat', { data: DATA, facet: { column: n('g') }, spec: { hconcat: [columnRepeat(point({ x: n('c'), y: q(ref('column')) })), point({ x: q('x'), y: q('v') })] } }],
)
GROUPS.push(['@aster-charts/vl == vega-lite: a facet over a repeat or a concat', list])
