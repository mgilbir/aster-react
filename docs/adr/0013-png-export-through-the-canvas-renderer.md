# ADR 0013: PNG export is the canvas renderer's pixels, encoded by the browser

Date: 2026-11-25
Status: Accepted (records a decision in force since 0.4.0; the scope paragraph of [ROADMAP.md](../ROADMAP.md) is its summary)

## Context

The deliverables are SVG and canvas output. A host that wants a raster of a chart usually draws the chart's SVG into an `<img>` and
then into a canvas, which needs `blob:` or `data:` in the page's `img-src` and so fails under a Content-Security-Policy that
allows neither (#144).

## Decision

1. **One convenience, no workstream.** `renderSceneToPng(scene, { scale, imageTimeoutMs, onImageError })` (`@aster-charts/core/png`)
   paints a scene with the canvas renderer and lets the platform canvas encode it as a PNG `Blob`: exactly the pixels
   `renderSceneToCanvas` paints. `getPng(options?)` on the ref of `<Chart>` (and of `<SvgChart>` given `png={png}` from
   `@aster-charts/react/png`) is that call on the chart's scene (`null` while there is none).
2. **Out of scope:** PDF, any image format the browser's canvas does not encode, and any server-side PNG (a server has no canvas).
3. **It costs nothing until it is called.** The painter, with the canvas renderer, is imported on the first `getPng` call; a chart that
   never exports does not load it. `<SvgChart>` gets it only through the `png` prop, as it gets `interaction`
   ([ADR 0007](0007-svgchart-shell-over-lazy-loading.md)).
4. Image marks are loaded from their urls with CORS, as vega's canvas loads them; one that does not load is left out and reported
   through the chart's `logger`. No `blob:` or `data:` image is loaded.

## Consequences

- The export is as faithful as the canvas renderer (`pnpm conformance:canvas` compares it with vega's canvas pixels).
- The size of the raster is the scene's size times `scale`. One past 32,767 pixels a side or 268,435,456 in all is refused before a canvas is made (`[aster] renderSceneToPng: a W x H image is too large`): use a smaller `scale`.

## Where it is implemented and held

- `packages/core/src/png.ts`, `packages/react/src/png-capability.ts`, `packages/react/src/Chart.png.test.tsx`.
- Budget rows `+ @aster-charts/core/png` and the `SvgChart` rows of `packages/benchmarks/scripts/budget-rows.mjs`.
