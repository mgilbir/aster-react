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
 * The requests of one chart on one host: `session` names what the evaluation remembers of them (one per event-loop owner state),
 * `rev` changes with every request. At most one request per item and set is kept: the latest.
 */
export interface EncodeLog {
  readonly session: object
  readonly rev: number
  readonly requests: readonly EncodeRequest[]
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
  return Object.freeze({ session, rev: seq, requests: Object.freeze([...kept, Object.freeze({ ident, set, seq })]) })
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
}
const BASE_SETS: ReadonlySet<string> = new Set(['enter', 'update', 'exit'])
const NAMED = new WeakMap<object, readonly string[]>()
const IN_SUBTREE = new WeakMap<object, boolean>()

/** The encode sets of a mark a handler can name: every set but `enter`, `update` and `exit`. */
export function namedSetsOf(mark: MarkLike): readonly string[] {
  let out = NAMED.get(mark)
  if (out === undefined) NAMED.set(mark, (out = Object.keys(mark.encode ?? {}).filter((k) => !BASE_SETS.has(k) && mark.encode![k] != null)))
  return out
}

/** Whether a mark, or a mark inside it, has a named encode set. */
export function hasNamedSetsIn(mark: MarkLike): boolean {
  let out = IN_SUBTREE.get(mark)
  if (out === undefined) IN_SUBTREE.set(mark, (out = namedSetsOf(mark).length > 0 || (mark.marks ?? []).some(hasNamedSetsIn)))
  return out
}

/** What a mark's items keep of the requests, per session: per item, the last request applied and the channels it left. */
interface KeptChannel { value: unknown; print: string }
interface KeptItem { done: number; channels: Map<string, KeptChannel> }
const KEPT = new WeakMap<object, Map<string, KeptItem>>()
export function keptItems(session: object): Map<string, KeptItem> {
  let m = KEPT.get(session)
  if (m === undefined) KEPT.set(session, (m = new Map()))
  return m
}
