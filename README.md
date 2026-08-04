# Aster Charts

A small TypeScript reimplementation of the Vega/Vega-Lite rendering stack on granular D3 primitives. Accepts Vega (and Vega-Lite) specs and renders them to SVG, aiming to match the real Vega renderer's output.

## Status

**Pre-alpha, M0 milestone.** The pipeline works end-to-end for a subset of Vega marks and scales; many features remain incomplete. Not for production use.

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
| `packages/benchmarks` — `@aster/benchmarks` | Bundle-size budget script (esbuild minimal chart, gzip vs 60 kB budget). |
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

**Conformance result (16 corpus specs): 16/16 passed.**

The core pipeline (Vega spec → compile → evaluate → SVG) is verified against the real Vega renderer oracle on a 16-spec conformance corpus: all 16 pass.

**What the corpus covers:**

| Area | Covered specs |
|------|---------------|
| Mark types | `line-basic`, `area-basic`, `area-vg`, `bar-bands`, `bar-basic`, `bar-vl`, `rule`, `scatter-basic`, `scatter-vg`, `tick-vg` |
| Point / symbol | `point-vl` |
| Scales | linear (`line-basic`, `scatter-basic`), band (`bar-*`), log (`line-log`), utc/time (`line-time`) |
| Axes | grid, tick marks, and domain strokes (labels/titles deliberately disabled in the corpus) |
| Transforms | eager stack (`bar-bands`), impute (`scatter-vg`), formula (`line-log`), filter (`line-log`) |

This includes both raw Vega (`*.vg.json`) and Vega-Lite (`*.vl.json`) entries, confirming that the `vega-lite.compile` path is also correct.

**What is NOT covered yet:**

- **Axis tick label positioning** — labels and titles are disabled in the corpus; text placement is a known gap.
- **Legends** — the `CompiledLegend` IR exists but there is no legend renderer / geometry.
- **Interactive selections / params** — no signal/event system at all.
- **Reactive dataflow** — current execution is static/eager re-evaluation per `renderSpec` call (no incremental update).
- **Canvas rendering** — only SVG output is implemented.
- **Full Vega transform parity** — some transforms exist but with limited support (bin, window, joinaggregate).

Expressions are CSP-safe: the engine evaluates them via the `vega-expression` AST interpreter (`vega-interpreter`), so no `new Function` is ever used.
