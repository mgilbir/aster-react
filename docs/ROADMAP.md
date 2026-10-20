# Roadmap: a from-scratch TypeScript/React Vega engine

Aster React is the browser/React member of the Aster family. Its intended
implementation is the same as [`aster`](https://github.com/mgilbir/aster) (Go) and
[`aster-kotlin`](https://github.com/mgilbir/aster-kotlin) (Kotlin): **reimplement the
Vega and Vega-Lite languages and their rendering from scratch**, so that the result
draws exactly what upstream draws, while being idiomatic and fast inside a React app
in the browser.

The real `vega` and `vega-lite` packages are the **oracle** — a dev-only reference the
tests compare against. They must not ship in the runtime, and neither may any of their
dependencies (`d3-*`, `topojson-client`, …).

This document records the verified starting point, the full inventory of borrowed code
that has to be replaced, the strategy for replacing it safely, and the plan.

**Scope of the rendering and experience goals.** The deliverables are **SVG and Canvas**
output and **interaction that is idiomatic in React**. Raster (PNG) and PDF export are
**out of scope** — the siblings provide them because they are server/native libraries,
but a browser React component composes into a page instead. This removes the largest
non-essential workstream (a rasteriser and a PDF writer) and lets the plan spend its
effort on the two things that matter: a dependency-free engine and a React-native
interaction model.

---

## 0. What the goal changes

The current codebase does the opposite of the goal in three ways:

1. **`@aster/core` runs on Vega's own pure packages** — `vega-expression`,
   `vega-interpreter`, `vega-format`, `vega-scale`, `vega-time`, `vega-util` — and on
   `d3-color`, `d3-contour`, `d3-dsv`, `d3-geo`, `d3-shape`, `topojson-client`
   (plus `d3-array`/`d3-format`/`d3-scale`/`d3-time`/`d3-time-format` declared but
   not imported directly).
2. **`ARCHITECTURE.md` documents this reuse as a deliberate design decision**
   ("The reason only pure packages are reused … is to avoid runtime leakage"). That
   decision is now reversed and must be superseded by an ADR.
3. **There is no Vega-Lite implementation at all.** `@aster/core` accepts only a Vega
   spec; the demo and the conformance harness call upstream `vega-lite.compile`
   *before* rendering. So the corpus's 413/413 result measures the *Vega* renderer on
   upstream-compiled Vega — it does not measure a Vega-Lite compiler, because there
   isn't one.

So "close the gap" now means two large programs: **own the runtime** (replace every
borrowed library) and **own the compiler** (write Vega-Lite from scratch). The
conformance harness keeps upstream as the oracle throughout.

### Consequences to plan for

- **The base bundle will grow.** Today's ~84 kB gzip leans on `vega-scale`,
  `vega-format` and friends being tree-shaken from a shared install. Owning scales,
  expressions, geo and shape costs bytes. Keep the addon boundary strict, gate each
  entry point, and re-baseline the core budget as the stack is replaced — the win
  over react-vega (288 kB) should survive, but the absolute number will rise.
- **`ARCHITECTURE.md` and the README describe the old design** and will be wrong the
  moment R1 starts. R0.1 supersedes them rather than leaving contradictory docs.
- **The conformance result is narrower than it looks.** 413/413 is the Vega renderer on
  *upstream-compiled* Vega; it says nothing yet about a Vega-Lite compiler.

---

## 1. Verified current state (re-verified 2026-10-15, second pass)

All gates re-run from the working tree after the parity iteration.

| Gate | Result |
|---|---|
| `pnpm build` / `pnpm typecheck` | pass (all 5 packages) |
| `pnpm test` | 257 tests / 27 files, all pass |
| `pnpm conformance` | **419 / 419** SVG geometry vs real Vega |
| `pnpm conformance-vl` | **126 / 126** (incl. repeat, scatter-matrix, vl-facet-2d) |
| `pnpm sweep-vl` (27,513 VL schema cases) | **99.7%** — 27,418 ok, 0 differ, 0 engine-error, 21 node-error, 34 nondeterministic, 40 both-refused |
| `pnpm conformance:browser` (Chromium, live canvas text metrics) | **419 / 419** |
| `pnpm probe` | 2 / 2 |
| bundle budget (`@aster/core` `renderSpec`) | 93.3 kB gzip / 96 kB — pass |
| `pnpm bench:browser` | aster 16.7 ms median frames / 2.2% long frames vs react-vega 26.8 ms / 98.1%; heap-churn retained ~0 MB |

Engine fixes from the parity iteration (closing the corpus and browser gates):

- **Facet/repeat compositions**: the ported `trellisLayout` now runs for 1d
  facets too (not just 2d trellises); the top-level facet form sizes children
  from the view defaults (step/bandspace signals, continuous 300) like
  vega-lite, not the facet's width/height; facet fields are appended to the
  inner pipeline's stack/aggregate/window groupbys so stacking restarts per
  cell; `repeat` compiles (plain and grid forms) with per-field filtered
  datasets, prefixed scales and `child__…` groups.
- **Legend layout**: gradient-legend labels are measured post-format (vega's
  U+2212 minus is wider than ASCII '-'), the legend box is `ceil`ed, guide
  titles default to bold (vega's `guide-title` style) for both measurement and
  rendering, band/symbol legends use measured per-label/per-column widths with
  vega's grid accumulation instead of char-count heuristics.
- **Marks**: rules span to scale zero via vega-lite's `zeroOrMin`/orientation
  law (with the `inrange` probe signal for non-zero domains), `size` maps to
  `strokeWidth`, `filled`/`fillOpacity`/`strokeDash`/offsets pass through;
  rule/rect/image nominal x use band scales (padding 0); ranged bars (x2/y2
  fields) extend the scale domain to the endpoint union and join axis titles
  with ', '; the variance aggregate family yields undefined (→ zero-size rect)
  for fewer than two valid values.
- **Rendering precision**: vega emits raw doubles for rect/frame paths and
  d3-path `digits=3` for symbol/arc/line/area paths — matched; angled text
  renders via `translate+rotate` (with the baseline offset as `dy`) in the
  string renderer, DOM patcher and canvas alike; the relative-command path
  canonicalizer is exact.

Second-pass engine fixes (closing the arc/theta/radius and legend families):

- **Arcs**: theta stacking follows vega-lite's polar stack law — aggregated
  thetas aggregate first (grouped by the raw series fields) then stack;
  a `radius` channel adds a radius scale driving `outerRadius`/`innerRadius`
  (stacking into `radius_start/end` when `radius.stack` is set, reversing on
  `sort: 'descending'`); channel `bandPosition` aligns the start angle within
  the stacked band; timeUnit thetas reference the offsetted-rect fields.
- **Legends**: gradient legends honor the legend's `format` (labels and width
  measurement) and round the background box per `cornerRadius`.
- **Aggregates**: the variance family (variance/stdev/stderr and population
  variants) yields undefined below two valid values (→ zero-size rects).

Third-pass engine fixes (the schema-sweep long tail, now at 99.5%):

- **Stack law**: ported vega-lite's `potentialStackedChannel` rules — explicit
  `stack:false/null`, ranged marks, and an aggregate anywhere in the encoding
  with no unaggregated stack-by series disable stacking; stack transforms and
  mark/scale references now agree. This also restored the area/line corpus
  after the zero-default rule was corrected to vega-lite's dimension-axis law.
- **Mark properties**: definition/config paint and geometry props pass through
  (`strokeWidth`, `strokeDash`, `fillOpacity`, `opacity`, `angle`,
  corner radii, `padAngle`, `strokeJoin`, …); `xOffset`/`yOffset` shift
  positional and secondary/centered channels; arc `thetaOffset`/`radiusOffset`
  shift polar channels; `filled:false` moves paint to stroke consistently;
  point/circle/square `size`, tick size/thickness/baseline/orientation, and
  bar `align`/zero-size semantics match the oracle.
- **Non-positional fields**: aggregate/timeUnit legends carry their format
  (`timeUnitSpecifier` for time), text marks format aggregate/timeUnit/`format`
  fields, date-valued linear size domains coerce correctly, and opacity
  legends tick/opacity geometry was added.
- **Facets/guides/config**: row-facet title bounds follow vega's title
  baseline; column-header labels honor label font/angle/baseline/offset;
  column-title padding/angle/baseline/anchors and timeUnit facet fields resolve; config `axis`/`axisX`/`axisY` blocks cascade into the compiled axes;
  axis grid width/dash and singular time intervals (`hour`/`minute`/…)
  resolve; config `width`/`height`/`size`/`filled`/alignment and
  bar/rect/tick geometry resolve through the mark compiler while inert
  style geometry is ignored.
- **Aggregate semantics**: string/date-bearing `min`/`max`/`distinct`/
  `valid`/`missing` use raw values, empty `sum`/`product`/`median`/quantiles
  match vega, numeric aggregate color scales (`count`/`distinct`/…), gradient
  labels on degenerate domains, and size-legend labels on the [0,1] domain
  are aligned. Legend title anchor/align/baseline/limit and label limits are
  applied across gradient and size legends.
- **Time units/ranges**: axis timeUnit formats carry `formatType:'time'`;
  legend specifiers use primitive units; color timeUnit symbol legends and
  gradient time labels resolve signal formats; rangeMin/rangeMax and quantile/
  quantize/threshold band legends (incl. title rows and domain ticks) match
  the oracle; config arc/tick/legend geometry properties and `config.view`
  frame stroke/fill/opacity/dash were wired through. Color interpolation now
  matches d3's achromatic-hue rule, multi-stop palette ranges, descending
  domains, threshold extents, and vega's gradient-legend tick/label sizing.
  TimeUnit uses vega-time's canonical 2012 fallback year and DAY/WEEK/
  DAYOFYEAR projections; facet headers/cells follow the compiled sort order,
  and fractional document sizes truncate like vega's SVG renderer. Rounded
  bars use Vega's clipped per-bar scope structure, including per-corner and
  leading-edge radii from mark/config options. Discrete scales retain
  undefined domain entries for aggregate-over-nominal fields, and ordering
  treats incomparable values (invalid dates, NaN) as equal.
- **Facets**: timeUnit facet fields get their cast + timeunit transforms in the
  child dataflow, and header titles/labels format timeUnit values.
- **Scales/legends**: discrete positional channels coerce unsupported scale
  types to band/point, continuous color honors supported types and
  `zero`/scheme ranges, band padding follows `padding`/`paddingInner` and
  config padding blocks, and gradient legends use the true scale domain for
  tick placement (with explicit `gradientLength`/`gradientThickness`/
  `labelOffset`/label-size honored).

Schema-sweep **differ residue is closed (0)**. The final clusters were
guide-scale ranges/domains (degenerate ranges rendering at the origin),
facet-header `labelOrient`/`orient` (labels as per-cell titles, footer labels,
and side titles), config `axis`/`header` precedence, axis orient/grid geometry,
label-angle anchors, `labelSeparation`/`tickMinStep`/`tickRound` tails,
`values`/bootstrap aggregate domains, and the size-legend grid tails
(`columns`, `gridAlign`, `rowPadding`, `labelFontSize`, negative
`symbolStrokeWidth`). The remaining non-ok cases are not comparison failures:
40 specs both engines refuse, 21 cases where the oracle crashes/refuses an
invalid shape/radius or degenerate scale spec, and 34 nondeterministic
`ci0`/`ci1` bootstrap aggregates (`Math.random` inside vega), pinned in the
sweep runner.

Size: **~17.7k main / ~2.7k test LOC**. For scale, the siblings' engines:

| Subsystem | Go | Kotlin |
|---|---:|---:|
| Vega-Lite compiler | 22,446 | 28,353 |
| Vega parser/runtime | 16,945 | 23,750 + 12,706 (model) |
| Scales | 6,271 | (in runtime) |
| Expressions | 6,589 | 6,305 |
| Transforms | 14,129 | (in runtime) |
| Geo | 6,569 | (in runtime) |
| Scene | 5,474 | 7,270 |
| Format/time/number | 4,927 | (in model) |
| SVG renderer | 1,430 | 803 |
| **Engine total** | **~85k+** | **~110k** |

Aster React already owns its top layer — spec compiler, eager runtime, scene, SVG
serializer, bounds, transforms, DOM patcher, signals. The from-scratch work is the
**library layer beneath it** and the **Vega-Lite compiler beside it**.

### Runtime dependency audit

**COMPLETE.** `@aster/core` has zero runtime dependencies on `vega-*`, `d3-*`, or
`topojson-*`. The ratchet (`scripts/check-deps.mjs`, per-package
`dep-baseline.json`) holds with an empty baseline and fails CI on any banned
import or dependency.

| Borrowed package | Replacement | Verified by |
|---|---|---|
| `vega-util` | `src/util.ts` | util vectors |
| `d3-color` | `src/color.ts` | colour projections |
| `vega-time` + `d3-time` | `src/time.ts` | interval/DST vectors (America/New_York) |
| `vega-format` + `d3-format` + `d3-time-format` | `src/format.ts`, `src/time-format.ts`, `src/locale.ts` | specifier + locale vectors |
| `vega-expression` + `vega-interpreter` | `src/expr-parser.ts`, `src/expr-interpreter.ts` | AST + eval vectors |
| `d3-dsv` + `topojson-client` | `src/dsv.ts`, `src/topojson.ts` | DSV + topology vectors |
| `d3-shape` | `src/shape.ts` | 256 curve/line/area vectors |
| `vega-scale` (d3-scale, d3-array, d3-interpolate, internmap) | `src/arr.ts`, `src/interp.ts`, `src/scale-d3.ts`, `src/scale.ts` | 173 scale/scheme/tick vectors |
| `d3-geo` | `src/geo-lib.ts`, `src/geo-projections.ts` | 18 projection/vector op-program cases |
| `d3-contour` | `src/contour.ts` | 30 marching-squares cases |

**5,043 oracle-vector cases** recorded from pinned upstream packages replay on
every `pnpm test` run. Time-dependent suites carry the zone they were recorded
under (America/New_York for the DST cases). SVG conformance against real Vega
holds at 413/413, and the bundle sits at 82.5 kB gzip against the 100 kB budget —
smaller than the borrowed tree it replaced.

---|---|---|---|
| `vega-util` | `data-format.ts`, `expression.ts` | **replaced** — `src/util.ts` (PR 1) | coercion, predicates, access paths, `extent`/`ascending`, `pluck` |
| `d3-color` | `expression.ts` | **replaced** — `src/color.ts` (PR 2) | CSS parse, RGB/HSL/Lab/HCL |
| `vega-time` + `d3-time` | `expression.ts` | **replaced** — `src/time.ts` (PR 3) | interval engine, units, floors, offsets, sequences |
| `vega-format` + `d3-format` + `d3-time-format` | `expression.ts`, `runtime.ts` | **replaced** — `src/format.ts`, `src/time-format.ts`, `src/locale.ts` (PR 4) | specifier grammar, strftime engine, locale facade |
| `vega-expression` + `vega-interpreter` | `expression.ts` | **replaced** — `src/expr-parser.ts`, `src/expr-interpreter.ts` (PR 5) | the DSL parser and CSP-safe evaluator |
| `d3-dsv` + `topojson-client` | `addon-load.ts` | **replaced** — `src/dsv.ts`, `src/topojson.ts` (PR 6) | DSV state machine, TopoJSON feature/mesh |
| `d3-shape` | `render.ts` | **replaced** — `src/shape.ts` (PR 7) | Path serializer, line/area, 19 curve families |
| `vega-scale` | `scales.ts`, `runtime.ts` | **remaining** | 16 scale types, tick generation, 68 schemes |
| `d3-geo` | `geo.ts` | **remaining** (addon) | projections, geoPath, measures |
| `d3-contour` | `addon-geo.ts` | **remaining** (addon) | marching squares |
| `d3-array`, `d3-scale`, `d3-time`, `d3-time-format`, `d3-format` | declared, unused directly | **remaining** (manifest cleanup with their phases) | d3-array's `tickStep` already lives in `src/format.ts` |
| `vega`, `vega-lite` | conformance/benchmarks/demo only | **keep** (the pinned oracle) | — |

Oracle-vector totals: **4,822 cases** across nine recorded libraries, replayed on
every `pnpm test` run; time-dependent suites carry the zone they were recorded
under (America/New_York for the DST cases) and both sides pin `process.env.TZ`
per suite.

---|---|---|---|
| `vega-expression` | `expression.ts` | expression lexer/parser → AST | own parser |
| `vega-interpreter` | `expression.ts` | CSP-safe AST evaluator | own interpreter |
| `vega-format` | `expression.ts`, `runtime.ts`, `data-format.ts` | locale, `format`/`timeFormat`/`tickFormat` | own d3-format/d3-time-format-compatible layer |
| `vega-time` | `expression.ts` | time units, floors, offsets, sequences | own time unit engine |
| `vega-scale` | `scales.ts`, `expression.ts` | 16 scale types, ticks, 68 schemes, `bandSpace` | own scale + tick + scheme engine |
| `vega-util` | `data-format.ts`, `expression.ts` | type coercion, array helpers | own util |
| `d3-color` | `expression.ts` | CSS colour parse, rgb/hsl/lab/hcl | own colour module |
| `d3-contour` | `addon-geo.ts` | marching squares | own contour |
| `d3-dsv` | `addon-load.ts` | csv/tsv/dsv parsing | own DSV reader |
| `d3-geo` | `geo.ts` | 16 projections, `geoPath`, geo measures | own geo module |
| `d3-shape` | `render.ts` | curves, line/area/arc, symbols, path | own shape module |
| `topojson-client` | `addon-load.ts` | TopoJSON feature/mesh decode | own TopoJSON reader |
| `vega`, `vega-lite` | conformance/benchmarks/demo only | the oracle / VL compile | **keep dev-only** |

---

## 2. Strategy: vector-first, swap-in-place

The siblings made this tractable the same way: they **recorded upstream's answers**
before rewriting each library and then replayed them. Go replays 21,523 calls from 25
packages; Kotlin keeps `test-fixtures/upstream-vectors`.

The method, applied per library:

1. **Record.** A `gen_*.mjs` uses the real dependency to emit input→output vectors
   (committed, gzipped). Covers the whole surface, including edge cases.
2. **Implement.** Build the replacement behind the *same internal API* the current
   callers use, so the pipeline does not move.
3. **Replay.** A test asserts exact equality against the vectors. This is independent
   of the browser and of the SVG oracle, and it localises a failure to one library.
4. **Swap and delete.** Flip the import, remove the dependency from `package.json`.
5. **Ban it.** A CI check fails if `packages/core/src` imports `vega-*`, `d3-*` or
   `topojson-*` (allow-list: tests, conformance, benchmarks, demo).

This keeps the oracle honest (real Vega still renders the corpus) while making each
library replacement a bounded, testable unit rather than a leap.

---

## 3. Inventory of own-code to build

| # | Subsystem | Borrows today | Target surface | Notes |
|---|---|---|---|---|
| R1 | util / array / stats | `vega-util`, `d3-array` | coercion, `extent`, bisect, quantile, group/rollup, variance, `ticks`, `nice`, `range`, `bandSpace`, `lerp` | small, unblocks everything |
| R1 | number/date format + locales | `vega-format` | `format`, `formatSpecifier`, `timeFormat`, `timeParse`, `locale`, `tickFormat`, all d3 locales | locale data is bulky; ship as an addon entry |
| R1 | time units | `vega-time` | floors, offsets, sequences, intervals, `timeUnitSpecifier`, `dayofyear`, `week`, **`isoweek`** | 6.4.0 additions included |
| R1 | colour | `d3-color` | CSS parse (names/hex/rgb/hsl), rgb/hsl/lab/hcl, interpolate | needed by schemes and expressions |
| R2 | expression language | `vega-expression`, `vega-interpreter` | lexer, parser, AST, CSP-safe interpreter, full function table (~119 functions) | AST node shapes should mirror `vega-expression` so vector diffs are meaningful |
| R3 | scales + ticks + schemes | `vega-scale`, `d3-scale` | 16 scale types, `nice`, padding, `domainRaw`, unioned domains, tick generation, 68 schemes | tick parity is the subtle part; vectors pin it |
| R4 | shape | `d3-shape`, `d3-path` | line/area/arc/symbol, all 17 curve methods, path serialization, bounds | renderer already dispatches; only the path builder changes |
| R5 | geo + contour | `d3-geo`, `d3-contour` | 16 projections, `geoPath`, `geoArea`/`geoCentroid`/`geoBounds`/`geoDistance`, graticule, antimeridian clipping; marching squares | addon-gated; largest per-line surface |
| R6 | data formats | `d3-dsv`, `topojson-client` | DSV reader, TopoJSON feature/mesh | addon-gated |
| R7 | **Vega-Lite compiler** | `vega-lite` (dev only; not shipped) | whole grammar → Vega | the single largest workstream; see Phase R7 |
| R8 | conformance rigour | — | scene + scale differential, VL compile diff, schema sweeps, upstream vectors | runs in parallel; makes every phase provable |

---

## 4. Plan

Relative sizes: `S` ≈ a day, `M` ≈ a few days, `L` ≈ a week+, `XL` ≈ a multi-week
workstream for one focused engineer.

### R0 — Foundation and guardrails (S)

- **R0.1** ADR `docs/adr/0001-own-the-engine.md`: reverses the "reuse pure packages"
  decision, states the oracle-only rule, and points at the vector method. Update
  `ARCHITECTURE.md`'s expression/scales/transforms sections to describe the target,
  not the current borrow.
- **R0.2** Dependency-boundary CI check (script or `dependency-cruiser`): fail if
  `packages/core/src` imports a banned package. Start with an allow-list of the
  current imports so it passes today; shrink it as each phase lands. This is what
  stops the gap from reopening.
- **R0.3** `packages/core/testdata/vectors/` + a `gen-vectors` script and a replay
  test per library. Land the harness with one trivial library (`vega-util`) to prove
  the loop.
- **Acceptance:** CI fails on a new banned import; at least one vector suite replays
  green.

### R1 — Foundation libraries (M, parallel after R0)

- **R1.1** util + array/stats vectors and implementation.
- **R1.2** colour vectors and implementation.
- **R1.3** time-unit vectors and implementation (incl. 6.4.0 `isoweek`).
- **R1.4** number/date format + locale vectors and implementation; locale data behind
  an addon entry so the base bundle stays lean.
- **Acceptance:** each library replays its upstream vectors exactly; no `vega-*`/`d3-*`
  import remains in the files it replaced.

### R2 — Expression language (L)

- **R2.1** Lexer + Pratt parser for the Vega expression DSL; record parse vectors from
  `vega-expression` (including error cases) and replay.
- **R2.2** CSP-safe AST interpreter over an explicit function table; record eval
  vectors from `vega-interpreter` and replay.
- **R2.3** Complete the function table to the full `vega-functions` surface, including
  the 6.4.0 additions (`ease*`, `interpolateLinear`, `geoTranslate`), regexp
  semantics (`g`/`y`/`u`, `lastIndex`), and `hypot`.
- **R2.4** Retire the hand-built table in `expression.ts`; the corpus plus vectors
  become the drift guard.
- **Acceptance:** DROP `vega-expression` and `vega-interpreter`; corpus stays 413/413;
  a generated test asserts the function table matches upstream's.

### R3 — Scales, ticks and schemes (XL)

- **R3.1** Record `vega-scale`/d3 vectors: domain/range/bandwidth per scale type, tick
  positions and formats across magnitudes and time zones, `nice`, padding, `bandSpace`.
- **R3.2** Implement scale constructors and tick generation; 68 colour schemes and
  interpolators (built on R1.2).
- **R3.3** `domainRaw`, unioned-domain signal refs, ordinal `range.count`, `reverse`,
  `clamp`, `values`/`step`.
- **Acceptance:** DROP `vega-scale` and `d3-scale`; tick vectors exact; corpus green.

### R4 — Shapes (L)

- **R4.1** Record curve/symbol/arc vectors from `d3-shape` (all 17 interpolation
  methods, 12 symbols, arc with pad/corner radius).
- **R4.2** Implement the path builder and serialization; wire `render.ts` and
  `bounds.ts` to it.
- **Acceptance:** DROP `d3-shape`; curve vectors exact; corpus green.

### R5 — Geo and contour (L, addon)

- **R5.1** Record projection/geoPath/measure vectors from `d3-geo`.
- **R5.2** Implement projections, `geoPath`, measures, graticule, antimeridian
  clipping; marching squares for `d3-contour`.
- **Acceptance:** DROP `d3-geo` and `d3-contour`; geo/contour corpus entries green.

### R6 — Data formats (M, addon)

- **R6.1** DSV reader with `d3-dsv`-identical quoting/typing vectors.
- **R6.2** TopoJSON feature/mesh decode with vectors.
- **Acceptance:** DROP `d3-dsv` and `topojson-client`; `data-url-csv` and geo corpus
  entries green.

### R7 — Vega-Lite compiler (XL — its own program)

**Status: complete.** `@aster/vl` (zero-dependency workspace package) compiles
Vega-Lite -> Vega, verified by rendering parity against the pinned
`vega-lite` oracle through `pnpm conformance-vl` (per-spec multiset diffs of
canonicalized SVG records). **125/125 corpus entries pass** with exact rendered output. Covered: unit specs for bar/point/circle/square/line/area/tick/text,
positional/color/size/opacity/shape channels across all four data types,
linear/band/point scale defaults, stack pipelines (single- and multi-series,
impute vs filter variants), aggregate/count, binning with the bins-signal
domain and offset-encoded bars, timeUnit pipelines with timeUnitSpecifier
formats and tickMinStep semantics, grid/label axis split with VL's tickCount
signals, legends, and mark-def properties. Also covered: stack center/normalize offsets, xOffset/yOffset grouped
bars, tick marks, aggregated domain sorts, log scales with greedy overlap,
explicit color ranges, conditional encodings, vega-transform passthrough
(calculate/filter/flatten/fold/window/quantile/kde/regression/loess), the
KDE shared-grid sampling semantics, line/area marks split by
color/detail/size channels via faceted pathgroups, arc/theta pie-donut
marks with polar text labels, layer composition with unioned scale
domains (incl. dual-axis independent y resolution), facet and concat
layouts, heatmaps, the boxplot composite, axis labelAngle, size-driven
line widths, static params, and per-field legend suppression, and log-axis label filtering (vega's
log axes carry no explicit tickCount — the axis default of 10 drives the
3/30/300 label filter). Interval selections render their static brush marks (clipped zero-size
shading; the engine skips unpainted rect items, as vega does). Unsized
units adopt vega-lite's default sizing (continuous dims 300; discrete dims
span band steps with `bandspace(domain length) * step` view-size signals).
Legends follow vega-lite's fixed channel order (color, size, shape,
opacity); the size-legend entry geometry mirrors vega's bound machinery
(datum size = max(ceil(sqrt(scale(v)) + strokeWidth), fontSize), miter
stroke inflation, per-entry bounds with rowPadding 2). Repeat specs
compile as vega-lite 6 itself does (degenerate single units).


The whole grammar, verified property-by-property against `vega-lite.compile` (the same
way Go and Kotlin do), then by rendering both compiled specs.

- **R7.1** Spec normalization, `$schema`/shape detection, top-level `width`/`height`/
  `padding`/`autosize`, `config` cascade and defaults.
- **R7.2** Single-view compilation: encoding channels (position, polar, offset, colour,
  size, shape, text, tooltip, href, detail, order), `aggregate`/`bin`/`timeUnit`/
  `stack`/`impute`/`sort`, scale/axis/legend/title defaults.
- **R7.3** Marks and composites: `bar`, `point`, `line`, `area`, `arc`, `rect`, `rule`,
  `tick`, `trail`, `text`, `boxplot`, `errorbar`, `errorband`.
- **R7.4** Transforms: every Vega-Lite transform → Vega transforms.
- **R7.5** Composition: `layer`, `facet` (incl. 2-D), `concat`/`hconcat`/`vconcat`,
  `repeat`.
- **R7.6** `params`/selections and conditional encodings.
- **R7.7** Property-by-property differential over a large VL fixture set (Go has 627
  Vega-Lite examples; Kotlin 332 fixtures), then a rendered-scene comparison.
- **Acceptance:** `@aster/core` exports a VL entry point; a `.vl.json` renders without
  importing `vega-lite`; the compiled-Vega diff is exact across the VL corpus.

### R8 — Conformance rigour (M–L, parallel from R0)

- **R8.1 — DONE.** `pnpm scene-diff` compares resolved scales (domain, range, bandwidth, interpolating-colour endpoints) and mark items directly against Vega's scenegraph for all 419 corpus specs.
- **R8.2 — DONE.** Nested/group scoped scale maps are compared by scope path (role/marktype + sibling order), including facet/concat cell scopes.
- **R8.3 — DONE.** Item comparison covers geometry, paint/dash/stroke extents, text/rect/symbol/area normalizations, item multisets, and paint-order checks for overlapping painted extents.
- **R8.4 — DONE.** Schema sweeps ported from the Go aster project:
  `pnpm sweep-vega` generates one chart per (property, value) pair vega's own
  schema declares (7,549 cases — matching the Go floor) and diffs each against
  upstream vega. **7,538 pass with zero comparable differences**; the remaining
  cases are 8 both-refused and 3 where the Vega oracle itself crashes. The
  Vega-Lite sweep is likewise **27,418 ok, 0 differ** (40 both-refused, 21 oracle
  refusals, 34 pinned nondeterministic bootstrap aggregates). Closed since the 80% checkpoint: all
  encode/config mark families, arcs (a full d3-arc port: padAngle,
  cornerRadius, radius swaps, degenerate radii), trails, scales, titles, the
  identity scale's range-less base, horizontal area baselines, and the
  scene-level scale/item work above. Projections: DONE —
  1104/1105 (was ~340). The whole cluster traced to vega lowercasing
  projection type names (multi-word types silently fell back to mercator)
  plus the missing Mollweide/geoIdentity ports, vega-projection's persistent
  per-projection geoPath (pointRadius), rotate gamma dropped in tuple
  coercion, and empty-path/null-position bounds semantics. One residual case
  (azimuthalequalarea-clipAngle-0) differs by a 1.7e-6 px fp epsilon in d3's
  clip-intersection arithmetic.

Legend orients: the legendParams + gridLayout port is in — vertical-entry
  symbol geometry for every orient, the grid anchor (floor/ceil axis-bound
  anchors, 18px offset, 8px margins, corner orients, start/middle/end), and
  the anchor-bound rules (xBounds = vertical axes, yBounds = horizontal,
  group-typed marks = ScopeRole union into both, grid marks excluded). Orient
  sweep 14/18; the remaining 4 are ±1-3px title/scope-bound epsilons on the
  sweep base (left/bottom orients). Three rounds landed the vega-faithful
  axis baseline architecture, the tick-position model, translate/offset,
  the legend entry-grid model, text stroke paint, title/subtitle limits,
  rule xc/yc config-ignore, the vega-exact title layout (baseline, align,
  angle, dx, subtitle color/size/padding, bound-union positioning via
  boundText), the adjustSpatial port (x2/y2 override width/height,
  rect/group/image swap, rules skip; area baseline reads y+height), mark
  paint attrs (opacity/dasharray/fill on path/rect/rule/line/area), and
  the legend title baseline + legendBounds anchoring. A later round ported
  the vega axisLayout semantics exactly: `ticks:false` zeroes the effective
  tickSize, interval-string `tickCount` refuses on non-time scales (and
  resolves to calendar intervals on time/utc), config-axis drops the
  lookup-bypassed props (`tickCount`/`values`/`tickMinStep`/`format`/
  `formatType`/`position`) and yields `tickOffset` to the axisBand style on
  band scales, axis `position` shifts the group along its line,
  `titleAnchor` snaps the title to the scale range ends and drives align,
  `titleX`/`titleY` resolve against the per-orient group origin,
  `titleAngle`/`labelAngle` rotate (baseline folded inside the rotate frame),
  and the title extent now comes from the real tick+label item bounds
  (stroke expansion and rotation included) instead of an analytic extent.
  Corpus 413/413. Sweep 7503/7549 (99.4%). A raw-guide round landed the layout-abort state: a throwing legend (tickCount interval strings, fractional/negative columns) aborts vega's whole ViewLayout — the axes/titles/legends now render at their raw encode positions (no translate delta, no perpendicular origins, degenerate boxes), the origin stays at the padding, and the view skips overflow growth. A layout/title round landed: legend anchor epsilon floors/ceils (1-ulp axis-bound guard), orient-bottom fill legends through the orient-independent block, title orient 'none' (vega's subtitle-offset switch has no case for it), and autosize contains:'padding'. A legend round landed the text-measured entry semantics: labelAlign drives both the text anchor and the bound extension (left w, center w/2, right 0), labelLimit width runs vega's limit truncation (the ellipsis inside the limit budget, util/text.js truncate) before measuring, the border strokeColor insets the rect half a pixel and boundStrokes the legend bounds, cornerRadius renders the rounded border at full size, and falsy `columns` lays one entry per column (opt.columns || groups.length). The vega-native trellis is in: a group mark with a `layout` def builds facet cells as scoped groups (facet key as the `parent` signal, cell encodes, scoped scales resolving against the outer scope signals, per-cell axes and titles) and runs them through the gridLayout port; a throwing layout renders unlayouted with default padding, as vega's dataflow does. A later scale round landed
  vega's continuous-scale `round` (via interpolateRound), interval-string
  `nice` through the tickCount util, band `align` (dropped by buildScale)
  and the type-keyed axisBand tickOffset, the vega-util zoom family for
  padDomain (log/sqrt/pow/symlog zoom in their transform spaces),
  point-scale labels at the raw scale position (the rounded tick position
  skewed view bounds by a pixel), and NaN-safe degenerate legend symbols.
  A legend round read the upstream render state directly (scenegraph dumps
  mid-pipeline) and ported the whole symbol-legend entry pipeline exactly:
  LegendEntries symbolLimit semantics (values.slice(0, limit-1) + the
  '…N entries' ellipsis entry whose offset datum collapses to 0 over the
  empty slice — symbolLimit 0.5 and −4 produce identical output), the
  sizeExpression datum (max(ceil(sqrt(symbolSize)+strokeWidth), fontSize);
  a negative symbolSize makes it NaN — the symbol path degenerates to its
  'MNaN,0' moveTo, the item bounds stay at their ±MAX_VALUE sentinels where
  unions no-op, and the `x || 0` anchor coercion pins the paints to the
  frame origin), the label x chaining symbolOffset before labelOffset
  (encoder(symbolOffset) + .offset), truthy clipHeight (entry y =
  clipHeight/2, the (0,0)/(0,clipHeight) corner points unioned into the
  entry bound, per-entry clipPath defs over the laid-out entry rect in both
  renderers), MEASURED per-entry bounds (boundText for labels — negative
  font sizes flip through Bounds.set normalization, and textWidth dropped
  its canvas-only fontSize guard; traced paths + miter stroke expansion for
  symbols), gridLayout's float column widths vs ceil'd advance extents with
  offsetValue lifts, column-major cell fill for vertical legends (the
  row/index sort), legendEntryLayout/legendGroupLayout/legendLayout sizing
  (title bound height drives the entry row, normalized title-bound x1 the
  overhang shift, legendBounds anchors x1/y1 at the padding clamping
  overhang), and the legend border (not symbol) stroke as the only
  boundStroke on the outer rect.
  A config-range round ported the scheme-range semantics: a named range
  resolves through config.range then vega's defaults (diverging carries
  extent [1,0]; a user entry replaces the default wholesale), a continuous
  scheme on a discrete scale quantizes to the domain cardinality, and the
  interpolator samples across flip(extent ?? [0,1], reverse) with the
  scale treated as a color scale (vega's scaleKey coerces linear+scheme to
  sequential-linear, which skips includeZero). An axis round ported
  tickBand ('extent' forces band 1/offset 0/extra on; 'middle' forces
  0.5), the AxisTicks extra entry (pegged to the first tick value, empty
  label, the scale+bandwidth term replaced by the raw scale of that
  value), unrounded label positions for every orient, the axis encode
  `range: abs(span(range(scale)))` spine extent, and labelFlush
  (align/baseline flips within the threshold of the range endpoints,
  labelFlushOffset dx/dy inward). config-mark closed the fill/stroke pair
  rule (a config fill/stroke default is skipped when either paint is
  encoded).

  **R8.4 floor — zero comparable differs (7538 ok + 8 both-refused + 3 oracle-refused / 7549):**
  every case both engines can draw now matches. The 3 remaining non-ok cases are
  oracle refusals (encode/config-area-interpolate-bundle: vega's own bound pass
  crashes in d3-shape; encode-trail-size--4: vega refuses a negative radius).
  Closed across this phase: identity scales, horizontal-area baselines,
  half-pixel/fractional and negative view dimensions, log/symlog degenerate
  symbols, title anchor/orient epsilons, rotated path bounds, clip-bound
  epsilon handling, and scene item/paint order.

  The **vega-lite sweep** now runs (the lite cases compile both VL
  compilers to Vega before rendering): baseline 10937 ok / 15581 differ /
  935 engine / 43 node — that surface is @aster/vl's drift, tracked
  separately from this floor. Parity rounds closed the bulk of it:
  27356 ok / 62 differ / 34 engine / 21 node of 27513 (99.4%).

  A later sweep pass closed another 148 cases. It added the `strokeWidth`
  channel end to end (linear [1,4] scale, per-entry stroke legend with vega's
  per-row size expression and bounds), made size/strokeWidth legends honor
  reverse, symbol limits, tickMinStep and empty-domain titles, and reproduced
  vega's continuous legend label formatting (`labelFormat` → span formatter, so
  a collapsed domain reads `1.000000` and an all-invalid gradient keeps its
  `NaN` label). Aggregate semantics now match vega more closely: count/
  distinct/valid/missing normalize the channel to quantitative, the invalid
  filter runs after the aggregate (only for scale-bearing quantitative
  channels), temporal aggregate outputs are not filtered, `distinct` reads the
  stored tuples (NaN/null count as values), `missing` excludes NaN, and the
  exponential family keeps vega's null/undefined ratio arithmetic (undefined
  ratio → NaN → filtered rows). Axis work landed the full `config.axisBand`
  cascade (title/orient/disable/tickOffset precedence), vega's explicit
  `labelAngle` normalization and derived label anchors, `orient` propagation to
  the grid axis, hidden-label exclusion from axis bounds, and the
  axis-group/rect spatial rules (x2/y2 style defaults apply to enter marks but
  not update-only marks, matching vega's per-block `adjustSpatial`).

  A further pass closed 34 cases. It fixed the axis tick model (a missing
  tickCount now means vega's tally of 10, tickMinStep goes through `tickCount`
  for every scale type, the cyclic month/day/quarter/hours units suppress the
  default tickCount, explicit axis `values` run through `validTicks` and are
  inherited by the grid axis, and `labelSeparation` reaches the overlap
  transform). Facet headers now lay out their label/title title-groups exactly:
  explicit fontSize/baseline/angle anchor at the vega title origin, angle signs
  pick left/right/center, baseline offsets are baked once (renderer vs flat
  item), and `header.title` overrides the column/row title text. Aggregate
  source casts now follow the DECLARED type (count-like ops over nominal
  sources no longer coerce the column or filter the aggregate output), and a
  continuous `xOffset`/`yOffset` channel gets a linear scale over the band
  width with vega's 18px bar size instead of a band scale.

  Another pass closed 19 cases. Size legends now implement `titleOrient`
  (top/left/right/bottom margins), explicit `labelBaseline` bounds, and
  opacity-0 symbol bounds; `config.legend` supplies symbolType defaults and
  translates `orient`/`symbolDirection`/`gradientDirection` into the compiled
  direction; text marks read config/style `baseline`/`filled` and map
  `outerRadius` to the polar `radius`; rect marks ignore `size` like vega; and
  the row-facet title is measured at its 11px guide-title size; and size
  legends now honor labelLimit truncation floor and symbolLimit's ellipsis
  entry dimensions. A final legend/axis pass added gradient `titleOrient`
  (side/bottom titles), negative gradient length/thickness geometry, and an
  explicit ranged-axis title (x2/y2 title wins over the joined default).
  Config-scale `xReverse`/`continuousPadding` now reach the positional scales,
  and a discrete point scale centers vega-lite's 18px bar while continuous
  measures keep the 5px band size. Explicit stack now applies to point
  marks (stack on x or y picks the measure axis) and stacked points read the
  `_end` field. Size legends now build Vega's horizontal grid for
  direction:horizontal / orient top|bottom / integer columns, and clipHeight
  entries use the clipped symbol path plus per-entry clip rects, and a size
  legend with `type: gradient` compiles to a gradient legend over the size
  scale.
  Closed clusters: the config layer (config forwarding into the Vega
  spec — guide blocks, mark -> config.mark, per-type blocks ->
  style[type], view -> cell with stroke/fill on the frame, title ->
  group-title/group-subtitle, scale applied to the scales — plus
  getMarkPropOrConfig paint resolution into the encodes for every mark
  type), legend paint properties (gradient + size builders), the facet
  view (grid-derived view sizing, degenerate root frame, header labels
  evaluating the title signal against vega's parent scope, forwarded
  label*/title* props, unwhitelisted facet axes, half-pixel guide
  bounds), the trail mark (compile + vega's built-in trail style size 2
  + d3-path-exact trail path geometry), the miter-expansion
  arc/path/symbol bounds, the descending-sweep arc bound
  normalization, grid/axis paint (gridColor through the compiled axis),
  tick thickness/size semantics, and the variance/stdev/stderr/values
  aggregate ops. Also closed: legend title-row metrics (titlePadding/titleFontSize),
  text-mark pass-through props, aggregate groupby over every
  non-aggregated field, the DEFAULT_REDUCED_OPACITY non-aggregate rule,
  the facet view's grid sizing and header labels, tick band/thickness
  config fallbacks, bar band-align/size semantics, and the arc radius
  resolution chain. The schema sweep's comparable differ set is now
  zero: the final pass closed guide-scale ranges/domains, facet header
  labelOrient/orient, config axis/header precedence, axis orient/grid
  geometry, label-angle anchors, tick/label tails, `values` aggregate
  domains, and size-legend grid layout. Remaining non-differ cases are
  the `ci0`/`ci1` bootstrap (Math.random inside vega — the oracle is
  nondeterministic by design), and oracle refusals of invalid shapes/radii
  and degenerate scale specs. Off-sweep parity also advanced: discrete
  scheme piecewise sampling is verified against Vega across schemes and
  domain cardinalities, `config.point` now feeds line/area point overlays
  (size/shape/strokeWidth/paint), and full `bin`/`window`/`joinaggregate`/
  `impute` options are covered by unit tests plus corpus specs.
- **R8.5 — DONE.** Remaining limitations are covered by the sweep scoreboard/probe harness; fixed behaviours are promoted into `corpus/` (bin/window options, `joinaggregate.key`, `impute.keyvals`, `config.point` overlays).
- **Acceptance:** sweeps and scene differential run in CI; corpus scale diffs are zero.

### R9 — Rendering targets: SVG and Canvas (L, must) — R9.1/R9.2 DONE

Both backends render the same scene, so the engine stays single-sourced; only the
final walk differs. **Done:** `@aster/core/canvas` renderer replays the shared
geometry (path-data parser) with an 8-test record-differential over all 288 vega
corpus scenes (zero diffs), and `<Chart renderer="canvas">` with dpr backing
stores, full-scene repaints, and SSR safety.

- **R9.1** Canvas renderer over the scene, parity-tested against the SVG path
  (same geometry, paint, clipping, text, gradients).
- **R9.2** `<Chart renderer="svg" | "canvas">`, SSR-safe SVG default; the canvas path
  handles devicePixelRatio, resize, and redraws without leaking listeners.
- **R9.3 — DONE.** Canvas paints are scheduled on `requestAnimationFrame` (replaced/cancelled per scene) so a large scene never blocks React's commit; synchronous fallback for hosts without rAF.
- **Out of scope:** PNG/PDF export. A host can rasterise the SVG or canvas itself if
  it needs a file.
- **Acceptance:** canvas passes the same scene differential as SVG; a canvas chart
  survives resize and strict-mode remount; base bundle unchanged when canvas is not
  imported.

### R10 — React-native interaction and accessibility (XL, must)

Interaction is a first-class deliverable, not a wrapper around an imperative view.
Everything below is expressed in React terms: controlled/uncontrolled props, hooks,
callbacks, and `useSyncExternalStore` where a session holds external state.

- **R10.1 — DONE.** Scene hit index (`@aster/core/hit`, uniform grid above a
  threshold, vega-matching pick semantics, paint-order resolution) so hover,
  click, touch and tooltips resolve a mark without walking the DOM. Wired into
  `<Chart renderer="canvas">` tooltips.
- **R10.2 — DONE.** Controlled interval brush (`onSelect`/`brush`), point/click selection (`onPointSelect`) and the unified `SelectValue` (`selection`/`onSelectionChange`, interval or point) all resolve through the scene hit index on SVG and canvas.
- **R10.3 — DONE.** Pan/zoom via wheel, drag, two-pointer pinch and keyboard, exposed as props and as a controlled `view: ViewDomain`; driven through scale `domainRaw` so marks and every guide recompute. Works on both SVG and Canvas.
- **R10.4 — DONE.** `signal.on` streams bridge to `onSignal`/`signalListeners`; values live in an external store read with `useSyncExternalStore`, so an event is one synchronous React state transition (no tearing under concurrent rendering). `ChartHandle.setSignal` drives the same path.
- **R10.5 — DONE.** `renderTooltip` renders custom tooltip content in the React tree (the default tooltip already lives there too).
- **R10.6 — DONE.** `buildA11yTree` emits one positioned, focusable node per mark item (or a dense summary), axis, legend and title, with upstream-style captions/roles, `aria`/`description` channels, selected state, a configurable density threshold and continuous axes exposed as sliders.
- **R10.7 — DONE.** Keyboard navigation across marks/guides (`Tab`, arrows, Home/End, Enter/Space) plus axis-slider pan/zoom (`+`/`-`, reset), with focus management in `<Chart>`.
- **Acceptance:** pan/zoom/select/tooltip are covered by React interaction tests on
  both backends; an axe (or equivalent) check passes; captions match upstream wording.

### R11 — React idioms and performance (M, continuous)

- **R11.1 — DONE.** `<Chart>`/`useChart` accept Vega or Vega-Lite directly (the VL compiler is `@aster/vl`, not `vega-lite`), and `ChartHandle` exposes scene/SVG/chart-info/view/signal methods imperatively.
- **R11.2 — DONE.** `useSpecData` / `useChartData` use `use()` + Suspense over a cached `loadSpecData` promise (loader addon imported lazily); `<Chart spec={promise}>` suspends to the host boundary.
- **R11.3 — DONE.** `renderChartToStaticMarkup` emits the full SVG; `hydrateChart` adopts and patches the server `<svg>` through the DOM patcher (React `renderToString` + `hydrateRoot` also round-trips the same DOM).
- **R11.4 — DONE.** `useChartWorker` + a pure request handler offload compile/evaluate/render to a Worker and fall back to the same synchronous handler when Workers are unavailable; responses carry a structured-clone-safe scene.
- **R11.5 — DONE.** Differential engine retained; `scripts/budget.mjs` gates core, dom, canvas, hit, signals and React entries independently.
- **Acceptance:** a chart renders from a VL spec in a fresh React app with no
  `vega-lite` import; SSR + hydration tests pass; budgets green.

### R12 — Production (M–L)

- **R12.1 — DONE.** `SpecLimits`/`AsterLimitError` enforce row/mark/depth/string/item/path/SVG budgets pre- and post-evaluation, plus an opt-in `maxTimeMs` wall-clock deadline checked at phase boundaries and inside dataset/encode loops.
- **R12.2 — DONE.** `@aster/core`, `@aster/react` and `@aster/vl` are publishable (metadata, files, exports, lockstep versions), with a tag-triggered release workflow using npm provenance and the dependency-boundary gate.
- **R12.3 — DONE.** Added API, errors, limits, testing, fonts, performance, interaction and release docs, plus ADRs 0002–0004 covering interaction, SSR/async/worker and publishing.
- **R12.4 — DONE.** Deterministic differential fuzzer, committed reproducer corpus/replay, and a nightly workflow running conformance, both schema sweeps, 3000 fuzz seeds and reproducer replay.
- **R12.5 — DONE.** Added BSD-3-Clause `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`.
- **Acceptance:** a clean app installs from npm and renders Vega and Vega-Lite; a
  hostile spec fails with a typed error; nightly jobs green.

---

## 5. Sequencing

```
R0 ─┬─► R1 ─┬─► R2 ─┐
    │       ├─► R3 ─┼─► R7 ─┐
    │       ├─► R4 ─┘       ├─► R9 ─┬─► R10 ─► R12
    │       ├─► R5 (addon)  │       └─► R11
    │       └─► R6 (addon)  │
    └─► R8 ─────────────────┘
```

- **R0 before everything:** the boundary check and the vector harness are what make the
  rest safe.
- **R1 first, then R2/R3/R4 in parallel:** these unblock the pipeline and the VL
  compiler; R5/R6 are addon-gated and can trail.
- **R7 (Vega-Lite) can start once R1–R4 are stable**, because its output is Vega and it
  depends on the same foundation.
- **R8 runs continuously:** every phase's acceptance is measured by it.
- **R9 (canvas) precedes R10 (interaction)** because pan/zoom/hit testing must work on
  both backends; **R10 and R11 are independent**, and **R12** follows once the runtime,
  compiler and interaction model are ours.
- **Interaction can be prototyped early** against the SVG backend (the existing brush
  and tooltip are a start), but it is not "done" until it works identically on canvas.

## 6. Definition of done

1. `@aster/core` has **zero** runtime dependencies on `vega-*`, `d3-*` or
   `topojson-*`; a CI check enforces it.
2. It renders Vega **and** Vega-Lite directly, matching upstream's compiled Vega
   property-for-property and upstream's rendered scene mark-for-mark and
   scale-for-scale.
3. Schema sweeps and recorded upstream vectors cover the language, not just a fixture
   list.
4. Both **SVG and Canvas** render the same scene and pass the same differential; there
   is no PDF/PNG workstream.
5. `<Chart>` is idiomatic React: accepts either grammar, supports SSR/hydration and
   async data, and offers declarative select/pan/zoom/tooltip plus a positioned
   accessibility tree that works on both backends.
6. Untrusted specs are bounded in time and memory and fail with typed errors.
7. Packages publish to npm with docs, changelog and licence.

## 7. Keeping this document honest

Every number in §1 is reproduced by a gate. As phases land, move replaced packages
from §1's audit table to a "done" list and shrink the R0.2 allow-list; the two must
agree, and CI should fail when they do not.
