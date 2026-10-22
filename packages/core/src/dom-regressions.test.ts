// @vitest-environment jsdom
/**
 * Targeted regressions for the DOM findings (C3, C23, C43), each next to the
 * general oracle that covers its shape (dom-oracle, dom-string-parity).
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { patchSceneDom, renderSceneToDomElement, sceneToDomDesc } from './addon-dom.js'
import { canon, firstDomDiff, parityDiff, parseSvg } from './dom-canon.testlib.js'
import { PairAttrSink, StringAttrSink } from './render.js'
import type { SceneGroup, SceneRoot } from './types.js'

const NS = 'http://www.w3.org/2000/svg'
const mkSvg = (): Element => document.createElementNS(NS, 'svg')

// ---------------------------------------------------------------------------
// C3: positional `clean` skip
// ---------------------------------------------------------------------------

describe('C3: removing items patches the right elements', () => {
  const spec = {
    width: 200, height: 100, padding: 0, autosize: 'none', data: [{ name: 't' }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 50], range: [0, 200] }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 50 }, size: { value: 30 } } } }],
  }
  const xs = (svg: Element): string[] => [...svg.querySelectorAll('.mark-symbol path')].map((p) => p.getAttribute('transform')!)
  const rows = (...v: number[]): { x: number }[] => v.map((x) => ({ x }))

  it('shows 0,20,30,40 after removing 10 from 0,10,20,30,40 (the audit repro)', () => {
    const chart = compileChart(spec as never)
    const svg = mkSvg()
    patchSceneDom(svg, evaluateChart(chart, { data: { t: rows(0, 10, 20, 30, 40) } }))
    expect(xs(svg)).toEqual(['translate(0,50)', 'translate(40,50)', 'translate(80,50)', 'translate(120,50)', 'translate(160,50)'])
    patchSceneDom(svg, evaluateChart(chart, { data: { t: rows(0, 20, 30, 40) } }))
    expect(xs(svg)).toEqual(['translate(0,50)', 'translate(80,50)', 'translate(120,50)', 'translate(160,50)'])
  })

  it('matches a fresh render after two removals and a reorder', () => {
    const chart = compileChart(spec as never)
    const svg = mkSvg()
    const steps = [rows(0, 5, 10, 15, 20, 25), rows(0, 10, 15, 20, 25), rows(0, 10, 20, 25), rows(25, 20, 10, 0)]
    for (const t of steps) {
      const scene = evaluateChart(chart, { data: { t } })
      patchSceneDom(svg, scene)
      const fresh = evaluateChart(compileChart(spec as never), { data: { t } })
      expect(firstDomDiff(canon(renderSceneToDomElement(fresh, document)), canon(svg))).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// C23: trail fill
// ---------------------------------------------------------------------------

describe('C23: a trail keeps its fill', () => {
  const trail = (extra: Record<string, unknown>): SceneRoot => ({
    width: 100, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    items: [{
      marktype: 'trail', role: 'mark',
      items: [
        { x: 10, y: 10, size: 6, ...extra },
        { x: 50, y: 40, size: 10, ...extra },
        { x: 90, y: 20, size: 4, ...extra },
      ],
    }],
  } as unknown as SceneRoot)

  it('the DOM descriptor keeps the fill, and a patch over the string-rendered DOM does not strip it', () => {
    const scene = trail({ fill: '#4c78a8', fillOpacity: 0.5, strokeDash: [2, 1] })
    const host = document.createElement('div')
    host.innerHTML = renderSceneToSvg(scene)
    const svg = host.firstElementChild!
    const path = (): Element => svg.querySelector('.mark-trail path')!
    expect(path().getAttribute('fill')).toBe('#4c78a8')
    patchSceneDom(svg, scene)
    expect(path().getAttribute('fill')).toBe('#4c78a8')
    expect(path().getAttribute('fill-opacity')).toBe('0.5')
    expect(path().getAttribute('stroke-dasharray')).toBe('2,1')
    expect(parityDiff(scene)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// C43: one attribute list for the string renderer and the DOM descriptor
// ---------------------------------------------------------------------------

const paint = {
  fill: '#123456', fillOpacity: 0.5, stroke: '#abcdef', strokeWidth: 2, strokeDash: [3, 1], strokeOpacity: 0.4, opacity: 0.9,
  strokeJoin: 'round', strokeCap: 'round', dataDatum: '{"k":"v\\"<&>"}',
}
const mark = (marktype: string, items: unknown[], extra: Record<string, unknown> = {}): SceneGroup =>
  ({ marktype, role: 'mark', items, ...extra }) as unknown as SceneGroup
const sceneOf = (items: SceneGroup[], extra: Record<string, unknown> = {}): SceneRoot =>
  ({ width: 220, height: 140, padding: { top: 5, right: 6, bottom: 7, left: 8 }, items, ...extra }) as unknown as SceneRoot

const MARK_SCENES: Record<string, SceneRoot> = {
  line: sceneOf([mark('line', [{ ...paint, x: 1, y: 2 }, { x: 30, y: 40 }, { x: 60, y: 10 }])]),
  'line (monotone, filled)': sceneOf([mark('line', [{ ...paint, x: 1, y: 2, interpolate: 'monotone' }, { x: 30, y: 40 }, { x: 60, y: 10 }])]),
  area: sceneOf([mark('area', [{ ...paint, x: 1, y: 20, y2: 60 }, { x: 30, y: 40, y2: 60 }, { x: 60, y: 10, y2: 60 }])]),
  symbol: sceneOf([mark('symbol', [{ ...paint, x: 10, y: 10, size: 50, shape: 'diamond', angle: 30 }, { x: null, y: null, fill: 'transparent' }])]),
  circle: sceneOf([mark('circle', [{ ...paint, x: 10, y: 10, size: 50 }, { ...paint, x: 20, y: 5, radius: 7 }])]),
  rect: sceneOf([mark('rect', [{ ...paint, x: 10, y: 10, width: 20, height: 30 }, { x: 5, y: 5, width: 4, height: 4 }, { x: 1, y: 1, width: 4, height: 4, fill: null, stroke: null }])]),
  'rect (rounded, clipped scopes)': sceneOf([mark('rect', [
    { ...paint, x: 10, y: 10, width: 20, height: 30, cornerRadius: 4, clip: true },
    { ...paint, x: 40, y: 10, width: 20, height: 30 },
  ])]),
  rule: sceneOf([mark('rule', [{ ...paint, x: 10, y: 10, x2: 50 }, { stroke: '#000', x: Number.NaN, y: 3, y2: 9 }])]),
  text: sceneOf([mark('text', [
    { ...paint, x: 10, y: 20, text: 'hello', fontSize: 12, font: 'serif', fontWeight: 'bold', baseline: 'top', align: 'left' },
    { ...paint, x: 10, y: 40, text: ['two', 'lines'], fontSize: 10, angle: 20, baseline: 'middle' },
  ])]),
  trail: sceneOf([mark('trail', [{ ...paint, x: 10, y: 10, size: 6 }, { x: 50, y: 40, size: 10 }, { x: 90, y: 20, size: 4 }])]),
  path: sceneOf([mark('path', [{ ...paint, path: 'M0,0L10,10L0,10Z', x: 5, y: 6, scaleX: 2, scaleY: 3 }, { path: '', fill: 'red' }])]),
  shape: sceneOf([mark('shape', [{ ...paint, path: 'M0,0L10,10L0,10Z' }])]),
  geoshape: sceneOf([mark('geoshape', [{ ...paint, path: 'M1,1L10,10L1,10Z' }])]),
  image: sceneOf([mark('image', [{ ...paint, url: 'a.png?x=1&y="2"', x: 3, y: 4, width: 10, height: 12, aspect: false }])]),
  arc: sceneOf([mark('arc', [{ ...paint, x: 50, y: 50, outerRadius: 30, innerRadius: 10, startAngle: 0.2, endAngle: 2, padAngle: 0.05, cornerRadius: 3 }])]),
  'unknown mark type renders nothing in both': sceneOf([mark('tick', [{ x: 1, y: 2 }])]),
  'group with guide leaves': sceneOf([{
    marktype: 'group', role: 'axis', x: 3, y: 4, clip: true, clipPathD: 'M0,0h10v10h-10Z',
    items: [
      { ...paint, path: 'M0,0L5,5', x: 1, y: 2, angle: 15, _clip: { w: 12, h: 9 } },
      { ...paint, shape: 'square', radius: 4, x: 5, y: 5, angle: 10 },
      { ...paint, text: 'tick', x: 3, y: 3, fontSize: 9, font: 'Arial', baseline: 'middle', angle: 45, align: 'right' },
      { ...paint, text: 'plain', x: 3, y: 3, fontSize: 9, baseline: 'bottom' },
      { ...paint, x: 1, y: 1, x2: 9, y2: 9 },
      { marktype: 'group', role: 'legend', items: [{ ...paint, text: 'nested', x: 2, y: 2 }] },
    ],
  } as unknown as SceneGroup]),
  'clipped mark groups, gradient defs, frame': sceneOf(
    [mark('symbol', [{ x: 5, y: 5, size: 20, fill: 'url(#g1)' }], { clip: true, clipPathD: 'M0,0h50v50h-50Z' }), mark('rule', [{ x: 1, y: 1, x2: 20, stroke: '#000' }], { clip: true })],
    {
      background: '#fefefe', frameClip: true, frameFill: '#eee', frameFillOpacity: 0.5, frameStroke: '#333', frameStrokeWidth: 2, frameStrokeDash: [4, 2], frameOpacity: 0.7,
      frameCornerRadius: 6, plotWidth: 190, plotHeight: 120,
      defs: [{ id: 'g1', direction: 'horizontal', colorStops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] }, { id: 'g2', colorStops: [{ offset: 0.5, color: 'rgb(1,2,3)' }] }],
    },
  ),
  'frame stroke without width': sceneOf([], { frameStroke: '#333' }),
}

describe('C43: the DOM descriptor and the string renderer take one attribute list', () => {
  for (const [name, scene] of Object.entries(MARK_SCENES)) {
    it(`${name}: patched DOM === parsed string output`, () => {
      expect(parityDiff(scene)).toBeNull()
    })
  }

  it('the audit\'s listed drifts are gone', () => {
    const attrs = (scene: SceneRoot, sel: string): Record<string, string> => {
      const el = renderSceneToDomElement(scene, document).querySelector(sel)!
      return Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))
    }
    // horizontal gradient direction
    const grad = attrs(MARK_SCENES['clipped mark groups, gradient defs, frame']!, 'linearGradient')
    expect([grad.x1, grad.x2, grad.y1, grad.y2]).toEqual(['0', '1', '0', '0'])
    // area opacity + dash, rect dash, rule stroke-opacity, symbol linejoin, arc linecap, path scale
    expect(attrs(MARK_SCENES.area!, '.mark-area path')).toMatchObject({ opacity: '0.9', 'stroke-dasharray': '3,1' })
    expect(attrs(MARK_SCENES.rect!, '.mark-rect path[data-datum]')['stroke-dasharray']).toBe('3,1')
    expect(attrs(MARK_SCENES.rule!, '.mark-rule line')['stroke-opacity']).toBe('0.4')
    expect(attrs(MARK_SCENES.symbol!, '.mark-symbol path')['stroke-linejoin']).toBe('round')
    expect(attrs(MARK_SCENES.arc!, '.mark-arc path')['stroke-linecap']).toBe('round')
    expect(attrs(MARK_SCENES.path!, '.mark-path path').transform).toBe('translate(5,6) scale(2,3)')
    // rounded frame
    expect(attrs(MARK_SCENES['clipped mark groups, gradient defs, frame']!, 'path.background').d).toContain('C')
    // data-datum on every item-level element
    for (const [k, sel] of [['text', 'text'], ['rule', 'line'], ['arc', 'path'], ['path', 'path'], ['image', 'image']] as const) {
      expect(attrs(MARK_SCENES[k]!, `.mark-${k === 'rule' ? 'rule' : k} ${sel}`)['data-datum'], k).toBe(paint.dataDatum)
    }
    // rotated guide text keeps its font-family
    const rotated = attrs(MARK_SCENES['group with guide leaves']!, 'text[transform]')
    expect(rotated['font-family']).toBe('Arial')
  })

  it('a first patch over the string-rendered DOM writes nothing', () => {
    for (const [name, scene] of Object.entries(MARK_SCENES)) {
      const host = document.createElement('div')
      host.innerHTML = renderSceneToSvg(scene)
      const svg = host.firstElementChild!
      const before = canon(svg)
      patchSceneDom(svg, scene)
      expect(firstDomDiff(before, canon(svg)), name).toBeNull()
    }
  })

  it('everything the string renderer writes is still escaped (one writer)', () => {
    const evil = '"><img src=x onerror=alert(1)>&'
    const scene = sceneOf([mark('symbol', [{ x: 1, y: 2, fill: evil, stroke: evil, dataDatum: evil }]), mark('path', [{ path: evil, fill: evil }])])
    const doc = parseSvg(renderSceneToSvg(scene))
    expect(doc.querySelector('img')).toBeNull()
    expect(sceneToDomDesc(scene).children!.length).toBeGreaterThan(0)
  })
})


describe('C43: the two sinks apply the same value rules', () => {
  const values: unknown[] = [
    undefined, null, 'transparent', 'red', '', 0, 3, -2.5, 1e21, Number.NaN, Infinity, true, false, [], [1, 2], [3, 'a&b', '"'],
    'a&b<c>"d\'e\tf\ng', '\u0000\uD800x', { gradient: 'g1' },
  ]
  for (const name of ['fill', 'stroke', 'opacity', 'stroke-dasharray', 'font-family']) {
    it(`attribute ${name}`, () => {
      for (const value of values) {
        const str = new StringAttrSink()
        const pair = new PairAttrSink()
        str.a(name, value)
        pair.a(name, value)
        // parse the string sink's output back with a real XML parser: same name, same decoded value
        const doc = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><g${str.s}/></svg>`)
        const el = doc.firstElementChild!
        const got = [...el.attributes].map((a) => [a.name, a.value])
        expect(got, `${name}=${String(value)}`).toEqual(pair.out.map(([k, v]) => [k, v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '\uFFFD').replace(/[\uD800-\uDFFF]/g, '\uFFFD')]))
      }
    })
  }
})
