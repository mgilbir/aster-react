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
    case: 'differential-transforms: dotbin: empty',
    reason:
      "dotbin over no rows: vega's transform reads the extent of a pulse that has none and throws an incidental `Cannot read "
      + "properties of null (reading 'map')` (a crash, not a refusal anyone wrote); Aster answers with no rows, which is what a "
      + "binning of nothing is (C130, C470).",
  },
  {
    gate: 'test',
    case: 'differential-nest: generate with no keys over 1 rows',
    reason:
      "nest with `generate` and no keys: vega gives the root row the dataset's own output array as `values` and the root is a row of "
      + "that array, so it holds itself (length rows + 1); Aster's root holds the rows (length rows), nothing cyclic. Vega's aliasing, "
      + "invisible to a chart, and Aster's tree is the one that can be walked (C470).",
  },
  {
    gate: 'test',
    case: 'differential-nest: generate with no keys over 2 rows',
    reason:
      "nest with `generate` and no keys: vega gives the root row the dataset's own output array as `values` and the root is a row of "
      + "that array, so it holds itself (length rows + 1); Aster's root holds the rows (length rows), nothing cyclic. Vega's aliasing, "
      + "invisible to a chart, and Aster's tree is the one that can be walked (C470).",
  },
  {
    gate: 'test',
    case: 'differential-nest: generate with no keys over 5 rows',
    reason:
      "nest with `generate` and no keys: vega gives the root row the dataset's own output array as `values` and the root is a row of "
      + "that array, so it holds itself (length rows + 1); Aster's root holds the rows (length rows), nothing cyclic. Vega's aliasing, "
      + "invisible to a chart, and Aster's tree is the one that can be walked (C470).",
  },
  {
    gate: 'test',
    case: 'differential-transforms: bin: extent omitted',
    reason:
      "bin without `extent`: vega refuses (`Missing required \"bin\" parameter: \"extent\"`); Aster derives the extent from the "
      + "data, a documented extension that the Vega-Lite compiler's output never needs and a hand-written spec may use (C748).",
  },
  {
    gate: 'test',
    case: 'differential-transforms: countpattern: tokens named like Object.prototype members',
    reason:
      "countpattern keeps its token counts in a plain object in vega, so a token named `constructor` or `__proto__` reads an "
      + "inherited member and its count is garbage; Aster counts such tokens as data (a null-prototype table), which is the "
      + "count anyone would expect (C748).",
  },
])
