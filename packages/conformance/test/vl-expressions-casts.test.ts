// @vitest-environment node
/**
 * The expression comparison of the composite suites (vl-expressions.ts) sees the casts of the data: a cast one compiler lacks, two different
 * casts of one field and a cast of another field are differences, in a formula written over the field itself and in a `format.parse` (C220).
 */
import { describe, it, expect } from 'vitest'
import { expressionDiff } from './vl-expressions.js'

const pipeline = (...transform: unknown[]) => ({ data: [{ name: 'source_0' }, { name: 'data_0', source: 'source_0', transform }] })
const cast = (fn: string, field: string) => ({ type: 'formula', expr: `${fn}(datum["${field}"])`, as: field })
const calc = { type: 'formula', expr: 'datum["v"] * 2', as: 'w' }

describe('the expression diff sees casts', () => {
  const same = pipeline(cast('toNumber', 'v'), calc)
  it('says nothing about the same cast', () => expect(expressionDiff(pipeline(cast('toNumber', 'v'), calc), same)).toBe(''))
  it('sees a cast of another kind', () => expect(expressionDiff(pipeline(cast('toDate', 'v'), calc), same)).not.toBe(''))
  it('sees a cast one side lacks', () => {
    expect(expressionDiff(pipeline(calc), same)).not.toBe('')
    expect(expressionDiff(same, pipeline(calc))).not.toBe('')
  })
  it('sees a cast of another field', () => expect(expressionDiff(pipeline(cast('toString', 'w'), calc), same)).not.toBe(''))
  it('reads the format.parse of a data source as the casts it makes', () => {
    const parsed = { data: [{ name: 'source_0', format: { type: 'csv', parse: { v: 'number' } } }, { name: 'data_0', source: 'source_0', transform: [calc] }] }
    expect(expressionDiff(pipeline(cast('toNumber', 'v'), calc), parsed)).toBe('')
    const dated = { data: [{ name: 'source_0', format: { type: 'csv', parse: { v: 'date' } } }, { name: 'data_0', source: 'source_0', transform: [calc] }] }
    expect(expressionDiff(pipeline(cast('toNumber', 'v'), calc), dated)).not.toBe('')
  })
  it('still sees a changed constant', () => expect(expressionDiff(pipeline(cast('toNumber', 'v'), { ...calc, expr: 'datum["v"] * 3' }), same)).not.toBe(''))
  it('compares the cast of a nested field as the cast it is', () => {
    const nested = (fn: string) => ({ type: 'formula', expr: `${fn}(datum["o"] && datum["o"]["v"])`, as: 'o.v' })
    expect(expressionDiff(pipeline(nested('toNumber')), pipeline(nested('toNumber')))).toBe('')
    expect(expressionDiff(pipeline(nested('toDate')), pipeline(nested('toNumber')))).not.toBe('')
  })
})
