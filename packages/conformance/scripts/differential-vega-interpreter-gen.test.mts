/**
 * GENERATED live differential of the expression EVALUATOR: random expressions from a grammar, parsed by
 * the pinned vega-expression, then evaluated on random data by the pinned vega-interpreter and by
 * Aster's `expr-interpreter.ts` in the same process.
 *
 *   - random: both sides on fresh copies of the same datum/params/host functions/event, through all four
 *     entry points (operator, parameter, event, handler); the result (or the thrown error's class and
 *     message) and everything written to console.error must agree.
 *   - operators: every operator over a matrix of coercion-heavy values.
 *   - sandbox probes: adversarial expressions. Where Aster is stricter than vega on purpose (its
 *     hardening goes beyond vega-interpreter) the divergence is pinned in a table, both sides, and
 *     nothing else may differ.
 *
 * The parser's counterpart is `differential-vega-expression-gen.test.mts`.
 * Seeds are fixed; set `ASTER_EXPR_FUZZ_SEED` / `ASTER_EXPR_FUZZ_N` to hunt with fresh ones.
 */
import { afterEach, describe, expect, it, vi as vitest } from 'vitest'
import * as ve from 'vega-expression'
import * as vi from 'vega-interpreter'
import { parseExpression } from '../../core/src/expr-parser.ts'
import { expressionInterpreter } from '../../core/src/expr-interpreter.ts'
import { exact, withTz } from './differential-util.mts'
import { gen, mkCleanSource, mkSource, OPS, rng } from './expression-gen.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- evaluation comparison -----------------------------------------------------------------------

const mkDatum = (): any => ({
  a: 1, b: 2, c: '3', x: 1.5, s: 'str', name: 'Zo\u00eb', n: null, u: undefined, nan: NaN, neg0: -0, t: true,
  list: [3, 1, 2], words: ['b', 'a'], nested: { deep: { x: 1 }, a: 'A' }, 'a b': 3, 'f g': 7,
  // an own column that shares a name with an Object.prototype member is data
  constructor: 'ownCtor', toString: 'ownToString',
  d: new Date(Date.UTC(2020, 5, 15, 12, 30, 45, 123)),
})
const mkParams = (): any => ({ $a: 1.5, $b: 'x', $c: [1, 2], $d: null, $e: { k: 1 }, $x: 0, $y: '' })
const mkHost = (): Record<string, unknown> => ({
  hostSum: (a: number, b: number) => a + b,
  hostThis: function (this: any) { return [typeof this, typeof this?.view, typeof this?.hostSum] },
  hostFn: () => () => 1,
  isFoo: (v: unknown) => typeof v === 'function',
})
const mkEvent = (datum: unknown): any => ({
  item: { datum },
  vega: {
    view: () => 'V', item: () => 'I', group: () => 'G', xy: () => [1, 2], x: () => 3, y: () => 4,
  },
})

type Side = 'vega' | 'aster'
type Mode = 'param' | 'handler' | 'operator' | 'event'
const MODES: readonly Mode[] = ['param', 'handler', 'operator', 'event']
const PROBE_MODES: readonly Mode[] = ['param', 'handler']
function evaluate(side: Side, code: string, ast: unknown, mode: Mode): { r: unknown; logs: string[] } {
  const logs: string[] = []
  const spy = vitest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  try {
    const ctx = { functions: mkHost() }
    const mod = side === 'vega' ? (vi as any).expressionInterpreter : expressionInterpreter
    const datum = mkDatum()
    const r = exact(() => {
      if (mode === 'param') return mod.parameter(ctx, { ast })(datum, mkParams())
      if (mode === 'operator') return mod.operator(ctx, { ast })(mkParams())
      // vega's `event` entry hands the expression no parameter object at all (an identifier read then throws);
      // Aster evaluates it against an empty one, which is vega's `handler` with no item and `{}`
      if (mode === 'event') {
        const ev = { vega: mkEvent(datum).vega }
        return side === 'vega' ? mod.handler(ctx, { ast })({}, ev) : mod.event(ctx, { ast })(ev)
      }
      return mod.handler(ctx, { ast })(mkParams(), mkEvent(datum))
    })
    return { r, logs }
  } finally {
    spy.mockRestore()
  }
}
const isHardening = (r: any): boolean => r && r.$ === 'throw' && typeof r.message === 'string' && r.message.startsWith('Function argument refused')

const SEED = process.env.ASTER_EXPR_FUZZ_SEED ? Number(process.env.ASTER_EXPR_FUZZ_SEED) : 0xA57E12
const N = process.env.ASTER_EXPR_FUZZ_N ? Number(process.env.ASTER_EXPR_FUZZ_N) : 30000

afterEach(() => vitest.restoreAllMocks())

describe('generated: vega-interpreter vs Aster expr-interpreter', () => {
  it(`agrees on results, thrown errors and console output over random expressions (UTC)`, () =>
    withTz('UTC', () => {
      const r = rng(SEED ^ 0x5eed)
      const M = Math.floor(N / 2)
      let evaluated = 0
      let errored = 0
      let refused = 0
      const bad: string[] = []
      for (let i = 0; i < M; i++) {
        // evaluation wants parseable sources: a lightly-mutated tree is kept, the rest are re-rolled
        const code = i % 3 === 0 ? mkSource(r) : i % 3 === 1 ? gen(r, 1 + r.int(5)) : mkCleanSource(r)
        const wantAst = (() => { try { return ve.parseExpression(code) } catch { return undefined } })()
        if (!wantAst) continue
        const gotAst = parseExpression(code)
        for (const mode of MODES) {
          const want = evaluate('vega', code, wantAst, mode)
          const got = evaluate('aster', code, gotAst, mode)
          evaluated++
          if ((want.r as any)?.$ === 'throw') errored++
          if (isHardening(got.r) && !isHardening(want.r)) { refused++; continue }
          if (JSON.stringify(got) !== JSON.stringify(want) && bad.length < 8) {
            bad.push(`${mode} ${JSON.stringify(code)}\n   vega:  ${JSON.stringify(want)}\n   aster: ${JSON.stringify(got)}`)
          }
        }
        if (bad.length >= 8) break
      }
      expect(bad).toEqual([])
      expect(evaluated).toBeGreaterThan(M * 0.3)
      expect(errored).toBeGreaterThan(evaluated * 0.05)
      expect(errored).toBeLessThan(evaluated * 0.8)
      // Aster's refusal of function-valued arguments is rare in this corpus; it must not swallow the comparison
      expect(refused).toBeLessThan(evaluated * 0.02)
    }), 120_000)

  it('agrees on operators over a value matrix (coercions, short-circuiting, NaN, -0, strings, null, undefined, arrays)', () =>
    withTz('UTC', () => {
      const vals = ['0', '-0', '1', '-1', '1.5', 'NaN', '1/0', '-1/0', '"1"', '"a"', '""', '"b"', 'null', 'undefined', 'true', 'false', '[]', '[1]', '[1,2]', '{}', 'datum.d', '2147483648', '4294967297', '-2147483649', '0.1', '"0x10"', '" 5 "']
      const unary = ['!', '-', '+', '~']
      const bad: string[] = []
      const check = (code: string): void => {
        const ast = ve.parseExpression(code)
        const want = evaluate('vega', code, ast, 'param')
        const got = evaluate('aster', code, parseExpression(code), 'param')
        if (JSON.stringify(got) !== JSON.stringify(want) && bad.length < 8) bad.push(`${code}  vega ${JSON.stringify(want)}  aster ${JSON.stringify(got)}`)
      }
      for (const a of vals) {
        for (const u of unary) check(`${u}${a === 'NaN' || a.startsWith('-') ? `(${a})` : a}`)
        for (const b of vals) for (const op of OPS) check(`(${a}) ${op} (${b})`)
      }
      expect(bad).toEqual([])
    }), 120_000)
})

// --- adversarial sandbox probes ------------------------------------------------------------------

const PROBES = [
  // reaching Function / eval / timers through the object graph
  'datum.constructor', 'datum.constructor.constructor', 'datum.constructor.constructor("return 1")', 'datum.constructor.constructor("return 1")()',
  'datum.list.constructor', 'datum.list.constructor.constructor', '"".constructor', '"".constructor.constructor', '(1).constructor.constructor',
  'datum.list.map.constructor', 'datum.list.map.constructor("return 1")', 'datum.nested.constructor', 'datum.f.constructor',
  'datum["constructor"]', 'datum["constructor"]["constructor"]', 'datum["con" + "structor"]', 'datum[datum.s]', 'datum[["constructor"]]',
  'datum.__proto__', 'datum.__proto__.constructor', 'datum["__proto__"]["constructor"]', '({}).__proto__', '({}).constructor', '({}).constructor.constructor',
  '({__proto__: 1})', '({"__proto__": 1})', '({constructor: 1})', '({a: 1, constructor: datum})', '({toString: 1})', '({valueOf: 1})', '({hasOwnProperty: 1})',
  '({a: datum.constructor})', '({a: datum.constructor.constructor})', '({a: datum.list.map.constructor})',
  'datum.hasOwnProperty', 'datum.hasOwnProperty("a")', 'datum.toString', 'datum.valueOf', 'datum.toLocaleString', 'datum.isPrototypeOf',
  'datum.__defineGetter__', 'datum.__lookupGetter__', 'datum.propertyIsEnumerable',
  // identifiers and function names
  'Function', 'Function("return 1")()', 'eval("1")', '_eval("1")', 'setTimeout(1)', 'setInterval(1)', 'setImmediate(1)', 'window', 'globalThis', 'process', 'require("fs")',
  'constructor', 'constructor("return 1")', 'toString', 'toString()', 'valueOf()', '_toString()', 'hasOwnProperty("x")', '__proto__', '__defineGetter__',
  '\\u0063onstructor', 'datum.\\u0063onstructor', 'datum["\\u0063onstructor"]', 'datum["\\x63onstructor"]', 'Function\\u0028', 'this', 'this.constructor',
  'import("x")', 'new Function("return 1")', 'function(){}', '(function(){})()', '(() => 1)()', 'a => a', 'async function(){}', 'class A {}', 'with(a){}',
  // function values flowing into calls, members and operators
  'length(datum.list.map)', 'isFoo(datum.list.map)', 'hostFn()', 'isFoo(hostFn())', 'hostFn()()', 'datum.list.map(function(){})',
  'datum.list.map(isFoo)', 'datum.list.sort(1)', 'datum.list.concat.call(1)', 'join(datum.list, datum.list.map)', 'upper(datum.list.map)',
  'datum.list.map + 1', 'datum.list.map == datum.list.map', '[datum.list.map]', '({m: datum.list.map})', 'datum.list.map ? 1 : 2', '!datum.list.map',
  'isNaN(datum.list.map)', 'isFinite(datum.list.map)', 'indexof("abc", datum.list.map)', 'test(datum.list.map, "x")', 'replace("a", "a", datum.list.map)',
  // regex literals and calls
  'test(/a+/, "aaa")', 'replace("aaa", /a/g, "b")', 'split("a,b", /,/)', 'regexp("(")', 'regexp("a", "gg")', '/a/.constructor', '/a/.source', '/a/.exec', '/a/.test("a")',
  // coercion hooks and prototype tricks
  '({toString: 1}) + ""', '({valueOf: 1}) + 1', '[] + {}', '[]["constructor"]', '"abc"["length"]', '"abc"[0]', 'datum.list[-1]', 'datum.list["length"]',
  'datum.list.length.constructor', '(0).toFixed', 'datum.s.split', 'datum.s.constructor', 'datum.nested.deep.constructor', 'datum.d.constructor', 'datum.d.getTime',
  // sneaky evaluation order and member forms
  'datum.constructor === Function', 'datum[Function]', 'datum[eval]', 'datum[setTimeout]', '{}[Function]', '[][eval]', 'datum.list[setTimeout]',
  'view()', 'item()', 'x()', 'xy()', 'group()', 'event.vega.view()', 'event.vega.view.constructor', 'event.item.datum.constructor', 'event.constructor',
  'item.constructor', 'item', 'event', 'event.vega', 'event.vega.constructor.constructor',
  // unusual syntax
  'a.b.c.d', 'null.x', 'undefined.x', '(1)(2)', '"a"(1)', 'datum.a(1)', 'datum["a"](1)', 'datum.list.map(1)', '[](1)', '{}(1)', 'nothing(null.x)', 'datum(null.x)', 'if(1)', 'if(1,2)', 'if(0,1,2,3)',
  '_(1)', '__(1)', '__proto__(1)', '$(1)', 'x\\u0020y', 'a\u2028b', 'a/*c*/b', 'a//c', 'a;b', 'a,b', '`a`', '#a', '@a', 'a?.b', 'a??b', 'a**b', '...a',
] as const

/**
 * Where Aster differs from vega-interpreter on the sandbox surface, probe by probe: [mode, source, vega's
 * outcome, Aster's outcome] (result or thrown error, plus console.error output, as JSON). These are Aster's
 * own hardening, taken on purpose and pinned both ways: Aster never resolves an inherited Object.prototype
 * member (`constructor`, `__proto__`, ...) through an identifier, a call name or a function value, reads a
 * data column of that name as data, and refuses a function-valued argument to a built-in. The one-sided
 * ones (`datum["constructor"]`) come from vega's parser rewriting a string literal that names an
 * Object.prototype member into an identifier, which Aster's parser keeps a string. Every other probe must
 * match vega exactly; an entry that starts agreeing, or a new disagreement, fails the test.
 */
const PINNED_DIVERGENCES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["param", "datum.list.constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "datum.list.constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "\"\".constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "\"\".constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "(1).constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "(1).constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "datum.list.map.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "datum.list.map.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "datum[\"constructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["handler", "datum[\"constructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["param", "datum[\"constructor\"][\"constructor\"]", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'function Object() { [native code] }')\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["handler", "datum[\"constructor\"][\"constructor\"]", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'function Object() { [native code] }')\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["param", "datum[[\"constructor\"]]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["handler", "datum[[\"constructor\"]]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["param", "datum[\"__proto__\"][\"constructor\"]", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'function Object() { [native code] }')\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["handler", "datum[\"__proto__\"][\"constructor\"]", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'function Object() { [native code] }')\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["param", "({}).constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "({}).constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "({a: datum.list.map.constructor})", "{\"r\":{\"a\":{\"$\":\"undef\"}},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"a\":{\"$\":\"undef\"}},\"logs\":[]}"],
  ["handler", "({a: datum.list.map.constructor})", "{\"r\":{\"a\":{\"$\":\"undef\"}},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"a\":{\"$\":\"undef\"}},\"logs\":[]}"],
  ["param", "constructor", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "constructor", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "constructor(\"return 1\")", "{\"r\":{\"0\":\"r\",\"1\":\"e\",\"2\":\"t\",\"3\":\"u\",\"4\":\"r\",\"5\":\"n\",\"6\":\" \",\"7\":\"1\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["handler", "constructor(\"return 1\")", "{\"r\":{\"0\":\"r\",\"1\":\"e\",\"2\":\"t\",\"3\":\"u\",\"4\":\"r\",\"5\":\"n\",\"6\":\" \",\"7\":\"1\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["param", "toString", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "toString", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "valueOf()", "{\"r\":{\"group\":{\"$\":\"fn\"},\"item\":{\"$\":\"fn\"},\"view\":{\"$\":\"fn\"},\"x\":{\"$\":\"fn\"},\"xy\":{\"$\":\"fn\"},\"y\":{\"$\":\"fn\"}},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["handler", "valueOf()", "{\"r\":{\"group\":{\"$\":\"fn\"},\"item\":{\"$\":\"fn\"},\"view\":{\"$\":\"fn\"},\"x\":{\"$\":\"fn\"},\"xy\":{\"$\":\"fn\"},\"y\":{\"$\":\"fn\"}},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["param", "hasOwnProperty(\"x\")", "{\"r\":true,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["handler", "hasOwnProperty(\"x\")", "{\"r\":true,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Cannot read properties of undefined (reading 'apply')\"},\"logs\":[]}"],
  ["param", "__proto__", "{\"r\":{},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "__proto__", "{\"r\":{},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "__defineGetter__", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "__defineGetter__", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "\\u0063onstructor", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "\\u0063onstructor", "{\"r\":{\"$\":\"fn\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["param", "datum[\"\\u0063onstructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["handler", "datum[\"\\u0063onstructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["param", "datum[\"\\x63onstructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["handler", "datum[\"\\x63onstructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":\"ownCtor\",\"logs\":[]}"],
  ["param", "length(datum.list.map)", "{\"r\":1,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: length\"},\"logs\":[]}"],
  ["handler", "length(datum.list.map)", "{\"r\":1,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: length\"},\"logs\":[]}"],
  ["param", "join(datum.list, datum.list.map)", "{\"r\":\"3function map() { [native code] }1function map() { [native code] }2\",\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: join\"},\"logs\":[]}"],
  ["handler", "join(datum.list, datum.list.map)", "{\"r\":\"3function map() { [native code] }1function map() { [native code] }2\",\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: join\"},\"logs\":[]}"],
  ["param", "upper(datum.list.map)", "{\"r\":\"FUNCTION MAP() { [NATIVE CODE] }\",\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: upper\"},\"logs\":[]}"],
  ["handler", "upper(datum.list.map)", "{\"r\":\"FUNCTION MAP() { [NATIVE CODE] }\",\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: upper\"},\"logs\":[]}"],
  ["param", "indexof(\"abc\", datum.list.map)", "{\"r\":-1,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: indexof\"},\"logs\":[]}"],
  ["handler", "indexof(\"abc\", datum.list.map)", "{\"r\":-1,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: indexof\"},\"logs\":[]}"],
  ["param", "test(datum.list.map, \"x\")", "{\"r\":false,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: test\"},\"logs\":[]}"],
  ["handler", "test(datum.list.map, \"x\")", "{\"r\":false,\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: test\"},\"logs\":[]}"],
  ["param", "replace(\"a\", \"a\", datum.list.map)", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Array.prototype.map called on null or undefined\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: replace\"},\"logs\":[]}"],
  ["handler", "replace(\"a\", \"a\", datum.list.map)", "{\"r\":{\"$\":\"throw\",\"name\":\"TypeError\",\"message\":\"Array.prototype.map called on null or undefined\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"throw\",\"name\":\"Error\",\"message\":\"Function argument refused: replace\"},\"logs\":[]}"],
  ["param", "[][\"constructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["handler", "[][\"constructor\"]", "{\"r\":{\"$\":\"undef\"},\"logs\":[]}",
   "{\"r\":{\"$\":\"fn\"},\"logs\":[]}"],
  ["handler", "event.vega.view.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
  ["handler", "event.vega.constructor.constructor", "{\"r\":{\"$\":\"undef\"},\"logs\":[\"Prevented interpretation of member \\\"constructor\\\" which could lead to insecure code execution\"]}",
   "{\"r\":{\"$\":\"undef\"},\"logs\":[]}"],
]

describe('generated: adversarial sandbox probes (vega-interpreter vs Aster)', () => {
  const rows = PROBES.map((code) => {
    const v = (() => { try { return { ast: ve.parseExpression(code) } } catch (e: any) { return { parseError: String(e?.message) } } })()
    const a = (() => { try { return { ast: parseExpression(code) } } catch (e: any) { return { parseError: String(e?.message) } } })()
    return { code, v, a }
  })

  it('accepts and rejects exactly the same sources', () => {
    for (const { code, v, a } of rows) expect({ code, ...('ast' in a ? { ok: true } : a) }).toEqual({ code, ...('ast' in v ? { ok: true } : v) })
  })

  it('evaluates every accepted probe to what vega does, except the pinned divergences, which hold exactly', () =>
    withTz('UTC', () => {
      const pinned = new Map(PINNED_DIVERGENCES.map(([mode, code, vega, aster]) => [`${mode} ${code}`, { vega, aster }]))
      const used = new Set<string>()
      const bad: string[] = []
      for (const { code, v, a } of rows) {
        if (!('ast' in v) || !('ast' in a)) continue
        for (const mode of PROBE_MODES) {
          const want = JSON.stringify(evaluate('vega', code, v.ast, mode))
          const got = JSON.stringify(evaluate('aster', code, a.ast, mode))
          const key = `${mode} ${code}`
          const pin = pinned.get(key)
          if (pin) {
            used.add(key)
            if (want !== pin.vega || got !== pin.aster) bad.push(`pinned ${key}\n   vega:  ${want}\n   aster: ${got}`)
          } else if (got !== want) {
            bad.push(`${key}\n   vega:  ${want}\n   aster: ${got}`)
          }
        }
      }
      for (const key of pinned.keys()) if (!used.has(key)) bad.push(`pinned entry never reached: ${key}`)
      expect(bad).toEqual([])
    }))

  it('never lets a probe return or smuggle Function, eval or a timer, and never executes injected code', () =>
    withTz('UTC', () => {
      const sensitive = new Set<unknown>([Function, eval, setTimeout, setInterval, globalThis, process])
      const seen = (v: unknown, depth = 0): boolean => {
        if (sensitive.has(v)) return true
        if (depth > 3 || v === null || typeof v !== 'object') return false
        return Object.values(v as object).some((x) => seen(x, depth + 1))
      }
      ;(globalThis as any).__asterEscaped = 0
      for (const { code, a } of rows) {
        if (!('ast' in a)) continue
        for (const mode of PROBE_MODES) {
          const logs: string[] = []
          const spy = vitest.spyOn(console, 'error').mockImplementation((...x: unknown[]) => { logs.push(x.map(String).join(' ')) })
          try {
            const ctx = { functions: mkHost() }
            const datum = mkDatum()
            let result: unknown
            try {
              result = mode === 'param' ? expressionInterpreter.parameter(ctx, { ast: a.ast })(datum, mkParams())
                : mode === 'operator' ? expressionInterpreter.operator(ctx, { ast: a.ast })(mkParams())
                : mode === 'event' ? expressionInterpreter.event(ctx, { ast: a.ast })(mkEvent(datum))
                : expressionInterpreter.handler(ctx, { ast: a.ast })(mkParams(), mkEvent(datum))
            } catch { result = undefined }
            expect({ code, smuggled: seen(result) }).toEqual({ code, smuggled: false })
          } finally {
            spy.mockRestore()
          }
        }
      }
      expect((globalThis as any).__asterEscaped).toBe(0)
    }))

  it('covers the sandbox surface: the probe list reaches parse errors, results and prevented-access logs', () =>
    withTz('UTC', () => {
      let parsed = 0
      let logged = 0
      for (const { code, v } of rows) {
        if (!('ast' in v)) continue
        parsed++
        if (evaluate('vega', code, v.ast, 'param').logs.length > 0) logged++
      }
      expect(parsed).toBeGreaterThan(PROBES.length * 0.6)
      expect(logged).toBeGreaterThanOrEqual(3)
    }))
})
