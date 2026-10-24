// @vitest-environment jsdom
/**
 * DOM descriptor vs string renderer parity over the whole conformance corpus
 * (audit C43, T2).
 *
 * `dom.ts` claimed the two renderers "can never drift". They did: the first
 * `patchSceneDom` over a string-rendered <svg> rewrote attributes (gradient
 * direction, dashes, linecaps, frame radius, trail fill, ...). For every scene of
 * the corpus (Vega and Vega-Lite specs) the DOM the patch path produces must be
 * attribute-for-attribute identical to the parsed output of `renderSceneToSvg`.
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
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
import { patchSceneDom, renderSceneToDomElement } from '@aster/core/dom'
import { loadSpecData } from '@aster/core/load'
import '@aster/core/geo'
import '@aster/core/transforms'

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')

interface CanonEl { tag: string; attrs: Array<[string, string]>; text?: string; kids: CanonEl[] }

function canon(el: Element): CanonEl {
  const attrs = [...el.attributes].map((a) => [a.name, a.value] as [string, string]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
  const kids = [...el.children].map(canon)
  return { tag: el.tagName, attrs, kids, ...(kids.length === 0 ? { text: el.textContent ?? '' } : {}) }
}

function firstDiff(a: CanonEl, b: CanonEl, path = 'svg'): string | null {
  if (a.tag !== b.tag) return `${path}: tag ${a.tag} vs ${b.tag}`
  const am = new Map(a.attrs), bm = new Map(b.attrs)
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    if (am.get(k) !== bm.get(k)) return `${path}<${a.tag}>@${k}: ${JSON.stringify(am.get(k))} (string) vs ${JSON.stringify(bm.get(k))} (DOM)`
  }
  if (a.text !== b.text) return `${path}<${a.tag}> text: ${JSON.stringify(a.text)} vs ${JSON.stringify(b.text)}`
  if (a.kids.length !== b.kids.length) return `${path}<${a.tag}>: ${a.kids.length} children vs ${b.kids.length}`
  for (let i = 0; i < a.kids.length; i++) {
    const d = firstDiff(a.kids[i]!, b.kids[i]!, `${path}/${a.kids[i]!.tag}[${i}]`)
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

describe('DOM descriptor === string renderer over the conformance corpus (audit C43)', () => {
  it('holds for every corpus scene, through the patch path and a fresh build', async () => {
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
    expect(files.length).toBeGreaterThan(300)
    const failures: string[] = []
    let checked = 0
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
      let spec = doc.spec ?? doc
      if (f.endsWith('.vl.json')) spec = vl.compile(spec).spec
      let scene
      try {
        scene = evaluateChart(compileChart(await loadSpecData(spec)), {})
      } catch (e) {
        failures.push(`${f}: could not build the scene: ${(e as Error).message}`)
        continue
      }
      checked++
      try {
        const fromString = canon(parseSvg(renderSceneToSvg(scene)))
        // the patch path from nothing (what <Chart> does after its first string mount)
        const patched = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        patchSceneDom(patched, scene)
        const d = firstDiff(fromString, canon(patched)) ?? firstDiff(fromString, canon(renderSceneToDomElement(scene, document)))
        if (d) failures.push(`${f}: ${d}`)
      } catch (e) {
        failures.push(`${f}: threw ${(e as Error).message}`)
      }
    }
    expect(checked).toBeGreaterThan(300)
    expect(failures.join('\n'), `${failures.length} corpus scene(s) differ between the string and DOM renderers`).toBe('')
  }, 600_000)
})
