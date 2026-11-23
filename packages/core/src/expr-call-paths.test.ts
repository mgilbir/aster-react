/**
 * Every check of the expression evaluator, on every path a call can take.
 *
 * A call is evaluated one of several ways: a function of Aster's own tables (which never reads `this`) is called directly, with a
 * closure per arity (none, one, two, three, more) and one for an argument order of its own (`clamp`); anything else (a function the
 * host registered, or a table entry changed since the call was compiled) goes through `apply` with the host's `this`. Each check must
 * hold on each of them, with the same error at the same point: a function-valued argument is refused (the `is*` inspectors excepted)
 * after the arguments are evaluated, a name inherited from Object.prototype is no function and fails before any argument is
 * evaluated, a regular expression is screened, the ceilings and the clock hold, a literal member key that names an Object.prototype
 * member keeps the guarded read, and a host function still receives its `this`.
 *
 * And each holds on both ways an expression is evaluated: once, and as one row of a pass over many rows with the same signals
 * (`exprRows`, which a filter or a formula runs), where what every row reads alike is read once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileExpr, engineParams, exprRows, registerExpressionFunction, type ExpressionRuntime } from './expression.js'
import { expressionInterpreter } from './expr-interpreter.js'
import { parseExpression } from './expr-parser.js'
import { withLimits } from './limits.js'

const rt = { scale: () => undefined, data: () => [], expr: () => () => undefined }
type Run = (src: string, datum?: unknown, params?: Record<string, unknown>, runtime?: ExpressionRuntime) => unknown
/** One evaluation. */
const single: Run = (src, datum = {}, params = {}, runtime = rt as never) => compileExpr(src, runtime)(datum, params)
/** The same, as the first row of a pass over rows, with the engine's own signal parameters (the only ones a pass hoists from). */
const inPass: Run = (src, datum = {}, params = {}, runtime = rt as never) => exprRows(compileExpr(src, runtime), engineParams({ ...params }))(datum)
const PATHS: Array<[string, Run]> = [['one evaluation', single], ['a row pass', inPass]]
const thrown = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`
  }
  return 'no error'
}
const limited = <T>(f: () => T, limits: Record<string, number> = {}): T => withLimits(limits, f)

afterEach(() => vi.restoreAllMocks())

describe.each(PATHS)('on %s', (_path, run) => {
  describe('a function-valued argument is refused on every call path', () => {
    const datum = { f: () => 'called', n: null }
    // one built-in per arity (the closures differ by arity), the argument in every position, and clamp's own order
    const CALLS: Array<[string, string[]]> = [
      ['abs', ['F']],
      ['pow', ['F', '2'], ],
      ['pow', ['2', 'F']],
      ['inrange', ['F', '[1, 2]', 'true']],
      ['inrange', ['1', 'F', 'true']],
      ['inrange', ['1', '[1, 2]', 'F']],
      ['pad', ['F', '5', '"*"', '"left"']],
      ['pad', ['"a"', '5', '"*"', 'F']],
      ['max', ['1', '2', '3', '4', 'F']],
      ['clamp', ['F', '0', '1']],
      ['clamp', ['1', 'F', '1']],
      ['clamp', ['1', '0', 'F']],
    ]
    it('refuses the function wherever it is, once every argument has been evaluated', () => {
      for (const [name, args] of CALLS) {
        const src = `${name}(${args.map((a) => (a === 'F' ? 'datum.f' : a)).join(', ')})`
        expect(thrown(() => run(src, datum)), src).toBe(`Error: Function argument refused: ${name}`)
        // an argument that throws wins over the refusal: the arguments are evaluated before the check
        const throwing = `${name}(${args.map((a) => (a === 'F' ? 'datum.f' : 'datum.n.x')).join(', ')})`
        if (args.length > 1) expect(thrown(() => run(throwing, datum)), throwing).toMatch(/^TypeError: Cannot read properties of null/)
      }
    })

    it('lets the is* inspectors look at a function', () => {
      expect(run('isObject(datum.f)', datum)).toBe(true)
      expect(run('isDefined(datum.f)', datum)).toBe(true)
    })

    it('never calls the function it refuses', () => {
      const f = vi.fn(() => 1)
      for (const src of ['abs(datum.f)', 'pow(datum.f, 1)', 'clamp(datum.f, 0, 1)', 'max(1, 2, 3, datum.f)', 'join([1], datum.f)']) {
        expect(() => run(src, { f })).toThrow(/Function argument refused/)
      }
      expect(f).not.toHaveBeenCalled()
    })
  })

  describe('the function a call resolves to is read on every call', () => {
    it('a registered function receives `this` (the function table and the event functions); a built-in is called directly', () => {
      const seen: unknown[] = []
      const dispose = registerExpressionFunction('probeThis', function (this: Record<string, unknown>, ...args: unknown[]) {
        seen.push(typeof this.view, typeof this.format, args.length)
        return 'ok'
      })
      try {
        expect(run('probeThis(1, 2, 3, 4)')).toBe('ok')
        expect(run('probeThis()')).toBe('ok')
        expect(seen).toEqual(['function', 'function', 4, 'function', 'function', 0])
      } finally {
        dispose()
      }
    })

    it('a built-in is handed exactly the arguments the call has (arity is observable through `arguments.length`)', () => {
      const scale = Object.assign((v: unknown) => `s(${String(v)})`, { domain: () => [0, 1] })
      const withScale = { ...rt, scale: (name: string) => (name === 'x' ? scale : undefined) }
      const ev = (src: string): unknown => run(src, {}, {}, withScale as never)
      // `scale(name)` gives the scale itself; `scale(name, undefined)` applies it to undefined
      expect(typeof ev('scale("x")')).toBe('function')
      expect(ev('scale("x", datum.missing)')).toBe('s(undefined)')
      expect(ev('sequence(3)')).toEqual([0, 1, 2])
      expect(ev('sequence(0, 3, datum.missing)')).toEqual([])
    })
  })

  describe('regular expressions are screened on every call path', () => {
    const HAZARD = '(a+)+$'
    it('a hazardous pattern is refused under limits, given as a literal, by regexp(), or as text', () => {
      for (const src of [
        `test(/${HAZARD}/, "aaa")`, `test("${HAZARD}", "aaa")`, `regexp("${HAZARD}")`, `regexp(/${HAZARD}/, "g")`,
        `replace("aaa", /${HAZARD}/, "")`, `split("aaa", /${HAZARD}/)`, `test(regexp("${HAZARD}"), "a")`,
      ]) {
        expect(thrown(() => limited(() => run(src))), src).toMatch(/regexSafety/)
      }
    })
    it('the input of a regular expression is length-capped under limits', () => {
      expect(thrown(() => limited(() => run('test(/a/, pad("", 300, "a"))'), { maxStringLength: 100 }))).toMatch(/maxStringLength/)
      expect(thrown(() => limited(() => run('replace(pad("", 300, "a"), /a/, "b")'), { maxStringLength: 100 }))).toMatch(/maxStringLength/)
    })
  })

  describe('ceilings and the clock hold on every call path', () => {
    it('sequence and pad are bounded before they allocate', () => {
      expect(thrown(() => run('length(sequence(0, 5e8))'))).toMatch(/limit exceeded: sequence/)
      expect(thrown(() => run('length(sequence(5e8))'))).toMatch(/limit exceeded: sequence/)
      expect(thrown(() => run('length(pad("x", 5e8))'))).toMatch(/limit exceeded/)
      expect(thrown(() => run('length(pad("x", 5e7, "ab", "center"))'))).toMatch(/limit exceeded/)
    })
    it('a spent deadline stops every call that samples the clock', () => {
      const rows = Array.from({ length: 5000 }, (_, i) => ({ v: i }))
      const withData = { ...rt, data: () => rows }
      for (const src of ['indata("t", "v", 3)', 'test(/a/, "a")', 'replace("a", /a/, "b")', 'split("a,b", /,/)', 'regexp("a")']) {
        const got = thrown(() => withLimits({ maxTimeMs: 0 }, () => run(src, {}, {}, withData as never)))
        expect(got, src).toMatch(/maxTimeMs exceeded/)
      }
    })
  })

  describe('member reads keep the prototype guard when the key is a literal', () => {
    it('a literal key naming an Object.prototype member keeps the guarded read; any other literal key reads as the named form does', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const datum = { list: [1, 2], f: Function, o: { a: 1 } }
      // `datum.f` holds Function: neither form produces it, and the refusal is an error of the evaluation (reported through the
      // engine's logger as any expression error), never a console write that bypasses it (C707)
      expect(thrown(() => run('datum["f"]', datum))).toMatch(/Prevented interpretation of member "f"/)
      expect(thrown(() => run('datum.f', datum))).toMatch(/Prevented interpretation of member "f"/)
      // a risky key resolves only as an own property (C384): an array's inherited `constructor` is not read, nor anything past it
      expect(run('datum.list["constructor"]', datum)).toBeUndefined()
      expect(run('datum.list.constructor', datum)).toBeUndefined()
      expect(thrown(() => run('datum.list.constructor.constructor', datum))).toBe("TypeError: Cannot read properties of undefined (reading 'constructor')")
      expect(run('datum["o"]["a"] + datum.list[1] + datum.list["1"]', datum)).toBe(5)
      expect(errors).not.toHaveBeenCalled()
      expect(thrown(() => run('datum.n["x"]', {}))).toBe("TypeError: Cannot read properties of undefined (reading 'x')")
      expect(thrown(() => run('datum.n[0]', {}))).toBe("TypeError: Cannot read properties of undefined (reading '0')")
    })
  })
})

// These build their own host (a function table, a runtime) and read the interpreter through it: there is one path to check, not two.
describe('how a call finds its function (the interpreter\'s own table and a runtime\'s, one path each)', () => {
  describe('a name inherited from Object.prototype is no function, before any argument is evaluated', () => {
    it('fails reading `apply` off nothing, whatever the arguments would do', () => {
      const host = { functions: {} as Record<string, unknown> }
      for (const name of ['constructor', 'hasOwnProperty', 'valueOf', '__proto__', '__defineGetter__', 'isPrototypeOf']) {
        for (const args of ['', '1', 'datum.n.x', '1, 2, 3, 4']) {
          const ast = parseExpression(`${name}(${args})`)
          const got = thrown(() => expressionInterpreter.parameter(host, { ast })({ n: null }, {}))
          expect(got, `${name}(${args})`).toBe("TypeError: Cannot read properties of undefined (reading 'apply')")
        }
      }
    })
  })

  describe('the function a call resolves to is read on every call', () => {
    it('a table entry replaced after the call was compiled is called, as a host function with its `this`', () => {
      const functions: Record<string, unknown> = {}
      const ast = parseExpression('abs(-2)')
      const evaluate = expressionInterpreter.parameter({ functions }, { ast })
      expect(evaluate({}, {})).toBe(2) // the default table's own `abs`
      functions.abs = function (this: Record<string, unknown>, v: number) { return [v, typeof this.view, typeof this.abs] }
      expect(evaluate({}, {})).toEqual([-2, 'function', 'function'])
      delete functions.abs
      expect(evaluate({}, {})).toBe(2)
    })

    it('a runtime\'s function table follows the registry: a function registered or disposed after it was made is seen by the next compile', () => {
      const runtime = { ...rt }
      expect(compileExpr('abs(-1)', runtime as never)({}, {})).toBe(1) // the runtime's table is made here
      expect(() => compileExpr('lateFn(1)', runtime as never)).toThrow('Unrecognized function: lateFn')
      const dispose = registerExpressionFunction('lateFn', (v: unknown) => `late ${String(v)}`)
      try {
        expect(compileExpr('lateFn(1)', runtime as never)({}, {})).toBe('late 1')
      } finally {
        dispose()
      }
      expect(() => compileExpr('lateFn(2)', runtime as never)).toThrow('Unrecognized function: lateFn')
    })
  })
})
