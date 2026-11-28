// @vitest-environment node
/**
 * A hand-built `CompiledChart` whose mark has an `enter` set and no `update` (compileChart merges enter into update, so only a
 * hand-built chart has one): a group mark is encoded with it, as a leaf mark is (C542).
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, type CompiledChart } from './index.js'

describe('a mark with an enter set only (C542)', () => {
  for (const type of ['group', 'rect'] as const) {
    it(`${type}: encoded with its enter set`, () => {
      const chart = compileChart({ width: 100, height: 100, marks: [{ type, encode: { enter: { x: { value: 7 }, y: { value: 9 }, width: { value: 30 }, height: { value: 20 } } } }] } as never) as CompiledChart
      const mark = chart.marks[0]!
      // (the hand-built form: the enter set, no update)
      const handBuilt = { ...chart, marks: [{ ...mark, encode: { enter: mark.encode!.update! } }] } as CompiledChart
      const scene = evaluateChart(handBuilt)
      const node = scene.items[0]!
      const item = (type === 'group' ? node : node.items![0]!) as { x?: number; y?: number; width?: number }
      expect([item.x, item.y, item.width]).toEqual([7, 9, 30])
    })
  }
})
