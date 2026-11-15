/**
 * The signal event loop as the React shells bind it, put in its slot (see engine-parts.ts). `@aster-charts/core/lean/signals`: outside a
 * browser build the shells import this module itself (with every part the loop's handlers can use, lean-signals-full.ts), so the loop is
 * there from the first render, as it always was; in a browser build they import `signals-deferred.ts`, which loads this module when a
 * chart first binds the loop.
 */
import { installPart, partLoaded, type EngineParts } from './engine-parts.js'
import { bindSceneSignals } from './signals.js'

export const part: EngineParts['signals'] = { bindSceneSignals }
installPart('signals', part)

/** Make sure the loop is in its slot (it is, once this module has run; put back if a test emptied it). */
export function loadSignalsPart(): Promise<void> {
  if (!partLoaded('signals')) installPart('signals', part)
  return Promise.resolve()
}
