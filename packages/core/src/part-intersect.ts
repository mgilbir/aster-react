/** The scene intersection behind `intersect()`, put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { sceneIntersect } from './scene-intersect.js'

export const part: EngineParts['intersect'] = { sceneIntersect }
installPart('intersect', part)
