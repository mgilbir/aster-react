/** The scheduler of `timer` event streams, put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { timers } from './timer.js'

export const part: EngineParts['timer'] = { timers }
installPart('timer', part)
