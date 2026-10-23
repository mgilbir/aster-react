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
import { buildA11yTree, compileChart, evaluateChart, getChartInfo, renderSceneToSvg, renderSpec } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { parseSvg, type XmlEl } from './svg-parse.js'

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

  it('a hyperlinked group item sits inside its <a> (vega draws the link around the group)', async () => {
    const spec: Spec = {
      ...FRAME, data: DATA, marks: [{
        type: 'group', from: { data: 't' }, encode: { update: { x: { field: 'a' }, y: { value: 5 }, width: { value: 20 }, height: { value: 20 }, stroke: { value: '#c00' }, href: { field: 'h' } } },
        marks: [{ type: 'symbol', encode: { update: { x: { value: 5 }, y: { value: 5 } } } }],
      }],
    }
    expect(await compare(spec)).toEqual([])
    expect(diffCanonical(canonicalizeSvg(renderSpec(spec as never)), canonicalizeSvg(domSvg(spec)))).toEqual([])
    expect(renderSpec(spec as never)).toContain('<a xlink:href="https://example.test/u?x=1&amp;y=&quot;2&quot;">')
  })

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
  it('a host that has a container passes its size: containerSize() reads it, like vega\'s view container', async () => {
    const spec = body({ autosize: { type: 'fit', contains: 'padding' }, signals: sizeSignals() })
    // vega: a container element of known size (jsdom has no layout, so give it one)
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 420 })
    Object.defineProperty(el, 'clientHeight', { value: 260 })
    document.body.appendChild(el)
    const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { initialize(el: Element): unknown; runAsync(): Promise<unknown>; toSVG(): Promise<string>; finalize(): void } }).View(
      vega.parse(spec as never), { renderer: 'none' })
    view.initialize(el)
    await view.runAsync()
    const oracle = await view.toSVG()
    view.finalize()
    const ours = renderSpec(spec as never, { containerSize: { width: 420, height: 260 } })
    expect(oracle).toContain('width="420"')
    expect(diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))).toEqual([])
    // and without a container both fall back to the spec's own default
    expect(renderSpec(spec as never)).toContain('width="300"')
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

describe('mark sort (vega SortItems) orders the encoded items by their own properties', () => {
  const DATA2 = [{ name: 't', values: [{ a: 30, b: 20, g: 'p', w: 2 }, { a: 10, b: 60, g: 'p', w: 3 }, { a: 90, b: 40, g: 'p', w: 1 }, { a: 50, b: 10, g: 'q', w: 3 }, { a: 20, b: 80, g: 'q', w: 1 }] }]
  const enc: Record<string, Record<string, unknown>> = {
    line: { x: { field: 'a' }, y: { field: 'b' }, stroke: { value: '#c00' } },
    area: { x: { field: 'a' }, y: { field: 'b' }, y2: { value: 85 }, fill: { value: 'gold' } },
    trail: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 4 }, fill: { value: 'orange' } },
    symbol: { x: { field: 'a' }, y: { field: 'b' }, fill: { value: 'steelblue' } },
    rect: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 9 }, height: { value: 9 }, fill: { value: 'tomato' } },
    text: { x: { field: 'a' }, y: { field: 'b' }, text: { field: 'g' } },
  }
  const sorts: Array<[string, unknown]> = [
    ['the item property x', { field: 'x' }],
    ['the item property y, descending', { field: 'y', order: 'descending' }],
    ['a datum path', { field: 'datum.w' }],
    ['a bracket datum accessor (vega-lite getSort)', { field: ['datum["w"]'], order: ['descending'] }],
    ['two keys', { field: ['datum.g', 'x'], order: ['descending', 'ascending'] }],
  ]
  for (const type of Object.keys(enc)) for (const [name, sort] of sorts) {
    it(`${type} sorted by ${name}`, async () => {
      const spec: Spec = { ...FRAME, data: DATA2, marks: [{ type, sort, from: { data: 't' }, encode: { update: enc[type] } }] }
      expect(await compare(spec)).toEqual([])
    })
    it(`${type} sorted by ${name}, inside a facet`, async () => {
      const spec: Spec = {
        ...FRAME, data: DATA2,
        marks: [{
          type: 'group', from: { facet: { name: 'f', data: 't', groupby: ['g'] } },
          encode: { update: { width: { value: 100 }, height: { value: 80 } } },
          marks: [{ type, sort, from: { data: 'f' }, encode: { update: enc[type] } }],
        }],
      }
      expect(await compare(spec)).toEqual([])
    })
  }
})

describe('a11y: the legend caption names its channels like vega (LegendScales order) and honours aria: false', () => {
  const vegaLegendLabels = async (spec: Spec): Promise<string[]> => {
    const out: string[] = []
    const walk = (el: XmlEl): void => {
      if (el.attrs['aria-roledescription'] === 'legend' && el.attrs['aria-label']) {
        out.push(el.attrs['aria-label'].replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
      }
      for (const c of el.children) if (typeof c !== 'string') walk(c)
    }
    walk(parseSvg(await oracleSvg(spec)))
    return out.sort()
  }
  const ourLegendLabels = (spec: Spec): string[] => {
    const scene = evaluateChart(compileChart(spec as never))
    return buildA11yTree(scene, getChartInfo(spec as never).scales).nodes.filter((n) => n.kind === 'legend').map((n) => n.label).sort()
  }
  const base = (legend: Spec): Spec => ({
    width: 120, height: 90, padding: 5, autosize: 'none',
    data: [{ name: 't', values: [{ a: 1, c: 'u' }, { a: 5, c: 'v' }, { a: 9, c: 'w' }] }],
    scales: [
      { name: 'col', type: 'ordinal', domain: { data: 't', field: 'c' }, range: { scheme: 'category10' } },
      { name: 'sz', type: 'linear', domain: { data: 't', field: 'a' }, range: [20, 200] },
      { name: 'sw', type: 'linear', domain: { data: 't', field: 'a' }, range: [1, 6] },
      { name: 'op', type: 'linear', domain: { data: 't', field: 'a' }, range: [0.2, 1] },
      { name: 'shp', type: 'ordinal', domain: { data: 't', field: 'c' }, range: ['circle', 'square', 'diamond'] },
      { name: 'dash', type: 'ordinal', domain: { data: 't', field: 'c' }, range: [[1, 0], [4, 2], [2, 2]] },
    ],
    legends: [legend],
  })
  const channelSets: Spec[] = [
    { fill: 'col' }, { stroke: 'col' }, { size: 'sz' }, { shape: 'shp' }, { opacity: 'op' }, { strokeWidth: 'sw' }, { strokeDash: 'dash' },
    { fill: 'col', size: 'sz' }, { fill: 'col', shape: 'shp' }, { stroke: 'col', strokeWidth: 'sw' }, { fill: 'col', stroke: 'col' },
    { size: 'sz', shape: 'shp', fill: 'col' }, { strokeWidth: 'sw', strokeDash: 'dash' }, { fill: 'col', opacity: 'op' },
  ]
  for (const channels of channelSets) {
    it(`legend over ${Object.keys(channels).join('+')}`, async () => {
      const spec = base({ ...channels, title: 'T', type: 'symbol' })
      expect(ourLegendLabels(spec)).toEqual(await vegaLegendLabels(spec))
    })
  }
  it('aria: false drops the legend caption', async () => {
    const spec = base({ fill: 'col', aria: false })
    expect(await vegaLegendLabels(spec)).toEqual([])
    expect(ourLegendLabels(spec)).toEqual([])
  })
})

describe('symbol legends: every channel goes through vega\'s one symbol encode (legend-symbol-groups)', () => {
  const data = [{ name: 't', values: [{ a: 0, b: 4, c: 'u' }, { a: 5, b: 9, c: 'v' }, { a: 10, b: 1, c: 'w' }, { a: 20, b: 3, c: 'x' }] }]
  const scales = [
    { name: 'col', type: 'ordinal', domain: { data: 't', field: 'c' }, range: { scheme: 'category10' } },
    { name: 'sz', type: 'linear', domain: { data: 't', field: 'a' }, range: [0, 300], zero: true },
    { name: 'sz2', type: 'sqrt', domain: { data: 't', field: 'b' }, range: [10, 200] },
    { name: 'sw', type: 'linear', domain: { data: 't', field: 'a' }, range: [1, 6] },
    { name: 'op', type: 'linear', domain: { data: 't', field: 'a' }, range: [0.1, 1] },
    { name: 'shp', type: 'ordinal', domain: { data: 't', field: 'c' }, range: ['circle', 'square', 'triangle-up', 'diamond'] },
    { name: 'dash', type: 'ordinal', domain: { data: 't', field: 'c' }, range: [[1, 0], [4, 2], [2, 2], [8, 3]] },
    { name: 'seq', type: 'linear', domain: { data: 't', field: 'a' }, range: { scheme: 'blues' } },
  ]
  const frame = { width: 160, height: 100, padding: 5, autosize: 'none', data, scales }
  const channelSets: Array<[string, Spec]> = [
    ['size', { size: 'sz' }], ['size sqrt', { size: 'sz2' }], ['opacity', { opacity: 'op' }], ['strokeWidth', { strokeWidth: 'sw' }],
    ['strokeDash', { strokeDash: 'dash' }], ['shape', { shape: 'shp' }], ['fill', { fill: 'col' }], ['stroke', { stroke: 'col' }],
    ['fill+stroke', { fill: 'col', stroke: 'col' }], ['size+fill', { size: 'sz', fill: 'col' }], ['shape+fill', { shape: 'shp', fill: 'col' }],
    ['opacity+stroke', { opacity: 'op', stroke: 'col' }], ['size+strokeWidth', { size: 'sz', strokeWidth: 'sw' }],
    ['fill symbol (continuous ticks)', { fill: 'seq', type: 'symbol' }],
  ]
  const looks: Array<[string, Spec]> = [
    ['defaults', {}],
    ['square symbols', { symbolType: 'square' }],
    ['stroke symbols', { symbolType: 'stroke' }],
    ['triangle symbols', { symbolType: 'triangle-down' }],
    ['vega-lite style encode (fill + transparent stroke)', { symbolType: 'square', encode: { symbols: { update: { fill: { value: '#4c78a8' }, stroke: { value: 'transparent' } } } } }],
    ['vega-lite stroke encode', { encode: { symbols: { update: { stroke: { value: '#4c78a8' }, opacity: { value: 0.7 } } } } }],
    ['symbolSize + symbolStrokeWidth + dash', { symbolSize: 150, symbolStrokeWidth: 3, symbolDash: [3, 1] }],
    ['symbolFillColor + symbolStrokeColor + opacity', { symbolFillColor: 'orange', symbolStrokeColor: 'purple', symbolOpacity: 0.5 }],
    ['horizontal, bottom', { direction: 'horizontal', orient: 'bottom' }],
    ['two columns', { columns: 2 }],
  ]
  for (const [cname, channels] of channelSets) for (const [lname, look] of looks) {
    it(`${cname} / ${lname}`, async () => {
      const spec: Spec = { ...frame, legends: [{ type: 'symbol', title: 'T', ...channels, ...look }] }
      expect(await compare(spec)).toEqual([])
    })
  }
  const manyData = [{ name: 'm', values: Array.from({ length: 7 }, (_, i) => ({ k: `item ${i}`, n: (i + 1) * 3, w: i % 3 })) }]
  const manyScales = [
    { name: 'mcol', type: 'ordinal', domain: { data: 'm', field: 'k' }, range: { scheme: 'tableau10' } },
    { name: 'msz', type: 'ordinal', domain: { data: 'm', field: 'k' }, range: [30, 60, 90, 120, 150, 180, 40] },
  ]
  for (const extra of [
    { columns: 3 }, { columns: 3, gridAlign: 'all' }, { columns: 2, direction: 'horizontal' }, { direction: 'horizontal', gridAlign: 'all' },
    { columns: 0 }, { gridAlign: 'all' }, { symbolLimit: 4 }, { columns: 3, rowPadding: 6, columnPadding: 14 }, { titleOrient: 'left', columns: 2 },
    { padding: 6, columns: 2 }, { symbolOffset: 3, columns: 2 }, { clipHeight: 20, columns: 2 },
  ]) {
    for (const ch of [{ fill: 'mcol' }, { size: 'msz', fill: 'mcol' }]) {
      it(`grid of entries ${JSON.stringify(ch)} ${JSON.stringify(extra)}`, async () => {
        expect(await compare({ ...frame, data: manyData, scales: manyScales, legends: [{ type: 'symbol', title: 'Items', ...ch, ...extra }] })).toEqual([])
      })
    }
  }
  it('a size legend drops its first value when it maps to size 0 (vega#717)', async () => {
    expect(await compare({ ...frame, legends: [{ size: 'sz', type: 'symbol' }] })).toEqual([])
  })
  it('explicit values, tickCount, tickMinStep', async () => {
    for (const extra of [{ values: [2, 7, 11] }, { tickCount: 3 }, { tickCount: 6 }, { tickMinStep: 10 }]) {
      expect(await compare({ ...frame, legends: [{ size: 'sz', type: 'symbol', ...extra }] })).toEqual([])
    }
  })
  it('the legend with the greatest priority channel supplies the entries (size before fill)', async () => {
    expect(await compare({ ...frame, legends: [{ fill: 'col', size: 'sz' }] })).toEqual([])
  })
  it('legend.disable is not a vega property: the legend is drawn', async () => {
    expect(await compare({ ...frame, legends: [{ fill: 'col', disable: true }] })).toEqual([])
  })
})

describe('C51: a nested group\'s axes follow config.axis like the view\'s', () => {
  const nested = (config: Spec, axes: Spec[], extra: Spec = {}): Spec => ({
    width: 200, height: 120, padding: 5, autosize: 'none', config,
    data: [{ name: 't', values: [{ c: 'a', v: 3 }, { c: 'b', v: 8 }, { c: 'c', v: 5 }] }],
    marks: [{
      type: 'group', encode: { update: { x: { value: 20 }, y: { value: 10 }, width: { value: 150 }, height: { value: 80 }, stroke: { value: '#ccc' } } },
      scales: [
        { name: 'gx', type: 'band', domain: { data: 't', field: 'c' }, range: [0, 150], padding: 0.2 },
        { name: 'gy', type: 'linear', domain: { data: 't', field: 'v' }, range: [80, 0], nice: true },
      ],
      axes,
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'gx', field: 'c' }, width: { scale: 'gx', band: 1 }, y: { scale: 'gy', field: 'v' }, y2: { scale: 'gy', value: 0 }, fill: { value: 'steelblue' } } } }],
      ...extra,
    }],
  })
  const axes = [{ scale: 'gx', orient: 'bottom', title: 'cat' }, { scale: 'gy', orient: 'left', grid: true, title: 'value' }]
  const configs: Array<[string, Spec]> = [
    ['axis block', { axis: { domainColor: 'red', tickColor: 'blue', labelColor: 'green', gridColor: '#bbb', titleColor: 'purple', labelFontSize: 14 } }],
    ['axisX / axisY', { axisX: { labelAngle: 45, tickSize: 9 }, axisY: { labelPadding: 8, domain: false } }],
    ['axisBottom / axisLeft', { axisBottom: { tickColor: 'orange' }, axisLeft: { titleFontSize: 16 } }],
    ['axisBand (the band scale of the group)', { axisBand: { tickOffset: 3, labelColor: 'brown' } }],
    ['all blocks', { axis: { tickColor: 'gray' }, axisX: { tickSize: 8 }, axisBottom: { tickSize: 3 }, axisBand: { grid: true } }],
    ['no config', {}],
  ]
  for (const [name, config] of configs) {
    it(name, async () => expect(await compare(nested(config, axes))).toEqual([]))
  }
  it('a group axis over the VIEW\'s band scale also gets config.axisBand', async () => {
    const spec: Spec = {
      width: 200, height: 120, padding: 5, autosize: 'none', config: { axisBand: { labelColor: 'brown', tickOffset: 2 }, axis: { tickColor: 'red' } },
      data: [{ name: 't', values: [{ c: 'a', v: 3 }, { c: 'b', v: 8 }] }],
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' }],
      marks: [{ type: 'group', encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } }, axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }], marks: [] }],
    }
    expect(await compare(spec)).toEqual([])
  })
})

describe('C58: an axis `encode` block styles and moves the generated marks like vega', () => {
  const spec = (axis: Spec, scaleType = 'linear', extra: Spec = {}): Spec => {
    const horizontal = axis.orient === 'bottom' || axis.orient === 'top'
    const scales = scaleType === 'band'
      ? [{ name: 's', type: 'band', domain: ['alpha', 'beta', 'gamma'], range: horizontal ? 'width' : 'height', padding: 0.2 }]
      : scaleType === 'time'
        ? [{ name: 's', type: 'time', domain: [{ signal: 'datetime(2024, 0, 1)' }, { signal: 'datetime(2024, 11, 1)' }], range: horizontal ? 'width' : 'height' }]
        : [{ name: 's', type: 'linear', domain: [0, 100], range: horizontal ? 'width' : 'height', nice: true }]
    return { width: 220, height: 140, padding: 25, autosize: 'none', scales, axes: [{ scale: 's', ...axis }], ...extra }
  }
  const ORIENTS = ['bottom', 'left', 'top', 'right']
  const elements: Array<[string, Record<string, Spec>]> = [
    ['labels: constant text', { labels: { update: { text: { value: 'T' } } } }],
    ['labels: text from the signal', { labels: { update: { text: { signal: "datum.label + ' units'" } } } }],
    ['labels: text from the value field', { labels: { update: { text: { field: 'value' } } } }],
    ['labels: paint and font', { labels: { update: { fill: { value: 'crimson' }, fontSize: { value: 14 }, fontWeight: { value: 'bold' }, opacity: { value: 0.6 } } } }],
    ['labels: angle, align, baseline', { labels: { update: { angle: { value: 40 }, align: { value: 'left' }, baseline: { value: 'middle' } } } }],
    ['labels: dx / dy', { labels: { update: { dx: { value: 3 }, dy: { value: -2 } } } }],
    ['labels: conditional fill by tick index', { labels: { update: { fill: [{ test: 'datum.tickIndex === 0', value: 'red' }, { value: 'blue' }] } } }],
    ['labels: enter then update (update wins)', { labels: { enter: { fill: { value: 'red' }, fontSize: { value: 13 } }, update: { fill: { value: 'green' } } } }],
    ['ticks: stroke and width', { ticks: { update: { stroke: { value: 'orange' }, strokeWidth: { value: 3 }, opacity: { value: 0.5 } } } }],
    ['ticks: dash', { ticks: { update: { strokeDash: { value: [2, 2] } } } }],
    ['grid: stroke and dash', { grid: { update: { stroke: { value: 'teal' }, strokeDash: { value: [4, 2] }, strokeOpacity: { value: 0.5 } } } }],
    ['grid: per tick opacity', { grid: { update: { opacity: { signal: 'datum.index' } } } }],
    ['domain: stroke', { domain: { update: { stroke: { value: 'purple' }, strokeWidth: { value: 4 }, strokeDash: { value: [6, 3] } } } }],
    ['title: text and paint', { title: { update: { text: { value: 'Replaced' }, fill: { value: 'navy' }, fontSize: { value: 15 }, opacity: { value: 0.8 } } } }],
    ['title: angle and dx', { title: { update: { angle: { value: 25 }, dx: { value: 6 } } } }],
    ['axis: layout parameters', { axis: { update: { offset: { value: 8 }, position: { value: 12 }, titlePadding: { value: 15 }, minExtent: { value: 40 }, maxExtent: { value: 60 } } } }],
    ['axis: translate', { axis: { update: { translate: { value: 0 } } } }],
    ['all elements', {
      labels: { update: { fill: { value: 'crimson' } } }, ticks: { update: { stroke: { value: 'blue' } } },
      grid: { update: { stroke: { value: 'green' } } }, domain: { update: { stroke: { value: 'black' } } }, title: { update: { fill: { value: 'gold' } } },
    }],
  ]
  for (const orient of ORIENTS) for (const [name, encode] of elements) {
    it(`${orient} / ${name}`, async () => {
      expect(await compare(spec({ orient, title: 'Axis title', grid: true, encode }))).toEqual([])
    })
  }
  for (const scaleType of ['band', 'time']) for (const [name, encode] of elements.slice(0, 9)) {
    it(`${scaleType} scale / ${name}`, async () => {
      expect(await compare(spec({ orient: 'bottom', title: 'Axis title', encode }, scaleType))).toEqual([])
    })
  }
  it('an encode on an element the axis does not draw is ignored', async () => {
    expect(await compare(spec({ orient: 'left', labels: false, ticks: false, domain: false, encode: { labels: { update: { fill: { value: 'red' } } }, ticks: { update: { stroke: { value: 'red' } } }, domain: { update: { stroke: { value: 'red' } } } } }))).toEqual([])
  })
  it('labelExpr is not a vega axis property (ignored); format applies; an encode text wins', async () => {
    expect(await compare(spec({ orient: 'left', format: '.0f', labelExpr: "datum.label + '!'", encode: { labels: { update: { fill: { value: 'red' } } } } }))).toEqual([])
    expect(await compare(spec({ orient: 'left', labelExpr: "datum.label + '!'", encode: { labels: { update: { text: { signal: "'x' + datum.index" } } } } }))).toEqual([])
  })
})

describe('group marks are scopes: guides, titles, data, facets and grid layouts like vega (ViewLayout)', () => {
  const data = [{ name: 't', values: [
    { g: 'a', k: 'x', v: 3 }, { g: 'a', k: 'y', v: 8 }, { g: 'b', k: 'x', v: 5 }, { g: 'b', k: 'y', v: 2 },
    { g: 'c', k: 'x', v: 9 }, { g: 'c', k: 'y', v: 6 }, { g: 'd', k: 'x', v: 1 }, { g: 'd', k: 'y', v: 4 },
  ] }]
  const frame = { width: 400, height: 300, padding: 5, autosize: 'none', data }
  const barScales = [
    { name: 'bx', type: 'band', domain: { data: 't', field: 'k' }, range: [0, 80], padding: 0.2 },
    { name: 'by', type: 'linear', domain: { data: 't', field: 'v' }, range: [60, 0], nice: true },
    { name: 'bc', type: 'ordinal', domain: { data: 't', field: 'k' }, range: ['#4c78a8', '#f58518'] },
  ]
  const barMarks = [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'bx', field: 'k' }, width: { scale: 'bx', band: 1 }, y: { scale: 'by', field: 'v' }, y2: { scale: 'by', value: 0 }, fill: { scale: 'bc', field: 'k' },
  } } }]
  const cell = (extra: Spec = {}): Spec => ({
    type: 'group', style: 'cell', encode: { update: { width: { value: 80 }, height: { value: 60 } } },
    scales: barScales, marks: barMarks, axes: [{ scale: 'bx', orient: 'bottom', title: 'k' }, { scale: 'by', orient: 'left', title: 'v' }], ...extra,
  })

  describe('a nested group lays out its own axes, legends and title', () => {
    const variants: Array<[string, Spec]> = [
      ['axes only', {}],
      ['a nested legend (C51)', { legends: [{ fill: 'bc', title: 'kind' }] }],
      ['nested legends on every orient', { legends: [{ fill: 'bc', orient: 'left' }, { stroke: 'bc', orient: 'bottom', direction: 'horizontal' }, { size: 'bsz', orient: 'top' }] }],
      ['two legends on one orient (grid layout)', { legends: [{ fill: 'bc', title: 'one' }, { stroke: 'bc', title: 'two' }] }],
      ['title top', { title: { text: 'T' } }],
      ['title bottom, anchor start', { title: { text: 'T', orient: 'bottom', anchor: 'start' } }],
      ['title left frame group', { title: { text: 'T', orient: 'left', frame: 'group', offset: 12 } }],
      ['title right, end anchor, style guide-label', { title: { text: 'T', orient: 'right', anchor: 'end', style: 'guide-label' } }],
      ['title with subtitle', { title: { text: 'T', subtitle: 'sub', subtitleFontSize: 9 } }],
      ['title from a signal reading the facet datum is covered below; here a plain title, long, with a limit', { title: { text: 'A rather long group title', limit: 40 } }],
      ['clip', { clip: true }],
      ['clip with a rounded background', { clip: true, encode: { update: { width: { value: 80 }, height: { value: 60 }, cornerRadius: { value: 8 }, fill: { value: '#eef' }, stroke: { value: '#99c' } } } }],
      ['background paint and offset', { encode: { update: { x: { value: 12 }, y: { value: 7 }, width: { value: 80 }, height: { value: 60 }, fill: { value: '#fee' }, stroke: { value: '#c99' }, strokeWidth: { value: 2 } } } }],
    ]
    for (const [name, extra] of variants) {
      it(name, async () => {
        const scales = [...barScales, { name: 'bsz', type: 'linear', domain: { data: 't', field: 'v' }, range: [20, 120] }]
        const g = cell({ ...extra, scales })
        expect(await compare({ ...frame, marks: [g] })).toEqual([])
      })
    }
    it('a group two levels deep', async () => {
      const inner = cell({ title: { text: 'inner' }, legends: [{ fill: 'bc' }] })
      const outer: Spec = { type: 'group', encode: { update: { x: { value: 20 }, y: { value: 10 }, width: { value: 220 }, height: { value: 180 }, stroke: { value: '#999' } } }, title: { text: 'outer' }, marks: [inner], axes: [] }
      expect(await compare({ ...frame, marks: [outer] })).toEqual([])
    })
    it('a group with no marks, only axes', async () => {
      expect(await compare({ ...frame, marks: [{ type: 'group', encode: { update: { width: { value: 80 }, height: { value: 60 } } }, scales: barScales, axes: [{ scale: 'bx', orient: 'bottom' }] }] })).toEqual([])
    })
  })

  describe('facets, data-driven groups and group data', () => {
    const facetCell = (groupby: unknown, extra: Spec = {}): Spec => ({
      type: 'group', from: { facet: { name: 'f', data: 't', groupby } }, encode: { update: { width: { value: 80 }, height: { value: 60 } } },
      title: { text: { signal: 'parent.g' }, style: 'guide-label', frame: 'group', offset: 8 },
      scales: [{ name: 'fx', type: 'band', domain: { data: 'f', field: 'k' }, range: [0, 80] }, { name: 'fy', type: 'linear', domain: { data: 'f', field: 'v' }, range: [60, 0], zero: true }],
      axes: [{ scale: 'fx', orient: 'bottom' }, { scale: 'fy', orient: 'left' }],
      marks: [{ type: 'rect', from: { data: 'f' }, encode: { update: { x: { scale: 'fx', field: 'k' }, width: { scale: 'fx', band: 1 }, y: { scale: 'fy', field: 'v' }, y2: { scale: 'fy', value: 0 }, fill: { value: 'teal' } } } }],
      ...extra,
    })
    for (const [name, groupby] of [['an array', ['g']], ['a string', 'g'], ['two fields', ['g', 'k']]] as Array<[string, unknown]>) {
      it(`facet by ${name}, wrapped in two columns`, async () => {
        expect(await compare({ ...frame, layout: { columns: 2, padding: 20, bounds: 'full', align: 'all' }, marks: [facetCell(groupby)] })).toEqual([])
      })
    }
    it('facet sorted descending by the key', async () => {
      expect(await compare({ ...frame, layout: { columns: 2, padding: 15, bounds: 'full', align: 'each' }, marks: [facetCell(['g'], { sort: { field: 'datum.g', order: 'descending' } })] })).toEqual([])
    })
    it('a facet key with a dot is a literal field name when escaped', async () => {
      const dotted = [{ name: 't', values: [{ 'o.g': 'p', k: 'x', v: 2 }, { 'o.g': 'q', k: 'x', v: 5 }, { 'o.g': 'p', k: 'y', v: 7 }] }]
      const c = facetCell(['o\\.g'], { title: { text: { signal: 'parent["o.g"]' }, style: 'guide-label', frame: 'group' } })
      expect(await compare({ ...frame, data: dotted, layout: { columns: 2, padding: 20, bounds: 'full', align: 'all' }, marks: [c] })).toEqual([])
    })
    it('one group per datum of a dataset, with the datum in its encode', async () => {
      const spec: Spec = {
        ...frame, layout: { columns: 4, padding: 10, bounds: 'full', align: 'each' },
        marks: [{ type: 'group', from: { data: 't' }, encode: { update: { width: { signal: 'datum.v * 8' }, height: { value: 30 }, stroke: { value: '#c00' } } },
          marks: [{ type: 'text', encode: { update: { text: { signal: 'parent.k' }, x: { value: 2 }, y: { value: 12 } } } }] }],
      }
      expect(await compare(spec)).toEqual([])
    })
    it('group-level data derived from the facet partition', async () => {
      const c = facetCell(['g'], {
        data: [{ name: 'big', source: 'f', transform: [{ type: 'filter', expr: 'datum.v > 3' }] }],
        marks: [{ type: 'rect', from: { data: 'big' }, encode: { update: { x: { scale: 'fx', field: 'k' }, width: { scale: 'fx', band: 1 }, y: { scale: 'fy', field: 'v' }, y2: { scale: 'fy', value: 0 }, fill: { value: 'orange' } } } }],
      })
      expect(await compare({ ...frame, layout: { columns: 2, padding: 20, bounds: 'full', align: 'all' }, marks: [c] })).toEqual([])
    })
    it('a facet aggregate positions the group (stack_group_main) and its children shift back', async () => {
      const spec: Spec = {
        ...frame,
        scales: [{ name: 'sx', type: 'band', domain: { data: 't', field: 'g' }, range: [0, 300], padding: 0.1 }, { name: 'sy', type: 'linear', domain: { data: 't', field: 'v' }, range: [200, 0], zero: true, nice: true }],
        marks: [{
          type: 'group', from: { facet: { name: 'stack', data: 't', groupby: ['g'], aggregate: { fields: ['v', 'v'], ops: ['min', 'max'] } } },
          encode: { update: { x: { scale: 'sx', field: 'g' }, width: { signal: "bandwidth('sx')" }, y: { signal: "scale('sy', datum.max_v)" }, y2: { signal: "scale('sy', 0)" }, clip: { value: true }, cornerRadius: { value: 6 } } },
          marks: [{ type: 'group', encode: { update: { y: { field: { group: 'y' }, mult: -1 }, width: { field: { group: 'width' } } } }, marks: [{
            type: 'rect', from: { data: 'stack' }, encode: { update: { width: { field: { group: 'width' } }, y: { scale: 'sy', field: 'v' }, y2: { scale: 'sy', value: 0 }, fill: { value: '#4c78a8' }, stroke: { value: '#fff' } } },
          }] }],
        }],
        axes: [{ scale: 'sx', orient: 'bottom' }, { scale: 'sy', orient: 'left' }],
      }
      expect(await compare(spec)).toEqual([])
    })
  })

  describe('the grid layout of child groups and the header / footer / title groups around it', () => {
    const cellsOf = (n: number, w = 70, h = 50): Spec[] => Array.from({ length: n }, (_, i) => ({
      type: 'group', style: 'cell', encode: { update: { width: { value: w + (i % 3) * 10 }, height: { value: h + (i % 2) * 8 } } },
      axes: i % 2 ? [{ scale: 'bx', orient: 'bottom' }] : [{ scale: 'by', orient: 'left' }],
      marks: [{ type: 'rect', encode: { update: { x: { value: 2 }, y: { value: 2 }, width: { value: 20 + i * 4 }, height: { value: 18 }, fill: { value: '#4c78a8' } } } }],
    }))
    const wrap = (layout: Spec, groups: Spec[], extra: Spec = {}): Spec => ({ ...frame, scales: barScales, layout, marks: groups, ...extra })
    const layouts: Array<[string, Spec]> = [
      ['columns 3, align each, full bounds', { columns: 3, align: 'each', bounds: 'full', padding: 12 }],
      ['columns 2, align all, flush bounds', { columns: 2, align: 'all', bounds: 'flush', padding: 9 }],
      ['no align', { columns: 3, bounds: 'full', padding: 7 }],
      ['row / column align and padding objects', { columns: 3, align: { row: 'each', column: 'all' }, padding: { row: 5, column: 15 }, bounds: 'full' }],
      ['centered rows', { columns: 3, align: 'each', padding: 10, center: { row: true, column: true }, bounds: 'full' }],
      ['one column', { columns: 1, align: 'all', padding: 10, bounds: 'full' }],
      ['anchored', { columns: 3, padding: 10, bounds: 'full', anchor: { x: 30, y: 20, column: 'middle', row: 'end' } }],
      ['columns from a signal', { columns: { signal: '2 + 1' }, padding: 10, align: 'each', bounds: 'full' }],
    ]
    for (const [name, layout] of layouts) {
      it(name, async () => expect(await compare(wrap(layout, cellsOf(6)))).toEqual([]))
    }
    const headers = (n: number): Spec[] => [
      { type: 'group', role: 'column-title', title: { text: 'Columns', style: 'guide-title', offset: 6 } },
      { type: 'group', role: 'row-title', title: { text: 'Rows', style: 'guide-title', offset: 6, orient: 'left' } },
      { type: 'group', role: 'column-header', from: { data: 'hd' }, encode: { update: { width: { value: 70 } } }, title: { text: { signal: 'parent.name' }, style: 'guide-label', frame: 'group', offset: 4 } },
      { type: 'group', role: 'column-footer', from: { data: 'hd' }, encode: { update: { width: { value: 70 } } }, title: { text: { signal: 'parent.name' }, style: 'guide-label', frame: 'group', orient: 'bottom', offset: 4 } },
      { type: 'group', role: 'row-header', encode: { update: { height: { value: 50 } } }, axes: [{ scale: 'by', orient: 'left', title: 'v' }] },
      ...cellsOf(n),
    ]
    const hd = { name: 'hd', values: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] }
    const headerLayouts: Array<[string, Spec]> = [
      ['headers and titles, column align all', { columns: 3, padding: 20, bounds: 'full', align: 'all', offset: { columnTitle: 10, rowTitle: 8, rowHeader: 3, columnHeader: 3, columnFooter: 5 } }],
      ['headers, flush bounds', { columns: 3, padding: 20, bounds: 'flush', align: 'each', offset: { columnTitle: 10 } }],
      ['title anchors at the end', { columns: 3, padding: 20, bounds: 'full', align: 'all', titleAnchor: { column: 'end', row: 'end' }, offset: { columnTitle: 10, rowTitle: 10 } }],
      ['header band', { columns: 3, padding: 20, bounds: 'full', align: 'all', headerBand: { row: 0.5, column: 0.25 }, footerBand: { column: 0.75 }, offset: { columnTitle: 10 } }],
    ]
    for (const [name, layout] of headerLayouts) {
      it(name, async () => expect(await compare({ ...frame, data: [...data, hd], scales: barScales, layout, marks: headers(3) })).toEqual([]))
    }
    it('a layout the grid cannot take (fractional columns) is dropped like vega\'s failed ViewLayout', async () => {
      expect(await compare(wrap({ columns: 2.5, padding: 10, bounds: 'full' }, cellsOf(4)))).toEqual([])
    })
  })
})

describe('legend encode blocks (labels, title, symbols, legend) apply like vega', () => {
  const data = [{ name: 't', values: [{ a: 0, c: 'u' }, { a: 5, c: 'v' }, { a: 10, c: 'w' }, { a: 20, c: 'x' }] }]
  const scales = [
    { name: 'col', type: 'ordinal', domain: { data: 't', field: 'c' }, range: { scheme: 'category10' } },
    { name: 'seq', type: 'linear', domain: { data: 't', field: 'a' }, range: { scheme: 'blues' } },
    { name: 'sz', type: 'linear', domain: { data: 't', field: 'a' }, range: [20, 200] },
  ]
  const frame = { width: 160, height: 100, padding: 5, autosize: 'none', data, scales }
  const encodes: Array<[string, Spec]> = [
    ['labels: text from a signal', { labels: { update: { text: { signal: "datum.label + '!'" } } } }],
    ['labels: text from the index', { labels: { update: { text: { signal: "'#' + datum.index" } } } }],
    ['labels: paint and font', { labels: { update: { fill: { value: 'crimson' }, fontSize: { value: 13 }, fontWeight: { value: 'bold' } } } }],
    ['labels: align and baseline', { labels: { update: { align: { value: 'right' }, baseline: { value: 'top' } } } }],
    ['title: text and paint', { title: { update: { text: { value: 'Replaced' }, fill: { value: 'navy' }, fontSize: { value: 15 } } } }],
    ['title: font', { title: { update: { font: { value: 'monospace' }, fontWeight: { value: 'normal' } } } }],
    ['legend: orient, offset and padding', { legend: { update: { orient: { value: 'left' }, offset: { value: 4 }, padding: { value: 6 } } } }],
    ['legend: border and fill', { legend: { update: { fill: { value: '#f4f4ff' }, stroke: { value: '#99c' }, cornerRadius: { value: 6 }, padding: { value: 5 } } } }],
  ]
  for (const [name, encode] of encodes) {
    it(`symbol legend / ${name}`, async () => {
      expect(await compare({ ...frame, legends: [{ fill: 'col', title: 'T', encode }] })).toEqual([])
    })
    it(`gradient legend / ${name}`, async () => {
      expect(await compare({ ...frame, legends: [{ fill: 'seq', title: 'T', type: 'gradient', gradientLength: 90, encode }] })).toEqual([])
    })
  }
  it('symbols: a symbol placed by its own x / y encode', async () => {
    expect(await compare({ ...frame, legends: [{ fill: 'col', encode: { symbols: { update: { x: { value: 20 }, y: { signal: 'datum.index * 2' } } } } }] })).toEqual([])
  })
  it('orient none is placed by legendX / legendY (also signals)', async () => {
    expect(await compare({ ...frame, legends: [{ fill: 'col', orient: 'none', legendX: 30, legendY: { signal: '10 + 5' } }] })).toEqual([])
    expect(await compare({ ...frame, legends: [{ fill: 'col', orient: 'none', encode: { legend: { update: { x: { value: 12 }, y: { value: 40 } } } } }] })).toEqual([])
  })
  it('labelExpr is not a vega legend property (ignored)', async () => {
    expect(await compare({ ...frame, legends: [{ fill: 'col', labelExpr: "datum.label + '!'" }, { fill: 'seq', type: 'gradient', orient: 'left', labelExpr: "datum.label + '!'" }] })).toEqual([])
  })
})
