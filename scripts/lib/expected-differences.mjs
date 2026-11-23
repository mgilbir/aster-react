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
    gate: 'canvas',
    case: 'area-gradient',
    reason: "the spec's fill is the string 'gradient' (no colour, no gradient object): vega's canvas assigns fillStyle='gradient', "
      + 'which a canvas ignores (an invalid colour leaves the previous value), so what vega paints depends on the fillStyle earlier '
      + "items left behind, not on the spec (view.scenegraph() item.fill === 'gradient'). The SVG gates compare this entry strictly.",
  },
])
