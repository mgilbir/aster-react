/**
 * Which opt-in add-ons a spec needs, and loading them on demand (`@aster-charts/core/addons`).
 *
 * The Vega features that cost bundle size live in add-ons that a plain chart never imports: `@aster-charts/core/transforms` (the
 * rare-layout transforms), `@aster-charts/core/geo` (projections, `contour`) and `@aster-charts/core/load` (the csv / tsv / dsv / topojson
 * readers). A host that knows what its specs need imports them statically; a host that renders specs it does not know
 * asks this module, which reads the spec (no evaluation, no regular expression) and imports exactly what it uses:
 *
 *   const missing = missingAddons(spec)            // [] for a plain chart: nothing to wait for
 *   if (missing.length) await loadAddons(missing)  // one dynamic import per add-on, each at most once
 *
 * An add-on the app already imported statically is recognised by what it registered (`isAddonLoaded`), so it is never
 * imported a second time; a bundler that sees both the static and the dynamic import puts the add-on in one module.
 * Nothing here is imported by `@aster-charts/core`'s main entry: an app that does not use this module does not pay for it.
 *
 * The same walk names the parts of the engine a spec may read (`specNeeds`, `partsNeeded`; see engine-parts.ts), which the public
 * entries carry and the React shells, on `@aster-charts/core/lean`, load on demand (`loadParts`).
 */
import { dataFormatRegistry, geoRegistry, transformRegistry } from './registry.js'
import { HARD_MAX_SPEC_DEPTH } from './limits.js'
import { ADDON_FUNCTIONS } from './addon-functions.js'
import { parseExpression } from './expr-parser.js'
import { parseEventSelectorString } from './event-selector.js'
import { registeredExpressionFunctionNames, withdrawExpressionFunctions } from './expression.js'
import { checkUrlData, validateUrlDataMode, type UrlDataMode } from './url-data.js'
import { dataWithoutRows, valuesSignal } from './spec-structure.js'
import { mayDrawRandom } from './random-tape.js'
import { ENGINE_PARTS, installPart, partLoaded, type EnginePart } from './engine-parts.js'
import type { VgSpec } from './types.js'

export type AddonName = 'transforms' | 'geo' | 'load'

/** What the host allows besides the spec itself: `urlData` as in `RuntimeInput`. */
export interface AddonOptions {
  /**
   * `'refuse'`: url datasets will be refused, so the readers their `format` names are not needed
   * ({@link addonsNeeded}), and {@link loadAddonsFor} rejects a spec that has one before importing anything.
   */
  urlData?: UrlDataMode
}

/** Every transform the `@aster-charts/core/transforms` add-on registers (and `requireTransform` asks it for). */
export const TRANSFORMS_ADDON_TYPES: readonly string[] = [
  'kde', 'density', 'quantile', 'regression', 'loess', 'pack', 'partition', 'treemap', 'wordcloud', 'voronoi',
  'pie', 'cross', 'countpattern', 'dotbin', 'geopoint', 'geojson', 'linkpath',
  'nest', 'tree', 'treelinks', 'force', 'kde2d', 'isocontour', 'heatmap', 'geopath', 'crossfilter', 'resolvefilter', 'label',
]
/** The expression functions the add-ons register, with the add-on of each (see `addon-functions.ts`). */
export { ADDON_FUNCTIONS }
/** Every expression function currently registered beyond the built-ins (the add-ons', and the host's own): for tests of the tables. */
export const registeredFunctionNames = registeredExpressionFunctionNames
/** Take expression functions out of the registry and get a function that restores them (a test seam). */
export const withdrawFunctions = withdrawExpressionFunctions
/** The data formats the `@aster-charts/core/load` add-on registers readers for. */
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

/**
 * The expression functions that need a part of the engine (engine-parts.ts) the React shells load on demand, whatever their
 * arguments: `test` and `regexp` make a regular expression of their pattern, which the screen reads under limits (limits.ts).
 * `engine-parts.test.ts` checks this table and the next one against the whole function table.
 */
export const PART_FUNCTIONS: Readonly<Record<string, EnginePart>> = Object.freeze({
  vlSelectionTest: 'selections', vlSelectionIdTest: 'selections', vlSelectionResolve: 'selections', vlSelectionTuples: 'selections',
  intersect: 'intersect',
  modify: 'modify', setdata: 'modify',
  test: 'regex', regexp: 'regex',
})
/**
 * The string functions that screen an argument that is a regular expression (limits.ts): one only a regular expression literal,
 * `regexp()` or a value from outside the spec (a row, a signal) can be. A call whose arguments after the first are all literals that
 * are not regular expressions (`replace(s, '-', '')`) hands the screen nothing. (The sequence functions, `join`, `indexof` and the
 * like, take a regular expression as any other value: they never screen one.)
 */
export const REGEX_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set(['replace', 'split'])
/** The transforms whose parameters are regular expressions (the transforms add-on's `countpattern`; `wordcloud` counts with one too). */
const REGEX_TRANSFORMS = new Set(['countpattern', 'wordcloud'])
/** The symbol shapes that are drawn without reading a path (geometry.ts `symbolData`); any other name is an SVG path. */
const BUILTIN_SHAPES = new Set(['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-right', 'triangle-left', 'stroke', 'arrow', 'wedge', 'triangle'])

/** What a walk of a spec found: the add-ons it needs, the parts of the engine it may need. */
interface Found {
  addons: Set<AddonName>
  parts: Set<EnginePart>
  /** a scope declares signals */
  eventLoop: boolean
}

/** The add-ons and parts called by one expression string; an expression that does not parse calls nothing (the engine reports it). */
function functionsCalled(expr: string, found: Found): void {
  let ast: unknown
  try { ast = parseExpression(expr) } catch { return }
  const stack: unknown[] = [ast]
  while (stack.length) {
    const n = stack.pop()
    if (n === null || typeof n !== 'object') continue
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue }
    // (a regular expression literal is screened where it is used: limits.ts)
    if (n instanceof RegExp) { found.parts.add('regex'); continue }
    const node = n as { type?: string; callee?: { type?: string; name?: string } } & Json
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && typeof node.callee.name === 'string') {
      const name = node.callee.name.startsWith('_') ? node.callee.name.slice(1) : node.callee.name
      if (Object.hasOwn(ADDON_FUNCTIONS, name)) found.addons.add(ADDON_FUNCTIONS[name]!)
      if (Object.hasOwn(PART_FUNCTIONS, name)) found.parts.add(PART_FUNCTIONS[name]!)
      else if (REGEX_ARGUMENT_FUNCTIONS.has(name) && mayBeRegex((node.arguments as unknown[] | undefined)?.slice(1))) found.parts.add('regex')
    }
    for (const k of Object.keys(node)) if (k !== 'type') stack.push(node[k])
  }
}

/** Whether any of these argument expressions may be a regular expression: anything but a literal that is not one. */
function mayBeRegex(args: unknown[] | undefined): boolean {
  return (args ?? []).some((a) => !isObj(a) || a.type !== 'Literal' || a.value instanceof RegExp)
}

/** The expressions in an event selector (`mousemove[event.x > 0]`): its filters. */
function selectorFilters(selector: string, found: Found): void {
  let streams: ReturnType<typeof parseEventSelectorString>
  try { streams = parseEventSelectorString(selector) } catch { return }
  const visit = (list: ReturnType<typeof parseEventSelectorString> | undefined): void => {
    for (const s of list ?? []) {
      for (const f of Array.isArray(s.filter) ? s.filter : s.filter ? [s.filter] : []) functionsCalled(f, found)
      visit(s.between); visit(s.merge); if (s.stream) visit([s.stream])
    }
  }
  visit(streams)
}

/** Whether a `shape` / `symbolType` value can name anything but a built-in symbol: a field, a signal, a scale, a rule, a custom path. */
function customShape(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return !BUILTIN_SHAPES.has(v)
  if (isObj(v) && !Array.isArray(v) && Object.keys(v).every((k) => k === 'value')) return v.value != null && (typeof v.value !== 'string' || !BUILTIN_SHAPES.has(v.value))
  return true
}

/**
 * One walk of `spec`, with a stack (specs nest to any depth), bounded like the rest of the engine's spec walks, and safe on a cyclic
 * object: what `addonsNeeded` and `partsNeeded` report.
 */
function walkSpec(spec: Json, refuseUrls: boolean): Found {
  const found: Found = { addons: new Set(), parts: new Set(), eventLoop: false }
  // (a scope's lists are read as the compiler reads them, vega-util `array()`: a single object is a one-element list)
  if (spec.projections != null && (!Array.isArray(spec.projections) || spec.projections.length > 0)) found.addons.add('geo')
  if (spec.layout != null) found.parts.add('layout')
  const seen = new WeakSet<object>()
  const stack: Array<[unknown, number, string]> = [[spec, 0, '']]
  while (stack.length) {
    const [node, depth, key] = stack.pop()!
    if (typeof node === 'string') {
      if (EXPRESSION_KEYS.has(key)) functionsCalled(node, found)
      else if (key === 'events') {
        selectorFilters(node, found)
        if (node.includes('timer')) found.parts.add('timer')
      }
      continue
    }
    if (!isObj(node) || depth > HARD_MAX_SPEC_DEPTH || seen.has(node)) continue
    seen.add(node)
    // the projections of a group mark are built in its scope (the view's are checked above)
    if (key === 'projections' && (!Array.isArray(node) || node.length > 0)) found.addons.add('geo')
    if (key === 'legends' && (!Array.isArray(node) || node.length > 0)) found.parts.add('legend')
    // (a scope that declares signals: the view's, a group mark's)
    if (key === 'signals' && (!Array.isArray(node) || node.length > 0)) found.eventLoop = true
    // (an object-form event stream: `{type: 'timer', ...}`, or one that merges or windows another)
    if (key === 'events' && JSON.stringify(node).includes('timer')) found.parts.add('timer')
    if (Array.isArray(node)) {
      for (const x of node) stack.push([x, depth + 1, key])
      continue
    }
    if (key === 'marks') {
      if (node.type === 'group' && node.layout != null) found.parts.add('layout')
      // (a path mark's path string is read for its bounds and its outline)
      if (node.type === 'path') found.parts.add('svgpath')
    }
    if ((Object.hasOwn(node, 'shape') && customShape(node.shape)) || (Object.hasOwn(node, 'symbolType') && customShape(node.symbolType))) found.parts.add('svgpath')
    if (key === 'transform' && typeof node.type === 'string') {
      if (node.type === 'contour') found.addons.add('geo')
      else if (TRANSFORM_TYPES.has(node.type)) {
        found.addons.add('transforms')
        // isocontour runs the geo add-on's contour engine; a geopath with no projection draws with its default path
        if (node.type === 'isocontour' || (node.type === 'geopath' && node.projection == null)) found.addons.add('geo')
      }
      if (REGEX_TRANSFORMS.has(node.type)) found.parts.add('regex')
    }
    if (key === 'format' && FORMAT_TYPES.has(node.type as string)) found.addons.add('load')
    // (a dataset definition is an element of a `data` array; a refused url dataset is never read)
    const refusedUrl = refuseUrls && key === 'data' && !!node.url && !node.values
    for (const k of Object.keys(node)) {
      // (`values` is read only when it is a `{signal}`: rows and GeoJSON are data, whatever their fields are named)
      if (k === 'values') {
        const signal = valuesSignal(node[k])
        if (signal !== undefined) stack.push([signal, depth + 1, 'signal'])
        continue
      }
      if (DATA_KEYS.has(k)) continue
      if (refusedUrl && k === 'format') continue
      stack.push([node[k], depth + 1, k])
    }
  }
  return found
}

/**
 * The add-ons `spec` needs, read from its structure alone: a transform of the transforms add-on, a `contour` transform or
 * a projection (geo), a text data format (load), in `data` and in the `data` / `transform` of every mark at any depth of
 * nesting; and an expression function of an add-on (`geoCentroid`, `sampleNormal`, `treePath`...) called by any expression the spec
 * carries (a signal's `update` / `init` / `on`, a `formula` / `filter` `expr`, a `{signal}` reference, an event filter, a
 * rule's `test`), found by parsing each expression with the engine's own parser. A walk of the spec each time it is asked (a
 * host that renders again keeps the answer: the React hook memoizes it per spec), so a spec edited in place is read as it is now.
 * With `urlData: 'refuse'` the `format` of a url dataset (one with a non-empty `url` and no `values`) is not counted: that dataset is
 * refused, never read, so it needs no reader.
 */
export function addonsNeeded(spec: VgSpec, options?: AddonOptions): readonly AddonName[] {
  return specNeeds(spec, options).addons
}

/** What a spec needs: the add-ons (`addonsNeeded`) and the parts of the engine (`partsNeeded`), from one walk. */
export interface SpecNeeds {
  addons: readonly AddonName[]
  parts: readonly EnginePart[]
  /**
   * Whether an interactive host binds the signal event loop for it (the `signals` part, which no evaluation reads): the view or a
   * group mark declares signals (`on` streams, a selection's, or values a host may set). A host that listens to signals binds it
   * whatever the spec says.
   */
  eventLoop: boolean
}

/** What the host gives an evaluation besides the spec that decides which parts it may need. */
export interface PartOptions extends AddonOptions {
  /** Whether the evaluation runs under `limits`: the regular-expression screen runs only then. */
  limits?: boolean
  /** Whether the host injects a random source (`RuntimeInput.random`). */
  random?: boolean
}

const NO_PARTS: readonly EnginePart[] = Object.freeze([])
const NO_NEEDS: SpecNeeds = Object.freeze({ addons: NONE, parts: NO_PARTS, eventLoop: false })

/** The add-ons and the parts of the engine `spec` needs, from one walk of it (see `addonsNeeded` and `partsNeeded`). */
export function specNeeds(spec: VgSpec, options?: PartOptions): SpecNeeds {
  if (!isObj(spec)) return NO_NEEDS
  validateUrlDataMode(options?.urlData)
  const found = walkSpec(spec, options?.urlData === 'refuse')
  const addons: AddonName[] = []
  if (found.addons.has('transforms')) addons.push('transforms')
  if (found.addons.has('geo')) addons.push('geo')
  if (found.addons.has('load')) addons.push('load')
  const parts = found.parts
  // the regular-expression screen runs only under limits; without them no pattern is screened
  if (!options?.limits) parts.delete('regex')
  // a legend draws its gradient and its symbols from path data
  if (parts.has('legend')) parts.add('svgpath')
  // With an injected random source, which build of a dataset takes a pulse decides which numbers it draws (the pulse path draws
  // without a tape: runtime.ts `datasetsMayDraw`), so a chart whose datasets may draw has the pulse path from its first evaluation.
  if (options?.random && mayDrawRandom(collectData(spec))) parts.add('pulse')
  const partList = ENGINE_PARTS.filter((p) => parts.has(p))
  return addons.length === 0 && partList.length === 0 && !found.eventLoop
    ? NO_NEEDS
    : { addons: addons.length ? Object.freeze(addons) : NONE, parts: partList.length ? Object.freeze(partList) : NO_PARTS, eventLoop: found.eventLoop }
}

/** Every dataset definition of a spec, at any depth of nesting, without its rows (what may draw from a random source). */
function collectData(spec: Json): unknown[] {
  const out: unknown[] = []
  const seen = new WeakSet<object>()
  const stack: Array<[unknown, number]> = [[spec, 0]]
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (!isObj(node) || depth > HARD_MAX_SPEC_DEPTH || seen.has(node) || Array.isArray(node)) continue
    seen.add(node)
    for (const d of Array.isArray(node.data) ? node.data : node.data != null ? [node.data] : []) if (isObj(d)) out.push(dataWithoutRows(d))
    for (const m of Array.isArray(node.marks) ? node.marks : node.marks != null ? [node.marks] : []) stack.push([m, depth + 1])
  }
  return out
}

/**
 * The parts of the engine (engine-parts.ts) `spec` may need, read from its structure alone, as `addonsNeeded` reads it: a legend
 * (`legends` in any scope), a grid layout (`layout` on the view or a group mark), a path mark or a symbol shape that may be a custom
 * path (svgpath), an expression that calls vega-selections' functions, `intersect()`, `modify()` / `setdata()`, a `timer` event stream;
 * under `limits` anything that can hand a regular expression to the screen (regex); with a random source, datasets that may draw from
 * it (pulse). The pulse path is otherwise loaded when a chart's data first changes. Every public entry of `@aster-charts/core` carries
 * the parts its functions can use: this is for the React shells, which use `@aster-charts/core/lean`.
 */
export function partsNeeded(spec: VgSpec, options?: PartOptions): readonly EnginePart[] {
  return specNeeds(spec, options).parts
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
export function missingAddons(spec: VgSpec, options?: AddonOptions): readonly AddonName[] {
  return notLoaded(addonsNeeded(spec, options))
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
        throw new Error(`[aster] could not load the "${name}" add-on (@aster-charts/core/${name}): ${reason}`, { cause })
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

/**
 * Import whatever `spec` needs and does not have yet. Resolves at once for a plain chart. With `urlData: 'refuse'` a spec that
 * has a url dataset rejects with the `AsterUrlError` evaluation would throw, before anything is imported.
 */
export function loadAddonsFor(spec: VgSpec, options?: AddonOptions): Promise<void> {
  let missing: readonly AddonName[]
  try {
    checkUrlData(spec, options?.urlData)
    missing = missingAddons(spec, options)
  } catch (e) {
    return Promise.reject(e)
  }
  return missing.length ? loadAddons(missing) : Promise.resolve()
}

/** The parts in `needed` that are not loaded yet; empty for a chart that needs none and for an entry that carries them. */
export function partsNotLoaded(needed: readonly EnginePart[]): readonly EnginePart[] {
  if (needed.length === 0) return needed
  const missing = needed.filter((p) => !partLoaded(p))
  return missing.length === needed.length ? needed : missing
}

type PartModule = { part: unknown }
/**
 * (the canvas part is loaded by `<Chart>`'s canvas capability, through `@aster-charts/core/lean/canvas`, and the signal loop by the
 * interaction capability, through `@aster-charts/core/lean/signals`: no evaluation reads either)
 */
const partImporters: Record<Exclude<EnginePart, 'canvas' | 'signals'>, () => Promise<PartModule>> = {
  legend: () => import('./part-legend.js'),
  layout: () => import('./part-layout.js'),
  pulse: () => import('./part-pulse.js'),
  selections: () => import('./part-selections.js'),
  regex: () => import('./part-regex.js'),
  svgpath: () => import('./part-svgpath.js'),
  intersect: () => import('./part-intersect.js'),
  modify: () => import('./part-modify.js'),
  timer: () => import('./part-timer.js'),
}
const partsLoading = new Map<EnginePart, Promise<void>>()

function loadPart(name: EnginePart): Promise<void> {
  if (partLoaded(name)) return Promise.resolve()
  if (name === 'canvas') return Promise.reject(new Error('[aster] the canvas part is loaded by the canvas capability (@aster-charts/core/lean/canvas)'))
  if (name === 'signals') return Promise.reject(new Error('[aster] the signals part is loaded by the interaction capability (@aster-charts/core/lean/signals)'))
  let p = partsLoading.get(name)
  if (!p) {
    p = partImporters[name]().then(
      // (a part module fills its slot when it runs; filled from its export as well, for a slot emptied since: a test seam)
      (mod) => {
        partsLoading.delete(name)
        if (!partLoaded(name)) installPart(name, mod.part as never)
      },
      (cause: unknown) => {
        partsLoading.delete(name) // a failed import is not remembered: the next call tries again
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`[aster] could not load the "${name}" part of the engine: ${reason}`, { cause })
      },
    )
    partsLoading.set(name, p)
  }
  return p
}

/** Import the named parts of the engine (concurrently, each at most once). Rejects, naming the part, when an import fails. */
export function loadParts(names: readonly EnginePart[]): Promise<void> {
  return names.length === 1 ? loadPart(names[0]!) : Promise.all(names.map(loadPart)).then(() => undefined)
}

/**
 * Import whatever `spec` needs and does not have yet, add-ons and parts of the engine alike: `loadAddonsFor` for a host of
 * `@aster-charts/core/lean` (the React shells). Resolves at once when nothing is missing.
 */
export function loadPartsFor(spec: VgSpec, options?: PartOptions): Promise<void> {
  let needs: SpecNeeds
  try {
    checkUrlData(spec, options?.urlData)
    needs = specNeeds(spec, options)
  } catch (e) {
    return Promise.reject(e)
  }
  const addons = notLoaded(needs.addons)
  const parts = partsNotLoaded(needs.parts)
  if (addons.length === 0 && parts.length === 0) return Promise.resolve()
  return Promise.all([loadAddons(addons), loadParts(parts)]).then(() => undefined)
}
