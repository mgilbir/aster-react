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

import type { SceneDef } from './types.js'

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


// --- gradient paints ------------------------------------------------------------------------------------------------

/** A paint that is a gradient object (vega-scenegraph `isGradient`): `{gradient: 'linear' | 'radial', stops, x1, ...}`. */
export interface GradientPaint { gradient: 'linear' | 'radial'; id?: string; stops: Array<{ offset: number; color: string }>; [k: string]: unknown }

export function isGradientPaint(v: unknown): v is GradientPaint {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ((v as { gradient?: unknown }).gradient === 'linear' || (v as { gradient?: unknown }).gradient === 'radial') && Array.isArray((v as { stops?: unknown }).stops)
}

/**
 * vega-scenegraph Gradient.js `gradientRef` as a pure function: the definition a gradient paint stands for. The id is the
 * object's own, else a hash of the definition (the same chart always writes the same ids); the coordinates default as
 * vega's do (linear 0,0 -> 1,0; radial centred, r 0 -> 0.5) unless the gradient names its own id, which is taken as written.
 */
export function gradientDefOf(g: GradientPaint): SceneDef {
  const radial = g.gradient === 'radial'
  const given = typeof g.id === 'string' && g.id !== ''
  const def: SceneDef = {
    id: '',
    colorStops: g.stops.map((st) => ({ offset: +st.offset, color: String(st.color) })),
    kind: radial ? 'radial' : 'linear',
  }
  const keys = radial ? (['x1', 'y1', 'r1', 'x2', 'y2', 'r2'] as const) : (['x1', 'y1', 'x2', 'y2'] as const)
  const defaults: Record<string, number> = radial ? { x1: 0.5, y1: 0.5, r1: 0, x2: 0.5, y2: 0.5, r2: 0.5 } : { x1: 0, y1: 0, x2: 1, y2: 0 }
  const rec = def as unknown as Record<string, number>
  for (const k of keys) {
    const v = g[k] != null ? +(g[k] as number) : given ? undefined : defaults[k]
    if (v !== undefined) rec[k] = v
  }
  def.id = given ? String(g.id) : 'gradient_' + hash53(JSON.stringify([def.kind, keys.map((k) => rec[k]), def.colorStops]))
  return def
}

/** The `url(#id)` a gradient paint is written as (a radial gradient is referenced through its pattern wrapper). */
export function gradientRef(g: GradientPaint): string {
  const def = gradientDefOf(g)
  return `url(#${def.kind === 'radial' ? 'p_' : ''}${def.id})`
}
