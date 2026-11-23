/**
 * The scale constructors, by family: `scale-continuous.ts` (linear), `scale-warped.ts` (identity, power, log, symlog, the sequential
 * and diverging colour scales), `scale-calendar.ts` (time and UTC), `scale-discrete.ts` (ordinal, band, point) and `scale-classes.ts`
 * (bin-ordinal and the discretizing scales). This
 * module only names them together; the registry in `scale.ts` imports the families directly, and the generated differential
 * of the quantile-style scales imports its constructors from here.
 */
export type { ScaleObject } from './scale-continuous.js'
export { linear, tickFormatFor } from './scale-continuous.js'
export {
  diverging,
  divergingLog,
  divergingPow,
  divergingSqrt,
  divergingSymlog,
  identityScale,
  log,
  pow,
  sequential,
  sequentialLog,
  sequentialPow,
  sequentialSqrt,
  sequentialSymlog,
  sqrt,
  symlog,
} from './scale-warped.js'
export { time, utcTime } from './scale-calendar.js'
export { band, bandSpace, implicit, ordinal, point } from './scale-discrete.js'
export { binOrdinal, quantileScale, quantize, sequentialQuantile, threshold } from './scale-classes.js'
