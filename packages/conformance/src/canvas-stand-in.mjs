/**
 * Resolve `canvas` (the optional native module vega-canvas imports) to a stand-in module, for a child Node process started with
 * `--import <dir>/register.mjs`. Synchronous in-thread hooks (`module.registerHooks`) where Node has them (22.15 and 23.5 on);
 * on older Node (20, which CI's engine-sensitive leg runs) the off-thread loader hooks of `module.register`, which resolve the same.
 */
import * as nodeModule from 'node:module'

/** @param {string} stand the stand-in's file URL */
export function resolveCanvasTo(stand) {
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === 'canvas' ? { url: stand, shortCircuit: true } : nextResolve(specifier, context)
      },
    })
    return
  }
  const loader = 'let stand\n'
    + 'export function initialize(data) { stand = data.stand }\n'
    + "export async function resolve(specifier, context, nextResolve) { return specifier === 'canvas' ? { url: stand, shortCircuit: true } : nextResolve(specifier, context) }\n"
  nodeModule.register(`data:text/javascript,${encodeURIComponent(loader)}`, { data: { stand } })
}
