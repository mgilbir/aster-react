# Aster Charts Architecture

## Pipeline Overview

The rendering pipeline transforms a Vega (or Vega-Lite) spec into an SVG string through three stages:

```
VgSpec (JSON)
  ──compileChart──►  CompiledChart IR   ──evaluateChart──►  SceneRoot   ──renderSceneToSvg──►  SVG string
                    (packages/core/src/                   (packages/core/src/
                     compiler.ts)                           runtime.ts)
```

1. **compileChart** (`packages/core/src/compiler.ts`) consumes a Vega spec (`VgSpec`, an open record) and produces a `CompiledChart` IR containing typed arrays of data definitions, scale definitions, data transforms, mark definitions, axes, and legends.
2. **evaluateChart** (`packages/core/src/runtime.ts`) resolves the IR against `RuntimeInput` (data rows, width/height, signals). It resolves data, applies `CompiledTransform` operators eagerly, builds scale functions, and constructs a `SceneRoot` with `SceneGroup` / `SceneItem` nodes.
3. **renderSceneToSvg** (`packages/core/src/render.ts`) walks the `SceneRoot` tree recursively, dispatching on `marktype` (line, area, symbol, rect, rule, text, path, arc) to emit SVG elements.

The scene shapes (`SceneRoot`, `SceneGroup`, `SceneItem`, `SceneNode`) are defined in `packages/core/src/types.ts` and intentionally mirror `vega-scenegraph`'s JSON structure so the conformance oracle (real Vega, rendered headless) can be compared structurally.

Public API:

```ts
import { renderSpec, compileChart, evaluateChart, renderSceneToSvg,
         compileExpr, buildScale, applyTransforms } from '@aster/core'
```

## Expression Engine

Expression evaluation uses two pure Vega packages:

- **vega-expression** (`parseExpression`) — parses the Vega expression DSL into an AST.
- **vega-interpreter** (`expressionInterpreter`) — evaluates that AST via a CSP-safe interpreter (no `new Function`).

A custom function context is bound to the runtime's scale and data lookups, plus the type/array/string/math utilities (`vega-util`), date-time units (`vega-time`), color parsing (`d3-color`), and formatting (`vega-format`). The context lives in `packages/core/src/expression.ts` and mirrors the documented `vega-functions` surface, including:

| Group | Functions |
|-------|-----------|
| Scale / projection / data | `scale`, `invert`, `domain`, `range`, `bandwidth`, `bandspace`, `copy`, `data`, `indata`, `pluck` |
| Date-time | `year/quarter/month/week/day/date/hours/…` (+ all `utc*` variants), `datetime`, `utc`, `time`, `timeOffset`/`utcOffset`, `timeSequence`/`utcSequence`, `dayofyear`, `timezoneoffset`, `now` |
| Array | `extent`, `clamp`, `lerp`, `sequence`, `slice`, `reverse`, `sort`, `join`, `peek`, `span`, `inrange`, `clampRange`, `indexof`, `lastindexof` |
| String | `truncate`, `pad`, `upper`, `lower`, `split`, `trim`, `replace`, `substring`, `test`/`regexp`, `parseFloat`/`parseInt` |
| Color | `rgb`, `hsl`, `lab`, `hcl`, `luminance`, `contrast` |
| Formatting | `format`, `timeFormat`/`utcFormat`, `timeParse`/`utcParse`, `timeUnitSpecifier`, `month*`/`day*` |

Signal values are exposed as `$`-prefixed parameters to `compileExpr`, matching Vega convention (`$width`, `$height`, etc.). Signal `update` expressions are resolved to a fixed point in the runtime (see `resolveSignalUpdates`), so a scale range/domain or an encoding can reference a derived signal such as `{"signal": "cx"}` where `cx` is `update: "width / 2"`. Event-driven `signal.on` handlers are intentionally ignored (static mode).

The reason only pure packages are reused — and **not** `vega-functions`, `vega-dataflow`, or `vega-scenegraph` — is to avoid runtime leakage. `vega-dataflow` carries reactive graphs, operators, and signals that are explicitly not part of the eager model. `vega-scenegraph` carries a mutable node tree that the SVG serializer replaces with a pure function. The result is a smaller, simpler runtime with no hidden dataflow layer.

## Config & style resolution

`compileChart` reads `spec.config` and applies it as encode/property defaults (encode always wins): `config.background` → root background, `config.view` / `config.style.cell` → frame stroke (a `transparent` stroke serializes as *no* stroke), `config.style.<marktype|name>` → mark encode defaults (e.g. a `rect` style's `fill`/`cornerRadius`), and `config.axis` / `config.legend` → guide defaults. The chart `title` (string or object, with `subtitle`) merges from `config.title` and the vega-theme style defaults (fontSize 13, bold, offset 4, subtitlePadding 3).

## Geo projections & the addon boundary

`packages/core/src/geo.ts` builds d3-geo projections (`mercator`, `albers`, `albersUsa`, `equirectangular`, `orthographic`, …) from the compiled `projections` spec, resolving `scale`/`translate`/`center`/`rotate` signal params against the runtime; the `geoshape` transform and shape marks route geometry through `geoPath(projection)` (identity pixel-space path when no projection is named).

Because `d3-geo` + `d3-contour` are ~17 kB gzip and only a small fraction of specs use them, they are **not** reachable from the `@aster/core` barrel. The core code paths consult a small injection registry (`packages/core/src/registry.ts`, `geoRegistry`); the `@aster/core/geo` addon entry imports the d3 modules and registers `buildProjection` / `projectedPath` / `contourRun`. A chart that uses a projection or the `contour` transform without the addon loaded gets an actionable "load `@aster/core/geo` first" error; every other chart renders with a lean base bundle. This keeps `renderSpec` of a bar/line chart byte-for-byte the size it was before geo/contour existed.

## Scales

Scale construction is delegated entirely to `vega-scale` (a pure package built on d3-scale utilities). The wrapper in `packages/core/src/scales.ts` resolves domains and ranges from the `CompiledScale` IR, handles Vega-specific options (`reverse`, `round`, `clamp`, `padding`, `paddingInner`, `paddingOuter`, `zero`, `nice`), and returns d3/daily-compatible `vs.Scale` objects. Tick generation uses `vega-scale`'s tick factory, which guarantees tick positions match the real Vega renderer exactly.

## Transforms

Eager data transforms live in `packages/core/src/transform.ts`. Each transform is a pure function `(rows, params, ctx) -> rows` that processes an array of `Row` objects in place. The following transform types are implemented:

```
formula    — evaluate an expression per row
filter     — keep rows matching an expression
collect    — sort and deduplicate
bin        — create bin boundaries (limited support)
fold       — unpivot fields into key/value columns
flatten    — unnest array fields
impute     — fill missing values (limited support)
stack      — running accumulation with offset
aggregate  — group + reduce
window     — running computation (limited support)
joinaggregate — window without sliding (limited support)
```

Transforms are applied sequentially within `evaluateChart` via `applyTransforms(rows, transforms, ctx)`. The `TransformContext` provides an `ExpressionRuntime` (for formula/filter), signal values, and a cross-dataset lookup function (for `lookup`, deferred).

## Rendering

The SVG serializer in `packages/core/src/render.ts` walks the `SceneRoot` tree and emits SVG. Key design concerns:

- **Frame (plot bounds)** — rendered as a `<path>` with 0.5-pixel alignment (`M0.5,0.5h...v...h...Z`) when a `frameStroke` style is present, matching Vega's anti-aliased cell boundary.
- **Half-pixel offset** — plot items are placed inside a `<g>` with `transform="translate(pad.left, pad.top)"`, matching Vega's plot frame translation.
- **Mark dispatch** — `renderGroup()` routes on `marktype` to specialized renderers:
  - **line** — builds a `d="M...L...L..."` path from contiguous defined points.
  - **area** — builds an area path with the upper hull (`y`) and lower hull (`y2`).
  - **symbol** — circle paths sized by `(sqrt(size) / 2)` radius, transformed to x/y.
  - **rect** — `<path>` using `h`/`v` commands to match Vega's rect-as-path convention.
  - **rule** — `<line>` elements.
  - **text** — `<text>` elements with x/y/align/baseline/fill/angle.
  - **path** — raw `d` attribute passthrough.
  - **arc** — arc segment path using `A` commands.
- **Number rounding** — all coordinates are rounded to 3 decimal places (`Math.round(x * 1000) / 1000`) for stable canonicalization in conformance diffs.

## Conformance

The conformance harness (`packages/conformance/src/run.ts`) is the correctness gate:

1. **Load corpus** — `corpus/*.vl.json` (Vega-Lite specs) and `corpus/*.vg.json` (raw Vega specs).
2. **Compile Vega-Lite** — for `.vl.json` entries, run `vega-lite.compile()` to produce Vega spec form.
3. **Dual render** — run both real Vega (headless, dev-only dependency) and `@aster/core`'s `renderSpec`.
4. **Canonicalize** — strip irrelevant attributes (`class`, `aria-*`, timestamps) and normalize element ordering.
5. **Diff** — compare geometry records (element type, position, size, color attributes).

M0 corpus conventions:

- Specs MUST set explicit numeric `width` and `height`.
- `autosize` must be `'none'` so layout is deterministic and comparable.

The canonicalizer (`packages/conformance/src/normalize.ts`) is the correctness gate: a spec passes only if the two SVGs have identical canonical geometry. Text labels, axis titles, and the chart title are all verified — headless text metrics are matched by reimplementing Vega's estimate width (`~~(0.8 · len · fontSize)`) and its `labelOverlap` parity/greedy removal.

### Gap probes (`packages/conformance/probes/`)

Areas that are **known-incomplete** are captured as feature probes under `probes/` and run via `pnpm probe`. A probe renders the same oracle diff as the corpus but is a *diagnostic, not a CI gate*: its failure documents a real gap, and when the gap is implemented the probe is promoted into `corpus/`. The current backlog: `contour` (density-blur float parity), `vl-facet-2d` (2-D facet grid axis orientation in the bottom-row cells), `vl-title-legend` (chart title anchored against a combined rotated-axis-title + legend layout).

## Known Limitations / Roadmap

| Area | Status | Notes |
|------|--------|-------|
| Marks | Done | rect/line/area/symbol/rule/text/arc/path/image/trail/shape, incl. curves, gradients, corner radii, `lineBreak` tspans |
| Scales | Done | incl. scheme ranges (no zero-extension), `values`/`step`, projections via d3-geo |
| Axes | Done | ticks, grid, domain, labels, titles (4 orients), `labelOverlap` |
| Legends | Done | gradient (vertical + horizontal), symbol (single + multi-column grids at any corner), size, band, bottom flow |
| Title | Done | top-level title + subtitle, anchored to content bounds (incl. rotated axis-title bounds) |
| Config | Done | background/view/style/axis/legend/title defaults |
| Expressions | Done | full vega-functions surface (date, color, array, string, scale) — CSP-safe |
| Nested scopes | Done | group marks with their own `scales`/`axes`/`data` render in an isolated child scope |
| Signals | Partial | `update` expressions resolved to a fixed point; **event-driven `signal.on` ignored** |
| Reactive dataflow | Open | updates re-encode the whole scene; no per-dataset incremental re-evaluation |
| Interactions | Open | no general signal→view event loop |
| Canvas rendering | Open | SVG only |
| Contour | Open | transform implemented; geometry diverges from oracle in the density blur (probe) |
| 2-D facet (VL) | Open | row×column facet grid renders but bottom-row cell axis orientation diverges (probe) |
| Binning parity | Partial | `bin` covers common cases; not every Vega option |

## Verification Commands

```bash
# Typecheck (all packages pass)
pnpm typecheck

# Build
pnpm build

# Conformance — 393-spec geometry diff against the real Vega oracle (the gate)
pnpm conformance

# Gap probes — diagnostic only, documents known-incomplete features
pnpm probe

# Bundle budget (esbuild, 60 kB gzip target)
pnpm --filter @aster/benchmarks run budget
```
