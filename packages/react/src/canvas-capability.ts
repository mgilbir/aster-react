import {
  createCanvasEvents, loadImages, renderSceneToCanvas, renderSceneToCanvasAppend, paintsSameAs, sceneImageUrls, snapshotCanvasScene, withSceneImages,
} from '@aster-charts/core/canvas'
import type { CanvasCapability } from './capabilities.js'

/** @internal The canvas renderer `<Chart>` injects into `ChartCore`; `<SvgChart>` never imports this module. */
export const canvasCapability: CanvasCapability = {
  createCanvasEvents,
  renderSceneToCanvas,
  renderSceneToCanvasAppend,
  paintsSameAs,
  snapshotCanvasScene,
  sceneImageUrls,
  loadImages,
  withSceneImages,
}
