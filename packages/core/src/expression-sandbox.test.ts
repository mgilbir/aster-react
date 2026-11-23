// @vitest-environment node
/**
 * The expression sandbox and the expression budgets, on the points the 2026-11-22 audit found open:
 *  - C384: a member read never hands out a built-in prototype (an inherited `__proto__` / `constructor`, a function's `prototype`);
 *  - C285: the vega-interpreter-shaped entry points call only the built-in method of a string or an array;
 *  - C530: the type inspectors are exempt from the function-argument refusal by identity, not by an `is` name prefix;
 *  - C485: an expression compiled before a registry change is compiled again once, not on every evaluation;
 *  - C89: `sequence` bounds the length it allocates, after vega's `| 0`;
 *  - C234: under limits the strings `join`, `replace`, `upper`, ... and `+` build, and the pieces `split` makes, are metered.
 */
import { describe, expect, it } from 'vitest'
import { compileExpr, registerExpressionFunction, substitution, type ExpressionRuntime } from './expression.js'
import { expressionInterpreter, interpret } from './expr-interpreter.js'
import { parseExpression } from './expr-parser.js'
import { AsterLimitError, withLimits } from './limits.js'

const rt: ExpressionRuntime = { scale: () => undefined, data: () => [], expr: (e) => compileExpr(e, rt) }
const ev = (src: string, datum: unknown = {}, params: Record<string, unknown> = {}): unknown => compileExpr(src, rt)(datum, params)
const thrown = (f: () => unknown): unknown => { try { f(); return null } catch (e) { return e } }

describe('C384: no built-in prototype is reachable by a member read', () => {
  const datum = { a: 1, list: [1, 2], s: 'x' }
  it.each([
    'datum.__proto__', 'datum["__proto__"]', 'datum.constructor', 'datum["constructor"]', 'datum.list.constructor', '[].constructor',
    "''.constructor", '(1).constructor', 'datum.list.__proto__', '{}.constructor', 'datum[["__proto__"]]', 'datum.hasOwnProperty', 'datum.toString',
  ])('%s is undefined', (src) => {
    expect(ev(src, datum)).toBeUndefined()
  })
  it('a function\'s prototype is not read either', () => {
    const scaleRt: ExpressionRuntime = { ...rt, scale: () => function scale(v: unknown) { return v } }
    expect(compileExpr("scale('x').prototype", scaleRt)({}, {})).toBeUndefined()
    expect(compileExpr("scale('x')['prototype']", scaleRt)({}, {})).toBeUndefined()
  })
  it('an own field of such a name is data', () => {
    const own = JSON.parse('{"__proto__": 5, "constructor": "c", "toString": "t"}')
    expect(ev('datum.__proto__ + datum.constructor + datum["toString"]', own)).toBe('5ct')
  })
  it('so nothing an expression hands a dataset edit or a transform can be a built-in prototype', () => {
    for (const src of ['datum.__proto__', 'datum.constructor.prototype', '[].constructor.prototype', 'datum.list.__proto__']) {
      const v = thrown(() => ev(src, datum)) ?? ev(src, datum)
      expect(v === Object.prototype || v === Array.prototype || v === Function.prototype).toBe(false)
    }
  })
})

describe('C285: the vega-interpreter-shaped entry points call only built-in methods', () => {
  const run = (src: string, datum: unknown): unknown => interpret(parseExpression(src), {}, {}, datum)
  it('a function held under a method name in an object literal is refused, not called', () => {
    let called = 0
    const datum = { f: () => { called++; return 'pwned' } }
    for (const src of ['join({join: datum.f}, 1)', 'indexof({indexOf: datum.f}, 1)', 'lastindexof({lastIndexOf: datum.f}, 1)', 'slice({slice: datum.f}, 1)']) {
      expect(String(thrown(() => run(src, datum))), src).toMatch(/Function argument refused/)
    }
    expect(called).toBe(0)
  })
  it('strings and arrays keep their methods', () => {
    expect(run('join([1, 2], "-")', {})).toBe('1-2')
    expect(run('indexof("abc", "c")', {})).toBe(2)
    expect(run('slice([1, 2, 3], 1)', {})).toEqual([2, 3])
    expect(run('substring("abc", 1)', {})).toBe('bc')
    expect(expressionInterpreter.parameter({ functions: {} }, { ast: parseExpression('split("a,b", ",")') })({}, {})).toEqual(['a', 'b'])
  })
})

describe('C530: only the built-in type inspectors may be handed a function', () => {
  it('a host function named is* is refused a function argument; the built-in inspectors are not', () => {
    let seen: unknown = 'not called'
    const dispose = registerExpressionFunction('isHoliday', (v: unknown) => { seen = v; return true })
    try {
      const scaleRt: ExpressionRuntime = { ...rt, scale: () => (v: unknown) => v }
      expect(String(thrown(() => compileExpr("isHoliday(scale('x'))", scaleRt)({}, {})))).toMatch(/Function argument refused: isHoliday/)
      expect(seen).toBe('not called')
      for (const name of ['isObject', 'isDefined', 'isValid', 'isNaN', 'isFinite', 'isString', 'isTuple']) {
        expect(thrown(() => compileExpr(`${name}(scale('x'))`, scaleRt)({}, {})), name).toBeNull()
      }
    } finally {
      dispose()
    }
  })
})

describe('C485: a registry change recompiles an expression once', () => {
  it('evaluations after an unrelated registration cost what they cost before (not a compile each)', () => {
    const f = compileExpr('datum.a * 2 + 1', rt)
    const time = (): number => {
      const t0 = performance.now()
      for (let i = 0; i < 200_000; i++) f({ a: i }, {})
      return performance.now() - t0
    }
    const before = Math.min(time(), time(), time())
    const dispose = registerExpressionFunction('unrelatedFn', () => 1)
    try {
      const after = Math.min(time(), time(), time())
      // (recompiling on every call was 100-300x slower; noise is well under 5x)
      expect(after).toBeLessThan(before * 5 + 5)
    } finally {
      dispose()
    }
  })
  it('a function disposed since compile is refused at the next evaluation, every evaluation', () => {
    const dispose = registerExpressionFunction('soonGone', () => 7)
    const f = compileExpr('soonGone()', rt)
    expect(f({}, {})).toBe(7)
    dispose()
    expect(String(thrown(() => f({}, {})))).toMatch(/Unrecognized function: soonGone/)
    expect(String(thrown(() => f({}, {})))).toMatch(/Unrecognized function: soonGone/)
  })
})

describe('C89: sequence bounds the length it allocates', () => {
  it('a count past 2^32 wraps as vega\'s does, and the wrapped length meets the ceiling', () => {
    expect(ev('length(sequence(0, 4294967296 + 5))')).toBe(5)
    // 2^32 + 3e7 wraps to 3e7 elements: over the built-in ceiling of 1e6, with or without limits
    expect(thrown(() => ev('length(sequence(0, 4294967296 + 3e7))'))).toBeInstanceOf(AsterLimitError)
    expect(thrown(() => withLimits({ maxTimeMs: 5000 }, () => ev('length(sequence(0, 4294967296 + 3e7))')))).toBeInstanceOf(AsterLimitError)
    expect(thrown(() => withLimits({ maxRows: 100 }, () => ev('length(sequence(4294967296 + 101))')))).toBeInstanceOf(AsterLimitError)
    // a count from 2^31 to 2^32 is negative after `| 0`: vega's own RangeError
    expect(String(thrown(() => ev('sequence(0, 3e9)')))).toMatch(/RangeError: Invalid array length/)
  })
})

describe('C234: strings built by expressions are metered under limits', () => {
  const limited = (src: string, params: Record<string, unknown> = {}): unknown => thrown(() => withLimits({ maxStringLength: 10_000 }, () => ev(src, {}, params)))
  const big = { s: 'a'.repeat(10_000), t: ' ' + 'a'.repeat(20_000) + ' ' }
  it.each([
    'replace(pad("", 10000, "a"), /a/g, pad("", 10000, "b"))',
    "replace(pad('', 5000, 'a'), /a/g, \"$'$'\")",
    "replace(pad('', 100, 'a'), 'a', pad('', 10000, 'b'))",
    'join(sequence(0, 10000), pad("", 10000, "b"))',
    'join(sequence(0, 2000), "abcdefghij")',
    's + s', "s + 'x'",
    // (a string longer than the cap that came in as data: what these builtins make of it is a string they built)
    'upper(t)', 'lower(t)', 'trim(t)', 'substring(t, 0)', 'slice(t, 0)', 'truncate(t, 1e6)',
  ])('%s is refused', (src) => {
    expect(limited(src, big)).toBeInstanceOf(AsterLimitError)
  })
  it('the pieces split makes are counted as rows before the array is made', () => {
    expect(thrown(() => withLimits({ maxRows: 5000 }, () => ev('length(split(s, ""))', {}, big)))).toBeInstanceOf(AsterLimitError)
    expect(thrown(() => withLimits({ maxRows: 5000 }, () => ev('length(split(s, "a"))', {}, big)))).toBeInstanceOf(AsterLimitError)
    expect(withLimits({ maxRows: 5000 }, () => ev('length(split(s, "a", 10))', {}, big))).toBe(10)
  })
  it('doubling a string stops at maxStringLength', () => {
    expect(limited('s + s + s', { s: 'a'.repeat(4000) })).toBeInstanceOf(AsterLimitError)
  })
  it('what stays within the limits is unchanged', () => {
    withLimits({ maxStringLength: 10_000 }, () => {
      expect(ev("replace('a-b-c', /-/g, '+')")).toBe('a+b+c')
      expect(ev("replace('abc', 'b', '[$&|$`|$\\'|$$]')")).toBe("a[b|a|c|$]c")
      expect(ev('join([1, null, "x"], ";")')).toBe('1;;x')
      expect(ev('length(split("a,b,c", ","))')).toBe(3)
      expect(ev('upper("abc") + lower("DEF") + trim(" x ") + truncate("abcdef", 4) + substring("abc", 1)')).toBe('ABCdefxabc…bc')
    })
  })
  it('without limits nothing is metered (vega parity)', () => {
    expect((ev('replace(pad("", 2000, "a"), /a/g, pad("", 2000, "b"))') as string).length).toBe(4_000_000)
  })
})

describe('substitution() is String.prototype.replace\'s GetSubstitution', () => {
  it('for generated replacement patterns, matches and captures', () => {
    let seed = 7
    const rand = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n }
    const parts = ['$$', '$&', '$`', "$'", '$1', '$2', '$01', '$10', '$0', '$<g>', '$<nope>', '$<', '$', 'x', '$9', '$11']
    const patterns: Array<string | RegExp> = [/b/g, /(b)(c)?/g, /(?<g>b+)/g, /x*/g, /(a)|(b)/g, 'b', /$/g, /(((((((((((b)))))))))))/g]
    for (let n = 0; n < 4000; n++) {
      const repl = Array.from({ length: 1 + rand(4) }, () => parts[rand(parts.length)]).join('')
      const pattern = patterns[rand(patterns.length)]!
      const str = ['abcbb', 'bbb', '', 'xyz', 'ab$c'][rand(5)]!
      const want = str.replace(pattern as RegExp, repl)
      const got = str.replace(pattern as RegExp, (...args: unknown[]) => {
        const named = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
        const tail = named ? 3 : 2
        return substitution(repl, args[0] as string, args[args.length - tail] as number, str, args.slice(1, args.length - tail), named ? args[args.length - 1] as Record<string, unknown> : undefined)
      })
      expect(got, `${JSON.stringify(str)}.replace(${String(pattern)}, ${JSON.stringify(repl)})`).toBe(want)
    }
  })
})

describe('docs/ARCHITECTURE.md lists every expression function (C707)', () => {
  it('the function table of "Expression Engine" names each function an expression can call, and nothing else', async () => {
    const { readFileSync } = await import('node:fs')
    const { expressionFunctionNames, registeredExpressionFunctionNames } = await import('./expression.js')
    const { EventFunctions } = await import('./expr-interpreter.js')
    const doc = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8')
    const section = doc.slice(doc.indexOf('## Expression Engine'), doc.indexOf('Hosts add functions with `registerExpressionFunction`'))
    const table = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Group') && !l.startsWith('|---'))
    const listed = new Set(table.flatMap((l) => [...l.split('|')[2]!.matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1]!)))
    const addons = new Set(registeredExpressionFunctionNames())
    const want = new Set([...expressionFunctionNames().filter((n) => !addons.has(n)), ...EventFunctions, 'if'])
    expect([...want].filter((n) => !listed.has(n)).sort(), 'functions missing from the table').toEqual([])
    expect([...listed].filter((n) => !want.has(n)).sort(), 'names in the table that are no function').toEqual([])
  })
})
