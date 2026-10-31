/**
 * Reading a scale spec: what a scale needs from its surroundings (`ScaleContext`: signal values, datasets, the size of the
 * view) and how a spec value that may be a `{signal}` reference is turned into a value.
 */
import { error as raise, isObject } from './util.js'

export interface ScaleContext {
  width: number
  height: number
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** `config.range`: a named range ('category', 'ramp', ...) resolves through it before the built-in aliases. */
  configRange?: Record<string, unknown>
  /** Evaluate a JS expression string and return the result. */
  evaluate?: (expr: string) => unknown
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
  /** Return all rows of a named dataset (identity keys the per-evaluation memo). */
  dataRows?: (dataName: string) => Record<string, unknown>[]
  /** True when the named dataset exists (a domain over an unknown dataset is refused). */
  hasData?: (dataName: string) => boolean
  /** Host/runtime domain override (pan/zoom, brush domains). */
  domainRaw?: unknown[]
  /**
   * Distinct-value memo keyed by the dataset rows ARRAY identity. It must live exactly as long as one evaluation: the
   * incremental path (and hosts that mutate their arrays in place) reuse an array object with new contents, so a
   * process-global memo would serve stale domains.
   */
  distinctCache?: WeakMap<unknown[], Map<string, unknown[]>>
  /**
   * Present when the scale is made in a pass of a view that makes another (autosize fit). A scale operator keeps its scale
   * between passes, so a pass that changes its parameters finds `bins` where the pass before left them, and a scale with
   * bins leaves the zero out of its default domain: the first pass includes it, the second does not.
   */
  pass?: { prev: { key: string; bins: boolean } | undefined; record: (key: string, bins: boolean) => void }
}

/** A name a signal reference may be: a bare identifier. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
/** Names an expression knows without a signal. */
const EXPRESSION_CONSTANTS = new Set(['NaN', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2', 'MIN_VALUE', 'MAX_VALUE'])

/** The value a `signal` reference stands for: a named signal's value, or the value of an expression. */
export function signalValue(reference: string, ctx: ScaleContext): unknown {
  if (Object.hasOwn(ctx.signals, reference)) return ctx.signals[reference]
  // a bare name that is no signal is a slip in the spec; anything else is an expression
  if (IDENTIFIER.test(reference) && !EXPRESSION_CONSTANTS.has(reference)) raise(`Unrecognized signal name: ${reference}`)
  if (!ctx.evaluate) raise(`Unrecognized signal expression: ${reference}`)
  return ctx.evaluate!(reference)
}

/** A spec value: itself, or what its `signal` reference stands for; any other object is refused. */
export function plain(value: unknown, ctx: ScaleContext): unknown {
  if (!isObject(value)) return value
  const reference = (value as { signal?: unknown }).signal
  if (reference) return signalValue(String(reference), ctx)
  return raise('Unsupported object: ' + JSON.stringify(value))
}

/** A spec list (or a `{signal}` standing for one), each entry read with `plain`. */
export function plainList(value: unknown, ctx: ScaleContext): unknown {
  const reference = (value as { signal?: unknown }).signal
  return reference ? signalValue(String(reference), ctx) : (value as unknown[]).map((entry) => plain(entry, ctx))
}

/** An object whose members may each be `{signal}` references. */
export function plainRecord(value: Record<string, unknown>, ctx: ScaleContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = plain(value[key], ctx)
  return out
}
