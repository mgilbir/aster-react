/**
 * vega-parser `Scope.objectProperty`: a parameter that is an object or a list whose parts may be signals at any depth -- an axis's
 * and a legend's `values` and `tickCount`, `config.legend.layout`. vega makes one expression of it (`propertyLambda`): a part with
 * a truthy `signal` is that signal's expression, a list or an object is built of its parts, anything else is the value written. The
 * whole is a signal of the view, so its value is the one the signals give it now.
 *
 * The value is resolved here in the same shape, part by part; an expression that throws is reported and gives `undefined`, as the
 * operator vega makes of it would not compute.
 */
type Evaluate = (expression: string) => unknown

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'

export function objectProperty(spec: unknown, evaluate: Evaluate): unknown {
  if (!isObject(spec)) return spec
  if (spec.signal) return evaluate(String(spec.signal))
  if (Array.isArray(spec)) return spec.map((v) => objectProperty(v, evaluate))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) out[key] = objectProperty(spec[key], evaluate)
  return out
}

/** Whether a parameter holds a signal at any depth (so its value is the signals', not the one written). */
export function holdsSignal(spec: unknown): boolean {
  if (!isObject(spec)) return false
  if (spec.signal) return true
  return (Array.isArray(spec) ? spec : Object.values(spec)).some(holdsSignal)
}
