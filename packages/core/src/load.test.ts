// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { readData, inferType } from './data-format.js'
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
    // data: URLs are denied by default; this host opts in to exactly that protocol
    const loaded = await loadSpecData(spec, { protocols: ['data:'] })
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

describe('malformed url and data', () => {
  const response = (body: string, status = 200): Response => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as unknown as Response
  const fakeFetch = (body: string, status = 200): typeof fetch =>
    (async () => response(body, status)) as unknown as typeof fetch
  const specWith = (data: Record<string, unknown>): VgSpec => ({ data: [data] } as unknown as VgSpec)

  it('surfaces HTTP failures with the dataset url and status', async () => {
    const spec = specWith({ name: 't', url: 'https://example.test/missing.json' })
    await expect(loadSpecData(spec, { fetch: fakeFetch('{}', 500) })).rejects.toThrow(/HTTP 500/)
  })

  it('rejects invalid JSON payloads', async () => {
    const spec = specWith({ name: 't', url: 'https://example.test/data.json', format: { type: 'json' } })
    await expect(loadSpecData(spec, { fetch: fakeFetch('{not json') })).rejects.toThrow(/invalid JSON data/)
  })

  it('infers json/csv/tsv from the url extension and honors explicit types', async () => {
    const json = specWith({ name: 't', url: 'https://example.test/data.json', format: { type: 'json', property: 'rows' } })
    const loadedJson = await loadSpecData(json, { fetch: fakeFetch('{"rows":[{"a":1},{"a":2}]}', 200) })
    expect((loadedJson.data as any)[0].values).toEqual([{ a: 1 }, { a: 2 }])

    const csv = await loadSpecData(specWith({ name: 't', url: 'https://example.test/data.csv' }), { fetch: fakeFetch('a,b\n1,x\n2,y\n') })
    expect((csv.data as any)[0].values).toEqual([{ a: '1', b: 'x' }, { a: '2', b: 'y' }])

    const tsv = await loadSpecData(specWith({ name: 't', url: 'https://example.test/data.tsv' }), { fetch: fakeFetch('a\tb\n1\tx\n') })
    expect((tsv.data as any)[0].values).toEqual([{ a: '1', b: 'x' }])

    const explicit = await loadSpecData(
      specWith({ name: 't', url: 'https://example.test/data.txt', format: { type: 'csv', parse: { a: 'number' } } }),
      { fetch: fakeFetch('a\n1\n2\n') },
    )
    expect((explicit.data as any)[0].values).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('rejects unavailable readers and malformed topojson', async () => {
    const parquet = specWith({ name: 't', url: 'https://example.test/data.json', format: { type: 'parquet' } })
    await expect(loadSpecData(parquet, { fetch: fakeFetch('{}') })).rejects.toThrow(/load the addon first/)

    const wrongTopo = specWith({ name: 't', url: 'https://example.test/topo.json', format: { type: 'topojson', feature: 'x' } })
    await expect(loadSpecData(wrongTopo, { fetch: fakeFetch('{"type":"FeatureCollection","features":[]}') }))
      .rejects.toThrow(/must be a Topology/)

    const missingTarget = specWith({ name: 't', url: 'https://example.test/topo.json', format: { type: 'topojson' } })
    await expect(loadSpecData(missingTarget, { fetch: fakeFetch('{"type":"Topology","arcs":[],"objects":{}}') }))
      .rejects.toThrow(/requires "feature" or "mesh"/)
  })

  it('treats a missing json property as an empty dataset', async () => {
    const spec = specWith({ name: 't', url: 'https://example.test/data.json', format: { type: 'json', property: 'nope.missing' } })
    const loaded = await loadSpecData(spec, { fetch: fakeFetch('{"rows":[{"a":1}]}') })
    expect((loaded.data as any)[0].values).toEqual([])
    const scene = evaluateChart(compileChart(loaded))
    expect(scene).toBeTruthy()
  })

  it('does not mutate the input spec and tolerates ragged csv rows', async () => {
    const spec = specWith({ name: 't', url: 'https://example.test/data.csv', format: { type: 'csv' } })
    const before = JSON.stringify(spec)
    const loaded = await loadSpecData(spec, { fetch: fakeFetch('a,b,c\n1,2\n3,4,5,6\n') })
    expect(JSON.stringify(spec)).toBe(before)
    expect((loaded.data as any)[0].values).toEqual([
      { a: '1', b: '2', c: '' },
      { a: '3', b: '4', c: '5' },
    ])
  })
})

describe('loadSpecData reads data, marks and signals as lists, as the compiler does', () => {
  const fetched: string[] = []
  const fetchStub = (async (url: string | URL) => {
    fetched.push(String(url))
    return new Response(JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  it('loads a url dataset given as a single object, at the top level and in a single nested group', async () => {
    fetched.length = 0
    const spec = {
      width: 40, height: 40,
      data: { name: 'top', url: 'https://data.example/top.json' },
      marks: { type: 'group', data: { name: 'inner', url: 'https://data.example/inner.json' }, marks: { type: 'symbol', from: { data: 'inner' } } },
    } as unknown as VgSpec
    const loaded = await loadSpecData(spec, { fetch: fetchStub })
    expect(fetched.sort()).toEqual(['https://data.example/inner.json', 'https://data.example/top.json'])
    expect((loaded.data as Array<{ values: unknown[] }>)[0]!.values).toHaveLength(3)
    // and the loaded spec evaluates: no "has a url but no data was loaded"
    expect(() => evaluateChart(compileChart(loaded), {})).not.toThrow()
    // the input is not modified
    expect((spec.data as { values?: unknown }).values).toBeUndefined()
  })

  it('evaluates a {signal} url against signals given as a single object', async () => {
    fetched.length = 0
    const spec = {
      signals: { name: 'file', value: 'https://data.example/s.json' },
      data: [{ name: 't', url: { signal: 'file' } }],
    } as unknown as VgSpec
    await loadSpecData(spec, { fetch: fetchStub })
    expect(fetched).toEqual(['https://data.example/s.json'])
  })

  it('leaves a spec without url datasets as it is', async () => {
    const spec = { data: { name: 't', values: [{ a: 1 }] }, marks: { type: 'rect' } } as unknown as VgSpec
    expect(await loadSpecData(spec, { fetch: fetchStub })).toBe(spec)
  })
})

describe('a url dataset in a group mark that nobody loaded fails as a top-level one does', () => {
  const group = (inner: Record<string, unknown>): VgSpec => ({
    width: 60, height: 40,
    data: [{ name: 'facets', values: [{ g: 'a' }, { g: 'b' }] }],
    marks: [{ type: 'group', ...inner }],
  } as unknown as VgSpec)
  const symbolOf = (name: string) => ({ type: 'symbol', from: { data: name }, encode: { update: { x: { field: 'x' }, y: { value: 5 } } } })
  const nested = group({ data: [{ name: 'inner', url: 'https://data.example/inner.json' }], marks: [symbolOf('inner')] })

  it('throws, naming the dataset and loadSpecData, instead of drawing an empty mark', () => {
    expect(() => evaluateChart(compileChart(nested), {})).toThrow(/dataset "inner" has a url but no data was loaded for it.*loadSpecData.*in a group mark/)
    // host rows do not reach a group's dataset, so they do not make it load either
    expect(() => evaluateChart(compileChart(nested), { data: { inner: [{ x: 1 }] } })).toThrow(/dataset "inner"/)
  })

  it('in a group of a group, and in every instance of a faceted group', () => {
    const deep = group({ marks: [{ type: 'group', data: [{ name: 'deep', url: 'https://data.example/d.json' }], marks: [symbolOf('deep')] }] })
    expect(() => evaluateChart(compileChart(deep), {})).toThrow(/dataset "deep"/)
    const faceted = group({ from: { facet: { data: 'facets', name: 'f', groupby: 'g' } }, data: [{ name: 'perFacet', url: 'https://data.example/p.json' }], marks: [symbolOf('perFacet')] })
    expect(() => evaluateChart(compileChart(faceted), {})).toThrow(/dataset "perFacet"/)
  })

  it('renders once loadSpecData has loaded it', async () => {
    const fetchStub = (async () => new Response('[{"x":1},{"x":2}]')) as unknown as typeof fetch
    const loaded = await loadSpecData(nested, { fetch: fetchStub })
    const scene = evaluateChart(compileChart(loaded), {})
    expect(JSON.stringify(scene)).toContain('"marktype":"symbol"')
  })

  it('a group dataset with values or made from another is not a url dataset', () => {
    expect(() => evaluateChart(compileChart(group({ data: [{ name: 'v', url: 'https://data.example/v.json', values: [{ x: 1 }] }], marks: [symbolOf('v')] })), {})).not.toThrow()
    expect(() => evaluateChart(compileChart(group({ data: [{ name: 's', source: 'facets' }], marks: [symbolOf('s')] })), {})).not.toThrow()
  })
})
