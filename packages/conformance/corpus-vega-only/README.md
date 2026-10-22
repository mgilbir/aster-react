# corpus-vega-only

Vega-Lite specs that `conformance-vl` checks against **real vega only**.

Every spec here is held to the same bar as `corpus/` in real vega: `@aster/vl`
compiles a deep-frozen copy, the emitted Vega raises no vega error or warning
(beyond what vega-lite's own output raises), and real vega renders it to the
same canonical SVG as vega-lite's output. What they skip is the last check,
"Aster's runtime renders our Vega like the reference", because Aster's runtime
cannot yet render **vega-lite's own output** for these shapes (so the check
would fail on the reference, not on `@aster/vl`):

- wrapped facets (`facet: {field}` + `columns`): the header groups driven by
  `sequence` datasets and `layout.columns`;
- grid / nested concat and repeat layouts: group-level `layout` positioning of
  child groups with axes and titles (offsets differ by a pixel or two, or the
  root is mis-sized);
- shared legends and child titles inside those layouts.

Each file name is the case; none of them is excluded from the real-vega gate.
When the runtime renders the reference correctly, move the file to `corpus/`.
