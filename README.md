# Aster Charts

A small TypeScript reimplementation of the Vega/Vega-Lite rendering stack on granular D3 primitives. Accepts Vega (and Vega-Lite) specs and renders them to SVG, aiming to match the real Vega renderer's output.

## Status

**Pre-alpha.** The pipeline works end-to-end, verified against the real Vega renderer on a 419-spec conformance corpus (419/419; marks, scales, axes, legends, titles, config, expressions, signals, grouping, trellis faceting, and URL data loaders), a 27,513-case Vega-Lite schema sweep (99.7%, 0 differ), and a Chromium browser conformance gate (419/419). Not for production use.

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
| `packages/react` — `@aster/react` | React `<Chart>` (SVG/canvas, incremental DOM patching, selection, tooltips) and the headless `useChart` hook. |
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

### React API

```tsx
import { Chart, useChart } from '@aster/react'

<Chart
  spec={spec}
  renderer="svg"              // or "canvas"
  tooltip
  onSelect={(interval) => {}} // interval brush
  onPointSelect={(datum) => {}} // click/point selection (SVG + canvas)
  renderTooltip={(datum) => <b>{String(datum.c)}</b>}
  limits={{ maxRows: 100_000, maxItems: 50_000, maxSvgLength: 8_000_000 }}
/>

const { scene, svg, error, session } = useChart(spec, { width, height, data })
```

`limits` (and `renderSpec(spec, { limits })`) provides typed
`AsterLimitError` budgets for untrusted specs, including a wall-clock deadline
(`maxTimeMs`); see [docs/LIMITS.md](docs/LIMITS.md). A headless session is also
exported as `createChartSession` from `@aster/core/dom`.

`<Chart>` also accepts Vega-Lite directly, a promise spec under `<Suspense>`, a
controlled `view`/`selection`, and an imperative ref (`ChartHandle`). Pan/zoom,
keyboard navigation and the accessible scene tree work on both SVG and canvas.
SSR uses `renderChartToStaticMarkup` + `hydrateChart` when the server `<svg>` node must
be preserved, and `useChartWorker` offloads compile/evaluate/render when a Worker is
available.

## Documentation

- [API](docs/API.md) — core, React and Vega-Lite entry points
- [Interaction](docs/INTERACTION.md) — selection, pan/zoom, signals, accessibility
- [Limits](docs/LIMITS.md) / [Errors](docs/ERRORS.md) — untrusted specs and typed failures
- [Testing](docs/TESTING.md) — gates, fuzzing, reproducers
- [Performance](docs/PERFORMANCE.md) / [Fonts](docs/FONTS.md)
- [Release](docs/RELEASE.md) / [ADRs](docs/adr/README.md)

## Current Status / What Works

**Conformance (real-Vega oracle, 419-spec corpus): 419/419.** The core pipeline (Vega spec → compile → evaluate → SVG, plus the React `<Chart>` wrapper) is diffed against the real Vega renderer on a 419-spec corpus (both raw Vega `*.vg.json` and Vega-Lite `*.vl.json`, confirming the vega-lite compile path). This covers marks (line/area/bar/rule/scatter/symbol/rect/text/arc/path/image/trail/shape, with curves/gradients/corner-radii), band/linear/log/pow/time scales, axes (ticks/grid/labels/titles/`labelOverlap`), legends (gradient and symbol, at any corner), titles, config/style defaults, full vega expression surface, nested scopes, trellis/facet-2d layout, contour, geo projections, and URL data loaders.

**Schema sweeps (27,513 Vega-Lite property/value cases): 99.7% (27,418 ok, 0 differ).** For every property the Vega-Lite schema declares, a small chart is rendered through both engines and the SVG is diffed. Every comparable case now matches; the 95 non-ok cases are 40 specs both engines refuse, 21 oracle crashes/refusals (invalid SVG shapes/radii and degenerate `nice`/padding scale specs), and 34 nondeterministic `ci0`/`ci1` bootstrap aggregates (`Math.random` inside vega), tracked in the sweep family scoreboard (`pnpm sweep-vl`).

**Scene differential (`pnpm scene-diff`): 419/419.** Beyond the serialized SVG, the
resolved scales per scope (domain/range/bandwidth/colour endpoints), mark/item
multisets and overlap paint order are compared directly against Vega's scenegraph.

**Vega schema sweep: 7,538/7,549 with zero comparable differences.** The remaining
11 cases are 8 specs both engines refuse and 3 cases the Vega oracle itself crashes
on; see `pnpm sweep-vega`.

**Vega-Lite schema sweep: 27,418/27,513 with zero comparable differences.** The
remaining cases are 40 both-refused, 21 oracle crashes/refusals and 34 pinned
nondeterministic bootstrap aggregates; see `pnpm sweep-vl`.

**Browser conformance gate (`pnpm conformance:browser`): 419/419.** The same oracle protocol run in a real Chromium page (vega-embed SVG renderer with live canvas text metrics, vs `renderSpec`), because the Node harness runs both engines in jsdom where neither can measure text.

**What is NOT covered yet:**

- **Full reactive dataflow** — the session fingerprints identical renders (returns the cached scene) and partially re-evaluates only the marks whose dataset changed, but the datum set is still eagerly re-encoded per update; there is no per-datum source/target pulse graph.
- **Full Vega transform parity** — `bin` covers common cases but not every Vega option; `window`/`joinaggregate`/`impute` hold for common shapes.
- **[io] tracing/other rare layout transforms** — the opt-in addon covers `kde`/`quantile`/`regression`/`loess`/`pack`/`partition`/`treemap`/`wordcloud`/`voronoi`.

Expressions are CSP-safe: the engine evaluates them via the `vega-expression` AST interpreter (`vega-interpreter`), so no `new Function` is ever used.

## Performance

Compared against react-vega and the official vega-embed tutorial (see `packages/benchmarks`): on a browser bar chart @1000 points `<Chart>` holds 1.1% long frames under a 1-update-per-frame stream vs react-vega's 92%, updates in ~7 ms vs ~16 ms, retains ~0.0 MB heap per update (react-vega ~0.5 MB), and `@aster/react <Chart>` is ~104 kB gzip vs react-vega's 289 kB. In jsdom the same comparison is bar update ~11 ms vs ~77 ms and scatter update ~9 ms vs ~31 ms.

### Reactive differential updates

For charts where only a fraction of the data changes between renders, pass `dataChanges` to `<Chart>` (dataset → indices whose rows changed, with a same-length immutable `data` replacement):

```tsx
<Chart spec={spec} data={newRows} dataChanges={{ table: changedIndices }} />
```

The reactive dataflow re-derives only the changed rows, reuses unchanged scene items and DOM subtrees, and reuses scales whose domain is unchanged (both continuous min/max tracking and a discrete value-census for band/point/ordinal domains; rect marks additionally reuse their paint order when the sort permutation is unchanged). `pnpm bench:differential` measures the win at 50k points / 1% changed: row-wise (`formula`) ~17x, fixed-scale symbol ~12x, and `aggregate` ~3x faster than a full re-encode at the scene level, and ~5–9x at the DOM-patch level; in-browser (`bench:browser`) a 1%-changed update on 1000 points costs ~1.2 ms vs ~5–7 ms for a full re-encode. The `dataChanges` (and dataset) transforms must preserve row length/order; `window`/`stack` with a `sort` and the geo/layout operators fall back to a full re-derive.
