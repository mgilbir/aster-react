import { describe, it, expect } from 'vitest'
import { compileExpr, type ExpressionRuntime, type CompiledExpr } from './expression.js'

const runtime: ExpressionRuntime = {
  scale: (n: string): ((value: unknown) => unknown) | undefined =>
    n === 'x' ? ((v: unknown) => Number(v) * 2) : undefined,
  data: (): never[] => [],
  expr: (e: string): CompiledExpr => compileExpr(e, runtime),
}

describe('expression', () => {
  it('toNumber converts string to number', () => {
    const fn = compileExpr('toNumber(datum["x"])', runtime)
    expect(fn({ x: '42' })).toBe(42)
  })

  it('isValid && isFinite returns true for number, false for null', () => {
    const fn = compileExpr('isValid(datum["x"]) && isFinite(+datum["x"])', runtime)
    expect(fn({ x: 5 })).toBe(true)
    expect(fn({ x: null })).toBeFalsy()
  })

  it('ceil(width/40) → 10 with params {width:400}', () => {
    const fn = compileExpr('ceil(width/40)', runtime)
    expect(fn({}, { width: 400 })).toBe(10)
  })

  it('scale("x", datum.v) + 1 for v=21 → 43', () => {
    const fn = compileExpr('scale("x", datum.v) + 1', runtime)
    expect(fn({ v: 21 })).toBe(43)
  })

  it('monthFormat(2) returns a non-empty string', () => {
    const fn = compileExpr('monthFormat(2)', runtime)
    const result = fn({}) as string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
