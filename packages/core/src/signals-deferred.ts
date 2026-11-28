/**
 * `@aster-charts/core/internal/signals` in a browser build (not public API, for the React shells): the signal event loop loaded when a chart first
 * binds it, so that a chart with no signal never fetches it (see part-signals.ts).
 */
export function loadSignalsPart(): Promise<void> {
  return import('./part-signals.js').then((m) => m.loadSignalsPart())
}
