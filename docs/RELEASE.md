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
pnpm verify:publish        # packs the tarballs and imports them in a clean project
pnpm --filter @aster/benchmarks run budget
# update CHANGELOG.md and package versions (all three public packages in lockstep)
git commit -am "release v0.1.0"
git tag v0.1.0
git push --follow-tags
```

`pnpm verify:publish` is the packaging gate: `npm pack` runs each package's
`prepack` licence copy, the tarball must contain `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `dist` and types, and the tarballs are extracted into a
clean `node_modules`, imported through every declared `exports` entry and used to
render a Vega spec and a Vega-Lite spec (through the opt-in addon) plus the SSR
and worker handlers. It runs in CI and before publishing.

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
