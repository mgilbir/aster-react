// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { DATA, xq, yq, cn, compileFrozen } from './helpers.js'

const unit = (extra: Record<string, unknown> = {}) => ({ data: DATA, mark: 'point', encoding: { x: xq, y: yq }, ...extra })

/** Each entry: a spec the validation layer must reject, and a phrase its message must carry. */
const REJECTED: Array<[string, unknown, RegExp]> = [
  // --- views: missing/ambiguous mark and unknown keys
  ['a unit without a mark', { data: DATA, encoding: { x: xq } }, /needs exactly one of `mark`/],
  ['mark and layer together', { data: DATA, mark: 'point', layer: [] }, /ambiguous view/],
  ['an unknown top-level key', unit({ colour: 'red' }), /unknown top-level property "colour"/],
  ['an unknown mark', unit({ mark: 'blob' }), /unknown mark type/],
  ['a map mark inside a facet', { data: DATA, facet: { field: 'c', type: 'nominal' }, spec: unit({ mark: 'geoshape', encoding: {} }) }, /inside a facet/],
  ['an errorbar with no continuous axis', unit({ mark: 'errorbar', encoding: { x: cn, y: cn } }), /continuous x or y axis/],
  ['an errorbar with both errors', unit({ mark: 'errorbar', encoding: { x: xq, y: yq, xError: { field: 'x' }, yError: { field: 'y' } } }), /both xError and yError/],
  ['an unknown mark property', unit({ mark: { type: 'point', sparkle: true } }), /unknown mark property "sparkle"/],
  ['config nested in a child spec', { data: DATA, hconcat: [unit({ config: {} })] }, /config is only allowed at the top level/],
  ['an unsupported config key', unit({ config: { fontSize: { xs: 3 } } }), /config\.fontSize/],
  ['an unknown projection type', unit({ mark: 'geoshape', projection: { type: 'robinson' } }), /unknown projection type/],
  ['an unknown projection property', unit({ mark: 'geoshape', projection: { zoom: 3 } }), /unknown projection property "zoom"/],
  ['a projection property of the wrong kind', unit({ mark: 'geoshape', projection: { scale: 'big' } }), /projection\.scale/],
  ['a projection in a config of the wrong kind', unit({ config: { projection: { translate: [1] } } }), /config\.projection\.translate/],
  ['customFormatTypes that is not a boolean', unit({ config: { customFormatTypes: 'yes' } }), /customFormatTypes/],
  ['a format type that is not a function name', unit({ config: { customFormatTypes: true, numberFormatType: 7 } }), /numberFormatType/],
  ['container sizing of a composition', { data: DATA, width: 'container', hconcat: [unit(), unit()] }, /container/],
  ['a longitude without its latitude', unit({ mark: 'point', encoding: { longitude: xq } }), /needs its pair/],
  ['a longitude on a bar', unit({ mark: 'bar', encoding: { longitude: xq, latitude: yq } }), /only implemented for the/],
  ['a latitude that counts records (no field to project)', unit({ mark: 'point', encoding: { longitude: xq, latitude: { aggregate: 'count', type: 'quantitative' } } }), /a count of records reads no field/],
  ['a non-numeric latitude datum', unit({ mark: 'point', encoding: { longitude: { datum: 1 }, latitude: { datum: 'north' } } }), /finite number/],
  ['a geojson shape on a point', unit({ mark: 'point', encoding: { shape: { field: 'g', type: 'geojson' } } }), /geoshape/],
  ['a geojson type outside the shape channel', unit({ mark: 'geoshape', encoding: { color: { field: 'g', type: 'geojson' } } }), /shape channel/],
  ['a faceted map', unit({ mark: 'geoshape', encoding: { column: cn } }), /inside a facet/],
  ['a topojson format without an object', { data: { values: [], format: { type: 'topojson' } }, mark: 'geoshape' }, /feature.*mesh/],
  ['a feature on a json format', { data: { values: [], format: { type: 'json', feature: 'x' } }, mark: 'geoshape' }, /only applies to the "topojson" format/],
  ['a graticule with unknown parameters', { data: { graticule: { spin: 1 } }, mark: 'geoshape' }, /unknown graticule property/],
  ['a sequence without a stop', { data: { sequence: { start: 0 } }, mark: 'point' }, /data\.sequence\.stop/],
  ['a sequence with another source', { data: { sequence: { start: 0, stop: 3 }, values: [] }, mark: 'point' }, /cannot be combined/],
  ['an unknown invalid mode', unit({ mark: { type: 'point', invalid: 'drop' } }), /unknown invalid-value mode/],
  ['a bad scale invalid value', unit({ config: { scale: { invalid: { x: 'nope' } } } }), /zero-or-min/],
  ['the time channel', unit({ encoding: { x: xq, y: yq, time: { field: 'x', type: 'quantitative' } } }), /the time channel needs a timer selection and its frame filter/],
  // --- composition nesting
  ['a facet inside a layer', { data: DATA, layer: [{ facet: { field: 'c', type: 'nominal' }, spec: unit() }] }, /not allowed inside `layer`/],
  ['an empty layer', { data: DATA, layer: [] }, /non-empty array/],
  ['facet without spec', { data: DATA, facet: { field: 'c', type: 'nominal' } }, /nested `spec`/],
  ['a repeat reference outside a repeat', unit({ encoding: { x: { field: { repeat: 'row' }, type: 'quantitative' } } }), /outside a matching `repeat`/],
  // --- channels
  ['an unknown channel', unit({ encoding: { x: xq, banana: yq } }), /unknown encoding channel "banana"/],
  ['an array on a single-def channel', unit({ encoding: { x: [xq] } }), /does not accept an array/],
  ['a channel def without field/value/datum', unit({ encoding: { x: { type: 'quantitative' } } }), /needs `field`/],
  ['an unknown type', unit({ encoding: { x: { field: 'x', type: 'integer' } } }), /unknown type/],
  ['a malformed field path', unit({ encoding: { x: { field: "v'] + 1 + datum['v", type: 'quantitative' } } }), /access path|invalid field/],
  ['an unknown aggregate', unit({ encoding: { x: { field: 'x', type: 'quantitative', aggregate: 'summ' } } }), /unknown aggregate/],
  ['an unknown scale property', unit({ encoding: { x: { ...xq, scale: { zeroish: true } } } }), /unknown scale property/],
  ['domainRaw', unit({ encoding: { x: { ...xq, scale: { domainRaw: [0, 1] } } } }), /domainRaw/],
  ['a scale domain over an undeclared param', unit({ encoding: { x: { ...xq, scale: { domain: { param: 'p' } } } } }), /parameter "p" is not declared/],
  // --- transforms
  ['an unknown transform', unit({ transform: [{ frobnicate: 'x' }] }), /unknown transform/],
  ['a vega-style transform', unit({ transform: [{ type: 'formula', expr: '1', as: 'z' }] }), /Vega-style transforms/],
  ['two transforms in one object', unit({ transform: [{ filter: 'true', calculate: '1', as: 'z' }] }), /ambiguous transform|unknown filter transform property/],
  ['a calculate without `as`', unit({ transform: [{ calculate: '1' }] }), /calculate needs `as`/],
  ['an aggregate with an unknown op', unit({ transform: [{ aggregate: [{ op: 'sumsum', field: 'x' }], groupby: ['c'] }] }), /unknown aggregate op/],
  ['an aggregate op without a field', unit({ transform: [{ aggregate: [{ op: 'sum' }], groupby: ['c'] }] }), /needs a field/],
  ['an argmax window op', unit({ transform: [{ window: [{ op: 'argmax', field: 'x' }], groupby: ['c'] }] }), /argmax/],
  ['a window with a bad op', unit({ transform: [{ window: [{ op: 'sparkle' }] }] }), /unknown window op/],
  ['a filter predicate with two operators', unit({ transform: [{ filter: { field: 'x', gt: 1, lt: 3 } }] }), /exactly one of/],
  ['a selection predicate over an undeclared param', unit({ transform: [{ filter: { param: 'brush' } }] }), /parameter "brush" is not declared/],
  ['an unknown impute method', unit({ transform: [{ impute: 'y', key: 'x', method: 'mode' }] }), /unknown impute method/],
  ['a lookup from an undeclared param', unit({ transform: [{ lookup: 'c', from: { param: 'p', key: 'k' } }] }), /parameter "p" is not declared/],
  // --- params / selections
  ['a legacy selection type', unit({ params: [{ name: 'pick', select: 'single' }] }), /selection type "single"/],
  ['a point option on an interval selection', unit({ params: [{ name: 'brush', select: { type: 'interval', nearest: true } }] }), /unknown interval selection property "nearest"/],
  ['an interval selection bound to inputs', unit({ params: [{ name: 'brush', select: 'interval', bind: { input: 'range' } }] }), /can only be bound to "scales"/],
  ['a selection on a layer itself', { data: DATA, params: [{ name: 'b', select: 'interval' }], layer: [unit({})] }, /a selection parameter on a layer spec itself.*which Vega rejects/],
  ['a selection on a concat with a layer of two units below it', { data: DATA, params: [{ name: 'b', select: 'interval' }], hconcat: [{ layer: [unit({}), unit({})] }, unit({})] }, /given to every unit below it.*a layer below would declare the selection's signals twice/],
  ['a selection on a facet over a layer of two units', { data: DATA, params: [{ name: 'b', select: 'interval' }], facet: { field: 'c', type: 'nominal' }, spec: { layer: [unit({}), unit({})] } }, /a layer below would declare/],
  ['a selection on a repeat over a boxplot', { data: DATA, params: [{ name: 'b', select: 'interval' }], repeat: ['x', 'y'], spec: unit({ mark: 'boxplot' }) }, /boxplot is a layer once vega-lite has normalized it/],
  ['a selection on a concat over a unit with params of its own', { data: DATA, params: [{ name: 'b', select: 'interval' }], hconcat: [unit({ params: [{ name: 'c', value: 1 }] }), unit({})] }, /replaces the parameters of a unit that has some of its own/],
  ['a selection restricted to views', { data: DATA, params: [{ name: 'b', select: 'interval', views: ['a'] }], hconcat: [unit({}), unit({})] }, /`views`.*not supported/],
  ['a timer event stream that is not a selection\'s own `on` (clear)', unit({ params: [{ name: 'b', select: { type: 'point', on: 'click', clear: 'timer' } }] }), /timer event streams/],
  ['a timer event stream in the selection config', unit({ config: { selection: { point: { on: 'timer' } } } }), /timer event streams/],
  ['a parameter with an empty name', unit({ params: [{ name: '', value: 1 }] }), /params\[0\]\.name: must be a non-empty string/],
  ['duplicate parameter names', unit({ params: [{ name: 'p', value: 1 }, { name: 'p', value: 2 }] }), /duplicate parameter/],
  ['a parameter with neither value nor expr', unit({ params: [{ name: 'p' }] }), /needs `value`, `expr` or `bind`/],
  ['an unknown bind input', unit({ params: [{ name: 'p', value: 1, bind: { input: 'dial' } }] }), /input type/],
  // --- conditions
  ['a param condition', unit({ encoding: { x: xq, y: yq, color: { condition: { param: 'brush', value: 'red' }, value: 'grey' } } }), /encoding\.color\.condition\.param: parameter "brush" is not declared in `params`/],
  ['a condition without a test', unit({ encoding: { x: xq, y: yq, color: { condition: { value: 'red' }, value: 'grey' } } }), /needs `test`/],
  ['an empty condition array', unit({ encoding: { x: xq, y: yq, color: { condition: [], value: 'grey' } } }), /must not be empty/],
  ['a field condition in an array', unit({ encoding: { x: xq, y: yq, color: { condition: [{ test: 'true', field: 'c', type: 'nominal' }], value: 'g' } } }), /value conditions/],
  ['a condition with both value and field', unit({ encoding: { x: xq, y: yq, color: { condition: { test: 'true', value: 'r', field: 'c', type: 'nominal' }, value: 'g' } } }), /exactly one of/],
  // --- sort
  ['an unknown sort string', unit({ encoding: { x: { ...cn, sort: 'sideways' } } }), /unknown sort/],
  ['an empty sort array', unit({ encoding: { x: { ...cn, sort: [] } } }), /at least one value/],
  ['a sort object with an unknown key', unit({ encoding: { x: { ...cn, sort: { field: 'y', direction: 'up' } } } }), /unknown sort property/],
  ['a sort op without a field', unit({ encoding: { x: { ...cn, sort: { op: 'mean' } } } }), /needs a `field`/],
  ['a sort with a bad order', unit({ encoding: { x: { ...cn, sort: { field: 'y', order: 'up' } } } }), /unknown order/],
  ['a sort by an unknown encoding', unit({ encoding: { x: { ...cn, sort: { encoding: 'tooltip' } } } }), /unknown sort channel/],
  // --- timeUnit
  ['an unknown time unit', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: 'fortnight' } } }), /unknown timeUnit/],
  ['a binned time unit with maxbins', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { unit: 'year', maxbins: 4 } } } }), /maxbins/],
  ['time-unit maxbins', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { maxbins: 6 } } } }), /maxbins/],
  ['a time-unit step of zero', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { unit: 'month', step: 0 } } } }), /step/],
  // --- bin
  ['pre-binned data off the positions', unit({ encoding: { x: xq, color: { field: 'x', type: 'quantitative', bin: 'binned' } } }), /property of an x or y channel/],
  ['binned: true off the positions', unit({ encoding: { x: xq, size: { field: 'x', type: 'quantitative', bin: { binned: true } } } }), /property of an x or y channel/],
  ['binned: true in a bin transform', unit({ transform: [{ bin: { binned: true }, field: 'x', as: 'b' }] }), /property of an x or y channel/],
  ['pre-binned data with a bin parameter', unit({ encoding: { x: { ...xq, bin: { binned: true, maxbins: 5 } }, x2: { field: 'y' } } }), /maxbins/],
  ['an unknown bin option', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { buckets: 4 } } } }), /unknown bin property/],
  ['a negative maxbins', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { maxbins: -1 } } } }), /positive number/],
  ['a bad extent', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { extent: [5, 1] } } } }), /min must be less/],
  // --- resolve
  ['an unknown resolve channel', { data: DATA, resolve: { scale: { banana: 'shared' } }, hconcat: [unit()] }, /unknown scale channel "banana"/],
  ['a bad resolve value', { data: DATA, resolve: { scale: { color: 'both' } }, hconcat: [unit()] }, /"shared" or "independent"/],
  ['resolve on a unit', unit({ resolve: { scale: { y: 'independent' } } }), /no meaning on a single unit/],
  ['an independent colour scale in a facet that holds another facet', { data: DATA, facet: { row: cn }, spec: { facet: { column: cn }, spec: unit({ encoding: { x: xq, color: cn } }) }, resolve: { scale: { color: 'independent' } } }, /independent scales or legends in a facet that holds another facet/],
  ['an independent x scale in a wrapped facet', { data: DATA, facet: cn, spec: unit({ encoding: { x: cn, y: yq } }), resolve: { scale: { x: 'independent' } } }, /wrapped facet/],
]

describe('validation layer: unsupported / invalid input throws a VLCompileError naming the feature', () => {
  for (const [name, spec, message] of REJECTED) {
    it(`rejects ${name}`, () => {
      expect(() => compile(spec as never)).toThrowError(VLCompileError)
      expect(() => compile(spec as never)).toThrowError(message)
    })
  }

  it('prefixes every message with [aster/vl] and names the path of the offending property', () => {
    expect(() => compile(unit({ encoding: { x: { ...cn, sort: 'sideways' } } }) as never)).toThrowError(/^\[aster\/vl\] encoding\.x\.sort:/)
  })

  it('rejects non-object input', () => {
    expect(() => compile(null as never)).toThrowError(VLCompileError)
    expect(() => compile([] as never)).toThrowError(VLCompileError)
    expect(() => compile('mark' as never)).toThrowError(VLCompileError)
  })
})

/** The matching accepted forms, so the table above is not simply rejecting everything. */
const ACCEPTED: Array<[string, unknown]> = [
  ['an x channel on a geoshape (vega-lite drops the channels a geoshape does not draw)', unit({ mark: 'geoshape', encoding: { x: xq } })],
  ['fill together with color (vega-lite drops the color of a filled mark)', unit({ mark: 'bar', encoding: { x: cn, color: cn, fill: cn } })],
  ['a datum condition on fill', unit({ encoding: { x: xq, y: yq, fill: { condition: { test: 'true', datum: 'a' }, value: 'g' } } })],
  ['sort by channel', unit({ encoding: { x: { ...cn, sort: '-y' }, y: { ...yq, aggregate: 'sum' } }, mark: 'bar' })],
  ['sort arrays', unit({ encoding: { x: { ...cn, sort: ['B', 'A'] }, y: { ...yq, aggregate: 'sum' } }, mark: 'bar' })],
  ['sort field+op', unit({ encoding: { x: { ...cn, sort: { field: 'v', op: 'max' } }, y: { ...yq, aggregate: 'sum' } }, mark: 'bar' })],
  ['sort count', unit({ encoding: { x: { ...cn, sort: { op: 'count' } }, y: { ...yq, aggregate: 'sum' } }, mark: 'bar' })],
  ['sort null', unit({ encoding: { x: { ...cn, sort: null }, y: { ...yq, aggregate: 'sum' } }, mark: 'bar' })],
  ['timeUnit utc / object / step', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { unit: 'month', utc: true, step: 2 } }, y: yq } })],
  ['bin options', unit({ mark: 'bar', encoding: { x: { field: 'v', type: 'quantitative', bin: { step: 2, extent: [0, 10], nice: false } }, y: { aggregate: 'count', type: 'quantitative' } } })],
  ['test conditions', unit({ encoding: { x: xq, y: yq, color: { condition: [{ test: { field: 'y', gt: 2 }, value: 'red' }], value: 'grey' } } })],
  ['variable params', unit({ params: [{ name: 'p', value: 1, bind: { input: 'range', min: 0, max: 3 } }, { name: 'q', expr: 'p * 2' }] })],
  ['a plain interval selection', unit({ params: [{ name: 'brush', select: { type: 'interval' } }] })],
  ['nested layer in concat', { data: DATA, hconcat: [{ layer: [unit(), unit()] }, unit()] }],
  ['wrapped facet', { data: DATA, facet: { field: 'c', type: 'nominal' }, columns: 2, spec: unit() }],
  ['layer repeat', { data: DATA, repeat: { layer: ['x', 'y'] }, spec: { mark: 'line', encoding: { x: cn, y: { field: { repeat: 'layer' }, type: 'quantitative' } } } }],
  ['resolve y independent in a layer', { data: DATA, resolve: { scale: { y: 'independent' } }, layer: [unit(), unit()] }],
  ['boxplot, string form', { data: DATA, mark: 'boxplot', encoding: { x: cn, y: { field: 'v', type: 'quantitative' } } }],
  // forms that were refused and compile now (each has its parity case against vega-lite in conformance/test/vl-compiler-parity.test.ts)
  ['a data-driven angle', unit({ mark: 'text', encoding: { x: xq, angle: yq } })],
  ['a DateTime datum', unit({ encoding: { x: { datum: { year: 2020 }, type: 'temporal' } } })],
  ['a constant position on a bar', unit({ mark: 'bar', encoding: { x: cn, y: { value: 10 } } })],
  ['a binned time unit on an ordinal field', unit({ encoding: { x: { field: 't', type: 'ordinal', timeUnit: 'binnedyear' } } })],
  ['a parameter-driven bin extent', { data: DATA, params: [{ name: 'p', value: [0, 5] }], mark: 'bar', encoding: { x: { field: 'x', type: 'quantitative', bin: { extent: { param: 'p' } } }, y: { aggregate: 'count', type: 'quantitative' } } }],
  ['a signal domain and a domainRaw', unit({ params: [{ name: 'd', value: [0, 5] }], encoding: { x: { ...xq, scale: { domain: { signal: 'd' }, domainRaw: { signal: 'd' } } }, y: yq } })],
  ['an independent axis in a faceted unit', unit({ encoding: { x: xq, y: yq, column: cn }, resolve: { axis: { x: 'independent' } } })],
  ['a wrapped faceted unit nested in a concat', { data: DATA, hconcat: [unit(), unit({ encoding: { x: xq, y: yq, facet: { ...cn, columns: 2 } } })] }],
  ['a wrapped facet operator nested in a concat', { data: DATA, vconcat: [unit(), { facet: cn, spec: unit() }] }],
  ['a facet inside a facet', { data: DATA, facet: { column: cn }, spec: { facet: { row: { field: 'g', type: 'nominal' } }, spec: unit() } }],
  ['a datum on a size (it was refused as "a datum on an unsupported channel")', unit({ encoding: { x: xq, y: yq, size: { datum: 4 } } })],
  ['scale: null on x (it was refused)', unit({ encoding: { x: { ...xq, scale: null } } })],
  ['a longitude / latitude value pair (it was refused: vega-lite reads no position from constants, and neither does this)', unit({ mark: 'point', encoding: { longitude: { value: 1 }, latitude: { value: 2 } } })],
  ['an aggregated latitude (it was refused: vega-lite aggregates it, grouped by the projected longitude)', unit({ mark: 'point', encoding: { longitude: xq, latitude: { ...yq, aggregate: 'mean' } } })],
  ['a key channel (it was refused as "a valid but unimplemented channel")', unit({ encoding: { x: xq, key: yq } })],
  ['a selection declared in two views', { data: DATA, hconcat: [unit({ params: [{ name: 'brush', select: 'interval' }] }), unit({ params: [{ name: 'brush', select: 'interval' }] })] }],
]

describe('validation layer: the supported forms still compile', () => {
  for (const [name, spec] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      const out = compileFrozen(spec)
      expect(out).toBeTypeOf('object')
    })
  }
})

describe('validation messages name the path and the nearest valid value (C637, C441, C633)', () => {
  const MESSAGES: Array<[string, unknown, RegExp]> = [
    ['a misspelt type', unit({ encoding: { x: { field: 'x', type: 'quantitive' } } }), /encoding\.x\.type: unknown type "quantitive" \(did you mean "quantitative"\?\)/],
    ['a misspelt channel', unit({ encoding: { x: xq, colour: cn } }), /encoding\.colour: unknown encoding channel "colour" \(did you mean "color"\?\)/],
    ['a misspelt mark', unit({ mark: 'bra' }), /mark: unknown mark type "bra" \(did you mean "bar"\?\)/],
    ['a misspelt mark property', unit({ mark: { type: 'bar', opactiy: 0.5 } }), /unknown mark property "opactiy" \(did you mean "opacity"\?\)/],
    ['a misspelt aggregate', unit({ encoding: { x: { ...xq, aggregate: 'avg' } } }), /unknown aggregate "avg"/],
    ['a misspelt config property', unit({ config: { axsi: {} } }), /config\.axsi: unknown config property "axsi" \(did you mean "axis"\?\)/],
    ['a config property vega-lite has that is not implemented', unit({ config: { axisQuantitative: {} } }), /config\.axisQuantitative: this config property is valid Vega-Lite but is not supported/],
    ['empty data', { data: {}, mark: 'point' }, /data: needs one of `values`, `url`, `name`, or a generator \(`sequence`, `sphere`, `graticule`\)/],
    ['a binding to an element with no input', unit({ params: [{ name: 'p', value: 1, bind: { element: '#x' } }] }), /params\[0\]\.bind: a binding needs `input`/],
    ['a DateTime year that is not a number', unit({ transform: [{ filter: { field: 't', equal: { year: 'foo' } } }] }), /transform\[0\]\.filter\.equal\.year: a DateTime year must be a number, got "foo"/],
    ['a DateTime month that is not a month', unit({ transform: [{ filter: { field: 't', range: [{ month: 'smarch' }, null] } }] }), /transform\[0\]\.filter\.range\[0\]\.month: a DateTime month must be a number or the name of a month/],
    ['an object predicate value', unit({ transform: [{ filter: { field: 'x', equal: { a: 1 } } }] }), /transform\[0\]\.filter\.equal: must be a number, a string, a boolean, null, a DateTime or an \{"expr"\} reference/],
    ['a DateTime selection value', unit({ params: [{ name: 's', select: { type: 'point', fields: ['t'] }, value: [{ t: { year: 'x' } }] }] }), /params\[0\]\.value\[0\]\.t\.year: a DateTime year must be a number/],
    ['a malformed field path in a predicate', unit({ transform: [{ filter: { field: 'a[', equal: 1 } }] }), /transform\[0\]\.filter\.field: invalid field name "a\["/],
    ['a malformed field path in a groupby', unit({ transform: [{ aggregate: [], groupby: ['b', 'a]'] }] }), /transform\[0\]\.groupby\[1\]: invalid field name "a\]"/],
    ['an axis resolution of a colour', { data: DATA, resolve: { axis: { color: 'independent' } }, hconcat: [unit()] }, /resolve\.axis\.color: unknown axis channel "color"/],
    ['a legend resolution of x', { data: DATA, resolve: { legend: { x: 'independent' } }, hconcat: [unit()] }, /resolve\.legend\.x: unknown legend channel "x"/],
    ['an infinite width', unit({ width: Infinity }), /width must be a non-negative number or \{"step": n\}, got Infinity/],
    ['a NaN height', unit({ height: NaN }), /got NaN/],
  ]
  for (const [name, spec, re] of MESSAGES) {
    it(name, () => {
      expect(() => compile(spec as never)).toThrow(VLCompileError)
      expect(() => compile(spec as never)).toThrow(re)
    })
  }
})

describe('a spec deeper than the compiler walks, or one that contains itself, is a VLCompileError (C493)', () => {
  const nest = (n: number, wrap: (s: unknown) => Record<string, unknown>): Record<string, unknown> => {
    let s: Record<string, unknown> = unit()
    for (let i = 0; i < n; i++) s = { data: DATA, ...wrap(s) }
    return s
  }
  for (const [kind, wrap] of [
    ['layer', (s: unknown) => ({ layer: [s] })],
    ['hconcat', (s: unknown) => ({ hconcat: [s] })],
    ['repeat', (s: unknown) => ({ repeat: ['x'], spec: s })],
    ['facet', (s: unknown) => ({ facet: { column: cn }, spec: s })],
  ] as const) {
    for (const n of [101, 450, 600, 5000]) {
      it(`${kind} ${n} deep`, () => expect(() => compile(nest(n, wrap) as never)).toThrow(VLCompileError))
    }
    it(`${kind} 100 deep compiles`, () => expect(() => compile(nest(100, wrap) as never)).not.toThrow())
  }
  it('a layer that contains its own spec', () => {
    const spec: Record<string, any> = { data: DATA, layer: [] }
    spec.layer.push(spec)
    expect(() => compile(spec as never)).toThrow(/cannot contain itself/)
  })
  it('a usermeta that contains the spec', () => {
    const spec: Record<string, any> = unit({ usermeta: {} })
    spec.usermeta.me = spec
    expect(() => compile(spec as never)).toThrow(/cannot contain itself/)
  })
  it('a predicate 450 deep compiles (the depth ceiling, not the stack, bounds it)', () => {
    let p: unknown = { field: 'x', equal: 1 }
    for (let i = 0; i < 450; i++) p = { not: p }
    expect(() => compile(unit({ transform: [{ filter: p }] }) as never)).not.toThrow()
  })
})

describe('the config properties vega-lite has are the schema\'s', () => {
  it('VEGA_LITE_CONFIG_KEYS is vega-lite 6.4.3\'s Config', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'conformance', 'node_modules', 'vega-lite', 'build', 'vega-lite-schema.json'), 'utf8'))
    const { VEGA_LITE_CONFIG_KEYS } = await import('../src/validate.js')
    expect([...VEGA_LITE_CONFIG_KEYS].sort()).toEqual(Object.keys(schema.definitions.Config.properties).sort())
  })
})
