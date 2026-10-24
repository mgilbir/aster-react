/**
 * Clip-path ids for the SVG serializers (string renderer and DOM descriptors).
 *
 * Ids are CONTENT-ADDRESSED: `clip<hash of the clip geometry>`. That makes them
 *   - deterministic per render (the same scene always yields the same ids, so SSR
 *     and hydration agree and a re-render does not churn `<defs>`), and
 *   - unique per chart in every way that matters: two charts on one page can only
 *     share an id when their clip geometry is identical, in which case the shared
 *     `<clipPath>` is the same shape and the reference resolves correctly.
 * A per-render counter (`clip1`, `clip2`, ...) restarted in every document, so
 * the first clipPath in document order silently won for every other chart (C45).
 *
 * Within one render a hash collision between two DIFFERENT geometries (2^-53 per
 * pair) is detected and resolved with a numeric suffix, never shared.
 */

/** A clip region: a path, or a rect in the clipped element's own frame. */
export type ClipDef = { d: string } | { x: number; y: number; w: number; h: number }

/** cyrb53: a fast 53-bit string hash (public domain), rendered base-36. */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export class ClipCollector {
  /** id -> definition, in first-use order. */
  readonly defs = new Map<string, ClipDef>()
  private readonly keys = new Map<string, string>()

  /** The id of `def`, registering it on first use. */
  id(def: ClipDef): string {
    const key = 'd' in def ? `p${def.d}` : `r${def.x},${def.y},${def.w},${def.h}`
    let id = `clip${hash53(key)}`
    for (let n = 1; ; n++) {
      const owner = this.keys.get(id)
      if (owner === undefined) {
        this.keys.set(id, key)
        this.defs.set(id, def)
        return id
      }
      if (owner === key) return id
      id = `clip${hash53(key)}_${n}`
    }
  }

  get size(): number {
    return this.defs.size
  }
}
