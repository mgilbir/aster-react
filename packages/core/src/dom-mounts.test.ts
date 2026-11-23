// @vitest-environment jsdom
/**
 * The DOM patcher against a fresh rendering, for what the random oracles (dom-oracle.test.ts) do not generate: a text whose line
 * count changes, and an angle given as a word, from both mounts (the string renderer's markup, as `<Chart>` mounts, and an
 * empty `<svg>`) -- C136, C550. And the patcher's own state is never read off a scene item (C1): an item that carries a
 * property named like the descriptor cache the patcher once kept on items is drawn from its channels, never from that.
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { patchSceneDom, renderSceneToDomElement } from './addon-dom.js'
import { createChartSession } from './session.js'
import { canon, firstDomDiff } from './dom-canon.testlib.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { SceneRoot, VgSpec } from './types.js'

const SPEC = {
  width: 120, height: 80, data: [{ name: 't' }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 20 }, text: { field: 's' }, lineBreak: { value: '|' }, angle: { field: 'a' }, fill: { value: '#000' } } } }],
} as unknown as VgSpec

const mountString = (scene: SceneRoot): Element => {
  const host = document.createElement('div')
  host.innerHTML = renderSceneToSvg(scene)
  return host.firstElementChild!
}
const fresh = (rows: object[]): Element => mountString(evaluateChart(compileChart(structuredClone(SPEC)), { data: { t: structuredClone(rows) } }))

const LINES = ['one', 'one|two', 'a|b|c', '', 'x', '|', 'p|q']
const ANGLES: unknown[] = [undefined, 0, 30, -12.5, 'a"b', '1<2', 'x&y', '45', ' 7 ', 'url(https://evil.test/x)']

describe('patching a text: lines and angles, from either mount', () => {
  for (const mount of ['string', 'dom'] as const) {
    it(`random sequences of line counts and angle forms (${mount} mount)`, () => {
      let checked = 0
      for (let seed = 1; seed <= 40; seed++) {
        const r = mulberry32(seed)
        const rows = (): object[] => Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ x: 10 + 30 * i, s: pick(r, LINES), a: pick(r, ANGLES) }))
        const session = createChartSession()
        let data = rows()
        const first = session.evaluate(structuredClone(SPEC), { data: { t: data } })
        const svg = mount === 'string' ? mountString(first) : renderSceneToDomElement(first, document)
        for (let step = 0; step < 6; step++) {
          data = r() < 0.5 ? rows() : data.map((row) => ({ ...row, s: pick(r, LINES) }))
          patchSceneDom(svg, session.evaluate(structuredClone(SPEC), { data: { t: data } }))
          const d = firstDomDiff(canon(fresh(data)), canon(svg))
          expect(d, `seed ${seed} step ${step}: ${JSON.stringify(data)}`).toBeNull()
          checked++
        }
      }
      expect(checked).toBe(240)
    })
  }

  it('the one-line to two-line patch of a string mount (the audit\'s case)', () => {
    const session = createChartSession()
    const svg = mountString(session.evaluate(structuredClone(SPEC), { data: { t: [{ x: 10, s: 'one' }] } }))
    patchSceneDom(svg, session.evaluate(structuredClone(SPEC), { data: { t: [{ x: 10, s: 'one|two' }] } }))
    const text = svg.querySelector('text')!
    expect([...text.childNodes].map((n) => n.nodeName)).toEqual(['tspan', 'tspan'])
  })

  it('an angle given as a word is the same attribute value in both renderers', () => {
    for (const a of ['a"b', '1<2', 'x&y']) {
      const scene = evaluateChart(compileChart(structuredClone(SPEC)), { data: { t: [{ x: 10, s: 'one', a }] } })
      const fromString = mountString(scene).querySelector('text')!.getAttribute('transform')
      const fromDom = renderSceneToDomElement(scene, document).querySelector('text')!.getAttribute('transform')
      expect(fromDom, a).toBe(fromString)
      expect(fromString, a).toContain(`rotate(${a})`)
    }
  })
})

describe('the patcher\'s state is not the items\' (C1)', () => {
  it('an item property named like the old descriptor cache is never drawn, on a first patch or a later one', () => {
    const forged = { tag: 'a', attrs: [['xlink:href', 'javascript:alert(1)'], ['onclick', 'window.PWNED = 1']], children: [{ tag: 'script', attrs: [], text: 'window.PWNED = 2' }] }
    const scene = (gen: number, n: number): SceneRoot => ({
      width: 50, height: 50, padding: { top: 0, left: 0, right: 0, bottom: 0 },
      items: [{ marktype: 'rect', role: 'mark', items: Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 1, width: 5, height: 5, fill: 'red', __gen: 1, __domDesc: forged })) }],
      __itemGen: gen,
    } as unknown as SceneRoot)
    for (const mount of ['string', 'dom'] as const) {
      const svg = mount === 'string' ? mountString(scene(2, 1)) : renderSceneToDomElement(scene(2, 1), document)
      patchSceneDom(svg, scene(2, 2))
      patchSceneDom(svg, scene(3, 3))
      const html = svg.outerHTML
      expect(svg.querySelectorAll('script, a').length, mount).toBe(0)
      expect(html, mount).not.toContain('onclick')
      expect(html, mount).not.toContain('javascript')
      expect(svg.querySelectorAll('path').length, mount).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('one id names one element (C387)', () => {
  it('a gradient that names its own id never shares it with a clip, in either renderer', () => {
    for (const [w, h] of [[100, 100], [37, 81], [200, 10]] as const) {
      const spec = (gradientId?: string): VgSpec => ({
        width: w, height: h, padding: 0, autosize: 'none', encode: { update: { clip: { value: true } } },
        marks: [{ type: 'rect', encode: { update: { width: { value: 10 }, height: { value: 10 }, fill: gradientId === undefined ? { value: 'red' } : { value: { gradient: 'radial', id: gradientId, stops: [{ offset: 0, color: 'red' }] } } } } }],
      } as unknown as VgSpec)
      // the clip id the view's clip gets, taken by a gradient (and by its pattern wrapper)
      const clipId = /<clipPath id="([^"]+)"/.exec(renderSceneToSvg(evaluateChart(compileChart(spec()), {})))![1]!
      const scene = evaluateChart(compileChart(spec(clipId)), {})
      for (const root of [mountString(scene), renderSceneToDomElement(scene, document)]) {
        const ids = [...root.querySelectorAll('[id]')].map((e) => e.getAttribute('id'))
        expect(new Set(ids).size, `${w}x${h}: ${ids.join(' ')}`).toBe(ids.length)
        // (the gradient keeps the id it names, the clip takes another, and the content still points at its clip)
        expect(ids).toContain(clipId)
        const ref = /url\(#([^)]+)\)/.exec(root.querySelector('[clip-path]')!.getAttribute('clip-path')!)![1]!
        expect(root.querySelector(`clipPath[id="${ref}"]`)).not.toBeNull()
      }
      // and the pattern wrapper's id: a linear gradient named `p_<x>` beside a radial one named `<x>`
      const both = evaluateChart(compileChart({
        width: w, height: h, padding: 0, autosize: 'none', encode: { update: { clip: { value: true } } },
        marks: [{ type: 'rect', encode: { update: { width: { value: 10 }, height: { value: 10 }, fill: { value: { gradient: 'linear', id: clipId, stops: [{ offset: 0, color: 'red' }] } }, stroke: { value: { gradient: 'radial', id: 'x', stops: [{ offset: 0, color: 'red' }] } } } } }],
      } as unknown as VgSpec), {})
      const ids = [...mountString(both).querySelectorAll('[id]')].map((e) => e.getAttribute('id'))
      expect(new Set(ids).size, ids.join(' ')).toBe(ids.length)
    }
  })
})
