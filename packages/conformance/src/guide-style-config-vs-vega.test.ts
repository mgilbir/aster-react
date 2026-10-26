// @vitest-environment jsdom
/**
 * The config a guide reads, against real Vega: the named styles its marks take their defaults from (`guide-label`,
 * `guide-title`, `group-title`, `group-subtitle`), the guide blocks of the config (`axis`, `axisX`, `axisY`, `axisBand`,
 * `legend`, `title`) and the `lineBreak` of the text marks. vega-parser's `applyDefaults` fills every channel a guide mark
 * does not encode from its styles, and a `null` in a style is a null channel.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}
const differences = async (spec: Spec): Promise<string[]> => diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))

const ROWS = [{ k: 'a', v: 28 }, { k: 'b', v: 55 }, { k: 'c', v: 43 }]
const chart = (config: Spec, extra: Spec = {}): Spec => ({
  width: 120, height: 80, padding: 5, autosize: 'none', config, data: [{ name: 't', values: ROWS }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
    { name: 'cat', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['#e41a1c', '#377eb8', '#4daf4a'] },
    { name: 'lin', type: 'linear', domain: [0, 10], range: ['white', 'black'] },
    { name: 'qz', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
  ],
  axes: [{ orient: 'bottom', scale: 'x', title: 'X', grid: true }, { orient: 'left', scale: 'y', title: 'Y' }],
  legends: [{ fill: 'cat', title: 'Cat' }, { fill: 'lin', title: 'Lin', orient: 'bottom', direction: 'horizontal' }, { fill: 'qz', title: 'Bands' }],
  title: { text: 'Title', subtitle: 'Subtitle' },
  marks: [],
  ...extra,
})

describe('config.style on the marks of a guide', () => {
  const styles: Array<[string, Spec]> = [
    ['guide-label font, size and colour', { style: { 'guide-label': { font: 'serif', fontSize: 14, fill: '#b00' } } }],
    ['guide-label weight, style and opacity', { style: { 'guide-label': { fontWeight: 'bold', fontStyle: 'italic', fillOpacity: 0.5, opacity: 0.8 } } }],
    ['guide-label with null channels', { style: { 'guide-label': { fill: null, fontSize: null, font: null } } }],
    ['guide-title font, size and colour', { style: { 'guide-title': { font: 'monospace', fontSize: 15, fill: '#05a', fontWeight: 'normal' } } }],
    ['guide-title with null channels', { style: { 'guide-title': { fill: null, fontWeight: null } } }],
    ['group-title and group-subtitle', { style: { 'group-title': { fontSize: 20, fill: 'green', fontWeight: 'normal' }, 'group-subtitle': { fontSize: 9, fill: 'gray', fontStyle: 'italic' } } }],
    ['a style naming a signal', { style: { 'guide-label': { fontSize: { signal: '16' }, fill: { signal: '"purple"' } } } }],
    ['every guide style at once', { style: { 'guide-label': { fontSize: 13 }, 'guide-title': { fontSize: 14 }, 'group-title': { fontSize: 15 }, 'group-subtitle': { fontSize: 16 } } }],
  ]
  for (const [what, config] of styles) {
    it(what, async () => { expect(await differences(chart(config))).toEqual([]) })
  }
  it('a style the guide marks name through encode.<part>.style replaces the default one', async () => {
    const cfg = { style: { custom: { fill: 'tomato', fontSize: 18 }, 'guide-label': { fontSize: 14, fill: '#b00' } } }
    const spec = chart(cfg, {
      axes: [{ orient: 'bottom', scale: 'x', title: 'X', encode: { labels: { style: 'custom' }, title: { style: ['custom'] } } }],
      legends: [{ fill: 'cat', title: 'Cat', encode: { labels: { style: 'custom' }, title: { style: 'nope' } } }],
    })
    expect(await differences(spec)).toEqual([])
  })
})

describe('the guide blocks of the config', () => {
  const blocks: Array<[string, Spec]> = [
    ['axis: nulled defaults', { axis: { domainColor: null, tickColor: null, gridColor: null, labelColor: null, titleColor: null } }],
    ['axis: nulled font sizes', { axis: { labelFontSize: null, titleFontSize: null, labelPadding: null, tickSize: null } }],
    ['axis: nulled extents and offsets', { axis: { minExtent: null, maxExtent: null, tickOffset: null, labelOffset: null, titlePadding: null } }],
    ['axis: orient blocks', { axisX: { tickColor: 'red', labelAngle: 20 }, axisY: { tickColor: 'green', domain: false }, axisBottom: { titleColor: 'blue' }, axisLeft: { labelColor: 'orange' } }],
    ['axis: the band block', { axisBand: { tickOffset: 0, tickRound: false, bandPosition: 0.25 } }],
    ['axis: a null in an orient block over a default', { axis: { tickColor: 'red' }, axisX: { tickColor: null } }],
    ['legend: nulled defaults', { legend: { labelColor: null, titleColor: null, symbolSize: null, symbolStrokeWidth: null, gradientStrokeColor: null } }],
    ['legend: nulled sizes and limits', { legend: { labelFontSize: null, titleFontSize: null, labelLimit: null, titleLimit: null, labelOffset: null, gradientLength: 100 } }],
    ['legend: layout', { legend: { padding: 4, offset: 6, fillColor: '#fafafa', strokeColor: '#aaa', cornerRadius: 3, rowPadding: 6, columnPadding: 12 } }],
    ['legend: gradient and symbol knobs', { legend: { gradientThickness: 10, gradientOpacity: 0.7, gradientStrokeWidth: 1, symbolType: 'square', symbolStrokeColor: '#333', symbolOpacity: 0.5, symbolLimit: 2 } }],
    ['title: nulled defaults', { title: { color: null, fontSize: null, subtitleColor: null, subtitleFontSize: null, offset: null } }],
    ['title: set', { title: { anchor: 'start', orient: 'bottom', fontSize: 18, color: 'navy', subtitleColor: 'teal', offset: 10, subtitlePadding: 8, frame: 'group' } }],
    ['lineBreak', { lineBreak: '|' }],
  ]
  for (const [what, config] of blocks) {
    it(what, async () => { expect(await differences(chart(config))).toEqual([]) })
  }
})

describe('the matrix is not vacuous', () => {
  it('a guide style changes the document', async () => {
    const plain = renderSpec(chart({}) as never)
    expect(renderSpec(chart({ style: { 'guide-label': { fontSize: 14, fill: '#b00' } } }) as never)).not.toEqual(plain)
    expect(renderSpec(chart({ axis: { domainColor: null } }) as never)).not.toEqual(plain)
  })
})
