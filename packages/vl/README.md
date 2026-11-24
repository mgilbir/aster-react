# @aster-charts/vl

A from-scratch Vega-Lite → Vega compiler verified against the vega-lite oracle by
rendering parity.

Install. Node 20 or newer;
no runtime dependencies and no peer dependencies (render the compiled spec with `@aster-charts/core`, or let `@aster-charts/react` compile it):

```bash
npm i @aster-charts/vl
```

Use it directly:

```ts
import { compile } from '@aster-charts/vl'

const vegaLiteSpec = {
  data: { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
}
const vegaSpec = compile(vegaLiteSpec) // a Vega spec; renderSpec(vegaSpec) from @aster-charts/core draws it
```

or let `<Chart>`/`useChart` do it by registering the add-on once:

```ts
import '@aster-charts/react/vl'
```

`@aster-charts/react` is Vega-only by default; the add-on is the opt-in boundary, mirroring `@aster-charts/core/dom` and
`@aster-charts/core/transforms` (its size is in [docs/PERFORMANCE.md](https://github.com/mgilbir/aster-react/blob/main/docs/PERFORMANCE.md#bundle-sizes)).

## Contract

For every Vega-Lite feature `compile` either produces Vega that renders like
vega-lite 6.4.3, or throws a `VLCompileError` naming the unsupported feature
(with the path in the spec, e.g. `encoding.x.scale.domain: ...`). It never
compiles a wrong chart silently, and it never mutates its input. The spec's
structure is copied; its rows (an inline `data.values`, the entries of `datasets`)
are not, and compiling one view over them reads none of them: it costs the same for 3 rows as for 6,000. Three
things do read rows, to share a dataset as vega-lite does: two views whose `data.values` are *distinct but equal*
arrays have their rows compared (passing the same array costs nothing), a `lookup` from anonymous inline rows reads
them, and an inline CSV / JSON text is compared as text; a large `params[].value` or `usermeta` is copied. (At
400,000 rows, measured on 2026-11-23: one unit 2.9 ms, two layers over equal distinct arrays 58 ms, four such
concat views 123 ms, a lookup from inline rows 100 ms, a 3.9 MB CSV text 20 ms, a 400,000-element parameter value
40 ms.) The compiled spec carries the caller's row objects, in arrays of its own,
as vega-lite does; nothing in Aster writes to them. Treat them as immutable too: to
change the data, pass new arrays (a chart that gets the same array again assumes
the same rows, so an in-place edit is seen only by what happens to re-evaluate; in
development builds `@aster-charts/react` and core's sessions warn when they see one,
see [Rows are treated as immutable](https://github.com/mgilbir/aster-react/blob/main/docs/API.md#rows-are-treated-as-immutable)).

A validation layer runs first and rejects unknown channels,
transform keys, composition nesting, params and selections, condition and sort
forms, time units, bin options, `resolve` values, config keys and mark-def keys.
Field names are escaped in one place wherever they enter
an expression or a generated dataset/signal/scale name.

## Supported

- Marks: arc, area, bar, boxplot, circle, errorband, errorbar, image, line, point, rect, rule,
  square, text, tick, trail. `errorbar` / `errorband` unfold into a layer of simple marks over one
  aggregate transform (extents `stderr`, `stdev`, `ci`, `iqr`, pre-aggregated bounds, `xError` /
  `yError`); `ci0` / `ci1` are emitted as Vega aggregate ops. `image` is laid out like a rect and
  takes the `url` channel (field or value).
- Composition: layer, hconcat, vconcat, concat, facet (row/column/wrap), repeat, with every nesting the
  Vega-Lite schema allows except those listed under "Throws"; `resolve` for scales, axes and legends; shared scales and legends.
- Sizing: numbers, `{"step": n}`, and `"container"` on a top-level unit or layer (vega-lite's
  containerSize signals and an autosize fit / fit-x / fit-y over the padding).
- Transforms: filter, calculate, bin, timeUnit, aggregate, joinaggregate, window, stack, fold,
  flatten, pivot, impute, lookup, sample, density, loess, regression, quantile, extent.
- Channels: x, y, x2, y2, xOffset, yOffset, xError(2), yError(2), theta, theta2, radius, radius2, color, fill,
  stroke, opacity, size, strokeWidth, shape, text, tooltip, href, url, description, detail, key, order,
  row, column, facet. `size` drives points, text (font size), lines, ticks, bars and trails (a constant, a field or
  conditions). Every channel takes a field of each type, a value, a datum and `scale: null` (the field read as it is);
  a channel the mark does not draw is dropped, as vega-lite drops it. An arc is centred by x / y and their offsets,
  a text placed by theta / radius around its x / y. Every mark x channel x
  definition is compared with vega-lite.
- `config.scale`: every key that reaches the output: band / bar / rect / tick padding, nested- and
  offset-band padding, `pointPadding`, `continuousPadding`, `round`, `clamp`, `zero`, `xReverse`,
  `useUnaggregatedDomain`, `minSize`/`maxSize`, `minBandSize`/`maxBandSize`, `minFontSize`/
  `maxFontSize`, `minStrokeWidth`/`maxStrokeWidth`, `minOpacity`/`maxOpacity`, `quantileCount`,
  `quantizeCount` and `invalid`. `scale.domain: "unaggregated"`, `scale.rangeMin` / `rangeMax`.
- `mark.invalid` (`filter`, `show`, `break-paths-filter-domains`, `break-paths-show-domains`,
  `break-paths-show-path-domains`, `null`) and `config.scale.invalid`.
- Custom format types (`formatType`, `config.customFormatTypes`, `numberFormatType`,
  `normalizedNumberFormatType`, `timeFormatType`): as vega-lite, a call of the expression function of that
  name (`price(datum["v"], "$.2f")`; axes and legends carry it in a labels encode). Register the function
  with `registerExpressionFunction` from `@aster-charts/core` (and with vega's `expressionFunction` for vega). A
  custom type is dropped, with its `format`, unless `customFormatTypes` is true (a facet header's is not).
- Explicit scale domains: arrays (numbers, strings, DateTime objects, `{expr}` / `{signal}` entries; a
  temporal field's become `{data: datetime(...)}` signals) with vega-lite's `zero` / `nice` rules, on
  position, size, opacity and colour scales. A domain that is neither an array nor `"unaggregated"` (`"Aa"`,
  a number, `true`) is emitted as written, as vega-lite does, and vega (and Aster's runtime) refuses it.
- Other config: `numberFormat`, `timeFormat`, `normalizedNumberFormat`, `countTitle`, `fieldTitle`,
  `aria`, `lineBreak`, `style`, `errorbar`, `errorband`, header / headerRow / headerColumn, legend,
  axis and mark blocks.
- Mark keys: `binSpacing`, `minBandSize`, `bandSize` (vega-lite ignores it too), `x2Offset`,
  `y2Offset`, `theta2Offset`, `radius2Offset`, `style`, `smooth`, `aspect`, `clip`, `aria`.
- Maps: `geoshape` marks over GeoJSON / TopoJSON
  (inline, `url`, or `sphere` / `graticule` generators) with `{type: "geojson"}` on `shape`; `projection`
  with every property and `config.projection`; `longitude` / `latitude` (and `longitude2` / `latitude2`) on
  point-like marks, text, line, trail and rule, layered over geoshapes. A longitude / latitude projects its raw field
  whatever else its definition says, as vega-lite does: an aggregate, a bin, a time unit, a sort array and the data type
  are read as on any other channel (a temporal type parses the field before it is projected), and a scale, an axis, a
  legend, a stack, an impute, a band or a pre-binned bin changes nothing. A unit fits its projection to its
  geoshape data unless it gives `scale` or `translate`; layer, concat and repeat children share one
  merged projection as vega-lite does. Vega's runtime computes the same projection as the Aster runtime,
  and the conformance corpus holds a case per feature.
- Animation: the `time` channel, driven by a `point` selection whose `on` is a
  timer (`"timer"`, `"timer{ms}"`, `{type: "timer"}`) and the `{filter: {param}}` transform; `mark.time`,
  `config.scale.framesPerSecond`. The signals, the `<main>_curr` frame dataset and the band `time` scale
  are vega-lite's. The first frame draws all the data (the store is empty), as in vega; the runtime ticks
  the clock with the same d3-timer schedule vega uses (see [docs/INTERACTION.md](https://github.com/mgilbir/aster-react/blob/main/docs/INTERACTION.md#signals)).
- Sort forms (arrays, `ascending`/`descending`, channel, `{field, op, order}`, `{encoding}`),
  conditions with `test` predicates (and/or/not, field predicates, DateTime values), time units
  (single, multi, `utc`, `step`), bin options, dotted/escaped/bracketed field names.

- Params and selections on a unit view, on the units of a layer, and on the units of a concat, hconcat, vconcat, facet or
  repeat view (linked brushing across views, a cross-view filter, a brush per facet cell or repeated view, a selection
  declared on the composition and given to every unit below it), as vega-lite 6.4.3 compiles them:
  point and interval selections; `fields`, `encodings`, `on`,
  `clear`, `toggle`, `nearest`, `resolve`, `mark`, `translate`, `zoom`, `value` (initial values, DateTimes
  included); `config.selection`; `bind` to inputs (`range`, `select`, `radio`, `checkbox`, ...), to the legend
  (`"legend"` or `{legend: stream}`) and to `"scales"` (pan and zoom through the scale domains); `{param}` conditions
  (`empty`) and predicates in `test`, `filter` (and, or, not) and `lookup.from`; `scale.domain` as `{param}` /
  `{unionWith}`; variable parameters (`value`, `expr`, `bind`, `react`). Projections over a bin or a time unit work as
  in vega-lite. A selection's state is its `<name>_store` dataset and the `<name>` signal, exactly as in vega-lite.
  `nearest` needs the transforms add-on (`import '@aster-charts/core/transforms'`) for its voronoi cells. The interaction
  needs the signal event loop (`<Chart>`, or `<SvgChart interaction>`): see [docs/INTERACTION.md](https://github.com/mgilbir/aster-react/blob/main/docs/INTERACTION.md). In a composition a unit's
  signals are its group mark's (a Vega group scope: one copy per view or facet cell, `push: "outer"` for the signals that
  feed a bound scale, the `facet` signal in a facet's cells), and the named selection, its store and `unit` stay at the root.

## Throws (not supported)

Everything below throws a `VLCompileError` naming the feature and its path; nothing is silently
ignored. Three refusals are general, and name what they refuse by path rather than by feature:

- **A value the Vega-Lite schema does not allow where it stands** (a wrong type, `null` where vega-lite reads "unset",
  a name that is not one of the schema's, a missing required property, an unknown property in the `config`): it is
  refused as `<path>: must be ... (Vega-Lite 6.4.3 schema)`, checked against a table generated from vega-lite 6.4.3's
  JSON schema at build time. vega-lite reads such a spec in ways its schema does not describe, so there is no contract to
  match. The few forms vega-lite reads beyond its schema that Aster draws as vega-lite does (a facet over a repeat or a
  concat, `stack: "wiggle"`, a Vega `{"signal"}` in a scale domain ...) are listed, each with the test that pins it, in
  `scripts/schema-table.mjs` (`EXTENSIONS`). An `{"expr"}` object is an expression only where the schema takes an
  ExprRef; anywhere else (a lookup `default`, an impute `value`, a parameter `value`) it is the literal object it is.
- **A property the compiler does not read.** Every property of the spec has to be read by the compile, or be one
  vega-lite itself ignores (each such rule is pinned against vega-lite by a test); any other is refused at the end of
  the compile as `<path>: is valid Vega-Lite but @aster-charts/vl does not implement it here, so it would be ignored`.
  So a feature the list below does not name is either compiled to what vega-lite draws, or refused by this message.
- **Names that collide in the compiled Vega**: a parameter named as a name the compiler makes (`unit` beside a
  selection, `x_step`), one selection name in two layers, two views of one `name`. Vega refuses the output (as it
  refuses vega-lite's), so the compile does, naming the duplicate.

The list below is the features refused by name, each checked by `test/readme-refusals.test.ts` against the build
(the spec is refused, and for that reason).

- Params and selections that vega-lite itself compiles to a Vega spec that Vega rejects or that has no well-defined meaning:
  on a layer spec itself, or on a concat / facet / repeat that has a layer or a composite mark (boxplot, errorbar,
  errorband) below it (vega-lite gives every unit a copy of the selection's signals, and the layers would declare them
  twice in one Vega scope), on a composition whose units have params of their own (vega-lite replaces a unit's
  parameters with the inherited ones), and with `views` (restricting a composition's selection to some of its views).
  Also: `bin.extent` as anything but a `[min, max]` pair or a `{param}` reference; a lookup from a selection of the same
  unit or of a later layer; `scale.domain.unionWith` in a layered spec; a parameter's `push`.
- Maps: a geoshape without a GeoJSON `shape` field inside a facet (vega-lite 6.4.3 fits the projection to
  `data("child_main")`, a dataset it never defines, so there is no output to match). Longitude / latitude
  positions on marks other than point, circle, square, text, line, trail and rule. What vega cannot run of vega-lite
  6.4.3's output: a half pair (only `longitude`, or one of a pair given as a value or a condition alone), and a
  longitude / latitude that is a count of records (`aggregate: "count"` with no field), both of which vega-lite
  projects with a geopoint transform that reads no field; a longitude / latitude datum that is not a number, which
  vega-lite writes into the geopoint transform as an expression vega cannot parse.
- Animation outside the one shape vega-lite 6.4.3 compiles to working output: a `time` channel needs a single
  top-level unit with exactly one timer selection and the `{filter: {param}}` transform (without them vega-lite
  emits marks that read a dataset it never defines); layers, concats, facets, composite marks
  (boxplot / errorbar / errorband) and point / line overlays are refused, as are `bind` / `value` on the timer
  selection.
- Bins and time units: `timeUnit.maxbins`, errorbar / errorband over a binned channel, and the
  `timeUnitBandPosition` / `timeUnitBandSize` mark keys.
- Channel definitions vega-lite 6.4.3 compiles that are not implemented yet: a `datum`
  condition on fillOpacity, strokeOpacity, angle, text or tooltip; an array of conditions that holds a field condition; `impute` or
  pre-binned data (`binned`) on a channel other than x and y (and longitude / latitude, where vega-lite ignores
  them); the `geojson` type on a channel other than shape, and
  a GeoJSON shape on any other mark.
- Positions: a condition that gives a field or a datum on a position channel (x, y, x2, y2, xOffset, yOffset, theta,
  theta2, radius, radius2, longitude, latitude and their ends). The Vega-Lite schema gives a position no condition, and
  vega-lite 6.4.3 makes a scale, an axis and a stack group of the condition's field while it places the mark by the
  value, so there is no coherent output to match. (A condition with a value is read as its value, as vega-lite
  reads it; on a channel the mark does not draw the condition is dropped with the channel.)
- Scales and encodings: channel-level `band` (except on longitude / latitude, where vega-lite ignores it); the positional mark-def constants `x` / `x2` / `y` / `y2`, except
  `x` / `y` on point, circle, square and text.
- Layout: `width` / `height: "container"` on a composition (only a top-level unit or layer), `data: null`, config keys
  outside the supported list, a wrapped facet (a single `facet` field) around or inside another facet, a selection or
  a map inside a facet inside a facet, independent x / y scales in a facet that holds another facet, a concat in a
  layer (the Vega-Lite schema forbids it), layer repeats combined with row / column, layers whose scales are
  incompatible or conflict, a facet of layers over different data, `argmax` / `argmin` as an op of a `window`
  transform, sort arrays of DateTime objects.
- Layer resolution where vega-lite 6.4.3's output is broken: independent x / y scales over layers sized
  differently (by steps, or by different widths / heights: vega-lite gives the view no size and draws nothing, or,
  in a nested layer, draws the layer past the view); `axis: null` on a layer after one that draws the axis
  (vega-lite crashes); a layer in a facet that keeps its own x / y scales unless the facet resolves them
  independent too (vega-lite reads a scale it never defines).
- Names that are members of Object.prototype (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__` ...) as
  a field, a dataset, a transform's output or a parameter. Vega keeps names in plain objects and mistakes these for the
  prototype's members, so vega-lite 6.4.3's chart of them fails in Vega or draws without them (an aggregate of nothing, a
  time unit of nothing, a legend or description that leaves the field out). They are refused by name, except where
  vega-lite's chart is the chart of any other name: a field only a fold, a bin transform, a stack transform, a pivot, a
  density or a quantile reads, a binned x / y / colour, `x2`, and a parameter (all but `__proto__`); each place is held to
  vega-lite for every member by `vl-prototype-names.test.ts` (conformance).

## Where it matches vega-lite on purpose, rather than the specification

- **UTC time units in filter predicates are read in local time.** A field predicate with a `utc*` time unit (`utcmonth`,
  `{unit: "month", utc: true}`, ...) cuts the field with the local-time functions (`month(datum.t)`, not `utcmonth(datum.t)`) and
  compares a bare number or name as that part of a local date, which is what vega-lite 6.4.3 compiles (its source marks it
  `TODO: support utc`). So a filter keeps the same rows as vega-lite in every zone. (The `timeUnit` transform and the encodings do
  read a UTC unit in UTC.) A `utc: true` DateTime *value* is still read in UTC.

## Known compiler gaps outside the gallery

No gallery spec exercises these, so the gallery gate cannot see them. Each was reproduced against vega-lite 6.4.3 on 2026-11-06.

- **A discrete `x` with `sort: "descending"` and an `x2` on another field** (`x: {field: "a", type: "nominal", sort: "descending"}`,
  `x2: {field: "c"}`) renders a different SVG from vega-lite's (the earlier triage put the cause in the union of
  the two domains, which needs the raw dataset's sort). The same spec with no `sort`, or `sort: "ascending"`, matches.
- **Field names of `geopoint` outputs** in a unit inside a `concat` or a `facet` stay `x` and `y`, where vega-lite writes
  `concat_0_x` / `child_x`. No render differs; the names show only in the compiled Vega.

## Known runtime gaps (Aster, not the compiler)

None are recorded: real vega renders our output identically to vega-lite's for the
whole conformance corpus, and Aster's runtime renders both.

Working on the compiler? See [packages/vl/CONTRIBUTING.md](https://github.com/mgilbir/aster-react/blob/main/packages/vl/CONTRIBUTING.md): where each part of the contract is implemented and tested.
