/**
 * What vega's parser refuses in one expression, once it has read it. A spec is refused as a whole, before anything runs, with a
 * message that is part of the contract (a user reads it), in this order:
 *
 * 1. text that is no expression: `Expression parse error: <the text>`;
 * 2. a call whose arguments name data or a scale and do not give a literal, in the order of the tree (pre-order);
 * 3. the first thing in the tree, read as the code generator reads it, that cannot be used: an unknown function
 *    (`Unrecognized function: foo`), a call of something that is not a name, an identifier `_`, an object literal with a key
 *    that is an `Object.prototype` member, a call with too few arguments. Which arguments of a call are read at all differs by
 *    function, and an unread one is never refused;
 * 4. the free names of the expression, in the order they were read: a name that is no signal of the scope is
 *    `Unrecognized signal name: "x"`.
 *
 * What is fixed by the observable behaviour: all of the above, and the text of every message. The functions that need a first
 * argument and are called without one fail in vega with a message of the JavaScript engine (`Cannot read properties of undefined
 * (reading 'type')`); that text is the one given here too.
 *
 * Not checked: that a data set named by `indata` or a selection function exists (the structural check of the spec reads those), and
 * that a scale a call names exists (vega leaves that to the call).
 */
import { SpecParseError } from './parse-error.js'
import { parseExpressionCached, type Expr } from './expr-parser.js'
import { expressionRegistryEpoch, isExpressionFunction } from './expression.js'
import { ExpressionConstants } from './expr-interpreter.js'
import { DisallowedObjectProperties } from './util.js'
import { stringValue } from './spec-structure.js'

type Call = Extract<Expr, { type: 'CallExpression' }>

/** The names an expression reads freely: `datum`, `event` and `item` are the evaluator's own. */
const EVALUATOR_NAMES: ReadonlySet<string> = new Set(['datum', 'event', 'item'])

/** Calls whose first argument names a data set or a scale and must be written out (the parser reads the name before running). */
const DATA_CALLS: ReadonlySet<string> = new Set(['data', 'treePath', 'treeAncestors'])
const SELECTION_CALLS: ReadonlySet<string> = new Set(['vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])
const SCALE_CALLS: ReadonlySet<string> = new Set([
  'bandwidth', 'copy', 'domain', 'range', 'invert', 'scale', 'gradient', 'geoArea', 'geoBounds', 'geoCentroid', 'geoShape', 'geoScale',
  '_bandwidth', '_range', '_scale',
])

/**
 * Calls of which only the first argument is read: the date parts, the length, the case and trim of a string, and the two internal
 * scale calls that take a name alone. The others are read whole, in order.
 */
const FIRST_ARGUMENT_ONLY: ReadonlySet<string> = new Set([
  'date', 'day', 'year', 'month', 'hours', 'minutes', 'seconds', 'milliseconds', 'time', 'timezoneoffset',
  'utcdate', 'utcday', 'utcyear', 'utcmonth', 'utchours', 'utcminutes', 'utcseconds', 'utcmilliseconds',
  'length', 'upper', 'lower', 'trim', '_bandwidth', '_range',
])
/** Calls that read their first argument, then the rest. */
const FIRST_ARGUMENT_THEN_REST: ReadonlySet<string> = new Set(['substring', 'split', 'test', '_scale'])
/** Calls that take exactly three arguments. */
const THREE_ARGUMENTS: ReadonlySet<string> = new Set(['clamp', 'if'])

const NO_ARGUMENT = "Cannot read properties of undefined (reading 'type')"

/** What an expression is refused for, whatever scope it is read in: the message, and whether vega's own message is one of the engine's. */
interface Refusal {
  readonly message: string
  readonly engine: boolean
}
const spec = (message: string): Refusal => ({ message, engine: false })
const engine = (message: string): Refusal => ({ message, engine: true })

/** The calls that name data or a scale in their arguments: what vega's parser refuses before it writes any code. */
function checkCall(name: string, args: readonly Expr[]): Refusal | null {
  const [first, second] = args
  if (DATA_CALLS.has(name)) {
    if (!first) return engine(NO_ARGUMENT)
    if (first.type !== 'Literal') return spec('First argument to data functions must be a string literal.')
  } else if (name === 'indata') {
    if (!first) return engine(NO_ARGUMENT)
    if (first.type !== 'Literal') return spec('First argument to indata must be a string literal.')
    if (!second) return engine(NO_ARGUMENT)
    if (second.type !== 'Literal') return spec('Second argument to indata must be a string literal.')
  } else if (SELECTION_CALLS.has(name)) {
    if (!first) return engine(NO_ARGUMENT)
    if (first.type !== 'Literal') return spec('First argument to selection functions must be a string literal.')
  } else if (SCALE_CALLS.has(name) && !first) {
    return engine(NO_ARGUMENT)
  }
  return null
}

/**
 * Reads an expression the way vega's parser does -- the calls of the whole tree first, then the code generator, which reads some
 * subtrees and not others -- in one walk: a refusal of the calls ends it, one of the code generator is kept while the rest of the
 * tree is still looked at for a refusal of the calls (which comes first, wherever it lies).
 */
class Reader {
  readonly names: string[] = []
  /** the first thing the code generator cannot use, in the order it reads */
  codegen: Refusal | null = null

  /** Walk `node`; `read` is whether the code generator reads it. A refusal of the calls is returned. */
  walk(node: Expr | null, read: boolean): Refusal | null {
    if (node === null) return engine("Cannot read properties of null (reading 'visit')")
    const live = read && this.codegen === null
    switch (node.type) {
      case 'Literal': return null
      case 'Identifier': {
        if (!live) return null
        const name = node.name
        if (name === '_') this.codegen = spec('Illegal identifier: _')
        else if (!this.names.includes(name) && !EVALUATOR_NAMES.has(name) && !Object.hasOwn(ExpressionConstants, name)) this.names.push(name)
        return null
      }
      case 'MemberExpression': return this.walk(node.object, read) ?? this.walk(node.property, read && node.computed)
      case 'CallExpression': return this.call(node, live)
      case 'UnaryExpression': return this.walk(node.argument, read)
      case 'BinaryExpression': case 'LogicalExpression': return this.walk(node.left, read) ?? this.walk(node.right, read)
      case 'ConditionalExpression': return this.walk(node.test, read) ?? this.walk(node.consequent, read) ?? this.walk(node.alternate, read)
      case 'ArrayExpression':
        for (const e of node.elements) {
          const refused = this.walk(e, read)
          if (refused) return refused
        }
        return null
      case 'ObjectExpression': {
        // (every key is looked at before any value is read; only a key written as a name can be one the evaluator refuses)
        if (live) for (const p of node.properties) if (p.key.type === 'Identifier' && DisallowedObjectProperties.has(p.key.name)) { this.codegen = spec('Illegal property: ' + p.key.name); break }
        for (const p of node.properties) {
          const refused = this.walk(p.value, read)
          if (refused) return refused
        }
        return null
      }
    }
  }

  private call(node: Call, live: boolean): Refusal | null {
    const args = node.arguments
    const callee = node.callee
    const name = callee.type === 'Identifier' ? callee.name : ''
    if (callee.type === 'Identifier') {
      const refused = checkCall(name, args)
      if (refused) return refused
    } else {
      // (not a name: the code generator refuses it, but the calls inside it are still looked at)
      const refused = this.walk(callee, false)
      if (refused) return refused
    }
    // which arguments the code generator reads: the first only, the first and then the rest, or all
    let to = args.length
    if (live) {
      if (callee.type !== 'Identifier') this.codegen = spec('Illegal callee type: ' + callee.type)
      else if (!isExpressionFunction(name)) this.codegen = spec('Unrecognized function: ' + name)
      else if (THREE_ARGUMENTS.has(name) && args.length !== 3) this.codegen = spec(`${args.length < 3 ? 'Missing' : 'Too many'} arguments to ${name} function.`)
      else if (FIRST_ARGUMENT_ONLY.has(name) || FIRST_ARGUMENT_THEN_REST.has(name)) {
        if (!args[0] || (name === '_scale' && !args[1])) this.codegen = engine(NO_ARGUMENT)
        else if (FIRST_ARGUMENT_ONLY.has(name)) to = 1
      }
    }
    for (let i = 0; i < args.length; i++) {
      const refused = this.walk(args[i]!, i < to)
      if (refused) return refused
    }
    return null
  }
}

interface Verdict {
  readonly refusal: Refusal | null
  readonly names: readonly string[]
  /** the registry of expression functions this was read under */
  readonly registry: number
}

/**
 * What was found about each text lately, across specs: the same expression turns up in chart after chart (and in the same chart
 * compiled again), and is neither parsed nor walked a second time. Two generations bound it: a text read in the young one is
 * found there; one found in the old one moves up; when the young one is full it becomes the old one and the old one goes.
 */
const GENERATION = 4096
let young = new Map<string, Verdict>()
let old = new Map<string, Verdict>()
const NO_NAMES: readonly string[] = []

function verdictOf(text: string): Verdict {
  const registry = expressionRegistryEpoch()
  let verdict = young.get(text)
  if (verdict === undefined && (verdict = old.get(text)) !== undefined) young.set(text, verdict)
  if (verdict !== undefined && verdict.registry === registry) return verdict
  let tree: Expr
  try {
    tree = parseExpressionCached(text)
  } catch (cause) {
    // (a limit is the engine's refusal, not a syntax error: it keeps its type, wherever the text is first read)
    if (cause instanceof Error && cause.name === 'AsterLimitError') throw cause
    throw new SpecParseError('Expression parse error: ' + text, { cause })
  }
  const reader = new Reader()
  const refusal = reader.walk(tree, true) ?? reader.codegen
  verdict = { refusal, names: refusal ? NO_NAMES : reader.names, registry }
  if (young.size >= GENERATION) { old = young; young = new Map() }
  young.set(text, verdict)
  return verdict
}

/**
 * Refuse `text` as vega's parser does, or return. `isSignal` says whether a name is a signal of the scope the expression is read
 * in. An engine limit (an expression too deep) keeps its own error type.
 */
export function checkExpression(text: string, isSignal: (name: string) => boolean): void {
  const { refusal, names } = verdictOf(text)
  if (refusal) throw refusal.engine ? new TypeError(refusal.message) : new SpecParseError(refusal.message)
  for (const name of names) if (!isSignal(name)) throw new SpecParseError('Unrecognized signal name: ' + stringValue(name))
}
