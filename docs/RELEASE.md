# Release

Published packages: `@aster-charts/core`, `@aster-charts/react`, `@aster-charts/vl`, versioned in lockstep.
Conformance, benchmarks and the demo remain private workspaces.

Nothing in this document is run by tests or by a contributor's machine except the
pre-flight commands; the publish itself is done by the `Release` workflow
(`.github/workflows/release.yml`) after the owner pushes a version tag.

## One-time registry and repository setup

1. The packages publish under the `aster-charts` npm organization (`@aster-charts/core`, `@aster-charts/react`,
   `@aster-charts/vl`). The org exists; its owners and members are managed on npmjs.com. The account behind `NPM_TOKEN`
   must be a member of the org with publish rights to the `@aster-charts` scope.
2. In the GitHub repository create an **environment named `npm-release`**
   (Settings, Environments). Add required reviewers, restrict it to version tags,
   and store the `NPM_TOKEN` secret (publish rights) in that environment, not as a
   repository secret. The `publish` job runs in it, so nothing publishes without an
   approval. Alternatively configure npm trusted publishing for `release.yml` and drop the token.
3. Provenance: `publishConfig.provenance` is set in each manifest; the publish job
   passes `--provenance` and is the only job with `id-token: write`.

## What the workflow does

Trigger: a pushed tag that matches `vX.Y.Z` or `vX.Y.Z-prerelease` (semver 2.0.0 forms: `v0.5.0-rc.1`, `v1.0.0-alpha`, `v1.0.0-0.3.7`; no
build metadata). There is no manual dispatch. Two jobs:

1. `verify` (read-only, no token, no `id-token`, 90 minute limit):
   - `node scripts/check-release-tag.mjs "$GITHUB_REF_NAME"`: the tag must equal the
     version of every public package, and the three must agree;
   - the tagged commit must be an ancestor of `origin/main`;
   - `pnpm install --frozen-lockfile`, then `pnpm check`, the gate list in
     `scripts/gates.mjs`. The tag is gated
     on `pnpm check` only: the Vega and Vega-Lite schema sweeps, the value sweep, the gallery, differential fuzzing, the Firefox and
     WebKit canvas runs and the long benchmarks run in the nightly workflow (`.github/workflows/nightly.yml`), not here;
   - `pnpm pack` of each public package (the same packer `verify:publish` checks), uploaded as an artifact together with
     `scripts/release-publish.mjs` and the two modules it imports (the publish job has no checkout).
2. `publish` (needs `verify`, environment `npm-release`, `id-token: write`, 20 minute limit): downloads
   those files and runs `node release-tarballs/scripts/release-publish.mjs "$GITHUB_REF_NAME" release-tarballs`. For core, vl, then react
   it runs `npm publish <tarball> --access public --provenance --ignore-scripts --tag <dist-tag>`. It installs and builds nothing, so no dependency lifecycle
   script ever runs with the publish token or the OIDC token in reach.

The dist-tag is always explicit: **`next` for a prerelease version (any version with a `-`), `latest` for a stable one**
(`scripts/lib/release.mjs`, covered for every semver prerelease form by `scripts/release-publish.test.mjs`). Without `--tag`, npm 10
would publish `v0.5.0-rc.1` as `latest` (so `npm i @aster-charts/react` would install the candidate) and npm 11 would refuse the publish.
Moving `latest` afterwards is a manual `npm dist-tag add`, not something the workflow does.

### Recovering from a partial publish

The three packages go out one after the other, so a registry error (5xx, a revoked token) can leave `core@X` live and immutable while
`vl@X` or `react@X` are not. The script is idempotent: before each package it asks `npm view <name>@<version> version` and **skips a version
that is already on the registry**, and it treats any answer other than "published" or "E404" as an error rather than as a reason to publish.
So the recovery is: fix the cause (token scope, registry outage), then use "Re-run failed jobs" on the same workflow run (or re-run
`publish`); the missing packages are published and the present ones are skipped. Never delete the tag or burn the version for this.
A package published by hand outside the workflow has no provenance and no verified tarball; avoid it.

### Why the three versions are pinned to each other exactly (lockstep)

`@aster-charts/react` depends on `@aster-charts/core` and `@aster-charts/vl` with `workspace:*`, which `pnpm pack` rewrites to the exact
version being packed. This is deliberate: the packages share module-level registries in core (transforms, geo projections, data formats,
the VL compiler hook), so two copies of core in one app (an app that installs `@aster-charts/core` at one version next to a `react` that pins
another) would register into a copy `<Chart>` does not read. Exact pins plus one registry (the three are published together, by one workflow, at one
version) make that state unreachable from a release; an app that imports `@aster-charts/core` directly must keep it at the same version as
`@aster-charts/react` (the READMEs say so, and `pnpm ls @aster-charts/core` shows a second copy). A caret range or a peer dependency would
trade this guarantee for freedom to skew; ADR 0004's lockstep rule chooses the guarantee.

Every action is pinned by commit SHA (the tag is in a comment beside it);
`scripts/release-workflow.test.mjs` asserts the trigger, the permission split, the
pinning, the environment and the ordering of the steps on the workflow file.

## Cutting a release (the owner's steps)

Releases go through a release branch and a pull request (`release/vX.Y.Z`, merged to `main`); the tag names the merge commit on `main`.

```bash
git switch -c release/v0.1.0
pnpm install --frozen-lockfile
pnpm check                 # the same gate list the workflow runs
# update CHANGELOG.md and the version of all three public packages (lockstep)
# update the README pre-alpha status paragraph and the "not yet published" notes of the Install sections, and the publishing items in docs/ROADMAP.md
node scripts/check-release-tag.mjs v0.1.0     # tag name = version in every package.json
git commit -am "release v0.1.0"
git push origin release/v0.1.0                # open the PR and merge it; CI runs on main after the merge
# confirm CI on main and the nightly workflow are green for the merge commit to be tagged (see below)
git switch main && git pull --ff-only origin main
git tag v0.1.0
git push origin v0.1.0                        # the tag push starts the Release workflow
```

Push the tag by name. `git push --follow-tags` sends annotated tags only and a plain `git tag` is lightweight, so with it the tag stays local
and the workflow never starts (and nothing fails). `scripts/release-workflow.test.mjs` runs this block's tag and push commands against a
bare remote and requires the tag to arrive.

Before tagging, confirm that the nightly workflow (`.github/workflows/nightly.yml`: the schema sweeps, the value sweep, the gallery,
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
npm view @aster-charts/core version
npm view @aster-charts/react version
npm view @aster-charts/vl version
npm view @aster-charts/react dist-tags    # a stable release: latest is the new version; a prerelease: next is, latest unchanged
```

## Clean-app smoke test

```bash
npm create vite@latest aster-smoke -- --template react-ts
cd aster-smoke && npm i @aster-charts/react @aster-charts/core
# Vega-Lite is opt-in:
#   import '@aster-charts/react/vl'
# render a Vega-Lite spec directly (no vega-lite dependency)
```

Then check one hostile spec fails with `AsterLimitError` and one URL-backed spec works
through `loadSpecData`.
