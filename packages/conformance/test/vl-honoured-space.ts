/** The space the scale-type differentials share: where each channel lives, and the data types and scale types asked of it. */
export type Obj = Record<string, unknown>

export const SCALE_TYPES = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'identity', 'sequential', 'time', 'utc', 'quantile', 'quantize', 'threshold', 'bin-ordinal', 'ordinal', 'point', 'band']

export const DATA: Array<[string, Obj]> = [
  ['quantitative', { field: 'v', type: 'quantitative' }],
  ['quantitative, binned', { field: 'v', type: 'quantitative', bin: true }],
  ['ordinal', { field: 'k', type: 'ordinal' }],
  ['nominal', { field: 'k', type: 'nominal' }],
  ['temporal', { field: 't', type: 'temporal' }],
  ['temporal, month', { field: 't', type: 'temporal', timeUnit: 'month' }],
  ['temporal, yearmonth', { field: 't', type: 'temporal', timeUnit: 'yearmonth' }],
  ['temporal, utc month', { field: 't', type: 'temporal', timeUnit: 'utcmonth' }],
  ['temporal, utc year', { field: 't', type: 'temporal', timeUnit: { unit: 'year', utc: true } }],
]

/** Where each channel lives: its mark, and the rest of the encoding that mark needs. */
export const PLACES: Array<[string, string, (def: Obj) => Obj]> = [
  ['x', 'point', (d) => ({ x: d, y: { field: 'v', type: 'quantitative' } })],
  ['x', 'bar', (d) => ({ x: d, y: { aggregate: 'sum', field: 'v', type: 'quantitative' } })],
  ['x', 'line', (d) => ({ x: d, y: { field: 'v', type: 'quantitative' } })],
  ['y', 'point', (d) => ({ y: d, x: { field: 'v', type: 'quantitative' } })],
  ['theta', 'arc', (d) => ({ theta: d })],
  ['radius', 'arc', (d) => ({ radius: d, theta: { field: 'k', type: 'nominal' } })],
  ['color', 'point', (d) => ({ color: d, x: { field: 'v', type: 'quantitative' } })],
  ['size', 'point', (d) => ({ size: d, x: { field: 'v', type: 'quantitative' } })],
  ['opacity', 'point', (d) => ({ opacity: d, x: { field: 'v', type: 'quantitative' } })],
  ['strokeWidth', 'point', (d) => ({ strokeWidth: d, x: { field: 'v', type: 'quantitative' } })],
  ['shape', 'point', (d) => ({ shape: d, x: { field: 'v', type: 'quantitative' } })],
  ['strokeDash', 'line', (d) => ({ strokeDash: d, x: { field: 'v', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } })],
  ['fill', 'circle', (d) => ({ fill: d, x: { field: 'v', type: 'quantitative' } })],
  ['stroke', 'point', (d) => ({ stroke: d, x: { field: 'v', type: 'quantitative' } })],
  ['fillOpacity', 'point', (d) => ({ fillOpacity: d, x: { field: 'v', type: 'quantitative' } })],
  ['strokeOpacity', 'point', (d) => ({ strokeOpacity: d, x: { field: 'v', type: 'quantitative' } })],
  ['angle', 'point', (d) => ({ angle: d, x: { field: 'v', type: 'quantitative' } })],
  ['xOffset', 'bar', (d) => ({ xOffset: d, x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count' } })],
  ['yOffset', 'bar', (d) => ({ yOffset: d, y: { field: 'k', type: 'nominal' }, x: { aggregate: 'count' } })],
  ['x with xOffset', 'bar', (d) => ({ x: d, xOffset: { field: 'k', type: 'nominal' }, y: { aggregate: 'count' } })],
]

export function channelOf(place: string): string {
  return place === 'x with xOffset' ? 'x' : place
}
