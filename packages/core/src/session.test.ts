import { describe, it, expect } from 'vitest'
import { renderSceneToSvg } from './index.js'
import { createChartSession } from './addon-dom.js'
import type { VgSpec } from './types.js'

const specWith = (values: Array<{ x: number; y: number }>, strokeWidth = 2): VgSpec =>
  ({
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400,
    height: 300,
    padding: 5,
    autosize: 'none',
    data: [{ name: 'table', values }],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width' },
      { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' }, range: [{ signal: 'height' }, 0], zero: true },
    ],
    marks: [
      {
        type: 'line',
        from: { data: 'table' },
        encode: {
          update: {
            x: { scale: 'x', field: 'x' },
            y: { scale: 'y', field: 'y' },
            stroke: { value: 'steelblue' },
            strokeWidth: { value: strokeWidth },
          },
        },
      },
    ],
  }) as unknown as VgSpec

describe('createChartSession', () => {
  it('returns the identical scene when only the spec object identity changed', () => {
    const session = createChartSession()
    const values = [{ x: 0, y: 1 }, { x: 1, y: 2 }]
    const a = session.evaluate(specWith(values), { width: 400, height: 300 })
    // React inline-literal pattern: new spec object, same structure + data refs
    const b = session.evaluate(specWith(values), { width: 400, height: 300 })
    expect(b).toBe(a)
  })

  it('re-evaluates on a per-datum dataChanges even when the data array identity is unchanged', () => {
    const session = createChartSession()
    const values = [{ x: 0, y: 1 }, { x: 1, y: 2 }]
    const a = session.evaluate(specWith(values), { width: 400, height: 300 })
    // In-place mutation (same array reference) + a per-datum changeset.
    values[1]!.y = 9
    const b = session.evaluate(specWith(values), { width: 400, height: 300, dataChanges: { table: [1] } })
    expect(b).not.toBe(a)
    expect(renderSceneToSvg(b)).not.toBe(renderSceneToSvg(a))
  })

  it('change() imperatively updates the last compiled chart with dataChanges', () => {
    const session = createChartSession()
    const spec = specWith([{ x: 0, y: 1 }, { x: 1, y: 2 }])
    const a = session.evaluate(spec, { width: 400, height: 300 })
    const changed = [{ x: 0, y: 1 }, { x: 1, y: 9 }]
    // No spec re-pass: change drives the update via data + dataChanges.
    const b = session.change({ data: { table: changed }, dataChanges: { table: [1] }, width: 400, height: 300 })
    expect(b).not.toBeNull()
    expect(b).not.toBe(a)
    expect(renderSceneToSvg(b!)).not.toBe(renderSceneToSvg(a))
    // A subsequent identical no-op evaluate is a cache hit.
    expect(session.evaluate(spec, { width: 400, height: 300, data: { table: changed } })).toBe(b)
  })

  it('change() returns null before the first evaluate', () => {
    const session = createChartSession()
    expect(session.change({ data: { table: [] } })).toBeNull()
  })

  it('invalidates when the data array is replaced', () => {
    const session = createChartSession()
    const a = session.evaluate(specWith([{ x: 0, y: 1 }, { x: 1, y: 5 }]), { width: 400, height: 300 })
    const b = session.evaluate(specWith([{ x: 0, y: 1 }, { x: 1, y: 9 }]), { width: 400, height: 300 })
    expect(b).not.toBe(a)
    expect(renderSceneToSvg(b)).not.toBe(renderSceneToSvg(a))
  })

  it('invalidates on size and signal changes', () => {
    const session = createChartSession()
    const spec = specWith([{ x: 0, y: 1 }, { x: 1, y: 2 }])
    const base = session.evaluate(spec, { width: 400, height: 300, signals: { shift: 0 } })
    expect(session.evaluate(spec, { width: 500, height: 300, signals: { shift: 0 } })).not.toBe(base)
    expect(session.evaluate(spec, { width: 400, height: 300, signals: { shift: 5 } })).not.toBe(base)
    expect(session.evaluate(spec, { width: 400, height: 300, signals: { shift: 5 } })).toBe(
      session.evaluate(spec, { width: 400, height: 300, signals: { shift: 5 } }),
    )
  })

  it('invalidates when spec structure changes under stable data', () => {
    const session = createChartSession()
    const values = [{ x: 0, y: 1 }, { x: 1, y: 2 }]
    const a = session.evaluate(specWith(values, 2), { width: 400, height: 300 })
    const b = session.evaluate(specWith(values, 5), { width: 400, height: 300 })
    expect(b).not.toBe(a)
    expect(renderSceneToSvg(b)).toContain('stroke-width="5"')
  })

  it('honors data overrides by reference', () => {
    const session = createChartSession()
    const spec = specWith([{ x: 0, y: 1 }])
    const input = { width: 400, height: 300 }
    const a = session.evaluate(spec, { ...input, data: { table: [{ x: 0, y: 2 }] } })
    const b = session.evaluate(spec, { ...input, data: { table: [{ x: 0, y: 99 }] } })
    expect(b).not.toBe(a)
  })
})

describe('session explicit hints given together', () => {
  const spec = {
    width: 200, height: 100, padding: 5, autosize: 'none',
    data: [
      { name: 't' }, { name: 'u' },
      { name: 'a', source: 't', transform: [{ type: 'aggregate', groupby: ['g'], fields: ['x'], ops: ['max'], as: ['m'] }] },
    ],
    scales: [
      { name: 'sx', type: 'linear', domain: { data: 'a', field: 'm' }, range: 'width' },
      { name: 'sy', type: 'linear', domain: { data: 'u', field: 'v' }, range: 'height' },
    ],
    marks: [
      { type: 'symbol', from: { data: 'a' }, encode: { update: { x: { scale: 'sx', field: 'm' }, y: { value: 5 } } } },
      { type: 'symbol', from: { data: 'u' }, encode: { update: { x: { value: 5 }, y: { scale: 'sy', field: 'v' } } } },
    ],
  } as unknown as VgSpec
  const t1 = [{ g: 'A', x: 1 }, { g: 'B', x: 2 }]
  const u1 = [{ v: 1 }, { v: 2 }]

  it('keeps dataChanges for one dataset when dataPulse names another', async () => {
    const { compileChart } = await import('./compiler.js')
    const { evaluateChart } = await import('./runtime.js')
    const t2 = [{ g: 'A', x: 1 }, { g: 'B', x: 40 }]
    const u2 = [...u1, { v: 3 }]
    const session = createChartSession()
    session.evaluate(spec, { data: { t: t1, u: u1 }, autoChanges: false })
    const got = session.evaluate(spec, {
      data: { t: t2, u: u2 }, autoChanges: false,
      dataChanges: { t: [1] },
      dataPulse: { u: { changed: [], appendOnly: true, baseLength: 2, added: [[2, 3]] } },
    })
    const want = evaluateChart(compileChart(structuredClone(spec)), { data: { t: t2, u: u2 } })
    expect(renderSceneToSvg(got)).toBe(renderSceneToSvg(want))
  })

  it('keeps changedDatasets named by the host when dataPulse is also given', async () => {
    const { compileChart } = await import('./compiler.js')
    const { evaluateChart } = await import('./runtime.js')
    const t2 = [{ g: 'A', x: 1 }, { g: 'B', x: 40 }, { g: 'B', x: 1 }]
    const u2 = [...u1, { v: 3 }]
    const session = createChartSession()
    session.evaluate(spec, { data: { t: t1, u: u1 }, autoChanges: false })
    const got = session.evaluate(spec, {
      data: { t: t2, u: u2 }, autoChanges: false,
      changedDatasets: ['t'],
      dataPulse: { u: { changed: [], from: [0, 1, -1], added: [[2, 3]], removed: [] } },
    })
    const want = evaluateChart(compileChart(structuredClone(spec)), { data: { t: t2, u: u2 } })
    expect(renderSceneToSvg(got)).toBe(renderSceneToSvg(want))
  })
})

describe('session: the container size is part of the view', () => {
  // vega-lite's `width: "container"`: the size signals read `containerSize()`
  const containerSpec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    padding: 5,
    autosize: { type: 'fit', contains: 'padding' },
    signals: [
      { name: 'width', init: 'isFinite(containerSize()[0]) ? containerSize()[0] : 300' },
      { name: 'height', init: 'isFinite(containerSize()[1]) ? containerSize()[1] : 300' },
    ],
    data: [{ name: 'table', values: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: [0, { signal: 'width' }] },
      { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' }, range: [{ signal: 'height' }, 0] },
    ],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
    marks: [{ type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
  } as unknown as VgSpec

  it('a resized container re-evaluates, as a fresh session would', () => {
    const session = createChartSession()
    const a = session.evaluate(containerSpec, { containerSize: { width: 480, height: 300 } })
    expect(a.width).toBe(480)
    const b = session.evaluate(containerSpec, { containerSize: { width: 320, height: 200 } })
    const fresh = createChartSession().evaluate(containerSpec, { containerSize: { width: 320, height: 200 } })
    expect([b.width, b.height]).toEqual([320, 200])
    expect(renderSceneToSvg(b)).toBe(renderSceneToSvg(fresh))
  })

  it('an explicit width / height is the view size whatever the size signals say', () => {
    const fixed = { width: 480, height: 260 }
    const plain = renderSceneToSvg(createChartSession().evaluate(containerSpec, { ...fixed }))
    // what a `window:resize` handler writes when the container has no size
    const withSignals = createChartSession().evaluate(containerSpec, { ...fixed, signals: { width: 300, height: 300 } })
    expect([withSignals.width, withSignals.height]).toEqual([480, 260])
    expect(renderSceneToSvg(withSignals)).toBe(plain)
  })
})

describe('one view size: scales, layout, svg and the width signal never disagree', () => {
  // `width` is a signal the spec reads through the x scale range, a mark and the layout alike
  const withSignal = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    height: 50, padding: 0, autosize: 'none',
    signals: [{ name: 'width', value: 300 }],
    data: [{ name: 't', values: [{ v: 1 }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: 'width' }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, height: { value: 10 }, width: { signal: 'width' } } } }],
  } as unknown as VgSpec
  const numeric = { ...(withSignal as object), width: 400, signals: [] } as unknown as VgSpec
  type S = { width: number; plotWidth: number; items: Array<{ items: Array<{ width: number }> }>; __scales: Array<{ range: number[] }> }
  /** [svg width, plot width, the signal as a mark reads it, the x scale's range end] */
  const sizes = (spec: VgSpec, input: Parameters<ReturnType<typeof createChartSession>['evaluate']>[1]): number[] => {
    const sc = createChartSession().evaluate(spec, input) as unknown as S
    return [sc.width, sc.plotWidth, sc.items[0]!.items[0]!.width, Number(sc.__scales[0]!.range[1])]
  }

  it('a fixed width wins over a width signal, in every consumer', () => {
    expect(sizes(withSignal, { width: 480, signals: { width: 300 } })).toEqual([480, 480, 480, 480])
    expect(sizes(withSignal, { width: 480 })).toEqual([480, 480, 480, 480])
  })

  it('without a fixed width the signal is the size, and the measured container only sizes a spec that has no such signal', () => {
    expect(sizes(withSignal, {})).toEqual([300, 300, 300, 300])
    expect(sizes(withSignal, { measuredSize: { width: 700, height: 200 } })).toEqual([300, 300, 300, 300])
    expect(sizes(numeric, { measuredSize: { width: 700, height: 200 } })).toEqual([700, 700, 700, 700])
  })

  it('a value written to the signal (a bound input, a handler) beats the measured container, and is the one every consumer reads', () => {
    const measuredSize = { width: 700, height: 200 }
    expect(sizes(withSignal, { measuredSize, signals: { width: 250 } })).toEqual([250, 250, 250, 250])
    expect(sizes(numeric, { measuredSize, signals: { width: 250 } })).toEqual([250, 250, 250, 250])
  })

  it('containerSize() is the container; without one it is the measured container', () => {
    const probe = { ...(withSignal as object), signals: [{ name: 'cw', init: 'containerSize()[0]' }], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, height: { value: 10 }, width: { signal: 'cw' } } } }], scales: [] } as unknown as VgSpec
    const w = (input: Parameters<ReturnType<typeof createChartSession>['evaluate']>[1]): number => (createChartSession().evaluate(probe, input) as unknown as S).items[0]!.items[0]!.width
    expect(w({ containerSize: { width: 320, height: 100 }, measuredSize: { width: 700, height: 200 } })).toBe(320)
    expect(w({ measuredSize: { width: 700, height: 200 } })).toBe(700)
  })
})
