// @vitest-environment node
/**
 * A composite mark (boxplot, errorbar, errorband) in a repeat, against vega-lite 6.4.3: every composite x every form of repeat (a list, a
 * row, a column, a grid, a layer) x the place of the repeated field x the compositions around it (a facet, a concat, a layer, another
 * repeat) x sizes, config, transforms and selections. The comparison is the composite-mark matrix's (vl-composite-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-composite-repeat-cases.js'

for (const [title, cases] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of cases) it(name, () => compare(spec), 30_000)
  })
}

/**
 * A selection a repeat gives to every unit below it reaches a composite mark as the layer it has become, one copy of the selection's
 * signals per part. For a boxplot that is a Vega spec Vega itself rejects (vega-lite's compile succeeds and its output does not
 * parse), so the selection is refused there. (An errorbar or errorband without ticks, borders or other parts is one part: vega-lite's
 * output is valid for it, and @aster/vl refuses it all the same.)
 */
describe('a selection a repeat gives to a repeated boxplot', async () => {
  const { compile } = await import('@aster/vl')
  const vl = await import('vega-lite')
  const vega = await import('vega')
  const spec = {
    data: { values: [{ c: 'A', v: 1, w: 2 }, { c: 'B', v: 3, w: 4 }, { c: 'A', v: 5, w: 6 }, { c: 'B', v: 7, w: 8 }] },
    params: [{ name: 'sel', select: { type: 'point', fields: ['c'] } }],
    repeat: { column: ['v', 'w'] },
    spec: { mark: 'boxplot', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: { repeat: 'column' }, type: 'quantitative' }, opacity: { condition: { param: 'sel', value: 1 }, value: 0.3 } } },
  }
  it('is a Vega spec that Vega rejects when vega-lite compiles it', () => {
    const out = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
    expect(() => new (vega as any).View((vega as any).parse(out), { renderer: 'none' })).toThrow(/Duplicate signal name: "sel_tuple"/)
  })
  it('is refused', () => {
    expect(() => compile(JSON.parse(JSON.stringify(spec)) as never)).toThrow(/boxplot is a layer once vega-lite has normalized it/)
  })
})
