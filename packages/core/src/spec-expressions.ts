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
import { engineSlotMessage, isEngineSlot } from './item-slots.js'
import { checkExpression } from './expr-check.js'
import { parseEventSelectorString } from './event-selector.js'
import { filterCode } from './stream-defs.js'
import {
  axisValue, checkFrom, checkScale, dataInputOf, dataWithoutRows, legendType, LEGEND_CHANNELS, Names, need, needDataRef, parseAxisNames, parseLegendNames, parseTitleNames, specList, stringValue,
} from './spec-structure.js'
import { transformParams, type ParamKind, type TransformParam } from './transform-params.js'
import { TUPLE_MAKING_TRANSFORMS, transformTypeOf } from './transform-names.js'
import { guideReading, legendLayout, legendSizeExpression, type GuideEnv, type GuideKind } from './guide-model.js'
import { splitAccessPath, TextTable } from './util.js'
import { dataKey, expressionReads, unitIndexedIn } from './expr-reads.js'
import { follow, node, Propagation, type SignalNode } from './signal-propagation.js'
import { isSignalRef as isSignalObject, VIEW_SIGNALS, viewSignals } from './view-props.js'

type Rec = Record<string, unknown>

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const isObject = (v: unknown): v is Rec => v !== null && typeof v === 'object'

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

/**
 * The selectors seen lately and the expressions each one holds (the filters of its streams, in the order vega reads them): the same
 * few turn up in chart after chart. A selector that does not parse is not kept. `null` is the refusal's message.
 */
interface SelectorTexts { readonly texts: readonly string[] }
const selectors: Record<'view' | 'scope', TextTable<SelectorTexts>> = {
  view: new TextTable('view selectors', 1024, 1_000_000), scope: new TextTable('scope selectors', 1024, 1_000_000),
}

/** The text of an expression given as a value of any type: a string as it is, anything else as its JSON. */
const textOf = (v: unknown): string => (typeof v === 'string' ? v : stringValue(v) + '')

class Check {
  private scope = new Scope()
  /** the data sets the scope being read knows (see spec-structure.ts `Names`) */
  private names = new Names()

  /**
   * Where the spec makes a regular expression, in the order met (each an expression's text, or a transform that brings its own
   * pattern): what `limits.regex: 'refuse'` refuses it for (limits.ts `checkChartRegex`).
   */
  readonly regexSites: string[] = []
  /** The data sets an expression has vega index by `unit` (expr-reads.ts `unitIndexedIn`). */
  readonly unitIndexed = new Set<string>()

  constructor(private readonly config: Rec) {}

  // -- the view's dataflow graph: what reads what, for the cycle vega refuses (C145) ----------------------------------------
  //
  // vega builds the operators of the view's own scope, ranks them, and throws `Cycle detected in dataflow graph.` when connecting
  // one to what it reads would place it after itself (vega-dataflow `rerank`). Which cycles it finds depends on that order, not
  // on the shape of the graph alone (a handler takes its source's rank and is never re-ranked: `a` on `{signal: "a"}` is
  // accepted), so the walk records what vega-runtime builds and replays its ranking (`assertNoCycle`, with the event loop's own
  // ranking, signal-propagation.ts): the operators in the order vega-runtime makes them (the view's signals, its data sets,
  // scales, the expressions handlers follow, named marks), each then connected to what it reads (a signal with `react: false`
  // reads its sources without being among their targets), then the handlers of `{signal}` / `{scale}` sources, each following its
  // source and feeding its signal (what its update reads is a parameter that reacts to nothing). A group's scope is a subflow, whose cycle vega logs rather than
  // throws (the event loop does the same: signals.ts); handlers of event streams and data triggers are ranked after nothing.

  /** the operator whose definition is being read (null: none of the view's, or one whose reads are not ranked) */
  private owner: string | null = null
  /** the view's operators in the order vega-runtime makes them, by kind, and what each reads */
  private readonly made = { signal: [] as string[], data: [] as string[], scale: [] as string[], lambda: [] as string[], mark: [] as string[] }
  private readonly graph = new Map<string, Set<string>>()
  private readonly unreactive = new Set<string>()
  private readonly handlers: Array<{ source: string; target: string }> = []
  /** the owner of each lambda waiting to be read, per list (a `{signal}` property is read last, for the operator it belongs to) */
  private readonly lambdaOwners = new WeakMap<string[], Array<string | null>>()

  private edge(source: string, target: string): void {
    if (this.scope.isGroup) return
    let s = this.graph.get(target)
    if (!s) this.graph.set(target, (s = new Set()))
    s.add(source)
  }
  private make(kind: keyof Check['made'], id: string): void {
    if (this.scope.isGroup) return
    const list = this.made[kind]
    if (!list.includes(id)) list.push(id)
  }
  /** Read `fn` as part of the definition of `owner`. */
  private as<T>(owner: string | null, fn: () => T): T {
    const outer = this.owner
    this.owner = this.scope.isGroup ? null : owner
    try { return fn() } finally { this.owner = outer }
  }
  /** The view's signals and the data sets an expression reads (expr-reads.ts); none when it does not parse (it is refused anyway). */
  private readsOf(text: string): Set<string> {
    const out = new Set<string>()
    let reads: ReadonlySet<string>
    try { reads = expressionReads(text) } catch { return out }
    for (const id of reads) {
      if (id.startsWith('data:')) out.add(id)
      else if (this.scope.hasSignal(id)) out.add('signal:' + id)
    }
    return out
  }
  /** What the current owner reads in an expression. */
  private reads(text: string): void {
    if (this.owner === null) return
    for (const id of this.readsOf(text)) this.edge(id, this.owner)
  }
  private pushLambda(lambdas: string[], text: string): void {
    lambdas.push(text)
    let owners = this.lambdaOwners.get(lambdas)
    if (!owners) this.lambdaOwners.set(lambdas, (owners = []))
    owners[lambdas.length - 1] = this.owner
  }
  /** Replay vega's ranking of the view's operators; throw its error on the cycle it finds. */
  assertNoCycle(): void {
    if (!this.handlers.length && !this.graph.size) return
    const flow = new Propagation(() => {})
    const nodes = new Map<string, SignalNode>()
    const get = (id: string): SignalNode => {
      let n = nodes.get(id)
      if (!n) nodes.set(id, (n = flow.add(node(id))))
      return n
    }
    const { signal, data, scale, lambda, mark } = this.made
    const order = [...signal, ...data, ...scale, ...lambda, ...mark]
    for (const id of order) get(id)
    try {
      for (const id of order) {
        const n = get(id)
        const sources = [...(this.graph.get(id) ?? [])].map(get).filter((x) => x !== n)
        if (!this.unreactive.has(id)) for (const src of sources) follow(src, n)
        flow.connect(n, sources)
      }
      for (const h of this.handlers) {
        const source = get(h.source)
        // (vega-dataflow onOperator: the handler is ranked with its source, follows it, and feeds its signal; what its update reads
        // is a parameter made with `react: false`, which counts it among nobody's targets)
        const hn = node('handler')
        hn.order = source.order
        follow(source, hn)
        const target = get(h.target)
        follow(hn, target)
        flow.connect(target, [hn])
      }
    } catch (e) {
      throw new SpecParseError(e instanceof Error ? e.message : String(e), { cause: e })
    }
  }

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
    else {
      const text = textOf(value)
      if (checkExpression(text, this.isSignal)) this.regexSites.push(text)
      this.reads(text)
      if (text.includes('intersect')) for (const name of unitIndexedIn(text)) this.unitIndexed.add(name)
    }
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
    if (typeof signal === 'string' && signal && !skip.has('signal')) {
      if (this.scope.hasSignal(signal)) { if (this.owner !== null) this.edge('signal:' + signal, this.owner) } else this.pushLambda(out, signal)
    }
    for (const key of Object.keys(node)) if (!skip.has(key)) this.lambdas(node[key], out, NONE, depth + 1)
  }

  /** `scope.signalRef(name)`: a signal of the scope is itself, anything else an expression of its own, read last. */
  private signalRef(name: unknown, lambdas: string[]): void {
    const text = String(name)
    if (!this.scope.hasSignal(text)) this.pushLambda(lambdas, text)
    else if (this.owner !== null) this.edge('signal:' + text, this.owner)
  }

  flush(lambdas: string[]): void {
    const owners = this.lambdaOwners.get(lambdas) ?? []
    lambdas.forEach((text, i) => this.as(owners[i] ?? null, () => this.expression(text)))
    lambdas.length = 0
    this.lambdaOwners.delete(lambdas)
  }

  // -- a scope, in the order vega reads it -------------------------------------------------------------------------

  /** The view: its signals (the five of every view, the spec's, the config's) are known to all its expressions. */
  view(spec: Rec, config: Rec): void {
    const lambdas: string[] = []
    const signals = viewSignals(spec, config)
    for (const name of VIEW_SIGNALS) this.scope.addSignal(name)
    this.declare(signals)
    for (const sig of signals) if (sig.push !== 'outer') this.make('signal', 'signal:' + String(sig.name))
    // vega-parser parseView: the legends' layout of the config, the view's own encode, its layout; then the rest of the spec (C284)
    this.objectProperty(isRecord(config.legend) ? config.legend.layout : undefined, lambdas)
    this.encode(spec.encode)
    this.objectProperty(spec.layout, lambdas)
    this.contents(spec, signals, lambdas)
    this.flush(lambdas)
    // the view registers its own root item last
    this.names.declare('root')
    // (vega ranks the view's operators when it builds the view, after its parser has read every expression)
    this.assertNoCycle()
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
      if (isRecord(s)) {
        this.make('scale', 'scale:' + String(s.name))
        this.as('scale:' + String(s.name), () => this.scaleDefinition(s, lambdas))
      }
    }
    for (const s of signals) this.signal(s, lambdas)
    this.guidesAndMarks(spec, lambdas)
  }

  private scaleDefinition(s: Rec, lambdas: string[]): void {
    {
      // (vega-parser parseScaleBins: an object of bins is one expression, written out with its signals in it)
      const bins = isRecord(s) ? s.bins : undefined
      if (isRecord(bins) && !bins.signal) {
        this.lambdas(s, lambdas, BINS)
        this.objectProperty(bins, lambdas)
      } else this.lambdas(s, lambdas)
    }
  }

  private guidesAndMarks(spec: Rec, lambdas: string[]): void {
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
    this.make('data', 'data:' + String(d.name))
    this.as('data:' + String(d.name), () => this.datasetDefinition(d, lambdas))
  }

  private datasetDefinition(d: Rec, lambdas: string[]): void {
    for (const t of specList(d.transform)) if (isRecord(t)) this.transform(t, lambdas)
    // (a trigger is an operator of its own that pulses the data set when it runs: nothing reads it)
    for (const on of specList(d.on)) if (isRecord(on)) this.as(null, () => this.trigger(on, String(d.name)))
    // vega-parser analyze: a data set's url, async, values and format are read only when it has a dynamic loader (its values or
    // its url is a signal, or its format holds one); a source data set, or a static one, reads none of them
    const values = dataWithoutRows(d).values
    if (d.values ? isSignalObject(d.values) || holdsSignal(d.format) : d.url ? holdsSignal(d.url) || holdsSignal(d.format) : false) {
      for (const v of [d.url, d.async, values]) if (isRecord(v) && v.signal) this.signalRef(v.signal, lambdas)
      this.objectProperty(d.format, lambdas)
    }
    if (dataInputOf(d) === 'source') {
      for (const source of specList(d.source)) {
        need(this.names, source)
        if (this.owner !== null) this.edge(dataKey(String(source)), this.owner)
      }
    }
    this.names.declare(d.name)
  }

  /** `parseTransform`: the parameters in the order of the definition, each read whole; then the transform's own signal. */
  private transform(t: Rec, lambdas: string[]): void {
    this.parameters(t, transformParams(t.type), lambdas)
    // countpattern makes its own regular expressions of `pattern` and `stopwords` (an absent or empty one is the engine's
    // fixed default, which is not the spec's: transform-stats.ts)
    if (transformTypeOf(t.type) === 'countpattern') {
      for (const k of ['pattern', 'stopwords'] as const) if (t[k]) this.regexSites.push(`countpattern ${k}`)
    }
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
        if (this.owner !== null) this.edge(dataKey(owner.from), this.owner)
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
        for (const name of p.list ? (value as unknown[]) : [value]) {
          if (isSignalObject(name)) continue
          need(this.names, name)
          if (this.owner !== null) this.edge(dataKey(String(name)), this.owner)
        }
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
      // (`react: false`: the signal reads its sources, but they do not count it among their targets)
      if (s.react === false && !this.scope.isGroup) this.unreactive.add('signal:' + String(s.name))
      if (expr) this.as('signal:' + String(s.name), () => this.expression(expr))
    }
    if (Array.isArray(s.on)) s.on.forEach((h, i) => this.handler(h, lambdas, String(s.name), i))
  }

  /** One entry of a signal's `on`: vega-parser's `parseUpdate`. */
  private handler(h: unknown, lambdas: string[], target = '', index = 0): void {
    if (!isRecord(h)) return
    // a handler of an operator (a signal, a scale) is an operator itself: it follows its source and writes its signal (vega-dataflow
    // `on`); one of event streams is not ranked
    void index
    this.as(null, () => this.handlerBody(h, lambdas))
    if (this.scope.isGroup || typeof h.events === 'string') return
    // vega-parser parseUpdate: several operators are one expression (`[a, scale("x")]`), one is the signal it names, the scale,
    // or the expression it is (an operator of its own, made after the data sets and scales)
    const operators = specList(h.events).filter((e): e is Rec => isRecord(e) && !!(e.signal || e.scale))
    if (!operators.length) return
    let source: string
    if (operators.length > 1) {
      const text = '[' + operators.map((o) => (o.scale ? 'scale("' + (o.scale as string) + '")' : (o.signal as string))).join(',') + ']'
      source = 'lambda:' + text
      this.make('lambda', source)
      for (const id of this.readsOf(text)) this.edge(id, source)
      for (const o of operators) if (o.scale) this.edge('scale:' + String(o.scale), source)
    } else if (operators[0]!.scale) source = 'scale:' + String(operators[0]!.scale)
    else {
      const text = String(operators[0]!.signal)
      if (this.scope.hasSignal(text)) source = 'signal:' + text
      else {
        source = 'lambda:' + text
        this.make('lambda', source)
        for (const id of this.readsOf(text)) this.edge(id, source)
      }
    }
    this.handlers.push({ source, target: 'signal:' + target })
  }

  private handlerBody(h: Rec, lambdas: string[]): void {
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
      // vega-parser update.js: the handler's update is `encode(item(), <set>)` (encode-handlers.ts)
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
      // (an empty merge makes no stream: vega fails on it as it builds the view, `reading 'merge'` of nothing; refused here, C629)
      if (!Array.isArray(s.merge) || s.merge.length === 0) throw new SpecParseError('Invalid stream specification: ' + stringValue(stream))
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
    // (a parameter of the guide's data vega looks up in the config when the guide has none: see CONFIG_VALUES)
    const fromConfig = kind === 'axis' || kind === 'legend'
      ? CONFIG_VALUES[kind].filter((key) => g[key] == null).map((key) => [key, kind === 'axis' ? axisValue(g, key, (name) => this.scope.scaleType(name), this.config)
        : isRecord(this.config.legend) ? this.config.legend[key] : undefined] as const).filter(([, v]) => isObject(v))
      : []
    if (!fromConfig.length && !keys.some((key) => key !== 'scale' && isObject(g[key]))) return
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
    for (const [key, v] of fromConfig) if (reading(key) === 'value') this.lambdas(v, lambdas)
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
    if (holdsSignal(value)) this.pushLambda(lambdas, propertyLambda(value))
  }

  /** `parseMark`, in the order its parts are read: interactivity and clip, the encode sets, the transforms, the sort, the layout, the content of a group, the triggers. */
  private mark(m: Rec, lambdas: string[]): void {
    // a named mark of the view is a data set (its items) that expressions can read: it reads what its definition reads
    if (m.name != null) this.make('mark', dataKey(String(m.name)))
    this.as(m.name != null ? dataKey(String(m.name)) : null, () => this.markDefinition(m, lambdas))
  }

  private markDefinition(m: Rec, lambdas: string[]): void {
    if (this.owner !== null && isRecord(m.from) && typeof m.from.data === 'string') this.edge(dataKey(m.from.data), this.owner)
    const group = m.type === 'group'
    const facet = isRecord(m.from) && isRecord(m.from.facet) ? m.from.facet : undefined
    checkFrom(m.from, group, this.names)
    // vega-parser parseData: a facet with no data of its own aggregates its data set by its groupby, the facet's `aggregate` being
    // that transform's parameters (`fields`, `ops`, `as`, `cross`: any of them a signal); then its keys (C126)
    if (facet !== undefined && facet.field == null && !(isRecord(m.from) && m.from.data)) {
      this.transform({ type: 'aggregate', groupby: specList(facet.groupby), ...(isRecord(facet.aggregate) ? facet.aggregate : {}) }, lambdas)
    }
    if (facet !== undefined) this.facetKeys(facet, lambdas)
    this.lambdas(m.interactive, lambdas)
    this.clip(m.clip, lambdas)
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
    // a named mark's triggers are read last, in the scope the mark is in; a mark only takes `modify` triggers
    if (m.name != null) {
      for (const on of specList(m.on)) {
        if (!isRecord(on)) continue
        if (on.insert || on.remove || on.toggle) throw new SpecParseError('Marks only support modify triggers.')
        this.trigger(on, String(m.name))
      }
    }
  }

  /**
   * The keys of a facet: `field` (vega-parser `fieldRef`: a name or a `{signal}`) and `groupby` (`keyRef`: names and `{signal}`s).
   * A field written `{expr}` is refused with vega's message; vega's `keyRef` takes an `{expr}` in `groupby` too and fails on it
   * as it writes its code, which the same refusal stands for. A `{signal}` whose text names no signal is an expression of its own
   * (vega fails on it as well: it is read, and evaluated, here).
   */
  private facetKeys(facet: Rec, lambdas: string[]): void {
    const key = (ref: unknown): void => {
      if (isRecord(ref) && ref.signal) { this.signalRef(ref.signal, lambdas); return }
      if (isObject(ref)) throw new SpecParseError('Unsupported field reference: ' + stringValue(ref))
    }
    if (facet.field != null) key(facet.field)
    else for (const ref of specList(facet.groupby)) key(ref)
  }

  /** vega-parser `clip`: a `{signal}`, or a clip path or sphere written into the call that draws it (`pathShape(...)`, `geoShape(...)`). */
  private clip(clip: unknown, lambdas: string[]): void {
    if (!isRecord(clip)) return
    const param = (v: unknown): string => (isRecord(v) && v.signal ? `${v.signal as string}` : stringValue(v))
    const expr = clip.signal ? `${clip.signal as string}` : clip.path ? 'pathShape(' + param(clip.path) + ')' : clip.sphere ? 'geoShape(' + param(clip.sphere) + ', {type: "Sphere"})' : undefined
    if (expr !== undefined) this.signalRef(expr, lambdas)
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
        // (a channel is written onto the item under its own name: none may name the engine's own slots, item-slots.ts)
        if (isEngineSlot(channel)) throw new SpecParseError(engineSlotMessage(channel, `encode block "${key}"`))
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
const BINS: ReadonlySet<string> = new Set(['bins'])
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
  if (!Array.isArray(node) && (node.signal || node.test || node.gradient != null || node.color || writesText(node))) return true
  for (const key of Object.keys(node)) if (holdsExpression(node[key], depth + 1)) return true
  return false
}

/**
 * Whether an entry pastes a property into its code as text (vega's `property`: anything but an object goes in as it is written), so
 * the code may not parse (`offset: "1+"`) or name a signal that is not there (`band: "abc"`).
 */
function writesText(e: Rec): boolean {
  const raw = (p: unknown): boolean => p != null && !isObject(p) && typeof p !== 'number'
  return raw(e.exponent) || raw(e.mult) || raw(e.offset) || (e.scale != null && e.range == null && Boolean(e.band) && +(e.band as number) !== 1 && raw(e.band))
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

/** A property (`exponent`, `mult`, `offset`, `band`) as vega writes it: an object (a list too) is an entry in parentheses, anything else its text. */
const propertyText = (p: unknown): string | null => (isObject(p) ? (() => { const t = entryText(p); return t === null ? null : `(${t})` })() : `${p as string}`)

/**
 * A colour object's call (`(rgb(r,g,b)+'')`): each part is an entry, and an entry with no value is vega's `null`, which its list
 * of arguments writes as nothing (`rgb(,0,0)`, a parse error, as in vega). A part that is not there fails as vega's parser does.
 */
const colorText = (type: string, parts: unknown[]): string | null => {
  const texts: string[] = []
  for (const p of parts) {
    if (p == null) throw new TypeError(`Cannot read properties of ${p === null ? 'null' : 'undefined'} (reading 'gradient')`)
    const t = entryCode(p)
    if (t === null) return null
    texts.push(t === VNULL ? '' : t)
  }
  return `(${type}(${texts.join(',')})+'')`
}

/** The expression vega builds for an entry (null: for one it would refuse in another way, which is not this check's). */
/** The parameters of a guide's data vega looks up in the config too (`_(name)`); `tickMinStep`, `tickCount`, `values` it reads off the guide alone. */
const CONFIG_VALUES: Readonly<Record<'axis' | 'legend', readonly string[]>> = {
  axis: ['labelBound', 'labelOverlap', 'labelSeparation', 'tickExtra'],
  legend: ['symbolLimit'],
}

export function entryText(spec: unknown): string | null {
  const code = entryCode(spec)
  return code === VNULL ? 'null' : code
}

/** vega's `null` as the code of an entry: the value null, which a template writes as `null` and a list of arguments as nothing. */
const VNULL = Symbol('null')

/** vega-parser encode/entry.js `entry`: the code of an entry, `VNULL` where vega's is the value `null`, `null` as for `entryText`. */
function entryCode(spec: unknown): string | null | typeof VNULL {
  // (vega reads the keys of whatever it is given: anything but an object with them gives no value)
  if (!isObject(spec)) return VNULL
  const e = spec as Rec
  if (e.gradient != null) {
    const args: Array<string | null> = [e.start, e.stop, e.count].map((v) => (v == null ? null : stringValue(v)))
    while (args.length && args[args.length - 1] == null) args.pop()
    const scale = scaleText(e.gradient)
    return scale === null ? null : `gradient(${[scale, ...args].join(',')})`
  }
  let value: string | null | typeof VNULL | undefined
  if (e.signal) value = `(${e.signal as string})`
  else if (e.color) {
    const c = e.color as Rec
    value = c.c ? colorText('hcl', [c.h, c.c, c.l]) : c.h || c.s ? colorText('hsl', [c.h, c.s, c.l]) : c.l || c.a ? colorText('lab', [c.l, c.a, c.b]) : c.r || c.g || c.b ? colorText('rgb', [c.r, c.g, c.b]) : VNULL
  } else if (e.field != null) value = fieldText(e.field)
  else if (e.value !== undefined) value = stringValue(e.value)
  if (value === null) return null
  const text = (v: string | typeof VNULL): string => (v === VNULL ? 'null' : v)
  if (e.scale != null) {
    const scale = scaleText(e.scale)
    if (scale === null) return null
    if (e.range != null) value = `lerp(_range(${scale}), ${+(e.range as number)})`
    else {
      if (value !== undefined) value = `_scale(${scale}, ${text(value)})`
      if (e.band) {
        const band = +(e.band as number) === 1 ? '' : propertyText(e.band)
        if (band === null) return null
        value = (typeof value === 'string' && value ? value + '+' : '') + `_bandwidth(${scale})` + (band === '' ? '' : '*' + band)
        if (e.extra) value = `(datum.extra ? _scale(${scale}, datum.extra.value) : ${value})`
      }
      if (value === undefined) value = '0'
    }
  }
  if (value === undefined) value = VNULL
  for (const [key, wrap] of [['exponent', (v: string, p: string) => `pow(${v},${p})`], ['mult', (v: string, p: string) => `${v}*${p}`], ['offset', (v: string, p: string) => `${v}+${p}`]] as const) {
    if (e[key] == null) continue
    const p = propertyText(e[key])
    if (p === null) return null
    value = wrap(text(value), p)
  }
  if (e.round) value = `round(${text(value)})`
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
/** Check every expression of `spec` (see the file header); returns where it makes regular expressions (`Check.regexSites`). */
export function checkExpressions(spec: Rec, config: Rec = {}): readonly string[] {
  return checkSpecExpressions(spec, config).regexSites
}

/** Check every expression of `spec`; what the walk found: the regular expressions it makes, the data sets it indexes by unit. */
export function checkSpecExpressions(spec: Rec, config: Rec = {}): { regexSites: readonly string[]; unitIndexed: readonly string[] } {
  const check = new Check(config)
  check.view(spec, config)
  return { regexSites: check.regexSites, unitIndexed: [...check.unitIndexed] }
}

/** vega-parser's `propertyLambda`: an object or array written out as an expression, a `{signal}` in it standing for its text. */
function propertyLambda(spec: unknown): string {
  const part = (v: unknown): string => (isObject(v) ? (typeof v.signal === 'string' && v.signal ? v.signal : !Array.isArray(v) && v.signal ? String(v.signal) : propertyLambda(v)) : stringValue(v))
  if (Array.isArray(spec)) return '[' + spec.map((v, i) => (i > 0 ? ',' : '') + part(v)).join('') + ']'
  const o = spec as Rec
  return '{' + Object.keys(o).map((k, i) => (i > 0 ? ',' : '') + stringValue(k) + ':' + part(o[k])).join('') + '}'
}
