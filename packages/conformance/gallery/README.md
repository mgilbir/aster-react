# Official Vega and Vega-Lite example galleries

`pnpm conformance:gallery` renders every example of the official galleries through real vega (the oracle) and through Aster, by both
paths a user takes, and compares the canonical SVG exactly (`src/normalize.ts`, no tolerance):

| path   | oracle                                                         | Aster                                                                                                          |
|--------|----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| static | vega in Node (`vega-lite` compiles first for Vega-Lite)        | `loadSpecData` + `renderSpec` (`@aster/vl` compiles Vega-Lite)                                                 |
| react  | the same vega in headless Chromium, in a 600 x 400 host        | `<Chart>` mounted as an app would: `@aster/react/vl`, `@aster/core/geo` + `/transforms`, data through `loadSpecData`, **no** size props unless the (compiled) spec has numeric top-level `width` / `height` |

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
* `unverifiable` - the **oracle** cannot be compared: it is not a function of its inputs (it renders differently when rendered
  twice: `random()`, bootstrap / sample transforms, timers) or vega itself fails (vega's heatmap needs a canvas on Node). Always
  listed with the reason; never counted as a pass; capped by a ceiling.

Nothing is tolerated silently: all `fail` and `error` lines are printed. The runs are deterministic (four consecutive runs gave
identical outcomes for all 720 specs on both paths).

## The ratchet

* `floors.json` - passing count per path and grammar (may only go up) and the unverifiable ceiling (may only go down).
* `passing-static.txt`, `passing-react.txt` - the specs that pass today; each must still pass (a count floor alone lets a fix hide
  a regression).
* the number of specs read must equal the manifest.

When the numbers improve the gate says so: raise `floors.json` and regenerate the lists with
`pnpm conformance:gallery --print-passing` (run it, review the diff, commit). Never lower a floor.

It is **not** in `scripts/gates.mjs` (so `pnpm check` stays hermetic and needs no fetch): it takes about 90 s and needs the cache,
so it runs in `.github/workflows/nightly.yml` after a cached fetch.

## Triage

`TRIAGE.md` is the snapshot of why each non-passing spec does not pass; `triage.json` is the same per spec;
`scripts/gallery-triage.mts` regenerates them (`pnpm conformance:gallery --json=out.json` first).
