/**
 * Every part of the engine in its slot, by a call rather than by bare imports: for pages that bundle core's sources (the canvas
 * gate's oracles), where the manifest's `sideEffects` (dist paths) does not cover the source modules and a bundler drops their bare
 * imports. See engine-parts.ts.
 *
 * `PARTS` is typed as a record over every `EnginePart`, so a part added to `EngineParts` without being listed here is a type error,
 * and `installAllParts` installs `ENGINE_PARTS` in order from it (install-parts.test.ts checks every slot is filled).
 */
import { ENGINE_PARTS, installPart, type EnginePart, type EngineParts } from './engine-parts.js'
import { part as aggregate } from './part-aggregate.js'
import { part as window } from './part-window.js'
import { part as reshape } from './part-reshape.js'
import { part as time } from './part-time.js'
import { part as curves } from './part-curves.js'
import { part as color } from './part-color.js'
import { part as scales } from './part-scales.js'
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
import { part as signals } from './part-signals.js'

const PARTS: { readonly [K in keyof EngineParts]: EngineParts[K] } = {
  aggregate, window, reshape, time, curves, color, scales, legend, layout, pulse, selections, regex, svgpath, intersect, modify, timer, canvas, signals,
}

const put = <K extends EnginePart>(name: K): void => installPart(name, PARTS[name])

export function installAllParts(): void {
  for (const name of ENGINE_PARTS) put(name)
}
