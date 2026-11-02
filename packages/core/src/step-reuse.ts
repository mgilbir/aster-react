/**
 * What a dataset's transform step reads, so a later evaluation can keep the rows the step made instead of making them again.
 *
 * A step's output is a function of its input rows, its own parameters, and what its parameters and expressions read: signals
 * (by name, anywhere in an expression or in a `{signal}` parameter), the injected random source, and, for `identifier`, the numbers
 * the previous evaluation gave its rows. The steps listed here read nothing else -- no scale, no dataset, no projection, no
 * container, no clock -- so those are the whole of what a re-evaluation has to compare. A step that mentions anything the analysis
 * cannot account for (a function outside the lists below, `event`, `item`, a malformed expression) is never kept: it runs, as it
 * always has.
 *
 * The analysis is of the compiled transform alone, so it is made once per transform and kept beside it.
 */
import { parseExpressionCached, type Expr } from './expr-parser.js'
import { refId, valueKey } from './fingerprint.js'
import { mayDrawRandom } from './random-tape.js'
import type { CompiledTransform } from './types.js'

/** Transform types that read their rows, their parameters and the signals those mention, and nothing else of the view. */
const READS_ROWS_AND_SIGNALS = new Set([
  'formula', 'filter', 'bin', 'timeunit', 'extent', 'crossfilter', 'resolvefilter', 'aggregate', 'joinaggregate', 'window',
  'collect', 'identifier', 'project', 'fold', 'flatten', 'stack', 'impute', 'pivot', 'sample', 'sequence',
])

/** Expression functions that compute from their arguments alone (the clock, the locale, scales, datasets and the host are not among them). */
const PURE_FUNCTIONS = new Set([
  'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'clamp', 'cos', 'exp', 'floor', 'hypot', 'log', 'max', 'min', 'pow', 'round', 'sin', 'sqrt', 'tan',
  'date', 'datetime', 'day', 'dayofyear', 'hours', 'milliseconds', 'minutes', 'month', 'quarter', 'seconds', 'time', 'timezoneoffset',
  'utc', 'utcdate', 'utcday', 'utcdayofyear', 'utchours', 'utcmilliseconds', 'utcminutes', 'utcmonth', 'utcquarter', 'utcseconds', 'utcweek', 'utcyear', 'week', 'year',
  'if', 'indexof', 'inrange', 'isArray', 'isBoolean', 'isDate', 'isDefined', 'isFinite', 'isInvalid', 'isNaN', 'isNumber', 'isObject', 'isRegExp', 'isString', 'isValid',
  'join', 'lastindexof', 'length', 'lerp', 'lower', 'pad', 'parseFloat', 'parseInt', 'peek', 'pluck', 'replace', 'reverse', 'slice', 'span', 'split', 'substring',
  'toBoolean', 'toDate', 'toNumber', 'toString', 'trim', 'truncate', 'upper',
])

/** The expression functions that draw from the random source (see `mayDrawRandom`). */
const DRAWING_FUNCTIONS = new Set(['random', 'sampleNormal', 'sampleLogNormal', 'sampleUniform'])

/** Names an expression means by themselves, not as signals. */
const KEYWORDS = new Set(['datum'])

export interface StepReads {
  /** The names the step's parameters and expressions mention besides the row: their values (a signal's, or none) are the step's inputs. */
  signals: readonly string[]
  /** The step can draw from the random source. */
  draws: boolean
  /** The signal the step writes its result to (bin, extent, timeunit, crossfilter). */
  publishes: string | undefined
}

const ANALYSED = new WeakMap<object, StepReads | null>()

/** What `t` reads, or `null` when it is not a step whose output is known to depend on nothing else. */
export function stepReadsOf(t: CompiledTransform): StepReads | null {
  let reads = ANALYSED.get(t)
  if (reads === undefined) {
    reads = analyse(t)
    ANALYSED.set(t, reads)
  }
  return reads
}

function analyse(t: CompiledTransform): StepReads | null {
  if (!READS_ROWS_AND_SIGNALS.has(t.type as string)) return null
  const names = new Set<string>()
  const params = t as unknown as Record<string, unknown>
  for (const key of Object.keys(params)) {
    // (a string `signal` on the transform itself names the signal it writes; an object one reads a signal)
    if (key === 'type' || (key === 'signal' && typeof params[key] === 'string')) continue
    if (!walkParam(params[key], names, key === 'expr', 0)) return null
  }
  const publishes = typeof params.signal === 'string' ? params.signal : undefined
  return { signals: [...names].sort(), draws: mayDrawRandom(t), publishes }
}

/** Collect the signals a parameter reads; `false`: it reads something the analysis does not cover. */
function walkParam(v: unknown, names: Set<string>, isExpr: boolean, depth: number): boolean {
  if (typeof v === 'string') return isExpr ? readExpression(v, names) : true
  if (v === null || typeof v !== 'object') return true
  if (depth > 8) return false
  if (Array.isArray(v)) {
    for (const x of v) if (!walkParam(x, names, false, depth + 1)) return false
    return true
  }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  // `{signal: <expression>}` is a signal reference (the engine resolves it before the step runs: see resolveSignalParams)
  if (keys.length === 1 && keys[0] === 'signal' && typeof o.signal === 'string') return readExpression(o.signal, names)
  for (const k of keys) if (!walkParam(o[k], names, k === 'expr', depth + 1)) return false
  return true
}

function readExpression(code: string, names: Set<string>): boolean {
  let tree: Expr
  try { tree = parseExpressionCached(code) } catch { return false }
  return readTree(tree, names)
}

function readTree(e: Expr | null, names: Set<string>): boolean {
  if (e === null) return true
  switch (e.type) {
    case 'Literal': return true
    case 'Identifier':
      if (e.name === 'event' || e.name === 'item' || e.name === 'this') return false
      if (!KEYWORDS.has(e.name)) names.add(e.name)
      return true
    case 'MemberExpression':
      return readTree(e.object, names) && (!e.computed || readTree(e.property, names))
    case 'CallExpression': {
      const f = e.callee
      if (f.type !== 'Identifier' || !(PURE_FUNCTIONS.has(f.name) || DRAWING_FUNCTIONS.has(f.name))) return false
      for (const a of e.arguments) if (!readTree(a, names)) return false
      return true
    }
    case 'UnaryExpression': return readTree(e.argument, names)
    case 'BinaryExpression': case 'LogicalExpression': return readTree(e.left, names) && readTree(e.right, names)
    case 'ConditionalExpression': return readTree(e.test, names) && readTree(e.consequent, names) && readTree(e.alternate, names)
    case 'ArrayExpression':
      for (const x of e.elements) if (!readTree(x, names)) return false
      return true
    case 'ObjectExpression':
      for (const p of e.properties) if (!readTree(p.value, names)) return false
      return true
    default: return false
  }
}

/**
 * A key that is equal for two values exactly when a step reading them cannot tell them apart. Plain data is keyed by its content (a
 * derived signal is a new array each pass); anything with state of its own -- a function, a class instance, an object carrying
 * hidden properties such as a crossfilter's bitmaps, which hash by their mask alone -- by identity.
 */
export function dependencyKey(v: unknown): string {
  return hidesState(v, 0, { nodes: 0 }) ? `#${refId(v as object)}` : valueKey(v)
}

function hidesState(v: unknown, depth: number, budget: { nodes: number }): boolean {
  if (v === null || typeof v !== 'object') return false
  if (++budget.nodes > 512 || depth > 6) return false
  if (Array.isArray(v)) {
    for (const x of v) if (hidesState(x, depth + 1, budget)) return true
    return false
  }
  if (v instanceof Date || v instanceof Set) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  const o = v as Record<string, unknown>
  if (Object.getOwnPropertyNames(o).length !== Object.keys(o).length || Object.getOwnPropertySymbols(o).length) return true
  for (const k of Object.keys(o)) if (hidesState(o[k], depth + 1, budget)) return true
  return false
}

/** What one run of a step left, for the evaluation that may keep it. */
export interface StepRecord {
  /** `dependencyKey` of each of the step's signals, as they stood when it ran (parallel to `StepReads.signals`). */
  keys: readonly string[]
  /** The value the step wrote to the signal it publishes, if it wrote one. */
  published?: { value: unknown }
  /** The random source a drawing step ran with, and the Box-Muller carry-over it left. */
  random?: { source: unknown; carry: number | undefined }
}

/** How many steps ran and how many were kept, since the counters were last read. For the tests; nothing reads them in a build. */
export const stepCounts = { ran: 0, reused: 0 }

/**
 * Whether a step may be kept at all. On unless a test turns it off: the differential that pins the kept steps to the ones the
 * engine makes without keeping any evaluates its reference with this off.
 */
export const reuse = { on: true }

const PIPELINES = new WeakMap<readonly CompiledTransform[], readonly string[] | null>()

/**
 * The signals a whole pipeline mentions, when every step of it is one whose rows depend on its input rows and those signals alone
 * (no draw, no signal written, no row numbering); `null` otherwise.
 */
export function pipelineReadsOf(transforms: readonly CompiledTransform[]): readonly string[] | null {
  let names = PIPELINES.get(transforms)
  if (names === undefined) {
    const all = new Set<string>()
    names = transforms.every((t) => {
      const reads = stepReadsOf(t)
      if (reads === null || reads.draws || reads.publishes !== undefined || t.type === 'identifier') return false
      for (const n of reads.signals) all.add(n)
      return true
    }) ? [...all].sort() : null
    PIPELINES.set(transforms, names)
  }
  return names
}
