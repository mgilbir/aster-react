// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { readData, coerceRows, inferType } from './data-format.js'
import { loadSpecData } from './addon-load.js'
import type { VgSpec } from './types.js'

/** Oracle-verified behaviors (real vega, see PR notes): inline format.parse coercion. */
describe('data formats', () => {
  it('coerces inline values via format.parse exactly like vega', () => {
    const rows = readData(
      [{ x: '5', y: '2024-01-15', s: '007', b: 'true' }],
      { parse: { x: 'number', y: 'date', b: 'boolean' } },
    )
    // vega: x -> 5, y -> Date(1705276800000), s stays '007', b -> true
    expect(rows[0]!.x).toBe(5)
    expect(rows[0]!.y).toBe(1705276800000)
    expect(rows[0]!.s).toBe('007')
    expect(rows[0]!.b).toBe(true)
  })

  it('leaves values alone without format.parse (oracle Q2/Q3)', () => {
    const rows = readData('x,y\n1,2\n3,4', { type: 'csv' })
    expect(rows).toEqual([{ x: '1', y: '2' }, { x: '3', y: '4' }])
  })

  it('parses csv/tsv/dsv strings via the addon readers', async () => {
    const { dataFormatRegistry } = await import('./registry.js')
    expect(readData('a,b\n1,x\n2,y', { type: 'csv' })).toEqual([{ a: '1', b: 'x' }, { a: '2', b: 'y' }])
    expect(readData('a\tb\n1\tx', { type: 'tsv' })).toEqual([{ a: '1', b: 'x' }])
    expect(readData('a;b\n1;x', { type: 'dsv', delimiter: ';' })).toEqual([{ a: '1', b: 'x' }])
    // quoted fields
    expect(readData('a,b\n"1,5",x', { type: 'csv' })).toEqual([{ a: '1,5', b: 'x' }])
    // header injection
    expect(readData('1,x', { type: 'csv', header: ['a', 'b'] })).toEqual([{ a: '1', b: 'x' }])
  })

  it('supports json property paths (oracle Q5)', () => {
    expect(readData('{"rows":[{"a":1},{"a":2}]}', { type: 'json', property: 'rows' })).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('extracts topojson features (addon)', () => {
    const topo = {
      type: 'Topology',
      arcs: [[[0, 0], [1, 1]]],
      objects: {
        reg: {
          type: 'GeometryCollection',
          geometries: [{ type: 'Polygon', arcs: [[0]], properties: { name: 'a' } }],
        },
      },
    }
    const rows = readData(topo, { type: 'topojson', feature: 'reg' })
    expect(rows).toHaveLength(1)
    expect((rows[0] as Record<string, unknown>).type).toBe('Feature')
    expect((rows[0] as { properties: { name: string } }).properties.name).toBe('a')
  })

  it('wraps a single non-array value like vega array()', () => {
    const topo = { type: 'Topology', arcs: [], objects: { g: { type: 'GeometryCollection', geometries: [] } } }
    const c = compileChart({
      data: [{ name: 't', values: topo as never }],
    } as never)
    // no throw: values wrap into [value]
    expect(() => evaluateChart(c)).not.toThrow()
  })

  it('loadSpecData inlines url datasets (data: URL, node fetch)', async () => {
    const spec = {
      data: [{ name: 't', url: 'data:text/csv,x,y%0A1,2%0A3,4', format: { type: 'csv' } }],
    } as unknown as VgSpec
    const loaded = await loadSpecData(spec)
    expect((loaded.data as unknown as { values: unknown }[])[0]!.values).toEqual([{ x: '1', y: '2' }, { x: '3', y: '4' }])
    // and the loaded spec feeds the pipeline end to end
    const scene = evaluateChart(compileChart(loaded))
    expect(scene).toBeTruthy()
  })

  it('loadSpecData is a no-op without url datasets', async () => {
    const spec = { data: [{ name: 't', values: [{ a: 1 }] }] } as unknown as VgSpec
    expect(await loadSpecData(spec)).toBe(spec)
  })

  it('throws an actionable error for text formats without the addon loaded (after registry reset)', async () => {
    // simulate a fresh process where only the core is loaded: use a fresh registry entry removal
    const { dataFormatRegistry } = await import('./registry.js')
    const saved = dataFormatRegistry.get('csv')
    dataFormatRegistry.delete('csv')
    try {
      expect(() => readData('a\n1', { type: 'csv' })).toThrow(/load the addon first/)
    } finally {
      dataFormatRegistry.set('csv', saved!)
    }
  })

  it('inferType matches vega-loader ordering', () => {
    expect(inferType(['true', 'false'])).toBe('boolean')
    expect(inferType([1, 2])).toBe('integer')
    expect(inferType([1.5])).toBe('number')
    expect(inferType(['2024-01-15'])).toBe('date')
    expect(inferType(['a'])).toBe('string')
  })
})
