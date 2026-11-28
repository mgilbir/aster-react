// @vitest-environment node
/**
 * A transform's `signal` against vega (C544): vega binds it to the value of the transform's operator. Where that value is data --
 * the bins, the extent, the rows the transform returns or adds, a pie's values, an identifier's counter, null -- Aster binds the same
 * value, read by a later dataset; where it is vega's internal state (an aggregate's cell map, a filter's bit set, a hierarchy's root,
 * a simulation) it is an opaque object standing for the operator, the same every evaluation (a documented deviation): what specs use
 * it for, `require: {signal}`, works. Every transform type is one or the other.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'
import '@aster-charts/core/geo'
import { TRANSFORM_TYPES } from '../../core/src/transform-names.ts'
import { signalValueOf } from '../../core/src/transform-params.ts'

type Obj = Record<string, unknown>
const ROWS = [{ id: 1, parent: null, v: 1, x: 1, y: 2, lon: 0, lat: 0, g: 'a', t: 'x y', arr: [1, 2] }, { id: 2, parent: 1, v: 5, x: 3, y: 4, lon: 10, lat: 5, g: 'b', t: 'y', arr: [3] }, { id: 3, parent: 1, v: 9, x: 2, y: 7, lon: 20, lat: 9, g: 'a', t: 'z', arr: [] }]
const CASES: Record<string, Obj[]> = {
  bin: [{ type: 'bin', field: 'v', extent: [0, 10] }], extent: [{ type: 'extent', field: 'v' }], timeunit: [{ type: 'timeunit', field: 'v', units: ['year'] }],
  dotbin: [{ type: 'dotbin', field: 'v' }], collect: [{ type: 'collect', sort: { field: 'v', order: 'descending' } }], sample: [{ type: 'sample', size: 2 }],
  fold: [{ type: 'fold', fields: ['v', 'x'] }], flatten: [{ type: 'flatten', fields: ['arr'] }], cross: [{ type: 'cross' }], kde: [{ type: 'kde', field: 'v', steps: 3 }],
  density: [{ type: 'density', extent: [0, 1], steps: 3, distribution: { function: 'normal' } }], quantile: [{ type: 'quantile', field: 'v', step: 0.25 }],
  regression: [{ type: 'regression', x: 'x', y: 'y' }], loess: [{ type: 'loess', x: 'x', y: 'y' }], contour: [{ type: 'contour', x: 'x', y: 'y', size: [8, 8] }],
  kde2d: [{ type: 'kde2d', x: 'x', y: 'y', size: [4, 4] }], isocontour: [{ type: 'kde2d', x: 'x', y: 'y', size: [4, 4] }, { type: 'isocontour', field: 'grid' }],
  impute: [{ type: 'impute', field: 'v', key: 'g', groupby: ['x'] }], sequence: [{ type: 'sequence', start: 0, stop: 3 }], pie: [{ type: 'pie', field: 'v' }],
  identifier: [{ type: 'identifier', as: 'n' }], formula: [{ type: 'formula', expr: '1', as: 'q' }], stack: [{ type: 'stack', field: 'v' }],
  countpattern: [{ type: 'countpattern', field: 't' }], geopoint: [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }],
  geojson: [{ type: 'geojson', fields: ['lon', 'lat'] }], crossfilter: [{ type: 'crossfilter', fields: ['v'], query: [[0, 4]] }],
  treelinks: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, { type: 'tree', size: [10, 10] }, { type: 'treelinks' }],
}
const spec = (transform: Obj[]): Obj => {
  const last = { ...transform[transform.length - 1], signal: 'S' }
  return {
    projections: [{ name: 'p', type: 'mercator' }],
    data: [{ name: 'src', values: structuredClone(ROWS), transform: [...transform.slice(0, -1), last] }, { name: 'o', values: [{}], transform: [{ type: 'formula', as: 's', expr: 'S' }] }],
  }
}
/** The value read through the formula: data, with functions and the crossfilter's bitmaps kept out. */
const plain = (v: unknown): string => JSON.stringify(v, (k, x: unknown) =>
  // (vega's bins are a function carrying start / stop / step: its own data; a method of an object is no data)
  typeof x === 'function' ? (k === '' ? { ...(x as unknown as Obj) } : undefined) : x instanceof Date ? `Date(${x.getTime()})` : x)
/** vega's LCG, the source both sides draw from (sample). */
const lcg = (seed: number): (() => number) => () => (seed = (1103515245 * seed + 12345) % 2147483647) / 2147483647

describe("a transform signal is what vega binds it to, or an opaque object for vega's internal state", () => {
  it('every transform type is modelled or refused, and every modelled one has a case here', () => {
    const modelled = [...TRANSFORM_TYPES].filter((t) => signalValueOf(t) !== undefined)
    expect(modelled.filter((t) => !CASES[t]).sort()).toEqual([])
  })
  for (const [type, transform] of Object.entries(CASES)) {
    it(type, async () => {
      const s = spec(transform)
      ;(vega as unknown as { setRandom(r: () => number): void }).setRandom(lcg(5))
      const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none', logLevel: vega.None })
      await view.runAsync()
      const want = plain((view.data('o') as Obj[])[0]!.s)
      view.finalize()
      const got = plain((datasetsOfScene(evaluateChart(compileChart(structuredClone(s) as never), { random: lcg(5) })).get('o') as Obj[])[0]!.s)
      expect(got).toBe(want)
    })
  }
  // (each with the parameters its definition requires, so the signal is what is refused)
  interface P { name: string; type: string; required?: boolean; array?: boolean; values?: unknown[] }
  const definition = (type: string): { params: P[] } => (vega as unknown as { definition(t: string): { params: P[] } }).definition(type)
  const value = (p: P): unknown => p.type === 'expr' ? 'true' : p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'projection' ? 'p'
    : p.type === 'compare' ? { field: 'a' } : p.type === 'enum' ? p.values?.[0] : 'a'
  for (const type of [...TRANSFORM_TYPES].filter((t) => signalValueOf(t) === undefined)) {
    it(`${type}: compiles with a signal`, () => {
      const t: Obj = { type, signal: 'S' }
      for (const p of definition(type).params) {
        if (p.type === 'index') Object.assign(t, { from: 'other', key: 'a' })
        else if (p.required) t[p.name] = p.array ? [value(p)] : value(p)
      }
      const s = { projections: [{ name: 'p', type: 'mercator' }], data: [{ name: 'other', values: [{ a: 1 }] }, { name: 'src', values: [{ a: 1 }], transform: [t] }] }
      // (it compiles: no refusal)
      expect(() => compileChart(s as never)).not.toThrow()
    })
  }

  const OPAQUE: Record<string, Obj[]> = {
    aggregate: [{ type: 'aggregate', groupby: ['g'] }], filter: [{ type: 'filter', expr: 'datum.v > 1' }], window: [{ type: 'window', ops: ['row_number'] }],
    project: [{ type: 'project', fields: ['v'] }], force: [{ type: 'force', static: true, iterations: 2 }],
    stratify: [{ type: 'stratify', key: 'id', parentKey: 'parent' }],
  }
  for (const [type, transform] of Object.entries(OPAQUE)) {
    it(`${type}: an opaque object, the same every evaluation, which a require waits on`, async () => {
      const s = spec(transform)
      ;(s.data as Obj[]).push({ name: 'r', values: [{ a: 1 }], transform: [{ type: 'linkpath', sourceX: 'a', sourceY: 'a', targetX: 'a', targetY: 'a', require: { signal: 'S' } }] })
      const chart = compileChart(structuredClone(s) as never)
      const read = (): unknown => (datasetsOfScene(evaluateChart(chart, {})).get('o') as Obj[])[0]!.s
      const first = read()
      expect(typeof first === 'object' && first !== null && Object.keys(first).length === 0, String(first)).toBe(true)
      expect(read()).toBe(first)
      const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none', logLevel: vega.None })
      await view.runAsync()
      expect(JSON.stringify(datasetsOfScene(evaluateChart(chart, {})).get('r'))).toBe(JSON.stringify(view.data('r')))
      view.finalize()
    })
  }
})
