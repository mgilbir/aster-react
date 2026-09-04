/**
 * Opt-in data-loading addon. Importing (or dynamic-importing) this module
 * registers the text-format readers (csv/tsv/dsv via d3-dsv, topojson via
 * topojson-client) and provides `loadSpecData`, which resolves every `url`
 * dataset in a spec into inline values:
 *
 *   import { loadSpecData } from '@aster/core/load'
 *   renderSpec(await loadSpecData(spec))
 *
 * Inline JSON values and `format.parse` type coercion work without the addon
 * (vega-loader-identical semantics ship in the core); csv/tsv/dsv/topojson
 * strings and URL datasets need it.
 */
import { dsvFormat } from 'd3-dsv'
import { feature as topoFeature, mesh as topoMesh } from 'topojson-client'
import { dataFormatRegistry } from './registry.js'
import { readData, type DataFormatSpec, type inferTypes as _inferTypes } from './data-format.js'
import type { VgSpec } from './types.js'

function delimited(delimiter: string) {
  return (data: unknown, format: Record<string, unknown>) => {
    let text = String(data)
    const header = format.header as unknown[] | undefined
    if (header) {
      text = header.map((h) => '"' + String(h).replaceAll('"', '""') + '"').join(delimiter) + '\n' + text
    }
    return dsvFormat(delimiter).parse(text) as unknown as Record<string, unknown>[]
  }
}

dataFormatRegistry.set('csv', delimited(','))
dataFormatRegistry.set('tsv', delimited('\t'))
dataFormatRegistry.set('dsv', (data: unknown, format: Record<string, unknown>) => delimited(String(format.delimiter ?? ','))(data, format))

dataFormatRegistry.set('topojson', (data, format) => {
  // vega-loader topojson: the input may be the topology object or an array
  // holding it; parse via the JSON reader first.
  const [topo] = readData(Array.isArray(data) ? (data as unknown[])[0] : data, {
    ...format,
    type: 'json',
  }) as unknown as [Record<string, unknown>]
  if (!topo || (topo as Record<string, unknown>).type !== 'Topology') {
    throw new Error('[aster] topojson data must be a Topology object')
  }
  const objects = (topo as { objects: Record<string, unknown> }).objects
  if (format.feature) {
    const fc = topoFeature(topo as never, objects[format.feature as string] as never)
    return (fc as { features?: unknown[] }).features as Record<string, unknown>[]
  }
  if (format.mesh) {
    const meshGeom = topoMesh(topo as never, objects[format.mesh as string] as never)
    return [{ type: 'GeometryCollection', geometries: [meshGeom] }] as Record<string, unknown>[]
  }
  throw new Error('[aster] topojson format requires "feature" or "mesh"')
})

/** Resolve the url of one dataset definition into inline values. */
async function loadUrl(url: string, format: DataFormatSpec | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown>[]> {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`[aster] failed to load dataset url ${url}: HTTP ${res.status}`)
  const text = await res.text()
  let type = format?.type
  if (!type) {
    // vega-loader infers the format from the url extension
    const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)
    const ext = m?.[1]?.toLowerCase()
    type = ext === 'tsv' ? 'tsv' : ext === 'csv' || ext === 'dsv' ? 'csv' : 'json'
  }
  return readData(text, { ...format, type })
}

/**
 * Fetch every `url` dataset in the spec and inline its values, so the
 * synchronous compile/evaluate/render pipeline can run unchanged. Datasets
 * already carrying `values` are left untouched. Returns a new spec object;
 * the input is not mutated.
 */
export async function loadSpecData<T extends VgSpec>(spec: T, opts?: { fetch?: typeof globalThis['fetch'] }): Promise<T> {
  const fetchImpl = opts?.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('[aster] no fetch implementation available; pass one via loadSpecData(spec, { fetch })')
  const urlDefs = (spec.data as Array<Record<string, unknown>>)?.filter((d) => typeof d?.url === 'string' && d.values == null) ?? []
  if (!urlDefs.length) return spec

  const data = (spec.data as Array<Record<string, unknown>>).map((d) => ({ ...d }))
  await Promise.all(
    urlDefs.map(async (def) => {
      const idx = (spec.data as Array<Record<string, unknown>>).indexOf(def)
      // The format is consumed by the load (readData applies type + parse);
      // strip it so the runtime treats the inlined rows as pre-parsed.
      const { format: _consumed, ...rest } = def
      void _consumed
      data[idx] = { ...rest, values: await loadUrl(def.url as string, def.format as DataFormatSpec | undefined, fetchImpl) }
    }),
  )
  return { ...spec, data }
}

export { readData, type DataFormatSpec, coerceRows } from './data-format.js'
export { dataFormatRegistry } from './registry.js'
