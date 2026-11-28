/**
 * The resource `useSpecData` reads with `React.use`: one promise per load, found again by every render that asks for the same load.
 *
 * Suspense needs the SAME promise on every render of a suspended component, and React keeps no state (no ref, no memo) for a
 * component that has not committed yet: the only place a promise can live across those renders is a module-level cache, and the
 * only thing the renders share is what they pass. So the cache is keyed the way the React boundary compares inputs
 * (docs/ARCHITECTURE.md, "The React boundary"):
 *
 * - the spec by CONTENT (an inline literal rebuilt by every render is the same load; its inline rows too, since a load is keyed
 *   on what it would fetch and return, not on which array holds the rows);
 * - the data-valued options (`baseURL`, `protocols`, `timeoutMs`, `limits`, ...) by content;
 * - a stateful object (`signal`, an `AbortSignal`) by identity;
 * - a function option (`fetch`, `allow`) by IDENTITY (DECISIONS, later decisions: useSpecData function options). A function is
 *   not data and closures of the same code differ in what they capture (a per-request `fetch` on a server carries that request's
 *   credentials, and this module cache is shared by every request), so two different functions are never served one load.
 * - `cacheKey`, a string the host gives, by value: the one way to share a load across function identities. With it the host
 *   names the load, the functions are not part of the key, and the ones called are the latest given (a latest-ref), so an inline
 *   arrow is fine.
 *
 * An inline function option WITHOUT a `cacheKey` is a new identity on every render, so each retry of a suspended component asks
 * for a new load (C50). That is caught, not looped: when a render misses its load while the same spec and data options already
 * have a load that settled and was never read again (the previous attempt, abandoned by its retry), the inputs churn. After
 * `UNSTABLE_LOAD_LIMIT` such loads in a row, the ask throws an `AsterUnstableLoadOptionError` naming the option and the fix,
 * instead of fetching again. A load read again after it settled (a retry that found its own load, a mounted reader) proves the
 * inputs stable and clears the count. Before anything settles, a parent re-rendering the suspended tree misses too: once
 * `UNSTABLE_LOAD_LIMIT` loads of the same inputs are in flight that nobody asked for again, a further miss waits for them (a
 * stand-in that is no data) instead of fetching. So an inline function costs fewer than 2 x `UNSTABLE_LOAD_LIMIT` fetches, then
 * the typed error; `resetSpecDataErrors()` clears the count (a new attempt, bounded the same way).
 *
 * Lifetime: a load a mounted component reads stays while it is mounted; one nothing mounted reads (a component that suspended and
 * went away, a component that unmounted) is kept among the last `IDLE_LOADS` such loads, so a remount or a retry finds it, and is
 * then dropped.
 *
 * A rejected load stays: every render that asks for it reads the same rejection, so the error reaches the error boundary once and
 * nothing fetches again by itself (DECISIONS Q19). It is tried again when an input changes (another key) and after
 * `resetSpecDataErrors()`, which an error boundary calls when it is reset. The cache cannot tell a reset by itself: React keeps no
 * state for a component that never committed, and the render React retries after an error can run in a later task than the one
 * that threw (it yields while rendering), so "the next render" is not "after the reset". Dropping a rejection by time therefore
 * starts a new load inside React's own retry, which fails, is retried, and so on: the loop of C48.
 */
import type { VgSpec } from '@aster-charts/core'
import type { LoadOptions } from '@aster-charts/core/load'

/** The loader's options plus the host's own name for a load (see `cacheKey` above). */
export type SpecDataOptions = LoadOptions & { cacheKey?: string }

/** Loads one spec and set of data options may start, with function options that change identity, before the ask throws. */
export const UNSTABLE_LOAD_LIMIT = 3

/**
 * `useSpecData` (or `loadSpecDataResource`) was given a function option that is a new function on every render, so a suspended
 * component would start a new load on every retry. `options` names the function options that changed.
 */
export class AsterUnstableLoadOptionError extends Error {
  readonly code = 'ASTER_UNSTABLE_LOAD_OPTION'
  readonly options: readonly string[]
  constructor(options: readonly string[], loads: number) {
    const names = options.map((n) => `\`${n}\``).join(', ')
    super(`[aster] useSpecData: ${names || 'a function option'} is a new function on every render, so every retry of the suspended `
      + `component starts a new load (${loads} so far). Hoist it out of the component (or keep it in a stable reference, such as a `
      + `module-level function), or pass a \`cacheKey\` that names the load: with one, the latest function given is used.`)
    this.name = 'AsterUnstableLoadOptionError'
    this.options = options
  }
}

/** A promise React can read synchronously once it has settled (the fields React's own `use` bookkeeping sets). */
type Tracked<T> = Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown }

interface Load {
  readonly key: string
  readonly family: Family
  readonly promise: Tracked<VgSpec>
  /** The latest function options given for this load (read when the loader calls them). */
  functions: Record<string, (...args: never[]) => unknown>
  /** Mounted components reading it. */
  users: number
  /** It has settled. */
  settled: boolean
  /** It was asked for again after it settled (its inputs are stable). */
  readAfterSettle: boolean
  /** It was asked for again at all after it was started. */
  readAgain: boolean
}

/** The loads of one spec and set of data options, whatever their function identities. */
interface Family {
  readonly key: string
  readonly loads: Set<Load>
  /** Loads started in a row while an earlier one was abandoned (see the module comment). */
  churn: number
}
const families = new Map<string, Family>()

/** Loads nothing mounted reads that are kept, oldest dropped first. */
export const IDLE_LOADS = 32

const loads = new Map<string, Load>()
/** Keys of the loads with no mounted reader, oldest first (a Map keeps insertion order). */
const idle = new Map<string, true>()

const objectIds = new WeakMap<object, number>()
let objectSeq = 0
function objectId(o: object): number {
  let id = objectIds.get(o)
  if (id === undefined) objectIds.set(o, (id = ++objectSeq))
  return id
}

const MAX_DEPTH = 64
const specKeys = new WeakMap<object, string>()

/**
 * Canonical text of a JSON-shaped value: plain objects with sorted keys, arrays in order, numbers and strings as JSON writes them
 * (with `-0`, `NaN` and the infinities told apart), a `Date` by its time. Anything else (a function, a Map, a class instance) and
 * a structure deeper than 64 levels or cyclic stand for themselves (by identity), so two of them are never the same content.
 */
function contentKey(value: unknown, depth = 0, seen: Set<object> = new Set()): string {
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'number': return Object.is(value, -0) ? '-0' : Number.isFinite(value) ? String(value) : `n:${String(value)}`
    case 'boolean': return value ? 'true' : 'false'
    case 'undefined': return 'u'
    case 'bigint': return `${String(value)}n`
    case 'symbol':
    case 'function': return `#${objectId(value as object)}`
  }
  if (value === null) return 'null'
  const o = value as object
  if (o instanceof Date) return `d:${o.getTime()}`
  if (depth > MAX_DEPTH || seen.has(o)) return `#${objectId(o)}`
  if (Array.isArray(o)) {
    seen.add(o)
    let out = '['
    for (let i = 0; i < o.length; i++) out += (i ? ',' : '') + contentKey(o[i], depth + 1, seen)
    seen.delete(o)
    return out + ']'
  }
  const proto = Object.getPrototypeOf(o) as unknown
  if (proto !== Object.prototype && proto !== null) return `#${objectId(o)}`
  seen.add(o)
  const rec = o as Record<string, unknown>
  let out = '{'
  let first = true
  for (const k of Object.keys(rec).sort()) {
    if (rec[k] === undefined) continue
    out += (first ? '' : ',') + JSON.stringify(k) + ':' + contentKey(rec[k], depth + 1, seen)
    first = false
  }
  seen.delete(o)
  return out + '}'
}

/** The spec's content key, computed once per spec object. */
function specKey(spec: VgSpec): string {
  if (spec === null || typeof spec !== 'object') return contentKey(spec)
  let key = specKeys.get(spec)
  if (key === undefined) specKeys.set(spec, (key = contentKey(spec)))
  return key
}

/** The options' key (see the module comment) and their functions. */
function optionsKey(options: SpecDataOptions): { key: string; functions: Record<string, (...args: never[]) => unknown> } {
  const functions: Record<string, (...args: never[]) => unknown> = {}
  let key = ''
  for (const name of Object.keys(options).sort()) {
    const v = (options as Record<string, unknown>)[name]
    if (v === undefined) continue
    let part: string
    if (typeof v === 'function') {
      functions[name] = v as (...args: never[]) => unknown
      // (by identity, unless the host names the load: then the latest function is called through a forwarder)
      part = options.cacheKey !== undefined ? 'f' : `f#${objectId(v)}`
    } else if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) {
      part = `#${objectId(v)}`
    } else {
      part = contentKey(v)
    }
    key += `${JSON.stringify(name)}=${part};`
  }
  return { key, functions }
}

/** The options' key with the function identities left out: the family of loads they belong to. */
function familyKey(options: SpecDataOptions): string {
  let key = ''
  for (const name of Object.keys(options).sort()) {
    const v = (options as Record<string, unknown>)[name]
    if (v === undefined) continue
    key += `${JSON.stringify(name)}=${typeof v === 'function' ? 'f' : typeof AbortSignal !== 'undefined' && v instanceof AbortSignal ? `#${objectId(v)}` : contentKey(v)};`
  }
  return key
}

function drop(key: string): void {
  const load = loads.get(key)
  if (!load) return
  loads.delete(key)
  idle.delete(key)
  load.family.loads.delete(load)
  // (a family with no loads left and nothing counted is forgotten; one whose inputs churned keeps its count)
  if (load.family.loads.size === 0 && load.family.churn === 0) {
    if (families.get(load.family.key) === load.family) families.delete(load.family.key)
  }
}

function markIdle(load: Load): void {
  idle.delete(load.key)
  idle.set(load.key, true)
  while (idle.size > IDLE_LOADS) {
    drop(idle.keys().next().value as string)
  }
}

function start(key: string, family: Family, spec: VgSpec, options: SpecDataOptions, functions: Load['functions']): Load {
  const load: Load = { key, family, promise: undefined as never, functions, users: 0, settled: false, readAfterSettle: false, readAgain: false }
  // the loader gets the data options as given and, for each function option, a forwarder to the latest one
  const { cacheKey: _name, ...loaderOptions } = options
  const call: Record<string, unknown> = { ...loaderOptions }
  for (const name of Object.keys(functions)) call[name] = (...args: never[]) => load.functions[name]!(...args)
  const promise: Tracked<VgSpec> = import('@aster-charts/core/load').then((mod) => mod.loadSpecData(spec, call as LoadOptions))
  promise.status = 'pending'
  promise.then(
    (value) => { promise.status = 'fulfilled'; promise.value = value; load.settled = true },
    (reason: unknown) => { promise.status = 'rejected'; promise.reason = reason; load.settled = true },
  )
  ;(load as { promise: Tracked<VgSpec> }).promise = promise
  loads.set(key, load)
  family.loads.add(load)
  markIdle(load)
  return load
}

/**
 * The load for these inputs: the one already made, or a new one. The function options given become its latest. Throws
 * `AsterUnstableLoadOptionError` when function options that change identity on every ask would start one load per ask.
 */
export function acquireSpecData(spec: VgSpec, options: SpecDataOptions): Load {
  const { key: optKey, functions } = optionsKey(options)
  const sKey = specKey(spec)
  const key = `${sKey}|${optKey}`
  const fKey = `${sKey}|${familyKey(options)}`
  let family = families.get(fKey)
  if (!family) families.set(fKey, (family = { key: fKey, loads: new Set(), churn: 0 }))
  const load = loads.get(key)
  if (load !== undefined) {
    load.readAgain = true
    if (load.settled && !load.readAfterSettle) {
      load.readAfterSettle = true
      family.churn = 0
    }
    load.functions = functions
    return load
  }
  // a load of the same spec and data options that settled and was never asked for again, by nobody mounted: the attempt this
  // ask most likely retries, with new function identities
  let abandoned: Load | undefined
  for (const l of family.loads) if (l.settled && !l.readAfterSettle && l.users === 0) { abandoned = l; break }
  if (abandoned) {
    family.churn++
    if (family.churn >= UNSTABLE_LOAD_LIMIT) {
      const changed = Object.keys(functions).filter((n) => abandoned!.functions[n] !== functions[n]).sort()
      throw new AsterUnstableLoadOptionError(changed, family.loads.size)
    }
  }
  // While loads of this family that nobody read again are still in flight, a render that misses again (a parent re-rendering
  // the suspended tree with new function identities) waits for them instead of fetching: at most UNSTABLE_LOAD_LIMIT such loads
  // are in flight, so the fetches are bounded before the count above can trip. The wait is no load: when it ends the render is
  // retried and asks again.
  const unread = [...family.loads].filter((l) => !l.settled && !l.readAgain && l.users === 0)
  if (unread.length >= UNSTABLE_LOAD_LIMIT) return waitFor(unread, family)
  return start(key, family, spec, options, functions)
}

/** Whether `load` is a wait stand-in (see `waitFor`): its value is no data, and the ask is made again once it settles. */
export function isSpecDataWait(load: Load): boolean {
  return load.key === ''
}

/** A stand-in that settles when the first of `pending` settles; never cached, never data (see `acquireSpecData`). */
function waitFor(pending: readonly Load[], family: Family): Load {
  const promise: Tracked<VgSpec> = Promise.race(pending.map((l) => l.promise.then(() => undefined, () => undefined))).then(() => ({}) as VgSpec)
  return { key: '', family, promise, functions: {}, users: 0, settled: false, readAfterSettle: false, readAgain: false }
}

/**
 * Forget every load that failed, so the next ask for it loads again; returns how many were forgotten. Call it when an error boundary
 * above a `useSpecData` is reset (react-error-boundary's `onReset`, or your boundary's reset handler), before its children render
 * again. A load in flight or loaded is untouched.
 */
export function resetSpecDataErrors(): number {
  let n = 0
  for (const [key, load] of [...loads]) {
    if (load.promise.status !== 'rejected') continue
    drop(key)
    n++
  }
  // (a reset is a new attempt: inputs that churned get their bounded number of loads again)
  for (const family of families.values()) family.churn = 0
  return n
}

/** A mounted component reads `load`; returns the release for its unmount. */
export function retainSpecData(load: Load): () => void {
  load.users++
  idle.delete(load.key)
  return () => {
    load.users--
    if (load.users === 0 && loads.get(load.key) === load) markIdle(load)
  }
}

