import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { axisValue } from './spec-structure.js'
import { propsOf } from './guide-encode.js'

/**
 * vega's axis config precedence (axis < axisX/axisY < axis<Orient> < axisBand, the axis's own value over all) is written three times:
 * the compile check's `axisValue` (spec-structure.ts), the compiler's merged defaults, and the guide builder's `propsOf` over them
 * (C717). They must agree for every orient, scale kind and combination of blocks.
 */
const BLOCKS = ['axis', 'axisX', 'axisY', 'axisTop', 'axisBottom', 'axisLeft', 'axisRight', 'axisBand'] as const

describe('the three readings of axis config precedence agree', () => {
  it('every orient x band or not x every subset of the config blocks x the axis giving the value or not', () => {
    let n = 0
    for (const orient of ['top', 'bottom', 'left', 'right']) {
      for (const band of [false, true]) {
        for (let mask = 0; mask < 1 << BLOCKS.length; mask++) {
          for (const own of [undefined, 'own']) {
            const config: Record<string, unknown> = {}
            BLOCKS.forEach((b, i) => { if (mask & (1 << i)) config[b] = { labelColor: b } })
            const axis = { scale: 's', orient, ...(own ? { labelColor: own } : {}) }
            const spec = { config, scales: [{ name: 's', type: band ? 'band' : 'linear', domain: [0, 1], range: [0, 1] }], axes: [axis] }
            const compiled = compileChart(spec as never).axes[0] as unknown as Record<string, unknown>
            const merged = compiled.labelColor
            const read = axisValue(axis, 'labelColor', () => (band ? 'band' : 'linear'), config)
            const props = propsOf((compiled.own ?? {}) as Record<string, unknown>, (compiled.cfg ?? {}) as Record<string, unknown>).get('labelColor')
            // (a block the spec does not have leaves the default config's value, the same in all three)
            const label = `${orient} ${band} ${mask} ${own}`
            expect(props, label).toBe(merged)
            if (mask || own) expect(read, label).toBe(merged)
            n++
          }
        }
      }
    }
    expect(n).toBe(4 * 2 * 256 * 2)
  })
})
