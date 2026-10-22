# Testing

## Gates

```bash
pnpm check:deps        # runtime cannot import vega-*/d3-*/topojson-*
pnpm typecheck
pnpm build
pnpm test              # unit + React interaction/SSR/a11y tests
pnpm conformance       # 419-spec real-Vega oracle SVG diff
pnpm scene-diff        # R8.1–R8.3: resolved scales/groups/items per scope
pnpm a11y-parity       # guide captions vs vega-scenegraph aria-label
pnpm transform-matrix  # transform option combinations vs the Vega oracle
pnpm conformance:batch # batched-SVG pixel parity (denseMarks vs per-item)
pnpm verify:publish    # npm pack: licences + exports + consumer smoke test
pnpm sweep-vl          # 27,513-case Vega-Lite property sweep
pnpm sweep-vega        # Vega schema sweep
pnpm --filter @aster/benchmarks run budget  # per-entry bundle gates
```

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
pnpm fuzz:replay                  # every committed reproducer
```

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

`pnpm conformance:canvas` renders the corpus plus custom-font/multi-line fixtures
through both canvas backends in headless Chromium (also `--browser=firefox|webkit`)
and pixel-diffs them (1px-neighbourhood, 4% ratio / 2.5 mean tolerance). It gates canvas paint order,
path replay and live text metrics; the recorded/jsdom canvas differential stays in
`packages/core/src/canvas.test.ts`.
