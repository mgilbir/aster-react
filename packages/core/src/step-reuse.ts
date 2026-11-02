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

/** The node types known to compute from their children alone; any other type (a new or forgotten shape) keeps the step out. */
const PURE_NODES = new Set(['Literal', 'Identifier', 'MemberExpression', 'CallExpression', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'ArrayExpression', 'ObjectExpression', 'Property'])

/**
 * Every identifier of the tree, found by walking ALL the child nodes of a node whatever its type (not the branches a type is known to
 * have), so that a read in any position is seen. The only names that are not reads are a property key (`a.b`, `{b: 1}`) and a called
 * function, which must be a pure or drawing one. `false`: the tree holds a node of a type not known to be pure, or `event`/`item`.
 */
function readTree(e: unknown, names: Set<string>): boolean {
  if (e === null || e === undefined) return true
  if (Array.isArray(e)) return e.every((x) => readTree(x, names))
  if (typeof e !== 'object') return true
  const node = e as { type?: unknown } & Record<string, unknown>
  if (typeof node.type !== 'string' || !PURE_NODES.has(node.type)) return false
  switch (node.type) {
    case 'Literal': return true
    case 'Identifier': {
      const name = node.name as string
      if (name === 'event' || name === 'item' || name === 'this') return false
      if (!KEYWORDS.has(name)) names.add(name)
      return true
    }
    case 'MemberExpression':
      // (a property name is not a read; a computed property is an expression)
      return readTree(node.object, names) && (node.computed !== true || readTree(node.property, names))
    case 'Property': return readTree(node.value, names)
    case 'CallExpression': {
      const f = node.callee as { type?: string; name?: string }
      if (f?.type !== 'Identifier' || !(PURE_FUNCTIONS.has(f.name!) || DRAWING_FUNCTIONS.has(f.name!))) return false
      return readTree(node.arguments, names)
    }
    default:
      // every other child of the node, whatever it is called
      for (const k of Object.keys(node)) if (k !== 'type' && !readTree(node[k], names)) return false
      return true
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

// ---------------------------------------------------------------------------
// Steps that write onto rows, run as one
// ---------------------------------------------------------------------------

/** The fields a row-writing step reads from its rows and the fields it writes to them. */
interface Footprint { reads: readonly string[]; writes: readonly string[] }

const FOOTPRINTS = new WeakMap<object, Footprint | null>()

/** A plain field name: no access path, so it is the name of one property of the row. */
const PLAIN_FIELD = /^[^.[\]\\]+$/

function footprintOf(t: CompiledTransform): Footprint | null {
  let found = FOOTPRINTS.get(t)
  if (found === undefined) {
    found = footprint(t as unknown as Record<string, unknown>)
    FOOTPRINTS.set(t, found)
  }
  return found
}

function footprint(p: Record<string, unknown>): Footprint | null {
  const names = (v: unknown, fallback: readonly string[]): string[] | null => {
    const list = v === undefined ? fallback : v
    return Array.isArray(list) && list.every((x) => typeof x === 'string') ? [...list as string[]] : null
  }
  switch (p.type) {
    case 'formula': {
      if (typeof p.expr !== 'string' || typeof p.as !== 'string') return null
      const reads = datumFields(p.expr)
      return reads === null ? null : { reads, writes: [p.as] }
    }
    case 'bin': case 'timeunit': {
      if (typeof p.field !== 'string' || !PLAIN_FIELD.test(p.field)) return null
      const as = names(p.as, p.type === 'bin' ? ['bin0', 'bin1'] : ['unit0', 'unit1'])
      if (as === null || as.length < 2) return null
      return { reads: [p.field], writes: p.interval === false ? [as[0]!] : [as[0]!, as[1]!] }
    }
    default: return null
  }
}

/**
 * The fields an expression reads off `datum` by name; `null` when it uses the row any other way (as a whole, by a computed name) or
 * holds a node of a type not known to be pure. All child nodes of a node are walked, whatever its type.
 */
function datumFields(code: string): string[] | null {
  let tree: Expr
  try { tree = parseExpressionCached(code) } catch { return null }
  const found = new Set<string>()
  const visit = (e: unknown): boolean => {
    if (e === null || e === undefined) return true
    if (Array.isArray(e)) return e.every(visit)
    if (typeof e !== 'object') return true
    const n = e as { type?: unknown } & Record<string, unknown>
    if (typeof n.type !== 'string' || !PURE_NODES.has(n.type)) return false
    if (n.type === 'Identifier') return n.name !== 'datum'
    if (n.type === 'Literal') return true
    if (n.type === 'Property') return visit(n.value)
    if (n.type === 'MemberExpression') {
      const o = n.object as { type?: string; name?: string }
      const p = n.property as { type?: string; name?: string; value?: unknown }
      if (o?.type === 'Identifier' && o.name === 'datum') {
        if (n.computed !== true && p.type === 'Identifier') { found.add(p.name!); return true }
        if (n.computed === true && p.type === 'Literal' && typeof p.value === 'string') { found.add(p.value); return true }
        return false
      }
      return visit(n.object) && (n.computed !== true || visit(n.property))
    }
    for (const k of Object.keys(n)) if (k !== 'type' && !visit(n[k])) return false
    return true
  }
  return visit(tree) ? [...found] : null
}

const UNITS = new WeakMap<readonly CompiledTransform[], readonly number[]>()

/**
 * Where the run of steps starting at each index ends (`ends[k] === k` for a step that runs alone). A run is consecutive steps that
 * only add fields to the rows they are given -- `formula`, `bin`, `timeunit` -- and read nothing another step of the run writes
 * or is yet to write, so that running them one after the other over one set of rows (each step writing onto the rows the one
 * before made) gives every row what it would be given by writing each step's fields onto its own copy. A step that draws,
 * publishes a signal or reads what a later step of the run writes ends the run before it.
 */
export function runsOf(transforms: readonly CompiledTransform[]): readonly number[] {
  let ends = UNITS.get(transforms)
  if (ends !== undefined) return ends
  const out: number[] = new Array(transforms.length)
  let start = 0
  const members: Footprint[] = []
  const admits = (f: Footprint): boolean => {
    if (f.reads.some((r) => f.writes.includes(r))) return false
    return members.every((m) => !f.writes.some((w) => m.writes.includes(w) || m.reads.includes(w)))
  }
  for (let k = 0; k < transforms.length; k++) {
    const t = transforms[k]!
    const reads = stepReadsOf(t)
    const f = reads !== null && !reads.draws && reads.publishes === undefined ? footprintOf(t) : null
    if (f !== null && members.length > 0 && admits(f)) {
      members.push(f)
    } else {
      for (let i = start; i < k; i++) out[i] = k - 1
      start = k
      members.length = 0
      if (f !== null) members.push(f)
    }
  }
  for (let i = start; i < transforms.length; i++) out[i] = transforms.length - 1
  UNITS.set(transforms, (ends = out))
  return ends
}

/** The fields a step that only adds fields writes (see {@link runsOf}). */
export function fieldsWritten(t: CompiledTransform): readonly string[] {
  return footprintOf(t)?.writes ?? []
}

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
