# ADR 0005: A signal write renders the fresh result

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

Vega's view keeps dataflow state between evaluations. A signal written into a running view
re-runs only the operators the write reaches, so state computed earlier survives: autosize
runs once and again only when `width`, `height`, `padding` or `autosize` change, and a chart
whose content outgrows the view keeps its first size. Vega's own second render can therefore
differ from its own fresh render of the same signal values.

Aster's evaluator is a function of the spec, the data and the signals. Its incremental paths
(sessions, `dataChanges`, streams) exist to be faster than a full evaluation, not to give a
different answer.

## Decision

A signal written into a running chart renders what a fresh chart with those signal values
renders. Incremental evaluation must equal a fresh evaluation at every step; where Vega's
retained render differs from Vega's own fresh render, Aster follows the fresh one.

The difference is measured, not hidden. The signals sweep and the selections comparison
classify a step as `retained` when Aster equals Vega's fresh render and Vega's retained render
differs. The count is a ceiling that can only be lowered.

## Consequences

- Rendering stays reproducible: the scene depends on the current inputs, not on the history of
  writes, so a stream, a hydrated chart and a chart that was never interacted with agree.
- A pan/zoom or brush chart whose content changes size can move its plot where Vega's keeps
  it still. The documented remedy is `autosize: "none"` ([INTERACTION.md](../INTERACTION.md#signals)).
- The `retained` cases are a known, counted deviation, listed in
  [ARCHITECTURE.md](../ARCHITECTURE.md#deviations-from-vega). Closing one means reproducing
  Vega's retained state, which would give up the equality with a fresh evaluation.

## Where it is implemented and held

- `packages/core/src/incremental-oracle.test.ts`: every update sequence, signal changes
  included, must deep-equal a freshly compiled chart evaluated from scratch at that step.
- `packages/conformance/src/run-sweep.ts`: classifies a step as `retained`; the ceiling is
  `--max-retained 60` for `sweep-signals` in `scripts/gates.mjs`.
- `packages/conformance/scripts/browser-vl-selections.mts`: the same classification and
  ceiling for the Vega-Lite selections comparison.
- What `retained` means, in full: [INTERACTION.md](../INTERACTION.md#signals).
