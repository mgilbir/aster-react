# ADR 0009: Live differentials against the oracle, recordings only where they hold

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

[ADR 0001](0001-own-the-engine.md) verifies each port against the pinned upstream package with
recorded input/output pairs (oracle vectors). A recording is exact only if the result does not
depend on the JavaScript engine. `Math.pow`, `exp`, `log`, the trig functions and `sqrt` are not
bit-identical across V8 versions, so numbers recorded under one Node cannot gate another. The
recordings of the numeric suites broke CI once (Node 22 against Node 26). A tolerance would hide
real one-ulp divergences.

## Decision

1. Where a result depends on the engine's numerics, the test runs the pinned real library and
   Aster in the same process, on the same inputs, and compares what both produce, strictly (NaN,
   -0, `undefined`, Dates, thrown errors). Nothing is recorded. Same engine on both sides removes
   the engine from the comparison and keeps the equality exact, with no tolerance.
2. Inputs live in importable case modules beside the tests, or are generated from a seed, so a
   failure names its seed and case. Generated suites scale with `ASTER_DIFF_SCALE`.
3. Recordings stay for the suites that do not depend on V8's numerics: vega-util, d3-color (with
   a 1e-6 tolerance), d3-format, vega-format, vega-time, d3-dsv and topojson-client.
4. The scale, geo, shape, expression and transform suites are live, and generated differentials
   cover the formatting layer far beyond the recorded vectors.

## Consequences

- The oracle packages must be installed to run the suites, which they are, as dev-only
  dependencies of `@aster-charts/conformance` ([ADR 0001](0001-own-the-engine.md)).
- The suites run on every Node version CI uses; the jsdom-free ones also on Node 20
  ([TESTING.md](../TESTING.md)).
- A difference between Aster and the oracle is a failure of the test that found it, not a
  difference between two Node versions.
- Live suites cost more CI time than replaying a file.

## Where it is implemented and held

- `packages/conformance/scripts/differential-util.mts`: the shared helpers and the rationale.
- `packages/conformance/scripts/differential-vega-scale.test.mts`,
  `differential-transforms.test.mts` and the other `differential-*.test.mts` files beside them.
- `packages/core/src/oracle-vectors.test.ts` and `packages/core/testdata/vectors/*.json`: the
  recordings that remain.
- The inventory of suites: [TESTING.md](../TESTING.md#oracle-vectors).
