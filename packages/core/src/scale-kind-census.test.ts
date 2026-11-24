/**
 * The domain census (runtime.ts: a scale over one field of one dataset is kept when a pulse proves its domain unchanged) applies to
 * the scale types by the kind of domain the registry gives them (`fieldDomainKind`), not by a hand list (C549): the numeric extent
 * for every type that is neither discrete nor quantile (identity, linear, log, pow, sqrt, symlog, time, utc, sequential, quantize,
 * threshold), the categories for every discrete one (ordinal, band, point, bin-ordinal), none for quantile.
 *
 * Generated walks: every type, rows edited in place (with `dataChanges`), appended (with `dataPulse`), or replaced, through a
 * session; at each step the session's scene and scale equal a fresh evaluation's, and the scale is kept exactly when the fresh
 * scale's domain is the step before's (and with an edit or an append, it is kept then).
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import { fieldDomainKind } from './scales.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>
type ScaleFn = ((x: unknown) => unknown) & { domain(): unknown[] }

const TYPES = ['identity', 'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize', 'threshold', 'quantile', 'ordinal', 'band', 'point', 'bin-ordinal']

const scaleOf = (scene: SceneRoot): ScaleFn => (scene as unknown as { __scaleMap: Map<string, ScaleFn> }).__scaleMap.get('s')!

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function chart(type: string): VgSpec {
  const discrete = fieldDomainKind(type) === 'categories'
  const colour = !['identity', 'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'band', 'point'].includes(type)
  return {
    width: 200, height: 100,
    data: [{ name: 't' }],
    scales: [{ name: 's', type, domain: { data: 't', field: discrete ? 'c' : 'v' }, range: colour ? ['red', 'green', 'blue'] : 'width' } as never],
    marks: [{
      type: 'rect', from: { data: 't' },
      encode: { update: colour ? { x: { field: 'v' }, width: { value: 2 }, height: { value: 2 }, fill: { scale: 's', field: discrete ? 'c' : 'v' } } : { x: { scale: 's', field: discrete ? 'c' : 'v' }, width: { value: 2 }, height: { value: 2 } } },
    }],
  }
}

describe('the domain census follows the registry kinds of every scale type', () => {
  it('kinds', () => {
    expect(TYPES.filter((t) => fieldDomainKind(t) === 'extent')).toEqual(['identity', 'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize', 'threshold'])
    expect(TYPES.filter((t) => fieldDomainKind(t) === 'categories')).toEqual(['ordinal', 'band', 'point', 'bin-ordinal'])
    expect(fieldDomainKind('quantile')).toBe('values')
    expect(fieldDomainKind('BAND')).toBeUndefined()
  })

  for (const type of TYPES) {
    it(`${type}: a session equals a fresh evaluation, and keeps the scale exactly when its domain holds`, () => {
      const random = rng(0x549 + type.length * 31 + type.charCodeAt(0))
      const spec = chart(type)
      const value = (): number => 1 + Math.floor(random() * 40)
      const row = (): Row => ({ v: value(), c: ['a', 'b', 'c', 'd'][Math.floor(random() * 4)] })
      let rows: Row[] = Array.from({ length: 12 }, row)
      const session = createChartSession()
      let prev = session.evaluate(spec, { data: { t: rows } })
      let kept = 0
      let provable = 0
      for (let step = 0; step < 40; step++) {
        const kind = Math.floor(random() * 3)
        let next: Row[]
        let hints: Partial<RuntimeInput> = {}
        if (kind === 0) {
          // edit a row in place: inside the extent / an existing category most of the time
          const i = Math.floor(random() * rows.length)
          next = rows.slice()
          next[i] = random() < 0.8 ? { v: 2 + Math.floor(random() * 30), c: rows[Math.floor(random() * rows.length)]!.c } : row()
          hints = { dataChanges: { t: [i] } }
        } else if (kind === 1) {
          next = [...rows, random() < 0.8 ? { v: 2 + Math.floor(random() * 30), c: rows[0]!.c } : row()]
          hints = { dataPulse: { t: { changed: [], appendOnly: true, baseLength: rows.length, added: [[rows.length, rows.length + 1]] } } }
        } else {
          next = Array.from({ length: 8 + Math.floor(random() * 8) }, row)
        }
        const scene = session.evaluate(spec, { data: { t: next }, ...hints })
        const fresh = evaluateChart(compileChart(spec), { data: { t: next } })
        expect(renderSceneToSvg(scene), `${type} step ${step}`).toBe(renderSceneToSvg(fresh))
        const sameDomain = JSON.stringify(scaleOf(fresh).domain()) === JSON.stringify(scaleOf(prev).domain())
        const isKept = scaleOf(scene) === scaleOf(prev)
        expect(JSON.stringify(scaleOf(scene).domain()), `${type} step ${step}`).toBe(JSON.stringify(scaleOf(fresh).domain()))
        if (isKept) {
          kept++
          expect(sameDomain, `${type} step ${step}: kept a scale whose domain moved`).toBe(true)
        }
        if (sameDomain && kind !== 2 && fieldDomainKind(type) !== 'values') provable++
        prev = scene
        rows = next
      }
      // a census (or the settings) proved the domain unchanged on an edit or an append that left it so
      if (provable > 0) expect(kept, type).toBeGreaterThan(0)
    })
  }
})
