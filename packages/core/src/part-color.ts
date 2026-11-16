/** The engine's colour family, put in its slot (see engine-parts.ts): the colour spaces, their interpolators and the scheme ramps. */
import { installPart, type EngineParts } from './engine-parts.js'
import { contrastRatio, hcl, hsl, lab, luminance, rgb } from './color.js'
import {
  interpolateCubehelix, interpolateCubehelixLong, interpolateHcl, interpolateHclLong, interpolateHsl, interpolateHslLong, interpolateLab,
  interpolateRgb, interpolateRgbBasis, interpolateRgbBasisClosed, interpolateText, isColor,
} from './interp-color.js'
import { rampScheme } from './color-schemes.js'

export const part: EngineParts['color'] = {
  rgb, hsl, lab, hcl, luminance, contrastRatio, interpolateText, interpolateRgb, isColor, rampScheme,
  interpolators: new Map<string, unknown>(Object.entries({
    Cubehelix: interpolateCubehelix, CubehelixLong: interpolateCubehelixLong, Hcl: interpolateHcl, HclLong: interpolateHclLong,
    Hsl: interpolateHsl, HslLong: interpolateHslLong, Lab: interpolateLab, Rgb: interpolateRgb, RgbBasis: interpolateRgbBasis,
    RgbBasisClosed: interpolateRgbBasisClosed,
  })),
}
installPart('color', part)
