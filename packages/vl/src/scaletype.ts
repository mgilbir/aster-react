/**
 * The scale type of a field on a channel that is not a position: the one it asked for (a request the channel or the data cannot use has
 * already been dropped from the field, see scaleTypeFits), else the one its data type gives it on that channel.
 *
 * The same answer is needed where a scale is built and where a mark reads through it: a band scale is read at the middle of its bands.
 */

/** The part of a field definition the scale type depends on. */
export interface ScaleTyped {
  type: string
  bin?: unknown
  tu?: { utc?: boolean }
  scale?: { type?: unknown }
}

const COLOUR = new Set(['color', 'fill', 'stroke'])
/** The channels whose values are a list of marks, not a range: a field of any type has an ordinal scale there. */
const LISTED = new Set(['shape', 'strokeDash'])

export const isDiscreteDataType = (type: string): boolean => type === 'nominal' || type === 'ordinal'

export function nonPositionScaleType(channel: string, f: ScaleTyped): string {
  if (f.scale?.type !== undefined) return String(f.scale.type)
  if (LISTED.has(channel)) return 'ordinal'
  if (COLOUR.has(channel)) {
    if (isDiscreteDataType(f.type)) return 'ordinal'
    if (f.type === 'temporal') return 'time'
    return f.bin ? 'bin-ordinal' : 'linear'
  }
  if (isDiscreteDataType(f.type)) return 'point'
  if (f.type === 'temporal') return f.tu?.utc ? 'utc' : 'time'
  return 'linear'
}
