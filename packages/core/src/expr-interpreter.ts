/**
 * The CSP-safe AST evaluator — a faithful port of vega-interpreter (2.3.1).
 * No `new Function`, no codegen: the AST is walked with a visitor table, and
 * anything that could execute code (Function, eval, timers, prototype
 * accessors) is refused by name, exactly as upstream does.
 *
 * Pinned by oracle vectors recorded from the pinned vega-interpreter
 * (`testdata/vectors/vega-expression.json`, eval suites).
 */
import { ascending, DisallowedObjectProperties, safeGet } from './util.js'
import { type AstNode } from './expr-parser.js'
import { guardedRegExp, checkRegexInput } from './limits.js'

// --- the interpreter's own default function table ----------------------------

const slice = Array.prototype.slice

const apply = (m: string, args: unknown[], cast?: (v: unknown) => unknown): unknown => {
  const obj = cast ? cast(args[0]) : args[0]
  const method = (obj as Record<string, unknown>)[m] as (...a: unknown[]) => unknown
  return method.apply(obj, slice.call(args, 1) as unknown[])
}

const datetime = (yearOrTimestring: unknown, m = 0, d = 1, H = 0, M = 0, S = 0, ms = 0): Date =>
  typeof yearOrTimestring === 'string'
    ? new Date(yearOrTimestring)
    : new Date(yearOrTimestring as number, m, d, H, M, S, ms)

/**
 * The evaluator's fallback functions, used when the host context does not
 * supply a name — a faithful port of vega-interpreter's Functions.js.
 */
export const DefaultFunctions: Record<string, (...args: never[]) => unknown> = {
  // math functions
  isNaN: Number.isNaN,
  isFinite: Number.isFinite,
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  log: Math.log,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  random: Math.random,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  clamp: (a, b, c) => Math.max(b as number, Math.min(c as number, a as number)),

  // date functions
  now: Date.now,
  utc: Date.UTC,
  datetime: datetime as unknown as (...args: never[]) => unknown,
  date: (d) => new Date(d as number).getDate(),
  day: (d) => new Date(d as number).getDay(),
  year: (d) => new Date(d as number).getFullYear(),
  month: (d) => new Date(d as number).getMonth(),
  hours: (d) => new Date(d as number).getHours(),
  minutes: (d) => new Date(d as number).getMinutes(),
  seconds: (d) => new Date(d as number).getSeconds(),
  milliseconds: (d) => new Date(d as number).getMilliseconds(),
  time: (d) => new Date(d as number).getTime(),
  timezoneoffset: (d) => new Date(d as number).getTimezoneOffset(),
  utcdate: (d) => new Date(d as number).getUTCDate(),
  utcday: (d) => new Date(d as number).getUTCDay(),
  utcyear: (d) => new Date(d as number).getUTCFullYear(),
  utcmonth: (d) => new Date(d as number).getUTCMonth(),
  utchours: (d) => new Date(d as number).getUTCHours(),
  utcminutes: (d) => new Date(d as number).getUTCMinutes(),
  utcseconds: (d) => new Date(d as number).getUTCSeconds(),
  utcmilliseconds: (d) => new Date(d as number).getUTCMilliseconds(),

  // sequence functions
  length: (x) => (x as { length: number }).length,
  join: function () { return apply('join', Array.from(arguments)) },
  indexof: function () { return apply('indexOf', Array.from(arguments)) },
  lastindexof: function () { return apply('lastIndexOf', Array.from(arguments)) },
  slice: function () { return apply('slice', Array.from(arguments)) },
  reverse: (x) => (x as unknown[]).slice().reverse(),
  sort: (x) => (x as unknown[]).slice().sort(ascending),

  // string functions
  parseFloat,
  parseInt,
  upper: (x) => String(x).toUpperCase(),
  lower: (x) => String(x).toLowerCase(),
  substring: function () { return apply('substring', Array.from(arguments), String) },
  split: function () { return apply('split', Array.from(arguments), String) },
  replace: function () { return apply('replace', Array.from(arguments), String) },
  trim: (x) => String(x).trim(),
  // Base64 encode/decode (Node ≥ 16 and browsers provide both globals)
  btoa: (x) => btoa(x as string),
  atob: (x) => atob(x as string),
  // URI encoding
  encodeURIComponent,

  // regexp functions
  regexp: ((p: string, f?: string) => guardedRegExp(String(p), f)) as unknown as (...args: never[]) => unknown,
  test: (r, t) => {
    const re = (r as unknown) instanceof RegExp ? (r as RegExp) : guardedRegExp(String(r))
    checkRegexInput(String(t))
    return re.test(t as string)
  },
} as Record<string, (...args: never[]) => unknown>

// --- constants ---------------------------------------------------------------

const Constants: Record<string, unknown> = {
  NaN: NaN,
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

// --- operators ---------------------------------------------------------------

const Unary: Record<string, (a: unknown) => unknown> = {
  '+': (a) => +((a as number)),
  '-': (a) => -((a as number)),
  '~': (a) => ~((a as number)),
  '!': (a) => !a,
}

/* eslint-disable eqeqeq */
/** Raw JS relational operators on untyped values (upstream's untyped comparisons). */
function lt(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) < (b as any)
}
function gt(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) > (b as any)
}
function lte(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) <= (b as any)
}
function gte(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) >= (b as any)
}

const Ops: Record<string, (a: unknown, b: unknown) => unknown> = {
  '*': (a, b) => (a as number) * (b as number),
  '+': (a, b) => (a as number) + (b as number),
  '-': (a, b) => (a as number) - (b as number),
  '/': (a, b) => (a as number) / (b as number),
  '%': (a, b) => (a as number) % (b as number),
  '>': (a, b) => gt(a, b),
  '<': (a, b) => lt(a, b),
  '<=': (a, b) => lte(a, b),
  '>=': (a, b) => gte(a, b),
  '==': (a, b) => a == b,
  '!=': (a, b) => a != b,
  '===': (a, b) => a === b,
  '!==': (a, b) => a !== b,
  '&': (a, b) => (a as number) & (b as number),
  '|': (a, b) => (a as number) | (b as number),
  '^': (a, b) => (a as number) ^ (b as number),
  '<<': (a, b) => (a as number) << (b as number),
  '>>': (a, b) => (a as number) >> (b as number),
  '>>>': (a, b) => (a as number) >>> (b as number),
}
/* eslint-enable eqeqeq */

// --- security ----------------------------------------------------------------

const EventFunctions = ['view', 'item', 'group', 'xy', 'x', 'y']

const DisallowedMethods = new Set<unknown>([
  Function,
  eval,
  setTimeout,
  setInterval,
])
if (typeof setImmediate === 'function') DisallowedMethods.add(setImmediate)

// --- the evaluator -----------------------------------------------------------

interface EvalContext {
  (node: AstNode): unknown
  memberDepth: number
  fn: Record<string, unknown>
  params: Record<string, unknown>
  datum: unknown
  event: unknown
  item: unknown
}

const Visitors: Record<string, ($: EvalContext, n: AstNode) => unknown> = {
  Literal: ($, n) => n.value,
  Identifier: ($, n) => {
    const id = n.name as string
    return $.memberDepth > 0 ? id
      : id === 'datum' ? $.datum
      : id === 'event' ? $.event
      : id === 'item' ? $.item
      : (Object.hasOwn(Constants, id) ? Constants[id] : undefined) || $.params['$' + id]
  },
  MemberExpression: ($, n) => {
    const d = !n.computed
    const o = $(n.object as AstNode)
    if (d) $.memberDepth += 1
    const p = $(n.property as AstNode)
    if (d) $.memberDepth -= 1
    // vega-interpreter returns the inert `Object` for `datum.constructor`
    // (pinned by the oracle vectors), so a plain object keeps that read. But a
    // risky key on a *function* (the `.constructor` of `Object`, which is
    // `Function`) is never resolved, and DisallowedMethods stays as the
    // faithful backstop. Calls refuse function values (see CallExpression),
    // so what is returned here cannot be invoked.
    const v = typeof o === 'function' ? safeGet(o, p) : (o as Record<string, unknown>)[p as string]
    if (DisallowedMethods.has(v)) {
      // eslint-disable-next-line no-console
      console.error(`Prevented interpretation of member "${String(p)}" which could lead to insecure code execution`)
      return undefined
    }
    return v
  },
  CallExpression: ($, n) => {
    const args = n.arguments as AstNode[]
    let name = (n.callee as { name: string }).name
    // handle special internal functions used by encoders
    // re-route to corresponding standard function
    if (name.startsWith('_')) {
      name = name.slice(1)
    }
    // special case "if" due to conditional evaluation of branches
    if (name === 'if') return $(args[0] as AstNode) ? $(args[1] as AstNode) : $(args[2] as AstNode)
    // Only own, table-registered functions are callable: names that exist on
    // Object.prototype (constructor, toString, ...) are never functions here.
    // An unknown name fails exactly as upstream does (`undefined.apply`), which the oracle vectors pin.
    // Names that exist on Object.prototype (constructor, valueOf, ...) are never
    // functions here; `toString` alone is a real table entry (coercion).
    const f = name !== 'toString' && DisallowedObjectProperties.has(name) ? undefined : ($.fn[name] || DefaultFunctions[name])
    const vals = args.map($)
    // No expression function takes a callable (vega-functions has none that
    // is reachable); refuse one rather than let a spec-reachable function
    // value (e.g. a scale) be invoked by a built-in. The `is*` type inspectors
    // only look at the value and are exempt.
    if (!name.startsWith('is') && vals.some((v) => typeof v === 'function')) {
      throw new Error(`Function argument refused: ${name}`)
    }
    return (f as (...a: unknown[]) => unknown).apply($.fn, vals)
  },
  ArrayExpression: ($, n) => (n.elements as AstNode[]).map($),  // array holes crash upstream too
  BinaryExpression: ($, n) => (Ops[n.operator as string] as (a: unknown, b: unknown) => unknown)($(n.left as AstNode), $(n.right as AstNode)),
  UnaryExpression: ($, n) => (Unary[n.operator as string] as (a: unknown) => unknown)($(n.argument as AstNode)),
  ConditionalExpression: ($, n) => $(n.test as AstNode)
    ? $(n.consequent as AstNode)
    : $(n.alternate as AstNode),
  LogicalExpression: ($, n) => n.operator === '&&'
    ? ($(n.left as AstNode) && $(n.right as AstNode))
    : ($(n.left as AstNode) || $(n.right as AstNode)),
  ObjectExpression: ($, n) => (n.properties as AstNode[]).reduce((o: Record<string, unknown>, p) => {
    $.memberDepth += 1
    const k = $(p.key as AstNode)
    $.memberDepth -= 1
    const v = $(p.value as AstNode)
    if (DisallowedObjectProperties.has(k as string)) {
      // eslint-disable-next-line no-console
      console.error(`Prevented interpretation of property "${k}" which could lead to insecure code execution`)
    } else if (DisallowedMethods.has(v)) {
      // eslint-disable-next-line no-console
      console.error(`Prevented interpretation of method "${k}" which could lead to insecure code execution`)
    } else {
      o[k as string] = v
    }
    return o
  }, {}),
}

/** Evaluate a parsed expression AST against a host function context. */
export function interpret(
  ast: AstNode,
  fn: Record<string, unknown>,
  params?: Record<string, unknown>,
  datum?: unknown,
  event?: unknown,
  item?: unknown,
): unknown {
  const $ = ((n: AstNode) => (Visitors[n.type] as (c: EvalContext, n: AstNode) => unknown)($, n)) as EvalContext
  $.memberDepth = 0
  $.fn = Object.create(fn) as Record<string, unknown>
  $.params = params ?? {}
  $.datum = datum
  $.event = event
  $.item = item
  // route event functions to annotated vega event context
  for (const f of EventFunctions) {
    $.fn[f] = (...args: unknown[]) => ((event as { vega: Record<string, (...a: unknown[]) => unknown> }).vega[f] as (...a: unknown[]) => unknown)(...args)
  }
  return $(ast)
}

/**
 * The interpreter's entry points, shaped like vega-interpreter's
 * `expressionInterpreter` so the engine's compile step binds to it directly.
 * (The `encode` entry point is omitted: the engine performs encodings in its
 * own runtime, not through vega's dataflow.)
 */
export const expressionInterpreter = {
  /** Parse an expression used to update an operator value. */
  operator(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const ast = expr.ast
    const fn = ctx.functions
    return (_: Record<string, unknown>) => interpret(ast, fn, _)
  },
  /** Parse an expression provided as an operator parameter value. */
  parameter(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const ast = expr.ast
    const fn = ctx.functions
    return (datum: unknown, _: Record<string, unknown>) => interpret(ast, fn, _, datum)
  },
  /** Parse an expression applied to an event stream. */
  event(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const ast = expr.ast
    const fn = ctx.functions
    return (event: unknown) => interpret(ast, fn, undefined, undefined, event)
  },
  /** Parse an expression used to handle an event-driven operator update. */
  handler(ctx: { functions: Record<string, unknown> }, expr: { ast: AstNode }) {
    const ast = expr.ast
    const fn = ctx.functions
    return (_: Record<string, unknown>, event: unknown) => {
      const datum = (event as { item?: { datum?: unknown } } | undefined)?.item?.datum
      return interpret(ast, fn, _, datum, event)
    }
  },
}
