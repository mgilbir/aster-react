/** The specs of the view-name differential (vl-view-names.test.ts): a view with a `name`, in every kind of view, with the scales, signals and legends that carry it. */

const DATA = { values: Array.from({ length: 24 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 + 2, n: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', t: `2020-0${1 + (i % 9)}-01` })) }
type Case = [string, Record<string, any>]
export const GROUPS: Array<[title: string, cases: Case[]]> = []
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const t = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'temporal', ...extra })

const unit = (extra: Record<string, unknown> = {}, encoding: Record<string, unknown> = {}) => ({ mark: 'point', encoding: { x: q('q'), y: q('q2'), ...encoding }, ...extra })
const kinds: Case[] = []
const NAMES = ['outer', 'my chart', 'a-b']
for (const name of NAMES) {
  kinds.push(
    [`${name}: a unit`, { name, ...unit() }],
    [`${name}: a unit with a colour legend`, { name, ...unit({}, { color: n('n') }) }],
    [`${name}: a unit with size and opacity`, { name, ...unit({}, { size: q('q'), opacity: q('q2') }) }],
    [`${name}: a bar with nominal x`, { name, mark: 'bar', encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }) } }],
    [`${name}: a unit with a step width`, { name, width: { step: 20 }, mark: 'bar', encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }) } }],
    [`${name}: a time unit`, { name, mark: 'bar', encoding: { x: t('t', { timeUnit: 'month' }), y: q('q', { aggregate: 'sum' }) } }],
    [`${name}: a binned unit`, { name, mark: 'bar', encoding: { x: q('q', { bin: true }), y: { aggregate: 'count' } } }],
    [`${name}: a layer`, { name, layer: [unit(), { mark: 'line', encoding: { x: q('q'), y: q('q2', { aggregate: 'mean' }) } }] }],
    [`${name}: a layer with a colour`, { name, encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }), color: n('g') }, layer: [{ mark: 'bar' }, { mark: 'point' }] }],
    [`${name}: independent y scales in a layer`, { name, resolve: { scale: { y: 'independent' } }, layer: [unit(), { mark: 'line', encoding: { x: q('q'), y: q('q2', { aggregate: 'mean' }) } }] }],
    [`${name}: an hconcat`, { name, hconcat: [unit(), unit({}, { y: q('q') })] }],
    [`${name}: a vconcat`, { name, vconcat: [unit(), unit({}, { y: q('q') })] }],
    [`${name}: a concat in two columns`, { name, columns: 2, concat: [unit(), unit(), unit()] }],
    [`${name}: an hconcat with a legend`, { name, hconcat: [unit({}, { color: n('n') }), unit({}, { color: n('n') })] }],
    [`${name}: a facet column`, { name, facet: { column: n('g') }, spec: unit() }],
    [`${name}: a facet row and column`, { name, facet: { row: n('g'), column: n('n') }, spec: unit() }],
    [`${name}: a facet with independent scales`, { name, resolve: { scale: { y: 'independent' } }, facet: { column: n('g') }, spec: unit() }],
    [`${name}: a faceted unit`, { name, ...unit({}, { column: n('g') }) }],
    [`${name}: a repeat`, { name, repeat: { column: ['q', 'q2'] }, spec: unit({}, { y: q({ repeat: 'column' } as never) }) }],
    [`${name}: a layer repeat`, { name, repeat: { layer: ['q', 'q2'] }, spec: { mark: 'line', encoding: { x: n('n'), y: q({ repeat: 'layer' } as never, { aggregate: 'mean' }) } } }],
    [`${name}: an interval selection`, { name, params: [{ name: 'brush', select: 'interval' }], mark: 'point', encoding: { x: q('q'), y: q('q2'), color: { condition: { param: 'brush', value: 'red' }, value: 'grey' } } }],
    [`${name}: a point selection in a layer`, { name, layer: [{ params: [{ name: 'pick', select: 'point' }], mark: 'point', encoding: { x: q('q'), y: q('q2'), color: { condition: { param: 'pick', value: 'red' }, value: 'grey' } } }, { mark: 'rule', encoding: { y: q('q2', { aggregate: 'mean' }) } }] }],
    [`${name}: bound scales`, { name, params: [{ name: 'grid', select: 'interval', bind: 'scales' }], ...unit() }],
    [`${name}: a title`, { name, title: 'A title', ...unit() }],
    [`${name}: a text mark with a size`, { name, mark: 'text', encoding: { x: q('q'), y: q('q2'), text: n('n'), size: q('q') } }],
    [`${name}: a stacked bar`, { name, mark: 'bar', encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }), color: n('g') } }],
    [`${name}: a named child of a concat`, { hconcat: [{ name, ...unit() }, unit()] }],
    [`${name}: a named layer in a layer`, { layer: [{ name, ...unit() }, { mark: 'line', encoding: { x: q('q'), y: q('q2', { aggregate: 'mean' }) } }] }],
    [`${name}: a named layer inside a named concat`, { name: 'top', vconcat: [{ name, layer: [unit(), { mark: 'rule', encoding: { y: q('q2', { aggregate: 'mean' }) } }] }, unit()] }],
    [`${name}: a crossfilter across a concat`, { name, params: [{ name: 'brush', select: 'interval' }], hconcat: [unit(), unit({ transform: [{ filter: { param: 'brush' } }] })] }],
    [`${name}: a selection declared in each child`, { name, hconcat: [unit({ params: [{ name: 'pickA', select: 'point' }] }), unit({ params: [{ name: 'pickB', select: 'interval' }] })] }],
    [`${name}: a selection in a facet`, { name, facet: { column: n('g') }, spec: unit({ params: [{ name: 'brush', select: 'interval' }] }) }],
    [`${name}: a selection in a repeat`, { name, repeat: { column: ['q', 'q2'] }, spec: unit({ params: [{ name: 'brush', select: 'interval' }] }, { y: q({ repeat: 'column' } as never) }) }],
    [`${name}: independent colour scales in a concat`, { name, resolve: { scale: { color: 'independent' } }, hconcat: [unit({}, { color: n('n') }), unit({}, { color: n('g') })] }],
    [`${name}: a legend of a binned colour`, { name, mark: 'point', encoding: { x: q('q'), y: q('q2'), color: q('q', { bin: true }) } }],
    [`${name}: a bar with a size`, { name, mark: 'bar', encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }), size: { value: 12 } } }],
    [`${name}: a wrapped facet`, { name, facet: n('n'), columns: 2, spec: unit() }],
    [`${name}: a faceted unit sorted by an aggregate of its rows`, { name, mark: 'point', encoding: { facet: n('n', { columns: 2, sort: { op: 'median', field: 'q' } }), x: q('q', { aggregate: 'median' }), y: n('g') } }],
    [`${name}: a faceted unit with a y sorted by its own aggregate`, { name, mark: 'point', height: { step: 12 }, encoding: { facet: n('n', { columns: 2, sort: { op: 'median', field: 'q' } }), x: q('q', { aggregate: 'median', scale: { zero: false } }), y: n('g', { sort: '-x' }), color: n('t') } }],
    [`${name}: a facet row sorted by an aggregate`, { name, facet: { row: n('n', { sort: { op: 'median', field: 'q' } }) }, spec: unit() }],
    [`${name}: a nested layer`, { name, layer: [{ layer: [unit(), unit({ mark: 'rule' })] }, unit({ mark: 'line' })] }],
  )
}
kinds.push(
  ['no name: a layer of a bar and a point with a colour', { encoding: { x: n('n'), y: q('q', { aggregate: 'sum' }), color: n('g') }, layer: [{ mark: 'bar' }, { mark: 'point' }] }],
  ['no name: size and opacity', unit({}, { size: q('q'), opacity: q('q2') })],
)
GROUPS.push(['@aster/vl == vega-lite: the name of a view', kinds.map(([name, spec]) => [name, { data: DATA, ...spec }] as Case)])
