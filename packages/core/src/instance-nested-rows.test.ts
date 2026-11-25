// @vitest-environment node
/**
 * A mark inside a group item kept by comparing its rows with its items' data (`evaluateInstanceMark`) where the rows hold objects
 * (C541). An item's datum is a shallow copy of its row, so an object a row holds is the one the new row holds: a host that wrote into
 * it before handing new rows (a new array of new row objects, API.md's remedy) is not seen by the comparison. The mark is made again,
 * as the view's own marks are, so every step is the fresh evaluation's scene. Over a facet and a plain group, nested objects and
 * arrays, top-level and nested fields read.
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg, type VgSpec } from './index.js'

type Row = Record<string, unknown>
const leaf = (data: string): unknown => ({ type: 'text', from: { data }, encode: { update: { x: { field: 'o.q' }, y: { field: 'v' }, text: { signal: "datum.o.q + ':' + datum.arr[0]" } } } })
const SPECS: Record<string, VgSpec> = {
  'a facet': { width: 200, height: 100, data: [{ name: 't' }], marks: [{ type: 'group', from: { facet: { data: 't', name: 'f', groupby: 'g' } }, marks: [leaf('f')] }] } as unknown as VgSpec,
  'a plain group': { width: 200, height: 100, data: [{ name: 't' }], marks: [{ type: 'group', marks: [leaf('t')] }] } as unknown as VgSpec,
}

describe('a kept mark of a group item over rows that hold objects (C541)', () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: a write into a nested object, then new rows, is the fresh scene`, () => {
      const host: Row[] = [{ g: 'a', v: 1, o: { q: 1 }, arr: [1] }, { g: 'b', v: 2, o: { q: 2 }, arr: [2] }]
      const chart = compileChart(spec)
      evaluateChart(chart, { data: { t: host } })
      ;(host[0]!.o as Row).q = 50
      ;(host[1]!.arr as number[])[0] = 9
      const next = host.map((r) => ({ ...r }))
      const got = renderSceneToSvg(evaluateChart(chart, { data: { t: next } }))
      const fresh = renderSceneToSvg(evaluateChart(compileChart(spec), { data: { t: next } }))
      expect(got).toBe(fresh)
      expect(got).toContain('50:1')
      expect(got).toContain('2:9')
    })
  }
})
