/**
 * What a dataset's transform step reads, so a later evaluation can keep the rows the step made instead of making them again.
 *
 * A step's output is a function of its input rows, its own parameters, and what its parameters and expressions read: signals
 * (by name, anywhere in an expression or in a `{signal}` parameter), the datasets an expression reads by a name it spells out
 * (`data("store")`, `vlSelectionTest("store", datum)`), the injected random source, and, for `identifier`, the numbers the previous
 * evaluation gave its rows. The steps listed here read nothing else -- no scale, no projection, no container, no clock -- so those
 * are the whole of what a re-evaluation has to compare. A step that mentions anything the analysis cannot account for (a function
 * outside the lists below, a dataset read by a computed name, `event`, `item`, a malformed expression) is never kept: it runs, as
 * it always has.
 *
 * The analysis is of the compiled transform alone, so it is made once per transform and kept beside it.
 */
import { parseExpressionCached, type Expr } from './expr-parser.js'
import { refId, valueKey } from './fingerprint.js'
import { mayDrawRandom } from './random-tape.js'
import { lexedAsWritten, lexedText } from './expr-text.js'
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

/**
 * Expression functions that read the rows of the dataset their first argument names, and compute from those and their other
 * arguments alone (vega-functions' data functions and vega-selections' tests). Kept only when that argument is a string literal.
 */
const DATASET_FUNCTIONS = new Set(['data', 'indata', 'vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])

/** The expression functions that draw from the random source (see `mayDrawRandom`). */
const DRAWING_FUNCTIONS = new Set(['random', 'sampleNormal', 'sampleLogNormal', 'sampleUniform'])

/** What the trees of a step call besides what they read: a function that draws from the random source. */
interface Calls { draws: boolean }

/** Names an expression means by themselves, not as signals. */
const KEYWORDS = new Set(['datum'])

export interface StepReads {
  /** The names the step's parameters and expressions mention besides the row: their values (a signal's, or none) are the step's inputs. */
  signals: readonly string[]
  /** The datasets its expressions read, by the names they spell out: their rows are the step's inputs too. */
  datasets: readonly string[]
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
  const datasets = new Set<string>()
  // (a drawing function called by an escaped name is no word the text holds: the trees say it too, see `readTree`)
  const calls: Calls = { draws: false }
  const params = t as unknown as Record<string, unknown>
  for (const key of Object.keys(params)) {
    // (a string `signal` on the transform itself names the signal it writes; an object one reads a signal)
    if (key === 'type' || (key === 'signal' && typeof params[key] === 'string')) continue
    if (!walkParam(params[key], names, datasets, calls, key === 'expr', 0)) return null
  }
  const publishes = typeof params.signal === 'string' ? params.signal : undefined
  return { signals: [...names].sort(), datasets: [...datasets].sort(), draws: mayDrawRandom(t) || calls.draws, publishes }
}

/** Collect the signals and datasets a parameter reads; `false`: it reads something the analysis does not cover. */
function walkParam(v: unknown, names: Set<string>, datasets: Set<string>, calls: Calls, isExpr: boolean, depth: number): boolean {
  if (typeof v === 'string') return isExpr ? readExpression(v, names, datasets, calls) : true
  if (v === null || typeof v !== 'object') return true
  if (depth > 8) return false
  if (Array.isArray(v)) {
    for (const x of v) if (!walkParam(x, names, datasets, calls, false, depth + 1)) return false
    return true
  }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  // `{signal: <expression>}` is a signal reference (the engine resolves it before the step runs: see resolveSignalParams)
  if (keys.length === 1 && keys[0] === 'signal' && typeof o.signal === 'string') return readExpression(o.signal, names, datasets, calls)
  for (const k of keys) if (!walkParam(o[k], names, datasets, calls, k === 'expr', depth + 1)) return false
  return true
}

function readExpression(code: string, names: Set<string>, datasets: Set<string>, calls: Calls): boolean {
  let tree: Expr
  try { tree = parseExpressionCached(code) } catch { return false }
  return readTree(tree, names, datasets, calls)
}

/** The node types known to compute from their children alone; any other type (a new or forgotten shape) keeps the step out. */
const PURE_NODES = new Set(['Literal', 'Identifier', 'MemberExpression', 'CallExpression', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'ArrayExpression', 'ObjectExpression', 'Property'])

/**
 * Every identifier of the tree, found by walking ALL the child nodes of a node whatever its type (not the branches a type is known to
 * have), so that a read in any position is seen. The only names that are not reads are a property key (`a.b`, `{b: 1}`) and a called
 * function, which must be a pure or drawing one, or a dataset function whose first argument is a string (the dataset it reads goes to
 * `datasets`). `false`: the tree holds a node of a type not known to be pure, `event`/`item`, or a dataset read by a computed name.
 */
function readTree(e: unknown, names: Set<string>, datasets: Set<string>, calls: Calls): boolean {
  if (e === null || e === undefined) return true
  if (Array.isArray(e)) return e.every((x) => readTree(x, names, datasets, calls))
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
      return readTree(node.object, names, datasets, calls) && (node.computed !== true || readTree(node.property, names, datasets, calls))
    case 'Property': return readTree(node.value, names, datasets, calls)
    case 'CallExpression': {
      const f = node.callee as { type?: string; name?: string }
      if (f?.type !== 'Identifier') return false
      if (DATASET_FUNCTIONS.has(f.name!)) {
        const first = (node.arguments as unknown[] | undefined)?.[0] as { type?: string; value?: unknown } | undefined
        if (first?.type !== 'Literal' || typeof first.value !== 'string') return false
        datasets.add(first.value)
      } else if (DRAWING_FUNCTIONS.has(f.name!)) {
        calls.draws = true
      } else if (!PURE_FUNCTIONS.has(f.name!)) return false
      return readTree(node.arguments, names, datasets, calls)
    }
    default:
      // every other child of the node, whatever it is called
      for (const k of Object.keys(node)) if (k !== 'type' && !readTree(node[k], names, datasets, calls)) return false
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
    const f = reads !== null && !reads.draws && reads.publishes === undefined && reads.datasets.length === 0 ? footprintOf(t) : null
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
 * (no draw, no signal written, no dataset read, no row numbering); `null` otherwise.
 */
export function pipelineReadsOf(transforms: readonly CompiledTransform[]): readonly string[] | null {
  let names = PIPELINES.get(transforms)
  if (names === undefined) {
    const all = new Set<string>()
    names = transforms.every((t) => {
      const reads = stepReadsOf(t)
      if (reads === null || reads.draws || reads.publishes !== undefined || reads.datasets.length > 0 || t.type === 'identifier') return false
      for (const n of reads.signals) all.add(n)
      return true
    }) ? [...all].sort() : null
    PIPELINES.set(transforms, names)
  }
  return names
}

// ---------------------------------------------------------------------------
// The names and the dataset reads of a definition's strings, as the expression lexer reads them
// ---------------------------------------------------------------------------


const ASCII_NAME = /[A-Za-z_$][\w$]*/g
/** A run of the characters a name is made of, past ASCII too (a superset of the names in the text: digits may lead). */
const NAME_RUN = new RegExp(`[\\p{ID_Continue}$${String.fromCharCode(0x200c, 0x200d)}]+`, 'gu')

/**
 * Every name `str` mentions, read as an expression or not: the ASCII names as written, and for a string with escapes or characters
 * past ASCII, the names of its lexed text (see {@link lexedText}) and, when it is an expression, the identifiers of its tree (the
 * names the lexer itself makes, in whatever script). A superset of the names an expression in it reads.
 */
export function namesIn(str: string, into: Set<string>): void {
  for (const m of str.matchAll(ASCII_NAME)) into.add(m[0])
  if (lexedAsWritten(str)) return
  for (const m of lexedText(str).matchAll(NAME_RUN)) into.add(m[0])
  let tree: Expr
  try { tree = parseExpressionCached(str) } catch { return }
  eachNode(tree, (node) => { if (node.type === 'Identifier' && typeof node.name === 'string') into.add(node.name) })
}

/** Visit every node of an expression tree, whatever the field a child is in (with a stack of its own: a long `a + b + ...` is deep). */
function eachNode(tree: unknown, visit: (node: { type: string } & Record<string, unknown>) => void): void {
  const stack: unknown[] = [tree]
  while (stack.length) {
    const e = stack.pop()
    if (e === null || typeof e !== 'object') continue
    if (Array.isArray(e)) { for (const x of e) stack.push(x); continue }
    const node = e as { type?: unknown } & Record<string, unknown>
    if (typeof node.type === 'string') visit(node as { type: string } & Record<string, unknown>)
    for (const k of Object.keys(node)) if (k !== 'type') stack.push(node[k])
  }
}

/** Expression functions that read a dataset's hierarchy (vega-functions' tree lookups): what they read is not keyed by its rows. */
const TREE_FUNCTIONS = new Set(['treePath', 'treeAncestors'])
/** Mentions a call that may read a dataset (see {@link DATASET_FUNCTIONS}, {@link TREE_FUNCTIONS}), in lexed text. */
const DATASET_CALL_TEXT = /\b(data|indata|vlSelectionTest|vlSelectionIdTest|vlSelectionResolve|treePath|treeAncestors)\s*\(/

/**
 * The datasets the expression `str` reads by the names it spells out (`data("store")`, `vlSelectionTest("store", datum)`): `[]` when
 * it reads none, `null` when it reads one by a computed name or a hierarchy (`treePath`), or when it mentions such a call and is no
 * expression the analysis can read (it is then taken to read every dataset).
 */
export function datasetsReadIn(str: string): readonly string[] | null {
  if (!DATASET_CALL_TEXT.test(lexedText(str))) return []
  let tree: Expr
  try { tree = parseExpressionCached(str) } catch { return null }
  const out = new Set<string>()
  let computed = false
  eachNode(tree, (node) => {
    if (node.type !== 'CallExpression') return
    const f = node.callee as { type?: string; name?: string } | undefined
    if (f?.type !== 'Identifier') { computed = true; return }
    if (TREE_FUNCTIONS.has(f.name!)) { computed = true; return }
    if (!DATASET_FUNCTIONS.has(f.name!)) return
    const first = (node.arguments as unknown[] | undefined)?.[0] as { type?: string; value?: unknown } | undefined
    if (first?.type === 'Literal' && typeof first.value === 'string') out.add(first.value)
    else computed = true
  })
  return computed ? null : [...out].sort()
}

/** Expression functions whose first argument names a scale (vega-functions' scale visitor reads it as a dependency when it is a literal). */
const SCALE_FUNCTIONS = new Set(['scale', 'invert', 'domain', 'range', 'bandwidth', 'bandspace', 'copy', 'gradient'])

/**
 * The scales the expression `str` names by a literal in a call that reads one (`scale('x', datum.v)`): the scales its operator is
 * connected to in vega. A name given otherwise is read when the call runs, with no connection, and is not listed. `[]` for text that
 * is no expression.
 */
export function scalesReadIn(str: string): string[] {
  let tree: Expr
  try { tree = parseExpressionCached(str) } catch { return [] }
  const out = new Set<string>()
  eachNode(tree, (node) => {
    if (node.type !== 'CallExpression') return
    const f = node.callee as { type?: string; name?: string } | undefined
    if (f?.type !== 'Identifier' || !SCALE_FUNCTIONS.has(f.name!)) return
    const first = (node.arguments as unknown[] | undefined)?.[0] as { type?: string; value?: unknown } | undefined
    if (first?.type === 'Literal' && typeof first.value === 'string') out.add(first.value)
  })
  return [...out]
}

const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g
/** An ASCII name that is no property of what is before it (`a.b` reads `a`). */
const FREE_NAME = /(?<![.\w$])[A-Za-z_$][\w$]*/g

/**
 * The names the expression `text` reads by themselves (signals, and the functions it calls), not the properties it reads off
 * them: for text the lexer reads as written, the ASCII names outside its string literals; otherwise those and the identifiers of
 * its tree that are no property key (an escaped name is the name it spells, a name past ASCII is whole). A superset of what the
 * expression reads by name.
 */
export function identifiersIn(text: string): string[] {
  const out: string[] = [...(text.replace(STRING_LITERAL, '""').match(FREE_NAME) ?? [])]
  if (lexedAsWritten(text)) return out
  let tree: Expr
  try { tree = parseExpressionCached(text) } catch {
    // (no expression: nothing runs it; its names as the lexer would spell them)
    return [...out, ...(lexedText(text).replace(STRING_LITERAL, '""').match(FREE_NAME) ?? []), ...[...lexedText(text).matchAll(NAME_RUN)].map((m) => m[0])]
  }
  const stack: unknown[] = [tree]
  while (stack.length) {
    const e = stack.pop()
    if (e === null || typeof e !== 'object') continue
    if (Array.isArray(e)) { for (const x of e) stack.push(x); continue }
    const node = e as { type?: unknown } & Record<string, unknown>
    if (node.type === 'Identifier' && typeof node.name === 'string') { out.push(node.name); continue }
    for (const k of Object.keys(node)) {
      if (k === 'type') continue
      // (a property read off an object, or the key of an object literal, is no name the expression reads)
      if (k === 'property' && node.type === 'MemberExpression' && node.computed !== true) continue
      if (k === 'key' && node.type === 'Property' && node.computed !== true) continue
      stack.push(node[k])
    }
  }
  return out
}
