/** The row transforms of transform-basic.ts, put in their slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { binRows, collectRows, extentOfField, flattenRows, foldRows, identifierRows, imputeRows, lookupRows, projectRows, sampleRows, sequenceRows, stackRows } from './transform-basic.js'

export const part: EngineParts['reshape'] = { collectRows, sampleRows, foldRows, flattenRows, projectRows, extentOfField, sequenceRows, lookupRows, imputeRows, stackRows, identifierRows, binRows }
installPart('reshape', part)
