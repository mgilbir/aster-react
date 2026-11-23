/**
 * GENERATED live differential of a log scale's ticks and tick labels over WHOLE BASES of every size (C96), against the pinned
 * vega-scale (d3-scale's log ticks), in one process. Aster skips the multiples of a power below the domain by a search instead of
 * one at a time, and counts what it keeps against the built-in item ceiling: for every case d3 answers with at most that many
 * ticks the two must be equal, tick for tick and label for label; past it Aster must refuse with an AsterLimitError.
 *
 * What is drawn: bases from 2 to 10^6 (and fractional ones, which take the other path), domains positive and negative, reversed,
 * across many powers, inside one power, and hugging a power from below; tick counts from 1 to 50.
 */
import * as vegaScale from 'vega-scale'
import { describe, expect, it, vi } from 'vitest'
import * as asterScale from '../../core/src/scale.ts'
import { AsterLimitError, HARD_CAPS } from '../../core/src/limits.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 300_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASES = [2, 3, 7, 10, 12, 16, 60, 100, 1000, 1e4, 1e5, 1e6, 2.5, Math.E, 1.5]

function genDomain(r: Rng, base: number): number[] {
  const p = (e: number): number => Math.pow(base, e)
  let lo: number
  let hi: number
  switch (r.int(5)) {
    case 0: lo = p(r.between(-3, 2)) * (1 + r.int(5)); hi = lo * p(r.between(0, 4)) * (1 + r.int(base > 100 ? 3 : 9)); break
    case 1: { const e = r.between(-2, 4); lo = p(e) * (1 - Math.pow(10, -r.between(1, 6))); hi = p(e); break }
    case 2: { const e = r.between(-2, 3); lo = p(e) * (1 + r.int(Math.min(base - 1, 50))); hi = lo + p(e) * r.between(1, 3); break }
    case 3: lo = r.pick([1, 0.001, 5]); hi = lo * Math.pow(10, r.between(1, 40)); break
    default: lo = r.pick([0.5, 1, 2]); hi = p(r.between(1, 3)); break
  }
  let d = [lo, hi]
  if (r.chance(0.3)) d = [-hi, -lo]
  if (r.chance(0.3)) d.reverse()
  return d
}

describe(`log scale ticks over whole bases vs vega-scale (generated, live)`, () => {
  it('equal ticks and labels where d3 gives a bounded number of them; a typed refusal past the ceiling', () => {
    const r = makeRng(0x96)
    let refused = 0
    let compared = 0
    const stats = compareCases('log ticks', scaled(3000), () => {
      const base = r.pick(BASES)
      const domain = genDomain(r, base)
      const count = r.pick([undefined, 1, 3, 5, 10, 20, 50])
      const run = (make: () => any, oracle: boolean): unknown => {
        const s = make().base(base).domain(domain).range([0, 500])
        let ticks: number[]
        try {
          ticks = count === undefined ? s.ticks() : s.ticks(count)
        } catch (e) {
          if (!oracle && e instanceof AsterLimitError) return 'refused past the ceiling'
          throw e
        }
        if (ticks.length > HARD_CAPS.items) return 'refused past the ceiling'
        const fmt = s.tickFormat(count ?? 10)
        return { ticks, labels: ticks.slice(0, 200).map((t) => fmt(t)) }
      }
      return {
        label: `base ${base} domain ${JSON.stringify(domain)} count ${count}`,
        oracle: () => run(() => (vegaScale.scale('log') as any)(), true),
        aster: () => {
          const out = run(() => asterScale.scale('log')!(), false)
          if (out === 'refused past the ceiling') refused++
          else compared++
          return out
        },
      }
    })
    expect(stats.informative).toBeGreaterThan(scaled(3000) * 0.8)
    // both outcomes are common: large bases are drawn enough to reach the ceiling, and most cases compare ticks
    expect(refused).toBeGreaterThan(scaled(3000) * 0.01)
    expect(compared).toBeGreaterThan(scaled(3000) * 0.7)
  })
})
