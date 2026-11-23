// @vitest-environment node
/**
 * The data readers of `@aster-charts/core/load` against vega-loader's (`vega.read`), and the format a url dataset is read in against
 * a vega View with a loader that answers from a table:
 *
 * - topojson (C33, C34, C403): every object of the vega-datasets topologies and of generated ones, as `feature` (a single geometry
 *   is one Feature row) and as `mesh` with each `filter` (the row is the MultiLineString itself), with `parse` applied to the
 *   decoded features;
 * - csv (C12): generated ragged texts read identically, while the cells a wide header over empty lines would make are refused
 *   before they are made (with and without limits, inline and loaded);
 * - format types (C626): a type no reader knows is vega's "Unknown data format type";
 * - the format of a url dataset (C287): its `format.type`, json by default, whatever the url's extension.
 *
 * Malformed topologies (C90, C402) have no vega counterpart worth matching (vega throws raw TypeErrors, or walks a sparse array
 * for minutes): Aster's answer is an `[aster] topojson: ...` error, at once.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as vega from 'vega'
import { renderSpec, AsterLimitError, type VgSpec } from '@aster-charts/core'
import { loadSpecData, readData } from '@aster-charts/core/load'

const dataset = (name: string): unknown => JSON.parse(readFileSync(new URL(`../node_modules/vega-datasets/data/${name}`, import.meta.url), 'utf8'))
const json = (v: unknown): string => JSON.stringify(v)

/** vega's rows, or the message it throws. */
function vegaRead(data: unknown, format: Record<string, unknown>): { rows?: unknown; error?: string } {
  try { return { rows: vega.read(data as never, format as never) } } catch (e) { return { error: (e as Error).message } }
}
function asterRead(data: unknown, format: Record<string, unknown>): { rows?: unknown; error?: string; type?: string } {
  try { return { rows: readData(data, format) } } catch (e) { return { error: (e as Error).message, type: (e as Error).constructor.name } }
}

// a deterministic generator
let seed = 0x5eed
const rand = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 }
const int = (n: number): number => Math.floor(rand() * n)

/** A random small topology: arcs, and objects of every geometry type, alone and in collections. */
function topology(): Record<string, unknown> {
  const arcCount = 1 + int(8)
  const quantized = rand() < 0.5
  const arcs = Array.from({ length: arcCount }, () => Array.from({ length: 2 + int(5) }, () => [int(9) - 4, int(9) - 4]))
  const arc = (): number => { const i = int(arcCount); return rand() < 0.3 ? ~i : i }
  const line = (): number[] => Array.from({ length: 1 + int(3) }, arc)
  const geometry = (depth = 0): Record<string, unknown> => {
    const kinds = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', ...(depth < 2 ? ['GeometryCollection'] : []), 'Nothing']
    const type = kinds[int(kinds.length)]!
    const extra = { ...(rand() < 0.5 ? { id: int(100) } : {}), ...(rand() < 0.5 ? { properties: { name: 'n' + int(10), v: int(5) } } : {}) }
    switch (type) {
      case 'Point': return { type, coordinates: [int(20), int(20)], ...extra }
      case 'MultiPoint': return { type, coordinates: Array.from({ length: 1 + int(3) }, () => [int(20), int(20)]), ...extra }
      case 'LineString': return { type, arcs: line(), ...extra }
      case 'MultiLineString': case 'Polygon': return { type, arcs: Array.from({ length: 1 + int(3) }, line), ...extra }
      case 'MultiPolygon': return { type, arcs: Array.from({ length: 1 + int(2) }, () => Array.from({ length: 1 + int(2) }, line)), ...extra }
      case 'GeometryCollection': return { type, geometries: Array.from({ length: int(4) }, () => geometry(depth + 1)), ...extra }
      default: return { type: null, ...extra }
    }
  }
  return {
    type: 'Topology',
    ...(quantized ? { transform: { scale: [0.5, 2], translate: [10, -5] } } : {}),
    arcs,
    objects: { a: geometry(), b: { type: 'GeometryCollection', geometries: Array.from({ length: 1 + int(4) }, () => geometry(1)) } },
  }
}

describe('topojson reads as vega-loader reads it (C33, C34, C403)', () => {
  const formats = (name: string): Array<Record<string, unknown>> => [
    { type: 'topojson', feature: name },
    { type: 'topojson', feature: name, parse: 'auto' },
    { type: 'topojson', feature: name, parse: { id: 'number' } },
    { type: 'topojson', mesh: name },
    { type: 'topojson', mesh: name, filter: 'interior' },
    { type: 'topojson', mesh: name, filter: 'exterior' },
    { type: 'topojson', mesh: name, filter: 'neither' },
  ]

  it('every object of the vega-datasets topologies, as an object and as its JSON text', () => {
    let compared = 0
    for (const file of ['world-110m.json', 'us-10m.json']) {
      const topo = dataset(file) as { objects: Record<string, unknown> }
      for (const name of Object.keys(topo.objects)) {
        for (const format of formats(name)) {
          for (const input of [topo, json(topo)]) {
            const v = vegaRead(input, format)
            const a = asterRead(input, format)
            expect(v.error, `${file} ${json(format)}: vega threw`).toBeUndefined()
            expect(a.error, `${file} ${json(format)}`).toBeUndefined()
            expect(json(a.rows), `${file} ${json(format)}`).toBe(json(v.rows))
            compared++
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(2 * 2 * 7 * 2)
  })

  it('generated topologies: every object, as feature and as mesh with each filter', () => {
    let compared = 0
    for (let i = 0; i < 300; i++) {
      const topo = topology()
      for (const name of ['a', 'b']) {
        for (const format of formats(name)) {
          const v = vegaRead(topo, format)
          if (v.error) continue // (a degenerate draw vega cannot read either: covered by the malformed cases below)
          const a = asterRead(topo, format)
          expect(a.error, `#${i} ${json(format)} ${json(topo)}`).toBeUndefined()
          expect(json(a.rows), `#${i} ${json(format)} ${json(topo)}`).toBe(json(v.rows))
          compared++
        }
      }
    }
    expect(compared).toBeGreaterThan(3000)
  })
})

describe('a malformed topology is an [aster] topojson error, at once (C90, C402)', () => {
  const base = (objects: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ type: 'Topology', arcs: [[[0, 0], [1, 1]], [[1, 1], [2, 0]]], objects, ...extra })
  const cases: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
    'arc index past the arcs (feature)': [base({ o: { type: 'LineString', arcs: [2] } }), { feature: 'o' }],
    'arc index past the arcs (mesh)': [base({ o: { type: 'LineString', arcs: [2] } }), { mesh: 'o' }],
    'huge arc index (mesh)': [base({ o: { type: 'LineString', arcs: [4294967294] } }), { mesh: 'o' }],
    'huge arc index (feature)': [base({ o: { type: 'LineString', arcs: [300000000] } }), { feature: 'o' }],
    'huge negative arc index': [base({ o: { type: 'LineString', arcs: [-300000000] } }), { mesh: 'o' }],
    'fractional arc index': [base({ o: { type: 'LineString', arcs: [0.5] } }), { mesh: 'o' }],
    'text arc index': [base({ o: { type: 'Polygon', arcs: [['0']] } }), { feature: 'o' }],
    'GeometryCollection without geometries (feature)': [base({ o: { type: 'GeometryCollection' } }), { feature: 'o' }],
    'GeometryCollection without geometries (mesh)': [base({ o: { type: 'GeometryCollection' } }), { mesh: 'o' }],
    'GeometryCollection with a null member': [base({ o: { type: 'GeometryCollection', geometries: [null] } }), { feature: 'o' }],
    'one-position arc (mesh)': [{ type: 'Topology', arcs: [[[0, 0]]], objects: { o: { type: 'LineString', arcs: [0] } } }, { mesh: 'o' }],
    'one-position arc (feature)': [{ type: 'Topology', arcs: [[[0, 0]]], objects: { o: { type: 'LineString', arcs: [0] } } }, { feature: 'o' }],
    'arc that is not a list': [{ type: 'Topology', arcs: [5], objects: { o: { type: 'LineString', arcs: [0] } } }, { feature: 'o' }],
    'position that is not a list': [{ type: 'Topology', arcs: [[[0, 0], 7]], objects: { o: { type: 'LineString', arcs: [0] } } }, { mesh: 'o' }],
    'transform without scale': [base({ o: { type: 'LineString', arcs: [0] } }, { transform: { translate: [0, 0] } }), { feature: 'o' }],
    'transform without translate (point)': [base({ o: { type: 'Point', coordinates: [1, 2] } }, { transform: { scale: [1, 1] } }), { feature: 'o' }],
    'no arcs list': [{ type: 'Topology', objects: { o: { type: 'LineString', arcs: [0] } } }, { feature: 'o' }],
    'LineString arcs not a list': [base({ o: { type: 'LineString', arcs: 0 } }), { mesh: 'o' }],
    'MultiPolygon arcs one level short': [base({ o: { type: 'MultiPolygon', arcs: [[0]] } }), { feature: 'o' }],
    'Point without coordinates': [base({ o: { type: 'Point' } }), { feature: 'o' }],
    'object that is not an object': [base({ o: 5 }), { feature: 'o' }],
  }
  for (const [name, [topo, format]] of Object.entries(cases)) {
    it(name, () => {
      const t0 = performance.now()
      const a = asterRead(topo, { type: 'topojson', ...format })
      expect(performance.now() - t0).toBeLessThan(200)
      expect(a.error, json(a.rows)).toMatch(/^\[aster\] topojson/)
      expect(a.type).toBe('Error')
    })
  }

  it('an object name the topology does not have, also one on Object.prototype, is "not found" (vega: Invalid TopoJSON object)', () => {
    const topo = base({ o: { type: 'LineString', arcs: [0] } })
    for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
      expect(asterRead(topo, { type: 'topojson', feature: name }).error).toMatch(/topojson object ".*" not found/)
    }
    expect(vegaRead(topo, { type: 'topojson', feature: 'nope' }).error).toMatch(/Invalid TopoJSON object: nope/)
  })
})

/** A random ragged delimited text: short and long lines, empty lines, quoted fields with delimiters, quotes and line breaks. */
function raggedCsv(): string {
  const columns = 1 + int(12)
  const field = (): string => {
    const r = rand()
    return r < 0.15 ? '' : r < 0.3 ? `"a,${int(9)}""q""\n${int(9)}"` : String(int(1000))
  }
  const lines = [Array.from({ length: columns }, (_, i) => (rand() < 0.1 ? `"c ${i}"` : `c${i}`)).join(',')]
  for (let r = int(30); r > 0; r--) lines.push(rand() < 0.15 ? '' : Array.from({ length: Math.max(1, columns + int(5) - 3) }, field).join(','))
  return lines.join(rand() < 0.2 ? '\r\n' : '\n') + (rand() < 0.5 ? '\n' : '')
}

describe('csv reads as vega-loader reads it, and the cells it makes are budgeted before they exist (C12)', () => {
  it('generated ragged texts (short, long and empty lines, quoting, CRLF): identical rows', () => {
    for (let i = 0; i < 500; i++) {
      const text = raggedCsv()
      for (const format of [{ type: 'csv' }, { type: 'csv', parse: 'auto' }, { type: 'dsv', delimiter: ',' }]) {
        expect(json(asterRead(text, format).rows), json(text)).toBe(json(vegaRead(text, format).rows))
      }
    }
  })

  /** A wide header over empty lines: about 31 KB that a reader pads to columns x lines cells. */
  const wide = (columns: number, lines: number): string => Array.from({ length: columns }, (_, i) => 'c' + i).join(',') + '\n'.repeat(lines)

  it('without limits: the built-in ceiling refuses the filled-in cells before they are made', () => {
    const t0 = performance.now()
    const a = asterRead(wide(2000, 20_000), { type: 'csv' })
    expect(a.error).toMatch(/csv cells filled in for missing fields \d+ > 1000000 \(built-in ceiling/)
    expect(performance.now() - t0).toBeLessThan(2000)
    // a ragged text under the ceiling reads as vega reads it
    const ok = wide(200, 4000)
    expect(json(asterRead(ok, { type: 'csv' }).rows)).toBe(json(vegaRead(ok, { type: 'csv' }).rows))
  })

  it('with limits: maxRows is checked row by row, and maxGeneratedRows replaces the ceiling', () => {
    const t0 = performance.now()
    const inline = (text: string, limits: Record<string, unknown>): unknown => {
      try { return renderSpec({ width: 10, height: 10, data: [{ name: 'd', values: text, format: { type: 'csv' } }], marks: [] } as unknown as VgSpec, { limits }) } catch (e) { return e }
    }
    const byRows = inline(wide(2000, 20_000), { maxRows: 1000, maxTimeMs: 2000, maxGeneratedRows: 100_000_000 })
    expect(byRows).toBeInstanceOf(AsterLimitError)
    expect(String((byRows as Error).message)).toMatch(/maxRows 1001 > 1000 \(csv rows\)/)
    const byCells = inline(wide(2000, 20_000), { maxGeneratedRows: 50_000 })
    expect(byCells).toBeInstanceOf(AsterLimitError)
    expect(String((byCells as Error).message)).toMatch(/maxGeneratedRows \d+ > 50000 \(csv cells filled in/)
    expect(performance.now() - t0).toBeLessThan(3000)
    // a limit that replaces the ceiling lets a legitimately ragged text through, read as vega reads it
    const big = wide(300, 4000) // 1.2 M filled cells, over the ceiling
    expect(asterRead(big, { type: 'csv' }).error).toMatch(/built-in ceiling/)
    expect(typeof inline(big, { maxGeneratedRows: 2_000_000 })).toBe('string')
  })

  it('loadSpecData: the same text over the wire is refused the same way, before its rows exist', async () => {
    const text = wide(2000, 20_000)
    const t0 = performance.now()
    const err = await loadSpecData({ data: [{ name: 'd', url: 'https://a.example.com/w.csv', format: { type: 'csv' } }] } as unknown as VgSpec, {
      allow: () => true, fetch: (async () => new Response(text)) as unknown as typeof fetch, limits: { maxRows: 1000, maxTimeMs: 2000, maxGeneratedRows: 100_000_000 },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/maxRows 1001 > 1000/)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('a format type no reader knows is vega\'s "Unknown data format type" (C626)', () => {
  it('misspelt, mis-cased and unsupported types, the load add-on loaded', () => {
    for (const type of ['jsno', 'CSV', 'Json', 'TopoJSON', 'parquet', 'arrow', 'toString', '__proto__']) {
      const v = vegaRead('[]', { type })
      const a = asterRead('[]', { type })
      expect(v.error, type).toBe(`Unknown data format type: ${type}`)
      expect(a.error, type).toBe(`[aster] Unknown data format type: ${type}`)
    }
    // an empty type is json in both
    expect(json(asterRead('[{"a":1}]', { type: '' }).rows)).toBe(json(vegaRead('[{"a":1}]', { type: '' }).rows))
  })
})

describe('the format of a url dataset is its format.type, json by default, as in vega (C287)', () => {
  /** What a vega View loads for a url dataset, its loader answering `body`. */
  async function vegaLoads(url: string, format: Record<string, unknown> | undefined, body: string): Promise<{ rows?: unknown; failed?: true }> {
    const loader = vega.loader()
    loader.load = async () => body
    let failed = false
    const logger = { level() { return this }, warn: (...a: unknown[]) => { if (String(a[0]).includes('Data ingestion failed')) failed = true }, error() {}, info() {}, debug() {} }
    const view = new vega.View(vega.parse({ data: [{ name: 'd', url, ...(format ? { format } : {}) }] } as never), { renderer: 'none', loader, logger: logger as never })
    await view.runAsync()
    return failed ? { failed: true } : { rows: view.data('d') }
  }

  it('every extension, every body, with and without a format', async () => {
    const bodies = { csv: 'a,b\n1,2\n', tsv: 'a\tb\n1\t2\n', json: '[{"a":1,"b":2}]' }
    let compared = 0
    for (const ext of ['csv', 'tsv', 'dsv', 'json', 'topojson', 'txt', '']) {
      const url = `https://a.example.com/data${ext ? '.' + ext : ''}`
      for (const [kind, body] of Object.entries(bodies)) {
        for (const format of [undefined, { type: 'csv' }, { type: 'tsv' }, { type: 'json' }]) {
          const v = await vegaLoads(url, format, body)
          const a = await loadSpecData({ data: [{ name: 'd', url, ...(format ? { format } : {}) }] } as unknown as VgSpec, {
            allow: () => true, fetch: (async () => new Response(body)) as unknown as typeof fetch,
          }).then((s) => ({ rows: (s.data as unknown as Array<{ values: unknown }>)[0]!.values }), (e: Error) => ({ error: e.message }))
          const label = `${url} ${kind} body, format ${json(format)}`
          if (v.failed) expect((a as { error?: string }).error, label).toMatch(/invalid JSON data/)
          else expect(json((a as { rows?: unknown }).rows), label).toBe(json(v.rows))
          compared++
        }
      }
    }
    expect(compared).toBe(7 * 3 * 4)
  })
})
