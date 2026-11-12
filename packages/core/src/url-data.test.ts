// @vitest-environment node
/**
 * `urlData: 'refuse'` (RuntimeInput) and `urlDatasets(spec)`: a host that supplies every row itself can refuse a spec that
 * names a `url` dataset, at once and with its own error, before any add-on loads (#143).
 *
 * This file imports no add-on (vitest gives each file its own module registry), so "nothing was imported" is observable as
 * `isAddonLoaded(...) === false`; the first test checks that premise.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, compileChart, evaluateChart, createChartStream, getChartInfo, AsterUrlError, AsterLimitError, checkUrlData, urlDatasets, HARD_MAX_SPEC_DEPTH } from './index.js'
import { createChartSession } from './session.js'
import { addonsNeeded, isAddonLoaded, loadAddonsFor, missingAddons } from './addons.js'
import type { VgSpec } from './types.js'

const BAR = (data: unknown[]): VgSpec => ({
  width: 100, height: 60,
  data,
  scales: [
    { name: 'x', type: 'band', domain: { data: 'source_0', field: 'a' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'source_0', field: 'b' }, range: 'height' },
  ],
  marks: [{
    type: 'rect', from: { data: 'source_0' },
    encode: { update: { x: { scale: 'x', field: 'a' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'b' }, y2: { scale: 'y', value: 0 } } },
  }],
} as VgSpec)
const CSV_URL = 'https://example.org/data.csv'
/** The issue's repro: a csv `url` dataset (what Vega-Lite's `data: { url }` compiles to). */
const URL_SPEC = BAR([{ name: 'source_0', url: CSV_URL, format: { type: 'csv' } }])
const ROWS = { source_0: [{ a: 'x', b: 1 }, { a: 'y', b: 2 }] }

/** The error `fn` throws (fails the test when it does not throw). */
function thrown(fn: () => unknown): unknown {
  try { fn() } catch (e) { return e }
  throw new Error('expected a throw')
}

describe('premise', () => {
  it('no add-on is registered in this file', () => {
    expect(isAddonLoaded('load')).toBe(false)
    expect(isAddonLoaded('transforms')).toBe(false)
    expect(isAddonLoaded('geo')).toBe(false)
  })
})

describe('urlDatasets', () => {
  it('names the url datasets at the top level and in nested group marks, at any depth, in document order', () => {
    const spec = {
      data: [{ name: 'a', url: 'a.json' }, { name: 'inline', values: [{ v: 1 }] }, { name: 'derived', source: 'inline' }],
      marks: [
        { type: 'group', data: [{ name: 'b', url: 'b.csv', format: { type: 'csv' } }], marks: [
          { type: 'group', marks: [{ type: 'group', data: [{ name: 'c', url: { signal: "'c' + '.json'" } }] }] },
        ] },
        { type: 'group', data: [{ name: 'd', url: 'd.json' }] },
      ],
    }
    expect(urlDatasets(spec)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('follows vega: `values` wins over `url`, and `url` over `source`', () => {
    // vega-parser `analyze`: `if (data.values) ... else if (data.url) ... else if (data.source)`
    expect(urlDatasets({ data: [{ name: 'v', url: 'x.json', values: [{ a: 1 }] }] })).toEqual([])
    expect(urlDatasets({ data: [{ name: 's', url: 'x.json', source: 'v' }] })).toEqual(['s'])
    // a `values` that loads nothing (an empty string) leaves the url to load
    expect(urlDatasets({ data: [{ name: 'e', url: 'x.json', values: '' }] })).toEqual(['e'])
  })

  it('is empty for a spec without url data, and for things that are not specs', () => {
    expect(urlDatasets(BAR([{ name: 'source_0', values: [] }]))).toEqual([])
    expect(urlDatasets({ data: [{ name: 'csv', values: 'a,b\n1,2', format: { type: 'csv' } }] })).toEqual([])
    for (const v of [null, undefined, 3, 'spec', [], { data: 'x', marks: 'y' }, { data: [null, 1, 'x', []] }]) expect(urlDatasets(v)).toEqual([])
  })

  it('is safe on a cyclic spec and refuses a nesting too deep to read in full', () => {
    const group: Record<string, unknown> = { type: 'group', data: [{ name: 'u', url: 'u.json' }] }
    group.marks = [group]
    expect(urlDatasets({ marks: [group] })).toEqual(['u'])
    // nested deeper than the engine's own ceiling: an error, never an answer that skipped the url below
    let deep: Record<string, unknown> = { type: 'group', data: [{ name: 'deep', url: 'd.json' }] }
    for (let i = 0; i <= HARD_MAX_SPEC_DEPTH; i++) deep = { type: 'group', marks: [deep] }
    expect(() => urlDatasets({ marks: [deep] })).toThrow(AsterLimitError)
  })
})

describe('checkUrlData', () => {
  it('throws an AsterUrlError naming the dataset and its url, and saying url data is not allowed', () => {
    const e = thrown(() => checkUrlData(URL_SPEC, 'refuse')) as AsterUrlError
    expect(e).toBeInstanceOf(AsterUrlError)
    expect(e.code).toBe('ASTER_URL_DENIED')
    expect(e.url).toBe(CSV_URL)
    expect(e.message).toContain('dataset "source_0"')
    expect(e.message).toContain('url data is not allowed')
    // it does not send the spec's author to loadSpecData: the host does not allow that
    expect(e.message).not.toContain('loadSpecData')
  })

  it('names every url dataset, and quotes a {signal} url', () => {
    const spec = { data: [{ name: 'a', url: { signal: "'a.json'" } }], marks: [{ type: 'group', data: [{ name: 'b', url: 'b.json' }] }] }
    const e = thrown(() => checkUrlData(spec, 'refuse')) as AsterUrlError
    expect(e.message).toContain('datasets "a", "b"')
    expect(e.url).toBe(`{"signal":"'a.json'"}`)
  })

  it('passes for allow, undefined, and a spec without url data', () => {
    expect(() => checkUrlData(URL_SPEC, 'allow')).not.toThrow()
    expect(() => checkUrlData(URL_SPEC, undefined)).not.toThrow()
    expect(() => checkUrlData(BAR([{ name: 'source_0', values: [] }]), 'refuse')).not.toThrow()
  })

  it('rejects any other mode, so a misspelt refusal never allows', () => {
    for (const bad of ['Refuse', 'deny', '', true, false, 0, null]) {
      expect(() => checkUrlData(URL_SPEC, bad as never)).toThrow(TypeError)
      expect(() => renderSpec(BAR([{ name: 'source_0', values: [] }]), { urlData: bad as never })).toThrow(TypeError)
    }
  })
})

describe('the engine refuses a url dataset under urlData: refuse', () => {
  it('renderSpec throws the refusal even when `data` supplies the rows; without it the rows render', () => {
    expect(renderSpec(URL_SPEC, { data: ROWS })).toContain('<path')
    expect(() => renderSpec(URL_SPEC, { data: ROWS, urlData: 'refuse' })).toThrow(AsterUrlError)
    expect(() => renderSpec(URL_SPEC, { data: ROWS, urlData: 'refuse' })).toThrow(/dataset "source_0"/)
    expect(() => renderSpec(URL_SPEC, { urlData: 'refuse' })).toThrow(/url data is not allowed/)
    // the same spec with inline rows renders under the refusal
    expect(renderSpec(BAR([{ name: 'source_0', values: ROWS.source_0 }]), { urlData: 'refuse' })).toContain('<path')
  })

  it('evaluateChart and getChartInfo refuse, a url dataset in a nested group included', () => {
    const nested = {
      width: 50, height: 50,
      marks: [{ type: 'group', data: [{ name: 'inner', url: 'inner.json' }], marks: [{ type: 'symbol', from: { data: 'inner' } }] }],
    } as VgSpec
    const chart = compileChart(nested)
    expect(() => evaluateChart(chart, { data: { inner: [] }, urlData: 'refuse' })).toThrow(/dataset "inner"/)
    expect(() => evaluateChart(chart, { data: { inner: [] } })).not.toThrow()
    expect(() => getChartInfo(URL_SPEC, { data: ROWS, urlData: 'refuse' })).toThrow(AsterUrlError)
    expect(getChartInfo(URL_SPEC, { data: ROWS })).not.toBeNull()
  })

  it('a session never answers a refusing input with the scene it cached for an allowing one', () => {
    const session = createChartSession()
    const allowed = session.evaluate(URL_SPEC, { data: ROWS })
    expect(allowed.items.length).toBeGreaterThan(0)
    expect(() => session.evaluate(URL_SPEC, { data: ROWS, urlData: 'refuse' })).toThrow(AsterUrlError)
    // and back: an allowing input renders again
    expect(session.evaluate(URL_SPEC, { data: ROWS }).items.length).toBeGreaterThan(0)
    // `change` re-evaluates the last chart: the refusal holds there too
    expect(() => session.change({ data: ROWS, urlData: 'refuse' })).toThrow(AsterUrlError)
  })

  it('a stream with initial.urlData refuses on every flush', () => {
    const stream = createChartStream(URL_SPEC, { initial: { data: ROWS, urlData: 'refuse' } })
    expect(() => stream.flush()).toThrow(AsterUrlError)
    stream.push({ data: { source_0: [{ a: 'z', b: 3 }] } })
    expect(() => stream.flush()).toThrow(AsterUrlError)
    const allowed = createChartStream(URL_SPEC, { initial: { data: ROWS } })
    expect(allowed.flush()?.scene.items.length).toBeGreaterThan(0)
  })
})

describe('add-ons under urlData: refuse', () => {
  // The issue's repro: a csv url dataset needs the `load` add-on, unless url data is refused.
  it('does not count the readers of a refused url dataset', () => {
    expect(addonsNeeded(URL_SPEC)).toEqual(['load'])
    expect(addonsNeeded(URL_SPEC, { urlData: 'refuse' })).toEqual([])
    expect(missingAddons(URL_SPEC, { urlData: 'refuse' })).toEqual([])
    // inline csv text is read whatever the setting: it still needs the readers
    const inlineCsv = { data: [{ name: 't', values: 'a,b\n1,2', format: { type: 'csv' } }] } as VgSpec
    expect(addonsNeeded(inlineCsv, { urlData: 'refuse' })).toEqual(['load'])
    // a nested group's url dataset too
    const nested = { marks: [{ type: 'group', data: [{ name: 'g', url: 'g.tsv', format: { type: 'tsv' } }] }] } as VgSpec
    expect(addonsNeeded(nested)).toEqual(['load'])
    expect(addonsNeeded(nested, { urlData: 'refuse' })).toEqual([])
    expect(() => addonsNeeded(URL_SPEC, { urlData: 'nope' as never })).toThrow(TypeError)
  })

  it('loadAddonsFor rejects with the refusal and imports nothing, even what else the spec needs', async () => {
    // a url dataset (csv: `load`) and a `pie` transform (`transforms`)
    const spec = { ...URL_SPEC, data: [{ name: 'source_0', url: CSV_URL, format: { type: 'csv' }, transform: [{ type: 'pie', field: 'b' }] }] } as VgSpec
    expect(addonsNeeded(spec)).toEqual(['transforms', 'load'])
    await expect(loadAddonsFor(spec, { urlData: 'refuse' })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadAddonsFor(spec, { urlData: 'refuse' })).rejects.toThrow(/dataset "source_0"/)
    expect(isAddonLoaded('load')).toBe(false)
    expect(isAddonLoaded('transforms')).toBe(false)
  })
})
