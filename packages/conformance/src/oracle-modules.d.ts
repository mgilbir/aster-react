// The oracle's own packages that ship no types and have no @types in this repository. The differentials import them to run the
// real implementation next to Aster's; their members are untyped on purpose (the differential checks the values, not the types).
// A package with types (vega, vega-lite, d3-color's subset in d3-color.d.ts) does not belong here.
declare module 'd3-array'
declare module 'd3-contour'
declare module 'd3-dsv'
declare module 'd3-format'
declare module 'd3-geo'
declare module 'd3-shape' {
  type Setter<D, Self> = (value?: number | string | boolean | object | null | ((d: D, i: number, data: D[]) => unknown)) => Self
  /** The chainable setters every generator has: a constant or an accessor of a datum in, the generator out. */
  interface Chain<D, Self> {
    x: Setter<D, Self>; x0: Setter<D, Self>; x1: Setter<D, Self>
    y: Setter<D, Self>; y0: Setter<D, Self>; y1: Setter<D, Self>
    defined: Setter<D, Self>; curve: Setter<D, Self>; context: Setter<D, Self>; digits: Setter<D, Self>
    startAngle: Setter<D, Self>; endAngle: Setter<D, Self>; padAngle: Setter<D, Self>; padRadius: Setter<D, Self>
    innerRadius: Setter<D, Self>; outerRadius: Setter<D, Self>; cornerRadius: Setter<D, Self>
  }
  /** `line()` and `area()`: called on the points they return the path text (or null). */
  export interface Generator<D> extends Chain<D, Generator<D>> { (data: Iterable<D> | ArrayLike<D>): string | null }
  /** `arc()`: called on one datum. */
  export interface ArcGenerator<D> extends Chain<D, ArcGenerator<D>> { (datum: D): string | null }
  export function arc<D = any>(): ArcGenerator<D>
  export function area<D = any>(): Generator<D>
  export function line<D = any>(): Generator<D>
  /** The curve factories (`curveLinear`, `curveBasis`, ...); passed to `.curve()` as they are. */
  export const curveLinear: object
  export const curveMonotoneX: object
  export const curveMonotoneY: object
}
declare module 'd3-time'
declare module 'd3-time-format'
declare module 'topojson-client'
declare module 'vega-format'
declare module 'vega-scale'
declare module 'vega-time'
