/**
 * The scale constructors, by family: `scale-continuous.ts` (identity, linear, power, log, symlog and the sequential and
 * diverging colour scales), `scale-calendar.ts` (time and UTC) and `scale-discrete.ts` (ordinal, band, point and the
 * discretizing scales). This module is the one place that names them all; the registry in `scale.ts` imports from it, and
 * the generated differential of the quantile-style scales imports the constructors from here.
 */
export type { ScaleObject } from './scale-continuous.js'
export {
  diverging,
  divergingLog,
  divergingPow,
  divergingSqrt,
  divergingSymlog,
  identityScale,
  linear,
  log,
  pow,
  sequential,
  sequentialLog,
  sequentialPow,
  sequentialSqrt,
  sequentialSymlog,
  sqrt,
  symlog,
  tickFormatFor,
} from './scale-continuous.js'
export { time, utcTime } from './scale-calendar.js'
export { band, bandSpace, binOrdinal, implicit, ordinal, point, quantileScale, quantize, sequentialQuantile, threshold } from './scale-discrete.js'
