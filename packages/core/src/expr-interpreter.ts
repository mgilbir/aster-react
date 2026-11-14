/**
 * The expression evaluator: the tree from `expr-parser.ts` compiled once into a tree of closures, with no
 * `new Function`, no `eval` and no code generation, so it runs under a strict CSP. Each closure takes the
 * per-evaluation `Frame` (parameters, datum, event, item) and returns the node's value; compiling resolves
 * everything that does not depend on the data (operators, member names, constants, which call is `if`)
 * so evaluating is a straight descent.
 *
 * The language semantics are those of vega-interpreter 2.3.1 (the pinned oracle; see
 * `conformance/scripts/differential-vega-expression*.test.mts`): untyped JavaScript operators and
 * coercions, short-circuiting `&&`/`||`/`?:`, unknown names resolving to `$`-prefixed parameters, the
 * default function table below, and the error a missing function, a null object or an unsupported
 * operator throws, message included.
 *
 * The sandbox is Aster's own and stricter than the oracle's:
 *  - an identifier, a call name or a function value never resolves an inherited `Object.prototype` member
 *    (`constructor`, `__proto__`, ...): a data column of that name is data, the inherited one does not exist;
 *  - `Function`, `eval` and the timers are never produced by a member read or stored in an object literal;
 *  - no value that is a function is handed to a built-in (other than the `is*` type inspectors), so a
 *    function reachable through a member read (a scale, a method) cannot be invoked by one;
 *  - the regular expressions the built-ins run are screened and their input length-capped under limits.
 */
import { ascending, DisallowedObjectProperties, safeGet, sortSlice, tupleDatum } from './util.js'
import type { AstNode, Expr } from './expr-parser.js'
import { checkRegexInput, checkRegexObject, regExpOf } from './limits.js'

// --- the default function table ---------------------------------------------------------------------

type Fn = (...args: never[]) => unknown

/** `obj.method(...rest)` for the sequence and string built-ins, screening any regular expression argument. */
function callMethod(method: string, args: unknown[], cast?: (v: unknown) => unknown): unknown {
  const obj = cast ? cast(args[0]) : args[0]
  for (let i = 1; i < args.length; i++) {
    if (args[i] instanceof RegExp) { checkRegexObject(args[i] as RegExp); checkRegexInput(String(obj)) }
  }
  // `.apply` stays a property read on whatever the lookup found: a missing method fails with the engine's
  // own "reading 'apply'" message, which is what the oracle reports
  const m = (obj as Record<string, unknown>)[method] as (...a: unknown[]) => unknown
  return m.apply(obj, args.slice(1))
}
const viaMethod = (method: string, cast?: (v: unknown) => unknown): Fn =>
  ((...args: unknown[]) => callMethod(method, args, cast)) as Fn

const MATH = ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'log', 'max', 'min', 'pow', 'random', 'round', 'sin', 'sqrt', 'tan'] as const
/** Date accessors: expression name -> Date method suffix; each exists in a local and (`utc` prefix) a UTC form. */
const DATE_PARTS: Record<string, string> = {
  date: 'Date', day: 'Day', year: 'FullYear', month: 'Month', hours: 'Hours', minutes: 'Minutes', seconds: 'Seconds', milliseconds: 'Milliseconds',
}
type DateGetter = (this: Date) => number

/**
 * The functions an expression can call when the host context does not supply one by that name: math,
 * dates, sequences, strings, regular expressions.
 */
export const DefaultFunctions: Record<string, Fn> = {
  isNaN: Number.isNaN,
  isFinite: Number.isFinite,
  clamp: ((v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))) as Fn,
  parseFloat,
  parseInt,
  encodeURIComponent,
  now: Date.now,
  utc: Date.UTC,
  datetime: ((year: unknown, m = 0, d = 1, H = 0, M = 0, S = 0, ms = 0) =>
    typeof year === 'string' ? new Date(year) : new Date(year as number, m, d, H, M, S, ms)) as Fn,
  time: ((t: number) => new Date(t).getTime()) as Fn,
  timezoneoffset: ((t: number) => new Date(t).getTimezoneOffset()) as Fn,

  length: ((x: { length: number }) => x.length) as Fn,
  join: viaMethod('join'),
  indexof: viaMethod('indexOf'),
  lastindexof: viaMethod('lastIndexOf'),
  slice: viaMethod('slice'),
  reverse: ((x: unknown[]) => x.slice().reverse()) as Fn,
  sort: ((x: unknown[]) => sortSlice(x, ascending)) as Fn,

  upper: ((x: unknown) => String(x).toUpperCase()) as Fn,
  lower: ((x: unknown) => String(x).toLowerCase()) as Fn,
  trim: ((x: unknown) => String(x).trim()) as Fn,
  substring: viaMethod('substring', String),
  split: viaMethod('split', String),
  replace: viaMethod('replace', String),
  btoa: ((x: string) => btoa(x)) as Fn,
  atob: ((x: string) => atob(x)) as Fn,

  regexp: ((pattern?: unknown, flags?: unknown) => regExpOf(pattern, flags)) as Fn,
  test: ((r: unknown, text: unknown) => {
    const re = regExpOf(r)
    const input = String(text)
    checkRegexInput(input)
    return re.test(input)
  }) as Fn,
}
for (const m of MATH) DefaultFunctions[m] = Math[m] as Fn
for (const [name, part] of Object.entries(DATE_PARTS)) {
  const local = Date.prototype[`get${part}` as 'getDate'] as DateGetter
  const utc = Date.prototype[`getUTC${part}` as 'getDate'] as DateGetter
  DefaultFunctions[name] = ((t: number) => local.call(new Date(t))) as Fn
  DefaultFunctions[`utc${name}`] = ((t: number) => utc.call(new Date(t))) as Fn
}

/** The numeric constants an expression can name. */
export const ExpressionConstants: Record<string, unknown> = {
  NaN,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  PI: Math.PI,
  SQRT1_2: Math.SQRT1_2,
  SQRT2: Math.SQRT2,
  MIN_VALUE: Number.MIN_VALUE,
  MAX_VALUE: Number.MAX_VALUE,
}

/** The functions the signal loop supplies from the event being handled (`event.vega.<name>`). */
export const EventFunctions = ['view', 'item', 'group', 'xy', 'x', 'y']

// --- the sandbox ------------------------------------------------------------------------------------

/** Functions that must never be produced by a member read nor stored in an object literal. */
const DisallowedMethods = new Set<unknown>([Function, eval, setTimeout, setInterval])
if (typeof setImmediate === 'function') DisallowedMethods.add(setImmediate)

const prevented = (what: string, name: unknown): void => {
  // eslint-disable-next-line no-console
  console.error(`Prevented interpretation of ${what} "${String(name)}" which could lead to insecure code execution`)
}

// --- compiling --------------------------------------------------------------------------------------

type Params = Record<string, unknown>

/** What one evaluation sees. `self` is the `this` handed to host functions, made on first use. */
interface Frame {
  params: Params
  datum: unknown
  event: unknown
  item: unknown
  self: object | undefined
}
type Run = (f: Frame) => unknown

/**
 * Which reading of the language a tree is compiled under. The engine's own entry (`compileExpression`) means what an expression
 * in a Vega spec means, which is what vega's code generator makes of it: the signals are the parameters by their own names, `NaN`
 * is the number, and a call has the shape the generator writes for it (see `FIRST_ARGUMENT_ONLY`, `ARGUMENT_ORDER`). The entry
 * points shaped like vega-interpreter's (`expressionInterpreter`, `interpret`) read the parameters `$`-prefixed and keep
 * vega-interpreter's own reading of those details (`NaN` is a parameter name there, and every argument is evaluated in order).
 */
interface Mode {
  engine: boolean
}

/**
 * The calls vega's code generator writes as a method of their first argument alone (`new Date(x).getDate()`, `x.length`,
 * `String(x).toUpperCase()`): any argument after the first is never evaluated.
 */
export const FIRST_ARGUMENT_ONLY: ReadonlySet<string> = new Set([
  'date', 'day', 'year', 'month', 'hours', 'minutes', 'seconds', 'milliseconds', 'time', 'timezoneoffset',
  'utcdate', 'utcday', 'utcyear', 'utcmonth', 'utchours', 'utcminutes', 'utcseconds', 'utcmilliseconds',
  'length', 'upper', 'lower', 'trim',
])
/** Calls whose arguments the generated code evaluates out of order: `clamp(v, lo, hi)` is `Math.max(lo, Math.min(hi, v))`. */
const ARGUMENT_ORDER: Readonly<Record<string, readonly number[]>> = { clamp: [1, 2, 0] }

/**
 * Functions of Aster's own tables that never read `this` (the defaults below and the engine's built-ins): a call that resolves to
 * one is made directly, with its arguments, instead of through `apply` with the `this` object a host function receives. Which
 * function a call resolves to is read on every call, as before; only the `this` it is handed differs, and these never look.
 */
const THISLESS = new WeakSet<object>()

/** Mark the functions of a table as never reading `this` (see `THISLESS`). Only for tables Aster itself writes. */
export function markThisless(table: Record<string, unknown>): void {
  for (const k in table) {
    const v = table[k]
    if (typeof v === 'function') THISLESS.add(v)
  }
}
markThisless(DefaultFunctions)

/** `event.vega[f](...args)`; the names are the oracle's, as V8 puts them in the "is not a function" message. */
function callEventFunction(event: unknown, f: string, args: unknown[]): unknown {
  return (event as { vega: Record<string, (...a: unknown[]) => unknown> }).vega[f]!(...args)
}

/** The `this` of a host function call: the host table, plus the event functions bound to the current event. */
function makeSelf(host: object, event: unknown): object {
  const self: Record<string, unknown> = Object.create(host)
  for (const name of EventFunctions) self[name] = (...args: unknown[]) => callEventFunction(event, name, args)
  return self
}

// A missing argument of `if(...)` and a hole in an array literal fail the way reading a tree node that is not there does.
const MISSING: Run = () => (undefined as unknown as { type: string }).type
const HOLE: Run = () => (null as unknown as { type: string }).type

/** Operators with a closure each; `in` and `instanceof` parse but have no evaluation (below). */
function binary(op: string, l: Run, r: Run): Run {
  switch (op) {
    case '+': return (f) => (l(f) as number) + (r(f) as number)
    case '-': return (f) => (l(f) as number) - (r(f) as number)
    case '*': return (f) => (l(f) as number) * (r(f) as number)
    case '/': return (f) => (l(f) as number) / (r(f) as number)
    case '%': return (f) => (l(f) as number) % (r(f) as number)
    /* eslint-disable @typescript-eslint/no-explicit-any, eqeqeq */
    case '<': return (f) => (l(f) as any) < (r(f) as any)
    case '>': return (f) => (l(f) as any) > (r(f) as any)
    case '<=': return (f) => (l(f) as any) <= (r(f) as any)
    case '>=': return (f) => (l(f) as any) >= (r(f) as any)
    case '==': return (f) => l(f) == r(f)
    case '!=': return (f) => l(f) != r(f)
    /* eslint-enable @typescript-eslint/no-explicit-any, eqeqeq */
    case '===': return (f) => l(f) === r(f)
    case '!==': return (f) => l(f) !== r(f)
    case '&': return (f) => (l(f) as number) & (r(f) as number)
    case '|': return (f) => (l(f) as number) | (r(f) as number)
    case '^': return (f) => (l(f) as number) ^ (r(f) as number)
    case '<<': return (f) => (l(f) as number) << (r(f) as number)
    case '>>': return (f) => (l(f) as number) >> (r(f) as number)
    case '>>>': return (f) => (l(f) as number) >>> (r(f) as number)
    default:
      // `in` / `instanceof`: both operands are evaluated, then the call into the (absent) operator table
      // fails. The message is the oracle's: it is what its source's call expression reads as to V8.
      return (f) => { l(f); r(f); throw new TypeError('Ops[n.operator] is not a function') }
  }
}

function unary(op: string, a: Run): Run {
  switch (op) {
    case '!': return (f) => !a(f)
    case '-': return (f) => -(a(f) as number)
    case '+': return (f) => +(a(f) as number)
    default: return (f) => ~(a(f) as number)
  }
}

/** `o[key]` for a key that names no `Object.prototype` member: the plain read, with the dangerous-function check. */
function plainMember(object: Run, key: string | number): Run {
  return (f) => {
    const v = (object(f) as Record<string | number, unknown>)[key]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented('member', key); return undefined }
    return v
  }
}

function member(object: Run, property: Expr, computed: Run | undefined): Run {
  const read = (o: unknown, key: unknown): unknown => {
    // a risky key on a *function* (`Object.constructor` is `Function`) is never resolved; on a plain object the
    // plain read stays, because the oracle's vectors pin that `datum.constructor` answers the inert `Object`
    const v = typeof o === 'function' ? safeGet(o, key) : (o as Record<string, unknown>)[key as string]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented('member', key); return undefined }
    return v
  }
  if (computed) {
    // `o["name"]`, `o[0]`: a literal key that names no Object.prototype member reads exactly as the named form does (`safeGet`
    // only differs on a risky key), so it is compiled as that, without the per-call key coercion and function test
    const key = property.type === 'Literal' ? (property as { value: unknown }).value : undefined
    if ((typeof key === 'string' && !DisallowedObjectProperties.has(key)) || typeof key === 'number') return plainMember(object, key)
    return (f) => read(object(f), computed(f))
  }
  const name = (property as { name: string }).name
  if (DisallowedObjectProperties.has(name)) return (f) => read(object(f), name)
  return plainMember(object, name)
}

const refuse = (name: string): never => { throw new Error(`Function argument refused: ${name}`) }

function call(node: Extract<Expr, { type: 'CallExpression' }>, host: Record<string, unknown>, mode: Mode): Run {
  const callee = node.callee
  // only a bare name is callable; anything else reads `.startsWith` off the missing name, as the oracle does
  if (callee.type !== 'Identifier') return () => (undefined as unknown as string).startsWith('_')
  // `_name` is the encoders' spelling of `name`
  const name = callee.name.startsWith('_') ? callee.name.slice(1) : callee.name
  let argv = node.arguments.map((a) => compile(a, host, mode))

  // `if` evaluates only the branch it takes
  if (name === 'if') {
    const [test = MISSING, yes = MISSING, no = MISSING] = argv
    return (f) => (test(f) ? yes(f) : no(f))
  }

  // the shapes of vega's generated calls (see `Mode`)
  if (mode.engine && FIRST_ARGUMENT_ONLY.has(name)) argv = argv.slice(0, 1)
  const order = mode.engine && argv.length === 3 && Object.hasOwn(ARGUMENT_ORDER, name) ? ARGUMENT_ORDER[name] : undefined

  // Names inherited from Object.prototype are never functions here; `toString` alone is a real table entry.
  const blocked = name !== 'toString' && DisallowedObjectProperties.has(name)
  // A built-in must not be able to invoke a function a spec reaches by a member read (a scale, a method);
  // the `is*` inspectors only look at the value and are exempt.
  const guardArgs = !name.startsWith('is')
  const count = argv.length

  /** The arguments' values in the call's order; then, when the callee is not an inspector, a function among them is refused. */
  const values = (f: Frame): unknown[] => {
    const vals: unknown[] = new Array(count)
    if (order) for (const i of order) vals[i] = (argv[i] as Run)(f)
    else for (let i = 0; i < count; i++) vals[i] = (argv[i] as Run)(f)
    if (guardArgs) for (let i = 0; i < count; i++) if (typeof vals[i] === 'function') refuse(name)
    return vals
  }

  // The event functions are the loop's, whatever the host table holds under their names.
  if (EventFunctions.includes(name)) return (f) => callEventFunction(f.event, name, values(f))

  const lookup = (): unknown => (blocked ? undefined : (host[name] || DefaultFunctions[name]))
  /** A host function: `this` is the host table with the event functions, the arguments an array. */
  const general = (f: Frame, fn: unknown): unknown => {
    // read before the arguments are evaluated: an unknown name fails here, whatever its arguments would do
    const apply = (fn as { apply: (self: unknown, args: unknown[]) => unknown }).apply
    const vals = values(f)
    return apply.call(fn, f.self ??= makeSelf(host, f.event), vals)
  }

  // What the name resolves to now: when it is one of Aster's own functions (which never read `this`), a call that still resolves
  // to it is made directly. The resolution is read on every call all the same: a table changed since falls back to `general`.
  const known = lookup()
  const direct = typeof known === 'function' && THISLESS.has(known) ? known as (...a: unknown[]) => unknown : undefined
  if (direct === undefined) return (f) => general(f, lookup())
  if (order !== undefined || count > 3) {
    return (f) => {
      const fn = lookup()
      return fn === direct ? direct(...values(f)) : general(f, fn)
    }
  }
  const [a0, a1, a2] = argv as [Run, Run, Run]
  switch (count) {
    case 0:
      return (f) => {
        const fn = lookup()
        return fn === direct ? direct() : general(f, fn)
      }
    case 1:
      return (f) => {
        const fn = lookup()
        if (fn !== direct) return general(f, fn)
        const v0 = a0(f)
        if (guardArgs && typeof v0 === 'function') refuse(name)
        return direct(v0)
      }
    case 2:
      return (f) => {
        const fn = lookup()
        if (fn !== direct) return general(f, fn)
        const v0 = a0(f)
        const v1 = a1(f)
        if (guardArgs && (typeof v0 === 'function' || typeof v1 === 'function')) refuse(name)
        return direct(v0, v1)
      }
    default:
      return (f) => {
        const fn = lookup()
        if (fn !== direct) return general(f, fn)
        const v0 = a0(f)
        const v1 = a1(f)
        const v2 = a2(f)
        if (guardArgs && (typeof v0 === 'function' || typeof v1 === 'function' || typeof v2 === 'function')) refuse(name)
        return direct(v0, v1, v2)
      }
  }
}

function objectLiteral(node: Extract<Expr, { type: 'ObjectExpression' }>, host: Record<string, unknown>, mode: Mode): Run {
  const props = node.properties.map((p) => {
    const key = (p.key.type === 'Identifier' ? p.key.name : (p.key as { value: string | number }).value)
    return { key, blocked: DisallowedObjectProperties.has(key as string), value: compile(p.value, host, mode) }
  })
  const n = props.length
  return (f) => {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      const p = props[i]!
      const v = p.value(f)
      if (p.blocked) prevented('property', p.key)
      else if (typeof v === 'function' && DisallowedMethods.has(v)) prevented('method', p.key)
      else out[p.key as string] = v
    }
    return out
  }
}

function compile(node: Expr, host: Record<string, unknown>, mode: Mode): Run {
  switch (node.type) {
    case 'Literal': {
      const v = node.value
      return () => v
    }
    case 'Identifier': {
      const name = node.name
      if (name === 'datum') return (f) => tupleDatum(f.datum)
      if (name === 'event') return (f) => f.event
      if (name === 'item') return (f) => f.item
      const own = Object.hasOwn(ExpressionConstants, name)
      const constant = own ? ExpressionConstants[name] : undefined
      // (vega-interpreter reads a constant through `||`, so its falsy `NaN` falls through to a parameter of that name)
      if (constant || (own && mode.engine)) return () => constant
      // (a signal by its own name is an own property only: no name reaches the prototype)
      if (mode.engine) return (f) => (Object.hasOwn(f.params, name) ? f.params[name] : undefined)
      const param = '$' + name
      return (f) => f.params[param]
    }
    case 'MemberExpression':
      return member(compile(node.object, host, mode), node.property, node.computed ? compile(node.property, host, mode) : undefined)
    case 'CallExpression':
      return call(node, host, mode)
    case 'ArrayExpression': {
      const els = node.elements.map((e) => (e === null ? HOLE : compile(e, host, mode)))
      return (f) => {
        const out: unknown[] = new Array(els.length)
        for (let i = 0; i < els.length; i++) out[i] = (els[i] as Run)(f)
        return out
      }
    }
    case 'BinaryExpression':
      return binary(node.operator, compile(node.left, host, mode), compile(node.right, host, mode))
    case 'UnaryExpression':
      return unary(node.operator, compile(node.argument, host, mode))
    case 'ConditionalExpression': {
      const [test, yes, no] = [compile(node.test, host, mode), compile(node.consequent, host, mode), compile(node.alternate, host, mode)]
      return (f) => (test(f) ? yes(f) : no(f))
    }
    case 'LogicalExpression': {
      const [l, r] = [compile(node.left, host, mode), compile(node.right, host, mode)]
      return node.operator === '&&' ? (f) => l(f) && r(f) : (f) => l(f) || r(f)
    }
    case 'ObjectExpression':
      return objectLiteral(node, host, mode)
  }
}

const NO_PARAMS: Params = Object.freeze({}) as Params
const INTERPRETER: Mode = { engine: false }
const ENGINE: Mode = { engine: true }

/**
 * Bind a tree to a host function table. The closures are made on the first evaluation: an expression is
 * bound for several roles (a parameter, an event handler) of which one is usually all that runs.
 */
function compileFor(ast: AstNode, fn: Record<string, unknown>, mode: Mode): (params: Params | undefined, datum: unknown, event: unknown, item: unknown) => unknown {
  let run: Run | undefined
  return (params, datum, event, item) => (run ??= compile(ast as Expr, fn, mode))({ params: params ?? NO_PARAMS, datum, event, item, self: undefined })
}

/** Evaluate a parsed expression against a host function table (compiles on every call; bind with `expressionInterpreter` to reuse). */
export function interpret(
  ast: AstNode,
  fn: Record<string, unknown>,
  params?: Record<string, unknown>,
  datum?: unknown,
  event?: unknown,
  item?: unknown,
): unknown {
  return compileFor(ast, fn, INTERPRETER)(params, datum, event, item)
}

/**
 * The entry points, shaped like vega-interpreter's `expressionInterpreter` so the engine's compile step
 * binds to them directly. Each compiles the tree once; the returned function is the evaluation. (Vega's
 * `encode` entry point is omitted: the engine performs encodings in its own runtime.)
 */
export const expressionInterpreter = {
  /** An expression that updates an operator value. */
  operator(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions, INTERPRETER)
    return (params: Record<string, unknown>) => run(params, undefined, undefined, undefined)
  },
  /** An expression given as an operator parameter value. */
  parameter(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions, INTERPRETER)
    return (datum: unknown, params: Record<string, unknown>) => run(params, datum, undefined, undefined)
  },
  /** An expression applied to an event stream. */
  event(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions, INTERPRETER)
    return (event: unknown) => run(undefined, undefined, event, undefined)
  },
  /** An expression that handles an event-driven operator update (its datum is the event's item's). */
  handler(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions, INTERPRETER)
    return (params: Record<string, unknown>, event: unknown) =>
      run(params, (event as { item?: { datum?: unknown } } | undefined)?.item?.datum, event, undefined)
  },
}

/**
 * The engine's own entry: an expression of a Vega spec (see `Mode`). The parameters are the signals by their own names, read where
 * they are (vega's entry points above take them `$`-prefixed, which would mean copying every signal on every evaluation).
 */
export function compileExpression(functions: Record<string, unknown>, ast: AstNode): (datum: unknown, params: Record<string, unknown> | undefined, event: unknown) => unknown {
  let run: Run | undefined
  return (datum, params, event) => {
    run ??= compile(ast as Expr, functions, ENGINE)
    // (an event's datum is its item's)
    return run(event != null
      ? { params: params ?? NO_PARAMS, datum: (event as { item?: { datum?: unknown } }).item?.datum, event, item: undefined, self: undefined }
      : { params: params ?? NO_PARAMS, datum, event: undefined, item: undefined, self: undefined })
  }
}
