import { part } from '@aster-charts/core/lean'
import { loadCanvasPart } from '@aster-charts/core/lean/canvas'
import type { CanvasCapability } from './capabilities.js'

/**
 * @internal The canvas renderer `<Chart>` injects into `ChartCore`; `<SvgChart>` never imports this module. Each function hands over
 * to the canvas part of the engine (`@aster-charts/core/lean`), which a chart that asks for `renderer="canvas"` loads before its first
 * render (`load`; ChartCore's `useAddons` suspends meanwhile), so that an SVG chart in a browser build never fetches the canvas
 * renderer. Outside a browser build `@aster-charts/core/lean/canvas` is the renderer itself, there from the first render.
 */
export const canvasCapability: CanvasCapability = {
  load: loadCanvasPart,
  createCanvasEvents: (...args) => part('canvas').createCanvasEvents(...args),
  renderSceneToCanvas: (...args) => part('canvas').renderSceneToCanvas(...args),
  renderSceneToCanvasAppend: (...args) => part('canvas').renderSceneToCanvasAppend(...args),
  paintsSameAs: (...args) => part('canvas').paintsSameAs(...args),
  snapshotCanvasScene: (...args) => part('canvas').snapshotCanvasScene(...args),
  sceneImageUrls: (...args) => part('canvas').sceneImageUrls(...args),
  loadImages: (...args) => part('canvas').loadImages(...args),
  withSceneImages: (...args) => part('canvas').withSceneImages(...args),
}
