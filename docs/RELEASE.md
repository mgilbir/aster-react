# Release

Published packages: `@aster/core`, `@aster/react`, `@aster/vl`. Conformance,
benchmarks and the demo remain private workspaces.

## One-time registry setup

1. Create the `@aster` npm scope (or change package names).
2. Configure npm trusted publishing for the GitHub `release.yml` workflow, or add an
   `NPM_TOKEN` repository secret with publish rights.
3. Enable provenance on npm. `publishConfig.provenance` is already set; the workflow
   also passes `--provenance` and requests `id-token: write`.

## Cutting a release

```bash
pnpm install
pnpm check:deps && pnpm typecheck && pnpm build && pnpm test && pnpm conformance
pnpm --filter @aster/benchmarks run budget
# update CHANGELOG.md and package versions (all three public packages in lockstep)
git commit -am "release v0.1.0"
git tag v0.1.0
git push --follow-tags
```

The `Release` workflow publishes all non-private workspace packages with public
access and provenance. Verify with:

```bash
npm view @aster/core version
npm view @aster/react version
npm view @aster/vl version
```

## Clean-app smoke test

```bash
npm create vite@latest aster-smoke -- --template react-ts
cd aster-smoke && npm i @aster/react @aster/core
# Vega-Lite is opt-in:
#   import '@aster/react/vl'
# render a Vega-Lite spec directly (no vega-lite dependency)
```

Then check one hostile spec fails with `AsterLimitError` and one URL-backed spec works
through `loadSpecData`.
