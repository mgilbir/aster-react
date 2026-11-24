// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'

const data = { values: [{ c: 'a', v: 1, w: 2 }, { c: 'b', v: 3, w: 4 }, { c: 'a', v: 5, w: 6 }] }
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string) => ({ field, type: 'nominal' })
const pt = (extra: Record<string, unknown>) => ({ data, mark: 'point', encoding: { x: q('v'), y: q('w') }, ...extra })

describe('what @aster-charts/vl refuses with a VLCompileError where it threw a TypeError (C639)', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an interval whose `on` is not a drag', pt({ params: [{ name: 'b', select: { type: 'interval', on: 'pointermove' } }] }), /is made by a drag/],
    ['an interval whose `translate` is not a drag', pt({ params: [{ name: 'b', select: { type: 'interval', translate: 'pointermove' } }] }), /moved by a drag/],
    ['an interval bound to the scales of a map', { data: { values: [{ lon: 1, lat: 2 }] }, mark: 'circle', encoding: { longitude: q('lon'), latitude: q('lat') }, params: [{ name: 'b', select: 'interval', bind: 'scales' }] }, /scales of a map/],
    ['an errorbar with the rule off and no ticks', { data, mark: { type: 'errorbar', rule: false }, encoding: { x: n('c'), y: q('v') } }, /every part of the errorbar is switched off/],
    ['a boxplot with every part off', { data, mark: { type: 'boxplot', box: false, median: false, rule: false, ticks: false, outliers: false }, encoding: { x: n('c'), y: q('v') } }, /every part of the boxplot/],
  ]
  for (const [name, spec, message] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => compile(spec as never)).toThrowError(VLCompileError)
      expect(() => compile(spec as never)).toThrowError(message)
    })
  }
})

describe('what an error mark may be told of its extent and centre (C246)', () => {
  const enc = { x: n('c'), y: q('v') }
  for (const mark of [{ type: 'errorbar', extent: 'bogus' }, { type: 'errorbar', extent: 1.5 }, { type: 'errorband', extent: 'range' }, { type: 'errorbar', center: 'max' }, { type: 'errorband', center: 'bogus' }]) {
    it(`refuses ${JSON.stringify(mark)}`, () => expect(() => compile({ data, mark, encoding: enc } as never)).toThrowError(VLCompileError))
  }
  it('refuses a centre in the config', () => expect(() => compile({ data, config: { errorbar: { center: 'max' } }, mark: 'errorbar', encoding: enc } as never)).toThrowError(/mean" or "median/))
  it('takes the mean and the median', () => {
    for (const center of ['mean', 'median']) expect(() => compile({ data, mark: { type: 'errorbar', center }, encoding: enc } as never)).not.toThrow()
  })
})

describe('a stack with one name for its outputs is refused (C494)', () => {
  it('as: ["s0"]', () => expect(() => compile({ data, transform: [{ stack: 'v', groupby: ['c'], as: ['s0'] }], mark: 'bar', encoding: { x: n('c'), y: q('s0') } } as never)).toThrowError(VLCompileError))
})

describe('an expression that names what nothing declares is refused at compile (ROUTED a06c)', () => {
  const unit = (extra: Record<string, unknown>) => pt(extra)
  it('a filter, a calculate, a condition test, an {expr} value and a title', () => {
    expect(() => compile(unit({ transform: [{ filter: 'datum.v > nope' }] }) as never)).toThrowError(/reads "nope"/)
    expect(() => compile(unit({ transform: [{ calculate: 'datum.v * k2', as: 'z' }] }) as never)).toThrowError(/reads "k2"/)
    expect(() => compile({ ...unit({}), encoding: { x: q('v'), y: q('w'), color: { condition: { test: 'datum.v > nope', value: 'red' }, value: 'blue' } } } as never)).toThrowError(/reads "nope"/)
    expect(() => compile({ ...unit({}), encoding: { x: q('v'), y: q('w'), size: { value: { expr: 'nope' } } } } as never)).toThrowError(/reads "nope"/)
    expect(() => compile(unit({ title: { text: { expr: 'zz' } } }) as never)).toThrowError(/reads "zz"/)
  })
  it('accepts a parameter, a selection, the view size and the datum', () => {
    expect(() => compile(unit({ params: [{ name: 'k', value: 5 }], transform: [{ filter: 'datum.v > k && width > 1 && height > 1' }] }) as never)).not.toThrow()
    expect(() => compile(unit({ params: [{ name: 's', select: 'interval' }], transform: [{ filter: { param: 's' } }] }) as never)).not.toThrow()
  })
})

describe('a composite mark keeps the variable parameters its parts read (C59)', () => {
  for (const mark of ['boxplot', 'errorbar', 'errorband']) {
    it(mark, () => {
      const out = compile({ data, mark, params: [{ name: 'cut', value: 1 }], transform: [{ filter: 'datum.v > cut' }], encoding: { x: n('c'), y: q('v') } } as never) as { signals?: Array<{ name: string }> }
      expect((out.signals ?? []).map((s) => s.name)).toContain('cut')
    })
  }
})
