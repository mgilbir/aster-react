// @vitest-environment node
/**
 * A mark's `blend` is written into the SVG `style` attribute only as a `mix-blend-mode` keyword (core blend-mode.ts):
 *  - every keyword, whether a literal or computed from the data, renders as real vega renders it (strict differential);
 *  - from Vega-Lite (a literal `mark.blend`, an `{expr}` over the data, `config.mark.blend`), a value that is not a
 *    keyword writes no `mix-blend-mode` and adds no CSS declaration, while a keyword still reaches the markup.
 *
 * These run against the built packages (the `build` gate precedes `test`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compile } from '@aster-charts/vl'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>

async function oracleSvg(spec: Obj): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const KEYWORDS = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
  'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-darker', 'plus-lighter',
]

/** The declarations of every style attribute in a document. */
const declarations = (svg: string): string[] =>
  [...svg.matchAll(/ style="([^"]*)"/g)].flatMap((m) => m[1]!.split(/(?<=;) /))

describe('blend keywords render as vega renders them', () => {
  // one row per keyword: each rect's blend is read from its row
  const spec: Obj = {
    width: 400, height: 40, padding: 5, autosize: 'none',
    data: [{ name: 't', values: KEYWORDS.map((k, i) => ({ i, k })) }],
    marks: [
      { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'i', mult: 20 }, y: { value: 5 }, width: { value: 15 }, height: { value: 15 }, fill: { value: 'tomato' }, blend: { field: 'k' } } } },
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'i', mult: 20 }, y: { value: 30 }, fill: { value: 'teal' }, blend: { signal: 'datum.k' } } } },
    ],
  }

  it('from a data field and an expression', async () => {
    const ours = renderSpec(spec as never)
    for (const k of KEYWORDS) expect(ours, k).toContain(`mix-blend-mode: ${k};`)
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(ours))).toEqual([])
  })
})

describe('Vega-Lite: blend reaches the SVG only as a keyword', () => {
  const HOSTILE = [
    'multiply; fill: red',
    'multiply;background:url(https://example.invalid/x)',
    'multiply;background:\\75 rl(https://example.invalid/x)',
    'normal } * { color: red',
  ]
  const DATA = { values: HOSTILE.map((h, i) => ({ x: i, y: i + 1, h })) }
  const unit = (mark: Obj, extra: Obj = {}): Obj => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 120, height: 80, data: DATA, mark,
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }, ...extra,
  })
  const render = (vl: Obj): string => renderSpec(compile(vl as never) as never)

  const CASES: Array<[string, (blend: string) => Obj]> = [
    ['mark.blend literal', (b) => unit({ type: 'point', filled: true, blend: b })],
    ['mark.blend literal on a bar', (b) => unit({ type: 'bar', blend: b })],
    ['config.mark.blend', (b) => unit({ type: 'point' }, { config: { mark: { blend: b } } })],
    ['mark.blend as an expression', (b) => unit({ type: 'point', blend: { expr: JSON.stringify(b) } })],
  ]

  for (const [what, make] of CASES) {
    it(`${what}: a keyword is written`, () => {
      const svg = render(make('multiply'))
      expect(svg).toContain('mix-blend-mode: multiply;')
    })
    it(`${what}: a value that is not a keyword writes nothing`, () => {
      for (const h of HOSTILE) {
        // (a literal that is not one of the schema's blend modes is refused by its path before anything is drawn (C245); the
        // expression forms reach the sink, which writes only keywords)
        if (!what.includes('expression')) {
          expect(() => compile(make(h) as never), JSON.stringify(h)).toThrow(/\[aster\/vl\] (config\.)?mark\.blend: must be one of/)
          continue
        }
        const svg = render(make(h))
        expect(svg, JSON.stringify(h)).not.toContain('mix-blend-mode')
        expect(svg, JSON.stringify(h)).not.toMatch(/example\.invalid|fill: red|color: red/)
        expect(declarations(svg), JSON.stringify(h)).toEqual([])
      }
    })
  }

  it('an expression over the data: rows whose value is not a keyword get no mix-blend-mode', () => {
    const svg = render(unit({ type: 'point', filled: true, blend: { expr: 'datum.h' } }))
    expect(svg).not.toContain('mix-blend-mode')
    expect(svg).not.toMatch(/example\.invalid|fill: red|color: red/)
    expect(declarations(svg)).toEqual([])
    // the same spec over keyword rows does write them (the expression reaches the mark)
    const ok = render({ ...unit({ type: 'point', filled: true, blend: { expr: 'datum.h' } }), data: { values: [{ x: 0, y: 1, h: 'screen' }] } })
    expect(ok).toContain('mix-blend-mode: screen;')
  })
})
