# Performance

Aster keeps a differential engine and adds opt-in boundaries so a chart pays only for the features it
imports. This document gives the practical guidance first, then the mechanisms, then the measurements. Every number is in
[Reference measurements](#reference-measurements) or [Bundle sizes](#bundle-sizes) next to the command that
produced it; the mechanisms below carry no numbers on purpose (they change with the code, the machine and
the browser).

## Practical guidance

- Large static dashboards: keep `<Chart incremental>` (default) and pass stable spec objects. Memoize spec
  builders at the call site.
- Streaming updates: use `createChartStream` (bounded queue, coalesced appends) or supply `dataChanges` with
  the new immutable data array.
- Transforms with no fast path (the global fitters `kde`, `regression`, `loess`, `quantile`, `contour`,
  `wordcloud`, ...) re-derive on an append; the downstream change result is still correct.
- Huge or untrusted specs: combine `limits` with `useChartWorker` and its `workerFactory`: `limits` gives the typed errors, and the
  hook's deadline (`timeoutMs`) terminates and replaces a worker that runs away.
- Dense marks: canvas avoids SVG node cost; hit testing uses a uniform grid above 400 items.
- Accessibility tree: set `a11y={{ summaryThreshold: N }}` (default 150) to collapse very dense marks into one
  summary node.

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
  evaluation keeps the rows of every step whose reads are as they were, republishing the signals it wrote. The React mount of a chart that fills its
  element (`width="container"`), which evaluates the spec at its own size and then at the measured element's, pays for the datasets once. Consecutive steps that
  only add fields (`bin`, `formula`, `timeunit`) write onto one set of rows instead of copying every row per step
  ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Fit views update incrementally**: a view that fits its viewport (`autosize` fit / fit-x / fit-y, Vega-Lite
  `"container"` sizes, and every `<Chart>` that fills its element with `width` / `height="container"`) builds its content twice, at the viewport
  and at the fitted size. Each pass of an update is made from the same pass of the evaluation before, so a one-row
  update re-encodes one item per pass instead of every item of the first pass. The view keeps both passes' state, so a fit view
  also retains the first pass's items between updates (not measured here; [ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Signal changes keep what does not read them**: a top-level mark keeps its group and its items, and a top-level scale its
  object, when the signals its definition names, the view's size and the datasets it reads are as they were, whichever other
  signals changed. A Vega-Lite `time` animation, whose clock ticks at 60 fps while its marks read the frame's rows, re-encodes
  nothing until the frame moves. A mark that tests a selection's store keeps its items while the store's rows are as they were;
  a point selection's numbered dataset and the scales over it are kept; and rows appended while a signal moves are a pulse that
  encodes the new items only. Marks with transforms, scales that read datasets or scales from an expression, and datasets with
  a step outside the kept-step list are made again on any signal change; group marks are made again, and the leaf marks inside
  their items are kept as on a data change
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
  same-paint symbol runs batch into one fill or one stroke when that paints what one path per item paints (opaque,
  unblended, filled or stroked but not both: overlapping translucent or filled-and-stroked symbols are painted one by
  one), and append-only streamed scenes paint just the new mark items.
- **Incremental scales**: continuous and discrete domains are reused when a changeset provably cannot move
  them; append-only continuous updates patch the min/max census in O(appended) instead of rescanning. A discrete
  scale over data (ordinal colour, shape, size, strokeDash; band; point) keeps its object when its rows change and its
  result does not: rows of categories it has appended or edited advance a census of the categories in O(changed), also
  after Vega-Lite's validity filter; any other change (a removal, a reorder, a sort by count or by an aggregate, several
  fields or datasets, `domainRaw`) reads the scale's settings again and keeps the scale when they are the same. The marks
  that read it then encode only the rows that changed. A new category, a category gone, or a sort order that moves makes
  the scale, and everything that reads it, again ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Marks inside group items**: a line per category, a facet's cells and a concat's views keep the leaf marks inside them by
  instance (the group item's key), encode only the rows that changed, and keep the group items, with their guides and titles, that
  did not change ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **DOM patching**: the first render emits the full SVG for SSR; later updates patch attributes in place.
  The mount commit skips the patcher (the browser just parsed that markup) and an append reuses the previous
  patch's descriptors as an identity prefix, so only the new items are created. Symbol descriptors are cached
  per mark group.
- **Dense marks (`denseMarks`, default `'auto'`)**: symbol marks with at least 512 items render as chunked
  `<path>` elements (256 items per chunk, positions baked into `d`) instead of one transformed element per
  datum. Chunks are cached per group, so an append re-serializes one chunk. Only opaque, unblended marks that
  are filled or stroked but not both batch (translucency must composite per item, and one path paints all its fill
  under all its stroke); rotated marks keep their own element; `'auto'` stays per-item when
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

The compute-side sections below (fit views, signal changes, selections, discrete scales, group marks) are before and after pairs: each names the
branch it was measured on and its base, and a probe that is committed under `packages/benchmarks/scripts/probes/` (`<worktree>` is any
checkout with a built `dist`, `.` for this one). The "before" builds are the base commits they name; to repeat a comparison, build the base
commit in a second worktree (`git worktree add`, `pnpm install`, `pnpm build`) and run the same probe on both, alternating, three rounds, on an idle
machine. Run on a different tree, a probe gives that tree's figure, not the one printed here; the printed figures belong to the date and machine in
their paragraph.

Measured 2026-11-05 on main at 098b243 on the development machine (Linux x86_64, node v26.13.0, headless Chromium
from Playwright), after `pnpm build`. The machine is shared: other users kept the load average between 0.5 and 5
during the runs. The Node figures are the median of three runs unless a table shows each run; the browser figures
are the median of two runs (six for `pnpm bench:browser`). Timings are machine- and load-dependent: compare the
ratios and the shape, and re-run before quoting. To compare two builds, run them alternately on the same machine
(the numbers below drifted from earlier editions of this page with the machine, not only with the code). The incremental gate
(`pnpm bench:incremental`) has a pass/fail floor in the PR gate, and the nightly browser benchmarks (`pnpm bench:browser`, `pnpm bench:browser-stream`) have floors too (`packages/benchmarks/src/browser-floors.ts`); the other benchmarks only print. The incremental floors and how they were
chosen are at the top of `packages/benchmarks/src/incremental.bench.tsx`. What each benchmark measures, and how to run the harness:
[packages/benchmarks/README.md](../packages/benchmarks/README.md).

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
(163x), vega `view.change` 19.0 ms (13.6 to 34.7 ms across the runs: Aster 54x to 107x cheaper), whole-array
replacement 37x; dense append patch 1.00 ms vs a 263.3 ms mount (273x).

### One-row updates on a view that fits its viewport (node, no DOM)

Measured 2026-11-09 on perf/fit-incremental against its base (df41263), the two builds run alternately, three rounds each,
load average 4 to 10. `node packages/benchmarks/scripts/probes/fit-view-update.mjs <worktree> 1`: a 10,000-point symbol chart with two
axes, `createChartSession().evaluate(spec, { data, dataChanges: { t: [i] }, ...size })`, 40 updates of one row inside the
domain, median ms per update. `fixed` is the Vega spec at `width/height` 600x300 (autosize pad, the control), `measured` the
same spec with `measuredSize` (autosize fit containing the padding), `vl-fixed` a Vega-Lite point chart at 600x300 (the
control for the next row) and `vl-cont` the same chart with `width/height: "container"` and `containerSize`.

| Case | base, rounds 1-3 | this change, rounds 1-3 |
|---|---|---|
| fixed (control) | 1.62 / 1.54 / 1.55 | 1.65 / 1.52 / 1.57 |
| measured (fit) | 6.01 / 5.67 / 5.76 | 1.36 / 1.32 / 1.38 |
| vl-fixed (control) | 2.45 / 2.38 / 2.49 | 2.42 / 2.47 / 2.42 |
| vl-cont (fit) | 36.81 / 36.83 / 35.84 | 4.34 / 4.56 / 4.31 |

A fit update now costs about what the fixed-size update of the same chart costs (0.9x for the Vega spec, 1.8x for the
Vega-Lite one, whose second pass also re-runs the formula and filter steps of its data); it was 3.7x and 15x. The first
update after a fresh evaluation, after a resize, or after an update that moves the fitted size (a domain change that widens
the axis labels) re-encodes what reads the size, as a resize of a fixed-size view does.

### Signal changes no mark reads (node, no DOM)

Measured 2026-11-10 on perf/signal-scoped-reuse against its base (main at e31d61c), the two builds run alternately, three
rounds each, on the shared machine. `node packages/benchmarks/scripts/probes/time-tick.mjs <worktree>`: a Vega-Lite `time`
animation over 3,000 points (`params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }]`, a
`filter` by it, `time: year` over three years), `createChartSession().evaluate(vg, { signals: { anim_clock } })` with only the
clock advanced by 16 ms per tick and no data change, 30 ticks, median and p90 ms per tick. The control is the fixed-size
one-row update of the section above (`node packages/benchmarks/scripts/probes/fit-view-update.mjs <worktree>`, its last run of three), which this change does not touch.

| Case | base, rounds 1-3 | this change, rounds 1-3 |
|---|---|---|
| tick, median (p90) | 11.76 (16.87) / 12.07 (17.92) / 11.86 (17.41) | 0.90 (1.01) / 0.91 (1.02) / 0.93 (1.41) |
| items of the 30th tick kept | 0 of 3000 | 3000 of 3000 |
| the same inputs again (session cache) | 0.06 / 0.05 / 0.06 | 0.04 / 0.04 / 0.04 |
| control: fixed-size one-row update | 0.56 / 0.55 / 0.62 | 0.56 / 0.56 / 0.58 |

The tick keeps the mark group, its items and the three scales, and the frame filter's step (it reads the store by name, and
the store's rows are equal). Keying a result by its reads costs a few microseconds per evaluation: a one-row stream append
on 10,000 points (`createChartStream`, 500 appends, the same alternation) went from 62 / 63 / 67 to 69 / 69 / 68 µs median.
`pnpm bench:incremental -- --points=10000 --reps=30`, three runs each: append speedup vs a full evaluation 21.5x / 21.8x /
20.2x before, 18.9x / 20.0x / 17.2x after (floor 8x); the stream append rounds to 0.1 ms before and 0.1 to 0.2 ms after.

### Selections, and rows with a signal change (node, and Chromium)

Measured 2026-11-10 on perf/selection-signal-reuse against its base (perf/transition-retarget-by-identity at 082a700, which holds
the signal-scoped reuse above), the two builds run alternately, three rounds each, on the shared machine. `node packages/benchmarks/scripts/probes/selection-reuse.mjs <worktree>`
and `node packages/benchmarks/scripts/probes/selection-fit.mjs <worktree>`: Vega-Lite scatters of 5,000 points compiled by
`@aster-charts/vl`, driven through `createChartSession().evaluate` as `<Chart>` drives it (each store handed back as data, a new
array on every edit), 40 evaluations per case (30 for the fit view, `width: "container"` with a measured 640 x 300), median ms.
`unread` changes a param no mark reads; `click` / `move` / `drag` put another tuple in the store; `append` adds one row inside the
domains. In the cases marked `3b` the points' opacity tests the selection (no ordinal color scale, whose census did not advance
over an append then: see the next section).

| Case | base, rounds 1-3 | this change, rounds 1-3 | kept after the change |
|---|---|---|---|
| point (click) selection, unread signal | 22.46 / 22.99 / 23.41 | 0.69 / 0.68 / 0.68 | 3 of 3 scales, 5000 of 5000 items |
| point (click) selection, a click | 22.27 / 22.08 / 22.04 | 16.72 / 16.97 / 16.79 | 3 of 3 scales (the points are encoded again) |
| hover selection, the same point | 21.32 / 21.25 / 21.71 | 0.59 / 0.57 / 0.58 | 3 of 3 scales, 5000 of 5000 items |
| hover selection, another point | 21.23 / 21.22 / 21.24 | 16.59 / 16.10 / 16.01 | 3 of 3 scales |
| interval brush, unread signal | 17.15 / 17.27 / 17.22 | 0.58 / 0.62 / 0.61 | the brush's marks and 5000 of 5000 items |
| interval brush, a drag step | 17.37 / 17.18 / 17.16 | 17.67 / 17.31 / 17.90 | the scales (as before) |
| 3b hover, append + unread | 28.52 / 28.51 / 28.72 | 0.75 / 0.76 / 0.76 | 5040 of 5041 items, 2 of 2 scales |
| 3b hover, one row modified + unread | 28.07 / 28.57 / 28.51 | 2.28 / 2.18 / 2.13 | 4999 of 5000 items |
| 3b brush, append | 21.10 / 20.88 / 21.14 | 0.76 / 0.81 / 0.79 | 5040 of 5041 items |
| 3b brush, append + unread | 26.85 / 27.19 / 27.15 | 0.72 / 0.77 / 0.78 | 5040 of 5041 items |
| fit view, hover, unread | 47.64 / 47.25 / 48.26 | 1.98 / 1.78 / 1.81 | 2 of 2 scales, 5000 of 5000 items |
| fit view, hover, append + unread | 56.10 / 55.80 / 55.50 | 2.06 / 2.09 / 2.10 | 5030 of 5031 items |
| fit view, brush, append + unread | 52.93 / 53.13 / 52.93 | 2.13 / 2.09 / 2.14 | 5030 of 5031 items |
| controls: fixed-size one-row update (`fit-view-update.mjs`, last run of three) | 0.58 / 0.57 / 0.57 | 0.60 / 0.56 / 0.56 | |
| controls: `time` animation tick (`time-tick.mjs`) | 0.91 / 0.92 / 0.91 | 0.90 / 0.91 / 0.91 | |
| controls: one-row stream append, 10,000 rows, no transforms (µs) | 68 / 70 / 68 | 69 / 69 / 70 | |
| one-row stream append through formula, formula, filter (µs) | 273 / 276 / 317 | 279 / 282 / 282 | |

A drag step costs what it did, a little more (17.2-17.4 ms before, 17.3-17.9 after: the keys of the store the points read are
made on every step, and the points are encoded again, as they must be). In headless Chromium (`node packages/benchmarks/scripts/probes/selection-drag.mjs <worktree> brush|hover
5000`: `<Chart>` bundled from each worktree, 50 pointer moves, the time from a move to the second animation frame after it, which
counts whole frames), a brush drag went from 115.1 / 115.2 / 115.3 to 81.8 / 81.8 / 81.8 ms and a hover sweep from 97.8 / 104.5 /
98.1 to 64.4 / 64.6 / 64.3 ms median. `pnpm bench:incremental -- --points=10000 --reps=30`, three runs each, alternated: append
speedup vs a full evaluation 19.10x / 19.36x / 19.30x before, 16.86x / 19.09x / 19.06x after (floor 8x); a session's whole-array
replacement 15.42x / 15.08x / 15.13x before, 16.24x / 16.62x / 16.90x after; the stream append rounds to 0.1-0.2 ms in both.

### Discrete scales over changing rows (node, no DOM)

Measured 2026-11-10 on perf/discrete-scale-appends against its base (72ffeea, which holds #136-#138), the two builds run
alternately, three rounds each, load average 1.3 to 1.8. `node packages/benchmarks/scripts/probes/discrete-scale-appends.mjs <worktree> 5000 20`:
Vega-Lite charts of 5,000 rows in five categories compiled by `@aster-charts/vl`, driven through `createChartSession().evaluate` as
`<Chart>` drives it (a new array per update, which the session diffs), 20 updates per case, median ms; `stream` is a
`createChartStream` append of one row, as `<ChartStream>` delivers it (80 appends). `scatter` is a point chart coloured by a
nominal field, `bar` a bar chart with a nominal x (stacked, as Vega-Lite stacks it), `stacked` a bar chart summing y per 50 ordinal
x bands, coloured by category, `line` one line per category. Items kept are counted by identity after the last update.

| Case | base, rounds 1-3 | this change, rounds 1-3 | kept after the change |
|---|---|---|---|
| scatter, a row of a category appended | 15.64 / 15.97 / 15.70 | 1.66 / 1.70 / 1.75 | the colour scale, 5019 of 5020 items |
| scatter, a row removed | 14.97 / 15.23 / 14.90 | 1.82 / 1.94 / 1.85 | the colour scale, 4980 of 4980 items |
| scatter, a value edited | 14.51 / 14.82 / 14.73 | 1.75 / 1.86 / 1.77 | the colour scale, 4999 of 5000 items |
| scatter, a category edited to another | 14.97 / 15.40 / 14.58 | 1.55 / 1.57 / 1.53 | the colour scale, 4999 of 5000 items |
| scatter, a new category appended | 14.97 / 15.28 / 15.54 | 15.54 / 16.40 / 15.28 | nothing (the domain changed) |
| scatter, stream append | 14.78 / 14.77 / 14.94 | 0.59 / 0.59 / 0.58 | the colour scale, 5079 of 5080 items |
| bar, a row of a category appended | 15.03 / 14.91 / 15.07 | 4.21 / 5.13 / 5.01 | the x scale, 5019 of 5020 items |
| bar, a row removed | 15.17 / 14.61 / 14.73 | 5.26 / 5.17 / 5.37 | the x scale, 4028 of 4980 items (the stack moves the bars above it) |
| bar, a category edited to another | 15.36 / 14.71 / 15.41 | 9.97 / 9.76 / 10.16 | the x scale, 3169 of 5000 items (two stacks move) |
| bar, stream append | 15.00 / 14.64 / 14.96 | 2.55 / 2.50 / 2.55 | the x scale, 5079 of 5080 items |
| stacked, a row of a category appended | 1.15 / 1.17 / 1.13 | 0.91 / 0.93 / 0.92 | both discrete scales, 49 of 50 bars |
| stacked, a category edited to another | 2.21 / 2.19 / 2.19 | 2.05 / 2.03 / 1.98 | both discrete scales, 68 of 70 bars |
| line, a row of a category appended | 17.53 / 17.56 / 17.54 | 18.07 / 17.73 / 18.30 | the colour scale; no item (group marks were made again then: see the next section) |
| line, a value edited | 16.26 / 16.46 / 16.55 | 17.07 / 17.08 / 16.99 | the colour scale; no item |
| controls: fixed-size one-row update (`fit-view-update.mjs`) | 0.55 / 0.55 / 0.56 | 0.57 / 0.57 / 0.58 | |
| controls: `time` animation tick (`time-tick.mjs`) | 0.91 / 1.04 / 0.92 | 0.94 / 0.93 / 0.93 | 3000 of 3000 items, both |
| controls: point / brush, an unread signal (`selection-unread.mjs`) | 0.44 / 0.44 / 0.46, 0.78 / 0.75 / 0.76 | 0.46 / 0.47 / 0.48, 0.79 / 0.77 / 0.75 | |

A new category costs what it did: every item is coloured again, as a fresh evaluation colours it. The line chart keeps its colour
scale but draws its lines in a group mark, which is made again on every evaluation, so its cost does not move (0.1 to 0.6 ms more in
these rounds; a CPU profile of 150 edits shows no new hot function, and a separate alternation measured 15.91 / 16.02 before and
16.27 / 16.11 ms after). `pnpm bench:incremental -- --points=10000 --reps=30`, three runs each, alternated: append speedup vs a full
evaluation 18.11x / 20.13x / 19.46x before, 19.23x / 19.50x / 19.53x after (floor 8x); a session's whole-array replacement
15.51x / 16.58x / 16.48x before, 14.74x / 14.29x / 14.76x after, whose session update measured alone (300 updates, alternated
three times) is 309 / 261 / 263 µs before and 261 / 262 / 262 µs after. `pnpm bench:browser-stream` held every floor before and
after (`<ChartStream>` on 10,000 points: 16.6 ms median frame before and 16.7 ms after, one mutation per append).

### Marks inside group items over changing rows (node, no DOM)

Measured 2026-11-10 on perf/discrete-scale-appends (11933f5) against the same base (72ffeea), alternated, three rounds each, load
average 2.9 to 5.3. `node packages/benchmarks/scripts/probes/group-marks.mjs <worktree> 5000 15`: Vega-Lite charts of 5,000 rows in five
categories through `createChartSession().evaluate` (a new array per update), 15 updates per case, median ms. `line` is one line per
category (a group mark faceted by the category, its line sorted), `facet` a scatter faceted into a column per category (each cell
with its grid axes), `concat` two views side by side. Items and groups (cells, headers, the groups of guides) are counted by identity
after the last update. The controls are the earlier sections' probes.

| Case | base, rounds 1-3 | this change, rounds 1-3 | kept after the change |
|---|---|---|---|
| line, a row of a category appended | 19.09 / 17.87 / 18.34 | 2.94 / 2.96 / 2.96 | 5014 of 5015 items; 4 of 10 groups |
| line, a row removed | 17.27 / 17.26 / 17.25 | 3.20 / 3.17 / 3.20 | 4985 of 4985 items |
| line, a value edited | 16.67 / 16.55 / 16.72 | 1.82 / 1.73 / 1.79 | 4999 of 5000 items |
| facet, a row of a category appended | 16.51 / 16.77 / 16.85 | 3.50 / 3.61 / 3.93 | 5014 of 5015 items; 36 of 40 groups |
| facet, a row removed | 17.06 / 17.30 / 17.34 | 4.10 / 4.16 / 4.21 | 4985 of 4985 items |
| facet, a value edited | 16.94 / 16.45 / 16.99 | 3.42 / 3.60 / 3.49 | 4999 of 5000 items; 38 of 40 groups |
| concat, a row appended | 25.20 / 25.03 / 25.17 | 4.09 / 3.92 / 3.96 | 10028 of 10030 items; 8 of 11 groups |
| concat, a row removed | 25.49 / 24.96 / 25.04 | 3.78 / 4.35 / 3.73 | 9970 of 9970 items |
| concat, a value edited | 24.77 / 25.07 / 24.82 | 3.67 / 3.66 / 3.44 | 9998 of 10000 items |
| scatter by category, append (the previous section's probe) | 15.61 / 16.43 / 15.89 | 1.69 / 1.68 / 1.72 | |
| controls: fixed-size one-row update (`fit-view-update.mjs`) | 0.57 / 0.56 / 0.58 | 0.58 / 0.59 / 0.58 | |
| controls: `time` animation tick (`time-tick.mjs`) | 0.93 / 0.93 / 0.93 | 0.96 / 0.95 / 0.95 | 3000 of 3000 items, both |
| controls: point / brush, an unread signal (`selection-unread.mjs`) | 0.45 / 0.46 / 0.46, 0.79 / 0.75 / 0.74 | 0.47 / 0.49 / 0.49, 0.77 / 0.76 / 0.78 | |

The groups not kept are the cell (or line) that changed, the groups above it, and the view's own axes and legend, which are made
again on every evaluation (comparing them would cost every chart without a group mark: a first version that did took the
fixed-size control from 0.56 to 0.70 ms and the tick from 0.93 to 1.22 ms). A kept or spliced mark compares its rows with its items'
data, O(rows) per evaluation: most of the 1.3 to 2.5 ms these cases cost beyond the scatter. `pnpm bench:incremental --
--points=10000 --reps=30`, alternated: append speedup 19.56x before, 18.78x after (floor 8x); `pnpm bench:browser-stream` held every
floor before and after (`<ChartStream>` on 10,000 points: 16.7 / 16.6 ms median frame).

### Differential updates (node, no DOM)

`pnpm bench:differential` (50,000 points, about 1% of rows changed; `evaluateChart` with a changeset vs a full
re-encode): row-wise `formula` 22.6 to 1.0 ms (23.1x), fixed-scale symbol 19.2 to 0.5 ms (38.8x),
`aggregate` over 1000 groups 6.2 to 2.5 ms (2.5x). Scene evaluation plus `patchSceneDom` at 4000 points:
6.6x, 9.5x and 3.0x for the same three cases.

### Embedding: `<Chart>` vs react-vega and the vega-embed tutorial

`pnpm bench:runtime` (jsdom, relative timings only; median update ms, 1000 points): line aster 3.5 /
asterDom 2.9 / react-vega 6.1 / vega-embed hook 3.7; scatter 4.6 / 4.2 / 33.1 / 70.7; bar 13.4 / 13.8 / 86.5 /
62.4. DOM nodes for the scatter chart: 82 vs 1073.

`pnpm bench:browser -- --points=1000 --memory=true` (headless Chromium; the table is the median of three runs made on 2026-11-23 at load
averages between 2 and 21 on a shared machine, median ms, first render / update). `aster` is `<Chart incremental={false}>` (string mode: the
svg is re-serialized and set as markup per update) and `asterDom` is `<Chart>`, whose default is the incremental patcher; until 2026-11-23 the
`aster` row was the same configuration as `asterDom` (it left `incremental` to its default), so the two differed only by noise:

| 1000 points | aster (string mode) | asterDom (default) | react-vega | vega-embed hook |
|---|---|---|---|---|
| line | 5.9 / 3.4 | 3.2 / 2.9 | 5.7 / 5.0 | 3.4 / 3.6 |
| scatter | 5.1 / 5.3 | 2.7 / 3.0 | 7.7 / 8.6 | 7.7 / 9.4 |
| bar | 14.0 / 14.0 | 17.4 / 16.0 | 25.7 / 33.8 | 35.4 / 16.9 |

The runs disagree about the order on bar (the default mode led in two of the three: 9.9 / 8.6 ms against string mode's 11.2 / 11.5 in the
quietest, 17.4 / 16.0 against 14.0 / 14.0 in the busiest), so only the large differences mean something: the incremental mode is the faster
one on line and scatter, a scatter of 1000 points is about 2x quicker to render and update in it than in string mode, and both modes are
ahead of react-vega and level with or ahead of vega-embed's hook (which updates in place with `view.change`) everywhere except line's first
render in string mode. `src/browser-floors.ts` fails the nightly run for ratios far outside these (the default mode 1.5x the faster Vega embed,
string mode 3x, the default mode 2x string mode). Stable-content re-render (fresh spec object, same data): 0 DOM mutations on all four, in
every run; 0.0 to 0.5 ms. Under a one-update-per-frame stream the share of frames over 21 ms ranged, over the three runs, 0.0% to 2.2% for the
default mode on line and 0.0% to 9.6% on scatter (0.6% to 3.9% and 2.2% to 57% for string mode), against 0.0% to 3.4% and 2.3% to 52% for the
Vega embeds; on bar every engine drops frames, the default mode 2.8% to 72%, string mode 61% to 100%, react-vega 98%, the hook 5% to 56%, the
spread being the machine's load, not the chart. Retained heap after churn (mount, 30 updates, unmount, five times, a collection before each
reading): -0.3 to 0.7 MB for every embed. Container resizes were followed 4 of 4 times by every embed.

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
(Aster SVG, microtask flush): per-item 161.2 ms median frame, 94.2% long, 100,030 DOM nodes, 18 to 19 appends in
3 s; with `denseMarks` 33.5 ms, 96.3% long, 402 DOM nodes, 82 to 84 appends. Dense marks cut the per-frame cost by
about 4.8x; neither SVG variant holds a 16.7 ms frame at 100,000 points, canvas does.

## Bundle sizes

`pnpm bench:bundle` (esbuild, minified, react external; every chunk counts, including the ones loaded on demand), measured
2026-11-23: `@aster-charts/react` `<Chart>` 312.7 kB gzip (845.6 kB minified, 261.8 kB brotli), `<SvgChart>` from `@aster-charts/react/lite`
284.3 kB gzip (770.3 kB minified, 239.0 kB brotli), `<SvgChart>` + `interaction` 302.7 kB gzip (817.1 kB minified, 254.4 kB brotli), vs react-vega
288.7 kB gzip (832.2 kB minified, 239.9 kB brotli) and the official vega-embed tutorial 288.0 kB (830.5 kB minified, 239.6 kB brotli). The
Aster rows are Vega only and count every chunk, the ones a browser build fetches on demand included (`<Chart>` is 190.6 kB of that up front,
the table below). The react-vega and vega-embed bundles include Vega-Lite (about 731 kB of their source inputs), so the like-for-like
comparison for a Vega-Lite app is `<Chart>` plus the Vega-Lite compiler: 296.9 kB gzip up front plus 137.3 kB loaded on demand (the `budget`
rows below), 434.2 kB in all, which is above react-vega's 288.7 kB. The smaller figure holds for Vega specs only.

`pnpm --filter @aster-charts/benchmarks run budget` bundles one tiny app per documented import pattern (esbuild, minify,
`NODE_ENV=production`, tree-shaking on, react external) and gates its gzip size (default level). Every file of the app is gzipped
on its own and the figures are the sums, because a browser fetches separately compressed files (one gzip of their concatenation read
3 to 5% under what is transferred; the React rows went up 6.5 to 11.5 kB when the method changed, with no code change). The add-on rows
are MARGINAL: the add-on's gzip added to the `@aster-charts/core` app (the old rows measured each add-on standalone, which double counted
the code it shares with core). A row counts the code a page loads up front: the entry and every chunk it imports statically. The React rows
also carry a TOTAL, the up-front size plus every chunk the app can fetch later, so code moved behind an `import()` that every chart triggers
cannot lower a row unseen. Each ceiling is the measured size plus 0.5 kB, and the measure must stay 0.3 to 0.7 kB under it: a change that grows
a row past that, or shrinks it past the other side (a ceiling gone stale, or an import that was shaken out and now measures nothing), fails
and re-sets the ceiling in its own change. The rows and ceilings are in `packages/benchmarks/scripts/budget-rows.mjs` (the history of why a
row grew is the git log of that file); the run prints the measure, the ceiling and the headroom of each. A row that names no ceiling, a
ceiling that names no row, an esbuild warning and a `dist` that is not the build of the sources (a missing or older output, an output whose
source is gone) all fail. Measured 2026-11-23 with `pnpm --filter @aster-charts/benchmarks run budget` (all rows PASS). **`scripts/perf-docs.test.mjs` ties every figure below, and the sentences derived from them here, in `docs/API.md` and in the react README, to the ceilings in `budget-rows.mjs`: change a ceiling and the test names the doc that is stale.**

| Row (`budget-rows.mjs` name) | Import pattern | gzip kB (up front) | Up front + on demand (gzip kB) |
|---|---|---|---|
| `@aster-charts/core` | `import { renderSpec } from '@aster-charts/core'` | 187.9 |  |
| `@aster-charts/react useChart` | `import { useChart } from '@aster-charts/react'` | 154.4 | 296.6 |
| `@aster-charts/react Chart` | `import { Chart } from '@aster-charts/react'` | 190.6 | 327.9 |
| `@aster-charts/react SvgChart` | `import { SvgChart } from '@aster-charts/react/lite'` | 179.0 | 297.2 |
| `@aster-charts/react SvgChart + interaction` | `<SvgChart>` + `import { interaction } from '@aster-charts/react/interaction'` | 190.3 | 316.7 |
| `@aster-charts/react Chart + VL` | `import '@aster-charts/react/vl'` + `<Chart>` | 302.5 | 434.2 |
| `@aster-charts/react Chart + all` | `import '@aster-charts/react/all'` + `<Chart>` | 261.6 | 329.1 |
| `@aster-charts/react useChartWorker` | `import { useChartWorker } from '@aster-charts/react'` | 204.0 | 296.2 |
| `@aster-charts/react hydrateChart` | `import { hydrateChart } from '@aster-charts/react'` | 219.0 | 295.9 |
| `@aster-charts/react/ssr` | `import { renderChartToStaticMarkup, hydrateChart } from '@aster-charts/react/ssr'` | 210.6 | 272.2 |
| `+ @aster-charts/core/dom` | core + `@aster-charts/core/dom` (marginal) | 11.9 |  |
| `+ @aster-charts/core/canvas` | core + `@aster-charts/core/canvas` (marginal) | 6.2 |  |
| `+ @aster-charts/core/hit` | core + `@aster-charts/core/hit` (marginal) | 11.8 |  |
| `+ @aster-charts/core/signals` | core + `@aster-charts/core/signals` (marginal) | 15.4 |  |
| `+ @aster-charts/core/load` | core + `@aster-charts/core/load` (marginal) | 7.7 |  |
| `+ @aster-charts/core/geo` | core + `@aster-charts/core/geo` (marginal) | 15.9 |  |
| `+ @aster-charts/core/transforms` | core + `@aster-charts/core/transforms` (marginal) | 39.4 |  |
| `+ @aster-charts/core/transition` | core + `@aster-charts/core/transition` (marginal) | 3.7 |  |
| `+ @aster-charts/core/png` | core + `@aster-charts/core/png` (marginal) | 8.0 |  |

(The older figures in this chapter, dated 2026-11-06 and before, were measured by the concatenated method and are kept as the history
of what each change cost; compare them with the table above only after adding the per-file difference.)

The manifests list only the files that really have an import effect (see
[ARCHITECTURE.md](ARCHITECTURE.md#side-effects-and-tree-shaking)). Without a `sideEffects` field a bundler must assume
every module has effects, so `import { useChart }` pulled in `Chart`, `ChartStream`, `useChartStream`,
`useChartWorkerStream`, the worker host and `batches` (37.7 kB gzip it never calls); `ASTER_BUDGET_SIDE_EFFECTS=all
node packages/benchmarks/scripts/budget.mjs` bundles the apps that way, and `ASTER_BUDGET_SIDE_EFFECTS=none` as if no module had an effect (a
row built on a bare `import '...'` then measures nothing and fails).
`<Chart>` is a shell over `ChartCore` with injected capabilities; that costs a little code in both shells: the property
reads through the capability objects (a minifier cannot rename them) and the report of a missing capability, which only
`<SvgChart>` can trigger but both share. `<SvgChart>` is 11.6 kB smaller than `<Chart>` (190.6 minus 179.0): it leaves out the canvas
renderer, the hit index and the signal loop. Their marginal rows (6.2, 11.8 and 15.4 kB) are each measured on their own,
so they do not add up to the 11.6 kB gap. The rows that contain no such
code are checked on the module list, not only the byte count: `pnpm check:bundle` asserts on the esbuild metafile that the
`<SvgChart>` bundle reads no `core/canvas`, `core/hit` or `core/signals` module, and that with `interaction` it reads hit and
signals but still no canvas (`hit.ts` and `canvas.ts` share the path parser through `path-data.ts` for exactly this reason).

The `useChart` and `<Chart>` rows fail if the field is removed or widened; `scripts/bundle-shaking.test.mjs` plants
that fault, and the opposite one (an import shaken out), and requires the budget to fail. The other direction (a list that is too narrow drops a registration) is
caught by `pnpm check:bundle`, which bundles and executes each import pattern.

The Vega-Lite compiler is 106.3 kB gzip on top of the base `<Chart>` (296.9 minus 190.6, measured 2026-11-23; 54.1 at the end of October,
before the selections, maps and animation work).

## Dated measurement notes

Narrative that belongs to a measurement date rather than to the current numbers.

### Corrections to earlier figures

**Earlier figures for the 100,000-point SVG stream were wrong.** Previous versions of this document and of the
README, CHANGELOG and benchmarks README quoted about 77 ms per frame per-item and 16.7 ms with 0% long frames with
`denseMarks`. Those were measured on an unfilled render: the benchmark spec drew symbols without a `fill`, and before
the default-config fix Aster rendered such symbols unfilled (Vega draws them filled), so the benchmark measured an
empty paint layer. The benchmark spec now states its fill, and the numbers above are the filled render on this
machine. They were measured on the current stack. A report that the pre-audit baseline gives the same numbers once the fill is explicit has not been re-run.

From 2026-10-27 to 2026-11-04 the stream append had regressed to 0.7 ms at 100,000 points (every evaluation scanned the whole dataset for rows to wrap as `{data: v}`); #103 restored it.

The row-wise ratio of the differential-updates benchmark is lower than in earlier editions of this page because the full re-encode got cheaper: expressions read the signals in place since #101.

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

### Bundle size history

The rows of the table in [Bundle sizes](#bundle-sizes) move with every change; these are the dated notes of the changes that moved them,
kept as they were written. The figures in them are before and after pairs measured on the commits they name; today's sizes are the table's.

Transitions (the `transition` prop, [ANIMATION.md](ANIMATION.md)), measured 2026-11-09 with the same command against the tree
before them (which read 152.7, 163.9, 205.7, 182.8, 200.1 and 308.8 for the first six rows): `@aster-charts/core` 152.8, `useChart`
164.4, `<Chart>` 206.9, `<SvgChart>` 184.0, `<SvgChart>` + `interaction` 201.6, `<Chart>` + VL 310.2 kB gzip eager, and the
on-demand column of the React rows up by 3.4 kB (to 64.5 and 62.5): the animation module, a new marginal row
`core + @aster-charts/core/transition` of 3.1 kB that an app fetches only when a chart sets the prop. The eager growth is the
prop handling and the scene stamps (0.85 kB of `<Chart>`'s 1.2) and the chunk boundary the on-demand module draws around the
colour and field code it shares with core (0.35 kB; `useChart` pays only that). `budget.mjs` keeps the breakdown. With the `maxItems` limit and on top of the fit-view work
(the combined stack, measured 2026-11-09 with the same command): the transition module is 3.3 kB and `<Chart>` 207.4 kB gzip eager.

Signal-scoped reuse (the keys of marks and scales, the kept copies and the steps that read a dataset by name), measured
2026-11-10 with the same command against main at e31d61c (kB gzip, before -> after): `@aster-charts/core` 153.0 -> 154.5,
`useChart` 164.6 -> 166.1, `<Chart>` 207.4 -> 208.7, `<SvgChart>` 184.4 -> 185.8, `<SvgChart>` + `interaction` 202.0 -> 203.3,
`<Chart>` + VL 310.6 -> 312.1; the marginal rows did not move.

Selections under signal changes (kept dataset builds, marks keyed by the datasets they read by name, pulses with a signal change,
names read as the expression lexer reads them), measured 2026-11-10 with the same command against its base 082a700 (kB gzip,
before -> after): `@aster-charts/core` 154.5 -> 155.7, `useChart` 166.1 -> 167.4, `<Chart>` 208.7 -> 210.0, `<SvgChart>` 185.8 ->
187.1, `<SvgChart>` + `interaction` 203.3 -> 204.4, `<Chart>` + VL 312.1 -> 313.3; `+ @aster-charts/core/dom` 10.6 -> 10.7, the
other marginal rows did not move.

Parts on demand (the aggregating, window and reshaping transforms, time scales and formats, the curves besides `linear`, colour
ramps and blending, and the scale types besides linear, ordinal, band, point, time and utc, loaded by the shells in a browser build
the first time a chart needs them: [ARCHITECTURE.md](ARCHITECTURE.md#the-parts-of-the-engine-most-charts-never-run)), measured
2026-11-16 with the same command against origin/main at a078891 (kB gzip eager, before -> after): `useChart` 168.9 -> 145.0,
`<Chart>` 204.5 -> 180.5, `<SvgChart>` 190.7 -> 166.9, `<SvgChart>` + `interaction` 204.2 -> 180.2, `<Chart>` + VL 311.1 -> 287.0;
the families moved to the on-demand column (`<Chart>` 107.2 -> 137.1). `@aster-charts/core` 172.7 -> 174.7: its entry carries every
part, as before, and pays the slot reads and the part objects. A new row, `import '@aster-charts/react/all'` + `<Chart>`, is what an app
that wants no first-render wait pays: 246.4 kB gzip, every part of the engine up front (67.5 kB stay on demand: the add-ons and the
transition module).

Where the growth sits, measured 2026-11-06 on `@aster-charts/vl` alone (esbuild, minified, `@aster-charts/core` external): the bundle is 324,435 bytes minified and 105.8 kB gzip level 9, against 176,836 bytes and 55.6 kB for the tree of 2026-10-23 (commit 861eb0b). The largest increases are in `compile.ts` (+74.0 kB minified) and `validate.ts` (+19.1 kB). With the selection modules (`selection.ts`, `selection-signals.ts`, `selection-marks.ts`, `selection-model.ts`) replaced by stubs the bundle is 7.1 kB gzip smaller, with `geo.ts` stubbed 1.5 kB smaller and with `animation.ts` stubbed 0.8 kB smaller (9.2 kB for the three together), so those three feature modules are a minor part of the growth. The selection handling inside `compile.ts` is not part of that figure.

Trimming the validation layer
(`packages/vl/src/validate.ts`: allow-lists derived from one table each, shared message templates, dead branches removed;
no check dropped, every message unchanged) took `@aster-charts/vl` from 180,940 to 176,836 bytes minified (-4.1 kB) and from
55,828 to 55,606 bytes gzip level 9 (-0.2 kB): the validator is mostly unique error text, which gzip already compresses well.
Measure it with `node` and esbuild on `packages/vl/dist/index.js` (`@aster-charts/core` external, minify).
