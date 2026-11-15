/**
 * The canvas renderer as `<Chart renderer="canvas">` uses it, put in its slot (see engine-parts.ts). `@aster-charts/core/lean/canvas`:
 * outside a browser build `<Chart>` imports this module itself, so the canvas renderer is there from the first render, as it always
 * was; in a browser build it imports `canvas-deferred.ts`, which loads this module when a chart first asks for a canvas.
 */
import { installPart, partLoaded, type EngineParts } from './engine-parts.js'
import {
  createCanvasEvents, loadImages, renderSceneToCanvas, renderSceneToCanvasAppend, sceneImageUrls, snapshotCanvasScene, withSceneImages,
} from './canvas.js'
import './part-svgpath.js' // (its symbols can be custom paths)

export const part: EngineParts['canvas'] = {
  createCanvasEvents, renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene, sceneImageUrls, loadImages, withSceneImages,
}
installPart('canvas', part)

/** Make sure the canvas part is in its slot (it is, once this module has run; put back if a test emptied it). */
export function loadCanvasPart(): Promise<void> {
  if (!partLoaded('canvas')) installPart('canvas', part)
  return Promise.resolve()
}
