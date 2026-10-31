/**
 * Which way a mark runs: `vertical` (the value is read off the y axis, the marks stand on the x axis) or `horizontal`. Only the marks that
 * draw a value along an axis have one; a point, an arc or a rect is `vertical` by convention, and some encodings leave a bar or a tick
 * with none (two axes that are neither measures).
 *
 * The orientation is decided from what each position channel is, by a short run of rules that are tried in turn; the first one that has
 * an answer gives it. Which rules a mark runs, and in which order, is the one table in this file:
 *
 *   binned        a channel whose field is already binned is the dimension
 *   leadingValue  an aggregate on one axis alone is the value
 *   rangedBar     a bar between two values on an axis is oriented along it (the orient asked for wins)
 *   segment       a span on both axes is a segment, which has no orientation
 *   ranged        a span on one axis is oriented along it (y first)
 *   alone         a rule that spans one axis alone runs along the other
 *   measures      the orient asked for; else the axis that is a measure is the value; else the time axis is the dimension
 */

export type Orientation = 'vertical' | 'horizontal'

/** What the rules read of one position channel. */
export interface Position {
  /** The channel is encoded at all (a field, a datum or a value). */
  present: boolean
  /** It is defined by a field (or a datum). */
  field: boolean
  aggregate: boolean
  /** The field is already binned: its values are where the bins start. */
  prebinned: boolean
  /** The values are measured: a quantitative field that is not binned, or a number. */
  measure: boolean
  temporal: boolean
}

export interface OrientInput {
  x: Position
  y: Position
  /** x2 / y2 are encoded. */
  x2: boolean
  y2: boolean
  /** The orient the mark, its style or the config asks for. */
  asked: string | undefined
}

/** The mark has no orientation, as opposed to a rule having nothing to say. */
const NONE = Symbol('no orientation')
type Verdict = string | typeof NONE | undefined
type Rule = (mark: string, c: OrientInput) => Verdict

const binned: Rule = (_m, { x, y }) => (x.field && x.prebinned ? 'vertical' : y.field && y.prebinned ? 'horizontal' : undefined)

const leadingValue: Rule = (_m, { x, y }) => {
  if (x.field && y.field && y.aggregate && !x.aggregate) return 'vertical'
  if (x.field && y.field && x.aggregate && !y.aggregate) return 'horizontal'
  return undefined
}

const rangedBar: Rule = (_m, { x2, y2, asked }) => {
  if (!x2 && !y2) return undefined
  if (asked) return asked
  return !x2 ? 'vertical' : !y2 ? 'horizontal' : undefined
}

const segment: Rule = (_m, { x2, y2 }) => (x2 && y2 ? NONE : undefined)

const ranged: Rule = (_m, { x2, y2 }) => (y2 ? 'vertical' : x2 ? 'horizontal' : undefined)

const alone: Rule = (_m, { x, y }) => (x.present && !y.present ? 'vertical' : y.present && !x.present ? 'horizontal' : undefined)

const measures: Rule = (mark, { x, y, asked }) => {
  if (asked) return asked
  // (a tick stands across the value, where a bar or a line runs along it)
  if (x.measure !== y.measure) return x.measure === (mark === 'tick') ? 'vertical' : 'horizontal'
  if (x.measure) return 'vertical'
  if (x.temporal !== y.temporal) return x.temporal ? 'vertical' : 'horizontal'
  return undefined
}

const BAR_RULES: readonly Rule[] = [binned, leadingValue, rangedBar, segment, ranged, measures]

/** The rules each mark runs. A mark that is not here has no orientation to decide. */
const RULES: ReadonlyMap<string, readonly Rule[]> = new Map([
  ['bar', BAR_RULES],
  ['text', BAR_RULES],
  ['rule', [segment, ranged, alone, measures]],
  ['area', [ranged, measures]],
  ['line', [measures]],
  ['tick', [measures]],
])

/** The orientation of `mark` for what its position channels are; `undefined` when the encoding leaves it none. */
export function orientationOf(mark: string, input: OrientInput): string | undefined {
  const rules = RULES.get(mark)
  if (rules === undefined) return 'vertical'
  for (const rule of rules) {
    const verdict = rule(mark, input)
    if (verdict !== undefined) return verdict === NONE ? undefined : verdict
  }
  return undefined
}
