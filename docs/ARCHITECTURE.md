# Aster Charts Architecture

> **Superseded sections.** The decision to reuse pure Vega packages
> (`vega-expression`, `vega-scale`, …) in the runtime has been reversed:
> [ADR 0001](adr/0001-own-the-engine.md) commits the engine to reimplementing that
> stack, verified against pinned oracle vectors. The sections below describe the
> inherited design where it still stands, and are updated as each phase of
> [ROADMAP.md](ROADMAP.md) replaces the package it borrows.

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
3. **renderSceneToSvg** (`packages/core/src/render.ts`) walks the `SceneRoot` tree recursively, dispatching on `marktype` (line, area, symbol, rect, rule, text, path, arc) to emit SVG elements.

The scene shapes (`SceneRoot`, `SceneGroup`, `SceneItem`, `SceneNode`) are defined in `packages/core/src/types.ts` and intentionally mirror `vega-scenegraph`'s JSON structure so the conformance oracle (real Vega, rendered headless) can be compared structurally.

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

Expression evaluation uses two pure Vega packages:

- **vega-expression** (`parseExpression`) — parses the Vega expression DSL into an AST.
- **vega-interpreter** (`expressionInterpreter`) — evaluates that AST via a CSP-safe interpreter (no `new Function`).

A custom function context is bound to the runtime's scale and data lookups, plus the type/array/string/math utilities (`vega-util`), date-time units (`vega-time`), color parsing (`d3-color`), and formatting (`vega-format`). The context lives in `packages/core/src/expression.ts` and mirrors the documented `vega-functions` surface, including:

| Group | Functions |
|-------|-----------|
| Scale / projection / data | `scale`, `invert`, `domain`, `range`, `bandwidth`, `bandspace`, `copy`, `data`, `indata`, `pluck` |
| Date-time | `year/quarter/month/week/day/date/hours/…` (+ all `utc*` variants), `datetime`, `utc`, `time`, `timeOffset`/`utcOffset`, `timeSequence`/`utcSequence`, `dayofyear`, `timezoneoffset`, `now` |
| Array | `extent`, `clamp`, `lerp`, `sequence`, `slice`, `reverse`, `sort`, `join`, `peek`, `span`, `inrange`, `clampRange`, `indexof`, `lastindexof` |
| String | `truncate`, `pad`, `upper`, `lower`, `split`, `trim`, `replace`, `substring`, `test`/`regexp`, `parseFloat`/`parseInt` |
| Color | `rgb`, `hsl`, `lab`, `hcl`, `luminance`, `contrast` |
| Formatting | `format`, `timeFormat`/`utcFormat`, `timeParse`/`utcParse`, `timeUnitSpecifier`, `month*`/`day*` |

Signal values are exposed as `$`-prefixed parameters to `compileExpr`, matching Vega convention (`$width`, `$height`, etc.). Signal `update` expressions are resolved to a fixed point in the runtime (see `resolveSignalUpdates`), so a scale range/domain or an encoding can reference a derived signal such as `{"signal": "cx"}` where `cx` is `update: "width / 2"`. Event-driven `signal.on` handlers are intentionally ignored (static mode).

The reason only pure packages are reused — and **not** `vega-functions`, `vega-dataflow`, or `vega-scenegraph` — is to avoid runtime leakage. `vega-dataflow` carries reactive graphs, operators, and signals that are explicitly not part of the eager model. `vega-scenegraph` carries a mutable node tree that the SVG serializer replaces with a pure function. The result is a smaller, simpler runtime with no hidden dataflow layer.

## Config & style resolution

`compileChart` reads `spec.config` and applies it as encode/property defaults (encode always wins): `config.background` → root background, `config.view` / `config.style.cell` → frame stroke (a `transparent` stroke serializes as *no* stroke), `config.style.<marktype|name>` → mark encode defaults (e.g. a `rect` style's `fill`/`cornerRadius`), and `config.axis` / `config.legend` → guide defaults. The chart `title` (string or object, with `subtitle`) merges from `config.title` and the vega-theme style defaults (fontSize 13, bold, offset 4, subtitlePadding 3).

## Geo projections & the addon boundary

`packages/core/src/geo.ts` builds d3-geo projections (`mercator`, `albers`, `albersUsa`, `equirectangular`, `orthographic`, …) from the compiled `projections` spec, resolving `scale`/`translate`/`center`/`rotate` signal params against the runtime; the `geoshape` transform and shape marks route geometry through `geoPath(projection)` (identity pixel-space path when no projection is named).

Because heavy feature areas are only used by a small fraction of specs, they are **not** reachable from the `@aster/core` barrel. The core code paths consult injection registries (`packages/core/src/registry.ts`: `geoRegistry`, `transformRegistry`, `dataFormatRegistry`); five opt-in addon entries register their implementations:

| Addon | Registers |
|---|---|
| `@aster/core/geo` | d3-geo projections (`buildProjection`, `projectedPath`) and d3-contour (`contourRun`) |
| `@aster/core/transforms` | the rare-layout transforms — `kde`, `quantile`, `regression`, `loess`, `pack`, `partition`, `treemap`, `wordcloud`, `voronoi` (implementations in `transform-extra.ts`) |
| `@aster/core/load` | the text-format readers (`csv`/`tsv`/`dsv` via d3-dsv, `topojson` via topojson-client) and `loadSpecData`, which fetches every `url` dataset and inlines its values so the synchronous pipeline runs unchanged |
| `@aster/core/dom` | the incremental DOM patcher (`patchSceneDom`, `sceneToDomDesc`, `createChartSession`); `<Chart>` now defaults to this path |
| `@aster/core/signals` | the signal→view event loop (`bindSceneSignals`, `stampDatumAttrs`) that binds a spec's `signal.on` streams to the rendered svg |

`@aster/react/vl` is the same pattern at the grammar level: the from-scratch Vega-Lite compiler (~22.6 kB gzip) sits behind `import '@aster/react/vl'`, so Vega-only hosts get a ~136 kB base entry; with the addon the entry is ~158 kB (react-vega: 289 kB). A spec that uses a gated feature without its addon loaded gets an actionable "load `@aster/...` first" error. `budget.mjs` gates core, dom, canvas, hit, signals, React and React+VL entries independently and records the measured sizes next to the budgets.

## Scales

Scale construction is delegated entirely to `vega-scale` (a pure package built on d3-scale utilities). The wrapper in `packages/core/src/scales.ts` resolves domains and ranges from the `CompiledScale` IR, handles Vega-specific options (`reverse`, `round`, `clamp`, `padding`, `paddingInner`, `paddingOuter`, `zero`, `nice`), and returns d3/daily-compatible `vs.Scale` objects. Tick generation uses `vega-scale`'s tick factory, which guarantees tick positions match the real Vega renderer exactly.

## Transforms

Eager data transforms live in `packages/core/src/transform.ts`. Each transform is a pure function `(rows, params, ctx) -> rows` that processes an array of `Row` objects in place. The following transform types are implemented:

```
formula    — evaluate an expression per row
filter     — keep rows matching an expression
collect    — sort and deduplicate
bin        — create bin boundaries (limited support)
fold       — unpivot fields into key/value columns
flatten    — unnest array fields
impute     — fill missing values (limited support)
stack      — running accumulation with offset
aggregate  — group + reduce
window     — running computation (limited support)
joinaggregate — window without sliding (limited support)
```

Transforms are applied sequentially within `evaluateChart` via `applyTransforms(rows, transforms, ctx)`. The `TransformContext` provides an `ExpressionRuntime` (for formula/filter), signal values, and a cross-dataset lookup function (for `lookup`, deferred).

## Rendering

The SVG serializer in `packages/core/src/render.ts` walks the `SceneRoot` tree and emits SVG. Key design concerns:

- **Frame (plot bounds)** — rendered as a `<path>` with 0.5-pixel alignment (`M0.5,0.5h...v...h...Z`) when a `frameStroke` style is present, matching Vega's anti-aliased cell boundary.
- **Half-pixel offset** — plot items are placed inside a `<g>` with `transform="translate(pad.left, pad.top)"`, matching Vega's plot frame translation.
- **Mark dispatch** — `renderGroup()` routes on `marktype` to specialized renderers:
  - **line** — builds a `d="M...L...L..."` path from contiguous defined points.
  - **area** — builds an area path with the upper hull (`y`) and lower hull (`y2`).
  - **symbol** — circle paths sized by `(sqrt(size) / 2)` radius, transformed to x/y.
  - **rect** — `<path>` using `h`/`v` commands to match Vega's rect-as-path convention.
  - **rule** — `<line>` elements.
  - **text** — `<text>` elements with x/y/align/baseline/fill/angle.
  - **path** — raw `d` attribute passthrough.
  - **arc** — arc segment path using `A` commands.
- **Number rounding** — all coordinates are rounded to 3 decimal places (`Math.round(x * 1000) / 1000`) for stable canonicalization in conformance diffs.

## Conformance

The conformance harness (`packages/conformance/src/run.ts`) is the SVG correctness gate.
`packages/conformance/src/scene-diff.ts` is the scene-level gate (R8.1–R8.3): it compares
resolved scales per scope, mark-group/item multisets, and paint order for overlapping
items directly against Vega's scenegraph, before either renderer serializes anything.

The SVG gate:

1. **Load corpus** — `corpus/*.vl.json` (Vega-Lite specs) and `corpus/*.vg.json` (raw Vega specs).
2. **Compile Vega-Lite** — for `.vl.json` entries, run `vega-lite.compile()` to produce Vega spec form.
3. **Dual render** — run both real Vega (headless, dev-only dependency) and `@aster/core`'s `renderSpec`.
4. **Canonicalize** — strip irrelevant attributes (`class`, `aria-*`, timestamps) and normalize element ordering.
5. **Diff** — compare geometry records (element type, position, size, color attributes).

M0 corpus conventions:

- Specs MUST set explicit numeric `width` and `height`.
- `autosize` must be `'none'` so layout is deterministic and comparable.

The canonicalizer (`packages/conformance/src/normalize.ts`) is the correctness gate: a spec passes only if the two SVGs have identical canonical geometry. Text labels, axis titles, and the chart title are all verified — headless text metrics are matched by reimplementing Vega's estimate width (`~~(0.8 · len · fontSize)`) and its `labelOverlap` parity/greedy removal.

### Gap probes (`packages/conformance/probes/`)

Areas that are **known-incomplete** are captured as feature probes under `probes/` and run via `pnpm probe`. A probe renders the same oracle diff as the corpus but is a *diagnostic, not a CI gate*: its failure documents a real gap, and when the gap is implemented the probe is promoted into `corpus/`. The former `contour`, `vl-facet-2d`, `vl-title-legend` and `data-url-csv` probes were implemented and promoted into `corpus/` — URL datasets now resolve via `loadSpecData` (the `@aster/core/load` addon) inside the conformance harness, matching how a real host fetches them. Facet/trellis positioning runs the exact vega algorithms (`src/bounds.ts` + `src/trellis.ts`), so new facet gaps should show up as corpus diffs, not layout guesses.

## Known Limitations / Roadmap

| Area | Status | Notes |
|------|--------|-------|
| Marks | Done | rect/line/area/symbol/rule/text/arc/path/image/trail/shape, incl. curves, gradients, corner radii, `lineBreak` tspans |
| Scales | Done | incl. scheme ranges (no zero-extension), `values`/`step`, projections via d3-geo |
| Axes | Done | ticks, grid, domain, labels, titles (4 orients), `labelOverlap` |
| Autosize | Done | `none`/`pad`/`fit`/`fit-x`/`fit-y` (viewSizeLayout parity: pad grows the viewport, fit shrinks content to a fixed viewport, iterating to a fixed point) |
| Legends | Done | gradient (vertical + horizontal), symbol (single + multi-column grids at any corner), size, band, bottom flow |
| Title | Done | top-level title + subtitle, anchored to content bounds (incl. rotated axis-title bounds) |
| Config | Done | background/view/style/axis/legend/title defaults |
| Expressions | Done | full vega-functions surface (date, color, array, string, scale) — CSP-safe |
| Nested scopes | Done | group marks with their own `scales`/`axes`/`data` render in an isolated child scope |
| Signals | Done | `update` resolved to a fixed point, plus event-driven `signal.on` streams via the signal→view event loop (`@aster/core/signals`) |
| Interactions | Done | brush/selection (`onSelect`/`brush`), drag overlays, and the spec-driven signal event loop in `<Chart>` |
| Data loaders | Done | `url` datasets with `csv`/`tsv`/`dsv`/`topojson` formats via `loadSpecData` (`@aster/core/load`); inline JSON + `format.parse` work in core |
| Reactive dataflow | Done | per-datum / length-changing pulses via `input.dataChanges` / `input.dataPulse` / session auto-diff (see "Incremental evaluation" above). One pulse engine serves same-length and length-changing updates; marks splice unchanged items, scales are reused when their domain is provably stable. The guarantee is exact equality with a fresh evaluation, enforced by `incremental-oracle.test.ts`. `bench:differential` documents the wins. |
| Incremental DOM | Done | `<Chart>` defaults to `patchSceneDom` (keeps the `<svg>`, patches changed attributes); the full string is serialized once for the first render so SSR + hydration match. Reused items are marked clean and their DOM descriptors are cached, so a differential update patches only the changed subtrees (O(changed) render) rather than re-descending the whole scene. |
| Canvas rendering | Open | SVG only |
| Contour | Done | implemented and promoted into `corpus/` |
| 2-D facet (VL) | Done | row×column facet grid verified against the oracle |
| Binning parity | Partial | `bin` covers common cases; not every Vega option |

## Verification Commands

```bash
# Typecheck (all packages pass)
pnpm typecheck

# Build
pnpm build

# Conformance — 406-spec geometry diff against the real Vega oracle (the gate)
pnpm conformance

# Gap probes — diagnostic only, documents known-incomplete features
pnpm probe

# Per-entry bundle gates (core/dom/canvas/hit/signals/React — see budget.mjs)
pnpm --filter @aster/benchmarks run budget
```
