# @aster/vl

A from-scratch Vega-Lite → Vega compiler verified against the vega-lite oracle by
rendering parity.

Use it directly:

```ts
import { compile } from '@aster/vl'

const vegaLiteSpec = {
  data: { values: [{ a: 'A', b: 28 }, { a: 'B', b: 55 }] },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
}
const vegaSpec = compile(vegaLiteSpec) // a Vega spec; renderSpec(vegaSpec) from @aster/core draws it
```

or let `<Chart>`/`useChart` do it by registering the addon once:

```ts
import '@aster/react/vl'
```

`@aster/react` is Vega-only by default; the addon is the opt-in boundary, mirroring `@aster/core/dom` and
`@aster/core/transforms` (its size is in `docs/PERFORMANCE.md`).

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

- Marks: arc, area, bar, boxplot, circle, errorband, errorbar, image, line, point, rect, rule,
  square, text, tick, trail. `errorbar` / `errorband` unfold into a layer of simple marks over one
  aggregate transform (extents `stderr`, `stdev`, `ci`, `iqr`, pre-aggregated bounds, `xError` /
  `yError`); `ci0` / `ci1` are emitted as Vega aggregate ops. `image` is laid out like a rect and
  takes the `url` channel (field or value).
- Composition: layer, hconcat, vconcat, concat, facet (row/column/wrap), repeat, with the nestings
  listed in `SUPPORTED_NESTING`; `resolve` for scales, axes and legends; shared scales and legends.
- Sizing: numbers, `{"step": n}`, and `"container"` on a top-level unit or layer (vega-lite's
  containerSize signals and an autosize fit / fit-x / fit-y over the padding).
- Transforms: filter, calculate, bin, timeUnit, aggregate, joinaggregate, window, stack, fold,
  flatten, pivot, impute, lookup, sample, density, loess, regression, quantile, extent.
- Channels: x, y, x2, y2, xOffset, yOffset, xError(2), yError(2), theta, radius, color, fill,
  stroke, opacity, size, strokeWidth, shape, text, tooltip, href, url, description, detail, order,
  row, column, facet. `size` drives points, text (font size), lines, ticks, bars and trails.
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
  with `registerExpressionFunction` from `@aster/core` (and with vega's `expressionFunction` for vega). A
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
- Sort forms (arrays, `ascending`/`descending`, channel, `{field, op, order}`, `{encoding}`),
  conditions with `test` predicates (and/or/not, field predicates, DateTime values), time units
  (single, multi, `utc`, `step`), bin options, dotted/escaped/bracketed field names.

- Params and selections on a unit view, on the units of a layer, and on the units of a concat, hconcat, vconcat, facet or
  repeat view (linked brushing across views, a cross-view filter, a brush per facet cell or repeated view, a selection
  declared on the composition and given to every unit below it), as vega-lite 6.4.3 compiles them
  (`src/selection.ts` ports `compile/selection/*`): point and interval selections; `fields`, `encodings`, `on`,
  `clear`, `toggle`, `nearest`, `resolve`, `mark`, `translate`, `zoom`, `value` (initial values, DateTimes
  included); `config.selection`; `bind` to inputs (`range`, `select`, `radio`, `checkbox`, ...), to the legend
  (`"legend"` or `{legend: stream}`) and to `"scales"` (pan and zoom through the scale domains); `{param}` conditions
  (`empty`) and predicates in `test`, `filter` (and, or, not) and `lookup.from`; `scale.domain` as `{param}` /
  `{unionWith}`; variable parameters (`value`, `expr`, `bind`, `react`). Projections over a bin or a time unit work as
  in vega-lite. A selection's state is its `<name>_store` dataset and the `<name>` signal, exactly as in vega-lite.
  `nearest` needs the transforms addon (`import '@aster/core/transforms'`) for its voronoi cells. The interaction
  needs the signal event loop (`<Chart>`, or `<SvgChart interaction>`): see docs/INTERACTION.md. In a composition a unit's
  signals are its group mark's (a Vega group scope: one copy per view or facet cell, `push: "outer"` for the signals that
  feed a bound scale, the `facet` signal in a facet's cells), and the named selection, its store and `unit` stay at the root.

## Throws (not supported)

Everything below throws a `VLCompileError` naming the feature and its path; nothing is silently
ignored.

- Params and selections that vega-lite itself compiles to a Vega spec that Vega rejects or that has no well-defined meaning:
  on a layer spec itself, or on a concat / facet / repeat that has a layer or a composite mark (boxplot, errorbar,
  errorband) below it (vega-lite gives every unit a copy of the selection's signals, and the layers would declare them
  twice in one Vega scope), on a composition whose units have params of their own (vega-lite replaces a unit's
  parameters with the inherited ones), with `views` (restricting a composition's selection to some of its views), on a
  named view, or on a path mark with an overlay (`mark.point` / `mark.line`: write the layers). Also: timer event streams
  (animation); `bin.extent` as a parameter; a lookup from a selection of the same unit or of a later layer;
  `scale.domain.unionWith` in a layered spec; a parameter's `push`.
- Maps: `geoshape` marks, `projection`, `latitude` / `longitude` channels, `{type: "geojson"}`.
- Animation: the `time` channel (`mark.time` and `config.scale.framesPerSecond` / `animationDuration` are accepted: without a `time` channel they change nothing in vega-lite either).
- Data-driven channels without a scale / legend implementation yet: `strokeDash`, `angle`,
  `fillOpacity`, `strokeOpacity` (constants and conditions work); `key`.
- Bins and time units: `bin: "binned"` / `binned: true` (pre-binned data), `timeUnit.maxbins`,
  `timeUnit.binned`, a bin or time-unit on a text / tooltip / href channel, errorbar / errorband over
  a binned channel or with argmin / argmax; `timeUnitBandPosition` / `timeUnitBandSize` mark keys.
- Scales and encodings: `scale: null`, channel-level `impute` and `band`,
  `size` constants or conditions on bars and ticks (a size *field* works), `x`/`y`/`x2`/`y2`/
  `theta`/`theta2`/`radius2` mark-def constants.
- Layout: `width` / `height: "container"` on a composition (only a top-level unit or layer),
  data generators (`sequence`, `sphere`, `graticule`) and `data: null`, config keys outside the
  supported list, nestings outside `SUPPORTED_NESTING` (a facet inside a facet, a concat inside a
  layer: the Vega-Lite schema forbids both), layer repeats combined with row / column, layers
  whose scales are incompatible or conflict, a facet of layers over different data, horizontal
  boxplots, `argmax` / `argmin` as an op of an `aggregate` or `window` transform (and as a channel
  aggregate of a composite mark), `regression` `params: true`, key-value `keyvals` ranges, sort
  arrays of DateTime objects.

## Known runtime gaps (Aster, not the compiler)

None are recorded: real vega renders our output identically to vega-lite's for the
whole corpus, and Aster's runtime renders both, so `packages/conformance/corpus-vega-only`
(where a spec lives while Aster cannot yet render vega-lite's output for it, held to the
real-vega check only) is empty. A new gap is recorded there, with its measured root cause.
