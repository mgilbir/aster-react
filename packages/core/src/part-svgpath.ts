/** The SVG path reader (custom symbol shapes, the bounds of path strings), put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { drawnPathCommands, renderSvgPath, svgPathCommands } from './path-data.js'

export const part: EngineParts['svgpath'] = { svgPathCommands, drawnPathCommands, renderSvgPath }
installPart('svgpath', part)
