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
 *  - in the engine's reading a member read never yields an inherited `Object.prototype` member either (`datum.__proto__`,
 *    `datum.constructor`, `[].constructor` are undefined; an own field of that name is data) nor a function's `prototype`, so
 *    no expression holds a built-in prototype object that a later write (a dataset edit, a transform) could land on;
 *  - `Function`, `eval` and the timers are never produced by a member read or stored in an object literal;
 *  - no value that is a function is handed to a built-in (other than the type inspectors, by identity), so a
 *    function reachable through a member read (a scale, a method) cannot be invoked by one; the method-shaped default
 *    functions (`join`, `indexof`, `slice`, `split`, ...) call only the built-in method of a string or an array;
 *  - `x instanceof f` runs only the ordinary prototype-chain test (a function with its own `Symbol.hasInstance` is refused);
 *  - the regular expressions the built-ins run are screened and their input length-capped under limits, and a string `+`
 *    builds under limits no string longer than `maxStringLength`.
 */
import { ascending, DisallowedObjectProperties, safeGet, sortSlice, tupleDatum, sameTuple } from './util.js'
import type { AstNode, Expr } from './expr-parser.js'
import { activeMeter, checkRegexObject, checkRegexRun, freshRegExp, limitViolation, metering, regExpOf } from './limits.js'

// --- the default function table ---------------------------------------------------------------------

type Fn = (...args: never[]) => unknown

/** The built-in methods `callMethod` may call: a string's or an array's own (typed arrays share the array's names). */
const NATIVE_METHODS: ReadonlySet<unknown> = new Set(
  ['join', 'indexOf', 'lastIndexOf', 'slice', 'substring', 'split', 'replace'].flatMap((m) => [
    (String.prototype as unknown as Record<string, unknown>)[m], (Array.prototype as unknown as Record<string, unknown>)[m],
    (Object.getPrototypeOf(Int8Array.prototype) as Record<string, unknown>)[m],
  ]).filter((f) => typeof f === 'function'),
)

/**
 * `obj.method(...rest)` for the sequence and string built-ins, screening any regular expression argument. Only a built-in method of
 * a string or an array is called: an object that carries a function under that name (an object literal holding a function a member
 * read found) is refused, so no spec-reached function is invoked with spec-chosen arguments.
 */
function callMethod(method: string, args: unknown[], cast?: (v: unknown) => unknown): unknown {
  const obj = cast ? cast(args[0]) : args[0]
  for (let i = 1; i < args.length; i++) {
    if (args[i] instanceof RegExp) { checkRegexObject(args[i] as RegExp); checkRegexRun(args[i] as RegExp, String(obj)) }
  }
  // `.apply` stays a property read on whatever the lookup found: a missing method fails with the engine's
  // own "reading 'apply'" message, which is what the oracle reports
  const m = (obj as Record<string, unknown>)[method] as (...a: unknown[]) => unknown
  if (typeof m === 'function' && !NATIVE_METHODS.has(m)) refuse(method)
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
    checkRegexRun(re, input)
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

/**
 * A read or a literal the sandbox refuses. The engine's reading fails the evaluation (an error the engine's logger reports, as any
 * expression error: nothing bypasses the logger); the entry points shaped like vega-interpreter's print vega-interpreter's console
 * message and carry on with undefined, as it does.
 */
function prevented(mode: Mode, what: string, name: unknown): void {
  const message = `Prevented interpretation of ${what} "${String(name)}" which could lead to insecure code execution`
  if (mode.engine) throw new Error(message)
  // eslint-disable-next-line no-console
  console.error(message)
}

/**
 * The built-in type inspectors (`isNaN`, `isArray`, ...): they only look at a value, so they may be handed a function. Recorded by
 * identity (`markInspectors`): a host-registered `isHoliday` is not one of them.
 */
const INSPECTORS = new WeakSet<object>([Number.isNaN, Number.isFinite])
/** Record functions as type inspectors (see `INSPECTORS`). Only for functions Aster itself writes. */
export function markInspectors(fns: ReadonlyArray<(...a: never[]) => unknown>): void {
  for (const f of fns) INSPECTORS.add(f)
}

/** Under limits, a string an expression builds by `+` is no longer than `maxStringLength` (the doubling `s + s` stops there). */
function builtString(v: unknown): unknown {
  if (metering && typeof v === 'string') {
    const cap = activeMeter()?.limits.maxStringLength
    if (cap != null && v.length > cap) throw limitViolation(`maxStringLength ${v.length} > ${cap} (string concatenation)`)
  }
  return v
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
  /** The row pass this evaluation is one row of (see `RowPass`); undefined for a single evaluation. */
  pass: RowPass | undefined
}
type Run = (f: Frame) => unknown

/**
 * One pass of an expression over many rows with the same parameters (a filter's or a formula's rows). Made only for a tree whose
 * evaluation cannot change a parameter (see `Compiling.pure`): each signal the tree names is read once, when the pass starts, as a
 * single evaluation reads it (an own property of the parameters, else undefined), into `sig` (by `Compiling.signals` index), and
 * that is the value every row would read.
 */
interface RowPass {
  sig: unknown[]
}

/** What compiling one tree carries: the host table, the language reading, and what a row pass needs to know of the tree. */
interface Compiling {
  host: Record<string, unknown>
  mode: Mode
  /** The signals the tree names (engine reading), in `RowPass.sig` order. */
  signals: string[]
  /**
   * Whether evaluating the tree can never write a parameter: it calls nothing but the default functions and the engine's functions
   * marked param-safe (`markParamSafe`). Any other call might (`data(...)` may derive another dataset, whose transforms may write a
   * signal; a host function may do anything), and a row pass then reads every signal live, as a single evaluation does.
   */
  pure: boolean
  /** One check per call: whether its name still resolves to the function it resolved to when compiled. */
  resolved: Array<() => boolean>
}

/**
 * Which reading of the language a tree is compiled under. The engine's own entry (`compileExpression`) means what an expression
 * in a Vega spec means, which is what vega's code generator makes of it: the signals are the parameters by their own names, `NaN`
 * is the number, and a call has the shape the generator writes for it (see `FIRST_ARGUMENT_ONLY`, `ARGUMENT_ORDER`). The entry
 * points shaped like vega-interpreter's (`expressionInterpreter`, `interpret`) read the parameters `$`-prefixed and keep
 * vega-interpreter's own reading of those details (`NaN` is a parameter name there, and every argument is evaluated in order).
 */
interface Mode {
  engine: boolean
  /**
   * The expression reads no row, no item and no event: a signal's `init` / `update`, a `{signal}` of a property (vega's `_`-only
   * parameter and operator expressions). `datum`, `event` and `item` are not defined there: reading one fails as vega's generated
   * code does (`ReferenceError: datum is not defined`, when it is evaluated, so `false && datum` is fine).
   */
  signal?: boolean
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
 * The default functions, which never read `this`: a call that resolves to one is made directly, with its arguments, instead of
 * through `apply` with the `this` object a host function receives (as is a call that resolves to a built-in of an engine table:
 * see `BUILTIN_TABLES`). Which function a call resolves to is read on every call, as before; only the `this` it is handed differs,
 * and these never look. None of them reaches the engine (a dataset, a scale, a signal) either, so a call that resolves to one
 * leaves every parameter as it was (`Compiling.pure`). Their identities, so a table entry replaced since is not taken for one.
 */
const PURE: ReadonlySet<unknown> = new Set(Object.values(DefaultFunctions))

/**
 * The function tables the engine makes (see `markBuiltinTable`): for each, the built-in functions it was made with (which never read
 * `this`) and the names of those that never write a parameter. One entry per table, so making a table costs no work per function.
 */
const BUILTIN_TABLES = new WeakMap<object, { builtins: Readonly<Record<string, unknown>>; paramSafe: ReadonlySet<string> }>()

/**
 * Record a function table the engine made: `builtins` are its own built-ins (the object they were made in, not the table, which may
 * hold more), none of which reads `this`; `paramSafe` names those that never write a parameter (a signal), directly or through
 * anything they reach, so that a row pass of a tree that calls only these and the default functions reads each signal once (see
 * `Compiling.pure`). A call counts as one of them only while the table resolves its name to that very function. Only for tables
 * Aster itself writes.
 */
export function markBuiltinTable(table: object, builtins: Readonly<Record<string, unknown>>, paramSafe: ReadonlySet<string>): void {
  BUILTIN_TABLES.set(table, { builtins, paramSafe })
}

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

/**
 * `x instanceof f` with the ordinary prototype-chain test only: a right-hand side that is not callable fails as the language fails it,
 * and one that brings its own `Symbol.hasInstance` (host code) is refused rather than run.
 */
function instanceOf(x: unknown, f: unknown): boolean {
  if (typeof f !== 'function') throw new TypeError("Right-hand side of 'instanceof' is not callable")
  if ((f as unknown as Record<symbol, unknown>)[Symbol.hasInstance] !== Function.prototype[Symbol.hasInstance]) refuse('instanceof')
  return x instanceof (f as new () => unknown)
}

/** Operators with a closure each. `in` / `instanceof`: the engine evaluates them as vega's code generator does; vega-interpreter has none. */
function binary(op: string, l: Run, r: Run, mode: Mode): Run {
  switch (op) {
    case '+': return (f) => builtString((l(f) as number) + (r(f) as number))
    case '-': return (f) => (l(f) as number) - (r(f) as number)
    case '*': return (f) => (l(f) as number) * (r(f) as number)
    case '/': return (f) => (l(f) as number) / (r(f) as number)
    case '%': return (f) => (l(f) as number) % (r(f) as number)
    /* eslint-disable @typescript-eslint/no-explicit-any, eqeqeq */
    case '<': return (f) => (l(f) as any) < (r(f) as any)
    case '>': return (f) => (l(f) as any) > (r(f) as any)
    case '<=': return (f) => (l(f) as any) <= (r(f) as any)
    case '>=': return (f) => (l(f) as any) >= (r(f) as any)
    case '==': return (f) => { const a = l(f), b = r(f); return a == b || sameTuple(a, b) }
    case '!=': return (f) => { const a = l(f), b = r(f); return a != b && !sameTuple(a, b) }
    /* eslint-enable @typescript-eslint/no-explicit-any, eqeqeq */
    // (two objects are one when they stand for one tuple: the engine's copies of a row, see `sameTuple`)
    case '===': return (f) => sameTuple(l(f), r(f))
    case '!==': return (f) => !sameTuple(l(f), r(f))
    case '&': return (f) => (l(f) as number) & (r(f) as number)
    case '|': return (f) => (l(f) as number) | (r(f) as number)
    case '^': return (f) => (l(f) as number) ^ (r(f) as number)
    case '<<': return (f) => (l(f) as number) << (r(f) as number)
    case '>>': return (f) => (l(f) as number) >> (r(f) as number)
    case '>>>': return (f) => (l(f) as number) >>> (r(f) as number)
    default:
      // `x in o` is a boolean, whatever `o` holds; a right-hand side that is not an object fails as the language fails it
      if (mode.engine && op === 'in') return (f) => { const k = l(f); return (k as string) in (r(f) as object) }
      if (mode.engine && op === 'instanceof') return (f) => { const x = l(f); return instanceOf(x, r(f)) }
      // vega-interpreter: both operands are evaluated, then the call into its (absent) operator table fails. The message is
      // that oracle's: it is what its source's call expression reads as to V8.
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
function plainMember(object: Run, key: string | number, mode: Mode): Run {
  return (f) => {
    const v = (object(f) as Record<string | number, unknown>)[key]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented(mode, 'member', key); return undefined }
    return v
  }
}

function member(object: Run, property: Expr, computed: Run | undefined, mode: Mode): Run {
  const read = (o: unknown, key: unknown): unknown => {
    // a risky key on a *function* (`Object.constructor` is `Function`) is never resolved. On any other value the engine's reading
    // resolves it only as an own property (an inherited `__proto__` or `constructor` would hand the expression a built-in
    // prototype), and a function's `prototype` not at all; vega-interpreter's reading keeps the plain read there, as its vectors
    // pin (`datum.constructor` answers the inert `Object`).
    const v = typeof o === 'function'
      ? (mode.engine && String(key) === 'prototype' ? undefined : safeGet(o, key))
      : mode.engine ? safeGet(o, key) : (o as Record<string, unknown>)[key as string]
    if (typeof v === 'function' && DisallowedMethods.has(v)) { prevented(mode, 'member', key); return undefined }
    return v
  }
  if (computed) {
    // `o["name"]`, `o[0]`: a literal key that names no Object.prototype member reads exactly as the named form does (`safeGet`
    // only differs on a risky key), so it is compiled as that, without the per-call key coercion and function test
    const key = property.type === 'Literal' ? (property as { value: unknown }).value : undefined
    if ((typeof key === 'string' && !DisallowedObjectProperties.has(key) && !(mode.engine && key === 'prototype')) || typeof key === 'number') return plainMember(object, key, mode)
    return (f) => read(object(f), computed(f))
  }
  const name = (property as { name: string }).name
  if (DisallowedObjectProperties.has(name) || (mode.engine && name === 'prototype')) return (f) => read(object(f), name)
  return plainMember(object, name, mode)
}

const refuse = (name: string): never => { throw new Error(`Function argument refused: ${name}`) }

/** Aster's built-ins that run a regular expression argument and do not return it. */
const REGEX_CONSUMERS: ReadonlySet<string> = new Set(['test', 'replace', 'split'])
/** Whether `name` resolves, in this host table, to Aster's own built-in. */
function ownBuiltin(host: Record<string, unknown>, name: string): boolean {
  const table = BUILTIN_TABLES.get(host)
  const fn = host[name] || DefaultFunctions[name]
  return table !== undefined && typeof fn === 'function' && Object.hasOwn(table.builtins, name) && table.builtins[name] === fn
}

function call(node: Extract<Expr, { type: 'CallExpression' }>, c: Compiling): Run {
  const callee = node.callee
  // only a bare name is callable; anything else reads `.startsWith` off the missing name, as the oracle does
  if (callee.type !== 'Identifier') return () => (undefined as unknown as string).startsWith('_')
  // `_name` is the encoders' spelling of `name`
  const name = callee.name.startsWith('_') ? callee.name.slice(1) : callee.name
  // A regular-expression literal handed straight to one of Aster's own `test`, `replace` or `split` is used there and never
  // escapes the call, so its copy per evaluation (vega's code generator writes the literal into the code) can only differ from the
  // literal itself in `lastIndex`, which only a `g` or `y` expression reads and writes: those are copied, the others shared.
  const consumesRegex = c.mode.engine && REGEX_CONSUMERS.has(name) && ownBuiltin(c.host, name)
  let argv = node.arguments.map((a) => {
    const v = a.type === 'Literal' ? (a as { value: unknown }).value : undefined
    return consumesRegex && v instanceof RegExp && !v.global && !v.sticky ? () => v : compile(a, c)
  })

  // `if` evaluates only the branch it takes
  if (name === 'if') {
    const [test = MISSING, yes = MISSING, no = MISSING] = argv
    return (f) => (test(f) ? yes(f) : no(f))
  }

  // the shapes of vega's generated calls (see `Mode`)
  if (c.mode.engine && FIRST_ARGUMENT_ONLY.has(name)) argv = argv.slice(0, 1)
  const order = c.mode.engine && argv.length === 3 && Object.hasOwn(ARGUMENT_ORDER, name) ? ARGUMENT_ORDER[name] : undefined

  // Names inherited from Object.prototype are never functions here; `toString` alone is a real table entry.
  const blocked = name !== 'toString' && DisallowedObjectProperties.has(name)
  const count = argv.length

  /**
   * The arguments' values in the call's order; then, unless the callee is one of the built-in type inspectors (by identity: see
   * `INSPECTORS`), a function among them is refused: a built-in must not be able to invoke a function a spec reaches by a member
   * read (a scale, a method).
   */
  const values = (f: Frame, guard: boolean): unknown[] => {
    const vals: unknown[] = new Array(count)
    if (order) for (const i of order) vals[i] = (argv[i] as Run)(f)
    else for (let i = 0; i < count; i++) vals[i] = (argv[i] as Run)(f)
    if (guard) for (let i = 0; i < count; i++) if (typeof vals[i] === 'function') refuse(name)
    return vals
  }
  const guards = (fn: unknown): boolean => !(typeof fn === 'function' && INSPECTORS.has(fn))

  // The event functions are the loop's, whatever the host table holds under their names.
  if (EventFunctions.includes(name)) {
    c.pure = false
    // (vega writes `event.vega.<name>(...)`: without an event that is `event is not defined`, before the arguments are read)
    if (c.mode.engine) {
      return (f) => {
        if (f.event == null) throw new ReferenceError('event is not defined')
        return callEventFunction(f.event, name, values(f, true))
      }
    }
    return (f) => callEventFunction(f.event, name, values(f, true))
  }

  const host = c.host
  const lookup = (): unknown => (blocked ? undefined : (host[name] || DefaultFunctions[name]))
  /** A host function: `this` is the host table with the event functions, the arguments an array. */
  const general = (f: Frame, fn: unknown): unknown => {
    // read before the arguments are evaluated: an unknown name fails here, whatever its arguments would do
    const apply = (fn as { apply: (self: unknown, args: unknown[]) => unknown }).apply
    const vals = values(f, guards(fn))
    return apply.call(fn, f.self ??= makeSelf(host, f.event), vals)
  }

  // What the name resolves to now: when it is one of Aster's own functions (which never read `this`), a call that still resolves
  // to it is made directly. The resolution is read on every call all the same: a table changed since falls back to `general`.
  const known = lookup()
  const table = BUILTIN_TABLES.get(host)
  const builtin = table !== undefined && typeof known === 'function' && Object.hasOwn(table.builtins, name) && table.builtins[name] === known
  if (!PURE.has(known) && !(builtin && table.paramSafe.has(name))) c.pure = false
  // (a row pass is made only while every call still resolves to what it did here: see `compileExpression`)
  c.resolved.push(() => lookup() === known)
  const direct = PURE.has(known) || builtin ? known as (...a: unknown[]) => unknown : undefined
  if (direct === undefined) return (f) => general(f, lookup())
  const guardArgs = guards(direct)
  if (order !== undefined || count > 3) {
    return (f) => {
      const fn = lookup()
      return fn === direct ? direct(...values(f, guardArgs)) : general(f, fn)
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

function objectLiteral(node: Extract<Expr, { type: 'ObjectExpression' }>, c: Compiling): Run {
  const props = node.properties.map((p) => {
    const key = (p.key.type === 'Identifier' ? p.key.name : (p.key as { value: string | number }).value)
    return { key, blocked: DisallowedObjectProperties.has(key as string), value: compile(p.value, c) }
  })
  const n = props.length
  return (f) => {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      const p = props[i]!
      const v = p.value(f)
      if (p.blocked) prevented(c.mode, 'property', p.key)
      else if (typeof v === 'function' && DisallowedMethods.has(v)) prevented(c.mode, 'method', p.key)
      else out[p.key as string] = v
    }
    return out
  }
}

/** A signal read (engine reading): in a row pass the value read at its start, else the own property, read now. */
function signalRead(name: string, c: Compiling): Run {
  let i = c.signals.indexOf(name)
  if (i < 0) i = c.signals.push(name) - 1
  const slot = i
  return (f) => {
    const p = f.pass
    if (p !== undefined) return p.sig[slot]
    return Object.hasOwn(f.params, name) ? f.params[name] : undefined
  }
}

function compile(node: Expr, c: Compiling): Run {
  switch (node.type) {
    case 'Literal': {
      const v = node.value
      // vega's code generator writes a regular expression literal into the code, so each evaluation has a fresh RegExp: a `g` or `y`
      // literal starts every evaluation at lastIndex 0 (vega-interpreter's reading hands out the one object of its tree)
      if (v instanceof RegExp && c.mode.engine) return () => freshRegExp(v)
      return () => v
    }
    case 'Identifier': {
      const name = node.name
      if (c.mode.signal && (name === 'datum' || name === 'event' || name === 'item')) {
        c.pure = false
        return () => { throw new ReferenceError(`${name} is not defined`) }
      }
      if (name === 'datum') return (f) => tupleDatum(f.datum)
      if (name === 'event') return (f) => f.event
      if (name === 'item') return (f) => f.item
      const own = Object.hasOwn(ExpressionConstants, name)
      const constant = own ? ExpressionConstants[name] : undefined
      // (vega-interpreter reads a constant through `||`, so its falsy `NaN` falls through to a parameter of that name)
      if (constant || (own && c.mode.engine)) return () => constant
      // (a signal by its own name is an own property only: no name reaches the prototype)
      if (c.mode.engine) return signalRead(name, c)
      const param = '$' + name
      return (f) => f.params[param]
    }
    case 'MemberExpression':
      return member(compile(node.object, c), node.property, node.computed ? compile(node.property, c) : undefined, c.mode)
    case 'CallExpression':
      return call(node, c)
    case 'ArrayExpression': {
      const els = node.elements.map((e) => (e === null ? HOLE : compile(e, c)))
      return (f) => {
        const out: unknown[] = new Array(els.length)
        for (let i = 0; i < els.length; i++) out[i] = (els[i] as Run)(f)
        return out
      }
    }
    case 'BinaryExpression':
      return binary(node.operator, compile(node.left, c), compile(node.right, c), c.mode)
    case 'UnaryExpression':
      return unary(node.operator, compile(node.argument, c))
    case 'ConditionalExpression': {
      const [test, yes, no] = [compile(node.test, c), compile(node.consequent, c), compile(node.alternate, c)]
      return (f) => (test(f) ? yes(f) : no(f))
    }
    case 'LogicalExpression': {
      const [l, r] = [compile(node.left, c), compile(node.right, c)]
      return node.operator === '&&' ? (f) => l(f) && r(f) : (f) => l(f) || r(f)
    }
    case 'ObjectExpression':
      return objectLiteral(node, c)
  }
}

/** Compile a whole tree. */
function compileTree(ast: AstNode, host: Record<string, unknown>, mode: Mode): { run: Run; c: Compiling } {
  const c: Compiling = { host, mode, signals: [], pure: true, resolved: [] }
  return { run: compile(ast as Expr, c), c }
}

const NO_PARAMS: Params = Object.freeze({}) as Params
const INTERPRETER: Mode = { engine: false }
const ENGINE: Mode = { engine: true }
const ENGINE_SIGNAL: Mode = { engine: true, signal: true }

/**
 * Bind a tree to a host function table. The closures are made on the first evaluation: an expression is
 * bound for several roles (a parameter, an event handler) of which one is usually all that runs.
 */
function compileFor(ast: AstNode, fn: Record<string, unknown>, mode: Mode): (params: Params | undefined, datum: unknown, event: unknown, item: unknown) => unknown {
  let run: Run | undefined
  return (params, datum, event, item) => (run ??= compileTree(ast, fn, mode).run)({ params: params ?? NO_PARAMS, datum, event, item, self: undefined, pass: undefined })
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
 * Handed as the `datum` of an expression (`expression.ts` `evalSignal`) to evaluate it as a signal's: with the signals alone, as
 * vega's parameter and operator expressions have (`datum`, `event` and `item` are then not defined).
 */
export const SIGNAL_CONTEXT: unique symbol = Symbol('signal context')

/** An expression compiled for the engine: one evaluation, or a pass over many rows with the same parameters. */
export interface EngineExpression {
  /** `item` is the scenegraph item an encode is evaluated for (vega binds it there); undefined elsewhere. */
  (datum: unknown, params: Record<string, unknown> | undefined, event: unknown, item?: unknown): unknown
  /**
   * The evaluation of each row of a pass in which the parameters stay as they are (a transform's loop over its rows): the same
   * values as one evaluation per row, with what every row reads alike read once (see `RowPass`). The returned function is for that
   * pass only: once anything may have written a parameter, prepare another.
   */
  rows(params: Record<string, unknown> | undefined): (datum: unknown) => unknown
}

/**
 * The engine's own entry: an expression of a Vega spec (see `Mode`). The parameters are the signals by their own names, read where
 * they are (vega's entry points above take them `$`-prefixed, which would mean copying every signal on every evaluation).
 */
export function compileExpression(functions: Record<string, unknown>, ast: AstNode): EngineExpression {
  let tree: { run: Run; c: Compiling } | undefined
  let signalTree: Run | undefined
  const evaluate = ((datum, params, event, item) => {
    // a signal's own expression (see `SIGNAL_CONTEXT`): its own tree, in which `datum`, `event` and `item` are not defined
    if (datum === SIGNAL_CONTEXT) {
      return (signalTree ??= compileTree(ast, functions, ENGINE_SIGNAL).run)({ params: params ?? NO_PARAMS, datum: undefined, event: undefined, item: undefined, self: undefined, pass: undefined })
    }
    const run = (tree ??= compileTree(ast, functions, ENGINE)).run
    // (an event's datum is its item's)
    return run(event != null
      ? { params: params ?? NO_PARAMS, datum: (event as { item?: { datum?: unknown } }).item?.datum, event, item, self: undefined, pass: undefined }
      : { params: params ?? NO_PARAMS, datum, event: undefined, item, self: undefined, pass: undefined })
  }) as EngineExpression
  evaluate.rows = (params0) => {
    const { run, c } = (tree ??= compileTree(ast, functions, ENGINE))
    const params = params0 ?? NO_PARAMS
    let pass: RowPass | undefined
    if (c.pure && c.resolved.every((still) => still())) {
      // each signal read as a single evaluation reads it
      pass = { sig: c.signals.map((name) => (Object.hasOwn(params, name) ? params[name] : undefined)) }
    }
    // (a frame per row, as a single evaluation makes one: measured cheaper than one frame whose datum is rewritten per row)
    return (datum) => run({ params, datum, event: undefined, item: undefined, self: undefined, pass })
  }
  return evaluate
}
