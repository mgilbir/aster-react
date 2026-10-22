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
  capacity: 32,              // queued batches (default 32; coalesce keeps 1)
  policy: 'coalesce',        // 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error'
  initial: { signals: { theme: 'dark' } },
})

stream.push({ append: { table: rows } })       // append rows to the current snapshot
stream.push({ data: { table: snapshot } })     // replace a snapshot
stream.push({ signals: { brush: [1, 4] }, width: 800 })
stream.push({ append: { table: rows }, pulse: { table: explicitPulse } })

stream.pending()   // the DataPulse that flush() would deliver
const result = stream.flush()   // { scene, pulse, batches, noop } | null
stream.stats()     // { depth, capacity, policy, coalesced, dropped, flushes }
stream.canAccept() // producer-side backpressure hint
stream.scene()     // last flushed SceneRoot (null before the first flush)
stream.close()
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

`policy: 'coalesce'` merges queued appends/snapshots so a slow consumer sees one pulse
for the latest state; `drop-oldest`/`drop-newest` bound the queue by discarding whole
batches; `error` throws `AsterStreamBackpressureError`. Explicit `pulse` values are
composed across coalesced batches when possible and otherwise fall back to a snapshot
diff (still correct, just O(n)).

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
