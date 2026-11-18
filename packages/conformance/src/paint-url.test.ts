// @vitest-environment node
/**
 * Paint never references another document (core paint-url.ts):
 *  - a colour, `none`, or a reference within the page (`url(#hatch)`), from a literal or the data, renders as real
 *    vega renders it (strict differential);
 *  - from Vega-Lite (a colour field with `scale: null`, `mark.fill` / `mark.stroke`, `config.background`), a `url()`
 *    naming another document is never written.
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

const OTHER = /url\((?![ \t\n\r\f]*["']?#)/i
const unescape = (s: string): string =>
  s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, h: string | undefined, c: string | undefined) => (h ? String.fromCodePoint(parseInt(h, 16) || 0xfffd) : c!))
/** Every fill / stroke / style value of a document that names another document. */
const references = (svg: string): string[] =>
  [...svg.matchAll(/ (fill|stroke|style|stop-color)="([^"]*)"/g)].map((m) => m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    .filter((v) => OTHER.test(unescape(v)))

describe('paint that names no other document renders as vega renders it', () => {
  const SAFE = ['#336699', 'steelblue', 'rgb(10, 20, 30)', 'hsl(120, 50%, 40%)', 'none', 'url(#hatch)', 'url(#hatch) red', 'r\\65 d']
  const spec: Obj = {
    width: 200, height: 60, padding: 5, autosize: 'none', background: 'url(#bg) #fafafa',
    data: [{ name: 't', values: SAFE.map((p, i) => ({ i, p })) }],
    marks: [
      { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'i', mult: 22 }, y: { value: 5 }, width: { value: 15 }, height: { value: 15 }, fill: { field: 'p' }, stroke: { signal: 'datum.p' } } } },
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'i', mult: 22 }, y: { value: 40 }, fill: { field: 'p' } } } },
    ],
  }
  it('from a data field, an expression, and the background', async () => {
    const ours = renderSpec(spec as never)
    for (const p of SAFE) expect(ours, p).toContain(`fill="${p}"`)
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(ours))).toEqual([])
  })
})

describe('Vega-Lite: paint never names another document', () => {
  const HOSTILE = [
    'url(http://example.invalid/a.svg#g)',
    'url(http://example.invalid/a.svg#g) red',
    '\\75 rl(http://example.invalid/a.svg#g)',
    'red url(http://example.invalid/a.svg#g)',
  ]
  const DATA = { values: HOSTILE.map((h, i) => ({ x: i, y: i + 1, h })) }
  const unit = (mark: Obj | string, extra: Obj = {}, encoding: Obj = {}): Obj => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 120, height: 80, data: DATA, mark,
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, ...encoding }, ...extra,
  })
  const render = (vl: Obj): string => renderSpec(compile(vl as never) as never)

  it('a colour field read as it is (scale: null): every row', () => {
    for (const ch of ['color', 'fill', 'stroke']) {
      const svg = render(unit({ type: 'point', filled: ch !== 'stroke' }, {}, { [ch]: { field: 'h', type: 'nominal', scale: null } }))
      expect(references(svg), ch).toEqual([])
      // the rows were drawn: the fallback of the second row is there
      expect(svg, ch).toContain('"red"')
    }
  })

  const CASES: Array<[string, (p: string) => Obj]> = [
    ['mark.fill', (p) => unit({ type: 'bar', fill: p })],
    ['mark.stroke', (p) => unit({ type: 'point', stroke: p })],
    ['mark.color', (p) => unit({ type: 'area', color: p })],
    ['mark.fill as an expression', (p) => unit({ type: 'bar', fill: { expr: JSON.stringify(p) } })],
    ['config.background', (p) => unit('point', { config: { background: p } })],
    ['background', (p) => unit('point', { background: p })],
    ['config.view.fill', (p) => unit('point', { config: { view: { fill: p, stroke: p } } })],
  ]
  for (const [what, make] of CASES) {
    it(what, () => {
      for (const h of HOSTILE) expect(references(render(make(h))), `${what} ${JSON.stringify(h)}`).toEqual([])
      // a reference within the page still reaches the document
      expect(render(make('url(#hatch)')), what).toContain('url(#hatch)')
    })
  }
})
