# Roadmap

Aster React is the browser/React member of the Aster family. Like [`aster`](https://github.com/mgilbir/aster) (Go)
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

`@aster/core`, `@aster/react` and `@aster/vl` have no dependency on `vega-*`, `d3-*` or `topojson-*`.
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
| `vega-scale`, `d3-scale`, `d3-array`, `d3-interpolate`, `internmap`, `d3-scale-chromatic` | `src/arr.ts`, `src/interp.ts`, `src/scale-d3.ts`, `src/scale.ts`, `src/scale-schemes.ts` |
| `vega-parser` / `vega-encode` scale parsing | `src/scales.ts` |
| `d3-geo`, `d3-geo-projection`, `vega-projection` | `src/geo-lib.ts`, `src/geo-projections.ts`, `src/geo.ts` |
| `d3-contour` | `src/contour.ts` |
| `vega-transforms`, `vega-statistics`, `vega-hierarchy`, `vega-geo`, `vega-regression`, `vega-label`, `delaunator`/`d3-delaunay` | `src/transform*.ts` |
| `vega-scenegraph` bounds and SVG path machinery | `src/bounds.ts`, `src/svg-path.ts`, `src/render.ts` |
| `vega-view` layout, `vega-event-selector`, `vega-runtime` signal loop | `src/trellis.ts`, `src/event-selector.ts`, `src/signals.ts`, `src/runtime.ts` |
| `vega-dataflow`'s observable evaluation order for the event-driven signals (modelled, not ported) | `src/signal-propagation.ts` |
| `vega-wordcloud`, `d3-cloud` | `src/wordcloud.ts` |

Licences of everything ported: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### Vega-Lite: `@aster/vl` compiles it, with an explicit refusal list

`@aster/vl` compiles Vega-Lite to Vega with no dependency on `vega-lite`. For every feature it either produces Vega
that renders like vega-lite 6.4.3 (`pnpm conformance-vl` renders the corpus through `@aster/vl` and diffs it against
vega-lite's output, and the emitted Vega is also run through real vega) or throws a `VLCompileError` naming the
feature. The refusal list is in [packages/vl/README.md](../packages/vl/README.md).

### Conformance rigour: in place

The oracle gates are the `pnpm check` list ([TESTING.md](TESTING.md)): the SVG corpus, the Vega-Lite corpus, the scene
differential, guide captions, the transform matrix, the three schema sweeps, differential fuzzing with committed
reproducers, oracle vectors (incl. a time-zone matrix), and the real-browser gates (corpus with live text metrics,
canvas pixels in Chromium, Firefox and WebKit nightly, batched-SVG pixels, signal event streams, React interaction).
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

**Not done: publishing.** Nothing has been published. The registry scope, the protected `npm-release` environment and
the tag are the owner's steps ([RELEASE.md](RELEASE.md)).

---

## 2. Open work

Each item is something the code or the gates show today; none is a plan that has not been checked against them.

- **Vega-Lite coverage.** What `@aster/vl` refuses today (selections on a layer spec itself, maps,
  the `time` channel, data-driven `strokeDash` / `angle` / `fillOpacity` / `strokeOpacity`, pre-binned data,
  `timeUnit.maxbins`, `scale: null`, some composition nestings, horizontal boxplots, argmin/argmax transform ops, ...).
- **Signals sweep.** Cases where real Vega's second render differs from its own fresh render (the `retained`
  status) are a documented deviation, not a fix; the gate has a ceiling that can only be lowered.
- **Word clouds.** `wordcloud` is vega-wordcloud / d3-cloud, drawn on the host's canvas as vega does; without a host
  canvas (Node) the words are boxes of their measured width, a cloud no browser draws.
- **Known interaction limits.** A zoomed stream-fed chart keeps the last unzoomed base extent until the view is
  reset; pan/zoom picks the first continuous scale per orientation in the root scope only
  ([INTERACTION.md](INTERACTION.md)).
- **Probes.** `packages/conformance/probes` holds two probes; both pass today and can be promoted into `corpus/`.
- **Streaming transport.** The host owns the network and decides when to flush.
- **Release.** Registry scope, `npm-release` environment with reviewers and `NPM_TOKEN` (or trusted publishing),
  version bump and tag ([RELEASE.md](RELEASE.md)).

---

## 3. Method (how a port is made safe)

Record, implement, replay, swap, ban:

1. **Record.** A `gen-*.mjs` script uses the real dependency to emit input to output vectors, including edge
   cases (`packages/conformance/scripts`, output in `packages/core/testdata`).
2. **Implement** the replacement behind the same internal API, as a transcription of the upstream code (surprising
   upstream behaviour is reproduced and pinned, not tidied).
3. **Replay.** A unit test asserts exact equality against the vectors, independent of the browser and the SVG oracle,
   so a failure is localised to one library.
4. **Swap and delete.** Flip the import, remove the dependency.
5. **Ban it.** `pnpm check:deps` fails on any banned import or dependency.

The SVG corpus, the scene differential, the sweeps and the fuzzer then check the whole pipeline against the same oracle.

## 4. Definition of done

1. The three packages have no runtime dependency on `vega-*`, `d3-*` or `topojson-*`; a gate enforces it. **Met.**
2. They render Vega and Vega-Lite directly, matching upstream property for property and scene for scene. **Met for
   the gates' corpus and sweeps; the exceptions are the open items above.**
3. Schema sweeps and recorded upstream vectors cover the language, not a fixture list. **Met** (three sweeps, vectors per library).
4. SVG and canvas render the same scene and pass the same differential; there is no PDF/PNG workstream. **Met.**
5. `<Chart>` is idiomatic React: either grammar, SSR/hydration, async data, declarative select/pan/zoom/tooltip and a
   positioned accessibility tree on both backends. **Met.**
6. Untrusted specs are bounded in time and memory and fail with typed errors. **Met with the documented caveats**
   ([LIMITS.md](LIMITS.md): native regular-expression calls are not interruptible without a worker).
7. Packages publish to npm with docs, changelog and licence. **Packaged and verified; not published.**

## 5. Keeping this document honest

A claim here is either a pointer to a gate or a command, or it is in "Open work". When a gate result changes, the
number is updated in TESTING.md or PERFORMANCE.md (with its command), not copied here. When an open item is closed,
it moves out of section 2 in the same change.
