// @vitest-environment node
/**
 * A dataset's rows come from its `values`, else its `url`, else its `source` (vega-parser `analyze`), and every part of the engine
 * reads the same one: the compile, the parse check, the session (host rows, incremental changes), the stream and loadSpecData.
 * What vega draws for these specs is the corpus entry data-values-over-source (checked against vega by the conformance gate).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, compileChart, createChartStream, type SceneRoot, type VgSpec } from './index.js'
import { createChartSession } from './session.js'
import { dataInputOf } from './spec-structure.js'
import { loadSpecData } from './addon-load.js'

const spec = (b: Record<string, unknown>): VgSpec => ({
  width: 100, height: 40,
  data: [{ name: 'a', values: [{ k: 1 }] }, { name: 'b', ...b }],
  marks: [{ type: 'symbol', from: { data: 'b' }, encode: { update: { x: { field: 'k' }, y: { value: 5 } } } }],
} as VgSpec)

function symbols(scene: SceneRoot): number[] {
  const out: number[] = []
  const walk = (n: unknown): void => {
    const g = n as { marktype?: string; items?: Array<{ x?: number }> }
    if (g.marktype === 'symbol') { for (const it of g.items ?? []) out.push(it.x!); return }
    for (const c of g.items ?? []) walk(c)
  }
  for (const c of scene.items) walk(c)
  return out
}
const countSymbols = (svg: string): number => (svg.match(/class="mark-symbol[^"]*"[^>]*>(.*?)<\/g>/)?.[1]?.match(/<path/g) ?? []).length

describe('dataInputOf', () => {
  it('is vega\'s order, each part taken when truthy', () => {
    expect(dataInputOf({ values: [], url: 'u', source: 's' })).toBe('values')
    expect(dataInputOf({ url: 'u', source: 's' })).toBe('url')
    expect(dataInputOf({ values: null, url: 'u' })).toBe('url')
    expect(dataInputOf({ url: '', source: 's' })).toBe('source')
    expect(dataInputOf({ values: '', source: 's' })).toBe('source')
    expect(dataInputOf({})).toBe('none')
  })
})

describe('a dataset with values and a source is its values', () => {
  const withSource = spec({ source: 'a', values: [{ k: 2 }, { k: 4 }, { k: 6 }] })

  it('compiles to its values only, and a source it names need not exist', () => {
    const d = compileChart(withSource).data[1]!
    expect(d.values).toHaveLength(3)
    expect(d.source).toBeUndefined()
    expect(() => compileChart(spec({ source: 'nowhere', values: [{ k: 1 }] }))).not.toThrow()
    // without values the source must exist, as vega's parser says
    expect(() => compileChart(spec({ source: 'nowhere' }))).toThrow(/Undefined data set name/)
  })

  it('takes the host rows given under its name, as a values dataset does', () => {
    expect(countSymbols(renderSpec(withSource, { data: { b: [{ k: 9 }] } }))).toBe(1)
  })

  it('a session follows its inline rows from one spec to the next', () => {
    const s = createChartSession()
    expect(symbols(s.evaluate(withSource, {}))).toEqual([2, 4, 6])
    expect(symbols(s.evaluate(spec({ source: 'a', values: [{ k: 7 }, { k: 8 }] }), {}))).toEqual([7, 8])
  })

  it('a stream appends to its inline rows', () => {
    const stream = createChartStream(withSource)
    stream.flush()
    stream.push({ append: { b: [{ k: 8 }] } })
    expect(symbols(stream.flush()!.scene)).toEqual([2, 4, 6, 8])
  })

  it('loadSpecData fetches what vega loads: not a url beside values, not an empty url', async () => {
    const fetched: string[] = []
    const fetchStub = (async (u: string | URL) => { fetched.push(String(u)); return new Response('[{"k":3}]') }) as typeof fetch
    await loadSpecData(spec({ source: 'a', values: [{ k: 1 }], url: 'https://d.example/x.json' }), { fetch: fetchStub })
    await loadSpecData(spec({ source: 'a', url: '' }), { fetch: fetchStub })
    expect(fetched).toEqual([])
    const loaded = await loadSpecData(spec({ source: 'a', url: 'https://d.example/y.json' }), { fetch: fetchStub })
    expect(fetched).toEqual(['https://d.example/y.json'])
    expect(countSymbols(renderSpec(loaded))).toBe(1)
  })
})
