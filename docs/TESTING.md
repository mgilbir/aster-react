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
the 419-spec real-Vega SVG diff; `conformance-vl` compiles the Vega-Lite corpus
with `@aster/vl` and diffs it against the Vega-Lite oracle.

## Oracle vectors

`packages/core/testdata/vectors/*.json` hold input/output pairs recorded from the pinned
upstream libraries (`pnpm vectors`); each library the engine reimplements is replayed against
them. The `spec-level/` vectors work one level up: a Vega **scale spec** (or projection spec) is
built by real vega (vega-parser + vega-encode's Scale transform, vega-geo's Projection) and by
Aster, and the built scale's type, domain, range, bins, sampled outputs and ticks must agree.
They come from `pnpm --filter @aster/conformance run vectors:scale-spec | vectors:projection |
vectors:interpolate`; the cases are in `packages/conformance/scripts/scale-spec-cases.mjs`
(hand-written edge cases plus 700 seeded random option combinations). A spec vega rejects
must be rejected here too.

## Time zones

The repo's default run pins `TZ=UTC`, which hides zone bugs (a UTC scale formatted in local
time passes there). The `tz-matrix` gate (`pnpm test:tz`) re-runs the zone-aware unit tests
(`*.tz.test.ts`), the scale-spec vectors (local-time scales were recorded per zone) and
`packages/conformance/corpus-tz` (raw Vega specs rendered by vega and Aster in the same zone)
under `America/New_York` and `Asia/Kolkata`. Add a case to `corpus-tz` when a fix depends on
the zone.

## Nightly sweeps

```bash
pnpm sweep-vl -- --floor N --min-ok N --max-node-error N      # Vega-Lite property sweep
pnpm sweep-vega -- --floor N --min-ok N --max-node-error N    # Vega schema sweep
```

A sweep run only passes when cases actually ran, the generated count is at least
`--floor`, the number of equal renders is at least `--min-ok`, nothing differs and
Aster crashes on nothing. `--max-node-error` is a ceiling on cases the oracle
itself crashes on (an Aster crash is never reclassified). The values the nightly
workflow passes are in `.github/workflows/nightly.yml`; raise them when the
schemas grow, never lower them. The Vega sweep's three oracle-side node-errors
are vega-interpreter's area `bundle` interpolator (two cases) and a negative
trail radius.

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
pnpm fuzz                         # 200 deterministic seeds
pnpm fuzz -- --seeds 3000 --start 200
```

`pnpm fuzz:replay` (a PR gate, see `scripts/gates.mjs`) replays every committed reproducer.

A failing seed is written as a standalone spec under
`packages/conformance/fuzz-repro/`; replay it, fix the engine, then promote it into
`corpus/` and delete the reproducer. The nightly workflow runs the conformance corpus,
both schema sweeps, 3000 fuzz seeds and the reproducer replay.

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
paint, geometry and text attribute, the full transform and the paint order, and only normalizes
representation differences it can justify (each is documented in the file).
`normalize.test.ts` plants one difference at a time and requires each to be reported.

## Transform vectors

`packages/conformance/scripts/gen-transform-vectors.mjs` (`pnpm --filter @aster/conformance run vectors:transforms`)
records transform-level oracle vectors from the pinned real Vega: transform params + input rows -> output rows,
one dataflow per case, into `packages/core/testdata/transform-vectors/`. `transform-vectors.test.ts` replays them
strictly (NaN, -0, `undefined` keys, Dates, row order, cycles, thrown errors), re-runs every case over deep-frozen
inputs (no transform may mutate its input), and `timeunit` cases carry the non-UTC zone they were recorded under.
Bootstrap (ci0/ci1) and `sample` are recorded with vega-statistics' seeded LCG (seed 42), which the engine also uses.
Deliberate deviations (documented in the code): seeded randomness instead of `Math.random`, `bin` without `extent`
derives it from the data, lookup tables are prototype-less, and vega crashes that are TypeErrors are not replicated.
