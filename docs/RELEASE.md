# Release

Published packages: `@aster/core`, `@aster/react`, `@aster/vl`, versioned in lockstep.
Conformance, benchmarks and the demo remain private workspaces.

Nothing in this document is run by tests or by a contributor's machine except the
pre-flight commands; the publish itself is done by the `Release` workflow
(`.github/workflows/release.yml`) after the owner pushes a version tag.

## One-time registry and repository setup

1. Create the `@aster` npm scope (or change package names).
2. In the GitHub repository create an **environment named `npm-release`**
   (Settings, Environments). Add required reviewers, restrict it to version tags,
   and store the `NPM_TOKEN` secret (publish rights) in that environment, not as a
   repository secret. The `publish` job runs in it, so nothing publishes without an
   approval. Alternatively configure npm trusted publishing for `release.yml` and drop the token.
3. Provenance: `publishConfig.provenance` is set in each manifest; the publish job
   passes `--provenance` and is the only job with `id-token: write`.

## What the workflow does

Trigger: a pushed tag that matches `vX.Y.Z` or `vX.Y.Z-prerelease`. There is no manual
dispatch. Two jobs:

1. `verify` (read-only, no token, no `id-token`):
   - `node scripts/check-release-tag.mjs "$GITHUB_REF_NAME"`: the tag must equal the
     version of every public package, and the three must agree;
   - the tagged commit must be an ancestor of `origin/main`;
   - `pnpm install --frozen-lockfile`, then `pnpm check`, the gate list in
     `scripts/gates.mjs`. The tag is gated
     on `pnpm check` only: the Vega and Vega-Lite schema sweeps, the gallery, differential fuzzing, the Firefox and
     WebKit canvas runs and the long benchmarks run in the nightly workflow (`.github/workflows/nightly.yml`), not here;
   - `pnpm pack` of each public package (the same packer `verify:publish` checks), uploaded as an artifact.
2. `publish` (needs `verify`, environment `npm-release`, `id-token: write`): downloads
   those tarballs and runs `npm publish <tarball> --access public --provenance --ignore-scripts`
   for core, vl, then react. It installs and builds nothing, so no dependency lifecycle
   script ever runs with the publish token or the OIDC token in reach.

Every action is pinned by commit SHA (the tag is in a comment beside it);
`scripts/release-workflow.test.mjs` asserts the trigger, the permission split, the
pinning, the environment and the ordering of the steps on the workflow file.

## Cutting a release (the owner's steps)

```bash
pnpm install --frozen-lockfile
pnpm check                 # the same gate list the workflow runs
# confirm the nightly workflow is green for the commit to be tagged (see below)
# update CHANGELOG.md and the version of all three public packages (lockstep)
# update the README pre-alpha status paragraph and the "not yet published" notes of the Install sections, and the publishing items in docs/ROADMAP.md
node scripts/check-release-tag.mjs v0.1.0     # tag name = version in every package.json
git commit -am "release v0.1.0"
git tag v0.1.0
git push --follow-tags
```

Before tagging, confirm that the nightly workflow (`.github/workflows/nightly.yml`: the schema sweeps, the gallery,
differential fuzzing, the Firefox and WebKit canvas runs and the benchmarks) is green for the commit being tagged, in the
repository's Actions tab. The release workflow does not run them and does not check that they passed. If the latest
nightly ran on an older commit, wait for the next one or run it manually (it has a `workflow_dispatch` trigger)
before pushing the tag.

The README's pre-alpha status paragraph, the "not yet published" notes of the Install sections (root README and the three package READMEs: [core](../packages/core/README.md), [react](../packages/react/README.md), [vl](../packages/vl/README.md))
and the ROADMAP's "Not done: publishing" (section 1), "Release" open item (section 2) and
definition-of-done item 7 (section 4) go stale the moment the tag is published; update them in the release commit,
together with the version and the CHANGELOG heading.

`pnpm verify:publish` is the packaging gate (part of `pnpm check`): it packs each
package with `pnpm pack`, fails on any `workspace:` range left in a packed manifest,
checks that the tarball carries `LICENSE`, `THIRD_PARTY_NOTICES.md` (with the licence
texts) and every `exports` target (JS and types), installs the tarballs with
`npm install` into a scratch project (offline; nothing is fetched or published),
imports every declared entry, typechecks a consumer file that uses the public types
with `module: nodenext`, and renders a Vega and a Vega-Lite spec through the installed
packages plus the SSR and worker handlers.

After the workflow finishes, verify with:

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
