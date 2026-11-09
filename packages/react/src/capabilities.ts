import type {
  renderSceneToCanvas,
  renderSceneToCanvasAppend,
  snapshotCanvasScene,
} from '@aster-charts/core/canvas'
import type { buildHitIndex } from '@aster-charts/core/hit'
import type { bindSceneSignals, createCursorTracker, sceneHasCursor } from '@aster-charts/core/signals'
import type { tooltipContent } from './tooltip-content.js'

/**
 * Capabilities are plain values handed to `ChartCore`; there is no registry and no side-effect
 * import. A bundle contains a capability's code only if the entry point that builds it is
 * imported, so `<SvgChart>` without `interaction` ships none of it.
 */

/** The canvas renderer (`@aster-charts/core/canvas`). Only `<Chart>` supplies it. */
export interface CanvasCapability {
  readonly renderSceneToCanvas: typeof renderSceneToCanvas
  readonly renderSceneToCanvasAppend: typeof renderSceneToCanvasAppend
  readonly snapshotCanvasScene: typeof snapshotCanvasScene
}

/**
 * Hit testing (`@aster-charts/core/hit`) and the signal event loop (`@aster-charts/core/signals`): tooltips,
 * point selection, `signal.on` event streams, and the item cursor (an item's `cursor` channel
 * shown while the pointer is over it).
 * Import the value from `@aster-charts/react/interaction`.
 */
export interface InteractionCapability {
  readonly buildHitIndex: typeof buildHitIndex
  readonly bindSceneSignals: typeof bindSceneSignals
  readonly createCursorTracker: typeof createCursorTracker
  readonly sceneHasCursor: typeof sceneHasCursor
  /** The default tooltip's content for an item's `tooltip` value, as vega-tooltip shows it. */
  readonly tooltipContent: typeof tooltipContent
}
