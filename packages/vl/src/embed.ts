/**
 * Embedding a compiled child view into a composite (concat/repeat) as a group:
 * every child-local name (scales, signals, datasets) is renamed so siblings
 * cannot collide, including the names that appear INSIDE Vega expression
 * strings (`scale("x", ...)`, `bandwidth('x')`, `ceil(width/40)`). Expressions
 * are scanned token by token so a field called "width" inside a string literal
 * is never rewritten.
 */

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

/** Rewrite signal identifiers and scale-name arguments in one expression string. */
export function renameExpr(expr: string, r: Renames): string {
  let out = ''
  let i = 0
  const n = expr.length
  let lastIdent: string | null = null // identifier immediately before the current position (whitespace aside)
  let pendingFn: string | null = null // function whose '(' was just consumed
  while (i < n) {
    const c = expr[i]!
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1
      const body = expr.slice(i + 1, j)
      let text = body
      if (pendingFn && SCALE_FUNCTIONS.has(pendingFn) && r.scales.has(body)) text = r.scales.get(body)!
      else if (pendingFn && DATA_FUNCTIONS.has(pendingFn) && r.datasets?.has(body)) text = r.datasets.get(body)!
      out += c + text + c
      i = j + 1
      pendingFn = null
      lastIdent = null
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(expr[j]!)) j++
      const id = expr.slice(i, j)
      // a member access (`.width`) or a call target (`width(`) is not a signal reference
      const prev = out.replace(/\s+$/, '').slice(-1)
      let k = j
      while (k < n && /\s/.test(expr[k]!)) k++
      const isMember = prev === '.'
      const isCall = expr[k] === '('
      const isKey = expr[k] === ':' && /[{,]/.test(prev)
      out += !isMember && !isCall && !isKey && r.signals.has(id) ? r.signals.get(id)! : id
      lastIdent = id
      pendingFn = null
      i = j
      continue
    }
    if (c === '(') {
      pendingFn = lastIdent
      out += c
      i++
      lastIdent = null
      continue
    }
    if (!/\s/.test(c)) {
      pendingFn = null
      lastIdent = null
    }
    out += c
    i++
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
