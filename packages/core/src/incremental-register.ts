/**
 * Hands the incremental engine to the runtime. A side-effect module (listed in `sideEffects`): the entries that re-evaluate a chart
 * (`evaluate.ts`, the session) import it, and a bundle of `renderSpec` alone never reaches it.
 */
import { registerIncrementalEngine } from './runtime.js'
import { incrementalEngine } from './incremental-engine.js'

registerIncrementalEngine(incrementalEngine)
