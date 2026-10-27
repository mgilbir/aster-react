// @vitest-environment jsdom
/**
 * Legends over discretizing scales (quantize, quantile, threshold, bin-ordinal), against real Vega.
 *
 * vega-parser decides the legend's type from the scale (a lone fill / stroke legend over a discretizing scale is a
 * `discrete` legend: bands, labelled at their breakpoints; `type: symbol` lists intervals; `type: gradient` becomes
 * discrete), vega-encode's LegendEntries produces the entries (`labelValues` and `labelFormat`: one precision for all
 * the labels, from the smallest gap between breakpoints; `< 3`, `3 – 6`, `≥ 6` for the intervals of a symbol legend; the
 * first label of a discrete legend is empty), and the layout sizes the box from what was drawn. The strict canonicalizer
 * judges the documents (it includes the accessible captions), the DOM renderer must draw the same one, and the scene
 * differential's snapshot of the scale must give the same caption.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { buildA11yTree, compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
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
const domSvg = (spec: Spec): string => new XMLSerializer().serializeToString(renderSceneToDomElement(evaluateChart(compileChart(spec as never)), document) as unknown as Node)
  .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')

async function differences(spec: Spec): Promise<string[]> {
  const want = canonicalizeSvg(await oracleSvg(spec))
  const out = diffCanonical(want, canonicalizeSvg(renderSpec(spec as never)))
  if (out.length) return out
  return diffCanonical(want, canonicalizeSvg(domSvg(spec))).map((d) => `dom: ${d}`)
}

/** the cases whose document the canonicalizer cannot read */
const unreadable: string[] = []

const DATA = (values: number[]): Spec => ({ name: 't', values: values.map((v, i) => ({ v, i })) })
const frame = (extra: Spec): Spec => ({ width: 160, height: 100, padding: 5, autosize: 'none', ...extra })

/** The scales: each with several domains (integer, fractional, negative, tiny, huge gaps) and range sizes. */
const SCALES: Array<[string, Array<[string, Spec, Spec[]]>]> = [
  ['quantize', [
    ['integers', { type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] }, []],
    ['thirds', { type: 'quantize', domain: [0, 1], range: ['#eee', '#9bd', '#06c'] }, []],
    ['negative and positive', { type: 'quantize', domain: [-10, 10], range: ['#a00', '#eee', '#0a0', '#00a'] }, []],
    ['thousands', { type: 'quantize', domain: [0, 1000], range: ['#fee', '#fbb', '#f88', '#f44', '#f00'] }, []],
    ['tiny', { type: 'quantize', domain: [0.001, 0.002], range: ['#eee', '#9bd', '#06c'] }, []],
    ['millions', { type: 'quantize', domain: [1e6, 5e6], range: ['#eee', '#06c'] }, []],
    ['one band', { type: 'quantize', domain: [0, 10], range: ['#06c'] }, []],
    ['nice', { type: 'quantize', domain: [0.13, 9.7], nice: true, range: ['#eee', '#9bd', '#06c'] }, []],
    ['a degenerate domain', { type: 'quantize', domain: [5, 5], range: ['#eee', '#06c'] }, []],
  ]],
  ['quantile', [
    ['integers', { type: 'quantile', domain: { data: 't', field: 'v' }, range: ['#eee', '#9bd', '#06c'] }, [DATA([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]],
    ['fractions', { type: 'quantile', domain: { data: 't', field: 'v' }, range: ['#eee', '#9bd', '#06c', '#038'] }, [DATA([0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.3, 1.6, 2.2])]],
    ['clustered', { type: 'quantile', domain: { data: 't', field: 'v' }, range: ['#eee', '#9bd', '#06c'] }, [DATA([1, 1, 1, 1, 2, 2, 50, 50, 50, 100])]],
    ['negative', { type: 'quantile', domain: { data: 't', field: 'v' }, range: ['#eee', '#9bd', '#06c'] }, [DATA([-30, -20, -10, 0, 10, 20, 30, 40, 50])]],
    ['explicit domain', { type: 'quantile', domain: [3, 1, 4, 1, 5, 9, 2, 6], range: ['#eee', '#9bd'] }, []],
    ['five bands', { type: 'quantile', domain: { data: 't', field: 'v' }, range: ['#fee', '#fbb', '#f88', '#f44', '#f00'] }, [DATA([12, 18, 21, 37, 44, 52, 61, 70, 83, 99])]],
  ]],
  ['threshold', [
    ['integers', { type: 'threshold', domain: [3, 6], range: ['#eee', '#9bd', '#06c'] }, []],
    ['halves', { type: 'threshold', domain: [0.5, 1.5, 2.5], range: ['#eee', '#9bd', '#06c', '#038'] }, []],
    ['around zero', { type: 'threshold', domain: [-1, 0, 1], range: ['#a00', '#eee', '#0a0', '#00a'] }, []],
    ['thousands', { type: 'threshold', domain: [1000, 2000], range: ['#eee', '#9bd', '#06c'] }, []],
    ['small', { type: 'threshold', domain: [0.001, 0.01], range: ['#eee', '#9bd', '#06c'] }, []],
    ['one threshold', { type: 'threshold', domain: [50], range: ['#eee', '#06c'] }, []],
    ['uneven', { type: 'threshold', domain: [1, 2, 50, 51, 1000], range: ['#fee', '#fbb', '#f88', '#f44', '#f00', '#a00'] }, []],
    ['no thresholds', { type: 'threshold', domain: [], range: ['#06c'] }, []],
  ]],
  ['bin-ordinal', [
    ['tens', { type: 'bin-ordinal', domain: [0, 1, 2], range: ['#eee', '#9bd', '#06c'], bins: [0, 10, 20, 30] }, []],
    ['halves', { type: 'bin-ordinal', domain: [0, 1], range: ['#eee', '#06c'], bins: [0, 0.5, 1] }, []],
    ['a step object', { type: 'bin-ordinal', domain: [0, 1, 2, 3], range: ['#eee', '#9bd', '#06c', '#038'], bins: { start: 0, stop: 100, step: 25 } }, []],
  ]],
]

/** The legend variants: type, orient and direction, a title, a format, explicit values, tick counts and the other knobs. */
const LEGENDS: Array<[string, Spec]> = [
  ['auto, right', {}],
  ['auto, titled, left', { title: 'Bands', orient: 'left' }],
  ['auto, horizontal at the bottom', { orient: 'bottom', direction: 'horizontal', title: 'Bands' }],
  ['auto, horizontal at the top', { orient: 'top', direction: 'horizontal' }],
  ['auto, horizontal on the right', { direction: 'horizontal' }],
  ['auto, vertical at the bottom', { orient: 'bottom' }],
  ['auto, a long thin gradient', { gradientLength: 80, gradientThickness: 8, title: 'T' }],
  ['auto, a stroke, with padding and a fill', { padding: 6, fillColor: '#f4f4f4', strokeColor: '#999', cornerRadius: 4, title: 'Boxed' }],
  ['auto, label knobs', { labelFontSize: 14, labelColor: '#c00', labelOffset: 10, labelLimit: 30, labelOverlap: 'greedy', labelSeparation: 4 }],
  ['auto, a number format', { format: '.1f' }],
  ['auto, a percentage', { format: '.0%' }],
  ['auto, a currency', { format: '$,.2f' }],
  ['auto, an SI prefix', { format: '~s' }],
  ['auto, explicit values', { values: [2, 4, 6] }],
  ['auto, a tick count', { tickCount: 2 }],
  ['auto, bottom title', { title: 'Bands', titleOrient: 'bottom', titleAnchor: 'middle' }],
  ['symbol, right', { type: 'symbol', title: 'Intervals' }],
  ['symbol, columns', { type: 'symbol', columns: 2, orient: 'bottom' }],
  ['symbol, horizontal', { type: 'symbol', direction: 'horizontal', orient: 'top' }],
  ['symbol, a format', { type: 'symbol', format: '.2f', symbolType: 'square' }],
  ['symbol, a limit', { type: 'symbol', symbolLimit: 2 }],
  ['symbol, explicit values', { type: 'symbol', values: [3, 6] }],
  ['gradient, right', { type: 'gradient', title: 'Gradient' }],
  ['gradient, horizontal', { type: 'gradient', direction: 'horizontal', orient: 'bottom' }],
]

describe('discretizing legends against vega', () => {
  for (const [kind, scales] of SCALES) {
    it(`${kind}: ${scales.length} scales x ${LEGENDS.length} legends`, async () => {
      const bad: string[] = []
      for (const [sname, scale, data] of scales) {
        for (const [lname, legend] of LEGENDS) {
          const spec = frame({ data, scales: [{ name: 'c', ...scale }], legends: [{ fill: 'c', ...legend }], marks: [] })
          let d: string[]
          try {
            d = await differences(spec)
          } catch (e) {
            // a document the canonicalizer cannot read (vega draws an Infinity transform for a legend over a degenerate
            // domain with explicit values): nothing to compare, counted
            if (!/^canonicalizeSvg: non-finite/.test((e as Error).message)) throw e
            unreadable.push(`${sname} / ${lname}`)
            d = []
          }
          if (d.length) bad.push(`${sname} / ${lname}: ${d[0]}`)
        }
      }
      expect(bad).toEqual([])
    }, 300_000)
  }

  it('the documents the canonicalizer cannot read are a couple of degenerate-domain cases', () => {
    // (runs after the matrices, in file order)
    expect(unreadable.length).toBeLessThanOrEqual(3)
  })

  it('the labels are the ones the issue showed: "3.0" for a quantize breakpoint, and the box is as wide as they make it', async () => {
    const spec = frame({ scales: [{ name: 'q', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] }], legends: [{ fill: 'q', title: 'Bands' }], marks: [] })
    const want = await oracleSvg(spec)
    const ours = renderSpec(spec as never)
    expect([...want.matchAll(/>([^<]*)<\/text>/g)].map((m) => m[1])).toContain('3.0')
    expect(ours).toContain('>3.0</text>')
    expect(ours).toContain('>6.0</text>')
    // the legend box: as wide as the gradient and the widest label
    expect(want.match(/<path class="background"[^>]*d="M0,0h(\d+)v(\d+)h-\1Z"[^>]*pointer-events="none"\/><g><g class="mark-group role-legend-entry/)?.[1])
      .toBe(ours.match(/<path class="background"[^>]*d="M0,0h(\d+)v(\d+)h-\1Z"[^>]*pointer-events="none"\/><g><g class="mark-group role-legend-entry/)?.[1])
  })

  it('the scale snapshot gives the accessible tree the same words as the SVG caption', () => {
    for (const scale of [
      { type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
      { type: 'threshold', domain: [3, 6], range: ['#eee', '#9bd', '#06c'] },
      { type: 'bin-ordinal', domain: [0, 1, 2], range: ['#eee', '#9bd', '#06c'], bins: [0, 10, 20, 30] },
    ]) {
      const spec = frame({ scales: [{ name: 'c', ...scale }], legends: [{ fill: 'c', title: 'T' }], marks: [] })
      const svg = renderSpec(spec as never)
      const caption = /aria-roledescription="legend" aria-label="([^"]*)"/.exec(svg)?.[1]
      const tree = buildA11yTree(evaluateChart(compileChart(spec as never)))
      expect(tree.nodes.find((n) => n.kind === 'legend')?.label).toBe(caption)
      expect(caption).toMatch(/boundar/)
    }
  })
})
