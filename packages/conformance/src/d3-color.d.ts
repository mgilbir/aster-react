// d3-color ships no types and @types/d3-color is not a dependency; this is the
// subset normalize.ts uses.
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
}
