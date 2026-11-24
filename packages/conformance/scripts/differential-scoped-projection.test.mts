/**
 * GENERATED live differential of a group's own datasets using projections (C151): a group mark's (or a facet's) `data` runs
 * `geopoint`, `geopath` or `geoshape` through a projection the group declares, one the view declares, or one the group declares
 * under the name of the view's (the group's wins), and its marks draw the result. Real Vega and Aster render the same SVG.
 */
import * as vega from 'vega'
import { describe, expect, it } from 'vitest'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import '../../core/src/addon-transforms.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'
import { quietLogger } from './differential-util.mts'

function projection(r: Rng): Record<string, unknown> {
  return { name: 'q', type: r.pick(['mercator', 'equirectangular', 'orthographic', 'albers']), scale: r.between(40, 140), translate: [r.between(50, 250), r.between(50, 150)], ...(r.chance(0.3) ? { rotate: [r.between(-60, 60), 0, 0] } : {}) }
}

function genSpec(r: Rng): Record<string, unknown> {
  const rows = Array.from({ length: r.between(1, 4) }, (_, i) => {
    const lon = r.between(-60, 60)
    const lat = r.between(-40, 50)
    return { k: i % 2, lon, lat, type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 10, lat], [lon + 10, lat + 8], [lon, lat + 8], [lon, lat]]] } }
  })
  const where = r.pick(['group', 'view', 'both'])
  const kind = r.pick(['geopoint', 'geopath', 'geoshape'])
  const transform = kind === 'geopoint' ? { type: 'geopoint', projection: 'q', fields: ['lon', 'lat'] } : { type: kind, projection: 'q' }
  const facet = r.chance(0.4)
  const marks = kind === 'geopoint'
    ? [{ type: 'symbol', from: { data: 'pp' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' } } } }]
    : kind === 'geopath'
      ? [{ type: 'path', from: { data: 'pp' }, encode: { update: { path: { field: 'path' }, stroke: { value: 'red' } } } }]
      : [{ type: 'shape', from: { data: 'pp' }, encode: { update: { shape: { field: 'shape' }, stroke: { value: 'red' } } } }]
  const group: Record<string, unknown> = {
    type: 'group',
    ...(facet ? { from: { facet: { name: 'f', data: 't', groupby: 'k' } } } : {}),
    encode: { update: { width: { value: 300 }, height: { value: 200 } } },
    ...(where !== 'view' ? { projections: [projection(r)] } : {}),
    data: [{ name: 'pp', source: facet ? 'f' : 't', transform: [transform] }],
    marks,
  }
  return {
    width: 300, height: 200, autosize: 'none',
    ...(where !== 'group' ? { projections: [projection(r)] } : {}),
    data: [{ name: 't', values: rows }], marks: [group],
  }
}

async function viaVega(spec: unknown): Promise<string> {
  const errors: unknown[][] = []
  const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
  await view.runAsync()
  if (errors.length) throw new Error(String(errors[0]))
  return view.toSVG()
}

describe(`a group's datasets through projections vs vega@${vega.version} (generated, live)`, () => {
  it('draw the same as vega, the group\'s own projection first', async () => {
    const r = makeRng(0x151)
    const count = scaled(150)
    let scoped = 0
    for (let i = 0; i < count; i++) {
      const spec = genSpec(r)
      if ((spec.marks as Array<{ projections?: unknown }>)[0]!.projections) scoped++
      const want = await viaVega(spec)
      const errors: string[] = []
      const got = renderSpec(structuredClone(spec) as never, { logger: { error: (e: unknown) => errors.push(String((e as Error)?.message ?? e)), warn() {}, info() {}, debug() {} } })
      expect(errors, JSON.stringify(spec)).toEqual([])
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got)), JSON.stringify(spec)).toEqual([])
    }
    expect(scoped).toBeGreaterThan(count * 0.5)
  })
})
