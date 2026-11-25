/**
 * What vega's tuples carry from one run of the dataflow to the next, for a pipeline whose steps read what a step at or after them
 * writes (vega/reorderable-matrix: `score` reads `order`, which the `window` after it writes).
 *
 * In vega a dataset's tuples are objects its transforms write onto, and they live as long as the data does: a transform runs again
 * only when its parameters changed or the fields it reads were modified upstream in the same run, and a transform that does not run
 * leaves what it wrote -- and what the steps after it wrote over that -- on the tuple. So after a signal change a step that reads a
 * field a later step writes reads the value the later step wrote in the run before, not the value an earlier step would give it now.
 * Where no step reads such a field, the tuples hold what a fresh run of the pipeline gives them, and the engine's evaluation (a
 * function of its inputs) is vega's; where one does, the evaluation starts from the rows the evaluation before left (runtime.ts
 * `historyRun`) and runs exactly the steps vega would run again.
 *
 * This module is the static half: which pipelines have such a read, and, for each step, what vega's transform compares to decide
 * whether it runs again in a run that adds and removes no tuple (its parameters' signals, the fields of the pulse it reads) and what
 * it writes. Only steps that keep every tuple and write fields onto them take part (see `stepOf`); a pipeline with any other step is
 * evaluated as before.
 */
import { parseExpressionCached, type Expr } from './expr-parser.js'
import type { CompiledTransform } from './types.js'

/**
 * One step as vega's dataflow sees it in a run that adds and removes no tuple. `rule` is when it runs again over the tuples it has:
 * - `fields`: when a field it reads (`inputs`) was modified upstream in the same run (vega: `pulse.modified(fields)`: formula, bin,
 *   timeunit, window, joinaggregate);
 * - `any`: whenever anything upstream ran (vega: it recomputes over its source whenever it is pulsed, or on `pulse.changed()`: stack,
 *   pie, dotbin, linkpath, voronoi, collect);
 * - `once`: never: it visits only added tuples (identifier, a formula with `initonly`).
 * Every step also runs again when a signal it reads was set.
 */
export interface HistoryStep {
  /** The fields it reads (for `fields`: whose modification upstream makes it run again). */
  readonly inputs: readonly string[]
  /** The fields it writes onto every tuple when it runs (vega: `pulse.modifies(as)`). */
  readonly writes: readonly string[]
  /** It runs again when a field it writes was modified upstream (a formula: `pulse.modified(as)`). */
  readonly rerunsOnWrites: boolean
  readonly rule: 'fields' | 'any' | 'once'
}

const PLANS = new WeakMap<readonly CompiledTransform[], readonly HistoryStep[] | null>()

/** The steps of `transforms` as vega runs them, when every step is one this module knows; `null` otherwise. */
export function vegaPlan(transforms: readonly CompiledTransform[]): readonly HistoryStep[] | null {
  let plan = PLANS.get(transforms)
  if (plan === undefined) {
    plan = planOf(transforms)
    PLANS.set(transforms, plan)
  }
  return plan
}

/**
 * The steps of `transforms` as vega runs them, when the pipeline reads, at some step, a field that step or a later one writes and every
 * step is one this module knows; `null` otherwise (the evaluation of the pipeline is a function of its input, as vega's is).
 */
export function historyPlan(transforms: readonly CompiledTransform[]): readonly HistoryStep[] | null {
  const steps = vegaPlan(transforms)
  if (steps === null) return null
  // (a read of a field that this step or a later one writes: what the tuple holds there is what the run before left)
  for (let k = 0; k < steps.length; k++) {
    for (let j = k; j < steps.length; j++) if (steps[k]!.inputs.some((f) => steps[j]!.writes.includes(f))) return steps
  }
  return null
}

function planOf(transforms: readonly CompiledTransform[]): readonly HistoryStep[] | null {
  if (transforms.length === 0) return null
  const steps: HistoryStep[] = []
  for (const t of transforms) {
    const s = stepOf(t)
    if (s === null) return null
    steps.push(s)
  }
  return steps
}

/**
 * Which steps vega runs again in a run over the same tuples (see `HistoryStep`): `changed[k]` says that a signal step `k` reads was set,
 * `upstream` the fields modified before the pipeline (its source's run). Returns, per step, whether it runs, and the fields modified at
 * the end of the pipeline.
 */
export function rerunsOf(plan: readonly HistoryStep[], changed: readonly boolean[], upstream: ReadonlySet<string>): { runs: boolean[]; modified: Set<string> } {
  const modified = new Set(upstream)
  const runs = plan.map((step, k) => {
    const run = step.rule !== 'once' && (changed[k] === true
      || (step.rule === 'any' ? modified.size > 0 : step.inputs.some((f) => modified.has(f)) || (step.rerunsOnWrites && step.writes.some((f) => modified.has(f)))))
    if (run) for (const f of step.writes) modified.add(f)
    return run
  })
  return { runs, modified }
}

const strings = (v: unknown): string[] | null => {
  const list = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]
  return list.every((x) => typeof x === 'string') ? list as string[] : null
}

/** The fields a `sort` parameter (`{field, order}`) compares. */
const sortFields = (sort: unknown): string[] | null => {
  if (sort === undefined || sort === null) return []
  if (typeof sort !== 'object' || Array.isArray(sort)) return null
  return strings((sort as { field?: unknown }).field)
}

function stepOf(t: CompiledTransform): HistoryStep | null {
  const p = t as unknown as Record<string, unknown>
  switch (t.type) {
    case 'formula': {
      if (typeof p.expr !== 'string' || typeof p.as !== 'string') return null
      const inputs = exprFields(p.expr)
      return inputs === null ? null : { inputs, writes: [p.as], rerunsOnWrites: true, rule: p.initonly === true ? 'once' : 'fields' }
    }
    case 'bin': case 'timeunit': {
      const field = p.field
      if (typeof field !== 'string') return null
      const as = strings(p.as ?? (t.type === 'bin' ? ['bin0', 'bin1'] : ['unit0', 'unit1']))
      return as === null || typeof p.signal === 'string' ? null : { inputs: [field], writes: as, rerunsOnWrites: false, rule: 'fields' }
    }
    case 'window': {
      // vega-transforms WindowState: the inputs are the sort fields and the fields of the ops; the outputs are `as`, or op_field
      const ops = strings(p.ops)
      const fields = Array.isArray(p.fields) ? p.fields : []
      const as = Array.isArray(p.as) ? p.as : []
      const sorts = sortFields(p.sort)
      if (ops === null || sorts === null || !fields.every((f) => f === null || typeof f === 'string') || !as.every((a) => a === null || typeof a === 'string')) return null
      const inputs = [...sorts, ...(fields.filter((f) => typeof f === 'string') as string[])]
      const writes = ops.map((op, i) => (as[i] as string | null | undefined) ?? (typeof fields[i] === 'string' ? `${op}_${fields[i]}` : op))
      return { inputs, writes, rerunsOnWrites: false, rule: 'fields' }
    }
    case 'joinaggregate': {
      // vega-transforms JoinAggregate: re-aggregates when its inputs (the measured fields and the groupby) were modified
      const ops = strings(p.ops)
      const fields = Array.isArray(p.fields) ? p.fields : []
      const as = Array.isArray(p.as) ? p.as : []
      const groupby = strings(p.groupby)
      if (ops === null || groupby === null || !fields.every((f) => f === null || typeof f === 'string') || !as.every((a) => a === null || typeof a === 'string')) return null
      const writes = ops.map((op, i) => (as[i] as string | null | undefined) ?? (typeof fields[i] === 'string' ? `${op}_${fields[i]}` : op))
      return { inputs: [...groupby, ...(fields.filter((f) => typeof f === 'string') as string[])], writes, rerunsOnWrites: false, rule: 'fields' }
    }
    case 'collect': {
      const sorts = sortFields(p.sort)
      return sorts === null ? null : { inputs: sorts, writes: [], rerunsOnWrites: false, rule: 'any' }
    }
    case 'extent': {
      // (writes no tuple: it publishes the extent of the field over its source whenever it is pulsed, vega-transforms Extent)
      const field = p.field
      return typeof field === 'string' ? { inputs: [field.split('.')[0]!], writes: [], rerunsOnWrites: false, rule: 'any' } : null
    }
    case 'lookup': {
      // vega-transforms Lookup: the looked-up rows are written again when its index changed (the other dataset changed: a parameter of
      // the step, see runtime.ts `historyParams`) or a key field was modified
      const keys = strings(p.fields)
      const writes = strings(p.as) ?? strings(p.values)
      return keys === null || writes === null || writes.length === 0 ? null : { inputs: keys.map((k) => k.split('.')[0]!), writes, rerunsOnWrites: false, rule: 'fields' }
    }
    case 'identifier':
      return typeof p.as === 'string' ? { inputs: [], writes: [p.as], rerunsOnWrites: false, rule: 'once' } : null
    // (the steps that recompute over their source whenever they are pulsed: vega-encode Stack, Pie, LinkPath; vega-transforms DotBin;
    // vega-voronoi Voronoi)
    case 'stack': return anyRule(p, ['field', 'groupby', 'sort'], ['y0', 'y1'])
    case 'pie': return anyRule(p, ['field'], ['startAngle', 'endAngle'])
    case 'dotbin': return anyRule(p, ['field', 'groupby'], ['bin'])
    case 'linkpath': return anyRule(p, ['sourceX', 'sourceY', 'targetX', 'targetY'], ['path'], { sourceX: 'source.x', sourceY: 'source.y', targetX: 'target.x', targetY: 'target.y' })
    case 'voronoi': return anyRule(p, ['x', 'y'], ['path'])
    default: return null
  }
}

/** A step of the `any` rule: the fields its parameters `reads` name (a field, a list, a `{field}` sort; `defaults` when absent) and `as`. */
function anyRule(p: Record<string, unknown>, reads: readonly string[], as: readonly string[], defaults: Record<string, string> = {}): HistoryStep | null {
  const inputs: string[] = []
  for (const key of reads) {
    const v = p[key] ?? defaults[key]
    const names = key === 'sort' ? sortFields(v) : strings(v)
    if (names === null) return null
    // (a nested path reads its first field)
    for (const n of names) inputs.push(n.split('.')[0]!)
  }
  const writes = strings(p.as ?? as)
  return writes === null ? null : { inputs, writes, rerunsOnWrites: false, rule: 'any' }
}

/**
 * The fields an expression reads off `datum` by name (vega-functions' codegen: `datum.a`, `datum["a"]`, the first name of
 * `datum.a.b`), which are the fields vega's formula compares. The row as a whole (`datum === src`) is no field read. `null`: the
 * expression does not parse.
 */
function exprFields(code: string): string[] | null {
  let tree: Expr
  try { tree = parseExpressionCached(code) } catch { return null }
  const found = new Set<string>()
  const visit = (e: unknown): void => {
    if (e === null || e === undefined || typeof e !== 'object') return
    if (Array.isArray(e)) { for (const x of e) visit(x); return }
    const n = e as Record<string, unknown>
    if (n.type === 'MemberExpression') {
      const o = n.object as { type?: string; name?: string }
      const p = n.property as { type?: string; name?: string; value?: unknown }
      if (o?.type === 'Identifier' && o.name === 'datum') {
        if (n.computed !== true && p?.type === 'Identifier') found.add(p.name!)
        else if (n.computed === true && p?.type === 'Literal' && typeof p.value === 'string') found.add(p.value)
        else visit(n.property)
        return
      }
    }
    for (const k of Object.keys(n)) if (k !== 'type') visit(n[k])
  }
  visit(tree)
  return [...found]
}
