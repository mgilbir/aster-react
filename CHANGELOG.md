# Changelog

## Unreleased

- **Transform gaps against real vega** (generated, live differentials over the parameter space):
  - `quantile` skips `null` like d3-array (`quantile([null, null], 0.25)` was 0, and a column with nulls shifted every percentile).
  - `contour`, `isocontour`, `kde2d` and `heatmap` follow vega: `scale: 0` and a falsy `translate` fall back to the grid's;
    `contour` spreads its default thresholds from zero when `values` are given; thresholds keep the order given (repeats too);
    a null cell reads as 0, a NaN one is below every level and smooths to a NaN coordinate; an estimated bandwidth no longer
    counts a null or empty coordinate as 0; a list parameter written as a plain value, a missing required parameter, an invalid
    cell size or bandwidth are refused with vega's messages, in vega's order.
  - `force` refuses a bad `forces` list with vega's messages (`Unsupported parameter: {"force":"gravity"}`, `Expected an array of
    sub-parameters`, `Undefined data set name` for a link force). Not fixed: the wording of an expression syntax error is still
    the parser's, not `Expression parse error: ...`.

- **`@aster/core` geo engine in Aster's own design** (`geo-events.ts`, `geo-sphere.ts`, `geo-clip.ts`, `geo-resample.ts`,
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

- **Performance: the 200k-row `crossfilter-flights` gallery spec.** On the React path it took 4-5 s (8 s and more under load,
  past the gallery's settle budget) because a chart given a `random` source fingerprinted every row of every dataset transform
  that could not draw from it; now only the code that can draw (`random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`,
  `sample`, `wordcloud`, the `ci0` / `ci1` ops) is. `crossfilter` places tuples against a range without sorting when the field
  holds only numbers, and a dataset declared in a group starts from the rows it is made from instead of copying them when its
  first transforms only read them (`resolvefilter` + `aggregate` copies nothing). Time to a stable svg in Chromium, measured
  against vega on the same data: 5.0 s to 0.5 s with a `random` source (vega 0.6 s); the output is unchanged.

- **Formatting layer in Aster's own design** (`format.ts`, `time-format.ts`, `time.ts`, `locale.ts`, `color.ts`). Number and date
  formatting, the calendar intervals, the time-unit floors, the locale facade and the colour spaces are re-decomposed (a specifier is
  parsed, settled in a locale and rendered; a directive is written once over a time base; a calendar unit is a record `makeInterval`
  turns into an interval; the colour grammar is built from slots) with output unchanged. New generated live differentials against the
  pinned d3-format, d3-time, d3-time-format, d3-color, vega-time and vega-format found and fixed: locale `grouping` / `numerals` given
  as array-likes; the stale SI prefix of an `s` format of a NaN whose locale text is empty or numeric; `formatFloat` under non-ASCII
  numerals returning `''`; `%Z` parsing half-hour offsets; the dedicated `timeYear.every(k)` / `utcYear.every(k)`; and a second, older
  `tickStep` that `formatSpan` and `timeBin` used. `timeUnitSpecifier` no longer loops forever on a specifier table that blanks a unit.
  Not fixed (another module): `timeBin` with a NaN extent picks the year grain where vega-time picks milliseconds.

- **`@aster/vl`: selections and composite marks in Aster's own design** (`selection*.ts`, `composite*.ts`). A selection is resolved
  against its unit into a model and wired by one sequence of steps over the signals it makes; the three composite marks share one
  anatomy and one part builder. The compiled Vega is unchanged on the 2769 specs of the matrices, the corpus and the gallery. New
  matrices compare with vega-lite 6.4.3 every selection type x option x binding x resolve x composition (876 cases) and every
  composite mark x extent x orientation x input x part x composition, plus path overlays and colour-ordered stacks (583 cases).
  What they found and fixed: a `{param}` domain keeps zero off; a horizontal area with `x2` ends at `x2`; `config.rule` /
  `config.text` keep their black against `config.mark.color`; a mark with `aria: false` encodes no role description; the mark
  inside a path group keeps the mark definition's styles; composite marks group by every entry of a `tooltip` / `detail` list
  and list a conditional field in their tooltip. Not fixed (pinned in the cases file): composite marks inside a `repeat`.

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
- **The cursor of the hovered item** (vega-view `cursor.js`): the chart container shows the `cursor` channel of the item
  under the pointer (a legend-bound Vega-Lite selection makes its symbols, labels and entries `pointer`), the spec's
  `cursor` signal wins unless it is `'default'`, and moving off the items resets it. Rendered as React state through the
  container's `style`, on `<Chart>` (SVG and canvas) and `<SvgChart interaction>`, compared with a real vega view by a
  differential test. `HitIndex.pick` (new) is vega's `event.item` (interactive items only, guide parts included), and
  legend entries and group items now carry their `cursor`.
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
  - The bundle budgets of the rows that contain `@aster/core` were raised by 7.2 kB gzip (130.8 kB for core). Guides cost
    more per item than before (every channel of every tick and label is Vega's own encode): see docs/PERFORMANCE.md.
- **Vega-Lite params and selections**: `@aster/vl` compiles point and interval selections, `bind` to inputs / legend /
  scales, `{param}` conditions, predicates and filters, lookups from a selection, `scale.domain` `{param}` /
  `{unionWith}` and value params as vega-lite 6.4.3 does (a port of `compile/selection/*`), on a unit view and on the
  units of a layer and of a concat, facet or repeat view (linked brushing across views, a brush or a point per facet cell, a
  selection declared on the composition and given to every unit below it: each unit's signals are its group's, a Vega group
  scope). `@aster/core` gains group-scoped signals as Vega defines them (one copy per group item, shadowing, `push:
  "outer"`, `scope`-source events, streams shared with the enclosing scope, `group()`/`inScope` over the scope's group, a
  group item picked where it has a fill or stroke, a facet cell's datum a tuple with `count`), the event loop keeps their
  values under `<scope id>:<name>`, and clipped marks no longer grow a group title's frame. `@aster/core` gains
  the expression functions behind them (vega-selections' `vlSelectionTest` / `vlSelectionIdTest` /
  `vlSelectionResolve` / `vlSelectionTuples`, `modify` with vega's changeset semantics, `isTuple`, the pan / zoom
  functions, faithful `inrange` and `clampRange`), `{scale}` event sources, and datasets the event loop edits
  (`hooks.onData`); `<Chart>` keeps the edited rows. Runtime gaps closed on the way: legend part names and
  interactive legends, a mark that reads another mark's items, the voronoi mark transform, pointer events on
  transparent items and on the painted frame. Gates: 70 `vlx-sel-*` corpus specs render like vega-lite's output in
  real vega and in Aster and compile to vega-lite's own signals, stores and marks (a structure test); `pnpm
  conformance:selections` drives the same native input through vega-lite + vega and `@aster/vl` + `<Chart>` (37 cases,
  composed views among them) and compares signals, group-scope signals, stores and SVG after every step: a step passes
  when Aster equals Vega's retained render or, where Vega keeps its first layout, a new Vega view initialised with the
  same state (counted against a ceiling, no tolerance); `pnpm conformance:signals` has the group-scope cases; live differentials of every
  selection function and of `modify` against the pinned vega; the incremental oracle edits selection stores.
- **Vega-Lite maps and animation (`@aster/vl`, runtime in `@aster/core`)**: `geoshape` marks, `projection` (every
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

- **`<SvgChart>` (`@aster/react/lite`) and the `interaction` capability (`@aster/react/interaction`)**: an SVG-only chart
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
  `@aster/core` the SVG path parser moved to `path-data.ts` (`@aster/core/canvas` re-exports it) so hit testing no longer
  reads the canvas renderer module.

- **Tree-shaking works (`sideEffects`)**: `@aster/core` and `@aster/react` declare the files whose import has an effect
  (the geo/transforms/load addons, the guide captions, `@aster/react/vl`, the worker entry), `@aster/vl` declares none.
  `import { useChart } from '@aster/react'` goes from 164.1 to 126.4 kB gzip, `<Chart>` from 163.9 to 156.5, `<Chart>`
  + VL from 218.3 to 210.7. `pnpm check:bundle` bundles and executes each documented import pattern (a blanket
  `false` fails it), the budget gates one bundle per pattern with the addons as marginal cost, and `pnpm
  verify:publish` executes a tree-shaken bundle of the installed tarballs. The Vega-Lite validator is 4.1 kB
  smaller minified with every check and message unchanged (one exception: a scale-config typo named after an
  `Object.prototype` member, e.g. `scale: {toString: 1}`, now says `unknown scale property` instead of printing
  the native function source).
- **Accessibility structure of the SVG (N3)**: axes, legends and titles are drawn as vega-scenegraph draws them
  (`<g class="mark-group role-axis" role="graphics-symbol" aria-roledescription="axis" aria-label="...">` around
  the item group, its background and foreground paths and one container per guide mark), every group mark has
  its container, data marks carry vega's class (`mark-rect role-mark <name>`), `aria-roledescription` and
  `aria-label`, and items carry `aria-label` / `role` / `aria-roledescription` from `description`, `ariaRole`,
  `ariaRoleDescription` (`aria: false` hides). The old `role="axis"` was no ARIA role. The captions are one
  implementation shared with the accessible tree. The strict canonicalizer compares this structure, so it
  can not drift again; `@aster/vl` now emits vega-lite's `description`, `ariaRoleDescription` and mark names.
  The corpus SVG changes (759 of 785 files); the pictures do not.
- **Spec lists are vega's (C80)**: `data: {values: [...]}`, a lone mark or scale object and `null` are read
  through vega-util `array()` as in vega-parser, and a data set used without being declared is
  `SpecParseError: Undefined data set name: "<name>"` (as `vega.parse`), in `compileChart` and so in every host.
  `checkSpecLimits` counts the same lists.
- **Dense SVG streams**: an append no longer re-scans every full chunk of a 100k-symbol mark (patch 1.8 ms to
  0.8 ms); `bench:incremental` gates it against a full mount. The browser stream bench states its symbol fill
  (vega draws a bare symbol filled; the old numbers measured an empty layer).
- **Release tooling and docs (audit C75, C77, C79, C80-C82, C86, C87, C89)**:
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
    `@aster/core/load` row, and its ceilings are measured + 0.5 kB.
  - README, ARCHITECTURE, ROADMAP, API, INTERACTION, LIMITS, ERRORS, FONTS, PERFORMANCE, TESTING, RELEASE, the ADRs and
    the package READMEs describe the current code; measured numbers appear only with the command that produced them
    (docs/TESTING.md, docs/PERFORMANCE.md). The README minimal example uses `data: [{ name, values }]` and runs.
  - Removed dead code: the five unimported `.d.ts` module shims, `scale-d3` `band`/`point`, VL `overlayFilled` and
    `intervalParams`, the compiler's `resolveSizeSpec`, and unreferenced runtime helpers. Added root scripts
    `bench:differential` and `bench:pipeline`.

- **Guides driven by signals, like vega (sweep-signals: 30 differences to 0, now a blocking gate)**: every
  axis and legend property may be a signal and a signal may hold anything; an axis `orient` signal is
  resolved when its value is known (any orient but the four is a vertical axis at the origin whose layout
  never runs); a tick count that is an interval string on a non-time scale, or a format that is no
  specifier, fails the axis ticks as in vega (logged, axis not drawn); titles exist whatever their text
  (empty text draws an empty `<text>`, a list is lines; an empty-string title is none); legend titles may be
  signals; a mark's `clip` (boolean or signal) bounds the mark to the enclosing frame (vega boundClip); the
  view width signal can be null or a word, and a negative width or height is laid out in vega's two passes;
  a text angle that is a word is written `rotate(word)`.
- **`registerExpressionFunction`** (`@aster/core`): vega's `expressionFunction`, the hook for Vega-Lite's
  custom `formatType`. `@aster/vl` now emits vega-lite's custom format types (text, tooltip, href,
  description, axis and legend labels, headers; `config.customFormatTypes`, `numberFormatType`,
  `normalizedNumberFormatType`, `timeFormatType`), explicit scale domains with vega-lite's `zero` / `nice`
  rules (continuous x / y, size, opacity and colour scales ignored them before), `zero` / `nice` on
  `pow` / `sqrt` / `symlog` position scales, and non-array, non-`"unaggregated"` scale domains (emitted as
  written; vega refuses them, so does the runtime with `SpecParseError`). The nightly Vega-Lite sweep has no
  engine errors left.
- **Browser gates in `pnpm check`**: `react-browser` (`pnpm --filter @aster/react run test:browser`) and
  `browser-conformance` (`conformance:browser`, 785/785, now comparing vega's string renderer with an
  explicitly sized container) join the gate list.

- **Group marks are vega scopes (audit C51, C55, C58, corpus-vega-only drained)**: every group mark
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
- **@aster/vl round 2**: `config.scale` keys, `mark.invalid`, `bandSize`/`binSpacing`/secondary
  offsets, errorbar / errorband, the image mark, `"container"` sizing, `numberFormat` /
  `timeFormat` / `fieldTitle` config, vega-lite's axis order, zindex and color-legend rules, and the
  default invalid-value filter for null data.
- **@aster/vl is production-usable**: every Vega-Lite feature either compiles to
  Vega that renders like vega-lite 6.4.3 or throws a `VLCompileError` naming the
  unsupported feature (audit C34-C37, C71-C74, C97). New validation layer, one
  field-name escaping helper, VL transform translation, nested composition,
  layer parent transforms/config, sort/condition/timeUnit/bin forms, shared
  scales and legends, collision-free generated names, and `compile` never
  mutates its input. `conformance-vl` now renders our output through real vega
  and fails on vega errors or warnings. The opt-in `@aster/react/vl` bundle row
  grew with it (budgets and sizes: docs/PERFORMANCE.md). Core: domain `sort: {op}` uses Vega's
  aggregate ops and ordinal `{scheme}` ranges resolve to colours.
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
- **DOM, canvas and hit-testing fixes** (audit C3, C22, C23, C41, C43, C47, C96): the
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
- **Streaming API**: `createChartStream` (bounded queue, `coalesce`/`drop-oldest`/
  `drop-newest`/`error` policies, explicit `pending()`/`flush()`/`pulse()` and stats).
  Added compact append-only pulses, O(appended) stream snapshots/mark splicing/bounds
  and continuous-domain updates, `useChartStream` for React, and
  `useChartWorkerStream` + `handleChartWorkerStreamRequest` for worker offload.
  `collect`/`sample`/`aggregate`/`joinaggregate` now have append fast paths.
- **Performance gate**: `pnpm bench:incremental` runs in CI (10k points, 30 updates) and nightly
  (100k/40) and fails below measured floors (append 8x, whole-array replace 8x, DOM patch 1.6x, dense append patch vs mount 200x; the first three are about half of the
  slowest run measured when they were set). It also runs a direct Vega baseline (`view.change(...).run()`, renderer
  `none`) on the same workload. Measured results: docs/PERFORMANCE.md.
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
- **No-op re-renders**: identical-content re-renders (fresh spec object, stable data)
  no longer mutate the DOM. `<Chart>` no longer calls `getChartInfo()` (a second compile+evaluate)
  from an effect: interaction/a11y metadata derives from the evaluated scene via
  `chartInfoFromScene`. The markup string also leaves the props after the first
  commit — React re-applies a present `dangerouslySetInnerHTML`, so the cached
  string was making every "incremental" render re-parse the whole SVG. Mount skips
  the now-redundant patch, canvas skips identical scenes, and `patchSceneDom` gained
  an identity-prefix append path (O(appended) instead of re-walking siblings).
- **Vega-Lite is opt-in**: the from-scratch VL compiler now lives behind
  `import '@aster/react/vl'` instead of being imported by the base `<Chart>` entry.
  Vega specs need no addon (as before); a VL spec without it
  throws an error naming the exact import, and `registerVegaLiteCompiler` /
  `hasVegaLiteCompiler` are exported for hosts that compile VL themselves. Worker
  hosts import the addon in the worker entry. The budget gate covers both entries
  (`@aster/react` and `@aster/react/vl`) separately; sizes are in docs/PERFORMANCE.md.
- **Evaluation skips overflow padding for fixed-size charts**: with
  `autosize: 'none'` the evaluator no longer measures every top-level group's
  recursive bounds (Vega's viewSizeLayout does not grow such a viewport), which was the
  dominant cost of a one-row update on a large chart; the differential speedups rise
  accordingly (docs/PERFORMANCE.md).
  `autosize: pad/fit` charts keep the full pass; conformance output is unchanged.
- **Faster row diff**: `rowsEqual` uses `for...in` (no `Object.keys` allocations)
  for plain rows: faster auto-pulse inference on wholesale array replacement.
- **Publish artifacts are tested**: new `pnpm verify:publish` packs every public
  package, asserts the tarball carries `LICENSE` + `THIRD_PARTY_NOTICES.md`
  (copied by a `prepack` step) plus `dist`/types, then extracts the tarballs into
  a clean `node_modules` and imports every declared entry (`@aster/core` addons,
  `@aster/react`, `/vl`, `/ssr`, `/worker`) to render Vega and Vega-Lite specs.
  It runs in `pnpm check` (CI, nightly and the release workflow), and now packs with `pnpm pack`, fails on a
  `workspace:` range, installs the tarballs with `npm install`, imports every declared export and typechecks a
  consumer file. This caught a real packaging
  bug: `@aster/react`'s barrel used extensionless relative imports, which
  bundlers accept but Node ESM rejects (SSR/worker consumers would fail to
  import the published package) — fixed.
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
- **Nested scopes / axes**: nested group marks now inherit outer scales (local names
  still shadow), so raw Vega specs that reference a parent `y` or colour scale render
  inside groups (population pyramid). Vega-Lite compilation now emits all grid axes
  before all label axes, matching Vega's paint order (the x-axis domain is no longer
  covered by the y-grid line). Band-sized encodes now apply `offset`/`mult` (e.g.
  `height: {scale:'y', band:1, offset:-1}`), restoring the 1px bar gaps.
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
- **Canvas hardening**: pixel gate now runs Chromium/Firefox/WebKit with a tighter
  1px/4%/2.5 tolerance, plus custom-font and multi-line fixtures.
- **Environment coverage**: locale matrix (number/date formatting plus rendered axis
  labels), custom-font provider matrix (font-string propagation, narrow/wide layout,
  invalid-provider fallback and cache invalidation), malformed URL/data tests, rare
  addon transforms (`kde`/`regression`/`loess`/`pack`/`partition`/`treemap`/`voronoi`)
  in the transform matrix, and a headless-Chromium canvas pixel-parity gate
  (`pnpm conformance:canvas`).
- **Canvas fixes (found by the Chromium gate)**: relative `H`/`V` path commands now
  carry the current point across each other (rects previously painted from
  `y - height`), canvas text no longer passes a boolean as `maxWidth`, scene siblings
  are ordered axes → marks → legends → title like Vega, and custom `labelFont`/
  `titleFont` families reach axis/legend text metrics.

- **Pulse/dataflow**: sessions automatically diff replaced immutable source arrays
  (`autoChanges`, default on), expose source/transform pulses via `session.pulse()`,
  and reuse unchanged items without an explicit `dataChanges` props. Sorted
  window/stack groups now consume dirty-group pulses instead of falling back.
- **Accessibility**: axe WCAG A/AA audit for the chart tree, guide-caption parity
  against Vega's `aria-label` (`pnpm a11y-parity`), and keyboard-operable legend entries
  (`aria-pressed`) that filter shape/paint series.
- **Transforms**: transform option matrix (bin/window/stack/joinaggregate/impute/
  fold/flatten/pivot/lookup/sequence/identifier/timeunit/extent), fixing impute
  tuple fields, sequence append semantics and identifier assignment.
- **Text metrics**: pluggable `TextMetricsProvider` on core/`<Chart>` for custom
  fonts and non-browser renderers, with provider-scoped caching and safe fallback.

- **Conformance rigour**: added the scene-level differential (`pnpm scene-diff`) comparing resolved
  scale maps per scope, mark/item geometry/paint and overlap paint order against Vega's scenegraph, and the schema
  sweeps (`pnpm sweep-vega`, `pnpm sweep-vl`, `pnpm sweep-signals`) with required floors. Results and the
  commands that produce them: docs/TESTING.md. Closed identity scales, horizontal area baselines,
  fractional/negative view sizes, log/symlog NaN symbols, title anchors, rotated path bounds, clip-bound
  epsilons and scene paint order.

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
  `@aster/vl`; no `vega-lite` runtime dependency.
- **Async/SSR/worker**: `useSpecData`/`useChartData` (Suspense + `use()`),
  promise specs, `renderChartToStaticMarkup` + `hydrateChart`, and
  `useChartWorker` with a synchronous fallback.
- **Limits**: `maxTimeMs` wall-clock deadline checked across compile/evaluate/render
  and inside dataset/encode loops; `domainRaw` scale overrides in core.
- **Tooling**: per-entry bundle gates (core, dom, canvas, hit, signals, React);
  deterministic differential fuzzer with committed reproducers; nightly sweep
  workflow; tag-triggered release workflow with npm provenance.
- **Docs**: API, errors, limits, testing, fonts, performance, interaction and release
  guides; ADRs 0002–0004.

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
