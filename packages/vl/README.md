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

## Throws (not supported)

Everything below throws a `VLCompileError` naming the feature and its path; nothing is silently
ignored.

- Params and selections: any `param` predicate or condition, `empty`, `push`, selection `value` and
  `bind`, non-interval selections, interval selection options (a plain interval renders as its
  static brush marks); `scale.domain` objects (`{param}`, `{unionWith}`) and `domainRaw`; parameter
  references in `bin.extent`; lookups from a selection.
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
  the view `background` property, data generators
  (`sequence`, `sphere`, `graticule`) and `data: null`, config keys outside the supported list,
  nestings outside `SUPPORTED_NESTING` (for example a facet in a concat), layer repeats combined
  with row / column, layers whose scales are incompatible or conflict, a facet of layers over
  different data, horizontal boxplots, `argmax` / `argmin` in sorts and window transforms,
  `regression` `params: true`, key-value `keyvals` ranges, sort arrays of DateTime objects.

## Known runtime gaps (Aster, not the compiler)

None are recorded: real vega renders our output identically to vega-lite's for the
whole corpus, and Aster's runtime renders both, so `packages/conformance/corpus-vega-only`
(where a spec lives while Aster cannot yet render vega-lite's output for it, held to the
real-vega check only) is empty. A new gap is recorded there, with its measured root cause.
