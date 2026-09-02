# Aster Charts

A small TypeScript reimplementation of the Vega/Vega-Lite rendering stack on granular D3 primitives. Accepts Vega (and Vega-Lite) specs and renders them to SVG, aiming to match the real Vega renderer's output.

## Status

**Pre-alpha, M1 milestone.** The pipeline works end-to-end across a 393-spec conformance corpus verified against the real Vega renderer. Static spec coverage is broad; reactive/interactive behavior and a few advanced layout subsystems remain. Not for production use.

## How It Works

Aster Charts treats the Vega spec as the canonical intermediate representation. The pipeline has three phases:

1. **Compile** — `compileChart(spec)` converts the Vega JSON spec (or a Vega-Lite spec compiled via `vega-lite.compile`) into a `CompiledChart` IR (data, scales, transforms, marks, axes, legends).
2. **Evaluate** — `evaluateChart(chart, input)` resolves the IR against runtime inputs (data rows, width/height, signals), applying eager transforms and building scale functions via `vega-scale` (exact parity with Vega's scale/tick semantics).
3. **Render** — `renderSceneToSvg(scene)` walks the resolved `SceneRoot` and produces a plain SVG string, mirroring `vega-scenegraph` structure and geometry.

Expressions (used in formulas, filters, and mark encodings) are parsed by `vega-expression` into an AST and evaluated by `vega-interpreter` in a CSP-safe interpreter — no `new Function`. The engine reuses only pure spec-language packages from the Vega ecosystem (`vega-expression`, `vega-interpreter`, `vega-scale`, `vega-format`, `vega-time`, `vega-util`) and rewrites all operational logic (spec compiler, transforms, scene, SVG renderer) on D3, keeping its runtime footprint small compared to bundling the full vega runtime.

## Repo Layout

| Package | Description |
|---------|-------------|
| `packages/core` — `@aster/core` | Compiler (spec -> IR), runtime (IR -> scene), SVG renderer, expression engine. Public API: `renderSpec`, `compileChart`, `evaluateChart`, `renderSceneToSvg`, `compileExpr`, `buildScale`, `applyTransforms`, plus incremental update: `createChartSession`, `patchSceneDom`, `renderSceneToDomElement`. |
| `packages/react` — `@aster/react` | Thin `<Chart>` React component rendering the SVG from `renderSpec`. |
| `packages/conformance` — `@aster/conformance` | Oracle harness: renders each corpus spec through both real Vega (dev-only) and `@aster/core`, canonicalizes SVGs, diffs geometry. |
| `packages/benchmarks` — `@aster/benchmarks` | Bundle-size budget script + performance harness vs the standard Vega-in-React embeddings (react-vega, vega-embed): mount/update/resize latency, frame pacing, memory, payload. See [`packages/benchmarks/README.md`](packages/benchmarks/README.md). |
| `.github/workflows/ci.yml` | CI pipeline: typecheck, build, test, conformance, bundle budget. |

## Quick Start

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm conformance           # 393-spec corpus vs real-Vega oracle (the CI gate)
pnpm probe                 # gap probes (diagnostic, NOT a gate): documents known gaps
pnpm --filter @aster/benchmarks run budget
pnpm bench                 # perf harness: aster vs react-vega vs vega-embed (needs build)
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

**Conformance corpus: 396/396 passed.**

The core pipeline (Vega spec → compile → evaluate → SVG) is verified against the real Vega renderer oracle on a 393-spec conformance corpus, spanning both raw Vega (`*.vg.json`) and Vega-Lite (`*.vl.json`, via `vega-lite.compile`) so both front-ends are held to the same geometry bar.

> **Geo & contour are opt-in addons.** Cartographic projections and the `contour`
> transform pull in `d3-geo` / `d3-contour` (~17 kB gzip), so they ship as a
> separate entry that a plain bar/line chart never bundles. Before rendering a
> spec that uses `projections`, a projected `geoshape`, or `contour`, load the
> addon once:
>
> ```ts
> await import('@aster/core/geo')   // or: import '@aster/core/geo'
> renderSpec(geoSpec)
> ```
>
> Without it, those specs throw an actionable "load the addon" error; every
> other chart renders unchanged and stays lean.

**What is covered and oracle-verified:**

- **Marks**: rect, line, area, symbol/circle, rule, text, arc, path, image, trail, shape/geoshape — including corner radius, per-corner rounding, curves (basis/cardinal/catmull/monotone/step/natural/bundle with tension), stroke dash, fill gradients, multi-line text via `lineBreak` → tspans.
- **Scales**: linear/pow/sqrt/log/symlog/time/utc/band/point/ordinal/quantile/quantize/threshold/sequential, color schemes (including scheme-range *without* zero extension), `values`/`step` ranges, domain sort.
- **Axes**: tick marks, grid, domain, numeric + time labels, axis titles (all 4 orients), `labelOverlap` parity removal, label padding/baseline geometry.
- **Legends**: gradient (vertical/right + horizontal strip), symbol (single-column + multi-column grids at any corner via `columns`/`direction`), size, and band legends; bottom-flow (vertical + horizontal).
- **Guides & spec language**: top-level chart **title + subtitle** (anchored against content bounds), static **signal `update`** expressions resolved to a fixed point, `config` (background/view/style.<mark>/axis/legend, transparent-stroke handling), `enter`+`update` encode merging, per-dataset transforms.
- **Nested scopes**: group marks that declare their own `scales`/`axes`/`data` render in an isolated child scope (parent datasets shared, `width`/`height` scale ranges resolve against the parent per vega semantics).
- **Transforms**: formula, filter, collect, bin, fold, flatten, impute, stack, aggregate, window, joinaggregate, extent, lookup, identifier, timeunit, kde, quantile, regression, loess, density, geoshape (with **d3-geo projections**: mercator/albers/equirectangular/…), pack/partition/treemap, voronoi, graticule, sequence, wordcloud.
- **Expressions**: the full expression function surface — type checks/coercions, math, array, string (pad/truncate/split…), **date-time accessors** (year/quarter/week/utc…), color (rgb/hsl/lab/hcl/luminance/contrast), regexp, and scale/projection/data functions (`scale`, `invert`, `domain`, `range`, `bandwidth`, `bandspace`, `data`, `indata`). CSP-safe via `vega-interpreter` (no `new Function`).

### Gap probes

Feature areas that are **known-incomplete** live in `packages/conformance/probes/` and run under `pnpm probe` (a diagnostic, **not** a CI gate). When a gap is implemented, its probe is promoted to `corpus/`. Remaining documented gaps:

- `contour` — the transform + density/marching-squares run, but pixel-exact oracle parity needs vega's float sequence in the density blur.
- `vl-facet-2d` — 2-D (row×column) facet grids: renders 129/129 records but the bottom-row cells' axis orientation still diverges.
- `vl-title-legend` — chart title anchored against a combined layout (rotated axis title + legend) still drifts by a few px.

**What is NOT covered yet (beyond the probes above):**

- **Interactive selections / event-driven signals** — `signal.on` streams and event handlers are ignored (static mode); `invert`/brush is exposed via `<Chart onSelect>` but there is no general signal→view event loop.
- **Reactive dataflow** — updates re-encode the whole scene; there is no partial per-dataset re-evaluation.
- **Canvas rendering** — only SVG output.

Expressions are CSP-safe: the engine evaluates them via the `vega-expression` AST interpreter (`vega-interpreter`), so no `new Function` is ever used.
