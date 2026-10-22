# API

Aster ships three public packages:

| Package | Entry | Purpose |
|---|---|---|
| `@aster/core` | `@aster/core` | compile/evaluate/render a Vega spec to SVG |
| `@aster/core/…` | `/dom`, `/canvas`, `/hit`, `/signals`, `/load`, `/geo`, `/transforms` | opt-in addons (tree-shaking boundaries) |
| `@aster/react` | `@aster/react` | `<Chart>`, `useChart`, SSR/hydration, worker hook |
| `@aster/react/vl` | `@aster/react/vl` | opt-in addon: registers the Vega-Lite grammar compiler |
| `@aster/vl` | `@aster/vl` | from-scratch Vega-Lite → Vega compiler |

## `@aster/core`

```ts
import {
  renderSpec, compileChart, evaluateChart, renderSceneToSvg,
  getChartInfo, buildA11yTree,
} from '@aster/core'

const svg = renderSpec(vegaSpec, {
  width: 400,
  height: 300,
  data: { table: rows },
  signals: { shift: 10 },
  domainRaw: { x: [0, 25] },   // pan/zoom/brush domain override
  limits: { maxRows: 100_000, maxTimeMs: 2_000 },
  textMetrics: { measure: (text, font, size) => myFontEngine.measure(text, font, size) },
})
```

`compileChart(spec)` produces the `CompiledChart` IR; `evaluateChart(chart, input)`
resolves data/scales/encodes into a `SceneRoot`; `renderSceneToSvg(scene)` serializes
it. `createChartSession()` (from `@aster/core/dom`) caches the IR and scene across
updates, diffs replaced immutable source arrays automatically (`autoChanges`, default
on), supports explicit per-datum `dataChanges`, and exposes the source/transform pulse
via `session.pulse()`. `buildPulseGraph(chart)` / `propagatePulse(graph, sources)` expose
the same dataflow structure directly.

### Streaming and pulses

`diffRows(previous, next)` classifies a replacement snapshot: same-length changes return
the changed indices; length-changing updates also return `from` (new → old row index,
`-1` for an insert), `to` (old → new, `-1` for a delete) and the added/removed ranges.
Pass the long form as `dataPulse` (per source dataset) to `evaluateChart`/`session` when
you already know the delta; `dataChanges` remains the compact same-length form.

`createChartStream(spec, options)` wraps a session with a push-based, bounded queue:

```ts
import { createChartStream } from '@aster/core'

const stream = createChartStream(spec, {
  capacity: 32,              // queued BATCHES (default 32; coalesce always holds 1)
  maxQueuedRows: 5_000_000,  // queued ROWS (snapshot + appended), every policy
  policy: 'coalesce',        // 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error'
  limits: { maxItems: 50_000, maxRows: 1_000_000 }, // same budgets as the session
  initial: { signals: { theme: 'dark' } },
})

stream.push({ append: { table: rows } })       // append rows to the current snapshot
stream.push({ data: { table: snapshot } })     // replace a snapshot
stream.push({ signals: { brush: [1, 4] }, width: 800 })
stream.push({ append: { table: rows }, pulse: { table: explicitPulse } })

stream.pending()   // the DataPulse that flush() would deliver
const result = stream.flush()   // { scene, pulse, batches, noop } | null
stream.stats()     // { depth, capacity, queuedRows, maxQueuedRows, policy, coalesced, dropped, flushes }
stream.canAccept() // producer-side backpressure hint
stream.scene()     // last flushed SceneRoot (null before the first flush)
stream.discard()   // drop all queued batches (recovery after a failed flush)
stream.close()     // releases queue, rows, scene and session; later push -> false, flush -> null
```

An empty first `flush()` primes the scene from the spec/initial snapshot; later empty
flushes are no-ops. The React bindings are:

- `useChartStream(spec, options)` — local stream, `push`/`flush`/`pause`/`resume`/`close`,
  stats and pulse.
- `useChartWorkerStream(spec, options)` — worker-owned stream, local fallback, plus
  `accepted()`/`rejected()`/`depth()` backpressure counters.
- `<ChartStream spec={...}>` / `<ChartWorkerStream spec={...}>` — render the streamed
  scene through the same DOM patcher, canvas renderer, interaction and a11y tree as
  `<Chart>` (no per-flush SVG serialization).
- `handleChartWorkerStreamRequest(request, streams)` — the pure worker protocol.

**Batch order.** Queued batches fold in the order they were pushed, exactly as if
they had been applied one at a time. Within a batch the order is: `data` (snapshot),
then `append`, then `pulse`, then `signals`/`width`/`height`/`domainRaw`/`limits`/
`textMetrics` (later batches win; a `null` `domainRaw` entry clears that override).
This holds under every policy, so a coalesced snapshot-then-append keeps the appended
rows. An explicit `pulse` is cleared by a later snapshot of the same dataset (the
snapshot diff is authoritative). A same-length pulse followed by an append composes
into an append-only pulse that still carries the in-place `changed` indices. When
pulses cannot be composed (an inconsistent mapping, or in-place edits that a snapshot
diff could not see) the dataset is re-derived (`changedDatasets`, no pulse): correct,
just O(n). The stream passes the session its own complete change description and
disables the session's identity-based auto-diff, so a row edited in place is never
mistaken for unchanged.

**Backpressure bounds.** There are two bounds, both enforced on `push`:

- `capacity` bounds queued **batches** for `drop-oldest`/`drop-newest`/`error`.
  `coalesce` folds everything into one queued batch, so it always holds one
  (`stats().capacity` is `1`).
- `maxQueuedRows` bounds queued **rows** (snapshot rows plus appended rows waiting for
  a flush, across datasets) under every policy; it is what bounds `coalesce` memory.
  Default 5,000,000. A batch larger than the bound is always refused.

When a push would exceed a bound: `drop-newest` and `coalesce` reject it (`push` returns
`false`, counted in `stats().dropped`; `coalesce` never discards already queued data),
`drop-oldest` discards whole oldest batches until it fits, `error` throws
`AsterStreamBackpressureError` (`code: 'ASTER_STREAM_BACKPRESSURE'`, `bound:
'batches' | 'rows'`, `limit`). `canAccept()` is `true` only while both bounds have room
(always `true` for `drop-oldest`). A paused or slow consumer therefore cannot grow the
queue past `capacity` batches or `maxQueuedRows` rows. Rows already flushed belong to
the stream's base snapshot and are the host's data, not queue memory.

**Atomic flush.** `flush()` commits nothing until the evaluation succeeds. If it throws
(an expression error, a limit, a deadline), the queue, the committed base rows,
signals, size, `domainRaw`, limits, `textMetrics` and the stats are exactly as before the
call; the failed batches stay queued. Push a corrected batch (a snapshot replaces
earlier queued rows; `limits: {}` replaces the budget) and flush again.

**Recovering from a failed flush.** Because a failed flush keeps its batches queued,
every later flush fails the same way until they are removed. The error you get is the
original one (`AsterLimitError`, an expression error, ...), unchanged. Call
`getStreamFlushFailure(err)` to get `{ batches, queuedRows }` (what is still queued; the
queue is folded, so the failing batch cannot be isolated and all of it took part), then
`stream.discard()` to drop every queued batch. It returns how many were dropped and
counts them in `stats().dropped`; committed rows and the last scene are untouched.
Push fresh batches and flush again. Hosts that flush on a timer or microtask should call
`discard()` in their flush `catch` (and report the error) so one bad batch cannot wedge
the stream. Re-pushing a corrective snapshot also works, but only if you know to.

**Limits.** `options.limits` / `initial.limits` / a batch's `limits` are enforced on
every flush exactly as `createChartSession` enforces them (spec pre-flight, the
`maxTimeMs` clock, scene limits), and `maxRows` additionally counts the rows the
stream holds, which the session cannot see because they arrive via `input.data`.

**close().** Releases the queue, the base rows, the last scene and the session.
Afterwards `push` returns `false` (not counted as a drop), `flush` returns `null`,
`scene()`/`pulse()` are `null`, `canAccept()` is `false`, and `session()` throws
`AsterStreamClosedError` (`code: 'ASTER_STREAM_CLOSED'`). `close()` is idempotent.

`buildA11yTree(scene, scales, options)` returns positioned, captioned nodes for marks,
axes, legends, legend entries and titles. `<Chart>` projects them into focusable
elements; non-React hosts can do the same. Legend entries are keyboard toggles.

### Interaction addons

- `@aster/core/hit` — `buildHitIndex(scene)`, `query` and `queryMark` (guides excluded).
- `@aster/core/signals` — `bindSceneSignals(svg, scene, values, hooks)`, `stampDatumAttrs`.
- `@aster/core/dom` — `patchSceneDom`, `renderSceneToDomElement`, `createChartSession`.
- `@aster/core/canvas` — `renderSceneToCanvas(scene, ctx, { dpr })`.
- `@aster/core/load` — `loadSpecData(spec, { fetch })` for URL datasets.
- `@aster/core/geo`, `@aster/core/transforms` — register projections/rare transforms.

## `@aster/react`

### `<Chart>`

```tsx
import { Chart, type ChartHandle, type SelectValue, type ViewDomain } from '@aster/react'

const ref = useRef<ChartHandle>(null)
const [view, setView] = useState<ViewDomain | null>(null)
const [selection, setSelection] = useState<SelectValue | null>(null)

<Chart
  ref={ref}
  spec={vegaOrVegaLiteSpec}
  renderer="svg"                 // or "canvas"
  panZoom
  view={view}                    // omit for uncontrolled
  onViewChange={setView}
  selection={selection}          // { type: 'interval' | 'point', … }
  onSelectionChange={setSelection}
  onSelect={(interval) => {}}    // interval convenience callback
  onPointSelect={(datum) => {}}  // click convenience callback
  tooltip
  renderTooltip={(datum) => <b>{String(datum.v)}</b>}
  a11y={{ summaryThreshold: 150 }}
  limits={{ maxRows: 100_000, maxItems: 50_000, maxTimeMs: 2_000 }}
/>
```

`spec` may be a Vega spec, a Vega-Lite spec, or a promise (wrap the chart in
`<Suspense>`). Vega-Lite is an opt-in addon — import it once before rendering VL
specs:

```ts
import '@aster/react/vl'   // side effect: registers the from-scratch VL compiler
```

The base `@aster/react` entry does not include the ~23 kB gzip Vega-Lite compiler;
passing a VL spec without the addon throws an error naming the missing import.
Vega specs need no extra import. Worker hosts must import `@aster/react/vl` in the
worker entry as well, since compilation happens there.

The ref exposes `getScene()`, `getSvg()`, `getChartInfo()`, `getView()`, `setView()`,
`resetView()`, `setSignal(name, value)` and `getSignals()`.

`denseMarks` (SVG only) batches dense symbol marks into chunked `<path>` elements
instead of one element per datum: 100k points become ~400 paths, a 100k-point client
mount drops from ~620 ms to ~280 ms, and a 100k-point stream from ~79 ms to ~17 ms per
appended frame. Positions are baked into `d`, so the pixels match; tooltips, point
selection and the a11y tree resolve through the scene.

- `'auto'` (default) batches symbol marks with ≥512 items unless the spec has
  `signal.on` event streams (those read the datum from per-item DOM nodes).
- `true` always batches, `false` disables.
- Client-only mounts batch directly. SSR/hydrated pages emit the per-item markup on
  the server (so hydration matches) and switch to batched in place after hydration.
- Per-mark `data-datum` attributes are not emitted for batched chunks.

Pan/zoom is driven through scale `domainRaw`: wheel, drag (shift-drag when selection
is enabled), two-pointer pinch and the keyboard (`←/→/↑/↓`, `+`/`-`, `0`/`Home`,
`Escape`). The same scale rebuild moves marks and all guides, on SVG and canvas.

### Hooks

```tsx
const { scene, svg, error, session } = useChart(spec, { width, height })

// URL data, Suspense/use() path
const loaded = useSpecData(specWithUrls, { fetch })
const chart = useChartData(specWithUrls)

// optional worker offload (falls back to sync on SSR/jsdom)
const { svg, scene, error, pending } = useChartWorker(spec, { width, height })
```

### SSR + hydration

```tsx
// Server: full SVG in the streamed HTML
const html = renderToString(<Chart spec={spec} />)

// Non-React host: string + DOM-patcher hydration (keeps the server <svg> node)
const svg = renderChartToStaticMarkup(spec, { width, height })
hydrateChart(container, spec, { width, height })
```

### Accessibility keyboard contract

`Tab` enters the chart's accessible tree. Mark/guide nodes move with arrow keys,
`Home`/`End` jump to the ends, and `Enter`/`Space` selects a mark. Continuous axes are
exposed as sliders; their arrow keys pan that axis and `+`/`-` zoom. The chart
container itself handles pan/zoom when focused.

## `@aster/vl`

```ts
import { compile } from '@aster/vl'
const vegaSpec = compile(vegaLiteSpec)
```

`<Chart>` and `useChart` use this compiler for Vega-Lite input once
`@aster/react/vl` is imported, so a fresh app does not need a `vega-lite`
dependency. Hosts that already bundle `@aster/vl` themselves can instead call
`registerVegaLiteCompiler(compile)` from `@aster/react`; `hasVegaLiteCompiler()`
reports whether one is registered.
