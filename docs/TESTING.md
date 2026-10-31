# Testing

## Gates

The PR gate list is defined once, in [`scripts/gates.mjs`](../scripts/gates.mjs).
Run it with:

```bash
pnpm check                 # every gate, all failures reported
pnpm check -- --list       # the gates, with what each one asserts
pnpm check -- --only conformance,a11y-parity
pnpm check -- --skip browser   # no Chromium installed (not the CI list)
```

CI runs `pnpm check` and nothing else; nightly runs it and then the extras below.
`scripts/gates.test.mjs` fails if a workflow or these docs grow their own copy.

What the notable gates establish: the dependency check parses every import form
and also scans the built `dist` (see `scripts/check-deps.mjs`); `conformance` is
the real-Vega SVG diff over the corpus; `conformance-vl` compiles the Vega-Lite corpus
with `@aster/vl`, diffs it against the Vega-Lite oracle and renders the Vega that
`@aster/vl` emits through real vega (an error or a warning from vega fails the entry);
`verify-publish` packs, installs and imports the tarballs (see [RELEASE.md](RELEASE.md)).

## Reference results

Measured on this tree (node v26.11.1, Linux x86_64, `TZ=UTC` unless stated, 2026-10-26). Every
row is the command in the second column run from the repository root after `pnpm build`; the
result is the summary line it prints. They change with the code: re-run before quoting them.

| What | Command | Result |
|---|---|---|
| Corpus size | `ls packages/conformance/corpus \| wc -l`; `... \| grep -c '\.vg\.json$'`; `... \| grep -c '\.vl\.json$'` | 993 specs: 321 raw Vega, 672 Vega-Lite |
| Unit, React, script and vector tests | `pnpm test` | 168 files, 16939 tests passed |
| Time-zone matrix | `pnpm test:tz` | `[tz] all zones passed` (zone-sensitive vitest suites under America/New_York and Asia/Kolkata; `corpus-tz` under UTC and both) |
| SVG corpus vs real Vega | `pnpm conformance` | 993/993 passed |
| Vega-Lite corpus through `@aster/vl` | `pnpm conformance-vl` | 672 passed, 0 failed, 0 errored / 672 |
| Scene differential | `pnpm scene-diff` | 993/993 scenes match |
| Guide captions vs Vega `aria-label` | `pnpm a11y-parity` | 993/993 caption sets match |
| Transform option combinations | `pnpm transform-matrix` | 75/76 match (1 browser-only case skipped here, run by `conformance:browser`) |
| Vega schema sweep | `pnpm sweep-vega -- --floor 7549 --min-ok 7538 --max-node-error 3` | 7538 ok, 8 both-refused, 3 node-error (the oracle crashes), 0 engine-error, 0 differ / 7549 |
| Vega-Lite schema sweep | `pnpm sweep-vl -- --floor 27513 --min-ok 27452 --max-node-error 17 --vega-check` | 27452 ok, 44 both-refused, 17 node-error, 0 engine-error, 0 differ, 0 vega-differ / 27513 |
| Signals sweep | `pnpm sweep-signals -- --floor 166 --min-ok 103 --max-node-error 2 --max-retained 60` | 103 ok, 60 retained, 1 both-refused, 2 node-error, 0 differ / 166 |
| Gap probes (diagnostic) | `pnpm probe` | 2/2 pass |
| Fuzz reproducers | `pnpm fuzz:replay` | 2/2 pass |
| Corpus in Chromium, live text metrics | `pnpm conformance:browser` | 992/993 passed; `vlx-geo-lines-trail-size` fails (a path differs by trailing digits; it fails identically on the maps branch before this merge, open) |
| Canvas pixels vs Vega's canvas | `pnpm conformance:canvas` | chromium 994/994 passed; append painting vs full repaint: 120 scenarios, 265 append frames, 0 failing |
| Batched (dense) SVG vs per-item SVG pixels | `pnpm conformance:batch` | 61/61 passed |
| Signal event streams vs real Vega | `pnpm conformance:signals` | 64/64 cases agree (group scopes among them) |
| Vega-Lite selections vs real Vega (same native input, signals/stores/SVG compared per step) | `pnpm conformance:selections` | 53/53 cases agree (concat, facet and repeat views and geographic interval selections among them; steps where Vega keeps its first layout are held to a new Vega view's render, 13 of them, ceiling 13) |
| `intersect()` (vega-lite's geo interval selections) over every mark type, seeded boxes, by mark name / type, vs real vega in Chromium | `pnpm conformance:intersect` | every (box, scope) pair agrees (2771) |
| `<Chart>` interaction in Chromium | `pnpm --filter @aster/react run test:browser` | all checks passed |
| Incremental gate | `pnpm bench:incremental -- --points=10000 --reps=30` | append 22.2x–26.7x (floor 8x), whole-array replace 22.0x–24.9x (floor 8x), DOM patch 4.9x–6.9x (floor 1.6x), dense 100k-symbol append patch vs mount 306x–332x (floor 200x) over three runs |
| Bundle shaking | `pnpm check:bundle` | every documented import pattern still works after tree-shaking (`--blanket-false` must fail) |
| Bundle budgets | `pnpm --filter @aster/benchmarks run budget` | all 13 import-pattern rows pass (sizes in [PERFORMANCE.md](PERFORMANCE.md#bundle-sizes)) |

## React component tests: the variant matrix

`<Chart>` and `<SvgChart>` are two shells over one `ChartCore`, so the component tests run on both instead of the light chart
getting a thinner copy. `packages/react/src/testing/variants.tsx` provides `forEachVariant(needs, (Chart, variant) => …)`,
which runs its body once per variant that has the declared capabilities (`svg`, `canvas`, `interaction`, `signals`) with the
variant's component bound to the name `Chart`: `Chart` (all four), `SvgChart` (`svg`) and `SvgChart+interaction` (`svg`,
`interaction`, `signals`). A variant that lacks a capability does not skip: it asserts the documented failure (the
runtime report `<SvgChart>` gives, see [API.md](API.md#svgchart-and-the-interaction-capability)) in the test's place, and the
plain `SvgChart` variant refuses interaction props and the missing-event-loop report, so a test that uses them must declare
`interaction`/`signals`. `variant.it(needs, name, fn)` declares needs for a single test.

Guards, all in `pnpm test`: `Chart.matrix.test.ts` (no test renders `<Chart>` outside the matrix without a listed reason),
`Chart.shells.test.ts` (the shells stay thin; `lite` never reaches canvas/hit/signals), `Chart.types.test.ts` (type fixtures that
must compile and must fail on exact lines, the props/handle parity assertions, and the documented examples) and
`Chart.corpus-parity.test.tsx` (the DOM of `<Chart>`, `<SvgChart>` and `<SvgChart interaction>` equal over the 993 corpus
specs: server markup, client mount, hydration).

`retained` in the signals sweep means: the engine equals vega's fresh render of the same signals, and vega's own
second render (after the signals were written into the running view) does not. See
[ARCHITECTURE.md](ARCHITECTURE.md#deviations-from-vega).

## Oracle vectors

`packages/core/testdata/vectors/*.json` hold input/output pairs recorded from the pinned
upstream libraries (`pnpm vectors`); the libraries the engine reimplements are replayed against
them (`packages/core/src/oracle-vectors.test.ts`). Recordings only hold for results that do not
depend on the V8 version (see "Why live" below), so only those suites stay recorded: vega-util,
d3-color (compared with a 1e-6 tolerance, because of its cbrt/pow round-trips), d3-format and
vega-format, vega-time, d3-dsv and topojson-client.

The four suites that went through `Math.pow/exp/log`, the trig functions or `sqrt` are LIVE
differentials, with their inputs in importable case modules beside the tests (the old recordings
broke CI once, Node 22 against Node 26):

| Suite (former vector file) | Test | Inputs | Cases |
|---|---|---|---|
| vega-scale: op programs, DST programs, scheme registry, tick helpers | `differential-vega-scale.test.mts` | `vega-scale-cases.mjs` | 43 + 2 + 68 + 60 |
| d3-geo projections and `geoPath`, d3-contour | `differential-d3-geo.test.mts` | `d3-geo-cases.mjs` | 18 + 30 (geo twice, see below) |
| the geo engine over seeded random GeoJSON and random projection parameters, every projection type, fits, spherical measures, whole specs | `differential-geo-generated.test.mts` | `geo-gen.mts` | 17 types x (36 + 14) + 6 x 17 fit-width/height + 600 spherical + 90 specs |
| d3-shape lines, areas, curve families | `differential-d3-shape.test.mts` | `d3-shape-cases.mjs` | 247 + 9 (each twice, see below) |
| d3-shape generated: every curve x beta/tension/alpha x seeded point sets (gaps, duplicates, collinear, 0-2 points, 1e300 / 1e-300, NaN/Infinity), line and area in five x0/x1/y0/y1 configurations, `d` at 3 / 0 / full digits and the raw context calls | `differential-d3-shape-generated.test.mts` | generated in the test (seeded) | 57 curve variants as line and as area, ~56k comparisons |
| vega-expression parser and vega-interpreter evaluator (all five kinds) | `differential-vega-expression.test.mts` | `vega-expression-cases.mjs` | 92 + 23 + 74 + 18 + 10 |

Four more live differentials are GENERATED (seeded, so a failure names its seed and case; `ASTER_DIFF_SCALE=10` multiplies the counts,
`ASTER_DIFF_TRACE=<file>` logs each case before it runs) and cover the formatting layer far beyond the recorded vectors:

| Module | Test | What is drawn |
|---|---|---|
| `format.ts`, number half of `locale.ts` vs d3-format and vega-format | `differential-format.test.mts` | specifiers over the whole grammar (and garbage), values incl. -0, NaN, +-Infinity, 1e21+, tiny, ties, non-numbers; `formatPrefix`; `precision*`; `tickStep`; generated locales (separators, grouping, numerals, currency, minus, nan, percent, some malformed); `formatFloat`, `formatSpan`, memoised identity, `defaultLocale` |
| `time-format.ts`, time half of `locale.ts` vs d3-time-format and vega-format | `differential-time-format.test.mts` | every directive (and non-directives) with the `- _ 0` modifiers, local and UTC, in UTC / America/New_York / Australia/Lord_Howe / Pacific/Apia / Asia/Kolkata; instants clustered at the zones' offset changes (found by scanning) and the ends of the Date range; parse of damaged round trips and garbage; generated locales; multi-format objects |
| `time.ts` vs d3-time and vega-time | `differential-time-intervals.test.mts` | floor / ceil / round / offset / range / count / `every(k)` / `filter` of every interval with odd steps and inputs; `timeUnits`, `timeUnitSpecifier`, `timeFloor` / `utcFloor` over generated unit lists and steps, `timeOffset`, `timeSequence`, `dayofyear`, `week`, `timeBin` (finite extents) |
| `color.ts` vs d3-color | `differential-color.test.mts` | well-formed and malformed colour strings (every CSS function, signs, exponents, percents, arity, case, all 148 keywords), constructors with odd channels, conversions between all spaces, brighter / darker / clamp / copy / string forms |
| `transform-agg.ts`, `transform-window.ts`, `transform-basic.ts` vs vega-transforms | `differential-transforms-generated.test.mts` | seeded cases per suite (aggregate, joinaggregate, window incl. frames/peers/ties, pivot, bin with every parameter also as signals, stack, impute, lookup, fold/flatten/project/identifier, timeunit, chains of 2-4 transforms): rows compared with key order, errors, random draws, published signals, frozen inputs |

The pinned upstream and Aster run in ONE process on identical inputs and are compared strictly: `NaN`,
`-0`, `undefined`, `Date`s, and thrown errors (class and message) all count, with no tolerance, no skip list
and no allow list (`exact()` in `differential-util.mts`). Each test ends with a coverage floor at the old
recorded case count, so the suites cannot shrink silently. The expression parser kinds are
engine-independent and would have stayed recorded, but they are live too (it costs nothing and keeps the whole
file out of `testdata`); the evaluator kinds are not (`pow`, `sqrt`, the `Math` table, and the V8 wording of the
TypeErrors that `evalSecurity` pins).

d3-shape and d3-geo round path coordinates to 3 decimals by default, which hides a 1-ulp divergence (a planted
`* (1 + Number.EPSILON)` in a Catmull-Rom curve and in the Mercator raw projection left every string identical).
Their cases therefore run twice, at the default digits and at full precision (`digits` null). The generated d3-shape differential also compares the exact numbers the curves send to a drawing context, which is what the canvas renderer draws.

The **spec-level** suites work one level up and are LIVE differentials, not recordings
(`packages/conformance/scripts/differential-{scale-spec,projection,interpolate}.test.mts`): a Vega **scale spec**
(or projection spec, or interpolator) is built by real vega (vega-parser + vega-encode's Scale transform, vega-geo's
Projection, vega-scale's interpolators) and by Aster in the same process, and the built object's type, domain, range,
bins, sampled outputs, ticks and paths must agree exactly. A spec vega rejects must be rejected here too. The cases are
in `scale-spec-cases.mjs` (hand-written edge cases plus 700 seeded random option combinations), `projection-cases.mjs`
and `interpolate-cases.mjs`. Why live: `Math.pow/exp/log` and the trig functions are not bit-identical across V8
versions, so an exactly-compared recording only holds on the Node that made it; running the oracle in the same engine
needs no tolerance. Shared helpers: `differential-util.mts`.

## Guides, scopes and aria against real Vega

Raw Vega specs are run through `vega.View` and through Aster in the same process, every document compared with the
strict canonicalizer (`packages/conformance/src/*-vs-vega.test.ts`, part of `pnpm test`):

- `guide-encode-vs-vega` (every `encode` block of an axis, legend and title), `guide-null-vs-vega` (`null` in every
  property of the Vega schema's axis, legend and title: in the spec, in the config, from a signal; the property lists are
  read from the schema), `guide-style-config-vs-vega` (`config.style`, the guide blocks of the config),
  `legend-discretizing-vs-vega` (quantize, quantile, threshold);
- `group-item-aria-vs-vega` (the item-level aria channels of group items, and the accessibility tree);
- `parse-scoping-vs-vega` (6643 generated specs for `Duplicate data set name` and its scoping, against `vega.parse`);
- `axis-ticks-failure-vs-vega` (an axis whose ticks fail, per scope: 216 generated specs, named level-order cases, and the
  marks that make vega's serializer crash; a case vega cannot serialize must be refused here too).

Where the oracle itself cannot answer (`vega.parse` refuses a config null that makes it write `undefined` into an
expression, or the document has a non-finite transform) the case is counted against a ceiling, not compared.

## Time zones

The repo's default run pins `TZ=UTC`, which hides zone bugs (a UTC scale formatted in local
time passes there). The `tz-matrix` gate (`pnpm test:tz`) re-runs the zone-aware unit tests
(`*.tz.test.ts`), the live scale-spec differential (every case also runs in each zone inside the test) and
`packages/conformance/corpus-tz` (raw Vega specs rendered by vega and Aster in the same zone)
under `America/New_York` and `Asia/Kolkata`. Add a case to `corpus-tz` when a fix depends on
the zone.

## Sweeps

```bash
pnpm sweep-vl -- --floor N --min-ok N --max-node-error N --vega-check       # Vega-Lite property sweep
pnpm sweep-vega -- --floor N --min-ok N --max-node-error N                  # Vega schema sweep
pnpm sweep-signals -- --floor N --min-ok N --max-node-error N --max-retained N   # signals written into a running chart
```

A sweep generates one small chart per property/value of the schema (`--filter substr` runs a subset). It only
passes when cases actually ran, the generated count is at least `--floor`, the number of equal renders is at least
`--min-ok`, nothing differs and Aster crashes on nothing. `--max-node-error` is a ceiling on cases the oracle itself
crashes on (an Aster crash is never reclassified), `--max-retained` a ceiling on `retained` cases. `--vega-check`
also renders the Vega that `@aster/vl` emits through real vega. The signals sweep is a PR gate (`sweep-signals` in
`scripts/gates.mjs`); the other two run nightly with the values in `.github/workflows/nightly.yml`. Raise the floors
when the schemas grow, never lower them. The Vega sweep's three oracle-side node-errors are vega-interpreter's
area `bundle` interpolator (two cases) and a negative trail radius.

The browser gate (`pnpm conformance:browser`) runs the same oracle protocol in
Chromium with live text metrics. `pnpm conformance:batch` rasterizes the normal and
`denseMarks` SVG DOMs of the same scene and diffs the pixels, so the batched path
(which intentionally stops mirroring Vega's per-item DOM) cannot drift. `pnpm a11y-parity` checks every corpus guide caption
against Vega's own `aria-label`; `pnpm transform-matrix` covers bin/window/stack/
joinaggregate/impute/sequence/identifier/fold/flatten/pivot/lookup combinations. The scene differential compares the resolved scenes
before serialization: scale domains/ranges/bandwidth per scope (including nested scopes),
group/item multisets, and paint order wherever painted extents overlap.

## Differential fuzzing

```bash
pnpm fuzz                         # 200 deterministic seeds from 0
pnpm fuzz -- --seeds 3000 --start 200
```

`pnpm fuzz:replay` (a PR gate, see `scripts/gates.mjs`) replays every committed reproducer.

A failing seed is written as a standalone spec under
`packages/conformance/fuzz-repro/`; replay it, fix the engine, then promote it into
`corpus/` and delete the reproducer. The nightly workflow runs the conformance corpus,
both schema sweeps, 3000 fuzz seeds and the reproducer replay, plus Firefox and WebKit canvas parity.

## Writing a new test

- **Core**: a focused Vitest file beside the module (`packages/core/src/*.test.ts`);
  prefer oracle-vector replay or canonical SVG diff for rendering semantics.
- **React**: use `@vitest-environment jsdom`, `createRoot`/`act`, and patch
  `getBoundingClientRect` for pointer-coordinate tests. SSR tests use
  `renderToString` and (for the strict no-replacement guarantee) `hydrateChart`.
- **Conformance**: add a minimal spec to `packages/conformance/corpus/*.vg.json` or
  `*.vl.json`; the corpus requires explicit `width`/`height` and `autosize: 'none'`.

## Reproducers

Keep failures small and deterministic: no `Math.random` in specs, no clock-dependent
expressions, and no unseeded bootstrap aggregates. Pin dates through data values or
`datetime(...)` expressions.

`pnpm conformance:canvas` renders the whole corpus plus custom-font/multi-line fixtures
through both canvas backends in headless Chromium (also `--browser=firefox|webkit`)
and pixel-diffs them exactly (a pixel differs above 48 summed channel difference; at most
0.05% differing pixels and a 0.05 mean per entry, WebKit 0.1% / 0.07: the measured
3-decimal path-rounding noise plus a small headroom). The only exclusion carries its evidence
in `scripts/browser-canvas-parity.mts`. It gates canvas paint order, path replay and live text
metrics; the call-by-call draw rules are asserted in `packages/core/src/canvas-draw.test.ts` and
the recorded/jsdom canvas-vs-SVG differential stays in `packages/core/src/canvas.test.ts`.
A second phase renders random append sequences to two real canvases (incremental append painting vs a full repaint of a freshly built scene) and requires every pixel to match after every step (`packages/conformance/scripts/browser-canvas-append.mts`, also runnable alone).

The SVG oracle's canonicalizer (`packages/conformance/src/normalize.ts`) is strict: it records every
paint, geometry and text attribute, the full transform and the paint order, and (as the
structure, `N-structure`) every group's class, role, `aria-roledescription`, `aria-label`, `aria-hidden` and nesting, and only normalizes
representation differences it can justify (each is documented in the file).
`normalize.test.ts` plants one difference at a time and requires each to be reported.

## Transform differential (live)

`packages/conformance/scripts/transform-cases.mjs` lists the transform-level cases (transform params + input rows ->
output rows). `differential-transforms.test.mts` runs every case through the pinned real Vega and through
`applyTransforms` in the same process and compares strictly (NaN, -0, `undefined` keys, Dates, row order, cycles,
thrown errors), then re-runs every case over deep-frozen inputs (no transform may mutate its input). `timeunit` cases
carry the non-UTC zone they run under. Nothing is recorded: `Math.pow/exp/log` differ in the last bit between V8
versions, so numbers recorded under one Node cannot gate another; running the oracle in the same engine needs no
tolerance. CI runs `pnpm test` on Node 20, 22 and the current major for this reason.

Two more engine facts the same-process oracle depends on. (1) `Array.prototype.sort` with a comparator over data that is
not a strict weak order (a column mixing strings and numbers) returns whatever comparison sequence the engine makes, and
that is the same on Node 20 and 22 (V8 11, 12) and differs on Node 26 (V8 14) and Node 27 (V8 15); Aster sorts data through `sortData`
(`packages/core/src/util.ts`), which stays on the builtin, so it makes the engine's own comparisons like Vega does. V8 15's
Maglev also inlines a hot `x.sort(cmp)` call site with a different order from the builtin, so `sortData` keeps the call
off that path and the vitest workers pin the inlining off for the oracle (`scripts/vitest-engine.setup.mjs`);
`packages/conformance/src/sort-engine.test.ts` turns it back on and shows the order does not move. (2) The default
`pnpm test` never sees the fetched gallery cache: tests that need it are `*.gallery.test.ts`, run by
`pnpm conformance:gallery` (`vitest.gallery.config.mjs`); `scripts/gallery-isolation.test.mjs` guards the split.
Bootstrap (ci0/ci1) and `sample` use vega-statistics' seeded LCG (seed 42) on both sides.
Deliberate deviations (documented in the code): seeded randomness instead of `Math.random`, `bin` without `extent`
derives it from the data, lookup tables are prototype-less, and vega crashes that are TypeErrors are not replicated.
