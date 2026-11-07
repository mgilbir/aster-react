# Contributor runbook

How to debug one failing conformance spec end to end, what the stale-`dist` refusals mean, and every environment variable the
harness and the scripts read. [CONTRIBUTING.md](../CONTRIBUTING.md) says what must be green before a PR;
[TESTING.md](TESTING.md) says what each suite proves; this page is for the moment something is red.

Every command below was run on this tree (Node 26, Linux). Output blocks are real output, shortened where marked. "The oracle" is
real `vega` (and `vega-lite` for `.vl.json` files); it is a test dependency only.

## 1. One failing corpus spec, end to end

The corpus is `packages/conformance/corpus` (`*.vg.json` Vega specs, `*.vl.json` Vega-Lite specs). A spec name is its file name
without the `.vg.json` / `.vl.json` suffix (`bar-basic`).

### 1.1 Find which gate failed

`pnpm check` prints a summary of the gates that failed. `pnpm check -- --list` lists the gates with what each asserts, and
`pnpm check -- --only <name>[,<name>]` re-runs just those (add `--fail-fast` to stop at the first failure). The gates that read the
corpus, and the command that re-runs one spec of each:

| Gate | What it compares | One spec |
|---|---|---|
| `conformance` | canonical SVG of real vega against Aster (`.vg.json` and `.vl.json`, the latter compiled by `vega-lite`) | `ASTER_CORPUS_FILTER='^bar-basic$' pnpm conformance` |
| `conformance-vl` | `.vl.json` only: `@aster/vl` against `vega-lite`, see 1.4 | `pnpm conformance-vl bar-basic` (a substring; no `--`) |
| `scene-diff` | resolved scales, groups and items per scope, before any SVG is written | `pnpm scene-diff -- --filter bar-basic` (add `--scales-only`) |
| `a11y-parity` | guide captions against vega-scenegraph's `aria-label` | `pnpm a11y-parity -- --filter bar-basic` |
| `transform-matrix` | transform option combinations (not per spec: cases are generated) | `pnpm transform-matrix -- --filter aggregate` |
| `browser-conformance` | vega-embed and Aster in Chromium with live canvas text metrics | `pnpm conformance:browser -- --filter=bar-basic` |
| `canvas`, `batch` | pixel parity in Chromium | `pnpm conformance:canvas -- --filter=bar-basic` takes `--filter=`, `--limit=N`, `--browser=chromium\|firefox\|webkit` |
| `tz-matrix` | the zone-sensitive tests and the `corpus-tz` corpus under non-UTC zones | `pnpm test:tz Asia/Kolkata` (one zone) |

The filters differ on purpose of the script that owns them: `ASTER_CORPUS_FILTER` is a regular expression, `conformance-vl` takes
a positional substring, `scene-diff`, `a11y-parity` and `transform-matrix` take `--filter <substring>`, the browser scripts
`--filter=<substring>`. `conformance-vl bar-basic` works; `conformance-vl -- bar-basic` passes the `--` as the filter and runs zero
specs.

### 1.2 Rule out a stale build first

The harness imports `@aster/core`, `@aster/react` and `@aster/vl` by package name, which resolves to each package's **`dist`**, not
its `src`. If you edited a source file and did not rebuild, the conformance run is checking the old code and says nothing about
your edit. See section 2. When in doubt: `pnpm build`, then re-run.

### 1.3 Reproduce with one spec

```bash
ASTER_CORPUS_FILTER='^bar-basic$' pnpm conformance
```

A green spec prints `PASS  bar-basic` and `[conformance] 1/1 passed`. A red one prints the first twelve differences. This is the
output with a planted bug (`num()` in `packages/core/src/render.ts` made to add 0.5 to every number, `pnpm --filter @aster/core build`;
shortened):

```text
FAIL  bar-basic
      root: svg|410|310|0 0 410 310|bg=#ffffff vs svg|410.5|310.5|0 0 410.5 310.5|bg=#ffffff
      only-oracle: path|M5.5,5.5L405.5,5.5L405.5,305.5L5.5,305.5Z|fill=none;stroke=#dddddd;stroke-width=1||
      only-oracle: line|5.5,105.5|405.5,105.5|stroke=#dddddd;stroke-width=1||
      ...
[conformance] 0/1 passed
[conformance] failing: bar-basic
```

How to read it. Both SVGs are reduced by `packages/conformance/src/normalize.ts` to one record per painted element in paint order
(geometry under the full transform, computed paint and text style, clip/mask/filter effects, text content), with numbers at three
decimals, colours as sRGB, ids resolved to what they point at. Differences that cannot change a pixel (attribute order, quote
style, `white` against `#fff`) are removed; everything else is compared. `root:` is the outer `<svg>` record on each side.
`only-oracle:` is an element vega drew that Aster did not draw the same way, `only-ours` (in `conformance-vl`: `ours-only`) the
reverse. The same element moved shows up as one line on each side, so read the pair. A `[count] oracle=23 ours=26` line is the
number of records on each side.

### 1.4 `.vl.json`: which stage differs

`pnpm conformance-vl <name>` runs four checks per spec, in this order (the header of `packages/conformance/src/run-vl.ts` has the
full list), so the first line it prints says where to look:

1. `@aster/vl` compiles a deep-frozen copy of the spec, and the emitted Vega survives a JSON round trip. A throw here is a
   compiler problem (a `VLCompileError` is a refusal, not a bug, if the feature is on the "Throws" list of `packages/vl/README.md`).
2. The emitted Vega is rendered by **real vega**; any vega error or warning that vega-lite's own output does not also raise fails
   the spec (`error:` / `warn:` lines). The compiler emitted invalid Vega.
3. Real vega's rendering of **our** Vega equals its rendering of **vega-lite's** Vega
   (`real vega on our Vega differs from vega-lite's`). The compiler emitted valid Vega that means something else.
4. Aster's runtime renders our Vega like the reference (`oracle-only` / `ours-only` lines). The compiler is fine; the runtime
   (`@aster/core`) differs.

Stages 1-3 never involve the Aster runtime: debug them in `packages/vl`
([packages/vl/CONTRIBUTING.md](../packages/vl/CONTRIBUTING.md)). Stage 4 and every `.vg.json` failure are runtime failures.

### 1.5 Runtime failure: evaluation or serialization

`scene-diff` compares the evaluated scene (scales, groups, items) with the oracle's scenegraph, before an SVG exists:

```bash
pnpm scene-diff -- --filter bar-basic
```

- `scene-diff` fails: the bug is in evaluation (data, transforms, scales, encodes, layout). It names the scale, group or item.
- `scene-diff` passes but `conformance` fails: the scene is right and the SVG written from it is not (`packages/core/src/render.ts`,
  guides, clip paths, gradients). With the planted bug above, `pnpm scene-diff -- --filter bar-basic` reports `1/1 scenes match`
  while `conformance` fails.

Then narrow by reading the first differing record: its tag and attributes name the mark or guide (`role-axis`, `mark-rect`...), and
the same spec in `packages/conformance/corpus` with the other marks removed is the smallest reproduction. To see both SVGs, call
`renderWithVega` (`packages/conformance/src/render-vega.ts`, takes a Vega spec: compile a `.vl.json` with `vega-lite` first) and
`renderSpec` from `@aster/core` in a `tsx` script placed in `packages/conformance` (so `vega` and `@aster/*` resolve) and run with
`pnpm --filter @aster/conformance exec tsx <script>`; print each result, or `canonicalizeSvg` of it.

### 1.6 Fails only in the browser

`pnpm conformance:browser -- --filter=<name>` renders in Chromium with vega-embed and with Aster, with live canvas text metrics
instead of the headless estimate (`docs/FONTS.md`). A spec that is green in Node and red here is measuring text differently. Install
the browser once with the command in CONTRIBUTING.md. For the interaction gates (`conformance:signals`, `conformance:selections`,
`conformance:intersect`) the debugging variables are in the table of section 3 (`SIG_PRINT`, `SEL_*`). With a filter, run the selections script
directly, because the package script also passes `--min-cases` and `--max-retained`, which a filtered run cannot meet:

```bash
pnpm --filter @aster/conformance exec tsx scripts/browser-vl-selections.mts --filter=legend
```

`--filter=` is a substring of the case name (a sentence such as `concat: a brush in one view filters another`). A case counted
as `retained` is not a failure: it is the documented difference after a signal write ([INTERACTION.md](INTERACTION.md#signals)).

### 1.7 Fix, then prove it

Rebuild, re-run the one spec, then the gate, then the whole list:

```bash
pnpm build
ASTER_CORPUS_FILTER='^bar-basic$' pnpm conformance
pnpm check -- --only conformance,conformance-vl,scene-diff
```

Add a corpus spec (or a unit or oracle-vector test) for every fixed behaviour (CONTRIBUTING.md). A known gap goes to
`packages/conformance/probes` (`pnpm probe [name-filter]`) until it is fixed, then moves to `corpus/`.

## 2. Stale `dist`

`@aster/core`, `@aster/react` and `@aster/vl` have `exports` that point at `dist` (`./dist/index.js`, `./dist/<entry>.js`).
Whatever imports them by name gets the build, not the source: the conformance scripts and tests, the benchmarks, the demo, the
packaging checks, and the React tests (18 of them import `@aster/core` or one of its entries). Only a package's own tests that import `./x.js` or `../src`
read source. So one `pnpm test` can mix source and build, and after an edit without a rebuild it tests old code against new code.

What reads `dist` and what happens when it is missing or old:

| Command | Missing `dist` | Older than the source |
|---|---|---|
| `pnpm check:deps` | refuses: `packages/vl/dist is missing -> run \`pnpm build\` first (or pass --src-only)`, exit 1 | not checked |
| `pnpm verify:publish` | refuses: `[verify-publish] FAIL: packages/vl/dist is missing — run \`pnpm build\` first`, exit 1 | not checked |
| `pnpm check:bundle` | refuses: `[bundle-shaking] packages/vl/dist is missing: run \`pnpm build\` first`, exit 2 | not checked |
| `pnpm --filter @aster/benchmarks run budget` | refuses (`... .js is missing`) | **refuses**: `Refusing to measure a stale or missing dist (1 problem); run \`pnpm build\` first:` then `packages/core/dist/render.js is older than its source`, exit 1 |
| `scripts/bundle-shaking.test.mjs`, `scripts/api-docs-coverage.test.mjs` | the test fails with `is not built (pnpm build)` / `is missing: run pnpm build` | not checked |
| `pnpm conformance`, `conformance-vl`, `scene-diff`, sweeps, `bench:bundle`, `vitest` suites that import `@aster/*` | module not found | **silent**: they run on the old build |

Only `budget` compares times (the modification time of every `src` file of the three packages, except `src/testing`, against its
`dist` counterpart); everything else only checks that the file exists. A dist that exists but is old passes the others. Measured on
this tree: with `num()` in `render.ts` changed and no rebuild, `pnpm conformance` printed `PASS  bar-basic`; after
`pnpm --filter @aster/core build` it printed `FAIL  bar-basic`.

The fix is always the same, and it is cheap to do too often:

```bash
pnpm build
```

It builds the three packages and the private workspaces in dependency order (`pnpm -r build`). `pnpm --filter @aster/core build`
rebuilds one package; the packages that depend on it do not need a rebuild to see it, because they import `@aster/core` at run time.
A `git checkout` or `git pull` that touches many sources makes the budget refuse until the next build. The `build` gate of
`pnpm check` runs first for that reason.

## 3. Environment variables

Everything the repository's own code reads (`process.env`, found by searching every tracked source file). Unset means the default
in the third column. Most are seed counts and debug switches of the generated differential tests: the tests walk deterministic
seeds, a failure prints its seed, and the seed variable replays it.

A reduced count can trip a test's own non-vacuity assertion. For example `SIGNAL_GRAPH_SEEDS=5` fails with `setdata graphs among 5:
expected 0 to be greater than 2`, `ABORT_ONE=1` with `trees whose legend failed in vega: expected 3 to be greater than 3`, and
`LABEL_SEEDS=5` with `expected 191 to be greater than 2000`. That is the guard that a generator exercises what it claims to, not a
bug. Use the single-seed variables (`*_SEED`) to replay one failure, and raise counts rather than lowering them to hunt for more.

Run a test file under a variable with `pnpm exec vitest run <file>` (add `-t '<test name>'` to select tests), for example:

```bash
ASTER_ORACLE_SEED=17 pnpm exec vitest run packages/core/src/incremental-oracle.test.ts
TZ=Asia/Kolkata pnpm exec vitest run packages/core/src/calendar.tz.test.ts
```

### Harness

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `ASTER_CORPUS_DIR` | `packages/conformance/src/run.ts` (`pnpm conformance`) | `corpus` | The corpus directory to run, relative to `packages/conformance`. `scripts/test-tz.mjs` sets `corpus-tz`. |
| `ASTER_CORPUS_FILTER` | `packages/conformance/src/run.ts` | unset: all specs | A regular expression; only specs whose name matches run. A filter that matches nothing fails with `corpus is empty`. |
| `ASTER_GALLERY_CACHE_DIR` | `packages/conformance/src/gallery/cache.ts` | `packages/conformance/.gallery` | Where the fetched official gallery examples live. `vitest.config.mjs` points the default test run at a directory that does not exist, so a test that needs the cache fails everywhere, not only on CI (`scripts/gallery-isolation.test.mjs` guards this); the gallery gate (`vitest.gallery.config.mjs`) does not. |
| `ASTER_V8_SORT_FLAG` | `scripts/vitest-engine.setup.mjs`, `packages/conformance/src/sort-engine.test.ts` | set by `vitest.config.mjs`: `--maglev-disable-builtin-reducers` if this V8 has it, else empty | Pins V8's inlined `Array.prototype.sort` off so the in-process oracle sorts deterministically; the sort-engine test turns it back on to prove Aster does not depend on the pin. Not for setting by hand. |
| `TZ` | Node itself; many tests set and restore `process.env.TZ` | the machine's zone | The time zone. `pnpm test:tz [zone ...]` runs the zone-sensitive tests and the `corpus-tz` corpus under `America/New_York`, `Asia/Kolkata` and `Australia/Lord_Howe` (and `UTC` for the corpus). Set it yourself to run any one test file in a zone. |

`NODE_ENV` appears in the repository only as an esbuild `define` (`"process.env.NODE_ENV": '"production"'`) that the bundling scripts
substitute; nothing reads it.

### Generated differential and property tests

| Variable | Test | Default | Effect |
|---|---|---|---|
| `ASTER_ORACLE_SEEDS`, `ASTER_ORACLE_STEPS`, `ASTER_ORACLE_START`, `ASTER_ORACLE_SEED` | `packages/core/src/incremental-oracle.test.ts` | 40, 12, 1, unset | Seeds to run, steps per seed, first seed, and a single seed to replay (incremental evaluation equals a fresh one). |
| `ASTER_DOM_ORACLE_SEEDS`, `_STEPS`, `_START`, `_SEED` | `packages/core/src/dom-oracle.test.ts` | 40, 10, 1, unset | Same knobs for the patched DOM against a DOM built fresh. |
| `ASTER_CANVAS_ORACLE_SEEDS`, `_STEPS`, `_START`, `_SEED` | `packages/core/src/canvas-append-oracle.test.ts` | 60, 12, 1, unset | Same knobs for canvas append painting against a full repaint. |
| `ASTER_REUSE_SEEDS`, `ASTER_REUSE_SEED` | `packages/core/src/dataset-reuse.test.ts` | 300, unset | Number of generated charts; replay one seed. |
| `ASTER_ONCE_SEEDS`, `ASTER_ONCE_SCOPED` | `packages/core/src/evaluate-once.test.ts` | 300, 200 | Generated charts for the plain and the group-scope tests. |
| `ASTER_STREAM_SEEDS`, `ASTER_STREAM_SEED`, `ASTER_STREAM_TRACE` | `packages/core/src/stream.property.test.ts` | 25, unset, unset | Seeds per policy; replay one seed; any non-empty value adds the flush/push trace to a failure message. |
| `ASTER_EXPR_FUZZ_SEED`, `ASTER_EXPR_FUZZ_N` | `differential-vega-expression-gen.test.mts`, `differential-vega-interpreter-gen.test.mts` | `0xA57E12`, 30000 | Seed and number of generated expression sources, against real vega's parser and interpreter. |
| `ASTER_DIFF_SCALE` | `scaled()` in `packages/conformance/scripts/differential-gen.mts`, used by the generated differentials | 1 | Multiplies every generated case count (a value that is not a positive number counts as 1). |
| `ASTER_DIFF_TRACE` | `differential-gen.mts`, `differential-scale-gen.test.mts` | unset | A file path: each case's name and label is appended before it runs, so the last line names the case that crashed a worker. |
| `ASTER_DIFF_MESSAGES` | `differential-d3-interpolate-gen.test.mts`, `differential-scale-gen.test.mts` | unset | Any non-empty value also compares the wording of a `TypeError` (it quotes variables of the library that raised it). |
| `ASTER_GEN_DEBUG` | `differential-transforms-generated.test.mts` | unset | Logs the cases where vega crashes inside its own code (those are skipped, not compared). |
| `ASTER_GEN_SHOW` | `differential-transforms-generated.test.mts` | unset | `<generator>#<index>` (for example `timeunit#12`): prints that case, vega's result and Aster's. |
| `ABORT_KINDS` | `differential-abort-gen.mts` (used by `differential-abort-trees.test.mts`) | every kind | Comma-separated failure kinds to inject (`axis,legend`), to narrow a failing tree. |
| `ABORT_ONE` | same | unset | Any non-empty value puts exactly one failure in every tree. |
| `ABORT_AUTOSIZE` | same | random per tree | Fixes `autosize` (`none`, `pad` or `fit`). |
| `GUIDE_AXES`, `GUIDE_LEGENDS`, `GUIDE_TITLES`, `GUIDE_SEED` | `packages/conformance/src/guide-generated-vs-vega.test.ts` | 500, 500, 400, unset | Generated cases per guide kind; a seed number runs that one case in all three and skips the not-vacuous assertions. |
| `GUIDE_PARTIAL_REPORT` | `differential-guide-partial.test.mts` | unset | Any non-empty value prints how many cases hit each guide part. |
| `TRELLIS_CASES`, `TRELLIS_SEED` | `packages/conformance/src/trellis-generated-vs-vega.test.ts` | 500, unset | Generated grids; replay one (it also prints why a case was refused). |
| `LABEL_SEEDS`, `LABEL_AREA_SEEDS`, `LABEL_BROWSER_SEEDS` | `packages/conformance/src/label-generated-vs-vega.test.ts` | 160, 90, 40 | Generated label specs: Node, area, and in Chromium. |
| `MARK_SEEDS` | `packages/conformance/src/mark-bounds-vs-vega.test.ts` | 600 | Generated mark-bounds cases. |
| `SIGNAL_GRAPH_SEEDS` | `packages/conformance/src/signal-dataflow-vs-vega.test.ts` | 70 | Generated event-driven signal graphs. |
| `TEXT_SEEDS` | `packages/conformance/src/text-truncation-vs-vega.test.ts` | 400 | Generated text-truncation cases. |
| `WORDCLOUD_SEEDS` | `packages/conformance/src/wordcloud-vs-vega.test.ts` | 36 | Generated word clouds. |

### Browser scripts (need Chromium)

| Variable | Script | Default | Effect |
|---|---|---|---|
| `SIG_PRINT` | `scripts/browser-signals.mts` (`pnpm conformance:signals`) | unset | Any non-empty value prints vega's final signal values for every case where vega did not error. |
| `SEL_DEBUG` | `scripts/browser-vl-selections.mts` (`pnpm conformance:selections`) | unset | Any non-empty value logs each case's frame rectangle, pointer targets, the mounted markup and the signals at each step. Verbose: use it with `--filter=`. |
| `SEL_TRACE` | same | unset | Logs the `grid_translate_anchor`, `grid_translate_delta` and `unit` signals around each drag step. |
| `SEL_MOD` | same | unset | Wraps vega's `modify` expression function, logs each call (group, dataset, row count before/after) and prints the `modlog` per case. |
| `SEL_NOFRESH` | same | unset | Skips vega's fresh-render snapshot, so a difference cannot be classified as `retained` and shows as a failure. |
| `SEL_MAX` | same | 6 | How many problems are printed per failing case. |
| `SEL_DUMP`, `SEL_DUMP_AT`, `SEL_DUMP_DIR` | same | unset, 0, `<os tmpdir>/aster-vl-selections-dump` | `SEL_DUMP` (any value) writes `sel-vega.svg`, `sel-aster.svg` and `sel-vega-fresh.svg` for step `SEL_DUMP_AT` into `SEL_DUMP_DIR`, which is created if missing; the script prints the directory. Each case overwrites the previous one's files, so combine it with `--filter`. |

### Scripts and test hooks

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `ASTER_BUDGET_IGNORE_SIDE_EFFECTS` | `packages/benchmarks/scripts/budget.mjs` | unset | `1` bundles as if the packages declared no `sideEffects` field. The bundle rows must then FAIL; `scripts/bundle-shaking.test.mjs` uses it to prove the budget watches tree-shaking. |
| `ASTER_SHAKE_ENV` | `scripts/check-bundle-shaking.mjs` | `{}` | Set by the script itself: the JSON argument its generated runner passes to the bundled pattern module. Do not set it. |
| `ASTER_VERIFY_PUBLISH_ROOT`, `ASTER_VERIFY_PUBLISH_PACKER` | `scripts/verify-publish.mjs` | the repository root, `pnpm` | Test hooks of `scripts/verify-publish.test.mjs`: a copy of the repository to verify, and the packer (`npm` proves the `workspace:` check bites). |
| `ASTER_RELEASE_WORKFLOW` | `scripts/release-workflow.test.mjs` | `.github/workflows/release.yml` | The workflow file the guard reads, so a fault-injected copy can be checked. |
| `FIXTURE` | `packages/conformance/test-fixtures/sweep-fixture.mjs` | `good` | Selects the fixture sweep that `packages/conformance/scripts/run-sweep.test.mjs` runs through `run-sweep.ts`. |
| `GITHUB_ACTIONS` | `scripts/gates.mjs` | unset | `true` wraps each gate's output in `::group::` lines. |
| `STEPS`, `GITHUB_STEP_SUMMARY` | `scripts/nightly-summary.mjs` (nightly workflow) | unset | `STEPS` (`${{ toJSON(steps) }}`) is required, else exit 2; when `GITHUB_STEP_SUMMARY` is set the table is appended to it. |

## 4. `sweep-values`

`pnpm --filter @aster/conformance run sweep-values` runs `packages/conformance/src/run-sweep.ts values` over
`packages/conformance/src/sweeps/values.mjs`. It is the value sweep: one small chart per (journey, column of values), 20 journeys
(a scale of each family under a mark, the legends, and the transforms that accumulate or format values) by 25 columns of values
that JavaScript treats differently from the obvious reading (a `null`, the word `null`, an empty cell, a word, a boolean, numeric
text, a negative zero, numbers past exact integers, ISO dates, hex, exponent and signed numbers written as text, a list in a
cell, `Infinity` written out...). Every other sweep varies the specification and holds the data still; this one holds the specification still and varies the
column. Cases are named `<journey>--<column>`. Like the other sweeps it renders each case with real vega and with Aster and compares
the SVG; `--floor`, `--min-ok` and `--max-node-error` are required, and `--filter <substring>` selects cases.

It has no root script, is not in the gate list and is not run by `nightly.yml`; no document mentioned it before this page. To run it:

```bash
pnpm --filter @aster/conformance run sweep-values --floor 500 --min-ok 1 --max-node-error 0
```

`values.mjs` emits each case as `specText` (the chart as JSON text, so that a negative zero survives), and `run-sweep.ts` parses it
with `JSON.parse` into the case's `spec` before anything is rendered. A generated case with neither a `spec` object nor a `specText`
that parses to an object fails the run before it renders anything, so the sweep cannot go back to reading every case as "both
refused" and checking nothing.

Run as above, it generates 500 cases and reports `482 ok, 18 differ` (no both-refused, node-error or engine-error), and exits 1
because of the 18. The 18 differences are open and unscheduled: 15 are in the `time-line` journey (including its `plain` control,
where Aster draws a tick line vega does not), and one each are `band-over-the-values` and `point-over-the-values` with
`with-a-list-in-a-cell` and `gradient-legend` with `with-infinity-written-out`. Whether they are Aster defects or sweep-spec
problems has not been investigated. This sweep is not a gate and not part of the nightly run, so nothing tracks them; the floors on the command line above are
placeholders, not committed ratchets.

## 5. Related

- [TESTING.md](TESTING.md): what every suite proves, with the last measured results.
- Every script here takes `--help` (usage and the script's header comment, exit 0) and refuses an option it does not declare (exit 2); 1 means the check failed: [TESTING.md](TESTING.md#command-line-options-and-exit-codes).
- [packages/vl/CONTRIBUTING.md](../packages/vl/CONTRIBUTING.md): where the Vega-Lite compiler's contract is implemented and tested.
- [ERRORS.md](ERRORS.md) for what an error message at run time means; [FONTS.md](FONTS.md) for text metrics.
