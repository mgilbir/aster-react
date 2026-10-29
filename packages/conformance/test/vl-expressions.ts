/**
 * The expressions of a compiled Vega spec, in a form two compilers' outputs can be compared in.
 *
 * Every string that Vega evaluates as an expression (a filter / formula `expr`, a signal's `init` / `update`, a `signal` reference
 * in a scale, a mark's or a guide's encode, a `test`, an axis `labelExpr`) is parsed with vega-expression and printed back
 * fully parenthesised, so what is compared is the expression and not its spelling:
 *
 *  - quotes (`datum['v']` / `datum["v"]`), whitespace and redundant parentheses do not matter;
 *  - `datum.v` and `datum["v"]` are the same field read.
 *
 * Aster keeps a generated field or signal name safe for Vega's access-path grammar (names.ts `safeKey`): an unusual name (a nested path
 * `o.v`, a name with brackets or quotes) is sanitised and followed by `_` + 6 hex digits of a hash, where vega-lite writes the name as it
 * is. So, in a field read `datum[...]`, both sides' names are reduced to their word characters (Aster's hash first removed from OUR
 * side only) before they are compared. Nothing else is normalised: operators, operands, their order and every constant are compared as
 * they are, so a changed constant or fence in a generated expression is a difference.
 */
import { parseExpression } from 'vega-expression'

export type Side = 'vega-lite' | 'aster'

/** The keys of a compiled Vega spec whose string value is an expression (or an event selector, for `events`). */
const EXPR_KEYS = new Set(['expr', 'signal', 'init', 'update', 'test', 'events', 'labelExpr'])
/** `toNumber(datum["f"])` written onto `f` itself: vega-lite's `format.parse` of the source, which Aster writes as a formula. */
const CAST = /^(toNumber|toDate|toString)\(datum\[("(?:[^"\\]|\\.)*")\]\)$/

/** `datum["k"]`: a formula that only copies one field into another name (Aster's flat key of an unusual field name). */
const COPY = /^datum\[("(?:[^"\\]|\\.)*")\]$/

const HASH = /_[0-9a-f]{6}(?![0-9A-Za-z])/g

function canonicalName(name: string, side: Side): string {
  const n = side === 'aster' ? name.replace(HASH, '') : name
  return n.replace(/\\/g, '').replace(/[^\w ]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

function print(node: any, side: Side): string {
  switch (node.type) {
    case 'Literal':
      return node.regex ? String(node.raw) : JSON.stringify(node.value)
    case 'Identifier': {
      const name = side === 'aster' ? node.name.replace(HASH, '') : node.name
      return aliases.get(name) ?? name
    }
    case 'MemberExpression': {
      const key = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : node.property.name
      if (node.object.type === 'Identifier' && node.object.name === 'datum' && typeof key === 'string') return `datum[${JSON.stringify(canonicalName(key, side))}]`
      return node.computed ? `${print(node.object, side)}[${print(node.property, side)}]` : `${print(node.object, side)}.${side === 'aster' ? node.property.name.replace(HASH, '') : node.property.name}`
    }
    case 'CallExpression':
      return `${print(node.callee, side)}(${node.arguments.map((a: any) => print(a, side)).join(', ')})`
    case 'UnaryExpression':
      return `(${node.operator}${print(node.argument, side)})`
    case 'BinaryExpression':
    case 'LogicalExpression':
      return `(${print(node.left, side)} ${node.operator} ${print(node.right, side)})`
    case 'ConditionalExpression':
      return `(${print(node.test, side)} ? ${print(node.consequent, side)} : ${print(node.alternate, side)})`
    case 'ArrayExpression':
      return `[${node.elements.map((e: any) => print(e, side)).join(', ')}]`
    case 'ObjectExpression':
      return `{${node.properties.map((p: any) => `${p.key.type === 'Identifier' ? p.key.name : JSON.stringify(p.key.value)}: ${print(p.value, side)}`).join(', ')}}`
    default:
      throw new Error(`unhandled expression node ${node.type}`)
  }
}

/**
 * Signals that only restate another one (`{name: "height", update: "child_height"}`: a facet's cell re-declares its size under the
 * name the marks inside use). Reading either is the same read, so both are compared as the signal they restate.
 */
let aliases: ReadonlyMap<string, string> = new Map()
function aliasesOf(vg: unknown, side: Side): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.name === 'string' && typeof o.update === 'string' && o.on === undefined && /^[A-Za-z_]\w*$/.test(o.update)) {
      found.set(side === 'aster' ? o.name.replace(HASH, '') : o.name, side === 'aster' ? o.update.replace(HASH, '') : o.update)
    }
    for (const x of Object.values(o)) walk(x)
  }
  walk(vg)
  return found
}

/** One expression string, canonicalised. A string that is not an expression (an event selector) is returned with its whitespace collapsed. */
export function canonicalExpression(src: string, side: Side): string {
  try {
    let ast: any = parseExpression(src)
    // `toNumber(datum["o"] && datum["o"]["v"])`: the cast of a nested field is its parse (vega-lite's `format.parse`, Aster's formula
    // casts), the guarded read is what is compared
    if (ast.type === 'CallExpression' && ast.callee.type === 'Identifier' && ['toNumber', 'toDate', 'toString'].includes(ast.callee.name) && ast.arguments.length === 1 && ast.arguments[0].type === 'LogicalExpression') ast = ast.arguments[0]
    return print(ast, side)
  } catch {
    return src.replace(/\s+/g, ' ').trim()
  }
}

/**
 * Aster copies a nested field into a flat key with one formula (`datum["o"] && datum["o"]["v"]` as `o_v_ab12cd`) and casts the copy in
 * place with the next (`toNumber(datum["o_v_ab12cd"])` as the same key); vega-lite writes the two as one, `toNumber(datum["o"] &&
 * datum["o"]["v"])` as `o.v`. A flat copy that is cast in place later in the same pipeline is read as the cast of its expression.
 */
function foldCasts(transforms: unknown[]): { fold: Map<object, string>; skip: Set<object> } {
  const fold = new Map<object, string>()
  const skip = new Set<object>()
  const isFormula = (t: unknown): t is { type: string; expr: string; as: string } =>
    t !== null && typeof t === 'object' && (t as { type?: unknown }).type === 'formula' && typeof (t as { expr?: unknown }).expr === 'string' && typeof (t as { as?: unknown }).as === 'string'
  transforms.forEach((t, i) => {
    if (!isFormula(t) || CAST.test(t.expr)) return
    const copied = COPY.exec(t.expr)
    if (copied && canonicalName(JSON.parse(copied[1]!), 'aster') === canonicalName(t.as, 'aster')) {
      // (a copy under the sanitised name of the same field is a rename; a cast of the copy is vega-lite's cast of the field itself)
      skip.add(t)
    }
    for (let j = i + 1; j < transforms.length; j++) {
      const c = transforms[j]
      if (!isFormula(c)) continue
      const m = CAST.exec(c.expr)
      if (m && JSON.parse(m[2]!) === t.as && c.as === t.as) {
        fold.set(t, t.expr)
        skip.add(c)
        break
      }
    }
  })
  return { fold, skip }
}

/** The distinct canonical expressions of a compiled Vega spec, sorted. */
export function expressionsOf(vg: unknown, side: Side): string[] {
  aliases = aliasesOf(vg, side)
  const out = new Set<string>()
  let folded = { fold: new Map<object, string>(), skip: new Set<object>() }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      const f = foldCasts(v)
      for (const [k, x] of f.fold) folded.fold.set(k, x)
      for (const x of f.skip) folded.skip.add(x)
      for (const x of v) walk(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    for (const [k, x] of Object.entries(obj)) {
      if (EXPR_KEYS.has(k) && typeof x === 'string') {
        if (folded.skip.has(obj)) continue
        const cast = k === 'expr' && typeof obj.as === 'string' ? CAST.exec(x) : null
        if (cast && JSON.parse(cast[2]!) === obj.as) continue
        out.add(canonicalExpression(k === 'expr' ? (folded.fold.get(obj) ?? x) : x, side))
      } else walk(x)
    }
  }
  walk(vg)
  return [...out].sort()
}

/** What differs between the expressions of Aster's output and vega-lite's, one line each; an empty string when they are the same. */
export function expressionDiff(ours: unknown, oracle: unknown): string {
  const a = expressionsOf(ours, 'aster')
  const o = expressionsOf(oracle, 'vega-lite')
  const inA = new Set(a)
  const inO = new Set(o)
  return [...o.filter((x) => !inA.has(x)).map((x) => `only vega-lite: ${x}`), ...a.filter((x) => !inO.has(x)).map((x) => `only aster:     ${x}`)].join('\n')
}
