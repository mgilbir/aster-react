/** The grid layout of a group's children, put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { layoutFacet } from './trellis.js'

export const part: EngineParts['layout'] = { layoutFacet }
installPart('layout', part)
