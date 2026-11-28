/**
 * Every part of the engine but the canvas renderer and the signal loop (see engine-parts.ts): what `lean-full.ts` carries, so that the
 * shells outside a browser build load nothing. (`<Chart>` brings the canvas renderer and the signal loop itself, each for the capability
 * that uses it: `part-canvas.ts`, `part-signals.ts`.)
 */
import './parts-signals.js'
import './part-pulse.js'
