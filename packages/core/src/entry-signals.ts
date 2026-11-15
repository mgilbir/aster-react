/**
 * `@aster-charts/core/signals`: the event-driven signal loop (signals.ts), with every part of the engine its handlers can use
 * (engine-parts.ts), so that it works for every spec as it is.
 */
import './parts-signals.js'
export * from './signals.js'

/** @internal vega-scenegraph's intersect over the scene (the `intersect()` expression function's body); exported for the conformance gate. */
export { sceneIntersect } from './scene-intersect.js'

/**
 * Drive the shared scheduler, and so every `timer` event stream, from `clock` instead of the host's globals; `null` goes
 * back to them. The determinism seam: a test, or a host that steps frames itself, installs a controlled clock. Swap it
 * only while no timer is live: a timer's pending wake-up belongs to the clock it was scheduled on.
 */
export { setTimerClock, type TimerClock } from './timer.js'
