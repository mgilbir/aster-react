# Errors

Aster distinguishes **host errors** from **spec errors** with one typed class:

```ts
import { AsterLimitError } from '@aster/core'

try {
  renderSpec(untrustedSpec, { limits: { maxRows: 10_000, maxTimeMs: 500 } })
} catch (err) {
  if (err instanceof AsterLimitError) {
    console.error(err.code)    // "ASTER_LIMIT"
    console.error(err.message) // "[aster] limit exceeded: maxRows 250000 > 10000"
  } else {
    throw err
  }
}
```

## Budget errors

`AsterLimitError` is thrown by `checkSpecLimits`, `checkSceneLimits`,
`checkSvgLength` and `createLimitClock`, and by the meters inside transforms,
the encode loop, guide generation, expression builtins and the expression parser
(see `docs/LIMITS.md`). A violation raised anywhere in a render is never
swallowed by a defensive `catch`: the call fails with it. Use `err.code ===
'ASTER_LIMIT'` across a worker boundary. `<Chart>` renders an alert instead of
calling an interaction handler, and reports the error through `onError`.

| Message fragment | Meaning |
|---|---|
| `maxRows`, `maxMarks`, `maxDepth`, `maxStringLength` | pre-flight spec budget; `maxRows` also caps any dataset a transform produces, `maxDepth` also covers expression nesting and cyclic specs (`spec contains a cycle`) |
| `maxGeneratedRows`, `maxGeneratedBytes` | cumulative rows / characters generated during one evaluation |
| `maxItems`, `maxPathLength` | generated scene budget (also tick counts and generated paths) |
| `timeoutMs`, `maxBytes`, `maxRedirects` | `loadSpecData` request caps (`AsterLimitError`) |
| `maxSvgLength` | serialized output budget |
| `maxTimeMs exceeded during …` | wall-clock deadline (`compile`, `evaluate`, `render`, `mark encoding`, …) |

## Stream errors

`createChartStream` throws two typed errors, each with a stable `code` (use the code,
not `instanceof`, across a worker boundary or duplicated bundles):

| Class | `code` | When |
|---|---|---|
| `AsterStreamBackpressureError` | `ASTER_STREAM_BACKPRESSURE` | `policy: 'error'` and a `push` would exceed `capacity` (batches, `bound: 'batches'`) or `maxQueuedRows` (rows, `bound: 'rows'`); `limit` is the configured bound |
| `AsterStreamClosedError` | `ASTER_STREAM_CLOSED` | `stream.session()` after `close()` (`push`/`flush` after close are no-ops, not errors) |

A `flush()` that throws (any error, including `AsterLimitError`) leaves the stream
exactly as it was before the call, with its batches still queued, and rethrows the
original error. `getStreamFlushFailure(err)` returns `{ batches, queuedRows }` for such an
error, and `stream.discard()` drops the queued batches so the next flush can succeed
(otherwise every later flush fails the same way). See "Atomic flush" and "Recovering from
a failed flush" in `docs/API.md`.

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
| a scale that cannot be built (bad `scheme`, non-array `range`, ...) | the run stops there: this and later scales are absent and nothing is encoded |
| a `signal.on` filter or update, while an event is handled | that event's delivery stops (updates already applied stand); the next event works |

An evaluation that logged a recovery is not committed as the base of the next incremental one, so a following update
re-derives from scratch. Items an aborted run never encoded are dropped from their mark (vega draws nothing for them
either, apart from the zero-size rect path, which is invisible).

**Never recovered** — these are the host's controls and the spec's own faults, and still throw: `AsterLimitError`,
`AsterUrlError`, `[aster]` usage errors, and an expression that does not **parse** (`ExpressionParseError`; vega throws those
from `vega.parse`). For signal event handlers a malformed selector or an unparsable update is reported when the handlers
are bound and that handler is skipped.

```ts
renderSpec(spec, { logger: { error: (e) => telemetry.report(e), warn: () => {} } })
```

## Other runtime errors

- **Unsupported scale/mark/transform** — the compiler throws with the spec location or
  type name. Load the matching addon first for geo/rare transforms/URL data.
- **Addon missing** — the error names the exact import, e.g.
  `[aster] geo addon not loaded; import '@aster/core/geo' first`.
- **Invalid URL/data** — `loadSpecData` rejects with the HTTP status or parse error.
- **URL refused by the policy** — `AsterUrlError` (`code: 'ASTER_URL_DENIED'`, `reason`):
  protocol, credentials, non-public host, `allow` veto, missing `baseURL`. Thrown by
  `loadSpecData` before any request, and by image marks under `urlPolicy`/`limits`.
- **Unloaded `url` dataset** — rendering a spec whose `url` dataset was never loaded throws
  `dataset "x" has a url but no data was loaded for it` (call `loadSpecData` first).
- **Stratify** — `[aster] stratify: cycle | multiple roots | missing: id | ambiguous: id | no root`
  (vega's messages).
- **Circular data reference** — named datasets cannot form a cycle.
- **Render failure** — `<Chart>` surfaces `Chart render failed` (or the typed limit
  message) and calls `onError`; `useChart` returns `{ error }`.

## Worker errors

`@aster/react/worker` returns `{ name, message, code? }` in its response and the hook
rehydrates it as an `Error`, so the consumer sees the same shape on both paths.
