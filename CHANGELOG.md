# Changelog

## Unreleased

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
