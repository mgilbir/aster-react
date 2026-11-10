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
- Huge or untrusted specs: combine `limits` with `useChartWorker`.
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
  evaluation keeps the rows of every step whose reads are as they were, republishing the signals it wrote. The React mount, which
  evaluates the spec at its own size and then at the measured container's, pays for the datasets once. Consecutive steps that
  only add fields (`bin`, `formula`, `timeunit`) write onto one set of rows instead of copying every row per step
  ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
- **Fit views update incrementally**: a view that fits its viewport (`autosize` fit / fit-x / fit-y, Vega-Lite
  `"container"` sizes, and every `<Chart>` sized by its measured container) builds its content twice, at the viewport
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
  same-paint symbol runs batch into one fill/stroke, and append-only streamed scenes paint just the new mark
  items.
- **Incremental scales**: continuous and discrete domains are reused when a changeset provably cannot move
  them; append-only continuous updates patch the min/max census in O(appended) instead of rescanning. A discrete
  scale over data (ordinal colour, shape, size, strokeDash; band; point) keeps its object when its rows change and its
  result does not: rows of categories it has appended or edited advance a census of the categories in O(changed), also
  after Vega-Lite's validity filter; any other change (a removal, a reorder, a sort by count or by an aggregate, several
  fields or datasets, `domainRaw`) reads the scale's settings again and keeps the scale when they are the same. The marks
  that read it then encode only the rows that changed. A new category, a category gone, or a sort order that moves makes
  the scale, and everything that reads it, again ([ARCHITECTURE.md](ARCHITECTURE.md#incremental-evaluation)).
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
load average 4 to 10. `node perf.mjs <worktree> 1`, a probe kept outside the repository: a 10,000-point symbol chart with two
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
rounds each, on the shared machine. `node tick.mjs <worktree>`, a probe kept outside the repository: a Vega-Lite `time`
animation over 3,000 points (`params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }]`, a
`filter` by it, `time: year` over three years), `createChartSession().evaluate(vg, { signals: { anim_clock } })` with only the
clock advanced by 16 ms per tick and no data change, 30 ticks, median and p90 ms per tick. The control is the fixed-size
one-row update of the section above (`node perf.mjs <worktree>`, its last run of three), which this change does not touch.

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
the signal-scoped reuse above), the two builds run alternately, three rounds each, on the shared machine. `node probe.mjs <worktree>`
and `node fit.mjs <worktree>`, probes kept outside the repository: Vega-Lite scatters of 5,000 points compiled by
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
| controls: fixed-size one-row update (`perf.mjs`, last run of three) | 0.58 / 0.57 / 0.57 | 0.60 / 0.56 / 0.56 | |
| controls: `time` animation tick (`tick.mjs`) | 0.91 / 0.92 / 0.91 | 0.90 / 0.91 / 0.91 | |
| controls: one-row stream append, 10,000 rows, no transforms (µs) | 68 / 70 / 68 | 69 / 69 / 70 | |
| one-row stream append through formula, formula, filter (µs) | 273 / 276 / 317 | 279 / 282 / 282 | |

A drag step costs what it did, a little more (17.2-17.4 ms before, 17.3-17.9 after: the keys of the store the points read are
made on every step, and the points are encoded again, as they must be). In headless Chromium (`node drag.mjs <worktree> brush|hover
5000`: `<Chart>` bundled from each worktree, 50 pointer moves, the time from a move to the second animation frame after it, which
counts whole frames), a brush drag went from 115.1 / 115.2 / 115.3 to 81.8 / 81.8 / 81.8 ms and a hover sweep from 97.8 / 104.5 /
98.1 to 64.4 / 64.6 / 64.3 ms median. `pnpm bench:incremental -- --points=10000 --reps=30`, three runs each, alternated: append
speedup vs a full evaluation 19.10x / 19.36x / 19.30x before, 16.86x / 19.09x / 19.06x after (floor 8x); a session's whole-array
replacement 15.42x / 15.08x / 15.13x before, 16.24x / 16.62x / 16.90x after; the stream append rounds to 0.1-0.2 ms in both.

### Discrete scales over changing rows (node, no DOM)

Measured 2026-11-10 on perf/discrete-scale-appends against its base (72ffeea, which holds #136-#138), the two builds run
alternately, three rounds each, load average 1.3 to 1.8. `node probe.mjs <worktree> 5000 20`, a probe kept outside the repository:
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
| line, a row of a category appended | 17.53 / 17.56 / 17.54 | 18.07 / 17.73 / 18.30 | the colour scale; no item (group marks are made again) |
| line, a value edited | 16.26 / 16.46 / 16.55 | 17.07 / 17.08 / 16.99 | the colour scale; no item |
| controls: fixed-size one-row update (`perf.mjs`) | 0.55 / 0.55 / 0.56 | 0.57 / 0.57 / 0.58 | |
| controls: `time` animation tick (`tick.mjs`) | 0.91 / 1.04 / 0.92 | 0.94 / 0.93 / 0.93 | 3000 of 3000 items, both |
| controls: point / brush, an unread signal (`sel.mjs`) | 0.44 / 0.44 / 0.46, 0.78 / 0.75 / 0.76 | 0.46 / 0.47 / 0.48, 0.79 / 0.77 / 0.75 | |

A new category costs what it did: every item is coloured again, as a fresh evaluation colours it. The line chart keeps its colour
scale but draws its lines in a group mark, which is made again on every evaluation, so its cost does not move (0.1 to 0.6 ms more in
these rounds; a CPU profile of 150 edits shows no new hot function, and a separate alternation measured 15.91 / 16.02 before and
16.27 / 16.11 ms after). `pnpm bench:incremental -- --points=10000 --reps=30`, three runs each, alternated: append speedup vs a full
evaluation 18.11x / 20.13x / 19.46x before, 19.23x / 19.50x / 19.53x after (floor 8x); a session's whole-array replacement
15.51x / 16.58x / 16.48x before, 14.74x / 14.29x / 14.76x after, whose session update measured alone (300 updates, alternated
three times) is 309 / 261 / 263 µs before and 261 / 262 / 262 µs after. `pnpm bench:browser-stream` held every floor before and
after (`<ChartStream>` on 10,000 points: 16.6 ms median frame before and 16.7 ms after, one mutation per append).

### Differential updates (node, no DOM)

`pnpm bench:differential` (50,000 points, about 1% of rows changed; `evaluateChart` with a changeset vs a full
re-encode): row-wise `formula` 22.6 to 1.0 ms (23.1x), fixed-scale symbol 19.2 to 0.5 ms (38.8x),
`aggregate` over 1000 groups 6.2 to 2.5 ms (2.5x). Scene evaluation plus `patchSceneDom` at 4000 points:
6.6x, 9.5x and 3.0x for the same three cases.

### Embedding: `<Chart>` vs react-vega and the vega-embed tutorial

`pnpm bench:runtime` (jsdom, relative timings only; median update ms, 1000 points): line aster 3.5 /
asterDom 2.9 / react-vega 6.1 / vega-embed hook 3.7; scatter 4.6 / 4.2 / 33.1 / 70.7; bar 13.4 / 13.8 / 86.5 /
62.4. DOM nodes for the scatter chart: 82 vs 1073.

`pnpm bench:browser -- --points=1000` (headless Chromium, median ms, first render / update):
line aster 2.65 / 2.55, asterDom 1.75 / 1.90, react-vega 2.90 / 3.45, vega-embed hook 2.40 / 2.60; scatter aster
2.90 / 3.45, asterDom 2.75 / 3.30, react-vega 8.20 / 7.90, vega-embed hook 7.05 / 8.35; bar aster 10.10 / 8.00,
asterDom 9.25 / 7.30, react-vega 15.50 / 16.75, vega-embed hook 14.90 / 8.30. Stable-content re-render (fresh spec
object, same data): 0 DOM mutations on all four; 0.3 ms for Aster vs 0.1 ms for the Vega wrappers. Under a
one-update-per-frame stream the line chart holds 16.7 ms median frames on all four; long frames (over 21 ms) are
0.0% for Aster, 1.7% to 3.7% for the Vega embeds. Run alternately against the 2026-10-27 build (2a03147), Aster's
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
(Aster SVG, microtask flush): per-item 161.2 ms median frame, 94.2% long, 100,030 DOM nodes, 18 to 19 appends in
3 s; with `denseMarks` 33.5 ms, 96.3% long, 402 DOM nodes, 82 to 84 appends. Dense marks cut the per-frame cost by
about 4.8x; neither SVG variant holds a 16.7 ms frame at 100,000 points, canvas does.

## Bundle sizes

`pnpm bench:bundle` (esbuild, minified, react external; every chunk counts, including the ones loaded on demand), measured
2026-11-06: `@aster-charts/react` `<Chart>` 264.0 kB gzip (711.5 kB minified, 222.9 kB brotli), `<SvgChart>` from `@aster-charts/react/lite`
243.2 kB gzip (656.5 kB minified, 206.5 kB brotli), `<SvgChart>` + `interaction` 258.4 kB gzip (695.4 kB minified,
218.8 kB brotli), vs react-vega 288.7 kB gzip (832.2 kB minified, 239.9 kB brotli) and the official vega-embed tutorial 288.0 kB
(830.5 kB minified, 239.6 kB brotli). The Aster rows are Vega only. The react-vega and vega-embed bundles include
Vega-Lite (about 731 kB of their source inputs), so the like-for-like comparison for a Vega-Lite app is `<Chart>` plus the
Vega-Lite compiler: 308.3 kB gzip eager plus 59.1 kB gzip loaded on demand (the `budget` rows below), 367.4 kB in all, which
is above react-vega's 288.7 kB. The smaller figure holds for Vega specs only.

`pnpm --filter @aster-charts/benchmarks run budget` bundles one tiny app per documented import pattern (esbuild, minify,
`NODE_ENV=production`, tree-shaking on, react external) and gates its gzip size (default level). The add-on rows are
MARGINAL: the add-on's gzip added to the `@aster-charts/core` app. The old rows measured each add-on standalone, which
double counted the code it shares with core (hit read 15.6 kB where an app pays about 5). Each budget is the measured
size plus 0.5 kB (`packages/benchmarks/scripts/budget.mjs` holds the rationale and the budgets, which are not copied
here); a change that needs more room edits the number in the same PR. These rows count the code a page loads eagerly: a
chunk loaded on demand is reported next to the row and is not in the gzip column. Measured 2026-11-06 with
`pnpm --filter @aster-charts/benchmarks run budget` (all rows PASS):

| Import pattern | gzip kB (eager) | Loaded on demand (gzip kB) |
|---|---|---|
| `import { renderSpec } from '@aster-charts/core'` | 152.5 | |
| `import { useChart } from '@aster-charts/react'` | 163.7 | 61.1 |
| `import { Chart } from '@aster-charts/react'` | 205.3 | 59.1 |
| `import { SvgChart } from '@aster-charts/react/lite'` | 182.5 | 61.1 |
| `<SvgChart>` + `import { interaction } from '@aster-charts/react/interaction'` | 199.7 | 59.1 |
| `import '@aster-charts/react/vl'` + `<Chart>` | 308.3 | 59.1 |
| core + `@aster-charts/core/dom` (marginal) | 10.6 | |
| core + `@aster-charts/core/canvas` (marginal) | 6.1 | |
| core + `@aster-charts/core/hit` (marginal) | 6.4 | |
| core + `@aster-charts/core/signals` (marginal) | 12.9 | |
| core + `@aster-charts/core/load` (marginal) | 5.4 | |
| core + `@aster-charts/core/geo` (marginal) | 16.0 | |
| core + `@aster-charts/core/transforms` (marginal) | 39.2 | |

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

The manifests list only the files that really have an import effect (see
[ARCHITECTURE.md](ARCHITECTURE.md#side-effects-and-tree-shaking)). Without a `sideEffects` field a bundler must assume
every module has effects, so `import { useChart }` pulled in `Chart`, `ChartStream`, `useChartStream`,
`useChartWorkerStream`, the worker host and `batches` (37.7 kB gzip it never calls); `ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1
node packages/benchmarks/scripts/budget.mjs`, run from `packages/benchmarks`, bundles the apps that way.
`<Chart>` is a shell over `ChartCore` with injected capabilities; that costs a little code in both shells: the property
reads through the capability objects (a minifier cannot rename them) and the report of a missing capability, which only
`<SvgChart>` can trigger but both share. `<SvgChart>` is 22.8 kB smaller than `<Chart>` (205.3 minus 182.5): it leaves out the canvas
renderer, the hit index and the signal loop. Their marginal rows (6.1, 6.4 and 12.9 kB) are each measured on their own,
so they do not add up to the 22.8 kB gap. The rows that contain no such
code are checked on the module list, not only the byte count: `pnpm check:bundle` asserts on the esbuild metafile that the
`<SvgChart>` bundle reads no `core/canvas`, `core/hit` or `core/signals` module, and that with `interaction` it reads hit and
signals but still no canvas (`hit.ts` and `canvas.ts` share the path parser through `path-data.ts` for exactly this reason).

The `useChart` and `<Chart>` rows fail if the field is removed or widened; `scripts/bundle-shaking.test.mjs` plants
that fault and requires the budget to fail. The other direction (a list that is too narrow drops a registration) is
caught by `pnpm check:bundle`, which bundles and executes each import pattern.

The Vega-Lite compiler is 103.0 kB gzip on top of the base `<Chart>` (308.3 minus 205.3, measured 2026-11-06). It was 54.1 at an earlier measurement, before the selections, maps and animation work.

Where the growth sits, measured 2026-11-06 on `@aster-charts/vl` alone (esbuild, minified, `@aster-charts/core` external): the bundle is 324,435 bytes minified and 105.8 kB gzip level 9, against 176,836 bytes and 55.6 kB for the tree of 2026-10-23 (commit 861eb0b). The largest increases are in `compile.ts` (+74.0 kB minified) and `validate.ts` (+19.1 kB). With the selection modules (`selection.ts`, `selection-signals.ts`, `selection-marks.ts`, `selection-model.ts`) replaced by stubs the bundle is 7.1 kB gzip smaller, with `geo.ts` stubbed 1.5 kB smaller and with `animation.ts` stubbed 0.8 kB smaller (9.2 kB for the three together), so those three feature modules are a minor part of the growth. The selection handling inside `compile.ts` is not part of that figure.

Trimming the validation layer
(`packages/vl/src/validate.ts`: allow-lists derived from one table each, shared message templates, dead branches removed;
no check dropped, every message unchanged) took `@aster-charts/vl` from 180,940 to 176,836 bytes minified (-4.1 kB) and from
55,828 to 55,606 bytes gzip level 9 (-0.2 kB): the validator is mostly unique error text, which gzip already compresses well.
Measure it with `node` and esbuild on `packages/vl/dist/index.js` (`@aster-charts/core` external, minify).

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
