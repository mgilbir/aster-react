/**
 * The names the expressions of a compiled Vega spec read, checked against the signals the spec declares.
 *
 * Vega fails to run a spec whose expression reads a name nothing declares ("Unrecognized signal name"), long after the compile that made
 * it; vega-lite compiles it without a word. An expression of the user's own (a filter, a calculate, a condition's `test`, a `{expr}`
 * reference) that names a parameter that does not exist is a mistake the compile can say so about, so it does, naming the expression.
 */
import { nextSolid, prevSolid, tokenize } from './expr-tokens.js'
import { VLCompileError } from './names.js'
import { isRows } from './rows.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** What a Vega expression may name without a signal: the root signals every view has, the datum / event / item / parent a scope gives (a group's title reads its parent), and vega's constants. */
const GLOBAL_NAMES: ReadonlySet<string> = new Set([
  'width', 'height', 'padding', 'autosize', 'background', 'datum', 'event', 'item', 'parent',
  'NaN', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2', 'MIN_VALUE', 'MAX_VALUE',
  // (the keywords the expression grammar reads as literals)
  'null', 'true', 'false',
])

/** Expressions that name nothing but globals (so they are fine whatever the spec declares): kept, bounded, so a text is read once. */
const GLOBAL_ONLY = new Set<string>()
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
const NAME = /[A-Za-z_$][\w$]*/g

/**
 * The same, for the common expression: no `/` (a division or a regular expression), no escape, nothing outside ASCII once its strings are
 * gone. Its names are found in the text itself, without the tokens; `undefined` where the text is not so plain (readNames reads it).
 */
function readPlainNames(expr: string): string[] | undefined {
  if (expr.includes('\\') || expr.includes('/')) return undefined
  const text = expr.includes('"') || expr.includes("'") ? expr.replace(STRING_LITERAL, '""') : expr
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(text) || text.includes('"') || text.includes("'")) return undefined
  const names: string[] = []
  NAME.lastIndex = 0
  for (let m = NAME.exec(text); m !== null; m = NAME.exec(text)) {
    const at = m.index
    // (the name is not the tail of a number such as `1e3`, nor of a longer name)
    const prev = at > 0 ? text.charCodeAt(at - 1) : 32
    if ((prev >= 48 && prev <= 57) || prev === 46) continue
    let b = at - 1
    while (b >= 0 && text.charCodeAt(b) <= 32) b--
    let a = at + m[0].length
    while (a < text.length && text.charCodeAt(a) <= 32) a++
    const before = b >= 0 ? text[b] : ''
    const after = a < text.length ? text[a] : ''
    if (before === '.' || after === '(' || (after === ':' && (before === '{' || before === ','))) continue
    if (after === ')' && before === '(') {
      let c = a + 1
      while (c < text.length && text.charCodeAt(c) <= 32) c++
      if (text[c] === '(') continue
    }
    names.push(m[0])
  }
  return names
}

/** The names an expression reads as signals: not a property (`a.b`), not called (`f(x)`), not an object key (`{k: 1}`), not in a string. */
function readNames(expr: string): string[] {
  const plain = readPlainNames(expr)
  if (plain !== undefined) return plain
  const names: string[] = []
  const tokens = tokenize(expr)
  // (text with a stray backslash is no expression vega can read: it says so itself, when it parses it)
  if (tokens.some((t) => t.kind === 'punct' && t.raw === '\\')) return names
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'name') continue
    const before = tokens[prevSolid(tokens, i)]?.raw
    const after = tokens[nextSolid(tokens, i)]?.raw
    if (before === '.' || after === '(' || (after === ':' && (before === '{' || before === ','))) continue
    // (a parenthesised callee, `(test)(x)`)
    if (after === ')' && tokens[nextSolid(tokens, nextSolid(tokens, i))]?.raw === '(' && before === '(') continue
    names.push(t.value!)
  }
  return names
}

/** Every signal the spec declares: in a `signals` list of any scope, or as the `signal` a data transform (bin, extent, geojson...) publishes. */
function declaredSignals(node: unknown, into: Set<string>, inTransform = false): void {
  if (Array.isArray(node)) {
    for (const x of node) declaredSignals(x, into, inTransform)
    return
  }
  if (!isObj(node)) return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'signals' && Array.isArray(v)) for (const s of v) if (isObj(s) && typeof s.name === 'string') into.add(s.name)
    if (k === 'signal' && inTransform && typeof v === 'string') into.add(v)
    if (v !== null && typeof v === 'object' && !isRows(v)) declaredSignals(v, into, k === 'transform')
  }
}

/** Throws a VLCompileError for the first expression of `out` that reads a name no signal of `out` declares. */
export function refuseUndeclaredNames(out: Obj): void {
  // (the signals are collected the first time an expression reads a name that is not a global one: most specs have none to look for)
  let declared: Set<string> | undefined
  const check = (expr: string, where: string): void => {
    if (GLOBAL_ONLY.has(expr)) return
    let globalOnly = true
    for (const name of readNames(expr)) {
      if (GLOBAL_NAMES.has(name)) continue
      globalOnly = false
      if (declared === undefined) declaredSignals(out, (declared = new Set<string>()))
      if (declared.has(name)) continue
      throw new VLCompileError(`${where}: the expression ${JSON.stringify(expr)} reads "${name}", which no parameter or signal declares (declare it in \`params\`)`)
    }
    // (the same text turns up again - in every dataset a filter is repeated in, and in the next compile of a spec being edited)
    if (globalOnly) {
      if (GLOBAL_ONLY.size >= 4096) GLOBAL_ONLY.clear()
      GLOBAL_ONLY.add(expr)
    }
  }
  const walk = (node: unknown, path: string, inTransform: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`, inTransform))
      return
    }
    if (!isObj(node)) return
    for (const [k, v] of Object.entries(node)) {
      const at = path === '' ? k : `${path}.${k}`
      if (typeof v === 'string') {
        // (the `signal` of a data transform names the signal it publishes; an `expr` is a filter's or a formula's)
        if ((k === 'signal' && !inTransform) || k === 'expr' || k === 'test' || k === 'update' || k === 'init') check(v, at)
      } else if (k === 'filter' && Array.isArray(v) && typeof node.type === 'string') {
        // (the filters of an event stream)
        for (const f of v) if (typeof f === 'string') check(f, at)
      } else if (k === 'value' || k === 'default' || k === 'keyvals') {
        // (a literal: `{expr: ...}` here is data a transform or a signal holds, as vega-lite writes it)
      } else if (v !== null && typeof v === 'object' && !isRows(v)) walk(v, at, k === 'transform')
    }
  }
  walk(out, '', false)
}
