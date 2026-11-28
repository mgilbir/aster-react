/**
 * A signal handler's `encode: <set>` (vega-parser: `update = 'encode(item(), <set>)'`; vega-functions `encode`): the event's item
 * is encoded again with the named encode set of its mark (`hover`, `leave`, `select`, ...), and keeps what that set wrote until the
 * mark's `update` set runs again on it (vega's Encode operator re-runs `update` on an item when a parameter of the mark's encode
 * sets, or the item's datum, changes): a channel only the named set writes stays as it was left.
 *
 * Aster's event loop does not hold the scenegraph between evaluations, so the loop records each request in the signal store it
 * hands the host (`ENCODE_LOG`, a symbol key: never a signal, carried by every copy of the store), and the evaluation applies the
 * requests to the items of the mark (runtime.ts). An item is named by its mark, the group instance it is in and its row
 * (`stampEncodeIdent`, written by the evaluation on the items of marks that have such sets), as vega names it by its tuple.
 *
 * A mark's `on` triggers (`modify` of one of its items, with `values`: vega-functions modify.js over the mark's items) go the same way:
 * the loop records each property write of an item in the same log (`ItemWrite`), and the evaluation sets the properties on the item
 * (before the mark's transforms run: a `force` transform reads the `fx` and `fy` a write gave a node). The mark's `update` set runs
 * again on a modified item, so a channel it writes is not changed by a write; the other properties stay on the item until it goes.
 */

/** The key of the store entry holding the requests (a symbol: not a signal, not serialised). */
export const ENCODE_LOG: unique symbol = Symbol.for('aster.encodeLog') as never

/** One request: encode the item `ident` with the set `set`; `seq` orders the requests of one log. */
interface EncodeRequest {
  readonly ident: string
  readonly set: string
  readonly seq: number
}

/**
 * One property written onto an item by a mark's `modify` trigger. `datum` is the item's datum as text when the write was made: the
 * item at that place stands for the same tuple only while its datum is the same (rows that came or went make another item of it).
 */
export interface ItemWrite {
  readonly ident: string
  readonly field: string
  readonly value: unknown
  readonly datum: string
  readonly seq: number
}

/**
 * The requests of one chart on one host: `session` names what the evaluation remembers of them (one per event-loop owner state),
 * `rev` changes with every request. At most one request per item and set is kept: the latest. The same for the writes, per item and
 * property.
 */
export interface EncodeLog {
  readonly session: object
  readonly rev: number
  readonly requests: readonly EncodeRequest[]
  readonly writes: readonly ItemWrite[]
}

const IDENT = new WeakMap<object, string>()

/** Name a scene item for the requests: `<mark>|<group instance>|<row>`. */
export function stampEncodeIdent(item: object, ident: string): void {
  IDENT.set(item, ident)
}

/** The encode sets a mark of an item has, besides `enter` and `exit` (written with its ident: see `stampEncodeSets`). */
const SETS = new WeakMap<object, readonly string[]>()

/** Record the encode sets of an item's mark (its named sets, and `update` when it has one), for `view.hover()` (signals.ts). */
export function stampEncodeSets(item: object, sets: readonly string[]): void {
  SETS.set(item, sets)
}

/** The name of the mark an item is in (the spec's own), for the marks that have `on` triggers: `modify` of another mark's item changes nothing. */
const MARK_NAMES = new WeakMap<object, string>()
export function stampItemMark(item: object, name: string): void {
  MARK_NAMES.set(item, name)
}
/** The name of the mark of a scene item, or of the item an event facade is made over, else undefined. */
export function itemMarkNameOf(item: unknown): string | undefined {
  for (let o = item; o !== null && typeof o === 'object'; o = Object.getPrototypeOf(o)) {
    const name = MARK_NAMES.get(o as object)
    if (name !== undefined) return name
  }
  return undefined
}

/** The encode sets of the mark of a scene item, or of the item an event facade is made over, else undefined. */
export function encodeSetsOf(item: unknown): readonly string[] | undefined {
  for (let o = item; o !== null && typeof o === 'object'; o = Object.getPrototypeOf(o)) {
    const sets = SETS.get(o as object)
    if (sets !== undefined) return sets
  }
  return undefined
}

/** Whether a mark of a chart, at any depth, has the encode set `name`. */
export function hasSetIn(marks: readonly MarkLike[] | undefined, name: string): boolean {
  for (const m of marks ?? []) if ((m.encode?.[name] != null) || hasSetIn(m.marks, name)) return true
  return false
}

/** The name of a scene item, or of the item an event facade is made over (its prototype chain), else undefined. */
export function encodeIdentOf(item: unknown): string | undefined {
  for (let o = item; o !== null && typeof o === 'object'; o = Object.getPrototypeOf(o)) {
    const id = IDENT.get(o as object)
    if (id !== undefined) return id
  }
  return undefined
}

/** A log with `request` added (it replaces the previous request of the same item and set). */
export function withRequest(log: EncodeLog | undefined, session: object, ident: string, set: string): EncodeLog {
  const kept = (log?.requests ?? []).filter((r) => r.ident !== ident || r.set !== set)
  const seq = (log?.rev ?? 0) + 1
  return Object.freeze({ session, rev: seq, requests: Object.freeze([...kept, Object.freeze({ ident, set, seq })]), writes: log?.writes ?? NO_WRITES })
}

/** A datum as text, for telling the item of a tuple from the item another tuple has in its place (the event loop writes the same text). */
export function datumText(datum: unknown): string {
  try { return JSON.stringify(datum) ?? '' } catch { return '?' }
}

const NO_WRITES: readonly ItemWrite[] = Object.freeze([])

/** A log with the writes `props` of the item `ident` added (each replaces the previous write of that item and property). */
export function withWrites(log: EncodeLog | undefined, session: object, ident: string, datum: string, props: ReadonlyArray<readonly [string, unknown]>): EncodeLog {
  const fields = new Set(props.map(([k]) => k))
  const kept = (log?.writes ?? NO_WRITES).filter((w) => w.ident !== ident || !fields.has(w.field))
  const seq = (log?.rev ?? 0) + 1
  const added = props.map(([field, value]) => Object.freeze({ ident, field, value, datum, seq }))
  return Object.freeze({ session, rev: seq, requests: log?.requests ?? Object.freeze([]), writes: Object.freeze([...kept, ...added]) })
}

/** The log a signal store holds, if any. */
export function encodeLogOf(signals: unknown): EncodeLog | undefined {
  if (signals === null || typeof signals !== 'object') return undefined
  const log = (signals as Record<symbol, unknown>)[ENCODE_LOG] as EncodeLog | undefined
  return log !== undefined && typeof log === 'object' && Array.isArray(log.requests) ? log : undefined
}

interface MarkLike {
  readonly encode?: Readonly<Record<string, unknown>>
  readonly marks?: readonly MarkLike[]
  readonly userName?: string
  readonly on?: readonly unknown[]
}

/** Whether a named mark has `on` triggers (vega parses them for a named mark only). */
export const hasTriggers = (mark: MarkLike): boolean => mark.userName !== undefined && Array.isArray(mark.on) && mark.on.length > 0
/** Whether the event loop can ask the evaluation for something about the items of a mark: a named encode set, or a trigger of its own. */
export const handlesItems = (mark: MarkLike): boolean => namedSetsOf(mark).length > 0 || hasTriggers(mark)
const BASE_SETS: ReadonlySet<string> = new Set(['enter', 'update', 'exit'])
const NAMED = new WeakMap<object, readonly string[]>()
const IN_SUBTREE = new WeakMap<object, boolean>()

/** The encode sets of a mark a handler can name: every set but `enter`, `update` and `exit`. */
export function namedSetsOf(mark: MarkLike): readonly string[] {
  let out = NAMED.get(mark)
  if (out === undefined) NAMED.set(mark, (out = Object.keys(mark.encode ?? {}).filter((k) => !BASE_SETS.has(k) && mark.encode![k] != null)))
  return out
}

/** Whether a mark, or a mark inside it, has a named encode set or a trigger (see `handlesItems`). */
export function hasNamedSetsIn(mark: MarkLike): boolean {
  let out = IN_SUBTREE.get(mark)
  if (out === undefined) IN_SUBTREE.set(mark, (out = handlesItems(mark) || (mark.marks ?? []).some(hasNamedSetsIn)))
  return out
}

/** What a mark's items keep of the requests, per session: per item, the last request applied and the channels it left. */
interface KeptChannel { value: unknown; print: string }
/** `written`: the properties a mark's `modify` trigger gave the item, with the datum the item had then and the last write applied. */
interface KeptItem { done: number; channels: Map<string, KeptChannel>; written?: { datum: string; values: Map<string, unknown>; done: number } }
const KEPT = new WeakMap<object, Map<string, KeptItem>>()
export function keptItems(session: object): Map<string, KeptItem> {
  let m = KEPT.get(session)
  if (m === undefined) KEPT.set(session, (m = new Map()))
  return m
}
