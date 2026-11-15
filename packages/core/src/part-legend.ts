/** The legend builder, put in its slot (see engine-parts.ts). Imported by the entries that evaluate, and on demand by the React shells. */
import { installPart, type EngineParts } from './engine-parts.js'
import { buildLegend, entriesRefusal, legendType, placeLegendStack } from './guide-legend.js'
import './part-svgpath.js' // (a legend draws its gradient and its symbols from path data)

export const part: EngineParts['legend'] = { buildLegend, entriesRefusal, legendType, placeLegendStack }
installPart('legend', part)
