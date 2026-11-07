/**
 * The geographic channel space: every mark that draws longitude / latitude positions x each geographic channel it draws x every
 * property a channel definition takes (aggregate, bin, timeUnit, sort, stack, scale, axis, legend, condition, impute, band,
 * bandPosition, format, title) x every data type, and the same channel as a datum or a value of each type. Each is asked beside the
 * companions that change what the property can mean: the default projection alone; a projection of another type with a nominal
 * colour (the field an aggregate groups by); and a pre-binned `y` with its end, beside the second pair of coordinates (vega-lite keeps
 * `longitude2` / `latitude2` on a point, a circle, a square, a line or a trail only when `y` is pre-binned: it reads `y` as the
 * position every end but x2 ends).
 *
 * Every case is in the space whatever vega-lite does with it (vl-geo-channels.test.ts says which ones @aster-charts/vl refuses, and why).
 */
type Obj = Record<string, unknown>
type Case = [string, Obj]

const ROWS: Obj[] = [
  { k: 'a', v: 1, v2: 2, t: '2020-01-01', lon: 10, lat: 20, lon2: 12, lat2: 22 },
  { k: 'b', v: 2, v2: 3, t: '2020-03-15', lon: 12, lat: 22, lon2: 15, lat2: 25 },
  { k: 'c', v: 3, v2: 4, t: '2020-07-04', lon: 14, lat: 21, lon2: 18, lat2: 23 },
  { k: 'a', v: 4, v2: 5, t: '2021-02-01', lon: 12, lat: 24, lon2: 16, lat2: 27 },
  { k: 'b', v: 5, v2: 6, t: '2021-06-01', lon: 16, lat: 22, lon2: 19, lat2: 26 },
]

/** The marks that draw longitude / latitude positions (a geoshape draws its shape, and drops them). */
export const GEO_MARKS = ['point', 'circle', 'square', 'text', 'line', 'trail', 'rule'] as const

const FIELD: Record<string, string> = { longitude: 'lon', latitude: 'lat', longitude2: 'lon2', latitude2: 'lat2' }
const Q = 'quantitative'
const TEST = 'datum.v > 2'

/** Each way of writing a channel's definition, given the field it reads (`f`) and the constant it is most naturally given (`n`). */
const PLAIN: Array<[string, (f: string, n: number) => Obj]> = [
  ['quantitative field', (f) => ({ field: f, type: Q })],
  ['field without a type', (f) => ({ field: f })],
  ['nominal field', (f) => ({ field: f, type: 'nominal' })],
  ['ordinal field', (f) => ({ field: f, type: 'ordinal' })],
  ['temporal field', (f) => ({ field: f, type: 'temporal' })],
  ['temporal string field', () => ({ field: 't', type: 'temporal' })],
  ['aggregate mean', (f) => ({ field: f, type: Q, aggregate: 'mean' })],
  ['aggregate sum', (f) => ({ field: f, type: Q, aggregate: 'sum' })],
  ['aggregate max', (f) => ({ field: f, type: Q, aggregate: 'max' })],
  ['aggregate distinct', (f) => ({ field: f, type: Q, aggregate: 'distinct' })],
  ['aggregate count of a field', (f) => ({ field: f, type: Q, aggregate: 'count' })],
  ['aggregate count', () => ({ aggregate: 'count', type: Q })],
  ['nominal aggregate min', (f) => ({ field: f, type: 'nominal', aggregate: 'min' })],
  ['bin', (f) => ({ field: f, type: Q, bin: true })],
  ['bin maxbins 4', (f) => ({ field: f, type: Q, bin: { maxbins: 4 } })],
  ['bin step 5', (f) => ({ field: f, type: Q, bin: { step: 5 } })],
  ['ordinal bin', (f) => ({ field: f, type: 'ordinal', bin: true })],
  ['bin binned', (f) => ({ field: f, type: Q, bin: 'binned' })],
  ['bin {binned: true}', (f) => ({ field: f, type: Q, bin: { binned: true } })],
  ['timeUnit year', (f) => ({ field: f, type: Q, timeUnit: 'year' })],
  ['timeUnit month', (f) => ({ field: f, type: Q, timeUnit: 'month' })],
  ['temporal timeUnit yearmonth', () => ({ field: 't', type: 'temporal', timeUnit: 'yearmonth' })],
  ['temporal timeUnit utc month', () => ({ field: 't', type: 'temporal', timeUnit: { unit: 'month', utc: true } })],
  ['ordinal timeUnit year', (f) => ({ field: f, type: 'ordinal', timeUnit: 'year' })],
  ['sort ascending', (f) => ({ field: f, type: Q, sort: 'ascending' })],
  ['sort descending', (f) => ({ field: f, type: Q, sort: 'descending' })],
  ['sort null', (f) => ({ field: f, type: Q, sort: null })],
  ['sort array', (f) => ({ field: f, type: Q, sort: [12, 10] })],
  ['nominal sort array', (f) => ({ field: f, type: 'nominal', sort: [12, 10] })],
  ['sort by field', (f) => ({ field: f, type: Q, sort: { field: 'v', order: 'descending' } })],
  ['sort by op', (f) => ({ field: f, type: Q, sort: { op: 'sum', field: 'v' } })],
  ['sort by encoding', (f) => ({ field: f, type: Q, sort: '-color' })],
  ['stack zero', (f) => ({ field: f, type: Q, stack: 'zero' })],
  ['stack normalize', (f) => ({ field: f, type: Q, stack: 'normalize' })],
  ['stack center', (f) => ({ field: f, type: Q, stack: 'center' })],
  ['stack null', (f) => ({ field: f, type: Q, stack: null })],
  ['stack true', (f) => ({ field: f, type: Q, stack: true })],
  ['scale log', (f) => ({ field: f, type: Q, scale: { type: 'log' } })],
  ['scale null', (f) => ({ field: f, type: Q, scale: null })],
  ['scale domain', (f) => ({ field: f, type: Q, scale: { domain: [0, 50] } })],
  ['scale zero, reverse', (f) => ({ field: f, type: Q, scale: { zero: true, reverse: true } })],
  ['axis title', (f) => ({ field: f, type: Q, axis: { title: 'q' } })],
  ['axis null', (f) => ({ field: f, type: Q, axis: null })],
  ['legend null', (f) => ({ field: f, type: Q, legend: null })],
  ['legend title', (f) => ({ field: f, type: Q, legend: { title: 'q' } })],
  ['condition with a value', (f, n) => ({ field: f, type: Q, condition: { test: TEST, value: n } })],
  ['conditions with values', (f, n) => ({ field: f, type: Q, condition: [{ test: TEST, value: n }, { test: 'datum.v > 4', value: n + 1 }] })],
  ['impute value', (f) => ({ field: f, type: Q, impute: { value: 0 } })],
  ['impute mean', (f) => ({ field: f, type: Q, impute: { method: 'mean' } })],
  ['band', (f) => ({ field: f, type: Q, band: 0.5 })],
  ['bandPosition', (f) => ({ field: f, type: Q, bandPosition: 0.5 })],
  ['temporal bandPosition', () => ({ field: 't', type: 'temporal', timeUnit: 'month', bandPosition: 0 })],
  ['format', (f) => ({ field: f, type: Q, format: '.1f' })],
  ['title', (f) => ({ field: f, type: Q, title: 'Where' })],
  ['every modifier at once', (f, n) => ({ field: f, type: Q, sort: 'descending', stack: 'zero', scale: { type: 'log' }, axis: null, legend: null, condition: { test: TEST, value: n }, impute: { value: 0 }, band: 0.5, bandPosition: 0.5 })],
  ['number datum', (_f, n) => ({ datum: n })],
  ['quantitative number datum', (_f, n) => ({ datum: n, type: Q })],
  ['nominal number datum', (_f, n) => ({ datum: n, type: 'nominal' })],
  ['ordinal number datum', (_f, n) => ({ datum: n, type: 'ordinal' })],
  ['temporal number datum', (_f, n) => ({ datum: n, type: 'temporal' })],
  ['string datum', () => ({ datum: 'b', type: 'nominal' })],
  ['date-time datum', () => ({ datum: { year: 2020, month: 'mar', date: 1 }, type: 'temporal' })],
  ['datum expression', (_f, n) => ({ datum: { expr: String(n) } })],
  ['datum with a modifier', (_f, n) => ({ datum: n, type: Q, scale: null, axis: null, bandPosition: 0.5 })],
  ['value', (_f, n) => ({ value: n })],
  ['condition with a value, and a value', (_f, n) => ({ condition: { test: TEST, value: n }, value: n + 2 })],
  ['condition with a field', (f, n) => ({ condition: { test: TEST, field: f, type: Q }, value: n })],
]

/**
 * Every definition. (Not here: a field read through a nested or an escaped path, and an `argmax` aggregate. @aster-charts/vl keeps the
 * flattened copy of such a field, and the field an argmax reads, under names of its own on every channel - an x as much as a
 * longitude - so the rows the mark reads differ from vega-lite's by those names alone; everything else compared equal, for 1140 such
 * cases of this space, when it was written.)
 */
export const DEFS = PLAIN

/** The companions a channel is asked beside: what else the unit encodes, and its projection. */
const COMPANIONS: Array<[string, (mark: string) => Obj]> = [
  ['alone', () => ({})],
  ['coloured by k, equalEarth', () => ({ projection: { type: 'equalEarth' }, encoding: { color: { field: 'k', type: 'nominal' } } })],
  [
    'on a pre-binned y, with the second pair',
    () => ({ encoding: { y: { field: 'v', type: Q, bin: 'binned' }, y2: { field: 'v2' }, longitude2: { field: 'lon2', type: Q }, latitude2: { field: 'lat2', type: Q } } }),
  ],
]

/** The unit a mark draws its geographic positions in, beside one companion. */
function unit(mark: string, companion: Obj): Obj {
  const encoding: Obj = { longitude: { field: 'lon', type: Q }, latitude: { field: 'lat', type: Q } }
  if (mark === 'rule') Object.assign(encoding, { longitude2: { field: 'lon2', type: Q }, latitude2: { field: 'lat2', type: Q } })
  if (mark === 'text') encoding.text = { field: 'k', type: 'nominal' }
  return { data: { values: ROWS }, mark, ...companion, encoding: { ...encoding, ...((companion.encoding as Obj | undefined) ?? {}) } }
}

/** Every geographic channel `mark` is given, as every definition, beside every companion. */
export function* geoChannelCases(mark: string): Generator<Case> {
  for (const [cn, companion] of COMPANIONS) {
    const u = unit(mark, companion(mark))
    const enc = u.encoding as Obj
    for (const ch of Object.keys(FIELD).filter((c) => c in enc)) {
      for (const [dn, def] of DEFS) {
        yield [`${mark} ${ch}: ${dn} (${cn})`, { ...u, encoding: { ...enc, [ch]: def(FIELD[ch]!, ch.startsWith('longitude') ? 13 : 23) } }]
      }
    }
  }
}
