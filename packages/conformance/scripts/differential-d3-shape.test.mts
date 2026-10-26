/**
 * LIVE differential for the curve/line/area generators (ADR-0001 suite formerly recorded as
 * `d3-shape.json`): the pinned `d3-shape` and Aster's `shape.ts` build the same path strings
 * from the same points (`d3-shape-cases.mjs`) in ONE process and engine; the strings
 * (or the thrown error, class and message) must be identical. Nothing is recorded: the
 * Catmull-Rom / cardinal / bundle / natural curves go through Math.pow and sqrt, which differ in
 * the last bit between V8 versions (see `differential-util.mts`).
 */
import { describe, expect, it } from 'vitest'
import * as d3Shape from 'd3-shape'
import * as aster from '../../core/src/shape.ts'
import { exact } from './differential-util.mts'
import { areaCurves, areaPoints, curveFamilies, gapCurves, gapPoints, pointSets } from './d3-shape-cases.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Api = Record<string, any>
const d3Api = d3Shape as unknown as Api
const asterApi = aster as unknown as Api

type Opts = { beta?: number; tension?: number; alpha?: number }

function factoryOf(api: Api, curveName: string, opts: Opts): any {
  let factory = api[curveName]
  if (opts.beta !== undefined) factory = factory.beta(opts.beta)
  if (opts.tension !== undefined) factory = factory.tension(opts.tension)
  if (opts.alpha !== undefined) factory = factory.alpha(opts.alpha)
  return factory
}

/**
 * d3-shape rounds path coordinates to 3 decimals by default, which hides a 1-ulp divergence
 * (a planted `* (1 + Number.EPSILON)` in a curve did not change a single string). So every case
 * also runs at full precision (`.digits(null)`), where the last bit is visible.
 */
const MODES: Array<{ label: string; digits: number | null | undefined }> = [
  { label: 'default digits', digits: undefined },
  { label: 'full precision', digits: null },
]

const lineOf = (api: Api, curve: string, opts: Opts, points: number[][], defined: boolean, digits: number | null | undefined) => exact(() => {
  const gen = api.line().x((d: number[]) => d[0]).y((d: number[]) => d[1])
  if (digits !== undefined) gen.digits(digits)
  if (defined) gen.defined((d: unknown[]) => d[2])
  return gen.curve(factoryOf(api, curve, opts))(points)
})

const areaOf = (api: Api, curve: string, opts: Opts, points: number[][], digits: number | null | undefined) => exact(() => {
  const gen = api.area().x((d: number[]) => d[0]).y0((d: number[]) => d[1]).y1((d: number[]) => d[2])
  if (digits !== undefined) gen.digits(digits)
  return gen.curve(factoryOf(api, curve, opts))(points)
})

const json = (x: unknown) => JSON.stringify(x)
const lineCases: Array<{ name: string; curve: string; opts: Opts; points: number[][]; defined: boolean }> = []
for (const [curve, opts] of curveFamilies as Array<[string, Opts]>) {
  ;(pointSets as number[][][]).forEach((points, i) =>
    lineCases.push({ name: `line ${curve} ${json(opts)} points#${i}`, curve, opts, points, defined: false }))
}
for (const [curve, opts] of gapCurves as Array<[string, Opts]>) {
  lineCases.push({ name: `line ${curve} ${json(opts)} with gaps`, curve, opts, points: gapPoints as number[][], defined: true })
}
const areaCases: Array<{ name: string; curve: string; opts: Opts; points: number[][] }> = []
for (const [curve, opts] of areaCurves as Array<[string, Opts]>) {
  ;(areaPoints as number[][][]).forEach((points, i) =>
    areaCases.push({ name: `area ${curve} ${json(opts)} points#${i}`, curve, opts, points: points.map((d) => d.slice(0, 3)) }))
}

describe(`d3-shape ${(d3Shape as unknown as { version?: string }).version ?? '3.2.0'} vs Aster shape.ts (live)`, () => {
  for (const m of MODES) {
    for (const c of lineCases) {
      it(`${c.name} [${m.label}]`, () => {
        const want = lineOf(d3Api, c.curve, c.opts, c.points, c.defined, m.digits)
        expect(lineOf(asterApi, c.curve, c.opts, c.points, c.defined, m.digits)).toEqual(want)
      })
    }
    for (const c of areaCases) {
      it(`${c.name} [${m.label}]`, () => {
        const want = areaOf(d3Api, c.curve, c.opts, c.points, m.digits)
        expect(areaOf(asterApi, c.curve, c.opts, c.points, m.digits)).toEqual(want)
      })
    }
  }
  it('keeps the recorded suite sizes (coverage floor)', () => {
    expect(lineCases.length).toBeGreaterThanOrEqual(247) // 27 curve variants x 9 point sets + 4 gap cases
    expect(areaCases.length).toBeGreaterThanOrEqual(9)
  })
})
