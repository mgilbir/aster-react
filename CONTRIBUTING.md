# Contributing

Aster Charts is verified against the real Vega renderer. Before opening a PR,
run the gates from the repository root:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm conformance
pnpm conformance-vl
pnpm sweep-vl          # 27,513 Vega-Lite schema cases; must stay 0 differ
pnpm check:deps
```

Guidelines:

- Keep `@aster/core` free of runtime `vega-*`/`d3-*` dependencies; the
  dependency ratchet (`pnpm check:deps`) enforces this.
- Add a conformance corpus spec (or a unit/oracle-vector test) for every fixed
  behaviour. `packages/conformance/probes` is for known gaps; promote a probe
  to `corpus/` when it passes.
- Update `README.md` and `docs/ROADMAP.md` when a gate or known limitation
  changes.
- Do not commit generated `dist/` output or ad-hoc debug scripts.
