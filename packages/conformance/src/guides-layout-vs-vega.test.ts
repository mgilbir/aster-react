// @vitest-environment jsdom
/**
 * Targeted differentials against real Vega for the guide / layout / link work of
 * audit C51, C55, C58 and the corpus-vega-only drain: each block pins one class
 * of defect over the general shape of the problem (every mark type, every
 * channel, every orient), judged by the strict canonicalizer. They run against
 * the built `@aster/core` (the `build` gate precedes `test`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

/** Diffs (empty = identical) between real Vega and Aster for `spec`. */
async function compare(spec: Spec): Promise<string[]> {
  return diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))
}

/** The DOM renderer's serialization of a spec, in the string renderer's namespace spelling. */
function domSvg(spec: Spec): string {
  const scene = evaluateChart(compileChart(spec as never))
  return new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
    .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')
}

const FRAME = { width: 120, height: 90, padding: 5, autosize: 'none' }
const DATA = [{ name: 't', values: [
  { a: 10, b: 20, c: 'u', h: 'https://example.test/u?x=1&y="2"' },
  { a: 50, b: 60, c: 'v', h: 'rel/path' },
  { a: 90, b: 40, c: 'w', h: '//cdn.example.test/w' },
] }]
// Vega's own renderer leaves an unhandled promise rejection behind for a link its
// sanitizer refuses (SVGStringRenderer.href reads `attr.href` of null), so the
// oracle comparisons stay on links it accepts; the refused ones are Aster-only below.
const HOSTILE = [{ name: 't', values: [{ a: 10, b: 20, c: 'u', h: 'javascript:alert(1)' }, { a: 50, b: 60, c: 'v', h: ' JaVaScRiPt:alert(1)' }, { a: 90, b: 40, c: 'w', h: 'vbscript:x' }] }]
const MARKS: Record<string, Record<string, unknown>> = {
  symbol: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 120 }, fill: { value: 'steelblue' } },
  rect: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 14 }, height: { value: 22 }, fill: { value: 'tomato' } },
  rule: { x: { field: 'a' }, y: { value: 5 }, y2: { field: 'b' }, stroke: { value: '#222' } },
  text: { x: { field: 'a' }, y: { field: 'b' }, text: { field: 'c' }, fill: { value: 'purple' } },
  arc: { x: { value: 60 }, y: { value: 45 }, startAngle: { field: 'a', mult: 0.02 }, endAngle: { field: 'b', mult: 0.05 }, outerRadius: { value: 30 }, fill: { value: 'teal' } },
  area: { x: { field: 'a' }, y: { field: 'b' }, y2: { value: 85 }, fill: { value: 'gold' } },
  line: { x: { field: 'a' }, y: { field: 'b' }, stroke: { value: '#c00' } },
  trail: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 4 }, fill: { value: 'orange' } },
  path: { x: { value: 30 }, y: { value: 30 }, path: { value: 'M0,0L20,0L10,16Z' }, fill: { value: 'seagreen' } },
}

describe('href: every mark kind draws its items inside <a xlink:href> like vega-scenegraph', () => {
  for (const type of Object.keys(MARKS)) {
    const spec: Spec = { ...FRAME, data: DATA, marks: [{ type, from: { data: 't' }, encode: { update: { ...MARKS[type], href: { field: 'h' } } } }] }
    it(`${type}: matches real vega`, async () => {
      expect(await compare(spec)).toEqual([])
    })
    it(`${type}: the DOM renderer builds the same document`, () => {
      expect(diffCanonical(canonicalizeSvg(renderSpec(spec as never)), canonicalizeSvg(domSvg(spec)))).toEqual([])
    })
  }

  it('a script URL never reaches the markup, with or without a url policy', () => {
    const spec: Spec = { ...FRAME, data: DATA, marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { ...MARKS.symbol, href: { field: 'h' } } } }] }
    const hostile: Spec = { ...spec, data: HOSTILE }
    expect(renderSpec(hostile as never)).not.toMatch(/javascript|vbscript|<a /i)
    expect(domSvg(hostile)).not.toMatch(/javascript|vbscript|<a /i)
    // under `limits` the default policy refuses them outright (a typed error, like image urls)
    expect(() => renderSpec(hostile as never, { limits: { maxRows: 100 } } as never)).toThrow(/url denied/)
  })

  it('the url policy governs links: a denied scheme throws, onDeny drops the link only', () => {
    const spec: Spec = { ...FRAME, data: [{ name: 't', values: [{ a: 1, h: 'ftp://example.test/f' }] }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'a' }, y: { value: 5 }, href: { field: 'h' } } } }] }
    expect(() => renderSpec(spec as never, { urlPolicy: {} })).toThrow(/protocol ftp: is not allowed/)
    const denied: string[] = []
    const svg = renderSpec(spec as never, { urlPolicy: { onDeny: (u) => denied.push(u) } })
    expect(denied).toEqual(['ftp://example.test/f'])
    expect(svg).not.toContain('<a ')
    expect(svg).toContain('<path')
  })
})

describe('signal init and containerSize(): a container-sized spec falls back like headless vega', () => {
  const body = (extra: Spec): Spec => ({
    padding: 5, data: DATA,
    marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: 'width' }, height: { signal: 'height' }, fill: { value: '#ddd' } } } }],
    ...extra,
  })
  const sizeSignals = (w = 300, h = 200): Spec[] => [{
    name: 'width', init: `isFinite(containerSize()[0]) ? containerSize()[0] : ${w}`,
    on: [{ update: `isFinite(containerSize()[0]) ? containerSize()[0] : ${w}`, events: 'window:resize' }],
  }, {
    name: 'height', init: `isFinite(containerSize()[1]) ? containerSize()[1] : ${h}`,
    on: [{ update: `isFinite(containerSize()[1]) ? containerSize()[1] : ${h}`, events: 'window:resize' }],
  }]
  for (const autosize of ['pad', 'none', { type: 'fit', contains: 'padding' }, { type: 'fit-x', contains: 'padding' }, { type: 'fit-y', contains: 'padding' }, 'fit']) {
    it(`width and height from init, autosize ${JSON.stringify(autosize)}`, async () => {
      expect(await compare(body({ autosize, signals: sizeSignals() }))).toEqual([])
    })
  }
  it('only width is a container size', async () => {
    expect(await compare(body({ height: 77, autosize: { type: 'fit-x', contains: 'padding' }, signals: sizeSignals().slice(0, 1) }))).toEqual([])
  })
  it('a host-supplied signal wins over init', () => {
    const svg = renderSpec(body({ autosize: 'none', signals: [{ name: 'width', init: '123' }, { name: 'height', value: 40 }] }) as never, { signals: { width: 80 } })
    expect(svg).toContain('width="90"')
  })
  it('init runs once: an update-less signal reads its init in later expressions', async () => {
    const spec = body({ autosize: 'none', width: 60, height: 60, signals: [{ name: 'k', init: '7 * 3' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'k' }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'red' } } } }] })
    expect(await compare(spec)).toEqual([])
    expect(renderSceneToSvg(evaluateChart(compileChart(spec as never)))).toContain('M21,0')
  })
})

describe('C55: time gradient legends label and place their Date ticks like vega', () => {
  const timeSpec = (scaleType: string, legend: Spec, extra: Spec = {}): Spec => ({
    width: 200, height: 120, padding: 5, autosize: 'none',
    data: [{ name: 'd', values: [{ t: '2024-01-15' }, { t: '2024-03-10' }, { t: '2024-06-30' }, { t: '2024-11-03' }], format: { parse: { t: 'date' } } }],
    scales: [{ name: 'c', type: scaleType, domain: { data: 'd', field: 't' }, range: { scheme: 'blues' } }],
    legends: [{ fill: 'c', type: 'gradient', ...legend }], ...extra,
  })
  const cases: Array<[string, Spec]> = [
    ['time scale, no format (the locale multi-format, not ".1~f")', timeSpec('time', {})],
    ['utc scale, no format', timeSpec('utc', {})],
    ['explicit time format', timeSpec('time', { format: '%b %d, %Y' })],
    ['formatType utc on a time scale', timeSpec('time', { format: '%Y-%m-%d', formatType: 'utc' })],
    ['horizontal strip: the box grows to the overhanging last label', timeSpec('time', { orient: 'bottom', direction: 'horizontal', gradientLength: 220 })],
    ['horizontal strip with a title wider than the strip', timeSpec('time', { orient: 'bottom', direction: 'horizontal', gradientLength: 60, title: 'A long legend title' })],
    ['horizontal numeric strip keeps its box', { width: 200, height: 100, padding: 5, autosize: 'none', data: [{ name: 'd', values: [{ v: 1 }, { v: 9 }] }], scales: [{ name: 'c', type: 'linear', domain: { data: 'd', field: 'v' }, range: { scheme: 'viridis' } }], legends: [{ fill: 'c', type: 'gradient', orient: 'top', direction: 'horizontal', gradientLength: 100 }] }],
    ['explicit tick values', timeSpec('time', { values: [{ signal: "datetime(2024, 2, 1)" }, { signal: "datetime(2024, 8, 1)" }], format: '%b' })],
    ['labelOverlap with a tickCount', timeSpec('time', { tickCount: 12, gradientLength: 100 })],
  ]
  for (const [name, spec] of cases) it(name, async () => expect(await compare(spec)).toEqual([]))
})

describe('gradient legends are sized by the labels Overlap leaves visible', () => {
  const numeric = (legend: Spec, domain = [0, 1000]): Spec => ({
    width: 200, height: 120, padding: 5, autosize: 'none',
    data: [{ name: 'd', values: domain.map((v) => ({ v })) }],
    scales: [{ name: 'c', type: 'linear', domain: { data: 'd', field: 'v' }, range: { scheme: 'viridis' } }],
    legends: [{ fill: 'c', type: 'gradient', ...legend }],
  })
  for (const gl of [40, 64, 100, 200]) for (const tc of [3, 6, 12]) for (const method of [true, 'parity', 'greedy', false]) {
    it(`vertical gradientLength ${gl}, tickCount ${tc}, labelOverlap ${method}`, async () => {
      expect(await compare(numeric({ gradientLength: gl, tickCount: tc, labelOverlap: method }))).toEqual([])
    })
    it(`horizontal gradientLength ${gl * 2}, tickCount ${tc}, labelOverlap ${method}`, async () => {
      expect(await compare(numeric({ orient: 'bottom', direction: 'horizontal', gradientLength: gl * 2, tickCount: tc, labelOverlap: method }))).toEqual([])
    })
  }
})
