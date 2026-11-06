# ADR 0008: Add-ons load themselves through Suspense; data never does

Date: 2026-11-06
Status: Accepted (records a decision already in force)

## Context

The Vega features that cost bundle size live in opt-in add-ons that the `@aster/core` barrel does
not reach: `@aster/core/transforms`, `/geo` and `/load`. A host that knows its specs imports the
add-ons it needs. A host that renders specs it does not know would otherwise get an error telling
it what to import, and the engine itself is synchronous, so it cannot wait for a module.

## Decision

1. `@aster/core/addons` reads a spec's structure (no evaluation) and says which add-ons it needs
   (`addonsNeeded`); `loadAddons` imports exactly those, each at most once. An add-on the app
   already imported is recognised by what it registered and not imported again.
2. In React the wait is a Suspense wait (`React.use`), the same one an async `spec` and
   `useSpecData` use. `<Chart>`, `<SvgChart>`, `useChart`, the stream components and the worker
   hooks suspend until the add-ons are there. There is no intermediate render, so no flash of an
   error or of a half-drawn chart. A spec that needs nothing, and an app that imported the add-on
   itself, never suspend.
3. A failed import is an ordinary chart error, reported through `onError`, and is remembered for
   the page's lifetime so that React's retry asks for a promise that settles.
4. The synchronous entry points (`renderSpec`, `renderChartToStaticMarkup`, `hydrateChart`) cannot
   wait and keep the actionable error; `loadAddonsFor(spec)` is the awaitable step for them.
5. Data is never fetched on its own. A `url` dataset is resolved by `loadSpecData` or
   `useSpecData` under the host's URL policy; only the readers for its format load by themselves.
6. The Vega-Lite compiler stays an explicit import (`@aster/react/vl`).

## Consequences

- A spec renders with nothing imported, and bundlers split the add-ons into chunks fetched on
  demand. The bundle budget counts what loads up front.
- A chart can suspend, so an app that wants a fallback wraps it in `<Suspense>`. Under
  `renderToString` the fallback is rendered and the client renders the chart;
  `renderToPipeableStream` and `renderToReadableStream` wait for the import.
- The detector is a second reading of the spec, so it must agree with the engine; a missing add-on
  would be a wrong error, an extra one a wasted download.
- Keeping `url` data out of auto-loading keeps a fetch the host's decision.

## Where it is implemented and held

- `packages/core/src/addons.ts`: `addonsNeeded`, `loadAddons`, `TRANSFORMS_ADDON_TYPES`.
- `packages/react/src/addons.ts`: `useAddons`, the Suspense wait and the remembered failure.
- `packages/conformance/src/addons-needed.test.ts`: the detector names exactly the add-ons the
  engine asks for, over every corpus spec, and a render with just those equals a render with all.
- `packages/react/src/Chart.autoload.test.tsx`, `Chart.autoload.errors.test.tsx`,
  `Chart.autoload.ssr.test.tsx`, `Chart.autoload.static.test.tsx`,
  `useChart.autoload.test.tsx`, `worker.autoload.test.tsx`: the React, SSR and worker behaviour
  above.
- How it works in detail: [ARCHITECTURE.md](../ARCHITECTURE.md#geo-projections--the-addon-boundary).
