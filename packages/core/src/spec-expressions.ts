/**
 * The expressions of a spec, checked as vega checks them: all of them, when the spec is parsed, before anything runs. One that
 * vega's parser refuses refuses the spec, with vega's message (see expr-check.ts for what an expression is refused for and in what
 * order): a syntax error is `Expression parse error: <text>`, where the text is what vega parsed, which is not always what the
 * author wrote:
 *
 * - a `signal` / `update` / `init` / `expr` / `test` is itself, where it stands alone;
 * - an encode entry is one expression made of its parts (`_scale("x", (signal))+(offset)`), a rule list a conditional chain,
 *   a data trigger a call of `modify`, the filters of an event stream one conjunction;
 * - a property that holds `{signal: text}` is an expression of its own, parsed when its scope has been read -- after the
 *   expressions of the scope, and not at all when the text names a signal of the scope the property is read in.
 *
 * Which names are signals is a matter of scope and of time: a group has its own signals and sees those of the scopes around it
 * (and a signal `parent`); a transform with a `signal` makes one for the expressions read after it.
 *
 * What is fixed by the observable behaviour: the order the sites are met in (a scope's signals, data sets, scales, signal handlers,
 * axes, marks, legends, title, then its lambdas -- the same order as the structural check), and the text of the message. The text of
 * an entry is built and parsed whole, only for an entry that holds a signal or a test.
 *
 * The `on` handlers of signals are read with the signal's own expression: the update, the events (a selector string, or streams
 * however nested, each with its filters), and the operators that trigger it. A handler that cannot be built refuses the spec; what
 * remains for the time the handlers are bound is what only a running chart can know.
 *
 * Which properties of an axis, a legend and the title are read at all, and as what, is guide-model.ts's; the longer text vega makes of
 * a few of them (`WRAPPED` there) when it is the author's text that is wrong in them is not reproduced.
 */
import { SpecParseError } from './parse-error.js'
import { checkExpression } from './expr-check.js'
import { parseEventSelectorString } from './event-selector.js'
import { filterCode } from './stream-defs.js'
import {
  checkFrom, checkScale, dataInputOf, legendType, LEGEND_CHANNELS, Names, need, needDataRef, parseAxisNames, parseLegendNames, parseTitleNames, specList, stringValue,
} from './spec-structure.js'
import { transformParams, type ParamKind, type TransformParam } from './transform-params.js'
import { TUPLE_MAKING_TRANSFORMS, transformTypeOf } from './transform-names.js'
import { guideReading, legendLayout, legendSizeExpression, type GuideEnv, type GuideKind } from './guide-model.js'
import { splitAccessPath } from './util.js'

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const isObject = (v: unknown): v is Rec => v !== null && typeof v === 'object'

/** The signals a view has without declaring them (vega-parser's `collectSignals`), in the order it parses their updates. */
const VIEW_SIGNALS = ['background', 'autosize', 'padding', 'width', 'height']

/**
 * What a scope of vega-parser knows by name when its expressions are read: its signals and scales (projections are scales) and
 * those of the scopes around it. A group's scope has the signal `parent` as well.
 */
class Scope {
  // (a scope with nothing declared is common: the collections are made when there is a name to put in them)
  private signals: Set<string> | null = null
  private scales: Map<string, string> | null = null
  constructor(readonly parent: Scope | null = null) {
    if (parent) this.addSignal('parent')
  }

  get isGroup(): boolean { return this.parent !== null }

  addSignal(name: unknown): void { (this.signals ??= new Set()).add(String(name)) }
  addScale(name: unknown, type?: unknown): void { (this.scales ??= new Map()).set(String(name), type ? String(type) : 'linear') }

  /**
   * Whether a signal of that name is declared here or in a scope around. (Upstream looks names up in plain objects, so `toString`
   * and `constructor` are signals of every scope; here they are absent names like any other, as the sandbox has them everywhere.)
   */
  hasSignal(name: string): boolean {
    for (let s: Scope | null = this; s; s = s.parent) if (s.signals?.has(name)) return true
    return false
  }

  hasScale(name: unknown): boolean {
    return this.scaleType(name) !== undefined
  }

  /** The type of the innermost scale (or projection) of that name. */
  scaleType(name: unknown): string | undefined {
    const k = String(name)
    for (let s: Scope | null = this; s; s = s.parent) {
      const type = s.scales?.get(k)
      if (type !== undefined) return type
    }
    return undefined
  }
}

const isSignalObject = (v: unknown): boolean => isObject(v) && !!(v as Rec).signal

/**
 * The signals of the view that have something to read, in the order vega-parser parses their updates (`collectSignals`): the five
 * every view has (when the author declared one, or a property of the view is a `{signal}`, which is its `update`), then the other
 * signals the spec declares, then those its config does.
 */
function viewSignals(spec: Rec, config: Rec): Rec[] {
  const declared = specList(spec.signals)
  // the author's declaration of each of the five, merged where there are several; the other signals as they come
  let own: Array<Rec | undefined> | undefined
  const others: Rec[] = []
  for (const s of declared) {
    if (!isRecord(s)) continue
    const at = VIEW_SIGNALS.indexOf(String(s.name))
    if (at < 0) others.push(s)
    else (own ??= [])[at] = own[at] ? { ...own[at], ...s } : s
  }
  const out: Rec[] = []
  for (let i = 0; i < 5; i++) {
    const name = VIEW_SIGNALS[i]!
    // (`width` and `height` are 0 where nothing says otherwise: a number is no signal)
    const value = spec[name] != null ? spec[name] : config[name]
    const update = isObject(value) && (value as Rec).signal ? { name, update: (value as Rec).signal } : null
    const mine = own?.[i]
    if (update || mine) out.push(update && mine ? { ...update, ...mine } : (update ?? mine)!)
  }
  for (const s of others) out.push(s)
  const fromConfig = specList(config.signals)
  if (fromConfig.length) {
    const named = new Set(declared.map((d) => (isRecord(d) ? String(d.name) : '')))
    for (const s of fromConfig) if (isRecord(s) && !VIEW_SIGNALS.includes(String(s.name)) && !named.has(String(s.name))) out.push(s)
  }
  return out
}

/**
 * The selectors seen lately and the expressions each one holds (the filters of its streams, in the order vega reads them): the same
 * few turn up in chart after chart. A selector that does not parse is not kept. `null` is the refusal's message.
 */
interface SelectorTexts { readonly texts: readonly string[] }
const selectors: Record<'view' | 'scope', Map<string, SelectorTexts>> = { view: new Map(), scope: new Map() }

/** The text of an expression given as a value of any type: a string as it is, anything else as its JSON. */
const textOf = (v: unknown): string => (typeof v === 'string' ? v : stringValue(v) + '')

class Check {
  private scope = new Scope()
  /** the data sets the scope being read knows (see spec-structure.ts `Names`) */
  private names = new Names()

  constructor(private readonly config: Rec) {}

  private get env(): GuideEnv {
    return { config: this.config, scaleType: (name) => this.scope.scaleType(name) }
  }

  /** Run `read` in a scope of its own, inside the current one (and, when given, with data sets of its own). */
  private within<T>(scope: Scope, read: () => T, names: Names = this.names): T {
    const outer = this.scope
    const outerNames = this.names
    this.scope = scope
    this.names = names
    try { return read() } finally { this.scope = outer; this.names = outerNames }
  }

  /** An expression that stands alone. */
  expression(value: unknown): void {
    if (this.collecting) this.collecting.push(textOf(value))
    else checkExpression(textOf(value), this.isSignal)
  }

  /** while set, the expressions that are met are kept, not checked: what a selector holds is worked out once */
  private collecting: string[] | null = null

  /** The expressions the streams of a selector hold, in the order they are read. */
  private selectorTexts(selector: string, source: 'view' | 'scope'): readonly string[] {
    const cache = selectors[source]
    let found = cache.get(selector)
    if (found === undefined) {
      let defs: ReturnType<typeof parseEventSelectorString>
      try {
        defs = parseEventSelectorString(selector, source)
      } catch (cause) {
        throw new SpecParseError(cause instanceof Error ? cause.message : String(cause), { cause })
      }
      const texts: string[] = []
      this.collecting = texts
      try { this.stream(defs.length > 1 ? { merge: defs } : defs[0]) } finally { this.collecting = null }
      found = { texts }
      if (cache.size >= 1024) cache.clear()
      cache.set(selector, found)
    }
    return found.texts
  }

  /** Whether a name is a signal of the scope being read. */
  private readonly isSignal = (name: string): boolean => this.scope.hasSignal(name)

  /** The texts of the `{signal: text}` objects of a subtree, in document order. */
  lambdas(node: unknown, out: string[], skip: ReadonlySet<string> = NONE, depth = 0): void {
    if (!isObject(node) || depth > 64) return
    if (Array.isArray(node)) {
      for (const item of node) this.lambdas(item, out, NONE, depth + 1)
      return
    }
    const signal = node.signal
    if (typeof signal === 'string' && signal && !this.scope.hasSignal(signal) && !skip.has('signal')) out.push(signal)
    for (const key of Object.keys(node)) if (!skip.has(key)) this.lambdas(node[key], out, NONE, depth + 1)
  }

  /** `scope.signalRef(name)`: a signal of the scope is itself, anything else an expression of its own, read last. */
  private signalRef(name: unknown, lambdas: string[]): void {
    const text = String(name)
    if (!this.scope.hasSignal(text)) lambdas.push(text)
  }

  flush(lambdas: string[]): void {
    for (const text of lambdas) this.expression(text)
    lambdas.length = 0
  }

  // -- a scope, in the order vega reads it -------------------------------------------------------------------------

  /** The view: its signals (the five of every view, the spec's, the config's) are known to all its expressions. */
  view(spec: Rec, config: Rec): void {
    const lambdas: string[] = []
    const signals = viewSignals(spec, config)
    for (const name of VIEW_SIGNALS) this.scope.addSignal(name)
    this.declare(signals)
    this.contents(spec, signals, lambdas)
    this.flush(lambdas)
    // the view registers its own root item last
    this.names.declare('root')
  }

  /**
   * `parseSignal`: a signal is known to its whole scope; one that pushes to the outer scope must be one that scope (or one around it)
   * declared before, and says nothing of its own value.
   */
  private declare(signals: readonly Rec[]): void {
    for (const s of signals) {
      if (s.push !== 'outer') {
        this.scope.addSignal(s.name)
        continue
      }
      if (!this.scope.hasSignal(String(s.name))) throw new SpecParseError('No prior signal definition for "outer" push: ' + stringValue(s.name))
      for (const key of OUTER_INVALID) if (s[key] !== undefined) throw new SpecParseError('Invalid property  for "outer" push: ' + stringValue(key))
    }
  }

  private contents(spec: Rec, signals: readonly Rec[], lambdas: string[]): void {
    for (const p of specList(spec.projections)) if (isRecord(p)) this.scope.addScale(p.name, 'projection')
    for (const s of specList(spec.scales)) if (isRecord(s)) { this.scope.addScale(s.name, s.type); this.names.addScale(s.name, s.type) }
    this.lambdas(specList(spec.projections), lambdas)
    for (const d of specList(spec.data)) if (isRecord(d)) this.dataset(d, lambdas)
    for (const s of specList(spec.scales)) {
      checkScale(s, this.names)
      this.lambdas(s, lambdas)
    }
    for (const s of signals) this.signal(s, lambdas)
    for (const a of specList(spec.axes)) {
      if (!isRecord(a)) continue
      // (the axis's configuration is looked up by the type of its scale, first)
      this.scaleNamed(a.scale)
      this.guide('axis', a, lambdas)
      parseAxisNames(a, this.names, () => this.config)
    }
    for (const m of specList(spec.marks)) if (isRecord(m)) this.mark(m, lambdas)
    for (const l of specList(spec.legends)) {
      if (!isRecord(l)) continue
      // a legend is for the scale of its first channel, which must be one of the scope
      const scale = LEGEND_CHANNELS.map((c) => l[c]).find((v) => !!v)
      if (!scale) throw new SpecParseError('Missing valid scale for legend.')
      this.scaleNamed(scale)
      this.guide('legend', l, lambdas)
      parseLegendNames(l, this.names)
    }
    if (spec.title) {
      if (isRecord(spec.title)) this.guide('title', spec.title, lambdas)
      parseTitleNames(spec.title, this.names)
    }
  }

  /** `scope.getScale`: a scale (or a projection) of the scope, or one around it. */
  private scaleNamed(name: unknown): void {
    if (!this.scope.hasScale(name)) throw new SpecParseError('Unrecognized scale name: ' + stringValue(name))
  }

  /** `parseData`: its transforms, its triggers, the data sets it is derived from (when it has no values of its own), then its name. */
  private dataset(d: Rec, lambdas: string[]): void {
    for (const t of specList(d.transform)) if (isRecord(t)) this.transform(t, lambdas)
    for (const on of specList(d.on)) if (isRecord(on)) this.trigger(on, String(d.name))
    this.lambdas({ url: d.url, async: d.async, values: Array.isArray(d.values) ? undefined : d.values }, lambdas)
    this.objectProperty(d.format, lambdas)
    if (dataInputOf(d) === 'source') for (const source of specList(d.source)) need(this.names, source)
    this.names.declare(d.name)
  }

  /** `parseTransform`: the parameters in the order of the definition, each read whole; then the transform's own signal. */
  private transform(t: Rec, lambdas: string[]): void {
    this.parameters(t, transformParams(t.type), lambdas)
    // (the transform's own signal is a signal of its scope from here on)
    if (t.signal) this.scope.addSignal(t.signal)
  }

  /**
   * `parseParameters`: each parameter of a definition in its order, as vega reads it -- the data set a lookup indexes (a literal name of
   * the scope), a required one that is missing, objects of sub-parameters (a list of them, each of a known kind), the name of a
   * projection or of a data set of the scope, a list (anything but a list or a `{signal}` makes vega's parser throw as it maps over it),
   * and the expressions it holds. `owner` is the object the parameters are written in: its `type` names it in a message.
   *
   * A `bin` without `extent` is the one required parameter not refused: Aster derives it from the data (a deliberate deviation, see
   * docs/ARCHITECTURE.md), where vega refuses it.
   */
  private parameters(owner: Rec, params: readonly TransformParam[], lambdas: string[]): void {
    for (const p of params) {
      if (p.ref === 'index') {
        if (typeof owner.from !== 'string') throw new SpecParseError('Lookup "from" parameter must be a string literal.')
        need(this.names, owner.from)
        continue
      }
      const value = owner[p.name]
      if (value === undefined) {
        if (p.required && !(p.name === 'extent' && transformTypeOf(owner.type) === 'bin')) throw new SpecParseError('Missing required ' + stringValue(owner.type) + ' parameter: ' + stringValue(p.name))
        continue
      }
      if (p.sub !== undefined) {
        if (p.list && !Array.isArray(value)) throw new SpecParseError('Expected an array of sub-parameters. Instead: ' + stringValue(value))
        for (const item of p.list ? (value as unknown[]) : [value]) this.subParameters(item, p.sub, lambdas)
        continue
      }
      if (p.ref === 'projection') {
        this.scaleNamed(value)
        continue
      }
      if (p.list && !isSignalObject(value) && !Array.isArray(value)) {
        throw new TypeError(value === null ? "Cannot read properties of null (reading 'map')" : 'value.map is not a function')
      }
      if (p.ref === 'data' && !isSignalObject(value)) {
        for (const name of p.list ? (value as unknown[]) : [value]) if (!isSignalObject(name)) need(this.names, name)
      }
      if (p.kind === 'expression' || (p.kind !== 'value' && isObject(value))) this.parameter(value, p.kind)
      if (isObject(value)) this.lambdas(value, lambdas)
    }
  }

  /** `parseSubParameter`: an object of the kind whose key it has, read through that kind's parameters. */
  private subParameters(item: unknown, kinds: NonNullable<TransformParam['sub']>, lambdas: string[]): void {
    const keys = Object.keys(kinds[0]?.key ?? {})
    if (item == null) throw new TypeError(`Cannot read properties of ${item} (reading '${keys[0]}')`)
    const o = item as Rec
    const kind = kinds.find((k) => Object.keys(k.key).every((key) => k.key[key] === o[key]))
    if (kind === undefined) throw new SpecParseError('Unsupported parameter: ' + stringValue(item))
    this.parameters(o, kind.params, lambdas)
  }

  /** One parameter's expressions that are read at once: an `expr` is a text; a field or a comparator may be written `{expr: text}`. */
  private parameter(value: unknown, kind: ParamKind): void {
    if (kind === 'expression') {
      if (isSignalObject(value)) throw new SpecParseError('Expression references can not be signals.')
      this.expression(value)
    } else if (kind === 'field' || kind === 'compare') {
      // (a comparator is `{field, order}`, each of which is a value or a list of them; any other parameter is a value or a list)
      const parts = kind === 'compare' && isRecord(value) ? [...specList(value.field), ...specList(value.order)] : Array.isArray(value) ? value : [value]
      for (const part of parts) {
        if (!isSignalObject(part) && isObject(part) && (part as Rec).expr) this.expression((part as Rec).expr)
      }
    }
  }

  /** `if(<trigger>,modify("<name>",<insert>,<remove>,<toggle>,<modify>,<values>),0)` */
  private trigger(on: Rec, name: string): void {
    const arg = (v: unknown): string => (v == null ? 'null' : `${v as string}`)
    const text = 'if(' + `${on.trigger as string}` + ',modify("' + name + '",' + [on.insert, on.remove, on.toggle, on.modify, on.values].map(arg).join(',') + '),0)'
    this.expression(text)
  }

  // -- signals and their handlers ----------------------------------------------------------------------------------

  /** `parseSignalUpdates`: the signal's expression, then each of its handlers in turn. */
  private signal(s: Rec, lambdas: string[]): void {
    if (s.push !== 'outer') {
      let expr = s.update
      if (s.init) {
        if (expr) throw new SpecParseError('Signals can not include both init and update expressions.')
        expr = s.init
      }
      if (expr) this.expression(expr)
    }
    if (Array.isArray(s.on)) for (const h of s.on) this.handler(h, lambdas)
  }

  /** One entry of a signal's `on`: vega-parser's `parseUpdate`. */
  private handler(h: unknown, lambdas: string[]): void {
    if (!isRecord(h)) return
    if (!h.events) throw new SpecParseError('Signal update missing events specification.')
    let events: unknown = h.events
    // (a selector gives streams alone: what they hold is worked out once, and read after the update)
    let selected: readonly string[] | null = null
    if (typeof events === 'string') {
      selected = this.selectorTexts(events, this.scope.isGroup ? 'scope' : 'view')
      events = []
    }
    // the operators that trigger the handler (a signal, a scale), and the event streams
    const operators: Rec[] = []
    const streams: unknown[] = []
    for (const e of specList(events)) {
      if (e == null) throw new TypeError(`Cannot read properties of ${e} (reading 'signal')`)
      if (isObject(e) && (e.signal || e.scale)) operators.push(e)
      else streams.push(e)
    }
    // several operators are one: the expression that makes an array of them
    const sources: unknown[] = operators.length > 1
      ? [{ signal: '[' + operators.map((o) => (o.scale ? 'scale("' + (o.scale as string) + '")' : (o.signal as string))).join(',') + ']' }]
      : operators
    if (streams.length) sources.push(streams.length > 1 ? { merge: streams } : streams[0])

    let update = h.update
    if (h.encode != null) {
      if (update) throw new SpecParseError('Signal encode and update are mutually exclusive.')
      update = 'encode(item(),' + stringValue(h.encode) + ')'
    }
    if (typeof update === 'string') this.expression(update)
    else if (update == null) throw new TypeError(`Cannot read properties of ${update} (reading 'expr')`)
    else {
      const u = update as Rec
      if (u.expr != null) this.expression(u.expr)
      else if (u.value != null) { /* a value is not read */ }
      else if (u.signal != null) this.signalRef(u.signal, lambdas)
      else throw new SpecParseError('Invalid signal update specification.')
    }

    if (selected) for (const text of selected) this.expression(text)
    else for (const source of sources) this.source(source as Rec, lambdas)
  }

  /** What triggers a handler: an operator (a signal, a scale) or an event stream. */
  private source(source: Rec, lambdas: string[]): void {
    if (source.signal) this.signalRef(source.signal, lambdas)
    else if (source.scale) {
      if (!this.scope.hasScale(source.scale)) throw new SpecParseError('Unrecognized scale name: ' + stringValue(source.scale))
    } else this.stream(source)
  }

  /** `parseStream`: a stream of events, a merge of streams, or a stream nested in another; each with its own parameters. */
  private stream(stream: unknown): void {
    const s = isRecord(stream) ? stream : null
    if (s?.merge) {
      for (const m of s.merge as unknown[]) this.stream(m)
      this.streamParameters(s)
    } else if (s?.stream) {
      this.stream(s.stream)
      this.streamParameters(s)
    } else if (s?.type) {
      // (a timer has no source and no mark to filter: only its own `between` and `filter` count)
      this.streamParameters(s.type === 'timer' ? { between: s.between, filter: s.filter } : s)
    } else {
      throw new SpecParseError('Invalid stream specification: ' + stringValue(stream))
    }
  }

  private streamParameters(stream: Rec): void {
    const between = stream.between as unknown[] | undefined
    if (between) {
      if (between.length !== 2) throw new SpecParseError('Stream "between" parameter must have 2 entries: ' + stringValue(stream))
      this.stream(between[0])
      this.stream(between[1])
    }
    const filters = filterCode(stream)
    if (filters !== null) this.expression(filters)
  }

  /**
   * An axis, a legend or the title (see guide-model.ts for what of it is read, and as what). The properties that vega reads as
   * values of their own are lambdas; every other `{signal}` is the entry of a channel of a mark the guide is made of, whose expression
   * is the signal in parentheses. Then the user's encode blocks. The marks of a symbol legend's entries are parsed in a group of
   * their own: a scope with a signal `parent`.
   */
  private guide(kind: GuideKind, g: Rec, lambdas: string[]): void {
    // a guide that holds no signal, no encode, nothing but values has no expression to read
    const keys = Object.keys(g)
    if (!keys.some((key) => key !== 'scale' && isObject(g[key]))) return
    const reading = guideReading(kind, g, this.env)
    const symbols = kind === 'legend' && legendType(g, this.scope.scaleType(LEGEND_CHANNELS.map((c) => g[c]).find((s) => !!s))) === 'symbol'
    // a symbol legend measures its entries as soon as they are made: before any of its marks are read
    if (symbols) this.expression(legendSizeExpression(g, this.env))
    const entries: string[] = []
    for (const key of keys) {
      const v = g[key]
      if (key === 'encode' || key === 'scale' || !isObject(v)) continue
      const how = reading(key)
      if (how === 'object') this.objectProperty(v, lambdas)
      else if (how === 'value') this.lambdas(v, lambdas)
      else if (how === 'entry') entries.push(key)
    }
    // the entries of a symbol legend lie in a group of their own
    for (const key of entries) {
      if (symbols && ENTRY_PARTS.test(key)) this.within(new Scope(this.scope), () => this.guideEntries(g[key]))
      else this.guideEntries(g[key])
    }
    if (symbols) this.objectProperty(legendLayout(g, this.env), lambdas)
    if (isRecord(g.encode)) {
      for (const key of Object.keys(g.encode)) {
        const one = { [key]: g.encode[key] }
        if (symbols && ENTRY_PARTS.test(key)) this.within(new Scope(this.scope), () => this.encode(one))
        else this.encode(one)
      }
    }
  }

  /** The `{signal}`s a guide property holds, each as the entry of a channel. */
  private guideEntries(node: unknown, depth = 0): void {
    if (!isObject(node) || depth > 16) return
    if (!Array.isArray(node) && typeof node.signal === 'string' && node.signal) {
      this.expression(`(${node.signal})`)
      return
    }
    for (const key of Object.keys(node)) this.guideEntries(node[key], depth + 1)
  }

  /**
   * `scope.objectProperty`: a `{signal}` is itself, any other object an expression that writes the object out with its signals in it
   * (a signal that names a signal of the scope stands for its text there, too: it is not a reference).
   */
  private objectProperty(value: unknown, lambdas: string[]): void {
    if (!isObject(value)) return
    if (!Array.isArray(value) && value.signal) { this.lambdas(value, lambdas); return }
    if (holdsSignal(value)) lambdas.push(propertyLambda(value))
  }

  /** `parseMark`, in the order its parts are read: interactivity and clip, the encode sets, the transforms, the sort, the layout, the content of a group, the triggers. */
  private mark(m: Rec, lambdas: string[]): void {
    const group = m.type === 'group'
    const facet = isRecord(m.from) && isRecord(m.from.facet) ? m.from.facet : undefined
    checkFrom(m.from, group, this.names)
    for (const key of ['interactive', 'clip']) this.lambdas(m[key], lambdas)
    this.encode(m.encode)
    for (const t of specList(m.transform)) {
      if (!isRecord(t)) continue
      this.transform(t, lambdas)
      if (typeof t.type === 'string' && TUPLE_MAKING_TRANSFORMS.has(t.type.toLowerCase())) throw new SpecParseError('Mark transforms should not generate new data.')
    }
    if (m.sort) {
      this.parameter(m.sort, 'compare')
      this.lambdas(m.sort, lambdas)
    }
    this.objectProperty(m.layout, lambdas)
    if (group) {
      // a facet is read with the group's content: its data set again, its name, its data, how it groups
      if (facet !== undefined) {
        needDataRef(facet, this.names)
        if (!facet.name) throw new SpecParseError('Facet must have a name: ' + stringValue(facet))
        if (!facet.data) throw new SpecParseError('Facet must reference a data set: ' + stringValue(facet))
        if (!facet.field && !facet.groupby) throw new SpecParseError('Facet must specify groupby or field: ' + stringValue(facet))
      }
      // a group is a scope of data sets of its own, unless its role is a guide's and it has no layout and no facet: then it is parsed in
      // its parent's (a facet's name is a data set of the group's scope)
      const role = typeof m.role === 'string' ? m.role : ''
      const guideRole = role.startsWith('axis') || role.startsWith('legend') || role.startsWith('title')
      const names = !guideRole || !!m.layout || facet !== undefined ? new Names(this.names) : this.names
      if (facet !== undefined) names.declare(facet.name)
      const inner: string[] = []
      const scope = new Scope(this.scope)
      this.within(scope, () => {
        const signals = specList(m.signals).filter(isRecord)
        this.declare(signals)
        this.contents(m, signals, inner)
        this.flush(inner)
      }, names)
    }
    this.lambdas(m.overlap, lambdas)
    if (m.name != null) this.names.declare(m.name)
    // a named mark's triggers are read last, in the scope the mark is in
    if (m.name != null) for (const on of specList(m.on)) if (isRecord(on) && !(on.insert || on.remove || on.toggle)) this.trigger(on, String(m.name))
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

/** The properties and encode blocks of a legend that belong to the marks of its entries (symbols and labels), as against its title and frame. */
const ENTRY_PARTS = /^(symbol|label|entries$)/
/** What a signal that pushes to an outer scope may not say (its value is the outer signal's). */
const OUTER_INVALID = ['value', 'update', 'init', 'react', 'bind'] as const
const NONE: ReadonlySet<string> = new Set()
const BLOCKS: ReadonlySet<string> = new Set(['enter', 'update', 'exit', 'hover', 'leave', 'select', 'release', 'name', 'interactive', 'style'])

// -- the text vega makes of an encode entry ----------------------------------------------------------------------------

/** Whether an object or list has a `{signal}` anywhere in it. */
function holdsSignal(node: unknown, depth = 0): boolean {
  if (!isObject(node) || depth > 64) return false
  if (!Array.isArray(node) && node.signal) return true
  for (const key of Object.keys(node)) if (holdsSignal(node[key], depth + 1)) return true
  return false
}

/** Whether an entry (or list of rules) has a signal or a test anywhere in it, or is a gradient (its start, stop and count may leave a hole in the call). */
function holdsExpression(node: unknown, depth = 0): boolean {
  if (!isObject(node) || depth > 8) return false
  if (!Array.isArray(node) && (node.signal || node.test || node.gradient != null)) return true
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
export function checkExpressions(spec: Rec, config: Rec = {}): void {
  new Check(config).view(spec, config)
}

/** vega-parser's `propertyLambda`: an object or array written out as an expression, a `{signal}` in it standing for its text. */
function propertyLambda(spec: unknown): string {
  const part = (v: unknown): string => (isObject(v) ? (typeof v.signal === 'string' && v.signal ? v.signal : !Array.isArray(v) && v.signal ? String(v.signal) : propertyLambda(v)) : stringValue(v))
  if (Array.isArray(spec)) return '[' + spec.map((v, i) => (i > 0 ? ',' : '') + part(v)).join('') + ']'
  const o = spec as Rec
  return '{' + Object.keys(o).map((k, i) => (i > 0 ? ',' : '') + stringValue(k) + ':' + part(o[k])).join('') + '}'
}
