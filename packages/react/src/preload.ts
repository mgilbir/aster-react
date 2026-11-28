/**
 * `preloadParts` of `@aster-charts/react`: the parts of the engine a browser build loads on demand, fetched ahead of time. It is
 * `@aster-charts/core/addons`'s, plus the two parts `<Chart>`'s capabilities load (the canvas renderer and the signal loop), so it lives
 * with `<Chart>`, which imports their loaders anyway (`<SvgChart>` from `/lite` never reads either: see the bundle-shaking gate).
 */
import type { EnginePart } from '@aster-charts/core/addons'
import { ENGINE_PARTS, partLoaded, preloadParts as preloadSpecParts } from '@aster-charts/core/internal'
import { loadCanvasPart } from '@aster-charts/core/internal/canvas'
import { loadSignalsPart } from '@aster-charts/core/internal/signals'

/**
 * Load parts of the engine ahead of time (every part when no names are given, the canvas renderer and the signal loop included), for an
 * app that knows which families its charts use and would rather fetch them before the first chart than when it renders. Resolves once
 * they are all loaded; rejects, naming the part, when an import fails, and with a TypeError for a name that is not a part
 * (`ENGINE_PARTS` of `@aster-charts/core/internal` lists them). (`import '@aster-charts/react/all'` instead bundles every part.)
 */
export function preloadParts(names: readonly EnginePart[] = ENGINE_PARTS): Promise<void> {
  const unknown = names.filter((n) => !ENGINE_PARTS.includes(n))
  if (unknown.length) return Promise.reject(new TypeError(`[aster] not a part of the engine: ${unknown.map((n) => JSON.stringify(n)).join(', ')} (the parts are ${ENGINE_PARTS.join(', ')})`))
  const wanted = names.filter((n) => !partLoaded(n))
  return Promise.all([
    preloadSpecParts(wanted.filter((n) => n !== 'canvas' && n !== 'signals')),
    wanted.includes('canvas') ? loadCanvasPart() : undefined,
    wanted.includes('signals') ? loadSignalsPart() : undefined,
  ]).then(() => undefined)
}
