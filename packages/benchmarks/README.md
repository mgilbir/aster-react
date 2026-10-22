# @aster/benchmarks

Performance comparison harness: our library (`@aster/react`) vs the two standard ways
to embed Vega in React.

| Approach | What it measures |
|---|---|
| `aster` | `<Chart>` from `@aster/react` — string rendering: full SVG re-serialized + re-parsed per update |
| `asterDom` | same `<Chart incremental>` — keeps the `<svg>` and patches only changed attributes (`patchSceneDom` in `@aster/core`) |
| `reactVega` | `react-vega` v8 `<VegaEmbed>` — the React wrapper from the vega org. Data updates deep-compare the spec and **re-embed** the view |
| `embedHook` | `vega-embed` in a `useEffect` following the official tutorials — incl. the documented incremental paths (`view.change()` for data, `view.width()/height()` for resize). This is Vega's best case |

All three are driven through the same React harness with the same specs (see
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
pnpm bench:incremental # streaming append + explicit pulse vs full evaluateChart
                      # (fails if the incremental path is not cheaper)
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
- `src/embeds.tsx` — the three embedding approaches behind one component interface
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
- `scripts/budget.mjs` — per-entry gzip gates for core, dom, canvas, hit, signals and React; used by CI

## Why the vega-embed hook wins updates (and what aster did about it)

Measured with `bench:pipeline` (compute only) + `bench:browser` (end to end),
bar chart @ 1000 points, before any fixes:

| stage per update | aster (string) | vega (embedHook) |
|---|---|---|
| spec work | compile ~0.02 ms (negligible) | 0 (parsed once at mount) |
| compute (dataflow / evaluate) | 5.5 ms — inflated by an O(n²) band-domain `distinctValues` | 3.4 ms |
| serialize | 1.5 ms string build | ~0 (renderer writes DOM directly) |
| DOM | **~10 ms full innerHTML re-parse of a 222 kB SVG** | ~5 ms attribute patching of existing nodes |

Vega's edge was never the dataflow — it was that updates **reuse the DOM nodes
it already created**. Aster re-ran the whole pipeline and threw away the entire
SVG tree every frame.

Fixes landed (all verified by 381/381 conformance, unchanged string output):
1. `distinctValues` O(n²) → Set-based (bar evaluate 5.5 → 1.8 ms).
2. `esc` memoization + integer fast path in `num` (string build ~20% faster).
3. `<Chart incremental>` / `patchSceneDom`: scene → descriptor tree → keyed
   in-place DOM patch (shared geometry with the string renderer, so the two
   paths cannot drift). Browser bar update 17.2 → ~9.4 ms (embedHook: 8.9),
   first render also improved (13.5 vs string 16.5), frame-pacing long-frames
   22.7% → 1.7%.

String mode is still the better default when *every* mark changes each update
(scatter-style churn): there, patching writes nearly all attributes anyway and
the browser's HTML parser is very good. `incremental` wins when the tree is
large and mostly stable (axes/legends/static styles — the common dashboard case).

## Streaming appends: aster vs a direct `vega.View`

`bench:browser-stream` now runs Vega's own streaming path on the identical spec
and row stream: `view.change('t', changeset().insert(rows)).run()` (and
`.runAsync()`), one append per animation frame, measured with the same
frame-pacing protocol as `<ChartStream>`. `bench:incremental` adds the
compute-only version (`renderer: 'none'`, so no paint is in the way) next to
aster's `stream.append`.

Headless Chromium, 1 append/frame for 3 s, 800×500 symbol chart, medians:

| points | backend | aster | vega `view.change` | note |
|---|---|---|---|---|
| 10k | SVG | 16.7 ms/frame, 0% long | 16.7 ms/frame, 2.3% long | both frame-bound; vega does ~240 DOM mutations per append vs ~1 for aster |
| 10k | canvas | 16.7 ms, 0% long | 16.7 ms, 0% long | frame-bound on both |
| 20k | SVG | 16.6 ms, 2% long | 31.6 ms, 100% long | crossover: vega leaves the frame budget |
| 50k | SVG | 44 ms, 95% long | 81 ms, 100% long | ~1.8x |
| 100k | SVG | 77 ms, 94% long | 170 ms, 100% long | ~2.2x; a single append on a 100k chart writes ~400k DOM attributes (≈4 per node) vs 1 for aster |
| 10k | SVG + `denseMarks` | **16.7 ms, 0% long** | 16.7 ms | 51 DOM nodes instead of 10,191 |
| 100k | SVG + `denseMarks` | **16.7 ms, 0% long** | 170 ms | ~400 DOM paths instead of 100k; `--dense=1` |
| 100k | canvas | 16.7 ms, 0% long | 16.7 ms (`run`) / 16.8 ms, 9.7% long (`runAsync`) | incremental append painting keeps both frame-bound |

The mutation column is the interesting part of the SVG result: Vega's
`view.change` sets the dataset's `modified` flag, so the SVG renderer re-walks
and re-writes the scene — the per-append mutation count grows with the dataset
(≈240 at 10k, ≈1.4k at 20k, ≈10k at 50k). Aster's append path writes only the
appended item, which is why its per-frame cost stays flat until SVG node cost
itself (not patching) becomes the limit.

Compute only (node, `renderer: 'none'`, 1 row/update): aster's stream append is
~13x cheaper than `view.change + run` at 10k (0.1 vs 1.0 ms) and ~62x at 100k
(0.2 vs 11.2 ms). The gap is the pulse: Vega inserts one tuple but still walks
the affected operators, while aster splices the mark items and patches the
domain census in O(appended).

Numbers are machine-dependent; the ratios and the shape (frame-bound below
~10k, paint-bound above ~50k for SVG) are what to compare.


## No-op re-renders (identical content)

`bench:browser`'s `stableRerenders` probe mounts a chart, then re-renders it with a
fresh spec object and the *same* data array. The gap was aster's largest
aster-specific regression (2.2–6.9 ms vs 0.1–0.2 ms for the Vega wrappers); two
causes were found and fixed:

1. `<Chart>` called `getChartInfo()` in an effect — a second `compileChart` +
   `evaluateChart` of the whole spec — and then `setState`, forcing an extra React
   pass. Interaction/a11y metadata now comes from the scene the session already
   returned (`chartInfoFromScene`), and the extra state/effect is gone.
2. `dangerouslySetInnerHTML` stayed in the props after the first commit (the memo
   held its cached string), and React re-applies a present `dangerouslySetInnerHTML`
   on every update — so every "incremental" no-op render was in fact re-parsing the
   whole SVG. The markup now leaves the props after the first commit; later updates
   patch the existing tree, and a scene whose DOM is already current is skipped
   entirely (SVG and canvas).

Result (line @ 1000 pts, headless Chromium, medians): stable re-render
2.0–2.4 ms → **0.3 ms**, DOM mutations 2 → **0**, first render 4.6–6.7 ms → 2.3–3.3 ms
(reactVega 3.2, embedHook 2.3). At 10k scatter points aster now mounts in 41–47 ms
vs 56–57 ms for both Vega paths.

## Why 100k-point SVG streams are still slow (and what would fix it)

The engine side is already O(appended): `flush()` costs 0.2–0.3 ms and the SVG
patcher was made to append-only too (the previous patch's descriptor array is
reused as an identity prefix, so only the new items are created instead of walking
100k siblings). The remaining ~77 ms/frame is the browser:

| raw DOM experiment (100k-node SVG, append 1 node/frame) | median frame |
|---|---|
| `<path d="…absolute…">` | ~45 ms |
| `<circle cx cy r>` | ~46 ms |
| `<path transform="translate(x,y)">` (what Vega emits for symbols) | ~145 ms |
| `<use x y href="#sym">` | ~207 ms |
| any of the above + `contain: layout paint` / `content-visibility: auto` | unchanged |

So per-item `transform` (and `<use>`) is what makes large SVG scenes expensive to
mutate, and no patcher-level change can go below the ~45 ms floor. Getting SVG
streams back on the frame budget needs fewer nodes:

- batch dense same-paint mark runs into one `<path>` (canvas already batches its
  draw calls) and hit-test through the scene index instead of DOM attributes;
- or emit absolute-coordinate `<circle>`/path items instead of per-item transforms.

Both intentionally diverge from Vega's SVG DOM (aster currently matches it
pixel- and string-for-string via the conformance corpus), so they should be
opt-in render modes with pixel-parity (not string-parity) gates.
