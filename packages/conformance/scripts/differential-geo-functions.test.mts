/**
 * LIVE differential for the geo functions of the expression language (vega-functions geo.js): `geoArea`, `geoBounds`,
 * `geoCentroid` through a named projection's path (pixel coordinates) or with no projection (the sphere), and
 * `geoScale`. Real vega evaluates each as a signal expression over a spec with the projections; Aster runs
 * `compileExpr` over the same projections built by the geo addon. Strict `exact` comparison.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '../../core/src/addon-geo.ts'
import { compileExpr, type ExpressionRuntime } from '../../core/src/expression.ts'
import { geoRegistry } from '../../core/src/registry.ts'
import { exact, quietLogger } from './differential-util.mts'
import { Rand, seedOf, withoutEmptyRings } from './geo-gen.mts'

const PROJECTIONS = [
  { name: 'merc', type: 'mercator', scale: 100, translate: [200, 150] },
  { name: 'albers', type: 'albersUsa', scale: 600, translate: [300, 200] },
  { name: 'ortho', type: 'orthographic', scale: 120, translate: [150, 150], rotate: [-20, -30, 0], clipAngle: 90 },
  { name: 'eq', type: 'equalEarth', scale: 80, translate: [100, 80], center: [10, 20] },
]
const projections = new Map<string, unknown>()
for (const p of PROJECTIONS) projections.set(p.name, geoRegistry.buildProjection!({ ...p } as never))
const runtime: ExpressionRuntime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
  projection: (name) => projections.get(name),
}

const NAMES = ['a', 'b'] as const
async function viaVega(code: string, args: unknown[]): Promise<unknown> {
  const errors: unknown[][] = []
  const view = new vega.View(
    vega.parse({ projections: PROJECTIONS, signals: [...NAMES.map((name) => ({ name, value: null })), { name: 'out', update: code }] } as never),
    { logger: quietLogger(errors) as never },
  )
  args.forEach((v, i) => view.signal(NAMES[i]!, v))
  await view.runAsync()
  return errors.length ? { $: 'throw' } : exact(() => view.signal('out'))
}
function viaAster(code: string, args: unknown[]): unknown {
  const params: Record<string, unknown> = {}
  args.forEach((v, i) => { params[NAMES[i]!] = v })
  const got = exact(() => compileExpr(code, runtime)(undefined, params)) as { $?: string } | null
  return got?.$ === 'throw' ? { $: 'throw' } : got
}

const poly = (ring: number[][]) => ({ type: 'Polygon', coordinates: [ring] })
const GEO: unknown[] = [
  { type: 'Point', coordinates: [-100, 40] },
  { type: 'MultiPoint', coordinates: [[-100, 40], [10, 50], [120, -30]] },
  { type: 'LineString', coordinates: [[-120, 30], [-80, 45], [-70, 20]] },
  poly([[-110, 30], [-90, 30], [-90, 45], [-110, 45], [-110, 30]]),
  { type: 'Feature', properties: {}, geometry: poly([[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]) },
  { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [5, 5] } },
    { type: 'Feature', properties: {}, geometry: poly([[100, -10], [120, -10], [120, 10], [100, 10], [100, -10]]) },
  ] },
  { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [10, 10]] }] },
  { type: 'Sphere' },
  // empty rings: vega's measure of one (through no projection) depends on what its d3 measured before, so the oracle is asked about the
  // shape without them (docs/ARCHITECTURE.md, Deviations from Vega); through a projection d3's clip throws, and so does Aster's
  { type: 'Polygon', coordinates: [[]] },
  { type: 'MultiPolygon', coordinates: [[[]], poly([[0, 50], [10, 50], [10, 60], [0, 60], [0, 50]]).coordinates[0]!].map((p, i) => (i === 0 ? p : [p])) },
  poly([[0, 0]]),
  { type: 'MultiPolygon', coordinates: [poly([[170, 10], [-170, 10], [-170, 20], [170, 20], [170, 10]]).coordinates, poly([[0, 50], [10, 50], [10, 60], [0, 60], [0, 50]]).coordinates] },
  null, undefined, {}, 'x', 5, [],
]

describe('geo expression functions vs real vega (live)', () => {
  for (const fn of ['geoArea', 'geoBounds', 'geoCentroid']) {
    it(`${fn}(projection, geojson) and ${fn}(null, geojson)`, async () => {
      for (const g of GEO) {
        for (const proj of [null, undefined, '', ...PROJECTIONS.map((p) => p.name), 'nope']) {
          const code = `${fn}(a, b)`
          // (no projection: the sphere's measures, where an empty ring adds nothing in Aster; a name is looked up as vega looks it up)
          const sphere = typeof proj !== 'string' || !PROJECTIONS.some((p) => p.name === proj)
          expect(viaAster(code, [proj, g]), `${fn} ${String(proj)} ${JSON.stringify(g)}`).toEqual(await viaVega(code, [proj, sphere ? withoutEmptyRings(g) : g]))
        }
      }
    })
  }
  // vega keeps projections among its scales: `scale('p', [lon, lat])` projects, `invert('p', [x, y])` unprojects
  it.each(['scale', 'invert'])('%s(projection, position) over generated and malformed positions', async (fn) => {
    const r = new Rand(seedOf(fn, 8))
    const positions: unknown[] = [
      ...Array.from({ length: 12 }, () => [r.range(-200, 200), r.range(-100, 100)]),
      ...Array.from({ length: 12 }, () => [r.range(-100, 600), r.range(-100, 400)]),
      [0, 0], [180, 90], [-180, -90], [1e-9, -1e-9], [-96, 38], [-150, 62], [-157, 20], [NaN, 1], [1, NaN], [Infinity, 0],
      [], [1], ['10', '20'], [null, null], 'ab', 5, null, undefined,
    ]
    for (const proj of [...PROJECTIONS.map((p) => p.name), 'nope']) {
      for (const pos of positions) {
        const code = `${fn}(a, b)`
        expect(viaAster(code, [proj, pos]), `${fn} ${proj} ${JSON.stringify(pos)}`).toEqual(await viaVega(code, [proj, pos]))
      }
    }
  })
  // vega's `copy(projection)` is a copy of the projection that every function taking a projection takes in place of its name (C291;
  // the zoomable world map drags with `invert(copy('projection'), xy())`)
  it('a copy of a projection stands for it in scale, invert, range, bandwidth, copy and the geo functions', async () => {
    const uses = [
      "scale(copy(a), [-100, 40])", "invert(copy(a), [120, 80])", "range(copy(a))", "bandwidth(copy(a))", "geoScale(copy(a))",
      "geoArea(copy(a), b)", "geoBounds(copy(a), b)", "geoCentroid(copy(a), b)", "invert(copy(copy(a)), [10, 20])",
      "copy(a) ? 1 : 0", "copy(a) === copy(a)", "isObject(copy(a))", "isValid(copy(a))", "isArray(copy(a))",
    ]
    let compared = 0
    for (const code of uses) {
      for (const proj of [...PROJECTIONS.map((p) => p.name), 'nope']) {
        for (const g of GEO.slice(0, 5)) {
          const want = await viaVega(code, [proj, g])
          expect(viaAster(code, [proj, g]), `${code} ${proj} ${JSON.stringify(g)}`).toEqual(want)
          if (want !== null && (want as { $?: string }).$ !== 'throw') compared++
        }
      }
    }
    expect(compared).toBeGreaterThan(200)
  })

  it('geoScale(projection)', async () => {
    for (const proj of [...PROJECTIONS.map((p) => p.name), 'nope', null, undefined]) {
      expect(viaAster('geoScale(a)', [proj]), `geoScale ${String(proj)}`).toEqual(await viaVega('geoScale(a)', [proj]))
    }
  })
})
