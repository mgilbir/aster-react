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
| full `evaluateChart` | 2.3 | 2.3 | 2.4 |
| `createChartStream` append + flush | 0.1 | 0.1 | 0.1 |
| `view.change(changeset().insert(...)).run()` in vega (`renderer: 'none'`) | 1.0 | 1.0 | 1.0 |
| append speedup vs full | 25.6x | 24.3x | 23.4x |
| append vs vega | 10.9x | 10.4x | 10.0x |
| whole-array replacement speedup vs full | 23.4x | 13.8x | 24.2x |
| DOM patch (`patchSceneDom`, 4000 points, jsdom) vs `renderSceneToSvg` | 5.7x | 5.4x | 5.8x |

`pnpm bench:incremental -- --points=100000 --reps=40`: full evaluate 37.8 ms, stream append 0.2 ms
(188x), vega `view.change` 12.5 ms (aster 62x cheaper), whole-array replacement 0.5 ms (77x).

### Differential updates (node, no DOM)

`pnpm bench:differential -- --points=50000` (about 1% of rows changed; `evaluateChart` with a changeset vs a full
re-encode): row-wise `formula` 45.6 to 1.2 ms (39.1x), fixed-scale symbol 17.6 to 0.4 ms (43.7x),
`aggregate` over 1000 groups 6.2 to 3.2 ms (1.9x). Scene evaluation plus `patchSceneDom` at 4000 points:
7.3x, 11.0x and 5.6x for the same three cases.

### Embedding: `<Chart>` vs react-vega and the vega-embed tutorial

`pnpm bench:runtime` (jsdom, relative timings only; median update ms, 1000 points): line aster 3.0 /
asterDom 2.4 / react-vega 6.4 / vega-embed hook 3.5; scatter 4.3 / 4.1 / 32.2 / 65.7; bar 11.8 / 10.5 / 80.3 /
54.3. DOM nodes for the scatter chart: 68 vs 1073.

`pnpm bench:browser -- --points=1000 --memory=false` (headless Chromium, median ms, first render / update):
line aster 2.0 / 2.4, asterDom 1.4 / 1.9, react-vega 2.8 / 3.3, vega-embed hook 2.4 / 2.7; scatter aster
2.7 / 3.5, asterDom 2.4 / 3.1, react-vega 8.2 / 8.7, vega-embed hook 7.5 / 8.0. Stable-content re-render
(fresh spec object, same data): 0 DOM mutations on all four; 0.4 to 0.7 ms for aster vs 0.1 to 0.2 ms for the
Vega wrappers. Under a one-update-per-frame stream all four hold 16.7 ms median frames; long frames
(over 21 ms) are 0.0% to 0.6% for aster, 0.0% to 1.7% for the Vega embeds.

`pnpm bench:memory` (jsdom heap growth per cycle, steady state, kB): line update aster 20.9 /
asterDom 15.0 / react-vega 42.1 / vega-embed hook 10.3; scatter update 16.0 / 22.6 / 47.4 / 35.8.

### Streaming appends in a real browser: `<ChartStream>` vs vega `view.change`

`pnpm bench:browser-stream` (one append per animation frame for 3 s, 800x500 symbol chart, headless
Chromium, median frame / share of frames over 21 ms / DOM mutations per append):

| Points | Backend | aster | vega `view.change` + `run` |
|---|---|---|---|
| 10,000 | SVG | 16.7 ms / 0.6% / 1.0 | 16.4 ms / 4.6% / 240.7 |
| 10,000 | canvas | 16.7 ms / 0.0% / 0 | 16.7 ms / 0.0% / 0 |
| 100,000 | SVG (per-item, `denseMarks` off) | 153.1 ms / 94.1% / 1.0 | 166.8 ms / 100.0% / 30,782.8 |
| 100,000 | canvas | 16.7 ms / 0.0% / 0 | 16.7 ms / 1.8% / 0 |

`pnpm bench:browser-stream -- --points=100000 --seconds=3 --engines=aster --renderers=svg --dense=0,1`
(aster SVG, microtask flush): per-item 149.6 ms median frame, 94.7% long, 100,031 DOM nodes; with
`denseMarks` 33.4 ms, 96.6% long, 402 DOM nodes.

**Regression against the earlier baseline.** The same two commands on the commit this work started from (`main`,
`2fb9733`, before the audit fixes) gave 77.1 ms per frame per-item (97.2% long) and **16.7 ms with 0.0% long frames
with `denseMarks`**: the 100,000-point SVG stream that used to hold the frame budget with dense marks now takes about
twice as long per frame (33.4 ms). Running the same command at the branch tips bisects it: it is absent at
`audit/05-stream` (77.8 ms / 16.7 ms), present from `b69ca76` (the commit that applies Vega's default config, guide
content and gradient stops; per-item 150.9 ms, dense 36.4 ms) and unchanged through the tip of the stack. The
10,000-point streams and the canvas streams are unaffected (16.7 ms median frames). The cause has not been
investigated (the commit makes symbols carry Vega's default style attributes, so more is written per node); the
numbers above are what the current code does on this machine. Before this regression is accepted or fixed, re-run
`pnpm bench:browser-stream -- --points=100000 --seconds=3 --engines=aster --renderers=svg --dense=0,1` on the
machine that matters.

## Bundle sizes

`pnpm bench:bundle` (esbuild, minified, react external): `@aster/react` `<Chart>` 160.2 kB gzip
(461.4 kB minified, 135.6 kB brotli) vs react-vega 288.7 kB gzip and the official vega-embed tutorial 288.0 kB.

`pnpm --filter @aster/benchmarks run budget` gates each published entry independently, so an addon
import cannot silently inflate the base bundle. Each budget is the measured size plus 0.5 kB
(`packages/benchmarks/scripts/budget.mjs` holds the history); a change that needs more room edits the number
in the same PR:

| Entry | Gzip (kB) | Budget (kB) |
|---|---|---|
| `@aster/core` | 118.8 | 119.3 |
| `@aster/core/dom` | 122.3 | 122.8 |
| `@aster/core/canvas` | 15.7 | 16.2 |
| `@aster/core/hit` | 15.7 | 16.0 |
| `@aster/core/load` | 14.7 | 15.2 |
| `@aster/core/signals` | 41.0 | 41.5 |
| `@aster/react` | 160.2 | 160.7 |
| `@aster/react/vl` (React + the Vega-Lite compiler) | 212.9 | 213.4 |

The Vega-Lite compiler is therefore 52.7 kB gzip on top of the base entry (212.9 minus 160.2); the standalone
entries share most of their code with `@aster/core`, so their marginal cost in an app is far below the standalone
numbers.

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
