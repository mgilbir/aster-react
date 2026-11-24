# Limits (untrusted specs and data)

## Recommended starting points

These are suggestions (a judgement, not measured defaults).

- **Public dashboard:** 100k rows, 50k items, 8 MB SVG, 2 s wall clock, and `maxGeneratedRows: 500_000`.
- **Unknown spec on a server:** use smaller numbers (10k rows, 250 ms), a `loadSpecData` allowlist, and a **killable worker** for the render.
- **Specs that need no regular expressions:** add `regex: 'refuse'` (any of the above). The screen below is a static model, conservative but not a proof; refusing is
  the only way to rule out a pattern that blocks the thread (see "Refusing every regular expression").

For an untrusted spec you need all three of these; `limits` alone is best-effort (see the two layers below):

1. `loadSpecData` with an `allow` hook for the origins you serve data from, and the same `limits`.
2. `limits` on the render itself.
3. The render in a `worker_threads` Worker (or a child process) that you `terminate()` when your own deadline passes. The kill is the hard guarantee; `limits` produce the friendly typed errors in the common case.

```ts
import { renderSpec, type SpecLimits, type VgSpec } from '@aster-charts/core'
import { loadSpecData } from '@aster-charts/core/load'

// Run this inside the Worker you can terminate().
const limits: SpecLimits = { maxRows: 10_000, maxItems: 50_000, maxSvgLength: 8_000_000, maxTimeMs: 250, regex: 'refuse' }

async function render(untrusted: VgSpec): Promise<string> {
  const loaded = await loadSpecData(untrusted, {
    allow: (url) => url.origin === 'https://data.example.com',
    limits,
  })
  return renderSpec(loaded, { limits })
}
```

In React, `<Chart limits>` and the worker hooks take the same `limits` ("In React and workers" below); the pieces of the model follow.

Data and specs are untrusted input. `SpecLimits` are the budgets; `loadSpecData`
takes a URL policy; image marks and `href` links share that policy. Every limit is
optional: a dimension you do not set is unbounded. There are no default numbers for
`SpecLimits` (the values below are examples, see "Recommended starting points"), with one
exception: once a `limits` object is present, even `{}`, a regular expression's input is capped at
10 000 characters (raise it with `maxStringLength`). What else switches on with a `limits` object is
under "Passing a `limits` object at all" below. A `limits` object is read as given, wherever a scope
opens (`renderSpec`, a session, a stream flush, `evaluateChart`, the worker handler, `checkSpecLimits`,
`checkSceneLimits`, `checkSvgLength`, `createLimitClock`): a key that is no limit (`maxrows`), or a budget
that is not a number `>= 0` (`NaN`, `'5'`, `null` from a JSON `NaN`, `-1`), is a `TypeError`, never read as
no budget. `Infinity` is a budget: it removes the cap of its own and replaces the ceiling it stands for.

**What this protects, and what it does not.** There are two layers.

- `limits` are **best-effort protection**. They are cooperative: counters and a wall clock
  checked at the sites that spend (see "How the budgets are enforced"). They turn the
  common abuse of a spec into a friendly, typed `AsterLimitError`, but a single
  synchronous native call cannot be interrupted (a regular expression, an engine
  allocation), and nothing in-process can promise otherwise.
- **The killable worker is the hard guarantee** for untrusted specs: render in a
  `worker_threads` Worker or a child process with a memory cap and a deadline, and
  `terminate()` / kill it when the deadline passes. Whatever `limits` miss, the kill covers.
- A small set of **built-in ceilings** (next section) holds even when no `limits` are given.
  They exist for one reason: a few inputs let a spec of a few hundred bytes (or a few
  hundred KB) exhaust the process, and "every limit is optional" should not mean a fatal
  out-of-memory for someone who never wrote `limits`. They are not a budget for charts.

## Built-in ceilings (active without `limits`)

Each ceiling bounds an amount that the SPEC controls and that is expensive in memory
(tens to hundreds of MB, or a fatal out-of-memory) long before the chart is large. It throws
the usual `AsterLimitError` (`code: 'ASTER_LIMIT'`), naming the amount, the ceiling and the limit
that raises it, for example
`[aster] limit exceeded: range 50000000 > 1000000 (built-in ceiling that applies even without limits; raise it with limits.maxRows)`.
Giving the matching limit replaces the ceiling by your number (your budget governs), and that limit is
then compared at the same site, before anything is allocated: a `limits` object is never less safe than
none (`{ maxGeneratedRows: 1000 }` alone refuses 5e7 `density` steps where it is the budget). Giving
unrelated limits (`limits: {}`, `{ maxStringLength }`) leaves the ceiling in force. They are exported as
`HARD_CAPS` and `HARD_MAX_SPEC_DEPTH` from `@aster-charts/core`.

The ceilings are taken where the thing is made, not at the call site that happened to be found: the
allocating primitives size themselves (`range`, numeric `ticks`, every calendar interval's range, the label
and word-cloud rasters, the contour scan, the geo event buffers), so a function is bounded whoever calls
it. A count the Array constructor refuses by itself (2^32 and up) is left to it, so it fails as vega's
does (`RangeError: Invalid array length`); every other count past a ceiling is an `AsterLimitError`, at
any size. For the transforms that multiply rows, what is bounded is what they add beyond the rows they are
given: a pipeline that does not amplify is never refused for the size of the data it is given.

| Ceiling | Value | Where it applies | Replaced by | Largest seen in the gallery / corpus / test suites |
|---|---|---|---|---|
| `rows` | 1 000 000 | array entries one generator or expression builtin makes: the `sequence` transform and `range` (and so a scale's `bins: {step}`), expression `sequence(...)`, `timeSequence(...)` and `utcSequence(...)`, `quantile` (groups x probabilities), `kde` (groups x steps) and `density` steps; and what the multiplying transforms add beyond their input: `cross`, `fold`, `flatten`, `impute`, `pivot` cells (groups x columns), an `aggregate` with `cross` | `maxRows`, `maxGeneratedRows` | 5 852 (a `cross`; `sequence` in the gallery: 1 000; `range`: 5 000; `density` steps 200) |
| `cells` | 10 000 000 | typed-array grids sized by spec parameters: `heatmap` pixels (ceil(width) x ceil(height) of its window), `kde2d`/contour density grids, the label bitmap, a contour scan's row buffers | `maxRows`, `maxGeneratedRows` | 58 200 (a `kde2d` grid), 2 448 heatmap pixels |
| `items` | 100 000 | counts a spec sets, and what they make: numeric `ticks` (axes, legends, a gradient legend's default count), axis ticks drawn, legend entries listed, the ticks of a log scale with a whole `base` (every multiple of every power in the domain: a base in the millions makes millions), time ticks, the steps of one search of a stepped calendar interval (`{interval: 'week', step: 2e7}`, `timeOffset('quarter', d, 4e6)`), trellis `layout.columns`, `contour` / `isocontour` `levels` and thresholds, a colour scheme `count`, quantized colour samples | `maxItems` | 551 axis ticks, 30 facet columns, 40 thresholds |
| `bytes` | 1 000 000 | one string an expression builtin builds: `pad`, number-format width (and, under limits, `join`, `replace`, `upper`, `lower`, `trim`, `truncate`, `substring`, `slice`) | `maxStringLength`, `maxGeneratedBytes` | 5 000 (`pad`), 982 (format width) |
| `coords` | 2 000 000 | positions one topojson decode produces (an arc referenced by many geometries counts every time), the positions of a `graticule` (lines x points per line) | `maxRows`, `maxGeneratedRows` | 101 000 (the gallery's largest map: 55 713) |
| `filledCells` | 1 000 000 | cells one delimited-text read (csv, tsv, dsv) fills in for fields a line does not have (`''` for each column a row lacks), the one part of a parse not bounded by the size of the text: a wide header over empty lines | `maxGeneratedRows` (they count against it) | 0 (no csv or tsv file of vega-datasets and no inline text of the corpus or gallery has a short line) |
| `work` | 100 000 000 | steps of a loop that is the product of spec or data sizes and allocates little: a contour scan (thresholds x declared grid cells) and its hole matching (holes x rings), a static `force` simulation (iterations x the steps of a tick), a `label` placement (labels x anchors and offsets), the candidates of a `cross` with a `filter` (n x n), a `regression` of a polynomial `order` (size² x points), a word cloud's spirals, the edge flips of a Delaunay triangulation. About a second of CPU | `maxTimeMs` (each such loop reads the clock) | 305 045 (a contour scan) |
| `pixels` | 16 000 000 | one raster a layout draws marks into: the `label` canvases (its `size`), the word cloud's board and sprite sheets | none | 250 000 (a word cloud's board; the label canvases run only on the gallery's browser path, not measured) |
| `vertices` | 4 000 000 | events one geo buffer holds: a shape's positions after projection, clipping and resampling (a projection's `scale` and `precision` multiply them) | none | 52 344 |
| `latticeTests` | 50 000 000 | the point-in-outline work of one `intersect()` of an arc, path, shape or geoshape item (vega-lite interval selections over geo marks, or the expression in any signal handler): the rows the item's outline spans inside the box, times its edges, plus each candidate point times its edges. A region beyond 2^52 is refused outright | none (`maxTimeMs` also bounds the walk, cooperatively) | 1 098 884 (the largest in the core test suites: a 3 000-row strip; not measured over the corpus, gallery or the intersect-browser gate) |
| spec depth | 1 000 (`HARD_MAX_SPEC_DEPTH`) | nesting of the spec object, checked iteratively when it is compiled (`values` data arrays are not walked); a deeper or cyclic spec is an `AsterLimitError` instead of a raw `RangeError` | `maxDepth` can only lower it | 12 |
| spec size | 5 000 000 objects | objects and arrays visited by that walk, by a session before it writes the spec's text, and by the pre-flight (`checkSpecLimits`) over the spec's own objects (a spec that shares sub-objects can otherwise make each exponential); inside `values`, a shared object is walked once | none | a few thousand |

How the values were chosen (the `rows` to `vertices` rows re-measured on 2026-11-23 over the corpus, the Vega-Lite corpus and the
gallery's Node path): the largest value each site reaches in the gallery (720 specs), the
corpus and the test suites is in the last column; every ceiling is 1 to 3 orders of magnitude above
it. The upper end is set by memory, not by taste: on Node a million generated rows costs about
150 MB, a 2-million-position topojson decode about 250 MB, and 5 million rows already fails with
`--max-old-space-size=512`. A real chart does not draw a million marks; a host that does can raise the matching limit.

`latticeTests` and `work` are the ceilings on work rather than memory. `work` holds without `limits`
and is replaced by `maxTimeMs`: every loop it bounds reads the clock, so a time budget stops it instead.
`pixels` and `vertices` are replaced by no limit: rows and items are other units.

`latticeTests` in particular: vega answers `intersect()` for an arc or path item by testing
every lattice point of the item's bounds within the box with `isPointInPath`; Aster gives the same answer row by row (the
winding test only changes where an edge crosses the row), so the work follows the rows the outline spans and its edges, not the
region's area. Past the ceiling, or for a region beyond 2^52 (where `x + 1` stops moving), `intersect()` throws an
`AsterLimitError` instead of answering. vega would not terminate on those inputs: its walk is over a region of more than
10^15 points, or never ends.

Not covered by a ceiling, deliberately: input that is large in itself (inline `values`, host `data`,
loaded files: they are data, not amplification; budget them with `maxRows`, `maxBytes`), and the
cumulative cost of many sites each just under its ceiling (that is what `maxGeneratedRows`,
`maxGeneratedBytes` and `maxTimeMs` are for, and for an untrusted spec the worker kill).
The lower-level functions (`ticks`, `range`, a calendar interval's `range`, ...) are bounded too, since
the ceiling is in them: they match d3 for every input under the ceilings, and the differentials that
compare them with d3 past them run with the ceilings off, by name (`unboundedForParity`, used by tests
only).

Calendar intervals end where d3-time does not (Q13 of the 2026-11-22 audit: matching an upstream hang is never intended). A
stepped or filtered interval searches one unit at a time for a date that passes its test; d3-time searches for ever once a step
leaves the Date range (an Invalid Date passes no test), and also where a local calendar makes a one-day step go round in circles
(Pacific/Apia skipped 2011-12-30). Aster's search ends with the Invalid Date at the end of the range, and one floor or one move
of more steps than the `items` ceiling is refused (with `maxTimeMs`, the clock is sampled at every step too). A UTC week interval
stepped by k (`every(k)`) jumps straight to the next multiple of k, so it answers any k at once; a local one walks, as a jump
across a daylight-saving gap can land elsewhere than the walk. Each of these is pinned by `scale-time-bounds.test.ts` and by the
d3-time differential, which runs up to the ends of the Date range.
Passing a `limits` object at all, even `{}`, turns the limits scope on: that enables
the pre-flight walk with its hard depth ceiling, the regular-expression screen (including the
10 000-character input cap, `maxStringLength`) and the default image/link URL policy described below.

```ts
import { renderSpec, type SpecLimits, type VgSpec } from '@aster-charts/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', values: [{ x: 1 }, { x: 2 }, { x: 3 }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { width: { value: 5 }, height: { value: 5 } } } }],
}

const limits: SpecLimits = {
  maxRows: 100_000,        // see "What maxRows counts"
  maxMarks: 200,           // mark definitions, recursive
  maxDepth: 32,            // spec object nesting (a hard ceiling of 1000 applies even when unset)
  maxStringLength: 10_000, // any string in the spec, a string a builtin builds, a regex input, any string an item draws
  maxItems: 50_000,        // generated scene items (and axis/legend/time ticks)
  maxPathLength: 1_000_000,// any generated or supplied path `d`
  maxSvgLength: 8_000_000, // length of the serialized SVG string
  maxTimeMs: 2_000,        // wall clock of one evaluation, see "What maxTimeMs covers"
  maxGeneratedRows: 500_000,   // cumulative rows produced by transforms/emitters in one evaluation
  maxGeneratedBytes: 5_000_000 // cumulative characters built by expression builtins
}

const svg = renderSpec(spec, { limits })
console.log(svg.length > 0)
```

## Which entry point enforces what

The budgets are not all enforced by every entry point. The meters (see below) run
inside any evaluation that has a `limits` scope; the pre-flight, scene and SVG-length
checks are separate calls.

| Entry point | Pre-flight (`checkSpecLimits`) | Meters (rows, items, time, strings, regex) | Scene check (`checkSceneLimits`) | `maxSvgLength` |
|---|---|---|---|---|
| `renderSpec` | yes | yes | yes | yes |
| `handleChartWorkerRequest` (`useChartWorker`) | yes | yes | yes | yes |
| `createChartSession().evaluate` | yes | yes | yes | no (you serialize) |
| `createChartSession().change` | no | yes, under the last evaluation's `limits` unless the change gives its own | yes | no |
| `createChartStream` flushes | yes (session) | yes | yes | no; `maxRows` also counts the rows the stream holds |
| `useChart` | yes (session) | yes | yes | yes when `serialize` is on (the default) |
| `<Chart limits>` | yes (session) | yes | yes | SVG renderer only: the scene is serialized once per evaluation to measure it, and only when `maxSvgLength` is set |
| `evaluateChart`, `getChartInfo` | no | yes | no | no |
| The event loop (`signal.on` handlers: `bindSceneSignals`, `<Chart>` interaction) | no | yes, per event | no | no |

So `evaluateChart` and `getChartInfo` do not apply `maxMarks`, `maxDepth`, the
spec-string check or the summed pre-flight row count, and they never check
`maxSvgLength` or the scene's `path`/`text` lengths. Call `checkSpecLimits`,
`checkSceneLimits` and `checkSvgLength` yourself if you build on the lower-level
functions (they are exported from `@aster-charts/core`).

The event loop runs each event under the limits its scene was evaluated with, so a
host passes nothing more: one scope and one wall clock per event, for the handlers'
expressions, the event-stream filters and what they re-evaluate. They meet the same
meters and the same regex screen (and `regex: 'refuse'`) as the evaluation. A
violation ends that event's run and is logged, as vega logs any handler error. The
loop keeps working, and the scene the handlers' signals lead to is evaluated under the
limits again. (Before 0.4.2 the loop ran without limits: a backtracking pattern in a
handler ran unscreened.) Every propagation of one event meets that clock, including the runs a
`modify` starts after the one that made it, and one event runs at most 1000 propagations (a
`modify` whose dataset feeds the signal that modifies it pulses again after every run; vega
recurses until the stack runs out); a dataset an event edits stays within `maxRows`.

### Interactive charts and untrusted specs: the threat model of the event loop

An interactive chart (`<Chart>`, or any host of `bindSceneSignals`) is meant to be safe for an untrusted spec. What a spec's
handlers can do is bounded as follows; each point is enforced in one place and tested.

- **What an expression sees of an event.** `event` is a frozen object whose only prototype is a frozen object of the engine's
  (no built-in one) answering the values Vega expressions observe, read off the event when an expression reads them, as vega's
  expressions read them, and only when they are a number, a string or a boolean (`type`, `vegaType`, the client / page / offset /
  screen coordinates, `button(s)`, `key`, `code`, the modifier keys, `deltaX/Y/Z/Mode`, `timeStamp`, the pointer fields, the
  touches as frozen copies, a timer tick's `timestamp` / `elapsed`: `EVENT_FACADE_FIELDS` in `signals.ts`; a type queued behind
  another sees `vegaType` as the event was handed over last) plus vega's extension (`item`, the scenegraph item;
  `vega`, the event functions `x()`, `y()`, `xy()`, `item()`, `group()`; `dataflow`). There is no target or current target
  node, no `view` (the window), no `composedPath`, no method. Expressions cannot call what they read, cannot read an inherited
  `Object.prototype` member or a function's `prototype`, and hand no function to a built-in (`expr-interpreter.ts`), so what
  a handler can reach is that graph; `signals.confinement.test.tsx` walks every path of it, for every kind of source, and
  checks that nothing belongs to the page.
- **Which events a spec can listen to.** The chart's own surface (`view` and `scope` sources) and timers, as
  `config.events` permits (vega's `permit`: `view: false`, `timer: false`, lists of types). `window` and CSS-selector
  sources reach beyond the chart, so the HOST decides them, through `SignalBindOptions.eventSources`: by default the
  window's pointer moves, ends and cancels and its `resize` (what Vega-Lite's interval drags and `width: "container"`
  listen to) and no selector source. A spec cannot read the page's keystrokes or its form fields, and cannot listen to an
  element outside the chart; its own `config.events` can only narrow the host's policy, never widen it. A blocked listener
  is reported once (`Blocked window keydown event listener ...`, then vega's `Can not resolve event source: window`).
  A host that renders trusted specs only can pass `eventSources: { window: true, selector: true }`. Where a host permits a
  source, the chart behaves exactly as vega does there: the browser parity gate (`conformance:signals`) runs its window
  cases (`window:keydown` / `keyup`, a press that bubbles to `window:mousedown`, a merged stream with a window source) with a
  policy that permits them and requires vega's signals, and runs the same sources under the default policy requiring that
  vega's signals move and Aster's do not. The default denies the page's keys deliberately (DECISIONS Q1): a spec from
  elsewhere must not read what is typed anywhere on the page.
- **What a spec can make the browser do.** The handlers' signals reach the scene, whose image and link URLs go through the
  URL policy (above); the event loop adds no other way out.
- **What outlives a binding** (timers, `between` windows, throttle and debounce clocks, `{signal}` handlers' memory, the
  `{scale}` sources' last view) is kept per host owner AND compiled chart: a different chart bound to the same owner starts
  afresh, as a new vega view does, and two charts of the same spec never share it.
- **What a delivery costs.** One event runs under the limits its scene was evaluated with (above).

## What `maxRows` counts

The pre-flight reads the spec's lists the way the compiler does (vega-util `array()`: a lone `data` object counts as a one-element list), so `checkSpecLimits` and the runtime agree on what is a dataset.

- **Pre-flight**: the sum of the rows the chart is given, each counted once: for every
  top-level dataset its host rows (`input.data` under its name, which replace its inline
  `values` rather than add to them), else its inline `values`; the inline `values` of nested
  group `data`; and every host array under a name no top-level dataset has. A dataset derived
  from others (`source`) is given no rows of its own, and host rows under its name are not
  used. Two datasets of 6 rows fail a `maxRows` of 10; a dataset of 6 inline rows whose host
  rows are 4 counts 4.
- **During evaluation**: each dataset on its own, after load, `source` and every
  transform step (not a sum). Datasets produced by `sequence`, `cross`, `fold` and the
  like count, so generated rows are covered. The cumulative total of generated rows is
  `maxGeneratedRows`.
- **`createChartStream`**: the rows the stream holds (base snapshot plus what the flush will
  add), checked before the flush is materialised; they reach the session as its host rows, so
  its pre-flight counts them once, in place of the spec's inline rows they started from.
- **`loadSpecData`**: rows of each loaded dataset (`limits.maxRows`; a csv's rows as they are
  read, before the next one is made), and decoded topojson coordinates (against
  `maxGeneratedRows`, else `maxRows`). The same holds for inline csv text read by `renderSpec`.

## What `maxTimeMs` covers

`maxTimeMs` is one wall-clock budget per `withLimits` scope, started when the scope opens.
`renderSpec`, `evaluateChart`, `getChartInfo`, a session's `evaluate`/`change` and the worker
handler each open one. It is checked at phase boundaries (`pre-flight`, `compile`,
`evaluate`, `render`) and, inside the evaluation, every 1024 rows/items or at each metered
site (see below). Every pass over the rows reads it as it goes, not only after it: the copy of
the rows a dataset is given, each transform's pass (a `formula` or `filter`'s expression per row,
the rows `bin`, `timeunit`, `identifier`, `lookup`, `project`, `geopoint` write, a `stack` or
`pivot`'s grouping), every 1024 comparisons of a sort of the data, and every 1024 nodes of a
hierarchy walk; a time budget stops a pass over a million rows within a few milliseconds of
running out (`limits-clock.test.ts`). It does **not** cover:

- anything it cannot interrupt: a single synchronous native call (a regular expression, see
  below), or `compileChart` itself;
- work done after the evaluation returns: the SVG serialization in `useChart` and
  `<Chart>`, the DOM patch, canvas painting, React rendering;
- each evaluation is its own budget: `<Chart>` re-evaluating on a prop change, or a stream
  flush, starts a new clock.

A session keeps the limits in its cache key. Re-evaluating the same inputs with the same
limits returns the cached scene (it was accepted under exactly those limits, and the pre-flight is not
run again for it); a different `limits` value re-evaluates and can reject. The only time check on a
cache hit is the one at the start of `evaluate` (`maxTimeMs: 0` fails there). A failed evaluation leaves
the session as it was, and the scenes it returned before: `datasetsOfScene(scene)` and the scene's
runtime keep the rows that scene was made with, whatever is evaluated or rejected after it.

## How the budgets are enforced: meters, not checkpoints

A budget that is only compared between phases cannot stop the costs that live
inside one synchronous call (a transform, one `sequence(0, 5e7)`, a 50-million
tick axis). So each such site reports what it is **about to spend** to a *meter*
that shares the one wall clock:

| Where | What is metered |
|---|---|
| Pre-flight (`checkSpecLimits`) | every string in the spec (`maxStringLength`), object depth (`maxDepth`, ceiling 1000), the spec's own objects (the spec-size ceiling), mark definitions (`maxMarks`), summed rows the chart is given, each once (see "What `maxRows` counts"). Iterative: a 200 000-deep or cyclic spec is an `AsterLimitError`, never a `RangeError`; a spec that shares sub-objects is not walked once per path to them |
| Every dataset | rows after load/`source`/transforms must be `<= maxRows` |
| Geo | the projection pipeline (clipping to the sphere and to the extent, resampling, the path and the measures) samples the clock every 128 events, and the rejoining of clipped rings once per crossing it walks (it is linear in the crossings: a ring that crosses the antimeridian 32 000 times takes about 0.1 s); the events one buffer holds count against the `vertices` ceiling, which no limit replaces (`maxRows` counts rows, not coordinates) |
| Transforms and row emitters | `sequence`, `fold` (rows x fields), `flatten`, `cross` (n x n), `impute`, `pivot` (groups x columns), an `aggregate` with `cross`, `kde` (groups x steps), `density`/`quantile` steps, the `regression` order, `graticule` positions, contour grids (declared size, scan and thresholds), heatmap pixels, the label canvases and bitmap, the word cloud board, `force` iterations, `range`: checked **before** the output is allocated or the loop runs (`maxRows` on the rows made, `maxGeneratedRows` on what is added, or the built-in ceiling). Every loop of the transform, layout, raster and geo code that the spec or its data sizes samples the clock **inside** it (`metered-loops.test.ts` refuses a loop that does not, or does not state its bound): among them `aggregate`, `joinaggregate`, `pivot`, `bootstrap`, `stack`, `window`, `loess`, `kde`, `wordcloud`, `pack`, `force` (every tick and every pass of a force), `label` (each label, each row of its canvases, each searched cell), the label rasterizer (each row it fills, each dash and join it makes), `contour` / `isocontour` (each row of the scan, each hole matched), `heatmap` (each row), `voronoi` (each point, each edge flip), `nest`, `cross` with a filter, the geo pipeline (each batch of projected, clipped and resampled events) and `indata()` |
| Encode loop | one item per row: `maxItems` is checked before the mark is encoded; the clock is sampled every 1024 items. Group items are metered the same way |
| Guides and scales | the ticks a numeric count makes, time ticks (counted before they are made where the interval can count, and as they grow), legend entries listed, axis ticks drawn, quantize colour samples (all against `maxItems`), facet `columns` |
| Expression builtins | `sequence` (the length it allocates, after vega's `\| 0`: rows), `pad` and number-format width (`maxStringLength`, cumulative `maxGeneratedBytes`), regex pattern/input length; the built-in ceilings apply to these even where the matching limit is unset. Under limits also: the string `join` and `replace` build, bounded before it is built (`replace` keeps the result within `maxStringLength` as each replacement is made, `$&`, `` $` `` and `$'` included), the pieces `split` makes (as rows, counted before the array is made), the strings `upper`, `lower`, `trim`, `truncate`, `substring` and `slice` make (`maxStringLength`, cumulative `maxGeneratedBytes`), and a string `+` builds (`maxStringLength`: a doubling `s + s` stops there) |
| Expression parser | nesting depth (1000): an `AsterLimitError`, not a stack overflow. Always thrown by the parser; see "A limit error cannot be swallowed" for what happens without a scope |
| Topojson | decoded coordinates against `maxGeneratedRows` (else `maxRows`) |
| Serialisation | every generated path `d` is checked as it is written (`maxPathLength`); `maxSvgLength` on the result where the entry point checks it (see the table above) |
| Scene (`checkSceneLimits`) | leaf items (`maxItems`), item `path` strings (`maxPathLength`), the total length of string and array `text` and every other string an item draws (`href`, `description`, a paint, `font`, `cursor`, an image `url`: `maxStringLength`; the item's `datum` is data, not drawn), and a lower bound for line/area paths (4 characters per point) |

Properties worth knowing:

- **One clock.** `renderSpec`, sessions, `evaluateChart`, `getChartInfo` and the worker
  handler open a scope (`withLimits`) with one wall clock. The `autosize: fit` loop, which
  evaluates the content several times, no longer restarts the budget per pass.
  Calling lower-level functions (`applyTransforms`, `buildScale`) yourself? Wrap
  them in `withLimits(limits, () => ...)` to get the same metering.
- **A limit error cannot be swallowed, inside a scope.** The runtime has defensive
  `catch` blocks (a signal expression that fails falls back to a default). The first
  violation in a scope is recorded on the meter, every later meter call re-throws it,
  and the scope re-throws it on exit even if a `catch` ate it. Without `limits` the entry
  points open a scope of their own for the built-in ceilings and the parser's nesting error,
  with the same rule: a 5000-term `1+1+...` signal fails with `maxDepth 1001 > 1000
  (expression nesting)` with or without `limits`.
- **Cost with limits off:** every site is one module-level null test. Limits ON
  adds an amortised clock read per 1024 rows/items.

### Deviations from Vega, made for safety

Vega has no budgets, no URL policy and no refusals of its own. Every row here is a
deliberate difference; each applies only where noted.

| Deviation | Why |
|---|---|
| Any budget in `SpecLimits`; rows, items, strings, paths, generated rows/bytes, SVG length and time are refused with `AsterLimitError` | vega renders whatever it is given |
| Built-in ceilings (previous section): a few spec-controlled amounts are refused above fixed values **even without `limits`**, and a spec nested deeper than 1000 or cyclic is an `AsterLimitError` even without `limits` | a few hundred bytes of spec can otherwise exhaust the process (a fatal out-of-memory, not an error) |
| Pre-flight depth ceiling: with a `limits` object, spec nesting deeper than `HARD_MAX_SPEC_DEPTH` (1000, exported from `@aster-charts/core`) fails even when `maxDepth` is unset, and a cyclic spec fails (`spec contains a cycle`) | an unbounded walk overflows the stack |
| `sequence`, `range`, numeric `ticks`, calendar and time-interval ranges, `pad` and number-format width are bounded by the active limits (and the built-in ceilings) before they allocate | one call can otherwise allocate gigabytes |
| A loop that is the product of spec or data sizes (a contour scan, a static `force`, a `label` placement, a filtered `cross`, a polynomial `regression`, a word cloud's spirals) past the `work` ceiling is refused, without `limits` too; a `maxTimeMs` budget replaces it | vega runs it to the end, which for some inputs is hours or never |
| A stroke the label rasterizer draws: a contour of more than a million dashes is stroked undashed; a round join or cap of an immense pen is made only as far as the canvas sees it (which is the disk, inside the canvas) | Skia, the canvas of Chromium, gives up dashing past a million dashes in the same way; cutting such a stroke exactly would take more memory than any canvas |
| Expression nesting deeper than 1000 throws `AsterLimitError` (the parser does so with or without `limits`; see "A limit error cannot be swallowed"). The parser counts 1000 nested unary and conditional productions, and a level of parentheses, brackets, call arguments or object values takes two of them, so 999 nested `!` and 499 nested parentheses parse; the tree may be 1000 levels tall | vega throws a raw `RangeError` at a stack-dependent depth |
| `bin`: a step that can never grow (underflowed to 0, `base` <= 1 that never reaches `maxbins`) throws `[aster] bin: cannot derive a step size ...` | vega loops forever. `maxbins: 0` (treated as 20) and `maxbins: -1` (NaN bins) give vega's output |
| `stratify` throws vega's errors (`cycle`, `multiple roots`, `missing: id`, `ambiguous: id`, `no root`) with an `[aster] stratify:` prefix | the messages are vega's; the prefix marks them as never recovered by the logger |
| Regex patterns with catastrophic-backtracking shapes, patterns > 1024 characters, and regex inputs longer than `maxStringLength` (default 10 000) are refused **under limits** | see the regex section |
| Decoded topojson coordinates are budgeted against `maxGeneratedRows` (else `maxRows`) | arcs are shared, so a few KB of input can decode to millions of points |
| `topojson` object names are looked up as own properties (`constructor`, `__proto__` are "not found") | the name is spec-controlled |
| `loadSpecData` and its URL policy: a network url needs an explicit allowlist (`allow`, or the `baseURL` origin), non-public hosts are refused, no credentials, every redirect hop vetted before it is requested (a redirect a browser hides is refused), timeout, size, request and byte caps | a spec's `url` is a request made on the host's behalf |
| A delimited text (csv, tsv, dsv) whose lines are shorter than its header fills in at most 1 000 000 missing cells per read (the `filledCells` ceiling; `maxGeneratedRows` replaces it), and under `limits` its rows are counted against `maxRows` as they are read | a wide header over empty lines is a few KB that vega pads to gigabytes |
| A malformed topology (an arc index out of range or not an integer, a `GeometryCollection` without `geometries`, an arc of fewer than two positions, a `transform` without `scale`/`translate`, a list that is not one) is an `[aster] topojson: ...` error | vega throws a raw `TypeError`, or walks a sparse array up to a huge arc index for minutes |
| Image and `href` URLs go through the same policy, and every URL a renderer writes is vetted where it is written, **always** (the defaults with neither `limits` nor `urlPolicy`; see "Every URL in the output") | a spec can name any URL |
| With `limits.regex: 'refuse'`, a spec that makes a regular expression is refused before it runs | no limit can stop a regular expression once it runs, and the screen is a heuristic |
| A paint (`fill`, `stroke`, the background) never references another document in SVG output (string and DOM), always: a leading `url(...)` naming one draws its fallback colour, else `none`; a `url(...)` anywhere else drops the attribute. `url(#id)` (within the page) is kept (see "Paint references" below) | vega's SVG renderers write paint as given, and Chromium fetches a paint server from another document, a request no URL policy sees |
| A mark's `blend` reaches SVG output (string and DOM) only as a `mix-blend-mode` keyword, always; any other value draws as if no blend were set (see "Blend modes" below) | vega's string renderer writes the value into the `style` attribute as given, where a value from the data can add CSS declarations of its own |

Differences that are **not** about safety (unsupported-feature errors, strict
Vega-Lite validation, vega errors Aster does not raise) are listed in `docs/ERRORS.md`.

### Regular expressions: what a cooperative clock cannot do

A JavaScript regular expression runs to completion once started. A pattern such
as `(a+)+$` against `aaaa...!` takes time exponential in the input length and
**no check inside Aster can interrupt it**, and the attack input is tiny (a few dozen
characters). Under limits Aster does two things
before a pattern is compiled or run, for every pattern a spec or its data can
supply (`test`, `regexp`, `replace`/`split` with a RegExp or a `/literal/`,
`countpattern`):

1. **Static screen** (`regex-screen.ts`). The pattern is read by a parser of the whole ECMAScript 2025 pattern grammar, in
   the mode its flags select (the legacy Annex B mode without `u`/`v`, where `\u{`, `\x`, `\k`, `\c` and a lone `{` are
   literals; the `u` mode; the `v` mode with set operations and strings), checked against a reference parser
   (`@eslint-community/regexpp`) on every generated pattern of its differential. A pattern the RegExp constructor rejects is
   left to it (its SyntaxError surfaces); **a valid pattern the screen cannot read, or cannot analyse within its budget, is
   refused** (fail closed). The pattern then becomes its position automaton, with the number of distinct ways each step can
   be taken (a backtracking matcher enumerates parse trees), and with the search's own loop in front unless every branch
   starts with `^` (outside `m` mode): V8 tries each start position in turn. It is refused, with an `AsterLimitError`
   (`regexSafety: ...`), when:
   - **exponential**: a part of it can match the same input in two ways and repeat (`(a+)+`, `(a|aa)+`, `(\w+\s?){1,50}`,
     `((a|a))*`, `(.*a){12}`). A repeat that may run twice or more is read as unbounded (`(a+){1,60}` is `(a+)+`),
     except a repeat of one character set, which is expanded exactly up to 64;
   - **polynomial of degree 3 or more**: three loops each able to hand the same input on to the next, the search's loop
     counted (`a*a*a*b`, `\s*.*x`, `.*foo.*bar`, the trim idiom `^\s*(.*?)\s*$`). Measured on V8: `\s*.*x` on 4 000
     spaces runs 14 s, `.*foo.*bar` on 6 000 characters 16 s, the trim idiom on 4 000 spaces before `x\n\nx` 19.7 s; the
     default input cap is 10 000. Degree 2 is allowed (`a*b` and `\s+$` take about 0.1 s on 10 000 characters; V8's cost per
     step depends on the shape, which the screen does not model: a repeated group such as `(\w?)+!` measured up to 15 times
     that, and the soundness test holds every accepted generated pattern to 20 times the plain quadratic search of its input),
     and a loop
     after which the match can always end is no hazard (`\s*.*`, `\d+\.?\d*`: the first path that reaches it succeeds);
   - **too many live paths**: over 4 096 ways to have matched one input so far (`(a|a)(a|a)...`), a loop counted as
     absorbing any length of it; or, next to a degree-2 chain, more than 16 transitions tried per character from those paths
     (the searched `a*x` tries 5). A bounded run after a loop over the same characters is entered from every place the loop
     can stop, which multiplies the quadratic search by the run's length: `a*[ab]{0,20}x` ran 11 s and `a+a{30}x` 14.6 s on
     10 000 characters, and are refused; `a*a{1,3}x` (0.19 s) is not;
   - a **backreference** inside a group that repeats (`(?:(a)\1)*`).
   A lookaround body is screened as a pattern of its own. A Unicode property is read as "any character", a
   case-insensitive set is closed under every case mapping V8 applies (derived from V8's own `iu` matching, about 0.15 s
   once per process on the first case-insensitive pattern), and a `v`-mode set operation keeps an upper and a lower bound,
   so nothing a pattern can match is left out of the analysis.
2. **Length caps**: a pattern over 1024 characters (a fixed cap: no limit raises it, and a `maxStringLength` below 1024 lowers it),
   or an input longer than `maxStringLength` (default 10 000), is refused. This bounds linear patterns.

**This is a static model of a backtracking matcher, not a proof.** It is conservative by construction, so a few safe
patterns are refused (`(a|a){2}`, `.{1,100}.{1,100}x`; rewrite them without the ambiguity). Its soundness is tested by
running every pattern it accepts out of a generated set on 10 000-character attack inputs in V8. Without limits nothing is screened (vega parity).

**If specs are untrusted, run the render in a killable worker** (a
`worker_threads` Worker you can `terminate()`, or a child process with a
timeout) and treat the worker's deadline as the hard guarantee. `maxTimeMs` then
produces friendly errors in the common case, the screen stops the known
shapes, and the kill covers the rest.

### Refusing every regular expression: `limits.regex: 'refuse'`

A host that draws specs which need no regular expressions can refuse them all. With `limits: { regex: 'refuse' }` a spec
that makes one is refused with an `AsterLimitError` (`regexSafety: regular expressions are disabled (limits.regex:
'refuse')`, naming the first place) before anything of it runs; the default, `'screen'`, is the screen above. What makes one:

- a regex literal anywhere in an expression (`/a+/`, `replace(datum.s, / a+/, '')`);
- a call of `test` or `regexp`, however it is written (`(test)(...)` is a call of `test`);
- a `countpattern` with its own `pattern` or `stopwords` (one without either uses the engine's fixed default and is allowed).

It does not depend on the data: the expressions are read when the spec is compiled (every one, also those in branches that
never run, in event handlers and event-stream filters, and in marks over empty data sets), and every evaluation under the
option refuses a chart that has any, so a spec is refused for what it is, not for what one dataset makes it do. The same
holds for a chart compiled earlier, a session or a stream whose limits change. A regular expression that reaches the engine
at run time instead (a `RegExp` object in host data or in a signal value given to `replace` / `split`) is refused where it
would run. What stays allowed: `replace` and `split` with text (text is literal, not a pattern), and the engine's own
parsing of numbers, dates, colours and CSV. A value other than `'screen'` or `'refuse'` is a `TypeError`, never read as
permission.

Over the official Vega and Vega-Lite example galleries (720 specs) the option refuses three, each for a regular expression it
makes: two filter on a search box with `test(regexp(...))`, and the word cloud counts words with its own `countpattern`.

## Loading URL data: `loadSpecData(spec, options)`

`url` datasets are fetched by `loadSpecData` from `@aster-charts/core/load`, never by
`renderSpec` (a `url` dataset that was not loaded is an error that tells you to
call it, not an empty chart). It resolves `url` datasets at the top level **and**
inside group marks at any depth, and returns a copy of the spec with those paths
replaced (the input itself when it has none; the input is never mutated).

**A network url needs an explicit URL policy.** Give `allow` (an allowlist; `allowOrigins([...])`
makes one from origins), or a `baseURL` the url is on. Without either, every `http(s)` url is
refused with an `AsterUrlError` before any request is made (`loadSpecData needs an explicit URL policy
for network urls ...`). This holds in every environment, a browser included: the request is made
with the viewer's network position and cookies.

Every URL a spec names passes the policy before any request is made:

| Option | Default | Meaning |
|---|---|---|
| `allow(url)` | none | **the URL policy**: awaited for the first URL **and every redirect hop**, before it is requested; it must return exactly `true` to permit. Required for any network url that is not on the `baseURL`'s origin. When given, it decides every url, the base's origin included. `allowOrigins(['https://data.example.com'])` is an origin allowlist |
| `baseURL` | none | base for relative `url`s (without it a relative url is an `AsterUrlError`). When no `allow` is given, a url on the base's own origin is permitted (the base is the host's choice) and every other network url is refused. The base's own origin is exempt from the private-network check |
| `fetch` | `globalThis.fetch` | your fetch; Aster still applies the policy and the caps around it. It must honour `redirect: 'manual'`: a response that says it followed a redirect on its own is refused (the hop was requested before it could be vetted) |
| `protocols` | `['http:', 'https:']` | allowed protocols. Anything not listed is refused (`data:`, `file:`, `javascript:`, `ftp:`, `blob:`, ...); add `'data:'` to permit data URLs, which need no `allow` (they reach nothing). URLs with embedded credentials are refused whatever `protocols` says |
| `allowPrivateNetwork` | `false` | permit non-public hosts (see "Which hosts are non-public" below). Not applied to the `baseURL` origin or to `data:` URLs. `allow` alone cannot override it |
| `timeoutMs` | 10 000 | per request, covering headers **and** body (an `AsterLimitError`) |
| `maxBytes` | 10 MiB (10 485 760 bytes) | per response, enforced **while the body streams** (a declared `content-length` over it is refused up front); the reader is cancelled, not buffered first. A fetch shim whose response has no stream is measured after the text exists |
| `maxTotalBytes` | 50 MiB (52 428 800 bytes) | bytes read into datasets in one call, summed over them (a dataset naming a url another one loaded counts again: each is parsed) |
| `maxRequests` | 100 | HTTP requests one call makes, redirect hops included. Several datasets naming one url make one request |
| `maxConcurrent` | 4 | requests in flight at once |
| `maxRedirects` | 5 | redirect hops followed per request; each hop goes through the whole policy **before** it is requested |
| `signal` | none | abort the whole load |
| `signals` | none | the values the host sets on the spec's top-level signals, read by a `{signal}` url instead of the spec's own initial values |
| `limits` | none | `maxRows` per loaded dataset (checked row by row while a csv is read), topojson coordinates, every budget over the `{signal}` url expressions it evaluates, and `maxTimeMs` over the whole call (`maxTimeMs exceeded during loadSpecData`) |

Every option is checked once, before anything is planned or requested: a value of the wrong type, or a
number that is not a whole number in its range (`NaN`, `Infinity`, `-1`, `1.5`, `'100'`), is a `TypeError`
(`[aster] loadSpecData: maxBytes must be an integer from 0 to ...`), never a cap silently turned off.

The defaults are exported as `LOAD_DEFAULTS` (`timeoutMs`, `maxBytes`, `maxTotalBytes`, `maxRequests`, `maxConcurrent`,
`maxRedirects`) from `@aster-charts/core/load`. Policy refusals are `AsterUrlError`; timeout, size, request, redirect and
budget failures are `AsterLimitError`; an HTTP error status is a plain `Error` (`[aster] failed to load dataset url ...: HTTP 404`).

**The clock does not depend on the fetch.** `timeoutMs`, `limits.maxTimeMs` and `signal` end the call at
their time whatever the `fetch`, the `allow` hook or the response body do: every step (the hook, the
request, the body, each chunk) is raced against the abort, and a value that arrives after it is never
taken. The abort is also passed to `fetch` as `init.signal`, so a fetch that honours it releases the
connection; one that ignores it may keep the socket open after the call has failed.

**Redirects.** Every hop is vetted by the whole policy before it is requested, in every environment.
`fetch` is called with `redirect: 'manual'`; a browser answers that with an opaque response that hides
the next location, so a redirect there cannot be vetted and is refused (`the response is a redirect whose
target this environment hides ...`): serve browser-loaded data without a redirect. A `Location` that is not
a URL is an `AsterUrlError`.

**`{signal}` urls.** A dataset whose `url` is a `{signal}` is loaded for the value the signal has when the
view starts: the expression is evaluated under `limits` (the regular-expression screen and the clock apply),
over the signals it reads and only those, each taken from its own scope (a group mark's signals shadow the
view's) and from `signals` for the host's values. vega reloads such a dataset whenever the signal changes;
`loadSpecData` loads once. `useChartData` in `@aster-charts/react` passes its `signals` to the loader, so a
host-set signal that changes loads again; a change made inside the chart (a bound input, an event handler)
does not reload (see docs/ROADMAP.md).

**The format.** A url dataset is read in the format its `format.type` names, `json` by default, as vega does: the url's
extension is not read. A `.csv` url with no `format` is json, and a body that is not JSON is an error
(`[aster] invalid JSON data: ...`), where vega logs the failed ingestion and goes on.

### Which hosts are non-public

The host is read as the URL parser reads it (so decimal, octal, hex, short and full-width IPv4 spellings are the
addresses they spell), and it is non-public when it is:

- a name with no dot, after every trailing dot is dropped (`http://metadata/`, `http://intranet/`, Docker Compose and
  Kubernetes service names, `localhost..`): such a name only resolves through a local search domain or hosts file;
- a name under a special-use or private-use suffix: `test`, `localhost`, `invalid`, `example`, `local`, `onion`, `alt`,
  `arpa` (`home.arpa`, the reverse zones), `internal`, and the de-facto internal `localdomain`, `lan`, `home`, `corp`,
  `intranet`, `private`, `svc`;
- an IPv4 address in a block the IANA special-purpose registry lists as not globally reachable (this-network, private,
  shared/CGNAT, loopback, link-local and cloud metadata, the IETF protocol block, the three documentation blocks,
  benchmarking, the deprecated 6to4 relay), or multicast, reserved or broadcast;
- an IPv6 address outside global unicast `2000::/3` (unspecified, loopback, IPv4-compatible, SIIT, local-use NAT64,
  discard, unique local, link-local, site-local, multicast, unassigned), or inside it in `2001::/23` (Teredo and the
  other protocol assignments), `2001:db8::/32` or `3fff::/20` (documentation). The IPv4-mapped (`::ffff:a.b.c.d`),
  well-known NAT64 (`64:ff9b::a.b.c.d`) and 6to4 (`2002:aabb:ccdd::`) forms are judged by the IPv4 address they carry;
- anything the parser does not read as a host.

`isNonPublicHost(hostname)` from `@aster-charts/core/load` is this check.

### Why these defaults

A spec's `url` is the request a server or browser will make on the spec author's
behalf. The attack is not "fetch a public CSV" (that is the feature); it is
reaching what only the host can reach: loopback and internal services, cloud
metadata, and slow or endless responses that pin the process. So:

- no network url is requested unless the host said which ones may be (`allow`, or the
  `baseURL` origin): the host knows where its data lives, the spec does not get to choose;
- non-public destinations are denied on top of that, and need an explicit
  `allowPrivateNetwork: true`;
- time, size, requests and concurrency are bounded by default because the alternative is
  an unbounded wait, buffer and fan-out.

### What the policy cannot see: DNS

The non-public check reads the host as written. A public name that resolves to a private
address (`127.0.0.1.nip.io`, a name whose owner points it at your network) passes it. Aster
does not resolve names itself, deliberately: a check that resolves the name and then lets
`fetch` connect is not a check of the address `fetch` connects to, because `fetch` resolves
the name again. A resolver that answers a public address to the first lookup and a loopback
one to the second (DNS rebinding, a zero TTL) gets the request through; measured on Node 26,
a pre-check saw `93.184.216.34` and the following `fetch` read a server on `127.0.0.1` (two
lookups). Closing that needs the address checked at the moment the connection is made, which
only the connection layer can do, and a browser has no DNS API at all.

So the control for names is the required `allow` policy: list the origins your data lives on.
If you must accept names you do not control, give `loadSpecData` a `fetch` whose connections
check the address they connect to (on Node, an undici `Agent` whose `connect.lookup` refuses
addresses `isNonPublicHost` flags), or enforce egress at the network.

Trusted specs (a demo, a test harness) can opt out explicitly with
`loadSpecData(spec, TRUSTED_LOAD_OPTIONS)`. Never use that for specs you did
not write.

```ts
import { allowOrigins, loadSpecData } from '@aster-charts/core/load'
import type { VgSpec } from '@aster-charts/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', url: 'data/table.json' }],   // relative: resolved against baseURL
  marks: [],
}

const loaded = await loadSpecData(spec, {
  baseURL: 'https://data.example.com/',
  allow: allowOrigins(['https://data.example.com']),
  maxBytes: 2_000_000,
  limits: { maxRows: 100_000, maxTimeMs: 5_000 },
})
```

`format.parse` accepts vega's `date:'%d/%m/%Y'` and `utc:'%Y-%m-%d'` patterns
(quoted or not), resolved through the chart's locale (`config.locale`, else the default one) like `vega-loader`.

## Refusing url datasets: `urlData`

An app that supplies every row itself (`data`) and draws specs it did not write never wants a spec to load data from a url.
Aster never fetches data by itself, so such a spec cannot load rows on its own; `urlData: 'refuse'` makes it fail at once, with
an error that says why, instead of after the add-ons its formats name have loaded and with advice to call `loadSpecData`:

```ts
import { AsterUrlError, renderSpec, urlDatasets, type VgSpec } from '@aster-charts/core'

const spec: VgSpec = {
  width: 100,
  height: 60,
  data: [{ name: 'source_0', url: 'https://example.org/data.csv', format: { type: 'csv' } }],
  marks: [],
}

console.log(urlDatasets(spec)) // ['source_0']
try {
  renderSpec(spec, { data: { source_0: [] }, urlData: 'refuse' })
} catch (e) {
  // [aster] url denied: dataset "source_0" loads its rows from a url, and url data is not allowed here (urlData: "refuse"): https://example.org/data.csv
  if (e instanceof AsterUrlError) console.log(e.code, e.message) // ASTER_URL_DENIED ...
}
```

- A url dataset is one with a non-empty `url` and no `values` (Vega reads `values` first, then `url`, then `source`, each when it is not empty), at the top level or in
  a group mark at any depth. A `{signal}` url counts. The refusal holds whether or not `data` gives rows under its name: what is
  refused is the spec asking for a url.
- The error is an `AsterUrlError` (`code: 'ASTER_URL_DENIED'`): `url` is the first dataset's url (a `{signal}` url as its JSON), and
  the message names every url dataset.
- Nothing is loaded first. `<Chart urlData="refuse">`, `<SvgChart>`, `useChart`, the stream components and hooks, and the worker
  refuse before importing any add-on (the `load` readers a csv url names, or anything else the spec needs) and report through
  `onError` / the hook's `error`. `addonsNeeded(spec, { urlData: 'refuse' })` does not count a url dataset's readers, and
  `loadAddonsFor(spec, { urlData: 'refuse' })` rejects with the refusal.
- Where to pass it: the runtime input of `renderSpec` / `evaluateChart` / `getChartInfo` / sessions, a stream's `initial` (fixed for
  its life), `<Chart urlData>` and the other React shells, `useChart`, and the worker hooks (it crosses `postMessage` as is).
  `urlDatasets(spec)` and `checkUrlData(spec, urlData)` check a spec without rendering it.
- It is independent of `limits` (a refusal needs no budget) and of `urlPolicy`, which vets image and link urls. Draw an untrusted spec
  with both closed: `urlData: 'refuse'` and a `urlPolicy` whose `allow` returns `false`.
- `'allow'` (the default) keeps today's behaviour: resolve url datasets with `loadSpecData`, or give their rows in `data`.

## Every URL in the output

A URL is vetted at the one place each renderer writes it, whatever channel, guide or code path put it on the scene: the
attribute sink both SVG renderers write every attribute through (a link's or an image's `xlink:href`, and any attribute that is
CSS -- a `url()` there never names another document), the urls a canvas host loads (`sceneImageUrls`, what `<Chart>` and
`renderSceneToPng` load), and the cursor a host shows (`resolveCursor`). This is on by default and fails closed:

- the policy is the one the scene was evaluated under (`urlPolicy`, or the defaults under `limits`); with neither, the
  defaults: a link is one of `http:`, `https:`, `mailto:`, `tel:` or relative, an image one of `http:`, `https:`, `data:` or
  relative, and neither carries credentials. A URL that cannot be read, or is refused, is not written: the item is drawn
  without its link, an image with an empty `href`, and nothing is requested. vega's own rewrites are applied first
  (`file://` stripped to the path, `//host` given `http:`), and the text that is written is the one judged (a
  `file://javascript:` link is refused; vega writes it as `javascript:`).
- a scene posted from a worker (a structured clone) carries no policy: it is vetted against the defaults where it is drawn, so
  a host that widens `protocols` in the worker sees those links dropped on the page (fail closed).
- the evaluation applies the policy too, to every URL channel it knows (`href` on any item of any mark, guide or title, an
  image's `url` and the `src` of an `image` object): that is where a refusal throws `AsterUrlError`, or calls `onDeny`.
- No encode channel can name the engine's own state on an item (`__domDesc`, `_hit`, `items`, `dataDatum`, ...): a spec that
  tries is refused with a `SpecParseError` ([ERRORS](ERRORS.md)).

## Image URLs

Image marks take their `url` from data, so a hostile spec can make the viewer's
browser request a tracking pixel or a `javascript:` URL. Image `url`s pass the
same checks, applied while the scene is built so the string renderer, the DOM
path and canvas all see vetted items (and vetted again where they are written, above):

```ts
import { renderSpec, type VgSpec } from '@aster-charts/core'

const spec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'icons', values: [{ src: 'https://cdn.example.com/a.png' }, { src: 'https://tracker.example.net/p.gif' }] }],
  marks: [{
    type: 'image',
    from: { data: 'icons' },
    encode: { enter: { url: { field: 'src' }, x: { value: 0 }, y: { value: 0 }, width: { value: 16 }, height: { value: 16 } } },
  }],
}

const log = (reason: string): void => { console.warn('image dropped:', reason) }
const svg = renderSpec(spec, { urlPolicy: {
  baseURL: 'https://app.example.com/',
  allow: (url) => url.hostname === 'cdn.example.com',
  onDeny: (url, error) => log(error.reason), // drop the image instead of throwing
}})
console.log(svg.includes('cdn.example.com'), svg.includes('tracker.example.net')) // true false
```

- With `urlPolicy` it is applied (its `protocols` default to `http:`, `https:`,
  `data:`). With `limits` and no `urlPolicy` the defaults apply (the spec is
  untrusted): `http:`, `https:`, `data:` and relative URLs only, no credentials;
  anything else throws `AsterUrlError` (or is dropped when `onDeny` is set).
- With neither, the output still vets every image url against the defaults (above): a
  `javascript:`, `file:`, `blob:` or credential-carrying url is drawn as no url (vega draws any
  `url`). **Residual risk:** a spec can still make the viewer's browser request an arbitrary
  `http(s)` URL (a tracking pixel, an IP leak, a request to an internal address the viewer can
  reach). If you render specs you did not write, pass a `urlPolicy` with `allow`.
- `allow` for images is synchronous. A relative URL needs `baseURL` once `allow`
  is set (fail closed).
- With a `baseURL` a relative image URL is drawn resolved against it, the way vega's loader
  does: a text prefix (`base` + `/` + `url`, `//host` getting `http:`), not a WHATWG resolution,
  so give a directory URL, not a page URL such as `location.href`, whose file name or query would
  become part of every path. `allow` is asked once, about exactly the url that is drawn; the text
  as written also passes the protocol and credential checks (a `file:` url is refused even though
  its drawn form would be a path). Without a base it is drawn as written.
- Where to pass it: `renderSpec`/`evaluateChart`/sessions take `urlPolicy` in the runtime
  input; `<Chart urlPolicy>`, `useChart(spec, { urlPolicy })` and `<ChartStream urlPolicy>`
  forward it (a denial without `onDeny` is a render error reported through `onError`; the
  stream reads it when it is created). Functions in it are compared by identity, so
  memoize the object. A Worker cannot receive `allow`/`onDeny` functions: register them
  in the worker with `registerWorkerUrlPolicy(name, { allow, onDeny })` and send
  `urlPolicy: { hooks: name, baseURL, protocols }` (`@aster-charts/react/worker`).

## Hyperlinks (`href`)

A mark's `href` channel is drawn the way Vega's SVG renderer draws it: the item's element
sits inside `<a xlink:href="...">` (string renderer and DOM path alike; line, area and trail
link through their first item). Two checks apply to the value:

- Always, in every renderer, with or without a policy: the link is vetted where it is written (see "Every URL in the
  output"). Only `http:`, `https:`, `mailto:`, `tel:` and scheme-less (relative) URIs are linked, without credentials
  (Vega's sanitizer also links `ftp:`, `callto:`, `cid:`, `xmpp:`, `file:` and `data:`, and lets `file://javascript:` through);
  `javascript:`, `vbscript:` and the like produce no link, whatever the spec says. (`//host/p` gets `http:`, `file://` is
  stripped to the path, as in Vega; a host-naming text with no scheme, `\\host\p`, is written as the URL it was judged as.)
- Under `limits` or an explicit `urlPolicy`, the URL policy above applies with the link
  protocols `http:`, `https:`, `mailto:`, `tel:` (and relative URLs): anything else throws
  `AsterUrlError`, or is dropped (the item is drawn without its link) when `onDeny` is set.

## The cursor

A mark's `cursor` channel and a spec's `cursor` signal reach the host as `resolveCursor` resolves them (vega-view's rule).
Only a CSS cursor keyword (`pointer`, `grab`, `zoom-in`, ...: the list of CSS Basic User Interface 4, ASCII case ignored) is
shown; any other value counts as no cursor. A CSS cursor may be a `url()` list, an image the viewer's browser fetches that no
URL policy would see, so a value that is not a keyword is never handed on (vega hands the text on as it is).

## The accessible tree

`buildA11yTree` is bounded whatever the data (`summaryThreshold`, default 150): over that many mark items in the whole scene
every mark is one summary node, no more than that many mark nodes are made in all (the rest fold into one), and a legend gives
no more than that many entry nodes.

## Blend modes (`blend`)

A mark's `blend` is drawn in SVG as vega draws it, `style="mix-blend-mode: <blend>;"`, but only when the value is a
`mix-blend-mode` keyword: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`,
`hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`, `plus-darker` or
`plus-lighter`. Matching is the browser's: CSS whitespace around the keyword is ignored, ASCII case is ignored, and the
lower-case keyword is written. Any other value, whether a literal, a field or an expression, writes nothing: the
mark is drawn with no blend, as a browser draws vega's DOM renderer when it rejects a value. The check applies in the
string renderer, the DOM renderer and its patches, with or without `limits`.

Without the check, a value from the data such as `multiply; background: url(...)` would add CSS declarations to the
element. Those could load a resource that the URL policy and `urlData: 'refuse'` never see, or restyle and move the
mark anywhere on the page. A CSS escape (`\75 rl(`) hides `url(` from a text check, so the keyword list is the rule,
not a filter for bad text. The canvas renderer passes the value to `globalCompositeOperation`, which ignores names it
does not know, as vega's canvas renderer does.

## Paint references (`fill`, `stroke`, background)

SVG paint is a colour, `none`, or `url(<reference>)` with an optional fallback colour. A reference to another
document (`url(https://host/a.svg#g)`) makes Chromium fetch that document, a request the URL policy and
`urlData: 'refuse'` never see; Firefox and WebKit load nothing. Paint often comes from the data (a field, a scale
over a data column, `scale: null` in Vega-Lite), so Aster never writes such a reference, in the string renderer,
the DOM renderer and its patches, with or without `limits`:

- `url(...)` naming another document at the start of a paint is replaced by its fallback colour, or `none` when
  there is none. This is what Firefox and WebKit draw for vega's output.
- `url(...)` naming another document anywhere else makes the value no paint at all, so the attribute is not
  written, as a browser ignores an invalid value.
- A reference within the page, `url(#pattern)`, is written as given (a pattern or gradient the page defines). It
  loads nothing, also under a `<base href>`.
- CSS escapes are decoded before the check, so `\75 rl(` is a `url(` and `url(\23 a)` is `url(#a)`, while an escaped
  colour name such as `r\65 d` is still written as it is. An escaped quote or whitespace is a character of the
  reference, as the browser reads it, not the quote or the space around it: `url(\"#a\")` names `"#a"`, a relative URL
  Chromium fetches from the page's directory, and `url(\20#a)` or `url(" #a")` resolves against the page's base, so
  each counts as another document (#178). `packages/conformance/src/paint-url-browser.test.ts` checks this reading
  against the requests Chromium makes.

Gradients from the spec are written as references to their own definitions, as before. A gradient stop's colour
takes colours only. The canvas renderer ignores a `url()` paint.

## Container size

`containerSize()` in expressions (Vega-Lite's `width: "container"`) returns
`[undefined, undefined]`, like headless Vega, unless the host passes
`containerSize: { width, height }` in the runtime input; Vega-Lite's own fallback size then
applies. A host that has a DOM element to fill passes its `clientWidth` / `clientHeight`.

`measuredSize: { width, height }` is the element a host lets the chart fill. It is the view size of a
spec with no `width` / `height` signal; a spec that drives those signals keeps doing so (the container
reaches it through `containerSize()`, which falls back to `measuredSize`); nor does it size a dimension the spec gives no value at all (no number, no signal): in Vega that is 0 and the autosize pass grows it to the content; nor a spec whose autosize is `none`, whose whole size in Vega is its `width`, `height` and `padding`. The view size has one value
for every consumer (scales, layout, marks and expressions); from the strongest: a fixed `width` /
`height`, a value written to the `width` / `height` signal (`signals`), then `measuredSize`.

## Locale and formatter caches

Expression `format`, `timeFormat`, `monthFormat`, ... read the chart's locale (`config.locale`) or the **current**
default locale on every call, so `defaultLocale(...)` after import takes
effect. A chart's own locale makes its formatter tables once, with the compiled chart, and they go with it. Memoised formatters are bounded (512 per table, least-recently-used out)
so arbitrary specifiers in data cannot grow the process without bound. The same holds for the
expression `pluck` accessor table (1024, least-recently-used out): an accessor is a pure function of
its name, so a dropped one is simply rebuilt.

## In React and workers

- `<Chart limits>` applies the budgets at every evaluation (compared by content, so an
  inline literal is fine). A violation renders the error state and calls `onError` with
  an `AsterLimitError`. `maxSvgLength` is enforced on the SVG renderer only, by
  serializing the scene once per evaluation (only when `maxSvgLength` is set). `useChart`
  does the same when `serialize` is on.
- `useChartWorker`, `useChartWorkerStream` and `<ChartWorkerStream>` send `limits` to the
  worker, which enforces them there (the request handler runs the same sequence as
  `renderSpec`). A violation comes back as `{ name, message, code: 'ASTER_LIMIT' }`; the
  hooks turn it into an `AsterLimitError` (see `docs/ERRORS.md`).
- `useSpecData`, `useChartData` and `loadSpecData` from `@aster-charts/react` take the same
  options as `loadSpecData` in `@aster-charts/core/load`, so the URL policy and `limits` apply to
  Suspense loading too. The resource is keyed on the options, functions by identity: define `allow`
  once (at module scope), not inline in the component, or every render starts a new load.
- `urlData="refuse"` refuses a spec with a url dataset in every shell, hook and worker, before any add-on is imported
  (see [Refusing url datasets](#refusing-url-datasets-urldata)).
- A worker is not a kill switch by itself. To get the hard guarantee described above,
  terminate the Worker you created (`worker.terminate()`) when your own deadline passes.
- The worker handler serializes the SVG inside the same limits scope as the evaluation (one meter and clock),
  so `maxPathLength` and the other serialization checks apply there exactly as in `renderSpec`.

## The `heatmap` image

The `heatmap` transform (`@aster-charts/core/transforms`) draws a raster grid into a bitmap that an image mark shows (`item.image`). vega draws it into a
`<canvas>`, which Node does not have: there `heatmap` throws. Here the bitmap holds its own pixels, so the transform and the SVG / canvas
renderers also run where there is no canvas (Node, a worker). The image's `href` is the platform canvas' `toDataURL()` when the document
has a canvas (the PNG a browser makes is byte for byte vega's), and otherwise a PNG written by the engine: valid, but uncompressed
(4 bytes per grid cell, base64), and without the premultiplied-alpha rounding a canvas applies to translucent pixels, so a
server-rendered `href` is not equal to a browser's for those. An explicit superset of vega, not a conformance pass.
