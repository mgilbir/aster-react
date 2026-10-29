/** Resolve `canvas` (the optional native module vega-canvas imports) to the coverage-only stand-in next to this file. */
import { registerHooks } from 'node:module'

const stand = new URL('./canvas-module.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'canvas' ? { url: stand, shortCircuit: true } : nextResolve(specifier, context)
  },
})
