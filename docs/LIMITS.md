# Limits (untrusted specs)

All limits are optional. Omit one to leave that dimension unbounded.

```ts
import { renderSpec, type SpecLimits } from '@aster/core'

const limits: SpecLimits = {
  maxRows: 100_000,       // inline data[].values rows
  maxMarks: 200,          // mark definitions, recursive
  maxDepth: 32,           // spec object nesting
  maxStringLength: 10_000,
  maxItems: 50_000,       // generated scene items
  maxPathLength: 1_000_000,
  maxSvgLength: 8_000_000,
  maxTimeMs: 2_000,       // wall-clock compile+evaluate+render
}

renderSpec(spec, { limits })
```

Enforcement points:

1. **Pre-flight** (`checkSpecLimits`): rows, marks, strings, depth — before allocation.
2. **Evaluation** (`createLimitClock`): `maxTimeMs` at phase boundaries and every 2048
   encoded rows / in the dataset builder.
3. **Scene** (`checkSceneLimits`): item count, path length, text length.
4. **Serialization** (`checkSvgLength`): final SVG length.

`<Chart limits={…}>` applies the same budgets on SVG and canvas, and passes them to
`getChartInfo`/selection metadata. Session caching is bypassed when a deadline-limited
request would otherwise return a cached scene, so a cached render cannot accidentally
sidestep a time budget check.

Recommended starting point for a public dashboard: 100k rows, 50k items, 8 MB SVG,
2 s wall clock. For an unknown spec on a server, use smaller numbers (10k rows,
250 ms) and run the render in the worker.
