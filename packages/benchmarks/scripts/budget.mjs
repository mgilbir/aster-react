/**
 * Bundle-size budgets: one tiny app per documented import pattern is bundled (esbuild, production, minify) and its gzip size is
 * checked against the ceiling in BUDGETS below (the measured size plus 0.5 kB). Needs `pnpm build` and refuses a stale dist.
 *
 * Run: pnpm --filter @aster-charts/benchmarks run budget   (the `budget` gate of `pnpm check`)
 * Environment: ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1 bundles as if no package declared `sideEffects` (the "before" column of docs/PERFORMANCE.md).
 *
 * Exit codes: 0 every pattern is within its budget, 1 a budget is exceeded or a pattern fails to bundle, 2 bad usage (an unknown option).
 */
import { build } from 'esbuild'
import { writeFileSync, readFileSync, statSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url })

// Per-import-pattern bundle gates (reshaped with the `sideEffects` work).
//
// Every row bundles a tiny app that imports ONE documented pattern (esbuild, minify, NODE_ENV=production, tree-shaking
// on, react/react-dom external) and gates its gzip size. What a row means:
//
//   absolute rows  the whole bundle of that app: core `renderSpec`, `useChart`, `<Chart>`, `<Chart>` + the VL compiler.
//   marginal rows  "+ @aster-charts/core/<addon>": the addon's gzip ADDED to the `@aster-charts/core` app. The addons share most of
//                  their code with core, so a standalone figure (the old rows: hit 15.6, load 14.6) double counts it
//                  and hid regressions: what an app pays for `+ hit` is ~5 kB.
//
// Tree-shaking is part of what these rows watch. Without a correct `sideEffects` field in the package manifests the
// `useChart` app drags in Chart, ChartStream, the worker host and the batch helpers (163.9 kB instead of 126.4), so
// that row fails the moment the field is dropped or widened (`ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1` simulates it and
// scripts/bundle-shaking.test.mjs asserts the row fails). The opposite failure, a `sideEffects` list that is too
// narrow, is caught by scripts/check-bundle-shaking.mjs, which executes the bundles.
//
// Every ceiling is the measured value + 0.5 kB (gzip, default level; `pnpm --filter @aster-charts/benchmarks run budget`).
// A change that needs more room edits the number here, in the PR, where the owner sees it. The history of why the
// core row grew (colour, calendar, format, transforms, scales, signals, limits, ...) is in docs/PERFORMANCE.md and the
// git log of this file.
//
// Selections (vega-selections port, modify, the vl* expression functions, dataset edits and {scale} events in the signal
// loop, and the VL selection compiler) raised core to 125.7, signals 5.7, useChart 129.1, Chart 161.4, SvgChart 144.8,
// SvgChart + interaction 155.7 and Chart + VL 227.6 (the VL row carries ~14 kB of the selection compiler).
// Group scopes (scoped signals in the runtime, the loop's per-scope streams and batching, the group pick) and composed-view
// selections in the VL compiler then took core to 126.3, signals 6.8, useChart 129.7, Chart 163.2, SvgChart + interaction 157.5
// and Chart + VL 230.7.
// Earlier measurement, 2026-10-23 (kB gzip): core 123.1; marginal dom 5.7, canvas 4.8, hit 5.0, signals 4.4, load 5.1,
// geo 12.3, transforms 15.1; useChart 126.4; Chart 157.2; Chart + VL 211.3; SvgChart 142.0; SvgChart + interaction 151.5.
// `<Chart>` was 156.5 (+ VL 210.7) before it became a shell over ChartCore with injected capabilities: the +0.7 is the
// capability indirection (property reads the minifier cannot rename) and the report of a missing capability, which
// `<Chart>` never needs but shares with `<SvgChart>` (one implementation is the point; see docs/ARCHITECTURE.md).
// Measured 2026-10-26 (kB gzip), after the Vega-Lite maps and animation work: core 125.3 (+2.2: the d3-timer port, real
// `modify`, the vega-selections functions, the fit-projection registry); marginal signals 5.8 (+1.4: timer streams, owners,
// the data hook); geo 12.5; useChart 128.6; Chart 161.1; SvgChart 144.2; SvgChart + interaction 155.4; Chart + VL 223.5
// (+12.2 over the 211.3 above: the maps and animation compile in @aster-charts/vl and the core runtime they need).
// Measured 2026-10-26 after the Vega-Lite maps and animation work on top of the selections work (kB gzip): signals marginal
// 7.8 (+0.4 over the selections raise: the d3-timer port and timer owners in the event loop); Chart 164.8 (+1.0), SvgChart 145.9
// (+0.6), SvgChart + interaction 159.1 (+1.1): the timer port, the fit-projection registry and unrounded geoshape bounds
// in core; Chart + VL 240.0 (+8.8): the maps (projections, geojson / geopoint data, geoshape marks) and animation (the time
// channel's scale, frame dataset and the timer selection) compile in @aster-charts/vl.
// Runtime parity (guides built from ports of vega-parser's guide encoders, shared immutable plans, per-scope abort model,
// legend part metadata) on top of the above, measured 2026-10-27 (kB gzip): core 133.8 (+8.5 over 125.3; the guide ports),
// useChart 137.7, Chart 172.4, SvgChart 153.0, SvgChart + interaction 166.2, Chart + VL 247.4. Marginal rows unchanged.
// vega's event config (config.events prevent/allow, ported from vega-view) and one resolved view size (measuredSize, a
// live containerSize) then took, measured 2026-10-27 (kB gzip): core 133.9, useChart 137.8, Chart 172.9, SvgChart 153.4,
// SvgChart + interaction 166.7, Chart + VL 247.9.
// The item cursor (vega-view cursor.js: resolveCursor, the pointer tracker, HitIndex.pick with its interactivity and the
// guide parts it finds, the container's cursor state in ChartCore) then took, measured (kB gzip): hit marginal 5.6 (+0.4),
// Chart 174.1 (+1.2), SvgChart 153.9 (+0.5), SvgChart + interaction 167.8 (+1.1), Chart + VL 249.1 (+1.2). Core and the
// other marginal rows stay inside their ceilings.
// The pointer through the svg's screen CTM (core/pointer.ts, one cached map for the cursor, tooltip and gestures), the
// painted-geometry hit index and the inert flags, merged, measured (kB gzip): hit marginal 5.8, Chart 174.8, SvgChart 154.3,
// SvgChart + interaction 168.7, Chart + VL 249.9.
// Add-on auto-load (the shells and hooks read which add-ons a spec needs and import them on demand: @aster-charts/core/addons, the
// Suspense wait in @aster-charts/react), measured (kB gzip, the entry and the chunks it imports statically; the add-ons are chunks
// fetched on demand and are not counted): useChart 139.9 (+2.0), Chart 176.6 (+1.8), SvgChart 157.5 (+3.2), SvgChart +
// interaction 171.7 (+3.0), Chart + VL 252.0 (+2.1). The code itself is +0.7..0.9 (the detector, its tables, the loader and the
// hook; measured with the add-ons kept out of the bundle); the rest is the chunk boundary a bundler draws once the add-ons are
// dynamic imports: the code core shares with them moves to chunks the entry imports by name. The data-datum stamp that left
// ChartCore (the markup is vega's) is already netted out. The core and marginal rows are unchanged.
// The gallery runtime work (docs/CHANGELOG: gallery conformance), measured (kB gzip): core 135.0 (+0.7: date functions as vega
// has them, ingest of primitive rows, d3's line and area generators over the items, gradient defs, source lists and the
// signal-ordered dataset build, the item transforms of a mark, trail through the d3-path buffer); geo marginal 14.3 (+1.5: the
// geo expression functions, the default path, the point radius); transforms marginal 23.2 (+7.6: tree / treelinks, force
// with the d3-quadtree it needs, kde2d, isocontour, geopath, the distribution functions, treePath); useChart 139.2, Chart 176.4,
// SvgChart 155.5, SvgChart + interaction 170.0, Chart + VL 251.6.
// Merged with the add-on auto-load (#38), measured (kB gzip): core 135.3 (+0.3 over the 135.0 above: the add-on function names the
// expression compiler reads to say which add-on to load); useChart 142.1, Chart 178.2, SvgChart 159.7, SvgChart + interaction
// 173.2, Chart + VL 253.5. The two sets of changes add up: the gallery work moves code core shares with the add-ons into the
// chunks the entry imports by name (the same chunk boundary as above), and the detector now parses expressions.
// The @aster-charts/vl compiler ports vega-lite's layout-size, band/bin/time-unit position, path-overlay, stack-order, resolve and
// legend-merge rules (gallery conformance): Chart + VL 257.6 (+7.7: the binned discrete fields and the layered axis merge came last).
// Nothing outside the VL row moved.
// The dataflow-failure containment (a throwing dataset stops the pass like vega's): SvgChart +0.1.
// Merged with the add-on auto-load and the gallery runtime work (#38, #39), measured (kB gzip): Chart + VL 261.5 (253.5 there, plus the
// compiler rules above: +8.0); every other row is within its budget: core 135.5, useChart 142.3, Chart 178.4, SvgChart 159.9, SvgChart +
// Independent facet scales and the rest of the refusals lifted in the gallery work: Chart + VL 266.9.
// interaction 173.4.
// The gallery runtime work (fix/gallery-runtime-2), measured (kB gzip): core 137.9 (+2.4 over 135.5: the dataflow rank and the signal
// abort, the view encode, the config legend layout, bounds traced for every symbol shape and rotated paths, the canvas gradient and
// bezier arcs in the shared path module), canvas marginal 5.9, hit marginal 6.5, transforms marginal 23.7 (crossfilter), useChart 144.5,
// Chart 181.7, SvgChart 162.4, SvgChart + interaction 176.3, Chart + VL 264.7. Ceilings are the measured value + 0.5.
// The runtime work of fix/gallery-runtime-3, measured (kB gzip): core 138.1 (inside its ceiling: the react-false ranks, the passes of a
// fit view, projections as scales and the label wiring, less the plain-tuple label that left transform.ts), transforms marginal 35.4
// (+11.7: the `label` transform, vega-label's layout, plus the coverage-only 2D context it draws the marks to avoid into and the
// drawing of each mark type onto it), useChart 145.2, Chart 182.8, SvgChart 163.4, SvgChart + interaction 177.4, Chart + VL 275.6.
// (The react rows are the entry alone: it grew by under a kB; the add-on chunks that load on demand are reported beside them.)
// Heatmap images, intersect() with the scene walk (in the signals entry), group-scoped projections and the clip shapes, and the
// view-size / fit fixes (fix/gallery-remaining), measured (kB gzip): core 138.8, signals marginal 12.2 (+3.9: the scene
// intersect and the path flattening it shares with the hit index), transforms marginal 36.9 (+1.5: heatmap and its bitmap),
// useChart 145.9, Chart 184.9, SvgChart 164.1, SvgChart + interaction 179.6, Chart + VL 280.8. Ceilings are the measured value + 0.5.
//
// The injected random source (RuntimeInput.random: the replayable tapes, the content fingerprint, the per-source Box-Muller pair),
// vega-functions setdata, and the dataflow order signals resolve in (test/gallery-deterministic), measured (kB gzip): core 140.4,
// useChart 147.5, Chart 186.4, SvgChart 165.6, SvgChart + interaction 181.3, Chart + VL 282.9 (core +1.6 over 138.8); the marginal entries did not move.
//
// The signal event loop as vega-dataflow's run loop (signal-propagation.ts, the graph built in signals.ts) and the wordcloud transform as
// vega-wordcloud / d3-cloud (wordcloud.ts, replacing the stand-in), measured (kB gzip): signals marginal 14.2 (+1.5), transforms
// marginal 39.1 (+1.7), Chart 188.6, SvgChart + interaction 183.5, Chart + VL 284.9; core, useChart and SvgChart did not move enough to
// cross their ceilings (core 140.6).
// The selection and composite-mark compilers rewritten in @aster-charts/vl (a smaller wiring, one part builder): Chart + VL 282.5 (-0.4); the
// ceiling follows it down. Every other row is unchanged.
// The @aster-charts/vl compile gaps (a facet over a repeat or a concat, view names, scale forwarding, orientation of the marks with no measure),
// measured (kB gzip): Chart + VL 283.6 (1.6 over the 282.0 ceiling; the base was not measured separately); every other row is unchanged.
// Lane fix/core-gaps (the id counter of a view, tuple creation order for sort ties, the check of a spec's expressions, transform names):
// Chart + VL 283.5 (+2.0 over 281.5); the other rows stay inside their ceilings.
// Landed together with #71-#74 (guide edges, arc outline, vl repeat/tables, vl compile gaps), measured on the merged tree (kB gzip):
// Chart + VL 288.5 (+7.0 over main's 281.5); core 140.8 (ceiling 140.9 unchanged).
// After #76 (role-gated config, mark-type bounds) and #77 (identifier pass consistency) landed together, measured on main (kB gzip):
// Chart + VL 289.0, at its 289.0 ceiling; the ceiling follows to 289.5. core 141.1 (ceiling 141.5).
// The geo engine as geometry event buffers (geo-events / geo-clip / geo-resample / geo-path / geo-projections ...: more, smaller
// modules, the sinks and the albersUsa interleave in place of d3's shared stream objects), measured (kB gzip): geo marginal 15.4
// (+1.1 over 14.3); core 138.1 and the other rows did not move.
// The same engine with its hot loops kept to what a cold start compiles cheaply (stages as batched methods, a pass-through for rings
// that need no cutting, the point and rectangle fast paths), after one walker for the measuring sinks and one placement base for the
// projections took out what they duplicated, then the batched sinks and the rectangle pass-through (a clip with nothing to cut hands
// its events on): geo marginal 16.3 (16.254; +0.9 over 15.4, none of it one piece: the antimeridian pass-through alone is 0.07).
// The ARIA of guides and marks over the parameter space (the root group item's channels, the mark roles, the config lookup),
// measured (kB gzip): core 141.0 (+0.2 over main's 140.8; ceiling 141.5); the other rows stay inside their ceilings.
// Built-in ceilings (HARD_CAPS, the spec depth walk, the no-limits scope, the bounded pluck table, the adjacent-quantifier regex
// rule) measured: core 141.7 (+0.7), useChart 148.7, Chart 189.6, SvgChart 166.9, SvgChart + interaction 184.2, Chart + VL 289.9;
// the marginal rows did not move. The ceilings follow to measured + 0.5.
// Size recovered from the existing code (perf/core-size; gzip bytes, same bundles): core 144479 -> 143481 (-998), useChart 151396 -> 150445,
// Chart 193288 -> 192343, SvgChart 170046 -> 169127, SvgChart + interaction 187811 -> 186862, Chart + VL 295948 -> 295012. The ceilings follow
// them down (core 140.1, useChart 146.9, Chart 187.8, SvgChart 165.2, SvgChart + interaction 182.5, Chart + VL 288.1, hit 6.4, signals 13.9,
// geo 16.0, transforms 38.6); dom, canvas and load measure within a few bytes of what they did and keep their ceilings.
// UTC time-unit guide labels (the format type follows the scale), the temporal size/opacity scales and the guide-title rules for
// ranged channels and layers (titles.ts), measured (kB gzip): Chart + VL 289.5 (+0.6 over origin/main's 288.9, measured with the same script); the other rows did not move.
// One tab stop per chart (focus hand-over on a spec change, entering the nodes from the container): Chart 189.2 and SvgChart 166.4 kB gzip
// (main: 188.8 and 166.1, so +0.3 each); the other rows stay inside their ceilings.
// The check of a spec's expressions as vega.parse makes it, at compile time (spec-expressions.ts reading the scopes, the handlers of
// signals and the guides; expr-check.ts; the tables of transform parameters and of guide properties; the event selector parser, which
// the compile now needs and used to be in the signals chunk alone), measured (kB gzip): core 146.6 (+5.5 over main's 141.1; minified,
// spec-expressions +3.8, guide-model 4.9, expr-check 3.6, transform-params 2.7, the selector parser 2.0), useChart 153.1, Chart 194.2, SvgChart 171.6, SvgChart + interaction 188.5,
// Chart + VL 294.2 (each +5.5..5.7 over main); signals marginal 12.9 (-0.9: the selector parser is core's now).
// With the cross-spec cache of what is found about an expression, measured: core 146.9 (+5.8 over main), useChart 153.3, Chart 194.4,
// SvgChart 171.9, SvgChart + interaction 188.7, Chart + VL 294.4. Minified, over main: spec-expressions +4.4, guide-model 4.9, expr-check 3.7,
// transform-params 2.7, the selector parser 2.0 (+0.4 stream-defs). Keeping only the kinded parameters in the transform table would save 0.5.
// Ceiling = the measure + 0.5.
// With the compile-time check of expressions merged on top of #78-#86 (kB gzip): core 150.4, useChart 157.2, Chart 198.5, SvgChart 175.9,
// SvgChart + interaction 193.2, Chart + VL 299.3; marginal: dom 6.0, canvas 6.0, hit 6.4, signals 12.9, load 5.4, geo 16.1, transforms 39.2.
// Every ceiling is that measure + 0.5.
// The ranged-channel, scale-type and polar fixes in @aster-charts/vl (fix/vl-ranged-temporal): Chart + VL 300.0 (+0.7 over 299.3: the scale-type rules,
// the secondary channel's domain, theta2 / radius2 and the constant-second-channel rules); nothing else moves. Its ceiling is that measure + 0.5.
// The runtime leftovers (fix/runtime-leftovers), measured (kB gzip) against origin/main's 98676b5: core 141.5 (+0.5: the facet
// join on vega's flat key and the aggregate's group keys, field paths where names were read as plain properties, the error a
// missing scale throws, the bare items of an aborted run kept, the viewport origin of the accessible tree), transforms marginal 39.2
// (+0.6: `nest`), useChart 148.3 (+0.5), Chart 189.2 (+0.5), SvgChart 166.4 (+0.4), SvgChart + interaction 183.8 (+0.5), Chart +
// VL 289.5 (+0.6). Ceilings are the measured value + 0.5.
// Kept dataset steps (step-reuse.ts: what a step reads, so a re-evaluation keeps the rows of the steps whose inputs did not move; the
// run of steps written as one; the group scopes' kept pipelines; the session's account of which host datasets are unchanged), measured
// (kB gzip): core 143.4 (+3.2 over 140.2), useChart 150.5 (+3.5 over 147.0), Chart 191.3 (+3.6), SvgChart 168.6 (+3.5), SvgChart +
// interaction 185.9 (+3.4), Chart + VL 287.0 (+3.5 over 283.5); the marginal rows did not move enough to cross theirs.
// #80-#83 land together (test strength, runtime leftovers, one tab stop, vl UTC); the ceilings are set here, in the first of them,
// from the measure of the four merged (kB gzip): core 141.5, useChart 148.4, Chart 189.6, SvgChart 166.9, SvgChart + interaction 184.2,
// Chart + VL 290.6; each is measured + 0.5, so every commit on main between them stays inside its ceiling.
// Kept dataset steps on top of main (guides and layout, #71-#75), measured (kB gzip): core 144.0, useChart 151.1, Chart 192.0,
// SvgChart 169.2, SvgChart + interaction 186.4, Chart + VL 292.1; the rest of the work of the section above is in these figures.
// Kept dataset steps merged with main at d2f753d (the leftovers, nest, field paths, built-in ceilings), measured (kB gzip): core 144.5,
// useChart 151.9, Chart 193.4, SvgChart 170.6, SvgChart + interaction 187.7, Chart + VL 294.0; the cause of the growth over main is
// step-reuse.ts and the runtime and session code around it. Ceilings are the measured value + 0.5.
// The incremental step engine out of the core entry (perf/engine-entry; the pulse-driven transform steps and the state a step leaves
// for the next pulse, in incremental-engine.ts, handed to the evaluation by evaluateChart and the chart session), measured (kB gzip) against
// origin/main's a3b453f: core 145.8 (-4.6 from 150.4: renderSpec evaluates once and no longer imports the engine); + dom marginal 10.6
// (+4.6: the engine is in the session's chunk of an app that already has core, so core + dom is 156.4 either way); canvas 5.9 (-0.1), hit 6.5
// (+0.1); the React rows keep the engine (every shell uses the session) and grew by 0.1 each (the module boundary): useChart 157.2, Chart 198.6,
// SvgChart 175.9, SvgChart + interaction 193.3, Chart + VL 299.4; signals 12.9, load 5.4, geo 16.1 and transforms 39.2 did not move.
// Ceilings are the measured value + 0.5.
// Late signals and mark transforms as points a pass stops at (fix/abort-late-signals-transforms), measured on a clean build (kB gzip): core 148.7
// (+0.7), useChart 160.1, Chart 201.6, SvgChart 178.8, SvgChart + interaction 196.1, Chart + VL 303.1. Ceilings are the measured value + 0.5.
// A group mark's transforms on its items, the encode before a mark's transforms, the refusal of tuple-making mark transforms and the guides that read
// a late signal (fix/abort-guides-group-transforms), measured on a clean build (kB gzip): core 149.2 (+0.5), useChart 160.7, Chart 202.2,
// SvgChart 179.4, SvgChart + interaction 196.7, Chart + VL 303.6. Ceilings are the measured value + 0.5.
// Every mark transform on the items, a mark's identifier from the view's counter, the guide parts left unencoded by a late signal and the
// properties each kind of guide has (fix/abort-guide-parts-item-transforms), measured on a clean build (kB gzip): core 150.5 (+1.3),
// useChart 161.9, Chart 203.4, SvgChart 180.7, SvgChart + interaction 197.8, Chart + VL 304.8. Ceilings are the measured value + 0.5.
// Guide formats read through the scale's formats, layouts that throw as stopping points with their warnings, and one parse walk that
// refuses the names and transform parameters vega refuses (fix/core-parse-format-layout-errors), measured on a clean build (kB gzip):
// core 152.4 (+1.9), useChart 163.6, Chart 205.2, SvgChart 182.4, SvgChart + interaction 199.6, Chart + VL 306.6. Ceilings are the
// The scale types vega-lite honours (fix/vl-honoured-scale-types) on main with the abort work above, measured on a clean build (kB gzip):
// Chart + VL 304.3 (+0.7 over the abort work's 303.6; the other rows did not move). Ceiling is the measured value + 0.5.
// Every mark drawing every channel definition (fix/vl-mark-position-channels) on main with the abort work and the paint channels, measured on a
// clean build (kB gzip): Chart + VL 305.2 (+0.4 over main's 304.8 ceiling; the other rows did not move). Ceiling is the measured value + 0.5.
// The guide parts that read a late signal, every mark transform on its items and the mark identifier (fix/abort-guide-parts-item-transforms) on
// main with the Vega-Lite channel work, measured on a clean build (kB gzip): Chart + VL 306.5 (+0.8 over main's 305.7 ceiling). Ceiling is the
// measured value + 0.5.
// Guide formats, layout errors and the parse walk (fix/core-parse-format-layout-errors) on main with the sort fix, measured on a clean build
// (kB gzip): Chart + VL 308.3 (+1.3 over main's 307.0 ceiling; the core growth the lane measured). Ceiling is the measured value + 0.5.
// The tooltip shows the item's `tooltip` value as vega-tooltip does (fix/129-tooltip-encoding; the formatter ships with the
// interaction capability), measured on a clean build against main (kB gzip): Chart 205.7 (main 205.4), SvgChart 182.8 (182.7),
// SvgChart + interaction 200.1 (199.8), Chart + VL 308.8 (308.5). Ceiling is the measured value + 0.5.
// Each pass of a fit view's update made from the same pass of the evaluation before (perf/fit-incremental: the first pass's state kept
// with the committed one, claims by identity), measured on a clean build (kB gzip): core 152.9 (+0.1 over 152.8), useChart 164.1, Chart
// 206.1, SvgChart 183.2, SvgChart + interaction 200.5, Chart + VL 309.2. Ceilings are the measured value + 0.5.
// Transitions (#127, feat/127-transitions: the `transition` prop, @aster-charts/core/transition loaded on demand), measured on a
// clean build against the branch's base, 0c19489 (kB gzip, before -> after): core 152.7 -> 152.8 (the key fields and tick values the
// runtime stamps on scenes), useChart 163.9 -> 164.4, Chart 205.7 -> 206.9, SvgChart 182.8 -> 184.0, SvgChart + interaction 200.1 ->
// 201.6, Chart + VL 308.8 -> 310.2; new marginal row + @aster-charts/core/transition 3.1 (the interpolation and the frame loop: an
// on-demand chunk of the React rows, which grew from +59.1 to +62.5 in chunks loaded on demand). Of the Chart row's +1.2, 0.85 is
// the prop handling in ChartCore and react/transition.js plus the core stamps (measured with @aster-charts/core/transition
// external: 206.56), and 0.35 is the chunk boundary: util.js and color.js, which the on-demand module shares with core, move to a
// chunk the entry imports by name (useChart, which never uses the prop, pays only that: 163.98 external, 164.35 bundled). Ceilings
// are the measured value + 0.5.
// Transitions stacked on the fit-view work (feat/127-transitions rebased onto perf/fit-incremental), measured on a clean build of
// the combined tree (kB gzip): core 153.0, useChart 164.6, Chart 207.3, SvgChart 184.4, SvgChart + interaction 201.9, Chart + VL
// 310.6, + @aster-charts/core/transition 3.1. Ceilings are the measured value + 0.5.
// Signal-scoped reuse (perf/signal-scoped-reuse: marks and scales keyed by the signals they read, the datasets' copies and the steps
// that read a dataset by name kept), measured 2026-11-10 on a clean build against origin/main's e31d61c (kB gzip, before -> after):
// core 153.0 -> 154.5, useChart 164.6 -> 166.1, Chart 207.4 -> 208.7, SvgChart 184.4 -> 185.8, SvgChart + interaction 202.0 -> 203.3,
// Chart + VL 310.6 -> 312.1; the marginal rows did not move. Ceilings are the measured value + 0.5.
// Selections under signal changes (perf/selection-signal-reuse: dataset builds kept between rounds and passes, marks keyed by the
// datasets they read by name, pulses with a signal change, keys read as the expression lexer reads names), measured 2026-11-10 on a
// clean build against its base 082a700 (kB gzip, before -> after): core 154.5 -> 155.7, useChart 166.1 -> 167.4, Chart 208.7 ->
// 210.0, SvgChart 185.8 -> 187.1, SvgChart + interaction 203.3 -> 204.4, Chart + VL 312.1 -> 313.3; + core/dom 10.6 -> 10.7 (within
// its ceiling), the other marginal rows did not move. Ceilings are the measured value + 0.5.
// Identifier numbers across rounds and expression names read as the lexer reads them (the same branch: `carriedFrom`, datasets that
// read a scale ranked after it, the parsed expression at every site that read names with a pattern), measured 2026-11-10 on a clean
// build (kB gzip, before -> after): core 155.7 -> 156.2, useChart 167.4 -> 167.8, Chart 210.0 -> 210.5, SvgChart 187.1 -> 187.6,
// SvgChart + interaction 204.4 -> 204.9, Chart + VL 313.3 -> 313.9; the marginal rows within their ceilings. Ceilings are the
// measured value + 0.5.
// Identifier numbers by source rows and the Vega-Lite compiler's expression tokenizer (the same branch), measured 2026-11-10 on a clean
// build (kB gzip, before -> after): core 156.2 -> 156.8, useChart 167.8 -> 168.4, Chart 210.5 -> 211.1, SvgChart 187.6 -> 188.1,
// SvgChart + interaction 204.9 -> 205.5, Chart + VL 313.9 -> 315.6 (the tokenizer, and the renames that read it); the marginal rows
// within their ceilings. Ceilings are the measured value + 0.5.
// A pulse through an identifier after a filter (source rows followed through the steps; the same branch), measured 2026-11-10 on a
// clean build (kB gzip, before -> after): core 156.8 -> 157.1 (within its ceiling), core/dom 11.3 (its ceiling was 11.1: the
// incremental engine is in that chunk), useChart 168.4 -> 169.4, Chart 211.1 -> 212.1, SvgChart 188.1 -> 189.1, SvgChart +
// interaction 205.5 -> 206.5, Chart + VL 315.6 -> 316.7. Ceilings are the measured value + 0.5.
// Discrete scales kept over row changes (the category census, scales kept for their settings; perf/discrete-scale-appends),
// measured 2026-11-10 on a clean build against its base 72ffeea (kB gzip, before -> after): core 157.1 -> 157.4 (its ceiling was
// 157.3: raised to the measured value + 0.5); useChart 169.4 -> 169.8, Chart 212.1 -> 212.4, SvgChart 189.1 -> 189.5, SvgChart +
// interaction 206.5 -> 206.8, Chart + VL 316.7 -> 317.1, each within its ceiling, which is unchanged; the marginal rows did not move.
// Marks inside group items kept by instance and unchanged group items shared, published signals recorded per step, force-bound marks,
// row cells compared as the scene sees them (the same branch), measured 2026-11-10 on a clean build (kB gzip, before -> after): core
// 157.4 -> 159.4, useChart 169.8 -> 171.4, Chart 212.4 -> 214.0, SvgChart 189.5 -> 191.0, SvgChart + interaction 206.8 -> 208.4,
// Chart + VL 317.1 -> 318.8; core/dom 11.3 -> 10.9 (the row diff is in the core chunk now, which the runtime calls). Ceilings are the
// measured value + 0.5; the marginal rows are within theirs.
// `urlData: 'refuse'` (#143: url-data.ts, the walk and the refusal in the engine's entry points; the React shells, hooks and worker
// refusing before any add-on import), measured 2026-11-12 on clean builds against origin/main 8c663d3 (kB gzip, before -> after):
// core 159.4 -> 159.9, useChart 171.4 -> 172.0, Chart 214.0 -> 214.7, SvgChart 191.1 -> 191.8, SvgChart + interaction 208.4 -> 209.1,
// Chart + VL 319.1 -> 319.8; the marginal rows did not cross theirs. #143 and #144 (getPng) land together, so the ceilings are set
// here from the larger of #143 alone and the two together (with #144: core 159.9, useChart 171.9, Chart 214.9, SvgChart 192.0,
// SvgChart + interaction 209.2, Chart + VL 319.6), each + 0.5, so main stays inside them between the two merges.
// <Chart renderer="canvas"> draws image marks from their urls (image-load.ts, shared with the png chunk, is in the canvas
// capability <Chart> carries; the effect that loads and repaints), measured 2026-11-12 on a clean build against feat/144-png-export
// cf0f141 (kB gzip, before -> after): Chart 214.9 -> 216.2, Chart + VL 319.6 -> 320.9, SvgChart 192.0 -> 192.3 and SvgChart +
// interaction 209.2 -> 209.6 (the effect in ChartCore; within their ceilings), png 7.7 -> 7.8 (within). Ceilings are the measured
// value + 0.5.
const BUDGETS = {
  '@aster-charts/core': 160.4 * 1024,
  '+ @aster-charts/core/dom': 11.8 * 1024,
  '+ @aster-charts/core/canvas': 6.4 * 1024,
  '+ @aster-charts/core/hit': 7.0 * 1024,
  '+ @aster-charts/core/signals': 13.4 * 1024,
  '+ @aster-charts/core/load': 5.9 * 1024,
  '+ @aster-charts/core/geo': 16.6 * 1024,
  '+ @aster-charts/core/transforms': 39.7 * 1024,
  // drawsSame looks into a guide's metadata by its fields (perf/transition-retarget-by-identity), measured 2026-11-10 on a clean
  // build: 3.7 kB gzip (was 3.3), an on-demand chunk only; no eager row moved. Ceiling is the measured value + 0.5.
  '+ @aster-charts/core/transition': 4.2 * 1024,
  // The PNG painter (#144: png.ts and the canvas renderer it paints with), an on-demand chunk only (`getPng` imports it on its first
  // call), measured 2026-11-12 on a clean build: 7.7 kB gzip over the core app (the canvas renderer's 6.0 included; 7.5 before the
  // one image deadline). No eager row grew past what the #143 note above set for the two together. Ceiling is the measured value + 0.5.
  '+ @aster-charts/core/png': 8.2 * 1024,
  '@aster-charts/react useChart': 172.5 * 1024,
  '@aster-charts/react Chart': 216.7 * 1024,
  // The light chart (`@aster-charts/react/lite`): SVG only, no canvas renderer; alone and with the `interaction` capability.
  '@aster-charts/react SvgChart': 192.5 * 1024,
  '@aster-charts/react SvgChart + interaction': 209.7 * 1024,
  // Base + the VL compiler (opt-in: `import '@aster-charts/react/vl'`).
  '@aster-charts/react Chart + VL': 321.4 * 1024,
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = dirname(dirname(dirname(THIS_DIR)))
const TMP = join(MONOREPO_ROOT, 'packages', 'benchmarks', '.tmp')

const CORE_APP = String.raw`import { renderSpec } from '@aster-charts/core'
const spec = { width: 400, height: 300, data: [{ name: 't', values: [{ x: 0, y: 10 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }], marks: [] }
export default () => renderSpec(spec)
`

/**
 * A row is either absolute (`base` unset: the whole bundle of the app) or MARGINAL (`base` names another row: the
 * row's gzip minus that row's, i.e. what the addon adds to an app that already renders with core). The addons share
 * most of their code with core, so a standalone figure double counts it; the marginal one is what an app pays.
 */
const ENTRIES = [
  { name: '@aster-charts/core', file: 'core.mjs', platform: 'node', src: CORE_APP },
  {
    name: '+ @aster-charts/core/dom',
    base: '@aster-charts/core',
    file: 'dom.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { createChartSession, patchSceneDom } from '@aster-charts/core/dom'
export const dom = { createChartSession, patchSceneDom }
`,
  },
  {
    name: '+ @aster-charts/core/canvas',
    base: '@aster-charts/core',
    file: 'canvas.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { renderSceneToCanvas } from '@aster-charts/core/canvas'
export const canvas = renderSceneToCanvas
`,
  },
  {
    name: '+ @aster-charts/core/hit',
    base: '@aster-charts/core',
    file: 'hit.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { buildHitIndex } from '@aster-charts/core/hit'
export const hit = buildHitIndex
`,
  },
  {
    name: '+ @aster-charts/core/signals',
    base: '@aster-charts/core',
    file: 'signals.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { bindSceneSignals } from '@aster-charts/core/signals'
export const signals = bindSceneSignals
`,
  },
  {
    name: '+ @aster-charts/core/load',
    base: '@aster-charts/core',
    file: 'load.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { loadSpecData } from '@aster-charts/core/load'
export const load = loadSpecData
`,
  },
  {
    name: '+ @aster-charts/core/geo',
    base: '@aster-charts/core',
    file: 'geo.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster-charts/core/geo'
`,
  },
  {
    name: '+ @aster-charts/core/transforms',
    base: '@aster-charts/core',
    file: 'transforms.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster-charts/core/transforms'
`,
  },
  {
    name: '+ @aster-charts/core/transition',
    base: '@aster-charts/core',
    file: 'transition.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { createScenePlayer, createSceneTransition } from '@aster-charts/core/transition'
export const transition = { createScenePlayer, createSceneTransition }
`,
  },
  {
    name: '+ @aster-charts/core/png',
    base: '@aster-charts/core',
    file: 'png.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { renderSceneToPng } from '@aster-charts/core/png'
export const png = renderSceneToPng
`,
  },
  {
    name: '@aster-charts/react useChart',
    file: 'react-usechart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { useChart } from '@aster-charts/react'
export default useChart
`,
  },
  {
    name: '@aster-charts/react Chart',
    file: 'react.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { Chart } from '@aster-charts/react'
export default Chart
`,
  },
  {
    name: '@aster-charts/react SvgChart',
    file: 'react-svgchart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster-charts/react/lite'
export default SvgChart
`,
  },
  {
    name: '@aster-charts/react SvgChart + interaction',
    file: 'react-svgchart-interaction.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'
export { SvgChart, interaction }
`,
  },
  {
    name: '@aster-charts/react Chart + VL',
    file: 'react-vl.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import '@aster-charts/react/vl'
import { Chart } from '@aster-charts/react'
export default Chart
`,
  },
]

function setupTmp() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
}

const PUBLIC_PACKAGES = ['core', 'react', 'vl']
// (mirrors tsconfig.build.json: test files, `src/testing/` helpers and type-only `*.assert.ts` modules emit nothing)
const isBuildInput = (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|testlib|testkit|assert)\.tsx?$/.test(name)

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? (e.name === 'testing' ? [] : listSources(p)) : isBuildInput(e.name) ? [p] : []
  })
}

/**
 * The budget must measure what `pnpm build` produces from the CURRENT sources: a dist that is
 * missing, or older than the source file it was built from, makes the numbers describe code that no
 * longer exists. Returns a list of problems (empty when every dist file is at least as new as its source).
 */
function distProblems() {
  const problems = []
  for (const pkg of PUBLIC_PACKAGES) {
    const srcDir = join(MONOREPO_ROOT, 'packages', pkg, 'src')
    const distDir = join(MONOREPO_ROOT, 'packages', pkg, 'dist')
    for (const file of listSources(srcDir)) {
      const rel = file.slice(srcDir.length + 1).replace(/\.tsx?$/, '.js')
      let dist
      try {
        dist = statSync(join(distDir, rel))
      } catch {
        problems.push(`packages/${pkg}/dist/${rel} is missing`)
        continue
      }
      if (dist.mtimeMs < statSync(file).mtimeMs) problems.push(`packages/${pkg}/dist/${rel} is older than its source`)
    }
  }
  return problems
}

// Test hook (scripts/bundle-shaking.test.mjs): bundle as if the packages declared no `sideEffects` field at all, i.e.
// every dist module may have effects. The rows must then FAIL: that is what proves the budget watches tree-shaking.
const IGNORE_SIDE_EFFECTS = process.env.ASTER_BUDGET_IGNORE_SIDE_EFFECTS === '1'
const ignoreSideEffects = {
  name: 'ignore-side-effects-field',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip || args.kind === 'entry-point') return undefined
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: { skip: true } })
      if (r.errors.length || !/[\\/]packages[\\/](core|react|vl)[\\/]dist[\\/]/.test(r.path)) return undefined
      return { path: r.path, sideEffects: true }
    })
  },
}

const KB = (n) => (n / 1024).toFixed(1)

try {
  setupTmp()
  const stale = distProblems()
  if (stale.length) {
    console.error(`Refusing to measure a stale or missing dist (${stale.length} problem${stale.length === 1 ? '' : 's'}); run \`pnpm build\` first:`)
    for (const p of stale.slice(0, 5)) console.error(`  ${p}`)
    process.exit(1)
  }

  const sizes = new Map()
  const lazyKb = new Map()
  let failed = false
  for (const entry of ENTRIES) {
    const entryPath = join(TMP, entry.file)
    const outDir = join(TMP, 'out')
    rmSync(outDir, { recursive: true, force: true })
    writeFileSync(entryPath, entry.src)
    // Code-split, so an add-on that is only ever `import()`ed (the shells load @aster-charts/core/geo, /transforms and /load on demand,
    // see @aster-charts/core/addons) is a chunk of its own, as it is in a real build. The row counts what the page loads up front: the
    // entry and every chunk it imports statically, not the chunks fetched later and only by a spec that needs them.
    const built = await build({
      entryPoints: [entryPath],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: entry.platform,
      splitting: true,
      write: true,
      outdir: outDir,
      metafile: true,
      absWorkingDir: MONOREPO_ROOT,
      logLevel: 'silent',
      external: entry.external,
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: IGNORE_SIDE_EFFECTS ? [ignoreSideEffects] : [],
    })
    const outputs = built.metafile.outputs
    const entryOut = Object.keys(outputs).find((o) => outputs[o].entryPoint)
    const initial = new Set()
    const visit = (o) => {
      if (initial.has(o)) return
      initial.add(o)
      for (const imp of outputs[o].imports) if (imp.kind === 'import-statement' && outputs[imp.path]) visit(imp.path)
    }
    visit(entryOut)
    lazyKb.set(entry.name, Object.keys(outputs).filter((o) => !initial.has(o)).reduce((n, o) => n + gzipSync(readFileSync(join(MONOREPO_ROOT, o))).length, 0))
    const buf = Buffer.concat([...initial].map((o) => readFileSync(join(MONOREPO_ROOT, o))))
    const gz = gzipSync(buf).length
    sizes.set(entry.name, { min: buf.length, gz })
    // Marginal rows report what the addon adds on top of its base row.
    const base = entry.base ? sizes.get(entry.base) : null
    const measured = base ? gz - base.gz : gz
    const budget = BUDGETS[entry.name]
    if (budget == null) throw new Error(`no budget for "${entry.name}"`)

    const pass = measured <= budget
    if (!pass) failed = true
    console.log(
      `${entry.name.padEnd(26)} min=${KB(base ? buf.length - base.min : buf.length).padStart(7)} kB  gzip=${KB(measured).padStart(6)} kB${base ? ' (marginal)' : '           '}  budget=${KB(budget).padStart(5)} kB  ${pass ? 'PASS' : 'FAIL'}${lazyKb.get(entry.name) ? `  (+${KB(lazyKb.get(entry.name))} kB gzip in chunks loaded on demand)` : ''}`,
    )
  }
  if (failed) process.exit(1)
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch { /* ignore */ }
}
