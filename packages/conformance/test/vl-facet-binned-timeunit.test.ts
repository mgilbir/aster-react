// @vitest-environment node
/**
 * A facet field binned to a time unit already (`binned*` units: the field holds the units' starts), against vega-lite 6.4.3 through real
 * Vega (C183): every binned unit of the schema x the facet form (a row, a column, a wrapped facet operator, an encoding facet, an encoding
 * row) x the field type (temporal, ordinal). The headers read the field's dates, as vega-lite parses them.
 */
import { createRequire } from 'node:module'
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const schema = createRequire(import.meta.url)('vega-lite/vega-lite-schema.json').definitions
const BINNED: string[] = schema.BinnedTimeUnit.enum
const rows = [
  { t: '2020-01-05T03:04:05', b: 1 }, { t: '2020-01-05T03:04:05', b: 3 }, { t: '2021-07-19T15:30:00', b: 2 }, { t: '2021-07-19T15:30:00', b: 5 },
]
const data = { values: rows }
const pt = { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } }

const cases: Array<[string, Record<string, unknown>]> = []
for (const unit of BINNED) {
  for (const type of ['temporal', 'ordinal']) {
    const def = { field: 't', type, timeUnit: unit }
    cases.push([caseName(unit, type, 'row'), { data, facet: { row: def }, spec: pt }])
    cases.push([caseName(unit, type, 'column'), { data, facet: { column: def }, spec: pt }])
    cases.push([caseName(unit, type, 'wrapped facet'), { data, facet: def, columns: 2, spec: pt }])
    cases.push([caseName(unit, type, 'encoding facet'), { data, ...pt, encoding: { ...pt.encoding, facet: def } }])
    cases.push([caseName(unit, type, 'encoding row'), { data, ...pt, encoding: { ...pt.encoding, row: def } }])
  }
}

describe('a facet over a binned time unit draws as vega-lite draws it', () => {
  it('the schema has binned units', () => { if (BINNED.length < 10) throw new Error(`only ${BINNED.length} binned units read from the schema`) })
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
