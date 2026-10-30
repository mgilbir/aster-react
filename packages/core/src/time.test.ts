// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { timeIntervalFor, timeUnitSpecifier, utcFloor, utcIntervalFor } from './time.js'

describe('time units: where Aster differs from vega-time on purpose', () => {
  it('a specifier table that blanks a unit skips that unit instead of looping forever', () => {
    expect(timeUnitSpecifier(['year', 'month'], { 'year-month': null, year: null } as never)).toBe('%b')
    expect(timeUnitSpecifier(['hours'], { hours: undefined } as never)).toBe('')
    expect(timeUnitSpecifier(['year', 'month'])).toBe('%Y-%m')
  })

  it('an inherited name is not a time unit', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(timeIntervalFor(key)).toBeUndefined()
      expect(utcIntervalFor(key)).toBeUndefined()
    }
  })

  it('a UTC floor that lands in the years 0..99 is an Invalid Date, as in vega-time', () => {
    expect(Number.isNaN(+utcFloor(['year'])(Date.UTC(1950, 5, 1)))).toBe(false)
    const ancient = new Date(0)
    ancient.setUTCFullYear(50, 5, 1)
    expect(Number.isNaN(+utcFloor(['year', 'month'])(ancient))).toBe(true)
  })
})
