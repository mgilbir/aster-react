// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { createChartSession } from './session.js'
import { createChartStream, AsterStreamBackpressureError } from './stream.js'
import { diffRows } from './pulse.js'
import './addon-transforms.js'
import './addon-geo.js'
import type { VgSpec } from './types.js'

const points = (n: number, from = 0) => Array.from({ length: n }, (_, i) => {
  const k = from + i
  return { x: (k % 97) / 97, v: (k % 23) / 2, g: `g${k % 5}`, w: 1 }
})

function symbolSpec(values: unknown[], transform?: unknown[]): VgSpec {
  return {
    width: 300, height: 180, padding: 0, autosize: 'none',
    data: transform?.length
      ? [
          { name: 'src', values },
          { name: 't', source: 'src', transform },
        ]
      : [{ name: 't', values }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 1], range: [0, 300] },
      { name: 'y', type: 'linear', domain: [0, 12], range: [180, 0] },
      { name: 'c', type: 'band', domain: ['g0', 'g1', 'g2', 'g3', 'g4'], range: [0, 300] },
    ],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { value: 20 } } },
    }],
  }
}

function evalFull(spec: VgSpec, values: unknown[]): string {
  const first = (spec.data as Array<{ name?: string }> | undefined)?.[0]
  return renderSceneToSvg(evaluateChart(compileChart(spec), { data: first?.name === 'src' ? { src: values } : { t: values } as never }))
}

const svgOf = (scene: ReturnType<typeof evaluateChart>): string => renderSceneToSvg(scene)

describe('length-changing pulses', () => {
  it('derives an append mapping and an insert/delete mapping', () => {
    const append = diffRows([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 2 }, { a: 3 }])!
    expect(append.addedRanges).toEqual([[2, 3]])
    expect(append.from).toEqual([0, 1, -1])
    expect(append.to).toEqual([0, 1])
    const insert = diffRows([{ a: 1 }, { a: 3 }], [{ a: 1 }, { a: 2 }, { a: 3 }])!
    expect(insert.addedRanges).toEqual([[1, 2]])
    expect(insert.from).toEqual([0, -1, 1])
    expect(insert.changed).toEqual([])
    const del = diffRows([{ a: 1 }, { a: 2 }, { a: 3 }], [{ a: 1 }, { a: 3 }])!
    expect(del.removedRanges).toEqual([[1, 2]])
    expect(del.to).toEqual([0, -1, 1])
  })

  it('splices scene items for an append without re-encoding retained rows', () => {
    const spec = symbolSpec(points(6))
    const session = createChartSession()
    const a = session.evaluate(spec)
    const itemsA = [...(a.items[0] as { items: unknown[] }).items]
    const next = [...points(6), ...points(2, 6)]
    const b = session.evaluate(spec, { data: { t: next } })
    const itemsB = (b.items[0] as { items: unknown[] }).items
    expect(itemsB).toHaveLength(8)
    expect(itemsB.slice(0, 6)).toEqual(itemsA)
    for (let i = 0; i < 6; i++) expect(itemsB[i]).toBe(itemsA[i])
    expect(session.pulse()?.structural.has('t')).toBe(true)
    expect(session.pulse()?.datasets.get('t')?.addedRanges).toEqual([[6, 8]])
    expect(svgOf(b)).toBe(evalFull(spec, next))
  })

  it('handles an insert in the middle and a delete by mapping retained items', () => {
    const spec = symbolSpec(points(8))
    const session = createChartSession()
    const a = session.evaluate(spec)
    const itemsA = [...(a.items[0] as { items: unknown[] }).items]
    const inserted = [...points(3), { x: 0.5, v: 7, g: 'g2', w: 1 }, ...points(5, 3)]
    const b = session.evaluate(spec, { data: { t: inserted } })
    const itemsB = (b.items[0] as { items: unknown[] }).items
    expect(itemsB).toHaveLength(9)
    expect(itemsB[0]).toBe(itemsA[0])
    expect(itemsB[1]).toBe(itemsA[1])
    expect(itemsB[2]).toBe(itemsA[2])
    expect(itemsB[4]).toBe(itemsA[3])
    expect(svgOf(b)).toBe(evalFull(spec, inserted))

    const deleted = inserted.filter((_, i) => i !== 2)
    const c = session.evaluate(spec, { data: { t: deleted } })
    expect(svgOf(c)).toBe(evalFull(spec, deleted))
  })

  it('propagates appends through filter/aggregate/window/fold/flatten', () => {
    const cases: Array<{ name: string; transform: unknown[]; a: unknown[]; b: unknown[] }> = [
      { name: 'filter', transform: [{ type: 'filter', expr: 'datum.v >= 2' }], a: points(6), b: points(9) },
      { name: 'aggregate', transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['v'] }], a: points(6), b: points(9) },
      { name: 'joinaggregate', transform: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['v'] }], a: points(6), b: points(9) },
      { name: 'window', transform: [{ type: 'window', groupby: ['g'], sort: { field: 'v' }, ops: ['rank'], as: ['v'] }], a: points(6), b: points(9) },
      { name: 'stack', transform: [{ type: 'stack', groupby: ['g'], field: 'v', as: ['v0', 'v1'] }], a: points(6), b: points(9) },
      { name: 'fold', transform: [{ type: 'fold', fields: ['v', 'w'], as: ['k', 'v'] }], a: points(3), b: points(5) },
      { name: 'flatten', transform: [{ type: 'formula', expr: '[datum.v, datum.x]', as: 'arr' }, { type: 'flatten', fields: ['arr'], as: ['v'] }], a: points(3), b: points(5) },
      { name: 'collect', transform: [{ type: 'collect', sort: { field: 'v', order: 'descending' } }], a: points(6), b: points(9) },
      { name: 'sample', transform: [{ type: 'sample', size: 3, sort: { field: 'v' } }], a: points(6), b: points(9) },
      { name: 'impute', transform: [{ type: 'impute', field: 'v', key: 'g', method: 'value', value: 0 }], a: points(6), b: points(9) },
      { name: 'pivot', transform: [{ type: 'pivot', field: 'g', value: 'v', groupby: ['x'] }], a: points(6), b: points(9) },
    ]
    for (const c of cases) {
      const spec = symbolSpec(c.a, c.transform)
      const session = createChartSession()
      session.evaluate(spec, { data: { src: c.a } })
      const inc = session.evaluate(spec, { data: { src: c.b } })
      const full = evaluateChart(compileChart(spec), { data: { src: c.b } })
      expect(svgOf(inc), c.name).toBe(svgOf(full))
    }
  })

  it('reuses unchanged groups of an incremental aggregate', () => {
    const a = points(6)
    const b = [...a, ...points(1, 6)]
    const spec = symbolSpec(a, [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['v'] }])
    const session = createChartSession()
    const first = session.evaluate(spec, { data: { src: a } })
    const itemsA = (first.items[0] as { items: unknown[] }).items
    const second = session.evaluate(spec, { data: { src: b } })
    const itemsB = (second.items[0] as { items: unknown[] }).items
    expect(svgOf(second)).toBe(evalFull(spec, b))
    // The first (unchanged) group's item is reused.
    expect(itemsB[0]).toBe(itemsA[0])
  })

  it('keeps geo and layout transforms on the mapping path', () => {
    const tree = [
      { id: 1, parent: null, v: 4 },
      { id: 2, parent: 1, v: 2 },
      { id: 3, parent: 1, v: 2 },
    ]
    const layout = (type: string): VgSpec => ({
      width: 200, height: 200, padding: 0, autosize: 'none',
      data: [
        { name: 'tree', values: tree },
        { name: 't', source: 'tree', transform: [
          { type: 'stratify', key: 'id', parentKey: 'parent' },
          { type, field: 'v', size: [100, 100], as: type === 'partition' || type === 'treemap' ? ['x0', 'y0', 'x1', 'y1'] : ['x', 'y', 'r'] },
        ] },
      ],
      marks: [{
        type: 'symbol', from: { data: 't' },
        encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 10 } } },
      }],
    } as VgSpec)
    for (const type of ['pack', 'partition', 'treemap']) {
      const spec = layout(type)
      const session = createChartSession()
      session.evaluate(spec, { data: { tree } })
      const next = [...tree, { id: 4, parent: 2, v: 1 }]
      const inc = session.evaluate(spec, { data: { tree: next } })
      const full = evaluateChart(compileChart(spec), { data: { tree: next } })
      expect(svgOf(inc), type).toBe(svgOf(full))
      expect(session.pulse()?.datasets.get('tree')?.addedRanges).toEqual([[3, 4]])
    }

    const voro = symbolSpec(points(5), [{ type: 'voronoi', x: 'x', y: 'v', size: [300, 180], as: 'path' }])
    const session = createChartSession()
    session.evaluate(voro, { data: { src: points(5) } })
    const next = points(7)
    const inc = session.evaluate(voro, { data: { src: next } })
    expect(svgOf(inc)).toBe(evalFull(voro, next))
    expect(session.pulse()?.datasets.get('src')?.addedRanges).toEqual([[5, 7]])
  })

  it('stays correct when an append extends a continuous scale domain', () => {
    const spec = symbolSpec(points(6))
    const session = createChartSession()
    session.evaluate(spec)
    const next = [...points(6), { x: 0.9, v: 100, g: 'g4', w: 1 }]
    const inc = session.evaluate(spec, { data: { t: next } })
    expect(svgOf(inc)).toBe(evalFull(spec, next))
  })

  it('accepts a same-length explicit dataPulse like dataChanges', () => {
    const a = points(6)
    const b = a.map((r, i) => (i === 1 ? { ...r, v: 9 } : r))
    const spec = symbolSpec(a)
    const chart = compileChart(spec)
    const first = evaluateChart(chart, { data: { t: a } })
    const itemsA = (first.items[0] as { items: unknown[] }).items
    const inc = evaluateChart(chart, { data: { t: b }, dataPulse: { t: { changed: [1] } } })
    const itemsB = (inc.items[0] as { items: unknown[] }).items
    expect(svgOf(inc)).toBe(evalFull(spec, b))
    expect(itemsB[0]).toBe(itemsA[0])
    expect(itemsB[2]).toBe(itemsA[2])
  })

  it('re-derives global fitters but still matches a full evaluation', () => {
    const curves: Array<{ name: string; transform: unknown[]; ext?: boolean }> = [
      { name: 'kde', transform: [{ type: 'kde', field: 'v', as: ['v'], extent: [0, 12] }] },
      { name: 'regression', transform: [{ type: 'regression', x: 'x', y: 'v', as: ['x', 'v'] }] },
      { name: 'loess', transform: [{ type: 'loess', x: 'x', y: 'v', as: ['x', 'v'] }] },
    ]
    for (const c of curves) {
      const spec = symbolSpec(points(6), c.transform)
      const session = createChartSession()
      session.evaluate(spec, { data: { src: points(6) } })
      const next = points(10)
      const inc = session.evaluate(spec, { data: { src: next } })
      expect(svgOf(inc), c.name).toBe(evalFull(spec, next))
    }
  })
})

describe('streaming and backpressure', () => {
  it('uses the initial stream snapshot', () => {
    const spec = symbolSpec(points(4))
    const stream = createChartStream(spec, { initial: { data: { t: points(4) } } })
    const flushed = stream.flush()!
    expect((flushed.scene.items[0] as { items: unknown[] }).items).toHaveLength(4)
  })

  it('coalesces queued appends into one explicit pulse', () => {
    const spec = symbolSpec(points(4))
    const stream = createChartStream(spec, { capacity: 2, policy: 'coalesce' })
    expect(stream.push({ append: { t: points(2, 4) } })).toBe(true)
    expect(stream.push({ append: { t: points(2, 6) } })).toBe(true)
    expect(stream.stats()).toMatchObject({ depth: 1, coalesced: 1 })
    const pending = stream.pending()
    expect(pending.datasets.get('t')?.addedRanges).toEqual([[4, 8]])
    const flush = stream.flush()!
    expect(flush.batches).toBe(1)
    expect(flush.pulse.datasets.get('t')?.addedRanges).toEqual([[4, 8]])
    expect(svgOf(flush.scene)).toBe(evalFull(spec, points(8)))
  })

  it('honors an explicit pulse without diffing the snapshot', () => {
    const spec = symbolSpec(points(4))
    const stream = createChartStream(spec)
    const append = points(2, 4)
    stream.push({
      append: { t: append },
      pulse: { t: { changed: [], from: [0, 1, 2, 3, -1, -1], added: [[4, 6]], removed: [] } },
    })
    const pending = stream.pending()
    expect(pending.datasets.get('t')?.from).toEqual([0, 1, 2, 3, -1, -1])
    const flush = stream.flush()!
    expect(flush.pulse.datasets.get('t')?.addedRanges).toEqual([[4, 6]])
  })

  it('drops newest/oldest batches and reports typed backpressure', () => {
    const spec = symbolSpec(points(2))
    const newest = createChartStream(spec, { capacity: 1, policy: 'drop-newest' })
    expect(newest.push({ append: { t: points(1, 2) } })).toBe(true)
    expect(newest.push({ append: { t: points(1, 3) } })).toBe(false)
    expect(newest.stats()).toMatchObject({ depth: 1, dropped: 1 })
    expect(newest.canAccept()).toBe(false)
    newest.close()
    expect(newest.push({ append: { t: points(1, 4) } })).toBe(false)

    const oldest = createChartStream(spec, { capacity: 1, policy: 'drop-oldest' })
    oldest.push({ append: { t: points(1, 2) } })
    oldest.push({ append: { t: points(1, 3) } })
    expect(oldest.stats()).toMatchObject({ depth: 1, dropped: 1 })
    expect(oldest.flush()).not.toBeNull()

    const errors = createChartStream(spec, { capacity: 1, policy: 'error' })
    errors.push({ append: { t: points(1, 2) } })
    expect(() => errors.push({ append: { t: points(1, 3) } })).toThrow(AsterStreamBackpressureError)
  })

  it('handles replace and delete snapshots through the queue', () => {
    const spec = symbolSpec(points(5))
    const stream = createChartStream(spec)
    stream.push({ data: { t: points(5) } })
    stream.flush()
    stream.push({ append: { t: points(2, 5) } })
    const appended = stream.flush()!
    expect(svgOf(appended.scene)).toBe(evalFull(spec, points(7)))

    const deleted = points(7).filter((_, i) => i !== 2)
    stream.push({ data: { t: deleted } })
    const removed = stream.flush()!
    expect(svgOf(removed.scene)).toBe(evalFull(spec, deleted))
    expect(removed.pulse.datasets.get('t')?.removedRanges).toEqual([[2, 3]])
  })

  it('treats a signal-only batch as a normal re-evaluation', () => {
    const spec = { ...symbolSpec(points(2)), signals: [{ name: 'pad', value: 1 }] } as VgSpec
    const stream = createChartStream(spec)
    stream.push({ width: 400 })
    const flush = stream.flush()!
    expect(flush.scene).toBeTruthy()
    expect(flush.pulse.datasets.size).toBe(0)
  })
})
