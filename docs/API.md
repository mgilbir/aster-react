# API

The public surface of the three Aster packages: what each entry point exports, with the examples that are type-checked against the source. For install and a first chart see the [README](../README.md#render-a-first-chart); for what a failure means see [ERRORS.md](ERRORS.md).

## Start here

| I want to | Import | Read |
|---|---|---|
| render a Vega spec to an SVG string, with no React | `renderSpec` from `@aster-charts/core` | [Render a Vega spec](#render-a-vega-spec) |
| show a chart in a React app | `Chart` from `@aster-charts/react` | [`<Chart>`](#chart) |
| use a Vega-Lite spec | `import '@aster-charts/react/vl'` once (React), or `compile` from `@aster-charts/vl` | [`<Chart>`](#chart), [`@aster-charts/vl`](#aster-chartsvl) |
| ship the smallest React bundle | `SvgChart` from `@aster-charts/react/lite` (and `interaction` from `@aster-charts/react/interaction` for tooltips and `signal.on`) | [`<SvgChart>`](#svgchart-and-the-interaction-capability) |
| get the scene or the SVG without a component | `useChart` from `@aster-charts/react` | [Hooks](#hooks) |
| update a chart as data arrives | `ChartStream` from `@aster-charts/react`, or `createChartStream` from `@aster-charts/core` | [Streaming and pulses](#streaming-and-pulses), [Streaming components](#streaming-components) |
| update a chart when only some rows changed | `createChartSession` from `@aster-charts/core/dom`, or the `dataChanges` prop | [Sessions and per-datum updates](#sessions-and-per-datum-updates) |
| keep rendering off the main thread | `useChartWorker` from `@aster-charts/react`, and `@aster-charts/react/worker-entry` in the worker | [Workers](#workers) |
| render on the server and hydrate | `renderChartToStaticMarkup`, `hydrateChart` from `@aster-charts/react` (or `@aster-charts/react/ssr`) | [SSR + hydration](#ssr--hydration) |
| render specs from untrusted sources | the `limits`, `urlPolicy` and `urlData` inputs, and a worker | [RuntimeInput](#runtimeinput), [LIMITS.md](LIMITS.md) |
| load a spec's `url` datasets | `loadSpecData` from `@aster-charts/core/load`, or `useSpecData` in React | [`@aster-charts/core/load`](#aster-chartscoreload) |
| save a chart as a PNG | `getPng()` on the chart's ref (`<SvgChart>` needs `png` from `@aster-charts/react/png`), or `renderSceneToPng` from `@aster-charts/core/png` | [PNG export](#png-export), [`@aster-charts/core/png`](#aster-chartscorepng) |
| call my own function from an expression | `registerExpressionFunction` from `@aster-charts/core` | [Custom expression functions](#custom-expression-functions) |

## Contents

- [Packages and entry points](#packages-and-entry-points)
- [`@aster-charts/core`](#aster-chartscore)
  - Guides: [Render a Vega spec](#render-a-vega-spec), [Sessions and per-datum updates](#sessions-and-per-datum-updates), [Custom expression functions](#custom-expression-functions), [Streaming and pulses](#streaming-and-pulses)
  - Reference: [RuntimeInput](#runtimeinput), [The pipeline steps](#the-pipeline-steps), [Locales](#locales), [Text metrics](#text-metrics), [Logger](#logger), [Pointer position and cursor](#pointer-position-and-cursor), [Building blocks](#building-blocks), [Limit checks](#limit-checks), [Typed errors](#typed-errors), [Accessibility tree](#accessibility-tree)
  - Add-on entry points: [`/hit`](#aster-chartscorehit), [`/signals`](#aster-chartscoresignals), [`/addons`](#aster-chartscoreaddons), [`/dom`](#aster-chartscoredom), [`/transition`](#aster-chartscoretransition), [`/canvas`](#aster-chartscorecanvas), [`/png`](#aster-chartscorepng), [`/load`](#aster-chartscoreload), [`/geo` and `/transforms`](#aster-chartscoregeo-and-aster-chartscoretransforms), [an example](#example-hit-testing-a-scene)
- [`@aster-charts/react`](#aster-chartsreact)
  - Components and hooks: [`<Chart>`](#chart), [PNG export](#png-export), [`<SvgChart>` and the `interaction` capability](#svgchart-and-the-interaction-capability), [Hooks](#hooks), [Streaming components](#streaming-components), [Workers](#workers), [SSR + hydration](#ssr--hydration)
  - Reference: [Registry and session re-exports](#registry-and-session-re-exports), [Pan, zoom and selection helpers](#pan-zoom-and-selection-helpers), [Accessibility keyboard contract](#accessibility-keyboard-contract)
- [`@aster-charts/vl`](#aster-chartsvl): [Compile a Vega-Lite spec](#compile-a-vega-lite-spec), [Maps and animation](#maps-and-animation)

## Packages and entry points

Aster ships three public packages:

| Package | Entry | Purpose |
|---|---|---|
| `@aster-charts/core` | `@aster-charts/core` | compile/evaluate/render a Vega spec to SVG; limits, streams, a11y tree |
| `@aster-charts/core/…` | `/addons`, `/dom`, `/canvas`, `/png`, `/hit`, `/signals`, `/transition`, `/load`, `/geo`, `/transforms` | `/addons` says which add-ons a spec needs and loads them on demand; `/transition` interpolates between two scenes; `/png` encodes a scene as a PNG; the others are opt-in add-ons (tree-shaking boundaries) |
| `@aster-charts/react` | `@aster-charts/react` | `<Chart>`, `useChart`, streams, SSR/hydration, worker hooks |
| `@aster-charts/react/…` | `/lite`, `/interaction`, `/png`, `/vl`, `/worker`, `/worker-entry`, `/ssr` | `/lite` is the SVG-only `<SvgChart>`; `/interaction` is the `interaction` capability that adds tooltips, point selection and `signal.on` streams to it; `/png` is the `png` capability that gives it `getPng`; `/vl` registers the Vega-Lite compiler (and exports `compile`, `isVegaLiteSpec`, `normalizeChartSpec`); `/worker` has the worker registries and protocol; `/worker-entry` is a ready worker script; `/ssr` is the string/hydration pair |
| `@aster-charts/vl` | `@aster-charts/vl` | from-scratch Vega-Lite → Vega compiler |

`@aster-charts/core` takes Vega specs only. Vega-Lite goes through `@aster-charts/vl` (or `@aster-charts/react/vl`).

Each package also has a README with its install line and a first example: [`@aster-charts/core`](../packages/core/README.md),
[`@aster-charts/react`](../packages/react/README.md), [`@aster-charts/vl`](../packages/vl/README.md).

Each package section below has the same order: guides (a task, start to finish, with a runnable example), then the reference
(what each export does and the rules it follows), then the entry points that are separate imports.

## `@aster-charts/core`

### Guides

#### Render a Vega spec

```ts
import { renderSpec, type VgSpec } from '@aster-charts/core'

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

#### Sessions and per-datum updates

`createChartSession()` (from `@aster-charts/core/dom`, also re-exported by `@aster-charts/react`) caches the IR and the scene across
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
import { createChartSession } from '@aster-charts/core/dom'
import type { VgSpec } from '@aster-charts/core'

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

#### Custom expression functions

`registerExpressionFunction(name, fn)` is the counterpart of vega's `expressionFunction(name, fn)`: expressions
(`{signal: ...}`, filters, formulas, encodes) may then call `name(...)`. It is how Vega-Lite's custom `formatType`
works: with `config.customFormatTypes: true`, `{"formatType": "price", "format": "$.2f"}` compiles (`@aster-charts/vl`, as
vega-lite) to `price(datum["v"], "$.2f")` for text, tooltip, href and description channels and to a
`price(datum.value, "$.2f")` label encode for axes and legends. Register `price` before rendering, in vega too if
you compare the two:

```ts
import { registerExpressionFunction, renderSpec, type VgSpec } from '@aster-charts/core'

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
As in vega's parser, a call to a name that is not a function of the current context is refused when the
spec is compiled, with `SpecParseError("Unrecognized function: <name>")` (a function that is removed after the compile
makes `ExpressionParseError("Unrecognized function: <name>")` the next time an expression compiled earlier runs), not when the call is first
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
its own), and so does `@aster-charts/vl`.

#### Streaming and pulses

`diffRows(previous, next)` classifies a replacement snapshot: same-length changes return
the changed indices; length-changing updates also return `from` (new → old row index,
`-1` for an insert), `to` (old → new, `-1` for a delete) and the added/removed ranges.
Pass the long form as `dataPulse` (per source dataset) to `evaluateChart`/`session` when
you already know the delta; `dataChanges` remains the compact same-length form (when both name
a dataset, `dataPulse` wins for it).

`createChartStream(spec, options)` wraps a session with a push-based, bounded queue:

```ts
import { createChartStream, type VgSpec } from '@aster-charts/core'

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
`width`, `height`, `domainRaw`, `limits`, `textMetrics`. `initial.urlPolicy` and `initial.urlData` are fixed for the stream's life.

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

### Reference

#### RuntimeInput

`RuntimeInput` (the second argument of `renderSpec`, `evaluateChart` and the session) has these fields: `limits`,
`urlPolicy`, `urlData`, `logger`, `random`, `textMetrics`, `data`, `width`, `height`, `signals`, `containerSize`, `measuredSize`, `changedDatasets`,
`dataChanges`, `dataPulse`, `autoChanges`, `domainRaw`. `data` is a `Record<string, unknown[]>` keyed by dataset
name; it overrides or supplies the rows of the spec dataset of that name.

`urlData` (`'allow'`, the default, or `'refuse'`; type `UrlDataMode`) says whether the spec may name `url` datasets. With
`'refuse'` a spec that has a dataset with a `url` and no `values`, at the top level or in a nested group, fails at once with an
`AsterUrlError` that names the dataset and says url data is not allowed, whether or not `data` gives rows under its name: for a host
that supplies every row itself and draws specs it did not write (the data counterpart of `urlPolicy`; see
[LIMITS.md](LIMITS.md#refusing-url-datasets-urldata)). Any other value is a `TypeError`. `urlDatasets(spec)` returns the names of a
spec's url datasets (top level and nested groups, in document order), and `checkUrlData(spec, urlData)` throws the refusal
`urlData: 'refuse'` would, for a host that checks a spec before handing it over.

`random` (`RuntimeInput.random`, `() => number` in [0, 1)) is the chart's source of random numbers, the per-chart counterpart of
vega's `setRandom`: expression `random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`, the `sample` transform and the
bootstrap `ci0` / `ci1` aggregate ops draw from it, one number per draw, in vega's order and count, so a host that gives Aster and
vega the same seeded generator gets the same numbers. The engine touches no global: without `random`, expressions use
`Math.random` and `sample` / `ci` the engine's own seeded stream. The evaluator reaches a fixed point (it builds datasets and
resolves signals more than once), so a source is consumed once per transform or signal *run*: a site whose inputs (its rows, its
parameters, the signals it mentions) are unchanged replays the numbers it drew, as vega's dataflow does not rerun an operator whose
inputs did not change; one whose inputs changed draws the next ones. The `<Chart random>` prop forwards it (pass one generator for
the life of the chart); a function cannot cross a worker boundary, so the worker protocol does not carry it.

`logger` (`RuntimeInput.logger`, type `Logger`) is where the engine reports an error it recovers from, as vega's
dataflow does: an expression that throws while a chart is evaluated (a conditional-encode test, an encode signal, a
filter or formula, a sort, a scale that cannot be built) is logged and the render carries on with what it has. See
`docs/ERRORS.md` for exactly what survives each failure.

`limits` are described in `docs/LIMITS.md`, including which entry point enforces which budget. They are best-effort protection: a killable worker is the hard guarantee for untrusted specs. A few built-in ceilings (`HARD_CAPS`, `HARD_MAX_SPEC_DEPTH`) hold even when no `limits` are given; they throw `AsterLimitError` and a matching limit replaces them.

#### The pipeline steps

`compileChart(spec)` produces the `CompiledChart` IR; `evaluateChart(chart, input)` resolves data/scales/encodes into
a `SceneRoot`; `renderSceneToSvg(scene)` serializes it; `getChartInfo(spec, input)` returns the size, padding and
scales (`ChartInfo`) of the evaluated scene (`chartInfoFromScene(scene)` reads the same from a scene you already
have). `renderSpec` is those steps plus the limit checks.

#### Locales

A locale is one object over the number and time formatters a chart reads text through: `format(specifier)`,
`formatPrefix(specifier, value)`, `formatFloat(specifier)`, `formatSpan(start, stop, count, specifier)` (numbers) and
`timeFormat`, `utcFormat`, `timeParse`, `utcParse` (dates). Each returns a formatter or parser function. The behaviour is
vega-format's; compiled formatters are kept per specifier in a bounded least-recently-used table
([LIMITS.md](LIMITS.md#locale-and-formatter-caches)).

- `locale(numberDefinition?, timeDefinition?)` returns a `Locale` from d3-format / d3-time-format style definitions
  (`FormatLocaleDefinition`, `TimeLocaleDefinition`); a missing half is the current default one. It does not change the default.
- `numberFormatLocale(definition)` and `timeFormatLocale(definition)` build one half alone (the number half has the
  number methods, the time half the date methods).
- `defaultLocale()` reads the default locale; `defaultLocale(numberDefinition, timeDefinition)` replaces both halves. One
  argument is an error. `numberFormatDefaultLocale(definition?)` and `timeFormatDefaultLocale(definition?)` read or replace one half.
  The expression functions `format`, `timeFormat`, `utcFormat`, `timeParse`, `utcParse`, the guide captions and the `date:` / `utc:` patterns of a data `parse` read the default on every call, so a replacement takes effect at once. It is
  process-wide state: set it once at start-up.
- `resetDefaultLocale()` puts both halves back to the built-in locale (a test seam).

```ts
import { locale } from '@aster-charts/core'

const de = locale({ decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] })
console.log(de.format(',.2f')(1234.5)) // 1.234,50
```

#### Text metrics

Text is measured for layout (axis labels, legends, `text` mark bounds) with, in order: the host provider, a canvas 2D
context, vega's headless estimate. [FONTS.md](FONTS.md) explains the order and why it decides whether a chart matches vega.
A `TextMetricsProvider` is `{ measure(text, font, fontSize, item?) => number }`, a non-negative advance width in CSS pixels.

- `setTextMetricsProvider(provider | null)` installs (or removes) the provider for the whole module and clears the width cache.
- `getTextMetricsProvider()` returns the installed provider or `null`.
- `withTextMetricsProvider(provider, fn)` runs `fn` with a scoped provider and restores the previous one afterwards, also when `fn`
  throws; `renderSpec` and `<Chart textMetrics>` use it. A `null` / `undefined` provider runs `fn` as it is.
- `usingCanvasTextMetrics()` is `true` when a provider is installed or a canvas 2D context exists in this environment.
- `measureText(text, font, item?)` is vega-scenegraph's cached width measurement (keyed by provider, font and text): the provider's
  answer (a throwing provider, or a negative or non-finite answer, falls back to the estimate), else the canvas context's
  `measureText`, and `0` when neither exists. Check `usingCanvasTextMetrics()` first to choose the estimate instead.
- `estimateTextWidth(text, fontSize)` is vega's headless estimate, `~~(0.8 * text.length * fontSize)`.
- `fontString(item)` builds the CSS font string vega builds from a text item: `[style ][variant ][weight ]{size}px {family}`
  from `fontStyle`, `fontVariant`, `fontWeight`, `fontSize` (default 11) and `fontFamily` or `font` (default `sans-serif`).

#### Logger

`consoleLogger` is the default `Logger`: `error` and `warn` go to `console.error` / `console.warn`, as vega's default
does. Pass it, or a `Logger` of your own, as `RuntimeInput.logger`.

#### Pointer position and cursor

- `clientToSvg(element, clientX, clientY)` returns `[x, y]`, the pointer in the chart element's own coordinates, as
  vega-scenegraph's `point(event, el)` does. It inverts the element's screen CTM, so a `viewBox` against a CSS-scaled
  width, borders, padding and ancestor transforms are accounted for. Without a CTM (a canvas) it unscales the bounding rect.
- `createPointMapper(getElement)` is the same map measured once and reused, so a `pointermove` costs no layout read. It returns
  `{ map(clientX, clientY), invalidate() }` (`PointMapper`); call `invalidate()` when the layout can have changed (a commit, a resize,
  a scroll, the pointer entering). While `getElement()` returns `null` the point is returned unchanged.
- `DEFAULT_CURSOR` is `'default'`, the cursor a view shows when nothing sets one.
- `resolveCursor(signalValue, itemCursor)` returns the CSS cursor to show, or `null` for none, from the value of the spec's
  `cursor` signal and the `cursor` of the item under the pointer (vega-view's rule: a `cursor` signal other than `default` wins,
  else the item's, else the signal's). A signal value that is vega's own `{ user, item }` object carries its item.

#### Building blocks

The pieces `renderSpec` and the session are made of are exported for hosts that build on them. Wrap calls in
`withLimits(limits, () => ...)` to get the same metering as `renderSpec` ([LIMITS.md](LIMITS.md#which-entry-point-enforces-what)).

- `compileExpr(expression, runtime)` compiles a Vega expression string against an `ExpressionRuntime`
  (`{ scale(name), data(name), expr(string), ... }`: how the expression reaches scales and datasets) and returns
  `(datum, params?, event?) => value`. A malformed expression throws `ExpressionParseError`.
- `buildScale(compiledScale, context)` builds one scale (`Scale`, a callable with `domain()`, `range()` and, where the type has
  one, `invert()`) from a `CompiledScale` and a `ScaleContext` (`width`, `height`, `signals`, `dataField(dataName, field)`, ...).
- `applyTransforms(rows, transforms, context, sourceName?)` runs a list of `CompiledTransform`s over `Row[]` (a `Row` is
  `Record<string, unknown>`); `sortRows(rows, sort?)` orders rows by a `SortSpec` (`{ field, order }`) and returns them
  unchanged without one. `context` is a `TransformContext`: the expression `runtime` and the `signals` by name.
- `datasetsOfScene(scene)` returns the rows each spec dataset ended with in the evaluation that made `scene`
  (`ReadonlyMap<name, rows | null>`, vega's `view.data(name)`); `null` marks a dataset that never ran, and the map is empty for a scene
  that did not come from this runtime (a clone, a worker result).
- Pulses: `rowsEqual(a, b)` is the row equality `diffRows` uses (plain rows by own keys, nested values by their JSON);
  `transformNeedsFullRederive(types)` says whether a chain of transform types holds a row-expanding or reordering one (`fold`,
  `flatten`, `pivot`, the layouts...), so a row-wise pulse cannot be applied through it; `isGroupedTransform(type)` is `true` for
  `aggregate`, `joinaggregate`, `window` and `stack`.
- Registries, filled by the add-ons: `transformRegistry` (`Map<type, TransformFn>`, the rare transforms of
  `@aster-charts/core/transforms`), `dataFormatRegistry` (`Map<format, reader>`, `json` built in; csv / tsv / dsv / topojson from
  `@aster-charts/core/load`), `geoRegistry` (the projection and contour hooks of `@aster-charts/core/geo`, `null` fields until loaded).
  `requireTransform(type)` returns a registered transform or throws the error that names the import to make
  (`await import("@aster-charts/core/transforms")`, see `docs/ERRORS.md`).

#### Limit checks

`renderSpec` runs these in a fixed order; call them yourself when you assemble the steps. All throw `AsterLimitError`.

- `checkSpecLimits(spec, limits, input?)` is the pre-flight, before anything is allocated: string lengths, depth, marks, inline rows
  (including `input.data`).
- `checkSceneLimits(scene, limits)` checks the generated geometry (items, path and text lengths) before serialization.
- `checkSvgLength(svg, limits)` checks `maxSvgLength` on the serialized string.
- `createLimitClock(limits?, now?)` starts the wall-clock budget (`maxTimeMs`, opt-in) and returns `{ started, deadline, check(phase?),
  remaining() }`; `check` throws once the budget is spent and is a no-op without `maxTimeMs`. `now` defaults to `performance.now`.
- `withLimits(limits, fn)` runs `fn(meter)` with a `LimitMeter` active, so every layer below reports to one budget. Nested calls with
  the same `limits` object share the outer meter; without `limits` the function runs unmetered (the built-in ceilings still hold).

#### Typed errors

`AsterUrlError` (`code: 'ASTER_URL_DENIED'`, `url`, `reason`) is thrown when the URL policy refuses a request, before any
request is made, and when `urlData: 'refuse'` refuses a url dataset; it is exported from `@aster-charts/core` and from `@aster-charts/core/load`. `docs/ERRORS.md` lists every error class.

#### Accessibility tree

`buildA11yTree(scene, scales, options)` returns positioned, captioned nodes (`A11yNode`) for marks,
axes, legends, legend entries and titles. A mark with more than `summaryThreshold` items (default 150) collapses to a
single summary node, and the tree carries a `summary` caption when the scene's mark items in total exceed it. `A11yOptions` are `label`,
`description`, `summaryThreshold`, `isSelected` and `isLegendEntryHidden`. `<Chart>` projects the nodes into
focusable elements; non-React hosts can do the same. The keyboard contract is in `docs/INTERACTION.md`.

### Add-on entry points

#### `@aster-charts/core/hit`

`buildHitIndex(scene)` returns `{ query(x, y), queryMark(x, y), size() }`; `queryMark` returns
data-bearing mark items only (guides excluded), `query` returns anything painted. Both give a `HitTarget`
(`{ item, marktype }`) or `null`.

#### `@aster-charts/core/signals`

`bindSceneSignals(svg, scene, values, hooks?, { pick?, data?, owner?, containerSize? })`, `stampDatumAttrs`, `setTimerClock`.
Binds every `signal.on` entry with vega's event-stream semantics: selector strings (`[mousedown, mouseup] > mousemove`,
`@name:click`, `symbol:click`, `window:keydown`, `click[event.shiftKey]{100}`, `mousedown!`), object-form `events`, arrays,
`{signal}` sources, `between`, filters, throttle, debounce, `consume` and `force`. `event` is the native event extended with
`item`, `vega` and `dataflow`, so `event.deltaY`, `event.shiftKey`, `x()`, `y()`, `item()` and `group()` behave as in vega;
`datum` is `event.item.datum`. A handler runs only when its stream matched; a signal's `update` re-runs only when a signal
it reads changed. It returns `{ detach(), release(), setSignal(name, value) }`: `detach()` stops delivering events to this
binding but leaves timer streams and pending debounces running (a host re-binds after every render and the timers belong
to the view); call `release()` when the host is done with the svg, which detaches and stops its timer streams and
pending debounces (vega's `view.finalize()`). `setTimerClock(clock | null)` ([Maps and animation](#maps-and-animation)) swaps the clock the timer streams run on.
- `hooks.onSignal(name, value, all)` — once per signal that changed while an event was processed.
- `hooks.onData(name, rows, fromTimer)` — once per dataset that `modify(...)` edited (`fromTimer`: a `timer` stream's tick made the edit) (a Vega-Lite selection's `<name>_store`), with
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
  datum, enclosing group). Without it, or when it finds nothing, the item is read from the DOM (the `mark-*`/`role-*`
  classes, and a `data-datum` stamp if `stampDatumAttrs` was called), where mark names are not available. `<Chart>` passes its own hit index.
- Lower-level pieces of the same module. `bindSignalEvents(svg, chart, runtime, signalParams, signals, hooks?, options?)` is
  what `bindSceneSignals` calls once it has read the compiled chart, expression runtime and signal parameters off the scene; use
  it when you hold those yourself (`options` also takes `originX` / `originY`, the padding the view-space position is offset by,
  and `scene`). `parseEventSelector(selector)` returns the event types a selector string, event-stream object or array listens to
  (`parseEventSelector('mousemove, click')` is `['mousemove', 'click']`) and throws on a malformed one.
  `sceneIntersect(scene, box, options, group)` is vega-scenegraph's `intersect` over a scene (the body of the `intersect()`
  expression function: `box` is `[[x0, y0], [x1, y1]]`, `options` may hold `marktype` and `markname`); it is exported for the
  conformance gate and is internal.
- The cursor. `sceneHasCursor(scene)` is `true` when any item of the scene has a `cursor` channel, so a host can skip picking on
  every pointer move when none does (the answer is cached per scene). `createCursorTracker({ pick, user, onCursor, eventConfig? })`
  is vega-view's cursor logic without any DOM: `move(x, y)` takes the `cursor` of the item `pick(x, y)` finds and
  `refresh()` re-reads the `cursor` signal; each calls `onCursor(cursor | null)` only when the shown cursor changes (see
  `resolveCursor` in `@aster-charts/core`). A `config.events.view` rule that blocks `pointermove` stops `move` from looking.

#### `@aster-charts/core/addons`

which add-ons a spec needs, and loading them (the `Chart` shells and hooks do this themselves; use it
where you cannot wait inside React). `addonsNeeded(spec)` reads the spec's structure (and parses its expressions) and returns the
needed `AddonName`s (`'transforms' | 'geo' | 'load'`); `missingAddons(spec)` is the subset not loaded yet; `loadAddons(names)`
imports them (concurrently, each at most once, rejecting with an error that names the add-on); `loadAddonsFor(spec)` (also in
`@aster-charts/react`) is the last two in one call. `isAddonLoaded(name)` says whether an add-on's registrations are present however they
got there, and `notLoaded(names)` filters a list by it. `addonsNeeded`, `missingAddons` and `loadAddonsFor` take an optional second
argument, `{ urlData }` (`AddonOptions`): with `urlData: 'refuse'` the readers a url dataset's `format` names are not counted (the dataset
is refused, never read), and `loadAddonsFor` rejects a spec that has a url dataset with the refusal before importing anything. Constants: `TRANSFORMS_ADDON_TYPES` (every transform type the
transforms add-on registers), `LOAD_ADDON_FORMATS` (`csv`, `tsv`, `dsv`, `topojson`) and `ADDON_FUNCTIONS` (expression function name to the
add-on that registers it). Test seams: `registeredFunctionNames` lists the expression functions registered beyond the built-ins, and
`withdrawFunctions(names)` removes some and returns a function that restores them.

#### `@aster-charts/core/dom`

`patchSceneDom(svg, scene, options?)` makes an existing `<svg>` element match a scene, touching only changed
attributes (it throws for a non-`svg` element); `renderSceneToDomElement(scene, document?, options?)` builds the element;
`sceneToDomDesc(scene, options?)` is the plain-data description (`DomDesc`: `tag`, `attrs`, `text`, `children`) both are made from;
`createChartSession`; `hasDenseSymbolMarks(scene, minItems?)` is `true` when a symbol mark is large enough for `denseMarks`
batching (default 512 items). `options` (`DomRenderOptions`) are `denseMarks` and `denseChunkSize` (default 256). Also:
`chartSkeleton(spec)` serializes a spec without its top-level datasets' inline values: two specs with the same skeleton compile to the
same chart, so a host can tell "same chart, new rows" from "a different chart" (`<Chart>` keeps live state for the first and
starts afresh for the second); `translatePathData(d, dx, dy)` shifts every absolute coordinate of an SVG path string by `(dx, dy)`,
copying arguments that do not move (relative deltas, arc radii and flags) verbatim.

#### `@aster-charts/core/transition`

`createSceneTransition(from, to, { easing?, maxItems? })` returns `{ from, to, moves, items, at(t) }`: `at(t)` is the scene at
linear progress `t` (eased with `easing`, default `'cubic-in-out'`), `at(1)` (and above) is `to` itself, and below 1 every call
returns one scene object rewritten in place. `moves` is false when the two scenes draw alike, or when more than `maxItems` items
would move (no limit by default; planning stops at the first one past it); `items` is how many move. `from` may be a frame of a running transition (an
interruption starts from it). Items are paired by the mark's `key` (else by index), facet group items by their `groupby`, axis
grid lines, ticks and labels by tick value; what moves, enters and leaves, and how, is in [ANIMATION.md](ANIMATION.md).
`easingFunction(easing?)` resolves a name or returns a function as given (an unknown name throws a `RangeError`);
`EASING_NAMES` lists the names. `drawsSame(a, b)` is whether two scenes (or nodes) draw the same: what a renderer reads is equal,
without looking into what they share by identity (`datum` and the engine's `__` stamps are not drawn); it answers false for what
it cannot compare, never true for scenes that draw differently. `createScenePlayer(paint, report, shown?)` is the frame loop `<Chart transition>` uses
(`requestAnimationFrame`; at once where there is none): `draw(target, scene, { duration, easing? } | null)` animates from the picture
on screen to `scene`, or with `null` makes `scene` the end of a running transition (same clock; a scene that `drawsSame` as that end keeps the plan) or draws it at once; `reset(scene)`
says what the target shows and `cancel()` stops the frames. `paint(target, scene)` draws a scene (`patchSceneDom`).

#### `@aster-charts/core/canvas`

`renderSceneToCanvas(scene, ctx, { dpr, batchSymbols })` paints a scene on a `CanvasLike` (a real 2D context, an
OffscreenCanvas context or a recording mock); `batchSymbols` (default `true`) merges long runs of identically painted symbols.
For streams: `snapshotCanvasScene(scene)` records what was drawn (`CanvasSceneSnapshot`) and `renderSceneToCanvasAppend(snapshot, nextScene, ctx, options?)`
paints only the appended items of the next scene on top of it; it returns `false`, having drawn nothing, when the
result would not equal a full repaint (anything but one mark group gained items at its end, a changed guide, a later group the new
items could cover), and the caller repaints in full. Path geometry: `parsePathData(d)` parses an SVG path string into absolute-command
segments (`PathSeg[]`: `M L H V C S Q T A Z`, relative commands included); `tracePath(sink, segments, tx?, ty?, arcs?)` replays them onto a
`PathSink` (the path methods of a 2D context) offset by `(tx, ty)`, with `arcs: 'bezier'` for vega's bezier approximation of an arc;
`canonicalPath(segments)` is the normalized text of parsed segments, the form in which canvas and SVG geometry are compared.
The renderer draws an image mark from the bitmap its item holds (`item.image`, an `ItemImage`) and never fetches. For image marks
drawn from a `url`: `sceneImageUrls(scene)` lists the urls that have no bitmap yet, `loadImages(urls, { timeoutMs, onError, who })`
loads them as vega's canvas does (`crossOrigin = "anonymous"`, at most `IMAGE_CONCURRENCY` (6) at a time, one deadline for all) and
resolves with the ones that loaded, and `withSceneImages(scene, bitmaps)` is a copy of the scene with those bitmaps in place (the
scene itself is not written). `<Chart renderer="canvas">` does this itself.

#### `@aster-charts/core/png`

`renderSceneToPng(scene, options?)` paints a scene with the canvas renderer and encodes it with the platform canvas (a `<canvas>`
element, else an `OffscreenCanvas`), resolving to a `Blob` of type `image/png` of `ceil(width * scale)` x `ceil(height * scale)`
pixels: the pixels `renderSceneToCanvas` paints at that `dpr`, background included (none: transparent). Nothing is serialized
to SVG and no `blob:` or `data:` url is loaded into an `<img>`, so it works under a Content-Security-Policy whose `img-src`
allows neither. It waits for `document.fonts.ready`. `PngOptions`: `scale` (pixels per scene unit, default 1, a finite number
above 0), `imageTimeoutMs` (the wait for all the image marks' images together; default `PNG_IMAGE_TIMEOUT_MS`, 10 000, at most
`PNG_MAX_IMAGE_TIMEOUT_MS`, 2 147 483 647, what a timer can wait) and `onImageError(url, error)`.

Image marks are drawn from their `url`s (already vetted by the chart's `urlPolicy`; the svg draws the same urls): each url is
loaded once, as vega's canvas loads images, with `crossOrigin = "anonymous"`, so the canvas stays readable; at most
`PNG_IMAGE_CONCURRENCY` (6) load at a time, and when `imageTimeoutMs` has passed the loads still running are abandoned (their
requests cancelled) and the ones not started are not made, so an export never waits longer than that for images. The canvas is
made once they are in. An image that does
not load (a network error, a server on another origin that does not allow CORS, the timeout, or no `Image` in a worker) is left
out of the PNG and reported to `onImageError`. A bitmap the scene already holds (a `heatmap`'s) is drawn as it is. The scene is
not modified. Rejects with a `RangeError` for an invalid `scale` or `imageTimeoutMs`, a scene without area, or an image wider or
taller than `PNG_MAX_SIDE` (32 767) or larger than `PNG_MAX_PIXELS` (268 435 456, 16 384 squared) pixels; with an `Error` when
there is no canvas, when the canvas cannot be read back (a bitmap the host put in the scene from another origin without CORS), or
when the browser will not encode it (a device may refuse canvases far below the caps).

#### `@aster-charts/core/load`

`loadSpecData(spec, { baseURL, allow, protocols, timeoutMs, maxBytes, ... })` for URL datasets, with a URL policy (safe defaults, see `docs/LIMITS.md`).
`LOAD_DEFAULTS` holds the numeric defaults (`timeoutMs`, `maxBytes`, `maxConcurrent`, `maxRedirects`) and `TRUSTED_LOAD_OPTIONS`
is the policy for a host that loads its own specs only (any http, https or data URL, private hosts included): never use it for specs
you did not write. `isNonPublicHost(hostname)` is the check behind `allowPrivateNetwork`: `true` for `localhost` and local-only
suffixes, loopback, private, link-local and reserved IPv4 addresses and their IPv6 equivalents. `readData(data, format?)` reads
data by a Vega `format` spec (`type`, `parse`, ...) the way vega-loader's `read` does, through the registered reader of the type and then
`coerceRows`; `coerceRows(rows, parse)` converts the columns that `parse` names (a column type, a `date:<pattern>` /
`utc:<pattern>`, or `'auto'` to infer from the first row) and returns copies. `dataFormatRegistry` and `AsterUrlError` are
re-exported here.

#### `@aster-charts/core/geo` and `@aster-charts/core/transforms`

Importing them registers the projections / rare transforms; load them
before rendering a spec that needs them (otherwise rendering throws an error naming the import, see `docs/ERRORS.md`).

#### Example: hit-testing a scene

```ts
import { renderSpec, type SceneRoot, type VgSpec } from '@aster-charts/core'
import { buildHitIndex } from '@aster-charts/core/hit'
import { createChartSession } from '@aster-charts/core/dom'

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

## `@aster-charts/react`

### Components and hooks

#### `<Chart>`

```tsx
import * as React from 'react'
import { Chart, type ChartHandle, type SelectValue, type ViewDomain } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

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
`<Suspense>`). Vega-Lite is an opt-in add-on — import it once before rendering VL
specs:

```ts
import '@aster-charts/react/vl'   // side effect: registers the from-scratch VL compiler
```

**Add-ons load themselves.** A spec that needs an opt-in core add-on (`@aster-charts/core/transforms`, `/geo`, `/load`) renders with nothing
imported: `<Chart>`, `<SvgChart>`, the hooks and the worker entry import what the spec needs (`addonsNeeded` in `@aster-charts/core/addons`),
and the chart suspends meanwhile, so put a `<Suspense fallback>` above it. The synchronous entry points (`renderSpec`,
`renderChartToStaticMarkup`, `hydrateChart`) cannot wait: `await loadAddonsFor(spec)` before them. The rules, server rendering,
workers and `url` data are in [ARCHITECTURE.md](ARCHITECTURE.md#geo-projections--the-add-on-boundary).

The base `@aster-charts/react` entry does not include the Vega-Lite compiler; importing `@aster-charts/react/vl` adds about 103 kB
gzip to the bundle (`<Chart>` 205.3 kB, `<Chart>` + `@aster-charts/react/vl` 308.3 kB eager, measured 2026-11-06 by
`pnpm --filter @aster-charts/benchmarks run budget`; the budgets and current figures are in [PERFORMANCE.md](PERFORMANCE.md#bundle-sizes)). Passing a VL spec without the add-on throws an error naming the missing
import. Vega specs need no extra import. Worker hosts must import `@aster-charts/react/vl` in the worker entry as well,
since compilation happens there.

**Props.** `spec` (compared by content: an equal inline literal does no work; the one exception is a dataset's inline `values` array, which is compared by identity, so a re-created but equal rows array is a new input, which the session's row diff finds unchanged and applies as a no-op; the streaming components keep the full content comparison, so a spec rebuilt every render does not restart a stream), `data`, `dataChanges`, `width`,
`height` (each independent; without them the chart measures its container; a given one fixes the view's size, even for a container-sized spec, whose `width` / `height` signals and `window:resize` handlers do not move it. The measured container only sizes a spec that has no `width` / `height` signal of its own, and a dimension the spec gives no value at all stays Vega's 0 grown to the content by autosize. It sizes the chart's whole box, padding, guides and the bound inputs under the chart included, as Vega-Lite's `"container"` does (autosize `fit` containing the padding): the content shrinks to fit, so a chart never overflows the container it fills, and a container whose height is the chart's own (a block `<div>` with no height) keeps the chart's size instead of growing with it; one that drives them (a bound input, a handler, Vega-Lite's `"container"`) keeps doing so, as in Vega where the size is a signal and the later write wins, and sees the container through `containerSize()`), `ariaLabel`, `className`, `style`,
`signals`, `signalListeners`, `onSignal`, `interactive`, `preventDefault`, `renderer`, `incremental`, `denseMarks`, `transition`,
`tooltip`, `renderTooltip`, `selection`/`select`, `onSelectionChange`, `onSelect`, `onPointSelect`, `brush`, `panZoom`,
`pan`, `zoom`, `view`, `onViewChange`, `maxZoom`, `a11y`, `limits`, `urlPolicy`, `urlData`, `random`, `logger`, `textMetrics`, `onError`.
`urlData="refuse"` refuses a spec with a `url` dataset before any add-on loads and before evaluation: the chart renders its error
state and `onError` receives the `AsterUrlError` (see `RuntimeInput.urlData`).

**Internal props.** `sceneOverride` and `onStreamInput` are host plumbing for `<ChartStream>` and `<ChartWorkerStream>`, which are
built on `<Chart>`. They are internal and unstable: their shape can change in any release and they are not covered by semver. Do not
use them in an application. `sceneOverride` (`SceneRoot | null`) makes the chart render that pre-evaluated scene instead of evaluating
`spec` (`undefined` keeps the normal path, `null` renders the loading or error state), so a streamed scene goes through the same
DOM patcher, canvas renderer, interaction and accessibility tree. `onStreamInput(input)` receives what the chart derives from its props and
gestures, `{ domainRaw?, signals }` (`ChartStreamInput`: the `domainRaw` of the pan/zoom view and the merged signal values), so the
stream can re-evaluate with them.

**`data` and `dataChanges`.** `data` is a `Record<string, unknown[]>`: the key is the *dataset name* in the spec, the
value its rows. A bare array does not typecheck (`data={newRows}` is an error); write `data={{ table: newRows }}`. A new
array for a dataset is diffed against the previous one (appends and in-place edits re-encode only the affected rows).
`dataChanges={{ table: [3, 7] }}` is an optional hint with the same meaning as in the session; it is validated, and an
unknown dataset, a non-integer or out-of-range index or a changed row count makes the whole changeset be ignored
(the update is diffed in full, so the chart is still correct) and `onError` receives an `Error` describing it.

**Ref.** The ref (`ChartHandle`) exposes `getScene()`, `getSvg()` (serializes the current scene), `getPng(options?)` (see
[PNG export](#png-export)), `getChartInfo()`, `getView()`, `setView()`, `resetView()`, `setSignal(name, value)` and `getSignals()`. `setSignal` runs the spec's
dependent signal updates when the SVG event loop is bound; on canvas or with `interactive={false}` it applies the value
as a signal override. Listeners (`signalListeners`, `onSignal`) are notified either way.

`denseMarks` (SVG only) batches dense symbol marks into chunked `<path>` elements
instead of one element per datum. Positions are baked into `d`, so the pixels match; tooltips,
point selection and the a11y tree resolve through the scene.

- `'auto'` (default) batches a symbol mark with at least 512 items unless the spec has
  `signal.on` event streams (a conservative default: the event loop resolves `event.item` through the scene hit index, not per-item DOM nodes). Each path holds up to
  256 symbols, so 100,000 points become 391 paths.
- `true` always batches (still only marks with at least 512 items), `false` disables.
- Client-only mounts batch directly. SSR/hydrated pages emit the per-item markup on
  the server (so hydration matches) and switch to batched in place after hydration.
- A mark with `href` links is never batched.

Pan, zoom and brushing are driven through scale `domainRaw`; the gestures, the keyboard contract and the rule that
picks the scales are in `docs/INTERACTION.md`.

`transition` (SVG; off by default) animates a change of data: `true`, or `TransitionOptions` `{ duration?: number /* ms, 300 */,
easing?: EasingName | ((t) => number) /* 'cubic-in-out' */, reducedMotion?: 'user' | 'always' | 'never' /* 'user' */, maxItems?: number /* 1000: a change that moves more items is drawn at once */ }`.
New `data` rows, new inline rows in an equal spec, a streamed scene and a Vega-Lite `time` animation's next frame are drawn as
frames from the picture on screen to the new scene, which is the last frame; anything else (signals, pan / zoom, size, legend
toggles) is drawn at once, or becomes the end of a transition that is running. Items are matched by the mark's `key`, else by
index. Hit testing, tooltips and the accessible tree use the new scene throughout. The canvas renderer, batched `denseMarks`
and `incremental={false}` draw at once; `@aster-charts/core/transition` is loaded on demand once the prop is set. Read when a
transition starts, so an options literal made anew on every render restarts nothing. Behaviour and costs: [ANIMATION.md](ANIMATION.md).

#### PNG export

`getPng(options?)` on the ref resolves to the chart as a PNG `Blob`: `getScene()` (the scene `getSvg()` serializes) painted by
the canvas renderer and encoded by the browser, or `null` while there is no scene. It takes `PngOptions` (`scale`,
`imageTimeoutMs`, `onImageError`; see [`@aster-charts/core/png`](#aster-chartscorepng)); an image mark that does not load is left
out and, without `onImageError`, reported to the chart's `logger` as a warning (the console by default). The painter is
`@aster-charts/core/png`, imported on the first call, so a bundler that splits code puts it in a chunk only an export fetches.
It loads no image from a `blob:` or `data:` url, which is what the usual recipe (the svg in an `<img>`, drawn onto a canvas) needs
and what a strict `img-src` forbids.

```tsx
import * as React from 'react'
import { Chart, type ChartHandle } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

export function Exportable({ spec }: { spec: VgSpec }): React.ReactElement {
  const ref = React.useRef<ChartHandle>(null)
  const save = async (): Promise<void> => {
    const blob = await ref.current?.getPng({ scale: 2 })
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'chart.png'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return <><Chart ref={ref} spec={spec} /><button onClick={() => { void save() }}>Save as PNG</button></>
}
```

`<SvgChart>` leaves out the canvas renderer, so its `getPng` needs the `png` capability: `import { png } from
'@aster-charts/react/png'` and pass `png={png}`. Without it `getPng` rejects with `[aster] getPng needs the png capability: ...`.
With it the painter and the canvas renderer are still loaded only by the first export.

#### `<SvgChart>` and the `interaction` capability

`<SvgChart>` is the SVG-only chart for size-sensitive apps: the same engine and the same DOM as `<Chart renderer="svg">`
(it is a second shell over the one implementation, see [ARCHITECTURE.md](ARCHITECTURE.md#chartcore-and-the-two-shells)),
minus what an SVG-only app does not use. It lives in its own entry and never imports the canvas renderer.

```tsx
import * as React from 'react'
import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'
import type { VgSpec } from '@aster-charts/core'

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

**The capability.** `interaction` (from `@aster-charts/react/interaction`) is a plain frozen value bundling hit testing
(`@aster-charts/core/hit`) and the signal event loop (`@aster-charts/core/signals`: `bindSceneSignals`). It is passed as
a prop: there is no registry, no global and no side-effect import (`sideEffects` needs no entry), so a bundler drops it
when it is not imported and `<SvgChart>` without it contains none of that code. `<Chart>` has it built in.

**Typing.** `SvgChartProps` is a union on `interaction`. These props exist only with it, and passing one without it is a
compile error: `tooltip`, `renderTooltip`, `onPointSelect`, `selection`, `select`, `onSelectionChange` (a click resolves
the mark under the pointer through the hit index) and `preventDefault` (it acts on the `signal.on` event loop).
`renderer` does not exist on `<SvgChart>` (it is always SVG). Every other `ChartProps` key is shared with the SAME type, and
the ref (`SvgChartHandle`) has every `ChartHandle` member; `src/parity.assert.ts` makes the compiler enforce both, so a prop
added to `<Chart>` without a decision about `<SvgChart>` fails `pnpm typecheck`.

```tsx
import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'
import type { VgSpec } from '@aster-charts/core'

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
| a spec with `signal.on` streams, no `interaction` | `[aster] this spec has event streams (signal.on) but no event loop is bound: pass interaction={interaction} from '@aster-charts/react/interaction'` |
| `tooltip`, `renderTooltip`, `onPointSelect`, `selection`, `select`, `onSelectionChange` or `preventDefault` without `interaction` (ignored) | `[aster] tooltip, … need hit testing and the signal event loop and are ignored: pass interaction={interaction} from '@aster-charts/react/interaction'` |
| `renderer="canvas"` (renders SVG) | `[aster] renderer="canvas" needs <Chart>: <SvgChart> has no canvas renderer, so it renders SVG` |
| `getPng()` without `png` (the promise rejects) | `[aster] getPng needs the png capability: <SvgChart> leaves out the canvas renderer it paints with; import { png } from "@aster-charts/react/png" and pass png={png}` |

Without `interaction`, `setSignal` and bound inputs (`signal.bind`) still work as signal overrides, exactly as on
`<Chart renderer="canvas">`; the spec's `signal.on` updates do not run. Server markup is identical with or without
`interaction`, and equals vega's: no per-item datum attribute is written (the mark under the pointer is found through the scene
hit index).

Sizes (gzip, eager, measured 2026-11-06 with `pnpm --filter @aster-charts/benchmarks run budget`): `<Chart>` 205.3 kB,
`<SvgChart>` 182.5 kB, `<SvgChart>` + `interaction` 199.7 kB ([PERFORMANCE.md](PERFORMANCE.md#bundle-sizes) holds the
current figures). Use `<Chart>` unless that 23 kB
matters; it is the zero-setup default and its behaviour does not depend on this component.

#### Hooks

```tsx
import * as React from 'react'
import { useChart, useChartData, useChartWorker, useSpecData } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

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
`@aster-charts/react` is the non-Suspense equivalent.
`loadSpecDataResource(spec, options?)` is the promise `useSpecData` reads with `React.use`: it is created once per spec object and set
of options (a repeat call returns the same promise, as Suspense needs) and imports the load add-on lazily, so an app without URL
datasets never bundles it. A failed load is dropped from the cache so the next render retries. `isPromiseLike(value)` is the
type guard for a `then`-able (the check `<Chart>` uses to tell an async `spec` from a spec).

#### Streaming components

```tsx
import * as React from 'react'
import { ChartStream, type ChartStreamHandle } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

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
batches, so scales, marks and guides recompute inside the stream; `limits`, `textMetrics`, `urlPolicy` and `urlData` configure
the stream's evaluation (a change of `urlData` starts a new stream); rendering, selection, tooltip, a11y and event props go to the underlying `<Chart>`.
The ref (`ChartStreamHandle`) has `push`, `flush`, `pending`, `pulse`, `stats`, `scene` and `close`.
The hook form is `useChartStream(spec, options)` (and `useChartWorkerStream` for a worker), described under
[Streaming and pulses](#streaming-and-pulses).

- **SSR.** `<ChartStream>` primes its first scene synchronously, so a server render contains the full chart
  markup (the same markup `<Chart>` emits). `<ChartWorkerStream>` has no worker on the server and renders an empty
  `<div data-testid="chart-worker-stream-loading">` until it mounts and the worker answers.
- **Errors.** A failed flush renders `<div role="alert">` with the message and reports once through `onStreamError`;
  the failed batches are discarded so the next flush recovers (`failure.discarded` says how many).

#### Workers

`useChartWorker` offloads compile/evaluate/render to a Worker and returns `{ svg, scene, error, pending }`;
`useChartWorkerStream` and `<ChartWorkerStream>` run a stream in a Worker. Without a Worker (no `worker`, and
`workerFactory` missing or returning `null`) the same request is handled synchronously, but from an effect: on the
server nothing runs, so `useChartWorker` returns `pending: true` with `svg: null` there, and in jsdom (no `Worker`) it
evaluates after mount.

```ts
// chart.worker.ts: the worker entry (a bundler builds it with `new Worker(new URL(...), { type: 'module' })`)
import '@aster-charts/react/vl'                       // only if the worker must compile Vega-Lite
import { registerWorkerTextMetrics, registerWorkerUrlPolicy } from '@aster-charts/react/worker'
import '@aster-charts/react/worker-entry'             // installs the message handler (self.onmessage)

registerWorkerTextMetrics('inter', { measure: (text, _font, size) => text.length * size * 0.55 })
registerWorkerUrlPolicy('cdn-only', { allow: (url) => url.hostname === 'cdn.example.com' })
```

```tsx
import * as React from 'react'
import { useChartWorker } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

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
- **`urlData`** (`useChartWorker(spec, { urlData })`, a stream's `initial.urlData`) travels with the request. With `'refuse'` the
  worker imports no add-on for a spec that has a url dataset and answers with the refusal (`code: 'ASTER_URL_DENIED'`).
- **`textMetrics` and `urlPolicy` by name.** A provider object or a policy with functions cannot cross `postMessage`.
  Register it in the worker with `registerWorkerTextMetrics(name, provider)` / `registerWorkerUrlPolicy(name,
  { allow, onDeny })` (both from `@aster-charts/react/worker`, called in the worker entry) and pass the name
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
- **Worker entry internals.** `@aster-charts/react/worker-entry` is built from these, exported from `@aster-charts/react/worker` for a worker script of your own:
  `createWorkerDispatcher(streams, post)` returns the message handler (`message => void`; `streams` is the `Map<number, ChartStream>` the stream
  requests share, `post` sends a response). It handles messages in arrival order and imports the add-ons a message's spec needs first, so a stream's
  `flush` never overtakes its `init`. It is made of `handleWorkerMessage(data, streams)`, which validates one message (a recognisable id gets a
  typed `TypeError` response, anything else is dropped as `null`) and calls `handleChartWorkerRequest` or `handleChartWorkerStreamRequest`;
  `prepareWorkerMessage(data)`, which normalizes the message's spec to Vega and returns `{ data, missing }`, the add-ons not loaded in this realm;
  and `handleWorkerMessageWithAddons(data, missing, streams)`, which imports `missing` and then handles the message (an import that
  fails answers that message with a typed error). `errorFromWire({ name, message, code? })` rebuilds the `Error` of a worker response
  (an `AsterLimitError` for `code: 'ASTER_LIMIT'`).
- **Host plumbing (`@internal`).** The hooks are built on helpers that the entry also exports and that are not a stable surface:
  `useWorkerInstance(worker, workerFactory)` owns the `Worker` of a hook (the supplied one, else the factory's, terminated on unmount) and
  returns a ref to it; `listenToWorker(worker, onMessage, onFailure)` attaches the message, `error` and `messageerror` listeners and returns the
  cleanup; `wireTextMetrics(textMetrics, viaWorker)` and `wireUrlPolicy(policy, viaWorker)` throw the errors that refuse a provider object or
  a policy with functions when a Worker is in use; `resolveWorkerTextMetrics(textMetrics)` and `resolveWorkerUrlPolicy(policy)` are the
  worker-side lookups of a registered name (they throw for an unknown one).

#### SSR + hydration

```tsx
import { renderToString } from 'react-dom/server'
import { Chart, hydrateChart, renderChartToStaticMarkup } from '@aster-charts/react'
import type { VgSpec } from '@aster-charts/core'

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

`renderChartToStaticMarkup` and `hydrateChart` (also exported from `@aster-charts/react/ssr`) accept either grammar and
apply `limits` like the client. A `<Chart>` on the server renders its markup in the HTML; the canvas renderer renders
an empty `<canvas>` there.

### Reference

#### Registry and session re-exports

`@aster-charts/react` also exports `registerVegaLiteCompiler(compile)` and `hasVegaLiteCompiler()`, the registry that `@aster-charts/react/vl` fills as a
side effect (see [`@aster-charts/vl`](#aster-chartsvl)): a host that bundles `@aster-charts/vl` itself registers `(spec) => vegaSpec` once, and `hasVegaLiteCompiler()`
says whether one is registered. `createChartSession` is `@aster-charts/core/dom`'s, re-exported for a host that renders through the
session ([Sessions and per-datum updates](#sessions-and-per-datum-updates)).

#### Pan, zoom and selection helpers

The pure functions behind `<Chart>`'s selection, pan and zoom are exported from `@aster-charts/react`, for a host that draws its own
controls or keeps the state outside the component. A `ViewDomain` is `{ x?: [number, number], y?: [number, number] }`, the visible
domain of the horizontal and vertical continuous scales; a `SelectionInterval` has the same shape; `PixelPoint` is `{ x, y }`.
`names` is the `PositionalScales` (`{ x?: scaleName, y?: scaleName }`) that says which scales are the horizontal and vertical ones
(default: scales named `x` and `y`). The `info` argument is the `ChartInfo` of the evaluated scene (`getChartInfo`, or
`ChartHandle.getChartInfo()`).

- `domainOf(scale)` reads a continuous scale's `[min, max]` domain, or `null` when the scale has no invertible numeric domain.
- `continuousAxes(info, names?)` lists which of `'x'` and `'y'` have such a domain, that is, which axes can pan and zoom.
- `zoomDomain(domain, anchor, factor, minSpan?)` scales a domain around an anchor value (`factor > 1` zooms in) and keeps its
  orientation; `panDomain(domain, fraction)` shifts it by a fraction of its span (positive: toward higher values).
- `cursorZoom(current, base, axis, anchorValue, factor)` zooms one axis of a view around a cursor value: zooming in stops at 1/1000 of the base
  span, and zooming out past the base domain returns the base domain.
- `keyboardView(key, current, base, { fast?, axis?, anchor?, pan?, zoom? })` is the keyboard contract (arrows pan, `+` / `-` zoom by 1.5x,
  `0` / `Home` reset). It returns `{ handled, view? }`, where `view: null` means reset; `pan: false` / `zoom: false` disable those keys.
- `normalizeView(view, base)` validates a controlled view against the chart's base domains and returns `null` for "not zoomed" (empty,
  non-finite, or equal to the base).
- `viewToDomainRaw(view, names?)` turns a view into the `RuntimeInput.domainRaw` override, keyed by the positional scale names.
- `dragToDataInterval(start, end, info, names?)` converts a container-local pixel drag into a `SelectionInterval` (an axis whose scale cannot
  be inverted, like a band scale, is left out); `selectionToPixels(selection, info, names?)` is the reverse, `{ x, y, width, height }` in pixels
  of the SVG.
- `selectValueToInterval(value)` and `selectValueToDatum(value)` read the interval or the point datum out of a `SelectValue`
  (`{ type: 'interval', interval }` or `{ type: 'point', datum }`), `null` for the other kind.

#### Accessibility keyboard contract

A chart is one Tab stop. Without pan or zoom the accessible tree is a roving-tabindex group (exactly one node is the stop);
with pan or zoom the container is the stop and `PageDown` / `PageUp` on it enter the tree. The keys, per node kind, are listed in
`docs/INTERACTION.md#accessibility`.

## `@aster-charts/vl`

### Compile a Vega-Lite spec

```ts
import { compile } from '@aster-charts/vl'

const vegaSpec = compile({
  data: { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
})
console.log(Array.isArray(vegaSpec.marks))
```

`<Chart>` and `useChart` use this compiler for Vega-Lite input once
`@aster-charts/react/vl` is imported, so a fresh app does not need a `vega-lite`
dependency. Hosts that already bundle `@aster-charts/vl` themselves can instead call
`registerVegaLiteCompiler` from `@aster-charts/react` with a function `(spec) => vegaSpec`;
`hasVegaLiteCompiler()` reports whether one is registered. `compile` throws `VLCompileError` for
anything outside the supported subset (see `docs/ERRORS.md`).

`compileUnit(spec)` compiles a spec that is a single unit (`mark` and `encoding`) to Vega; it validates its input and does not mutate it. For a
unit spec it returns the same Vega spec as `compile`. It does not handle `layer`, `facet`, `concat` or `repeat`
specs (it fails with a `TypeError`, not a `VLCompileError`): use `compile` for anything that is not known to be one unit.

### Maps and animation

Vega-Lite maps (`geoshape`, `projection`, `longitude` / `latitude`, `{type: "geojson"}`) and animation (the `time`
channel with a `timer` point selection and `{filter: {param}}`) compile to what vega-lite 6.4.3 emits; what throws is listed in
[packages/vl/README.md](../packages/vl/README.md#throws-not-supported). Running an animation needs
the signal event loop (`<Chart>` or `<SvgChart interaction>`): `timer` streams run on one scheduler, with d3-timer's schedule, shared by the page,
stop on unmount. `setTimerClock(clock | null)`, imported from `@aster-charts/core/signals`, drives the shared scheduler (and so every
`timer` stream) from `clock` instead of the host's globals; `null` goes back to them. A clock is `{ now, setTimeout,
clearTimeout, setInterval, clearInterval, requestFrame }`. It is the seam for a test, or a host that steps frames itself. Swap
it only while no timer is live: a timer's pending wake-up belongs to the clock it was scheduled on. `bindSceneSignals(..)`
takes `{ owner, data }` (the element the timers belong to, the datasets the loop starts from), an `onData` hook, and returns a
binding with `release()`.
