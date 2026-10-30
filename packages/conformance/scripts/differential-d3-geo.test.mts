/**
 * LIVE differential for the projections, `geoPath` and contours (ADR-0001 suites formerly
 * recorded as `d3-geo.json`): the pinned `d3-geo` / `d3-contour` and Aster's engines
 * (`geo-projections.ts`, `contour.ts`) run the same op programs and grids (`d3-geo-cases.mjs`)
 * in ONE process and engine; every result (path strings, areas, bounds, centroids, projected
 * and inverted points, thrown errors with class and message) must be identical, bit for bit.
 * Nothing is recorded: the projections are trig heavy (sin/cos/atan2/asin) and those differ in
 * the last bit between V8 versions (see `differential-util.mts`).
 */
import { describe, expect, it } from 'vitest'
import * as d3Geo from 'd3-geo'
import * as d3Contour from 'd3-contour'
import * as vega from 'vega'
import * as geoPort from '../../core/src/geo-projections.ts'
import { GeoPath } from '../../core/src/geo-path.ts'
import { contourPolygons } from '../../core/src/contour.ts'
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

/** The ops of a program, run on d3-geo's getter/setter projection. */
function runD3Ops(type: string, ops: Op[], digits: number | null | undefined): unknown[] {
  const samples = structuredClone(geoSamples) as Record<string, unknown>
  const p: any = d3Api[FACTORIES[type]!]()
  const path = () => { const g = d3Api.geoPath(p); return digits === undefined ? g : g.digits(digits) }
  return ops.map(([name, ...args]) =>
    exact(() => {
      switch (name) {
        case 'scale': case 'translate': case 'center': case 'rotate': case 'precision': case 'clipAngle':
        case 'parallels': case 'reflectX': case 'reflectY':
          p[name](args[0])
          return p[name]()
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

/**
 * The same ops on Aster's projection: a setter is `configure` with that one property (a projection lacking the property
 * leaves it alone, as vega's Projection transform does), and the getter is the property of the same name.
 */
function runAsterOps(type: string, ops: Op[], digits: number | null | undefined): unknown[] {
  const samples = structuredClone(geoSamples) as Record<string, unknown>
  const p: any = asterApi[asterName(FACTORIES[type]!)]()
  const path = () => { const g = new GeoPath(p); if (digits !== undefined) g.digits = digits; return g }
  return ops.map(([name, ...args]) =>
    exact(() => {
      switch (name) {
        case 'scale': case 'translate': case 'center': case 'rotate': case 'precision': case 'clipAngle':
        case 'parallels': case 'reflectX': case 'reflectY':
          if (!(name in p)) throw new TypeError(`p.${name} is not a function`)
          p.configure({ [name]: args[0] })
          return p[name]
        case 'path': return path().draw(samples[args[0] as string])
        case 'area': return path().area(samples[args[0] as string])
        case 'bounds': return path().bounds(samples[args[0] as string])
        case 'centroid': return path().centroid(samples[args[0] as string])
        case 'measure': return path().measure(samples[args[0] as string])
        case 'call': return p.project(args[0][0], args[0][1])
        case 'invert': return p.invert ? p.invert(args[0][0], args[0][1]) : undefined
        default: throw new Error('unknown geo op ' + name)
      }
    }),
  )
}

type Contour = (typeof contourCases)[number]
const contourOf = (make: () => any, c: Contour) =>
  exact(() => make().smooth(c.smooth).size(c.size).thresholds(c.thresholds)(structuredClone(c.values)))
const portContourOf = (c: Contour) => exact(() => contourPolygons(structuredClone(c.values), c.thresholds, c.size, c.smooth))

/**
 * The oracle of record for contours: vega's own `contour` transform over the grid. It is not d3-contour: vega-geo carries an
 * older marching squares, which smooths a point between a missing cell (NaN) or equal cells (a flat grid) into a NaN or
 * infinite coordinate where d3-contour 4 falls back to the grid line. Aster follows vega, so every case is judged against
 * vega, and against d3-contour wherever the two agree (a grid of finite, distinct neighbours, or no smoothing).
 */
async function vegaContourOf(c: Contour): Promise<unknown> {
  const spec = { data: [{ name: 'src', values: [{ a: 1 }], transform: [{ type: 'contour', size: c.size, values: structuredClone(c.values), thresholds: c.thresholds, smooth: c.smooth }] }] }
  const view = new vega.View(vega.parse(spec as vega.Spec), { renderer: 'none', logLevel: vega.None })
  await view.runAsync()
  return exact(() => (view.data('src') as Array<{ type: string; value: number; coordinates: unknown }>).map(({ type, value, coordinates }) => ({ type, value, coordinates })))
}

describe(`d3-geo ${(d3Geo as unknown as { version?: string }).version ?? '3.1.1'} vs Aster geo-projections.ts (live)`, () => {
  for (const m of MODES) {
    ;(geoPrograms as Array<{ type: string; ops: Op[] }>).forEach(({ type, ops }, i) => {
      it(`geo #${i} ${type} [${m.label}]`, () =>
        withTz('UTC', () => {
          const want = runD3Ops(type, ops, m.digits)
          expect(runAsterOps(type, ops, m.digits)).toEqual(want)
        }))
    })
  }

  contourCases.forEach((c: Contour, i: number) => {
    it(`contour #${i} ${c.grid} ${c.size} smooth=${c.smooth} t=${c.thresholds}`, async () => {
      expect(portContourOf(c)).toEqual(await vegaContourOf(c))
      if (c.grid === 'peak' || !c.smooth) expect(portContourOf(c)).toEqual(contourOf(d3Contour.contours as () => any, c))
    })
  })

  it('keeps the recorded suite sizes (coverage floor)', () => {
    expect(geoPrograms.length).toBeGreaterThanOrEqual(18)
    expect(contourCases.length).toBeGreaterThanOrEqual(30)
  })
})
