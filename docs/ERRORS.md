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
