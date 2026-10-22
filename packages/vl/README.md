# @aster/vl

A from-scratch Vega-Lite → Vega compiler verified against the vega-lite oracle by
rendering parity.

Use it directly:

```ts
import { compile } from '@aster/vl'
const vegaSpec = compile(vegaLiteSpec)
```

or let `<Chart>`/`useChart` do it by registering the addon once:

```ts
import '@aster/react/vl'
```

`@aster/react` is Vega-only by default (the compiler is ~45 kB gzip); the addon is
the opt-in boundary, mirroring `@aster/core/dom` and `@aster/core/transforms`.

## Contract

For every Vega-Lite feature `compile` either produces Vega that renders like
vega-lite 6.4.3, or throws a `VLCompileError` naming the unsupported feature
(with the path in the spec, e.g. `encoding.x.scale.domain: ...`). It never
compiles a wrong chart silently, and it never mutates its input (the spec is
cloned; tests deep-freeze every corpus spec).

A validation layer (`src/validate.ts`) runs first and rejects unknown channels,
transform keys, composition nesting, params and selections, condition and sort
forms, time units, bin options, `resolve` values, config keys and mark-def keys.
Field names go through one escaping helper (`src/names.ts`) wherever they enter
an expression or a generated dataset/signal/scale name.

## Supported

- Marks: arc, area, bar, boxplot, circle, line, point, rect, rule, square, text,
  tick, trail.
- Composition: layer, hconcat, vconcat, concat, facet (row/column/wrap), repeat,
  with the nestings listed in `SUPPORTED_NESTING`; `resolve` for scales, axes
  and legends; shared scales and merged legends.
- Transforms: filter, calculate, bin, timeUnit, aggregate, joinaggregate,
  window, stack, fold, flatten, pivot, impute, lookup, sample, density, loess,
  regression, quantile, extent.
- Channels: x, y, x2, y2, xOffset, yOffset, theta, radius, color, fill, stroke,
  opacity, fillOpacity, strokeOpacity, strokeWidth, strokeDash, size, angle,
  shape, text, tooltip, href, description, detail, order, row, column, facet.
- Sort forms (arrays, `ascending`/`descending`, channel, `{field, op, order}`,
  `{encoding}`), conditions with `test` predicates (and/or/not, field
  predicates, DateTime values), time units (single, multi, `utc`, `step`),
  bin options (`maxbins`, `step`, `steps`, `extent`, `nice`, `base`, `divide`,
  `minstep`), dotted/escaped/bracketed field names.

## Throws (not supported)

Image, geoshape, errorbar and errorband marks; projections and geo fields;
selection/param predicates and conditions, selection bindings and any selection
other than a plain static `interval`; `bin: "binned"`; `timeUnit.maxbins`;
`scale: null`, identity scales, `domainRaw`, `rangeMin/Max`, `domain` objects;
channel `impute`, `band`, `formatType`, and `{type: "geojson"}`; the channels
xError(2), yError(2), latitude/longitude, radius2/theta2 on non-arcs, url, key,
time; `width/height: "container"`; data generators and `data: null`; custom mark
`style`, `invalid`, `bandSize`, `smooth`; layer scale-type conflicts that
vega-lite would make independent; facets of layers over different data;
horizontal boxplots. Nestings outside `SUPPORTED_NESTING` (for example a facet
of a concat) are valid Vega-Lite but throw.

## Known runtime gaps (Aster, not the compiler)

Real vega renders our output identically to vega-lite's for the whole corpus.
Aster's own runtime cannot yet render vega-lite's output for some shapes
(wrapped facets, grid/nested layouts, dotted-field formulas, UTC time-unit
labels, stacked bars with `cornerRadius`); those specs live in
`packages/conformance/corpus-vega-only` and are held to the real-vega check only.
