/**
 * LIVE, GENERATED differential for the geo engine (`geo-lib.ts`, `geo-projections.ts`, `geo.ts`):
 * seeded random GeoJSON (points, lines, polygons with holes, antimeridian-crossing and
 * pole-enclosing rings, degenerate rings, huge and tiny coordinates) and random projection
 * parameters (rotate, center, scale, translate, clipAngle, clipExtent, precision, reflect,
 * parallels, fit) for EVERY projection type Aster registers, run through real Vega (vega-geo's
 * Projection transform over vega-projection's registry, d3-geo 3.1.1) and through Aster's
 * `buildProjection`, in one process. Everything must be identical bit for bit: the projection's
 * state after the parameters apply, projected and inverted points, path strings (default and full
 * precision, with numeric and function point radii), planar area/bounds/centroid/length of the
 * path, the spherical geoArea/geoBounds/geoCentroid, and fitted scale/translate. A final block runs
 * whole Vega specs (geoshape, geopath, geopoint, graticule) through both renderers.
 *
 * A failure names the generator seed and case index; re-run it by narrowing `CASES`.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as vega from 'vega'
import * as d3Geo from 'd3-geo'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import '../../core/src/addon-transforms.ts'
import { buildProjection } from '../../core/src/geo.ts'
import { GeoPath } from '../../core/src/geo-path.ts'
import { sphereArea, sphereBounds, sphereCentroid } from '../../core/src/geo-sphere-measures.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { enc, exact, quietLogger } from './differential-util.mts'
import { PLANAR_SHAPES, PROJECTION_TYPES, Rand, geoObject, oddParams, probePoints, projectionParams, randomSpec, regional, seedOf, type Json } from './geo-gen.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

/** how many generated cases each block runs; the floor test below keeps this from being quietly lowered */
const CASES = { configs: 36, shapes: 7, fits: 14, odd: 30, sphere: 600, specs: 90 }

/* ---- the two subjects ---------------------------------------------------------------------- */

/** What both sides expose, so the comparison is one function. */
interface Probe {
  /** Make the next measure start from a clean state (d3 keeps pipelines and accumulators between calls; Aster keeps none). */
  fresh?(): void
  /** Repair what a call that threw left behind. */
  recover?(): void
  config(): Record<string, unknown>
  project(p: number[]): unknown
  invert(xy: number[]): unknown
  path(geo: unknown, o: { digits?: number | null; radius?: number | ((g: unknown) => number) }): unknown
  planar(geo: unknown): Record<string, unknown>
}

const CONFIG_PROPS = ['scale', 'translate', 'center', 'rotate', 'clipAngle', 'clipExtent', 'precision', 'parallels', 'reflectX', 'reflectY']

/**
 * d3-geo keeps its measuring accumulators, and the pipeline it built for them, in module and projection state: a call
 * that throws half way (an empty polygon ring does) leaves a polygon half open, and the next measure starts from there.
 * Aster keeps no state between calls, so the oracle is put back in a known state after a throw: one well-formed polygon
 * through every measure closes what was left open and empties the sums.
 */
const REPAIR = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
function repairD3(): void {
  const g = d3Geo.geoPath()
  for (const run of [() => d3Geo.geoArea(REPAIR as Any), () => d3Geo.geoBounds(REPAIR as Any), () => d3Geo.geoCentroid(REPAIR as Any), () => g.area(REPAIR as Any), () => g.bounds(REPAIR as Any), () => g.centroid(REPAIR as Any), () => g.measure(REPAIR as Any)]) run()
}

/**
 * d3's path string remembers the append function of the last circle it drew. A point drawn with `digits(null)` leaves
 * the unrounded one remembered (a stray point does that in a path that interleaves, albersUsa's does), and every later
 * default-digits path of the process comes out unrounded. Vega never sets `digits`; asking for two other digit counts
 * makes d3 forget it.
 */
function unpoisonDigits(): void {
  d3Geo.geoPath().digits(2)
  d3Geo.geoPath().digits(3)
}

function d3Probe(p: Any): Probe {
  return {
    recover: repairD3,
    // re-setting a reflection drops the cached pipeline and recomputes what derives from the scale, without touching
    // a cylindrical projection's clip rectangle (re-setting the scale would recompute that one from the current rotation)
    fresh: () => { if (p.reflectX) p.reflectX(p.reflectX()); else if (p.scale) p.scale(p.scale()) },
    config: () => {
      const o: Record<string, unknown> = {}
      for (const m of CONFIG_PROPS) if (typeof p[m] === 'function') o[m] = exact(() => p[m]())
      return o
    },
    project: (pt) => p(pt),
    invert: (xy) => (p.invert ? p.invert(xy) : 'none'),
    path: (geo, o) => {
      const g = d3Geo.geoPath(p)
      if (o.digits !== undefined) g.digits(o.digits)
      if (o.radius !== undefined) g.pointRadius(o.radius as Any)
      try {
        return g(geo as Any)
      } finally {
        if (o.digits === null) unpoisonDigits()
      }
    },
    planar: (geo) => {
      const g = d3Geo.geoPath(p).digits(null)
      return { area: exact(() => g.area(geo as Any)), bounds: exact(() => g.bounds(geo as Any)), centroid: exact(() => g.centroid(geo as Any)), measure: exact(() => g.measure(geo as Any)) }
    },
  }
}

function asterProbe(p: Any): Probe {
  const pathOf = (o: { digits?: number | null; radius?: number | ((g: unknown) => number) }): GeoPath => {
    const g = new GeoPath(p)
    if (o.digits !== undefined) g.digits = o.digits
    if (o.radius !== undefined) g.pointRadius = o.radius
    return g
  }
  return {
    config: () => {
      const o: Record<string, unknown> = {}
      for (const m of CONFIG_PROPS) if (p[m] !== undefined) o[m] = exact(() => p[m])
      return o
    },
    project: (pt) => p.project(pt[0], pt[1]),
    invert: (xy) => p.invert(xy[0], xy[1]),
    path: (geo, o) => pathOf(o).draw(geo),
    planar: (geo) => {
      const g = pathOf({ digits: null })
      return { area: exact(() => g.area(geo)), bounds: exact(() => g.bounds(geo)), centroid: exact(() => g.centroid(geo)), measure: exact(() => g.measure(geo)) }
    },
  }
}

/** A projection, or the message of the error that building it raised. */
type Built = { projection: Any } | { error: string }

async function viaVega(params: Record<string, Json>): Promise<Built> {
  try {
    const errors: unknown[][] = []
    const quiet = quietLogger(errors)
    const spec = structuredClone({ width: 300, height: 200, projections: [{ name: 'p', ...params }] })
    const view = new vega.View(vega.parse(spec as vega.Spec), { renderer: 'none', logLevel: vega.None, logger: quiet as never })
    view.logger(quiet as never)
    await view.runAsync()
    if (errors.length) {
      repairD3()
      return { error: String((errors[0]![0] as Error)?.message ?? errors[0]![0]) }
    }
    return { projection: view.scale('p') }
  } catch (e) {
    repairD3()
    return { error: (e as Error).message }
  }
}

function viaAster(params: Record<string, Json>): Built {
  try {
    return { projection: buildProjection({ name: 'p', ...structuredClone(params) } as never) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/* ---- comparison ------------------------------------------------------------------------------ */

/** Path strings longer than this are a blown-up shape (see `observe`). */
const HUGE_PATH = 150_000

/** A long string stands for its length and hash, so a whole run does not hold tens of megabytes of path text. */
const digest = (v: unknown): unknown => (typeof v === 'string' && v.length > 4096 ? { n: v.length, head: v.slice(0, 60), sha: createHash('sha1').update(v).digest('hex') } : v)

const radiusFn = (g: any): number => (g && g.type === 'Point' ? 7 : g && g.type === 'MultiPoint' ? 2.5 : 5)

/** Whether a GeoJSON object draws any point (a Point / MultiPoint anywhere inside it). */
function drawsPoints(g: any): boolean {
  if (!g || typeof g !== 'object') return false
  if (g.type === 'Point' || g.type === 'MultiPoint') return true
  if (g.type === 'Feature') return drawsPoints(g.geometry)
  if (g.type === 'FeatureCollection') return g.features.some((f: any) => drawsPoints(f.geometry))
  if (g.type === 'GeometryCollection') return g.geometries.some(drawsPoints)
  return false
}

/**
 * Whether a GeoJSON object has a polygon ring that streams no vertex (a ring is streamed without its closing position,
 * so one or no positions leave nothing). d3's measures close such a ring against whatever vertex the previous call left in
 * module state, so what they report depends on the history of the process: only a thrown error is a stable answer.
 */
function hasEmptyRing(g: any): boolean {
  if (!g || typeof g !== 'object') return false
  if (g.type === 'Polygon') return g.coordinates.some((r: unknown[]) => r.length <= 1)
  if (g.type === 'MultiPolygon') return g.coordinates.some((poly: unknown[][]) => poly.some((r) => r.length <= 1))
  if (g.type === 'Feature') return hasEmptyRing(g.geometry)
  if (g.type === 'FeatureCollection') return g.features.some((f: any) => hasEmptyRing(f.geometry))
  if (g.type === 'GeometryCollection') return g.geometries.some(hasEmptyRing)
  return false
}

/** `value` unless it is a result that depends on process history (see `hasEmptyRing`), which is replaced by a marker. */
const stable = (value: unknown): unknown => ((value as Any)?.$ === 'throw' ? value : 'history-dependent')

/**
 * Everything one probe reports about one projection; same keys, same order, on both sides.
 *
 * Full-precision paths (`digits(null)`) are asked of point-free shapes only: d3's path string keeps one
 * module-level "current append function" for its cached point circle, and drawing a point with `digits(null)`
 * leaves it set to the unrounded one, so every later default-digits path of the process comes out unrounded too.
 * Vega never sets `digits`, so that state is unreachable from a spec, and Aster does not carry it.
 */
function observe(probe: Probe, points: number[][], pixels: number[][], shapes: Json[]): Record<string, unknown> {
  const out: Record<string, unknown> = { config: probe.config() }
  points.forEach((pt, i) => (out[`project#${i}`] = exact(() => probe.project(pt))))
  pixels.forEach((xy, i) => (out[`invert#${i}`] = exact(() => probe.invert(xy))))
  shapes.forEach((g, i) => {
    const path = exact(() => probe.path(g, {}))
    out[`path#${i}`] = digest(path)
    // a shape that a projection blows up (gnomonic near its horizon sends coordinates to 1e9 and every segment is
    // subdivided to full depth) is compared once, by its default path: the other renderings of it would cost minutes
    if (typeof path === 'string' && path.length > HUGE_PATH) {
      out[`huge#${i}`] = path.length
      return
    }
    if (!drawsPoints(g)) out[`path-full#${i}`] = digest(exact(() => probe.path(g, { digits: null })))
    out[`path-r#${i}`] = digest(exact(() => probe.path(g, { radius: 3.25 })))
    out[`path-rfn#${i}`] = digest(exact(() => probe.path(g, { radius: radiusFn })))
    probe.fresh?.()
    let planar = probe.planar(g)
    if (hasEmptyRing(g)) planar = Object.fromEntries(Object.entries(planar).map(([k, v]) => [k, k === 'bounds' ? v : stable(v)]))
    out[`planar#${i}`] = planar
    if (JSON.stringify(planar).includes('"$":"throw"')) probe.recover?.()
  })
  return out
}

function firstDiff(want: unknown, got: unknown, at = '$'): string | null {
  if (JSON.stringify(want) === JSON.stringify(got)) return null
  if (want && got && typeof want === 'object' && typeof got === 'object') {
    for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const d = firstDiff((want as Any)[k], (got as Any)[k], `${at}.${k}`)
      if (d) return d
    }
  }
  if (typeof want === 'string' && typeof got === 'string') {
    // two long strings: show where they part
    let i = 0
    while (want[i] === got[i]) i++
    return `${at}: vega ...${want.slice(Math.max(0, i - 60), i + 60)} vs aster ...${got.slice(Math.max(0, i - 60), i + 60)} (at ${i} of ${want.length}/${got.length})`
  }
  const s = (v: unknown) => { const t = JSON.stringify(v); return t === undefined ? 'undefined' : t.length > 400 ? t.slice(0, 400) + '...' : t }
  return `${at}: vega ${s(want)} vs aster ${s(got)}`
}

async function compareProjection(params: Record<string, Json>, r: Rand, label: string, shapesN: number, given?: Json[]): Promise<void> {
  const theirs = await viaVega(params)
  const ours = viaAster(params)
  if ('error' in theirs || 'error' in ours) {
    // both refuse, with the same words (a user sees them)
    const e = (b: Built): string => ('error' in b ? b.error : 'built')
    if (e(theirs) !== e(ours)) throw new Error(`${label} ${JSON.stringify(params)}\n  vega: ${e(theirs)}\n  aster: ${e(ours)}`)
    return
  }
  const points = probePoints(r, 8)
  const pixels = Array.from({ length: 5 }, () => [r.range(-200, 800), r.range(-200, 600)])
  const shapes = given ?? Array.from({ length: shapesN }, () => geoObject(r))
  const want = enc(observe(d3Probe(theirs.projection), points, pixels, shapes))
  const got = enc(observe(asterProbe(ours.projection), points, pixels, shapes))
  const d = firstDiff(want, got)
  if (d) throw new Error(`${label} ${JSON.stringify(params)}\n  ${d}\n  shapes ${JSON.stringify(shapes)}`)
}

/* ---- the differentials --------------------------------------------------------------------- */

describe(`generated geo differential vs vega@${vega.version} / d3-geo@3.1.1 (live)`, () => {
  for (const type of PROJECTION_TYPES) {
    it(`${type}: random parameters, points, inversion, paths and planar measures`, { timeout: 120_000 }, async () => {
      const r = new Rand(seedOf(type, 1))
      const failures: string[] = []
      for (let i = 0; i < CASES.configs; i++) {
        await compareProjection(projectionParams(r, type), r, `${type}#${i}`, CASES.shapes).catch((e: Error) => failures.push(e.message))
      }
      expect(failures.length, `${failures.length} of ${CASES.configs} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
    })
    it(`${type}: parameters of the wrong kind build, or fail, as in vega`, { timeout: 120_000 }, async () => {
      const r = new Rand(seedOf(type, 7))
      const failures: string[] = []
      for (let i = 0; i < CASES.odd; i++) {
        await compareProjection(oddParams(r, projectionParams(r, type)), r, `${type}-odd#${i}`, 3).catch((e: Error) => failures.push(e.message))
      }
      expect(failures.length, `${failures.length} of ${CASES.odd} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
    })
    it(`${type}: fit / fitSize / fitExtent against generated data`, { timeout: 120_000 }, async () => {
      const r = new Rand(seedOf(type, 2))
      const failures: string[] = []
      for (let i = 0; i < CASES.fits; i++) {
        await compareProjection(projectionParams(r, type, { fit: true }), r, `${type}-fit#${i}`, 3).catch((e: Error) => failures.push(e.message))
      }
      expect(failures.length, `${failures.length} of ${CASES.fits} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
    })
  }

  it('shapes a clip rectangle has nothing to cut come out as they went in (and merge in order across the parts of albersUsa)', { timeout: 120_000 }, async () => {
    const r = new Rand(seedOf('nothing-to-cut', 11))
    const failures: string[] = []
    const configs: Array<[Record<string, Json>, () => Json[]]> = [
      [{ type: 'identity', scale: 1, translate: [0, 0], clipExtent: [[0, 0], [100, 100]] }, () => PLANAR_SHAPES],
      [{ type: 'identity', scale: 2, translate: [-10, 5], clipExtent: [[0, 0], [100, 100]], reflectY: true }, () => PLANAR_SHAPES],
      [{ type: 'albersUsa', scale: 1000, translate: [480, 300] }, () => Array.from({ length: 12 }, () => regional(r))],
      [{ type: 'albersUsa' }, () => Array.from({ length: 12 }, () => regional(r))],
      [{ type: 'mercator', scale: 140, translate: [450, 250] }, () => Array.from({ length: 12 }, () => regional(r))],
      [{ type: 'mercator', scale: 140, translate: [450, 250], clipExtent: [[20, 20], [880, 480]] }, () => Array.from({ length: 12 }, () => regional(r))],
      [{ type: 'transverseMercator', scale: 140, translate: [450, 250] }, () => Array.from({ length: 12 }, () => regional(r))],
      [{ type: 'albers', scale: 1000, translate: [480, 300], clipExtent: [[0, 0], [960, 600]] }, () => Array.from({ length: 12 }, () => regional(r))],
    ]
    for (const [params, shapes] of configs) {
      for (let i = 0; i < 6; i++) await compareProjection(params, r, `${params.type}#${i}`, 0, shapes()).catch((e: Error) => failures.push(e.message))
    }
    expect(failures.length, `${failures.length} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
  })

  it('fitWidth / fitHeight on the built projections', async () => {
    for (const type of PROJECTION_TYPES) {
      const r = new Rand(seedOf(type, 3))
      for (let i = 0; i < 6; i++) {
        const params = projectionParams(r, type)
        const built = await viaVega(params)
        const made = viaAster(params)
        if ('error' in built || 'error' in made) continue
        const theirs = built.projection
        const ours = made.projection
        const data = geoObject(r)
        for (const fit of ['fitWidth', 'fitHeight'] as const) {
          const size = r.range(60, 700)
          const want = exact(() => { theirs[fit](size, data); return [theirs.scale(), theirs.translate(), theirs.clipExtent?.()] })
          if ((want as Any)?.$ === 'throw') repairD3()
          const got = exact(() => { ours[fit](size, data); return [ours.scale, ours.translate, ours.clipExtent] })
          expect(got, `${type}#${i} ${fit} ${JSON.stringify(params)} ${JSON.stringify(data)}`).toEqual(want)
        }
      }
    }
  })

  it('spherical geoArea / geoBounds / geoCentroid over generated shapes', () => {
    const r = new Rand(seedOf('sphere', 4))
    for (let i = 0; i < CASES.sphere; i++) {
      const g = geoObject(r)
      if (hasEmptyRing(g)) continue
      for (const [name, theirs, ours] of [['geoArea', d3Geo.geoArea, sphereArea], ['geoBounds', d3Geo.geoBounds, sphereBounds], ['geoCentroid', d3Geo.geoCentroid, sphereCentroid]] as const) {
        const want = exact(() => (theirs as Any)(structuredClone(g)))
        if ((want as Any)?.$ === 'throw') repairD3()
        const got = exact(() => (ours as Any)(structuredClone(g)))
        const d = firstDiff(want, got)
        if (d) throw new Error(`${name}#${i} ${JSON.stringify(g)}\n  ${d}`)
      }
    }
  })

  it('the default path (no projection) draws and measures coordinates as they are', () => {
    const r = new Rand(seedOf('default-path', 6))
    const failures: string[] = []
    for (let i = 0; i < 300; i++) {
      const g = geoObject(r)
      const dg = d3Geo.geoPath()
      const ag = new GeoPath()
      const check = (label: string, want: unknown, got: unknown): void => {
        const d = firstDiff(enc(want), enc(got))
        if (d) failures.push(`${label} ${JSON.stringify(g)}\n  ${d}`)
      }
      check('draw', exact(() => dg(g as Any)), exact(() => ag.draw(g)))
      if (!drawsPoints(g)) {
        const raw = d3Geo.geoPath().digits(null)
        const own = new GeoPath()
        own.digits = null
        check('draw-full', exact(() => raw(g as Any)), exact(() => own.draw(g)))
      }
      if (!hasEmptyRing(g)) {
        check('area', exact(() => dg.area(g as Any)), exact(() => ag.area(g)))
        check('bounds', exact(() => dg.bounds(g as Any)), exact(() => ag.bounds(g)))
        check('centroid', exact(() => dg.centroid(g as Any)), exact(() => ag.centroid(g)))
        check('measure', exact(() => dg.measure(g as Any)), exact(() => ag.measure(g)))
      }
      if (JSON.stringify(exact(() => dg.area(g as Any))).includes('throw')) repairD3()
    }
    expect(failures.length, failures.slice(0, 3).join('\n')).toBe(0)
  })

  it('the geo expression-level entry points agree on hostile objects', () => {
    const odd = [null, undefined, {}, [], 'x', 5, { type: 'Feature' }, { type: 'Feature', geometry: null }, { type: 'FeatureCollection', features: [] }, { type: 'Polygon', coordinates: [] }, { type: 'Point', coordinates: [] }, { type: 'LineString', coordinates: [[0, 0]] }, { type: 'constructor' }, { type: '__proto__' }]
    for (const g of odd) {
      for (const [theirs, ours] of [[d3Geo.geoArea, sphereArea], [d3Geo.geoBounds, sphereBounds], [d3Geo.geoCentroid, sphereCentroid]] as const) {
        const want = exact(() => (theirs as Any)(structuredClone(g)))
        if ((want as Any)?.$ === 'throw') repairD3()
        expect(exact(() => (ours as Any)(structuredClone(g))), JSON.stringify(g)).toEqual(want)
      }
    }
  })

  it('keeps its generated volume (coverage floor)', () => {
    expect(CASES.configs).toBeGreaterThanOrEqual(36)
    expect(CASES.fits).toBeGreaterThanOrEqual(14)
    expect(CASES.odd).toBeGreaterThanOrEqual(30)
    expect(CASES.sphere).toBeGreaterThanOrEqual(600)
    expect(CASES.specs).toBeGreaterThanOrEqual(90)
    expect(PROJECTION_TYPES.length).toBe(17)
  })
})

/* ---- whole specs: geoshape, geopath, geopoint, graticule ------------------------------------- */

describe('generated whole specs vs vega (live)', () => {
  /**
   * Specs on which real Vega itself reports an error (its path parser refuses a `NaN` coordinate that a degenerate clip produced,
   * its d3 stream throws on an empty ring), or whose SVG the canonicalizer cannot read (a mark at an infinite position), are not comparable: what a view does after an error is the runtime's business, not the
   * geo engine's. They are counted, and pinned, so the exclusion cannot grow unnoticed.
   */
  const refusedByVega: number[] = []
  const r = new Rand(seedOf('specs', 5))
  for (let i = 0; i < CASES.specs; i++) {
    const spec = randomSpec(r)
    it(`spec #${i} ${(spec.projections as Any)[0].type}`, async () => {
      const errors: unknown[][] = []
      let want: string
      try {
        const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
        await view.runAsync()
        want = await view.toSVG()
        view.finalize()
      } catch {
        errors.push(['threw'])
        want = ''
      }
      if (errors.length) {
        refusedByVega.push(i)
        return
      }
      let wantCanonical: ReturnType<typeof canonicalizeSvg>
      try {
        wantCanonical = canonicalizeSvg(want)
      } catch {
        // the canonicalizer does not take a mark at a non-finite position, which vega draws for a vertex at a pole
        refusedByVega.push(i)
        return
      }
      const got = renderSpec(structuredClone(spec) as never) as string
      const d = diffCanonical(wantCanonical, canonicalizeSvg(got))
      expect(d, d.slice(0, 3).join('\n') + '\n' + JSON.stringify(spec)).toEqual([])
    })
  }
  it('compares most of the generated specs (the ones vega refuses stay few)', () => {
    expect(refusedByVega.length, `vega refused specs ${refusedByVega.join(',')}`).toBeLessThanOrEqual(Math.floor(CASES.specs / 4))
  })
})
