# Changelog

## Unreleased

- **Conformance rigour**: added the scene-level differential (`pnpm scene-diff`,
  419/419) comparing resolved scale maps per scope, mark/item geometry/paint and
  overlap paint order against Vega's scenegraph (R8.1–R8.3). Both schema sweeps now
  have zero comparable differences: Vega 7,538/7,549 (8 both-refused, 3 oracle
  crashes) and Vega-Lite 27,418/27,513 (40 both-refused, 21 oracle refusals, 34
  pinned nondeterministic bootstrap aggregates). Closed identity scales, horizontal
  area baselines, fractional/negative view sizes, log/symlog NaN symbols, title
  anchors, rotated path bounds, clip-bound epsilons and scene paint order.

- **React interaction**: controlled/uncontrolled pan/zoom (`panZoom`, `view`,
  `onViewChange`, `maxZoom`) with wheel/drag/pinch/keyboard over scale `domainRaw`;
  unified `SelectValue` (`selection`/`onSelectionChange`) alongside the existing
  interval and point callbacks; `ChartHandle` imperative ref.
- **Signals**: `signal.on` now updates through `useSyncExternalStore` (one normal React
  state transition) and re-renders dependent marks; `setSignal` available on the ref.
- **Accessibility**: `buildA11yTree` + focusable `<Chart>` projection with captions,
  roles, selected state, dense-chart summary and adjustable continuous axes; keyboard
  navigation across marks/guides.
- **Vega-Lite input**: `<Chart>` and `useChart` compile Vega-Lite directly through
  `@aster/vl`; no `vega-lite` runtime dependency.
- **Async/SSR/worker**: `useSpecData`/`useChartData` (Suspense + `use()`),
  promise specs, `renderChartToStaticMarkup` + `hydrateChart`, and
  `useChartWorker` with a synchronous fallback.
- **Limits**: `maxTimeMs` wall-clock deadline checked across compile/evaluate/render
  and inside dataset/encode loops; `domainRaw` scale overrides in core.
- **Tooling**: per-entry bundle gates (core, dom, canvas, hit, signals, React);
  deterministic differential fuzzer with committed reproducers; nightly sweep
  workflow; tag-triggered release workflow with npm provenance.
- **Docs**: API, errors, limits, testing, fonts, performance, interaction and release
  guides; ADRs 0002–0004.

- Schema sweep: 27,418/27,513 cases match, **0 differ**; the remaining
  non-ok cases are 40 both-refused specs, 21 oracle refusals and 34 pinned
  nondeterministic `ci0`/`ci1` bootstrap cases.
- Closed sweep tails: guide-scale ranges/domains, facet header
  `labelOrient`/`orient`, config axis/header precedence, axis orient/grid
  geometry, label angle anchors, tick/label tails, `values` aggregate
  domains, size-legend grid layout, and `config.point` cross-block geometry.
- Vega transform parity: full `bin` step/anchor/base/divide/minstep/span/steps
  options and interval mode, full `window` ops/frames/ignorePeers/params,
  `joinaggregate.key`, and signal-valued `impute.keyvals`.
- React: `onPointSelect` click selection, `renderTooltip` React slot,
  `useChart` headless hook, canvas redraw scheduling on `requestAnimationFrame`.
- Core: typed `SpecLimits`/`AsterLimitError` budgets for untrusted specs.
- Added BSD-3-Clause license, contribution guide and third-party notices.
