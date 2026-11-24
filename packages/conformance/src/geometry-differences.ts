/**
 * The differences between Aster's pick and vega's that `conformance:geometry` (scripts/browser-geometry.mts) knows and tolerates.
 *
 * This is not a skip list. Every point the gate compares is still compared; a difference is told apart from a defect by naming what
 * the ORACLE is doing there, and the gate then holds it to three rules:
 *
 *   - every difference belongs to one of the classes below (one that does not is a failure: a new difference, or a bug);
 *   - a class needs evidence in the difference itself (a value the oracle's own scenegraph or DOM holds), never the name of a spec or a
 *     seed, and never "the browser only": a predicate reads the items, the groups above them and the oracle's element;
 *   - a class that no difference falls into any more has been fixed: the gate fails (`FIXED-GAP`) until its entry is removed, so the
 *     table can only name differences that still exist (the expected-differences rule of lane a18's branch, which this table is to be
 *     moved onto when the two are stacked).
 *
 * Each class says why the difference is not a defect of Aster's: the oracle's answer there is not a function of the spec that vega
 * and a browser agree on (an attribute SVG rejects and the browser repairs in its own way, glyph cells, a view of no size), or it is
 * a limit of Aster's hit index that the class names.
 */

/** What the gate knows of one side of a difference: the item vega (or Aster, by its place in vega's scenegraph) picked. */
export interface Side {
  /** The mark type of the item. */
  type: string
  /** The raw `x`, `y`, `width`, `height` of each group item above the item, innermost first. */
  groups: ReadonlyArray<readonly unknown[]>
  /** The item's own bounds as vega measured them, raw. */
  bounds: readonly unknown[]
  /** The attributes of the item's SVG element and of the elements above it that SVG does not take as written (svg only). */
  rejected: readonly string[]
}

/** One decisive point where Aster and vega answer differently. */
export interface Difference {
  renderer: 'svg' | 'canvas'
  /** The view's origin, as vega computed it (an item whose bounds reach an infinity makes it infinite). */
  origin: readonly [number, number]
  /** The view's size, as vega computed it. */
  size: readonly [number, number]
  /** The item vega picked (null: nothing), and the item Aster picked, as vega's scenegraph holds it. */
  vega: Side | null
  aster: Side | null
}

export interface KnownDifference {
  id: string
  renderer: 'svg' | 'canvas' | 'both'
  reason: string
  matches(d: Difference): boolean
}

/** Single precision (2^24): beyond it a canvas path's floats cannot tell one pixel from the next. */
const FLOAT_EXACT = 2 ** 24

const sides = (d: Difference): Side[] => [d.vega, d.aster].filter((s): s is Side => s !== null)
const number = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
/** Whether a value a scenegraph holds reads as a number the way an arithmetic does: not a string like "15px", not NaN. */
const reads = (v: unknown): boolean => v === undefined || v === null || !Number.isNaN(+(v as number))

export const KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  {
    id: 'view-not-finite',
    renderer: 'both',
    reason:
      "an item whose bounds reach an infinity makes vega's view infinite (its origin and its size are Infinity), and then its canvas picks on "
      + 'coordinates that are not numbers (every bounds test passes) and its SVG is translated by an attribute the browser rejects (and so by none). '
      + "Such a view has no pointer position that means anything: Aster's index, which places every item in the view's own frame, finds nothing there.",
    matches: (d) => !d.origin.every(Number.isFinite) || !d.size.every(Number.isFinite),
  },
  {
    id: 'svg-attribute-rejected',
    renderer: 'svg',
    reason:
      'vega writes the number JavaScript prints into an SVG attribute (NaN, Infinity, a size below 0, a number beyond single precision, a CSS unit '
      + "that is not one of the attribute's), and what the browser does with an attribute it rejects is its own repair, not vega's: `width` below 0 "
      + 'is `auto` (the bitmap\'s size), `NaN` is 0, a rejected `transform` is none, a path is drawn up to its first number that is none. '
      + 'The element\'s attributes (its own, or those of a group above it) say so.',
    matches: (d) => sides(d).some((s) => s.rejected.length > 0),
  },
  {
    id: 'svg-text-glyphs',
    renderer: 'svg',
    reason:
      "the browser hit-tests an SVG text by its glyph cells, vega's canvas pick by the text's box: vega's two renderers disagree there (the "
      + "points where they do are not counted), and Aster's index answers with the box -- one of the two.",
    matches: (d) => sides(d).some((s) => s.type === 'text'),
  },
  {
    id: 'canvas-group-one-axis-not-a-number',
    renderer: 'canvas',
    reason:
      "a group item whose x (or y) is a string that is not a number and whose other position is a number (`\"15px\"`, 32): vega's canvas "
      + 'draws the group untranslated (a translate that is not two numbers is ignored) and asks its bounds on the axis that is a number and '
      + "not on the other; Aster's index drops the bounds test on both axes there, and measures what it keeps in the frame it draws in.",
    matches: (d) => sides(d).some((s) => s.groups.some(([x, y]) => (!reads(x) || !reads(y)) && (reads(x) || reads(y)))),
  },
  {
    id: 'canvas-beyond-float-precision',
    renderer: 'canvas',
    reason:
      "a canvas keeps its path in 32-bit floats: beyond 2^24 a coordinate cannot tell one pixel from the next (a rect 71 high at 1e15 has no height "
      + "there), and vega's pick asks the canvas; Aster tests in doubles.",
    matches: (d) =>
      d.origin.some((v) => Math.abs(v) >= FLOAT_EXACT)
      || sides(d).some((s) => s.bounds.some((v) => Math.abs(number(v)) >= FLOAT_EXACT) || s.groups.some((g) => g.some((v) => Math.abs(number(v)) >= FLOAT_EXACT))),
  },
]

/** The id of the first known class a difference falls into, or null. */
export function classify(d: Difference): string | null {
  for (const k of KNOWN_DIFFERENCES) if ((k.renderer === 'both' || k.renderer === d.renderer) && k.matches(d)) return k.id
  return null
}
