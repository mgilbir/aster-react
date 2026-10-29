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
import { ADDON_FUNCTIONS } from './addon-functions.js'
import { parseExpression } from './expr-parser.js'
import { parseEventSelectorString } from './event-selector.js'
import { registeredExpressionFunctionNames, withdrawExpressionFunctions } from './expression.js'
import type { VgSpec } from './types.js'

export type AddonName = 'transforms' | 'geo' | 'load'

/** Every transform the `@aster/core/transforms` add-on registers (and `requireTransform` asks it for). */
export const TRANSFORMS_ADDON_TYPES: readonly string[] = [
  'kde', 'density', 'quantile', 'regression', 'loess', 'pack', 'partition', 'treemap', 'wordcloud', 'voronoi',
  'pie', 'cross', 'countpattern', 'dotbin', 'geopoint', 'geojson', 'linkpath',
  'tree', 'treelinks', 'force', 'kde2d', 'isocontour', 'heatmap', 'geopath', 'crossfilter', 'resolvefilter', 'label',
]
/** The expression functions the add-ons register, with the add-on of each (see `addon-functions.ts`). */
export { ADDON_FUNCTIONS }
/** Every expression function currently registered beyond the built-ins (the add-ons', and the host's own): for tests of the tables. */
export const registeredFunctionNames = registeredExpressionFunctionNames
/** Take expression functions out of the registry and get a function that restores them (a test seam). */
export const withdrawFunctions = withdrawExpressionFunctions
/** The data formats the `@aster/core/load` add-on registers readers for. */
export const LOAD_ADDON_FORMATS: readonly string[] = ['csv', 'tsv', 'dsv', 'topojson']

const TRANSFORM_TYPES = new Set(TRANSFORMS_ADDON_TYPES)
const FORMAT_TYPES = new Set(LOAD_ADDON_FORMATS)

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object'

const NONE: readonly AddonName[] = Object.freeze([])

/** Keys whose string value is an expression in a Vega spec (signal `update` / `init`, `on` triggers and handlers, `test`, `expr`, a `{signal}` ref, an event `filter`). */
const EXPRESSION_KEYS = new Set([
  'signal', 'expr', 'update', 'init', 'test', 'trigger', 'insert', 'remove', 'toggle', 'modify', 'filter',
])
/** Keys whose value is data, never expressions: a dataset's rows, a signal's or a literal's value. */
const DATA_KEYS = new Set(['values', 'value'])

/** The add-on functions called by one expression string; an expression that does not parse calls nothing (the engine reports it). */
function addonFunctionsCalled(expr: string, found: Set<AddonName>): void {
  let ast: unknown
  try { ast = parseExpression(expr) } catch { return }
  const stack: unknown[] = [ast]
  while (stack.length) {
    const n = stack.pop()
    if (n === null || typeof n !== 'object') continue
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue }
    const node = n as { type?: string; callee?: { type?: string; name?: string } } & Json
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && typeof node.callee.name === 'string') {
      const name = node.callee.name.startsWith('_') ? node.callee.name.slice(1) : node.callee.name
      if (Object.hasOwn(ADDON_FUNCTIONS, name)) found.add(ADDON_FUNCTIONS[name]!)
    }
    for (const k of Object.keys(node)) if (k !== 'type') stack.push(node[k])
  }
}

/** The expressions in an event selector (`mousemove[event.x > 0]`): its filters. */
function selectorFilters(selector: string, found: Set<AddonName>): void {
  let streams: ReturnType<typeof parseEventSelectorString>
  try { streams = parseEventSelectorString(selector) } catch { return }
  const visit = (list: ReturnType<typeof parseEventSelectorString> | undefined): void => {
    for (const s of list ?? []) {
      for (const f of Array.isArray(s.filter) ? s.filter : s.filter ? [s.filter] : []) addonFunctionsCalled(f, found)
      visit(s.between); visit(s.merge); if (s.stream) visit([s.stream])
    }
  }
  visit(streams)
}

/**
 * The add-ons `spec` needs, read from its structure alone: a transform of the transforms add-on, a `contour` transform or
 * a projection (geo), a text data format (load), in `data` and in the `data` / `transform` of every mark at any depth of
 * nesting; and an expression function of an add-on (`geoCentroid`, `sampleNormal`, `treePath`...) called by any expression the spec
 * carries (a signal's `update` / `init` / `on`, a `formula` / `filter` `expr`, a `{signal}` reference, an event filter, a
 * rule's `test`), found by parsing each expression with the engine's own parser. A walk of the spec each time it is asked (a
 * host that renders again keeps the answer: the React hook memoizes it per spec), so a spec edited in place is read as it is now.
 */
export function addonsNeeded(spec: VgSpec): readonly AddonName[] {
  if (!isObj(spec)) return NONE
  const found = new Set<AddonName>()
  if (Array.isArray(spec.projections) && spec.projections.length > 0) found.add('geo')
  // one walk, with a stack (specs nest to any depth), bounded like the rest of the engine's spec walks, and safe on a cyclic object
  const seen = new WeakSet<object>()
  const stack: Array<[unknown, number, string]> = [[spec, 0, '']]
  while (stack.length) {
    const [node, depth, key] = stack.pop()!
    if (typeof node === 'string') {
      if (EXPRESSION_KEYS.has(key)) addonFunctionsCalled(node, found)
      else if (key === 'events') selectorFilters(node, found)
      continue
    }
    if (!isObj(node) || depth > HARD_MAX_SPEC_DEPTH || seen.has(node)) continue
    seen.add(node)
    // the projections of a group mark are built in its scope (the view's are checked above)
    if (key === 'projections' && Array.isArray(node) && node.length > 0) found.add('geo')
    if (Array.isArray(node)) {
      for (const x of node) stack.push([x, depth + 1, key])
      continue
    }
    if (key === 'transform' && typeof node.type === 'string') {
      if (node.type === 'contour') found.add('geo')
      else if (TRANSFORM_TYPES.has(node.type)) {
        found.add('transforms')
        // isocontour runs the geo add-on's contour engine; a geopath with no projection draws with its default path
        if (node.type === 'isocontour' || (node.type === 'geopath' && node.projection == null)) found.add('geo')
      }
    }
    if (key === 'format' && FORMAT_TYPES.has(node.type as string)) found.add('load')
    for (const k of Object.keys(node)) {
      if (DATA_KEYS.has(k) && !(k === 'values' && isObj(node[k]) && !Array.isArray(node[k]))) continue
      stack.push([node[k], depth + 1, k])
    }
  }
  const out: AddonName[] = []
  if (found.has('transforms')) out.push('transforms')
  if (found.has('geo')) out.push('geo')
  if (found.has('load')) out.push('load')
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
