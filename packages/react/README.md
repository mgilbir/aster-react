# @aster/react

React bindings for Aster Charts: `<Chart>` (SVG or canvas; Vega, or Vega-Lite through an opt-in add-on), `useChart`,
`useSpecData`, `useChartWorker`, streaming components and hooks, SSR/hydration helpers, declarative selection and
pan/zoom, and an accessible scene tree.

Install (version 0.1.0 is not yet published to npm; the command works once the first release is tagged). Node 20 or newer;
`react` ^19 is a peer dependency, and a browser app mounts with `react-dom`. `@aster/core` and `@aster/vl` are installed with it as
dependencies; add `@aster/core` yourself only if your code imports it (for example `@aster/core/dom`).

```bash
npm i @aster/react react react-dom
```

```tsx
import { Chart } from '@aster/react'
// Vega-Lite is opt-in: importing this registers the compiler (and adds its size to your bundle).
import '@aster/react/vl'

declare const spec: Record<string, unknown> // a Vega or Vega-Lite spec

export const Demo = () => <Chart spec={spec} panZoom tooltip a11y limits={{ maxTimeMs: 2000 }} />
```

Vega specs need only the first import. The opt-in core add-ons (`@aster/core/transforms`, `/geo`, `/load`) are loaded on demand when
a spec needs them: the chart suspends meanwhile (wrap it in `<Suspense>` for a fallback), then renders as it would have with the add-on
imported ([how add-ons load themselves](https://github.com/mgilbir/aster-react/blob/main/docs/ARCHITECTURE.md#geo-projections--the-add-on-boundary)). Without `@aster/react/vl`, a Vega-Lite spec throws an error naming the missing
import; if you compile Vega-Lite specs in a worker, import the add-on in the worker entry too.

For a smaller bundle there is an SVG-only chart: `<SvgChart>` from `@aster/react/lite` (182.5 kB gzip against 205.3 kB for
`<Chart>`, measured 2026-11-06 with `pnpm --filter @aster/benchmarks run budget`; it never imports the canvas renderer). Tooltips, point selection and `signal.on` event streams come with the
`interaction` capability, passed as a prop (199.7 kB gzip with it; current figures in [docs/PERFORMANCE.md](https://github.com/mgilbir/aster-react/blob/main/docs/PERFORMANCE.md#bundle-sizes)):

```tsx
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'

declare const spec: Record<string, unknown> // a Vega spec

export const Small = () => <SvgChart spec={spec as never} interaction={interaction} tooltip />
```

`react` (^19) is a peer dependency. See the [API reference](https://github.com/mgilbir/aster-react/blob/main/docs/API.md) and [INTERACTION](https://github.com/mgilbir/aster-react/blob/main/docs/INTERACTION.md) in the repository.
