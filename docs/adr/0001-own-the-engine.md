# ADR 0001: Own the engine — no Vega/D3 packages in the runtime

Date: 2026-10-12
Status: Accepted
Supersedes: the "reuse only pure Vega packages" decision described in
[ARCHITECTURE.md](../ARCHITECTURE.md#expression-engine) and the related README text.

## Context

Aster React reimplements the Vega and Vega-Lite languages and their rendering, as
[`aster`](https://github.com/mgilbir/aster) (Go) and
[`aster-kotlin`](https://github.com/mgilbir/aster-kotlin) (Kotlin) do. The intended
shape of the TypeScript engine is therefore the same as its siblings: the language and
the renderer are ours; the upstream `vega`/`vega-lite` packages are the **test oracle**,
used only by the conformance harness, the vector generators and the benchmarks.

The codebase as inherited does not have that shape:

1. `@aster/core` depends at runtime on `vega-expression`, `vega-interpreter`,
   `vega-format`, `vega-scale`, `vega-time`, `vega-util` and on `d3-color`,
   `d3-contour`, `d3-dsv`, `d3-geo`, `d3-shape`, `topojson-client` (with
   `d3-array`/`d3-format`/`d3-scale`/`d3-time`/`d3-time-format` declared but unused).
2. There is no Vega-Lite implementation: hosts must run upstream `vega-lite.compile`
   themselves before handing over a spec.

The bundle argument for reuse ("smaller than bundling the full vega runtime") remains
true but is no longer the deciding one. Owning the engine is what the project is for:
it is what lets the React runtime control interaction, incremental update, size and
behaviour end to end, and it is the only route to rendering Vega-Lite directly.

## Decision

1. **The runtime owns the engine.** `@aster/core` and `@aster/react` must not import
   or declare any `vega-*`, `d3-*` or `topojson-*` package. Every such surface is
   reimplemented in TypeScript and covered by two gates:
   - **oracle vectors** — input/output pairs recorded from the pinned upstream package
     (`packages/conformance/scripts/gen-vectors.mjs` → `packages/core/testdata/vectors/`)
     and replayed by unit tests, so a port is verified for exact behaviour (including
     `NaN`, `-0`, `undefined`, `Date` and thrown-error cases) before its dependency is
     dropped. Local-time cases are recorded and replayed with `TZ=UTC` so vectors are
     machine-independent.
   - **the SVG conformance corpus** — real Vega renders the same spec and the two
     outputs are diffed, as before.
2. **The oracle stays pinned and dev-only.** `@aster/conformance` declares the exact
   oracle versions it records against, in its devDependencies. They never ship.
3. **The boundary is enforced by a ratchet.** `scripts/check-deps.mjs` fails on any
   banned import or dependency not listed in a package's `dep-baseline.json`, and on
   any baseline entry that no longer matches. Baselines start at the inherited state
   and may only shrink; each phase of [ROADMAP.md](../ROADMAP.md#3-inventory-of-own-code-to-build)
   removes its entries when the replacement is verified.

## Consequences

- **The base bundle grows** before it shrinks: scales, expressions, geo and shape
  become ours, and the per-entry budget gates are re-baselined as phases land. The
  gap to react-vega (288 kB gzip) is expected to hold.
- **Ports are transcriptions, not paraphrases.** Where upstream's behaviour is
  surprising (e.g. `toBoolean('False')` is `true`, `NaN` compares equal to everything
  in `ascending`), the port reproduces it and the vectors pin it. Correctness against
  the oracle outranks tidiness.
- **A port may fix a proven bug in our code** while matching upstream exactly — e.g.
  the `pluck` expression function now uses `field()` the way `vega-functions` does,
  instead of misusing `accessor` as a path factory (it could not have worked).
- **Docs describe the target from the phase that changes it.** ARCHITECTURE sections
  that justify the borrowed stack are superseded by this ADR as each phase lands.
