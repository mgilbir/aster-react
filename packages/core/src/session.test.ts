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
