declare module 'vega-format' {
  export interface FormatLocale {
    format(specifier: string): (value: unknown) => string
    formatPrefix(specifier: string, value: number): (value: number) => string
    formatFloat(specifier: string): (value: number) => string
    formatSpan(a: unknown, b: unknown, count: number, specifier: string): (value: unknown) => string
    timeFormat(specifier: string): (value: unknown) => string
    utcFormat(specifier: string): (value: unknown) => string
    timeParse(specifier: string): (value: string) => Date | null
    utcParse(specifier: string): (value: string) => Date | null
  }
  export function locale(definition: unknown): FormatLocale
  export const defaultLocale: unknown
  export function numberFormatLocale(definition: unknown): unknown
  export function timeFormatLocale(definition: unknown): unknown
  export function numberFormatDefaultLocale(definition?: unknown): unknown
  export function timeFormatDefaultLocale(definition?: unknown): unknown
  export function resetDefaultLocale(): void
  export function resetNumberFormatDefaultLocale(): void
  export function resetTimeFormatDefaultLocale(): void
}
