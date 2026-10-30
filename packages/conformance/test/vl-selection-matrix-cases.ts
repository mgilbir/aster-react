/** The specs of the selection matrix (type x binding x resolve x composition); the test compares each against vega-lite 6.4.3. */

const DATA = {
  values: [
    { c: 'A', g: 'p', x: 1, y: 2, v: 5, t: '2001-01-01' },
    { c: 'B', g: 'q', x: 2, y: 4, v: 9, t: '2002-01-01' },
    { c: 'A', g: 'q', x: 3, y: 3, v: 2, t: '2003-01-01' },
    { c: 'C', g: 'p', x: 4, y: 6, v: 7, t: '2004-01-01' },
    { c: 'B', g: 'p', x: 5, y: 5, v: 4, t: '2005-01-01' },
    { c: 'C', g: 'q', x: 6, y: 8, v: 6, t: '2006-01-01' },
  ],
}
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })

type Param = Record<string, any>
type Variant = [name: string, param: Param, encoding?: Record<string, unknown>]

const sel = (select: Record<string, unknown> | string, extra: Record<string, unknown> = {}): Param => ({ name: 'sel', select, ...extra })

const POINT: Variant[] = [
  ['point default', sel('point')],
  ['point object', sel({ type: 'point' })],
  ['point fields', sel({ type: 'point', fields: ['c'] })],
  ['point two fields', sel({ type: 'point', fields: ['c', 'g'] })],
  ['point encodings x', sel({ type: 'point', encodings: ['x'] })],
  ['point encodings x y', sel({ type: 'point', encodings: ['x', 'y'] })],
  ['point encodings color', sel({ type: 'point', encodings: ['color'] })],
  ['point toggle false', sel({ type: 'point', fields: ['c'], toggle: false })],
  ['point toggle expression', sel({ type: 'point', fields: ['c'], toggle: 'event.altKey' })],
  ['point toggle true', sel({ type: 'point', fields: ['c'], toggle: true })],
  ['point nearest', sel({ type: 'point', fields: ['c'], nearest: true })],
  ['point nearest on pointerover', sel({ type: 'point', encodings: ['x'], nearest: true, on: 'pointerover' })],
  ['point on pointerover', sel({ type: 'point', fields: ['c'], on: 'pointerover' })],
  ['point on two streams', sel({ type: 'point', fields: ['c'], on: 'click, pointerover' })],
  ['point clear false', sel({ type: 'point', fields: ['c'], clear: false })],
  ['point clear mouseout', sel({ type: 'point', fields: ['c'], clear: 'pointerout' })],
  ['point toggle false, clear mouseout', sel({ type: 'point', fields: ['c'], toggle: false, clear: 'pointerout' })],
  ['point initial values', sel({ type: 'point', fields: ['c'] }, { value: [{ c: 'A' }, { c: 'B' }] })],
  ['point initial values, two fields', sel({ type: 'point', fields: ['c', 'g'] }, { value: [{ c: 'A', g: 'p' }] })],
  ['point initial encoding values', sel({ type: 'point', encodings: ['x'] }, { value: [{ x: 2 }, { x: 3 }] })],
  ['point initial value inferred', sel({ type: 'point' }, { value: [{ c: 'A' }] })],
  ['point initial datetime', sel({ type: 'point', fields: ['t'] }, { value: [{ t: { year: 2002 } }] })],
  ['point initial scalar', sel({ type: 'point', fields: ['c'] }, { value: 'A' })],
  ['point bound select', sel({ type: 'point', fields: ['c'] }, { bind: { c: { input: 'select', options: ['A', 'B', 'C'] } } })],
  ['point bound select with initial', sel({ type: 'point', fields: ['c'] }, { value: [{ c: 'B' }], bind: { c: { input: 'select', options: ['A', 'B', 'C'] } } })],
  ['point bound range, encoding', sel({ type: 'point', encodings: ['x'] }, { bind: { input: 'range', min: 1, max: 6 } })],
  ['point bound two inputs', sel({ type: 'point', fields: ['c', 'g'] }, { bind: { c: { input: 'select', options: ['A', 'B', 'C'] }, g: { input: 'radio', options: ['p', 'q'] } } })],
  ['point bound input with nearest', sel({ type: 'point', fields: ['c'], nearest: true }, { bind: { c: { input: 'select', options: ['A', 'B', 'C'] } } })],
  ['point bound input, clear', sel({ type: 'point', fields: ['c'], clear: 'pointerout' }, { bind: { c: { input: 'select', options: ['A', 'B', 'C'] } } })],
  ['point bound legend', sel({ type: 'point', fields: ['c'] }, { bind: 'legend' })],
  ['point bound legend, dblclick', sel({ type: 'point', fields: ['c'] }, { bind: { legend: 'dblclick' } })],
  ['point bound legend, on and clear', sel({ type: 'point', fields: ['c'], on: 'pointerover', clear: 'pointerout' }, { bind: 'legend' })],
  ['point bound legend, toggle false', sel({ type: 'point', fields: ['c'], toggle: false }, { bind: 'legend' })],
  ['point bound legend, initial', sel({ type: 'point', fields: ['c'] }, { value: [{ c: 'A' }], bind: 'legend' })],
  ['point bound legend, encoding', sel({ type: 'point', encodings: ['color'] }, { bind: 'legend' })],
  ['point bound legend stream list', sel({ type: 'point', fields: ['c'] }, { bind: { legend: 'click, pointerover' } })],
  ['point bound legend, two fields', sel({ type: 'point', fields: ['c', 'g'] }, { bind: 'legend' })],
]
const RESOLVES = ['global', 'union', 'intersect'] as const
const INTERVAL: Variant[] = [
  ['interval default', sel('interval')],
  ['interval encodings x', sel({ type: 'interval', encodings: ['x'] })],
  ['interval encodings y', sel({ type: 'interval', encodings: ['y'] })],
  ['interval fields', sel({ type: 'interval', fields: ['c'] })],
  ['interval translate false', sel({ type: 'interval', translate: false })],
  ['interval zoom false', sel({ type: 'interval', zoom: false })],
  ['interval translate and zoom false', sel({ type: 'interval', translate: false, zoom: false })],
  ['interval zoom event filter', sel({ type: 'interval', zoom: 'wheel[event.altKey]' })],
  ['interval translate stream', sel({ type: 'interval', translate: '[pointerdown[event.shiftKey], window:pointerup] > window:pointermove!' })],
  ['interval on stream', sel({ type: 'interval', on: '[pointerdown[!event.shiftKey], window:pointerup] > window:pointermove!' })],
  ['interval mark config', sel({ type: 'interval', mark: { fill: 'red', fillOpacity: 0.3, stroke: 'blue', strokeWidth: 2, cursor: 'crosshair' } })],
  ['interval mark config, translate false', sel({ type: 'interval', translate: false, mark: { stroke: 'red', strokeDash: [3, 3] } })],
  ['interval clear false', sel({ type: 'interval', clear: false })],
  ['interval clear escape', sel({ type: 'interval', clear: 'keydown[event.key === "Escape"]' })],
  ['interval initial x', sel({ type: 'interval', encodings: ['x'] }, { value: { x: [2, 4] } })],
  ['interval initial x y', sel({ type: 'interval' }, { value: { x: [2, 4], y: [3, 6] } })],
  ['interval initial y', sel({ type: 'interval', encodings: ['y'] }, { value: { y: [3, 6] } })],
  ['interval initial inferred', sel({ type: 'interval' }, { value: { x: [1, 3] } })],
  ['interval bound scales', sel({ type: 'interval' }, { bind: 'scales' })],
  ['interval bound scales x', sel({ type: 'interval', encodings: ['x'] }, { bind: 'scales' })],
  ['interval bound scales y', sel({ type: 'interval', encodings: ['y'] }, { bind: 'scales' })],
  ['interval bound scales, translate false', sel({ type: 'interval', translate: false }, { bind: 'scales' })],
  ['interval bound scales, zoom false', sel({ type: 'interval', zoom: false }, { bind: 'scales' })],
  ['interval bound scales, zoom stream', sel({ type: 'interval', zoom: 'wheel[event.altKey]' }, { bind: 'scales' })],
  ['interval bound scales, clear', sel({ type: 'interval', clear: 'dblclick' }, { bind: 'scales' })],
  ['interval bound scales, initial', sel({ type: 'interval', encodings: ['x'] }, { value: { x: [2, 4] }, bind: 'scales' })],
]
const SCALES: Array<[string, Record<string, unknown>]> = [
  ['log', { type: 'log' }],
  ['pow', { type: 'pow', exponent: 2 }],
  ['sqrt', { type: 'sqrt' }],
  ['symlog', { type: 'symlog', constant: 3 }],
  ['reversed', { reverse: true }],
  ['domain', { domain: [0, 10] }],
]

const UNIT_ENCODING = (extra: Record<string, unknown> = {}) => ({
  x: q('x'),
  y: q('y'),
  color: { condition: { param: 'sel', field: 'c', type: 'nominal' }, value: 'grey' },
  ...extra,
})
const withEnc = (v: Variant, enc: Record<string, unknown> | undefined) => ({ ...UNIT_ENCODING(), ...(enc ?? {}) })

type Composer = (param: Param, resolve: string | undefined, mark?: string, enc?: Record<string, unknown>, scaleX?: Record<string, unknown>) => Record<string, any>
const withResolve = (p: Param, resolve: string | undefined): Param => (resolve && typeof p.select === 'object' ? { ...p, select: { ...p.select, resolve } } : resolve ? { ...p, select: { type: p.select, resolve } } : p)
const COMPOSERS: Array<[string, Composer]> = [
  ['unit', (p, r, mark = 'point', enc, sx) => ({ data: DATA, params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(sx ? { x: q('x', { scale: sx }) } : {}), ...(enc ?? {}) } })],
  ['layer', (p, r, mark = 'point', enc) => ({ data: DATA, layer: [{ params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] })],
  ['layer, selection on the second', (p, r, mark = 'point', enc) => ({ data: DATA, layer: [{ mark: 'line', encoding: { x: q('x'), y: q('y') } }, { params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } }] })],
  ['hconcat', (p, r, mark = 'point', enc) => ({ data: DATA, hconcat: [{ params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } }, { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }] })],
  ['vconcat of two selections', (p, r, mark = 'point', enc) => ({ data: DATA, vconcat: [{ params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } }, { params: [withResolve({ ...p, name: 'sel' }, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}), y: q('v') } }] })],
  ['column facet', (p, r, mark = 'point', enc) => ({ data: DATA, facet: { column: n('g') }, spec: { params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } } })],
  ['row and column facet', (p, r, mark = 'point', enc) => ({ data: DATA, facet: { row: n('g'), column: n('c') }, spec: { params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } } })],
  ['repeat', (p, r, mark = 'point', enc) => ({ data: DATA, repeat: { column: ['y', 'v'] }, spec: { params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), y: q('y', { field: { repeat: 'column' } } as never), ...(enc ?? {}) } } })],
  ['facet of layers', (p, r, mark = 'point', enc) => ({ data: DATA, facet: { column: n('g') }, spec: { layer: [{ params: [withResolve(p, r)], mark, encoding: { ...UNIT_ENCODING(), ...(enc ?? {}) } }, { mark: 'rule', encoding: { y: q('y', { aggregate: 'mean' }) } }] } })],
]


export type Cases = Array<[name: string, spec: Record<string, any>]>
/** Every group of cases, in order. */
export const GROUPS: Array<[title: string, cases: Cases]> = []
function group(title: string, body: (add: (name: string, spec: Record<string, any>) => void) => void): void {
  const cases: Cases = []
  body((name, spec) => cases.push([name, spec]))
  GROUPS.push([title, cases])
}

group('@aster/vl == vega-lite: point selections, every option x composition', (add) => {
  for (const [cname, compose] of COMPOSERS) {
    for (const [vname, param, enc] of POINT) {
      add(`${vname} in a ${cname}`, compose(param, undefined, 'point', enc))
    }
  }
})

group('@aster/vl == vega-lite: interval selections, every option x composition', (add) => {
  for (const [cname, compose] of COMPOSERS) {
    for (const [vname, param, enc] of INTERVAL) {
      add(`${vname} in a ${cname}`, compose(param, undefined, 'point', enc))
    }
  }
})

group('@aster/vl == vega-lite: resolve x type x composition', (add) => {
  const CASES: Variant[] = [
    ['point', sel({ type: 'point', fields: ['c'] })],
    ['point, no toggle', sel({ type: 'point', fields: ['c'], toggle: false })],
    ['point by id', sel({ type: 'point' })],
    ['point nearest', sel({ type: 'point', encodings: ['x'], nearest: true })],
    ['interval', sel({ type: 'interval' })],
    ['interval x', sel({ type: 'interval', encodings: ['x'] })],
  ]
  for (const [cname, compose] of COMPOSERS) {
    for (const [vname, param, enc] of CASES) {
      for (const resolve of RESOLVES) add(`${vname}, resolve ${resolve}, in a ${cname}`, compose(param, resolve, 'point', enc))
    }
  }
})

group('@aster/vl == vega-lite: interval translate / zoom / scale binding over each scale type', (add) => {
  const INTERVALS: Variant[] = [
    ['interval', sel({ type: 'interval' })],
    ['interval x', sel({ type: 'interval', encodings: ['x'] })],
    ['bound scales', sel({ type: 'interval' }, { bind: 'scales' })],
    ['bound scales x', sel({ type: 'interval', encodings: ['x'] }, { bind: 'scales' })],
    ['interval with an initial value', sel({ type: 'interval', encodings: ['x'] }, { value: { x: [2, 4] } })],
  ]
  for (const [sname, scale] of SCALES) {
    for (const [vname, param] of INTERVALS) {
      for (const [cname, compose] of [COMPOSERS[0]!, COMPOSERS[3]!, COMPOSERS[5]!]) {
        add(`${vname}, x scale ${sname}, in a ${cname}`, compose(param, undefined, 'point', { y: q('y', { scale: sname === 'log' ? {} : scale }) }, scale))
      }
    }
  }
  add('an interval over a time scale', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] })], mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: q('y') } })
  add('bound scales over a time scale', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] }, { bind: 'scales' })], mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: q('y') } })
  add('an interval over a band scale', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] })], mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } })
  add('an interval over a binned x', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] })], mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } })
  add('an interval over a time unit', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] })], mark: 'point', encoding: { x: { field: 't', type: 'temporal', timeUnit: 'year' }, y: q('y') } })
  add('a point selection over a binned x', { data: DATA, params: [sel({ type: 'point', encodings: ['x'] })], mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' }, color: { condition: { param: 'sel', value: 'red' }, value: 'grey' } } })
  add('a point selection over a time unit', { data: DATA, params: [sel({ type: 'point', encodings: ['x'] })], mark: 'point', encoding: { x: { field: 't', type: 'temporal', timeUnit: 'year' }, y: q('y'), color: { condition: { param: 'sel', value: 'red' }, value: 'grey' } } })
})

group('@aster/vl == vega-lite: the marks a selection is used on', (add) => {
  const MARKS = ['point', 'bar', 'line', 'area', 'tick', 'circle', 'square', 'text', 'rule', 'trail'] as const
  const VARIANTS: Variant[] = [
    ['point', sel({ type: 'point', fields: ['c'] })],
    ['nearest', sel({ type: 'point', encodings: ['x'], nearest: true })],
    ['interval', sel({ type: 'interval' })],
  ]
  for (const mark of MARKS) {
    for (const [vname, param] of VARIANTS) {
      add(`${vname} on a ${mark}`, { data: DATA, params: [param], mark, encoding: { ...UNIT_ENCODING(), ...(mark === 'text' ? { text: n('c') } : {}) } })
    }
  }
})

group('@aster/vl == vega-lite: a selection used by a filter, an opacity and a scale domain', (add) => {
  const P = (extra: Record<string, unknown> = {}) => sel({ type: 'interval', encodings: ['x'], ...extra })
  const CASES: Array<[string, Record<string, any>]> = [
    ['a filter on a selection', { data: DATA, params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') }, transform: [{ filter: { param: 'sel' } }] }],
    ['a filter on an empty-false selection', { data: DATA, params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') }, transform: [{ filter: { param: 'sel', empty: false } }] }],
    ['a condition with empty false', { data: DATA, params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', empty: false, value: 'red' }, value: 'grey' } } }],
    ['a size condition and a text condition', { data: DATA, params: [sel({ type: 'point', fields: ['c'] })], mark: 'text', encoding: { x: q('x'), y: q('y'), text: n('c'), size: { condition: { param: 'sel', value: 20 }, value: 10 } } }],
    ['a layer filtered by a selection of another layer', { data: DATA, layer: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { transform: [{ filter: { param: 'sel' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { value: 'red' } } }] }],
    ['a scale domain from a selection in a vconcat', { data: DATA, vconcat: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x', { scale: { domain: { param: 'sel' } } }), y: q('y') } }] }],
    ['a scale domain from a selection with a field', { data: DATA, vconcat: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x', { scale: { domain: { param: 'sel', encoding: 'x' } } }), y: q('y') } }] }],
    ['a scale domain from a selection with a field name', { data: DATA, vconcat: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x', { scale: { domain: { param: 'sel', field: 'x' } } }), y: q('y') } }] }],
    ['a bin extent from a selection', { data: DATA, vconcat: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'bar', encoding: { x: q('x', { bin: { extent: { param: 'sel' } } }), y: { aggregate: 'count' } } }] }],
    ['a reversed domain from a selection', { data: DATA, vconcat: [{ params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x', { scale: { domain: { param: 'sel' }, reverse: true } }), y: q('y') } }] }],
    ['a selection in a layer and an overview in a vconcat (interactive_layered_crossfilter shape)', { data: DATA, vconcat: [{ layer: [{ params: [P()], mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }, { mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' }, color: { value: 'red' } }, transform: [{ filter: { param: 'sel' } }] }] }] }],
    ['two selections', { data: DATA, params: [sel({ type: 'point', fields: ['c'] }), { name: 'brush', select: { type: 'interval' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', field: 'c', type: 'nominal' }, value: 'grey' }, size: { condition: { param: 'brush', value: 100 }, value: 30 } } }],
    ['two intervals', { data: DATA, params: [sel({ type: 'interval', encodings: ['x'] }), { name: 'brush', select: { type: 'interval', encodings: ['y'] } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', value: 'red' }, value: 'grey' }, size: { condition: { param: 'brush', value: 100 }, value: 30 } } }],
    ['a point and a legend-bound point', { data: DATA, params: [sel({ type: 'point', fields: ['c'] }, { bind: 'legend' }), { name: 'other', select: { type: 'point', fields: ['g'] } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', field: 'c', type: 'nominal' }, value: 'grey' }, shape: { condition: { param: 'other', field: 'g', type: 'nominal' }, value: 'square' } } }],
    ['a composite condition (and)', { data: DATA, params: [sel({ type: 'point', fields: ['c'] }), { name: 'brush', select: { type: 'interval' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', field: 'c', type: 'nominal' }, value: 'grey' }, opacity: { condition: { test: { and: [{ param: 'sel' }, { param: 'brush' }] }, value: 1 }, value: 0.2 } } }],
    ['a composite condition (or, not)', { data: DATA, params: [sel({ type: 'point', fields: ['c'] }), { name: 'brush', select: { type: 'interval' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), opacity: { condition: { test: { or: [{ param: 'sel' }, { not: { param: 'brush' } }] }, value: 1 }, value: 0.2 } } }],
    ['a variable parameter next to a selection', { data: DATA, params: [{ name: 'k', value: 3 }, sel({ type: 'point', fields: ['c'] })], mark: 'point', encoding: { x: q('x'), y: q('y'), size: { condition: { param: 'sel', value: 100 }, value: 10 }, opacity: { condition: { test: 'datum.x > k', value: 1 }, value: 0.3 } } }],
    ['a selection param in a filter inside a facet', { data: DATA, facet: { column: n('g') }, spec: { params: [P()], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', value: 'red' }, value: 'grey' } } } }],
    ['a selection in a facet used in a layer sibling', { data: DATA, facet: { column: n('g') }, spec: { layer: [{ params: [sel({ type: 'point', fields: ['c'] })], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', transform: [{ filter: { param: 'sel' } }], encoding: { x: q('x'), y: q('y') } }] } }],
    ['a top-level config.selection', { data: DATA, config: { selection: { interval: { mark: { fill: 'red' }, clear: false }, point: { toggle: false, on: 'pointerover' } } }, params: [P(), { name: 'pt', select: 'point' }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'pt', value: 'red' }, value: 'grey' } } }],
  ]
  for (const [name, spec] of CASES) add(name, spec)
})
