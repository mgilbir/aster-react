# corpus-vega-only

Vega-Lite specs that `conformance-vl` checks against **real vega only**.

Every spec here is held to the same bar as `corpus/` in real vega: `@aster/vl` compiles a
deep-frozen copy, the emitted Vega raises no vega error or warning (beyond what vega-lite's own
output raises), and real vega renders it to the same canonical SVG as vega-lite's output
(strict canonicalizer, paint order included). What they skip is the last check, "Aster's runtime
renders our Vega like the reference": Aster cannot yet render **vega-lite's own output** for
them, so that check would fail on the reference, not on `@aster/vl`.

Each file is here for a measured reason (first strict difference of Aster against real vega on
vega-lite's own Vega; `0` means the SVG matches and a gate other than the SVG diff fails):

| cases | root cause in the runtime |
|---|---|
| `concat-*`, `vconcat-layer`, `repeat-columns`, `repeat-in-concat`, `repeat-row-layer-child` | group `layout` of concat/repeat children: child groups, grid cells and the root size differ (a nested concat is measured as 10x10 or 10x510) |
| `facet-wrap`, `facet-wrap-sized-spec`, `facet-encoding-wrap-transform`, `facet-layer`, `facet-nested-field`, `facet-row-col-color`, `facet-in-concat` | wrapped / layered facets: header and cell placement, axis ticks per cell; `facet-in-concat` throws (`reading 'data'`) |
| `hdr-*` (label anchor / orient, `labels: false`, title anchor) | facet header placement beyond the defaults |
| `concat-shared-color*`, `resolve-concat-color-shared` | shared legends in compositions |

When the runtime renders the reference correctly, move the file to `corpus/`; the gates will
say so (move it, run `pnpm check`).
