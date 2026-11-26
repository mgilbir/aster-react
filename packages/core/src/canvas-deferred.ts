/**
 * `@aster-charts/core/internal/canvas` in a browser build (not public API, for `<Chart>`): the canvas renderer loaded when a chart first asks
 * for `renderer="canvas"`, so that an SVG chart never fetches it (see part-canvas.ts).
 */
export function loadCanvasPart(): Promise<void> {
  return import('./part-canvas.js').then((m) => m.loadCanvasPart())
}
