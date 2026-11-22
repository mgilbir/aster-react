import { describe, it, expect } from 'vitest'
import { autosizeOf, paddingOf, staticAutosize, viewSignals } from './view-props.js'

describe('viewSignals (vega-parser collectSignals)', () => {
  it('a {signal} property is the update of the view signal; a declaration of the same name is merged over it, first in the list', () => {
    const spec = {
      background: { signal: "'red'" },
      signals: [{ name: 'x', value: 1 }, { name: 'background', value: 'blue' }, { name: 'padding', update: 'x' }],
    }
    expect(viewSignals(spec, { padding: 4, autosize: 'pad' })).toEqual([
      { name: 'background', update: "'red'", value: 'blue' },
      // (a declared view signal starts from the property's static value: a padding object)
      { name: 'padding', value: { top: 4, right: 4, bottom: 4, left: 4 }, update: 'x' },
      { name: 'x', value: 1 },
    ])
  })

  it('the property comes from the config when the spec has none; a view signal neither declared nor a reference is left out', () => {
    expect(viewSignals({ width: 10 }, { width: { signal: '5' }, height: { signal: '6' }, autosize: { signal: "'none'" } })).toEqual([
      { name: 'autosize', update: "'none'" },
      { name: 'height', update: '6' },
    ])
    expect(viewSignals({ width: 10, height: 20, padding: 3 }, { background: 'red' })).toEqual([])
  })

  it('a declared width starts from the property `|| 0`; the config signals the spec does not declare come last', () => {
    expect(viewSignals({ signals: [{ name: 'width', update: '2' }, { name: 'a' }] }, { signals: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }, { name: 'width', value: 9 }] })).toEqual([
      { name: 'width', value: 0, update: '2' },
      { name: 'a' },
      { name: 'b', value: 2 },
    ])
  })
})

describe('paddingOf (vega-view padding.js)', () => {
  it('an object by side, anything else one number for every side, `+v || 0`', () => {
    expect(paddingOf(5)).toEqual({ top: 5, right: 5, bottom: 5, left: 5 })
    expect(paddingOf('7')).toEqual({ top: 7, right: 7, bottom: 7, left: 7 })
    expect(paddingOf(null)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(paddingOf('x')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(paddingOf({ top: '3', left: 2, right: null })).toEqual({ top: 3, right: 0, bottom: 0, left: 2 })
    expect(paddingOf([1, 2])).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})

describe('autosizeOf (vega-view-transforms viewSizeLayout)', () => {
  it('reads an object by type and contains; no type is no layout, an unknown type moves the origin only', () => {
    expect(autosizeOf({ type: 'fit', contains: 'padding' })).toEqual({ type: 'fit', contains: 'padding' })
    expect(autosizeOf('none')).toEqual({ type: 'skip', contains: undefined })
    expect(autosizeOf(null)).toEqual({ type: 'skip', contains: undefined })
    expect(autosizeOf({ contains: 'padding' })).toEqual({ type: 'skip', contains: 'padding' })
    expect(autosizeOf({ type: 'bogus' })).toEqual({ type: 'shift', contains: undefined })
  })
  it('a property that is no signal is made an object first (vega-parser autosize.js)', () => {
    expect(staticAutosize('none')).toEqual({ type: 'none', contains: undefined })
    expect(staticAutosize(undefined)).toEqual({ type: 'pad', contains: undefined })
    expect(staticAutosize('')).toEqual({ type: 'pad', contains: undefined })
    expect(staticAutosize({})).toEqual({ type: 'skip', contains: undefined })
  })
})
