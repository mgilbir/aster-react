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
