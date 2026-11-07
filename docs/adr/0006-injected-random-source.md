# ADR 0006: Randomness is injected or seeded, never ambient

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

Vega draws from one global `Math.random` that a host can replace with `setRandom`. The
expression `random()`, the `sample*` functions, the `sample` transform and the bootstrap
`ci0` / `ci1` aggregate ops all draw from it, in an order and count that follow from vega's
dataflow, which runs an operator once while its inputs stay the same.

Aster's evaluator is not a reactive dataflow. It builds datasets and resolves signals more than
once in one evaluation, and a chart evaluates again for every size, data or signal change. With
an ambient `Math.random` that is invisible. With a host-injected stream it would consume the
stream once per pass and give later passes other numbers than vega's single run gives. And an
incremental evaluation that draws fresh random numbers cannot equal a fresh one
([ADR 0005](0005-signal-write-is-a-fresh-render.md)).

## Decision

1. A host injects randomness per evaluation: `RuntimeInput.random`, a function returning numbers
   in [0, 1) (`<Chart random={...}>` in React), the counterpart of vega's `setRandom`. The engine
   never writes or replaces a global.
2. The injected source is wrapped so that each site that draws (a dataset transform, a signal
   update) keeps a tape of the numbers it drew per fingerprint of its inputs. Running a site
   again on the same inputs replays its tape; different inputs read the source on. The source is
   consumed in the count and order of vega's dataflow. Sites that cannot draw are never
   fingerprinted.
3. With no injected source, `sample` and the bootstrap ops use the engine's own seeded stream, a
   linear congruential generator (vega's constants) seeded with 42, so their result is a pure
   function of their rows. Expression functions (`random()`, `sampleNormal`, ...) and `wordcloud`
   fall back to `Math.random`, as vega does.
4. The force simulation and the circle packer never read the injected source: they always draw
   from `layoutRandom()` (`packages/core/src/layout-random.ts`, a fixed-seed linear congruential
   stream that starts from the same state every run), whether or not a host injects one.
5. A function cannot cross a worker boundary, so the worker protocol does not carry the source.

## Consequences

- A host that gives Aster and vega the same seeded stream gets the same numbers from `sample`,
  the bootstrap ops, `wordcloud` and the expression functions, which is how the differential
  tests compare randomised charts. Force and pack layouts are reproducible on their own fixed
  stream instead; injecting a source does not change them.
- `sample` and bootstrap intervals are reproducible by default, which vega's are not.
  Expression `random()` without an injected source is not reproducible, as in vega.
- Taping costs a fingerprint of a site's inputs when a source is injected; without one nothing
  is fingerprinted.
- A randomised chart in a worker uses the engine's seeded streams or `Math.random`, not the
  host's source.

## Where it is implemented and held

- `packages/core/src/types.ts` (`RuntimeInput.random`), `packages/core/src/random-tape.ts`
  (the tapes and `mayDrawRandom`).
- `packages/core/src/transform-agg.ts` (`SEED`, `lcg`), `packages/core/src/transform-basic.ts`
  (`sampleRows`), `packages/core/src/layout-random.ts` (`layoutRandom`).
- `packages/core/src/random-sites.test.ts`: `mayDrawRandom` names every drawing expression
  function and transform, and the engine fingerprints exactly those sites.
- `packages/react/src/Chart.random.test.tsx`: `<Chart random>` draws once per row, in row order,
  and a resize does not redraw.
- `packages/core/src/dataset-reuse.test.ts`: an evaluation that keeps dataset steps equals a
  one-shot evaluation fed the same inputs, including steps that draw random numbers.
- `packages/core/src/evaluate-once.test.ts`: `evaluateOnce` makes what `evaluateChart` makes of a
  first evaluation, with a seeded source where the chart draws.
