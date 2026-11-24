// @vitest-environment jsdom
/**
 * DOM descriptor vs string renderer parity over the whole conformance corpus.
 *
 * `dom.ts` claimed the two renderers "can never drift". They did: the first
 * `patchSceneDom` over a string-rendered <svg> rewrote attributes (gradient
 * direction, dashes, linecaps, frame radius, trail fill, ...). For every scene of
 * the corpus (Vega and Vega-Lite specs) the DOM the patch path produces must be
 * attribute-for-attribute identical to the parsed output of `renderSceneToSvg`, by
 * four routes: a patch of an empty <svg>, a fresh DOM build, a patch of the SAME scene over its own string mount (what
 * `<Chart>` does on its first update: the element came from markup, so the patcher has no record of it), and a patch of
 * ANOTHER scene over a string mount (a chart whose scene changes: the markup of one scene, the patch of the next).
 * The comparison walks child NODES, text nodes included, and reads attributes by namespace and local name.
 *
 * There is NO allow-list of tolerated differences: both renderers take every
 * attribute from one per-element list (packages/core/src/render.ts), so any
 * difference is a bug. Hand-built scenes for what the corpus lacks are in
 * packages/core/src/dom-regressions.test.ts. This file lives in the conformance
 * package because it needs the Vega-Lite compiler (core's sources may not import
 * the oracle stack). It runs against the built packages (`pnpm build` first).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as vl from 'vega-lite'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import { patchSceneDom, renderSceneToDomElement } from '@aster-charts/core/dom'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')

interface CanonEl { tag: string; attrs: Array<[string, string]>; kids: Array<CanonEl | string> }

/** An element as compared: its attributes by namespace and name, and every child NODE in order (a text node is its text). */
function canon(el: Element): CanonEl {
  // (a namespace declaration is compared by its written name: the markup parses to one in the xmlns namespace, the DOM builder writes it plain)
  const attrs = [...el.attributes].map((a) => [a.name === 'xmlns' || a.name.startsWith('xmlns:') ? a.name : `${a.namespaceURI ?? ''}|${a.localName}`, a.value] as [string, string]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
  const kids: Array<CanonEl | string> = []
  for (const n of el.childNodes) {
    if (n.nodeType === 1) kids.push(canon(n as Element))
    else if (n.nodeType === 3 || n.nodeType === 4) kids.push(n.textContent ?? '')
    else kids.push(`#node${n.nodeType}:${n.textContent ?? ''}`)
  }
  return { tag: el.tagName, attrs, kids }
}

const nodeName = (k: CanonEl | string): string => (typeof k === 'string' ? `#text(${JSON.stringify(k.slice(0, 40))})` : k.tag)

function firstDiff(a: CanonEl, b: CanonEl, path = 'svg'): string | null {
  if (a.tag !== b.tag) return `${path}: tag ${a.tag} vs ${b.tag}`
  const am = new Map(a.attrs), bm = new Map(b.attrs)
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    if (am.get(k) !== bm.get(k)) return `${path}<${a.tag}>@${k}: ${JSON.stringify(am.get(k))} (string) vs ${JSON.stringify(bm.get(k))} (DOM)`
  }
  if (a.kids.length !== b.kids.length) return `${path}<${a.tag}>: children [${a.kids.map(nodeName).join(' ')}] vs [${b.kids.map(nodeName).join(' ')}]`
  for (let i = 0; i < a.kids.length; i++) {
    const x = a.kids[i]!
    const y = b.kids[i]!
    if (typeof x === 'string' || typeof y === 'string') {
      if (x !== y) return `${path}<${a.tag}> child ${i}: ${nodeName(x)} (string) vs ${nodeName(y)} (DOM)`
      continue
    }
    const d = firstDiff(x, y, `${path}/${x.tag}[${i}]`)
    if (d) return d
  }
  return null
}

function parseSvg(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(`string renderer emitted invalid XML: ${err.textContent?.slice(0, 200)}`)
  return doc.documentElement
}

/** A string mount, as `<Chart>` makes it: the markup of `scene` set into a host element, whose <svg> the patcher then receives. */
function stringMount(scene: ReturnType<typeof evaluateChart>): Element {
  const host = document.createElement('div')
  host.innerHTML = renderSceneToSvg(scene)
  return host.firstElementChild!
}

describe('the comparison itself (planted differences it must see)', () => {
  const el = (markup: string): CanonEl => canon(parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`))
  it('sees text beside element children, a text node in another place, and attribute namespaces', () => {
    expect(firstDiff(el('<text>STRAY<tspan>one</tspan><tspan>two</tspan></text>'), el('<text><tspan>one</tspan><tspan>two</tspan></text>'))).not.toBeNull()
    expect(firstDiff(el('<text><tspan>one</tspan>x<tspan>two</tspan></text>'), el('<text><tspan>one</tspan><tspan>two</tspan>x</text>'))).not.toBeNull()
    expect(firstDiff(el('<image xlink:href="a"/>'), el('<image href="a"/>'))).not.toBeNull()
    expect(firstDiff(el('<text>a<tspan>b</tspan></text>'), el('<text>a<tspan>b</tspan></text>'))).toBeNull()
  })
})

describe('DOM descriptor === string renderer over the conformance corpus', () => {
  const allFiles = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
  // The corpus is cut into slices, one test each: one long synchronous test keeps a vitest worker from answering its host
  // (Timeout calling onTaskUpdate), and a slice names where a difference is.
  const SLICE = 40
  let checkedTotal = 0
  const sceneOf = new Map<string, ReturnType<typeof evaluateChart>>()
  it('covers the corpus', () => {
    expect(allFiles.length).toBeGreaterThan(300)
  })
  for (let from = 0; from < allFiles.length; from += SLICE) it(`holds for corpus scenes ${from}-${from + SLICE}, through the patch path and a fresh build`, async () => {
    const files = allFiles.slice(from, from + SLICE)
    const failures: string[] = []
    let checked = 0
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
      // only a true wrapper doc ({ spec }) is unwrapped: a Vega-Lite repeat / facet spec carries a
      // nested `spec` child of its own and has a $schema (same rule as run-vl.ts)
      let spec = doc.$schema ? doc : (doc.spec ?? doc)
      if (f.endsWith('.vl.json')) spec = vl.compile(spec).spec
      let scene
      try {
        scene = evaluateChart(compileChart(await loadSpecData(spec, TRUSTED_LOAD_OPTIONS)), {})
      } catch (e) {
        failures.push(`${f}: could not build the scene: ${(e as Error).message}`)
        continue
      }
      checked++
      sceneOf.set(f, scene)
      try {
        const fromString = canon(parseSvg(renderSceneToSvg(scene)))
        // the patch path from nothing, a fresh DOM build, and the patch of the scene over its own string mount (what <Chart> does
        // on its first update: the element came from markup, the patcher has no record of it)
        const patched = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        patchSceneDom(patched, scene)
        const mounted = stringMount(scene)
        patchSceneDom(mounted as SVGSVGElement, scene)
        const d = firstDiff(fromString, canon(patched)) ?? firstDiff(fromString, canon(renderSceneToDomElement(scene, document))) ?? firstDiff(fromString, canon(mounted))
        if (d) failures.push(`${f}: ${d}`)
      } catch (e) {
        failures.push(`${f}: threw ${(e as Error).message}`)
      }
    }
    checkedTotal += checked
    expect(failures.join('\n'), `${failures.length} corpus scene(s) differ between the string and DOM renderers`).toBe('')
  }, 600_000)
  it('built a scene for (nearly) the whole corpus', () => {
    expect(checkedTotal).toBeGreaterThan(300)
  })

  // A chart whose scene changes: the markup of one scene, then the patch of another (the item counts, the lines of a text, the
  // marks and the guides all change). Every scene is the "next" of another, and each pair is compared with the fresh markup of the next.
  it('patching ANOTHER scene over a string mount equals the next scene\'s own markup, for pairs across the corpus', () => {
    const scenes = [...sceneOf.entries()]
    expect(scenes.length).toBeGreaterThan(300)
    const failures: string[] = []
    let pairs = 0
    for (let i = 0; i < scenes.length; i++) {
      // (the next scene in the list is a near twin of this one; a stride of 7 pairs unlike ones, and every scene is a next of another)
      for (const j of [(i * 7 + 3) % scenes.length]) {
        const [fa, a] = scenes[i]!
        const [fb, b] = scenes[j]!
        if (fa === fb) continue
        pairs++
        try {
          const mounted = stringMount(a)
          patchSceneDom(mounted as SVGSVGElement, b)
          const d = firstDiff(canon(parseSvg(renderSceneToSvg(b))), canon(mounted))
          if (d) failures.push(`${fa} -> ${fb}: ${d}`)
        } catch (e) {
          failures.push(`${fa} -> ${fb}: threw ${(e as Error).message}`)
        }
        if (failures.length > 8) break
      }
    }
    expect(pairs).toBeGreaterThan(900)
    expect(failures.join('\n'), `${failures.length} pair(s) differ`).toBe('')
  }, 600_000)

  // Scenes the corpus lacks: text whose lines change (the C136 sequence), item counts that change, and attribute values that need
  // escaping, patched over a string mount of another scene.
  describe('hand-built scene pairs, and hostile values', () => {
    const textScene = (text: unknown, extra: Record<string, unknown> = {}): ReturnType<typeof evaluateChart> =>
      evaluateChart(compileChart({ width: 120, height: 60, marks: [{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { value: text }, fill: { value: 'black' }, ...extra } } }] } as never), {})
    const rectScene = (n: number): ReturnType<typeof evaluateChart> =>
      evaluateChart(compileChart({ width: 120, height: 60, data: [{ name: 'd', values: Array.from({ length: n }, (_, i) => ({ i })) }], marks: [{ type: 'rect', from: { data: 'd' }, encode: { update: { x: { field: 'i', mult: 10 }, y: { value: 5 }, width: { value: 8 }, height: { value: 8 }, fill: { value: 'steelblue' } } } }] } as never), {})
    const check = (a: ReturnType<typeof evaluateChart>, b: ReturnType<typeof evaluateChart>): void => {
      const mounted = stringMount(a)
      patchSceneDom(mounted as SVGSVGElement, b)
      expect(firstDiff(canon(parseSvg(renderSceneToSvg(b))), canon(mounted))).toBeNull()
    }
    it('a text of one line becomes several, and several become one', () => {
      check(textScene('one'), textScene(['one', 'two']))
      check(textScene(['one', 'two', 'three']), textScene('one'))
      check(textScene(['one', 'two']), textScene(['one', 'two']))
      check(textScene(''), textScene(['', 'x']))
    })
    it('the number of items changes', () => {
      check(rectScene(3), rectScene(7))
      check(rectScene(7), rectScene(0))
      check(rectScene(0), rectScene(2))
    })
    it('quotes, markup characters and ampersands in a text, a font, a title and a link are attribute values, not markup', () => {
      const hostile = ['a"b', "it's", '<b>&amp;</b>', 'x & y < z > w', '\u00e9\u4e2d\ud83d\ude00', 'line\nbreak', '&#x3c;script&#x3e;', ' leading and trailing ']
      for (const v of hostile) {
        check(textScene('plain'), textScene(v, { font: { value: v }, tooltip: { value: v }, aria: { value: true }, description: { value: v }, href: { value: 'https://example.com/?a=1&b="2"' }, angle: { value: 30 } }))
        check(textScene(v, { font: { value: v }, description: { value: v } }), textScene(v + '!', { description: { value: v + '!' } }))
      }
    })
    it('a non-numeric angle is written the same way by both (C550)', () => {
      check(textScene('t'), textScene('t', { angle: { value: 'a"b' } }))
      check(textScene('t', { angle: { value: '12' } }), textScene('t', { angle: { value: '<1>' } }))
    })
  })
})
