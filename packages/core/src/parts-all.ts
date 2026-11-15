/**
 * Every part of the engine but the canvas renderer (see engine-parts.ts): what `lean-full.ts` carries, so that the shells outside a
 * browser build load nothing. (`<Chart>` brings the canvas renderer itself: `@aster-charts/core/lean/canvas`.)
 */
import './parts-signals.js'
import './part-pulse.js'
