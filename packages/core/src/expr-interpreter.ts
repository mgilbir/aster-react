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
import { ascending, DisallowedObjectProperties, safeGet } from './util.js'
import type { AstNode, Expr } from './expr-parser.js'
import { guardedRegExp, checkRegexInput, checkRegexObject } from './limits.js'

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
  sort: ((x: unknown[]) => x.slice().sort(ascending)) as Fn,

  upper: ((x: unknown) => String(x).toUpperCase()) as Fn,
  lower: ((x: unknown) => String(x).toLowerCase()) as Fn,
  trim: ((x: unknown) => String(x).trim()) as Fn,
  substring: viaMethod('substring', String),
  split: viaMethod('split', String),
  replace: viaMethod('replace', String),
  btoa: ((x: string) => btoa(x)) as Fn,
  atob: ((x: string) => atob(x)) as Fn,

  regexp: ((pattern: string, flags?: string) => guardedRegExp(String(pattern), flags)) as Fn,
  test: ((r: unknown, text: string) => {
    const re = r instanceof RegExp ? r : guardedRegExp(String(r))
    if (r instanceof RegExp) checkRegexObject(r)
    checkRegexInput(String(text))
    return re.test(text)
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

function member(object: Run, property: Expr, computed: Run | undefined): Run {
  const read = (o: unknown, key: unknown): unknown => {
    // a risky key on a *function* (`Object.constructor` is `Function`) is never resolved; on a plain object the
    // plain read stays, because the oracle's vectors pin that `datum.constructor` answers the inert `Object`
    const v = typeof o === 'function' ? safeGet(o, key) : (o as Record<string, unknown>)[key as string]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented('member', key); return undefined }
    return v
  }
  if (computed) return (f) => read(object(f), computed(f))
  const name = (property as { name: string }).name
  if (DisallowedObjectProperties.has(name)) return (f) => read(object(f), name)
  return (f) => {
    const v = (object(f) as Record<string, unknown>)[name]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented('member', name); return undefined }
    return v
  }
}

function call(node: Extract<Expr, { type: 'CallExpression' }>, host: Record<string, unknown>): Run {
  const callee = node.callee
  // only a bare name is callable; anything else reads `.startsWith` off the missing name, as the oracle does
  if (callee.type !== 'Identifier') return () => (undefined as unknown as string).startsWith('_')
  // `_name` is the encoders' spelling of `name`
  const name = callee.name.startsWith('_') ? callee.name.slice(1) : callee.name
  const argv = node.arguments.map((a) => compile(a, host))

  // `if` evaluates only the branch it takes
  if (name === 'if') {
    const [test = MISSING, yes = MISSING, no = MISSING] = argv
    return (f) => (test(f) ? yes(f) : no(f))
  }

  // Names inherited from Object.prototype are never functions here; `toString` alone is a real table entry.
  const blocked = name !== 'toString' && DisallowedObjectProperties.has(name)
  // A built-in must not be able to invoke a function a spec reaches by a member read (a scale, a method);
  // the `is*` inspectors only look at the value and are exempt.
  const guardArgs = !name.startsWith('is')
  const count = argv.length
  const isEvent = EventFunctions.includes(name)

  return (f) => {
    // The event functions are the loop's, whatever the host table holds under their names.
    const fn = isEvent ? undefined : blocked ? undefined : (host[name] || DefaultFunctions[name])
    // read before the arguments are evaluated: an unknown name fails here, whatever its arguments would do
    const apply = isEvent ? undefined : (fn as { apply: (self: unknown, args: unknown[]) => unknown }).apply
    const vals: unknown[] = []
    for (let i = 0; i < count; i++) vals.push((argv[i] as Run)(f))
    if (guardArgs) {
      for (let i = 0; i < count; i++) {
        if (typeof vals[i] === 'function') throw new Error(`Function argument refused: ${name}`)
      }
    }
    if (isEvent) return callEventFunction(f.event, name, vals)
    return (apply as (self: unknown, args: unknown[]) => unknown).call(fn, f.self ??= makeSelf(host, f.event), vals)
  }
}

function objectLiteral(node: Extract<Expr, { type: 'ObjectExpression' }>, host: Record<string, unknown>): Run {
  const props = node.properties.map((p) => {
    const key = (p.key.type === 'Identifier' ? p.key.name : (p.key as { value: string | number }).value)
    return { key, blocked: DisallowedObjectProperties.has(key as string), value: compile(p.value, host) }
  })
  return (f) => {
    const out: Record<string, unknown> = {}
    for (const p of props) {
      const v = p.value(f)
      if (p.blocked) prevented('property', p.key)
      else if (typeof v === 'function' && DisallowedMethods.has(v)) prevented('method', p.key)
      else out[p.key as string] = v
    }
    return out
  }
}

function compile(node: Expr, host: Record<string, unknown>): Run {
  switch (node.type) {
    case 'Literal': {
      const v = node.value
      return () => v
    }
    case 'Identifier': {
      const name = node.name
      if (name === 'datum') return (f) => f.datum
      if (name === 'event') return (f) => f.event
      if (name === 'item') return (f) => f.item
      const constant = Object.hasOwn(ExpressionConstants, name) ? ExpressionConstants[name] : undefined
      if (constant) return () => constant
      const param = '$' + name
      return (f) => f.params[param]
    }
    case 'MemberExpression':
      return member(compile(node.object, host), node.property, node.computed ? compile(node.property, host) : undefined)
    case 'CallExpression':
      return call(node, host)
    case 'ArrayExpression': {
      const els = node.elements.map((e) => (e === null ? HOLE : compile(e, host)))
      return (f) => {
        const out: unknown[] = new Array(els.length)
        for (let i = 0; i < els.length; i++) out[i] = (els[i] as Run)(f)
        return out
      }
    }
    case 'BinaryExpression':
      return binary(node.operator, compile(node.left, host), compile(node.right, host))
    case 'UnaryExpression':
      return unary(node.operator, compile(node.argument, host))
    case 'ConditionalExpression': {
      const [test, yes, no] = [compile(node.test, host), compile(node.consequent, host), compile(node.alternate, host)]
      return (f) => (test(f) ? yes(f) : no(f))
    }
    case 'LogicalExpression': {
      const [l, r] = [compile(node.left, host), compile(node.right, host)]
      return node.operator === '&&' ? (f) => l(f) && r(f) : (f) => l(f) || r(f)
    }
    case 'ObjectExpression':
      return objectLiteral(node, host)
  }
}

const NO_PARAMS: Params = Object.freeze({}) as Params

/**
 * Bind a tree to a host function table. The closures are made on the first evaluation: an expression is
 * bound for several roles (a parameter, an event handler) of which one is usually all that runs.
 */
function compileFor(ast: AstNode, fn: Record<string, unknown>): (params: Params | undefined, datum: unknown, event: unknown, item: unknown) => unknown {
  let run: Run | undefined
  return (params, datum, event, item) => (run ??= compile(ast as Expr, fn))({ params: params ?? NO_PARAMS, datum, event, item, self: undefined })
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
  return compileFor(ast, fn)(params, datum, event, item)
}

/**
 * The entry points, shaped like vega-interpreter's `expressionInterpreter` so the engine's compile step
 * binds to them directly. Each compiles the tree once; the returned function is the evaluation. (Vega's
 * `encode` entry point is omitted: the engine performs encodings in its own runtime.)
 */
export const expressionInterpreter = {
  /** An expression that updates an operator value. */
  operator(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions)
    return (params: Record<string, unknown>) => run(params, undefined, undefined, undefined)
  },
  /** An expression given as an operator parameter value. */
  parameter(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions)
    return (datum: unknown, params: Record<string, unknown>) => run(params, datum, undefined, undefined)
  },
  /** An expression applied to an event stream. */
  event(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions)
    return (event: unknown) => run(undefined, undefined, event, undefined)
  },
  /** An expression that handles an event-driven operator update (its datum is the event's item's). */
  handler(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const run = compileFor(expr.ast, ctx.functions)
    return (params: Record<string, unknown>, event: unknown) =>
      run(params, (event as { item?: { datum?: unknown } } | undefined)?.item?.datum, event, undefined)
  },
}
