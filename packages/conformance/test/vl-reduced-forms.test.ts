// @vitest-environment node
/**
 * Schema-valid forms found to draw differently from vega-lite 6.4.3 (C184, C442), each over the marks / channels / compositions it
 * applies to, through real Vega: a mark's `ariaRole`; a radius on a text, a height on a bar, a width on an image; an arc's radius offset
 * with a second radius; `x: {value: "width"}`; DateTime axis values; a facet's `bounds: "flush"`; a month sorted by an array of names (an axis, and a facet's
 * headers by a time unit's names or numbers); a bar's own width and height on any scales; a bar's corner radii
 * over every encoding shape. (A field with an escaped backslash:
 * vl-escaped-names.test.ts.)
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
// (a bar's own width / height, numbers: the band channel's size, or the range channel's when it has no stack and no second position,
// placed by align / baseline; in config.bar too)
{
  const t = (field: string) => ({ field, type: 'temporal' })
  const encodings: Array<[string, Record<string, unknown>]> = [
    ['x q, y q', { x: q('b'), y: q('c') }], ['x n, y q', { x: n('a'), y: q('c') }], ['x q, y n', { x: q('b'), y: n('a') }],
    ['x t, y q', { x: t('t'), y: q('c') }], ['x q, y t', { x: q('b'), y: t('t') }], ['x sum, y q', { x: { ...q('b'), aggregate: 'sum' }, y: q('c') }],
    ['stacked by colour', { x: q('b'), y: q('c'), color: n('a') }], ['y2', { x: q('b'), y: q('c'), y2: { field: 'b' } }], ['x2', { x: q('b'), x2: { field: 'c' }, y: q('c') }],
  ]
  const sizes: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ['width', { width: 8 }], ['height', { height: 6 }], ['width and height', { width: 8, height: 6 }], ['size, width and height', { size: 7, width: 8, height: 6 }],
    ['width and height, align left, baseline bottom', { width: 8, height: 6, align: 'left', baseline: 'bottom' }],
    ['config width and height', {}, { bar: { width: 9, height: 4 } }],
  ]
  for (const [en, encoding] of encodings) {
    for (const [sn, md, config] of sizes) cases.push([caseName('bar', sn, en), { data, mark: { type: 'bar', ...md }, encoding, ...(config ? { config } : {}) }])
  }
}
// (a bar's corner radii over every encoding shape (C442): a stack with no dimension channel - a typeless field, a lone measure - is one
// clipped stack group; cornerRadiusEnd rounds the end of an oriented bar, every corner of a bar ranged along its orientation, nothing of a
// bar with no orientation)
{
  const radii: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ['cornerRadius', { cornerRadius: 2 }], ['cornerRadiusEnd', { cornerRadiusEnd: 3 }], ['cornerRadiusTopLeft', { cornerRadiusTopLeft: 4 }],
    ['cornerRadius and cornerRadiusEnd', { cornerRadius: 2, cornerRadiusEnd: 5 }], ['config cornerRadiusEnd', {}, { bar: { cornerRadiusEnd: 4 } }],
  ]
  const shapes: Array<[string, Record<string, unknown>]> = [
    ['typeless y with a linear scale', { y: { field: 'b', scale: { type: 'linear' } } }], ['typeless x', { x: { field: 'b' } }], ['y q', { y: q('b') }], ['x q', { x: q('b') }],
    ['y q, colour', { y: q('b'), color: n('a') }], ['x sum, colour', { x: { ...q('b'), aggregate: 'sum' }, color: n('a') }], ['x n', { x: n('a') }], ['y n', { y: n('a') }],
    ['x n, y q', { x: n('a'), y: q('b') }], ['x q, y n', { x: q('b'), y: n('a') }], ['x n, y and y2', { x: n('a'), y: q('b'), y2: { field: 'c' } }],
    ['x and x2, y n', { x: q('b'), x2: { field: 'c' }, y: n('a') }], ['x q, y q', { x: q('b'), y: q('c') }], ['x n, y n', { x: n('a'), y: n('a') }],
  ]
  for (const [rn, md, config] of radii) {
    for (const [sn, encoding] of shapes) cases.push([caseName('bar', rn, sn), { data, mark: { type: 'bar', ...md }, encoding, ...(config ? { config } : {}) }])
  }
}
describe('the reduced forms draw as vega-lite draws them', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
