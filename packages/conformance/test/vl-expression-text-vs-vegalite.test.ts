// @vitest-environment node
/**
 * Where @aster-charts/vl rewrites names inside the text it compiles (a voronoi cell's tooltip, the units and marks a named view relabels,
 * the layers of a repeat inside a facet), it reads that text as vega's lexer reads expressions (packages/vl/src/expr-tokens.ts): a name
 * inside a string literal, a title, a field called `datum` are text, and are given back as the user wrote them. Each case compares with
 * the real vega-lite 6.4.3 (its Vega, rendered by real vega where the scene says more than the spec).
 */
import { describe, expect, it } from 'vitest'
import * as vl from 'vega-lite'
import * as vega from 'vega'
import '@aster-charts/core/transforms'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { compile } from '@aster-charts/vl'

type Obj = Record<string, any>

/** Every string of a compiled spec that holds `needle`, in order. */
function stringsWith(spec: unknown, needle: string): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.includes(needle)) out.push(v) }
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(spec)
  return out
}

describe('names in text, against vega-lite', () => {
  it('a voronoi tooltip over a field called `datum`, and a title that says `datum`', async () => {
    const spec: Obj = {
      data: { values: [{ a: 1, datum: 5, b: 2 }, { a: 2, datum: 7, b: 3 }] },
      params: [{ name: 'p', select: { type: 'point', nearest: true, on: 'pointerover' } }],
      mark: 'point',
      encoding: {
        x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
        tooltip: [{ field: 'datum', type: 'quantitative' }, { field: 'a', type: 'quantitative', title: 'the datum of a' }],
      },
    }
    const cells = (root: Obj): unknown[] => {
      const out: unknown[] = []
      const walk = (n: Obj): void => {
        if (n.marktype === 'path' && String(n.name).endsWith('voronoi')) out.push(...n.items.map((i: Obj) => i.tooltip))
        for (const c of n.items ?? []) if (c.items) walk(c)
      }
      walk(root)
      return out
    }
    const view = new vega.View(vega.parse(vl.compile(structuredClone(spec)).spec as never), { renderer: 'none' })
    await view.runAsync()
    const want = cells((view.scenegraph() as Obj).root)
    view.finalize()
    expect(want).toEqual([{ datum: '5', 'the datum of a': '1' }, { datum: '7', 'the datum of a': '2' }])
    expect(cells(evaluateChart(compileChart(compile(structuredClone(spec)) as never)) as unknown as Obj)).toEqual(want)
  })

  it('a named view keeps a title that reads like a unit or a group call', () => {
    const t = 'unit: "layer_0" and group("cell")'
    const spec: Obj = { name: 'outer', title: t, data: { values: [{ a: 1, b: 2 }] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative', title: t } } }
    const want = stringsWith(vl.compile(structuredClone(spec)).spec, 'and group(').filter((x) => x === t)
    expect(want.length).toBeGreaterThan(0)
    expect(stringsWith(compile(structuredClone(spec)), 'and group(').filter((x) => x.includes('outer_layer_0') || x.includes('outer_cell'))).toEqual([])
    expect(stringsWith(compile(structuredClone(spec)), 'and group(').filter((x) => x === t).length).toBe(want.length)
  })

  it('a repeat of layers inside a facet keeps a title that holds the name its layers had', () => {
    const t = 'see child_layer_0_x'
    const spec: Obj = {
      data: { values: Array.from({ length: 4 }, (_, i) => ({ a: i, b: i * 2, c: i, g: i % 2 })) },
      facet: { column: { field: 'g', type: 'nominal' } },
      spec: { repeat: { layer: ['a', 'b'] }, spec: { mark: 'line', encoding: { x: { field: 'c', type: 'quantitative', title: t }, y: { field: { repeat: 'layer' }, type: 'quantitative' } } } },
    }
    const want = stringsWith(vl.compile(structuredClone(spec)).spec, 'see ')
    expect(want.length).toBeGreaterThan(0)
    expect(stringsWith(compile(structuredClone(spec)), 'see ')).toEqual(want)
    // (a field the user named as the layers were named is the user's: vega-lite reads it as it is)
    const named: Obj = { ...spec, data: { values: Array.from({ length: 4 }, (_, i) => ({ child_layer_0_v: i, b: i * 2, c: i, g: i % 2 })) },
      spec: { repeat: { layer: ['child_layer_0_v', 'b'] }, spec: { mark: 'line', encoding: { x: { field: 'c', type: 'quantitative' }, y: { field: { repeat: 'layer' }, type: 'quantitative' } } } } }
    const fields = (o: unknown): string[] => [...new Set(stringsWith(o, '_v').filter((x) => /^[\w]+$/.test(x) && x.includes('layer')))].sort()
    expect(fields(compile(structuredClone(named)))).toEqual(fields(vl.compile(structuredClone(named)).spec))
    // (the layers' own names are still the repeat values', as vega-lite names them)
    expect(stringsWith(compile(structuredClone(spec)), '__layer_a_').length).toBeGreaterThan(0)
  })
})
