# Roadmap

Aster Charts is the browser/React member of the Aster family. Like [`aster`](https://github.com/mgilbir/aster) (Go)
and [`aster-kotlin`](https://github.com/mgilbir/aster-kotlin) (Kotlin), it **reimplements the Vega and Vega-Lite
languages and their rendering from scratch**, so that it draws what upstream draws, while being idiomatic and fast
inside a React app. The real `vega` and `vega-lite` packages are the **oracle**: a dev-only reference the tests
compare against. They do not ship, and neither do their dependencies (`d3-*`, `topojson-client`, ...).

**Scope.** The deliverables are SVG and canvas output and interaction that is idiomatic in React. Raster (PNG) and
PDF export are out of scope; a browser component composes into a page and a host can rasterize the SVG or canvas
itself.

This document records what is done, what is open, and how claims are kept honest. It carries no measured numbers:
corpus counts, sweep results, bundle sizes and benchmark ratios are in [TESTING.md](TESTING.md) and
[PERFORMANCE.md](PERFORMANCE.md), each next to the command that produced it. The design is in
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. State

### Own the runtime: done

`@aster-charts/core`, `@aster-charts/react` and `@aster-charts/vl` have no dependency on `vega-*`, `d3-*` or `topojson-*`.
`pnpm check:deps` (`scripts/check-deps.mjs`) fails on any banned import or dependency in the sources or in the built
`dist`; the per-package `dep-baseline.json` files are empty. Each replaced library was recorded as oracle vectors
from the pinned upstream package, implemented behind the same internal API, replayed, and then swapped in:

| Upstream | Owned replacement |
|---|---|
| `vega-util` | `src/util.ts` |
| `d3-color` | `src/color.ts` |
| `vega-time`, `d3-time` | `src/time.ts` |
| `vega-format`, `d3-format`, `d3-time-format` | `src/format.ts`, `src/time-format.ts`, `src/locale.ts` |
| `vega-expression`, `vega-interpreter`, the `vega-functions` surface | `src/expr-parser.ts`, `src/expr-interpreter.ts`, `src/expression.ts` |
| `d3-dsv`, `topojson-client` | `src/dsv.ts`, `src/topojson.ts` |
| `d3-shape`, `d3-path` | `src/shape.ts`, the arc/path code in `src/render.ts` |
| `vega-scale`, `d3-scale`, `d3-array`, `d3-interpolate`, `internmap`, `d3-scale-chromatic` | `src/arr.ts`, `src/interp.ts`, `src/scale.ts`, `src/scale-continuous.ts`, `src/scale-discrete.ts`, `src/scale-d3.ts`, `src/scale-schemes.ts` |
| `vega-parser` / `vega-encode` scale parsing | `src/scales.ts`, `src/scale-domain.ts` |
| `d3-geo`, `d3-geo-projection`, `vega-projection` (behaviour matched bit for bit; own design: geometry event buffers, see ARCHITECTURE) | `src/geo-events.ts`, `src/geo-sphere.ts`, `src/geo-sphere-measures.ts`, `src/geo-clip.ts`, `src/geo-resample.ts`, `src/geo-path.ts`, `src/geo-raw.ts`, `src/geo-projections.ts`, `src/geo.ts` |
| `d3-contour` | `src/contour.ts` |
| `vega-transforms`, `vega-statistics`, `vega-hierarchy`, `vega-geo`, `vega-regression`, `vega-label`, `delaunator`/`d3-delaunay` | `src/transform*.ts`, `src/delaunay.ts`, `src/voronoi.ts`, `src/orient.ts` |
| `vega-scenegraph` bounds and SVG path machinery (behaviour matched; the bounds code is Aster's own structure, see ARCHITECTURE) | `src/bounds.ts`, `src/bounds-pen.ts`, `src/svg-path.ts`, `src/render.ts` |
| `vega-view` and `vega-view-transforms` layout, `vega-parser` guides (behaviour matched; own design: grid core over boxes, axes by frame), `vega-event-selector`, `vega-runtime` signal loop | `src/trellis.ts`, `src/guide-encode.ts`, `src/guide-axis.ts`, `src/guide-legend.ts`, `src/guide-title.ts`, `src/event-selector.ts`, `src/signals.ts`, `src/runtime.ts` |
| `vega-dataflow`'s observable evaluation order for the event-driven signals (modelled, not ported) | `src/signal-propagation.ts` |
| `vega-wordcloud`, `d3-cloud` | `src/wordcloud.ts` |

Licences of everything ported: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### Vega-Lite: `@aster-charts/vl` compiles it, with an explicit refusal list

`@aster-charts/vl` compiles Vega-Lite to Vega with no dependency on `vega-lite`. For every feature it either produces Vega
that renders like vega-lite 6.4.3 (`pnpm conformance-vl` renders the corpus through `@aster-charts/vl` and diffs it against
vega-lite's output, and the emitted Vega is also run through real vega) or throws a `VLCompileError` naming the
feature. The refusal list is in [packages/vl/README.md](../packages/vl/README.md).

### Conformance rigour: in place

The oracle gates are split between the PR gate and the nightly workflow ([TESTING.md](TESTING.md#what-runs-where)). `pnpm check` (the
PR gate, and the only gate of a release tag) runs the gate list in [`scripts/gates.mjs`](../scripts/gates.mjs); `pnpm check -- --list`
prints each gate with what it asserts. The nightly workflow adds what is too slow for a PR, listed in TESTING.md.
The canonicalizer is strict and each normalization is justified in `packages/conformance/src/normalize.ts`.

### Rendering targets, interaction, React idioms, production: done

- SVG string renderer, incremental DOM patcher and canvas renderer over one scene; append painting; dense marks.
- Hit index, controlled/uncontrolled selection and pan/zoom over scale `domainRaw`, the `signal.on` event loop,
  keyboard navigation and an accessibility tree on both backends ([INTERACTION.md](INTERACTION.md)).
- `<Chart>`/`useChart` accept Vega or Vega-Lite; Suspense data; SSR and strict hydration; worker offload with a
  synchronous fallback; streams with bounded queues ([API.md](API.md)).
- Untrusted-spec bounds and a URL policy ([LIMITS.md](LIMITS.md)), typed errors ([ERRORS.md](ERRORS.md)).
- Three publishable packages with a verified tarball ([RELEASE.md](RELEASE.md)); licence, contributing guide,
  changelog and third-party notices.

**Published.** 0.1.0 is on npm under the `aster-charts` org (`@aster-charts/core`, `@aster-charts/react`,
`@aster-charts/vl`), published with provenance by the tag-triggered release workflow ([RELEASE.md](RELEASE.md)).

---

## 2. Open work

Each item is something the code or the gates show today; none is a plan that has not been checked against them.

- **Vega-Lite coverage.** What `@aster-charts/vl` still refuses is listed in
  [packages/vl/README.md](../packages/vl/README.md#throws-not-supported), which a test holds to the compiler.
- **Signals sweep.** The `retained` cases ([INTERACTION.md](INTERACTION.md#signals)) are a documented deviation, not a
  fix; the gate has a ceiling that can only be lowered.
- **Word clouds.** `wordcloud` is vega-wordcloud / d3-cloud, drawn on the host's canvas as vega does; without a host
  canvas (Node) the words are boxes of their measured width, a cloud no browser draws.
- **Known interaction limits.** A zoomed stream-fed chart keeps the last unzoomed base extent until the view is
  reset; pan/zoom picks the first continuous scale per orientation in the root scope only
  ([INTERACTION.md](INTERACTION.md)).
- **Probes.** `packages/conformance/probes` holds two probes; both pass today and can be promoted into `corpus/`.
- **Streaming transport.** The host owns the network and decides when to flush.
- **Release.** Move publishing from the `NPM_TOKEN` secret to npm trusted publishing now that the packages exist, and
  add required reviewers to the `npm-release` environment ([RELEASE.md](RELEASE.md)).

---

## 3. Method (how a port is made safe)

Implement, compare, swap, ban. The comparison is recorded only where the result does not depend on the JavaScript engine,
and live (real upstream and Aster in one process) everywhere else ([TESTING.md](TESTING.md#oracle-vectors)):

1. **Implement** the replacement behind the same internal API, as a transcription of the upstream code (surprising
   upstream behaviour is reproduced and pinned, not tidied).
2. **Compare.** Libraries whose results are engine-independent (vega-util, d3-color, d3-format / vega-format, vega-time,
   d3-dsv, topojson-client) are replayed against vectors a `gen-*.mjs` script recorded from the pinned upstream
   (`packages/conformance/scripts`, output in `packages/core/testdata`), with exact equality, independent of the browser and
   the SVG oracle. Libraries that go through `Math.pow/exp/log`, the trig functions or `sqrt` (not bit-identical across V8
   versions), and the spec-level suites, are live differentials: real upstream and Aster run in one process on identical
   inputs and are compared strictly (see "Why live" in TESTING.md). Either way a failure is localised to one library.
3. **Swap and delete.** Flip the import, remove the dependency.
4. **Ban it.** `pnpm check:deps` fails on any banned import or dependency.

The SVG corpus, the scene differential, the sweeps and the fuzzer then check the whole pipeline against the same oracle.

## 4. Definition of done

1. The three packages have no runtime dependency on `vega-*`, `d3-*` or `topojson-*`; a gate enforces it. **Met.**
2. They render Vega and Vega-Lite directly, matching upstream property for property and scene for scene. **Met for
   the gates' corpus and sweeps; the exceptions are the open items above.**
3. Schema sweeps and recorded upstream vectors cover the language, not a fixture list. **Met** (four sweeps: Vega, Vega-Lite, signals and values; vectors per library).
4. SVG and canvas render the same scene and pass the same differential; there is no PDF/PNG workstream. **Met.**
5. `<Chart>` is idiomatic React: either grammar, SSR/hydration, async data, declarative select/pan/zoom/tooltip and a
   positioned accessibility tree on both backends. **Met.**
6. Untrusted specs are bounded in time and memory and fail with typed errors. **Met with the documented caveats**
   ([LIMITS.md](LIMITS.md): native regular-expression calls are not interruptible without a worker).
7. Packages publish to npm with docs, changelog and licence. **Met** (0.1.0).

## 5. Keeping this document honest

A claim here is either a pointer to a gate or a command, or it is in "Open work". When a gate result changes, the
number is updated in TESTING.md or PERFORMANCE.md (with its command), not copied here. When an open item is closed,
it moves out of section 2 in the same change.
