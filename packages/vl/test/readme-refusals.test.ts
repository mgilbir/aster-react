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
// (the section itself, up to the next heading: a phrase in a later section does not count)
const LIST = README.slice(README.indexOf('## Throws (not supported)'), README.indexOf('\n## ', README.indexOf('## Throws (not supported)') + 1))

const data = { values: [{ a: 'A', b: 1, c: 2, d: '2020-01-01', lon: 1, lat: 2, t: 1 }] }
const q = (field: string): Record<string, unknown> => ({ field, type: 'quantitative' })
const n = (field: string): Record<string, unknown> => ({ field, type: 'nominal' })
const unit = (mark: unknown, encoding: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, mark, encoding, ...extra })
const sel = { name: 'p', select: 'interval' }
const timer = { name: 'anim', select: { type: 'point', on: 'timer', fields: ['t'] } }
const frame = [{ filter: { param: 'anim' } }]
const lonlat = { longitude: q('lon'), latitude: q('lat') }
const proj = { projection: { type: 'mercator' } }

/** [the words the README uses, a spec that exercises it, what the refusal says (not a refusal for another reason)] */
const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
  ['on a layer spec itself', { data, params: [sel], layer: [unit('point', { x: q('b') }), unit('line', { x: q('b') })].map(({ data: _d, ...u }) => u) }, /on a layer spec itself/],
  ['on a composition whose units have params of their own', { data, params: [sel], hconcat: [{ params: [{ name: 'q', select: 'point' }], mark: 'point', encoding: { x: q('b') } }] }, /replaces the parameters of a uni/],
  ['`views`', { data, params: [{ ...sel, views: ['a'] }], hconcat: [{ name: 'a', mark: 'point', encoding: { x: q('b') } }] }, /`views`/],
  ['`bin.extent` as anything but a `[min, max]` pair', unit('bar', { x: { field: 'b', type: 'quantitative', bin: { extent: { expr: 'ext' } } }, y: { aggregate: 'count' } }, { params: [{ name: 'ext', value: [0, 5] }] }), /bin\.extent/],
  ['a lookup from a selection of the same\n  unit', unit('point', { x: q('b') }, { params: [{ name: 'p', select: 'point' }], transform: [{ lookup: 'a', from: { param: 'p', key: 'a' } }] }), /in the unit that declares it/],
  ['`scale.domain.unionWith` in a layered spec', { data, layer: [{ params: [sel], mark: 'point', encoding: { x: { ...q('b'), scale: { domain: { unionWith: [0, 100] } } } } }, { mark: 'point', encoding: { x: q('b') } }] }, /unionWith/],
  ['a parameter\'s `push`', unit('point', { x: q('b') }, { params: [{ ...sel, push: 'outer' }] }), /push/],
  ['a geoshape without a GeoJSON `shape` field inside a facet', { data: { values: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { a: 'A' } }] }, facet: { row: { field: 'properties.a' } }, spec: { ...proj, mark: 'geoshape' } }, /geoshape with no `shape` field inside a facet/],
  ['positions on marks other than point', unit('bar', lonlat, proj), /only implemented for the point/],
  ['a half pair', unit('point', { longitude: q('lon') }, proj), /needs its pair/],
  ['one of a pair given as a value or a condition alone', unit('point', { longitude: { value: 1 }, latitude: q('lat') }, proj), /needs its pair/],
  ['a count of records (`aggregate: "count"` with no field)', unit('point', { longitude: { aggregate: 'count', type: 'quantitative' }, latitude: q('lat') }, proj), /count of records/],
  ['a longitude / latitude datum that is not a number', unit('point', { longitude: { datum: 'east', type: 'nominal' }, latitude: q('lat') }, proj), /must be a finite number/],
  ['a `time` channel needs a unit at the root, or in the\n  layers of the root', { data, hconcat: [{ params: [timer], transform: frame, mark: 'point', encoding: { x: q('b'), time: q('t') } }] }, /single top-level unit/],
  ['composite marks', unit('boxplot', { x: n('a'), y: q('b'), time: q('t') }, { params: [timer], transform: frame }), /animating it is not supported/],
  ['an errorbar or errorband whose measure is a nested path', unit('errorbar', { x: n('a'), y: q('o.v') }), /nested path or a name with a dot/],
  ['`timeUnit.maxbins`', unit('bar', { x: { field: 'd', type: 'temporal', timeUnit: { maxbins: 5 } }, y: q('c') }), /timeUnit\.maxbins/],
  ['errorbar / errorband over a binned channel', unit('errorbar', { x: { field: 'b', type: 'quantitative', bin: 'binned' }, y: q('c') }), /over a binned/],
  ['a `datum`\n  condition on fillOpacity', unit('point', { x: q('b'), fillOpacity: { condition: { test: 'datum.b > 1', datum: 2 }, value: 1 } }), /datum conditions/],
  // (a field condition on a field definition is not in the schema, so it is refused as that: it was listed as "a field condition that
  // reads a field other than the channel's own")
  ['A value the Vega-Lite schema does not allow where it stands', unit('point', { x: q('b'), color: { condition: { test: 'datum.b > 1', field: 'c', type: 'quantitative' }, field: 'b', type: 'quantitative' } }), /^\[aster\/vl\] encoding\.color\.condition: .*\(Vega-Lite 6\.4\.3 schema\)$/],
  ['an array of conditions that holds a field condition', unit('point', { x: q('b'), color: { condition: [{ test: 'datum.b > 1', field: 'a', type: 'nominal' }], value: 'g' } }), /must be value conditions/],
  ['`impute` or\n  pre-binned data (`binned`) on a channel other than x and y', unit('line', { x: q('b'), y: q('c'), color: { ...n('a'), impute: { value: 0 } } }), /`impute` only applies/],
  ['the `geojson` type on a channel other than shape', unit('point', { x: q('b'), color: { field: 'a', type: 'geojson' } }), /geojson type only applies/],
  ['a GeoJSON shape on any other mark', unit('point', { x: q('b'), shape: { field: 'g', type: 'geojson' } }), /only applies to the geoshape mark/],
  ['channel-level `band`', unit('bar', { x: { field: 'd', type: 'temporal', timeUnit: 'month', band: 0.5 } }), /`band` is not supported/],
  ['a condition that gives a field or a datum on a position channel', unit('point', { x: { condition: { test: 'datum.b > 1', field: 'c', type: 'quantitative' }, value: 1 }, y: q('b') }), /on a position channel/],
  ['`order` given as a\n  list', unit('line', { x: q('b'), y: q('c'), order: [{ field: 'a', type: 'nominal' }] }), /order given as a list/],
  ['`width` / `height: "container"` on a composition', { data, width: 'container', hconcat: [{ mark: 'point', encoding: { x: q('b') } }] }, /"container" is only supported/],
  ['a\n  `{"repeat": ...}` reference in a transform', { data, repeat: ['b'], spec: { transform: [{ filter: { field: { repeat: 'repeat' }, gt: 1 } }], mark: 'point', encoding: { x: q('b') } } }, /reference in a transform is not supported/],
  ['repeat\'s `row` / `column` given as a string', { data, repeat: { row: 'b' }, spec: { mark: 'point', encoding: { x: { field: { repeat: 'row' }, type: 'quantitative' } } } }, /reads the string "b" as the list of its characters/],
  ['`data: null`', { data: null, mark: 'point' }, /data: null/],
  ['config keys\n  outside the supported list', unit('point', { x: q('b') }, { config: { nonsense: 1 } }), /config property/],
  ['a wrapped facet', { data, facet: { row: { field: 'a' } }, spec: { facet: { field: 'b', type: 'nominal' }, spec: { mark: 'point', encoding: { x: q('b') } } } }, /wrapped facet/],
  ['a concat in a\n  layer', { data, layer: [{ hconcat: [{ mark: 'point' }] }] }, /not allowed inside `layer`/],
  ['layer repeats combined with row / column', { data, repeat: { layer: ['b', 'c'], row: ['b'] }, spec: { mark: 'point', encoding: { x: { field: { repeat: 'layer' }, type: 'quantitative' } } } }, /layer repeats combined/],
  ['layers whose scales are\n  incompatible or conflict', { data, layer: [{ mark: 'point', encoding: { x: n('a') } }, { mark: 'point', encoding: { x: q('b') } }] }, /independent x scales over layers sized differently/],
  ['independent x / y scales sized by steps in a\n  wrapped facet', { data, facet: n('a'), spec: { mark: 'point', encoding: { x: n('a'), y: q('b') } }, resolve: { scale: { x: 'independent' } } }, /sized by steps/],
  ['a facet of layers over different data', { data, facet: { row: { field: 'a' } }, spec: { layer: [{ data, mark: 'point' }, { data: { values: [{ a: 1 }] }, mark: 'line' }] } }, /different data sources/],
  ['`argmax` / `argmin` as an op of a `window`', unit('point', { x: q('b') }, { transform: [{ window: [{ op: 'argmax', field: 'b', as: 'm' }] }] }), /window op "argmax"/],
  ['sort arrays of DateTime objects', unit('point', { x: { field: 'd', type: 'temporal', sort: [{ year: 2020 }] } }), /DateTime objects/],
  ['is valid Vega-Lite but @aster-charts/vl does not implement it here, so it would be ignored', unit('point', { x: q('b'), color: { ...n('a'), header: { title: 'h' } } }), /encoding\.color\.header\.title: is valid Vega-Lite but/],
  ['a parameter named as a name the compiler makes', unit('bar', { x: n('a'), y: q('b') }, { params: [{ name: 'x_step', value: 1 }] }), /declares the Vega signal "x_step" twice/],
  ['independent x / y scales over layers sized\n  differently', { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b') } }, { mark: 'point', encoding: { x: q('c'), y: q('b') } }], resolve: { scale: { x: 'independent' } } }, /independent x scales over layers sized differently/],
  ['`axis: null` on a layer after one that draws the axis', { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: { ...q('c'), axis: null } } }] }, /`axis: null` on a layer after one that draws/],
  ['a layer in a facet that keeps its own x / y scales', { data, facet: { column: n('a') }, spec: { layer: [{ mark: 'point', encoding: { x: q('b'), y: q('b') } }, { mark: 'point', encoding: { x: q('b'), y: q('c') } }], resolve: { scale: { y: 'independent' } } } }, /a layer in a facet that keeps its own y scales/],
  ['Names that are members of Object.prototype', unit('bar', { x: n('a'), y: { ...q('valueOf'), aggregate: 'sum' } }), /encoding\.y\.field: a field named "valueOf" is not supported: Vega keeps names in plain objects/],
  ['Names with a backslash of their own', unit('point', { x: q('x\\\\y') }), /encoding\.x\.field: a field named "x\\\\\\\\y" is not supported here: it holds a backslash/],
  ['A selection projected over a nested field', unit('point', { x: q('b') }, { params: [{ name: 'p', select: { type: 'point', fields: ['o.v'] } }] }), /select\.fields: a selection cannot be projected over the nested field "o\.v"/],
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
  ['a shape field that is not GeoJSON on a geoshape (a shape legend; the geoshape draws its data)', { data: { values: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, a: 'A' }] }, ...proj, mark: 'geoshape', encoding: { shape: n('a') } }],
  ['`size` conditions on bars and ticks', unit('bar', { x: n('a'), y: q('b'), size: { condition: { test: 'datum.b > 1', value: 3 }, value: 5 } })],
  ['the key channel', unit('point', { x: q('b'), key: n('a') })],
  ['every property of a longitude / latitude definition (it was refused as "projected, not scaled")', unit('point', { longitude: { ...q('lon'), aggregate: 'mean', sort: 'descending', scale: null, axis: null, legend: null, stack: 'zero' }, latitude: { ...q('lat'), bin: true } }, proj)],
  ['a time unit and any data type on a longitude / latitude (it was refused as "quantitative only")', unit('point', { longitude: { field: 'lon', type: 'nominal' }, latitude: { field: 'lat', type: 'temporal', timeUnit: 'year' } }, proj)],
  ['`impute`, pre-binned data and `band` on a longitude / latitude (vega-lite ignores them)', unit('point', { longitude: { ...q('lon'), impute: { value: 0 }, band: 0.5 }, latitude: { ...q('lat'), bin: 'binned' } }, proj)],
  ['a selection on a named view', { data, params: [sel], hconcat: [{ name: 'v', mark: 'point', encoding: { x: q('b') } }] }],
  ['`header: null` on a facet', { data, facet: { row: { field: 'a', type: 'nominal', header: null } }, spec: { mark: 'point', encoding: { x: q('b') } } }],
  ['a nested view\'s background, padding and autosize (vega-lite ignores them)', { data, hconcat: [{ background: 'red', padding: 5, autosize: 'none', mark: 'point', encoding: { x: q('b') } }] }],
  ['`view` on a concat, and view.clip', { data, view: { fill: 'red' }, hconcat: [{ view: { clip: true }, mark: 'point', encoding: { x: q('b') } }] }],
  ['resolve on a layer, at every level', { data, layer: [{ layer: [unit('bar', { x: n('a'), y: q('b') }), unit('line', { x: n('a'), y: q('c') })].map(({ data: _d, ...u }) => u), resolve: { scale: { y: 'independent' } } }, { mark: 'rule', encoding: { y: q('b') } }], resolve: { legend: { color: 'independent' } } }],
]

describe('packages/vl/README.md "Throws (not supported)" matches the compiler', () => {
  for (const [words, spec, says] of REFUSED) {
    it(`names, and the compiler refuses: ${words.replace(/\s+/g, ' ')}`, () => {
      expect(LIST, 'the README does not say this').toContain(words)
      expect(() => compile(spec as never)).toThrow(VLCompileError)
      expect(() => compile(spec as never)).toThrow(says)
    })
  }

  for (const [what, spec] of COMPILES) {
    it(`compiles, so the README does not list it: ${what}`, () => {
      expect(() => compile(spec as never), what).not.toThrow()
    })
  }

  it('does not list what used to be refused', () => {
    for (const stale of ['`strokeDash`', '`angle`', '`binned: true`', '`bin: "binned"`', '`sequence`', 'horizontal\n  boxplots', '`params: true`', '`keyvals` ranges', 'named view', 'path mark with an overlay', 'a `datum` on a channel other than the positions', '`scale: null` on a channel other than', 'scale / legend implementation yet', '`size` conditions on bars', 'a shape field that is not', 'projected, not scaled']) {
      expect(LIST, stale).not.toContain(stale)
    }
  })
})
