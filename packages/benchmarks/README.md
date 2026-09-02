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
```

Knobs (all runners): `--points=1000` (dataset size), `--reps=…`, `--kind=line,scatter,bar`
(runtime/browser), `--cycles=…` (memory), `--seconds=3` (browser frame pacing).
The browser runner needs a Chromium for Playwright (`npx playwright install chromium`).

## Interpreting

- **jsdom timings are relative** — same protocol for every embed, but jsdom parses
  HTML strings and patches DOM much slower than a browser; trust the browser runner
  for absolute and near-tie numbers. jsdom is still useful in CI (no browser needed).
- **Frame pacing** streams one data update per animation frame; the interesting column
  is `% long frames (>21ms)` — dropped frames a user would feel.
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
- `src/browser-entry.ts` — `window.__bench` API bundled into the browser page
- `scripts/browser.bench.mjs` — esbuild + Playwright + CDP driver
- `scripts/bundle-size.mjs` — per-approach payload table
- `scripts/budget.mjs` — (existing) `@aster/core` gzip budget gate used by CI

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
