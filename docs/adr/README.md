# Architecture decision records

One record per decision, in the siblings' format: the context, the decision, and what
it costs (the later records also name the code and tests that implement it).

Records are amended in place. When the code moves away from what a record says but the
decision stands, the record gets a dated entry under `## Amendments` saying what changed
("*2026-10-23, to match the code.*") and the text it replaces is corrected or marked
superseded there. Only a decision that is reversed gets a new record that supersedes the
old one, and the old record's `Status` then points at it. History is in git.

| Record | Decision |
|---|---|
| [0001-own-the-engine](0001-own-the-engine.md) | The runtime reimplements the Vega/D3 stack; upstream packages are the test oracle only. Introduces the oracle-vector method and the dependency-boundary ratchet. |
| [0002-interaction-as-react-state](0002-interaction-as-react-state.md) | Selection and pan/zoom are React values over `domainRaw`; signals use `useSyncExternalStore`; hit testing is scene-based. |
| [0003-ssr-async-worker](0003-ssr-async-worker.md) | Full-SVG SSR, DOM-patcher hydration, Suspense/`use()` data, and an optional symmetric worker path. |
| [0004-release-and-provenance](0004-release-and-provenance.md) | Publish core/react/vl with lockstep versions, npm provenance and per-entry bundle gates. |
| [0005-signal-write-is-a-fresh-render](0005-signal-write-is-a-fresh-render.md) | A signal written into a running chart renders what a fresh chart renders; Vega's retained-state cases are counted as `retained` under a ceiling. |
| [0006-injected-random-source](0006-injected-random-source.md) | Randomness is injected per evaluation (`RuntimeInput.random`, replayed per site) or seeded by the engine, never ambient. |
| [0007-svgchart-shell-over-lazy-loading](0007-svgchart-shell-over-lazy-loading.md) | `<Chart>` and `<SvgChart>` are thin shells over one `ChartCore` with injected capabilities, instead of lazy-loading inside `<Chart>`. |
| [0008-addons-load-themselves-through-suspense](0008-addons-load-themselves-through-suspense.md) | Add-ons a spec needs load on demand behind a Suspense wait; `url` data is never fetched on its own. |
| [0009-live-differentials-over-recorded-vectors](0009-live-differentials-over-recorded-vectors.md) | Engine-sensitive ports are verified by live same-process differentials; recordings stay only where they hold. |
| [0010-limits-best-effort-worker-is-the-guarantee](0010-limits-best-effort-worker-is-the-guarantee.md) | `limits` are cooperative best-effort budgets; for untrusted specs a killable worker is the guarantee. |
