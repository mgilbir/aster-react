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

- Keep `@aster/core` free of runtime `vega-*`/`d3-*` dependencies; the
  dependency ratchet (`pnpm check:deps`) enforces this.
- Add a conformance corpus spec (or a unit/oracle-vector test) for every fixed
  behaviour. `packages/conformance/probes` is for known gaps; promote a probe
  to `corpus/` when it passes.
- Update `README.md` and `docs/ROADMAP.md` when a gate or known limitation
  changes.
- Do not commit generated `dist/` output or ad-hoc debug scripts.
