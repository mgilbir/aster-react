# Changelog

## Unreleased

- **Incremental appends/inserts/deletes**: `diffRows`/`dataPulse` now carry an old↔new
  index mapping plus added/removed ranges. The runtime propagates length-changing
  pulses through row-wise, filter, fold/flatten, grouped and 1:1 geo/hierarchy
  transforms, and scene items splice instead of rebuilding. `pnpm bench:incremental`
  gates that an append is cheaper than a full re-evaluate.
- **Streaming API**: `createChartStream` (bounded queue, `coalesce`/`drop-oldest`/
  `drop-newest`/`error` policies, explicit `pending()`/`flush()`/`pulse()` and stats).
  Added compact append-only pulses, O(appended) stream snapshots/mark splicing/bounds
  and continuous-domain updates, `useChartStream` for React, and
  `useChartWorkerStream` + `handleChartWorkerStreamRequest` for worker offload.
  `collect`/`sample`/`aggregate`/`joinaggregate` now have append fast paths.
- **Performance gate**: `pnpm bench:incremental` runs in CI (10k/30) and nightly
  (100k/40); measured ~29x and ~216x cheaper than a full evaluate at the median. The
  benchmark also runs a direct Vega baseline (`view.change(...).run()`, renderer
  `none`): aster's append is ~13x cheaper at 10k and ~62x at 100k on the same workload.
- **Streaming rendering**: `<ChartStream>`/`<ChartWorkerStream>` render streamed
  scenes through the existing DOM patcher/canvas backend/interaction/a11y tree instead
  of re-serializing SVG per flush. `useChartStream`/`useChartWorkerStream` gained
  pause/resume/close and worker accepted/rejected/depth backpressure counters; the
  worker protocol now reports queued depth and per-batch acceptance.
- **Streaming frame pacing**: `flushPolicy: 'microtask' | 'raf'` on the stream hooks;
  a real-browser `<ChartStream>` benchmark (`pnpm bench:browser-stream`) covering
  SVG/canvas, long frames, DOM mutations and node counts. Canvas path/symbol caches,
  solid-paint bbox skipping and batched same-paint symbol runs bring a 10k-point
  one-append-per-frame stream to ~16.7ms median frames with no long frames on SVG
  and canvas; 100k canvas frames dropped from ~52ms to ~16.7ms via incremental append painting (only new mark items are drawn; full repaints still fall back safely).
  The runner now includes a direct Vega `view.change` baseline on the identical spec
  and row stream (SVG/canvas, `run`/`runAsync`): at 100k points Vega needs ~170ms per
  SVG frame vs aster's ~77ms and reports ~2.3% long frames / ~240 DOM mutations per
  append at 10k (aster: 0% long, ~1 mutation); both are frame-bound on canvas.
- **No-op re-renders**: identical-content re-renders (fresh spec object, stable data)
  went from 2.0–2.4ms with 2 DOM mutations to ~0.3ms with none (Vega wrappers
  0.1–0.2ms). `<Chart>` no longer calls `getChartInfo()` (a second compile+evaluate)
  from an effect: interaction/a11y metadata derives from the evaluated scene via
  `chartInfoFromScene`. The markup string also leaves the props after the first
  commit — React re-applies a present `dangerouslySetInnerHTML`, so the cached
  string was making every "incremental" render re-parse the whole SVG. Mount skips
  the now-redundant patch, canvas skips identical scenes, and `patchSceneDom` gained
  an identity-prefix append path (O(appended) instead of re-walking siblings), which
  also cut 100k-point SVG stream frames to ~77ms.
- **Nested scopes / axes**: nested group marks now inherit outer scales (local names
  still shadow), so raw Vega specs that reference a parent `y` or colour scale render
  inside groups (population pyramid). Vega-Lite compilation now emits all grid axes
  before all label axes, matching Vega's paint order (the x-axis domain is no longer
  covered by the y-grid line). Band-sized encodes now apply `offset`/`mult` (e.g.
  `height: {scale:'y', band:1, offset:-1}`), restoring the 1px bar gaps.
- **Signal binds**: `<Chart>` renders `signal.bind` range/select/checkbox/radio/
  color/text controls and routes changes through the signal store; VL compilers
  preserve bind metadata. Range controls use Vega's label/slider/value layout.
- **Tooltip positioning**: the chart container now establishes a positioned ancestor
  whenever a tooltip or a11y tree is present, not only for selection/pan. Absolute
  tooltips no longer position against `<body>` and disappear above the viewport after
  scrolling. The demo also scales oversized SVGs to the pane width for side-by-side
  comparison.
- **Demo polish**: relative `url: "data/..."` paths now strip the `data/` prefix and
  resolve to the official Vega datasets host (with a fallback host), so copy/pasted
  Vega examples work; the playground recursively resolves nested data URLs. Removed
  the double chart container in the gallery aster column, updated stale hero stats,
  and fixed default text marks to emit Vega's 11px sans-serif instead of inheriting
  the browser's 16px default.
- **Canvas hardening**: pixel gate now runs Chromium/Firefox/WebKit with a tighter
  1px/4%/2.5 tolerance, plus custom-font and multi-line fixtures.
- **Environment coverage**: locale matrix (number/date formatting plus rendered axis
  labels), custom-font provider matrix (font-string propagation, narrow/wide layout,
  invalid-provider fallback and cache invalidation), malformed URL/data tests, rare
  addon transforms (`kde`/`regression`/`loess`/`pack`/`partition`/`treemap`/`voronoi`)
  in the transform matrix, and a headless-Chromium canvas pixel-parity gate
  (`pnpm conformance:canvas`).
- **Canvas fixes (found by the Chromium gate)**: relative `H`/`V` path commands now
  carry the current point across each other (rects previously painted from
  `y - height`), canvas text no longer passes a boolean as `maxWidth`, scene siblings
  are ordered axes → marks → legends → title like Vega, and custom `labelFont`/
  `titleFont` families reach axis/legend text metrics.

- **Pulse/dataflow**: sessions automatically diff replaced immutable source arrays
  (`autoChanges`, default on), expose source/transform pulses via `session.pulse()`,
  and reuse unchanged items without an explicit `dataChanges` props. Sorted
  window/stack groups now consume dirty-group pulses instead of falling back.
- **Accessibility**: axe WCAG A/AA audit for the chart tree, guide-caption parity
  (419/419) against Vega's `aria-label`, and keyboard-operable legend entries
  (`aria-pressed`) that filter shape/paint series.
- **Transforms**: transform option matrix (bin/window/stack/joinaggregate/impute/
  fold/flatten/pivot/lookup/sequence/identifier/timeunit/extent), fixing impute
  tuple fields, sequence append semantics and identifier assignment.
- **Text metrics**: pluggable `TextMetricsProvider` on core/`<Chart>` for custom
  fonts and non-browser renderers, with provider-scoped caching and safe fallback.

- **Conformance rigour**: added the scene-level differential (`pnpm scene-diff`,
  419/419) comparing resolved scale maps per scope, mark/item geometry/paint and
  overlap paint order against Vega's scenegraph (R8.1–R8.3). Both schema sweeps now
  have zero comparable differences: Vega 7,538/7,549 (8 both-refused, 3 oracle
  crashes) and Vega-Lite 27,418/27,513 (40 both-refused, 21 oracle refusals, 34
  pinned nondeterministic bootstrap aggregates). Closed identity scales, horizontal
  area baselines, fractional/negative view sizes, log/symlog NaN symbols, title
  anchors, rotated path bounds, clip-bound epsilons and scene paint order.

- **React interaction**: controlled/uncontrolled pan/zoom (`panZoom`, `view`,
  `onViewChange`, `maxZoom`) with wheel/drag/pinch/keyboard over scale `domainRaw`;
  unified `SelectValue` (`selection`/`onSelectionChange`) alongside the existing
  interval and point callbacks; `ChartHandle` imperative ref.
- **Signals**: `signal.on` now updates through `useSyncExternalStore` (one normal React
  state transition) and re-renders dependent marks; `setSignal` available on the ref.
- **Accessibility**: `buildA11yTree` + focusable `<Chart>` projection with captions,
  roles, selected state, dense-chart summary and adjustable continuous axes; keyboard
  navigation across marks/guides.
- **Vega-Lite input**: `<Chart>` and `useChart` compile Vega-Lite directly through
  `@aster/vl`; no `vega-lite` runtime dependency.
- **Async/SSR/worker**: `useSpecData`/`useChartData` (Suspense + `use()`),
  promise specs, `renderChartToStaticMarkup` + `hydrateChart`, and
  `useChartWorker` with a synchronous fallback.
- **Limits**: `maxTimeMs` wall-clock deadline checked across compile/evaluate/render
  and inside dataset/encode loops; `domainRaw` scale overrides in core.
- **Tooling**: per-entry bundle gates (core, dom, canvas, hit, signals, React);
  deterministic differential fuzzer with committed reproducers; nightly sweep
  workflow; tag-triggered release workflow with npm provenance.
- **Docs**: API, errors, limits, testing, fonts, performance, interaction and release
  guides; ADRs 0002–0004.

- Schema sweep: 27,418/27,513 cases match, **0 differ**; the remaining
  non-ok cases are 40 both-refused specs, 21 oracle refusals and 34 pinned
  nondeterministic `ci0`/`ci1` bootstrap cases.
- Closed sweep tails: guide-scale ranges/domains, facet header
  `labelOrient`/`orient`, config axis/header precedence, axis orient/grid
  geometry, label angle anchors, tick/label tails, `values` aggregate
  domains, size-legend grid layout, and `config.point` cross-block geometry.
- Vega transform parity: full `bin` step/anchor/base/divide/minstep/span/steps
  options and interval mode, full `window` ops/frames/ignorePeers/params,
  `joinaggregate.key`, and signal-valued `impute.keyvals`.
- React: `onPointSelect` click selection, `renderTooltip` React slot,
  `useChart` headless hook, canvas redraw scheduling on `requestAnimationFrame`.
- Core: typed `SpecLimits`/`AsterLimitError` budgets for untrusted specs.
- Added BSD-3-Clause license, contribution guide and third-party notices.
