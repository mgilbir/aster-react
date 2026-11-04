/**
 * The paint space: a `fill` or a `stroke` channel on every mark, filled and unfilled (by default, by the mark, by the config), as a
 * field, a datum, a value and a condition, alone and with a `color` or the other paint channel beside it; the config and mark-def
 * colours they fall back on; and layers whose paint channels share one field. vega-lite 6.4.3 drops `color` when the channel it would
 * write (fill on a filled mark, stroke on an unfilled one) is encoded, and otherwise gives every paint channel a scale and a legend of
 * its own, merged when the fields are the same.
 */
type Obj = Record<string, unknown>
type Case = [string, Obj]

/** Small squares, so that a geoshape draws them; the same rows carry the fields every other mark reads. */
const square = (x: number, y: number): Obj => ({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] })
const ROWS: Obj[] = [
  { k: 'a', v: 1, w: 2, n: 1, c: '#e45756' },
  { k: 'b', v: 2, w: 5, n: null, c: '#54a24b' },
  { k: 'c', v: 3, w: 3, n: 3, c: '#b279a2' },
  { k: 'a', v: 4, w: 1, n: 2, c: '#e45756' },
]
const DATA = { values: ROWS }
const GEO_DATA = { values: ROWS.map((r, i) => ({ type: 'Feature', geometry: square(i * 2, i % 2), ...r })) }

const K = { field: 'k', type: 'nominal' }
const V = { field: 'v', type: 'quantitative' }
const W = { field: 'w', type: 'quantitative' }

export const PAINT_MARKS = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'rule', 'line', 'area', 'trail', 'text', 'arc', 'geoshape'] as const

/** The data and the rest of the encoding a mark needs to draw. */
function around(mark: string): { data: Obj; encoding: Obj; extra: Obj } {
  switch (mark) {
    case 'arc': return { data: DATA, encoding: { theta: V }, extra: {} }
    case 'geoshape': return { data: GEO_DATA, encoding: {}, extra: { projection: { type: 'identity' } } }
    case 'text': return { data: DATA, encoding: { x: V, y: W, text: K }, extra: {} }
    case 'rect': return { data: DATA, encoding: { x: K, y: { field: 'w', type: 'ordinal' } }, extra: {} }
    case 'bar': return { data: DATA, encoding: { x: K, y: V }, extra: {} }
    default: return { data: DATA, encoding: { x: V, y: W }, extra: {} }
  }
}

/** How the mark comes to be filled or not. */
const FILLED: Array<[string, (mark: string) => { mark: unknown; config?: Obj }]> = [
  ['default', (m) => ({ mark: m })],
  ['mark filled', (m) => ({ mark: { type: m, filled: true } })],
  ['mark unfilled', (m) => ({ mark: { type: m, filled: false } })],
  ['config.mark unfilled', (m) => ({ mark: m, config: { mark: { filled: false } } })],
  ['config.<mark> filled', (m) => ({ mark: m, config: { [m]: { filled: true } } })],
]

/** A paint channel as each kind of definition. */
const DEFS: Array<[string, Obj]> = [
  ['nominal field', K],
  ['quantitative field', V],
  ['datum', { datum: 'a', type: 'nominal' }],
  ['value', { value: '#f58518' }],
  ['condition value', { condition: { test: 'datum.v > 1', value: '#f58518' }, value: '#72b7b2' }],
  ['condition field', { condition: { test: 'datum.v > 1', field: 'k', type: 'nominal' }, value: '#72b7b2' }],
  ['condition only', { condition: { test: 'datum.v > 1', value: '#f58518' } }],
  ['condition datum', { condition: { test: 'datum.v > 1', datum: 'b' }, value: '#72b7b2' }],
  ['no legend', { ...V, legend: null }],
  ['quantitative field with a null', { field: 'n', type: 'quantitative' }],
  ['colour field read as it is', { field: 'c', type: 'nominal', scale: null }],
]

const other = (ch: 'fill' | 'stroke'): 'fill' | 'stroke' => (ch === 'fill' ? 'stroke' : 'fill')

/** What else the encoding paints with. */
const COMPANIONS: Array<[string, (ch: 'fill' | 'stroke') => Obj, ((mark: string) => boolean)?]> = [
  ['alone', () => ({})],
  ['color on the same field', () => ({ color: K })],
  ['color on another field', () => ({ color: W })],
  ['color value', () => ({ color: { value: '#4c78a8' } })],
  ['the other paint on the same field', (ch) => ({ [other(ch)]: K })],
  ['the other paint on another field', (ch) => ({ [other(ch)]: W })],
  // (a discrete and a continuous scale over one field keep a legend each; two of the same kind share one)
  ['the other paint on field v as ordinal', (ch) => ({ [other(ch)]: { field: 'v', type: 'ordinal' } })],
  ['color and the other paint', (ch) => ({ color: K, [other(ch)]: W })],
  ['a size legend beside', () => ({ size: W })],
  // (on a geoshape the shape channel carries the geometry: a shape field there is refused, packages/vl/README.md "Throws")
  ['a shape legend on the same field', () => ({ shape: K }), (mark) => mark !== 'geoshape'],
]

/** Every paint channel on `mark`: each way of being filled, each kind of definition, each companion. */
export function* paintCases(mark: string): Generator<Case> {
  const base = around(mark)
  for (const [fn, filled] of FILLED) {
    const f = filled(mark)
    for (const ch of ['fill', 'stroke'] as const) {
      for (const [dn, def] of DEFS) {
        for (const [cn, companion, applies] of COMPANIONS) {
          if (applies && !applies(mark)) continue
          const spec = { data: base.data, ...base.extra, mark: f.mark, encoding: { ...base.encoding, ...companion(ch), [ch]: def }, ...(f.config ? { config: f.config } : {}) }
          yield [`${mark} (${fn}) ${ch} ${dn}, ${cn}`, spec]
        }
      }
    }
  }
}

/** The colours a paint channel falls back on: the config's and the mark def's, with and without a colour beside it. */
export function* paintDefaultCases(): Generator<Case> {
  const DEFAULTS: Array<[string, (mark: string) => { mark: unknown; config?: Obj }]> = [
    ['config.mark.color', (m) => ({ mark: m, config: { mark: { color: '#9d755d' } } })],
    ['config.<mark>.fill', (m) => ({ mark: m, config: { [m]: { fill: '#9d755d' } } })],
    ['config.<mark>.stroke', (m) => ({ mark: m, config: { [m]: { stroke: '#9d755d' } } })],
    ['config.mark fill and stroke', (m) => ({ mark: m, config: { mark: { fill: '#9d755d', stroke: '#bab0ac' } } })],
    ['mark color', (m) => ({ mark: { type: m, color: '#9d755d' } })],
    ['mark fill and stroke', (m) => ({ mark: { type: m, fill: '#9d755d', stroke: '#bab0ac' } })],
    ['mark color, unfilled', (m) => ({ mark: { type: m, color: '#9d755d', filled: false } })],
  ]
  const DEFS2 = DEFS.filter(([n]) => ['nominal field', 'value', 'condition only', 'condition field'].includes(n))
  for (const mark of PAINT_MARKS) {
    const base = around(mark)
    for (const [dn0, make] of DEFAULTS) {
      const d = make(mark)
      for (const ch of ['fill', 'stroke'] as const) {
        for (const [dn, def] of DEFS2) {
          for (const [cn, companion] of [['alone', {}], ['color field', { color: W }]] as Array<[string, Obj]>) {
            const spec = { data: base.data, ...base.extra, mark: d.mark, encoding: { ...base.encoding, ...companion, [ch]: def }, ...(d.config ? { config: d.config } : {}) }
            yield [`${mark} (${dn0}) ${ch} ${dn}, ${cn}`, spec]
          }
        }
      }
    }
  }
}

/** Layers whose paint channels read one field or several: the shared scales and the legends they merge into. */
export function* paintLayerCases(): Generator<Case> {
  const PAINTS: Array<[string, Obj]> = [
    ['color k', { color: K }],
    ['fill k', { fill: K }],
    ['stroke k', { stroke: K }],
    ['fill v', { fill: V }],
    ['color k + stroke v', { color: K, stroke: V }],
  ]
  const MARKS2 = ['point', 'bar', 'line', 'circle']
  for (const m1 of MARKS2) {
    for (const m2 of MARKS2) {
      for (const [p1, e1] of PAINTS) {
        for (const [p2, e2] of PAINTS) {
          const pos = m1 === 'bar' || m2 === 'bar' ? { x: K, y: V } : { x: V, y: W }
          yield [`layer ${m1} ${p1} / ${m2} ${p2}`, { data: DATA, layer: [{ mark: m1, encoding: { ...pos, ...e1 } }, { mark: m2, encoding: { ...pos, ...e2 } }] }]
        }
      }
    }
  }
}
