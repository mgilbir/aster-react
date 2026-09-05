import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart, getChartInfo } from './runtime.js'

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
