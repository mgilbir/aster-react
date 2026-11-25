/**
 * Planning the url datasets of a spec (internal, `@aster-charts/core/lean/load`): which datasets load from which url, with a
 * `{signal}` url evaluated over its own scope's signals and the host's. `loadSpecData` (addon-load.ts) fetches what this plans;
 * `datasetUrls` is the plan without the fetch, for a host that keeps url data current.
 */
import type { LoadOptions } from './addon-load.js'
import type { VgSpec } from './types.js'
import type { DataFormatSpec } from './data-format.js'
import { dataInputOf, specList } from './spec-structure.js'
import { compileExpr, type ExpressionRuntime } from './expression.js'
import { parseExpression } from './expr-parser.js'
import { AsterLimitError, assertSpecDepth, withLimits } from './limits.js'

// --- walking the spec ---------------------------------------------------------

export type Json = Record<string, unknown>

export interface LoadTask { def: Json; url: string; format: DataFormatSpec | undefined; name: string }

const NO_DATA_RUNTIME: ExpressionRuntime = {
  scale: () => undefined,
  data: () => undefined,
  expr: (e) => compileExpr(e, NO_DATA_RUNTIME),
}

/** The names an expression reads (its free identifiers: not a property name, not a called function's name). */
function namesRead(code: string): string[] {
  const out = new Set<string>()
  const stack: unknown[] = [parseExpression(code)]
  while (stack.length) {
    const n = stack.pop()
    if (n === null || typeof n !== 'object') continue
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue }
    const node = n as Json
    switch (node.type) {
      case 'Identifier': out.add(node.name as string); break
      case 'MemberExpression': stack.push(node.object); if (node.computed) stack.push(node.property); break
      case 'CallExpression': stack.push(node.arguments); break
      case 'Property': stack.push(node.value); break
      default: for (const k of Object.keys(node)) if (k !== 'type') stack.push(node[k])
    }
  }
  return [...out]
}

/**
 * The signals one scope declares (the view's or a group mark's), and the values worked out so far. A `{signal}` url is
 * evaluated, as vega does when the view starts, over the signals it reads: the closest declaration in its scope or one around
 * it, each from its `value` (or the host's, for a top-level signal) or its `init` / `update` expression over the signals that
 * one reads in turn. Only what the url reads is evaluated.
 */
class SignalScope {
  private readonly defs = new Map<string, Json>()
  private readonly values = new Map<string, unknown>()
  private readonly pending = new Set<string>()
  /** The view's numeric `width` / `height` (vega's view signals of those names). */
  readonly viewSize = new Map<string, unknown>()

  constructor(readonly parent: SignalScope | null, signals: unknown, private readonly host?: Readonly<Record<string, unknown>>) {
    for (const def of specList(signals)) {
      if (def && typeof def === 'object' && typeof (def as Json).name === 'string') this.defs.set((def as Json).name as string, def as Json)
    }
  }

  /** The value of `name` as seen from this scope (undefined when no scope declares it). */
  value(name: string): unknown {
    for (let s: SignalScope | null = this; s; s = s.parent) if (s.declares(name)) return s.own(name)
    return undefined
  }

  private declares(name: string): boolean {
    return this.defs.has(name) || this.viewSize.has(name) || (this.host !== undefined && Object.hasOwn(this.host, name))
  }

  private own(name: string): unknown {
    if (this.host !== undefined && Object.hasOwn(this.host, name)) return this.host[name]
    if (this.values.has(name)) return this.values.get(name)
    const def = this.defs.get(name)
    if (!def) return this.viewSize.get(name)
    // (a definition that reads itself, directly or through others, has no value yet: undefined, as an unset signal)
    if (this.pending.has(name)) return undefined
    this.pending.add(name)
    let v: unknown = def.value
    try {
      const expr = typeof def.init === 'string' ? def.init : typeof def.update === 'string' ? def.update : undefined
      if (v === undefined && expr !== undefined) v = this.evaluate(expr)
    } finally {
      this.pending.delete(name)
    }
    this.values.set(name, v)
    return v
  }

  /**
   * An expression over the signals it reads. A budget refusal (the regular-expression screen, the clock) is the call's
   * failure; any other error leaves the value undefined, as a signal that needs data or scales is when the view starts.
   */
  evaluate(expr: string): unknown {
    try {
      const signals: Json = Object.create(null) as Json
      for (const name of namesRead(expr)) signals[name] = this.value(name)
      return compileExpr(expr, NO_DATA_RUNTIME)(undefined, signals)
    } catch (e) {
      if (e instanceof AsterLimitError) throw e
      return undefined
    }
  }
}

/**
 * Copy only the paths of `spec` that hold url datasets (top level AND inside
 * nested group marks, at any depth) and queue one task per dataset. The input is
 * never mutated; untouched branches are shared with it. A `{signal}` url is
 * evaluated in its own scope (see SignalScope).
 */
export function planLoads(spec: Json, tasks: LoadTask[], hostSignals: Readonly<Record<string, unknown>> | undefined): Json {
  // a deep or cyclic spec is a typed refusal here, as in every other entry point, never a stack overflow
  assertSpecDepth(spec)
  // (the lists are read as the compiler reads them, vega-util `array()`: a single object is a one-element list, and a list made
  // of one is returned as an array when something in it changed)
  const visitData = (list: unknown, scope: SignalScope): unknown => {
    if (list == null) return list
    let changed = false
    const out = specList(list).map((d) => {
      const def = d as Json | null
      // (a dataset vega loads from its url: no values, a url; see dataInputOf)
      if (def && typeof def === 'object' && dataInputOf(def) === 'url') {
        // vega loads a `{signal}` url dynamically (a Load operator re-run when the signal changes); a static spec
        // is loaded for the value the signal has when the view starts
        const expr = typeof def.url === 'object' && def.url !== null ? (def.url as Json).signal : undefined
        const url = typeof def.url === 'string' ? def.url : typeof expr === 'string' ? scope.evaluate(expr) : undefined
        if (typeof url !== 'string') {
          throw new Error(`[aster] dataset "${String(def.name)}": url must be a string (or a {signal} whose initial value is one)`)
        }
        const copy: Json = { ...def }
        tasks.push({ def: copy, url, format: def.format as DataFormatSpec | undefined, name: String(def.name) })
        changed = true
        return copy
      }
      return d
    })
    return changed ? out : list
  }
  const visitMarks = (marks: unknown, outer: SignalScope): unknown => {
    if (marks == null) return marks
    let changed = false
    const out = specList(marks).map((m) => {
      if (!m || typeof m !== 'object') return m
      const mark = m as Json
      // a group mark is a scope: its signals are seen by its own datasets and marks
      const scope = mark.type === 'group' && mark.signals != null ? new SignalScope(outer, mark.signals) : outer
      const data = visitData(mark.data, scope)
      const inner = visitMarks(mark.marks, scope)
      if (data === mark.data && inner === mark.marks) return m
      changed = true
      return { ...mark, ...(data !== mark.data ? { data } : {}), ...(inner !== mark.marks ? { marks: inner } : {}) }
    })
    return changed ? out : marks
  }
  const view = new SignalScope(null, spec.signals, hostSignals)
  for (const k of ['width', 'height'] as const) if (typeof spec[k] === 'number') view.viewSize.set(k, spec[k])
  const data = visitData(spec.data, view)
  const marks = visitMarks(spec.marks, view)
  if (data === spec.data && marks === spec.marks) return spec
  return { ...spec, ...(data !== spec.data ? { data } : {}), ...(marks !== spec.marks ? { marks } : {}) }
}

/**
 * The urls `loadSpecData(spec, { signals, limits })` would request, in document order, and nothing else: no request is made.
 * A `{signal}` url is evaluated as the load evaluates it (over its own scope's signals and the host's `signals`, under `limits`).
 * A host that keeps a spec's url data current compares this list before and after a signal change and loads only when it differs.
 */
export function datasetUrls(spec: VgSpec, opts: Pick<LoadOptions, 'signals' | 'limits'> = {}): string[] {
  const tasks: LoadTask[] = []
  withLimits(opts.limits, () => planLoads(spec as unknown as Json, tasks, opts.signals))
  return tasks.map((t) => t.url)
}

