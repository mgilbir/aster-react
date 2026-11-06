# Performance

Aster keeps a differential engine and adds opt-in boundaries so a chart pays only for the features it
imports. This document describes the mechanisms, then gives the measurements. Every number is in
[Reference measurements](#reference-measurements) or [Bundle sizes](#bundle-sizes) next to the command that
produced it; the mechanisms below carry no numbers on purpose (they change with the code, the machine and
the browser).

## What is fast

- **Session caching**: `createChartSession` fingerprints the spec skeleton, dataset identities, size,
  signals, `domainRaw` and the limits; identical inputs return the same scene. `<Chart>` derives its
  interaction/a11y metadata from that scene (`chartInfoFromScene`) instead of calling `getChartInfo`, which
  compiled and evaluated a second time on every render. The `dangerouslySetInnerHTML` prop is dropped
  after the first commit (React re-applies a present one, so a cached markup string made every no-op render
  re-parse the whole SVG). An identical-content re-render therefore costs no DOM mutation.
- **Fixed-size charts**: when `autosize` is `none` (explicit width/height, the usual dashboard case)
  evaluation skips Vega's overflow-padding pass, which measures the recursive bounds of every top-level
  group. That walk dominated a one-row update on a large chart. Charts with `autosize: pad/fit` keep the full
  pass (Vega's viewSizeLayout grows or fits the viewport), and the corpus, which includes both, renders
  byte-identically.
- **Kept dataset steps**: a resize, a signal write or a re-render with equal rows no longer runs every dataset pipeline from its
  first step. A step records the signals it reads, the rows it was made from and (for a drawing step) the random source; the next
  evaluation keeps the rows of every step whose reads are as they were, republishing the signals it wrote. The React mount, which
  evaluates the spec at its own size and then at the measured container's, pays for the datasets once. Consecutive steps that
  only add fields (`bin`, `formula`, `timeunit`) write onto one set of rows instead of copying every row per step
  ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Auto-pulse inference**: `rowsEqual` compares plain rows with `for...in` instead of two `Object.keys`
  allocations per row, so replacing the whole data array stays cheap even without explicit `dataChanges`.
- **Per-datum updates**: sessions diff replaced immutable source arrays automatically (`autoChanges`), then
  re-encode only changed rows and reuse unchanged scene items; explicit `dataChanges` remains available for
  custom batching. The source/transform pulse is exposed through `session.pulse()`.
- **Length-changing pulses**: appends/inserts/deletes carry an old to new row mapping and added/removed
  ranges. Row-wise, filter, fold/flatten, grouped (`aggregate`, `joinaggregate`, `window`, `stack`) and 1:1
  geo/hierarchy operators propagate it; marks splice item arrays instead of re-encoding. Steady-state appends
  are O(appended + changed) for the common source, row-wise, mark path: the stream mutates its owned
  snapshot, the mark group appends items and unions cached bounds, and continuous domains patch their min/max
  census without rescanning. Transforms without a fast path re-derive; the result is still exactly a fresh
  evaluation ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Streams**: `createChartStream` adds a bounded queue with coalesce/drop-oldest/drop-newest/error policies
  and explicit `flush()` pulses. `<ChartStream>`/`<ChartWorkerStream>` reuse the SVG patcher and the canvas
  backend; canvas path parsing and symbol generation are cached, solid paints skip bbox computation, dense
  same-paint symbol runs batch into one fill/stroke, and append-only streamed scenes paint just the new mark
  items.
- **Incremental scales**: continuous and discrete domains are reused when a changeset provably cannot move
  them; append-only continuous updates patch the min/max census in O(appended) instead of rescanning.
- **DOM patching**: the first render emits the full SVG for SSR; later updates patch attributes in place.
  The mount commit skips the patcher (the browser just parsed that markup) and an append reuses the previous
  patch's descriptors as an identity prefix, so only the new items are created. Symbol descriptors are cached
  per mark group.
- **Dense marks (`denseMarks`, default `'auto'`)**: symbol marks with at least 512 items render as chunked
  `<path>` elements (256 items per chunk, positions baked into `d`) instead of one transformed element per
  datum. Chunks are cached per group, so an append re-serializes one chunk. Only opaque marks batch
  (translucency must composite per item); rotated marks keep their own element; `'auto'` stays per-item when
  the spec has `signal.on` streams. SSR emits per-item markup for hydration and the client switches to batched
  in place. Tooltips and hit testing use the scene index; `pnpm conformance:batch` gates pixel parity against
  the per-item rendering. The node count matters because appending one node to a very large SVG, and above
  all one with a `transform` per item (how Vega writes symbols), is expensive in the browser whatever the
  framework does.
- **No-op renders**: identical content is free all the way through: the session returns the cached scene,
  chart info/a11y derive from it, and the SVG/canvas effects skip the DOM/canvas when the scene object is
  unchanged.
- **Canvas**: full repaint is scheduled on `requestAnimationFrame` with DPR backing.
- **Workers**: `useChartWorker` moves compile/evaluate/render off the main thread and falls back to the same
  synchronous handler when workers are unavailable.

## Reference measurements

Measured 2026-11-05 on main at 098b243 on the development machine (Linux x86_64, node v26.13.0, headless Chromium
from Playwright), after `pnpm build`. The machine is shared: other users kept the load average between 0.5 and 5
during the runs. The Node figures are the median of three runs unless a table shows each run; the browser figures
are the median of two runs (six for `pnpm bench:browser`). Timings are machine- and load-dependent: compare the
ratios and the shape, and re-run before quoting. To compare two builds, run them alternately on the same machine
(the numbers below drifted from earlier editions of this page with the machine, not only with the code). The incremental gate
(`pnpm bench:incremental`) is the only one of these with a pass/fail floor; the floors and how they were
chosen are at the top of `packages/benchmarks/src/incremental.bench.tsx`.

### Compute: incremental append vs full evaluation (node, no paint)

`pnpm bench:incremental -- --points=10000 --reps=30` (three runs, medians in ms), 800x500 symbol chart,
one row appended per update:

| Path | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| full `evaluateChart` | 2.9 | 3.0 | 2.7 |
| `createChartStream` append + flush | 0.2 | 0.2 | 0.2 |
| `view.change(changeset().insert(...)).run()` in vega (`renderer: 'none'`) | 1.2 | 1.2 | 1.1 |
| append speedup vs full | 18.3x | 15.8x | 18.2x |
| append vs vega | 7.1x | 5.8x | 6.6x |
| whole-array replacement speedup vs full | 15.9x | 12.7x | 17.1x |
| DOM patch (`patchSceneDom`, 4000 points, jsdom) vs `renderSceneToSvg` | 3.3x | 3.7x | 5.4x |
| dense 100,000-symbol mark: append patch vs mount (ms) | 1.31 vs 314.3 (249x) | 1.17 vs 275.6 (254x) | 1.12 vs 265.9 (254x) |

`pnpm bench:incremental -- --points=100000 --reps=40`: full evaluate 42.1 ms, stream append 0.3 ms
(163x), vega `view.change` 19.0 ms (13.6 to 34.7 ms across the runs: aster 54x to 107x cheaper), whole-array
replacement 37x; dense append patch 1.00 ms vs a 263.3 ms mount (273x). From 2026-10-27 to 2026-11-04 the stream
append had regressed to 0.7 ms at 100,000 points (every evaluation scanned the whole dataset for rows to wrap as
`{data: v}`); #103 restored it.

### Differential updates (node, no DOM)

`pnpm bench:differential` (50,000 points, about 1% of rows changed; `evaluateChart` with a changeset vs a full
re-encode): row-wise `formula` 22.6 to 1.0 ms (23.1x), fixed-scale symbol 19.2 to 0.5 ms (38.8x),
`aggregate` over 1000 groups 6.2 to 2.5 ms (2.5x). Scene evaluation plus `patchSceneDom` at 4000 points:
6.6x, 9.5x and 3.0x for the same three cases. (The row-wise ratio is lower than in earlier editions because the full
re-encode got cheaper: expressions read the signals in place since #101.)

### Embedding: `<Chart>` vs react-vega and the vega-embed tutorial

`pnpm bench:runtime` (jsdom, relative timings only; median update ms, 1000 points): line aster 3.5 /
asterDom 2.9 / react-vega 6.1 / vega-embed hook 3.7; scatter 4.6 / 4.2 / 33.1 / 70.7; bar 13.4 / 13.8 / 86.5 /
62.4. DOM nodes for the scatter chart: 82 vs 1073.

`pnpm bench:browser -- --points=1000` (headless Chromium, median ms, first render / update):
line aster 2.65 / 2.55, asterDom 1.75 / 1.90, react-vega 2.90 / 3.45, vega-embed hook 2.40 / 2.60; scatter aster
2.90 / 3.45, asterDom 2.75 / 3.30, react-vega 8.20 / 7.90, vega-embed hook 7.05 / 8.35; bar aster 10.10 / 8.00,
asterDom 9.25 / 7.30, react-vega 15.50 / 16.75, vega-embed hook 14.90 / 8.30. Stable-content re-render (fresh spec
object, same data): 0 DOM mutations on all four; 0.3 ms for aster vs 0.1 ms for the Vega wrappers. Under a
one-update-per-frame stream the line chart holds 16.7 ms median frames on all four; long frames (over 21 ms) are
0.0% for aster, 1.7% to 3.7% for the Vega embeds. Run alternately against the 2026-10-27 build (2a03147), aster's
first render and update timings here read 5% to 17% slower (about 5% normalised by the Vega embeds of the same run),
but the work does not differ: both builds emit byte-identical SVG for these charts, and CPU profiles of the same
mounts and updates in Chromium, taken alternately, show the current build busy no longer than the old one (2.4 to 3.7 s
against 2.7 to 4.0 s, tracking the machine's load). The timing difference is within this machine's noise.

`pnpm bench:memory` (jsdom heap growth per cycle, steady state, kB): line update aster 24.4 /
asterDom 28.6 / react-vega 42.2 / vega-embed hook 12.4; scatter update 27.1 / 26.9 / 46.0 / 36.2.

### Streaming appends in a real browser: `<ChartStream>` vs vega `view.change`

`pnpm bench:browser-stream` (one append per animation frame for 3 s, 800x500 symbol chart with an explicit
symbol fill, headless Chromium, median frame / share of frames over 21 ms / DOM mutations per append):

| Points | Backend | aster | vega `view.change` + `run` |
|---|---|---|---|
| 10,000 | SVG | 16.6 ms / 0.9% / 1.0 | 16.6 ms / 2.5% / 240.1 |
| 10,000 | canvas | 16.7 ms / 0.0% / 0 | 16.7 ms / 0.3% / 0 |
| 100,000 | SVG (per-item, `denseMarks` off) | 157.7 ms / 93.8% / 1.0 | 174.4 ms / 100.0% / 34,862.3 |
| 100,000 | canvas | 16.7 ms / 0.0% / 0 | 16.7 ms / 5.9% / 0 |

`pnpm bench:browser-stream -- --points=100000 --seconds=3 --engines=aster --renderers=svg --dense=0,1`
(aster SVG, microtask flush): per-item 161.2 ms median frame, 94.2% long, 100,030 DOM nodes, 18 to 19 appends in
3 s; with `denseMarks` 33.5 ms, 96.3% long, 402 DOM nodes, 82 to 84 appends. Dense marks cut the per-frame cost by
about 4.8x; neither SVG variant holds a 16.7 ms frame at 100,000 points, canvas does.

**Earlier figures for the 100,000-point SVG stream were wrong.** Previous versions of this document and of the
README, CHANGELOG and benchmarks README quoted about 77 ms per frame per-item and 16.7 ms with 0% long frames with
`denseMarks`. Those were measured on an unfilled render: the benchmark spec drew symbols without a `fill`, and before
the default-config fix Aster rendered such symbols unfilled (Vega draws them filled), so the benchmark measured an
empty paint layer. The benchmark spec now states its fill, and the numbers above are the filled render on this
machine. I measured them on the current stack; the reviewer reports that the pre-audit baseline gives the same numbers once the fill is explicit (I did not re-run that).

### What the guides cost (2026-10-26)

Axes, legends and titles are built by ports of vega-parser's guide encoders: every channel of every tick, grid line, label
and legend entry is Vega's own encode, so the items carry what Vega's carry, and the document says what Vega's says
(about 9% more bytes for a chart with a thousand ticks). The marks of a guide are planned once per compiled chart (the
defaults from `config.style`, which channels are plain values, which depend on the datum, a tick position as a closure
over its scale); each evaluation then runs only the channels that read the datum. Measured with the 1,000-point scatter and bar fixtures (600 x 400), each phase on a spec nothing has compiled, medians of 16
alternating runs on a quiet machine with `process.cpuUsage` (the first evaluation, the second evaluation of the same compiled chart,
`renderSceneToSvg`, compile), ratios branch / before: scatter compile 0.78, evaluate 1.18, render 1.05, second evaluate 1.07; bar compile
0.74, evaluate 1.04, render 1.12, second evaluate 1.02 (with 300 specs per run, once the code is warm: all within 1.05 except bar render
at 1.05 and scatter evaluate at 1.04). The bar render is the document being larger (313,561 bytes against 289,209: the 1,000 ticks and 1,000
grid lines carry the attributes Vega writes). `bench:incremental` (10,000 and 100,000 points) is within 0 to 5% on every row;
`bench:browser`, 1,000 bars, four alternating runs, medians: `<Chart>` mount +2%, update -6%, resize -7%; the DOM variant +4%, -3%, -2%.

Re-measured on the final tree (6 alternating runs, 80 fresh specs each, medians, load about 1), ratios against the code before
this work: scatter compile 0.79, first evaluate 1.13, render 1.03, second evaluate 1.06; bar compile 0.72, first evaluate 1.09,
render 1.05, second evaluate 0.92. A fresh compile + evaluate + render, 60 specs per kind in one process: line 0.80, bar 1.07.
The known gap is the cold path, and it depends on what ran before: a fresh scatter is +3% after bar charts but +20 to 30% right after
line charts (the code is still in the interpreter and baseline tiers for the first charts of a process). Warm, every phase is within 10%.
Closing the cold gap would need a second, hand-written guide path, which this work deliberately does not have (one plan feeds every
guide, so the output cannot drift between two paths).

What made this cheap: a chart's guide marks are shared by every chart whose guide has the same content, config object, scale and orient
(the merged default config is built once and frozen, so a spec without a config shares it), the entries of a guide are closures made once
per entry and bound to an evaluation's scales (the marks' own evaluator is never called by a guide: sharing it made the marks' evaluation
slower), ticks, grid lines and labels are made by one constructor per leaf kind, and nothing keeps a weak-map entry per chart.

## Bundle sizes

`pnpm bench:bundle` (esbuild, minified, react external; every chunk counts, including the ones loaded on demand), measured
2026-11-06: `@aster/react` `<Chart>` 264.0 kB gzip (711.5 kB minified, 222.9 kB brotli), `<SvgChart>` from `@aster/react/lite`
243.2 kB gzip (656.5 kB minified, 206.5 kB brotli), `<SvgChart>` + `interaction` 258.4 kB gzip (695.4 kB minified,
218.8 kB brotli), vs react-vega 288.7 kB gzip (832.2 kB minified, 239.9 kB brotli) and the official vega-embed tutorial 288.0 kB
(830.5 kB minified, 239.6 kB brotli). The Aster rows are Vega only. The react-vega and vega-embed bundles include
Vega-Lite (about 731 kB of their source inputs), so the like-for-like comparison for a Vega-Lite app is `<Chart>` plus the
Vega-Lite compiler: 308.3 kB gzip eager plus 59.1 kB gzip loaded on demand (the `budget` rows below), 367.4 kB in all, which
is above react-vega's 288.7 kB. The smaller figure holds for Vega specs only.

`pnpm --filter @aster/benchmarks run budget` bundles one tiny app per documented import pattern (esbuild, minify,
`NODE_ENV=production`, tree-shaking on, react external) and gates its gzip size (default level). The addon rows are
MARGINAL: the addon's gzip added to the `@aster/core` app. The old rows measured each addon standalone, which
double counted the code it shares with core (hit read 15.6 kB where an app pays about 5). Each budget is the measured
size plus 0.5 kB (`packages/benchmarks/scripts/budget.mjs` holds the rationale and the budgets, which are not copied
here); a change that needs more room edits the number in the same PR. These rows count the code a page loads eagerly: a
chunk loaded on demand is reported next to the row and is not in the gzip column. Measured 2026-11-06 with
`pnpm --filter @aster/benchmarks run budget` (all rows PASS):

| Import pattern | gzip kB (eager) | Loaded on demand (gzip kB) |
|---|---|---|
| `import { renderSpec } from '@aster/core'` | 152.5 | |
| `import { useChart } from '@aster/react'` | 163.7 | 61.1 |
| `import { Chart } from '@aster/react'` | 205.3 | 59.1 |
| `import { SvgChart } from '@aster/react/lite'` | 182.5 | 61.1 |
| `<SvgChart>` + `import { interaction } from '@aster/react/interaction'` | 199.7 | 59.1 |
| `import '@aster/react/vl'` + `<Chart>` | 308.3 | 59.1 |
| core + `@aster/core/dom` (marginal) | 10.6 | |
| core + `@aster/core/canvas` (marginal) | 6.1 | |
| core + `@aster/core/hit` (marginal) | 6.4 | |
| core + `@aster/core/signals` (marginal) | 12.9 | |
| core + `@aster/core/load` (marginal) | 5.4 | |
| core + `@aster/core/geo` (marginal) | 16.0 | |
| core + `@aster/core/transforms` (marginal) | 39.2 | |

The manifests list only the files that really have an import effect (see
[ARCHITECTURE.md](ARCHITECTURE.md#side-effects-and-tree-shaking)). Without a `sideEffects` field a bundler must assume
every module has effects, so `import { useChart }` pulled in `Chart`, `ChartStream`, `useChartStream`,
`useChartWorkerStream`, the worker host and `batches` (37.7 kB gzip it never calls); `ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1
node packages/benchmarks/scripts/budget.mjs`, run from `packages/benchmarks`, bundles the apps that way.
`<Chart>` is a shell over `ChartCore` with injected capabilities; that costs a little code in both shells: the property
reads through the capability objects (a minifier cannot rename them) and the report of a missing capability, which only
`<SvgChart>` can trigger but both share. `<SvgChart>` is 22.8 kB smaller than `<Chart>` (205.3 minus 182.5): the canvas
renderer, the hit index and the signal loop (6.1 + 6.4 + 12.9 kB as marginal rows). The rows that contain no such
code are checked on the module list, not only the byte count: `pnpm check:bundle` asserts on the esbuild metafile that the
`<SvgChart>` bundle reads no `core/canvas`, `core/hit` or `core/signals` module, and that with `interaction` it reads hit and
signals but still no canvas (`hit.ts` and `canvas.ts` share the path parser through `path-data.ts` for exactly this reason).

The `useChart` and `<Chart>` rows fail if the field is removed or widened; `scripts/bundle-shaking.test.mjs` plants
that fault and requires the budget to fail. The other direction (a list that is too narrow drops a registration) is
caught by `pnpm check:bundle`, which bundles and executes each import pattern.

The Vega-Lite compiler is 103.0 kB gzip on top of the base `<Chart>` (308.3 minus 205.3, measured 2026-11-06). It was 54.1 at an earlier measurement, before the selections, maps and animation work: the selection compiler is most of the growth, then the maps (projections, geojson / geopoint data, geoshape marks) and the animation (the `time` channel's scale and frame dataset). Trimming the validation layer
(`packages/vl/src/validate.ts`: allow-lists derived from one table each, shared message templates, dead branches removed;
no check dropped, every message unchanged) took `@aster/vl` from 180,940 to 176,836 bytes minified (-4.1 kB) and from
55,828 to 55,606 bytes gzip level 9 (-0.2 kB): the validator is mostly unique error text, which gzip already compresses well.
Measure it with `node` and esbuild on `packages/vl/dist/index.js` (`@aster/core` external, minify).

## Practical guidance

- Large static dashboards: keep `<Chart incremental>` (default) and pass stable spec objects. Memoize spec
  builders at the call site.
- Streaming updates: use `createChartStream` (bounded queue, coalesced appends) or supply `dataChanges` with
  the new immutable data array.
- Transforms with no fast path (the global fitters `kde`, `regression`, `loess`, `quantile`, `contour`,
  `wordcloud`, ...) re-derive on an append; the downstream change result is still correct.
- Huge or untrusted specs: combine `limits` with `useChartWorker`.
- Dense marks: canvas avoids SVG node cost; hit testing uses a uniform grid above 400 items.
- Accessibility tree: set `a11y={{ summaryThreshold: N }}` (default 150) to collapse very dense marks into one
  summary node.
