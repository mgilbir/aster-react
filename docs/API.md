# API

Aster ships three public packages:

| Package | Entry | Purpose |
|---|---|---|
| `@aster/core` | `@aster/core` | compile/evaluate/render a Vega spec to SVG; limits, streams, a11y tree |
| `@aster/core/…` | `/dom`, `/canvas`, `/hit`, `/signals`, `/load`, `/geo`, `/transforms` | opt-in addons (tree-shaking boundaries) |
| `@aster/react` | `@aster/react` | `<Chart>`, `useChart`, streams, SSR/hydration, worker hooks |
| `@aster/react/…` | `/vl`, `/worker`, `/worker-entry`, `/ssr` | `/vl` registers the Vega-Lite compiler; `/worker` has the worker registries and protocol; `/worker-entry` is a ready worker script; `/ssr` is the string/hydration pair |
| `@aster/vl` | `@aster/vl` | from-scratch Vega-Lite → Vega compiler |

`@aster/core` takes Vega specs only. Vega-Lite goes through `@aster/vl` (or `@aster/react/vl`).

## `@aster/core`

```ts
import { renderSpec, type VgSpec } from '@aster/core'

const vegaSpec: VgSpec = {
  width: 400,
  height: 300,
  data: [{ name: 'table', values: [{ x: 1 }, { x: 2 }] }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width' }],
  marks: [{
    type: 'symbol',
    from: { data: 'table' },
    encode: { enter: { x: { scale: 'x', field: 'x' }, y: { signal: 'shift' }, fill: { value: 'steelblue' } } },
  }],
  signals: [{ name: 'shift', value: 0 }],
}
const rows = [{ x: 1 }, { x: 5 }, { x: 25 }]
const myFontEngine = { measure: (text: string, _font: string, size: number): number => text.length * size * 0.6 }
const report = (...a: unknown[]): void => { console.log(a.length) }

const svg = renderSpec(vegaSpec, {
  width: 400,
  height: 300,
  data: { table: rows },        // Record<string, unknown[]>: dataset name -> rows
  signals: { shift: 10 },
  domainRaw: { x: [0, 25] },    // pan/zoom/brush domain override, by scale name
  limits: { maxRows: 100_000, maxTimeMs: 2_000 },
  textMetrics: { measure: (text, font, size) => myFontEngine.measure(text, font, size) },
  logger: { error: (...a) => report(a), warn: (...a) => report(a) },  // vega-shaped; default: console
})
console.log(svg.startsWith('<svg'))
```

`RuntimeInput` (the second argument of `renderSpec`, `evaluateChart` and the session) has these fields: `limits`,
`urlPolicy`, `logger`, `textMetrics`, `data`, `width`, `height`, `signals`, `containerSize`, `measuredSize`, `changedDatasets`,
`dataChanges`, `dataPulse`, `autoChanges`, `domainRaw`. `data` is a `Record<string, unknown[]>` keyed by dataset
name; it overrides or supplies the rows of the spec dataset of that name.

`logger` (`RuntimeInput.logger`, type `Logger`) is where the engine reports an error it recovers from, as vega's
dataflow does: an expression that throws while a chart is evaluated (a conditional-encode test, an encode signal, a
filter or formula, a sort, a scale that cannot be built) is logged and the render carries on with what it has. See
`docs/ERRORS.md` for exactly what survives each failure.

`limits` are described in `docs/LIMITS.md`, including which entry point enforces which budget.

`compileChart(spec)` produces the `CompiledChart` IR; `evaluateChart(chart, input)` resolves data/scales/encodes into
a `SceneRoot`; `renderSceneToSvg(scene)` serializes it; `getChartInfo(spec, input)` returns the size, padding and
scales (`ChartInfo`) of the evaluated scene (`chartInfoFromScene(scene)` reads the same from a scene you already
have). `renderSpec` is those steps plus the limit checks.

### Sessions and per-datum updates

`createChartSession()` (from `@aster/core/dom`, also re-exported by `@aster/react`) caches the IR and the scene across
updates. An evaluation with the same spec content, data array identities, size, signals and limits returns the *same*
`SceneRoot`. Replaced immutable source arrays are diffed automatically (`autoChanges`, default on; set it to `false`
to force a full re-encode), explicit per-datum `dataChanges` are supported, and the source/transform pulse of the last
evaluation is `session.pulse()`. `session.change(input)` re-evaluates the chart compiled by the last `evaluate`
without passing the spec again. `buildPulseGraph(chart)` / `propagatePulse(graph, sources)` expose the dataflow
structure directly.

`dataChanges` is `Record<string, number[]>`: per dataset, the indices (into the NEW row array) whose values changed.
It is only valid when the array keeps its length and order; the session then reuses the previous scene items of every
other row. Mutating an array in place without replacing it, and without `dataChanges`, is invisible to the cache.

```ts
import { createChartSession } from '@aster/core/dom'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'table' }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width' }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'x' }, width: { value: 4 }, height: { value: 4 } } } }],
}

const session = createChartSession()
const rows = [{ x: 1 }, { x: 2 }]
const first = session.evaluate(spec, { data: { table: rows } })
console.log(session.evaluate(spec, { data: { table: rows } }) === first) // true: same inputs, same scene

// A new array of the same length: diffed automatically, only row 1 is re-encoded.
const second = session.evaluate(spec, { data: { table: [{ x: 1 }, { x: 3 }] } })
console.log(second === first, session.pulse()?.datasets.get('table')?.changed) // false [ 1 ]

// An append is an append-only pulse (existing rows keep their index).
session.evaluate(spec, { data: { table: [{ x: 1 }, { x: 3 }, { x: 9 }] } })
console.log(session.pulse()?.datasets.get('table')?.appendOnly) // true

// You already know what changed: say so.
session.change({ data: { table: [{ x: 1 }, { x: 4 }, { x: 9 }] }, dataChanges: { table: [1] } })
```

### Custom expression functions

`registerExpressionFunction(name, fn)` is the counterpart of vega's `expressionFunction(name, fn)`: expressions
(`{signal: ...}`, filters, formulas, encodes) may then call `name(...)`. It is how Vega-Lite's custom `formatType`
works: with `config.customFormatTypes: true`, `{"formatType": "price", "format": "$.2f"}` compiles (`@aster/vl`, as
vega-lite) to `price(datum["v"], "$.2f")` for text, tooltip, href and description channels and to a
`price(datum.value, "$.2f")` label encode for axes and legends. Register `price` before rendering, in vega too if
you compare the two:

```ts
import { registerExpressionFunction, renderSpec, type VgSpec } from '@aster/core'

const myFormatter = (format: string) => (value: number): string => `${format}:${value}`
const off = registerExpressionFunction('price', (value: number, format: string) => myFormatter(format)(value))

const spec: VgSpec = {
  width: 100,
  height: 20,
  marks: [{ type: 'text', encode: { enter: { text: { signal: 'price(12.5, "$.2f")' } } } }],
}
console.log(renderSpec(spec).includes('$.2f:12.5')) // true
off() // removes it
```

`registerExpressionFunction` returns the function that removes the registration (restoring the one it replaced).
As in vega's code generator, a call to a name that is not a function of the current context is refused when the
expression is compiled, with `ExpressionParseError("Unrecognized function: <name>")`, not when the call is first
evaluated (the built-ins, the registered functions, `if` and the event functions `x`, `y`, `xy`, `item`, `group`,
`view` are known). The check follows the registry: removing a registration (or replacing it) makes expressions
compiled earlier re-validate the next time they run, so a call to a function you removed throws the same error
instead of calling a stale closure, and a replaced function is called in its new form.
The registry is global, as vega's is. A registered function is host code: the engine does not sandbox or meter it,
and a spec decides its arguments, so register only functions that are safe for any arguments a spec you render can
produce. A name that is not a plain identifier, or that an expression already means something by (a built-in
function, a constant, `datum`, `event`, ...), or that starts with `_`, is refused with an `[aster]` error. A custom
`formatType` that is not registered fails like any unknown expression function. Without `customFormatTypes: true`
vega-lite drops a custom `formatType` and its `format` from field definitions, axes and legends (a facet header keeps
its own), and so does `@aster/vl`.

### Streaming and pulses

`diffRows(previous, next)` classifies a replacement snapshot: same-length changes return
the changed indices; length-changing updates also return `from` (new → old row index,
`-1` for an insert), `to` (old → new, `-1` for a delete) and the added/removed ranges.
Pass the long form as `dataPulse` (per source dataset) to `evaluateChart`/`session` when
you already know the delta; `dataChanges` remains the compact same-length form (when both name
a dataset, `dataPulse` wins for it).

`createChartStream(spec, options)` wraps a session with a push-based, bounded queue:

```ts
import { createChartStream, type VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', values: [{ x: 1 }] }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width' }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'x' }, width: { value: 4 }, height: { value: 4 } } } }],
  signals: [{ name: 'theme', value: 'light' }, { name: 'brush', value: null }],
}
const rows = [{ x: 2 }, { x: 3 }]
const snapshot = [{ x: 1 }, { x: 2 }, { x: 3 }]
const explicitPulse = { changed: [], appendOnly: true, baseLength: 3, added: [[3, 5] as [number, number]] }

const stream = createChartStream(spec, {
  capacity: 32,              // queued BATCHES (default 32; coalesce always holds 1)
  maxQueuedRows: 5_000_000,  // queued ROWS (snapshot + appended), every policy (default 5,000,000)
  policy: 'coalesce',        // 'coalesce' (default) | 'drop-oldest' | 'drop-newest' | 'error'
  limits: { maxItems: 50_000, maxRows: 1_000_000 }, // same budgets as the session
  initial: { signals: { theme: 'dark' } },
})

stream.push({ append: { table: rows } })       // append rows to the current snapshot
stream.push({ data: { table: snapshot } })     // replace a snapshot
stream.push({ signals: { brush: [1, 4] }, width: 800 })
stream.push({ append: { table: [{ x: 4 }, { x: 5 }] }, pulse: { table: explicitPulse } })

console.log([...stream.pending().structural]) // pending(): the DataPulse that flush() would deliver
const result = stream.flush()   // { scene, pulse, batches, noop } | null
console.log(result?.batches)    // 1: coalesce folded the four pushes into one batch
console.log(stream.stats())     // { depth, capacity, queuedRows, maxQueuedRows, policy, coalesced, dropped, flushes }
console.log(stream.canAccept()) // producer-side backpressure hint
console.log(stream.scene() === result?.scene) // last flushed SceneRoot (null before the first flush)
console.log(stream.discard())   // drop all queued batches (recovery after a failed flush); returns how many
stream.close()                  // releases queue, rows, scene and session; later push -> false, flush -> null
```

`push(batch)` copies the `append` arrays it is given (the caller may reuse them), returns `true` when the batch was
queued and `false` when the policy rejected it, and throws only for `policy: 'error'`
(`AsterStreamBackpressureError`) or a malformed batch (`TypeError`). An appended list of any length is fine: rows are
moved into the stream's base array with a loop at flush time, never by spreading them into a call, so a very large
`append` cannot hit the engine's call-argument limit. `StreamBatch` fields: `data`, `append`, `pulse`, `signals`,
`width`, `height`, `domainRaw`, `limits`, `textMetrics`. `initial.urlPolicy` is fixed for the stream's life.

An empty first `flush()` primes the scene from the spec/initial snapshot; later empty
flushes are no-ops. The React bindings are:

- `useChartStream(spec, options)` — local stream, `push`/`flush`/`pause`/`resume`/`close`,
  stats and pulse; `options` are the stream options plus `serialize`, `autoFlush` and `flushPolicy`.
- `useChartWorkerStream(spec, options)` — worker-owned stream, local fallback, plus
  `accepted()`/`rejected()`/`depth()` backpressure counters.
- `<ChartStream spec={...}>` / `<ChartWorkerStream spec={...}>` — render the streamed
  scene through the same DOM patcher, canvas renderer, interaction and a11y tree as
  `<Chart>` (no per-flush SVG serialization). See "Streaming components" below.
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
the stream. Re-pushing a corrective snapshot also works, but only if you know to. The React
hooks and components do this discard themselves and expose `flushFailure`.

**Limits.** `options.limits` / `initial.limits` / a batch's `limits` are enforced on
every flush exactly as `createChartSession` enforces them (spec pre-flight, the
`maxTimeMs` clock, scene limits), and `maxRows` additionally counts the rows the
stream holds, which the session cannot see because they arrive via `input.data`.

**close().** Releases the queue, the base rows, the last scene and the session.
Afterwards `push` returns `false` (not counted as a drop), `flush` returns `null`,
`scene()`/`pulse()` are `null`, `canAccept()` is `false`, and `session()` throws
`AsterStreamClosedError` (`code: 'ASTER_STREAM_CLOSED'`). `close()` is idempotent.

### Accessibility tree

`buildA11yTree(scene, scales, options)` returns positioned, captioned nodes (`A11yNode`) for marks,
axes, legends, legend entries and titles. A mark with more than `summaryThreshold` items (default 150) collapses to a
single summary node, and the tree carries a `summary` caption when the scene's mark items in total exceed it. `A11yOptions` are `label`,
`description`, `summaryThreshold`, `isSelected` and `isLegendEntryHidden`. `<Chart>` projects the nodes into
focusable elements; non-React hosts can do the same. The keyboard contract is in `docs/INTERACTION.md`.

### Interaction addons

- `@aster/core/hit` — `buildHitIndex(scene)` returns `{ query(x, y), queryMark(x, y), size() }`; `queryMark` returns
  data-bearing mark items only (guides excluded), `query` returns anything painted. Both give a `HitTarget`
  (`{ item, marktype }`) or `null`.
- `@aster/core/signals` — `bindSceneSignals(svg, scene, values, hooks, { pick })`, `stampDatumAttrs`.
  Binds every `signal.on` entry with vega's event-stream semantics: selector strings (`[mousedown, mouseup] > mousemove`,
  `@name:click`, `symbol:click`, `window:keydown`, `click[event.shiftKey]{100}`, `mousedown!`), object-form `events`, arrays,
  `{signal}` sources, `between`, filters, throttle, debounce, `consume` and `force`. `event` is the native event extended with
  `item`, `vega` and `dataflow`, so `event.deltaY`, `event.shiftKey`, `x()`, `y()`, `item()` and `group()` behave as in vega;
  `datum` is `event.item.datum`. A handler runs only when its stream matched; a signal's `update` re-runs only when a signal
  it reads changed. It returns `{ detach(), setSignal(name, value) }`.
  - `hooks.onSignal(name, value, all)` — once per signal that changed while an event was processed.
  - `hooks.onData(name, rows)` — once per dataset that `modify(...)` edited (a Vega-Lite selection's `<name>_store`), with
    its input rows. The host passes them back as `data[name]` to the next evaluation and as `{ data }` to the next
    `bindSceneSignals`, so the dataset is an input like any other (`<Chart>` does this itself). The expression functions
    `vlSelectionTest`, `vlSelectionIdTest`, `vlSelectionResolve`, `vlSelectionTuples`, `modify`, `isTuple`, `panLinear` /
    `panLog` / `panPow` / `panSymlog`, `zoomLinear` / `zoomLog` / `zoomPow` / `zoomSymlog` are part of the expression
    language (vega-selections 6.1.4, vega-functions, vega-util); `{scale}` event sources fire when a scale changed
    between two bindings.
  - Group scopes: a group mark's `signals` (`SceneGroup.scopeSignals`) are read and written per group item; `onSignal` and
    `setSignal` name them `<scope id>:<name>` (the id is `scopeSignals.id`), and the store holds them under that key:
    see [INTERACTION.md](INTERACTION.md#group-scopes).
  - `hooks.logger` — where bind-time errors (a malformed selector or expression: the handler is skipped) and run-time errors
    (an expression that throws while an event is handled: that event's delivery stops, earlier updates stand) are reported;
    default: the console. Nothing escapes the DOM listener.
  - `hooks.preventDefault` — vega's `view.preventDefault()` (default `false`): whether events of the chart's own surface are
    prevented when `config.events.defaults` names neither `prevent` nor `allow`. The config decides first (vega's default is
    `{allow: ['wheel']}`, so every listened view event but `wheel` is prevented); a `consume`d stream always prevents.
  - `{ pick }` — `(x, y) => HitTarget | null`, e.g. `buildHitIndex(scene).query`: resolves `event.item` (mark type, name, role,
    datum, enclosing group). Without it, or when it finds nothing, the item is read from the DOM (`data-datum` stamps and
    `mark-*`/`role-*` classes), where mark names are not available. `<Chart>` passes its own hit index.
- `@aster/core/dom` — `patchSceneDom`, `renderSceneToDomElement`, `createChartSession`, `hasDenseSymbolMarks`.
- `@aster/core/canvas` — `renderSceneToCanvas(scene, ctx, { dpr })`.
- `@aster/core/load` — `loadSpecData(spec, { baseURL, allow, protocols, timeoutMs, maxBytes, ... })` for URL datasets, with a URL policy (safe defaults, see `docs/LIMITS.md`).
- `@aster/core/geo`, `@aster/core/transforms` — importing them registers the projections / rare transforms; load them
  before rendering a spec that needs them (otherwise rendering throws an error naming the import, see `docs/ERRORS.md`).

```ts
import { renderSpec, type SceneRoot, type VgSpec } from '@aster/core'
import { buildHitIndex } from '@aster/core/hit'
import { createChartSession } from '@aster/core/dom'

const spec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'table', values: [{ k: 1 }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { value: 10 }, y: { value: 10 }, width: { value: 30 }, height: { value: 30 }, fill: { value: 'red' } } } }],
}
const scene: SceneRoot = createChartSession().evaluate(spec)
const hit = buildHitIndex(scene)
console.log(hit.size(), hit.queryMark(20, 20)?.item.datum, hit.queryMark(90, 90)) // 1 { k: 1 } null
console.log(renderSpec(spec).startsWith('<svg'))
```

## `@aster/react`

### `<Chart>`

```tsx
import * as React from 'react'
import { Chart, type ChartHandle, type SelectValue, type ViewDomain } from '@aster/react'
import type { VgSpec } from '@aster/core'

const vegaOrVegaLiteSpec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 'table' }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'v' } } } }],
}

export function Example(): React.ReactElement {
  const ref = React.useRef<ChartHandle>(null)
  const [view, setView] = React.useState<ViewDomain | null>(null)
  const [selection, setSelection] = React.useState<SelectValue | null>(null)
  const [rows] = React.useState([{ v: 1 }, { v: 2 }, { v: 3 }])

  return (
    <Chart
      ref={ref}
      spec={vegaOrVegaLiteSpec}
      data={{ table: rows }}         // Record<string, unknown[]>: dataset name -> rows
      renderer="svg"                 // or "canvas"
      panZoom                        // or pan / zoom separately, see docs/INTERACTION.md
      view={view}                    // omit for uncontrolled
      onViewChange={setView}
      selection={selection}          // { type: 'interval' | 'point', … }
      onSelectionChange={setSelection}
      onSelect={(interval) => { console.log(interval) }}    // interval convenience callback
      onPointSelect={(datum) => { console.log(datum) }}     // click convenience callback
      tooltip
      renderTooltip={(datum) => <b>{String(datum.v)}</b>}
      a11y={{ summaryThreshold: 150 }}
      limits={{ maxRows: 100_000, maxItems: 50_000, maxTimeMs: 2_000 }}
      onError={(error) => { console.error(error.message) }}
    />
  )
}
```

`spec` may be a Vega spec, a Vega-Lite spec, or a promise (wrap the chart in
`<Suspense>`). Vega-Lite is an opt-in addon — import it once before rendering VL
specs:

```ts
import '@aster/react/vl'   // side effect: registers the from-scratch VL compiler
```

The base `@aster/react` entry does not include the Vega-Lite compiler; importing `@aster/react/vl` adds about 54.2 kB
gzip to the bundle (`<Chart>` 157.2 kB, `<Chart>` + `@aster/react/vl` 211.3 kB, measured by
`pnpm --filter @aster/benchmarks run budget`; see [PERFORMANCE.md](PERFORMANCE.md#bundle-sizes)). Passing a VL spec without the addon throws an error naming the missing
import. Vega specs need no extra import. Worker hosts must import `@aster/react/vl` in the worker entry as well,
since compilation happens there.

**Props.** `spec` (compared by content: an equal inline literal does no work; the one exception is a dataset's inline `values` array, which is compared by identity, so a re-created but equal rows array is a new input, which the session's row diff finds unchanged and applies as a no-op; the streaming components keep the full content comparison, so a spec rebuilt every render does not restart a stream), `data`, `dataChanges`, `width`,
`height` (each independent; without them the chart measures its container; a given one fixes the view's size, even for a container-sized spec, whose `width` / `height` signals and `window:resize` handlers do not move it. The measured container only sizes a spec that has no `width` / `height` signal of its own; one that drives them (a bound input, a handler, Vega-Lite's `"container"`) keeps doing so, as in Vega where the size is a signal and the later write wins, and sees the container through `containerSize()`), `ariaLabel`, `className`, `style`,
`signals`, `signalListeners`, `onSignal`, `interactive`, `preventDefault`, `renderer`, `incremental`, `denseMarks`,
`tooltip`, `renderTooltip`, `selection`/`select`, `onSelectionChange`, `onSelect`, `onPointSelect`, `brush`, `panZoom`,
`pan`, `zoom`, `view`, `onViewChange`, `maxZoom`, `a11y`, `limits`, `urlPolicy`, `logger`, `textMetrics`, `onError`.

**`data` and `dataChanges`.** `data` is a `Record<string, unknown[]>`: the key is the *dataset name* in the spec, the
value its rows. A bare array does not typecheck (`data={newRows}` is an error); write `data={{ table: newRows }}`. A new
array for a dataset is diffed against the previous one (appends and in-place edits re-encode only the affected rows).
`dataChanges={{ table: [3, 7] }}` is an optional hint with the same meaning as in the session; it is validated, and an
unknown dataset, a non-integer or out-of-range index or a changed row count makes the whole changeset be ignored
(the update is diffed in full, so the chart is still correct) and `onError` receives an `Error` describing it.

**Ref.** The ref (`ChartHandle`) exposes `getScene()`, `getSvg()` (serializes the current scene), `getChartInfo()`,
`getView()`, `setView()`, `resetView()`, `setSignal(name, value)` and `getSignals()`. `setSignal` runs the spec's
dependent signal updates when the SVG event loop is bound; on canvas or with `interactive={false}` it applies the value
as a signal override. Listeners (`signalListeners`, `onSignal`) are notified either way.

`denseMarks` (SVG only) batches dense symbol marks into chunked `<path>` elements
instead of one element per datum. Positions are baked into `d`, so the pixels match; tooltips,
point selection and the a11y tree resolve through the scene.

- `'auto'` (default) batches a symbol mark with at least 512 items unless the spec has
  `signal.on` event streams (those read the datum from per-item DOM nodes). Each path holds up to
  256 symbols, so 100,000 points become 391 paths.
- `true` always batches (still only marks with at least 512 items), `false` disables.
- Client-only mounts batch directly. SSR/hydrated pages emit the per-item markup on
  the server (so hydration matches) and switch to batched in place after hydration.
- Per-mark `data-datum` attributes are not emitted for batched chunks, and a mark with `href` links is never batched.

Pan, zoom and brushing are driven through scale `domainRaw`; the gestures, the keyboard contract and the rule that
picks the scales are in `docs/INTERACTION.md`.

### `<SvgChart>` and the `interaction` capability

`<SvgChart>` is the light chart for size-sensitive apps: the same engine and the same DOM as `<Chart renderer="svg">`
(it is a second shell over the one implementation, see [ARCHITECTURE.md](ARCHITECTURE.md#chartcore-and-the-two-shells)),
minus what an SVG-only app does not use. It lives in its own entry and never imports the canvas renderer.

```tsx
import * as React from 'react'
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 'table', values: [{ v: 1 }, { v: 2 }, { v: 3 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'v' } } } }],
}

export function Static(): React.ReactElement {
  // Renders, pans/zooms, brushes an interval (`onSelect`, `brush`), binds inputs, builds the accessible tree.
  return <SvgChart spec={spec} panZoom onSelect={(interval) => { console.log(interval) }} />
}

export function Interactive(): React.ReactElement {
  // Tooltips, point selection and the spec's `signal.on` event streams need the capability, passed as a prop.
  return <SvgChart spec={spec} interaction={interaction} tooltip onPointSelect={(datum) => { console.log(datum) }} />
}
```

**The capability.** `interaction` (from `@aster/react/interaction`) is a plain frozen value bundling hit testing
(`@aster/core/hit`) and the signal event loop (`@aster/core/signals`: `bindSceneSignals`, `stampDatumAttrs`). It is passed as
a prop: there is no registry, no global and no side-effect import (`sideEffects` needs no entry), so a bundler drops it
when it is not imported and `<SvgChart>` without it contains none of that code. `<Chart>` has it built in.

**Typing.** `SvgChartProps` is a union on `interaction`. These props exist only with it, and passing one without it is a
compile error: `tooltip`, `renderTooltip`, `onPointSelect`, `selection`, `select`, `onSelectionChange` (a click resolves
the mark under the pointer through the hit index) and `preventDefault` (it acts on the `signal.on` event loop).
`renderer` does not exist on `<SvgChart>` (it is always SVG). Every other `ChartProps` key is shared with the SAME type, and
the ref (`SvgChartHandle`) has every `ChartHandle` member; `src/parity.assert.ts` makes the compiler enforce both, so a prop
added to `<Chart>` without a decision about `<SvgChart>` fails `pnpm typecheck`.

```tsx
import * as React from 'react'
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
import type { VgSpec } from '@aster/core'

declare const spec: VgSpec

export const ok = <SvgChart spec={spec} interaction={interaction} tooltip />
// @ts-expect-error `tooltip` needs the interaction capability: pass interaction={interaction}
export const missing = <SvgChart spec={spec} tooltip />
```

A conditional `interaction={maybe}` typed `InteractionCapability | undefined` does not satisfy either arm of the union;
branch on it, or render `<SvgChart>` with and without the prop.

**At runtime, never a silently dead chart.** Types cannot see a spec's `signal.on` streams, and JS callers have no types, so
the component itself reports every feature it cannot provide. It still renders what it can (an error state would throw
away a correct picture; this is the same stance as a rejected `dataChanges` changeset, not the render-error stance of a
missing Vega-Lite compiler, where nothing meaningful can be drawn). The report goes to `onError` as an `Error` (else to
`logger.warn`, else `console.warn`), once per distinct problem, from an effect (so not during SSR):

| Situation | Message |
|---|---|
| a spec with `signal.on` streams, no `interaction` | `[aster] this spec has event streams (signal.on) but no event loop is bound: pass interaction={interaction} from '@aster/react/interaction'` |
| `tooltip`, `renderTooltip`, `onPointSelect`, `selection`, `select`, `onSelectionChange` or `preventDefault` without `interaction` (ignored) | `[aster] tooltip, … need hit testing and the signal event loop and are ignored: pass interaction={interaction} from '@aster/react/interaction'` |
| `renderer="canvas"` (renders SVG) | `[aster] renderer="canvas" needs <Chart>: <SvgChart> has no canvas renderer, so it renders SVG` |

Without `interaction`, `setSignal` and bound inputs (`signal.bind`) still work as signal overrides, exactly as on
`<Chart renderer="canvas">`; the spec's `signal.on` updates do not run. Server markup is identical with or without
`interaction`, except that a spec with event streams gets no `data-datum` attributes without it (nothing reads them).

Sizes (gzip, `pnpm --filter @aster/benchmarks run budget`): `<Chart>` 157.2 kB, `<SvgChart>` 142.0 kB,
`<SvgChart>` + `interaction` 151.5 kB ([PERFORMANCE.md](PERFORMANCE.md#bundle-sizes)). Use `<Chart>` unless that 15 kB
matters; it is the zero-setup default and its behaviour does not depend on this component.

### Hooks

```tsx
import * as React from 'react'
import { useChart, useChartData, useChartWorker, useSpecData } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = { width: 100, height: 60, marks: [{ type: 'rect', encode: { enter: { width: { value: 20 }, height: { value: 20 } } } }] }
const specWithUrls: VgSpec = { width: 100, height: 60, data: [{ name: 'table', url: 'https://data.example.com/a.csv' }], marks: [] }

export function Hooks(): React.ReactElement {
  const width = 200
  const height = 100
  // Headless: scene + SVG string through the same incremental session <Chart> uses.
  // `serialize: false` skips the SVG string (svg is null) when you render the scene yourself.
  const { scene, svg, error, session } = useChart(spec, { width, height })

  // URL data, Suspense/use() path: wrap the component that calls these in <Suspense>.
  // const loaded = useSpecData(specWithUrls, { fetch })   // returns the spec with the rows inlined
  // const chart = useChartData(specWithUrls)              // load + useChart (loader and chart options together)

  // Optional worker offload; without a Worker it evaluates synchronously after mount.
  const worker = useChartWorker(spec, { width, height })
  return <div data-scene={scene != null} data-svg={svg != null} data-error={error?.message} data-sessions={session != null} data-pending={worker.pending} />
}

export const loaders = { useSpecData, useChartData, specWithUrls }
```

`useChart` takes every `RuntimeInput` field plus `serialize` and returns `{ scene, svg, error, session }`; `error`
is set (and `scene`/`svg` are `null`) when the evaluation throws, and `maxSvgLength` is checked when it serializes.
`useSpecData` and `useChartData` take the options of `loadSpecData` (`UseSpecDataOptions`), `loadSpecData` from
`@aster/react` is the non-Suspense equivalent.

### Streaming components

```tsx
import * as React from 'react'
import { ChartStream, type ChartStreamHandle } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', values: [{ x: 1 }] }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width', zero: false }],
  axes: [{ scale: 'x', orient: 'bottom' }],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { value: 50 } } } }],
}

export function Live(): React.ReactElement {
  const ref = React.useRef<ChartStreamHandle>(null)
  React.useEffect(() => {
    const id = setInterval(() => ref.current?.push({ append: { table: [{ x: Math.random() * 100 }] } }), 100)
    return () => clearInterval(id)
  }, [])
  return (
    <ChartStream
      ref={ref}
      spec={spec}
      streamOptions={{ policy: 'drop-oldest', capacity: 8 }}
      panZoom
      limits={{ maxRows: 100_000 }}
      onStreamError={(error, failure) => { console.error(error.message, failure?.discarded) }}
    />
  )
}
```

`<ChartStream>` and `<ChartWorkerStream>` take `<Chart>`'s props except `data`/`dataChanges` (replaced by
`push({ data | append })`) and add `streamOptions` (`capacity`, `maxQueuedRows`, `policy`, `autoFlush`,
`flushPolicy`, `initial`, and for the worker form `worker`/`workerFactory`; `serialize` is forced off because the
component renders the scene itself) and `onStreamError(error, failure?)`.
`panZoom`/`pan`/`zoom`/`view`/`onViewChange` and `signals` are routed into the stream as `domainRaw` and `signals`
batches, so scales, marks and guides recompute inside the stream; `limits`, `textMetrics` and `urlPolicy` configure
the stream's evaluation; rendering, selection, tooltip, a11y and event props go to the underlying `<Chart>`.
The ref (`ChartStreamHandle`) has `push`, `flush`, `pending`, `pulse`, `stats`, `scene` and `close`.

- **SSR.** `<ChartStream>` primes its first scene synchronously, so a server render contains the full chart
  markup (the same markup `<Chart>` emits). `<ChartWorkerStream>` has no worker on the server and renders an empty
  `<div data-testid="chart-worker-stream-loading">` until it mounts and the worker answers.
- **Errors.** A failed flush renders `<div role="alert">` with the message and reports once through `onStreamError`;
  the failed batches are discarded so the next flush recovers (`failure.discarded` says how many).

### Workers

`useChartWorker` offloads compile/evaluate/render to a Worker and returns `{ svg, scene, error, pending }`;
`useChartWorkerStream` and `<ChartWorkerStream>` run a stream in a Worker. Without a Worker (no `worker`, and
`workerFactory` missing or returning `null`) the same request is handled synchronously, but from an effect: on the
server nothing runs, so `useChartWorker` returns `pending: true` with `svg: null` there, and in jsdom (no `Worker`) it
evaluates after mount.

```ts
// chart.worker.ts: the worker entry (a bundler builds it with `new Worker(new URL(...), { type: 'module' })`)
import '@aster/react/vl'                       // only if the worker must compile Vega-Lite
import { registerWorkerTextMetrics, registerWorkerUrlPolicy } from '@aster/react/worker'
import '@aster/react/worker-entry'             // installs the message handler (self.onmessage)

registerWorkerTextMetrics('inter', { measure: (text, _font, size) => text.length * size * 0.55 })
registerWorkerUrlPolicy('cdn-only', { allow: (url) => url.hostname === 'cdn.example.com' })
```

```tsx
import * as React from 'react'
import { useChartWorker } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = { width: 100, height: 40, marks: [{ type: 'text', encode: { enter: { text: { value: 'hi' } } } }] }

export function Offloaded(): React.ReactElement {
  const { svg, error, pending } = useChartWorker(spec, {
    workerFactory: () => (typeof Worker === 'undefined' ? null : new Worker(new URL('./chart.worker.ts', import.meta.url), { type: 'module' })),
    limits: { maxRows: 100_000, maxTimeMs: 2_000 },     // enforced inside the worker
    textMetrics: 'inter',                               // a NAME registered in the worker
    urlPolicy: { hooks: 'cdn-only', baseURL: 'https://app.example.com/' },
  })
  return pending ? <p>loading</p> : error ? <p role="alert">{error.message}</p> : <div dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
}
```

- **`limits`** travel in every request and are enforced in the worker, with the same sequence as `renderSpec`
  (pre-flight, meters, scene, SVG length). A violation comes back as a wire error with `code: 'ASTER_LIMIT'`.
- **`textMetrics` and `urlPolicy` by name.** A provider object or a policy with functions cannot cross `postMessage`.
  Register it in the worker with `registerWorkerTextMetrics(name, provider)` / `registerWorkerUrlPolicy(name,
  { allow, onDeny })` (both from `@aster/react/worker`, called in the worker entry) and pass the name
  (`textMetrics: 'inter'`, `urlPolicy: { hooks: 'cdn-only', baseURL, protocols }`). Passing an object while a Worker is
  in use fails the hook with an error that says so; without a Worker an object works as is. An unregistered name fails
  with `[aster] unknown text-metrics provider "<name>" ...`. For streams the same applies to `textMetrics`,
  `initial.textMetrics`, `initial.urlPolicy` and a batch's `textMetrics` (`ChartWorkerBatch`).
- **Failures.** A worker `error` or `messageerror` event ends the pending request or stream with an `Error`
  (`[aster] worker error: ...`, `[aster] worker message could not be deserialized (messageerror)`); the hook's `error`
  is set and `pending` is `false`. Worker errors arrive as `{ name, message, code? }` and are rebuilt into `Error`s; see
  `docs/ERRORS.md` for which class survives.
- **`serialize`.** The streaming hooks take `serialize` (default `true`): `false` skips building the SVG string per
  scene (the components set it, since they render the scene themselves). `useChart` takes it too.
- **Protocol.** `handleChartWorkerRequest(request)` and `handleChartWorkerStreamRequest(request, streams)` are the pure
  handlers behind the entry; `cloneableScene(scene)` strips what cannot be structured-cloned; `nextWorkerRequestId()`
  gives ids from the one per-realm counter all the hooks share.

### SSR + hydration

```tsx
import { renderToString } from 'react-dom/server'
import { Chart, hydrateChart, renderChartToStaticMarkup } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = { width: 100, height: 60, marks: [{ type: 'rect', encode: { enter: { width: { value: 20 }, height: { value: 20 }, fill: { value: 'teal' } } } }] }
const width = 100
const height = 60

// Server: full SVG in the streamed HTML
const html = renderToString(<Chart spec={spec} />)

// Non-React host: string + DOM-patcher hydration (keeps the server <svg> node)
const svg = renderChartToStaticMarkup(spec, { width, height })
export function hydrate(container: Element): void {
  hydrateChart(container, spec, { width, height })
}
console.log(html.includes('<svg'), svg.startsWith('<svg'))
```

`renderChartToStaticMarkup` and `hydrateChart` (also exported from `@aster/react/ssr`) accept either grammar and
apply `limits` like the client. A `<Chart>` on the server renders its markup in the HTML; the canvas renderer renders
an empty `<canvas>` there.

### Accessibility keyboard contract

The accessible tree is a roving-tabindex group: exactly one node is a Tab stop. The keys, per node kind, are listed in
`docs/INTERACTION.md#accessibility`.

## `@aster/vl`

```ts
import { compile } from '@aster/vl'

const vegaSpec = compile({
  data: { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
})
console.log(Array.isArray(vegaSpec.marks))
```

`<Chart>` and `useChart` use this compiler for Vega-Lite input once
`@aster/react/vl` is imported, so a fresh app does not need a `vega-lite`
dependency. Hosts that already bundle `@aster/vl` themselves can instead call
`registerVegaLiteCompiler` from `@aster/react` with a function `(spec) => vegaSpec`;
`hasVegaLiteCompiler()` reports whether one is registered. `compile` throws `VLCompileError` for
anything outside the supported subset (see `docs/ERRORS.md`).

Vega-Lite maps (`geoshape`, `projection`, `longitude` / `latitude`, `{type: "geojson"}`) and animation (the `time`
channel with a `timer` point selection and `{filter: {param}}`) compile to what vega-lite 6.4.3 emits; maps in a facet and
animations outside a single top-level unit throw (reasons in `packages/vl/README.md`). Running an animation needs
the signal event loop (`<Chart>` or `<SvgChart interaction>`): `timer` streams run on a d3-timer port shared by the page,
stop on unmount, and `setTimerClock` from `@aster/core` installs a controlled clock. `bindSceneSignals(..)` takes
`{ owner, data }` (the element the timers belong to, the datasets the loop starts from), an `onData` hook, and returns a
binding with `release()`.
