declare module 'vega-scale' {
  export interface Scale {
    (value: unknown): unknown
    domain(): unknown[]
    domain(d: unknown[]): this
    range(): unknown[]
    range(r: unknown[]): this
    ticks?(count?: number): unknown[]
    nice?(count?: number): this
    invert?(v: unknown): unknown
    bandwidth?(): number
    padding?(p: number): this
    paddingInner?(p: number): this
    paddingOuter?(p: number): this
    round?(b: boolean): this
    clamp?(b: boolean): this
    base?(b: number): this
    exponent?(e: number): this
    constant?(k: number): this
    interpolator?(): (t: number) => unknown
    copy?(): this
    [key: string]: unknown
  }
  export function scale(type: string): (() => Scale) | undefined
  export function scheme(name: string): unknown[] | ((count?: number) => unknown[]) | undefined
  export function tickCount(scale: Scale, count: number, size?: number, step?: number): number
  export function tickValues(scale: Scale, count: number, size?: number, step?: number): unknown[]
  export function tickFormat(
    locale: unknown,
    scale: Scale,
    count: number,
    specifier?: string,
    formatType?: string,
    noSkip?: boolean,
  ): (value: unknown) => string
  export function bandSpace(count: number, paddingInner: number, paddingOuter: number): number
  export function scaleCopy(scale: Scale): Scale
}
