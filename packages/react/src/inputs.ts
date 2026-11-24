/**
 * The React boundary's inputs: how a component or hook compares them from one render to the next (the identity rule) and how
 * it checks them before anything is evaluated (every failure goes to the one error channel). `<Chart>`, `<SvgChart>` and the
 * hooks share these, so a prop means the same thing everywhere (docs/API.md, "How props are compared").
 *
 * The identity rule:
 * - JSON-shaped values (`spec`, `limits`, `signals`, `view`, `brush`, `selection`, `a11y` options) are compared by CONTENT: an
 *   inline literal rebuilt on every render is the same input (`useStableContent`).
 * - `data` is compared dataset by dataset: the same keys with the same row arrays is the same input, whatever the object
 *   holding them (`useDataInput`); a dataset's rows are compared by identity, and a new array is diffed by the session.
 * - Callbacks (`onError`, `onSignal`, `onSelect`, ... and the functions of `urlPolicy`) are read through a latest-ref: a new
 *   function identity is never a change, and the latest one is the one called.
 * - Stateful objects the chart cannot compare (`random`, `textMetrics`, `tooltipContainer`, the capabilities) are compared by
 *   identity: memoize them.
 * - State an event writes (a bound input, a `signal.on` handler, a brush, a zoom) lives in the component; a prop never is
 *   copied into it. The two are merged when the chart reads them, so removing a prop's key is expressible.
 */
import * as React from 'react'
import type { ImageUrlPolicy, Logger } from '@aster-charts/core'
import { contentEqual, describeValue as describe, useStableContent } from './spec.js'

/** The value of the last render, read by callbacks and effects that must not re-run when it changes identity. */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = React.useRef(value)
  ref.current = value
  return ref
}

/** What `useDataInput` gives back: the datasets a chart evaluates with, or why they were refused. */
export type DataInput = { data: Record<string, unknown[]> | undefined; error: null } | { data: undefined; error: TypeError }

/**
 * Check the `data` prop: an object of datasets, each an array of rows. A dataset whose rows are `undefined` is not given (as if
 * the key were absent: the spec's own `values` apply), so `data={{ table: query.data }}` while a query loads draws the spec
 * without those rows; any other value that is not an array (`null`, an object, a string, a number) is refused with a
 * `TypeError` that names the dataset. `data` itself may be `undefined` or `null` (no datasets given).
 */
export function readDataInput(data: unknown): Record<string, unknown[]> | undefined {
  if (data == null) return undefined
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError(`[aster] data must be an object of datasets ({ name: rows[] }); got ${describe(data)}`)
  }
  let out: Record<string, unknown[]> | undefined
  for (const name of Object.keys(data)) {
    const rows = (data as Record<string, unknown>)[name]
    if (rows === undefined) continue
    if (!Array.isArray(rows)) throw new TypeError(`[aster] data[${JSON.stringify(name)}] must be an array of rows; got ${describe(rows)}`)
    ;(out ??= {})[name] = rows
  }
  return out
}

/** The same datasets: the same names with the same row arrays. */
function sameDatasets(a: Record<string, unknown[]> | undefined, b: Record<string, unknown[]> | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}

/**
 * The `data` prop, checked (`readDataInput`) and stable: while it holds the same datasets with the same row arrays, the same
 * object is returned, so a `data={{ table: rows }}` literal rebuilt by every render of the parent changes nothing.
 */
export function useDataInput(data: unknown): DataInput {
  const ref = React.useRef<DataInput>({ data: undefined, error: null })
  let next: DataInput
  try {
    next = { data: readDataInput(data), error: null }
  } catch (e) {
    next = { data: undefined, error: e as TypeError }
  }
  const prev = ref.current
  if (next.error === null && prev.error === null && sameDatasets(prev.data, next.data)) return prev
  if (next.error !== null && prev.error !== null && prev.error.message === next.error.message) return prev
  ref.current = next
  return next
}

/**
 * Check a size prop (`width` / `height`): a finite number of pixels, at least 0, or `'container'` (the element's measured
 * size). Anything else is refused with a `TypeError` naming the prop, never replaced by another size.
 */
export function checkSizeProp(name: 'width' | 'height', value: unknown): void {
  if (value === undefined || value === 'container') return
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return
  throw new TypeError(`[aster] ${name} must be a finite number of pixels (0 or more) or 'container'; got ${describe(value)}`)
}

/**
 * `urlPolicy`, stable by content: its plain values compared by content, its functions (`allow`, `onDeny`) through a
 * latest-ref. An inline policy object (a new `allow` arrow on every render) is the same policy, and the function called is
 * the latest; a policy that gains or loses a function, or changes a value, is a new one.
 */
export function useStablePolicy(policy: ImageUrlPolicy | undefined): ImageUrlPolicy | undefined {
  const latest = useLatest(policy)
  const shape = policy === undefined ? undefined : policyShape(policy)
  const stableShape = useStableContent(shape)
  return React.useMemo(() => {
    if (stableShape === undefined) return undefined
    const out: Record<string, unknown> = { ...stableShape }
    for (const key of Object.keys(stableShape)) {
      if (stableShape[key] !== FUNCTION) continue
      out[key] = (...args: unknown[]) => (latest.current as Record<string, (...a: unknown[]) => unknown> | undefined)?.[key]?.(...args)
    }
    return out as ImageUrlPolicy
  }, [stableShape, latest])
}

/**
 * `logger`, stable: one proxy per "a logger is given or not", which always calls the latest logger's methods. A logger rebuilt by
 * every render (an inline `{ error, warn }` literal) is the same input, so it never re-evaluates a chart nor re-posts a request.
 */
export function useStableLogger(logger: Logger | undefined): Logger | undefined {
  const latest = useLatest(logger)
  const given = logger != null
  return React.useMemo<Logger | undefined>(() => (given
    ? {
      error: (...a) => latest.current?.error(...a),
      warn: (...a) => latest.current?.warn(...a),
      info: (...a) => latest.current?.info?.(...a),
      debug: (...a) => latest.current?.debug?.(...a),
    }
    : undefined), [given, latest])
}

/** Marks a function member of a policy in its shape (see `useStablePolicy`). */
const FUNCTION = '\u0000function'
function policyShape(policy: ImageUrlPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(policy)) out[k] = typeof v === 'function' ? FUNCTION : v
  return out
}

/**
 * The signal values events wrote (a bound input, a `signal.on` handler, `setSignal`), with the moment each was written. Only
 * events write here; the `signals` prop is never copied in (see `useControlledSignals`, which merges the two when the chart
 * reads them).
 */
export interface EventSignals {
  /**
   * The event loop's signal set as it last reported it: what it reported changed, and also what it holds without having changed
   * it (a handler's assignment of the value the signal had, a derived signal it left as it was, with its internal marker), which
   * pin those signals as vega's dataflow does. It was seeded with the chart's merged values, the prop's among them.
   */
  readonly values: Readonly<Record<string, unknown>>
  /** When each signal an event changed was written: a tick of `clock`. */
  readonly written: Readonly<Record<string, number>>
  /** The tick of the last write. */
  readonly clock: number
}

export interface EventSignalStore {
  get: () => EventSignals
  subscribe: (listener: () => void) => () => void
  /**
   * Events changed `changed` (one write, one tick). `all` is the event loop's whole signal set after them, when it reports
   * one; without it the changed values are set on the current one.
   */
  write: (changed: Readonly<Record<string, unknown>>, all?: Readonly<Record<string, unknown>>) => void
}

const NO_EVENTS: EventSignals = Object.freeze({ values: Object.freeze({}), written: Object.freeze({}), clock: 0 })

export function createEventSignalStore(): EventSignalStore {
  let snapshot = NO_EVENTS
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    write(changed, all) {
      const clock = snapshot.clock + 1
      const written = { ...snapshot.written }
      for (const name of Object.keys(changed)) written[name] = clock
      snapshot = { values: { ...(all ?? snapshot.values), ...changed }, written, clock }
      for (const l of listeners) l()
    },
  }
}

/** An event loop's own key in its signal set (a held derived signal's marker): never a name an expression reads. */
const isLoopKey = (name: string): boolean => name.charCodeAt(0) === 0

/**
 * The chart's signal values: the `signals` prop merged with what events wrote, at read time.
 *
 * `signals` is CONTROLLED by content, and the latest writer of a signal wins: a key whose value changes (by content, so an
 * inline literal rebuilt by every render is no change) wins over what an event wrote before; an event that writes it
 * afterwards wins until the prop's value changes again (the event is reported through `onSignal` / `signalListeners`). A key
 * removed from the prop is released: if an event wrote the signal after the prop last set it, the event's value stays,
 * else the signal is the spec's own again. A value the prop gave is never kept once the prop stops giving it.
 */
export function useControlledSignals(signals: Readonly<Record<string, unknown>> | undefined, events: EventSignals): Record<string, unknown> {
  const controlled = useStableContent(signals)
  // When each controlled key last changed, in the event store's ticks: derived state, recomputed while rendering when the prop's
  // content changes (React discards it with the render if that render is not committed).
  const [control, setControl] = React.useState(() => ({ prop: controlled, since: sinceOf(undefined, controlled, {}, 0) }))
  let current = control
  if (control.prop !== controlled) {
    current = { prop: controlled, since: sinceOf(control.prop, controlled, control.since, events.clock) }
    setControl(current)
  }
  const since = current.since
  return React.useMemo(() => {
    const out: Record<string, unknown> = {}
    // (an event's value counts when it was written after the prop last set the signal, or the prop never did)
    const eventWins = (name: string): boolean => Object.hasOwn(events.written, name) && (!Object.hasOwn(since, name) || events.written[name]! > since[name]!)
    // The loop's whole set is the dataflow's state, and is the chart's for every signal the prop has never set: a value the loop
    // holds without having reported it changed pins that signal (vega does not re-evaluate it until something pulses it), so
    // leaving it out would have the evaluation recompute it from its `update`. For a signal the prop set, the loop's value is the
    // prop's (the loop was seeded with it) unless an event wrote it after: then it is the event's.
    for (const [name, value] of Object.entries(events.values)) {
      if (isLoopKey(name) || !Object.hasOwn(since, name) || eventWins(name)) out[name] = value
    }
    if (controlled) {
      for (const [name, value] of Object.entries(controlled)) {
        if (!eventWins(name)) out[name] = value
      }
    }
    return out
  }, [controlled, since, events])
}

/**
 * The tick at which the prop last set each signal: kept for a key whose value did not change, `now` for one that changed or
 * came back. A key the prop no longer has keeps the tick it was last set at (what an event wrote before then stays dead).
 */
function sinceOf(
  prev: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>> | undefined,
  prevSince: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = { ...prevSince }
  if (!next) return out
  for (const name of Object.keys(next)) {
    const same = prev !== undefined && Object.hasOwn(prev, name) && Object.hasOwn(prevSince, name) && contentEqual(prev[name], next[name])
    if (!same) out[name] = now
  }
  return out
}
