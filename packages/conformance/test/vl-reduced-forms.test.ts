// @vitest-environment node
/**
 * Schema-valid forms found to draw differently from vega-lite 6.4.3 (C184, C442), each over the marks / channels / compositions it
 * applies to, through real Vega: a mark's `ariaRole`; a radius on a text, a height on a bar, a width on an image; an arc's radius offset
 * with a second radius; `x: {value: "width"}`; DateTime axis values; a facet's `bounds: "flush"`; a month sorted by an array of names (an axis, and a facet's
 * headers by a time unit's names or numbers). (A field with an escaped backslash: vl-escaped-names.test.ts.)
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 6 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], b: i + 2, c: (i * 5) % 7 + 1, t: `2020-0${(i % 6) + 1}-15`, url: 'data:image/png;base64,iVBORw0KGgo=' }))
const data = { values: rows }
const q = (field: string) => ({ field, type: 'quantitative' })
const n = (field: string) => ({ field, type: 'nominal' })

const cases: Array<[string, Record<string, unknown>]> = []
for (const mark of ['bar', 'point', 'text', 'rect', 'line', 'area', 'tick', 'rule', 'arc']) {
  const enc = mark === 'arc' ? { theta: q('b'), color: n('a') } : { x: n('a'), y: q('b'), ...(mark === 'text' ? { text: n('a') } : {}) }
  cases.push([caseName(mark, 'ariaRole'), { data, mark: { type: mark, ariaRole: 'listitem', ariaRoleDescription: 'item' }, encoding: enc }])
}
for (const [mark, props] of [['text', { radius: 10, theta: 1 }], ['text', { radius: 10 }], ['bar', { height: 8 }], ['image', { width: 12, height: 9 }], ['point', { radius: 5 }]] as const) {
  const enc = mark === 'image' ? { x: q('b'), y: q('c'), url: { field: 'url', type: 'nominal' } } : mark === 'bar' && 'height' in props ? { x: q('b'), y: n('a') } : { x: q('b'), y: q('c'), ...(mark === 'text' ? { text: n('a') } : {}) }
  cases.push([caseName(mark, JSON.stringify(props)), { data, mark: { type: mark, ...props }, encoding: enc }])
}
cases.push(['arc: radiusOffset with radius2', { data, mark: { type: 'arc', radiusOffset: 5 }, encoding: { theta: q('b'), radius: q('c'), radius2: { value: 20 }, color: n('a') } }])
cases.push(['arc: radius2Offset with radius2', { data, mark: { type: 'arc', radius2Offset: 5 }, encoding: { theta: q('b'), radius: q('c'), radius2: { value: 20 }, color: n('a') } }])
for (const mark of ['text', 'point', 'rule']) {
  for (const ch of ['x', 'y'] as const) {
    const other = ch === 'x' ? 'y' : 'x'
    cases.push([caseName(mark, `${ch}: {value: "${ch === 'x' ? 'width' : 'height'}"}`), { data, mark, encoding: { [ch]: { value: ch === 'x' ? 'width' : 'height' }, [other]: q('b'), ...(mark === 'text' ? { text: n('a') } : {}) } }])
  }
}
for (const ch of ['x', 'y'] as const) {
  cases.push([caseName(ch, 'axis.values as DateTimes'), { data, mark: 'point', encoding: { [ch]: { field: 't', type: 'temporal', axis: { values: [{ year: 2020, month: 2, date: 1 }, { year: 2020, month: 'may', date: 1 }] } }, [ch === 'x' ? 'y' : 'x']: q('b') } }])
}
for (const ch of ['row', 'column', 'facet'] as const) {
  cases.push([caseName(`encoding ${ch}`, 'bounds flush'), { data, mark: 'point', encoding: { x: q('b'), y: q('c'), [ch]: { field: 'a', type: 'nominal', bounds: 'flush' } } }])
}
cases.push(['facet operator: bounds flush', { data, bounds: 'flush', facet: { column: n('a') }, spec: { mark: 'point', encoding: { x: q('b') } } }])
for (const ch of ['x', 'color']) {
  cases.push([caseName(ch, 'timeUnit month sorted by names'), { data, mark: 'point', encoding: { y: q('b'), [ch]: { field: 't', type: 'ordinal', timeUnit: 'month', sort: ['Jun', 'Jan'] } } }])
}
// (a facet's header sorted by an array of a time unit's names or numbers: the cells and headers in the array's order)
for (const ch of ['row', 'column', 'facet'] as const) {
  for (const [tu, sort] of [['month', ['Jun', 'Jan']], ['month', ['March', 'february', 'Jan']], ['month', [5, 1]], ['day', ['Wed', 'Mon']], ['quarter', [2, 1]], ['date', [15]]] as const) {
    const fd = { field: 't', type: 'ordinal', timeUnit: tu, sort }
    cases.push([caseName(`encoding ${ch}`, `${tu} sorted by ${JSON.stringify(sort)}`), { data, mark: 'point', encoding: { x: q('b'), y: q('c'), [ch]: fd } }])
    cases.push([caseName(`facet operator ${ch}`, `${tu} sorted by ${JSON.stringify(sort)}`), { data, facet: ch === 'facet' ? fd : { [ch]: fd }, spec: { mark: 'point', encoding: { x: q('b') } } }])
  }
}
describe('the reduced forms draw as vega-lite draws them', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
