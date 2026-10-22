# @aster/react

Idiomatic React bindings for Aster Charts: `<Chart>` (SVG/canvas, Vega or Vega-Lite
input), `useChart`, `useSpecData`, `useChartWorker`, SSR/hydration helpers, declarative
selection/pan/zoom and an accessible scene tree.

```tsx
import { Chart } from '@aster/react'
// Vega-Lite is opt-in (~23 kB gzip saved when you don't need it):
import '@aster/react/vl'

<Chart spec={spec} panZoom tooltip a11y limits={{ maxTimeMs: 2000 }} />
```

Vega specs need only the first import. Without `@aster/react/vl`, a Vega-Lite spec
throws an error naming the missing import; the addon also has to be imported in a
worker entry if you compile VL specs there.

See `docs/API.md`, `docs/INTERACTION.md` and `docs/RELEASE.md` in the repository.
