# @aster/core

A TypeScript Vega rendering engine with no `vega-*`, `d3-*` or `topojson-*` dependency: it compiles a Vega spec to an IR,
evaluates data, scales and encodes into a renderer-neutral scene, and renders it to SVG (or to a canvas, or to a live DOM,
through the addons). The real Vega packages are used only as the test oracle.

```ts
import { renderSpec } from '@aster/core'

const spec = {
  width: 200, height: 100,
  data: [{ name: 't', values: [{ x: 1 }, { x: 3 }] }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { value: 50 } } } }],
}
const svg = renderSpec(spec, { limits: { maxTimeMs: 2000 } })
```

Vega-Lite input goes through `@aster/vl` (`compile(vlSpec)`) or `<Chart>` from `@aster/react`.

Addons (each a separate entry, so a chart pays only for what it imports): `@aster/core/dom` (incremental DOM, sessions),
`/canvas`, `/hit` (hit testing), `/signals` (the `signal.on` event loop), `/load` (URL datasets with a URL policy),
`/geo` (projections, contours), `/transforms` (kde, regression, loess, pack, partition, treemap, wordcloud, voronoi).

Specs from untrusted sources need `limits`; see `docs/LIMITS.md`. See also the
[repository documentation](https://github.com/mgilbir/aster-react#readme), especially `docs/API.md`, `docs/LIMITS.md`
and `docs/ERRORS.md`.
