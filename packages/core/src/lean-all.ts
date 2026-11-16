/**
 * `@aster-charts/core/lean/all` (for `import '@aster-charts/react/all'`): every part of the engine in its slot from the start
 * (engine-parts.ts), the canvas renderer and the signal event loop included, by static imports. An app that imports it bundles the
 * whole engine up front, as `@aster-charts/core` itself does, and the React shells never wait for a part: what they would load on
 * demand is already loaded. The opt-in add-ons (`/geo`, `/transforms`, `/load`) stay opt-in: an app imports those it uses itself.
 *
 * Each part is put in its slot by a call, not by the bare import of its module alone: what this module does when it runs does not
 * depend on whether a part's module ran before (and was emptied since, as a test of the lean path does).
 */
import { installPart, type EnginePart, type EngineParts } from './engine-parts.js'
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

const EVERY_PART: { [K in EnginePart]: EngineParts[K] } = {
  aggregate, window, reshape, time, curves, color, scales, legend, layout, pulse, selections, regex, svgpath, intersect, modify, timer, canvas, signals,
}
for (const name of Object.keys(EVERY_PART) as EnginePart[]) installPart(name, EVERY_PART[name] as never)
