/**
 * Items of vega's scenegraph and of Aster's scene, named by their place: the names of the marks and the indices of the group items
 * above an item, its mark's name and its own index (`/g0[1]/m2[3]`); a mark is named by its path (`/g0[1]/m2`), a group mark by
 * its own (`/g0`). The specs these are used on (`geometry-specs.ts`) give every mark a unique name and have no guides, so the place
 * is the identity of an item on both sides: a differential compares what one side answers with what the other does by this name,
 * never by the order items are first met in (where two items swapped would read alike).
 *
 * Aster's scene holds a group mark as its group items, one node each (`_scope`), next to each other in their parent, each holding
 * its own box (`_bg`, not an item) and its marks, a clipped one's content inside a node that clips it (`contentClip`).
 */

export interface VegaNode {
  marktype?: string
  name?: string
  role?: string
  items?: VegaNode[]
  bounds?: { x1: number; y1: number; x2: number; y2: number }
  mark?: VegaNode
  clip?: unknown
  interactive?: boolean
  [k: string]: unknown
}

export interface AsterNode {
  marktype?: string
  name?: string
  items?: AsterNode[]
  _scope?: boolean
  _bg?: boolean
  contentClip?: boolean
  [k: string]: unknown
}

/** The marks and items of vega's root group item, by name. A group mark's entry is the mark; each group item is an item. */
export function vegaPlaces(rootItem: VegaNode): Map<string, VegaNode> {
  const out = new Map<string, VegaNode>()
  const walk = (marks: VegaNode[], path: string): void => {
    for (const m of marks) {
      const p = `${path}/${m.name}`
      out.set(p, m)
      ;(m.items ?? []).forEach((it, i) => {
        out.set(`${p}[${i}]`, it)
        if (m.marktype === 'group') walk(it.items ?? [], `${p}[${i}]`)
      })
    }
  }
  walk(rootItem.items ?? [], '')
  return out
}

/**
 * The marks and items of Aster's scene, by name. A group mark has no node of its own: its entry is a stand-in holding its group items
 * in order (`items`), which is what a group mark is to vega.
 */
export function asterPlaces(scene: { items: unknown[] }): { places: Map<string, AsterNode>; unknown: string[] } {
  const out = new Map<string, AsterNode>()
  const unknown: string[] = []
  const walk = (nodes: AsterNode[], path: string, counts: Map<string, number>): void => {
    for (const n of nodes) {
      if (n._bg === true) continue
      if (n.marktype === 'group' && n._scope !== true && n.contentClip === true) { walk(n.items ?? [], path, counts); continue }
      if (n.marktype === 'group' && n._scope === true) {
        const i = (counts.get(n.name!) ?? -1) + 1
        counts.set(n.name!, i)
        const p = `${path}/${n.name}`
        let mark = out.get(p)
        if (mark === undefined) out.set(p, (mark = { marktype: 'group', name: n.name, items: [] }))
        mark.items!.push(n)
        out.set(`${p}[${i}]`, n)
        walk(n.items ?? [], `${p}[${i}]`, new Map())
        continue
      }
      if (n.marktype !== undefined && Array.isArray(n.items)) {
        const p = `${path}/${n.name}`
        out.set(p, n)
        n.items.forEach((it, i) => out.set(`${p}[${i}]`, it as AsterNode))
        continue
      }
      unknown.push(`${path}: ${JSON.stringify(Object.keys(n))}`)
    }
  }
  walk(scene.items as AsterNode[], '', new Map())
  return { places: out, unknown }
}

/** The name of every object of a place map (its inverse): what an answer (a picked item, an intersected one) is called. */
export function nameOf(places: Map<string, object>): Map<object, string> {
  const out = new Map<object, string>()
  for (const [k, v] of places) out.set(v, k)
  return out
}

/**
 * Two numbers of a box are the same when they are the same value: the same number (NaN is NaN, -0 is 0), the same string -- vega's
 * arithmetic on a channel that is a string leaves strings in its boxes, and so does Aster's -- or null and 0, which every numeric
 * reading of a box (a comparison, a sum, a product) takes alike: vega's box holds a null where a point added had a null coordinate,
 * Aster's curves read it as the number 0.
 */
export function sameEdge(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  return (a === null && b === 0) || (a === 0 && b === null)
}

export function sameBox(a: { x1: unknown; y1: unknown; x2: unknown; y2: unknown }, b: { x1: unknown; y1: unknown; x2: unknown; y2: unknown }): boolean {
  return sameEdge(a.x1, b.x1) && sameEdge(a.y1, b.y1) && sameEdge(a.x2, b.x2) && sameEdge(a.y2, b.y2)
}

export function boxText(b: { x1: unknown; y1: unknown; x2: unknown; y2: unknown }): string {
  const t = (v: unknown): string => (typeof v === 'number' ? (Math.abs(v) >= 1.7e308 ? (v > 0 ? 'MAX' : '-MAX') : Object.is(v, -0) ? '-0' : String(v)) : JSON.stringify(v))
  return `[${t(b.x1)}, ${t(b.y1)}, ${t(b.x2)}, ${t(b.y2)}]`
}
