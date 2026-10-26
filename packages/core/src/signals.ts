/**
 * Event-driven signals: the signal-update event loop.
 *
 * A port of the parts of vega that turn DOM events into signal updates:
 * vega-event-selector (selector strings, see event-selector.ts), vega-parser's
 * stream/update parsing (marktype/markname filters, `between`, throttle,
 * debounce, `consume`, merged streams, `{signal}` sources), vega-runtime's stream
 * graph, vega-dataflow's EventStream and `on`, and vega-view's event plumbing
 * (`event.item`, `event.vega.{view,item,group,xy,x,y}`, window / CSS-selector / timer
 * sources).
 *
 * Semantics worth knowing (all verified against the pinned vega in the
 * real-browser parity test, packages/conformance/scripts/browser-signals.mts):
 *
 * - `event` in an update/filter expression is the NATIVE event, extended with
 *   `item`, `vega` and `dataflow` exactly as vega-view does -- `event.deltaY`,
 *   `event.shiftKey`, ... are the browser's own values.
 * - `datum` in an update is `event.item.datum`.
 * - A handler runs only when ITS stream matched. A signal's static `update`
 *   re-runs only when a signal it references changed (not on every event).
 * - A value is stored when it differs (`!==`) from the current one, or when the
 *   entry says `force`; a handler returning a fresh array/object always counts
 *   as a change, like vega's operator `set`.
 * - An error while a native event is processed (a filter or update expression
 *   throwing) is reported to the logger and abandons the rest of THAT event's
 *   delivery; updates already applied stand, and the loop carries on. Selector
 *   and expression errors are found when the handlers are bound and reported
 *   then (logger.error); the handler is not bound. Nothing escapes the DOM
 *   listener and nothing is swallowed silently.
 *
 * The host (React `<Chart>`, or any embedder) calls `bindSceneSignals` on the
 * rendered SVG and re-renders when `onSignal` fires.
 */
import type { CompiledChart, CompiledData, CompiledSignalDef, SceneGroup, SceneItem, SceneNode, SceneRoot, SignalOnDef } from './types.js'
import { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import { applyChangeset, newChangeset, planModify, type Changeset } from './modify.js'
import { valuesEqual } from './fingerprint.js'
import { parseExpression, type AstNode } from './expr-parser.js'
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import { dict, ownGet, setOwn, TUPLE_ID } from './util.js'
import { consoleLogger, type Logger } from './logger.js'

export interface BoundEvent {
  event: string
  handler: (evt: Event) => void
  el: EventTarget
}

/** The vega-style event context: view coords + the targeted mark's datum. */
export interface EventContext {
  /** x/y in view coordinates (page coords minus the chart origin). */
  x: number
  y: number
  /** The raw DOM event. */
  native: Event
  /** The mark datum under the pointer, if any. */
  datum?: Record<string, unknown>
}

/** What `pick` / the DOM fallback resolve an event position to: a scene item and where it sits. */
export interface PickedItem {
  /** The scene item (`datum`, `x`, `y`, ...). */
  item: object
  /** The mark type of the mark the item belongs to (`rect`, `symbol`, `group`, ...). */
  marktype?: string
  /** The mark's `name`. */
  name?: string
  /** The mark's `role`. */
  role?: string
  /** The enclosing group item (vega's `item.mark.group`). */
  group?: PickedItem | null
}

export interface SignalEventHooks {
  /** Called once per signal that changed while an event (or `setSignal`) was processed. */
  onSignal?: (name: string, value: unknown, all: Record<string, unknown>) => void
  /**
   * Called once per dataset that `modify(...)` edited while an event (or `setSignal`) was processed, with the
   * dataset's input rows afterwards. The host keeps them and hands them back as `data[name]` to the next
   * evaluation (and as `SignalBindOptions.data` when it binds again): that evaluation is then the scene vega
   * would show, the dataset being an input like any other (selection stores are datasets).
   */
  onData?: (name: string, rows: unknown[]) => void
  /**
   * Where errors and warnings go (vega's logger): a bad selector or expression is
   * reported at bind time, an expression that throws while an event is processed
   * is reported when it happens. Default: the console.
   */
  logger?: Logger
  /**
   * Call `preventDefault()` on events of the `view` source before handling them
   * (vega's `view.preventDefault()`, default false). `consume` always prevents.
   */
  preventDefault?: boolean
}

export interface SignalBindOptions {
  originX?: number
  originY?: number
  /**
   * Resolve a view-space position (page coords minus the svg origin, padding
   * included) to the scene item under it -- `buildHitIndex(scene).query` from
   * `@aster/core/hit` fits. Without it `event.item` is recovered from the DOM
   * (the `data-datum` stamp and the `mark-*`/`role-*` classes).
   */
  pick?: (x: number, y: number) => { item: object; marktype?: string } | null
  /** The scene, so a picked item's enclosing groups and mark name/role can be found. */
  scene?: SceneRoot
  /**
   * The input rows of the datasets as the evaluation was given them (`RuntimeInput.data`), so a dataset the
   * host has edited through `onData` is continued from where it stands. A dataset not named here starts
   * from the rows written in the spec.
   */
  data?: Record<string, unknown[]>
}

export interface SignalBinding {
  detach: () => void
  /** Manually set a signal (the imperative path, e.g. brush props). */
  setSignal: (name: string, value: unknown) => void
}

/**
 * The event types a selector string (or event-stream object / array of them)
 * listens to, in vega's grammar: `parseEventSelector('mousemove, click')` is
 * `['mousemove', 'click']`. Throws on a malformed selector.
 */
export function parseEventSelector(selector: unknown): string[] {
  const out: string[] = []
  const visit = (d: StreamDef): void => {
    if (d.merge) d.merge.forEach(visit)
    else if (d.stream) visit(d.stream)
    else if (typeof d.type === 'string') out.push(d.type)
  }
  const defs = typeof selector === 'string' ? parseEventSelectorString(selector, 'view') : normalizeEvents(selector).streams
  defs.forEach(visit)
  return out
}

// --- event streams ---------------------------------------------------------

interface ExtEvent extends Event {
  item?: object
  vega?: unknown
  dataflow?: unknown
}

/** Per-stream state that must survive a re-bind (hosts re-bind after every render). */
interface StreamState {
  active: boolean
  last: number
  tid: ReturnType<typeof setTimeout> | null
  evt: ExtEvent | null
  /** Delivers a debounced event into the CURRENT binding (null while unbound). */
  deliver: ((e: ExtEvent) => void) | null
}

const persisted = new WeakMap<EventTarget, Map<string, StreamState>>()

function stateFor(owner: EventTarget, key: string): StreamState {
  let m = persisted.get(owner)
  if (!m) persisted.set(owner, (m = new Map()))
  let st = m.get(key)
  if (!st) m.set(key, (st = { active: false, last: -1, tid: null, evt: null, deliver: null }))
  return st
}

class Stream {
  targets: Stream[] = []
  consume = false
  filterFn: ((e: ExtEvent) => boolean) | null = null
  /** Overrides receive (between's marker streams, debounce). */
  recv: ((e: ExtEvent) => void) | null = null

  receive(e: ExtEvent): void {
    if (this.recv) return this.recv(e)
    if (this.filterFn && !this.filterFn(e)) return
    for (let i = 0; i < this.targets.length; ++i) this.targets[i]!.receive(e)
    if (this.consume) {
      e.preventDefault?.()
      e.stopPropagation?.()
    }
  }
}

/** vega-dataflow EventStream.filter / apply: a downstream stream fed by this one. */
function filtered(src: Stream, f: ((e: ExtEvent) => boolean) | null): Stream {
  const s = new Stream()
  s.filterFn = f
  src.targets.push(s)
  return s
}

function mergeStreams(first: Stream, rest: Stream[]): Stream {
  const s = new Stream()
  first.targets.push(s)
  for (const r of rest) r.targets.push(s)
  return s
}

// --- selector / stream-spec normalisation -----------------------------------

interface OperatorSource { signal?: string; scale?: string }

/** vega-parser update.js: a string is a selector; otherwise an array of stream objects and operator sources. */
function normalizeEvents(events: unknown): { streams: StreamDef[]; sources: OperatorSource[] } {
  if (events == null) throw new Error('Signal update missing events specification.')
  const list: unknown[] = typeof events === 'string' ? parseEventSelectorString(events, 'view') : Array.isArray(events) ? events : [events]
  const streams: StreamDef[] = []
  const sources: OperatorSource[] = []
  for (const s of list) {
    const o = s as OperatorSource | null
    if (o && typeof o === 'object' && (o.signal || o.scale)) sources.push(o)
    else streams.push(s as StreamDef)
  }
  return { streams, sources }
}

/** vega-parser filterMark. */
function markFilter(def: { marktype?: string; markname?: string; markrole?: string }): string {
  const item = 'event.item'
  return item
    + (def.marktype && def.marktype !== '*' ? '&&' + item + ".mark.marktype==='" + def.marktype + "'" : '')
    + (def.markrole ? '&&' + item + ".mark.role==='" + def.markrole + "'" : '')
    + (def.markname ? '&&' + item + ".mark.name==='" + def.markname + "'" : '')
}

/** The filter expression text vega-parser's streamParameters builds (or null). */
function filterCode(def: StreamDef & { markrole?: string }): string | null {
  const param: string[] = def.filter ? ([] as string[]).concat(def.filter) : []
  if (def.marktype || def.markname || def.markrole) param.push(markFilter(def))
  if (def.source === 'scope') param.push('inScope(event.item)')
  return param.length ? '(' + param.join(')&&(') + ')' : null
}

// --- expression helpers ------------------------------------------------------

/** The functions that read a dataset by the name in their first argument (vega-functions' dataVisitor / selectionVisitor). */
const DATA_READERS = new Set(['data', 'indata', 'vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])

/** The key under which an expression's dependence on the dataset `name` is tracked next to its signal names. */
const dataKey = (name: string): string => `data:${name}`

/** The identifiers an expression reads (signal references, among them), and `data:NAME` for every dataset it reads. */
function identifiersOf(code: string): Set<string> {
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
  visit(parseExpression(code))
  return out
}

// --- the binding -------------------------------------------------------------

type Update = { kind: 'expr'; code: string } | { kind: 'value'; value: unknown } | { kind: 'signal'; name: string }

function updateOf(on: SignalOnDef): Update {
  const u = on.update
  if (typeof u === 'string') return { kind: 'expr', code: u }
  if (u && typeof u === 'object') {
    if (u.expr != null) return { kind: 'expr', code: u.expr }
    if (u.value != null) return { kind: 'value', value: u.value }
    if (u.signal != null) return { kind: 'signal', name: u.signal }
  }
  throw new Error('Invalid signal update specification.')
}

/**
 * Bind every `signal.on` event stream in the compiled chart to DOM events on
 * `svg` (and `window` / CSS-selected elements / timers for those sources). See
 * the file header for the semantics. Returns a binding with `detach` + an
 * imperative `setSignal`.
 */
export function bindSignalEvents(
  svg: SVGSVGElement,
  chart: CompiledChart,
  runtime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: SignalBindOptions = {},
): SignalBinding {
  return bindSignalEventsDefs(svg, chart.signalDefs ?? [], chart.data ?? [], runtime, signalParams, signals, hooks, opts)
}

function bindSignalEventsDefs(
  svg: SVGSVGElement,
  defs: CompiledSignalDef[],
  dataDefs: CompiledData[],
  sceneRuntime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks,
  opts: SignalBindOptions,
): SignalBinding {
  const logger: Logger = hooks.logger ?? consoleLogger
  const originX = opts.originX ?? 0
  const originY = opts.originY ?? 0
  const detachFns: Array<() => void> = []
  const rootStreams = new Map<string, Stream>()
  /** Signal-source handlers: run when a signal they reference changes. */
  const signalHandlers: Array<{ deps: Set<string>; run: () => void }> = []
  const fail = (what: string, e: unknown): void => logger.error(`signal event handler${what}: ${e instanceof Error ? e.message : String(e)}`)

  // ---- datasets the handlers edit (`modify`) -------------------------------------------------
  // A dataset an event handler modifies lives here, as its input rows; the rest of the datasets are the
  // scene's. The transformed rows are what `data()` shows the handlers meanwhile.
  const datasets = new Map(dataDefs.map((d) => [d.name, d]))
  const inputRows = new Map<string, Array<Record<string, unknown>>>()
  const liveRows = new Map<string, unknown[]>()
  const rawOf = (name: string): Array<Record<string, unknown>> =>
    inputRows.get(name) ?? (opts.data?.[name] as Array<Record<string, unknown>> | undefined) ?? (datasets.get(name)?.values as Array<Record<string, unknown>> | undefined) ?? []
  const dataOf = (name: string): unknown[] | undefined => {
    const raw = inputRows.get(name)
    if (!raw) return sceneRuntime.data(name)
    let rows = liveRows.get(name)
    if (!rows) liveRows.set(name, (rows = sceneRuntime.transformed ? sceneRuntime.transformed(name, raw) : raw))
    return rows
  }

  // ---- the transaction: one native event (or setSignal) is one "run" ----------
  let txn: { changed: string[]; pending: Map<string, Changeset>; edited: Set<string> } | null = null

  /** vega-functions modify.js: queue the edit; it is applied when the pass that asked for it has finished. */
  const modifyData = (name: string, insert: unknown, remove: unknown, toggle: unknown, modifyTuple: unknown, values: unknown): number => {
    if (!datasets.has(name)) throw new Error(`Cannot modify the unknown data set "${name}"`)
    if (!txn) throw new Error('modify() is only available while an event is being handled')
    const t = txn
    return planModify(rawOf(name), () => {
      let cs = t.pending.get(name)
      if (!cs) t.pending.set(name, (cs = newChangeset()))
      return cs
    }, insert, remove, toggle, modifyTuple, values)
  }
  /** Pulse the queued edits into their datasets (vega: `df.runAfter(() => df.pulse(input, changes).run())`). */
  const applyEdits = (): string[] => {
    if (!txn || txn.pending.size === 0) return []
    const touched: string[] = []
    for (const [name, cs] of txn.pending) {
      inputRows.set(name, applyChangeset(rawOf(name), cs))
      liveRows.delete(name)
      txn.edited.add(name)
      touched.push(name)
    }
    txn.pending.clear()
    return touched
  }

  // The runtime the handlers' expressions run in: the scene's, with the datasets as edited and `modify`.
  const bindRuntime: ExpressionRuntime = {
    ...sceneRuntime,
    data: dataOf,
    modify: modifyData,
    expr: (code) => compile(code),
  }
  const compiledExprs = new Map<string, CompiledExpr>()
  const compile = (code: string): CompiledExpr => {
    let f = compiledExprs.get(code)
    if (!f) compiledExprs.set(code, (f = compileExpr(code, bindRuntime)))
    return f
  }
  const runtime = bindRuntime

  /** The current value: the host's store wins, the evaluated scene's value is the baseline. */
  const read = (name: string): unknown => (Object.hasOwn(signals, name) ? signals[name] : ownGet(signalParams, name))
  const params = (): Record<string, unknown> => dict(signalParams, signals)

  const markChanged = (name: string): void => {
    if (txn && !txn.changed.includes(name)) txn.changed.push(name)
  }
  /** vega Dataflow.update: store the value when it differs (reference) or is forced. */
  const update = (name: string, value: unknown, force: boolean): void => {
    if (!force && read(name) === value) return
    setOwn(signals, name, value)
    markChanged(name)
  }

  const derived = defs.filter((d) => typeof d.update === 'string').map((d) => {
    let deps = new Set<string>()
    try { deps = identifiersOf(d.update!) } catch { /* an unparsable update is reported when it evaluates */ }
    return { def: d, deps }
  })

  const cascade = (): void => {
    if (!txn) return
    // edits the first pass queued are applied now, and what reads those datasets runs again
    let frontier = new Set([...txn.changed, ...applyEdits().map(dataKey)])
    // acyclic in a valid spec; the bound keeps a cyclic one finite
    for (let round = 0; round <= defs.length && frontier.size > 0; ++round) {
      const next = new Set<string>()
      for (const { def, deps } of derived) {
        if (![...deps].some((n) => frontier.has(n))) continue
        try {
          const v = runtime.expr(def.update!)(undefined, params())
          if (!valuesEqual(v, read(def.name))) {
            setOwn(signals, def.name, v)
            markChanged(def.name)
            next.add(def.name)
          }
        } catch (e) {
          fail(` (update of "${def.name}")`, e)
        }
      }
      for (const h of signalHandlers) {
        if (![...h.deps].some((n) => frontier.has(n))) continue
        const before = txn.changed.length
        h.run()
        for (let i = before; i < txn.changed.length; ++i) next.add(txn.changed[i]!)
      }
      for (const name of applyEdits()) next.add(dataKey(name))
      frontier = next
    }
  }

  /** Run `fn` as one dataflow run: errors are logged (vega: Dataflow.error), then dependents settle and hooks fire. */
  const run = (fn: () => void): void => {
    if (txn) {
      try { fn() } catch (e) { fail('', e) }
      return
    }
    txn = { changed: [], pending: new Map(), edited: new Set() }
    try {
      try { fn() } catch (e) { fail('', e) }
      cascade()
    } finally {
      const { changed, edited } = txn
      txn = null
      for (const name of edited) hooks.onData?.(name, inputRows.get(name)!)
      for (const name of changed) hooks.onSignal?.(name, read(name), signals)
    }
  }

  // ---- event extension (vega-view events-extend.js) ----------------------------
  const viewFacade = {
    signal: (name: string) => read(name),
    width: () => svg.clientWidth,
    height: () => svg.clientHeight,
  }
  const pointOf = (e: ExtEvent): [number, number] => {
    const t = (e as unknown as { changedTouches?: ArrayLike<{ clientX: number; clientY: number }> }).changedTouches
    const src = t ? t[0]! : (e as unknown as { clientX: number; clientY: number })
    const rect = svg.getBoundingClientRect()
    return [src.clientX - rect.left - (svg.clientLeft || 0) - originX, src.clientY - rect.top - (svg.clientTop || 0) - originY]
  }
  const sceneInfo = opts.scene ? sceneIndex(opts.scene) : null

  const resolveItem = (e: ExtEvent): object | undefined => {
    let picked: PickedItem | null | undefined
    if (opts.pick) {
      const p = pointOf(e)
      const hit = opts.pick(p[0] + originX, p[1] + originY)
      picked = hit ? { marktype: hit.marktype, ...hit } as PickedItem : null
      if (picked && sceneInfo) picked = sceneInfo.describe(picked)
    }
    // no picker, or it found nothing under the pointer (e.g. no layout): what the DOM under the event says
    if (!picked) picked = domPick(svg, e.target)
    return picked ? itemFacade(picked) : undefined
  }

  const extend = (e: ExtEvent, withItem: boolean): ExtEvent => {
    const point = pointOf(e)
    const item = withItem ? resolveItem(e) : undefined
    const itemGroup = item
      ? (item as { mark: { marktype: string; group: object | null } }).mark.marktype === 'group' ? item : (item as { mark: { group: object | null } }).mark.group
      : null
    const group = (name?: string): object => {
      let g = itemGroup as { mark?: { interactive?: boolean } } | null
      if (name) {
        for (let i = item as { mark: { name?: string; group: object | null } } | null | undefined; i; i = i.mark.group as typeof i) {
          if (i.mark.name === name) { g = i as never; break }
        }
      }
      return g && g.mark && g.mark.interactive ? g : {}
    }
    const xy = (it?: unknown): [number, number] => {
      if (!it) return point
      if (typeof it === 'string') it = group(it)
      const p: [number, number] = [point[0], point[1]]
      let cur = it as { x?: number; y?: number; mark?: { group?: unknown } } | null
      while (cur) {
        p[0] -= cur.x || 0
        p[1] -= cur.y || 0
        cur = (cur.mark && cur.mark.group) as typeof cur
      }
      return p
    }
    const vega = { view: () => viewFacade, item: () => item || {}, group, xy, x: (it?: unknown) => xy(it)[0], y: (it?: unknown) => xy(it)[1] }
    defineExt(e, 'dataflow', viewFacade)
    defineExt(e, 'item', item)
    defineExt(e, 'vega', vega)
    return e
  }

  // ---- stream construction (vega-parser parseStream + vega-runtime stream.js) ---
  const filterFn = (code: string): ((e: ExtEvent) => boolean) => {
    const f = runtime.expr(code)
    return (e) => Boolean(f(undefined, undefined, e))
  }

  const addListener = (target: EventTarget, type: string, send: (e: Event) => void): void => {
    target.addEventListener(type, send)
    detachFns.push(() => target.removeEventListener(type, send))
  }

  /** One root stream per `source:type` (vega Scope.event), with one DOM listener. */
  const rootFor = (source: string, type: string | number): Stream => {
    const key = source + ':' + type
    const have = rootStreams.get(key)
    if (have) return have
    const s = new Stream()
    rootStreams.set(key, s)
    const deliver = (e: ExtEvent, viaView: boolean, native: Event): void => {
      run(() => {
        if (viaView && hooks.preventDefault) native.preventDefault?.()
        s.receive(extend(e, viaView))
      })
    }
    if (source === 'timer') {
      const ms = Number(type)
      const id = setInterval(() => deliver({ type: 'timer', timestamp: Date.now() } as unknown as ExtEvent, false, {} as Event), ms)
      detachFns.push(() => clearInterval(id))
    } else if (source === 'view') {
      addListener(svg, String(type), (e) => deliver(e as ExtEvent, true, e))
    } else if (source === 'window') {
      if (typeof window !== 'undefined') addListener(window, String(type), (e) => deliver(e as ExtEvent, false, e))
      else logger.warn('Can not resolve event source: window')
    } else if (typeof document !== 'undefined') {
      for (const el of Array.from(document.querySelectorAll(source))) addListener(el, String(type), (e) => deliver(e as ExtEvent, false, e))
    } else {
      logger.warn('Can not resolve event source: ' + source)
    }
    return s
  }

  let nodeCounter = 0
  const buildStream = (def: StreamDef & { markrole?: string }, keyBase: string): Stream => {
    if (def == null || typeof def !== 'object') throw new Error('Invalid stream specification: ' + JSON.stringify(def))
    let stream: Stream
    if (def.merge) {
      const list = def.merge.map((m) => buildStream(m, keyBase))
      stream = mergeStreams(list[0]!, list.slice(1))
    } else if (def.stream) {
      stream = buildStream(def.stream, keyBase)
    } else if (def.type != null) {
      if (def.type === 'timer') {
        stream = rootFor('timer', def.throttle ?? 0)
        def = { between: def.between, filter: def.filter } as StreamDef
      } else {
        stream = rootFor(def.source === 'scope' || !def.source ? 'view' : def.source, def.type)
      }
    } else {
      throw new Error('Invalid stream specification: ' + JSON.stringify(def))
    }
    const code = filterCode(def)
    const hasParams = def.between || code || def.throttle != null || def.debounce != null || def.consume
    if (!hasParams) return stream

    let s = stream
    const id = ++nodeCounter
    if (def.between) {
      if (def.between.length !== 2) throw new Error('Stream "between" parameter must have 2 entries: ' + JSON.stringify(def))
      const a = buildStream(def.between[0]!, keyBase)
      const b = buildStream(def.between[1]!, keyBase)
      const st = stateFor(svg, `${keyBase}|between${id}`)
      const on = new Stream(); on.recv = () => { st.active = true }
      const off = new Stream(); off.recv = () => { st.active = false }
      a.targets.push(on)
      b.targets.push(off)
      s = filtered(s, () => st.active)
    } else {
      s = filtered(s, null)
    }
    if (code) {
      const f = filterFn(code)
      s = filtered(s, f)
    }
    if (def.throttle != null) {
      const pause = +def.throttle
      const st = stateFor(svg, `${keyBase}|throttle${id}`)
      s = filtered(s, () => {
        const now = Date.now()
        if (now - st.last > pause) { st.last = now; return true }
        return false
      })
    }
    if (def.debounce != null) {
      const delay = +def.debounce
      const out = new Stream()
      const st = stateFor(svg, `${keyBase}|debounce${id}`)
      const mine = (e: ExtEvent): void => run(() => out.receive(e))
      st.deliver = mine
      detachFns.push(() => { if (st.deliver === mine) st.deliver = null })
      const gate = new Stream()
      gate.recv = (e) => {
        st.evt = e
        if (st.tid) clearTimeout(st.tid)
        st.tid = setTimeout(() => {
          const ev = st.evt
          st.tid = null
          st.evt = null
          if (ev && st.deliver) st.deliver(ev)
        }, delay)
      }
      s.targets.push(gate)
      s = out
    }
    if (def.consume) s.consume = true
    return s
  }

  // ---- bind every handler -------------------------------------------------------
  const names = new Set(defs.map((d) => d.name))
  defs.forEach((signal, si) => {
    (signal.on ?? []).forEach((on, oi) => {
      const where = ` (signal "${signal.name}", on[${oi}])`
      try {
        if (on.encode != null) throw new Error('`encode` updates (mark re-encode on event) are not supported; use `update`')
        const upd = updateOf(on)
        const { streams, sources } = normalizeEvents(on.events)
        if (sources.some((s) => s.scale)) throw new Error('`{scale}` event sources are not supported')
        const force = on.force === true
        const keyBase = `${si}:${signal.name}:${oi}:${JSON.stringify(on.events)}`
        // the value an update produces for a delivery; `e` is the extended event (or a stand-in)
        let compiled: ((datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown) | null = null
        if (upd.kind === 'expr') compiled = runtime.expr(upd.code)
        const evaluate = (e: unknown): unknown =>
          upd.kind === 'expr' ? compiled!(undefined, params(), e) : upd.kind === 'value' ? upd.value : read(upd.name)
        const terminal = (e: ExtEvent): void => update(signal.name, evaluate(e), force)
        for (const def of streams) {
          const stream = buildStream(def as StreamDef, keyBase)
          const sink = new Stream()
          sink.recv = terminal
          stream.targets.push(sink)
        }
        if (sources.length) {
          const deps = new Set<string>()
          for (const s of sources) for (const id of identifiersOf(s.signal!)) deps.add(id)
          for (const d of deps) if (!names.has(d)) deps.delete(d)
          signalHandlers.push({ deps, run: () => { try { update(signal.name, evaluate({}), force) } catch (e) { fail(where, e) } } })
        }
      } catch (e) {
        fail(where, e)
      }
    })
  })

  // Debounced deliveries re-enter the current binding; a re-bind reclaims them.
  const setSignal = (name: string, value: unknown): void => {
    if (name == null) return
    run(() => update(name, value, true))
  }

  return {
    detach: () => {
      for (const fn of detachFns.splice(0)) fn()
    },
    setSignal,
  }
}

function defineExt(e: object, key: string, value: unknown): void {
  Object.defineProperty(e, key, { value, writable: true, configurable: true, enumerable: false })
}

// --- items ---------------------------------------------------------------------

/** vega scenegraph item facade: the scene item plus `mark` ({marktype,name,role,group,interactive}). */
function itemFacade(p: PickedItem): object {
  const mark = {
    marktype: p.marktype ?? 'group',
    name: p.name,
    role: p.role,
    interactive: true,
    get group(): object | null { return p.group ? itemFacade(p.group) : null },
  }
  return Object.create(p.item, { mark: { value: mark, enumerable: true }, [TUPLE_ID]: { value: true } }) as object
}

/** `event.item` recovered from the DOM: the `data-datum` stamp and the mark container's classes. */
function domPick(svg: SVGSVGElement, target: EventTarget | null): PickedItem | null {
  let el = target as Element | null
  let datum: unknown
  let found = false
  let marktype: string | undefined
  let role: string | undefined
  let name: string | undefined
  while (el && el !== (svg as Element)) {
    const ds = (el as HTMLElement).dataset?.datum
    if (!found && ds != null) {
      try { datum = JSON.parse(ds) } catch { datum = undefined }
      found = true
    }
    const cls = typeof (el as Element).getAttribute === 'function' ? (el as Element).getAttribute('class') : null
    if (cls && marktype === undefined) {
      const parts = cls.split(/\s+/)
      const m = parts.find((c) => c.startsWith('mark-'))
      if (m) {
        marktype = m.slice(5)
        const r = parts.find((c) => c.startsWith('role-'))
        role = r ? r.slice(5) : undefined
        name = parts.find((c) => !c.startsWith('mark-') && !c.startsWith('role-') && c.length > 0)
      }
    }
    el = el.parentElement
  }
  if (!found && marktype === undefined) return null
  return { item: { datum }, marktype: marktype === 'path' ? 'path' : marktype, name, role }
}

/** Parent links of a scene, so a picked item can report its mark and enclosing groups (built once, lazily). */
const sceneIndexes = new WeakMap<SceneRoot, ReturnType<typeof buildSceneIndex>>()
function sceneIndex(scene: SceneRoot): ReturnType<typeof buildSceneIndex> {
  let idx = sceneIndexes.get(scene)
  if (!idx) sceneIndexes.set(scene, (idx = buildSceneIndex(scene)))
  return idx
}

function buildSceneIndex(scene: SceneRoot): { describe: (p: PickedItem) => PickedItem } {
  let parents: WeakMap<object, SceneGroup> | null = null
  const ensure = (): WeakMap<object, SceneGroup> => {
    if (parents) return parents
    const map = new WeakMap<object, SceneGroup>()
    const walk = (g: SceneGroup): void => {
      for (const c of g.items ?? []) {
        map.set(c, g)
        if (Array.isArray((c as SceneGroup).items)) walk(c as SceneGroup)
      }
    }
    for (const r of scene.items) walk(r)
    return (parents = map)
  }
  const isMark = (g: SceneGroup): boolean => g.marktype !== undefined && g.marktype !== 'group'
  /** A group item (a SceneGroup that is not a mark container), as a PickedItem with its own group chain. */
  const groupPick = (g: SceneGroup): PickedItem => ({
    item: g,
    marktype: 'group',
    name: g.name,
    role: g.role,
    get group(): PickedItem | null { return enclosing(g) },
  } as PickedItem)
  /** vega's root group item (`mark-group role-frame root`): the group of every top-level mark. */
  const rootGroup: PickedItem = { item: { x: 0, y: 0 }, marktype: 'group', name: 'root', role: 'frame', group: null }
  const enclosing = (node: object): PickedItem | null => {
    const map = ensure()
    let p = map.get(node)
    while (p && isMark(p)) p = map.get(p)
    return p ? groupPick(p) : rootGroup
  }
  return {
    describe: (p) => {
      const map = ensure()
      const container = map.get(p.item)
      const markGroup = container && isMark(container) ? container : undefined
      const m = (p.item as SceneItem).mark
      return {
        item: p.item,
        marktype: markGroup?.marktype ?? p.marktype,
        name: markGroup?.name ?? m?.name,
        role: markGroup?.role ?? m?.role,
        get group(): PickedItem | null { return enclosing(markGroup ?? p.item) },
      } as PickedItem
    },
  }
}

/** Stamp `data-datum` on mark items so event targeting can recover the datum. */
export function stampDatumAttrs(items: SceneNode[]): void {
  const walk = (node: SceneNode): void => {
    const kids = (node as SceneGroup).items
    if (Array.isArray(kids)) {
      for (const c of kids) walk(c)
      return
    }
    const it = node as SceneItem
    if (it.datum != null && typeof it.datum === 'object') {
      ;(it as unknown as { dataDatum?: string }).dataDatum = JSON.stringify(it.datum)
    }
  }
  for (const it of items) walk(it)
}

/**
 * High-level helper for hosts: bind the event loop for an evaluated scene.
 * Uses the scene's own runtime/compiled-chart/signal metadata, so the caller
 * only needs the svg element, the scene, the signal store, and hooks.
 */
export function bindSceneSignals(
  svg: SVGSVGElement,
  scene: SceneRoot,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: Pick<SignalBindOptions, 'pick' | 'data'> = {},
): SignalBinding {
  const chart = (scene as unknown as { compiled?: CompiledChart }).compiled
  const runtime = scene.runtime as ExpressionRuntime | undefined
  const signalParams = (scene as unknown as { signalParams?: Record<string, unknown> }).signalParams ?? {}
  if (!chart || !runtime) {
    // Non-interactive scene (no runtime handle): a no-op binding.
    return { detach: () => {}, setSignal: () => {} }
  }
  return bindSignalEvents(
    svg,
    chart,
    runtime,
    signalParams,
    signals,
    hooks,
    { originX: scene.padding?.left ?? 0, originY: scene.padding?.top ?? 0, scene, ...opts },
  )
}
