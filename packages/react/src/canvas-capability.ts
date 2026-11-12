import {
  loadImages, renderSceneToCanvas, renderSceneToCanvasAppend, sceneImageUrls, snapshotCanvasScene, withSceneImages,
} from '@aster-charts/core/canvas'
import type { CanvasCapability } from './capabilities.js'

/** @internal The canvas renderer `<Chart>` injects into `ChartCore`; `<SvgChart>` never imports this module. */
export const canvasCapability: CanvasCapability = {
  renderSceneToCanvas,
  renderSceneToCanvasAppend,
  snapshotCanvasScene,
  sceneImageUrls,
  loadImages,
  withSceneImages,
}
