import { buildHitIndex } from '@aster/core/hit'
import { bindSceneSignals, createCursorTracker, sceneHasCursor } from '@aster/core/signals'
import type { InteractionCapability } from './capabilities.js'

export type { InteractionCapability } from './capabilities.js'

/**
 * `@aster/react/interaction`: hit testing and the signal event loop, as a value passed to
 * `<SvgChart interaction={interaction}>`. `<Chart>` already has it built in.
 *
 *   import { SvgChart } from '@aster/react/lite'
 *   import { interaction } from '@aster/react/interaction'
 *   <SvgChart spec={spec} interaction={interaction} tooltip />
 *
 * A plain value, not a registration: nothing happens on import, so bundlers drop it when unused.
 */
export const interaction: InteractionCapability = /* @__PURE__ */ Object.freeze({
  buildHitIndex,
  bindSceneSignals,
  createCursorTracker,
  sceneHasCursor,
})
