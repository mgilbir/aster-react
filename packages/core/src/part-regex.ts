/** The static screen of regular expressions, put in its slot (see engine-parts.ts and limits.ts, which refuses every pattern without it). */
import { installPart, type EngineParts } from './engine-parts.js'
import { regexHazard } from './regex-screen.js'

export const part: EngineParts['regex'] = { regexHazard }
installPart('regex', part)
