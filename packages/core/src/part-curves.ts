/** The curves of a line or an area besides `linear`, put in their slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { FAMILIES } from './curves.js'

export const part: EngineParts['curves'] = { families: FAMILIES }
installPart('curves', part)
