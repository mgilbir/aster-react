# @aster/benchmarks

Performance comparison harness: our library (`@aster/react`) vs the two standard ways
to embed Vega in React.

| Approach | What it measures |
|---|---|
| `aster` | `<Chart>` from `@aster/react` with `incremental={false}`: the full SVG is re-serialized and re-parsed per update |
| `asterDom` | same `<Chart incremental>` — keeps the `<svg>` and patches only changed attributes (`patchSceneDom` in `@aster/core`) |
| `reactVega` | `react-vega` v8 `<VegaEmbed>` — the React wrapper from the vega org. Data updates deep-compare the spec and **re-embed** the view |
| `embedHook` | `vega-embed` in a `useEffect` following the official tutorials — incl. the documented incremental paths (`view.change()` for data, `view.width()/height()` for resize). This is Vega's best case |

All four are driven through the same React harness with the same specs (see
`src/fixtures.ts`, same shapes as the conformance corpus) and the same DOM-quiescence
measurement protocol (`src/settle.ts`: the operation is complete when, after the first
DOM mutation, no further mutations occur for a few consecutive frames).

## Running

Requires a built workspace: run `pnpm build` at the repo root first
(all runners check and fail with a hint otherwise).

```bash
pnpm bench            # everything
pnpm bench:runtime    # jsdom: mount / update / resize latency, DOM node counts
pnpm bench:memory     # node --expose-gc: heap retained per mount/unmount & update cycle
pnpm bench:bundle     # esbuild: min/gzip/brotli payload per approach (react external)
pnpm bench:browser    # Playwright headless Chromium: time-to-first-render, update
                      # latency, frame pacing, prop + container resize, CDP heap
pnpm bench:pipeline   # per-stage compute breakdown: aster compile/evaluate/serialize
                      # vs vega parse/dataflow/toSVG (no DOM in the way)
pnpm bench:incremental # streaming append / whole-array replace / DOM patch vs their baselines;
                      # fails below measured floors (see the header of src/incremental.bench.tsx)
pnpm bench:differential # changed-set update vs full re-encode (scene eval and DOM patch)
pnpm --filter @aster/benchmarks run budget  # per-import-pattern gzip budgets (addons as marginal cost); refuses a stale dist
pnpm bench:browser-stream # per-frame append: aster <ChartStream> vs vega view.change
                      # SVG/canvas, microtask/raf and run/runAsync
                      # flush policies, long frames + DOM mutations
```

Knobs (all runners): `--points=1000` (dataset size), `--reps=…`, `--kind=line,scatter,bar`
(runtime/browser), `--cycles=…` (memory), `--seconds=3` (browser frame pacing),
`--dense=0,1` (streaming: aster SVG with `denseMarks` batching on/off).
The browser runner needs a Chromium for Playwright (`npx playwright install chromium`).

## Interpreting

- **jsdom timings are relative** — same protocol for every embed, but jsdom parses
  HTML strings and patches DOM much slower than a browser; trust the browser runner
  for absolute and near-tie numbers. jsdom is still useful in CI (no browser needed).
- **Frame pacing** streams one data update per animation frame; the interesting column
  is `% long frames (>21ms)` — dropped frames a user would feel. The streaming runner
  puts aster and Vega on the *same* spec and rows, so the `engine`/`flush` columns are
  directly comparable: `aster` flushes on a microtask or in `requestAnimationFrame`,
  `vega` calls the documented `view.change('t', changeset().insert(rows))` and then
  `.run()` (synchronous) or `.runAsync()` (deferred). `mut/append` counts DOM mutations
  per appended row — it separates "cheap for the engine" from "cheap because it stopped
  touching the DOM" (canvas has no DOM mutations at all on either side).
- **Container resize** changes the host's CSS width and times how long the chart svg
  takes to follow: `aster` has a built-in `ResizeObserver`; the Vega paths only react
  because the harness wires the documented `ResizeObserver` + view-API glue, which
  costs an extra `runAsync` round trip.
- **Update latency for the vega baselines differs by shape**: `embedHook` gets true
  incremental dataflow updates, `reactVega` pays a full re-embed whenever data changes.
- **Retained heap** runs 5x (mount -> 30 updates -> unmount) with a forced GC (CDP
  `HeapProfiler.collectGarbage`) before sampling; a few hundred kB is noise, MB-scale
  growth after unmount is a leak signal.

## Files

- `src/fixtures.ts` — seeded data + spec builders (line/bar/scatter, v6 shapes)
- `src/embeds.tsx` — the four embedding approaches behind one component interface
- `src/settle.ts` — shared DOM-quiescence protocol / measurement primitives
- `src/runtime.bench.tsx`, `src/memory.bench.tsx` — jsdom runners
- `src/incremental.bench.tsx` — `createChartStream` append vs full re-evaluate, plus a
  compute-only (`renderer: 'none'`) Vega `view.change` baseline for the same workload
  (`--vega=0` disables it)
- `src/browser-stream-entry.tsx` — in-page frame-pacing driver for `<ChartStream>` and a
  plain `vega.View`
- `src/browser-entry.ts` — `window.__bench` API bundled into the browser page
- `scripts/browser.bench.mjs` — esbuild + Playwright + CDP driver
- `scripts/bundle-size.mjs` — per-approach payload table
- `scripts/budget.mjs` — per-import-pattern gzip gates (core `renderSpec`, `useChart`, `<Chart>`, `<Chart>` + VL, and dom/canvas/hit/signals/load/geo/transforms as marginal cost on top of core); part of `pnpm check`. `ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1` bundles as if the manifests had no `sideEffects` field, and the `useChart`/`<Chart>` rows must then fail. It compares each `dist` file with its source and exits if one is missing or older, so it never measures a stale build

## Results

Measured numbers, with the command and date that produced each, are in
[docs/PERFORMANCE.md](../../docs/PERFORMANCE.md#reference-measurements). They are not repeated here: the benchmark
harness is the stable thing, the numbers belong to a machine and a commit.

Two results are worth knowing how to read:

- **Streaming appends.** `bench:browser-stream` runs Vega's own streaming path
  (`view.change('t', changeset().insert(rows)).run()` / `.runAsync()`) and `<ChartStream>` on the identical spec and
  rows, one append per animation frame. Vega's `view.change` sets the dataset's `modified` flag, so its SVG renderer
  re-walks and re-writes the scene and the mutation count per append grows with the dataset; aster's append path writes
  only the appended item. At large sizes SVG is bound by the browser's cost of mutating a very large node tree (and
  most of all per-item `transform` attributes), not by the engine; that is why `denseMarks` batches dense symbol marks
  into a few hundred `<path>` elements and why canvas stays frame-bound. `--dense=0,1` compares aster SVG with
  batching off and on.
- **Compute only.** `bench:incremental` runs the same append workload through Vega with `renderer: 'none'` so no paint
  is in the way: the gap is the pulse. Vega inserts one tuple but still walks the affected operators, while aster
  splices the mark items and patches the domain census in O(appended).

String mode (`incremental={false}`) is still the better default when every mark changes on each update (scatter-style
churn): patching then writes nearly all attributes anyway and the browser's HTML parser is very good. Incremental
patching wins when the tree is large and mostly stable (axes, legends, static styles), the common dashboard case.
