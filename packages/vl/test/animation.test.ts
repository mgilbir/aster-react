// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { compileFrozen } from './helpers.js'

const ROWS = [
  { year: 1990, c: 'a', x: 1, y: 2 },
  { year: 1991, c: 'a', x: 2, y: 3 },
  { year: 1990, c: 'b', x: 3, y: 1 },
]
const timer = (extra: Record<string, unknown> = {}, name = 'anim') => ({ name, select: { type: 'point', on: 'timer', fields: ['year'], ...extra } })
const anim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  data: { values: ROWS },
  params: [timer()],
  transform: [{ filter: { param: 'anim' } }],
  mark: 'point',
  encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } },
  ...over,
})

describe('animation: a time channel with a timer selection', () => {
  const vg = compileFrozen(anim())
  const dataOf = (name: string): any => vg.data.find((d: any) => d.name === name)

  it('the selection is a store dataset the animation signals write to', () => {
    expect(vg.data[0]).toEqual({ name: 'anim_store' })
    const sig = (n: string): any => vg.signals.find((s: any) => s.name === n)
    expect(sig('anim_clock').on[0].events).toEqual({ type: 'timer', throttle: (1 / 60) * 1000 })
    expect(sig('anim_value').update).toBe("invert('time', eased_anim_clock)")
    expect(sig('anim_tuple_fields').value).toEqual([{ type: 'E', field: 'year' }])
    expect(sig('anim_modify').on[0].update).toBe('modify("anim_store", anim_tuple, true)')
    expect(sig('anim').update).toBe('vlSelectionResolve("anim_store", "union", true, true)')
    expect(sig('anim_tuple').on[0].update).toBe('{unit: "", fields: anim_tuple_fields, values: [anim_value ? anim_value : min_extent]}')
  })

  it('the frame filter leaves the main dataset for the dataset the marks read; scales keep the whole data', () => {
    const main = dataOf('data_0')
    expect(JSON.stringify(main.transform)).not.toContain('vlSelectionTest')
    expect(dataOf('data_0_curr')).toEqual({
      name: 'data_0_curr', source: 'data_0',
      transform: [{ type: 'filter', expr: '!length(data("anim_store")) || vlSelectionTest("anim_store", datum)' }],
    })
    expect(vg.marks[0].from).toEqual({ data: 'data_0_curr' })
    expect(vg.marks[0].interactive).toBe(true)
    expect(vg.marks[0].encode.update.cursor).toEqual({ value: 'pointer' })
    expect(vg.scales.find((s: any) => s.name === 'x').domain.data).toBe('data_0')
  })

  it('the time scale is a band scale, one step per frame (2 fps by default)', () => {
    expect(vg.scales.find((s: any) => s.name === 'time')).toEqual({ name: 'time', type: 'band', domain: { data: 'data_0', field: 'year', sort: true }, range: { step: 500 } })
    expect(compileFrozen(anim({ config: { scale: { framesPerSecond: 8, animationDuration: 9 } } })).scales.find((s: any) => s.name === 'time').range).toEqual({ step: 125 })
    expect(vg.axes.map((a: any) => a.scale)).not.toContain('time')
    expect(vg.legends).toBeUndefined()
  })

  it('empty: false is a predicate that selects nothing until the store has a tuple', () => {
    const v = compileFrozen(anim({ transform: [{ filter: { param: 'anim', empty: false } }] }))
    expect(v.data.find((d: any) => d.name === 'data_0_curr').transform[0].expr).toBe('length(data("anim_store")) && vlSelectionTest("anim_store", datum)')
  })

  it('an unfiltered mark source is a pass-through main dataset; encodings projects the time field', () => {
    const v = compileFrozen({
      data: { name: 'tbl', values: ROWS }, params: [{ name: 'anim', select: { type: 'point', on: 'timer', encodings: ['time'] } }],
      transform: [{ filter: { param: 'anim' } }], mark: 'text', encoding: { text: { field: 'c', type: 'nominal' }, time: { field: 'year', type: 'ordinal' } },
    })
    expect(v.data.map((d: any) => d.name)).toEqual(['anim_store', 'tbl', 'data_0', 'data_0_curr'])
    expect(v.data[2]).toEqual({ name: 'data_0', source: 'tbl', transform: [] })
    expect(v.signals.find((s: any) => s.name === 'anim_tuple_fields').value).toEqual([{ field: 'year', channel: 'time', type: 'E' }])
  })

  it('the timer selection is not drawn as a brush', () => {
    expect(JSON.stringify(vg.marks)).not.toContain('brush')
  })
})

describe('animation: refusals (vega-lite 6.4.3 emits marks that read a dataset it never defines for these)', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a time channel without a timer selection', anim({ params: undefined, transform: undefined }), /exactly one timer selection/],
    ['a timer selection without the filter', anim({ transform: [] }), /needs the transform/],
    ['a timer selection without a time channel', anim({ encoding: { x: { field: 'x', type: 'quantitative' } } }), /animates the `time` channel/],
    ['a selection by row id (no fields, no encodings)', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'timer' } }] }), /exactly one of `fields` or `encodings`/],
    ['fields and encodings together', anim({ params: [timer({ encodings: ['time'] })] }), /exactly one of/],
    ['encodings other than time', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'timer', encodings: ['x'] } }] }), /\["time"\]/],
    ['a time unit projected through encodings', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'timer', encodings: ['time'] } }], encoding: { x: { field: 'x', type: 'quantitative' }, time: { field: 'year', type: 'temporal', timeUnit: 'year' } } }), /time unit/],
    ['a second timer selection', anim({ params: [timer(), timer({}, 'other')] }), /only one timer selection/],
    ['an unknown selection option', anim({ params: [timer({ toggle: true })] }), /select\.toggle/],
    ['a bound timer', anim({ params: [{ ...timer(), bind: { input: 'checkbox' } }] }), /bind/],
    ['a reserved signal name', anim({ params: [timer({}, 'anim_clock')], transform: [{ filter: { param: 'anim_clock' } }] }), /signal an animation defines/],
    ['a non-timer point selection', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'click', fields: ['year'] } }] }), /exactly one timer selection/],
    ['a param predicate on a non-timer parameter', anim({ transform: [{ filter: { param: 'nope' } }, { filter: { param: 'anim' } }] }), /is not declared in `params`/],
    ['a time channel with a sort', anim({ encoding: { x: { field: 'x', type: 'quantitative' }, time: { field: 'year', type: 'ordinal', sort: 'descending' } } }), /time\.sort/],
    ['a time channel with an aggregate', anim({ encoding: { x: { field: 'x', type: 'quantitative' }, time: { field: 'year', type: 'ordinal', aggregate: 'max' } } }), /time\.aggregate/],
    ['an animated layer', { data: { values: ROWS }, layer: [anim()] }, /(not supported|only supported|single top-level unit)/],
    ['an animated concat child', { hconcat: [anim()] }, /(single top-level unit|selection\/param predicates)/],
    ['an animated boxplot', anim({ mark: 'boxplot', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } } }), /composite mark/],
    ['an animated line with a point overlay', anim({ mark: { type: 'line', point: true } }), /overlay/],
    ['an animated faceted unit', anim({ encoding: { x: { field: 'x', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' }, column: { field: 'c', type: 'nominal' } } }), /faceted/],
  ]
  for (const [name, spec, message] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => compile(spec as never)).toThrowError(VLCompileError)
      expect(() => compile(spec as never)).toThrowError(message)
    })
  }

  it('a frame filter that lands before an aggregate with a raw-table sort is refused, not mis-compiled', () => {
    const spec = anim({
      transform: [{ filter: { param: 'anim' } }],
      encoding: { x: { field: 'c', type: 'nominal', sort: { field: 'y', op: 'sum' } }, y: { field: 'y', type: 'quantitative', aggregate: 'sum' }, time: { field: 'year', type: 'ordinal' } },
      mark: 'bar',
    })
    expect(() => compile(spec as never)).toThrowError(/pre-aggregation table/)
  })
})
