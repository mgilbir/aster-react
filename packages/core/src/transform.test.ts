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

    it('pivot aggregates a value field into per-key columns', () => {
      const rows = [
        { g: 'a', cat: 'x', v: 5 },
        { g: 'a', cat: 'y', v: 3 },
        { g: 'b', cat: 'x', v: 7 },
        { g: 'b', cat: 'y', v: 1 },
      ]
      const result = applyTransforms(rows, [{ type: 'pivot', field: 'cat', value: 'v', groupby: ['g'], op: 'sum' }], ctx)
      expect(result).toHaveLength(2)
      const a = result.find((r) => r.g === 'a')!
      const b = result.find((r) => r.g === 'b')!
      // pivot keys sort ascending: x before y
      expect(a.x).toBe(5)
      expect(a.y).toBe(3)
      expect(b.x).toBe(7)
      expect(b.y).toBe(1)
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
      // vega writes results back in SOURCE order; sorting only drives the window
      expect(result[0]!.csum).toBe(60) // t=3
      expect(result[1]!.csum).toBe(10) // t=1
      expect(result[2]!.csum).toBe(30) // t=2
    })

    it('impute on complete rows → unchanged', () => {
      const rows = [{ key: 1, val: 10 }, { key: 2, val: 20 }]
      const result = applyTransforms(rows, [{ type: 'impute', field: 'val', key: 'key', method: 'value', value: 0 }], ctx)
      expect(result).toHaveLength(2)
      expect(result[0]!.val).toBe(10)
      expect(result[1]!.val).toBe(20)
    })

    it('impute fills missing keys from the cross-group domain (vega semantics)', () => {
      const rows = [{ g: 'a', y: 2019, v: 10 }, { g: 'b', y: 2021, v: 30 }]
      const result = applyTransforms(rows, [{ type: 'impute', field: 'v', key: 'y', groupby: ['g'], method: 'value', value: 0 }], ctx)
      expect(result).toHaveLength(4)
      const imputedA = result.find((r) => r.g === 'a' && r.y === 2021)
      expect(imputedA).toBeDefined()
      expect(imputedA!.v).toBe(0)
      expect(imputedA!._impute).toBe(true)
    })

    it('impute does not fabricate keys between observed values (vega semantics)', () => {
      const rows = [{ y: 2019, v: 10 }, { y: 2021, v: 30 }]
      const result = applyTransforms(rows, [{ type: 'impute', field: 'v', key: 'y', method: 'value', value: 0 }], ctx)
      expect(result.find((r) => r.y === 2020)).toBeUndefined()
      expect(result).toHaveLength(2)
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

describe('bin options (vega-statistics parity)', () => {
  const rows = [{ v: 5 }, { v: 10 }, { v: 15 }, { v: 20 }, { v: 25 }, { v: 30 }, { v: 40 }]
  const bin = (opts: Record<string, unknown>) =>
    applyTransforms(rows, [{ type: 'bin', field: 'v', as: ['b0', 'b1'], extent: [0, 40], ...opts } as never], ctx)

  it('honors steps, base, divide, minstep, span and anchor', () => {
    expect(bin({ steps: [2, 5, 10] }).map((r) => [r.b0, r.b1])).toEqual([
      [4, 6], [10, 12], [14, 16], [20, 22], [24, 26], [30, 32], [38, 40],
    ])
    expect(bin({ maxbins: 5 }).map((r) => r.b0)).toEqual([0, 10, 10, 20, 20, 30, 30])
    expect(bin({ base: 2, maxbins: 5 }).map((r) => r.b0)).toEqual([0, 8, 8, 16, 24, 24, 32])
    expect(bin({ divide: [4, 2], maxbins: 5 }).map((r) => r.b0)).toEqual([0, 10, 10, 20, 20, 30, 30])
    expect(bin({ minstep: 6, maxbins: 10 }).map((r) => r.b0)).toEqual([0, 10, 10, 20, 20, 30, 30])
    expect(bin({ span: 80, maxbins: 5 }).map((r) => r.b0)).toEqual([0, 0, 0, 20, 20, 20, 20])
    expect(bin({ step: 7, anchor: 3 }).map((r) => [r.b0, r.b1])).toEqual([
      [3, 10], [10, 17], [10, 17], [17, 24], [24, 31], [24, 31], [38, 45],
    ])
  })

  it('interval:false writes only the bin start', () => {
    const out = bin({ step: 7, interval: false }) as Record<string, unknown>[]
    expect(out[1]!.b0).toBe(7)
    expect(out[1]).not.toHaveProperty('b1')
  })

  it('coerces values like vega toNumber: null stays null, an unparseable string is NaN', () => {
    const out = applyTransforms(
      [{ v: '12' }, { v: null }, { v: 'x' }, { v: -5 }, { v: 45 }],
      [{ type: 'bin', field: 'v', as: ['b0', 'b1'], extent: [0, 40], step: 10 } as never],
      ctx,
    )
    // real vega: bin0 is NaN (not null) for 'x' -- vega-transforms Bin only maps null/'' to null
    expect(out.map((r) => r.b0)).toEqual([10, null, NaN, -Infinity, Infinity])
  })
})

describe('window options (vega Window parity)', () => {
  const rows = [
    { g: 'a', t: 1, v: 10 },
    { g: 'a', t: 2, v: 20 },
    { g: 'b', t: 1, v: 5 },
    { g: 'b', t: 3, v: 15 },
    { g: 'a', t: 3, v: 30 },
    { g: 'b', t: 2, v: 25 },
  ]
  const win = (opts: Record<string, unknown>) =>
    applyTransforms(rows, [{ type: 'window', groupby: ['g'], sort: { field: 't' }, ...opts } as never], ctx)

  it('computes rank/cume/ntile and value ops', () => {
    const ops = ['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'nth_value', 'first_value', 'last_value']
    const fields = [null, null, null, null, null, 'v', 'v', 'v', 'v', 'v', 'v']
    const params = [null, null, null, null, null, 2, 2, 1, 2, null, null]
    const out = win({ fields, ops, params, as: ['rn', 'rk', 'dr', 'pr', 'cd', 'nt', 'lag', 'lead', 'nth', 'fv', 'lv'] })
    // source order: a1, a2, b1, b3, a3, b2
    expect(out[0]).toMatchObject({ rn: 1, rk: 1, dr: 1, pr: 0, cd: 1 / 3, nt: 1, lag: null, lead: 20, nth: null, fv: 10, lv: 10 })
    expect(out[1]).toMatchObject({ rn: 2, rk: 2, dr: 2, lag: null, lead: 30, nth: 20 })
    expect(out[4]).toMatchObject({ rn: 3, rk: 3, dr: 3, cd: 1, lag: 10, lead: null, nth: 20 })
  })

  it('honors frame windows and ignorePeers', () => {
    const out = win({ fields: ['v'], ops: ['sum'], frame: [-1, 1], as: ['sum'] })
    expect(out.map((r) => r.sum)).toEqual([30, 60, 30, 40, 50, 45])
    const all = win({ fields: ['v'], ops: ['sum'], frame: [null, null], as: ['sum'] })
    expect(all.map((r) => r.sum)).toEqual([60, 60, 45, 45, 60, 45])
    const running = win({ fields: ['v'], ops: ['sum'], frame: [null, 0], ignorePeers: true, as: ['sum'] })
    expect(running.map((r) => r.sum)).toEqual([10, 30, 5, 45, 60, 30])
  })

  it('expands range frames over peer sort values', () => {
    const peerRows = [{ t: 1, v: 1 }, { t: 1, v: 2 }, { t: 2, v: 4 }]
    const out = applyTransforms(peerRows, [{ type: 'window', sort: { field: 't' }, fields: ['v', 'v'], ops: ['sum', 'rank'], as: ['sum', 'rk'] } as never], ctx)
    expect(out.map((r) => r.sum)).toEqual([3, 3, 7])
    expect(out.map((r) => r.rk)).toEqual([1, 1, 3])
  })

  it('supports prev_value and next_value', () => {
    const vRows = [{ t: 1, v: null }, { t: 2, v: 5 }, { t: 3, v: null }, { t: 4, v: 7 }]
    const out = applyTransforms(vRows, [{ type: 'window', sort: { field: 't' }, fields: ['v', 'v'], ops: ['prev_value', 'next_value'], as: ['prev', 'next'] } as never], ctx)
    expect(out.map((r) => r.prev)).toEqual([null, 5, 5, 7])
    expect(out.map((r) => r.next)).toEqual([5, 5, 7, 7])
  })
})

describe('joinaggregate key and impute keyvals', () => {
  it('key overrides groupby for the join cells', () => {
    const rows = [{ g: 'a', v: 1 }, { g: 'a', v: 3 }, { g: 'b', v: 10 }]
    const out = applyTransforms(rows, [{ type: 'joinaggregate', fields: ['v'], ops: ['mean'], as: ['m'], key: 'g' } as never], ctx)
    expect(out.map((r) => r.m)).toEqual([2, 2, 10])
  })

  it('resolves keyvals from a signal', () => {
    const localCtx = { ...ctx, signals: { kv: [1, 2, 3] } as Record<string, unknown> }
    const rows = [{ k: 1, v: 10 }]
    const out = applyTransforms(rows, [{ type: 'impute', field: 'v', key: 'k', keyvals: { signal: 'kv' }, method: 'value', value: 0 } as never], localCtx)
    expect(out.map((r) => r.k)).toEqual([1, 2, 3])
    expect(out.map((r) => r.v)).toEqual([10, 0, 0])
  })
})
