# Gallery triage (snapshot)

Generated from a run of `pnpm conformance:gallery` at the commit that introduced the gate, by `scripts/gallery-triage.mts`
(per-spec data: `triage.json`). **No engine bug is fixed in the branch that added this**; this is the map for splitting the fixes.

## Update: the last failures (branch fix/gallery-last)

Gate after: static Vega 89 / 93 (4 unverifiable: their oracle needs a canvas Node lacks), Vega-Lite 627; react Vega 93, Vega-Lite 627
(swap 223 / 223).

* `vega/pacman` (react): the signal event loop was a fixed-point evaluator; vega runs a ranked dataflow (each operator at most once per
  stamp, a handler assignment that does not pulse leaves its dependents as they were, `modify` a run of its own). `signals.ts` now runs
  `signal-propagation.ts`, which models vega-dataflow's evaluation order (each node once per propagation, in order); differential: `signal-dataflow-vs-vega.test.ts`.
* `vega/word-cloud` (react): `wordcloud` is vega-wordcloud / d3-cloud now, its sprites drawn on the host's canvas as vega's are;
  differential: `wordcloud-vs-vega.test.ts`.
* `vega/time-units` and the other `timeoutMs 10000 exceeded loading data/...` errors under load: the harness, not the engine
  (see the README: the data is preloaded into the page).

## Update: the remaining real failures (branch fix/gallery-remaining)

Gate after: static Vega 84 / 93, Vega-Lite 617 / 627; react Vega 82, Vega-Lite 615 (swap 223 / 223). Closed, with the cause:

* `vega/arc-diagram` (react): a view dimension the spec gives no value (no number, no signal) is 0 in vega and autosize grows it to the
  content; `<Chart>` sized it to the measured container. `contentSized` now covers any such dimension (not only a composition's); autosize
  `fit` also keeps the viewport of a dimension that is 0 (nothing to shrink) instead of the content-grown size.
* `vega/contour-plot`, `vega/density-heatmaps` (react): the `heatmap` transform (transforms add-on) and the image mark's bitmap
  (SVG `href` = the document canvas' own PNG, byte for byte vega's in Chromium; canvas draws the canvas the bitmap keeps its pixels in).
  The static path stays `unverifiable`: vega's heatmap throws in Node (no canvas), reason `oracle-error`. The pixels are held to
  vega-geo's own Heatmap in Node with a pixel-keeping canvas stand-in (`heatmap-vs-vega.test.ts`), the canvas renderer to Chromium's.
* `vl/interactive_1d_geo_brush`, `vl/interactive_airport_crossfilter` (react only: the static path never fires the timer tick): the engine
  had no `intersect()` expression function (the geo interval selection selects what is drawn inside the brush), and a view whose
  frame fill is `transparent` was not picked by the pointer over the empty plot (so the brush's `pointerdown` never ran).
  `scripts/browser-intersect.mts` (every mark type against vega in Chromium) and four geo cases of `browser-vl-selections`.
* `vega/platformer` (static): not time-driven. A signal's non-string `init` (`init: 15`) was dropped; with vega's timers held off the first
  frame is equal. It passes on the static path now (its oracle ticks only if a timer fires before the SVG is taken: 12 of 12 runs
  under CPU load were equal; the deterministic-oracle work owns the rest).
* `vega/projections`: Aster did not build a group mark's `projections` (every cell drew with mercator). Vega 6.3.1 registers 17 projection
  types; `airy` and the rest of d3-geo-projection's set are vega-projection-extended's. An unregistered type throws in the Projection
  transform, which stops the pass: ONE error logged; in a group item's scope the items before it are whole and it and the ones after
  keep their frame, with no layout (the view is 0 x 0); at the view's scope nothing is made. The engine does exactly that and has no
  projection beyond vega's 17, so there is no superset to keep: the extended names are refused like vega. The spec now equals vega's
  own (failing) render on both paths -- a pass in the sense of "same document and same logged error", not of drawing the maps.
  Needed too: a mark's `clip: {sphere}` / `{path}` / `{signal}` shape, `geoShape` / `pathShape`.

Still open, with the reason:

* `vega/labeled-scatter-plot` (static): vega's `label` needs a canvas in Node. The `canvas` package (node-canvas, cairo) was tried as the
  oracle (installed outside the repo, run in a child process, text measured by the same canvas on both sides): 4 of 2260 labels are
  placed differently, because cairo and the browser's Skia rasterise the marks the labels avoid differently and Aster's raster follows
  Skia (it equals Chromium on the react path). So a Node canvas oracle cannot be equal without breaking the browser match; the
  spec stays failing on the static path as an oracle limitation, and is held by `label-vs-vega.test.ts` and the react path.
* `vega/word-cloud` (static): needs a canvas too, and is random.

## Update: runtime fixes (branch fix/gallery-runtime)

Gate after the runtime work: static Vega 61 / 93, Vega-Lite 274 / 627; React Vega 45 / 93, Vega-Lite 205 / 627 (from 37 / 251 and
30 / 186). The tables below are the snapshot the work started from. Closed since: `time()` and the date functions, inline primitive
`values`, a mark reading a group mark's items (and the mark transforms that read items), line / area breaks and curves (which also
fixed `stacked_area*` and `interactive_legend*`), values taken from signals / other datasets (source lists, projection type, signal
url and values, signal order), `tree` / `treelinks` / `force` / `kde2d` / `isocontour` / `geopath` and the missing functions, the
gradient fill, the trail arc flags, the text mark of an empty signal, the shape stroke bound, `geoshape` `pointRadius`, the `&quot;`
text. Still open on the runtime side: a root `encode` with `x` / `y` (`vega/radar-chart`), an empty group mark's container
(`vega/budget-forecasts`), `label` / `wordcloud` (their oracle needs a canvas: `vega/labeled-scatter-plot`, `vega/word-cloud`), the
`crossfilter` transform, facet cell layout, the timer-driven `vega/donut-chart-labelled` on the React path, and the React-path-only
differences (a `data-datum` attribute on every item of a chart with event streams, among them `vega/force-directed-layout`).

## Update: runtime fixes (branch fix/gallery-runtime-3)

Gate after: static Vega 82 / 93, Vega-Lite 601 / 627; react Vega 78, Vega-Lite 599 (swap 223 / 223). Closed, with the cause the
earlier triage had wrong or not found:

* `vl/point_constant_legend_domain`: a `react: false` signal sits in a cycle through a scale (`domain('color')` -> the scale whose domain
  is the signal). vega-dataflow does not make it a target of the signal it reads, so when that signal is re-ranked past the scale
  it runs first and reads its initial value: the ordinal domain is undefined and stays implicit (the marks fill it in, the legend
  lists it). Fixed in `frozenReadsOf` (runtime).
* `vl/geo_choropleth`, `vl/geo_repeat`, `vl/geo_trellis`, `vl/interactive_geo_facet_species`: not "first-pass items vega keeps". The
  topology has 467 counties whose geometry is an empty MultiPolygon; vega draws their `<path>` without a `d`, the string and DOM
  renderers skipped an item with no path.
* `vl/scatter_image`: not "by design": vega's loader resolves a relative image url against its `baseURL`; the engine's counterpart
  is the url policy's `baseURL` (now applied to images; the gallery harness hands it to the engine as it hands the base to vega's loader).
* `vega/flight-passengers`: vega-encode's DataJoin keys axis items by `value`; the second pass of a `fit` view updates the items of the
  ticks it shares with the first in place and appends the new ones (Sep and May of a padded time scale after Apr). Ported for the ticks,
  labels and grid of axes (`retainGuideOrder`). Legends are not covered (no case found where it shows).
* `vega/histogram-null-values`: the same two passes: the Scale operator keeps its scale, and `includeZero` reads the `bins` the first
  pass left, so the second pass of a scale whose parameters changed leaves the zero out of its domain (`scales.ts` `pass`).
* `vega/labeled-scatter-plot` (react path): the `label` transform is now vega-label's (`label.ts`, `label-draw.ts`, `raster.ts`); all
  2260 labels are where vega's are in Chromium. Static path: vega in Node has no canvas, its `label` fails and leaves the labels at
  `undefined`, so there is nothing to compare with (the placement is tested against vega-label itself in `label-vs-vega.test.ts`).
* `scale('projection', ...)`: vega keeps projections among the scales. `vl/interactive_airport_crossfilter` and `vl/interactive_1d_geo_brush`
  are equal to the oracle at runtime on vega-lite's own Vega; what keeps them failing is the compiler (`source_1` is the name of
  two datasets of one concat: `ctx.nextSource` in `compile.ts` hands out `source_<n>` apart from the counter the other sources use;
  a selection on `latitude` / `longitude` encodings is rejected).
* Polar arcs (`arc_radial`, `arc_radial_histogram`, `arc_ordinal_theta`): equal at runtime on vega-lite's own Vega (and the family of
  `polar-vl-runtime-vs-vega.test.ts`); the Vega `@aster/vl` emits is what differs.
* `vl/geo_line`, `vl/geo_rule`, `vl/interactive_geo_earthquakes` already passed at the start of this branch.

## Update: runtime fixes (branch fix/gallery-runtime-2)

Gate after: static Vega 80 / 93, Vega-Lite 476 / 627; react Vega 76 (77 when `vega/zoomable-circle-packing` is not over its 10 s load
limit on a busy machine), Vega-Lite 474. Closed: a throw's rank (and `datasetsOfScene` to see it), a throwing top-level signal, the
view's `encode`, an empty group mark's container, `crossfilter` / `resolvefilter`, the `padding` and `background` view signals, a
timeunit's signal, group facets over `from.data`, facet `cross` cells, nested field references, scale-reading transforms, the legend
layout config, autosize `fit` measured once, symbol / arc bounds, scale `bins` ticks, time multi-format, canvas gradient boxes and path
arcs. Still open on the runtime side, with the reason:

* `vega/flight-passengers`: vega's DataJoin keeps the axis items of the first pass and appends the ones the second pass adds (a `fit`
  chart whose ticks change with the width): same records, different order.
* `vega/histogram-null-values`: the scale's `bins` survive into vega's second pass (a url dataset needs two), which then leaves out
  the zero of the domain; one pass here includes it.
* `vega/labeled-scatter-plot` (label) and `vega/word-cloud` (wordcloud): both need vega's canvas bitmaps; the word cloud is also random
  by design (`Math.random` in vega-wordcloud), so it can never be verified. The `label` port has no bitmap collision (not done).
* `vega/platformer`: a timer-driven game whose signals depend on each other through `frame`.
* `vega/projections`: the oracle itself fails (the extended d3-geo-projection names are not registered in vega); Aster draws them.
* `vl/scatter_image`: by design (vega resolves the href against the loader baseURL).
* `vl/geo_choropleth`, `vl/geo_repeat`: vega keeps items of its first pass (never encoded, no `d`) that the filtered dataset no longer has.
* the three `error` specs that are `lookup` of a selection store (`vl/interactive_airport_crossfilter`, `vl/point_scale_range_field`,
  `vl/trellis_selections`), and the rest of `vl/` that fail, are in the compiler (`@aster/vl`): the Vega they emit differs.

## Numbers

| path | grammar | pass | fail | error | unverifiable | total |
|---|---|---|---|---|---|---|
| static | Vega | 37 | 31 | 18 | 7 | 93 |
| static | Vega-Lite | 251 | 236 | 130 | 10 | 627 |
| react | Vega | 37 | 26 | 19 | 11 | 93 |
| react | Vega-Lite | 251 | 234 | 130 | 12 | 627 |

The react rows are after the React-path fixes (below); at the commit that introduced the gate they were 30 / 36 / 20 / 7 and 186 / 301 / 130 / 10.

Static -> react status of the 720 specs, now: 284 pass/pass, 260 fail/fail, 147 error/error, 15 unverifiable/unverifiable, **0 pass static / fail
react** (there were 75), 4 pass static / unverifiable react (time-dependent oracles, see "React-path-only differences"), 4 fail static / pass
react, and 6 single moves.

How to read the categories. A *category* is a tested claim where it says "verified", otherwise a located one:

* `error`: the message.
* *compiler* vs *runtime* (Vega-Lite only): Aster's runtime is run on the Vega **vega-lite itself compiled**. If that already differs,
  the defect is in the runtime ("runtime"); if it matches the oracle and only the Vega `@aster/vl` emitted differs, it is the compiler
  ("compiler"). For a compiler spec one group of vega-lite's output at a time (size/layout signals; scales+axes+legends;
  data+marks; title/config) is grafted into `@aster/vl`'s output: the group whose graft makes the render equal is where the defect is
  ("not isolated" = no single group or pair does; the difference is spread).
* runtime categories marked **verified** were confirmed by applying the claimed fix to the spec and seeing the render become equal
  (primitive `values` wrapped; `time(` rewritten to `toNumber(`), or by a record-level normalisation that makes the two sides equal.
  Those marked *located* come from deleting one component (a mark, the axes, the title) from the Vega for both engines until the
  render becomes equal; they say where the difference lives, not what it is.
* A spec has one category here; one defect can hide a second one behind it.

## Categories (static path, every spec that did not pass or was unverifiable is accounted for)

| count | category | representative | its first diff |
|---|---|---|---|
| 125 | error: @aster/vl rejects a valid Vega-Lite feature | `vl/arc_params` | `[aster/vl] hconcat[0].mark.radius2: mark-def radius2 is not supported` |
| 83 | compiler: scales+guides (scales, axes, legends) + data+marks | `vl/arc_facet` | `only-oracle: path/M5.096,200.621A150,150,0,0,0,70.948,330.239L155,206Z/fill=#54a24b//` |
| 47 | compiler: size/layout (signals, width, height, autosize, padding, layout) | `vl/animated_hop` | `only-oracle: path/M43.5,10.5L63.5,10.5L63.5,310.5L43.5,310.5Z/fill=none;stroke=#dddddd;stroke-width=1//` |
| 22 | compiler: scales+guides (scales, axes, legends) | `vl/bar_default_tooltip_title_null` | `- oracle:             path.foreground hidden=true // + aster:                g .mark-text.role-axis-title` |
| 18 | compiler: not isolated by grafting | `vl/bar_1d_temporal` | `only-oracle: path/M17.5,5.5L317.5,5.5L317.5,25.5L17.5,25.5Z/fill=none;stroke=#dddddd;stroke-width=1//` |
| 16 | runtime: other (not isolated) | `vega/parallel-coordinates` | `only-oracle: path/M86,10L202,181.556L318,209.6L434,230L550,321.111L666,294.444L782,410/fill=none;stroke=#4682b` |
| 13 | error: runtime lacks a Vega transform / expression function / transform backend | `vega/airport-connections` | `[aster] unsupported transform type "geopath"` |
| 10 | error: runtime rejects a spec value that vega takes from a signal / another dataset | `vega/annual-precipitation` | `Projection type must be a name string.` |
| 9 | compiler: data+marks | `vl/area_overlay` | `- oracle:         g .mark-line.role-mark.layer_1_marks role=graphics-object rd=line mark container // + aster:` |
| 9 | runtime: expression `time(x)` returns a Date, not a timestamp | `vl/circle_github_punchcard` | `- oracle:         g .mark-group.role-axis role=graphics-symbol rd=axis label="Y-axis titled 'time (day)' for a` |
| 8 | runtime: inline primitive `values` are not wrapped as {data: v} | `vega/dot-plot` | `only-oracle: line/159.5,74.75/159.5,79.75/stroke=#888888;stroke-width=1//` |
| 6 | runtime: facet / cell group layout or order | `vega/brushing-scatter-plots` | `only-oracle: line/106.5,551.5/106.5,556.5/stroke=#cccccc;stroke-width=1//` |
| 5 | runtime: a mark reading `from: {data: <mark name>}` (a group mark's items) draws nothing | `vega/arc-diagram` | `- oracle:         g .mark-path.role-mark role=graphics-symbol rd=path mark container // + aster:          g .m` |
| 5 | runtime: path: a line/area with breaks closes each piece with Z (vega: M..L..M..L) | `vl/layer_null_data` | `only-oracle: path/M43,157.273L85.857,10M171.571,10L214.429,75.455M300.143,10L343,75.455/fill=none;stroke=#4c78` |
| 4 | runtime: geo (shape marks / projection fit), root size off by 1-2 px | `vega/earthquakes` | `only-oracle: path/M139.801,429.599M139.801,438.527A8.928,8.928,0,1,1,139.801,420.671A8.928,8.928,0,1,1,139.801` |
| 4 | runtime: numbers: coordinates differ in the 3rd decimal (rounding / summation order) | `vl/interactive_legend` | `only-oracle: path/M6,125.706L8.524,125.406L10.886,125.331L13.41,122.475L15.853,123.044L18.378,125.619L20.821,1` |
| 3 | runtime: a text mark positioned from an undefined signal changes the autosize bounds | `vega/bar-chart` | `only-oracle: line/113.5,216.5/113.5,221.5/stroke=#888888;stroke-width=1//` |
| 3 | runtime: guide (removing axes) | `vega/histogram-null-values` | `- oracle:         g .mark-group.role-axis role=graphics-symbol rd=axis label="X-axis for a linear scale with v` |
| 3 | runtime: other (mark[0] group) | `vega/job-voyager` | `only-oracle: path/M21,10L74,10L128,10L181,10L288,10L341,10L394,11L448,12L501,10L554,13L608,12L661,13L714,13L76` |
| 3 | compiler: size/layout (signals, width, height, autosize, padding, layout) + data+marks | `vl/bar_1d_dimension_only` | `only-oracle: path/M43.5,10.5L63.5,10.5L63.5,310.5L43.5,310.5Z/fill=none;stroke=#dddddd;stroke-width=1//` |
| 3 | runtime: serialisation: text content escapes `"` as &quot; (vega leaves it raw) | `vl/bar_axis_title_quoted` | `only-oracle: text/141.5,355.5/"Quoted" Title/fill=#000000;font-family=sans-serif;font-size=11;font-weight=700;` |
| 3 | compiler: size/layout (signals, width, height, autosize, padding, layout) + scales+guides (scales, axes, legends) | `vl/circle_scale_quantile` | `- oracle:         g .mark-group.role-legend role=graphics-symbol rd=legend label="Symbol legend titled 'Quanti` |
| 2 | runtime: guide (removing axes; removing title) | `vega/top-k-plot-with-others` | `only-oracle: line/202.5,398.5/202.5,403.5/stroke=#888888;stroke-width=1//` |
| 2 | compiler: scales+guides (scales, axes, legends) + title/config/projections | `vl/dynamic_color_legend` | `- oracle:         g .mark-group.role-legend role=graphics-symbol rd=legend label="Symbol legend titled 'Weathe` |
| 1 | runtime: guide (removing title) | `vega/flight-passengers` | `- oracle:         g .mark-group.role-axis role=graphics-symbol rd=axis label="X-axis for a time scale with val` |
| 1 | runtime: other (mark[0] group "everything") | `vega/platformer` | `only-oracle: path/M15.625,46.875L28.125,46.875L28.125,59.375L15.625,59.375Z/fill=#00ffff;fill-opacity=0//{clip` |
| 1 | runtime: other (mark[1] group) | `vega/regression` | `- oracle:         g .mark-group.role-scope role=graphics-object rd=group mark container // + aster:        pat` |
| 1 | runtime: other (mark[2] group) | `vega/u-district-cuisine` | `only-oracle: line/112.5,91/112.5,457/stroke=#dddddd;stroke-width=1;stroke-dasharray=3,2//` |
| 1 | compiler: title/config/projections | `vl/area_density_facet` | `only-oracle: text/5,15.5/Distribution of Body Mass of Penguins/fill=#000000;font-family=sans-serif;font-size=1` |
| 1 | runtime: gradient fill object stringified on a path (area/line) | `vl/area_gradient` | `- oracle:         g .mark-area.role-mark.layer_0_marks role=graphics-object rd=area mark container // + aster:` |
| 1 | runtime: image: href is not resolved against the loader baseURL (harness gives vega a baseURL) | `vl/scatter_image` | `only-oracle: image/83.692,236.308/50/50/href=https://gallery.invalid/data/ffox.png/fill=none/@preserveAspectRa` |
| 1 | runtime: other (mark[0] group "concat_0_group") | `vl/test_invalid_break_paths_filter_domains` | `- oracle:                     g .mark-group.role-axis role=graphics-symbol rd=axis label="X-axis titled 'a' fo` |
| 1 | runtime: arc: large-arc flag of an elliptical arc differs | `vl/trail_color` | `only-oracle: path/M51.269,294.552L53.771,295.856A0.577,0.577,0,1,1,53.24,296.881L50.731,295.59A0.584,0.584,0,1` |
| 17 | unverifiable (oracle not comparable) | see below | |

### Members of the small categories

* **runtime: other (not isolated)** (16): `vega/parallel-coordinates`, `vega/probability-density`, `vega/reorderable-matrix`, `vega/time-units`, `vega/wind-vectors`, `vega/zoomable-circle-packing`, `vl/arc_radial`, `vl/bar_custom_time_domain`, `vl/isotype_grid`, `vl/line_override_dynamic_format`, `vl/line_timestamp_domain`, `vl/nested_concat_align`, `vl/rect_binned_heatmap`, `vl/test_invalid_break_paths_show_domains`, `vl/test_invalid_break_paths_show_path_domains`, `vl/test_invalid_default`
* **error: runtime lacks a Vega transform / expression function / transform backend** (13): `vega/airport-connections`, `vega/beeswarm-plot`, `vega/crossfilter-flights`, `vega/dorling-cartogram`, `vega/edge-bundling`, `vega/force-directed-layout`, `vega/map-with-tooltip`, `vega/packed-bubble-chart`, `vega/quantile-dot-plot`, `vega/radial-tree-layout`, `vega/tree-layout`, `vega/volcano-contours`, `vl/point_quantile_quantile`
* **error: runtime rejects a spec value that vega takes from a signal / another dataset** (10): `vega/annual-precipitation`, `vega/distortion-comparison`, `vega/donut-chart-labelled`, `vega/overview-plus-detail`, `vega/quantile-quantile-plot`, `vega/world-map`, `vl/geo_params_projections`, `vl/interactive_airport_crossfilter`, `vl/point_scale_range_field`, `vl/trellis_selections`
* **compiler: data+marks** (9): `vl/area_overlay`, `vl/histogram_log`, `vl/interactive_overview_detail`, `vl/isotype_bar_chart_emoji`, `vl/layer_arc_label`, `vl/layer_bar_labels_style`, `vl/line_shape_overlay`, `vl/tick_width_band`, `vl/waterfall_chart`
* **runtime: expression `time(x)` returns a Date, not a timestamp** (9): `vl/circle_github_punchcard`, `vl/circle_labelangle_orient_signal`, `vl/line_conditional_axis`, `vl/line_conditional_axis_config`, `vl/line_default_format`, `vl/line_narrow_yearmonth_span`, `vl/line_narrow_yearquarter_span`, `vl/line_override_static_format`, `vl/rect_lasagna`
* **runtime: inline primitive `values` are not wrapped as {data: v}** (8): `vega/dot-plot`, `vega/horizon-graph`, `vega/radial-plot`, `vl/bar_tooltip_aggregate`, `vl/bar_tooltip_groupby`, `vl/circle_wilkinson_dotplot`, `vl/circle_wilkinson_dotplot_stacked`, `vl/layer_line_window`
* **runtime: facet / cell group layout or order** (6): `vega/brushing-scatter-plots`, `vl/isotype_bar_chart`, `vl/trellis_area_sort_array`, `vl/trellis_barley`, `vl/trellis_barley_layer_median`, `vl/trellis_row_column`
* **runtime: a mark reading `from: {data: <mark name>}` (a group mark's items) draws nothing** (5): `vega/arc-diagram`, `vega/barley-trellis-plot`, `vega/grouped-bar-chart`, `vega/labeled-scatter-plot`, `vega/radar-chart`
* **runtime: path: a line/area with breaks closes each piece with Z (vega: M..L..M..L)** (5): `vl/layer_null_data`, `vl/line_skip_invalid`, `vl/line_skip_invalid_mid`, `vl/line_skip_invalid_mid_cap_square`, `vl/line_skip_invalid_mid_overlay`
* **runtime: geo (shape marks / projection fit), root size off by 1-2 px** (4): `vega/earthquakes`, `vl/geo_graticule`, `vl/geo_graticule_object`, `vl/geo_text`
* **runtime: numbers: coordinates differ in the 3rd decimal (rounding / summation order)** (4): `vl/interactive_legend`, `vl/interactive_legend_dblclick`, `vl/stacked_area`, `vl/stacked_area_stream`
* **runtime: a text mark positioned from an undefined signal changes the autosize bounds** (3): `vega/bar-chart`, `vega/budget-forecasts`, `vega/word-cloud`
* **runtime: guide (removing axes)** (3): `vega/histogram-null-values`, `vega/zoomable-binned-plot`, `vega/zoomable-scatter-plot`
* **runtime: other (mark[0] group)** (3): `vega/job-voyager`, `vega/nested-bar-chart`, `vega/projections`
* **compiler: size/layout (signals, width, height, autosize, padding, layout) + data+marks** (3): `vl/bar_1d_dimension_only`, `vl/bar_grouped_label`, `vl/tick_grouped`
* **runtime: serialisation: text content escapes `"` as &quot; (vega leaves it raw)** (3): `vl/bar_axis_title_quoted`, `vl/bar_grouped_thin`, `vl/bar_grouped_thin_minBandSize`
* **compiler: size/layout (signals, width, height, autosize, padding, layout) + scales+guides (scales, axes, legends)** (3): `vl/circle_scale_quantile`, `vl/circle_scale_quantize`, `vl/circle_scale_threshold`
* **runtime: guide (removing axes; removing title)** (2): `vega/top-k-plot-with-others`, `vega/top-k-plot`
* **compiler: scales+guides (scales, axes, legends) + title/config/projections** (2): `vl/dynamic_color_legend`, `vl/interactive_seattle_weather`
* **runtime: guide (removing title)** (1): `vega/flight-passengers`
* **runtime: other (mark[0] group "everything")** (1): `vega/platformer`
* **runtime: other (mark[1] group)** (1): `vega/regression`
* **runtime: other (mark[2] group)** (1): `vega/u-district-cuisine`
* **compiler: title/config/projections** (1): `vl/area_density_facet`
* **runtime: gradient fill object stringified on a path (area/line)** (1): `vl/area_gradient`
* **runtime: image: href is not resolved against the loader baseURL (harness gives vega a baseURL)** (1): `vl/scatter_image`
* **runtime: other (mark[0] group "concat_0_group")** (1): `vl/test_invalid_break_paths_filter_domains`
* **runtime: arc: large-arc flag of an elliptical arc differs** (1): `vl/trail_color`

### Members of the large categories

See `triage.json` (`category`, `culprit`, `first` per spec).

## The three specs from the demo

| spec | static | react | category / evidence |
|---|---|---|---|
| `vega/donut-chart-labelled` | error: `Missing required "sequence" parameter: "start"` | fail: no donut at all (root 264 x 264 vs 441 x 301) | runtime rejects a value vega takes from a signal (`sequence.start = {signal: "rightExt[0]"}` from an `extent` in another dataset). On the React path `<Chart>` mounts without the chart instead of reporting it. |
| `vega/barley-trellis-plot` | fail: 6 oracle-only `text` records (`Crookston`, ...) | same | a mark reading `from: {data: "site"}`, the name of a group mark, draws nothing. Ablation: removing mark[1] (the text mark) makes the renders equal. |
| `vega/radial-plot` | fail (every arc differs) | same | **verified**: wrapping the primitive `values: [12, 23, ...]` as `{data: v}` makes the render identical (0 diffs), so inline primitive `values` are not wrapped; the arcs are `d="MNaN,NaN..."`. Same cause: `vl/arc_radial`, `vl/bar_tooltip_aggregate`, `vl/bar_tooltip_groupby`, `vega/dot-plot`, `vega/horizon-graph`, ... (the 8 in the table). |

## Verified or located causes behind the larger categories

Runtime (Aster's runtime differs on vega's own Vega):

* **`time(x)` returns a Date.** `time(datetime(2006,0,1))` is `1136073600000` in vega and a `Date` in Aster, so
  `time(datetime(year(d),0,1)) === time(datetime(2006,0,1))` (the Vega-Lite `filter: {timeUnit, equal}`) is never true and the
  chart loses its rows. Verified by rewriting `time(` to `toNumber(`: the renders become equal for the 9 specs.
* **Broken line/area segments are closed.** `M43,235L93,85ZM193,197.5...` (Aster) vs `M43,235L93,85M193,197.5...` (vega) for a
  line with invalid points (`line_skip_invalid*`, `layer_null_data`; also in `test_invalid_*`, which have further layout diffs).
* **Stacked-area coordinates differ in the 3rd decimal** (`111.712` vs `111.713`; `stacked_area*`, `interactive_legend*`).
* **Trail marks**: the large-arc flag of the cap arcs differs (`trail_color`).
* **Gradient fill on an `area` path is stringified** (`fill=[object Object]`; `area_gradient`).
* **Empty-string stroke**: vega paints `stroke=""` as a stroke attribute, Aster drops it, which moves the group background by half a
  pixel (`isotype_grid`, `isotype_bar_chart`).
* **A text mark positioned by `scale(undefined signal)`** (`x: {scale, signal: "tooltip.category"}` with `tooltip = {}`) takes part in
  vega's autosize bounds (6 px); Aster ignores it. Verified by ablation on `vega/bar-chart` (removing the text mark: 0 diffs).
* **Geo**: `geoshape` / `shape` marks make the view 1-2 px smaller than vega's (projection fit extent); `vl/geo_*`, `vega/earthquakes`.
* **Text content escaping**: Aster writes `&quot;` for `"` inside `<text>`, vega writes the raw quote (valid XML both ways; only
  the string differs): `bar_axis_title_quoted`, `bar_grouped_thin*`.
* **Image `href`** is left relative by Aster; vega resolves it against the loader `baseURL` (the harness gives vega one so that data
  resolves). Probably by design; listed so that it is not mistaken for a layout bug.
* Facet cells / row order (`trellis_barley*`, `trellis_row_column`, `trellis_area_sort_array`, `vega/brushing-scatter-plots`):
  the cell group is where the render diverges (rows come out at different positions).
* Located only: signal-valued axis `offset` is a candidate for `zoomable-scatter-plot` / `zoomable-binned-plot` (the axis ticks are
  where the diff is); `histogram-null-values`, `top-k-plot*`, `flight-passengers` (axis / title located, cause not isolated).

Compiler (`@aster/vl` emits a Vega whose render differs while Aster's runtime renders vega-lite's Vega correctly): 188 specs,
spread as in the table. Features of the source that the failing specs share (a spec can have several; "of 188"): `timeUnit` 39,
`layer` 43, `config` 35, `bin` 34, `concat` 23, `selection params` 22, `tooltip` 21, `legend` 20, `xOffset/yOffset` 19, `facet/row/column` 18,
`overlay line/point` 17, `title: null` 15, `test_invalid_*` 13, `repeat` 10, `errorbar/errorband` 8, `bandPosition` 6, `stack` 5.
Representatives that were read through to the cause:

* `xOffset`/`yOffset` (`bar_grouped`, ...): vega-lite makes the step `x_step = 20 * bandspace(domain('xOffset').length, 0, 0) / (1-0.2)`;
  `@aster/vl` emits `x_step = 20`, so the view is half as wide (359 vs 183 px).
* One positional channel only (`bar_1d`, `point_1d`, ...): vega-lite makes the 1D view `height: 20`; `@aster/vl` leaves 300.
* `timeUnit` with `bandPosition` / a time-unit scale (`bar_month_temporal_band_center`, `rect_heatmap_weather_temporal_center_band`, ...): the
  scale domain is a single date ("December to December", "31 to 31") instead of the range.
* `area` with `line: true` / `point: true` (`area_overlay`): the overlay layers differ (`.mark-line` expected, `.mark-symbol` emitted).
* `title: null` on an axis (`bar_default_tooltip_title_null`): the axis title is still drawn.
* Ranged encodings (`boxplot_preaggregated`): vega-lite drops the axis title, `@aster/vl` draws one.
* Legend titles merged across size and colour on the same field (`circle_scale_quantile`: `Quantile, b` vs `Quantile`).
* Binned ordinal (`histogram_ordinal`): the bins are not produced (2 values instead of 10).
* `title: {text, anchor: "start"}` on a layered facet (`area_density_facet`): the anchor is lost.
* `aggregate: distinct` (`bar_distinct`): the y domain is `0 .. 1`.

## Errors (148 on the static path)

Aster or `@aster/vl` threw. 125 are `@aster/vl` refusing a valid Vega-Lite feature with an explicit message (it never renders
something wrong silently; the messages are the work list); 23 come from the runtime.

| count | message (normalised) | where | example |
|---|---|---|---|
| 10 | a condition needs exactly one of `value`, `field`, `datum` | @aster/vl | `vl/selection_composition_and` |
| 9 | timeUnit "...": binned time units are not supported | @aster/vl | `vl/bar_binned_yearmonth_grouped` |
| 9 | a channel definition needs `field`, `value`, `datum` or `aggregate: "..."` | @aster/vl | `vl/bar_bullet_expr_bind` |
| 8 | the view background property is not supported; set it through config.view | @aster/vl | `vl/concat_population_pyramid` |
| 8 | a facet field definition needs `type` | @aster/vl | `vl/facet_column_facet_column_point_future` |
| 7 | [aster] unsupported transform type "..." | runtime | `vega/airport-connections` |
| 7 | boxplot only supports the x and y channels | @aster/vl | `vl/boxplot_2D_horizontal_color_size` |
| 5 | this config property is valid Vega-Lite but is not supported by @aster/vl (it would be silently ignored) | @aster/vl | `vl/boxplot_minmax_2D_horizontal_custom_midtick_color` |
| 5 | channel-level `impute` is not supported | @aster/vl | `vl/line_encoding_impute_keyvals` |
| 4 | Projection type must be a name string. | runtime | `vega/annual-precipitation` |
| 4 | boxplot requires plain x and y fields (no aggregate, bin or timeUnit) | @aster/vl | `vl/boxplot_1D_horizontal` |
| 4 | boxplot supports only field, type and title on x/y | @aster/vl | `vl/boxplot_1D_invalid` |
| 3 | a constant datum position is not supported on the "..." mark | @aster/vl | `vl/area_overlay_with_y2` |
| 3 | encoding.size is not supported on the "..." mark | @aster/vl | `vl/bar_aggregate_size` |
| 3 | pre-binned data (binned: true) is not supported; let @aster/vl bin the field or use a bin transform | @aster/vl | `vl/bar_binned_data` |
| 3 | `resolve` has no meaning on a single unit spec | @aster/vl | `vl/bar_grouped_facet_independent_scale` |
| 3 | duplicate parameter name "..." | @aster/vl | `vl/concat_hover` |
| 3 | positional mark-def constants (x/xN/y/yN) are not supported; use encoding | @aster/vl | `vl/interactive_global_development` |
| 3 | a data-driven strokeDash (scale + legend) is not supported; use a constant {"...": ...} or a condition | @aster/vl | `vl/line_dashed_part` |
| 2 | Disabled. | runtime | `vega/beeswarm-plot` |
| 2 | Unrecognized function: geoCentroid | runtime | `vega/dorling-cartogram` |
| 2 | a data-driven angle (scale + legend) is not supported; use a constant {"...": ...} or a condition | @aster/vl | `vl/arc_radial_histogram` |
| 2 | `scale: null` (identity/disabled scale) is not supported | @aster/vl | `vl/bar_color_disabled_scale` |
| 2 | width must be a non-negative number or {"...": n}, got {"...":N,"...":"..."} | @aster/vl | `vl/bar_grouped_custom_padding` |
| 2 | layers specify conflicting values for scale "..." property "..." | @aster/vl | `vl/concat_bar_scales_discretize` |
| 2 | maps (geoshape marks, projections, longitude / latitude) inside a facet are not supported: vega-lite N.N.N fit | @aster/vl | `vl/geo_trellis` |
| 2 | Undefined data set name: "..." | runtime | `vl/interactive_airport_crossfilter` |
| 2 | must be a [min, max] pair of numbers (parameter references are not supported) | @aster/vl | `vl/interactive_bin_extent` |
| 2 | layers give scale "..." incompatible types ("..." and "..."); vega-lite would make them independent scales, wh | @aster/vl | `vl/interactive_line_hover` |
| 2 | a variable parameter needs `value` or `expr` | @aster/vl | `vl/interactive_paintbrush_simple_false` |
| 2 | temporal/DateTime datums are not supported | @aster/vl | `vl/layer_line_datum_rule_datetime` |
| 2 | data generators: `sequence` is not supported (`sphere` and `graticule` are) | @aster/vl | `vl/sequence_line` |
| 1 | [aster] Missing required "..." parameter: "..." | runtime | `vega/donut-chart-labelled` |
| 1 | Unrecognized signal name: detailDomain | runtime | `vega/overview-plus-detail` |
| 1 | Unrecognized function: quantileLogNormal | runtime | `vega/quantile-dot-plot` |
| 1 | [aster] dataset "...": url must be a string (a signal-valued url cannot be resolved ahead of time) | runtime | `vega/quantile-quantile-plot` |
| 1 | mark-def radiusN is not supported | @aster/vl | `vl/arc_params` |
| 1 | op "..." is not supported in transforms (use {"...":"..."} with a join) | @aster/vl | `vl/bar_argmax_transform` |
| 1 | encoding.xOffset.datum is not supported (datum works on x, y, xN, yN, longitude, latitude and color) | @aster/vl | `vl/bar_grouped_repeated` |
| 1 | spacing is only meaningful on composition specs | @aster/vl | `vl/facet_grid_bar` |
| 1 | unknown channel "..." | @aster/vl | `vl/interactive_1d_geo_brush` |
| 1 | domainRaw is not supported | @aster/vl | `vl/interactive_point_domainRaw_binding` |
| 1 | mark type not supported yet: boxplot | @aster/vl | `vl/layer_boxplot_circle` |
| 1 | pre-binned data (bin: "...") is not supported; let @aster/vl bin the field (bin: true) or use a bin transform | @aster/vl | `vl/layer_cumulative_histogram` |
| 1 | layers give scale "..." different explicit or signal-based domains, which cannot be merged | @aster/vl | `vl/layer_histogram_global_mean` |
| 1 | regression `params: true` is not supported | @aster/vl | `vl/layer_point_line_regression` |
| 1 | encoding.stroke.datum is not supported (datum works on x, y, xN, yN, longitude, latitude and color) | @aster/vl | `vl/line_color_halo` |
| 1 | a constant value position is not supported on the "..." mark | @aster/vl | `vl/parallel_coordinate` |
| 1 | unknown bind property "..." | @aster/vl | `vl/param_search_input` |
| 1 | a domain object must be {"...": ...}, {"...": [...]} or a signal; give an array or "..." | @aster/vl | `vl/point_constant_legend_domain` |
| 1 | Unrecognized function: quantileUniform | runtime | `vl/point_quantile_quantile` |
| 1 | Undefined data set name: undefined | runtime | `vl/point_scale_range_field` |
| 1 | must be a non-empty array of {op, field?, as?} | @aster/vl | `vl/vconcat_flatten` |

## Unverifiable (the oracle cannot be compared)

Static path:

* `vega/bar-line-toggle` (static): oracle-nondeterministic (random)
* `vega/contour-plot` (static): oracle-error
* `vega/density-heatmaps` (static): oracle-error
* `vega/earthquakes-globe` (static): oracle-nondeterministic (random)
* `vega/error-bars` (static): oracle-nondeterministic (unknown)
* `vega/hypothetical-outcome-plots` (static): oracle-nondeterministic (random)
* `vega/pi-monte-carlo` (static): oracle-nondeterministic (random)
* `vl/errorband_2d_horizontal_color_encoding` (static): oracle-nondeterministic (unknown)
* `vl/errorband_2d_vertical_borders` (static): oracle-nondeterministic (unknown)
* `vl/errorbar_2d_vertical_ticks` (static): oracle-nondeterministic (unknown)
* `vl/layer_line_errorband_2d_horizontal_borders_strokedash` (static): oracle-nondeterministic (unknown)
* `vl/layer_line_errorband_ci` (static): oracle-nondeterministic (unknown)
* `vl/layer_point_errorbar_2d_horizontal_ci` (static): oracle-nondeterministic (unknown)
* `vl/layer_point_errorbar_ci` (static): oracle-nondeterministic (unknown)
* `vl/point_offset_random` (static): oracle-nondeterministic (random)
* `vl/point_ordinal_bin_offset_random` (static): oracle-nondeterministic (random)
* `vl/sample_scatterplot` (static): oracle-nondeterministic (random)

React path: vega/bar-line-toggle, vega/earthquakes-globe, vega/error-bars, vega/hypothetical-outcome-plots, vega/pi-monte-carlo, vega/platformer, vega/word-cloud, vl/errorband_2d_horizontal_color_encoding, vl/errorband_2d_vertical_borders, vl/errorbar_2d_vertical_ticks, vl/layer_line_errorband_2d_horizontal_borders_strokedash, vl/layer_line_errorband_ci, vl/layer_point_errorbar_2d_horizontal_ci, vl/layer_point_errorbar_ci, vl/point_offset_random, vl/point_ordinal_bin_offset_random, vl/sample_scatterplot

`oracle-error` for `contour-plot` / `density-heatmaps` is vega's own heatmap transform needing a canvas on Node (the browser path
renders them with vega and reports Aster's `unsupported transform type "kdeNd"`). The `errorband`/`errorbar` `ci` and `sample` specs
use bootstrap sampling; `random()` specs use `random()`; neither engine is seeded, so there is nothing exact to compare.

## React-path-only differences

At the commit that introduced the gate, 75 specs passed on the static path and failed through `<Chart>` (the oracle is the same vega in
the same Chromium). All 75 are resolved; the React path passes exactly the specs the static path does (288 each).

* **`data-datum` attributes (about 48 specs)**: `interactive_brush`, `interactive_paintbrush*`, `selection_*`, `param_expr`,
  `interactive_point_init`, `vega/clock`, `stock-index-chart`, ... Every spec with `signal.on` event streams (and every chart with a
  tooltip) had a JSON copy of each datum written onto its mark elements as `data-datum`, so the mounted DOM differed from vega's by an
  attribute on every mark. The canonical diff printed one paint record per mark, which looked like "the un-selected marks are not dimmed";
  the paint was equal (the selection store was seeded and resolved correctly: the first record that differed was a grey symbol only
  because its attribute list differed). The mark under the pointer is now found through the scene hit index on every renderer, and the
  stamp is gone from `<Chart>` / `<SvgChart>`.
* **stepped / faceted sizing (about 20 specs)**: `facet_custom*`, `repeat_*`, `trellis_*`, `bar_column_fold`, `bar_count_minimap`,
  `selection_filter*`, `selection_resolution_*`, `point_invalid_size_show`, ... A composition (top-level `layout`, no width/height: what
  vega-lite makes of a facet / concat / repeat) is sized by its layout in vega. `<Chart>` measures its container and made that the view
  size, so the root became 600 x 400 with the content inside (an extra empty frame path, 476 px against 411). The measured container
  no longer sizes a dimension that the layout owns (`CompiledChart.contentSized`); the host's size props and a value written to the
  signal still win.
* **timer-driven specs (`vega/clock`, `pacman`, `watch`, `donut-chart-labelled`, `vl/animated_gapminder`, `animated_hop`)**: `<Chart>`
  mounts the view live, so its timers keep ticking. The oracle's own document changes with time (measured: the same view left running
  for 1.3 s), so there is no frame to compare against; they are `unverifiable` (`oracle-time-dependent`) on the React path instead of
  hanging the settle loop (`watch` redraws every 10 ms) or passing and failing with the second they were rendered in (`clock`). They are
  still compared on the static path, which takes the first frame.

4 specs fail statically and pass through `<Chart>` (`vega/flight-passengers`, `top-k-plot`, `top-k-plot-with-others`,
`vl/bar_axis_title_quoted`): not investigated. The first three pass when `<Chart>` is handed the spec's numeric `width` / `height` and the oracle runs in a host
(the static path has neither); `bar_axis_title_quoted` passes in the browser (the two serialisations of the quote agree there; not investigated).

## Known compiler gaps outside the gallery (lane 8, not yet fixed)
These are not exercised by any gallery spec, so the gate cannot see them. They are recorded here so they are not lost.
- **A discrete x with `sort: "descending"` plus `x2`.** The union of the domain needs the raw dataset's sort; the parity case was dropped rather than shipped failing.
- **The `theta2` / `radius2` channels** (ranged polar arcs) are still refused with an explicit message. `vl/arc_params` uses `radius2` as a *mark def*, which is supported.
- **`filled` on a text or trail mark.** The colour paint should flip, as vega-lite does. Found by the paint matrix in `vl-compiler-parity.test.ts`; 12 cases are left out of it.
- **Field names of `geopoint` outputs** in a unit inside a concat or facet stay unprefixed (`x`, `layer_1_x`), where vega-lite writes `concat_0_x`. No render or expression differs.
- **The merged bins-signal name** in one repeat-in-concat case is `layer_1` where vega-lite writes `layer_0`. No render differs.
