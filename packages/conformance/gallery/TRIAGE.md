# Gallery triage

Nothing is open. On 2026-11-06 the gallery gate (`pnpm conformance:gallery`, 720 specs) reported:

| path | Vega (93) | Vega-Lite (627) |
|---|---|---|
| static (real vega in Node against `renderSpec`) | 89 pass, 0 fail, 0 error, 4 unverifiable | 627 pass |
| react (real vega in Chromium against `<Chart>`) | 93 pass | 627 pass |

The spec-swap path ran 223 of 223 committed pairs and all passed. The numbers the gate holds are in
[floors.json](floors.json) (`pass`, `maxUnverifiable`, `swap`) and the names of the passing specs in
[passing-static.txt](passing-static.txt) and [passing-react.txt](passing-react.txt); a change that lowers any of them fails the gate.

The 4 unverifiable specs are not failures: the oracle itself cannot render them in Node (it needs a canvas, which Node lacks), so
there is nothing to compare against. They are `vega/contour-plot`, `vega/density-heatmaps`, `vega/labeled-scatter-plot` and
`vega/word-cloud`, and each passes on the react path, where the oracle runs in a browser.

## When a spec fails

```bash
pnpm conformance:gallery --json=out.json
pnpm --filter @aster/conformance exec tsx scripts/gallery-triage.mts out.json triage.json
```

[scripts/gallery-triage.mts](../scripts/gallery-triage.mts) puts every spec the static path did not pass into a root-cause category
(a tested claim, not a guess from a message) and prints the category table; `triage.json` is the per-spec output. Run on the current
state it prints an empty table, and the `triage.json` committed here is that run's output: `[]`.
The gallery cache must be fetched first ([README.md](README.md#the-specs-are-fetched-not-committed)).

## Compiler gaps the gallery cannot see

Gaps in `@aster/vl` that no gallery spec exercises are listed, with how to reproduce them, in
[packages/vl/README.md](../../vl/README.md#known-compiler-gaps-outside-the-gallery).

## History

The earlier contents of this file (the per-category triage of the gate's first run, with 148 errors on the static path and 37 of 93
Vega and 251 of 627 Vega-Lite passing, and the notes on each fix that closed them) are in git history of this path.
