/** What the composite-mark tests compare of a compiled spec: the marks, axes, scales (without their domains), legends and signals, with the names the compilers are free to differ in made equal. */
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

/**
 * The same name on both sides. Aster keeps a field with a path or an unusual character in it under a safe flat key (names.ts `safeKey`:
 * the name with its odd characters replaced, then `_` and six hex digits of a hash) that a formula copies the value into, where vega-lite
 * writes the field as it is (`o.v`, `a\\.b`). The flat keys are read from those formulas (the copy's `as` and the path it reads) and each is
 * written back as the path it stands for, as the exact string, wherever it occurs (a name made of it, `sum_o_<hash>`, included). Nothing
 * else is rewritten: a user's own `v_abcdef` stays, and `o.v` and `o_v` are two names.
 */
export function flatKeys(s: any): Map<string, string> {
  const found = new Map<string, string>()
  const part = (k: string): string => k.replace(/\./g, '\\.')
  const read = (expr: unknown): string[] | undefined => {
    if (typeof expr !== 'string') return undefined
    // `datum["o"] && datum["o"]["v"]` (a nested path, guarded) or `datum["a.b"]` (one key)
    const keys = [...expr.matchAll(/datum((?:\[(?:"(?:[^"\\]|\\.)*"|\d+)\])+)/g)]
    const last = keys.at(-1)
    if (last === undefined) return undefined
    return [...last[1]!.matchAll(/\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : `[${m[2]}]`))
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (o.type === 'formula' && typeof o.as === 'string' && /_[0-9a-f]{6}$/.test(o.as)) {
      const path = read(o.expr)
      if (path !== undefined) found.set(o.as, path.map((k, i) => (k.startsWith('[') ? k : i === 0 ? part(k) : `.${part(k)}`)).join(''))
    }
    for (const x of Object.values(o)) walk(x)
  }
  walk(s)
  return found
}
const writeBack = (s: string, keys: Map<string, string>): string => {
  let out = s
  for (const key of [...keys.keys()].sort((a, b) => b.length - a.length)) out = out.split(key).join(keys.get(key)!)
  return out
}
const sameName = (s: string, keys: Map<string, string>): string => writeBack(s, keys).replace(/\bdata\("([^"\\]*)"\)/g, "data('$1')")
/** A scale's domain says which dataset it reads by name; the names of datasets are the compilers' (the draw tells whether the right one is read). */
const unnamedData = (v: unknown): unknown => (Array.isArray(v) ? v.map(unnamedData) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === 'data' && typeof x === 'string' ? '<data>' : unnamedData(x)])) : v)
const canon = (v: unknown, keys: Map<string, string>): unknown => {
  if (Array.isArray(v)) return v.map((x) => canon(x, keys))
  if (typeof v === 'string') return sameName(v, keys)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(Object.keys(o).sort().filter((k) => !(k === 'data' && Array.isArray(o[k]))).map((k) => [k, k === 'from' ? '<from>' : k === 'domain' ? canon(unnamedData(o[k]), keys) : canon(o[k], keys)]))
}
export const pickSpec = (s: any, side: 'oracle' | 'aster'): unknown => canon(plain({
  marks: s.marks,
  // (Aster names `formatType: "time"` on the axis of a time unit, which vega infers from a time scale)
  axes: (s.axes ?? []).map(({ formatType, ...axis }: any) => (formatType === 'time' ? axis : { ...axis, formatType })),
  scales: (s.scales ?? []).map(({ domain: _d, ...rest }: any) => rest),
  legends: s.legends,
  signals: s.signals,
}), side === 'aster' ? flatKeys(s) : new Map())




