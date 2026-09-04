# Aster Charts

A small TypeScript reimplementation of the Vega/Vega-Lite rendering stack on granular D3 primitives. Accepts Vega (and Vega-Lite) specs and renders them to SVG, aiming to match the real Vega renderer's output.

## Status

**Pre-alpha.** The pipeline works end-to-end, verified against the real Vega renderer on a 406-spec conformance corpus (marks, scales, axes, legends, titles, config, expressions, signals, grouping, trellis faceting, and URL data loaders). Not for production use.

## How It Works

Aster Charts treats the Vega spec as the canonical intermediate representation. The pipeline has three phases:

1. **Compile** — `compileChart(spec)` converts the Vega JSON spec (or a Vega-Lite spec compiled via `vega-lite.compile`) into a `CompiledChart` IR (data, scales, transforms, marks, axes, legends).
2. **Evaluate** — `evaluateChart(chart, input)` resolves the IR against runtime inputs (data rows, width/height, signals), applying eager transforms and building scale functions via `vega-scale` (exact parity with Vega's scale/tick semantics).
3. **Render** — `renderSceneToSvg(scene)` walks the resolved `SceneRoot` and produces a plain SVG string, mirroring `vega-scenegraph` structure and geometry.

Expressions (used in formulas, filters, and mark encodings) are parsed by `vega-expression` into an AST and evaluated by `vega-interpreter` in a CSP-safe interpreter — no `new Function`. The engine reuses only pure spec-language packages from the Vega ecosystem (`vega-expression`, `vega-interpreter`, `vega-scale`, `vega-format`, `vega-time`, `vega-util`) and rewrites all operational logic (spec compiler, transforms, scene, SVG renderer) on D3, keeping its runtime footprint small compared to bundling the full vega runtime.

## Repo Layout

| Package | Description |
|---------|-------------|
| `packages/core` — `@aster/core` | Compiler (spec -> IR), runtime (IR -> scene), SVG renderer, expression engine. Public API: `renderSpec`, `compileChart`, `evaluateChart`, `renderSceneToSvg`, `compileExpr`, `buildScale`, `applyTransforms`. |
| `packages/react` — `@aster/react` | Thin `<Chart>` React component rendering the SVG from `renderSpec`. |
| `packages/conformance` — `@aster/conformance` | Oracle harness: renders each corpus spec through both real Vega (dev-only) and `@aster/core`, canonicalizes SVGs, diffs geometry. |
| `packages/benchmarks` — `@aster/benchmarks` | Runtime/memory/bundle/browser performance harness comparing `<Chart>` vs react-vega and vega-embed; includes the core `renderSpec` gzip budget gate. |
| `.github/workflows/ci.yml` | CI pipeline: typecheck, build, test, conformance, bundle budget. |

## Quick Start

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm conformance
pnpm --filter @aster/benchmarks run budget
```

### Minimal Example

```ts
import { renderSpec } from '@aster/core'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 400, height: 300,
  data: { values: [
    { a: 'A', b: 28 }, { a: 'B', b: 55 }, { a: 'C', b: 43 }
  ]},
  scales: [
    { name: 'x', type: 'band', domain: { data: 'data0', field: 'a' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'data0', field: 'b' }, range: 'height', zero: true }
  ],
  axes: [{ scale: 'x', orient: 'bottom' }],
  marks: [{ type: 'rect', from: { data: 'data0' }, encode: {
    enter: { x: { scale: 'x', field: 'a' }, width: { scale: 'x', band: 1 },
             y: { scale: 'y', field: 'b' }, y2: { scale: 'y', value: 0 },
             fill: { value: '#4c78a8' } }
  }}]
}

const svg = renderSpec(spec)
// svg is a plain SVG string
```

## Current Status / What Works

**Conformance result (406 corpus specs): 406/406 passed.** The core pipeline (Vega spec → compile → evaluate → SVG, plus the React `<Chart>` wrapper) is diffed against the real Vega renderer oracle on a 406-spec conformance corpus: all pass. This covers marks (line/area/bar/rule/scatter/symbol/rect/text/arc/path/image/trail/shape, with curves/gradients/corner-radii), band/linear/log/pow/time scales, axes (ticks/grid/labels/titles/`labelOverlap`), legends (gradient and symbol, at any corner), titles, config/style defaults, full vega expression surface, nested scopes, trellis/facet-2d layout, contour, geo projections, and URL data loaders.

Both raw Vega (`*.vg.json`) and Vega-Lite (`*.vl.json`) entries are included, confirming the `vega-lite.compile` path is correct.

**What is NOT covered yet:**

- **Canvas rendering** — only SVG output is implemented.
- **Full reactive dataflow** — the session fingerprints identical renders (returns the cached scene) and partially re-evaluates only the marks whose dataset changed, but the datum set is still eagerly re-encoded per update; there is no per-datum source/target pulse graph.
- **Full Vega transform parity** — `bin` covers common cases but not every Vega option; `window`/`joinaggregate`/`impute` hold for common shapes.
- **[io] tracing/other rare layout transforms** — the opt-in addon covers `kde`/`quantile`/`regression`/`loess`/`pack`/`partition`/`treemap`/`wordcloud`/`voronoi`.

Expressions are CSP-safe: the engine evaluates them via the `vega-expression` AST interpreter (`vega-interpreter`), so no `new Function` is ever used.

## Performance

Compared against react-vega and the official vega-embed tutorial (see `packages/benchmarks`): on a browser bar chart @1000 points the incremental path (now the default in `<Chart>`) drops long frames from 30.3% → 1.1%, retains ~0 MB heap per update, and `@aster/react <Chart>` is ~86 kB gzip vs react-vega's 289 kB.
