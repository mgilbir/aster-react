// @vitest-environment node
/**
 * `emptyUrlData(spec)` (what a `<Chart urlLoad>` draws until its first load arrives) and `datasetUrls(spec, options)` (what it
 * compares to decide whether a signal change loads anything). The first must be exactly the shape `loadSpecData` gives a loaded
 * dataset with no rows (so a load changes the rows and nothing else, and the session diffs them), at every depth and for every
 * way a spec names its data; the second exactly the urls `loadSpecData` requests.
 */
import { describe, it, expect } from 'vitest'
import { AsterLimitError, emptyUrlData, HARD_MAX_SPEC_DEPTH, urlDatasets } from './index.js'
import { datasetUrls, loadSpecData } from './addon-load.js'
import type { VgSpec } from './types.js'

type Json = Record<string, unknown>
const base = 'https://data.example.com'

/** A fetch that serves `[{v: <the url's last digit>}]` for every url and records the urls it was asked for. */
function recorder(): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = []
  const fetch = (async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify([{ v: urls.length }]), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, urls }
}
const allow = (): boolean => true

/** The same spec with the rows each url dataset got stripped (`values` removed from every dataset that has a `url`). */
function withoutRows(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutRows)
  if (node === null || typeof node !== 'object') return node
  const out: Json = {}
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === 'values' && typeof (node as Json).url !== 'undefined') continue
    out[k] = withoutRows(v)
  }
  return out
}

/** Specs naming url datasets in every way: nested to several depths, a lone object for a list, several beside non-url datasets. */
const SPECS: Array<[string, Json]> = [
  ['top level', { data: [{ name: 'a', url: `${base}/a.json` }] }],
  ['with a csv format (stripped, as the loader strips it)', { data: [{ name: 'a', url: `${base}/a.csv`, format: { type: 'csv' } }] }],
  ['a lone data object, not a list', { data: { name: 'a', url: `${base}/a.json` } }],
  ['a {signal} url', { signals: [{ name: 'n', value: 3 }], data: [{ name: 'a', url: { signal: `'${base}/f' + n + '.json'` } }] }],
  ['beside inline, derived and url-less datasets', { data: [
    { name: 'i', values: [{ q: 1 }] }, { name: 'a', url: `${base}/a.json` }, { name: 'd', source: 'a' }, { name: 'e', url: '' }, { name: 'both', url: `${base}/x.json`, values: [{ z: 1 }] },
  ] }],
  ['in a group', { marks: [{ type: 'group', data: [{ name: 'a', url: `${base}/a.json` }], marks: [] }] }],
  ['three groups deep, with a sibling that has none', { marks: [
    { type: 'rect' },
    { type: 'group', marks: [{ type: 'group', marks: [{ type: 'group', data: [{ name: 'deep', url: `${base}/deep.json` }, { name: 'in', values: [] }] }] }] },
  ] }],
  ['a lone group object for the marks', { marks: { type: 'group', data: [{ name: 'g', url: `${base}/g.json` }] } }],
  ['top level and nested, same name in two scopes', { data: [{ name: 'a', url: `${base}/a.json` }], marks: [{ type: 'group', data: [{ name: 'a', url: `${base}/b.json` }] }] }],
]

describe('emptyUrlData', () => {
  for (const [name, spec] of SPECS) {
    it(`${name}: the url datasets have no rows and no format, nothing else changes, the input is untouched`, () => {
      const before = JSON.stringify(spec)
      const empty = emptyUrlData(spec as VgSpec) as unknown as Json
      expect(JSON.stringify(spec)).toBe(before)
      // (every dataset the input loads from a url has `values: []` and no format now: none of the result loads any more)
      const names = urlDatasets(spec as VgSpec)
      expect(names.length).toBeGreaterThan(0)
      // (each of those datasets has an empty `values` array and no `format`, and no dataset gained rows)
      const found: Json[] = []
      const walk = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(walk); return }
        const o = node as Json
        if (typeof o.name === 'string' && typeof o.url !== 'undefined' && Array.isArray(o.values) && o.values.length === 0) found.push(o)
        for (const v of Object.values(o)) walk(v)
      }
      walk(empty)
      expect(found.map((d) => d.name).sort()).toEqual([...names].sort())
      expect(found.every((d) => !('format' in d))).toBe(true)
      // (no dataset of the result still loads: the walk of url datasets finds none)
      expect(urlDatasets(empty as unknown as VgSpec)).toEqual([])
    })
  }

  it('has exactly the shape a load gives, apart from the rows: for every spec above, loaded minus rows equals empty minus rows', async () => {
    for (const [name, spec] of SPECS) {
      const { fetch } = recorder()
      const loaded = await loadSpecData(spec as VgSpec, { fetch, allow })
      const empty = emptyUrlData(spec as VgSpec)
      // (the lone-object lists the loader normalises to arrays, as `emptyUrlData` does: the same shape)
      expect(withoutRows(empty), name).toEqual(withoutRows(loaded))
    }
  })

  it('is the very same object, and shares what it does not change', () => {
    const plain = { data: [{ name: 'i', values: [{ a: 1 }] }], marks: [{ type: 'group', marks: [] }] } as unknown as VgSpec
    expect(emptyUrlData(plain)).toBe(plain)
    const mixed = {
      data: [{ name: 'i', values: [{ a: 1 }] }],
      marks: [{ type: 'rect' }, { type: 'group', data: [{ name: 'g', url: `${base}/g.json` }] }],
      scales: [{ name: 's' }],
    } as unknown as VgSpec
    const empty = emptyUrlData(mixed) as unknown as { data: unknown[]; marks: unknown[]; scales: unknown[] }
    expect(empty).not.toBe(mixed)
    expect(empty.data).toBe((mixed as unknown as { data: unknown[] }).data)
    expect(empty.scales).toBe((mixed as unknown as { scales: unknown[] }).scales)
    expect(empty.marks[0]).toBe((mixed as unknown as { marks: unknown[] }).marks[0])
    expect(empty.marks[1]).not.toBe((mixed as unknown as { marks: unknown[] }).marks[1])
  })

  it('leaves what is not an object as it is, and a nesting past the ceiling is a typed refusal, never a stack overflow', () => {
    expect(emptyUrlData(null)).toBeNull()
    expect(emptyUrlData('x')).toBe('x')
    const cyclic: Json = { marks: [] }
    ;(cyclic.marks as unknown[]).push(cyclic)
    expect(() => emptyUrlData(cyclic)).toThrow(AsterLimitError)
    let deep: Json = { data: [{ name: 'a', url: `${base}/a.json` }] }
    for (let i = 0; i < HARD_MAX_SPEC_DEPTH + 2; i++) deep = { marks: [deep] }
    expect(() => emptyUrlData(deep)).toThrow(AsterLimitError)
  })
})

describe('datasetUrls', () => {
  it('is the urls a load requests, in order, for every spec above', async () => {
    for (const [name, spec] of SPECS) {
      const rec = recorder()
      await loadSpecData(spec as VgSpec, { fetch: rec.fetch, allow })
      // (several datasets naming one url make one request: the list names each dataset's url, the requests are the distinct ones)
      expect([...new Set(datasetUrls(spec as VgSpec))], name).toEqual([...new Set(rec.urls)].sort((a, b) => datasetUrls(spec as VgSpec).indexOf(a) - datasetUrls(spec as VgSpec).indexOf(b)))
    }
  })

  it('evaluates a {signal} url over the host\'s signals, a group\'s own signals shadowing the view\'s', () => {
    const spec = {
      signals: [{ name: 'which', value: 'a' }],
      data: [{ name: 'top', url: { signal: "'/t/' + which" } }],
      marks: [{ type: 'group', signals: [{ name: 'which', value: 'inner' }], data: [{ name: 'g', url: { signal: "'/g/' + which" } }] }],
    } as unknown as VgSpec
    expect(datasetUrls(spec)).toEqual(['/t/a', '/g/inner'])
    expect(datasetUrls(spec, { signals: { which: 'z' } })).toEqual(['/t/z', '/g/inner'])
  })

  it('a url that is not a string is the loader\'s error, and the url expressions run under the limits', () => {
    expect(() => datasetUrls({ data: [{ name: 'a', url: { signal: 'nope' } }] } as unknown as VgSpec)).toThrow(/url must be a string/)
    const evil = { signals: [{ name: 'u', init: "test(/(a+)+$/, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!') ? '/1' : '/2'" }], data: [{ name: 'd', url: { signal: 'u' } }] } as unknown as VgSpec
    expect(() => datasetUrls(evil, { limits: { regex: 'refuse' } })).toThrow(AsterLimitError)
  })
})
