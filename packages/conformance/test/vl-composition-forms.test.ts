// @vitest-environment node
/**
 * Schema-valid forms that were refused although vega-lite 6.4.3 draws them (C83), each over its variants, drawn by vega-lite and by
 * @aster-charts/vl through real Vega:
 *  - `width` / `height: "container"` in a facet's spec: each cell takes the container's size (`child_width` from containerSize(),
 *    updated on resize: the size signals are compared as well as the drawing);
 *  - a `{repeat}` reference in a condition's field, or a sort's (vega-lite normalize/repeater.ts replaces it there as in the channel);
 *  - a `sequence` generator with a `name`.
 * And two forms vega-lite compiles to a chart other than the spec's, which are refused (DECISIONS Q9), with vega-lite's output checked to
 * be wrong here: a `{repeat}` reference in a transform (vega-lite leaves it in the output, a field "[object Object]" or ""), and a repeat
 * row / column given as a string (the schema wants an array; vega-lite reads the string as the list of its characters).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

type Spec = Record<string, unknown>
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }
const rows = Array.from({ length: 8 }, (_, i) => ({ a: 'ABC'[i % 3], g: 'pq'[i % 2], b: i + 2, c: (i * 5) % 7 + 1, d: (i * 3) % 5 }))
const data = { values: rows }
const q = (field: unknown) => ({ field, type: 'quantitative' })
const n = (field: unknown) => ({ field, type: 'nominal' })
const vlOut = (spec: Spec): Spec => (vl as any).compile(plain(spec), { logger: quiet }).spec
/** The size signals and the autosize of a compiled spec (a container's signals are what the drawing does not show). */
const sizing = (vg: Spec): unknown => [((vg.signals ?? []) as Spec[]).filter((s) => /(^|_)(width|height)$/.test(String(s.name))), vg.autosize ?? null]

describe('width / height "container" in a facet\'s spec', () => {
  const unit = (size: Spec, mark = 'point', enc: Spec = { x: q('b'), y: q('c') }) => ({ ...size, mark, encoding: enc })
  for (const [sn, size] of [['width', { width: 'container' }], ['height', { height: 'container' }], ['both', { width: 'container', height: 'container' }], ['width, a fixed height', { width: 'container', height: 120 }]] as const) {
    const forms: Array<[string, Spec]> = [
      ['facet column', { data, facet: { column: n('g') }, spec: unit(size) }],
      ['facet row', { data, facet: { row: n('g') }, spec: unit(size) }],
      ['facet row and column', { data, facet: { row: n('g'), column: n('a') }, spec: unit(size) }],
      ['wrapped facet', { data, facet: n('a'), columns: 2, spec: unit(size) }],
      ['layer in a facet', { data, facet: { column: n('g') }, spec: { ...size, layer: [unit({}), unit({}, 'line')] } }],
      ['bars on a band scale', { data, facet: { column: n('g') }, spec: unit(size, 'bar', { x: n('a'), y: q('c') }) }],
      ['independent x', { data, facet: { column: n('g') }, spec: unit(size), resolve: { scale: { x: 'independent' } } }],
      ['a facet in a concat', { data, hconcat: [{ facet: { column: n('g') }, spec: unit(size) }] }],
      ['faceted through the encoding', { data, ...size, mark: 'point', encoding: { x: q('b'), y: q('c'), row: n('g') } }],
    ]
    for (const [fn, spec] of forms) {
      it(caseName(fn, sn), async () => {
        await drawsLikeVegaLite(spec)
        expect(sizing(compile(plain(spec)) as Spec)).toEqual(sizing(vlOut(spec)))
      }, 30_000)
    }
  }
})

describe('a {repeat} reference in a condition or a sort', () => {
  const cases: Array<[string, Spec]> = []
  for (const [rn, repeat, v] of [['repeat list', ['b', 'c'], 'repeat'], ['repeat row', { row: ['b', 'c'] }, 'row'], ['repeat column', { column: ['b', 'd'] }, 'column'], ['repeat row x column', { row: ['b', 'c'], column: ['c', 'd'] }, 'row']] as const) {
    const ref = { repeat: v }
    cases.push([caseName(rn, 'a param condition with the field'), { data, params: [{ name: 's', select: 'point' }], repeat, spec: { mark: 'point', encoding: { x: q(ref), y: q('c'), color: { condition: { param: 's', ...q(ref) }, value: 'grey' } } } }])
    cases.push([caseName(rn, 'a test condition with the field'), { data, repeat, spec: { mark: 'point', encoding: { x: q('b'), y: q('c'), color: { condition: { test: 'datum.c > 3', ...n(ref) }, value: 'grey' } } } }])
    cases.push([caseName(rn, 'a size condition'), { data, repeat, spec: { mark: 'point', encoding: { x: q(ref), y: q('c'), size: { condition: { test: 'datum.b > 3', ...q(ref) }, value: 10 } } } }])
    cases.push([caseName(rn, 'a sort by the field'), { data, repeat, spec: { mark: 'bar', encoding: { x: { ...n('a'), sort: { field: ref, op: 'sum' } }, y: { ...q(ref), aggregate: 'sum' } } } }])
  }
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})

describe('a sequence generator with a name', () => {
  const cases: Array<[string, Spec]> = [
    ['named', { data: { sequence: { start: 0, stop: 5 }, name: 'seq' }, mark: 'point', encoding: { x: q('data') } }],
    ['named, with as', { data: { sequence: { start: 0, stop: 5, as: 'v' }, name: 'seq' }, mark: 'point', encoding: { x: q('v') } }],
    ['named, with a step and a calculate', { data: { sequence: { start: 0, stop: 3, step: 0.5, as: 'v' }, name: 'seq' }, transform: [{ calculate: 'sin(datum.v)', as: 's' }], mark: 'line', encoding: { x: q('v'), y: q('s') } }],
    ['named, in a layer', { layer: [{ data: { sequence: { start: 0, stop: 5, as: 'v' }, name: 'seq' }, mark: 'point', encoding: { x: q('v') } }, { data, mark: 'rule', encoding: { x: q('b') } }] }],
  ]
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})

describe('forms vega-lite compiles to a chart other than the spec\'s are refused', () => {
  const ref = { repeat: 'repeat' }
  const inTransforms: Array<[string, Spec]> = [
    ['filter field', { filter: { field: ref, gt: 3 } }],
    ['aggregate field', { aggregate: [{ op: 'sum', field: ref, as: 's' }], groupby: ['a'] }],
    ['calculate as', { calculate: 'datum.b', as: ref }],
    ['bin field', { bin: true, field: ref, as: 's' }],
    ['timeUnit field', { timeUnit: 'month', field: ref, as: 's' }],
    ['window field', { window: [{ op: 'sum', field: ref, as: 's' }] }],
    ['fold', { fold: [ref] }],
  ]
  for (const [name, t] of inTransforms) {
    it(caseName('a {repeat} reference in a transform', name), () => {
      const spec = { data, repeat: ['b', 'c'], spec: { transform: [t], mark: 'point', encoding: { x: q({ repeat: 'repeat' }), y: q('c') } } }
      // (vega-lite writes the reference into its output as it is: a field read as "[object Object]", an empty field or name, or an object)
      const out = JSON.stringify(vlOut(spec).data)
      expect(['object Object', '"repeat":"repeat"', 'datum[\\"\\"]', '"field":""'].some((w) => out.includes(w)), `vega-lite's output: ${out.slice(0, 400)}`).toBe(true)
      expect(() => compile(plain(spec))).toThrowError(VLCompileError)
      expect(() => compile(plain(spec))).toThrowError(/a `\{"repeat": \.\.\.\}` reference in a transform is not supported/)
    })
  }
  for (const ch of ['row', 'column'] as const) {
    it(caseName('a repeat given as a string', ch), () => {
      const spec = { data, repeat: { [ch]: 'bc' }, spec: { mark: 'point', encoding: { x: q({ repeat: ch }), y: q('c') } } }
      // (vega-lite repeats the characters: two views, of the fields "b" and "c", not one of the field "bc")
      const fields = JSON.stringify(vlOut(spec).marks)
      expect(fields.includes('"field":"b"') && fields.includes('"field":"c"') && !fields.includes('"field":"bc"')).toBe(true)
      expect(() => compile(plain(spec))).toThrowError(/must be an array of field names \(\["bc"\]\): vega-lite 6\.4\.3 reads the string "bc" as the list of its characters/)
    })
  }
})
