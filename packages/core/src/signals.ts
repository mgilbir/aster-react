/**
 * Event-driven signals: the signal→view event loop.
 *
 * Vega binds each `signal.on` event stream to a view event; the stream's
 * `update` expression (with `event`, `datum` and signal refs in scope)
 * produces the new signal value, and dependent signals/scales re-evaluate to
 * a fixed point — the same semantics as our static `update` resolution, fed
 * by DOM events instead of the initial pulse.
 *
 * The host (React `<Chart>`, or any embedder) calls `bindSignalEvents` on the
 * rendered SVG and re-renders when the returned handler fires.
 */
import type { CompiledChart, CompiledSignalDef, SceneGroup, SceneItem, SceneNode, SceneRoot } from './types.js'
import { type ExpressionRuntime } from './expression.js'

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

export interface SignalEventHooks {
  /** Called after an event stream updates one or more signals. */
  onSignal?: (name: string, value: unknown, all: Record<string, unknown>) => void
}

export interface SignalBinding {
  detach: () => void
  /** Manually set a signal (the imperative path, e.g. brush props). */
  setSignal: (name: string, value: unknown) => void
}

interface EventTargetInfo {
  signal: CompiledSignalDef
  on: { events: string; update?: string }
}

const SUPPORTED_EVENTS = new Set([
  'mousemove', 'mouseout', 'mouseover', 'mouseleave', 'mousedown', 'mouseup',
  'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'touchend',
])

/** Parse a vega event selector: space-separated simple event names. */
export function parseEventSelector(selector: string): string[] {
  return selector.split(/\s+/).filter((s) => s.length > 0 && SUPPORTED_EVENTS.has(s))
}

/**
 * Find the scene item whose element (or ancestor) carries the pointer, by
 * reading the data-attributes our renderer stamps on mark elements.
 */
function findDatum(svg: SVGSVGElement, target: EventTarget | null): Record<string, unknown> | undefined {
  let el = target as Element | null
  while (el && el !== svg) {
    if (el instanceof Element && (el as HTMLElement).dataset?.datum) {
      try {
        return JSON.parse((el as HTMLElement).dataset.datum!) as Record<string, unknown>
      } catch {
        return undefined
      }
    }
    el = el.parentElement
  }
  return undefined
}

/**
 * Bind every `signal.on` event stream in the compiled chart to DOM events on
 * `svg`. On each event: evaluate the stream's `update` expression with the
 * vega event context, store the new signal value, resolve dependent signal
 * updates to a fixed point (the same rule as the static pulse), and invoke
 * the hooks. Returns a binding with `detach` + an imperative `setSignal`.
 */
export function bindSignalEvents(
  svg: SVGSVGElement,
  chart: CompiledChart,
  runtime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: { originX?: number; originY?: number } = {},
): SignalBinding {
  const signalDefs = chart.signalDefs ?? []
  return bindSignalEventsDefs(svg, chart, signalDefs, runtime, signalParams, signals, hooks, opts)
}

function bindSignalEventsDefs(
  svg: SVGSVGElement,
  chart: CompiledChart,
  defs: CompiledSignalDef[],
  runtime: ExpressionRuntime,
  signalParams: Record<string, unknown>,
  signals: Record<string, unknown>,
  hooks: SignalEventHooks = {},
  opts: { originX?: number; originY?: number } = {},
): SignalBinding {
  const originX = opts.originX ?? 0
  const originY = opts.originY ?? 0
  const targets: Array<EventTargetInfo & { eventNames: string[] }> = []



  for (const signal of defs) {
    for (const on of signal.on ?? []) {
      const eventNames = parseEventSelector(on.events)
      if (!eventNames.length) continue
      targets.push({ signal, on, eventNames })
    }
  }

  const detachFns: Array<() => void> = []

  const handle = (info: EventTargetInfo, evt: Event): void => {
    const update = info.on.update
    if (typeof update !== 'string') return
    // view coordinates: subtract the chart origin (padding) like vega does
    let x = 0
    let y = 0
    if (evt instanceof MouseEvent) {
      const rect = svg.getBoundingClientRect()
      x = evt.clientX - rect.left - originX
      y = evt.clientY - rect.top - originY
    }
    const datum = findDatum(svg, evt.target)
    const eventCtx: EventContext = { x, y, native: evt, datum }
    // `event` in expressions: the vega event facade (x/y + the raw event).
    const expr = runtime.expr(update)
    try {
      // vega's event-stream handler arity: datum comes from event.item.datum
      // (the targeted mark), the event facade exposes x/y + the raw event.
      const facade = { ...eventCtx, vega: eventCtx, item: { datum: eventCtx.datum } }
      const value = (expr as (datum: unknown, params: unknown, event?: unknown) => unknown)(
        eventCtx.datum ?? {},
        { ...signalParams, ...signals },
        facade,
      )
      setSignal(info.signal.name, value)
    } catch {
      // expressions referencing absent datum/event fields are skipped (the
      // same tolerance as the static resolution)
    }
  }

  for (const info of targets) {
    for (const eventName of info.eventNames) {
      const listener = (evt: Event) => handle(info, evt)
      svg.addEventListener(eventName, listener)
      detachFns.push(() => svg.removeEventListener(eventName, listener))
    }
  }

  const setSignal = (name: string, value: unknown): void => {
    if (name == null) return
    signals[name] = value
    // Resolve dependent signal updates to a fixed point (the same rule as
    // resolveSignalUpdates in the static pulse).
    const maxRounds = 3
    for (let round = 0; round < maxRounds; ++round) {
      let changed = false
      for (const def of defs) {
        if (!def.update || def.name === name) continue
        try {
          const next = runtime.expr(def.update)({}, { ...signalParams, ...signals })
          if (JSON.stringify(next) !== JSON.stringify(signals[def.name])) {
            signals[def.name] = next
            changed = true
          }
        } catch { /* skip unresolvable this round */ }
      }
      if (!changed) break
    }
    hooks.onSignal?.(name, signals[name], signals)
  }

  return {
    detach: () => detachFns.forEach((fn) => fn()),
    setSignal,
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
    { originX: scene.padding?.left ?? 0, originY: scene.padding?.top ?? 0 },
  )
}
