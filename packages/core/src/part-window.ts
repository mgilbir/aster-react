/** The `window` transform, put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { windowRows } from './transform-window.js'

export const part: EngineParts['window'] = { windowRows }
installPart('window', part)
