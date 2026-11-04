/**
 * The mark x channel space: every mark, every encoding channel a unit spec has (vega-lite 6.4.3's UNIT_CHANNEL_INDEX), and each kind
 * of definition a channel takes: a field of each type, a value, a datum (a number and a string), a condition with a value, a condition
 * with a field (nominal and quantitative), and a field read without a scale (`scale: null`). The channel replaces the one the mark's
 * own encoding has, so the channels a mark needs are asked every way as well.
 *
 * Every case is in the space whatever vega-lite does with it: a channel the mark does not draw is dropped by vega-lite (its output
 * is the output without the channel), one it draws is drawn, and a definition vega-lite refuses compares nothing (vl-ranged-compare.ts).
 * The facet channels (row, column, facet) split the view rather than draw on a mark: they are the facet differentials'.
 */
type Obj = Record<string, unknown>
type Case = [string, Obj]

const square = (x: number, y: number): Obj => ({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] })
const URL = 'data:image/png;base64,'
const ROWS: Obj[] = [
  { k: 'a', v: 1, w: 2, t: '2020-01-01', u: URL, lon: 10, lat: 20 },
  { k: 'b', v: 2, w: 5, t: '2020-03-15', u: URL, lon: 12, lat: 22 },
  { k: 'c', v: 3, w: 3, t: '2020-07-04', u: URL, lon: 14, lat: 21 },
]
const K = { field: 'k', type: 'nominal' }
const V = { field: 'v', type: 'quantitative' }
const W = { field: 'w', type: 'quantitative' }

export const MARKS = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'rule', 'line', 'area', 'trail', 'text', 'arc', 'image', 'geoshape'] as const

/** The data and the encoding a mark draws with. */
export function base(mark: string): Obj {
  if (mark === 'geoshape') return { data: { values: ROWS.map((r, i) => ({ type: 'Feature', geometry: square(i * 2, 0), ...r })) }, projection: { type: 'identity' }, encoding: {} }
  const enc: Obj = mark === 'arc' ? { theta: V } : mark === 'bar' ? { x: K, y: V } : { x: V, y: W }
  if (mark === 'text') enc.text = K
  if (mark === 'image') enc.url = { field: 'u' }
  return { data: { values: ROWS }, encoding: enc }
}

/** Each channel, with the value it takes, a second value (a condition's other branch) and the datum it is most naturally given. */
export const CHANNELS: Array<[channel: string, value: unknown, other: unknown]> = [
  ['x', 10, 40], ['y', 10, 40], ['x2', 30, 60], ['y2', 30, 60],
  ['xOffset', 5, 9], ['yOffset', 5, 9],
  ['theta', 1, 2], ['theta2', 2, 3], ['radius', 30, 20], ['radius2', 10, 5],
  ['longitude', 10, 12], ['latitude', 20, 22], ['longitude2', 12, 14], ['latitude2', 22, 24],
  ['color', '#f58518', '#72b7b2'], ['fill', '#f58518', '#72b7b2'], ['stroke', '#f58518', '#72b7b2'],
  ['opacity', 0.5, 0.8], ['fillOpacity', 0.5, 0.8], ['strokeOpacity', 0.5, 0.8],
  ['strokeWidth', 3, 1], ['strokeDash', [2, 2], [4, 1]], ['size', 50, 120], ['angle', 30, 60], ['shape', 'square', 'cross'],
  ['time', 1, 2],
  ['order', 1, 2], ['text', 'z', 'y'], ['detail', 'z', 'y'], ['key', 'z', 'y'],
  ['tooltip', 'z', 'y'], ['href', 'https://example.com/a', 'https://example.com/b'], ['url', URL, URL], ['description', 'z', 'y'],
]

const TEST = 'datum.v > 1'

/** Each kind of definition, for a channel whose value and other value are given. */
export const DEFS: Array<[string, (value: unknown, other: unknown) => Obj]> = [
  ['quantitative field', () => W],
  ['nominal field', () => K],
  ['ordinal field', () => ({ field: 'v', type: 'ordinal' })],
  ['temporal field', () => ({ field: 't', type: 'temporal' })],
  ['field without a type', () => ({ field: 'k' })],
  ['value', (value) => ({ value })],
  ['number datum', () => ({ datum: 3 })],
  ['string datum', () => ({ datum: 'b', type: 'nominal' })],
  ['condition with a value', (value, other) => ({ condition: { test: TEST, value }, value: other })],
  ['condition with a nominal field', (_value, other) => ({ condition: { test: TEST, field: 'k', type: 'nominal' }, value: other })],
  ['condition with a quantitative field', (_value, other) => ({ condition: { test: TEST, field: 'w', type: 'quantitative' }, value: other })],
  ['quantitative field, scale null', () => ({ ...W, scale: null })],
  ['nominal field, scale null', () => ({ ...K, scale: null })],
]

/** Every channel on `mark`, as every kind of definition. */
export function* markChannelCases(mark: string): Generator<Case> {
  const b = base(mark)
  for (const [ch, value, other] of CHANNELS) {
    for (const [dn, def] of DEFS) {
      yield [`${mark} ${ch}: ${dn}`, { ...b, mark, encoding: { ...(b.encoding as Obj), [ch]: def(value, other) } }]
    }
  }
}
