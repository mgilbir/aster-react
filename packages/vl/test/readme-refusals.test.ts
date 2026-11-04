// @vitest-environment node
/**
 * The "Throws (not supported)" list of packages/vl/README.md is checked against the compiler: every feature it names is
 * refused with a VLCompileError, and the features that used to be on the list (and now compile) are not on it.
 * A list that nobody runs goes stale; this one fails when the README claims a refusal the compiler no longer makes, and
 * when a refusal is removed from the README while the compiler still makes it.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const LIST = README.slice(README.indexOf('## Throws (not supported)'), README.indexOf('## Known runtime gaps'))

const data = { values: [{ a: 'A', b: 1, c: 2, d: '2020-01-01', lon: 1, lat: 2, t: 1 }] }
const q = (field: string): Record<string, unknown> => ({ field, type: 'quantitative' })
const n = (field: string): Record<string, unknown> => ({ field, type: 'nominal' })
const unit = (mark: unknown, encoding: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, mark, encoding, ...extra })
const sel = { name: 'p', select: 'interval' }
const timer = { name: 'anim', select: { type: 'point', on: 'timer', fields: ['t'] } }
const frame = [{ filter: { param: 'anim' } }]
const lonlat = { longitude: q('lon'), latitude: q('lat') }
const proj = { projection: { type: 'mercator' } }

/** [the words the README uses, a spec that exercises it] */
const REFUSED: Array<[string, Record<string, unknown>]> = [
  ['on a layer spec itself', { data, params: [sel], layer: [unit('point', { x: q('b') }), unit('line', { x: q('b') })].map(({ data: _d, ...u }) => u) }],
  ['on a composition whose units have params of their own', { data, params: [sel], hconcat: [{ params: [{ name: 'q', select: 'point' }], mark: 'point', encoding: { x: q('b') } }] }],
  ['`views`', { data, params: [{ ...sel, views: ['a'] }], hconcat: [{ name: 'a', mark: 'point', encoding: { x: q('b') } }] }],
  ['`bin.extent` as anything but a `[min, max]` pair', unit('bar', { x: { field: 'b', type: 'quantitative', bin: { extent: { expr: 'ext' } } }, y: { aggregate: 'count' } }, { params: [{ name: 'ext', value: [0, 5] }] })],
  ['a lookup from a selection of the same\n  unit', unit('point', { x: q('b') }, { params: [{ name: 'p', select: 'point' }], transform: [{ lookup: 'a', from: { param: 'p', key: 'a' } }] })],
  ['`scale.domain.unionWith` in a layered spec', { data, layer: [{ params: [sel], mark: 'point', encoding: { x: { ...q('b'), scale: { domain: { unionWith: [0, 100] } } } } }, { mark: 'point', encoding: { x: q('b') } }] }],
  ['a parameter\'s `push`', unit('point', { x: q('b') }, { params: [{ ...sel, push: 'outer' }] })],
  ['a geoshape without a `shape` field inside a facet', { data: { values: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { a: 'A' } }] }, facet: { row: { field: 'properties.a' } }, spec: { ...proj, mark: 'geoshape' } }],
  ['positions on marks other than point', unit('bar', lonlat, proj)],
  ['a half pair', unit('point', { longitude: q('lon') }, proj)],
  ['a `time` channel needs a single\n  top-level unit', { data, hconcat: [{ params: [timer], transform: frame, mark: 'point', encoding: { x: q('b'), time: q('t') } }] }],
  ['composite marks', unit('boxplot', { x: n('a'), y: q('b'), time: q('t') }, { params: [timer], transform: frame })],
  ['`bind` / `value` on the timer', unit('point', { x: q('b'), time: q('t') }, { params: [{ ...timer, bind: { input: 'range' } }], transform: frame })],
  ['`timeUnit.maxbins`', unit('bar', { x: { field: 'd', type: 'temporal', timeUnit: { maxbins: 5 } }, y: q('c') })],
  ['errorbar / errorband over a binned channel', unit('errorbar', { x: { field: 'b', type: 'quantitative', bin: 'binned' }, y: q('c') })],
  ['`timeUnitBandPosition`', unit({ type: 'bar', timeUnitBandPosition: 0.5 }, { x: { field: 'd', type: 'temporal', timeUnit: 'month' } })],
  ['a `datum`\n  condition on fillOpacity', unit('point', { x: q('b'), fillOpacity: { condition: { test: 'datum.b > 1', datum: 2 }, value: 1 } })],
  ['a field condition that reads a field other than the\n  channel\'s own', unit('point', { x: q('b'), color: { condition: { test: 'datum.b > 1', field: 'c', type: 'quantitative' }, field: 'b', type: 'quantitative' } })],
  ['an array of conditions that holds a field condition', unit('point', { x: q('b'), color: { condition: [{ test: 'datum.b > 1', field: 'a', type: 'nominal' }], value: 'g' } })],
  ['`impute` or\n  pre-binned data (`binned`) on a channel other than x and y', unit('line', { x: q('b'), y: q('c'), color: { ...n('a'), impute: { value: 0 } } })],
  ['the `geojson` type on a channel other than shape', unit('point', { x: q('b'), color: { field: 'a', type: 'geojson' } })],
  ['a shape field that is not\n  GeoJSON on a geoshape', { data: { values: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, a: 'A' }] }, ...proj, mark: 'geoshape', encoding: { shape: n('a') } }],
  ['a GeoJSON shape on any other mark', unit('point', { x: q('b'), shape: { field: 'g', type: 'geojson' } })],
  ['channel-level `band`', unit('bar', { x: { field: 'd', type: 'temporal', timeUnit: 'month', band: 0.5 } })],
  ['`size` conditions on bars and ticks', unit('bar', { x: n('a'), y: q('b'), size: { condition: { test: 'datum.b > 1', value: 3 }, value: 5 } })],
  ['the positional mark-def constants', unit({ type: 'bar', x: 5 }, { y: q('b') })],
  ['`width` / `height: "container"` on a composition', { data, width: 'container', hconcat: [{ mark: 'point', encoding: { x: q('b') } }] }],
  ['`data: null`', { data: null, mark: 'point' }],
  ['config keys\n  outside the supported list', unit('point', { x: q('b') }, { config: { nonsense: 1 } })],
  ['a wrapped facet', { data, facet: { row: { field: 'a' } }, spec: { facet: { field: 'b', type: 'nominal' }, spec: { mark: 'point', encoding: { x: q('b') } } } }],
  ['a concat in a\n  layer', { data, layer: [{ hconcat: [{ mark: 'point' }] }] }],
  ['layer repeats combined with row / column', { data, repeat: { layer: ['b', 'c'], row: ['b'] }, spec: { mark: 'point', encoding: { x: { field: { repeat: 'layer' }, type: 'quantitative' } } } }],
  ['layers whose scales are\n  incompatible or conflict', { data, layer: [{ mark: 'point', encoding: { x: n('a') } }, { mark: 'point', encoding: { x: q('b') } }] }],
  ['a facet of layers over different data', { facet: { row: { field: 'a' } }, spec: { layer: [{ data, mark: 'point' }, { data: { values: [{ a: 1 }] }, mark: 'line' }] } }],
  ['`argmax` / `argmin` as an op of a `window`', unit('point', { x: q('b') }, { transform: [{ window: [{ op: 'argmax', field: 'b', as: 'm' }] }] })],
  ['sort arrays of DateTime objects', unit('point', { x: { field: 'd', type: 'temporal', sort: [{ year: 2020 }] } })],
]

/** Features the README used to list as refused, that compile now. */
const COMPILES: Array<[string, Record<string, unknown>]> = [
  ['`fillOpacity` and `strokeOpacity` fields', unit('point', { x: q('b'), fillOpacity: q('c'), strokeOpacity: n('a') })],
  ['strokeDash', unit('line', { x: q('b'), y: q('c'), strokeDash: n('a') })],
  ['angle', unit('point', { x: q('b'), angle: q('c') })],
  ['bin: "binned"', unit('bar', { x: { field: 'b', type: 'quantitative', bin: 'binned' }, x2: { field: 'c' }, y: q('c') })],
  ['timeUnit.binned', unit('bar', { x: { field: 'd', type: 'temporal', timeUnit: { unit: 'month', binned: true } }, y: q('c') })],
  ['a bin on a text channel', unit('text', { x: q('c'), text: { field: 'b', type: 'quantitative', bin: true } })],
  ['a time unit on a tooltip', unit('point', { x: q('c'), tooltip: { field: 'd', type: 'temporal', timeUnit: 'month' } })],
  ['channel-level impute', unit('line', { x: q('b'), y: { ...q('c'), impute: { value: 0 } } })],
  ['a size constant on a bar', unit('bar', { x: n('a'), y: q('b'), size: { value: 5 } })],
  ['theta mark-def constants', unit({ type: 'arc', theta: 1 }, { color: n('a') })],
  ['radius2 mark-def constants', unit({ type: 'arc', radius2: 10 }, { theta: q('b'), radius: q('c') })],
  ['the sequence generator', { data: { sequence: { start: 0, stop: 5, as: 'x' } }, mark: 'point', encoding: { x: q('x') } }],
  ['the sphere generator', { data: { sphere: true }, ...proj, mark: 'geoshape' }],
  ['a horizontal boxplot', unit('boxplot', { x: q('b'), y: n('a') })],
  ['argmax as an aggregate op', unit('point', { x: q('m') }, { transform: [{ aggregate: [{ op: 'argmax', field: 'b', as: 'm' }], groupby: ['a'] }] })],
  ['regression params: true', unit('text', { text: n('coef') }, { transform: [{ regression: 'b', on: 'c', params: true }] })],
  ['keyvals ranges', unit('point', { x: q('b') }, { transform: [{ impute: 'b', key: 'c', keyvals: { start: 0, stop: 5 } }] })],
  ['a facet inside a facet (row and column)', { data, facet: { row: { field: 'a' } }, spec: { facet: { column: { field: 'a' } }, spec: { mark: 'point', encoding: { x: q('b') } } } }],
  ['a point mark in a facet', { data, facet: { row: { field: 'a' } }, spec: { ...proj, mark: 'point', encoding: lonlat } }],
  ['`scale: null` on a position', unit('point', { x: { ...q('b'), scale: null } })],
  ['a `datum` on a size', unit('point', { x: q('b'), size: { datum: 2 } })],
  ['the key channel', unit('point', { x: q('b'), key: n('a') })],
  ['a selection on a named view', { data, params: [sel], hconcat: [{ name: 'v', mark: 'point', encoding: { x: q('b') } }] }],
]

describe('packages/vl/README.md "Throws (not supported)" matches the compiler', () => {
  for (const [words, spec] of REFUSED) {
    it(`names, and the compiler refuses: ${words.replace(/\s+/g, ' ')}`, () => {
      expect(LIST, 'the README does not say this').toContain(words)
      expect(() => compile(spec as never)).toThrow(VLCompileError)
    })
  }

  for (const [what, spec] of COMPILES) {
    it(`compiles, so the README does not list it: ${what}`, () => {
      expect(() => compile(spec as never), what).not.toThrow()
    })
  }

  it('does not list what used to be refused', () => {
    for (const stale of ['`strokeDash`', '`angle`', '`binned: true`', '`bin: "binned"`', '`sequence`', 'horizontal\n  boxplots', '`params: true`', '`keyvals` ranges', 'named view', 'path mark with an overlay', 'a `datum` on a channel other than the positions', '`scale: null` on a channel other than', 'scale / legend implementation yet']) {
      expect(LIST, stale).not.toContain(stale)
    }
  })
})
