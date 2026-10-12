# Architecture decision records

One record per decision, in the siblings' format: the context, the decision, and what
it costs. Records are immutable once accepted; a decision that changes gets a new
record that supersedes the old one, and the old record's `Status` points at it.

| Record | Decision |
|---|---|
| [0001-own-the-engine](0001-own-the-engine.md) | The runtime reimplements the Vega/D3 stack; upstream packages are the test oracle only. Introduces the oracle-vector method and the dependency-boundary ratchet. |
