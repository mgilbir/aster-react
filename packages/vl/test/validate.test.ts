// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { DATA, xq, yq, cn, compileFrozen } from './helpers.js'

const unit = (extra: Record<string, unknown> = {}) => ({ data: DATA, mark: 'point', encoding: { x: xq, y: yq }, ...extra })

/** Each entry: a spec the validation layer must reject, and a phrase its message must carry. */
const REJECTED: Array<[string, unknown, RegExp]> = [
  // --- views: missing/ambiguous mark and unknown keys (C97)
  ['a unit without a mark', { data: DATA, encoding: { x: xq } }, /needs exactly one of `mark`/],
  ['mark and layer together', { data: DATA, mark: 'point', layer: [] }, /ambiguous view/],
  ['an unknown top-level key', unit({ colour: 'red' }), /unknown top-level property "colour"/],
  ['an unknown mark', unit({ mark: 'blob' }), /unknown mark type/],
  ['a map mark inside a facet', { data: DATA, facet: { field: 'c', type: 'nominal' }, spec: unit({ mark: 'geoshape', encoding: {} }) }, /inside a facet/],
  ['an errorbar with no continuous axis', unit({ mark: 'errorbar', encoding: { x: cn, y: cn } }), /continuous x or y axis/],
  ['an errorbar with both errors', unit({ mark: 'errorbar', encoding: { x: xq, y: yq, xError: { field: 'x' }, yError: { field: 'y' } } }), /both xError and yError/],
  ['an unknown mark property', unit({ mark: { type: 'point', sparkle: true } }), /unknown mark property "sparkle"/],
  ['an unsupported mark property', unit({ mark: { type: 'bar', timeUnitBandSize: 2 } }), /timeUnitBandSize/],
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
  ['a longitude / latitude value pair', unit({ mark: 'point', encoding: { longitude: { value: 1 }, latitude: { value: 2 } } }), /needs a `field` or `datum`/],
  ['a longitude on a bar', unit({ mark: 'bar', encoding: { longitude: xq, latitude: yq } }), /only implemented for the/],
  ['an aggregated latitude', unit({ mark: 'point', encoding: { longitude: xq, latitude: { ...yq, aggregate: 'mean' } } }), /aggregate.*does not apply/],
  ['a non-numeric latitude datum', unit({ mark: 'point', encoding: { longitude: { datum: 1 }, latitude: { datum: 'north' } } }), /finite number/],
  ['a geojson shape on a point', unit({ mark: 'point', encoding: { shape: { field: 'g', type: 'geojson' } } }), /geoshape/],
  ['a geojson type outside the shape channel', unit({ mark: 'geoshape', encoding: { color: { field: 'g', type: 'geojson' } } }), /shape channel/],
  ['an x channel on a geoshape', unit({ mark: 'geoshape', encoding: { x: xq } }), /positioned by its projection/],
  ['a faceted map', unit({ mark: 'geoshape', encoding: { column: cn } }), /inside a facet/],
  ['a topojson format without an object', { data: { values: [], format: { type: 'topojson' } }, mark: 'geoshape' }, /feature.*mesh/],
  ['a feature on a json format', { data: { values: [], format: { type: 'json', feature: 'x' } }, mark: 'geoshape' }, /only applies to the "topojson" format/],
  ['a graticule with unknown parameters', { data: { graticule: { spin: 1 } }, mark: 'geoshape' }, /unknown graticule property/],
  ['a sequence without a stop', { data: { sequence: { start: 0 } }, mark: 'point' }, /data\.sequence\.stop/],
  ['a sequence with another source', { data: { sequence: { start: 0, stop: 3 }, values: [] }, mark: 'point' }, /cannot be combined/],
  ['an unknown invalid mode', unit({ mark: { type: 'point', invalid: 'drop' } }), /unknown invalid-value mode/],
  ['a bad scale invalid value', unit({ config: { scale: { invalid: { x: 'nope' } } } }), /zero-or-min/],
  ['the time channel', unit({ encoding: { x: xq, y: yq, time: { field: 'x', type: 'quantitative' } } }), /time/],
  // --- composition nesting (C34)
  ['a facet inside a layer', { data: DATA, layer: [{ facet: { field: 'c', type: 'nominal' }, spec: unit() }] }, /not allowed inside `layer`/],
  ['a concat inside a facet', { data: DATA, facet: { field: 'c', type: 'nominal' }, spec: { hconcat: [unit()] } }, /not allowed inside `facet`/],
  ['an empty layer', { data: DATA, layer: [] }, /non-empty array/],
  ['facet without spec', { data: DATA, facet: { field: 'c', type: 'nominal' } }, /nested `spec`/],
  ['a repeat reference outside a repeat', unit({ encoding: { x: { field: { repeat: 'row' }, type: 'quantitative' } } }), /outside a matching `repeat`/],
  // --- channels (C35)
  ['an unknown channel', unit({ encoding: { x: xq, banana: yq } }), /unknown encoding channel "banana"/],
  ['a valid but unimplemented channel', unit({ encoding: { x: xq, key: yq } }), /key.*not supported/],
  ['a data-driven strokeDash', unit({ encoding: { x: xq, strokeDash: cn } }), /strokeDash/],
  ['a data-driven angle', unit({ mark: 'text', encoding: { x: xq, angle: yq } }), /angle/],
  ['fill together with color', unit({ mark: 'bar', encoding: { x: cn, color: cn, fill: cn } }), /together with encoding\.color/],
  ['an array on a single-def channel', unit({ encoding: { x: [xq] } }), /does not accept an array/],
  ['a channel def without field/value/datum', unit({ encoding: { x: { type: 'quantitative' } } }), /needs `field`/],
  ['an unknown type', unit({ encoding: { x: { field: 'x', type: 'integer' } } }), /unknown type/],
  ['a malformed field path', unit({ encoding: { x: { field: "v'] + 1 + datum['v", type: 'quantitative' } } }), /access path|invalid field/],
  ['an unknown aggregate', unit({ encoding: { x: { field: 'x', type: 'quantitative', aggregate: 'summ' } } }), /unknown aggregate/],
  ['a datum on an unsupported channel', unit({ encoding: { x: xq, y: yq, size: { datum: 4 } } }), /size\.datum/],
  ['temporal datums', unit({ encoding: { x: { datum: { year: 2020 }, type: 'temporal' } } }), /datum/],
  ['a constant position on a bar', unit({ mark: 'bar', encoding: { x: cn, y: { value: 10 } } }), /constant value position is not supported/],
  ['scale: null', unit({ encoding: { x: { ...xq, scale: null } } }), /scale: null/],
  ['an unknown scale property', unit({ encoding: { x: { ...xq, scale: { zeroish: true } } } }), /unknown scale property/],
  ['domainRaw', unit({ encoding: { x: { ...xq, scale: { domainRaw: [0, 1] } } } }), /domainRaw/],
  ['a scale domain over an undeclared param', unit({ encoding: { x: { ...xq, scale: { domain: { param: 'p' } } } } }), /parameter "p" is not declared/],
  // --- transforms (C36)
  ['an unknown transform', unit({ transform: [{ frobnicate: 'x' }] }), /unknown transform/],
  ['a vega-style transform', unit({ transform: [{ type: 'formula', expr: '1', as: 'z' }] }), /Vega-style transforms/],
  ['two transforms in one object', unit({ transform: [{ filter: 'true', calculate: '1', as: 'z' }] }), /ambiguous transform|unknown filter transform property/],
  ['a calculate without `as`', unit({ transform: [{ calculate: '1' }] }), /calculate needs `as`/],
  ['a dotted output name', unit({ transform: [{ calculate: '1', as: 'a.b' }] }), /must not contain/],
  ['an aggregate with an unknown op', unit({ transform: [{ aggregate: [{ op: 'sumsum', field: 'x' }], groupby: ['c'] }] }), /unknown aggregate op/],
  ['an aggregate op without a field', unit({ transform: [{ aggregate: [{ op: 'sum' }], groupby: ['c'] }] }), /needs a field/],
  ['an argmax transform op', unit({ transform: [{ aggregate: [{ op: 'argmax', field: 'x' }], groupby: ['c'] }] }), /argmax/],
  ['a window with a bad op', unit({ transform: [{ window: [{ op: 'sparkle' }] }] }), /unknown window op/],
  ['a filter predicate with two operators', unit({ transform: [{ filter: { field: 'x', gt: 1, lt: 3 } }] }), /exactly one of/],
  ['a selection predicate over an undeclared param', unit({ transform: [{ filter: { param: 'brush' } }] }), /parameter "brush" is not declared/],
  ['an unknown impute method', unit({ transform: [{ impute: 'y', key: 'x', method: 'mode' }] }), /unknown impute method/],
  ['a lookup from an undeclared param', unit({ transform: [{ lookup: 'c', from: { param: 'p', key: 'k' } }] }), /parameter "p" is not declared/],
  // --- params / selections (C35)
  ['a legacy selection type', unit({ params: [{ name: 'pick', select: 'single' }] }), /selection type "single"/],
  ['a point option on an interval selection', unit({ params: [{ name: 'brush', select: { type: 'interval', nearest: true } }] }), /unknown interval selection property "nearest"/],
  ['an interval selection bound to inputs', unit({ params: [{ name: 'brush', select: 'interval', bind: { input: 'range' } }] }), /can only be bound to "scales"/],
  ['a selection on a layer itself', { data: DATA, params: [{ name: 'b', select: 'interval' }], layer: [unit({})] }, /a selection parameter on a layer spec itself.*which Vega rejects/],
  ['a selection on a concat with a layer below it', { data: DATA, params: [{ name: 'b', select: 'interval' }], hconcat: [{ layer: [unit({})] }, unit({})] }, /given to every unit below it.*a layer below would declare the selection's signals twice/],
  ['a selection on a facet over a layer', { data: DATA, params: [{ name: 'b', select: 'interval' }], facet: { field: 'c', type: 'nominal' }, spec: { layer: [unit({})] } }, /a layer below would declare/],
  ['a selection on a repeat over a boxplot', { data: DATA, params: [{ name: 'b', select: 'interval' }], repeat: ['x', 'y'], spec: unit({ mark: 'boxplot' }) }, /boxplot is a layer once vega-lite has normalized it/],
  ['a selection on a concat over a unit with params of its own', { data: DATA, params: [{ name: 'b', select: 'interval' }], hconcat: [unit({ params: [{ name: 'c', value: 1 }] }), unit({})] }, /replaces the parameters of a unit that has some of its own/],
  ['a selection restricted to views', { data: DATA, params: [{ name: 'b', select: 'interval', views: ['a'] }], hconcat: [unit({}), unit({})] }, /`views`.*not supported/],
  ['a timer selection without fields or encodings (it would select by row id)', unit({ params: [{ name: 'b', select: { type: 'point', on: 'timer{500}' } }] }), /exactly one of `fields` or `encodings`/],
  ['a timer event stream that is not a selection\'s own `on` (clear)', unit({ params: [{ name: 'b', select: { type: 'point', on: 'click', clear: 'timer' } }] }), /timer event streams/],
  ['a timer event stream in the selection config', unit({ config: { selection: { point: { on: 'timer' } } } }), /timer event streams/],
  ['a parameter with an invalid name', unit({ params: [{ name: 'my param', value: 1 }] }), /identifiers/],
  ['duplicate parameter names', unit({ params: [{ name: 'p', value: 1 }, { name: 'p', value: 2 }] }), /duplicate parameter/],
  ['a parameter with neither value nor expr', unit({ params: [{ name: 'p' }] }), /needs `value` or `expr`/],
  ['an unknown bind input', unit({ params: [{ name: 'p', value: 1, bind: { input: 'dial' } }] }), /input type/],
  // --- conditions (C35)
  ['a param condition', unit({ encoding: { x: xq, y: yq, color: { condition: { param: 'brush', value: 'red' }, value: 'grey' } } }), /param/],
  ['a condition without a test', unit({ encoding: { x: xq, y: yq, color: { condition: { value: 'red' }, value: 'grey' } } }), /needs `test`/],
  ['an empty condition array', unit({ encoding: { x: xq, y: yq, color: { condition: [], value: 'grey' } } }), /must not be empty/],
  ['a field condition in an array', unit({ encoding: { x: xq, y: yq, color: { condition: [{ test: 'true', field: 'c', type: 'nominal' }], value: 'g' } } }), /value conditions/],
  ['a datum condition', unit({ encoding: { x: xq, y: yq, color: { condition: { test: 'true', datum: 'a' }, value: 'g' } } }), /datum/],
  ['a condition with both value and field', unit({ encoding: { x: xq, y: yq, color: { condition: { test: 'true', value: 'r', field: 'c', type: 'nominal' }, value: 'g' } } }), /exactly one of/],
  // --- sort (C35)
  ['an unknown sort string', unit({ encoding: { x: { ...cn, sort: 'sideways' } } }), /unknown sort/],
  ['an empty sort array', unit({ encoding: { x: { ...cn, sort: [] } } }), /at least one value/],
  ['a sort object with an unknown key', unit({ encoding: { x: { ...cn, sort: { field: 'y', direction: 'up' } } } }), /unknown sort property/],
  ['a sort op without a field', unit({ encoding: { x: { ...cn, sort: { op: 'mean' } } } }), /needs a `field`/],
  ['a sort with a bad order', unit({ encoding: { x: { ...cn, sort: { field: 'y', order: 'up' } } } }), /unknown order/],
  ['a sort by an unknown encoding', unit({ encoding: { x: { ...cn, sort: { encoding: 'tooltip' } } } }), /unknown sort channel/],
  // --- timeUnit (C74)
  ['an unknown time unit', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: 'fortnight' } } }), /unknown timeUnit/],
  ['a binned time unit', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: 'binnedyear' } } }), /binned/],
  ['time-unit maxbins', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { maxbins: 6 } } } }), /maxbins/],
  ['a time-unit step of zero', unit({ encoding: { x: { field: 't', type: 'temporal', timeUnit: { unit: 'month', step: 0 } } } }), /step/],
  // --- bin (C74)
  ['pre-binned data', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: 'binned' } } }), /pre-binned/],
  ['binned: true', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { binned: true } } } }), /pre-binned/],
  ['an unknown bin option', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { buckets: 4 } } } }), /unknown bin property/],
  ['a negative maxbins', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { maxbins: -1 } } } }), /positive number/],
  ['a bad extent', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { extent: [5, 1] } } } }), /min must be less/],
  ['a parameter-driven bin extent', unit({ encoding: { x: { field: 'x', type: 'quantitative', bin: { extent: { param: 'p' } } } } }), /pair of numbers/],
  // --- resolve (C72)
  ['an unknown resolve channel', { data: DATA, resolve: { scale: { banana: 'shared' } }, hconcat: [unit()] }, /unknown channel "banana"/],
  ['a bad resolve value', { data: DATA, resolve: { scale: { color: 'both' } }, hconcat: [unit()] }, /"shared" or "independent"/],
  ['resolve on a unit', unit({ resolve: { scale: { y: 'independent' } } }), /no meaning on a single unit/],
  ['a wrapped faceted unit nested in a concat', { data: DATA, hconcat: [unit(), unit({ encoding: { x: xq, y: yq, facet: { ...cn, columns: 2 } } })] }, /wrapped facet.*nested in another composition/],
  ['a wrapped facet operator nested in a concat', { data: DATA, vconcat: [unit(), { facet: cn, spec: unit() }] }, /wrapped facet.*nested in another composition/],
  ['an independent scale in a facet', { data: DATA, facet: { row: cn }, spec: unit(), resolve: { scale: { y: 'independent' } } }, /independent resolution inside a facet/],
  ['an independent axis in a faceted unit', unit({ encoding: { x: xq, y: yq, column: cn }, resolve: { axis: { x: 'independent' } } }), /independent resolution inside a facet/],
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
]

describe('validation layer: the supported forms still compile', () => {
  for (const [name, spec] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      const out = compileFrozen(spec)
      expect(out).toBeTypeOf('object')
    })
  }
})
