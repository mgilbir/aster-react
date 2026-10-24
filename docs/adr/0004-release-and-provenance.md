# ADR 0004: Publish three packages with provenance

Date: 2026-10-20
Status: Accepted

## Context

The monorepo contains a core engine, React bindings, a Vega-Lite compiler, and
developer-only harnesses. Users need a small install surface and verifiable artifacts;
the oracle (Vega) must never become a runtime dependency.

## Decision

1. Publish `@aster/core`, `@aster/react`, `@aster/vl`; keep conformance, benchmarks and
   the demo private.
2. Version the three public packages in lockstep and publish from a tag-triggered
   GitHub workflow with npm provenance (`id-token: write`, `--provenance`).
3. Keep the dependency-boundary ratchet in the release workflow, before build/test, so
   a forbidden oracle import can never be published.
4. Gate each published entry point independently in the bundle budget (R11.5).
5. Document the clean-app smoke test (Vega + Vega-Lite render, typed limit error) as
   the post-publish acceptance check.

## Consequences

- A release requires registry/trusted-publishing setup; the workflow document records
  it.
- Lockstep versions avoid compatibility matrices between core/react/vl.
- Provenance ties published tarballs to the commit and workflow run.

## Amendments

*2026-10-23, to match the code.* Decision 3 ("the ratchet runs in the release workflow before build/test") is
replaced by a stronger one:

- The release workflow runs only on a pushed version tag. A `verify` job with no token runs the tag/version check,
  `pnpm install --frozen-lockfile` and `pnpm check` (the whole gate list, which includes the dependency boundary,
  `verify:publish`, conformance and the bundle budgets), then packs the tarballs with `pnpm pack`.
- A separate `publish` job in the protected `npm-release` environment holds `id-token: write`, downloads those
  tarballs and publishes them with provenance, installing and building nothing.
- Actions are pinned by commit SHA. Details and the one-time setup: [RELEASE.md](../RELEASE.md).
- The tarballs are checked as consumers receive them: packed with `pnpm pack`, no `workspace:` ranges, licence
  texts included, installed with `npm install`, every export imported and typechecked (`pnpm verify:publish`).
