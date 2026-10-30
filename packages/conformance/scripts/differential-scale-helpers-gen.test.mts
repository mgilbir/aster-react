/**
 * GENERATED live differential of the helpers around the scale registry (`core/src/scale.ts`) against the pinned
 * `vega-scale` 8.1.2 and `vega-format` 2.1.2, in one process and one engine: tickCount (counts, minimum steps,
 * `{interval, step}`, interval names), tickValues, validTicks, tickFormat, labelValues, labelFormat, labelFraction,
 * scaleFraction, scaleCopy, interpolateColors, interpolateRange, quantizeInterpolator, every named scheme, bandSpace and
 * the type predicates. Each trial builds a configured scale of a registry type on both sides (domain, range, bins as
 * the Scale transform leaves them) and compares what the helper returns, or the error it raises.
 */
import * as vegaFormat from 'vega-format'
import * as vegaScale from 'vega-scale'
import { describe, expect, it, vi } from 'vitest'
import * as aster from '../../core/src/scale.ts'
import { locale as asterLocale } from '../../core/src/locale.ts'
import { enc, withTz } from './differential-util.mts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 300_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
const V: any = vegaScale
const A: any = aster
const vLocale = (vegaFormat as any).locale()
const aLocale = asterLocale()

const TYPES = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'diverging-linear', 'quantile', 'quantize', 'threshold', 'bin-ordinal', 'ordinal', 'band', 'point', 'identity']

interface Plan { type: string; domain: unknown[]; range: unknown[]; bins?: number[]; date: boolean; wide: boolean }

function planFor(r: Rng): Plan {
  const type = r.pick(TYPES)
  const date = type === 'time' || type === 'utc'
  const base = r.pick([0, 1, 5, 100, -50, 0.001, 1e6, 3.5])
  const span = r.pick([1, 10, 100, 0.01, 1e5, 7.7])
  let domain: unknown[]
  if (date) {
    const t0 = r.pick([0, 946684800000, 1.7e12, 1710054000000])
    const dspan = r.pick([1000, 60000, 3600000, 86400000, 604800000, 2.6e9, 3.2e10, 3.2e11])
    domain = r.chance(0.1) ? [t0 + dspan, t0] : [t0, t0 + dspan]
  } else if (type === 'ordinal' || type === 'band' || type === 'point') domain = r.pick([['a', 'b', 'c', 'd'], ['x'], [], ['a', 'b', 'a'], [1, 2, 3]])
  else if (type === 'log') domain = r.pick([[1, 1000], [0.01, 100], [-100, -1], [1, 1], [5, 5000], [1, 1e9]])
  else if (type === 'diverging-linear') domain = [base, base + span, base + 2 * span]
  else if (type === 'threshold') domain = [base, base + span, base + 2 * span].slice(0, r.between(1, 3))
  else if (type === 'quantile') domain = Array.from({ length: r.between(0, 12) }, () => base + span * r.next())
  else domain = r.chance(0.12) ? [base + span, base] : r.chance(0.08) ? [base, base] : [base, base + span]
  const px = r.pick([[0, 500], [500, 0], [0, 100], [10, 10], [0, 1000], [20, 380]])
  let range: unknown[] = px
  if (type === 'ordinal') range = ['red', 'green', 'blue']
  if (type === 'quantile' || type === 'quantize') range = r.pick([['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['a'], []])
  if (type === 'threshold' || type === 'bin-ordinal') range = r.pick([['a', 'b', 'c', 'd'], ['a', 'b'], ['a']])
  if (type === 'sequential' || type === 'diverging-linear') range = []
  const bins = r.chance(0.2) && ['linear', 'time', 'utc', 'sqrt', 'pow'].includes(type) ? Array.from({ length: r.between(2, 7) }, (_, i) => (date ? (domain[0] as number) + i * 3e6 : base + (i * span) / 5)) : undefined
  const wide = date && Math.abs((domain[1] as number) - (domain[0] as number)) > 1e10
  return { type, domain, range, bins, date, wide }
}

/** Fine interval names list millions of dates over a wide time domain. */
const fine = (c: unknown): boolean => /minute|hour|day|week/.test(JSON.stringify(c) ?? '')
/** A NaN or infinite tick count sends d3-time into a loop that allocates without end; the oracle itself does not answer. */
const unbounded = (c: unknown): boolean => typeof c === 'number' && !Number.isFinite(c)
const countFor = (r: Rng, p: Plan, pool: unknown[] = COUNTS): unknown => { let c = r.pick(pool); while ((p.wide && fine(c)) || (p.date && unbounded(c))) c = r.pick(pool); return c }

function build(side: any, p: Plan, r: Rng, seed: number): any {
  const s = side.scale(p.type)()
  void r
  void seed
  s.domain(p.date ? p.domain.map((v) => new Date(v as number)) : p.domain)
  if (p.type === 'sequential' || p.type === 'diverging-linear') s.interpolator(side.interpolateColors(['#ffffe0', '#8b0000'], 'rgb'))
  else if (p.range.length || p.type !== 'identity') s.range(p.range)
  if (p.bins) s.bins = p.bins.map((v) => (p.date ? new Date(v) : v))
  return s
}

const COUNTS: unknown[] = [undefined, null, 0, 1, 2, 3, 5, 10, 20, 100, 0.5, -1, NaN, '5', Infinity, { interval: 'month' }, { interval: 'year', step: 2 }, { interval: 'day', step: 7 }, 'month', 'week', 'hour', 'bogus', { interval: 'quarter' }, { step: 3 }, { interval: 'minute', step: 15 }]
const MIN_STEPS: unknown[] = [undefined, undefined, undefined, 0, 1, 10, 0.1, 50, -5, NaN, 1e9]
const SPECS: unknown[] = [undefined, null, ',f', '.2f', 's', '%', '$,.2f', 'e', '.3g', '%Y', '%b %d', '%H:%M', 'bad']
const FORMAT_TYPES: unknown[] = [undefined, undefined, 'time', 'utc', 'number', 'bogus']
const LEGENDS: unknown[] = ['symbol', 'discrete', 'gradient', undefined, 'other']

function samples(p: Plan, r: Rng): unknown[] {
  const n = r.between(4, 8)
  const out: unknown[] = []
  for (let i = 0; i < n; i++) {
    const d0 = typeof p.domain[0] === 'number' ? (p.domain[0] as number) : 0
    const d1 = typeof p.domain[p.domain.length - 1] === 'number' ? (p.domain[p.domain.length - 1] as number) : 1
    const v = d0 + (d1 - d0) * r.pick([-0.5, 0, 0.25, 0.5, 1, 1.5, r.next()])
    out.push(p.date ? new Date(v) : r.chance(0.1) ? r.pick(['a', 'b', null, NaN, 'zz']) : v)
  }
  return out
}

const fmtImage = (f: any, xs: unknown[]): unknown => (typeof f === 'function' ? xs.map((x, i) => { try { return enc(f(x, i, xs)) } catch (e) { return { threw: (e as Error).constructor.name } } }) : enc(f))

describe('scale helpers vs vega-scale 8.1.2 (generated)', () => {
  it('tickCount, tickValues, validTicks', () => {
    const r = makeRng(0x7c1)
    withTz('America/New_York', () => {
      compareCases('ticks-helpers', scaled(9000), () => {
        const p = planFor(r)
        const count = countFor(r, p)
        const minStep = r.pick(MIN_STEPS)
        const which = r.pick(['tickCount', 'tickValues', 'valid', 'tickValuesInterval'])
        const cand = samples(p, r)
        return {
          label: `${which} ${p.type} ${JSON.stringify(p.domain)} bins=${JSON.stringify(p.bins)} count=${JSON.stringify(count)} minStep=${minStep}`,
          oracle: () => run(V, p, which, count, minStep, cand),
          aster: () => run(A, p, which, count, minStep, cand),
        }
      })
    })
    function run(side: any, p: Plan, which: string, count: any, minStep: any, cand: unknown[]): unknown {
      const s = build(side, p, r, 0)
      if (which === 'tickCount') return side.tickCount(s, count, minStep)
      if (which === 'tickValues') return side.tickValues(s, count)
      if (which === 'valid') return side.validTicks(s, cand, typeof count === 'number' ? count : 5)
      return side.tickValues(s, side.tickCount(s, count))
    }
  })

  it('tickFormat, labelValues, labelFormat, labelFraction', () => {
    const r = makeRng(0x7c2)
    withTz('America/New_York', () => {
      compareCases('label-helpers', scaled(9000), () => {
        const p = planFor(r)
        const count = countFor(r, p, COUNTS.filter((c) => typeof c !== 'object' || c === null))
        const spec = r.pick(SPECS)
        const ft = r.pick(FORMAT_TYPES)
        const legend = r.pick(LEGENDS)
        const noSkip = r.pick([undefined, true, false])
        const xs = samples(p, r)
        const which = r.pick(['tickFormat', 'labelValues', 'labelFormat', 'labelFraction'])
        const run = (side: any, loc: any): unknown => {
          const s = build(side, p, r, 0)
          if (which === 'tickFormat') return fmtImage(side.tickFormat(loc, s, count, spec, ft, noSkip), xs)
          if (which === 'labelValues') { const v = side.labelValues(s, count); return { v, max: v?.max } }
          if (which === 'labelFraction') return fmtImage(side.labelFraction(s), xs)
          const vals = side.labelValues(s, count)
          return fmtImage(side.labelFormat(loc, s, count, legend, spec, ft, noSkip), vals)
        }
        return { label: `${which} ${p.type} ${JSON.stringify(p.domain)} count=${count} spec=${spec} ft=${ft} legend=${legend}`, oracle: () => run(V, vLocale), aster: () => run(A, aLocale) }
      })
    })
  })

  it('scaleFraction, scaleCopy, interpolateRange, quantizeInterpolator, interpolateColors', () => {
    const r = makeRng(0x7c3)
    compareCases('colour-helpers', scaled(6000), () => {
      const p = planFor(r)
      const which = r.pick(['scaleFraction', 'scaleCopy', 'interpolateRange', 'quantizeInterpolator', 'interpolateColors'])
      const lo = r.pick([0, 1, -5, 10, NaN]); const hi = r.pick([10, 1, 100, Infinity, 0])
      const colors = Array.from({ length: r.between(0, 4) }, () => r.pick(['red', '#fff', 'steelblue', 'rgb(1,2,3)', 'nonsense', '#123456']))
      const space = r.pick([undefined, 'rgb', 'hsl', 'lab', 'hcl', 'cubehelix', 'rgb-basis', 'bogus'])
      const gamma = r.pick([undefined, 1, 2.2, 0.5])
      const rng = r.pick([[0, 1], [0.2, 0.8], [1, 0], [0, 0]])
      const n = r.pick([0, 1, 2, 5, 9])
      const xs = [0, 0.25, 0.5, 1, -1, 2, NaN]
      const run = (side: any): unknown => {
        const s = build(side, p, r, 0)
        if (which === 'scaleFraction') return fmtImage(side.scaleFraction(s, lo, hi), xs)
        if (which === 'scaleCopy') { const c = side.scaleCopy(s); return { type: c.type, same: c === s, d: c.domain() } }
        if (which === 'interpolateRange') return fmtImage(side.interpolateRange((t: number) => t * 100, rng), xs)
        if (which === 'quantizeInterpolator') return side.quantizeInterpolator((t: number) => t * 100, n)
        return fmtImage(side.interpolateColors(colors, space, gamma), xs)
      }
      return { label: `${which} ${p.type} ${lo},${hi} ${colors} ${space} ${gamma}`, oracle: () => run(V), aster: () => run(A) }
    })
  })

  it('every scheme, bandSpace, the type predicates', () => {
    const r = makeRng(0x7c4)
    const names: string[] = Object.keys(V.scheme ? {} : {}).concat(
      ...['category10', 'category20', 'category20b', 'category20c', 'accent', 'dark2', 'paired', 'pastel1', 'pastel2', 'set1', 'set2', 'set3', 'tableau10', 'tableau20', 'blues', 'greens', 'greys', 'oranges', 'purples', 'reds', 'blueorange', 'brownbluegreen', 'purplegreen', 'pinkyellowgreen', 'purpleorange', 'redblue', 'redgrey', 'redyellowblue', 'redyellowgreen', 'spectral', 'viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'bluegreen', 'bluepurple', 'goldgreen', 'goldorange', 'goldred', 'greenblue', 'orangered', 'purplebluegreen', 'purpleblue', 'purplered', 'redpurple', 'yellowgreenblue', 'yellowgreen', 'yelloworangebrown', 'yelloworangered', 'darkblue', 'darkgold', 'darkgreen', 'darkmulti', 'darkred', 'lightgreyred', 'lightgreyteal', 'lightmulti', 'lightorange', 'lighttealblue', 'rainbow', 'sinebow', 'Blues', 'VIRIDIS', 'nonsense', ''],
    )
    for (const n of names) {
      expect(sampleScheme(A, n), n).toEqual(sampleScheme(V, n))
    }
    // the one place Aster differs on purpose: scheme names come from specs, so inherited names are not schemes (vega returns Object's)
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(A.scheme(n), n).toBeUndefined()
    // the one place Aster differs on purpose: scheme names come from specs, so inherited names are not schemes (vega returns Object's)
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(A.scheme(n), n).toBeUndefined()
    compareCases('band-space', scaled(3000), () => {
      const a = [r.pick([0, 1, 5, 10, 100, 1.5, NaN, -1]), r.pick([0, 0.1, 0.5, 1, 2, -1, NaN]), r.pick([0, 0.1, 0.5, 1, 2, -1, NaN])] as const
      return { label: String(a), oracle: () => V.bandSpace(...a), aster: () => A.bandSpace(...a) }
    })
    const keys = [...TYPES, 'sequential-log', 'diverging-symlog', 'sequential-sqrt', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'LINEAR', 'Linear', 'x', 'band ', 'valueOf']
    for (const k of keys) {
      for (const f of ['isValidScaleType', 'isContinuous', 'isDiscrete', 'isDiscretizing', 'isLogarithmic', 'isTemporal', 'isInterpolating', 'isQuantile']) {
        expect(!!A[f](k), `${f}(${k})`).toBe(!!V[f](k))
      }
      const v = V.scale(k)
      const a = A.scale(k)
      expect(typeof a, `scale(${k})`).toBe(typeof v)
      if (v) expect(Object.keys(a().type ? { t: a().type } : {})).toEqual(Object.keys({ t: v().type }))
      if (v) expect(a().type).toBe(v().type)
      if (v) expect(A.isRegisteredScale(a())).toBe(V.isRegisteredScale(v()))
    }
  })
})

function sampleScheme(side: any, name: string): unknown {
  try {
    const s = side.scheme(name)
    if (Array.isArray(s)) return enc(s)
    if (typeof s === 'function') return Array.from({ length: 21 }, (_, i) => enc(s(i / 20)))
    return enc(s)
  } catch (e) {
    return { threw: (e as Error).message }
  }
}
