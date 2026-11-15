/** The pulse path of the incremental engine, put in its slot (see engine-parts.ts): what re-derives a dataset from a change of its rows. */
import { installPart, type EngineParts } from './engine-parts.js'
import { applyPipelineWithPulse } from './incremental-engine.js'

export const part: EngineParts['pulse'] = { applyPipelineWithPulse }
installPart('pulse', part)
