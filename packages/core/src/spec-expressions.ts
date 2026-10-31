/**
 * The expressions of a spec, checked as vega checks them: all of them, when the spec is parsed, before anything runs. One that is
 * not an expression refuses the spec with `Expression parse error: <text>`, where the text is what vega parsed, which is not
 * always what the author wrote:
 *
 * - a `signal` / `update` / `init` / `expr` / `test` is itself, where it stands alone;
 * - an encode entry is one expression made of its parts (`_scale("x", (signal))+(offset)`), a rule list a conditional chain,
 *   a data trigger a call of `modify`;
 * - a property that holds `{signal: text}` is an expression of its own, parsed when its scope has been read -- after the
 *   expressions of the scope, and not at all when the text names a signal.
 *
 * What is fixed by the observable behaviour: the order the sites are met in (a scope's signals, data sets, scales, signal handlers,
 * axes, marks, legends, title, then its lambdas -- the same order as the structural check), and the text of the message. The text of
 * an entry is built and parsed whole, only for an entry that holds a signal or a test.
 *
 * Not checked here: the `on` handlers of signals (their events, filters and updates). A handler that cannot be built is reported
 * when the signals are bound and the other handlers still bind (see signals.ts); what it reports reads as vega's message does.
 *
 * Not reproduced: the longer text vega makes of a few guide properties (an axis `orient` that is a signal, `band` positions, signed
 * offsets); their expression is quoted alone.
 */
import { SpecParseError } from './parse-error.js'
import { parseExpressionCached } from './expr-parser.js'
import { specList, stringValue } from './spec-structure.js'
import { splitAccessPath } from './util.js'

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const isObject = (v: unknown): v is Rec => v !== null && typeof v === 'object'

/** The signals a view has without declaring them. */
const VIEW_SIGNALS = ['width', 'height', 'padding', 'autosize', 'background', 'cursor']

function refuse(text: string, cause: unknown): never {
  throw new SpecParseError('Expression parse error: ' + text, { cause })
}

/** Whether `text` is an expression; if not, the error the parser gave. */
function parseError(text: string): { error: unknown } | null {
  try {
    parseExpressionCached(text)
    return null
  } catch (e) {
    // (a limit is the engine's refusal, not a syntax error: it keeps its type, wherever the text is first read)
    if (e instanceof Error && e.name === 'AsterLimitError') throw e
    return { error: e }
  }
}

/** The text of an expression given as a value of any type: a string as it is, anything else as its JSON. */
const textOf = (v: unknown): string => (typeof v === 'string' ? v : stringValue(v) + '')

class Check {
  /** every signal a spec declares, in any scope: a `{signal: name}` that names one is a reference, not an expression */
  private readonly named = new Set<string>(VIEW_SIGNALS)

  constructor(spec: Rec) {
    this.collectNames(spec)
  }

  private collectNames(scope: Rec): void {
    for (const s of specList(scope.signals)) if (isRecord(s) && s.name !== undefined) this.named.add(String(s.name))
    for (const m of specList(scope.marks)) if (isRecord(m)) this.collectNames(m)
  }

  /** An expression that stands alone. */
  expression(value: unknown): void {
    const text = textOf(value)
    const bad = parseError(text)
    if (bad) refuse(text, bad.error)
  }

  /** The texts of the `{signal: text}` objects of a subtree, in document order. */
  lambdas(node: unknown, out: string[], skip: ReadonlySet<string> = NONE, depth = 0): void {
    if (!isObject(node) || depth > 64) return
    if (Array.isArray(node)) {
      for (const item of node) this.lambdas(item, out, NONE, depth + 1)
      return
    }
    const signal = node.signal
    if (typeof signal === 'string' && signal && !this.named.has(signal) && !skip.has('signal')) out.push(signal)
    for (const key of Object.keys(node)) if (!skip.has(key)) this.lambdas(node[key], out, NONE, depth + 1)
  }

  flush(lambdas: string[]): void {
    for (const text of lambdas) this.expression(text)
    lambdas.length = 0
  }

  // -- a scope, in the order vega reads it -------------------------------------------------------------------------

  scope(spec: Rec, lambdas: string[], view = false): void {
    for (const key of ['projections']) this.lambdas(specList(spec[key]), lambdas)
    for (const d of specList(spec.data)) if (isRecord(d)) this.dataset(d, lambdas)
    for (const s of specList(spec.scales)) this.lambdas(s, lambdas)
    for (const s of specList(spec.signals)) if (isRecord(s)) this.signal(s)
    for (const a of specList(spec.axes)) if (isRecord(a)) this.guide(a, lambdas)
    for (const m of specList(spec.marks)) if (isRecord(m)) this.mark(m, lambdas)
    for (const l of specList(spec.legends)) if (isRecord(l)) this.guide(l, lambdas)
    if (isRecord(spec.title)) this.guide(spec.title, lambdas)
    if (view) {
      // the view's own properties (a size, padding, autosize, background that is a signal) are signals of the view
      for (const key of ['width', 'height', 'padding', 'autosize', 'background']) this.lambdas(spec[key], lambdas)
    }
  }

  private dataset(d: Rec, lambdas: string[]): void {
    for (const t of specList(d.transform)) if (isRecord(t)) this.transform(t, lambdas)
    for (const on of specList(d.on)) if (isRecord(on)) this.trigger(on, String(d.name))
    this.lambdas({ url: d.url, async: d.async, values: Array.isArray(d.values) ? undefined : d.values }, lambdas)
    this.objectProperty(d.format, lambdas)
  }

  private transform(t: Rec, lambdas: string[]): void {
    this.expressionsIn(t, 0)
    this.lambdas(t, lambdas, TRANSFORM_OWN)
  }

  /** `expr` of a transform, and the `{expr: text}` that stands for a field or a value (vega's field references). */
  private expressionsIn(node: unknown, depth: number): void {
    if (!isObject(node) || depth > 16) return
    if (Array.isArray(node)) {
      for (const item of node) this.expressionsIn(item, depth + 1)
      return
    }
    for (const key of Object.keys(node)) {
      const v = node[key]
      if ((key === 'expr' && v != null && !isObject(v)) || (depth === 0 && key === 'filter' && node.type === 'cross' && typeof v === 'string')) this.expression(v)
      else this.expressionsIn(v, depth + 1)
    }
  }

  /** `if(<trigger>,modify("<name>",<insert>,<remove>,<toggle>,<modify>,<values>),0)` */
  private trigger(on: Rec, name: string): void {
    const arg = (v: unknown): string => (v == null ? 'null' : `${v as string}`)
    const text = 'if(' + `${on.trigger as string}` + ',modify("' + name + '",' + [on.insert, on.remove, on.toggle, on.modify, on.values].map(arg).join(',') + '),0)'
    this.expression(text)
  }

  private signal(s: Rec): void {
    if (s.push === 'outer') return
    let expr = s.update
    if (s.init) {
      if (expr) return
      expr = s.init
    }
    if (expr) this.expression(expr)
  }

  /**
   * An axis, a legend or the title. The properties that vega reads as values of their own are lambdas; every other `{signal}` is the
   * entry of a channel of a mark the guide is made of, whose expression is the signal in parentheses. Then the user's encode blocks.
   */
  private guide(g: Rec, lambdas: string[]): void {
    for (const key of Object.keys(g)) {
      const v = g[key]
      if (key === 'encode' || key === 'scale' || !isObject(v)) continue
      if (OBJECT_PROPERTIES.has(key)) this.objectProperty(v, lambdas)
      else if (GUIDE_VALUES.has(key)) this.lambdas(v, lambdas)
      else this.guideEntries(v)
    }
    this.encode(g.encode)
  }

  /** The `{signal}`s a guide property holds, each as the entry of a channel. */
  private guideEntries(node: unknown, depth = 0): void {
    if (!isObject(node) || depth > 16) return
    if (!Array.isArray(node) && typeof node.signal === 'string' && node.signal) {
      if (!this.named.has(node.signal)) this.expression(`(${node.signal})`)
      return
    }
    for (const key of Object.keys(node)) this.guideEntries(node[key], depth + 1)
  }

  /** `scope.objectProperty`: a `{signal}` is itself, any other object an expression that writes the object out with its signals in it. */
  private objectProperty(value: unknown, lambdas: string[]): void {
    if (!isObject(value)) return
    if (!Array.isArray(value) && value.signal) { this.lambdas(value, lambdas); return }
    const found: string[] = []
    this.lambdas(value, found)
    if (found.length) lambdas.push(propertyLambda(value))
  }

  private mark(m: Rec, lambdas: string[]): void {
    for (const t of specList(m.transform)) if (isRecord(t)) this.transform(t, lambdas)
    for (const key of ['clip', 'interactive', 'sort']) this.lambdas(m[key], lambdas)
    this.objectProperty(m.layout, lambdas)
    this.encode(m.encode)
    if (m.type === 'group') {
      const inner: string[] = []
      this.scope(m, inner)
      this.flush(inner)
    }
  }

  // -- encode entries ----------------------------------------------------------------------------------------------

  /** The blocks of an encode set (`enter`, `update`, ...) and, for a guide, those of each of its parts. */
  encode(encode: unknown, depth = 0): void {
    if (!isRecord(encode)) return
    for (const key of Object.keys(encode)) {
      const block = encode[key]
      if (!isRecord(block)) continue
      if (depth === 0 && !BLOCKS.has(key)) {
        // a guide's part (`labels`, `ticks`, ...) holds blocks of its own
        this.encode(block, 1)
        continue
      }
      for (const channel of Object.keys(block)) {
        const entry = block[channel]
        if (entry == null) continue
        this.entry(entry)
      }
    }
  }

  /** One channel of an encode block: an entry, or a list of rules. Only one that holds an expression is built and parsed. */
  private entry(spec: unknown): void {
    if (!holdsExpression(spec)) return
    const text = Array.isArray(spec) ? ruleText(spec) : entryText(spec)
    if (text !== null) this.expression(text)
  }
}

const NONE: ReadonlySet<string> = new Set()
const TRANSFORM_OWN: ReadonlySet<string> = new Set(['signal', 'expr'])
/** The properties of an axis or a legend that vega reads as values of their own, not as the entry of a channel. */
const GUIDE_VALUES: ReadonlySet<string> = new Set(['tickMinStep', 'formatType', 'format', 'symbolLimit', 'bandPosition'])
const OBJECT_PROPERTIES: ReadonlySet<string> = new Set(['tickCount', 'values'])
const BLOCKS: ReadonlySet<string> = new Set(['enter', 'update', 'exit', 'hover', 'leave', 'select', 'release', 'name', 'interactive', 'style'])

// -- the text vega makes of an encode entry ----------------------------------------------------------------------------

/** Whether an entry (or list of rules) has a signal or a test anywhere in it. */
function holdsExpression(node: unknown, depth = 0): boolean {
  if (!isObject(node) || depth > 8) return false
  if (!Array.isArray(node) && (node.signal || node.test)) return true
  for (const key of Object.keys(node)) if (holdsExpression(node[key], depth + 1)) return true
  return false
}

/** A field reference as vega writes it into the expression of an entry: `datum["a"]`, `item.mark.group["a"]`, `datum[signal]`. */
function fieldText(ref: unknown): string | null {
  const r: Rec = isRecord(ref) ? ref : { datum: ref }
  let object: string
  let field: unknown
  if (r.signal) { object = 'datum'; field = r.signal } else if (r.group || r.parent) {
    let level = Math.max(1, (r.level as number) || 1)
    object = 'item'
    while (level-- > 0) object += '.mark.group'
    if (r.parent) { field = r.parent; object += '.datum' } else field = r.group
  } else if (r.datum) { object = 'datum'; field = r.datum } else return null
  if (!r.signal) {
    if (typeof field === 'string') field = splitAccessPath(field).map(stringValue).join('][')
    else { const inner = fieldText(field); if (inner === null) return null; field = inner }
  }
  return `${object}[${field as string}]`
}

const scaleText = (scale: unknown): string | null =>
  typeof scale === 'string' ? stringValue(scale) : isRecord(scale) && scale.signal ? `(${scale.signal as string})` : fieldText(scale)

const propertyText = (p: unknown): string | null => (isRecord(p) ? (() => { const t = entryText(p); return t === null ? null : `(${t})` })() : `${p as string}`)

const colorText = (type: string, parts: unknown[]): string | null => {
  const texts = parts.map((p) => (isObject(p) ? entryText(p) : 'null'))
  return texts.some((t) => t === null) ? null : `(${type}(${texts.join(',')})+'')`
}

/** The expression vega builds for an entry (null: for one it would refuse in another way, which is not this check's). */
export function entryText(spec: unknown): string | null {
  if (!isObject(spec) || Array.isArray(spec)) return 'null'
  const e = spec as Rec
  if (e.gradient != null) {
    const args: Array<string | null> = [e.start, e.stop, e.count].map((v) => (v == null ? null : stringValue(v)))
    while (args.length && args[args.length - 1] == null) args.pop()
    const scale = scaleText(e.gradient)
    return scale === null ? null : `gradient(${[scale, ...args].join(',')})`
  }
  let value: string | undefined | null
  if (e.signal) value = `(${e.signal as string})`
  else if (e.color) {
    const c = e.color as Rec
    value = c.c ? colorText('hcl', [c.h, c.c, c.l]) : c.h || c.s ? colorText('hsl', [c.h, c.s, c.l]) : c.l || c.a ? colorText('lab', [c.l, c.a, c.b]) : c.r || c.g || c.b ? colorText('rgb', [c.r, c.g, c.b]) : 'null'
  } else if (e.field != null) value = fieldText(e.field)
  else if (e.value !== undefined) value = stringValue(e.value)
  if (value === null) return null
  if (e.scale != null) {
    const scale = scaleText(e.scale)
    if (scale === null) return null
    if (e.range != null) value = `lerp(_range(${scale}), ${+(e.range as number)})`
    else {
      if (value !== undefined) value = `_scale(${scale}, ${value})`
      if (e.band) {
        const band = +(e.band as number) === 1 ? '' : '*' + propertyText(e.band)
        value = (value ? value + '+' : '') + `_bandwidth(${scale})` + band
        if (e.extra) value = `(datum.extra ? _scale(${scale}, datum.extra.value) : ${value})`
      }
      if (value == null) value = '0'
    }
  }
  if (value === undefined) value = 'null'
  if (e.exponent != null) value = `pow(${value},${propertyText(e.exponent)})`
  if (e.mult != null) value += `*${propertyText(e.mult)}`
  if (e.offset != null) value += `+${propertyText(e.offset)}`
  if (e.round) value = `round(${value})`
  return value
}

/** The expression for a list of rules: `(test)?value:(test)?value:...` ending in the last value, or `null`. */
function ruleText(rules: unknown[]): string | null {
  let code = ''
  for (const r of rules) {
    const value = entryText(r)
    if (value === null) return null
    code += isRecord(r) && r.test ? `(${r.test as string})?${value}:` : value
  }
  return code.endsWith(':') ? code + 'null' : code
}

/**
 * Check every expression of a spec the way vega parses them (see the head of this file). Throws `SpecParseError` for the first
 * one, in vega's order, that is not an expression.
 */
export function checkExpressions(spec: Rec): void {
  const check = new Check(spec)
  const lambdas: string[] = []
  check.scope(spec, lambdas, true)
  check.flush(lambdas)
}

/** vega-parser's `propertyLambda`: an object or array written out as an expression, a `{signal}` in it standing for its text. */
function propertyLambda(spec: unknown): string {
  const part = (v: unknown): string => (isObject(v) ? (typeof v.signal === 'string' && v.signal ? v.signal : !Array.isArray(v) && v.signal ? String(v.signal) : propertyLambda(v)) : stringValue(v))
  if (Array.isArray(spec)) return '[' + spec.map((v, i) => (i > 0 ? ',' : '') + part(v)).join('') + ']'
  const o = spec as Rec
  return '{' + Object.keys(o).map((k, i) => (i > 0 ? ',' : '') + stringValue(k) + ':' + part(o[k])).join('') + '}'
}
