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
import { parseExpression, type AstNode } from './expr-parser.js'
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import { array, dict, heldSignalName, ownGet, setOwn, TUPLE_ID, MARK_NODE, scopedSignalName } from './util.js'
import { Flow, Op, STOP } from './signal-dataflow.js'
import { sceneIntersect } from './scene-intersect.js'
import { consoleLogger, type Logger } from './logger.js'
import { timers, type Timer } from './timer.js'
import { resolveCursor } from './cursor.js'
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
   * Resolve a view-space position (page coords minus the svg origin, padding
   * included) to the scene item under it -- `buildHitIndex(scene).query` from
   * `@aster/core/hit` fits. Without it `event.item` is recovered from the DOM
   * (the `mark-*`/`role-*` classes, and the `data-datum` stamp when `stampDatumAttrs` was called).
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
  /**
   * What the state that outlives a binding (timer streams, throttle and debounce clocks, `between` windows) is kept
   * for: an object that stays the same across the host's re-renders. Default: the svg element, which a host that
   * patches its DOM keeps; a host that REPLACES the svg on every render passes its container (or any stable object),
   * or each render would restart its timers.
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
   * would restart the schedule every frame). Call `release` when the host is done with the svg.
   */
  detach: () => void
  /**
   * `detach`, and stop everything the svg keeps running between bindings: its timer streams and pending
   * debounces (vega's `view.finalize()`). Idempotent. A timer whose svg has left the document stops itself
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

// --- the cursor (vega-view cursor.js) ------------------------------------------------

/** What the cursor tracker needs from its host. */
export interface CursorTrackerOptions {
  /**
   * The item under the point `move` was given (`HitIndex.pick` of the view-space position: the topmost item that takes the
   * pointer), or null. The point is the host's to define: a host that knows no item has a cursor answers null without
   * converting it.
   */
  pick: (x: number, y: number) => { item: object } | null
  /** The value of the spec's `cursor` signal now (a string; undefined when the spec has none). Read at every move and refresh. */
  user: () => unknown
  /** Told the cursor to show whenever it changes (null: none). Never told the same value twice in a row. */
  onCursor: (cursor: string | null) => void
  /** `config.events`: a `view` rule that blocks `pointermove` stops the tracker from ever looking (vega's `permit`). */
  eventConfig?: CompiledChart['eventConfig']
}

export interface CursorTracker {
  /** The pointer moved to this point (vega: a `pointermove` of the view): read the `cursor` of the item `pick` finds there, report the result. */
  move: (x: number, y: number) => void
  /** The `cursor` signal changed (vega: its operator re-runs): report the cursor with the item the pointer was last over. */
  refresh: () => void
}

/**
 * vega-view `cursor.js`: the item cursor is taken at every pointermove (`event.item && event.item.cursor || null`, so
 * moving off the items resets it), the visible cursor is `resolveCursor(user, item)`. The host owns where it is shown.
 * Framework-agnostic: nothing here touches the DOM.
 */
export function createCursorTracker(opts: CursorTrackerOptions): CursorTracker {
  // `opts` is read afresh at every call: a host that re-renders updates it in place, the tracker (and the item it holds) stays
  const blocked = (): boolean => {
    // vega-view events.js `permit(view, 'view', 'pointermove')`: `false`, or a list / object of types that lacks it, blocks it
    const rule = opts.eventConfig?.view
    return rule === false || (rule != null && typeof rule === 'object' && !(Array.isArray(rule) ? rule.includes('pointermove') : (rule as Record<string, unknown>).pointermove))
  }
  let item: string | null = null
  // vega rewrites the signal as `{user, item}` at a pointermove (user: its value, or 'default' when that is falsy): until the
  // host changes the value, that is what the signal holds
  let hasMoved = false
  let movedRaw: unknown
  let movedUser: unknown
  const signal = (): unknown => {
    const raw = opts.user()
    if (!hasMoved || movedRaw !== raw) return raw
    return typeof movedUser === 'string' ? movedUser : { user: movedUser, item }
  }
  let shown: string | null = resolveCursor(opts.user(), null)
  const report = (): void => {
    const next = resolveCursor(signal(), item)
    if (next === shown) return
    shown = next
    opts.onCursor(next)
  }
  return {
    move(x, y) {
      if (blocked()) return
      const raw = opts.user()
      if (!hasMoved || movedRaw !== raw) {
        hasMoved = true
        movedRaw = raw
        movedUser = raw ? (typeof raw === 'string' ? raw : (raw as { user?: unknown }).user) : 'default'
      }
      const c = (opts.pick(x, y)?.item as { cursor?: unknown } | undefined)?.cursor
      item = typeof c === 'string' && c !== '' ? c : null
      report()
    },
    refresh: report,
  }
}

/** Whether any item of the scene has a `cursor` channel (so a host can skip picking on every pointermove when none does). */
export function sceneHasCursor(scene: SceneRoot): boolean {
  let known = cursorScenes.get(scene)
  if (known === undefined) {
    const walk = (nodes: readonly SceneNode[] | undefined): boolean => {
      for (const n of nodes ?? []) {
        if ((n as SceneItem).cursor != null) return true
        if (walk((n as SceneGroup).items)) return true
      }
      return false
    }
    cursorScenes.set(scene, (known = walk(scene.items)))
  }
  return known
}
const cursorScenes = new WeakMap<SceneRoot, boolean>()

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

// --- selector / stream-spec normalisation -----------------------------------

interface OperatorSource { signal?: string; scale?: string }

/** vega-parser update.js: a string is a selector; otherwise an array of stream objects and operator sources. */
function normalizeEvents(events: unknown, defaultSource: 'view' | 'scope' = 'view'): { streams: StreamDef[]; sources: OperatorSource[] } {
  if (events == null) throw new Error('Signal update missing events specification.')
  // (a selector string's default source is the view's, and a group scope's own in a subscope: vega-parser update.js)
  const list: unknown[] = typeof events === 'string' ? parseEventSelectorString(events, defaultSource) : Array.isArray(events) ? events : [events]
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
const identifiers = new Map<string, Set<string>>()
function identifiersOf(code: string): Set<string> {
  // (a host binds again after every render, to the same expressions)
  let have = identifiers.get(code)
  if (have === undefined) {
    if (identifiers.size >= 2048) identifiers.clear()
    identifiers.set(code, (have = parseIdentifiers(code)))
  }
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
  return bindSignalEventsDefs(svg, chart.signalDefs ?? [], chart.data ?? [], runtime, signalParams, signals, hooks, opts, chart.eventConfig)
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
  svg: SVGSVGElement,
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
  const owner: EventTarget = opts.owner ?? svg
  const rootStreams = new Map<string, Stream>()
  /** `{scale}`-source handlers: run when a scale they name has changed since the scene the loop was last bound to. */
  const scaleHandlers: Array<{ scales: Set<string>; run: () => void }> = []
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

  // ---- the dataflow: one native event (or setSignal) is one run of it ---------------------------
  // The graph the handlers run in is vega-dataflow's (see signal-dataflow.ts): a delivery runs the event handlers (they set
  // their signals and touch them), then the touched operators are evaluated in rank order, once per stamp.
  const flow = new Flow({ error: (e) => { if (!(e instanceof Logged)) fail('', e) } })
  /** an error already reported by the operator that raised it: the run is abandoned, the report is not repeated */
  class Logged extends Error {}
  /** the signal operators by store key, the dataset operators by name */
  const signalOps = new Map<string, Op>()
  const dataOps = new Map<string, Op>()
  /** the `{signal}`-source handlers (vega: `onOperator`), collected while the entries are parsed, built into the graph after them */
  const handlerSpecs: HandlerSpec[] = []
  const handlerOps: Array<{ op: Op; state: HandlerState }> = []
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
    return planModify(rawOf(name), () => {
      let m = modifying.get(name)
      if (!m || m.stamp < flow.stamp()) {
        const mine = (m = { stamp: flow.stamp(), cs: newChangeset() })
        modifying.set(name, mine)
        flow.runAfter(() => {
          pulsed.set(name, mine.cs)
          flow.touch(dataOps.get(name)!)
          flow.evaluate()
        }, 1)
      }
      return m.cs
    }, insert, remove, toggle, modifyTuple, values)
  }
  /** vega-functions data.js setdata: `df.pulse(input, changeset().remove(truthy).insert(tuples))`, applied when the dataset's operator runs. */
  const setData = (name: string, tuples: unknown): number => {
    const cs = newChangeset()
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
    intersect: (box, opt, group) => sceneIntersect(opts.scene, box, opt, group),
    expr: (code) => compileIn(bindRuntime, code),
  }
  const compiledExprs = new WeakMap<ExpressionRuntime, Map<string, CompiledExpr>>()
  const compileIn = (rt: ExpressionRuntime, code: string): CompiledExpr => {
    let cache = compiledExprs.get(rt)
    if (!cache) compiledExprs.set(rt, (cache = new Map()))
    let f = cache.get(code)
    if (!f) cache.set(code, (f = compileExpr(code, rt)))
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
        expr: (code) => compileIn(made, code),
      }
      scopeRuntimes.set(scope, (rt = made))
    }
    return rt
  }
  const runtime = bindRuntime

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
      assigned.clear()
      flow.evaluate(fn)
      holdStale()
    } finally {
      handling--
      for (const h of handlerOps) h.state.skip = h.op.skip()
      if (batching === 0) flushNotified()
    }
  }

  // What the runs of one DOM event changed is told to the host once the event has been delivered to every scope that listens:
  // the host re-renders (and binds again) on being told, which must not happen between two scopes' runs of the same event.
  const notified = { changed: new Set<string>(), edited: new Set<string>() }
  let batching = 0
  const flushNotified = (): void => {
    const edited = [...notified.edited]
    const changed = [...notified.changed]
    notified.edited.clear()
    notified.changed.clear()
    for (const name of edited) hooks.onData?.(name, inputRows.get(name)!)
    for (const key of changed) hooks.onSignal?.(key, readKey(key), signals)
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
    const [x, y] = clientToSvg(svg, src.clientX, src.clientY)
    return [x - originX, y - originY]
  }
  const sceneInfo = opts.scene ? sceneIndex(opts.scene) : null

  const resolveItem = (e: ExtEvent): object | undefined => {
    let picked: PickedItem | null | undefined
    // a legend's marks are named by the spec (`<field>_legend_symbols`...) and carry their entry as datum: the DOM says so
    const inLegend = typeof (e.target as Element | null)?.closest === 'function' && (e.target as Element).closest('.role-legend') != null
    if (inLegend) {
      picked = domPick(svg, e.target)
      if (picked && !picked.group && sceneInfo) picked.group = sceneInfo.root()
      // the entry (the datum) is the scene item under the pointer: the rendered markup carries no stamp of it
      if (picked && opts.pick) {
        const p = pointOf(e)
        const hit = opts.pick(p[0] + originX, p[1] + originY)
        if (hit && (hit.item as { datum?: unknown }).datum != null) picked.item = hit.item
      }
    }
    if (!picked && opts.pick) {
      const p = pointOf(e)
      const hit = opts.pick(p[0] + originX, p[1] + originY)
      picked = hit ? { marktype: hit.marktype, ...hit } as PickedItem : null
      if (picked && sceneInfo) picked = sceneInfo.describe(picked)
    }
    // no picker, or it found nothing under the pointer (e.g. no layout): what the DOM under the event says
    if (!picked) picked = domPick(svg, e.target)
    // the painted frame of the view is the root group's background: vega picks it, so over the empty plot the item is the root group
    if (!picked && opts.scene && sceneInfo && (opts.scene.frameFill || opts.scene.frameStroke || opts.scene.frameFillTransparent)) {
      const [px, py] = pointOf(e)
      const w = opts.scene.plotWidth ?? opts.scene.width
      const h = opts.scene.plotHeight ?? opts.scene.height
      if (px >= 0 && py >= 0 && px <= w && py <= h) picked = sceneInfo.root()
    }
    return picked ? itemFacade(picked) : undefined
  }

  /** The events already extended: several scopes' streams receive the same event, which is resolved (item, coordinates) once. */
  const extendedEvents = new WeakSet<object>()
  const extend = (e: ExtEvent, withItem: boolean): ExtEvent => {
    if (extendedEvents.has(e)) return e
    extendedEvents.add(e)
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
    const deliverTo = (stream: Stream, e: ExtEvent, viaView: boolean, native: Event): void => {
      run(() => {
        if (viaView && preventsEvent(preventDefaults, hooks.preventDefault === true, String(type))) native.preventDefault?.()
        stream.receive(extend(e, viaView))
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
        fresh.timer = timers.interval((elapsed) => {
          // an owner that has left the document no longer ticks (a host that forgot `release`)
          const connected = (owner as Partial<Node>).isConnected ?? svg.isConnected
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
      const mine = (e: ExtEvent): void => deliverTo(s, e, false, {} as Event)
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
      const deliver = (e: ExtEvent, viaView: boolean, native: Event): void => {
        batching++
        try { for (const stream of list) deliverTo(stream, e, viaView, native) } finally { if (--batching === 0) flushNotified() }
      }
      if (source === 'view') {
        addListener(svg, String(type), (e) => deliver(e as ExtEvent, true, e))
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
          const { streams, sources } = normalizeEvents(on.events, scope ? 'scope' : 'view')
          const force = on.force === true
          const keyBase = `${scope ? scope.id : ''}|${si}:${signal.name}:${oi}:${JSON.stringify(on.events)}`
          const rt = runtimeFor(scope)
          // the value an update produces for a delivery; `e` is the extended event (or a stand-in)
          let compiled: ((datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown) | null = null
          if (upd.kind === 'expr') compiled = rt.expr(upd.code)
          const evaluate = (e: unknown): unknown =>
            upd.kind === 'expr' ? compiled!(undefined, params(scope), e) : upd.kind === 'value' ? upd.value : read(upd.name, scope)
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
    const created: Array<{ op: Op; deps: Set<string>; react: boolean }> = []
    const defByKey = new Map<string, CompiledSignalDef>()
    const make = (op: Op, deps: Set<string>, react: boolean): void => {
      flow.add(op)
      created.push({ op, deps, react })
    }
    const guarded = <T>(f: () => T, what: string): T | undefined => {
      try { return f() } catch (e) { fail(what, e); return undefined }
    }
    const signalOp = (scope: Scope | null, d: CompiledSignalDef): void => {
      const key = keyOf(scope, d.name)
      const op = new Op(d.name)
      const code = typeof d.update === 'string' ? d.update : typeof d.init === 'string' ? d.init : null
      let deps = new Set<string>()
      if (code !== null) { try { deps = depKeys(scope, code) } catch { /* an unparsable expression is reported when it evaluates */ } }
      if (typeof d.update === 'string') {
        const code = d.update
        // vega Operator.evaluate: the update's value replaces the operator's when it differs (reference); else nothing pulses
        op.evaluate = () => {
          let v: unknown
          try { v = runtimeFor(scope).expr(code)(undefined, params(scope)) } catch (e) { fail(` (update of "${d.name}")`, e); throw new Logged() }
          if (scope === null && Object.hasOwn(signals, heldSignalName(key))) { delete signals[heldSignalName(key)]; writes++ }
          evaluatedAt.set(key, writes)
          if (v !== read(d.name, scope)) markChanged(store(scope, d.name, v))
          else if (!op.modified()) return STOP
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
      const op = new Op(dataKey(name), () => {
        const cs = pulsed.get(name)
        if (!cs) return
        pulsed.delete(name)
        inputRows.set(name, applyChangeset(rawOf(name), cs))
        liveRows.delete(name)
        notified.edited.add(name)
      })
      dataOps.set(name, op)
      make(op, new Set(), false)
    }

    // the source operator of each entry, and the handler that follows it
    interface Built { spec: HandlerSpec; source: Op; consumedAtInit: boolean }
    const built: Built[] = []
    const lambdas = new Map<string, { op: Op; first: unknown }>()
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
        const lambda = new Op('(' + source + ')')
        lambda.evaluate = () => {
          let v: unknown
          try { v = f(undefined, params(scope)) } catch (e) { fail(spec.where, e); throw new Logged() }
          if (v !== value) value = v
          else if (!lambda.modified()) return STOP
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
      const sources: Op[] = []
      for (const k of deps) {
        const s = k.startsWith('data:') ? dataOps.get(k.slice(5)) : signalOps.get(k)
        if (!s || s === op) continue
        sources.push(s)
        if (react) s.addTarget(op)
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
      const h = new Op(`on ${spec.id}`)
      h.modified(spec.force)
      h.evaluate = () => {
        let value: unknown
        try { value = spec.update() } catch (e) { fail(spec.where, e); throw new Logged() }
        if (!targetOp.skip()) {
          targetOp.skip(value !== hs.value)
          const changed = read(spec.targetName, spec.target) !== value
          store(spec.target, spec.targetName, value)
          assigned.add(targetKey)
          if (changed || h.modified()) markChanged(targetKey)
        }
        if (value !== hs.value) hs.value = value
        else if (!h.modified()) return STOP
      }
      h.rank = source.rank // immediately follows its source
      source.addTarget(h)
      h.skip(hs.skip)
      h.addTarget(targetOp)
      guarded(() => flow.connect(targetOp, [h]), '')
      handlerOps.push({ op: h, state: hs })
    }
  }

  // A scale event is a scale that was recomputed. The host binds again after every render, so the scales of this
  // scene are compared with those the loop saw last: a scale that differs fires its handlers, as one run.
  if (scaleHandlers.length) {
    const seen = scaleSnapshots.get(svg) ?? new Map<string, string>()
    scaleSnapshots.set(svg, seen)
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

function buildSceneIndex(scene: SceneRoot): { describe: (p: PickedItem) => PickedItem; root: () => PickedItem } {
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
  /** The group mark a group item belongs to, as vega has it: a mark holding the group items of that name (the cells of a facet). The scene keeps no such wrapper. */
  const groupMarkOf = (g: SceneGroup, parent: SceneGroup | undefined): object => {
    const mark = { marktype: 'group', name: g.name, role: g.role } as { items?: unknown[] }
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
    root: () => rootGroup,
    describe: (p) => {
      const map = ensure()
      const container = map.get(p.item)
      const markGroup = container && isMark(container) ? container : undefined
      const m = (p.item as SceneItem).mark
      // a picked group item (a facet cell, a nested view) names its own mark: vega's `item.mark.name` / `.role`
      const own = markGroup === undefined && (p.item as SceneGroup).marktype === 'group' ? (p.item as SceneGroup) : undefined
      return {
        item: p.item,
        marktype: markGroup?.marktype ?? p.marktype,
        name: markGroup?.name ?? m?.name ?? own?.name,
        role: markGroup?.role ?? m?.role ?? own?.role,
        // (a group item's mark: vega's group mark holds it and its siblings of the same name)
        ...((p.item as SceneGroup).marktype === 'group' ? { node: groupMarkOf(p.item as SceneGroup, container) } : {}),
        get group(): PickedItem | null { return enclosing(markGroup ?? p.item) },
      } as PickedItem
    },
  }
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
 * only needs the svg element, the scene, the signal store, and hooks.
 */
export function bindSceneSignals(
  svg: SVGSVGElement,
  scene: SceneRoot,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: Pick<SignalBindOptions, 'pick' | 'data' | 'owner' | 'containerSize'> = {},
): SignalBinding {
  const chart = (scene as unknown as { compiled?: CompiledChart }).compiled
  const runtime = scene.runtime as ExpressionRuntime | undefined
  const signalParams = (scene as unknown as { signalParams?: Record<string, unknown> }).signalParams ?? {}
  if (!chart || !runtime) {
    // Non-interactive scene (no runtime handle): a no-op binding.
    return { detach: () => {}, release: () => {}, setSignal: () => {} }
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

/** @internal vega-scenegraph's intersect over the scene (the `intersect()` expression function's body); exported for the conformance gate. */
export { sceneIntersect } from './scene-intersect.js'
