# Contributing

Prerequisites:

- **Node `^22.22.2 || ^24.15.0 || >=26`** (the root `engines`; `.nvmrc` names the version the maintainers use). This is the range the
  `jsdom` dev dependency supports, and pnpm 11 needs at least 22.13, so an older 22.x, 23.x, 24.0 to 24.14 or 25.x can install but not run
  `pnpm test`. The published packages support Node 20 (their `engines`); CI executes their built `dist` and React on it
  (`scripts/dist-node-smoke.test.mjs`), but you do not develop on it.
- **pnpm as pinned by `packageManager` in `package.json`**. Node 25 and later no longer bundle corepack: install it with
  `npm install --global pnpm@<the pinned version>` (or `corepack enable` where corepack exists, or the `pnpm/action-setup` action in CI).
- `pnpm install`, then **`pnpm build`**: the tests and several gates read the built `dist` of the packages, so `pnpm test` on a tree that
  was not built fails.
- **Playwright Chromium** for the browser gates (command below). `pnpm install` and `playwright install --with-deps` need the network; the
  gates themselves run offline (`verify-publish` installs the packed tarballs into a scratch project from the local files).

`pnpm check` runs 26 gates in sequence, and a complete run takes on the order of an hour on a laptop: a full build (including the demo's
Vite build), the whole vitest suite, the time-zone matrix, packaging, the Vega and Vega-Lite oracle gates, a 10,000-point benchmark with
floors, the bundle and size checks, and seven Chromium gates. Each gate has its own deadline (`timeoutMs` in `scripts/gates.mjs`); one that
hangs is killed and reported as `FAIL <gate> (timeout)`. While iterating, run one gate (`pnpm check -- --only conformance`) or a tag
(`--only browser`, `--skip browser`) and the whole list before opening the PR.

Aster Charts is verified against the real Vega renderer. Before opening a PR,
run the full gate list from the repository root:

```bash
pnpm check
```

The gate list lives in one place, [`scripts/gates.mjs`](scripts/gates.mjs), and
CI runs `pnpm check` on every push to `main` (and nothing on a branch or pull request: `scripts/gates.test.mjs` pins the trigger), so run it
before you merge. A green local run is a green `ci` job, but `ci.yml` has a second job a local run does not reproduce: `unit`, the
unit tests on Node 20 (the engine-sensitive suites and the dist smoke test), 22 and the newest major. Do not copy
the list anywhere else: `scripts/gates.test.mjs` fails if `ci.yml` runs anything beyond `pnpm check`, the toolchain setup and the Node-matrix unit tests, or if a
code block of this file or docs/TESTING.md has a line that is a gate's command; `scripts/docs-single-source.test.mjs` fails if a
paragraph of any other doc (outside docs/TESTING.md and docs/RUNBOOK.md, which tabulate results) names four or more gates. `pnpm check -- --list`
prints the gates with the reason for each. The browser gates need Chromium
(`pnpm --filter @aster-charts/conformance exec playwright install --with-deps chromium`);
`pnpm check -- --skip browser` skips them locally, but that is not the CI list.

When a gate is red, [docs/RUNBOOK.md](docs/RUNBOOK.md) covers debugging one failing corpus spec end to end, the stale-`dist`
refusals, and every environment variable the harness reads. Changing the Vega-Lite compiler: see
[packages/vl/CONTRIBUTING.md](packages/vl/CONTRIBUTING.md).

The heavier schema sweeps, the value sweep and fuzzing run nightly (see
[docs/TESTING.md](docs/TESTING.md)); run them yourself when you touch the
Vega-Lite compiler or expression/transform semantics.

Guidelines:

- Keep `@aster-charts/core`, `@aster-charts/react` and `@aster-charts/vl` free of `vega-*`/`d3-*`/`topojson-*`
  dependencies and imports; the dependency boundary (`pnpm check:deps`) enforces this on the
  sources and on the built `dist`.
- When you port an algorithm or table from an upstream project, add that project's `LICENSE` text to
  `THIRD_PARTY_NOTICES.md` (`scripts/notices.test.mjs` checks the texts against `node_modules`).
- Add a conformance corpus spec (or a unit/oracle-vector test) for every fixed
  behaviour. `packages/conformance/probes` is for known gaps; promote a probe
  to `corpus/` when it passes.
- Update `README.md` and `docs/ROADMAP.md` when a gate or known limitation
  changes. A number in the docs (counts, sizes, speedups) must come from a command you ran on the
  tree being documented, with the command written next to it.
- Do not commit generated `dist/` output or ad-hoc debug scripts.
