/**
 * Which scale properties mean something for a scale. A property the scale has no use for is dropped from the compiled scale, never
 * forwarded: Vega rejects, say, `exponent` on a linear scale.
 *
 * The answer depends on the property, the scale type and, for the colour properties, the channel. It is kept as a table of rows, one
 * per property: the scale types it is for, and the channels it is limited to. A property with no row (the four every scale takes, and
 * any other name) applies everywhere.
 */

/** The scale types that map a continuous domain to a continuous range. */
const CONTINUOUS = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc'] as const
/** The scale types of a position laid out in steps. */
const BANDED = ['band', 'point'] as const
const COLOUR = ['color', 'fill', 'stroke'] as const

interface Row {
  /** The scale types the property is for. */
  types: { readonly only: readonly string[] } | { readonly except: readonly string[] }
  /** The channels the property is limited to; every channel when absent. */
  channels?: readonly string[]
}

const only = (...types: readonly string[]): Row['types'] => ({ only: types })
const except = (...types: readonly string[]): Row['types'] => ({ except: types })

const ROWS = new Map<string, Row>([
  // the domain
  ['domainMin', { types: only(...CONTINUOUS) }],
  ['domainMax', { types: only(...CONTINUOUS) }],
  ['domainRaw', { types: only(...CONTINUOUS) }],
  ['domainMid', { types: only(...CONTINUOUS), channels: COLOUR }],
  ['nice', { types: only(...CONTINUOUS, 'quantize', 'threshold') }],
  ['zero', { types: only('linear', 'pow', 'sqrt', 'symlog', 'quantize') }],
  ['bins', { types: except('point', 'band', 'identity', 'ordinal') }],
  // the shape of a continuous scale
  ['exponent', { types: only('pow') }],
  ['base', { types: only('log') }],
  ['constant', { types: only('symlog') }],
  ['clamp', { types: only(...CONTINUOUS) }],
  // the range
  ['round', { types: only(...CONTINUOUS, ...BANDED) }],
  ['padding', { types: only(...CONTINUOUS, ...BANDED) }],
  ['paddingInner', { types: only('band') }],
  ['paddingOuter', { types: only(...BANDED) }],
  ['align', { types: only(...BANDED) }],
  ['scheme', { types: except('point', 'band', 'identity'), channels: COLOUR }],
  ['interpolate', { types: except('point', 'band', 'identity'), channels: COLOUR }],
])

/** Whether the scale property `prop` applies to a scale of type `type` on `channel`. */
export function scalePropApplies(channel: string, type: string, prop: string): boolean {
  const row = ROWS.get(prop)
  if (row === undefined) return true
  if (row.channels !== undefined && !row.channels.includes(channel)) return false
  return 'only' in row.types ? row.types.only.includes(type) : !row.types.except.includes(type)
}

/** The marks that draw a value along one axis over a dimension on the other. */
const ALONG_AXIS = new Set(['bar', 'area', 'line', 'trail'])

/**
 * Whether a continuous position scale reaches zero when the spec does not say. It does, except on the dimension axis of a mark that is
 * drawn along the other one: the x axis of a vertical bar, area, line or trail, and the y axis of a horizontal one.
 */
export function zeroByDefault(mark: string, channel: string, orient: string): boolean {
  if (!ALONG_AXIS.has(mark)) return true
  return channel !== (orient === 'vertical' ? 'x' : orient === 'horizontal' ? 'y' : undefined)
}
