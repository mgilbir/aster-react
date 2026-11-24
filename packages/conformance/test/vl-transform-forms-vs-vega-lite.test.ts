// @vitest-environment node
/**
 * Transforms and their outputs, against vega-lite 6.4.3 with real vega on both outputs (audit C186 C187 C189 C185 C188 C300 C443 C494):
 *  - a name a transform produces with a dot in it (`as: "m.x"`) is a key of the rows; a path that joins to it reads it back, in a channel,
 *    a later transform and an expression;
 *  - equal bins - two transforms', or a transform's and a channel's - are one bin, and a bin's extent may be a parameter;
 *  - the stack of an arc, an area and a bar follows a colour domain, whatever form the colour field takes;
 *  - a facet's map has no default projection type.
 * Every case is generated from a seed or listed by shape; a spec vega-lite refuses must be refused here.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { pick, plain, sameDrawing, stream } from './vl-a16-helpers.js'

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  c: ['a', 'b', 'c'][i % 3]!, g: i % 2 ? 'm' : 'f', v: [4, 9, 6, 31, 7, 5, 8, 12, 2, 6, 7, 20][i % 12]! + (i % 5) * 3, w: (i * 7) % 13, i,
  t: `2012-0${1 + (i % 6)}-1${i % 9}`, o: { g: i % 2 ? 'm' : 'f', c: ['a', 'b', 'c'][i % 3] },
}))
const data = { values: ROWS }
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })

// --- a produced name with a dot in it ----------------------------------------------------------------------------------------------

type Kind = 'calculate' | 'aggregate' | 'joinaggregate' | 'window' | 'bin' | 'stack' | 'fold' | 'timeUnit' | 'regression' | 'lookup'
const KINDS: Kind[] = ['calculate', 'aggregate', 'joinaggregate', 'window', 'bin', 'stack', 'fold', 'timeUnit', 'regression', 'lookup']
const AS = ['m.x', 'm.n.x', 'm_x', 'm x']

function producing(kind: Kind, as: string): { transform: Record<string, unknown>[]; channel: string; keep: string[] } {
  switch (kind) {
    case 'calculate': return { transform: [{ calculate: 'datum.v * 2', as }], channel: as, keep: ['c'] }
    case 'aggregate': return { transform: [{ aggregate: [{ op: 'mean', field: 'v', as }], groupby: ['c'] }], channel: as, keep: ['c'] }
    case 'joinaggregate': return { transform: [{ joinaggregate: [{ op: 'sum', field: 'v', as }], groupby: ['c'] }], channel: as, keep: ['c'] }
    case 'window': return { transform: [{ window: [{ op: 'rank', as }], sort: [{ field: 'v' }], groupby: ['c'] }], channel: as, keep: ['c'] }
    case 'bin': return { transform: [{ bin: true, field: 'v', as }], channel: as, keep: ['c'] }
    case 'stack': return { transform: [{ stack: 'v', groupby: ['c'], as: [as, `${as}_end`] }], channel: as, keep: ['c'] }
    case 'fold': return { transform: [{ fold: ['v', 'w'], as: [`${as}_k`, as] }], channel: as, keep: ['c'] }
    case 'timeUnit': return { transform: [{ timeUnit: 'month', field: 't', as }], channel: as, keep: ['c'] }
    case 'regression': return { transform: [{ regression: 'v', on: 'w', as: [`${as}_on`, as] }], channel: as, keep: ['c'] }
    case 'lookup': return { transform: [{ lookup: 'c', from: { data: { values: [{ c: 'a', z: 1 }, { c: 'b', z: 5 }, { c: 'c', z: 3 }] }, key: 'c', fields: ['z'] }, as: [as] }], channel: as, keep: ['c'] }
  }
}

describe('a name a transform produces with a dot in it is the key of its rows, and a path that joins to it reads it', () => {
  for (const kind of KINDS) {
    for (const as of AS) {
      for (const read of ['path', 'escaped', 'later calculate', 'later filter', 'later aggregate'] as const) {
        const { transform, channel } = producing(kind, as)
        const quant = !['timeUnit', 'lookup'].includes(kind) || kind === 'lookup'
        const field = read === 'escaped' ? as.replace(/\./g, '\\.') : as
        const later: Record<string, unknown>[] =
          read === 'later calculate' ? [{ calculate: `datum[${JSON.stringify(as)}] + 1`, as: 'z1' }]
            : read === 'later filter' ? [{ filter: { field: as, valid: true } }]
              : read === 'later aggregate' ? [{ aggregate: [{ op: 'max', field: as, as: 'mx' }], groupby: ['c'] }] : []
        const y = read === 'later calculate' ? q('z1') : read === 'later aggregate' ? q('mx') : kind === 'timeUnit' ? { field, type: 'temporal' } : quant ? q(field) : n(field)
        it(`${kind} as ${JSON.stringify(as)}, read as ${read}`, () => sameDrawing({ data, transform: [...transform, ...later], mark: 'point', encoding: { x: n('c'), y: kind === 'bin' && read === 'path' ? q(field) : y } }), 20_000)
      }
    }
  }
})

describe('a name with a dot read by a path where the rows carry another key is not found, as in vega-lite', () => {
  it('an aggregate that makes "m.x" and a channel that reads "m"', () => sameDrawing({ data, transform: [{ aggregate: [{ op: 'mean', field: 'v', as: 'm.x' }], groupby: ['c'] }], mark: 'point', encoding: { x: n('c'), y: q('m') } }))
})

// --- bins -------------------------------------------------------------------------------------------------------------------------

describe('equal bins are one bin', () => {
  const bar = (transform: Record<string, unknown>[], encoding: Record<string, unknown>) => ({ data, transform, mark: 'bar', encoding })
  const cases: Array<[string, Record<string, unknown>]> = [
    ['two transforms', bar([{ bin: true, field: 'v', as: 'b' }, { bin: true, field: 'v', as: 'b2' }], { x: q('b2', { bin: 'binned' }), x2: { field: 'b2_end' }, y: { aggregate: 'count' } })],
    ['two transforms, a formula between them', bar([{ bin: true, field: 'v', as: 'b' }, { calculate: 'datum.b + 1', as: 'k' }, { bin: true, field: 'v', as: 'b2' }], { x: q('b2', { bin: 'binned' }), x2: { field: 'b2_end' }, y: { aggregate: 'count' } })],
    ['a transform and the channel', bar([{ bin: true, field: 'v', as: 'b' }], { x: q('v', { bin: true }), y: { aggregate: 'count' } })],
    ['a transform and the channel, maxbins', bar([{ bin: { maxbins: 4 }, field: 'v', as: 'b' }], { x: q('v', { bin: { maxbins: 4 } }), y: { aggregate: 'count' } })],
    ['a transform and the channel of another bin', bar([{ bin: { maxbins: 4 }, field: 'v', as: 'b' }], { x: q('v', { bin: { maxbins: 7 } }), y: { aggregate: 'count' } })],
    ['a transform and the channel, a filter between them', bar([{ bin: true, field: 'v', as: 'b' }, { filter: 'datum.w > 3' }], { x: q('v', { bin: true }), y: { aggregate: 'count' } })],
    ['a transform and the channel, the same bin on y', bar([{ bin: true, field: 'v', as: 'b' }], { y: q('v', { bin: true }), x: { aggregate: 'count' } })],
    ['a bin and a bin of another field', bar([{ bin: true, field: 'v', as: 'b' }, { bin: true, field: 'w', as: 'b2' }], { x: q('b', { bin: 'binned' }), x2: { field: 'b_end' }, y: q('b2', { bin: 'binned' }), y2: { field: 'b2_end' } })],
  ]
  for (const [name, spec] of cases) it(name, () => sameDrawing(spec))
  it('in a layer', () => sameDrawing({ data, layer: [bar([{ bin: true, field: 'v', as: 'b' }], { x: q('v', { bin: true }), y: { aggregate: 'count' } }), bar([], { x: q('v', { bin: true }), y: { aggregate: 'count' }, color: { value: 'red' } })] }))
})

describe('the extent of a bin may be a parameter', () => {
  const brush = { name: 'br', select: { type: 'interval', encodings: ['x'] } }
  for (const extent of [{ param: 'br' }, { param: 'br', encoding: 'x' }, { param: 'br', field: 'b' }]) {
    it(`a transform: ${JSON.stringify(extent)}`, () => sameDrawing({ data, params: [brush], transform: [{ bin: { extent }, field: 'v', as: 'b' }], mark: 'bar', encoding: { x: q('b', { bin: 'binned' }), x2: { field: 'b_end' }, y: { aggregate: 'count' } } }))
  }
  it('a variable parameter', () => sameDrawing({ data, params: [{ name: 'ext', value: [0, 40] }], transform: [{ bin: { extent: { param: 'ext' } }, field: 'v', as: 'b' }], mark: 'bar', encoding: { x: q('b', { bin: 'binned' }), x2: { field: 'b_end' }, y: { aggregate: 'count' } } }))
  it('is not an array: no TypeError', () => {
    expect(() => compile(plain({ data, params: [brush], transform: [{ bin: { extent: { param: 'br' } }, field: 'v', as: 'b' }], mark: 'point', encoding: { x: q('b') } }) as never)).not.toThrow()
  })
})

// --- the stack order of a colour domain -------------------------------------------------------------------------------------------------

describe('a stack follows the colour domain, in every form', () => {
  const DOMAIN = ['c', 'a', 'b']
  const MARKS = ['arc', 'bar', 'area', 'text'] as const
  for (const mark of MARKS) {
    for (const colorField of ['c', 'o.c']) {
      for (const stack of [undefined, 'normalize', 'center', false] as const) {
        const measure = q(mark === 'area' || mark === 'bar' ? 'v' : 'v', { aggregate: 'sum', ...(stack !== undefined ? { stack } : {}) })
        const color = n(colorField, { scale: { domain: DOMAIN } })
        const encoding: Record<string, unknown> =
          mark === 'arc' || mark === 'text' ? { theta: measure, color, ...(mark === 'text' ? { text: n('c') } : {}) }
            : mark === 'bar' ? { x: n('g'), y: measure, color } : { x: q('i'), y: measure, color }
        it(`${mark}, colour ${colorField}, stack ${String(stack)}`, () => sameDrawing({ data, mark, encoding }))
      }
    }
  }
  it('an arc over theta and radius', () => sameDrawing({ data, mark: 'arc', encoding: { theta: q('v', { aggregate: 'sum' }), radius: q('w', { aggregate: 'sum' }), color: n('c', { scale: { domain: DOMAIN } }) } }))
  it('an arc whose mark def says horizontal (an arc has no orientation)', () => sameDrawing({ data, mark: { type: 'arc', orient: 'horizontal' }, encoding: { theta: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: DOMAIN } }) } }))
  it('an area is imputed by the colour alone, not by the sort index', () => sameDrawing({ data, mark: 'area', encoding: { x: q('i'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: DOMAIN } }) } }))
  it('in a layer, a facet and a repeat', async () => {
    const unit = { mark: 'area', encoding: { x: q('i'), y: q('v', { aggregate: 'sum' }), color: n('c', { scale: { domain: DOMAIN } }) } }
    await sameDrawing({ data, layer: [unit] })
    await sameDrawing({ data, facet: { row: n('g') }, spec: unit })
    await sameDrawing({ data, repeat: ['v', 'w'], spec: { ...unit, encoding: { ...unit.encoding, y: q('v', { aggregate: 'sum' }) } } })
  })
})

// --- maps in a facet -------------------------------------------------------------------------------------------------------------

describe('a map in a facet has the projection its child specified (no default type)', () => {
  const pts = { values: [{ lon: -10, lat: 20, n: 'a', k: 'x' }, { lon: 30, lat: -5, n: 'b', k: 'y' }, { lon: 70, lat: 40, n: 'a', k: 'y' }, { lon: -60, lat: -30, n: 'b', k: 'x' }] }
  const enc = { longitude: q('lon'), latitude: q('lat') }
  const unit = { mark: 'circle', encoding: enc }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['facet row', { data: pts, facet: { row: n('n') }, spec: unit }],
    ['facet column', { data: pts, facet: { column: n('k') }, spec: unit }],
    ['facet wrapped', { data: pts, facet: n('n'), columns: 2, spec: unit }],
    ['facet, config.projection', { data: pts, config: { projection: { rotate: [10, 0, 0] } }, facet: { row: n('n') }, spec: unit }],
    ['facet, an explicit type', { data: pts, facet: { row: n('n') }, spec: { ...unit, projection: { type: 'orthographic' } } }],
    ['a unit with a row channel', { data: pts, mark: 'circle', encoding: { ...enc, row: n('n') } }],
    ['a unit with a column channel and config.projection', { data: pts, config: { projection: { rotate: [10, 0, 0] } }, mark: 'circle', encoding: { ...enc, column: n('n') } }],
    ['a facet of a layer', { data: pts, facet: { row: n('n') }, spec: { layer: [unit] } }],
    ['a unit alone', { data: pts, ...unit }],
  ]
  for (const [name, spec] of cases) it(name, () => sameDrawing(spec))
})

void pick
void stream
