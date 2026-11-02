/**
 * LIVE differential for the plain built-ins an expression names: the Math functions, `min` / `max`, `isNaN` / `isFinite`, `upper` /
 * `lower` / `trim` and `now`. Aster's expression library answers these from one table (`DefaultFunctions` in `expr-interpreter.ts`, held
 * against vega-interpreter by `differential-vega-expression*.test.mts`); this test holds the same names through the path a spec takes
 * (`compileExpr` with the host's function table) against the pinned real Vega, evaluated as a signal expression of a `View`, on the same
 * inputs in one process, compared with the strict `exact` image (NaN is not undefined, -0 is not 0).
 *
 * The inputs are every kind a spec can feed in: null, undefined, '', numbers (NaN, +-Infinity, -0, integers, fractions, huge), numeric
 * and non-numeric strings, booleans, arrays, objects, Dates.
 */
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import { compileExpr, type ExpressionRuntime } from '../../core/src/expression.ts'
import { exact, quietLogger } from './differential-util.mts'

vi.setConfig({ testTimeout: 60_000 })

const runtime: ExpressionRuntime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}

const NAMES = ['a', 'b', 'c', 'd', 'e'] as const
const spec = (code: string): vega.Spec => ({
  signals: [...NAMES.map((name) => ({ name, value: null })), { name: 'out', update: code }],
})

async function viaVega(code: string, args: unknown[]): Promise<unknown> {
  const errors: unknown[][] = []
  const view = new vega.View(vega.parse(spec(code)), { logger: quietLogger(errors) as never })
  args.forEach((v, i) => view.signal(NAMES[i]!, v))
  await view.runAsync()
  if (errors.length) return { $: 'throw' }
  return exact(() => view.signal('out'))
}
function viaAster(code: string, args: unknown[]): unknown {
  const params: Record<string, unknown> = {}
  args.forEach((v, i) => { params[NAMES[i]!] = v })
  const got = exact(() => compileExpr(code, runtime)(undefined, params)) as { $?: string } | null
  // the dataflow logs an operator error and keeps going; only that a call threw is compared
  return got?.$ === 'throw' ? { $: 'throw' } : got
}
const call = (fn: string, n: number) => `${fn}(${NAMES.slice(0, n).join(', ')})`

const VALUES: unknown[] = [
  null, undefined, '', 0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, 2, 10, 255, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, NaN, Infinity, -Infinity,
  '0', '3.7', ' 12 ', '1e3', '0x10', 'abc', 'ABC', '  padded  ', '\t tab\n', 'Straße', 'İ', 'ǅ', 'ß', ' nbsp ',
  true, false, [], [4], [1, 2], ['9'], {}, { valueOf: () => 7 }, { toString: () => ' Obj ' }, new Date(0), new Date(NaN),
]
const UNARY = [
  'abs', 'acos', 'asin', 'atan', 'ceil', 'cos', 'exp', 'floor', 'log', 'round', 'sin', 'sqrt', 'tan',
  'isNaN', 'isFinite', 'upper', 'lower', 'trim',
]
const BINARY = ['atan2', 'pow']
const SPREAD = ['min', 'max']

describe('plain built-ins vs real vega (live)', () => {
  for (const fn of UNARY) {
    it(`${fn}(x)`, async () => {
      for (const v of VALUES) {
        expect(viaAster(call(fn, 1), [v]), `${fn}(${String(typeof v === 'object' ? JSON.stringify(v) : v)})`).toEqual(await viaVega(call(fn, 1), [v]))
      }
    })
  }
  for (const fn of [...BINARY, ...SPREAD]) {
    it(`${fn}(x, y)`, async () => {
      for (const x of VALUES) for (const y of VALUES.filter((_, i) => i % 3 === 0)) {
        expect(viaAster(call(fn, 2), [x, y]), `${fn}(${String(x)}, ${String(y)})`).toEqual(await viaVega(call(fn, 2), [x, y]))
      }
    })
  }
  for (const fn of SPREAD) {
    it(`${fn}(...) with no, one and several arguments`, async () => {
      for (const args of [[], [3], [3, 1, 2], [1, NaN, 2], [null, 1], ['4', 2, '10'], [-0, 0], [0, -0], [1, 2, 3, 4, 5]]) {
        const code = call(fn, args.length)
        expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
      }
    })
  }
  it('now() is the clock', () => {
    const before = Date.now()
    const got = compileExpr('now()', runtime)(undefined, {}) as number
    expect(typeof got).toBe('number')
    expect(got).toBeGreaterThanOrEqual(before)
    expect(got).toBeLessThanOrEqual(Date.now())
  })
})
