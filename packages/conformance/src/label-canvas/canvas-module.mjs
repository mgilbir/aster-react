/**
 * A stand-in for the `canvas` package, for running vega (and so vega-label) in Node with a canvas it can draw into: the
 * coverage-only context of `@aster/core` (`raster.ts`), plus what vega asks of a context (`getImageData`, `measureText`).
 * The text width is vega's headless estimate (`~~(0.8 * length * fontSize)`), which is what the engine measures with in Node.
 */
import { AlphaCanvas } from '../../../core/dist/raster.js'

class Context extends AlphaCanvas {
  constructor(canvas, width, height) {
    super(width, height)
    this.canvas = canvas
  }
  measureText(text) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
    return { width: ~~(0.8 * String(text).length * size) }
  }
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[(j * w + i) * 4 + 3] = this.alpha[(y + j) * this.width + x + i]
    return { data, width: w, height: h }
  }
  clearRect() {}
  setTransform() {}
}

export class Canvas {
  constructor(width, height) {
    this.width = width
    this.height = height
    this._ctx = new Context(this, width, height)
  }
  getContext() { return this._ctx }
}

export class Image {}
export const createCanvas = (w, h) => new Canvas(w, h)
