import { describe, it, expect } from 'vitest'
import { applyTransforms } from './transform.js'
import { sortBySpec } from './transform-agg.js'
import { orderOf } from './tuple-order.js'
import { compileExpr } from './expression.js'

const runtime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}
const ctx = { runtime, signals: {} as Record<string, unknown> }
const rows = (): Array<{ v: number; g: string }> => [{ v: 3, g: 'b' }, { v: 1, g: 'a' }, { v: 3, g: 'a' }, { v: 2, g: 'b' }]

describe('the order rows were made in is left behind only by the sort that was asked to', () => {
  it('a plain sort leaves nothing behind', () => {
    expect(orderOf(sortBySpec(rows(), { field: 'v' })!)).toBeNull()
  })

  it('a collect with a sort after it leaves the order behind; a collect that nothing sorts after does not', () => {
    const after = applyTransforms(rows(), [{ type: 'collect', sort: { field: 'v' } }, { type: 'collect', sort: { field: 'g' } }], ctx)
    expect(after.map((r) => `${r.g}${r.v}`)).toEqual(['a1', 'a3', 'b3', 'b2'])
    const only = applyTransforms(rows(), [{ type: 'collect', sort: { field: 'v' } }], ctx)
    expect(orderOf(only)).toBeNull()
  })

  it('the order rides along the transforms that keep their rows, and ends at one that makes new rows', () => {
    // ties of the last sort fall back to the order the rows were made in, though a collect and a formula moved/rewrote them
    const kept = applyTransforms(rows(), [{ type: 'collect', sort: { field: 'v' } }, { type: 'formula', expr: 'datum.v', as: 'w' }, { type: 'collect', sort: { field: 'g' } }], ctx)
    expect(kept.map((r) => `${r.g}${r.v}`)).toEqual(['a1', 'a3', 'b3', 'b2'])
    // a fold makes new rows: the order the earlier collect left is not theirs
    const folded = applyTransforms(rows(), [{ type: 'collect', sort: { field: 'v' } }, { type: 'fold', fields: ['v'], as: ['k', 'val'] }, { type: 'collect', sort: { field: 'g' } }], ctx)
    expect(folded.map((r) => `${r.g}${r.val}`)).toEqual(['a1', 'a3', 'b2', 'b3'])
  })

  it('a transform that fails before its sort runs does not make the NEXT, unrelated sort leave an order behind', () => {
    // the first collect is the one a sort follows, so it is asked for the order; its `order` signal does not parse, so it throws
    // before it sorts anything
    const failing = [{ type: 'collect', sort: { field: 'v', order: { signal: '1 +' } } }, { type: 'collect', sort: { field: 'g' } }]
    expect(() => applyTransforms(rows(), failing as never, ctx)).toThrow()
    const unrelated = sortBySpec(rows(), { field: 'v' })!
    expect(orderOf(unrelated)).toBeNull()
  })
})
