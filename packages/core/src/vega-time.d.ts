declare module 'vega-time' {
  export function timeOffset(unit: string, date: Date, step?: number): Date
  export function utcOffset(unit: string, date: Date, step?: number): Date
  export function timeSequence(unit: string, start: Date, stop: Date, step?: number): Date[]
  export function utcSequence(unit: string, start: Date, stop: Date, step?: number): Date[]
  export function dayofyear(date: Date): number
  export function utcdayofyear(date: Date): number
  export function week(date: Date): number
  export function utcweek(date: Date): number
  export function timeUnitSpecifier(units: string | string[], specifiers?: Record<string, string>): string
}
