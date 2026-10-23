# @aster/react

React bindings for Aster Charts: `<Chart>` (SVG or canvas; Vega, or Vega-Lite through an opt-in addon), `useChart`,
`useSpecData`, `useChartWorker`, streaming components and hooks, SSR/hydration helpers, declarative selection and
pan/zoom, and an accessible scene tree.

```tsx
import { Chart } from '@aster/react'
// Vega-Lite is opt-in: importing this registers the compiler (and adds its size to your bundle).
import '@aster/react/vl'

declare const spec: Record<string, unknown> // a Vega or Vega-Lite spec

export const Demo = () => <Chart spec={spec} panZoom tooltip a11y limits={{ maxTimeMs: 2000 }} />
```

Vega specs need only the first import. Without `@aster/react/vl`, a Vega-Lite spec throws an error naming the missing
import; if you compile Vega-Lite specs in a worker, import the addon in the worker entry too.

For a smaller bundle there is an SVG-only chart: `<SvgChart>` from `@aster/react/lite` (142 kB gzip against 157 kB for
`<Chart>`; it never imports the canvas renderer). Tooltips, point selection and `signal.on` event streams come with the
`interaction` capability, passed as a prop (151.5 kB gzip with it):

```tsx
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'

declare const spec: Record<string, unknown> // a Vega spec

export const Small = () => <SvgChart spec={spec as never} interaction={interaction} tooltip />
```

`react` (^19) is a peer dependency. See `docs/API.md`, `docs/INTERACTION.md` and `docs/RELEASE.md` in the repository.
