# Aster Charts

A TypeScript reimplementation of the Vega and Vega-Lite rendering stack, with React bindings. It
accepts Vega specs (and Vega-Lite specs through `@aster/vl`) and renders them to SVG or canvas, aiming
to produce what the real Vega renderer produces. The real `vega` and `vega-lite` packages are the test
oracle only; nothing in the published packages imports them or any `d3-*` / `topojson-*` package.

## Status

**Pre-alpha. Not published.** The behaviour is checked against the real packages by the gates in
[`scripts/gates.mjs`](scripts/gates.mjs) (`pnpm check`). The current results, each next to the command that
produced it, are in [docs/TESTING.md](docs/TESTING.md#reference-results) and
[docs/PERFORMANCE.md](docs/PERFORMANCE.md#reference-measurements); in short, as measured on this tree:

- the SVG corpus (794 specs: 319 Vega, 475 Vega-Lite) renders identically to real Vega under a strict
  canonicalizer: `pnpm conformance` (794/794);
- the same 475 Vega-Lite specs compiled by `@aster/vl` render identically to vega-lite's output: `pnpm conformance-vl` (475/475);
- the schema sweeps (one chart per property/value of the schema) have no differences: Vega 7538 ok of 7549 (8 both-refused, 3 the oracle itself crashes on), Vega-Lite 27452 ok of 27513 (44 both-refused, 17 oracle crashes),
  signals 104 ok of 166 (59 `retained`, see below; 0 differ);
- in real Chromium, the corpus matches Vega's string renderer (794/794), the canvas renderer matches Vega's canvas (795/795 pixel comparisons),
  and signal event streams match Vega (38/38 cases).

Known gaps and deliberate differences from Vega are listed in [docs/LIMITS.md](docs/LIMITS.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deviations-from-vega) and [docs/ROADMAP.md](docs/ROADMAP.md). Specs from
untrusted sources need `limits` (and, for regular expressions, a killable worker): read
[docs/LIMITS.md](docs/LIMITS.md) before rendering them.

## How It Works

The Vega spec is the canonical intermediate representation. A Vega-Lite spec is first compiled to Vega by
`@aster/vl`. The Vega pipeline has three phases, all implemented in `@aster/core`:

1. **Compile**: `compileChart(spec)` turns the Vega JSON into a `CompiledChart` IR (data, scales, transforms, marks, axes, legends, signals).
2. **Evaluate**: `evaluateChart(chart, input)` resolves the IR against runtime inputs (data rows, size, signals): it runs the
   transforms, builds the scales and builds the scene graph, with Vega's layout, bounds and guide algorithms. Updates are
   incremental: a changed row, an appended batch or a changed signal re-derives only what it affects, and the result always
   equals a fresh evaluation ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#incremental-evaluation)).
3. **Render**: `renderSceneToSvg(scene)` produces an SVG string that has the structure of `vega-scenegraph`'s SVG renderer
   (classes, roles and ARIA labels included, compared by the conformance gate); the
   `@aster/core/dom` addon patches a live `<svg>` instead, and `@aster/core/canvas` paints the same scene to a canvas.

Everything below the spec language is owned: the expression parser and CSP-safe interpreter (no `new Function`), scales, ticks
and colour schemes, number and time formatting, time zones, curves and symbols, geo projections, contours, DSV and TopoJSON
readers, and the transforms. They are ports of the upstream algorithms, each checked against oracle vectors recorded from the
pinned upstream packages ([docs/TESTING.md](docs/TESTING.md#oracle-vectors)); their licences are reproduced in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Repo Layout

| Path | Description |
|---------|-------------|
| `packages/core` (`@aster/core`) | Compiler (spec to IR), runtime (IR to scene), SVG renderer, expression engine, limits. Entry points: `.`, `/dom` (incremental DOM, sessions), `/canvas`, `/hit` (hit testing), `/signals` (event loop), `/load` (URL datasets), `/geo`, `/transforms`. |
| `packages/react` (`@aster/react`) | `<Chart>` (SVG/canvas, incremental DOM patching, selection, pan/zoom, tooltips, accessibility tree), `useChart`, streaming and worker components and hooks, SSR helpers. `@aster/react/vl` registers the Vega-Lite compiler. |
| `packages/vl` (`@aster/vl`) | The Vega-Lite to Vega compiler. Throws `VLCompileError` for what it does not support. |
| `packages/conformance` (`@aster/conformance`, private) | The oracle harness: corpus, sweeps, vectors, browser gates, fuzzing. |
| `packages/benchmarks` (`@aster/benchmarks`, private) | Runtime, memory, bundle and browser performance harness (`<Chart>` vs react-vega and vega-embed) and the bundle-size budgets. |
| `apps/demo` (private) | A gallery and playground that renders Aster next to Vega. |
| `scripts/` | The gate list (`gates.mjs`), dependency boundary, publish verification, release guards and their tests. |
| `.github/workflows/` | `ci.yml` (runs `pnpm check`), `nightly.yml` (sweeps, fuzzing, extra browsers), `release.yml` (tag-triggered, see [docs/RELEASE.md](docs/RELEASE.md)). |

## Quick Start

```bash
pnpm install
pnpm build
pnpm check          # every gate; `pnpm check -- --list` shows them, `-- --skip browser` skips the Chromium ones
```

### Minimal Example

```ts
import { renderSpec } from '@aster/core'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 400, height: 300,
  data: [{ name: 'data0', values: [
    { a: 'A', b: 28 }, { a: 'B', b: 55 }, { a: 'C', b: 43 },
  ] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 'data0', field: 'a' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'data0', field: 'b' }, range: 'height', zero: true },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  marks: [{ type: 'rect', from: { data: 'data0' }, encode: {
    enter: { x: { scale: 'x', field: 'a' }, width: { scale: 'x', band: 1 },
             y: { scale: 'y', field: 'b' }, y2: { scale: 'y', value: 0 },
             fill: { value: '#4c78a8' } },
  } }],
}

const svg = renderSpec(spec)
// svg is a plain SVG string
```

`data` is a list of named datasets. As in `vega-parser`, a lone object stands for a one-element list (the lists
are read through vega-util `array()`), and a mark that reads a dataset the spec does not declare fails with
`SpecParseError: Undefined data set name: "<name>"`. This example is rendered by real Vega and by Aster in the
tests and the outputs agree.

### React API

```tsx
import { useState } from 'react'
import { Chart, useChart } from '@aster/react'

declare const spec: Record<string, unknown> // a Vega spec, as above

export function Demo() {
  const [rows] = useState([{ a: 'A', b: 28 }, { a: 'B', b: 55 }])
  return (
    <Chart
      spec={spec}
      data={{ data0: rows }}          // dataset name -> rows; a new array is diffed against the last one
      renderer="svg"                  // or "canvas"
      tooltip
      onPointSelect={(datum) => console.log(datum)}
      renderTooltip={(datum) => <b>{String(datum.a)}</b>}
      limits={{ maxRows: 100_000, maxItems: 50_000, maxSvgLength: 8_000_000 }}
    />
  )
}

// headless: the evaluated scene and SVG, no DOM
export function Headless() {
  const { scene, svg, error } = useChart(spec, { width: 400, height: 300, data: { data0: [{ a: 'A', b: 28 }] } })
  return error ? <p>{String(error)}</p> : <pre>{scene ? svg : ''}</pre>
}
```

`limits` (and `renderSpec(spec, { limits })`) gives typed `AsterLimitError` budgets for untrusted specs, including
a wall-clock deadline (`maxTimeMs`); see [docs/LIMITS.md](docs/LIMITS.md). A headless session is exported as
`createChartSession` from `@aster/core/dom`.

`<Chart>` also accepts Vega-Lite (opt-in: `import '@aster/react/vl'`), a promise spec under `<Suspense>`, a
controlled `view`/`selection`, and an imperative ref (`ChartHandle`). Pan/zoom, keyboard navigation and the accessible scene
tree work on SVG and canvas. SSR uses `renderChartToStaticMarkup` + `hydrateChart` when the server `<svg>` node must be
preserved, and `useChartWorker` offloads compile/evaluate/render when a Worker is available. The full surface is in
[docs/API.md](docs/API.md).

### Differential updates and streams

When only some rows change, say which: `dataChanges` maps a dataset name to the indices whose rows changed, with a
same-length replacement of that dataset in `data`.

```tsx
import { Chart } from '@aster/react'

declare const spec: Record<string, unknown>          // your Vega spec
declare const newRows: Array<Record<string, unknown>> // same length as before, row 1 replaced

export const Updated = () => (
  <Chart spec={spec} data={{ data0: newRows }} dataChanges={{ data0: [1] }} />
)
```

For a push-based feed, `createChartStream` adds a bounded queue with `coalesce` / `drop-oldest` / `drop-newest` / `error`
backpressure and an explicit `flush()`:

```ts
import { createChartStream, type VgSpec } from '@aster/core'

declare const spec: VgSpec                              // your Vega spec
declare const newRows: Array<Record<string, unknown>>

const stream = createChartStream(spec, { capacity: 32, policy: 'coalesce' })
stream.push({ append: { data0: newRows } })   // or { data: snapshot }, signals, width/height
const flushed = stream.flush()                 // null when nothing was pending
if (flushed) console.log(flushed.scene.width, flushed.noop)
```

In React use `<ChartStream spec={spec}>` or `<ChartWorkerStream>`: the streamed scene goes through the same DOM patcher,
canvas renderer, interaction and accessibility tree as `<Chart>`. Measurements are in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md#reference-measurements).

## Documentation

- [API](docs/API.md): core, React and Vega-Lite entry points
- [Architecture](docs/ARCHITECTURE.md): pipeline, incremental evaluation, renderers, deviations from Vega
- [Interaction](docs/INTERACTION.md): selection, pan/zoom, signals, accessibility
- [Limits](docs/LIMITS.md) / [Errors](docs/ERRORS.md): untrusted specs and typed failures
- [Testing](docs/TESTING.md): gates, oracles, sweeps, fuzzing, reference results
- [Performance](docs/PERFORMANCE.md) / [Fonts](docs/FONTS.md)
- [Release](docs/RELEASE.md) / [ADRs](docs/adr/README.md) / [Roadmap](docs/ROADMAP.md) / [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## What is not covered

- **Vega-Lite**: `@aster/vl` throws a `VLCompileError` naming the feature for what it does not compile (a selection on a layer spec itself, maps, the `time` channel, a few data-driven channels, pre-binned data). The list is in
  [packages/vl/README.md](packages/vl/README.md).
- **Signals**: a signal written into a running chart renders the fresh result for the new signals; real Vega keeps some
  state from its first run (the `retained` cases, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deviations-from-vega)).
- **Word clouds**: `wordcloud` is a deterministic stand-in that mirrors d3-cloud's structure; it does not rasterize glyphs.
- **Streaming transport**: `createChartStream` and the hooks give a bounded queue, policies and explicit pulses; the host owns the
  network and decides when to flush.
- **Transforms without an incremental fast path** (for example the global fitters `kde`, `regression`, `loess`) re-derive
  on every append; the result is still exactly a fresh evaluation ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#incremental-evaluation)).
- **Export**: PNG and PDF export are out of scope; a host can rasterize the SVG or canvas.
