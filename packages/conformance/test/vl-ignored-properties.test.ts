// @vitest-environment node
/**
 * The properties @aster-charts/vl consumes without reading them (consume.ts `ignore`, in compile.ts / composite.ts) are the ones
 * vega-lite 6.4.3 ignores: for each rule, generated over the channels, marks and compositions it covers, vega-lite's output is the same
 * with and without the property, and @aster-charts/vl compiles the spec (no refusal) to what vega-lite draws. A rule that stopped being
 * true of vega-lite fails here, not silently in a chart.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { HEADER_IGNORED_ON } from '../../vl/src/compile.js'
import { drawsLikeVegaLite } from './vl-composition-render.js'

const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }
const vlJson = (spec: unknown): string => JSON.stringify((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: quiet }).spec)

const rows = Array.from({ length: 12 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', b: (i * 7) % 13 + 1, u: (i * 5) % 11 + 1, t: `2020-0${(i % 9) + 1}-15`, lon: -120 + i * 4, lat: 30 + i }))
const data = { values: rows }
const pt = { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'u', type: 'quantitative' } } }

/** [name, spec with the property, the same spec without it] */
type Case = [string, Record<string, unknown>, Record<string, unknown>]
const cases: Case[] = []
const pair = (name: string, make: (withIt: boolean) => Record<string, unknown>): void => { cases.push([name, make(true), make(false)]) }

// a composition operator's size
for (const [k, op] of [['hconcat', (v: unknown) => ({ hconcat: [v, v] })], ['vconcat', (v: unknown) => ({ vconcat: [v, v] })], ['concat', (v: unknown) => ({ concat: [v, v] })], ['repeat', (v: unknown) => ({ repeat: ['b', 'u'], spec: v })], ['facet', (v: unknown) => ({ facet: { column: { field: 'g', type: 'nominal' } }, spec: v })], ['wrapped facet', (v: unknown) => ({ facet: { field: 'g', type: 'nominal' }, spec: v })]] as const) {
  for (const size of ['width', 'height'] as const) pair(`${k}: the operator's ${size}`, (w) => ({ data, ...(w ? { [size]: 333 } : {}), ...op(pt) }))
}
// a nested view's background, padding and autosize (vega-lite reads them on the root view only), and a composition operator's `view`
const NESTINGS: Array<[string, (v: Record<string, unknown>) => Record<string, unknown>]> = [
  ['hconcat', (v) => ({ data, hconcat: [v, pt] })],
  ['layer', (v) => ({ data, layer: [v, { mark: 'rule', encoding: { y: { field: 'u', aggregate: 'mean', type: 'quantitative' } } }] })],
  ['facet', (v) => ({ data, facet: { column: { field: 'g', type: 'nominal' } }, spec: v })],
  ['repeat', (v) => ({ data, repeat: ['b', 'u'], spec: v })],
]
for (const [k, nest] of NESTINGS) {
  for (const [prop, v] of [['background', 'red'], ['padding', 40], ['autosize', 'none']] as const) pair(`${k}: a nested view's ${prop}`, (w) => nest({ ...pt, ...(w ? { [prop]: v } : {}) }))
}
for (const [k, op] of [['hconcat', { hconcat: [pt, pt] }], ['vconcat', { vconcat: [pt, pt] }], ['concat', { concat: [pt, pt] }], ['repeat', { repeat: ['b', 'u'], spec: pt }], ['facet', { facet: { column: { field: 'g', type: 'nominal' } }, spec: pt }], ['wrapped facet', { facet: { field: 'g', type: 'nominal' }, spec: pt }]] as const) {
  pair(`${k}: the operator's view background`, (w) => ({ data, ...op, ...(w ? { view: { fill: 'yellow', stroke: 'red', clip: true } } : {}) }))
}
// a header on a channel that is not a facet channel
for (const ch of HEADER_IGNORED_ON) {
  const mark = ['theta', 'theta2', 'radius', 'radius2'].includes(ch) ? 'arc' : ch === 'url' ? 'image' : ch.startsWith('lon') || ch.startsWith('lat') ? 'point' : 'point'
  const def = { field: ['href', 'url', 'description', 'key', 'detail', 'text', 'tooltip'].includes(ch) ? 'a' : 'b', type: ['key', 'detail', 'description', 'href', 'url', 'text', 'tooltip'].includes(ch) ? 'nominal' : ch === 'time' ? 'ordinal' : 'quantitative' }
  const geo = ch.startsWith('lon') || ch.startsWith('lat') ? { longitude: { field: 'lon', type: 'quantitative' }, latitude: { field: 'lat', type: 'quantitative' } } : { x: { field: 'b', type: 'quantitative' }, y: { field: 'u', type: 'quantitative' } }
  if (ch === 'time') continue
  pair(`header on ${ch}`, (w) => ({ data, mark, encoding: { ...geo, [ch]: { ...def, ...(w ? { header: { title: 'H', labelColor: 'red' } } : {}) } } }))
}
// mark-def properties vega-lite reads nowhere
for (const mark of ['bar', 'point', 'line', 'area', 'rect', 'tick', 'rule', 'text', 'arc', 'circle', 'square', 'trail']) {
  const enc = mark === 'arc' ? { theta: { field: 'b', type: 'quantitative' }, color: { field: 'a', type: 'nominal' } } : pt.encoding
  pair(`${mark}: mark bandSize`, (w) => ({ data, mark: { type: mark, ...(w ? { bandSize: 7 } : {}) }, encoding: enc }))
  pair(`${mark}: mark gradient`, (w) => ({ data, mark: { type: mark, ...(w ? { gradient: { x1: 0, y1: 1, x2: 0, y2: 0, stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] } } : {}) }, encoding: enc }))
}
// a sort under an explicit domain, or on a continuous scale; a band position on a plain continuous field
for (const ch of ['x', 'y', 'color', 'size', 'opacity']) {
  const def = { field: 'b', type: 'quantitative' }
  const enc = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...pt.encoding, [ch]: { ...def, ...extra } })
  pair(`${ch}: a sort on a continuous scale`, (w) => ({ data, mark: 'point', encoding: enc(w ? { sort: { field: 'u', op: 'sum', order: 'descending' } } : {}) }))
  pair(`${ch}: a band position on a plain continuous field`, (w) => ({ data, mark: 'point', encoding: enc(w ? { bandPosition: 0.2 } : {}) }))
  pair(`${ch}: a sort under an explicit nominal domain`, (w) => ({ data, mark: 'point', encoding: { ...pt.encoding, [ch]: { field: 'a', type: 'nominal', scale: { domain: ['C', 'A', 'B'] }, ...(w ? { sort: { field: 'u', op: 'mean' } } : {}) } } }))
}
// what a longitude / latitude does not read
for (const [k, v] of [['scale', { type: 'log' }], ['axis', { title: 'L' }], ['legend', { title: 'L' }], ['stack', 'zero'], ['impute', { value: 0 }], ['band', 0.5], ['condition', { test: 'datum.b > 3', value: 3 }], ['bandPosition', 0.3], ['sort', { field: 'b', op: 'sum' }]] as const) {
  pair(`longitude: ${k}`, (w) => ({ data, mark: 'point', encoding: { longitude: { field: 'lon', type: 'quantitative', ...(w ? { [k]: v } : {}) }, latitude: { field: 'lat', type: 'quantitative' } } }))
}
pair('a longitude / latitude constant', (w) => ({ data, mark: 'point', encoding: { ...pt.encoding, ...(w ? { longitude: { value: 3 }, latitude: { value: 4 } } : {}) } }))
// a condition beside a position; a key constant; a condition beside an order field
for (const ch of ['x', 'y', 'xOffset']) pair(`${ch}: a condition beside the field`, (w) => ({ data, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' }, xOffset: { field: 'g', type: 'nominal' }, [ch]: { ...(ch === 'y' ? { field: 'b', type: 'quantitative' } : { field: ch === 'x' ? 'a' : 'g', type: 'nominal' }), ...(w ? { condition: { test: 'datum.b > 3', value: 2 } } : {}) } } }))
pair('key: a value', (w) => ({ data, ...pt, encoding: { ...pt.encoding, ...(w ? { key: { value: 'k' } } : {}) } }))
pair('order: a condition beside the field', (w) => ({ data, mark: 'line', encoding: { ...pt.encoding, order: { field: 'b', type: 'quantitative', ...(w ? { condition: { test: 'datum.b > 3', value: 1 } } : {}) } } }))
// a layer's data, transforms, projection and channels that every layer below replaces
pair('a layer\'s data every layer replaces', (w) => ({ ...(w ? { data: { values: [{ b: 99, u: 99 }] }, transform: [{ filter: 'datum.b > 0' }] } : {}), layer: [{ data, ...pt }, { data, mark: 'rule', encoding: { y: { field: 'u', aggregate: 'mean', type: 'quantitative' } } }] }))
pair('a layer\'s channel every layer replaces with null', (w) => ({ data, encoding: { ...(w ? { color: { field: 'a', type: 'nominal' } } : {}) }, layer: [{ ...pt, encoding: { ...pt.encoding, color: null } }, { mark: 'line', encoding: { ...pt.encoding, color: null } }] }))
pair('a layer\'s projection every layer replaces', (w) => ({ data, ...(w ? { projection: { type: 'naturalEarth1' } } : {}), layer: [{ projection: { type: 'mercator' }, mark: 'point', encoding: { longitude: { field: 'lon', type: 'quantitative' }, latitude: { field: 'lat', type: 'quantitative' } } }] }))
pair('a projection on a unit that projects nothing', (w) => ({ data, ...pt, ...(w ? { projection: { type: 'mercator' } } : {}) }))
// an arc's second offsets with no second channel
for (const k of ['theta2Offset', 'radius2Offset']) pair(`arc: ${k} with no second channel`, (w) => ({ data, mark: { type: 'arc', ...(w ? { [k]: 9 } : {}) }, encoding: { theta: { field: 'b', type: 'quantitative', stack: true }, radius: { field: 'u', type: 'quantitative' }, color: { field: 'a', type: 'nominal' } } }))
// what a composite mark does not read
pair('errorbar: a tooltip in its mark def', (w) => ({ data, mark: { type: 'errorbar', ...(w ? { tooltip: true } : {}) }, encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }))
pair('errorbar: an error value', (w) => ({ data, mark: 'errorbar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' }, ...(w ? { yError: { value: 2 } } : {}) } }))
pair('boxplot: a selection on the mark', (w) => ({ data, ...(w ? { params: [{ name: 'sel', select: 'interval' }] } : {}), mark: 'boxplot', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }))

describe('what @aster-charts/vl ignores, vega-lite ignores', () => {
  for (const [name, withIt, without] of cases) {
    it(name, async () => {
      expect(vlJson(withIt), 'vega-lite\'s output does not depend on it').toBe(vlJson(without))
      await drawsLikeVegaLite(withIt)
    }, 30_000)
  }
})
