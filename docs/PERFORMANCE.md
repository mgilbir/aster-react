# Performance

Aster keeps the differential engine from earlier phases and adds opt-in boundaries so
a chart pays only for the features it imports.

## What is fast

- **Session caching**: `createChartSession` fingerprints the spec skeleton, dataset
  identities, size, signals and `domainRaw`; identical inputs return the same scene.
  `<Chart>` derives its interaction/a11y metadata from that scene
  (`chartInfoFromScene`) instead of calling `getChartInfo`, which used to compile and
  evaluate a second time on every render. Combined with dropping the
  `dangerouslySetInnerHTML` prop after the first commit (React re-applies a present
  one, so a cached markup string made every no-op render re-parse the whole SVG), an
  identical-content re-render now costs ~0.3ms with zero DOM mutations (1k–10k
  points, measured in `pnpm bench:browser`; Vega's wrappers: 0.1–0.2ms).
- **Fixed-size charts**: when `autosize` is `none` (explicit width/height, the usual
  dashboard case) evaluation skips Vega's overflow-padding pass, which measures the
  recursive bounds of every top-level group. That walk was the dominant cost of a
  one-row update on a large chart: line @1k browser update 4.1 → 3.1ms, 5k full
  evaluate 1.5 → 1.2ms, 50k differential full re-encode 59 → 54ms, and a 100k
  same-length array replacement ~16 → ~10ms. Charts with `autosize: pad/fit` keep
  the full pass, and the 419-spec conformance corpus (which includes both) is
  byte-identical.
- **Auto-pulse inference**: `rowsEqual` compares plain rows with `for...in` instead
  of two `Object.keys` allocations per row (~1.5x faster on 100k rows), so replacing
  the whole data array stays cheap even without explicit `dataChanges`.
- **Per-datum updates**: sessions diff replaced immutable source arrays automatically
  (`autoChanges`), then re-encode only changed rows and reuse unchanged scene items;
  explicit `dataChanges` remains available for custom batching. The source/transform
  pulse is exposed through `session.pulse()`.
- **Length-changing pulses**: appends/inserts/deletes carry an old↔new row mapping and
  added/removed ranges. Row-wise, filter, fold/flatten, grouped (`aggregate`,
  `joinaggregate`, `window`, `stack`) and 1:1 geo/hierarchy operators propagate it;
  marks splice item arrays instead of re-encoding. `pnpm bench:incremental` reports
  the win (a 10k-point symbol chart appending one row is ~29x cheaper at the median
  than a full evaluate; 100k points ~216x). The benchmark runs in CI (10k/30 updates)
  and nightly (100k/40). Steady-state appends are O(appended + changed) for the
  common source→row-wise→mark path: the stream mutates its owned snapshot, the mark
  group appends items and unions cached bounds, and continuous domains patch their
  min/max census without rescanning. The benchmark also measures the DOM path:
  patching a persistent `<svg>` with `patchSceneDom` is measurably cheaper (~1.2–1.6x)
  than re-serializing the full SVG in jsdom (a browser shows a larger gap).
- **Streams**: `createChartStream` adds a bounded queue with
  coalesce/drop-oldest/drop-newest/error policies and explicit `flush()` pulses.
  `<ChartStream>`/`<ChartWorkerStream>` reuse the SVG patcher and canvas backend;
  canvas path parsing/symbol generation is cached, solid paints skip bbox
  computation, dense same-paint symbol runs batch into one fill/stroke, and
  append-only streamed scenes paint just the new mark items synchronously. In headless Chromium, a 10k-point stream at one append/frame holds
  ~16.7ms median frames with 0% long frames on both SVG and canvas; 100k points
  holds ~16.7ms on canvas (only the appended items are painted) while SVG is
  ~77ms per frame, the remaining scaling boundary. That SVG cost is browser-side:
  appending one node to a 100k-node SVG costs ~45ms/frame in headless Chromium even
  with no framework involved, and ~145ms when every item carries a
  `transform="translate(…)"` (which is how Vega — and therefore aster — emits
  symbols). `contain`/`content-visibility` do not help; the opt-in `denseMarks` mode
  does (fewer nodes, absolute coordinates — at the cost of SVG-DOM parity with Vega),
  bringing the same stream to ~16.7ms. The same benchmark now runs a
  direct Vega baseline on the identical spec/rows
  (`view.change('t', changeset().insert(rows)).run()`): at 100k points it needs
  ~170ms per frame on SVG (aster ~77ms, ~2.2x faster, ~17ms with `denseMarks`) and is frame-bound on canvas
  like aster; at 10k both are frame-bound, but Vega reports ~2.3% long frames and
  ~240 DOM mutations per append versus ~1 for aster. Compute only
  (`pnpm bench:incremental`, `renderer: 'none'`) aster's append is ~13x cheaper than
  `view.change` at 10k and ~62x at 100k, because Vega still walks the affected
  operators for a one-tuple insert while aster splices items and patches the
  domain census in O(appended).
- **Incremental scales**: continuous/discrete domains are reused when a changeset
  provably cannot move them; append-only continuous updates patch the min/max census
  in O(appended) instead of rescanning the dataset.
- **DOM patching**: the first render emits the full SVG for SSR; later updates patch
  attributes in place instead of re-parsing the tree. The mount commit skips the
  patcher (the browser just parsed that markup) and an append reuses the previous
  patch's descriptors as an identity prefix, so only the new items are created —
  an O(appended) SVG patch, not a re-walk of every sibling. Symbol descriptors are
  cached per mark group, so an append rebuilds only new/dirty entries
  (`patchSceneDom` at 100k: ~5.3 → ~3.8ms).
- **Dense marks (`denseMarks`, opt-in)**: dense symbol marks render as chunked
  `<path>` elements with the position baked into `d` instead of one transformed
  element per datum. At 100k points this turns 100k DOM nodes into ~400 and a
  one-append-per-frame SVG stream from ~79ms to **~16.7ms** (0% long frames),
  matching canvas. Chunks are bounded (~256 items) and cached per group, so an
  append re-serializes one chunk. Only opaque marks batch (translucency must
  composite per item); rotated marks keep their own element. Tooltips/hit-testing
  use the scene index; `pnpm conformance:batch` gates pixel parity against the
  per-item rendering.
- **No-op renders**: identical content is free all the way through — the session
  returns the cached scene, chart info/a11y derive from it, and the SVG/canvas
  effects skip the DOM/canvas when the scene object is unchanged.
- **Canvas**: full repaint is scheduled on `requestAnimationFrame` with DPR backing.
- **Workers**: `useChartWorker` moves compile/evaluate/render off the main thread and
  falls back to synchronous execution when workers are unavailable.

## Bundle gates

`packages/benchmarks/scripts/budget.mjs` gates each published entry independently:
core, dom, canvas, hit, signals and React. This prevents an addon import from silently
inflating the base bundle. Measured gzip sizes are recorded next to the budgets.

## Practical guidance

- Large static dashboards: keep `<Chart incremental>` (default) and pass stable spec
  objects. Memoize spec builders at the call site.
- Streaming updates: use `createChartStream` (bounded queue, coalesced appends) or
  supply `dataChanges` with the new immutable data array.
- Global fitters (`kde`/`regression`/`loess`/`wordcloud`/`contour`) re-derive on an
  append; the downstream change result is still correct.
- Huge or untrusted specs: combine `limits` with `useChartWorker`.
- Dense marks: canvas avoids SVG node cost; hit testing uses a uniform grid above 400
  items.
- Accessibility tree: set `a11y={{ summaryThreshold: N }}` (default 150) to collapse
  very dense marks into one summary node.
