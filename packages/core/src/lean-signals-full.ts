/**
 * `@aster-charts/core/internal/signals` outside a browser build: the signal event loop in its slot from the start, with every part of the
 * engine its handlers can use (as `@aster-charts/core/signals` carries them), so a server render or a test runner binds it at once.
 */
import './parts-signals.js'
export { loadSignalsPart } from './part-signals.js'
