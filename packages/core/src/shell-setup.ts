/**
 * What the React shells set up once before their first evaluation on `@aster-charts/core/lean` (they call `setUpShell` from
 * `useAddons`: a call, not an import effect, so that no bundler can drop it): the guide captions `renderSceneToSvg` quotes in
 * aria-label, as the main entry installs them; and the loader of the pulse path, which a re-evaluation that could have taken a
 * pulse asks for (runtime.ts) so that the next one is incremental. A failed import of it is not retried: without the pulse path
 * every evaluation still makes the same scene, only in full. It is said once, as a warning (C501): a page that cannot load the
 * part pays for every update in full, and the host should know why.
 */
import './guide-caption.js'
import { setPartRequester } from './engine-parts.js'
import { loadParts } from './addons.js'
import { consoleLogger } from './logger.js'

let setUp = false
let pulseFailed = false

export function setUpShell(): void {
  if (setUp) return
  setUp = true
  setPartRequester((name) => {
    if (name !== 'pulse' || pulseFailed) return
    loadParts([name]).catch((e: unknown) => {
      pulseFailed = true
      consoleLogger.warn(`[aster] the incremental engine part ('pulse') failed to load: every evaluation runs in full from now on (${e instanceof Error ? e.message : String(e)})`)
    })
  })
}
