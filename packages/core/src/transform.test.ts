import { describe, it, expect } from 'vitest'
import { applyTransforms, sortRows } from './transform.js'
import { compileExpr } from './expression.js'

const runtime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}
const ctx = { runtime, signals: {} as Record<string, unknown> }

describe('transform', () => {
  describe('applyTransforms', () => {
    it('formula adds a new field', () => {
      const rows = [{ a: 3, b: 4 }, { a: 10, b: 20 }]
      const result = applyTransforms(rows, [{ type: 'formula', expr: 'datum.a + datum.b', as: 'c' }], ctx)
      expect(result[0]!.c).toBe(7)
      expect(result[1]!.c).toBe(30)
    })

    it('filter keeps matching rows', () => {
      const rows = [{ v: 2 }, { v: 0 }, { v: 5 }]
      const result = applyTransforms(rows, [{ type: 'filter', expr: 'datum.v > 1' }], ctx)
      expect(result).toHaveLength(2)
      expect(result[0]!.v).toBe(2)
      expect(result[1]!.v).toBe(5)
    })

    it('stack groups with offset zero', () => {
      const rows = [
        { x: 'a', y: 1 },
        { x: 'a', y: 2 },
        { x: 'b', y: 5 },
      ]
      const result = applyTransforms(rows, [{ type: 'stack', groupby: ['x'], field: 'y', as: ['y0', 'y1'], offset: 'zero' }], ctx)
      // group 'a': row 1 → y0=0,y1=1; row 2 → y0=1,y1=3
      // group 'b': row 1 → y0=0,y1=5
      expect(result).toHaveLength(3)
      const aRows = result.filter((r) => r.x === 'a')
      expect(aRows[0]!.y0).toBe(0)
      expect(aRows[0]!.y1).toBe(1)
      expect(aRows[1]!.y0).toBe(1)
      expect(aRows[1]!.y1).toBe(3)
      expect(result[2]!.y0).toBe(0)
      expect(result[2]!.y1).toBe(5)
    })

    it('aggregate sums per group', () => {
      const rows = [
        { x: 'a', v: 10 },
        { x: 'a', v: 20 },
        { x: 'b', v: 30 },
      ]
      const result = applyTransforms(rows, [{ type: 'aggregate', groupby: ['x'], fields: ['v'] as [string], ops: ['sum'] as [string], as: ['sum'] }], ctx)
      expect(result).toHaveLength(2)
      const aRow = result.find((r) => r.x === 'a')
      expect(aRow!.sum).toBe(30)
      const bRow = result.find((r) => r.x === 'b')
      expect(bRow!.sum).toBe(30)
    })

    it('window running sum in sort order', () => {
      const rows = [
        { t: 3, v: 30 },
        { t: 1, v: 10 },
        { t: 2, v: 20 },
      ]
      const result = applyTransforms(
        rows,
        [{ type: 'window', sort: { field: 't' }, fields: ['v'] as [string], ops: ['sum'] as [string], as: ['csum'] }],
        ctx,
      )
      expect(result[0]!.csum).toBe(10)
      expect(result[1]!.csum).toBe(30)
      expect(result[2]!.csum).toBe(60)
    })

    it('impute on complete rows → unchanged', () => {
      const rows = [{ key: 1, val: 10 }, { key: 2, val: 20 }]
      const result = applyTransforms(rows, [{ type: 'impute', field: 'val', key: 'key', method: 'value', value: 0 }], ctx)
      expect(result).toHaveLength(2)
      expect(result[0]!.val).toBe(10)
      expect(result[1]!.val).toBe(20)
    })

    it('impute fills numeric gap', () => {
      const rows = [{ y: 2019, v: 10 }, { y: 2021, v: 30 }]
      const result = applyTransforms(rows, [{ type: 'impute', field: 'v', key: 'y', method: 'value', value: 0 }], ctx)
      const gap = result.find((r) => r.y === 2020)
      expect(gap).toBeDefined()
      expect(gap!.v).toBe(0)
    })

    it('sortRows ascending', () => {
      const rows = [{ v: 3 }, { v: 1 }, { v: 2 }]
      const result = sortRows(rows, { field: 'v', order: 'ascending' })
      expect(result[0]!.v).toBe(1)
      expect(result[1]!.v).toBe(2)
      expect(result[2]!.v).toBe(3)
    })

    it('sortRows descending', () => {
      const rows = [{ v: 3 }, { v: 1 }, { v: 2 }]
      const result = sortRows(rows, { field: 'v', order: 'descending' })
      expect(result[0]!.v).toBe(3)
      expect(result[1]!.v).toBe(2)
      expect(result[2]!.v).toBe(1)
    })
  })
})
