/**
 * LIVE differential: every transform parameter vega reads as a field, written in every form vega-parser accepts, against the pinned
 * real vega, through the whole chart (compile, then evaluate) on both sides.
 *
 * vega-parser reads a field parameter (and a value vega lets be computed per tuple) in several forms (`parameterValue`): a name, a
 * `{signal}` whose value is the name, `{field, as}` (the field's accessor, named `as`) and `{expr, as}` (an expression over the tuple,
 * with no name: vega's Expression operator drops `as`); a comparator's fields may be `{signal}` or `{expr}`; and what is none of them
 * is no access path, which vega's runtime refuses when it builds the view. Each transform names its outputs after the accessors'
 * names, so an unnamed one shows as the key `"undefined"` -- vega's output, compared as it is.
 *
 * Generated from vega's own definitions: every transform that has a field parameter (sub-parameters of `force` and `density`
 * included) and every comparator parameter must have a base case here that sets it, and every such parameter is rewritten, one at a
 * time (one element of a list at a time), into every form. What is compared, strictly: the dataset's rows (values, key order,
 * undefined-valued keys, row order) or, when vega refuses, that Aster refuses too, with vega's message when it is no incidental
 * TypeError.
 *
 * `heatmap` draws into a canvas, which Node lacks: vega gets the stand-in canvas the raster differential uses, and the images are
 * compared by their bytes. `wordcloud` lays words out by their ink on a canvas (its own Chromium differential pins it, see
 * wordcloud-vs-vega.test.ts); here its forms are held to each other: each form of a parameter gives the cloud the plain form gives.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'
import '@aster-charts/core/geo'

type Obj = Record<string, unknown>

const ROWS: Obj[] = [
  { id: 1, parent: null, g: 'a', k: 1, v: 1, x: 1, y: 2, w: 1, t: 'aa bb', arr: [1, 2], d: 946684800000, lon: 0, lat: 0, c: 'red' },
  { id: 2, parent: 1, g: 'a', k: 2, v: 3, x: 2, y: 5, w: 2, t: 'bb', arr: [3], d: 978307200000, lon: 10, lat: 5, c: 'blue' },
  { id: 3, parent: 1, g: 'b', k: 1, v: 5, x: 3, y: 4, w: 1, t: 'cc', arr: [4, 5], d: 1009843200000, lon: -20, lat: 30, c: 'green' },
  { id: 4, parent: 2, g: 'b', k: 2, v: 7, x: 4, y: 9, w: 3, t: 'cc dd', arr: [], d: 1041379200000, lon: 40, lat: -10, c: 'red' },
]
const EXTRA = [
  { name: 'tab', values: [{ id: 1, z: 10 }, { id: 2, z: 20 }] },
  { name: 'tab2', values: [{ v: 1 }, { v: 4 }, { v: 6 }] },
  { name: 'links', values: [{ source: 1, target: 2 }, { source: 3, target: 4 }] },
]
const PT = { type: 'formula', expr: "{type: 'Point', coordinates: [datum.lon, datum.lat]}", as: 'pt' }
const STRAT = { type: 'stratify', key: 'id', parentKey: 'parent' }

/**
 * A pipeline per case, the transform under test last but for what reads its result; `alts` are the forms tried for a parameter vega
 * computes per tuple (a constant otherwise): its value as `{field}`, `{expr}` and `{signal}`.
 */
interface Base { pipeline: Obj[]; at?: number; alts?: Record<string, unknown[]> }
const BASES: Record<string, Base> = {
  aggregate: { pipeline: [{ type: 'aggregate', groupby: ['g', 'k'], fields: ['v', 'x'], ops: ['sum', 'max'], key: 'g' }] },
  aggregateCross: { pipeline: [{ type: 'aggregate', groupby: ['g', 'k'], fields: ['v'], ops: ['sum'], cross: true }] },
  bin: { pipeline: [{ type: 'bin', field: 'v', extent: [0, 10], maxbins: 5 }] },
  countpattern: { pipeline: [{ type: 'countpattern', field: 't' }] },
  density: { pipeline: [{ type: 'density', extent: [0, 10], steps: 3, distribution: { function: 'kde', from: 'tab2', field: 'v', bandwidth: 1 } }] },
  densityMixture: { pipeline: [{ type: 'density', extent: [0, 10], steps: 3, distribution: { function: 'mixture', distributions: [{ function: 'kde', from: 'tab2', field: 'v', bandwidth: 1 }, { function: 'normal' }] } }] },
  dotbin: { pipeline: [{ type: 'dotbin', field: 'v', groupby: ['g'], step: 3, signal: 'db' }, { type: 'formula', expr: 'db.step', as: 'st' }], at: 0 },
  extent: { pipeline: [{ type: 'extent', field: 'v', signal: 'ext' }, { type: 'formula', expr: 'ext', as: 'e' }], at: 0 },
  flatten: { pipeline: [{ type: 'flatten', fields: ['arr', 'arr'], index: 'i' }] },
  fold: { pipeline: [{ type: 'fold', fields: ['v', 'k'] }] },
  impute: { pipeline: [{ type: 'filter', expr: 'datum.v != 3' }, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], value: -1 }] },
  joinaggregate: { pipeline: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v', 'x'], ops: ['sum', 'min'], key: 'g' }] },
  kde: { pipeline: [{ type: 'kde', field: 'v', groupby: ['g'], steps: 2, extent: [0, 10], bandwidth: 1 }] },
  lookup: { pipeline: [{ type: 'lookup', from: 'tab', key: 'id', fields: ['k'], values: ['z', 'id'], default: 0 }] },
  lookupFields: { pipeline: [{ type: 'lookup', from: 'tab', key: 'id', fields: ['k', 'id'], as: ['o1', 'o2'] }] },
  pivot: { pipeline: [{ type: 'pivot', field: 'k', value: 'v', groupby: ['g'], key: 'g' }] },
  project: { pipeline: [{ type: 'project', fields: ['v', 'g'] }] },
  quantile: { pipeline: [{ type: 'quantile', field: 'v', groupby: ['g'], probs: [0.5] }] },
  timeunit: { pipeline: [{ type: 'timeunit', field: 'd', units: ['year'], timezone: 'utc' }] },
  window: { pipeline: [{ type: 'window', groupby: ['g'], fields: ['v', 'x'], ops: ['sum', 'max'], sort: { field: ['v', 'x'], order: ['descending', 'ascending'] } }] },
  linkpath: { pipeline: [{ type: 'linkpath', sourceX: 'x', sourceY: 'y', targetX: 'v', targetY: 'k' }] },
  pie: { pipeline: [{ type: 'pie', field: 'v' }] },
  stack: { pipeline: [{ type: 'stack', field: 'v', groupby: ['g'], sort: { field: 'k', order: 'descending' } }] },
  collect: { pipeline: [{ type: 'collect', sort: { field: ['g', 'v'], order: ['descending'] } }] },
  contour: { pipeline: [{ type: 'contour', x: 'x', y: 'y', weight: 'w', size: [8, 8], count: 2 }] },
  geojson: { pipeline: [{ type: 'geojson', fields: ['lon', 'lat'], signal: 'gj' }, { type: 'formula', expr: 'gj.features[0].geometry.coordinates.length', as: 'n' }], at: 0 },
  geojsonGeo: { pipeline: [PT, { type: 'geojson', geojson: 'pt', signal: 'gj' }, { type: 'formula', expr: 'gj.features.length', as: 'n' }], at: 1 },
  geopath: { pipeline: [PT, { type: 'geopath', projection: 'p', field: 'pt', pointRadius: 3 }], alts: { pointRadius: [{ field: 'w' }, { expr: 'datum.coordinates[0] / 10 + 1' }, { signal: '2 + 2' }] } },
  geopoint: { pipeline: [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }] },
  geoshape: { pipeline: [PT, { type: 'geoshape', projection: 'p', field: 'datum.pt', pointRadius: 3 }], alts: { pointRadius: [{ field: 'w' }, { expr: 'datum.coordinates[1] / 10 + 1' }, { signal: '5' }] } },
  heatmap: {
    pipeline: [{ type: 'kde2d', x: 'x', y: 'y', size: [3, 3], as: 'grid' }, { type: 'heatmap', field: 'grid', color: '#f00', opacity: 0.5 }],
    alts: { color: [{ field: 'c' }, { expr: "datum.$value > datum.$max / 2 ? 'red' : 'blue'" }, { expr: 'datum.c' }, { signal: "'green'" }], opacity: [{ field: 'w' }, { expr: 'datum.$x / 3' }, { signal: '0.25' }] },
  },
  isocontour: {
    pipeline: [{ type: 'kde2d', x: 'x', y: 'y', size: [8, 8], as: 'grid' }, { type: 'isocontour', field: 'grid', levels: 2, scale: 2, translate: [1, 1] }],
    // (an element of `translate` written `{field}` / `{expr}` is a function inside a list, which vega adds to the coordinates as text:
    // its own source code -- no chart; an element is tried as a signal)
    alts: { scale: [{ field: 'w' }, { expr: 'datum.grid.width / 4' }, { signal: '3' }], translate: [{ signal: '4' }, { signal: 'on ? 2 : 0' }] },
  },
  kde2d: { pipeline: [{ type: 'kde2d', x: 'x', y: 'y', weight: 'w', groupby: ['g'], size: [4, 4] }, { type: 'formula', expr: 'datum.grid.values.length', as: 'n' }], at: 0 },
  force: {
    pipeline: [{ type: 'force', static: true, iterations: 3, forces: [{ force: 'collide', radius: 'v' }, { force: 'nbody', strength: -5 }, { force: 'link', links: 'links', id: 'id', distance: 10, strength: 0.5 }, { force: 'x', x: 'x' }, { force: 'y', y: 'y' }] }],
    alts: { radius: [{ field: 'w' }, { expr: 'datum.v + 1' }, { signal: '2' }], strength: [{ field: 'w' }, { expr: '-datum.v' }, { signal: '0.3' }], distance: [{ field: 'w' }, { expr: 'datum.source.v + 1' }, { signal: '4' }] },
  },
  nest: { pipeline: [{ type: 'nest', keys: ['g', 'k'], generate: true }] },
  pack: { pipeline: [STRAT, { type: 'pack', field: 'v', radius: 'w', size: [100, 100], sort: { field: 'v' } }] },
  partition: { pipeline: [STRAT, { type: 'partition', field: 'v', size: [100, 100], sort: { field: 'v', order: 'descending' } }] },
  stratify: { pipeline: [STRAT, { type: 'tree', size: [100, 100] }], at: 0 },
  tree: { pipeline: [STRAT, { type: 'tree', field: 'v', size: [100, 100], sort: { field: 'v' } }] },
  treemap: { pipeline: [STRAT, { type: 'treemap', field: 'v', size: [100, 100], sort: { field: 'v' } }] },
  loess: { pipeline: [{ type: 'loess', x: 'x', y: 'y', groupby: ['g'] }] },
  regression: { pipeline: [{ type: 'regression', x: 'x', y: 'y', groupby: ['g'] }] },
  voronoi: { pipeline: [{ type: 'voronoi', x: 'x', y: 'y', size: [10, 10] }] },
  wordcloud: {
    pipeline: [{ type: 'wordcloud', size: [200, 200], text: 't', font: 'sans-serif', fontStyle: 'normal', fontWeight: 'normal', fontSize: 12, rotate: 0, padding: 1 }],
    // (each form with the plain form it stands for: see the wordcloud case below)
    alts: {
      font: [{ field: 'c' }, { expr: "'serif'" }, { signal: "'monospace'" }], fontStyle: [{ expr: "'italic'" }, { signal: "'italic'" }],
      fontWeight: [{ expr: "datum.v > 3 ? 'bold' : 'normal'" }, { signal: "'bold'" }], fontSize: [{ field: 'v' }, { expr: 'datum.v * 3' }, { signal: '20' }],
      rotate: [{ field: 'k' }, { expr: 'datum.k * 45' }, { signal: '90' }], padding: [{ field: 'w' }, { expr: 'datum.w + 1' }, { signal: '3' }],
    },
  },
  crossfilter: { pipeline: [{ type: 'crossfilter', fields: ['v', 'x'], query: [[0, 4], [0, 10]], signal: 'cf' }] },
  label: {
    pipeline: [{ type: 'label', size: [100, 100], sort: { field: 'v' } }],
  },
}

const spec = (pipeline: Obj[], signals: Obj[] = []): Obj => ({
  width: 100, height: 100, signals: [{ name: 'on', value: true }, ...signals],
  projections: [{ name: 'p', type: 'mercator', scale: 50, translate: [50, 50] }],
  data: [...EXTRA, { name: 'src', values: structuredClone(ROWS), transform: pipeline }],
})

// --------------------------------------------------------------------------------------------- the forms of one parameter

const fieldExpr = (name: string): string => `datum[${JSON.stringify(name)}]`
/** The forms of a field written as the name `f`; `bad` ones are no access path. */
function fieldForms(f: string): Array<{ form: string; value: unknown }> {
  return [
    { form: '{field}', value: { field: f } },
    { form: '{field, as}', value: { field: f, as: 'w2' } },
    { form: '{expr}', value: { expr: fieldExpr(f) } },
    { form: '{expr, as}', value: { expr: fieldExpr(f), as: 'w2' } },
    { form: '{expr} reading a signal', value: { expr: `on ? ${fieldExpr(f)} : null` } },
    { form: '{signal}', value: { signal: JSON.stringify(f) } },
    { form: 'an object of no form', value: { name: f } },
    { form: '{field} that is no path', value: { field: { name: f } } },
    { form: 'a number', value: 3 },
  ]
}
function compareForms(f: string): Array<{ form: string; value: unknown }> {
  return [
    { form: '{expr}', value: { expr: fieldExpr(f) } },
    { form: '{expr} negated', value: { expr: `-${fieldExpr(f)}` } },
    { form: '{signal}', value: { signal: JSON.stringify(f) } },
    { form: '{field} (no path)', value: { field: f } },
    { form: 'an empty name', value: '' },
  ]
}

interface Param { path: string; kind: 'field' | 'computed' | 'compare'; list: boolean }
interface VegaParam { name: string; type: string; expr?: boolean; array?: boolean; params?: Array<{ key: Obj; params?: VegaParam[] }> }
const definition = (type: string): { params: VegaParam[] } => (vega as unknown as { definition(t: string): { params: VegaParam[] } }).definition(type)
/** Every parameter of a transform vega reads as a field, a computed value or a comparator, by its path (sub-parameters: `forces.radius`). */
function fieldParams(params: VegaParam[], prefix = ''): Param[] {
  const out: Param[] = []
  for (const p of params) {
    if (p.type === 'field') out.push({ path: prefix + p.name, kind: 'field', list: !!p.array })
    else if (p.expr) out.push({ path: prefix + p.name, kind: 'computed', list: !!p.array })
    else if (p.type === 'compare') out.push({ path: prefix + p.name, kind: 'compare', list: false })
    if (p.params) for (const s of p.params) out.push(...fieldParams(s.params ?? [], prefix + p.name + '.'))
  }
  return out
}

interface Case { label: string; pipeline: Obj[]; base: string; param: string; kind: Param['kind'] }
/** The places in `o` (a transform, a list of sub-parameter objects...) a parameter path names: [holder, key] pairs. */
function holders(o: unknown, path: string[]): Array<[Obj, string]> {
  if (o === null || typeof o !== 'object') return []
  if (Array.isArray(o)) return o.flatMap((x) => holders(x, path))
  const rec = o as Obj
  if (path.length === 1) return path[0]! in rec ? [[rec, path[0]!]] : []
  return holders(rec[path[0]!], path.slice(1))
}

function casesOf(name: string, base: Base): { cases: Case[]; covered: Set<string> } {
  const at = base.at ?? base.pipeline.length - 1
  const t = base.pipeline[at]!
  const cases: Case[] = []
  const covered = new Set<string>()
  for (const p of fieldParams(definition(t.type as string).params)) {
    const places = holders(t, p.path.split('.'))
    if (!places.length) continue
    covered.add(p.path)
    places.forEach(([holder, key], h) => {
      const written = holder[key]
      const slots: Array<number | null> = p.list && Array.isArray(written) ? written.map((_, i) => i) : [null]
      for (const slot of slots) {
        const current = slot === null ? written : (written as unknown[])[slot]
        let forms: Array<{ form: string; value: unknown }>
        if (p.kind === 'compare') {
          const fields = Array.isArray((current as Obj).field) ? ((current as Obj).field as string[]) : [(current as Obj).field as string]
          forms = fields.flatMap((f, i) => compareForms(f).map(({ form, value }) => ({
            form: `field[${i}] ${form}`,
            value: { ...(current as Obj), field: Array.isArray((current as Obj).field) ? fields.map((g, j) => (j === i ? value : g)) : value },
          })))
        } else if (p.kind === 'computed') forms = (base.alts?.[key] ?? []).map((value) => ({ form: JSON.stringify(value), value }))
        else forms = typeof current === 'string' ? fieldForms(current) : []
        for (const { form, value } of forms) {
          const pipeline = structuredClone(base.pipeline)
          const [hold, k] = holders(pipeline[at], p.path.split('.'))[h]!
          if (slot === null) hold[k] = value
          else (hold[k] as unknown[])[slot] = value
          cases.push({ label: `${name}: ${p.path}${slot === null ? '' : `[${slot}]`}${places.length > 1 ? ` (#${h})` : ''} as ${form}`, pipeline, base: name, param: p.path, kind: p.kind })
        }
      }
    })
  }
  return { cases, covered }
}

// --------------------------------------------------------------------------------------------- the two sides

type Outcome = { rows: unknown[] } | { error: string }

/** A canvas as Node lacks one: vega-canvas finds `document`, vega-geo's heatmap writes its pixels into the buffer. */
function withCanvas<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as { document?: unknown }
  const had = g.document
  g.document = {
    createElement() {
      const c = { width: 0, height: 0, pix: undefined as Uint8ClampedArray | undefined, getContext: () => ({
        getImageData: (_x: number, _y: number, w: number, h: number) => (c.pix = new Uint8ClampedArray(4 * w * h), { data: c.pix }),
        putImageData() {},
      }) }
      return c
    },
  }
  return run().finally(() => { g.document = had })
}

async function viaVega(s: Obj): Promise<Outcome> {
  const errors: string[] = []
  try {
    const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none', logLevel: vega.None })
    view.logger({
      level() { return 1 },
      error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')); return this },
      warn() { return this }, info() { return this }, debug() { return this },
    } as unknown as vega.LoggerInterface)
    await withCanvas(() => view.runAsync())
    const rows = view.data('src')
    view.finalize()
    return errors.length ? { error: errors[0]!.replace(/^Error: /, '') } : { rows }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function viaAster(s: Obj): Outcome {
  const errors: string[] = []
  try {
    const logger = { error: (...a: unknown[]) => { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')) }, warn() {} }
    // (a seeded stream: the layouts that draw -- force, wordcloud -- draw the same numbers every run)
    const scene = evaluateChart(compileChart(structuredClone(s) as never), { logger, random: lcg(7) })
    const rows = datasetsOfScene(scene).get('src')
    if (errors.length || rows == null) return { error: errors[0] ?? 'the dataset failed' }
    return { rows: rows as unknown[] }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Heatmap images become their bytes on both sides. */
function plain(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    const o: Obj = { ...(row as Obj) }
    for (const k of Object.keys(o)) {
      const v = o[k] as { width?: number; height?: number; pix?: Uint8ClampedArray; pixels?: Uint8ClampedArray } | undefined
      if (v && typeof v === 'object' && (v.pix || v.pixels)) o[k] = { image: [v.width, v.height], bytes: Array.from((v.pix ?? v.pixels)!) }
    }
    return o
  })
}

const show = (v: unknown): string => (v instanceof Date ? `Date(${v.getTime()})` : typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[array ${v.length}]` : typeof v === 'object' && v !== null ? '{object}' : String(v))

/** Strict structural equality, key order included; the path of the first difference, or null. */
function diff(a: unknown, b: unknown, path = '$', seen = new Set<unknown>()): string | null {
  if (Object.is(a, b)) return null
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? null : `${path}: ${show(a)} vs ${show(b)}`
  if (typeof a === 'function' && typeof b === 'function') return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${show(a)} vs ${show(b)}`
  if (seen.has(a)) return null
  seen.add(a)
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.join('\u0000') !== kb.join('\u0000')) return `${path}: keys [${ka.join(',')}] vs [${kb.join(',')}]`
  for (const k of ka) {
    const d = diff((a as Obj)[k], (b as Obj)[k], `${path}.${k}`, seen)
    if (d) return d
  }
  return null
}

/**
 * The transforms whose vega output cannot be compared in Node, held to their own plain forms instead: `wordcloud` lays words out by
 * their ink on a canvas (wordcloud-vs-vega.test.ts compares it with vega in Chromium); `geoshape` writes vega's shape function, which
 * draws on a canvas context, where Aster writes the path (the geo pipeline differential compares the drawn shapes).
 */
const METAMORPHIC = new Set(['wordcloud', 'geoshape'])
const READ_BY_SOME_FORM: Record<string, string[]> = { wordcloud: ['font', 'fontStyle', 'fontWeight', 'fontSize', 'rotate'], geoshape: ['pointRadius'] }

/** A fresh pseudo-random stream (vega's LCG). */
const lcg = (seed: number): (() => number) => () => (seed = (1103515245 * seed + 12345) % 2147483647) / 2147483647

const INCIDENTAL = /Cannot read properties|is not a function|is not iterable/
/** The forms that are no access path (see `fieldForms`, `compareForms`). */
const NO_PATH = /no form|no path|a number|an empty name/

// --------------------------------------------------------------------------------------------- the suite

const ALL = Object.entries(BASES).map(([name, base]) => ({ name, base, ...casesOf(name, base) }))

describe('every transform parameter vega reads as a field, in every form, against vega', () => {
  it('every field, computed and comparator parameter of every transform vega defines has a base case that sets it', () => {
    const missing: string[] = []
    for (const type of Object.keys((vega as unknown as { transforms: Obj }).transforms).map((t) => t.toLowerCase())) {
      const def = (vega as unknown as { definition(t: string): { params: VegaParam[] } | undefined }).definition(type)
      if (!def) continue
      for (const p of fieldParams(def.params)) {
        if (!ALL.some((c) => (c.base.pipeline[c.base.at ?? c.base.pipeline.length - 1]!.type === type) && c.covered.has(p.path))) missing.push(`${type}.${p.path}`)
      }
    }
    expect(missing).toEqual([])
  })

  for (const { name, base, cases } of ALL) {
    it(name, { timeout: 60_000 }, async () => {
      expect(cases.length, 'cases').toBeGreaterThan(0)
      const bad: string[] = []
      let compared = 0
      let refused = 0
      if (METAMORPHIC.has(name)) {
        // (see METAMORPHIC) each form must give the cloud its twin gives -- the same values written another way: a
        // `{field}` as an `{expr}` reading the field, an expression or signal of literals as the constant -- and a cloud other than the
        // base's when it computes other values (it is read, not dropped)
        const at = base.pipeline.length - 1
        const baseRows = viaAster(spec(base.pipeline))
        const changed = new Set<string>()
        for (const c of cases) {
          const t = c.pipeline[at]!
          if (NO_PATH.test(c.label)) {
            // (vega's runtime refuses these when it builds the view, before any canvas is needed)
            const got = viaAster(spec(c.pipeline))
            const want = await viaVega(spec(c.pipeline))
            if (!('error' in got) || !('error' in want) || got.error !== want.error) bad.push(`${c.label}: ${JSON.stringify([got, want].map((o) => ('error' in o ? o.error : 'ok')))}`)
            refused++
            continue
          }
          const twin = structuredClone(c.pipeline)
          twin[at]![c.param] = twinOf(t[c.param], c.kind === 'field')
          const got = viaAster(spec(c.pipeline))
          const want = viaAster(spec(twin))
          if ('error' in got || 'error' in want || 'error' in baseRows) { bad.push(`${c.label}: threw ${JSON.stringify([got, want].filter((o) => 'error' in o))}`); continue }
          compared++
          const d = diff(got.rows, want.rows)
          if (d) bad.push(`${c.label}: vs its twin ${JSON.stringify(twin[at]![c.param])}: ${d}`)
          if (diff(got.rows, baseRows.rows) !== null) changed.add(c.param)
        }
        // (the forms are read, not dropped: each parameter that sizes or places what is drawn changes it in some form)
        for (const p of READ_BY_SOME_FORM[name] ?? []) if (!changed.has(p)) bad.push(`${p}: no form changed the output`)
        expect(bad, bad.slice(0, 10).join('\n')).toEqual([])
        expect(compared + refused).toBe(cases.length)
        expect(compared).toBeGreaterThan(cases.length / 2)
        return
      }
      for (const c of cases) {
        const want = await viaVega(spec(c.pipeline))
        const got = viaAster(spec(c.pipeline))
        if ('error' in want) {
          refused++
          if (!('error' in got)) bad.push(`${c.label}: Aster did not refuse; vega: ${want.error}`)
          else if (!INCIDENTAL.test(want.error) && !got.error.includes(want.error)) bad.push(`${c.label}: aster "${got.error}" vs vega "${want.error}"`)
          continue
        }
        if ('error' in got) { bad.push(`${c.label}: Aster threw ${got.error}`); continue }
        compared++
        const d = diff(plain(got.rows), plain(want.rows))
        if (d) bad.push(`${c.label}: ${d}`)
      }
      expect(bad, `${bad.length} of ${cases.length} differ:\n${bad.slice(0, 10).join('\n')}`).toEqual([])
      // (not vacuous: most forms are compared row for row; the forms that are no access path are refused)
      expect(compared, `compared (refused ${refused})`).toBeGreaterThan(cases.length / 2)
    })
  }
})

/**
 * The plain twin of a wordcloud form: `{field: f}` as `{expr: datum[f]}` (a field parameter's as its name), `{expr}` / `{signal}` of
 * literals as the constant they compute, an `{expr}` reading the tuple as the same expression written with the other spelling.
 */
function twinOf(v: unknown, field: boolean): unknown {
  if (typeof v !== 'object' || v === null) return v
  const o = v as Obj
  if (typeof o.field === 'string') return field ? o.field : { expr: fieldExpr(o.field) }
  const text = (o.expr ?? o.signal) as string | undefined
  if (typeof text !== 'string') return v
  // (a literal is the constant it spells, even one that holds the text `datum`: a geoshape's field is the path `datum.pt`)
  if (/^\s*(["']).*\1\s*$/.test(text)) return JSON.parse(text.trim().replace(/'/g, '"'))
  if (/datum/.test(text)) return { expr: `(${text})` }
  return JSON.parse(text.replace(/'/g, '"'))
}
