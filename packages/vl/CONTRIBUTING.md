# Working on `@aster/vl`

This page is for people who change the compiler. It is not part of the published package: the npm page is [README.md](README.md),
which states the contract (what compiles, what throws). The repository-wide workflow is [CONTRIBUTING.md](../../CONTRIBUTING.md); how
to debug a failing conformance case end to end is in [docs/RUNBOOK.md](../../docs/RUNBOOK.md).

## Where the contract is implemented

| Contract in the README | Source (`packages/vl/src`) |
|---|---|
| `compile` never mutates its input | `compile.ts` clones the spec once, up front; every later edit lands on the private copy |
| Unsupported or invalid input throws a `VLCompileError` naming the feature and its path | `validate.ts`: allow-lists derived from one table each, shared message templates; it runs before anything is compiled |
| Composition nesting | `SUPPORTED_NESTING` in `validate.ts` (parent kind to the child kinds that are implemented; today it equals the schema's `SCHEMA_CHILDREN`; the nestings the compiler still refuses are individual checks listed under "Throws") |
| Field names never reach an expression or a generated name unescaped | `names.ts`: every place that lets a user-supplied field name into an expression string, a generated field name or a signal name goes through it |
| Marks and channels | `compile.ts` (the unit compiler), `channels.ts` (which marks draw which channels), `orient.ts`, `scaletype.ts`, `scaleprops.ts`, `scaleconfig.ts`, `titles.ts` |
| Composite marks (boxplot, errorbar, errorband), overlays | `composite-marks.ts`, `composite.ts` |
| Composition (concat, repeat, facet) | `embed.ts` renames every child-local scale, signal and dataset so siblings cannot collide, including names inside expression strings |
| Transforms, predicates, time units | `transforms.ts`, `predicate.ts`, `timeunit.ts` |
| Selections | `selection.ts` (the parameter resolved against its unit), `selection-model.ts`, `selection-signals.ts`, `selection-marks.ts`; event selector strings: `event-selector.ts` |
| Maps | `geo.ts`, a port of vega-lite's `compile/projection` with the `geojson` / `geopoint` data nodes and the `geoshape` post-encoding transform |
| Animation | `animation.ts`: the `time` channel, the timer selection and the `{filter: {param}}` transform |
| Dataflow optimizations vega-lite runs over the whole spec | `optimize.ts` |

## Where it is tested

- Unit tests in `packages/vl/test/`: `validate.test.ts` (refusals), `names.test.ts` (hostile field names), `immutability.test.ts`
  (compiles a deep-frozen copy of every corpus spec, from `corpus/` and `corpus-vega-only/`, so a mutation throws), `structure.test.ts`,
  `selection-composites.test.ts`, `geo.test.ts`, `animation.test.ts` and the rest.
- `readme-refusals.test.ts` reads the "Throws (not supported)" list of [README.md](README.md) (the text between `## Throws (not supported)` and
  `## Known runtime gaps`). Every feature it names must be refused by `compile` with a `VLCompileError`, and the features that used to be on
  the list must not be. To change the list, change the README and the table in the test together; keep both headings.
- Parity against the real vega-lite lives in the conformance package, not here: `packages/conformance/test/vl-mark-channels.test.ts` compiles
  every mark x channel x definition (`vl-mark-channels-space.ts`) with vega-lite 6.4.3 and with `@aster/vl` and compares the compiled
  scales, axes and legends, the rows and the SVG; `vl-predicate.tz.test.ts` compares the rows and expressions of every predicate form, including
  every UTC time unit read in local time, under the zones of `pnpm test:tz`; the `vlx-geo-*` specs of `packages/conformance/corpus` hold a case
  per map feature. `pnpm conformance-vl` renders the whole Vega-Lite corpus through vega-lite and through `@aster/vl` and compares both.
- `packages/conformance/corpus-vega-only` is where a Vega-Lite spec would live while the Aster runtime cannot yet render vega-lite's own Vega for it
  (it is held to the real-vega check only). It is empty today; its README says how to record a case.
