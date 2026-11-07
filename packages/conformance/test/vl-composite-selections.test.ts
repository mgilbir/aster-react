// @vitest-environment node
/**
 * A selection a repeat or a concat gives to the composite marks below it, against vega-lite 6.4.3. An errorbar or an errorband that is one
 * unit once vega-lite has normalized it takes the selection (a point or an interval, its brush, a condition on it, bound scales); one that
 * is several (ticks, borders, points) and a boxplot declare the selection's signals twice in one Vega scope, which Vega rejects, so they
 * are refused (vega-lite compiles them to a spec Vega cannot run).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import * as vega from 'vega'
import { compile } from '@aster-charts/vl'
import { compare } from './vl-composite-compare.js'

const DATA = { values: Array.from({ length: 30 }, (_, i) => ({ c: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', x: i % 6, v: (i * 7) % 13 + 1, w: (i * 3) % 11 + 2 })) }
const q = (field: unknown, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string) => ({ field, type: 'nominal' })
const ref = (name: string) => ({ repeat: name })
const point = { name: 'pick', select: { type: 'point', fields: ['c'] } }
const interval = { name: 'brush', select: 'interval' }

const bar = (extra: Record<string, unknown> = {}, y: unknown = q('v')) => ({ mark: { type: 'errorbar', ...extra }, encoding: { x: n('c'), y, opacity: { condition: { param: 'pick', value: 1 }, value: 0.3 } } })
const band = (extra: Record<string, unknown> = {}, y: unknown = q('v')) => ({ mark: { type: 'errorband', ...extra }, encoding: { x: q('x'), y, opacity: { condition: { param: 'pick', value: 1 }, value: 0.3 } } })

const ACCEPTED: Array<[string, Record<string, any>]> = []
for (const [pn, param] of [['a point selection', point], ['an interval selection', interval]] as const) {
  const kind = (u: Record<string, any>) => (param === point ? u : { ...u, encoding: { ...u.encoding, opacity: { condition: { param: 'brush', value: 1 }, value: 0.3 } } })
  for (const [mn, make] of [['errorbar', bar], ['errorband', band]] as const) {
    const ys = (v: unknown) => kind(make({}, v))
    ACCEPTED.push(
      [`${pn} on a column repeat of ${mn}`, { data: DATA, params: [param], repeat: { column: ['v', 'w'] }, spec: ys(q(ref('column'))) }],
      [`${pn} on a row repeat of ${mn}`, { data: DATA, params: [param], repeat: { row: ['v', 'w'] }, spec: ys(q(ref('row'))) }],
      [`${pn} on a list repeat of ${mn}`, { data: DATA, params: [param], repeat: ['v', 'w'], spec: ys(q(ref('repeat'))) }],
      [`${pn} on a grid repeat of ${mn}`, { data: DATA, params: [param], repeat: { row: ['v', 'w'], column: ['x', 'v'] }, spec: ys(q(ref('row'))) }],
      [`${pn} on an hconcat of two ${mn}s`, { data: DATA, params: [param], hconcat: [ys(q('v')), ys(q('w'))] }],
      [`${pn} on a vconcat of two ${mn}s`, { data: DATA, params: [param], vconcat: [ys(q('v')), ys(q('w'))] }],
      [`${pn} on a concat of ${mn} and a point`, { data: DATA, params: [param], hconcat: [ys(q('v')), { mark: 'point', encoding: { x: q('x'), y: q('w') } }] }],
      [`${pn} on a repeat that holds a concat of ${mn}s`, { data: DATA, params: [param], repeat: { column: ['v', 'w'] }, spec: { vconcat: [ys(q(ref('column'))), ys(q('x'))] } }],
      [`${pn} on a facet of ${mn}`, { data: DATA, params: [param], facet: { column: n('g') }, spec: ys(q('v')) }],
    )
  }
}
// a selection a view declares for itself, next to the composite, and a repeat's own parameters
ACCEPTED.push(
  ['a repeat with a selection on its errorbar and a colour condition', { data: DATA, params: [point], repeat: { column: ['v', 'w'] }, spec: { mark: 'errorbar', encoding: { x: n('c'), y: q(ref('column')), color: { condition: { param: 'pick', field: 'g', type: 'nominal' }, value: 'grey' } } } }],
  ['a repeat with a selection and a variable parameter', { data: DATA, params: [point, { name: 'scale', value: 1 }], repeat: { column: ['v', 'w'] }, spec: bar({}, q(ref('column'))) }],
  ['a named repeat with a selection on its errorband', { data: DATA, name: 'outer', params: [point], repeat: { column: ['v', 'w'] }, spec: band({}, q(ref('column'))) }],
)

describe('a selection given to a composite mark of one unit is what vega-lite makes', () => {
  for (const [name, spec] of ACCEPTED) it(name, () => compare(spec), 30_000)
})

describe('a selection given to a composite mark of several units is refused', () => {
  const MANY: Array<[string, Record<string, any>]> = [
    ['an errorbar with ticks in a repeat', { data: DATA, params: [point], repeat: { column: ['v', 'w'] }, spec: bar({ ticks: true }, q(ref('column'))) }],
    ['an errorband with borders in a repeat', { data: DATA, params: [point], repeat: { column: ['v', 'w'] }, spec: band({ borders: true }, q(ref('column'))) }],
    ['an errorbar with ticks in an hconcat', { data: DATA, params: [point], hconcat: [bar({ ticks: true }), bar({ ticks: true }, q('w'))] }],
    ['an errorband with borders in an hconcat', { data: DATA, params: [point], hconcat: [band({ borders: true }), band({ borders: true }, q('w'))] }],
    ['a boxplot in a repeat', { data: DATA, params: [point], repeat: { column: ['v', 'w'] }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q(ref('column')) } } }],
    ['a boxplot in an hconcat', { data: DATA, params: [point], hconcat: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: 'boxplot', encoding: { x: n('c'), y: q('w') } }] }],
  ]
  for (const [name, spec] of MANY) {
    it(`${name}: vega-lite's spec has the signals twice, ours is refused`, () => {
      const theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: { level: () => null, warn() {}, info() {}, debug() {}, error() {} } }).spec
      expect(() => new (vega as any).View((vega as any).parse(theirs), { renderer: 'none' })).toThrow(/Duplicate signal name/)
      expect(() => compile(JSON.parse(JSON.stringify(spec)) as never)).toThrow(/selection parameter/)
    })
  }
})
