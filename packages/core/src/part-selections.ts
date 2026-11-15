/** vega-selections' expression functions, put in their slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { selectionIdTest, selectionResolve, selectionTest, selectionTuples } from './selections.js'

export const part: EngineParts['selections'] = { selectionTest, selectionIdTest, selectionResolve, selectionTuples }
installPart('selections', part)
