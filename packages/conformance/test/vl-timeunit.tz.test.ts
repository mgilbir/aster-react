// @vitest-environment node
/**
 * Every time unit, in every place a spec can put one, against vega-lite 6.4.3: the rows the compiled spec makes (so the time unit is
 * computed the same, in this zone and in the others `pnpm test:tz` runs it under), the names of the fields it makes, and the
 * time-unit transform itself.
 *
 * The units are those of the schema: every local and every UTC unit, and the pre-binned ones; as strings and as objects, with a step.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { TIME_DATA, bothCompile, rowsOf } from './vl-time-helpers.js'
import { expressionDiff } from './vl-expressions.js'

const require = createRequire(import.meta.url)
const schema = require('vega-lite/vega-lite-schema.json').definitions
const LOCAL: string[] = [...schema.LocalSingleTimeUnit.enum, ...schema.LocalMultiTimeUnit.enum]
const UTC: string[] = [...schema.UtcSingleTimeUnit.enum, ...schema.UtcMultiTimeUnit.enum]
const BINNED: string[] = schema.BinnedTimeUnit.enum

const UNITS: Array<[string, unknown]> = [
  ...LOCAL.map((u): [string, unknown] => [u, u]),
  ...UTC.map((u): [string, unknown] => [u, u]),
  ...['year', 'month', 'date', 'hours', 'yearmonth', 'yearmonthdate', 'day'].map((u): [string, unknown] => [`{unit: ${u}, utc}`, { unit: u, utc: true }]),
  ...['year', 'month', 'date', 'hours', 'yearmonth', 'yearmonthdate', 'quarter'].map((u): [string, unknown] => [`{unit: ${u}, step: 2}`, { unit: u, step: 2 }]),
  ...['year', 'month', 'hours', 'yearmonthdate'].map((u): [string, unknown] => [`{unit: ${u}, utc, step: 3}`, { unit: u, utc: true, step: 3 }]),
]

const FORMS: Array<[string, (unit: unknown) => Record<string, unknown>]> = [
  ['encoding', (unit) => ({ data: { values: TIME_DATA }, mark: 'point', encoding: { x: { field: 't', type: 'temporal', timeUnit: unit }, y: { field: 'v', type: 'quantitative' } } })],
  ['ordinal encoding', (unit) => ({ data: { values: TIME_DATA }, mark: 'point', encoding: { x: { field: 't', type: 'ordinal', timeUnit: unit }, y: { field: 'v', type: 'quantitative' } } })],
  ['aggregate by the unit', (unit) => ({ data: { values: TIME_DATA }, mark: 'bar', encoding: { x: { field: 't', type: 'ordinal', timeUnit: unit }, y: { aggregate: 'sum', field: 'v', type: 'quantitative' } } })],
  ['transform', (unit) => ({ data: { values: TIME_DATA }, transform: [{ timeUnit: unit, field: 't', as: 'u' }], mark: 'point', encoding: { x: { field: 'u', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } })],
  ['colour', (unit) => ({ data: { values: TIME_DATA }, mark: 'point', encoding: { x: { field: 'v', type: 'quantitative' }, color: { field: 't', type: 'ordinal', timeUnit: unit } } })],
]

/** The time-unit transforms of a compiled spec, as the fields they read, the parts they cut and the fields they write. */
const transformsOf = (spec: any): unknown[] =>
  (spec.data ?? []).flatMap((d: any) => d.transform ?? []).filter((t: any) => t.type === 'timeunit').map(({ field, units, timezone, step, as }: any) => ({ field, units, timezone, step, as }))

describe('every time unit is what vega-lite makes', () => {
  for (const [formName, make] of FORMS) {
    describe(formName, () => {
      for (const [name, unit] of UNITS) {
        it(name, async () => {
          const spec = make(unit)
          const both = bothCompile(spec)
          if ('refusedBy' in both) {
            expect(both.refusedBy, `${name} in a ${formName}`).toBe('vega-lite')
            return
          }
          expect(transformsOf(both.ours), 'time-unit transforms').toEqual(transformsOf(both.theirs))
          expect(await rowsOf(both.ours)).toEqual(await rowsOf(both.theirs))
          expect(expressionDiff(both.ours, both.theirs)).toBe('')
        })
      }
    })
  }
})

describe('the pre-binned time units', () => {
  for (const unit of BINNED) {
    it(unit, async () => {
      const spec = { data: { values: TIME_DATA }, mark: 'bar', encoding: { x: { field: 't', type: 'temporal', timeUnit: unit }, y: { field: 'v', type: 'quantitative' } } }
      const both = bothCompile(spec)
      if ('refusedBy' in both) return expect(both.refusedBy).toBe('vega-lite')
      expect(await rowsOf(both.ours)).toEqual(await rowsOf(both.theirs))
    })
  }
})
