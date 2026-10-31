const CONTINUOUS_TO_CONTINUOUS = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc'])
const CONTINUOUS_DOMAIN = new Set([...CONTINUOUS_TO_CONTINUOUS, 'quantile', 'quantize', 'threshold'])

/**
 * vega-lite `scaleTypeSupportProperty` + `channelScalePropertyIncompatability`: whether a
 * user scale property means anything for this channel and scale type. An
 * inapplicable one is dropped (vega-lite warns), never forwarded: real vega
 * rejects e.g. `exponent` on a linear scale.
 */
export function scalePropApplies(channel: string, type: string, prop: string): boolean {
  switch (prop) {
    case 'type': case 'domain': case 'reverse': case 'range':
      return true
    case 'scheme': case 'interpolate': case 'domainMid':
      if (channel !== 'color' && channel !== 'fill' && channel !== 'stroke') return false
      return prop === 'domainMid' ? CONTINUOUS_TO_CONTINUOUS.has(type) : !['point', 'band', 'identity'].includes(type)
    case 'bins':
      return !['point', 'band', 'identity', 'ordinal'].includes(type)
    case 'round':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'band' || type === 'point'
    case 'padding':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'point' || type === 'band'
    case 'paddingOuter': case 'align':
      return type === 'point' || type === 'band'
    case 'paddingInner':
      return type === 'band'
    case 'domainMax': case 'domainMin': case 'domainRaw': case 'clamp':
      return CONTINUOUS_TO_CONTINUOUS.has(type)
    case 'nice':
      return CONTINUOUS_TO_CONTINUOUS.has(type) || type === 'quantize' || type === 'threshold'
    case 'exponent': return type === 'pow'
    case 'base': return type === 'log'
    case 'constant': return type === 'symlog'
    case 'zero':
      return CONTINUOUS_DOMAIN.has(type) && !['log', 'time', 'utc', 'threshold', 'quantile'].includes(type)
    default:
      return true
  }
}
