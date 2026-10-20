# Third-party notices

Aster Charts has no runtime dependencies on `vega-*` or `d3-*` packages.
Its public behaviour is verified against and modelled on the following
open-source projects, which remain dev/benchmark/conformance dependencies:

- **Vega / Vega-Lite / vega-scenegraph / vega-scale / vega-time / vega-format /
  vega-util / vega-expression / vega-interpreter / vega-transforms** —
  BSD-3-Clause, Copyright (c) 2015-2026, Jeffrey Heer, Dominik Moritz,
  UW Interactive Data Lab and contributors.
- **D3 (d3-array, d3-color, d3-contour, d3-dsv, d3-format, d3-geo, d3-scale,
  d3-shape, d3-time, d3-time-format, d3-interpolate, d3-scale-chromatic)** —
  ISC, Copyright 2010-2023 Mike Bostock.
- **topojson-client** — ISC, Copyright 2012-2023 Michael Bostock.
- **React / React DOM** — MIT, Copyright (c) Meta Platforms, Inc. and affiliates.
- **TypeScript, esbuild, Vite, Vitest, tsx, playwright, pnpm** — their
  respective MIT/Apache-2.0 licenses.

Colour palettes in `packages/core/src/scale-schemes.ts` are transcribed from
`vega-scale` and `d3-scale-chromatic` under their respective BSD-3-Clause and
ISC licenses.
