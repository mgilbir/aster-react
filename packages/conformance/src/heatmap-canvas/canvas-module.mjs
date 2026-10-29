/**
 * A stand-in for the `canvas` package, for running vega-geo's `heatmap` in Node: a canvas that keeps the pixels `putImageData` is
 * given (and a blank `getImageData`), which is all the transform asks of it. The test compares the PIXELS vega-geo computes with the
 * engine's; how a browser encodes them is the gallery gate's (`vega/density-heatmaps`, `vega/contour-plot` in Chromium).
 */
class Context {
  constructor(canvas) { this.canvas = canvas }
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } }
  putImageData(img) { this.canvas.pixels = img.data }
}
export class Canvas {
  constructor(width, height) { this.width = width; this.height = height; this.pixels = null; this._ctx = new Context(this) }
  getContext() { return this._ctx }
}
export class Image {}
export const createCanvas = (w, h) => new Canvas(w, h)
