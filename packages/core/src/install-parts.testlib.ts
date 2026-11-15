/**
 * Every part of the engine in its slot, by a call rather than by bare imports: for pages that bundle core's sources (the canvas
 * gate's oracles), where the manifest's `sideEffects` (dist paths) does not cover the source modules and a bundler drops their bare
 * imports. See engine-parts.ts.
 */
import { installPart } from './engine-parts.js'
import { part as legend } from './part-legend.js'
import { part as layout } from './part-layout.js'
import { part as pulse } from './part-pulse.js'
import { part as selections } from './part-selections.js'
import { part as regex } from './part-regex.js'
import { part as svgpath } from './part-svgpath.js'
import { part as intersect } from './part-intersect.js'
import { part as modify } from './part-modify.js'
import { part as timer } from './part-timer.js'
import { part as canvas } from './part-canvas.js'

export function installAllParts(): void {
  installPart('legend', legend)
  installPart('layout', layout)
  installPart('pulse', pulse)
  installPart('selections', selections)
  installPart('regex', regex)
  installPart('svgpath', svgpath)
  installPart('intersect', intersect)
  installPart('modify', modify)
  installPart('timer', timer)
  installPart('canvas', canvas)
}
