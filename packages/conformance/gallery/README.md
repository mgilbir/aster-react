# Official Vega and Vega-Lite example galleries

`pnpm conformance:gallery` renders every example of the official galleries through real vega (the oracle) and through Aster, by both
paths a user takes, and compares the canonical SVG exactly (`src/normalize.ts`, no tolerance):

| path   | oracle                                                         | Aster                                                                                                          |
|--------|----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| static | vega in Node (`vega-lite` compiles first for Vega-Lite)        | `loadSpecData` + `renderSpec` (`@aster/vl` compiles Vega-Lite)                                                 |
| react  | the same vega in headless Chromium, in a 600 x 400 host        | `<Chart>` mounted as an app would: `@aster/react/vl`, **no** add-on imported (`<Chart>` loads geo / transforms itself, and the page checks it loaded exactly what the spec needs), data through `loadSpecData`, **no** size props unless the (compiled) spec has numeric top-level `width` / `height` |

Both read the data from the pinned `vega-datasets` package (3.2.1, the version both repositories' lockfiles use) through one offline
`fetch`; the browser page has every request routed to disk or aborted. There is no network at test time.

## The specs are fetched, not committed

| source      | tag     | commit                                     | files (`*.vg.json` / `*.vl.json`)        |
|-------------|---------|--------------------------------------------|------------------------------------------|
| vega/vega   | v6.3.1  | `c42b7bad10730383c780f7769768b8b64bc0052a` | `docs/examples/` (93)                    |
| vega/vega-lite | v6.4.3 | `f4bb2188709204860329aff2aeaf678c0280c315` | `examples/specs/` (627; `normalized/` is not part of it) |

```
pnpm --filter @aster/conformance gallery:fetch              # download what is missing into packages/conformance/.gallery/ (gitignored), verify all
pnpm --filter @aster/conformance gallery:fetch -- --verify  # verify only, no network
pnpm --filter @aster/conformance gallery:fetch -- --regenerate   # maintainers: re-list the pinned commits and rewrite manifest.json
```

`manifest.json` (committed) lists every file with its sha256. Files are downloaded from `raw.githubusercontent.com` **at the commit**
(a tag can move, a SHA cannot); any checksum mismatch fails the fetch and removes the file; files already present and verified are
skipped. The gate verifies the whole cache against the manifest before it reads a spec and, if the cache is missing or altered,
fails naming the fetch command (it never skips). `.gallery/` also holds each repository's `LICENSE`. Data files that are not in
`vega-datasets` were looked for in vega's `docs/data`; the only two it has beyond the package (`points.json`,
`platformer-terrain.txt`) are not referenced by any example, so nothing is fetched besides the specs. Three examples (`point_constant_legend_domain`,
`selection_type_point_zorder`, `stocks-2009-layered-line-point`) reference `cars.json` / `stocks.csv` through the jsDelivr copy of
`vega-datasets@v1.29.0`; both the harness and the browser page resolve those two names to the pinned 3.2.1 files.

### Licence

Vega and Vega-Lite are BSD-3-Clause. The examples are used unmodified for conformance testing and are not redistributed by this
repository; the fetched copies carry the upstream `LICENSE` next to them in the cache, and the notices are kept here:

```
Copyright (c) 2015-2023, University of Washington Interactive Data Lab
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Vega-Lite's copyright line differs (`Copyright (c) 2015, University of Washington Interactive Data Lab.`), the terms are the same.

## Outcomes

Every spec ends in exactly one of:

* `pass` - the canonical SVGs are equal.
* `fail` - they differ. Printed with the first diff (`first`) and the first diff that says WHAT differs (`->`: for a structure
  diff the oracle/aster line pair).
* `error` - Aster (or `@aster/vl`) threw, or its SVG could not be canonicalised.
* `unverifiable` - the **oracle** cannot be compared: it is not a function of its inputs even with the gate's determinism (below), or
  vega itself fails. Always listed with the reason; never counted as a pass; capped by a ceiling. Today that is only the specs whose
  oracle needs a canvas Node lacks (`oracle-needs-canvas`: heatmap, label, wordcloud transforms); on the React path, in Chromium,
  nothing is unverifiable.

### Determinism: the same randomness and the same clock for both engines

A spec that draws random numbers or reads the time is compared exactly, not skipped.

* **Randomness.** Every render gets a fresh copy of ONE seeded generator (`src/gallery/seeded.ts`, mulberry32). Vega gets it through
  `setRandom` (what `random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`, the `sample` transform, the bootstrap `ci0` /
  `ci1`, `randomKDE` and the wordcloud layout read) and as `Math.random` (the call sites that read it directly); the stale
  Box-Muller pair vega keeps in a module variable is drained first. Aster gets it as `RuntimeInput.random` / `<Chart random>`.
  Aster consumes it in vega's order and count, so any difference left is a real divergence
  (`scripts/differential-random.test.mts` pins the order and count against live vega).
* **Time, static path.** `Date.now` and `performance.now` are frozen for both engines; the first frame is compared.
* **Time, React path.** The page's clock is replaceable (`src/gallery/virtual-clock.ts`, installed before d3-timer binds
  `requestAnimationFrame`). A spec with a `timer` stream or `now()` runs on a virtual clock for BOTH engines: they start together at
  virtual time 0, the same callbacks fire in the same order as it advances, and the frame at 1300 virtual ms is compared (an
  oracle that differs between two such renders is `oracle-nondeterministic`). Waits on real I/O (vega's image-ready poll) stay on the
  real clock.

Nothing is tolerated silently: all `fail` and `error` lines are printed. The runs are deterministic (four consecutive runs gave
identical outcomes for all 720 specs on both paths).

## The ratchet

* `floors.json` - passing count per path and grammar (may only go up) and the unverifiable ceiling (may only go down). The one
  exception so far: the React ceiling went from 7 / 10 to 11 / 12 when time-dependent oracles started to be measured
  (`vega/clock`, `pacman`, `watch`, `donut-chart-labelled`, `vl/animated_gapminder`, `animated_hop`: each was a fail or an error
  on that path, or hung; none was a pass). They are still checked on the static path, where the first frame is what is compared.
* `passing-static.txt`, `passing-react.txt` - the specs that pass today; each must still pass (a count floor alone lets a fix hide
  a regression).
* the number of specs read must equal the manifest.

When the numbers improve the gate says so: raise `floors.json` and regenerate the lists with
`pnpm conformance:gallery --print-passing` (run it, review the diff, commit). Never lower a floor.

It is **not** in `scripts/gates.mjs` (so `pnpm check` stays hermetic and needs no fetch): it takes about 90 s and needs the cache,
so it runs in `.github/workflows/nightly.yml` after a cached fetch.

## The spec-swap path

Every other path mounts fresh. This one holds a mounted chart to what a fresh mount shows when its `spec` PROP CHANGES (a playground
re-rendering one `<Chart>`): ONE `<Chart>` is given spec A, runs for a moment (its timers tick, the pointer moves, presses and
releases over it), is given spec B, settles, and the canonical SVG is compared with a fresh mount of B and with vega's B. The pairs
are the COMMITTED list `swap-pairs.txt` (one `A => B` per line), made once by the seeded selection in `src/gallery/swap-pairs.ts`: the three a playground user reported, timer /
selection / facet / map specs both as the spec left behind and as the one that follows, and a seeded remainder (223 pairs; B is
always a spec the react path passed when the list was made, so equal to a fresh mount means equal to vega). The gate reads only
that file, so other changes to the passing lists do not change the sample. A pair whose B no longer passes a fresh mount (or whose spec left the
gallery) is SKIPPED with a reason and listed in the output -- never a swap regression, the static and react ratchets own that. The ratchet
(`floors.json` `swap`): every runnable pair must pass and equal vega's B, at least `minRunnable` pairs must be runnable (the sample cannot
erode silently), unverifiable ceiling. `pnpm conformance:gallery --regenerate-swap-pairs` rewrites the list deliberately (review the diff). It is reported apart
from the fresh-mount counts, and runs after the other paths (a load-dependent timeout of a data load would otherwise decide it).
On origin/main 187 of the 223 pairs passed; the rest left the old chart's elements, timers or state behind.

## Triage

`TRIAGE.md` is the snapshot of why each non-passing spec does not pass; `triage.json` is the same per spec;
`scripts/gallery-triage.mts` regenerates them (`pnpm conformance:gallery --json=out.json` first).
