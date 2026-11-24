/** Types of scripts/schema-table.mjs (the generator of src/schema-table.ts), for the tests that run it. */
export interface Schema { definitions: Record<string, Record<string, unknown>>; $ref: string }
export interface Extension { why: string; pinnedBy: string; example: Record<string, unknown>; patch(definitions: Schema['definitions']): void }
export const K: Readonly<Record<'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'NULL' | 'ANY' | 'OBJECT' | 'ARRAY', number>>
export const EXTENSIONS: readonly Extension[]
export function pinnedSchema(): { schema: Schema; version: string }
export function extendedSchema(schema: Schema, extensions?: readonly Extension[]): Schema
export function generate(schema: Schema, version: string): string
