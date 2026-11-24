/**
 * A transform's parameters as vega reads them, resolved for one evaluation from the table of its definition (transform-params.ts),
 * the same table the compile check walks: what the spec writes is accepted and read in one place, so no transform can accept a
 * form and then mis-read it.
 *
 * Per parameter, by its kind (vega-parser `parameterValue`):
 * - a `{signal}` is the signal's value (a declared signal by its name, else the expression's value) -- for a whole list too;
 * - a field (or a value vega lets be computed per tuple) written `{expr: text, as?}` is an accessor that evaluates the expression
 *   over the tuple, with no name (vega's Expression operator drops `as`); written `{field: name, as?}` it is the field's accessor,
 *   named `as` when given (vega `fieldRef`). Any other value is left as written: a field name stays a string, which the
 *   transform reads with `fieldOf` as before, and a constant stays a constant;
 * - a comparator `{field, order}`: each field may be a `{signal}` or an `{expr}` (an accessor), each order a `{signal}`;
 * - objects of sub-parameters (`force.forces`, `density.distribution`) are read through the parameters of their kind;
 * - an expression is a text, read by the transform itself.
 * Keys the definition does not list are never read by vega; they are left as written.
 *
 * A transform with nothing to resolve (no `{signal}`, no object-form field) is returned as it is, so the common case costs one
 * look-up of a flag kept beside it.
 */
import { transformParams, type TransformParam } from './transform-params.js'
import type { CompiledTransform } from './types.js'
import type { ExpressionRuntime } from './expression.js'
import { accessor, array, dict, field, splitAccessPath, type Accessor } from './util.js'
import { parseExpressionCached, type AstNode } from './expr-parser.js'

type Rec = Record<string, unknown>

/** What resolving reads: the expression runtime and the signals of the evaluation. */
export interface ParamContext {
  runtime: ExpressionRuntime
  signals: Record<string, unknown>
}

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
/** vega-parser `isSignal`: an object with a truthy `signal`. */
const isSignal = (v: unknown): v is { signal: string } => isRecord(v) && !!v.signal

/** Whether a value written for a parameter of this kind has something to resolve. */
function needsValue(p: TransformParam, v: unknown): boolean {
  if (p.sub !== undefined) return (p.list && Array.isArray(v) ? v : [v]).some((x) => isRecord(x) && needsParams(x, subParamsOf(p, x)))
  if (isSignal(v)) return true
  if (p.kind === 'expression') return false
  // bounded: the elements the spec writes for one parameter
  for (const x of p.list && Array.isArray(v) ? v : [v]) {
    if (isSignal(x)) return true
    if (p.kind === 'field' && isRecord(x) && (x.expr || x.field)) return true
    if (p.kind === 'compare' && isRecord(x) && [...array(x.field), ...array(x.order)].some((f) => isSignal(f) || (isRecord(f) && !!f.expr))) return true
  }
  return false
}

function needsParams(o: Rec, params: readonly TransformParam[]): boolean {
  // bounded: the fixed table of a transform's parameters
  for (const p of params) if (o[p.name] !== undefined && needsValue(p, o[p.name])) return true
  return false
}

/** The parameters of the kind of sub-parameter object `item` is (told by its key), none when it is of no known kind. */
function subParamsOf(p: TransformParam, item: unknown): readonly TransformParam[] {
  if (!isRecord(item)) return []
  return p.sub?.find((s) => Object.keys(s.key).every((k) => s.key[k] === item[k]))?.params ?? []
}

const NEEDS = new WeakMap<object, boolean>()

/** Whether the transform has a parameter written as a `{signal}`, an `{expr}` or a `{field}` (kept beside the compiled transform). */
export function hasResolvedParams(t: CompiledTransform): boolean {
  let needs = NEEDS.get(t)
  if (needs === undefined) {
    needs = needsParams(t as unknown as Rec, transformParams(t.type))
    NEEDS.set(t, needs)
  }
  return needs
}

/** The transform with its parameters resolved for this evaluation (itself when there is nothing to resolve). */
export function resolveTransformParams(t: CompiledTransform, ctx: ParamContext): CompiledTransform {
  if (!hasResolvedParams(t)) return t
  return resolveObject(t as unknown as Rec, transformParams(t.type), ctx) as unknown as CompiledTransform
}

function resolveObject(o: Rec, params: readonly TransformParam[], ctx: ParamContext): Rec {
  // prototype-less: spec keys such as `__proto__` stay plain data
  const out = dict<unknown>(o)
  // bounded: the fixed table of a transform's parameters
  for (const p of params) {
    const v = o[p.name]
    if (v !== undefined) out[p.name] = resolveParam(p, v, ctx)
  }
  return out
}

function resolveParam(p: TransformParam, v: unknown, ctx: ParamContext): unknown {
  if (p.sub !== undefined) {
    return p.list && Array.isArray(v) ? v.map((x) => resolveSub(p, x, ctx)) : resolveSub(p, v, ctx)
  }
  if (p.kind === 'expression') return v
  if (p.list && !isSignal(v) && Array.isArray(v)) return v.map((x) => resolveValue(p, x, ctx))
  return resolveValue(p, v, ctx)
}

function resolveSub(p: TransformParam, item: unknown, ctx: ParamContext): unknown {
  const params = subParamsOf(p, item)
  return params.length && needsParams(item as Rec, params) ? resolveObject(item as Rec, params, ctx) : item
}

function resolveValue(p: TransformParam, v: unknown, ctx: ParamContext): unknown {
  if (isSignal(v)) return signalValue(v.signal, ctx)
  if (p.kind === 'field' && isRecord(v)) {
    if (v.expr) return expressionAccessor(v.expr as string, ctx)
    if (v.field) return field(v.field, v.as as string | undefined)
    return v
  }
  if (p.kind === 'compare' && isRecord(v)) {
    const out = dict<unknown>(v)
    if (v.field !== undefined) out.field = mapOne(v.field, (f) => (isSignal(f) ? signalValue(f.signal, ctx) : isRecord(f) && f.expr ? expressionAccessor(f.expr as string, ctx) : f))
    if (v.order !== undefined) out.order = mapOne(v.order, (o) => (isSignal(o) ? signalValue(o.signal, ctx) : o))
    return out
  }
  return v
}

/** `f` over a list's elements, or over the one value written alone. */
const mapOne = (v: unknown, f: (x: unknown) => unknown): unknown => (Array.isArray(v) ? v.map(f) : f(v))

/** vega-parser `Scope.signalRef`: the name of a declared signal is that signal, anything else an expression of the signals. */
function signalValue(text: string, ctx: ParamContext): unknown {
  return Object.hasOwn(ctx.signals, text) ? ctx.signals[text] : ctx.runtime.expr(text)({}, ctx.signals)
}

/**
 * vega's Expression operator: the expression over the tuple and the signals, an accessor with no name, whose fields are the
 * fields of `datum` the expression names (a heatmap colour that names no pixel field is evaluated once per grid).
 */
function expressionAccessor(text: string, ctx: ParamContext): Accessor {
  const fn = ctx.runtime.expr(text)
  const signals = ctx.signals
  return accessor((d: unknown) => fn(d, signals), [...datumFieldsOf(text)])
}

/**
 * The fields of `datum` an expression names (`datum.$x`, `datum['$value']`): what vega's code generator collects as the
 * expression's fields. A use it cannot see by name (`datum[name]`, `datum` handed to a function) is not one.
 */
export function datumFieldsOf(expr: string): Set<string> {
  const names = new Set<string>()
  const visit = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) visit(x); return }
    const node = n as AstNode
    if (node.type === 'MemberExpression') {
      const obj = node.object as AstNode
      const prop = node.property as AstNode
      if (obj.type === 'Identifier' && obj.name === 'datum') {
        if (!node.computed && prop.type === 'Identifier') names.add(String(prop.name))
        else if (node.computed && prop.type === 'Literal') names.add(String(prop.value))
      }
    }
    // bounded: the nodes of a parsed expression (the parser bounds its size and depth)
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(parseExpressionCached(expr))
  return names
}

const PLAIN = new WeakMap<object, boolean>()

const isName = (v: unknown): boolean => typeof v === 'string'
const isNames = (v: unknown): boolean => isName(v) || (Array.isArray(v) && v.every(isName))

/**
 * Whether every field and comparator the transform reads is written with plain names (a string, or a list of them): what the
 * incremental paths that key or order rows by the raw `groupby` / `fields` / `sort` (incremental-state.ts) can read without
 * resolving them. A `{signal}`, an `{expr}` or a `{field, as}` there means the step runs whole.
 */
export function fieldsArePlainNames(t: CompiledTransform): boolean {
  let plain = PLAIN.get(t)
  if (plain === undefined) {
    const o = t as unknown as Rec
    plain = transformParams(t.type).every((p) => {
      const v = o[p.name]
      if (v === undefined) return true
      if (p.kind === 'field') return isNames(v)
      if (p.kind === 'compare') return isRecord(v) && (v.field === undefined || isNames(v.field)) && (v.order === undefined || isNames(v.order))
      return true
    })
    PLAIN.set(t, plain)
  }
  return plain
}

/**
 * Refuse what vega's runtime cannot make a field accessor of, when it builds the view (`new View`), before anything runs: a field
 * written as something truthy that is no access path -- an object that is neither `{signal}`, `{expr}` nor `{field}`, a number,
 * `true`, a `{field}` whose field is no path, a comparator's field that is no path (an empty name included) -- makes vega's code
 * generator write `return _[];`, which the JavaScript engine refuses with this SyntaxError. (A falsy field is no accessor at all,
 * and a path that is malformed is refused by `splitAccessPath` itself, as in vega.)
 */
export function checkFieldReferences(t: Rec): void {
  checkParams(t, transformParams(t.type))
}

const NO_PATH = "Unexpected token ']'"

const emptyPath = (v: unknown): boolean => (typeof v === 'string' ? v !== '' && splitAccessPath(v).length === 0 : !Array.isArray(v))

function checkParams(o: Rec, params: readonly TransformParam[]): void {
  // bounded: the fixed table of a transform's parameters
  for (const p of params) {
    const v = o[p.name]
    if (v === undefined || isSignal(v)) continue
    if (p.sub !== undefined) {
      for (const item of p.list && Array.isArray(v) ? v : [v]) if (isRecord(item)) checkParams(item, subParamsOf(p, item))
      continue
    }
    // bounded: the elements the spec writes for one parameter
    for (const x of p.list && Array.isArray(v) ? v : [v]) {
      if (p.kind === 'field' && !isSignal(x)) {
        // (a parameter vega computes per tuple but is no field -- `pointRadius`, `fontSize` -- is a constant unless an object)
        const fieldOnly = !p.computed
        if (isRecord(x)) {
          if (x.expr) continue
          if (x.field ? emptyPath(x.field) : fieldOnly) throw new SyntaxError(NO_PATH)
        } else if (fieldOnly && x && typeof x !== 'string' && emptyPath(x)) throw new SyntaxError(NO_PATH)
      } else if (p.kind === 'compare' && isRecord(x)) {
        for (const f of array(x.field)) {
          if (f == null || isSignal(f) || (isRecord(f) && f.expr)) continue
          if (typeof f === 'string' ? splitAccessPath(f).length === 0 : emptyPath(f)) throw new SyntaxError(NO_PATH)
        }
      }
    }
  }
}
