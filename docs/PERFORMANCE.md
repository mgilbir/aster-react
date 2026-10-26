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

Measured 2026-10-23 on the development machine (Linux x86_64, node v26.11.1, headless Chromium from
Playwright), one run each, nothing else running, after `pnpm build`. Timings are machine- and
load-dependent: compare the ratios and the shape, and re-run before quoting. The incremental gate
(`pnpm bench:incremental`) is the only one of these with a pass/fail floor; the floors and how they were
chosen are at the top of `packages/benchmarks/src/incremental.bench.tsx`.

### Compute: incremental append vs full evaluation (node, no paint)

`pnpm bench:incremental -- --points=10000 --reps=30` (three runs, medians in ms), 800x500 symbol chart,
one row appended per update:

| Path | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| full `evaluateChart` | 2.3 | 2.5 | 2.2 |
| `createChartStream` append + flush | 0.1 | 0.1 | 0.1 |
| `view.change(changeset().insert(...)).run()` in vega (`renderer: 'none'`) | 1.0 | 1.0 | 1.0 |
| append speedup vs full | 22.2x | 26.7x | 24.0x |
| append vs vega | 10.1x | 11.2x | 11.3x |
| whole-array replacement speedup vs full | 23.2x | 24.9x | 22.0x |
| DOM patch (`patchSceneDom`, 4000 points, jsdom) vs `renderSceneToSvg` | 5.2x | 6.9x | 4.9x |
| dense 100,000-symbol mark: append patch vs mount (ms) | 0.85 vs 283.1 (332x) | 0.87 vs 273.6 (316x) | 0.89 vs 273.2 (306x) |

`pnpm bench:incremental -- --points=100000 --reps=40`: full evaluate 37.8 ms, stream append 0.2 ms
(179x), vega `view.change` 12.6 ms (aster 60x cheaper), whole-array replacement 77x; dense append patch
0.85 ms vs a 249.6 ms mount (293x).

### Differential updates (node, no DOM)

`pnpm bench:differential -- --points=50000` (about 1% of rows changed; `evaluateChart` with a changeset vs a full
re-encode): row-wise `formula` 46.8 to 1.1 ms (40.9x), fixed-scale symbol 17.4 to 0.4 ms (45.7x),
`aggregate` over 1000 groups 5.4 to 2.6 ms (2.1x). Scene evaluation plus `patchSceneDom` at 4000 points:
9.9x, 9.7x and 3.4x for the same three cases.

### Embedding: `<Chart>` vs react-vega and the vega-embed tutorial

`pnpm bench:runtime` (jsdom, relative timings only; median update ms, 1000 points): line aster 3.2 /
asterDom 2.6 / react-vega 6.3 / vega-embed hook 4.0; scatter 5.1 / 4.3 / 32.0 / 66.1; bar 12.0 / 11.0 / 78.3 /
55.3. DOM nodes for the scatter chart: 82 vs 1073.

`pnpm bench:browser -- --points=1000 --memory=false` (headless Chromium, median ms, first render / update):
line aster 2.2 / 2.5, asterDom 1.4 / 1.9, react-vega 2.8 / 3.3, vega-embed hook 2.3 / 2.5; scatter aster
2.7 / 3.4, asterDom 2.5 / 3.2, react-vega 7.7 / 8.4, vega-embed hook 7.3 / 8.2. Stable-content re-render
(fresh spec object, same data): 0 DOM mutations on all four; 0.3 to 0.4 ms for aster vs 0.1 to 0.2 ms for the
Vega wrappers. Under a one-update-per-frame stream the line and scatter charts hold 16.7 ms median frames on all
four; long frames (over 21 ms) are 0.0% to 0.6% for aster, 0.0% to 3.4% for the Vega embeds.

`pnpm bench:memory` (jsdom heap growth per cycle, steady state, kB): line update aster 23.0 /
asterDom 15.5 / react-vega 42.1 / vega-embed hook 10.4; scatter update 16.0 / 13.5 / 31.9 / 19.0.

### Streaming appends in a real browser: `<ChartStream>` vs vega `view.change`

`pnpm bench:browser-stream` (one append per animation frame for 3 s, 800x500 symbol chart with an explicit
symbol fill, headless Chromium, median frame / share of frames over 21 ms / DOM mutations per append):

| Points | Backend | aster | vega `view.change` + `run` |
|---|---|---|---|
| 10,000 | SVG | 16.7 ms / 0.6% / 1.0 | 16.6 ms / 2.9% / 242.0 |
| 10,000 | canvas | 16.6 ms / 0.0% / 0 | 16.7 ms / 0.0% / 0 |
| 100,000 | SVG (per-item, `denseMarks` off) | 149.3 ms / 94.1% / 1.0 | 166.2 ms / 100.0% / 30,782.8 |
| 100,000 | canvas | 16.7 ms / 0.0% / 0 | 18.6 ms / 19.3% / 0 |

`pnpm bench:browser-stream -- --points=100000 --seconds=3 --engines=aster --renderers=svg --dense=0,1`
(aster SVG, microtask flush): per-item 154.3 ms median frame, 94.4% long, 100,030 DOM nodes, 19 appends in 3 s;
with `denseMarks` 33.3 ms, 97.7% long, 402 DOM nodes, 88 appends. Dense marks cut the per-frame cost by about
4.6x; neither SVG variant holds a 16.7 ms frame at 100,000 points, canvas does.

**Earlier figures for the 100,000-point SVG stream were wrong.** Previous versions of this document and of the
README, CHANGELOG and benchmarks README quoted about 77 ms per frame per-item and 16.7 ms with 0% long frames with
`denseMarks`. Those were measured on an unfilled render: the benchmark spec drew symbols without a `fill`, and before
the default-config fix Aster rendered such symbols unfilled (Vega draws them filled), so the benchmark measured an
empty paint layer. The benchmark spec now states its fill, and the numbers above are the filled render on this
machine. I measured them on the current stack; the reviewer reports that the pre-audit baseline gives the same numbers once the fill is explicit (I did not re-run that).

## Bundle sizes

`pnpm bench:bundle` (esbuild, minified, react external): `@aster/react` `<Chart>` 160.6 kB gzip
(458.6 kB minified, 136.0 kB brotli), `<SvgChart>` from `@aster/react/lite` 145.1 kB gzip (419.2 kB minified, 123.8 kB brotli),
`<SvgChart>` + `interaction` 154.8 kB gzip (443.2 kB minified, 131.5 kB brotli), vs react-vega 288.7 kB gzip and the official
vega-embed tutorial 288.0 kB.

`pnpm --filter @aster/benchmarks run budget` bundles one tiny app per documented import pattern (esbuild, minify,
`NODE_ENV=production`, tree-shaking on, react external) and gates its gzip size (default level). The addon rows are
MARGINAL: the addon's gzip added to the `@aster/core` app. The old rows measured each addon standalone, which
double counted the code it shares with core (hit read 15.6 kB where an app pays about 5). Each budget is the measured
size plus 0.5 kB (`packages/benchmarks/scripts/budget.mjs` holds the rationale); a change that needs more room edits
the number in the same PR. Measured 2026-10-26 (the core rows grew by 3.1 kB with the runtime parity work: guide encoders, discretizing label formats, per-scope structure walk):

| Import pattern | Before (gzip kB) | Now (gzip kB) | Budget (kB) |
|---|---|---|---|
| `import { renderSpec } from '@aster/core'` | 123.0 | 126.2 | 126.7 |
| `import { useChart } from '@aster/react'` | 164.1 | 129.7 | 130.2 |
| `import { Chart } from '@aster/react'` | 163.9 | 160.6 | 161.1 |
| `import { SvgChart } from '@aster/react/lite'` | n/a | 145.1 | 145.6 |
| `<SvgChart>` + `import { interaction } from '@aster/react/interaction'` | n/a | 154.8 | 155.3 |
| `import '@aster/react/vl'` + `<Chart>` | 218.3 | 214.8 | 215.3 |
| core + `@aster/core/dom` (marginal) | 5.8 | 5.7 | 6.2 |
| core + `@aster/core/canvas` (marginal) | 4.8 | 4.8 | 5.3 |
| core + `@aster/core/hit` (marginal) | 5.1 | 5.0 | 5.5 |
| core + `@aster/core/signals` (marginal) | 4.4 | 4.4 | 4.9 |
| core + `@aster/core/load` (marginal) | 5.1 | 5.1 | 5.6 |
| core + `@aster/core/geo` (marginal) | 12.4 | 12.3 | 12.8 |
| core + `@aster/core/transforms` (marginal) | 15.1 | 15.1 | 15.6 |

"Before" is the same apps bundled with no `sideEffects` field (`ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1 node
packages/benchmarks/scripts/budget.mjs`, run from `packages/benchmarks`; the Vega-Lite row also had the untrimmed validator). Without
the field a bundler must assume every module has effects, so `import { useChart }` pulled in `Chart`, `ChartStream`,
`useChartStream`, `useChartWorkerStream`, the worker host and `batches` (37.7 kB gzip it never calls). The manifests now
list the files that really have an import effect (see [ARCHITECTURE.md](ARCHITECTURE.md#side-effects-and-tree-shaking)).
`<Chart>` was 156.5 kB (+ VL 210.7) before it became a shell over `ChartCore` with injected capabilities; the +0.7 kB is the
property reads through the capability objects (a minifier cannot rename them) and the report of a missing capability, which
only `<SvgChart>` can trigger but both share. `<SvgChart>` is 15.2 kB smaller than `<Chart>`: the canvas renderer, the hit index
and the signal loop (4.8 + 5.0 + 4.4 kB as marginal rows, plus what they share with nothing else). The rows that contain no such
code are checked on the module list, not only the byte count: `pnpm check:bundle` asserts on the esbuild metafile that the
`<SvgChart>` bundle reads no `core/canvas`, `core/hit` or `core/signals` module, and that with `interaction` it reads hit and
signals but still no canvas (`hit.ts` and `canvas.ts` share the path parser through `path-data.ts` for exactly this reason).

The `useChart` and `<Chart>` rows fail if the field is removed or widened; `scripts/bundle-shaking.test.mjs` plants
that fault and requires the budget to fail. The other direction (a list that is too narrow drops a registration) is
caught by `pnpm check:bundle`, which bundles and executes each import pattern.

The Vega-Lite compiler is 54.2 kB gzip on top of the base `<Chart>` (214.8 minus 160.6). Trimming the validation layer
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
