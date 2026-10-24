// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { compile as vlCompile } from 'vega-lite'
import { compile } from '@aster/vl'

// The strict conformance oracle compares paint order, which depends on the order
// and zindex of the compiled axes. Vega-Lite emits all grid axes first, then the
// main axes, and gives a rect mark over a discrete field zindex 1.
const SPECS = [
  'area-layer-opacity', 'area-line', 'candlestick', 'dual-axis', 'error-bar',
  'heatmap', 'layer-line-area', 'line-area-layer', 'line-double-layer',
]
type Axis = Record<string, unknown>
const key = (a: Axis) => ({ scale: a.scale, orient: a.orient, grid: a.grid, zindex: a.zindex, gridScale: a.gridScale })

describe('axis assembly order and zindex match vega-lite', () => {
  for (const name of SPECS) {
    it(name, () => {
      const spec = JSON.parse(readFileSync(new URL(`../corpus/${name}.vl.json`, import.meta.url), 'utf8'))
      const oracle = (vlCompile(spec).spec as { axes?: Axis[] }).axes ?? []
      const ours = (compile(spec) as { axes?: Axis[] }).axes ?? []
      expect(ours.map(key)).toEqual(oracle.map(key))
    })
  }
})
