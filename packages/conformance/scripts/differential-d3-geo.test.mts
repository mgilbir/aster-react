/**
 * LIVE differential for the projections, `geoPath` and contours (ADR-0001 suites formerly
 * recorded as `d3-geo.json`): the pinned `d3-geo` / `d3-contour` and Aster's ports
 * (`geo-projections.ts`, `contour.ts`) run the same op programs and grids (`d3-geo-cases.mjs`)
 * in ONE process and engine; every result (path strings, areas, bounds, centroids, projected
 * and inverted points, thrown errors with class and message) must be identical, bit for bit.
 * Nothing is recorded: the projections are trig heavy (sin/cos/atan2/asin) and those differ in
 * the last bit between V8 versions (see `differential-util.mts`).
 */
import { describe, expect, it } from 'vitest'
import * as d3Geo from 'd3-geo'
import * as d3Contour from 'd3-contour'
import * as geoPort from '../../core/src/geo-projections.ts'
import contoursPort from '../../core/src/contour.ts'
import { exact, withTz } from './differential-util.mts'
import { contourCases, geoPrograms, geoSamples } from './d3-geo-cases.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Op = [string, ...unknown[]]
type Api = Record<string, any>
const d3Api = d3Geo as unknown as Api
const asterApi = geoPort as unknown as Api

const FACTORIES: Record<string, string> = {
  albers: 'geoAlbers', albersUsa: 'geoAlbersUsa',
  azimuthalEqualArea: 'geoAzimuthalEqualArea', azimuthalEquidistant: 'geoAzimuthalEquidistant',
  conicConformal: 'geoConicConformal', conicEqualArea: 'geoConicEqualArea',
  conicEquidistant: 'geoConicEquidistant', equalEarth: 'geoEqualEarth',
  equirectangular: 'geoEquirectangular', gnomonic: 'geoGnomonic',
  mercator: 'geoMercator', naturalEarth1: 'geoNaturalEarth1',
  orthographic: 'geoOrthographic', stereographic: 'geoStereographic',
  transverseMercator: 'geoTransverseMercator',
}
/** Aster's port names them without the `geo` prefix. */
const asterName = (n: string) => n.charAt(3).toLowerCase() + n.slice(4)

/**
 * geoPath rounds path strings to 3 decimals by default, which hides a 1-ulp divergence (a planted
 * `* (1 + Number.EPSILON)` in the Mercator raw projection changed one point, not one path). So
 * every program also runs with `geoPath().digits(null)`, where the last bit is visible.
 */
const MODES: Array<{ label: string; digits: number | null | undefined }> = [
  { label: 'default digits', digits: undefined },
  { label: 'full precision', digits: null },
]

function runGeoOps(api: Api, theirs: boolean, type: string, ops: Op[], digits: number | null | undefined): unknown[] {
  const samples = structuredClone(geoSamples) as Record<string, unknown>
  const factory = FACTORIES[type]!
  const p: any = api[theirs ? factory : asterName(factory)]()
  const path = () => { const g = api.geoPath(p); return digits === undefined ? g : g.digits(digits) }
  return ops.map(([name, ...args]) =>
    exact(() => {
      switch (name) {
        case 'scale': p.scale(args[0]); return p.scale()
        case 'translate': p.translate(args[0]); return p.translate()
        case 'center': p.center(args[0]); return p.center()
        case 'rotate': p.rotate(args[0]); return p.rotate()
        case 'precision': p.precision(args[0]); return p.precision()
        case 'clipAngle': p.clipAngle(args[0]); return p.clipAngle()
        case 'parallels': p.parallels(args[0]); return p.parallels()
        case 'reflectX': p.reflectX(args[0]); return p.reflectX()
        case 'reflectY': p.reflectY(args[0]); return p.reflectY()
        case 'path': return path()(samples[args[0] as string])
        case 'area': return path().area(samples[args[0] as string])
        case 'bounds': return path().bounds(samples[args[0] as string])
        case 'centroid': return path().centroid(samples[args[0] as string])
        case 'measure': return path().measure(samples[args[0] as string])
        case 'call': return p(args[0])
        case 'invert': return p.invert ? p.invert(args[0]) : undefined
        default: throw new Error('unknown geo op ' + name)
      }
    }),
  )
}

type Contour = (typeof contourCases)[number]
const contourOf = (make: () => any, c: Contour) =>
  exact(() => make().smooth(c.smooth).size(c.size).thresholds(c.thresholds)(structuredClone(c.values)))

describe(`d3-geo ${(d3Geo as unknown as { version?: string }).version ?? '3.1.1'} vs Aster geo-projections.ts (live)`, () => {
  for (const m of MODES) {
    ;(geoPrograms as Array<{ type: string; ops: Op[] }>).forEach(({ type, ops }, i) => {
      it(`geo #${i} ${type} [${m.label}]`, () =>
        withTz('UTC', () => {
          const want = runGeoOps(d3Api, true, type, ops, m.digits)
          expect(runGeoOps(asterApi, false, type, ops, m.digits)).toEqual(want)
        }))
    })
  }

  contourCases.forEach((c: Contour, i: number) => {
    it(`contour #${i} ${c.grid} ${c.size} smooth=${c.smooth} t=${c.thresholds}`, () => {
      const want = contourOf(d3Contour.contours as () => any, c)
      expect(contourOf(contoursPort, c)).toEqual(want)
    })
  })

  it('keeps the recorded suite sizes (coverage floor)', () => {
    expect(geoPrograms.length).toBeGreaterThanOrEqual(18)
    expect(contourCases.length).toBeGreaterThanOrEqual(30)
  })
})
