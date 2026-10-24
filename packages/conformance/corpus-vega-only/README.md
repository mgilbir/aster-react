# corpus-vega-only

Vega-Lite specs that `conformance-vl` checks against **real vega only**.

Every spec here is held to the same bar as `corpus/` in real vega: `@aster/vl` compiles a
deep-frozen copy, the emitted Vega raises no vega error or warning (beyond what vega-lite's own
output raises), and real vega renders it to the same canonical SVG as vega-lite's output
(strict canonicalizer, paint order included). What they skip is the last check, "Aster's runtime
renders our Vega like the reference": Aster cannot yet render **vega-lite's own output** for
them, so that check would fail on the reference, not on `@aster/vl`.

This directory is empty: every case that lived here (50 of them, each with the root cause measured
in the table that used to be here) now renders correctly in Aster and was moved to `corpus/` with its
content unchanged.

A case belongs here only while Aster cannot yet render vega-lite's own Vega for it. When one is added, record
the measured root cause per case (the first strict difference of Aster against real vega on vega-lite's own
Vega; `0` means the SVG matches and a gate other than the SVG diff fails), and move the file to `corpus/`
as soon as the runtime renders the reference correctly: the gates say so (move it, run `pnpm check`).
