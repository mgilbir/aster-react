/**
 * A formula that only casts the field it writes (`toNumber(datum.t)` as `t`: what vega-lite writes for a quantitative or temporal field)
 * reads nothing a later run could have changed under it, so the pipeline needs no tuple history (tuple-history.ts `selfCast`): its rows are
 * what a pipeline with the history gives, step after step of a session -- rows replaced, kept, removed, appended -- for every cast and for
 * values the casts treat differently (strings, blanks, dates, nulls, NaN).
 */
import { describe, expect, it } from 'vitest'
import { historyPlan } from './tuple-history.js'
import { datasetsOfScene } from './runtime.js'
import { createChartSession } from './session.js'
import type { CompiledTransform, VgSpec } from './types.js'

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

const VALUES: unknown[] = [5, '7', ' 8 ', '', null, undefined, 'abc', true, false, 'false', '0', new Date(86400000), 1.5e12, '2020-01-02', NaN, 0, -3.5, '1e3']
const castOf = (fn: string, field: string, quoted: boolean): Record<string, unknown> => ({ type: 'formula', as: field, expr: quoted ? `${fn}(datum["${field}"])` : `${fn}(datum.${field})` })

/** The plan a transform list makes. A cast written for a quantitative field is `toNumber`. */
const plan = (t: unknown[]): unknown => historyPlan(t as CompiledTransform[])

describe('the pipelines that need a tuple history', () => {
  it('a cast of the field it writes is not one; a read of what a later step writes, or a formula that changes the value, is', () => {
    for (const fn of ['toNumber', 'toDate', 'toString', 'toBoolean']) {
      expect(plan([castOf(fn, 't', false)]), fn).toBeNull()
      expect(plan([castOf(fn, 't', true)]), `${fn} quoted`).toBeNull()
    }
    // not a cast of its own field, or not only a cast: the history is kept
    expect(plan([{ type: 'formula', as: 't', expr: 'datum.t + 1' }])).not.toBeNull()
    expect(plan([{ type: 'formula', as: 't', expr: 'toNumber(datum.u)' }])).toBeNull() // reads u, writes t: no self read at all
    expect(plan([{ type: 'formula', as: 't', expr: 'toNumber(datum.t) + 1' }])).not.toBeNull()
    expect(plan([{ type: 'formula', as: 't', expr: 'toNumber(datum.t, 1)' }])).not.toBeNull()
    expect(plan([{ type: 'formula', as: 't', expr: 'toNumber(datum.t.x)' }])).not.toBeNull()
    expect(plan([{ type: 'formula', as: 't', expr: 'min(datum.t)' }])).not.toBeNull()
    // an earlier step reads what the cast writes later: the history is kept
    expect(plan([{ type: 'formula', as: 'k', expr: 'datum.t + 1' }, castOf('toNumber', 't', false)])).not.toBeNull()
  })
})

describe('a session over a pipeline of casts gives the rows the history gives', () => {
  const base = (rows: unknown[], transform: unknown[]): VgSpec => ({
    width: 100, height: 60, padding: 0, autosize: 'none',
    data: [{ name: 'd', values: rows, transform }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }],
    marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { value: 5 }, y: { value: 5 } } } }],
  } as unknown as VgSpec)
  const cells = (scene: unknown): string => JSON.stringify((datasetsOfScene(scene as never).get('d') ?? []).map((r) => Object.keys(r as object).sort().map((k) => {
    const v = (r as Record<string, unknown>)[k]
    return [k, v instanceof Date ? `date:${+v}` : typeof v === 'number' && Number.isNaN(v) ? 'NaN' : v]
  })))

  it('over generated rows, for every cast: rows replaced, kept, removed, appended', () => {
    const rnd = lcg(4242)
    let compared = 0
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
    for (let n = 0; n < 40; n++) {
      const fn = pick(['toNumber', 'toDate', 'toString', 'toBoolean'])
      const quoted = rnd() < 0.5
      const cast = castOf(fn, 't', quoted)
      // the same pipeline with a step that reads what it writes and changes it: the history is on, and `t` is cast by the same formula
      const withHistory = [cast, { type: 'formula', as: 'h', expr: 'datum.h == null ? 0 : datum.h' }]
      expect(plan([cast])).toBeNull()
      expect(plan(withHistory)).not.toBeNull()
      let rows = Array.from({ length: 6 }, (_, i) => ({ id: i, t: pick(VALUES) }))
      const plain = createChartSession()
      const kept = createChartSession()
      for (let step = 0; step < 8; step++) {
        const next = rows.slice()
        for (let k = 0; k < 2; k++) if (rnd() < 0.7) next[Math.floor(rnd() * next.length)] = { id: 100 + step * 10 + k, t: pick(VALUES) }
        if (rnd() < 0.3) next.splice(Math.floor(rnd() * next.length), 1)
        if (rnd() < 0.4) next.push({ id: 500 + step, t: pick(VALUES) })
        const a = plain.evaluate(base(next, [cast]), { data: { d: next } })
        const b = kept.evaluate(base(next, withHistory), { data: { d: next } })
        const strip = (text: string): string => JSON.stringify((JSON.parse(text) as Array<Array<[string, unknown]>>).map((r) => r.filter(([k]) => k !== 'h')))
        expect(strip(cells(a)), `${fn} step ${step}`).toBe(strip(cells(b)))
        compared += (JSON.parse(cells(a)) as unknown[]).length
        rows = next
      }
    }
    // (the comparison is of rows, not of two empty lists)
    expect(compared).toBeGreaterThan(1000)
  })
})
