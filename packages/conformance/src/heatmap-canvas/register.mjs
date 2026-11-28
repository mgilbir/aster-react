/** Resolve `canvas` (the optional native module vega-canvas imports) to the pixel-keeping stand-in next to this file. */
import { resolveCanvasTo } from '../canvas-stand-in.mjs'

resolveCanvasTo(new URL('./canvas-module.mjs', import.meta.url).href)
