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

describe('expression — function library (oracle-calibrated)', () => {
  const scaleObj = Object.assign((v: unknown) => Number(v) * 2, {
    domain: () => [0, 10],
    range: () => [0, 20],
    invert: (v: unknown) => Number(v) / 2,
    bandwidth: () => 3,
  })
  const rt: ExpressionRuntime = {
    scale: (n: string) => (n === 'x' ? (scaleObj as never) : undefined),
    data: (n: string) => (n === 't' ? [{ a: 1 }, { a: 2 }] : undefined),
    expr: (e: string): CompiledExpr => compileExpr(e, rt),
  }
  const run = (e: string, d: unknown = {}, p: Record<string, unknown> = {}) => compileExpr(e, rt)(d, p)

  it('clamp / lerp', () => {
    expect(run('clamp(1.5, 0, 1)')).toBe(1)
    expect(run('lerp([0, 50], 0.5)')).toBe(25)
  })
  it('test() with string or regexp', () => {
    expect(run("test('ab', 'abc')")).toBe(true)
    expect(run('test(/^a/, "bab")')).toBe(false)
  })
  it('truncate respects align + ellipsis', () => {
    expect(run("truncate('abcdefg', 5, 'right', '~')")).toBe('abcd~')
    expect(run("truncate('abcdefg', 5, 'left', '~')")).toBe('~defg')
    expect(run("truncate('abcdefg', 5, 'center', '~')")).toBe('ab~fg')
    expect(run("truncate('abcdefg', 5)")).toBe('abcd\u2026')
  })
  it('pad respects align (default char is space)', () => {
    expect(run("pad('abc', 6, '-', 'left')")).toBe('---abc')
    expect(run("pad('abc', 6, '-', 'center')")).toBe('-abc--')
    expect(run("pad('abc', 6)")).toBe('abc   ')
  })
  it('merge() is last-wins', () => {
    expect(run('merge({a:1},{b:2},{a:3})')).toEqual({ a: 3, b: 2 })
  })
  it('coercions map null/empty to null (vega)', () => {
    expect(run("toBoolean('true')")).toBe(true)
    expect(run("toBoolean('')")).toBe(null)
    expect(run('toString("")')).toBe(null)
  })
  it('array utilities', () => {
    expect(run('peek([1,2,3])')).toBe(3)
    expect(run('span([2,5])')).toBe(3)
    expect(run('indexof([1,2,3], 2)')).toBe(1)
    expect(run('extent([3,1,2])')).toEqual([1, 3])
  })
  it('scale domain/range/invert/bandwidth', () => {
    expect(run("domain('x')")).toEqual([0, 10])
    expect(run("range('x')")).toEqual([0, 20])
    expect(run("invert('x', 10)")).toBe(5)
    expect(run("bandwidth('x')")).toBe(3)
  })
  it('date-time accessors from datetime()', () => {
    expect(run('year(datetime(2021, 2, 15))')).toBe(2021)
    expect(run('month(datetime(2021, 2, 15))')).toBe(2)
    expect(run('quarter(datetime(2021, 2, 15))')).toBe(1)
    expect(run('utcyear(utc(2021, 2, 15))')).toBe(2021)
  })
  it('indata returns match count', () => {
    expect(run("indata('t', 'a', 1)")).toBe(1)
    expect(run("indata('t', 'a', 99)")).toBeUndefined()
  })
  it('color functions return color objects', () => {
    expect(String(run("rgb('#f00')"))).toMatch(/rgb|#ff0000/i)
    expect(run('luminance("white")')).toBeCloseTo(1, 3)
  })
})
