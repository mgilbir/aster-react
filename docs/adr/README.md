# Architecture decision records

One record per decision, in the siblings' format: the context, the decision, and what
it costs. Records are immutable once accepted; a decision that changes gets a new
record that supersedes the old one, and the old record's `Status` points at it.

| Record | Decision |
|---|---|
| [0001-own-the-engine](0001-own-the-engine.md) | The runtime reimplements the Vega/D3 stack; upstream packages are the test oracle only. Introduces the oracle-vector method and the dependency-boundary ratchet. |
| [0002-interaction-as-react-state](0002-interaction-as-react-state.md) | Selection and pan/zoom are React values over `domainRaw`; signals use `useSyncExternalStore`; hit testing is scene-based. |
| [0003-ssr-async-worker](0003-ssr-async-worker.md) | Full-SVG SSR, DOM-patcher hydration, Suspense/`use()` data, and an optional symmetric worker path. |
| [0004-release-and-provenance](0004-release-and-provenance.md) | Publish core/react/vl with lockstep versions, npm provenance and per-entry bundle gates. |
