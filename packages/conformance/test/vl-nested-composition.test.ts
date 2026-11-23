// @vitest-environment node
/**
 * Compositions inside compositions, against vega-lite 6.4.3 through real Vega: the outer operator (hconcat, vconcat, concat in columns)
 * x the inner one (a repeat, a repeat in rows and columns, an hconcat, a vconcat, a layer) x what each view draws (two-dimensional, or
 * one-dimensional: a strip of ticks along x or along y, whose other size the composition gives it) x the view beside it (C168, C184).
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 12 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], b: (i * 7) % 13 + 1, d: (i * 3) % 7 + 1, e: (i * 5) % 11 + 2 }))
const data = { values: rows }
type View = Record<string, unknown>
const q = (field: string) => ({ field, type: 'quantitative' })

/** A view over the repeated field `r` (or a plain field when not repeated). */
const VIEWS: Array<[string, (r: unknown) => View]> = [
  ['2D points', (r) => ({ mark: 'point', encoding: { x: { ...q('b'), ...(r ? { field: r } : {}) }, y: q('e') } })],
  ['ticks along x', (r) => ({ mark: 'tick', encoding: { x: { ...q('b'), ...(r ? { field: r } : {}) } } })],
  ['ticks along y', (r) => ({ mark: 'tick', encoding: { y: { ...q('b'), ...(r ? { field: r } : {}) } } })],
  ['bars', (r) => ({ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { ...q('b'), aggregate: 'sum', ...(r ? { field: r } : {}) } } })],
]
const INNER: Array<[string, (v: (r: unknown) => View) => View]> = [
  ['a repeat', (v) => ({ repeat: ['b', 'd'], spec: v({ repeat: 'repeat' }) })],
  ['a row repeat', (v) => ({ repeat: { row: ['b', 'd'] }, spec: v({ repeat: 'row' }) })],
  ['a column repeat', (v) => ({ repeat: { column: ['b', 'd'] }, spec: v({ repeat: 'column' }) })],
  ['an hconcat', (v) => ({ hconcat: [v(undefined), v(undefined)] })],
  ['a vconcat', (v) => ({ vconcat: [v(undefined), v(undefined)] })],
]
const OUTER: Array<[string, (inner: View, beside: View) => View]> = [
  ['vconcat', (inner, beside) => ({ data, vconcat: [inner, beside] })],
  ['hconcat', (inner, beside) => ({ data, hconcat: [inner, beside] })],
  ['concat in 2 columns', (inner, beside) => ({ data, columns: 2, concat: [inner, beside, beside] })],
  ['vconcat in an hconcat', (inner, beside) => ({ data, hconcat: [{ vconcat: [inner, beside] }, beside] })],
]
const bar = VIEWS[3]![1](undefined)

const cases: Array<[string, View]> = []
for (const [oName, outer] of OUTER) {
  for (const [iName, inner] of INNER) {
    for (const [vName, view] of VIEWS) cases.push([caseName(oName, iName, vName), outer(inner(view), bar)])
  }
}

describe('a composition inside another draws as vega-lite draws it', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
