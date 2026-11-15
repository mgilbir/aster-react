/** The dataset edits of `modify()` and `setdata()`, put in their slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { applyChangeset, newChangeset, planModify } from './modify.js'

export const part: EngineParts['modify'] = { planModify, newChangeset, applyChangeset }
installPart('modify', part)
