/**
 * An independent reading of the Vega-Lite JSON schema, for the tests of the generated table (schema-table.test.ts) and of the compile
 * against vega-lite (conformance/test/vl-schema-values.test.ts). It interprets the schema JSON itself, keyword by keyword (the subset
 * vega-lite's schema uses), and shares no code with scripts/schema-table.mjs or src/schema.ts.
 *
 * `strict`: JSON Schema as written. `lenient`: the same, except that outside `config` an object may carry properties its definition
 * does not have (schema.ts leaves those to validate.ts and the consumption check; it is the stricter of the two).
 */
type Node = Record<string, unknown>
const KEYWORDS = new Set(['$ref', 'anyOf', 'type', 'enum', 'const', 'properties', 'additionalProperties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'minProperties', 'format', 'description', 'markdownDescription', '$schema', 'definitions'])

export function schemaOracle(schema: { definitions: Record<string, Node>; $ref: string }, mode: 'strict' | 'lenient'): (v: unknown) => boolean {
  const defs = schema.definitions
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  const typeOk = (t: string, v: unknown): boolean =>
    t === 'string' ? typeof v === 'string'
      : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : t === 'integer' ? Number.isInteger(v)
          : t === 'boolean' ? typeof v === 'boolean'
            : t === 'null' ? v === null
              : t === 'array' ? Array.isArray(v)
                : t === 'object' ? isObj(v)
                  : (() => { throw new Error(`type ${t}`) })()
  const ok = (node: Node | boolean | undefined, v: unknown, inConfig: boolean): boolean => {
    if (node === undefined || node === true) return true
    if (node === false) return false
    for (const k of Object.keys(node)) if (!KEYWORDS.has(k)) throw new Error(`keyword ${k}`)
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace('#/definitions/', '')
      if (!ok(defs[name], v, inConfig || name === 'Config')) return false
    }
    if (Array.isArray(node.anyOf) && !node.anyOf.some((alt) => ok(alt as Node, v, inConfig))) return false
    if (node.type !== undefined && ![node.type].flat().some((t) => typeOk(t as string, v))) return false
    if (Array.isArray(node.enum) && !node.enum.some((x) => x === v)) return false
    if ('const' in node && node.const !== v) return false
    if (typeof v === 'number') {
      if (typeof node.minimum === 'number' && v < node.minimum) return false
      if (typeof node.maximum === 'number' && v > node.maximum) return false
    }
    if (typeof v === 'string') {
      if (typeof node.minLength === 'number' && v.length < node.minLength) return false
      if (typeof node.maxLength === 'number' && v.length > node.maxLength) return false
    }
    if (Array.isArray(v)) {
      if (typeof node.minItems === 'number' && v.length < node.minItems) return false
      if (typeof node.maxItems === 'number' && v.length > node.maxItems) return false
      if (node.items !== undefined && !v.every((x) => ok(node.items as Node, x, inConfig))) return false
    }
    if (isObj(v) && (node.type === 'object' || node.properties !== undefined)) {
      const present = Object.keys(v).filter((k) => v[k] !== undefined)
      for (const r of (node.required as string[] | undefined) ?? []) if (!present.includes(r)) return false
      if (typeof node.minProperties === 'number' && present.length < node.minProperties) return false
      const props = (node.properties ?? {}) as Record<string, Node>
      for (const k of present) {
        if (Object.prototype.hasOwnProperty.call(props, k)) { if (!ok(props[k], v[k], inConfig)) return false }
        else if (node.additionalProperties === false) { if (mode === 'strict' || inConfig) return false }
        else if (isObj(node.additionalProperties) && !ok(node.additionalProperties as Node, v[k], inConfig)) return false
      }
    }
    return true
  }
  return (v) => ok({ $ref: schema.$ref }, v, false)
}
