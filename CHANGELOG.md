# Changelog

Version 0.1.0 is the first release. From 0.1.0 on, entries are added per release under Added, Changed
and Fixed, per package. Everything built before the first release is in [Pre-release history](#pre-release-history) below.

## Unreleased

The fixes of the 2026-11-22 codebase audit (finding IDs `C<n>` in parentheses, design tensions `T1`
to `T5` and the maintainer's decisions `Q<n>` are the audit's). Many entries are **breaking**: each is marked and carries its **Migration**. Sizes: every
bundle row grew with the correctness work (core entry 177.1 to 206.3 kB gzip, `<Chart>` 190.4 to 226.0, `<Chart>` + Vega-Lite 296.7 to 367.5, by the
budget's method on origin/main and on this tree); docs/PERFORMANCE.md has the table and the paths that cost more than before, with numbers.

### `@aster-charts/core`

#### Changed (breaking)

**URLs, security defaults and the output**

- **Every URL in the output is vetted where it is written, by default** (Q3; C1, C3, C8, C20, C97, T1). The two SVG sinks (string and DOM), the urls a
  canvas host loads (`sceneImageUrls`, so `<Chart>` on canvas and `renderSceneToPng`) and the cursor a host shows (`resolveCursor`) apply the URL policy the
  scene was evaluated under, else the defaults, whatever channel or code path put the URL on the scene. With no `urlPolicy` and no `limits` a link is now
  one of `http:`, `https:`, `mailto:`, `tel:` or relative, an image one of `http:`, `https:`, `data:` or relative, neither with credentials; anything else
  is not written (the item is drawn without its link; an image with an empty `href`), where vega writes it. **Migration:** a chart that links `ftp:`,
  `file:`, `data:`, `cid:`, `xmpp:` or `callto:` URLs, or draws `file:` / `blob:` images, with no policy must pass `urlPolicy: { protocols: [...] }`
  naming them. A scene posted from a worker carries no policy and is vetted against the defaults where it is drawn: widened `protocols` apply in the
  worker only.
- **An encode channel may not name the engine's own item state** (C1). A channel that starts with `_` (`__domDesc`, `_hit`, `_drawError`, `__proto__`, ...)
  or is a field of the engine's scene types and not vega's (`items`, `marktype`, `role`, `datum`, `mark`, `dataDatum`, `urlDenied`, `titleRole`, ...), in any
  encode block or config style / mark default, is a `SpecParseError` when the spec is compiled: `Encode channel "<name>" (<where>) names a property the
  engine keeps on its scene items for itself; it cannot be encoded.` **Migration:** rename such a custom channel; vega's channels, the fields vega's
  scenegraph reads besides its schema (`href`, `fontVariant`, `image`, ...) and any other name are accepted as before.
- **The cursor is a CSS keyword or nothing** (C97): the cursor vega's rule picks is shown (`resolveCursor`, `<Chart>`'s container) only when it is a CSS
  cursor keyword; any other text, a `url(...)` cursor (which the viewer's browser would fetch past the URL policy) included, leaves the cursor as it was.
  **Migration:** a spec that needs an image cursor cannot have one.
- **The accessible tree's label is the view's description** (C289): the spec's `description`, else `config.description` ("Vega visualization" by
  default), as vega-view labels its container; the default used to be "Data visualization". `SceneRoot.description` carries it; the dead
  `SceneRoot.ariaLabel` / `ariaRole` and `SceneItem.ariaLabel` fields are gone. **`FontProps.fontFamily` is gone** (C551): the family is the item's
  `font`, as vega's `font()` reads it; the canvas painter and the measurer build one font string (`fontString`).
- **A handler sees an event facade, not the DOM event** (C4). `signal.on` handlers, event-stream filters and what they re-evaluate get a frozen read-only
  view of the event's plain fields (`EVENT_FACADE_FIELDS`: type, `vegaType`, time, buttons, coordinates, modifier keys, wheel deltas, pointer and touch
  fields, a timer's `timestamp` / `elapsed`; each read off the event when an expression reads it, as vega reads it, and only a number, string or boolean;
  touches as frozen copies) plus the extension vega-view gives it (`item`, `vega`, `dataflow`); `target`, `currentTarget`, `composedPath`, `view` and every
  other host object are gone. **Migration:** a spec that read `event.target...` (or any field not in the list) reads `undefined`; use `event.item`.
- **Window and CSS-selector event sources are decided by the host** (C4, C78). `bindSceneSignals(..., { eventSources })` takes an `EventSourcePolicy`
  (`{ window?, selector? }`, each `true`, `false` or a list of event types). The default, `DEFAULT_EVENT_SOURCES`, allows the window's pointer and touch
  moves, ends and cancels and `resize`, and no selector source: a spec can no longer listen to the page's keys, inputs, clipboard or focus, nor to elements
  outside the chart. A spec's `config.events` (`view`, `window`, `selector`, `timer`) is applied as vega applies it and can only narrow the policy. An
  invalid CSS selector source is reported once per chart (docs/LIMITS.md, "Interactive charts and untrusted specs"). **Migration:** a host that renders
  trusted specs needing `window:keydown` or `#id:click` passes `eventSources: { window: true, selector: true }` (or the types it allows); in React the
  prop of `<Chart>` is `eventSources`.
- **Expressions never hand out a built-in prototype** (C384, C285): a member read of `__proto__`, a function's `prototype`, `constructor` paths and
  similar on any receiver reads `undefined`; host getters are not run; `Function` / `eval` reads throw. A documented deviation (ARCHITECTURE.md); none
  for vega specs.
- **Under `limits`, every regular-expression run is checked before it starts** (C10, C11). Patterns are read by a complete ECMAScript 2025 parser; a pattern
  the screen cannot read or analyse, an exponentially ambiguous one and a backreference in a repeat are refused whatever the input. Every other pattern has
  a cost, about `work * n ** degree` steps on `n` characters (degree: its chain of overlapping loops, the search's own loop counted), and each run on an
  actual text is refused when that, at 8 ns a step, exceeds the time left under `maxTimeMs` (else 100 ms per run, `REGEX_RUN_BUDGET_MS`), since nothing can
  interrupt a running RegExp: `\s+$` runs on a 1 000-character text and is refused on a 10 000-character one; `.*foo.*bar` on a long text is refused. The
  refusal says what was computed (`regexSafety: polynomial backtracking of degree 2: about 2400 ms on 10000 characters, over the 100 ms a run may take:
  /\s+$/`). Patterns that passed the old shape rules can be refused on long texts and some it refused now run on short ones. The screen's own analysis
  counts against the evaluation (it samples `maxTimeMs`; without it an evaluation's patterns share 1 000 000 analysis steps). A pattern over the fixed
  1024-character cap is refused as `regexSafety: pattern length N > 1024 (the fixed cap ...)`, not as `maxStringLength` (C655). **Migration:** give the
  regex shorter texts, raise `maxTimeMs`, anchor or rewrite the pattern (`trim(s)` for the trim idiom), or use `limits: { regex: 'refuse' }`.
- **`setSignal` behaves as vega's `view.signal`** (C270): an unknown name throws `Unrecognized signal name: "<name>"`, and a value equal to the current one
  does not re-run dependents unless `{ force: true }` is passed. **Migration:** pass `{ force: true }` where a re-run on an unchanged value was relied on;
  set only declared signals.
- **Dataflow cycles vega refuses are refused when the spec is compiled** (C144, C145, C113): an empty `merge` stream (`Invalid stream specification`, C629)
  and signals that read each other in a circle (a `react: false` reader is the way out, as vega requires) are a `SpecParseError` with vega's
  `Cycle detected in dataflow graph.` or its own message; they were logged on every bind and ignored or run. **Migration:** drop the empty merge; break the
  cycle.
- **Transition durations are bounded** (C487): a non-finite, negative or longer-than-60 s duration draws the target at once; an easing that returns a
  non-finite number throws `RangeError`.

**Loading**

- **`loadSpecData` requires an explicit URL policy for network urls** (Q3). A `http(s)` url is requested only when the host said which may be: `allow`
  (an allowlist), or, with no `allow`, a `baseURL` the url is on. Without either it is an `AsterUrlError` before any request, in every environment, a
  browser included. When `allow` is given it decides every url, the `baseURL` origin included. `data:` urls still need only `protocols: ['data:']`.
  **Migration:** `loadSpecData(spec, { allow: allowOrigins(['https://data.example.com']) })` (`allowOrigins` is new in `@aster-charts/core/load`), or
  `allow: (url) => url.origin === 'https://data.example.com'`; in React give `useSpecData` / `useChartData` the same `allow`, defined once at module scope.
  A host that loads only its own specs keeps `TRUSTED_LOAD_OPTIONS`.
- **The non-public host rule is wider** (C13). Also refused without `allowPrivateNetwork`: names with no dot (`http://metadata/`, service names), names under
  special-use and private-use suffixes (`.test`, `.example`, `.invalid`, `.local`, `.internal`, `.lan`, `.home`, `.corp`, `.svc`, `.home.arpa`, ...), the IPv4
  documentation, 6to4-relay and other special-purpose blocks, and every IPv6 address outside global unicast. `isNonPublicHost` reads a hostname as the URL
  parser does. **Migration:** a data host on such a name needs `allowPrivateNetwork: true` (or to be the `baseURL` origin).
- **A url dataset's format is its `format.type`, `json` by default** (C287, Q9, Q12), as in vega: the url's extension is no longer read. A body that is not
  JSON is `[aster] invalid JSON data: ...`. **Migration:** name the format of a csv / tsv url: `format: { type: 'csv' }`.
- **A redirect whose target a browser hides is refused** (C268): every hop is vetted before it is requested, in every environment; an opaque redirect, and a
  response a custom `fetch` says it followed on its own, is an `AsterUrlError`. **Migration:** serve browser-loaded data without a redirect; a custom `fetch`
  must honour `redirect: 'manual'`.
- **`loadSpecData` options are validated** (C237): a value of the wrong type, or a number that is not a whole number in range (`NaN`, `Infinity`, `-1`, `1.5`,
  `'100'`), is a `TypeError` before anything is requested (`maxBytes: NaN` used to disable the cap, `timeoutMs: NaN` was a 1 ms timer).
- **Host `data` naming a dataset the chart does not declare is a `TypeError`** (C306), as vega's `view.data(name, rows)` throws: `renderSpec(spec, { data: {
  tabel: rows } })` rendered the spec's own rows with no word; it now throws `[aster] input.data names dataset "tabel", which the chart does not declare (it
  declares: table; ...)`, from `renderSpec`, `evaluateChart`, sessions, streams and the React shells (once through `onError`). A list where a record by
  dataset is expected is refused too. **Migration:** key `data` by the top-level dataset names; a `data` object shared by several charts must be narrowed to
  each chart's datasets.

**Limits**

- **The built-in ceilings are in the allocating primitives, and hold at every size** (T1; C9, C16, C17, C29, C88, C93, C94, C95, C107, C239, C240, C486).
  `range`, numeric `ticks`, every calendar interval's range, the label and word-cloud rasters, the contour scan and the geo event buffers size themselves,
  so a function is bounded whoever calls it; the multiplying transforms (`cross`, `fold`, `flatten`, `impute`, `pivot`, an `aggregate` with `cross`, `kde`
  groups x steps, `graticule`) are bounded on what they add beyond their input. New ceilings: `work` (1e8 steps of a loop that is a product of spec or data
  sizes), `pixels` (16M, one raster's) and `vertices` (4M, one geo buffer's), and `filledCells` (1 000 000, see loading below); a count past a ceiling is an
  `AsterLimitError` at any size. **Migration:** a host that needs more raises the matching limit (the message names it); `HARD_CAPS` lists the values.
- **A `limits` object is read as given** (C233): a key that is no limit (`maxrows`), or a budget that is not a number `>= 0`, is a `TypeError` wherever a scope
  opens (`renderSpec`, sessions, streams, `evaluateChart`, the worker handler, `checkSpecLimits`, `checkSceneLimits`, `checkSvgLength`, `createLimitClock`);
  it was silently no budget. **Migration:** pass numbers (`Infinity` for no cap).
- **`session.change(input)` goes on from the last accepted evaluation** (C267): its size, signals, `limits`, `urlPolicy`, `urlData`, `random`, `textMetrics`,
  `logger`, `domainRaw`, `containerSize` and `measuredSize` carry over, each replaced by the one `input` gives; an explicit `undefined` removes one. Before,
  only the data carried over, so a change after an evaluation under `limits` ran without them. **Migration:** pass `undefined` for a setting a change must drop.
- **`maxStringLength` covers every string a scene item draws** (C704): `href`, `description`, paints, `font`, `cursor`, an image `url`, not only `text`.
- **`maxGeneratedRows` meters the rows an evaluation's transforms produce in that evaluation** (C281, Q17): a pulse is charged the rows it produced and a
  step kept from the evaluation before is charged nothing, so a session may accept appends that a fresh evaluation of the accumulated rows refuses.
  `maxRows` still bounds every dataset on every path.

**Compile and runtime**

- **An unregistered scale type is refused** with vega's `Unrecognized scale type: "<type>"` (`SpecParseError`) when the spec is compiled (C539), and a
  scale's `type` is matched as written: `"BAND"`, `"Linear"` and `"Time"` were lower-cased into a scale whose spec was read as another type (C288).
  `CompiledScale.type` is the new `ScaleType`. **Migration:** use vega's types in lower case (`diverging` alone is not one: `diverging-linear`, ...).
- **A malformed change hint throws a `TypeError` naming the dataset** (C232, C500): a name that is no dataset of the chart or the host, a `dataChanges` /
  `dataPulse` for a `source`-derived dataset, an index that is not a whole number, a pulse that says nothing. An empty hint (`changedDatasets: []`) says that
  nothing changed. **Migration:** name only datasets the chart or `data` has, describe a derived dataset's change on its source, pass whole-number indices.
- **`format` on a dataset derived by `source` is ignored, as in vega** (C115, Q12); it re-read the source's raw values through that format and skipped the
  source's transforms. **Migration:** put the `format` on the source dataset.
- **A host size no longer overrides a size the spec computes** (C112): a `width` / `height` signal with an `update` and no handlers wins over `input.width` /
  `input.height` and a written signal value. **Migration:** give the size as a value (or a signal without an update) to let the host set it.
- **Encode entries mean the code vega writes for them** (C397): a `value` that is an object is that object (`{value: {signal: "1+1"}}` is the object, not 2);
  an `exponent`, `mult`, `offset` or `band` given as text is pasted into the entry's code as vega pastes it (`offset: "5"` adds 5; `"abc"` is refused as an
  unknown signal at compile). **Migration:** write `{signal: ...}` for a computed channel, and numbers or entries for the modifiers.
- **The `format` / `formatType` keys of an encode entry are removed** (C397): `{field: 'v', format: '.2f'}` formatted the field, an Aster-only key vega has
  not; the field is its value now, and `EncodeValue`'s field variant loses the two members. **Migration:** `{signal: "format(datum.v, '.2f')"}`.
- **A mark's defaults are the compiled config's only** (C396): an explicit `null` (in the encode or in a config block or style) keeps none, where a
  point / circle / square symbol, a trail and a line were given 2 by the runtime and the renderers.
- **A group item's `datum` is a copy of its row** (C87), as a leaf item's: a write into a scene no longer reaches the spec's `values` or the host's rows
  (nested objects stay shared: API.md). **Scope ids escape data-given keys** (C383): a facet key holding `[`, `]`, `/`, `@`, `:` or `%` is
  percent-escaped in `SceneGroup.scopeSignals.id` and in the store keys `<scope id>:<name>`.
- **A mark `type` vega does not draw is refused when the spec is compiled** (C238; Q9, Q12): an unknown name, a Vega-Lite mark name (`circle`, `square`,
  `bar`, `tick`, `point`, `geoshape`), another spelling, a non-string or a missing type is `SpecParseError: Cannot read properties of undefined (reading
  'tag')`, the text vega's renderer fails with; it drew an empty group or a guessed mark. **Migration:** write vega's mark type (`symbol` for a circle or a
  point, `rect` for a bar or a tick, `shape` with a `geoshape` transform for a geoshape); `@aster-charts/vl` output is unaffected.
- **No `geoshape` mark type, and a `shape` mark does not draw a datum's `path` or `shape`** (C149, Q12): vega draws neither; a `shape` mark whose items hold no
  shape logs vega's `Cannot read properties of undefined (reading 'context')` and draws nothing. **Migration:** draw GeoJSON with a `shape` mark and a
  mark-level `{type: "geoshape"}` transform (what vega-lite emits), or read a data-level geoshape's output through `shape: {field: "shape"}`; draw path
  strings with a `path` mark.
- **A projection parameter whose `{signal}` throws is an error** (C153): it was swallowed and the map drawn with the projection's defaults; it is logged and the
  pass stops at the projection, as in vega. **`buildProjection(spec)` takes one argument**, and the registry's `projectedPath` / `projectedBounds` are gone
  (C291).
- **`config.style.<marktype>` no longer applies to every mark of that type** (C128): as in vega, a mark takes the styles it names in `style`. **Migration:**
  name the style on the mark (`style: "rect"`); `@aster-charts/vl` already writes `style: [<mark>]`.
- **A transform field that is no access path is refused** (C35): an object that is neither `{signal}`, `{expr}` nor `{field}`, a number, a `{field}` naming
  none, an empty comparator field is `SyntaxError: Unexpected token ']'` from `compileChart`, as vega's runtime refuses it; it read the whole row.
  `accessorName` of an accessor with no name is `undefined` (vega-util's), so an unnamed `{expr}` output is written under the key `"undefined"`.
- **A `{signal}` that vega-parser cannot read is refused when the spec is compiled** (Q12): the `interpolate` of a scale (its type, its `gamma`) and the
  `interval` / `step` of an object `nice`; vega's parser reads them with no scope and crashes, `compileChart` throws a `SpecParseError` with that message.
  **Migration:** write the value, or drive it with another property.
- **A group mark whose `role` is a guide's is refused when the spec is compiled** (C205, Q6): a `group` mark with the role `axis`, `legend` or `title`, or a
  prefixed one (`axis-label`, `legend-entry`, `title-text`, ...), that holds marks, signals, data, scales, projections, axes, legends or a title and has no
  `layout` or facet is a `SpecParseError` (`[aster] a group mark with the role "<role>" ...`): vega-parser makes no scope of it, so what vega draws depends
  on how many rows the group's data has. **Migration:** drop the role, give the group a `layout` or a facet, or use another role name; a prefixed role with
  nothing in it is an ordinary group mark.
- **`createChartStream` refuses what it used to read as something else** (C645): a `policy` that is none of `coalesce`, `drop-oldest`, `drop-newest`, `error`
  (`'drop_oldest'` ran as `drop-newest`), a `capacity` or `maxQueuedRows` below 1, and a batch key that is no batch field (`push({ rows })` answered `true`
  and flushed nothing). `ChartSession.evaluate(null)`, `createChartStream(null)` and `evaluateChart(spec)` throw a named `[aster]` error (C644).
  **Migration:** fix the option or the key; `Infinity` is still "no bound".
- **A stream reads its spec once, when it is created**: it evaluates a private deep-frozen copy, so a change to the host's object afterwards does not reach the
  running stream (create a new stream for a new spec). No migration for a host that does not mutate its spec after creating the stream.
- **`monotone-x` and `monotone-y` are not curves** (C311), as in vega (its table has only `monotone`, by the mark's orient); a line or area
  with them logged vega's error and was drawn monotone anyway; it is drawn linear now and the error is logged. **Migration:** `interpolate: 'monotone'` (with
  `orient: 'horizontal'` for the y curve).
- **`defaultLocale`, `numberFormatDefaultLocale` and `timeFormatDefaultLocale` are overloads** (read with no argument, set with a definition; C499): an explicit
  `undefined` no longer type checks (it threw a raw `TypeError`). **`createHostCanvas()` returns `HostCanvas | null`**, `createCanvasEvents(canvas: HostCanvas)`,
  `renderSceneToPng` resolves to `HostBlob`, `clientToSvg` / `createPointMapper` take `HostElement` (C688: the DOM types in a program that has them).
  `BoundEvent` and `EventContext` are no longer exported from `@aster-charts/core/signals` (C758).

**Public surface** (Q20, C758)

- **The `@aster-charts/core/lean*` subpaths are now `@aster-charts/core/internal*` and are not public API** (`internal`, `internal/hit`, `/signals`, `/canvas`,
  `/load`, `/stream`, `/all`, and `internal/testing` for what only the conformance gates call): plumbing for `@aster-charts/react` and this repository's
  tests, no semver, no declarations for a consumer. **Migration:** use the public entries: `@aster-charts/core/addons` for `specNeeds`, `loadAddons`,
  `loadParts`, `preloadParts`; `@aster-charts/core/dom` for `createChartSession`, `patchSceneDom`, `renderSceneToDomElement`; `@aster-charts/core` for the rest.
- **Removed exports:** the add-on registries and test seams (`dataFormatRegistry`, `geoRegistry`, `transformRegistry`, `requireTransform`, the types `GeoRegistry`,
  `ContourFeature`, `TransformFn`, `DataFormatReader`; `dataFormatRegistry` from `/load`, `withdrawFunctions` from `/addons`; C543, Q20: they were
  process-wide and writable; to ask whether an add-on is loaded use `isAddonLoaded(name)`); `buildPulseGraph`, `propagatePulse`, `transformNeedsFullRederive`
  and the types `PulseGraph`, `PulseNode`, `PulsePropagation` (C283: `session.pulse()` reports what the last evaluation changed); `checkChartRows` and
  `shareRowWatch` (the warning is unchanged); `ChartSession.last()` (keep the scene `evaluate` / `change` returned); `sceneIntersect` from `/signals`.
- **The shipped declarations carry no `@internal` member** (`stripInternal`): the scene's `__scales`, `__scaleMap`, `__locale`, `__datasets`, `__source`,
  `__keyFields` and the like are not in the `.d.ts`. **Migration:** the data they described is on `getChartInfo(...)` / `chartInfoFromScene(scene)`.

#### Added

- **Signal handlers that re-encode an item** (C629, Q6): `{ events, encode: "<set>" }` encodes the event's item again with its mark's named set (`hover`,
  `leave`, `select`, ...) as vega does; what the set writes stays until the mark's `update` runs on the item again, which takes back only the channels
  `update` writes. The `encode(item, set, retval)` expression function works while an event is handled. The request travels in the signal store under a
  symbol key (a host that serialises the store drops it); the binding needs the scene's picker (`<Chart>` passes it). Items of leaf marks are re-encoded
  (docs/INTERACTION.md). **`encode.hover` works as vega's view does** (C76): `bindSceneSignals` runs `view.hover()` by default
  (`SignalBindOptions.hover: false` or `{hoverSet, updateSet}`), new hook `SignalEventHooks.onEncode(all)`; `encode.exit` is accepted.
- **Mark and data triggers run** (C73): a data set's `on: [{ trigger, insert | remove | toggle | modify, values }]` runs in the event loop when its trigger
  changes (`specNeeds` names the `modify` part); a named mark's `on: [{trigger, modify, values}]` sets the properties on the items `modify` names (writes
  travel to the host beside the encode requests, `ENCODE_LOG`, and the next evaluation applies them; leaf marks only); insert / remove / toggle on a mark throw
  vega's `Marks only support modify triggers.`
- **`item` in encode expressions** (C31): an encode's `signal` and rule `test` expressions (marks, nested groups, axes, legends) read the scenegraph item
  being built (`item.x`, `item.datum`, `item.mark.group`, ...). **Facet parameters given as signals** (C126): `groupby`, `field` and the facet aggregate's
  `fields`, `ops`, `as`, `cross`; `{expr}` facet keys throw vega's `Unsupported field reference`. **`in` and `instanceof`** evaluate as in vega's code
  generator (C125).
- **Item `zindex` orders painting and picking, at every depth** (C28, C118, C309): a falsy `zindex` first, in order, then the others by `zindex`, in the SVG
  string, the DOM patcher, the canvas and the hit index (`paint-order.ts`); a mark's own `zindex` orders the marks inside groups and facet cells. A group
  mark's items carry `SceneGroup.markZindex`. **A mark `key` joins rows into items** (C120), as vega's DataJoin. **Colour-object encode entries** (C27):
  `{color: {r,g,b}}`, `{h,s,l}`, `{h,c,l}`, `{l,a,b}`. **`data('<mark>')`** reads a named mark's items in the order it draws them (C74).
- **A running view** (C766, C70): `RuntimeInput.retainFrom` and `createChartSession({ runningView: true })` (`ChartSessionOptions`, `@aster-charts/core/dom`): an
  evaluation that continues a scene keeps its axes' tick order, the domain an ordinal scale given no domain ended with and, for `autosize: pad`, its padding
  until `width`, `height` or `padding` change; where the rows a mark is drawn from came or went (other than appended), it renders as a fresh view (INTERACTION.md,
  "A running view, and where it stops"). A `force` layout a view goes on with is vega's simulation (C73). `RuntimeInput.previousScene` lets an `evaluateChart`
  caller hand back the scene of its last evaluation so a hint for a new array is checked by identity (Q16).
- **`config.locale` is the chart's own number and time locale** (C41), as vega's view locale: axis and legend labels, captions, a text `format`, the expression
  functions `format` / `timeFormat` / `utcFormat` / `timeParse` / `utcParse` / `monthFormat` / `dayFormat` and the `date:` / `utc:` patterns of its data read it;
  no process-wide state is touched. It was silently ignored.
- **The view's frame is the root group item** (C279): `SceneRoot.frameCursor` carries the root encode's `cursor`, and the hit index holds the frame (a fill, a
  `transparent` one too, or a stroke along it) as the first entry, found by `pick` only, so `event.item` and the cursor over the empty plot are vega's.
  **Authored marks are laid out by their `role`** as vega's ViewLayout reads it (C205): `axis`, `legend`, `title`, `frame`, `scope`; the operators vega ranks
  late (a scale whose domain reads data, and everything that reads it) are ranked after every operator that reads none, so what a failing operator leaves
  depends on where it ranks (a legend over such a scale has its title and no entries; an axis over one has no ticks and is refused like any half-built axis,
  `[aster] the ticks of the axis over scale "<name>" were never made: ...`). A group item's layout reads an authored `legend` / `title` mark by its role.
- **`loadSpecData`** takes `maxRequests` (default 100, redirect hops included), `maxTotalBytes` (default 50 MiB) and `signals` (the host's values for the
  spec's top-level signals, read by a `{signal}` url); one url is requested once per call (C236); `allowOrigins(origins)` in `@aster-charts/core/load`.
- **Types:** `PulseChangeInput` and `PulseRange` are exported and `RuntimeInput.dataPulse` / `StreamBatch.pulse` accept the `RowDiff` `diffRows` returns
  (C278: it did not compile; at run time its first range was read as the list of ranges); `SceneItem.image`, `SceneItem.tooltip`, `SceneRoot.signalParams`
  and `SceneRoot.__limits` are declared and `SceneRoot.runtime` / `.compiled` typed (C538); `ScaleContext`, `TransformContext` (C730); `EnginePart` from
  `/addons`; **web-platform types in the declarations are structural where the consumer has no DOM lib** (C688): every entry compiles with `lib: ["es2022"]`,
  `types: []` and `skipLibCheck: false` (it failed with 16 errors). `RuntimeInput.measuredSize` takes each dimension on its own. `HitIndexOptions.strategy`
  (`'auto'` | `'scan'` | `'grid'`, default unchanged; C338).

#### Fixed (security)

- **A forged DOM descriptor can no longer reach the page** (C1): an encode channel named `__domDesc` was taken as the item's cached DOM descriptor, so after a
  string mount and one update the patcher created any element and attribute it said (`<a xlink:href="javascript:..." onclick=...>`, `<script>`). The cache lives
  beside the items (a `WeakMap`), such a channel is refused, and the patcher never sets an `on...` attribute.
- **A refused URL no longer survives in a session** (C2): an append whose URL the policy refused threw after the rows were pushed into the previous scene's
  items; the in-place write is claimed and undone on any throw, and the policy is applied as each item is encoded. **`file://javascript:...`** (C3: the text
  that is written is the one vetted; vega 6.3.1 has the same defect). Title and subtitle links, a group mark's title and every other guide node go through the
  URL policy (C8); the `image` channel too (C20). A URL refused for its credentials is reported without them (C391, `redactUrl`). A gradient paint's own `id`
  cannot break out of its `url(#...)` or collide with a clip id (C387).
- **`loadSpecData`'s time bounds no longer depend on the `fetch`** (C235): `timeoutMs`, `limits.maxTimeMs` and the caller's `signal` reached only `init.signal`;
  every step is now raced against the abort and a value that arrives after it is never taken. `{signal}` urls are evaluated under the limits (C14: a
  backtracking pattern ran 22.8 s under `maxTimeMs: 200`); a csv's cells are budgeted before they are made (C12: a 31 KB header over empty lines made ~2 GB of
  cells; under limits the rows are counted against `maxRows` as they are read, the cells filled in for missing fields are bounded with or without limits);
  a topology's arc indices are checked before they size anything (C90, C402).
- **Spec text never reaches the `Function` constructor** (C18): a scale option was applied by calling `scale[key]` whenever it was a function, so
  `"constructor": "..."` compiled the text; options are now only the scale's own methods, and a test renders the corpus under
  `--disallow-code-generation-from-strings`.
- **Scale, tick, calendar and geo work a spec controls ends, with or without `limits`** (C19, C96, C132, C242, Q13): `bins: {step: 1e-7}`,
  `utcSequence('seconds', ...)` over decades, a log scale of base `1e15`, a UTC axis at the end of the Date range, a tiny `precision` over a graticule
  (gigabytes in one uninterruptible call) each exhausted the heap or never returned; ranges and calendar ranges count against the `rows` ceiling, log ticks
  and one calendar search against `items`, the positions a projection makes against `coords`, and every step ticks the limits' clock. Fatal out-of-memory
  and endless loops from small specs are closed in the legend, `strokeDash`, `isocontour`, `scale.bins`, `label`, word cloud, `force`, `nest` and sharing
  sub-objects (C9, C16, C17, C88, C93, C94, C95, C107, C239, C240, C486); every loop of the transform, layout, raster and geo code reads the clock.
- **A self-feeding `modify` is bounded** (C99): one event runs at most 1000 propagations, `maxTimeMs` is checked before each run and the row caps apply to edited
  data sets. String builders (`+`, `join`, `replace`, `split`, `upper`, `lower`, `trim`, ...) are metered under `limits` (C234). Process-wide text-keyed caches are
  bounded by the length of their keys (C385); the path parse caches by the text they hold (C98).

#### Fixed

**Rendering, canvas and accessibility**

- The renderers write only what the scene permits, under what it was evaluated with: the URL policy's `allow` hook is asked once per image about exactly the url
  drawn (C286); a link refused under one policy comes back under another in a session (C478); a per-call text measurer is in force when the scene is written
  (C38) and text widths are cached per measurer (C414); `setTextMetricsProvider` reaches everything an evaluation keeps (C217); a provider that throws is
  reported and its fallback width not cached (C111, C395).
- Canvas: clips to the view's `clip` and the rounded box (C134); `renderSceneToCanvasAppend` returns true only when the result equals a full repaint (C135); a
  paint that throws restores the context (C228); empty `fill` / `stroke` text paints nothing (C412); a group item's `blend` and an axis' or legend's `clip` and
  `blend` are drawn in all three renderers (C533). SVG: a gradient paint with its own `id` and no coordinates is written bare, left to right (C137); the first
  patch of a string-mounted `<text>` that gains lines no longer keeps the old text node (C136); an angle given as a word is the same `transform` in the DOM
  patcher and the string renderer (C550); `patchSceneDom` no longer rewrites every `<a xlink:href>` on its first patch (C647); a legend caption says "titled" only
  for the legend's own title and a `null` line of text is empty (C422, C423).
- Accessible tree: legend entry ids are unique (C138), the tree is bounded whatever the data (C241), a mark item's box is the hit index's bounds and its id follows
  its datum (C411). Canvas event types named like `Object.prototype` members are handed over as any other (C551). The cursor vega's rule picks is shown only when a
  keyword (C97, above).
- **A symbol batch is a set of symbols that cannot overlap, so its pixels are the one-element-per-item ones** (C37, C413): translucent, blended and
  filled-and-stroked symbols share a path (SVG `denseMarks`) or a fill and stroke (canvas symbol runs) with the symbols of their paint they cannot overlap; a
  run is cut where a symbol's ink box (shape, the stroke's real reach, a pixel of antialiasing on every side) meets one already in the batch, so a scatter of
  1 000 stroked, translucent symbols is about 45 elements. Rotated symbols, gradient paints and **a symbol with a `description` keep their own element** (the
  description is the item's aria-label and role; vega's SVG gives each its own element). Every Vega-Lite mark carries a description, so the gain is for Vega
  specs and Vega-Lite specs with `aria: false`. (This replaces 0.4.1's "a translucent symbol keeps its own element".)
- `<Chart incremental={false}>` drew nothing for a symbol mark of 512 or more items: dense batching is the incremental patcher's, so string mode never batches.

**Evaluation, state and reuse**

- **An incremental evaluation is the fresh evaluation** for marks drawn from marks, group-scoped reads, fitted projections and large signal values (C7, C24, C26,
  C42, C114, C265): every engine array carries a content stamp, every reuse compares stamps, a value past the fingerprint's text budget is keyed by a hash of all
  its content, and a fitted projection is in the dependency closure. **Signals settle in vega's order** (C23, C25, C113): ranked as vega-dataflow ranks them, an
  update runs again only when what it reads changed, `domain('x')[1]` sees the scale at any chain depth, a signal's `init` waits for what it reads (and is
  evaluated once, C143). **`datum === src` holds when `src` holds an item's datum** (C68). An edited row whose encode throws gives the fresh scene (C110, Q8);
  appended items are measured by their mark's type (C116); a function re-registered with another body invalidates every reused result (C280); a `width` /
  `height` signal with an `update` sizes the view (C112).
- **What vega's tuples carry from one run to the next** (C68): a dataset whose transforms read a field a later transform writes (vega/reorderable-matrix) is
  evaluated from the tuples the evaluation before left and runs again only the steps vega runs again, followed for every step vega runs over kept tuples (formula,
  bin, timeunit, window, joinaggregate, lookup, stack, pie, dotbin, linkpath, voronoi, collect, extent, identifier), at the top level and in `source`-derived
  datasets; not followed: a `filter` in such a pipeline and stream appends to it (ARCHITECTURE.md). **Reuse under `limits`** (C277): a scale or top-level mark
  made under the same limits is kept and charged what making it charged; results taken partly from the evaluation before are still made again.
- **A scene returned by an evaluation never changes** through a value made of a dataset's rows (C30, Q14): signal values and item properties holding `data('t')`
  inside an object or list are copies (one per array version, keyed by stamp); `datasetsOfScene(scene)` and the runtime's `data()` no longer show rows of a later
  append or of a rejected evaluation. The session cache answers only for equal inputs (C122, C123, C282, C400, C503); one injected `random` shared by several
  charts draws per chart (C124); a stream evaluates with `initial.random` (C272).
- Streams: a `from` that names an old row twice is re-derived (C399); a push made during a flush is delivered (C484); a bound of `NaN` is a `TypeError` (C502); a
  queued snapshot is copied (C529); `push` after `close()` returns `false` and `initial.data` rows are checked as later ones (C705). A `null` row in a session's
  same-length update throws the documented row error (C500).
- Event loop: state is per chart (C40, C290); an `owner` that is not a DOM node keeps its timers and a timer whose element was never in the document stops (C271,
  C388); a regex literal is a fresh `RegExp` per evaluation (C32); `sequence()` applies its count ceiling before wrapping (C89); host functions named `is*` are
  guarded (C530); a stale registry epoch recompiles an expression once (C485). Selections: unit counts are read from the store as it is and tuples are combined
  per unit only where vega indexes the store (C419, C420); a selection store a handler writes is tested as vega tests it, Dates becoming numbers up to the first
  field that fails (the Date residual). Transitions: retargeting to a scene that draws like the start keeps moving from what is shown, a throwing first frame is
  reported (C146, C487, C716).
- A group mark's own signals are evaluated once each, after the ones they read, in vega's dataflow order (C483: 200 cells x 160 chained signals, 333 to 7.5 ms);
  a cycle among them is logged and stops the pass at the group item. A dataset vega re-ranked past the marks that throws no longer stops every mark (C211). A
  throwing mark `clip`, a pre-faceted group over a field that holds no array, and a throwing `layout` or guide `values` signal are logged once and stop the pass
  where vega's does (C121, C398); `{field: {group | parent, level}}` (C119); a kept group-item mark over object rows is made again (C541); a hand-built mark with
  only `enter` is encoded (C542); a pulse part that fails to load is said once (C501). The development row watch also warns when rows were edited and handed
  back in a new array (C266).
- A mark drawn from a sorted mark reads that mark's items in the order of its rows (C63), and a `label` over a `line`, `area` or `trail` places labels. The root
  frame's border is inset as vega-scenegraph's group is, whatever its stroke width. `intersect(box, filter, group)` searches the mark node it is given (C365, 27 710
  cases against vega in Chromium); passing an item, a datum or a number raises `Intersect scene must be mark node or group item.`; `intersect()` enters a nested
  group only if its bounds meet the box (C480).
- **Transform parameters are read as vega reads them** (C35): `{expr, as}`, `{field, as}`, comparators and `{signal}`s for every parameter of every transform,
  resolved in one place from the definition table (41 of 43 such forms read the wrong value). A mark's defaults follow vega (config and style defaults in `enter`,
  spatial channels adjusted per set; C129); guide values, tick counts and the legend layout read signals at any depth (C147, C148); axis ticks are made as vega's
  AxisTicks makes them (C421; `grid`, unknown legend `orient` and config-looked-up guide parameters, C553). `dotbin`, `pie`, a formula output named `__proto__` and
  a transform's `signal` (24 transforms had none) follow vega (C130, C404, C544, C546); `applyTransforms` charges `maxGeneratedRows` once (C405). A transform `signal`
  on an operator whose value is vega's internal state holds an opaque object (a documented deviation): `require: {signal}` works. A mark's extent is measured as its
  type (C129). `datum`, `event` and `item` are not defined where only signals are in scope (`ReferenceError: datum is not defined`, as vega; the row, encode and
  handler contexts are unchanged). A window frame that ends outside its partition no longer fails with the engine's TypeError / RangeError; a `flatten` of a field a
  row does not hold throws a `TypeError` naming it.
- Scales and geo: scales warn as vega's Scale operator does (C333); `{signal: "true" | "false" | "null"}` is the literal (C133); padding an empty literal domain is
  `Domain array must not be empty` (C410); an unused `sequential` scale with `range: []` no longer throws (C408); a colour's keys are in d3-color's order (C409);
  scale options apply literals before `{signal}`s as vega's operator does (C353) and a sort that cannot combine fields is refused when the domain is parsed (C585);
  `geoshape` with no projection, a group mark's `clip: {sphere | path | signal}`, a group's own projections, `geoBounds` of empty rings, `graticule` parameters
  and `copy('projection')` follow vega (C149 to C154, C291, C425); `graticule` on a dataset that has rows keeps them (C210); `isocontour` over a row with no grid
  says `invalid size` (C472). Layouts: hierarchy sort ties (C131), an unenclosable `pack` is logged (C406), `spiral: constructor` (C386), `voronoi` `size` (C407).
- Hit index, bounds and paths as vega's, on every value an encode can write (C139, C140, C141, C142, C198, C229, C39, C415, C416, C417, C418, C455, C532, C713): items are
  measured as their mark's type from the raw channel values; a group item keeps the position and size its encode wrote; a rect's numeric-string `width` is drawn;
  a symbol or image at a missing or NaN position is picked where it is drawn; a dash gap takes no pointer; `tracePath` returns to the subpath's start on `Z`; an index
  kept for a scene no longer reports items appended for a later one; a scene that crossed a structured clone no longer throws in a canvas index; an empty path is
  measured without the path reader. The hit index picks as vega's canvas and a browser's SVG do where `conformance:geometry` found it did not. The canvas index keeps
  its bounds test on the other axis for a group positioned by a string that is no number on one axis. The dead axis-bounds fallback is removed (C552).
- `loadSpecData` reads `{signal}` urls in a group's scope (C531); `format: {type: 'topojson', feature}` naming a single geometry gives one Feature (C33), `mesh`
  honours `filter` (C34), `format.parse` applies to the decoded features (C403); an unknown `format.type` is `[aster] Unknown data format type: jsno` (C626);
  `addonsNeeded` / `partsNeeded` read a `{signal}` an encode entry's `value` holds and no longer depend on key order (C127); `loadAddons` rejects before importing
  anything for a name that is no add-on (C627); an unparseable redirect `Location` is an `AsterUrlError`, deep or cyclic specs an `AsterLimitError` (C402); it
  loads the engine's time part itself when `parse` has a date pattern. The empty-slot error of a part names the entry that carries it (C691).
- `translatePathData` is right for every valid SVG path (C218). `defaultLocale(definition, undefined)` no longer replaces the number half and then throws (C499).
  `bindSceneSignals` on a scene without the evaluation's handles warns once and stays inert (C524). `createPointMapper().map` returns (NaN, NaN) before its element
  exists (C532). The compile walk reads every expression site vega's parser reads (C126, C284).
- **The label transform's raster stroker joins a curve's flattened vertices round** (C482): a tight turn no longer grows a miter spike the browser does not draw;
  **a stroke a pixel or less across is a hairline in the coverage canvas** as a browser draws it (C208: one pixel thick along the axis the line runs less along,
  spread over the two pixels it straddles); the raster scan sorts its crossings in place.
- TSDoc, ARCHITECTURE.md, ERRORS.md, LIMITS.md, ANIMATION.md and INTERACTION.md follow the code (C269, C361, C706, C707, C710, C711, C712, C715, C735, C758).

#### Performance

- Costs measured against origin/main (docs/PERFORMANCE.md has every row): a signal write on a chart of 10 000 items costs what it did in 0.4.2 again (the scene's
  expression runtime no longer keeps the evaluation's map of the marks' items unless the chart names a mark in a string, gives a named mark triggers or passes a
  computed name); a formula that only casts the field it writes (what Vega-Lite writes for a quantitative or temporal field) keeps no tuple history (a Vega-Lite
  line chart of 5 000 points updates one row in 3.8 ms, not 11 to 16); the first append to a stream no longer walks every row to learn its frozen spec is frozen;
  the dense SVG append patch and the canvas and hit-index visits no longer read every item's `zindex` at each update; a mark whose encode set has no `x2`, `xc`,
  `y2` or `yc` is not adjusted item by item; the stream's per-flush input and the evaluation context are built without conditional object spreads (stream append
  153 to 144 us); a deep-frozen spec costs a session nothing to evaluate again (3.4 ms to 0.06 ms; C503); the canvas hit index builds in 3.2 ms (8.4 before a32's change);
  `translatePathData` is about 20% faster; the label transform's stroked-curve workload is 21% cheaper cold and 55% warm than on origin/main. A time budget answers within its granularity on every pass over the rows (C340, C514).
- A running view (the session `<Chart>` makes) kept every scene it continued alive (about 300 kB per update of a 1 000-point chart); a scene is collectable once
  the next one replaces it.
- Costs that remain, with numbers in docs/PERFORMANCE.md: stream append +15% (production) and the first render of 1 000 translucent stroked symbols +23% against
  origin/main, a Vega-Lite facet compile +32%, `compileChart` +29%, the cold import of `@aster-charts/core` +18% (the larger code), the accessible tree's cost;
  they are the price of the checks above.

### `@aster-charts/react`

#### Changed (breaking)

- **A chart is the size its spec makes it** (Q11; C274). `<Chart>` / `<SvgChart>` / the stream components without size props used to fill their element; as in
  Vega and vega-embed a literal size now draws at that size in any element. `width` / `height` take a new value, `'container'`, which fills the element in that
  dimension (measured and followed as it resizes; each dimension on its own); Vega-Lite's `width: "container"` still fills the element without any prop.
  **Migration:** `<Chart spec={spec} width="container" height="container" />` for a chart that relied on filling its element.
- **`signals` is controlled, by content** (Q19; C292): a key whose value changes wins over what an interaction wrote before; an interaction afterwards wins until
  the prop's value changes again and is reported through `onSignal`; removing a key releases it. `getSignals()` returns the merged values. **Migration:** a host
  that passed `signals` only as initial values and expected interactions to stick across re-renders gets that now; to keep an interaction's value after the prop
  changes, pass it back from `onSignal`.
- **Every failure reaches the error state and `onError`; nothing is thrown from render** (C46, C47, C554): a Vega-Lite spec without `import
  '@aster-charts/react/vl'`, a compile error, `spec={null}` / `undefined` / a JSON string / an array and a rejected spec promise used to throw out of render;
  `useChart`, `useChartStream`, `useChartWorkerStream` and the stream components threw too. They show the error state (`role="alert"`, inside the chart's own
  element, keeping `className`, `style` and `ariaLabel`) and call `onError` once, or return the hooks' `error` / call `onStreamError`. `isVegaLiteSpec` returns
  `false` for anything that is not a plain object. **Migration:** an error boundary that caught these throws no longer sees them; handle them in `onError`.
- **Inputs are checked at the boundary** (C100, C243, C490, C630): a dataset in `data` that is not an array of rows and a `width` / `height` that is not a finite
  number of pixels (0 or more) or `'container'` put the chart in its error state with a `TypeError` naming the prop; a dataset of `undefined` rows is "not given"; a
  controlled `view`, `brush` or interval axis that is not two finite, different numbers is reported through `onError` (once per value) and left out. A `renderer`
  that is no renderer (`"webgl"`) reports `[aster] renderer="webgl" is no renderer ("svg" or "canvas"), so it renders SVG` once (C645).
- **Bound inputs follow vega-view** (C227, C295): a number field (and every generic `input` type) writes its text, as Vega does (`"12"`, and `""` when cleared;
  it wrote the number, and `0` when cleared); `bind.labels` label the options; array, `null` and boolean options work; search, date, color are their own input types
  with `placeholder` and the other field attributes; a slider with no value starts mid-range. **Migration:** an expression that compared a number-field signal with
  `===` against a number compares with `==` or converts (`toNumber(s)`), as with Vega.
- **The pan / zoom helpers work in the scale's own space** (C155, C534): `zoomDomain`, `panDomain`, `cursorZoom` and `keyboardView` take the live scale (`scale?` /
  `scales?`) and `zoomDomain`'s `minSpan` is measured in that space; without it they are linear as before; `cursorZoom` takes `maxZoom` (default 1000). **The wheel
  zooms by Vega-Lite's stretch** `1.001 ^ (deltaY * 16 ^ deltaMode)` (C488): a pixel-mode notch of 100 zooms about 10% (it was 14%), with or without a modifier key
  (Ctrl+wheel zoomed 6.7 times as fast); a wheel with nothing to zoom, a horizontal scroll and a wheel over a bound input are no longer prevented.
- **A `ChartHandle` kept past unmount is inert** (C489): `setSignal` / `setView` do nothing, `getScene()` / `getSvg()` / `getChartInfo()` / `getView()` return `null`,
  `getSignals()` `{}`. **The host's `style` wins** over the chart's own `width` / `height` / `position` / `touch-action` (C294).
- **`useSpecData` does not retry a failed load by itself** (Q19, C48): it throws the rejection to the error boundary once; the load is tried again when an input
  changes or after `resetSpecDataErrors()`. **Its cache is keyed by content and identity** (C50): the spec and data options by content, `fetch`, `allow` and
  `signal` by identity; an inline function option without a `cacheKey` fails with `AsterUnstableLoadOptionError` instead of refetching on every render.
  **Migration:** call `resetSpecDataErrors()` in the error boundary's reset; hoist function options or pass a `cacheKey`. `useSpecData`, `useChartData` and
  `loadSpecData` need the explicit URL policy (see core) and take `maxRequests`, `maxTotalBytes`, `signals`; `useChartData` gives its `signals` to the loader so a
  `{signal}` url follows the host's value (C531).
- **`useChartWorkerStream().accepted()` / `rejected()` are counts since the hook mounted** (C718) of what `push` accepted and of batches that will not be delivered,
  with or without a Worker (they were the worker's answer to the last flush, `null` without one). **`close()` on a stream hook no longer pauses the hook** (C159): it
  closes that stream; a stream started later (a new spec) is open; `pause()` is the hook's and survives a new stream.
- **`ChartStreamHandle` is typed as the hook's functions** (C275): `flush` is `() => StreamFlush | null`, `pending` `() => DataPulse`, `pulse` `() => DataPulse |
  null`, `stats` `() => StreamStats`; `<ChartWorkerStream>` has its own `ChartWorkerStreamHandle`. **Migration:** a ref passed to `<ChartWorkerStream>` is
  `useRef<ChartWorkerStreamHandle>(null)`; a deep import of `./ChartStream` for it moves to `./ChartWorkerStream`.
- **`hydrateChart` no longer takes `tooltips`** (C276, Q20): the option only wrote `data-datum` attributes nothing binds; `HydrateChartOptions` is `RuntimeInput`.
  **Migration:** drop it; render `<Chart>` for tooltips on a hydrated page.
- **Removed from the public surface** (Q20): `registerVegaLiteCompiler` and the `VegaLiteCompiler` type (`import '@aster-charts/react/vl'` registers as before and
  `hasVegaLiteCompiler()` says whether it did; compile yourself with `compile` from `@aster-charts/vl`); from `@aster-charts/react/worker` the `@internal` helpers
  (`resolveWorkerTextMetrics`, `resolveWorkerUrlPolicy`, `wireTextMetrics`, `wireUrlPolicy`, `workerTimeout`, `terminatedError`, `terminateWorker`,
  `useWorkerInstance`, `listenToWorker`, `replayWorkerLogs`, the `WorkerInstance` type); `ChartProps.sceneOverride` and `ChartProps.onStreamInput` from the
  declarations (`<SvgChart>` no longer accepts them). `UseChartResult.session` is typed `ChartSession`.

#### Added

- **`<Chart urlLoad>` (and `<SvgChart urlLoad>`)** loads url datasets itself and reloads them when a signal their urls read changes inside the chart (C531): vega
  reloads a `{signal}` url from a bound input or an event handler as much as from the host; `urlLoad` takes the loader's options, the loader's URL policy is required,
  the chart's `limits` and `signals` are the loader's; a load a newer url supersedes, and one still running at unmount, is aborted; the datasets are empty until the first
  load arrives (and on the server); a failed load is reported once through `onError`. Without the prop nothing is fetched. Pinned against real vega by
  `pnpm conformance:url-reload`.
- **`eventSources` on `<Chart>` and `<SvgChart interaction>`** (core's `EventSourcePolicy`, compared by content; see core): the default is unchanged.
- **The worker hooks own a hard deadline** (Q4, C244): `useChartWorker`, `useChartWorkerStream` and `<ChartWorkerStream>` take `timeoutMs` (default
  `DEFAULT_WORKER_TIMEOUT_MS`, 30 000); a request not answered in time terminates the worker, `error` is the typed `AsterWorkerTimeoutError` (`code:
  'ASTER_WORKER_TIMEOUT'`) and `pending` is false; a worker made by `workerFactory` is replaced at once, a supplied `worker` is terminated.
  **`resetSpecDataErrors()`** retries every failed `useSpecData` load; **`cacheKey`** on `useSpecData` / `useChartData` / `loadSpecDataResource` is the host's name for
  a load; **`AsterUnstableLoadOptionError`** (`code: 'ASTER_UNSTABLE_LOAD_OPTION'`) is thrown when a function option is a new function on every render.
- `width="container"` / `height="container"`; `positionalScales(spec)` and the `PositionalScales` type (C534); `bind.debounce` on bound inputs; `ChartStreamInput`
  and `ChartWorkerStreamHandle` are exported (C275, C730). `<Chart>` runs a mark's `encode.hover` as vega-embed's view does (C76) and its session is a running view.

#### Fixed (security)

- Generated bound inputs take only the input types and field attributes an input can safely have (Vega copies every key of `bind` onto the input, so a spec could add
  an inline `on*` handler); a radio group is named with the chart's own id; `bind.element` is not honoured and is reported through the logger (Q1, docs/LIMITS.md).

#### Fixed

- Pan, wheel and pinch zoom, the keyboard and the brush work on `time` / `utc` scales (C44) and each scale as Vega-Lite's `bind: "scales"` does: `log` in its logarithm,
  `pow` in its power, `symlog` in its transform, the others linearly (C155: one ArrowLeft on a `[1, 1000]` log axis gave `[-78.92, 920.08]`); a time brush reports
  milliseconds. The persisted selection rectangle is clipped to the plot and `NaN` no longer reaches `style.left` (C490); a chart that only brushes takes touch drags
  (C491); keys and double-clicks inside bound inputs no longer pan, zoom, reset or clear the selection (C71); `select` (the alias of `selection`) works and `brush={null}`
  clears (C293); radio-bound signals of two charts no longer share a native radio group (C156); a legend scale name with selector characters no longer throws on
  ArrowRight in the accessible tree (C389); a canvas chart follows a change of `devicePixelRatio` (C505); a chart that mounted in its error state measures and zooms after
  it recovers (C46); `onError` no longer fires twice for one failure (C157); `incremental={false}` with a dense symbol mark renders (C43).
- Hydrating server markup the client draws differently (another time zone, the server's text estimate) patches the adopted `<svg>` to the client's scene once and
  makes the accessible overlay and bound inputs anew (C45), without React's "attributes didn't match" warning; the first re-render of a chart with `signal.on`
  streams no longer binds again.
- `useSpecData` refetched forever on a failed load (C48) and on inline literals (C50); `useChartWorker` looped on inline `data`, `signals` and `domainRaw` (C72): every hook
  input follows the identity rule (ARCHITECTURE.md, "The React boundary"); the worker stream keeps every push it accepts in order (Q19; C49, C158) with one flush in
  flight at a time (C77); a stream after `close()` and a new spec flushes again (C159); a replaced stream and the stream of an unmounted hook are closed (C506); `limits` and
  `textMetrics` changes reach a live stream (C296); `useChartStream().flush()` with nothing queued sets no state (C632); the coalescing queue folds in place (C492: 40 000
  one-row pushes, 6.7 s before); one failing `post` no longer silences the worker (C160) and a worker `error` ends only requests in flight (C555); `<ChartStream random>` and
  `<ChartWorkerStream random>` reach the stream (C272); `validateDataChanges` refuses `undefined` and holes (C101). A handler's `encode: <set>` (and the hover) reached the
  evaluation in `<Chart>` never (C76).
- **`import { ChartStream } from '@aster-charts/react'` no longer pulls the whole synchronous engine** (C82): `<ChartWorkerStream>` is its own module, so an app importing only
  `<ChartStream>` no longer bundles every part up front (new shaking pattern `react-chartstream`).
- `tooltip-content.ts` (vega-tooltip's `formatValue` and JSON replacer) carries vega-tooltip's BSD-3-Clause notice in `THIRD_PARTY_NOTICES.md` (C109).

### `@aster-charts/vl`

#### Changed (breaking)

- **A value the Vega-Lite schema does not allow where it stands is refused** with a `VLCompileError` naming its path (`<path>: must be ... (Vega-Lite 6.4.3 schema)`):
  a wrong type, `null` where vega-lite reads "unset", a name that is not one of the schema's (a scale scheme, a mark blend mode, a projection type ...), a missing
  required property, an `{"expr"}` where the schema takes no expression, an unknown property inside `config`. The check is generated at build time from vega-lite 6.4.3's
  JSON schema (`scripts/schema-table.mjs`); the forms vega-lite reads beyond its schema and Aster draws as vega-lite does stay accepted, each listed with the test that
  pins it (`EXTENSIONS`). Replaces the hand-listed value checks (C245). **Migration:** fix the value the message names; `{"expr"}` is accepted wherever the schema takes
  an ExprRef.
- **The consumption check** (T3, C83): every property of a spec must be read by the compile, or be one vega-lite itself ignores; any other is refused at the end of the
  compile as `<path>: is valid Vega-Lite but @aster-charts/vl does not implement it here, so it would be ignored`. Each "vega-lite ignores it" rule (and the mark-definition
  properties vega-lite ignores or forwards per mark type, a table generated from vega-lite itself) is pinned against vega-lite. The `timeUnitBandPosition` /
  `timeUnitBandSize` mark keys are accepted and ignored.
- **Specs that compiled to a wrong chart now throw a `VLCompileError`:** names that collide in the compiled Vega (C182: a parameter named as a compiler-made name,
  one selection name in two layers, two views of one `name`); where vega-lite 6.4.3's own output is broken (Q9: independent x / y scales over layers sized
  differently, `axis: null` on a layer after one that draws the axis, a layer in a facet keeping its own x / y scales unless the facet resolves them independent, two
  views aggregating different measures into one name, binning a field the layer's own transform makes, a nested view named as the root view; C51, C57, C79, C161, C164,
  C428); schema-invalid values that drew a different chart (C245); a field, dataset, transform output or parameter named as a member of `Object.prototype` wherever Vega
  mistakes it for the prototype's member (C442); a field whose path holds an escaped backslash wherever vega-lite writes it into a Vega `field` unescaped (C184, C442); a
  `{repeat}` reference in a transform, a repeat's `row` / `column` given as a string (C83); an `xOffset` / `yOffset` over a point scale (C636); a selection parameter on a
  boxplot, errorbar or errorband (C59); an interval selection whose `on` or `translate` is not a drag and an interval bound to a map's scales (C639, a raw `TypeError`
  before), an errorbar / errorband whose `extent` or `center` the schema does not name (C246) or whose measure is a nested or dotted path (C60, Q9); `order` given as a
  list (vega-lite 6.4.3 reads none of its entries and draws the chart unordered); a `{datum: {expr}}` where vega-lite's chart of it is wrong (a scale made of it, a
  tooltip, text, href or description); a variable parameter inside a view of a composition (vega-lite declares its signal at the top only); a tick whose `baseline` is
  `alphabetic`, `line-top` or `line-bottom`; two equal bins whose rows differ (a filter between). **Migration:** the message names the path; remove or rename what it names
  (give the layer a width, share the scale, rename the parameter, the view or the field; write a repeat's list as an array; declare a parameter in the top-level `params`;
  write a datum constant as a `value`), or file the feature as a gap.
- **A mark property is resolved as vega-lite resolves it** (C80, C297, C298): the mark definition, then the styles, then the mark type's config, then `config.mark`, by
  one resolver (`getMarkPropOrConfig` / `getMarkConfig`); the styles of a mark reach every property; `config.style.<mark>` is merged over `config.<mark>`; what the config says
  of a property the mark definition does not is left to Vega, which applies `config.style`, `config.<mark>` and `config.mark` in its own order: Aster no longer repeats it in
  the encoding (`config.mark.strokeWidth` on a point, `config.mark.size` on a line or a text, `config.rule.size`, `config.mark.outerRadius` on an arc, ...). Config props
  that only `config.axis` / `axisX` / `axisY` / the orient's block give are no longer written on the compiled axis (the picture is the same; code that read them off
  `spec.axes[i]` reads `spec.config`). **Migration:** a chart that set a property in `config.mark` or `config.<mark>` and got Aster's value now gets vega-lite's.
- **Casts of the data follow vega-lite's parse** (C169): `toNumber` only for a `min` / `max` of a quantitative field and the quantitative dimension of a path mark with no
  `order`; every other quantitative field is read as the data gives it (an empty string is a row at 0, a mean over strings is not a number). **Migration:** parse the column in
  `data.format.parse` to restore the old reading.
- **A facet with `name` names its parts after it** (`other_marks`, was `child_marks`); `autosize: "fit"` over a view sized by steps becomes `fit-x` / `fit-y` / `pad` (C426);
  a variable parameter is the signal vega-lite makes of it (`value` a literal whatever it holds, `expr` the update or, with `bind`, the initial value; `expr` with `value` or
  `bind` compile; C442); a transform output name may have a dot in it (`as: "m.x"`, C300); a unit with a pivot parses no field of its encoding.

#### Added

- **`resolve` on a layer at every level** (C79): scales, axes and legends resolved over the layer tree as vega-lite does; independent continuous x / y scales in a wrapped
  facet; `resolve.scale.<channel>` / `resolve.legend.<channel>: independent` for any channel in a facet; `width` / `height: "container"` in a facet's spec; a wrapped facet
  reads every header property and `config.headerFacet` (C52, C83).
- A mark-definition `x`, `y`, `x2` and `y2` on every mark, and a rule's, area's, rect's and tick's `width` / `height` (placed by `align` / `baseline`); a bar's own `width` /
  `height` on every scale; `mark.ariaRole`, `radius` and `theta` of a text or point, DateTime `axis.values`, `x: {value: "width"}` (C161, C184); non-identifier parameter names
  (`my brush`); a selection projected over an escaped or nested field (`a\.b`, `o.c`: the flat copy the rows carry under the joined path); a `{repeat}` reference in a
  condition's field; a `sequence` generator with a `name`; scale properties as `{expr}` (C174); animation forms vega-lite compiles and vega runs (a timer selection with no
  `time` channel, `fields` with `encodings`, a second timer selection, an aggregate on `time`, a selection over no field, ...); `mergeChainedBins` (two equal bins in one
  pipeline are one bin); `config.locale` passed to the Vega config (C41); a title in the tooltip and the aria description is a string literal that cannot break (C103).
- Validation messages suggest the nearest valid value, tell a config typo from an unsupported key and carry the path (C637); DateTime parts are checked (C441); spec depth (1000)
  and view depth (100) are bounded and a cyclic spec is refused (C493); expressions that read a name nothing declares are refused at compile.

#### Fixed

- Composition and facets: a facet of layers drew every facet's rows in every cell (C6); prototype-named keys could write `Object.prototype` (C5); bins, aggregates, parses and
  extent merged across views where vega-lite keeps them apart (C51, C56 to C58, C180); a binned field on two channels groups by both bins (C53); repeated children's `name`
  into signal names (C102); a facet spec's own data (C166); titles, `background: null`, `usermeta`, `datasets`, `format.parse: null` (C162, C165, C181, C427); independent y axes'
  orient (C163); `config.header.title: null` (C167); one-dimensional views in nested compositions (C168); a facet over a `binned*` time unit (C183); a composition renaming
  `width` inside `labelExpr` (C299); arming a spec reordered its keys; a concat view's `description`; a facet sorted by a field over a calculate and a time-unit facet field
  reads the pipeline's own dataset; the datasets a facet of layers derives group by what the layers group by.
- Stack, scales and guides as vega-lite: the stack for every mark and pair of positions (C54, C176, C177, C221, C431) and `stack: "normalize"` that stacks nothing no longer
  fixes the domain; `scale.rangeMin` / `rangeMax`, `config.scale` (`zero`, `clamp`, `round`, `xReverse`, `continuousPadding`), a binned ordinal or nominal field read by its bin's
  text, `axis.values` / `legend.values` of a temporal field, `axis.offset`, the orient's config block, `axis.style`, gradient-legend opacity, `config.title` assembly, the autosize
  of a composition, and the tooltip title of a ranged mark with a `{datum}` end (C170 to C175, C222 to C224, C429 to C433, C535, C557, C558).
- Mark encoding: invalid values per channel (C178, C434); the size channel of a bar and a tick (C438); a binned field or time unit on a band scale at the band's start (C437, C559);
  a constant position with no orientation is a range (C436); `mark.url` of an image (C273); a scale bound to a selection clips only x and y (C435); `unselectedOpacity` (C560); an
  axis `orient` expression drives the labels (C226); a conditional field's format (C179); `mark.ariaRole`, `mark.shape: {expr}` (C536, C439); a rounded stacked bar inside a facet
  drew every segment once per row (C55: 300 rows, 30 000 rects in 271 ms, now 300 in 15 ms); the same time unit on x and y with a band position (C440); `mark.tooltip` as a number,
  `mark.aria` as an expression, an empty title list, a relative bar size over a continuous scale, an `align` on an hconcat / vconcat; a rounded bar with no dimension channel is
  clipped in one stack group; an `{"expr": ...}` where the schema takes any value is the literal object (C442); a position's channels over every combination of constants,
  spans and pre-binned fields; a `format` that is an object is read as vega-lite reads it; the `{row, column}` form of `align`.
- Composite marks: a unit kept none of its `params` (C59); a boxplot over a nested or dotted field, category or colour (C60, C189, C390); `title: null` on a measure (C190); a
  `detail` list with a time-unit entry (C444); a bin transform with `extent: {param}` (C186) and two equal bins (C187); the stack of an arc follows a colour domain (C185); a
  faceted map has no default projection type (C188).
- Internal: the next free `data_N` of a facet with shared scales is found by a fold, not a `Math.max(...)` spread (C464); dead code removed (C558, C561, C563). `compile` reads each
  generated dataset once when it looks for unused ones and keeps the tokens of the expressions it renames and scans; the undeclared-name check is one walk of the compiled spec.
  Compile cost against origin/main: a facet +32%, selection/params +27%, point / bar +19% / +27% (docs/PERFORMANCE.md).

### Repository and tooling

#### Changed (breaking for contributors)

- CI (`ci.yml`) runs on pushes to `main` only (C305). Contributor Node range is `^22.22.2 || ^24.15.0 || >=26` (root `engines`, `.nvmrc`); Node 20 stays supported for
  consumers and a test executes dist and React on it (C369, Q22). `SIG_PRINT=1` is now `--print-vega`, `SEL_NOFRESH` is removed, `pnpm probe` fails on a failing probe unless
  it is listed in `scripts/lib/expected-differences.mjs`.
- **Bundle budgets** (C331, C522, C523, C757): each file of an app is gzipped on its own (what a browser transfers); new rows `useChartWorker`, `hydrateChart` and `/ssr`; the
  React rows have a second ceiling for up front + on demand; a measure must sit 0.3 to 0.7 kB under its ceiling and a row that measures nothing fails; `ASTER_BUDGET_SIDE_EFFECTS=all`
  / `none`. docs/PERFORMANCE.md's table is the budgets' table and is tested against it (`scripts/perf-docs.test.mjs`; C368).
- **Every conformance gate's verdict comes from one harness, `scripts/lib/run-gate.mjs`** (C64, C230, C564; T4): it owns the exit code, fails a run that compared nothing, holds each
  counter to its floor and refuses a `dist` older than its sources (`browser-conformance` set no exit code at all). **Known differences live in one table,
  `scripts/lib/expected-differences.mjs`**, and each entry must still differ (`FIXED-GAP` / `STALE-GAP`); the canvas gate's skip list is gone. Every gate declares its `verdict` and
  `scripts/gate-self-test.test.mjs` runs it as a control, with `--plant-difference` and narrowed to nothing. Pixel comparisons require locality and ink (C65, C194). The gallery gate
  fails when a run is above its floor and holds the ratchet files against the base revision (`ratchet-overrides.json`; C262, C525), with a `seeded` path (C264).
- **No harness hands one object to both engines** (C61; T4): `forEngines(spec, fn)` takes two deep copies before either runs, guarded by a vitest setup file and a static rule.
  `scene-diff` compares the whole scene (C62); `conformance:diff` skips nothing (C193); the schema sweeps sweep every kind of a property (Vega 7 760 cases, Vega-Lite 33 043, values
  525; C263, C332, C479, C301, C759); every oracle render and data load has a 60 s deadline (C507).
- **Tests and gates leave no temporary directory behind** (four weeks of gate runs once filled a 394 GB disk): `scripts/lib/temp-dir.mjs` and `scripts/lib/launch-browser.mjs` own every `mkdtemp` and browser
  launch; `pnpm check` runs each gate with `TMPDIR` pointed at a fresh directory and fails a gate that leaves anything (`FAIL <gate> (left temp dirs)`); `scripts/temp-dir-leaks.test.mjs`
  plants each kind of leak.
- **Public-surface gate:** `scripts/public-surface.test.mjs` fails on any internal on a public entry (runtime exports, shipped declarations, API.md); `scripts/verify-publish.mjs`
  checks on the packed tarballs that every internal entry imports and that a consumer's `tsc` is refused every name from one, requires every export condition and bundles the
  `browser` ones (C509).

#### Fixed

- **A prerelease tag no longer publishes as `latest`** (C66): `scripts/release-publish.mjs` passes `--tag next` for any semver prerelease; a partial publish is finished by re-running
  the job (C231); the release steps push the tag (C367); docs/RELEASE.md has the recovery steps and why the three packages are pinned to each other exactly (Q21).
- Dependency boundary (C104): `createRequire` however reached, `process.getBuiltinModule`, `x['require']`, URL and `data:` specifiers, relative paths into `node_modules`, path references
  and `declare module` in shipped `.d.ts`, `npm:` / git / URL / file ranges in the manifest and every path in `files` are refused. Gates: per-gate deadlines and `timeout-minutes` on every
  job (C251); `--only` takes tags (C642); `pnpm typecheck` covers every test and runner script (C303; 45 hidden type errors fixed); `build` cleans `dist` (C566); the nightly floors validate
  every measurement and require every row (C197, C641); the benchmarks' `aster` row is string mode and `asterDom` the incremental one (C304).
- The lockfile has no deprecated package, `packageManager` carries the pnpm tarball's sha512, and `vega`, `vega-lite`, `vega-embed` and `react-vega` are exact versions (C393).
  `THIRD_PARTY_NOTICES.md` has a vega-tooltip section and its sections are compared with a source of truth by `scripts/notices.test.mjs` (C109, C687). Generated differentials all honour
  `ASTER_DIFF_SCALE` (C760). `noImplicitReturns`, `noFallthroughCasesInSwitch` and `noUnusedParameters` are on for every package (C568).

#### Added

- **The corpus and its gates** (1130 specs: 438 Vega, 692 Vega-Lite): `pnpm conformance` refuses render-identical entries (`corpus-identical.json`, empty) and entries that draw no
  item (`corpus-no-items.json`, each with its reason; C318, C520, Q31); `pnpm conformance-vl` compares the tooltip of every item and prints the data warnings real vega raises (C329,
  C516); specs that did not contain what their name states now do (each checked by deleting the property and comparing the oracle's SVG; the renames are in the commits); 33 + 28 composite specs use the default autosize instead of `none` (C255); every `$schema` is v6 (C595, C685).
- Differentials against real vega / vega-lite, generated: bounds and `intersect()` (`geometry-vs-vega`, `path-outline-vs-vega`), `pnpm conformance:geometry` (a blocking Chromium gate: the
  pick on each renderer and `intersect()` against vega, 160 specs under a deadline), `conformance:intersect`, `conformance:url-reload`, mark triggers, force layouts, scope signals,
  legend strips over late scales, selection stores, expression sites, dataflow cycles, mark role x config, running views, zindex, hover, mark defaults, the Vega-Lite encoding, stack, scales,
  guides, composite marks, transform outputs, animation, datum expressions, format objects; the Q9 parity assertion (`vl-oracle-defect.ts`: where the compiler refuses what vega-lite compiles,
  real Vega must fail on or draw nothing from vega-lite's output, and the typed `VLCompileError` is asserted). The oracle vectors (`packages/core/testdata/vectors`) were re-recorded with
  the committed generator for the dimensions the first recording lacked (C359, C621 to C623, C693 to C701, C763; `pnpm vectors` is reproducible).
- Test infrastructure: React's act environment is on in every test file and a state update outside `act` fails (C671); guards read syntax, not text (C346, C347, C659, C670); worker tests share
  one `fake-worker.ts` (C350, C351); guards that could not fail now can, each with a planted defect watched failing (C105, C199, C200, C338, C340, C456 to C459, C571, C651, C652, C736 and the
  titles of C460, C653); the default test run pins `TZ=UTC` (C379, C576); floors count what they name (C673, C586, C475, C587); the fuzzer has a scene space (C249). Docs: ADRs 0011 (engine parts
  load on demand), 0012 (the hit index is exact; a tooltip follows the pointer) and 0013 (PNG export), amended ADRs, ARCHITECTURE's tables follow the import graph, ERRORS.md lists every `[aster]`
  message stem, the package READMEs state the `moduleResolution` TypeScript needs (C371, C373 to C378, C447 to C454, C728 to C731); `scripts/docs-claims.test.mjs` and
  `scripts/docs-examples.test.mjs` compute the documents' claims from the sources and type-check their code blocks.

## 0.4.2 (2026-11-18)

### `@aster-charts/core`

#### Added

- **`limits: { regex: 'refuse' }`** (#174) refuses every spec that makes a regular expression, before anything of it runs: a
  regex literal, a call of `test` or `regexp` however it is written, or a `countpattern` with its own `pattern` /
  `stopwords`. The expressions are read when the spec is compiled (also branches that never run, event handlers and
  filters), so a spec is refused for what it is, whatever its data; a `RegExp` that reaches the engine at run time (host
  data, a signal value) is refused where it would run. For hosts that draw specs which need no regular expressions: the
  regex screen is a heuristic, and no limit can stop a regular expression once it runs (`.*a.*a.*a.*c` passes the screen
  and blocked for seconds on a few hundred characters). The default, `'screen'`, is unchanged. See docs/LIMITS.md
  ("Refusing every regular expression").

#### Fixed (security)

- **The event loop runs `signal.on` handlers under the chart's `limits`.** `<Chart>` interaction (and
  `bindSceneSignals`) ran the handlers' expressions, the event-stream filters and what they re-evaluate with no limits at
  all, even when the host passed them: a click handler ran a backtracking pattern the regex screen refuses everywhere else
  (`test('(a+)+$', ...)` blocked for seconds on 26 characters), and `maxTimeMs` and the string and row caps did not
  apply. Each event now runs under the limits its scene was evaluated with (one wall clock per event); a violation ends
  that event's run and is logged, as any handler error. Hosts pass nothing new.
- **A mark's `blend` reaches SVG output only as a `mix-blend-mode` keyword** (#170). It was written into the `style`
  attribute as given, so a value from the data or an expression such as `multiply; background: url(...)` added CSS
  declarations of its own: it loaded resources the URL policy and `urlData: 'refuse'` never see (also when written with
  a CSS escape, `\75 rl(`), and could restyle or move the mark. Now only a keyword is written, matched as CSS matches it
  (surrounding whitespace and ASCII case ignored); anything else draws as if no blend were set.
- **Paint never references another document in SVG output.** A `fill`, `stroke` or background of
  `url(<another document>)`, which can come from the data, made Chromium fetch that document, again past the URL policy.
  Such a reference at the start of a paint is now replaced by its fallback colour, or `none`, which is what Firefox and
  WebKit draw for it; one anywhere else drops the attribute. A reference within the page (`url(#pattern)`), colours and
  gradients are written as before.

The `blend` and paint fixes apply to the string renderer, the DOM renderer and its patches, with or without `limits`; the
canvas renderer was not affected. See docs/LIMITS.md ("Blend modes", "Paint references").

The synchronous entry is 175.7 kB gzip (175.0 in 0.4.1), `<Chart>` 181.7 kB (180.9); string rendering and event handling are
no slower.

## 0.4.1 (2026-11-16)

### `@aster-charts/react`

#### Added

- **`import '@aster-charts/react/all'`** loads every part of the engine up front, so no chart ever waits for one: for apps that
  prefer bytes up front to a round trip the first time a chart uses a rarer feature (`<Chart>` with it: 246.4 kB gzip).
- **`preloadParts(names?)`** fetches chosen parts ahead of time (every part when called without names).

#### Performance

- **More of the engine loads on demand.** The aggregate transforms (aggregate, joinaggregate, pivot, facet groups, domains
  sorted by an aggregate), `window`, the reshaping transforms (collect, sample, fold, flatten, project, extent, sequence,
  lookup, impute, stack, identifier, bin), time scales, formats and parsing, every curve but `linear`, colour spaces,
  interpolators and schemes, and the rarer scale types are parts the shells load when a spec needs them, read from the spec
  and its parsed expressions; a property a signal drives loads its whole family. Nothing is declared: any spec renders as
  before. In a browser build `<Chart>` is 180.5 kB gzip up front (204.5 before), `<SvgChart>` 166.9 (190.7), `useChart`
  145.0 (168.9), `<Chart>` + Vega-Lite 287.0 (311.1); the chart-bench `<Chart>` app's library cost is 180.2 kB (202.5).
  Mount time is within 10% of 0.4.0. A part the engine reads that was not loaded is an error naming it, never a different
  drawing (see docs/PERFORMANCE.md and docs/API.md).
  **Breaking in effect:** in a browser build the first commit of a chart whose spec needs a part of the engine (0.4.1: aggregate, time,
  colour, curves, so most Vega-Lite charts) is the `<Suspense>` fallback. **Migration:** wrap charts in `<Suspense>`, or
  `import '@aster-charts/react/all'`, or call `preloadParts` (ADR 0011).

### `@aster-charts/core`

#### Changed

- The synchronous entry (`renderSpec`, sessions, `renderChartToStaticMarkup`, `hydrateChart`, the worker) still carries every
  part, and is 174.7 kB gzip (172.7 in 0.4.0) for the slots the parts are read from.

## 0.4.0 (2026-11-15)

### `@aster-charts/core`

#### Changed (breaking)

- **A row that is `null` or `undefined` is an error, as in vega.** 0.3.0 drew such a row: it read it as `{data: null}`
  (or boxed it, for a `{signal}` values), so it was drawn and counted in aggregates (`count`, a stack, a domain). vega fails
  on it, and Aster now fails where vega fails, with the same class of error (`TypeError`) and a message of its own that names
  the dataset, the row and where it came from: thrown for a spec's inline `values`, the host's `data` and `dataChanges`, and by
  a stream's `push`; logged, with the pass stopped where vega's stops, for a group's inline values, `setdata` and the mark that
  joins a row a `{signal}` values made. To keep such rows out, filter them before passing the data (`rows.filter((r) => r != null)`).
  See `docs/ERRORS.md`, "Rows that are null or undefined".

#### Fixed

- Every scene item has the `datum` vega gives it. The item of a mark without `from` had none (vega: a generated `{}`, which its
  encode already read); an axis' ticks, labels and grid lines now carry their tick tuple and its domain and title the axis datum,
  a legend's symbols, labels and bands their entry, its title and gradient the legend datum, a title's texts the title's `{}`, and
  the axis, legend and title group items their own datum; a legend entry's box is vega's entry group item (`{index, count}`, and
  `item().items` holds its symbol and label, as vega's legend click handlers read them). A group item keeps its `tooltip`.
  `event.item.mark.name` is the name the spec gave the mark (a mark it did not name has none, so **(breaking)** `@marks:click` no longer
  matches it), and an axis or legend part's `mark.role` is vega's (`axis-label`, `legend-symbol`...).
- **(Breaking)** The hit index picks what vega picks: the topmost item whose painted geometry contains the point, with no pointing slack (a thin line
  or a small touch target needs an exact hit: draw a larger transparent mark). A
  2px tolerance around every item made a dense chart report a point drawn later whose edge was a fraction of a pixel away instead
  of the point under the pointer (on a 10,000-point scatter, the circle 0.19px away). A stroke is hit as it is painted (half its
  width, its caps and joins), a symbol with only a stroke by its ring, an item with neither a fill nor a stroke not at all, a
  transparent stroke like a transparent fill; a rect no longer wins over the marks drawn after it in a group; clips and the view's
  own edge bound what is picked; a stroked trail takes the pointer along its stroke; and `pick` (vega's `event.item`) reports a
  line, an area or a trail as its first item, as vega does. With a picker, the event loop takes `event.item` from it alone, not
  from the DOM element under the pointer.
- A spec whose autosize is `none` keeps its own size when a host passes the container it measured (`measuredSize`): in Vega its
  whole size is its `width`, `height` and `padding`, and vega-embed draws it so in any container; it was filled to the container
  with autosize `fit`, which shrank its plot to make room for the guides (the chart-bench frame, 824 x 536 at 56,20 in a 900 x 600
  box, was drawn 786 x 499 at 92,25). `StreamBatch` takes `containerSize` and `measuredSize`.
- `HitIndex.tooltip(x, y)` is the item vega's tooltip handler is called with (the topmost item that takes the pointer; a line,
  an area or a trail resolved to one of its items as vega resolves it); `HitTarget` says what was hit (`kind`) and whether the
  item's mark reads a dataset (`fromData`). `queryMark` returns the items of a mark without `from` like any other's.
- A group item with `noBound` leaves its clipped content out of its bounds, as vega's bound pass does: its children no longer
  size the view under autosize `pad` or `fit` (corpus entry `group-nobound`), and the pointer picks within the group's bounds.
- `isTuple` is true for what vega's dataflow made a tuple (a dataset's rows, each transform's rows, a mark's datum and a mark
  without `from`'s `{}`, the copies of a mark's items another mark is made from, a group item's datum, an axis', a legend's and
  a title's data) and false for anything else; it was false almost everywhere. Nothing is stamped on a row to say so, and only
  a chart that asks `isTuple` of something other than Vega-Lite's `group()` and `facet` keeps track of them.
- `parent` is the datum of the group item around a mark whatever made it: in a group mark without `from` nested in a facet cell
  it was the cell's datum, where vega gives the plain group's `{}` (corpus entry `group-parent-plain`).
- Autosize `none` containing the padding with a size smaller than the padding (no `width` at all, say) keeps vega's negative
  view: the scales, the grid and the root group's box are laid out on it and the axes placed as on a 0-wide view, in an svg of
  `max(0, size)`; Aster clamped the view to 0 and drew a padding-sized svg without the axes (corpus entry
  `autosize-none-padding-unsized`, promoted from the probes).
- On the SVG, a `pointerout` / `mouseout` / `dragleave` is about the item the pointer leaves, as vega's (the element it is
  dispatched to): it was about the item under its new point, so `@bars:mouseout` did not fire when the pointer left a bar for
  empty space or left the chart. `event.vegaType` is the type the stream listens to, as in vega.
- A scene a session hands back unchanged, and every mark or scale kept from an earlier evaluation, is formatted under the
  default locale and in the time zone in use: after `defaultLocale(...)`, or a change of the host's time zone, the next
  evaluation formats afresh (it kept showing the old text until the data or signals changed).

#### Added

- `createCanvasEvents(canvas)` (`@aster-charts/core/canvas`): the canvas renderer's events for the signal event loop
  (`bindSceneSignals(canvas, scene, signals, hooks, { pick, events })`), resolved as vega's canvas handler resolves them: an
  event is about the item the last `pointermove` picked, a move that changes item is also the out and over of the two, every
  `pointermove` is also a `mousemove`, a click counts only on the item pressed, a touch is about the item it started on. The
  hovered item outlives a re-bind (a new scene's item at the same place stands for it; one gone from the scene is not left).
  `bindSceneSignals` takes any rendered element (the svg or the canvas).

#### Performance

- **A signal change re-does only the work downstream of it.** A top-level group mark (a facet, Vega-Lite's colour-grouped lines
  and areas) whose subtree reads nothing that changed is kept whole; a mark over the rows its items were made from evaluates
  again only the channels that read what changed, and an item whose re-evaluated channels come out as they were is the item
  before; a mark drawn from another mark's items (Vega-Lite's voronoi) is kept when what it reads of them is as it was. What is
  derived from a scene -- the hit index, the DOM descriptors, the accessible tree's boxes, `event.item`'s parent links, the
  cursor check -- is kept with the engine's nodes and costs what a scene made anew. On the chart-bench heavy survival chart a
  60-move pointer sweep in Chromium costs about half the CPU it did with the Vega spec (603 -> 314 ms) and a quarter with the
  Vega-Lite spec (4,204 -> 1,043 ms); see docs/ARCHITECTURE.md for what each reuse reads.
- A dense hit index answers its first queries by a scan of the item boxes and builds its grid when asked more; a path item's
  outline is placed when a query first reaches its box.
- **A pointer move re-does less around the scene too.** The view's axes are kept from the evaluation before when nothing they are
  made from changed, and the DOM patcher and the hit index keep what they made of a kept axis and of a mark's kept group items; a
  filter or a sort over another dataset's rows copies only the rows it returns; binding the event loop no longer reads every point
  of every leaf mark. On the chart-bench heavy survival chart (five alternating pairs, Chromium, one 60-move sweep each, CPU-busy
  median) the Vega spec's sweep costs 245 ms where it cost 295, the Vega-Lite spec's 875 where it cost 976; the vega arms moved
  by 3 % or less.
- `paintsSameAs(snapshot, scene)` (`@aster-charts/core/canvas`): whether a scene paints exactly the pixels already on the canvas.
- **Less again per pointer move.** A filter's or a formula's loop over its rows reads each signal its expression names once per
  pass, when nothing in the pass can write one (the interpreted predicate `hoverX != null && datum.x <= hoverX` went from about
  27 to 8-13 ns a row); the state an aggregate, joinaggregate, collect or flatten leaves for the next pulse is made of what the
  step computed as it ran instead of reading every row again; binding the event loop again on the same element for the same
  chart compiles no expression again; and the view's legends and title, and every guide of a group mark, are kept from the
  evaluation before when nothing they are made from, or placed against, changed. On the chart-bench heavy survival chart (five
  alternating pairs, Chromium, one 60-move sweep each, CPU-busy median) `<Chart>`'s sweep costs 229 ms where it cost 246, the
  canvas renderer's 230 where it cost 239; the Vega-Lite spec, the scatter chart, every mount and the vega control moved by 2 %
  or less.

### `@aster-charts/react`

#### Performance

- `<Chart renderer="canvas">` paints nothing for a scene that paints the pixels already on the canvas (a pointer move that changes
  only a tooltip): the chart-bench survival chart's canvas sweep costs 247 ms where it cost 692 (vega's canvas: 537).
- A pointer move that only moves the tooltip renders the tooltip, not the chart; a scene that leaves the accessible tree as it
  was renders none of the accessible overlay.
- **A chart loads only the parts of the engine it uses.** The legend builder, the grid layout, the SVG path reader (custom
  symbol shapes, path marks), vega-selections' functions, the regular-expression screen (under `limits`), the pulse path
  of the incremental engine (once a chart's data changes), `intersect()`, `modify()` / `setdata()`, `timer` streams and,
  for `renderer="canvas"`, the canvas renderer are chunks the shells import when a spec needs them, suspending meanwhile as
  for the add-ons (the first commit is the `<Suspense>` fallback, never a half-made chart). In a browser build `<Chart>`
  is 209.1 kB gzip up front (235.0 before), `useChart` 165.9 (180.8), `<SvgChart>` 188.0 (203.2); the chart-bench `<Chart>`
  app's library cost (Vite) is 202.3 kB (225.4, measured on the layer below the hover finish). A chart that needs none of these fetches nothing; mount CPU is within 3%
  either way. Outside a browser build (the `browser` export condition) every part is there, so a server render draws what it
  drew; `@aster-charts/core`'s synchronous API carries every part as before.
  **Breaking in effect:** in a browser build the first commit of a chart whose spec needs one of these parts (the canvas renderer, the signal
  loop, ...) is the `<Suspense>` fallback. **Migration:** wrap charts in `<Suspense>`, or `import '@aster-charts/react/all'`, or call
  `preloadParts` (0.4.1; ADR 0011).

#### Fixed

- `<Chart renderer="canvas">` binds the spec's event loop, as vega's canvas renderer does: `signal.on` streams of every form,
  `event.item` / `item()` / `group()`, Vega-Lite selections (point, interval, nearest, bound scales, legend bindings, bound
  inputs) and `setSignal` with its dependent updates, which were SVG-only (a chart-bench survival chart, whose tooltip reads a
  `pointermove` signal, showed no tooltip on canvas). The pointer of the tooltip, the cursor, a click and pan / zoom is read in
  the canvas's own box (it was the chart container's, a border or padding on the canvas away). At a device pixel ratio of 1
  the canvas has no CSS size (**breaking**: size it with CSS), as vega's: a host's CSS sizes it as an image (`max-width` with `height: auto` keeps its
  proportions) and the pointer maps by that box.

- A tooltip shows the item vega shows: the topmost item that takes the pointer. A tooltip encoded on a mark without `from` (a
  transparent hover target, the usual way to give a Vega chart's empty plot a tooltip) never showed; a group item's tooltip
  (a facet cell) and an interactive axis, legend or title part's never showed either; a data mark drawn under a mark without
  `from` showed through it; a falsy tooltip value (`0`, `false`) showed, where vega shows none. `renderTooltip` is called for
  an item with a `tooltip` value or made from a data row. **(Breaking)** A click (`onPointSelect`, a point `SelectValue`) selects vega's event
  item when it is an item of a mark (a mark without `from` gives `{}`), and nothing under it.
- `<ChartStream>` and `<ChartWorkerStream>` without size props size the stream to the container they measure, as `<Chart>` sizes
  its own evaluation (they drew the spec at its own size, and Vega-Lite's `"container"` at its fallback size).
- docs: `denseMarks` batches only opaque, unrotated symbols (a translucent symbol keeps its own element: one path composites
  once where separate elements composite at every overlap), which is why a scatter with `fillOpacity` below 1 stays per item.
  **Superseded** (unreleased): a translucent, blended or filled-and-stroked symbol is batched with the symbols it cannot overlap.

## 0.3.0 (2026-11-12)

### `@aster-charts/core`

#### Fixed

- A dataset's rows come from its `values`, else its `url`, else its `source`, as in vega: a dataset with `values` and a `source`
  drew its source's rows (and one whose `source` named no dataset drew nothing); one with a `url` and a `source` drew the source's
  rows instead of asking for the url to be loaded; and `loadSpecData` tried to fetch an empty `url`. The compile, the session, the
  stream and `loadSpecData` now all read the one vega reads (`dataInputOf`; corpus entry `data-values-over-source`).
- **(Breaking)** A `url` dataset in a group mark that was never loaded fails the render with the same error as a top-level one (`has a url but no
  data was loaded for it`, pointing at `loadSpecData`); it used to be an empty dataset, so its marks silently drew nothing. Load the data
  (`loadSpecData`) before rendering a spec with such a dataset.
- `loadSpecData` loads a `url` dataset given as a single object (`data: { name, url }`, at the top level or in a nested group whose
  `marks` / `data` is a single object), and evaluates a `{signal}` url against `signals` given as a single object, as the compiler
  reads those lists (vega's `array()`). It used to skip them, and the render then failed with "has a url but no data was loaded".
- `addonsNeeded` counts a `projections` given as a single object (at the top level or in a group), so `<Chart>` loads the geo add-on
  for it instead of failing the render.
- A chart session given a spec whose top-level dataset has lost its inline `values` (or gained them), with nothing else
  changed, compiled it afresh only if something else differed: it went on with the chart compiled from the other spec, so
  rows that were no longer in the spec could still be drawn. Whether a dataset has rows is now part of what makes a chart
  the same; the rows themselves still are not (#143).

#### Added

- `urlData` in the runtime input (`'allow'`, the default, or `'refuse'`; type `UrlDataMode`): with `'refuse'` a spec that has a
  `url` dataset (one with a non-empty `url` and no `values`, at the top level or in a nested group) fails at once with an `AsterUrlError`
  (`ASTER_URL_DENIED`) that names the dataset, whether or not `data` gives its rows. Sessions and streams (`initial.urlData`)
  take it too. `urlDatasets(spec)` lists a spec's url datasets and `checkUrlData(spec, urlData)` throws the refusal without
  rendering. `addonsNeeded`, `missingAddons` and `loadAddonsFor` (`@aster-charts/core/addons`) take `{ urlData }`: under
  `'refuse'` a url dataset's readers are not counted, and `loadAddonsFor` rejects with the refusal before importing anything
  ([docs/LIMITS.md](docs/LIMITS.md#refusing-url-datasets-urldata), #143).

- `@aster-charts/core/canvas`: `sceneImageUrls`, `loadImages` and `withSceneImages`, the image-mark loading `<Chart renderer="canvas">`
  and `renderSceneToPng` share.
- `@aster-charts/core/png`: `renderSceneToPng(scene, { scale, imageTimeoutMs, onImageError })` paints a scene with the canvas
  renderer and encodes it with the platform canvas as a PNG `Blob`, exactly the pixels `renderSceneToCanvas` paints. It loads no
  `blob:` or `data:` image, so it works under a Content-Security-Policy that allows neither in `img-src`. Image marks are loaded from
  their urls with CORS, as vega's canvas loads them; one that does not load is left out and reported (#144).

### `@aster-charts/react`

#### Fixed

- `<Chart renderer="canvas">` draws image marks that have a `url`, as vega's canvas renderer does: it loads each url (with CORS,
  `crossOrigin = "anonymous"`) and repaints when it arrives. It used to draw none of them, since the canvas renderer only draws
  bitmaps it is given. Loaded images are kept when the data changes; one that does not load is reported to `logger.warn` once.

#### Added

- `getPng(options?)` on the ref of `<Chart>` (and of `<SvgChart>` given `png={png}` from the new `@aster-charts/react/png`): the
  chart's scene as a PNG `Blob` (`null` while there is none), with `scale` for high-density output. The painter is imported on the
  first call, so a chart that never exports does not load it; an image mark that does not load is reported to the chart's `logger`.
  Raster export was out of scope; this one convenience is in, because the usual recipe (the SVG in an `<img>`) needs `blob:` or
  `data:` in `img-src` (#144).
- `urlData` on `<Chart>`, `<SvgChart>`, `<ChartStream>` and `<ChartWorkerStream>`, and in `useChart`, `useChartWorker` and a
  stream's `initial`: `urlData="refuse"` refuses a spec with a url dataset before any add-on loads (the csv readers a url names,
  or anything else the spec needs) and reports the `AsterUrlError` through `onError` / `error`. The worker imports nothing for
  such a spec and answers with the refusal (#143).

## 0.2.0 (2026-11-11)

### `@aster-charts/react`

#### Fixed

- A chart without size props in a container whose height is its own no longer grows: the bound inputs under the chart
  are not counted as the chart's, and the inline `<svg>` no longer leaves a descender gap below it (#128).

#### Added

- `transition` on `<Chart>` and `<SvgChart>` (`true` or `{ duration, easing, reducedMotion, maxItems }`, type `TransitionOptions`): a
  change of data animates in the SVG from the picture on screen to the new scene, and settles on exactly the scene a chart
  without it draws. Items are matched by the mark's `key` (Vega-Lite's `key` channel), else by index; bars grow from their
  baseline, other new items fade in, axes slide to their new ticks; new data mid-way starts from the frame on screen;
  `prefers-reduced-motion` is honoured by default. Signals, pan / zoom, resizes and legend toggles are drawn at once; hit
  testing, tooltips and the accessible tree answer for the new scene. `<ChartStream>` passes it through, and a Vega-Lite
  `time` animation tweens between its frames. The canvas renderer and batched dense marks draw at once. The interpolation
  loads on demand. A change that moves more than `maxItems` items (default 1,000) is drawn at once ([docs/ANIMATION.md](docs/ANIMATION.md), #127).

#### Changed

- **(Breaking)** `tooltip` shows the hovered item's `tooltip` value, as Vega with vega-tooltip does (the Vega-Lite `tooltip` encoding with
  its titles and formats), and nothing for a mark without one. It used to list every field of the datum, including
  Vega-Lite's internal fields. To list a datum, encode `tooltip: { signal: "datum" }` (#129).
- `renderTooltip` receives a second argument, `{ tooltip, item }` (`TooltipInfo`): the item's `tooltip` value and the
  scene item (#129).

### `@aster-charts/core`

#### Changed

- `@aster-charts/core/transition`: a running transition given a scene that draws like its end (a Vega-Lite `time`
  animation's clock between two frames, a signal no mark reads) keeps its plan instead of planning again; `drawsSame(a, b)`
  is exported. On 1,000 keyed rects: 0.18–0.27 ms instead of 1.01–1.13 ms per such scene, and 0.001–0.002 ms when the
  scenes share the mark (`bench:transition-retarget`).
- **(Breaking)** The container a host measured (`measuredSize`, which `<Chart>` passes when it has no size props) sizes the chart's whole
  box, as Vega-Lite's `"container"` does (autosize `fit` containing the padding): the content shrinks so padding and
  guides fit inside. It used to size the plot, with padding and axes added on top, so a chart overflowed the container
  it filled, and a container whose height is the chart's own (a block `<div>`) grew on every measurement (#128).
- A data update on a view that fits its viewport (`autosize` fit / fit-x / fit-y, Vega-Lite `"container"` sizes, and every
  `<Chart>` without size props) is incremental in both of the view's layout passes: each pass starts from the same pass of the
  evaluation before. A one-row update on a 10,000-point chart went from 5.8 to 1.4 ms (Vega spec in a measured container) and
  from 37 to 4.5 ms (Vega-Lite `"container"`), about the cost of the same update at a fixed size. The scene is unchanged; a fit
  view now also keeps its first pass's state (and items) between evaluations.
- A signal change keeps the top-level marks and scales that do not read it: a mark keeps its group and its items, a scale its
  object, when the signals its definition names, the view's size and the datasets it reads are as they were. A tick of a
  Vega-Lite `time` animation on 3,000 points (its clock advanced, its marks reading the frame's rows) went from 11.9 to 0.9 ms,
  every item kept, until the frame moves. A dataset with no transforms keeps its copy of rows the session says are unchanged,
  and a transform step that reads a dataset by a name it spells out (`data("store")`, `vlSelectionTest("store", datum)`) is
  kept while that dataset's rows are equal. Marks with transforms, marks and scales that read datasets or scales from an
  expression, and group marks are made again on any signal change, as before; so is everything under `limits` or in an
  `evaluateChart` call without a change description. The scene is unchanged. A one-row stream append costs about 6 µs more.
- Selections keep what they do not touch. A dataset built again in a later round of an evaluation (once a selection's
  `vlSelectionResolve` signal resolves) or in the second pass of a fit view is kept when its inputs and what its steps read are
  as they were, its `identifier` numbers included, so a point selection's dataset, and the scales over it, survive a signal
  change. A mark that tests a store (`vlSelectionTest("brush_store", datum)`) is keyed by that store's rows and the signals it
  names, not by every signal. A pulse runs through a pipeline whose reads did not change, whichever other signals did, so rows
  appended while a hover or a brush moves encode only the new items. On 5,000 points: an unrelated signal 22.5 to 0.7 ms (point
  selection), 17.2 to 0.6 ms (interval brush); a click 22.2 to 16.8 ms; a row appended while a signal moves 28.5 to 0.8 ms; in a
  `"container"` view 47.6 to 1.8 ms; a brush drag through `<Chart>` in Chromium 115 to 82 ms per move. A drag step itself costs
  about what it did (17.2 to 17.3-17.9 ms). Keys now read names as the expression lexer does (an escaped or non-ASCII name is the
  name it spells), and a step that calls `random` by an escaped name is one that draws. The scene is unchanged.
- A discrete scale over data (ordinal colour, shape, size and strokeDash; band; point) keeps its object when its rows change
  and its result does not, so the marks that read it encode only the rows that changed. Rows of categories it has, appended or
  edited, advance a census of the categories (also after Vega-Lite's validity filter); a removal, a reorder, a sort by count or
  by an aggregate, a domain of several fields or datasets and a `domainRaw` read the scale's settings again and keep the scale
  when they are the same. A new category, a category gone or a sort order that moves makes it again, with everything that reads
  it. On 5,000 rows through a chart session: a row appended to a scatter coloured by a category 15.6 to 1.7 ms, a row removed 15.0
  to 1.8 ms, a `createChartStream` append 14.8 to 0.6 ms; a bar chart with a nominal x 15.0 to 4.2-5.1 ms per append. A line per
  category is drawn in a group mark: see the next entry. The scene is unchanged.
- The marks inside group items (a line per category, a facet's cells, a concat's views, a group per row) are kept by the item they
  are in, and encode only the rows that changed; a group item that did not change keeps its identity, with its guides and title.
  On 5,000 rows through a chart session: a row appended to a line per category 18.4 to 3.0 ms, to a column facet 16.7 to 3.7 ms, to
  two concatenated views 25.1 to 4.0 ms. The scene is unchanged.

#### Added

- `@aster-charts/core/transition`: `createSceneTransition(from, to, { easing, maxItems })` pairs the items of two scenes (by the
  mark's `key`, else by index; facet groups by their `groupby`; axis ticks by value) and returns the frames between them
  (`at(t)`, where `at(1)` is `to` itself); `easingFunction` and `EASING_NAMES` for the named curves. Scenes now carry the
  key fields of marks and group items and the tick value of axis leaves, which no renderer draws (#127).
- `@aster-charts/core/signals`: `hooks.onData` gets a third argument, `fromTimer`, true when a `timer` stream's tick made
  the edit (#127).

#### Fixed

- A spec that drives one view dimension itself keeps its other, numeric dimension when a host measures its container. A
  Vega-Lite spec with `width: "container", height: 200` in `<Chart>` grew on every measurement inside a block `<div>`
  with no height of its own, because the measured height replaced the 200 and the container grew with the chart (#128).
- A mark drawn from the items of another mark (`from: {data: <mark name>}`) was empty after an update told that some other
  dataset changed, when the mark it reads was kept from the evaluation before.
- A dataset whose transform throws stops the pass before every mark, as in Vega. After an update told that some other
  dataset changed, a mark kept from the evaluation before was drawn anyway.
- A `filter` whose expression reads a scale, or a dataset the same update changed (`length(data("t"))` over its own source; a
  selection's store edited together with the rows it filters), kept its verdict on the rows that had not changed: a pulse
  judged only the new and modified rows, so rows a moved scale or store would now drop were drawn. It judges every row again.
- A mark that reads a dataset's hierarchy (`treePath`, `treeAncestors`) or a scale through an expression that spells the
  function's name with an escape was kept after its data changed.
- An `identifier` after a transform that reads a scale numbered its rows again on every evaluation, with numbers another
  dataset's rows held (a point picked in one selected a point of the other, and a picked point was lost on the next signal
  change). Such a dataset is now numbered after the scale it reads, as in Vega, and its rows keep their numbers.
- An `identifier` after a `filter` gave a row the filter let through again a new number. A row keeps the number of its source
  row while that row lives, whether the filter passes it or not, as Vega's tuples do. This holds for appends too: they still run
  from the rows the evaluation before made, and they follow only the rows they add. An append on 10,000 rows takes 0.29 ms
  (0.28 ms before).
- A scale was kept after an update with a domain or a range that was no longer right: a scale whose domain or range reads a dataset
  or a scale from an expression (`{signal: "[0, length(data('t'))]"}`, a range ending at `bandwidth('x')`) when its own domain's
  dataset did not change, and a scale whose range comes from another dataset (`range: {data: 'r', field: 'f'}`) when that dataset
  changed. Both are now read again.
- An ordinal scale that adds the categories it is asked for to its domain (`domainImplicit`, a `domainRaw`, or no domain) was
  kept from one update to the next, with categories that rows since removed had added. It is made again on every evaluation.
- A pulse through a step that publishes a signal (Vega-Lite's `{extent, param}`) kept the rows of the steps after it that read it
  (a `calculate` over the extent): removing the row of the minimum left every other row normalised by the old extent. The steps
  after such a step run over every row when the value it publishes moves.
- After a node of a `force` layout with a `link` force was added or removed, the marks drawn from the link rows kept the paths of
  the layout before. The force's mark and the marks reading its links are made again together on every evaluation.
- A session that was not told what changed took `0` and `-0` in a row for one value, and compared nested values by JSON (`Infinity`
  and `null` were one value, as were any two Maps). Cells compare as the scene sees them (`Object.is`, Dates by their instant).
- A discrete scale was kept when an update told of the change (`dataChanges`) turned a category's first value from `0` into `-0`,
  which the domain then lists.
- Names spelled with escapes in expressions (an escaped `data`, `random` or signal name) were missed wherever the engine read
  what an expression depends on: the order of datasets and signals, what a data change affects, which sites draw from an
  injected `random` and what they read, `setdata`, late signals, a projection's fit, `init` signals that read data or scales, and
  formulas over a hierarchy (`treePath`), which were also taken as row-local. They are read as the expression lexer reads them.

### `@aster-charts/vl`

#### Changed

- Layers (or the views of a composition) that sort a shared scale differently are still refused, and the error now says which
  layer has which sort: `layers sort the shared scale "y" differently: layer 0 (bar) {"op":"sum","field":"order"}, layer 1 (text)
  {"op":"min","field":"order"}`. A sort written once in a shared encoding can differ per layer through each mark's default `op`;
  when only the `op` differs, the error says to give the sort an explicit one (#135).

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
  **Superseded:** the regex screen runs only under `limits` (docs/LIMITS.md); without `limits`, `test(/a*a*a*a*a*b/, 'a'.repeat(3000))` in a signal
  does not return, so the sentence about `a*a*a*a*a*b` above does not hold without `limits`. 0.4.2 added `limits: { regex: 'refuse' }`, and the
  unreleased entries above replace the screen's shape rules with a per-run cost check under `limits`.

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
  - **(Breaking)** `buildA11yTree` boxes are in the viewport, as `A11yNode` always said: the padding and the frame offset are in the
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
