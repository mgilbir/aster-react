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
