# ADR 0010: `limits` are best-effort; a killable worker is the guarantee

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

A hostile spec can ask for a lot: a `sequence` of 5e7 rows, a regular expression with
catastrophic backtracking, a topojson arc referenced thousands of times. The engine is
synchronous JavaScript. A single native call (a regular expression, an engine allocation) cannot
be interrupted from inside the same thread, so nothing in-process can promise that a render ends
by a deadline.

## Decision

1. `limits` (`SpecLimits`, `AsterLimitError`) are cooperative budgets: counters and a wall clock
   checked at the sites that spend. They turn the common abuse of a spec into a typed, friendly
   error. They are documented as best-effort protection, not as a guarantee.
2. A small set of built-in ceilings (`HARD_CAPS`, `HARD_MAX_SPEC_DEPTH`) holds even when the host
   passes no `limits`, so that "every limit is optional" does not mean a fatal out-of-memory for a
   host that never wrote any. They are not a budget for charts; giving the matching limit
   replaces the ceiling.
3. Where a limit cannot interrupt a call, the engine refuses the dangerous input before it runs:
   a static screen rejects regular expressions with known catastrophic shapes, applied only
   under `limits`. It is documented as a heuristic.
4. For an untrusted spec the guarantee is the host's: render in a `worker_threads` Worker or a
   child process, with a memory cap and a deadline, and `terminate()` or kill it when the
   deadline passes. A worker is not a kill switch by itself; the host must terminate the one it
   created. `maxTimeMs` and the rest then give friendly errors in the common case, and the kill
   covers whatever they miss.

## Consequences

- Documentation and TSDoc must not call `limits` a guarantee; they point at the worker.
- Hosts that render untrusted specs carry the cost of a worker or child process and own the
  deadline.
- A limit is added where a site spends, with a test that drives the real attack shape.
- The regular-expression screen can refuse a safe pattern (`(\d+\.)*\d+`) and can pass a
  dangerous one (`.*a.*a.*a.*b`); that trade-off is accepted and stated.

## Where it is implemented and held

- `packages/core/src/limits.ts`: `SpecLimits`, `AsterLimitError`, `HARD_CAPS`,
  `HARD_MAX_SPEC_DEPTH`, and the TSDoc on `maxTimeMs`.
- `packages/core/src/regex-screen.ts`: the static screen.
- `packages/core/src/limits-attacks.test.ts` with `packages/core/src/attack.testkit.ts`: each
  budget is driven by its real attack in a child process with a hard kill, and the test asserts
  an `AsterLimitError` within a CPU-time bound.
- `packages/core/src/limits.test.ts`, `packages/core/src/expression-limits.test.ts`.
- The two layers, the ceilings and the enforcement table: [LIMITS.md](../LIMITS.md).
