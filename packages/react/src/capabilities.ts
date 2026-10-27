import type {
  renderSceneToCanvas,
  renderSceneToCanvasAppend,
  snapshotCanvasScene,
} from '@aster/core/canvas'
import type { buildHitIndex } from '@aster/core/hit'
import type { bindSceneSignals, createCursorTracker, sceneHasCursor, stampDatumAttrs } from '@aster/core/signals'

/**
 * Capabilities are plain values handed to `ChartCore`; there is no registry and no side-effect
 * import. A bundle contains a capability's code only if the entry point that builds it is
 * imported, so `<SvgChart>` without `interaction` ships none of it.
 */

/** The canvas renderer (`@aster/core/canvas`). Only `<Chart>` supplies it. */
export interface CanvasCapability {
  readonly renderSceneToCanvas: typeof renderSceneToCanvas
  readonly renderSceneToCanvasAppend: typeof renderSceneToCanvasAppend
  readonly snapshotCanvasScene: typeof snapshotCanvasScene
}

/**
 * Hit testing (`@aster/core/hit`) and the signal event loop (`@aster/core/signals`): tooltips,
 * point selection, `signal.on` event streams, `data-datum` stamping, and the item cursor (an item's `cursor` channel
 * shown while the pointer is over it).
 * Import the value from `@aster/react/interaction`.
 */
export interface InteractionCapability {
  readonly buildHitIndex: typeof buildHitIndex
  readonly bindSceneSignals: typeof bindSceneSignals
  readonly stampDatumAttrs: typeof stampDatumAttrs
  readonly createCursorTracker: typeof createCursorTracker
  readonly sceneHasCursor: typeof sceneHasCursor
}
