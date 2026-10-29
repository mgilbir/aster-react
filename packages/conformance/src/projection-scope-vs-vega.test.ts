/**
 * Projections declared in a GROUP's scope, projection types vega 6.3.1 has not registered, and a mark's `clip` to a projection's
 * sphere, against real vega (strict canonicalizer, the error vega's logger got compared too).
 *
 *   - a group mark's `projections` are made per group item, in its scope: `type: {signal: "parent.data"}` is the item's datum;
 *   - a type that is not in vega-projection's registry (`airy` and the rest of d3-geo-projection's extended set, which vega does
 *     not ship) throws in the Projection transform, which stops the whole pass there: items before it are whole, the item and the
 *     ones after it keep their frame, nothing is laid out, and ONE error is logged. At the view's scope, nothing at all is made.
 *     The engine does the same -- it has no projection beyond vega's seventeen, so there is no superset to keep or to refuse;
 *   - `clip: {sphere}`, `{path}` and a `{signal}` that returns a shape clip a mark to a path.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { addonsNeeded } from '@aster/core/addons'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = { level: () => 2, error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(structuredClone(spec) as never), { renderer: 'none', logger },
  )
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}
function engine(spec: Spec): { svg: string; errors: string[] } {
  const errors: string[] = []
  const svg = renderSpec(structuredClone(spec) as never, { logger: { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} } as never })
  return { svg, errors }
}
async function same(spec: Spec): Promise<{ errors: string[] }> {
  const o = await oracle(spec)
  const a = engine(spec)
  expect(diffCanonical(canonicalizeSvg(o.svg), canonicalizeSvg(a.svg))).toEqual([])
  expect(a.errors).toEqual(o.errors)
  return { errors: o.errors }
}

const LAND = [
  { type: 'Polygon', coordinates: [[[-100, 20], [-60, 20], [-60, 60], [-100, 60], [-100, 20]]] },
  { type: 'Polygon', coordinates: [[[10, -30], [50, -30], [50, 10], [10, 10], [10, -30]]] },
  { type: 'Polygon', coordinates: [[[170, -10], [-170, -10], [-170, 20], [170, 20], [170, -10]]] },
  { type: 'Polygon', coordinates: [[[100, 30], [140, 30], [140, 60], [100, 60], [100, 30]]] },
]
const DATA = [
  { name: 'sphere', values: [{ type: 'Sphere' }] },
  { name: 'land', values: LAND },
  { name: 'graticule', transform: [{ type: 'graticule', step: [30, 30] }] },
]
const shapes = (clip: unknown = false, label = false): unknown[] => [
  { type: 'shape', from: { data: 'sphere' }, encode: { enter: { fill: { value: 'aliceblue' } } }, transform: [{ type: 'geoshape', projection: 'projection' }] },
  { type: 'shape', from: { data: 'graticule' }, clip, encode: { enter: { stroke: { value: '#ddd' } } }, transform: [{ type: 'geoshape', projection: 'projection' }] },
  { type: 'shape', from: { data: 'land' }, clip, encode: { enter: { stroke: { value: '#888' }, fill: { value: 'black' } } }, transform: [{ type: 'geoshape', projection: 'projection' }] },
  ...(label ? [{ type: 'text', encode: { enter: { x: { value: 5 }, y: { value: 95 }, text: { signal: 'parent.data' }, fill: { value: 'black' } } } }] : []),
]
/** One group item per type, each with its own projection: the cell layout is the view's `layout`. */
const cells = (types: string[], clip: unknown = false, extra: Spec = {}): Spec => ({
  autosize: 'pad',
  signals: [{ name: 'scale0', value: 38 }],
  data: [{ name: 'types', values: types }, ...DATA],
  layout: { columns: 3, padding: 10 },
  marks: [{
    type: 'group', from: { data: 'types' },
    signals: [{ name: 'width', update: '200' }, { name: 'height', update: '100' }],
    encode: { enter: { width: { signal: '200' }, height: { signal: '100' }, clip: { value: true } } },
    projections: [{ name: 'projection', type: { signal: 'parent.data' }, scale: { signal: 'scale0' }, translate: [100, 50] }],
    marks: shapes(clip, true),
  }],
  ...extra,
})

/** vega-projection's registry (its `projection(type)` lower-cases the name). */
const VEGA_TYPES = ['albers', 'albersUsa', 'azimuthalEqualArea', 'azimuthalEquidistant', 'conicConformal', 'conicEqualArea', 'conicEquidistant', 'equalEarth', 'equirectangular', 'gnomonic', 'identity', 'mercator', 'mollweide', 'naturalEarth1', 'orthographic', 'stereographic', 'transverseMercator']
/** (a Sphere through `identity` is not drawable in d3-geo: its stream has no sphere; vega's own SVG serializer throws on it, so does the engine) */
const SPHERE_TYPES = VEGA_TYPES.filter((t) => t !== 'identity')
/** d3-geo-projection's, which vega does not register (vega.github.io/vega/examples/projections only works with vega-projection-extended). */
const EXTENDED = ['airy', 'aitoff', 'armadillo', 'august', 'baker', 'berghaus', 'bertin1953', 'boggs', 'bonne', 'bottomley', 'bromley', 'collignon', 'craig', 'craster', 'cylindricalEqualArea', 'cylindricalStereographic', 'eckert1', 'eckert2', 'eckert3', 'eckert4', 'eckert5', 'eckert6', 'eisenlohr', 'fahey', 'foucaut', 'foucautSinusoidal', 'gilbert', 'gingery', 'ginzburg4', 'ginzburg5', 'ginzburg6', 'ginzburg8', 'ginzburg9', 'gringorten', 'guyou', 'hammer', 'hammerRetroazimuthal', 'healpix', 'hill', 'homolosine', 'hufnagel', 'hyperelliptical', 'interrupt', 'interruptedHomolosine', 'interruptedMollweide', 'interruptedMollweideHemispheres', 'interruptedSinuMollweide', 'interruptedSinusoidal', 'kavrayskiy7', 'lagrange', 'larrivee', 'laskowski', 'littrow', 'loximuthal', 'miller', 'modifiedStereographic', 'mtFlatPolarParabolic', 'mtFlatPolarQuartic', 'mtFlatPolarSinusoidal', 'naturalEarth2', 'nellHammer', 'nicolosi', 'patterson', 'peirceQuincuncial', 'polyconic', 'polyhedralButterfly', 'polyhedralCollignon', 'polyhedralWaterman', 'rectangularPolyconic', 'robinson', 'satellite', 'sinuMollweide', 'sinusoidal', 'times', 'twoPointAzimuthal', 'twoPointEquidistant', 'vanDerGrinten', 'vanDerGrinten2', 'vanDerGrinten3', 'vanDerGrinten4', 'wagner', 'wagner4', 'wagner6', 'wagner7', 'wiechel', 'winkel3']

describe('the projection types are exactly vega-projection\'s', () => {
  it('vega knows the seventeen, in any case, and none of the extended set', () => {
    for (const t of [...VEGA_TYPES, ...VEGA_TYPES.map((x) => x.toUpperCase())]) expect((vega.projection as (type: string) => unknown)(t), t).not.toBeNull()
    for (const t of EXTENDED) expect((vega.projection as (type: string) => unknown)(t), t).toBeNull()
  })
  it('the engine makes the same ones, and refuses the rest with the same error', async () => {
    const probe = (type: string): Spec => ({ width: 40, height: 40, projections: [{ name: 'p', type }], data: [{ name: 'g', values: [{ type: 'Sphere' }] }], marks: [{ type: 'shape', from: { data: 'g' }, transform: [{ type: 'geoshape', projection: 'p' }] }] })
    for (const t of [...SPHERE_TYPES, 'MERCATOR', 'Albers']) {
      const o = await oracle(probe(t))
      expect(engine(probe(t)).errors, t).toEqual(o.errors)
    }
    for (const t of EXTENDED) expect(engine(probe(t)).errors, t).toEqual([`Error: Unrecognized projection type: ${t}`])
  })
})

describe('group-scoped projections, one per item', () => {
  it('every type vega registers, per item', async () => {
    const r = await same(cells(SPHERE_TYPES))
    expect(r.errors).toEqual([])
  })
  it('identity (pixel space), where no sphere is drawn', async () => {
    const spec = cells(['identity', 'mercator'])
    ;((spec.data as Array<{ name: string; values?: unknown }>).find((d) => d.name === 'sphere') as { values: unknown }).values = []
    await same(spec)
  })
  it('scale / translate / center / rotate / parallels / clipAngle as signals of the scope', async () => {
    await same(cells(['orthographic', 'albers', 'conicConformal', 'azimuthalEqualArea'], false, {
      signals: [{ name: 'scale0', value: 50 }],
    }))
  })
  it('the type is a default (mercator) when the signal holds nothing', async () => {
    await same(cells(['', 'mercator']))
  })
  it('a projection of the group is not the view\'s of the same name', async () => {
    const spec = cells(['gnomonic', 'mercator'], false, { projections: [{ name: 'projection', type: 'orthographic', scale: 30, translate: [100, 50] }] })
    await same(spec)
  })
  it('the comparison draws something', () => {
    const svg = engine(cells(['mercator', 'orthographic'])).svg
    expect((svg.match(/<path[^>]*stroke="#888"/g) ?? []).length).toBeGreaterThan(2)
  })
})

describe('a type vega has not registered stops the pass', () => {
  const at = (n: number): string[] => VEGA_TYPES.slice(0, 6).map((t, i) => (i === n ? 'airy' : t))
  for (const n of [0, 2, 5]) {
    it(`the unknown type is item ${n} of 6: whole before it, a frame from it, nothing laid out, one error`, async () => {
      const r = await same(cells(at(n)))
      expect(r.errors).toEqual(['Error: Unrecognized projection type: airy'])
    })
  }
  it('several unknown types: the first one is the error', async () => {
    const r = await same(cells(['mercator', 'robinson', 'airy', 'gnomonic']))
    expect(r.errors).toEqual(['Error: Unrecognized projection type: robinson'])
  })
  it('an unknown type at the view\'s scope: no dataset, scale or mark is made', async () => {
    const spec: Spec = { width: 200, height: 100, padding: 5, data: DATA, projections: [{ name: 'projection', type: 'airy', scale: 40, translate: [100, 50] }], marks: shapes() }
    const r = await same(spec)
    expect(r.errors).toEqual(['Error: Unrecognized projection type: airy'])
  })
  it('an unknown type given by a signal, at the view\'s scope', async () => {
    const spec: Spec = { width: 200, height: 100, padding: 5, signals: [{ name: 'kind', value: 'wagner6' }], data: DATA, projections: [{ name: 'projection', type: { signal: 'kind' }, scale: 40, translate: [100, 50] }], marks: shapes() }
    const r = await same(spec)
    expect(r.errors).toEqual(['Error: Unrecognized projection type: wagner6'])
  })
  it('the add-on detector sees a group\'s projections', () => {
    expect(addonsNeeded(cells(['mercator']) as never)).toContain('geo')
  })
})

describe('a mark\'s clip', () => {
  const view = (clip: unknown): Spec => ({ width: 200, height: 100, padding: 5, data: DATA, projections: [{ name: 'projection', type: 'orthographic', scale: 45, translate: [100, 50] }], marks: shapes(clip) })
  for (const [name, clip] of [
    ['true', true], ['false', false],
    ['the sphere of a projection', { sphere: 'projection' }],
    ['the sphere of a projection named by a signal', { sphere: { signal: '"projection"' } }],
    ['a path', { path: 'M10,10L150,20L90,90Z' }],
    ['a path from a signal', { path: { signal: '"M20,20h100v50h-100Z"' } }],
    ['a signal that is a shape (geoShape)', { signal: "geoShape('projection', {type: 'Sphere'})" }],
    ['a signal that is a shape (pathShape)', { signal: "pathShape('M0,0L100,0L100,100Z')" }],
    ['a signal that is true', { signal: '1 < 2' }],
    ['a signal that is false', { signal: '1 > 2' }],
  ] as Array<[string, unknown]>) {
    it(name, async () => { await same(view(clip)) })
  }
  it('the sphere clip is a path, not the frame', () => {
    expect(engine(view({ sphere: 'projection' })).svg).toMatch(/<clipPath id="clip\w+"><path d="M[^"]{40,}"\/><\/clipPath>/)
  })
})
