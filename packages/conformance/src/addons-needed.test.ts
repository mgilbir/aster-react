/**
 * `addonsNeeded(spec)` (the add-on auto-load's detector) is exact: it names the add-ons the ENGINE asks for, no more and no less.
 *
 * The ground truth is the engine itself. Every corpus spec (the 993 Vega and Vega-Lite files; Vega-Lite through the pinned
 * vega-lite compiler, so the specs are what the oracle makes) is rendered with all three add-ons registered, then again as an
 * app that loads nothing up front would: with none registered, each "load the addon first" failure names the add-on to load, which
 * is then registered and the render repeated until it succeeds. The add-ons loaded that way are the ones the spec needs.
 * `addonsNeeded` must name exactly that set (so there is no add-on loaded for nothing, and none missing), and a render with
 * exactly the add-ons it names must equal the render with all of them.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import {
  addonsNeeded, isAddonLoaded, missingAddons, ADDON_FUNCTIONS, registeredFunctionNames, withdrawFunctions, LOAD_ADDON_FORMATS, TRANSFORMS_ADDON_TYPES, type AddonName,
} from '@aster/core/addons'
import { dataFormatRegistry, geoRegistry, renderSpec, transformRegistry, type TransformFn, type VgSpec } from '@aster/core'

const ADDONS: readonly AddonName[] = ['transforms', 'geo', 'load']
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')

// ---- registering / unregistering an add-on, as if its module had not been imported ----
type Reader = typeof dataFormatRegistry extends Map<string, infer R> ? R : never
// (a snapshot of what the add-on modules registered when they were imported above - not of the detector's own tables, which are
// under test: a table that forgot a transform must not also forget to unregister it)
const saved = {
  transforms: new Map<string, TransformFn>(transformRegistry),
  geo: { ...geoRegistry },
  load: new Map<string, Reader>([...dataFormatRegistry].filter(([f]) => f !== 'json')),
}
// an add-on's expression functions are part of what it registers: withdrawn with it, put back with it
// (read from the add-ons' sources, not from the detector's table that is under test: a table that forgot a function must not also forget to withdraw it)
const CORE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'src')
const sourceOf = (f: string): string => readFileSync(join(CORE_SRC, f), 'utf8')
const registeredIn = (f: string): string[] => [...sourceOf(f).matchAll(/register(?:Runtime)?ExpressionFunction\('(\w+)'/g)].map((m) => m[1]!)
const REGISTERED_BY: Record<'transforms' | 'geo', string[]> = {
  geo: registeredIn('addon-geo.ts'),
  // stats-functions.ts registers the entries of its FUNCTIONS object in a loop
  transforms: [...registeredIn('transform-extra.ts'), ...(/const FUNCTIONS = \{([^}]*)\}/.exec(sourceOf('stats-functions.ts'))![1]!.match(/\w+/g) ?? [])],
}
const functionsOf = (name: 'transforms' | 'geo'): string[] => REGISTERED_BY[name]
const withdrawn = new Map<AddonName, () => void>()
function setFunctions(name: AddonName, on: boolean): void {
  if (name === 'load') return
  const restore = withdrawn.get(name)
  if (on && restore) { restore(); withdrawn.delete(name) }
  else if (!on && !restore) withdrawn.set(name, withdrawFunctions(functionsOf(name)))
}
function setLoaded(name: AddonName, on: boolean): void {
  setFunctions(name, on)
  if (name === 'transforms') for (const [t, fn] of saved.transforms) { if (on) transformRegistry.set(t, fn); else transformRegistry.delete(t) }
  else if (name === 'load') for (const [f, r] of saved.load) { if (on) dataFormatRegistry.set(f, r); else dataFormatRegistry.delete(f) }
  else Object.assign(geoRegistry, on ? saved.geo : Object.fromEntries(Object.keys(saved.geo).map((k) => [k, null])))
}
const setOnly = (loaded: ReadonlySet<AddonName>): void => { for (const a of ADDONS) setLoaded(a, loaded.has(a)) }

const MISSING = /load the addon first: await import\("@aster\/core\/(transforms|geo|load)"\)/

/** The add-ons the engine asks for, discovered the way a loading app would: one "load the addon" failure at a time. */
function discovered(spec: VgSpec): { needed: Set<AddonName>; svg: string } | { error: string } {
  const loaded = new Set<AddonName>()
  for (;;) {
    setOnly(loaded)
    try {
      return { needed: loaded, svg: renderSpec(spec) }
    } catch (e) {
      const m = MISSING.exec(e instanceof Error ? e.message : String(e))
      if (!m || loaded.has(m[1] as AddonName)) return { error: e instanceof Error ? e.message : String(e) }
      loaded.add(m[1] as AddonName)
    }
  }
}

describe('addonsNeeded is exactly what the engine asks for, over the whole corpus', async () => {
  const specs: Array<{ name: string; spec: VgSpec }> = []
  setOnly(new Set(ADDONS))
  for (const f of readdirSync(CORPUS).sort()) {
    const kind = f.endsWith('.vl.json') ? 'vl' : f.endsWith('.vg.json') ? 'vg' : null
    if (!kind) continue
    const doc = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as VgSpec
    let spec = (doc.$schema ? doc : (doc.spec ?? doc)) as VgSpec
    if (kind === 'vl') spec = vl.compile(spec as never).spec as unknown as VgSpec
    try { specs.push({ name: f, spec: await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS) as VgSpec }) } catch { /* a spec whose data cannot load is not a rendering case */ }
  }

  it('covers the corpus', () => { expect(specs.length).toBeGreaterThan(900) })

  it('names the add-ons the render needs: no more, no less; and renders with just those as with all', () => {
    const wrong: string[] = []
    const counts: Record<AddonName, number> = { transforms: 0, geo: 0, load: 0 }
    let compared = 0
    for (const { name, spec } of specs) {
      setOnly(new Set(ADDONS))
      let all: string
      try { all = renderSpec(spec) } catch { continue } // a spec that does not render at all says nothing about add-ons
      const found = discovered(spec)
      if ('error' in found) { wrong.push(`${name}: renders with every add-on but not by loading them one at a time: ${found.error.slice(0, 120)}`); continue }
      compared++
      const named = new Set(addonsNeeded(spec))
      for (const a of found.needed) counts[a]++
      if ([...found.needed].sort().join() !== [...named].sort().join()) wrong.push(`${name}: the engine asked for [${[...found.needed].sort()}], addonsNeeded says [${[...named].sort()}]`)
      if (found.svg !== all) wrong.push(`${name}: rendering with just [${[...found.needed]}] differs from rendering with all`)
    }
    setOnly(new Set(ADDONS))
    expect(wrong.slice(0, 10).join('\n'), `${wrong.length} wrong`).toBe('')
    expect(compared).toBeGreaterThan(900)
    // the comparison is not vacuous: every add-on is demanded by some corpus spec, and most specs need none
    expect(counts.transforms).toBeGreaterThan(5)
    expect(counts.geo).toBeGreaterThan(5)
    expect(counts.load).toBeGreaterThan(0)
  }, 600_000)

  it('missingAddons is what is needed and not registered', () => {
    const treemap = specs.find((s) => s.name === 'treemap.vg.json')!.spec
    setOnly(new Set(ADDONS))
    expect(missingAddons(treemap)).toEqual([])
    setLoaded('transforms', false)
    expect(isAddonLoaded('transforms')).toBe(false)
    expect(missingAddons(treemap)).toEqual(['transforms'])
    setOnly(new Set(ADDONS))
  })
})

describe('the detector\'s tables are the add-ons\' registrations', () => {
  it('TRANSFORMS_ADDON_TYPES is what @aster/core/transforms registers, and what the engine asks it for', () => {
    setOnly(new Set(ADDONS))
    expect([...transformRegistry.keys()].sort()).toEqual([...TRANSFORMS_ADDON_TYPES].sort())
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'src', 'transform.ts'), 'utf8')
    const asked = new Set([...source.matchAll(/requireTransform\('([a-z]+)'\)/g)].map((m) => m[1]!))
    expect(asked.size).toBeGreaterThan(10)
    expect([...asked].filter((t) => !TRANSFORMS_ADDON_TYPES.includes(t))).toEqual([])
  })
  it('ADDON_FUNCTIONS is the expression functions the add-ons register, each under the add-on that registers it', () => {
    setOnly(new Set(ADDONS))
    expect(registeredFunctionNames().sort()).toEqual(Object.keys(ADDON_FUNCTIONS).sort())
    expect(registeredFunctionNames().sort()).toEqual([...REGISTERED_BY.geo, ...REGISTERED_BY.transforms].sort())
    for (const addon of ['geo', 'transforms'] as const) {
      expect(REGISTERED_BY[addon].length).toBeGreaterThan(1)
      for (const f of REGISTERED_BY[addon]) expect(ADDON_FUNCTIONS[f], f).toBe(addon)
    }
    const call = (name: string) => ({ marks: [{ type: 'text', encode: { update: { text: { signal: `${name}(0)` } } } }] }) as VgSpec
    for (const [name, addon] of Object.entries(ADDON_FUNCTIONS)) {
      expect([...addonsNeeded(call(name))], name).toEqual([addon])
      // without the add-on the engine names it (rather than "Unrecognized function")
      const other = ADDONS.filter((a) => a !== addon)
      setOnly(new Set(other))
      expect(() => renderSpec(call(name)), name).toThrow(new RegExp(`load the addon first: await import\\("@aster/core/${addon}"\\)`))
      setOnly(new Set(ADDONS))
    }
  })
  it('LOAD_ADDON_FORMATS is what @aster/core/load registers beyond the built-in json', () => {
    setOnly(new Set(ADDONS))
    expect([...dataFormatRegistry.keys()].filter((f) => f !== 'json').sort()).toEqual([...LOAD_ADDON_FORMATS].sort())
  })
})

describe('addonsNeeded reads the structure, not the text', () => {
  const only = (spec: VgSpec): string => [...addonsNeeded(spec)].join()
  it('finds a transform in a nested group mark, in a mark-level transform, and a text format in a nested dataset', () => {
    expect(only({ marks: [{ type: 'group', marks: [{ type: 'group', data: [{ name: 'd', transform: [{ type: 'regression', x: 'a', y: 'b' }] }] }] }] })).toBe('transforms')
    expect(only({ marks: [{ type: 'text', transform: [{ type: 'wordcloud' }] }] })).toBe('transforms')
    expect(only({ marks: [{ type: 'group', data: [{ name: 'd', values: 'a\n1', format: { type: 'csv' } }] }] })).toBe('load')
    expect(only({ data: [{ name: 'd', transform: [{ type: 'contour', size: [1, 1] }] }] })).toBe('geo')
    expect(only({ projections: [{ name: 'p', type: 'mercator' }] })).toBe('geo')
  })
  it('finds an add-on function in every kind of expression a spec carries, and only there', () => {
    const fn = 'geoArea(null, datum)'
    const sig = (extra: Record<string, unknown>): VgSpec => ({ signals: [{ name: 's', ...extra }] })
    expect(only(sig({ update: fn }))).toBe('geo')
    expect(only(sig({ init: fn }))).toBe('geo')
    expect(only(sig({ on: [{ events: 'click', update: fn }] }))).toBe('geo')
    expect(only(sig({ on: [{ events: { type: 'click', filter: fn }, update: '1' }] }))).toBe('geo')
    expect(only(sig({ on: [{ events: `click[${fn} > 0]`, update: '1' }] }))).toBe('geo')
    expect(only({ data: [{ name: 'd', transform: [{ type: 'formula', expr: fn, as: 'a' }] }] })).toBe('geo')
    expect(only({ data: [{ name: 'd', transform: [{ type: 'filter', expr: fn }] }] })).toBe('geo')
    expect(only({ data: [{ name: 'd', transform: [{ type: 'extent', field: 'x', signal: 'e' }, { type: 'bin', field: 'x', extent: { signal: fn } }] }] })).toBe('geo')
    expect(only({ marks: [{ type: 'group', marks: [{ type: 'rect', encode: { update: { x: { signal: fn }, fill: [{ test: fn, value: 'red' }, { value: 'blue' }] } } }] }] })).toBe('geo')
    expect(only({ scales: [{ name: 'x', type: 'linear', domain: { signal: 'sampleNormal(0, 1)' }, range: [0, 1] }] })).toBe('transforms')
    expect(only({ signals: [{ name: 's', update: 'sampleNormal() + geoArea(null, 1)' }] })).toBe('transforms,geo')
    // a call that does not parse is the engine's to report; a name that is not called, or is data, is nothing
    expect(only(sig({ update: 'geoArea(' }))).toBe('')
    expect(only(sig({ update: 'geoArea' }))).toBe('')
    expect(only(sig({ update: "'geoArea(1)'" }))).toBe('')
    expect(only(sig({ value: 'geoArea(1)' }))).toBe('')
    expect(only({ data: [{ name: 'd', values: [{ update: 'geoArea(1)', expr: 'geoArea(1)' }] }] })).toBe('')
    expect(only({ marks: [{ type: 'text', encode: { update: { text: { value: 'geoArea(1)' } } } }] })).toBe('')
  })
  it('does not take the word for the thing: a field, a signal or a string that says "pie" needs nothing', () => {
    expect(only({ data: [{ name: 'pie', values: [{ type: 'pie', format: { type: 'csv' } }], transform: [{ type: 'filter', expr: "datum.type == 'pie'" }] }], signals: [{ name: 'projections', value: ['pie', 'kde'] }], marks: [{ type: 'rect', name: 'treemap', encode: { update: { fill: { value: 'geo' } } } }], projections: [] })).toBe('')
  })
  it('is not fooled by a deep or cyclic marks tree, and reads a spec edited in place as it is now', () => {
    const deep: VgSpec = { marks: [] }
    let cur = deep
    for (let i = 0; i < 5000; i++) { const g: VgSpec = { type: 'group', marks: [] }; (cur.marks as unknown[]).push(g); cur = g }
    expect(() => addonsNeeded(deep)).not.toThrow()
    const cyc: VgSpec = { marks: [] }
    ;(cyc.marks as unknown[]).push(cyc)
    expect(only(cyc)).toBe('')
    const edited: VgSpec = { data: [{ name: 'd' }] }
    expect(only(edited)).toBe('')
    ;(edited.data as Array<Record<string, unknown>>)[0]!.transform = [{ type: 'kde' }]
    expect(only(edited)).toBe('transforms')
  })
})
