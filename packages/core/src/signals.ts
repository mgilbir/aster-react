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
 * - What the signals hold after a delivery is decided by the propagation (signal-propagation.ts): each signal
 *   is evaluated at most once per delivery, in the order of the graph, a signal an event handler set is not
 *   re-evaluated but its dependents are, and a `{signal}`-source handler follows its source and passes the
 *   change on only when it computes something other than last time (or `force`).
 * - An error while a native event is processed (a filter or update expression
 *   throwing) is reported to the logger and abandons the rest of THAT event's
 *   delivery; updates already applied stand, and the loop carries on. Selector
 *   and expression errors are found when the handlers are bound and reported
 *   then (logger.error); the handler is not bound. Nothing escapes the DOM
 *   listener and nothing is swallowed silently.
 *
 * The host (React `<Chart>`, or any embedder) calls `bindSceneSignals` on the
 * rendered SVG or canvas and re-renders when `onSignal` fires. Which item an event of
 * the view is about is the renderer's business, as in vega-scenegraph: on the SVG it is
 * the item under the event's point (the browser's hit test of the element); a canvas has
 * no element per item, and its renderer (`createCanvasEvents` from `@aster-charts/core/canvas`)
 * resolves events as vega's canvas handler does (`ViewEvents`).
 */
import type { CompiledChart, CompiledData, CompiledSignalDef, SceneGroup, SceneItem, SceneNode, SceneRoot, SignalOnDef } from './types.js'
import { isEngineNode, keptInto } from './scene-registry.js'
import { compileExpr, type CompiledExpr, type ExpressionRuntime } from './expression.js'
import type { Changeset } from './modify.js'
import { parseExpression, type AstNode } from './expr-parser.js'
import { normalizeEvents, filterCode } from './stream-defs.js'
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import { array, dict, heldSignalName, ownGet, setOwn, markTupleAlways, MARK_NODE, scopedSignalName, TextTable } from './util.js'
import { follow, node, Propagation, type SignalNode } from './signal-propagation.js'
import { consoleLogger, type Logger } from './logger.js'
import { AsterLimitError, withLimits, type SpecLimits } from './limits.js'
import type { Timer } from './timer.js'
import { part } from './engine-parts.js'
import { clientToSvg } from './pointer.js'

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
  /** The scene node of the item's mark (what `item.mark.items` is in vega): `intersect(..., unit.mark)` walks it. */
  node?: object
  /** A group item's marks (`item.items`), for a picked item the scene holds as a leaf: a legend entry's box. */
  items?: object[]
}

/**
 * How the events of the view reach the loop and which item each one is about: vega-scenegraph's renderer handler. The
 * default is the SVG's (every DOM event of the rendered element, about the item under its point); `createCanvasEvents` from
 * `@aster-charts/core/canvas` is the canvas renderer's. A host keeps one for as long as it shows the element: what it holds
 * (the item under the pointer, the one a button went down on) outlives a binding, as vega's handler outlives a render.
 */
export interface ViewEvents {
  /** A binding starts: `scene` answers for the scene it was made for. */
  connect(scene: ViewEventScene): ViewEventConnection
}

/** What a binding tells its `ViewEvents` about its scene. */
export interface ViewEventScene {
  /** The item under a pointer position (client coordinates), or null. */
  resolve(point: { clientX: number; clientY: number }): PickedItem | null
  /**
   * The item of this scene that an item an earlier binding resolved stands for (vega's items persist from one render to the
   * next), or null when it is gone from the scene (vega: an exit): in the mark at the same place, the item of the same row, else
   * the item at the same position whose row holds the same values.
   */
  relocate(item: PickedItem): PickedItem | null
}

/** One binding's subscription to its `ViewEvents`. */
export interface ViewEventConnection {
  /**
   * Deliver every event of `type` of the view to `send`, with the item it is about: an item or null (none) as the renderer
   * resolved it, or undefined to leave it to the loop (the item under the event's point); and the `event.vegaType` the handlers
   * see (default: `type`).
   */
  on(type: string, send: (event: Event, item: PickedItem | null | undefined, vegaType?: string) => void): void
  /** The binding is over: deliver nothing more to it. */
  disconnect(): void
}

export interface SignalEventHooks {
  /** Called once per signal that changed while an event (or `setSignal`) was processed. */
  onSignal?: (name: string, value: unknown, all: Record<string, unknown>) => void
  /**
   * Called once per dataset that `modify(...)` edited while an event (or `setSignal`) was processed, with the
   * dataset's input rows afterwards. The host keeps them and hands them back as `data[name]` to the next
   * evaluation (and as `SignalBindOptions.data` when it binds again): that evaluation is then the scene vega
   * would show, the dataset being an input like any other (selection stores are datasets). `fromTimer` is true when
   * the edit came from a `timer` event stream's tick (a Vega-Lite `time` animation advancing a frame), not from input.
   */
  onData?: (name: string, rows: unknown[], fromTimer: boolean) => void
  /**
   * Where errors and warnings go (vega's logger): a bad selector or expression is
   * reported at bind time, an expression that throws while an event is processed
   * is reported when it happens. Default: the console.
   */
  logger?: Logger
  /**
   * vega's `view.preventDefault()` (default false): whether events of the `view` source are prevented when
   * `config.events.defaults` names neither `prevent` nor `allow`. The config decides first (by default every view
   * event but `wheel` is prevented, see `preventsEvent`); `consume` always prevents.
   */
  preventDefault?: boolean
}

export interface SignalBindOptions {
  originX?: number
  originY?: number
  /**
   * The budgets every delivery runs under (one scope, one wall clock per event): the handlers' expressions, the event filters
   * and what they re-evaluate meet the same limits as the evaluation (the regex screen, `limits.regex`, `maxTimeMs`, the
   * string and row caps). A violation abandons the delivery and is logged, as any handler error. `bindSceneSignals` takes
   * them from the scene: the limits it was evaluated under.
   */
  limits?: SpecLimits
  /**
   * Resolve a view-space position (page coords minus the svg origin, padding
   * included) to the scene item under it -- `buildHitIndex(scene).query` from
   * `@aster-charts/core/hit` fits. Without it `event.item` is recovered from the DOM
   * (the `mark-*`/`role-*` classes, and the `data-datum` stamp when `stampDatumAttrs` was called).
   */
  pick?: (x: number, y: number) => { item: object; marktype?: string } | null
  /**
   * How the view's events arrive and which item each is about (the renderer's event handler). Default: the DOM events of
   * the element, each about the item under its point (the SVG renderer's). A canvas passes `createCanvasEvents(canvas)` from
   * `@aster-charts/core/canvas`, kept for as long as the canvas is shown.
   */
  events?: ViewEvents
  /** The scene, so a picked item's enclosing groups and mark name/role can be found. */
  scene?: SceneRoot
  /**
   * The input rows of the datasets as the evaluation was given them (`RuntimeInput.data`), so a dataset the
   * host has edited through `onData` is continued from where it stands. A dataset not named here starts
   * from the rows written in the spec.
   */
  data?: Record<string, unknown[]>
  /**
   * What the state that outlives a binding (timer streams, throttle and debounce clocks, `between` windows) is kept
   * for: an object that stays the same across the host's re-renders. Default: the rendered element (svg or canvas), which
   * a host that patches its DOM keeps; a host that REPLACES the element on every render passes its container (or any
   * stable object), or each render would restart its timers.
   */
  owner?: EventTarget
  /**
   * `containerSize()` for the handlers' expressions, read when an event fires (vega: the view container's live
   * `clientWidth` / `clientHeight`). Without it they read the size the scene was evaluated with, which a
   * `window:resize` handler would see a render behind.
   */
  containerSize?: () => [number | undefined, number | undefined]
}

export interface SignalBinding {
  /**
   * Stop delivering events to this binding. Timer streams (and pending debounces) are NOT stopped: a host
   * re-binds after every render, and a timer is the view's, not one binding's (stopping it per render
   * would restart the schedule every frame). Call `release` when the host is done with the element.
   */
  detach: () => void
  /**
   * `detach`, and stop everything the element keeps running between bindings: its timer streams and pending
   * debounces (vega's `view.finalize()`). Idempotent. A timer whose element has left the document stops itself
   * at its next tick even if the host never gets here.
   */
  release: () => void
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

// --- the cursor (vega-view cursor.js): cursor.ts, which a host loads without the loop ----------------------------------

export { createCursorTracker, sceneHasCursor, type CursorTracker, type CursorTrackerOptions } from './cursor.js'

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

/** A timer stream of one owner: it outlives the bindings (a host re-binds after every render) until `release`. */
interface TimerState {
  timer: Timer
  /** Delivers a tick into the CURRENT binding (null while unbound). */
  deliver: ((e: ExtEvent) => void) | null
}
const persistedTimers = new WeakMap<EventTarget, Map<string, TimerState>>()

/**
 * What a `{signal}`-source handler remembers between runs (vega: the handler operator `onOperator` makes): the last value its update
 * produced (it only pulses its signal when that changes, or the entry says `force`) and whether it is still to skip its first
 * invocation. It outlives a binding as the operator outlives a render.
 */
interface HandlerState { value: unknown; skip: boolean }
const persistedHandlers = new WeakMap<EventTarget, Map<string, HandlerState>>()

/** Stop every timer stream and pending debounce the owner keeps running between bindings. */
function releaseOwner(owner: EventTarget): void {
  const timersOf = persistedTimers.get(owner)
  if (timersOf) {
    for (const st of timersOf.values()) {
      st.deliver = null
      st.timer.stop()
    }
    persistedTimers.delete(owner)
  }
  persistedHandlers.delete(owner)
  shells.delete(owner)
  const streams = persisted.get(owner)
  if (streams) {
    for (const st of streams.values()) {
      if (st.tid) clearTimeout(st.tid)
      st.tid = null
      st.evt = null
      st.deliver = null
    }
  }
}
type EventDefaults = { prevent?: unknown; allow?: unknown }

/** vega-view `initializeEventConfig`: `config.events.defaults`, with a `prevent` / `allow` list read as a set of types. */
/**
 * What a binding of a view keeps for the next binding of the same view on the same element (one per owner, see
 * SignalBindOptions.owner): the expressions of its handlers and filters, compiled. A host binds again for every scene it shows, and
 * each binding builds its own runtime (the scene's datasets and scales, its own dataset edits), so compiling against that runtime
 * compiled every expression again, for every scene. They are compiled once instead, against a runtime of the shell's that forwards
 * every member to the runtime of the binding now live (`forwarding`), so an expression of the shell does exactly what the same
 * expression compiled by the live binding would.
 *
 * A binding takes the owner's shell only when no other binding uses it (the last one was detached or released), on the same element
 * and for the same signal and dataset definitions (the same compiled chart); else it starts a shell of its own. Everything else a
 * binding is made of (the dataflow, the streams, the scopes, the baselines of its handlers) is built for each binding, as before.
 */
interface BindingShell {
  el: Element
  defs: CompiledSignalDef[]
  dataDefs: CompiledData[]
  /** The binding that uses the shell (a token of it), or null. */
  live: object | null
  /** The runtimes of the binding that uses the shell, by scope (`''`: the view's). */
  current: Map<string, ExpressionRuntime>
  forwarders: Map<string, ExpressionRuntime>
  compiled: Map<string, Map<string, CompiledExpr>>
}
const shells = new WeakMap<EventTarget, BindingShell>()

/** Every member an expression runtime may have (the type checks the list is complete). */
const RUNTIME_KEYS = Object.keys({
  scale: true, data: true, expr: true, projection: true, tree: true, modify: true, transformed: true, inScope: true, containerSize: true,
  random: true, setdata: true, intersect: true,
} satisfies Record<keyof ExpressionRuntime, true>) as Array<keyof ExpressionRuntime>

/** The key of a scope's runtime in a shell (`''` is the view's, which no scope id can collide with). */
const scopeKey = (scope: Scope): string => '\u0000' + scope.id

/** A runtime each member of which is the member of `target()` when it is read (present or not, as there). */
function forwarding(target: () => ExpressionRuntime): ExpressionRuntime {
  const rt = {} as ExpressionRuntime
  for (const key of RUNTIME_KEYS) Object.defineProperty(rt, key, { enumerable: true, get: () => target()[key] })
  return rt
}

/** The parsed `events` of a signal's `on` entry, per default source: a pure function of the spec, parsed once. */
const PARSED_EVENTS = new WeakMap<object, Map<string, ReturnType<typeof normalizeEvents>>>()
function eventsOf(on: SignalOnDef, defaultSource: 'view' | 'scope'): ReturnType<typeof normalizeEvents> {
  let bySource = PARSED_EVENTS.get(on)
  if (bySource === undefined) PARSED_EVENTS.set(on, (bySource = new Map()))
  let got = bySource.get(defaultSource)
  // (a malformed selector throws here every time, as it did when parsed for each binding)
  if (got === undefined) bySource.set(defaultSource, (got = normalizeEvents(on.events, defaultSource)))
  return got
}

function eventDefaults(config: CompiledChart['eventConfig']): EventDefaults {
  const d = { ...(config?.defaults ?? {}) } as EventDefaults
  for (const k of ['prevent', 'allow'] as const) if (Array.isArray(d[k])) d[k] = new Set(d[k] as unknown[])
  return d
}

/**
 * vega-view `events.js` `prevent(view, type)`: whether an event of the `view` source is prevented before it is handled.
 * `prevent: false` or `allow: true` -> never; `prevent: true` or `allow: false` -> always; a `prevent` list -> the types
 * in it; an `allow` list -> the types not in it; none of these -> `view.preventDefault()`. vega-parser's default config
 * is `allow: ['wheel']`, so a page still scrolls over a chart that does not handle wheel (or whose config allows it).
 */
function preventsEvent(d: EventDefaults, viewPreventDefault: boolean, type: string): boolean {
  const { prevent, allow } = d
  return prevent === false || allow === true ? false
    : prevent === true || allow === false ? true
    : prevent ? (prevent as Set<string>).has(type)
    : allow ? !(allow as Set<string>).has(type)
    : viewPreventDefault
}

/** What a binding last saw of each scale named by a `{scale}` event source, per surface (it survives a re-bind). */
const scaleSnapshots = new WeakMap<EventTarget, Map<string, string>>()

/** A scale's domain and range as one comparable string (Dates by time); `''` for no scale. */
function scaleImage(scale: unknown): string {
  const s = scale as { domain?: () => unknown[]; range?: () => unknown[] } | undefined
  if (!s || typeof s.domain !== 'function') return ''
  try {
    return JSON.stringify([s.domain(), typeof s.range === 'function' ? s.range() : null], (_k, v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))
  } catch {
    return ''
  }
}

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

// --- expression helpers ------------------------------------------------------

/** The functions that read a dataset by the name in their first argument (vega-functions' dataVisitor / selectionVisitor). */
const DATA_READERS = new Set(['data', 'indata', 'vlSelectionTest', 'vlSelectionIdTest', 'vlSelectionResolve'])

/** The key under which an expression's dependence on the dataset `name` is tracked next to its signal names. */
const dataKey = (name: string): string => `data:${name}`

/** The identifiers an expression reads (signal references, among them), and `data:NAME` for every dataset it reads. */
const identifiers = new TextTable<Set<string>>('handler identifiers', 2048, 2_000_000)
function identifiersOf(code: string): Set<string> {
  // (a host binds again after every render, to the same expressions)
  let have = identifiers.get(code)
  if (have === undefined) identifiers.set(code, (have = parseIdentifiers(code)))
  return have
}
function parseIdentifiers(code: string): Set<string> {
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

/**
 * A signal scope of the scene: a group item whose mark declares signals (vega: a group mark's `signals`; each item has its
 * own copy, a facet cell included). Its signals shadow the enclosing scope's of the same name; `push: "outer"` writes to the
 * enclosing one.
 */
interface Scope {
  id: string
  defs: CompiledSignalDef[]
  /** The signals this scope declares (a `push: "outer"` entry declares none). */
  names: Set<string>
  /** The values the scene was evaluated with; the store (`<id>:<name>`) wins where an event has written. */
  values: Record<string, unknown>
  group: SceneGroup
  /**
   * vega's `context.group` is the group of the first mark created in the scope; a group with no marks (axes, legends, a
   * title) has none, and `inScope` is then false for every item.
   */
  hasContent: boolean
  parent: Scope | null
}

function collectScopes(scene: SceneRoot | undefined): Scope[] {
  const out: Scope[] = []
  if (!scene) return out
  const walk = (g: SceneGroup, parent: Scope | null): void => {
    let here = parent
    const sc = g.scopeSignals
    if (sc) {
      here = { id: sc.id, defs: sc.defs, names: new Set(sc.defs.filter((d) => d.push !== 'outer').map((d) => d.name)), values: sc.values, group: g, hasContent: sc.hasContent, parent }
      out.push(here)
    }
    // (a leaf mark's items are leaves: they hold no group, as scene-registry.ts reads a scene)
    if (g.role === 'mark' && g.marktype !== 'group') return
    for (const c of g.items ?? []) if (Array.isArray((c as SceneGroup).items)) walk(c as SceneGroup, here)
  }
  for (const r of scene.items) walk(r, null)
  return out
}

/** vega-functions inScope: `item` is `group` or lies within it (an event item is a facade whose prototype is the scene item). */
function itemWithin(item: unknown, group: object): boolean {
  for (let cur = item as { mark?: { group?: object | null } } | null | undefined; cur; cur = cur.mark?.group as typeof cur) {
    if ((cur as unknown) === group || Object.getPrototypeOf(cur) === group) return true
  }
  return false
}

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
 * Bind every `signal.on` event stream in the compiled chart to the events of the
 * view rendered as `el` (an svg, or a canvas with `opts.events`; and `window` /
 * CSS-selected elements / timers for those sources). See the file header for the
 * semantics. Returns a binding with `detach` + an imperative `setSignal`.
 */
export function bindSignalEvents(
  el: Element,
  chart: CompiledChart,
  runtime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: SignalBindOptions = {},
): SignalBinding {
  return bindSignalEventsDefs(el, chart.signalDefs ?? [], chart.data ?? [], runtime, signalParams, signals, hooks, opts, chart.eventConfig)
}

/** One `{signal}` event source of a `signal.on` entry, as parsed. */
interface HandlerSpec {
  /** stable across bindings */
  id: string
  /** the scope the entry is written in (names in `source` and in the update resolve there) */
  scope: Scope | null
  /** the scope that declares the signal the entry writes (the entry's own, or the enclosing one for `push: "outer"`) */
  target: Scope | null
  targetName: string
  /** the signal's name, or an expression (several sources are `[a,b]`) */
  source: string
  force: boolean
  where: string
  /** the value the entry's update gives now */
  update: () => unknown
}

function bindSignalEventsDefs(
  el: Element,
  defs: CompiledSignalDef[],
  dataDefs: CompiledData[],
  sceneRuntime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks,
  opts: SignalBindOptions,
  eventConfig?: CompiledChart['eventConfig'],
): SignalBinding {
  const preventDefaults = eventDefaults(eventConfig)
  const logger: Logger = hooks.logger ?? consoleLogger
  const scopes = collectScopes(opts.scene)
  /** Every scoped signal by its store key (`<scope id>:<name>`). */
  const scopeByKey = new Map<string, { scope: Scope; name: string }>()
  for (const sc of scopes) for (const n of sc.names) scopeByKey.set(scopedSignalName(sc.id, n), { scope: sc, name: n })
  /** The scope that declares `name` as seen from `scope` (null: the root scope's signal). */
  const ownerOf = (scope: Scope | null, name: string): Scope | null => {
    for (let sc = scope; sc; sc = sc.parent) if (sc.names.has(name)) return sc
    return null
  }
  const keyOf = (owner: Scope | null, name: string): string => (owner ? scopedSignalName(owner.id, name) : name)
  const originX = opts.originX ?? 0
  const originY = opts.originY ?? 0
  const detachFns: Array<() => void> = []
  /** what outlives a binding is kept per owner (see SignalBindOptions.owner) */
  const owner: EventTarget = opts.owner ?? el
  let shell = shells.get(owner)
  if (shell === undefined || shell.live !== null || shell.el !== el || shell.defs !== defs || shell.dataDefs !== dataDefs) {
    shell = { el, defs, dataDefs, live: null, current: new Map(), forwarders: new Map(), compiled: new Map() }
    shells.set(owner, shell)
  }
  const liveToken = {}
  const myShell = shell
  myShell.live = liveToken
  myShell.current = new Map()
  detachFns.push(() => { if (myShell.live === liveToken) myShell.live = null })
  const rootStreams = new Map<string, Stream>()
  /** `{scale}`-source handlers: run when a scale they name has changed since the scene the loop was last bound to. */
  const scaleHandlers: Array<{ scales: Set<string>; run: () => void }> = []
  /** the errors already logged (a limit violation is also re-thrown when its delivery's scope ends: it is logged once) */
  const logged = new WeakSet<object>()
  const fail = (what: string, e: unknown): void => {
    if (typeof e === 'object' && e !== null) {
      if (logged.has(e)) return
      logged.add(e)
    }
    logger.error(`signal event handler${what}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ---- datasets the handlers edit (`modify`) -------------------------------------------------
  // A dataset an event handler modifies lives here, as its input rows; the rest of the datasets are the
  // scene's. The transformed rows are what `data()` shows the handlers meanwhile.
  const datasets = new Map(dataDefs.map((d) => [d.name, d]))
  const inputRows = new Map<string, Array<Record<string, unknown>>>()
  const liveRows = new Map<string, unknown[]>()
  // The rows a dataset starts from are the spec's or the host's: a modified tuple is written to a copy the loop owns, and a
  // handler that still holds the original (a signal kept it) reaches the copy through it, as one tuple is one tuple in vega.
  const ownCopies = new WeakMap<object, Record<string, unknown>>()
  const owned = new WeakSet<object>()
  const writable = (t: Record<string, unknown>): Record<string, unknown> => {
    if (owned.has(t)) return t
    const copy = { ...t }
    owned.add(copy)
    ownCopies.set(t, copy)
    return copy
  }
  const current = (t: unknown): unknown => (t !== null && typeof t === 'object' ? (ownCopies.get(t) ?? t) : t)
  const currentAll = (v: unknown): unknown => (Array.isArray(v) ? v.map(current) : current(v))
  const rawOf = (name: string): Array<Record<string, unknown>> =>
    inputRows.get(name) ?? (opts.data?.[name] as Array<Record<string, unknown>> | undefined) ?? (datasets.get(name)?.values as Array<Record<string, unknown>> | undefined) ?? []
  const dataOf = (name: string): unknown[] | undefined => {
    const raw = inputRows.get(name)
    if (!raw) return sceneRuntime.data(name)
    let rows = liveRows.get(name)
    if (!rows) liveRows.set(name, (rows = sceneRuntime.transformed ? sceneRuntime.transformed(name, raw) : raw))
    return rows
  }

  // ---- the dataflow: one native event (or setSignal) is one run of it ---------------------------
  // The graph the handlers run in (see signal-propagation.ts): a delivery runs the event handlers (they set their signals
  // and touch them), then the touched nodes, and what they reach, are evaluated in order, once each.
  const flow = new Propagation((e) => { if (!(e instanceof Logged)) fail('', e) })
  /** an error already reported by the operator that raised it: the run is abandoned, the report is not repeated */
  class Logged extends Error {}
  /** the signal operators by store key, the dataset operators by name */
  const signalOps = new Map<string, SignalNode>()
  const dataOps = new Map<string, SignalNode>()
  /** the `{signal}`-source handlers (vega: `onOperator`), collected while the entries are parsed, built into the graph after them */
  const handlerSpecs: HandlerSpec[] = []
  const handlerOps: Array<{ op: SignalNode; state: HandlerState }> = []
  /** the store keys a handler assigned in the run (their dependents may not have been told, see `holdStale`) */
  const assigned = new Set<string>()
  /** the derived signals of the view that read a signal (by its store key), for `holdStale` */
  const readers = new Map<string, Array<{ key: string; def: CompiledSignalDef }>>()
  /** when (a count of the writes to the store) a signal was last written and a derived signal was last evaluated, in this binding */
  const wroteAt = new Map<string, number>()
  const evaluatedAt = new Map<string, number>()
  /** handling an event (or `setSignal`): `modify` is available */
  let handling = 0
  /** the edits `setdata` / `modify` pulse into a dataset, applied when its operator runs */
  const pulsed = new Map<string, Changeset>()
  /** vega-functions modify.js `data.changes`: the changeset of the stamp a dataset is being modified in */
  const modifying = new Map<string, { stamp: number; cs: Changeset }>()

  /** vega-functions modify.js: queue the edit; the dataset is pulsed in a run of its own once the one that asked has finished. */
  const modifyData = (name: string, insert: unknown, remove: unknown, toggle: unknown, modifyTuple: unknown, values: unknown): number => {
    if (!datasets.has(name)) throw new Error(`Cannot modify the unknown data set "${name}"`)
    if (!handling) throw new Error('modify() is only available while an event is being handled')
    const { planModify, newChangeset } = part('modify')
    return planModify(rawOf(name), () => {
      let m = modifying.get(name)
      if (!m || m.stamp < flow.clock) {
        const mine = (m = { stamp: flow.clock, cs: newChangeset() })
        modifying.set(name, mine)
        flow.runAfter(() => {
          pulsed.set(name, mine.cs)
          flow.touch(dataOps.get(name)!)
          flow.evaluate()
        }, 1)
      }
      return m.cs
    }, currentAll(insert), currentAll(remove), toggle, current(modifyTuple), values)
  }
  /** vega-functions data.js setdata: `df.pulse(input, changeset().remove(truthy).insert(tuples))`, applied when the dataset's operator runs. */
  const setData = (name: string, tuples: unknown): number => {
    const cs = part('modify').newChangeset()
    cs.remp.push(() => true)
    for (const t of array(tuples)) cs.add.push(t)
    pulsed.set(name, cs)
    flow.touch(dataOps.get(name)!)
    return 1
  }

  // The runtime the handlers' expressions run in: the scene's, with the datasets as edited and `modify`.
  const bindRuntime: ExpressionRuntime = {
    ...sceneRuntime,
    data: dataOf,
    modify: modifyData,
    setdata: (name, tuples) => {
      if (!datasets.has(name)) throw new TypeError(`Cannot read properties of undefined (reading 'input')`)
      return setData(name, tuples)
    },
    ...(opts.containerSize ? { containerSize: opts.containerSize } : {}),
    intersect: (box, opt, group) => part('intersect').sceneIntersect(opts.scene, box, opt, group),
    expr: (code) => compileIn('', code),
  }
  myShell.current.set('', bindRuntime)
  /** An expression of the scope `key` (`''`: the view's), compiled once per shell against the shell's runtime of that scope. */
  const compileIn = (key: string, code: string): CompiledExpr => {
    let cache = myShell.compiled.get(key)
    if (!cache) myShell.compiled.set(key, (cache = new Map()))
    let f = cache.get(code)
    if (!f) {
      let rt = myShell.forwarders.get(key)
      if (!rt) myShell.forwarders.set(key, (rt = forwarding(() => myShell.current.get(key)!)))
      cache.set(code, (f = compileExpr(code, rt)))
    }
    return f
  }
  /** A scale as a handler of `scope` sees it: the scales its group (and the groups around it) declare, then the view's. */
  const scaleIn = (scope: Scope, name: string): ReturnType<ExpressionRuntime['scale']> => {
    for (let sc: Scope | null = scope; sc; sc = sc.parent) {
      const own = (sc.group as unknown as { __scaleFns?: Map<string, unknown> }).__scaleFns?.get(name)
      if (own) return own as ReturnType<ExpressionRuntime['scale']>
    }
    return sceneRuntime.scale(name)
  }
  /** The expression runtime of a scope: `inScope` and `scale` see that group's scope. The root scope is the scene's. */
  const scopeRuntimes = new Map<Scope, ExpressionRuntime>()
  const runtimeFor = (scope: Scope | null): ExpressionRuntime => {
    if (!scope) return bindRuntime
    let rt = scopeRuntimes.get(scope)
    if (!rt) {
      const made: ExpressionRuntime = {
        ...bindRuntime,
        inScope: (item) => scope.hasContent && itemWithin(item, scope.group),
        scale: (name) => scaleIn(scope, name),
        expr: (code) => compileIn(scopeKey(scope), code),
      }
      scopeRuntimes.set(scope, (rt = made))
      myShell.current.set(scopeKey(scope), made)
    }
    return rt
  }
  /** The current value of `name` as seen from `scope`: the host's store wins, the evaluated scene's value is the baseline. */
  const read = (name: string, scope: Scope | null = null): unknown => {
    const owner = ownerOf(scope, name)
    if (!owner) return Object.hasOwn(signals, name) ? signals[name] : ownGet(signalParams, name)
    const key = scopedSignalName(owner.id, name)
    return Object.hasOwn(signals, key) ? signals[key] : owner.values[name]
  }
  /** The value stored under a store key (a root signal's name, or a scoped signal's `<scope id>:<name>`). */
  const readKey = (key: string): unknown => {
    const hit = scopeByKey.get(key)
    return hit ? read(hit.name, hit.scope) : read(key)
  }
  /**
   * What an expression of `scope` sees: the view's signals, then each enclosing scope's own over them, outermost first. It
   * is built once between two writes of a signal (every filter of an event reads it before any handler writes).
   */
  const params = (scope: Scope | null = null): Record<string, unknown> => {
    const have = paramsMemo.get(scope)
    if (have && have.gen === writes) return have.params
    const p = buildParams(scope)
    paramsMemo.set(scope, { gen: writes, params: p })
    return p
  }
  const paramsMemo = new Map<Scope | null, { gen: number; params: Record<string, unknown> }>()
  /** Counts the writes to the signal store: a memoised `params` is good until the next one. */
  let writes = 0
  const buildParams = (scope: Scope | null): Record<string, unknown> => {
    const p = dict(signalParams, signals)
    if (!scope) return p
    const chain: Scope[] = []
    for (let sc: Scope | null = scope; sc; sc = sc.parent) chain.unshift(sc)
    for (const sc of chain) {
      for (const n of sc.names) p[n] = read(n, sc)
      const datum = (sc.group as { datum?: unknown }).datum
      if (datum !== undefined) p.parent = datum
    }
    return p
  }

  const markChanged = (key: string): void => { notified.changed.add(key) }
  /** Store `value` as the value of the signal `name` as `owner` (the scope that declares it) sees it. */
  const store = (owner: Scope | null, name: string, value: unknown): string => {
    const key = keyOf(owner, name)
    setOwn(signals, key, value)
    wroteAt.set(key, ++writes)
    return key
  }
  /**
   * vega-dataflow `Dataflow.update(op, value, {skip: true, force})`, what an event handler does to the signal it feeds: the
   * value is stored when it differs (reference) or is forced, and the signal is touched with its own update skipped.
   * `owner` is the scope that declares the signal.
   */
  const update = (owner: Scope | null, name: string, value: unknown, force: boolean): void => {
    if (!force && read(name, owner) === value) return
    const key = store(owner, name, value)
    markChanged(key)
    const op = signalOps.get(key)
    if (op) flow.touch(op, true)
  }
  /** The ids an expression reads as store keys (data dependencies stay `data:NAME`): a name resolves in `scope` first. */
  const depKeys = (scope: Scope | null, code: string): Set<string> => {
    const out = new Set<string>()
    for (const id of identifiersOf(code)) out.add(id.startsWith('data:') ? id : keyOf(ownerOf(scope, id), id))
    return out
  }

  /**
   * A handler assigns its signal's value as it is, and pulses the signal's dependents only if what it computed differs from what
   * it computed last: a dependent can be left as it was while what it reads has changed (vega's operator keeps the value it has
   * until a source pulses it). The scene is evaluated from the signals' values, and would compute that dependent afresh, so the
   * store says it is HELD (see `heldSignalName`) for as long as the dataflow has not evaluated it. Only a signal that reads one
   * a handler assigned, and was not evaluated after the assignment, can be so.
   */
  const holdStale = (): void => {
    for (const target of assigned) {
      for (const entry of readers.get(target) ?? []) {
        if ((evaluatedAt.get(entry.key) ?? -1) >= (wroteAt.get(target) ?? 0)) continue
        const { key, def } = entry
        let fresh: unknown
        try { fresh = runtimeFor(null).expr(def.update!)(undefined, params(null)) } catch { continue }
        const held = Object.hasOwn(signals, heldSignalName(key))
        const current = read(def.name, null)
        if (fresh !== current) {
          if (!held) { setOwn(signals, heldSignalName(key), true); store(null, def.name, current) }
        } else if (held) { delete signals[heldSignalName(key)]; writes++ }
      }
    }
  }

  /**
   * Run `fn` as one delivery: the handlers it calls set their signals, then the dataflow runs (vega: `view.runAsync(null, fn)`).
   * Errors are logged (vega: Dataflow.error), the hooks fire when the outermost delivery is over.
   */
  const run = (fn: () => void): void => {
    if (handling) {
      try { fn() } catch (e) { fail('', e) }
      return
    }
    handling++
    try {
      // one delivery is one pass under the limits the scene was evaluated with (`SignalBindOptions.limits`): a violation the
      // dataflow caught (and logged) is re-thrown when the scope ends, and ends the delivery here
      withLimits(opts.limits, () => {
        assigned.clear()
        flow.evaluate(fn)
        holdStale()
      })
    } catch (e) {
      if (!(e instanceof AsterLimitError)) throw e
      fail('', e)
    } finally {
      handling--
      for (const h of handlerOps) h.state.skip = h.op.skip
      if (batching === 0) flushNotified()
    }
  }

  // What the runs of one DOM event changed is told to the host once the event has been delivered to every scope that listens:
  // the host re-renders (and binds again) on being told, which must not happen between two scopes' runs of the same event.
  const notified = { changed: new Set<string>(), edited: new Set<string>() }
  let batching = 0
  /** A `timer` stream's tick is being delivered (what it edits is told to the host as the timer's). */
  let timerTick = false
  const flushNotified = (): void => {
    const edited = [...notified.edited]
    const changed = [...notified.changed]
    notified.edited.clear()
    notified.changed.clear()
    for (const name of edited) hooks.onData?.(name, inputRows.get(name)!, timerTick)
    for (const key of changed) hooks.onSignal?.(key, readKey(key), signals)
  }

  // ---- event extension (vega-view events-extend.js) ----------------------------
  const viewFacade = {
    signal: (name: string) => read(name),
    width: () => el.clientWidth,
    height: () => el.clientHeight,
  }
  /** A client point in view coordinates (the view's origin, inside its padding). */
  const viewPoint = (src: { clientX: number; clientY: number }): [number, number] => {
    const [x, y] = clientToSvg(el, src.clientX, src.clientY)
    return [x - originX, y - originY]
  }
  const clientPoint = (e: ExtEvent): { clientX: number; clientY: number } => {
    const t = (e as unknown as { changedTouches?: ArrayLike<{ clientX: number; clientY: number }> }).changedTouches
    return t ? t[0]! : (e as unknown as { clientX: number; clientY: number })
  }
  const pointOf = (e: ExtEvent): [number, number] => viewPoint(clientPoint(e))
  const sceneInfo = opts.scene ? sceneIndex(opts.scene) : null

  /** The scene item under a client point (described: its mark, its groups), from the scene hit index; null for none. */
  const resolveAt = (src: { clientX: number; clientY: number }): PickedItem | null => {
    let picked: PickedItem | null = null
    const p = viewPoint(src)
    if (opts.pick) {
      // the scene hit index decides what the item is, as vega's pick does: the rendered markup carries no stamp of it, and a
      // DOM element the browser finds where the scene's geometry has nothing (a glyph past the text's box) is not an item
      const hit = opts.pick(p[0] + originX, p[1] + originY)
      picked = hit ? { marktype: hit.marktype, ...hit } as PickedItem : null
      if (picked && sceneInfo) picked = describeIn(sceneInfo, picked)
    }
    picked ??= frameAt(p)
    if (picked && opts.scene) pickedFrom.set(picked, opts.scene)
    return picked
  }
  /** The painted frame of the view is the root group's background: vega picks it, so over the empty plot the item is the root group. */
  const frameAt = (p: [number, number]): PickedItem | null => {
    const sc = opts.scene
    if (!sc || !sceneInfo || !(sc.frameFill || sc.frameStroke || sc.frameFillTransparent)) return null
    const w = sc.plotWidth ?? sc.width
    const h = sc.plotHeight ?? sc.height
    return p[0] >= 0 && p[1] >= 0 && p[0] <= w && p[1] <= h ? sceneInfo.root() : null
  }

  /** `event.item` of an event the renderer left to the loop: the item under its point (no picker: what the DOM under it says). */
  const resolveItem = (e: ExtEvent): PickedItem | null => {
    if (opts.pick) return resolveAt(clientPoint(e))
    // no picker: what the DOM under the event says (a legend's marks are named by the spec, `<field>_legend_symbols`...)
    const picked = domPick(el, e.target)
    const inLegend = typeof (e.target as Element | null)?.closest === 'function' && (e.target as Element).closest('.role-legend') != null
    if (picked && inLegend && !picked.group && sceneInfo) picked.group = sceneInfo.root()
    return picked ?? frameAt(pointOf(e))
  }

  /**
   * The events already extended, with the item they were extended with: several scopes' streams receive the same event, which
   * is resolved (item, coordinates) once. A canvas hands one native event over several times (a pointermove is also the
   * pointerout of the item it leaves and the pointerover of the one it enters), each time about its own item: vega extends
   * it again each time.
   */
  const extendedEvents = new WeakMap<object, PickedItem | null | undefined>()
  const extend = (e: ExtEvent, withItem: boolean, given?: PickedItem | null): ExtEvent => {
    if (extendedEvents.has(e) && extendedEvents.get(e) === given) return e
    extendedEvents.set(e, given)
    const point = pointOf(e)
    const picked = withItem ? (given !== undefined ? given : resolveItem(e)) : undefined
    // (vega hands its handlers the renderer's answer as it is: a canvas that picked nothing says `null`, an svg element without
    // an item `undefined`)
    const item = picked ? itemFacade(picked) : given === null && opts.events ? null : undefined
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

  // The view's events, as the renderer hands them over (the SVG's by default: each about the item under its point).
  const viewEvents = (opts.events ?? domViewEvents(el, opts.pick != null)).connect({
    resolve: resolveAt,
    relocate: (item) => (sceneInfo && opts.scene ? relocateIn(opts.scene, sceneInfo, item) : null),
  })
  detachFns.push(() => viewEvents.disconnect())

  // ---- stream construction (vega-parser parseStream + vega-runtime stream.js) ---
  const filterFn = (code: string, scope: Scope | null): ((e: ExtEvent) => boolean) => {
    const f = runtimeFor(scope).expr(code)
    return (e) => Boolean(f(undefined, params(scope), e))
  }

  const addListener = (target: EventTarget, type: string, send: (e: Event) => void): void => {
    target.addEventListener(type, send)
    detachFns.push(() => target.removeEventListener(type, send))
  }

  /**
   * The root stream of `source:type` for a scope (vega Scope.event): the stream of the nearest enclosing scope that already
   * has one, else a new one that belongs to this scope. A scope is parsed after the ones around it, so the view's streams
   * are shared by every scope that listens to the same event (its handlers run in ONE dataflow run, the view's first); a
   * stream a scope makes is its own and its inner scopes', and a sibling scope makes another. Each stream has one DOM
   * listener (a delivery is one dataflow run), and they fire in the order they were made.
   */
  const rootFor = (scope: Scope | null, source: string, type: string | number | undefined): Stream => {
    const suffix = '\u0000' + source + ':' + type
    for (let sc: Scope | null = scope; ; sc = sc.parent) {
      const found = rootStreams.get((sc ? sc.id : '') + suffix)
      if (found) return found
      if (!sc) break
    }
    const key = (scope ? scope.id : '') + suffix
    const s = new Stream()
    rootStreams.set(key, s)
    /** The one run a delivery of `e` to this root stream is. */
    const deliverTo = (stream: Stream, e: ExtEvent, viaView: boolean, native: Event, item?: PickedItem | null): void => {
      run(() => {
        if (viaView && preventsEvent(preventDefaults, hooks.preventDefault === true, String(type))) native.preventDefault?.()
        stream.receive(extend(e, viaView, item))
      })
    }
    if (source === 'timer') {
      // vega-view `view.timer(send, delay)`: d3-timer's `interval(tick, delay)` (no delay: every frame), whose tick hands
      // the stream `{timestamp, elapsed}`. One timer per owner, scope and delay, alive across re-bindings.
      let byDelay = persistedTimers.get(owner)
      if (!byDelay) persistedTimers.set(owner, (byDelay = new Map()))
      let st = byDelay.get(key)
      if (!st) {
        const fresh: TimerState = { timer: undefined as unknown as Timer, deliver: null }
        let wasConnected = false
        fresh.timer = part('timer').timers.interval((elapsed) => {
          // an owner that has left the document no longer ticks (a host that forgot `release`)
          const connected = (owner as Partial<Node>).isConnected ?? el.isConnected
          if (connected) wasConnected = true
          else if (wasConnected) {
            releaseOwner(owner)
            return
          }
          fresh.deliver?.({ timestamp: Date.now(), elapsed } as unknown as ExtEvent)
        // (the type as written: `timer:500` hands d3-timer the STRING '500', whose `interval` then adds delays to it as text and
        // ticks once, where `timer{500}` / `{type: 'timer', throttle: 500}` hand it the number; the stream of the delay is the one
        // the first of them made)
        }, type as number | undefined)
        byDelay.set(key, (st = fresh))
      }
      const mine = (e: ExtEvent): void => {
        timerTick = true
        try { deliverTo(s, e, false, {} as Event) } finally { timerTick = false }
      }
      st.deliver = mine
      const owned = st
      detachFns.push(() => { if (owned.deliver === mine) owned.deliver = null })
      return s
    }
    // A DOM source has one listener for every scope that listens to it, and the scopes' streams run in the order they were
    // made (the view's first, then the scopes' in document order), each as its own dataflow run.
    const listenKey = source + ':' + type
    let streams = domStreams.get(listenKey)
    if (!streams) {
      const list: Stream[] = (streams = [])
      domStreams.set(listenKey, list)
      const deliver = (e: ExtEvent, viaView: boolean, native: Event, item?: PickedItem | null): void => {
        batching++
        try { for (const stream of list) deliverTo(stream, e, viaView, native, item) } finally { if (--batching === 0) flushNotified() }
      }
      if (source === 'view') {
        // (vega's handlers say which of the types they listen to an event was handed over as: `event.vegaType`)
        viewEvents.on(String(type), (e, item, vegaType) => { defineExt(e, 'vegaType', vegaType ?? String(type)); deliver(e as ExtEvent, true, e, item) })
      } else if (source === 'window') {
        if (typeof window !== 'undefined') addListener(window, String(type), (e) => deliver(e as ExtEvent, false, e))
        else logger.warn('Can not resolve event source: window')
      } else if (typeof document !== 'undefined') {
        for (const el of Array.from(document.querySelectorAll(source))) addListener(el, String(type), (e) => deliver(e as ExtEvent, false, e))
      } else {
        logger.warn('Can not resolve event source: ' + source)
      }
    }
    streams.push(s)
    return s
  }
  const domStreams = new Map<string, Stream[]>()

  let nodeCounter = 0
  const buildStream = (def: StreamDef & { markrole?: string }, keyBase: string, scope: Scope | null): Stream => {
    if (def == null || typeof def !== 'object') throw new Error('Invalid stream specification: ' + JSON.stringify(def))
    let stream: Stream
    if (def.merge) {
      const list = def.merge.map((m) => buildStream(m, keyBase, scope))
      stream = mergeStreams(list[0]!, list.slice(1))
    } else if (def.stream) {
      stream = buildStream(def.stream, keyBase, scope)
    } else if (def.type != null) {
      if (def.type === 'timer') {
        stream = rootFor(scope, 'timer', def.throttle)
        def = { between: def.between, filter: def.filter } as StreamDef
      } else {
        stream = rootFor(scope, def.source === 'scope' || !def.source ? 'view' : def.source, def.type)
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
      const a = buildStream(def.between[0]!, keyBase, scope)
      const b = buildStream(def.between[1]!, keyBase, scope)
      const st = stateFor(owner, `${keyBase}|between${id}`)
      const on = new Stream(); on.recv = () => { st.active = true }
      const off = new Stream(); off.recv = () => { st.active = false }
      a.targets.push(on)
      b.targets.push(off)
      s = filtered(s, () => st.active)
    } else {
      s = filtered(s, null)
    }
    if (code) {
      const f = filterFn(code, scope)
      s = filtered(s, f)
    }
    if (def.throttle != null) {
      const pause = +def.throttle
      const st = stateFor(owner, `${keyBase}|throttle${id}`)
      s = filtered(s, () => {
        const now = Date.now()
        if (now - st.last > pause) { st.last = now; return true }
        return false
      })
    }
    if (def.debounce != null) {
      const delay = +def.debounce
      const out = new Stream()
      const st = stateFor(owner, `${keyBase}|debounce${id}`)
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
  // The view's signals, then each group scope's. A scope's handlers read and write through it: its own signals shadow
  // the enclosing ones, `push: "outer"` writes to the enclosing scope's, and its selector strings default to the
  // `scope` source (events within the scope's group).
  const rootNames = new Set(defs.map((d) => d.name))
  const units: Array<{ scope: Scope | null; defs: CompiledSignalDef[] }> = [{ scope: null, defs }, ...scopes.map((sc) => ({ scope: sc as Scope | null, defs: sc.defs }))]
  for (const unit of units) {
    const scope = unit.scope
    unit.defs.forEach((signal, si) => {
      (signal.on ?? []).forEach((on, oi) => {
        const where = ` (signal "${signal.name}"${scope ? ` of scope "${scope.id}"` : ''}, on[${oi}])`
        try {
          if (on.encode != null) throw new Error('`encode` updates (mark re-encode on event) are not supported; use `update`')
          // the signal this handler writes: its own, or the enclosing scope's for `push: "outer"`
          let target: Scope | null = scope
          if (signal.push === 'outer') {
            if (!scope) throw new Error('`push: "outer"` needs an enclosing scope')
            target = ownerOf(scope.parent, signal.name)
            if (!target && !rootNames.has(signal.name)) throw new Error(`No prior signal definition for "outer" push: "${signal.name}"`)
          }
          const upd = updateOf(on)
          const { streams, sources } = eventsOf(on, scope ? 'scope' : 'view')
          const force = on.force === true
          const keyBase = `${scope ? scope.id : ''}|${si}:${signal.name}:${oi}:${JSON.stringify(on.events)}`
          const rt = runtimeFor(scope)
          // the value an update produces for a delivery; `e` is the extended event (or a stand-in)
          let compiled: ((datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown) | null = null
          if (upd.kind === 'expr') compiled = rt.expr(upd.code)
          // (a `{signal}` update names a signal or, as any signal reference of a spec, is an expression: vega-parser's signalRef)
          else if (upd.kind === 'signal' && !ownerOf(scope, upd.name) && !Object.hasOwn(signals, upd.name) && !Object.hasOwn(signalParams, upd.name)) compiled = rt.expr(upd.name)
          const evaluate = (e: unknown): unknown =>
            compiled ? compiled(undefined, params(scope), e) : upd.kind === 'value' ? upd.value : read((upd as { name: string }).name, scope)
          const terminal = (e: ExtEvent): void => update(target, signal.name, evaluate(e), force)
          for (const def of streams) {
            const stream = buildStream(def as StreamDef, keyBase, scope)
            const sink = new Stream()
            sink.recv = terminal
            stream.targets.push(sink)
          }
          // vega-parser update.js: several operator sources are merged into ONE (the expression `[a,b]`, a fresh array whenever
          // either has changed); a single one is the signal itself if it names one, else the expression's operator
          const onSignals = sources.filter((s) => s.signal != null)
          if (onSignals.length) {
            const text = onSignals.length > 1 ? '[' + onSignals.map((s) => s.signal).join(',') + ']' : onSignals[0]!.signal!
            handlerSpecs.push({
              id: `${keyBase}|signal`, scope, target, targetName: signal.name, source: text, force, where,
              update: () => evaluate({}),
            })
          }
          const onScales = new Set(sources.filter((s) => s.scale != null).map((s) => s.scale!))
          if (onScales.size) {
            scaleHandlers.push({ scales: onScales, run: () => { try { update(target, signal.name, evaluate({}), force) } catch (e) { fail(where, e) } } })
          }
        } catch (e) {
          fail(where, e)
        }
      })
    })
  }

  // ---- the graph (vega-parser's operators, vega-runtime's connections, in the order the dataflow ranks them) ----------
  // Created in the order vega-parser emits them: the view's signals, the datasets, the expression sources of the entries
  // (`signalRef` makes one for an expression), then each group scope's signals (a subflow is built after the view's first run).
  // Then every operator is connected to what it reads, in that order, and each entry's handler is made to follow its source.
  {
    const created: Array<{ op: SignalNode; deps: Set<string>; react: boolean }> = []
    const defByKey = new Map<string, CompiledSignalDef>()
    const make = (op: SignalNode, deps: Set<string>, react: boolean): void => {
      flow.add(op)
      created.push({ op, deps, react })
    }
    const guarded = <T>(f: () => T, what: string): T | undefined => {
      try { return f() } catch (e) { fail(what, e); return undefined }
    }
    const signalOp = (scope: Scope | null, d: CompiledSignalDef): void => {
      const key = keyOf(scope, d.name)
      const op = node(d.name)
      const code = typeof d.update === 'string' ? d.update : typeof d.init === 'string' ? d.init : null
      let deps = new Set<string>()
      if (code !== null) { try { deps = depKeys(scope, code) } catch { /* an unparsable expression is reported when it evaluates */ } }
      if (typeof d.update === 'string') {
        const code = d.update
        // vega Operator.evaluate: the update's value replaces the operator's when it differs (reference); else nothing pulses
        op.run = () => {
          let v: unknown
          try { v = runtimeFor(scope).expr(code)(undefined, params(scope)) } catch (e) { fail(` (update of "${d.name}")`, e); throw new Logged() }
          if (scope === null && Object.hasOwn(signals, heldSignalName(key))) { delete signals[heldSignalName(key)]; writes++ }
          evaluatedAt.set(key, writes)
          if (v !== read(d.name, scope)) markChanged(store(scope, d.name, v))
          else if (!op.forced) return false
        }
        if (scope === null && !d.on?.length) {
          for (const dep of deps) {
            let list = readers.get(dep)
            if (list === undefined) readers.set(dep, (list = []))
            list.push({ key, def: d })
          }
        }
      }
      signalOps.set(key, op)
      defByKey.set(key, d)
      // (`init` is evaluated once, and the operator then lets go of what it read: it is ranked after it, it is not pulsed by it)
      make(op, deps, d.react !== false && typeof d.update === 'string')
    }
    for (const d of defs) signalOp(null, d)
    for (const d of dataDefs) {
      if (dataOps.has(d.name)) continue
      const name = d.name
      const op = node(dataKey(name), () => {
        const cs = pulsed.get(name)
        if (!cs) return
        pulsed.delete(name)
        inputRows.set(name, part('modify').applyChangeset(rawOf(name), cs, writable))
        liveRows.delete(name)
        notified.edited.add(name)
      })
      dataOps.set(name, op)
      make(op, new Set(), false)
    }

    // the source operator of each entry, and the handler that follows it
    interface Built { spec: HandlerSpec; source: SignalNode; consumedAtInit: boolean }
    const built: Built[] = []
    const lambdas = new Map<string, { op: SignalNode; first: unknown }>()
    const sourceOf = (spec: HandlerSpec): Built | null => {
      const { scope, source } = spec
      const owner = /^[A-Za-z_$][\w$]*$/.test(source) ? ownerOf(scope, source) : null
      const named = /^[A-Za-z_$][\w$]*$/.test(source) && (owner !== null || rootNames.has(source))
      if (named) {
        const key = keyOf(owner, source)
        const op = signalOps.get(key)
        const def = defByKey.get(key)
        if (!op || !def) return null
        // the operator pulsed in the first run unless its own update left it at the value it was made with
        const consumed = def.update === undefined && def.init === undefined ? true : read(source, owner) !== def.value
        return { spec, source: op, consumedAtInit: consumed }
      }
      const lambdaKey = (scope ? scope.id : '') + '\u0000' + source
      let made = lambdas.get(lambdaKey)
      if (!made) {
        const f = runtimeFor(scope).expr(source)
        const deps = depKeys(scope, source)
        let value: unknown = null
        try { value = f(undefined, params(scope)) } catch { /* reported when it evaluates in a run */ }
        const lambda = node('(' + source + ')')
        lambda.run = () => {
          let v: unknown
          try { v = f(undefined, params(scope)) } catch (e) { fail(spec.where, e); throw new Logged() }
          if (v !== value) value = v
          else if (!lambda.forced) return false
        }
        made = { op: lambda, first: value }
        lambdas.set(lambdaKey, made)
        make(lambda, deps, true)
      }
      // (the operator pulsed in the first run unless its value stayed the `null` it is made with)
      return { spec, source: made.op, consumedAtInit: made.first !== null }
    }
    const lambdasOf = (scope: Scope | null): void => {
      for (const spec of handlerSpecs) {
        if (spec.scope !== scope) continue
        const b = guarded(() => sourceOf(spec), spec.where)
        if (b) built.push(b)
      }
    }
    lambdasOf(null)
    for (const sc of scopes) {
      for (const d of sc.defs) if (d.push !== 'outer') signalOp(sc, d)
      lambdasOf(sc)
    }

    for (const { op, deps, react } of created) {
      const sources: SignalNode[] = []
      for (const k of deps) {
        const s = k.startsWith('data:') ? dataOps.get(k.slice(5)) : signalOps.get(k)
        if (!s || s === op) continue
        sources.push(s)
        if (react) follow(s, op)
      }
      guarded(() => flow.connect(op, sources), '')
    }

    // vega-dataflow `on(operator, target, update, params, options)`
    let states = persistedHandlers.get(owner)
    if (!states) persistedHandlers.set(owner, (states = new Map()))
    for (const { spec, source, consumedAtInit } of built) {
      const targetKey = keyOf(spec.target, spec.targetName)
      const targetOp = signalOps.get(targetKey)
      if (!targetOp) continue
      let state = states.get(spec.id)
      if (!state) states.set(spec.id, (state = { value: defByKey.get(targetKey)?.value, skip: !consumedAtInit }))
      const hs = state
      const h = node(`on ${spec.id}`)
      h.forced = spec.force
      h.run = () => {
        let value: unknown
        try { value = spec.update() } catch (e) { fail(spec.where, e); throw new Logged() }
        if (!targetOp.skip) {
          targetOp.skip = value !== hs.value
          const changed = read(spec.targetName, spec.target) !== value
          store(spec.target, spec.targetName, value)
          assigned.add(targetKey)
          if (changed || h.forced) markChanged(targetKey)
        }
        if (value !== hs.value) hs.value = value
        else if (!h.forced) return false
      }
      h.order = source.order // immediately follows its source
      follow(source, h)
      h.skip = hs.skip
      follow(h, targetOp)
      guarded(() => flow.connect(targetOp, [h]), '')
      handlerOps.push({ op: h, state: hs })
    }
  }

  // A scale event is a scale that was recomputed. The host binds again after every render, so the scales of this
  // scene are compared with those the loop saw last: a scale that differs fires its handlers, as one run.
  if (scaleHandlers.length) {
    const seen = scaleSnapshots.get(el) ?? new Map<string, string>()
    scaleSnapshots.set(el, seen)
    const changed = new Set<string>()
    for (const name of new Set(scaleHandlers.flatMap((h) => [...h.scales]))) {
      const now = scaleImage(sceneRuntime.scale(name))
      const before = seen.get(name)
      seen.set(name, now)
      if (before !== undefined && before !== now) changed.add(name)
    }
    if (changed.size) {
      run(() => {
        for (const h of scaleHandlers) if ([...h.scales].some((n) => changed.has(n))) h.run()
      })
    }
  }

  // Debounced deliveries re-enter the current binding; a re-bind reclaims them.
  const setSignal = (name: string, value: unknown): void => {
    if (name == null) return
    const hit = scopeByKey.get(name)
    run(() => (hit ? update(hit.scope, hit.name, value, true) : update(null, name, value, true)))
  }

  return {
    detach: () => {
      for (const fn of detachFns.splice(0)) fn()
    },
    release: () => {
      for (const fn of detachFns.splice(0)) fn()
      releaseOwner(owner)
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
    ...(p.node ? { [MARK_NODE]: p.node } : {}),
  }
  const facade = Object.create(p.item, {
    mark: { value: mark, enumerable: true },
    ...(p.items !== undefined ? { items: { value: p.items, enumerable: true } } : {}),
  }) as object
  markTupleAlways(facade)
  return facade
}

/**
 * The SVG renderer's events: every DOM event of the element, about the item of the element the browser dispatched it to, which
 * is the item under its point (the loop resolves it), except for the events of the pointer leaving an element: those are about
 * the element left, which the scene hit index (`picked`) finds under the pointer's last position over the svg. (Without a picker
 * the loop reads the item off the element an event is dispatched to, which is the one left.)
 */
function domViewEvents(target: Element, picked: boolean): ViewEvents {
  if (picked) trackPointer(target)
  return {
    connect: (scene) => {
      const off: Array<() => void> = []
      return {
        on(type, send) {
          const left = picked && LEAVING.has(type)
          const listener = (e: Event): void => {
            const last = left ? lastPointer.get(target) : undefined
            send(e, last ? scene.resolve(last) : undefined)
          }
          target.addEventListener(type, listener)
          off.push(() => target.removeEventListener(type, listener))
        },
        disconnect() { for (const f of off.splice(0)) f() },
      }
    },
  }
}
/** The events a pointer leaving an element is dispatched as (to the element it leaves). */
const LEAVING = new Set(['pointerout', 'mouseout', 'dragleave'])
/** Where the pointer last was over an svg (client coordinates): a pointer that leaves an item left the item there. */
const lastPointer = new WeakMap<Element, { clientX: number; clientY: number }>()
const tracked = new WeakSet<Element>()
function trackPointer(target: Element): void {
  if (tracked.has(target)) return
  tracked.add(target)
  const keep = (e: Event): void => {
    const m = e as MouseEvent
    lastPointer.set(target, { clientX: m.clientX, clientY: m.clientY })
  }
  // (the boundary events of a move, pointer and mouse ones, are dispatched before its pointermove: what this holds then is the
  // position before the move)
  for (const t of ['pointermove', 'pointerdown', 'mousemove']) target.addEventListener(t, keep, { passive: true })
}

/** The scene a resolved item belongs to, so a later binding can find what stands for it in its own scene. */
const pickedFrom = new WeakMap<PickedItem, SceneRoot>()

/** A hit, described as `event.item` needs it: its mark's type, name and role, its enclosing groups (and a legend entry's marks). */
function describeIn(info: SceneIndex, hit: PickedItem): PickedItem {
  const picked = info.describe(hit)
  // vega's legend entry is a group item holding its symbol and its label (`item().items[0].items[0].datum.value`)
  if ((picked.item as SceneItem)._part === 'entry') picked.items = info.entryMarks(picked.item as SceneItem)
  return picked
}

/**
 * The item of `scene` that `old` (resolved by an earlier binding) stands for, or null when it is gone. vega's items persist across
 * renders, an item being its mark's item for the same tuple, and a removed one exits; Aster evaluates each scene afresh, with no
 * tuple ids, so the item is looked for where it was: in the mark at the same place in the scene (the same marks and groups down to
 * it, of the same type, name and role), the item with the same datum (the same row object), else the item at the same position
 * whose datum holds the same values (a row the evaluation copied).
 */
function relocateIn(scene: SceneRoot, info: SceneIndex, old: PickedItem): PickedItem | null {
  const from = pickedFrom.get(old)
  if (from === undefined) return null
  if (from === scene) return old
  const before = sceneIndex(from)
  if (old === before.root()) return info.root()
  const path = before.pathOf(old.item)
  if (!path) return null
  const index = path[path.length - 1]!
  const siblings = (path.length > 1 ? (info.at(path.slice(0, -1)) as SceneGroup | undefined)?.items : scene.items) as readonly SceneItem[] | undefined
  if (!siblings) return null
  const datum = (old.item as SceneItem).datum
  let node: SceneItem | undefined
  if (datum !== null && typeof datum === 'object') for (const it of siblings) if (it.datum === datum) { node = it; break }
  if (node === undefined && sameValues(siblings[index]?.datum, datum)) node = siblings[index]
  if (node === undefined) return null
  const now = describeIn(info, { item: node, marktype: old.marktype })
  if (now.marktype !== old.marktype || now.name !== old.name || now.role !== old.role) return null
  pickedFrom.set(now, scene)
  return now
}

/** Two datums of the same row: the same value, or objects whose own fields hold the same values. */
function sameValues(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]) || !Object.hasOwn(b, k)) return false
  return true
}

/** `event.item` recovered from the DOM: the `data-datum` stamp and the mark container's classes. */
function domPick(svg: Element, target: EventTarget | null): PickedItem | null {
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
const sceneIndexes = new WeakMap<SceneRoot, SceneIndex>()
function sceneIndex(scene: SceneRoot): SceneIndex {
  let idx = sceneIndexes.get(scene)
  if (!idx) sceneIndexes.set(scene, (idx = buildSceneIndex(scene)))
  return idx
}

/** A group node's children split by kind: the groups among them, and the leaves (kept with an engine node: see scene-registry.ts). */
interface NodeShape { groups: SceneGroup[]; leaves: ReadonlySet<object> | null }
const NODE_SHAPES = new WeakMap<object, { shape: NodeShape; root: object }>()
function shapeOf(g: SceneGroup, root: object): NodeShape {
  const kept = NODE_SHAPES.get(g)
  if (kept !== undefined && keptInto(kept.root, root)) return kept.shape
  const groups: SceneGroup[] = []
  let leaves: Set<object> | null = null
  for (const c of g.items ?? []) {
    if (c === null || typeof c !== 'object') continue
    if (Array.isArray((c as SceneGroup).items)) groups.push(c as SceneGroup)
    else (leaves ??= new Set()).add(c)
  }
  const shape = { groups, leaves }
  if (isEngineNode(g)) NODE_SHAPES.set(g, { shape, root })
  return shape
}

/**
 * The parent of a node of the scene (the group whose `items` hold it), found without walking the leaves of every mark: the scene's
 * group nodes are walked once (they are few), and a leaf is looked up in the leaf sets of the groups that hold leaves, which an
 * engine node keeps for its lifetime (for the later scenes that keep it, see `keptInto`). What a pointer event needs of a scene
 * costs what the scene made anew, not what it holds.
 */
function parentFinder(scene: SceneRoot): (node: object) => SceneGroup | undefined {
  const groupParent = new Map<object, SceneGroup>()
  const holders: Array<[SceneGroup, ReadonlySet<object>]> = []
  const walk = (g: SceneGroup, depth: number): void => {
    const shape = shapeOf(g, scene)
    if (shape.leaves !== null) holders.push([g, shape.leaves])
    if (depth > 256) return
    for (const c of shape.groups) {
      if (!groupParent.has(c)) groupParent.set(c, g)
      walk(c, depth + 1)


    }
  }
  for (const r of scene.items) walk(r, 0)
  const found = new Map<object, SceneGroup | undefined>()
  return (node) => {
    const g = groupParent.get(node)
    if (g !== undefined) return g
    if (found.has(node)) return found.get(node)
    let out: SceneGroup | undefined
    for (const [h, leaves] of holders) if (leaves.has(node)) { out = h; break }
    found.set(node, out)
    return out
  }
}

interface SceneIndex {
  describe: (p: PickedItem) => PickedItem
  root: () => PickedItem
  entryMarks: (box: SceneItem) => object[]
  /** Where a node sits: its index in the scene's items, then in each group's items down to it; null when it is not in the scene. */
  pathOf: (node: object) => number[] | null
  /** The node at a place `pathOf` gave (of this scene or another), or undefined. */
  at: (path: readonly number[]) => object | undefined
}

function buildSceneIndex(scene: SceneRoot): SceneIndex {
  let parents: { get: (node: object) => SceneGroup | undefined } | null = null
  const ensure = (): { get: (node: object) => SceneGroup | undefined } => {
    if (parents) return parents
    return (parents = { get: parentFinder(scene) })
  }
  const isMark = (g: SceneGroup): boolean => g.marktype !== undefined && g.marktype !== 'group'
  /** The name the spec gave a mark: vega's `item.mark.name` (the scene calls a mark the spec did not name `marks`). */
  const specName = (g: SceneGroup): string | undefined => g.cssName
  /** The group mark a group item belongs to, as vega has it: a mark holding the group items of that name (the cells of a facet). The scene keeps no such wrapper. */
  const groupMarkOf = (g: SceneGroup, parent: SceneGroup | undefined): object => {
    const mark = { marktype: 'group', name: specName(g), role: g.role } as { items?: unknown[] }
    Object.defineProperty(mark, 'items', {
      enumerable: true,
      get: () => ((parent ? parent.items : scene.items) ?? []).filter((i) => (i as SceneGroup).marktype === 'group' && (i as SceneGroup).name === g.name),
    })
    return mark
  }
  /** A group item (a SceneGroup that is not a mark container), as a PickedItem with its own group chain. */
  const groupPick = (g: SceneGroup): PickedItem => ({
    item: g,
    marktype: 'group',
    name: specName(g),
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
  /**
   * The marks of the legend entry a box stands for, as vega's entry group holds them: its symbol mark, then its label mark, each
   * with the entry's one item. The scene keeps an entry's leaves after its box, in that order.
   */
  const entryMarks = (box: SceneItem): object[] => {
    const leaves = (ensure().get(box)?.items ?? []) as SceneItem[]
    const symbols: SceneItem[] = []
    const labels: SceneItem[] = []
    for (let i = leaves.indexOf(box) + 1; i > 0 && i < leaves.length && leaves[i]!._part !== 'entry'; i++) {
      if (leaves[i]!._part === 'symbol') symbols.push(leaves[i]!)
      else if (leaves[i]!._part === 'label') labels.push(leaves[i]!)
    }
    return [{ marktype: 'symbol', role: 'legend-symbol', items: symbols }, { marktype: 'text', role: 'legend-label', items: labels }]
  }
  const pathOf = (node: object): number[] | null => {
    const map = ensure()
    const path: number[] = []
    for (let n = node; ;) {
      const parent = map.get(n)
      const i = ((parent ? parent.items : scene.items) as readonly object[] | undefined)?.indexOf(n) ?? -1
      if (i < 0) return null
      path.push(i)
      if (!parent) return path.reverse()
      n = parent
    }
  }
  const at = (path: readonly number[]): object | undefined => {
    let list: readonly object[] | undefined = scene.items
    let node: object | undefined
    for (const i of path) {
      node = list?.[i]
      if (node === undefined) return undefined
      list = (node as SceneGroup).items
    }
    return node
  }
  return {
    root: () => rootGroup,
    entryMarks,
    pathOf,
    at,
    describe: (p) => {
      const map = ensure()
      const container = map.get(p.item)
      const markGroup = container && isMark(container) ? container : undefined
      const m = (p.item as SceneItem).mark
      // a picked group item (a facet cell, a nested view) names its own mark: vega's `item.mark.name` / `.role`
      const own = markGroup === undefined && (p.item as SceneGroup).marktype === 'group' ? (p.item as SceneGroup) : undefined
      // a part of an axis or a legend: vega's mark of that part (`axis-label`, `legend-symbol`...), named as the spec named it
      const part = markGroup === undefined && container !== undefined ? guidePart(container, p.item as SceneItem) : undefined
      return {
        item: p.item,
        marktype: markGroup?.marktype ?? p.marktype,
        name: markGroup ? specName(markGroup) : part ? part.name : m?.name ?? (own ? specName(own) : undefined),
        role: markGroup?.role ?? part?.role ?? m?.role ?? own?.role,
        // (a group item's mark: vega's group mark holds it and its siblings of the same name)
        ...((p.item as SceneGroup).marktype === 'group' ? { node: groupMarkOf(p.item as SceneGroup, container) } : {}),
        get group(): PickedItem | null { return enclosing(markGroup ?? p.item) },
      } as PickedItem
    },
  }
}

/** vega's roles of the marks of a guide's parts (vega-parser guides): an entry box stands for the entry's group item (`scope`). */
const GUIDE_PART_ROLES: Record<string, Record<string, string>> = {
  axis: { tick: 'axis-tick', label: 'axis-label', grid: 'axis-grid', domain: 'axis-domain', title: 'axis-title', bg: 'axis' },
  legend: { symbol: 'legend-symbol', label: 'legend-label', title: 'legend-title', entry: 'scope', gradient: 'legend-gradient', band: 'legend-band', bg: 'legend' },
}

/** The role and the spec's name of the guide mark a leaf of an axis or a legend belongs to, or undefined for any other leaf. */
function guidePart(guide: SceneGroup, leaf: SceneItem): { role: string; name: string | undefined } | undefined {
  if ((guide as { _scope?: boolean })._scope === true || (guide.role !== 'axis' && guide.role !== 'legend')) return undefined
  const part = leaf._part
  const role = part !== undefined ? GUIDE_PART_ROLES[guide.role]![part] : undefined
  if (role === undefined) return undefined
  const key = part === 'entry' ? 'entries' : part === 'bg' ? guide.role : part!
  return { role, name: guide.partMeta?.[key]?.name }
}

/**
 * A datum as JSON. A datum may refer to itself (a `joinaggregate` with `ops: ["values"]` puts the group's tuples,
 * itself among them, on every tuple of the group): the reference that closes the circle is left out.
 */
function datumJson(datum: unknown): string | undefined {
  try {
    return JSON.stringify(datum)
  } catch {
    const ancestors: unknown[] = []
    return JSON.stringify(datum, function (this: unknown, _key: string, value: unknown) {
      if (value === null || typeof value !== 'object') return value
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop()
      if (ancestors.includes(value)) return undefined
      ancestors.push(value)
      return value
    })
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
      ;(it as unknown as { dataDatum?: string }).dataDatum = datumJson(it.datum)
    }
  }
  for (const it of items) walk(it)
}

/**
 * High-level helper for hosts: bind the event loop for an evaluated scene.
 * Uses the scene's own runtime/compiled-chart/signal metadata, so the caller
 * only needs the rendered element (the svg, or the canvas with `opts.events`
 * from `createCanvasEvents`), the scene, the signal store, and hooks.
 */
export function bindSceneSignals(
  el: Element,
  scene: SceneRoot,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: Pick<SignalBindOptions, 'pick' | 'data' | 'owner' | 'containerSize' | 'events'> = {},
): SignalBinding {
  const chart = (scene as unknown as { compiled?: CompiledChart }).compiled
  const runtime = scene.runtime as ExpressionRuntime | undefined
  const signalParams = (scene as unknown as { signalParams?: Record<string, unknown> }).signalParams ?? {}
  if (!chart || !runtime) {
    // Non-interactive scene (no runtime handle): a no-op binding.
    return { detach: () => {}, release: () => {}, setSignal: () => {} }
  }
  return bindSignalEvents(
    el,
    chart,
    runtime,
    signalParams,
    signals,
    hooks,
    {
      originX: scene.padding?.left ?? 0, originY: scene.padding?.top ?? 0, scene,
      // the limits the scene was evaluated under (runtime.ts `__limits`)
      limits: (scene as unknown as { __limits?: SpecLimits }).__limits,
      ...opts,
    },
  )
}
