/**
 * Against real Vega, in the same process: the view's own `clip` (the root group item clipped to its box, rounded when the view
 * has a corner radius: vega-scenegraph `clip`, both renderers -- C134), and a gradient paint that names its own `id` and no
 * coordinates (written bare, the SVG default: C137); and the view's `description` is what the scene carries for the accessible
 * name (vega-view `view.description(spec.description)`, the container's aria-label: C289).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

async function vegaSvg(s: Record<string, unknown>): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

const clipSpec = (w: number, h: number, padding: number, cornerRadius: number): Record<string, unknown> => ({
  width: w, height: h, padding, autosize: 'none',
  encode: { update: { clip: { value: true }, cornerRadius: { value: cornerRadius }, fill: { value: '#eee' }, stroke: { value: 'black' } } },
  marks: [{ type: 'rect', encode: { update: { x: { value: w / 2 }, y: { value: h / 3 }, width: { value: 500 }, height: { value: 500 }, fill: { value: 'red' } } } }],
})

describe('the view\'s clip (C134)', () => {
  for (const [w, h, p, r] of [[100, 80, 5, 0], [100, 80, 5, 12], [60, 30, 0, 40], [31, 77, 3, 3.5], [200, 50, 10, -4]] as const) {
    it(`${w} x ${h}, padding ${p}, corner radius ${r}`, async () => {
      const s = clipSpec(w, h, p, r)
      const want = await vegaSvg(s)
      const got = renderSpec(structuredClone(s) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
      // (not vacuous: vega clips, with a path when the corner is rounded)
      expect(want).toContain('<clipPath')
      if (r) expect(/<clipPath[^>]*><path/.test(want)).toBe(true)
    })
  }
})

describe('a gradient paint with its own id (C137)', () => {
  const gradientSpec = (paint: Record<string, unknown>): Record<string, unknown> => ({
    width: 100, height: 40, autosize: 'none', padding: 0,
    marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 100 }, height: { value: 40 }, fill: { value: paint } } } }],
  })
  const stops = [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }]
  for (const paint of [
    { gradient: 'linear', id: 'mine', stops },
    { gradient: 'linear', id: 'mine', x1: 0, y1: 0, x2: 0, y2: 1, stops },
    { gradient: 'radial', id: 'mine', stops },
  ]) {
    it(JSON.stringify(paint), async () => {
      const want = await vegaSvg(gradientSpec(paint))
      const got = renderSpec(structuredClone(gradientSpec(paint)) as never)
      const def = (svg: string): string | undefined => /<(linear|radial)Gradient[^>]*>/.exec(svg)?.[0]
      expect(def(got)).toBe(def(want))
    })
  }
})

describe('the view\'s description (C289)', () => {
  it('is the scene\'s, as vega-view takes it', async () => {
    for (const description of ['A chart about things', 'x', undefined]) {
      const s = { width: 50, height: 50, ...(description !== undefined ? { description } : {}), marks: [] }
      const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none' })
      await view.runAsync()
      const theirs = (view as unknown as { description(): string | undefined }).description()
      view.finalize()
      expect(evaluateChart(compileChart(structuredClone(s) as never), {}).description).toBe(theirs)
    }
  })
})
