/**
 * Embedding a compiled child view into a composite (concat/repeat) as a group:
 * every child-local name (scales, signals, datasets) is renamed so siblings
 * cannot collide, including the names that appear INSIDE Vega expression
 * strings (`scale("x", ...)`, `bandwidth('x')`, `ceil(width/40)`). Expressions
 * are scanned token by token so a field called "width" inside a string literal
 * is never rewritten.
 */

import { nextSolid, prevSolid, tokenize } from './expr-tokens.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Vega expression functions whose FIRST argument is a scale name. */
const SCALE_FUNCTIONS = new Set(['scale', 'invert', 'domain', 'range', 'bandwidth', 'bandspace', 'copy', 'gradient', 'scaleGradient'])

/** Vega expression functions whose FIRST argument is a dataset name. */
const DATA_FUNCTIONS = new Set(['data', 'indata'])

export interface Renames {
  signals: ReadonlyMap<string, string>
  scales: ReadonlyMap<string, string>
  /** dataset renames applied to `data('name')` arguments (optional) */
  datasets?: ReadonlyMap<string, string>
}

/**
 * Rewrite signal identifiers and scale-name arguments in one expression string, read token by token as vega's lexer reads it (see
 * expr-tokens.ts): a name is the name it spells (escapes decoded), and a dataset or scale a call names is the value of its string
 * literal. What is not renamed is given back as it was written.
 */
export function renameExpr(expr: string, r: Renames): string {
  const tokens = tokenize(expr)
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'string') {
      // (the first argument of a call that reads a scale or a dataset by name)
      const open = prevSolid(tokens, i)
      const fn = open >= 0 && tokens[open]!.raw === '(' ? tokens[prevSolid(tokens, open)] : undefined
      const callee = fn?.kind === 'name' ? fn.value! : undefined
      const to = callee !== undefined && SCALE_FUNCTIONS.has(callee) ? r.scales.get(t.value!)
        : callee !== undefined && DATA_FUNCTIONS.has(callee) ? r.datasets?.get(t.value!) : undefined
      out += to !== undefined ? `${t.raw[0]}${to}${t.raw[0]}` : t.raw
      continue
    }
    if (t.kind === 'name') {
      // a member access (`.width`), a call target (`width(`) or an object key (`{width: 1}`) is not a signal reference
      const before = tokens[prevSolid(tokens, i)]?.raw
      const after = tokens[nextSolid(tokens, i)]?.raw
      const isMember = before === '.'
      const isCall = after === '('
      const isKey = after === ':' && (before === '{' || before === ',')
      const to = !isMember && !isCall && !isKey ? r.signals.get(t.value!) : undefined
      out += to ?? t.raw
      continue
    }
    out += t.raw
  }
  return out
}

/**
 * Apply renames throughout a compiled Vega fragment (in place): `signal`
 * expressions, signal definitions, `scale`/`gridScale` references and legend
 * scale properties. `{field: {group: 'width'}}` reads the enclosing group and is
 * deliberately untouched.
 */
export function renameFragment(node: unknown, r: Renames): void {
  if (Array.isArray(node)) {
    for (const x of node) renameFragment(x, r)
    return
  }
  if (!isObj(node)) return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'signal' && typeof v === 'string') {
      node[k] = renameExpr(v, r)
    } else if ((k === 'update' || k === 'init') && typeof v === 'string' && (typeof node.name === 'string' || node.events !== undefined)) {
      // a signal definition's expression, or the update of one of its `on` handlers
      node[k] = renameExpr(v, r)
    } else if ((k === 'scale' || k === 'gridScale') && typeof v === 'string') {
      node[k] = r.scales.get(v) ?? v
    } else if (k === 'field' && isObj(v) && typeof v.group === 'string') {
      // group-relative reference: leave alone
    } else if (LEGEND_SCALE_PROPS.has(k) && typeof v === 'string' && r.scales.has(v)) {
      node[k] = r.scales.get(v)!
    } else if (v !== null && typeof v === 'object') {
      renameFragment(v, r)
    }
  }
}

/** Legend properties that name the scale the legend describes. */
const LEGEND_SCALE_PROPS = new Set(['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeWidth', 'strokeDash', 'fillOpacity', 'strokeOpacity', 'angle'])

/** Rename dataset references (`from.data`, scale-domain `data`, facet `data`) in place. */
export function renameDataRefs(node: unknown, map: ReadonlyMap<string, string>): void {
  if (Array.isArray(node)) {
    for (const x of node) renameDataRefs(x, map)
    return
  }
  if (!isObj(node)) return
  if (typeof node.data === 'string' && map.has(node.data)) node.data = map.get(node.data)
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object') renameDataRefs(v, map)
}

/** The keys whose strings are Vega expressions in a compiled view. */
export const EXPRESSION_KEYS: ReadonlySet<string> = new Set(['signal', 'update', 'init', 'expr', 'test'])

/**
 * Name the units and marks an expression names after a view (`prefix`): the unit a selection's tuple came from (`unit: "x"`,
 * `unit === "x"`) and the mark a facet's cell is read from (`group("x")`), read token by token, unless `keepUnit` / `keepMark` says
 * the name is the view's already.
 */
export function relabelUnits(expr: string, keepUnit: (unit: string) => boolean, keepMark: (mark: string) => boolean, prefix: string): string {
  const tokens = tokenize(expr)
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'string') {
      // (the operator before the string: `:`, `(`, or `===` / `==`, whose characters are tokens of their own)
      let op = prevSolid(tokens, i)
      let opRaw = op >= 0 ? tokens[op]!.raw : ''
      while (opRaw.endsWith('=') && op > 0 && tokens[op - 1]!.raw === '=') { op--; opRaw = '=' + opRaw }
      const name = op >= 0 ? tokens[prevSolid(tokens, op)] : undefined
      const isUnit = name?.kind === 'name' && name.value === 'unit' && (opRaw === ':' || opRaw === '===' || opRaw === '==')
      const isGroup = name?.kind === 'name' && name.value === 'group' && opRaw === '(' && tokens[nextSolid(tokens, i)]?.raw === ')'
      const v = t.value!
      if ((isUnit && !keepUnit(v)) || (isGroup && !keepMark(v))) { out += JSON.stringify(prefix + v); continue }
    }
    out += t.raw
  }
  return out
}
