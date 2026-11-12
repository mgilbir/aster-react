import type { PngCapability } from './capabilities.js'

export type { PngCapability } from './capabilities.js'
export type { PngOptions } from '@aster-charts/core/png'

/**
 * `@aster-charts/react/png`: PNG export for `<SvgChart>`, as a value passed to `<SvgChart png={png}>`; its ref's `getPng` then
 * works as `<Chart>`'s does. `<Chart>` already has it built in.
 *
 *   import { SvgChart } from '@aster-charts/react/lite'
 *   import { png } from '@aster-charts/react/png'
 *   <SvgChart ref={ref} spec={spec} png={png} />
 *   const blob = await ref.current.getPng({ scale: 2 })
 *
 * The painter (`@aster-charts/core/png`, with the canvas renderer) is imported the first time `getPng` is called, so a bundler that
 * splits code puts it in a chunk that only an export fetches. A plain value: nothing happens on import.
 */
export const png: PngCapability = /* @__PURE__ */ Object.freeze({
  load: () => import('@aster-charts/core/png'),
})
