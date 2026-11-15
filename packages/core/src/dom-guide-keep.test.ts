// @vitest-environment jsdom
/**
 * The DOM patcher keeps what it made of a guide (an axis, a legend, a title) the engine kept, and the scene's scale snapshots are the
 * array the scene before carried when every scale is the one before: a pointer move that keeps both axes describes neither again.
 *
 * What describing a guide reads besides the group is changed in turn, on a scene that holds the very same guide groups (a host's
 * scene made of the engine's nodes), and each change must describe the guide again: the scale snapshots, the text measurer set for
 * every chart, the default locale, the batching options; a guide whose descriptor asked for a clip is never kept. One SVG element
 * patched with every scene equals a fresh rendering of it, and the descriptors equal a fresh scene's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { patchSceneDom, renderSceneToDomElement, sceneToDomDesc, type DomDesc } from './dom.js'
import { createChartSession } from './session.js'
import { defaultLocale, resetDefaultLocale } from './locale.js'
import { setTextMetricsProvider } from './text-metrics.js'
import type { SceneRoot, VgSpec } from './types.js'

const SPEC = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [{ name: 'hoverX', value: null }],
  data: [{ name: 'pts', values: [{ x: 1, y: 2, c: 'a' }, { x: 50, y: 3.5, c: 'b' }, { x: 80, y: 7, c: 'a' }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
  ],
  axes: [{ scale: 'x', orient: 'bottom', title: 'Days', labelLimit: 30 }, { scale: 'y', orient: 'left', grid: true, format: '.1f' }],
  legends: [{ fill: 'c', title: 'Kind' }],
  title: 'Survival',
  marks: [{
    type: 'symbol', from: { data: 'pts' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { scale: 'c', field: 'c' }, opacity: { signal: 'hoverX == null ? 1 : 0.5' } } },
  }],
} as unknown as VgSpec

/** The descriptors of the view's axes, legends and title, in the order they are drawn (the frame's mark children that are guides). */
function guideDescs(root: DomDesc): DomDesc[] {
  const out: DomDesc[] = []
  const visit = (d: DomDesc): void => {
    const cls = d.attrs.find(([k]) => k === 'class')?.[1] ?? ''
    if (/role-(axis|legend|title)\b/.test(cls) && /mark-group/.test(cls)) { out.push(d); return }
    for (const c of d.children ?? []) visit(c)
  }
  visit(root)
  return out
}

const html = (el: Element): string => el.outerHTML
/** A descriptor as what it draws: the patcher's `clean` hint (whether it may skip an element last patched with it) aside. */
const drawn = (d: DomDesc): string => JSON.stringify(d, (k, v) => (k === 'clean' ? undefined : v))
const fresh = (scene: SceneRoot): string => html(renderSceneToDomElement(scene, document))
/** A host's scene of the engine's nodes: another root, the same items. */
const rewrapped = (scene: SceneRoot, extra: Partial<SceneRoot> = {}): SceneRoot => Object.assign(Object.create(Object.getPrototypeOf(scene)), scene, extra) as SceneRoot

afterEach(() => {
  resetDefaultLocale()
  setTextMetricsProvider(null)
})

describe('the DOM patcher keeps what it made of a kept guide', () => {
  it('a pointer move that keeps the axes describes neither again; the patched SVG equals a fresh rendering', () => {
    const session = createChartSession()
    let scene = session.evaluate(SPEC, {})
    const svg = renderSceneToDomElement(scene, document)
    let before = guideDescs(sceneToDomDesc(scene))
    expect(before.length).toBe(4) // two axes, the legend, the title
    for (let i = 0; i < 10; i++) {
      const next = session.evaluate(SPEC, { signals: { hoverX: i * 9 } })
      expect(next.__scales).toBe(scene.__scales)
      scene = next
      patchSceneDom(svg, scene)
      expect(html(svg)).toBe(fresh(evaluateChart(compileChart(SPEC), { signals: { hoverX: i * 9 } })))
      const now = guideDescs(sceneToDomDesc(scene))
      // (the axes are the engine's kept groups; the legend and the title are made again by every evaluation)
      expect(now.map((d, k) => d === before[k])).toEqual([true, true, false, false])
      before = now
    }
  })

  it('a scale made again gives the scene snapshots of its own, those of a fresh evaluation', () => {
    const moving = { ...SPEC, signals: [{ name: 'hoverX', value: null }, { name: 'top', value: 100 }], scales: [{ name: 'x', type: 'linear', domain: { signal: '[0, top]' }, range: 'width' }, ...(SPEC as { scales: unknown[] }).scales.slice(1)] } as unknown as VgSpec
    const session = createChartSession()
    const a = session.evaluate(moving, {})
    const b = session.evaluate(moving, { signals: { top: 140 } })
    expect(b.__scales).not.toBe(a.__scales)
    expect(b.__scales).toEqual(evaluateChart(compileChart(moving), { signals: { top: 140 } }).__scales)
    const c = session.evaluate(moving, { signals: { top: 140, hoverX: 3 } })
    expect(c.__scales).toBe(b.__scales)
  })

  it('each input of a guide\'s descriptor besides the group describes it again', () => {
    const scene = createChartSession().evaluate(SPEC, {})
    const first = guideDescs(sceneToDomDesc(scene))
    const same = (s: SceneRoot, options?: Parameters<typeof sceneToDomDesc>[1]): boolean[] => {
      const got = sceneToDomDesc(s, options)
      // (the descriptors are those a fresh scene of the same input makes)
      expect(drawn(got)).toBe(drawn(sceneToDomDesc(evaluateChart(compileChart(SPEC), {}), options)))
      return guideDescs(got).map((d, k) => d === first[k])
    }
    // another scene of the same nodes: every guide's descriptor is the one before (the legend and the title too)
    expect(same(rewrapped(scene))).toEqual([true, true, true, true])
    // the batching options
    expect(same(rewrapped(scene), { denseMarks: true })).toEqual([false, false, false, false])
    // the scale snapshots, by array
    expect(same(rewrapped(scene, { __scales: [...(scene.__scales ?? [])] } as Partial<SceneRoot>))).toEqual([false, false, false, false])
  })

  it('the text measurer set for every chart and the default locale', () => {
    const scene = createChartSession().evaluate(SPEC, {})
    const svg = renderSceneToDomElement(scene, document)
    const first = guideDescs(sceneToDomDesc(scene))
    setTextMetricsProvider({ measure: (text) => text.length * 20 })
    const wide = rewrapped(scene)
    expect(guideDescs(sceneToDomDesc(wide)).some((d, k) => d === first[k])).toBe(false)
    patchSceneDom(svg, wide)
    expect(html(svg)).toBe(fresh(wide))
    setTextMetricsProvider(null)
    const second = guideDescs(sceneToDomDesc(scene))
    defaultLocale({ decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] }, {
      dateTime: '%x %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['AM', 'PM'], days: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
      shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], months: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
      shortMonths: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
    })
    const german = rewrapped(scene)
    expect(guideDescs(sceneToDomDesc(german)).some((d, k) => d === second[k])).toBe(false)
    patchSceneDom(svg, german)
    expect(html(svg)).toBe(fresh(german))
  })

  it('a guide whose descriptor asked for a clip is described again, and its clip is in the defs', () => {
    // (a legend whose entries are clipped to a height hangs a clip on a group around each symbol)
    const clipped = { ...SPEC, legends: [{ fill: 'c', title: 'Kind', clipHeight: 4 }] } as unknown as VgSpec
    const scene = createChartSession().evaluate(clipped, {})
    const root = sceneToDomDesc(scene)
    expect(drawn(root)).toContain('clipPath')
    const legend = guideDescs(root)[2]!
    const again = sceneToDomDesc(rewrapped(scene))
    expect(guideDescs(again)[2]).not.toBe(legend)
    expect(drawn(again)).toBe(drawn(root))
  })
})
