import { buildHitIndex } from '@aster-charts/core/internal/hit'
import { createCursorTracker, part, sceneHasCursor } from '@aster-charts/core/internal'
import { loadSignalsPart } from '@aster-charts/core/internal/signals'
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
 * A plain value, not a registration: nothing happens on import, so bundlers drop it when unused. The event loop is a part of the
 * engine (`@aster-charts/core/internal`) that a chart which binds it loads before its first render (`loadSignals`; ChartCore's
 * `useAddons` suspends meanwhile): a chart with no signal, and no host listening to signals, never fetches it in a browser build.
 */
export const interaction: InteractionCapability = /* @__PURE__ */ Object.freeze({
  buildHitIndex,
  bindSceneSignals: (...args: Parameters<InteractionCapability['bindSceneSignals']>) => part('signals').bindSceneSignals(...args),
  loadSignals: loadSignalsPart,
  createCursorTracker,
  sceneHasCursor,
  tooltipContent,
})
