import { buildHitIndex } from '@aster-charts/core/hit'
import { bindSceneSignals, createCursorTracker, sceneHasCursor } from '@aster-charts/core/signals'
import type { InteractionCapability } from './capabilities.js'
import { tooltipContent } from './tooltip-content.js'

export type { InteractionCapability } from './capabilities.js'

/**
 * `@aster-charts/react/interaction`: hit testing and the signal event loop, as a value passed to
 * `<SvgChart interaction={interaction}>`. `<Chart>` already has it built in.
 *
 *   import { SvgChart } from '@aster-charts/react/lite'
 *   import { interaction } from '@aster-charts/react/interaction'
 *   <SvgChart spec={spec} interaction={interaction} tooltip />
 *
 * A plain value, not a registration: nothing happens on import, so bundlers drop it when unused.
 */
export const interaction: InteractionCapability = /* @__PURE__ */ Object.freeze({
  buildHitIndex,
  bindSceneSignals,
  createCursorTracker,
  sceneHasCursor,
  tooltipContent,
})
