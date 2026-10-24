import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from '@aster/core'
import { SCALE_INFO_KEY, scalesFromSerialized, serializeScales } from './serialScales.js'

const specFor = (type: string, extra: Record<string, unknown> = {}, domain: unknown = [1, 100]): never => ({
  width: 200, height: 100, padding: 0, autosize: 'none',
  scales: [
    { name: 's', type, domain, range: 'width', ...extra },
    { name: 'v', type: 'linear', domain: [-5, 5], range: 'height', nice: false },
  ],
  marks: [],
}) as never

describe('serialized scales rebuild invertible scales (C30)', () => {
  for (const [type, extra, domain] of [
    ['linear', {}, [0, 10]],
    ['log', { base: 10 }, [1, 1000]],
    ['log', { base: 2 }, [1, 64]],
    ['pow', { exponent: 2 }, [0, 10]],
    ['sqrt', {}, [0, 16]],
    ['symlog', { constant: 2 }, [-10, 40]],
    ['linear', { clamp: true }, [0, 10]],
    ['time', {}, [1e12, 1.1e12]],
  ] as const) {
    it(`${type} ${JSON.stringify(extra)} matches the live scale`, () => {
      const scene = evaluateChart(compileChart(specFor(type, extra, domain)), {})
      const live = scene.__scaleMap!.get('s') as ((v: number) => number) & { invert: (p: number) => number; domain: () => unknown[] }
      const rebuilt = scalesFromSerialized(JSON.parse(JSON.stringify(serializeScales(scene.__scaleMap)))).get('s') as typeof live
      expect(rebuilt).toBeDefined()
      const d0 = Number(live.domain()[0])
      const d1 = Number(live.domain()[live.domain().length - 1])
      for (const t of [0, 0.1, 0.5, 0.9, 1]) {
        const v = d0 + (d1 - d0) * t
        expect(rebuilt(v)).toBeCloseTo(live(v), 6)
      }
      for (const p of [0, 50, 100, 200]) {
        expect(Number(rebuilt.invert(p))).toBeCloseTo(Number(live.invert(p)), 5)
      }
      expect(rebuilt.domain().map(Number)).toEqual(live.domain().map(Number))
    })
  }

  it('a descending range (y axis) inverts correctly and discrete scales are not described', () => {
    const scene = evaluateChart(compileChart({
      width: 200, height: 100, padding: 0, autosize: 'none',
      scales: [
        { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
        { name: 'c', type: 'band', domain: ['a', 'b'], range: 'width' },
      ],
      marks: [],
    } as never), {})
    const list = serializeScales(scene.__scaleMap)
    expect(list.map((s) => s.name)).toEqual(['y'])
    const y = scalesFromSerialized(list).get('y') as unknown as { (v: number): number; invert(p: number): number }
    expect(y(0)).toBe(100)
    expect(y.invert(0)).toBeCloseTo(10)
  })

  it('exposes the description under SCALE_INFO_KEY on cloneable scenes', async () => {
    const { cloneableScene } = await import('./worker.js')
    const scene = evaluateChart(compileChart(specFor('linear', {}, [0, 10])), {})
    const clone = cloneableScene(scene) as unknown as Record<string, unknown>
    expect(Array.isArray(clone[SCALE_INFO_KEY])).toBe(true)
    expect(() => structuredClone(clone)).not.toThrow()
  })
})
