/**
 * Live differential of a projection parameter that fails (C153): a `{signal}` parameter whose expression throws, and a `fit` list
 * with a null member, in every parameter a projection takes, at the top level and in a group. vega logs the error its operator throws
 * and draws none of the marks after it; Aster must log the same error and draw the same picture, never fall back to the
 * projection's defaults in silence. A parameter that only reads a dataset made later is no error in either.
 */
import * as vega from 'vega'
import { describe, expect, it } from 'vitest'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { quietLogger } from './differential-util.mts'

const FEATURE = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] } }

const THROWING = ['null.x', 'nothing[0].y', "data('later')[5].v"]
const PARAMS: Array<[string, (e: string) => unknown]> = [
  ['scale', (e) => ({ signal: e })],
  ['center', (e) => [{ signal: e }, 0]],
  ['rotate', (e) => ({ signal: e })],
  ['translate', (e) => [100, { signal: e }]],
  ['clipExtent', (e) => ({ signal: `[[0, 0], [${e}, 100]]` })],
  ['fit', (e) => ({ signal: e })],
  ['precision', (e) => ({ signal: e })],
]

function spec(param: string, value: unknown, inGroup: boolean): Record<string, unknown> {
  const projection = { name: 'p', type: 'mercator', size: [200, 100], [param]: value }
  const marks = [
    { type: 'shape', from: { data: 'f' }, encode: { update: { stroke: { value: 'red' } } }, transform: [{ type: 'geoshape', projection: 'p' }] },
    { type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'blue' } } } },
  ]
  return {
    width: 200, height: 100, autosize: 'none',
    signals: [{ name: 'nothing', value: null }],
    data: [{ name: 'f', values: [FEATURE] }, { name: 'later', values: [{ v: 1 }] }],
    ...(inGroup
      ? { marks: [{ type: 'group', encode: { update: { width: { value: 200 }, height: { value: 100 } } }, projections: [projection], marks }] }
      : { projections: [projection], marks }),
  }
}

async function viaVega(s: unknown): Promise<{ svg?: string; errors: string[] }> {
  const errors: unknown[][] = []
  try {
    const view = new vega.View(vega.parse(structuredClone(s) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
    await view.runAsync()
    const svg = await view.toSVG().catch((e: Error) => { errors.push([`threw ${e.message}`]); return undefined })
    return { svg, errors: errors.map((e) => String(e[0]).replace(/^\w*Error: /, '')) }
  } catch (e) {
    return { errors: [...errors.map((x) => String(x[0])), `threw ${(e as Error).message}`] }
  }
}

function viaAster(s: unknown): { svg?: string; errors: string[] } {
  const errors: string[] = []
  try {
    const svg = renderSpec(structuredClone(s) as never, { logger: { error: (e: unknown) => errors.push(String((e as Error)?.message ?? e)), warn() {}, info() {}, debug() {} } })
    return { svg, errors }
  } catch (e) {
    return { errors: [...errors, `threw ${(e as Error).message}`] }
  }
}

describe(`a projection parameter that fails vs vega@${vega.version} (live)`, () => {
  it('logs the error vega logs and draws what vega draws', async () => {
    let failing = 0
    const cases: Array<[string, unknown]> = []
    for (const [param, make] of PARAMS) for (const e of THROWING) cases.push([`${param} = ${e}`, make(e)])
    // a null among the shapes to fit, a fit list of only nulls, a fit over a dataset that exists
    cases.push(['fit [null, feature]', [null, FEATURE]], ['fit [null]', [null]], ['fit data', { signal: "data('f')" }], ['fit [data, null]', [{ signal: "data('f')" }, null]])
    for (const [label, value] of cases) {
      for (const inGroup of [false, true]) {
        const param = label.split(' ')[0]!
        const s = spec(param, value, inGroup)
        const want = await viaVega(s)
        const got = viaAster(s)
        const where = `${label}${inGroup ? ' (in a group)' : ''}`
        // the error the failing operator throws, logged first; then the same picture. Where the parameter reads a dataset, vega's
        // operator is ranked after the marks were made, and its renderer then fails on shapes the geoshape never wrote (a second
        // error, and no picture): Aster stops at the projection, with no shape drawn either
        expect(got.errors[0], where).toBe(want.errors[0]?.replace(/^\w*Error: /, ''))
        if (want.errors.length) failing++
        if (want.svg !== undefined) {
          expect(got.errors.length, where).toBe(want.errors.length)
          expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg!)), where).toEqual([])
        } else {
          expect(want.errors.at(-1), where).toBe("threw Cannot read properties of undefined (reading 'context')")
          expect(got.svg !== undefined && /<path [^>]*d="M[^"]*"[^>]*stroke="red"/.test(got.svg), where).toBe(false)
        }
      }
    }
    expect(failing).toBeGreaterThan(30)
  })

  it('a signal two lists deep in a parameter is resolved, where vega leaves the reference (a listed deviation)', async () => {
    const s = spec('clipExtent', [[0, 0], [{ signal: 'width' }, 100]], false)
    const want = await viaVega(s)
    const got = viaAster(s)
    // vega clips to [[0, 0], [NaN, 100]]: NaN in its path; Aster clips to the view's width, as `{signal: "[[0,0],[width,100]]"}` does
    expect(want.svg).toMatch(/NaN/)
    expect(got.svg).not.toMatch(/NaN/)
    const resolved = viaAster(spec('clipExtent', { signal: '[[0, 0], [width, 100]]' }, false))
    expect(got.svg).toBe(resolved.svg)
    // one that throws is logged by both; one that reads a dataset fails after the marks are made (they are drawn), any other stops
    // the pass before them
    for (const e of THROWING) {
      const deep = spec('clipExtent', [[0, 0], [{ signal: e }, 100]], false)
      const w = await viaVega(deep)
      const g = viaAster(deep)
      expect(g.errors[0], e).toBe(w.errors[0])
      const rect = /fill="#00f"|fill="blue"/
      expect(rect.test(g.svg ?? ''), e).toBe(rect.test(w.svg ?? ''))
    }
  })
})
