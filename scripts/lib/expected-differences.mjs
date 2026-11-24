/**
 * The one table of known differences between Aster and an oracle that a gate tolerates.
 *
 * There is no other exclusion mechanism in the gates: no skip list in a script, no `delete` in a generator, no "browser only"
 * flag that drops a case. An entry here is not a skip: the case is still compared on every run, and `runGate`
 * (run-gate.mjs) requires that it STILL DIFFERS. When a fix makes it agree, the gate fails with `FIXED-GAP` until the entry
 * is removed; when a case named here is no longer compared on a full run (renamed, deleted), the gate fails with `STALE-GAP`.
 * So the table can only ever name live differences, and each one carries the reason it is not a defect of Aster's (or the
 * finding that tracks it).
 *
 * `gate` is the gate's name in scripts/gates.mjs; `case` the case name the gate reports.
 * Adding an entry to make a gate pass is the kind of exclusion the project forbids: an entry needs evidence that the ORACLE's
 * output is undefined or wrong for that case, written in `reason`.
 *
 * @type {ReadonlyArray<{ gate: string, case: string, reason: string }>}
 */
export const EXPECTED_DIFFERENCES = Object.freeze([
  {
    gate: 'geometry-browser',
    case: "view-not-finite",
    reason:
      "an item whose bounds reach an infinity makes vega's view infinite (its origin and its size are Infinity), and then its "
      + "canvas picks on coordinates that are not numbers (every bounds test passes) and its SVG is translated by an attribute "
      + "the browser rejects (and so by none). Such a view has no pointer position that means anything: Aster's index, which "
      + "places every item in the view's own frame, finds nothing there.",
  },
  {
    gate: 'geometry-browser',
    case: "svg-attribute-rejected",
    reason:
      "vega writes the number JavaScript prints into an SVG attribute (NaN, Infinity, a size below 0, a number beyond single "
      + "precision, a CSS unit that is not one of the attribute's), and what the browser does with an attribute it rejects is "
      + "its own repair, not vega's: `width` below 0 is `auto` (the bitmap's size), `NaN` is 0, a rejected `transform` is none, "
      + "a path is drawn up to its first number that is none. The element's attributes (its own, or those of a group above it) "
      + "say so.",
  },
  {
    gate: 'geometry-browser',
    case: "svg-text-glyphs",
    reason:
      "the browser hit-tests an SVG text by its glyph cells, vega's canvas pick by the text's box: vega's two renderers "
      + "disagree there (the points where they do are not counted), and Aster's index answers with the box -- one of the two.",
  },
  {
    gate: 'geometry-browser',
    case: "canvas-group-one-axis-not-a-number",
    reason:
      "a group item whose x (or y) is a string that is not a number and whose other position is a number (`\"15px\"`, 32): "
      + "vega's canvas draws the group untranslated (a translate that is not two numbers is ignored) and asks its bounds on the "
      + "axis that is a number and not on the other; Aster's index drops the bounds test on both axes there, and measures what "
      + "it keeps in the frame it draws in.",
  },
  {
    gate: 'geometry-browser',
    case: "canvas-beyond-float-precision",
    reason:
      "a canvas keeps its path in 32-bit floats: beyond 2^24 a coordinate cannot tell one pixel from the next (a rect 71 high "
      + "at 1e15 has no height there), and vega's pick asks the canvas; Aster tests in doubles.",
  },
  {
    gate: 'test',
    case: 'mark-role-config-vs-vega: a group mark whose role starts with axis, legend or title',
    reason:
      "vega's ViewLayout reads a child's role: a GROUP mark that says `role: axis` (or `legend`, `title`, and the prefixed `axis-label` ...) is "
      + "laid out as that guide (half-pixel offset, the legend grid, the title anchor) and its role-axis container carries the axis caption. "
      + "Aster lays out only the guides it generates from `axes`, `legends` and `title`; an authored group is drawn in place. Not a "
      + "function of anything a chart author writes for a guide (C205).",
  },
  {
    gate: 'test',
    case: 'mark-role-config-vs-vega: a data mark whose role is exactly axis',
    reason:
      "vega's axis layout takes a data mark whose role is `axis` as the guide and offsets it by half a pixel (`M13.5,13.5L..` against "
      + "`M13,13L..`); Aster does not read the role of an authored mark for layout (C205).",
  },
  {
    gate: 'test',
    case: 'mark-role-config-vs-vega: a data mark whose role is legend, in a chart with a legend',
    reason:
      "vega's ViewLayout gathers a data mark with `role: legend` with the legends and places it on the legend grid (the chart's own "
      + "legend moves, the view grows by the grid); Aster's legend layout reads only the legends it generated (C205).",
  },
  {
    gate: 'test',
    case: 'mark-role-config-vs-vega: a data mark whose role is frame or scope, in a chart with a legend and a title',
    reason:
      "vega's ViewLayout unions a `frame` or `scope` child's bounds into both anchor bounds and drops the guides' placement against it "
      + "(the view is 132x82 where Aster's is 174x99); Aster places the legend against the plot as it does for any data mark (C205).",
  },
  {
    gate: 'test',
    case: 'mark-role-config-vs-vega: a stroked area whose role is frame, scope, legend or title',
    reason:
      "vega's parser makes such a stroked area a layout container: its stroke does not grow the view as it does for every other role "
      + "(height 82 against 84); Aster grows the view by the stroke (C205).",
  },
  {
    gate: 'test',
    case: 'guide-null-vs-vega: a legend layout parameter nulled in the config',
    reason:
      "`config.legend.gridAlign`, `rowPadding`, `columnPadding` or `gradientLength` = null: vega-parser writes `undefined` into the "
      + "expression of the legend's entry layout and `vega.parse` throws `Unrecognized signal name: \"undefined\"` (a defect of the "
      + "parser, not a refusal anyone wrote); Aster reads a null config value as no value and renders the legend with its defaults (C310).",
  },
  {
    gate: 'test',
    case: 'guide-encode-vs-vega: a list of styles on a title group or subtitle',
    reason:
      "`encode.group.style` or `encode.subtitle.style` given as a list of two styles on a title: vega-parser concatenates the list into "
      + "an expression (`nullnull`) and `vega.parse` throws `Unrecognized signal name: \"nullnull\"`; Aster applies the styles of the "
      + "list in order, as it does for every other mark (C310).",
  },
])
