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
import * as vega from 'vega'
import * as d3Geo from 'd3-geo'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import '../../core/src/addon-transforms.ts'
import { buildProjection } from '../../core/src/geo.ts'
import * as asterGeo from '../../core/src/geo-lib.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { enc, exact, quietLogger } from './differential-util.mts'
import { PROJECTION_TYPES, Rand, geoObject, probePoints, projectionParams, randomSpec, seedOf, type Json } from './geo-gen.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

/** how many generated cases each block runs; the floor test below keeps this from being quietly lowered */
const CASES = { configs: 36, shapes: 7, fits: 14, sphere: 600, specs: 90 }

/* ---- the two subjects ---------------------------------------------------------------------- */

/** What both sides expose, so the comparison is one function. */
interface Probe {
  config(): Record<string, unknown>
  project(p: number[]): unknown
  invert(xy: number[]): unknown
  path(geo: unknown, o: { digits?: number | null; radius?: number | ((g: unknown) => number) }): unknown
  planar(geo: unknown): Record<string, unknown>
}

const CONFIG_PROPS = ['scale', 'translate', 'center', 'rotate', 'clipAngle', 'clipExtent', 'precision', 'parallels', 'reflectX', 'reflectY']

function d3Probe(p: Any): Probe {
  return {
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
      return g(geo as Any)
    },
    planar: (geo) => {
      const g = d3Geo.geoPath(p).digits(null)
      return { area: exact(() => g.area(geo as Any)), bounds: exact(() => g.bounds(geo as Any)), centroid: exact(() => g.centroid(geo as Any)), measure: exact(() => g.measure(geo as Any)) }
    },
  }
}

function asterProbe(p: Any): Probe {
  return {
    config: () => {
      const o: Record<string, unknown> = {}
      for (const m of CONFIG_PROPS) if (typeof p[m] === 'function') o[m] = exact(() => p[m]())
      return o
    },
    project: (pt) => p(pt),
    invert: (xy) => (p.invert ? p.invert(xy) : 'none'),
    path: (geo, o) => {
      const g = asterGeo.geoPath(p)
      if (o.digits !== undefined) g.digits(o.digits)
      if (o.radius !== undefined) g.pointRadius(o.radius)
      return g(geo)
    },
    planar: (geo) => {
      const g = asterGeo.geoPath(p).digits(null)
      return { area: exact(() => g.area(geo)), bounds: exact(() => g.bounds(geo)), centroid: exact(() => g.centroid(geo)), measure: exact(() => g.measure(geo)) }
    },
  }
}

async function viaVega(params: Record<string, Json>): Promise<Any | null> {
  try {
    const errors: unknown[][] = []
    const quiet = quietLogger(errors)
    const spec = structuredClone({ width: 300, height: 200, projections: [{ name: 'p', ...params }] })
    const view = new vega.View(vega.parse(spec as vega.Spec), { renderer: 'none', logLevel: vega.None, logger: quiet as never })
    view.logger(quiet as never)
    await view.runAsync()
    if (errors.length) return null
    return view.scale('p')
  } catch {
    return null
  }
}

function viaAster(params: Record<string, Json>): Any | null {
  try {
    return buildProjection({ name: 'p', ...structuredClone(params) } as never)
  } catch {
    return null
  }
}

/* ---- comparison ------------------------------------------------------------------------------ */

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
    out[`path#${i}`] = exact(() => probe.path(g, {}))
    if (!drawsPoints(g)) out[`path-full#${i}`] = exact(() => probe.path(g, { digits: null }))
    out[`path-r#${i}`] = exact(() => probe.path(g, { radius: 3.25 }))
    out[`path-rfn#${i}`] = exact(() => probe.path(g, { radius: radiusFn }))
    out[`planar#${i}`] = probe.planar(g)
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
  const s = (v: unknown) => { const t = JSON.stringify(v); return t === undefined ? 'undefined' : t.length > 400 ? t.slice(0, 400) + '...' : t }
  return `${at}: vega ${s(want)} vs aster ${s(got)}`
}

async function compareProjection(params: Record<string, Json>, r: Rand, label: string, shapesN: number): Promise<void> {
  const theirs = await viaVega(params)
  const ours = viaAster(params)
  if (theirs === null || ours === null) {
    expect(ours === null, `${label}: builds in ${theirs === null ? 'neither' : 'vega only'} ${JSON.stringify(params)}`).toBe(theirs === null)
    return
  }
  const points = probePoints(r, 8)
  const pixels = Array.from({ length: 5 }, () => [r.range(-200, 800), r.range(-200, 600)])
  const shapes = Array.from({ length: shapesN }, () => geoObject(r))
  const want = enc(observe(d3Probe(theirs), points, pixels, shapes))
  const got = enc(observe(asterProbe(ours), points, pixels, shapes))
  const d = firstDiff(want, got)
  if (d) throw new Error(`${label} ${JSON.stringify(params)}\n  ${d}\n  shapes ${JSON.stringify(shapes)}`)
}

/* ---- the differentials --------------------------------------------------------------------- */

describe(`generated geo differential vs vega@${vega.version} / d3-geo@3.1.1 (live)`, () => {
  for (const type of PROJECTION_TYPES) {
    it(`${type}: random parameters, points, inversion, paths and planar measures`, async () => {
      const r = new Rand(seedOf(type, 1))
      const failures: string[] = []
      for (let i = 0; i < CASES.configs; i++) {
        await compareProjection(projectionParams(r, type), r, `${type}#${i}`, CASES.shapes).catch((e: Error) => failures.push(e.message))
      }
      expect(failures.length, `${failures.length} of ${CASES.configs} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
    })
    it(`${type}: fit / fitSize / fitExtent against generated data`, async () => {
      const r = new Rand(seedOf(type, 2))
      const failures: string[] = []
      for (let i = 0; i < CASES.fits; i++) {
        await compareProjection(projectionParams(r, type, { fit: true }), r, `${type}-fit#${i}`, 3).catch((e: Error) => failures.push(e.message))
      }
      expect(failures.length, `${failures.length} of ${CASES.fits} differ; first:\n${failures.slice(0, 3).join('\n')}`).toBe(0)
    })
  }

  it('fitWidth / fitHeight on the built projections', async () => {
    for (const type of PROJECTION_TYPES) {
      const r = new Rand(seedOf(type, 3))
      for (let i = 0; i < 6; i++) {
        const params = projectionParams(r, type)
        const theirs = await viaVega(params)
        const ours = viaAster(params)
        if (theirs === null || ours === null) continue
        const data = geoObject(r)
        for (const fit of ['fitWidth', 'fitHeight'] as const) {
          const size = r.range(60, 700)
          const want = exact(() => { theirs[fit](size, data); return [theirs.scale(), theirs.translate(), theirs.clipExtent?.()] })
          const got = exact(() => { ours[fit](size, data); return [ours.scale(), ours.translate(), ours.clipExtent?.()] })
          expect(got, `${type}#${i} ${fit} ${JSON.stringify(data)}`).toEqual(want)
        }
      }
    }
  })

  it('spherical geoArea / geoBounds / geoCentroid over generated shapes', () => {
    const r = new Rand(seedOf('sphere', 4))
    for (let i = 0; i < CASES.sphere; i++) {
      const g = geoObject(r)
      for (const [name, theirs, ours] of [['geoArea', d3Geo.geoArea, asterGeo.geoArea], ['geoBounds', d3Geo.geoBounds, asterGeo.geoBounds], ['geoCentroid', d3Geo.geoCentroid, asterGeo.geoCentroid]] as const) {
        const want = exact(() => (theirs as Any)(structuredClone(g)))
        const got = exact(() => (ours as Any)(structuredClone(g)))
        const d = firstDiff(want, got)
        if (d) throw new Error(`${name}#${i} ${JSON.stringify(g)}\n  ${d}`)
      }
    }
  })

  it('the geo expression-level entry points agree on hostile objects', () => {
    const odd = [null, undefined, {}, [], 'x', 5, { type: 'Feature' }, { type: 'Feature', geometry: null }, { type: 'FeatureCollection', features: [] }, { type: 'Polygon', coordinates: [] }, { type: 'Point', coordinates: [] }, { type: 'LineString', coordinates: [[0, 0]] }, { type: 'constructor' }, { type: '__proto__' }]
    for (const g of odd) {
      for (const [theirs, ours] of [[d3Geo.geoArea, asterGeo.geoArea], [d3Geo.geoBounds, asterGeo.geoBounds], [d3Geo.geoCentroid, asterGeo.geoCentroid]] as const) {
        expect(exact(() => (ours as Any)(structuredClone(g))), JSON.stringify(g)).toEqual(exact(() => (theirs as Any)(structuredClone(g))))
      }
    }
  })

  it('keeps its generated volume (coverage floor)', () => {
    expect(CASES.configs).toBeGreaterThanOrEqual(36)
    expect(CASES.fits).toBeGreaterThanOrEqual(14)
    expect(CASES.sphere).toBeGreaterThanOrEqual(600)
    expect(CASES.specs).toBeGreaterThanOrEqual(90)
    expect(PROJECTION_TYPES.length).toBe(17)
  })
})

/* ---- whole specs: geoshape, geopath, geopoint, graticule ------------------------------------- */

describe('generated whole specs vs vega (live)', () => {
  /**
   * Specs on which real Vega itself reports an error (its path parser refuses a `NaN` coordinate that a degenerate clip produced,
   * its d3 stream throws on an empty ring) are not comparable: what a view does after an error is the runtime's business, not the
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
      const got = renderSpec(structuredClone(spec) as never) as string
      const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))
      expect(d, d.slice(0, 3).join('\n') + '\n' + JSON.stringify(spec)).toEqual([])
    })
  }
  it('compares most of the generated specs (the ones vega refuses stay few)', () => {
    expect(refusedByVega.length, `vega refused specs ${refusedByVega.join(',')}`).toBeLessThanOrEqual(Math.floor(CASES.specs / 4))
  })
})
