// @vitest-environment jsdom
/**
 * Every URL a renderer writes is vetted where it is written (audit T1; C1, C3, C20, C97, C286, C391): the attribute sinks of the
 * SVG renderers (render.ts `writtenText`, `AttrSink.u`), the urls the canvas loads (`sceneImageUrls`), the cursor a host shows
 * (`resolveCursor`). The checks here do not trust the code they test:
 *
 *  - the attribute names are DERIVED from the renderers' source (every name a sink call or a literal of render.ts / dom.ts
 *    writes), and every one the SVG grammar lets hold a URL is shown never to hold a refused one -- a renderer that starts writing a
 *    new URL-bearing attribute is in the list the day it is written;
 *  - the names written as generated text (the sinks' `t`/`n`/`g`, which do not vet) are derived too, and none of them may be one
 *    that holds a URL, but `clip-path`, whose every value is shown to be a clip id the renderer made;
 *  - what is written is judged by oracles of their own: the WHATWG parser against a web page's base and a `file:` page's base, and
 *    a CSS tokenizer (css-url.testlib.ts), never by url-policy.ts or paint-url.ts.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderSceneToSvg, writtenText, isUrlAttr, isTextAttr, StringAttrSink, PairAttrSink } from './render.js'
import { sceneToDomDesc, type DomDesc } from './dom.js'
import { renderSceneToCanvas, sceneImageUrls, type CanvasLike } from './canvas.js'
import { bindSceneUrlPolicy, AsterUrlError, type ImageUrlPolicy } from './url-policy.js'
import { resolveCursor, createCursorTracker } from './cursor.js'
import { cssUrls, namesAnotherDocument } from './css-url.testlib.js'
import { compileChart, evaluateChart, renderSpec } from './index.js'
import type { SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

const SRC = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8')

// --- oracles ------------------------------------------------------------------------------------------------------------

/**
 * What SVG 2 and CSS let hold a URL: the link attributes, and the presentation attributes whose grammar takes a `<url>` (a
 * paint, a clip, a mask, a filter, a marker, a cursor) or any declarations at all (`style`).
 */
const URL_ATTRS = new Set(['href', 'xlink:href', 'src'])
const CSS_URL_ATTRS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor', 'style'])
const urlCapable = (n: string): boolean => URL_ATTRS.has(n) || CSS_URL_ATTRS.has(n)

const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:']
const IMAGE_PROTOCOLS = ['http:', 'https:', 'data:']

/**
 * Whether a URL attribute's text is one the browser may follow / load: in a web page AND in a `file:` page (where a text with no
 * scheme of its own that names a host would be a `file://host` path), it is either a reference within the page's own origin (no
 * scheme, no host) or a URL of an allowed protocol with no credentials. An empty text names nothing.
 */
function urlOk(text: string, kind: 'link' | 'image'): boolean {
  if (text === '') return true
  const allowed = kind === 'link' ? LINK_PROTOCOLS : IMAGE_PROTOCOLS
  for (const base of ['https://page.test/dir/', 'file:///dir/page.html']) {
    let u: URL
    try { u = new URL(text, base) } catch { continue } // the browser follows nothing
    const pageOrigin = new URL(base)
    const sameDoc = u.protocol === pageOrigin.protocol && u.host === pageOrigin.host && !/^[\s\u0000-\u001f]*[a-z][a-z0-9+.-]*:/i.test(text)
    if (sameDoc) continue
    if (!allowed.includes(u.protocol) || u.username !== '' || u.password !== '') return false
  }
  return true
}

const HOSTILE = [
  'javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'JaVaScRiPt:alert(1)', '\u0001javascript:alert(1)', 'vbscript:x',
  'file://javascript:alert(1)', 'file://vbscript:x', 'file://data:text/html,<script>alert(1)</script>', 'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd', 'file:////evil.test/share', 'ftp://evil.test/x', 'blob:https://evil.test/u', 'https://user:pw@evil.test/a.png',
  'https://evil.test\\@good.test/', 'HTTPS://u:p@evil.test/', '//evil.test/x', '\\\\evil.test\\share', '/\\evil.test/x',
  'url(https://evil.test/x)', '\\75 rl(https://evil.test/x)', 'x; background:url(https://evil.test/y)', 'url(#ok) url(https://evil.test/z)',
  'https://good.test/ok.png', 'mailto:a@b.test', 'rel/path.png', '#frag', 'data:image/png;base64,AAAA',
]

// --- the names the renderers write, derived from their source -----------------------------------------------------------

interface Written { sinkVetted: Set<string>; generated: Set<string>; literal: Set<string> }

function writtenNames(): Written {
  const out: Written = { sinkVetted: new Set(), generated: new Set(), literal: new Set() }
  for (const file of ['render.ts', 'dom.ts']) {
    // (the code only: what a comment says an element looks like is not written)
    const src = SRC(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\.([avtngu])\(\s*'([^']+)'/g)) (('avu'.includes(m[1]!)) ? out.sinkVetted : out.generated).add(m[2]!)
    // the names a loop hands a sink (`for (const [attr, v] of [['fx', ...], ...]) w.v(attr, ...)`)
    for (const m of src.matchAll(/\[\s*'([a-z][a-z0-9:-]*)'\s*,\s*def\.[a-z0-9]+\s*\]/g)) out.sinkVetted.add(m[1]!)
    // attributes written into markup text as it is (render.ts templates), and attribute pairs written as data (dom.ts)
    for (const m of src.matchAll(/<[a-zA-Z]+((?:\s+[a-z][a-z0-9:-]*="[^"]*")+)\s*\/?>/g)) for (const a of m[1]!.matchAll(/([a-z][a-z0-9:-]*)="/g)) out.literal.add(a[1]!)
    if (file === 'dom.ts') for (const m of src.matchAll(/\[\s*'([a-z][a-z0-9:-]*)'\s*,\s*(?:'|`|[a-zA-Z])/g)) out.literal.add(m[1]!)
  }
  return out
}

describe('the attribute sink (render.ts): every attribute the renderers write', () => {
  const names = writtenNames()

  it('the derivation finds the renderers\' attributes (a floor, so a regex that matches nothing fails here)', () => {
    for (const n of ['xlink:href', 'fill', 'stroke', 'style', 'aria-label', 'data-datum', 'transform', 'clip-path', 'd', 'font-family']) {
      expect(names.sinkVetted.has(n) || names.generated.has(n), n).toBe(true)
    }
    expect(names.sinkVetted.size).toBeGreaterThan(30)
  })

  it('no attribute that can hold a URL is written as text the sink does not vet, but clip-path (a clip id the renderer made)', () => {
    expect([...names.generated].filter(urlCapable).filter((n) => n !== 'clip-path')).toEqual([])
    // markup written as it is, and descriptor pairs written as data: none at all that can hold a URL
    expect([...names.literal].filter(urlCapable)).toEqual([])
  })

  it('every name written through the sink (not only the URL-capable ones) never holds a refused URL or another document\'s url()', () => {
    const vetted = [...names.sinkVetted].filter((n) => !isTextAttr(n))
    expect(vetted.filter(urlCapable).length).toBeGreaterThan(3)
    for (const name of vetted) {
      for (const p of HOSTILE) {
        const x = writtenText(name, p)
        if (x === null) continue
        if (isUrlAttr(name)) expect(urlOk(x, 'link'), `${name} = ${JSON.stringify(p)} -> ${JSON.stringify(x)}`).toBe(true)
        else if (!isTextAttr(name)) expect(namesAnotherDocument(x), `${name} = ${JSON.stringify(p)} -> ${JSON.stringify(x)}`).toBe(false)
      }
    }
  })

  it('both sinks write the same text, the string one escaped', () => {
    // (texts with a C0 control character are left out: XML cannot carry one, and the escaping of them is svg-escaping.test.ts's)
    for (const name of [...names.sinkVetted]) {
      for (const p of HOSTILE.filter((t) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t))) {
        const s = new StringAttrSink()
        const q = new PairAttrSink()
        s.v(name, p); q.v(name, p)
        const parsed = s.s === '' ? [] : [[name, new DOMParser().parseFromString(`<x${s.s}></x>`, 'text/html').body.firstElementChild!.getAttribute(name)]]
        expect(parsed, `${name} ${JSON.stringify(p)}`).toEqual(q.out)
      }
    }
  })
})

// --- hand-made scenes: no evaluation in front of the renderers ------------------------------------------------------------

const MARKS = ['rect', 'symbol', 'text', 'image', 'path', 'arc', 'rule', 'line', 'area', 'trail', 'circle'] as const

/** The item channels a renderer may read: the scene type's fields (types.ts SceneItem) and those vega's renderers read besides. */
function sceneChannels(): string[] {
  const src = SRC('types.ts')
  const body = /export interface SceneItem \{([\s\S]*?)\n\}/.exec(src)![1]!
  const names = [...body.matchAll(/^\s+([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!)
  return [...new Set([...names, 'href', 'url', 'image', 'cursor', 'tooltip', 'fontVariant', 'smooth', 'scaleX', 'scaleY', 'dir'])]
}

/** The channels whose text is geometry the renderers parse (a symbol shape, a path, a curve name): they keep drawable values. */
const PARSED = new Set(['shape', 'path', 'interpolate', 'orient'])

function hostileScene(payload: string, policy?: ImageUrlPolicy): SceneRoot {
  const channels = sceneChannels().filter((c) => !c.startsWith('_') && c !== 'datum' && c !== 'mark' && !PARSED.has(c))
  const groups: SceneGroup[] = MARKS.map((marktype, k) => {
    const item: Record<string, unknown> = { x: 10 + k, y: 10, x2: 20, y2: 20, width: 5, height: 5, size: 20, text: 't', path: 'M0,0L1,1' }
    // every channel that holds text takes the payload (a number channel keeps its number: the geometry must be drawable)
    for (const c of channels) if (item[c] === undefined) item[c] = payload
    item.image = { src: payload, width: 4, height: 4 }
    const second = { ...item, x: 30 + k }
    return { marktype, role: 'mark', items: [item, second] as SceneItem[], hasLinks: true } as SceneGroup
  })
  const scene: SceneRoot = {
    width: 200, height: 100, padding: { top: 0, left: 0, right: 0, bottom: 0 }, background: payload, items: groups,
    frameFill: payload, frameStroke: payload, frameClip: true,
    defs: [{ id: payload, kind: 'radial', colorStops: [{ offset: 0, color: payload }] }, { id: `l${payload}`, colorStops: [{ offset: 1, color: payload }] }],
  } as unknown as SceneRoot
  bindSceneUrlPolicy(scene, policy)
  return scene
}

/** Every attribute of every element of a rendered SVG (from markup), with its element's tag. */
function attrsOfMarkup(svg: string): Array<{ tag: string; name: string; value: string }> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out: Array<{ tag: string; name: string; value: string }> = []
  for (const el of [...doc.getElementsByTagName('*')]) for (const a of [...el.attributes]) out.push({ tag: el.localName, name: a.name, value: a.value })
  return out
}
function attrsOfDesc(d: DomDesc, out: Array<{ tag: string; name: string; value: string }> = []): Array<{ tag: string; name: string; value: string }> {
  for (const [name, value] of d.attrs) out.push({ tag: d.tag, name, value })
  for (const c of d.children ?? []) attrsOfDesc(c, out)
  return out
}

function checkAttrs(attrs: Array<{ tag: string; name: string; value: string }>, label: string, denyAll: boolean): void {
  for (const { tag, name, value } of attrs) {
    expect(name.startsWith('on'), `${label}: <${tag} ${name}>`).toBe(false)
    if (URL_ATTRS.has(name)) {
      expect(urlOk(value, tag === 'image' ? 'image' : 'link'), `${label}: <${tag} ${name}="${value}">`).toBe(true)
      // (an allow hook that permits nothing: no URL at all, not even a relative one, as there is no base to vet it against)
      if (denyAll) expect(value, `${label}: <${tag} ${name}>`).toBe('')
    } else if (name === 'clip-path') {
      expect(value, `${label}: clip-path`).toMatch(/^url\(#clip[a-z0-9_]+\)$/)
    } else if (!isTextAttr(name)) {
      expect(namesAnotherDocument(value), `${label}: <${tag} ${name}="${value}">`).toBe(false)
    }
  }
}

/**
 * A recording context: the properties assigned. (What a canvas can be made to load from a text: an image a host loads from
 * `sceneImageUrls`, and a `filter`, which may name an SVG filter by url(); a paint or a font is a colour or a font to it.)
 */
function recordingCtx(): { ctx: CanvasLike; assigned: Map<string, unknown[]> } {
  const assigned = new Map<string, unknown[]>()
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(t, k) {
      if (typeof k !== 'string') return undefined
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 5 })
      if (k.startsWith('create')) return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t, k, v) { assigned.set(k as string, [...(assigned.get(k as string) ?? []), v]); t[k as string] = v; return true },
  }) as unknown as CanvasLike
  return { ctx, assigned }
}

describe('hand-made scenes: every channel of every mark holds a hostile text, and nothing evaluated them', () => {
  for (const denyAll of [false, true]) {
    const policy: ImageUrlPolicy | undefined = denyAll ? { allow: () => false } : undefined
    it(`SVG string and DOM descriptors write no refused URL (${denyAll ? 'a policy that allows nothing' : 'no policy: the defaults'})`, () => {
      for (const p of HOSTILE) {
        const scene = hostileScene(p, policy)
        checkAttrs(attrsOfMarkup(renderSceneToSvg(scene)), `svg ${JSON.stringify(p)}`, denyAll)
        checkAttrs(attrsOfDesc(sceneToDomDesc(scene)), `dom ${JSON.stringify(p)}`, denyAll)
      }
    })

    it(`canvas: the urls a host loads, and anything handed to the context (${denyAll ? 'a policy that allows nothing' : 'the defaults'})`, () => {
      for (const p of HOSTILE) {
        const scene = hostileScene(p, policy)
        for (const it of scene.items[3]!.items as SceneItem[]) delete (it as { image?: unknown }).image
        const urls = sceneImageUrls(scene)
        for (const u of urls) expect(urlOk(u, 'image'), `${JSON.stringify(p)} -> ${u}`).toBe(true)
        if (denyAll) expect(urls).toEqual([])
        const { ctx, assigned } = recordingCtx()
        renderSceneToCanvas(scene, ctx)
        expect(assigned.has('filter'), JSON.stringify(p)).toBe(false)
        // (the control: the paint was drawn at all)
        expect(assigned.has('fillStyle')).toBe(true)
      }
    })
  }

  it('the cursor a host shows is a CSS keyword or nothing, from the signal and from the item alike', () => {
    for (const p of [...HOSTILE, 'pointer', 'POINTER ', 'url(https://evil.test/c.png), auto', 'url(a.cur), pointer', 'grab', 'zoom-in', 'inherit', '']) {
      for (const shown of [resolveCursor(p, null), resolveCursor(null, p), resolveCursor({ user: p, item: p }, p), resolveCursor('default', p)]) {
        if (shown === null) continue
        expect(shown, JSON.stringify(p)).toMatch(/^[a-z-]+$/)
        expect(namesAnotherDocument(shown)).toBe(false)
      }
    }
    // the tracker never shows such a value: over an item whose cursor is a url the cursor stays as it was (as a browser ignores
    // vega's assignment of a value it does not take), and a keyword item cursor is shown
    const seen: Array<string | null> = []
    let cursor = 'url(https://evil.test/c.png), auto'
    const t = createCursorTracker({ pick: () => ({ item: { cursor } }), user: () => undefined, onCursor: (c) => seen.push(c) })
    t.move(1, 1)
    expect(seen).toEqual([])
    cursor = 'pointer'
    t.move(1, 1)
    cursor = 'url(https://evil.test/c.png)'
    t.move(1, 1)
    expect(seen).toEqual(['pointer'])
    // control: a keyword is shown
    expect(resolveCursor('default', 'pointer')).toBe('pointer')
    expect(resolveCursor('Pointer', null)).toBe('pointer')
  })
})

// --- C286: the allow hook sees exactly the url that is drawn ---------------------------------------------------------------

describe('an image url is vetted as it is drawn', () => {
  const imageSpec = (url: string): VgSpec => ({
    width: 20, height: 20, data: [{ name: 't', values: [{ u: url }] }],
    marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, width: { value: 5 }, height: { value: 5 } } } }],
  } as unknown as VgSpec)
  const drawn = (svg: string): string | undefined => /<image[^>]*xlink:href="([^"]*)"/.exec(svg)?.[1]

  it('allow is asked once, about the url written into the output, for every base and url shape', () => {
    for (const baseURL of ['https://app.test/dash/page.html?id=3', 'https://app.test/dash/', 'https://app.test/dash', 'https://app.test']) {
      for (const url of ['logo.png', '../logo.png', '/logo.png', ' https://cdn.test/a.png', 'HTTPS://cdn.test/a.png', '//cdn.test/a.png', 'http:/evil.test/a.png']) {
        const asked: string[] = []
        const svg = renderSpec(imageSpec(url), { urlPolicy: { baseURL, allow: (u) => { asked.push(u.href); return true } } })
        const href = drawn(svg)!
        expect(asked.length, `${baseURL} + ${url}`).toBe(1)
        expect(new URL(href).href, `${baseURL} + ${url}`).toBe(asked[0])
      }
    }
  })

  it('a refused scheme stays refused though the drawn form would be a path (file:)', () => {
    expect(() => renderSpec(imageSpec('file:///etc/passwd'), { urlPolicy: { baseURL: 'https://app.test/' } })).toThrowError(AsterUrlError)
  })
})

// --- every channel through the evaluation: a policy that refuses a host keeps it out of every output ------------------------

describe('a URL the policy refuses reaches no output, whatever channel or part of the chart holds it (C8, C20)', () => {
  const channels = sceneChannels().filter((c) => !c.startsWith('_') && c !== 'datum' && c !== 'mark')
  /** The parts of a chart that hold the channel, each with its own URL (`https://deny.test/<part>/<channel>`). */
  const PARTS = ['axis-labels', 'axis-title', 'axis-axis', 'legend-symbols', 'legend-labels', 'legend-title', 'legend-legend', 'title-title',
    'title-subtitle', 'title-group', 'group-title', 'group', 'group-rect', ...MARKS.filter((m) => m !== 'circle').map((m) => `mark-${m}`)]
  const specWith = (channel: string): VgSpec => {
    const ch = (part: string): Record<string, unknown> => ({ [channel]: { value: `https://deny.test/${part}/${channel}` } })
    return {
      width: 120, height: 80, data: [{ name: 't', values: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 3], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }],
      axes: [{ orient: 'bottom', scale: 'x', title: 'X', encode: { labels: { update: ch('axis-labels') }, title: { update: ch('axis-title') }, axis: { update: ch('axis-axis') } } }],
      legends: [{ fill: 'c', title: 'C', encode: { symbols: { update: ch('legend-symbols') }, labels: { update: ch('legend-labels') }, title: { update: ch('legend-title') }, legend: { update: ch('legend-legend') } } }],
      title: { text: 'T', subtitle: 'S', encode: { title: { update: ch('title-title') }, subtitle: { update: ch('title-subtitle') }, group: { update: ch('title-group') } } },
      marks: [
        ...MARKS.filter((m) => m !== 'circle').map((type) => ({ type, from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 10 }, width: { value: 4 }, height: { value: 4 }, ...ch(`mark-${type}`) } } })),
        { type: 'group', title: { text: 'G', encode: { title: { update: ch('group-title') } } }, encode: { update: { width: { value: 30 }, height: { value: 30 }, ...ch('group') } }, marks: [{ type: 'rect', encode: { update: { width: { value: 3 }, height: { value: 3 }, ...ch('group-rect') } } }] },
      ],
    } as unknown as VgSpec
  }

  it('every scene channel, on every mark type, the guides, the titles and a group: no URL output holds the refused host', () => {
    const denied: string[] = []
    const policy: ImageUrlPolicy = { allow: (u) => u.hostname !== 'deny.test', onDeny: (u) => denied.push(u), baseURL: 'https://app.test/' }
    let evaluated = 0
    for (const channel of channels) {
      let scene: SceneRoot
      try { scene = evaluateChart(compileChart(specWith(channel)), { urlPolicy: policy }) } catch { continue } // a channel whose text cannot be drawn (a path)
      evaluated++
      // the URLs of the output: URL attributes, the url()s of every other attribute that is CSS, the images a canvas host loads
      const urlsOf = (attrs: Array<{ name: string; value: string }>): string[] =>
        attrs.flatMap((a) => (URL_ATTRS.has(a.name) ? [a.value] : isTextAttr(a.name) ? [] : cssUrls(a.value)))
      const outputs = [...urlsOf(attrsOfMarkup(renderSceneToSvg(scene))), ...urlsOf(attrsOfDesc(sceneToDomDesc(scene))), ...sceneImageUrls(scene)]
      for (const v of outputs) expect(v, channel).not.toContain('deny.test')
    }
    expect(evaluated).toBeGreaterThan(channels.length - 5)
    // the evaluation reported the refusal (onDeny), where it happened: the link of EVERY part (the titles' text items are two
    // levels down their group), and an image mark's url and bitmap
    expect(PARTS.filter((part) => !denied.includes(`https://deny.test/${part}/href`))).toEqual([])
    expect(denied).toContain('https://deny.test/mark-image/url')
  })

  it('control: an allowed host is written (the test can see a link and an image at all)', () => {
    const svg = renderSceneToSvg(evaluateChart(compileChart(specWith('href')), { urlPolicy: { allow: () => true, baseURL: 'https://app.test/' } }))
    // (every part that can hold a link holds it: the marks, the axis, the legend, the titles, the group)
    expect(PARTS.filter((part) => !svg.includes(`<a xlink:href="https://deny.test/${part}/href">`))).toEqual([])
  })

  it('the `image` channel (an object with a src) goes through the policy too, under limits and with a hook', () => {
    const spec = (src: string): VgSpec => ({ width: 20, height: 20, marks: [{ type: 'image', encode: { update: { width: { value: 5 }, height: { value: 5 }, image: { value: { src, width: 1, height: 1 } } } } }] } as unknown as VgSpec)
    expect(() => renderSpec(spec('javascript:alert(1)'), { limits: {} })).toThrowError(AsterUrlError)
    expect(() => renderSpec(spec('https://attacker.test/t.png'), { urlPolicy: { allow: (u) => u.hostname === 'trusted.test' } })).toThrowError(AsterUrlError)
    const denied: string[] = []
    expect(renderSpec(spec('https://attacker.test/t.png'), { urlPolicy: { allow: (u) => u.hostname === 'trusted.test', onDeny: (u) => denied.push(u) } })).not.toContain('attacker')
    expect(denied).toEqual(['https://attacker.test/t.png'])
    expect(renderSpec(spec('https://trusted.test/t.png'), { urlPolicy: { allow: (u) => u.hostname === 'trusted.test' } })).toContain('xlink:href="https://trusted.test/t.png"')
    // with no policy at all: a script url is not written
    expect(renderSpec(spec('javascript:alert(1)'))).not.toContain('javascript')
  })
})
