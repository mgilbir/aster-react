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
  VERSIONS.set(arr, (VERSIONS.get(arr) ?? 0) + 1)
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
