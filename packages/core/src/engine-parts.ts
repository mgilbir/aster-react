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
 * datasets in full, which makes the same scene, and asks for the part so that the next one is incremental (runtime.ts).
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
import type {
  createCanvasEvents, loadImages, paintsSameAs, renderSceneToCanvas, renderSceneToCanvasAppend, sceneImageUrls, snapshotCanvasScene, withSceneImages,
} from './canvas.js'

export interface EngineParts {
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
}

export type EnginePart = keyof EngineParts

/** Every part, in the order `partsNeeded` lists them. */
export const ENGINE_PARTS: readonly EnginePart[] = Object.freeze(['legend', 'layout', 'pulse', 'selections', 'regex', 'svgpath', 'intersect', 'modify', 'timer', 'canvas'])

const slots: Partial<EngineParts> = {}

/** Put a part in its slot (what each `part-*.ts` module does when it is imported). */
export function installPart<K extends EnginePart>(name: K, impl: EngineParts[K]): void {
  slots[name] = impl
}

/** Whether a part is in its slot, however it got there (an entry that carries it, or an earlier `loadParts`). */
export function partLoaded(name: EnginePart): boolean {
  return slots[name] !== undefined
}

/** A part, which must be loaded: reading an empty slot throws (see the file header). */
export function part<K extends EnginePart>(name: K): EngineParts[K] {
  const impl = slots[name]
  if (impl === undefined) {
    throw new Error(`[aster] the "${name}" part of the engine is not loaded: load it before evaluating (loadPartsFor in @aster-charts/core/addons), or import @aster-charts/core, which carries it`)
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
