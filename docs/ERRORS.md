# Errors

Aster separates **host controls** (a budget, a URL policy, a backpressure bound) from **spec errors** and from
**recovered expression errors**. The first group has typed classes with stable `code`s; the rest are plain `Error`s
whose message starts with `[aster]` (or `[aster/vl]` for the Vega-Lite compiler).

```ts
import { AsterLimitError, renderSpec, type VgSpec } from '@aster/core'

const untrustedSpec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'table', values: Array.from({ length: 20 }, (_, i) => ({ i })) }],
  marks: [],
}

try {
  renderSpec(untrustedSpec, { limits: { maxRows: 10, maxTimeMs: 500 } })
} catch (err) {
  if (err instanceof AsterLimitError) {
    console.error(err.code)    // "ASTER_LIMIT"
    console.error(err.message) // "[aster] limit exceeded: maxRows 20 > 10"
  } else {
    throw err
  }
}
```

## Typed errors at a glance

| Class | From | `name` | `code` | Extra fields |
|---|---|---|---|---|
| `AsterLimitError` | `@aster/core` | `AsterLimitError` | `ASTER_LIMIT` | none |
| `AsterUrlError` | `@aster/core`, `@aster/core/load` | `AsterUrlError` | `ASTER_URL_DENIED` | `url`, `reason` |
| `AsterStreamBackpressureError` | `@aster/core` | `AsterStreamBackpressureError` | `ASTER_STREAM_BACKPRESSURE` | `bound` (`'batches'` or `'rows'`), `limit` |
| `AsterStreamClosedError` | `@aster/core` | `AsterStreamClosedError` | `ASTER_STREAM_CLOSED` | none |
| `ExpressionParseError` | `@aster/core` | `ExpressionParseError` | none | `expression`, `cause` |
| `SpecParseError` | `@aster/core` | `SpecParseError` | none | `cause` |
| `VLCompileError` | `@aster/vl` | `VLCompileError` | none | none |

Everything else the packages throw is a plain `Error` (or a `TypeError` for a malformed stream batch or worker
message) with an `[aster]` prefix and **no `code`**. Do not claim a `code` for an error that is not in this table.

### `instanceof` or `code`?

Prefer `err.code === 'ASTER_LIMIT'` (and the other codes) over `instanceof` whenever the error may have crossed a
boundary or come from a second copy of the package:

- The worker hooks (`useChartWorker`, `useChartWorkerStream`, `<ChartWorkerStream>`) rebuild the error from
  `{ name, message, code }` (`errorFromWire` in `@aster/react/worker`). A limit error (`code: 'ASTER_LIMIT'`) comes
  back as a real `AsterLimitError`. **Every other class comes back as a plain `Error` with `name` and `code` copied
  over and none of its other fields**: an `AsterUrlError` loses `url` and `reason`, an
  `AsterStreamBackpressureError` loses `bound` and `limit`, so `instanceof AsterUrlError` is `false` there while
  `err.code === 'ASTER_URL_DENIED'` works.
- If you call `handleChartWorkerRequest` / `handleChartWorkerStreamRequest` yourself, or read `ChartWorkerResponse`
  messages directly, you get the wire form `error: { name, message, code? }`.
- Two copies of `@aster/core` (a bundler duplicating a dependency) have two different `AsterLimitError` classes.

## Budget errors

`AsterLimitError` is thrown by `checkSpecLimits`, `checkSceneLimits`, `checkSvgLength` and `createLimitClock`, by
`loadSpecData` (timeouts, size, redirects), and by the meters inside transforms, the encode loop, guide generation,
expression builtins and the expression parser (see `docs/LIMITS.md`). Under a `limits` scope a violation raised
anywhere in a render is never swallowed by a defensive `catch`: the call fails with it. `<Chart>` renders
`<div role="alert">` containing the limit message instead of the chart, and reports the error through `onError`.

| Message fragment | Meaning |
|---|---|
| `maxRows`, `maxMarks`, `maxDepth`, `maxStringLength` | pre-flight spec budget; `maxRows` also caps any dataset a transform produces, `maxDepth` also covers expression nesting (`(expression nesting)`) and, with a cyclic spec, the separate message `spec contains a cycle` |
| `maxGeneratedRows`, `maxGeneratedBytes` | cumulative rows / characters generated during one evaluation |
| `maxItems`, `maxPathLength` | generated scene budget (also tick counts and generated paths) |
| `regexSafety: ...` | a regular expression pattern with a catastrophic-backtracking shape was refused (only under `limits`) |
| `timeoutMs`, `maxBytes`, `maxRedirects` | `loadSpecData` request caps |
| `maxSvgLength` | serialized output budget |
| `maxTimeMs exceeded during <phase>` | wall-clock deadline; the phase is `pre-flight`, `compile`, `evaluate`, `render`, `change`, `mark encoding`, `loadSpecData`, `regular expression` or the name of the transform that was running |

## URL errors

`AsterUrlError` (`code: 'ASTER_URL_DENIED'`, `url`, `reason`) means a URL was refused by the policy: protocol not
allowed, embedded credentials, non-public host, relative URL without `baseURL`, refused by the `allow` hook. It is
thrown by `loadSpecData` before the request is made, and by image and `href` marks under `urlPolicy` or `limits`
(unless `onDeny` is set, which drops the image or link instead). It is never recovered by the `logger` mechanism
below.

## Stream errors

`createChartStream` throws two typed errors, each with a stable `code` (use the code, not `instanceof`, across a
worker boundary or duplicated bundles):

| Class | `code` | When |
|---|---|---|
| `AsterStreamBackpressureError` | `ASTER_STREAM_BACKPRESSURE` | `policy: 'error'` and a `push` would exceed `capacity` (batches, `bound: 'batches'`) or `maxQueuedRows` (rows, `bound: 'rows'`); `limit` is the configured bound |
| `AsterStreamClosedError` | `ASTER_STREAM_CLOSED` | `stream.session()` after `close()` (`push` returns `false` and `flush` returns `null` after close; neither throws) |

A batch that is not an object, or whose `data.<name>` / `append.<name>` is not an array, makes `push` throw a
`TypeError` (`[aster] stream batch must be an object`, `[aster] stream batch.append.<name> must be an array`).

A `flush()` that throws (any error, including `AsterLimitError`) leaves the stream
exactly as it was before the call, with its batches still queued, and rethrows the
original error. `getStreamFlushFailure(err)` returns `{ batches, queuedRows }` for such an
error, and `stream.discard()` drops the queued batches so the next flush can succeed
(otherwise every later flush fails the same way). See "Atomic flush" and "Recovering from
a failed flush" in `docs/API.md`.

The React bindings do the discard for you: `useChartStream`, `useChartWorkerStream`, `<ChartStream>` and
`<ChartWorkerStream>` call `stream.discard()` right after capturing a flush error, expose it as `error` together with
`flushFailure: { batches, queuedRows, discarded }`, and clear both on the next successful flush. The components
render `<div role="alert">` with the message and call `onStreamError(error, failure?)` once per error. With
`policy: 'error'` a local `push` throws `AsterStreamBackpressureError` to the caller; with a Worker the producer-side
buffer throws the same class before anything is posted.

## Recovered expression errors (`logger`)

An expression that throws **at run time** is not a host error and not a reason to fail the render: vega's dataflow logs
it and carries on with what it has computed, and so does the engine. The report goes to `RuntimeInput.logger` (a
vega-shaped `{ error, warn, info?, debug? }`; default `console`; `<Chart logger>` and `SignalEventHooks.logger` forward
it). Nothing is swallowed without a report, and each report is the original `Error`.

| Where the expression threw | What is left (as in vega) |
|---|---|
| a conditional-encode `test` or branch, a `signal` or `field` in an encode | the failing item keeps the channels evaluated **before** the failing one (spec order); no later item, of this mark or any later one, is encoded or drawn (the run is aborted) |
| a dataset transform (`filter`, `formula`, ...) or a mark-level `transform` | the dataset publishes no rows; marks sourced from it are not built |
| a mark `sort`, a facet header `sort` | the rows stay in data order |
| a scale that cannot be built (bad `scheme`, unrecognised scale `type`, non-array `range`, ...) | the run stops there: this and later scales are absent and nothing is encoded |
| a `signal.on` filter or update, while an event is handled | that event's delivery stops (updates already applied stand); the next event works |

An evaluation that logged a recovery is not committed as the base of the next incremental one, so a following update
re-derives from scratch. Items an aborted run never encoded are dropped from their mark (vega draws nothing for them
either, apart from the zero-size rect path, which is invisible).

**Never recovered** (rethrown to the caller): `AsterLimitError`, `AsterUrlError`, `SpecParseError`, an expression that
does not **parse** (`ExpressionParseError`; vega throws those from `vega.parse`), and any error whose message starts
with `[aster]` (usage errors, the unsupported-feature errors below). For signal event handlers a malformed selector or
an unparsable update is reported to the logger when the handlers are bound and that handler is skipped.

```ts
import { renderSpec, type VgSpec } from '@aster/core'

const reports: unknown[] = []
const spec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'table', values: [{ a: 1 }, { a: 2 }], transform: [{ type: 'filter', expr: 'datum.a.b.c > 1' }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { width: { value: 5 }, height: { value: 5 } } } }],
}
const svg = renderSpec(spec, {
  logger: { error: (e) => reports.push(e), warn: () => {} },
})
console.log(reports.length, svg.includes('<svg')) // 1 true: the filter failed, the run carried on
```

## Unsupported and unknown features

These are thrown by the **runtime** while the chart is evaluated, not by `compileChart`. The compiler only checks the
shape of the spec (`[aster] compileChart expects a Vega spec object`, `[aster] spec.scales must be an array of scale
definitions`, `[aster] a scale definition must be an object`); a spec with an unknown transform compiles and then fails
on the first `renderSpec`/`evaluateChart`. They are plain `Error`s with an `[aster]` prefix and no `code`.

| Situation | Error |
|---|---|
| unknown transform `type` | `[aster] unsupported transform type "bogus"` |
| unknown aggregate op | `[aster] unsupported aggregate op "bogus" (vega: AggregateOps[op] is not a function)` |
| `width` / `height` of the form `{ step }` | `[aster] width/height {step} sizing is not supported yet` |
| a transform that needs a missing parameter | `[aster] Missing required "<type>" parameter: "<name>"` |
| a geo projection used without the addon | `[aster] this spec uses a geo projection; load the addon first: await import("@aster/core/geo")` |
| a rare transform (`kde`, `linkpath`, `treemap`, ...) without the addon | `[aster] this spec uses the "kde" transform; load the addon first: await import("@aster/core/transforms")` |
| `csv`/`tsv`/`topojson` data format without the addon | `[aster] this spec reads "csv" data; load the addon first: await import("@aster/core/load")` |
| an unknown symbol `shape` (not a built-in name, not a valid SVG path) | `Invalid SVG path, incorrect parameter count` (the same message vega gives) |
| a Vega-Lite spec without the VL addon (`<Chart>`, `useChart`, the worker handlers) | `A Vega-Lite spec was passed but the compiler is not loaded. Add ...` followed by the import to add, `import '@aster/react/vl'` (no `[aster]` prefix) |

Load the matching addon (`@aster/core/geo`, `@aster/core/transforms`, `@aster/core/load`) before calling `renderSpec` or another synchronous entry point
(`await loadAddonsFor(spec)` from `@aster/react`, or `loadAddons(missingAddons(spec))` from `@aster/core/addons`, does it for you). `<Chart>`, `<SvgChart>`, `useChart`,
`useChartStream` and the worker hooks load them themselves; if that import fails the error is `[aster] could not load the "geo" add-on (@aster/core/geo): <reason>`,
reported through `onError` (the hook's `error`), and it is remembered for the page (reload to retry).

### Deliberate differences from Vega

- **Unknown dataset names are fatal; unknown signal names are not.** An undeclared dataset used as a source (`from.data`,
  a scale domain) is `SpecParseError: Undefined data set name: "<name>"`, as `vega.parse`, from `compileChart` and so
  from every host. So is a name declared twice in one scope, `SpecParseError: Duplicate data set name: "<name>"`, with
  vega-parser's scoping: data sets, named marks, a facet's name, `root`, and every user-named mark a guide is made of
  (`encode.axis`, `encode.grid`, `encode.legend`, `encode.symbols`, ...) are data sets of the scope they are parsed in;
  a nested group owns its own names and may shadow its parents'. (Names such as `toString` crash vega's own parser;
  Aster does not reproduce that.) `vega.parse` also throws on an unknown signal name (`Unrecognized signal name`); Aster renders such a
  spec (the signal is `undefined`) without a report. An unknown scale `type` is not fatal either: vega throws at parse
  time, Aster logs it and stops building scales (see the table above).
- **Spec lists follow vega-util `array()`.** `data`, `scales`, `marks`, ... may be a lone object (a one-element list)
  or `null` (empty), as in `vega-parser`: `data: { values: [...] }` is accepted.
- **Unknown expression functions are fatal, except in a signal `update`.** A call to an unknown function in a formula,
  a filter or an encode `signal` throws `ExpressionParseError("Unrecognized function: <name>")` out of the
  render, as vega's parser does. In a signal `update` expression it does not: the update is skipped, the signal keeps
  its previous value, and nothing is reported (checked with a `logger`; vega throws from `parse`).
- **Unknown projection type.** Without the geo addon Aster throws the "load the addon" error above. With it, an
  unrecognised projection type throws `Unrecognized projection type: <type>` (a plain `Error` without the `[aster]`
  prefix) out of the render, where vega logs the same message and renders without the projection.
- **Vega-Lite is validated strictly.** `@aster/vl` implements a subset of Vega-Lite and throws a `VLCompileError`
  (`[aster/vl] <path>: <message>`) for an unknown key (`unknown top-level property "foo"`), a config property it does
  not implement (`config.bogus: this config property is valid Vega-Lite but is not supported by @aster/vl`), a
  feature it does not implement (`mark type "geoshape" is not supported by @aster/vl yet`) and an unknown mark.
  vega-lite itself compiles the first three (it ignores the key or property) and crashes on the unknown mark.
- **Safety refusals.** Limits, the regular-expression screen, the URL policy, the hard spec-depth ceiling and the
  `bin`/`stratify` refusals are Aster additions; see `docs/LIMITS.md`.

## Other runtime errors

- **Invalid URL/data** — `loadSpecData` rejects with `[aster] failed to load dataset url <url>: HTTP <status>`, an
  `AsterUrlError`, an `AsterLimitError` (timeout, size, redirects, rows), or a parse error such as `[aster] invalid
  JSON data: ...`.
- **Unloaded `url` dataset** — rendering a spec whose `url` dataset was never loaded throws `[aster] dataset "t" has a
  url but no data was loaded for it; resolve url datasets first: import { loadSpecData } from "@aster/core/load" and
  render await loadSpecData(spec, { baseURL, ... }), or pass the rows as input.data["t"]`.
- **Stratify** — `[aster] stratify: cycle | multiple roots | missing: id | ambiguous: id | no root` (vega's messages
  with the prefix), and `[aster] stratify requires a key field`.
- **Circular data reference** — named datasets cannot form a cycle: `[aster] circular data reference: <name>`.
- **Scale domain with a non-string `data`** — `SpecParseError` (`Undefined data set name: ...`), as vega's parser.
- **Unknown expression function** — a call to a name that is not a built-in, a registered function (see
  `registerExpressionFunction`), `if` or an event function throws `ExpressionParseError("Unrecognized function:
  <name>")` when the expression is compiled (vega: from its code generator). A function whose registration was
  disposed is treated the same way, including by expressions compiled before the disposal.
- **Expression functions** — `registerExpressionFunction` throws `[aster] registerExpressionFunction: "<name>" is not
  a plain identifier | is already an expression function, constant or keyword | needs a function`.
- **`bin`** — `[aster] bin: cannot derive a step size from base, maxbins and the data span` where vega would loop
  forever.
- **Render failure** — `<Chart>` renders `<div role="alert">` with `Chart render failed` (the message is in the
  `title`) or, for an `AsterLimitError`, the limit message itself, and calls `onError`; `useChart` returns `{ error }`
  (and `scene: null`).
- **Rejected `dataChanges`** — an unknown dataset, a non-integer or out-of-range index, or a changed row count makes
  `<Chart>` ignore the whole changeset (the update is diffed in full, the chart stays correct) and call `onError` with
  `[aster] dataChanges["<name>"]: ...`.
- **`@aster/vl`** — `compile()` throws `VLCompileError` for anything it validates (see above).

## Worker errors

`@aster/react/worker` answers a request with `{ id, error: { name, message, code? } }`; stream requests may add
`failure: { batches, queuedRows, discarded }`. The hooks rehydrate it with `errorFromWire` (see
[`instanceof` or `code`?](#instanceof-or-code) for what survives). In addition:

- A Worker `error` event ends the pending request with `Error('[aster] worker error: <message>')`, and a
  `messageerror` event with `Error('[aster] worker message could not be deserialized (messageerror)')`; a failing
  `postMessage` surfaces its own error. The hook's `error` is set and `pending` becomes `false`.
- A `textMetrics` object (or a `urlPolicy` with `allow`/`onDeny` functions) cannot be posted to a Worker: the hook
  fails with `[aster] a textMetrics provider object cannot be sent to a worker; register it in the worker with
  registerWorkerTextMetrics and pass its name` (respectively `... registerWorkerUrlPolicy ...`). An unregistered name
  fails in the worker with `[aster] unknown text-metrics provider "<name>" (register it with registerWorkerTextMetrics
  in the worker)` / `[aster] unknown url-policy hooks "<name>" ...`.
- The shipped worker entry (`@aster/react/worker-entry`) validates messages: a request without a spec object, a stream
  request with a bad `op`, `streamId`, `batches` or `options` is answered with a `TypeError` wire error
  (`[aster] request needs a spec object`, ...); a message without a numeric `id` is dropped because there is nobody to
  answer; a flush for an unknown stream gives `[aster] unknown stream <id>`.
