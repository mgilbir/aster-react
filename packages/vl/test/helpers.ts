import { compile } from '../src/index.js'
import type { VLSpec } from '../src/index.js'

export const DATA = {
  values: [
    { c: 'A', g: 'p', x: 1, y: 2, v: 5, t: '2024-01-15', o: { v: 3 }, 'IMDB Rating': 6.1 },
    { c: 'B', g: 'q', x: 2, y: 4, v: 9, t: '2024-02-20', o: { v: 7 }, 'IMDB Rating': 7.4 },
    { c: 'A', g: 'q', x: 3, y: 3, v: 2, t: '2024-03-05', o: { v: 1 }, 'IMDB Rating': 5.2 },
  ],
}
export const xq = { field: 'x', type: 'quantitative' }
export const yq = { field: 'y', type: 'quantitative' }
export const cn = { field: 'c', type: 'nominal' }

/** Recursively freeze: any in-place write by the compiler throws (ES modules are strict). */
export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

/** Compile a deep-frozen copy (so a mutation of the input fails loudly). */
export function compileFrozen(spec: unknown): Record<string, any> {
  return compile(deepFreeze(JSON.parse(JSON.stringify(spec))) as VLSpec) as Record<string, any>
}

/** Every string value reachable in a compiled spec, with its key. */
export function* strings(node: unknown, key = ''): Generator<[string, string]> {
  if (typeof node === 'string') yield [key, node]
  else if (Array.isArray(node)) for (const n of node) yield* strings(n, key)
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (k !== 'values') yield* strings(v, k)
  }
}

/** All objects reachable in a compiled spec. */
export function* objects(node: unknown): Generator<Record<string, any>> {
  if (Array.isArray(node)) for (const n of node) yield* objects(n)
  else if (node !== null && typeof node === 'object') {
    yield node as Record<string, any>
    for (const [k, v] of Object.entries(node)) if (k !== 'values') yield* objects(v)
  }
}
