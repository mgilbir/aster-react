# @aster-charts/core

A TypeScript Vega rendering engine with no `vega-*`, `d3-*` or `topojson-*` dependency: it compiles a Vega spec to an IR,
evaluates data, scales and encodes into a renderer-neutral scene, and renders it to SVG (or to a canvas, or to a live DOM,
through the add-ons). The real Vega packages are used only as the test oracle.

Install. Node 20 or newer; TypeScript needs `"moduleResolution": "bundler"`, `"node16"` or `"nodenext"`: the packages declare their types through `exports` only (no `typesVersions`), so the older `"node"` (node10) resolution cannot find a subpath such as `@aster-charts/react/vl` or `@aster-charts/core/dom`, and loses the types the root entry takes from them (`ChartSession`, `PngOptions`, `EnginePart` become `any`) without an error under `skipLibCheck`. no runtime dependencies and no peer dependencies:

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
`/geo` (projections, contours), `/transition` (interpolating two scenes), `/png` (a scene as a PNG), `/transforms` (the transforms listed in `TRANSFORMS_ADDON_TYPES`, exported from `@aster-charts/core/addons`, such as `pie`, `kde` and `treemap`; and the distribution functions).
`@aster-charts/core/addons` says which of them a spec needs (`addonsNeeded(spec)`) and imports the missing ones on
demand (`loadAddonsFor(spec)`); the React shells use it, so a spec renders with nothing imported
([how add-ons load themselves](https://github.com/mgilbir/aster-react/blob/main/docs/ARCHITECTURE.md#geo-projections--the-add-on-boundary)).
Every entry carries the whole engine, so `renderSpec` and the other synchronous functions draw any spec with nothing to load. The
same module also names the *parts* of the engine a spec needs (`specNeeds(spec).parts`: the rarer transforms, time, curves, colour
ramps, rare scale types, legends, ...), which `@aster-charts/react` loads on demand in a browser build (a resolver that applies the `browser` export condition), and `preloadParts(names?)`
fetches them ahead of time.

Specs from untrusted sources need `limits`; see [LIMITS](https://github.com/mgilbir/aster-react/blob/main/docs/LIMITS.md). See also the
[repository documentation](https://github.com/mgilbir/aster-react#readme), especially the [API reference](https://github.com/mgilbir/aster-react/blob/main/docs/API.md),
[LIMITS](https://github.com/mgilbir/aster-react/blob/main/docs/LIMITS.md) and [ERRORS](https://github.com/mgilbir/aster-react/blob/main/docs/ERRORS.md).
