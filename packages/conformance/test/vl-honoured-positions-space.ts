/**
 * The positioning and mark space of the honoured-scale-type differentials: where a mark sits on the scales its encoding asked for.
 * Every mark, every data type of a position and every scale type vega-lite honours for it, with and without a band position, with
 * offsets on continuous and band scales, on binned and log scales, with datums, and a colour that is a time unit.
 */
import * as vl from 'vega-lite'
import { TIME_DATA, silent } from './vl-time-helpers.js'
import { DATA, SCALE_TYPES, type Obj } from './vl-honoured-space.js'

type Case = [string, Obj]

const V = { field: 'v', type: 'quantitative' }
const K = { field: 'k', type: 'nominal' }

export const MARKS = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'rule', 'line', 'area', 'trail', 'text'] as const

/** What the rest of the encoding of `mark` needs, with `pos` the position under test on `channel`. */
function around(mark: string, channel: 'x' | 'y', pos: Obj, partner?: Obj): Obj {
  const other = channel === 'x' ? 'y' : 'x'
  const rest: Obj = partner ? { [other]: partner }
    : mark === 'bar' ? { [other]: { aggregate: 'sum', field: 'v', type: 'quantitative' } }
    : mark === 'rect' ? { [other]: K }
    : { [other]: V }
  return { ...rest, [channel]: pos, ...(mark === 'text' ? { text: { field: 'k', type: 'nominal' } } : {}) }
}

/** The scale types vega-lite gives `pos` on `channel` when asked (`type` itself when it honours the request). */
function honoured(spec: Obj, channel: string, type: string): boolean {
  try {
    const vg = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec
    return (vg.scales ?? []).find((s: Obj) => s.name === channel)?.type === type
  } catch {
    return false
  }
}

const BAND_POSITIONS: Array<number | undefined> = [undefined, 0, 0.25, 1]

/** Every mark on x and on y: each data type, each scale type vega-lite honours, each band position (of the field, and of a time unit on the mark). */
export function* markPositionCases(mark: string): Generator<Case> {
  for (const channel of ['x', 'y'] as const) {
    for (const [dn, def] of DATA) {
      for (const type of SCALE_TYPES) {
        const probe = { data: { values: TIME_DATA }, mark, encoding: around(mark, channel, { ...def, scale: { type } }) }
        if (!honoured(probe, channel, type)) continue
        for (const bp of BAND_POSITIONS) {
          const pos = { ...def, scale: { type }, ...(bp !== undefined ? { bandPosition: bp } : {}) }
          yield [`${mark} ${channel}: ${dn}, ${type}, bandPosition ${bp}`, { data: { values: TIME_DATA }, mark, encoding: around(mark, channel, pos) }]
        }
        // (a temporal field on the other channel: the bar, rect or tick is then sized on this one's scale whatever its type)
        if (mark === 'bar' || mark === 'rect' || mark === 'tick') {
          const pos = { ...def, scale: { type } }
          yield [`${mark} ${channel}: ${dn}, ${type}, the other channel temporal`, { data: { values: TIME_DATA }, mark, encoding: around(mark, channel, pos, { field: 't', type: 'temporal' }) }]
        }
      }
    }
  }
}

/** Offsets on every kind of position: band, point, continuous, binned, time. */
export function* offsetCases(): Generator<Case> {
  const OFFSETS: Array<[string, Obj]> = [
    ['nominal', K],
    ['ordinal', { field: 'k', type: 'ordinal' }],
    ['quantitative', V],
    ['binned', { field: 'v', type: 'quantitative', bin: true }],
    ['temporal', { field: 't', type: 'temporal' }],
    ['month', { field: 't', type: 'temporal', timeUnit: 'month' }],
  ]
  for (const mark of ['bar', 'point', 'tick', 'rule', 'text', 'circle', 'rect', 'area', 'line']) {
    for (const channel of ['x', 'y'] as const) {
      for (const [dn, def] of DATA) {
        for (const [on, off] of OFFSETS) {
          const enc = { ...around(mark, channel, def), [`${channel}Offset`]: off }
          yield [`${mark} ${channel}: ${dn} with ${channel}Offset ${on}`, { data: { values: TIME_DATA }, mark, encoding: enc }]
        }
      }
    }
    // an offset along the other axis, and both axes
    yield [`${mark}: yOffset only`, { data: { values: TIME_DATA }, mark, encoding: { ...around(mark, 'x', K), yOffset: K } }]
    yield [`${mark}: both offsets`, { data: { values: TIME_DATA }, mark, encoding: { ...around(mark, 'x', K), xOffset: K, yOffset: K } }]
  }
  // layers that share an offset
  for (const channel of ['x', 'y'] as const) {
    const pos = channel === 'x' ? { x: K, y: { aggregate: 'sum', field: 'v', type: 'quantitative' } } : { y: K, x: { aggregate: 'sum', field: 'v', type: 'quantitative' } }
    const off = { [`${channel}Offset`]: K }
    for (const second of ['text', 'point', 'tick', 'rule', 'bar']) {
      const enc2 = second === 'text' ? { ...pos, ...off, text: { field: 'v', aggregate: 'sum', type: 'quantitative' } } : { ...pos, ...off }
      yield [`layer ${channel}Offset: bar + ${second}`, { data: { values: TIME_DATA }, layer: [{ mark: 'bar', encoding: { ...pos, ...off } }, { mark: second, encoding: enc2 }] }]
    }
    yield [`layer ${channel}Offset: only the second`, { data: { values: TIME_DATA }, layer: [{ mark: 'bar', encoding: pos }, { mark: 'point', encoding: { ...pos, ...off } }] }]
  }
}

/** A colour (and other channels) that is a time unit, on every mark, with the band position the unit is read at. */
export function* timeUnitChannelCases(): Generator<Case> {
  const UNITS: Array<[string, Obj]> = [
    ['month', { timeUnit: 'month' }],
    ['yearmonth', { timeUnit: 'yearmonth' }],
    ['utcyear', { timeUnit: 'utcyear' }],
    ['yearmonthdate', { timeUnit: 'yearmonthdate' }],
    ['none', {}],
  ]
  for (const mark of ['bar', 'rect', 'point', 'circle', 'tick', 'line', 'area', 'text', 'rule']) {
    for (const channel of ['color', 'size', 'opacity']) {
      for (const [un, unit] of UNITS) {
        for (const x of [K, V, { field: 't', type: 'temporal', timeUnit: 'month' }]) {
          for (const bp of [undefined, 0, 1]) {
            const def = { field: 't', type: 'temporal', ...unit, ...(bp !== undefined ? { bandPosition: bp } : {}) }
            const enc = { ...around(mark, 'x', x), [channel]: def }
            yield [`${mark} ${channel} ${un} (x ${JSON.stringify(x)}) bandPosition ${bp}`, { data: { values: TIME_DATA }, mark, encoding: enc }]
          }
        }
      }
    }
  }
}

/** A datum in place of a field, on every position of every mark. */
export function* datumCases(): Generator<Case> {
  const DATUMS: Array<[string, Obj]> = [
    ['number', { datum: 3 }],
    ['number, type', { datum: 3, type: 'quantitative' }],
    ['string', { datum: 'a', type: 'nominal' }],
    ['date', { datum: { year: 2020, month: 5 }, type: 'temporal' }],
    ['time-unit', { datum: 'b', type: 'ordinal' }],
    ['bandPosition', { datum: 3, type: 'quantitative', bandPosition: 1 }],
  ]
  for (const mark of MARKS) {
    for (const [dn, datum] of DATUMS) {
      for (const channel of ['x', 'y'] as const) {
        const other = channel === 'x' ? 'y' : 'x'
        for (const [on, otherDef] of [['quantitative', V], ['nominal', K], ['temporal', { field: 't', type: 'temporal' }]] as Array<[string, Obj]>) {
          const enc: Obj = { [channel]: datum, [other]: otherDef, ...(mark === 'text' ? { text: K } : {}) }
          yield [`${mark} ${channel}=datum ${dn}, ${other} ${on}`, { data: { values: TIME_DATA }, mark, encoding: enc }]
          yield [`${mark} ${channel}=datum ${dn}, ${other} ${on}, ${other}2`, { data: { values: TIME_DATA }, mark, encoding: { ...enc, [`${channel}2`]: { datum: 5 } } }]
        }
      }
    }
  }
}
