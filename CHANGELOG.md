# Changelog

## Unreleased

- **Group marks are vega scopes (audit C51, C55, C58, corpus-vega-only drained)**: every group mark
  is built and laid out like vega (one group item per facet partition / datum, own scales and data,
  `layout` grid, then axes, legends and the title), replacing the per-shape concat / facet / header
  builders. Concat, repeat and wrapped / layered / nested facets, facet header placement
  (`labelAnchor`, `labelOrient`, `orient`, `labels: false`, title anchors), nested legends
  (compiled with the view's config, as are nested group axes) and composition-level legends now
  match real vega; `corpus-vega-only` is empty. Gradient legends of time scales label and place
  their Date ticks (corpus-tz covers New_York and Kolkata). Axis `encode` (labels, ticks, grid,
  domain, title, axis) and legend `encode` (labels, title, symbols, legend) apply as in vega, and the
  runtime no longer reads the non-vega `labelExpr` / legend `disable`. Symbol legends are one vega
  symbol encode for every channel (size, opacity, strokeWidth, strokeDash, ...); a mark `sort` orders
  encoded items (stacked-area / imputed-line series order); `href` is drawn as `<a xlink:href>`
  under the URL policy; `containerSize()` reads `RuntimeInput.containerSize`; `signal.init` is an
  expression, not a literal.
- **@aster/vl round 2**: `config.scale` keys, `mark.invalid`, `bandSize`/`binSpacing`/secondary
  offsets, errorbar / errorband, the image mark, `"container"` sizing, `numberFormat` /
  `timeFormat` / `fieldTitle` config, vega-lite's axis order, zindex and color-legend rules, and the
  default invalid-value filter for null data.
- **@aster/vl is production-usable**: every Vega-Lite feature either compiles to
  Vega that renders like vega-lite 6.4.3 or throws a `VLCompileError` naming the
  unsupported feature (audit C34-C37, C71-C74, C97). New validation layer, one
  field-name escaping helper, VL transform translation, nested composition,
  layer parent transforms/config, sort/condition/timeUnit/bin forms, shared
  scales and legends, collision-free generated names, and `compile` never
  mutates its input. `conformance-vl` now renders our output through real vega
  and fails on vega errors or warnings. The opt-in `@aster/react/vl` bundle row
  grew to ~189 kB gzip (proposed budget 190 kB, pending approval). Core: domain `sort: {op}` uses Vega's
  aggregate ops and ordinal `{scheme}` ranges resolve to colours.
- **Loader URL policy (breaking default)**: `loadSpecData(spec, options)` now vets every URL
  (protocols `http:`/`https:` only, no credentials, loopback/private/link-local hosts denied,
  relative urls need `baseURL`, an `allow(url)` hook re-run on every redirect hop) and bounds
  each request (`timeoutMs`, `maxBytes` enforced while streaming, `maxConcurrent`,
  `maxRedirects`, `signal`). `data:` urls need `protocols: ['data:']`. Group-level `url`
  datasets are now resolved; an unloaded `url` dataset is an error instead of an empty chart.
  `TRUSTED_LOAD_OPTIONS` opts out for specs you wrote. Image-mark urls share the policy
  (`RuntimeInput.urlPolicy`, defaults applied under `limits`).
- **Limits are meters, not checkpoints**: one wall clock and generated-row/byte meters are
  threaded through transforms, row emitters, the encode loop, guides, expression builtins and the
  parser; single-call allocators (`sequence`, `pad`, format width, ticks, facet columns, contour
  grids, topojson arcs) are bounded before they allocate; `maxRows` covers nested group data,
  host `input.data` and transform output; paths and text arrays count toward `maxPathLength` /
  `maxStringLength`; deep and cyclic specs and expressions throw `AsterLimitError`. New
  `maxGeneratedRows` / `maxGeneratedBytes`. See `docs/LIMITS.md` (including why untrusted
  specs still need a killable worker for regular expressions).
- **Fixes**: `bin` with `maxbins <= 0` and `stratify` cycles no longer hang (vega's results and
  errors); `Math.min/max(...rows)` no longer overflows the stack at ~120k rows; `format.parse`
  accepts `date:`/`utc:` patterns; expression `format`/`timeFormat` follow the current default
  locale; formatter caches are bounded.
- **DOM, canvas and hit-testing fixes** (audit C3, C22, C23, C41, C43, C47, C96): the
  DOM patcher no longer leaves removed items drawn and drops others after a removal or
  reorder; the string renderer and the DOM descriptor take every attribute from one
  per-element list in `render.ts` (a first patch no longer rewrites gradient direction,
  dashes, caps, the rounded frame, trail fill, ...); canvas append painting is exact
  (in-place edits in other groups, changed guides, z-order against later groups and the
  miter limit are handled by declining to a full repaint) and no longer serialises item
  arrays per frame; trails paint their fill on canvas; the canvas honours symbol `angle`
  and path `scaleX/scaleY`; the hit index picks against painted geometry (pies, maps,
  lines, rotated text) and cannot be made to run out of memory by one oversized item.

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
- **Vega-Lite is opt-in**: the from-scratch VL compiler now lives behind
  `import '@aster/react/vl'` instead of being imported by the base `<Chart>` entry
  (~23 kB gzip saved). Vega specs need no addon (as before); a VL spec without it
  throws an error naming the exact import, and `registerVegaLiteCompiler` /
  `hasVegaLiteCompiler` are exported for hosts that compile VL themselves. Worker
  hosts import the addon in the worker entry. `@aster/react` measures 136.0 kB gzip
  (Vega only) / 158.4 kB with the addon; the budget gate now covers both entries
  (160 kB each), replacing the single 159 kB budget that had 0.6 kB of headroom.
- **Evaluation skips overflow padding for fixed-size charts**: with
  `autosize: 'none'` the evaluator no longer measures every top-level group's
  recursive bounds (Vega's viewSizeLayout does not grow such a viewport). Line
  @1k browser update 4.1 → 3.1ms, 5k full evaluate 1.5 → 1.2ms, 50k differential
  full re-encode 59 → 54ms, 100k same-array replacement ~16 → ~10ms; differential
  speedups rise accordingly (fixed-scale symbol 12x → 54x, row-wise 18x → 42x).
  `autosize: pad/fit` charts keep the full pass; conformance output is unchanged.
- **Faster row diff**: `rowsEqual` uses `for...in` (no `Object.keys` allocations)
  for plain rows, ~1.5x faster auto-pulse inference on wholesale array replacement.
- **Publish artifacts are tested**: new `pnpm verify:publish` packs every public
  package, asserts the tarball carries `LICENSE` + `THIRD_PARTY_NOTICES.md`
  (copied by a `prepack` step) plus `dist`/types, then extracts the tarballs into
  a clean `node_modules` and imports every declared entry (`@aster/core` addons,
  `@aster/react`, `/vl`, `/ssr`, `/worker`) to render Vega and Vega-Lite specs.
  It runs in CI, nightly and the release workflow. This caught a real packaging
  bug: `@aster/react`'s barrel used extensionless relative imports, which
  bundlers accept but Node ESM rejects (SSR/worker consumers would fail to
  import the published package) — fixed.
- **Wholesale-array replacement benchmark**: `bench:incremental` now measures the
  `<Chart data={next}>` path (no explicit changes) end to end. The session
  infers the pulse from the row diff: at 100k points a same-length replacement is
  ~0.5 ms and an appended row ~1.3 ms vs ~32 ms for a full evaluation (63x).
- **Benchmark warm-up**: the jsdom and browser runners mount every embed once
  before measuring and discard a first full pass, removing the first-embed JIT
  penalty that made the identical `aster`/`asterDom` paths differ by ~1–2 ms.
- **Dense SVG marks by default**: `denseMarks` now defaults to `'auto'` — symbol
  marks with ≥512 items batch into chunked `<path>` elements unless the spec uses
  `signal.on` event streams (`true` forces, `false` disables). Client-only mounts
  batch directly (100k-point mount ~620 → ~280ms, 100k → 402 nodes); SSR emits the
  per-item markup so hydration matches, then switches to batched in place.
  `denseMarks={false}` keeps the per-item DOM.
- **Dense SVG marks (`denseMarks`)**: opt-in batched symbol rendering for large SVG
  scenes. Dense symbol marks emit chunked `<path>` elements (positions baked into
  `d`, ~256 items per chunk) instead of one transformed element per datum: 100k
  points go from 100k DOM nodes to ~400, and a 100k-point append-per-frame SVG
  stream from ~79ms to ~16.7ms (0% long frames). Chunks are cached per mark group
  and only the tail chunk is re-serialized per append; translucent marks stay
  per-item (compositing), rotated marks keep their element, and tooltips/point
  selection/a11y resolve through the scene. New `pnpm conformance:batch` rasterizes
  batched vs per-item DOMs and gates pixel parity. Symbol descriptor build is also
  cached per group for the normal path (~5.3 → ~3.8ms `patchSceneDom` at 100k).
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
