// @vitest-environment node
/**
 * A selection's store seeded with a tuple, in vega-lite's output and in @aster-charts/vl's, run by real vega (audit C69, C264). The gallery
 * draws a selection's first frame only, where the store is empty and every datum passes: a filter that is in the wrong place (before the
 * bins, in the examples that crossfilter) passes there too. Here the store holds a brush, and each view is drawn again.
 *
 * The shape is the gallery's `interactive_crossfilter` - a repeat of a layer, the second layer filtered by the brush and binned over a
 * repeated field - and the units it is made of, over generated rows and generated brushes (inside the data, on its ends, reversed, past
 * it, empty).
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import { compile } from '@aster-charts/vl'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { oracleOf, pick, plain, stream } from './vl-a16-helpers.js'

function rowsOf(seed: number): Array<Record<string, number>> {
  const r = stream(seed)
  return Array.from({ length: 90 }, () => ({ delay: Math.round(r() * 120 - 30), distance: Math.round(r() * 4400 + 100), time: Math.round(r() * 240) / 10 }))
}

const bar = (field: unknown, extra: Record<string, unknown> = {}) => ({ mark: 'bar', encoding: { x: { field, bin: { maxbins: 20 }, type: 'quantitative' }, y: { aggregate: 'count', type: 'quantitative' }, ...extra } })

/** The shapes: the gallery's crossfilter, and the pieces it is made of. */
function shapes(data: unknown): Array<[string, Record<string, any>, string[]]> {
  const brush = { name: 'brush', select: { type: 'interval', encodings: ['x'] } }
  const filtered = (field: unknown) => ({ params: [brush], transform: [{ filter: { param: 'brush' } }], ...bar(field, { color: { value: '#f58518' } }) })
  return [
    ['a repeat of a layer, the brushed layer last (interactive_crossfilter)', { data, repeat: { column: ['distance', 'delay'] }, spec: { layer: [{ ...bar({ repeat: 'column' }), encoding: { ...bar({ repeat: 'column' }).encoding, color: { value: '#ddd' } } }, filtered({ repeat: 'column' })] } }, ['distance', 'delay']],
    ['a repeat of a layer, the brushed layer first', { data, repeat: { column: ['distance', 'delay'] }, spec: { layer: [filtered({ repeat: 'column' }), bar({ repeat: 'column' })] } }, ['distance', 'delay']],
    ['a layer of one filtered, binned unit', { data, layer: [filtered('distance')] }, ['distance']],
    ['a layer, the brushed unit last', { data, layer: [bar('distance'), filtered('distance')] }, ['distance']],
    ['a unit with its own brush and filter', { data, ...filtered('delay') }, ['delay']],
    ['a filter by a transform before the bin of a layer', { data, layer: [{ transform: [{ filter: 'datum.distance > 1285.9 && datum.distance < 2504.8' }], ...bar('distance') }] }, []],
  ]
}

/** The names of the units a spec's `brush` tuples are written under: each `brush_tuple` signal's `unit: "..."`. */
function unitsOf(vg: Record<string, any>): string[] {
  const out: string[] = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o === null || typeof o !== 'object') return
    const r = o as Record<string, any>
    if (r.name === 'brush_tuple' && Array.isArray(r.on)) for (const h of r.on) { const m = /unit: ("(?:[^"\\]|\\.)*")/.exec(String(h.update)); if (m) out.push(JSON.parse(m[1]!)) }
    for (const v of Object.values(r)) if (v !== null && typeof v === 'object') walk(v)
  }
  walk(vg)
  return out
}

async function drawWith(vg: Record<string, unknown>, tuples: unknown[]): Promise<string> {
  const view = new vega.View(vega.parse(plain(vg) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    view.finalize()
    if (tuples.length) {
      view.change('brush_store', view.changeset().remove(() => true).insert(plain(tuples) as never))
      await view.runAsync()
    }
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

describe('a brushed store draws what vega-lite draws', () => {
  for (let seed = 0; seed < 12; seed++) {
    const rows = rowsOf(7000 + seed)
    const r = stream(900 + seed)
    for (const [name, spec, fields] of shapes({ values: rows })) {
      it(`seed ${seed}: ${name}`, async () => {
        const oracle = oracleOf(spec)
        expect('vega' in oracle, 'vega-lite compiles the shape').toBe(true)
        const ours = compile(plain(spec) as never) as Record<string, any>
        const vlUnits = unitsOf((oracle as { vega: Record<string, any> }).vega)
        expect(unitsOf(ours), 'the units the brush is written under').toEqual(vlUnits)
        // a brush over each stored field: between two values of the column, on its ends, reversed, wider than the data, empty
        for (const field of fields) {
          const col = rows.map((x) => x[field]!).sort((a, b) => a - b)
          const at = (): number => col[Math.floor(r() * col.length)]!
          const brushes: Array<[number, number]> = [[at(), at()], [col[0]!, at()], [at(), col[col.length - 1]!], [col[0]! - 1000, col[col.length - 1]! + 1000], [at(), at()].sort((a, b) => b - a) as [number, number], [col[3]!, col[3]!]]
          for (const range of brushes) {
            const tuples = vlUnits.map((unit) => ({ unit, fields: [{ field, channel: 'x', type: 'R' }], values: [range] }))
            const [a, b] = await Promise.all([drawWith((oracle as { vega: Record<string, any> }).vega, tuples), drawWith(ours, tuples)])
            expect(diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b)), `${field} ${JSON.stringify(range)}`).toEqual([])
          }
        }
      }, 60_000)
    }
  }
})

void pick
