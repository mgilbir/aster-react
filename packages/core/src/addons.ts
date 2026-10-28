/**
 * Which opt-in add-ons a spec needs, and loading them on demand (`@aster/core/addons`).
 *
 * The Vega features that cost bundle size live in add-ons that a plain chart never imports: `@aster/core/transforms` (the
 * rare-layout transforms), `@aster/core/geo` (projections, `contour`) and `@aster/core/load` (the csv / tsv / dsv / topojson
 * readers). A host that knows what its specs need imports them statically; a host that renders specs it does not know
 * asks this module, which reads the spec (no evaluation, no regular expression) and imports exactly what it uses:
 *
 *   const missing = missingAddons(spec)            // [] for a plain chart: nothing to wait for
 *   if (missing.length) await loadAddons(missing)  // one dynamic import per add-on, each at most once
 *
 * An add-on the app already imported statically is recognised by what it registered (`isAddonLoaded`), so it is never
 * imported a second time; a bundler that sees both the static and the dynamic import puts the add-on in one module.
 * Nothing here is imported by `@aster/core`'s main entry: an app that does not use this module does not pay for it.
 */
import { dataFormatRegistry, geoRegistry, transformRegistry } from './registry.js'
import { HARD_MAX_SPEC_DEPTH } from './limits.js'
import type { VgSpec } from './types.js'

export type AddonName = 'transforms' | 'geo' | 'load'

/** Every transform the `@aster/core/transforms` add-on registers (and `requireTransform` asks it for). */
export const TRANSFORMS_ADDON_TYPES: readonly string[] = [
  'kde', 'density', 'quantile', 'regression', 'loess', 'pack', 'partition', 'treemap', 'wordcloud', 'voronoi',
  'pie', 'cross', 'countpattern', 'dotbin', 'geopoint', 'geojson', 'linkpath',
]
/** The data formats the `@aster/core/load` add-on registers readers for. */
export const LOAD_ADDON_FORMATS: readonly string[] = ['csv', 'tsv', 'dsv', 'topojson']

const TRANSFORM_TYPES = new Set(TRANSFORMS_ADDON_TYPES)
const FORMAT_TYPES = new Set(LOAD_ADDON_FORMATS)

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object'

const NONE: readonly AddonName[] = Object.freeze([])

/**
 * The add-ons `spec` needs, read from its structure alone: a transform of the transforms add-on, a `contour` transform or
 * a projection (geo), a text data format (load), in `data` and in the `data` / `transform` of every mark at any depth of
 * nesting. A walk of the spec each time it is asked (a host that renders again keeps the answer: the React hook memoizes it per
 * spec), so a spec edited in place is read as it is now.
 */
export function addonsNeeded(spec: VgSpec): readonly AddonName[] {
  if (!isObj(spec)) return NONE
  let transforms = false
  let geo = Array.isArray(spec.projections) && spec.projections.length > 0
  let load = false
  const scanData = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const d of list) {
      if (!isObj(d)) continue
      if (isObj(d.format) && FORMAT_TYPES.has(d.format.type as string)) load = true
      scanTransforms(d.transform)
    }
  }
  const scanTransforms = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const t of list) {
      const type = isObj(t) ? t.type : undefined
      if (type === 'contour') geo = true
      else if (TRANSFORM_TYPES.has(type as string)) transforms = true
    }
  }
  scanData(spec.data)
  // group marks nest to any depth; walk them with a stack, bounded like the rest of the engine's spec walks
  const stack: Array<[unknown, number]> = [[spec.marks, 0]]
  while (stack.length) {
    const [marks, depth] = stack.pop()!
    if (!Array.isArray(marks) || depth > HARD_MAX_SPEC_DEPTH) continue
    for (const m of marks) {
      if (!isObj(m)) continue
      scanData(m.data)
      scanTransforms(m.transform)
      stack.push([m.marks, depth + 1])
    }
  }
  const out: AddonName[] = []
  if (transforms) out.push('transforms')
  if (geo) out.push('geo')
  if (load) out.push('load')
  return out.length ? Object.freeze(out) : NONE
}

/** Whether an add-on's registrations are present, however they got there (a static import, an earlier `loadAddons`). */
export function isAddonLoaded(name: AddonName): boolean {
  switch (name) {
    case 'geo': return geoRegistry.buildProjection !== null
    case 'transforms': return TRANSFORMS_ADDON_TYPES.every((t) => transformRegistry.has(t))
    case 'load': return LOAD_ADDON_FORMATS.every((f) => dataFormatRegistry.has(f))
  }
}

/** The add-ons in `needed` that are not loaded yet; empty for a plain chart and for an app that imported them. */
export function notLoaded(needed: readonly AddonName[]): readonly AddonName[] {
  if (needed.length === 0) return needed
  const missing = needed.filter((a) => !isAddonLoaded(a))
  return missing.length === needed.length ? needed : missing
}

/** The add-ons `spec` needs that are not loaded yet. */
export function missingAddons(spec: VgSpec): readonly AddonName[] {
  return notLoaded(addonsNeeded(spec))
}

const importers: Record<AddonName, () => Promise<unknown>> = {
  transforms: () => import('./addon-transforms.js'),
  geo: () => import('./addon-geo.js'),
  load: () => import('./addon-load.js'),
}
const loading = new Map<AddonName, Promise<void>>()

function loadAddon(name: AddonName): Promise<void> {
  if (isAddonLoaded(name)) return Promise.resolve()
  let p = loading.get(name)
  if (!p) {
    p = importers[name]().then(
      () => undefined,
      (cause: unknown) => {
        loading.delete(name) // a failed import is not remembered: the next call tries again
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`[aster] could not load the "${name}" add-on (@aster/core/${name}): ${reason}`, { cause })
      },
    )
    loading.set(name, p)
  }
  return p
}

/** Import the named add-ons (concurrently, each at most once). Rejects, naming the add-on, when an import fails. */
export function loadAddons(names: readonly AddonName[]): Promise<void> {
  return names.length === 1 ? loadAddon(names[0]!) : Promise.all(names.map(loadAddon)).then(() => undefined)
}

/** Import whatever `spec` needs and does not have yet. Resolves at once for a plain chart. */
export function loadAddonsFor(spec: VgSpec): Promise<void> {
  const missing = missingAddons(spec)
  return missing.length ? loadAddons(missing) : Promise.resolve()
}
