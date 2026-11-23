// @vitest-environment jsdom
/**
 * A per-call text measurer (`RuntimeInput.textMetrics`) is the one the scene is drawn with, by every renderer (C38): the labels
 * the layout sized whole are not cut when the scene is written. And the measured widths (C414): one cache per measurer, so a
 * scoped measurer neither reads nor clears another's, under keys no font and text can share.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from './index.js'
import { sceneToDomDesc } from './dom.js'
import { renderSceneToCanvas } from './canvas.js'
import { buildHitIndex } from './hit.js'
import { buildA11yTree } from './a11y.js'
import { makeRecorder } from './canvas-record.testlib.js'
import { measureText, setTextMetricsProvider, withTextMetricsProvider, type TextMetricsProvider } from './text-metrics.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { DomDesc } from './dom.js'
import type { VgSpec } from './types.js'

afterEach(() => setTextMetricsProvider(null))

const spec = (labels: string[], limit: number): VgSpec => ({
  width: 300, height: 100, padding: 5,
  data: [{ name: 't', values: labels.map((s, i) => ({ s, i })) }],
  scales: [{ name: 'y', type: 'band', domain: { data: 't', field: 's' }, range: 'height' }],
  axes: [{ orient: 'left', scale: 'y' }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 100 }, y: { scale: 'y', field: 's' }, text: { field: 's' }, limit: { value: limit } } } }],
} as unknown as VgSpec)

const textsOfSvg = (svg: string): string[] => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map((t) => t.textContent ?? '')
const textsOfDesc = (d: DomDesc, out: string[] = []): string[] => {
  if (d.tag === 'text') out.push(d.text ?? (d.children ?? []).map((c) => c.text ?? '').join(''))
  for (const c of d.children ?? []) if (d.tag !== 'text') textsOfDesc(c, out)
  return out
}

describe('the scene is written under the measurer it was laid out with (C38)', () => {
  it('string, DOM, canvas, hit index, accessible tree: a per-call measurer equals the same measurer set around the call', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = mulberry32(seed)
      const per = pick(r, [1, 2, 3, 5])
      const provider: TextMetricsProvider = { measure: (text) => text.length * per }
      const labels = Array.from({ length: 3 }, (_, i) => `label ${i} ${'x'.repeat(Math.floor(r() * 60))}`)
      const s = spec(labels, pick(r, [40, 90, 150, 400]))
      // the reference: the same measurer in force for the whole of the evaluation and the rendering
      const ref = withTextMetricsProvider(provider, () => {
        const scene = evaluateChart(compileChart(structuredClone(s)), {})
        const { ctx, records } = makeRecorder()
        renderSceneToCanvas(scene, ctx)
        return { svg: renderSceneToSvg(scene), dom: textsOfDesc(sceneToDomDesc(scene)), canvas: records.filter((x) => x.op === 'text').map((x) => x.geom), hit: buildHitIndex(scene).size(), a11y: JSON.stringify(buildA11yTree(scene).nodes.map((n) => [n.x, n.y, n.width, n.height])) }
      })
      // the per-call measurer, and a different one set for every chart meanwhile
      setTextMetricsProvider({ measure: (text) => text.length * 13 })
      const scene = evaluateChart(compileChart(structuredClone(s)), { textMetrics: provider })
      const { ctx, records } = makeRecorder()
      renderSceneToCanvas(scene, ctx)
      expect(textsOfSvg(renderSceneToSvg(scene)), `seed ${seed}`).toEqual(textsOfSvg(ref.svg))
      expect(textsOfDesc(sceneToDomDesc(scene)), `seed ${seed}`).toEqual(ref.dom)
      expect(records.filter((x) => x.op === 'text').map((x) => x.geom), `seed ${seed}`).toEqual(ref.canvas)
      expect(buildHitIndex(scene).size()).toBe(ref.hit)
      expect(JSON.stringify(buildA11yTree(scene).nodes.map((n) => [n.x, n.y, n.width, n.height])), `seed ${seed}`).toBe(ref.a11y)
      setTextMetricsProvider(null)
    }
  })

  it('renderSpec with a per-call measurer: the audit\'s case (labels under their limit are whole)', () => {
    const provider: TextMetricsProvider = { measure: (text) => text.length * 3 }
    const label = 'a category name of forty characters long'
    const s = spec([label], 150)
    expect(textsOfSvg(renderSpec(s, { textMetrics: provider })).filter((t) => t.startsWith('a category'))).toEqual([label, label])
  })
})

describe('measured widths: one cache per measurer, unambiguous keys (C414)', () => {
  it('a font and a text that split differently never share a width', () => {
    const calls: string[] = []
    setTextMetricsProvider({ measure: (text, font) => { calls.push(`${font}|${text}`); return font.length * 100 + text.length } })
    for (const [font, text] of [['11px a) b', 'c'], ['11px a', 'b) c'], ['11px a) b) c', ''], ['11px', 'a) b) c']] as const) {
      expect(measureText(text, font), `${font} / ${text}`).toBe(font.length * 100 + text.length)
    }
    expect(calls.length).toBe(4)
  })

  it('a scoped measurer neither clears the global one\'s widths nor reads them', () => {
    let globalCalls = 0
    setTextMetricsProvider({ measure: (text) => { globalCalls++; return text.length } })
    measureText('abc', '11px x')
    measureText('abc', '11px x')
    expect(globalCalls).toBe(1)
    for (let i = 0; i < 5; i++) withTextMetricsProvider({ measure: (text) => text.length * 2 }, () => expect(measureText('abc', '11px x')).toBe(6))
    // (the global one's width is still cached: nothing cleared it)
    expect(measureText('abc', '11px x')).toBe(3)
    expect(globalCalls).toBe(1)
    // control: setting a measurer again forgets what it measured
    setTextMetricsProvider({ measure: (text) => { globalCalls++; return text.length } })
    measureText('abc', '11px x')
    expect(globalCalls).toBe(2)
  })
})
