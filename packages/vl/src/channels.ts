/** Which marks draw which encoding channels: vega-lite 6.4.3's channel.ts getSupportedMark and encoding.ts markChannelCompatible. */

const ALL_MARK_TYPES = ['arc', 'area', 'bar', 'circle', 'geoshape', 'image', 'line', 'rule', 'point', 'rect', 'square', 'trail', 'text', 'tick']

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** channel.ts getSupportedMark: the marks that draw a channel (`always`), or draw it only for pre-binned data (`binned`). */
function supportedMarks(channel: string): Record<string, 'always' | 'binned'> | undefined {
  const always = (marks: string[]): Record<string, 'always'> => Object.fromEntries(marks.map((m) => [m, 'always' as const]))
  switch (channel) {
    case 'color': case 'fill': case 'stroke': case 'description': case 'detail': case 'key': case 'tooltip': case 'href': case 'order':
    case 'opacity': case 'fillOpacity': case 'strokeOpacity': case 'strokeWidth': case 'facet': case 'row': case 'column':
      return always(ALL_MARK_TYPES)
    case 'x': case 'y': case 'xOffset': case 'yOffset': case 'latitude': case 'longitude': case 'time':
      return always(ALL_MARK_TYPES.filter((m) => m !== 'geoshape'))
    case 'x2': case 'y2': case 'latitude2': case 'longitude2':
      return { ...always(['area', 'bar', 'image', 'rect', 'rule']), circle: 'binned', point: 'binned', square: 'binned', tick: 'binned', line: 'binned', trail: 'binned' }
    case 'size': return always(['point', 'tick', 'rule', 'circle', 'square', 'bar', 'text', 'line', 'trail'])
    case 'strokeDash': return always(['line', 'point', 'tick', 'rule', 'circle', 'square', 'bar', 'geoshape'])
    case 'shape': return always(['point', 'geoshape'])
    case 'text': return always(['text'])
    case 'angle': return always(['point', 'square', 'text'])
    case 'url': return always(['image'])
    case 'theta': case 'radius': return always(['text', 'arc'])
    case 'theta2': case 'radius2': return always(['arc'])
    default: return undefined
  }
}

/**
 * Does `mark` draw `channel` (with `encoding` the rest of the unit's encoding)? A channel it does not draw is dropped, with a warning.
 * (An image mark is compiled as a rect carrying `$image`; the channel table is the image's.)
 */
export function markChannelCompatible(encoding: Record<string, unknown>, channel: string, mark: string, image: boolean): boolean {
  const table = supportedMarks(channel)
  if (!table) return true // (an unknown channel is validate.ts's to reject)
  const supported = table[image ? 'image' : mark]
  if (!supported) return false
  if (supported === 'binned') {
    // circle, point, square and tick only take x2 / y2 when x / y is pre-binned data and they say where the bin ends
    const primary = encoding[channel === 'x2' ? 'x' : 'y']
    const bin = isObject(primary) ? primary.bin : undefined
    return isObject(primary) && typeof primary.field === 'string' && isObject(encoding[channel]) && typeof (encoding[channel] as Record<string, unknown>).field === 'string' && (bin === 'binned' || (isObject(bin) && bin.binned === true))
  }
  return true
}

