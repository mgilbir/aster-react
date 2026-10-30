/**
 * LIVE, generated differential for the domains of the quantile-style scales: `quantile`, `quantize`, `threshold` and
 * `sequentialQuantile` of `scale-d3.ts` against the d3-scale 4.0.2 that the pinned vega-scale is built on, in the same
 * process. The domains are the ones a data column gives: numbers mixed with null, undefined, NaN, numeric and
 * non-numeric strings, '', booleans and Dates, in any order, with repeats, or empty. Every observable of the built
 * scale is compared: the domain, the thresholds / quantiles, the output for probe values (missing ones included),
 * and `invertExtent`.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { quantileScale, quantize, sequentialQuantile, threshold } from '../../core/src/scale-d3.ts'
import { exact } from './differential-util.mts'

const d3Path = createRequire(createRequire(import.meta.url).resolve('vega-scale')).resolve('d3-scale')
const d3 = (await import(pathToFileURL(d3Path).href)) as Record<string, () => any> // eslint-disable-line @typescript-eslint/no-explicit-any

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r = prng(0x51a7)
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

const ODD: unknown[] = [null, undefined, NaN, '', '3', '2.5', 'x', ' 7 ', true, false, Infinity, -Infinity, new Date(5), [4], -0]

function domain(): unknown[] {
  const n = pick([0, 1, 2, 3, 4, 7, 12, 30])
  const mode = pick(['clean', 'sparse', 'mostly-odd', 'all-null', 'dups'])
  return Array.from({ length: n }, () => {
    if (mode === 'all-null') return pick([null, undefined, NaN])
    if (mode === 'dups') return pick([1, 2, 2, 5, null])
    const odd = mode === 'mostly-odd' ? 0.7 : mode === 'sparse' ? 0.25 : 0
    return r() < odd ? pick(ODD) : Math.round((r() * 30 - 8) * 4) / 4
  })
}
const PROBES: unknown[] = [-10, -1, 0, 0.5, 1, 2, 2.5, 3, 5, 7.5, 9, 12, 25, 100, null, undefined, NaN, '4', 'x', '', Infinity, -Infinity, true]

/* eslint-disable @typescript-eslint/no-explicit-any */
function observe(s: any, ranges: unknown[]): unknown {
  const o: Record<string, unknown> = {}
  o.domain = exact(() => s.domain())
  o.thresholds = exact(() => (s.thresholds ? s.thresholds() : s.quantiles ? s.quantiles() : undefined))
  o.range = exact(() => (s.range ? s.range() : undefined))
  o.calls = PROBES.map((p) => exact(() => s(p)))
  if (s.invertExtent) o.invert = ranges.map((y) => exact(() => s.invertExtent(y)))
  return o
}

const RANGES: unknown[][] = [['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['a'], [], [0, 1, 2, 3, 4, 5], ['a', 'b']]

describe('discretizing scale domains vs d3-scale 4.0.2 (generated)', () => {
  for (let i = 0; i < 400; i++) {
    const dom = domain()
    const range = pick(RANGES)
    const tag = JSON.stringify(dom, (_k, v) => (v === undefined ? '__undef' : typeof v === 'number' && !isFinite(v) ? String(v) : v))
    it(`quantile #${i} ${tag} range=${range.length}`, () => {
      const build = (make: () => any) => exact(() => { const s = make(); s.range(range).domain(dom); return observe(s, range) })
      expect(build(quantileScale)).toEqual(build(d3.scaleQuantile!))
    })
    it(`quantize #${i} ${tag.slice(0, 80)} range=${range.length}`, () => {
      const ext = [pick(dom.length ? dom : [0]), pick(dom.length ? dom : [10])]
      const build = (make: () => any) => exact(() => { const s = make(); s.range(range).domain(ext); return observe(s, range) })
      expect(build(quantize)).toEqual(build(d3.scaleQuantize!))
    })
    it(`threshold #${i} ${tag.slice(0, 80)} range=${range.length}`, () => {
      const build = (make: () => any) => exact(() => { const s = make(); s.range(range).domain(dom); return observe(s, range) })
      expect(build(threshold)).toEqual(build(d3.scaleThreshold!))
    })
    it(`sequentialQuantile #${i} ${tag}`, () => {
      const build = (make: () => any) => exact(() => {
        const s = make()
        s.domain(dom)
        return { domain: s.domain(), range: s.range(), quantiles: [0, 1, 2, 4].map((n) => exact(() => s.quantiles(n))), calls: PROBES.map((p) => exact(() => s(p))) }
      })
      expect(build(sequentialQuantile)).toEqual(build(d3.scaleSequentialQuantile!))
    })
  }
})
