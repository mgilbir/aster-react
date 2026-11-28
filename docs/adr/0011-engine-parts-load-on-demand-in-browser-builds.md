# ADR 0011: Engine parts load on demand in a browser build; the first paint is synchronous only where nothing needs loading

Date: 2026-11-25
Status: Accepted (records a decision in force since 0.4.0; it reverses the rationale of [ADR 0007](0007-svgchart-shell-over-lazy-loading.md)
that "nothing loads asynchronously, so the first paint is synchronous")

## Context

Most charts never run most of the engine: the aggregating, window and reshaping transforms, the calendar and time formats, the
curves besides `linear`, colours, the scale types besides the common ones, the legend builder, grid layouts, vega-selections, the
regular-expression screen, the pulse path of the incremental engine, and the canvas renderer and the signal loop. A React app that
renders a bar chart paid for all of them, and ADR 0004's per-entry bundle budget had nothing to say about it, because the engine was
one synchronous module graph. ADR 0008 had already accepted that a chart may wait for an add-on (Suspense), and ADR 0007's amendment
(2026-11-23) had to concede that "nothing loads asynchronously" no longer held. This record is the decision those two point at.

## Decision

1. **Parts are slots.** A module of the engine that only some specs read is a *part* (`packages/core/src/engine-parts.ts`: `part(name)`
   reads a slot, `installPart` fills it). Reading an empty slot throws, never draws differently, so a missed detection refuses a chart
   instead of drawing it wrong.
2. **Two engines from one source.** `@aster-charts/core` and every synchronous entry (`/dom`, `/signals`, `/hit`, `/canvas`, `/png`)
   import the parts that their functions can read, so `renderSpec`, `createChartSession().evaluate`, `renderChartToStaticMarkup`
   and `hydrateChart` draw every spec with nothing to load. `@aster-charts/core/internal` and `/lean/*` are the same functions with the
   slots empty; the React shells import them. The `exports` map resolves them by condition: under `browser` to the lean modules,
   anywhere else (`default`: a server, a test runner) to `lean-full.js`, which fills every slot.
3. **What a chart needs is read, then loaded, behind the Suspense wait of ADR 0008.** `specNeeds(spec, { limits, random })`
   (`packages/core/src/addons.ts`) names the add-ons and the parts a spec may read, conservatively (a name it cannot read from the
   spec names the whole family); `useAddons` loads them and the chart suspends meanwhile. The canvas renderer
   (`renderer="canvas"`) and the signal loop are parts too, loaded by the capabilities the shells carry.
4. **Ways to have no wait.** `import '@aster-charts/react/all'` puts every part in the bundle and in its slot before the first
   render; `preloadParts(names?)` fetches parts ahead of time without bundling them; a server render needs nothing (decision 2).
5. **The shells and the worker.** `<Chart>`, `<SvgChart>`, `useChart`, `useChartStream` and `<ChartStream>` import the lean engine.
   The worker shells (`<ChartWorkerStream>`, `useChartWorkerStream`, `@aster-charts/react/worker`) run the whole synchronous engine,
   in the worker and in their in-realm fallback, so they import the `@aster-charts/core` barrel; they are separate modules from
   `<ChartStream>` so that importing one does not carry the other (audit C82).

## Consequences

- **The first paint is synchronous only where nothing needs loading.** A browser build of a chart that needs a part suspends once, the
  first time any chart on the page needs it: with a `<Suspense>` boundary the fallback shows, and without one the new root commits
  when the chart is ready. A chart that needs no part paints in its first commit. A server render, `renderToString` included, draws
  the chart (ADR 0003's decision 1 holds there).
- **"A browser build" means a resolver that applies the `browser` export condition**, not only a bundler: Node run with
  `--conditions=browser` and test runners that default to it (a jsdom Jest environment, edge or worker toolchains) get the lean
  modules with no bundling to fill the slots. For those, `import '@aster-charts/react/all'` or `await preloadParts()` before the
  first render is the remedy, and `renderToString` of a chart that needs a part renders the fallback.
- **The bundle budget has something to measure**: `<Chart>`, `<SvgChart>` and `useChart` count what loads up front, and the `Chart + all`
  row is what no wait costs (PERFORMANCE.md). The shaking gate asserts the split for `<Chart>` and `<ChartStream>` (patterns
  `react-lean`, `react-chartstream`, `react-lean-all`).
- **A detector that misses a part is a wrong error; one that over-names is a wasted download.** `packages/conformance/src/parts-needed.test.ts`
  checks the detector against the engine over the corpus and the galleries, with and without limits.
- **Two copies of the engine in one page would not share slots.** The packages are pinned to each other exactly for the same reason
  as for add-ons ([RELEASE.md](../RELEASE.md)).

## Where it is implemented and held

- `packages/core/src/engine-parts.ts`, `part-*.ts`, `parts-*.ts`, `lean*.ts`; `packages/react/src/addons.ts` (`useAddons`),
  `preload.ts`, `all.ts`.
- `packages/conformance/src/parts-needed.test.ts`, `packages/core/src/engine-parts.test.ts`.
- `scripts/check-bundle-shaking.mjs`: `react-lean` (a plain chart loads no part; a legend, a custom path, a canvas load theirs from
  chunks the entry does not contain), `react-lean-all`, `react-chartstream`.
- The mechanism in detail: [ARCHITECTURE.md](../ARCHITECTURE.md#the-parts-of-the-engine-most-charts-never-run).
