// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { compileFrozen } from './helpers.js'

const FEATURES = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { v: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } }] }
const geoData = { values: FEATURES, format: { property: 'features' } }
const pts = { values: [{ lon: 1, lat: 2, lon2: 3, lat2: 4, n: 5 }] }
const lon = { field: 'lon', type: 'quantitative' }
const lat = { field: 'lat', type: 'quantitative' }

/** The transforms of a compiled spec, in dataset order. */
const transforms = (vg: any): any[] => vg.data.flatMap((d: any) => d.transform ?? [])
const find = (vg: any, type: string): any[] => transforms(vg).filter((t) => t.type === type)

describe('maps: a unit with a geoshape mark', () => {
  const vg = compileFrozen({ width: 300, height: 200, data: geoData, projection: { type: 'mercator' }, mark: 'geoshape' })

  it('fits the projection to the unit data and draws the shape through it', () => {
    expect(vg.projections).toEqual([{ name: 'projection', size: { signal: '[width, height]' }, fit: { signal: "data('source_0')" }, type: 'mercator' }])
    expect(vg.marks[0]).toMatchObject({ type: 'shape', style: ['geoshape'], transform: [{ type: 'geoshape', projection: 'projection' }] })
    expect(vg.marks[0].clip).toBeUndefined()
    expect(vg.style).toBe('view')
  })

  it('defaults the type to equalEarth, and takes config.projection under the unit projection', () => {
    expect(compileFrozen({ data: geoData, projection: {}, mark: 'geoshape' }).projections[0].type).toBe('equalEarth')
    const vg2 = compileFrozen({ data: geoData, config: { projection: { type: 'orthographic', rotate: [1, 2, 0] } }, projection: { type: 'stereographic' }, mark: 'geoshape' })
    expect(vg2.projections[0]).toMatchObject({ type: 'stereographic', rotate: [1, 2, 0] })
  })

  it('an explicit scale or translate turns the fit off and clips the mark', () => {
    for (const projection of [{ scale: 100 }, { translate: [10, 20] }, { scale: 0, type: 'mercator' }]) {
      const v = compileFrozen({ data: geoData, projection, mark: 'geoshape' })
      expect(v.projections[0]).toMatchObject({ translate: { signal: '[width / 2, height / 2]' }, ...projection })
      expect(v.projections[0].fit).toBeUndefined()
      expect(v.projections[0].size).toBeUndefined()
      expect(v.marks[0].clip).toBe(true)
    }
    // ...the author's translate wins over the centring default
    expect(compileFrozen({ data: geoData, projection: { translate: [10, 20] }, mark: 'geoshape' }).projections[0].translate).toEqual([10, 20])
  })

  it('expression references become signals', () => {
    const v = compileFrozen({ params: [{ name: 'k', value: 2 }], data: geoData, projection: { scale: { expr: 'k * 10' } }, mark: 'geoshape' })
    expect(v.projections[0].scale).toEqual({ signal: 'k * 10' })
  })

  it('a geojson shape field is filtered, consolidated for the fit, and read off the item', () => {
    const v = compileFrozen({
      data: { values: [{ g: FEATURES.features[0]!.geometry }] },
      projection: { type: 'mercator' },
      mark: 'geoshape',
      encoding: { shape: { field: 'g', type: 'geojson' } },
    })
    const ts = transforms(v)
    expect(ts[0]).toEqual({ type: 'filter', expr: 'isValid(datum["g"])' })
    expect(ts[1]).toEqual({ type: 'geojson', geojson: 'g', signal: 'geojson_0' })
    expect(v.projections[0].fit).toEqual({ signal: 'geojson_0' })
    expect(v.marks[0].transform).toEqual([{ type: 'geoshape', projection: 'projection', field: 'datum["g"]' }])
    expect(v.scales ?? []).toEqual([])
    expect(v.legends).toBeUndefined()
  })

  it('a graticule or sphere is a data generator; a graticule is not filled', () => {
    const sphere = compileFrozen({ data: { sphere: true }, projection: {}, mark: 'geoshape' })
    expect(sphere.data[0]).toEqual({ name: 'source_0', values: [{ type: 'Sphere' }] })
    const grat = compileFrozen({ data: { graticule: { step: [10, 10] } }, projection: {}, mark: 'geoshape' })
    expect(grat.data[0]).toEqual({ name: 'source_0', transform: [{ type: 'graticule', step: [10, 10] }] })
    expect(grat.marks[0].encode.update.fill).toEqual({ value: 'transparent' })
    expect(grat.marks[0].encode.update.stroke).toEqual({ value: '#4c78a8' })
    expect(compileFrozen({ data: { graticule: true }, projection: {}, mark: { type: 'geoshape', filled: true } }).marks[0].encode.update.fill).toEqual({ value: '#4c78a8' })
  })

  it('a topojson format passes through', () => {
    const v = compileFrozen({ data: { values: { type: 'Topology', objects: {}, arcs: [] }, format: { type: 'topojson', feature: 'x' } }, projection: {}, mark: 'geoshape' })
    expect(v.data[0].format).toEqual({ type: 'topojson', feature: 'x' })
  })
})

describe('maps: longitude / latitude', () => {
  it('projects the pair to x / y after fitting its extent, and positions the mark with the output fields', () => {
    const vg = compileFrozen({ data: pts, projection: { type: 'mercator' }, mark: 'circle', encoding: { longitude: lon, latitude: lat } })
    // (after the type casts of the quantitative fields)
    const ts = transforms(vg).filter((t) => t.type !== 'formula')
    expect(ts.map((t) => t.type)).toEqual(['geojson', 'geopoint'])
    expect(ts[0]).toEqual({ type: 'geojson', fields: ['lon', 'lat'], signal: 'geojson_0' })
    expect(ts[1]).toEqual({ type: 'geopoint', projection: 'projection', fields: ['lon', 'lat'], as: ['x', 'y'] })
    expect(vg.projections[0].fit).toEqual({ signal: 'geojson_0' })
    expect(vg.marks[0].encode.update).toMatchObject({ x: { field: 'x' }, y: { field: 'y' } })
    expect(vg.scales ?? []).toEqual([])
    expect(vg.axes).toBeUndefined()
    expect(vg.style).toBe('view')
  })

  it('an explicit projection needs no geojson transform', () => {
    const vg = compileFrozen({ data: pts, projection: { scale: 90 }, mark: 'point', encoding: { longitude: lon, latitude: lat } })
    expect(find(vg, 'geojson')).toEqual([])
    expect(find(vg, 'geopoint')).toHaveLength(1)
    expect(vg.marks[0].clip).toBe(true)
  })

  it('a datum position is an expression of the pair (and is not described as a field)', () => {
    const vg = compileFrozen({ data: pts, projection: {}, mark: 'point', encoding: { longitude: { datum: 5 }, latitude: lat } })
    expect(find(vg, 'geopoint')[0].fields).toEqual([{ expr: '5' }, 'lat'])
    expect(JSON.stringify(vg.marks[0].encode.update.description)).not.toContain('5')
  })

  it('the second pair feeds a rule from x2 / y2', () => {
    const vg = compileFrozen({
      data: pts,
      projection: {},
      mark: 'rule',
      encoding: { longitude: lon, latitude: lat, longitude2: { field: 'lon2' }, latitude2: { field: 'lat2' } },
    })
    expect(find(vg, 'geopoint').map((t) => t.as)).toEqual([['x', 'y'], ['x2', 'y2']])
    expect(find(vg, 'geojson').map((t) => t.signal)).toEqual(['geojson_0', 'geojson_1'])
    expect(vg.projections[0].fit).toEqual({ signal: '[geojson_0, geojson_1]' })
    expect(vg.marks[0].encode.update).toMatchObject({ x: { field: 'x' }, y: { field: 'y' }, x2: { field: 'x2' }, y2: { field: 'y2' } })
  })

  it('an aggregate groups by the projected coordinates', () => {
    const vg = compileFrozen({
      data: pts,
      projection: {},
      mark: 'circle',
      encoding: { longitude: lon, latitude: lat, size: { aggregate: 'count', type: 'quantitative' } },
    })
    expect(find(vg, 'aggregate')[0].groupby).toEqual(['x', 'y'])
  })

  it('an x / y encoding next to the pair keeps its own scale', () => {
    const vg = compileFrozen({ data: pts, projection: {}, mark: 'circle', encoding: { longitude: lon, latitude: lat, x: { value: 50 } } })
    expect(vg.marks[0].encode.update.x).toEqual({ value: 50 })
    expect(vg.marks[0].encode.update.y).toEqual({ field: 'y' })
  })
})

describe('maps: layers', () => {
  const shape = { data: geoData, mark: 'geoshape' }
  const points = { data: pts, mark: 'circle', encoding: { longitude: lon, latitude: lat } }

  it('share one projection, fitted to the union of the layers data', () => {
    const vg = compileFrozen({ projection: { type: 'mercator' }, layer: [shape, points] })
    expect(vg.projections).toEqual([{ name: 'projection', size: { signal: '[width, height]' }, fit: { signal: "[data('source_0'), layer_1_geojson_0]" }, type: 'mercator' }])
    expect(vg.marks.map((m: any) => m.name)).toEqual(['layer_0_marks', 'layer_1_marks'])
    expect(vg.marks[0].transform[0].projection).toBe('projection')
    expect(find(vg, 'geopoint')[0]).toMatchObject({ projection: 'projection', as: ['layer_1_x', 'layer_1_y'] })
    expect(vg.style).toBe('view')
  })

  it('a layer-level projection reaches its layers; a layer own projection wins over it', () => {
    const own = compileFrozen({ projection: { type: 'mercator' }, layer: [{ ...shape, projection: { type: 'albers' } }, points] })
    expect(own.projections.map((p: any) => [p.name, p.type])).toEqual([['layer_0_projection', 'albers'], ['layer_1_projection', 'mercator']])
    expect(own.marks[0].transform[0].projection).toBe('layer_0_projection')
  })

  it('layers that disagree on a property keep their own projections', () => {
    const vg = compileFrozen({ layer: [{ ...shape, projection: { type: 'mercator' } }, { ...points, projection: { type: 'equirectangular' } }] })
    expect(vg.projections.map((p: any) => p.name)).toEqual(['layer_0_projection', 'layer_1_projection'])
  })

  it('a fitted and an explicit projection never merge', () => {
    const vg = compileFrozen({ layer: [{ ...shape, projection: { type: 'mercator' } }, { ...points, projection: { type: 'mercator', scale: 50 } }] })
    expect(vg.projections).toHaveLength(2)
    expect(vg.projections[1].fit).toBeUndefined()
  })

  it('a layer without a projection of its own adopts its sibling with an empty one', () => {
    const vg = compileFrozen({ layer: [{ ...shape, projection: { type: 'mercator' } }, { ...points, projection: {} }] })
    expect(vg.projections).toHaveLength(1)
    expect(vg.projections[0]).toMatchObject({ name: 'projection', type: 'mercator' })
  })

  it('a merged projection without a type is vega\'s default, not equalEarth (vega-lite parity)', () => {
    const vg = compileFrozen({ layer: [shape, { ...points, projection: { rotate: [1, 2, 0] } }] })
    expect(vg.projections).toHaveLength(1)
    expect(vg.projections[0].type).toBeUndefined()
  })

  it('names follow the view name', () => {
    const vg = compileFrozen({ name: 'atlas', projection: {}, layer: [shape, points] })
    expect(vg.projections[0].name).toBe('atlas_projection')
    expect(find(vg, 'geojson')[0].signal).toBe('atlas_layer_1_geojson_0')
  })
})

describe('maps: composition', () => {
  it('a concat hoists each child projection, named after its cell, onto the child size', () => {
    const unit = { width: 100, height: 80, data: geoData, mark: 'geoshape' }
    const vg = compileFrozen({ hconcat: [{ ...unit, projection: { type: 'mercator' } }, { ...unit, projection: { type: 'equirectangular' } }] })
    expect(vg.projections.map((p: any) => [p.name, p.type, p.size.signal])).toEqual([
      ['concat_0_projection', 'mercator', '[childWidth, height]'],
      ['concat_1_projection', 'equirectangular', '[childWidth, height]'],
    ])
    const groups = vg.marks.filter((m: any) => m.type === 'group')
    expect(groups.map((g: any) => g.marks[0].transform[0].projection)).toEqual(['concat_0_projection', 'concat_1_projection'])
  })

  it('a concat of layers with points keeps each cell geojson signals apart', () => {
    const cell = { width: 100, height: 80, projection: {}, layer: [{ data: geoData, mark: 'geoshape' }, { data: pts, mark: 'circle', encoding: { longitude: lon, latitude: lat } }] }
    const vg = compileFrozen({ hconcat: [cell, cell] })
    const signals = find(vg, 'geojson').map((t) => t.signal)
    expect(new Set(signals).size).toBe(signals.length)
    for (const p of vg.projections) {
      for (const s of signals.filter((x: string) => p.fit.signal.includes(x))) expect(s.startsWith(p.name.replace('projection', ''))).toBe(true)
    }
  })

  it('maps inside a facet are refused: vega-lite fits them to a dataset it never defines', () => {
    expect(() => compile({ data: geoData, facet: { field: 'properties.v', type: 'nominal' }, spec: { mark: 'geoshape', projection: {} } } as never)).toThrowError(/inside a facet/)
    expect(() => compile({ data: geoData, mark: 'geoshape', projection: {}, encoding: { column: { field: 'properties.v', type: 'nominal' } } } as never)).toThrowError(/inside a facet/)
  })
})

describe('maps: refusals', () => {
  it('a parameter named like a published geojson signal', () => {
    expect(() => compile({ params: [{ name: 'geojson_0', value: 1 }], data: pts, projection: {}, mark: 'point', encoding: { longitude: lon, latitude: lat } } as never)).toThrowError(VLCompileError)
  })

  it('longitude / latitude inherited into a mark that cannot take them', () => {
    expect(() => compile({ data: pts, projection: {}, encoding: { longitude: lon, latitude: lat }, layer: [{ mark: 'bar' }] } as never)).toThrowError(/only implemented for/)
  })
})
