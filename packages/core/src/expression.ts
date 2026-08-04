/**
 * Expression engine.
 *
 * We reuse the spec language's own grammar: `vega-expression` parses the
 * expression DSL to an AST, and `vega-interpreter` evaluates that AST (CSP-safe,
 * no `new Function`). We supply the *function context* — the subset of
 * `vega-functions` semantics our runtime needs — bound to our scales/data, and
 * vega-format for number/time formatting (also pure). This keeps expression
 * semantics byte-compatible with vega while staying independent of vega's
 * runtime packages.
 */
import { parseExpression } from 'vega-expression'
import { expressionInterpreter } from 'vega-interpreter'
import { locale, defaultLocale } from 'vega-format'
import { isArray, isBoolean, isDate, isNumber, isObject, isRegExp, isString } from 'vega-util'

export interface ExpressionRuntime {
  /** Scale lookup by name. Returns the scale callable, or undefined. */
  scale: (name: string) => ((value: unknown) => unknown) | undefined
  /** Dataset lookup by name. Returns the rows, or undefined. */
  data: (name: string) => unknown[] | undefined
  /** Compile an expression string against this runtime. */
  expr: (expr: string) => CompiledExpr
}

export type CompiledExpr = (datum: unknown, params?: Record<string, unknown>) => unknown

const L = locale(defaultLocale)

function isValid(value: unknown): boolean {
  return value != null && value === value
}

function monthFormatValue(month: unknown): string {
  return L.timeFormat('%B')(new Date(2000, Number(month), 1))
}

function dayFormatValue(day: unknown): string {
  return L.timeFormat('%A')(new Date(2000, 0, 2 + Number(day)))
}

function createFunctionContext(runtime: ExpressionRuntime): Record<string, unknown> {
  return {
    isValid,
    isInvalid: (value: unknown) => value == null || value !== value,
    isArray,
    isBoolean,
    isDate,
    isNumber,
    isObject,
    isRegExp,
    isString,
    toBoolean: (value: unknown) => !!value,
    toNumber: (value: unknown) => Number(value),
    toDate: (value: unknown) => (value instanceof Date ? value : new Date(value as number)),
    toString: (value: unknown) => String(value),
    scale: function (this: unknown, name: string, value?: unknown) {
      const scale = runtime.scale(name)
      if (scale === undefined) return undefined
      return arguments.length > 1 ? scale(value) : scale
    },
    bandwidth: (name: string) => {
      const scale = runtime.scale(name)
      const bw = scale && (scale as { bandwidth?: () => number }).bandwidth
      return bw ? bw.call(scale) : undefined
    },
    data: (name: string) => runtime.data(name) ?? [],
    format: (value: unknown, spec?: string) => L.format(spec ?? '')(value),
    timeFormat: (value: unknown, spec?: string) => L.timeFormat(spec ?? '')(value),
    utcFormat: (value: unknown, spec?: string) => L.utcFormat(spec ?? '')(value),
    monthFormat: monthFormatValue,
    monthAbbrevFormat: (month: unknown) => L.timeFormat('%b')(new Date(2000, Number(month), 1)),
    dayFormat: dayFormatValue,
    dayAbbrevFormat: (day: unknown) => L.timeFormat('%a')(new Date(2000, 0, 2 + Number(day))),
  }
}

/** Compile an expression string to an evaluable function bound to a runtime. */
export function compileExpr(expr: string, runtime: ExpressionRuntime): CompiledExpr {
  const ast = parseExpression(expr)
  const functions = createFunctionContext(runtime)
  const evalParam = expressionInterpreter.parameter({ functions }, { ast })
  return (datum, params) => {
    // Signal values are exposed to expressions as $-prefixed params (vega convention).
    const p: Record<string, unknown> = {}
    if (params) {
      for (const key of Object.keys(params)) p[`$${key}`] = params[key]
    }
    return evalParam(datum, p)
  }
}
