# Roadmap: a from-scratch TypeScript/React Vega engine

Aster React is the browser/React member of the Aster family. Its intended
implementation is the same as [`aster`](https://github.com/mgilbir/aster) (Go) and
[`aster-kotlin`](https://github.com/mgilbir/aster-kotlin) (Kotlin): **reimplement the
Vega and Vega-Lite languages and their rendering from scratch**, so that the result
draws exactly what upstream draws, while being idiomatic and fast inside a React app
in the browser.

The real `vega` and `vega-lite` packages are the **oracle** — a dev-only reference the
tests compare against. They must not ship in the runtime, and neither may any of their
dependencies (`d3-*`, `topojson-client`, …).

This document records the verified starting point, the full inventory of borrowed code
that has to be replaced, the strategy for replacing it safely, and the plan.

**Scope of the rendering and experience goals.** The deliverables are **SVG and Canvas**
output and **interaction that is idiomatic in React**. Raster (PNG) and PDF export are
**out of scope** — the siblings provide them because they are server/native libraries,
but a browser React component composes into a page instead. This removes the largest
non-essential workstream (a rasteriser and a PDF writer) and lets the plan spend its
effort on the two things that matter: a dependency-free engine and a React-native
interaction model.

---

## 0. What the goal changes

The current codebase does the opposite of the goal in three ways:

1. **`@aster/core` runs on Vega's own pure packages** — `vega-expression`,
   `vega-interpreter`, `vega-format`, `vega-scale`, `vega-time`, `vega-util` — and on
   `d3-color`, `d3-contour`, `d3-dsv`, `d3-geo`, `d3-shape`, `topojson-client`
   (plus `d3-array`/`d3-format`/`d3-scale`/`d3-time`/`d3-time-format` declared but
   not imported directly).
2. **`ARCHITECTURE.md` documents this reuse as a deliberate design decision**
   ("The reason only pure packages are reused … is to avoid runtime leakage"). That
   decision is now reversed and must be superseded by an ADR.
3. **There is no Vega-Lite implementation at all.** `@aster/core` accepts only a Vega
   spec; the demo and the conformance harness call upstream `vega-lite.compile`
   *before* rendering. So the corpus's 413/413 result measures the *Vega* renderer on
   upstream-compiled Vega — it does not measure a Vega-Lite compiler, because there
   isn't one.

So "close the gap" now means two large programs: **own the runtime** (replace every
borrowed library) and **own the compiler** (write Vega-Lite from scratch). The
conformance harness keeps upstream as the oracle throughout.

### Consequences to plan for

- **The base bundle will grow.** Today's ~84 kB gzip leans on `vega-scale`,
  `vega-format` and friends being tree-shaken from a shared install. Owning scales,
  expressions, geo and shape costs bytes. Keep the addon boundary strict, gate each
  entry point, and re-baseline the core budget as the stack is replaced — the win
  over react-vega (288 kB) should survive, but the absolute number will rise.
- **`ARCHITECTURE.md` and the README describe the old design** and will be wrong the
  moment R1 starts. R0.1 supersedes them rather than leaving contradictory docs.
- **The conformance result is narrower than it looks.** 413/413 is the Vega renderer on
  *upstream-compiled* Vega; it says nothing yet about a Vega-Lite compiler.

---

## 1. Verified current state (2026-10-12)

Every gate was run from the working tree; all pass.

| Gate | Result |
|---|---|
| `pnpm build` / `pnpm typecheck` | pass (all 5 packages) |
| `pnpm test` | 139 tests / 21 files, all pass |
| `pnpm conformance` | 413 / 413 SVG geometry vs real Vega |
| `pnpm probe` | 2 / 2 |
| bundle budget (`@aster/core` `renderSpec`) | 84.3 kB gzip / 85 kB — pass |
| `<Chart>` bundle | 90.4 kB gzip vs react-vega 288.7 kB |

Size: **~17.7k main / ~2.7k test LOC**. For scale, the siblings' engines:

| Subsystem | Go | Kotlin |
|---|---:|---:|
| Vega-Lite compiler | 22,446 | 28,353 |
| Vega parser/runtime | 16,945 | 23,750 + 12,706 (model) |
| Scales | 6,271 | (in runtime) |
| Expressions | 6,589 | 6,305 |
| Transforms | 14,129 | (in runtime) |
| Geo | 6,569 | (in runtime) |
| Scene | 5,474 | 7,270 |
| Format/time/number | 4,927 | (in model) |
| SVG renderer | 1,430 | 803 |
| **Engine total** | **~85k+** | **~110k** |

Aster React already owns its top layer — spec compiler, eager runtime, scene, SVG
serializer, bounds, transforms, DOM patcher, signals. The from-scratch work is the
**library layer beneath it** and the **Vega-Lite compiler beside it**.

### Runtime dependency audit

**COMPLETE.** `@aster/core` has zero runtime dependencies on `vega-*`, `d3-*`, or
`topojson-*`. The ratchet (`scripts/check-deps.mjs`, per-package
`dep-baseline.json`) holds with an empty baseline and fails CI on any banned
import or dependency.

| Borrowed package | Replacement | Verified by |
|---|---|---|
| `vega-util` | `src/util.ts` | util vectors |
| `d3-color` | `src/color.ts` | colour projections |
| `vega-time` + `d3-time` | `src/time.ts` | interval/DST vectors (America/New_York) |
| `vega-format` + `d3-format` + `d3-time-format` | `src/format.ts`, `src/time-format.ts`, `src/locale.ts` | specifier + locale vectors |
| `vega-expression` + `vega-interpreter` | `src/expr-parser.ts`, `src/expr-interpreter.ts` | AST + eval vectors |
| `d3-dsv` + `topojson-client` | `src/dsv.ts`, `src/topojson.ts` | DSV + topology vectors |
| `d3-shape` | `src/shape.ts` | 256 curve/line/area vectors |
| `vega-scale` (d3-scale, d3-array, d3-interpolate, internmap) | `src/arr.ts`, `src/interp.ts`, `src/scale-d3.ts`, `src/scale.ts` | 173 scale/scheme/tick vectors |
| `d3-geo` | `src/geo-lib.ts`, `src/geo-projections.ts` | 18 projection/vector op-program cases |
| `d3-contour` | `src/contour.ts` | 30 marching-squares cases |

**5,043 oracle-vector cases** recorded from pinned upstream packages replay on
every `pnpm test` run. Time-dependent suites carry the zone they were recorded
under (America/New_York for the DST cases). SVG conformance against real Vega
holds at 413/413, and the bundle sits at 82.5 kB gzip against the 96 kB budget —
smaller than the borrowed tree it replaced.

---|---|---|---|
| `vega-util` | `data-format.ts`, `expression.ts` | **replaced** — `src/util.ts` (PR 1) | coercion, predicates, access paths, `extent`/`ascending`, `pluck` |
| `d3-color` | `expression.ts` | **replaced** — `src/color.ts` (PR 2) | CSS parse, RGB/HSL/Lab/HCL |
| `vega-time` + `d3-time` | `expression.ts` | **replaced** — `src/time.ts` (PR 3) | interval engine, units, floors, offsets, sequences |
| `vega-format` + `d3-format` + `d3-time-format` | `expression.ts`, `runtime.ts` | **replaced** — `src/format.ts`, `src/time-format.ts`, `src/locale.ts` (PR 4) | specifier grammar, strftime engine, locale facade |
| `vega-expression` + `vega-interpreter` | `expression.ts` | **replaced** — `src/expr-parser.ts`, `src/expr-interpreter.ts` (PR 5) | the DSL parser and CSP-safe evaluator |
| `d3-dsv` + `topojson-client` | `addon-load.ts` | **replaced** — `src/dsv.ts`, `src/topojson.ts` (PR 6) | DSV state machine, TopoJSON feature/mesh |
| `d3-shape` | `render.ts` | **replaced** — `src/shape.ts` (PR 7) | Path serializer, line/area, 19 curve families |
| `vega-scale` | `scales.ts`, `runtime.ts` | **remaining** | 16 scale types, tick generation, 68 schemes |
| `d3-geo` | `geo.ts` | **remaining** (addon) | projections, geoPath, measures |
| `d3-contour` | `addon-geo.ts` | **remaining** (addon) | marching squares |
| `d3-array`, `d3-scale`, `d3-time`, `d3-time-format`, `d3-format` | declared, unused directly | **remaining** (manifest cleanup with their phases) | d3-array's `tickStep` already lives in `src/format.ts` |
| `vega`, `vega-lite` | conformance/benchmarks/demo only | **keep** (the pinned oracle) | — |

Oracle-vector totals: **4,822 cases** across nine recorded libraries, replayed on
every `pnpm test` run; time-dependent suites carry the zone they were recorded
under (America/New_York for the DST cases) and both sides pin `process.env.TZ`
per suite.

---|---|---|---|
| `vega-expression` | `expression.ts` | expression lexer/parser → AST | own parser |
| `vega-interpreter` | `expression.ts` | CSP-safe AST evaluator | own interpreter |
| `vega-format` | `expression.ts`, `runtime.ts`, `data-format.ts` | locale, `format`/`timeFormat`/`tickFormat` | own d3-format/d3-time-format-compatible layer |
| `vega-time` | `expression.ts` | time units, floors, offsets, sequences | own time unit engine |
| `vega-scale` | `scales.ts`, `expression.ts` | 16 scale types, ticks, 68 schemes, `bandSpace` | own scale + tick + scheme engine |
| `vega-util` | `data-format.ts`, `expression.ts` | type coercion, array helpers | own util |
| `d3-color` | `expression.ts` | CSS colour parse, rgb/hsl/lab/hcl | own colour module |
| `d3-contour` | `addon-geo.ts` | marching squares | own contour |
| `d3-dsv` | `addon-load.ts` | csv/tsv/dsv parsing | own DSV reader |
| `d3-geo` | `geo.ts` | 16 projections, `geoPath`, geo measures | own geo module |
| `d3-shape` | `render.ts` | curves, line/area/arc, symbols, path | own shape module |
| `topojson-client` | `addon-load.ts` | TopoJSON feature/mesh decode | own TopoJSON reader |
| `vega`, `vega-lite` | conformance/benchmarks/demo only | the oracle / VL compile | **keep dev-only** |

---

## 2. Strategy: vector-first, swap-in-place

The siblings made this tractable the same way: they **recorded upstream's answers**
before rewriting each library and then replayed them. Go replays 21,523 calls from 25
packages; Kotlin keeps `test-fixtures/upstream-vectors`.

The method, applied per library:

1. **Record.** A `gen_*.mjs` uses the real dependency to emit input→output vectors
   (committed, gzipped). Covers the whole surface, including edge cases.
2. **Implement.** Build the replacement behind the *same internal API* the current
   callers use, so the pipeline does not move.
3. **Replay.** A test asserts exact equality against the vectors. This is independent
   of the browser and of the SVG oracle, and it localises a failure to one library.
4. **Swap and delete.** Flip the import, remove the dependency from `package.json`.
5. **Ban it.** A CI check fails if `packages/core/src` imports `vega-*`, `d3-*` or
   `topojson-*` (allow-list: tests, conformance, benchmarks, demo).

This keeps the oracle honest (real Vega still renders the corpus) while making each
library replacement a bounded, testable unit rather than a leap.

---

## 3. Inventory of own-code to build

| # | Subsystem | Borrows today | Target surface | Notes |
|---|---|---|---|---|
| R1 | util / array / stats | `vega-util`, `d3-array` | coercion, `extent`, bisect, quantile, group/rollup, variance, `ticks`, `nice`, `range`, `bandSpace`, `lerp` | small, unblocks everything |
| R1 | number/date format + locales | `vega-format` | `format`, `formatSpecifier`, `timeFormat`, `timeParse`, `locale`, `tickFormat`, all d3 locales | locale data is bulky; ship as an addon entry |
| R1 | time units | `vega-time` | floors, offsets, sequences, intervals, `timeUnitSpecifier`, `dayofyear`, `week`, **`isoweek`** | 6.4.0 additions included |
| R1 | colour | `d3-color` | CSS parse (names/hex/rgb/hsl), rgb/hsl/lab/hcl, interpolate | needed by schemes and expressions |
| R2 | expression language | `vega-expression`, `vega-interpreter` | lexer, parser, AST, CSP-safe interpreter, full function table (~119 functions) | AST node shapes should mirror `vega-expression` so vector diffs are meaningful |
| R3 | scales + ticks + schemes | `vega-scale`, `d3-scale` | 16 scale types, `nice`, padding, `domainRaw`, unioned domains, tick generation, 68 schemes | tick parity is the subtle part; vectors pin it |
| R4 | shape | `d3-shape`, `d3-path` | line/area/arc/symbol, all 17 curve methods, path serialization, bounds | renderer already dispatches; only the path builder changes |
| R5 | geo + contour | `d3-geo`, `d3-contour` | 16 projections, `geoPath`, `geoArea`/`geoCentroid`/`geoBounds`/`geoDistance`, graticule, antimeridian clipping; marching squares | addon-gated; largest per-line surface |
| R6 | data formats | `d3-dsv`, `topojson-client` | DSV reader, TopoJSON feature/mesh | addon-gated |
| R7 | **Vega-Lite compiler** | `vega-lite` (dev only; not shipped) | whole grammar → Vega | the single largest workstream; see Phase R7 |
| R8 | conformance rigour | — | scene + scale differential, VL compile diff, schema sweeps, upstream vectors | runs in parallel; makes every phase provable |

---

## 4. Plan

Relative sizes: `S` ≈ a day, `M` ≈ a few days, `L` ≈ a week+, `XL` ≈ a multi-week
workstream for one focused engineer.

### R0 — Foundation and guardrails (S)

- **R0.1** ADR `docs/adr/0001-own-the-engine.md`: reverses the "reuse pure packages"
  decision, states the oracle-only rule, and points at the vector method. Update
  `ARCHITECTURE.md`'s expression/scales/transforms sections to describe the target,
  not the current borrow.
- **R0.2** Dependency-boundary CI check (script or `dependency-cruiser`): fail if
  `packages/core/src` imports a banned package. Start with an allow-list of the
  current imports so it passes today; shrink it as each phase lands. This is what
  stops the gap from reopening.
- **R0.3** `packages/core/testdata/vectors/` + a `gen-vectors` script and a replay
  test per library. Land the harness with one trivial library (`vega-util`) to prove
  the loop.
- **Acceptance:** CI fails on a new banned import; at least one vector suite replays
  green.

### R1 — Foundation libraries (M, parallel after R0)

- **R1.1** util + array/stats vectors and implementation.
- **R1.2** colour vectors and implementation.
- **R1.3** time-unit vectors and implementation (incl. 6.4.0 `isoweek`).
- **R1.4** number/date format + locale vectors and implementation; locale data behind
  an addon entry so the base bundle stays lean.
- **Acceptance:** each library replays its upstream vectors exactly; no `vega-*`/`d3-*`
  import remains in the files it replaced.

### R2 — Expression language (L)

- **R2.1** Lexer + Pratt parser for the Vega expression DSL; record parse vectors from
  `vega-expression` (including error cases) and replay.
- **R2.2** CSP-safe AST interpreter over an explicit function table; record eval
  vectors from `vega-interpreter` and replay.
- **R2.3** Complete the function table to the full `vega-functions` surface, including
  the 6.4.0 additions (`ease*`, `interpolateLinear`, `geoTranslate`), regexp
  semantics (`g`/`y`/`u`, `lastIndex`), and `hypot`.
- **R2.4** Retire the hand-built table in `expression.ts`; the corpus plus vectors
  become the drift guard.
- **Acceptance:** DROP `vega-expression` and `vega-interpreter`; corpus stays 413/413;
  a generated test asserts the function table matches upstream's.

### R3 — Scales, ticks and schemes (XL)

- **R3.1** Record `vega-scale`/d3 vectors: domain/range/bandwidth per scale type, tick
  positions and formats across magnitudes and time zones, `nice`, padding, `bandSpace`.
- **R3.2** Implement scale constructors and tick generation; 68 colour schemes and
  interpolators (built on R1.2).
- **R3.3** `domainRaw`, unioned-domain signal refs, ordinal `range.count`, `reverse`,
  `clamp`, `values`/`step`.
- **Acceptance:** DROP `vega-scale` and `d3-scale`; tick vectors exact; corpus green.

### R4 — Shapes (L)

- **R4.1** Record curve/symbol/arc vectors from `d3-shape` (all 17 interpolation
  methods, 12 symbols, arc with pad/corner radius).
- **R4.2** Implement the path builder and serialization; wire `render.ts` and
  `bounds.ts` to it.
- **Acceptance:** DROP `d3-shape`; curve vectors exact; corpus green.

### R5 — Geo and contour (L, addon)

- **R5.1** Record projection/geoPath/measure vectors from `d3-geo`.
- **R5.2** Implement projections, `geoPath`, measures, graticule, antimeridian
  clipping; marching squares for `d3-contour`.
- **Acceptance:** DROP `d3-geo` and `d3-contour`; geo/contour corpus entries green.

### R6 — Data formats (M, addon)

- **R6.1** DSV reader with `d3-dsv`-identical quoting/typing vectors.
- **R6.2** TopoJSON feature/mesh decode with vectors.
- **Acceptance:** DROP `d3-dsv` and `topojson-client`; `data-url-csv` and geo corpus
  entries green.

### R7 — Vega-Lite compiler (XL — its own program)

**Status: complete.** `@aster/vl` (zero-dependency workspace package) compiles
Vega-Lite -> Vega, verified by rendering parity against the pinned
`vega-lite` oracle through `pnpm conformance-vl` (per-spec multiset diffs of
canonicalized SVG records). **125/125 corpus entries pass** with exact rendered output. Covered: unit specs for bar/point/circle/square/line/area/tick/text,
positional/color/size/opacity/shape channels across all four data types,
linear/band/point scale defaults, stack pipelines (single- and multi-series,
impute vs filter variants), aggregate/count, binning with the bins-signal
domain and offset-encoded bars, timeUnit pipelines with timeUnitSpecifier
formats and tickMinStep semantics, grid/label axis split with VL's tickCount
signals, legends, and mark-def properties. Also covered: stack center/normalize offsets, xOffset/yOffset grouped
bars, tick marks, aggregated domain sorts, log scales with greedy overlap,
explicit color ranges, conditional encodings, vega-transform passthrough
(calculate/filter/flatten/fold/window/quantile/kde/regression/loess), the
KDE shared-grid sampling semantics, line/area marks split by
color/detail/size channels via faceted pathgroups, arc/theta pie-donut
marks with polar text labels, layer composition with unioned scale
domains (incl. dual-axis independent y resolution), facet and concat
layouts, heatmaps, the boxplot composite, axis labelAngle, size-driven
line widths, static params, and per-field legend suppression, and log-axis label filtering (vega's
log axes carry no explicit tickCount — the axis default of 10 drives the
3/30/300 label filter). Interval selections render their static brush marks (clipped zero-size
shading; the engine skips unpainted rect items, as vega does). Unsized
units adopt vega-lite's default sizing (continuous dims 300; discrete dims
span band steps with `bandspace(domain length) * step` view-size signals).
Legends follow vega-lite's fixed channel order (color, size, shape,
opacity); the size-legend entry geometry mirrors vega's bound machinery
(datum size = max(ceil(sqrt(scale(v)) + strokeWidth), fontSize), miter
stroke inflation, per-entry bounds with rowPadding 2). Repeat specs
compile as vega-lite 6 itself does (degenerate single units).


The whole grammar, verified property-by-property against `vega-lite.compile` (the same
way Go and Kotlin do), then by rendering both compiled specs.

- **R7.1** Spec normalization, `$schema`/shape detection, top-level `width`/`height`/
  `padding`/`autosize`, `config` cascade and defaults.
- **R7.2** Single-view compilation: encoding channels (position, polar, offset, colour,
  size, shape, text, tooltip, href, detail, order), `aggregate`/`bin`/`timeUnit`/
  `stack`/`impute`/`sort`, scale/axis/legend/title defaults.
- **R7.3** Marks and composites: `bar`, `point`, `line`, `area`, `arc`, `rect`, `rule`,
  `tick`, `trail`, `text`, `boxplot`, `errorbar`, `errorband`.
- **R7.4** Transforms: every Vega-Lite transform → Vega transforms.
- **R7.5** Composition: `layer`, `facet` (incl. 2-D), `concat`/`hconcat`/`vconcat`,
  `repeat`.
- **R7.6** `params`/selections and conditional encodings.
- **R7.7** Property-by-property differential over a large VL fixture set (Go has 627
  Vega-Lite examples; Kotlin 332 fixtures), then a rendered-scene comparison.
- **Acceptance:** `@aster/core` exports a VL entry point; a `.vl.json` renders without
  importing `vega-lite`; the compiled-Vega diff is exact across the VL corpus.

### R8 — Conformance rigour (M–L, parallel from R0)

- **R8.1** Scene-level differential: compare resolved **scales** (domain, range,
  bandwidth, ticks) and marks, not just canonical SVG. Reuse `evaluateChart`.
- **R8.2** Nested (group-scoped) scale comparison, keyed by scope path + facet key.
- **R8.3** Paint order, dash arrays, symbol/path drawn extents, and line/area series
  collapse to an outline point list.
- **R8.4 — IN PROGRESS.** Schema sweeps ported from the Go aster project:
  `pnpm sweep-vega` generates one chart per (property, value) pair vega's own
  schema declares (7,549 cases — matching the Go floor) and diffs each against
  upstream vega. **6,019/7,549 pass (80%)**: all encode/config mark families,
  arcs (a full d3-arc port: padAngle, cornerRadius, radius swaps, degenerate
  radii), trails, scales, titles. Remaining clusters: projections (the d3-geo
  clip/rotate subsystem, ~950), legend orients (the legendGroupLayout port,
  ~240 — the first cut regressed the corpus and was reverted), axis tick/label
  properties (~200), trellis layout (33), config-range (11).
- **R8.5** Promote every remaining limitation into a failing probe.
- **Acceptance:** sweeps and scene differential run in CI; corpus scale diffs are zero.

### R9 — Rendering targets: SVG and Canvas (L, must) — R9.1/R9.2 DONE

Both backends render the same scene, so the engine stays single-sourced; only the
final walk differs. **Done:** `@aster/core/canvas` renderer replays the shared
geometry (path-data parser) with an 8-test record-differential over all 288 vega
corpus scenes (zero diffs), and `<Chart renderer="canvas">` with dpr backing
stores, full-scene repaints, and SSR safety.

- **R9.1** Canvas renderer over the scene, parity-tested against the SVG path
  (same geometry, paint, clipping, text, gradients).
- **R9.2** `<Chart renderer="svg" | "canvas">`, SSR-safe SVG default; the canvas path
  handles devicePixelRatio, resize, and redraws without leaking listeners.
- **R9.3** OffscreenCanvas/`requestAnimationFrame` scheduling so large charts never
  block a render commit.
- **Out of scope:** PNG/PDF export. A host can rasterise the SVG or canvas itself if
  it needs a file.
- **Acceptance:** canvas passes the same scene differential as SVG; a canvas chart
  survives resize and strict-mode remount; base bundle unchanged when canvas is not
  imported.

### R10 — React-native interaction and accessibility (XL, must)

Interaction is a first-class deliverable, not a wrapper around an imperative view.
Everything below is expressed in React terms: controlled/uncontrolled props, hooks,
callbacks, and `useSyncExternalStore` where a session holds external state.

- **R10.1 — DONE.** Scene hit index (`@aster/core/hit`, uniform grid above a
  threshold, vega-matching pick semantics, paint-order resolution) so hover,
  click, touch and tooltips resolve a mark without walking the DOM. Wired into
  `<Chart renderer="canvas">` tooltips.
- **R10.2** Declarative selection: controlled/uncontrolled interval brush, point/click
  selection, and a `select` value type, with `onSelect` like the existing brush.
- **R10.3** Pan and zoom: wheel, drag, pinch and keyboard, exposed as props and as a
  controlled `view` object; driven through `domainRaw`/scale signals so the scene and
  every guide recompute. Works on both SVG and Canvas.
- **R10.4** Signals as React state: `signal.on` streams bridged to `onSignal`, and the
  existing event loop wrapped so a signal update is a normal state transition (no
  tearing, safe under concurrent rendering).
- **R10.5** Tooltips as React content: a render prop / children slot positioned in the
  React tree, not a detached DOM overlay.
- **R10.6** Accessibility tree: one positioned, focusable element per mark/axis/legend/
  title, with upstream's captions and roles, `aria`/`description` channels, selected
  state, a dense-chart summary threshold, and an adjustable continuous axis.
- **R10.7** Keyboard navigation and focus management across marks and guides.
- **Acceptance:** pan/zoom/select/tooltip are covered by React interaction tests on
  both backends; an axe (or equivalent) check passes; captions match upstream wording.

### R11 — React idioms and performance (M, continuous)

- **R11.1** Public API: `<Chart spec>` accepting Vega **or** Vega-Lite with no
  pre-compile step; headless `useChart`/`createChartSession` hooks; an imperative
  handle via `ref` for hosts that need one.
- **R11.2** Async data via Suspense/`use()` and an explicit `loadSpecData` path.
- **R11.3** SSR string render + hydration via the DOM patcher; no layout flash.
- **R11.4** Optional worker offload for compile/evaluate on large specs.
- **R11.5** Keep the differential engine; add per-entry bundle gates.
- **Acceptance:** a chart renders from a VL spec in a fresh React app with no
  `vega-lite` import; SSR + hydration tests pass; budgets green.

### R12 — Production (M–L)

- **R12.1** Limits for untrusted specs: deadline, row/item/string/path/SVG-size
  budgets charged before allocation, bounded recursion, typed errors.
- **R12.2** Publish `@aster/core`, `@aster/react`, addons to npm with a release
  workflow and provenance.
- **R12.3** Docs: api, errors, limits, testing, fonts, performance, interaction; ADRs
  per major decision.
- **R12.4** Differential fuzzing and nightly sweeps with a committed reproducer
  corpus.
- **R12.5** LICENSE (BSD-3-Clause), CONTRIBUTING, CHANGELOG, THIRD_PARTY_NOTICES.
- **Acceptance:** a clean app installs from npm and renders Vega and Vega-Lite; a
  hostile spec fails with a typed error; nightly jobs green.

---

## 5. Sequencing

```
R0 ─┬─► R1 ─┬─► R2 ─┐
    │       ├─► R3 ─┼─► R7 ─┐
    │       ├─► R4 ─┘       ├─► R9 ─┬─► R10 ─► R12
    │       ├─► R5 (addon)  │       └─► R11
    │       └─► R6 (addon)  │
    └─► R8 ─────────────────┘
```

- **R0 before everything:** the boundary check and the vector harness are what make the
  rest safe.
- **R1 first, then R2/R3/R4 in parallel:** these unblock the pipeline and the VL
  compiler; R5/R6 are addon-gated and can trail.
- **R7 (Vega-Lite) can start once R1–R4 are stable**, because its output is Vega and it
  depends on the same foundation.
- **R8 runs continuously:** every phase's acceptance is measured by it.
- **R9 (canvas) precedes R10 (interaction)** because pan/zoom/hit testing must work on
  both backends; **R10 and R11 are independent**, and **R12** follows once the runtime,
  compiler and interaction model are ours.
- **Interaction can be prototyped early** against the SVG backend (the existing brush
  and tooltip are a start), but it is not "done" until it works identically on canvas.

## 6. Definition of done

1. `@aster/core` has **zero** runtime dependencies on `vega-*`, `d3-*` or
   `topojson-*`; a CI check enforces it.
2. It renders Vega **and** Vega-Lite directly, matching upstream's compiled Vega
   property-for-property and upstream's rendered scene mark-for-mark and
   scale-for-scale.
3. Schema sweeps and recorded upstream vectors cover the language, not just a fixture
   list.
4. Both **SVG and Canvas** render the same scene and pass the same differential; there
   is no PDF/PNG workstream.
5. `<Chart>` is idiomatic React: accepts either grammar, supports SSR/hydration and
   async data, and offers declarative select/pan/zoom/tooltip plus a positioned
   accessibility tree that works on both backends.
6. Untrusted specs are bounded in time and memory and fail with typed errors.
7. Packages publish to npm with docs, changelog and licence.

## 7. Keeping this document honest

Every number in §1 is reproduced by a gate. As phases land, move replaced packages
from §1's audit table to a "done" list and shrink the R0.2 allow-list; the two must
agree, and CI should fail when they do not.
