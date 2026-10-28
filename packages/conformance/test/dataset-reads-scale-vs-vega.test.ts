// @vitest-environment node
/**
 * A transform that reads a scale (`domain('x')`, `scale('x', v)`, `range('x')`) runs after the scale it reads: vega ranks the
 * transform's operator after the scale's. The datasets are compared (view.data) and the render.
 */
import { describe, it, expect } from 'vitest'
import '@aster/core/transforms'
import { renderSpec, evaluateChart, compileChart, datasetsOfScene } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const rows = [3, 8, 5, 12, 7, 20, 15, 2].map((x, i) => ({ x, y: x * 2 + (i % 3), g: i % 2 ? 'p' : 'q' }))
const spec = (transform: any[], extra: Record<string, unknown> = {}): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 200,
  height: 100,
  padding: 5,
  data: [{ name: 'src', values: rows }, { name: 'derived', source: 'src', transform }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'src', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 'src', field: 'y' }, range: 'height' }],
  marks: [
    { type: 'symbol', from: { data: 'src' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } },
    { type: 'line', from: { data: 'derived' }, encode: { update: { x: { scale: 'x', field: 'u' }, y: { scale: 'y', field: 'v' }, stroke: { value: 'firebrick' } } } },
  ],
  ...extra,
})
const CASES: Record<string, any> = {
  'a regression over the extent of a scale domain': spec([{ type: 'regression', x: 'x', y: 'y', extent: { signal: "domain('x')" }, as: ['u', 'v'] }]),
  'a regression per group, over the extent of a scale domain': spec([{ type: 'regression', groupby: ['g'], x: 'x', y: 'y', method: 'quad', extent: { signal: "domain('x')" }, as: ['u', 'v'] }]),
  'a formula that scales a field': spec([{ type: 'formula', expr: "scale('x', datum.x)", as: 'u' }, { type: 'formula', expr: "scale('y', datum.y)", as: 'v' }]),
  'a filter on the range of a scale': spec([{ type: 'filter', expr: "scale('x', datum.x) > range('x')[1] / 2" }, { type: 'formula', expr: 'datum.x', as: 'u' }, { type: 'formula', expr: 'datum.y', as: 'v' }]),
  'a dataset derived from the one that reads a scale': {
    ...spec([{ type: 'formula', expr: "scale('x', datum.x)", as: 'u' }, { type: 'formula', expr: 'datum.y', as: 'v' }]),
    data: [
      { name: 'src', values: rows },
      { name: 'derived', source: 'src', transform: [{ type: 'formula', expr: "scale('x', datum.x)", as: 'u' }, { type: 'formula', expr: 'datum.y', as: 'v' }] },
      { name: 'again', source: 'derived', transform: [{ type: 'formula', expr: 'datum.u + 1', as: 'u2' }] },
    ],
  },
}
describe('a transform that reads a scale', () => {
  for (const [name, s] of Object.entries(CASES)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const logger = { error: (e: unknown) => { errors.push(e) }, warn: () => {} }
      const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(s))), { logger } as never)
      expect(errors).toEqual([])
      const got: Record<string, unknown> = {}
      for (const d of s.data) got[d.name] = JSON.parse(JSON.stringify(datasetsOfScene(scene).get(d.name) ?? null))
      expect(got).toEqual(vega.datasets)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(renderSpec(JSON.parse(JSON.stringify(s)), { logger } as never) as string)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
