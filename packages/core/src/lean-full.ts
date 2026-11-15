/**
 * `@aster-charts/core/lean` outside a browser build: the module the React shells use (lean.ts) with every part of the engine already
 * in its slot (engine-parts.ts), so that a server render, a test runner or a worker without the `browser` condition draws every chart
 * synchronously, as it always did.
 */
import './parts-all.js'
export * from './lean.js'
