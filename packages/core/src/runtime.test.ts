import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart, getChartInfo } from './runtime.js'
import { renderSceneToSvg } from './index.js'

/** Deterministic PRNG for the differential fuzz test. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 200, autosize: 'none' } as const
const sc = (name: string, dom: unknown) => ({ name, type: 'linear', domain: dom, range: 'width' })
const ysc = (name: string, dom: unknown) => ({ name, type: 'linear', domain: dom, range: 'height', zero: true, nice: true })
const sym = (field: string) => ({ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field }, y: { scale: 'y', value: 0 }, size: { value: 40 } } } })

function fuzzSpecs(): Array<{ name: string; spec: Record<string, unknown> }> {
  const n = 12
  const rows = Array.from({ length: n }, (_, i) => ({ x: i % 4, y: i % 5, g: 'g' + (i % 3), v: i }))
  const specs: Array<{ name: string; spec: Record<string, unknown> }> = [
    { name: 'symbol', spec: { ...BASE, data: [{ name: 't', values: rows }], scales: [sc('x', [0, 10]), ysc('y', [0, 10])], marks: [sym('x')] } as never },
    { name: 'formula', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'formula', expr: 'datum.x * 2', as: 'x2' }] }], scales: [sc('x', [0, 10]), ysc('y', [0, 10])], marks: [sym('x2')] } as never },
    { name: 'aggregate', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }], scales: [sc('x', [0, 10]), ysc('y', [0, 10])], marks: [sym('s')] } as never },
    { name: 'joinaggregate', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }], scales: [sc('x', [0, 10]), ysc('y', [0, 10])], marks: [sym('s')] } as never },
    { name: 'filter', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'filter', expr: 'datum.x > 1' }] }], scales: [sc('x', [0, 10]), ysc('y', [0, 10])], marks: [sym('x')] } as never },
    { name: 'bin', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'bin', field: 'x', extent: [0, 4], as: ['b0', 'b1'] }] }], scales: [sc('x', [0, 4]), ysc('y', [0, 10])], marks: [sym('b0')] } as never },
    { name: 'band-scale', spec: { ...BASE, data: [{ name: 't', values: rows }], scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 }, ysc('y', [0, 10])], marks: [sym('x')] } as never },
    // Rect marks sort by their y-scale field (paint order); this fuzzes the
    // sort-permutation cache, the discrete-domain census reuse, and the
    // scale-identity item-reuse check against the full re-derive.
    { name: 'rect-band-sort', spec: { ...BASE, data: [{ name: 't', values: rows }], scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 }, ysc('y', { data: 't', field: 'v' })], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }] } as never },
    { name: 'rect-aggregate-sort', spec: { ...BASE, data: [{ name: 't', values: rows, transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }], scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 }, ysc('y', { data: 't', field: 's' })], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 's' }, y2: { scale: 'y', value: 0 } } } }] } as never },
  ]
  return specs
}

describe('differential multi-dataset / source-chain / signal interaction', () => {
  const fs = (values: Array<{ x: number; y: number }>) => ({
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 200, autosize: 'none',
    data: [{ name: 't', values }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
  } as never)
  const xs = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => it.x)

  it('applies multi-dataset changesets', () => {
    const spec = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 200, autosize: 'none',
      data: [{ name: 'a', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, { name: 'b', values: [{ x: 3, y: 3 }, { x: 4, y: 4 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [
        { type: 'symbol', from: { data: 'a' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 0 }, size: { value: 40 } } } },
        { type: 'symbol', from: { data: 'b' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 0 }, size: { value: 40 } } } },
      ] } as never
    const chart = compileChart(spec)
    const data = { a: [{ x: 1, y: 1 }, { x: 2, y: 2 }], b: [{ x: 3, y: 3 }, { x: 4, y: 4 }] }
    const next = { a: [{ x: 5, y: 1 }, { x: 2, y: 2 }], b: [{ x: 3, y: 3 }, { x: 8, y: 4 }] }
    evaluateChart(chart, { data })
    const inc = evaluateChart(chart, { data: next, dataChanges: { a: [0], b: [1] } })
    const full = evaluateChart(chart, { data: next })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(full))
  })

  it('propagates a changeset through a source-chain derived dataset', () => {
    const spec = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 200, autosize: 'none',
      data: [
        { name: 'src', values: [{ x: 1 }, { x: 3 }] },
        { name: 'derived', source: 'src', transform: [{ type: 'formula', expr: 'datum.x * 2', as: 'y2' }] },
      ],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 'derived' }, encode: { update: { x: { scale: 'x', field: 'y2' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(spec)
    const src = [{ x: 1 }, { x: 3 }]
    evaluateChart(chart, { data: { src } })
    const nextSrc = [{ x: 2 }, { x: 3 }]
    const inc = evaluateChart(chart, { data: { src: nextSrc }, dataChanges: { src: [0] } })
    const full = evaluateChart(chart, { data: { src: nextSrc } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(full)) // derived re-derives to [4,6]
  })

  it('applies dataChanges while a (unchanged) signal drives the scale', () => {
    const spec = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: { signal: 'hi' }, range: 'height', zero: true }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(spec)
    const data = { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }
    const next = { t: [{ x: 1, y: 1 }, { x: 2, y: 8 }, { x: 3, y: 3 }] }
    evaluateChart(chart, { data, signals: { hi: 10 } })
    // signal unchanged (params stable) -> differential runs; scale domain {signal:'hi'}
    const inc = evaluateChart(chart, { data: next, dataChanges: { t: [1] }, signals: { hi: 10 } })
    const full = evaluateChart(chart, { data: next, signals: { hi: 10 } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(full))
  })
})

describe('differential fuzz (incremental === full re-derive)', () => {
  it('matches full re-derive across random changesets and specs', () => {
    const rand = mulberry32(0xC0FFEE)
    for (const { name, spec } of fuzzSpecs()) {
      const chart = compileChart(spec)
      const n = 12
      const base = Array.from({ length: n }, (_, i) => ({ x: i % 4, y: i % 5, g: 'g' + (i % 3), v: i }))
      for (let trial = 0; trial < 8; trial++) {
        // random changeset (subset of indices, random new values, same length/order)
        const changed: number[] = []
        const next = base.map((r, i) => {
          if (rand() < 0.25) { changed.push(i); return { ...r, x: (r.x + 1) % 4, y: (r.y + 1) % 5, v: r.v + 1 } }
          return r
        })
        evaluateChart(chart, { data: { t: base } })
        const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: changed } })
        const full = evaluateChart(chart, { data: { t: next } })
        expect(renderSceneToSvg(inc), `${name} trial ${trial}`).toBe(renderSceneToSvg(full))
      }
    }
  })

  it('rect differential: order-stable update reuses items and matches full re-derive', () => {
    // Bars whose y values stay in the same rank order: the sort permutation is
    // unchanged, so per-datum item reuse is safe and must engage.
    const rows = Array.from({ length: 8 }, (_, i) => ({ g: 'g' + i, v: i === 7 ? 100 : (i + 1) * 10 }))
    const spec = {
      ...BASE,
      data: [{ name: 't', values: rows }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 },
        ysc('y', { data: 't', field: 'v' }),
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
    } as never
    const chart = compileChart(spec)
    const a = evaluateChart(chart, { data: { t: rows } })
    const itemsA = a.items[0]!.items as unknown[]
    // Bump one bar's value but keep every bar's rank AND the domain extent
    // (row 7's v=100 stays the max, so the y scale is provably unchanged).
    const next = rows.map((r, i) => (i === 3 ? { g: r.g, v: r.v + 5 } : r))
    const b = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [3] } })
    const itemsB = b.items[0]!.items as unknown[]
    expect(renderSceneToSvg(b)).toBe(renderSceneToSvg(evaluateChart(chart, { data: { t: next } })))
    expect(itemsB).toBe(itemsA)
    // Scene items keep dataset order; only row 3 is re-encoded (a new
    // generation), the rest are reused.
    expect((itemsB[3] as { __gen?: number } | undefined)?.__gen).not.toBe((itemsB[0] as { __gen?: number } | undefined)?.__gen)
  })

  it('discrete domain: new category rebuilds the scale; value swap within the set reuses it', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ g: 'g' + (i % 3), v: i }))
    const spec = {
      ...BASE,
      data: [{ name: 't', values: rows }],
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 }, ysc('y', [0, 10])],
      marks: [sym('x')],
    } as never
    const chart = compileChart(spec)
    evaluateChart(chart, { data: { t: rows } })
    // Swap g values within the existing set: ordered distinct set unchanged.
    const swapped = rows.map((r, i) => (i === 0 ? { g: 'g1', v: r.v } : r))
    const incSwap = evaluateChart(chart, { data: { t: swapped }, dataChanges: { t: [0] } })
    expect(renderSceneToSvg(incSwap)).toBe(renderSceneToSvg(evaluateChart(chart, { data: { t: swapped } })))
    // Introduce a brand-new category: the domain must rebuild.
    const withNew = rows.map((r, i) => (i === 0 ? { g: 'gNew', v: r.v } : r))
    const incNew = evaluateChart(chart, { data: { t: withNew }, dataChanges: { t: [0] } })
    expect(renderSceneToSvg(incNew)).toBe(renderSceneToSvg(evaluateChart(chart, { data: { t: withNew } })))
  })
})

describe('autosize compilation', () => {
  it('parses string autosize as-is', () => {
    expect(compileChart({ autosize: 'pad' } as never).autosize).toBe('pad')
    expect(compileChart({ autosize: 'none' } as never).autosize).toBe('none')
    expect(compileChart({ autosize: 'fit' } as never).autosize).toBe('fit')
  })

  it('parses {type} object autosize', () => {
    expect(compileChart({ autosize: { type: 'pad' } } as never).autosize).toBe('pad')
    expect(compileChart({ autosize: { type: 'none' } } as never).autosize).toBe('none')
  })

  it('missing autosize -> undefined', () => {
    expect(compileChart({} as never).autosize).toBeUndefined()
  })
})

describe('autosize pad vs none', () => {
  it('evaluateChart: autosize != "none" expands padding.left from axis title+labels', () => {
    const common = {
      width: 400,
      height: 300,
      padding: { top: 0, right: 0, bottom: 0, left: 0 } as const,
      data: [{ name: 'table', values: [{ v: 0 }, { v: 100 }] }],
      scales: [
        { name: 'x', type: 'linear' as const, domain: [] as never, range: [0, 400] as never },
        { name: 'y', type: 'linear' as const, domain: [] as never, range: [300, 0] as never },
      ],
      axes: [
        {
          scale: 'y',
          orient: 'left' as const,
          labels: true,
          domain: true,
          title: 'Y-Value',
        },
      ],
      marks: [
        { type: 'point', name: 'pts', from: { data: 'table' } as const } as never,
      ],
    }

    // Spec with autosize: 'none' – padding stays at base (0).
    const specNone = { ...common, autosize: 'none' }
    const chartNone = compileChart(specNone)
    const sceneNone = evaluateChart(chartNone, { width: 400, height: 300 })

    // Spec WITHOUT autosize -> default pad path (autosize !== 'none').
    const specPad = { ...common }
    const chartPad = compileChart(specPad)
    const scenePad = evaluateChart(chartPad, { width: 400, height: 300 })

    // With autosize: 'none', padding.left should stay at 0.
    // With default (pad), padding.left should expand to fit axis title on the left.
    expect(scenePad.padding!.left).toBeGreaterThan(sceneNone.padding!.left)
  })

  it('getChartInfo returns same padding as evaluateChart for pad specs', () => {
    const spec = {
      width: 400,
      height: 300,
      padding: { top: 0, right: 0, bottom: 0, left: 0 } as const,
      data: [{ name: 'table', values: [{ v: 0 }, { v: 100 }] }],
      scales: [
        { name: 'x', type: 'linear' as const, domain: [] as never, range: [0, 400] as never },
        { name: 'y', type: 'linear' as const, domain: [] as never, range: [300, 0] as never },
      ],
      axes: [
        {
          scale: 'y',
          orient: 'left' as const,
          labels: true,
          domain: true,
          title: 'Y-Value',
        },
      ],
      marks: [
        { type: 'point', name: 'pts', from: { data: 'table' } as const } as never,
      ],
    }
    const info = getChartInfo(spec, { width: 400, height: 300 })
    const scene = evaluateChart(compileChart(spec), { width: 400, height: 300 })
    expect(info.padding).toEqual(scene!.padding)
  })
})

describe('NaN fix (Bug 1)', () => {
  it('NaN size falls through to override', () => {
    // When width is NaN (from vega-lite {signal: 'width'} compile),
    // resolveSize should fall through to the override, not return NaN.
    const spec = { width: { signal: 'width' } as unknown, height: { signal: 'height' } as unknown }
    const chart = compileChart(spec)
    const scene = evaluateChart(chart, { width: 600, height: 400 })
    expect(Number.isNaN(scene.width)).toBe(false)
    expect(scene.width).toBeGreaterThan(0)
  })
})

describe('partial re-evaluation (reactive dataflow)', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 100,
    height: 100,
    autosize: 'none',
    data: [
      { name: 'src', values: [{ v: 1 }, { v: 3 }] },
      { name: 'derived', source: 'src', transform: [{ type: 'formula', expr: 'datum.v * 2', as: 'y2' }] },
    ],
    scales: [
      { name: 'y', type: 'linear', domain: { data: 'derived', field: 'y2' }, range: 'height', zero: true, nice: true },
    ],
    marks: [
      { type: 'rect', from: { data: 'derived' }, encode: { update: { x: { value: 0 }, y: { scale: 'y', field: 'y2' }, y2: { scale: 'y', value: 0 }, height: { value: 5 } } } },
    ],
  } as never

  const rectGroup = (scene: import('./types.js').SceneRoot) =>
    scene.items.find((g) => (g as { marktype?: string }).marktype === 'rect')!

  it('rebuilds a mark when a source-chain dataset changes (not stale reuse)', () => {
    const chart = compileChart(spec)
    const s1 = evaluateChart(chart, { data: { src: [{ v: 1 }, { v: 3 }] } })
    const g1 = rectGroup(s1)
    // `derived` (source: src) changes too; changedDatasets names only `src`.
    const s2 = evaluateChart(chart, { data: { src: [{ v: 5 }, { v: 7 }] }, changedDatasets: ['src'] })
    const g2 = rectGroup(s2)
    expect(g2).not.toBe(g1)
  })

  it('reuses a mark unaffected by the changed dataset', () => {
    const chart = compileChart(spec)
    const s1 = evaluateChart(chart, { data: { src: [{ v: 1 }, { v: 3 }] } })
    const g1 = rectGroup(s1)
    // Change an unrelated dataset name; the mark (from `derived`) is untouched.
    const s2 = evaluateChart(chart, { data: { other: [] }, changedDatasets: ['other'] })
    const g2 = rectGroup(s2)
    expect(g2).toBe(g1)
  })
})

describe('per-datum differential update', () => {
  // Symbol mark at fixed-scale positions (domains [0,10], not data-derived), so
  // an unchanged row re-encodes to an identical item and can be reused.
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200,
    height: 200,
    autosize: 'none',
    data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    ],
    marks: [
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 50 } } } },
    ],
  } as never

  const symbolItems = (scene: import('./types.js').SceneRoot) =>
    scene.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!

  it('reuses unchanged items and re-encodes only changed indices', () => {
    const chart = compileChart(spec)
    const s1 = evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } })
    // Snapshot the item references: the differential path reuses the same item
    // array in place (persistent scene), so `before` must not alias it.
    const before = [...symbolItems(s1)]
    // Row index 1 changes (x 2 -> 5); indices 0 and 2 are unchanged.
    const s2 = evaluateChart(chart, {
      data: { t: [{ x: 1, y: 1 }, { x: 5, y: 2 }, { x: 3, y: 3 }] },
      dataChanges: { t: [1] },
    })
    const after = symbolItems(s2)
    expect(after[0]).toBe(before[0]) // unchanged -> same object (identity preserved)
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1]) // changed -> re-encoded
    expect((after[1] as { x?: number }).x).not.toBe((before[1] as { x?: number }).x)
    // The mark GROUP (not just its items) is persistent across the differential
    // update — a genuinely live, in-place-spliced mark like vega's.
    const group = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!
    expect(group(s2)).toBe(group(s1))
  })

  it('falls back to full re-encode when an index is out of range', () => {
    const chart = compileChart(spec)
    const s1 = evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } })
    const before = symbolItems(s1)
    // Length mismatch -> index alignment is invalid -> no reuse.
    const s2 = evaluateChart(chart, {
      data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      dataChanges: { t: [0] },
    })
    const after = symbolItems(s2)
    expect(after[0]).not.toBe(before[0])
  })

  it('invalidates reuse when a size/signal param changes', () => {
    // Item positions use range 'width'; a width change shifts every position, so
    // the previously-encoded items would be stale if reused.
    const chart = compileChart(spec)
    const s1 = evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }, width: 200 })
    const beforeItems = [...symbolItems(s1)]
    const s2 = evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }, dataChanges: { t: [1] }, width: 300 })
    const afterItems = symbolItems(s2)
    // Same values, but width changed -> positions re-encoded, not reused.
    expect(afterItems[0]).not.toBe(beforeItems[0])
  })

  it('incremental aggregate equals full re-derive (unchanged groups only)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }], transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 },
        { name: 'y', type: 'linear', domain: { data: 't', field: 's' }, range: 'height', zero: true, nice: true },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 's' }, y2: { scale: 'y', value: 0 } } } }],
    } as never
    const chart = compileChart(ts)
    const sums = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'rect')!.items!.map((it) => (it as { datum?: { s?: number } }).datum?.s)
    const init = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    const changed = [{ g: 'a', v: 3 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    // groups 'a'(3+2=5) and 'b'(12); order should be identical incrementally vs full.
    expect(sums(inc)).toEqual(sums(full))
  })

  it('incremental joinaggregate equals full re-derive', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }], transform: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 20], range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 20], range: 'height' },
      ],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 's' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const sums = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { s?: number } }).datum?.s)
    const init = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    const changed = [{ g: 'a', v: 3 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(sums(inc)).toEqual(sums(full)) // 'a'->5 (3+2), 'b'->12
  })

  it('incremental window equals full re-derive (grouped, no sort)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }], transform: [{ type: 'window', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 20], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 20], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 's' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const sums = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { s?: number } }).datum?.s)
    const init = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    const changed = [{ g: 'a', v: 3 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(sums(inc)).toEqual(sums(full)) // 'a' running sum -> [3,5]; 'b' -> [5,12]
  })

  it('incremental stack equals full re-derive (grouped, no sort)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }], transform: [{ type: 'stack', groupby: ['g'], field: 'v', as: ['y0', 'y1'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 20], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 20], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'y1' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const y1 = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { y1?: number } }).datum?.y1)
    const init = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    const changed = [{ g: 'a', v: 3 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(y1(inc)).toEqual(y1(full)) // 'a' cumulative -> [3,5]; 'b' -> [5,12]
  })

  it('incremental filter equals full re-derive', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }], transform: [{ type: 'filter', expr: 'datum.v > 2' }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const vs = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { v?: number } }).datum?.v)
    const init = [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }]
    const changed = [{ v: 4 }, { v: 3 }, { v: 5 }, { v: 7 }] // index 0 now passes
    evaluateChart(chart, { data: { t: init } }) // -> [3,5,7]
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } }) // -> [4,3,5,7]
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(vs(inc)).toEqual(vs(full))
  })

  it('incremental bin (fixed extent) equals full re-derive', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }], transform: [{ type: 'bin', field: 'v', extent: [0, 10], as: ['b0', 'b1'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'b0' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const b0 = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { b0?: number } }).datum?.b0)
    const init = [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }]
    const changed = [{ v: 2 }, { v: 3 }, { v: 5 }, { v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(b0(inc)).toEqual(b0(full))
  })

  it('incremental bin (data-derived extent) equals full re-derive when extent is stable', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }], transform: [{ type: 'bin', field: 'v', as: ['b0', 'b1'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'b0' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const b0 = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { b0?: number } }).datum?.b0)
    const init = [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }]
    const changed = [{ v: 2 }, { v: 3 }, { v: 5 }, { v: 7 }] // stays within extent, old not at boundary
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(b0(inc)).toEqual(b0(full))
  })

  it('incremental fold equals full re-derive', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ id: 'r1', a: 1, b: 2 }, { id: 'r2', a: 3, b: 4 }], transform: [{ type: 'fold', fields: ['a', 'b'], as: ['key', 'val'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'val' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const vals = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { val?: number } }).datum?.val)
    const init = [{ id: 'r1', a: 1, b: 2 }, { id: 'r2', a: 3, b: 4 }]
    const changed = [{ id: 'r1', a: 5, b: 2 }, { id: 'r2', a: 3, b: 4 }] // r1 fold -> [5,2]
    evaluateChart(chart, { data: { t: init } }) // -> [1,2,3,4]
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } }) // -> [5,2,3,4]
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(vals(inc)).toEqual(vals(full))
  })

  it('incremental timeunit equals full re-derive', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ d: '2024-01-05' }, { d: '2024-02-10' }], transform: [{ type: 'timeunit', field: 'd', units: ['month'], as: ['t0', 't1'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 't0' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const t0 = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => String((it as { datum?: { t0?: unknown } }).datum?.t0))
    const init = [{ d: '2024-01-05' }, { d: '2024-02-10' }]
    const changed = [{ d: '2024-01-20' }, { d: '2024-02-10' }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(t0(inc)).toEqual(t0(full))
  })

  it('incremental lookup equals full re-derive when its source is unaffected', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [
        { name: 'src', values: [{ id: 1, label: 'x' }, { id: 2, label: 'y' }] },
        { name: 't', values: [{ k: 1 }, { k: 2 }], transform: [{ type: 'lookup', from: 'src', key: 'id', fields: ['k'], values: ['label'], as: ['lab'] }] },
      ],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', value: 0 }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const lab = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { lab?: string } }).datum?.lab)
    const src = [{ id: 1, label: 'x' }, { id: 2, label: 'y' }]
    evaluateChart(chart, { data: { src, t: [{ k: 1 }, { k: 2 }] } }) // -> [x,y]
    const inc = evaluateChart(chart, { data: { src, t: [{ k: 2 }, { k: 2 }] }, dataChanges: { t: [0] } }) // -> [y,y]
    const full = evaluateChart(chart, { data: { src, t: [{ k: 2 }, { k: 2 }] } })
    expect(lab(inc)).toEqual(lab(full)) // source unchanged -> both [y,y]
  })

  it('incremental flatten equals full re-derive when array lengths are stable', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ id: 'r1', vals: [10, 20] }, { id: 'r2', vals: [30] }], transform: [{ type: 'flatten', fields: ['vals'] }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'vals' }, y: { value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const vals = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { vals?: number } }).datum?.vals)
    const init = [{ id: 'r1', vals: [10, 20] }, { id: 'r2', vals: [30] }]
    const changed = [{ id: 'r1', vals: [11, 20] }, { id: 'r2', vals: [30] }] // same array length
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    expect(vals(inc)).toEqual(vals(full))
  })

  it('non-incrementable transforms (collect/impute) fall back to a correct full re-derive', () => {
    const clock = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 100, height: 100, autosize: 'none' } as const
    const scale = { name: 'x', type: 'linear', domain: [0, 10], range: 'width' }
    const yScale = { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }
    const sym = { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 0 }, size: { value: 40 } } } }
    // collect: sorts by v descending (reorder) — a changed row re-sorts.
    const collectChart = compileChart({ ...clock, data: [{ name: 't', values: [{ v: 1 }, { v: 4 }, { v: 2 }], transform: [{ type: 'collect', sort: { field: 'v', order: 'descending' } }] }], scales: [scale, yScale], marks: [sym] } as never)
    const vs = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { v?: number } }).datum?.v)
    evaluateChart(collectChart, { data: { t: [{ v: 1 }, { v: 4 }, { v: 2 }] } })
    const cInc = evaluateChart(collectChart, { data: { t: [{ v: 5 }, { v: 4 }, { v: 2 }] }, dataChanges: { t: [0] } })
    const cFull = evaluateChart(collectChart, { data: { t: [{ v: 5 }, { v: 4 }, { v: 2 }] } })
    expect(vs(cInc)).toEqual(vs(cFull)) // [5,4,2] sorted desc, deterministic
    // impute: fills a missing key per group.
    const imputeChart = compileChart({ ...clock, data: [{ name: 't', values: [{ g: 'a', k: 1, v: 5 }, { g: 'a', k: 3, v: 9 }], transform: [{ type: 'impute', field: 'v', key: 'k', groupby: ['g'], method: 'value', value: 0 }] }], scales: [scale, yScale], marks: [sym] } as never)
    const iv = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { datum?: { v?: number } }).datum?.v)
    evaluateChart(imputeChart, { data: { t: [{ g: 'a', k: 1, v: 5 }, { g: 'a', k: 3, v: 9 }] } })
    const iInc = evaluateChart(imputeChart, { data: { t: [{ g: 'a', k: 1, v: 6 }, { g: 'a', k: 3, v: 9 }] }, dataChanges: { t: [0] } })
    const iFull = evaluateChart(imputeChart, { data: { t: [{ g: 'a', k: 1, v: 6 }, { g: 'a', k: 3, v: 9 }] } })
    expect(iv(iInc)).toEqual(iv(iFull))
  })

  it('reuses an affected data-domain scale when its domain is stable (correct output)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', zero: true, nice: true }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', value: 0 }, y: { scale: 'y', field: 'v' }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const y = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => (it as { y?: number }).y)
    const init = [{ v: 1 }, { v: 3 }, { v: 5 }, { v: 7 }]
    const changed = [{ v: 1 }, { v: 4 }, { v: 5 }, { v: 7 }] // index 1 (3->4) stays within [1,7]; old not a boundary
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: changed }, dataChanges: { t: [1] } })
    const full = evaluateChart(chart, { data: { t: changed } })
    // Domain [1,7] unchanged, so the reused scale yields identical positions.
    expect(y(inc)).toEqual(y(full))
  })

  it('stamps reused items as clean and changed items dirty (DOM-subtree skip basis)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
      ],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 50 } } } }],
    } as never
    const chart = compileChart(ts)
    const items = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!
    evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } })
    const s2 = evaluateChart(chart, { data: { t: [{ x: 1, y: 1 }, { x: 5, y: 2 }, { x: 3, y: 3 }] }, dataChanges: { t: [1] } })
    const gen = (s2 as unknown as { __itemGen?: number }).__itemGen
    const it = items(s2)
    // unchanged indices keep a previous generation -> clean (skippable by the patcher)
    expect((it[0] as { __gen?: number }).__gen).not.toBe(gen)
    expect((it[2] as { __gen?: number }).__gen).not.toBe(gen)
    // changed index has the current generation -> dirty (patched)
    expect((it[1] as { __gen?: number }).__gen).toBe(gen)
  })

  it('reuses a continuous scale when a boundary row moves but another holds the min', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 1 }, { v: 7 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', zero: true, nice: true }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', value: 0 }, y: { scale: 'y', field: 'v' }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const y = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!.map((it) => it.y)
    evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 3 }, { v: 1 }, { v: 7 }] } })
    // index 0 (v:1 -> 2); index 2 still holds min 1, so the domain [1,7] is unchanged.
    const inc = evaluateChart(chart, { data: { t: [{ v: 2 }, { v: 3 }, { v: 1 }, { v: 7 }] }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: [{ v: 2 }, { v: 3 }, { v: 1 }, { v: 7 }] } })
    expect(y(inc)).toEqual(y(full))
  })

  it('does NOT reuse a discrete (band) scale when a new category enters (correct output)', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'b', v: 3 }] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 },
        { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
    } as never
    const chart = compileChart(ts)
    const x = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'rect')!.items!.map((it) => Math.round((it as { x?: number }).x! * 10) / 10)
    evaluateChart(chart, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 3 }] } })
    const inc = evaluateChart(chart, { data: { t: [{ g: 'z', v: 1 }, { g: 'b', v: 3 }] }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: [{ g: 'z', v: 1 }, { g: 'b', v: 3 }] } })
    expect(x(inc)).toEqual(x(full)) // new category 'z' -> domain rebuilt
  })

  it('falls back to full re-derive when a changed row switches group', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 200, autosize: 'none',
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }], transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 },
        { name: 'y', type: 'linear', domain: { data: 't', field: 's' }, range: 'height', zero: true, nice: true },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 's' }, y2: { scale: 'y', value: 0 } } } }],
    } as never
    const chart = compileChart(ts)
    const sums = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'rect')!.items!.map((it) => (it as { datum?: { s?: number } }).datum?.s)
    const init = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    // index 0 switches group a -> b
    const switched = [{ g: 'b', v: 3 }, { g: 'a', v: 2 }, { g: 'b', v: 5 }, { g: 'b', v: 7 }]
    evaluateChart(chart, { data: { t: init } })
    const inc = evaluateChart(chart, { data: { t: switched }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: switched } })
    expect(sums(inc)).toEqual(sums(full))
  })

  it('re-derives only changed rows through a row-wise dataset transform', () => {
    const ts = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200,
      height: 200,
      autosize: 'none',
      data: [{ name: 't', values: [{ v: 1 }, { v: 3 }, { v: 5 }], transform: [{ type: 'formula', expr: 'datum.v * 2', as: 'y2' }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 20], range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 20], range: 'height' },
      ],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'y2' }, y: { scale: 'y', value: 0 }, size: { value: 40 } } } }],
    } as never
    const chart = compileChart(ts)
    const items = (s: import('./types.js').SceneRoot) => s.items.find((g) => (g as { marktype?: string }).marktype === 'symbol')!.items!
    const s1 = evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 3 }, { v: 5 }] } })
    const before = [...items(s1)]
    const beforeDatums = before.map((it) => (it as { datum?: { y2?: number } }).datum?.y2)
    const s2 = evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 4 }, { v: 5 }] }, dataChanges: { t: [1] } })
    const after = items(s2)
    expect(after[0]).toBe(before[0]) // unchanged item reused
    expect((after[0] as { datum?: { y2?: number } }).datum?.y2).toBe(beforeDatums[0]) // output row reused
    expect(after[1]).not.toBe(before[1]) // changed item re-encoded
    expect((after[1] as { datum?: { y2?: number } }).datum?.y2).toBe(8) // v=4 -> y2=8
  })
})
