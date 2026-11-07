# @aster/demo

A single-page gallery and playground that renders Aster next to the official Vega toolchain. It is the fastest way to see the
project work. The package is private (`"private": true`) and is not published to npm.

## What it shows

Every comparison card feeds the same spec to both engines: the official `vega-embed` on the left (loaded lazily, so the Aster
column paints first), `<Chart>` from `@aster/react` on the right. Vega-Lite specs are compiled by `@aster/vl` for both columns.

The page (`src/App.tsx`) has these sections:

- **Reactive dataflow** -- a live per-datum update through `dataChanges` (one point changes every 700 ms) and hover tooltips.
- **Streaming** -- the same append stream into an SVG and a canvas `ChartStream`.
- **Spec playground** -- paste any Vega or Vega-Lite spec and see both engines render it.
- **New in this build**, **Selections, maps and animation**, **Gallery** -- the same spec in both engines. The first two take their
  specs from `src/showcase/` (nine of its fourteen files are byte-identical to files of `packages/conformance/corpus`), the
  gallery from `src/specs.ts`.

The numbers in the page header (conformance counts, bundle size, frame time) are literal text in `src/App.tsx`. They are not
computed from a run and are not checked by any gate, so treat the repository docs ([README](../../README.md),
[docs/TESTING.md](../../docs/TESTING.md), [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md)) as the source for current figures.

## Run it

From the repository root, after `pnpm install`. The demo imports `@aster/core`, `@aster/react` and `@aster/vl` through their
`exports`, which point at `dist`, so build the packages first:

```bash
pnpm build
pnpm --filter @aster/demo dev
```

Vite serves the app at <http://localhost:5173/>. After a change to a package source, run `pnpm build` again: the dev server reads
the built `dist`, not `src`.

Other scripts of the package:

| Command | What it does |
|---|---|
| `pnpm --filter @aster/demo typecheck` | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter @aster/demo build` | rebuilds `@aster/react` (`tsc`), then `vite build` into `apps/demo/dist` (ignored by git) |

`build` rebuilds only `@aster/react`; `@aster/core` and `@aster/vl` must already be built (`pnpm build` at the root does all three).

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
