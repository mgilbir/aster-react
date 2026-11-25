// @vitest-environment node
/**
 * A `format` that is an object (`{year: "%Y"}`, the formats of a time unit) with no `formatType` (or `time` on a time), on a text, a
 * tooltip, an axis, a legend and a facet header, over every type of field, against vega-lite 6.4.3.
 *
 * Vega-lite reads such a format as a time format where the guide formats a time, and drops it everywhere else: the text of a field and a guide
 * of a number or a name take the default format of their field. Aster wrote the object into `format(datum.y, {...})` (which Vega refuses at
 * run time) and into the guide's `format`.
 */
import { describe, it } from 'vitest'
import { check, plain } from './vl-parity-check.js'

const DATA = { values: [{ x: 1, y: 2.345, n: 'a', g: 'p', t: '2001-02-03' }, { x: 3, y: 5.5, n: 'b', g: 'q', t: '2002-03-04' }, { x: 4, y: 6.25, n: 'a', g: 'p', t: '2003-04-05' }] }
const TYPES: Array<[string, string]> = [['y', 'quantitative'], ['n', 'nominal'], ['n', 'ordinal'], ['t', 'temporal']]
const FORMATS: Array<Record<string, unknown>> = [{ year: '%Y' }, { a: 1 }, {}]
/** The format types written beside it: none (the routed shape), and `time` on a time (the form of its own). */
const FORMAT_TYPES = (type: string): Array<string | undefined> => (type === 'temporal' ? [undefined, 'time'] : [undefined])

type Spec = Record<string, unknown>
const cases: Array<[string, Spec]> = []
for (const [field, type] of TYPES) {
  for (const format of FORMATS) {
    for (const formatType of FORMAT_TYPES(type)) {
      const f = { field, type, format, ...(formatType === undefined ? {} : { formatType }) }
      const name = `${type} ${JSON.stringify(format)} ${formatType ?? 'no formatType'}`
      const x = { field: 'x', type: 'quantitative' }
      cases.push([`text ${name}`, { data: DATA, mark: 'text', encoding: { x, text: f } }])
      cases.push([`tooltip ${name}`, { data: DATA, mark: 'point', encoding: { x, tooltip: f } }])
      cases.push([`axis ${name}`, { data: DATA, mark: 'point', encoding: { x: { field, type, axis: { format, ...(formatType === undefined ? {} : { formatType }) } }, y: { field: 'x', type: 'quantitative' } } }])
      cases.push([`legend ${name}`, { data: DATA, mark: 'point', encoding: { x, color: { field, type, legend: { format, ...(formatType === undefined ? {} : { formatType }) } } } }])
      cases.push([`size legend ${name}`, { data: DATA, mark: 'point', encoding: { x, size: { field, type, legend: { format, ...(formatType === undefined ? {} : { formatType }) } } } }])
    }
  }
}

describe('@aster-charts/vl == vega-lite: a format that is an object', () => {
  for (const [name, spec] of cases) it(name, () => check(plain(spec)), 30_000)
})
