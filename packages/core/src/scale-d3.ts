/**
 * The scale constructors, by family: `scale-continuous.ts` (identity, linear, power, log, symlog, the sequential and
 * diverging colour scales, and time and UTC) and `scale-discrete.ts` (ordinal, band, point and the discretizing scales). This
 * module only names them together; the registry in `scale.ts` imports the families directly, and the generated differential
 * of the quantile-style scales imports its constructors from here.
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
  time,
  utcTime,
} from './scale-continuous.js'
export { band, bandSpace, binOrdinal, implicit, ordinal, point, quantileScale, quantize, sequentialQuantile, threshold } from './scale-discrete.js'
