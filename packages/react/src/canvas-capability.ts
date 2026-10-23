import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from '@aster/core/canvas'
import type { CanvasCapability } from './capabilities.js'

/** @internal The canvas renderer `<Chart>` injects into `ChartCore`; `<SvgChart>` never imports this module. */
export const canvasCapability: CanvasCapability = {
  renderSceneToCanvas,
  renderSceneToCanvasAppend,
  snapshotCanvasScene,
}
