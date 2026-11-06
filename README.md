# Aster Charts

Aster Charts (Aster for short) renders [Vega](https://vega.github.io/vega/) and [Vega-Lite](https://vega.github.io/vega-lite/) specs to SVG or canvas
from TypeScript, with React bindings: a `<Chart>` component, hooks, streaming, workers and server rendering. It is a
reimplementation of the Vega and Vega-Lite rendering stack that aims to produce what the real Vega renderer produces. The real
`vega` and `vega-lite` packages are the test oracle only; nothing in the published packages imports them or any `d3-*` /
`topojson-*` package.

**Pre-alpha. Version 0.1.0, not yet published to npm.** The install commands below work once the first release is tagged; until
then, build from this repository ([Build from source](#build-from-source)). How closely the output matches Vega is measured by
the gates, and the results are in [Conformance results](#conformance-results).

## Install

Not yet published (see above); these are the commands for the packages once they are. Consumers need Node 20 or newer (`engines`
in each package).

```bash
npm i @aster/react react react-dom   # React charts: <Chart>, useChart; react ^19 is a peer dependency
npm i @aster/core                    # no React: renderSpec and the engine (no dependencies)
npm i @aster/vl                      # only to compile Vega-Lite yourself (no dependencies)
```

`@aster/react` depends on `@aster/core` and `@aster/vl` itself, so a React app needs only the first line. Install `@aster/core`
as well when the app imports it directly (for example `@aster/core/dom` or `renderSpec`). Vega-Lite in a React app is opt-in with
`import '@aster/react/vl'`. `react-dom` is not a declared peer of `@aster/react`; a browser app mounts with it, and server
rendering uses `react-dom/server`.

## Render a first chart

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

A Vega spec rendered to an SVG string, with no React.
`data` is a list of named datasets. As in `vega-parser`, a lone object stands for a one-element list (the lists
are read through vega-util `array()`), and a mark that reads a dataset the spec does not declare fails with
`SpecParseError: Undefined data set name: "<name>"`. This example is rendered by real Vega and by Aster in the
tests and the outputs agree. [scripts/readme-examples.test.mjs](scripts/readme-examples.test.mjs) type-checks every code block of
this README against the built packages and runs the first two.

### A Vega-Lite spec

`@aster/vl` compiles Vega-Lite to Vega; `renderSpec` draws the result.

```ts
import { renderSpec, type VgSpec } from '@aster/core'
import { compile } from '@aster/vl'

const vegaSpec = compile({
  data: { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }, { a: 'C', b: 43 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
}) as VgSpec

const svg = renderSpec(vegaSpec)
```

### In React

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

## Where to go next

| I want to | Read |
|---|---|
| see every export and prop of a package | [docs/API.md](docs/API.md) (start with its "Start here" table), and the package READMEs: [`@aster/core`](packages/core/README.md), [`@aster/react`](packages/react/README.md), [`@aster/vl`](packages/vl/README.md) |
| try it next to real Vega in a browser | [apps/demo/README.md](apps/demo/README.md) (the gallery and playground: run, build, deploy) |
| render specs I did not write | [docs/LIMITS.md](docs/LIMITS.md) (budgets, the URL policy, what a worker guarantees) |
| understand an error message | [docs/ERRORS.md](docs/ERRORS.md) (every error class and what survives each failure) |
| use Vega-Lite and know what it refuses | [packages/vl/README.md](packages/vl/README.md) (what compiles, and the "Throws" list) |
| add pan, zoom, selection, tooltips or `signal.on` handlers | [docs/INTERACTION.md](docs/INTERACTION.md) |
| match Vega's text widths or fix a chart whose labels differ | [docs/FONTS.md](docs/FONTS.md) |
| keep the bundle small or the chart fast | [docs/PERFORMANCE.md](docs/PERFORMANCE.md) (guidance, bundle sizes, measurements); the harness is [packages/benchmarks/README.md](packages/benchmarks/README.md) |
| know where Aster differs from Vega on purpose | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deviations-from-vega) |
| understand how the engine works | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [ADRs](docs/adr/README.md) |
| build, test or change the code | [CONTRIBUTING.md](CONTRIBUTING.md), [docs/TESTING.md](docs/TESTING.md) |
| debug a red gate or one failing spec | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| see what the official Vega and Vega-Lite galleries show | [packages/conformance/gallery/README.md](packages/conformance/gallery/README.md) and its [triage](packages/conformance/gallery/TRIAGE.md) |
| cut a release | [docs/RELEASE.md](docs/RELEASE.md) |
| see what is open or changed | [docs/ROADMAP.md](docs/ROADMAP.md), [CHANGELOG.md](CHANGELOG.md) |
| check a licence | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

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
   `@aster/core/dom` add-on patches a live `<svg>` instead, and `@aster/core/canvas` paints the same scene to a canvas.

Everything below the spec language is owned: the expression parser and CSP-safe interpreter (no `new Function`), scales, ticks
and colour schemes, number and time formatting, time zones, curves and symbols, geo projections, contours, DSV and TopoJSON
readers, and the transforms. They are ports of the upstream algorithms, each checked against oracle vectors recorded from the
pinned upstream packages ([docs/TESTING.md](docs/TESTING.md#oracle-vectors)); their licences are reproduced in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Repo Layout

| Path | Description |
|---------|-------------|
| `packages/core` (`@aster/core`) | Compiler (spec to IR), runtime (IR to scene), SVG renderer, expression engine, limits. Entry points: `.`, `/addons` (which add-ons a spec needs, loaded on demand), `/dom` (incremental DOM, sessions), `/canvas`, `/hit` (hit testing), `/signals` (event loop), `/load` (URL datasets), `/geo`, `/transforms`. [README](packages/core/README.md). |
| `packages/react` (`@aster/react`) | `<Chart>` (SVG/canvas, incremental DOM patching, selection, pan/zoom, tooltips, accessibility tree), `useChart`, streaming and worker components and hooks, SSR helpers. Entry points: `.`, `/lite` (SVG-only `<SvgChart>`), `/interaction`, `/ssr`, `/worker`, `/worker-entry`, `/vl` (registers the Vega-Lite compiler). [README](packages/react/README.md). |
| `packages/vl` (`@aster/vl`) | The Vega-Lite to Vega compiler. Throws `VLCompileError` for what it does not support. [README](packages/vl/README.md). |
| `packages/conformance` (`@aster/conformance`, private) | The oracle harness: corpus, sweeps, vectors, browser gates, fuzzing, and the [official gallery runs](packages/conformance/gallery/README.md). |
| `packages/benchmarks` (`@aster/benchmarks`, private) | Runtime, memory, bundle and browser performance harness (`<Chart>` vs react-vega and vega-embed) and the bundle-size budgets: [packages/benchmarks/README.md](packages/benchmarks/README.md). |
| `apps/demo` (private) | A gallery and playground that renders Aster next to Vega: [apps/demo/README.md](apps/demo/README.md) (run, build, deploy). |
| `scripts/` | The gate list (`gates.mjs`), dependency boundary, publish verification, release guards and their tests. |
| `.github/workflows/` | `ci.yml` (runs `pnpm check`), `nightly.yml` (sweeps, fuzzing, extra browsers), `release.yml` (tag-triggered, see [docs/RELEASE.md](docs/RELEASE.md)). |

## Known gaps and differences from Vega

Each list lives in one place; this page only points at them.

- **Vega-Lite features `@aster/vl` refuses:** [packages/vl/README.md](packages/vl/README.md#throws-not-supported), held to the compiler by a test. Each is a `VLCompileError` naming the feature and its path.
- **Where Aster deliberately differs from Vega** (including the `retained` cases, where a signal written into a running chart renders the fresh result): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deviations-from-vega); the differences made for safety are in [docs/LIMITS.md](docs/LIMITS.md#deviations-from-vega-made-for-safety).
- **Untrusted specs:** `limits` are best-effort budgets and a killable worker is the hard guarantee (a regular expression, for one, cannot be interrupted in-process); a few built-in ceilings hold even without `limits`. Read [docs/LIMITS.md](docs/LIMITS.md) before rendering specs from untrusted sources.
- **Open work, word clouds, streaming transport and export:** [docs/ROADMAP.md](docs/ROADMAP.md#2-open-work). PNG and PDF export are out of scope; a host can rasterize the SVG or canvas.
- **Transforms without an incremental fast path** (the global fitters such as `kde`, `regression`, `loess`) re-derive on every append; the result is still exactly a fresh evaluation ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

## Conformance results

The behaviour is checked against the real packages by the gates in
[`scripts/gates.mjs`](scripts/gates.mjs) (`pnpm check`). The current results, each next to the command that
produced it, are in [docs/TESTING.md](docs/TESTING.md#reference-results) and
[docs/PERFORMANCE.md](docs/PERFORMANCE.md#reference-measurements); in short, as measured on this tree:

- the SVG corpus (1055 specs: 383 Vega, 672 Vega-Lite) renders identically to real Vega under a strict
  canonicalizer: `pnpm conformance` (1055/1055);
- the same 672 Vega-Lite specs compiled by `@aster/vl` render identically to vega-lite's output: `pnpm conformance-vl` (672/672);
- the schema sweeps (one chart per property/value of the schema) have no differences: Vega 7538 ok of 7549 (8 both-refused, 3 the oracle itself crashes on), Vega-Lite 27452 ok of 27513 (44 both-refused, 17 oracle crashes),
  signals 103 ok of 166 (60 `retained`, see [Known gaps](#known-gaps-and-differences-from-vega); 0 differ);
- in real Chromium, the corpus matches Vega's string renderer (1055/1055), the canvas renderer matches Vega's canvas (1067/1067 pixel comparisons),
  and signal event streams match Vega (64/64 cases).

## Build from source

For working on this repository (contributors need Node 22.13 or newer, which pnpm 11 requires; pnpm is pinned by
`packageManager`). [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

```bash
pnpm install
pnpm build
pnpm check          # every gate; `pnpm check -- --list` shows them, `-- --skip browser` skips the Chromium ones
```
