/**
 * The hit index keeps the entries it made of a guide of the view (an axis, a legend, a title) the engine kept: a pointer move that
 * keeps both axes indexes neither again (their labels' boxes were measured anew by every index of every scene).
 *
 * What indexing a guide reads besides the group is changed in turn, on a scene that holds the very same guide groups (a host's scene
 * of the engine's nodes), and each change must index the guides again: where the view's frame is (the padding), how large the plot
 * is, whether the view clips to it, the text measurer set for every chart, the renderer. After every step what each renderer's index
 * finds on a grid of points (query, queryMark, pick, tooltip) is what a fresh index of a fresh evaluation finds.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { buildHitIndex } from './hit.js'
import { createChartSession } from './session.js'
import { derivedCounts } from './scene-registry.js'
import { setTextMetricsProvider } from './text-metrics.js'
import type { RuntimeInput, SceneGroup, SceneNode, SceneRoot, VgSpec } from './types.js'

const SPEC = {
  width: 300, height: 200, padding: 30, autosize: 'none',
  signals: [{ name: 'hoverX', value: null }],
  data: [{ name: 'pts', values: [{ x: 1, y: 2, c: 'a' }, { x: 50, y: 3.5, c: 'b' }, { x: 80, y: 7, c: 'a' }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
  ],
  axes: [
    { scale: 'x', orient: 'bottom', title: 'Days', labels: true, encode: { labels: { interactive: true }, ticks: { interactive: true } } },
    { scale: 'y', orient: 'left', grid: true, title: 'Survival', encode: { title: { interactive: true } } },
  ],
  legends: [{ fill: 'c', title: 'Kind', encode: { symbols: { interactive: true }, labels: { interactive: true } } }],
  title: { text: 'Chart', encode: { title: { interactive: true } } },
  marks: [{
    type: 'symbol', from: { data: 'pts' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 200 }, fill: { scale: 'c', field: 'c' }, opacity: { signal: 'hoverX == null ? 1 : 0.5' } } },
  }],
} as unknown as VgSpec

/** Every node of a scene by its place, so what two indexes find can be compared across scenes. */
function placesOf(scene: SceneRoot): Map<object, string> {
  const out = new Map<object, string>()
  const walk = (nodes: readonly SceneNode[] | undefined, at: string): void => {
    ;(nodes ?? []).forEach((n, i) => {
      const here = `${at}.${i}`
      if (n !== null && typeof n === 'object' && !out.has(n)) out.set(n, here)
      walk((n as SceneGroup).items, here)
    })
  }
  walk(scene.items, 'r')
  return out
}

function findings(scene: SceneRoot, renderer: 'svg' | 'canvas'): string[] {
  const index = buildHitIndex(scene, undefined, { renderer })
  const places = placesOf(scene)
  const name = (t: { item: object; marktype: string; kind?: string } | null): string => (t === null ? '-' : `${places.get(t.item) ?? '?'}/${t.marktype}/${t.kind ?? ''}`)
  const out: string[] = []
  for (let x = 0; x <= scene.width; x += 4) for (let y = 0; y <= scene.height; y += 4) {
    out.push([index.query(x, y), index.queryMark(x, y), index.pick(x, y), index.tooltip(x, y)].map(name).join(' '))
  }
  return out
}

/** The scene with every node a copy of its own: no index has made anything of them. */
function copied(scene: SceneRoot): SceneRoot {
  const copy = (n: SceneNode): SceneNode => {
    const out = { ...(n as object) } as SceneGroup
    if (Array.isArray(out.items)) out.items = (out.items as SceneNode[]).map(copy) as SceneGroup['items']
    return out
  }
  return rewrapped(scene, { items: scene.items.map((g) => copy(g) as SceneGroup) })
}

/**
 * The guides walked to index `scene` with `renderer`, and the check of what it finds against an index of the same scene made of
 * nodes of its own (nothing kept), and, given `input`, against a fresh evaluation's.
 */
function walked(scene: SceneRoot, renderer: 'svg' | 'canvas', input?: RuntimeInput): number {
  const before = derivedCounts.guideEntries
  const got = findings(scene, renderer)
  const n = derivedCounts.guideEntries - before
  expect(got).toEqual(findings(copied(scene), renderer))
  if (input !== undefined) expect(got).toEqual(findings(evaluateChart(compileChart(SPEC), input), renderer))
  return n
}

const rewrapped = (scene: SceneRoot, extra: Partial<SceneRoot> = {}): SceneRoot => Object.assign(Object.create(Object.getPrototypeOf(scene)), scene, extra) as SceneRoot

afterEach(() => setTextMetricsProvider(null))

describe('the hit index keeps the entries of a kept guide', () => {
  for (const renderer of ['svg', 'canvas'] as const) {
    it(`${renderer}: a pointer move that keeps the axes indexes neither again`, () => {
      const session = createChartSession()
      expect(walked(session.evaluate(SPEC, {}), renderer, {})).toBe(4)
      for (let i = 0; i < 6; i++) {
        const input = { signals: { hoverX: i * 9 } }
        // (the legend and the title are made again by every evaluation)
        expect(walked(session.evaluate(SPEC, input), renderer, input)).toBe(2)
      }
    })

    it(`${renderer}: each input of a guide's entries besides the group indexes it again`, () => {
      const scene = createChartSession().evaluate(SPEC, {})
      walked(scene, renderer)
      expect(walked(rewrapped(scene), renderer)).toBe(0)
      setTextMetricsProvider({ measure: (text) => text.length * 13 })
      expect(walked(rewrapped(scene), renderer)).toBe(4)
      setTextMetricsProvider(null)
      expect(walked(rewrapped(scene, { padding: { left: 40, top: 12, right: 30, bottom: 30 } }), renderer)).toBe(4)
      expect(walked(rewrapped(scene, { plotWidth: 200 } as Partial<SceneRoot>), renderer)).toBe(4)
      expect(walked(rewrapped(scene, { frameClip: true }), renderer)).toBe(4)
    })
  }

  it('the canvas renderer\'s index does not take the SVG one\'s entries', () => {
    const scene = createChartSession().evaluate(SPEC, {})
    walked(scene, 'svg')
    expect(walked(rewrapped(scene), 'canvas')).toBe(4)
  })
})
