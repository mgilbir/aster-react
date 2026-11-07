# ADR 0007: `<SvgChart>` is a second shell over `ChartCore`, not a lazy-loaded `<Chart>`

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

`<Chart>` carries two heavy capabilities most pages do not need: the canvas renderer, and hit
testing with the signal event loop. Apps that only render an SVG chart want a smaller bundle.
There are two ways to give it to them: load the capabilities asynchronously inside `<Chart>`, or
ship a second component that never imports them.

## Decision

`@aster-charts/react` has one implementation, `ChartCore` (`packages/react/src/ChartCore.tsx`). It
receives its capabilities as injected values and never imports them. `<Chart>` and `<SvgChart>`
are shells that render `<ChartCore>`: `<Chart>` injects the canvas and interaction capabilities;
`<SvgChart>` (from `@aster-charts/react/lite`) injects none and passes through the `interaction` value its
caller imports from `@aster-charts/react/interaction`.

Lazy loading inside `<Chart>` was rejected. Nothing loads asynchronously, so the first paint is
synchronous and server-render-safe, and the cost of a capability is visible in the importing
code.

## Consequences

- An app that imports only `@aster-charts/react/lite` never reaches the canvas module, the hit index or
  the signal loop. `<SvgChart>` without `interaction` renders, and reports a missing event loop
  if the spec needs one.
- The split costs `<Chart>` about 0.7 kB gzip: property reads through the capability objects and
  the missing-capability report that only `<SvgChart>` can trigger.
- The shells must stay thin, or one would handle a prop the other forgets. A source-level guard
  limits what a shell may contain.
- Two component names to document, and a choice for the app to make
  ([INTERACTION.md](../INTERACTION.md#chart-or-svgchart)).
- This is separate from add-on auto-loading ([ADR 0008](0008-addons-load-themselves-through-suspense.md)),
  which is asynchronous by design but only for features a spec uses.

## Where it is implemented and held

- `packages/react/src/ChartCore.tsx`, `Chart.tsx`, `SvgChart.tsx`, `lite.ts`.
- `packages/react/src/Chart.shells.test.ts`: a shell renders only `<ChartCore>` (at most 14 code
  lines); the value import graph of `lite.ts` never reaches canvas, hit or signals, and the
  guard is shown to bite.
- `scripts/check-bundle-shaking.mjs`: bundles `@aster-charts/react/lite` and asserts the bundle holds no
  canvas, hit or signals code; `scripts/bundle-shaking.test.mjs` asserts the gate fails when the
  `sideEffects` fields are wrong.
- `packages/react/src/Chart.corpus-parity.test.tsx` (named in
  [TESTING.md](../TESTING.md)): the DOM of `<Chart>`, `<SvgChart>` and `<SvgChart interaction>`
  equal over the corpus.
- The shells and their cost: [ARCHITECTURE.md](../ARCHITECTURE.md#chartcore-and-the-two-shells).
