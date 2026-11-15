/**
 * A row pass (`exprRows`): an expression evaluated over many rows with the same signals, as a filter or a formula runs it. Each
 * signal it names is read once, when the pass starts, instead of once per row and read; the values are those of one evaluation per
 * row. That holds only while nothing in the pass can write a signal, and only for the engine's own signal objects, so:
 *  - a pass reads each signal once (the work this saves), and a new pass reads it again (a value kept from a pass never outlives it);
 *  - a tree that calls anything that might write a signal (a dataset read, a host function), or whose call now resolves to such a
 *    function, reads every signal live, row by row;
 *  - a host's own parameter object (a getter, a proxy) is read row by row, as before;
 *  - the engine's filter and formula steps do evaluate their rows as passes over the engine's own signals.
 */
import { describe, expect, it, vi } from 'vitest'
import { compileExpr, engineParams, exprRows, registerExpressionFunction, type ExpressionRuntime } from './expression.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'

/** Which signal objects the engine marked as its own, and the parameters of each pass a step prepared. */
const seen = vi.hoisted(() => ({ marked: new Set<object>(), passes: [] as Array<object | undefined> }))
vi.mock('./expression.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./expression.js')>()
  return {
    ...real,
    engineParams: <T extends Record<string, unknown>>(p: T): T => { seen.marked.add(p); return real.engineParams(p) },
    exprRows: (fn: Parameters<typeof real.exprRows>[0], params: Record<string, unknown> | undefined) => { seen.passes.push(params); return real.exprRows(fn, params) },
  }
})
import { compileExpression } from './expr-interpreter.js'
import { parseExpression } from './expr-parser.js'

const rt = { scale: () => undefined, data: () => [], expr: () => () => undefined } as unknown as ExpressionRuntime
const rows = Array.from({ length: 50 }, (_, i) => ({ x: i, s: `r${i}` }))

/** Signal parameters that count how many times each signal is read (an own-property test or a get). */
function counted(values: Record<string, unknown>): { params: Record<string, unknown>; reads: () => number } {
  let reads = 0
  const params = new Proxy(Object.assign(Object.create(null) as Record<string, unknown>, values), {
    get(t, k) { if (typeof k === 'string') reads++; return t[k as string] },
    getOwnPropertyDescriptor(t, k) { if (typeof k === 'string') reads++; return Object.getOwnPropertyDescriptor(t, k) },
  })
  return { params, reads: () => reads }
}

describe('a row pass reads each signal once', () => {
  it('reads the signals of a filter predicate once per pass, not per row', () => {
    const fn = compileExpr('lo != null && datum.x >= lo && datum.x <= hi', rt)
    const { params, reads } = counted({ lo: 10, hi: 20 })
    const row = exprRows(fn, engineParams(params))
    expect(rows.filter((r) => row(r)).map((r) => r.x)).toEqual(Array.from({ length: 11 }, (_, i) => 10 + i))
    // an own-property test and a read per signal, once
    expect(reads()).toBe(4)
  })

  it('reads them once whatever the tree calls, when every call is one that cannot write a signal', () => {
    const fn = compileExpr('format(datum.x * k, ",.1f") + upper(tag) + (isValid(datum.s) ? clamp(datum.x, 0, k) : 0)', rt)
    const { params, reads } = counted({ k: 3, tag: 'a' })
    const row = exprRows(fn, engineParams(params))
    const single = (r: unknown): unknown => fn(r, { k: 3, tag: 'a' })
    for (const r of rows) expect(row(r)).toBe(single(r))
    expect(reads()).toBe(4)
  })

  it('a new pass reads the signals again: a value read for one pass is not the next pass\'s', () => {
    const fn = compileExpr('datum.x <= hoverX', rt)
    const params = engineParams(Object.assign(Object.create(null) as Record<string, unknown>, { hoverX: 5 }))
    const first = exprRows(fn, params)
    expect(rows.filter((r) => first(r))).toHaveLength(6)
    params.hoverX = 30
    expect(rows.filter((r) => exprRows(fn, params)(r))).toHaveLength(31)
  })

  it('a host\'s own parameter object is read per row, as one evaluation reads it', () => {
    const fn = compileExpr('datum.x <= hoverX', rt)
    const { params, reads } = counted({ hoverX: 5 })
    const row = exprRows(fn, params)
    rows.forEach((r) => row(r))
    expect(reads()).toBe(2 * rows.length)
  })
})

describe('a tree that might write a signal reads every signal live', () => {
  it('a dataset read (it may derive a dataset whose transforms write a signal)', () => {
    const params = engineParams(Object.assign(Object.create(null) as Record<string, unknown>, { n: 0 }))
    // a runtime whose `data` writes a signal, as deriving a dataset with an `extent` or `bin` signal does
    const writing = { ...rt, data: () => { params.n = (params.n as number) + 1; return [] } } as unknown as ExpressionRuntime
    const fn = compileExpr('length(data("d")) + n', writing)
    const row = exprRows(fn, params)
    expect(rows.slice(0, 4).map((r) => row(r))).toEqual([1, 2, 3, 4])
  })

  it('a function the host registered', () => {
    const params = engineParams(Object.assign(Object.create(null) as Record<string, unknown>, { n: 0 }))
    const dispose = registerExpressionFunction('bumpN', () => { params.n = (params.n as number) + 1; return 0 })
    try {
      const fn = compileExpr('bumpN() + n', rt)
      const row = exprRows(fn, params)
      expect(rows.slice(0, 4).map((r) => row(r))).toEqual([1, 2, 3, 4])
    } finally {
      dispose()
    }
  })

  it('a call that resolved to a default function when compiled and resolves to another when the pass starts', () => {
    const functions: Record<string, unknown> = {}
    const evaluate = compileExpression(functions, parseExpression('abs(n) + n'))
    const params = engineParams(Object.assign(Object.create(null) as Record<string, unknown>, { n: -1 }))
    expect(exprRowsOf(evaluate, params)).toEqual([0, 0, 0])
    // the table now holds a function of the host's under that name, which writes the signal
    functions.abs = (v: number) => { params.n = (params.n as number) + 10; return v }
    params.n = 0
    // each row reads `n` after the call wrote it: 0 + 10, 10 + 20, 20 + 30
    expect(exprRowsOf(evaluate, params)).toEqual([10, 30, 50])
  })
})

describe('the engine\'s steps evaluate their rows as passes', () => {
  it('a filter and a formula, over the rows of a dataset, as one pass each over the engine\'s own signals', () => {
    const spec = {
      signals: [{ name: 'hoverX', value: 20 }],
      data: [{
        name: 't', values: rows,
        transform: [{ type: 'filter', expr: 'hoverX != null && datum.x <= hoverX' }, { type: 'formula', expr: 'datum.x * 2 + hoverX', as: 'y' }],
      }],
    }
    seen.marked.clear()
    seen.passes.length = 0
    evaluateChart(compileChart(spec as never), { signals: { hoverX: 3 } })
    expect(seen.passes.length).toBe(2)
    for (const p of seen.passes) expect(p !== undefined && seen.marked.has(p)).toBe(true)
  })
})

function exprRowsOf(evaluate: ReturnType<typeof compileExpression>, params: Record<string, unknown>): unknown[] {
  const row = evaluate.rows(params)
  return [0, 1, 2].map((i) => row({ i }))
}
