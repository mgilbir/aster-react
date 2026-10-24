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
  ['a valid but unimplemented mark', unit({ mark: 'geoshape' }), /not supported by @aster\/vl yet/],
  ['an errorbar with no continuous axis', unit({ mark: 'errorbar', encoding: { x: cn, y: cn } }), /continuous x or y axis/],
  ['an errorbar with both errors', unit({ mark: 'errorbar', encoding: { x: xq, y: yq, xError: { field: 'x' }, yError: { field: 'y' } } }), /both xError and yError/],
  ['an unknown mark property', unit({ mark: { type: 'point', sparkle: true } }), /unknown mark property "sparkle"/],
  ['an unsupported mark property', unit({ mark: { type: 'bar', timeUnitBandSize: 2 } }), /timeUnitBandSize/],
  ['config nested in a child spec', { data: DATA, hconcat: [unit({ config: {} })] }, /config is only allowed at the top level/],
  ['an unsupported config key', unit({ config: { projection: { type: 'mercator' } } }), /config\.projection/],
  ['customFormatTypes that is not a boolean', unit({ config: { customFormatTypes: 'yes' } }), /customFormatTypes/],
  ['a format type that is not a function name', unit({ config: { customFormatTypes: true, numberFormatType: 7 } }), /numberFormatType/],
  ['container sizing of a composition', { data: DATA, width: 'container', hconcat: [unit(), unit()] }, /container/],
  ['projections', unit({ projection: { type: 'mercator' } }), /projection/],
  ['data generators', { data: { sequence: { start: 0, stop: 3 } }, mark: 'point' }, /generators/],
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
  ['a valid but unimplemented channel', unit({ encoding: { x: xq, latitude: yq } }), /latitude.*not supported/],
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
  ['a parameter-driven scale domain', unit({ encoding: { x: { ...xq, scale: { domain: { param: 'p' } } } } }), /domain objects/],
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
  ['a selection predicate', unit({ transform: [{ filter: { param: 'brush' } }] }), /selection\/param predicates/],
  ['an unknown impute method', unit({ transform: [{ impute: 'y', key: 'x', method: 'mode' }] }), /unknown impute method/],
  ['a lookup from a selection', unit({ transform: [{ lookup: 'c', from: { param: 'p', key: 'k' } }] }), /selection|from\.data/],
  // --- params / selections (C35)
  ['a point selection', unit({ params: [{ name: 'pick', select: 'point' }] }), /selection type "point"/],
  ['interval selection options', unit({ params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }] }), /interval selection options/],
  ['a selection with a binding', unit({ params: [{ name: 'brush', select: 'interval', bind: 'scales' }] }), /bindings/],
  ['an interval selection in a layer', { data: DATA, layer: [unit({ params: [{ name: 'b', select: 'interval' }] })] }, /not allowed|params/],
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
