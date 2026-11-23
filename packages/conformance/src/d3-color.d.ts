// d3-color ships no types and @types/d3-color is not a dependency; this is the
// subset normalize.ts and the d3-color differential (scripts/differential-color.test.mts) use.
declare module 'd3-color' {
  export interface RGBColor {
    r: number
    g: number
    b: number
    opacity: number
  }
  export interface Color {
    rgb(): RGBColor
    formatHex(): string
  }
  export function color(specifier: string): Color | null
  /** The colour spaces: each takes a specifier, a colour or channels, and returns a colour (or one with NaN channels). */
  type Space = (...args: unknown[]) => Record<string, unknown>
  export const rgb: Space
  export const hsl: Space
  export const lab: Space
  export const gray: Space
  export const hcl: Space
  export const lch: Space
  export const cubehelix: Space
}
