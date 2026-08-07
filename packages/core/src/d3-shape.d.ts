declare module 'd3-shape' {
  export interface CurveFactory {
    (context: unknown): unknown
  }

  export interface Curve {
    lineStart(): void
    lineEnd(): void
    point(x: number, y: number): void
  }

  export interface CurveFactoryWithMethods extends CurveFactory {
    beta?(beta: number): CurveFactoryWithMethods
    tension?(tension: number): CurveFactoryWithMethods
    alpha?(alpha: number): CurveFactoryWithMethods
  }

  export interface Line<Datum> {
    (data: Datum[]): string | null
    x(x: ((d: Datum, i: number, data: Datum[]) => number) | number): this
    y(y: ((d: Datum, i: number, data: Datum[]) => number) | number): this
    defined(defined: ((d: Datum, i: number, data: Datum[]) => boolean) | boolean): this
    curve(curve: CurveFactory): this
    context(context: unknown): this
  }

  export interface Area<Datum> {
    (data: Datum[]): string | null
    x(x: ((d: Datum, i: number, data: Datum[]) => number) | number): this
    y0(y0: ((d: Datum, i: number, data: Datum[]) => number) | number): this
    y1(y1: ((d: Datum, i: number, data: Datum[]) => number) | number): this
    defined(defined: ((d: Datum, i: number, data: Datum[]) => boolean) | boolean): this
    curve(curve: CurveFactory): this
    context(context: unknown): this
  }

  export function line<Datum>(): Line<Datum>
  export function area<Datum>(): Area<Datum>

  export const curveLinear: CurveFactory
  export const curveBasis: CurveFactory
  export const curveBasisClosed: CurveFactory
  export const curveBasisOpen: CurveFactory
  export const curveBundle: CurveFactoryWithMethods
  export const curveCardinal: CurveFactoryWithMethods
  export const curveCardinalClosed: CurveFactoryWithMethods
  export const curveCardinalOpen: CurveFactoryWithMethods
  export const curveCatmullRom: CurveFactoryWithMethods
  export const curveCatmullRomClosed: CurveFactoryWithMethods
  export const curveCatmullRomOpen: CurveFactoryWithMethods
  export const curveLinearClosed: CurveFactory
  export const curveMonotoneX: CurveFactory
  export const curveMonotoneY: CurveFactory
  export const curveNatural: CurveFactory
  export const curveStep: CurveFactory
  export const curveStepAfter: CurveFactory
  export const curveStepBefore: CurveFactory
}
