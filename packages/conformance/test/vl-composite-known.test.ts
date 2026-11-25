// @vitest-environment node
/**
 * The composite-mark specs that cannot sit in the matrix beside the others, each with the difference from vega-lite 6.4.3 it is held to.
 * A pinned difference is a claim: if it stops being true the case fails, and the spec belongs in the matrix (vl-composite-matrix-cases.ts).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { pickSpec, plain } from './vl-composite-pick.js'

const DATA = {
  values: Array.from({ length: 48 }, (_, i) => ({ c: ['A', 'B', 'C'][i % 3], x: i % 5, v: [3, 5, 4, 6, 5, 4, 7, 5, 6, 4, 5, 6, 40, 5, 6, 4, -30, 5, 4, 6][i % 20]! + (i % 7), w: (i * 3) % 11 })),
}
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const theirs = (spec: unknown): Record<string, any> => (vl as any).compile(plain(spec)).spec
const size = (svg: string): [number, number] => {
  const m = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg)
  if (!m) throw new Error('no size in the svg')
  return [Number(m[1]), Number(m[2])]
}
const textsIn = (svg: string): number => (svg.match(/<text /g) ?? []).length

describe('composite specs held to a known difference from vega-lite', () => {
  for (const [name, spec] of [
    ['area with config.area.opacity and a line', { data: DATA, config: { area: { line: true, opacity: 0.2 } }, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } }],
    ['area with config.mark.opacity and points', { data: DATA, config: { area: { point: true }, mark: { opacity: 0.9 } }, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }) } }],
  ] as Array<[string, Record<string, any>]>) {
    it(`${name}: the same picture, and now the same marks (a14 reads the config's opacity as vega-lite does)`, async () => {
      const oracle = theirs(spec)
      const ours = compile(plain(spec) as never) as Record<string, any>
      // (it was a known difference: Aster repeated the config opacity in the mark's encode, vega-lite leaves it to the config's style. It no longer
      // differs, so the entry is an agreement now and says so)
      expect(pickSpec(ours, 'aster')).toEqual(pickSpec(oracle, 'oracle'))
      expect(diffCanonical(canonicalizeSvg(await renderWithVega(oracle)), canonicalizeSvg(await renderWithVega(plain(ours))))).toEqual([])
    })
  }

  it('a boxplot with every part off: vega-lite draws an empty 10 x 10 view, Aster does not draw that', async () => {
    const spec = { data: DATA, mark: { type: 'boxplot', box: false, median: false, rule: false, outliers: false }, encoding: { x: n('c'), y: q('v') } }
    expect(size(await renderWithVega(theirs(spec)))).toEqual([10, 10])
    let ours: Record<string, any> | undefined
    try { ours = compile(plain(spec) as never) as Record<string, any> } catch (e) { expect(e).toBeInstanceOf(VLCompileError) }
    if (ours !== undefined) expect(size(await renderWithVega(plain(ours))), 'Aster draws what vega-lite does: move the spec to the matrix').not.toEqual([10, 10])
  })

  it('an errorbar over a nested field: vega-lite draws no data for it, and Aster refuses it', async () => {
    const spec = { data: { values: DATA.values.map((d) => ({ ...d, o: { v: d.v } })) }, mark: 'errorbar', encoding: { x: n('c'), y: q('o.v') } }
    const svg = await renderWithVega(theirs(spec))
    // (its y axis runs from 0 to 0 and carries one label, where the same chart over a flat field has a label for each tick and the x axis has none)
    const flat = { data: DATA, mark: 'errorbar', encoding: { x: n('c'), y: q('v') } }
    expect(textsIn(svg), 'vega-lite draws the nested field: move the spec to the matrix').toBeLessThan(textsIn(await renderWithVega(theirs(flat))))
    // (Aster refuses it, naming the field: a16, DECISIONS Q9)
    expect(() => compile(plain(spec) as never)).toThrow(/is a nested path or a name with a dot in it/)
  })

  it('an errorbar over a binned x: vega-lite draws it, Aster refuses it', async () => {
    const spec = { data: DATA, mark: 'errorbar', encoding: { x: q('x', { bin: true }), y: q('v') } }
    expect(textsIn(await renderWithVega(theirs(spec)))).toBeGreaterThan(4)
    expect(() => compile(plain(spec) as never)).toThrow(VLCompileError)
  })
})
