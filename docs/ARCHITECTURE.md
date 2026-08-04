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

A custom function context is bound to the runtime's scale and data lookups, plus format functions (`vega-format`, `vega-time`, `vega-util`). The context lives in `packages/core/src/expression.ts`:

| Function | Purpose |
|----------|---------|
| `scale(name, value?)` | Look up a scale by name; call it if value provided |
| `bandwidth(name)` | Get the band width of an ordinal/band scale |
| `data(name)` | Resolve rows of a dataset by name |
| `format / timeFormat / utcFormat / monthFormat / dayFormat` | Numeric and time formatting |

Type-assertion utilities (`isValid`, `isInvalid`, `isArray`, etc.) come from `vega-util`. Signal values are exposed as `$`-prefixed parameters to `compileExpr`, matching Vega convention (`$width`, `$height`, etc.).

The reason only pure packages are reused — and **not** `vega-functions`, `vega-dataflow`, or `vega-scenegraph` — is to avoid runtime leakage. `vega-dataflow` carries reactive graphs, operators, and signals that are explicitly not part of M0. `vega-scenegraph` carries a mutable node tree that the SVG serializer replaces with a pure function. The result is a smaller, simpler runtime with no hidden dataflow layer.

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
- Specs avoid tick labels / titles (text marks) where possible — text positioning is a known gap.

The canonicalizer (`packages/conformance/src/normalize.ts`) is the correctness gate: a spec passes only if the two SVGs have identical canonical geometry.

## Known Limitations / Roadmap

| Area | Status | Notes |
|------|--------|-------|
| Tick label positioning | Partial | Line positions often wrong; text placement diverges |
| Legend rendering | Not started | `CompiledLegend` IR exists but no renderer |
| Title positioning | Not started | `CompiledAxis.title` parsed but not positioned in SVG |
| Reactive dataflow | Not started | `renderSpec` is static/eager; future: incremental update |
| Interactions | Not started | No signal/event system |
| Binning parity | Partial | `bin` transform exists but not full Vega parity |
| Vega-Lite coverage | Partial | Depends on `vega-lite.compile` producing valid Vega |
| More marks | Partial | Arc, area, line, rect, rule, symbol, text, path implemented; some geometry differs |

## Verification Commands

```bash
# Typecheck (core, react pass; conformance has known node-type errors)
pnpm typecheck

# Build
pnpm build

# Conformance — geometry diff against real Vega oracle
pnpm conformance

# Bundle budget (esbuild, 60 kB gzip target)
pnpm --filter @aster/benchmarks run budget
```
