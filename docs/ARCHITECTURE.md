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
(a port of `vega-expression`'s lexer and Pratt parser, producing the same AST) and evaluated by
`packages/core/src/expr-interpreter.ts` (a port of `vega-interpreter`'s CSP-safe AST walker). Nothing is
compiled with `new Function` or `eval`. The function table the interpreter calls lives in
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
`signal.on` handlers are real: `@aster/core/signals` ports the parts of `vega-event-selector`, `vega-view` and
`vega-runtime` that turn DOM events into signal updates (selectors, `between`, filters, `throttle`, `consume`,
`markname:event`), and `<Chart>` re-evaluates the scene when a signal changes ([INTERACTION.md](INTERACTION.md)).
A signal written into a running chart renders like Vega except in the `retained` cases described under
"Deviations from Vega" below.

## Config & style resolution

`compileChart` reads `spec.config` and applies it as encode/property defaults (encode always wins): `config.background` → root background, `config.view` / `config.style.cell` → frame stroke (a `transparent` stroke serializes as *no* stroke), `config.style.<marktype|name>` → mark encode defaults (e.g. a `rect` style's `fill`/`cornerRadius`), and `config.axis` / `config.legend` → guide defaults. The chart `title` (string or object, with `subtitle`) merges from `config.title` and the vega-theme style defaults (fontSize 13, bold, offset 4, subtitlePadding 3).

## Geo projections & the addon boundary

`packages/core/src/geo.ts` builds projections (`mercator`, `albers`, `albersUsa`, `equirectangular`, `orthographic`, …) from the compiled `projections` spec on top of the owned ports of d3-geo and d3-geo-projection (`geo-lib.ts`, `geo-projections.ts`), resolving `scale`/`translate`/`center`/`rotate` signal params against the runtime; the `geoshape` transform and shape marks route geometry through `geoPath(projection)` (identity pixel-space path when no projection is named).

Because heavy feature areas are only used by a small fraction of specs, they are **not** reachable from the `@aster/core` barrel. The core code paths consult injection registries (`packages/core/src/registry.ts`: `geoRegistry`, `transformRegistry`, `dataFormatRegistry`); five opt-in addon entries register their implementations:

| Addon | Registers |
|---|---|
| `@aster/core/geo` | the projections (`buildProjection`, `projectedPath`) and the contour generator (`contourRun`) |
| `@aster/core/transforms` | the rare-layout transforms — `kde`, `density`, `quantile`, `regression`, `loess`, `pack`, `partition`, `treemap`, `wordcloud`, `voronoi` (implementations in `transform-extra.ts`) |
| `@aster/core/load` | the text-format readers (`csv`/`tsv`/`dsv`, `topojson`; `dsv.ts`, `topojson.ts`) and `loadSpecData`, which vets every URL against a policy (protocols, credentials, private hosts, redirects, size and time bounds), fetches each `url` dataset and inlines its values so the synchronous pipeline runs unchanged ([LIMITS.md](LIMITS.md)) |
| `@aster/core/dom` | the incremental DOM patcher (`patchSceneDom`, `sceneToDomDesc`, `createChartSession`); `<Chart>` now defaults to this path |
| `@aster/core/signals` | the signal→view event loop (`bindSceneSignals`, `stampDatumAttrs`) that binds a spec's `signal.on` streams to the rendered svg |

`@aster/react/vl` is the same pattern at the grammar level: the Vega-Lite compiler (`@aster/vl`) is registered by `import '@aster/react/vl'`, so Vega-only hosts do not pay for it. A spec that needs a gated feature without its addon loaded gets an actionable error naming what to import first. `packages/benchmarks/scripts/budget.mjs` gates the `@aster/core`, `/dom`, `/canvas`, `/hit`, `/load`, `/signals`, `@aster/react` and `@aster/react/vl` entries independently; the measured sizes are in [PERFORMANCE.md](PERFORMANCE.md).

## Scales

Scales are built by `packages/core/src/scales.ts`, a transcription of `vega-parser`'s scale parsing and `vega-encode`'s `Scale` transform (domain, range, interpolate, nice, bins, scheme and range-step configuration), on top of the owned ports of `vega-scale` and d3-scale (`scale.ts`, `scale-d3.ts`), d3-array/internmap (`arr.ts`), d3-interpolate (`interp.ts`) and the colour schemes (`scale-schemes.ts`). The structure follows upstream function for function; behaviour is pinned by oracle vectors recorded from the real packages, including whole "scale spec to built scale" vectors (`testdata/vectors/spec-level/`). Tick generation is the same code path as Vega's, so tick positions and labels match.

## Transforms

Eager data transforms are dispatched by `applyTransform` in `packages/core/src/transform.ts`; the implementations are in `transform-basic.ts`, `transform-agg.ts`, `transform-stats.ts` and `transform-extra.ts`. Each is a function from input rows to output rows that never mutates its input. The dispatch handles: `formula`, `filter`, `collect`, `sample`, `fold`, `flatten`, `bin`, `impute`, `aggregate`, `joinaggregate`, `window`, `stack`, `extent`, `lookup`, `pivot`, `sequence`, `identifier`, `timeunit`, `cross`, `countpattern`, `dotbin`, `pie`, `label`, `stratify`, `contour`, `graticule`, `geojson`, `geopoint`, `geoshape`, `linkpath`, `project`, and (through the `@aster/core/transforms` addon) `kde`, `density`, `quantile`, `regression`, `loess`, `pack`, `partition`, `treemap`, `wordcloud` and `voronoi`. Any other type throws `[aster] unsupported transform type "<type>"`. Option coverage follows Vega's, case by case, through the transform vectors and the transform matrix ([TESTING.md](TESTING.md)); the deliberate differences are listed under "Deviations from Vega".

`TransformContext` provides an `ExpressionRuntime` (for formula/filter), the signal values, a cross-dataset lookup for `lookup`, and the hierarchy and projection tables for the geo/hierarchy operators. Transforms run sequentially per dataset inside `evaluateChart`.

## Rendering

The SVG serializer in `packages/core/src/render.ts` walks the `SceneRoot` tree and emits SVG with the structure of `vega-scenegraph`'s SVG renderer: `mark-*` groups with Vega's classes, `role`, `aria-roledescription` and `aria-label` (axes, legends and titles are `mark-group role-axis` / `role-legend` / `role-title` containers around the item group and its per-mark containers), clip paths and gradients as `<defs>`. The captions are one implementation shared with the accessibility tree (`buildA11yTree`). The conformance canonicalizer compares painted records (geometry, paint, text, order) and, separately, this structure (`N-structure` in `packages/conformance/src/normalize.ts`: every group's class, role, `aria-*`, nesting), so neither can drift. Key design concerns:

- **Frame (plot bounds)** — rendered as a path with 0.5-pixel alignment when the view has a stroke, matching Vega's cell boundary; the view content sits in a `<g>` translated by the padding.
- **Mark dispatch** — `renderGroup` routes on `marktype` (`group`, `line`, `area`, `symbol`, `rect`, `rule`, `text`, `trail`, `path`, `shape`, `geoshape`, `image`, `arc`); each mark kind has one `*Attrs(item, sink)` function (see "Renderers, the DOM patcher and hit testing" above).
- **Path numbers** — paths produced by the d3-shape/d3-path ports (lines, areas, symbols, arcs) are written with d3-path's `digits = 3` rounding; rect and frame paths are written with raw doubles, as Vega does. The conformance canonicalizer does not paper over either.

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
| Oracle crashes | not reproduced (TypeErrors upstream) | crash | the sweeps count these as `node-error` |

## Known Limitations / Roadmap

The open items are in [ROADMAP.md](ROADMAP.md); the feature areas that are not covered are in [LIMITS.md](LIMITS.md) and the `@aster/vl` README ("Throws").

## Verification Commands

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm check                      # the whole gate list (scripts/gates.mjs)
pnpm probe                      # diagnostic only: documents known-incomplete features
pnpm --filter @aster/benchmarks run budget
```
