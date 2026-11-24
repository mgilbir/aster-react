/**
 * The parts of the engine that most charts never run, and that the React shells load on demand.
 *
 * Every public entry of `@aster-charts/core` (`renderSpec`, `compileChart` / `evaluateChart`, `createChartSession`, the signal loop,
 * the renderers) carries the parts its functions can use, as it always did: it imports their `part-*.ts` modules, which put them in
 * the slots below. `@aster-charts/core/lean` is the same engine with the slots left empty, for the React shells: they read which
 * parts a spec needs (`partsNeeded` in addons.ts), import exactly those (`loadParts`), and render once they are there, through the same
 * Suspense wait as the opt-in add-ons. A chart that needs none of them never fetches anything.
 *
 * A slot that is read while it is empty is a missed detection, never a reason to go on without the part: the reader throws, so a
 * chart is refused rather than drawn differently, and the regular-expression screen in particular can never be skipped (limits.ts).
 * The one exception is the pulse path of the incremental engine, which is an optimisation: without it a re-evaluation derives its
 * datasets in full, which makes the same scene, and asks for the part so that the next one is incremental (runtime.ts). Not for a
 * dataset that may draw from an injected random source: the two builds draw other numbers from the same source, so there the slot
 * is read like any other (`specNeeds` names `pulse` for it, addons.ts).
 *
 * Only types are imported here: this module is in every bundle, the parts are not.
 */
import type { buildLegend, entriesRefusal, legendType, placeLegendStack } from './guide-legend.js'
import type { layoutFacet } from './trellis.js'
import type { selectionIdTest, selectionResolve, selectionTest, selectionTuples } from './selections.js'
import type { regexHazard } from './regex-screen.js'
import type { drawnPathCommands, renderSvgPath, svgPathCommands } from './path-data.js'
import type { sceneIntersect } from './scene-intersect.js'
import type { applyChangeset, newChangeset, planModify } from './modify.js'
import type { Timers } from './timer.js'
import type { IncrementalEngine } from './runtime.js'
import type { bindSceneSignals } from './signals.js'
import type { aggregateGroups, aggregateRows, joinAggregateRows, pivotRows } from './transform-agg.js'
import type { windowRows } from './transform-window.js'
import type {
  binRows, collectRows, extentOfField, flattenRows, foldRows, identifierRows, imputeRows, lookupRows, projectRows, sampleRows, sequenceRows, stackRows,
} from './transform-basic.js'
import type { timeunitRows } from './transform-timeunit.js'
import type { time, utcTime } from './scale-calendar.js'
import type { dayofyear, timeIntervalFor, timeOffset, timeSequence, timeUnitSpecifier, utcdayofyear, utcIntervalFor, utcOffset, utcSequence, utcweek, week } from './time.js'
import type { defaultTimeLocale, timeFormatLocale } from './locale-time.js'
import type { FAMILIES } from './curves.js'
import type { contrastRatio, hcl, hsl, lab, luminance, rgb } from './color.js'
import type { interpolateRgb, interpolateText, isColor } from './interp-color.js'
import type { rampScheme } from './color-schemes.js'
import type {
  diverging, divergingLog, divergingPow, divergingSqrt, divergingSymlog, identityScale, log, pow, sequential, sequentialLog, sequentialPow,
  sequentialSqrt, sequentialSymlog, sqrt, symlog,
} from './scale-warped.js'
import type { binOrdinal, quantileScale, quantize, threshold } from './scale-classes.js'
import type {
  createCanvasEvents, loadImages, paintsSameAs, renderSceneToCanvas, renderSceneToCanvasAppend, sceneImageUrls, snapshotCanvasScene, withSceneImages,
} from './canvas.js'

export interface EngineParts {
  /**
   * The aggregation engine (transform-agg.ts): the `aggregate`, `joinaggregate` and `pivot` transforms, a facet's `groupby` (its group
   * items are an aggregate), and a scale domain sorted by an aggregate of another field (`sort: {op, field}`).
   */
  aggregate: { aggregateRows: typeof aggregateRows; aggregateGroups: typeof aggregateGroups; joinAggregateRows: typeof joinAggregateRows; pivotRows: typeof pivotRows }
  /** The `window` transform (transform-window.ts). */
  window: { windowRows: typeof windowRows }
  /**
   * The row transforms of transform-basic.ts: `collect`, `sample`, `fold`, `flatten`, `project`, `extent`, `sequence`, `lookup`,
   * `impute`, `stack`, `identifier` and `bin`.
   */
  reshape: {
    collectRows: typeof collectRows; sampleRows: typeof sampleRows; foldRows: typeof foldRows; flattenRows: typeof flattenRows; projectRows: typeof projectRows
    extentOfField: typeof extentOfField; sequenceRows: typeof sequenceRows; lookupRows: typeof lookupRows; imputeRows: typeof imputeRows
    stackRows: typeof stackRows; identifierRows: typeof identifierRows; binRows: typeof binRows
  }
  /**
   * The calendar and the time formats (time.ts, time-format.ts, locale-time.ts): the `time` and `utc` scales, the `timeunit` transform,
   * a date formatted or parsed (a time scale's labels, `formatType: 'time' | 'utc'`, a `date:` / `utc:` parse of a dataset, a time
   * locale in the config) and the expression functions that read the calendar (`timeFormat`, `utcParse`, `timeOffset`, `week`...).
   */
  time: {
    timeunitRows: typeof timeunitRows; time: typeof time; utcTime: typeof utcTime
    timeIntervalFor: typeof timeIntervalFor; utcIntervalFor: typeof utcIntervalFor; timeOffset: typeof timeOffset; utcOffset: typeof utcOffset
    timeSequence: typeof timeSequence; utcSequence: typeof utcSequence; dayofyear: typeof dayofyear; utcdayofyear: typeof utcdayofyear
    week: typeof week; utcweek: typeof utcweek; timeUnitSpecifier: typeof timeUnitSpecifier
    defaultTimeLocale: typeof defaultTimeLocale; timeFormatLocale: typeof timeFormatLocale
  }
  /** The curves of a line or an area besides `linear` (curves.ts): an `interpolate` that names one, or that is not a literal. */
  curves: { families: typeof FAMILIES }
  /**
   * Colours (color.ts, interp-color.ts, color-schemes.ts): a scale that blends colours (a scheme that is a ramp, a range of texts on
   * a continuous scale, a named `interpolate`), and the expression functions `rgb`, `hsl`, `lab`, `hcl`, `luminance`, `contrast`.
   */
  color: {
    rgb: typeof rgb; hsl: typeof hsl; lab: typeof lab; hcl: typeof hcl; luminance: typeof luminance; contrastRatio: typeof contrastRatio
    interpolateText: typeof interpolateText; interpolateRgb: typeof interpolateRgb; isColor: typeof isColor
    /** The colour interpolators a scale's `interpolate` names, by the key scale.ts makes of the name (`Hcl`, `RgbBasis`...). */
    interpolators: ReadonlyMap<string, unknown>
    rampScheme: typeof rampScheme
  }
  /**
   * The scale types besides linear, ordinal, band, point and the calendar ones (scale-warped.ts, scale-classes.ts): log, pow, sqrt,
   * symlog, identity, sequential and diverging (a continuous scale over colours is one), quantile, quantize, threshold, bin-ordinal.
   */
  scales: {
    log: typeof log; pow: typeof pow; sqrt: typeof sqrt; symlog: typeof symlog; identityScale: typeof identityScale
    sequential: typeof sequential; sequentialLog: typeof sequentialLog; sequentialPow: typeof sequentialPow; sequentialSqrt: typeof sequentialSqrt
    sequentialSymlog: typeof sequentialSymlog; diverging: typeof diverging; divergingLog: typeof divergingLog; divergingPow: typeof divergingPow
    divergingSqrt: typeof divergingSqrt; divergingSymlog: typeof divergingSymlog
    quantileScale: typeof quantileScale; quantize: typeof quantize; threshold: typeof threshold; binOrdinal: typeof binOrdinal
  }
  /** The legend builder (guide-legend.ts): a spec with `legends`. */
  legend: { buildLegend: typeof buildLegend; entriesRefusal: typeof entriesRefusal; legendType: typeof legendType; placeLegendStack: typeof placeLegendStack }
  /** The grid layout of a group's children (trellis.ts): a spec with a `layout`. */
  layout: { layoutFacet: typeof layoutFacet }
  /** The pulse path of the incremental engine (incremental-engine.ts): a dataset re-derived from a change of its rows. */
  pulse: { applyPipelineWithPulse: IncrementalEngine['applyPipelineWithPulse'] }
  /** vega-selections' functions (selections.ts): an expression that calls `vlSelectionTest` and the like. */
  selections: { selectionTest: typeof selectionTest; selectionIdTest: typeof selectionIdTest; selectionResolve: typeof selectionResolve; selectionTuples: typeof selectionTuples }
  /** The static screen of regular expressions (regex-screen.ts), run under limits before any pattern is compiled. */
  regex: { regexHazard: typeof regexHazard }
  /** The SVG path reader and vega's replay of it (path-data.ts): custom symbol shapes and the bounds of path strings. */
  svgpath: { svgPathCommands: typeof svgPathCommands; drawnPathCommands: typeof drawnPathCommands; renderSvgPath: typeof renderSvgPath }
  /** The scene intersection behind the `intersect()` expression function (scene-intersect.ts). */
  intersect: { sceneIntersect: typeof sceneIntersect }
  /** The dataset edits of `modify()` and `setdata()` (modify.ts). */
  modify: { planModify: typeof planModify; newChangeset: typeof newChangeset; applyChangeset: typeof applyChangeset }
  /** The scheduler of `timer` event streams (timer.ts). */
  timer: { timers: Timers }
  /** The canvas renderer (canvas.ts) as `<Chart renderer="canvas">` uses it: asked for by the renderer prop, never by a spec. */
  canvas: {
    createCanvasEvents: typeof createCanvasEvents; renderSceneToCanvas: typeof renderSceneToCanvas
    renderSceneToCanvasAppend: typeof renderSceneToCanvasAppend; paintsSameAs: typeof paintsSameAs; snapshotCanvasScene: typeof snapshotCanvasScene
    sceneImageUrls: typeof sceneImageUrls; loadImages: typeof loadImages; withSceneImages: typeof withSceneImages
  }
  /**
   * The signal event loop (signals.ts) as the React shells bind it: asked for by a chart that binds it (a spec that declares signals,
   * or a host that listens to them: `specNeeds(...).eventLoop`), never read by an evaluation.
   */
  signals: { bindSceneSignals: typeof bindSceneSignals }
}

export type EnginePart = keyof EngineParts

/** Every part, in the order `partsNeeded` lists them. */
export const ENGINE_PARTS: readonly EnginePart[] = Object.freeze([
  'aggregate', 'window', 'reshape', 'time', 'curves', 'color', 'scales',
  'legend', 'layout', 'pulse', 'selections', 'regex', 'svgpath', 'intersect', 'modify', 'timer', 'canvas', 'signals',
])

const slots: Partial<EngineParts> = {}

/** Put a part in its slot (what each `part-*.ts` module does when it is imported). */
export function installPart<K extends EnginePart>(name: K, impl: EngineParts[K]): void {
  slots[name] = impl
}

/** Whether a part is in its slot, however it got there (an entry that carries it, or an earlier `loadParts`). */
export function partLoaded(name: EnginePart): boolean {
  return slots[name] !== undefined
}

/**
 * The public entry that carries each part (importing it fills the slot), `null` for a part no entry fills: the pulse part (the
 * incremental engine asks for it in the background, `loadParts`), and the canvas renderer and the signal loop, which the React shells
 * load for the capability that uses them (no evaluation reads either). Typed per part, so a new part must say where it is carried; the
 * test (engine-parts-entries.test.ts) imports each entry in a fresh module registry and checks the claim both ways.
 */
export const CARRIED_BY: Readonly<Record<EnginePart, '@aster-charts/core' | '@aster-charts/core/signals' | null>> = {
  aggregate: '@aster-charts/core', window: '@aster-charts/core', reshape: '@aster-charts/core', time: '@aster-charts/core',
  curves: '@aster-charts/core', color: '@aster-charts/core', scales: '@aster-charts/core', legend: '@aster-charts/core',
  layout: '@aster-charts/core', pulse: null, selections: '@aster-charts/core', regex: '@aster-charts/core', svgpath: '@aster-charts/core',
  intersect: '@aster-charts/core/signals', modify: '@aster-charts/core/signals', timer: '@aster-charts/core/signals',
  canvas: null, signals: null,
}

/** What to do about an empty slot: the entry that carries the part, or how else it gets loaded. */
function howToLoad(name: EnginePart): string {
  const entry = CARRIED_BY[name]
  if (entry !== null) return `load it before evaluating (loadPartsFor in @aster-charts/core/addons), or import ${entry}, which carries it`
  if (name === 'canvas') return 'it belongs to the canvas renderer, which <Chart renderer="canvas"> loads (the canvas capability); no entry of @aster-charts/core carries it'
  if (name === 'signals') return 'it belongs to the signal loop, which <Chart> loads for a chart that binds events (the interaction capability); no entry of @aster-charts/core carries it'
  return 'load it with loadParts in @aster-charts/core/addons; no entry of @aster-charts/core carries it'
}

/** A part, which must be loaded: reading an empty slot throws (see the file header). */
export function part<K extends EnginePart>(name: K): EngineParts[K] {
  const impl = slots[name]
  if (impl === undefined) {
    throw new Error(`[aster] the "${name}" part of the engine is not loaded: ${howToLoad(name)}`)
  }
  return impl
}

/** A part when it is loaded, `undefined` when it is not (for the pulse path alone: see the file header). */
export function optionalPart<K extends EnginePart>(name: K): EngineParts[K] | undefined {
  return slots[name]
}

let requester: ((name: EnginePart) => void) | null = null

/** @internal Who loads a part the engine asks for while it runs (the on-demand loader sets it; see `requestPart`). */
export function setPartRequester(fn: ((name: EnginePart) => void) | null): void {
  requester = fn
}

/**
 * Ask for a part the engine could have used and went on without (the pulse path, which an evaluation replaces with a full
 * derivation): it is loaded in the background for the evaluations after this one. Nothing happens when no loader is installed.
 */
export function requestPart(name: EnginePart): void {
  requester?.(name)
}

/** @internal Take parts out of their slots and get a function that puts them back (a test seam for the lean path). */
export function withdrawParts(names: readonly EnginePart[]): () => void {
  const saved = names.map((n) => [n, slots[n]] as const)
  for (const n of names) delete slots[n]
  return () => {
    for (const [n, impl] of saved) {
      if (impl === undefined) delete slots[n]
      else (slots as Record<string, unknown>)[n] = impl
    }
  }
}
