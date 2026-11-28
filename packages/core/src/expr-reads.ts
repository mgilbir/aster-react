/**
 * What an expression reads, by name: the identifiers it names (a signal is read by its name and by nothing else), and the datasets
 * it reads by the name it spells out (`data('t')`, `indata('t', ...)`, the vega-lite selection reads), as `data:<name>`. One reading
 * for the two places that build the graph of what reads what: the compile-time walk (spec-expressions.ts, which refuses a cycle
 * as vega does) and the signal event loop (signals.ts, which orders its operators by it).
 */
import { parseExpressionCached, type AstNode } from './expr-parser.js'
import { TextTable } from './util.js'

/** The functions that read a dataset by the name in their first argument (vega-functions' dataVisitor / selectionVisitor). */
export const DATA_READERS: ReadonlySet<string> = new Set(['data', 'indata', 'vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])

/** The key under which an expression's dependence on the dataset `name` is tracked next to its signal names. */
export const dataKey = (name: string): string => `data:${name}`

const READS = new TextTable<ReadonlySet<string>>('expression reads', 2048, 2_000_000)

/**
 * Whether an encode entry (or a list of rules) holds an expression that names `item` (vega binds the scenegraph item there): its
 * `signal` and `test` texts, at any depth. One that does is evaluated per item with the item it is building.
 */
const ENTRY_READS_ITEM = new WeakMap<object, boolean>()
export function entryReadsItem(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  let known = ENTRY_READS_ITEM.get(entry)
  if (known === undefined) {
    known = false
    const visit = (v: unknown, depth: number): void => {
      if (known || v === null || typeof v !== 'object' || depth > 12) return
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'signal' || k === 'test') && typeof x === 'string') {
          try { if (expressionReads(x).has('item')) known = true } catch { /* refused when the spec was compiled */ }
        } else visit(x, depth + 1)
      }
    }
    visit(entry, 0)
    ENTRY_READS_ITEM.set(entry, known)
  }
  return known
}

/** The selection functions vega-selections' `selectionVisitor` reads (it indexes a data set by unit when the last argument is `'intersect'`). */
const SELECTION_FUNCTIONS: ReadonlySet<string> = new Set(['vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])

/**
 * The data sets an expression has vega index by `unit`: a selection function called on a data set named literally whose last
 * argument is the literal `'intersect'` (vega-selections `selectionVisitor`). An index, once made, serves every call on that data
 * set; a data set never so named has none, and its `intersect` tests then require every tuple to match.
 */
export function unitIndexedIn(code: string): string[] {
  const out: string[] = []
  const visit = (n: unknown): void => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(visit); return }
    const node = n as AstNode
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode | undefined
      const args = node.arguments as AstNode[]
      const last = args[args.length - 1]
      if (callee?.type === 'Identifier' && SELECTION_FUNCTIONS.has(callee.name as string) && args[0]?.type === 'Literal' && typeof args[0].value === 'string'
        && args.length >= 2 && last?.type === 'Literal' && last.value === 'intersect') out.push(args[0].value)
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(parseExpressionCached(code))
  return out
}

/**
 * The data sets an expression tests with `vlSelectionTest` on a name it spells out. Testing is what rewrites a Date of a stored tuple
 * to a number, in the tuple itself (vega-selections `selectionTest`), so these are the stores whose tuples vega holds as numbers once a
 * dataset's filter has run.
 */
export function testedStoresIn(code: string): string[] {
  const out: string[] = []
  const visit = (n: unknown): void => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(visit); return }
    const node = n as AstNode
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode | undefined
      const args = node.arguments as AstNode[]
      if (callee?.type === 'Identifier' && callee.name === 'vlSelectionTest' && args[0]?.type === 'Literal' && typeof args[0].value === 'string') out.push(args[0].value)
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(parseExpressionCached(code))
  return out
}

/**
 * Whether an expression calls `data`, as the evaluator resolves the callee (the parsed tree, not the text: `(data)('t')`,
 * `data ('t')`, `\u0064ata('t')` and the encoders' spelling `_data('t')` all call it). Only a bare name is callable, so only a call of
 * a name is looked at. `data` is the one function that hands out an array the engine advances in place (a dataset's rows, a named
 * mark's items; `treePath` and `treeAncestors` answer fresh arrays of rows, `indata` and the selection functions answer derived
 * values). Not cached here: the runtime decides once per expression text. Text the parser refuses answers `true` (it is refused where it is compiled; what is unknown is taken to call it).
 */
export function callsData(code: string): boolean {
  let found = false
  const visit = (n: unknown): void => {
    if (found || n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(visit); return }
    const node = n as AstNode
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode | undefined
      // (`_name` is the encoders' spelling of `name`, as the evaluator reads it)
      if (callee?.type === 'Identifier') {
        const name = callee.name as string
        if ((name.startsWith('_') ? name.slice(1) : name) === 'data') { found = true; return }
      }
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  try { visit(parseExpressionCached(code)) } catch { return true }
  return found
}

/** The identifiers an expression reads (signal references among them), and `data:NAME` for every dataset it reads by name. */
export function expressionReads(code: string): ReadonlySet<string> {
  let have = READS.get(code)
  if (have === undefined) READS.set(code, (have = parseReads(code)))
  return have
}

function parseReads(code: string): Set<string> {
  const out = new Set<string>()
  const visit = (n: unknown): void => {
    if (n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(visit); return }
    const node = n as AstNode
    switch (node.type) {
      case 'Identifier': out.add(node.name as string); return
      case 'MemberExpression':
        visit(node.object)
        if (node.computed) visit(node.property)
        return
      case 'CallExpression': {
        const callee = node.callee as AstNode | undefined
        const first = (node.arguments as AstNode[])[0]
        if (callee?.type === 'Identifier' && DATA_READERS.has(callee.name as string) && first?.type === 'Literal' && typeof first.value === 'string') {
          out.add(dataKey(first.value))
        }
        visit(node.arguments)
        return
      }
      case 'Property': visit(node.value); return
      default:
        for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
    }
  }
  visit(parseExpressionCached(code))
  return out
}
