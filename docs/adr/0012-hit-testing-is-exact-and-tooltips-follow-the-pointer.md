# ADR 0012: Hit testing is exact, and a tooltip shows what the chart says at the pointer

Date: 2026-11-25
Status: Accepted (records decisions in force since 0.4.0)

## Context

Interaction needs two answers from the scene: which item is under the pointer (`event.item`, the tooltip's item, `@marks:click`), and
what a tooltip shows. Vega answers the first with the renderer's own pick (a canvas hit test, or the browser's element under the
pointer) and the second with a tooltip handler that is called as a pointer move is handed over, before the dataflow run the move
starts.

## Decision

1. **The hit index picks what vega picks, with no pointing slack.** `buildHitIndex` (`@aster-charts/core/hit`) answers the topmost item
   whose painted geometry contains the point: a stroke is hit as it is painted (half its width, caps and joins), a symbol with only a
   stroke by its ring, an item with neither a fill nor a stroke not at all, clips and the view's own edge bound the answer. An
   earlier 2 px tolerance made a dense chart report a point drawn later whose edge was a fraction of a pixel away instead of the point
   under the pointer. A thin line or a small touch target must be hit exactly, as in vega; a host that wants slack draws a larger
   (transparent) mark.
2. **A tooltip shows what the chart says at the pointer.** A tooltip whose value reads a signal that the same pointer move sets
   shows the value of that move; vega's shows the previous move's (it is called before the dataflow run).
3. **A tooltip belongs to the item under the pointer.** The pointer leaving the marks for an axis hides the tooltip on both renderers;
   vega's two renderers disagree (its SVG keeps the last one shown), and Aster takes the canvas's behaviour on both.
4. **Where the index cannot say what a pointer position means** (an infinite view, an SVG attribute the browser repairs, an SVG text,
   a canvas beyond single precision) it answers in doubles in the view's own frame; those cases are held as differences, not hidden
   (`conformance:geometry`).

## Consequences

- Decisions 2 and 3 are deviations from Vega that are the user's decision; they are rows of the deviations table in
  [ARCHITECTURE.md](../ARCHITECTURE.md), pinned by `pnpm conformance:selections` (which also checks that vega still behaves as the
  row says: if vega starts agreeing, the row goes).
- Decision 1 is a breaking change of 0.4.0 (CHANGELOG): `@marks:click` no longer matches a mark the spec did not name, and
  `onPointSelect` reports vega's event item.

## Where it is implemented and held

- `packages/core/src/hit.ts` (the index), `packages/core/src/hit-geometry.test.ts`, `packages/conformance/scripts/browser-geometry.mts`
  (the geometry gate against vega's real picks in Chromium), `packages/conformance/scripts/browser-signals.mts`.
- [INTERACTION.md](../INTERACTION.md).
