/**
 * Content stamps: what stands for "this array holds what it held" in the engine's reuse.
 *
 * The engine hands out arrays it later advances in place for O(changed) cost: a pulse advances a dataset's step arrays (after
 * `claim`, runtime.ts), and an append advances a mark's items array. So an array's identity is not its content. Every reuse decision
 * that would compare an engine-written array by identity compares its stamp instead -- the array AND how many times it was written
 * in place -- through this one module:
 *
 * - `wrote(arr)` is called by the code that writes a published array in place, at the write (the two gates above);
 * - `pin(arr)` records the array as it is now, `samePin(p, arr)` tells whether `arr` is that array, unwritten since;
 * - `stampKey(v)` is the same as a string, for keys (`valueKey` past its structural budget).
 *
 * A stamp that did not move is an array that holds what it held: incremental-shapes.test.ts checks that invariant over every array
 * a scene publishes, after every generated update.
 */

const IDS = new WeakMap<object, number>()
const VERSIONS = new WeakMap<object, number>()
let seq = 0

/** A process-unique id for an object (its identity, as a number). */
export function idOf(v: object): number {
  let id = IDS.get(v)
  if (id === undefined) IDS.set(v, (id = ++seq))
  return id
}

/** Say that `arr` (an array, or another engine structure) was written in place: every stamp taken of it before no longer matches. */
export function wrote(arr: object): void {
  // (a history of the content before, if a reader keeps one, gets a copy: this gate does not journal the write)
  const kept = HISTORIES.get(arr)
  if (kept !== undefined && kept.version === versionOf(arr) && kept.after === undefined && kept.copy === undefined && Array.isArray(arr)) {
    HISTORIES.delete(arr)
    kept.copy = arr.slice()
  }
  VERSIONS.set(arr, (VERSIONS.get(arr) ?? 0) + 1)
}

/**
 * Open a journalled write of `arr` (a claim, before a pulse advances the array in place): the stamps taken before no longer match,
 * and the history readers keep of the content before (`keepHistory`) is answered from the content after and the journal -- the length
 * it had and the old value of each slot overwritten (`beforeWrite`) -- so a write costs O(changed), not a copy of the array. Closed by
 * `endWrite`. A journalled write may only overwrite slots (after `beforeWrite`) and add slots past the end.
 */
export function beginWrite(arr: object): void {
  const v = versionOf(arr)
  VERSIONS.set(arr, v + 1)
  const kept = HISTORIES.get(arr)
  if (kept === undefined || kept.version !== v || !Array.isArray(arr) || kept.copy !== undefined) return
  const after: Version = { version: v + 1 }
  kept.len = arr.length
  kept.slots = new Map()
  kept.after = after
  HISTORIES.set(arr, after)
  JOURNALS.set(arr, kept)
}

/** Before a journalled write overwrites `arr[i]` (see `beginWrite`). */
export function beforeWrite(arr: readonly unknown[], i: number): void {
  const j = JOURNALS.get(arr)
  if (j !== undefined && i < j.len! && !j.slots!.has(i)) j.slots!.set(i, arr[i])
}

/** Close a journalled write: the stamps taken while it ran no longer match either; the history of the content after is the array's. */
export function endWrite(arr: object): void {
  JOURNALS.delete(arr)
  const v = versionOf(arr) + 1
  VERSIONS.set(arr, v)
  const h = HISTORIES.get(arr)
  if (h !== undefined) h.version = v
}

/**
 * An array's content as it is now, kept for readers that outlive later writes (a scene's datasets, DECISIONS Q14: a scene's rows are
 * that scene's): the array itself while it is not written; after a journalled write, the content after (`after`, the next version)
 * cut to the length it had and with the overwritten slots put back; after any other write, the copy `wrote` took. One record per
 * version of an array, shared by every reader of that version: the array holds one entry and nothing keeps a reader alive. (The
 * engine never edits a published row object in place, which the incremental differential checks.)
 *
 * The record of a version does not hold the array: the tables below are keyed by the array, and a value that holds its own key keeps
 * it alive through every minor GC (V8's scavenger treats an old table's values as roots), so each array a scene published -- a host's
 * rows, 80 kB at 10k rows -- would be promoted and live until the next full collection. The reader's handle holds the array.
 */
interface Version {
  version: number
  copy?: readonly unknown[]
  len?: number
  slots?: Map<number, unknown>
  after?: Version
}
/** A reader's hold on an array's content at one version (see `keepHistory`). */
export interface History {
  readonly of: readonly unknown[]
  readonly at: Version
}
const HISTORIES = new WeakMap<object, Version>()
const JOURNALS = new WeakMap<object, Version>()

export function keepHistory(arr: readonly unknown[]): History {
  const version = versionOf(arr)
  let at = HISTORIES.get(arr)
  if (at === undefined || at.version !== version) HISTORIES.set(arr, (at = { version }))
  return { of: arr, at }
}

/** The content a history kept (rebuilt once from the writes after it, then kept). */
export function historical(h: History): readonly unknown[] {
  const first = h.at
  if (first.copy !== undefined) return first.copy
  if (first.after === undefined) return h.of
  // (down the chain of later writes, then back up: a long-lived scene may be many writes behind; every version is of the same array)
  const chain: Version[] = []
  let at: Version = first
  while (at.copy === undefined && at.after !== undefined) { chain.push(at); at = at.after }
  let content: readonly unknown[] = at.copy ?? h.of
  for (let k = chain.length - 1; k >= 0; k--) {
    const c = chain[k]!
    const out = content.slice(0, c.len)
    for (const [i, v] of c.slots!) out[i] = v
    c.copy = content = out
    c.after = undefined
    c.slots = undefined
  }
  return content
}

/** How many times `v` was written in place (a primitive never is). */
export function versionOf(v: unknown): number {
  return v !== null && typeof v === 'object' ? VERSIONS.get(v) ?? 0 : 0
}

/** A value as it is now: the value and, for an object, its version. */
export interface Pin<T = unknown> { readonly of: T; readonly version: number }

export function pin<T>(v: T): Pin<T> {
  return { of: v, version: versionOf(v) }
}

/** Whether `v` is the value `p` pinned, an object not written in place since. */
export function samePin(p: Pin | undefined, v: unknown): boolean {
  return p !== undefined && p.of === v && p.version === versionOf(v)
}

/** Pins of each of `vs`. */
export function pinAll<T>(vs: readonly T[]): Array<Pin<T>> {
  return vs.map(pin)
}

/** Whether each of `vs` is the value pinned at its index, unwritten since. */
export function samePins(ps: readonly Pin[], vs: readonly unknown[]): boolean {
  if (ps.length !== vs.length) return false
  for (let i = 0; i < ps.length; i++) if (!samePin(ps[i], vs[i])) return false
  return true
}

/** The stamp of an object as a key: its identity and its version. */
export function stampKey(v: object): string {
  return `#${idOf(v)}.${versionOf(v)}`
}
