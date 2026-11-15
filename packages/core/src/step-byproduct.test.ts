/**
 * The state an aggregate, joinaggregate, collect or flatten step leaves for the next pulse is made of what the step computed of its
 * rows as it ran (step-byproduct.ts), not derived again after it:
 *  - it is exactly the state `deriveStepState` derives, over generated rows and parameters (groups with nested, missing, null and
 *    mixed-type keys, a cross, sorts by one and two fields in either order, flattens of uneven arrays);
 *  - each row's group-by, sort and flatten fields are read once per step, by the step, instead of again for the state;
 *  - the state describes the rows as the step read them, even if they change in place right after (rows may be the host's);
 *  - a step whose parameters were resolved from signals, or that groups by a custom key, derives its state as before.
 */
import { describe, expect, it } from 'vitest'
import { applyOneWithState, deriveStepState } from './incremental-state.js'
import type { StepTransformContext } from './runtime.js'
import type { CompiledTransform } from './types.js'
import type { Row } from './transform-agg.js'

const rt = { scale: () => undefined, data: () => [], expr: () => () => undefined }
const tctx = (): StepTransformContext => ({ runtime: rt as never, signals: Object.create(null) as Record<string, unknown>, datasets: () => undefined })

/** A small deterministic generator (an LCG). */
function rng(seed: number): { int: (n: number) => number; pick: <T>(xs: readonly T[]) => T; chance: (p: number) => boolean } {
  let s = seed >>> 0
  const next = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  return { int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)]!, chance: (p) => next() < p }
}

const VALUES: unknown[] = [null, undefined, NaN, 0, -0, 1, 2, '1', 'a', 'b', '', true, false, 1.5, new Date(0), [1, 2]]

function genRows(r: ReturnType<typeof rng>, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const row: Row = { i, a: r.pick(VALUES), b: r.pick(['x', 'y', 'z', null]), v: r.int(10), 'c.d': r.pick(VALUES), o: { k: r.pick(['p', 'q', undefined]) } }
    // (a flatten fails on a field that holds no array, as vega's does: the fields it reads are arrays, some empty)
    row.arr = Array.from({ length: r.int(4) }, () => r.int(5))
    row.arr2 = Array.from({ length: r.int(3) }, () => r.pick(['s', 't', null]))
    if (r.chance(0.1)) delete row.a
    return row
  })
}

function genTransform(r: ReturnType<typeof rng>): CompiledTransform {
  const groupby = r.pick<unknown>([undefined, [], ['a'], ['b'], ['a', 'b'], ['o.k'], ['c\\.d'], ['b', 'o.k', 'a'], 'b'])
  switch (r.int(4)) {
    case 0: {
      const [fields, ops] = r.pick<[unknown, unknown]>([[undefined, undefined], [['v'], ['sum']], [['v', 'v'], ['max', 'argmax']], [[null], ['count']]])
      // (a cross over two plain fields: its empty cells come after the groups made of rows)
      return r.chance(0.2) ? { type: 'aggregate', groupby: ['a', 'b'], fields, ops, cross: true } as never : { type: 'aggregate', groupby, fields, ops } as never
    }
    case 1: return { type: 'joinaggregate', groupby, fields: ['v'], ops: [r.pick(['sum', 'count', 'mean'])], as: ['m'] } as never
    case 2: return {
      type: 'collect',
      sort: r.pick<unknown>([undefined, { field: 'a' }, { field: 'v', order: 'descending' }, { field: ['b', 'a'], order: ['ascending', 'descending'] }, { field: 'o.k' }, { field: 'missing' }]),
    } as never
    default: return { type: 'flatten', fields: r.pick([['arr'], ['arr', 'arr2'], ['arr2']]), as: r.pick([undefined, ['x'], ['x', 'y']]) } as never
  }
}

describe('a step\'s state is made of what the step computed', () => {
  it('equals the state derived after the step, over generated rows and parameters', () => {
    const r = rng(0x5eed)
    let byKind: Record<string, number> = {}
    for (let c = 0; c < 600; c++) {
      const rows = genRows(r, r.int(40))
      const t = genTransform(r)
      const ctx = tctx()
      const { rows: out, state } = applyOneWithState(rows, t, ctx, 'src')
      expect(state, `${JSON.stringify(t)} #${c}`).toEqual(deriveStepState(t, rows, out, ctx))
      byKind = { ...byKind, [t.type as string]: (byKind[t.type as string] ?? 0) + 1 }
    }
    for (const kind of ['aggregate', 'joinaggregate', 'collect', 'flatten']) expect(byKind[kind]).toBeGreaterThan(100)
  })

  it('reads each row\'s fields once per step, not again for the state', () => {
    for (const t of [
      { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['argmax'] },
      { type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] },
      { type: 'collect', sort: { field: 'g' } },
      { type: 'flatten', fields: ['g'] },
    ] as CompiledTransform[]) {
      let reads = 0
      const rows: Row[] = Array.from({ length: 30 }, (_, i) => {
        const row: Row = { v: i }
        const g = t.type === 'flatten' ? [i % 3, 1] : `k${i % 4}`
        Object.defineProperty(row, 'g', { enumerable: true, get: () => { reads++; return g } })
        return row
      })
      applyOneWithState(rows, t, tctx(), 'src')
      // (an aggregate also reads the first row of each of its 4 groups for the group's output row; a joinaggregate reads each row
      // once as it copies it, and groups the copies, whose `g` is plain data; a flatten copies each row once per element it makes,
      // two here, which reads `g` again)
      const own = { aggregate: rows.length + 4, joinaggregate: rows.length, collect: rows.length, flatten: rows.length * 3 }
      expect(reads, String(t.type)).toBe(own[t.type as keyof typeof own])
    }
  })

  it('describes the rows as the step read them, whatever they hold afterwards', () => {
    const rows: Row[] = [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'a', v: 3 }]
    const t = { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] } as CompiledTransform
    const { rows: out, state } = applyOneWithState(rows, t, tctx(), 'src')
    const expected = deriveStepState(t, rows, out, tctx())
    rows[0]!.g = 'b'
    expect(state).toEqual(expected)
    expect((state as { rowKey: string[] }).rowKey).toEqual(['a', 'b', 'a'])
  })

  it('a step that groups by a custom key, or read parameters resolved from signals, derives its state as before', () => {
    const rows: Row[] = [{ g: 'a', h: 'x', v: 1 }, { g: 'b', h: 'x', v: 2 }]
    const keyed = { type: 'aggregate', groupby: ['g'], key: 'h', fields: ['v'], ops: ['sum'] } as CompiledTransform
    const a = applyOneWithState(rows, keyed, tctx(), 'src')
    expect(a.state).toEqual(deriveStepState(keyed, rows, a.rows, tctx()))
    expect((a.state as { rowKey: string[] }).rowKey).toEqual(['a', 'b'])
    const ctx = tctx()
    ctx.signals.by = 'g'
    const signalled = { type: 'collect', sort: { field: { signal: 'by' } } } as CompiledTransform
    const b = applyOneWithState(rows, signalled, ctx, 'src')
    expect(b.state).toEqual(deriveStepState(signalled, rows, b.rows, ctx))
  })
})
