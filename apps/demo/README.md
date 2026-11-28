# @aster-charts/demo

A single-page gallery and playground that renders Aster next to the official Vega toolchain. It is the fastest way to see the
project work. The package is private (`"private": true`) and is not published to npm.

## What it shows

Every comparison card feeds the same spec to both engines: the official `vega-embed` on the left (loaded lazily, so the Aster
column paints first), `<Chart>` from `@aster-charts/react` on the right. A Vega-Lite spec is compiled by `@aster-charts/vl` for the Aster column (`<Chart>` with `@aster-charts/react/vl`) and by the official `vega-lite` inside `vega-embed` for the oracle column: the two compilers are what the cards compare.

The page (`src/App.tsx`) has these sections:

- **Reactive dataflow** -- a live per-datum update through `dataChanges` (one point changes every 700 ms) and hover tooltips.
- **Streaming** -- the same append stream into an SVG and a canvas `ChartStream`.
- **Spec playground** -- paste any Vega or Vega-Lite spec and see both engines render it.
- **New in this build**, **Selections, maps and animation**, **Gallery** -- the same spec in both engines. The first two take their
  specs from `packages/conformance/corpus` (imported from there, all fourteen: each is a corpus spec, compared with real vega / vega-lite by
  the gates), the gallery from `src/specs.ts`.

The page header states no measured figure (a number written into a page goes stale: it had 1,055 conformance specs, 205 kB and a corpus of "400+" when the corpus had 1,063 and `<Chart>` was 190 kB); `scripts/docs-claims.test.mjs` fails if one comes back. The repository docs ([README](../../README.md),
[docs/TESTING.md](../../docs/TESTING.md), [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md)) are the source for current figures.

The cards are written as an app should write them: every `<Chart>` sits under a `<Suspense>` boundary (`AsterSuspense` in `src/App.tsx`),
because a chart that needs a part of the engine suspends once in a browser build ([ADR 0011](../../docs/adr/0011-engine-parts-load-on-demand-in-browser-builds.md)); `dataChanges` is made where the rows are
(`LiveDataChanges`); a size prop is passed only where the spec has a number (a concat or facet view is sized by its content); and the brush of
the brush card is the spec's own interval parameter, not the older `brush` / `onSelect` props.

## Run it

From the repository root, after `pnpm install`. The demo imports `@aster-charts/core`, `@aster-charts/react` and `@aster-charts/vl` through their
`exports`, which point at `dist`, so build the packages first:

```bash
pnpm build
pnpm --filter @aster-charts/demo dev
```

Vite serves the app at <http://localhost:5173/>. After a change to a package source, run `pnpm build` again: the dev server reads
the built `dist`, not `src`.

Other scripts of the package:

| Command | What it does |
|---|---|
| `pnpm --filter @aster-charts/demo typecheck` | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter @aster-charts/demo build` | `vite build` into `apps/demo/dist` (ignored by git) |

`build` builds none of the packages it imports (a second `tsc` of `@aster-charts/react` would race the other workspaces that read its `dist`); `@aster-charts/core`, `@aster-charts/vl` and `@aster-charts/react` must already be built, which `pnpm build` at the root does in dependency order.

## Build and deployment

`vite build` writes a static site to `apps/demo/dist`. `wrangler.toml` describes it as a Cloudflare Workers static-assets
deployment:

```toml
name = "aster-charts-demo"
compatibility_date = "2025-04-01"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

`wrangler` (^4) is a devDependency of the package, so the tool is installed with `pnpm install`. The assets directory is the Vite
output and unknown paths fall back to `index.html`. Nothing in this repository runs a deploy: no package script, no workflow in
`.github/workflows/`. A deploy is a manual step of whoever owns the Cloudflare account (`wrangler` reads `wrangler.toml` and needs
that account's login), run after a build. `pnpm-workspace.yaml` explains why the `workerd` download is disabled: it is only
needed for `wrangler dev`, never for a static-assets deploy.
