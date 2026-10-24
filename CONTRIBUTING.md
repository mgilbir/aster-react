# Contributing

Aster Charts is verified against the real Vega renderer. Before opening a PR,
run the full gate list from the repository root:

```bash
pnpm check
```

The gate list lives in one place, [`scripts/gates.mjs`](scripts/gates.mjs), and
CI runs exactly `pnpm check`, so a green local run is a green CI run. Do not copy
the list anywhere else (a test fails if a workflow or doc does). `pnpm check -- --list`
prints the gates with the reason for each. The browser gates need Chromium
(`pnpm --filter @aster/conformance exec playwright install --with-deps chromium`);
`pnpm check -- --skip browser` skips them locally, but that is not the CI list.

The heavier schema sweeps and fuzzing run nightly (see
[docs/TESTING.md](docs/TESTING.md)); run them yourself when you touch the
Vega-Lite compiler or expression/transform semantics.

Guidelines:

- Keep `@aster/core`, `@aster/react` and `@aster/vl` free of `vega-*`/`d3-*`/`topojson-*`
  dependencies and imports; the dependency boundary (`pnpm check:deps`) enforces this on the
  sources and on the built `dist`.
- When you port an algorithm or table from an upstream project, add that project's `LICENSE` text to
  `THIRD_PARTY_NOTICES.md` (`scripts/notices.test.mjs` checks the texts against `node_modules`).
- Add a conformance corpus spec (or a unit/oracle-vector test) for every fixed
  behaviour. `packages/conformance/probes` is for known gaps; promote a probe
  to `corpus/` when it passes.
- Update `README.md` and `docs/ROADMAP.md` when a gate or known limitation
  changes. A number in the docs (counts, sizes, speedups) must come from a command you ran on the
  tree being documented, with the command written next to it.
- Do not commit generated `dist/` output or ad-hoc debug scripts.
