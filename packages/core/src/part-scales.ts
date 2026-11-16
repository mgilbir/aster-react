/** The scale types besides linear, ordinal, band, point and the calendar ones, put in their slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import {
  diverging, divergingLog, divergingPow, divergingSqrt, divergingSymlog, identityScale, log, pow, sequential, sequentialLog, sequentialPow,
  sequentialSqrt, sequentialSymlog, sqrt, symlog,
} from './scale-warped.js'
import { binOrdinal, quantileScale, quantize, threshold } from './scale-classes.js'

export const part: EngineParts['scales'] = {
  log, pow, sqrt, symlog, identityScale, sequential, sequentialLog, sequentialPow, sequentialSqrt, sequentialSymlog,
  diverging, divergingLog, divergingPow, divergingSqrt, divergingSymlog, quantileScale, quantize, threshold, binOrdinal,
}
installPart('scales', part)
