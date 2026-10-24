/**
 * LIVE differential for the d3-interpolate table `vega-scale`'s `interpolate(type, gamma)`
 * reads: every case builds the interpolator in real Vega and in Aster (same process, same
 * engine) and compares the values at the `T` positions exactly. See `differential-util.mts`
 * for why nothing is recorded. (`hcl`/`cubehelix`/`zoom`/gamma go through pow, trig and
 * atan2, the very functions that differ between V8 versions.)
 * `interpolate('hcl')` used to be undefined in Aster (audit C95).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { interpolate } from '../../core/src/scale.ts'
import { attempt } from './differential-util.mts'
import { cases, T } from './interpolate-cases.mjs'

type Interp = (...a: unknown[]) => ((t: number) => unknown) & { duration?: number }

function evaluate(make: (name: string, gamma?: number) => unknown, c: (typeof cases)[number]): unknown {
  return attempt(() => {
    const f = make(c.name, c.gamma) as Interp
    const g = f(...structuredClone(c.args))
    const r = T.map((t) => g(t))
    return c.name === 'zoom' ? { v: r, duration: g.duration } : r
  })
}

describe(`interpolator table vs vega@${vega.version} (live)`, () => {
  for (const [i, c] of cases.entries()) {
    it(`${i} ${c.name || '(generic)'}${c.gamma != null ? ` gamma ${c.gamma}` : ''} ${JSON.stringify(c.args).slice(0, 60)}`, () => {
      const want = evaluate(vega.interpolate as never, c)
      expect(evaluate(interpolate as never, c)).toEqual(want)
    })
  }
  it('covers the whole case list', () => {
    expect(cases.length).toBeGreaterThanOrEqual(231)
  })
})
