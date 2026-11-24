/** The space of animation specs vl-anim-forms.test.ts draws from: a timer selection and a time channel in the forms vega-lite compiles. */
import { pick, stream } from './vl-a16-rng.js'

export const ROWS = [1990, 1991, 1992].flatMap((year, y) => ['a', 'b', 'c'].map((country, c) => ({ year, date: `${year}-06-15`, country, region: c % 2 ? 'w' : 'e', pop: 10 + 7 * c + 3 * y, life: 50 + 4 * c + 2 * y, fert: 5 - c * 0.5 - y * 0.3 })))

export function genSpec(seed: number): Record<string, any> {
  const r = stream(seed)
  const name = pick(r, ['anim', 'play'])
  const timeKind = pick(r, ['ordinal', 'quantitative', 'temporal', 'unit'] as const)
  const timeField = timeKind === 'temporal' || timeKind === 'unit' ? 'date' : 'year'
  const time: Record<string, unknown> = timeKind === 'unit' ? { field: 'date', type: 'temporal', timeUnit: 'year' } : { field: timeField, type: timeKind }
  // (a time unit with an aggregate is a channel-definition question of its own, not an animation's)
  if (timeKind !== 'unit' && r() < 0.15) time.aggregate = pick(r, ['max', 'min', 'mean'] as const)
  const select: Record<string, unknown> = { type: 'point', on: pick(r, ['timer', 'timer{100}', { type: 'timer' }]) }
  // the projection: fields, encodings, both, or (rarely) neither
  const form = pick(r, ['fields', 'fields', 'encodings', 'both', 'encodings-x', 'encodings-xy', 'none'] as const)
  if (form === 'fields' || form === 'both') select.fields = [timeField]
  if (form === 'encodings' || form === 'both') select.encodings = ['time']
  if (form === 'encodings-x') select.encodings = ['x']
  if (form === 'encodings-xy') select.encodings = ['x', 'time']
  if (r() < 0.2) select.toggle = pick(r, [true, false, 'event.shiftKey'] as const)
  if (r() < 0.1) select.nearest = true
  if (r() < 0.1) select.resolve = pick(r, ['union', 'intersect'] as const)
  if (r() < 0.1) select.clear = 'dblclick'
  const param: Record<string, unknown> = { name, select }
  if (r() < 0.15) param.bind = { input: 'checkbox' }
  if (r() < 0.1) param.value = [{ [timeField]: timeField === 'year' ? 1991 : '1991-06-15' }]
  const params: Record<string, unknown>[] = [param]
  if (r() < 0.2) params.push({ name: 'other', select: { type: 'point', on: 'timer', fields: ['country'] } })
  const variable = r() < 0.15 ? [{ name: 'k', value: 3 }] : []
  const mark = pick(r, ['point', 'circle', 'tick', 'text', 'bar', 'line'] as const)
  const xy: Record<string, unknown> = mark === 'bar'
    ? { x: { field: 'country', type: 'nominal' }, y: { field: 'pop', type: 'quantitative' } }
    : mark === 'line'
      ? { x: { field: 'year', type: 'quantitative' }, y: { field: 'pop', type: 'quantitative' }, color: { field: 'country', type: 'nominal' } }
      : { x: { field: 'life', type: 'quantitative' }, y: { field: 'fert', type: 'quantitative' } }
  const withTime = r() < 0.85
  const encoding: Record<string, unknown> = { ...xy, ...(withTime ? { time } : {}) }
  if (mark === 'text') encoding.text = { field: 'country', type: 'nominal' }
  if (mark === 'point' && r() < 0.4) encoding.color = { field: 'region', type: 'nominal' }
  const transform: unknown[] = []
  if (r() < 0.25) transform.push({ filter: 'datum.pop > 9' })
  if (r() < 0.9) transform.push({ filter: r() < 0.2 ? { param: name, empty: false } : { param: name } })
  const unit: Record<string, any> = { params, transform, mark, encoding }
  const base: Record<string, any> = { width: 220, height: 150, data: { values: ROWS } }
  const where = pick(r, ['unit', 'unit', 'layer', 'layer2'] as const)
  // (a variable parameter belongs to the top of the spec; a layer's units take selections only)
  if (where === 'unit') return { ...base, ...unit, params: [...params, ...variable] }
  if (where === 'layer') return { ...base, ...(variable.length ? { params: variable } : {}), layer: [unit] }
  return { ...base, ...(variable.length ? { params: variable } : {}), layer: [unit, { mark: 'rule', encoding: { y: { datum: 7 } } }] }
}

