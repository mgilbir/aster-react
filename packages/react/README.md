# @aster/react

Idiomatic React bindings for Aster Charts: `<Chart>` (SVG/canvas, Vega or Vega-Lite
input), `useChart`, `useSpecData`, `useChartWorker`, SSR/hydration helpers, declarative
selection/pan/zoom and an accessible scene tree.

```tsx
import { Chart } from '@aster/react'

<Chart spec={spec} panZoom tooltip a11y limits={{ maxTimeMs: 2000 }} />
```

See `docs/API.md`, `docs/INTERACTION.md` and `docs/RELEASE.md` in the repository.
