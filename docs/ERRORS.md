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
`checkSvgLength` and `createLimitClock`. `<Chart>` renders an alert instead of
calling an interaction handler, and reports the error through `onError`.

| Message fragment | Meaning |
|---|---|
| `maxRows`, `maxMarks`, `maxDepth`, `maxStringLength` | pre-flight spec budget |
| `maxItems`, `maxPathLength` | generated scene budget |
| `maxSvgLength` | serialized output budget |
| `maxTimeMs exceeded during …` | wall-clock deadline (`compile`, `evaluate`, `render`, `mark encoding`, …) |

## Other runtime errors

- **Unsupported scale/mark/transform** — the compiler throws with the spec location or
  type name. Load the matching addon first for geo/rare transforms/URL data.
- **Addon missing** — the error names the exact import, e.g.
  `[aster] geo addon not loaded; import '@aster/core/geo' first`.
- **Invalid URL/data** — `loadSpecData` rejects with the HTTP status or parse error.
- **Circular data reference** — named datasets cannot form a cycle.
- **Render failure** — `<Chart>` surfaces `Chart render failed` (or the typed limit
  message) and calls `onError`; `useChart` returns `{ error }`.

## Worker errors

`@aster/react/worker` returns `{ name, message, code? }` in its response and the hook
rehydrates it as an `Error`, so the consumer sees the same shape on both paths.
