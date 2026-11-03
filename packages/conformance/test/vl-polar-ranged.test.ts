// @vitest-environment node
/**
 * theta and theta2, radius and radius2 against vega-lite 6.4.3: an arc between two angles (or two radii), alone, stacked, normalized,
 * binned, in a time unit, discrete, with a constant or a datum for its end, under a colour and next to the other polar channel, itself
 * ranged or stacked. The compiled scales and marks, the scales and axes as they run, the rows and the SVG must be the same
 * (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { TIME_DATA } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'

type Obj = Record<string, unknown>
const DATA = TIME_DATA.map((r, i) => ({ ...r, w: (r.v as number) * 2 + (i % 4), c: i % 3 ? 'p' : 'q' }))

/** The first channel of a pair. A pre-binned or datum first channel is another feature (polar pre-binned data, a datum that makes a scale). */
const FIRST: Array<[string, Obj | null, 'n' | 't' | 'o']> = [
  ['v', { field: 'v', type: 'quantitative' }, 'n'],
  ['sum v', { field: 'v', type: 'quantitative', aggregate: 'sum' }, 'n'],
  ['count', { aggregate: 'count', type: 'quantitative' }, 'n'],
  ['v, stack normalize', { field: 'v', type: 'quantitative', stack: 'normalize' }, 'n'],
  ['v, stack true', { field: 'v', type: 'quantitative', stack: true }, 'n'],
  ['v, sqrt scale', { field: 'v', type: 'quantitative', scale: { type: 'sqrt' } }, 'n'],
  ['v, bin', { field: 'v', type: 'quantitative', bin: true }, 'n'],
  ['month', { field: 't', type: 'temporal', timeUnit: 'month' }, 't'],
  ['utc year and month', { field: 't', type: 'temporal', timeUnit: 'utcyearmonth' }, 't'],
  ['k, ordinal', { field: 'k', type: 'ordinal' }, 'o'],
]
/** The second channel: none, a field, the same field, an aggregate, a time unit, a constant, a datum. */
const SECOND: Array<[string, Obj | null, 'n' | 't' | 'o' | 'any']> = [
  ['none', null, 'any'],
  ['w', { field: 'w' }, 'n'],
  ['v', { field: 'v' }, 'n'],
  ['sum w', { field: 'w', aggregate: 'sum' }, 'n'],
  ['count', { aggregate: 'count' }, 'n'],
  ['value', { value: 1.5 }, 'any'],
  ['datum', { datum: 7 }, 'n'],
  ['month', { field: 't', timeUnit: 'month' }, 't'],
  ['k', { field: 'k' }, 'o'],
]
const OTHER: Array<[string, Obj | null]> = [
  ['alone', null],
  ['over a colour', { color: { field: 'c', type: 'nominal' } }],
]

const pair = (kind: 'theta' | 'radius', a: Obj | null, a2: Obj | null, other: Obj | null, extra: Obj | null): Obj => ({
  data: { values: DATA },
  mark: 'arc',
  encoding: { ...(a ? { [kind]: a } : {}), ...(a2 ? { [`${kind}2`]: a2 } : {}), ...(other ?? {}), ...(extra ?? {}) },
})

describe('a ranged polar position has the scales, the marks and the picture vega-lite gives it', () => {
  for (const kind of ['theta', 'radius'] as const) {
    const otherKind = kind === 'theta' ? 'radius' : 'theta'
    for (const [fn, first, fk] of FIRST) {
      it(`${kind} ${fn}: with each second channel, alone, under a colour and next to the other channel`, async () => {
        const cases: Array<[string, Obj]> = []
        for (const [sn, second, sk] of SECOND) {
          if (sk !== 'any' && sk !== fk) continue
          for (const [on, extra] of OTHER) {
            cases.push([`${sn}, ${on}`, pair(kind, first, second, null, extra)])
            // next to the other polar channel: a field of its own, itself ranged, stacked
            for (const [pn, polar] of [
              ['a nominal', { [otherKind]: { field: 'k', type: 'nominal' } }],
              ['a measure', { [otherKind]: { field: 'w', type: 'quantitative', aggregate: 'sum' } }],
              ['a measure, ranged', { [otherKind]: { field: 'w', type: 'quantitative' }, [`${otherKind}2`]: { field: 'v' } }],
              ['a stacked measure', { [otherKind]: { field: 'w', type: 'quantitative', stack: 'normalize' } }],
            ] as Array<[string, Obj]>) cases.push([`${sn}, ${on}, with ${pn}`, pair(kind, first, second, polar, extra)])
          }
        }
        const bad = await collect(cases, 0.9)
        expect(bad.slice(0, 6), `${bad.length} of ${cases.length} differ`).toEqual([])
      }, 240_000)
    }
  }

  it('an arc with no theta is a full turn, with no radius a full disc', async () => {
    const cases: Array<[string, Obj]> = []
    for (const [fn, first] of FIRST.slice(0, 4)) {
      cases.push([`radius ${fn}`, pair('radius', first, null, null, null)])
      cases.push([`radius ${fn}, ranged`, pair('radius', first, { field: 'w' }, null, null)])
      cases.push([`mark theta, radius ${fn}`, { ...pair('radius', first, null, null, null), mark: { type: 'arc', theta: 1 } }])
      cases.push([`mark theta and theta2, radius ${fn}`, { ...pair('radius', first, null, null, null), mark: { type: 'arc', theta: 1, theta2: 2 } }])
    }
    cases.push(['nothing', { data: { values: DATA }, mark: 'arc' }])
    const bad = await collect(cases)
    expect(bad.slice(0, 6), `${bad.length} of ${cases.length} differ`).toEqual([])
  }, 240_000)
})
