/** The SVG path reader (custom symbol shapes, the bounds of path strings), put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { renderSvgPath, svgPathCommands } from './svg-path.js'

export const part: EngineParts['svgpath'] = { svgPathCommands, renderSvgPath }
installPart('svgpath', part)
