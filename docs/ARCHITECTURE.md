# Aster Charts Architecture

> **Status.** This document describes the code as it is. The runtime owns its whole stack
> ([ADR 0001](adr/0001-own-the-engine.md)): `@aster/core`, `@aster/react` and `@aster/vl` import
> nothing from `vega-*`, `d3-*` or `topojson-*` (`pnpm check:deps` checks the sources and the built
> `dist`); the real Vega and Vega-Lite packages are the test oracle only. Measured results (corpus
> counts, sweeps, bundle sizes, benchmark ratios) are not repeated here: they live in
> [TESTING.md](TESTING.md) and [PERFORMANCE.md](PERFORMANCE.md), each next to the command that produced it.
> [ROADMAP.md](ROADMAP.md) lists what is still open.

## Pipeline Overview

The rendering pipeline transforms a Vega (or Vega-Lite) spec into an SVG string through three stages:

```
VgSpec (JSON)
  ──compileChart──►  CompiledChart IR   ──evaluateChart──►  SceneRoot   ──renderSceneToSvg──►  SVG string
                    (packages/core/src/                   (packages/core/src/
                     compiler.ts)                           runtime.ts)
```

1. **compileChart** (`packages/core/src/compiler.ts`) consumes a Vega spec (`VgSpec`, an open record) and produces a `CompiledChart` IR containing typed arrays of data definitions, scale definitions, data transforms, mark definitions, axes, and legends.
2. **evaluateChart** (`packages/core/src/runtime.ts`) resolves the IR against `RuntimeInput` (data rows, width/height, signals). It resolves data, applies `CompiledTransform` operators eagerly, builds scale functions, and constructs a `SceneRoot` with `SceneGroup` / `SceneItem` nodes.
3. **renderSceneToSvg** (`packages/core/src/render.ts`) walks the `SceneRoot` tree recursively, dispatching on `marktype` (group, line, area, symbol, rect, rule, text, path, arc, shape, trail, image) to emit SVG elements.

The scene shapes (`SceneRoot`, `SceneGroup`, `SceneItem`, `SceneNode`) are defined in `packages/core/src/types.ts` and intentionally mirror `vega-scenegraph`'s JSON structure so the conformance oracle (real Vega, rendered headless) can be compared structurally.

Vega-Lite input is a separate step in front of this pipeline: `@aster/vl`'s `compile(vlSpec)` emits a Vega spec, which then follows the three stages above. `<Chart>` does this through the opt-in `@aster/react/vl` addon; `renderSpec` takes Vega only.

Public API:

```ts
import { renderSpec, compileChart, evaluateChart, renderSceneToSvg,
         compileExpr, buildScale, applyTransforms } from '@aster/core'
```

## Incremental evaluation

**Guarantee.** For any spec and any sequence of updates (value changes that grow or shrink a domain, row inserts/removes/reorders, length changes, signal and size changes, `changedDatasets`, `dataChanges`, `dataPulse`, session `evaluate`/`change`), the scene an incremental or streamed update produces deep-equals `evaluateChart(compileChart(spec), input)` built from scratch at that step. This is a correctness guarantee, not a best-effort optimisation: `packages/core/src/incremental-oracle.test.ts` generates random specs and update sequences and compares every step with a freshly compiled chart (`ASTER_ORACLE_SEEDS=2000 pnpm vitest run packages/core/src/incremental-oracle.test.ts` for a long sweep; a failure prints the seed and a shrunk step list).

**State model.**

- The compiled IR (`CompiledChart`) is immutable. `evaluateChart` never writes it: derived signal values, resolved multi-dataset scale domains and the `category` range are per-evaluation (or resolved once at compile time).
- Everything an evaluation remembers lives in one `IncrementalState` per compiled chart (`runtime.ts`): the previous final scales (plus their min/max or value census), each dataset pipeline's per-step outputs and indexes, and the previous top-level mark groups keyed by compiled-mark identity.
- An evaluation reads the committed state and builds a fresh draft. The draft becomes the committed state exactly once, after the evaluation succeeds (`evaluateChart`) or after the session's limit checks pass (`evaluateChartPending(...).commit()`). The few fast paths that update a structure in place for O(changed) cost first *claim* it, which flags the committed state stale: an evaluation that dies before committing can never leave a half-updated state behind (the next evaluation re-derives from scratch).
- Reuse is keyed by what a result actually depends on: the evaluation context (signals incl. `width`/`height`, `domainRaw`, text metrics; typed and structural, so an unchanged `[0, width]` derived signal is unchanged), every dataset the unit reads (closed over `source` chains, `lookup.from` and `data()`/`indata()` expressions), and each scale it reads (by object identity).
- Mark groups are matched to the previous scene by compiled-mark identity, never by source dataset or name. Group marks (facets, trellises, scoped groups) are always rebuilt.

**Scenes are never observably mutated after they are returned.** A structural update (insert/remove/reorder) builds a new items array. An append or same-length edit advances the engine-owned array in place (O(changes)) and hands it to the new group; the superseded group's `items` becomes a lazy snapshot (old length plus the overwritten items) that materialises on first read and composes across a chain, so earlier scenes can be read in any order, or never. Newer groups never reference older ones (an unreferenced old scene is collectable); an old scene that is retained but never read keeps one small undo record per later update alive. Always read `group.items` through the group: an array reference captured earlier is the engine's live array. The other live link is `scene.runtime` (the signal event loop's expression runtime), which reads the chart's datasets as they are *now*.

**Transforms.** Same-length and length-changing updates go through one engine (`applyStepWithPulse`): a same-length pulse is an append-only pulse that appends nothing. Per-transform fast paths exist for row-local transforms, `filter`, `fold`, `flatten`, `aggregate`, `joinaggregate`, `collect`/`sample`, `identifier`; `window` (which writes results in source order) and `stack` re-derive and are compared row by row; everything else re-derives. A transform is row-local only when its output row depends on nothing but its input row.

## Renderers, the DOM patcher and hit testing

**One attribute list per element.** `render.ts` defines, for every SVG element the scene produces (symbol, rect, line, area, trail, text, arc, path, image, guide leaves, frame, background, gradients, clip paths), one `*Attrs(item, sink)` function. The string renderer (`renderSceneToSvg`) writes it through `StringAttrSink` (escaped `name="value"` text, the single `escAttr`/`escText` writer); the DOM descriptor builder (`dom.ts`) writes the same function through `PairAttrSink` (`[name, value]` pairs for `setAttribute`). Neither side owns a list of its own, so they cannot drift; `dom.ts` only decides structure (nesting, clip registration, per-item descriptor caching, `denseMarks` batching, which deliberately does not mirror the string output). The paint of every element (fill, stroke, dash, cap, join, opacity, blend: vega's `stylesAttr`) is one function, `paintAttrs`, so a paint property cannot be dropped by one mark kind or one renderer; text geometry (`textItemDesc`), item transforms (`rotateItemTransform`/`transformItemTransform`), the frame (`frameBackgroundPath`/`frameItem`) and the d3-arc port (`arcInto`) are shared with the canvas painter. Clip ids are content-addressed (`svg-defs.ts`), so a descriptor never depends on traversal order. `packages/conformance/scripts/dom-string-parity.test.mts` enforces it over the whole conformance corpus with no allow-list, and `dom-regressions.test.ts` over hand-built scenes for what the corpus lacks. The canvas painter still has its own paint code; `canvas.test.ts` and the Chromium canvas gate compare it with the SVG output.

**The DOM patcher** matches children by position. A reused item keeps its cached descriptor (`clean`), and a clean descriptor is only skipped when the element it lands on was last patched with that very descriptor; after a removal or reorder it is compared and written like any other (`dom-oracle.test.ts` checks patched DOM against a freshly built one over random insert/remove/reorder sequences, per-item and dense).

**Canvas append painting** (`renderSceneToCanvasAppend`) paints only appended marks over the previous frame and returns `false` (caller repaints in full) unless the result equals a full repaint: every existing item is untouched (same array lineage, no `__editGen` stamp, no newer `__gen` under a reused group object), every guide is unchanged (the context has no clear, so a changed guide would ghost), and the appended marks cannot land on paint a full repaint draws above them. `canvas-append-oracle.test.ts` (recorded paint) and the second phase of `pnpm conformance:canvas` (real Chromium pixels) check it over random session and stream sequences.

**The hit index** (`@aster/core/hit`) picks against the geometry the renderers paint: the flattened fill/stroke outline of arcs, paths, shapes, geoshapes, areas, lines and trails, the symbol's own shape and rotation, the rounded rect outline, and text from the layout's text bounds rotated about its anchor. Points within 2px of painted geometry count as hits (pointing slack). Cell ranges are clamped to the grid and entries covering many cells are kept in a short side list, so no item can make the index allocate without bound. `hit-geometry.test.ts` checks it against geometry taken from the canvas renderer.

## Expression Engine

Expressions (formulas, filters, signal updates, mark encodings) are parsed by `packages/core/src/expr-parser.ts`
(an on-demand lexer and a precedence-climbing parser that accept and refuse exactly what `vega-expression` does,
with its diagnostics, producing a plain ESTree-shaped tree) and compiled once into closures by
`packages/core/src/expr-interpreter.ts` (the semantics of `vega-interpreter`, with Aster's stricter sandbox).
Nothing is compiled with `new Function` or `eval`. The function table the interpreter calls lives in
`packages/core/src/expression.ts`; it mirrors the documented `vega-functions` surface and is bound to the
runtime's scales and data, to the owned type/array/string/math utilities (`util.ts`), colour spaces
(`color.ts`), calendar (`time.ts`) and format layer (`format.ts`, `time-format.ts`, `locale.ts`):

| Group | Functions |
|-------|-----------|
| Scale / projection / data | `scale`, `invert`, `domain`, `range`, `bandwidth`, `bandspace`, `copy`, `data`, `indata`, `pluck` |
| Date-time | `year/quarter/month/week/day/date/hours/…` (+ all `utc*` variants), `datetime`, `utc`, `time`, `timeOffset`/`utcOffset`, `timeSequence`/`utcSequence`, `dayofyear`, `timezoneoffset`, `now` |
| Array | `extent`, `clamp`, `lerp`, `sequence`, `slice`, `reverse`, `sort`, `join`, `peek`, `span`, `inrange`, `clampRange`, `indexof`, `lastindexof` |
| String | `truncate`, `pad`, `upper`, `lower`, `split`, `trim`, `replace`, `substring`, `test`/`regexp`, `parseFloat`/`parseInt` |
| Color | `rgb`, `hsl`, `lab`, `hcl`, `luminance`, `contrast` |
| Formatting | `format`, `timeFormat`/`utcFormat`, `timeParse`/`utcParse`, `timeUnitSpecifier`, `month*`/`day*` |

Hosts add functions with `registerExpressionFunction` (vega's `expressionFunction`); see [API.md](API.md).

Signals are values in the evaluation context. Signal `update` expressions are resolved to a fixed point in the runtime
(`resolveSignalUpdates`), so a scale range/domain or an encoding can reference a derived signal. Event-driven
`signal.on` handlers are real: `@aster/core/signals` reimplements the behaviour of `vega-event-selector` (its own `event-selector.ts`), `vega-view` and
`vega-runtime` that turn DOM events into signal updates (selectors, `between`, filters, `throttle`, `consume`,
`markname:event`), and `<Chart>` re-evaluates the scene when a signal changes ([INTERACTION.md](INTERACTION.md)).
A signal written into a running chart renders like Vega except in the `retained` cases described under
"Deviations from Vega" below.

## Config & style resolution

`compileChart` reads `spec.config` and applies it as encode/property defaults (encode always wins): `config.background` → root background, `config.view` / `config.style.cell` → frame stroke (a `transparent` stroke serializes as *no* stroke), `config.style.<marktype|name>` → mark encode defaults (e.g. a `rect` style's `fill`/`cornerRadius`), and `config.axis` / `config.legend` → guide defaults. The chart `title` (string or object, with `subtitle`) merges from `config.title` and the vega-theme style defaults (fontSize 13, bold, offset 4, subtitlePadding 3).

## Geo projections & the addon boundary

`packages/core/src/geo.ts` builds projections (`mercator`, `albers`, `albersUsa`, `equirectangular`, `orthographic`, …) from the compiled `projections` spec the way vega's Projection transform does, resolving `scale`/`translate`/`center`/`rotate` signal params against the runtime; the `geoshape` transform and shape marks route geometry through the projection's `GeoPath` (`geo-path.ts`; a path with no projection draws coordinates as they are).

The geo engine is Aster's own design and matches d3-geo/vega bit for bit (the generated differential pins it, see TESTING). A GeoJSON object is flattened once into an **event buffer** (`geo-events.ts`: points, line and polygon starts and ends, the sphere), and every stage is a pure function from one buffer to another: rotation and clipping to the visible sphere (`geo-clip.ts`: antimeridian cut, small-circle cap, cut pieces re-joined into rings along the clip boundary), projection with adaptive resampling (`geo-resample.ts`), clipping to the screen rectangle. A projection (`geo-projections.ts`: raw projection formulas in `geo-raw.ts`, plus scale/translate/centre/rotation/clip state) offers `project`/`invert` for one position and `planar` for a whole buffer; the path string and the planar measures (`geo-path.ts`) and the spherical measures (`geo-sphere-measures.ts`) are folds over the final buffer. No state outlives a call. The hot loops are written for a cold start, where compile time is most of a render: each stage walks its buffer in batches of 128 events through one method (a loop that runs long inside one call is compiled twice by V8), methods and not per-instance closures are the call targets (a closure that changes between calls deoptimises its caller), a ring that crosses neither the antimeridian nor a pole is passed through the sphere clip, and a buffer that lies strictly inside the clip rectangle is passed through the rectangle clip. Events carry the index of the input event they descend from, which is how the three parts of the albersUsa composite are interleaved back into the order a streaming pipeline would have written them.

**Projections that fit data.** A projection with `fit` reads its extent from datasets and signals (`data('a')`, a `geojson` transform's signal), so the runtime keeps a projection registry: it rebuilds a projection when a dataset or signal it was fitted to changes (an epoch counter), builds datasets on demand when a fit needs one that has not been evaluated yet, and treats `geopoint` / `geoshape` as not row-local when their projection fits (a row's pixels depend on all rows). The `geojson` transform publishes its collection as the signal it names. `geoshape` reads its feature from the item and measures the path with an unrounded bounding context (`projectedBounds`, a lazy thunk on the item), because vega's group layout uses unrounded bounds and a rounded path would shift a concat grid by a pixel.

Because heavy feature areas are only used by a small fraction of specs, they are **not** reachable from the `@aster/core` barrel. The core code paths consult injection registries (`packages/core/src/registry.ts`: `geoRegistry`, `transformRegistry`, `dataFormatRegistry`); five opt-in addon entries register their implementations:

| Addon | Registers |
|---|---|
| `@aster/core/geo` | the projections (`buildProjection`, `projectedPath`) and the contour generator (`contourRun`) |
| `@aster/core/transforms` | the rare-layout transforms — `kde`, `kde2d`, `isocontour`, `heatmap`, `density`, `quantile`, `regression`, `loess`, `pack`, `partition`, `treemap`, `tree`, `treelinks`, `force`, `wordcloud`, `voronoi`, `geopath`, `label` (implementations in `transform-extra.ts` (`voronoi` on `delaunay.ts`, `voronoi.ts` and `orient.ts`), `hierarchy-layout.ts` with `circle-pack.ts`, `treemap-tiling.ts` and `hierarchy-tree.ts`, `force-layout.ts` with `quadtree.ts`, `raster-transforms.ts`; `label.ts` places labels as vega-label does, on an occupancy grid, and `label-draw.ts` draws the marks it avoids with `raster.ts`, a coverage-only 2D context that follows Skia's rasterizer, so it needs neither a canvas nor a DOM), and the distribution functions of the expression language (`quantileNormal`, `densityUniform`, ... in `stats-functions.ts`) plus `treePath` / `treeAncestors` |
| `@aster/core/load` | the text-format readers (`csv`/`tsv`/`dsv`, `topojson`; `dsv.ts`, `topojson.ts`) and `loadSpecData`, which vets every URL against a policy (protocols, credentials, private hosts, redirects, size and time bounds), fetches each `url` dataset and inlines its values so the synchronous pipeline runs unchanged ([LIMITS.md](LIMITS.md)) |
| `@aster/core/dom` | the incremental DOM patcher (`patchSceneDom`, `sceneToDomDesc`, `createChartSession`); `<Chart>` now defaults to this path |
| `@aster/core/signals` | the signal→view event loop (`bindSceneSignals`, `stampDatumAttrs`) that binds a spec's `signal.on` streams to the rendered svg |

**Add-ons load themselves.** A host that knows what its specs need imports the add-ons (`import '@aster/core/geo'`); the shells and hooks also load them on demand, so a spec renders with nothing imported. `@aster/core/addons` reads the spec's structure (a transform of the transforms add-on, a `contour` transform or a `projections` entry for geo, a `csv`/`tsv`/`dsv`/`topojson` format for load, in `data` and in every mark's `data` / `transform` at any depth; no evaluation, no regular expression, cached per spec object) and imports exactly those, each at most once; an add-on the app imported itself is recognised by what it registered and never imported again. Test: `packages/conformance/src/addons-needed.test.ts` checks the detector against the engine itself over the 993 corpus specs (the add-ons discovered by loading one at a time on each "load the addon" failure are exactly the ones named, and a render with just those equals a render with all). The React wait is a Suspense wait (`React.use`), like an async `spec` and `useSpecData`: `<Chart>`, `<SvgChart>`, `useChart`, `useChartStream` suspend until the add-ons are there (a boundary above shows its fallback; with none the new root waits), render the same document the static path renders, and report a failed import through `onError` / the hook's `error`. The synchronous entry points (`renderSpec`, `renderChartToStaticMarkup`, `hydrateChart`) cannot wait and keep the actionable error; `loadAddonsFor(spec)` is the awaitable step for them. In a worker the entry (`@aster/react/worker-entry`) imports what a message's spec needs before it handles it, in arrival order; the main-thread fallbacks of the worker hooks wait the same way. The Vega-Lite compiler stays an explicit import (`@aster/react/vl`). Data is never fetched on its own: a `url` dataset is still resolved by `loadSpecData` / `useSpecData` (a fetch is the host's decision, under its URL policy), only the readers for its format load by themselves.

`@aster/react/vl` is the same pattern at the grammar level: the Vega-Lite compiler (`@aster/vl`) is registered by `import '@aster/react/vl'`, so Vega-only hosts do not pay for it. A spec that needs a gated feature without its addon loaded gets an actionable error naming what to import first. `packages/benchmarks/scripts/budget.mjs` gates one bundle per import pattern (core `renderSpec`, `useChart`, `<Chart>`, `<Chart>` + VL, and each core addon as its marginal cost on top of core); the measured sizes are in [PERFORMANCE.md](PERFORMANCE.md#bundle-sizes).

## ChartCore and the two shells

`@aster/react` has one chart implementation, `ChartCore` (`packages/react/src/ChartCore.tsx`: evaluation, the DOM patcher, pan/zoom,
selection, the a11y tree, the event loop). It receives its optional capabilities as injected values, never imports them:
the canvas renderer (`CanvasCapability`, `@aster/core/canvas`) and hit testing + the signal loop (`InteractionCapability`,
`@aster/core/hit`, `@aster/core/signals`). `<Chart>` (`Chart.tsx`) and `<SvgChart>` (`SvgChart.tsx`) are shells that render
`<ChartCore>`: `<Chart>` injects both capabilities, `<SvgChart>` injects nothing itself and passes through the `interaction`
its caller gives it. So `@aster/react/lite` (`SvgChart`) never reaches the canvas module, and `@aster/react/interaction`
(the `interaction` value) is the only way hit and signals enter a lite bundle. The shell split costs `<Chart>` 0.7 kB gzip
(the property reads through the capability objects, and the missing-capability report that only `<SvgChart>` can trigger).

`<SvgChart>` was chosen over lazy-loading the heavy modules: nothing loads asynchronously, the first paint is synchronous and
SSR-safe, and the cost is explicit in the importing code.

**Making drift hard.** A second component that mostly copies the first is where a prop gets handled in one and forgotten in
the other. Six mechanisms, each with a check that fails when the property it protects is broken:

| Mechanism | Where | What breaks it |
|---|---|---|
| One implementation; the shells hold no logic | `Chart.shells.test.ts`: each shell at most 14 code lines, no hooks, no control flow, one `<ChartCore>`; the value-import graph of `lite.ts` never reaches `core/canvas`, `core/hit`, `core/signals` or the capability modules | a hook, a branch or a helper in a shell; a value import of a capability in `ChartCore` |
| Props parity | `parity.assert.ts` (type-only, in `pnpm typecheck`): every `ChartProps` / `ChartHandle` key is shared (same type), interaction-only or excluded with a reason, in the lists of `svg-chart-types.ts` | a new prop on `<Chart>` nobody decided about; a shared prop whose type differs |
| Type contract | `Chart.types.test.ts` compiles `type-fixtures/`: what must compile, what must fail on exactly the marked lines, and that a prop added to `ChartProps` or a method added to `ChartHandle` makes `parity.assert.ts` fail | loosening the union on `interaction`; a parity assertion that no longer fires |
| One test matrix | `testing/variants.tsx`: `forEachVariant(needs, (Chart, variant) => …)` runs each component test on `Chart`, `SvgChart` and `SvgChart+interaction`. A test declares `svg`, `canvas`, `interaction`, `signals`; a variant that lacks one asserts the documented failure (the runtime report, or the refusal) in its place; the plain variant refuses interaction props and the event-stream report, so a test cannot pass vacuously on a variant that ignores what it exercises | a behaviour that differs between variants; a test that needs a capability it did not declare |
| Matrix coverage | `Chart.matrix.test.ts`: no test file may render `<Chart>` outside the matrix unless listed in `DIRECT_CHART_TESTS` with a reason (stale entries fail) | a new test written against `Chart` directly |
| Output parity | `Chart.corpus-parity.test.tsx` (in `pnpm test`): over all 794 corpus specs, server markup, a client mount and hydration of `<SvgChart interaction>` and `<SvgChart>` equal `<Chart renderer="svg">` byte for byte, with no `data-datum` attribute anywhere; the a11y overlay is in the compared DOM | any markup, attribute or a11y difference |

The browser gate, the bundle-shaking gate (module assertions on the esbuild metafile), the budget and `verify:publish` add
the real-browser behaviour and the size/import guarantees ([PERFORMANCE.md](PERFORMANCE.md#bundle-sizes), [TESTING.md](TESTING.md)).

## Side effects and tree-shaking

The package manifests declare `sideEffects` so a bundler can drop every module an app does not use: `@aster/vl` is `false`, `@aster/core` and `@aster/react` list the files below. A blanket `false` would be wrong because several documented imports work only through a module's top-level effect. The audit covered every module in `packages/{core,react,vl}/src` for top-level effects (registrations, `globalThis` writes, polyfills, prototype patches, mutable singletons whose initialisation matters, imports done only for their effect). Everything else that runs at import time only fills the module's own tables (`scale.ts` registers the scale types into its own map, `locale.ts`/`format.ts`/`time-format.ts` build their default locale, the `geo-*` ports and `time.ts` build their own constants and caches, `data-format.ts` registers the `json` reader in the registry it reads from), so it stays whenever the module is used and needs no listing.

| File (dist) | Effect | Why it must be listed |
|---|---|---|
| core `addon-geo.js` | assigns `geoRegistry.buildProjection/projectedPath/contourRun` | `import '@aster/core/geo'` exports nothing used |
| core `addon-transforms.js` | bare `import './transform-extra.js'` | the entry only exists for its effect |
| core `label.js` | `transformRegistry.set('label', ...)` | imported bare by `addon-transforms.js`; listed in `sideEffects`, without which a bundler drops the import and `label` is missing |
| core `transform-extra.js` | `transformRegistry.set(...)` for kde, kde2d, isocontour, heatmap, density, quantile, regression, loess, pack, partition, treemap, tree, treelinks, force, wordcloud, voronoi, pie, cross, countpattern, dotbin, geopoint, geopath, geojson, linkpath | reached only through the bare import above |
| core `addon-load.js` | `dataFormatRegistry.set('csv' \| 'tsv' \| 'dsv' \| 'topojson')` | `import '@aster/core/load'` for the readers alone must register them |
| core `guide-caption.js` | `installGuideCaptions(...)` into `render.ts` | imported bare by `index.ts` and `dom.ts`; without it axis/legend `aria-label` captions vanish. Canvas and hit never import it, so they do not pay for it |
| react `vl.js` | `registerVegaLiteCompiler(...)` (a `globalThis` registry under `Symbol.for('@aster/react/vega-lite-compiler')`) | `import '@aster/react/vl'` |
| react `worker-entry.js` | `globalThis.onmessage = ...` | `import '@aster/react/worker-entry'` is the worker's whole body |

`scripts/check-bundle-shaking.mjs` (`pnpm check:bundle`, a `pnpm check` gate) bundles a tiny app per documented import pattern with esbuild (production, tree-shaking), executes the bundle in a fresh node process (jsdom where it needs a DOM) and asserts the behaviour: Vega-Lite registered and rendered, geo projections, rare transforms, URL and inline csv data, `<Chart>` on the server and the client, `useChart` with and without serialising, `/ssr` hydration, the worker handler and the worker entry, the dom/canvas/hit/signals addons, `<SvgChart>` alone and with `interaction` (asserted on the esbuild metafile: no `core/canvas`, no `core/hit` or `core/signals` without the capability), the lazy `await import('@aster/core/geo')` form, and negative controls (without the addon the spec asks for it). `node scripts/check-bundle-shaking.mjs --blanket-false` simulates `"sideEffects": false` and must fail (10 of 23 patterns do; `scripts/bundle-shaking.test.mjs` asserts it); `--bundler vite` runs the same patterns through Vite/Rollup (a vitest dependency in the pnpm store; not a gate). `pnpm verify:publish` repeats the exercise on the installed tarballs.

## Scales

Scales are built by `packages/core/src/scales.ts`, a transcription of `vega-parser`'s scale parsing and `vega-encode`'s `Scale` transform (domain, range, interpolate, nice, bins, scheme and range-step configuration), on top of the owned ports of `vega-scale` and d3-scale (`scale.ts`, `scale-d3.ts`), d3-array/internmap (`arr.ts`), d3-interpolate (`interp.ts`) and the colour schemes (`scale-schemes.ts`). The structure follows upstream function for function; behaviour is pinned by oracle vectors recorded from the real packages, including whole "scale spec to built scale" vectors (`testdata/vectors/spec-level/`). Tick generation is the same code path as Vega's, so tick positions and labels match.

## Transforms

Eager data transforms are dispatched by `applyTransform` in `packages/core/src/transform.ts`; the implementations are in `transform-basic.ts`, `transform-agg.ts`, `transform-stats.ts` (its regression and loess fits and `sampleCurve` are in `curve-fits.ts`) and `transform-extra.ts`. Each is a function from input rows to output rows that never mutates its input. The dispatch handles: `formula`, `filter`, `collect`, `sample`, `fold`, `flatten`, `bin`, `impute`, `aggregate`, `joinaggregate`, `window`, `stack`, `extent`, `lookup`, `pivot`, `sequence`, `identifier`, `timeunit`, `cross`, `countpattern`, `dotbin`, `pie`, `stratify`, `contour`, `graticule`, `geojson`, `geopoint`, `geoshape`, `linkpath`, `project`, and (through the `@aster/core/transforms` addon) `kde`, `kde2d`, `isocontour`, `density`, `quantile`, `regression`, `loess`, `pack`, `partition`, `treemap`, `tree`, `treelinks`, `force`, `geopath`, `wordcloud`, `voronoi` and `label`. A mark's `lookup`, `linkpath`, `force`, `geopath`, `voronoi`, `label`, `heatmap` and `wordcloud` transforms run on the encoded items after the encode, as vega-parser's mark transforms do. Any other type throws `[aster] unsupported transform type "<type>"`. Option coverage follows Vega's, case by case, through the transform vectors and the transform matrix ([TESTING.md](TESTING.md)); the deliberate differences are listed under "Deviations from Vega".

`TransformContext` provides an `ExpressionRuntime` (for formula/filter), the signal values, a cross-dataset lookup for `lookup`, and the hierarchy and projection tables for the geo/hierarchy operators. Transforms run sequentially per dataset inside `evaluateChart`.

## Rendering

The SVG serializer in `packages/core/src/render.ts` walks the `SceneRoot` tree and emits SVG with the structure of `vega-scenegraph`'s SVG renderer: `mark-*` groups with Vega's classes, `role`, `aria-roledescription` and `aria-label` (axes, legends and titles are `mark-group role-axis` / `role-legend` / `role-title` containers around the item group and its per-mark containers), clip paths and gradients as `<defs>`. The captions are one implementation shared with the accessibility tree (`buildA11yTree`). The conformance canonicalizer compares painted records (geometry, paint, text, order) and, separately, this structure (`N-structure` in `packages/conformance/src/normalize.ts`: every group's class, role, `aria-*`, nesting), so neither can drift. Key design concerns:

- **Frame (plot bounds)** — rendered as a path with 0.5-pixel alignment when the view has a stroke, matching Vega's cell boundary; the view content sits in a `<g>` translated by the padding.
- **Mark dispatch** — `renderGroup` routes on `marktype` (`group`, `line`, `area`, `symbol`, `rect`, `rule`, `text`, `trail`, `path`, `shape`, `geoshape`, `image`, `arc`); each mark kind has one `*Attrs(item, sink)` function (see "Renderers, the DOM patcher and hit testing" above).
- **Guides** — an axis, a legend and a title are each a few marks defined by encode blocks, with Aster's own description of what a guide is (`guide-encode.ts`: `propsOf` reads a property from the spec, then the config; `setChannels` files it under `enter` or `update`; `customize` lays the user's `encode.<part>` over it; `withStyleDefaults` fills what is left from `config.style`; a `null` is a value that reaches the item). `guide-axis.ts` describes an axis by the way it runs and the side it faces and places it from what was measured; `guide-legend.ts` and `guide-title.ts` do the same for legends (entries, gradient strip or bands, title) and titles (with the stack of a view's legends placed by `placeLegendStack`). `trellis.ts` is the grid layout over boxes (`placeGrid`) that facets, a legend's entries and a view's legends share. Their output is Vega's (a property, an `encode` block or a `config.style` reaches an item the way it does there, for every property rather than a list of them, and positions come from the same arithmetic), which the generated differentials in `docs/TESTING.md` hold them to. The discretizing scales' legend labels are `labelFormat` / `labelValues` (`scale.ts`).
- **Scopes and an aborted pass** — `spec-structure.ts` walks a spec in vega-parser's order and scoping (a data set name may repeat in a nested group but not in one scope). When an axis cannot make its ticks, Vega's dataflow pass aborts at that operator (`axisTicksFailed` in `runtime.ts`): a scale ranked late in its own scope leaves a scenegraph Vega cannot serialize (refused here), any other leaves a clean cut (the axes before it, unlaid-out, and nothing built after it in its scope or in the scopes built after it). The differential test `axis-ticks-failure-vs-vega.test.ts` pins the rule per scope.
- **Path numbers** — paths produced by the shape code (lines, areas: `shape.ts`; symbols, arcs: `render.ts`) are written with the three-decimal rounding Vega's d3-path buffers apply (`digits = 3`); rect and frame paths are written with raw doubles, as Vega does. The conformance canonicalizer does not paper over either.

## Conformance

The conformance harness (`packages/conformance`) uses the real Vega and Vega-Lite packages, pinned in its devDependencies, as the oracle. Its gates (the list that runs is `scripts/gates.mjs`; counts and commands are in [TESTING.md](TESTING.md)):

- **SVG corpus** (`src/run.ts`): every `corpus/*.vg.json` (raw Vega) and `corpus/*.vl.json` (Vega-Lite, compiled by upstream `vega-lite`) is rendered by real Vega (headless) and by `@aster/core`'s `renderSpec`, both canonicalized by `src/normalize.ts` and diffed. The canonicalizer records every paint, geometry and text attribute, the full transform and the paint order, and normalizes only representation (each normalization has its reason in the file); `normalize.test.ts` plants one difference at a time and requires it to be reported.
- **Vega-Lite corpus** (`src/run-vl.ts`): the same `.vl.json` entries compiled by `@aster/vl` (not upstream), diffed against the upstream-compiled render, and the Vega `@aster/vl` emits is also rendered through real Vega, which must not error or warn.
- **Scene differential** (`scripts/scene-diff.mts`): resolved scales per scope, mark and item multisets, and paint order compared with Vega's scenegraph before anything is serialized.
- **Guide captions** (`a11y-parity`), **transform option combinations** (`transform-matrix`), **schema sweeps** (`src/run-sweep.ts`: one generated chart per property/value of the Vega, Vega-Lite and signals schemas), **differential fuzzing** (`fuzz`), and the **real-browser** gates (Chromium text metrics, canvas pixels, batched-SVG pixels, signal event streams, React interaction).
- **Oracle vectors**: per-library input/output pairs recorded from the pinned packages and replayed by `pnpm test`.

Corpus entries set explicit numeric `width`/`height` and `autosize: 'none'` so layout is deterministic. Headless text metrics are matched by reimplementing Vega's estimate (`~~(0.8 * len * fontSize)`, see [FONTS.md](FONTS.md)).

### Gap probes (`packages/conformance/probes/`)

Known-incomplete areas are captured as feature probes under `probes/` and run via `pnpm probe`. A probe renders the same oracle diff as the corpus but is a diagnostic, never a blocking gate: its failure documents a real gap, and when the gap is implemented the probe is promoted into `corpus/`.

## Deviations from Vega

Aster matches Vega's output wherever the oracle can be run; where it deliberately does not, the difference is in the code with a comment and is listed here. Safety deviations (bounds on time, memory and input) are in [LIMITS.md](LIMITS.md).

| Area | Aster | Vega | Why |
|---|---|---|---|
| Randomness (`sample`, `ci0`/`ci1` bootstrap) | seeded LCG (`SEED`), a pure function of the rows | `Math.random` | an incremental evaluation must equal a fresh one; with the same stream the draw equals Vega's (pinned by vectors) |
| Input mutation (`joinaggregate`, `window`) | write onto copies | write onto the input tuples | engine-owned snapshots and scenes are never mutated |
| Lookup tables | prototype-less | plain objects | a data value such as `constructor` is a key, not an inherited member |
| `bin` without `extent` | derives the extent from the data | "Missing required bin parameter" | Aster extension |
| `{signal}` in scale `interpolate`/`gamma` | resolved | TypeError in `parseScaleInterpolate` | do not reproduce an upstream crash |
| Signals written into a running chart: `retained` | renders the fresh result for the new signals (a pure function of its inputs) | the running view retains its first autosize (and some other dataflow state), so its second render can differ from its own fresh render | an incremental session must equal a fresh evaluation; the sweep counts these cases as `retained` and the gate has a ceiling that can only be lowered |
| Unsupported or unknown features | throw a typed error naming the feature | some are silently ignored | no silent wrong charts; see [ERRORS.md](ERRORS.md) |
| SVG output of dense marks (`denseMarks`) | batched `<path>` chunks; pixel parity gated by `pnpm conformance:batch` | one element per item | node cost of large SVG; opt-out with `denseMarks={false}` |
| `force` that keeps running (`static: false`, `restart`) | the layout of the first tick, a pure function of its inputs; no animation | the simulation keeps ticking on a timer, the picture at the first frame is the first tick | the engine renders a snapshot; a spec that animates needs the event loop's timers |
| Signal-valued `url` of a dataset | `loadSpecData` loads the url for the signal's initial value (top-level signals, evaluated in order) | a dynamic loader that reloads when the signal changes | a static spec is loaded once; reload with `loadSpecData` again to follow a signal |
| Oracle crashes | not reproduced (TypeErrors upstream) | crash | the sweeps count these as `node-error` |
| An axis whose ticks fail over a late-ranked scale, with a domain or a title to draw | refused (`[aster] the ticks of the axis ... failed`) | the scenegraph has holes and Vega's own `toSVG` throws (`reading 'marktype'`) | there is no document to match; the cases Vega can draw are matched exactly |
| Names that are members of `Object.prototype` (`toString`) for data sets or scales | handled as any name | `vega.parse` crashes | do not reproduce an upstream crash |
| `vlSelectionResolve` over several tuples of one array-valued field (an interval over a discrete field, several units) | merges into fresh arrays; the store is left alone | the first tuple's own value array is the accumulator and grows in place, so the result and the store depend on it | a read must not rewrite the data it reads; the generated differential keeps such stores out of the resolve comparison |
| Voronoi cells of points with missing or non-numeric coordinates, or with coordinates beyond 1e150 | the call ends and answers once per row; the orientation test is exact | the reference loops forever on some such inputs, and its orientation predicate overflows past 1e150 | no spec may hang the host; the cells of finite coordinates are character-for-character the reference's (`differential-voronoi`, `differential-delaunay`) |
| Decoded topojson positions of a topology without `transform` | fresh arrays | the topology's own position arrays | the output may be modified without changing the topology |
| `dsv` quoting on write with a delimiter that is a regular expression class character (`-`, `]`, `\`, `^`) | quotes correctly | builds a character class from the raw delimiter, which throws or misquotes | do not reproduce an upstream crash |

## Known Limitations / Roadmap

The open items are in [ROADMAP.md](ROADMAP.md); the feature areas that are not covered are in [LIMITS.md](LIMITS.md) and the `@aster/vl` README ("Throws").

## Verification Commands

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm check                      # the whole gate list (scripts/gates.mjs)
pnpm probe                      # diagnostic only: documents known-incomplete features
pnpm --filter @aster/benchmarks run budget
```
