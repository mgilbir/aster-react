/** Test-only helpers (excluded from the published build): canonical DOM serialisation and string-vs-DOM parity. */
import { renderSceneToSvg } from './index.js'
import { patchSceneDom, renderSceneToDomElement } from './addon-dom.js'
import type { SceneRoot } from './types.js'

export interface CanonEl { tag: string; attrs: Array<[string, string]>; text?: string; kids: CanonEl[] }

export function canon(el: Element): CanonEl {
  const attrs = [...el.attributes].map((a) => [a.name, a.value] as [string, string]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
  const kids = [...el.children].map(canon)
  const out: CanonEl = { tag: el.tagName, attrs, kids }
  if (kids.length === 0) out.text = el.textContent ?? ''
  return out
}

export function firstDomDiff(a: CanonEl, b: CanonEl, path = 'svg'): string | null {
  if (a.tag !== b.tag) return `${path}: tag ${a.tag} vs ${b.tag}`
  const am = new Map(a.attrs), bm = new Map(b.attrs)
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    if (am.get(k) !== bm.get(k)) return `${path}<${a.tag}>@${k}: ${JSON.stringify(am.get(k))} vs ${JSON.stringify(bm.get(k))}`
  }
  if (a.text !== b.text) return `${path}<${a.tag}> text: ${JSON.stringify(a.text)} vs ${JSON.stringify(b.text)}`
  if (a.kids.length !== b.kids.length) return `${path}<${a.tag}>: ${a.kids.length} children vs ${b.kids.length}`
  for (let i = 0; i < a.kids.length; i++) {
    const d = firstDomDiff(a.kids[i]!, b.kids[i]!, `${path}/${a.kids[i]!.tag}[${i}]`)
    if (d) return d
  }
  return null
}


export function parseSvg(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(`string renderer emitted invalid XML: ${err.textContent?.slice(0, 200)}`)
  return doc.documentElement
}

/** DOM parity for one scene; returns the first difference or null. */
export function parityDiff(scene: SceneRoot): string | null {
  const svg = renderSceneToSvg(scene)
  const fromString = canon(parseSvg(svg))
  // the patch path, from nothing (what <Chart> does after its first string mount)
  const patched = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  patchSceneDom(patched, scene)
  const d1 = firstDomDiff(fromString, canon(patched))
  if (d1) return `patch: ${d1}`
  const built = renderSceneToDomElement(scene, document)
  const d2 = firstDomDiff(fromString, canon(built))
  return d2 ? `fresh: ${d2}` : null
}

