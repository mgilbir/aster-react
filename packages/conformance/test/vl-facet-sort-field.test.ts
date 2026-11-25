// @vitest-environment node
/**
 * A facet sorted by a field (`sort: {field}`, which vega-lite reads as the minimum of the field) over a view with a calculate and a time-unit
 * facet field - trellis_area_seattle. The cells took their rows from the raw data source, where the facet field and the sort field do not
 * exist yet, so the rows fell into no row and the chart was 133 pixels high where vega-lite's is 682.
 */
import { describe, it } from 'vitest'
import { check, plain } from './vl-parity-check.js'

const ROWS = Array.from({ length: 24 * 4 }, (_, i) => ({ date: `2010-${String((i % 4) * 3 + 1).padStart(2, '0')}-15T${String(Math.floor(i / 4)).padStart(2, '0')}:00:00`, temperature: 8 + Math.floor(i / 4) / 3 + (i % 4) * 4 }))
const cell = { width: 200, height: 25, view: { stroke: null }, mark: 'area', encoding: { x: { field: 'date', type: 'temporal', timeUnit: 'monthdate' }, y: { aggregate: 'mean', field: 'temperature', type: 'quantitative' } } }
const calc = [{ calculate: '(hours(datum.date) + 18) % 24', as: 'order' }]
const CASES: Array<[string, Record<string, unknown>]> = [
  ['trellis_area_seattle: a sort field, a calculate and a time unit', { transform: calc, spacing: { row: 1 }, facet: { row: { field: 'date', timeUnit: 'hours', type: 'nominal', sort: { field: 'order' } } }, spec: cell }],
  ['a sort field and an operation', { transform: calc, facet: { row: { field: 'date', timeUnit: 'hours', type: 'nominal', sort: { field: 'order', op: 'max' } } }, spec: cell }],
  ['a sort field on a column', { transform: calc, facet: { column: { field: 'date', timeUnit: 'hours', type: 'nominal', sort: { field: 'order' } } }, spec: { ...cell, width: 60 } }],
  ['no sort', { transform: calc, facet: { row: { field: 'date', timeUnit: 'hours', type: 'nominal' } }, spec: cell }],
]
describe('@aster-charts/vl == vega-lite: a facet sorted by a field', () => {
  for (const [name, spec] of CASES) it(name, () => check(plain({ data: { values: ROWS }, ...spec })), 60_000)
})
