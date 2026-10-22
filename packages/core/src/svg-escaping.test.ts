// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from './index.js'
import { patchSceneDom, renderSceneToDomElement } from './addon-dom.js'
import type { SceneRoot } from './types.js'

// Regression + property suite for SVG string escaping (audit C2).
//
// Method: take a scene that contains every mark type, axis and legend leaf and
// a gradient def. For every channel the serializers read, overwrite that
// channel on every node with (a) a benign value of the right kind and (b) a
// hostile string. Parse both renders with a real XML parser (jsdom's
// image/svg+xml DOMParser, which is strict) and require the hostile document
// to have exactly the benign document's element/attribute-name structure.

const HOSTILE: string[] = [
  '"><img src=x onerror=alert(1)>',
  "' onload='alert(1)' x='",
  '</text><script>alert(1)</script><text>',
  '"/><circle r="9999" onclick="x"/><path d="',
  'javascript:alert(1)',
  '&amp;&quot;&#x22;&lt;',
  '\n"\tonmouseover="x"\r',
  ']]><![CDATA[<b>',
  '<!--',
  '\u0000\u0001\u0008\u000b\u001f￾￿',
  '\ud800 lone \udc00 surrogates',
  'M0,0"/><rect/><path d="',
  'a"b\'c<d>e&f',
]

const BENIGN_KIND = {
  num: 5,
  color: '#336699',
  str: 'hello',
  dash: [4, 2],
  path: 'M0,0L10,10',
  url: 'a.png',
} as const

type Kind = keyof typeof BENIGN_KIND
// Every channel the string renderer (render.ts) and the descriptor builder
// (dom.ts) read from an item / group.
const CHANNELS: Record<string, Kind> = {
  x: 'num', y: 'num', x2: 'num', y2: 'num', width: 'num', height: 'num', size: 'num', radius: 'num',
  innerRadius: 'num', outerRadius: 'num', startAngle: 'num', endAngle: 'num', padAngle: 'num', angle: 'num',
  cornerRadius: 'num', cornerRadiusTopLeft: 'num', cornerRadiusTopRight: 'num', cornerRadiusBottomLeft: 'num',
  cornerRadiusBottomRight: 'num', dx: 'num', dy: 'num', fontSize: 'num', lineHeight: 'num', limit: 'num',
  strokeWidth: 'num', opacity: 'num', fillOpacity: 'num', strokeOpacity: 'num', scaleX: 'num', scaleY: 'num',
  tension: 'num',
  fill: 'color', stroke: 'color',
  strokeDash: 'dash',
  shape: 'str', baseline: 'str', align: 'str', interpolate: 'str', orient: 'str', strokeJoin: 'str',
  strokeCap: 'str', font: 'str', fontWeight: 'str', text: 'str', role: 'str', dataDatum: 'str', ellipsis: 'str',
  lineBreak: 'str', aspect: 'str',
  path: 'path', clipPathD: 'path',
  url: 'url',
}

const SPEC = {
  width: 200, height: 120, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ a: 10, b: 20, c: 1 }, { a: 50, b: 60, c: 2 }, { a: 90, b: 40, c: 3 }] }],
  scales: [
    { name: 'sx', type: 'linear', domain: [0, 100], range: 'width' },
    { name: 'sy', type: 'linear', domain: [0, 100], range: 'height' },
    { name: 'col', type: 'sequential', domain: [1, 3], range: { scheme: 'blues' } },
    { name: 'col2', type: 'sequential', domain: [0, 9], range: { scheme: 'greens' } },
    { name: 'cat', type: 'ordinal', domain: [1, 2, 3], range: ['#111111', '#222222', '#333333'] },
  ],
  axes: [{ orient: 'bottom', scale: 'sx', title: 'x' }, { orient: 'left', scale: 'sy', grid: true, title: 'y' }],
  legends: [{ fill: 'col', type: 'gradient', title: 'g' }, { fill: 'col2', type: 'gradient', orient: 'bottom', title: 'h' }, { fill: 'cat', title: 'c' }],
  marks: [
    ...(['symbol', 'rect', 'text', 'rule', 'trail', 'arc', 'image', 'path', 'line', 'area'] as const).map((type) => ({
      type, from: { data: 't' },
      encode: { update: {
        x: { scale: 'sx', field: 'a' }, y: { scale: 'sy', field: 'b' },
        ...(type === 'rect' ? { width: { value: 10 }, height: { value: 10 } } : {}),
        ...(type === 'rule' ? { x2: { value: 150 }, y2: { value: 50 } } : {}),
        ...(type === 'text' ? { text: { field: 'a' }, fill: { value: '#000000' } } : {}),
        ...(type === 'image' ? { url: { value: 'a.png' }, width: { value: 10 }, height: { value: 10 } } : {}),
        ...(type === 'path' ? { path: { value: 'M0,0L5,5' }, stroke: { value: '#000000' } } : {}),
        ...(type === 'arc' ? { startAngle: { value: 0 }, endAngle: { value: 1 }, outerRadius: { value: 9 } } : {}),
        ...(type === 'trail' ? { size: { value: 3 } } : {}),
        ...(type === 'symbol' || type === 'rect' || type === 'arc' || type === 'trail' || type === 'area'
          ? { fill: { scale: 'col', field: 'c' } } : {}),
        ...(type === 'line' || type === 'symbol' ? { stroke: { value: '#000000' } } : {}),
      } },
    })),
    { type: 'group', clip: true, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 20 }, height: { value: 20 }, fill: { value: '#eeeeee' }, stroke: { value: '#000000' } } },
      marks: [{ type: 'symbol', encode: { update: { x: { value: 3 }, y: { value: 3 } } } }] },
  ],
}

function baseScene(): SceneRoot {
  return evaluateChart(compileChart(structuredClone(SPEC) as never), {})
}

/** Every node (groups and leaves) of a scene, root-first. */
function nodes(scene: SceneRoot): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (n: Record<string, unknown>): void => {
    out.push(n)
    const kids = n.items
    if (Array.isArray(kids)) for (const k of kids) walk(k as Record<string, unknown>)
  }
  for (const g of scene.items) walk(g as unknown as Record<string, unknown>)
  return out
}

function withChannel(channel: string, value: unknown): SceneRoot {
  const scene = baseScene()
  for (const n of nodes(scene)) n[channel] = Array.isArray(value) ? [...value] : value
  return scene
}

function hostileFor(kind: Kind, h: string): unknown {
  return kind === 'dash' ? [h, h] : h
}

// --- structure extraction -----------------------------------------------------

interface Sk { tag: string; attrs: string[]; kids: Sk[] }

function skeletonOf(el: Element): Sk {
  return {
    tag: el.localName,
    attrs: [...el.attributes].map((a) => a.name).sort(),
    kids: [...el.children].map(skeletonOf),
  }
}

function parseXml(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error(`not well-formed XML: ${err.textContent?.slice(0, 200)}`)
  return doc.documentElement
}

const skeletonOfSvg = (svg: string): Sk => skeletonOf(parseXml(svg))

/** Attribute names each tag may carry, from every benign render (see below). */
const ATTR_UNIVERSE = new Map<string, Set<string>>()
function learn(sk: Sk): void {
  let set = ATTR_UNIVERSE.get(sk.tag)
  if (!set) ATTR_UNIVERSE.set(sk.tag, (set = new Set()))
  for (const a of sk.attrs) set.add(a)
  for (const k of sk.kids) learn(k)
}

/**
 * Element tree (tags, order, nesting) must be identical. Attribute NAMES must
 * be identical, except that an attribute whose very presence is derived from
 * the value (e.g. `dy`, which exists only when a font size yields a non-zero
 * baseline offset) may differ; those must still be names some benign render of
 * that tag carries. A hostile value can therefore never introduce a new tag, a
 * new attribute name (`onerror`, `onload`, ...) or reshape the tree.
 */
function describeDiff(a: Sk, b: Sk, path = 'svg'): string | null {
  if (a.tag !== b.tag) return `${path}: tag ${a.tag} != ${b.tag}`
  const known = ATTR_UNIVERSE.get(a.tag)
  for (const name of a.attrs) {
    if (!known?.has(name)) return `${path}<${a.tag}>: unexpected attribute ${name}`
  }
  if (a.kids.length !== b.kids.length) return `${path}<${a.tag}>: ${a.kids.length} children != ${b.kids.length}`
  for (let i = 0; i < a.kids.length; i++) {
    const d = describeDiff(a.kids[i]!, b.kids[i]!, `${path}/${a.tag}[${i}]`)
    if (d) return d
  }
  return null
}

describe('C2: SVG string renderer escapes every attribute and text value', () => {
  it('the base scene covers every mark type, axis/legend leaves and a gradient', () => {
    const svg = renderSceneToSvg(baseScene())
    for (const cls of ['mark-symbol', 'mark-rect', 'mark-text', 'mark-rule', 'mark-trail', 'mark-arc', 'mark-image', 'mark-path', 'mark-line', 'mark-area', 'linearGradient']) {
      expect(svg, cls).toContain(cls)
    }
    expect(svg).toContain('x1="0" x2="1"') // horizontal gradient
    expect(svg).toContain('x1="0" x2="0"') // vertical gradient
    expect(svg).toContain('<clipPath')
    expect(svg).toContain('clip-path=')
    expect(svg).toContain('stop-color=')
    expect(svg).toContain('role="axis"')
    expect(svg).toContain('role="legend"')
    expect(() => parseXml(svg)).not.toThrow()
  })

  // Learn the benign attribute universe: the base scene plus every channel set
  // to a benign value of its kind.
  learn(skeletonOfSvg(renderSceneToSvg(baseScene())))
  for (const [channel, kind] of Object.entries(CHANNELS)) learn(skeletonOfSvg(renderSceneToSvg(withChannel(channel, BENIGN_KIND[kind]))))

  it('the attribute universe is non-trivial (guards the comparator)', () => {
    expect(ATTR_UNIVERSE.get('path')!.size).toBeGreaterThan(8)
    expect(ATTR_UNIVERSE.get('path')!.has('onerror')).toBe(false)
  })

  for (const [channel, kind] of Object.entries(CHANNELS)) {
    it(`channel ${channel}: hostile strings never change the document structure`, () => {
      const benign = skeletonOfSvg(renderSceneToSvg(withChannel(channel, BENIGN_KIND[kind])))
      for (const h of HOSTILE) {
        const svg = renderSceneToSvg(withChannel(channel, hostileFor(kind, h)))
        const hostile = skeletonOfSvg(svg)
        expect(describeDiff(hostile, benign), `${channel}=${JSON.stringify(h)}`).toBeNull()
      }
    })
  }

  const allChannels = (valueFor: (kind: Kind) => unknown): SceneRoot => {
    const scene = baseScene()
    for (const [channel, kind] of Object.entries(CHANNELS)) {
      for (const n of nodes(scene)) { const v = valueFor(kind); n[channel] = Array.isArray(v) ? [...v] : v }
    }
    return scene
  }
  const frameFields = (v: unknown, dash: unknown): SceneRoot => {
    const s = baseScene()
    s.background = v as string
    s.frameFill = v as string
    s.frameStroke = v as string
    s.frameStrokeDash = dash as number[]
    s.frameStrokeWidth = 1
    s.frameClip = true
    for (const def of s.defs ?? []) {
      ;(def as { id: string }).id = v as string
      for (const stop of def.colorStops) { stop.color = v as string; stop.offset = (typeof v === 'string' ? 0.5 : v) as number }
    }
    return s
  }
  learn(skeletonOfSvg(renderSceneToSvg(allChannels((k) => BENIGN_KIND[k]))))
  learn(skeletonOfSvg(renderSceneToSvg(frameFields('#336699', [4, 2]))))

  it('all channels hostile at once keeps the benign structure', () => {
    const benign = skeletonOfSvg(renderSceneToSvg(allChannels((k) => BENIGN_KIND[k])))
    for (const h of HOSTILE) {
      const d = describeDiff(skeletonOfSvg(renderSceneToSvg(allChannels((k) => hostileFor(k, h)))), benign)
      expect(d, JSON.stringify(h)).toBeNull()
    }
  })

  it('scene-level frame, background and gradient-def fields are escaped', () => {
    const benign = skeletonOfSvg(renderSceneToSvg(frameFields('#336699', [4, 2])))
    for (const h of HOSTILE) {
      const hostile = skeletonOfSvg(renderSceneToSvg(frameFields(h, [h, h])))
      expect(describeDiff(hostile, benign), JSON.stringify(h)).toBeNull()
    }
  })

  it('a non-numeric value in a numeric position never survives as itself', () => {
    const scene = withChannel('x', '"><img onerror=alert(1)>')
    const svg = renderSceneToSvg(scene)
    expect(svg).not.toContain('<img')
    expect(svg).not.toMatch(/onerror=/)
  })

  it('escaping does not alter benign output', () => {
    const svg = renderSceneToSvg(baseScene())
    expect(svg).not.toMatch(/&(amp|lt|gt|quot|#x)/)
  })

  it('end to end from a spec: hostile data columns used as fill, coordinates, text and path', () => {
    const mk = (v: unknown): never => ({
      width: 100, height: 100, autosize: 'none',
      data: [{ name: 't', values: [{ v }] }],
      marks: [
        { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { value: 5 }, fill: { field: 'v' }, stroke: { field: 'v' } } } },
        { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { value: 5 }, width: { value: 4 }, height: { value: 4 }, fill: { field: 'v' } } } },
        { type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { value: 5 }, text: { field: 'v' }, fill: { field: 'v' } } } },
        { type: 'path', from: { data: 't' }, encode: { update: { path: { field: 'v' }, fill: { field: 'v' } } } },
        { type: 'line', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 1 }, stroke: { field: 'v' } } } },
        { type: 'area', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 1 }, fill: { field: 'v' } } } },
        { type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'v' }, x: { field: 'v' }, y: { value: 1 } } } },
      ],
    }) as never
    const benign = skeletonOfSvg(renderSpec(mk('5')))
    for (const h of HOSTILE) {
      const svg = renderSpec(mk(h))
      expect(describeDiff(skeletonOfSvg(svg), benign), JSON.stringify(h)).toBeNull()
    }
  })

  it('DOM paths (fresh build and in-place patch) agree on structure for hostile scenes', () => {
    ATTR_UNIVERSE.clear()
    for (const [channel, kind] of Object.entries(CHANNELS)) {
      learn(skeletonOf(renderSceneToDomElement(withChannel(channel, BENIGN_KIND[kind]), document) as Element))
    }
    learn(skeletonOf(renderSceneToDomElement(baseScene(), document) as Element))
    for (const [channel, kind] of Object.entries(CHANNELS)) {
      const benignScene = withChannel(channel, BENIGN_KIND[kind])
      const benignDom = renderSceneToDomElement(benignScene, document) as Element
      const benignSk = skeletonOf(benignDom)
      for (const h of HOSTILE.slice(0, 4)) {
        const hostileScene = withChannel(channel, hostileFor(kind, h))
        const fresh = renderSceneToDomElement(hostileScene, document) as Element
        expect(describeDiff(skeletonOf(fresh), benignSk), `fresh ${channel}=${JSON.stringify(h)}`).toBeNull()
        const patched = renderSceneToDomElement(benignScene, document) as Element
        patchSceneDom(patched as unknown as SVGSVGElement, hostileScene)
        expect(describeDiff(skeletonOf(patched), benignSk), `patched ${channel}=${JSON.stringify(h)}`).toBeNull()
      }
    }
  })

  it('render.ts writes attribute values only through the shared writer (source guard)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'render.ts'), 'utf8')
    const interpolations = [...src.matchAll(/="\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]!.trim())
    expect(interpolations.length).toBeGreaterThan(20)
    const bad = interpolations.filter((e) => !/^(num3?|escAttr|fp)\(/.test(e))
    expect(bad, JSON.stringify(bad)).toEqual([])
  })

  it('escaping round-trips: a parser recovers the original characters exactly, once', () => {
    const v = 'a&b<c>d"e\'f\tg\nh'
    const scene = baseScene()
    for (const n of nodes(scene)) { n.fill = v; n.path = v; n.dataDatum = v; n.text = v }
    const doc = new DOMParser().parseFromString(renderSceneToSvg(scene), 'image/svg+xml')
    const fills = [...doc.querySelectorAll('[fill]')].map((e) => e.getAttribute('fill'))
    expect(fills).toContain(v)
    const ds = [...doc.querySelectorAll('path')].map((e) => e.getAttribute('d'))
    expect(ds).toContain(v)
    expect([...doc.querySelectorAll('[data-datum]')].map((e) => e.getAttribute('data-datum'))).toContain(v)
    // text content: tabs/newlines are collapsed by the line splitter, '&<>"' must survive once
    expect([...doc.querySelectorAll('text')].some((e) => (e.textContent ?? '').includes('a&b<c>d"e'))).toBe(true)
    const dash = baseScene()
    for (const n of nodes(dash)) n.strokeDash = ['x&y', 'z"w']
    const doc2 = new DOMParser().parseFromString(renderSceneToSvg(dash), 'image/svg+xml')
    expect([...doc2.querySelectorAll('[stroke-dasharray]')].map((e) => e.getAttribute('stroke-dasharray'))).toContain('x&y,z"w')
  })
})
