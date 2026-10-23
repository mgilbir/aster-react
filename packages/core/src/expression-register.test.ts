import { afterEach, describe, expect, it } from 'vitest'
import { compileExpr, registerExpressionFunction, renderSpec, ExpressionParseError, type ExpressionRuntime } from './index.js'

const runtime: ExpressionRuntime = { scale: () => undefined, data: () => undefined, expr: (e) => compileExpr(e, runtime) }
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const reg = (name: string, fn: (...a: never[]) => unknown): void => { cleanups.push(registerExpressionFunction(name, fn)) }

describe('registerExpressionFunction (vega expressionFunction)', () => {
  it('an expression calls a registered function with its arguments', () => {
    reg('price', ((v: number, spec: string) => `${spec}:${v * 2}`) as never)
    expect(compileExpr('price(datum.v, "$.2f")', runtime)({ v: 21 })).toBe('$.2f:42')
  })

  it('the disposer removes it, restoring what it replaced', () => {
    const off1 = registerExpressionFunction('twice', ((x: number) => x * 2) as never)
    const off2 = registerExpressionFunction('twice', ((x: number) => x * 3) as never)
    expect(compileExpr('twice(2)', runtime)({})).toBe(6)
    off2()
    expect(compileExpr('twice(2)', runtime)({})).toBe(4)
    off1()
    expect(() => compileExpr('twice(2)', runtime)).toThrow()
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

  it('an unregistered name is refused when the expression is compiled, like vega\'s codegen', () => {
    expect(() => compileExpr('nosuchfn(1)', runtime)).toThrow(ExpressionParseError)
    expect(() => compileExpr('nosuchfn(1)', runtime)).toThrow(/Unrecognized function: nosuchfn/)
  })

  it('dispose, then compile a fresh expression: refused at compile time', () => {
    const off = registerExpressionFunction('probe3', (() => 1) as never)
    expect(compileExpr('probe3(1) + 0', runtime)({})).toBe(1)
    off()
    expect(() => compileExpr('probe3(1) + 0', runtime)).toThrow(/Unrecognized function: probe3/)
  })

  it('dispose, then run an expression compiled (and cached) before: refused, not a TypeError', () => {
    const off = registerExpressionFunction('probe4', (() => 1) as never)
    const cached = compileExpr('probe4(2)', runtime)
    expect(cached({})).toBe(1)
    off()
    expect(() => cached({})).toThrow(ExpressionParseError)
    expect(() => cached({})).toThrow(/Unrecognized function: probe4/)
  })

  it('re-register after disposal: a cached closure and a fresh compile both call the new function', () => {
    const off1 = registerExpressionFunction('probe5', (() => 'old') as never)
    const cached = compileExpr('probe5()', runtime)
    off1()
    const off2 = registerExpressionFunction('probe5', (() => 'new') as never)
    cleanups.push(off2)
    expect(cached({})).toBe('new')
    expect(compileExpr('probe5()', runtime)({})).toBe('new')
  })

  it('two charts sharing the registry: disposal reaches the second, evaluation by evaluation', () => {
    const spec = (): never => ({
      width: 10, height: 10, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ a: 1 }], transform: [{ type: 'formula', as: 'x', expr: 'probe6(datum.a)' }] }],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 5 }, text: { field: 'x' } } } }],
    }) as never
    const off = registerExpressionFunction('probe6', ((v: number) => `v${v}`) as never)
    expect(renderSpec(spec())).toContain('v1')
    expect(renderSpec(spec())).toContain('v1')
    off()
    expect(() => renderSpec(spec())).toThrow(/Unrecognized function: probe6/)
    const off2 = registerExpressionFunction('probe6', ((v: number) => `w${v}`) as never)
    cleanups.push(off2)
    expect(renderSpec(spec())).toContain('w1')
  })
})
