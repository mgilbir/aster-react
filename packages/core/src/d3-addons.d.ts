declare module 'd3-dsv' {
  export function dsvFormat(delimiter: string): {
    parse(text: string): Record<string, unknown>[] & { columns?: string[] }
    format(rows: Record<string, unknown>[]): string
  }
}
declare module 'topojson-client' {
  export function feature(topology: unknown, object: unknown, filter?: (a: unknown, b: unknown) => boolean): unknown
  export function mesh(topology: unknown, object?: unknown, filter?: (a: unknown, b: unknown) => boolean): unknown
}
