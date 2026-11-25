// @vitest-environment jsdom
/**
 * A gradient (or discrete-gradient) legend whose strip throws, against real Vega: the title (and the layout around it) is there or not
 * according to the rank of the operators.
 *
 * `legend.type: "gradient"` on a discrete colour scale is the case that shows it: vega's gradient fill is `gradient(scale)`, which
 * needs `scale.interpolate` an ordinal scale has not, so the strip's encode throws and the pass stops. vega ranks an operator that
 * reads a scale whose domain reads data after every operator that reads none (the legend's title reads only the legend's datum), so
 * over a data-driven scale the title was made before the strip threw, and over a literal domain it was not. The strip reads the
 * scale in its default fill (gradient) or its band fills (discrete); a fill the spec writes decides for a gradient.
 *
 * Not covered here, and different: a strip whose own fill throws WITHOUT reading the late scale. vega's pass then stops before the
 * scale itself is evaluated, so no mark that reads it is encoded and no guide over it has a caption (the late-taint of
 * runtime.ts, which a failing guide part does not set yet). ROADMAP names it.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>

const ROWS = [{ k: 'a', v: 3, g: 'north' }, { k: 'b', v: 8, g: 'south' }, { k: 'c', v: 5, g: 'east' }, { k: 'd', v: 9, g: 'north' }]
const SCALES: Record<string, Spec> = {
  'ordinal over data': { type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  'ordinal literal': { type: 'ordinal', domain: ['a', 'b', 'c'], range: ['#c00', '#06c', '#0a0'] },
  'ordinal over two fields': { type: 'ordinal', domain: { data: 't', fields: ['g', 'k'] }, range: 'category' },
  'band over data': { type: 'band', domain: { data: 't', field: 'k' }, range: [0, 1] },
  'point literal': { type: 'point', domain: ['a', 'b'], range: [0, 1] },
  'linear over data': { type: 'linear', domain: { data: 't', field: 'v' }, range: ['white', 'black'] },
  'linear literal': { type: 'linear', domain: [0, 10], range: ['white', 'black'] },
  'quantize over data': { type: 'quantize', domain: { data: 't', field: 'v' }, range: ['#eee', '#9bd', '#06c'] },
  'quantize literal': { type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
  'threshold over a signal': { type: 'threshold', domain: [3, 6], range: ['#eee', '#9bd', '#06c'] },
}
const FILLS: Record<string, unknown> = {
  'the default fill': undefined,
  'a fill that reads the scale': { signal: 'gradient("g", [0,0], [1,1])' },
  'a fill that reads no scale': { value: 'teal' },
}
const TYPES = ['gradient', 'discrete', undefined] as const

function build(scale: Spec, type: string | undefined, fill: unknown, title: boolean, orient: string, second: boolean): Spec {
  const legend: Spec = { fill: 'g', orient, ...(title ? { title: 'region' } : {}), ...(type ? { type } : {}) }
  if (fill !== undefined) legend.encode = { gradient: { update: { fill } } }
  return {
    width: 160, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't', values: ROWS }],
    scales: [{ name: 'g', ...scale }, ...(second ? [{ name: 'h', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }] : [])],
    legends: second ? [legend, { fill: 'h', title: 'other' }] : [legend],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { value: 1 }, y: { value: 1 }, width: { value: 9 }, height: { value: 9 }, fill: { value: '#888' } } } }],
  }
}

async function vegaSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}

describe('a legend strip that throws, over scales ranked early and late (vega)', () => {
  it('the same document as vega, for every scale, type, fill, title and legend arrangement', async () => {
    const bad: string[] = []
    let withTitle = 0
    let withoutTitle = 0
    let n = 0
    for (const [sName, scale] of Object.entries(SCALES)) {
      for (const type of TYPES) {
        for (const [fName, fill] of Object.entries(FILLS)) {
          for (const [title, orient, second] of [[true, 'right', false], [false, 'right', false], [true, 'bottom', false]] as const) {
            n++
            const spec = build(scale, type, fill, title, orient, second)
            const label = `${sName} / ${type ?? 'default'} / ${fName} / ${title ? 'titled' : 'untitled'} ${orient}${second ? ' + second legend' : ''}`
            let oracle: string
            try { oracle = await vegaSvg(spec) } catch (e) { bad.push(`${label}: vega refused: ${(e as Error).message}`); continue }
            const log = console.error
            console.error = () => {}
            let ours: string
            try { ours = (await forEngines(spec, (_o, a) => Promise.resolve(renderSpec(a as never)))) } finally { console.error = log }
            const d = diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))
            if (d.length) bad.push(`${label}: ${d[0]}`)
            if (title && !second && /role-legend-title/.test(oracle)) withTitle++
            else if (title && !second) withoutTitle++
          }
        }
      }
    }
    expect(bad).toEqual([])
    // (not vacuous: the title is there in some of the cases whose strip throws and not in others)
    expect(withTitle).toBeGreaterThan(10)
    expect(withoutTitle).toBeGreaterThan(5)
    expect(n).toBe(Object.keys(SCALES).length * TYPES.length * Object.keys(FILLS).length * 3)
  }, 240_000)
})
