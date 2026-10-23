import { afterEach, describe, expect, it } from 'vitest'
import { compileExpr, registerExpressionFunction, renderSpec, type ExpressionRuntime } from './index.js'

const runtime: ExpressionRuntime = { scale: () => undefined, data: () => undefined, expr: (e) => compileExpr(e, runtime) }
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const reg = (name: string, fn: (...a: never[]) => unknown): void => { cleanups.push(registerExpressionFunction(name, fn)) }

describe('registerExpressionFunction (vega expressionFunction)', () => {
  it('an expression calls a registered function with its arguments', () => {
    reg('price', ((v: number, spec: string) => `${spec}:${v * 2}`) as never)
    expect(compileExpr('price(datum.v, "$.2f")', runtime)({ v: 21 })).toBe('$.2f:42')
  })

  it('an unregistered name fails as an unknown function does', () => {
    expect(() => compileExpr('nosuchfn(1)', runtime)({})).toThrow()
  })

  it('the disposer removes it, restoring what it replaced', () => {
    const off1 = registerExpressionFunction('twice', ((x: number) => x * 2) as never)
    const off2 = registerExpressionFunction('twice', ((x: number) => x * 3) as never)
    expect(compileExpr('twice(2)', runtime)({})).toBe(6)
    off2()
    expect(compileExpr('twice(2)', runtime)({})).toBe(4)
    off1()
    expect(() => compileExpr('twice(2)', runtime)({})).toThrow()
    off1() // twice is harmless
  })

  it('refuses names an expression already means something by, and names that are not identifiers', () => {
    for (const name of ['format', 'timeFormat', 'abs', 'datum', 'event', 'PI', 'if', 'toString', 'constructor', '__proto__', '_hidden', 'a-b', '1a', '', 'a b']) {
      expect(() => registerExpressionFunction(name, (() => 1) as never), name).toThrow(/registerExpressionFunction/)
    }
    expect(() => registerExpressionFunction('ok', 'not a function' as never)).toThrow(/needs a function/)
  })

  it('a registered function reaches a chart: a text mark calls it', () => {
    reg('shout', ((s: string) => String(s).toUpperCase() + '!') as never)
    const svg = renderSpec({
      width: 50, height: 20, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ w: 'hi' }] }],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 10 }, text: { signal: 'shout(datum.w)' } } } }],
    } as never)
    expect(svg).toContain('HI!')
  })

  it('a function argument is still refused: a spec cannot hand a registered function a callable', () => {
    reg('call', ((f: unknown) => typeof f) as never)
    const rt: ExpressionRuntime = { scale: () => (() => 1) as never, data: () => undefined, expr: (e) => compileExpr(e, rt) }
    expect(() => compileExpr('call(scale("x"))', rt)({})).toThrow(/Function argument refused/)
  })
})
