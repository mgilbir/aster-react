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
 * - a function option (`fetch`, `allow`) through a latest-ref: an inline arrow rebuilt by every render is the same option, and
 *   the function called is the latest one given. A function is not data: it cannot be compared by content, and comparing it by
 *   identity makes every inline arrow a new load, which a suspended component asks for again on every retry (C50). Its CODE is in
 *   the key all the same, as a guard: two components whose `allow` differ in code are never served one load, so a component is
 *   never handed rows that only another component's veto let through.
 * - `cacheKey`, a string the host gives, by value. Functions with the same code that close over different values (a `fetch` made
 *   per user by one factory, a per-request `fetch` on a server, where this module cache is shared by every request) are the same
 *   option to the cache; a host that needs such loads kept apart gives each its own `cacheKey`, as it gives a query library a
 *   query key.
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

/** A promise React can read synchronously once it has settled (the fields React's own `use` bookkeeping sets). */
type Tracked<T> = Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown }

interface Load {
  readonly key: string
  readonly promise: Tracked<VgSpec>
  /** The latest function options given for this load (read when the loader calls them). */
  functions: Record<string, (...args: never[]) => unknown>
  /** Mounted components reading it. */
  users: number
}

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
      part = `f:${Function.prototype.toString.call(v)}`
    } else if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) {
      part = `#${objectId(v)}`
    } else {
      part = contentKey(v)
    }
    key += `${JSON.stringify(name)}=${part};`
  }
  return { key, functions }
}

function markIdle(load: Load): void {
  idle.delete(load.key)
  idle.set(load.key, true)
  while (idle.size > IDLE_LOADS) {
    const oldest = idle.keys().next().value as string
    idle.delete(oldest)
    loads.delete(oldest)
  }
}

function start(key: string, spec: VgSpec, options: SpecDataOptions, functions: Load['functions']): Load {
  const load: Load = { key, promise: undefined as never, functions, users: 0 }
  // the loader gets the data options as given and, for each function option, a forwarder to the latest one
  const { cacheKey: _name, ...loaderOptions } = options
  const call: Record<string, unknown> = { ...loaderOptions }
  for (const name of Object.keys(functions)) call[name] = (...args: never[]) => load.functions[name]!(...args)
  const promise: Tracked<VgSpec> = import('@aster-charts/core/load').then((mod) => mod.loadSpecData(spec, call as LoadOptions))
  promise.status = 'pending'
  promise.then(
    (value) => { promise.status = 'fulfilled'; promise.value = value },
    (reason: unknown) => { promise.status = 'rejected'; promise.reason = reason },
  )
  ;(load as { promise: Tracked<VgSpec> }).promise = promise
  loads.set(key, load)
  markIdle(load)
  return load
}

/** The load for these inputs: the one already made, or a new one. The function options given become its latest. */
export function acquireSpecData(spec: VgSpec, options: SpecDataOptions): Load {
  const { key: optKey, functions } = optionsKey(options)
  const key = `${specKey(spec)}|${optKey}`
  let load = loads.get(key)
  if (load === undefined) return start(key, spec, options, functions)
  load.functions = functions
  return load
}

/**
 * Forget every load that failed, so the next ask for it loads again; returns how many were forgotten. Call it when an error boundary
 * above a `useSpecData` is reset (react-error-boundary's `onReset`, or your boundary's reset handler), before its children render
 * again. A load in flight or loaded is untouched.
 */
export function resetSpecDataErrors(): number {
  let n = 0
  for (const [key, load] of loads) {
    if (load.promise.status !== 'rejected') continue
    loads.delete(key)
    idle.delete(key)
    n++
  }
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

export type { Load as SpecDataLoad }
