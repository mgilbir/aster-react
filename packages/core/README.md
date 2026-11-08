# @aster-charts/core

A TypeScript Vega rendering engine with no `vega-*`, `d3-*` or `topojson-*` dependency: it compiles a Vega spec to an IR,
evaluates data, scales and encodes into a renderer-neutral scene, and renders it to SVG (or to a canvas, or to a live DOM,
through the add-ons). The real Vega packages are used only as the test oracle.

Install (version 0.1.0 is not yet published to npm; the command works once the first release is tagged). Node 20 or newer;
no runtime dependencies and no peer dependencies:

```bash
npm i @aster-charts/core
```

```ts
import { renderSpec } from '@aster-charts/core'

const spec = {
  width: 200, height: 100,
  data: [{ name: 't', values: [{ x: 1 }, { x: 3 }] }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { value: 50 } } } }],
}
const svg = renderSpec(spec, { limits: { maxTimeMs: 2000 } })
```

Vega-Lite input goes through `@aster-charts/vl` (`compile(vlSpec)`) or `<Chart>` from `@aster-charts/react`.

Add-ons (each a separate entry, so a chart pays only for what it imports): `@aster-charts/core/dom` (incremental DOM, sessions),
`/canvas`, `/hit` (hit testing), `/signals` (the `signal.on` event loop), `/load` (URL datasets with a URL policy),
`/geo` (projections, contours), `/transforms` (the transforms listed in `TRANSFORMS_ADDON_TYPES`, exported from `@aster-charts/core/addons`, such as `pie`, `kde` and `treemap`; and the distribution functions).
`@aster-charts/core/addons` says which of them a spec needs (`addonsNeeded(spec)`) and imports the missing ones on
demand (`loadAddonsFor(spec)`); the React shells use it, so a spec renders with nothing imported
([how add-ons load themselves](https://github.com/mgilbir/aster-react/blob/main/docs/ARCHITECTURE.md#geo-projections--the-add-on-boundary)).

Specs from untrusted sources need `limits`; see [LIMITS](https://github.com/mgilbir/aster-react/blob/main/docs/LIMITS.md). See also the
[repository documentation](https://github.com/mgilbir/aster-react#readme), especially the [API reference](https://github.com/mgilbir/aster-react/blob/main/docs/API.md),
[LIMITS](https://github.com/mgilbir/aster-react/blob/main/docs/LIMITS.md) and [ERRORS](https://github.com/mgilbir/aster-react/blob/main/docs/ERRORS.md).
