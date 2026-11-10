# Changelog

Version 0.1.0 is the first release. From 0.1.0 on, entries are added per release under Added, Changed
and Fixed, per package. Everything built before the first release is in [Pre-release history](#pre-release-history) below.

## Unreleased

### `@aster-charts/react`

#### Changed

- `tooltip` shows the hovered item's `tooltip` value, as Vega with vega-tooltip does (the Vega-Lite `tooltip` encoding with
  its titles and formats), and nothing for a mark without one. It used to list every field of the datum, including
  Vega-Lite's internal fields. To list a datum, encode `tooltip: { signal: "datum" }` (#129).
- `renderTooltip` receives a second argument, `{ tooltip, item }` (`TooltipInfo`): the item's `tooltip` value and the
  scene item (#129).

### `@aster-charts/core`

#### Fixed

- A spec that drives one view dimension itself keeps its other, numeric dimension when a host measures its container. A
  Vega-Lite spec with `width: "container", height: 200` in `<Chart>` grew on every measurement inside a block `<div>`
  with no height of its own, because the measured height replaced the 200 and the container grew with the chart (#128).

## 0.1.0 (2026-11-08): initial release

### `@aster-charts/core`

The rendering engine, with no runtime dependencies. It compiles, evaluates and renders a Vega spec to an SVG string (`renderSpec`)
or a scene, and reimplements the Vega and D3 pieces it needs (scales, formats, time, colors, geo, transforms, expressions) as its own
code; the real `vega` and `d3-*` packages are the test oracle only.

- Vega 6 specs, including nested group scopes, signals, guides (axes, legends, titles), layouts and the transform set, with Vega's
  error messages for specs it refuses.
- Optional entry points (add-ons) so a bundle pays only for what a spec uses: `/transforms`, `/geo`, `/load`, `/dom` (incremental DOM
  patcher and chart sessions), `/canvas`, `/hit` (hit testing), `/signals`, and `/addons` (which add-ons a spec needs, loaded on demand).
- Differential updates and streams: `createChartStream` with a bounded queue and backpressure policies, and pulses that re-evaluate
  only what changed.
- Accessibility: an accessible scene tree and guide captions.
- Budgets for untrusted specs: `limits` (`AsterLimitError`, a wall-clock `maxTimeMs`, row, item and size ceilings), best-effort by
  design; see [docs/LIMITS.md](docs/LIMITS.md).
- A URL policy for `loadSpecData` (http/https only, private hosts denied, timeouts and byte bounds).

### `@aster-charts/vl`

A from-scratch Vega-Lite compiler (`compile`: Vega-Lite spec to Vega spec) with no runtime dependency on `vega-lite`. It covers
the unit, layer, concat, facet and repeat views, parameters and selections, composite marks (`boxplot`, `errorbar`, `errorband`),
maps (`geoshape`, projections) and animation, and is checked against the real `vega-lite` compiler's output.

### `@aster-charts/react`

- `<Chart>` (SVG or canvas) and the headless `useChart` hook, for Vega specs; Vega-Lite is opt-in with `import '@aster-charts/react/vl'`.
- `<SvgChart>` from `@aster-charts/react/lite`, an SVG-only chart for a smaller bundle, and the `interaction` capability from
  `@aster-charts/react/interaction` that adds tooltips, point selection and `signal.on` streams to it.
- Interaction as React state: controlled or uncontrolled selection and pan/zoom, signal binds, tooltips, and keyboard navigation over
  the accessible scene tree.
- Data: `useSpecData` / `useChartData` (Suspense and `use()`), `dataChanges` for differential updates, and streaming components and hooks.
- Server and workers: `renderChartToStaticMarkup` with `hydrateChart`, and `useChartWorker` to move compile, evaluate and render into a Worker.

The public surface is in [docs/API.md](docs/API.md). Output is verified against real Vega and Vega-Lite by the gates in
[docs/TESTING.md](docs/TESTING.md).

## Pre-release history

Everything below was written during development, before the first release, as a log of what each change fixed or added. It is
reverse-chronological: the newest entries are first within each group, and the oldest are last. Entries are grouped by package or
topic and carry no dates, so an entry later in a group may be superseded by one earlier in it; a note that was true when written and no
longer is carries a **Superseded** marker. The counts, sizes and corpus totals in an entry are those of the build it was written
against. They are not current values; for the current ones see [README.md](README.md) and [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### `@aster-charts/core`

The engine: compiling and evaluating Vega specs, scales, geo, formats, guides, scenes, data loading and limits.

- **`@aster-charts/core`: a time axis keys its ticks by value, and a time scale reads a string as a number, as vega does.** The ticks of a
  `time` or `utc` axis are joined by their value as text, which stops at the second, so ticks a few milliseconds apart share one item
  (the last tick's datum, the first one's place), where each used to be its own. A string handed to a `time` or `utc` scale is
  read as a number (`'2'` is 2 ms), not parsed as a date, so a date string in a time-scale encode gives `NaN`: parse dates with
  `format.parse` or a `timeparse` formula before they reach the scale.
- **`@aster-charts/core`: an incremental evaluation keeps the gradient definitions of the marks it does not re-encode.** A mark reused from
  the previous scene, or a row a pulse leaves alone, still brings the `<defs>` its gradient fill or stroke refers to, so the SVG of an
  incremental update no longer references a gradient the scene lost; one nothing uses any more is dropped.
- **`@aster-charts/core`: an axis label is the value the format returns, not its text.** A band or point axis over a column whose cell holds a
  list (`[1, 2]`) writes the label as two lines, as vega does, and sizes the axis for both; it was one line, `1,2`.
- **`@aster-charts/core`: a mark whose encode throws is contained as vega contains it.** The item that threw keeps the channels set before
  the failing one and its edges (`y2`, `x2`) are never made a size, so it draws as a zero-size rect where it drew the full one. When
  the encode reads a scale that is ranked late (a domain over data of its own scope), the pass reaches the title and the guides that
  read no late scale, as vega's does: a legend over a late scale is its group, title and an unmade gradient or entry (the aria
  caption included), one over a literal domain is made whole. Before, the chart stopped at the mark.

- **`@aster-charts/core`: a guide's format, a layout that throws, and the names and parameters a spec must have, as vega reads them.** A
  legend's `format` the label format refuses (`{signal: '0/0'}`, `zzz%%`) made `renderSpec` throw; it is now the error vega logs, and
  the pass stops at the legend (a gradient whose labels are ranked last keeps its gradient). The format and format type of an axis or
  a legend are the values their signals hold, read through the scale's own tick format (a falsy time specifier is the default
  multi-format, as in vega, not the text `NaN`), and a signal given to a guide's ticks or entries that throws stops the pass at the
  guide, logged once. The caption reads the format off the guide's group item and is not written when it cannot be made. A layout vega
  cannot take (a `columns` that is no count, a column header or footer with no cell to line up with, a legend's entries `columns`) is
  logged and stops the pass where vega's does, instead of being swallowed; `Grid headers exceed limit` is warned; a grid moves a cell's
  bounds with it rather than measuring them again, as vega. `compileChart` refuses, in vega's order and with its messages, a transform
  without a required parameter (a `bin` without `extent` is the exception: Aster accepts it and derives the extent from the data, see
  "Deviations from Vega" in `docs/ARCHITECTURE.md`), a lookup without a literal `from`, a
  projection, a data set or the scale of an axis or legend that the scope does not have, a list parameter given as something else,
  sub-parameters of no known kind, a facet without a name or a grouping, a signal pushed to an outer scope that has none, and a domain
  sorted by an op without its field. A `timeUnitSpecifier(...)` format the engine refuses is vega's logged error, no longer read off
  the call's text.

- **`@aster-charts/core`: every transform of a mark runs on its encoded items, and a guide that reads a late signal is drawn as vega leaves
  it.** A mark's transforms other than `lookup`, `force`, `label`, `voronoi`, `wordcloud`, `heatmap`, `linkpath` and `geopath` ran on
  the data rows before the encode: a `formula` that read `datum.datum.a` threw, and what a transform wrote (`x`, `fill`, a stack's
  `y`) was never drawn. All of them now run after the encode, on the items, through the path group marks use: they read what the
  encode gave the items and write onto them, which is what is drawn; `geoshape` reads its feature off the item. A mark's `identifier`
  numbers its items from the view's counter, after the datasets, and an item keeps its number from one evaluation to the next
  (nested scopes are numbered in Aster's build order: see "Known differences not yet matched" in `docs/ERRORS.md`). What reads a late
  signal that threw follows vega's dataflow: a mark whose encode reads it runs none of its transforms nor its sort, a transform that
  reads it stops them there. The part of a guide whose encode reads it (a title's text, a label's color, a legend's symbol size) is
  left unencoded, every part of the guide when it is the guide's group that reads it (an `offset`, a `padding`, a `format`), and the
  view is not laid out; the generated guides of `differential-abort-trees` compare the picture where vega can draw it. A guide no
  longer reads a property vega does not know for its kind (`columns` on an axis), so an expression there that does not parse is
  accepted, as vega accepts it.

- **`@aster-charts/core`: a group mark's transforms run on its items, as vega runs them.** Only a group's `formula` was run, and only to see
  whether it threw; what any transform wrote was dropped. The items of a group mark are now encoded in the scope the mark is in (the
  item's own data sets and projections are its content's, which its encode cannot read), then every transform of the mark runs on them
  and writes onto them (a `formula` that sets `x` or `fill`, a `window`, a `stack`, a `pie`, ...), then its sort, and only then is what
  each item holds made: it reads the group's position and size as the transforms left them. A transform that throws stops the pass
  there. A mark (of any type) whose transform makes or drops tuples (`filter`, `aggregate`, `fold`, ...) is refused when the spec is
  parsed, with vega's `Mark transforms should not generate new data.` A mark whose encode throws and whose transform or sort throws
  too logs the encode's error, as vega runs the encode first. A guide of the view that reads a late signal that threw no longer evaluates
  it (a derived format made `renderSpec` throw, a derived tick count logged an error vega never logs): the one error logged is the
  signal's. An axis whose ticks read it is refused (`[aster]`), since vega's renderers cannot draw what it leaves. The
  generated trees of `differential-abort-trees` put transforms on groups, header groups in grids and two failures in one mark.

- **`@aster-charts/core`: late signals and mark transforms stop the pass like vega's.** A signal of the view that reads data or a scale (or one
  declared after it) and throws was never logged and the marks that read it were drawn; a mark's `transform` or `sort` that throws
  was logged and the run went on. Both are now points the pass stops at (see "Scopes and an aborted pass" in `docs/ARCHITECTURE.md`):
  a late signal is ranked after every other operator of the view's scope, so everything that does not read it is made, what reads it is
  left bare, the layout of the view does not run when a mark reads it or a gradient legend's labels wait for it, and nothing below the
  view is made; a mark's transforms and sort run on its encoded items, so the mark is made in full and the pass stops after it. One
  error each, as vega logs. The generated trees of `differential-abort-trees` now put failures in them.

- **`@aster-charts/core`: a circular symbol is drawn on canvas as vega draws it** (one full-turn arc about the item's origin, not two half turns),
  and the Chromium canvas gate compares the calls of vega and Aster for the generated gradient entries: WebKit rasterized the two half
  turns a pixel differently and only its nightly noticed.

- **`@aster-charts/core`: the gradient of a scale.** `{gradient: <scale>, start, stop, count}` in an encode and the expression
  `gradient(scale, start, stop, count)` (which compiled and failed when called) paint a linear gradient whose stops are the scale's
  ticks (`count`, else 15) and the ends of its domain, in the colours the scale gives; scales without ticks (quantize, quantile,
  threshold, ordinal) use their domain, and a domain of no width is stretched onto [0, 1]. The scale may be named by a signal or a field;
  a scale that cannot draw one (an ordinal scale over words) fails with vega's `TypeError` and stops the pass there. Before, the
  fill was dropped. The SVG definitions are the same as for a gradient object, once per distinct gradient however many items share it
  (the ids stay content-addressed: charts on one page cannot collide); a gradient on text and on a rule is painted on canvas over the
  item's bounds (stroke included), and one on a group's box over the group's bounds, as vega's canvas does. Generated over the kinds of
  scale, the options and every mark that paints, against vega's SVG (string and DOM renderers) and its canvas in Chromium.

- **`@aster-charts/core`: a failing operator stops the pass as it does in vega, in every scope.** An encode that threw (a mark's, a group's, an
  entry of an axis, a legend or a title), a signal or a scale of a group's scope, logged one error per item it failed on (11 for one
  axis) and drew the scopes, legends and titles vega never gets to. Vega's dataflow runs its operators in rank order and stops at the
  first that throws: one error is logged, and the scenegraph is what the operators before it made. That is now modelled for every
  step of every scope (signals, projections, scales, axes, marks, legends, title), with the scopes of a group's items made one level
  after the scope the group is in: a failure in a mark leaves the groups before it empty, the groups after it not made, and the
  guides after it absent; a guide that fails keeps the channels written before the failing one (in vega's order, so the picture
  of a left axis differs from a bottom one), the marks of it after the failing one are not made, and the caption names what it
  made; a gradient legend's labels and a symbol legend's entries come after everything else of their scope; the layout of a group
  ran only if the pass went past every scope below it. Pinned by generated differentials against vega: random trees with failures
  at random places (`differential-abort-trees`), and every channel of every guide mark (`differential-guide-partial`).

- **`@aster-charts/core`: `renderSpec` no longer carries the incremental step engine** (`incremental-engine.ts`, `evaluate.ts`, `runtime.ts`).
  The engine (the pulse-driven transform steps and the state a step leaves for the next pulse) is only used by a chart evaluated again from
  a committed state. `renderSpec` and `getChartInfo` evaluate once and no longer import it; the public `evaluateChart` and the chart
  session (so every `<Chart>`, `useChart`, stream and worker) are handed it. `evaluateChart` behaves as before. A `renderSpec`-only
  bundle is 4.6 kB gzip smaller (150.4 to 145.8); the React rows and `core + @aster-charts/core/dom` keep the engine. Output is the same:
  `evaluate-once.test.ts` compares the two evaluations over generated charts, and the shaking gate and `verify-publish` check, by
  module, that a `renderSpec` bundle does not contain the engine and an `evaluateChart` one does.

- **A re-evaluation keeps the dataset steps whose inputs did not change** (`step-reuse.ts`, `runtime.ts`, `session.ts`). The React mount
  evaluates a chart at the spec's size and again at the measured container's, and a resize or a signal write evaluates it again; every
  dataset pipeline ran from its first step each time. A step records the rows it was made from, the signals it reads, the random source
  it drew from and what it published; the next evaluation keeps it when they are as they were, writes the signals it published again,
  and does not draw again. Datasets of group scopes are kept as whole pipelines. Consecutive `bin` / `formula` / `timeunit` steps
  write onto one set of rows instead of copying every row per step, and source rows are no longer copied before a step that makes
  rows of its own. On crossfilter-flights (200k rows, Chromium) a container resize costs 7 ms instead of 133 ms and the React mount to a stable
  `<svg>` 198 ms instead of 385 ms. Output is the same: a generated differential against an engine that keeps nothing, and a live one
  against Vega.

- **`@aster-charts/core`: every expression of a spec is refused when the spec is compiled, as `vega.parse` refuses it** (same time, same message,
  same order; a `SpecParseError`). It was only a syntax error in most places, and the handlers of signals were not looked at until they
  were bound. Now `compileChart`, `renderSpec` and the mount of a `<Chart>` also refuse: the `on` handlers of signals (their updates,
  event selectors, streams however nested with their filters, the signals and scales that trigger them, `encode` with `update`,
  `init` with `update`); an unknown function (`Unrecognized function: foo`, in a signal `update` too) and an undeclared name
  (`Unrecognized signal name: "x"`), with the scope rules of vega-parser (a group's signals and `parent`, the signals transforms
  declare, the signals of the config, the five of every view); the refusals of vega's code generator (`Illegal callee type`,
  `Illegal identifier: _`, `Illegal property`, `Missing arguments to clamp function.`, a call that needs a literal data or scale name);
  the `on` triggers of named marks; and the expressions of a transform in the order of its definition, by the kind of each parameter.
  A function of an add-on is known to the compile whether or not the add-on is loaded (it is asked for by `@aster-charts/core/addons` and
  fails, naming the add-on, when called without it). Properties of guides vega never reads are no longer refused, and a symbol legend's
  size and layout expressions are quoted as vega quotes them (see docs/ERRORS.md for the few it does not).
  Also: `isInvalid`, which vega does not have, is an unknown function; a spec whose expressions use a name it declares no signal for
  (one a host supplies in `RuntimeInput.signals`, say) now fails to compile, where it used to render with the name undefined.

- **`@aster-charts/core` limits: built-in ceilings for the crash-class inputs, and `limits` documented as best-effort.** A few inputs let a tiny
  spec exhaust the process (a 440 KB topojson topology that decodes to 200M positions, `tickCount: 2e6`, `sequence` of 5e7, a trellis
  `layout.columns` of 5e7, `pad` / number-format widths of 5e7, a spec nested 20 000 deep). They are now refused with `AsterLimitError`
  even when no `limits` are given (`HARD_CAPS`: rows 1M, cells 10M, items 100k, bytes 1M, coords 2M; spec depth 1000), naming the
  ceiling and the limit that raises it; a matching limit replaces the ceiling, and nothing in the gallery or corpus comes near them.
  A deep or cyclic spec is a typed error without `limits` too (it was a raw `RangeError`). The worker handler serializes the SVG
  inside the limits scope. The expression `pluck` accessor table is a bounded LRU (it grew without bound). The regex screen refuses
  three or more adjacent overlapping unbounded quantifiers (`a*a*a*a*a*b` ran over 20 s on 9 000 characters). `docs/LIMITS.md`
  states that `limits` are best-effort and that the killable worker is the hard guarantee.

- **`@aster-charts/core`: four runtime leftovers closed, each against vega 6.3.1.**
  - Field paths. A facet `groupby` that is a nested path (`'o.k'`) threw; the group items are matched with their rows by the
    key the aggregate hands back, and are joined the way vega joins them (rows that share the flat key of their group-by
    names, an escaped name reading nothing, are one item). `stratify`'s `key` and `parentKey`, a json format's `property`
    (`a["b"]`, `a\.b`, `a[1]`) and `indata`'s field are paths too. A generated differential draws nested, escaped,
    bracketed, quoted and numeric paths into 47 transform pipelines and 20 spec shapes (facets, encode entries, scale
    domains, sorts, expressions) and compares with vega.
  - `nest` (named in the transform list, refused at run time) is implemented: groups, the generated interior rows,
    and the layouts and `treelinks` that follow, compared with vega over generated nestings.
  - An encode entry that calls a scale the spec never declared fails as vega's does (`TypeError: _.%name is not a function`,
    the run stops, the item keeps the channels before it) instead of drawing a rect. The items an aborted run never
    encoded now stay in their mark for every mark type, a line whose width failed is drawn at 1, a rule keeps a NaN
    `x2` / `y2`, and an image with no url, x or y is drawn as vega draws it.
  - `buildA11yTree` boxes are in the viewport, as `A11yNode` always said: the padding and the frame offset are in the
    numbers (the React overlay no longer adds the padding). Hosts that added the padding themselves must stop.

- **`@aster-charts/core` guides and layout: eight divergences from vega closed**, which the generated guide and grid differentials had been avoiding
  (they now draw all of them): an axis with explicit `values` formats its labels for one tick per value (a precision that follows the
  tick step, `e` among others, differed); `tickMinStep` acts only through the tick count (a log scale keeps ticks closer than it); an
  axis `orient` signal reads the per-orient config blocks per key as signal expressions, and its `labelBound` clips as a vertical axis;
  under `fit`, `fit-x` and `fit-y` a legend takes from the view only its extent across its side, the view title sits against the same
  bounds, a legend is arranged again in the second pass and a grid's second layout starts from the first's places (the floats vega's
  second pass rounds); an `orient: none` legend with no `legendX` / `legendY` extends nothing along that axis; grid headers beyond the
  column count add nothing to the bounds.

- **`@aster-charts/core` scale stack in Aster's own design** (`arr.ts`, `interp.ts`, `scale.ts`, `scale-continuous.ts`, `scale-discrete.ts`,
  `scale-d3.ts`, `scale-domain.ts`, `scales.ts`). d3-array, d3-interpolate, d3-scale, vega-scale and the spec side of vega-parser /
  vega-encode were written as transcriptions; they are now models of their own: one mapping model and one warp for identity / linear /
  power / log / symlog, a gradient model for the sequential and diverging scales, a lexicon of categories under ordinal / band / point,
  a tick-ladder table for time, a tick planner, a shared set of channel ramps for every colour space, and a spec reader that turns a
  scale spec into typed settings before anything is built. The numbers are the same to the last bit; a seeded live differential runs
  programs of getter / setter calls on every one of the 28 scale types (reversed, zero-width, NaN, infinite, Date, wrong-length and
  non-iterable arguments) against vega-scale, every interpolator in every colour space and gamma against d3-interpolate, the
  array helpers against d3-array, and discrete / quantile domain specs against real vega. 15 % fewer lines; the core bundle is 0.5 kB
  gzip smaller and a fresh process loads it as fast. They found and fixed six divergences, in the code before the rewrite as well:
  - `bisectCenter` read `null` as 0 where d3-array reads it as NaN; `interpolateNumberArray` returned a plain array for a typed-array
    target (d3 slices the target, so a `Uint8Array` truncates) and `interpolateArray` did not hand a typed array to it.
  - A literal list among a scale domain's `fields` that holds `null` or `undefined` fails in vega's dataflow; the scale now refuses it.
  - Whether a domain sort is allowed is judged on what the spec wrote, as vega does: over several fields an `op` and `field` given as
    signals are refused, and an `op` signal with no `field` is refused unless it is `count`.
  - Over several fields there is no combined `count` column, so a sort by `field: 'count'` keeps first-seen order (it ordered by how
    many fields held the value).
  `THIRD_PARTY_NOTICES.md` drops the quickselect notice (no code is based on it any more) and says which projects stay listed.

- **Transform gaps against real vega** (generated, live differentials over the parameter space):
  - `quantile` skips `null` like d3-array (`quantile([null, null], 0.25)` was 0, and a column with nulls shifted every percentile).
  - `contour`, `isocontour`, `kde2d` and `heatmap` follow vega: `scale: 0` and a falsy `translate` fall back to the grid's;
    `contour` spreads its default thresholds from zero when `values` are given; thresholds keep the order given (repeats too);
    a null cell reads as 0, a NaN one is below every level and smooths to a NaN coordinate; an estimated bandwidth no longer
    counts a null or empty coordinate as 0; a list parameter written as a plain value, a missing required parameter, an invalid
    cell size or bandwidth are refused with vega's messages, in vega's order.
  - `force` refuses a bad `forces` list with vega's messages (`Unsupported parameter: {"force":"gravity"}`, `Expected an array of
    sub-parameters`, `Undefined data set name` for a link force). Not fixed: the wording of an expression syntax error is still
    the parser's, not `Expression parse error: ...`. **Superseded:** a `force` whose expression does not parse now throws
    `SpecParseError: Expression parse error: 1 +` from `renderSpec`.

- **`@aster-charts/core` geo engine in Aster's own design** (`geo-events.ts`, `geo-sphere.ts`, `geo-clip.ts`, `geo-resample.ts`,
  `geo-raw.ts`, `geo-projections.ts`, `geo-path.ts`, `geo-sphere-measures.ts`, `geo.ts`). A GeoJSON object is flattened into
  an event buffer and each stage (rotate, clip to the visible sphere, project with adaptive resampling, clip to the
  screen) is a function from one buffer to another; projections are objects with properties and a `configure(params)` in
  vega's order, not getter/setter closures; no state survives a call (d3-geo's measures and cached pipelines leak state
  from a call that throws). The results are the same bit for bit: a seeded generated differential runs random GeoJSON
  (antimeridian and pole rings, holes, degenerate rings, huge and tiny coordinates) and random parameters
  (rotate, centre, scale, translate, clipAngle, clipExtent, precision, reflect, parallels, fit, parameters of the wrong
  kind) for every projection type against vega's projections and d3-geo's paths, and whole specs (geoshape, geopath,
  geopoint, graticule) against vega's SVG. It found and fixed two divergences: the Equal Earth inversion stopped at 1e-6
  instead of 1e-12, and `geopath` drew every point with a NaN radius when `pointRadius` was an `{expr}`. `geoshape` takes
  the path and the unrounded bounds from one pass over the geometry. Not carried over: an empty polygon ring is closed
  against the vertex the previous call happened to leave in d3's module state, so only an error is stable there.

- **Formatting layer in Aster's own design** (`format.ts`, `time-format.ts`, `time.ts`, `locale.ts`, `color.ts`). Number and date
  formatting, the calendar intervals, the time-unit floors, the locale facade and the colour spaces are re-decomposed (a specifier is
  parsed, settled in a locale and rendered; a directive is written once over a time base; a calendar unit is a record `makeInterval`
  turns into an interval; the colour grammar is built from slots) with output unchanged. New generated live differentials against the
  pinned d3-format, d3-time, d3-time-format, d3-color, vega-time and vega-format found and fixed: locale `grouping` / `numerals` given
  as array-likes; the stale SI prefix of an `s` format of a NaN whose locale text is empty or numeric; `formatFloat` under non-ASCII
  numerals returning `''`; `%Z` parsing half-hour offsets; the dedicated `timeYear.every(k)` / `utcYear.every(k)`; and a second, older
  `tickStep` that `formatSpan` and `timeBin` used. `timeUnitSpecifier` no longer loops forever on a specifier table that blanks a unit.
  Not fixed (another module): `timeBin` with a NaN extent picks the year grain where vega-time picks milliseconds. **Superseded:** `timeBin` with a NaN extent now returns the same units and step as vega-time's `timeBin` (checked for `[NaN, NaN]` and `[NaN, 5]`).

- **`@aster-charts/core`: the small ports in Aster's own design** (`event-selector.ts`, `selections.ts`, `timer.ts`, `topojson.ts`,
  `dsv.ts`, `data-format.ts`, and the voronoi transform as `delaunay.ts` + `voronoi.ts` + `orient.ts`). Parsed selectors and their
  messages, selection results, timer ticks on a virtual clock, topojson features and meshes, parsed rows, inferred types and
  voronoi paths are unchanged, and now pinned by generated live differentials against the real vega-event-selector,
  vega-selections, d3-timer (with clock stalls and manual flushes), topojson-client (random topologies and us-10m / world-110m),
  d3-dsv, vega-loader and d3-delaunay / delaunator / robust-predicates (point sets that stress a triangulation). What they found
  and fixed: voronoi cells of nearly coincident points were computed with an inexact orientation test (an exact sign is used now);
  an inverted or NaN extent is refused with `invalid bounds`; voronoi on missing coordinates ends instead of looping. Deviations
  kept, in docs/ARCHITECTURE.md: `vlSelectionResolve` does not grow the store's arrays in place, topojson positions are fresh
  arrays. Selection tests over 100k tuples run in about 55% of the time of the code they replace.

- **Gallery conformance, runtime (the official Vega / Vega-Lite examples against real vega)**: the fixes below take the
  gallery gate from 37 / 251 (static, Vega / Vega-Lite) and 30 / 186 (React) to 61 / 274 and 45 / 205:
  - Date expression functions are vega's: `time(x)` is a timestamp (a Vega-Lite `filter {timeUnit, equal}` kept no rows),
    `year()`, `quarter()` (1-based), `datetime()`, `utc()`, `timeFormat()`, `timeParse()`, `monthFormat()` ... take the raw
    argument as `new Date(x)` does; a live differential covers every one of them.
  - Inline primitive `values` are rows `{data: v}`; `dataset.source` may be a list; a dataset's `values`, a `url` and a
    projection `type` may be `{signal}`s (`loadSpecData` loads a signal url for the signal's initial value); a signal
    declared without a value exists; datasets are built in the order of the signals they write (`extent`, `bin`) and
    read; a transform parameter that names a declared signal is that signal (`static`).
  - A mark may read a group mark's items (`from: {data: <name>}`); a mark's `lookup` / `linkpath` / `force` / `geopath`
    transforms run on the encoded items; a group that declares its own `height` / `width` signal sizes its scales by it;
    a facet may be pre-faceted data (`facet.field`); a view with no `width` / `height` is 0 wide / high (it was 500);
    `autosize: {type: "none", contains: "padding"}` takes the padding out of the size.
  - Line and area paths are d3's generators over the items (a gap is the curve's own, not a `Z`; stacked areas and
    curves are vega's to the last digit); trail marks run vega's generator through the d3-path buffer; gradient objects
    as fills and strokes are defs (linear and radial); a text mark's items always have text bounds; shape and geoshape
    bound their stroke with the miter expansion; `geoshape` takes a `pointRadius`.
  - New in the opt-in addons, each compared with the pinned vega package: `tree` / `treelinks` / `treePath` /
    `treeAncestors`, `force` (d3-force + d3-quadtree, bit-exact), `kde2d`, `isocontour`, `geopath`, `geoArea` /
    `geoBounds` / `geoCentroid` / `geoScale`, and the normal / log-normal / uniform `sample` / `density` / `cumulative` /
    `quantile` functions.
  - The conformance canonicalizer decodes character references in text nodes and reads a radial gradient's pattern.

- **Runtime parity with Vega 6.3.1 (six documented gaps closed)**, each compared with real Vega by a differential test and
  corpus specs:
  - Axes, legends and titles are built by ports of vega-parser's guide encoders and vega-view-transforms' layouts, so
    every property, every `encode` block (`legend`, `entries`, `symbols`, `labels`, `title`, `gradient`, bands) and every
    `config.style` / config block reaches an item as in Vega, and `null` means what it means there for every guide
    property (a `null` in the config removes a default, in the spec it is no value, from a signal it is a value).
  - Quantize, quantile and threshold legends label their bins like vega-encode (`3.0`, `< 2`, `>= 10.5`, `lo - hi`
    intervals for symbol legends) and are as wide as Vega's.
  - Group items write their own `aria-label`, `role`, `aria-roledescription` and `aria-hidden` (string renderer, DOM path
    and the accessibility tree).
  - `Duplicate data set name` follows vega-parser's scoping (a nested group may shadow its parents' names, a name is
    declared once per scope, guide parts and facets count).
  - An axis whose ticks cannot be made (an interval string on a non-time scale, a format that is no specifier) follows
    Vega's dataflow abort per scope: a clean cut after the axis for most scales, a refusal where Vega's own serializer
    crashes. Also fixed on the way: a scale in a group nested two levels deep ranges over the view's size, and an
    `orient: none` legend no longer widens the view by its `legendX` twice.
  - The bundle budgets of the rows that contain `@aster-charts/core` were raised by 7.2 kB gzip (130.8 kB for core). Guides cost
    more per item than before (every channel of every tick and label is Vega's own encode): see docs/PERFORMANCE.md.

- **Accessibility structure of the SVG (N3)**: axes, legends and titles are drawn as vega-scenegraph draws them
  (`<g class="mark-group role-axis" role="graphics-symbol" aria-roledescription="axis" aria-label="...">` around
  the item group, its background and foreground paths and one container per guide mark), every group mark has
  its container, data marks carry vega's class (`mark-rect role-mark <name>`), `aria-roledescription` and
  `aria-label`, and items carry `aria-label` / `role` / `aria-roledescription` from `description`, `ariaRole`,
  `ariaRoleDescription` (`aria: false` hides). The old `role="axis"` was no ARIA role. The captions are one
  implementation shared with the accessible tree. The strict canonicalizer compares this structure, so it
  can not drift again; `@aster-charts/vl` now emits vega-lite's `description`, `ariaRoleDescription` and mark names.
  The corpus SVG changes (759 of 785 files); the pictures do not.

- **Spec lists are vega's** (the README example used to throw a raw `TypeError`): `data: {values: [...]}`, a lone mark or scale object and `null` are read
  through vega-util `array()` as in vega-parser, and a data set used without being declared is
  `SpecParseError: Undefined data set name: "<name>"` (as `vega.parse`), in `compileChart` and so in every host.
  `checkSpecLimits` counts the same lists.

- **Guides driven by signals, like vega (sweep-signals: 30 differences to 0, now a blocking gate)**: every
  axis and legend property may be a signal and a signal may hold anything; an axis `orient` signal is
  resolved when its value is known (any orient but the four is a vertical axis at the origin whose layout
  never runs); a tick count that is an interval string on a non-time scale, or a format that is no
  specifier, fails the axis ticks as in vega (logged, axis not drawn); titles exist whatever their text
  (empty text draws an empty `<text>`, a list is lines; an empty-string title is none); legend titles may be
  signals; a mark's `clip` (boolean or signal) bounds the mark to the enclosing frame (vega boundClip); the
  view width signal can be null or a word, and a negative width or height is laid out in vega's two passes;
  a text angle that is a word is written `rotate(word)`.

- **`registerExpressionFunction`** (`@aster-charts/core`): vega's `expressionFunction`, the hook for Vega-Lite's
  custom `formatType`. `@aster-charts/vl` now emits vega-lite's custom format types (text, tooltip, href,
  description, axis and legend labels, headers; `config.customFormatTypes`, `numberFormatType`,
  `normalizedNumberFormatType`, `timeFormatType`), explicit scale domains with vega-lite's `zero` / `nice`
  rules (continuous x / y, size, opacity and colour scales ignored them before), `zero` / `nice` on
  `pow` / `sqrt` / `symlog` position scales, and non-array, non-`"unaggregated"` scale domains (emitted as
  written; vega refuses them, so does the runtime with `SpecParseError`). The nightly Vega-Lite sweep has no
  engine errors left.

- **Group marks are vega scopes (nested group axes skipped `config.axis`, nested legends were dropped, axis `encode` was ignored; corpus-vega-only drained)**: every group mark
  is built and laid out like vega (one group item per facet partition / datum, own scales and data,
  `layout` grid, then axes, legends and the title), replacing the per-shape concat / facet / header
  builders. Concat, repeat and wrapped / layered / nested facets, facet header placement
  (`labelAnchor`, `labelOrient`, `orient`, `labels: false`, title anchors), nested legends
  (compiled with the view's config, as are nested group axes) and composition-level legends now
  match real vega; `corpus-vega-only` is empty. Gradient legends of time scales label and place
  their Date ticks (corpus-tz covers New_York and Kolkata). Axis `encode` (labels, ticks, grid,
  domain, title, axis) and legend `encode` (labels, title, symbols, legend) apply as in vega, and the
  runtime no longer reads the non-vega `labelExpr` / legend `disable`. Symbol legends are one vega
  symbol encode for every channel (size, opacity, strokeWidth, strokeDash, ...); a mark `sort` orders
  encoded items (stacked-area / imputed-line series order); `href` is drawn as `<a xlink:href>`
  under the URL policy; `containerSize()` reads `RuntimeInput.containerSize`; `signal.init` is an
  expression, not a literal.

- **Loader URL policy (breaking default)**: `loadSpecData(spec, options)` now vets every URL
  (protocols `http:`/`https:` only, no credentials, loopback/private/link-local hosts denied,
  relative urls need `baseURL`, an `allow(url)` hook re-run on every redirect hop) and bounds
  each request (`timeoutMs`, `maxBytes` enforced while streaming, `maxConcurrent`,
  `maxRedirects`, `signal`). `data:` urls need `protocols: ['data:']`. Group-level `url`
  datasets are now resolved; an unloaded `url` dataset is an error instead of an empty chart.
  `TRUSTED_LOAD_OPTIONS` opts out for specs you wrote. Image-mark urls share the policy
  (`RuntimeInput.urlPolicy`, defaults applied under `limits`).

- **Limits are meters, not checkpoints**: one wall clock and generated-row/byte meters are
  threaded through transforms, row emitters, the encode loop, guides, expression builtins and the
  parser; single-call allocators (`sequence`, `pad`, format width, ticks, facet columns, contour
  grids, topojson arcs) are bounded before they allocate; `maxRows` covers nested group data,
  host `input.data` and transform output; paths and text arrays count toward `maxPathLength` /
  `maxStringLength`; deep and cyclic specs and expressions throw `AsterLimitError`. New
  `maxGeneratedRows` / `maxGeneratedBytes`. See `docs/LIMITS.md` (including why untrusted
  specs still need a killable worker for regular expressions).

- **Fixes**: `bin` with `maxbins <= 0` and `stratify` cycles no longer hang (vega's results and
  errors); `Math.min/max(...rows)` no longer overflows the stack at ~120k rows; `format.parse`
  accepts `date:`/`utc:` patterns; expression `format`/`timeFormat` follow the current default
  locale; formatter caches are bounded.

- **DOM, canvas and hit-testing fixes**: the
  DOM patcher no longer leaves removed items drawn and drops others after a removal or
  reorder; the string renderer and the DOM descriptor take every attribute from one
  per-element list in `render.ts` (a first patch no longer rewrites gradient direction,
  dashes, caps, the rounded frame, trail fill, ...); canvas append painting is exact
  (in-place edits in other groups, changed guides, z-order against later groups and the
  miter limit are handled by declining to a full repaint) and no longer serialises item
  arrays per frame; trails paint their fill on canvas; the canvas honours symbol `angle`
  and path `scaleX/scaleY`; the hit index picks against painted geometry (pies, maps,
  lines, rotated text) and cannot be made to run out of memory by one oversized item.

- **Incremental appends/inserts/deletes**: `diffRows`/`dataPulse` now carry an old↔new
  index mapping plus added/removed ranges. The runtime propagates length-changing
  pulses through row-wise, filter, fold/flatten, grouped and 1:1 geo/hierarchy
  transforms, and scene items splice instead of rebuilding. `pnpm bench:incremental`
  gates that an append, a whole-array replacement and a DOM patch each beat their baseline by a measured floor.

- **Nested scopes / axes**: nested group marks now inherit outer scales (local names
  still shadow), so raw Vega specs that reference a parent `y` or colour scale render
  inside groups (population pyramid). Vega-Lite compilation now emits all grid axes
  before all label axes, matching Vega's paint order (the x-axis domain is no longer
  covered by the y-grid line). Band-sized encodes now apply `offset`/`mult` (e.g.
  `height: {scale:'y', band:1, offset:-1}`), restoring the 1px bar gaps.

- **Canvas fixes (found by the Chromium gate)**: relative `H`/`V` path commands now
  carry the current point across each other (rects previously painted from
  `y - height`), canvas text no longer passes a boolean as `maxWidth`, scene siblings
  are ordered axes → marks → legends → title like Vega, and custom `labelFont`/
  `titleFont` families reach axis/legend text metrics.

- **Pulse/dataflow**: sessions automatically diff replaced immutable source arrays
  (`autoChanges`, default on), expose source/transform pulses via `session.pulse()`,
  and reuse unchanged items without an explicit `dataChanges` props. Sorted
  window/stack groups now consume dirty-group pulses instead of falling back.

- **Transforms**: transform option matrix (bin/window/stack/joinaggregate/impute/
  fold/flatten/pivot/lookup/sequence/identifier/timeunit/extent), fixing impute
  tuple fields, sequence append semantics and identifier assignment.

- **Text metrics**: pluggable `TextMetricsProvider` on core/`<Chart>` for custom
  fonts and non-browser renderers, with provider-scoped caching and safe fallback.

- **Limits**: `maxTimeMs` wall-clock deadline checked across compile/evaluate/render
  and inside dataset/encode loops; `domainRaw` scale overrides in core.

### `@aster-charts/vl`

The Vega-Lite compiler.

- **`@aster-charts/vl`: a longitude or latitude takes every definition vega-lite compiles.** `aggregate`, `bin`, `timeUnit`, `sort`,
  `stack`, `scale`, `axis`, `legend`, a value `condition`, `impute`, `band` and `bandPosition`, and any type but quantitative, were
  refused on longitude / latitude and their ends. vega-lite 6.4.3 projects the raw field whatever the definition says and reads the
  rest as on any other channel (an aggregate grouped by the projected positions, the fields of a bin and a time unit, a sort index,
  the parse and format of the type), while a scale, an axis, a legend, a stack, an impute, a band or pre-binned data change nothing;
  so does this now. The end of a pair on a point, circle, square, line or trail is kept beside a pre-binned `y`, as vega-lite keeps
  it (it was read against a pre-binned longitude / latitude). A count of records on a longitude / latitude is refused, with the half
  pair and the datum that is not a number, because vega cannot run what vega-lite emits for them (listed under "Throws"). Pinned by
  `vl-geo-channels` (mark x geographic channel x definition x companion, 4020 cases) against vega-lite 6.4.3.

- **`@aster-charts/vl`: every mark draws every channel as vega-lite draws it, whatever the channel's definition.** A datum on a size, opacity,
  shape, dash, angle, theta, radius or text channel, and `scale: null` on any channel, were refused; they compile now (a datum is its
  scale's domain, a field without a scale is read as it is, a position without a scale has no axis). The `key` channel is supported.
  An arc is centred by x, y and their offsets (and stacks a quantitative x or y), theta and radius take values, datums and second
  channels alone, and a text is placed by x and y around which theta and radius move it. A constant x or y on a bar, rect, tick or
  image is laid out as a field is (the centre of a band, or one end of a range), an offset that is a value moves the mark, and size
  conditions work on bars and ticks. Order and detail keep only their field definitions, as vega-lite does, and an order value is the
  zindex of the items. A text, tooltip, href, url or description shows a condition's field as text. A non-GeoJSON shape field on a
  geoshape is a shape legend, a constant longitude / latitude is no projected position, and channels a mark does not draw are no
  longer validated. A condition that gives a field on a position is refused (listed under "Throws": the schema gives positions no
  condition and vega-lite's output for it is incoherent). Pinned by `vl-mark-channels` (every mark x every channel x every kind of
  definition, 6188 cases) against vega-lite 6.4.3.

- **`@aster-charts/vl`: `fill` and `stroke` paint every mark as vega-lite paints them, beside `color` and each other.** A fill on a stroked
  mark, a stroke on a filled one, and either beside a `color` were refused; now each paint channel has its scale and legend, a `color`
  gives way to the fill (filled mark) or stroke (unfilled mark) the encoding has, and every mark is painted by one rule (the mark
  definition's and the config's paint, then color, fill and stroke). Legend symbols are painted from the mark's paint, and the legends
  that read one field merge when both scales are discrete or both continuous (vega-lite 6.4.3), after layers and views merge theirs.
  Channels a mark does not draw (a size on an area, an x on a geoshape, a url off an image) are dropped as vega-lite drops them instead
  of being refused. A layer whose leaf has two legends no longer overflows the stack. The encoding refusals that remain are listed in
  the README. Pinned by `vl-paint-channels` (mark x filled x channel x definition x companion, config defaults, layers) and
  `vl-mark-channels` against vega-lite 6.4.3.

- **`@aster-charts/vl`: a scale type a channel can use is the scale the field has, and marks sit where vega-lite puts them.** The #87 fallback
  covered the requests a channel or the data cannot use; these valid ones were ignored or answered with another scale: colour `point`
  and `bin-ordinal`; `ordinal` and `band` on size, opacity, stroke width and angle (a band scale is read at the middle of its bands);
  `quantile`, `quantize` and `threshold` on shape and stroke dash (and on every numeric channel, whose range is cut into classes only
  for size); a temporal `xOffset` (a time scale, over the span of its time unit); `log` on a binned position. The scales of `fill` and
  `stroke` are named `fill` and `stroke`; data-driven `fillOpacity` and `strokeOpacity` have their scales (no legend, as in vega-lite);
  the legend of a log, symlog, quantile or threshold scale thins its labels; a legend over a temporal field read through a scale that is
  not a time scale formats its labels as times. Positions: `band` on point marks sits at the middle of the band (or at the field's
  `bandPosition`; a rule honours it too), a rect-based mark on a `point` scale is a default step wide, an `xOffset` on a continuous
  position is dropped (it has nothing to nest in), a point offset leaves a bar its default width, a layer that offsets a position
  does not change the step the first layer gave it, a binned or time-unit offset is read at the middle of its unit, a time-unit colour
  or size on a bar is read at the middle of the unit, a stacked area/line over a discrete dimension is imputed, and a datum is not a
  typed field when the orientation of a tick or bar is decided. Pinned by generated differentials against vega-lite 6.4.3: every
  channel x every scale type it honours x every data type (`vl-honoured-scale-types`) and every mark x position x scale type x band
  position, offsets, time-unit channels and datums (`vl-honoured-positions`); the compared output now includes compiled axes and legends.

- **`@aster-charts/vl`: composite marks in a repeat, and the decision tables as Aster's own.**
  - A boxplot, errorbar or errorband in a repeat (a list, a row, a column, a grid, a layer, nested in a facet, a concat, a layer or
    another repeat) is rewritten after the repeat has put its values in; it was rewritten while its field was still a `{repeat}`
    reference. A generated matrix of composite marks x repeat forms x channels x compositions now compares each against vega-lite 6.4.3
    (SVG, signals, scales, axes, legends, marks). It found and fixed, in views a repeated composite sits in: a view with an axis and no
    scale on the other channel declares that size signal in its group (concat and repeat); the legend of a layer of composite marks
    merges a nested layer's titles first; a datum colour in a composite mark and a datum condition on `color`, `size`, `opacity`,
    `strokeWidth`, `strokeDash`; a repeat inside a repeat (inner variables shadow the outer's; views are named `child__row_gchild__column_v`);
    sibling aggregates of one source that group alike are one aggregate, in vega-lite's order, so the bootstrap intervals of an
    errorbar's views agree.
  - Which scale properties apply to a scale type (`scaleprops.ts`), a mark's orientation (`orient.ts`), a scale's default zero, time units
    (`timeunit.ts`) and predicates (`predicate.ts`) no longer follow vega-lite's functions line by line: a table of rows, an ordered
    run of rules, and shared pieces of their own. Each is pinned over its whole input space (scale property x scale type x channel;
    mark x position channels x second channels x asked orient; every time unit in every place; every form of predicate over every kind of
    value) against the compiled Vega of vega-lite, and 178,640 + 15,492 specs compile to the same Vega before and after. The
    orientation tables found two places the old one was not vega-lite's (a pre-binned channel on a rule or an area; a datum read as a field).

- **`@aster-charts/vl`: ten compile gaps against vega-lite 6.4.3, each pinned by a generated differential.** A rule over pre-binned channels
  (`x2: inrange(...)`); area, tick and bar marks with no orientation (two non-measures); a line with `x2`/`y2` is a rule; a view's `name`
  prefixes its scale and signal names (`outer_x`, `outer_childWidth`), through repeats, concats, layers and facets; continuous colour scales
  forward `round`, `clamp`, `nice`, `padding` and the like; `zero` on a log scale is dropped; `nice` on a time scale is kept;
  `binned: true` in the timeunit transform of a binned time unit; a selection a repeat or concat gives to a single-part errorbar or
  errorband compiles (a boxplot, which vega-lite compiles to a spec Vega cannot parse, stays refused); a repeat or a concat inside a facet
  compiles (a repeat of layers is a layered view to the facet). The scale-forwarding differential now also covers `yOffset`.

- **`@aster-charts/vl`: selections and composite marks in Aster's own design** (`selection*.ts`, `composite*.ts`). A selection is resolved
  against its unit into a model and wired by one sequence of steps over the signals it makes; the three composite marks share one
  anatomy and one part builder. The compiled Vega is unchanged on the 2769 specs of the matrices, the corpus and the gallery. New
  matrices compare with vega-lite 6.4.3 every selection type x option x binding x resolve x composition (876 cases) and every
  composite mark x extent x orientation x input x part x composition, plus path overlays and colour-ordered stacks (583 cases).
  What they found and fixed: a `{param}` domain keeps zero off; a horizontal area with `x2` ends at `x2`; `config.rule` /
  `config.text` keep their black against `config.mark.color`; a mark with `aria: false` encodes no role description; the mark
  inside a path group keeps the mark definition's styles; composite marks group by every entry of a `tooltip` / `detail` list
  and list a conditional field in their tooltip. Not fixed (pinned in the cases file): composite marks inside a `repeat`. **Superseded** by the entry "composite marks in a repeat" above in `@aster-charts/vl`: a `boxplot` in a `repeat` compiles.

- **Vega-Lite params and selections**: `@aster-charts/vl` compiles point and interval selections, `bind` to inputs / legend /
  scales, `{param}` conditions, predicates and filters, lookups from a selection, `scale.domain` `{param}` /
  `{unionWith}` and value params as vega-lite 6.4.3 does (a port of `compile/selection/*`), on a unit view and on the
  units of a layer and of a concat, facet or repeat view (linked brushing across views, a brush or a point per facet cell, a
  selection declared on the composition and given to every unit below it: each unit's signals are its group's, a Vega group
  scope). `@aster-charts/core` gains group-scoped signals as Vega defines them (one copy per group item, shadowing, `push:
  "outer"`, `scope`-source events, streams shared with the enclosing scope, `group()`/`inScope` over the scope's group, a
  group item picked where it has a fill or stroke, a facet cell's datum a tuple with `count`), the event loop keeps their
  values under `<scope id>:<name>`, and clipped marks no longer grow a group title's frame. `@aster-charts/core` gains
  the expression functions behind them (vega-selections' `vlSelectionTest` / `vlSelectionIdTest` /
  `vlSelectionResolve` / `vlSelectionTuples`, `modify` with vega's changeset semantics, `isTuple`, the pan / zoom
  functions, faithful `inrange` and `clampRange`), `{scale}` event sources, and datasets the event loop edits
  (`hooks.onData`); `<Chart>` keeps the edited rows. Runtime gaps closed on the way: legend part names and
  interactive legends, a mark that reads another mark's items, the voronoi mark transform, pointer events on
  transparent items and on the painted frame. Gates: 70 `vlx-sel-*` corpus specs render like vega-lite's output in
  real vega and in Aster and compile to vega-lite's own signals, stores and marks (a structure test); `pnpm
  conformance:selections` drives the same native input through vega-lite + vega and `@aster-charts/vl` + `<Chart>` (37 cases,
  composed views among them) and compares signals, group-scope signals, stores and SVG after every step: a step passes
  when Aster equals Vega's retained render or, where Vega keeps its first layout, a new Vega view initialised with the
  same state (counted against a ceiling, no tolerance); `pnpm conformance:signals` has the group-scope cases; live differentials of every
  selection function and of `modify` against the pinned vega; the incremental oracle edits selection stores.

- **Vega-Lite maps and animation (`@aster-charts/vl`, runtime in `@aster-charts/core`)**: `geoshape` marks, `projection` (every
  property, `config.projection`), `longitude` / `latitude` (and `2`) channels and `{type: "geojson"}` compile to what
  vega-lite 6.4.3 emits for units, layers, concats and repeats (inline GeoJSON / TopoJSON, `sphere` and `graticule`
  generators; a unit fits its projection unless it gives `scale` / `translate`); maps in a facet stay refused, because
  vega-lite emits a dataset it never defines. The `time` channel (vega-lite 6 animation: a `timer` point selection, the
  `{filter: {param}}` frame filter, a band `time` scale) compiles to vega-lite's signals, `<main>_curr` dataset and
  scale through the selection compiler (a timer selection is a point selection whose events include a timer), and its
  first frame matches real vega. Runtime: `timer` event streams on a port of d3-timer (same instants and
  `{timestamp, elapsed}` as vega), kept per chart host across re-binds and stopped on unmount / `binding.release()`;
  `setTimerClock` installs a controlled clock. A size legend beside a colour channel whose field is a condition's now
  takes the channel's constant paint, as vega-lite's. 109 `vlx-geo-*` and 17 `vlx-anim-*` corpus cases, a seeded
  compile differential for animation, live differentials for the timer scheduler and the geo pipeline, and a Playwright
  frame comparison against vega on a controlled clock (`pnpm conformance:signals`, 6 animation cases).

- **@aster-charts/vl round 2**: `config.scale` keys, `mark.invalid`, `bandSize`/`binSpacing`/secondary
  offsets, errorbar / errorband, the image mark, `"container"` sizing, `numberFormat` /
  `timeFormat` / `fieldTitle` config, vega-lite's axis order, zindex and color-legend rules, and the
  default invalid-value filter for null data.

- **@aster-charts/vl is production-usable**: every Vega-Lite feature either compiles to
  Vega that renders like vega-lite 6.4.3 or throws a `VLCompileError` naming the
  unsupported feature (compositions, encodings and transforms used to be mis-compiled silently, field names went into expressions unescaped, the compiler emitted Vega only Aster's lenient runtime accepted and mutated the caller's spec). New validation layer, one
  field-name escaping helper, VL transform translation, nested composition,
  layer parent transforms/config, sort/condition/timeUnit/bin forms, shared
  scales and legends, collision-free generated names, and `compile` never
  mutates its input. `conformance-vl` now renders our output through real vega
  and fails on vega errors or warnings. The opt-in `@aster-charts/react/vl` bundle row
  grew with it (budgets and sizes: docs/PERFORMANCE.md). Core: domain `sort: {op}` uses Vega's
  aggregate ops and ordinal `{scheme}` ranges resolve to colours.

### `@aster-charts/react`

The React bindings.

- **`@aster-charts/react`: a chart is one Tab stop.** With `pan` / `zoom` the container was a Tab stop next to the roving stop among the
  accessibility nodes (two per chart). Now the container is the only stop and the nodes are `tabindex=-1`, reached from it with
  `PageDown` / `PageUp` (the arrows pan there); without pan or zoom the roving stop stays. Focus survives a re-render, a resize, a
  spec swap and pan/zoom being switched off (it moves to the container or the stop node instead of `<body>`), and a click elsewhere
  is not undone. The jsdom tests walk the tab order of a page of charts; the Chromium gate presses the real Tab and Shift+Tab.

- **The cursor of the hovered item** (vega-view `cursor.js`): the chart container shows the `cursor` channel of the item
  under the pointer (a legend-bound Vega-Lite selection makes its symbols, labels and entries `pointer`), the spec's
  `cursor` signal wins unless it is `'default'`, and moving off the items resets it. Rendered as React state through the
  container's `style`, on `<Chart>` (SVG and canvas) and `<SvgChart interaction>`, compared with a real vega view by a
  differential test. `HitIndex.pick` (new) is vega's `event.item` (interactive items only, guide parts included), and
  legend entries and group items now carry their `cursor`.

- **`<SvgChart>` (`@aster-charts/react/lite`) and the `interaction` capability (`@aster-charts/react/interaction`)**: an SVG-only chart
  for size-sensitive apps. It never imports the canvas renderer (142.0 kB gzip against 157.2 for `<Chart>`); hit testing
  and the `signal.on` event loop arrive only as `<SvgChart interaction={interaction}>` (151.5 kB), a plain value, with no
  registry and no side-effect import. Tooltips, point selection and `preventDefault` are a compile error without it, and
  at runtime a spec with event streams (or a JS caller using those props, or `renderer="canvas"`) is reported through
  `onError` (else the logger, else the console) while the chart still renders; never a silently dead chart. `<Chart>`
  keeps its behaviour and its DOM byte for byte (the 785 corpus specs hash the same before and after); its bundle is 0.7 kB
  larger (156.5 to 157.2) because it is now a shell over the same `ChartCore` that `<SvgChart>` shares. Anti-drift: the
  shells are guarded to stay thin; every `ChartProps`/`ChartHandle` key must be shared with the same type, interaction-only,
  or excluded with a reason (`pnpm typecheck`); the React component tests run on `<Chart>`, `<SvgChart>` and `<SvgChart
  interaction>` through one matrix; and the DOM of all three is compared over the whole corpus (server markup, client mount,
  hydration). The browser gate drives every interaction check through both components, the bundle-shaking gate asserts the
  modules of each bundle, and `verify:publish` bundles and typechecks the new entries from the installed tarballs. In
  `@aster-charts/core` the SVG path parser moved to `path-data.ts` (`@aster-charts/core/canvas` re-exports it) so hit testing no longer
  reads the canvas renderer module.

- **Streaming API**: `createChartStream` (bounded queue, `coalesce`/`drop-oldest`/
  `drop-newest`/`error` policies, explicit `pending()`/`flush()`/`pulse()` and stats).
  Added compact append-only pulses, O(appended) stream snapshots/mark splicing/bounds
  and continuous-domain updates, `useChartStream` for React, and
  `useChartWorkerStream` + `handleChartWorkerStreamRequest` for worker offload.
  `collect`/`sample`/`aggregate`/`joinaggregate` now have append fast paths.

- **Streaming rendering**: `<ChartStream>`/`<ChartWorkerStream>` render streamed
  scenes through the existing DOM patcher/canvas backend/interaction/a11y tree instead
  of re-serializing SVG per flush. `useChartStream`/`useChartWorkerStream` gained
  pause/resume/close and worker accepted/rejected/depth backpressure counters; the
  worker protocol now reports queued depth and per-batch acceptance.

- **Streaming frame pacing**: `flushPolicy: 'microtask' | 'raf'` on the stream hooks;
  a real-browser `<ChartStream>` benchmark (`pnpm bench:browser-stream`) covering
  SVG/canvas, long frames, DOM mutations and node counts, with a direct Vega `view.change`
  baseline on the identical spec and row stream (SVG/canvas, `run`/`runAsync`). Canvas path/symbol
  caches, solid-paint bbox skipping, batched same-paint symbol runs and incremental append painting
  (only new mark items are drawn; full repaints still fall back safely) keep canvas streams frame-bound.
  Measured results: docs/PERFORMANCE.md.

- **Vega-Lite is opt-in**: the from-scratch VL compiler now lives behind
  `import '@aster-charts/react/vl'` instead of being imported by the base `<Chart>` entry.
  Vega specs need no addon (as before); a VL spec without it
  throws an error naming the exact import, and `registerVegaLiteCompiler` /
  `hasVegaLiteCompiler` are exported for hosts that compile VL themselves. Worker
  hosts import the addon in the worker entry. The budget gate covers both entries
  (`@aster-charts/react` and `@aster-charts/react/vl`) separately; sizes are in docs/PERFORMANCE.md.

- **Signal binds**: `<Chart>` renders `signal.bind` range/select/checkbox/radio/
  color/text controls and routes changes through the signal store; VL compilers
  preserve bind metadata. Range controls use Vega's label/slider/value layout.

- **Tooltip positioning**: the chart container now establishes a positioned ancestor
  whenever a tooltip or a11y tree is present, not only for selection/pan. Absolute
  tooltips no longer position against `<body>` and disappear above the viewport after
  scrolling. The demo also scales oversized SVGs to the pane width for side-by-side
  comparison.

- **Demo polish**: relative `url: "data/..."` paths now strip the `data/` prefix and
  resolve to the official Vega datasets host (with a fallback host), so copy/pasted
  Vega examples work; the playground recursively resolves nested data URLs. Removed
  the double chart container in the gallery aster column, updated stale hero stats,
  and fixed default text marks to emit Vega's 11px sans-serif instead of inheriting
  the browser's 16px default.

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
  `@aster-charts/vl`; no `vega-lite` runtime dependency.

- **Async/SSR/worker**: `useSpecData`/`useChartData` (Suspense + `use()`),
  promise specs, `renderChartToStaticMarkup` + `hydrateChart`, and
  `useChartWorker` with a synchronous fallback.

### Performance and benchmarks

Entries that are mainly about speed or size; they touch `@aster-charts/core` and `@aster-charts/react`.

- **`@aster-charts/core` is about 1 kB gzip smaller (144,479 to 143,481 bytes), and every `@aster-charts/react` row follows (`useChart` -951, `<Chart>` -945,
  `<SvgChart>` -919, `<SvgChart>` + interaction -949, `<Chart>` + VL -936).** Nothing changes in what is drawn or computed: the expression
  host table no longer restates the Math, date, string and clock functions the interpreter's default table already provides (`now()` still
  reads `Date.now` when it is called); the categorical colour schemes are runs of hex like the others; the log, power and symlog maps of
  scales and of pan / zoom are written once; the fallback for a refused `timeUnitSpecifier` and the built-in scale ranges read the tables
  they used to copy; the undocumented `ASTER_DEBUG_PAD` console dump is gone. New guards: `differential-expression-math` (the plain
  built-ins against real Vega) and `time-unit-format` (what an axis labels with a refused `timeUnitSpecifier`).

- **Performance: the 200k-row `crossfilter-flights` gallery spec.** On the React path it took 4-5 s (8 s and more under load,
  past the gallery's settle budget) because a chart given a `random` source fingerprinted every row of every dataset transform
  that could not draw from it; now only the code that can draw (`random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`,
  `sample`, `wordcloud`, the `ci0` / `ci1` ops) is. `crossfilter` places tuples against a range without sorting when the field
  holds only numbers, and a dataset declared in a group starts from the rows it is made from instead of copying them when its
  first transforms only read them (`resolvefilter` + `aggregate` copies nothing). Time to a stable svg in Chromium, measured
  against vega on the same data: 5.0 s to 0.5 s with a `random` source (vega 0.6 s); the output is unchanged.

- **Dense SVG streams**: an append no longer re-scans every full chunk of a 100k-symbol mark (patch 1.8 ms to
  0.8 ms); `bench:incremental` gates it against a full mount. The browser stream bench states its symbol fill
  (vega draws a bare symbol filled; the old numbers measured an empty layer).

- **Performance gate**: `pnpm bench:incremental` runs in CI (10k points, 30 updates) and nightly
  (100k/40) and fails below measured floors (append 8x, whole-array replace 8x, DOM patch 1.6x, dense append patch vs mount 200x; the first three are about half of the
  slowest run measured when they were set). It also runs a direct Vega baseline (`view.change(...).run()`, renderer
  `none`) on the same workload. Measured results: docs/PERFORMANCE.md.

- **No-op re-renders**: identical-content re-renders (fresh spec object, stable data)
  no longer mutate the DOM. `<Chart>` no longer calls `getChartInfo()` (a second compile+evaluate)
  from an effect: interaction/a11y metadata derives from the evaluated scene via
  `chartInfoFromScene`. The markup string also leaves the props after the first
  commit — React re-applies a present `dangerouslySetInnerHTML`, so the cached
  string was making every "incremental" render re-parse the whole SVG. Mount skips
  the now-redundant patch, canvas skips identical scenes, and `patchSceneDom` gained
  an identity-prefix append path (O(appended) instead of re-walking siblings).

- **Evaluation skips overflow padding for fixed-size charts**: with
  `autosize: 'none'` the evaluator no longer measures every top-level group's
  recursive bounds (Vega's viewSizeLayout does not grow such a viewport), which was the
  dominant cost of a one-row update on a large chart; the differential speedups rise
  accordingly (docs/PERFORMANCE.md).
  `autosize: pad/fit` charts keep the full pass; conformance output is unchanged.

- **Faster row diff**: `rowsEqual` uses `for...in` (no `Object.keys` allocations)
  for plain rows: faster auto-pulse inference on wholesale array replacement.

- **Wholesale-array replacement benchmark**: `bench:incremental` now measures the
  `<Chart data={next}>` path (no explicit changes) end to end. The session
  infers the pulse from the row diff; the gate compares it with a full evaluation (docs/PERFORMANCE.md).

- **Benchmark warm-up**: the jsdom and browser runners mount every embed once
  before measuring and discard a first full pass, removing the first-embed JIT
  penalty that made identical paths differ.

- **Dense SVG marks by default**: `denseMarks` defaults to `'auto'`: symbol marks with at least 512 items
  batch into chunked `<path>` elements (positions baked into `d`, 256 items per chunk) instead of one transformed
  element per datum, unless the spec uses `signal.on` event streams (`true` forces, `false` disables, and
  `denseMarks={false}` keeps the per-item DOM). Client-only mounts batch directly; SSR emits the per-item markup so
  hydration matches, then switches to batched in place. Chunks are cached per mark group and only the tail chunk is
  re-serialized per append; translucent marks stay per-item (compositing), rotated marks keep their element, and
  tooltips/point selection/a11y resolve through the scene. `pnpm conformance:batch` rasterizes batched vs per-item
  DOMs and gates pixel parity. Symbol descriptor build is also cached per group for the normal path. Measured
  results: docs/PERFORMANCE.md.

### Tooling, tests, release and docs

Gates, test suites, release checks and documentation, none of it shipped in the packages.

- **Tree-shaking works (`sideEffects`)**: `@aster-charts/core` and `@aster-charts/react` declare the files whose import has an effect
  (the geo/transforms/load addons, the guide captions, `@aster-charts/react/vl`, the worker entry), `@aster-charts/vl` declares none.
  `import { useChart } from '@aster-charts/react'` goes from 164.1 to 126.4 kB gzip, `<Chart>` from 163.9 to 156.5, `<Chart>`
  + VL from 218.3 to 210.7. `pnpm check:bundle` bundles and executes each documented import pattern (a blanket
  `false` fails it), the budget gates one bundle per pattern with the addons as marginal cost, and `pnpm
  verify:publish` executes a tree-shaken bundle of the installed tarballs. The Vega-Lite validator is 4.1 kB
  smaller minified with every check and message unchanged (one exception: a scale-config typo named after an
  `Object.prototype` member, e.g. `scale: {toString: 1}`, now says `unknown scale property` instead of printing
  the native function source).

- **Release tooling and docs**:
  - `pnpm verify:publish` packs with `pnpm pack` (what the release uses), fails on any `workspace:` range in a packed
    manifest, installs the tarballs with `npm install` into a scratch project (offline), imports every declared export
    entry and typechecks a consumer file (`module: nodenext`).
  - `.github/workflows/release.yml`: version tags only, a read-only `verify` job (tag equals every package version,
    commit on main, `pnpm check`, `pnpm pack`) and a separate `publish` job in the protected `npm-release`
    environment that alone holds `id-token: write` and installs nothing; actions pinned by commit SHA.
    `scripts/release-workflow.test.mjs` asserts this on the workflow file.
  - `THIRD_PARTY_NOTICES.md` carries the verbatim `LICENSE` texts of every ported project (`vega-*`, Vega-Lite, `d3-*`,
    `delaunator`, `robust-predicates`, `internmap`, `topojson-client`, the d3-cloud notice); `scripts/notices.test.mjs`
    checks them against `node_modules` and that every upstream name the sources port is listed.
  - `pnpm bench:incremental` fails below measured floors; `budget.mjs` refuses a stale `dist`, has an
    `@aster-charts/core/load` row, and its ceilings are measured + 0.5 kB.
  - README, ARCHITECTURE, ROADMAP, API, INTERACTION, LIMITS, ERRORS, FONTS, PERFORMANCE, TESTING, RELEASE, the ADRs and
    the package READMEs describe the current code; measured numbers appear only with the command that produced them
    (docs/TESTING.md, docs/PERFORMANCE.md). The README minimal example uses `data: [{ name, values }]` and runs.
  - Removed dead code: the five unimported `.d.ts` module shims, `scale-d3` `band`/`point`, VL `overlayFilled` and
    `intervalParams`, the compiler's `resolveSizeSpec`, and unreferenced runtime helpers. Added root scripts
    `bench:differential` and `bench:pipeline`.

- **Browser gates in `pnpm check`**: `react-browser` (`pnpm --filter @aster-charts/react run test:browser`) and
  `browser-conformance` (`conformance:browser`, 785/785, now comparing vega's string renderer with an
  explicitly sized container) join the gate list.

- **Publish artifacts are tested**: new `pnpm verify:publish` packs every public
  package, asserts the tarball carries `LICENSE` + `THIRD_PARTY_NOTICES.md`
  (copied by a `prepack` step) plus `dist`/types, then extracts the tarballs into
  a clean `node_modules` and imports every declared entry (`@aster-charts/core` addons,
  `@aster-charts/react`, `/vl`, `/ssr`, `/worker`) to render Vega and Vega-Lite specs.
  It runs in `pnpm check` (CI, nightly and the release workflow), and now packs with `pnpm pack`, fails on a
  `workspace:` range, installs the tarballs with `npm install`, imports every declared export and typechecks a
  consumer file. This caught a real packaging
  bug: `@aster-charts/react`'s barrel used extensionless relative imports, which
  bundlers accept but Node ESM rejects (SSR/worker consumers would fail to
  import the published package) — fixed.

- **Canvas hardening**: pixel gate now runs Chromium/Firefox/WebKit with a tighter
  1px/4%/2.5 tolerance, plus custom-font and multi-line fixtures.

- **Environment coverage**: locale matrix (number/date formatting plus rendered axis
  labels), custom-font provider matrix (font-string propagation, narrow/wide layout,
  invalid-provider fallback and cache invalidation), malformed URL/data tests, rare
  addon transforms (`kde`/`regression`/`loess`/`pack`/`partition`/`treemap`/`voronoi`)
  in the transform matrix, and a headless-Chromium canvas pixel-parity gate
  (`pnpm conformance:canvas`).

- **Accessibility**: axe WCAG A/AA audit for the chart tree, guide-caption parity
  against Vega's `aria-label` (`pnpm a11y-parity`), and keyboard-operable legend entries
  (`aria-pressed`) that filter shape/paint series.

- **Conformance rigour**: added the scene-level differential (`pnpm scene-diff`) comparing resolved
  scale maps per scope, mark/item geometry/paint and overlap paint order against Vega's scenegraph, and the schema
  sweeps (`pnpm sweep-vega`, `pnpm sweep-vl`, `pnpm sweep-signals`) with required floors. Results and the
  commands that produce them: docs/TESTING.md. Closed identity scales, horizontal area baselines,
  fractional/negative view sizes, log/symlog NaN symbols, title anchors, rotated path bounds, clip-bound
  epsilons and scene paint order.

- **Tooling**: per-entry bundle gates (core, dom, canvas, hit, signals, React);
  deterministic differential fuzzer with committed reproducers; nightly sweep
  workflow; tag-triggered release workflow with npm provenance.

- **Docs**: API, errors, limits, testing, fonts, performance, interaction and release
  guides; ADRs 0002–0004.

### Earliest entries, not tied to a feature

These are the unlabelled bullets at the end of the log, so the oldest entries.

- Closed sweep tails: guide-scale ranges/domains, facet header
  `labelOrient`/`orient`, config axis/header precedence, axis orient/grid
  geometry, label angle anchors, tick/label tails, `values` aggregate
  domains, size-legend grid layout, and `config.point` cross-block geometry.
- Vega transform parity: `bin` step/anchor/base/divide/minstep/span/steps
  options and interval mode (oracle-vector tested), full `window` ops/frames/ignorePeers/params,
  `joinaggregate.key`, and signal-valued `impute.keyvals`.
- React: `onPointSelect` click selection, `renderTooltip` React slot,
  `useChart` headless hook, canvas redraw scheduling on `requestAnimationFrame`.
- Core: typed `SpecLimits`/`AsterLimitError` budgets for untrusted specs.
- Added BSD-3-Clause license, contribution guide and third-party notices.
